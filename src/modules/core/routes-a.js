// core 路由：认证 / 资料 / 头像 / 密码 / 个人主页分类
// // 搬运自 src/server.js 的固定行区间（预铺骨架，逐字未改），见 docs/tools/extract-server-modules.mjs。
import { HttpError, ensure, field, ok, rateLimit, res_ } from '../../core/http.js';
import { assertPinAllowed, notifyMentions, resolveOwnCategory, shapeAuthor, shapeCategory, shapeConversation, shapeMessage, shapeNotification, shapePerson, shapePostDetail, shapePostListRow, shapeProfile, shapeReply, shapeReposter, shapeUser } from '../../core/shape.js';
import { isOwner, isStaff, requireOwner, requireStaff, requireUser } from '../../core/guards.js';
import { issueSession, removeAvatarFile, saveAvatarFile, sessionCookie } from '../../core/sessions.js';
import { store } from '../../core/store.js';
import { MAX_AVATAR_BYTES } from '../../core/paths.js';
import { renderMarkdown, markdownToPlainText } from '../../markdown.js';
import { hashPassword, verifyPassword } from '../../password.js';
import { forumAiStatus, noteAgentStatus } from '../../core/mount-status.js';

/** 登记本文件负责的路由。 */
export function registerRoutesA(route) {
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
    ok(res_(ctx), { user: shapeUser(store.userById(user.id)) }, { 'Set-Cookie': sessionCookie(token) });
  });

  route('POST', '/api/auth/logout', async (ctx) => {
    if (ctx.sessionToken) store.deleteSession(ctx.sessionToken);
    ok(res_(ctx), { loggedOut: true }, { 'Set-Cookie': sessionCookie('', 0) });
  });

  route('GET', '/api/auth/me', async (ctx) => {
    if (!ctx.user) return ok(res_(ctx), { user: null, unread: 0 });
    const fresh = store.userById(ctx.user.id) ?? ctx.user;
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
      profileRules: store.PROFILE_RULES,
      messageRules: store.MESSAGE_RULES,
      hotPosts: store.hotPosts(5).map((row) => ({
        id: row.id,
        title: row.title,
        replyCount: row.reply_count,
        likeCount: row.like_count,
      })),
    });
  });

}
