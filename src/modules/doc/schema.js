// 可编程帖子（P2）的数据表。
//
// 十四张表全是新增的，v1 的表一张都不动 —— 迁移是纯加法（同 feed 的做法）。
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

/**
 * 标签的上限（`doc_tags`，第四轮新增）。
 *
 * 上限照着两个邻居取：forum-ai 的 `asStringArray(parsed.tags, 6, 24)`（6 个 × 24 字）
 * 与 note-agent 的「标签最多 5 个」。这里取更紧的那一对 —— 标签是给人扫的，
 * 一排 6 个以上就没人看了。
 */
export const MAX_DOC_TAGS = 5;
export const MAX_TAG_TEXT = 24;

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
 * 派生块的 id 形状（脚本自己起的名字，如 `s1` / `chart-main`）。
 *
 * 与 `BLOCK_ID_PATTERN` 是**两个命名空间**：派生层的 id 永远不会与真块的 `b\d+` 撞车，
 * 因为脚本产出的东西压根不写进 `document_blocks`。
 */
export const DERIVED_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

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

/** `Sandbox.state` 的两种作用域（`doc_app_state` 上的 CHECK 钉死了这两个）。 */
export const APP_STATE_SCOPES = ['user', 'shared'];

/**
 * 帖子级脚本（第 13 种内置块类型 `script`）的代码长度上限。
 * 与 `MAX_APP_CODE` 同一个量级：脚本是一段真写得成一个应用的程序。
 */
export const MAX_SCRIPT_CODE = 20000;

/**
 * 每个用户最多能存多少条**脚本模板**（`doc_script_templates`，「开发者功能」里的个人零件库）。
 * 上限不是防攻击，是防自己：模板列表要在一屏里能读完。
 */
export const MAX_SCRIPT_TEMPLATES = 50;

/** 模板名的长度上限（按字符数算，和标题一样）。 */
export const MAX_SCRIPT_TEMPLATE_NAME = 40;

/** 模板说明的长度上限。 */
export const MAX_SCRIPT_TEMPLATE_DESC = 200;

/**
 * 派生层（脚本产出）的配额。超限**不是错误**，是把超出部分丢掉并附一条警告 ——
 * 脚本写飞了不该让整篇帖子打不开。
 */
export const MAX_DERIVED_BLOCKS = 100;
export const MAX_DERIVED_PROPS_BYTES = 8 * 1024;
export const MAX_DERIVED_TOTAL_BYTES = 64 * 1024;

/**
 * 派生块的两种作用域。
 *   user   每个访问者一份（「我的待办」这类）
 *   shared 全站共享一份（user_id 恒为 0，站点公告这类）
 */
export const DERIVED_SCOPES = ['user', 'shared'];

/** 帖子页的两种呈现方式：`inline` 正常流里的一枚小标；`fullpage` 铺满视口的整屏应用。 */
export const APP_MODES = ['inline', 'fullpage'];

/** `state` 能力的第三种作用域：全站共享。它落在 `doc_site_state`，不落 `doc_app_state`。 */
export const SITE_STATE_SCOPE = 'site';

/** 沙箱状态（含全站共享）的全部作用域。 */
export const STATE_SCOPES = [...APP_STATE_SCOPES, SITE_STATE_SCOPE];

/** 全站共享状态的配额：单值字节、每个 namespace 的键数。 */
export const MAX_SITE_STATE_VALUE = 4096;
export const MAX_SITE_STATE_KEYS = 1000;

/**
 * 服务端能力调用的限流：每个 (访客, 文档) 每分钟多少次。
 * 沙箱那边 200 条/秒管的是**消息频率**，管不到服务端压力 —— 这是两道不同的闸。
 */
export const MAX_CAPABILITY_CALLS_PER_MINUTE = 60;

/**
 * `state` 能力用 `scope='site'` 时，数据落在哪个 namespace。
 *
 *   - 带代码的自定义块类型（§2.4）：**用类型名** —— 于是同一个组件在所有引用它的
 *     帖子之间共享一份全局数据（「计算器用过几次」是它自己的事，不是哪一篇帖子的）。
 *   - 内置的 `script` 块：**用 `doc:<文档 id>`** —— 一篇帖子一个名字空间，
 *     否则两篇帖子的脚本会互相踩。
 */
export function siteStateNamespace({ type = '', documentId = 0 } = {}) {
  const name = String(type ?? '');
  return name === 'script' ? `doc:${Number(documentId) || 0}` : name;
}

/**
 * 沙箱里的代码能向宿主申请的**能力白名单**。
 *
 * 一个沙箱是不透明源：它读不到 DOM、cookie、localStorage，也发不出网络请求，
 * 所以「能干什么」完全由这张表决定。加名字 = 开窗，每个都得能审计（`doc_capability_logs`）。
 *   `doc-meta`   这篇文档的公开元信息（标题 / 作者 / 更新时间）
 *   `doc-blocks` 正文里其它块的 `{id, type, props}` —— 于是「按别的块算点东西」写得出来
 *   `viewer`     正在看的人（登录与否 / 用户名 / 是不是管理员）
 *   `state`      读写**自己的**持久状态（`Sandbox.state`）—— 没有它，代码算完就没了
 *
 * 第二轮新增的两个（走**帖子级脚本**才拿得到，见 spec §4.3）：
 *   `blocks.derived` 派生层增删改查。`list` 永远允许（它只回访客本来就看得见的东西），
 *                    其余三个只在文档的 `allow_script_write=1` 时放行。
 *   `site.read`      读站内其它内容的**只读**出口：只回 `scope='public'` 且未删除的行，
 *                    分页 ≤ 50，绝不含邮箱等私密字段。这是本轮唯一新增的信息暴露面。
 */
export const SANDBOX_CAPABILITIES = ['doc-meta', 'doc-blocks', 'viewer', 'state', 'blocks.derived', 'site.read'];

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
  reason      TEXT    NOT NULL DEFAULT 'edit' CHECK (reason IN ('create','edit','ops','template','import','rollback','adopt')),
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

-- 每篇文档一份的**设置**（第二轮新增）。脚本代码、开关、全屏、wiki 归站位置都在这里。
-- 为什么不加列到 documents：documents 早就建好了，CREATE TABLE IF NOT EXISTS 对已存在的表
-- 是空操作，而 core 的 ensureColumn 只覆盖 users 与 posts（见文件头与 §2.1 的长注释）。
-- 这八样也都不是**正文**：不进修订、不进导出、不进 props —— 所以它们不能塞进 document_blocks。
--   allow_script_write 每篇一个开关，**默认 0 = 脚本只能读本帖的块**（Q6）
--   app_mode           inline（正常流里一枚小标）/ fullpage（铺满视口的整屏应用）
--   station_id         属于哪个 wiki 站（0 = 不属于任何站，于是它照旧是一条独立帖子）
--   parent_id          站在树上的父页（0 = 直接挂在站下）
--   sort_order         同一个父页下的排序
--   icon               树上的图标（一个短字符串，不是表情图片）
--   source_text        作者最后一次输入的**源码原文，逐字节**（§3.4）。
--                      解析器是有损的（表格分隔行会被剥、嵌套列表被吞、看不懂的退回段落），
--                      所以编辑器的往返基准必须是这一串字节，而不是「解析再拼回来」。
--                      只读路径**完全不看它**：渲染永远以 document_blocks 为准。
-- 一行都不存在时按默认值算（queries.settingsOf 返回 null，调用方补默认值），所以不写「INSERT 默认行」。
CREATE TABLE IF NOT EXISTS doc_settings (
  document_id        INTEGER PRIMARY KEY REFERENCES documents(id),
  allow_script_write INTEGER NOT NULL DEFAULT 0,
  app_mode           TEXT    NOT NULL DEFAULT 'inline' CHECK (app_mode IN ('inline','fullpage')),
  station_id         INTEGER NOT NULL DEFAULT 0,
  parent_id          INTEGER NOT NULL DEFAULT 0,
  sort_order         INTEGER NOT NULL DEFAULT 0,
  icon               TEXT    NOT NULL DEFAULT '',
  source_text        TEXT    NOT NULL DEFAULT '',
  updated_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_doc_settings_station ON doc_settings (station_id, parent_id, sort_order);

-- 派生层：**脚本产出的块**（第二轮新增，Q6 的 C 方案）。
-- 它像真块一样渲染、能参与 bind、能按「每人一份」或「全站共享一份」持久化，
-- 但**永远不进 document_blocks**：不产生修订、不算作者编辑。
-- 「采纳为真块」= 把这些行拷进 document_blocks（发新 id、position 接到末尾）+ 写一条
-- reason='adopt' 的修订 + 删掉这些行 —— 于是固化一次就是一次普通文档写，不需要新机制。
-- block_id 是**脚本自己的命名空间**（s1 / chart-main 这类），与真块的 b 加数字互不干扰；
-- position 用 REAL 的理由与 document_blocks 一样（插到 3 和 4 之间写 3.5）。
-- 删文档 / 采纳时由 store 清掉，不留孤儿行。
CREATE TABLE IF NOT EXISTS doc_script_blocks (
  document_id INTEGER NOT NULL REFERENCES documents(id),
  scope       TEXT    NOT NULL DEFAULT 'user' CHECK (scope IN ('user','shared')),
  user_id     INTEGER NOT NULL DEFAULT 0,
  block_id    TEXT    NOT NULL,
  type        TEXT    NOT NULL,
  props_json  TEXT    NOT NULL DEFAULT '{}',
  position    REAL    NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (document_id, scope, user_id, block_id)
);
CREATE INDEX IF NOT EXISTS idx_doc_script_blocks_doc ON doc_script_blocks (document_id, position);

-- 全站共享状态（state 能力的 scope='site'，第二轮新增）。
-- 为什么不是 doc_app_state 加一个 scope 值：那张表的 CHECK 只允许 user|shared，
-- 而给已存在的表改 CHECK 要重建表（SQLite 没有 ALTER CONSTRAINT）—— 新表是纯加法。
-- namespace 由 schema.js:siteStateNamespace 决定（自定义组件用类型名、内置 script 用 doc:<id>）；
-- key 是脚本自己起的名字；user_id 恒为 0，留着这一列是为了以后要按人分时可以长出来。
CREATE TABLE IF NOT EXISTS doc_site_state (
  namespace  TEXT    NOT NULL,
  key        TEXT    NOT NULL,
  user_id    INTEGER NOT NULL DEFAULT 0,
  value      TEXT    NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (namespace, key, user_id)
);

-- 用户自己的**脚本模板**（第三轮新增，「开发者功能」里的个人零件库）。
-- 为什么不是 templates.js 里的那 8 个内置模板：那些是**一篇文档的起始块序列**（骨架），
-- 跟着代码走、只读；这里的每一条是**一段可复用的沙箱代码**，按用户存、能改能删。
-- 为什么不塞进 doc_block_types：块类型是**全站共享**的注册表（注册了所有人都能用，
-- 而且目前撤不掉 —— README 记的已知缺口），模板必须是**个人**的、必须能删。
-- code 的长度上限复用 MAX_SCRIPT_CODE，在 store 里查；每人的条数上限见 MAX_SCRIPT_TEMPLATES。
CREATE TABLE IF NOT EXISTS doc_script_templates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  name        TEXT    NOT NULL,
  description TEXT    NOT NULL DEFAULT '',
  code        TEXT    NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE (user_id, name)
);
CREATE INDEX IF NOT EXISTS idx_doc_script_templates_user ON doc_script_templates (user_id, updated_at DESC);

-- 积木的**标签**（第四轮新增，用来替代下线的「学术笔记」）。
-- 为什么不给 documents 加一列 tags：表早就建好了，CREATE TABLE IF NOT EXISTS 对已存在的表
-- 是空操作，而 core 的 ensureColumn 只覆盖 users 与 posts（见文件头与 §2.1 的长注释）——
-- 要加列就得写一次守卫式迁移，为了一张「一篇文章 0~5 个短字符串」的名单不值当。
-- 为什么不是一张 tags 主表 + 关联表：标签没有自己的生命周期（没有简介、没有作者、不能单独改名），
-- 「有哪些标签」是从用法里长出来的（SELECT DISTINCT tag 就够了），多一张主表只会多一条要同步的真相。
-- 主键 (document_id, tag) 顺带管住了「同一篇里同一个标签出现两次」。
-- 删文档时由 store 一并清掉，不留孤儿行。
CREATE TABLE IF NOT EXISTS doc_tags (
  document_id INTEGER NOT NULL REFERENCES documents(id),
  tag         TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (document_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_doc_tags_tag ON doc_tags (tag, document_id);

-- 草稿箱（第五轮新增）：一篇文档「还没发布过 / 有没发布的改动」时在这里留一行。
-- 为什么不给 documents 加一列：表早就建好了，CREATE TABLE IF NOT EXISTS 对已存在的表
-- 是空操作，加列就得写守卫式迁移（同 doc_tags 的理由）；新伴随表才是纯加法。
-- 三种状态全靠「这一行在不在」+ doc_published_blocks 表达，**不需要回填**：
--   没有行            = 没有草稿，document_blocks 就是线上内容（老库与刚发布完的文档天然如此）
--   有行 published=0  = 从没发布过，只有作者自己的草稿箱里看得见（读者一律 404）
--   有行 published=1  = 发布过，但工作副本又有改动；读者读 doc_published_blocks
-- 不变量：published=1 的行，doc_published_blocks 里**一定**已经有一份线上内容 ——
-- 由 store.js 的 beginDraft 保证（它先拷旧的正文，再让人改工作副本）。
CREATE TABLE IF NOT EXISTS doc_drafts (
  document_id INTEGER PRIMARY KEY REFERENCES documents(id),
  published   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- 线上版正文：发布那一刻的 document_blocks 副本。列与 document_blocks **逐列一致**，
-- 所以 blockFromRow 与同一套取列/排序照原样通用（发布 = 拷一次，不改任何写块路径）。
-- 删文档时由 store 一并清掉，不留孤儿行。
CREATE TABLE IF NOT EXISTS doc_published_blocks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id  INTEGER NOT NULL REFERENCES documents(id),
  block_id     TEXT    NOT NULL,
  type         TEXT    NOT NULL,
  type_version INTEGER NOT NULL DEFAULT 1,
  position     REAL    NOT NULL,
  props_json   TEXT    NOT NULL DEFAULT '{}',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE (document_id, block_id)
);
CREATE INDEX IF NOT EXISTS idx_doc_published_blocks_order ON doc_published_blocks (document_id, position);
`;

/**
 * 从 `DOC_SCHEMA` 里摘出某张表的 CREATE 语句（迁移要**重建**表时用同一份 DDL）。
 *
 * 为什么不把 DDL 抄第二遍：两份真相必然分叉，改了其中一份忘了另一份，
 * 正是这类迁移 bug 的经典写法。宁可在这里正则摘一次。
 */
export function docTableDdl(name, as = name) {
  const match = new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\);`).exec(DOC_SCHEMA);
  if (!match) throw new Error(`DOC_SCHEMA 里没有 ${name} 这张表`);
  // 第二参数：同一份 DDL 换个表名建表（重建表时必须先建成临时名字，**不能**改旧表的名字）。
  return as === name ? match[0] : match[0].replace(`CREATE TABLE IF NOT EXISTS ${name} `, `CREATE TABLE IF NOT EXISTS ${as} `);
}
