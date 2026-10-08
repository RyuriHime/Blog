// 用量面板的另外几本账：论坛 AI（forum-ai）与笔记（note-agent）。
//
// ── 为什么需要这个文件 ──
// 面板原来只读 `ai_token_usage`，而那张表**只有 AI 编辑台会写**（`src/modules/ai/routes.js`
// 的 `callModel` 里那一处）。可站点的 AI 不止这一路，另外两路把账记在自己的表里：
//   · forum-ai   → `ai_document_reviews`（逐篇解读，**按 document_id upsert**）、
//                  `ai_corpus_reports`（每次「整理全站」一行，`created_by` 记了发起人）；
//   · note-agent → `notes_usage`（按用户/会话累计）。
// 三个包共用宿主同一个 SQLite 文件（`src/server.js:68` / `:71` 把同一个 db 交给两个挂载层），
// 所以这里**直接读**那三张表 —— 不改那两个自包含包的写入路径，历史数据也就自动补回来了。
//
// ── 三条已知的不精确（面板上必须如实写出来） ──
//   1. `ai_document_reviews` 是 upsert：同一篇被重新解读只留最后一次的 token，
//      之前那几次的 token 在上游是真花掉了，但行已被覆盖 —— 历史偏低、补不回来；
//   2. `ai_corpus_reports` 一行是一次整理里**多次调用之和**，档位只能按这一行自己的
//      `created_at` 判一次（跨了高峰/空闲边界的整理会偏一点）；
//   3. 这两张表（以及 `notes_usage`）都**没有缓存命中数**，输入只能整段按未命中价算（偏高）。
//
// 还有一条归属上的事实：`ai_document_reviews` **没有「谁触发的」这一列**，所以逐篇解读
// 只进全站合计，不进「我的用量」；全站整理（`created_by`）与笔记（`user_id`）能按人归属。

import { isPeakHour } from './pricing.js';

/** 面板上的来源清单：标签、说明、已知的不精确。前端原样渲染，不在前端编文案。 */
export const AI_USAGE_SOURCES = Object.freeze([
  Object.freeze({
    key: 'ai_edit',
    label: 'AI 编辑台',
    detail: '每次调用一行，带模型与高峰/空闲档位 —— 这份账最准。',
    perUser: true,
    caveat: '',
  }),
  Object.freeze({
    key: 'forum_review',
    label: '论坛 AI · 逐篇解读',
    detail: '取自论坛 AI 自己的解读记录（每篇最新一次）。',
    perUser: false,
    caveat: '同一篇重复解读只留最后一次的用量，更早几次已在上游花掉、补不回来；也没记是谁触发的，只进全站合计。',
  }),
  Object.freeze({
    key: 'forum_corpus',
    label: '论坛 AI · 整理全站',
    detail: '取自论坛 AI 每次「整理全站」留下的报告。',
    perUser: true,
    caveat: '一次整理是多轮调用之和，只能按这次整理的时刻判一次高峰/空闲（跨边界会偏）。',
  }),
  Object.freeze({
    key: 'notes',
    label: '笔记',
    detail: '取自笔记子系统按用户累计的用量。',
    perUser: true,
    caveat: '没有缓存命中数，输入整段按未命中价算（偏高）。',
  }),
]);

/** 面板上的来源 key（顺序与 `AI_USAGE_SOURCES` 一致）。 */
export const AI_USAGE_SOURCE_KEYS = Object.freeze(AI_USAGE_SOURCES.map((item) => item.key));

const FORUM_REVIEWS = 'ai_document_reviews';
const FORUM_REPORTS = 'ai_corpus_reports';
const NOTES_USAGE = 'notes_usage';

function num(value) {
  const parsed = Math.round(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * 表在不在。
 *
 * 为什么要探：这三张表由**别的包**在各自建表时创建（forum-ai / note-agent 没装时不存在的）。
 * 面板不能因为「note-agent 没配」就 500 —— 缺表当 0 算，这块面板本来就是个汇总视图。
 */
function hasTable(db, name) {
  try {
    return Boolean(
      db.prepare("SELECT 1 AS yes FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
    );
  } catch {
    return false;
  }
}

/** 表存在就查；查询本身出错（老库缺列）也当空 —— 面板不该被别的包的表结构拖垮。 */
function queryAll(db, sql, args) {
  try {
    return db.prepare(sql).all(...args);
  } catch {
    return [];
  }
}

/**
 * 外来用量行（`ai_token_usage` 以外那几本账），一行一次「记账的调用」。
 *
 * `userId` 给了就只取**能归属到这个人的**那些（整理全站的 `created_by`、笔记的 `user_id`）；
 * 逐篇解读没有触发者这一列，只有 `userId == null`（全站口径）时才收进来。
 *
 * 时间用各表自己的「记账时刻」：解读用 `updated_at`（upsert 改的就是它）、
 * 整理用 `created_at`。缓存命中数一律 0（表里没有这个字段，见文件头第 3 条）。
 */
export function foreignUsageRows(db, { userId = null } = {}) {
  const rows = [];

  // ① 论坛 AI·逐篇解读：没有触发者，只进全站。
  if (userId == null && hasTable(db, FORUM_REVIEWS)) {
    const list = queryAll(
      db,
      `SELECT model, prompt_tokens, completion_tokens, updated_at FROM ${FORUM_REVIEWS}`,
      [],
    );
    for (const row of list) {
      rows.push({
        source: 'forum_review',
        at: Number(row.updated_at) || 0,
        model: row.model,
        promptTokens: num(row.prompt_tokens),
        cachedTokens: 0,
        completionTokens: num(row.completion_tokens),
        calls: 1,
      });
    }
  }

  // ② 论坛 AI·整理全站：`created_by` 是发起人的用户号，能按人归属。
  if (hasTable(db, FORUM_REPORTS)) {
    const where = [];
    const args = [];
    if (userId != null) {
      // 列是 TEXT，而写入的是 JS 数字（forum-ai/src/routes.mjs:410）—— 比较前统一成文本。
      where.push('CAST(created_by AS TEXT) = ?');
      args.push(String(userId));
    }
    const list = queryAll(
      db,
      `SELECT model, prompt_tokens, completion_tokens, created_at
         FROM ${FORUM_REPORTS}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`,
      args,
    );
    for (const row of list) {
      rows.push({
        source: 'forum_corpus',
        at: Number(row.created_at) || 0,
        model: row.model,
        promptTokens: num(row.prompt_tokens),
        cachedTokens: 0,
        completionTokens: num(row.completion_tokens),
        calls: 1,
      });
    }
  }

  // ③ 笔记：`user_id` + `calls`（一行可能记了好几次调用）。
  if (hasTable(db, NOTES_USAGE)) {
    const where = [];
    const args = [];
    if (userId != null) {
      where.push('user_id = ?');
      args.push(userId);
    }
    const list = queryAll(
      db,
      `SELECT model, prompt, completion, calls, created_at
         FROM ${NOTES_USAGE}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`,
      args,
    );
    for (const row of list) {
      rows.push({
        source: 'notes',
        at: Number(row.created_at) || 0,
        model: row.model,
        promptTokens: num(row.prompt),
        cachedTokens: 0,
        completionTokens: num(row.completion),
        calls: Math.max(1, Math.round(Number(row.calls) || 1)),
      });
    }
  }

  return rows;
}

/**
 * 外来用量行 → `(peak, model)` 分组，**形状与 `ai_token_usage` 的 `GROUP BY peak, model` 一致**，
 * 好直接和 AI 编辑台那几组拼在一起喂 `summarizeCost`（钱按每组自己的档位与模型算）。
 *
 * `peak` 用这一行自己的记账时刻判（`isPeakHour`），不是看面板打开的时刻 —— 与
 * `ai_token_usage.peak` 同一个道理（见 pricing.js 文件头）。
 */
export function groupByPeakModel(rows = []) {
  const groups = new Map();
  for (const row of rows) {
    const promptTokens = num(row?.promptTokens);
    const completionTokens = num(row?.completionTokens);
    const calls = Math.max(1, Math.round(Number(row?.calls) || 1));
    const peak = isPeakHour(Number(row?.at) || 0);
    const model = String(row?.model ?? '');
    const key = `${peak ? 1 : 0}|${model}`;
    const group =
      groups.get(key) ??
      { peak, model, promptTokens: 0, cachedTokens: 0, completionTokens: 0, calls: 0, missing: 0 };
    group.promptTokens += promptTokens;
    group.cachedTokens += num(row?.cachedTokens);
    group.completionTokens += completionTokens;
    group.calls += calls;
    // 只记了次数、没记 token 的行（上游没报 usage）：单独报出来，别让 0 元像免费。
    if (promptTokens === 0 && completionTokens === 0) group.missing += calls;
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** 按来源把外来用量行列一下（面板要能说「这笔钱是哪一路花的」）。 */
export function rowsBySource(rows = []) {
  const map = new Map();
  for (const row of rows) {
    const key = String(row?.source ?? '');
    const list = map.get(key);
    if (list) list.push(row);
    else map.set(key, [row]);
  }
  return map;
}
