// 管理后台：统计、用户与角色、隐藏帖子、审计日志。

import { $, emptyHtml, esc, loadingHtml, ui } from '../core/dom.js';
import { api } from '../core/api.js';
import { navigate } from '../core/router.js';
import { state } from '../core/state.js';
import * as Avatar from '../core/avatar.js';
import * as Fmt from '../core/format.js';

async function viewAdmin() {
  ui.app.innerHTML = loadingHtml();
  if (!state.me) {
    state.redirect = '/admin';
    navigate('/login');
    return;
  }
  if (!Fmt.isStaffUser(state.me)) {
    ui.app.innerHTML = `<div class="card">${emptyHtml('🚫', '需要管理员权限', '请联系站长为你开通')}</div>`;
    return;
  }

  const { stats, users, recentPosts, hiddenPosts, moderationLogs, viewer } = await api('/api/admin/overview');
  const iAmOwner = Boolean(viewer?.isOwner);
  const statCards = [
    ['用户', stats.users],
    ['帖子', stats.posts],
    ['已隐藏', stats.hiddenPosts ?? hiddenPosts.length],
    ['回复', stats.replies],
    ['评价总数', stats.reactions],
    ['投币总数', stats.coins],
    ['关注关系', stats.follows],
    ['收藏总数', stats.bookmarks],
    ['今日新帖', stats.postsToday],
    ['今日回复', stats.repliesToday],
    ['已封禁', stats.banned],
  ]
    .map(
      ([label, value]) =>
        `<div class="admin-stat"><div class="value">${Fmt.fmtNum(value)}</div><div class="label">${label}</div></div>`,
    )
    .join('');

  const userRows = users
    .map((user) => {
      const isSelf = user.id === state.me.id;
      const canGrant = iAmOwner && !isSelf && user.role !== 'owner';
      const roleAction = canGrant
        ? user.role === 'admin'
          ? `<button class="btn btn-sm" data-action="set-role" data-id="${user.id}" data-role="member" data-name="${esc(user.displayName)}">收回管理员</button>`
          : `<button class="btn btn-sm btn-primary" data-action="set-role" data-id="${user.id}" data-role="admin" data-name="${esc(user.displayName)}">设为管理员</button>`
        : user.role === 'owner'
          ? '<span class="hint">站长</span>'
          : '';
      const banAction = isSelf || user.role === 'owner'
        ? ''
        : user.banned
          ? `<button class="btn btn-sm" data-action="unban-user" data-id="${user.id}">解封</button>`
          : `<button class="btn btn-sm btn-danger" data-action="ban-user" data-id="${user.id}">封禁</button>`;

      return `
    <tr>
      <td>${Avatar.avatarHtml(user, 'avatar-sm')} ${esc(user.displayName)} ${Fmt.roleTag(user.role)}</td>
      <td>@${esc(user.username)}</td>
      <td>${user.postCount}</td>
      <td>${user.replyCount}</td>
      <td>${user.followerCount}</td>
      <td>🪙 ${user.coinBalance}</td>
      <td>${user.banned ? '<span class="tag tag-banned">已封禁</span>' : '<span class="tag">正常</span>'}</td>
      <td>
        <div class="row-actions">
          ${roleAction}
          ${banAction}
          ${isSelf && !roleAction && !banAction ? '<span class="hint">当前账号</span>' : ''}
        </div>
      </td>
    </tr>`;
    })
    .join('');

  const postRows = recentPosts
    .map(
      (post) => `
    <tr>
      <td class="wrap">
        <a href="#/post/${post.id}">${esc(post.title)}</a>
        ${post.hidden ? ' <span class="tag tag-hidden">🙈 已隐藏</span>' : ''}
      </td>
      <td>${esc(post.board)}</td>
      <td>${esc(post.author)}</td>
      <td>${post.views}</td>
      <td>${Fmt.timeAgo(post.createdAt)}</td>
      <td>
        <div class="row-actions">
          <button class="btn btn-sm" data-action="hide-post" data-id="${post.id}" data-hidden="${post.hidden ? '1' : '0'}" data-back="admin">
            ${post.hidden ? '👁 恢复' : '🙈 隐藏'}
          </button>
          <button class="btn btn-sm btn-danger" data-action="delete-post" data-id="${post.id}" data-back="admin">删除</button>
        </div>
      </td>
    </tr>`,
    )
    .join('');

  const hiddenRows = hiddenPosts.length
    ? hiddenPosts
        .map(
          (post) => `
      <tr>
        <td class="wrap"><a href="#/post/${post.id}">${esc(post.title)}</a></td>
        <td>${esc(post.author)}</td>
        <td>${esc(post.moderator ?? '—')}</td>
        <td>${esc(post.reason || '—')}</td>
        <td>${post.hiddenAt ? Fmt.timeAgo(post.hiddenAt) : '—'}</td>
        <td><button class="btn btn-sm" data-action="hide-post" data-id="${post.id}" data-hidden="1" data-back="admin">👁 恢复</button></td>
      </tr>`,
        )
        .join('')
    : '<tr><td colspan="6">没有被隐藏的文章</td></tr>';

  const ACTION_LABELS = {
    hide_post: '🙈 隐藏文章',
    unhide_post: '👁 恢复文章',
    delete_post: '🗑 删除文章',
    ban_user: '🚫 封禁用户',
    unban_user: '✅ 解封用户',
    grant_admin: '🛡️ 任命管理员',
    revoke_admin: '↩️ 收回管理员',
  };
  const logRows = moderationLogs.length
    ? moderationLogs
        .map(
          (log) => `
      <tr>
        <td>${esc(log.actor?.displayName ?? '（已注销）')}</td>
        <td>${ACTION_LABELS[log.action] ?? esc(log.action)}</td>
        <td class="wrap">${esc(log.targetLabel || `#${log.targetId}`)}</td>
        <td>${esc(log.reason || '—')}</td>
        <td>${Fmt.timeAgo(log.createdAt)}</td>
      </tr>`,
        )
        .join('')
    : '<tr><td colspan="5">还没有管理操作记录</td></tr>';

  ui.app.innerHTML = `
    <section class="page-head">
      <h1>🛠️ 管理后台</h1>
      <div class="page-sub">
        你是 <strong>${Fmt.roleLabel(viewer?.role ?? state.me.role)}</strong>。
        管理团队可以隐藏或删除违规文章；${iAmOwner ? '作为站长，你还可以任命或收回管理员。' : '任命管理员只有站长可以操作。'}
      </div>
    </section>

    <div class="admin-stats">${statCards}</div>

    <section class="card" style="padding:0">
      <div class="card-head" style="padding:16px 18px;margin:0;border-bottom:1px solid var(--border-soft)">
        <span class="card-title">👥 用户管理</span>
        <span class="hint">${iAmOwner ? '站长可以任命管理员' : '只有站长能任命管理员'}</span>
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>用户</th><th>账号</th><th>发帖</th><th>回复</th><th>粉丝</th><th>余额</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>${userRows}</tbody>
        </table>
      </div>
    </section>

    <section class="card" style="padding:0">
      <div class="card-head" style="padding:16px 18px;margin:0;border-bottom:1px solid var(--border-soft)">
        <span class="card-title">🙈 已隐藏的文章（${hiddenPosts.length}）</span>
        <span class="hint">隐藏可逆：访客看到 404，作者仍可查看</span>
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>标题</th><th>作者</th><th>操作人</th><th>原因</th><th>时间</th><th>操作</th></tr></thead>
          <tbody>${hiddenRows}</tbody>
        </table>
      </div>
    </section>

    <section class="card" style="padding:0">
      <div class="card-head" style="padding:16px 18px;margin:0;border-bottom:1px solid var(--border-soft)">
        <span class="card-title">🆕 最近发布</span>
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>标题</th><th>板块</th><th>作者</th><th>浏览</th><th>时间</th><th>操作</th></tr></thead>
          <tbody>${postRows || '<tr><td colspan="6">暂无数据</td></tr>'}</tbody>
        </table>
      </div>
    </section>

    <section class="card" style="padding:0">
      <div class="card-head" style="padding:16px 18px;margin:0;border-bottom:1px solid var(--border-soft)">
        <span class="card-title">📜 管理操作记录</span>
        <span class="hint">隐藏 / 删除 / 封禁 / 任命都会留痕</span>
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>操作人</th><th>动作</th><th>对象</th><th>原因</th><th>时间</th></tr></thead>
          <tbody>${logRows}</tbody>
        </table>
      </div>
    </section>`;
}

/* ------------------------------------------------------------------ */
/* 路由分发                                                            */

// ── 导出 ──────────────────────────────────────────────────────────────
export { viewAdmin };

/* @hand-written */
