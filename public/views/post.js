// 帖子详情页：正文、评价栏、转发列表、回复。
//
// **这个页面已经不渲染了**（帖子功能整体下线，见 README「帖子功能下线」一节）：
// 路由仍留着 `#/post/:id`，但 `viewPost()` 只做一件事 —— 把读者送到对应的积木页。
// 这个文件里还活着的三样东西是**给积木页复用的零件**：
// `replyHtml`、`reactionBarHtml`、`repostSectionHtml`（`views/doc.js` 的互动条）。
// 留着它们而不是搬进 doc.js，是因为搬一遍就是一次无谓的回归风险。

import { esc, loadingHtml, toast, ui } from '../core/dom.js';
import { api } from '../core/api.js';
import { state } from '../core/state.js';
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
function reactionBarHtml(post, opts = {}) {
  const isAuthor = state.me && state.me.id === post.author.id;
  // 积木页复用这条互动条时（`opts.docMode`）压掉两个按钮：
  // 「✏️ 编辑」指向 `#/edit/:postId`、「🗑 删除」删的是那篇影子帖 ——
  // 都是通往帖子功能的门，而积木页自己那张卡片顶上（`views/doc.js` 的
  // `docActionsHtml`）本来就有「编辑 / 删除」，改的是积木本身。留着只会误导。
  const postDoors = !opts.docMode;

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
      ${isAuthor && postDoors ? `<a class="btn btn-sm" href="#/edit/${post.id}">✏️ 编辑</a>` : ''}
      ${
        state.me && Fmt.isStaffUser(state.me)
          ? `<button class="btn btn-sm ${post.hidden ? 'is-on' : ''}" data-action="hide-post" data-id="${post.id}" data-hidden="${post.hidden ? '1' : '0'}"
                     title="隐藏后文章对普通访客和搜索引擎都不可见，可随时恢复">${post.hidden ? '👁 恢复显示' : '🙈 隐藏'}</button>`
          : ''
      }
      ${
        postDoors && state.me && (isAuthor || Fmt.isStaffUser(state.me))
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
 * 这篇帖子对应的积木是哪一篇？没有就返回 null。
 *
 * 帖子与积木是两张表，只有文档知道自己锚在哪篇帖子上（`documents.anchor_post_id`），
 * 所以这件事只能反查。影子行的可见性跟着文档 scope 走：看不见的文档反查不到，
 * 于是也不会把人送进一篇他本来就无权读的积木。
 */
async function docOfPost(postId) {
  if (!Number.isInteger(postId) || postId <= 0) return null;
  return api(`/api/docs/by-anchor/${postId}`)
    .then((data) => data?.doc ?? null)
    .catch(() => null);
}

/**
 * 帖子页 —— 现在只做一件事：把读者送到这篇帖子对应的积木页。
 *
 * 帖子功能整体下线，站内**一切**指向 `#/post/:id` 的链接（旧收藏、动态流里
 * 的引用卡、通知、搜索结果、管理后台的列表……）都汇到这一个函数里，
 * 所以重定向只写在这一处 —— 别的入口一个都不用动，也就不存在漏网的通道。
 *
 * 反查不到积木说明这篇帖子还没被迁进积木（理论上启动时的一次性迁移已经把
 * 活帖都补过了，见 `src/modules/doc/store.js` 的 `migrateLegacyPosts`），
 * 这时也不能停在一个已经废除的页面上，只能请人去广场。
 */
async function viewPost(id) {
  ui.app.innerHTML = loadingHtml();
  const doc = await docOfPost(Number(id));
  if (doc) {
    location.replace(`#/doc/${doc.id}`);
    return;
  }
  ui.app.innerHTML = `<article class="card">
    <div class="page-head"><h1>这篇帖子没有对应的积木</h1></div>
    <p class="hint">帖子功能已经下线：新内容一律写在积木里，老帖也已经各自搬成了一篇积木。这一篇可能已经被删掉了。</p>
    <div class="form-actions"><a class="btn btn-primary" href="#/docs">去积木广场 →</a></div>
  </article>`;
}

/**
 * 老的「编辑帖子」地址（`#/edit/:id`）：同样改道它对应的积木编辑器。
 *
 * 编辑入口只剩积木一条路 —— 帖子写接口已经整体返回 410，把作者留在一个
 * 点不动的表单上才是真的坏体验。
 */
async function viewLegacyEdit(id) {
  ui.app.innerHTML = loadingHtml();
  const doc = await docOfPost(Number(id));
  if (doc) {
    toast('帖子已经搬进积木了，这里是它的编辑器');
    location.replace(`#/doc/${doc.id}/edit`);
    return;
  }
  toast('帖子功能已经下线，去积木广场新建一篇吧', 'error');
  location.replace('#/docs');
}

/* ------------------------------------------------------------------ */
/* 视图：帖子链接一律改道积木                                          */

// ── 导出 ──────────────────────────────────────────────────────────────
export { replyHtml };
export { reactionBarHtml };
export { repostSectionHtml };
export { viewPost };
export { viewLegacyEdit };

/* @hand-written */
