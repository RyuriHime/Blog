// 个人主页。

import { $, esc, loadingHtml, ui } from '../core/dom.js';
import { api } from '../core/api.js';
import { PROFILE_LAYOUTS } from '../core/state.js';
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
    ['关注者', user.followerCount],
    ['关注中', user.followingCount],
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

  // 两张关注名单卡（关注者 / 我关注的人）。文案按视角变：自己看自己时是「我的关注者 /
  // 我关注的人」，看别人时还是「关注者 / TA 关注的人」。
  // 为什么要攒成一个字符串、在模板里出现两次：**自己看自己时它们必须排在文章列表上面**。
  // 排在页面最底下时，文章一多就得整页滚到底才看得见 —— 用户反馈的「在自己的主页上
  // 看不到我关注的人」就是这么来的（接口一直是对的，是位置太靠后）。
  // 自己视角再多给一个「全部名单」入口：`#/following` 那个名单页只认这个地址。
  const followCards = `
    <section class="card">
      <div class="card-head"><span class="card-title">👥 ${isOwner ? '我的关注者' : '关注者'}（${user.followerCount}）</span></div>
      <div class="chip-list">
        ${
          followers.length
            ? followers.map((person) => Widgets.personChipHtml(person, { follow: true })).join('')
            : `<div class="hint">${isOwner ? '还没有人关注你' : '还没有关注者'}</div>`
        }
      </div>
    </section>

    <section class="card">
      <div class="card-head">
        <span class="card-title">➡️ ${isOwner ? '我关注的人' : 'TA 关注的人'}（${user.followingCount}）</span>
        ${isOwner ? '<a class="btn btn-sm" href="#/following">全部名单</a>' : ''}
      </div>
      <div class="chip-list">
        ${
          following.length
            ? following.map((person) => Widgets.personChipHtml(person, { follow: true })).join('')
            : `<div class="hint">${isOwner ? '你还没有关注任何人：去 <a href="#/feed">动态流</a> 里找人关注一下' : '还没有关注任何人'}</div>`
        }
      </div>
    </section>`;

  ui.app.innerHTML = `
    <section class="card">
      <div class="profile-head">
        ${Avatar.avatarHtml(user, 'avatar-lg')}
        <div class="profile-info">
          <h1 style="font-size:21px">${esc(user.displayName)} ${Fmt.roleTag(user.role)}</h1>
          <div class="page-sub">@${esc(user.username)} · 加入于 ${Fmt.timeAgo(user.createdAt)}</div>
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

    ${isOwner ? followCards : ''}

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

    ${isOwner ? '' : followCards}`;
}

/* ------------------------------------------------------------------ */
/* 视图：消息通知                                                      */

// ── 导出 ──────────────────────────────────────────────────────────────
export { viewUser };

/* @hand-written */
