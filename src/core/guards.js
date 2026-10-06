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
 * 「这篇帖子谁能看」的额外判定（可注入，只做**放行**）。
 *
 * 为什么要有这个口子：积木的互动（赞 / 踩 / 投币 / 收藏 / 通知）全部认 `posts` 的行，
 * 靠一条影子行复用 core 的接口。而影子行的 `hidden` 只由文档的可见范围决定，
 * core 又只认 `hidden` —— 于是「仅关注我的人」「仅团队」的积木，关注者点不了赞（404）。
 *
 * 让它由业务模块**登记**一条判定，比在 core 里 import 业务模块
 * （骨架规矩不许）或把互动接口复制一份到 doc 里都干净。
 * 谁都不认，还是 404。
 */
const postVisibility = [];

/** 登记一条可见性判定：`fn(post, ctx)` 回 true = 这篇对当前访客可见。 */
function addPostVisibility(fn) {
  if (typeof fn === 'function') postVisibility.push(fn);
}

/**
 * 隐藏的文章对普通访客和搜索引擎都不存在：
 * 只有站务、作者本人，或**登记过的判定**放行的人能打开，其它人一律按「不存在」处理。
 */
function assertPostVisible(post, ctx) {
  if (!post.hidden) return;
  const viewer = ctx.user;
  const allowed = viewer && (isStaff(viewer) || viewer.id === post.author_id);
  ensure(
    allowed || postVisibility.some((fn) => fn(post, ctx)),
    404,
    'post_not_found',
    '帖子不存在或已被删除',
  );
}
export { isOwner, isStaff, requireUser, requireStaff, requireOwner, assertPostVisible, addPostVisibility };
