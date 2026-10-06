// 团队（P4）的数据表。
//
// 三张表全是新增的，不动 v1 / core 的任何一张表 —— 迁移是纯加法，线上老数据一个字都不用改。
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
//      撑不起本模块的验收点「成员一起编辑且不互相覆盖」。
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

/** 加入方式：`open` 谁都能自己加入；`invite` 只能由 owner / admin 拉人。 */
export const TEAM_JOIN_POLICIES = ['open', 'invite'];

/** 字段长度上限。与前端 `public/views/team.js` 里的 maxlength 必须一致。 */
export const MAX_TEAM_NAME = 40;
export const MAX_TEAM_INTRO = 300;
export const MAX_TEAM_SLUG = 40;
export const MAX_TEAM_POST_TITLE = 120;

/** 团队帖正文上限。与帖子同一个口径（core 的帖子也是 20000）。 */
export const MAX_TEAM_POST_CONTENT = 20000;

/** 一个团队主页一页显示多少条帖子。 */
export const TEAM_PAGE_MAX = 50;

export const TEAM_SCHEMA = `
-- 团队本体。slug 是给人看、给 URL 用的短名；name 是可以随时改的中文名。
CREATE TABLE IF NOT EXISTS teams (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT    NOT NULL UNIQUE,
  name        TEXT    NOT NULL,
  intro       TEXT    NOT NULL DEFAULT '',
  -- 建队的人。与 team_members 里 role='owner' 的那一行始终一致（建队时同一个事务里写）。
  owner_id    INTEGER NOT NULL REFERENCES users(id),
  join_policy TEXT    NOT NULL DEFAULT 'open' CHECK (join_policy IN ('open','invite')),
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
`;
