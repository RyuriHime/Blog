/**
 * 数据访问层：所有 SQL 都集中在这里，server.js 只负责 HTTP 与校验。
 *
 * 关于 POST_*_COLUMNS：开头的 6 个 `?` 依次是「浏览者参数」
 * （liked / disliked / my_coins / bookmarked / author_followed / reposted），
 * 拼接查询时必须先传 6 个 viewerId，再传过滤条件参数。
 */
import { COIN_RULES, MESSAGE_RULES, PROFILE_RULES } from './db.js';
import { addDays, parseDay, todayString } from './dates.js';

const VIEWER_PARAM_COUNT = 6;

/**
 * 拉黑过滤：把「我拉黑的人」和「拉黑了我的人」都排除掉。
 * 用在帖子列表与评论列表上：被拉黑的人看不到我的内容，我也眼不见为净。
 * 两个 `?` 都传当前浏览者 id。
 */
const BLOCKED_AUTHOR_SQL = `p.user_id NOT IN (
  SELECT blocked_id FROM blocks WHERE blocker_id = ?
  UNION
  SELECT blocker_id FROM blocks WHERE blocked_id = ?
)`;
const BLOCKED_COMMENTER_SQL = `r.user_id NOT IN (
  SELECT blocked_id FROM blocks WHERE blocker_id = ?
  UNION
  SELECT blocker_id FROM blocks WHERE blocked_id = ?
)`;

/* 单项计数的子查询（列表、详情共用，保证口径一致） */
const LIKE_COUNT_SQL = "(SELECT COUNT(*) FROM reactions rx WHERE rx.post_id = p.id AND rx.kind = 'like')";
const DISLIKE_COUNT_SQL = "(SELECT COUNT(*) FROM reactions rx WHERE rx.post_id = p.id AND rx.kind = 'dislike')";
const COIN_COUNT_SQL = '(SELECT COALESCE(SUM(c.amount), 0) FROM coins c WHERE c.post_id = p.id)';
const BOOKMARK_COUNT_SQL = '(SELECT COUNT(*) FROM bookmarks bm2 WHERE bm2.post_id = p.id)';
const REPOST_COUNT_SQL = '(SELECT COUNT(*) FROM reposts rp WHERE rp.post_id = p.id)';
const REPLY_COUNT_SQL = '(SELECT COUNT(*) FROM replies r WHERE r.post_id = p.id AND r.deleted = 0)';

const POST_LIST_COLUMNS = `
  p.id, p.title, substr(p.content, 1, 400) AS content_head,
  p.views, p.pinned, p.locked, p.created_at, p.updated_at,
  p.hidden, p.hidden_at, p.hidden_reason, p.hidden_by,
  p.category_id, pc.name AS category_name, p.profile_pinned, p.profile_pinned_at,
  b.id AS board_id, b.slug AS board_slug, b.name AS board_name, b.icon AS board_icon,
  u.id AS author_id, u.username AS author_username, u.display_name AS author_display, u.role AS author_role, u.avatar AS author_avatar,
  ${REPLY_COUNT_SQL} AS reply_count,
  ${LIKE_COUNT_SQL} AS like_count,
  ${DISLIKE_COUNT_SQL} AS dislike_count,
  ${COIN_COUNT_SQL} AS coin_count,
  ${BOOKMARK_COUNT_SQL} AS bookmark_count,
  ${REPOST_COUNT_SQL} AS repost_count,
  EXISTS (SELECT 1 FROM reactions rx WHERE rx.post_id = p.id AND rx.kind = 'like' AND rx.user_id = ?) AS liked,
  EXISTS (SELECT 1 FROM reactions rx WHERE rx.post_id = p.id AND rx.kind = 'dislike' AND rx.user_id = ?) AS disliked,
  COALESCE((SELECT SUM(c.amount) FROM coins c WHERE c.post_id = p.id AND c.user_id = ?), 0) AS my_coins,
  EXISTS (SELECT 1 FROM bookmarks bm WHERE bm.post_id = p.id AND bm.user_id = ?) AS bookmarked,
  EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = ? AND f.followee_id = p.user_id) AS author_followed,
  EXISTS (SELECT 1 FROM reposts rp2 WHERE rp2.post_id = p.id AND rp2.user_id = ?) AS reposted,
  COALESCE((SELECT MAX(r.created_at) FROM replies r WHERE r.post_id = p.id AND r.deleted = 0), p.created_at) AS last_active_at
`;

const POST_FULL_COLUMNS = POST_LIST_COLUMNS.replace(
  'substr(p.content, 1, 400) AS content_head',
  'p.content',
);

const SORTS = {
  latest: 'p.pinned DESC, p.created_at DESC',
  active: 'p.pinned DESC, last_active_at DESC',
  // 个人主页：主页置顶优先，其次按时间
  profile: 'p.profile_pinned DESC, p.profile_pinned_at DESC, p.created_at DESC',
  hot: `p.pinned DESC,
        (like_count * 4 + coin_count * 5 + reply_count * 3 - dislike_count * 2 + p.views * 0.1) DESC,
        p.created_at DESC`,
};

export function createStore(db) {
  const statements = {
    userByUsername: db.prepare('SELECT * FROM users WHERE username = ?'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    insertUser: db.prepare(
      `INSERT INTO users (username, display_name, password_hash, role, bio, banned, coin_balance, coin_refresh_at, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    ),
    addCoinBalance: db.prepare('UPDATE users SET coin_balance = coin_balance + ? WHERE id = ?'),
    updateProfile: db.prepare('UPDATE users SET display_name = ?, bio = ? WHERE id = ?'),
    updateAvatar: db.prepare('UPDATE users SET avatar = ? WHERE id = ?'),
    updatePassword: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
    deleteOtherSessions: db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?'),
    listUsers: db.prepare(
      `SELECT u.id, u.username, u.display_name, u.role, u.bio, u.avatar, u.banned, u.created_at, u.coin_balance,
              (SELECT COUNT(*) FROM posts p WHERE p.user_id = u.id AND p.deleted = 0) AS post_count,
              (SELECT COUNT(*) FROM replies r WHERE r.user_id = u.id AND r.deleted = 0) AS reply_count,
              (SELECT COUNT(*) FROM follows f WHERE f.followee_id = u.id) AS follower_count
       FROM users u ORDER BY u.banned ASC, u.id ASC`,
    ),
    setBanned: db.prepare('UPDATE users SET banned = ? WHERE id = ?'),
    setRole: db.prepare('UPDATE users SET role = ? WHERE id = ?'),
    countOwners: db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'owner'"),
    listStaff: db.prepare(
      "SELECT id, username, display_name, role, avatar, banned FROM users WHERE role IN ('owner', 'admin') ORDER BY role ASC, id ASC",
    ),
    listSessionsOfUser: db.prepare('SELECT token FROM sessions WHERE user_id = ?'),
    insertModerationLog: db.prepare(
      `INSERT INTO moderation_logs (actor_id, action, target_type, target_id, target_label, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    listModerationLogs: db.prepare(
      `SELECT g.id, g.action, g.target_type, g.target_id, g.target_label, g.reason, g.created_at,
              a.id AS actor_id, a.username AS actor_username, a.display_name AS actor_display, a.role AS actor_role
       FROM moderation_logs g
       LEFT JOIN users a ON a.id = g.actor_id
       ORDER BY g.created_at DESC, g.id DESC
       LIMIT ?`,
    ),
    countUsers: db.prepare('SELECT COUNT(*) AS count FROM users'),
    userProfile: db.prepare(
      `SELECT u.id, u.username, u.display_name, u.role, u.bio, u.avatar, u.created_at, u.coin_balance, u.banned,
              (SELECT COUNT(*) FROM posts p WHERE p.user_id = u.id AND p.deleted = 0) AS post_count,
              (SELECT COUNT(*) FROM replies r WHERE r.user_id = u.id AND r.deleted = 0) AS reply_count,
              (SELECT COUNT(*) FROM follows f WHERE f.followee_id = u.id) AS follower_count,
              (SELECT COUNT(*) FROM follows f WHERE f.follower_id = u.id) AS following_count,
              (SELECT COUNT(*) FROM reactions rx JOIN posts p2 ON p2.id = rx.post_id
                WHERE p2.user_id = u.id AND p2.deleted = 0 AND rx.kind = 'like') AS likes_received,
              (SELECT COUNT(*) FROM reactions rx JOIN posts p2 ON p2.id = rx.post_id
                WHERE p2.user_id = u.id AND p2.deleted = 0 AND rx.kind = 'dislike') AS dislikes_received,
              (SELECT COUNT(*) FROM bookmarks bm WHERE bm.user_id = u.id) AS bookmark_count
       FROM users u WHERE u.username = ?`,
    ),

    insertSession: db.prepare(
      'INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    ),
    sessionByToken: db.prepare('SELECT * FROM sessions WHERE token = ?'),
    touchSession: db.prepare('UPDATE sessions SET expires_at = ? WHERE token = ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
    purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),

    listBoards: db.prepare(
      `SELECT b.id, b.slug, b.name, b.description, b.icon, b.sort_order,
              (SELECT COUNT(*) FROM posts p WHERE p.board_id = b.id AND p.deleted = 0) AS post_count,
              (SELECT COUNT(*) FROM replies r JOIN posts p2 ON p2.id = r.post_id
                WHERE p2.board_id = b.id AND r.deleted = 0 AND p2.deleted = 0) AS reply_count
       FROM boards b ORDER BY b.sort_order ASC, b.id ASC`,
    ),
    boardBySlug: db.prepare('SELECT * FROM boards WHERE slug = ?'),
    boardById: db.prepare('SELECT * FROM boards WHERE id = ?'),

    insertPost: db.prepare(
      `INSERT INTO posts (board_id, user_id, title, content, views, pinned, locked, deleted, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, 0, 0, 0, ?, ?)`,
    ),
    updatePost: db.prepare('UPDATE posts SET title = ?, content = ?, board_id = ?, updated_at = ? WHERE id = ?'),
    softDeletePost: db.prepare('UPDATE posts SET deleted = 1, updated_at = ? WHERE id = ?'),
    setHidden: db.prepare('UPDATE posts SET hidden = ?, hidden_at = ?, hidden_by = ?, hidden_reason = ? WHERE id = ?'),
    countHiddenPosts: db.prepare('SELECT COUNT(*) AS count FROM posts WHERE deleted = 0 AND hidden = 1'),
    listHiddenPosts: db.prepare(
      `SELECT p.id, p.title, p.created_at, p.hidden_at, p.hidden_reason,
              u.display_name AS author_display, u.username AS author_username,
              m.display_name AS moderator_display
       FROM posts p
       JOIN users u ON u.id = p.user_id
       LEFT JOIN users m ON m.id = p.hidden_by
       WHERE p.deleted = 0 AND p.hidden = 1
       ORDER BY p.hidden_at DESC LIMIT ?`,
    ),
    bumpViews: db.prepare('UPDATE posts SET views = views + 1 WHERE id = ?'),
    countPostsAll: db.prepare('SELECT COUNT(*) AS count FROM posts WHERE deleted = 0'),
    countRepliesAll: db.prepare('SELECT COUNT(*) AS count FROM replies WHERE deleted = 0'),

    listReplies: db.prepare(
      `SELECT r.id, r.content, r.created_at, r.user_id,
              u.username AS author_username, u.display_name AS author_display, u.role AS author_role, u.banned AS author_banned, u.avatar AS author_avatar
       FROM replies r JOIN users u ON u.id = r.user_id
       WHERE r.post_id = ? AND r.deleted = 0 AND (${BLOCKED_COMMENTER_SQL} OR ? = -1)
       ORDER BY r.created_at ASC`,
    ),
    replyById: db.prepare('SELECT * FROM replies WHERE id = ?'),
    insertReply: db.prepare(
      'INSERT INTO replies (post_id, user_id, content, deleted, created_at) VALUES (?, ?, ?, 0, ?)',
    ),
    softDeleteReply: db.prepare('UPDATE replies SET deleted = 1 WHERE id = ?'),

    reactionByUserPost: db.prepare('SELECT kind FROM reactions WHERE user_id = ? AND post_id = ?'),
    upsertReaction: db.prepare(
      `INSERT INTO reactions (user_id, post_id, kind, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, post_id) DO UPDATE SET kind = excluded.kind, created_at = excluded.created_at`,
    ),
    deleteReaction: db.prepare('DELETE FROM reactions WHERE user_id = ? AND post_id = ?'),
    countReaction: db.prepare('SELECT COUNT(*) AS count FROM reactions WHERE post_id = ? AND kind = ?'),

    coinByUserPost: db.prepare('SELECT amount FROM coins WHERE user_id = ? AND post_id = ?'),
    upsertCoin: db.prepare(
      `INSERT INTO coins (user_id, post_id, amount, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, post_id) DO UPDATE SET amount = amount + excluded.amount`,
    ),
    addCoins: db.prepare('UPDATE users SET coin_balance = coin_balance + ? WHERE id = ?'),
    spendCoins: db.prepare('UPDATE users SET coin_balance = coin_balance - ? WHERE id = ?'),
    totalCoins: db.prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM coins WHERE post_id = ?'),

    deleteBookmark: db.prepare('DELETE FROM bookmarks WHERE user_id = ? AND post_id = ?'),
    insertBookmark: db.prepare(
      'INSERT OR IGNORE INTO bookmarks (user_id, post_id, created_at) VALUES (?, ?, ?)',
    ),
    hasBookmark: db.prepare('SELECT 1 AS hit FROM bookmarks WHERE user_id = ? AND post_id = ?'),

    insertFollow: db.prepare(
      'INSERT OR IGNORE INTO follows (follower_id, followee_id, created_at) VALUES (?, ?, ?)',
    ),
    deleteFollow: db.prepare('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?'),
    hasFollow: db.prepare('SELECT 1 AS hit FROM follows WHERE follower_id = ? AND followee_id = ?'),
    followerCount: db.prepare('SELECT COUNT(*) AS count FROM follows WHERE followee_id = ?'),
    followingCount: db.prepare('SELECT COUNT(*) AS count FROM follows WHERE follower_id = ?'),
    listFollowing: db.prepare(
      `SELECT u.id, u.username, u.display_name, u.role, u.bio, u.avatar, f.created_at AS followed_at,
              (SELECT COUNT(*) FROM posts p WHERE p.user_id = u.id AND p.deleted = 0) AS post_count,
              (SELECT COUNT(*) FROM follows f2 WHERE f2.followee_id = u.id) AS follower_count
       FROM follows f JOIN users u ON u.id = f.followee_id
       WHERE f.follower_id = ? ORDER BY f.created_at DESC`,
    ),
    listFollowers: db.prepare(
      `SELECT u.id, u.username, u.display_name, u.role, u.bio, u.avatar, f.created_at AS followed_at,
              (SELECT COUNT(*) FROM posts p WHERE p.user_id = u.id AND p.deleted = 0) AS post_count,
              EXISTS (SELECT 1 FROM follows f2 WHERE f2.follower_id = ? AND f2.followee_id = u.id) AS viewer_follows
       FROM follows f JOIN users u ON u.id = f.follower_id
       WHERE f.followee_id = ? ORDER BY f.created_at DESC`,
    ),

    listCategories: db.prepare(
      `SELECT c.id, c.name, c.sort_order, c.created_at,
              (SELECT COUNT(*) FROM posts p WHERE p.category_id = c.id AND p.deleted = 0) AS post_count
       FROM profile_categories c WHERE c.user_id = ? ORDER BY c.sort_order ASC, c.id ASC`,
    ),
    categoryById: db.prepare('SELECT * FROM profile_categories WHERE id = ?'),
    categoryCount: db.prepare('SELECT COUNT(*) AS count FROM profile_categories WHERE user_id = ?'),
    categoryByName: db.prepare('SELECT id FROM profile_categories WHERE user_id = ? AND name = ?'),
    maxCategoryOrder: db.prepare(
      'SELECT COALESCE(MAX(sort_order), -1) AS max_order FROM profile_categories WHERE user_id = ?',
    ),
    insertCategory: db.prepare(
      'INSERT INTO profile_categories (user_id, name, sort_order, created_at) VALUES (?, ?, ?, ?)',
    ),
    renameCategory: db.prepare('UPDATE profile_categories SET name = ? WHERE id = ? AND user_id = ?'),
    deleteCategory: db.prepare('DELETE FROM profile_categories WHERE id = ? AND user_id = ?'),
    clearCategory: db.prepare('UPDATE posts SET category_id = NULL WHERE category_id = ?'),
    uncategorizedCount: db.prepare(
      'SELECT COUNT(*) AS count FROM posts WHERE user_id = ? AND deleted = 0 AND category_id IS NULL',
    ),

    setPostCategory: db.prepare('UPDATE posts SET category_id = ? WHERE id = ?'),
    setProfilePin: db.prepare('UPDATE posts SET profile_pinned = ?, profile_pinned_at = ? WHERE id = ?'),
    countProfilePinned: db.prepare(
      'SELECT COUNT(*) AS count FROM posts WHERE user_id = ? AND profile_pinned = 1 AND deleted = 0',
    ),

    insertRepost: db.prepare(
      'INSERT INTO reposts (post_id, user_id, comment, created_at) VALUES (?, ?, ?, ?)',
    ),
    deleteRepost: db.prepare('DELETE FROM reposts WHERE post_id = ? AND user_id = ?'),
    repostByUserPost: db.prepare('SELECT * FROM reposts WHERE post_id = ? AND user_id = ?'),
    countReposts: db.prepare('SELECT COUNT(*) AS count FROM reposts WHERE post_id = ?'),
    listReposters: db.prepare(
      `SELECT rp.id, rp.comment, rp.created_at, u.id AS user_id, u.username, u.display_name, u.role, u.avatar
       FROM reposts rp JOIN users u ON u.id = rp.user_id
       WHERE rp.post_id = ? ORDER BY rp.created_at DESC`,
    ),
    listRepostsByUser: db.prepare(
      `SELECT rp.id AS repost_id, rp.comment AS repost_comment, rp.created_at AS repost_created_at, p.id AS post_id
       FROM reposts rp JOIN posts p ON p.id = rp.post_id
       WHERE rp.user_id = ? AND p.deleted = 0 ORDER BY rp.created_at DESC LIMIT 50`,
    ),
    countRepostsByUser: db.prepare(
      `SELECT COUNT(*) AS count FROM reposts rp JOIN posts p ON p.id = rp.post_id
       WHERE rp.user_id = ? AND p.deleted = 0`,
    ),

    /* ---------------- 私信 ---------------- */
    insertMessage: db.prepare(
      'INSERT INTO messages (sender_id, recipient_id, content, read_at, created_at) VALUES (?, ?, ?, NULL, ?)',
    ),
    messageById: db.prepare('SELECT * FROM messages WHERE id = ?'),
    listThread: db.prepare(
      `SELECT m.id, m.sender_id, m.recipient_id, m.content, m.read_at, m.created_at,
              s.username AS sender_username, s.display_name AS sender_display, s.avatar AS sender_avatar
       FROM messages m JOIN users s ON s.id = m.sender_id
       WHERE (m.sender_id = ? AND m.recipient_id = ?) OR (m.sender_id = ? AND m.recipient_id = ?)
       ORDER BY m.created_at ASC LIMIT 500`,
    ),
    countMessagesInThread: db.prepare(
      `SELECT COUNT(*) AS count FROM messages
       WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)`,
    ),
    markThreadRead: db.prepare(
      'UPDATE messages SET read_at = ? WHERE recipient_id = ? AND sender_id = ? AND read_at IS NULL',
    ),
    unreadMessages: db.prepare('SELECT COUNT(*) AS count FROM messages WHERE recipient_id = ? AND read_at IS NULL'),
    unreadFromPeer: db.prepare(
      'SELECT COUNT(*) AS count FROM messages WHERE recipient_id = ? AND sender_id = ? AND read_at IS NULL',
    ),
    countSentToday: db.prepare(
      'SELECT COUNT(*) AS count FROM messages WHERE sender_id = ? AND recipient_id = ? AND created_at >= ?',
    ),
    firstSentToday: db.prepare(
      'SELECT created_at FROM messages WHERE sender_id = ? AND recipient_id = ? AND created_at >= ? ORDER BY created_at ASC LIMIT 1',
    ),
    listConversations: db.prepare(
      `WITH pairs AS (
         SELECT m.*, CASE WHEN m.sender_id = ? THEN m.recipient_id ELSE m.sender_id END AS peer_id
         FROM messages m
         WHERE m.sender_id = ? OR m.recipient_id = ?
       ),
       ranked AS (
         SELECT p.*, ROW_NUMBER() OVER (PARTITION BY p.peer_id ORDER BY p.created_at DESC, p.id DESC) AS rn
         FROM pairs p
       )
       SELECT r.peer_id, r.content, r.created_at, r.sender_id, r.read_at,
              u.username, u.display_name, u.role, u.avatar,
              (SELECT COUNT(*) FROM messages x
                WHERE x.recipient_id = ? AND x.sender_id = r.peer_id AND x.read_at IS NULL) AS unread
       FROM ranked r JOIN users u ON u.id = r.peer_id
       WHERE r.rn = 1 AND r.peer_id NOT IN (
         SELECT blocked_id FROM blocks WHERE blocker_id = ?
         UNION
         SELECT blocker_id FROM blocks WHERE blocked_id = ?
       )
       ORDER BY r.created_at DESC`,
    ),

    /* ---------------- 黑名单 ---------------- */
    insertBlock: db.prepare(
      'INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)',
    ),
    deleteBlock: db.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?'),
    hasBlock: db.prepare('SELECT 1 AS hit FROM blocks WHERE blocker_id = ? AND blocked_id = ?'),
    blockedEitherWay: db.prepare(
      'SELECT 1 AS hit FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?) LIMIT 1',
    ),
    listBlocks: db.prepare(
      `SELECT u.id, u.username, u.display_name, u.role, u.avatar, b.created_at AS blocked_at
       FROM blocks b JOIN users u ON u.id = b.blocked_id
       WHERE b.blocker_id = ? ORDER BY b.created_at DESC`,
    ),
    countBlocks: db.prepare('SELECT COUNT(*) AS count FROM blocks WHERE blocker_id = ?'),
    blockedByMe: db.prepare('SELECT 1 AS hit FROM blocks WHERE blocker_id = ? AND blocked_id = ?'),

    insertNotification: db.prepare(
      `INSERT INTO notifications (user_id, actor_id, type, post_id, reply_id, team_id, excerpt, read_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    ),
    hasUnreadNotification: db.prepare(
      `SELECT 1 AS hit FROM notifications
       WHERE user_id = ? AND actor_id IS ? AND type = ? AND post_id IS ? AND read_at IS NULL LIMIT 1`,
    ),
    listNotifications: db.prepare(
      `SELECT n.id, n.type, n.post_id, n.reply_id, n.team_id, n.excerpt, n.read_at, n.created_at,
              a.id AS actor_id, a.username AS actor_username, a.display_name AS actor_display, a.role AS actor_role, a.avatar AS actor_avatar,
              p.title AS post_title, p.deleted AS post_deleted,
              t.slug AS team_slug, t.name AS team_name, t.deleted AS team_deleted
       FROM notifications n
       LEFT JOIN users a ON a.id = n.actor_id
       LEFT JOIN posts p ON p.id = n.post_id
       LEFT JOIN teams t ON t.id = n.team_id
       WHERE n.user_id = ? AND (? = 0 OR n.read_at IS NULL)
       ORDER BY n.created_at DESC, n.id DESC
       LIMIT ? OFFSET ?`,
    ),
    countNotifications: db.prepare(
      'SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND (? = 0 OR read_at IS NULL)',
    ),
    markNotificationRead: db.prepare(
      'UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL',
    ),
    markAllRead: db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL'),
    deleteReadNotifications: db.prepare('DELETE FROM notifications WHERE user_id = ? AND read_at IS NOT NULL'),
  };

  const ANON = -1;

  function buildFilter({
    boardId,
    q,
    authorId,
    bookmarkedBy,
    followingBy,
    categoryId,
    uncategorized,
    includeHidden = false,
    hideBlockedFor = ANON,
  } = {}) {
    const where = ['p.deleted = 0'];
    const params = [];
    // 隐藏的文章默认对所有人不可见；管理员/作者查看时由调用方传 includeHidden
    if (!includeHidden) where.push('p.hidden = 0');
    // 拉黑过滤：被拉黑的人看不到我的文章，我也看不到 TA 的
    if (hideBlockedFor && hideBlockedFor !== ANON) {
      where.push(BLOCKED_AUTHOR_SQL);
      params.push(hideBlockedFor, hideBlockedFor);
    }
    if (boardId) {
      where.push('p.board_id = ?');
      params.push(boardId);
    }
    if (authorId) {
      where.push('p.user_id = ?');
      params.push(authorId);
    }
    if (categoryId) {
      where.push('p.category_id = ?');
      params.push(categoryId);
    } else if (uncategorized) {
      where.push('p.category_id IS NULL');
    }
    if (bookmarkedBy) {
      where.push('EXISTS (SELECT 1 FROM bookmarks bm WHERE bm.post_id = p.id AND bm.user_id = ?)');
      params.push(bookmarkedBy);
    }
    if (followingBy) {
      where.push('p.user_id IN (SELECT f.followee_id FROM follows f WHERE f.follower_id = ?)');
      params.push(followingBy);
    }
    if (q) {
      where.push('(p.title LIKE ? OR p.content LIKE ?)');
      params.push(`%${q}%`, `%${q}%`);
    }
    return { clause: where.join(' AND '), params };
  }

  return {
    raw: db,
    ANON,
    COIN_RULES,
    PROFILE_RULES,

    /* ---------------- 用户 ---------------- */
    userById: (id) => statements.userById.get(id) ?? null,
    userByUsername: (username) => statements.userByUsername.get(username) ?? null,

    createUser({ username, displayName, passwordHash, role = 'member', bio = '' }) {
      const info = statements.insertUser.run(
        username,
        displayName,
        passwordHash,
        role,
        bio,
        COIN_RULES.signupGrant,
        0,
        Date.now(),
      );
      return this.userById(Number(info.lastInsertRowid));
    },

    listUsers: () => statements.listUsers.all(),

    setUserBanned(id, banned) {
      statements.setBanned.run(banned ? 1 : 0, id);
    },

    /* ---------------- 角色与管理操作 ---------------- */
    /** 改角色；返回 {error} 或 {user}。站长不能被改成别的角色。 */
    setUserRole(id, role) {
      const user = this.userById(id);
      if (!user) return { error: 'user_not_found' };
      if (user.role === 'owner') return { error: 'owner_immutable' };
      if (!['admin', 'member'].includes(role)) return { error: 'bad_role' };
      statements.setRole.run(role, id);
      return { user: this.userById(id), changed: user.role !== role };
    },

    listStaff: () => statements.listStaff.all(),
    listSessionsOfUser: (userId) => statements.listSessionsOfUser.all(userId),

    /** 记录一条管理操作，后台可以看到审计轨迹 */
    logModeration({ actorId, action, targetType, targetId, targetLabel = '', reason = '' }) {
      statements.insertModerationLog.run(
        actorId ?? null,
        action,
        targetType,
        targetId,
        String(targetLabel).slice(0, 120),
        String(reason ?? '').slice(0, 200),
        Date.now(),
      );
    },

    listModerationLogs(limit = 30) {
      return statements.listModerationLogs.all(Math.min(Math.max(limit, 1), 100)).map((row) => ({
        id: row.id,
        action: row.action,
        targetType: row.target_type,
        targetId: row.target_id,
        targetLabel: row.target_label,
        reason: row.reason,
        createdAt: row.created_at,
        actor: row.actor_id
          ? {
              id: row.actor_id,
              username: row.actor_username,
              displayName: row.actor_display,
              role: row.actor_role,
            }
          : null,
      }));
    },

    userProfile: (username) => statements.userProfile.get(username) ?? null,

    /**
     * 读取用户钱包（余额就存在 users.coin_balance 上）。
     * 注意：已取消「每天补足」机制——余额只会在注册赠送、
     * 别人投币给你时增加，不会随时间自动回涨。
     * 列 coin_refresh_at 是历史遗留字段，现在只用于兼容旧库，不再读写。
     */
    wallet(userId) {
      return statements.userById.get(userId) ?? null;
    },

    stats() {
      return {
        users: Number(statements.countUsers.get().count),
        posts: Number(statements.countPostsAll.get().count),
        replies: Number(statements.countRepliesAll.get().count),
      };
    },

    /* ---------------- 会话 ---------------- */
    createSession(token, userId, ttlMs) {
      const now = Date.now();
      statements.insertSession.run(token, userId, now, now + ttlMs);
      return { token, userId, expiresAt: now + ttlMs };
    },
    sessionByToken: (token) => statements.sessionByToken.get(token) ?? null,
    touchSession: (token, expiresAt) => statements.touchSession.run(expiresAt, token),
    deleteSession: (token) => statements.deleteSession.run(token),
    purgeExpiredSessions: () => statements.purgeSessions.run(Date.now()),

    /* ---------------- 板块 ---------------- */
    listBoards: () => statements.listBoards.all(),
    boardBySlug: (slug) => statements.boardBySlug.get(slug) ?? null,
    boardById: (id) => statements.boardById.get(id) ?? null,

    /* ---------------- 帖子 ---------------- */
    listPosts(options = {}) {
      const { page = 1, perPage = 10, sort = 'latest', viewerId = ANON } = options;
      const { clause, params } = buildFilter(options);
      const orderBy = SORTS[sort] ?? SORTS.latest;
      const limit = Math.min(Math.max(perPage, 1), 50);
      const offset = (Math.max(page, 1) - 1) * limit;
      const sql = `SELECT ${POST_LIST_COLUMNS}
        FROM posts p
        JOIN boards b ON b.id = p.board_id
        JOIN users u ON u.id = p.user_id
        LEFT JOIN profile_categories pc ON pc.id = p.category_id
        WHERE ${clause}
        ORDER BY ${orderBy}
        LIMIT ? OFFSET ?`;
      const viewerParams = Array.from({ length: VIEWER_PARAM_COUNT }, () => viewerId);
      return db.prepare(sql).all(...viewerParams, ...params, limit, offset);
    },

    countPosts(options = {}) {
      const { clause, params } = buildFilter(options);
      const sql = `SELECT COUNT(*) AS count FROM posts p WHERE ${clause}`;
      return Number(db.prepare(sql).get(...params).count);
    },

    postById(id, viewerId = ANON) {
      const sql = `SELECT ${POST_FULL_COLUMNS}
        FROM posts p
        JOIN boards b ON b.id = p.board_id
        JOIN users u ON u.id = p.user_id
        LEFT JOIN profile_categories pc ON pc.id = p.category_id
        WHERE p.id = ? AND p.deleted = 0`;
      const viewerParams = Array.from({ length: VIEWER_PARAM_COUNT }, () => viewerId);
      return db.prepare(sql).get(...viewerParams, id) ?? null;
    },

    /** 内部用：不依赖浏览者上下文的最小帖子行（权限判断、通知用）。 */
    postRow(id) {
      return (
        db
          .prepare(
            'SELECT id, user_id, board_id, title, locked, deleted, hidden, hidden_reason FROM posts WHERE id = ?',
          )
          .get(id) ?? null
      );
    },

    createPost({ boardId, userId, title, content }) {
      const now = Date.now();
      const info = statements.insertPost.run(boardId, userId, title, content, now, now);
      return Number(info.lastInsertRowid);
    },

    updatePost({ id, boardId, title, content }) {
      statements.updatePost.run(title, content, boardId, Date.now(), id);
    },

    softDeletePost(id) {
      statements.softDeletePost.run(Date.now(), id);
    },

    /** 隐藏 / 取消隐藏（可逆的管理操作，和软删除区分开） */
    setPostHidden(postId, hidden, { byUserId = null, reason = '' } = {}) {
      statements.setHidden.run(
        hidden ? 1 : 0,
        hidden ? Date.now() : null,
        hidden ? byUserId : null,
        hidden ? String(reason ?? '').slice(0, 200) : '',
        postId,
      );
      return { hidden };
    },

    hiddenPostCount: () => Number(statements.countHiddenPosts.get().count),
    listHiddenPosts: (limit = 20) => statements.listHiddenPosts.all(limit),

    bumpViews: (id) => statements.bumpViews.run(id),

    /* ---------------- 回复 ---------------- */
    listReplies: (postId, viewerId = ANON) => statements.listReplies.all(postId, viewerId, viewerId, viewerId),
    replyById: (id) => statements.replyById.get(id) ?? null,
    countReplies: (postId) =>
      Number(
        db.prepare('SELECT COUNT(*) AS count FROM replies WHERE post_id = ? AND deleted = 0').get(postId)
          .count,
      ),

    createReply({ postId, userId, content }) {
      const info = statements.insertReply.run(postId, userId, content, Date.now());
      return Number(info.lastInsertRowid);
    },

    softDeleteReply: (id) => statements.softDeleteReply.run(id),

    /* ---------------- 私信 ---------------- */
    MESSAGE_RULES,

    /** 两个人之间是否互相关注（互关 = 可以无限私信） */
    areMutualFollowers(a, b) {
      return Boolean(this.isFollowing(a, b) && this.isFollowing(b, a));
    },

    /** 任一方关注了另一方就算「有关注关系」 */
    hasFollowRelation(a, b) {
      return Boolean(this.isFollowing(a, b) || this.isFollowing(b, a));
    },

    /** 今天（本地自然日）我已经给对方发了几条 + 最早那条的时间 */
    messagesSentToday(senderId, recipientId) {
      const dayStart = parseDay(todayString()).getTime();
      const count = Number(statements.countSentToday.get(senderId, recipientId, dayStart).count);
      const first = statements.firstSentToday.get(senderId, recipientId, dayStart);
      const nextDayStart = parseDay(addDays(todayString(), 1)).getTime();
      return { count, firstAt: first?.created_at ?? null, resetsAt: nextDayStart };
    },

    /**
     * 私信可用性：把「能不能发、为什么不能、今天还剩几条」一次算清楚。
     * @returns {{canSend: boolean, reason: string, message: string, mutual: boolean, followed: boolean,
     *            blockedByMe: boolean, blockedMe: boolean, remainingToday: number|null,
     *            dailyLimit: number|null, resetsAt: number|null, sentToday: number}}
     */
    messageAvailability(senderId, recipient) {
      const dailyLimit = MESSAGE_RULES.oneWayDailyLimit;
      const blockedByMe = Boolean(statements.blockedByMe.get(senderId, recipient.id));
      const blockedMe = Boolean(statements.blockedByMe.get(recipient.id, senderId));
      const mutual = this.areMutualFollowers(senderId, recipient.id);
      const followed = this.hasFollowRelation(senderId, recipient.id);
      const sent = this.messagesSentToday(senderId, recipient.id);

      const base = {
        mutual,
        followed,
        blockedByMe,
        blockedMe,
        sentToday: sent.count,
        dailyLimit,
        resetsAt: sent.resetsAt,
        remainingToday: mutual ? null : Math.max(0, dailyLimit - sent.count),
      };

      if (recipient.id === senderId) {
        return { ...base, canSend: false, reason: 'self', message: '不能给自己发私信' };
      }
      if (blockedByMe) {
        return { ...base, canSend: false, reason: 'blocked_by_me', message: '你已把对方拉黑，先解除黑名单才能私信' };
      }
      if (blockedMe) {
        return { ...base, canSend: false, reason: 'blocked_me', message: '对方已将你拉黑，无法发送私信' };
      }
      if (!followed) {
        return {
          ...base,
          canSend: false,
          reason: 'no_relation',
          message: '先关注对方（或等对方关注你）才能私信',
        };
      }
      if (!mutual && sent.count >= dailyLimit) {
        return {
          ...base,
          canSend: false,
          reason: 'daily_limit',
          message: `单方面关注每天只能发 ${dailyLimit} 条私信，互相关注后不限量。明天再来或等对方回关`,
        };
      }
      return { ...base, canSend: true, reason: 'ok', message: mutual ? '互相关注：不限量' : `单方面关注：每天 ${dailyLimit} 条` };
    },

    createMessage({ senderId, recipientId, content }) {
      const info = statements.insertMessage.run(senderId, recipientId, content, Date.now());
      return this.messageById(Number(info.lastInsertRowid));
    },

    messageById: (id) => statements.messageById.get(id) ?? null,

    listThread(userId, peerId) {
      return statements.listThread.all(userId, peerId, peerId, userId);
    },

    countThread(userId, peerId) {
      return Number(statements.countMessagesInThread.get(userId, peerId, peerId, userId).count);
    },

    markThreadRead(userId, peerId) {
      return Number(statements.markThreadRead.run(Date.now(), userId, peerId).changes ?? 0);
    },

    unreadMessageCount: (userId) => Number(statements.unreadMessages.get(userId).count),
    unreadFromPeer: (userId, peerId) => Number(statements.unreadFromPeer.get(userId, peerId).count),

    /** 会话列表：每个对端只取最后一条，并带上未读数（已排除双向拉黑的人） */
    listConversations(userId) {
      return statements.listConversations.all(userId, userId, userId, userId, userId, userId);
    },

    /* ---------------- 黑名单 ---------------- */
    blockUser(blockerId, blockedId) {
      if (blockerId === blockedId) return { error: 'self_block' };
      const changed = Number(statements.insertBlock.run(blockerId, blockedId, Date.now()).changes ?? 0);
      // 拉黑会同时解除双向关注，避免「拉黑了却还互相关注」
      this.setFollow(blockerId, blockedId, false);
      this.setFollow(blockedId, blockerId, false);
      return { blocked: true, changed: changed > 0 };
    },

    unblockUser(blockerId, blockedId) {
      const changed = Number(statements.deleteBlock.run(blockerId, blockedId).changes ?? 0);
      return { blocked: false, changed: changed > 0 };
    },

    isBlocked(blockerId, blockedId) {
      return Boolean(statements.hasBlock.get(blockerId, blockedId));
    },

    /** 任意一方拉黑了另一方 */
    blocksBetween(a, b) {
      if (!a || !b) return false;
      return Boolean(statements.blockedEitherWay.get(a, b, b, a));
    },

    listBlocks: (userId) => statements.listBlocks.all(userId),
    blockCount: (userId) => Number(statements.countBlocks.get(userId).count),

    /* ---------------- 评价：赞 / 踩 ---------------- */
    reactionCounts(postId) {
      return {
        likeCount: Number(statements.countReaction.get(postId, 'like').count),
        dislikeCount: Number(statements.countReaction.get(postId, 'dislike').count),
      };
    },

    /** 同一用户对同一帖子只能赞或踩；重复点击同一个则取消。 */
    setReaction(userId, postId, kind) {
      const current = statements.reactionByUserPost.get(userId, postId)?.kind ?? null;
      let next = kind;
      if (current === kind) {
        statements.deleteReaction.run(userId, postId);
        next = null;
      } else {
        statements.upsertReaction.run(userId, postId, kind, Date.now());
      }
      return {
        liked: next === 'like',
        disliked: next === 'dislike',
        changed: current !== next,
        previous: current,
        ...this.reactionCounts(postId),
      };
    },

    /* ---------------- 投币 ---------------- */
    coinState(userId, postId) {
      return {
        balance: Number(this.wallet(userId)?.coin_balance ?? 0),
        myCoins: Number(statements.coinByUserPost.get(userId, postId)?.amount ?? 0),
        coinCount: Number(statements.totalCoins.get(postId).total),
        perPostLimit: COIN_RULES.perPostLimit,
        signupGrant: COIN_RULES.signupGrant,
      };
    },

    /**
     * 投币：单帖每人上限 2 币，余额不足则拒绝（没有每日补足，币要靠别人的投币赚），
     * 投出的币会转进作者账户。
     * @returns {{error?: string} & Record<string, unknown>}
     */
    giveCoin({ userId, postId, amount = 1 }) {
      const user = this.wallet(userId);
      if (!user) return { error: 'user_not_found' };
      const post = this.postRow(postId);
      if (!post || post.deleted) return { error: 'post_not_found' };
      if (post.user_id === userId) return { error: 'self_coin' };

      const mine = Number(statements.coinByUserPost.get(userId, postId)?.amount ?? 0);
      const remaining = COIN_RULES.perPostLimit - mine;
      if (remaining <= 0) {
        return { error: 'per_post_limit', myCoins: mine, ...this.coinState(userId, postId) };
      }
      const give = Math.min(Math.max(1, Math.floor(amount)), remaining);
      if (Number(user.coin_balance) < give) {
        return { error: 'insufficient_coins', ...this.coinState(userId, postId) };
      }

      db.exec('BEGIN IMMEDIATE');
      try {
        statements.upsertCoin.run(userId, postId, give, Date.now());
        statements.spendCoins.run(give, userId);
        statements.addCoins.run(give, post.user_id);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return { given: give, authorId: post.user_id, ...this.coinState(userId, postId) };
    },

    /* ---------------- 收藏 ---------------- */
    toggleBookmark(userId, postId) {
      if (statements.hasBookmark.get(userId, postId)) {
        statements.deleteBookmark.run(userId, postId);
      } else {
        statements.insertBookmark.run(userId, postId, Date.now());
      }
      return {
        bookmarked: Boolean(statements.hasBookmark.get(userId, postId)),
        bookmarkCount: Number(
          db.prepare('SELECT COUNT(*) AS count FROM bookmarks WHERE post_id = ?').get(postId).count,
        ),
      };
    },

    /* ---------------- 关注 ---------------- */
    isFollowing: (followerId, followeeId) =>
      Boolean(followerId && followeeId && statements.hasFollow.get(followerId, followeeId)),

    followCounts(userId) {
      return {
        followerCount: Number(statements.followerCount.get(userId).count),
        followingCount: Number(statements.followingCount.get(userId).count),
      };
    },

    /** 直接设置关注关系（拉黑时用来解除双向关注） */
    setFollow(followerId, followeeId, following) {
      if (followerId === followeeId) return false;
      const has = Boolean(statements.hasFollow.get(followerId, followeeId));
      if (following === has) return false;
      if (following) statements.insertFollow.run(followerId, followeeId, Date.now());
      else statements.deleteFollow.run(followerId, followeeId);
      return true;
    },

    toggleFollow(followerId, followeeId) {
      if (followerId === followeeId) return { error: 'self_follow' };
      if (!this.userById(followeeId)) return { error: 'user_not_found' };
      // 任一方拉黑就不能关注
      if (this.isBlocked(followerId, followeeId)) return { error: 'blocked_by_me' };
      if (this.isBlocked(followeeId, followerId)) return { error: 'blocked_me' };
      const following = Boolean(statements.hasFollow.get(followerId, followeeId));
      if (following) statements.deleteFollow.run(followerId, followeeId);
      else statements.insertFollow.run(followerId, followeeId, Date.now());
      // 注意：计数字段要放在后面展开，否则会覆盖 following 布尔值
      return { ...this.followCounts(followeeId), following: !following };
    },

    listFollowing: (userId) => statements.listFollowing.all(userId),
    listFollowers: (userId, viewerId = ANON) => statements.listFollowers.all(viewerId, userId),

    /* ---------------- 通知 ---------------- */
    /**
     * 写一条通知。规则：
     *  - 不给自己发通知；
     *  - 默认「同一个人对同一个对象的同类未读通知只保留一条」（防止反复点赞刷屏）；
     *    团队公告这类「每一次都值得单独提醒」的场景传 dedupe: false。
     *  - teamId 让通知能指回团队（前端据此跳到团队主页）。
     */
    createNotification({
      userId,
      actorId = null,
      type,
      postId = null,
      replyId = null,
      teamId = null,
      excerpt = '',
      dedupe = true,
    }) {
      if (!userId) return null;
      if (actorId && actorId === userId) return null;
      if (dedupe && statements.hasUnreadNotification.get(userId, actorId, type, postId)) return null;
      const info = statements.insertNotification.run(
        userId,
        actorId,
        type,
        postId,
        replyId,
        teamId,
        String(excerpt ?? '').slice(0, 200),
        Date.now(),
      );
      return Number(info.lastInsertRowid);
    },

    listNotifications({ userId, page = 1, perPage = 20, unreadOnly = false }) {
      const limit = Math.min(Math.max(perPage, 1), 50);
      const offset = (Math.max(page, 1) - 1) * limit;
      return statements.listNotifications.all(userId, unreadOnly ? 1 : 0, limit, offset);
    },

    countNotifications: (userId, unreadOnly = false) =>
      Number(statements.countNotifications.get(userId, unreadOnly ? 1 : 0).count),

    unreadCount: (userId) => Number(statements.countNotifications.get(userId, 1).count),

    markNotificationRead(userId, id) {
      statements.markNotificationRead.run(Date.now(), id, userId);
      return { unread: this.unreadCount(userId) };
    },

    markAllNotificationsRead(userId) {
      statements.markAllRead.run(Date.now(), userId);
      return { unread: 0 };
    },

    clearReadNotifications(userId) {
      statements.deleteReadNotifications.run(userId);
    },

    /* ---------------- 个人主页分类 / 置顶 ---------------- */
    listProfileCategories: (userId) => statements.listCategories.all(userId),
    profileCategoryCount: (userId) => Number(statements.categoryCount.get(userId).count),
    profileCategoryById: (id) => statements.categoryById.get(id) ?? null,
    uncategorizedCount: (userId) => Number(statements.uncategorizedCount.get(userId).count),

    createProfileCategory(userId, name) {
      if (this.profileCategoryCount(userId) >= PROFILE_RULES.categoryLimit) return { error: 'category_limit' };
      if (statements.categoryByName.get(userId, name)) return { error: 'category_exists' };
      const maxOrder = Number(statements.maxCategoryOrder.get(userId).max_order);
      const info = statements.insertCategory.run(userId, name, maxOrder + 1, Date.now());
      return { category: this.profileCategoryById(Number(info.lastInsertRowid)) };
    },

    renameProfileCategory(userId, id, name) {
      const category = this.profileCategoryById(id);
      if (!category || category.user_id !== userId) return { error: 'not_found' };
      const clash = db
        .prepare('SELECT id FROM profile_categories WHERE user_id = ? AND name = ? AND id <> ?')
        .get(userId, name, id);
      if (clash) return { error: 'category_exists' };
      statements.renameCategory.run(name, id, userId);
      return { category: this.profileCategoryById(id) };
    },

    deleteProfileCategory(userId, id) {
      const category = this.profileCategoryById(id);
      if (!category || category.user_id !== userId) return { error: 'not_found' };
      db.exec('BEGIN IMMEDIATE');
      try {
        statements.clearCategory.run(id);
        statements.deleteCategory.run(id, userId);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return { deleted: true };
    },

    profilePinCount: (userId) => Number(statements.countProfilePinned.get(userId).count),
    profilePinLimit: () => PROFILE_RULES.pinLimit,
    profileCategoryLimit: () => PROFILE_RULES.categoryLimit,
    setPostCategory: (postId, categoryId) => statements.setPostCategory.run(categoryId, postId),
    setProfilePin: (postId, pinned) => statements.setProfilePin.run(pinned ? 1 : 0, pinned ? Date.now() : null, postId),

    /* ---------------- 转发 ---------------- */
    repostByUser: (postId, userId) => statements.repostByUserPost.get(postId, userId) ?? null,
    repostCount: (postId) => Number(statements.countReposts.get(postId).count),
    listReposters: (postId) => statements.listReposters.all(postId),
    repostCountByUser: (userId) => Number(statements.countRepostsByUser.get(userId).count),

    /** 转发（同一用户对同一篇只保留一条，重复转发只更新评论）。 */
    createRepost({ postId, userId, comment = '' }) {
      const existing = statements.repostByUserPost.get(postId, userId);
      if (existing) {
        db.prepare('UPDATE reposts SET comment = ?, created_at = ? WHERE id = ?').run(comment, Date.now(), existing.id);
      } else {
        statements.insertRepost.run(postId, userId, comment, Date.now());
      }
      return {
        reposted: true,
        updated: Boolean(existing),
        repostCount: this.repostCount(postId),
        comment,
      };
    },

    deleteRepost(postId, userId) {
      const existing = statements.repostByUserPost.get(postId, userId);
      if (!existing) return { error: 'not_reposted' };
      statements.deleteRepost.run(postId, userId);
      return { reposted: false, repostCount: this.repostCount(postId) };
    },

    /** 某个用户转发过的文章（按转发时间倒序），带上 TA 的转发语。 */
    listRepostedPosts(userId, viewerId = ANON) {
      const reposts = statements.listRepostsByUser.all(userId);
      if (!reposts.length) return [];
      const byId = new Map(reposts.map((row) => [row.post_id, row]));
      const rows = this.listPostsByIds([...byId.keys()], viewerId);
      const order = new Map(reposts.map((row, index) => [row.post_id, index]));
      return rows
        .sort((a, b) => order.get(a.id) - order.get(b.id))
        .map((row) => {
          const meta = byId.get(row.id);
          if (!meta) return null;
          return {
            ...row,
            repost: {
              id: meta.repost_id,
              comment: meta.repost_comment,
              createdAt: meta.repost_created_at,
              by: userId,
            },
          };
        })
        .filter(Boolean);
    },

    /** 按 id 批量取帖子（保持 POST_*_COLUMNS 的口径一致）。 */
    listPostsByIds(ids, viewerId = ANON) {
      if (!ids.length) return [];
      const placeholders = ids.map(() => '?').join(', ');
      const hideBlocked = viewerId !== ANON;
      const sql = `SELECT ${POST_LIST_COLUMNS}
        FROM posts p
        JOIN boards b ON b.id = p.board_id
        JOIN users u ON u.id = p.user_id
        LEFT JOIN profile_categories pc ON pc.id = p.category_id
        WHERE p.deleted = 0 AND p.hidden = 0 AND p.id IN (${placeholders})
          ${hideBlocked ? `AND ${BLOCKED_AUTHOR_SQL}` : ''}`;
      const viewerParams = Array.from({ length: VIEWER_PARAM_COUNT }, () => viewerId);
      const blockParams = hideBlocked ? [viewerId, viewerId] : [];
      // 占位符在 SQL 文本里的顺序是：6 个浏览者状态列 → p.id IN (...) → 拉黑过滤的两个 ?，
      // 所以 ids 必须排在 blockParams 前面，否则 p.id IN (?) 会绑到 viewerId 上，
      // 查出来的是「浏览者自己的帖子」。
      return db.prepare(sql).all(...viewerParams, ...ids, ...blockParams);
    },

    /* ---------------- 账号设置 ---------------- */
    updateProfile(userId, { displayName, bio }) {
      statements.updateProfile.run(displayName, bio, userId);
      return this.userById(userId);
    },

    updatePassword(userId, passwordHash) {
      statements.updatePassword.run(passwordHash, userId);
    },

    /** 头像存的是字符串：`emoji:字符:色相` / `file:/avatars/xxx.png` / ''（默认首字母） */
    updateAvatar(userId, avatar) {
      statements.updateAvatar.run(String(avatar ?? ''), userId);
      return this.userById(userId);
    },

    deleteOtherSessions(userId, keepToken) {
      const info = statements.deleteOtherSessions.run(userId, keepToken ?? '');
      return Number(info.changes ?? 0);
    },

    /* ---------------- 后台 ---------------- */
    adminStats() {
      const base = this.stats();
      const banned = Number(db.prepare('SELECT COUNT(*) AS count FROM users WHERE banned = 1').get().count);
      const today = Date.now() - 24 * 3600 * 1000;
      const postsToday = Number(
        db.prepare('SELECT COUNT(*) AS count FROM posts WHERE deleted = 0 AND created_at >= ?').get(today)
          .count,
      );
      const repliesToday = Number(
        db.prepare('SELECT COUNT(*) AS count FROM replies WHERE deleted = 0 AND created_at >= ?').get(today)
          .count,
      );
      const reactions = Number(db.prepare('SELECT COUNT(*) AS count FROM reactions').get().count);
      const coins = Number(db.prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM coins').get().total);
      const follows = Number(db.prepare('SELECT COUNT(*) AS count FROM follows').get().count);
      const bookmarks = Number(db.prepare('SELECT COUNT(*) AS count FROM bookmarks').get().count);
      const hiddenPosts = Number(statements.countHiddenPosts.get().count);
      const staff = Number(db.prepare("SELECT COUNT(*) AS count FROM users WHERE role IN ('owner', 'admin')").get().count);
      return {
        ...base,
        banned,
        postsToday,
        repliesToday,
        reactions,
        coins,
        follows,
        bookmarks,
        hiddenPosts,
        staff,
      };
    },

    recentPosts(limit = 8) {
      return db
        .prepare(
          `SELECT p.id, p.title, p.created_at, p.views, p.hidden,
                  u.display_name AS author_display, b.name AS board_name
           FROM posts p JOIN users u ON u.id = p.user_id JOIN boards b ON b.id = p.board_id
           WHERE p.deleted = 0 ORDER BY p.created_at DESC LIMIT ?`,
        )
        .all(limit);
    },

    hotPosts(limit = 5) {
      return db
        .prepare(
          `SELECT p.id, p.title, p.created_at,
                  (SELECT COUNT(*) FROM replies r WHERE r.post_id = p.id AND r.deleted = 0) AS reply_count,
                  (SELECT COUNT(*) FROM reactions rx WHERE rx.post_id = p.id AND rx.kind = 'like') AS like_count,
                  (SELECT COALESCE(SUM(c.amount), 0) FROM coins c WHERE c.post_id = p.id) AS coin_count
           FROM posts p WHERE p.deleted = 0 AND p.hidden = 0
           ORDER BY (like_count * 4 + coin_count * 5) DESC, p.created_at DESC LIMIT ?`,
        )
        .all(limit);
    },
  };
}
