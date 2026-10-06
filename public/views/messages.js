// 私信：会话列表与单条会话。

import { $, emptyHtml, esc, loadingHtml, ui } from '../core/dom.js';
import { api } from '../core/api.js';
import { navigate } from '../core/router.js';
import { state } from '../core/state.js';
import * as Avatar from '../core/avatar.js';
import * as Fmt from '../core/format.js';
import * as Session from '../core/session.js';
import * as Widgets from '../core/widgets.js';

async function viewMessages() {
  ui.app.innerHTML = loadingHtml();
  if (!state.me) {
    state.redirect = '/messages';
    navigate('/login');
    return;
  }
  const data = await api('/api/messages');
  state.messageUnread = data.unread ?? 0;

  const rows = data.items.length
    ? data.items
        .map(
          (item) => `
      <a class="dm-row ${item.unread > 0 ? 'is-unread' : ''}" href="#/messages/${encodeURIComponent(item.peer.username)}">
        ${Avatar.avatarHtml(item.peer, 'avatar-lg')}
        <div class="dm-row-main">
          <div class="dm-row-head">
            <span class="dm-row-name">${esc(item.peer.displayName)} ${Fmt.roleTag(item.peer.role)}</span>
            <span class="hint">${Fmt.timeAgo(item.lastMessage.createdAt)}</span>
          </div>
          <div class="dm-row-preview">
            ${item.lastMessage.mine ? '<span class="hint">我：</span>' : ''}${esc(item.lastMessage.content.slice(0, 60))}
          </div>
        </div>
        ${item.unread > 0 ? `<span class="menu-badge">${item.unread}</span>` : ''}
      </a>`,
        )
        .join('')
    : emptyHtml('✉️', '还没有私信', '去别人的主页点「私信」就能聊起来');

  const rules = data.rules ?? state.site.messageRules ?? { oneWayDailyLimit: 1 };
  ui.app.innerHTML = `
    <section class="page-head">
      <h1>✉️ 私信</h1>
      <div class="page-sub">
        互相关注 <strong>不限量</strong>；单方面关注每天 <strong>${rules.oneWayDailyLimit} 条</strong>；拉黑后无法互相私信。
      </div>
    </section>
    <section class="card" style="padding:0">
      <div class="dm-list">${rows}</div>
    </section>`;
  Session.renderUserArea();
}
async function viewThread(username) {
  ui.app.innerHTML = loadingHtml();
  if (!state.me) {
    state.redirect = `/messages/${username}`;
    navigate('/login');
    return;
  }
  const data = await api(`/api/messages/${encodeURIComponent(username)}`);
  const { peer, messages, availability } = data;
  void Session.refreshMessageUnread();

  const bubbles = messages.length
    ? messages
        .map(
          (item) => `
      <div class="dm-bubble ${item.senderId === state.me.id ? 'is-mine' : ''}">
        <div class="dm-bubble-body">${esc(item.content).replace(/\n/g, '<br />')}</div>
        <div class="dm-bubble-time">${Fmt.fullTime(item.createdAt)}${item.senderId === state.me.id ? (item.read ? ' · 已读' : ' · 未读') : ''}</div>
      </div>`,
        )
        .join('')
    : `<div class="dm-empty">还没有聊过天，打个招呼吧 👋</div>`;

  ui.app.innerHTML = `
    <section class="page-head">
      <h1>
        <a href="#/u/${encodeURIComponent(peer.username)}" class="dm-peer-link">
          ${Avatar.avatarHtml(peer, 'avatar-sm')} ${esc(peer.displayName)}
        </a>
        ${Fmt.roleTag(peer.role)}
      </h1>
      <div class="page-sub">
        <a href="#/messages">← 全部会话</a>
        ${Widgets.messageQuotaHtml(availability)}
      </div>
    </section>

    <section class="card dm-thread">
      <div class="dm-messages">${bubbles}</div>
      ${
        availability.canSend
          ? `<form class="dm-composer" data-action="send-message" data-username="${esc(peer.username)}">
               <textarea name="content" rows="2" maxlength="${(state.site.messageRules ?? {}).maxLength ?? 1000}"
                         placeholder="输入私信内容，Enter 发送 / Shift+Enter 换行" required></textarea>
               <button class="btn btn-primary" type="submit">发送</button>
               <div class="form-error" data-error hidden></div>
             </form>`
          : `<div class="dm-locked">
               ${Widgets.messageQuotaHtml(availability)}
               <span class="hint">${esc(availability.message)}</span>
             </div>`
      }
    </section>`;
  Session.renderUserArea();
  const box = document.querySelector('.dm-messages');
  if (box) box.scrollTop = box.scrollHeight;
  const textarea = document.querySelector('.dm-composer textarea');
  if (textarea) textarea.focus();
}

/* ------------------------------------------------------------------ */
/* 视图：帖子详情                                                      */

// ── 导出 ──────────────────────────────────────────────────────────────
export { viewMessages };
export { viewThread };

/* @hand-written */
