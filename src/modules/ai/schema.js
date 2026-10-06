// AI 能力层（P3）自己**拥有**的两张表，以及六项能力的目录。
//
// 归属：
//   ai_capability_grants —— 能力授权（谁、授予哪项能力、何时、有效期、每日配额、是否已收回）
//   ai_op_logs           —— AI 操作日志（每次能力使用一行，存 before/after，可回滚）
//
// 不在这里，也不许写进 owns：
//   ai_post_reviews / ai_site_reports —— forum-ai 运行时自建自管，不归任何一个模块登记。
//
// 只读、绝不写：documents / document_blocks（归 P2）、users / posts（归 core）。

/**
 * 六项能力（出处 docs/01-需求规格说明书.md FR-CAP-02）。
 *
 * **默认全部关闭**：`ai_capability_grants` 里没有对应的有效行 = 没有这项能力。
 * 授权不是前端隐藏按钮，服务端每次调用前都要查这张表（FR-CAP-01 / FR-CAP-03）。
 */
export const AI_CAPABILITIES = Object.freeze([
  { key: 'read_post', label: '读指定帖子', risk: 'low' },
  { key: 'read_site', label: '读全站', risk: 'medium' },
  { key: 'network', label: '联网', risk: 'medium' },
  { key: 'edit_content', label: '修改内容', risk: 'high' },
  { key: 'site_tools', label: '调用站内工具', risk: 'medium' },
  { key: 'publish', label: '代表用户发布', risk: 'high' },
]);

export const AI_CAPABILITY_KEYS = Object.freeze(AI_CAPABILITIES.map((item) => item.key));

/** 高风险能力：除了默认关闭，开启时还必须显式 `confirm: true`（FR-CAP-08）。 */
export const AI_HIGH_RISK = Object.freeze(['edit_content', 'publish']);

/** 审计日志里的动作名。授权/收回也算状态变更，一并留痕。 */
export const AI_ACTIONS = Object.freeze(['read', 'draft', 'preview', 'apply', 'publish', 'tool', 'grant', 'revoke']);

/** 计入每日配额的 action（授权/收回本身不占额度）。 */
export const AI_QUOTA_ACTIONS = Object.freeze(['read', 'draft', 'preview', 'apply', 'publish', 'tool']);

/**
 * 建表 SQL。
 *
 * 顶层分号会被 `src/core/table.js` 的切分器拆成一条条语句：
 * 两条 `CREATE TABLE IF NOT EXISTS` 进表名册（就是 `owns` 里的那两个名字），
 * `CREATE INDEX` 照常执行但不进名册。
 *
 * `user_id` 引用 `users(id)`：`src/server.js` 先 import `./store.js`（登记 17 张 core 表）
 * 再 import `./modules/index.js`（登记这两张），所以外键目标那时已经存在。
 */
export const AI_SCHEMA = `
CREATE TABLE IF NOT EXISTS ai_capability_grants (
  user_id     INTEGER NOT NULL REFERENCES users(id),
  capability  TEXT    NOT NULL,
  granted_at  INTEGER NOT NULL,
  expires_at  INTEGER,
  daily_quota INTEGER NOT NULL DEFAULT 0,
  revoked_at  INTEGER,
  PRIMARY KEY (user_id, capability)
);

CREATE TABLE IF NOT EXISTS ai_op_logs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id),
  capability     TEXT    NOT NULL,
  action         TEXT    NOT NULL,
  target_type    TEXT    NOT NULL DEFAULT '',
  target_id      TEXT    NOT NULL DEFAULT '',
  status         TEXT    NOT NULL DEFAULT 'applied',
  reason         TEXT    NOT NULL DEFAULT '',
  before_json    TEXT,
  after_json     TEXT,
  created_at     INTEGER NOT NULL,
  rolled_back_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ai_capability_grants_user ON ai_capability_grants (user_id, revoked_at);
CREATE INDEX IF NOT EXISTS idx_ai_op_logs_user ON ai_op_logs (user_id, id DESC);
`;
