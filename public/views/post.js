// 帖子详情页：正文、评价栏、转发列表、回复。

import { $, emptyHtml, esc, loadingHtml, ui } from '../core/dom.js';
import { api } from '../core/api.js';
import { state } from '../core/state.js';
import * as Ai from './ai.js';
import * as Avatar from '../core/avatar.js';
import * as Fmt from '../core/format.js';

/**
 * 一条回复。
 *
 * `opts.deleteAction`：删除按钮的接线。默认走 `core/events.js` 的
 * `data-action="delete-reply"` —— 它删完会 `Post.viewPost()` 回到帖子页。
 * 积木页复用同一张卡片，但删完要**留在积木页**（那里没有帖子路由可回），
 * 所以那边传 `'reply-delete'`，改由 `views/doc.js` 自己的 `data-doc-action` 接。
 */
function replyHtml(reply, post, opts = {}) {
  const canDelete =
    state.me && (state.me.id === reply.author.id || state.me.id === post.author.id || Fmt.isStaffUser(state.me));
  const deleteAttr = opts.deleteAction
    ? `data-doc-action="${esc(opts.deleteAction)}"`
    : 'data-action="delete-reply"';
  return `
    <div class="reply" id="reply-${reply.id}">
      ${Avatar.avatarHtml(reply.author)}
      <div class="reply-body">
        <div class="reply-head">
          <a class="reply-author" href="#/u/${encodeURIComponent(reply.author.username)}">${esc(reply.author.displayName)}</a>
          ${Fmt.roleTag(reply.author.role)}
          ${reply.author.id === post.author.id ? '<span class="tag tag-soft">楼主</span>' : ''}
          <span title="${Fmt.fullTime(reply.createdAt)}">${Fmt.timeAgo(reply.createdAt)}</span>
          <span class="reply-actions">
            ${canDelete ? `<button class="link-btn" ${deleteAttr} data-id="${reply.id}" data-post="${post.id}">删除</button>` : ''}
          </span>
        </div>
        <div class="md">${reply.contentHtml}</div>
      </div>
    </div>`;
}
function reactionBarHtml(post) {
  const isAuthor = state.me && state.me.id === post.author.id;

  return `
    <div class="action-bar">
      <button class="btn btn-sm reaction ${post.liked ? 'is-on' : ''}" data-action="reaction" data-kind="like" data-id="${post.id}" title="觉得有用就点个赞">
        👍 <span data-like-label>${post.liked ? '已赞' : '赞'}</span> <span data-like-count>${post.likeCount}</span>
      </button>
      <button class="btn btn-sm reaction ${post.disliked ? 'is-on-danger' : ''}" data-action="reaction" data-kind="dislike" data-id="${post.id}" title="觉得没帮助可以踩">
        👎 <span data-dislike-label>${post.disliked ? '已踩' : '踩'}</span> <span data-dislike-count>${post.dislikeCount}</span>
      </button>
      <button class="btn btn-sm ${post.bookmarked ? 'is-on' : ''}" data-action="bookmark" data-id="${post.id}">
        ${post.bookmarked ? '★ 已收藏' : '☆ 收藏'} <span data-bookmark-count>${post.bookmarkCount}</span>
      </button>
      <button class="btn btn-sm ${post.reposted ? 'is-on-repost' : ''}" data-action="repost-toggle" data-id="${post.id}"
              title="${post.reposted ? '撤销我的转发' : '把这篇转发到我的主页'}">
        🔁 ${post.reposted ? '已转发' : '转发'} <span data-repost-count>${post.repostCount}</span>
      </button>
      <button class="btn btn-sm btn-ghost" data-action="copy-link" data-id="${post.id}" title="复制链接分享给站外的人">🔗 复制链接</button>
      ${
        state.me && !isAuthor
          ? `<button class="btn btn-sm ${post.authorFollowed ? 'is-on' : ''}" data-action="follow" data-user="${post.author.id}" data-name="${esc(post.author.displayName)}">
               ${post.authorFollowed ? '✓ 已关注作者' : '＋ 关注作者'}
             </button>`
          : ''
      }
      <span class="spacer"></span>
      ${isAuthor ? `<a class="btn btn-sm" href="#/edit/${post.id}">✏️ 编辑</a>` : ''}
      ${
        state.me && Fmt.isStaffUser(state.me)
          ? `<button class="btn btn-sm ${post.hidden ? 'is-on' : ''}" data-action="hide-post" data-id="${post.id}" data-hidden="${post.hidden ? '1' : '0'}"
                     title="隐藏后文章对普通访客和搜索引擎都不可见，可随时恢复">${post.hidden ? '👁 恢复显示' : '🙈 隐藏'}</button>`
          : ''
      }
      ${
        state.me && (isAuthor || Fmt.isStaffUser(state.me))
          ? `<button class="btn btn-sm btn-danger" data-action="delete-post" data-id="${post.id}">🗑 删除</button>`
          : ''
      }
    </div>`;
}

/**
 * 转发区块：转发表单 + 转发列表。
 *
 * `opts.docMode` 是给积木页（`#/doc/:id`）用的，两个差别：
 *   1. core 的转发提交 / 撤销处理完都会 `Post.viewPost()` 把人甩回帖子页，
 *      而积木页必须留在积木页 —— 所以改挂 `data-doc-form` / `data-doc-action`，
 *      由 `views/doc.js` 自己的委托接。
 *   2. 外壳从 `section.card` 换成 `section.repost-block`：积木页那块本来就长在
 *      `.doc-interact` 这张卡片里，再套一层卡片会出双边框。
 * `id="repost-section"` 两边都留着 —— `core/events.js` 那颗互动条上的「🔁 转发」
 * 就是靠它找输入框的（一次只渲染一个路由，页面上不会有两个）。
 */
function repostSectionHtml(post, reposters, opts = {}) {
  const mine = reposters.find((item) => item.user.id === state.me?.id) ?? null;
  const formAttr = opts.docMode ? 'data-doc-form="repost"' : 'data-action="repost"';
  const cancelAttr = opts.docMode ? 'data-doc-action="repost-cancel"' : 'data-action="repost-cancel"';
  const wrapperClass = opts.docMode ? 'repost-block' : 'card';
  const list = reposters.length
    ? `<div class="repost-list">${reposters
        .map(
          (item) => `
        <div class="repost-item">
          ${Avatar.avatarHtml(item.user, 'avatar-sm')}
          <div class="repost-body">
            <div class="repost-head">
              <a class="reply-author" href="#/u/${encodeURIComponent(item.user.username)}">${esc(item.user.displayName)}</a>
              ${Fmt.roleTag(item.user.role)}
              <span title="${Fmt.fullTime(item.createdAt)}">${Fmt.timeAgo(item.createdAt)} 转发</span>
            </div>
            ${item.comment ? `<div class="repost-comment">${esc(item.comment)}</div>` : '<div class="hint">（仅转发，没有附加评论）</div>'}
          </div>
        </div>`,
        )
        .join('')}</div>`
    : '<div class="hint">还没有人转发，你可以抢第一个。</div>';

  // 自己的文章也能转发（服务端不再拦 self_repost）：对自己来说「转发」就是把它放进
  // 主页的「🔁 转发」分类，等于给自己置顶，没有理由只给自己看一句「不用转发」。
  const form = state.me
    ? `<form class="form repost-form" ${formAttr} data-id="${post.id}">
           <div class="field">
             <textarea name="comment" maxlength="300" rows="2"
                       placeholder="${mine ? '修改你的转发语…' : '说点什么再转发（可留空直接转发）'}">${esc(mine?.comment ?? '')}</textarea>
             <span class="hint">转发会作为一条新动态发到动态流，同时进你主页的「🔁 转发」分类（点主页那颗「🔁 转发」标签就能看到）${state.me.id === post.author.id ? '' : '，并通知作者'}；同一篇只能转发一次，可随时撤销。</span>
           </div>
           <div class="form-error" data-error hidden></div>
           <div class="form-actions">
             <button class="btn btn-primary" type="submit">${mine ? '更新转发语' : '确认转发'}</button>
             ${mine ? `<button class="btn" type="button" ${cancelAttr} data-id="${post.id}">撤销转发</button>` : ''}
           </div>
         </form>`
    : '<div class="hint">登录后可以转发这篇文章。</div>';

  return `
    <section class="${wrapperClass}" id="repost-section">
      <div class="card-head">
        <span class="card-title">🔁 转发（${reposters.length}）</span>
        <button class="btn btn-sm btn-ghost" type="button" data-action="copy-link" data-id="${post.id}">🔗 复制链接</button>
      </div>
      ${form}
      <div style="margin-top:14px">${list}</div>
    </section>`;
}
/**
 * 「这一篇已经搬进积木了」。
 *
 * 帖子页现在是被弃用的入口：新东西都写进积木（`#/doc/:id`）。但旧链接、旧收藏、
 * 列表卡片点进来还是这条路，所以**不能把帖子页关掉**，只能在顶上挂一条横幅，
 * 把读者送到真正该去的地方 —— 积木页上的正文、点赞、收藏和 AI 解读
 * 就是从这里搬过去的（阅读页的互动条直接打在锚点行上）。
 */
function movedNoteHtml(doc) {
  return `<div class="doc-moved-banner">
    <span class="doc-moved-icon">🧩</span>
    <div class="doc-moved-text">
      <strong>这一篇已经搬进积木了</strong>
      <div class="hint">正文、点赞、收藏和 AI 解读都在积木页上。这里留着的只是它的「影子」（旧链接还能点进来）。</div>
    </div>
    <a class="btn btn-sm btn-primary" href="#/doc/${esc(doc.id)}">去积木页 →</a>
  </div>`;
}

async function viewPost(id) {
  ui.app.innerHTML = loadingHtml();
  const [{ post, replies, reposters }, aiInfo, moved] = await Promise.all([
    api(`/api/posts/${id}`),
    api(`/api/ai/posts/${id}`).catch(() => ({ cached: null, stale: false })),
    // 反查这篇帖子是不是某篇积木的影子行。影子行的可见性跟着文档 scope 走，
    // 列表里能看见它就说明读者本来就有权看，所以这里拿不到也只是「不是影子行」。
    api(`/api/docs/by-anchor/${id}`).catch(() => ({ doc: null })),
  ]);
  const movedDoc = moved?.doc ?? null;

  ui.app.innerHTML = `
    <article class="card">
      ${movedDoc ? movedNoteHtml(movedDoc) : ''}
      ${
        post.hidden
          ? `<div class="moderation-banner">
               <span class="moderation-icon">🙈</span>
               <div>
                 <strong>这篇文章已被${post.hiddenBy && state.me && post.hiddenBy === state.me.id ? '你' : '管理团队'}隐藏</strong>
                 <div class="hint">
                   ${post.hiddenReason ? `原因：${esc(post.hiddenReason)} · ` : ''}
                   隐藏期间普通访客访问会看到 404，且不出现在列表与搜索里，只有作者本人和管理团队可见。
                 </div>
               </div>
               ${
                 state.me && Fmt.isStaffUser(state.me)
                   ? `<button class="btn btn-sm" data-action="hide-post" data-id="${post.id}" data-hidden="1">👁 恢复显示</button>`
                   : ''
               }
             </div>`
          : ''
      }
      <div class="post-detail-head">
        ${Avatar.avatarHtml(post.author, 'avatar-lg')}
        <div style="min-width:0;flex:1">
          <div class="post-tags">
            <a class="tag" href="#/board/${esc(post.board.slug)}">${post.board.icon} ${esc(post.board.name)}</a>
            ${post.pinned ? '<span class="tag tag-pin">📌 置顶</span>' : ''}
            ${post.locked ? '<span class="tag">🔒 已锁定</span>' : ''}
            ${post.authorFollowed ? '<span class="tag tag-follow">✓ 已关注作者</span>' : ''}
          </div>
          <h1 class="post-detail-title">${esc(post.title)}</h1>
          <div class="post-detail-meta">
            <a href="#/u/${encodeURIComponent(post.author.username)}">${esc(post.author.displayName)}</a>
            ${Fmt.roleTag(post.author.role)}
            <span>·</span>
            <span title="${Fmt.fullTime(post.createdAt)}">发布于 ${Fmt.timeAgo(post.createdAt)}</span>
            ${post.updatedAt - post.createdAt > 60000 ? `<span>· 已编辑于 ${Fmt.timeAgo(post.updatedAt)}</span>` : ''}
            <span>·</span>
            <span>👁 ${post.views} 次浏览</span>
          </div>
        </div>
      </div>

      <div class="md" style="margin-top:18px">${post.contentHtml}</div>

      ${Ai.aiPostPanelHtml(post, aiInfo)}

      ${state.me ? reactionBarHtml(post) : `<div class="action-bar">
        <a class="btn btn-sm btn-primary" href="#/login">登录后可以评价和关注作者</a>
        <span class="spacer"></span>
        <span class="post-meta"><span>👍 ${post.likeCount}</span><span>👎 ${post.dislikeCount}</span><span>⭐ ${post.bookmarkCount}</span><span>🔁 ${post.repostCount}</span></span>
      </div>`}
    </article>

    <section class="card" style="padding:0">
      <div class="card-head" style="padding:16px 18px;margin:0;border-bottom:1px solid var(--border-soft)">
        <span class="card-title">💬 全部回复（${replies.length}）</span>
        ${post.locked ? '<span class="tag">🔒 该帖已锁定</span>' : ''}
      </div>
      ${replies.length ? replies.map((reply) => replyHtml(reply, post)).join('') : emptyHtml('💭', '还没有人回复', '来抢占沙发吧')}
    </section>

    <section class="card">
      <div class="card-head"><span class="card-title">✍️ 发表回复</span></div>
      ${
        !state.me
          ? `<div class="hint" style="margin-bottom:12px">登录后即可参与讨论。</div>
             <div class="form-actions">
               <a class="btn btn-primary" href="#/login">登录</a>
               <a class="btn" href="#/register">注册新账号</a>
             </div>`
          : post.locked && state.me.role !== 'admin'
            ? '<div class="hint">该帖子已锁定，暂时无法回复。</div>'
            : `<form class="form" data-action="reply" data-id="${post.id}">
                 <div class="field">
                   <textarea name="content" placeholder="写下你的想法…（支持 Markdown，@某人 可以提醒 TA）" required maxlength="5000"></textarea>
                   <span class="hint">支持 粗体、行内代码、代码块、引用、列表、链接与 @提及</span>
                 </div>
                 <div class="form-error" data-error hidden></div>
                 <div class="form-actions">
                   <button class="btn btn-primary" type="submit">发表回复</button>
                   <button class="btn btn-ghost" type="button" data-action="preview" data-target="reply">预览</button>
                 </div>
                 <div class="preview-box" data-preview hidden></div>
               </form>`
      }
    </section>

    ${repostSectionHtml(post, reposters)}`;
}

/* ------------------------------------------------------------------ */
/* 视图：发帖 / 编辑                                                   */

// ── 导出 ──────────────────────────────────────────────────────────────
export { replyHtml };
export { reactionBarHtml };
export { repostSectionHtml };
export { viewPost };

/* @hand-written */
