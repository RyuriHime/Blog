// AI 能力层（P3）的 HTTP 接口。
//
// handler 收到的 ctx 形状（与 install 收到的那个 ctx 同名但不是一回事）：
//   { req, res, params, query, user, sessionToken, ip, body }
// 其中 `body` 只在 POST / PUT / PATCH 时被解析过，`query` 是 URLSearchParams。
//
// ── 为什么前缀是 /api/ai-edit 而不是文档里的 /api/ai ──
// forum-ai 的挂载层（forum-ai/src/mount.mjs:255 的 isAiPath、:330-344）
// 把 `/api/ai/` 下**所有**路径都短路了：命中它的 14 条路由就自己答，
// 没命中就直接 404（message 是「 AI 接口不存在」，开头一个空格），
// **永远不交回宿主路由表**。所以任何注册在 `/api/ai/<子路径>` 的宿主路由都是不可达的。
// `/api/ai-edit/` 不以 `/api/ai/` 开头，落回宿主路由表，能被正常分发。
import { HttpError, ensure, rateLimit } from '../../core/http.js';
import { requireUser, requireStaff } from '../../core/guards.js';
import {
  AI_CAPABILITIES,
  AI_CAPABILITY_KEYS,
  AI_HIGH_RISK,
  AI_QUOTA_ACTIONS,
  AI_BLOCKED_STATUS,
  AI_CONTENT_CAPABILITY,
  AI_MAX_BLOCK_CHARS,
  AI_MAX_TARGET_ID,
  AI_MAX_REASON,
  AI_BLOCK_TYPES,
  AI_BLOCK_TYPE_NAMES,
  AI_BUDGET_ENV,
  AI_USAGE_TOP_USERS,
} from './schema.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** 配额按 **UTC 自然日** 结算：把时间戳向下取整到当天 00:00。 */
function startOfUtcDay(at) {
  return at - (at % DAY_MS);
}

/** 要求登录。未登录 → 401 `unauthenticated`（不是 404）。 */
function viewer(reqCtx) {
  requireUser(reqCtx);
  return reqCtx.user;
}

function readGrant(db, userId, capability) {
  return (
    db
      .prepare('SELECT * FROM ai_capability_grants WHERE user_id = ? AND capability = ?')
      .get(userId, capability) ?? null
  );
}

/** 有效的授权 = 没被收回、且没到期。 */
function isGrantActive(grant, at) {
  if (!grant) return false;
  if (grant.revoked_at != null) return false;
  if (grant.expires_at != null && grant.expires_at <= at) return false;
  return true;
}

/**
 * 当天已用次数（授权/收回这类状态变更不占额度）。
 *
 * `status <> 'blocked'`：被服务端自己挡下来的调用（没配 key、上游拒绝、连不上）
 * 一行都不该从用户额度里扣 —— 用户一次模型都没用上。修之前 dailyQuota=3 时
 * 四次「没配 key 的 503」就能把额度耗光。
 */
function usedToday(db, userId, capability, at) {
  const placeholders = AI_QUOTA_ACTIONS.map(() => '?').join(', ');
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM ai_op_logs
        WHERE user_id = ? AND capability = ? AND created_at >= ? AND action IN (${placeholders})
          AND status <> ?`,
    )
    .get(userId, capability, startOfUtcDay(at), ...AI_QUOTA_ACTIONS, AI_BLOCKED_STATUS);
  return Number(row?.n ?? 0);
}

/** 只看授权在不在、过没过期，不看配额（回滚用：撤销不该被额度挡住）。 */
function requireCapability(db, userId, capability) {
  const grant = readGrant(db, userId, capability);
  ensure(
    isGrantActive(grant, Date.now()),
    403,
    'forbidden',
    `未授权能力「${capability}」，请先在 /api/ai-edit/grants 授权`,
  );
  return grant;
}

/**
 * 服务端强制：没有有效授权就 403，超出每日配额就 429 `ai_rate_limited`。
 * 前端藏不藏按钮跟这里无关 —— 这道门在服务端（FR-CAP-01/03/04/07）。
 */
function guardCapability(db, userId, capability) {
  const at = Date.now();
  const grant = requireCapability(db, userId, capability);
  const quota = Number(grant.daily_quota ?? 0);
  if (quota > 0) {
    const used = usedToday(db, userId, capability, at);
    ensure(used < quota, 429, 'ai_rate_limited', `能力「${capability}」今日额度已用完（${used}/${quota}）`);
  }
  return grant;
}

/**
 * 全站当天**计费**调用次数（所有用户加起来）。
 * 口径与 `usedToday` 逐字一致：只数 `AI_QUOTA_ACTIONS`、且 `status <> 'blocked'`。
 */
function siteUsedToday(db, at) {
  const placeholders = AI_QUOTA_ACTIONS.map(() => '?').join(', ');
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM ai_op_logs
        WHERE created_at >= ? AND action IN (${placeholders}) AND status <> ?`,
    )
    .get(startOfUtcDay(at), ...AI_QUOTA_ACTIONS, AI_BLOCKED_STATUS);
  return Number(row?.n ?? 0);
}

/** 读全站每日上限：没配 / 空 / 0 / 非正数 都表示不限（返回 0，保持既有行为）。 */
function readSiteBudget() {
  const raw = process.env[AI_BUDGET_ENV];
  if (raw == null || raw === '') return 0;
  const limit = Number(raw);
  return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
}

/**
 * 全站兜底闸门。
 *
 * 只在**真会花钱或有副作用**的路径上调用（`/draft` 与 `/ops` 的落盘）；预览不调用 ——
 * 预览既不调模型也不写盘，没有理由被全站预算挡住。
 *
 * 为什么需要：配额是按用户算的，钱是按 key 算的。20 个人各用满 50 次/天 = 同一张
 * 账单上 1000 次，中间一个闸门都没有。这条是兜底，不是替代个人配额。
 */
function guardSiteBudget(db) {
  const limit = readSiteBudget();
  if (limit <= 0) return;
  const used = siteUsedToday(db, Date.now());
  ensure(
    used < limit,
    429,
    'ai_rate_limited',
    `全站今日 AI 调用已达上限（${used}/${limit}）：配额按用户算、账单按 key 算，` +
      `这道闸门兜住「一把 key 被全站烧穿」。调整环境变量 ${AI_BUDGET_ENV} 可放行。`,
  );
}

/**
 * 检查一个块补丁的**形状** —— 就是 P2 `document_blocks` 的那一套 `{ type, props }`。
 *
 * 返回空串表示合法；否则返回一句话的毛病描述。**故意不在这里抛**：
 * 用户传错形状该是 400 `bad_request`，模型吐错形状该是 502 `ai_bad_json`
 * （既有代号，不新造同义词），同一个函数服务两种调用方。
 */
function blockPatchProblem(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return '必须是一个对象';
  if (typeof value.type !== 'string' || !AI_BLOCK_TYPE_NAMES.includes(value.type)) {
    return `type 必须是已知块类型之一（${AI_BLOCK_TYPE_NAMES.join(' / ')}），收到「${String(value.type)}」`;
  }
  // `props` 必须**显式给出**。这一版只做「整块替换」，不做「只改一半」的合并：
  // 缺了 props，`cleanBlockPatch` 会补成 `{}`，写回文档时就是一次静默清空 ——
  // 调用方要的是「改类型、别动 props」，拿到的是 props 被抹掉，而且审计里也看不出来。
  // （P2 的 `updateBlock` 确实把 `props === undefined` 当成「保留原 props」，
  // 见 `src/modules/doc/store.js` 的 `const nextProps = props === undefined ? ... : props;`。
  // 我们**故意比它严**：这条路径记录的是「这一块改完之后长什么样」，只有全量值才有意义。）
  if (
    value.props === undefined ||
    value.props === null ||
    typeof value.props !== 'object' ||
    Array.isArray(value.props)
  ) {
    return 'props 必须是对象（这一版只接受整块替换 { type, props }，不支持只改一半）';
  }
  return '';
}

/** 校验通过后取出干净的 `{ type, props }`：多余的键不入库。 */
function cleanBlockPatch(value) {
  return { type: value.type, props: value.props ?? {} };
}

/** 审计日志里的目标 id：`<documentId>:<blockId>`，回滚时能拆回来源。 */
function composeTargetId(documentId, blockId) {
  return `${String(documentId ?? '')}:${String(blockId ?? '')}`;
}

/** 把 `composeTargetId` 拼出来的字符串拆回去。 */
function splitTargetId(targetId) {
  const [documentId = '', blockId = ''] = String(targetId ?? '').split(':');
  return { documentId, blockId };
}

function logOp(db, entry) {
  const info = db
    .prepare(
      `INSERT INTO ai_op_logs
         (user_id, capability, action, target_type, target_id, status, reason, before_json, after_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      entry.userId,
      entry.capability,
      entry.action,
      entry.targetType ?? '',
      String(entry.targetId ?? ''),
      entry.status ?? 'applied',
      entry.reason ?? '',
      entry.before === undefined || entry.before === null ? null : JSON.stringify(entry.before),
      entry.after === undefined || entry.after === null ? null : JSON.stringify(entry.after),
      Date.now(),
    );
  return Number(info.lastInsertRowid);
}

/**
 * 被挡下来的调用也要留痕（`status='blocked'`，不计配额）。
 *
 * 以前只有「连不上 / 超时」这两条写日志，被上游 401/403/429/500 拒绝、以及模型
 * 返回坏 JSON 的几条**什么都不记** —— 同一次调用，网络失败有痕、被服务商拒绝没痕，
 * 审计就是缺的。
 */
function logBlocked(db, userId, capability, action, targetId, reason) {
  logOp(db, {
    userId,
    capability,
    action,
    targetType: 'document_block',
    targetId: String(targetId ?? ''),
    status: AI_BLOCKED_STATUS,
    reason,
  });
}

function shapeOp(row) {
  return {
    id: row.id,
    capability: row.capability,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    status: row.status,
    reason: row.reason,
    before: row.before_json == null ? null : JSON.parse(row.before_json),
    after: row.after_json == null ? null : JSON.parse(row.after_json),
    createdAt: row.created_at,
    rolledBackAt: row.rolled_back_at ?? null,
    canRollback: row.status === 'applied' && row.before_json != null && row.rolled_back_at == null,
  };
}

export function registerAiRoutes(ctx) {
  const { db, routes } = ctx;

  // ── 1. 能力目录 + 我的授权状态（FR-CAP-09：UI 上随时可见）─────────────
  routes.add('GET', '/api/ai-edit/capabilities', (reqCtx) => {
    const user = viewer(reqCtx);
    const at = Date.now();
    const capabilities = AI_CAPABILITIES.map((item) => {
      const grant = readGrant(db, user.id, item.key);
      const active = isGrantActive(grant, at);
      return {
        key: item.key,
        label: item.label,
        risk: item.risk,
        highRisk: AI_HIGH_RISK.includes(item.key),
        granted: active,
        dailyQuota: active ? Number(grant.daily_quota ?? 0) : 0,
        usedToday: usedToday(db, user.id, item.key, at),
        expiresAt: active ? (grant.expires_at ?? null) : null,
      };
    });
    return ctx.http.ok(reqCtx.res, { capabilities });
  });

  // ── 2. 我的授权列表 ─────────────────────────────────────────────────
  routes.add('GET', '/api/ai-edit/grants', (reqCtx) => {
    const user = viewer(reqCtx);
    const rows = db
      .prepare('SELECT * FROM ai_capability_grants WHERE user_id = ? ORDER BY capability')
      .all(user.id);
    const at = Date.now();
    return ctx.http.ok(reqCtx.res, {
      grants: rows.map((row) => ({
        capability: row.capability,
        grantedAt: row.granted_at,
        expiresAt: row.expires_at ?? null,
        dailyQuota: Number(row.daily_quota ?? 0),
        revokedAt: row.revoked_at ?? null,
        active: isGrantActive(row, at),
        usedToday: usedToday(db, user.id, row.capability, at),
      })),
    });
  });

  // ── 3. 授权（高风险能力要 confirm: true）──────────────────────────────
  routes.add('POST', '/api/ai-edit/grants', (reqCtx) => {
    const user = viewer(reqCtx);
    const body = reqCtx.body ?? {};
    const capability = String(body.capability ?? '');
    ensure(AI_CAPABILITY_KEYS.includes(capability), 400, 'bad_request', `未知能力「${capability}」`);

    if (AI_HIGH_RISK.includes(capability)) {
      ensure(
        body.confirm === true,
        400,
        'bad_request',
        `「${capability}」是高风险能力，开启需要在请求里带 confirm: true`,
      );
    }

    const dailyQuota = body.dailyQuota == null ? 0 : Number(body.dailyQuota);
    ensure(
      Number.isInteger(dailyQuota) && dailyQuota >= 0 && dailyQuota <= 1000,
      400,
      'bad_request',
      'dailyQuota 必须是 0~1000 的整数（0 表示不限次数）',
    );

    const ttlMs = body.ttlMs == null ? null : Number(body.ttlMs);
    if (ttlMs != null) ensure(Number.isFinite(ttlMs) && ttlMs > 0, 400, 'bad_request', 'ttlMs 必须是正数（毫秒）');

    const at = Date.now();
    const expiresAt = ttlMs == null ? null : at + ttlMs;

    // 收回过的授权重新授予 = 同一行复活（PRIMARY KEY(user_id, capability)）。
    db.prepare(
      `INSERT INTO ai_capability_grants (user_id, capability, granted_at, expires_at, daily_quota, revoked_at)
       VALUES (?, ?, ?, ?, ?, NULL)
       ON CONFLICT (user_id, capability) DO UPDATE SET
         granted_at  = excluded.granted_at,
         expires_at  = excluded.expires_at,
         daily_quota = excluded.daily_quota,
         revoked_at  = NULL`,
    ).run(user.id, capability, at, expiresAt, dailyQuota);

    logOp(db, {
      userId: user.id,
      capability,
      action: 'grant',
      status: 'applied',
      reason: `授予能力（quota=${dailyQuota}）`,
      after: { capability, dailyQuota, expiresAt },
    });

    return ctx.http.ok(reqCtx.res, { granted: true, capability, expiresAt, dailyQuota });
  });

  // ── 4. 收回授权（立即失效，FR-CAP-03）────────────────────────────────
  routes.add('DELETE', '/api/ai-edit/grants/:capability', (reqCtx) => {
    const user = viewer(reqCtx);
    const capability = String(reqCtx.params.capability ?? '');
    ensure(AI_CAPABILITY_KEYS.includes(capability), 400, 'bad_request', `未知能力「${capability}」`);

    const at = Date.now();
    // `before` 必须在 UPDATE **之前**取：改完再读，拿到的是 revoked_at 已经非空的
    // 「收回后」状态，审计里的「改前值」就成了假的。
    const beforeGrant = readGrant(db, user.id, capability);

    const info = db
      .prepare(
        'UPDATE ai_capability_grants SET revoked_at = ? WHERE user_id = ? AND capability = ? AND revoked_at IS NULL',
      )
      .run(at, user.id, capability);
    ensure(info.changes > 0, 404, 'not_found', `没有可收回的授权「${capability}」`);

    logOp(db, {
      userId: user.id,
      capability,
      action: 'revoke',
      status: 'applied',
      reason: '用户收回授权',
      before: beforeGrant,
    });

    return ctx.http.ok(reqCtx.res, { revoked: true, capability, revokedAt: at });
  });

  // ── 5. 我的 AI 操作日志（FR-CAP-05）──────────────────────────────────
  routes.add('GET', '/api/ai-edit/ops', (reqCtx) => {
    const user = viewer(reqCtx);
    const raw = Number(reqCtx.query?.get?.('limit') ?? 20);
    const limit = Math.min(Math.max(Number.isFinite(raw) ? raw : 20, 1), 100);
    const rows = db
      .prepare(
        `SELECT * FROM ai_op_logs WHERE user_id = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(user.id, limit);
    const total = Number(db.prepare('SELECT COUNT(*) AS n FROM ai_op_logs WHERE user_id = ?').get(user.id)?.n ?? 0);
    return ctx.http.ok(reqCtx.res, { ops: rows.map(shapeOp), total, limit });
  });

  // ── 6. 提交一次块级改动（预览 / 落盘）────────────────────────────────
  //
  // 这是「AI 按积木块改稿」的落点：改的是**一个块**，不是整篇重写。
  // FR-CAP-06：不落盘前必须先把改动给用户看。所以不带 `confirm: true` 时
  // 只回预览、状态记 `preview`；带了才写 `applied` 并留下 before/after。
  // 真正的写盘由 P2 的 /api/docs/* 完成（documents/document_blocks 归 P2，我只读），
  // 我这张表负责的是**授权、审计与回滚所需的旧值**。
  //
  // 能力恒为 `edit_content`、动作由 `confirm` 推导 —— **不看 body.capability / body.action**。
  // 这两个字段以前是客户端说了算：只授权了低风险 `read_post` 的人，把 capability 填成
  // `read_post` 就能让这条接口落盘一次内容改写；带上 `action: 'grant'` 还能把日志
  // 伪造成一条授权记录。
  routes.add('POST', '/api/ai-edit/ops', (reqCtx) => {
    const user = viewer(reqCtx);
    const body = reqCtx.body ?? {};
    const capability = AI_CONTENT_CAPABILITY;
    guardCapability(db, user.id, capability);

    const after = body.after ?? null;
    const afterProblem = blockPatchProblem(after);
    ensure(
      !afterProblem,
      400,
      'bad_request',
      `after 不是合法的块（${afterProblem}）—— 这一版只接受块级改动 { type, props }，不接受整篇重写`,
    );
    const before = body.before ?? null;
    if (before !== null) {
      const beforeProblem = blockPatchProblem(before);
      ensure(!beforeProblem, 400, 'bad_request', `before 不是合法的块（${beforeProblem}）`);
    }
    // 审计和返回里只能出现 `{ type, props }`：`after` / `before` 来自请求体，可能夹带
    // 别的键（上一轮实测就存进过 `{"type":"poll","props":{…},"blockType":"vote","content":{…}}`
    // —— 旧形状的键跟着新形状一起进了库）。`cleanBlockPatch` 只留 type / props。
    const cleanAfter = cleanBlockPatch(after);
    const cleanBefore = before === null ? null : cleanBlockPatch(before);

    // 目标恒为「某个文档里的某一块」：`targetType` 由服务端写死，`targetId` 由服务端拼，
    // 客户端塞不进任意字符串（以前 targetType 可以是 not_a_real_thing、
    // targetId 能塞 5000 个字符）。
    const targetType = 'document_block';
    // `documentId` 是必填的：落盘记的是「哪一篇的哪一块」，缺了它目标栏就是 `:b7`，
    // 回滚时写不回任何地方 —— 一条「已落盘」的审计却指不回文档，比不记还坏。
    const rawDocumentId = body.documentId;
    const documentId =
      typeof rawDocumentId === 'number' && Number.isInteger(rawDocumentId) && rawDocumentId > 0
        ? String(rawDocumentId)
        : typeof rawDocumentId === 'string'
          ? rawDocumentId.trim()
          : '';
    ensure(documentId !== '', 400, 'bad_request', 'documentId 不能为空 —— 落盘要记清楚改的是哪一篇文档');
    // `targetId` 用 `:` 拼、回滚时按 `:` 拆，所以 id 里不能自带 `:`，否则拆出错的目标。
    ensure(!documentId.includes(':'), 400, 'bad_request', 'documentId 里不能有冒号');
    const blockId = String(body.blockId ?? '').trim();
    ensure(blockId.length >= 1, 400, 'bad_request', 'blockId 不能为空');
    ensure(!blockId.includes(':'), 400, 'bad_request', 'blockId 里不能有冒号');
    const targetId = composeTargetId(documentId, blockId);
    ensure(
      targetId.length <= AI_MAX_TARGET_ID,
      400,
      'bad_request',
      `documentId + blockId 太长（上限 ${AI_MAX_TARGET_ID} 个字符）`,
    );
    const reason = String(body.reason ?? '').slice(0, AI_MAX_REASON);

    // 全站闸门排在**校验之后**：预算用光时，一个畸形的请求体（比如缺 props）应该拿到
    // 400 告诉它请求写错了，而不是 429 让它以为「预算满了、等明天再来」。落盘才过闸门，
    // 纯预览不花任何东西，不挡。
    if (body.confirm === true) guardSiteBudget(db);

    if (body.confirm !== true) {
      const opId = logOp(db, {
        userId: user.id,
        capability,
        action: 'preview',
        targetType,
        targetId,
        status: 'preview',
        reason: reason || '等待用户确认',
        before: cleanBefore,
        after: cleanAfter,
      });
      return ctx.http.ok(reqCtx.res, {
        applied: false,
        opId,
        preview: { targetType, targetId, before: cleanBefore, after: cleanAfter },
        hint: '这是预览，没有落盘。确认后带 confirm: true 再提交一次。',
      });
    }

    const opId = logOp(db, {
      userId: user.id,
      capability,
      action: 'apply',
      targetType,
      targetId,
      status: 'applied',
      reason,
      before: cleanBefore,
      after: cleanAfter,
    });
    return ctx.http.ok(reqCtx.res, {
      applied: true,
      opId,
      targetType,
      targetId,
      documentId,
      blockId,
      before: cleanBefore,
      after: cleanAfter,
      // 真正的写盘由调用方（前端拿这个 patch 去调 P2 的 PUT /api/docs/:id/blocks/:blockId）
      // 完成：documents / document_blocks 归 P2，我只读。我这边的职责是
      // 授权、审计和「改之前长什么样」。
      writeTo: `/api/docs/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(blockId)}`,
    });
  });

  // ── 7. 回滚（把旧值交回去，FR-CAP-05「能回滚」）───────────────────────
  routes.add('POST', '/api/ai-edit/ops/:id/rollback', (reqCtx) => {
    const user = viewer(reqCtx);
    const id = Number(reqCtx.params.id);
    ensure(Number.isInteger(id) && id > 0, 400, 'bad_request', '操作 id 不合法');

    const row = db.prepare('SELECT * FROM ai_op_logs WHERE id = ? AND user_id = ?').get(id, user.id);
    ensure(row, 404, 'not_found', '找不到这条操作记录');

    // 回滚交出去的 `restore` 是要写回 document_blocks 的旧值 —— 这本身就是一条写路径，
    // 所以同样要过能力门：得还持有当初那次操作所用的能力。
    // 只看授权、不看配额（撤销不该被当日额度挡住）。
    // 放在 404 之后：回滚别人的操作仍然是 404，不泄漏这条记录存不存在。
    requireCapability(db, user.id, row.capability);

    // 判据必须和 shapeOp 的 canRollback 一致，否则会出现「列表说不能回滚、接口却回滚成功」。
    ensure(row.status === 'applied', 409, 'conflict', '只有已经落盘（applied）的操作才能回滚');
    ensure(row.rolled_back_at == null, 409, 'conflict', '这条操作已经回滚过了');
    ensure(row.before_json != null, 409, 'conflict', '这条操作没有存旧值，无法回滚');

    const at = Date.now();
    db.prepare('UPDATE ai_op_logs SET rolled_back_at = ?, status = ? WHERE id = ?').run(at, 'rolled_back', id);

    logOp(db, {
      userId: user.id,
      capability: row.capability,
      action: 'rollback',
      targetType: row.target_type,
      targetId: row.target_id,
      status: 'applied',
      reason: `回滚操作 #${id}`,
    });

    // `restore` 就是改动前的样子，由调用方（P2 的文档界面）拿回去写盘。
    return ctx.http.ok(reqCtx.res, {
      rolledBack: true,
      opId: id,
      targetType: row.target_type,
      targetId: row.target_id,
      restore: JSON.parse(row.before_json),
      rolledBackAt: at,
    });
  });

  // ── 8. AI 草拟一次块级改动（vibe coding 的入口）──────────────────────
  //
  // 没配 AI_API_KEY 时返回 503 `ai_not_configured`（不是 500）—— 这是验收项。
  // 超时 504 `ai_timeout`、模型侧限流 429 `ai_rate_limited`、
  // 连不上/鉴权失败/坏 JSON 502 `ai_unreachable`/`ai_unauthorized`/`ai_bad_json`/`ai_upstream_error`。
  // 代号全部沿用 `docs/skeleton.md` 的既有清单，不新造（FR-AI-15）。
  routes.add('POST', '/api/ai-edit/draft', async (reqCtx) => {
    const user = viewer(reqCtx);
    const body = reqCtx.body ?? {};
    const capability = AI_CONTENT_CAPABILITY;
    guardCapability(db, user.id, capability);
    // 真会发出去一次模型调用 —— 过全站闸门。
    guardSiteBudget(db);

    // FR-AI-14：按用户限流，v1 是 10 次/分钟。
    rateLimit(`ai-edit:draft:${user.id}`, 10, 60 * 1000);

    const instruction = typeof body.instruction === 'string' ? body.instruction.trim() : '';
    ensure(instruction.length >= 1, 400, 'bad_request', 'instruction 不能为空');
    ensure(instruction.length <= 2000, 400, 'bad_request', 'instruction 不能超过 2000 个字符');

    // 当前块必须是 P2 的形状（`{ type, props }`），否则提示词给的例子和模型吐回来的
    // 东西都对不上 —— 以前我用的是自造的 `{ blockType, content }`，模型照着发明了
    // `vote` 这种根本不存在的块类型，落盘时必然写不进去。
    const currentBlock = body.block ?? null;
    const blockProblem = blockPatchProblem(currentBlock);
    ensure(!blockProblem, 400, 'bad_request', `block 不是合法的块（${blockProblem}）`);
    const cleanBlock = cleanBlockPatch(currentBlock);

    // 提示词体积就是账单。instruction 限了 2000 字，block 之前一个字都没限：
    // 实测 12 万字的块能撑出 352KB 的请求体（唯一约束是 core/http.js 的 512KB 上限），
    // 必然超出任何模型上下文，而钱照付。
    const blockJson = JSON.stringify(cleanBlock);
    ensure(
      blockJson.length <= AI_MAX_BLOCK_CHARS,
      400,
      'bad_request',
      `block 太大（${blockJson.length} 字符，上限 ${AI_MAX_BLOCK_CHARS}）——只提交要改的那一块`,
    );

    // 审计目标：`<documentId>:<blockId>`。两者都可以缺省（纯试写），但要能对上文档。
    const targetId = composeTargetId(body.documentId, body.blockId);

    const apiKey = process.env.AI_API_KEY;
    if (!apiKey) {
      logBlocked(db, user.id, capability, 'draft', targetId, 'ai_not_configured');
      throw new HttpError(503, 'ai_not_configured', '没有配置 AI_API_KEY，无法调用模型');
    }

    // 默认值必须和 `forum-ai/src/ai.mjs` 的 DEFAULT_BASE_URL / DEFAULT_MODEL 一致：
    // 同一个项目里 `AI_BASE_URL` / `AI_MODEL` 只能有一个默认值。两边不一致的时候，
    // 只配 `AI_API_KEY`（forum-ai/README.md 里的最小配法）就会把 key 发到另一个
    // 服务商去 —— 既肯定调不通，也等于把密钥递给了第三方。
    // `scripts/ai-smoke.mjs` 第 16 节直接读这两个源文件比对，只改一边会红。
    // 超时默认 180000 是 FR-AI-13 写的「超时按 180 秒级」，跟 forum-ai 的 60000
    // 不同是有意的，不参与这项比对。
    const baseUrl = String(process.env.AI_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
    const model = String(process.env.AI_MODEL || 'deepseek-chat');
    const configured = Number(process.env.AI_TIMEOUT_MS);
    const timeoutMs = Number.isFinite(configured) && configured > 0 ? configured : 180000;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          messages: [
            {
              role: 'system',
              content: [
                '你是博客「积木帖子」的块编辑器。用户给你当前这一块，以及一句改写要求。',
                '你只改这一块，绝不重写整篇，也不要碰别的块。',
                '只输出一个 JSON 对象，形状必须是 {"type":"<块类型>","props":{…}}，',
                '不要输出解释文字，也不要 Markdown 代码围栏。',
                `type 只能取这些名字之一：${AI_BLOCK_TYPES.map((item) => `${item.name}（${item.label}）`).join('、')}。`,
                'props 是各类型自己的字段：正文 {"text":"…"}；标题 {"text":"…","level":1}；',
                '代码 {"text":"…","lang":"…"}；引用 {"text":"…","source":"…"}；',
                '投票 {"question":"…","options":["选项一","选项二"],"multiple":false}；图片 {"src":"…","alt":"…","text":"…"}。',
                '脚本 {"code":"…"}（浏览器里跑的 JS，服务端不执行）；',
                '子页 {"doc":"…","mode":"card","title":"…","note":"…"}（doc 填页面标题或 id，拿不准就留空）。',
                '用户没要求改的部分保持原样。',
              ].join(''),
            },
            {
              role: 'user',
              content: `当前块（JSON）：${blockJson}\n改写要求：${instruction}`,
            },
          ],
        }),
        signal: controller.signal,
      });
    } catch (error) {
      const aborted = error?.name === 'AbortError';
      logBlocked(db, user.id, capability, 'draft', targetId, aborted ? 'ai_timeout' : 'ai_unreachable');
      throw new HttpError(
        aborted ? 504 : 502,
        aborted ? 'ai_timeout' : 'ai_unreachable',
        aborted ? `模型调用超过 ${timeoutMs}ms` : '连不上模型服务',
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 401 || response.status === 403) {
      logBlocked(db, user.id, capability, 'draft', targetId, 'ai_unauthorized');
      throw new HttpError(502, 'ai_unauthorized', '模型服务拒绝了这个 API key');
    }
    if (response.status === 429) {
      logBlocked(db, user.id, capability, 'draft', targetId, 'ai_rate_limited');
      throw new HttpError(429, 'ai_rate_limited', '模型服务限流了，请稍后再试');
    }
    if (!response.ok) {
      logBlocked(db, user.id, capability, 'draft', targetId, `ai_upstream_error ${response.status}`);
      throw new HttpError(502, 'ai_upstream_error', `模型服务返回 ${response.status}`);
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      logBlocked(db, user.id, capability, 'draft', targetId, 'ai_bad_json');
      throw new HttpError(502, 'ai_bad_json', '模型返回的不是 JSON');
    }

    const content = String(payload?.choices?.[0]?.message?.content ?? '');
    let patch;
    try {
      patch = JSON.parse(content.replace(/```json/gi, '').replace(/```/g, '').trim());
    } catch {
      logBlocked(db, user.id, capability, 'draft', targetId, 'ai_bad_json');
      throw new HttpError(502, 'ai_bad_json', '模型没有返回合法的 JSON 改动');
    }

    // 合法的 JSON ≠ 合法的块。模型完全可以吐回 `{"blockType":"vote","content":{…}}`
    // 这种自造形状 —— 这时候落盘会直接失败，所以在这里就挡住。
    // 用 `ai_bad_json`（既有代号）而不是新造一个，代号表见 docs/skeleton.md。
    const patchProblem = blockPatchProblem(patch);
    if (patchProblem) {
      logBlocked(db, user.id, capability, 'draft', targetId, `ai_bad_json 块形状不对：${patchProblem}`);
      throw new HttpError(502, 'ai_bad_json', `模型没有返回合法的块（${patchProblem}）`);
    }
    const cleanPatch = cleanBlockPatch(patch);

    const opId = logOp(db, {
      userId: user.id,
      capability,
      action: 'draft',
      targetType: 'document_block',
      targetId,
      status: 'preview',
      reason: instruction.slice(0, 200),
      before: cleanBlock,
      after: cleanPatch,
    });

    return ctx.http.ok(reqCtx.res, {
      applied: false,
      opId,
      patch: cleanPatch,
      before: cleanBlock,
      targetType: 'document_block',
      targetId,
      ...splitTargetId(targetId),
      model,
    });
  });

  // ── 9. 全站用量 + 预算状态（仅管理团队）────────────────────────────────
  //
  // 补的是「配额按用户算、钱按 key 算」留下的那个洞：在这之前，全站今天调了多少次、
  // 谁在用、有没有顶到上限，管理员一概看不见，唯一的全局约束就是账单本身。
  //
  // 口径：`billed` 只数 AI_QUOTA_ACTIONS 里**没失败**的行 —— 与用户额度、全站预算
  // 逐字一致；`total` 是当天的全部日志行（含预览、授权、被挡掉的）。
  //
  // **没有 token 数**：这张表没存模型返回的 usage；`ctx.schema.add` 只有
  // CREATE TABLE IF NOT EXISTS，没有加列的迁移通道（`src/core/table.js` 全文 87 行），
  // 所以这里把「次数」当成本的代理指标，并在返回值里写清楚。
  routes.add('GET', '/api/ai-edit/usage', (reqCtx) => {
    requireStaff(reqCtx);
    const at = Date.now();
    const since = startOfUtcDay(at);
    const placeholders = AI_QUOTA_ACTIONS.map(() => '?').join(', ');

    const total = Number(
      db.prepare('SELECT COUNT(*) AS n FROM ai_op_logs WHERE created_at >= ?').get(since)?.n ?? 0,
    );
    const billed = siteUsedToday(db, at);
    const blocked = Number(
      db
        .prepare('SELECT COUNT(*) AS n FROM ai_op_logs WHERE created_at >= ? AND status = ?')
        .get(since, AI_BLOCKED_STATUS)?.n ?? 0,
    );
    const byAction = db
      .prepare('SELECT action, COUNT(*) AS n FROM ai_op_logs WHERE created_at >= ? GROUP BY action ORDER BY n DESC')
      .all(since)
      .map((row) => ({ action: row.action, count: Number(row.n) }));
    const topUsers = db
      .prepare(
        `SELECT l.user_id AS userId, COALESCE(u.username, '') AS username, COUNT(*) AS n
           FROM ai_op_logs l LEFT JOIN users u ON u.id = l.user_id
          WHERE l.created_at >= ? AND l.action IN (${placeholders}) AND l.status <> ?
          GROUP BY l.user_id ORDER BY n DESC LIMIT ?`,
      )
      .all(since, ...AI_QUOTA_ACTIONS, AI_BLOCKED_STATUS, AI_USAGE_TOP_USERS)
      .map((row) => ({ userId: row.userId, username: row.username, count: Number(row.n) }));
    const users = Number(
      db
        .prepare(
          `SELECT COUNT(DISTINCT user_id) AS n FROM ai_op_logs
            WHERE created_at >= ? AND action IN (${placeholders}) AND status <> ?`,
        )
        .get(since, ...AI_QUOTA_ACTIONS, AI_BLOCKED_STATUS)?.n ?? 0,
    );
    const allTime = Number(db.prepare('SELECT COUNT(*) AS n FROM ai_op_logs').get()?.n ?? 0);

    const limit = readSiteBudget();
    return ctx.http.ok(reqCtx.res, {
      scope: 'site',
      since,
      today: { total, billed, blocked, users, byAction, topUsers },
      allTime: { total: allTime },
      budget: {
        envKey: AI_BUDGET_ENV,
        unlimited: limit <= 0,
        limit,
        used: billed,
        remaining: limit <= 0 ? null : Math.max(limit - billed, 0),
      },
      note: '按调用次数统计；这张表没有存模型返回的 token 用量，所以没有金额。',
    });
  });
}
