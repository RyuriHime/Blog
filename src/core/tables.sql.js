// 搬运自 src/db.js:8-201 的 SCHEMA 大字符串（预铺骨架，逐字未改，只去掉了外壳）。
// 14 张 core 表：users / sessions / boards / posts / replies / reactions /
// bookmarks / follows / notifications /
// profile_categories / reposts / moderation_logs / messages / blocks。
//
// 这里是唯一还留着一大块 SQL 的地方。拆成 14 个文件并不划算：
// 它们之间靠外键互相引用，拆开只会让「按什么顺序建表」变得更难看出。
// 各业务模块自己的表**不要**写在这里，走 schemas.add() 登记。
import { schemas } from './table.js';

export const CORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  username        TEXT    NOT NULL UNIQUE,
  display_name    TEXT    NOT NULL,
  password_hash   TEXT    NOT NULL,
  role            TEXT    NOT NULL DEFAULT 'member',
  bio             TEXT    NOT NULL DEFAULT '',
  avatar          TEXT    NOT NULL DEFAULT '',
  banned          INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS boards (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT    NOT NULL UNIQUE,
  name        TEXT    NOT NULL,
  description TEXT    NOT NULL DEFAULT '',
  icon        TEXT    NOT NULL DEFAULT '💬',
  sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS posts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id          INTEGER NOT NULL REFERENCES boards(id),
  user_id           INTEGER NOT NULL REFERENCES users(id),
  title             TEXT    NOT NULL,
  content           TEXT    NOT NULL,
  views             INTEGER NOT NULL DEFAULT 0,
  pinned            INTEGER NOT NULL DEFAULT 0,
  locked            INTEGER NOT NULL DEFAULT 0,
  deleted           INTEGER NOT NULL DEFAULT 0,
  hidden            INTEGER NOT NULL DEFAULT 0,
  hidden_at         INTEGER,
  hidden_by         INTEGER,
  hidden_reason     TEXT    NOT NULL DEFAULT '',
  category_id       INTEGER,
  profile_pinned    INTEGER NOT NULL DEFAULT 0,
  profile_pinned_at INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_posts_board ON posts(board_id, deleted, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_user ON posts(user_id, deleted, created_at DESC);

CREATE TABLE IF NOT EXISTS replies (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  content    TEXT    NOT NULL,
  deleted    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_replies_post ON replies(post_id, deleted, created_at);

-- 评价：赞 / 踩（同一用户对同一帖子只能二选一）
CREATE TABLE IF NOT EXISTS reactions (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  kind       TEXT    NOT NULL CHECK (kind IN ('like', 'dislike')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, post_id)
);
CREATE INDEX IF NOT EXISTS idx_reactions_post ON reactions(post_id, kind);

CREATE TABLE IF NOT EXISTS bookmarks (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, post_id)
);
CREATE INDEX IF NOT EXISTS idx_bookmarks_user ON bookmarks(user_id, created_at DESC);

-- 关注关系
CREATE TABLE IF NOT EXISTS follows (
  follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (follower_id, followee_id)
);
CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows(followee_id);

-- 消息通知
-- team_id 故意不写外键：teams 表由团队模块自己建，两边谁先建不确定（同一个道理见 feed_items.team_id）。
-- 它只用来把「团队公告」这类通知指回具体团队，团队没了通知也就没人点得进去，留着无害。
CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  type       TEXT    NOT NULL,
  post_id    INTEGER REFERENCES posts(id) ON DELETE CASCADE,
  reply_id   INTEGER REFERENCES replies(id) ON DELETE CASCADE,
  team_id    INTEGER,
  excerpt    TEXT    NOT NULL DEFAULT '',
  read_at    INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(user_id, read_at);

-- 个人主页的文章分类（用户自建）
CREATE TABLE IF NOT EXISTS profile_categories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT    NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, name)
);
CREATE INDEX IF NOT EXISTS idx_profile_categories_user ON profile_categories(user_id, sort_order);

-- 转发（同一用户对同一篇只留一条，可撤销）
CREATE TABLE IF NOT EXISTS reposts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  comment    TEXT    NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, post_id)
);
CREATE INDEX IF NOT EXISTS idx_reposts_post ON reposts(post_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reposts_user ON reposts(user_id, created_at DESC);

-- 管理操作审计日志（隐藏/删除文章、封禁、发放或收回管理员）
CREATE TABLE IF NOT EXISTS moderation_logs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action       TEXT    NOT NULL,
  target_type  TEXT    NOT NULL,
  target_id    INTEGER NOT NULL,
  target_label TEXT    NOT NULL DEFAULT '',
  reason       TEXT    NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_moderation_logs_created ON moderation_logs(created_at DESC);

-- 私信（一对一，不做群聊；已读状态记在收件人侧）
CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content      TEXT    NOT NULL,
  read_at      INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(sender_id, recipient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_inbox ON messages(recipient_id, read_at, created_at DESC);

-- 黑名单：被拉黑的人不能关注、私信我，也看不到我发的文章
CREATE TABLE IF NOT EXISTS blocks (
  blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);
CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON blocks(blocked_id);
`;

schemas.addScript(CORE_SCHEMA, 'core');

/** 逐条切出单张表的建表语句，方便别的模块或测试按名字取用。 */
export function coreTableStatements() {
  return CORE_SCHEMA.split(/;\s*(?=\n|$)/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => `${item};`);
}
