// 个人主页与排行榜。

import { $, esc, loadingHtml, ui } from '../core/dom.js';
import { api } from '../core/api.js';
import { PROFILE_LAYOUTS, state } from '../core/state.js';
import * as Avatar from '../core/avatar.js';
import * as Fmt from '../core/format.js';
import * as Prefs from '../core/preferences.js';
import * as Widgets from '../core/widgets.js';

async function viewUser(username, query) {
  ui.app.innerHTML = loadingHtml();
  const filter = query.get('category') || 'all';
  const suffix = filter === 'all' ? '' : `?category=${encodeURIComponent(filter)}`;
  const data = await api(`/api/users/${encodeURIComponent(username)}${suffix}`);
  const { user, followers, following, posts, categories, uncategorizedCount, pinnedCount } = data;
  const value = data.value ?? { totalValue: 0, avgValue: 0, bestValue: 0, rank: null };
  const layout = Prefs.profileLayout();
  const isOwner = Boolean(user.isMe);
  const basePath = `/u/${encodeURIComponent(user.username)}`;
  const toolsFor = isOwner ? (post) => Widgets.ownerToolsHtml(post, categories) : null;
  const categoryLimit = data.categoryLimit ?? Fmt.profileRules().categoryLimit;

  // §8.2 积木优先：这位用户如果有一份 kind='profile' 的文档，主页正文就用它渲染。
  // 任何一步失败都退回原来的「签名 + 帖子列表」—— 接线是「优先」，不是「替代」。
  let profileDocHtml = '';
  try {
    const found = await api(`/api/docs/profile/${encodeURIComponent(user.username)}`);
    if (found && found.found === true && found.html && !(found.doc && found.doc.deleted === true) && !(found.abilities && found.abilities.canView === false)) {
      profileDocHtml = found.html;
    }
  } catch (error) {
    profileDocHtml = '';
  }
  const hasProfileDoc = Boolean(profileDocHtml);

  const stats = [
    ['文章', user.postCount],
    ['回复', user.replyCount],
    ['获赞', user.likesReceived],
    ['获踩', user.dislikesReceived],
    ['收币', user.coinsReceived],
    ['关注者', user.followerCount],
    ['关注中', user.followingCount],
    ['权重 W', value.totalValue],
    ['篇均价值', value.avgValue],
    ['榜单排名', value.rank ? `#${value.rank}` : '—'],
  ]
    .map(
      ([label, value]) =>
        `<div class="stat"><div class="stat-value">${Fmt.fmtNum(value)}</div><div class="stat-label">${label}</div></div>`,
    )
    .join('');

  // 第 4 个参数 rawName 是分类的**原始**名字。data-name 必须放它，不能放 label ——
  // label 是显示文案（带 `🗂 ` 前缀且已经过 esc），回填进重命名对话框后用户一保存，
  // `🗂 ` 和 `&amp;` 这种转义残渣就原样写进数据库了。
  const chip = (key, label, count, rawName = '') => {
    const active = filter === key ? 'is-active' : '';
    const inner = `<a class="chip-label" href="#${basePath}${key === 'all' ? '' : `?category=${encodeURIComponent(key)}`}">${label} <span class="chip-count">${count}</span></a>`;
    // rawName 只有真分类才传（「全部 / 未分类 / 转发」不是分类），那几个退回 label 本身，
    // 免得 data-name 空着被重命名/删除对话框当成空名字用。
    const name = esc(rawName || label);
    const tools = isOwner && key !== 'all' && key !== 'none' ? `
      <button class="chip-x" data-action="rename-category" data-id="${key}" data-name="${name}" title="重命名">✎</button>
      <button class="chip-x" data-action="delete-category" data-id="${key}" data-name="${name}" title="删除分类（文章会回到未分类）">✕</button>` : '';
    return `<span class="chip ${active}">${inner}${tools}</span>`;
  };

  const chips = [
    chip('all', '📚 全部', user.postCount),
    ...categories.map((category) => chip(String(category.id), `🗂 ${esc(category.name)}`, category.postCount, category.name)),
    chip('none', '📭 未分类', uncategorizedCount),
    data.repostCount ? chip('reposts', '🔁 转发', data.repostCount) : '',
  ]
    .filter(Boolean)
    .join('');

  const layoutTabs = PROFILE_LAYOUTS.map(
    ([key, label]) =>
      `<button class="tab ${layout === key ? 'is-active' : ''}" type="button" data-action="profile-layout" data-layout="${key}">${label}</button>`,
  ).join('');

  const pinnedPosts = filter === 'all' ? posts.filter((post) => post.profilePinned) : [];
  const otherPosts = filter === 'all' ? posts.filter((post) => !post.profilePinned) : posts;

  ui.app.innerHTML = `
    <section class="card">
      <div class="profile-head">
        ${Avatar.avatarHtml(user, 'avatar-lg')}
        <div class="profile-info">
          <h1 style="font-size:21px">${esc(user.displayName)} ${Fmt.roleTag(user.role)}</h1>
          <div class="page-sub">@${esc(user.username)} · 加入于 ${Fmt.timeAgo(user.createdAt)}${isOwner ? ` · 🪙 ${Fmt.fmtNum(user.coinBalance)} 币` : ''}</div>
          ${user.bio ? `<p class="profile-bio">${esc(user.bio)}</p>` : '<p class="profile-bio hint">这位用户还没有写个性签名</p>'}
        </div>
        <div class="profile-actions">
          ${
            isOwner
              ? `<a class="btn btn-sm" href="#/settings">⚙️ 账号设置</a>
                 <a class="btn btn-sm" href="#/bookmarks">⭐ 我的收藏</a>
                 <a class="btn btn-sm btn-primary" href="#/new">✏️ 写文章</a>`
              : `<button class="btn ${user.isFollowing ? '' : 'btn-primary'}" data-action="follow" data-user="${user.id}" data-name="${esc(user.displayName)}" ${user.blockedByMe ? 'disabled' : ''}>
                   ${user.isFollowing ? '✓ 已关注' : '＋ 关注'}
                 </button>
                 <a class="btn btn-sm ${data.messageAvailability?.canSend ? 'btn-primary' : ''}" href="#/messages/${encodeURIComponent(user.username)}"
                    title="${esc(data.messageAvailability?.message ?? '')}">
                   ✉️ 私信${user.mutualFollow ? '' : data.messageAvailability?.followed ? `（今天剩 ${data.messageAvailability.remainingToday} 条）` : ''}
                 </a>
                 <button class="btn btn-sm ${user.blockedByMe ? 'btn-danger' : ''}" data-action="block-user" data-id="${user.id}" data-blocked="${user.blockedByMe ? '1' : '0'}" data-name="${esc(user.displayName)}">
                   ${user.blockedByMe ? '🚫 解除拉黑' : '🚫 拉黑'}
                 </button>`
          }
        </div>
      </div>
      ${
        user.blockedByMe
          ? `<div class="moderation-banner">
               <span class="moderation-icon">🚫</span>
               <div>
                 <strong>你已把 ${esc(user.displayName)} 拉黑</strong>
                 <div class="hint">TA 的关注与私信都会被拒绝，也看不到你发的文章；你也看不到 TA 的内容。文章列表已隐藏。</div>
               </div>
               <button class="btn btn-sm" data-action="block-user" data-id="${user.id}" data-blocked="1" data-name="${esc(user.displayName)}">解除拉黑</button>
             </div>`
          : ''
      }
      <div class="stat-grid stat-grid-wide">${stats}</div>
    </section>

    ${
      isOwner
        ? `<section class="card">
             <div class="card-head">
               <span class="card-title">🗂 我的分类（${categories.length}/${categoryLimit}）</span>
               <button class="btn btn-sm" type="button" data-action="toggle-category-form">＋ 新建分类</button>
             </div>
             <form class="form" data-action="create-category" hidden>
               <div class="form-row">
                 <input name="name" type="text" maxlength="12" placeholder="分类名称，例如「前端笔记」" required />
                 <button class="btn btn-primary" type="submit">创建</button>
               </div>
               <div class="form-error" data-error hidden></div>
             </form>
             <div class="hint">分类只影响你的个人主页；删除分类不会删除文章，文章会回到「未分类」。置顶推荐最多 ${data.pinLimit} 篇（已置顶 ${pinnedCount} 篇）。</div>
           </section>`
        : ''
    }

    ${
      hasProfileDoc
        ? `<section class="card doc-panel"><div class="doc-body">${profileDocHtml}</div></section>`
        : `<section class="card" style="padding:0">
      <div class="card-head chips-head">
        <div class="chips">${chips}</div>
        <div class="tabs tabs-sm">${layoutTabs}</div>
      </div>
      ${
        pinnedPosts.length
          ? `<div class="pinned-block">
               <div class="pinned-title">📌 置顶推荐</div>
               ${Widgets.profilePostsHtml(pinnedPosts, { layout, toolsFor })}
             </div>`
          : ''
      }
      <div class="profile-posts">
        ${Widgets.profilePostsHtml(otherPosts, { layout, toolsFor })}
      </div>
    </section>`
    }

    <section class="card">
      <div class="card-head"><span class="card-title">👥 关注者（${user.followerCount}）</span></div>
      <div class="chip-list">
        ${followers.length ? followers.map((person) => Widgets.personChipHtml(person, { follow: true })).join('') : '<div class="hint">还没有关注者</div>'}
      </div>
    </section>

    <section class="card">
      <div class="card-head"><span class="card-title">➡️ TA 关注的人（${user.followingCount}）</span></div>
      <div class="chip-list">
        ${following.length ? following.map((person) => Widgets.personChipHtml(person, { follow: true })).join('') : '<div class="hint">还没有关注任何人</div>'}
      </div>
    </section>`;
}

/* ------------------------------------------------------------------ */
/* 视图：每日签到                                                      */
async function viewRanking(query) {
  ui.app.innerHTML = loadingHtml();
  const windowKey = Widgets.RANKING_WINDOWS.some(([key]) => key === query.get('window')) ? query.get('window') : 'all';
  const sortBy = query.get('sort') === 'avg' ? 'avg' : 'total';
  const data = await api(`/api/ranking?window=${windowKey}&limit=20`);
  const weights = data.weights ?? state.site.valueWeights;

  const windowTabs = Widgets.RANKING_WINDOWS.map(
    ([key, label]) =>
      `<a class="tab ${windowKey === key ? 'is-active' : ''}" href="#/ranking${key === 'all' ? '' : `?window=${key}`}">${label}</a>`,
  ).join('');

  const postRows = data.posts.length
    ? data.posts
        .map(
          (post, index) => `
      <tr>
        <td class="rank-cell"><span class="rank-badge ${Widgets.rankBadgeClass(index)}">${index + 1}</span></td>
        <td class="wrap">
          <a href="#/post/${post.id}">${esc(post.title)}</a>
          <div class="hint">${post.board.icon} ${esc(post.board.name)} · ${esc(post.author.displayName)} · ${Fmt.timeAgo(post.createdAt)}</div>
        </td>
        <td class="num">👍 ${post.likeCount}</td>
        <td class="num">🪙 ${post.coinCount}</td>
        <td class="num">⭐ ${post.bookmarkCount}</td>
        <td class="num">👎 ${post.dislikeCount}</td>
        <td class="num">🔁 ${post.repostCount}</td>
        <td class="num hint">${post.baseScore}</td>
        <td class="num value-cell">${post.valueScore}</td>
      </tr>`,
        )
        .join('')
    : '<tr><td colspan="9">这个时间窗内还没有文章</td></tr>';

  const authors = [...data.authors].sort((a, b) =>
    sortBy === 'avg' ? b.avgValue - a.avgValue || b.totalValue - a.totalValue : b.totalValue - a.totalValue,
  );

  const authorRows = authors.length
    ? authors
        .map(
          (item, index) => `
      <tr>
        <td class="rank-cell"><span class="rank-badge ${Widgets.rankBadgeClass(index)}">${index + 1}</span></td>
        <td>
          <a class="author-cell" href="#/u/${encodeURIComponent(item.user.username)}">
            ${Avatar.avatarHtml(item.user, 'avatar-sm')}
            <span>${esc(item.user.displayName)}</span>
          </a>
          ${Fmt.roleTag(item.user.role)}
        </td>
        <td class="num">${item.postCount}</td>
        <td class="num value-cell">${item.totalValue}</td>
        <td class="num">${item.avgValue}</td>
        <td class="num">${item.bestValue}</td>
        <td class="num">👍 ${item.likesReceived}</td>
        <td class="num">🪙 ${item.coinsReceived}</td>
        <td class="num">⭐ ${item.bookmarksReceived}</td>
        <td class="num">👎 ${item.dislikesReceived}</td>
      </tr>`,
        )
        .join('')
    : '<tr><td colspan="10">还没有可排名的作者</td></tr>';

  ui.app.innerHTML = `
    <section class="page-head">
      <h1>🏆 价值排行榜</h1>
      <div class="page-sub">按「赞 · 投币 · 收藏 · 踩」加权计算文章价值，个人权重为所有文章价值之和。</div>
    </section>

    <div class="list-head">
      <div class="tabs">${windowTabs}</div>
      <span class="hint">共统计 ${data.totals.posts} 篇文章</span>
    </div>

    <section class="card" style="padding:0">
      <div class="card-head" style="padding:16px 18px;margin:0;border-bottom:1px solid var(--border-soft)">
        <span class="card-title">📄 文章价值榜</span>
        <span class="hint">V 越高代表综合质量越高</span>
      </div>
      <div class="table-wrap">
        <table class="data rank-table">
          <thead>
            <tr><th>#</th><th>标题</th><th>赞</th><th>币</th><th>藏</th><th>踩</th><th>转发</th><th>基础分</th><th>价值 V</th></tr>
          </thead>
          <tbody>${postRows}</tbody>
        </table>
      </div>
    </section>

    <section class="card" style="padding:0">
      <div class="card-head" style="padding:16px 18px;margin:0;border-bottom:1px solid var(--border-soft)">
        <span class="card-title">👤 作者权重榜</span>
        <div class="tabs tabs-sm">
          <a class="tab ${sortBy === 'total' ? 'is-active' : ''}" href="#/ranking?${new URLSearchParams({ ...(windowKey === 'all' ? {} : { window: windowKey }) }).toString()}">按总权重</a>
          <a class="tab ${sortBy === 'avg' ? 'is-active' : ''}" href="#/ranking?${new URLSearchParams({ ...(windowKey === 'all' ? {} : { window: windowKey }), sort: 'avg' }).toString()}">按篇均</a>
        </div>
      </div>
      <div class="table-wrap">
        <table class="data rank-table">
          <thead>
            <tr><th>#</th><th>作者</th><th>文章</th><th>总权重 W</th><th>篇均</th><th>最佳</th><th>获赞</th><th>收币</th><th>被藏</th><th>被踩</th></tr>
          </thead>
          <tbody>${authorRows}</tbody>
        </table>
      </div>
    </section>

    ${Widgets.formulaCardHtml(weights)}`;
}

/* ------------------------------------------------------------------ */
/* 视图：消息通知                                                      */

// ── 导出 ──────────────────────────────────────────────────────────────
export { viewUser };
export { viewRanking };

/* @hand-written */
