// 会话与站点数据：登录态、未读数、消息未读。
// 这些数据在多个视图里被读，所以读回来一律写进 core/state.js 的 state 对象。
import { $, esc, toast, ui } from './dom.js';
import { api } from './api.js';
import { toastError } from './errors.js';
import { state } from './state.js';
import * as Avatar from './avatar.js';
import * as Fmt from './format.js';
import * as Prefs from './preferences.js';
import * as Router from './router.js';
import * as Theme from './theme.js';

function requireLogin(message) {
  if (state.me) return true;
  state.redirect = location.hash.replace(/^#/, '') || '/';
  toast(message || '请先登录', 'error');
  Router.navigate('/login');
  return false;
}

/* ------------------------------------------------------------------ */
/* 路由                                                                */
function renderUserArea() {
  if (!state.me) {
    ui.userArea.innerHTML = `
      <a class="btn btn-sm btn-ghost" href="#/login">登录</a>
      <a class="btn btn-sm" href="#/register">注册</a>`;
    return;
  }
  const me = state.me;
  // P5：AI 阅读助手 / 学术笔记 从侧栏「我的账户」搬到顶栏 —— 它们排在 user-area 的最前面，
  // 也就是顶栏右边的第一组。顶栏原来还有个「✏️ 发动态」按钮，P5 一并删了：首页最上面
  // 就是编辑框，用户菜单里也有「✏️ 发布新帖」→ #/new，功能没丢。
  // 原本这里还有第三个「🕸 知识网络图」：知识网络图在 PR #5 里整条删除（路由、视图、样式分片、
  // knowledge-pack 全没了），入口跟着去掉，否则顶栏会挂一个点了没反应的死链。
  // 「📓 学术笔记」也走同一条路：功能并进了**积木的标签**（给积木打「学术笔记」标签），
  // 入口从今天起不再出现。代码还留着（#/notes 与 /notes/ 都还在，直接输地址还能进），
  // 只是界面上不再提它 —— 测试也改成断言「界面上找不到这个入口」。
  const quickLinks = `
    <div class="top-links">
      <a class="top-link" href="#/ai" title="AI 阅读助手">🤖<span class="top-link-text">AI 阅读助手</span></a>
    </div>`;
  ui.userArea.innerHTML = `
    ${quickLinks}
    <a class="bell" href="#/notifications" title="消息通知">
      🔔${state.unread > 0 ? `<span class="bell-badge">${state.unread > 99 ? '99+' : state.unread}</span>` : ''}
    </a>
    <a class="bell" href="#/messages" title="私信">
      ✉️${state.messageUnread > 0 ? `<span class="bell-badge">${state.messageUnread > 99 ? '99+' : state.messageUnread}</span>` : ''}
    </a>
    <button class="user-chip" data-action="toggle-menu" type="button">
      ${Avatar.avatarHtml(me, 'avatar-sm')}
      <span>${esc(me.displayName)}</span>
    </button>
    <div class="menu" id="user-menu" hidden>
      <a class="menu-item" href="#/u/${encodeURIComponent(me.username)}">👤 我的主页</a>
      <a class="menu-item" href="#/messages">✉️ 私信${state.messageUnread > 0 ? ` <span class="menu-badge">${state.messageUnread}</span>` : ''}</a>
      <a class="menu-item" href="#/">🏠 起始页</a>
      <a class="menu-item" href="#/notifications">🔔 消息通知${state.unread > 0 ? ` <span class="menu-badge">${state.unread}</span>` : ''}</a>
      <a class="menu-item" href="#/following">📋 关注列表</a>
      <a class="menu-item" href="#/bookmarks">⭐ 我的收藏</a>
      <a class="menu-item" href="#/docs">🧩 积木广场</a>
      <a class="menu-item" href="#/teams">👥 团队广场</a>
      <a class="menu-item" href="#/wiki">⧉ Wiki 站</a>
      <a class="menu-item" href="#/settings">⚙️ 账号设置</a>
      <!-- 「✏️ 发布新帖」在这里去掉了：帖子功能整体下线，写作入口只剩积木广场
           （上面那条积木广场）。旧地址 #/new 仍然认，会被 router 送到广场。 -->
      ${Fmt.isStaffUser(me) ? '<a class="menu-item" href="#/admin">🛠️ 管理后台</a>' : ''}
      <div class="menu-sep"></div>
      <button class="menu-item" data-action="logout" type="button">🚪 退出登录</button>
    </div>`;
}
/* ------------------------------------------------------------------ */
/* P5：右侧栏抽屉                                                      */
/*   默认收起（右边缘只留一条把手，主内容区吃满整宽）                    */
/*   鼠标移到把手/面板上滑出，移开自动收回                              */
/*   面板左边缘可拖动改宽（200–520），记住设置，双击恢复默认              */
/*   窄屏（≤900px）不做浮层：还原成静态侧栏，把手隐藏（触屏没有 hover）    */
/* ------------------------------------------------------------------ */
const SIDEBAR_MIN_WIDTH = 200;
const SIDEBAR_MAX_WIDTH = 520;
const SIDEBAR_DEFAULT_WIDTH = 306;
// 沿用仓库现有的 forum: 前缀（见 core/preferences.js 的 THEME_STORAGE_KEY）
const SIDEBAR_WIDTH_KEY = 'forum:sidebarWidth';
/** 固定（钉住）：钉住之后鼠标移开也不收回。 */
const SIDEBAR_PIN_KEY = 'forum:sidebarPinned';
/** 鼠标移开后延迟一点再收回：从把手挪到面板的缝隙里时不会抖一下。 */
const SIDEBAR_HIDE_DELAY = 160;

let sidebarDrawerBound = false;
let sidebarHideTimer = 0;

function sidebarWidthFromPrefs() {
  const raw = Number(Prefs.readPreference(SIDEBAR_WIDTH_KEY, ''));
  return Number.isFinite(raw) && raw > 0 ? raw : SIDEBAR_DEFAULT_WIDTH;
}

function clampSidebarWidth(width) {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

function applySidebarWidth(width, { persist = false } = {}) {
  const next = clampSidebarWidth(width);
  state.sidebarWidth = next;
  const style = ui.sidebar?.style;
  if (style) {
    if (typeof style.setProperty === 'function') style.setProperty('--sidebar-width', `${next}px`);
    else style['--sidebar-width'] = `${next}px`;
  }
  if (persist) Prefs.writePreference(SIDEBAR_WIDTH_KEY, String(next));
  return next;
}

function sidebarPinnedFromPrefs() {
  return Prefs.readPreference(SIDEBAR_PIN_KEY, '') === '1';
}

function setSidebarPinned(pinned, { persist = false } = {}) {
  state.sidebarPinned = Boolean(pinned);
  if (typeof ui.sidebar?.classList?.toggle === 'function') ui.sidebar.classList.toggle('is-pinned', state.sidebarPinned);
  const handle = ui.sidebar?.querySelector('.sidebar-handle');
  if (handle) {
    handle.setAttribute('aria-pressed', state.sidebarPinned ? 'true' : 'false');
    handle.title = state.sidebarPinned ? '已钉住：鼠标移开也不会收回（点一下取消）' : '侧栏：鼠标移上来滑出，点一下钉住';
  }
  if (persist) Prefs.writePreference(SIDEBAR_PIN_KEY, state.sidebarPinned ? '1' : '0');
  return state.sidebarPinned;
}

/** 点把手：钉住（并展开）↔ 取消钉住（并收回）。 */
function toggleSidebarPin() {
  const next = !state.sidebarPinned;
  setSidebarPinned(next, { persist: true });
  setSidebarOpen(next);
}

function setSidebarOpen(open) {
  state.sidebarOpen = Boolean(open);
  if (typeof ui.sidebar?.classList?.toggle === 'function') ui.sidebar.classList.toggle('is-open', state.sidebarOpen);
  // 用类选择器取：动态渲染出来的元素的 id 不能用 $('#…') 查 ——
  // scripts/check-ui-contract.mjs 会把这类查询当成「index.html 里的挂载点」来校验。
  const handle = ui.sidebar?.querySelector('.sidebar-handle');
  if (handle) handle.setAttribute('aria-expanded', state.sidebarOpen ? 'true' : 'false');
}

/** 渲染完把状态贴回去（renderSidebar 会被重画，类名与宽度得重新应用）。 */
function syncSidebarDrawer() {
  applySidebarWidth(state.sidebarWidth ?? sidebarWidthFromPrefs());
  if (state.sidebarPinned === undefined) state.sidebarPinned = sidebarPinnedFromPrefs();
  setSidebarPinned(state.sidebarPinned);
  // 钉住 = 常驻展开；没钉住就沿用上次的开合状态
  setSidebarOpen(Boolean(state.sidebarPinned) || Boolean(state.sidebarOpen));
}

function initSidebarDrawer() {
  if (sidebarDrawerBound || !ui.sidebar) return;
  sidebarDrawerBound = true;

  const cancelHide = () => {
    if (sidebarHideTimer) {
      clearTimeout(sidebarHideTimer);
      sidebarHideTimer = 0;
    }
  };
  const inside = (node) => (typeof ui.sidebar.contains === 'function' ? ui.sidebar.contains(node) : false);

  // 悬停滑出 / 移开收回
  ui.sidebar.addEventListener('mouseenter', () => {
    cancelHide();
    setSidebarOpen(true);
  });
  ui.sidebar.addEventListener('mouseleave', () => {
    cancelHide();
    if (state.sidebarPinned) return; // 钉住了就不收回
    sidebarHideTimer = setTimeout(() => setSidebarOpen(false), SIDEBAR_HIDE_DELAY);
  });

  // 键盘：Tab 聚焦进抽屉也滑出，焦点离开就收回
  ui.sidebar.addEventListener('focusin', () => {
    cancelHide();
    setSidebarOpen(true);
  });
  ui.sidebar.addEventListener('focusout', (event) => {
    if (state.sidebarPinned) return; // 钉住了就不收回
    const next = event.relatedTarget;
    if (!next || !inside(next)) setSidebarOpen(false);
  });

  // 点把手：钉住 / 取消钉住（钉住 = 常驻展开，不自动收回；键盘与触屏也能用）
  ui.sidebar.addEventListener('click', (event) => {
    if (event.target?.closest?.('.sidebar-handle')) toggleSidebarPin();
  });

  // 拖面板左边缘改宽度
  let drag = null;
  const onMove = (event) => {
    if (!drag) return;
    // 往左拖 = 变宽
    applySidebarWidth(drag.startWidth + (drag.startX - event.clientX));
  };
  const endDrag = () => {
    if (!drag) return;
    drag = null;
    applySidebarWidth(state.sidebarWidth ?? SIDEBAR_DEFAULT_WIDTH, { persist: true });
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', endDrag);
  };
  ui.sidebar.addEventListener('pointerdown', (event) => {
    if (!event.target?.closest?.('#sidebar-resizer')) return;
    event.preventDefault?.();
    drag = { startX: event.clientX, startWidth: state.sidebarWidth ?? sidebarWidthFromPrefs() };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', endDrag);
  });

  // 双击拖拽带恢复默认宽度
  ui.sidebar.addEventListener('dblclick', (event) => {
    if (!event.target?.closest?.('#sidebar-resizer')) return;
    applySidebarWidth(SIDEBAR_DEFAULT_WIDTH, { persist: true });
  });
}

function renderSidebar() {
  // v2：侧栏的「📚 板块」已经下线（论坛形态不再存在），换成一个动态流的快捷入口。
  // 保留 `renderSidebar()` 这个无参签名，调用方不用改。
  //
  // P5：侧栏只留「导航 + 站点数据 + 小贴士」这三类东西。删掉的三张卡，功能一个没丢：
  //   · 「🪙 我的账户」卡 —— AI 阅读助手 / 学术笔记 搬到顶栏；消息通知 / 我的关注 /
  //     我的收藏 / 账号设置 只留在用户菜单里。（「可用币」当时也搬到了顶栏，但它随后
  //     随那次「删掉币系统」整体下线，所以顶栏只剩前两个入口。）
  //   · 「📅 每日签到」卡 —— 签到已经随「删掉签到与价值排行两套功能」整条下线
  //     （页面、接口、发币规则、样式分片全没了），这张卡是它最后的残留。
  //   · 「🏆 价值排行榜」卡 —— 同上，排行榜也整条下线。
  //   · 「🔥 热门讨论」卡 —— 这件事由顶部的动态流本身承担（首页就是动态流）。
  // 另外，下面那条「📋 关注列表」是 P4 补回来的：它跟「👥 我关注的」是两件事 ——
  //   后者是**过滤后的动态流**（看 TA 们发了什么），前者是**名单**（我关注了谁、一键取关）。
  //   之前 `#/following` 被改道去了动态流，名单页就没人到得了了。
  ui.sidebar.innerHTML = `
    <button
      class="sidebar-handle"
      id="sidebar-handle"
      type="button"
      aria-controls="sidebar-panel"
      aria-expanded="false"
      aria-pressed="false"
      title="侧栏：鼠标移上来滑出，点一下钉住"
    >
      <span class="sidebar-handle-icon" aria-hidden="true">📚</span>
      <span class="sidebar-handle-icon-pin" aria-hidden="true">📌</span>
      <span class="sidebar-handle-text">侧栏</span>
    </button>
    <div class="sidebar-panel" id="sidebar-panel">
    <div class="sidebar-resizer" id="sidebar-resizer" title="拖动改宽度，双击恢复默认"></div>
    ${
      state.me
        ? ''
        : `<div class="card card-tight">
             <div class="card-title" style="margin-bottom:8px">🎉 加入讨论</div>
             <div class="hint" style="margin-bottom:10px">注册后可以发帖、评价、关注作者并收到消息通知。</div>
             <div class="form-actions">
               <a class="btn btn-sm btn-primary" href="#/register">注册</a>
               <a class="btn btn-sm" href="#/login">登录</a>
             </div>
           </div>`
    }
    <div class="card card-tight">
      <div class="card-head"><span class="card-title">🌊 动态</span><a class="tag" href="#/feed">去发一条</a></div>
      <div class="side-links">
        <a class="side-link" href="#/">🏠 起始页</a>
        <a class="side-link" href="#/feed">🌍 全部动态</a>
        <a class="side-link" href="#/feed?filter=following">👥 我关注的</a>
        <a class="side-link" href="#/feed?filter=mine">📝 我的动态</a>
        <a class="side-link" href="#/following">📋 关注列表</a>
      </div>
    </div>
    <div class="card card-tight">
      <div class="card-head"><span class="card-title">🧩 积木</span><a class="tag" href="#/docs">全部</a></div>
      <div class="side-links">
        <a class="side-link" href="#/docs">🧩 积木广场</a>
        <a class="side-link" href="#/guide">📖 积木教程</a>
        <a class="side-link" href="#/dev">🛠 开发者功能</a>
      </div>
    </div>
    <div class="card card-tight">
      <div class="card-head"><span class="card-title">👥 团队</span><a class="tag" href="#/teams">全部</a></div>
      <div class="side-links">
        <a class="side-link" href="#/teams">👥 团队广场</a>
        <a class="side-link" href="#/teams?mine=1">🙋 我加入的</a>
      </div>
    </div>
    <div class="card card-tight">
      <div class="card-head"><span class="card-title">📊 站点数据</span></div>
      <div class="stat-grid">
        <div class="stat"><div class="stat-value">${Fmt.fmtNum(state.site.stats.posts)}</div><div class="stat-label">帖子</div></div>
        <div class="stat"><div class="stat-value">${Fmt.fmtNum(state.site.stats.replies)}</div><div class="stat-label">回复</div></div>
        <div class="stat"><div class="stat-value">${Fmt.fmtNum(state.site.stats.users)}</div><div class="stat-label">成员</div></div>
      </div>
    </div>
    <div class="card card-tight">
      <div class="card-head"><span class="card-title">💡 小贴士</span></div>
      <div class="hint" style="line-height:1.8">
        · 标题写清楚问题，别写「救命」<br />
        · 代码用三个反引号包裹<br />
        · @某人 可以提醒 TA 来看
      </div>
    </div>
    </div>`;
  syncSidebarDrawer();
  initSidebarDrawer();
}
async function loadSite() {
  try {
    state.site = await api('/api/site');
    // P5：侧栏不再预取榜单 —— 排行榜已随「删掉签到与价值排行两套功能」整条下线，
    // 首屏少打一次 /api/ranking 的请求。
  } catch (error) {
    toastError(error);
  }
}
async function loadSession() {
  try {
    const data = await api('/api/auth/me');
    state.me = data.user;
    state.unread = data.unread ?? 0;
  } catch {
    state.me = null;
    state.unread = 0;
  }
  state.messageUnread = 0;
  renderUserArea();
  void refreshMessageUnread();
}
async function refreshMessageUnread() {
  if (!state.me) return;
  try {
    const { unread } = await api('/api/messages/summary');
    if (unread !== state.messageUnread) {
      state.messageUnread = unread;
      renderUserArea();
      renderSidebar();
    }
  } catch {
    /* 静默失败，不打扰用户 */
  }
}
async function refreshUnread() {
  if (!state.me) return;
  try {
    const { unread } = await api('/api/notifications/summary');
    if (unread !== state.unread) {
      state.unread = unread;
      renderUserArea();
      renderSidebar();
    }
  } catch {
    /* 静默失败，不打扰用户 */
  }
  await refreshMessageUnread();
}

/* ------------------------------------------------------------------ */
/* 帖子列表组件                                                        */
async function bootstrap() {
  // 首屏再套用一次本地主题（index.html 里的内联脚本已经先设过，避免闪烁），
  // 并监听系统配色变化，让「跟随系统」实时生效。
  Theme.applyTheme(Prefs.readPreference(Prefs.THEME_STORAGE_KEY, 'dark'), { silent: true, persist: false });
  if (typeof window.matchMedia === 'function') {
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const onSystemThemeChange = () => {
      if (state.theme === 'auto') Theme.applyTheme('auto', { silent: true, persist: false });
    };
    if (typeof media.addEventListener === 'function') media.addEventListener('change', onSystemThemeChange);
    else if (typeof media.addListener === 'function') media.addListener(onSystemThemeChange);
  }

  renderUserArea();
  await loadSite();
  await loadSession();
  renderSidebar();
  window.addEventListener('hashchange', Router.route);
  await Router.route();
  setInterval(refreshUnread, 60000);
}

// ── 导出 ──────────────────────────────────────────────────────────────
export { bootstrap };
export { loadSite };
export { loadSession };
export { refreshUnread };
export { refreshMessageUnread };
export { renderUserArea };
export { renderSidebar };
export { requireLogin };

/* @hand-written */
