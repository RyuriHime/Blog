// core 路由：消息通知 / 管理后台
// // 搬运自 src/server.js 的固定行区间（预铺骨架，逐字未改），见 docs/tools/extract-server-modules.mjs。
import { HttpError, ensure, field, ok, rateLimit, res_ } from '../../core/http.js';
import { assertPinAllowed, coinAvailability, notifyMentions, resolveOwnCategory, shapeAuthor, shapeCategory, shapeConversation, shapeMessage, shapeNotification, shapePerson, shapePostDetail, shapePostListRow, shapeProfile, shapeReply, shapeReposter, shapeUser } from '../../core/shape.js';
import { isOwner, isStaff, requireOwner, requireStaff, requireUser } from '../../core/guards.js';
import { issueSession, removeAvatarFile, saveAvatarFile, sessionCookie } from '../../core/sessions.js';
import { store } from '../../core/store.js';
import { MAX_AVATAR_BYTES } from '../../core/paths.js';
import { renderMarkdown, markdownToPlainText } from '../../markdown.js';
import { hashPassword, verifyPassword } from '../../password.js';

/** 登记本文件负责的路由。 */
export function registerRoutesD(route) {
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
}
