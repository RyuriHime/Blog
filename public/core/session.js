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
  // P5：AI 阅读助手 / 学术笔记 从侧栏「我的账户」搬到顶栏 —— user-area 紧跟在 topnav 里的
  // 「✏️ 发动态」按钮后面，所以放在最前面就是「发动态的旁边」。
  // 原本这里还有第三个「🕸 知识网络图」：知识网络图在 PR #5 里整条删除（路由、视图、样式分片、
  // knowledge-pack 全没了），入口跟着去掉，否则顶栏会挂一个点了没反应的死链。
  const quickLinks = `
    <div class="top-links">
      <a class="top-link" href="#/ai" title="AI 阅读助手">🤖<span class="top-link-text">AI 阅读助手</span></a>
      <a class="top-link" href="#/notes" title="学术笔记">📓<span class="top-link-text">学术笔记</span></a>
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
      <a class="menu-item" href="#/notifications">🔔 消息通知${state.unread > 0 ? ` <span class="menu-badge">${state.unread}</span>` : ''}</a>
      <a class="menu-item" href="#/following">📋 关注列表</a>
      <a class="menu-item" href="#/bookmarks">⭐ 我的收藏</a>
      <a class="menu-item" href="#/docs">🧩 积木广场</a>
      <a class="menu-item" href="#/teams">👥 团队广场</a>
      <a class="menu-item" href="#/wiki">⧉ Wiki 站</a>
      <a class="menu-item" href="#/settings">⚙️ 账号设置</a>
      <a class="menu-item" href="#/new">✏️ 发布新帖</a>
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
  setSidebarOpen(Boolean(state.sidebarOpen));
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
    sidebarHideTimer = setTimeout(() => setSidebarOpen(false), SIDEBAR_HIDE_DELAY);
  });

  // 键盘：Tab 聚焦进抽屉也滑出，焦点离开就收回
  ui.sidebar.addEventListener('focusin', () => {
    cancelHide();
    setSidebarOpen(true);
  });
  ui.sidebar.addEventListener('focusout', (event) => {
    const next = event.relatedTarget;
    if (!next || !inside(next)) setSidebarOpen(false);
  });

  // 点把手：展开 / 收起（键盘与触屏都能用）
  ui.sidebar.addEventListener('click', (event) => {
    if (event.target?.closest?.('#sidebar-handle')) setSidebarOpen(!state.sidebarOpen);
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
  const hot = state.site.hotPosts
    .map(
      (post, index) => `
      <a class="hot-item" href="#/post/${post.id}">
        <span class="hot-rank ${index < 3 ? 'top' : ''}">${index + 1}</span>
        <span>${esc(post.title)}</span>
      </a>`,
    )
    .join('');

  // P5：侧栏「我的账户」卡片整体下线 ——
  //   · AI 阅读助手 / 知识网络图 / 学术笔记 → 搬到顶栏「发动态」旁边
  //   · 消息通知 / 我的关注 / 我的收藏 / 账号设置 → 在这里删除
  //     （功能都还在：顶栏 🔔 铃铛进消息通知，用户菜单里四个入口一个不少）
  //   · P4 补回「📋 关注列表」：它跟「👥 我关注的」是两件事 ——
  //     后者是**过滤后的动态流**（看 TA 们发了什么），前者是**名单**（我关注了谁、一键取关）。
  //     之前 `#/following` 被改道去了动态流，名单页就没人到得了了，现在恢复。
  ui.sidebar.innerHTML = `
    <button
      class="sidebar-handle"
      id="sidebar-handle"
      type="button"
      aria-controls="sidebar-panel"
      aria-expanded="false"
      title="侧栏：鼠标移上来滑出（也可以点我）"
    >
      <span class="sidebar-handle-icon" aria-hidden="true">📚</span>
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
      <div class="card-head"><span class="card-title">🌊 动态</span><a class="tag" href="#/">去发一条</a></div>
      <div class="side-links">
        <a class="side-link" href="#/">🌍 全部动态</a>
        <a class="side-link" href="#/?filter=following">👥 我关注的</a>
        <a class="side-link" href="#/?filter=mine">📝 我的动态</a>
        <a class="side-link" href="#/following">📋 关注列表</a>
      </div>
    </div>
    <div class="card card-tight">
      <div class="card-head"><span class="card-title">🧩 积木</span><a class="tag" href="#/docs">全部</a></div>
      <div class="side-links">
        <a class="side-link" href="#/docs">🧩 积木广场</a>
        <a class="side-link" href="#/blocks">🧱 块类型表</a>
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
      <div class="card-head"><span class="card-title">🔥 热门讨论</span></div>
      <div class="hot-list">${hot || '<div class="hint">还没有内容</div>'}</div>
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
