// 通用界面零件：帖子卡片（列表/卡片/紧凑三种布局）、分页、排序页签、版块下拉、
// 作者工具条、徽章、统计行、公式说明卡、私信配额提示。
// 五路并行时，这些是**共享**零件 —— 要改先看别人用没用到。

import { $, emptyHtml, esc } from './dom.js';
import { state } from './state.js';
import * as Avatar from './avatar.js';
import * as Fmt from './format.js';

function postBadgesHtml(post) {
  return `
    ${post.hidden ? '<span class="tag tag-hidden">🙈 已隐藏</span>' : ''}
    ${post.repost ? '<span class="tag tag-repost">🔁 转发</span>' : ''}
    ${post.profilePinned ? '<span class="tag tag-pin">📌 置顶推荐</span>' : ''}
    ${post.pinned ? '<span class="tag tag-pin">📌 全局置顶</span>' : ''}
    <a class="tag" href="#/board/${esc(post.board.slug)}">${post.board.icon} ${esc(post.board.name)}</a>
    ${post.category ? `<span class="tag tag-category">🗂 ${esc(post.category.name)}</span>` : ''}
    ${post.locked ? '<span class="tag">🔒 已锁定</span>' : ''}
    ${post.authorFollowed ? '<span class="tag tag-follow">✓ 已关注</span>' : ''}
    ${Fmt.roleTag(post.author.role)}`;
}
function postMetaStatsHtml(post) {
  return `
    <a class="meta-strong" href="#/u/${encodeURIComponent(post.author.username)}">${esc(post.author.displayName)}</a>
    <span>·</span>
    <span title="${Fmt.fullTime(post.createdAt)}">${Fmt.timeAgo(post.lastActiveAt ?? post.createdAt)}</span>
    <span class="spacer"></span>
    <span class="meta-item" title="点赞">👍 ${Fmt.fmtNum(post.likeCount)}</span>
    <span class="meta-item ${post.disliked ? 'is-dim' : ''}" title="踩">👎 ${Fmt.fmtNum(post.dislikeCount)}</span>
    <span class="meta-item" title="浏览">👁 ${Fmt.fmtNum(post.views)}</span>
    <span class="meta-item" title="回复">💬 ${post.replyCount}</span>
    ${post.bookmarked ? '<span class="meta-item" title="已收藏">⭐</span>' : ''}`;
}

/** 作者整理自己主页的小工具：选分类 + 置顶推荐。 */
function ownerToolsHtml(post, categories) {
  const options = ['<option value="">未分类</option>']
    .concat(
      categories.map(
        (category) =>
          `<option value="${category.id}" ${post.category?.id === category.id ? 'selected' : ''}>${esc(category.name)}</option>`,
      ),
    )
    .join('');
  return `
    <div class="owner-tools">
      <select class="mini-select" data-action="set-category" data-id="${post.id}" title="归入我的分类">${options}</select>
      <button class="btn btn-sm ${post.profilePinned ? 'is-on' : ''}" data-action="profile-pin"
              data-id="${post.id}" data-pinned="${post.profilePinned ? '1' : '0'}"
              title="在个人主页顶部推荐这篇">📌 ${post.profilePinned ? '取消置顶' : '置顶'}</button>
    </div>`;
}
function postListHtml(items, toolsFor = null) {
  if (!items.length) {
    return `<div class="post-list">${emptyHtml('🍃', '这里还很安静', '成为第一个发帖的人吧')}</div>`;
  }
  const rows = items
    .map(
      (post) => `
    <article class="post-row ${post.pinned || post.profilePinned ? 'is-pinned' : ''}">
      ${Avatar.avatarHtml(post.author)}
      <div class="post-main">
        <div class="post-tags">${postBadgesHtml(post)}</div>
        <h3 class="post-title"><a href="#/post/${post.id}">${esc(post.title)}</a></h3>
        ${post.repost?.comment ? `<p class="repost-quote">🔁 ${esc(post.repost.comment)}</p>` : ''}
        <p class="post-excerpt">${esc(post.excerpt)}</p>
        <div class="post-meta">${postMetaStatsHtml(post)}</div>
        ${toolsFor ? `<div class="post-owner-row">${toolsFor(post)}</div>` : ''}
      </div>
    </article>`,
    )
    .join('');
  return `<div class="post-list">${rows}</div>`;
}
function postCardsHtml(items, toolsFor = null) {
  if (!items.length) return `<div class="card">${emptyHtml('🍃', '这个分类下还没有文章')}</div>`;
  return `<div class="post-cards">${items
    .map(
      (post) => `
    <article class="post-card ${post.profilePinned ? 'is-pinned' : ''}">
      <div class="post-tags">${postBadgesHtml(post)}</div>
      <h3 class="post-title"><a href="#/post/${post.id}">${esc(post.title)}</a></h3>
      ${post.repost?.comment ? `<p class="repost-quote">🔁 ${esc(post.repost.comment)}</p>` : ''}
      <p class="post-excerpt">${esc(post.excerpt)}</p>
      <div class="post-meta">${postMetaStatsHtml(post)}</div>
      ${toolsFor ? `<div class="post-owner-row">${toolsFor(post)}</div>` : ''}
    </article>`,
    )
    .join('')}</div>`;
}
function postCompactHtml(items, toolsFor = null) {
  if (!items.length) return `<div class="card">${emptyHtml('🍃', '这个分类下还没有文章')}</div>`;
  return `<div class="post-compact">${items
    .map(
      (post) => `
    <div class="compact-row ${post.profilePinned ? 'is-pinned' : ''}">
      <a class="compact-title" href="#/post/${post.id}">${post.profilePinned ? '📌 ' : ''}${esc(post.title)}</a>
      ${post.category ? `<span class="tag tag-category">${esc(post.category.name)}</span>` : ''}
      <span class="compact-meta">${Fmt.timeAgo(post.createdAt)} · 👍 ${post.likeCount} · 👎 ${post.dislikeCount} · 💬 ${post.replyCount}</span>
      ${toolsFor ? `<div class="post-owner-row">${toolsFor(post)}</div>` : ''}
    </div>`,
    )
    .join('')}</div>`;
}
function profilePostsHtml(posts, { layout, toolsFor = null }) {
  if (layout === 'cards') return postCardsHtml(posts, toolsFor);
  if (layout === 'compact') return postCompactHtml(posts, toolsFor);
  return postListHtml(posts, toolsFor);
}
function pageNumbers(page, total) {
  const candidates = new Set([1, total, page, page - 1, page + 1, page - 2, page + 2]);
  const pages = [...candidates].filter((value) => value >= 1 && value <= total).sort((a, b) => a - b);
  const output = [];
  let previous = 0;
  for (const value of pages) {
    if (previous && value - previous > 1) output.push('…');
    output.push(value);
    previous = value;
  }
  return output;
}
function paginationHtml(page, totalPages, hrefFor) {
  if (totalPages <= 1) return '';
  const links = pageNumbers(page, totalPages)
    .map((value) =>
      value === '…'
        ? '<span class="page-link is-disabled">…</span>'
        : `<a class="page-link ${value === page ? 'is-active' : ''}" href="${hrefFor(value)}">${value}</a>`,
    )
    .join('');
  return `<nav class="pagination">
    <a class="page-link ${page <= 1 ? 'is-disabled' : ''}" href="${hrefFor(Math.max(1, page - 1))}">‹ 上一页</a>
    ${links}
    <a class="page-link ${page >= totalPages ? 'is-disabled' : ''}" href="${hrefFor(Math.min(totalPages, page + 1))}">下一页 ›</a>
  </nav>`;
}
function sortTabsHtml(sort, basePath, query) {
  const tabs = [
    ['latest', '🕒 最新发布'],
    ['active', '💬 最新回复'],
    ['hot', '🔥 最热'],
  ];
  const queryString = query.toString();
  return `<div class="tabs">${tabs
    .map(([key, label]) => {
      const params = new URLSearchParams(queryString);
      params.set('sort', key);
      params.delete('page');
      return `<a class="tab ${sort === key ? 'is-active' : ''}" href="#${basePath}?${params.toString()}">${label}</a>`;
    })
    .join('')}</div>`;
}
function feedTabsHtml(feed, basePath, query) {
  if (!state.me) return '';
  const tabs = [
    ['all', '🌐 全部讨论'],
    ['following', '👥 我关注的'],
  ];
  return `<div class="tabs tabs-sm">${tabs
    .map(([key, label]) => {
      const params = new URLSearchParams(query.toString());
      if (key === 'following') params.set('feed', 'following');
      else params.delete('feed');
      params.delete('page');
      const qs = params.toString();
      return `<a class="tab ${feed === key ? 'is-active' : ''}" href="#${basePath}${qs ? `?${qs}` : ''}">${label}</a>`;
    })
    .join('')}</div>`;
}
function personChipHtml(person, { unfollow = false, follow = false } = {}) {
  return `
    <div class="person-chip">
      ${Avatar.avatarHtml(person, 'avatar-sm')}
      <div class="person-info">
        <a class="person-name" href="#/u/${encodeURIComponent(person.username)}">${esc(person.displayName)}</a>
        ${Fmt.roleTag(person.role)}
        <div class="hint">@${esc(person.username)}${person.bio ? ` · ${esc(person.bio.slice(0, 24))}` : ''}</div>
      </div>
      ${
        unfollow
          ? `<button class="btn btn-sm" data-action="follow" data-user="${person.id}" data-name="${esc(person.displayName)}">已关注</button>`
          : follow
            ? `<button class="btn btn-sm ${person.viewerFollows ? 'is-on' : ''}" data-action="follow" data-user="${person.id}" data-name="${esc(person.displayName)}">${person.viewerFollows ? '✓ 已关注' : '＋ 关注'}</button>`
            : `<span class="hint">${person.postCount ?? 0} 帖</span>`
      }
    </div>`;
}
function messageQuotaHtml(availability) {
  if (!availability) return '';
  if (availability.blockedByMe) {
    return `<span class="dm-blocked">🚫 你已拉黑对方，解除后才能私信</span>`;
  }
  if (availability.blockedMe) {
    return `<span class="dm-blocked">🚫 对方已将你拉黑，无法发送私信</span>`;
  }
  if (availability.mutual) return `<span class="dm-quota is-free">🤝 互相关注 · 不限量</span>`;
  if (availability.followed) {
    const left = availability.remainingToday ?? 0;
    return `<span class="dm-quota ${left > 0 ? '' : 'is-empty'}">👋 单方面关注 · 今天还剩 ${left}/${availability.dailyLimit} 条</span>`;
  }
  return `<span class="dm-quota is-empty">🔒 先关注对方（或等 TA 关注你）才能私信</span>`;
}
function boardOptions(selectedId) {
  return state.site.boards
    .map(
      (board) =>
        `<option value="${board.id}" ${Number(selectedId) === board.id ? 'selected' : ''}>${board.icon} ${esc(board.name)}</option>`,
    )
    .join('');
}

// ── 导出 ──────────────────────────────────────────────────────────────
export { postBadgesHtml };
export { postMetaStatsHtml };
export { ownerToolsHtml };
export { postListHtml };
export { postCardsHtml };
export { postCompactHtml };
export { profilePostsHtml };
export { pageNumbers };
export { paginationHtml };
export { sortTabsHtml };
export { feedTabsHtml };
export { personChipHtml };
export { boardOptions };
export { messageQuotaHtml };

/* @hand-written */
