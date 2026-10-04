// 搬运自 src/server.js 的固定行区间（预铺骨架，逐字未改），见 docs/tools/extract-server-modules.mjs。
import { ensure } from './http.js';

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
export { isOwner, isStaff, requireUser, requireStaff, requireOwner, assertPostVisible };
