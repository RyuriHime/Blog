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

/**
 * 计入每日配额的 action。
 *
 * `preview` **不在**这里：预览只是往本地日志写一行，既没落盘也没有模型调用，
 * 不该花掉「今天还能用几次」的额度 —— 否则用户每多看一眼就少一次真正的调用。
 * 授权 / 收回同样不占额度。
 *
 * 另外 `usedToday` 只数**没失败**的行（`status <> 'blocked'`）：
 * 请求根本没发出去（没配 key）或被上游拒绝时，不该扣用户的额度。
 */
export const AI_QUOTA_ACTIONS = Object.freeze(['read', 'draft', 'apply', 'publish', 'tool']);

/** 失败 / 根本没发出去的调用在日志里的状态，不计配额。 */
export const AI_BLOCKED_STATUS = 'blocked';

/**
 * `/api/ai-edit/ops` 只处理**块级内容改动**，所以能力恒为 `edit_content`、
 * 动作由 `confirm` 推导，客户端传什么都不改这两项 ——
 * 否则只授权了低风险 `read_post` 的人就能拿它落盘一次内容改写。
 */
export const AI_CONTENT_CAPABILITY = 'edit_content';

/**
 * 单个块的字符上限。提示词体积直接等于账单：一个 12 万字的块能撑出 352KB 的请求体，
 * 必然超出任何模型上下文，钱照付（见 routes.js 的 /draft）。
 */
export const AI_MAX_BLOCK_CHARS = 20000;

/**
 * 审计目标字段的长度上限，免得日志被任意长字符串灌满。
 *
 * `targetType` 没有对应的常量了：它现在由服务端写死成 `document_block`，
 * 客户端根本没有这个字段可填（以前能填 `not_a_real_thing`）。
 */
export const AI_MAX_TARGET_ID = 200;
export const AI_MAX_REASON = 500;

/**
 * P2（积木帖子的作者）内置的块类型 —— 就是 `document_blocks.type` 的合法取值。
 *
 * 这里是**抄的一份**（出处 `src/modules/doc/blocks/types.js`）：骨架规范禁止 import
 * 隔壁模块的文件，所以只能复制。复制会有漂移的风险，`scripts/ai-smoke.mjs` 第 19 节
 * 拿 `GET /api/docs/meta/block-types` 跟这份逐项比对，P2 加了新类型就会红。
 *
 * 块的数据形状也是 P2 定的：`{ type: '<上面某个名字>', props: {…} }`。
 * 我的审计日志里 `before_json` / `after_json` 存的就是这个形状，一个字都不翻译 ——
 * 以前我用的是自造的 `{ blockType, content }`，模型照着发明了 `vote` 这种不存在的
 * 类型，落盘时必然对不上。
 */
export const AI_BLOCK_TYPES = Object.freeze([
  { name: 'heading', label: '标题' },
  { name: 'paragraph', label: '正文' },
  { name: 'list', label: '列表' },
  { name: 'code', label: '代码' },
  { name: 'table', label: '表格' },
  { name: 'formula', label: '公式' },
  { name: 'image', label: '图片' },
  { name: 'quote', label: '引用' },
  { name: 'poll', label: '投票' },
  { name: 'wiki', label: '双链' },
  { name: 'embed', label: '嵌入' },
  { name: 'app', label: '小应用' },
  // 第 13、14 种是 P2 在 v2 合进 main 之后补的（脚本块 / 挂载子页），
  // 漂移哨兵（`scripts/ai-smoke.mjs` 第 19 节）就是为这一刻准备的：
  // 少了这两项，「当前块是脚本块、让 AI 改一下」会被提示词误导成别的类型再写回去。
  { name: 'script', label: '脚本' },
  { name: 'subpage', label: '子页' },
]);

export const AI_BLOCK_TYPE_NAMES = Object.freeze(AI_BLOCK_TYPES.map((item) => item.name));

/**
 * 全站每日 AI 调用总上限的环境变量名。
 *
 * 单用户配额管不住**总额**：钱是按 key 算的，配额是按用户算的 ——
 * 20 个人各用满 50 次/天，同一张账单上就是 1000 次，而这中间没有任何闸门，
 * 管理员也看不到全站今天用了多少（FR-CAP-07「配额兼作成本控制」只到了个人一级）。
 * 这个上限是**兜底**：0 或不配 = 不限（保持既有行为，不影响验收）。
 */
export const AI_BUDGET_ENV = 'AI_DAILY_TOTAL_LIMIT';

/** 管理员用量面板里「谁用得最多」的条数。 */
export const AI_USAGE_TOP_USERS = 10;

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
