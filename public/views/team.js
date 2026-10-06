// 团队（P4）：团队列表 #/teams、团队主页 #/team/<slug>。
//
// 三条约定，改这个文件之前先读一遍：
//   1) 事件不进 core/events.js 的中央 switch，改成对 ui.app 做**一次性委托**，
//      靠 data-team-action 属性分发。中央 switch 被 check-ui-contract 盯着，
//      而页面上的控件天天变 —— 这是 P1 动态流踩出来的写法。
//   2) 服务端给的 canEdit / myRole / canJoin **只是界面提示**：它们可能在两次
//      点击之间就变了。真正的判定每次都发生在服务端，前端拿到 403 / 404 就照实
//      报错，不要自作聪明地把按钮藏起来假装事情没发生。
//   3) 这个文件里出现的每一个类名字面量都必须在 public/css/86-team.css 里
//      有对应规则，否则 scripts/check-ui-contract.mjs 会红。注意它是按
//      「类名等于引号引起来的东西」去扫的，连注释里随手写的省略号样式
//      都会被当成一个类名 —— 所以别在注释里演示那种写法。
//   4) 主页的三个页签（讨论 / 文件 / 群聊）走地址栏的 ?tab= 参数，不做「就地隐藏切换」：
//      切页签得重新走一遍 route()，视图才有机会去拉那一页的数据。草稿在 teamState.draft 里，
//      整页重画不会丢。
//   5) 群聊的定时轮询由本模块自己负责停。core/api.js 的「页面代次」守卫是给
//      「视图渲染期间发出的请求」准备的，而 setInterval 回调发起请求时 routeInFlight
//      是 null —— 守卫压根不会拦它。所以每个渲染入口都先 stopChatPolling()。
import { $, copyText, esc, emptyHtml, loadingHtml, selectText, toast, ui } from '../core/dom.js';
import { api, withButtonBusy } from '../core/api.js';
import { apiErrorText, toastError } from '../core/errors.js';
import { state } from '../core/state.js';
import { navigate, routeQuery } from '../core/router.js';
import * as Avatar from '../core/avatar.js';
import * as Fmt from '../core/format.js';
import { paginationHtml } from '../core/widgets.js';
// 公式排版复用站点原本那一套（离线 KaTeX，就在 /notes/vendor 下）。
// 动态流、积木页用的都是它 —— 这里没有第二份数学渲染实现。
// 服务端 renderMarkdown **从不排公式**，只把 `$…$` / `$$…$$` 原样吐出来，
// 所以团队帖的正文必须在这儿补一次，否则 `$E=mc^2$` 就是一段等宽源码。
import { ntRenderMath } from './notes.js';

/** 兜底的四档可见范围：正常情况用服务端返回的 SCOPE_OPTIONS 覆盖它。 */
const FALLBACK_SCOPES = [
  { value: 'public', label: '公开' },
  { value: 'followers', label: '仅关注我的人' },
  { value: 'team', label: '仅团队' },
  { value: 'private', label: '仅自己' },
];
const SCOPE_ICON = { public: '🌍', followers: '👥', team: '🎽', private: '🔒' };

/**
 * 模块级状态。**故意不是每次渲染重建的**：
 * 保存后要整页重画，而用户正在框里写字 —— 重画一次就把草稿抹了。
 * 所以草稿单独存在这里，重画时从它取值填回去。
 */
const teamState = {
  scopes: FALLBACK_SCOPES,
  draft: {
    title: '',
    content: '',
    scope: 'team',
    name: '',
    intro: '',
    slug: '',
    joinPolicy: 'open',
    username: '',
    message: '',
    // 广场「用团队号加入」那个输入框，和团队公告的编辑框。
    // ⚠️ 新加的 key 必须写在这里：下面的 input/change 委托只认 draft 里已有的键。
    code: '',
    announcement: '',
  },
  editing: null,
  conflict: null,
  panel: null,
  /** 团队公告的编辑态。true 时顶部那块画成可写的框。 */
  noticeEditing: false,
  /** 当前团队主页的快照。局部重画（成员名单、文件柜、群聊）要用，免得整页重来把草稿冲掉。 */
  team: null,
  members: [],
  memberTotal: 0,
  membersExpanded: false,
  membersAll: [],
  filesData: null,
  maxFileBytes: 0,
};
/** 列表里每条帖子的原始数据：编辑要用回原文，渲染出来的是 HTML。 */
const postCache = new Map();

/** 三个页签。讨论页是默认页签，所以它的地址里不带 tab 参数。 */
const TEAM_TABS = [
  ['discuss', '💬 讨论'],
  ['files', '📁 文件'],
  ['chat', '🗨️ 群聊'],
];
/** 与 src/modules/team/schema.js 的 MAX_TEAM_FILE_BYTES 对齐：真正的裁判是服务端。 */
const FALLBACK_MAX_FILE_BYTES = 4 * 1024 * 1024;
/** 群聊轮询间隔。 */
const CHAT_POLL_MS = 5000;

let chatTimer = null;
/** 群聊的增量游标与当前列表：只记最新一条的 id，轮询时用 ?after= 拿新消息。 */
const chatState = { slug: '', latestId: 0, messages: [] };

/**
 * 停掉群聊轮询。**每个渲染入口都要先调它**：
 * core/api.js 的「页面代次」守卫对 setInterval 回调是失效的（见文件头第 5 条），
 * 不自己停，用户切走之后它还会继续往别的页面上写。
 */
function stopChatPolling() {
  if (chatTimer) clearInterval(chatTimer);
  chatTimer = null;
}

/** 字节数说人话。core/format.js 只有时间/数字，没有文件大小。 */
function sizeLabel(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(2)} MB`;
}

function fileIcon(file) {
  const name = String(file?.name ?? '').toLowerCase();
  if (/\.(png|jpe?g|gif|webp|bmp|svg)$/.test(name)) return '🖼️';
  if (/\.(zip|rar|7z|tar|gz)$/.test(name)) return '🗜️';
  if (/\.(mp3|wav|ogg|m4a|flac)$/.test(name)) return '🎵';
  if (/\.(mp4|mov|mkv|webm|avi)$/.test(name)) return '🎬';
  if (/\.pdf$/.test(name)) return '📕';
  if (/\.(xlsx?|csv)$/.test(name)) return '📊';
  if (/\.docx?$/.test(name)) return '📘';
  if (/\.(txt|md|json|js|mjs|css|html|py|sql|ya?ml)$/.test(name)) return '📄';
  return '📦';
}

/** 把选中的文件读成 data URL。服务端收的就是 {name, dataUrl} —— 零依赖，不写 multipart。 */
function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('这个文件读不出来，换一个试试'));
    reader.readAsDataURL(file);
  });
}

function teamTabsHtml(team, tab, query) {
  const links = TEAM_TABS.map(([value, label]) => {
    const href = routeQuery(`/team/${team.slug}`, query, {
      tab: value === 'discuss' ? null : value,
      page: null,
      fpage: null,
    });
    return `<a class="team-tab ${value === tab ? 'is-active' : ''}" href="${href}">${label}</a>`;
  }).join('');
  return `<div class="team-tabs">${links}</div>`;
}

const scopeLabel = (value) => teamState.scopes.find((item) => item.value === value)?.label ?? '仅团队';
const scopeOptionsHtml = (selected) =>
  teamState.scopes
    .map((item) => `<option value="${esc(item.value)}" ${item.value === selected ? 'selected' : ''}>${esc(item.label)}</option>`)
    .join('');

function resetTransient() {
  teamState.editing = null;
  teamState.conflict = null;
  teamState.panel = null;
  teamState.noticeEditing = false;
}

/* ── 团队列表 ──────────────────────────────────────────────────────── */

function teamCardHtml(team) {
  const role = team.myRoleLabel ? `<span class="team-card-role">${esc(team.myRoleLabel)}</span>` : '';
  return `<article class="card team-card">
    <div class="team-card-head">
      <a class="team-card-name" href="#/team/${encodeURIComponent(team.slug)}">${esc(team.name)}</a>
      ${role}
    </div>
    <p class="team-card-intro">${team.intro ? esc(team.intro) : '这个团队还没有写简介。'}</p>
    <div class="team-card-meta">
      <span class="team-card-owner">${Avatar.avatarHtml(team.owner, 'avatar-sm')}<span>${esc(team.owner.displayName)}</span></span>
      <span class="hint">${Fmt.fmtNum(team.memberCount)} 名成员</span>
      <span class="hint">${Fmt.fmtNum(team.postCount)} 篇帖子</span>
      <span class="hint">${esc(team.joinPolicyLabel)}</span>
    </div>
  </article>`;
}

/**
 * 广场顶上的「用团队号加入」。
 *
 * 团队号 = 6 位、只用念得出口也不会念错的字符（服务端连 I/L/O 抄错的写法都折叠）。
 * 这里只管把用户敲的东西原样递过去，怎么认是服务端的事。
 */
function joinCodeHtml() {
  if (!state.me) return '';
  return `<div class="card team-join">
    <div class="team-join-title">🔑 用团队号加入</div>
    <p class="hint">问团队里的朋友要一个 6 位团队号（团队主页顶上就有）。写着「需要邀请」的团队也走这里 —— 团队号本身就是邀请。</p>
    <div class="team-join-bar">
      <input class="input team-join-input" data-team-field="code" maxlength="12" value="${esc(teamState.draft.code)}"
        placeholder="比如 K7M2QP" autocomplete="off" spellcheck="false" aria-label="团队号" />
      <button class="btn btn-primary" data-team-action="join-by-code">加入</button>
    </div>
  </div>`;
}

function createFormHtml() {
  if (!state.me) return '';
  if (teamState.panel !== 'create') {
    return `<div class="team-toolbar"><button class="btn btn-primary" data-team-action="open-create">＋ 新建团队</button></div>`;
  }
  return `<div class="card team-form">
    <div class="team-form-title">新建团队</div>
    <label class="team-field"><span class="team-field-label">团队名</span>
      <input class="input" data-team-field="name" maxlength="40" value="${esc(teamState.draft.name)}" placeholder="比如：前端小组" /></label>
    <label class="team-field"><span class="team-field-label">简介</span>
      <textarea class="input" data-team-field="intro" rows="2" maxlength="300" placeholder="这个团队是干什么的">${esc(teamState.draft.intro)}</textarea></label>
    <label class="team-field"><span class="team-field-label">地址（可留空，会自动生成）</span>
      <input class="input" data-team-field="slug" maxlength="40" value="${esc(teamState.draft.slug)}" placeholder="英文小写字母、数字、短横线" /></label>
    <label class="team-field"><span class="team-field-label">谁能加入</span>
      <select class="input" data-team-field="joinPolicy">
        <option value="open" ${teamState.draft.joinPolicy === 'open' ? 'selected' : ''}>谁都能加入</option>
        <option value="invite" ${teamState.draft.joinPolicy === 'invite' ? 'selected' : ''}>需要邀请</option>
      </select></label>
    <div class="team-form-bar">
      <button class="btn btn-primary" data-team-action="create-team">建好了</button>
      <button class="btn" data-team-action="close-panel">取消</button>
    </div>
  </div>`;
}

async function viewTeams(query) {
  bindTeamOnce();
  stopChatPolling(); // 从团队主页切回列表：群聊轮询到这儿必须断掉
  resetTransient();
  const mine = query.get('mine') === '1';
  ui.app.innerHTML = `<div class="team-page">
    <div class="page-head"><h1 class="team-page-title">🎽 团队</h1>
      <p class="hint">一群人一块地方：团队主页上能发帖，帖子能设成「只有本团队看得见」，成员还能一起改同一篇。</p></div>
    <div class="team-tabs">
      <a class="team-tab ${mine ? '' : 'is-active'}" href="#/teams">全部团队</a>
      <a class="team-tab ${mine ? 'is-active' : ''}" href="#/teams?mine=1">我加入的</a>
    </div>
    <div data-team-join></div>
    <div data-team-create></div>
    <div data-team-list>${loadingHtml()}</div>
    <div data-team-pager></div>
  </div>`;

  const joinBox = $('[data-team-join]');
  if (joinBox) joinBox.innerHTML = joinCodeHtml();

  const createBox = $('[data-team-create]');
  if (createBox) createBox.innerHTML = createFormHtml();

  let data;
  try {
    data = await api(`/api/teams?${mine ? 'mine=1&' : ''}page=${encodeURIComponent(query.get('page') || '1')}`);
  } catch (error) {
    if (error?.aborted) return;
    const text = apiErrorText(error);
    if (!text) return;
    const list = $('[data-team-list]');
    if (list) list.innerHTML = `<div class="card">${emptyHtml('😵', esc(text))}</div>`;
    return;
  }
  const list = $('[data-team-list]');
  if (!list) return; // 期间用户又点了别处

  const items = Array.isArray(data.items) ? data.items : [];
  if (Array.isArray(data.scopes) && data.scopes.length) teamState.scopes = data.scopes;
  list.innerHTML = items.length
    ? items.map(teamCardHtml).join('')
    : `<div class="card">${emptyHtml('🎽', mine ? '你还没加入任何团队' : '还没有团队', mine ? '去「全部团队」逛逛，或者自己建一个' : '点上面的「新建团队」，开第一个')}</div>`;

  const pager = $('[data-team-pager]');
  if (pager) {
    pager.innerHTML = paginationHtml(Number(data.page) || 1, Number(data.totalPages) || 1, (target) =>
      routeQuery('/teams', query, { page: target === 1 ? null : String(target) }),
    );
  }
}

/* ── 团队主页 ──────────────────────────────────────────────────────── */

function memberChipHtml(member, team) {
  const owner = team.owner?.id === member.user.id;
  const tools = [];
  // 改角色只有创建者能做（服务端 PUT members/:id 也是这么判的）；
  // 踢人管理员就行，所以这里放宽到 canManage —— 与服务端对齐，别自己收窄。
  if (team.myRole === 'owner' && !owner) {
    tools.push(
      member.teamRole === 'admin'
        ? `<button class="team-mini" data-team-action="demote-member" data-team-user="${member.user.id}">降为成员</button>`
        : `<button class="team-mini" data-team-action="promote-member" data-team-user="${member.user.id}">设为管理员</button>`,
    );
  }
  if (team.canManage && !owner) {
    tools.push(`<button class="team-mini team-mini-danger" data-team-action="kick-member" data-team-user="${member.user.id}">移出</button>`);
  }
  return `<div class="team-member">
    ${Avatar.avatarHtml(member.user, 'avatar-sm')}
    <a class="team-member-name" href="#/u/${encodeURIComponent(member.user.username)}">${esc(member.user.displayName)}</a>
    <span class="team-member-role">${esc(member.teamRoleLabel)}</span>
    ${tools.length ? `<span class="team-member-tools">${tools.join('')}</span>` : ''}
  </div>`;
}

/**
 * 团队公告。**只有成员看得到** —— 服务端就不给非成员这个字段（见 shape.js），
 * 所以这里判「joined / canManage」是在跟自己对齐，不是在防守。
 *
 * 团长和管理员能在原地把它改成编辑态；保存后服务端会给每个成员发一条通知。
 */
function noticeHtml(team) {
  if (!team.joined && !team.canManage) return '';
  if (teamState.noticeEditing && team.canManage) {
    return `<div class="team-notice is-editing" data-team-notice>
      <div class="team-notice-head">
        <span class="team-notice-title">📢 团队公告</span>
        <span class="hint">保存之后，队里每个人都会收到一条通知。</span>
      </div>
      <textarea class="input team-notice-input" data-team-field="announcement" rows="4" maxlength="2000"
        placeholder="比如：周五晚上八点，语音聊一下下个版本做啥">${esc(teamState.draft.announcement)}</textarea>
      <div class="team-notice-bar">
        <button class="btn btn-primary" data-team-action="save-announcement">保存公告</button>
        <button class="btn" data-team-action="cancel-announcement">取消</button>
      </div>
    </div>`;
  }
  const body = team.announcement
    ? `<div class="team-notice-body">${esc(team.announcement.text)}</div>
       <div class="team-notice-meta">${esc(team.announcement.author?.displayName ?? '（已注销）')} 写于 ${team.announcement.editedAt ? Fmt.timeAgo(team.announcement.editedAt) : '刚刚'}</div>`
    : `<div class="team-notice-body is-empty">还没有公告。${team.canManage ? '写一条，队里每个人都会收到通知。' : '等团长或管理员发话。'}</div>`;
  const tools = team.canManage ? `<button class="btn btn-sm" data-team-action="edit-announcement">${team.announcement ? '改公告' : '写公告'}</button>` : '';
  return `<div class="team-notice" data-team-notice>
    <div class="team-notice-head"><span class="team-notice-title">📢 团队公告</span>${tools}</div>
    ${body}
  </div>`;
}

/** 只重画团队主页顶部那块（团队号 + 公告）。整页重画会把编辑到一半的字冲掉。 */
function repaintNotice() {
  const hero = $('[data-team-hero]');
  if (hero && teamState.team) hero.innerHTML = teamHeroHtml(teamState.team, teamState.memberTotal);
}

function teamHeroHtml(team, memberTotal) {
  const buttons = [];
  if (team.canJoin) buttons.push(`<button class="btn btn-primary" data-team-action="join-team">加入团队</button>`);
  else if (team.joined && team.myRole !== 'owner') buttons.push(`<button class="btn" data-team-action="leave-team">退出团队</button>`);
  if (team.canManage) buttons.push(`<button class="btn" data-team-action="toggle-settings">团队设置</button>`);
  if (team.myRole === 'owner') buttons.push(`<button class="btn btn-danger" data-team-action="disband-team">解散团队</button>`);

  const settings = teamState.panel === 'settings' && team.canManage
    ? `<div class="card team-form">
        <div class="team-form-title">团队设置</div>
        <label class="team-field"><span class="team-field-label">团队名</span>
          <input class="input" data-team-field="name" maxlength="40" value="${esc(teamState.draft.name || team.name)}" /></label>
        <label class="team-field"><span class="team-field-label">简介</span>
          <textarea class="input" data-team-field="intro" rows="2" maxlength="300">${esc(teamState.draft.intro || team.intro)}</textarea></label>
        <label class="team-field"><span class="team-field-label">谁能加入</span>
          <select class="input" data-team-field="joinPolicy">
            <option value="open" ${team.joinPolicy === 'open' ? 'selected' : ''}>谁都能加入</option>
            <option value="invite" ${team.joinPolicy === 'invite' ? 'selected' : ''}>需要邀请</option>
          </select></label>
        <div class="team-form-bar">
          <button class="btn btn-primary" data-team-action="save-settings">保存设置</button>
          <button class="btn" data-team-action="close-panel">取消</button>
        </div>
      </div>`
    : '';

  const invite = team.canManage
    ? `<div class="team-invite">
        <input class="input team-invite-input" data-team-field="username" placeholder="输入用户名，把人拉进来" value="${esc(teamState.draft.username)}" />
        <button class="btn" data-team-action="invite-member">拉进团队</button>
      </div>`
    : '';

  // 团队号只在成员这一侧有值（服务端给的）。给要进来的人念一下，比复制链接方便。
  const code = team.joinCode
    ? `<div class="team-code">
        <span class="team-code-label">团队号</span>
        <b class="team-code-value" data-team-code>${esc(team.joinCode)}</b>
        <button class="btn btn-sm" data-team-action="copy-join-code" data-code="${esc(team.joinCode)}">复制</button>
        <span class="hint">把这个号发给要拉进来的人，他们在团队广场就能加入。</span>
      </div>`
    : '';

  return `<div class="card team-hero">
    <div class="team-hero-head">
      <div class="team-hero-title">
        <h1 class="team-title">${esc(team.name)}</h1>
        <span class="team-slug">#${esc(team.slug)}</span>
        ${team.myRoleLabel ? `<span class="team-card-role">${esc(team.myRoleLabel)}</span>` : ''}
      </div>
      <div class="team-hero-actions">${buttons.join('')}</div>
    </div>
    <p class="team-intro">${team.intro ? esc(team.intro) : '这个团队还没有写简介。'}</p>
    <div class="team-stats">
      <span class="team-stat"><b class="team-stat-num">${Fmt.fmtNum(memberTotal)}</b><span class="team-stat-label">成员</span></span>
      <span class="team-stat"><b class="team-stat-num">${Fmt.fmtNum(team.postCount)}</b><span class="team-stat-label">帖子</span></span>
      <span class="team-stat"><b class="team-stat-num">${esc(team.joinPolicyLabel)}</b><span class="team-stat-label">加入方式</span></span>
      <span class="team-stat"><b class="team-stat-num">${esc(team.owner.displayName)}</b><span class="team-stat-label">创建者</span></span>
    </div>
    ${code}
    ${noticeHtml(team)}
    ${settings}
    ${invite}
  </div>`;
}

function membersHtml(members, memberTotal, team, expanded = false) {
  if (!members.length) return '';
  const more = memberTotal > members.length ? `<span class="hint">等 ${Fmt.fmtNum(memberTotal)} 人</span>` : '';
  // 详情接口只给前 12 个成员（页面别一上来就渲染几百个人），要看全的走「查看全部」。
  const bar = expanded
    ? `<div class="team-members-bar"><button class="btn btn-sm" data-team-action="collapse-members">收起名单</button></div>`
    : memberTotal > members.length
      ? `<div class="team-members-bar"><button class="btn btn-sm" data-team-action="load-all-members">查看全部 ${Fmt.fmtNum(memberTotal)} 位成员</button></div>`
      : '';
  return `<div class="card team-members">
    <div class="team-members-title">成员 ${more}</div>
    <div class="team-members-list">${members.map((member) => memberChipHtml(member, team)).join('')}</div>
    ${bar}
  </div>`;
}

/** 只重画成员区。整页重画会把用户在框里写的字冲掉，这里是他的名字旁边点按钮。 */
function repaintMembers() {
  const box = $('[data-team-members]');
  const team = teamState.team;
  if (!box || !team) return;
  const expanded = teamState.membersExpanded && teamState.membersAll.length > 0;
  box.innerHTML = membersHtml(
    expanded ? teamState.membersAll : teamState.members,
    teamState.memberTotal,
    team,
    expanded,
  );
}

/**
 * 名单展开着的时候重新拉一遍全量成员：踢人 / 改角色 / 退出之后，
 * 只靠详情接口那前 12 条会把已经走了的人留在名单里。
 */
async function reloadMembers(team) {
  if (!teamState.membersExpanded) return;
  const data = await api(`/api/teams/${encodeURIComponent(team.slug)}/members`);
  teamState.membersAll = Array.isArray(data.items) ? data.items : [];
  repaintMembers();
}

function composerHtml(team) {
  if (!state.me) {
    return `<div class="card team-composer team-composer-guest">
      <div class="hint">登录并加入团队之后，就能在这里发帖了。</div>
      <a class="btn btn-primary" href="#/login">去登录</a>
    </div>`;
  }
  if (!team.joined) {
    return `<div class="card team-composer team-composer-guest">
      <div class="hint">${team.joinPolicy === 'invite' ? '这个团队需要邀请才能加入，找管理员拉你进去。' : '加入这个团队之后就能在这里发帖了。'}</div>
    </div>`;
  }
  return `<div class="card team-composer" data-team-editor>
    <input class="input team-composer-title" data-team-field="title" maxlength="120" placeholder="标题" value="${esc(teamState.draft.title)}" />
    <textarea class="input team-composer-body" data-team-field="content" rows="4" placeholder="写点什么给团队看…支持 Markdown 和 $LaTeX$">${esc(teamState.draft.content)}</textarea>
    <div class="team-md-preview md" data-team-preview hidden></div>
    <div class="team-composer-bar">
      <select class="input team-scope-select" data-team-field="scope">${scopeOptionsHtml(teamState.draft.scope)}</select>
      <button class="btn" type="button" data-team-action="preview">👁 预览</button>
      <button class="btn btn-primary" data-team-action="create-post">发到团队</button>
    </div>
  </div>`;
}

function conflictHtml(conflict) {
  return `<div class="team-conflict">
    <div class="team-conflict-title">⚠️ 有人在你之前改过了</div>
    <div class="hint">你看的是第 ${esc(String(conflict.mineVersion))} 版，现在已经到第 ${esc(String(conflict.latest.version))} 版。</div>
    <div class="team-conflict-latest md">${conflict.latest.contentHtml ?? ''}</div>
    <div class="team-conflict-bar">
      <button class="btn btn-primary" data-team-action="take-latest" data-team-post="${conflict.postId}">看别人的新版</button>
      <button class="btn btn-danger" data-team-action="force-save" data-team-post="${conflict.postId}">仍然保存我的</button>
    </div>
  </div>`;
}

function teamPostHtml(post) {
  const editing = teamState.editing === post.id;
  const conflict = teamState.conflict?.postId === post.id ? teamState.conflict : null;
  const editor = post.editor && post.edited
    ? `<span class="hint">最后由 ${esc(post.editor.displayName)} 改过</span>`
    : '';

  const body = editing
    ? `<div class="team-post-edit" data-team-editor>
        <input class="input team-post-edit-title" data-team-field="title" maxlength="120" value="${esc(teamState.draft.title)}" />
        <textarea class="input team-post-edit-body" data-team-field="content" rows="8" placeholder="支持 Markdown 和 $LaTeX$">${esc(teamState.draft.content)}</textarea>
        <div class="team-md-preview md" data-team-preview hidden></div>
        <div class="team-post-edit-bar">
          <select class="input team-scope-select" data-team-field="scope">${scopeOptionsHtml(teamState.draft.scope)}</select>
          <button class="btn" type="button" data-team-action="preview">👁 预览</button>
          <button class="btn btn-primary" data-team-action="save-post" data-team-post="${post.id}">保存</button>
          <button class="btn" data-team-action="cancel-edit">取消</button>
        </div>
        ${conflict ? conflictHtml(conflict) : ''}
      </div>`
    : `<div class="team-post-body md">${post.contentHtml ?? ''}</div>`;

  const tools = [];
  if (post.canEdit) tools.push(`<button class="team-mini" data-team-action="edit-post" data-team-post="${post.id}">编辑</button>`);
  if (post.canDelete) tools.push(`<button class="team-mini team-mini-danger" data-team-action="delete-post" data-team-post="${post.id}">删除</button>`);

  return `<article class="card team-post" data-team-post-card="${post.id}">
    <div class="team-post-head">
      <h2 class="team-post-title">${esc(post.title)}</h2>
      <span class="team-post-scope" title="${esc(post.scopeLabel)}">${SCOPE_ICON[post.scope] ?? '🎽'} ${esc(post.scopeLabel)}</span>
    </div>
    <div class="team-post-meta">
      ${Avatar.avatarHtml(post.author, 'avatar-sm')}
      <a class="team-post-author" href="#/u/${encodeURIComponent(post.author.username ?? '')}">${esc(post.author.displayName ?? post.author.username ?? '未知')}</a>
      <span class="hint">${Fmt.timeAgo(post.createdAt)}</span>
      <span class="team-post-version">第 ${Fmt.fmtNum(post.version)} 版</span>
      ${editor}
      ${tools.length ? `<span class="team-post-tools">${tools.join('')}</span>` : ''}
    </div>
    ${body}
  </article>`;
}

/* ── 文件柜 ────────────────────────────────────────────────────────── */

function fileRowHtml(file) {
  const tools = [`<a class="team-file-download" href="${esc(file.downloadUrl)}">下载</a>`];
  if (file.canDelete) {
    tools.push(`<button class="team-mini team-mini-danger" data-team-action="delete-file" data-team-file="${file.id}">删除</button>`);
  }
  return `<div class="team-file">
    <span class="team-file-icon" aria-hidden="true">${fileIcon(file)}</span>
    <span class="team-file-main">
      <span class="team-file-name">${esc(file.name)}</span>
      <span class="team-file-meta">${esc(file.sizeLabel || sizeLabel(file.size))} · ${esc(file.uploader?.displayName ?? '')} · ${Fmt.timeAgo(file.createdAt)}</span>
    </span>
    <span class="team-file-tools">${tools.join('')}</span>
  </div>`;
}

function fileCabinetHtml(team, data, error) {
  const maxBytes = Number(data?.maxBytes) || teamState.maxFileBytes || FALLBACK_MAX_FILE_BYTES;
  const items = Array.isArray(data?.items) ? data.items : [];
  const upload = team.joined
    ? `<span class="team-file-upload">
        <label class="btn btn-sm team-file-pick">＋ 上传文件
          <input class="team-file-picker" type="file" data-team-file-picker /></label>
        <span class="hint">单个文件不超过 ${esc(sizeLabel(maxBytes))}</span>
      </span>`
    : '<span class="hint">只有团队成员能上传和下载</span>';
  const list = error
    ? `<div class="team-files-empty">${emptyHtml('😵', esc(error))}</div>`
    : items.length
      ? `<div class="team-file-list">${items.map(fileRowHtml).join('')}</div>`
      : `<div class="team-files-empty">${emptyHtml('📁', '文件柜还是空的', team.joined ? '第一个文件由你来传' : '加入之后就能看到')}</div>`;
  return `<div class="card team-files">
    <div class="team-files-head">
      <div class="team-files-title">📁 文件柜</div>
      ${upload}
    </div>
    ${list}
  </div>`;
}

/** 用当前快照重画文件柜（上传成功后就地补一条，不重新请求）。 */
function repaintFiles() {
  const box = $('[data-team-files]');
  if (!box || !teamState.team) return;
  box.innerHTML = fileCabinetHtml(teamState.team, teamState.filesData, '');
}

async function renderFiles(team, query) {
  const box = $('[data-team-files]');
  if (!box) return;
  if (!state.me || !team.joined) {
    box.innerHTML = fileCabinetHtml(team, null, '');
    return;
  }
  const page = Number(query.get('fpage')) || 1;
  let data;
  try {
    data = await api(`/api/teams/${encodeURIComponent(team.slug)}/files?page=${page}`);
  } catch (error) {
    if (error?.aborted) return;
    const text = apiErrorText(error);
    if (!text) return;
    if (!$('[data-team-files]')) return; // 期间用户切走了
    box.innerHTML = `<div class="card team-files">${emptyHtml('😵', esc(text))}</div>`;
    return;
  }
  if (!$('[data-team-files]')) return;
  teamState.filesData = data;
  teamState.maxFileBytes = Number(data.maxBytes) || teamState.maxFileBytes;
  repaintFiles();
  const pager = $('[data-team-files-pager]');
  if (pager) {
    pager.innerHTML = paginationHtml(Number(data.page) || 1, Number(data.totalPages) || 1, (target) =>
      routeQuery(`/team/${team.slug}`, query, { tab: 'files', fpage: target === 1 ? null : String(target) }),
    );
  }
}

/* ── 群聊 ──────────────────────────────────────────────────────────── */

function chatMessageHtml(message) {
  const tools = message.canDelete
    ? `<button class="team-mini team-mini-danger" data-team-action="delete-message" data-team-message="${message.id}">删除</button>`
    : '';
  return `<div class="team-chat-msg" data-team-message-card="${message.id}">
    ${Avatar.avatarHtml(message.author, 'avatar-sm')}
    <div class="team-chat-body">
      <div class="team-chat-meta">
        <a class="team-chat-author" href="#/u/${encodeURIComponent(message.author?.username ?? '')}">${esc(message.author?.displayName ?? '未知')}</a>
        <span class="team-chat-time">${Fmt.timeAgo(message.createdAt)}</span>
        ${tools ? `<span class="team-chat-tools">${tools}</span>` : ''}
      </div>
      <div class="team-chat-text">${esc(message.content)}</div>
    </div>
  </div>`;
}

function chatHtml(team) {
  if (!state.me) {
    return `<div class="card team-chat">${emptyHtml('🗨️', '群聊只有团队成员能看', '登录之后再回来')}</div>`;
  }
  if (!team.joined) {
    return `<div class="card team-chat">${emptyHtml('🗨️', '群聊只有团队成员能看', '加入团队之后就能一起聊')}</div>`;
  }
  return `<div class="card team-chat">
    <div class="team-chat-head">
      <div class="team-chat-title">🗨️ 团队群聊</div>
      <span class="hint">每 5 秒自动刷新 · 只有团队成员看得见</span>
    </div>
    <div class="team-chat-list" data-team-chat-list><span class="hint">正在加载…</span></div>
    <div class="team-chat-bar">
      <textarea class="input team-chat-input" data-team-field="message" rows="2" maxlength="1000" placeholder="说点什么…">${esc(teamState.draft.message)}</textarea>
      <button class="btn btn-primary" data-team-action="send-message">发送</button>
    </div>
  </div>`;
}

function scrollChatToEnd() {
  const list = $('[data-team-chat-list]');
  if (list && typeof list.scrollHeight === 'number') list.scrollTop = list.scrollHeight;
}

function paintChat() {
  const box = $('[data-team-chat-list]');
  if (!box) return;
  box.innerHTML = chatState.messages.length
    ? chatState.messages.map(chatMessageHtml).join('')
    : emptyHtml('🗨️', '还没人说话', '打个招呼吧');
  scrollChatToEnd();
}

/** 把新消息合进来（按 id 去重，轮询和「自己刚发的那条」都走这里）。 */
function pushChatMessages(items) {
  const known = new Set(chatState.messages.map((item) => item.id));
  let added = false;
  for (const item of items) {
    if (!item || known.has(item.id)) continue;
    chatState.messages.push(item);
    known.add(item.id);
    added = true;
  }
  if (added) paintChat();
}

async function renderChat(team) {
  const box = $('[data-team-chat]');
  if (!box) return;
  box.innerHTML = chatHtml(team);
  if (!state.me || !team.joined) return;
  let data;
  try {
    data = await api(`/api/teams/${encodeURIComponent(team.slug)}/messages`);
  } catch (error) {
    if (error?.aborted) return;
    const text = apiErrorText(error);
    const list = $('[data-team-chat-list]');
    if (list && text) list.innerHTML = emptyHtml('😵', esc(text));
    return;
  }
  if (!$('[data-team-chat-list]')) return; // 期间用户切走了
  chatState.slug = team.slug;
  chatState.latestId = Number(data.latestId) || 0;
  chatState.messages = Array.isArray(data.items) ? data.items : [];
  paintChat();
}

async function pollChat(team) {
  if (!chatState.latestId) return;
  if (currentSlug() !== team.slug || !$('[data-team-chat-list]')) return stopChatPolling();
  const data = await api(`/api/teams/${encodeURIComponent(team.slug)}/messages?after=${chatState.latestId}`);
  if (!$('[data-team-chat-list]')) return;
  pushChatMessages(Array.isArray(data.items) ? data.items : []);
  chatState.latestId = Math.max(chatState.latestId, Number(data.latestId) || 0);
}

function startChatPolling(team) {
  stopChatPolling();
  chatTimer = setInterval(() => {
    if (document.visibilityState === 'hidden') return; // 页面在后台就别问了
    pollChat(team).catch(() => stopChatPolling());
  }, CHAT_POLL_MS);
}

/** 选中文件 → 客户端先按上限拦一道 → 读成 data URL → 上传。服务端还会再校验一遍。 */
async function uploadTeamFile(picker) {
  const team = teamState.team;
  const file = picker?.files?.[0];
  if (!team || !file) return;
  const maxBytes = Number(teamState.maxFileBytes) || FALLBACK_MAX_FILE_BYTES;
  if (file.size > maxBytes) {
    toast(`这个文件太大了，单个最多 ${sizeLabel(maxBytes)}`, 'error');
    picker.value = '';
    return;
  }
  picker.disabled = true;
  toast('正在上传…', 'info');
  try {
    const dataUrl = await fileToDataUrl(file);
    const data = await api(`/api/teams/${encodeURIComponent(team.slug)}/files`, {
      method: 'POST',
      body: { name: file.name, dataUrl },
    });
    if (teamState.filesData) {
      teamState.filesData.items = [data.file, ...(teamState.filesData.items ?? [])];
      teamState.filesData.total = (Number(teamState.filesData.total) || 0) + 1;
      repaintFiles();
    } else {
      await renderFiles(team, currentQuery());
    }
    toast('上传好了', 'success');
  } finally {
    picker.value = '';
    picker.disabled = false;
  }
}

async function viewTeam(handle, query) {
  bindTeamOnce();
  stopChatPolling();
  const key = String(handle ?? '');
  if (teamState.handle !== key) {
    resetTransient();
    teamState.handle = key;
    teamState.membersExpanded = false;
    teamState.membersAll = [];
    teamState.filesData = null;
    chatState.slug = '';
    chatState.latestId = 0;
    chatState.messages = [];
    postCache.clear();
  }
  const rawTab = query.get('tab');
  const tab = rawTab === 'files' || rawTab === 'chat' ? rawTab : 'discuss';

  ui.app.innerHTML = `<div class="team-page">
    <div class="team-crumb"><a href="#/teams">← 所有团队</a></div>
    <div data-team-hero>${loadingHtml()}</div>
    <div data-team-members></div>
    <div data-team-tabs></div>
    <div data-team-composer></div>
    <div data-team-posts></div>
    <div data-team-pager></div>
    <div data-team-files></div>
    <div data-team-files-pager></div>
    <div data-team-chat></div>
  </div>`;

  let data;
  try {
    data = await api(`/api/teams/${encodeURIComponent(key)}`);
  } catch (error) {
    if (error?.aborted) return;
    const text = apiErrorText(error);
    if (!text) return;
    const hero = $('[data-team-hero]');
    if (!hero) return;
    // 以前这里写的是「也许它已经解散了」—— 读起来像在陈述事实，其实只是详情没取到。
    // 404 多半是团队真没了，其它情况大概率是网络的事，分开说清楚，并且给一条退路。
    const hint = error?.status === 404 ? '这个团队不存在，或者已经被解散了' : '可能是网络断了，刷新一下再试';
    hero.innerHTML = `<div class="card team-gone">${emptyHtml('🧭', esc(text), hint)}<div class="team-gone-bar"><a class="btn" href="#/teams">← 返回团队广场</a></div></div>`;
    return;
  }
  const team = data.team;
  if (!team) {
    const hero = $('[data-team-hero]');
    if (hero) hero.innerHTML = `<div class="card team-gone">${emptyHtml('🧭', '团队不存在')}<div class="team-gone-bar"><a class="btn" href="#/teams">← 返回团队广场</a></div></div>`;
    return;
  }
  const members = Array.isArray(data.members) ? data.members : [];
  const memberTotal = Number(data.memberTotal) || members.length;

  const heroBox = $('[data-team-hero]');
  if (!heroBox) return; // 期间用户又点了别处
  teamState.team = team;
  teamState.members = members;
  teamState.memberTotal = memberTotal;
  heroBox.innerHTML = teamHeroHtml(team, memberTotal);
  repaintMembers();
  if (teamState.membersExpanded) await reloadMembers(team);
  const tabsBox = $('[data-team-tabs]');
  if (tabsBox) tabsBox.innerHTML = teamTabsHtml(team, tab, query);

  if (tab === 'files') {
    const filesBox = $('[data-team-files]');
    if (filesBox) filesBox.innerHTML = loadingHtml();
    await renderFiles(team, query);
    return;
  }
  if (tab === 'chat') {
    await renderChat(team);
    if ($('[data-team-chat-list]')) startChatPolling(team);
    return;
  }

  const composerBox = $('[data-team-composer]');
  if (composerBox) composerBox.innerHTML = composerHtml(team);

  await renderTeamPosts(team, query);
}

async function renderTeamPosts(team, query) {
  const box = $('[data-team-posts]');
  if (!box) return;
  const page = Number(query.get('page')) || 1;
  let data;
  try {
    data = await api(`/api/teams/${encodeURIComponent(team.slug)}/posts?page=${page}`);
  } catch (error) {
    if (error?.aborted) return;
    const text = apiErrorText(error);
    if (!text) return;
    box.innerHTML = `<div class="card">${emptyHtml('😵', esc(text))}</div>`;
    return;
  }
  if (Array.isArray(data.scopes) && data.scopes.length) teamState.scopes = data.scopes;
  const items = Array.isArray(data.items) ? data.items : [];
  for (const post of items) postCache.set(post.id, post);

  box.innerHTML = items.length
    ? items.map(teamPostHtml).join('')
    : `<div class="card">${emptyHtml('📝', '这个团队还没发过帖子', team.joined ? '上面就是输入框，写第一条吧' : '加入之后你也能发')}</div>`;

  const pager = $('[data-team-pager]');
  if (pager) {
    pager.innerHTML = paginationHtml(page, Number(data.totalPages) || 1, (target) =>
      routeQuery(`/team/${team.slug}`, query, { page: target === 1 ? null : String(target) }),
    );
  }

  // 公式排版必须在 innerHTML **之后** —— renderMathInElement 只处理已经在 DOM 里的节点。
  // 服务端那个 renderMarkdown 从不排公式，它只把 `$…$` / `$$…$$` 原样留在 HTML 里。
  ntRenderMath(box);
}

/** 局部重画一条帖子（不整页重画，免得把用户在别处写的东西抹掉）。 */
function repaintPost(post) {
  const node = $(`[data-team-post-card="${post.id}"]`);
  if (!node) return;
  node.outerHTML = teamPostHtml(post);
  // ⚠️ 上面那句把 `node` 换掉了：旧引用当场变成游离节点，公式得挂到**新的**那张卡上。
  ntRenderMath($(`[data-team-post-card="${post.id}"]`));
}

/* ── 事件 ──────────────────────────────────────────────────────────── */

/** 当前团队主页的 slug（从 hash 里现取，不靠闭包里的旧值）。 */
function currentSlug() {
  const parts = (window.location.hash || '').replace(/^#/, '').split('?')[0].split('/').filter(Boolean);
  return parts[0] === 'team' && parts[1] ? parts[1] : '';
}

/** 当前地址里的查询串（页签、页码都在这儿）。整页重画时靠它保住页签。 */
function currentQuery() {
  const raw = (window.location.hash || '').replace(/^#/, '');
  const index = raw.indexOf('?');
  return new URLSearchParams(index === -1 ? '' : raw.slice(index + 1));
}

function refreshTeam() {
  const slug = currentSlug();
  if (slug) return viewTeam(slug, currentQuery());
  return viewTeams(currentQuery());
}

/** 预览按钮上的两句话。写成常量，是为了让「展开」和「收起」永远对得上。 */
const PREVIEW_OPEN = '👁 预览';
const PREVIEW_CLOSE = '👁 收起预览';

/**
 * 团队帖输入框（发帖 / 编辑）的 Markdown 预览。
 *
 * 走站点既有那条路：`POST /api/markdown/preview` —— 发帖框、积木页的预览也是它，
 * 前端不自己拼一份 Markdown（那样两边迟早长得不一样）。
 *
 * 排版公式这一步**不能省**：那个接口只吐 `$…$` / `$$…$$` 原文，
 * 排版权一直归客户端的 `ntRenderMath`（见文件头 import 那段注释）。
 */
async function togglePreview(node) {
  const editor = node.closest('[data-team-editor]');
  const textarea = editor?.querySelector('[data-team-field="content"]');
  const box = editor?.querySelector('[data-team-preview]');
  if (!editor || !textarea || !box) return;

  if (!box.hidden) {
    box.hidden = true;
    node.textContent = PREVIEW_OPEN;
    return;
  }

  const text = textarea.value ?? '';
  if (text.trim() === '') {
    box.innerHTML = '<span class="hint">还没写内容。</span>';
  } else {
    const { html } = await api('/api/markdown/preview', { method: 'POST', body: { content: text } });
    box.innerHTML = html || '<span class="hint">（空内容）</span>';
    ntRenderMath(box);
  }
  box.hidden = false;
  node.textContent = PREVIEW_CLOSE;
}

async function handleAction(action, node) {
  const postId = Number(node.dataset.teamPost);
  const cached = postCache.get(postId);

  // 预览不碰任何数据，放在最前面：它不需要 postId，也不该走后面那一串分支。
  if (action === 'preview') return togglePreview(node);

  if (action === 'open-create') {
    // ⚠️ 这里**不能**写成「设好 panel 再调一次 viewTeams()」。
    // viewTeams() 一进来就 resetTransient()，而它会把 panel 清成 null ——
    // 刚点开的面板被自己抹掉，表现是「点『＋ 新建团队』毫无反应」（渲染断言看不出来这种 bug）。
    // 只重画这一个盒子就够，还顺带省掉一次整页的接口请求，用户的草稿也不会被冲掉。
    teamState.panel = 'create';
    const box = $('[data-team-create]');
    if (box) box.innerHTML = createFormHtml();
    return;
  }
  if (action === 'close-panel') {
    teamState.panel = null;
    return refreshTeam();
  }
  if (action === 'toggle-settings') {
    teamState.panel = teamState.panel === 'settings' ? null : 'settings';
    return refreshTeam();
  }
  if (action === 'create-team') {
    return withButtonBusy(node, async () => {
      const draft = teamState.draft;
      const data = await api('/api/teams', {
        method: 'POST',
        body: { name: draft.name, intro: draft.intro, slug: draft.slug || undefined, joinPolicy: draft.joinPolicy },
      });
      teamState.draft = { ...teamState.draft, name: '', intro: '', slug: '' };
      teamState.panel = null;
      toast('团队建好了', 'success');
      navigate(`/team/${data.team.slug}`);
    });
  }
  if (action === 'save-settings') {
    const slug = currentSlug();
    return withButtonBusy(node, async () => {
      const draft = teamState.draft;
      await api(`/api/teams/${encodeURIComponent(slug)}`, {
        method: 'PUT',
        body: { name: draft.name, intro: draft.intro, joinPolicy: draft.joinPolicy },
      });
      teamState.panel = null;
      toast('团队设置已保存', 'success');
      await refreshTeam();
    });
  }
  if (action === 'join-team') {
    const slug = currentSlug();
    return withButtonBusy(node, async () => {
      await api(`/api/teams/${encodeURIComponent(slug)}/join`, { method: 'POST' });
      toast('已加入团队', 'success');
      await refreshTeam();
    });
  }
  if (action === 'join-by-code') {
    const code = String(teamState.draft.code || '').trim();
    if (!code) return toast('先填团队号', 'error');
    return withButtonBusy(node, async () => {
      const data = await api('/api/teams/join-by-code', { method: 'POST', body: { code } });
      teamState.draft = { ...teamState.draft, code: '' };
      toast(`已加入「${data.team.name}」`, 'success');
      // 直接进团队主页：加完还站在广场上，用户得自己再找一遍。
      navigate(`/team/${data.team.slug}`);
    });
  }
  if (action === 'copy-join-code') {
    const code = String(node.dataset.code || '');
    if (!code) return;
    if (await copyText(code)) return toast('团队号已复制', 'success');
    // 两条脚本复制路径都被拦下了，退到「选中 + Ctrl+C」。
    // 这一条浏览器无条件放行：键盘触发的复制不检查用户手势。
    // 页面上的团队号本来就在旁边，选中它比让用户照着念一遍有用得多。
    selectText($('[data-team-code]'));
    return toast('已选中团队号，按 Ctrl+C 复制', 'success');
  }
  if (action === 'edit-announcement' || action === 'cancel-announcement') {
    const editing = action === 'edit-announcement';
    teamState.noticeEditing = editing;
    // 进编辑态时把现有公告填进草稿；取消时也填一遍，免得下次打开还留着上次没保存的内容。
    if (editing) teamState.draft = { ...teamState.draft, announcement: teamState.team?.announcement?.text ?? '' };
    return repaintNotice();
  }
  if (action === 'save-announcement') {
    const slug = currentSlug();
    const announcement = String(teamState.draft.announcement || '');
    return withButtonBusy(node, async () => {
      const data = await api(`/api/teams/${encodeURIComponent(slug)}/announcement`, {
        method: 'PUT',
        body: { announcement },
      });
      teamState.team = data.team;
      teamState.noticeEditing = false;
      repaintNotice();
      // notified 是服务端数出来的收件人数（写公告的人自己不算）。
      toast(data.notified ? `公告保存了，通知了 ${Fmt.fmtNum(data.notified)} 位成员` : '公告保存了', 'success');
    });
  }
  if (action === 'leave-team') {
    const slug = currentSlug();
    if (!window.confirm('确定退出这个团队吗？退出之后就看不了「仅团队」的帖子了。')) return;
    return withButtonBusy(node, async () => {
      await api(`/api/teams/${encodeURIComponent(slug)}/leave`, { method: 'POST' });
      toast('已退出团队', 'success');
      await refreshTeam();
    });
  }
  if (action === 'disband-team') {
    const slug = currentSlug();
    if (!window.confirm('解散之后团队和里面的帖子都会消失（可以找回，但要找运维）。确定吗？')) return;
    return withButtonBusy(node, async () => {
      await api(`/api/teams/${encodeURIComponent(slug)}`, { method: 'DELETE' });
      toast('团队已解散', 'success');
      navigate('/teams');
    });
  }
  if (action === 'invite-member') {
    const slug = currentSlug();
    const username = String(teamState.draft.username || '').trim();
    if (!username) return toast('先填个用户名', 'error');
    return withButtonBusy(node, async () => {
      await api(`/api/teams/${encodeURIComponent(slug)}/members`, { method: 'POST', body: { username } });
      teamState.draft.username = '';
      toast(`已经把 ${username} 拉进来了`, 'success');
      await refreshTeam();
    });
  }
  if (action === 'promote-member' || action === 'demote-member') {
    const slug = currentSlug();
    const userId = Number(node.dataset.teamUser);
    return withButtonBusy(node, async () => {
      await api(`/api/teams/${encodeURIComponent(slug)}/members/${userId}`, {
        method: 'PUT',
        body: { role: action === 'promote-member' ? 'admin' : 'member' },
      });
      toast('角色改好了', 'success');
      await refreshTeam();
    });
  }
  if (action === 'kick-member') {
    const slug = currentSlug();
    const userId = Number(node.dataset.teamUser);
    if (!window.confirm('确定把这个人移出团队吗？')) return;
    return withButtonBusy(node, async () => {
      await api(`/api/teams/${encodeURIComponent(slug)}/members/${userId}`, { method: 'DELETE' });
      toast('已经移出团队', 'success');
      await refreshTeam();
    });
  }
  if (action === 'load-all-members') {
    const team = teamState.team;
    if (!team) return;
    return withButtonBusy(node, async () => {
      const data = await api(`/api/teams/${encodeURIComponent(team.slug)}/members`);
      teamState.membersAll = Array.isArray(data.items) ? data.items : [];
      teamState.membersExpanded = true;
      repaintMembers();
    });
  }
  if (action === 'collapse-members') {
    teamState.membersExpanded = false;
    repaintMembers();
    return;
  }
  if (action === 'create-post') {
    const slug = currentSlug();
    const draft = teamState.draft;
    if (!String(draft.title || '').trim()) return toast('先写个标题', 'error');
    if (!String(draft.content || '').trim()) return toast('正文还没写', 'error');
    return withButtonBusy(node, async () => {
      await api(`/api/teams/${encodeURIComponent(slug)}/posts`, {
        method: 'POST',
        body: { title: draft.title, content: draft.content, scope: draft.scope },
      });
      teamState.draft = { ...teamState.draft, title: '', content: '', scope: 'team' };
      toast('发出去了', 'success');
      await refreshTeam();
    });
  }
  if (action === 'edit-post') {
    if (!cached) return;
    teamState.editing = postId;
    teamState.conflict = null;
    teamState.draft = { ...teamState.draft, title: cached.title, content: cached.content, scope: cached.scope };
    return repaintPost(cached);
  }
  if (action === 'cancel-edit') {
    teamState.editing = null;
    teamState.conflict = null;
    return refreshTeam();
  }
  if (action === 'save-post' && cached) {
    return savePost(node, cached, { force: false });
  }
  if (action === 'force-save' && cached) {
    return savePost(node, cached, { force: true });
  }
  if (action === 'take-latest' && cached) {
    const conflict = teamState.conflict;
    teamState.editing = null;
    teamState.conflict = null;
    if (conflict?.latest) postCache.set(postId, conflict.latest);
    toast('已换成别人的新版', 'info');
    await refreshTeam();
    return;
  }
  if (action === 'delete-post' && cached) {
    const slug = currentSlug();
    if (!window.confirm('确定删掉这篇帖子吗？删了之后团队里就都看不到了。')) return;
    return withButtonBusy(node, async () => {
      await api(`/api/teams/${encodeURIComponent(slug)}/posts/${postId}`, { method: 'DELETE' });
      toast('已删除', 'success');
      await refreshTeam();
    });
  }
  if (action === 'delete-file') {
    const team = teamState.team;
    const fileId = Number(node.dataset.teamFile);
    if (!team || !Number.isInteger(fileId)) return;
    if (!window.confirm('确定删掉这个文件吗？删了就下载不到了。')) return;
    return withButtonBusy(node, async () => {
      await api(`/api/teams/${encodeURIComponent(team.slug)}/files/${fileId}`, { method: 'DELETE' });
      toast('文件已删除', 'success');
      await renderFiles(team, currentQuery());
    });
  }
  if (action === 'send-message') {
    const team = teamState.team;
    if (!team) return;
    const content = String(teamState.draft.message || '').trim();
    if (!content) return toast('消息是空的', 'error');
    return withButtonBusy(node, async () => {
      const data = await api(`/api/teams/${encodeURIComponent(team.slug)}/messages`, { method: 'POST', body: { content } });
      teamState.draft.message = '';
      const input = $('[data-team-field="message"]');
      if (input) input.value = '';
      pushChatMessages([data.message]);
      toast('已发送', 'success');
    });
  }
  if (action === 'delete-message') {
    const team = teamState.team;
    const messageId = Number(node.dataset.teamMessage);
    if (!team || !Number.isInteger(messageId)) return;
    if (!window.confirm('删掉这条消息吗？')) return;
    return withButtonBusy(node, async () => {
      await api(`/api/teams/${encodeURIComponent(team.slug)}/messages/${messageId}`, { method: 'DELETE' });
      chatState.messages = chatState.messages.filter((item) => item.id !== messageId);
      paintChat();
      toast('消息已删除', 'success');
    });
  }
}

async function savePost(node, cached, { force }) {
  const slug = currentSlug();
  const draft = teamState.draft;
  const version = force ? teamState.conflict?.latest?.version : cached.version;
  await withButtonBusy(node, async () => {
    try {
      const data = await api(`/api/teams/${encodeURIComponent(slug)}/posts/${cached.id}`, {
        method: 'PUT',
        body: { title: draft.title, content: draft.content, scope: draft.scope, version, force },
      });
      postCache.set(cached.id, data.post);
      teamState.editing = null;
      teamState.conflict = null;
      toast('保存好了', 'success');
      await refreshTeam();
    } catch (error) {
      if (error.status !== 409) throw error;
      // 版本对不上：把别人的最新版拿回来，让用户自己决定留哪一份。
      const latest = (await api(`/api/teams/${encodeURIComponent(slug)}/posts/${cached.id}`)).post;
      postCache.set(cached.id, latest);
      teamState.editing = cached.id;
      teamState.conflict = { postId: cached.id, latest, mineVersion: version };
      repaintPost(latest);
      toast('有人改过了，看看要留哪一份', 'error');
    }
  });
}

let bound = false;
function bindTeamOnce() {
  if (bound) return;
  bound = true;

  ui.app.addEventListener('click', (event) => {
    const node = event.target.closest('[data-team-action]');
    if (!node) return;
    event.preventDefault();
    handleAction(node.dataset.teamAction, node).catch((error) => toastError(error));
  });

  // 草稿实时存进模块级状态：整页重画之后还能填回去。
  ui.app.addEventListener('input', (event) => {
    const node = event.target.closest('[data-team-field]');
    if (!node) return;
    const field = node.dataset.teamField;
    if (field in teamState.draft) teamState.draft[field] = node.value;
  });
  ui.app.addEventListener('change', (event) => {
    const node = event.target.closest('[data-team-field]');
    if (!node) return;
    const field = node.dataset.teamField;
    if (field in teamState.draft) teamState.draft[field] = node.value;
  });

  // 文件柜：选好文件就传（不再点一次「上传」按钮）。失败照样由 toastError 报出来。
  ui.app.addEventListener('change', (event) => {
    const picker = event.target.closest('[data-team-file-picker]');
    if (!picker) return;
    uploadTeamFile(picker).catch((error) => toastError(error));
  });
}

// ── 导出 ──────────────────────────────────────────────────────────────
export { viewTeams };
export { viewTeam };

/* @hand-written */
