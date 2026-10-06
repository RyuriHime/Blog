// 首页 / 版块 / 搜索 / 收藏 / 关注 四处「帖子列表」型页面。

import { $, emptyHtml, esc, loadingHtml, ui } from '../core/dom.js';
import { api } from '../core/api.js';
import { navigate, routeQuery } from '../core/router.js';
import { state } from '../core/state.js';
import * as Session from '../core/session.js';
import * as Widgets from '../core/widgets.js';

async function renderPostListSection({ basePath, query, options = {} }) {
  const params = new URLSearchParams(query);
  const page = Math.max(1, Number(params.get('page') || 1));
  const sort = params.get('sort') || 'latest';
  const feed = params.get('feed') === 'following' ? 'following' : 'all';
  const search = new URLSearchParams(params);
  search.set('page', String(page));
  search.set('sort', sort);
  search.set('perPage', '10');
  if (feed === 'following') search.set('following', '1');

  const data = await api(`/api/posts?${search.toString()}`);
  const hrefFor = (target) => routeQuery(basePath, query, { page: target, sort });
  const head = options.head || '';

  return `
    ${head}
    <div class="list-head">
      ${options.title || ''}
      <div class="tabs-stack">
        ${Widgets.feedTabsHtml(feed, basePath, query)}
        ${Widgets.sortTabsHtml(sort, basePath, query)}
      </div>
    </div>
    ${Widgets.postListHtml(data.items)}
    ${Widgets.paginationHtml(data.page, data.totalPages, hrefFor)}`;
}

/* ------------------------------------------------------------------ */
/* 视图：首页 / 板块 / 搜索 / 收藏 / 关注流 / 用户主页                    */
async function viewHome(query) {
  ui.app.innerHTML = loadingHtml();
  const hero = `
    <section class="hero">
      <h1>围炉而坐，聊聊技术 👋</h1>
      <p>分区讨论、Markdown 发帖、评价、关注作者，消息通知一个都不少。</p>
      <div class="hero-actions">
        <a class="btn btn-primary" href="#/new">✏️ 我要发帖</a>
        ${state.me ? '<a class="btn" href="#/following">👥 我关注的人</a>' : '<a class="btn" href="#/register">🎉 注册一个账号</a>'}
      </div>
    </section>`;
  ui.app.innerHTML = await renderPostListSection({
    basePath: '/',
    query,
    options: { head: hero, title: '<h2 class="card-title">🧵 讨论</h2>' },
  });
}
async function viewBoard(slug, query) {
  ui.app.innerHTML = loadingHtml();
  const board = state.site.boards.find((item) => item.slug === slug);
  const head = `
    <section class="card">
      <div class="card-head" style="margin-bottom:6px">
        <h1 style="font-size:21px">${board ? board.icon : '📁'} ${esc(board?.name || slug)}</h1>
        <a class="tag" href="#/">← 全部帖子</a>
      </div>
      <div class="page-sub">${esc(board?.description || '板块不存在或已删除')}</div>
      ${
        board
          ? `<div class="post-meta" style="margin-top:10px">
               <span>共 ${board.postCount} 个主题</span><span>·</span><span>${board.replyCount} 条回复</span>
             </div>`
          : ''
      }
    </section>`;
  ui.app.innerHTML = await renderPostListSection({
    basePath: `/board/${slug}`,
    query,
    options: { head },
  });
  Session.renderSidebar(slug);
}
async function viewSearch(query) {
  const keyword = (query.get('q') || '').trim();
  ui.searchInput.value = keyword;
  ui.app.innerHTML = loadingHtml();
  if (!keyword) {
    ui.app.innerHTML = `<div class="card">${emptyHtml('🔍', '输入关键词开始搜索', '标题和正文都会被检索')}</div>`;
    return;
  }
  const head = `
    <section class="card">
      <h1 style="font-size:20px">🔍 搜索「${esc(keyword)}」</h1>
      <div class="page-sub">同时在帖子标题与正文中匹配关键词。</div>
    </section>`;
  ui.app.innerHTML = await renderPostListSection({ basePath: '/search', query, options: { head } });
}
async function viewBookmarks(query) {
  ui.app.innerHTML = loadingHtml();
  if (!state.me) {
    state.redirect = '/bookmarks';
    navigate('/login');
    return;
  }
  const params = new URLSearchParams(query);
  params.set('bookmarked', '1');
  const head = `
    <section class="card">
      <h1 style="font-size:20px">⭐ 我的收藏</h1>
      <div class="page-sub">只有你能看到这个列表。</div>
    </section>`;
  ui.app.innerHTML = await renderPostListSection({ basePath: '/bookmarks', query: params, options: { head } });
}
async function viewFollowing() {
  ui.app.innerHTML = loadingHtml();
  if (!state.me) {
    state.redirect = '/following';
    navigate('/login');
    return;
  }
  const data = await api('/api/me/following');
  ui.app.innerHTML = `
    <section class="card">
      <div class="card-head" style="margin-bottom:4px">
        <h1 style="font-size:20px">📋 关注列表</h1>
        <span class="tag">关注 ${data.counts.followingCount} · 粉丝 ${data.counts.followerCount}</span>
      </div>
      <div class="page-sub">你关注的人都在下面。点名字进 TA 的主页，点「已关注」就取关。</div>
      <div class="form-actions" style="margin-top:12px">
        <a class="btn btn-sm" href="#/?filter=following">去看 TA 们发的动态 →</a>
        <a class="btn btn-sm" href="#/u/${encodeURIComponent(state.me.username)}">我的主页（含粉丝名单）→</a>
      </div>
    </section>
    <section class="card" style="padding:0">
      <div class="card-head" style="padding:16px 18px;margin:0;border-bottom:1px solid var(--border-soft)">
        <span class="card-title">关注列表（${data.items.length}）</span>
      </div>
      <div class="chip-list">
        ${data.items.length ? data.items.map((person) => Widgets.personChipHtml(person, { unfollow: true })).join('') : emptyHtml('👀', '还没有关注任何人', '去动态里点作者旁边的「关注」试试')}
      </div>
    </section>`;
}

// ── 导出 ──────────────────────────────────────────────────────────────
export { renderPostListSection };
export { viewHome };
export { viewBoard };
export { viewSearch };
export { viewBookmarks };
export { viewFollowing };

/* @hand-written */
