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
import { requireUser } from '../../core/guards.js';
import { AI_CAPABILITIES, AI_CAPABILITY_KEYS, AI_HIGH_RISK, AI_QUOTA_ACTIONS } from './schema.js';

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

/** 当天已用次数（授权/收回这类状态变更不占额度）。 */
function usedToday(db, userId, capability, at) {
  const placeholders = AI_QUOTA_ACTIONS.map(() => '?').join(', ');
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM ai_op_logs
        WHERE user_id = ? AND capability = ? AND created_at >= ? AND action IN (${placeholders})`,
    )
    .get(userId, capability, startOfUtcDay(at), ...AI_QUOTA_ACTIONS);
  return Number(row?.n ?? 0);
}

/**
 * 服务端强制：没有有效授权就 403，超出每日配额就 429 `ai_rate_limited`。
 * 前端藏不藏按钮跟这里无关 —— 这道门在服务端（FR-CAP-01/03/04/07）。
 */
function guardCapability(db, userId, capability) {
  const at = Date.now();
  const grant = readGrant(db, userId, capability);
  ensure(isGrantActive(grant, at), 403, 'forbidden', `未授权能力「${capability}」，请先在 /api/ai-edit/grants 授权`);
  const quota = Number(grant.daily_quota ?? 0);
  if (quota > 0) {
    const used = usedToday(db, userId, capability, at);
    ensure(used < quota, 429, 'ai_rate_limited', `能力「${capability}」今日额度已用完（${used}/${quota}）`);
  }
  return grant;
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
      before: readGrant(db, user.id, capability),
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
  routes.add('POST', '/api/ai-edit/ops', (reqCtx) => {
    const user = viewer(reqCtx);
    const body = reqCtx.body ?? {};
    const capability = String(body.capability ?? 'edit_content');
    ensure(AI_CAPABILITY_KEYS.includes(capability), 400, 'bad_request', `未知能力「${capability}」`);
    guardCapability(db, user.id, capability);

    const after = body.after ?? null;
    ensure(
      after !== null && typeof after === 'object' && !Array.isArray(after),
      400,
      'bad_request',
      'after 必须是一个对象（这一版只接受块级改动，不接受整篇重写）',
    );
    const before = body.before ?? null;
    const targetType = String(body.targetType ?? 'document_block');
    const targetId = String(body.targetId ?? '');
    const reason = String(body.reason ?? '').slice(0, 500);

    if (body.confirm !== true) {
      const opId = logOp(db, {
        userId: user.id,
        capability,
        action: 'preview',
        targetType,
        targetId,
        status: 'preview',
        reason: reason || '等待用户确认',
        before,
        after,
      });
      return ctx.http.ok(reqCtx.res, {
        applied: false,
        opId,
        preview: { targetType, targetId, before, after },
        hint: '这是预览，没有落盘。确认后带 confirm: true 再提交一次。',
      });
    }

    const opId = logOp(db, {
      userId: user.id,
      capability,
      action: String(body.action ?? 'apply'),
      targetType,
      targetId,
      status: 'applied',
      reason,
      before,
      after,
    });
    return ctx.http.ok(reqCtx.res, { applied: true, opId, targetType, targetId, before, after });
  });

  // ── 7. 回滚（把旧值交回去，FR-CAP-05「能回滚」）───────────────────────
  routes.add('POST', '/api/ai-edit/ops/:id/rollback', (reqCtx) => {
    const user = viewer(reqCtx);
    const id = Number(reqCtx.params.id);
    ensure(Number.isInteger(id) && id > 0, 400, 'bad_request', '操作 id 不合法');

    const row = db.prepare('SELECT * FROM ai_op_logs WHERE id = ? AND user_id = ?').get(id, user.id);
    ensure(row, 404, 'not_found', '找不到这条操作记录');
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
    const capability = 'edit_content';
    guardCapability(db, user.id, capability);

    // FR-AI-14：按用户限流，v1 是 10 次/分钟。
    rateLimit(`ai-edit:draft:${user.id}`, 10, 60 * 1000);

    const instruction = typeof body.instruction === 'string' ? body.instruction.trim() : '';
    ensure(instruction.length >= 1, 400, 'bad_request', 'instruction 不能为空');
    ensure(instruction.length <= 2000, 400, 'bad_request', 'instruction 不能超过 2000 个字符');

    const apiKey = process.env.AI_API_KEY;
    if (!apiKey) {
      logOp(db, {
        userId: user.id,
        capability,
        action: 'draft',
        targetType: 'document_block',
        targetId: String(body.blockId ?? ''),
        status: 'blocked',
        reason: 'ai_not_configured',
      });
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
              content:
                '你是帖子块编辑器。只输出一个 JSON 对象，形如 {"blockType":"...","content":{...}}，' +
                '不要输出解释文字或 Markdown 代码围栏。',
            },
            {
              role: 'user',
              content: `当前块（JSON）：${JSON.stringify(body.block ?? null)}\n改写要求：${instruction}`,
            },
          ],
        }),
        signal: controller.signal,
      });
    } catch (error) {
      const aborted = error?.name === 'AbortError';
      logOp(db, {
        userId: user.id,
        capability,
        action: 'draft',
        status: 'blocked',
        reason: aborted ? 'ai_timeout' : 'ai_unreachable',
      });
      throw new HttpError(
        aborted ? 504 : 502,
        aborted ? 'ai_timeout' : 'ai_unreachable',
        aborted ? `模型调用超过 ${timeoutMs}ms` : '连不上模型服务',
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 401 || response.status === 403) {
      throw new HttpError(502, 'ai_unauthorized', '模型服务拒绝了这个 API key');
    }
    if (response.status === 429) {
      throw new HttpError(429, 'ai_rate_limited', '模型服务限流了，请稍后再试');
    }
    if (!response.ok) {
      throw new HttpError(502, 'ai_upstream_error', `模型服务返回 ${response.status}`);
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new HttpError(502, 'ai_bad_json', '模型返回的不是 JSON');
    }

    const content = String(payload?.choices?.[0]?.message?.content ?? '');
    let patch;
    try {
      patch = JSON.parse(content.replace(/```json/gi, '').replace(/```/g, '').trim());
    } catch {
      throw new HttpError(502, 'ai_bad_json', '模型没有返回合法的 JSON 改动');
    }

    const opId = logOp(db, {
      userId: user.id,
      capability,
      action: 'draft',
      targetType: 'document_block',
      targetId: String(body.blockId ?? ''),
      status: 'preview',
      reason: instruction.slice(0, 200),
      before: body.block ?? null,
      after: patch,
    });

    return ctx.http.ok(reqCtx.res, { applied: false, opId, patch, model });
  });
}
