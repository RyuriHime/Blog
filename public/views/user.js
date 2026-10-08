// 个人主页。

import { $, esc, loadingHtml, ui } from '../core/dom.js';
import { api } from '../core/api.js';
import { PROFILE_LAYOUTS } from '../core/state.js';
import * as Avatar from '../core/avatar.js';
import * as Fmt from '../core/format.js';
import * as Prefs from '../core/preferences.js';
import * as ProfileRules from '../core/profile-rules.js';
import * as Widgets from '../core/widgets.js';

async function viewUser(username, query) {
  ui.app.innerHTML = loadingHtml();
  // 分类功能已下线（需求 4：改为积木标签）。筛选项只剩「全部 / 转发」，
  // 点标签筛的是 `?tag=`，由后端在影子行上按 `doc_tags` 过滤。
  const filter = query.get('category') === 'reposts' ? 'reposts' : 'all';
  const activeTag = query.get('tag') || '';
  const suffix = activeTag
    ? `?tag=${encodeURIComponent(activeTag)}`
    : filter === 'reposts'
      ? '?category=reposts'
      : '';
  const data = await api(`/api/users/${encodeURIComponent(username)}${suffix}`);
  const { user, followers, following, posts, tags, pinnedCount } = data;
  const layout = Prefs.profileLayout();
  const isOwner = Boolean(user.isMe);
  const basePath = `/u/${encodeURIComponent(user.username)}`;
  // 作者自己在列表上能做的事只剩「置顶推荐」（归入分类已随分类功能下线，
  // 标签请到积木编辑器里改 —— 那里才是标签的家）。
  const toolsFor = isOwner ? (post) => Widgets.ownerToolsHtml(post) : null;

  // §8.2 积木优先：这位用户如果有一份 kind='profile' 的文档，主页正文就用它渲染。
  // 任何一步失败都退回原来的「签名 + 帖子列表」—— 接线是「优先」，不是「替代」。
  // 需求 1/2：这一份文档就是**本页的底层** —— 作者点「翻新个人主页」进积木编辑器改它，
  // 块规则（哪块不许删、保存前要满足什么）与编辑器共用同一份 `profile-rules.js`。
  let profileDoc = null;
  try {
    const found = await api(`/api/docs/profile/${encodeURIComponent(user.username)}`);
    if (found && found.found === true && found.html && !(found.doc && found.doc.deleted === true) && !(found.abilities && found.abilities.canView === false)) {
      profileDoc = found;
    }
  } catch (error) {
    profileDoc = null;
  }
  const profileDocHtml = profileDoc ? profileDoc.html : '';
  const hasProfileDoc = Boolean(profileDocHtml);
  // 需求 2：名片（头像 / 昵称 / 签名 / 关注 / 私信 / 拉黑）**是主页的第一块** ——
  // 服务端已经把它渲染进 `profileDocHtml` 里（块里存的是占位，渲染时换成真卡片）。
  // 它出现的时候，页面上那份硬编码的旧头像卡就必须让位，否则会看到两张。
  const hasProfileHead = hasProfileDoc && profileDocHtml.includes('data-profile-card');
  // 统计那 6 格在**有积木主页时挪到正文下面**：主页的第一块就是名片（头像 / 昵称 / 签名 /
  // 关注 / 私信 / 拉黑），它必须出现在页面最上面 —— 统计再抢在最前，头像和签名就被挤下去了。
  // 只有还没块化的老主页（没有 seed 出来的 `profile-*` 块）才需要这一排兜底统计，
  // 块化的主页里统计是「数据统计」块自己的事（需求 2）。
  const profileSeeded = hasProfileDoc && (Array.isArray(profileDoc.blocks) ? profileDoc.blocks : []).some((block) => String(block.props?.source?.kind ?? '').startsWith('profile-'));
  // 编辑器保存前的判定与主页共用同一份规则（`public/core/profile-rules.js` 是服务端
  // `src/modules/doc/profile-rules.js` 的同源副本），所以这里算出来的结论和服务端 400 一致。
  const profileCheck = isOwner ? ProfileRules.checkProfile({ blocks: profileDoc?.blocks ?? null, hasDoc: hasProfileDoc }) : null;

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
  const statsHtml = `<div class="stat-grid stat-grid-wide">${stats}</div>`;

  // 筛选条：全部 / 该用户用过的标签 / 转发。
  // 分类那套（🗂 新建/重命名/删除分类、📭 未分类）已经整条下线 —— 需求 4「删除被弃用的
  // 分类功能，改为 Tag 功能」。标签不是用户自己维护的列表，而是**从积木用法里长出来的**：
  // 作者在自己的积木上贴了什么标签，这里就出现什么，点一下筛出贴了它的那几篇。
  const chip = (href, label, count, active, tools = '') =>
    `<span class="chip ${active ? 'is-active' : ''}"><a class="chip-label" href="${href}">${label} <span class="chip-count">${count}</span></a>${tools}</span>`;

  const chips = [
    chip(`#${basePath}`, '📚 全部', user.postCount, !activeTag && filter !== 'reposts'),
    ...(tags ?? []).map((tag) =>
      chip(
        `#${basePath}?tag=${encodeURIComponent(tag.name)}`,
        `🏷 ${esc(tag.name)}`,
        tag.postCount,
        activeTag.toLowerCase() === tag.name.toLowerCase(),
      ),
    ),
    data.repostCount ? chip(`#${basePath}?category=reposts`, '🔁 转发', data.repostCount, filter === 'reposts') : '',
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
    <!-- 需求 2：头像 / 昵称 / 签名 / 关注 / 私信 / 拉黑这一框**是一个积木块**
         （服务端渲染时把它放进积木主页的第一块位置）。所以这一份硬编码的头像卡
         只在没有积木主页、或积木主页里没有名片块时才出现 —— 否则页面上会出现两张卡片。 -->
    ${hasProfileHead ? '' : `<section class="card" data-role="profile-head-fallback">
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
                 <!-- 帖子功能下线：这条原来是 #/new（发帖）。留着「写」这个动作，
                      但落点改成积木广场 —— 那里才有新建入口。 -->
                 <a class="btn btn-sm btn-primary" href="#/docs">🧩 去积木广场写作</a>`
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
      ${
        isOwner
          ? `<div class="profile-actions">
               ${
                 hasProfileDoc
                   ? `<a class="btn btn-sm" href="#/doc/${profileDoc.doc.id}/edit?mode=blocks" title="个人主页还是一篇积木文档：块可以自由增删改，只有「${ProfileRules.PROFILE_CARD_APP}」块锁着">✏️ 翻新我的主页</a>`
                   : `<button class="btn btn-sm" data-action="profile-create" title="把主页翻新成一篇积木文档：头像 / 昵称 / 统计数据 / 标签 / 置顶推荐 / 发过的积木贴与动态都是块">🧩 把主页变成积木</button>`
               }
             </div>`
          : ''
      }
    </section>`}

    ${hasProfileDoc ? '' : statsHtml}

    ${
      isOwner
        ? `<section class="card">
             <div class="card-head"><span class="card-title">🏷 我的标签</span></div>
             <div class="hint">标签不再是需要你单独维护的「分类」：它长在你的积木上 —— 到
               <a href="#/docs">积木编辑器</a>里给一篇积木贴上标签，这里就会多出一项，
               点它就能筛出贴了同一个标签的积木。置顶推荐最多 ${data.pinLimit} 篇（已置顶 ${pinnedCount} 篇）。</div>
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

    ${hasProfileDoc && !profileSeeded ? statsHtml : ''}

    ${isOwner ? '' : followCards}`;
}

/* ------------------------------------------------------------------ */
/* 视图：消息通知                                                      */

// ── 导出 ──────────────────────────────────────────────────────────────
export { viewUser };

/* @hand-written */
