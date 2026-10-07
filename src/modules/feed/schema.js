// 动态（P1）的数据表。
//
// 三张表都是新增的，不动 v1 的任何一张表 —— 这样迁移就是纯加法，
// 线上老数据一个字都不用改（见 03-数据迁移与上线方案.md 的「方案甲·原地增量」）。
//
// 建表顺序 = 别的模块 import 这个文件时登记的顺序；
// `addScript` 会按「括号深度为 0 的分号」切开逐条登记，
// 索引语句照旧执行但不进表名册（否则索引名会被当成表名，归属检查会误报）。

/**
 * 可见范围的**冻结枚举**。
 *
 * 这四个值是跨模块契约：P4（团队）要按 `team` 判成员资格，P3（AI）要按同一套值
 * 决定「这条动态能不能喂给 AI」。改这个数组 = 改契约，必须同步
 * `docs/skeleton.md`、`public/views/timeline.js` 与 `scripts/feed-smoke.mjs`。
 *
 * ⚠️ 数据库那一层也钉死了（feed_items.scope 上的 CHECK），
 * 因为服务端强制过滤是 FR-FEED-08 的验收点，不能只靠应用层自觉。
 */
export const FEED_SCOPES = ['public', 'followers', 'team', 'private'];

/** 一条动态最多配几张图。与前端 `MAX_FEED_IMAGES` 必须一致。 */
export const MAX_FEED_IMAGES = 9;

/** 单张图的字节上限：与头像同一口径（256 KB，前端会先压缩）。 */
export const MAX_FEED_IMAGE_BYTES = 256 * 1024;

/** 正文长度上限。比帖子的 20000 短：动态是短内容。 */
export const MAX_FEED_CONTENT = 4000;

/** 动态回复的长度上限。与前端 `public/views/timeline.js` 的 `MAX_REPLY` 必须一致。 */
export const MAX_FEED_REPLY_CONTENT = 2000;

export const FEED_SCHEMA = `
-- 动态（一条时间线就是这张表倒着读）
CREATE TABLE IF NOT EXISTS feed_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  content     TEXT    NOT NULL DEFAULT '',
  scope       TEXT    NOT NULL DEFAULT 'public' CHECK (scope IN ('public','followers','team','private')),
  -- scope='team' 时指向 teams.id。**故意不加外键**：teams 归 P4，现在这张表还不存在，
  -- 加了外键会让 feed_items 建不出来，把 P1 和 P4 绑死。
  team_id     INTEGER,
  -- 配图：JSON 数组，元素是 { url, type, bytes }。url 是本站图片接口的绝对路径。
  images_json TEXT    NOT NULL DEFAULT '[]',
  -- 引用的站内帖子（渲染成卡片）。引用的帖子删了不影响这条动态还在。
  ref_post_id INTEGER,
  deleted     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feed_items_time ON feed_items (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_feed_items_user ON feed_items (user_id, created_at DESC);

-- 点赞 / 踩。与 posts 的 reactions 同语义：一人一条、可互斥、可取消。
CREATE TABLE IF NOT EXISTS feed_reactions (
  user_id      INTEGER NOT NULL REFERENCES users(id),
  feed_item_id INTEGER NOT NULL REFERENCES feed_items(id),
  kind         TEXT    NOT NULL CHECK (kind IN ('like','dislike')),
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (user_id, feed_item_id)
);
CREATE INDEX IF NOT EXISTS idx_feed_reactions_item ON feed_reactions (feed_item_id, kind);

-- 动态的回复。
-- 与帖子的 replies 同语义：软删（deleted = 1）、一个人可以对同一条动态回多条。
-- **不复用 replies 表**：那张表的外键指向 posts，而动态不是帖子（可见范围、
-- 删除语义、通知链路都不一样）。塞进同一张表会让「一条回复到底挂在哪」
-- 变成靠 user_id 猜的事。
CREATE TABLE IF NOT EXISTS feed_replies (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  feed_item_id INTEGER NOT NULL REFERENCES feed_items(id),
  user_id      INTEGER NOT NULL REFERENCES users(id),
  content      TEXT    NOT NULL DEFAULT '',
  deleted      INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feed_replies_item ON feed_replies (feed_item_id, deleted, created_at, id);
`;
