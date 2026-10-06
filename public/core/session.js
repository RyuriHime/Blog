// 会话与站点数据：登录态、未读数、签到、币规则、消息未读。
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
  ui.userArea.innerHTML = `
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
      <a class="menu-item" href="#/checkin">📅 每日签到${state.checkin && !state.checkin.checkedInToday ? ' <span class="menu-badge">未签</span>' : ''}</a>
      <a class="menu-item" href="#/ranking">🏆 价值排行榜</a>
      <a class="menu-item" href="#/notifications">🔔 消息通知${state.unread > 0 ? ` <span class="menu-badge">${state.unread}</span>` : ''}</a>
      <a class="menu-item" href="#/following">👥 我的关注</a>
      <a class="menu-item" href="#/bookmarks">⭐ 我的收藏</a>
      <a class="menu-item" href="#/docs">🧩 积木广场</a>
      <a class="menu-item" href="#/settings">⚙️ 账号设置</a>
      <a class="menu-item" href="#/new">✏️ 发布新帖</a>
      ${Fmt.isStaffUser(me) ? '<a class="menu-item" href="#/admin">🛠️ 管理后台</a>' : ''}
      <div class="menu-sep"></div>
      <button class="menu-item" data-action="logout" type="button">🚪 退出登录</button>
    </div>`;
}
function checkinCardHtml() {
  const rules = Fmt.checkinRules();
  const status = state.checkin;
  if (!status) {
    return `<div class="card card-tight">
      <div class="card-head"><span class="card-title">📅 每日签到</span></div>
      <div class="hint">正在读取签到状态…</div>
    </div>`;
  }

  const dots = status.week
    .map(
      (item) =>
        `<span class="checkin-dot ${item.attended ? 'is-on' : ''} ${item.isToday ? 'is-today' : ''} ${item.future ? 'is-future' : ''}" title="${item.day}">${Fmt.weekdayCn(item.day)}</span>`,
    )
    .join('');

  return `
    <div class="card card-tight">
      <div class="card-head">
        <span class="card-title">📅 每日签到</span>
        <a class="tag" href="#/checkin">看日历</a>
      </div>
      <div class="checkin-row">
        ${
          status.checkedInToday
            ? `<span class="checkin-done">✅ 今日已签到</span><span class="hint">连续 ${status.streak} 天</span>`
            : `<button class="btn btn-sm btn-primary" data-action="checkin">签到领 ${rules.dailyReward} 币</button>`
        }
      </div>
      <div class="checkin-dots">${dots}</div>
      <div class="hint">
        本周 ${status.weekAttended}/${status.fullWeekDays} 天${
          status.pendingBonus > 0
            ? ` · 有 ${status.pendingBonus} 币全勤奖待领`
            : ` · 全勤再得 ${rules.weeklyBonus} 币`
        }
      </div>
    </div>`;
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

  const meCard = state.me
    ? `<div class="card card-tight">
         <div class="card-head"><span class="card-title">🪙 我的账户</span></div>
         <div class="coin-balance">
           <span class="coin-value">${Fmt.fmtNum(state.me.coinBalance ?? 0)}</span>
           <span class="hint">可用币 · 签到可以领币，别人投给你的也会到账</span>
         </div>
         <div class="side-links">
           <a class="side-link" href="#/notifications">🔔 消息通知${state.unread > 0 ? ` <span class="menu-badge">${state.unread}</span>` : ''}</a>
           <a class="side-link" href="#/following">👥 我的关注</a>
           <a class="side-link" href="#/bookmarks">⭐ 我的收藏</a>
           <a class="side-link" href="#/ai">🤖 AI 阅读助手</a>
           <a class="side-link" href="#/notes">📓 学术笔记</a>
           <a class="side-link" href="#/settings">⚙️ 账号设置</a>
         </div>
       </div>
       ${checkinCardHtml()}`
    : '';

  ui.sidebar.innerHTML = `
    ${
      state.me
        ? ''
        : `<div class="card card-tight">
             <div class="card-title" style="margin-bottom:8px">🎉 加入讨论</div>
             <div class="hint" style="margin-bottom:10px">注册后可以发帖、评价、投币、关注作者并收到消息通知。</div>
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
      </div>
    </div>
    <div class="card card-tight">
      <div class="card-head"><span class="card-title">🧩 积木</span><a class="tag" href="#/docs">全部</a></div>
      <div class="side-links">
        <a class="side-link" href="#/docs">🧩 积木广场</a>
        <a class="side-link" href="#/blocks">🧱 块类型表</a>
      </div>
    </div>
    ${meCard}
    <div class="card card-tight">
      <div class="card-head"><span class="card-title">📊 站点数据</span></div>
      <div class="stat-grid">
        <div class="stat"><div class="stat-value">${Fmt.fmtNum(state.site.stats.posts)}</div><div class="stat-label">帖子</div></div>
        <div class="stat"><div class="stat-value">${Fmt.fmtNum(state.site.stats.replies)}</div><div class="stat-label">回复</div></div>
        <div class="stat"><div class="stat-value">${Fmt.fmtNum(state.site.stats.users)}</div><div class="stat-label">成员</div></div>
      </div>
    </div>
    <div class="card card-tight">
      <div class="card-head"><span class="card-title">🏆 价值排行榜</span><a class="tag" href="#/ranking">完整榜单</a></div>
      <div class="hot-list">
        ${
          (state.ranking ?? [])
            .slice(0, 5)
            .map(
              (post, index) => `
          <a class="hot-item" href="#/post/${post.id}">
            <span class="hot-rank ${index < 3 ? 'top' : ''}">${index + 1}</span>
            <span>${esc(post.title)}</span>
            <span class="rank-value">${post.valueScore}</span>
          </a>`,
            )
            .join('') || '<div class="hint">榜单加载中…</div>'
        }
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
    </div>`;
}
async function loadSite() {
  try {
    state.site = await api('/api/site');
    const ranking = await api('/api/ranking?limit=5');
    state.ranking = ranking.posts ?? [];
  } catch (error) {
    toastError(error);
  }
}
async function loadCheckin() {
  if (!state.me) return null;
  try {
    return await api('/api/checkin');
  } catch {
    return null;
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
  state.checkin = await loadCheckin();
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
export { loadCheckin };
export { refreshUnread };
export { refreshMessageUnread };
export { renderUserArea };
export { renderSidebar };
export { requireLogin };
export { checkinCardHtml };

/* @hand-written */
