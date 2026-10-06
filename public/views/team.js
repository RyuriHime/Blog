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
import { $, esc, emptyHtml, loadingHtml, toast, ui } from '../core/dom.js';
import { api, withButtonBusy } from '../core/api.js';
import { state } from '../core/state.js';
import { navigate, routeQuery } from '../core/router.js';
import * as Avatar from '../core/avatar.js';
import * as Fmt from '../core/format.js';
import { paginationHtml } from '../core/widgets.js';

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
  draft: { title: '', content: '', scope: 'team', name: '', intro: '', slug: '', joinPolicy: 'open', username: '' },
  editing: null,
  conflict: null,
  panel: null,
};
/** 列表里每条帖子的原始数据：编辑要用回原文，渲染出来的是 HTML。 */
const postCache = new Map();

const scopeLabel = (value) => teamState.scopes.find((item) => item.value === value)?.label ?? '仅团队';
const scopeOptionsHtml = (selected) =>
  teamState.scopes
    .map((item) => `<option value="${esc(item.value)}" ${item.value === selected ? 'selected' : ''}>${esc(item.label)}</option>`)
    .join('');

function resetTransient() {
  teamState.editing = null;
  teamState.conflict = null;
  teamState.panel = null;
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
  resetTransient();
  const mine = query.get('mine') === '1';
  ui.app.innerHTML = `<div class="team-page">
    <div class="page-head"><h1 class="team-page-title">🎽 团队</h1>
      <p class="hint">一群人一块地方：团队主页上能发帖，帖子能设成「只有本团队看得见」，成员还能一起改同一篇。</p></div>
    <div class="team-tabs">
      <a class="team-tab ${mine ? '' : 'is-active'}" href="#/teams">全部团队</a>
      <a class="team-tab ${mine ? 'is-active' : ''}" href="#/teams?mine=1">我加入的</a>
    </div>
    <div data-team-create></div>
    <div data-team-list>${loadingHtml()}</div>
    <div data-team-pager></div>
  </div>`;

  const createBox = $('[data-team-create]');
  if (createBox) createBox.innerHTML = createFormHtml();

  let data;
  try {
    data = await api(`/api/teams?${mine ? 'mine=1&' : ''}page=${encodeURIComponent(query.get('page') || '1')}`);
  } catch (error) {
    const list = $('[data-team-list]');
    if (list) list.innerHTML = `<div class="card">${emptyHtml('😵', error.message)}</div>`;
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
  if (team.myRole === 'owner' && !owner) {
    tools.push(
      member.teamRole === 'admin'
        ? `<button class="team-mini" data-team-action="demote-member" data-team-user="${member.user.id}">降为成员</button>`
        : `<button class="team-mini" data-team-action="promote-member" data-team-user="${member.user.id}">设为管理员</button>`,
    );
    tools.push(`<button class="team-mini team-mini-danger" data-team-action="kick-member" data-team-user="${member.user.id}">移出</button>`);
  }
  return `<div class="team-member">
    ${Avatar.avatarHtml(member.user, 'avatar-sm')}
    <a class="team-member-name" href="#/u/${encodeURIComponent(member.user.username)}">${esc(member.user.displayName)}</a>
    <span class="team-member-role">${esc(member.teamRoleLabel)}</span>
    ${tools.length ? `<span class="team-member-tools">${tools.join('')}</span>` : ''}
  </div>`;
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
    ${settings}
    ${invite}
  </div>`;
}

function membersHtml(members, memberTotal, team) {
  if (!members.length) return '';
  const more = memberTotal > members.length ? `<span class="hint">等 ${Fmt.fmtNum(memberTotal)} 人</span>` : '';
  return `<div class="card team-members">
    <div class="team-members-title">成员 ${more}</div>
    <div class="team-members-list">${members.map((member) => memberChipHtml(member, team)).join('')}</div>
  </div>`;
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
  return `<div class="card team-composer">
    <input class="input team-composer-title" data-team-field="title" maxlength="120" placeholder="标题" value="${esc(teamState.draft.title)}" />
    <textarea class="input team-composer-body" data-team-field="content" rows="4" placeholder="写点什么给团队看…">${esc(teamState.draft.content)}</textarea>
    <div class="team-composer-bar">
      <select class="input team-scope-select" data-team-field="scope">${scopeOptionsHtml(teamState.draft.scope)}</select>
      <button class="btn btn-primary" data-team-action="create-post">发到团队</button>
    </div>
  </div>`;
}

function conflictHtml(conflict) {
  return `<div class="team-conflict">
    <div class="team-conflict-title">⚠️ 有人在你之前改过了</div>
    <div class="hint">你看的是第 ${esc(String(conflict.mineVersion))} 版，现在已经到第 ${esc(String(conflict.latest.version))} 版。</div>
    <div class="team-conflict-latest">${conflict.latest.contentHtml ?? ''}</div>
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
    ? `<div class="team-post-edit">
        <input class="input team-post-edit-title" data-team-field="title" maxlength="120" value="${esc(teamState.draft.title)}" />
        <textarea class="input team-post-edit-body" data-team-field="content" rows="8">${esc(teamState.draft.content)}</textarea>
        <div class="team-post-edit-bar">
          <select class="input team-scope-select" data-team-field="scope">${scopeOptionsHtml(teamState.draft.scope)}</select>
          <button class="btn btn-primary" data-team-action="save-post" data-team-post="${post.id}">保存</button>
          <button class="btn" data-team-action="cancel-edit">取消</button>
        </div>
        ${conflict ? conflictHtml(conflict) : ''}
      </div>`
    : `<div class="team-post-body">${post.contentHtml ?? ''}</div>`;

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

async function viewTeam(handle, query) {
  bindTeamOnce();
  const key = String(handle ?? '');
  if (teamState.handle !== key) {
    resetTransient();
    teamState.handle = key;
    postCache.clear();
  }

  ui.app.innerHTML = `<div class="team-page">
    <div class="team-crumb"><a href="#/teams">← 所有团队</a></div>
    <div data-team-hero>${loadingHtml()}</div>
    <div data-team-members></div>
    <div data-team-composer></div>
    <div data-team-posts></div>
    <div data-team-pager></div>
  </div>`;

  let data;
  try {
    data = await api(`/api/teams/${encodeURIComponent(key)}`);
  } catch (error) {
    const hero = $('[data-team-hero]');
    if (hero) hero.innerHTML = `<div class="card">${emptyHtml('🧭', error.message, '也许它已经解散了')}</div>`;
    return;
  }
  const team = data.team;
  if (!team) {
    const hero = $('[data-team-hero]');
    if (hero) hero.innerHTML = `<div class="card">${emptyHtml('🧭', '团队不存在')}</div>`;
    return;
  }
  const members = Array.isArray(data.members) ? data.members : [];
  const memberTotal = Number(data.memberTotal) || members.length;

  const heroBox = $('[data-team-hero]');
  if (!heroBox) return; // 期间用户又点了别处
  heroBox.innerHTML = teamHeroHtml(team, memberTotal);
  const memberBox = $('[data-team-members]');
  if (memberBox) memberBox.innerHTML = membersHtml(members, memberTotal, team);
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
    box.innerHTML = `<div class="card">${emptyHtml('😵', error.message)}</div>`;
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
}

/** 局部重画一条帖子（不整页重画，免得把用户在别处写的东西抹掉）。 */
function repaintPost(post) {
  const node = $(`[data-team-post-card="${post.id}"]`);
  if (!node) return;
  node.outerHTML = teamPostHtml(post);
}

/* ── 事件 ──────────────────────────────────────────────────────────── */

/** 当前团队主页的 slug（从 hash 里现取，不靠闭包里的旧值）。 */
function currentSlug() {
  const parts = (window.location.hash || '').replace(/^#/, '').split('?')[0].split('/').filter(Boolean);
  return parts[0] === 'team' && parts[1] ? parts[1] : '';
}

function refreshTeam() {
  const slug = currentSlug();
  if (slug) return viewTeam(slug, new URLSearchParams());
  return viewTeams(new URLSearchParams());
}

async function handleAction(action, node) {
  const postId = Number(node.dataset.teamPost);
  const cached = postCache.get(postId);

  if (action === 'open-create') {
    teamState.panel = 'create';
    return viewTeams(new URLSearchParams(window.location.hash.split('?')[1] || ''));
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
    handleAction(node.dataset.teamAction, node).catch((error) => toast(error.message, 'error'));
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
}

// ── 导出 ──────────────────────────────────────────────────────────────
export { viewTeams };
export { viewTeam };

/* @hand-written */
