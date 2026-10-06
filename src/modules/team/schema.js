// 团队（P4）的数据表。
//
// 七张表全是新增的，不动 v1 / core 的任何一张表 —— 迁移是纯加法，线上老数据一个字都不用改。
// 老库开库时这几条 `CREATE TABLE IF NOT EXISTS` 会照跑一遍：新加的 `team_replies`
// 与 `team_join_requests` 因此在任何老库上都是自动建出来的，migrate.js 只管
// 「老表补列」与「老表改约束（只能重建）」这两种改不动的情况。
//
// 建表顺序 = 别的模块 import 这个文件时登记的顺序；`addScript` 会按「括号深度为 0 的分号」
// 切开逐条登记，索引语句照旧执行但不进表名册（否则索引名会被当成表名，归属检查会误报）。
//
// ⚠️ 为什么团队帖子不放进 core 的 `posts`、也不复用 P2 的 `documents`：
//   1) `posts.board_id` 是 `boards` 的外键，团队帖要挂进 `posts` 就得凭空造一个「团队」板块，
//      而 `buildFilter()`（`src/store.js`）的第一句就是 `p.deleted = 0` —— 造出来的帖子会
//      出现在首页、版块列表和全文搜索里；用 `hidden` 藏又会撞上 core 的语义
//      「非 staff 非作者一律 404」（`src/core/guards.js` 的 `assertPostVisible`），
//      团队普通成员不是 staff，一点开就 404。
//   2) `documents` 上的 `team` 档含义是「任何与我共享任一团队的人都能看」（见
//      `src/modules/doc/visibility.js` 的 `sameTeam`），它没有 `team_id`，
//      表达不了「这一篇属于**哪个**团队的主页」，也没有 `version` 列，
//      撑不起本模块的验收点「改自己的帖也不静默覆盖（版本号 + 冲突提示）」。
//   3) 三张表归 P4 自己，团队帖的可见性、版本号、软删除就都在 P4 的目录里，
//      改它不会碰到任何人 —— 这正是 v2 骨架并行开工的前提。

/**
 * 可见范围的**冻结枚举**。
 *
 * 与 P1 的 `FEED_SCOPES`（`src/modules/feed/schema.js`）、P2 的 `documents.scope`
 * 是**同一套四个值**，属于跨模块契约：改这里 = 改契约，必须同步
 * `docs/skeleton.md` 与 `public/views/timeline.js`。
 *
 * 模块之间不许互相 import（`scripts/check-skeleton.mjs` 会扫相对 import），
 * 所以这里是**照抄一份**而不是引用 —— 这不是重复，是解耦的代价。
 */
export const TEAM_SCOPES = ['public', 'followers', 'team', 'private'];

/** 团队成员角色。`owner` 是建队的人且**唯一**（转让要显式接口，不允许两个 owner）。 */
export const TEAM_ROLES = ['owner', 'admin', 'member'];

/**
 * 加入方式：`open` 谁都能自己加入；`apply` 要先递一条申请，团长与管理员批准了才算加入。
 *
 * ⚠️ 这两档是冻结枚举，改它必须同步三处：`teams.join_policy` 的 CHECK、
 * `migrate.js` 里那条重建表（老库是先有 `invite` 才有 `apply` 的），以及前端
 * `public/views/team.js` 的两处下拉框。
 *
 * 「邀请」不再是一个**设置**：它变成了团队号（见 `TEAM_JOIN_CODE_LENGTH` 那段）——
 * 号本身就是邀请，管理员把号发给谁就是邀请了谁。原来的 `invite` 档只能靠
 * 「拉人接口」把人塞进来，那条路已经删掉了（团长与管理员不该能凭一个用户名
 * 就把人拽进团队，当事人连知都不知道）。
 */
export const TEAM_JOIN_POLICIES = ['open', 'apply'];

/** 字段长度上限。与前端 `public/views/team.js` 里的 maxlength 必须一致。 */
export const MAX_TEAM_NAME = 40;
export const MAX_TEAM_INTRO = 300;
export const MAX_TEAM_SLUG = 40;
export const MAX_TEAM_POST_TITLE = 120;

/** 团队帖正文上限。与帖子同一个口径（core 的帖子也是 20000）。 */
export const MAX_TEAM_POST_CONTENT = 20000;

/** 一条回复的字数上限。与 core 的回复同一个口径（那边也是 5000）。 */
export const MAX_TEAM_REPLY_CONTENT = 5000;

/** 一个团队主页一页显示多少条帖子。 */
export const TEAM_PAGE_MAX = 50;

/** 团队文件柜：单个文件上限。 */
export const MAX_TEAM_FILE_BYTES = 4 * 1024 * 1024;

/** 文件原名（展示用）的长度上限。磁盘上的名字由服务端另起，见 storage.js。 */
export const MAX_TEAM_FILE_NAME = 120;

/** 文件柜一页多少条。 */
export const TEAM_FILE_PAGE_MAX = 50;

/**
 * 上传接口的请求体上限。
 *
 * 6 MB ≈ 「4 MB 文件做成 base64」（base64 会胀 4/3，5.33 MB）再加一点余量。
 * 它是**逐路由**放宽的（`src/core/router.js` 里 `route()` 的第 4 个参数），
 * 不是把全站上限抬到 6 MB —— 别的接口还是 512 KB。
 */
export const TEAM_FILE_BODY_LIMIT = 6 * 1024 * 1024;

/** 群聊一条消息的字数上限。 */
export const MAX_TEAM_MESSAGE = 1000;

/** 群聊一次最多拉多少条（轮询用小值，进页面用大值）。 */
export const TEAM_MESSAGE_PAGE_MAX = 100;

/**
 * 团队号（teamid）：6 位，用它就能加入团队，不用先找管理员拉人。
 *
 * 字母表是 Crockford Base32 的那一套：去掉了 I / L / O / U ——
 * 前三个念出来会听错、抄下来会看错（1 和 l、0 和 O），U 去掉是为了不与脏话拼词。
 * 用户手写输入时由 `join-code.js` 把 I / L 折成 1、O 折成 0，所以「抄错一位」大多能救回来。
 *
 * 32^6 ≈ 10.7 亿种，配合「查号」接口的限流（20 次 / 10 分钟 / 人）没法暴力枚举。
 */
export const TEAM_JOIN_CODE_LENGTH = 6;
export const TEAM_JOIN_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 团队公告的正文上限。公告会人手一条通知，所以别让它长到刷屏。 */
export const MAX_TEAM_ANNOUNCEMENT = 2000;

/** 加入申请里那句「想加入的理由」的上限。 */
export const MAX_TEAM_JOIN_MESSAGE = 200;

/** 一条加入申请的三档状态。走完 `approved` / `rejected` 就不再回头。 */
export const TEAM_JOIN_REQUEST_STATUSES = ['pending', 'approved', 'rejected'];

/** 管理面板一次最多列出多少条申请。 */
export const TEAM_JOIN_REQUEST_PAGE_MAX = 50;

export const TEAM_SCHEMA = `
-- 团队本体。slug 是给人看、给 URL 用的短名；name 是可以随时改的中文名。
CREATE TABLE IF NOT EXISTS teams (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT    NOT NULL UNIQUE,
  name        TEXT    NOT NULL,
  intro       TEXT    NOT NULL DEFAULT '',
  -- 建队的人。与 team_members 里 role='owner' 的那一行始终一致（建队时同一个事务里写）。
  owner_id    INTEGER NOT NULL REFERENCES users(id),
  join_policy TEXT    NOT NULL DEFAULT 'open' CHECK (join_policy IN ('open','apply')),
  -- 要不要出现在「团队广场」的列表里。1 = 出现（默认），0 = 藏起来。
  --
  -- 藏起来 ≠ 不能进：团队主页、团队号、帖子链接照旧能用，只是不在广场上被陌生人逛到。
  -- 这就是「不公开的团队」该有的样子 —— 隐私要在**被发现**这一层解决，
  -- 而不是把入口一并砍掉（否则群里发个链接给自己人都进不来）。
  listed      INTEGER NOT NULL DEFAULT 1,
  -- 6 位团队号：凭它加入团队（见 join-code.js）。老库由 migrate.js 回填，所以有默认空串。
  -- ⚠️ 它的唯一索引**不在这里建**：老库的 teams 表还没有这一列，
  --    开库时执行建表脚本会先跑，那时建索引会报「no such column」。
  --    索引跟着列一起放在 migrate.js 里建（列加完再建索引，顺序才是对的）。
  join_code   TEXT    NOT NULL DEFAULT '',
  -- 团队公告：团长与管理员能改，改完给全体成员发一条通知。
  -- 空串 = 还没写过公告。announcement_by / _at 记住「谁在什么时候改的」，
  -- 公告被清空时两列一起置空，不留「上一版的作者」这种会误导人的残渣。
  announcement    TEXT    NOT NULL DEFAULT '',
  announcement_by INTEGER REFERENCES users(id),
  announcement_at INTEGER,
  deleted     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_teams_time  ON teams (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_teams_owner ON teams (owner_id);

-- 成员表。主键 (team_id, user_id) 保证一个人在一个团队里只有一行 ——
-- 「重复加入」因此在数据库层就不可能发生，不靠应用层判重。
CREATE TABLE IF NOT EXISTS team_members (
  team_id   INTEGER NOT NULL REFERENCES teams(id),
  user_id   INTEGER NOT NULL REFERENCES users(id),
  role      TEXT    NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, user_id)
);
-- 「我加入了哪些团队」是每个页面都要问的问题，按 user_id 走索引。
CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members (user_id, team_id);

-- 团队帖子。
--
-- ⚠️ team_id 这里**有**外键（与 feed_items.team_id 故意不加外键正好相反）：
-- feed_items 是 P1 的表，建它的时候 teams 还不存在，加外键会让它建不出来；
-- 而 team_posts 是 P4 自己的表，teams 在同一个脚本里排在它前面，加外键是安全的。
--
-- version：乐观并发的版本号。每次成功保存 +1；客户端提交时带上自己看到的版本，
-- 对不上就是「有人改过了」（409 conflict），接口把选择权交回给人，不静默覆盖。
CREATE TABLE IF NOT EXISTS team_posts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id    INTEGER NOT NULL REFERENCES teams(id),
  user_id    INTEGER NOT NULL REFERENCES users(id),
  title      TEXT    NOT NULL DEFAULT '',
  content    TEXT    NOT NULL DEFAULT '',
  scope      TEXT    NOT NULL DEFAULT 'team' CHECK (scope IN ('public','followers','team','private')),
  version    INTEGER NOT NULL DEFAULT 1,
  -- 最后一次改它的人。冲突提示里要指名道姓（「张三刚刚改过」），只有版本号说不出这句话。
  updated_by INTEGER,
  deleted    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_team_posts_team ON team_posts (team_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_team_posts_user ON team_posts (user_id, created_at DESC);

-- 团队帖的回复。
--
-- ⚠️ 回复**没有自己的可见范围**：跟着帖子走。「帖子看得见」= 「回复看得见」（见 routes.js 里的
-- loadPost），一条回复单独设 scope 只会让「这段对话谁看得见哪半段」变成谜。
-- 于是作者把帖子标成 public 时，路过的读者能看见、也能读完这串回复 —— 这正是 public 的意思。
--
-- 写回复则收紧到**团队成员**（路由里判）：回复是队内讨论，路过的人看完就走。
--
-- team_id 是**故意冗余**的一份：权限判定要问「我在这个团队里是什么角色」，
-- 有它就不用绕道 team_posts，写法与 team_messages / team_files 一致。
-- 写入时从帖子取，此后不变（帖子不会转会到别的团队）。
--
-- deleted 是软删除：作者本人或团队管理员能删（routes.js），删完留一行壳，编号不乱。
CREATE TABLE IF NOT EXISTS team_replies (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id    INTEGER NOT NULL REFERENCES team_posts(id),
  team_id    INTEGER NOT NULL REFERENCES teams(id),
  user_id    INTEGER NOT NULL REFERENCES users(id),
  content    TEXT    NOT NULL DEFAULT '',
  deleted    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
-- 回复永远按「某条帖子、时间正序」取，所以索引里 post_id 在前、created_at 升序。
CREATE INDEX IF NOT EXISTS idx_team_replies_post ON team_replies (post_id, deleted, created_at, id);
CREATE INDEX IF NOT EXISTS idx_team_replies_user ON team_replies (user_id, created_at DESC);

-- 团队文件柜。
--
-- 磁盘上的文件名**不存用户给的那个名字**，而是另起 <team_id>-<时间>-<随机>.<扩展名>
-- （见 storage.js）。用户给的名字只用于展示、以及下载时回填
-- Content-Disposition；直接拿它当路径就是一次目录穿越（「../../…」），
-- 这里从结构上不给这个机会 —— 库里这一列只可能是白名单字符。
CREATE TABLE IF NOT EXISTS team_files (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id     INTEGER NOT NULL REFERENCES teams(id),
  user_id     INTEGER NOT NULL REFERENCES users(id),
  name        TEXT    NOT NULL,                 -- 展示用的原名
  mime        TEXT    NOT NULL DEFAULT '',
  size        INTEGER NOT NULL DEFAULT 0,
  stored_name TEXT    NOT NULL,                 -- 落盘文件名，只含 [A-Za-z0-9._-]
  deleted     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_team_files_team ON team_files (team_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_team_files_user ON team_files (user_id, created_at DESC);

-- 团队群聊。
--
-- 只存纯文本：**不做 Markdown 渲染**。聊天框里贴 HTML 是最容易被当成「渲染功能」
-- 引进来的一次 XSS，这里干脆不给这个面 —— 前端只负责把文本转义后显示。
CREATE TABLE IF NOT EXISTS team_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id    INTEGER NOT NULL REFERENCES teams(id),
  user_id    INTEGER NOT NULL REFERENCES users(id),
  content    TEXT    NOT NULL,
  deleted    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
-- 群聊永远是「按团队取一段、按时间排」；轮询只问 id 更大的那些，所以索引带 id DESC。
CREATE INDEX IF NOT EXISTS idx_team_messages_team ON team_messages (team_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_team_messages_user ON team_messages (user_id, id DESC);

-- 加入申请。
--
-- 团队的「加入方式」设成 apply 之后，想进来的人先在这里递一条申请，
-- 团长与管理员批准（PUT /api/teams/:id/join-requests/:requestId）了才写进 team_members。
-- 原来的做法是管理员拿一个用户名把人**直接拽进来**（那条路已经删了）——
-- 被拉的人连知都不知道，也没有拒绝的机会。
--
-- status 只在这三档之间走：pending → approved / rejected，走完不再回头。
-- 被拒之后还想进，就再递一条**新**的（历史留着当记录，也免得「改一下申请」把审核记录改没了）。
-- 唯一的部分索引保证同一个人对同一个团队最多只挂一条**待审**申请：
-- 重复点「申请加入」不该堆出一排一样的申请给管理员。
--
-- message 是申请人自己写的一句话理由（可以为空）：审核的人得有点上下文，
-- 只有一个用户名的话，除非本来就认识，否则没法判断。
CREATE TABLE IF NOT EXISTS team_join_requests (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id    INTEGER NOT NULL REFERENCES teams(id),
  user_id    INTEGER NOT NULL REFERENCES users(id),
  message    TEXT    NOT NULL DEFAULT '',
  status     TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  -- 谁批的、什么时候批的。还没处理时两列都是空 —— 与公告的 announcement_by/_at 同一个套路。
  decided_by INTEGER REFERENCES users(id),
  decided_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- 管理面板每次展开都要问「这个团队有哪些待审申请」，所以 (team_id, status) 一起进索引。
CREATE INDEX IF NOT EXISTS idx_team_join_requests_team ON team_join_requests (team_id, status, created_at DESC, id DESC);
-- 「我对这个团队的申请现在什么状态」团队主页要问，按人查。
CREATE INDEX IF NOT EXISTS idx_team_join_requests_user ON team_join_requests (user_id, team_id, id DESC);
-- 同一个人对同一个团队最多一条待审申请（被拒之后再申请是合法的：那时旧的那条已经不是 pending）。
CREATE UNIQUE INDEX IF NOT EXISTS idx_team_join_requests_pending ON team_join_requests (team_id, user_id) WHERE status = 'pending';
`;

/**
 * 从 `TEAM_SCHEMA` 里摘出某张表的 CREATE 语句（迁移要**重建**表时用同一份 DDL）。
 *
 * 为什么不把 DDL 抄第二遍：两份真相必然分叉，改了其中一份忘了另一份，
 * 正是这类迁移 bug 的经典写法。宁可在这里正则摘一次。
 *
 * `as` 是给「重建时要先建一张临时表」用的：同一份 DDL 换个表名照样用
 * （见 `migrate.js` 的 `ensureTeamJoinPolicy`）。不传就是原样。
 *
 * 目前只有 `teams` 用到它：`join_policy` 的 CHECK 从 `('open','invite')` 变成
 * `('open','apply')` —— CHECK 改不了，只能按新 DDL 重建表再搬数据。
 */
export function teamTableDdl(name, as = name) {
  const match = new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\);`).exec(TEAM_SCHEMA);
  if (!match) throw new Error(`TEAM_SCHEMA 里没有 ${name} 这张表`);
  return as === name ? match[0] : match[0].replace(`CREATE TABLE IF NOT EXISTS ${name} `, `CREATE TABLE IF NOT EXISTS ${as} `);
}
