// AI 能力层（P3）自己**拥有**的两张表，以及能力目录。
//
// 归属：
//   ai_capability_grants —— 能力授权（谁、授予哪项能力、何时、有效期、每日配额、是否已收回）
//   ai_op_logs           —— AI 操作日志（每次能力使用一行，存 before/after，可回滚）
//   ai_token_usage       —— 每次真的打到上游的模型调用一行 token 用量（成本面板的钱）
//   ai_preview_requests  —— 「预览缓存不封顶」的申请与审批（谁申请、谁批的、什么时候）
//
// 不在这里，也不许写进 owns：
//   ai_post_reviews / ai_site_reports —— forum-ai 运行时自建自管，不归任何一个模块登记。
//
// 只读、绝不写：documents / document_blocks（归 P2）、users / posts（归 core）。

/**
 * 能力目录 —— 服务端唯一的授权白名单。
 *
 * **这里只列真的接上了线的能力。** 目录里的每一项都必须有服务端调用点去
 * `requireCapability` / `guardCapability`（见 routes.js），否则它就是个空开关：
 * 授权、配额、「收回」全都点得动，却什么也拦不住 —— 面板上多一行，用户就多一份误解。
 *
 * 2026-10 收尾时删掉了五项从未接线的能力：`read_post` 读指定帖子 / `read_site` 读全站 /
 * `network` 联网 / `site_tools` 调用站内工具 / `publish` 代表用户发布。它们当初是按
 * `docs/01-需求规格说明书.md` 的 FR-CAP-02 抄进来的，但那份规格书**不在这个仓库里**，
 * P3 真正交付的功能面是 AI 编辑台，只有「修改内容」一路。要加回任何一项，请连同它的
 * 服务端调用点一起加；加不了调用点就别加进这份目录。
 *
 * 后来加回来的两项是「左栏那两条转换」搬进宿主时挂上的（调用点在
 * `src/modules/ai/extract.js`，原先是 note-agent 的 `/extract` 与 `/extract-image`）：
 *   · `extract` —— 文档 / PDF → Markdown（**不调模型、不花钱**，所以是低风险）；
 *   · `extract_image` —— 图片 → Markdown（走视觉模型、按 token 计费，所以是中风险；
 *     它同时进了 `AI_QUOTA_ACTIONS`，每日配额与全站预算都算得到它）。
 * 两项**都不是** `AI_HIGH_RISK`：它们不改任何已存在的内容，
 * 输出只会落到用户自己眼前的编辑区里（落盘仍要作者自己按「插入 / 替换」）。
 *
 * **默认全部关闭**：`ai_capability_grants` 里没有对应的有效行 = 没有这项能力。
 * 授权不是前端隐藏按钮，服务端每次调用前都要查这张表（FR-CAP-01 / FR-CAP-03）。
 */
export const AI_CAPABILITIES = Object.freeze([
  { key: 'edit_content', label: '修改内容', risk: 'high' },
  { key: 'extract', label: '文档转换（不花模型）', risk: 'low' },
  { key: 'extract_image', label: '图片识别（走视觉模型）', risk: 'medium' },
]);

export const AI_CAPABILITY_KEYS = Object.freeze(AI_CAPABILITIES.map((item) => item.key));

/** 高风险能力：除了默认关闭，开启时还必须显式 `confirm: true`（FR-CAP-08）。 */
export const AI_HIGH_RISK = Object.freeze(['edit_content']);

/** 审计日志里的动作名。授权/收回也算状态变更，一并留痕。 */
export const AI_ACTIONS = Object.freeze([
  'read',
  'draft',
  'preview',
  'apply',
  'publish',
  'tool',
  // 把文件读成文本交给用户（`src/modules/ai/extract.js` 那两条转换）。它**不改任何内容**，
  // 所以既不是 `draft` 也不是 `apply` —— 日志里一眼能把它与「改稿」分开。
  'extract',
  'grant',
  'revoke',
]);

/**
 * 计入每日配额与全站预算的 action。
 *
 * `preview` **不在**这里：预览只是往本地日志写一行，既没落盘也没有模型调用，
 * 不该花掉「今天还能用几次」的额度 —— 否则用户每多看一眼就少一次真正的调用。
 * 授权 / 收回同样不占额度。
 *
 * `extract` **在**这里，因为它是按 token 计费的一次真调用（图片识别，走视觉模型）；
 * 而同一个能力下「文档 / PDF → Markdown」那条**根本不写 op 日志**（不调模型、不花钱），
 * 所以两条转换天然分开计费，不需要再为「免费的那条」发明一个新 action。
 *
 * 另外 `usedToday` 只数**没失败**的行（`status <> 'blocked'`）：
 * 请求根本没发出去（没配 key）或被上游拒绝时，不该扣用户的额度。
 */
export const AI_QUOTA_ACTIONS = Object.freeze(['read', 'draft', 'apply', 'publish', 'tool', 'extract']);

/** 失败 / 根本没发出去的调用在日志里的状态，不计配额。 */
export const AI_BLOCKED_STATUS = 'blocked';

/**
 * `/api/ai-edit/ops` 只处理**块级内容改动**，所以能力恒为 `edit_content`、
 * 动作由 `confirm` 推导，客户端传什么都不改这两项 ——
 * 否则只要手里有**任何**一项已授权的能力（当时目录里有五项低/中风险能力可授），
 * 把请求体里的 `capability` 填成那一项就能拿它落盘一次内容改写。
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
 * 单块操作的 `targetType` 没有对应的常量了：它由服务端写死成 `document_block`，
 * 客户端根本没有这个字段可填（以前能填 `not_a_real_thing`）。
 */
export const AI_MAX_TARGET_ID = 200;
export const AI_MAX_REASON = 500;

/**
 * 改稿的两种粒度（用户 2026-10 的需求：块太碎了，要么整篇、要么按小标题一节一节来）。
 *
 *   section  —— 一个小节（一个 heading 到下一个 heading 之前）
 *   document —— 整篇
 *
 * `block` 作为 `/ops` 的历史取值仍然接受（旧前端、旧审计行），但不在这份清单里：
 * 这是新草拟接口 `POST /api/ai-edit/draft-range` 认的粒度。
 */
export const AI_SCOPES = Object.freeze(['section', 'document']);

/** 切小节的判据：P2 的哪个块类型算「标题」。抄自 `src/modules/doc/blocks/types.js`。 */
export const AI_SECTION_HEADING_TYPE = 'heading';

/**
 * 一小节最多多少块 —— 抄 P2 `src/modules/doc/blocks/ops.js` 的 `MAX_OPS = 50`。
 *
 * 小节的落盘走的是 `POST /api/docs/:id/ops`，一批最多 50 条 replace，
 * 所以一节超过 50 块就**不可能**一次应用完。与其让用户改完才发现只写进去一半，
 * 不如在 `POST /api/ai-edit/sections` 的清单里就标 `tooLarge`、
 * 在 `draft-range` 上直接 400 说清原因。
 * `scripts/ai-smoke.mjs` 有一节拿 `src/modules/doc/blocks/ops.js` 的源文本比对这两个数。
 */
export const AI_MAX_SECTION_BLOCKS = 50;

/**
 * 一次送进模型的**整篇** Markdown 上限（字符数）。
 *
 * 提示词体积就是账单，整篇改写是这个模块里最贵的动作：超了就是 400 并如实说明
 * （不静默截断 —— 截一半的 Markdown 交给模型重写，回来的东西等于把后半篇删了）。
 */
export const AI_MAX_RANGE_CHARS = 40000;

/** `POST /api/ai-edit/sections` 的输入上限（纯切分，不调模型，所以宽松些）。 */
export const AI_MAX_SECTION_INPUT = 200;

/**
 * range 类操作在审计里的 `target_type`。
 *
 * 与 `document_block` 并列，回滚时前端按 `restore` 的形状分支（块数组 / `{markdown}`），
 * 不靠 targetType 猜 —— 但列表里要能一眼看出这次改的是整篇还是一节。
 */
export const AI_RANGE_TARGET_TYPES = Object.freeze({ section: 'doc_section', document: 'document' });

/** 整篇改写时模型可以顺便改标题：`title` 字段的长度上限。 */
export const AI_MAX_TITLE = 200;

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
  // 第 15 种：P2 把「同一小节里连续的正文」并成一段 `prose` 之后新加的
  // （见 `src/modules/doc/blocks/markdown.js` 的 `mergeProse`）。
  // 模型必须知道它，否则看到一篇正常文章里大段大段的 `prose` 会以为块类型不认识、
  // 自作主张拆回 `paragraph` / `list` —— 那正好把「块太散」这个毛病又改回来。
  { name: 'prose', label: '小节正文' },
  // 第 16 种：折叠块（mkdocs 的 `??? note "标题"` 落成的块）。
  // 它管的是「一大段能收起来的正文」，模型改写时**整块对待**：该收起来的收起来，
  // 别拆成十个小段、也别把里面的列表搬出去。
  { name: 'fold', label: '折叠块' },
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
 * token 用量落库的粒度：**一次真的打到上游的模型调用一行**。
 *
 * 为什么不往 `ai_op_logs` 上加列：`ctx.schema.add` 只有 `CREATE TABLE IF NOT EXISTS`，
 * 没有加列的迁移通道（`src/core/table.js`），而这张表还必须是启动即有的 ——
 * 加列要另造一套迁移，收益却只是少一次 INSERT。所以用量单独一张表，
 * 靠 `user_id` / `action` / `created_at` 与审计行对齐（`op_id` 不存：
 * 草拟的审计行是在模型返回**之后**才写的，这里存不了它的 id）。
 *
 * `peak` 是**调用时刻**所处的档位（北京时间工作日高峰 / 空闲），落库时定死：
 * 计费看的是调用那一刻，不是管理员半夜打开面板的那一刻（详见 pricing.js）。
 */
export const AI_TOKEN_USAGE_TABLE = 'ai_token_usage';

/**
 * 建表 SQL。
 *
 * 顶层分号会被 `src/core/table.js` 的切分器拆成一条条语句：
 * 三条 `CREATE TABLE IF NOT EXISTS` 进表名册（就是 `owns` 里的那三个名字），
 * `CREATE INDEX` 照常执行但不进名册。
 *
 * `user_id` 引用 `users(id)`：`src/server.js` 先 import `./store.js`（登记 14 张 core 表）
 * 再 import `./modules/index.js`（登记这三张），所以外键目标那时已经存在。
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

CREATE TABLE IF NOT EXISTS ai_token_usage (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER NOT NULL REFERENCES users(id),
  action            TEXT    NOT NULL DEFAULT '',
  model             TEXT    NOT NULL DEFAULT '',
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  cached_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  peak              INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_token_usage_created ON ai_token_usage (created_at);
CREATE INDEX IF NOT EXISTS idx_ai_token_usage_user ON ai_token_usage (user_id, created_at);

CREATE TABLE IF NOT EXISTS ai_preview_requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  status       TEXT    NOT NULL DEFAULT 'pending',
  reason       TEXT    NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  decided_at   INTEGER,
  decided_by   INTEGER,
  decided_note TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_ai_preview_requests_user ON ai_preview_requests (user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_ai_preview_requests_status ON ai_preview_requests (status, id DESC);
`;
