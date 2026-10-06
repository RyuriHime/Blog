// 通知中心。

import { $, emptyHtml, esc, loadingHtml, ui } from '../core/dom.js';
import { api } from '../core/api.js';
import { navigate, routeQuery } from '../core/router.js';
import { state } from '../core/state.js';
import * as Fmt from '../core/format.js';
import * as Session from '../core/session.js';
import * as Widgets from '../core/widgets.js';

const NOTIF_META = {
  post_reply: { icon: '💬', text: '回复了你的帖子' },
  post_repost: { icon: '🔁', text: '转发了你的文章' },
  post_like: { icon: '👍', text: '赞了你的帖子' },
  post_dislike: { icon: '👎', text: '踩了你的帖子' },
  follow: { icon: '👥', text: '关注了你' },
  mention: { icon: '📣', text: '在内容里 @ 了你' },
  following_post: { icon: '🆕', text: '发布了新帖子' },
  // 团队公告：团队成员才会收到（发给全队时一个人一条，不做未读合并）。
  team_announcement: { icon: '🎽', text: '发布了团队公告' },
  // 加入申请这三条：「需要申请」的团队才有。
  // 申请那条是发给团长和管理员的（申请人是 actor），批/拒那两条发给申请人（审批人是 actor）。
  team_join_request: { icon: '🙋', text: '申请加入你的团队' },
  team_join_approved: { icon: '✅', text: '通过了你的加入申请' },
  team_join_rejected: { icon: '🚫', text: '拒绝了你的加入申请' },
  moderation: { icon: '🛡️', text: '管理操作' },
  message: { icon: '✉️', text: '给你发了私信' },
  system: { icon: '📢', text: '系统消息' },
};
function notifTarget(item) {
  // 私信直接跳到会话
  if (item.type === 'message' && item.actor) return `#/messages/${encodeURIComponent(item.actor.username)}`;
  if (item.type === 'follow' && item.actor) return `#/u/${encodeURIComponent(item.actor.username)}`;
  // 团队公告点进团队主页（公告就挂在主页上）。团队已被解散就不跳了，退回发公告的人的主页。
  if (item.type === 'team_announcement' && item.team && !item.team.deleted) {
    return `#/team/${encodeURIComponent(item.team.slug)}`;
  }
  // 加入申请这三条也跳团队主页：申请人进去看「⏳ 申请审核中」，管理员进去审。
  if (
    (item.type === 'team_join_request' || item.type === 'team_join_approved' || item.type === 'team_join_rejected') &&
    item.team &&
    !item.team.deleted
  ) {
    return `#/team/${encodeURIComponent(item.team.slug)}`;
  }
  if (item.post && !item.post.deleted) return `#/post/${item.post.id}`;
  if (item.actor) return `#/u/${encodeURIComponent(item.actor.username)}`;
  return null;
}
/*
 * 【别把 `notif-actor` 改回链接】整条通知本身就是一个 `<a>`（下面那个 `notif-item`）。
 * HTML 解析器遇到「已经有一个 `<a>` 开着时再来一个 `<a>` 起始标签」会**隐含闭合外层**，
 * 于是外层链接只包住最前面那个图标方块、后面的正文全掉到链接外面去 ——
 * 这一版的通知列表就是这么坏掉的：每条只剩一个 30px 的图标，正文全跑到卡片左边缘堆着。
 * 想让人名可点，只能换个做法（例如整条不套 `<a>`、改用 `data-action` 跳转），
 * 不能靠往里塞第二个 `<a>`。
 */
function notifHtml(item) {
  const meta = NOTIF_META[item.type] ?? { icon: '🔔', text: '有新消息' };
  const target = notifTarget(item);
  const body = `
    <div class="notif-icon">${meta.icon}</div>
    <div class="notif-main">
      <div class="notif-line">
        <span class="notif-actor">${item.actor ? esc(item.actor.displayName) : '系统'}</span>
        <span class="notif-action">${meta.text}</span>
      </div>
      ${
        item.type === 'moderation' || item.type === 'system' || item.type === 'message' || item.type === 'team_announcement'
          || item.type === 'team_join_request' || item.type === 'team_join_approved' || item.type === 'team_join_rejected'
          ? item.excerpt
            ? `<div class="notif-excerpt">${esc(item.excerpt)}</div>`
            : ''
          : item.post?.title
            ? `<div class="notif-excerpt">${esc(item.post.title)}${item.post.deleted ? '（已删除）' : ''}</div>`
            : item.excerpt
              ? `<div class="notif-excerpt">${esc(item.excerpt)}</div>`
              : ''
      }
      <div class="notif-time">${Fmt.timeAgo(item.createdAt)}</div>
    </div>
    ${item.read ? '' : '<span class="notif-dot" title="未读"></span>'}`;

  return target
    ? `<a class="notif-item ${item.read ? '' : 'is-unread'}" href="${target}" data-action="open-notification" data-id="${item.id}">${body}</a>`
    : `<div class="notif-item ${item.read ? '' : 'is-unread'}" data-action="read-notification" data-id="${item.id}">${body}</div>`;
}
async function viewNotifications(query) {
  ui.app.innerHTML = loadingHtml();
  if (!state.me) {
    state.redirect = '/notifications';
    navigate('/login');
    return;
  }
  const filter = query.get('filter') === 'unread' ? 'unread' : 'all';
  const page = Math.max(1, Number(query.get('page') || 1));
  const data = await api(`/api/notifications?filter=${filter}&page=${page}&perPage=20`);
  state.unread = data.unreadCount;

  const tabs = [
    ['all', `全部 ${filter === 'all' ? `(${data.total})` : ''}`],
    ['unread', '只看未读'],
  ]
    .map(([key, label]) => {
      const params = new URLSearchParams(query.toString());
      if (key === 'unread') params.set('filter', 'unread');
      else params.delete('filter');
      params.delete('page');
      const qs = params.toString();
      return `<a class="tab ${filter === key ? 'is-active' : ''}" href="#/notifications${qs ? `?${qs}` : ''}">${label}</a>`;
    })
    .join('');

  ui.app.innerHTML = `
    <section class="card">
      <div class="card-head" style="margin-bottom:4px">
        <h1 style="font-size:20px">🔔 消息通知</h1>
        ${data.unreadCount > 0 ? `<button class="btn btn-sm" data-action="read-all">全部标为已读（${data.unreadCount}）</button>` : '<span class="tag">已全部读完</span>'}
      </div>
      <div class="page-sub">有人回复、评价、关注你或 @ 你时，这里会收到提醒。</div>
      <div class="tabs" style="margin-top:12px">${tabs}</div>
    </section>

    <section class="card" style="padding:0">
      <div class="notif-list">
        ${data.items.length ? data.items.map(notifHtml).join('') : emptyHtml('📭', filter === 'unread' ? '没有未读消息' : '还没有任何消息', '多参与讨论就会有啦')}
      </div>
      ${Widgets.paginationHtml(data.page, data.totalPages, (target) => routeQuery('/notifications', query, { page: target }))}
    </section>`;
  Session.renderUserArea();
  Session.renderSidebar();
}

/* ------------------------------------------------------------------ */
/* 视图：私信                                                          */
/* ------------------------------------------------------------------ */

/** 一天一条的限制进度条文案 */

// ── 导出 ──────────────────────────────────────────────────────────────
export { NOTIF_META };
export { notifTarget };
export { notifHtml };
export { viewNotifications };

/* @hand-written */
