// 可编程帖子（P2）的数据表。
//
// 六张表全是新增的，v1 的表一张都不动 —— 迁移是纯加法（同 feed 的做法）。
//
// 建表顺序 = 别的模块 import 这个文件时登记的顺序；
// `addScript` 会按「括号深度为 0 的分号」切开逐条登记，
// 索引语句照旧执行但不进表名册（否则索引名会被当成表名，归属检查会误报）。
//
// ⚠️ 这段 SQL 里**不许出现分号**（除了每条语句结尾那一个）：
// addScript 是按分号切分语句的，注释或默认值里夹一个分号会把一条建表语句拦腰切断。

/**
 * 文档的三种形态。**冻结枚举**：`documents.kind` 上的 CHECK 钉死了它。
 *
 *   post    积木帖子  —— 公开的可编程正文，会往 posts 里放一条互动锚点
 *   note    笔记      —— 笔记广场里的那一份，由 notes 子系统接线而来
 *   profile 个人主页  —— 一个用户一份（不是新建一张表，而是 documents 的一种 kind）
 */
export const DOC_KINDS = ['post', 'note', 'profile'];

/**
 * 可见范围。**必须与 `src/modules/feed/schema.js` 的 FEED_SCOPES 逐字相同** ——
 * 这是跨模块契约（P3 要按同一套值决定「这段正文能不能喂给 AI」），
 * 由 scripts/doc-smoke.mjs 的契约对拍测试守住。
 */
export const DOC_SCOPES = ['public', 'followers', 'team', 'private'];

/** 标题长度上限。 */
export const MAX_DOC_TITLE = 120;

/** 一篇文档最多多少块（防止一次导入把库撑爆）。 */
export const MAX_DOC_BLOCKS = 500;

/** 单块 props 序列化后的字节上限（块是声明式的，正文不该塞进 props）。 */
export const MAX_BLOCK_PROPS_BYTES = 32 * 1024;

/**
 * 正文（blocks_json）的字节上限。
 * 与 posts.content 的 20000 同一个量级：文档是「一块正文」，不是文件柜。
 */
export const MAX_DOC_BODY_BYTES = 256 * 1024;

/** 每篇文档保留多少条修订（FR-TPL-02 的「修订记录」+ FR-EDIT-08 的撤销/重做）。 */
export const MAX_DOC_REVISIONS = 50;

/** 块类型名的形状：小写字母开头，允许小写字母 / 数字 / 下划线，最长 32。 */
export const BLOCK_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

/** 块 id 的形状：`b` + 数字。全站前端（含 note-agent）都按这个认块。 */
export const BLOCK_ID_PATTERN = /^b\d+$/;

/**
 * 沙箱代码（`app` 块的 `props.code`）的长度上限。
 * 超了**在保存时**就 `bad_request`，不等到渲染 —— 一份超长正文不该先落库再变成 500。
 * 20000 是「一个真写得成功能的小应用」的量级：几百行 JS + 一点 HTML / CSS。
 */
export const MAX_APP_CODE = 20000;

/**
 * 沙箱块自己能存的 JSON 状态上限（`Sandbox.state.set` 一次写的字节数）。
 * 它是**用户内容**，不是缓存：状态表与文档同生共死（删块 / 删文档一起清）。
 */
export const MAX_APP_STATE = 32768;

/** `Sandbox.state` 的两种作用域。 */
export const APP_STATE_SCOPES = ['user', 'shared'];

/**
 * 沙箱里的代码能向宿主申请的**能力白名单**。
 *
 * 一个沙箱是不透明源：它读不到 DOM、cookie、localStorage，也发不出网络请求，
 * 所以「能干什么」完全由这张表决定。加名字 = 开窗，每个都得能审计（`doc_capability_logs`）。
 *   `doc-meta`   这篇文档的公开元信息（标题 / 作者 / 更新时间）
 *   `doc-blocks` 正文里其它块的 `{id, type, props}` —— 于是「按别的块算点东西」写得出来
 *   `viewer`     正在看的人（登录与否 / 用户名 / 是不是管理员）
 *   `state`      读写**自己的**持久状态（`Sandbox.state`）—— 没有它，代码算完就没了
 */
export const SANDBOX_CAPABILITIES = ['doc-meta', 'doc-blocks', 'viewer', 'state'];

/**
 * 沙箱 → 宿主可以发的消息类型白名单（§6.2）。其余一律丢弃并计数。
 * `ready` 握手 / `resize` 自适应高度 / `value` 把结果交回宿主（联动）/ `request` 申请能力。
 */
export const SANDBOX_MESSAGES = ['ready', 'resize', 'value', 'request'];

/** 沙箱 iframe 的 `sandbox` 属性：只给脚本，**不给** allow-same-origin（不透明源），其余一个都不给。 */
export const SANDBOX_IFRAME_ATTRS = 'sandbox="allow-scripts" loading="lazy" referrerpolicy="no-referrer"';

/** 沙箱文档自己的 CSP：发不出网络请求、加载不了外部脚本与图片（数据出不去）。 */
export const SANDBOX_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'";

/** watchdog：iframe 必须在这个时限内发出 `ready`，否则降级成占位。 */
export const SANDBOX_READY_MS = 2000;

/** 沙箱 → 宿主消息的频率上限（每秒）。超了停止响应并降级，防死循环把浏览器卡死。 */
export const SANDBOX_MESSAGES_PER_SECOND = 200;

/**
 * 互动锚点挂靠的系统板块的 slug。
 *
 * 这个板块**惰性创建**（第一次真的建文档时才 `INSERT OR IGNORE`）：
 * 锚点行 `deleted = 0`，所以一定会被帖子列表看见；启动时就建的话
 * `/api/site` 返回的板块表会当场多一项（check-golden 的 96 条对外行为断言守着那里）。
 */
export const DOC_BOARD_SLUG = 'documents';

/** 系统板块的展示名与图标（它不出现在任何导航里，只是为了让管理后台不显示一行空白）。 */
export const DOC_BOARD_NAME = '积木';
export const DOC_BOARD_ICON = '🧩';
export const DOC_BOARD_DESCRIPTION = '可编程帖子、笔记与个人主页的互动锚点';
export const DOC_BOARD_SORT = 999;

export const DOC_SCHEMA = `
-- 文档：一块可编程正文（积木帖子 / 笔记 / 个人主页共用这一张表）
CREATE TABLE IF NOT EXISTS documents (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER NOT NULL REFERENCES users(id),
  kind             TEXT    NOT NULL DEFAULT 'post' CHECK (kind IN ('post','note','profile')),
  title            TEXT    NOT NULL DEFAULT '',
  scope            TEXT    NOT NULL DEFAULT 'public' CHECK (scope IN ('public','followers','team','private')),
  -- 建这篇文档时用的模板名（空串 = 空白文档）。只作展示与「从模板重建」，不参与渲染。
  template         TEXT    NOT NULL DEFAULT '',
  -- 互动锚点：posts 里那条「影子行」的 id。见 src/modules/doc/anchor.js 的长注释。
  anchor_post_id   INTEGER,
  -- 作者手动关掉这篇文档里的沙箱块（FR-SANDBOX-05 的逃生开关）。
  sandbox_disabled INTEGER NOT NULL DEFAULT 0,
  deleted          INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_user ON documents (user_id, kind, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_list ON documents (kind, deleted, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_anchor ON documents (anchor_post_id);

-- 块：一篇文档的有序积木。
-- position 用 REAL 是**故意的**：插到 3 和 4 之间写 3.5，不必把后面所有块 +1（验收标准 ②）。
CREATE TABLE IF NOT EXISTS document_blocks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id  INTEGER NOT NULL REFERENCES documents(id),
  -- 文档内的块 id：b1 / b2 / b3……块间联动（bind.from）按它引用，所以文档内唯一。
  block_id     TEXT    NOT NULL,
  -- 块类型名。**单独一列**而不是塞进 props：要按类型统计、要按类型查未注册的块（坑 #4）。
  type         TEXT    NOT NULL,
  -- 写这个块时用的类型版本，用来判断要不要迁移（FR-BLOCK-06）。
  type_version INTEGER NOT NULL DEFAULT 1,
  position     REAL    NOT NULL,
  props_json   TEXT    NOT NULL DEFAULT '{}',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE (document_id, block_id)
);
CREATE INDEX IF NOT EXISTS idx_document_blocks_order ON document_blocks (document_id, position);

-- 修订：每保存一次留一条完整快照。
-- 买三件事：模板的「修订记录」（FR-TPL-02）、撤销/重做（FR-EDIT-08）、回滚。
-- 存整份 blocks_json 而不是 diff：一篇文档最多 500 块、256 KB，
-- 存快照比维护一套 diff 正确得多（diff 撞上块重排/类型迁移时会算错）。
CREATE TABLE IF NOT EXISTS document_revisions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES documents(id),
  revision    INTEGER NOT NULL,
  blocks_json TEXT    NOT NULL DEFAULT '[]',
  reason      TEXT    NOT NULL DEFAULT 'edit' CHECK (reason IN ('create','edit','ops','template','import','rollback')),
  author_id   INTEGER NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  UNIQUE (document_id, revision)
);
CREATE INDEX IF NOT EXISTS idx_document_revisions_doc ON document_revisions (document_id, revision DESC);

-- 块类型注册表：FR-BLOCK-04「不改核心代码就能注册新块类型」的唯一诚实实现。
-- 内置的 12 种**不写进这张表**（它们跟着代码走）；这里只存用户注册的。
CREATE TABLE IF NOT EXISTS doc_block_types (
  name              TEXT    PRIMARY KEY,
  version           INTEGER NOT NULL DEFAULT 1,
  label             TEXT    NOT NULL DEFAULT '',
  icon              TEXT    NOT NULL DEFAULT '',
  -- 声明式的 props 形状（类型 / 必填 / 默认值 / 上限），渲染前用它校验。
  props_schema_json TEXT    NOT NULL DEFAULT '{}',
  -- declarative = 数据驱动（只有声明，没有代码）；sandbox = 一段在沙箱里跑的渲染函数。
  renderer_kind     TEXT    NOT NULL DEFAULT 'declarative' CHECK (renderer_kind IN ('declarative','sandbox')),
  renderer_json     TEXT    NOT NULL DEFAULT '{}',
  -- 谁注册的。全局注册表要能记名、能撤（fr-block-04 的待确认 #4）。
  created_by        INTEGER REFERENCES users(id),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

-- 沙箱能力调用的审计（§6.3）：块 id、文档 id、能力名、谁、允许与否、什么时候。
-- 这张表是**追加型**的（只写不读回业务），所以没有 updated_at；
-- 保留策略：doc-smoke 会断言它真的落了行，管理后台后续按 document_id 查。
CREATE TABLE IF NOT EXISTS doc_capability_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES documents(id),
  block_id    TEXT    NOT NULL DEFAULT '',
  capability  TEXT    NOT NULL,
  user_id     INTEGER REFERENCES users(id),
  allowed     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_doc_capability_logs_doc ON doc_capability_logs (document_id, created_at DESC);

-- 文件笔记 → 文档的对照表（§8.1「读取时按需惰性建块」的落点）。
-- 笔记的正文本来住在文件系统 data/notes/<用户>/<name>.md 里，本轮**不搬**；
-- 这张表只记住「这篇笔记已经惰性导入成哪一篇文档」，于是第二次读就直接读库。
-- 为什么不加一列到 documents 上：documents 早就建好了，CREATE TABLE IF NOT EXISTS
-- 对已存在的表是空操作（见 src/core/open-db-support.js 的 ensureColumn，那条路只覆盖 core 的表），
-- 而**新表**在每次开库时都会补建，是纯加法，老库也能长出来。
CREATE TABLE IF NOT EXISTS note_documents (
  user_id     INTEGER NOT NULL REFERENCES users(id),
  -- 笔记的 slug（note-studio 的 store.paths(name).name），同一用户下唯一。
  note_name   TEXT    NOT NULL,
  document_id INTEGER NOT NULL REFERENCES documents(id),
  created_at  INTEGER NOT NULL,
  UNIQUE (user_id, note_name)
);
CREATE INDEX IF NOT EXISTS idx_note_documents_doc ON note_documents (document_id);

-- 投票块的票（§5.2「投票块要真的能投」）。
-- 为什么单独一张表而不是写回块的 props：props 是**文档内容**，改一次就产生一条修订；
-- 票是**访客的行为**，跟内容不是一回事。写进 props 还会让「作者改选项」= 「改所有人的票」。
-- 主键 (document_id, block_id, option_id, user_id) 直接保证「同一个选项只能投一次」，
-- 单选时 store 先删掉本块本用户的其它票再插 —— 不需要额外约束。
-- 选项被作者删掉后，那张旧票由 store.prunePollVotes 清掉（不留下投给不存在选项的票）。
CREATE TABLE IF NOT EXISTS doc_poll_votes (
  document_id INTEGER NOT NULL REFERENCES documents(id),
  block_id    TEXT    NOT NULL,
  option_id   TEXT    NOT NULL,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (document_id, block_id, option_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_doc_poll_votes_block ON doc_poll_votes (document_id, block_id);

-- Wiki 页面的**分类与排序**（§7.3「wiki 是带边栏的多页面」）。
-- 页面清单本身可以从 documents 表（template='page'）推出来，不用存；
-- 这里只补两样库推不出来的东西：它属于哪个分类、在分类里排第几。
-- 与 note_documents 同一个理由（见上面那段注释）：老库里 documents 已经存在，
-- 加列是空操作，而新表每次开库都会补建，是纯加法。
CREATE TABLE IF NOT EXISTS doc_wiki_pages (
  document_id INTEGER PRIMARY KEY REFERENCES documents(id),
  category    TEXT    NOT NULL DEFAULT '',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_doc_wiki_pages_category ON doc_wiki_pages (category, sort_order);

-- 沙箱块自己的持久状态（Sandbox.state）—— 让「代码算出来的东西」能活过刷新。
-- 为什么单独一张表：状态是**运行期数据**，不是文档内容。写进 props 等于每次交互
-- 都产生一条修订、还把所有访客的写入互相覆盖。
-- scope='shared' 时 user_id 恒为 0（全站共用一份，能被任何人写，所以默认不启用）；
-- scope='user' 时按 (block, user) 各存一份 —— 「我的待办」这类应用靠它。
-- 删块 / 删文档时由 store 一并清掉，不留孤儿行。
CREATE TABLE IF NOT EXISTS doc_app_state (
  document_id INTEGER NOT NULL REFERENCES documents(id),
  block_id    TEXT    NOT NULL,
  scope       TEXT    NOT NULL DEFAULT 'user' CHECK (scope IN ('user','shared')),
  user_id     INTEGER NOT NULL DEFAULT 0,
  value       TEXT    NOT NULL DEFAULT '',
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (document_id, block_id, scope, user_id)
);
CREATE INDEX IF NOT EXISTS idx_doc_app_state_doc ON doc_app_state (document_id, block_id);
`;
