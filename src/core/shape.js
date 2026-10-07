// 搬运自 src/server.js 的固定行区间（预铺骨架，逐字未改），见 docs/tools/extract-server-modules.mjs。
import { ensure, ok } from './http.js';
import { store } from './store.js';
import { markdownToPlainText, renderMarkdown } from '../markdown.js';

/* ------------------------------------------------------------------ */
/* 序列化                                                              */
/* ------------------------------------------------------------------ */

const shapeUser = (row) =>
  row && {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    bio: row.bio ?? '',
    avatar: row.avatar ?? '',
    banned: Boolean(row.banned),
    createdAt: row.created_at,
  };

const shapeAuthor = (row) => ({
  id: row.author_id,
  username: row.author_username,
  displayName: row.author_display,
  role: row.author_role,
  avatar: row.author_avatar ?? '',
});

function shapePostListRow(row) {
  return {
    id: row.id,
    title: row.title,
    excerpt: markdownToPlainText(row.content_head, 150),
    board: { id: row.board_id, slug: row.board_slug, name: row.board_name, icon: row.board_icon },
    author: shapeAuthor(row),
    category: row.category_id ? { id: row.category_id, name: row.category_name } : null,
    profilePinned: Boolean(row.profile_pinned),
    profilePinnedAt: row.profile_pinned_at ?? null,
    views: row.views,
    replyCount: row.reply_count,
    likeCount: row.like_count,
    dislikeCount: row.dislike_count,
    bookmarkCount: row.bookmark_count,
    repostCount: row.repost_count ?? 0,
    liked: Boolean(row.liked),
    disliked: Boolean(row.disliked),
    bookmarked: Boolean(row.bookmarked),
    reposted: Boolean(row.reposted),
    authorFollowed: Boolean(row.author_followed),
    hidden: Boolean(row.hidden),
    hiddenAt: row.hidden_at ?? null,
    hiddenReason: row.hidden_reason ?? '',
    hiddenBy: row.hidden_by ?? null,
    pinned: Boolean(row.pinned),
    locked: Boolean(row.locked),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActiveAt: row.last_active_at,
  };
}

const shapePostDetail = (row) => ({
  ...shapePostListRow({ ...row, content_head: row.content }),
  content: row.content,
  contentHtml: renderMarkdown(row.content),
  excerpt: markdownToPlainText(row.content, 150),
});

const shapeReply = (row) => ({
  id: row.id,
  content: row.content,
  contentHtml: renderMarkdown(row.content),
  createdAt: row.created_at,
  author: {
    id: row.user_id,
    username: row.author_username,
    displayName: row.author_display,
    role: row.author_role,
    avatar: row.author_avatar ?? '',
    banned: Boolean(row.author_banned),
  },
});

const shapeNotification = (row) => ({
  id: row.id,
  type: row.type,
  excerpt: row.excerpt,
  read: Boolean(row.read_at),
  createdAt: row.created_at,
  post: row.post_id ? { id: row.post_id, title: row.post_title, deleted: Boolean(row.post_deleted) } : null,
  // 团队公告一类的通知指向团队；团队被解散后 slug 还在，前端点进去会看到「不存在或已解散」。
  team: row.team_id ? { id: row.team_id, slug: row.team_slug, name: row.team_name, deleted: Boolean(row.team_deleted) } : null,
  // 「有人回复了你的动态」指向那条动态。只给 id：动态的正文/可见范围要另拉一次
  // （列表页 20 条通知不该顺带 20 次 feed 查询），前端点进去就是 `#/feed`。
  feedItemId: row.feed_item_id == null ? null : Number(row.feed_item_id),
  actor: row.actor_id
    ? {
        id: row.actor_id,
        username: row.actor_username,
        displayName: row.actor_display,
        role: row.actor_role,
        avatar: row.actor_avatar ?? '',
      }
    : null,
});

const shapePerson = (row) => ({
  id: row.id,
  username: row.username,
  displayName: row.display_name,
  role: row.role,
  bio: row.bio ?? '',
  avatar: row.avatar ?? '',
  followedAt: row.followed_at ?? null,
  blockedAt: row.blocked_at ?? null,
  postCount: row.post_count === undefined ? null : Number(row.post_count),
  followerCount: row.follower_count === undefined ? null : Number(row.follower_count),
  viewerFollows: row.viewer_follows === undefined ? undefined : Boolean(row.viewer_follows),
});

const shapeMessage = (row) => ({
  id: row.id,
  content: row.content,
  createdAt: row.created_at,
  read: Boolean(row.read_at),
  senderId: row.sender_id,
  recipientId: row.recipient_id,
});

const shapeConversation = (row, viewerId) => ({
  peer: {
    id: row.peer_id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    avatar: row.avatar ?? '',
  },
  lastMessage: {
    content: row.content,
    createdAt: row.created_at,
    mine: row.sender_id === viewerId,
    read: Boolean(row.read_at),
  },
  unread: Number(row.unread ?? 0),
});

const shapeProfile = (row, extra = {}) => ({
  id: row.id,
  username: row.username,
  displayName: row.display_name,
  role: row.role,
  bio: row.bio ?? '',
  avatar: row.avatar ?? '',
  banned: Boolean(row.banned),
  createdAt: row.created_at,
  postCount: Number(row.post_count ?? 0),
  replyCount: Number(row.reply_count ?? 0),
  followerCount: Number(row.follower_count ?? 0),
  followingCount: Number(row.following_count ?? 0),
  likesReceived: Number(row.likes_received ?? 0),
  dislikesReceived: Number(row.dislikes_received ?? 0),
  bookmarkCount: Number(row.bookmark_count ?? 0),
  ...extra,
});

/* ------------------------------------------------------------------ */
/* 通知辅助                                                            */
/* ------------------------------------------------------------------ */

/** 从 Markdown 正文里抓出 @username 形式的提及。 */
function collectMentions(content) {
  const names = new Set();
  for (const match of String(content ?? '').matchAll(/@([A-Za-z0-9_]{3,20})/g)) {
    names.add(match[1]);
  }
  return [...names];
}

/**
 * @param {object} args
 * @param {(userId: number) => boolean} [args.visibleTo]
 *   可选：判断被 @ 的人**能不能看见这条内容**。不传 = 一律通知。
 *   帖子和回复本来就是公开的，所以那边不传；动态有 private / followers / team 三档
 *   可见范围，而通知的 `excerpt` 是正文前 60 字 —— 不做这层过滤的话，
 *   「只给我自己看」的动态里 @ 谁，谁就在通知中心读到了那 60 字。
 */
function notifyMentions({ content, actorId, postId = null, replyId = null, visibleTo }) {
  for (const username of collectMentions(content)) {
    const mentioned = store.userByUsername(username);
    if (!mentioned || mentioned.id === actorId) continue;
    if (typeof visibleTo === 'function' && !visibleTo(mentioned.id)) continue;
    store.createNotification({
      userId: mentioned.id,
      actorId,
      type: 'mention',
      postId,
      replyId,
      excerpt: markdownToPlainText(content, 60),
    });
  }
}

/** 转发者（带 TA 的转发语） */
const shapeReposter = (row) => ({
  repostId: row.id,
  comment: row.comment ?? '',
  createdAt: row.created_at,
  user: {
    id: row.user_id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    avatar: row.avatar ?? '',
  },
});

const shapeCategory = (row) => ({
  id: row.id,
  name: row.name,
  sortOrder: row.sort_order ?? 0,
  postCount: Number(row.post_count ?? 0),
});

/** 校验分类归属：只能把文章放进自己的分类。null 表示「不分类」。 */
function resolveOwnCategory(user, value) {
  if (value === null || value === undefined || value === '') return null;
  const categoryId = Number(value);
  const category = store.profileCategoryById(categoryId);
  ensure(category && category.user_id === user.id, 400, 'bad_category', '分类不存在或不属于你');
  return categoryId;
}

/** 个人主页置顶有数量上限。 */
function assertPinAllowed(user, { alreadyPinned = false } = {}) {
  if (alreadyPinned) return;
  ensure(
    store.profilePinCount(user.id) < store.profilePinLimit(),
    400,
    'pin_limit',
    `个人主页最多置顶 ${store.profilePinLimit()} 篇文章`,
  );
}

/* ------------------------------------------------------------------ */
/* 路由表                                                              */
/* ------------------------------------------------------------------ */
export {
  shapeUser,
  shapeAuthor,
  shapePostListRow,
  shapePostDetail,
  shapeReply,
  shapeNotification,
  shapePerson,
  shapeMessage,
  shapeConversation,
  shapeProfile,
  collectMentions,
  notifyMentions,
  shapeReposter,
  shapeCategory,
  resolveOwnCategory,
  assertPinAllowed,
};
