import http from 'node:http';
import { mkdirSync } from 'node:fs';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { openDatabase } from './db.js';
import { createStore } from './store.js';
import { hashPassword, verifyPassword } from './password.js';
import { renderMarkdown, markdownToPlainText } from './markdown.js';
// AI reading assistant: self-contained mount layer. It short-circuits only
// /api/ai/* and hands every other request back to this file's handler (below).
import { mountForumAi, forumAiStatus } from '../forum-ai/src/mount.mjs';
import { mountNoteAgent, noteAgentStatus } from '../note-agent/src/mount.mjs';
// Note studio: the academic note subsystem. `./notes.js` is the only glue layer —
// it registers the package's own /api/notes* routes *plus* this forum's rules
// (one folder per user, private by default, a public square).
import { createNotes, defaultNotesDir } from './notes.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..');
const PUBLIC_DIR = join(ROOT, 'public');
const DB_FILE = process.env.DB_FILE || join(ROOT, 'data', 'forum.db');
/** 上传头像的存放目录：默认跟数据库放一起（方便整体备份/迁移），测试可用 AVATAR_DIR 隔离 */
const AVATAR_DIR =
  process.env.AVATAR_DIR ||
  (DB_FILE === ':memory:' ? join(ROOT, 'data', 'avatars') : join(dirname(DB_FILE), 'avatars'));
const AVATAR_URL_PREFIX = '/avatars/';
const MAX_AVATAR_BYTES = 256 * 1024;
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';

const SESSION_COOKIE = 'forum_sid';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const ANON = -1;

/* ------------------------------------------------------------------ */
/* 基础设施                                                            */
/* ------------------------------------------------------------------ */

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function ensure(condition, status, code, message) {
  if (!condition) throw new HttpError(status, code, message);
}

function res_(ctx) {
  return ctx.res;
}

function sendJson(res, status, payload, headers = {}) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

const ok = (res, data, headers) => sendJson(res, 200, { ok: true, data }, headers);

async function readJsonBody(req) {
  const limit = 512 * 1024;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    ensure(size <= limit, 413, 'payload_too_large', '提交的内容太长了');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    ensure(
      parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed),
      400,
      'invalid_body',
      '请求体格式不正确',
    );
    return parsed;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'invalid_json', '请求体不是合法的 JSON');
  }
}

function parseCookies(header) {
  const cookies = new Map();
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    cookies.set(part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim()));
  }
  return cookies;
}

/* ---------------- 轻量速率限制（内存桶） ---------------- */
const buckets = new Map();
function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  bucket.count += 1;
  ensure(bucket.count <= limit, 429, 'rate_limited', '操作有点频繁，请稍后再试');
}

/* ---------------- 输入校验 ---------------- */
function field(value, { name = '', min = 0, max = 100000, pattern, label }) {
  ensure(typeof value === 'string', 400, 'invalid_field', `${label}格式不正确`);
  const text = value.replace(/\r\n?/g, '\n').trim();
  ensure(text.length >= min, 400, 'invalid_field', `${label}至少需要 ${min} 个字符`);
  ensure(text.length <= max, 400, 'invalid_field', `${label}不能超过 ${max} 个字符`);
  if (pattern) ensure(pattern.test(text), 400, 'invalid_field', `${label}${name}`);
  return text;
}

/* ------------------------------------------------------------------ */
/* 数据层                                                              */
/* ------------------------------------------------------------------ */

const { db, seeded, notifications: backfilledNotifications } = openDatabase(DB_FILE);
const store = createStore(db);
store.purgeExpiredSessions();
setInterval(() => {
  store.purgeExpiredSessions();
  buckets.clear();
}, 3600 * 1000).unref();

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
    ...(row.coin_balance === undefined ? {} : { coinBalance: Number(row.coin_balance) }),
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
    coinCount: row.coin_count,
    bookmarkCount: row.bookmark_count,
    repostCount: row.repost_count ?? 0,
    myCoins: Number(row.my_coins ?? 0),
    liked: Boolean(row.liked),
    disliked: Boolean(row.disliked),
    bookmarked: Boolean(row.bookmarked),
    reposted: Boolean(row.reposted),
    authorFollowed: Boolean(row.author_followed),
    hidden: Boolean(row.hidden),
    hiddenAt: row.hidden_at ?? null,
    hiddenReason: row.hidden_reason ?? '',
    hiddenBy: row.hidden_by ?? null,
    baseScore: row.base_score === undefined ? undefined : Number(Number(row.base_score).toFixed(2)),
    valueScore: row.value_score === undefined ? undefined : Number(Number(row.value_score).toFixed(2)),
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
  coinBalance: Number(row.coin_balance ?? 0),
  postCount: Number(row.post_count ?? 0),
  replyCount: Number(row.reply_count ?? 0),
  followerCount: Number(row.follower_count ?? 0),
  followingCount: Number(row.following_count ?? 0),
  likesReceived: Number(row.likes_received ?? 0),
  dislikesReceived: Number(row.dislikes_received ?? 0),
  coinsReceived: Number(row.coins_received ?? 0),
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

function notifyMentions({ content, actorId, postId = null, replyId = null }) {  for (const username of collectMentions(content)) {
    const mentioned = store.userByUsername(username);
    if (!mentioned || mentioned.id === actorId) continue;
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

/**
 * 计算「当前浏览者能不能给这篇帖子投币」，并把原因和提示文案一起返回。
 * 前端只负责展示，规则永远以服务端为准，避免两边逻辑不一致。
 */
function coinAvailability(post, viewer) {
  const rules = store.COIN_RULES;
  const base = {
    perPostLimit: rules.perPostLimit,
    signupGrant: rules.signupGrant,
    myCoins: 0,
    balance: 0,
  };

  if (!viewer) {
    return { ...base, available: false, reason: 'anonymous', message: '登录后才能投币' };
  }

  const state = store.coinState(viewer.id, post.id);
  const common = { ...base, myCoins: state.myCoins, balance: state.balance };

  if (post.author_id === viewer.id) {
    return {
      ...common,
      available: false,
      reason: 'self',
      message: '不能给自己的帖子投币，把币留给别人吧 🙌',
    };
  }
  if (state.myCoins >= rules.perPostLimit) {
    return {
      ...common,
      available: false,
      reason: 'per_post_limit',
      message: `这篇帖子你已经投满 ${rules.perPostLimit} 币了`,
    };
  }
  if (state.balance <= 0) {
    return {
      ...common,
      available: false,
      reason: 'insufficient_coins',
      message: '币不够了：去「每日签到」领币（每天 1 币，全勤再 +3），或等别人给你的文章投币',
    };
  }
  return {
    ...common,
    available: true,
    reason: 'ok',
    message: `投 1 币给作者（可用 ${state.balance} 币，单帖上限 ${rules.perPostLimit} 币）`,
  };
}

/* ------------------------------------------------------------------ */
/* 路由表                                                              */
/* ------------------------------------------------------------------ */

const routes = [];

function route(method, pattern, handler) {
  const keys = [];
  const source = pattern.replace(/:([A-Za-z_]+)/g, (_match, key) => {
    keys.push(key);
    return '([^/]+)';
  });
  routes.push({ method, regex: new RegExp(`^${source}$`), keys, handler });
}

/** 站长（建站者，唯一）拥有分配管理员的权力；管理员与站长统称 staff（管理团队） */
const isOwner = (user) => user?.role === 'owner';
const isStaff = (user) => user?.role === 'owner' || user?.role === 'admin';

function requireUser(ctx) {
  ensure(ctx.user, 401, 'unauthenticated', '请先登录');
  ensure(!ctx.user.banned, 403, 'banned', '账号已被封禁，无法执行该操作');
  return ctx.user;
}

/** 需要管理团队身份（站长或管理员） */
function requireStaff(ctx) {
  const user = requireUser(ctx);
  ensure(isStaff(user), 403, 'forbidden', '需要管理员权限');
  return user;
}

/** 只有站长可以做的操作（分配/收回管理员） */
function requireOwner(ctx) {
  const user = requireUser(ctx);
  ensure(isOwner(user), 403, 'owner_only', '只有站长可以执行该操作');
  return user;
}

/**
 * 隐藏的文章对普通访客和搜索引擎都不存在：
 * 只有站务和作者本人能打开，其它人一律按「不存在」处理。
 */
function assertPostVisible(post, ctx) {
  if (!post.hidden) return;
  const viewer = ctx.user;
  const allowed = viewer && (isStaff(viewer) || viewer.id === post.author_id);
  ensure(allowed, 404, 'post_not_found', '帖子不存在或已被删除');
}

/* ---------------- 认证 ---------------- */

route('POST', '/api/auth/register', async (ctx) => {
  rateLimit(`register:${ctx.ip}`, 10, 10 * 60 * 1000);
  const username = field(ctx.body.username, {
    label: '用户名',
    name: '只能包含字母、数字和下划线',
    min: 3,
    max: 20,
    pattern: /^[A-Za-z0-9_]+$/,
  });
  const password = field(ctx.body.password, { label: '密码', min: 6, max: 72 });
  const displayName = ctx.body.displayName
    ? field(ctx.body.displayName, { label: '昵称', min: 1, max: 20 })
    : username;

  ensure(!store.userByUsername(username), 409, 'username_taken', '该用户名已被注册');
  const isFirstUser = store.stats().users === 0;
  const user = store.createUser({
    username,
    displayName,
    passwordHash: hashPassword(password),
    role: isFirstUser ? 'owner' : 'member',
  });
  const token = issueSession(user.id);
  store.createNotification({
    userId: user.id,
    type: 'system',
    excerpt: '欢迎来到围炉论坛！看看《论坛版规与发帖指南》，然后去发你的第一个帖子吧 🎉',
  });
  ok(res_(ctx), { user: shapeUser(user) }, { 'Set-Cookie': sessionCookie(token) });
});

route('POST', '/api/auth/login', async (ctx) => {
  rateLimit(`login:${ctx.ip}`, 20, 5 * 60 * 1000);
  const username = field(ctx.body.username, { label: '用户名', min: 1, max: 40 });
  const password = field(ctx.body.password, { label: '密码', min: 1, max: 200 });
  const user = store.userByUsername(username);
  ensure(user && verifyPassword(password, user.password_hash), 401, 'bad_credentials', '用户名或密码不对');
  ensure(!user.banned, 403, 'banned', '该账号已被封禁');
  const token = issueSession(user.id);
  ok(res_(ctx), { user: shapeUser(store.wallet(user.id)) }, { 'Set-Cookie': sessionCookie(token) });
});

route('POST', '/api/auth/logout', async (ctx) => {
  if (ctx.sessionToken) store.deleteSession(ctx.sessionToken);
  ok(res_(ctx), { loggedOut: true }, { 'Set-Cookie': sessionCookie('', 0) });
});

route('GET', '/api/auth/me', async (ctx) => {
  if (!ctx.user) return ok(res_(ctx), { user: null, unread: 0 });
  const fresh = store.wallet(ctx.user.id) ?? ctx.user;
  ok(res_(ctx), { user: shapeUser(fresh), unread: store.unreadCount(ctx.user.id) });
});

route('POST', '/api/me/profile', async (ctx) => {
  const user = requireUser(ctx);
  const displayName =
    ctx.body.displayName === undefined
      ? user.display_name
      : field(ctx.body.displayName, { label: '昵称', min: 1, max: 20 });
  const bio =
    ctx.body.bio === undefined ? user.bio ?? '' : field(ctx.body.bio, { label: '个性签名', min: 0, max: 100 });

  const updated = store.updateProfile(user.id, { displayName, bio });
  ok(res_(ctx), { user: shapeUser(updated) });
});

/* ---------------- 头像 ---------------- */

route('POST', '/api/me/avatar', async (ctx) => {
  const user = requireUser(ctx);
  rateLimit(`avatar:${user.id}`, 20, 10 * 60 * 1000);
  const previous = user.avatar ?? '';
  const type = ctx.body.type;

  if (type === 'reset') {
    const updated = store.updateAvatar(user.id, '');
    await removeAvatarFile(previous);
    return ok(res_(ctx), { user: shapeUser(updated) });
  }

  if (type === 'emoji') {
    const emoji = String(ctx.body.emoji ?? '').trim();
    ensure(emoji.length > 0 && emoji.length <= 8, 400, 'bad_emoji', '请选择一个表情作为头像');
    ensure(!/[<>&"'`\\/]/.test(emoji), 400, 'bad_emoji', '表情内容不合法');
    const hue = Number(ctx.body.hue ?? 210);
    ensure(Number.isFinite(hue) && hue >= 0 && hue <= 359, 400, 'bad_hue', '色相取值不正确');
    const updated = store.updateAvatar(user.id, `emoji:${emoji}:${Math.round(hue)}`);
    await removeAvatarFile(previous);
    return ok(res_(ctx), { user: shapeUser(updated) });
  }

  if (type === 'upload') {
    const url = await saveAvatarFile(user.id, ctx.body.dataUrl);
    const updated = store.updateAvatar(user.id, `file:${url}`);
    await removeAvatarFile(previous);
    return ok(res_(ctx), { user: shapeUser(updated), avatarUrl: url, maxBytes: MAX_AVATAR_BYTES });
  }

  throw new HttpError(400, 'bad_avatar_type', '头像类型不正确');
});

route('POST', '/api/auth/password', async (ctx) => {
  const user = requireUser(ctx);
  rateLimit(`password:${user.id}`, 10, 10 * 60 * 1000);
  const currentPassword = field(ctx.body.currentPassword, { label: '当前密码', min: 1, max: 200 });
  const newPassword = field(ctx.body.newPassword, { label: '新密码', min: 6, max: 72 });

  ensure(verifyPassword(currentPassword, user.password_hash), 400, 'bad_password', '当前密码不正确');
  ensure(newPassword !== currentPassword, 400, 'same_password', '新密码不能和当前密码相同');

  store.updatePassword(user.id, hashPassword(newPassword));
  // 改密后把其它设备的登录状态全部踢掉，只保留当前会话
  const revokedSessions = store.deleteOtherSessions(user.id, ctx.sessionToken);
  ok(res_(ctx), { changed: true, revokedSessions });
});

/* ---------------- 每日签到 ---------------- */

route('GET', '/api/checkin', async (ctx) => {
  const user = requireUser(ctx);
  ok(res_(ctx), store.checkinStatus(user.id));
});

route('POST', '/api/checkin', async (ctx) => {
  const user = requireUser(ctx);
  rateLimit(`checkin:${user.id}`, 20, 60 * 1000);
  const result = store.performCheckin(user.id);
  if (result.error === 'already_checked_in') {
    throw new HttpError(409, 'already_checked_in', '今天已经签到过了，明天再来');
  }
  ensure(!result.error, 400, 'checkin_failed', '签到失败，请稍后再试');
  ok(res_(ctx), result);
});

/* ---------------- 个人主页分类 ---------------- */

route('GET', '/api/me/categories', async (ctx) => {
  const user = requireUser(ctx);
  ok(res_(ctx), {
    items: store.listProfileCategories(user.id).map(shapeCategory),
    limit: store.profileCategoryLimit(),
    uncategorizedCount: store.uncategorizedCount(user.id),
  });
});

route('POST', '/api/me/categories', async (ctx) => {
  const user = requireUser(ctx);
  const name = field(ctx.body.name, { label: '分类名称', min: 1, max: 12 });
  const result = store.createProfileCategory(user.id, name);
  if (result.error === 'category_limit') {
    throw new HttpError(400, 'category_limit', `最多只能建 ${store.profileCategoryLimit()} 个分类`);
  }
  if (result.error === 'category_exists') throw new HttpError(409, 'category_exists', '已经有同名分类了');
  ensure(!result.error, 400, 'category_failed', '创建失败');
  ok(res_(ctx), { category: shapeCategory({ ...result.category, post_count: 0 }) });
});

route('PUT', '/api/me/categories/:id', async (ctx) => {
  const user = requireUser(ctx);
  const name = field(ctx.body.name, { label: '分类名称', min: 1, max: 12 });
  const result = store.renameProfileCategory(user.id, Number(ctx.params.id), name);
  if (result.error === 'not_found') throw new HttpError(404, 'category_not_found', '分类不存在');
  if (result.error === 'category_exists') throw new HttpError(409, 'category_exists', '已经有同名分类了');
  ok(res_(ctx), { category: shapeCategory(result.category) });
});

route('DELETE', '/api/me/categories/:id', async (ctx) => {
  const user = requireUser(ctx);
  const result = store.deleteProfileCategory(user.id, Number(ctx.params.id));
  if (result.error === 'not_found') throw new HttpError(404, 'category_not_found', '分类不存在');
  ok(res_(ctx), { deleted: true, uncategorizedCount: store.uncategorizedCount(user.id) });
});

/* ---------------- Markdown 预览 ---------------- */

route('POST', '/api/markdown/preview', async (ctx) => {
  requireUser(ctx);
  const content = typeof ctx.body.content === 'string' ? ctx.body.content.slice(0, 20000) : '';
  ok(res_(ctx), { html: renderMarkdown(content) });
});

/* ---------------- 站点信息 ---------------- */

route('GET', '/api/site', async (ctx) => {
  ok(res_(ctx), {
    boards: store.listBoards().map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      icon: row.icon,
      postCount: row.post_count,
      replyCount: row.reply_count,
    })),
    stats: store.stats(),
    ai: forumAiStatus(),
    notes: noteAgentStatus(),
    coinRules: store.COIN_RULES,
    checkinRules: store.CHECKIN_RULES,
    profileRules: store.PROFILE_RULES,
    valueWeights: store.valueWeights(),
    messageRules: store.MESSAGE_RULES,
    hotPosts: store.hotPosts(5).map((row) => ({
      id: row.id,
      title: row.title,
      replyCount: row.reply_count,
      likeCount: row.like_count,
      coinCount: row.coin_count,
    })),
  });
});

/* ---------------- 知识网络图 ---------------- */

/*
 * 图不是在这里现算的：scripts/build-graph.mjs 离线跑（导出语料 → knowledge-pack
 * 算关系网 → 清洗成 data/knowledge/graph.json），这里只负责把结果读出来。
 * 好处是访问很轻（读一个 JSON），而且重新部署不会动 data/。
 */
const GRAPH_FILE = join(ROOT, 'data', 'knowledge', 'graph.json');
const GRAPH_STATUS_FILE = join(ROOT, 'data', 'knowledge', 'status.json');

async function readJsonFile(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

route('GET', '/api/knowledge/graph', async (ctx) => {
  const graph = await readJsonFile(GRAPH_FILE);
  if (!graph) {
    throw new HttpError(404, 'graph_not_built', '知识网络图还没有生成');
  }
  const status = await readJsonFile(GRAPH_STATUS_FILE);
  ok(res_(ctx), { graph, status });
});

/** 原版的可视化页面（knowledge-pack 自己生成的单文件 viewer），给「打开原图」用。 */
route('GET', '/api/knowledge/viewer', async (ctx) => {
  let html;
  try {
    html = await readFile(join(ROOT, 'data', 'knowledge', 'out', 'viewer.html'), 'utf8');
  } catch {
    throw new HttpError(404, 'viewer_not_built', '还没有生成可视化页面');
  }
  const res = res_(ctx);
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(html);
});

/* ---------------- 帖子 ---------------- */

function resolveListView(ctx) {
  const boardSlug = ctx.query.get('board');
  let boardId = null;
  if (boardSlug) {
    const board = store.boardBySlug(boardSlug);
    ensure(board, 404, 'board_not_found', '板块不存在');
    boardId = board.id;
  }
  let authorId = null;
  if (ctx.query.get('author')) {
    const author = store.userByUsername(ctx.query.get('author'));
    ensure(author, 404, 'user_not_found', '用户不存在');
    authorId = author.id;
  }
  const q = (ctx.query.get('q') || '').trim().slice(0, 60);
  const sort = ['latest', 'hot', 'active'].includes(ctx.query.get('sort')) ? ctx.query.get('sort') : 'latest';
  const page = Math.max(1, Number(ctx.query.get('page') || 1) || 1);
  const perPage = Math.min(30, Math.max(5, Number(ctx.query.get('perPage') || 10) || 10));
  const bookmarkedBy = ctx.query.get('bookmarked') === '1' ? requireUser(ctx).id : null;
  const followingBy = ctx.query.get('following') === '1' ? requireUser(ctx).id : null;
  return {
    boardId,
    authorId,
    q,
    sort,
    page,
    perPage,
    bookmarkedBy,
    followingBy,
    // 管理团队可以看到被隐藏的文章（列表里会打「已隐藏」标记）
    includeHidden: isStaff(ctx.user),
    // 拉黑过滤：我和对方任意一方拉黑了对方，列表里就互相看不到
    hideBlockedFor: ctx.user?.id ?? ANON,
    viewerId: ctx.user?.id ?? ANON,
  };
}

route('GET', '/api/posts', async (ctx) => {
  const view = resolveListView(ctx);
  const total = store.countPosts(view);
  const rows = store.listPosts(view);
  ok(res_(ctx), {
    items: rows.map(shapePostListRow),
    page: view.page,
    perPage: view.perPage,
    total,
    totalPages: Math.max(1, Math.ceil(total / view.perPage)),
    sort: view.sort,
  });
});

route('GET', '/api/posts/:id', async (ctx) => {
  const id = Number(ctx.params.id);
  ensure(Number.isInteger(id) && id > 0, 400, 'bad_id', '帖子编号不正确');
  const row = store.postById(id, ctx.user?.id ?? ANON);
  ensure(row, 404, 'post_not_found', '帖子不存在或已被删除');
  assertPostVisible(row, ctx);
  // 作者拉黑了我（或我拉黑了作者）→ 当作不存在，避免通过直链绕过
  ensure(
    !ctx.user || !store.blocksBetween(ctx.user.id, row.author_id),
    404,
    'post_not_found',
    '帖子不存在或已被删除',
  );
  const isAuthor = ctx.user?.id === row.author_id;
  if (!isAuthor && !row.hidden) store.bumpViews(id);

  ok(res_(ctx), {
    post: {
      ...shapePostDetail({ ...row, views: row.views + (isAuthor || row.hidden ? 0 : 1) }),
      coin: coinAvailability(row, ctx.user),
    },
    replies: store.listReplies(id, ctx.user?.id ?? ANON).map(shapeReply),
    reposters: store.listReposters(id).map(shapeReposter),
  });
});

route('POST', '/api/posts', async (ctx) => {
  const user = requireUser(ctx);
  rateLimit(`post:${user.id}`, 15, 10 * 60 * 1000);
  const boardId = Number(ctx.body.boardId);
  ensure(store.boardById(boardId), 400, 'bad_board', '请选择要发布到的板块');
  const title = field(ctx.body.title, { label: '标题', min: 2, max: 80 });
  const content = field(ctx.body.content, { label: '正文', min: 2, max: 20000 });
  const categoryId = resolveOwnCategory(user, ctx.body.categoryId);
  const wantPin = Boolean(ctx.body.profilePinned);
  if (wantPin) assertPinAllowed(user);

  const id = store.createPost({ boardId, userId: user.id, title, content });
  if (categoryId) store.setPostCategory(id, categoryId);
  if (wantPin) store.setProfilePin(id, true);

  // 通知关注我的人：我发新帖了（同一人对同一帖子只保留一条未读通知）
  for (const follower of store.listFollowers(user.id)) {
    store.createNotification({
      userId: follower.id,
      actorId: user.id,
      type: 'following_post',
      postId: id,
      excerpt: title,
    });
  }
  notifyMentions({ content, actorId: user.id, postId: id });

  ok(res_(ctx), { id });
});

route('PUT', '/api/posts/:id', async (ctx) => {
  const user = requireUser(ctx);
  const id = Number(ctx.params.id);
  const row = store.postById(id, user.id);
  ensure(row, 404, 'post_not_found', '帖子不存在');
  ensure(row.author_id === user.id || isStaff(user), 403, 'forbidden', '只能编辑自己的帖子');
  const boardId = ctx.body.boardId ? Number(ctx.body.boardId) : row.board_id;
  ensure(store.boardById(boardId), 400, 'bad_board', '板块不存在');
  const title = field(ctx.body.title, { label: '标题', min: 2, max: 80 });
  const content = field(ctx.body.content, { label: '正文', min: 2, max: 20000 });
  const pinProvided = ctx.body.profilePinned !== undefined;
  if (pinProvided && ctx.body.profilePinned) {
    assertPinAllowed(user, { alreadyPinned: Boolean(row.profile_pinned) });
  }

  store.updatePost({ id, boardId, title, content });
  if (ctx.body.categoryId !== undefined) store.setPostCategory(id, resolveOwnCategory(user, ctx.body.categoryId));
  if (pinProvided) store.setProfilePin(id, Boolean(ctx.body.profilePinned));
  ok(res_(ctx), { id });
});

route('DELETE', '/api/posts/:id', async (ctx) => {
  const user = requireUser(ctx);
  const id = Number(ctx.params.id);
  const row = store.postById(id, user.id);
  ensure(row, 404, 'post_not_found', '帖子不存在');
  ensure(row.author_id === user.id || isStaff(user), 403, 'forbidden', '没有权限删除这个帖子');
  store.softDeletePost(id);
  if (row.author_id !== user.id) {
    const label = isOwner(user) ? '站长' : '管理员';
    store.createNotification({
      userId: row.author_id,
      actorId: user.id,
      type: 'moderation',
      postId: id,
      excerpt: `${label}删除了你的文章：${row.title}`,
    });
    store.logModeration({
      actorId: user.id,
      action: 'delete_post',
      targetType: 'post',
      targetId: id,
      targetLabel: row.title,
    });
  }
  ok(res_(ctx), { deleted: true });
});

/* ---------------- 管理：隐藏 / 恢复文章（站长 + 管理员） ---------------- */

route('POST', '/api/admin/posts/:id/hide', async (ctx) => {
  const user = requireStaff(ctx);
  const id = Number(ctx.params.id);
  const row = store.postRow(id);
  ensure(row && !row.deleted, 404, 'post_not_found', '帖子不存在');

  const hidden = Boolean(ctx.body.hidden);
  const reason =
    ctx.body.reason === undefined || ctx.body.reason === null
      ? ''
      : field(ctx.body.reason, { label: '隐藏原因', min: 0, max: 100 });

  store.setPostHidden(id, hidden, { byUserId: user.id, reason });

  const label = isOwner(user) ? '站长' : '管理员';
  if (row.user_id !== user.id) {
    store.createNotification({
      userId: row.user_id,
      actorId: user.id,
      type: 'moderation',
      postId: id,
      excerpt: hidden
        ? `${label}隐藏了你的文章：${row.title}${reason ? `（原因：${reason}）` : ''}`
        : `${label}恢复了你的文章显示：${row.title}`,
    });
  }
  store.logModeration({
    actorId: user.id,
    action: hidden ? 'hide_post' : 'unhide_post',
    targetType: 'post',
    targetId: id,
    targetLabel: row.title,
    reason,
  });

  const detail = store.postById(id, user.id);
  ok(res_(ctx), {
    postId: id,
    hidden,
    hiddenReason: reason,
    hiddenBy: user.id,
    post: detail ? shapePostListRow(detail) : null,
    hiddenCount: store.hiddenPostCount(),
  });
});

/* ---------------- 评价：赞 / 踩 ---------------- */

route('POST', '/api/posts/:id/reaction', async (ctx) => {
  const user = requireUser(ctx);
  const id = Number(ctx.params.id);
  const post = store.postById(id, user.id);
  ensure(post, 404, 'post_not_found', '帖子不存在');
  assertPostVisible(post, ctx);
  const kind = ctx.body.kind;
  ensure(kind === 'like' || kind === 'dislike', 400, 'bad_kind', '只支持「赞」或「踩」');

  const result = store.setReaction(user.id, id, kind);
  if (result.changed && (result.liked || result.disliked)) {
    store.createNotification({
      userId: post.author_id,
      actorId: user.id,
      type: result.liked ? 'post_like' : 'post_dislike',
      postId: id,
      excerpt: post.title,
    });
  }
  ok(res_(ctx), {
    liked: result.liked,
    disliked: result.disliked,
    likeCount: result.likeCount,
    dislikeCount: result.dislikeCount,
  });
});

/* ---------------- 投币 ---------------- */

route('POST', '/api/posts/:id/coin', async (ctx) => {
  const user = requireUser(ctx);
  const id = Number(ctx.params.id);
  const post = store.postRow(id);
  ensure(post && !post.deleted, 404, 'post_not_found', '帖子不存在');
  assertPostVisible(post, ctx);
  const rules = store.COIN_RULES;
  const amount = Number(ctx.body.amount ?? 1);
  ensure(Number.isFinite(amount) && amount >= 1, 400, 'bad_amount', '投币数量不正确');

  const result = store.giveCoin({ userId: user.id, postId: id, amount });
  if (result.error === 'self_coin') throw new HttpError(400, 'self_coin', '不能给自己的帖子投币');
  if (result.error === 'per_post_limit') {
    throw new HttpError(400, 'per_post_limit', `每个帖子最多投 ${rules.perPostLimit} 币`);
  }
  if (result.error === 'insufficient_coins') {
    throw new HttpError(400, 'insufficient_coins', '币不够了：去「每日签到」领币，或等别人给你的文章投币');
  }
  ensure(!result.error, 400, 'coin_failed', '投币失败');

  store.createNotification({
    userId: result.authorId,
    actorId: user.id,
    type: 'post_coin',
    postId: id,
    excerpt: `投了 ${result.given} 币`,
  });
  ok(res_(ctx), {
    given: result.given,
    myCoins: result.myCoins,
    coinCount: result.coinCount,
    balance: result.balance,
    perPostLimit: result.perPostLimit,
    signupGrant: result.signupGrant,
  });
});

/* ---------------- 个人主页：文章分类与置顶 ---------------- */

route('POST', '/api/posts/:id/category', async (ctx) => {
  const user = requireUser(ctx);
  const id = Number(ctx.params.id);
  const post = store.postById(id, user.id);
  ensure(post, 404, 'post_not_found', '帖子不存在');
  ensure(post.author_id === user.id, 403, 'forbidden', '只能整理自己的文章');
  const categoryId = resolveOwnCategory(user, ctx.body.categoryId ?? null);
  store.setPostCategory(id, categoryId);
  ok(res_(ctx), {
    postId: id,
    category: categoryId ? shapeCategory(store.profileCategoryById(categoryId)) : null,
    uncategorizedCount: store.uncategorizedCount(user.id),
  });
});

route('POST', '/api/posts/:id/profile-pin', async (ctx) => {
  const user = requireUser(ctx);
  const id = Number(ctx.params.id);
  const post = store.postById(id, user.id);
  ensure(post, 404, 'post_not_found', '帖子不存在');
  ensure(post.author_id === user.id, 403, 'forbidden', '只能置顶自己的文章');
  const pinned = Boolean(ctx.body.pinned);
  if (pinned) assertPinAllowed(user, { alreadyPinned: Boolean(post.profile_pinned) });
  store.setProfilePin(id, pinned);
  ok(res_(ctx), {
    postId: id,
    profilePinned: pinned,
    pinnedCount: store.profilePinCount(user.id),
    pinLimit: store.profilePinLimit(),
  });
});

/* ---------------- 转发 ---------------- */

route('POST', '/api/posts/:id/repost', async (ctx) => {
  const user = requireUser(ctx);
  const id = Number(ctx.params.id);
  const post = store.postById(id, user.id);
  ensure(post, 404, 'post_not_found', '帖子不存在');
  assertPostVisible(post, ctx);
  ensure(post.author_id !== user.id, 400, 'self_repost', '这是你自己的文章，不用转发啦');
  ensure(!post.locked || isStaff(user), 403, 'locked', '该帖子已锁定，暂时不能转发');

  const comment = ctx.body.comment === undefined || ctx.body.comment === null
    ? ''
    : field(ctx.body.comment, { label: '转发语', min: 0, max: 300 });
  const result = store.createRepost({ postId: id, userId: user.id, comment });

  // 只在「第一次转发」时通知作者，改转发语不重复打扰
  if (!result.updated) {
    store.createNotification({
      userId: post.author_id,
      actorId: user.id,
      type: 'post_repost',
      postId: id,
      excerpt: comment || post.title,
    });
  }
  ok(res_(ctx), result);
});

route('DELETE', '/api/posts/:id/repost', async (ctx) => {
  const user = requireUser(ctx);
  const id = Number(ctx.params.id);
  const result = store.deleteRepost(id, user.id);
  if (result.error === 'not_reposted') throw new HttpError(400, 'not_reposted', '你还没有转发过这篇');
  ok(res_(ctx), result);
});

/* ---------------- 排行榜 ---------------- */

route('GET', '/api/ranking', async (ctx) => {
  const windowParam = ctx.query.get('window') ?? 'all';
  const days = windowParam === '7' ? 7 : windowParam === '30' ? 30 : 0;
  const limit = Math.min(50, Math.max(5, Number(ctx.query.get('limit') || 20) || 20));
  const minPosts = Math.max(1, Number(ctx.query.get('minPosts') || 1) || 1);
  const viewerId = ctx.user?.id ?? ANON;

  const viewerIdForRank = ctx.user?.id ?? ANON;
  const rankedRows = store.rankPosts({ days, limit, hideBlockedFor: viewerIdForRank });
  // 一次批量取回浏览者相关的状态（是否已赞/已收藏/已转发），避免逐条查询
  const viewerState = new Map(
    store.listPostsByIds(rankedRows.map((row) => row.id), viewerId).map((row) => [
      row.id,
      { liked: Boolean(row.liked), bookmarked: Boolean(row.bookmarked), reposted: Boolean(row.reposted), myCoins: Number(row.my_coins ?? 0) },
    ]),
  );

  const posts = rankedRows.map((row) => ({
    id: row.id,
    title: row.title,
    excerpt: markdownToPlainText(row.content_head, 120),
    board: { slug: row.board_slug, name: row.board_name, icon: row.board_icon },
    author: shapeAuthor(row),
    createdAt: row.created_at,
    views: row.views,
    pinned: Boolean(row.pinned),
    replyCount: row.reply_count,
    likeCount: row.like_count,
    dislikeCount: row.dislike_count,
    coinCount: row.coin_count,
    bookmarkCount: row.bookmark_count,
    repostCount: row.repost_count,
    baseScore: Number(Number(row.base_score).toFixed(2)),
    valueScore: Number(Number(row.value_score).toFixed(2)),
    ...(viewerState.get(row.id) ?? { liked: false, bookmarked: false, reposted: false, myCoins: 0 }),
  }));

  const authors = store.rankAuthors({ days, limit, minPosts, hideBlockedFor: viewerIdForRank }).map((row, index) => ({
    rank: index + 1,
    user: {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
      bio: row.bio ?? '',
      avatar: row.avatar ?? '',
    },
    postCount: Number(row.post_count),
    totalValue: Number(Number(row.total_value).toFixed(2)),
    avgValue: Number(Number(row.avg_value).toFixed(2)),
    bestValue: Number(Number(row.best_value).toFixed(2)),
    likesReceived: Number(row.likes_received),
    dislikesReceived: Number(row.dislikes_received),
    coinsReceived: Number(row.coins_received),
    bookmarksReceived: Number(row.bookmarks_received),
    repliesReceived: Number(row.replies_received),
  }));

  ok(res_(ctx), {
    window: days === 0 ? 'all' : String(days),
    days,
    weights: store.valueWeights(),
    posts,
    authors,
    totals: { posts: store.stats().posts, authors: authors.length },
  });
});

/* ---------------- 收藏 ---------------- */
route('POST', '/api/posts/:id/bookmark', async (ctx) => {
  const user = requireUser(ctx);
  const id = Number(ctx.params.id);
  const bookmarkedPost = store.postById(id, user.id);
  ensure(bookmarkedPost, 404, 'post_not_found', '帖子不存在');
  assertPostVisible(bookmarkedPost, ctx);
  ok(res_(ctx), store.toggleBookmark(user.id, id));
});

/* ---------------- 回复 ---------------- */

route('POST', '/api/posts/:id/replies', async (ctx) => {
  const user = requireUser(ctx);
  rateLimit(`reply:${user.id}`, 40, 10 * 60 * 1000);
  const id = Number(ctx.params.id);
  const post = store.postById(id, user.id);
  ensure(post, 404, 'post_not_found', '帖子不存在');
  assertPostVisible(post, ctx);
  ensure(!post.locked || isStaff(user), 403, 'locked', '该帖子已锁定，无法回复');
  const content = field(ctx.body.content, { label: '回复内容', min: 1, max: 5000 });
  const replyId = store.createReply({ postId: id, userId: user.id, content });
  const created = store.listReplies(id, user.id).find((reply) => reply.id === replyId);

  store.createNotification({
    userId: post.author_id,
    actorId: user.id,
    type: 'post_reply',
    postId: id,
    replyId,
    excerpt: markdownToPlainText(content, 60),
  });
  notifyMentions({ content, actorId: user.id, postId: id, replyId });

  ok(res_(ctx), { reply: shapeReply(created), replyCount: store.countReplies(id) });
});

route('DELETE', '/api/replies/:id', async (ctx) => {
  const user = requireUser(ctx);
  const id = Number(ctx.params.id);
  const reply = store.replyById(id);
  ensure(reply && !reply.deleted, 404, 'reply_not_found', '回复不存在');
  const post = store.postById(reply.post_id, user.id);
  const allowed = reply.user_id === user.id || post?.author_id === user.id || isStaff(user);
  ensure(allowed, 403, 'forbidden', '没有权限删除这条回复');
  store.softDeleteReply(id);
  ok(res_(ctx), { deleted: true });
});

/* ---------------- 关注 ---------------- */

route('POST', '/api/users/:id/follow', async (ctx) => {
  const user = requireUser(ctx);
  const id = Number(ctx.params.id);
  ensure(store.userById(id), 404, 'user_not_found', '用户不存在');
  const result = store.toggleFollow(user.id, id);
  if (result.error === 'self_follow') throw new HttpError(400, 'self_follow', '不能关注自己');
  if (result.error === 'blocked_by_me') {
    throw new HttpError(403, 'blocked_by_me', '你已把对方拉黑，先解除黑名单才能关注');
  }
  if (result.error === 'blocked_me') {
    throw new HttpError(403, 'blocked_me', '对方已将你拉黑，无法关注 TA');
  }
  ensure(!result.error, 400, 'follow_failed', '关注失败');

  if (result.following) {
    store.createNotification({ userId: id, actorId: user.id, type: 'follow' });
  }
  ok(res_(ctx), { following: result.following, followerCount: result.followerCount });
});

/* ---------------- 黑名单 ---------------- */

route('POST', '/api/users/:id/block', async (ctx) => {
  const user = requireUser(ctx);
  const id = Number(ctx.params.id);
  ensure(store.userById(id), 404, 'user_not_found', '用户不存在');
  const blocked = ctx.body.blocked === undefined ? true : Boolean(ctx.body.blocked);
  const result = blocked ? store.blockUser(user.id, id) : store.unblockUser(user.id, id);
  if (result.error === 'self_block') throw new HttpError(400, 'self_block', '不能拉黑自己');
  ok(res_(ctx), {
    blocked: result.blocked,
    changed: result.changed,
    blockCount: store.blockCount(user.id),
    following: false,
  });
});

route('GET', '/api/me/blocks', async (ctx) => {
  const user = requireUser(ctx);
  ok(res_(ctx), {
    items: store.listBlocks(user.id).map(shapePerson),
    total: store.blockCount(user.id),
  });
});

/* ---------------- 私信 ---------------- */

route('GET', '/api/messages/summary', async (ctx) => {
  if (!ctx.user) return ok(res_(ctx), { unread: 0 });
  ok(res_(ctx), {
    unread: store.unreadMessageCount(ctx.user.id),
    conversations: store.listConversations(ctx.user.id).length,
  });
});

route('GET', '/api/messages', async (ctx) => {
  const user = requireUser(ctx);
  ok(res_(ctx), {
    items: store.listConversations(user.id).map((row) => shapeConversation(row, user.id)),
    unread: store.unreadMessageCount(user.id),
    rules: store.MESSAGE_RULES,
  });
});

/** 会话详情：打开即把对方发来的消息标记为已读 */
route('GET', '/api/messages/:username', async (ctx) => {
  const user = requireUser(ctx);
  const peer = store.userByUsername(ctx.params.username);
  ensure(peer, 404, 'user_not_found', '用户不存在');
  ensure(peer.id !== user.id, 400, 'self_thread', '不能和自己私信');
  if (store.isBlocked(peer.id, user.id)) {
    throw new HttpError(403, 'blocked_me', '对方已将你拉黑，无法查看会话');
  }

  const messages = store.listThread(user.id, peer.id);
  const unreadBefore = store.unreadFromPeer(user.id, peer.id);
  if (unreadBefore > 0) store.markThreadRead(user.id, peer.id);

  ok(res_(ctx), {
    peer: shapePerson(peer),
    messages: messages.map(shapeMessage),
    total: store.countThread(user.id, peer.id),
    unreadBefore,
    availability: store.messageAvailability(user.id, peer),
    rules: store.MESSAGE_RULES,
  });
});

route('POST', '/api/messages/:username', async (ctx) => {
  const user = requireUser(ctx);
  rateLimit(`message:${user.id}`, 60, 10 * 60 * 1000);
  const peer = store.userByUsername(ctx.params.username);
  ensure(peer, 404, 'user_not_found', '用户不存在');

  const availability = store.messageAvailability(user.id, peer);
  if (!availability.canSend) {
    const status =
      availability.reason === 'daily_limit' ? 429 : availability.reason === 'self' ? 400 : 403;
    const code = availability.reason === 'self' ? 'self_message' : availability.reason;
    throw new HttpError(status, code, availability.message);
  }

  const content = field(ctx.body.content, { label: '私信内容', min: 1, max: store.MESSAGE_RULES.maxLength });
  const message = store.createMessage({ senderId: user.id, recipientId: peer.id, content });
  store.createNotification({
    userId: peer.id,
    actorId: user.id,
    type: 'message',
    excerpt: markdownToPlainText(content, 60),
  });

  ok(res_(ctx), {
    message: shapeMessage(message),
    availability: store.messageAvailability(user.id, peer),
    unread: store.unreadMessageCount(user.id),
  });
});

route('GET', '/api/users/:username', async (ctx) => {
  const row = store.userProfile(ctx.params.username);
  ensure(row, 404, 'user_not_found', '用户不存在');
  const viewerId = ctx.user?.id ?? ANON;
  const isMe = viewerId === row.id;
  const balance = isMe ? Number(store.wallet(row.id)?.coin_balance ?? row.coin_balance) : undefined;

  // 拉黑关系：对方拉黑了我 → 我连 TA 的主页都打不开；我拉黑了对方 → 能打开但看不到文章
  const blockedByMe = !isMe && viewerId !== ANON && store.isBlocked(viewerId, row.id);
  if (!isMe && viewerId !== ANON && store.isBlocked(row.id, viewerId)) {
    throw new HttpError(404, 'user_not_found', '用户不存在或已被屏蔽');
  }
  const mutualFollow = viewerId !== ANON && !isMe ? store.areMutualFollowers(viewerId, row.id) : false;

  // 个人主页的文章筛选：?category=<id> | none | reposts
  const categoryParam = ctx.query.get('category');
  const filter = {};
  const showReposts = categoryParam === 'reposts';
  if (categoryParam === 'none') {
    filter.uncategorized = true;
  } else if (categoryParam && !showReposts) {
    const categoryId = Number(categoryParam);
    const category = store.profileCategoryById(categoryId);
    ensure(category && category.user_id === row.id, 404, 'category_not_found', '分类不存在');
    filter.categoryId = categoryId;
  }

  // 我拉黑了对方：主页能看到（方便解除），但内容一律不展示
  const posts = blockedByMe
    ? []
    : showReposts
    ? store.listRepostedPosts(row.id, viewerId).map((item) => ({
        ...shapePostListRow(item),
        repost: {
          id: item.repost.id,
          comment: item.repost.comment,
          createdAt: item.repost.createdAt,
        },
      }))
    : store
        .listPosts({
          authorId: row.id,
          perPage: 50,
          sort: 'profile',
          viewerId,
          // 被隐藏的文章只有作者本人和管理团队能看到
          includeHidden: isMe || isStaff(ctx.user),
          ...filter,
        })
        .map(shapePostListRow);

  const value = store.profileValue(row.id);

  ok(res_(ctx), {
    user: shapeProfile(row, {
      isMe,
      isFollowing: store.isFollowing(viewerId, row.id),
      followsMe: viewerId !== ANON && !isMe ? store.isFollowing(row.id, viewerId) : false,
      mutualFollow,
      blockedByMe,
      ...(isMe ? { coinBalance: balance } : {}),
    }),
    ...(isMe || viewerId === ANON
      ? {}
      : { messageAvailability: store.messageAvailability(viewerId, row) }),
    value: {
      totalValue: Number(value.totalValue.toFixed(2)),
      avgValue: Number(value.avgValue.toFixed(2)),
      bestValue: Number(value.bestValue.toFixed(2)),
      postCount: value.postCount,
      rank: store.authorValueRank(row.id),
      weights: store.valueWeights(),
    },
    repostCount: store.repostCountByUser(row.id),
    categories: store.listProfileCategories(row.id).map(shapeCategory),
    uncategorizedCount: store.uncategorizedCount(row.id),
    pinnedCount: store.profilePinCount(row.id),
    pinLimit: store.profilePinLimit(),
    categoryLimit: store.profileCategoryLimit(),
    filter: categoryParam ?? 'all',
    followers: store.listFollowers(row.id, viewerId).map(shapePerson),
    following: store.listFollowing(row.id).map(shapePerson),
    posts,
  });
});

route('GET', '/api/me/following', async (ctx) => {
  const user = requireUser(ctx);
  ok(res_(ctx), {
    items: store.listFollowing(user.id).map(shapePerson),
    counts: store.followCounts(user.id),
    coinBalance: Number(store.wallet(user.id)?.coin_balance ?? user.coin_balance),
  });
});

/* ---------------- 消息通知 ---------------- */

route('GET', '/api/notifications', async (ctx) => {
  const user = requireUser(ctx);
  const page = Math.max(1, Number(ctx.query.get('page') || 1) || 1);
  const perPage = Math.min(50, Math.max(5, Number(ctx.query.get('perPage') || 20) || 20));
  const unreadOnly = ctx.query.get('filter') === 'unread';
  const total = store.countNotifications(user.id, unreadOnly);

  ok(res_(ctx), {
    items: store.listNotifications({ userId: user.id, page, perPage, unreadOnly }).map(shapeNotification),
    page,
    perPage,
    total,
    totalPages: Math.max(1, Math.ceil(total / perPage)),
    unreadCount: store.unreadCount(user.id),
    filter: unreadOnly ? 'unread' : 'all',
  });
});

route('GET', '/api/notifications/summary', async (ctx) => {
  if (!ctx.user) return ok(res_(ctx), { unread: 0 });
  ok(res_(ctx), { unread: store.unreadCount(ctx.user.id) });
});

route('POST', '/api/notifications/:id/read', async (ctx) => {
  const user = requireUser(ctx);
  ok(res_(ctx), store.markNotificationRead(user.id, Number(ctx.params.id)));
});

route('POST', '/api/notifications/read-all', async (ctx) => {
  const user = requireUser(ctx);
  ok(res_(ctx), store.markAllNotificationsRead(user.id));
});

/* ---------------- 管理后台 ---------------- */

route('GET', '/api/admin/overview', async (ctx) => {
  const staff = requireStaff(ctx);
  ok(res_(ctx), {
    viewer: { id: staff.id, role: staff.role, isOwner: isOwner(staff) },
    stats: store.adminStats(),
    users: store.listUsers().map((row) => ({
      ...shapeUser(row),
      postCount: row.post_count,
      replyCount: row.reply_count,
      followerCount: row.follower_count,
    })),
    recentPosts: store.recentPosts(10).map((row) => ({
      id: row.id,
      title: row.title,
      createdAt: row.created_at,
      views: row.views,
      author: row.author_display,
      board: row.board_name,
      hidden: Boolean(row.hidden),
    })),
    hiddenPosts: store.listHiddenPosts(10).map((row) => ({
      id: row.id,
      title: row.title,
      createdAt: row.created_at,
      hiddenAt: row.hidden_at,
      reason: row.hidden_reason,
      author: row.author_display,
      authorUsername: row.author_username,
      moderator: row.moderator_display,
    })),
    moderationLogs: store.listModerationLogs(20),
  });
});

/**
 * 分配 / 收回管理员：只有站长可以操作。
 * 站长自己不能被降级（避免把唯一的站长弄丢）。
 */
route('POST', '/api/admin/users/:id/role', async (ctx) => {
  const owner = requireOwner(ctx);
  const id = Number(ctx.params.id);
  const target = store.userById(id);
  ensure(target, 404, 'user_not_found', '用户不存在');
  ensure(target.id !== owner.id, 400, 'self_role', '不能修改自己的角色');
  ensure(target.role !== 'owner', 400, 'owner_immutable', '站长角色不可变更');

  const role = ctx.body.role;
  ensure(role === 'admin' || role === 'member', 400, 'bad_role', '只能设为管理员或普通成员');
  const result = store.setUserRole(id, role);
  ensure(!result.error, 400, 'role_failed', '角色修改失败');

  if (result.changed) {
    store.createNotification({
      userId: id,
      actorId: owner.id,
      type: 'moderation',
      excerpt:
        role === 'admin'
          ? '站长把你设为管理员了，现在可以隐藏或删除违规文章 🛡️'
          : '你的管理员权限已被收回',
    });
    store.logModeration({
      actorId: owner.id,
      action: role === 'admin' ? 'grant_admin' : 'revoke_admin',
      targetType: 'user',
      targetId: id,
      targetLabel: target.display_name,
    });
  }
  ok(res_(ctx), {
    user: shapeUser(store.userById(id)),
    changed: result.changed,
    staff: store.listStaff(),
  });
});

route('POST', '/api/admin/users/:id/ban', async (ctx) => {
  const admin = requireStaff(ctx);
  const id = Number(ctx.params.id);
  const target = store.userById(id);
  ensure(target, 404, 'user_not_found', '用户不存在');
  ensure(target.id !== admin.id, 400, 'self_ban', '不能封禁自己');
  ensure(target.role !== 'owner', 400, 'owner_immutable', '不能封禁站长');
  // 管理员之间不能互相封禁，只有站长可以处理管理员
  ensure(
    !isStaff(target) || isOwner(admin),
    403,
    'staff_protected',
    '管理员不能封禁其它管理员，请让站长处理',
  );

  const banned = Boolean(ctx.body.banned);
  store.setUserBanned(id, banned);
  if (banned) {
    for (const session of store.listSessionsOfUser(id)) {
      store.deleteSession(session.token);
    }
  }
  store.createNotification({
    userId: id,
    actorId: admin.id,
    type: 'moderation',
    excerpt: banned ? '你的账号已被封禁' : '你的账号已解封',
  });
  store.logModeration({
    actorId: admin.id,
    action: banned ? 'ban_user' : 'unban_user',
    targetType: 'user',
    targetId: id,
    targetLabel: target.display_name,
  });
  ok(res_(ctx), { user: shapeUser(store.userById(id)) });
});

/* ------------------------------------------------------------------ */
/* 请求处理                                                            */
/* ------------------------------------------------------------------ */

function issueSession(userId) {
  const token = randomBytes(24).toString('hex');
  store.createSession(token, userId, SESSION_TTL_MS);
  return token;
}

function sessionCookie(token, maxAgeSeconds = SESSION_TTL_MS / 1000) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

function resolveUser(req) {
  const token = parseCookies(req.headers.cookie).get(SESSION_COOKIE);
  if (!token) return { user: null, sessionToken: null };
  const session = store.sessionByToken(token);
  if (!session) return { user: null, sessionToken: null };
  if (Number(session.expires_at) < Date.now()) {
    store.deleteSession(token);
    return { user: null, sessionToken: null };
  }
  const user = store.userById(session.user_id);
  if (!user || user.banned) {
    store.deleteSession(token);
    return { user: null, sessionToken: null };
  }
  store.touchSession(token, Date.now() + SESSION_TTL_MS);
  return { user, sessionToken: token };
}

/* ------------------------------------------------------------------ */
/* 头像：预设 emoji 或上传图片                                          */
/* ------------------------------------------------------------------ */

const AVATAR_IMAGE_TYPES = {
  png: { ext: 'png', mime: 'image/png' },
  jpeg: { ext: 'jpg', mime: 'image/jpeg' },
  webp: { ext: 'webp', mime: 'image/webp' },
};

/** 用魔数判断图片类型，不信任客户端声明的 MIME（顺便挡掉 SVG / HTML 伪装） */
function sniffImageType(buffer) {
  if (buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'png';
  }
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.length > 12 && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') {
    return 'webp';
  }
  return null;
}

/** 把 dataURL 落盘到 data/avatars/，返回可访问的站内地址 */
async function saveAvatarFile(userId, dataUrl) {
  const match = String(dataUrl ?? '').match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/);
  ensure(match, 400, 'bad_image', '只支持 PNG / JPEG / WebP 图片');
  const declared = match[1];
  const buffer = Buffer.from(match[2], 'base64');
  ensure(buffer.length > 0, 400, 'bad_image', '图片内容为空');
  ensure(
    buffer.length <= MAX_AVATAR_BYTES,
    400,
    'image_too_large',
    `头像不能超过 ${Math.round(MAX_AVATAR_BYTES / 1024)} KB`,
  );
  const type = sniffImageType(buffer);
  ensure(type, 400, 'bad_image', '图片格式识别失败（不支持 SVG）');
  ensure(type === declared, 400, 'bad_image', '图片内容与声明的格式不一致');

  mkdirSync(AVATAR_DIR, { recursive: true });
  const filename = `u${userId}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}.${AVATAR_IMAGE_TYPES[type].ext}`;
  await writeFile(join(AVATAR_DIR, filename), buffer);
  return `${AVATAR_URL_PREFIX}${filename}`;
}

/** 换头像时删掉旧文件（只动我们自己目录里的，失败也不影响主流程） */
async function removeAvatarFile(avatar) {
  // 存库格式是 `file:/avatars/xxx.png`，去掉前缀后再校验文件名
  const url = String(avatar ?? '').replace(/^file:/, '');
  if (!url.startsWith(AVATAR_URL_PREFIX)) return;
  const name = url.slice(AVATAR_URL_PREFIX.length);
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.includes('..')) return;
  try {
    await unlink(join(AVATAR_DIR, name));
  } catch {
    /* 文件不存在就忽略 */
  }
}

/** 静态提供头像文件 */
async function serveAvatar(req, res, pathname) {
  const name = decodeURIComponent(pathname.slice(AVATAR_URL_PREFIX.length));
  ensure(/^[A-Za-z0-9._-]+$/.test(name) && !name.includes('..'), 400, 'bad_avatar_name', '头像地址不合法');
  const target = normalize(join(AVATAR_DIR, name));
  ensure(target.startsWith(normalize(AVATAR_DIR)), 400, 'bad_avatar_name', '头像地址不合法');

  try {
    const body = await readFile(target);
    res.writeHead(200, {
      'Content-Type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': body.length,
      // 文件名里带随机串、内容永不变，可以放心长缓存
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    return res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404 Not Found');
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

async function serveStatic(req, res, pathname) {  let relative = decodeURIComponent(pathname).replace(/^\/+/, '');
  if (relative === '') relative = 'index.html';
  const target = normalize(join(PUBLIC_DIR, relative));
  const inside =
    target === PUBLIC_DIR || target.startsWith(PUBLIC_DIR + (process.platform === 'win32' ? '\\' : '/'));
  const candidates = inside && extname(target) ? [target] : [join(PUBLIC_DIR, 'index.html')];

  for (const candidate of candidates) {
    try {
      const body = await readFile(candidate);
      res.writeHead(200, {
        'Content-Type': MIME[extname(candidate).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': body.length,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',      });
      if (req.method === 'HEAD') return res.end();
      return res.end(body);
    } catch {
      /* 尝试下一个候选路径 */
    }
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404 Not Found');
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  res.on('finish', () => {
    if (process.env.QUIET !== '1') {
      console.log(`${req.method} ${pathname}${url.search} → ${res.statusCode} (${Date.now() - started}ms)`);
    }
  });

  try {
    if (pathname.startsWith('/api/')) {
      const { user, sessionToken } = resolveUser(req);
      const matched = routes.filter((entry) => entry.regex.test(pathname));
      ensure(matched.length > 0, 404, 'not_found', '接口不存在');
      const entry = matched.find((candidate) => candidate.method === req.method);
      ensure(entry, 405, 'method_not_allowed', '请求方法不被支持');

      const match = entry.regex.exec(pathname);
      const params = Object.fromEntries(entry.keys.map((key, index) => [key, match[index + 1]]));
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJsonBody(req) : {};
      await entry.handler({
        req,
        res,
        params,
        query: url.searchParams,
        body,
        user,
        sessionToken,
        ip: req.socket.remoteAddress || 'unknown',
      });
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Method Not Allowed');
    }
    if (pathname.startsWith(AVATAR_URL_PREFIX)) {
      return await serveAvatar(req, res, pathname);
    }
    // 笔记编辑器必须在 serveStatic 之前拦截：`/notes/` 没有扩展名，
    // 落到论坛的静态分发会被兜底成 SPA 的 index.html。
    if (pathname === '/notes' || pathname.startsWith('/notes/')) {
      const taken = await notes.serveStatic(req, res, pathname);
      if (taken !== false) return taken;
    }
    return await serveStatic(req, res, pathname);
  } catch (error) {
    const httpError =
      error instanceof HttpError ? error : new HttpError(500, 'internal_error', '服务器内部错误，请稍后再试');
    if (!(error instanceof HttpError)) {
      console.error('[error]', req.method, pathname, error);
    }
    if (!res.headersSent) {
      sendJson(res, httpError.status, {
        ok: false,
        error: { code: httpError.code, message: httpError.message },
      });
    } else {
      res.end();
    }
  }
});

// Mount note-studio（学术笔记子系统）。它是独立的包，`./notes.js` 是唯一的接线层：
// 注册它的路由、接管 `/notes/` 的静态资源，并加上论坛自己的规矩
// （按人分目录、默认私密、公开广场）。它不建表 —— 笔记是 data/notes/<用户id>/ 下的 .md/.json。
const notes = createNotes({
  dataDir: process.env.NOTES_DIR || defaultNotesDir(ROOT),
  userById: (id) => store.userById(id),
  resolveUser,
});

for (const entry of notes.routes) {
  route(entry.method, entry.pattern, async (ctx) => {
    // 写操作加一道粗粒度护栏（note-studio 内部还有它自己的限额）
    if (entry.method !== 'GET') rateLimit(`notes:${ctx.user?.id ?? ctx.ip}`, 60, 60 * 1000);
    const result = await entry.handler(ctx);
    return sendJson(ctx.res, result.status, result.body, result.headers ?? {});
  });
}

// Mount the AI reading assistant. `db` and `resolveUser` are already defined
// above; the mount layer creates its own ai_* tables (CREATE TABLE IF NOT
// EXISTS) and never writes to the host's tables.
mountForumAi({ db, resolveUser, quiet: false, scopeVocabulary: 'forum' }).attach(server);

// Mount 学术笔记整理 Agent。前缀**必须**显式给成 `/api/note-agent`：
// 它的默认值是 `/api/notes`，而那个前缀已经被上面 note-studio 的接线层占了，
// 且它命中即短路、连 404 都不回退 —— 用默认值会把笔记接口整棵吃掉。
// 它建自己的 notes_* 表（CREATE TABLE IF NOT EXISTS），不写论坛任何业务表。
mountNoteAgent({
  db,
  resolveUser,
  basePath: '/api/note-agent',
  quiet: false,
}).attach(server);

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  🗣️  围炉论坛已启动');
  console.log(`  → 本地访问: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`  → 数据库  : ${DB_FILE}`);
  if (seeded) {
    console.log(`  → 首次初始化: 写入 ${seeded.boards} 个板块 / ${seeded.users} 个示例用户`);
    console.log('  → 管理员  : admin / admin123   （示例账号：alice|bob|carol / demo1234）');
  } else if (backfilledNotifications) {
    console.log(`  → 数据升级完成: 回填 ${backfilledNotifications} 条消息通知 / 关注关系`);
  }
  console.log('');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n收到 ${signal}，正在关闭...`);
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
