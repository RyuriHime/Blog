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
// 帖子详情页与回复是后来加的，走的是同一个 ntRenderMath，且都在 innerHTML 之后调用。
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
    // 「要不要出现在团队广场」只有创建者能改，值是 '1' / '0'（表单送出来的都是字符串）。
    listed: '',
    message: '',
    // 广场「用团队号加入」那个输入框，和团队公告的编辑框。
    // ⚠️ 新加的 key 必须写在这里：下面的 input/change 委托只认 draft 里已有的键。
    code: '',
    announcement: '',
    // 帖子详情页的回复框（同上：不加在这里，敲的字永远进不了状态）。
    reply: '',
    // 申请加入时写的那一小段理由（「需要申请」的团队才有这一栏）。
    applyMessage: '',
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
  /** 加入申请那块的快照与筛选（管理面板展开时才有值）。 */
  requests: [],
  requestsStatus: 'pending',
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
  // 隐藏的团队（没勾「出现在团队广场」）只会出现在成员自己的「我加入的」里。
  // 给一个标记说明为什么别处看不到它 —— 否则用户会以为广场坏了。
  const hidden = team.listed === false
    ? `<span class="team-card-hidden" title="这个团队没有显示在团队广场上，只有成员和拿到团队号的人找得到">🙈 已隐藏</span>`
    : '';
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
      ${hidden}
    </div>
  </article>`;
}

/**
 * 广场顶上的「用团队号加入」。
 *
 * 团队号 = 6 位、只用念得出口也不会念错的字符（服务端连 I/L/O 抄错的写法都折叠）。
 * 这里只管把用户敲的东西原样递过去，怎么认是服务端的事。
 *
 * ⚠️ 这条路**不看**「需不需要申请」：团队号本身就是邀请，见服务端那条路由的注释。
 */
function joinCodeHtml() {
  if (!state.me) return '';
  return `<div class="card team-join">
    <div class="team-join-title">🔑 用团队号加入</div>
    <p class="hint">问团队里的朋友要一个 6 位团队号（团队主页顶上就有）。写着「需要申请」的团队也走这里 —— 团队号本身就是邀请。</p>
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
        <option value="apply" ${teamState.draft.joinPolicy === 'apply' ? 'selected' : ''}>需要申请（团长和管理员审核）</option>
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

/** 设置面板里「出现在团队广场」那个下拉框当前该选哪个：用户改过就用他改的，没改过跟服务端。 */
function teamListedValue(team) {
  if (teamState.draft.listed === '0' || teamState.draft.listed === '1') return teamState.draft.listed;
  return team.listed === false ? '0' : '1';
}

function teamHeroHtml(team, memberTotal) {
  const buttons = [];
  const request = team.myRequest ?? null;
  const pending = request?.status === 'pending';
  // 「加入」和「申请」是两条路，走哪条由服务端算好的 canJoin / canApply 决定（两者互斥）。
  // 被拒之后再点一次，按钮上就写「再申请一次」—— 动作一模一样，只是把话说明白。
  if (team.canJoin) buttons.push(`<button class="btn btn-primary" data-team-action="join-team">加入团队</button>`);
  else if (team.canApply) {
    const label = request?.status === 'rejected' ? '再申请一次' : '申请加入';
    buttons.push(`<button class="btn btn-primary" data-team-action="apply-team">${label}</button>`);
  }
  if (pending) {
    buttons.push('<span class="team-pending" data-team-request-pending>⏳ 申请审核中</span>');
    buttons.push('<button class="btn btn-sm" data-team-action="withdraw-request">撤回申请</button>');
  }
  if (team.joined && team.myRole !== 'owner') buttons.push(`<button class="btn" data-team-action="leave-team">退出团队</button>`);
  if (team.canManage) {
    const count = Number(team.pendingRequestCount) || 0;
    const badge = count > 0 ? ` <b class="team-requests-badge">${Fmt.fmtNum(count)}</b>` : '';
    buttons.push(`<button class="btn" data-team-action="toggle-requests">📨 加入申请${badge}</button>`);
    buttons.push(`<button class="btn" data-team-action="toggle-settings">团队设置</button>`);
  }
  if (team.myRole === 'owner') buttons.push(`<button class="btn btn-danger" data-team-action="disband-team">解散团队</button>`);

  // 申请加入的这一步：先写一句理由（可留空）再递，递出去之后顶部会变成「⏳ 申请审核中」。
  const applyPanel = teamState.panel === 'apply' && team.canApply
    ? `<div class="card team-apply" data-team-apply>
        <div class="team-form-title">申请加入「${esc(team.name)}」</div>
        <label class="team-field"><span class="team-field-label">说一句为什么想加入（可以留空）</span>
          <textarea class="input" data-team-field="applyMessage" rows="3" maxlength="200"
            placeholder="比如：我在做前端，想找人一起看看代码">${esc(teamState.draft.applyMessage)}</textarea></label>
        <div class="team-form-bar">
          <button class="btn btn-primary" data-team-action="submit-apply">递申请</button>
          <button class="btn" data-team-action="cancel-apply">取消</button>
        </div>
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
    ${applyPanel}
  </div>`;
}

/**
 * 团队设置的**表单本体**（只画给团长 / 管理员）。
 *
 * 这段以前是塞在 hero 里的一张小卡：点开之后整个主页被顶下去一截，
 * 边上还在轮询群聊、重画公告，填到一半被整块 innerHTML 换掉是常事。
 * 现在它住在右侧抽屉里（见 `drawerHtml`），hero 只管画「设置」那个按钮。
 */
function settingsFormHtml(team) {
  // 「要不要出现在广场上」只有创建者能改，所以这一段只画给创建者；
  // 管理员带着 listed 去请求会拿到 403（服务端那一条 ensure 就是干这个的）。
  const listedField = team.myRole === 'owner'
    ? `<label class="team-field"><span class="team-field-label">出现在团队广场</span>
        <select class="input" data-team-field="listed">
          <option value="1" ${teamListedValue(team) === '1' ? 'selected' : ''}>显示在广场上</option>
          <option value="0" ${teamListedValue(team) === '0' ? 'selected' : ''}>不显示（只有成员和拿到团队号的人找得到）</option>
        </select>
        <span class="hint">藏起来之后团队主页、团队号和帖子链接照旧能用，只是广场上不再列出来。</span></label>`
    : '';

  return `<div class="team-form">
    <label class="team-field"><span class="team-field-label">团队名</span>
      <input class="input" data-team-field="name" maxlength="40" value="${esc(teamState.draft.name || team.name)}" /></label>
    <label class="team-field"><span class="team-field-label">简介</span>
      <textarea class="input" data-team-field="intro" rows="2" maxlength="300">${esc(teamState.draft.intro || team.intro)}</textarea></label>
    <label class="team-field"><span class="team-field-label">谁能加入</span>
      <select class="input" data-team-field="joinPolicy">
        <option value="open" ${teamState.draft.joinPolicy === 'open' ? 'selected' : ''}>谁都能加入</option>
        <option value="apply" ${teamState.draft.joinPolicy === 'apply' ? 'selected' : ''}>需要申请（团长和管理员审核）</option>
      </select></label>
    ${listedField}
    <div class="team-form-bar">
      <button class="btn btn-primary" data-team-action="save-settings">保存设置</button>
      <button class="btn" data-team-action="close-panel">取消</button>
    </div>
  </div>`;
}

/**
 * 右侧抽屉：团队设置与加入申请审核都从这里滑出来，不再摊在主页里。
 *
 * 两条规矩：
 *  1. 只有 `settings` / `requests` 两个 panel 走抽屉（递申请那张小卡还留在页面里 ——
 *     它只有两个输入框，弹个抽屉反而多一步）。
 *  2. 抽屉内容由 `teamState.panel` 决定，所以 `refreshTeam()`（= 重画整个 viewTeam）
 *     天然就能把它关掉或换掉，不需要额外的开关状态。
 */
function drawerHtml(team) {
  const panel = teamState.panel;
  if (!team || !team.canManage || (panel !== 'settings' && panel !== 'requests')) return '';
  const title = panel === 'settings' ? '团队设置' : '📨 加入申请';
  // 申请列表要等接口回来，先摆一个转圈；设置那张是纯表单，直接画。
  const body = panel === 'settings'
    ? `<div class="team-drawer-body" data-team-drawer-body>${settingsFormHtml(team)}</div>`
    : `<div class="team-drawer-body" data-team-drawer-body>${loadingHtml()}</div>`;

  return `<div class="team-drawer" data-team-drawer-panel="${panel}">
    <div class="team-drawer-mask" data-team-action="close-panel"></div>
    <aside class="team-drawer-box" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="team-drawer-head">
        <span class="team-drawer-title">${title}</span>
        <button class="team-mini" data-team-action="close-panel">关闭</button>
      </div>
      ${body}
    </aside>
  </div>`;
}

/**
 * 加入申请（只有团长与管理员看得到这一块）。
 *
 * 三条状态页签是**客户端筛选**：`?status=` 递给服务端，服务端只回那一档 ——
 * 不在这儿把全部申请拉回来自己过滤（申请可能很多，而「待审」是唯一天天要看的）。
 */
function joinRequestsHtml(team, data) {
  const items = Array.isArray(data.items) ? data.items : [];
  const status = String(data.status ?? 'pending');
  const tabs = [
    ['pending', `待审 ${Fmt.fmtNum(Number(data.pendingTotal) || 0)}`],
    ['approved', '已批准'],
    ['rejected', '已拒绝'],
    ['all', '全部'],
  ]
    .map(([value, label]) =>
      `<a class="team-tab ${value === status ? 'is-active' : ''}" href="#" data-team-action="requests-status" data-status="${value}">${label}</a>`,
    )
    .join('');

  const rows = items.length
    ? items
        .map((item) => {
          const tools = item.canDecide
            ? `<div class="team-request-bar">
                 <button class="btn btn-sm btn-primary" data-team-action="approve-request" data-team-request="${item.id}">批准加入</button>
                 <button class="btn btn-sm" data-team-action="reject-request" data-team-request="${item.id}">拒绝</button>
               </div>`
            : `<div class="team-request-bar">
                 <span class="team-request-status">${esc(item.statusLabel)}</span>
                 <button class="team-mini" data-team-action="drop-request" data-team-request="${item.id}">清掉这条记录</button>
               </div>`;
          return `<div class="team-request" data-team-request-card="${item.id}">
            <div class="team-request-head">
              ${Avatar.avatarHtml(item.user, 'avatar-sm')}
              <a class="team-request-name" href="#/u/${encodeURIComponent(item.user.username)}">${esc(item.user.displayName)}</a>
              <span class="hint">${Fmt.timeAgo(item.createdAt)}</span>
            </div>
            ${item.message ? `<div class="team-request-message">${esc(item.message)}</div>` : '<div class="team-request-message is-empty">（没写理由）</div>'}
            ${tools}
          </div>`;
        })
        .join('')
    : `<div class="team-request-empty"><span class="hint">${status === 'pending' ? '现在没有人等着进来。' : '这一档里还没有申请。'}</span></div>`;

  return `<div class="team-requests" data-team-requests-list>
    <div class="team-requests-head">
      <span class="hint">这一档共 ${Fmt.fmtNum(Number(data.total) || 0)} 条</span>
    </div>
    <div class="team-tabs team-requests-tabs">${tabs}</div>
    ${rows}
  </div>`;
}

/** 拉一次申请列表并画进抽屉。只有抽屉开着、且当前用户能管这个团队时才动手。 */
async function renderJoinRequests(team) {
  const box = $('[data-team-drawer-body]');
  if (!box || !team || !team.canManage || teamState.panel !== 'requests') return;
  box.innerHTML = loadingHtml();
  let data;
  try {
    data = await api(
      `/api/teams/${encodeURIComponent(team.slug)}/join-requests?status=${encodeURIComponent(teamState.requestsStatus)}`,
    );
  } catch (error) {
    if (error?.aborted) return;
    const text = apiErrorText(error);
    if (!text) return;
    box.innerHTML = emptyHtml('😵', esc(text));
    return;
  }
  teamState.requests = Array.isArray(data.items) ? data.items : [];
  const live = $('[data-team-drawer-body]');
  if (live) live.innerHTML = joinRequestsHtml(team, data);
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
    // 三种「进不来」的处境说法不一样：正等审核 / 被拒了（可以再来）/ 从没申请过。
    const status = team.myRequest?.status;
    const hint = status === 'pending'
      ? '你的申请还在等团长或者管理员审核，通过之后就能在这里发帖了。'
      : status === 'rejected'
        ? '上次的申请被拒绝了，可以再申请一次。'
        : team.joinPolicy === 'apply'
          ? '这个团队需要申请才能加入：点右上角的「申请加入」，等团长或管理员批准。'
          : '加入这个团队之后就能在这里发帖了。';
    return `<div class="card team-composer team-composer-guest">
      <div class="hint">${esc(hint)}</div>
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

/**
 * 一条团队帖。
 *
 * `detail` 是详情页（`#/team/<slug>/post/<id>`）用的：那边标题不再当链接（人已经在了），
 * 编辑/删除按钮也不画 —— 编辑那条流程收尾时要整页重画**团队主页**（`refreshTeam`），
 * 在详情页点它会把人莫名送回主页。要改帖子，回团队主页改。
 */
function teamPostHtml(post, { detail = false } = {}) {
  const editing = teamState.editing === post.id;
  const conflict = teamState.conflict?.postId === post.id ? teamState.conflict : null;
  const editor = post.editor && post.edited
    ? `<span class="hint">最后由 ${esc(post.editor.displayName)} 改过</span>`
    : '';
  const slug = post.team?.slug ?? currentSlug();
  const href = `#/team/${encodeURIComponent(slug)}/post/${post.id}`;
  const replyTotal = Number(post.replyCount) || 0;
  // 列表页把「N 条回复」也做成入口：一串已经在进行的讨论，比一句话更值得点进去。
  const replies = detail
    ? `<span class="team-post-replies" data-team-reply-count>💬 ${Fmt.fmtNum(replyTotal)} 条回复</span>`
    : replyTotal > 0
      ? `<a class="team-post-replies" href="${href}">💬 ${Fmt.fmtNum(replyTotal)} 条回复</a>`
      : '';
  const title = detail
    ? esc(post.title)
    : `<a class="team-post-title-link" href="${href}">${esc(post.title)}</a>`;

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
  // 「💬 回复」列表页和详情页都画：
  //   列表上 —— 点进去就是详情页的回复框（带上 `?reply=1`，见 handleAction）；
  //   详情上 —— 把光标直接送进回复框，读到底不用自己往下滚。
  tools.push(`<button class="team-mini" data-team-action="reply-post" data-team-post="${post.id}" title="回复这篇帖子">💬 回复</button>`);
  if (!detail && post.canEdit) tools.push(`<button class="team-mini" data-team-action="edit-post" data-team-post="${post.id}">编辑</button>`);
  if (!detail && post.canDelete) tools.push(`<button class="team-mini team-mini-danger" data-team-action="delete-post" data-team-post="${post.id}">删除</button>`);
  // 「只有作者本人能编辑」在界面上也要看得出来：canEdit 是服务端算好的（shapeTeamPost）。
  // 详情页不画编辑/删除 —— 那条编辑流程收尾时要整页重画团队主页，在详情页点它会把人送回去。

  return `<article class="card team-post" data-team-post-card="${post.id}">
    <div class="team-post-head">
      <h2 class="team-post-title">${title}</h2>
      <span class="team-post-scope" title="${esc(post.scopeLabel)}">${SCOPE_ICON[post.scope] ?? '🎽'} ${esc(post.scopeLabel)}</span>
    </div>
    <div class="team-post-meta">
      ${Avatar.avatarHtml(post.author, 'avatar-sm')}
      <a class="team-post-author" href="#/u/${encodeURIComponent(post.author.username ?? '')}">${esc(post.author.displayName ?? post.author.username ?? '未知')}</a>
      <span class="hint">${Fmt.timeAgo(post.createdAt)}</span>
      <span class="team-post-version">第 ${Fmt.fmtNum(post.version)} 版</span>
      ${editor}
      ${replies}
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
    teamState.requests = [];
    teamState.requestsStatus = 'pending';
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
    <div data-team-drawer></div>
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

  // 设置面板的草稿跟着服务端的最新值走。
  // 草稿是模块级的、跨团队还留着上一个团队的值，而设置面板**显示**的是服务端值、
  // 提交的却是草稿 —— 不同步的话「打开设置 → 直接点保存」会把加入方式悄悄写回 open。
  teamState.draft.joinPolicy = team.joinPolicy === 'apply' ? 'apply' : 'open';
  teamState.draft.listed = team.listed === false ? '0' : '1';

  repaintMembers();
  if (teamState.membersExpanded) await reloadMembers(team);
  // 抽屉（团队设置 / 加入申请）跟 hero 一起画。panel 是模块级状态、整页重画不会丢，
  // 所以「保存完 / 批完申请」这类 refreshTeam 走一遍，抽屉还留在原地。
  // ⚠️ 必须排在草稿同步**之后**：设置表单显示的是 teamState.draft 里的值。
  const drawerBox = $('[data-team-drawer]');
  if (drawerBox) drawerBox.innerHTML = drawerHtml(team);
  // 申请列表要等接口：抽屉一画出来就去拉（它不受页签影响，哪个页签都看得见）。
  if (teamState.panel === 'requests') await renderJoinRequests(team);
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
  // 正文里的 LaTeX（$…$ / $$…$$）交给 KaTeX 就地渲染。必须在 innerHTML 之后。
  ntRenderMath(box);

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

/* ── 帖子详情：一条帖子 + 它下面的一串回复 ─────────────────────────── */

/** 详情页顶部：只回答「这是哪个团队」。加入/设置/公告那些留在团队主页。 */
function detailHeroHtml(team) {
  const back = `#/team/${encodeURIComponent(team.slug)}`;
  return `<div class="card team-detail-hero">
    <div class="team-detail-team">
      <a class="team-detail-name" href="${back}">🎽 ${esc(team.name)}</a>
      <span class="hint">团队讨论</span>
    </div>
    <a class="btn btn-sm" href="${back}">← 回团队</a>
  </div>`;
}

/**
 * 一条回复。
 *
 * `contentHtml` 是服务端渲染好的（`shapeTeamReply` 里 renderMarkdown），前端**不再加工**：
 * 再动一次只会把已经转义好的内容弄坏 —— 那正是 XSS 唯一的入口。
 */
function teamReplyHtml(reply) {
  const tools = reply.canDelete
    ? `<button class="team-mini team-mini-danger" data-team-action="delete-reply" data-team-post="${reply.postId}" data-team-reply="${reply.id}">删除</button>`
    : '';
  return `<div class="team-reply" data-team-reply-card="${reply.id}">
    ${Avatar.avatarHtml(reply.author, 'avatar-sm')}
    <div class="team-reply-main">
      <div class="team-reply-head">
        <a class="team-reply-author" href="#/u/${encodeURIComponent(reply.author.username ?? '')}">${esc(reply.author.displayName ?? reply.author.username ?? '未知')}</a>
        <span class="hint">${Fmt.timeAgo(reply.createdAt)}</span>
        ${tools}
      </div>
      <div class="team-reply-body">${reply.contentHtml ?? ''}</div>
    </div>
  </div>`;
}

/**
 * 回复框。
 *
 * 未登录 / 没加入的人看到的是**说明**而不是输入框：「能看见」（公开帖谁都看得见）与
 * 「能回复」（要是团队成员）是两件事，把输入框摆在那儿再让人吃一个 403 最招人烦。
 */
function replyFormHtml(team, postId) {
  if (!state.me) {
    return `<div class="card team-reply-form team-reply-form-guest">
      <div class="hint">登录之后就能回复这篇帖子。</div>
      <a class="btn btn-sm" href="#/login">去登录</a>
    </div>`;
  }
  if (!team.joined) {
    const status = team.myRequest?.status;
    const hint = status === 'pending'
      ? '你的申请还在等审核，通过之后就能回复了。'
      : status === 'rejected'
        ? '上次的申请被拒绝了，可以再申请一次。'
        : team.joinPolicy === 'apply'
          ? '这个团队需要申请才能加入，加入之后才能回复。'
          : '加入这个团队之后就能回复了。';
    return `<div class="card team-reply-form team-reply-form-guest">
      <div class="hint">${esc(hint)}</div>
    </div>`;
  }
  return `<div class="card team-reply-form">
    <textarea class="input team-reply-input" data-team-field="reply" data-team-reply-field rows="3" maxlength="5000" placeholder="回复这篇帖子…（支持 $E=mc^2$ 这样的公式）">${esc(teamState.draft.reply)}</textarea>
    <div class="team-reply-bar">
      <span class="hint">支持 Markdown 与 LaTeX 公式</span>
      <button class="btn btn-primary" data-team-action="create-reply" data-team-post="${postId}">回复</button>
    </div>
  </div>`;
}

/**
 * 拉一遍回复并画出来。发完 / 删完都走这里 —— 顺序只由服务端说了算。
 *
 * `slug` 默认从地址里现取（发回复、删回复两条路径都在详情页上），详情页则把
 * 手里那个 team.slug 传进来：渲染测试直接调 `viewTeamPost('x', 1, …)` 时地址栏
 * 可能还停在别处，靠 currentSlug() 会请求到上一个团队去。
 */
async function renderReplies(postId, query = null, slug = currentSlug()) {
  const box = $('[data-team-replies]');
  if (!box) return;
  const params = query ?? currentQuery();
  const page = Number(params.get('rpage')) || 1;
  let data;
  try {
    data = await api(`/api/teams/${encodeURIComponent(slug)}/posts/${postId}/replies?page=${page}`);
  } catch (error) {
    if (error?.aborted) return;
    const text = apiErrorText(error);
    if (!text) return;
    box.innerHTML = emptyHtml('😵', esc(text));
    return;
  }
  const items = Array.isArray(data.items) ? data.items : [];
  // 列表容器自己就是一张卡片（外壳里带着 .card），所以空态不再套一层，免得卡里套卡。
  box.innerHTML = items.length
    ? items.map(teamReplyHtml).join('')
    : emptyHtml('💬', '还没有人回复', '底下就是回复框，说点什么吧');
  // 公式渲染必须在 innerHTML 之后：renderMathInElement 只处理已经在 DOM 里的节点。
  ntRenderMath(box);

  const chip = $('[data-team-reply-count]');
  if (chip) chip.textContent = `💬 ${Fmt.fmtNum(Number(data.total) || 0)} 条回复`;

  const pager = $('[data-team-replies-pager]');
  if (pager) {
    pager.innerHTML = paginationHtml(page, Number(data.totalPages) || 1, (target) =>
      routeQuery(`/team/${slug}/post/${postId}`, params, { rpage: target === 1 ? null : String(target) }),
    );
  }
}

/**
 * 团队帖子详情 `#/team/<slug>/post/<id>`。
 *
 * 这里**故意不**画团队主页那一整套（成员名单 / 文件柜 / 群聊）：详情页要的是「读完这段讨论」，
 * 把主页搬过来只会把人埋在中间找不到回复框。回团队的路留了两条（面包屑 + 顶部按钮）。
 */
async function viewTeamPost(handle, postId, query) {
  bindTeamOnce();
  stopChatPolling();
  const key = String(handle ?? '');
  if (teamState.handle !== key) {
    resetTransient();
    teamState.handle = key;
    postCache.clear();
  }

  ui.app.innerHTML = `<div class="team-page">
    <div class="team-crumb"><a href="#/teams">← 所有团队</a></div>
    <div data-team-hero>${loadingHtml()}</div>
    <div data-team-post-detail>${loadingHtml()}</div>
    <div class="card team-replies" data-team-replies></div>
    <div data-team-replies-pager></div>
    <div data-team-reply-form></div>
  </div>`;

  let team;
  try {
    team = (await api(`/api/teams/${encodeURIComponent(key)}`)).team;
  } catch (error) {
    if (error?.aborted) return;
    const text = apiErrorText(error);
    const hero = $('[data-team-hero]');
    if (!text || !hero) return;
    const hint = error?.status === 404 ? '这个团队不存在，或者已经被解散了' : '可能是网络断了，刷新一下再试';
    hero.innerHTML = `<div class="card team-gone">${emptyHtml('🧭', esc(text), hint)}<div class="team-gone-bar"><a class="btn" href="#/teams">← 返回团队广场</a></div></div>`;
    const loading = $('[data-team-post-detail]');
    if (loading) loading.innerHTML = '';
    return;
  }
  if (!team) {
    const hero = $('[data-team-hero]');
    if (hero) hero.innerHTML = `<div class="card team-gone">${emptyHtml('🧭', '团队不存在')}<div class="team-gone-bar"><a class="btn" href="#/teams">← 返回团队广场</a></div></div>`;
    return;
  }
  teamState.team = team;
  const heroBox = $('[data-team-hero]');
  if (!heroBox) return; // 期间用户又点了别处
  heroBox.innerHTML = detailHeroHtml(team);

  const backHref = `#/team/${encodeURIComponent(team.slug)}`;
  let post;
  try {
    post = (await api(`/api/teams/${encodeURIComponent(team.slug)}/posts/${postId}`)).post;
  } catch (error) {
    if (error?.aborted) return;
    const text = apiErrorText(error);
    const box = $('[data-team-post-detail]');
    if (!text || !box) return;
    // 看不见 / 已被删：分开说不清就一起说，并留一条回团队的路 —— 别把人扔在空白页上。
    box.innerHTML = `<div class="card team-gone">${emptyHtml('🧭', esc(text), '它可能已经被删了，也可能本来就不给你看')}<div class="team-gone-bar"><a class="btn" href="${backHref}">← 回「${esc(team.name)}」</a></div></div>`;
    return;
  }
  postCache.set(post.id, post);

  const detailBox = $('[data-team-post-detail]');
  if (!detailBox) return;
  detailBox.innerHTML = teamPostHtml(post, { detail: true });
  ntRenderMath(detailBox);

  const formBox = $('[data-team-reply-form]');
  if (formBox) formBox.innerHTML = replyFormHtml(team, post.id);

  // 列表上那个「💬 回复」按钮是带 `?reply=1` 进来的：画完就把光标送进框里。
  // 放在这里是因为要等 `teamPostHtml` 与回复表单都落进 DOM —— 提前聚焦等于对空气调 focus()。
  if (query?.get('reply') === '1') focusReplyField();

  await renderReplies(post.id, query, team.slug);
}

/**
 * 把光标送进详情页的回复框，并把它滚到眼前。
 *
 * 两处调它：列表上点「💬 回复」跳进详情页（`?reply=1`），
 * 以及已经在详情页时再点一次（不重画页面，只挪光标）。
 * 框不在（未登录、没加入团队时那里只有一句提示）就安静地什么都不做。
 */
function focusReplyField() {
  const box = $('[data-team-reply-field]');
  if (!box) return;
  if (typeof box.focus === 'function') box.focus();
  if (typeof box.scrollIntoView === 'function') box.scrollIntoView({ block: 'center' });
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
    const team = teamState.team ?? {};
    return withButtonBusy(node, async () => {
      const draft = teamState.draft;
      await api(`/api/teams/${encodeURIComponent(slug)}`, {
        method: 'PUT',
        body: {
          // 没改过的字段要把服务端原来的值送回去：只送草稿的话，空串会被当成
          // 「把团队名改成空」直接 400，而用户只是点了一下保存。
          name: draft.name || team.name,
          intro: draft.intro || team.intro,
          joinPolicy: draft.joinPolicy,
          // 「出现在团队广场」只有创建者能改，不是创建者就别带这个字段（带了会 403）。
          ...(team.myRole === 'owner' ? { listed: teamListedValue(team) } : {}),
        },
      });
      teamState.panel = null;
      toast('团队设置已保存', 'success');
      await refreshTeam();
    });
  }
  if (action === 'reply-post') {
    const slug = currentSlug();
    // 已经在详情页：直接把人送到回复框，别把页面重画一遍（读到这里的位置就没了）。
    if ((window.location.hash || '').includes(`/post/${postId}`)) return focusReplyField();
    // 从列表点进详情：用 `?reply=1` 表达「进来就是要回复」。
    // 让路由把详情页画完、viewTeamPost 读到这个参数再聚焦 ——
    // 比在这里 setTimeout 去猜渲染时机可靠（接口还没回来时 setTimout 一定抢跑）。
    navigate(`/team/${encodeURIComponent(slug)}/post/${postId}?reply=1`);
    return;
  }
  if (action === 'join-team' || action === 'submit-apply') {
    const slug = currentSlug();
    const applying = action === 'submit-apply';
    const message = applying ? String(teamState.draft.applyMessage || '').trim() : '';
    return withButtonBusy(node, async () => {
      const data = await api(`/api/teams/${encodeURIComponent(slug)}/join`, {
        method: 'POST',
        body: message ? { message } : {},
      });
      // 服务端说 requested 就是「递了申请」而不是「进去了」——两种情况话不一样。
      if (data?.requested) {
        teamState.draft.applyMessage = '';
        teamState.panel = null;
        toast('申请递上去了，等团长或者管理员批准', 'success');
      } else {
        toast('已加入团队', 'success');
      }
      await refreshTeam();
    });
  }
  if (action === 'apply-team') {
    teamState.panel = 'apply';
    return refreshTeam();
  }
  if (action === 'cancel-apply') {
    teamState.panel = null;
    return refreshTeam();
  }
  if (action === 'withdraw-request') {
    const slug = currentSlug();
    const requestId = Number(teamState.team?.myRequest?.id);
    if (!requestId) return toast('没有正在审核的申请', 'error');
    if (!window.confirm('撤回之后想加入得重新申请一次。确定吗？')) return;
    return withButtonBusy(node, async () => {
      await api(`/api/teams/${encodeURIComponent(slug)}/join-requests/${requestId}`, { method: 'DELETE' });
      toast('申请已经撤回', 'success');
      await refreshTeam();
    });
  }
  if (action === 'toggle-requests') {
    teamState.panel = teamState.panel === 'requests' ? null : 'requests';
    return refreshTeam();
  }
  if (action === 'requests-status') {
    teamState.requestsStatus = String(node.dataset.status || 'pending');
    return renderJoinRequests(teamState.team);
  }
  if (action === 'approve-request' || action === 'reject-request') {
    const slug = currentSlug();
    const requestId = Number(node.dataset.teamRequest);
    return withButtonBusy(node, async () => {
      await api(`/api/teams/${encodeURIComponent(slug)}/join-requests/${requestId}`, {
        method: 'PUT',
        body: { action: action === 'approve-request' ? 'approve' : 'reject' },
      });
      toast(action === 'approve-request' ? '已经批准，他/她现在是成员了' : '已经拒绝', 'success');
      // 整页刷一次：成员数、待审角标、名单都跟着变。
      await refreshTeam();
    });
  }
  if (action === 'drop-request') {
    const slug = currentSlug();
    const requestId = Number(node.dataset.teamRequest);
    if (!window.confirm('这条记录会被删掉（不影响已经批过的成员身份）。确定吗？')) return;
    return withButtonBusy(node, async () => {
      await api(`/api/teams/${encodeURIComponent(slug)}/join-requests/${requestId}`, { method: 'DELETE' });
      toast('记录已经清掉', 'success');
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
  if (action === 'create-reply') {
    const slug = currentSlug();
    const content = String(teamState.draft.reply || '').trim();
    if (!content) {
      toast('先写点什么再回复', 'error');
      return;
    }
    return withButtonBusy(node, async () => {
      await api(`/api/teams/${encodeURIComponent(slug)}/posts/${postId}/replies`, {
        method: 'POST',
        body: { content },
      });
      teamState.draft = { ...teamState.draft, reply: '' };
      const field = $('[data-team-reply-field]');
      if (field) field.value = '';
      toast('回复好了', 'success');
      // 重拉一遍，而不是把新回复拼到列表末尾：顺序和「N 条回复」都由服务端说了算，
      // 前端自己算一份顺序，就多一处可能对不上的地方。
      await renderReplies(postId);
    });
  }
  if (action === 'delete-reply') {
    const slug = currentSlug();
    const replyId = Number(node.dataset.teamReply);
    if (!Number.isInteger(replyId)) return;
    if (!window.confirm('删掉这条回复吗？')) return;
    return withButtonBusy(node, async () => {
      await api(`/api/teams/${encodeURIComponent(slug)}/posts/${postId}/replies/${replyId}`, { method: 'DELETE' });
      toast('回复已删掉了', 'success');
      await renderReplies(postId);
    });
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

  // 抽屉开着时按 ESC 关掉（和点遮罩、点「关闭」走同一条 close-panel）。
  // 两个小让步：正在某个输入框里按 ESC 不关（改团队设置改到一半不该被一键抹掉）；
  // 挂之前先问一句 document.addEventListener 在不在 —— check-frontend 的假 DOM 没有它。
  if (typeof document.addEventListener === 'function') {
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !teamState.panel) return;
      if (event.target?.closest?.('[data-team-field]')) return;
      handleAction('close-panel', event.target).catch((error) => toastError(error));
    });
  }
}

// ── 导出 ──────────────────────────────────────────────────────────────
export { viewTeams };
export { viewTeam };
export { viewTeamPost };

/* @hand-written */
