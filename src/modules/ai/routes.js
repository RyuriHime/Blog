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
  AI_SCOPES,
  AI_MAX_SECTION_BLOCKS,
  AI_MAX_RANGE_CHARS,
  AI_MAX_SECTION_INPUT,
  AI_RANGE_TARGET_TYPES,
  AI_MAX_TITLE,
  AI_TOKEN_USAGE_TABLE,
} from './schema.js';
import { splitSections, SECTION_OPENING_LABEL } from './sections.js';
import {
  AI_TEMPLATE_KEYS,
  AI_BLOCK_PROP_GUIDE,
  AI_SANDBOX_GUIDE,
  AI_AUTHORING_GUIDE,
  AI_FENCE_GUIDE,
} from './syntax.js';
import { repairBlock, repairBlockList, repairMarkdown, describeRepairs } from './programs.js';
import {
  AI_PRICE_CURRENCY,
  AI_PRICE_UNIT,
  AI_PRICE_SOURCE,
  AI_PRICE_ENV_KEYS,
  AI_OFF_PEAK_FACTOR,
  isPeakHour,
  shapeTokenUsage,
  summarizeCost,
  priceFor,
  priceNote,
} from './pricing.js';

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
 * 没配模型就先给 503 —— 关键在于它**必须排在 `rateLimit` 之前**，一次额度都不许吃。
 *
 * 为什么单列一个函数：`rateLimit` 是 `src/core/http.js` 里的内存桶，只给「检查」
 * 不给「退还」（core 文件我改不得）。以前 `/draft-range` 连打 5 次「没配 key 的 503」
 * 就把每分钟 5 次用完，第 6 次是 429 —— 用户一次模型都没用上、一分钱没花。
 * 每日配额（`usedToday`）与全站闸门（`siteUsedToday`）都排除 `blocked` 行，限流跟上同一个口径。
 */
function requireModelConfigured(
  db,
  { userId, capability, action, targetId, targetType = 'document_block' },
) {
  if (process.env.AI_API_KEY) return;
  logBlocked(db, userId, capability, action, targetId, 'ai_not_configured', targetType);
  throw new HttpError(503, 'ai_not_configured', '没有配置 AI_API_KEY，无法调用模型');
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

/** 是不是一个普通的 JSON 对象（不是 null / 数组 / 标量）。 */
function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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
function logBlocked(db, userId, capability, action, targetId, reason, targetType = 'document_block') {
  logOp(db, {
    userId,
    capability,
    action,
    targetType,
    targetId: String(targetId ?? ''),
    status: AI_BLOCKED_STATUS,
    reason,
  });
}

/**
 * 把一次模型调用的 token 用量记进 `ai_token_usage`（成本面板的钱就靠这张表）。
 *
 * **只记真的打到上游、且上游答了的那次**（`callModel` 里 HTTP 200 拿到 payload 之后）：
 * 内容是不是合法 JSON 与花不花钱无关 —— 坏 JSON 的应答上游照样计费，
 * 所以这一行在 `parseModelJson` 之前就写下了。
 *
 * `peak` 按**此刻**判并落库，不留给读的时候再算（计费看调用那一刻，见 pricing.js）。
 * 记账本身不许抛：一次成功的模型调用不该因为记不上账而变成 500。
 */
function recordTokenUsage(db, { userId, action, model, usage, at = Date.now() }) {
  try {
    db.prepare(
      `INSERT INTO ${AI_TOKEN_USAGE_TABLE}
         (user_id, action, model, prompt_tokens, cached_tokens, completion_tokens, peak, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      userId,
      String(action ?? ''),
      String(model ?? ''),
      usage.promptTokens,
      usage.cachedTokens,
      usage.completionTokens,
      isPeakHour(at) ? 1 : 0,
      at,
    );
  } catch {
    // 表在、列在（schema.js 建的是它），能失败只有磁盘/权限这类环境问题 ——
    // 吞掉它，调用方拿到的仍然是一次正常的模型结果。
  }
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

/** 一小节的块数组：必须是 `[{ blockId, type, props }]`。返回毛病描述，空串表示合法。 */
function sectionBlocksProblem(list, label = 'blocks') {
  if (!Array.isArray(list)) return `${label} 必须是数组`;
  if (list.length === 0) return `${label} 不能是空数组`;
  if (list.length > AI_MAX_SECTION_BLOCKS) {
    return `${label} 有 ${list.length} 块，超过一批 ${AI_MAX_SECTION_BLOCKS} 条的上限（落盘走 POST /api/docs/:id/ops）`;
  }
  const seen = new Set();
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    const problem = blockPatchProblem(item);
    if (problem) return `${label}[${i}] ${problem}`;
    const id = String(item.blockId ?? '').trim();
    if (id === '') return `${label}[${i}] 缺 blockId —— 回写要靠它认块`;
    if (id.length > 64) return `${label}[${i}] blockId 太长（上限 64）`;
    if (id.includes(':')) return `${label}[${i}] blockId 里不能有冒号`;
    if (seen.has(id)) return `${label}[${i}] blockId 重复（「${id}」出现两次）`;
    seen.add(id);
  }
  return '';
}

/** 校验通过后取出干净的块数组：只留 `blockId` / `type` / `props`。 */
function cleanSectionBlocks(list) {
  return list.map((item) => ({
    blockId: String(item.blockId).trim(),
    type: item.type,
    props: item.props ?? {},
  }));
}

/** 两个 props 是不是同一份内容（键序无关 —— 数据库里的键序和模型吐的不一定一样）。 */
function sameProps(a, b) {
  const norm = (value) => {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(norm);
    return Object.keys(value)
      .sort()
      .reduce((out, key) => {
        out[key] = norm(value[key]);
        return out;
      }, {});
  };
  return JSON.stringify(norm(a ?? {})) === JSON.stringify(norm(b ?? {}));
}

/**
 * 这一节里**真的改了**的块有几块。
 *
 * 不能用「模型返回了几块」充数：提示词要求它整节收齐，一字未动的块也会原样吐回来，
 * 那样报出来的数字永远是整节的长度，用户看到的「改了 8 块」其实是「这一节有 8 块」。
 */
function countChangedBlocks(before, after) {
  return after.filter((block) => {
    const was = before.find((item) => item.blockId === block.blockId);
    return !was || was.type !== block.type || !sameProps(was.props, block.props);
  }).length;
}

/**
 * 模型返回的一节改动：`{ blocks: [{ blockId, type, props }], markdown }`。
 *
 * 比用户提交的那条路严一档：`allowedIds` 是**我发过去的那一节**的块 id，
 * 模型吐回来的每个 blockId 都必须在里面。模型很擅长发明 id（`b7`、`block-3`），
 * 放过去就是往一篇文档里写一块并不属于这一节、甚至并不存在的东西。
 *
 * `markdown` 是给**界面**看的：用户明确要求「别给我 JSON，给渲染后的预览」，
 * 而这一节要显示成什么样，只能由 P2 的渲染器说了算（`POST /api/docs/:id/preview`）。
 * 所以同一节要两份：`blocks` 用于**精确落盘**（走 ops，块 id 不乱），
 * `markdown` 只用于**渲染预览**，绝不参与写盘。两份不一致时以 `blocks` 为准。
 */
function sectionPatchProblem(value, allowedIds) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return '必须是一个对象 { blocks: [...], markdown }';
  }
  const problem = sectionBlocksProblem(value.blocks, 'blocks');
  if (problem) return problem;
  const allowed = new Set(allowedIds);
  const returned = new Set();
  for (let i = 0; i < value.blocks.length; i += 1) {
    const id = String(value.blocks[i].blockId).trim();
    if (!allowed.has(id)) return `blocks[${i}].blockId「${id}」不在我发过去的这一节里（块 id 必须原样照抄）`;
    returned.add(id);
  }
  // 必须整节收齐：落盘走 `POST /api/docs/:id/ops`，那一步要求 before / after 的块
  // id **一一对应**。模型少吐一块，这里放过就变成「草拟能成、落盘 400」—— 与其把
  // 一个半成品交给用户点落盘，不如现在就说清楚。
  for (const id of allowed) {
    if (!returned.has(id)) {
      return `这一节的块「${id}」没出现在 blocks 里 —— 一节要整节收齐（少一块就对不上盘）`;
    }
  }
  if (typeof value.markdown !== 'string' || value.markdown.trim() === '') {
    return 'markdown 不能为空 —— 界面靠它渲染这一节的预览（blocks 只用于落盘）';
  }
  if (value.markdown.length > AI_MAX_RANGE_CHARS) {
    return `markdown 太长了（${value.markdown.length} 字符，上限 ${AI_MAX_RANGE_CHARS}）`;
  }
  return '';
}

/**
 * 整篇的旧值 / 新值：`{ markdown, title? }`，或者「直接套站内模板」的 `{ template, title? }`。
 *
 * `template` 这条路径是给「帮我做个投票问卷」这类要求用的：站里已经有维护好的成品，
 * 让模型现编 Markdown 反而更容易编歪（也更容易超出 `AI_MAX_RANGE_CHARS`）。
 * 两种形状**二选一**：同时给 template 与 markdown 就报错，免得两个解释打架。
 */
function documentPatchProblem(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return `${label} 必须是对象 { markdown }`;
  }
  const hasTemplate = typeof value.template === 'string' && value.template.trim() !== '';
  if (value.template !== undefined && value.template !== null && !hasTemplate) {
    return `${label}.template 必须是非空字符串`;
  }
  if (hasTemplate) {
    const key = value.template.trim();
    if (!AI_TEMPLATE_KEYS.some((item) => item.key === key)) {
      return `${label}.template「${key}」不是站里的模板（可选：${AI_TEMPLATE_KEYS.map((item) => item.key).join('、')}）`;
    }
    if (typeof value.markdown === 'string' && value.markdown.trim() !== '') {
      return `${label} 同时给了 template 与 markdown，只能二选一`;
    }
  } else if (typeof value.markdown !== 'string' || value.markdown.trim() === '') {
    return `${label}.markdown 必须是非空字符串`;
  }
  if (typeof value.markdown === 'string' && value.markdown.length > AI_MAX_RANGE_CHARS) {
    return `${label}.markdown 有 ${value.markdown.length} 字符，超过 ${AI_MAX_RANGE_CHARS} 的上限`;
  }
  if (value.title !== undefined && value.title !== null) {
    if (typeof value.title !== 'string') return `${label}.title 必须是字符串`;
    if (value.title.length > AI_MAX_TITLE) return `${label}.title 太长（上限 ${AI_MAX_TITLE}）`;
  }
  return '';
}

function cleanDocumentPatch(value) {
  const patch = {};
  if (typeof value.template === 'string' && value.template.trim() !== '') patch.template = value.template.trim();
  if (typeof value.markdown === 'string') patch.markdown = value.markdown;
  if (typeof value.title === 'string' && value.title.trim() !== '') patch.title = value.title.trim();
  return patch;
}

/** 站里有哪些模板 —— 拼进整篇提示词，让模型知道「可以只回一个 template」。 */
function templateMenu() {
  return `站里现成的模板：${AI_TEMPLATE_KEYS.map((item) => `${item.key}（${item.title}：${item.description}）`).join('；')}。`;
}

/* ---------------- 审查（原「AI 学术审查」的接班人） ---------------- */

/**
 * 审查的六类问题 —— 口径与 `note-agent/src/prompts.mjs` 的 `REVIEW_SYSTEM` 一致。
 *
 * 那边是「学术笔记」抽屉里的学术审查，入口已经下线（笔记功能整体隐掉了），
 * 但用户要的**能力**没下线：换成在积木这一侧提供同样的审查。这里手抄一份口径，
 * 是因为两边代码零共享（骨架规范不许业务模块互相 import）。
 */
const AI_REVIEW_KINDS = Object.freeze(['logic', 'fact', 'structure', 'clarity', 'citation', 'formula']);
const AI_REVIEW_SEVERITIES = Object.freeze(['high', 'medium', 'low']);
const AI_MAX_FINDINGS = 12;
const AI_MAX_REVIEW_TEXT = 400;

/**
 * 审查的系统提示词。
 *
 * 与块/整篇提示词的区别：审查**不改稿、不落盘**，只回意见；而且每条意见必须
 * 原样引用草稿里的一段文字（少于 6 个字或引用不到的会被 `reviewFindings` 丢掉）
 * ——「建议补充更多细节」这种无法验证的空话就是这么挡掉的。
 */
function reviewSystemPrompt() {
  return [
    '你是一个严格的中文编辑，审查一篇「积木帖子」草稿的内容、逻辑与结构。',
    '你**只提意见，不改稿**：不要重写整篇，也不要输出改完的正文。',
    '只指出**有证据的问题**，不要写「建议补充更多细节」「建议增加例子」这类无法验证的空话。',
    '只输出一个 JSON 对象，不要解释文字，也不要 Markdown 代码围栏，形状必须是：',
    '{"summary":"≤200 字的总体评价",',
    '"findings":[{"blockId":"涉及的那一块 id（我给你的清单里标了，判断不出就填空串）",',
    '"kind":"logic|fact|structure|clarity|citation|formula","severity":"high|medium|low",',
    '"quote":"草稿里**原样出现**的一段文字（不少于 6 个字，必须逐字照抄）",',
    '"issue":"≤120 字，问题是什么","suggestion":"≤200 字，应该怎么改",',
    '"patch":"如果建议就是「把 quote 换成另一段文字」，给出替换后的文字；否则空串"}],',
    '"strengths":["草稿做得好的地方，最多 3 条"]}',
    '每条发现都必须能原样引用草稿里的文字 —— 引用不出来就别写这一条，宁可少写。',
    `findings 最多 ${AI_MAX_FINDINGS} 条，按 severity 从高到低排。`,
    '六类问题的含义：logic 推理跳跃、结论与前提不符；fact 事实、数据、定义、公式写错；',
    'structure 层级混乱、内容放错位置；clarity 指代不明、术语前后不一致；',
    'citation 声称有来源却没有出处；formula LaTeX 写错、符号未定义、公式与文字矛盾。',
    '积木特有的毛病也属于审查范围：投票的选项不合理、小应用/脚本的代码跑不起来、',
    '代码里申请了沙箱没有的能力、图片没写 alt、表格口径没交代。',
  ].join('\n');
}

/** 把要审查的内容拼成一段带块 id 的文本 —— 让模型能引用 `blockId`，也让 `quote` 可核对。 */
function reviewTextOf({ blocks, markdown }) {
  if (Array.isArray(blocks) && blocks.length) {
    return blocks
      .map((item) => {
        const props = item.props && typeof item.props === 'object' ? item.props : {};
        const text = typeof props.text === 'string' && props.text !== '' ? props.text : JSON.stringify(props);
        return `【${item.blockId} · ${item.type}】\n${text}`;
      })
      .join('\n\n');
  }
  return markdown;
}

/**
 * 清洗 + 核对模型给的审查结果：`reviewFindings({ raw, source })`。
 * 返回 `{ value, dropped }` —— `dropped` 是「引用对不上草稿」被丢掉的条数，
 * 要报给调用方，不能悄悄吞掉（否则界面上会显示一份「比模型说的少」的意见而无人知情）。
 */
function reviewFindings({ raw, source }) {
  const findings = [];
  let dropped = 0;
  const rawList = Array.isArray(raw.findings) ? raw.findings : [];
  for (const item of rawList) {
    if (!item || typeof item !== 'object') {
      dropped += 1;
      continue;
    }
    const quote = typeof item.quote === 'string' ? item.quote.trim() : '';
    if (quote.length < 6 || (source !== '' && !source.includes(quote))) {
      dropped += 1;
      continue;
    }
    const issue = typeof item.issue === 'string' ? item.issue.trim() : '';
    if (issue === '') {
      dropped += 1;
      continue;
    }
    const kind = AI_REVIEW_KINDS.includes(item.kind) ? item.kind : 'logic';
    const severity = AI_REVIEW_SEVERITIES.includes(item.severity) ? item.severity : 'low';
    findings.push({
      blockId: typeof item.blockId === 'string' ? item.blockId.trim().slice(0, 40) : '',
      kind,
      severity,
      quote: quote.slice(0, 400),
      issue: issue.slice(0, 200),
      suggestion: typeof item.suggestion === 'string' ? item.suggestion.trim().slice(0, 300) : '',
      patch: typeof item.patch === 'string' ? item.patch.slice(0, AI_MAX_RANGE_CHARS) : '',
    });
    if (findings.length >= AI_MAX_FINDINGS) break;
  }
  const order = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  const summary = typeof raw.summary === 'string' ? raw.summary.trim().slice(0, AI_MAX_REVIEW_TEXT) : '';
  const strengths = Array.isArray(raw.strengths)
    ? raw.strengths.filter((line) => typeof line === 'string' && line.trim() !== '').slice(0, 3)
    : [];
  return { value: { summary, findings, strengths }, dropped };
}

/** 审查结果必须是对象，且 `findings` 要是个数组（空数组也算，模型可以说「没毛病」）。 */
function reviewShapeProblem(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return '顶层必须是对象';
  if (!Array.isArray(value.findings)) return 'findings 必须是数组';
  return '';
}

/**
 * 块级改写的系统提示词。
 *
 * 抽出来是因为它现在有三个用户：单块 `/draft`、按小节 `/draft-range`、以及
 * `scripts/ai-smoke.mjs` 里对措辞的断言。同一段话在两处各写一份，
 * 改了一处忘另一处，模型就按老规矩吐形状 —— 落盘时才炸（这条踩过一次了：
 * 旧提示词用的是自造的 `{ blockType, content }`，模型照着发明了不存在的 `vote` 类型）。
 *
 * 具体的字段表 / 沙箱说明 / 取舍规则放在 `./syntax.js`（骨架规范不许业务模块互相
 * import，所以那边是手抄的一份，靠 `scripts/ai-smoke.mjs` 第 19 节的哨兵盯漂移）。
 * 这里只负责把它们拼成一段话 —— 老版本只写了七种块、poll 的 options 还写成字符串
 * 数组，结果模型不知道该用 `app` 做小工具，也不知道 vote 不存在。
 */
function blockPromptRules() {
  return [
    `type 只能取这些名字之一：${AI_BLOCK_TYPES.map((item) => `${item.name}（${item.label}）`).join('、')}。`,
    AI_BLOCK_PROP_GUIDE.join('\n'),
    AI_SANDBOX_GUIDE.join('\n'),
    AI_AUTHORING_GUIDE.join('\n'),
    AI_FENCE_GUIDE.join('\n'),
    '用户没要求改的部分保持原样。',
  ].join('\n');
}

function blockSystemPrompt() {
  return [
    '你是博客「积木帖子」的块编辑器。用户给你当前这一块，以及一句改写要求。',
    '你只改这一块，绝不重写整篇，也不要碰别的块。',
    '只输出一个 JSON 对象，形状必须是 {"type":"<块类型>","props":{…}}，',
    '不要输出解释文字，也不要 Markdown 代码围栏。',
    blockPromptRules(),
  ].join('');
}

/** 按小节改写的系统提示词：输入是一节的若干块，输出**改过的块 + 这一节的 Markdown**。 */
function sectionSystemPrompt() {
  return [
    '你是博客「积木帖子」的块编辑器。用户给你**一个小节**里的若干块（JSON 数组，按顺序，每块有 blockId）。',
    '你只改这个小节里的内容，绝不改别的块，也不要增删块。',
    '只输出一个 JSON 对象，形状必须是',
    '{"blocks":[{"blockId":"原样的 id","type":"<块类型>","props":{…}}],"markdown":"<这一节改完之后的 Markdown>"}。',
    'blocks 里只列出**你改动过**的块；blockId 必须原样照抄我给的那个，不许发明新的，也不许改 id。',
    'markdown 是给界面渲染预览用的：把**整个小节**（包括没改的块）按顺序写成 Markdown，',
    '标题用 # 开头，正文就是正文；它必须和 blocks 表达的是同一份内容（以 blocks 为准，markdown 不许夹带新东西）。',
    '不要输出解释文字，也不要 Markdown 代码围栏。',
    blockPromptRules(),
  ].join('');
}

/** 整篇改写的系统提示词：输入整篇 Markdown，输出改完的整篇 Markdown，或「套某个模板」。 */
function documentSystemPrompt() {
  return [
    '你是博客「积木帖子」的整篇编辑器。用户给你**整篇 Markdown**，以及一句改写要求。',
    '只输出一个 JSON 对象，形状必须是 {"markdown":"<改完的整篇>"}，',
    '可选一个 "title" 字段（用户明确要求改标题时再给）。',
    templateMenu(),
    '如果用户要的整篇**正好就是某个模板**（例如「改成投票问卷的样子」「按实验记录来写」），',
    '你可以只输出 {"template":"<模板 key>"} —— 前端会把站里维护好的模板套上去；',
    '给了 template 就不要再给 markdown，两者只能二选一。',
    '模板都不合适时才自己写 markdown：',
    '没让改的部分照抄原样，不要顺手润色；不要输出解释文字；最外层不要把整个 JSON 包进代码围栏。',
    // 整篇模式最容易栽在这里：模型知道本站有 ```` ```doc:<类型> ```` 围栏，却只写了
    // `doc:app` 那半行、围栏没写 —— P2 的解析器（`blocks/markdown.js`）只认围栏，
    // 裸文本一律变成普通正文（`prose`），程序就变成了一堆打印出来的 JSON。
    'Markdown 里的积木块必须写成围栏块：三个反引号开头、紧跟 doc:<块类型>、换行后是 JSON、再用三个反引号收尾，例如：',
    '```doc:poll\\n{"question":"…","options":[{"id":"o1","text":"甲"},{"id":"o2","text":"乙"}]}\\n```',
    '**围栏不能省**：光写 doc:poll 那半行，它只会被当成普通正文打印出来（详见下面「照抄围栏块的三条铁律」）。',
    '小应用（能在浏览器里跑的程序）的围栏体是 {"app":"应用名","config":{},"code":"<button>…</button><script>…<\\/script>"}，',
    '代码全部在 code 里（样式写 <style>、脚本写 <script>），**没有 title / html / css / js 这些字段**；',
    '代码跑在隔离 iframe 里：只有内联脚本与内联样式、**没有网络**，不许写 <link>、外链 CDN 或 fetch / XMLHttpRequest；',
    '照抄已有的围栏块时，类型名与字段名一个字都别改；没见过的块类型不要发明（每类块的 props 见块编辑器的说明）。',
    AI_FENCE_GUIDE.join('\n'),
    '注意：本站的 Markdown 与积木块是互转的，转换有损（表格分隔行会被剥掉、嵌套列表会被并成一块），',
    '能不动结构就别动结构。',
    '要「能跑的东西」（投票、小工具、小界面）时，直接在 markdown 里写 ```doc:poll / ```doc:app 围栏，',
    '围栏里的 JSON 规则见块编辑器的说明（形状写错会退化成普通代码块）。',
  ].join('');
}

/**
 * 真发一次模型调用，把模型返回的**原文**拿回来。
 *
 * 返回 `{ content, model, usage }`：解析和形状校验留给调用方（块 / 小节 / 整篇三种形状不同，
 * 但坏形状一律用既有的 `ai_bad_json`，不新造代号）。
 *
 * `usage` 是上游报的 token 用量（`{ promptTokens, cachedTokens, completionTokens }`），
 * 到手就顺手记进 `ai_token_usage`（成本面板的钱靠它）。**记在这里而不是调用方**：
 * 四个调用点里有两个（草拟、评审）拿到内容就走自己的岔路，放调用方迟早漏一个；
 * 而且上游是**按 token 计费**的 —— 返回半截 JSON、调用方要报 `ai_bad_json` 的那次
 * 照样收钱，所以这一行必须写在「HTTP 200 拿到 payload」之后、「解析」之前。
 * 上游没报 usage（例如某些兼容网关）时三个数都是 0，金额按 0 算，不猜。
 *
 * 所有「发不出去 / 被上游拒绝」的分支都在这里 `logBlocked` —— 以前只有「连不上」
 * 和「超时」写日志，被 401/403/429/500 拒绝的那几条什么都不记，审计就是缺的。
 * 抽成一个函数也是为了让下一个接口不可能漏掉这几行。被拒的分支**没有** token 可记：
 * 上游没生成内容，也就没有用量。
 */
async function callModel(
  db,
  { userId, capability, action, targetId, targetType = 'document_block', system, userText },
) {
  // 没配 key 的 503 在这里；路由在 `rateLimit` 之前已经先问过一次（同一个函数），
  // 那次之后 key 不会凭空出现，所以这里通常只是兜底。
  requireModelConfigured(db, { userId, capability, action, targetId, targetType });
  // 上面那行不抛就说明 key 在，所以这里直接取来用（同一个环境变量，不复制一份判断）。
  const apiKey = process.env.AI_API_KEY;

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
          { role: 'system', content: system },
          { role: 'user', content: userText },
        ],
      }),
      signal: controller.signal,
    });
  } catch (error) {
    const aborted = error?.name === 'AbortError';
    logBlocked(db, userId, capability, action, targetId, aborted ? 'ai_timeout' : 'ai_unreachable', targetType);
    throw new HttpError(
      aborted ? 504 : 502,
      aborted ? 'ai_timeout' : 'ai_unreachable',
      aborted ? `模型调用超过 ${timeoutMs}ms` : '连不上模型服务',
    );
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 || response.status === 403) {
    logBlocked(db, userId, capability, action, targetId, 'ai_unauthorized', targetType);
    throw new HttpError(502, 'ai_unauthorized', '模型服务拒绝了这个 API key');
  }
  if (response.status === 429) {
    logBlocked(db, userId, capability, action, targetId, 'ai_rate_limited', targetType);
    throw new HttpError(429, 'ai_rate_limited', '模型服务限流了，请稍后再试');
  }
  if (!response.ok) {
    logBlocked(db, userId, capability, action, targetId, `ai_upstream_error ${response.status}`, targetType);
    throw new HttpError(502, 'ai_upstream_error', `模型服务返回 ${response.status}`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    logBlocked(db, userId, capability, action, targetId, 'ai_bad_json', targetType);
    throw new HttpError(502, 'ai_bad_json', '模型返回的不是 JSON');
  }

  const content = String(payload?.choices?.[0]?.message?.content ?? '');
  // 计费与「内容合不合法」无关：先记账，再让调用方去解析（坏 JSON 也是花过钱的）。
  const usage = shapeTokenUsage(payload?.usage);
  recordTokenUsage(db, { userId, action, model: String(payload?.model || model), usage });
  return { content, model, usage };
}

/** 模型原文 → JSON。坏 JSON 一律 `ai_bad_json` 502，并在日志里留一条 blocked。 */
function parseModelJson(content, { db, userId, capability, action, targetId, targetType = 'document_block' }) {
  try {
    return JSON.parse(String(content).replace(/```json/gi, '').replace(/```/g, '').trim());
  } catch {
    logBlocked(db, userId, capability, action, targetId, 'ai_bad_json', targetType);
    throw new HttpError(502, 'ai_bad_json', '模型没有返回合法的 JSON 改动');
  }
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
  // 这两个字段以前是客户端说了算：随便一个授权（当时目录里还有低风险的能力）的人，把 capability
  // 填成那项低风险能力就能让这条接口落盘一次内容改写；带上 `action: 'grant'` 还能把日志
  // 伪造成一条授权记录。
  routes.add('POST', '/api/ai-edit/ops', (reqCtx) => {
    const user = viewer(reqCtx);
    const body = reqCtx.body ?? {};
    const capability = AI_CONTENT_CAPABILITY;
    guardCapability(db, user.id, capability);

    // 粒度（用户 2026-10 的需求：块太碎，要么整篇、要么按小标题一节一节来）。
    // 缺省 `block` 是历史行为，旧前端不传 scope 时逐字不变。
    const scope =
      body.scope === undefined || body.scope === null || body.scope === '' ? 'block' : String(body.scope);
    ensure(
      scope === 'block' || scope === 'section' || scope === 'document',
      400,
      'bad_request',
      `scope 只能是 block（单块）/ section（一小节）/ document（整篇），收到「${scope}」`,
    );

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
    const reason = String(body.reason ?? '').slice(0, AI_MAX_REASON);

    // 落盘前的最后一道形状纠正（见 `programs.js`）。前端送来的 `after` 一般已经是被
    // `/draft` 摆正过的，但这条接口是公开契约：手工拼的请求、或者没跟上的旧前端，都可能
    // 把「模型原样吐出来的自造形状」直接送到这里。就地摆正后再走校验 —— 摆完还是非法
    // （缺 blockId、超长、类型不认识）一样 400。`before` 一律不动：它描述的是改动前的
    // 样子，回滚要写回的正是它。
    const repairNotes = [];
    if (scope === 'document') {
      if (isRecord(body.after) && typeof body.after.markdown === 'string') {
        const fixed = repairMarkdown(body.after.markdown);
        body.after.markdown = fixed.value;
        repairNotes.push(...fixed.notes);
      }
    } else if (scope === 'section') {
      if (Array.isArray(body.after)) {
        const fixed = repairBlockList(body.after, body.before);
        body.after = fixed.value;
        repairNotes.push(...fixed.notes);
      }
    } else if (isRecord(body.after) || Array.isArray(body.after)) {
      const fixed = repairBlock(body.after);
      body.after = fixed.value;
      repairNotes.push(...fixed.notes);
    }
    const repairs = describeRepairs(repairNotes);

    // 两种粒度共用一套外壳，只有「校验什么形状 / targetType / targetId / 往哪儿写」不同。
    let targetType = 'document_block';
    let targetId = '';
    let cleanBefore = null;
    let cleanAfter = null;
    let writeTo = '';
    let blockId = '';

    if (scope === 'document') {
      // 整篇：`{ markdown, title? }`。写盘走 P2 的 `PUT /api/docs/:id/markdown`。
      const afterProblem = documentPatchProblem(body.after, 'after');
      ensure(!afterProblem, 400, 'bad_request', `after 不是合法的整篇改动（${afterProblem}）`);
      if (body.before !== undefined && body.before !== null) {
        const beforeProblem = documentPatchProblem(body.before, 'before');
        ensure(!beforeProblem, 400, 'bad_request', `before 不是合法的整篇改动（${beforeProblem}）`);
        cleanBefore = cleanDocumentPatch(body.before);
      }
      cleanAfter = cleanDocumentPatch(body.after);
      targetType = AI_RANGE_TARGET_TYPES.document;
      targetId = composeTargetId(documentId, '*');
      writeTo = `/api/docs/${encodeURIComponent(documentId)}/markdown`;
    } else if (scope === 'section') {
      // 一小节：两边的块数组必须覆盖**同一批** blockId。回滚写回的是 `before` 那些块，
      // 集合对不上就会出现「回滚漏改一半」或者「回滚凭空多出一块」。
      const afterProblem = sectionBlocksProblem(body.after, 'after');
      ensure(!afterProblem, 400, 'bad_request', `after 不是合法的一节改动（${afterProblem}）`);
      const beforeProblem = sectionBlocksProblem(body.before, 'before');
      ensure(!beforeProblem, 400, 'bad_request', `before 不是合法的一节改动（${beforeProblem}）`);
      cleanAfter = cleanSectionBlocks(body.after);
      cleanBefore = cleanSectionBlocks(body.before);
      const idsOf = (list) => list.map((item) => item.blockId).sort().join('\u0000');
      ensure(
        idsOf(cleanBefore) === idsOf(cleanAfter),
        400,
        'bad_request',
        'before / after 的 blockId 必须一一对应（回滚要按同一批块写回）',
      );
      targetType = AI_RANGE_TARGET_TYPES.section;
      const label =
        cleanAfter.length === 1
          ? cleanAfter[0].blockId
          : `${cleanAfter[0].blockId}~${cleanAfter[cleanAfter.length - 1].blockId}`;
      targetId = composeTargetId(documentId, label);
      // 一节 50 块时 `b1~b50` 还没问题，但 id 本身可以长到 64 —— 兜一下，
      // 宁可目标栏写「这一节有几块」，也不要一条超长的 target_id 灌进日志。
      if (targetId.length > AI_MAX_TARGET_ID) {
        targetId = composeTargetId(documentId, `section(${cleanAfter.length})`);
      }
      writeTo = `/api/docs/${encodeURIComponent(documentId)}/ops`;
    } else {
      const after = body.after ?? null;
      const afterProblem = blockPatchProblem(after);
      ensure(
        !afterProblem,
        400,
        'bad_request',
        `after 不是合法的块（${afterProblem}）—— 单块模式只接受 { type, props }，要整篇或整节请带 scope`,
      );
      const before = body.before ?? null;
      if (before !== null) {
        const beforeProblem = blockPatchProblem(before);
        ensure(!beforeProblem, 400, 'bad_request', `before 不是合法的块（${beforeProblem}）`);
      }
      // 审计和返回里只能出现 `{ type, props }`：`after` / `before` 来自请求体，可能夹带
      // 别的键（上一轮实测就存进过 `{"type":"poll","props":{…},"blockType":"vote","content":{…}}`
      // —— 旧形状的键跟着新形状一起进了库）。`cleanBlockPatch` 只留 type / props。
      cleanAfter = cleanBlockPatch(after);
      cleanBefore = before === null ? null : cleanBlockPatch(before);

      // 目标恒为「某个文档里的某一块」：`targetType` 由服务端写死，`targetId` 由服务端拼，
      // 客户端塞不进任意字符串（以前 targetType 可以是 not_a_real_thing、
      // targetId 能塞 5000 个字符）。
      blockId = String(body.blockId ?? '').trim();
      ensure(blockId.length >= 1, 400, 'bad_request', 'blockId 不能为空');
      ensure(!blockId.includes(':'), 400, 'bad_request', 'blockId 里不能有冒号');
      targetId = composeTargetId(documentId, blockId);
      ensure(
        targetId.length <= AI_MAX_TARGET_ID,
        400,
        'bad_request',
        `documentId + blockId 太长（上限 ${AI_MAX_TARGET_ID} 个字符）`,
      );
      writeTo = `/api/docs/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(blockId)}`;
    }

    ensure(
      targetId.length <= AI_MAX_TARGET_ID,
      400,
      'bad_request',
      `targetId 太长（上限 ${AI_MAX_TARGET_ID} 个字符）`,
    );

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
        scope,
        // 形状纠正做了什么，明说（见 `programs.js`）。
        ...(repairs === '' ? {} : { repairs }),
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
      scope,
      targetType,
      targetId,
      documentId,
      // `blockId` 只在单块模式下有意义；两种新粒度用 `before` / `after` 的形状区分
      // （块数组 = 一节，`{markdown}` = 整篇），回滚拿回来的 `restore` 也是同一套形状。
      ...(scope === 'block' ? { blockId } : {}),
      // 形状纠正做了什么，明说（见 `programs.js`）。
      ...(repairs === '' ? {} : { repairs }),
      before: cleanBefore,
      after: cleanAfter,
      // 真正的写盘由调用方完成：documents / document_blocks 归 P2，我只读。
      // 我这边的职责是授权、审计和「改之前长什么样」。
      writeTo,
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

    // 顺序：先问「配没配 key」（不配则 503、不吃额度），再记一次限流，最后才发请求。
    // 校验不过的请求（instruction 空、block 太大）在这之前就已经 400 了，同样不吃额度。
    requireModelConfigured(db, { userId: user.id, capability, action: 'draft', targetId });
    // FR-AI-14：按用户限流，v1 是 10 次/分钟。
    rateLimit(`ai-edit:draft:${user.id}`, 10, 60 * 1000);

    const { content, model } = await callModel(db, {
      userId: user.id,
      capability,
      action: 'draft',
      targetId,
      system: blockSystemPrompt(),
      userText: `当前块（JSON）：${blockJson}\n改写要求：${instruction}`,
    });

    // 合法的 JSON ≠ 合法的块。模型完全可以吐回 `{"blockType":"vote","content":{…}}`
    // 这种自造形状 —— 这时候落盘会直接失败，所以在这里就挡住。
    // 用 `ai_bad_json`（既有代号）而不是新造一个，代号表见 docs/skeleton.md。
    const patch = parseModelJson(content, { db, userId: user.id, capability, action: 'draft', targetId });
    // 形状纠正（见 `programs.js`）：模型爱把「能跑的程序」写成正文里的 `doc:app` + JSON，
    // 或者自造 `{title,html,css,js}` 这种本站没有的形状。先摆正，再走原来那道校验
    // —— 摆完还是非法（缺 props、类型不认识）一样 502，规则一条都没放松。
    const salvaged = repairBlock(patch, cleanBlock);
    const patchProblem = blockPatchProblem(salvaged.value);
    if (patchProblem) {
      logBlocked(db, user.id, capability, 'draft', targetId, `ai_bad_json 块形状不对：${patchProblem}`);
      throw new HttpError(502, 'ai_bad_json', `模型没有返回合法的块（${patchProblem}）`);
    }
    const cleanPatch = cleanBlockPatch(salvaged.value);
    const repairs = describeRepairs(salvaged.notes);

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
      // 形状纠正做了什么，明说 —— 静悄悄改掉模型给的东西比报错更难查。
      ...(repairs === '' ? {} : { repairs }),
      model,
    });
  });

  // ── 9. 小节清单（纯切分：不调模型、不落库、不花钱）──────────────────────
  //
  // 前端的「改哪一节」下拉就用这份清单。切分之所以放在服务端，是因为它有两个用处：
  // 前端拿它渲染、`draft-range` 拿它校验「你发来的这堆块是连着的同一节」。
  // 两边各切一份必然漂移，而漂移的表现是「下拉里选第 3 节，实际改到别的块」。
  // 算法本体在 `src/modules/ai/sections.js`，`scripts/ai-smoke.mjs` 直接对它断言。
  routes.add('POST', '/api/ai-edit/sections', (reqCtx) => {
    viewer(reqCtx);
    const body = reqCtx.body ?? {};
    const blocks = body.blocks;
    ensure(Array.isArray(blocks), 400, 'bad_request', 'blocks 必须是数组（把这一篇的块按顺序发过来）');
    ensure(
      blocks.length <= AI_MAX_SECTION_INPUT,
      400,
      'bad_request',
      `块太多了（${blocks.length} 个，上限 ${AI_MAX_SECTION_INPUT}）`,
    );
    const sections = splitSections(blocks);
    return ctx.http.ok(reqCtx.res, {
      total: blocks.length,
      count: sections.length,
      maxSectionBlocks: AI_MAX_SECTION_BLOCKS,
      opening: SECTION_OPENING_LABEL,
      sections,
    });
  });

  // ── 10. AI 草拟一次「一节 / 整篇」的改动 ────────────────────────────────
  //
  // 与第 8 节的 `/draft`（单块）并列，不合并：单块的契约已经被 171 项回归钉住了，
  // 往里塞 scope 就得动它的返回形状。这一条只做两种粒度，失败代号与 `/draft` 完全一致
  // （503 `ai_not_configured` / 504 `ai_timeout` / 429 `ai_rate_limited` / 502 `ai_*`）。
  routes.add('POST', '/api/ai-edit/draft-range', async (reqCtx) => {
    const user = viewer(reqCtx);
    const body = reqCtx.body ?? {};
    const capability = AI_CONTENT_CAPABILITY;
    guardCapability(db, user.id, capability);
    // 真会发出去一次模型调用 —— 过全站闸门。
    guardSiteBudget(db);
    // 限流（整篇/整节比单块贵，收得比 `/draft` 的 10 次/分钟更紧）**放在校验之后**：
    // 与全站闸门同一个道理 —— 一个填错的请求（缺 blocks、scope 乱写）应该拿到 400
    // 告诉它哪里错了，而不是被记一次限流、还以为「额度用完了」。见下面两处调用。
    // 同样地，「没配 key」（`requireModelConfigured`）也排在那两处限流之前：
    // 503 一次模型都没用上，不该把每分钟 5 次吃掉。

    const scope = String(body.scope ?? '');
    ensure(
      AI_SCOPES.includes(scope),
      400,
      'bad_request',
      `scope 只能是 ${AI_SCOPES.join(' / ')}（section = 按小节，document = 整篇）`,
    );

    const instruction = typeof body.instruction === 'string' ? body.instruction.trim() : '';
    ensure(instruction.length >= 1, 400, 'bad_request', 'instruction 不能为空');
    ensure(instruction.length <= 2000, 400, 'bad_request', 'instruction 不能超过 2000 个字符');

    const rawDocumentId = body.documentId;
    const documentId =
      typeof rawDocumentId === 'number' && Number.isInteger(rawDocumentId) && rawDocumentId > 0
        ? String(rawDocumentId)
        : typeof rawDocumentId === 'string'
          ? rawDocumentId.trim()
          : '';
    ensure(documentId !== '', 400, 'bad_request', 'documentId 不能为空 —— 改稿要记清楚改的是哪一篇文档');
    ensure(!documentId.includes(':'), 400, 'bad_request', 'documentId 里不能有冒号');

    if (scope === 'section') {
      const blocksProblem = sectionBlocksProblem(body.blocks, 'blocks');
      ensure(!blocksProblem, 400, 'bad_request', `blocks 不是合法的一节（${blocksProblem}）`);
      const cleanBlocks = cleanSectionBlocks(body.blocks);
      const ids = cleanBlocks.map((item) => item.blockId);
      // 提示词体积就是账单（与 `/draft` 的 AI_MAX_BLOCK_CHARS 同一个理由）。
      const sent = JSON.stringify(cleanBlocks);
      ensure(
        sent.length <= AI_MAX_RANGE_CHARS,
        400,
        'bad_request',
        `这一节太大（${sent.length} 字符，上限 ${AI_MAX_RANGE_CHARS}）—— 拆成几节分别改`,
      );

      let targetId = composeTargetId(documentId, `${ids[0]}~${ids[ids.length - 1]}`);
      if (targetId.length > AI_MAX_TARGET_ID) {
        targetId = composeTargetId(documentId, `section(${cleanBlocks.length})`);
      }
      const heading = String(body.heading ?? '').trim().slice(0, 200);

      requireModelConfigured(db, {
        userId: user.id,
        capability,
        action: 'draft',
        targetId,
        targetType: AI_RANGE_TARGET_TYPES.section,
      });
      rateLimit(`ai-edit:draft-range:${user.id}`, 5, 60 * 1000);
      const { content, model } = await callModel(db, {
        userId: user.id,
        capability,
        action: 'draft',
        targetId,
        targetType: AI_RANGE_TARGET_TYPES.section,
        system: sectionSystemPrompt(),
        userText:
          `${heading ? `这一节的小标题：${heading}\n` : ''}` +
          `这一节的块（JSON 数组，按顺序）：${sent}\n改写要求：${instruction}`,
      });
      const patch = parseModelJson(content, {
        db,
        userId: user.id,
        capability,
        action: 'draft',
        targetId,
        targetType: AI_RANGE_TARGET_TYPES.section,
      });
      // 形状纠正（见 `programs.js`）：整节里可能混着被写成正文的程序块、或字段自造的小应用。
      // blockId 一个都不动，所以下面「整节收齐、id 一一对应」的校验该过还是过、该红还是红；
      // 预览用的 Markdown 一并摆正，免得块与预览各说一套。
      const patchObject = isRecord(patch) ? patch : null;
      const fixedBlocks = repairBlockList(patchObject ? patchObject.blocks : null, cleanBlocks);
      const fixedMarkdown =
        patchObject && typeof patchObject.markdown === 'string' ? repairMarkdown(patchObject.markdown) : null;
      const fixedPatch = patchObject
        ? { ...patchObject, blocks: fixedBlocks.value, ...(fixedMarkdown ? { markdown: fixedMarkdown.value } : {}) }
        : patchObject;
      const repairs = describeRepairs([...fixedBlocks.notes, ...(fixedMarkdown ? fixedMarkdown.notes : [])]);
      const patchProblem = sectionPatchProblem(fixedPatch, ids);
      if (patchProblem) {
        logBlocked(
          db,
          user.id,
          capability,
          'draft',
          targetId,
          `ai_bad_json 一节形状不对：${patchProblem}`,
          AI_RANGE_TARGET_TYPES.section,
        );
        throw new HttpError(502, 'ai_bad_json', `模型没有返回合法的一节改动（${patchProblem}）`);
      }
      const changed = cleanSectionBlocks(fixedPatch.blocks);
      // 预览用（给界面渲染，不落盘）：见 sectionPatchProblem 的注释。
      const previewMarkdown = String(fixedPatch.markdown).trim();
      const opId = logOp(db, {
        userId: user.id,
        capability,
        action: 'draft',
        targetType: AI_RANGE_TARGET_TYPES.section,
        targetId,
        status: 'preview',
        reason: instruction.slice(0, 200),
        before: cleanBlocks,
        after: changed,
      });
      return ctx.http.ok(reqCtx.res, {
        applied: false,
        opId,
        scope,
        patch: { blocks: changed, markdown: previewMarkdown },
        before: cleanBlocks,
        changedCount: countChangedBlocks(cleanBlocks, changed),
        targetType: AI_RANGE_TARGET_TYPES.section,
        targetId,
        documentId,
        model,
        // 形状纠正做了什么，明说（见 `programs.js`）。
        ...(repairs === '' ? {} : { repairs }),
        writeTo: `/api/docs/${encodeURIComponent(documentId)}/ops`,
        hint: '这是预览，没有落盘。落盘由前端完成：先 POST /api/docs/:id/ops 写盘，再带 confirm: true 调 /api/ai-edit/ops 记一条 applied 审计。',
      });
    }

    const markdown = typeof body.markdown === 'string' ? body.markdown : '';
    ensure(
      markdown.trim() !== '',
      400,
      'bad_request',
      'markdown 不能为空（整篇模式要先把当前的 Markdown 发过来）',
    );
    ensure(
      markdown.length <= AI_MAX_RANGE_CHARS,
      400,
      'bad_request',
      `整篇有 ${markdown.length} 字符，超过上限 ${AI_MAX_RANGE_CHARS} —— 整篇改写是最贵的动作，这一篇请改用「按小节」`,
    );
    const targetId = composeTargetId(documentId, '*');
    const before = { markdown };
    if (typeof body.title === 'string' && body.title.trim() !== '') {
      before.title = body.title.trim().slice(0, AI_MAX_TITLE);
    }

    requireModelConfigured(db, {
      userId: user.id,
      capability,
      action: 'draft',
      targetId,
      targetType: AI_RANGE_TARGET_TYPES.document,
    });
    rateLimit(`ai-edit:draft-range:${user.id}`, 5, 60 * 1000);
    const { content, model } = await callModel(db, {
      userId: user.id,
      capability,
      action: 'draft',
      targetId,
      targetType: AI_RANGE_TARGET_TYPES.document,
      system: documentSystemPrompt(),
      userText: `当前整篇 Markdown：\n${markdown}\n改写要求：${instruction}`,
    });
    const patch = parseModelJson(content, {
      db,
      userId: user.id,
      capability,
      action: 'draft',
      targetId,
      targetType: AI_RANGE_TARGET_TYPES.document,
    });
    // 形状纠正（见 `programs.js`）：裸写的 `doc:app` 补围栏、围栏体里的自造字段就地摆正。
    // 连「模型把原文照抄回来」这种最坏情况都救得回来 —— 原文里那段跑不起来的 JSON，
    // 会在这里变成一块真正的小应用。摆完还是非法就照旧 502。
    const patchObject = isRecord(patch) ? patch : null;
    const fixedMarkdown =
      patchObject && typeof patchObject.markdown === 'string' ? repairMarkdown(patchObject.markdown) : null;
    const fixedPatch = patchObject
      ? { ...patchObject, ...(fixedMarkdown ? { markdown: fixedMarkdown.value } : {}) }
      : patchObject;
    const repairs = describeRepairs(fixedMarkdown ? fixedMarkdown.notes : []);
    const patchProblem = documentPatchProblem(fixedPatch, 'patch');
    if (patchProblem) {
      logBlocked(
        db,
        user.id,
        capability,
        'draft',
        targetId,
        `ai_bad_json 整篇形状不对：${patchProblem}`,
        AI_RANGE_TARGET_TYPES.document,
      );
      throw new HttpError(502, 'ai_bad_json', `模型没有返回合法的整篇改动（${patchProblem}）`);
    }
    const cleanPatch = cleanDocumentPatch(fixedPatch);
    const opId = logOp(db, {
      userId: user.id,
      capability,
      action: 'draft',
      targetType: AI_RANGE_TARGET_TYPES.document,
      targetId,
      status: 'preview',
      reason: instruction.slice(0, 200),
      before,
      after: cleanPatch,
    });
    return ctx.http.ok(reqCtx.res, {
      applied: false,
      opId,
      scope,
      patch: cleanPatch,
      before,
      targetType: AI_RANGE_TARGET_TYPES.document,
      targetId,
      documentId,
      model,
      // 形状纠正做了什么，明说（见 `programs.js`）。
      ...(repairs === '' ? {} : { repairs }),
      writeTo: cleanPatch.template
        ? `/api/docs/${encodeURIComponent(documentId)}/apply-template`
        : `/api/docs/${encodeURIComponent(documentId)}/markdown`,
      hint: cleanPatch.template
        ? `这是预览，没有落盘。模型选的是站内模板「${cleanPatch.template}」：落盘由前端完成 —— POST ${`/api/docs/${encodeURIComponent(documentId)}/apply-template`}（body {"key":"${cleanPatch.template}","mode":"replace"}），再带 confirm: true 调 /api/ai-edit/ops 记一条 applied 审计。`
        : '这是预览，没有落盘。落盘由前端完成：先 PUT /api/docs/:id/markdown 写盘（块数暴跌时 P2 会 409，要带 ?confirm=1），再带 confirm: true 调 /api/ai-edit/ops 记一条 applied 审计。',
    });
  });

  // ── 11. 审查（原「AI 学术审查」的接班人：只出意见，不改稿）──────────────
  //
  // 为什么不塞进 `/ops`：审查的形状不是「before → after」的补丁，而是「一堆带原文
  // 引用的意见」。落盘仍然走既有路径 —— 前端挑一条意见，把它的 `suggestion` 当改写
  // 要求交给 `/draft`（单块）或 `/draft-range`（一节），预览确认后写盘、再带 `confirm`
  // 调 `/ops`。所以这条接口**不写任何东西**，也不会让「审查」变成一条能绕过预览的捷径。
  routes.add('POST', '/api/ai-edit/review', async (reqCtx) => {
    const user = viewer(reqCtx);
    const body = reqCtx.body ?? {};
    const capability = AI_CONTENT_CAPABILITY;
    guardCapability(db, user.id, capability);

    const rawDocumentId = body.documentId;
    const documentId =
      typeof rawDocumentId === 'number' && Number.isInteger(rawDocumentId) && rawDocumentId > 0
        ? String(rawDocumentId)
        : typeof rawDocumentId === 'string'
          ? rawDocumentId.trim()
          : '';
    ensure(documentId !== '', 400, 'bad_request', 'documentId 不能为空 —— 审查要记清楚审的是哪一篇');
    ensure(!documentId.includes(':'), 400, 'bad_request', 'documentId 里不能有冒号');

    const instruction = typeof body.instruction === 'string' ? body.instruction.trim().slice(0, 2000) : '';
    const hasBlocks = Array.isArray(body.blocks) && body.blocks.length > 0;
    let blocks = null;
    let markdown = '';
    if (hasBlocks) {
      const blocksProblem = sectionBlocksProblem(body.blocks, 'blocks');
      ensure(!blocksProblem, 400, 'bad_request', `blocks 不是合法的一节（${blocksProblem}）`);
      blocks = cleanSectionBlocks(body.blocks);
      const sent = JSON.stringify(blocks);
      ensure(sent.length <= AI_MAX_RANGE_CHARS, 400, 'bad_request', `要审的内容太大（${sent.length} 字符，上限 ${AI_MAX_RANGE_CHARS}）—— 分几节审`);
    } else {
      markdown = typeof body.markdown === 'string' ? body.markdown : '';
      ensure(
        markdown.trim() !== '',
        400,
        'bad_request',
        '要审的内容不能为空：给 blocks（按块审，意见能挂到块上）或 markdown（整篇审）',
      );
      ensure(
        markdown.length <= AI_MAX_RANGE_CHARS,
        400,
        'bad_request',
        `要审的正文有 ${markdown.length} 字符，超过 ${AI_MAX_RANGE_CHARS} 的上限`,
      );
    }

    const targetId = composeTargetId(documentId, '*');
    ensure(targetId.length <= AI_MAX_TARGET_ID, 400, 'bad_request', `targetId 太长（上限 ${AI_MAX_TARGET_ID} 个字符）`);
    requireModelConfigured(db, {
      userId: user.id,
      capability,
      action: 'draft',
      targetId,
      targetType: AI_RANGE_TARGET_TYPES.document,
    });
    rateLimit(`ai-edit:review:${user.id}`, 5, 60 * 1000);

    const source = reviewTextOf({ blocks, markdown });
    const { content, model } = await callModel(db, {
      userId: user.id,
      capability,
      action: 'draft',
      targetId,
      targetType: AI_RANGE_TARGET_TYPES.document,
      system: reviewSystemPrompt(),
      userText: `要审查的内容：\n${source}${instruction ? `\n额外要求：${instruction}` : ''}`,
    });
    const parsed = parseModelJson(content, {
      db,
      userId: user.id,
      capability,
      action: 'draft',
      targetId,
      targetType: AI_RANGE_TARGET_TYPES.document,
    });
    const shapeProblem = reviewShapeProblem(parsed);
    if (shapeProblem) {
      logBlocked(
        db,
        user.id,
        capability,
        'draft',
        targetId,
        `ai_bad_json 审查形状不对：${shapeProblem}`,
        AI_RANGE_TARGET_TYPES.document,
      );
      throw new HttpError(502, 'ai_bad_json', `模型没有返回合法的审查结果（${shapeProblem}）`);
    }
    const { value: review, dropped } = reviewFindings({ raw: parsed, source });
    const opId = logOp(db, {
      userId: user.id,
      capability,
      action: 'draft',
      targetType: AI_RANGE_TARGET_TYPES.document,
      targetId,
      status: 'preview',
      reason: instruction ? `审查：${instruction.slice(0, 180)}` : '审查',
      before: null,
      after: review,
    });
    return ctx.http.ok(reqCtx.res, {
      applied: false,
      opId,
      documentId,
      model,
      // 「引用对不上草稿」被丢掉的条数：界面要能说出「少了几条」，不能假装模型只写了这些。
      dropped,
      targetType: AI_RANGE_TARGET_TYPES.document,
      targetId,
      ...review,
      hint: '这只是意见，没有落盘。要采纳某一条：把它的 suggestion 当 instruction 交给 /api/ai-edit/draft（单块）或 /api/ai-edit/draft-range（一节），预览确认后再写盘，最后带 confirm: true 调 /api/ai-edit/ops 记审计。',
    });
  });

  // ── 12. 全站用量 + 预算状态 + 花的钱（仅管理团队）────────────────────────
  //
  // 补的是「配额按用户算、钱按 key 算」留下的那个洞：在这之前，全站今天调了多少次、
  // 谁在用、有没有顶到上限，管理员一概看不见，唯一的全局约束就是账单本身。
  //
  // 口径分两套，故意**分开报**，因为它们回答的是不同的问题：
  //   · 次数（`total` / `billed` / `blocked` / `users` / `byAction` / `topUsers`）
  //     —— 配额闸门用的就是它：`billed` 只数 AI_QUOTA_ACTIONS 里**没失败**的行，
  //     与用户额度、全站预算逐字一致；`total` 是当天的全部日志行（含预览、授权、被挡的）。
  //   · 钱（`tokens` + `cost`）—— 来自 `ai_token_usage`（每次真打到上游的调用一行），
  //     次数当不了成本的代理：一次整篇改写和一次单块草拟都算「1 次」，账单差几十倍。
  //
  // 金额按**每行自己的 `model` 与落库时的 `peak` 档位**算：换模型不会改写历史账单，
  // 半夜打开面板看白天的账也不会跟着变价（理由见 pricing.js 文件头）。
  //
  // 这是**估算**，面板上要说清：单价抄自官方价目表（官方调价后要对齐 pricing.js）；
  // 上游没报 usage 的调用金额按 0 算，单独用 `tokens.missing` 报出来，别让 0 元像免费。
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

    // 用量按 `(peak, model)` 分组取，汇总时每组按自己的档位与模型单价算钱。
    // 分组而不是「拿总 token 乘一个价」：历史账单里可能混着好几个模型、
    // 也可能跨了高峰与空闲两档，混着乘出来的数看着精确，其实每一段都不对。
    const usageOf = (from) => {
      const base = `SELECT peak, model,
                           SUM(prompt_tokens) AS promptTokens,
                           SUM(cached_tokens) AS cachedTokens,
                           SUM(completion_tokens) AS completionTokens,
                           COUNT(*) AS calls,
                           SUM(CASE WHEN prompt_tokens = 0 AND completion_tokens = 0 THEN 1 ELSE 0 END) AS missing
                      FROM ${AI_TOKEN_USAGE_TABLE}`;
      const rows =
        from == null
          ? db.prepare(`${base} GROUP BY peak, model`).all()
          : db.prepare(`${base} WHERE created_at >= ? GROUP BY peak, model`).all(from);
      return summarizeCost(
        rows.map((row) => ({ ...row, peak: Number(row.peak) === 1 })),
        { env: process.env },
      );
    };
    const todayUsage = usageOf(since);
    const allTimeUsage = usageOf(null);
    const counts = (sum) => ({
      prompt: sum.promptTokens,
      cached: sum.cachedTokens,
      completion: sum.completionTokens,
      total: sum.totalTokens,
      calls: sum.calls,
      missing: sum.missing,
    });
    const money = (sum) => ({
      yuan: sum.yuan,
      peakYuan: sum.peakYuan,
      offPeakYuan: sum.offPeakYuan,
      currency: AI_PRICE_CURRENCY,
      unit: AI_PRICE_UNIT,
    });

    const limit = readSiteBudget();
    const peakNow = isPeakHour(at);
    const price = priceFor(process.env.AI_MODEL || 'deepseek-chat', process.env);
    return ctx.http.ok(reqCtx.res, {
      scope: 'site',
      since,
      today: {
        total,
        billed,
        blocked,
        users,
        byAction,
        topUsers,
        tokens: counts(todayUsage),
        cost: money(todayUsage),
      },
      allTime: { total: allTime, tokens: counts(allTimeUsage), cost: money(allTimeUsage) },
      // 面板要把「这份账按什么单价、哪个时段算的」原样写出来（含出处链接）：
      // 金额是估算，来历不明的话管理员没办法判断该不该信它。
      pricing: {
        model: price.model,
        known: price.known,
        label: price.label,
        inputMiss: price.inputMiss,
        inputHit: price.inputHit,
        output: price.output,
        unit: AI_PRICE_UNIT,
        currency: AI_PRICE_CURRENCY,
        offPeakFactor: AI_OFF_PEAK_FACTOR,
        peakNow,
        source: AI_PRICE_SOURCE,
        envKeys: AI_PRICE_ENV_KEYS,
        note: priceNote(price, { peak: peakNow }),
      },
      budget: {
        envKey: AI_BUDGET_ENV,
        unlimited: limit <= 0,
        limit,
        used: billed,
        remaining: limit <= 0 ? null : Math.max(limit - billed, 0),
      },
      note: '次数与 token 用量分开统计：次数是配额闸门的口径，金额 = token × 单价（按调用时刻的高峰/空闲档位估算，单价抄自官方价目表）。',
    });
  });
}
