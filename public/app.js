/* 围炉论坛 · 前端逻辑（原生 ES Module，无框架、无构建） */

const $ = (selector, root = document) => root.querySelector(selector);

const ui = {
  app: $('#app'),
  sidebar: $('#sidebar'),
  userArea: $('#user-area'),
  searchForm: $('#search-form'),
  searchInput: $('#search-input'),
  toasts: $('#toasts'),
};

const state = {
  me: null,
  unread: 0,
  messageUnread: 0,
  checkin: null,
  ranking: [],
  theme: 'dark',
  site: {
    boards: [],
    stats: { users: 0, posts: 0, replies: 0 },
    hotPosts: [],
    coinRules: { signupGrant: 10, perPostLimit: 2 },
    checkinRules: { dailyReward: 1, weeklyBonus: 3, fullWeekDays: 7 },
    profileRules: { pinLimit: 3, categoryLimit: 8 },
    messageRules: { oneWayDailyLimit: 1, maxLength: 1000 },
  },
  redirect: '/',
};

const PROFILE_LAYOUTS = [
  ['list', '☰ 列表'],
  ['cards', '▦ 卡片'],
  ['compact', '≡ 紧凑'],
];

/* ------------------------------------------------------------------ */
/* 本地偏好                                                            */
/* ------------------------------------------------------------------ */

function readPreference(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writePreference(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 隐私模式下忽略 */
  }
}

const profileLayout = () => readPreference('forum:profileLayout', 'list');

/* ------------------------------------------------------------------ */
/* 背景主题                                                            */
/* ------------------------------------------------------------------ */

// 这个 key 必须和 index.html 首屏脚本里的字面量一致
const THEME_STORAGE_KEY = 'forum:theme';

const THEMES = [
  { key: 'auto', label: '跟随系统', hint: '随系统深浅色切换', auto: true },
  { key: 'dark', label: '暗夜', hint: '默认深蓝夜色', swatch: { bg: '#0b0f16', panel: '#141b29', accent: '#5b8cff' } },
  { key: 'midnight', label: '极夜', hint: '纯黑 OLED，最省电', swatch: { bg: '#000000', panel: '#0b0e13', accent: '#5b8cff' } },
  { key: 'light', label: '明亮', hint: '浅色日间主题', swatch: { bg: '#f5f7fb', panel: '#ffffff', accent: '#2f66f0' } },
  { key: 'amber', label: '暖阳', hint: '琥珀黄深色', swatch: { bg: '#16110a', panel: '#221a0f', accent: '#f0b429' } },
  { key: 'sand', label: '奶黄', hint: '米黄纸感浅色', swatch: { bg: '#fdf6e3', panel: '#fffdf7', accent: '#c98a00' } },
  { key: 'forest', label: '森林', hint: '墨绿护眼', swatch: { bg: '#07130d', panel: '#0e1c15', accent: '#35c07f' } },
  { key: 'violet', label: '暮紫', hint: '紫罗兰夜色', swatch: { bg: '#0d0a18', panel: '#171228', accent: '#a06bff' } },
];

const systemPrefersLight = () =>
  typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: light)').matches;

/** auto → 按系统解析；其余直接用主题名（对应 html[data-theme="..."]） */
const resolveTheme = (key) => (key === 'auto' ? (systemPrefersLight() ? 'light' : 'dark') : key);
const themeMeta = (key) => THEMES.find((item) => item.key === key) ?? THEMES[1];

function themeSwatchHtml(theme) {
  if (theme.auto) return '<span class="theme-swatch is-auto"></span>';
  const { bg, panel, accent } = theme.swatch;
  return `<span class="theme-swatch" style="--swatch-bg:${bg};--swatch-panel:${panel};--swatch-accent:${accent}"></span>`;
}

function themeOptionsHtml() {
  return THEMES.map(
    (theme) => `
    <button class="theme-option ${state.theme === theme.key ? 'is-active' : ''}" type="button"
            data-action="set-theme" data-theme="${theme.key}">
      ${themeSwatchHtml(theme)}
      <span class="theme-name">${theme.label}<span class="theme-hint">${theme.hint}</span></span>
      ${state.theme === theme.key ? '<span class="menu-check">✓</span>' : ''}
    </button>`,
  ).join('');
}

function renderThemeArea() {
  const area = $('#theme-area');
  if (!area) return;
  area.innerHTML = `
    <button class="btn btn-sm btn-ghost theme-btn" type="button" data-action="toggle-theme-menu"
            title="切换背景主题（当前：${themeMeta(state.theme).label}）" aria-label="切换背景主题">🎨</button>
    <div class="menu theme-menu" id="theme-menu" hidden>
      ${THEMES.map(
        (theme) => `
        <button class="menu-item theme-item" type="button" data-action="set-theme" data-theme="${theme.key}">
          ${themeSwatchHtml(theme)}
          <span>${theme.label}</span>
          ${state.theme === theme.key ? '<span class="menu-check">✓</span>' : ''}
        </button>`,
      ).join('')}
    </div>`;
}

function applyTheme(key, { silent = false, persist = true } = {}) {
  const chosen = THEMES.some((item) => item.key === key) ? key : 'dark';
  const resolved = resolveTheme(chosen);
  document.documentElement.dataset.theme = resolved;
  state.theme = chosen;
  if (persist) writePreference(THEME_STORAGE_KEY, chosen);

  renderThemeArea();
  const grid = document.querySelector('[data-theme-grid]');
  if (grid) grid.innerHTML = themeOptionsHtml();

  if (!silent) {
    toast(
      chosen === 'auto'
        ? `已切换：跟随系统（当前是${resolved === 'light' ? '明亮' : '暗夜'}）`
        : `已切换到「${themeMeta(chosen).label}」主题`,
      'success',
    );
  }
}

/* ------------------------------------------------------------------ */
/* 通用工具                                                            */
/* ------------------------------------------------------------------ */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPES[char]);

function timeAgo(timestamp) {
  const diff = Date.now() - Number(timestamp || 0);
  if (diff < 45 * 1000) return '刚刚';
  if (diff < 3600 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 24 * 3600 * 1000) return `${Math.floor(diff / 3600000)} 小时前`;
  if (diff < 30 * 24 * 3600 * 1000) return `${Math.floor(diff / 86400000)} 天前`;
  const date = new Date(Number(timestamp));
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function fullTime(timestamp) {
  return new Date(Number(timestamp)).toLocaleString('zh-CN', { hour12: false });
}

function fmtNum(value) {
  const num = Number(value || 0);
  if (num < 1000) return String(num);
  if (num < 10000) return `${(num / 1000).toFixed(1)}k`;
  return `${(num / 10000).toFixed(1)}w`;
}

function hueOf(text) {
  let hash = 0;
  for (const char of String(text || '?')) hash = (hash * 31 + char.codePointAt(0)) % 360;
  return hash;
}

const AVATAR_EMOJIS = [
  ['🦊', 24],
  ['🐳', 198],
  ['🌻', 45],
  ['🧭', 212],
  ['🚀', 265],
  ['🐼', 160],
  ['🦉', 275],
  ['🍀', 130],
  ['⚡', 48],
  ['🎧', 300],
  ['🌙', 230],
  ['🔥', 12],
];

/** 头像字段的两种取值：`emoji:字符:色相` / `file:/avatars/xxx.png`；空串表示用昵称首字母 */
function avatarParts(person) {
  const raw = String((typeof person === 'object' && person ? person.avatar : '') ?? '').trim();
  if (raw.startsWith('emoji:')) {
    const [, emoji, hue] = raw.split(':');
    if (emoji) return { kind: 'emoji', emoji, hue: Number(hue) || 210 };
  }
  if (raw.startsWith('file:')) {
    const url = raw.slice(5);
    if (/^\/avatars\/[A-Za-z0-9._-]+$/.test(url)) return { kind: 'file', url };
  }
  return null;
}

/** 支持传「用户对象」或「昵称字符串」：优先用用户设置的头像，否则用昵称首字母色块 */
function avatarHtml(person, size = '') {
  const name =
    typeof person === 'string' ? person : person?.displayName ?? person?.username ?? person?.name ?? '?';
  const custom = avatarParts(person);

  if (custom?.kind === 'file') {
    return `<span class="avatar avatar-img ${size}" aria-hidden="true"><img src="${esc(custom.url)}" alt="" loading="lazy" /></span>`;
  }
  if (custom?.kind === 'emoji') {
    return `<span class="avatar avatar-emoji ${size}" style="--hue:${custom.hue}" aria-hidden="true">${esc(custom.emoji)}</span>`;
  }

  const label = String(name || '?').trim().slice(0, 1).toUpperCase();
  return `<span class="avatar ${size}" style="--hue:${hueOf(name)}" aria-hidden="true">${esc(label)}</span>`;
}

/** 站长 / 管理员 / 成员；staff（管理团队）可以隐藏或删除违规文章 */
const isStaffRole = (role) => role === 'owner' || role === 'admin';
const isStaffUser = (user) => Boolean(user && isStaffRole(user.role));
const roleLabel = (role) => (role === 'owner' ? '站长' : role === 'admin' ? '管理员' : '成员');

const roleTag = (role) => {
  if (role === 'owner') return '<span class="tag tag-owner">👑 站长</span>';
  if (role === 'admin') return '<span class="tag tag-admin">🛡️ 管理员</span>';
  return '';
};

const coinRules = () => state.site.coinRules ?? { signupGrant: 10, perPostLimit: 2 };
const checkinRules = () => state.site.checkinRules ?? { dailyReward: 1, weeklyBonus: 3, fullWeekDays: 7 };
const profileRules = () => state.site.profileRules ?? { pinLimit: 3, categoryLimit: 8 };

/** YYYY-MM-DD → 周一…周日 */
function weekdayCn(day) {
  const date = new Date(`${day}T00:00:00`);
  if (Number.isNaN(date.getTime())) return '·';
  return ['一', '二', '三', '四', '五', '六', '日'][(date.getDay() + 6) % 7];
}

function monthDayCn(day) {
  const parts = String(day).split('-');
  return parts.length === 3 ? `${Number(parts[1])}/${Number(parts[2])}` : day;
}

function toast(message, type = 'info') {
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.textContent = message;
  ui.toasts.append(node);
  setTimeout(() => node.remove(), 3200);
}

async function api(path, options = {}) {
  const { method = 'GET', body } = options;
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    throw new Error('网络请求失败，请检查服务是否在运行');
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    /* 忽略解析失败 */
  }
  if (!response.ok || !payload?.ok) {
    const error = new Error(payload?.error?.message || `请求失败（HTTP ${response.status}）`);
    error.code = payload?.error?.code;
    error.status = response.status;
    if (response.status === 401) {
      state.me = null;
      state.unread = 0;
      renderUserArea();
    }
    throw error;
  }
  return payload.data;
}

function loadingHtml() {
  return `<div class="card"><div class="skeleton">
    <div class="sk-line" style="width:38%"></div>
    <div class="sk-line" style="width:88%"></div>
    <div class="sk-line" style="width:74%"></div>
    <div class="sk-line" style="width:56%"></div>
  </div></div>`;
}

const emptyHtml = (emoji, title, hint = '') =>
  `<div class="empty"><span class="emoji">${emoji}</span><div>${esc(title)}</div>${
    hint ? `<div class="hint">${esc(hint)}</div>` : ''
  }</div>`;

/** 未登录时先去登录页，登录后回到原处。 */
function requireLogin(message) {
  if (state.me) return true;
  state.redirect = location.hash.replace(/^#/, '') || '/';
  toast(message || '请先登录', 'error');
  navigate('/login');
  return false;
}

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

function parseHash() {
  const raw = location.hash.replace(/^#/, '');
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  const [path, queryString = ''] = (decoded || '/').split('?');
  return { path: path || '/', query: new URLSearchParams(queryString) };
}

function navigate(path) {
  if (location.hash === `#${path}`) return route();
  location.hash = path;
}

function routeQuery(base, query, overrides = {}) {
  const params = new URLSearchParams(query);
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null || value === undefined || value === '') params.delete(key);
    else params.set(key, value);
  }
  const qs = params.toString();
  return `#${base}${qs ? `?${qs}` : ''}`;
}

/* ------------------------------------------------------------------ */
/* 头部 / 侧栏                                                         */
/* ------------------------------------------------------------------ */

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
      ${avatarHtml(me, 'avatar-sm')}
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
      <a class="menu-item" href="#/settings">⚙️ 账号设置</a>
      <a class="menu-item" href="#/new">✏️ 发布新帖</a>
      ${isStaffUser(me) ? '<a class="menu-item" href="#/admin">🛠️ 管理后台</a>' : ''}
      <div class="menu-sep"></div>
      <button class="menu-item" data-action="logout" type="button">🚪 退出登录</button>
    </div>`;
}

function checkinCardHtml() {
  const rules = checkinRules();
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
        `<span class="checkin-dot ${item.attended ? 'is-on' : ''} ${item.isToday ? 'is-today' : ''} ${item.future ? 'is-future' : ''}" title="${item.day}">${weekdayCn(item.day)}</span>`,
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

function renderSidebar(activeBoardSlug = null) {
  const boards = state.site.boards
    .map(
      (board) => `
      <a class="board-link ${board.slug === activeBoardSlug ? 'is-active' : ''}" href="#/board/${esc(board.slug)}">
        <span>${board.icon}</span>
        <span>${esc(board.name)}</span>
        <span class="count">${board.postCount}</span>
      </a>`,
    )
    .join('');

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
           <span class="coin-value">${fmtNum(state.me.coinBalance ?? 0)}</span>
           <span class="hint">可用币 · 签到可以领币，别人投给你的也会到账</span>
         </div>
         <div class="side-links">
           <a class="side-link" href="#/notifications">🔔 消息通知${state.unread > 0 ? ` <span class="menu-badge">${state.unread}</span>` : ''}</a>
           <a class="side-link" href="#/following">👥 我的关注</a>
           <a class="side-link" href="#/bookmarks">⭐ 我的收藏</a>
           <a class="side-link" href="#/ai">🤖 AI 阅读助手</a>
           <a class="side-link" href="#/graph">🕸 知识网络图</a>
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
      <div class="card-head"><span class="card-title">📚 板块</span><a class="tag" href="#/">全部</a></div>
      <div class="board-nav">${boards || '<div class="hint">暂无板块</div>'}</div>
    </div>
    ${meCard}
    <div class="card card-tight">
      <div class="card-head"><span class="card-title">📊 站点数据</span></div>
      <div class="stat-grid">
        <div class="stat"><div class="stat-value">${fmtNum(state.site.stats.posts)}</div><div class="stat-label">帖子</div></div>
        <div class="stat"><div class="stat-value">${fmtNum(state.site.stats.replies)}</div><div class="stat-label">回复</div></div>
        <div class="stat"><div class="stat-value">${fmtNum(state.site.stats.users)}</div><div class="stat-label">成员</div></div>
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
    toast(error.message, 'error');
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
/* ------------------------------------------------------------------ */

function postBadgesHtml(post) {
  return `
    ${post.hidden ? '<span class="tag tag-hidden">🙈 已隐藏</span>' : ''}
    ${post.repost ? '<span class="tag tag-repost">🔁 转发</span>' : ''}
    ${post.profilePinned ? '<span class="tag tag-pin">📌 置顶推荐</span>' : ''}
    ${post.pinned ? '<span class="tag tag-pin">📌 全局置顶</span>' : ''}
    <a class="tag" href="#/board/${esc(post.board.slug)}">${post.board.icon} ${esc(post.board.name)}</a>
    ${post.category ? `<span class="tag tag-category">🗂 ${esc(post.category.name)}</span>` : ''}
    ${post.locked ? '<span class="tag">🔒 已锁定</span>' : ''}
    ${post.authorFollowed ? '<span class="tag tag-follow">✓ 已关注</span>' : ''}
    ${roleTag(post.author.role)}`;
}

function postMetaStatsHtml(post) {
  return `
    <a class="meta-strong" href="#/u/${encodeURIComponent(post.author.username)}">${esc(post.author.displayName)}</a>
    <span>·</span>
    <span title="${fullTime(post.createdAt)}">${timeAgo(post.lastActiveAt ?? post.createdAt)}</span>
    <span class="spacer"></span>
    <span class="meta-item" title="点赞">👍 ${fmtNum(post.likeCount)}</span>
    <span class="meta-item ${post.disliked ? 'is-dim' : ''}" title="踩">👎 ${fmtNum(post.dislikeCount)}</span>
    <span class="meta-item" title="投币">🪙 ${fmtNum(post.coinCount)}</span>
    <span class="meta-item" title="浏览">👁 ${fmtNum(post.views)}</span>
    <span class="meta-item" title="回复">💬 ${post.replyCount}</span>
    ${post.bookmarked ? '<span class="meta-item" title="已收藏">⭐</span>' : ''}`;
}

/** 作者整理自己主页的小工具：选分类 + 置顶推荐。 */
function ownerToolsHtml(post, categories) {
  const options = ['<option value="">未分类</option>']
    .concat(
      categories.map(
        (category) =>
          `<option value="${category.id}" ${post.category?.id === category.id ? 'selected' : ''}>${esc(category.name)}</option>`,
      ),
    )
    .join('');
  return `
    <div class="owner-tools">
      <select class="mini-select" data-action="set-category" data-id="${post.id}" title="归入我的分类">${options}</select>
      <button class="btn btn-sm ${post.profilePinned ? 'is-on' : ''}" data-action="profile-pin"
              data-id="${post.id}" data-pinned="${post.profilePinned ? '1' : '0'}"
              title="在个人主页顶部推荐这篇">📌 ${post.profilePinned ? '取消置顶' : '置顶'}</button>
    </div>`;
}

function postListHtml(items, toolsFor = null) {
  if (!items.length) {
    return `<div class="post-list">${emptyHtml('🍃', '这里还很安静', '成为第一个发帖的人吧')}</div>`;
  }
  const rows = items
    .map(
      (post) => `
    <article class="post-row ${post.pinned || post.profilePinned ? 'is-pinned' : ''}">
      ${avatarHtml(post.author)}
      <div class="post-main">
        <div class="post-tags">${postBadgesHtml(post)}</div>
        <h3 class="post-title"><a href="#/post/${post.id}">${esc(post.title)}</a></h3>
        ${post.repost?.comment ? `<p class="repost-quote">🔁 ${esc(post.repost.comment)}</p>` : ''}
        <p class="post-excerpt">${esc(post.excerpt)}</p>
        <div class="post-meta">${postMetaStatsHtml(post)}</div>
        ${toolsFor ? `<div class="post-owner-row">${toolsFor(post)}</div>` : ''}
      </div>
    </article>`,
    )
    .join('');
  return `<div class="post-list">${rows}</div>`;
}

function postCardsHtml(items, toolsFor = null) {
  if (!items.length) return `<div class="card">${emptyHtml('🍃', '这个分类下还没有文章')}</div>`;
  return `<div class="post-cards">${items
    .map(
      (post) => `
    <article class="post-card ${post.profilePinned ? 'is-pinned' : ''}">
      <div class="post-tags">${postBadgesHtml(post)}</div>
      <h3 class="post-title"><a href="#/post/${post.id}">${esc(post.title)}</a></h3>
      ${post.repost?.comment ? `<p class="repost-quote">🔁 ${esc(post.repost.comment)}</p>` : ''}
      <p class="post-excerpt">${esc(post.excerpt)}</p>
      <div class="post-meta">${postMetaStatsHtml(post)}</div>
      ${toolsFor ? `<div class="post-owner-row">${toolsFor(post)}</div>` : ''}
    </article>`,
    )
    .join('')}</div>`;
}

function postCompactHtml(items, toolsFor = null) {
  if (!items.length) return `<div class="card">${emptyHtml('🍃', '这个分类下还没有文章')}</div>`;
  return `<div class="post-compact">${items
    .map(
      (post) => `
    <div class="compact-row ${post.profilePinned ? 'is-pinned' : ''}">
      <a class="compact-title" href="#/post/${post.id}">${post.profilePinned ? '📌 ' : ''}${esc(post.title)}</a>
      ${post.category ? `<span class="tag tag-category">${esc(post.category.name)}</span>` : ''}
      <span class="compact-meta">${timeAgo(post.createdAt)} · 👍 ${post.likeCount} · 👎 ${post.dislikeCount} · 🪙 ${post.coinCount} · 💬 ${post.replyCount}</span>
      ${toolsFor ? `<div class="post-owner-row">${toolsFor(post)}</div>` : ''}
    </div>`,
    )
    .join('')}</div>`;
}

function profilePostsHtml(posts, { layout, toolsFor = null }) {
  if (layout === 'cards') return postCardsHtml(posts, toolsFor);
  if (layout === 'compact') return postCompactHtml(posts, toolsFor);
  return postListHtml(posts, toolsFor);
}

function pageNumbers(page, total) {
  const candidates = new Set([1, total, page, page - 1, page + 1, page - 2, page + 2]);
  const pages = [...candidates].filter((value) => value >= 1 && value <= total).sort((a, b) => a - b);
  const output = [];
  let previous = 0;
  for (const value of pages) {
    if (previous && value - previous > 1) output.push('…');
    output.push(value);
    previous = value;
  }
  return output;
}

function paginationHtml(page, totalPages, hrefFor) {
  if (totalPages <= 1) return '';
  const links = pageNumbers(page, totalPages)
    .map((value) =>
      value === '…'
        ? '<span class="page-link is-disabled">…</span>'
        : `<a class="page-link ${value === page ? 'is-active' : ''}" href="${hrefFor(value)}">${value}</a>`,
    )
    .join('');
  return `<nav class="pagination">
    <a class="page-link ${page <= 1 ? 'is-disabled' : ''}" href="${hrefFor(Math.max(1, page - 1))}">‹ 上一页</a>
    ${links}
    <a class="page-link ${page >= totalPages ? 'is-disabled' : ''}" href="${hrefFor(Math.min(totalPages, page + 1))}">下一页 ›</a>
  </nav>`;
}

function sortTabsHtml(sort, basePath, query) {
  const tabs = [
    ['latest', '🕒 最新发布'],
    ['active', '💬 最新回复'],
    ['hot', '🔥 最热'],
  ];
  const queryString = query.toString();
  return `<div class="tabs">${tabs
    .map(([key, label]) => {
      const params = new URLSearchParams(queryString);
      params.set('sort', key);
      params.delete('page');
      return `<a class="tab ${sort === key ? 'is-active' : ''}" href="#${basePath}?${params.toString()}">${label}</a>`;
    })
    .join('')}</div>`;
}

function feedTabsHtml(feed, basePath, query) {
  if (!state.me) return '';
  const tabs = [
    ['all', '🌐 全部讨论'],
    ['following', '👥 我关注的'],
  ];
  return `<div class="tabs tabs-sm">${tabs
    .map(([key, label]) => {
      const params = new URLSearchParams(query.toString());
      if (key === 'following') params.set('feed', 'following');
      else params.delete('feed');
      params.delete('page');
      const qs = params.toString();
      return `<a class="tab ${feed === key ? 'is-active' : ''}" href="#${basePath}${qs ? `?${qs}` : ''}">${label}</a>`;
    })
    .join('')}</div>`;
}

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
        ${feedTabsHtml(feed, basePath, query)}
        ${sortTabsHtml(sort, basePath, query)}
      </div>
    </div>
    ${postListHtml(data.items)}
    ${paginationHtml(data.page, data.totalPages, hrefFor)}`;
}

/* ------------------------------------------------------------------ */
/* 视图：首页 / 板块 / 搜索 / 收藏 / 关注流 / 用户主页                    */
/* ------------------------------------------------------------------ */

async function viewHome(query) {
  ui.app.innerHTML = loadingHtml();
  const hero = `
    <section class="hero">
      <h1>围炉而坐，聊聊技术 👋</h1>
      <p>分区讨论、Markdown 发帖、评价投币、关注作者，消息通知一个都不少。</p>
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
  renderSidebar(slug);
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

function personChipHtml(person, { unfollow = false, follow = false } = {}) {
  return `
    <div class="person-chip">
      ${avatarHtml(person, 'avatar-sm')}
      <div class="person-info">
        <a class="person-name" href="#/u/${encodeURIComponent(person.username)}">${esc(person.displayName)}</a>
        ${roleTag(person.role)}
        <div class="hint">@${esc(person.username)}${person.bio ? ` · ${esc(person.bio.slice(0, 24))}` : ''}</div>
      </div>
      ${
        unfollow
          ? `<button class="btn btn-sm" data-action="follow" data-user="${person.id}" data-name="${esc(person.displayName)}">已关注</button>`
          : follow
            ? `<button class="btn btn-sm ${person.viewerFollows ? 'is-on' : ''}" data-action="follow" data-user="${person.id}" data-name="${esc(person.displayName)}">${person.viewerFollows ? '✓ 已关注' : '＋ 关注'}</button>`
            : `<span class="hint">${person.postCount ?? 0} 帖</span>`
      }
    </div>`;
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
        <h1 style="font-size:20px">👥 我的关注</h1>
        <span class="tag">关注 ${data.counts.followingCount} · 粉丝 ${data.counts.followerCount}</span>
      </div>
      <div class="page-sub">关注作者后，首页「我关注的」只看 TA 们的帖子，TA 发新帖也会通知你。</div>
      <div class="coin-balance" style="margin-top:12px">
        <span class="coin-value">🪙 ${fmtNum(data.coinBalance)}</span>
        <span class="hint">可用币（注册送 ${coinRules().signupGrant} 币；之后靠每日签到与别人投给你的币增加）</span>
      </div>
      <div class="form-actions" style="margin-top:12px">
        <a class="btn btn-sm" href="#/?feed=following">去看 TA 们的帖子 →</a>
      </div>
    </section>
    <section class="card" style="padding:0">
      <div class="card-head" style="padding:16px 18px;margin:0;border-bottom:1px solid var(--border-soft)">
        <span class="card-title">关注列表（${data.items.length}）</span>
      </div>
      <div class="chip-list">
        ${data.items.length ? data.items.map((person) => personChipHtml(person, { unfollow: true })).join('') : emptyHtml('👀', '还没有关注任何人', '去帖子里点「关注」试试')}
      </div>
    </section>`;
}

async function viewUser(username, query) {
  ui.app.innerHTML = loadingHtml();
  const filter = query.get('category') || 'all';
  const suffix = filter === 'all' ? '' : `?category=${encodeURIComponent(filter)}`;
  const data = await api(`/api/users/${encodeURIComponent(username)}${suffix}`);
  const { user, followers, following, posts, categories, uncategorizedCount, pinnedCount } = data;
  const value = data.value ?? { totalValue: 0, avgValue: 0, bestValue: 0, rank: null };
  const layout = profileLayout();
  const isOwner = Boolean(user.isMe);
  const basePath = `/u/${encodeURIComponent(user.username)}`;
  const toolsFor = isOwner ? (post) => ownerToolsHtml(post, categories) : null;
  const categoryLimit = data.categoryLimit ?? profileRules().categoryLimit;

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
        `<div class="stat"><div class="stat-value">${fmtNum(value)}</div><div class="stat-label">${label}</div></div>`,
    )
    .join('');

  const chip = (key, label, count) => {
    const active = filter === key ? 'is-active' : '';
    const inner = `<a class="chip-label" href="#${basePath}${key === 'all' ? '' : `?category=${encodeURIComponent(key)}`}">${label} <span class="chip-count">${count}</span></a>`;
    const tools = isOwner && key !== 'all' && key !== 'none' ? `
      <button class="chip-x" data-action="rename-category" data-id="${key}" data-name="${esc(label)}" title="重命名">✎</button>
      <button class="chip-x" data-action="delete-category" data-id="${key}" data-name="${esc(label)}" title="删除分类（文章会回到未分类）">✕</button>` : '';
    return `<span class="chip ${active}">${inner}${tools}</span>`;
  };

  const chips = [
    chip('all', '📚 全部', user.postCount),
    ...categories.map((category) => chip(String(category.id), `🗂 ${esc(category.name)}`, category.postCount)),
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
        ${avatarHtml(user, 'avatar-lg')}
        <div class="profile-info">
          <h1 style="font-size:21px">${esc(user.displayName)} ${roleTag(user.role)}</h1>
          <div class="page-sub">@${esc(user.username)} · 加入于 ${timeAgo(user.createdAt)}${isOwner ? ` · 🪙 ${fmtNum(user.coinBalance)} 币` : ''}</div>
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
             </form>
             <div class="hint">分类只影响你的个人主页；删除分类不会删除文章，文章会回到「未分类」。置顶推荐最多 ${data.pinLimit} 篇（已置顶 ${pinnedCount} 篇）。</div>
           </section>`
        : ''
    }

    <section class="card" style="padding:0">
      <div class="card-head chips-head">
        <div class="chips">${chips}</div>
        <div class="tabs tabs-sm">${layoutTabs}</div>
      </div>
      ${
        pinnedPosts.length
          ? `<div class="pinned-block">
               <div class="pinned-title">📌 置顶推荐</div>
               ${profilePostsHtml(pinnedPosts, { layout, toolsFor })}
             </div>`
          : ''
      }
      <div class="profile-posts">
        ${profilePostsHtml(otherPosts, { layout, toolsFor })}
      </div>
    </section>

    <section class="card">
      <div class="card-head"><span class="card-title">👥 关注者（${user.followerCount}）</span></div>
      <div class="chip-list">
        ${followers.length ? followers.map((person) => personChipHtml(person, { follow: true })).join('') : '<div class="hint">还没有关注者</div>'}
      </div>
    </section>

    <section class="card">
      <div class="card-head"><span class="card-title">➡️ TA 关注的人（${user.followingCount}）</span></div>
      <div class="chip-list">
        ${following.length ? following.map((person) => personChipHtml(person, { follow: true })).join('') : '<div class="hint">还没有关注任何人</div>'}
      </div>
    </section>`;
}

/* ------------------------------------------------------------------ */
/* 视图：每日签到                                                      */
/* ------------------------------------------------------------------ */

async function viewCheckin() {
  ui.app.innerHTML = loadingHtml();
  if (!state.me) {
    state.redirect = '/checkin';
    navigate('/login');
    return;
  }

  const status = await api('/api/checkin');
  state.checkin = status;
  const rules = checkinRules();

  const weekDots = status.week
    .map(
      (item) => `
      <div class="week-cell ${item.attended ? 'is-on' : ''} ${item.isToday ? 'is-today' : ''} ${item.future ? 'is-future' : ''}">
        <span class="week-label">周${weekdayCn(item.day)}</span>
        <span class="week-day">${monthDayCn(item.day)}</span>
        <span class="week-mark">${item.attended ? '✅' : item.future ? '·' : '—'}</span>
      </div>`,
    )
    .join('');

  const calendar = status.calendar
    .map(
      (item) =>
        `<span class="cal-cell ${item.attended ? 'is-on' : ''} ${item.isToday ? 'is-today' : ''} ${item.future ? 'is-future' : ''}"
               title="${item.day}${item.attended ? ' 已签到' : ''}">${monthDayCn(item.day)}</span>`,
    )
    .join('');

  const bonuses = status.bonusHistory.length
    ? status.bonusHistory
        .map((item) => `<div class="bonus-row"><span>🏅 ${item.weekStart} 那周全勤</span><span class="bonus-amount">+${item.amount} 币</span></div>`)
        .join('')
    : '<div class="hint">还没有拿过全勤奖，连续 7 天（周一至周日）都来签到试试。</div>';

  ui.app.innerHTML = `
    <section class="card checkin-hero">
      <div class="checkin-hero-main">
        <h1 style="font-size:21px">📅 每日签到</h1>
        <div class="page-sub">每天签到领 ${rules.dailyReward} 币；一个自然周（周一至周日）全勤，下周一签到再额外领 ${rules.weeklyBonus} 币。</div>
        <div class="checkin-status">
          ${
            status.checkedInToday
              ? `<span class="checkin-done big">✅ 今天已签到</span>
                 <span class="hint">明天再来，连续签到 ${status.streak} 天</span>`
              : `<button class="btn btn-primary" data-action="checkin">立即签到，领 ${rules.dailyReward} 币</button>
                 ${status.streak > 0 ? `<span class="hint">已经连续 ${status.streak} 天，别断了</span>` : '<span class="hint">开始你的第一天签到吧</span>'}`
          }
        </div>
        ${
          status.pendingBonus > 0
            ? `<div class="checkin-pending">🎁 上周全勤，签到即领 ${status.pendingBonus} 币全勤奖</div>`
            : ''
        }
      </div>
      <div class="checkin-stats">
        <div class="stat"><div class="stat-value">${status.streak}</div><div class="stat-label">连续签到</div></div>
        <div class="stat"><div class="stat-value">${status.total}</div><div class="stat-label">累计签到</div></div>
        <div class="stat"><div class="stat-value">${status.weekAttended}/${rules.fullWeekDays}</div><div class="stat-label">本周进度</div></div>
        <div class="stat"><div class="stat-value">🪙 ${fmtNum(status.coinBalance)}</div><div class="stat-label">可用币</div></div>
      </div>
    </section>

    <section class="card">
      <div class="card-head"><span class="card-title">本周（${status.weekStart} 起）</span></div>
      <div class="week-grid">${weekDots}</div>
      <div class="hint" style="margin-top:10px">
        ${status.weekAttended >= rules.fullWeekDays ? '本周已全勤 ✅ 下周一签到就能拿到全勤奖' : `本周还差 ${rules.fullWeekDays - status.weekAttended} 天全勤，全勤额外 +${rules.weeklyBonus} 币`}
      </div>
    </section>

    <section class="card">
      <div class="card-head"><span class="card-title">最近 35 天</span></div>
      <div class="cal-grid">${calendar}</div>
    </section>

    <section class="card">
      <div class="card-head"><span class="card-title">🏅 全勤记录</span></div>
      ${bonuses}
    </section>`;
}

/* ------------------------------------------------------------------ */
/* 视图：账号设置                                                      */
/* ------------------------------------------------------------------ */

async function viewSettings() {
  ui.app.innerHTML = loadingHtml();
  if (!state.me) {
    state.redirect = '/settings';
    navigate('/login');
    return;
  }

  const me = state.me;
  const status = state.checkin ?? (await api('/api/checkin'));
  state.checkin = status;
  const blocks = await api('/api/me/blocks').catch(() => ({ items: [], total: 0 }));

  ui.app.innerHTML = `
    <section class="page-head">
      <h1>⚙️ 账号设置</h1>
      <div class="page-sub">修改头像、昵称与个性签名、更换密码、管理黑名单，都在这里完成。</div>
    </section>

    <section class="card">
      <div class="card-head">
        <span class="card-title">🖼️ 头像</span>
        <span class="hint">预设表情或上传图片（会自动压缩成 256×256）</span>
      </div>
      <div class="avatar-editor">
        <div class="avatar-preview">
          ${avatarHtml(me, 'avatar-lg')}
          <span class="hint">当前头像</span>
        </div>
        <div class="avatar-controls">
          <div class="avatar-emojis">
            ${AVATAR_EMOJIS.map(
              ([emoji, hue]) => `
              <button class="avatar-option" type="button" data-action="set-avatar-emoji"
                      data-emoji="${emoji}" data-hue="${hue}" title="用 ${emoji} 作为头像"
                      style="--hue:${hue}">${emoji}</button>`,
            ).join('')}
          </div>
          <div class="form-actions" style="margin-top:12px;flex-wrap:wrap">
            <label class="btn btn-sm" for="avatar-file">📁 上传图片</label>
            <input id="avatar-file" type="file" accept="image/png,image/jpeg,image/webp" hidden data-avatar-input />
            <button class="btn btn-sm btn-ghost" type="button" data-action="reset-avatar">恢复默认</button>
            <span class="hint">支持 PNG / JPEG / WebP，≤ 256 KB，只保存到本机 data/avatars/</span>
          </div>
        </div>
      </div>
    </section>

    <section class="card">
      <div class="card-head">
        <span class="card-title">👤 个人资料</span>
        <a class="tag" href="#/u/${encodeURIComponent(me.username)}">查看我的主页</a>
      </div>
      <form class="form" data-action="save-profile">
        <div class="field">
          <label for="displayName">昵称</label>
          <input id="displayName" name="displayName" type="text" maxlength="20" required value="${esc(me.displayName)}" />
          <span class="hint">1-20 个字符，会显示在帖子、回复和通知里。</span>
        </div>
        <div class="field">
          <label for="bio">个性签名</label>
          <textarea id="bio" name="bio" maxlength="100" rows="3" class="bio-input"
                    placeholder="用一句话介绍自己，会显示在个人主页">${esc(me.bio ?? '')}</textarea>
          <span class="hint">最多 100 个字符，支持纯文本。</span>
        </div>
        <div class="form-error" data-error hidden></div>
        <div class="form-actions">
          <button class="btn btn-primary" type="submit">保存资料</button>
          <span class="hint">用户名 @${esc(me.username)} 不可修改</span>
        </div>
      </form>
    </section>

    <section class="card">
      <div class="card-head">
        <span class="card-title">🎨 外观</span>
        <span class="hint">主题只保存在当前浏览器（localStorage）</span>
      </div>
      <div class="theme-grid" data-theme-grid>${themeOptionsHtml()}</div>
      <div class="hint" style="margin-top:10px">点顶部导航栏的 🎨 也可以随时快速切换。</div>
    </section>

    <section class="card">
      <div class="card-head"><span class="card-title">🔒 修改密码</span></div>
      <form class="form" data-action="change-password">
        <div class="field">
          <label for="currentPassword">当前密码</label>
          <input id="currentPassword" name="currentPassword" type="password" required autocomplete="current-password" />
        </div>
        <div class="field">
          <label for="newPassword">新密码</label>
          <input id="newPassword" name="newPassword" type="password" required minlength="6" maxlength="72"
                 autocomplete="new-password" placeholder="至少 6 位" />
        </div>
        <div class="field">
          <label for="confirmPassword">确认新密码</label>
          <input id="confirmPassword" name="confirmPassword" type="password" required minlength="6" maxlength="72"
                 autocomplete="new-password" />
        </div>
        <div class="form-error" data-error hidden></div>
        <div class="form-actions">
          <button class="btn btn-primary" type="submit">更新密码</button>
          <span class="hint">修改成功后，其它设备上的登录状态会被强制下线。</span>
        </div>
      </form>
    </section>

    <section class="card">
      <div class="card-head">
        <span class="card-title">📅 签到与资产</span>
        <a class="tag" href="#/checkin">去签到</a>
      </div>
      <div class="stat-grid stat-grid-wide">
        <div class="stat"><div class="stat-value">${status.streak}</div><div class="stat-label">连续签到</div></div>
        <div class="stat"><div class="stat-value">${status.total}</div><div class="stat-label">累计签到</div></div>
        <div class="stat"><div class="stat-value">${status.weekAttended}/${status.fullWeekDays}</div><div class="stat-label">本周进度</div></div>
        <div class="stat"><div class="stat-value">🪙 ${fmtNum(me.coinBalance ?? status.coinBalance)}</div><div class="stat-label">可用币</div></div>
      </div>
      ${
        status.checkedInToday
          ? '<div class="hint" style="margin-top:12px">✅ 今天已经签到过了</div>'
          : '<div class="form-actions" style="margin-top:12px"><button class="btn btn-sm btn-primary" data-action="checkin">立即签到，领 ' +
            checkinRules().dailyReward +
            ' 币</button></div>'
      }
    </section>

    <section class="card">
      <div class="card-head">
        <span class="card-title">🚫 黑名单（${blocks.items.length}）</span>
        <span class="hint">被拉黑的人无法关注你、给你发私信，也看不到你发的文章</span>
      </div>
      <div class="chip-list">
        ${
          blocks.items.length
            ? blocks.items
                .map(
                  (person) => `
          <span class="chip">
            <a class="chip-label" href="#/u/${encodeURIComponent(person.username)}">
              ${avatarHtml(person, 'avatar-sm')} ${esc(person.displayName)}
            </a>
            <button class="chip-x" data-action="block-user" data-id="${person.id}" data-blocked="1" data-name="${esc(person.displayName)}"
                    title="解除拉黑">✕</button>
          </span>`,
                )
                .join('')
            : '<div class="hint">黑名单是空的。在别人的主页点「🚫 拉黑」就能加进来。</div>'
        }
      </div>
    </section>

    <section class="card">
      <div class="card-head"><span class="card-title">🧾 账号信息</span></div>
      <div class="table-wrap">
        <table class="data">
          <tbody>
            <tr><th>用户名</th><td>@${esc(me.username)}</td></tr>
            <tr><th>身份</th><td>${roleTag(me.role) || '普通成员'}</td></tr>
            <tr><th>注册时间</th><td>${fullTime(me.createdAt)}</td></tr>
            <tr><th>状态</th><td>${me.banned ? '<span class="tag tag-banned">已封禁</span>' : '<span class="tag">正常</span>'}</td></tr>
          </tbody>
        </table>
      </div>
    </section>`;
}

/* ------------------------------------------------------------------ */
/* 视图：排行榜                                                        */
/* ------------------------------------------------------------------ */

const RANKING_WINDOWS = [
  ['all', '全部时间'],
  ['30', '近 30 天'],
  ['7', '近 7 天'],
];

/** 前三名用金银铜徽标（写成函数，避免在 class 里嵌套模板字符串） */
const rankBadgeClass = (index) => (index < 3 ? `top-${index + 1}` : '');

function formulaCardHtml(weights) {
  const w = weights ?? { like: 1, coin: 5, bookmark: 3, dislike: 3, dislikeSoftCap: 3, halfSaturation: 50 };
  return `
    <section class="card formula-card">
      <div class="card-head"><span class="card-title">🧮 权重是怎么算的</span></div>
      <div class="formula">
        <div class="formula-line"><span class="formula-tag">①</span> 踩的软化：<code>D' = ${w.dislikeSoftCap}·踩 / (踩 + ${w.dislikeSoftCap})</code> —— 踩越多边际影响越小，最多相当于 ${w.dislikeSoftCap} 次踩</div>
        <div class="formula-line"><span class="formula-tag">②</span> 基础分：<code>S = ${w.like}·赞 + ${w.coin}·币 + ${w.bookmark}·收藏 − ${w.dislike}·D'</code></div>
        <div class="formula-line"><span class="formula-tag">③</span> 文章价值：<code>V = 100·S / (|S| + ${w.halfSaturation})</code> —— 饱和映射，天然落在 −100 ~ +100</div>
        <div class="formula-line"><span class="formula-tag">④</span> 个人权重：<code>W = Σ V</code>（该作者所有未删除文章的价值之和）</div>
      </div>
      <div class="hint" style="margin-top:10px;line-height:1.9">
        为什么投币权重最高（${w.coin}）：它最稀缺——注册只送 ${coinRules().signupGrant} 币，之后只能靠签到（每天 1 币）和别人的投币获得，单帖最多 ${coinRules().perPostLimit} 币，还不能自投；
        收藏（${w.bookmark}）代表"以后还要回来看"，强于点赞（${w.like}）；
        踩（${w.dislike}）通过软化函数避免围攻把一篇文章直接打成负无穷；
        半饱和点 ${w.halfSaturation} 让分数有界且边际递减——S=${w.halfSaturation} 时恰好 50 分，S=150 得 75 分，S=450 得 90 分。
        转发（🔁）目前只作为传播数据展示，暂不计入价值分，想计入的话改一个权重常量即可。
      </div>
    </section>`;
}

async function viewRanking(query) {
  ui.app.innerHTML = loadingHtml();
  const windowKey = RANKING_WINDOWS.some(([key]) => key === query.get('window')) ? query.get('window') : 'all';
  const sortBy = query.get('sort') === 'avg' ? 'avg' : 'total';
  const data = await api(`/api/ranking?window=${windowKey}&limit=20`);
  const weights = data.weights ?? state.site.valueWeights;

  const windowTabs = RANKING_WINDOWS.map(
    ([key, label]) =>
      `<a class="tab ${windowKey === key ? 'is-active' : ''}" href="#/ranking${key === 'all' ? '' : `?window=${key}`}">${label}</a>`,
  ).join('');

  const postRows = data.posts.length
    ? data.posts
        .map(
          (post, index) => `
      <tr>
        <td class="rank-cell"><span class="rank-badge ${rankBadgeClass(index)}">${index + 1}</span></td>
        <td class="wrap">
          <a href="#/post/${post.id}">${esc(post.title)}</a>
          <div class="hint">${post.board.icon} ${esc(post.board.name)} · ${esc(post.author.displayName)} · ${timeAgo(post.createdAt)}</div>
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
        <td class="rank-cell"><span class="rank-badge ${rankBadgeClass(index)}">${index + 1}</span></td>
        <td>
          <a class="author-cell" href="#/u/${encodeURIComponent(item.user.username)}">
            ${avatarHtml(item.user, 'avatar-sm')}
            <span>${esc(item.user.displayName)}</span>
          </a>
          ${roleTag(item.user.role)}
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

    ${formulaCardHtml(weights)}`;
}

/* ------------------------------------------------------------------ */
/* 视图：消息通知                                                      */
/* ------------------------------------------------------------------ */

const NOTIF_META = {
  post_reply: { icon: '💬', text: '回复了你的帖子' },
  post_repost: { icon: '🔁', text: '转发了你的文章' },
  post_like: { icon: '👍', text: '赞了你的帖子' },
  post_dislike: { icon: '👎', text: '踩了你的帖子' },
  post_coin: { icon: '🪙', text: '给你的帖子投了币' },
  follow: { icon: '👥', text: '关注了你' },
  mention: { icon: '📣', text: '在内容里 @ 了你' },
  following_post: { icon: '🆕', text: '发布了新帖子' },
  moderation: { icon: '🛡️', text: '管理操作' },
  message: { icon: '✉️', text: '给你发了私信' },
  system: { icon: '📢', text: '系统消息' },
};

function notifTarget(item) {
  // 私信直接跳到会话
  if (item.type === 'message' && item.actor) return `#/messages/${encodeURIComponent(item.actor.username)}`;
  if (item.type === 'follow' && item.actor) return `#/u/${encodeURIComponent(item.actor.username)}`;
  if (item.post && !item.post.deleted) return `#/post/${item.post.id}`;
  if (item.actor) return `#/u/${encodeURIComponent(item.actor.username)}`;
  return null;
}

function notifHtml(item) {
  const meta = NOTIF_META[item.type] ?? { icon: '🔔', text: '有新消息' };
  const target = notifTarget(item);
  const body = `
    <div class="notif-icon">${meta.icon}</div>
    <div class="notif-main">
      <div class="notif-line">
        ${
          item.actor
            ? `<a class="notif-actor" href="#/u/${encodeURIComponent(item.actor.username)}">${esc(item.actor.displayName)}</a>`
            : '<span class="notif-actor">系统</span>'
        }
        <span class="notif-action">${meta.text}</span>
      </div>
      ${
        item.type === 'moderation' || item.type === 'system' || item.type === 'post_coin' || item.type === 'message'
          ? item.excerpt
            ? `<div class="notif-excerpt">${esc(item.excerpt)}</div>`
            : ''
          : item.post?.title
            ? `<div class="notif-excerpt">${esc(item.post.title)}${item.post.deleted ? '（已删除）' : ''}</div>`
            : item.excerpt
              ? `<div class="notif-excerpt">${esc(item.excerpt)}</div>`
              : ''
      }
      <div class="notif-time">${timeAgo(item.createdAt)}</div>
    </div>
    ${item.read ? '' : '<span class="notif-dot" title="未读"></span>'}`;

  return target
    ? `<a class="notif-item ${item.read ? '' : 'is-unread'}" href="${target}" data-action="open-notification" data-id="${item.id}">${body}</a>`
    : `<div class="notif-item ${item.read ? '' : 'is-unread'}" data-action="read-notification" data-id="${item.id}">${body}</div>`;
}

async function viewNotifications(query) {
  ui.app.innerHTML = loadingHtml();
  if (!state.me) {
    state.redirect = '/notifications';
    navigate('/login');
    return;
  }
  const filter = query.get('filter') === 'unread' ? 'unread' : 'all';
  const page = Math.max(1, Number(query.get('page') || 1));
  const data = await api(`/api/notifications?filter=${filter}&page=${page}&perPage=20`);
  state.unread = data.unreadCount;

  const tabs = [
    ['all', `全部 ${filter === 'all' ? `(${data.total})` : ''}`],
    ['unread', '只看未读'],
  ]
    .map(([key, label]) => {
      const params = new URLSearchParams(query.toString());
      if (key === 'unread') params.set('filter', 'unread');
      else params.delete('filter');
      params.delete('page');
      const qs = params.toString();
      return `<a class="tab ${filter === key ? 'is-active' : ''}" href="#/notifications${qs ? `?${qs}` : ''}">${label}</a>`;
    })
    .join('');

  ui.app.innerHTML = `
    <section class="card">
      <div class="card-head" style="margin-bottom:4px">
        <h1 style="font-size:20px">🔔 消息通知</h1>
        ${data.unreadCount > 0 ? `<button class="btn btn-sm" data-action="read-all">全部标为已读（${data.unreadCount}）</button>` : '<span class="tag">已全部读完</span>'}
      </div>
      <div class="page-sub">有人回复、评价、投币、关注你或 @ 你时，这里会收到提醒。</div>
      <div class="tabs" style="margin-top:12px">${tabs}</div>
    </section>

    <section class="card" style="padding:0">
      <div class="notif-list">
        ${data.items.length ? data.items.map(notifHtml).join('') : emptyHtml('📭', filter === 'unread' ? '没有未读消息' : '还没有任何消息', '多参与讨论就会有啦')}
      </div>
      ${paginationHtml(data.page, data.totalPages, (target) => routeQuery('/notifications', query, { page: target }))}
    </section>`;
  renderUserArea();
  renderSidebar();
}

/* ------------------------------------------------------------------ */
/* 视图：私信                                                          */
/* ------------------------------------------------------------------ */

/** 一天一条的限制进度条文案 */
function messageQuotaHtml(availability) {
  if (!availability) return '';
  if (availability.blockedByMe) {
    return `<span class="dm-blocked">🚫 你已拉黑对方，解除后才能私信</span>`;
  }
  if (availability.blockedMe) {
    return `<span class="dm-blocked">🚫 对方已将你拉黑，无法发送私信</span>`;
  }
  if (availability.mutual) return `<span class="dm-quota is-free">🤝 互相关注 · 不限量</span>`;
  if (availability.followed) {
    const left = availability.remainingToday ?? 0;
    return `<span class="dm-quota ${left > 0 ? '' : 'is-empty'}">👋 单方面关注 · 今天还剩 ${left}/${availability.dailyLimit} 条</span>`;
  }
  return `<span class="dm-quota is-empty">🔒 先关注对方（或等 TA 关注你）才能私信</span>`;
}

async function viewMessages() {
  ui.app.innerHTML = loadingHtml();
  if (!state.me) {
    state.redirect = '/messages';
    navigate('/login');
    return;
  }
  const data = await api('/api/messages');
  state.messageUnread = data.unread ?? 0;

  const rows = data.items.length
    ? data.items
        .map(
          (item) => `
      <a class="dm-row ${item.unread > 0 ? 'is-unread' : ''}" href="#/messages/${encodeURIComponent(item.peer.username)}">
        ${avatarHtml(item.peer, 'avatar-lg')}
        <div class="dm-row-main">
          <div class="dm-row-head">
            <span class="dm-row-name">${esc(item.peer.displayName)} ${roleTag(item.peer.role)}</span>
            <span class="hint">${timeAgo(item.lastMessage.createdAt)}</span>
          </div>
          <div class="dm-row-preview">
            ${item.lastMessage.mine ? '<span class="hint">我：</span>' : ''}${esc(item.lastMessage.content.slice(0, 60))}
          </div>
        </div>
        ${item.unread > 0 ? `<span class="menu-badge">${item.unread}</span>` : ''}
      </a>`,
        )
        .join('')
    : emptyHtml('✉️', '还没有私信', '去别人的主页点「私信」就能聊起来');

  const rules = data.rules ?? state.site.messageRules ?? { oneWayDailyLimit: 1 };
  ui.app.innerHTML = `
    <section class="page-head">
      <h1>✉️ 私信</h1>
      <div class="page-sub">
        互相关注 <strong>不限量</strong>；单方面关注每天 <strong>${rules.oneWayDailyLimit} 条</strong>；拉黑后无法互相私信。
      </div>
    </section>
    <section class="card" style="padding:0">
      <div class="dm-list">${rows}</div>
    </section>`;
  renderUserArea();
}

async function viewThread(username) {
  ui.app.innerHTML = loadingHtml();
  if (!state.me) {
    state.redirect = `/messages/${username}`;
    navigate('/login');
    return;
  }
  const data = await api(`/api/messages/${encodeURIComponent(username)}`);
  const { peer, messages, availability } = data;
  void refreshMessageUnread();

  const bubbles = messages.length
    ? messages
        .map(
          (item) => `
      <div class="dm-bubble ${item.senderId === state.me.id ? 'is-mine' : ''}">
        <div class="dm-bubble-body">${esc(item.content).replace(/\n/g, '<br />')}</div>
        <div class="dm-bubble-time">${fullTime(item.createdAt)}${item.senderId === state.me.id ? (item.read ? ' · 已读' : ' · 未读') : ''}</div>
      </div>`,
        )
        .join('')
    : `<div class="dm-empty">还没有聊过天，打个招呼吧 👋</div>`;

  ui.app.innerHTML = `
    <section class="page-head">
      <h1>
        <a href="#/u/${encodeURIComponent(peer.username)}" class="dm-peer-link">
          ${avatarHtml(peer, 'avatar-sm')} ${esc(peer.displayName)}
        </a>
        ${roleTag(peer.role)}
      </h1>
      <div class="page-sub">
        <a href="#/messages">← 全部会话</a>
        ${messageQuotaHtml(availability)}
      </div>
    </section>

    <section class="card dm-thread">
      <div class="dm-messages">${bubbles}</div>
      ${
        availability.canSend
          ? `<form class="dm-composer" data-action="send-message" data-username="${esc(peer.username)}">
               <textarea name="content" rows="2" maxlength="${(state.site.messageRules ?? {}).maxLength ?? 1000}"
                         placeholder="输入私信内容，Enter 发送 / Shift+Enter 换行" required></textarea>
               <button class="btn btn-primary" type="submit">发送</button>
             </form>`
          : `<div class="dm-locked">
               ${messageQuotaHtml(availability)}
               <span class="hint">${esc(availability.message)}</span>
             </div>`
      }
    </section>`;
  renderUserArea();
  const box = document.querySelector('.dm-messages');
  if (box) box.scrollTop = box.scrollHeight;
  const textarea = document.querySelector('.dm-composer textarea');
  if (textarea) textarea.focus();
}

/* ------------------------------------------------------------------ */
/* 视图：帖子详情                                                      */
/* ------------------------------------------------------------------ */

function replyHtml(reply, post) {
  const canDelete =
    state.me && (state.me.id === reply.author.id || state.me.id === post.author.id || isStaffUser(state.me));
  return `
    <div class="reply" id="reply-${reply.id}">
      ${avatarHtml(reply.author)}
      <div class="reply-body">
        <div class="reply-head">
          <a class="reply-author" href="#/u/${encodeURIComponent(reply.author.username)}">${esc(reply.author.displayName)}</a>
          ${roleTag(reply.author.role)}
          ${reply.author.id === post.author.id ? '<span class="tag tag-soft">楼主</span>' : ''}
          <span title="${fullTime(reply.createdAt)}">${timeAgo(reply.createdAt)}</span>
          <span class="reply-actions">
            ${
              canDelete
                ? `<button class="link-btn" data-action="delete-reply" data-id="${reply.id}" data-post="${post.id}">删除</button>`
                : ''
            }
          </span>
        </div>
        <div class="md">${reply.contentHtml}</div>
      </div>
    </div>`;
}

function reactionBarHtml(post) {
  const rules = coinRules();
  // 投币规则由服务端下发（post.coin），前端只负责展示与提示
  const coin = post.coin ?? {
    available: false,
    reason: 'anonymous',
    message: '登录后即可投币',
    myCoins: post.myCoins ?? 0,
    balance: 0,
    perPostLimit: rules.perPostLimit,
    signupGrant: rules.signupGrant,
  };
  const isAuthor = state.me && state.me.id === post.author.id;

  return `
    <div class="action-bar">
      <button class="btn btn-sm reaction ${post.liked ? 'is-on' : ''}" data-action="reaction" data-kind="like" data-id="${post.id}" title="觉得有用就点个赞">
        👍 <span data-like-label>${post.liked ? '已赞' : '赞'}</span> <span data-like-count>${post.likeCount}</span>
      </button>
      <button class="btn btn-sm reaction ${post.disliked ? 'is-on-danger' : ''}" data-action="reaction" data-kind="dislike" data-id="${post.id}" title="觉得没帮助可以踩">
        👎 <span data-dislike-label>${post.disliked ? '已踩' : '踩'}</span> <span data-dislike-count>${post.dislikeCount}</span>
      </button>
      <button class="btn btn-sm reaction ${coin.myCoins > 0 ? 'is-on-coin' : ''} ${coin.available ? '' : 'is-locked'}"
              data-action="coin" data-id="${post.id}"
              data-coin-locked="${coin.available ? '0' : '1'}" data-coin-reason="${esc(coin.reason)}"
              data-coin-hint="${esc(coin.message)}" data-limit="${coin.perPostLimit}"
              aria-disabled="${coin.available ? 'false' : 'true'}" title="${esc(coin.message)}">
        🪙 投币 <span data-coin-count>${post.coinCount}</span><span data-my-coins>${coin.myCoins > 0 ? ` <span class="tag tag-soft">我投了 ${coin.myCoins}</span>` : ''}</span>
      </button>
      ${
        state.me && !isAuthor
          ? `<span class="coin-budget" data-coin-budget>可用 ${coin.balance} 币</span>`
          : ''
      }
      ${coin.available || !state.me ? '' : `<span class="coin-locked-hint">${esc(coin.message)}</span>`}
      <button class="btn btn-sm ${post.bookmarked ? 'is-on' : ''}" data-action="bookmark" data-id="${post.id}">
        ${post.bookmarked ? '★ 已收藏' : '☆ 收藏'} <span data-bookmark-count>${post.bookmarkCount}</span>
      </button>
      <button class="btn btn-sm ${post.reposted ? 'is-on-repost' : ''}" data-action="repost-toggle" data-id="${post.id}"
              title="${post.reposted ? '撤销我的转发' : '把这篇转发到我的主页'}">
        🔁 ${post.reposted ? '已转发' : '转发'} <span data-repost-count>${post.repostCount}</span>
      </button>
      <button class="btn btn-sm btn-ghost" data-action="copy-link" data-id="${post.id}" title="复制链接分享给站外的人">🔗 复制链接</button>
      ${
        state.me && !isAuthor
          ? `<button class="btn btn-sm ${post.authorFollowed ? 'is-on' : ''}" data-action="follow" data-user="${post.author.id}" data-name="${esc(post.author.displayName)}">
               ${post.authorFollowed ? '✓ 已关注作者' : '＋ 关注作者'}
             </button>`
          : ''
      }
      <span class="spacer"></span>
      ${post.valueScore !== undefined ? `<span class="value-chip" title="价值分由赞、投币、收藏、踩综合计算">⭐ 价值 ${post.valueScore}</span>` : ''}
      ${isAuthor ? `<a class="btn btn-sm" href="#/edit/${post.id}">✏️ 编辑</a>` : ''}
      ${
        state.me && isStaffUser(state.me)
          ? `<button class="btn btn-sm ${post.hidden ? 'is-on' : ''}" data-action="hide-post" data-id="${post.id}" data-hidden="${post.hidden ? '1' : '0'}"
                     title="隐藏后文章对普通访客和搜索引擎都不可见，可随时恢复">${post.hidden ? '👁 恢复显示' : '🙈 隐藏'}</button>`
          : ''
      }
      ${
        state.me && (isAuthor || isStaffUser(state.me))
          ? `<button class="btn btn-sm btn-danger" data-action="delete-post" data-id="${post.id}">🗑 删除</button>`
          : ''
      }
    </div>`;
}

/** 转发区块：转发表单 + 转发列表 */
function repostSectionHtml(post, reposters) {
  const mine = reposters.find((item) => item.user.id === state.me?.id) ?? null;
  const list = reposters.length
    ? `<div class="repost-list">${reposters
        .map(
          (item) => `
        <div class="repost-item">
          ${avatarHtml(item.user, 'avatar-sm')}
          <div class="repost-body">
            <div class="repost-head">
              <a class="reply-author" href="#/u/${encodeURIComponent(item.user.username)}">${esc(item.user.displayName)}</a>
              ${roleTag(item.user.role)}
              <span title="${fullTime(item.createdAt)}">${timeAgo(item.createdAt)} 转发</span>
            </div>
            ${item.comment ? `<div class="repost-comment">${esc(item.comment)}</div>` : '<div class="hint">（仅转发，没有附加评论）</div>'}
          </div>
        </div>`,
        )
        .join('')}</div>`
    : '<div class="hint">还没有人转发，你可以抢第一个。</div>';

  const form =
    state.me && state.me.id !== post.author.id
      ? `<form class="form repost-form" data-action="repost" data-id="${post.id}">
           <div class="field">
             <textarea name="comment" maxlength="300" rows="2"
                       placeholder="${mine ? '修改你的转发语…' : '说点什么再转发（可留空直接转发）'}">${esc(mine?.comment ?? '')}</textarea>
             <span class="hint">转发会出现在你的主页「🔁 转发」里，并通知作者；同一篇只能转发一次，可随时撤销。</span>
           </div>
           <div class="form-actions">
             <button class="btn btn-primary" type="submit">${mine ? '更新转发语' : '确认转发'}</button>
             ${mine ? `<button class="btn" type="button" data-action="repost-cancel" data-id="${post.id}">撤销转发</button>` : ''}
           </div>
         </form>`
      : state.me
        ? '<div class="hint">自己的文章不用转发，直接分享链接给朋友就好。</div>'
        : '<div class="hint">登录后可以转发这篇文章。</div>';

  return `
    <section class="card" id="repost-section">
      <div class="card-head">
        <span class="card-title">🔁 转发（${reposters.length}）</span>
        <button class="btn btn-sm btn-ghost" type="button" data-action="copy-link" data-id="${post.id}">🔗 复制链接</button>
      </div>
      ${form}
      <div style="margin-top:14px">${list}</div>
    </section>`;
}

async function viewPost(id) {
  ui.app.innerHTML = loadingHtml();
  const [{ post, replies, reposters }, aiInfo] = await Promise.all([
    api(`/api/posts/${id}`),
    api(`/api/ai/posts/${id}`).catch(() => ({ cached: null, stale: false })),
  ]);

  ui.app.innerHTML = `
    <article class="card">
      ${
        post.hidden
          ? `<div class="moderation-banner">
               <span class="moderation-icon">🙈</span>
               <div>
                 <strong>这篇文章已被${post.hiddenBy && state.me && post.hiddenBy === state.me.id ? '你' : '管理团队'}隐藏</strong>
                 <div class="hint">
                   ${post.hiddenReason ? `原因：${esc(post.hiddenReason)} · ` : ''}
                   隐藏期间普通访客访问会看到 404，且不出现在列表、搜索与排行榜里，只有作者本人和管理团队可见。
                 </div>
               </div>
               ${
                 state.me && isStaffUser(state.me)
                   ? `<button class="btn btn-sm" data-action="hide-post" data-id="${post.id}" data-hidden="1">👁 恢复显示</button>`
                   : ''
               }
             </div>`
          : ''
      }
      <div class="post-detail-head">
        ${avatarHtml(post.author, 'avatar-lg')}
        <div style="min-width:0;flex:1">
          <div class="post-tags">
            <a class="tag" href="#/board/${esc(post.board.slug)}">${post.board.icon} ${esc(post.board.name)}</a>
            ${post.pinned ? '<span class="tag tag-pin">📌 置顶</span>' : ''}
            ${post.locked ? '<span class="tag">🔒 已锁定</span>' : ''}
            ${post.authorFollowed ? '<span class="tag tag-follow">✓ 已关注作者</span>' : ''}
          </div>
          <h1 class="post-detail-title">${esc(post.title)}</h1>
          <div class="post-detail-meta">
            <a href="#/u/${encodeURIComponent(post.author.username)}">${esc(post.author.displayName)}</a>
            ${roleTag(post.author.role)}
            <span>·</span>
            <span title="${fullTime(post.createdAt)}">发布于 ${timeAgo(post.createdAt)}</span>
            ${post.updatedAt - post.createdAt > 60000 ? `<span>· 已编辑于 ${timeAgo(post.updatedAt)}</span>` : ''}
            <span>·</span>
            <span>👁 ${post.views} 次浏览</span>
          </div>
        </div>
      </div>

      <div class="md" style="margin-top:18px">${post.contentHtml}</div>

      ${aiPostPanelHtml(post, aiInfo)}

      ${state.me ? reactionBarHtml(post) : `<div class="action-bar">
        <a class="btn btn-sm btn-primary" href="#/login">登录后可以评价、投币和关注作者</a>
        <span class="spacer"></span>
        <span class="post-meta"><span>👍 ${post.likeCount}</span><span>👎 ${post.dislikeCount}</span><span>🪙 ${post.coinCount}</span><span>⭐ ${post.bookmarkCount}</span><span>🔁 ${post.repostCount}</span></span>
      </div>`}
    </article>

    <section class="card" style="padding:0">
      <div class="card-head" style="padding:16px 18px;margin:0;border-bottom:1px solid var(--border-soft)">
        <span class="card-title">💬 全部回复（${replies.length}）</span>
        ${post.locked ? '<span class="tag">🔒 该帖已锁定</span>' : ''}
      </div>
      ${replies.length ? replies.map((reply) => replyHtml(reply, post)).join('') : emptyHtml('💭', '还没有人回复', '来抢占沙发吧')}
    </section>

    <section class="card">
      <div class="card-head"><span class="card-title">✍️ 发表回复</span></div>
      ${
        !state.me
          ? `<div class="hint" style="margin-bottom:12px">登录后即可参与讨论。</div>
             <div class="form-actions">
               <a class="btn btn-primary" href="#/login">登录</a>
               <a class="btn" href="#/register">注册新账号</a>
             </div>`
          : post.locked && state.me.role !== 'admin'
            ? '<div class="hint">该帖子已锁定，暂时无法回复。</div>'
            : `<form class="form" data-action="reply" data-id="${post.id}">
                 <div class="field">
                   <textarea name="content" placeholder="写下你的想法…（支持 Markdown，@某人 可以提醒 TA）" required maxlength="5000"></textarea>
                   <span class="hint">支持 粗体、行内代码、代码块、引用、列表、链接与 @提及</span>
                 </div>
                 <div class="form-actions">
                   <button class="btn btn-primary" type="submit">发表回复</button>
                   <button class="btn btn-ghost" type="button" data-action="preview" data-target="reply">预览</button>
                 </div>
                 <div class="preview-box" data-preview hidden></div>
               </form>`
      }
    </section>

    ${repostSectionHtml(post, reposters)}`;
}

/* ------------------------------------------------------------------ */
/* 视图：发帖 / 编辑                                                   */
/* ------------------------------------------------------------------ */

function boardOptions(selectedId) {
  return state.site.boards
    .map(
      (board) =>
        `<option value="${board.id}" ${Number(selectedId) === board.id ? 'selected' : ''}>${board.icon} ${esc(board.name)}</option>`,
    )
    .join('');
}

async function viewCompose(postId) {
  ui.app.innerHTML = loadingHtml();
  if (!state.me) {
    state.redirect = postId ? `/edit/${postId}` : '/new';
    navigate('/login');
    return;
  }
  let post = null;
  if (postId) {
    const data = await api(`/api/posts/${postId}`);
    post = data.post;
    if (post.author.id !== state.me.id && state.me.role !== 'admin') {
      ui.app.innerHTML = `<div class="card">${emptyHtml('🚫', '没有权限编辑这个帖子')}</div>`;
      return;
    }
  }

  let categories = [];
  try {
    categories = (await api('/api/me/categories')).items;
  } catch {
    categories = [];
  }

  ui.app.innerHTML = `
    <section class="card">
      <div class="card-head">
        <h1 style="font-size:20px">${post ? '✏️ 编辑帖子' : '✏️ 发布新帖'}</h1>
        <a class="tag" href="${post ? `#/post/${post.id}` : '#/'}">取消</a>
      </div>
      <form class="form" id="composeForm" data-action="compose" data-id="${post?.id ?? ''}">
        <div class="field">
          <label for="boardId">选择板块</label>
          <select id="boardId" name="boardId" required>${boardOptions(post?.board.id)}</select>
        </div>
        <div class="field">
          <label for="categoryId">个人主页分类（可选）</label>
          <select id="categoryId" name="categoryId">
            <option value="">未分类</option>
            ${categories
              .map(
                (category) =>
                  `<option value="${category.id}" ${post?.category?.id === category.id ? 'selected' : ''}>🗂 ${esc(category.name)}</option>`,
              )
              .join('')}
          </select>
          <span class="hint">分类只影响你个人主页的归类，去 <a href="#/u/${encodeURIComponent(state.me.username)}">我的主页</a> 可以新建或整理分类。</span>
        </div>
        <label class="checkbox-row">
          <input type="checkbox" name="profilePinned" value="1" ${post?.profilePinned ? 'checked' : ''} />
          <span>📌 在我的个人主页置顶推荐（每篇最多 ${profileRules().pinLimit} 篇置顶）</span>
        </label>
        <div class="field">
          <label for="title">标题</label>
          <input id="title" name="title" type="text" required minlength="2" maxlength="80"
                 placeholder="一句话说清楚你要讨论什么" value="${esc(post?.title ?? '')}" />
        </div>
        <div class="field">
          <label for="content">正文</label>
          <div class="md-toolbar">
            <button class="btn btn-sm btn-ghost" type="button" data-action="md" data-md="bold"><b>B</b></button>
            <button class="btn btn-sm btn-ghost" type="button" data-action="md" data-md="italic"><i>I</i></button>
            <button class="btn btn-sm btn-ghost" type="button" data-action="md" data-md="code">代码</button>
            <button class="btn btn-sm btn-ghost" type="button" data-action="md" data-md="block">代码块</button>
            <button class="btn btn-sm btn-ghost" type="button" data-action="md" data-md="quote">引用</button>
            <button class="btn btn-sm btn-ghost" type="button" data-action="md" data-md="list">列表</button>
            <button class="btn btn-sm btn-ghost" type="button" data-action="md" data-md="link">链接</button>
            <button class="btn btn-sm btn-ghost" type="button" data-action="md" data-md="mention">@提及</button>
          </div>
          <textarea id="content" name="content" required maxlength="20000"
                    placeholder="详细描述你的问题或想法…">${esc(post?.content ?? '')}</textarea>
        </div>
        <div class="preview-box" data-preview hidden></div>
        <div class="form-actions">
          <button class="btn btn-primary" type="submit">${post ? '保存修改' : '发布帖子'}</button>
          <button class="btn btn-ghost" type="button" data-action="preview" data-target="compose">预览</button>
          <span class="hint">发布后会自动通知你的关注者</span>
        </div>
      </form>
      <!-- AI 笔记工作台（note-agent）的挂载点。
           刻意放在 </form> **外面**：面板里有一个 <input type="text"> 的「要求」输入框，
           放进表单里按回车会被浏览器当成提交，直接把帖子发出去。
           抽屉本体是 position: fixed，放哪儿都不占布局。 -->
      <div id="notesMount" class="notes-mount"></div>
    </section>`;

  mountComposeNotesPanel(post?.id ?? null);
}

/* ------------------------------------------------------------------ */
/* AI 笔记工作台（note-agent）：写作页的挂载与销毁                      */
/* ------------------------------------------------------------------ */

/**
 * 写作页当前的面板实例。
 *
 * SPA 每次换页都会整个重写 `ui.app.innerHTML`，所以换页前必须 destroy()：
 * 面板挂着编辑区监听，还会往 document.body 上添 `notes-drawer-open` 类，
 * 留着会漏到下一页去（抽屉跟着你满站跑）。
 */
let composeNotesPanel = null;

function destroyComposeNotesPanel() {
  if (!composeNotesPanel) return;
  try {
    composeNotesPanel.destroy();
  } catch (error) {
    console.warn('[notes-agent] 工作台销毁失败：', error);
  }
  composeNotesPanel = null;
}

/**
 * 在写作页挂上工作台。
 *
 * 守卫式：面板脚本（/notes-panel.js）没加载成功时静默跳过，写作页照常可用。
 * 守卫必须写成 `if (window.NotesAgent)` 这个形状 —— note-agent 的
 * tests/test-integration.mjs 就是用这个正则认「接入方有没有走守卫式」的。
 *
 * `#composeForm` 里正好是 `#title` + `#content` 两个元素，与面板自带的
 * textarea 适配器（window.NotesAgent.createTextareaAdapter）对得上。
 */
function mountComposeNotesPanel(postId) {
  const mount = document.getElementById('notesMount');
  const root = document.getElementById('composeForm');
  if (!mount || !root) return;
  if (window.NotesAgent) {
    try {
      composeNotesPanel = window.NotesAgent.attach({
        mount,
        editor: window.NotesAgent.createTextareaAdapter(root),
        postId: postId ?? null,
      });
    } catch (error) {
      console.warn('[notes-agent] 工作台挂载失败：', error);
      composeNotesPanel = null;
    }
  }
}

/* ------------------------------------------------------------------ */
/* 视图：登录 / 注册                                                   */
/* ------------------------------------------------------------------ */

async function viewAuth(mode) {
  const isLogin = mode === 'login';
  ui.app.innerHTML = `
    <section class="card" style="max-width:460px;width:100%;margin:0 auto">
      <div class="card-head">
        <h1 style="font-size:20px">${isLogin ? '👋 欢迎回来' : '🎉 创建新账号'}</h1>
      </div>
      <form class="form" data-action="${isLogin ? 'login' : 'register'}">
        <div class="field">
          <label for="username">用户名</label>
          <input id="username" name="username" type="text" required autocomplete="username"
                 placeholder="字母、数字或下划线，3-20 位" />
        </div>
        ${
          isLogin
            ? ''
            : `<div class="field">
                 <label for="displayName">昵称（可选）</label>
                 <input id="displayName" name="displayName" type="text" maxlength="20" placeholder="展示给其他用户的名字" />
               </div>`
        }
        <div class="field">
          <label for="password">密码</label>
          <input id="password" name="password" type="password" required autocomplete="${isLogin ? 'current-password' : 'new-password'}"
                 placeholder="${isLogin ? '输入密码' : '至少 6 位'}" />
        </div>
        <div class="form-error" data-error hidden></div>
        <div class="form-actions">
          <button class="btn btn-primary" type="submit">${isLogin ? '登录' : '注册并登录'}</button>
          <a class="btn btn-ghost" href="#/${isLogin ? 'register' : 'login'}">${isLogin ? '没有账号？注册' : '已有账号？登录'}</a>
        </div>
      </form>
      <div class="hint" style="margin-top:16px;line-height:1.9">
        演示账号：<code>admin / admin123</code>（管理员）<br />
        普通账号：<code>alice / demo1234</code>、<code>bob / demo1234</code>
      </div>
    </section>`;

  $('#username').focus();
}

/* ------------------------------------------------------------------ */
/* 视图：AI 阅读助手                                                   */
/* ------------------------------------------------------------------ */

function aiConfigured() {
  return Boolean(state.site?.ai?.configured);
}

function aiNoticeHtml() {
  return `<div class="ai-notice">⚙️ AI 还没有配置。启动服务前设置环境变量 <code>AI_API_KEY</code>（可选 <code>AI_BASE_URL</code> / <code>AI_MODEL</code>）即可启用，例如：<code>AI_API_KEY=sk-xxx node src/server.js</code></div>`;
}

const aiChip = (text, kind = '') => `<span class="ai-chip ${kind}">${esc(text)}</span>`;

/** 同时兼容 postId（论坛）与 documentId（通用包）两种字段名。 */
const aiIdOf = (item) => item?.postId ?? item?.documentId ?? null;

const aiPostLink = (post) => `
  <a class="ai-post" href="#/post/${post.id}">
    <span class="ai-post-title">${esc(post.title)}</span>
    <span class="ai-post-meta">${esc(post.board || '')}${post.replyCount ? ` · ${post.replyCount} 条回复` : ''}${post.difficulty ? ` · ${esc(post.difficulty)}` : ''}</span>
  </a>`;

function aiAskFormHtml(context) {
  const isPost = Boolean(context.postId);
  return `
    <form class="ai-ask-form" data-action="ai-ask" data-id="${isPost ? context.postId : ''}" data-host="${esc(context.host)}">
      <div class="ai-ask-row">
        <input name="question" maxlength="500" placeholder="${isPost ? '就这篇帖子提问，例如：这个方案有什么坑？' : '问全站，例如：入门该从哪几篇开始读？'}" required />
        <button class="btn btn-primary" type="submit">问一问</button>
      </div>
      <div class="hint">AI 只依据${isPost ? '这篇帖子及其回复' : `已整理的全站语料（当前 ${fmtNum(state.site?.stats?.posts ?? 0)} 篇帖子）`}回答，并给出引用出处。</div>
    </form>
    <div class="ai-answer-host" data-ai-answer hidden></div>`;
}

function aiAnswerHtml(data) {
  const citations = (data.citations ?? [])
    .map((item) => {
      const id = aiIdOf(item);
      return `
      <a class="ai-cite" ${id ? `href="#/post/${id}"` : ''}>
        <span class="ai-cite-id">${id ? `#${id}` : '外部'}</span>
        <span class="ai-cite-title">${esc(item.title)}</span>
        ${item.quote ? `<span class="ai-cite-quote">「${esc(item.quote)}」</span>` : ''}
      </a>`;
    })
    .join('');
  const notes = (data.notes ?? []).map((note) => `<li>${esc(note)}</li>`).join('');
  const confidenceLabel = { high: '依据充分', medium: '依据一般', low: '依据不足' }[data.confidence] ?? '依据一般';
  return `
    <div class="ai-answer">
      <div class="ai-answer-head">
        <span class="ai-badge">AI 回答</span>
        ${aiChip(confidenceLabel, `conf-${data.confidence || 'medium'}`)}
        ${data.model ? aiChip(data.model, 'soft') : ''}
        ${data.truncated ? aiChip('材料已截断', 'warn') : ''}
      </div>
      <div class="ai-answer-text">${esc(data.answer).replace(/\n/g, '<br />')}</div>
      ${
        citations
          ? `<div class="ai-cites"><div class="ai-sub">引用出处</div>${citations}</div>`
          : '<div class="hint">这条回答没有引用具体帖子。</div>'
      }
      ${notes ? `<div class="ai-sub">补充提醒</div><ul class="ai-notes">${notes}</ul>` : ''}
    </div>`;
}

function aiReviewCardHtml(review) {
  if (!review || review.status !== 'done') return '';
  const prereq = (review.prereq ?? [])
    .map(
      (item) =>
        `<li><strong>${esc(item.name)}</strong>${item.level ? ` <span class="ai-mini">${esc(item.level)}</span>` : ''}${item.why ? ` — ${esc(item.why)}` : ''}</li>`,
    )
    .join('');
  const recommend = (review.recommend ?? [])
    .map((item) => {
      const id = aiIdOf(item);
      return `
      <li>
        ${id ? `<a href="#/post/${id}">${esc(item.title)}</a>` : `<span>${esc(item.title)}</span>`}
        ${item.relation ? aiChip(item.relation, 'soft') : ''}
        ${item.reason ? `<div class="hint">${esc(item.reason)}</div>` : ''}
      </li>`;
    })
    .join('');
  return `
    <div class="ai-review">
      <div class="ai-badges">
        ${review.category ? aiChip(`📂 ${review.category}`, 'cat') : ''}
        ${review.difficulty ? aiChip(`🎯 ${review.difficulty}`, 'diff') : ''}
        ${(review.tags ?? []).map((tag) => aiChip(tag, 'soft')).join('')}
      </div>
      ${review.summary ? `<p class="ai-summary">${esc(review.summary)}</p>` : ''}
      ${
        prereq
          ? `<div class="ai-sub">🧱 前置知识</div><ul class="ai-list">${prereq}</ul>`
          : ''
      }
      ${
        recommend
          ? `<div class="ai-sub">📚 推荐阅读</div><ul class="ai-list">${recommend}</ul>`
          : ''
      }
      <div class="hint">${review.model ? `模型 ${esc(review.model)} · ` : ''}更新于 ${timeAgo(review.updatedAt)}${
        review.tokens?.prompt ? ` · tokens ${review.tokens.prompt}+${review.tokens.completion}` : ''
      }</div>
    </div>`;
}

/** 帖子详情页里的 AI 区块：解读 / 前置知识 / 推荐阅读 / 就这篇提问。 */
function aiPostPanelHtml(post, aiInfo) {
  const review = aiInfo?.cached ?? null;
  const stale = Boolean(aiInfo?.stale);
  const done = review && review.status === 'done';
  const failed = review && review.status !== 'done';
  const host = `ai-post-${post.id}`;
  const needsRebuild = stale || failed;
  const buttonLabel = done && !needsRebuild ? '🔄 重新解读' : needsRebuild && done ? '🔄 内容已变，重新解读' : '✨ 解读这篇';

  return `
    <section class="ai-panel" data-ai-panel="${host}">
      <div class="ai-panel-head">
        <span class="ai-badge">🤖 AI 阅读助手</span>
        ${
          state.me
            ? `<button class="btn btn-sm btn-ghost" type="button" data-action="ai-analyze" data-id="${post.id}" data-host="${host}">${buttonLabel}</button>`
            : '<a class="btn btn-sm btn-ghost" href="#/login">登录后可使用</a>'
        }
      </div>
      ${!aiConfigured() ? aiNoticeHtml() : ''}
      ${
        done
          ? `${stale ? '<div class="ai-stale">内容有更新，建议重新解读一次。</div>' : ''}${aiReviewCardHtml(review)}`
          : failed
            ? `<div class="ai-error">上次解读失败：${esc(review.error || '未知原因')}</div>`
            : `<div class="hint">还没有解读过。点右上角「解读这篇」，AI 会给出分类、摘要、前置知识与推荐阅读。</div>`
      }
      <div class="ai-ask-block">
        <div class="ai-sub">💬 就这篇提问</div>
        ${aiAskFormHtml({ postId: post.id, host })}
      </div>
    </section>`;
}

/** AI 主页：全站整理结果 + 逐篇分类清单 + 全站问答。 */
async function viewAI() {
  ui.app.innerHTML = loadingHtml();
  if (!state.me) {
    state.redirect = '/ai';
    navigate('/login');
    return;
  }

  const data = await api('/api/ai/site');
  const { report, topics = [], readingPath = [], posts = [], stats = {} } = data;
  const isAdmin = isStaffUser(state.me);
  const corpus = stats.corpus ?? {};

  const head = `
    <section class="card">
      <div class="card-head">
        <h1 style="font-size:21px">🤖 AI 阅读助手</h1>
        <div class="ai-head-actions">
          ${isAdmin ? '<button class="btn btn-sm" type="button" data-action="ai-analyze-pending">⚡ 解读未整理的帖子</button>' : ''}
          ${isAdmin ? '<button class="btn btn-sm btn-primary" type="button" data-action="ai-site-analyze">🧭 重新整理全站</button>' : ''}
        </div>
      </div>
      <div class="page-sub">把论坛里的 Markdown 帖子自动分类整理，给出推荐阅读顺序与前置知识；也可以基于单篇帖子或全站内容直接提问。</div>
      <div class="ai-stats">
        <span class="ai-stat"><strong>${fmtNum(stats.analyzed ?? 0)}</strong> 篇已解读</span>
        ${stats.pending ? `<span class="ai-stat warn"><strong>${fmtNum(stats.pending)}</strong> 篇待整理</span>` : ''}
        <span class="ai-stat"><strong>${fmtNum(corpus.posts ?? 0)}</strong> 篇帖子</span>
        <span class="ai-stat"><strong>${fmtNum(corpus.replies ?? 0)}</strong> 条回复</span>
        <span class="ai-stat"><strong>${fmtNum(topics.length)}</strong> 个主题</span>
        ${stats.failed ? `<span class="ai-stat warn"><strong>${fmtNum(stats.failed)}</strong> 篇解读失败</span>` : ''}
      </div>
      ${!aiConfigured() ? aiNoticeHtml() : ''}
      ${data.stale && report ? '<div class="ai-stale">论坛内容有更新，这份整理可能已经过时，建议重新整理。</div>' : ''}
    </section>`;

  const qa = `
    <section class="card">
      <div class="card-head"><span class="card-title">💬 问全站</span></div>
      ${aiAskFormHtml({ host: 'ai-site' })}
    </section>`;

  const reportHtml = report
    ? `
    <section class="card">
      <div class="card-head">
        <span class="card-title">🧭 全站知识地图</span>
        <span class="hint">${timeAgo(report.createdAt)}整理 · 覆盖 ${fmtNum(report.postCount)} 篇${report.model ? ` · ${esc(report.model)}` : ''}</span>
      </div>
      ${report.status !== 'done' ? `<div class="ai-error">上次整理失败：${esc(report.error || '未知原因')}</div>` : ''}
      ${report.summary ? `<p class="ai-summary">${esc(report.summary)}</p>` : ''}
      ${
        readingPath.length
          ? `<div class="ai-sub">🚀 推荐阅读路线</div>
             <ol class="ai-path">
               ${readingPath
                 .map(
                   (step) => `
                 <li>
                   <a href="#/post/${step.post.id}">${esc(step.post.title)}</a>
                   ${step.level ? aiChip(step.level, 'diff') : ''}
                   ${step.reason ? `<div class="hint">${esc(step.reason)}</div>` : ''}
                 </li>`,
                 )
                 .join('')}
             </ol>`
          : ''
      }
      ${
        topics.length
          ? `<div class="ai-sub">🗂 主题分组</div>
             <div class="ai-topics">
               ${topics
                 .map(
                   (topic) => `
                 <div class="ai-topic">
                   <div class="ai-topic-head">
                     <span class="ai-topic-name">${esc(topic.name)}</span>
                     ${topic.difficulty ? aiChip(topic.difficulty, 'diff') : ''}
                     ${(topic.prereq ?? []).map((item) => aiChip(`前置：${item}`, 'soft')).join('')}
                     <span class="ai-topic-count">${topic.posts.length} 篇</span>
                   </div>
                   ${topic.summary ? `<div class="hint">${esc(topic.summary)}</div>` : ''}
                   <div class="ai-posts">${topic.posts.map(aiPostLink).join('')}</div>
                 </div>`,
                 )
                 .join('')}
             </div>`
          : `<div class="hint">还没有整理过全站。${isAdmin ? '点上面的「重新整理全站」开始。' : '等管理员整理一次后这里就会显示主题分组。'}</div>`
      }
    </section>`
    : `
    <section class="card">
      <div class="card-head"><span class="card-title">🧭 全站知识地图</span></div>
      ${emptyHtml('🗺', '还没有整理过全站', isAdmin ? '点上方「重新整理全站」，AI 会聚类出主题与阅读路线' : '等管理员整理一次后这里就会显示主题分组')}
    </section>`;

  const listHtml = `
    <section class="card">
      <div class="card-head">
        <span class="card-title">📄 逐篇分类</span>
        <span class="hint">${
          stats.pending
            ? `还有 ${fmtNum(stats.pending)} 篇没整理${isAdmin ? '，可以点上方「⚡ 解读未整理的帖子」批量处理' : ''}`
            : '点开任意帖子即可单独解读'
        }</span>
      </div>
      ${
        posts.length
          ? `<div class="ai-posts wide">${posts
              .map(
                (post) => `
            <div class="ai-post-row">
              <a class="ai-post" href="#/post/${post.id}">
                <span class="ai-post-title">${esc(post.title)}</span>
                <span class="ai-post-meta">${esc(post.board)} · ${esc(post.author)}${post.replyCount ? ` · ${post.replyCount} 条回复` : ''}</span>
                ${post.summary ? `<span class="ai-post-summary">${esc(post.summary)}</span>` : ''}
              </a>
              <div class="ai-post-chips">
                ${
                  post.category
                    ? aiChip(post.category, 'cat')
                    : `<span class="hint">未解读</span>`
                }
                ${post.difficulty ? aiChip(post.difficulty, 'diff') : ''}
              </div>
            </div>`,
              )
              .join('')}</div>`
          : emptyHtml('📭', '还没有帖子', '先去发一篇吧')
      }
    </section>`;

  ui.app.innerHTML = head + qa + reportHtml + listHtml;
}

/* ------------------------------------------------------------------ */
/* 视图：管理后台                                                      */
/* ------------------------------------------------------------------ */

async function viewAdmin() {
  ui.app.innerHTML = loadingHtml();
  if (!state.me) {
    state.redirect = '/admin';
    navigate('/login');
    return;
  }
  if (!isStaffUser(state.me)) {
    ui.app.innerHTML = `<div class="card">${emptyHtml('🚫', '需要管理员权限', '请联系站长为你开通')}</div>`;
    return;
  }

  const { stats, users, recentPosts, hiddenPosts, moderationLogs, viewer } = await api('/api/admin/overview');
  const iAmOwner = Boolean(viewer?.isOwner);
  const statCards = [
    ['用户', stats.users],
    ['帖子', stats.posts],
    ['已隐藏', stats.hiddenPosts ?? hiddenPosts.length],
    ['回复', stats.replies],
    ['评价总数', stats.reactions],
    ['投币总数', stats.coins],
    ['关注关系', stats.follows],
    ['收藏总数', stats.bookmarks],
    ['今日新帖', stats.postsToday],
    ['今日回复', stats.repliesToday],
    ['已封禁', stats.banned],
  ]
    .map(
      ([label, value]) =>
        `<div class="admin-stat"><div class="value">${fmtNum(value)}</div><div class="label">${label}</div></div>`,
    )
    .join('');

  const userRows = users
    .map((user) => {
      const isSelf = user.id === state.me.id;
      const canGrant = iAmOwner && !isSelf && user.role !== 'owner';
      const roleAction = canGrant
        ? user.role === 'admin'
          ? `<button class="btn btn-sm" data-action="set-role" data-id="${user.id}" data-role="member" data-name="${esc(user.displayName)}">收回管理员</button>`
          : `<button class="btn btn-sm btn-primary" data-action="set-role" data-id="${user.id}" data-role="admin" data-name="${esc(user.displayName)}">设为管理员</button>`
        : user.role === 'owner'
          ? '<span class="hint">站长</span>'
          : '';
      const banAction = isSelf || user.role === 'owner'
        ? ''
        : user.banned
          ? `<button class="btn btn-sm" data-action="unban-user" data-id="${user.id}">解封</button>`
          : `<button class="btn btn-sm btn-danger" data-action="ban-user" data-id="${user.id}">封禁</button>`;

      return `
    <tr>
      <td>${avatarHtml(user, 'avatar-sm')} ${esc(user.displayName)} ${roleTag(user.role)}</td>
      <td>@${esc(user.username)}</td>
      <td>${user.postCount}</td>
      <td>${user.replyCount}</td>
      <td>${user.followerCount}</td>
      <td>🪙 ${user.coinBalance}</td>
      <td>${user.banned ? '<span class="tag tag-banned">已封禁</span>' : '<span class="tag">正常</span>'}</td>
      <td>
        <div class="row-actions">
          ${roleAction}
          ${banAction}
          ${isSelf && !roleAction && !banAction ? '<span class="hint">当前账号</span>' : ''}
        </div>
      </td>
    </tr>`;
    })
    .join('');

  const postRows = recentPosts
    .map(
      (post) => `
    <tr>
      <td class="wrap">
        <a href="#/post/${post.id}">${esc(post.title)}</a>
        ${post.hidden ? ' <span class="tag tag-hidden">🙈 已隐藏</span>' : ''}
      </td>
      <td>${esc(post.board)}</td>
      <td>${esc(post.author)}</td>
      <td>${post.views}</td>
      <td>${timeAgo(post.createdAt)}</td>
      <td>
        <div class="row-actions">
          <button class="btn btn-sm" data-action="hide-post" data-id="${post.id}" data-hidden="${post.hidden ? '1' : '0'}" data-back="admin">
            ${post.hidden ? '👁 恢复' : '🙈 隐藏'}
          </button>
          <button class="btn btn-sm btn-danger" data-action="delete-post" data-id="${post.id}" data-back="admin">删除</button>
        </div>
      </td>
    </tr>`,
    )
    .join('');

  const hiddenRows = hiddenPosts.length
    ? hiddenPosts
        .map(
          (post) => `
      <tr>
        <td class="wrap"><a href="#/post/${post.id}">${esc(post.title)}</a></td>
        <td>${esc(post.author)}</td>
        <td>${esc(post.moderator ?? '—')}</td>
        <td>${esc(post.reason || '—')}</td>
        <td>${post.hiddenAt ? timeAgo(post.hiddenAt) : '—'}</td>
        <td><button class="btn btn-sm" data-action="hide-post" data-id="${post.id}" data-hidden="1" data-back="admin">👁 恢复</button></td>
      </tr>`,
        )
        .join('')
    : '<tr><td colspan="6">没有被隐藏的文章</td></tr>';

  const ACTION_LABELS = {
    hide_post: '🙈 隐藏文章',
    unhide_post: '👁 恢复文章',
    delete_post: '🗑 删除文章',
    ban_user: '🚫 封禁用户',
    unban_user: '✅ 解封用户',
    grant_admin: '🛡️ 任命管理员',
    revoke_admin: '↩️ 收回管理员',
  };
  const logRows = moderationLogs.length
    ? moderationLogs
        .map(
          (log) => `
      <tr>
        <td>${esc(log.actor?.displayName ?? '（已注销）')}</td>
        <td>${ACTION_LABELS[log.action] ?? esc(log.action)}</td>
        <td class="wrap">${esc(log.targetLabel || `#${log.targetId}`)}</td>
        <td>${esc(log.reason || '—')}</td>
        <td>${timeAgo(log.createdAt)}</td>
      </tr>`,
        )
        .join('')
    : '<tr><td colspan="5">还没有管理操作记录</td></tr>';

  ui.app.innerHTML = `
    <section class="page-head">
      <h1>🛠️ 管理后台</h1>
      <div class="page-sub">
        你是 <strong>${roleLabel(viewer?.role ?? state.me.role)}</strong>。
        管理团队可以隐藏或删除违规文章；${iAmOwner ? '作为站长，你还可以任命或收回管理员。' : '任命管理员只有站长可以操作。'}
      </div>
    </section>

    <div class="admin-stats">${statCards}</div>

    <section class="card" style="padding:0">
      <div class="card-head" style="padding:16px 18px;margin:0;border-bottom:1px solid var(--border-soft)">
        <span class="card-title">👥 用户管理</span>
        <span class="hint">${iAmOwner ? '站长可以任命管理员' : '只有站长能任命管理员'}</span>
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>用户</th><th>账号</th><th>发帖</th><th>回复</th><th>粉丝</th><th>余额</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>${userRows}</tbody>
        </table>
      </div>
    </section>

    <section class="card" style="padding:0">
      <div class="card-head" style="padding:16px 18px;margin:0;border-bottom:1px solid var(--border-soft)">
        <span class="card-title">🙈 已隐藏的文章（${hiddenPosts.length}）</span>
        <span class="hint">隐藏可逆：访客看到 404，作者仍可查看</span>
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>标题</th><th>作者</th><th>操作人</th><th>原因</th><th>时间</th><th>操作</th></tr></thead>
          <tbody>${hiddenRows}</tbody>
        </table>
      </div>
    </section>

    <section class="card" style="padding:0">
      <div class="card-head" style="padding:16px 18px;margin:0;border-bottom:1px solid var(--border-soft)">
        <span class="card-title">🆕 最近发布</span>
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>标题</th><th>板块</th><th>作者</th><th>浏览</th><th>时间</th><th>操作</th></tr></thead>
          <tbody>${postRows || '<tr><td colspan="6">暂无数据</td></tr>'}</tbody>
        </table>
      </div>
    </section>

    <section class="card" style="padding:0">
      <div class="card-head" style="padding:16px 18px;margin:0;border-bottom:1px solid var(--border-soft)">
        <span class="card-title">📜 管理操作记录</span>
        <span class="hint">隐藏 / 删除 / 封禁 / 任命都会留痕</span>
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>操作人</th><th>动作</th><th>对象</th><th>原因</th><th>时间</th></tr></thead>
          <tbody>${logRows}</tbody>
        </table>
      </div>
    </section>`;
}

/* ------------------------------------------------------------------ */
/* 路由分发                                                            */
/* ------------------------------------------------------------------ */

async function route() {
  const { path, query } = parseHash();
  const parts = path.split('/').filter(Boolean);
  const [first, second] = parts;

  window.scrollTo({ top: 0 });
  closeMenus(); // 换页时收起用户菜单 / 主题菜单
  destroyComposeNotesPanel(); // 换页时销毁写作页的 AI 工作台（见其定义处的说明）
  if (first !== 'board') renderSidebar(null);
  if (first !== 'search') ui.searchInput.value = query.get('q') || '';

  try {
    if (!first) return await viewHome(query);
    if (first === 'board' && second) return await viewBoard(second, query);
    if (first === 'post' && second) return await viewPost(Number(second));
    if (first === 'new') return await viewCompose(null);
    if (first === 'edit' && second) return await viewCompose(Number(second));
    if (first === 'search') return await viewSearch(query);
    if (first === 'bookmarks') return await viewBookmarks(query);
    if (first === 'following') return await viewFollowing();
    if (first === 'checkin') return await viewCheckin();
    if (first === 'ai') return await viewAI();
    if (first === 'graph') return await viewGraph();
    if (first === 'notes') return await viewNotes();
    if (first === 'ranking') return await viewRanking(query);
    if (first === 'settings') return await viewSettings();
    if (first === 'notifications') return await viewNotifications(query);
    if (first === 'messages' && second) return await viewThread(second);
    if (first === 'messages') return await viewMessages();
    if (first === 'u' && second) return await viewUser(second, query);
    if (first === 'login') return await viewAuth('login');
    if (first === 'register') return await viewAuth('register');
    if (first === 'admin') return await viewAdmin();
    ui.app.innerHTML = `<div class="card">${emptyHtml('🧭', '页面不存在', '返回首页继续逛逛')}</div>`;
  } catch (error) {
    ui.app.innerHTML = `<div class="card">${emptyHtml('😵', error.message || '加载失败')}
      <div style="text-align:center"><a class="btn btn-sm" href="#/">返回首页</a></div></div>`;
    toast(error.message, 'error');
  }
}

/* ------------------------------------------------------------------ */
/* 交互                                                                */
/* ------------------------------------------------------------------ */

/** 关闭所有下拉浮层（用户菜单、主题菜单…） */
function closeMenus() {
  for (const menu of document.querySelectorAll('.menu')) menu.hidden = true;
}

const closeMenu = closeMenus;

async function withButtonBusy(button, task) {
  if (!button) return task();
  button.disabled = true;
  try {
    return await task();
  } finally {
    button.disabled = false;
  }
}

document.addEventListener('click', async (event) => {
  const actionNode = event.target.closest('[data-action]');

  if (!actionNode) {
    closeMenus();
    return;
  }
  const action = actionNode.dataset.action;

  // 点菜单内部不关闭，点其它任何地方都收起
  if (!['toggle-menu', 'toggle-theme-menu'].includes(action) && actionNode.closest('.menu') === null) {
    closeMenus();
  }

  try {
    switch (action) {
      case 'toggle-menu': {
        event.preventDefault();
        const userMenu = $('#user-menu');
        if (userMenu) {
          const willOpen = userMenu.hidden;
          closeMenus();
          userMenu.hidden = !willOpen;
        }
        break;
      }
      case 'toggle-theme-menu': {
        event.preventDefault();
        const themeMenu = $('#theme-menu');
        if (themeMenu) {
          const willOpen = themeMenu.hidden;
          closeMenus();
          themeMenu.hidden = !willOpen;
        }
        break;
      }
      case 'set-theme': {
        event.preventDefault();
        applyTheme(actionNode.dataset.theme);
        closeMenus();
        break;
      }
      case 'set-avatar-emoji': {
        if (!requireLogin('登录后才能设置头像')) break;
        const result = await withButtonBusy(actionNode, () =>
          api('/api/me/avatar', {
            method: 'POST',
            body: { type: 'emoji', emoji: actionNode.dataset.emoji, hue: Number(actionNode.dataset.hue) },
          }),
        );
        applyAvatarResult(result);
        toast('头像已更新（预设表情）', 'success');
        break;
      }
      case 'reset-avatar': {
        if (!requireLogin('登录后才能设置头像')) break;
        const result = await withButtonBusy(actionNode, () => api('/api/me/avatar', { method: 'POST', body: { type: 'reset' } }));
        applyAvatarResult(result);
        toast('已恢复默认头像（昵称首字母）', 'success');
        break;
      }
      case 'logout': {
        await api('/api/auth/logout', { method: 'POST' });
        state.me = null;
        state.unread = 0;
        renderUserArea();
        renderSidebar();
        toast('已退出登录', 'success');
        navigate('/');
        break;
      }
      case 'reaction': {
        if (!requireLogin('登录后才能评价')) break;
        const postId = Number(actionNode.dataset.id);
        const kind = actionNode.dataset.kind;
        const result = await withButtonBusy(actionNode, () =>
          api(`/api/posts/${postId}/reaction`, { method: 'POST', body: { kind } }),
        );
        const bar = actionNode.closest('.action-bar');
        const likeButton = bar?.querySelector('[data-action="reaction"][data-kind="like"]');
        const dislikeButton = bar?.querySelector('[data-action="reaction"][data-kind="dislike"]');
        if (likeButton) {
          likeButton.classList.toggle('is-on', result.liked);
          const label = likeButton.querySelector('[data-like-label]');
          if (label) label.textContent = result.liked ? '已赞' : '赞';
          const count = likeButton.querySelector('[data-like-count]');
          if (count) count.textContent = result.likeCount;
        }
        if (dislikeButton) {
          dislikeButton.classList.toggle('is-on-danger', result.disliked);
          const label = dislikeButton.querySelector('[data-dislike-label]');
          if (label) label.textContent = result.disliked ? '已踩' : '踩';
          const count = dislikeButton.querySelector('[data-dislike-count]');
          if (count) count.textContent = result.dislikeCount;
        }
        break;
      }
      case 'checkin': {
        if (!requireLogin('登录后才能签到')) break;
        const result = await withButtonBusy(actionNode, () => api('/api/checkin', { method: 'POST' }));
        state.checkin = result;
        if (state.me) state.me.coinBalance = result.coinBalance;
        renderUserArea();
        renderSidebar();
        const bonusText = result.bonus > 0 ? `，全勤奖 +${result.bonus} 币 🎁` : '';
        toast(`签到成功 +${result.reward} 币${bonusText}，当前 ${result.coinBalance} 币`, 'success');
        const { path } = parseHash();
        if (path === '/checkin') await viewCheckin();
        else if (path === '/settings') await viewSettings();
        break;
      }
      case 'toggle-category-form': {
        event.preventDefault();
        const categoryForm = document.querySelector('form[data-action="create-category"]');
        if (categoryForm) {
          categoryForm.hidden = !categoryForm.hidden;
          if (!categoryForm.hidden) categoryForm.querySelector('input')?.focus();
        }
        break;
      }
      case 'rename-category': {
        const currentName = actionNode.dataset.name;
        const nextName = prompt('重命名分类', currentName);
        if (!nextName || nextName === currentName) break;
        await api(`/api/me/categories/${actionNode.dataset.id}`, { method: 'PUT', body: { name: nextName } });
        toast('分类已重命名', 'success');
        await refreshProfile();
        break;
      }
      case 'delete-category': {
        if (!confirm(`删除分类「${actionNode.dataset.name}」？文章不会被删除，只是回到「未分类」。`)) break;
        await withButtonBusy(actionNode, () => api(`/api/me/categories/${actionNode.dataset.id}`, { method: 'DELETE' }));
        toast('分类已删除，文章回到「未分类」', 'success');
        await refreshProfile();
        break;
      }
      case 'repost-toggle': {
        if (!requireLogin('登录后才能转发')) break;
        const box = document.querySelector('#repost-section textarea[name="comment"]');
        if (!box) {
          toast('这篇文章暂时不能转发', 'error');
          break;
        }
        box.scrollIntoView({ behavior: 'smooth', block: 'center' });
        box.focus();
        break;
      }
      case 'repost-cancel': {
        const repostPostId = Number(actionNode.dataset.id);
        if (!confirm('撤销转发？你主页上的这条转发会消失。')) break;
        await withButtonBusy(actionNode, () => api(`/api/posts/${repostPostId}/repost`, { method: 'DELETE' }));
        toast('已撤销转发', 'success');
        await viewPost(repostPostId);
        break;
      }
      case 'copy-link': {
        const linkPostId = Number(actionNode.dataset.id);
        const shareUrl = `${location.origin}${location.pathname}#/post/${linkPostId}`;
        try {
          await navigator.clipboard.writeText(shareUrl);
          toast('链接已复制，发给朋友吧 🔗', 'success');
        } catch {
          window.prompt('复制这个链接：', shareUrl);
        }
        break;
      }
      case 'profile-pin': {
        const postId = Number(actionNode.dataset.id);
        const wantPinned = actionNode.dataset.pinned !== '1';
        const result = await withButtonBusy(actionNode, () =>
          api(`/api/posts/${postId}/profile-pin`, { method: 'POST', body: { pinned: wantPinned } }),
        );
        toast(wantPinned ? `已置顶推荐（${result.pinnedCount}/${result.pinLimit}）` : '已取消置顶', 'success');
        await refreshProfile();
        break;
      }
      case 'profile-layout': {
        event.preventDefault();
        writePreference('forum:profileLayout', actionNode.dataset.layout);
        await refreshProfile();
        break;
      }
      case 'coin': {        const postId = Number(actionNode.dataset.id);
        // 服务端已经算好能不能投，这里只负责把原因说清楚，绝不留一个「点了没反应」的按钮
        if (actionNode.dataset.coinLocked === '1') {
          if (actionNode.dataset.coinReason === 'anonymous') {
            requireLogin('登录后才能投币');
            break;
          }
          toast(actionNode.dataset.coinHint || '暂时不能投币', 'error');
          break;
        }
        const result = await withButtonBusy(actionNode, () =>
          api(`/api/posts/${postId}/coin`, { method: 'POST', body: { amount: 1 } }),
        );
        if (state.me) state.me.coinBalance = result.balance;

        const count = actionNode.querySelector('[data-coin-count]');
        if (count) count.textContent = result.coinCount;
        const mine = actionNode.querySelector('[data-my-coins]');
        if (mine) mine.innerHTML = ` <span class="tag tag-soft">我投了 ${result.myCoins}</span>`;
        actionNode.classList.add('is-on-coin');

        const bar = actionNode.closest('.action-bar');
        const budget = bar?.querySelector('[data-coin-budget]');
        if (budget) budget.textContent = `可用 ${result.balance} 币`;

        // 达到单帖上限或余额用尽时，把按钮切换成「锁定但可解释」的状态
        const limit = Number(actionNode.dataset.limit ?? result.perPostLimit);
        const hint = bar?.querySelector('.coin-locked-hint');
        if (result.myCoins >= limit) {
          lockCoinButton(actionNode, `这篇帖子你已经投满 ${limit} 币了`, hint);
        } else if (result.balance <= 0) {
          lockCoinButton(actionNode, '币不够了：去「每日签到」领币，或等别人给你的文章投币', hint);
        }

        renderSidebar();
        toast(`投币成功，感谢支持作者！剩余 ${result.balance} 币 🪙`, 'success');
        break;
      }
      case 'bookmark': {
        if (!requireLogin('登录后才能收藏')) break;
        const postId = Number(actionNode.dataset.id);
        const result = await withButtonBusy(actionNode, () =>
          api(`/api/posts/${postId}/bookmark`, { method: 'POST' }),
        );
        actionNode.classList.toggle('is-on', result.bookmarked);
        actionNode.innerHTML = `${result.bookmarked ? '★ 已收藏' : '☆ 收藏'} <span data-bookmark-count>${result.bookmarkCount}</span>`;
        toast(result.bookmarked ? '已加入收藏' : '已取消收藏', 'success');
        break;
      }
      case 'block-user': {
        if (!requireLogin('登录后可以拉黑用户')) break;
        const userId = Number(actionNode.dataset.id);
        const name = actionNode.dataset.name ?? '该用户';
        const willBlock = actionNode.dataset.blocked !== '1';
        if (
          willBlock &&
          !confirm(`拉黑「${name}」？\n\nTA 将无法：关注你、给你发私信、查看你发的文章。\n同时会解除你们之间的关注关系。`)
        ) {
          break;
        }
        const result = await withButtonBusy(actionNode, () =>
          api(`/api/users/${userId}/block`, { method: 'POST', body: { blocked: willBlock } }),
        );
        toast(willBlock ? `已拉黑 ${name}` : `已解除对 ${name} 的拉黑`, 'success');
        void result;
        const { path: currentPath } = parseHash();
        if (currentPath.startsWith('/settings')) await viewSettings();
        else await viewUser(currentUsername(), new URLSearchParams());
        break;
      }
      case 'follow': {
        if (!requireLogin('登录后才能关注作者')) break;
        const userId = Number(actionNode.dataset.user);
        const result = await withButtonBusy(actionNode, () =>
          api(`/api/users/${userId}/follow`, { method: 'POST' }),
        );
        toast(result.following ? `已关注 ${actionNode.dataset.name ?? 'TA'}` : '已取消关注', 'success');
        if (actionNode.classList.contains('btn-primary')) {
          actionNode.classList.toggle('btn-primary', !result.following);
        }
        actionNode.classList.toggle('is-on', result.following);
        actionNode.textContent = result.following ? '✓ 已关注' : '＋ 关注';
        if (document.querySelector('.profile-head')) await viewUser(currentUsername(), new URLSearchParams());
        break;
      }
      case 'open-notification': {
        const id = Number(actionNode.dataset.id);
        if (actionNode.classList.contains('is-unread')) {
          api(`/api/notifications/${id}/read`, { method: 'POST' })
            .then((result) => {
              state.unread = result.unread;
              renderUserArea();
            })
            .catch(() => {});
        }
        break;
      }
      case 'read-notification': {
        const id = Number(actionNode.dataset.id);
        const result = await api(`/api/notifications/${id}/read`, { method: 'POST' });
        state.unread = result.unread;
        actionNode.classList.remove('is-unread');
        actionNode.querySelector('.notif-dot')?.remove();
        renderUserArea();
        break;
      }
      case 'read-all': {
        const result = await api('/api/notifications/read-all', { method: 'POST' });
        state.unread = result.unread ?? 0;
        toast('已全部标为已读', 'success');
        await viewNotifications(parseHash().query);
        break;
      }
      case 'delete-post': {
        if (!confirm('确定删除这个帖子吗？此操作不可撤销。')) break;
        const postId = Number(actionNode.dataset.id);
        await withButtonBusy(actionNode, () => api(`/api/posts/${postId}`, { method: 'DELETE' }));
        toast('帖子已删除', 'success');
        if (actionNode.dataset.back === 'admin') route();
        else navigate('/');
        break;
      }
      case 'delete-reply': {
        if (!confirm('确定删除这条回复吗？')) break;
        await withButtonBusy(actionNode, () => api(`/api/replies/${actionNode.dataset.id}`, { method: 'DELETE' }));
        toast('回复已删除', 'success');
        await viewPost(Number(actionNode.dataset.post));
        break;
      }
      case 'hide-post': {
        if (!state.me || !isStaffUser(state.me)) {
          toast('只有管理团队可以隐藏文章', 'error');
          break;
        }
        const postId = Number(actionNode.dataset.id);
        const willHide = actionNode.dataset.hidden !== '1';
        let reason = '';
        if (willHide) {
          const answer = prompt('隐藏这篇？可以填一个原因（会通知作者，可留空）：', '');
          if (answer === null) break; // 用户取消
          reason = answer.slice(0, 100);
        } else if (!confirm('恢复显示这篇？访客将重新看到它。')) {
          break;
        }
        const result = await withButtonBusy(actionNode, () =>
          api(`/api/admin/posts/${postId}/hide`, { method: 'POST', body: { hidden: willHide, reason } }),
        );
        toast(
          willHide ? `已隐藏，作者会收到通知（当前共隐藏 ${result.hiddenCount} 篇）` : '已恢复显示',
          'success',
        );
        if (actionNode.dataset.back === 'admin') await viewAdmin();
        else await viewPost(postId);
        break;
      }
      case 'set-role': {
        const targetRole = actionNode.dataset.role;
        const targetName = actionNode.dataset.name ?? '该用户';
        const confirmText =
          targetRole === 'admin'
            ? `把「${targetName}」设为管理员？TA 将可以隐藏或删除任何文章。`
            : `收回「${targetName}」的管理员权限？`;
        if (!confirm(confirmText)) break;
        const result = await withButtonBusy(actionNode, () =>
          api(`/api/admin/users/${actionNode.dataset.id}/role`, { method: 'POST', body: { role: targetRole } }),
        );
        toast(
          targetRole === 'admin'
            ? `${targetName} 现在是${roleLabel('admin')}了 🛡️`
            : `已收回 ${targetName} 的管理员权限`,
          'success',
        );
        void result;
        await viewAdmin();
        break;
      }
      case 'ban-user':
      case 'unban-user': {
        const banned = action === 'ban-user';
        const userId = Number(actionNode.dataset.id);
        if (banned && !confirm('封禁该用户？其登录会话会立即失效。')) break;
        await withButtonBusy(actionNode, () =>
          api(`/api/admin/users/${userId}/ban`, { method: 'POST', body: { banned } }),
        );
        toast(banned ? '已封禁该用户' : '已解封', 'success');
        await viewAdmin();
        break;
      }
      case 'ai-analyze': {
        if (!requireLogin('登录后可以让 AI 解读这篇帖子')) break;
        const postId = Number(actionNode.dataset.id);
        const host = actionNode.dataset.host;
        const before = actionNode.textContent;
        actionNode.textContent = '⏳ AI 解读中…';
        try {
          const result = await api(`/api/ai/posts/${postId}/analyze`, { method: 'POST' });
          const hostNode = document.querySelector(`[data-ai-panel="${host}"]`);
          if (hostNode) {
            const stale = hostNode.querySelector('.ai-stale');
            if (stale) stale.remove();
            const old = hostNode.querySelector('.ai-review');
            if (old) old.remove();
            const oldError = hostNode.querySelector('.ai-error');
            if (oldError) oldError.remove();
            const askBlock = hostNode.querySelector('.ai-ask-block');
            askBlock?.insertAdjacentHTML('beforebegin', aiReviewCardHtml(result.review));
            actionNode.textContent = '🔄 重新解读';
          }
          toast('解读完成', 'success');
        } catch (error) {
          actionNode.textContent = before;
          toast(error.message, 'error');
          throw error;
        }
        break;
      }
      case 'ai-analyze-pending': {
        if (!requireLogin('请先登录')) break;
        const before = actionNode.textContent;
        let totalDone = 0;
        let totalFailed = 0;
        try {
          for (let round = 0; round < 40; round += 1) {
            actionNode.textContent = `⏳ 解读中…已 ${totalDone} 篇`;
            const batch = await api('/api/ai/posts/analyze-pending', { method: 'POST', body: { limit: 10 } });
            totalDone += batch.processed;
            totalFailed += batch.failed;
            if (batch.processed === 0 && batch.failed === 0) break;
            if (batch.remaining <= 0) break;
          }
          await viewAI();
          toast(
            totalFailed
              ? `已解读 ${totalDone} 篇，${totalFailed} 篇失败（详情见各帖页面）`
              : `已解读 ${totalDone} 篇`,
            totalFailed ? 'error' : 'success',
          );
        } catch (error) {
          actionNode.textContent = before;
          toast(error.message, 'error');
          throw error;
        }
        break;
      }
      case 'ai-site-analyze': {
        if (!requireLogin('请先登录')) break;
        if (!confirm('重新整理全站？会调用 AI 逐个帖子分析，可能需要十几秒并消耗 token。')) break;
        await withButtonBusy(actionNode, async () => {
          const result = await api('/api/ai/site/analyze', { method: 'POST' });
          toast(`整理完成：${result.topics} 个主题 · ${result.readingPath} 步阅读路线`, 'success');
          await viewAI();
        });
        break;
      }
      case 'preview': {
        event.preventDefault();
        const form = actionNode.closest('form');
        const textarea = form.querySelector('textarea[name="content"]');
        const box = form.querySelector('[data-preview]');
        if (!box || !textarea) break;
        if (!box.hidden) {
          box.hidden = true;
          actionNode.textContent = '预览';
          break;
        }
        const { html } = await api('/api/markdown/preview', { method: 'POST', body: { content: textarea.value } });
        box.innerHTML = `<div class="md">${html || '<span class="hint">（空内容）</span>'}</div>`;
        box.hidden = false;
        actionNode.textContent = '收起预览';
        break;
      }
      case 'md': {
        event.preventDefault();
        const form = actionNode.closest('form');
        const textarea = form.querySelector('textarea[name="content"]');
        applyMarkdown(actionNode.dataset.md, textarea);
        break;
      }
      default:
        break;
    }
  } catch (error) {
    toast(error.message, 'error');
  }
});

function currentUsername() {
  const { path } = parseHash();
  const parts = path.split('/').filter(Boolean);
  return parts[0] === 'u' ? parts[1] : state.me?.username ?? '';
}

/** 重新渲染当前正在浏览的个人主页（保持分类筛选与排版）。 */
async function refreshProfile() {
  const { path, query } = parseHash();
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'u' && parts[1]) await viewUser(parts[1], query);
}

/** 把投币按钮切成「不可用但可点击」的状态：点了会弹出原因，而不是毫无反应。 */
function lockCoinButton(button, message, hintNode) {
  button.dataset.coinLocked = '1';
  button.dataset.coinHint = message;
  button.setAttribute('aria-disabled', 'true');
  button.title = message;
  if (!button.classList.contains('is-locked')) button.classList.add('is-locked');
  if (hintNode) {
    hintNode.textContent = message;
  } else {
    button.insertAdjacentHTML('afterend', `<span class="coin-locked-hint">${esc(message)}</span>`);
  }
}

function applyMarkdown(kind, textarea) {
  if (!textarea) return;
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const value = textarea.value;
  const selected = value.slice(start, end);
  const wrap = (prefix, suffix, placeholder) => {
    const inner = selected || placeholder;
    textarea.value = `${value.slice(0, start)}${prefix}${inner}${suffix}${value.slice(end)}`;
    textarea.focus();
    textarea.setSelectionRange(start + prefix.length, start + prefix.length + inner.length);
  };
  const prefixLines = (template) => {
    const inner = selected || '内容';
    const block = inner
      .split('\n')
      .map((line) => template.replace('$1', line))
      .join('\n');
    textarea.value = `${value.slice(0, start)}${block}${value.slice(end)}`;
    textarea.focus();
    textarea.setSelectionRange(start, start + block.length);
  };

  if (kind === 'bold') wrap('**', '**', '粗体');
  else if (kind === 'italic') wrap('*', '*', '斜体');
  else if (kind === 'code') wrap('`', '`', 'code');
  else if (kind === 'block') wrap('\n```js\n', '\n```\n', '// 在这里写代码');
  else if (kind === 'quote') prefixLines('> $1');
  else if (kind === 'list') prefixLines('- $1');
  else if (kind === 'link') wrap('[', '](https://example.com)', '链接文字');
  else if (kind === 'mention') wrap('@', ' ', 'username');
}

/** 用浏览器把图片等比压缩到 256×256 再转 dataURL，避免上传大图 */
function compressImageFile(file, maxSize = 256) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error('这个文件不是有效的图片'));
      image.onload = () => {
        try {
          const side = Math.min(image.width, image.height);
          const sx = Math.max(0, Math.floor((image.width - side) / 2));
          const sy = Math.max(0, Math.floor((image.height - side) / 2));
          const target = Math.min(maxSize, side);
          const canvas = document.createElement('canvas');
          canvas.width = target;
          canvas.height = target;
          const context = canvas.getContext('2d');
          context.drawImage(image, sx, sy, side, side, 0, 0, target, target);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
          resolve({ dataUrl, size: Math.round((dataUrl.length - 'data:image/jpeg;base64,'.length) * 0.75) });
        } catch (error) {
          reject(error);
        }
      };
      image.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

/** 头像更新后：刷新全局用户状态、顶栏、侧栏与设置页预览 */
function applyAvatarResult(result) {
  if (state.me && result?.user) {
    state.me = { ...state.me, avatar: result.user.avatar, displayName: result.user.displayName };
  }
  renderUserArea();
  renderSidebar();
  const preview = document.querySelector('.avatar-preview');
  if (preview && state.me) {
    preview.innerHTML = `${avatarHtml(state.me, 'avatar-lg')}<span class="hint">当前头像</span>`;
  }
}

document.addEventListener('change', async (event) => {
  const avatarInput = event.target.closest('[data-avatar-input]');
  if (avatarInput) {
    const file = avatarInput.files?.[0];
    avatarInput.value = '';
    if (!file) return;
    if (!state.me) {
      requireLogin('登录后才能上传头像');
      return;
    }
    try {
      toast('正在压缩图片…', 'info');
      const { dataUrl, size } = await compressImageFile(file);
      if (size > 256 * 1024) {
        toast('压缩后仍然超过 256 KB，换张小一点的图片吧', 'error');
        return;
      }
      const result = await api('/api/me/avatar', { method: 'POST', body: { type: 'upload', dataUrl } });
      applyAvatarResult(result);
      toast('头像上传成功 🎉', 'success');
    } catch (error) {
      toast(error.message, 'error');
    }
    return;
  }

  const select = event.target.closest('[data-action="set-category"]');
  if (!select) return;
  try {
    const postId = Number(select.dataset.id);
    const value = select.value;
    const result = await api(`/api/posts/${postId}/category`, {
      method: 'POST',
      body: { categoryId: value === '' ? null : Number(value) },
    });
    toast(result.category ? `已归入「${result.category.name}」` : '已移出分类', 'success');
    await refreshProfile();
  } catch (error) {
    toast(error.message, 'error');
  }
});

document.addEventListener('submit', async (event) => {
  const form = event.target.closest('form[data-action]');
  if (!form) return;
  event.preventDefault();
  const action = form.dataset.action;
  const data = Object.fromEntries(new FormData(form).entries());
  const errorBox = form.querySelector('[data-error]');
  const submitButton = form.querySelector('button[type="submit"]');
  if (errorBox) errorBox.hidden = true;

  const fail = (message) => {
    if (errorBox) {
      errorBox.textContent = message;
      errorBox.hidden = false;
    }
    toast(message, 'error');
  };

  try {
    if (action === 'send-message') {
      const username = form.dataset.username;
      const textarea = form.querySelector('textarea[name="content"]');
      const content = (data.content ?? '').trim();
      if (!content) {
        textarea?.focus();
        return;
      }
      await withButtonBusy(submitButton, () =>
        api(`/api/messages/${encodeURIComponent(username)}`, { method: 'POST', body: { content } }),
      );
      if (textarea) textarea.value = '';
      await viewThread(username);
      await refreshMessageUnread();
      return;
    }

    if (action === 'login' || action === 'register') {
      const payload =
        action === 'login'
          ? { username: data.username, password: data.password }
          : { username: data.username, password: data.password, displayName: data.displayName };
      const result = await withButtonBusy(submitButton, () =>
        api(`/api/auth/${action}`, { method: 'POST', body: payload }),
      );
      await loadSession();
      toast(action === 'login' ? `欢迎回来，${result.user.displayName}` : '注册成功，欢迎加入 🎉', 'success');
      navigate(state.redirect && state.redirect !== '/login' ? state.redirect : '/');
      state.redirect = '/';
      return;
    }

    if (action === 'ai-ask') {
      if (!requireLogin('登录后可以向 AI 提问')) return;
      const question = String(data.question ?? '').trim();
      if (question.length < 2) {
        fail('问题太短了，多写几个字吧');
        return;
      }
      const postId = form.dataset.id ? Number(form.dataset.id) : null;
      const host = form.dataset.host;
      const answerHost = document.querySelector(`[data-ai-panel="${host}"] [data-ai-answer]`) ??
        document.querySelector('[data-ai-answer]');
      if (answerHost) {
        answerHost.hidden = false;
        answerHost.innerHTML = '<div class="ai-loading">🤔 AI 正在读材料并组织回答…</div>';
      }
      try {
        const result = await withButtonBusy(submitButton, () =>
          api('/api/ai/ask', { method: 'POST', body: postId ? { question, postId } : { question } }),
        );
        if (answerHost) answerHost.innerHTML = aiAnswerHtml(result);
      } catch (error) {
        if (answerHost) answerHost.innerHTML = `<div class="ai-error">${esc(error.message)}</div>`;
        else fail(error.message);
      }
      return;
    }

    if (action === 'reply') {
      const postId = Number(form.dataset.id);
      const textarea = form.querySelector('textarea[name="content"]');
      const result = await withButtonBusy(submitButton, () =>
        api(`/api/posts/${postId}/replies`, { method: 'POST', body: { content: textarea.value } }),
      );
      toast('回复成功', 'success');
      await viewPost(postId);
      const node = document.getElementById(`reply-${result.reply.id}`);
      if (node) node.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    if (action === 'compose') {
      const postId = form.dataset.id ? Number(form.dataset.id) : null;
      const body = {
        boardId: Number(data.boardId),
        title: data.title,
        content: data.content,
        categoryId: data.categoryId ? Number(data.categoryId) : null,
        profilePinned: Boolean(data.profilePinned),
      };
      const result = postId
        ? await withButtonBusy(submitButton, () => api(`/api/posts/${postId}`, { method: 'PUT', body }))
        : await withButtonBusy(submitButton, () => api('/api/posts', { method: 'POST', body }));
      await loadSite();
      toast(postId ? '修改已保存' : '发布成功 🎉', 'success');
      navigate(`/post/${result.id}`);
      return;
    }

    if (action === 'repost') {
      const repostPostId = Number(form.dataset.id);
      const result = await withButtonBusy(submitButton, () =>
        api(`/api/posts/${repostPostId}/repost`, { method: 'POST', body: { comment: data.comment ?? '' } }),
      );
      toast(result.updated ? '转发语已更新' : '转发成功，已出现在你的主页 🔁', 'success');
      await viewPost(repostPostId);
      return;
    }

    if (action === 'create-category') {
      const result = await withButtonBusy(submitButton, () =>
        api('/api/me/categories', { method: 'POST', body: { name: data.name } }),
      );
      toast(`分类「${result.category.name}」已创建`, 'success');
      await refreshProfile();
      return;
    }

    if (action === 'save-profile') {
      const result = await withButtonBusy(submitButton, () =>
        api('/api/me/profile', { method: 'POST', body: { displayName: data.displayName, bio: data.bio } }),
      );
      state.me = { ...state.me, displayName: result.user.displayName, bio: result.user.bio };
      renderUserArea();
      toast('个人资料已保存', 'success');
      return;
    }

    if (action === 'change-password') {
      if (data.newPassword !== data.confirmPassword) {
        fail('两次输入的新密码不一致');
        return;
      }
      const result = await withButtonBusy(submitButton, () =>
        api('/api/auth/password', {
          method: 'POST',
          body: { currentPassword: data.currentPassword, newPassword: data.newPassword },
        }),
      );
      form.reset();
      toast(`密码已更新，已下线 ${result.revokedSessions} 个其它会话`, 'success');
      return;
    }
  } catch (error) {
    fail(error.message);
  }
});

ui.searchForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const keyword = ui.searchInput.value.trim();
  navigate(keyword ? `/search?q=${encodeURIComponent(keyword)}` : '/');
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeMenus();
});

/* ------------------------------------------------------------------ */
/* 学术笔记（note-studio）                                             */
/* ------------------------------------------------------------------ */

// 这一页的所有控件都用 id / data-nt-* 就地绑定，不接中央的 data-action 分发，
// 免得动到 check-ui-contract.mjs 盯着的那个 switch（跟知识网络图一个做法）。
const NT_KATEX = {
  css: '/notes/vendor/katex/katex.min.css',
  js: '/notes/vendor/katex/katex.min.js',
  autoRender: '/notes/vendor/katex/contrib/auto-render.min.js',
};
const ntState = { tab: 'mine', mine: [], publicCount: 0, square: [], reading: null, busy: false };
const ntScripts = new Map();

function ntLoadScript(src) {
  if (ntScripts.has(src)) return ntScripts.get(src);
  const task = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`脚本加载失败：${src}`));
    document.head.appendChild(script);
  });
  ntScripts.set(src, task);
  return task;
}

function ntStyleOnce(id, href) {
  if (document.getElementById(id)) return;
  const link = document.createElement('link');
  link.id = id;
  link.rel = 'stylesheet';
  link.href = href;
  document.head.appendChild(link);
}

// 复用 note-studio 自带的离线 KaTeX（就在 /notes/vendor 下），不拉任何 CDN。
async function ntEnsureKatex() {
  ntStyleOnce('nt-katex-css', NT_KATEX.css);
  await ntLoadScript(NT_KATEX.js);
  await ntLoadScript(NT_KATEX.autoRender);
}

function ntRenderMath(root) {
  if (!root) return;
  ntEnsureKatex()
    .then(() => {
      if (typeof window.renderMathInElement === 'function') {
        window.renderMathInElement(root, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '\\[', right: '\\]', display: true },
            { left: '$', right: '$', display: false },
            { left: '\\(', right: '\\)', display: false },
          ],
          throwOnError: false,
        });
      }
    })
    .catch(() => {
      /* KaTeX 没取到就当纯文本看，不影响阅读 */
    });
}

async function ntReload() {
  const [mine, square] = await Promise.all([api('/api/notes-mine'), api('/api/notes-square')]);
  ntState.mine = mine.notes ?? [];
  ntState.publicCount = mine.publicCount ?? ntState.mine.filter((note) => note.public).length;
  ntState.square = square.notes ?? [];
}

async function viewNotes() {
  ui.app.innerHTML = loadingHtml();
  if (!state.me) {
    state.redirect = '/notes';
    navigate('/login');
    return;
  }
  ntState.tab = 'mine';
  ntState.reading = null;
  try {
    await ntReload();
  } catch (error) {
    ui.app.innerHTML = `<div class="card">${emptyHtml('📓', '笔记功能暂时打不开', esc(error.message || '请稍后再试'))}</div>`;
    return;
  }
  ntRender();
}

function ntRender() {
  if (ntState.reading) {
    ntRenderReading();
    return;
  }
  const { mine, square } = ntState;

  const head = `
    <section class="card">
      <div class="card-head">
        <h1 style="font-size:21px">📓 学术笔记</h1>
        <a class="btn btn-sm btn-primary" href="/notes/" target="_blank" rel="noopener">✏️ 打开编辑器</a>
      </div>
      <div class="page-sub">支持 Markdown 与 LaTeX 公式，图片可以转成文字或公式，也有 AI 帮你整理和审阅。笔记默认私密，只有你自己看得到；想分享就点「公开」。</div>
      <div class="nt-stats">
        <span class="nt-stat"><strong>${fmtNum(mine.length)}</strong> 篇我的笔记</span>
        <span class="nt-stat"><strong>${fmtNum(ntState.publicCount)}</strong> 篇已公开</span>
        <span class="nt-stat"><strong>${fmtNum(square.length)}</strong> 篇广场可见</span>
      </div>
    </section>`;

  const tabs = `
    <div class="nt-tabs" id="ntTabs">
      <button class="nt-tab${ntState.tab === 'mine' ? ' is-on' : ''}" type="button" data-nt-tab="mine">📒 我的笔记</button>
      <button class="nt-tab${ntState.tab === 'square' ? ' is-on' : ''}" type="button" data-nt-tab="square">🌐 公开广场${square.length ? ` (${fmtNum(square.length)})` : ''}</button>
    </div>`;

  const list = ntState.tab === 'mine' ? ntMineHtml(mine) : ntSquareHtml(square);
  ui.app.innerHTML = head + tabs + list;
  ntBind();
}

function ntMineHtml(notes) {
  if (!notes.length) {
    return `<section class="card" id="ntList">${emptyHtml(
      '📝',
      '你还没有笔记',
      '点右上角「打开编辑器」写第一篇 —— 新笔记默认是私密的，只有你自己看得到',
    )}</section>`;
  }
  const rows = notes
    .map(
      (note) => `
      <div class="nt-item">
        <div class="nt-item-main">
          <div class="nt-item-title">
            <span>${esc(note.title || note.name)}</span>
            ${note.public ? '<span class="nt-tag is-public">已公开</span>' : '<span class="nt-tag">私密</span>'}
          </div>
          <div class="nt-item-meta">${timeAgo(note.updatedAt)}更新 · ${fmtNum(note.bytes)} 字节${note.public && note.sharedAt ? ` · ${timeAgo(note.sharedAt)}公开` : ''}</div>
        </div>
        <div class="nt-item-actions">
          <button class="btn btn-sm" type="button" data-nt-act="${note.public ? 'unpublish' : 'publish'}" data-nt-name="${esc(note.name)}">${note.public ? '🙈 取消公开' : '🌐 公开'}</button>
          <button class="btn btn-sm btn-danger" type="button" data-nt-act="delete" data-nt-name="${esc(note.name)}">🗑 删除</button>
        </div>
      </div>`,
    )
    .join('');
  return `<section class="card" id="ntList"><div class="nt-list">${rows}</div></section>`;
}

function ntSquareHtml(notes) {
  if (!notes.length) {
    return `<section class="card" id="ntList">${emptyHtml('🌐', '广场上还没有笔记', '大家公开出来的笔记会出现在这里')}</section>`;
  }
  const rows = notes
    .map(
      (note) => `
      <div class="nt-item is-clickable" data-nt-open="1" data-nt-owner="${esc(note.ownerId)}" data-nt-name="${esc(note.name)}">
        <div class="nt-item-main">
          <div class="nt-item-title"><span>${esc(note.title || note.name)}</span></div>
          <div class="nt-item-meta">${esc(note.ownerName || note.ownerId)} · ${timeAgo(note.updatedAt)}更新 · 约 ${fmtNum(note.readingMinutes ?? 1)} 分钟</div>
          ${note.excerpt ? `<div class="nt-excerpt">${esc(note.excerpt)}</div>` : ''}
        </div>
        <div class="nt-item-actions"><span class="nt-open">阅读 →</span></div>
      </div>`,
    )
    .join('');
  return `<section class="card" id="ntList"><div class="nt-list">${rows}</div></section>`;
}

function ntRenderReading() {
  const note = ntState.reading;
  const owner = note.owner?.name || note.owner?.id || '';
  ui.app.innerHTML = `
    <section class="card">
      <div class="card-head">
        <h1 style="font-size:21px">${esc(note.title || note.name)}</h1>
        <button class="btn btn-sm" type="button" id="ntBack">← 返回广场</button>
      </div>
      <div class="page-sub">${esc(owner)} 的公开笔记 · ${timeAgo(note.updatedAt)}更新</div>
    </section>
    <section class="card">
      <article class="md nt-article" id="ntArticle">${note.html || `<p>${esc(note.markdown || '')}</p>`}</article>
    </section>`;
  const back = document.getElementById('ntBack');
  if (back) {
    back.addEventListener('click', () => {
      ntState.reading = null;
      ntRender();
    });
  }
  // note.html 是服务端用 src/markdown.js 渲染的：先全量转义再注入白名单标签，不会带出脚本。
  ntRenderMath(document.getElementById('ntArticle'));
}

function ntBind() {
  const tabs = document.getElementById('ntTabs');
  if (tabs) {
    tabs.addEventListener('click', (event) => {
      const button = event.target.closest('[data-nt-tab]');
      if (!button) return;
      ntState.tab = button.dataset.ntTab === 'square' ? 'square' : 'mine';
      ntRender();
    });
  }
  const list = document.getElementById('ntList');
  if (list) list.addEventListener('click', ntOnListClick);
}

async function ntOnListClick(event) {
  if (ntState.busy) return;

  const open = event.target.closest('[data-nt-open]');
  if (open) {
    await ntOpenNote(open.dataset.ntOwner, open.dataset.ntName);
    return;
  }

  const button = event.target.closest('[data-nt-act]');
  if (!button) return;
  const { ntAct, ntName } = button.dataset;
  const path = `/api/notes/${encodeURIComponent(ntName)}`;

  if (ntAct === 'delete') {
    if (!window.confirm(`确定删掉「${ntName}」吗？删了就找不回来了。`)) return;
    await ntMutate(path, 'DELETE', '笔记已删除');
  } else if (ntAct === 'publish') {
    await ntMutate(`${path}/publish`, 'POST', '已公开，广场上能看到了');
  } else if (ntAct === 'unpublish') {
    await ntMutate(`${path}/unpublish`, 'POST', '已取消公开，别人看不到这篇了');
  }
}

async function ntMutate(path, method, successMessage) {
  ntState.busy = true;
  try {
    await api(path, { method });
    toast(successMessage, 'success');
    await ntReload();
    ntRender();
  } catch (error) {
    toast(error.message || '操作失败', 'error');
  } finally {
    ntState.busy = false;
  }
}

async function ntOpenNote(ownerId, name) {
  ntState.busy = true;
  try {
    const note = await api(`/api/notes-square/${encodeURIComponent(ownerId)}/${encodeURIComponent(name)}`);
    if (!note || !note.html) throw new Error('这篇笔记已经不再公开了');
    ntState.reading = note;
    ntRender();
  } catch (error) {
    toast(error.message || '打不开这篇笔记', 'error');
  } finally {
    ntState.busy = false;
  }
}

/* ------------------------------------------------------------------ */
/* 知识网络图（knowledge-pack）                                        */
/* ------------------------------------------------------------------ */

/*
 * 数据来自 GET /api/knowledge/graph —— 那份 JSON 由 scripts/build-graph.mjs 离线生成
 * （导出语料 → knowledge-pack 算关系网 → 清洗碎片标签）。页面不算图，只负责画出来。
 *
 * 布局用 canvas + 手写力导向，不引第三方库（整个项目零依赖）。斥力/弹簧/阻尼这些
 * 参数照搬 knowledge-pack 自带的 report.mjs，保证和原版 viewer 看起来是一个东西。
 */

const KG_NODE_COLOR = { seed: '#ffb454', document: '#5b8cff', tag: '#43d39e', external: '#6b7a90' };
const KG_EDGE_STYLE = {
  seed_topic: { color: '#ffb454', alpha: 0.72, target: 130, strength: 0.02 },
  similar: { color: '#5b8cff', alpha: 0.34, target: 110, strength: 0.02 },
  explicit_link: { color: '#ffffff', alpha: 0.42, target: 190, strength: 0.02 },
  tagged: { color: '#43d39e', alpha: 0.16, target: 190, strength: 0.004 },
  tag_cooccurrence: { color: '#6b7a90', alpha: 0.3, target: 190, strength: 0.02 },
};
const KG_TYPE_LABEL = { seed: '种子帖', document: '帖子', tag: '标签', external: '范围外文件' };

const kg = {
  nodes: [],
  edges: [],
  byId: new Map(),
  neighbors: new Map(),
  meta: null,
  selected: null,
  hover: null,
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  width: 0,
  height: 0,
  ticks: 0,
  raf: 0,
  canvas: null,
  ctx: null,
  drag: null,
  pan: null,
};

function kgRadius(node) {
  if (node.type === 'seed') return 16;
  if (node.type === 'tag') return 5 + Math.min(9, (node.degree ?? 0) * 0.5);
  return 6 + Math.min(14, (node.relevance ?? 0) * 42 + (node.degree ?? 0) * 0.3);
}

/** 初始摆位：撒在一个圆环上，让力导向自己去收敛（比全堆在中心快）。 */
function kgLayout() {
  const cx = kg.width / 2;
  const cy = kg.height / 2;
  const radius = Math.min(kg.width, kg.height) * 0.34;
  kg.nodes.forEach((node, index) => {
    const angle = (index / Math.max(1, kg.nodes.length)) * Math.PI * 2;
    const jitter = 0.65 + Math.random() * 0.5;
    node.x = cx + Math.cos(angle) * radius * jitter;
    node.y = cy + Math.sin(angle) * radius * jitter;
    node.vx = 0;
    node.vy = 0;
  });
  kg.ticks = 0;
}

function kgResize() {
  const canvas = kg.canvas;
  if (!canvas) return;
  const rect = canvas.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  kg.width = Math.max(320, Math.round(rect.width));
  kg.height = Math.max(320, Math.round(rect.height));
  canvas.width = Math.round(kg.width * dpr);
  canvas.height = Math.round(kg.height * dpr);
  canvas.style.width = `${kg.width}px`;
  canvas.style.height = `${kg.height}px`;
  kg.ctx = canvas.getContext('2d');
  kg.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (!kg.nodes.some((node) => Number.isFinite(node.x))) kgLayout();
}

/** 一帧物理：向心 + 两两斥力 + 边的弹簧 + 阻尼（参数与原版 viewer 一致）。 */
function kgStep() {
  const { nodes, edges } = kg;
  const repulsion = 0.00035 * (kg.width + kg.height);
  const cx = kg.width / 2;
  const cy = kg.height / 2;

  for (const node of nodes) {
    node.vx += (cx - node.x) * 0.0004;
    node.vy += (cy - node.y) * 0.0004;
  }

  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i];
      const b = nodes[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      let distSq = dx * dx + dy * dy;
      if (distSq > 90000) continue;
      if (distSq < 1) distSq = 1;
      const force = (repulsion * 90) / distSq;
      const dist = Math.sqrt(distSq) || 1;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      a.vx -= fx;
      a.vy -= fy;
      b.vx += fx;
      b.vy += fy;
    }
  }

  for (const edge of edges) {
    const style = KG_EDGE_STYLE[edge.type] ?? KG_EDGE_STYLE.tag_cooccurrence;
    const a = kg.byId.get(edge.from);
    const b = kg.byId.get(edge.to);
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const delta = (dist - style.target) * style.strength;
    const fx = (dx / dist) * delta;
    const fy = (dy / dist) * delta;
    a.vx += fx;
    a.vy += fy;
    b.vx -= fx;
    b.vy -= fy;
  }

  for (const node of nodes) {
    node.vx *= 0.72;
    node.vy *= 0.72;
    node.vx = Math.max(-18, Math.min(18, node.vx));
    node.vy = Math.max(-18, Math.min(18, node.vy));
    node.x += node.vx;
    node.y += node.vy;
  }
  kg.ticks += 1;
}

/** 当前高亮的是谁：选中的节点，否则鼠标悬停的节点。 */
function kgFocus() {
  return kg.selected ?? kg.hover;
}

function kgIsDim(node) {
  const focus = kgFocus();
  if (!focus || node.id === focus.id) return false;
  return !(kg.neighbors.get(focus.id)?.has(node.id) ?? false);
}

function kgToWorld(clientX, clientY) {
  const rect = kg.canvas.getBoundingClientRect();
  return {
    x: (clientX - rect.left - kg.offsetX) / kg.scale,
    y: (clientY - rect.top - kg.offsetY) / kg.scale,
  };
}

function kgNodeAt(worldX, worldY) {
  for (let i = kg.nodes.length - 1; i >= 0; i -= 1) {
    const node = kg.nodes[i];
    const radius = kgRadius(node) + 4;
    const dx = worldX - node.x;
    const dy = worldY - node.y;
    if (dx * dx + dy * dy <= radius * radius) return node;
  }
  return null;
}

function kgDraw() {
  const ctx = kg.ctx;
  if (!ctx) return;
  ctx.clearRect(0, 0, kg.width, kg.height);
  ctx.save();
  ctx.translate(kg.offsetX, kg.offsetY);
  ctx.scale(kg.scale, kg.scale);

  for (const edge of kg.edges) {
    const style = KG_EDGE_STYLE[edge.type] ?? KG_EDGE_STYLE.tag_cooccurrence;
    const a = kg.byId.get(edge.from);
    const b = kg.byId.get(edge.to);
    if (!a || !b) continue;
    const dim = kgIsDim(a) && kgIsDim(b);
    ctx.globalAlpha = dim ? style.alpha * 0.25 : style.alpha;
    ctx.strokeStyle = style.color;
    ctx.lineWidth = (edge.weight ?? 1) > 2 ? 1.6 : 1;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  for (const node of kg.nodes) {
    const radius = kgRadius(node);
    const dim = kgIsDim(node);
    const focused = kgFocus()?.id === node.id;
    ctx.globalAlpha = dim ? 0.22 : 1;
    ctx.beginPath();
    ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = KG_NODE_COLOR[node.type] ?? '#6b7a90';
    ctx.fill();
    if (focused) {
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
    }
    if (kg.scale > 0.55) {
      ctx.globalAlpha = dim ? 0.25 : 0.92;
      ctx.fillStyle = kgPalette.text;
      ctx.font = `${node.type === 'tag' ? 11 : 12}px ${kgPalette.font}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(node.label, node.x, node.y + radius + 3);
    }
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

/** 主题切换时重新取色（画布不会自己跟着 CSS 变量变）。 */
const kgPalette = { text: '#e8eef7', font: 'sans-serif' };
function kgRefreshPalette() {
  const style = getComputedStyle(document.documentElement);
  kgPalette.text = style.getPropertyValue('--text').trim() || '#e8eef7';
  kgPalette.font = style.getPropertyValue('--font').trim() || 'sans-serif';
}

function kgStop() {
  if (kg.raf) cancelAnimationFrame(kg.raf);
  kg.raf = 0;
}

/** 主循环：前 600 帧算布局，之后只重画（跟原版一样，避免一直抖）。 */
function kgLoop() {
  if (!kg.canvas || !kg.canvas.isConnected) {
    kgStop();
    return;
  }
  if (kg.ticks < 600) kgStep();
  kgDraw();
  kg.raf = requestAnimationFrame(kgLoop);
}

function kgNeighbors() {
  kg.neighbors = new Map(kg.nodes.map((node) => [node.id, new Set()]));
  for (const edge of kg.edges) {
    kg.neighbors.get(edge.from)?.add(edge.to);
    kg.neighbors.get(edge.to)?.add(edge.from);
  }
}

function kgPanelHtml() {
  const focus = kgFocus();
  if (!focus) {
    const meta = kg.meta ?? {};
    const seed = meta.seed ?? {};
    const keywords = (meta.seedKeywords ?? []).map((item) => `<span class="kg-chip is-static">${esc(item.term)}</span>`).join('');
    return `
      <div class="kg-panel-title">🧭 关于这张图</div>
      <p class="kg-hint">每篇帖子是一个蓝点，标签是绿点，橙色大点是你选的主题（种子帖）。离种子越近、相关度越高，连线越亮。</p>
      <div class="kg-row"><span>主题</span><strong>${esc(seed.title ?? '—')}</strong></div>
      <div class="kg-row"><span>板块</span><strong>${esc(seed.board ?? '—')}</strong></div>
      ${keywords ? `<div class="kg-sub">主题词</div><div class="kg-chips">${keywords}</div>` : ''}
      <p class="kg-hint">点一个点看它的详情；点标签可以只留下它的邻居；点帖子会直接跳过去。</p>`;
  }
  const meta = kg.byId.get(focus.id) ?? {};
  const isPost = focus.type === 'document' || focus.type === 'seed';
  const neighbors = kg.neighbors.get(focus.id) ?? new Set();
  const rows = [
    `<div class="kg-row"><span>类型</span><strong>${esc(KG_TYPE_LABEL[focus.type] ?? focus.type)}</strong></div>`,
    `<div class="kg-row"><span>连线</span><strong>${neighbors.size} 条</strong></div>`,
  ];
  if (isPost) {
    if (focus.relevance != null) rows.push(`<div class="kg-row"><span>相关度</span><strong>${(focus.relevance * 100).toFixed(1)}%</strong></div>`);
    if (focus.confidence) rows.push(`<div class="kg-row"><span>置信度</span><strong>${esc(focus.confidence)}</strong></div>`);
    if (focus.board) rows.push(`<div class="kg-row"><span>板块</span><strong>${esc(focus.board)}</strong></div>`);
  }
  return `
    <div class="kg-panel-title">${esc(focus.label)}</div>
    ${rows.join('')}
    ${
      isPost && focus.postId != null
        ? `<a class="btn btn-sm btn-primary kg-open" href="#/post/${focus.postId}">打开这篇帖子</a>`
        : '<p class="kg-hint">点空白处可以取消选择。</p>'
    }`;
}

function kgRenderPanel() {
  const panel = document.getElementById('kg-panel');
  if (panel) panel.innerHTML = kgPanelHtml();
}

function kgBind() {
  const canvas = kg.canvas;
  if (!canvas) return;

  canvas.addEventListener('pointerdown', (event) => {
    const world = kgToWorld(event.clientX, event.clientY);
    const node = kgNodeAt(world.x, world.y);
    canvas.setPointerCapture(event.pointerId);
    if (node) {
      kg.selected = kg.selected?.id === node.id ? null : node;
      kg.drag = node;
    } else {
      kg.pan = { x: event.clientX - kg.offsetX, y: event.clientY - kg.offsetY };
    }
    kgRenderPanel();
  });

  canvas.addEventListener('pointermove', (event) => {
    if (kg.drag) {
      const world = kgToWorld(event.clientX, event.clientY);
      kg.drag.x = world.x;
      kg.drag.y = world.y;
      kg.drag.vx = 0;
      kg.drag.vy = 0;
      return;
    }
    if (kg.pan) {
      kg.offsetX = event.clientX - kg.pan.x;
      kg.offsetY = event.clientY - kg.pan.y;
      return;
    }
    const world = kgToWorld(event.clientX, event.clientY);
    const node = kgNodeAt(world.x, world.y);
    canvas.style.cursor = node ? 'pointer' : 'grab';
    if ((node?.id ?? null) !== (kg.hover?.id ?? null)) {
      kg.hover = node;
      kgRenderPanel();
    }
  });

  const endDrag = (event) => {
    if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    kg.drag = null;
    kg.pan = null;
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    const factor = event.deltaY < 0 ? 1.12 : 0.89;
    const next = Math.max(0.2, Math.min(4, kg.scale * factor));
    // 以鼠标位置为锚点缩放
    kg.offsetX = px - ((px - kg.offsetX) * next) / kg.scale;
    kg.offsetY = py - ((py - kg.offsetY) * next) / kg.scale;
    kg.scale = next;
  }, { passive: false });

  const refit = document.getElementById('kgRefit');
  if (refit) refit.onclick = () => {
    kg.scale = 1;
    kg.offsetX = 0;
    kg.offsetY = 0;
  };
  const relayout = document.getElementById('kgRelayout');
  if (relayout) relayout.onclick = () => {
    kgLayout();
    kgDraw();
  };
  const clear = document.getElementById('kgClear');
  if (clear) clear.onclick = () => {
    kg.selected = null;
    kgRenderPanel();
  };
}

function kgTagChipsHtml() {
  return kg.nodes
    .filter((node) => node.type === 'tag')
    .sort((a, b) => (b.degree ?? 0) - (a.degree ?? 0))
    .map((node) => `<button class="kg-chip" type="button" data-kg-tag="${esc(node.id)}">${esc(node.label)}</button>`)
    .join('');
}

function renderGraphPage(payload) {
  const { graph, status } = payload;
  const stats = graph.stats ?? {};
  kg.meta = graph;
  kg.nodes = (graph.nodes ?? []).map((node) => ({ ...node }));
  kg.edges = graph.edges ?? [];
  kg.byId = new Map(kg.nodes.map((node) => [node.id, node]));
  kgNeighbors();
  kg.selected = null;
  kg.hover = null;

  ui.app.innerHTML = `
    <section class="card">
      <div class="card-head">
        <h1 style="font-size:21px">🕸 知识网络图</h1>
        <div class="kg-actions">
          <button class="btn btn-sm" type="button" id="kgRefit">🎯 回到中心</button>
          <button class="btn btn-sm" type="button" id="kgRelayout">🔄 重新布局</button>
          <button class="btn btn-sm" type="button" id="kgClear">✖ 取消选择</button>
          <a class="btn btn-sm" href="/api/knowledge/viewer" target="_blank" rel="noopener">↗ 打开原版大图</a>
        </div>
      </div>
      <div class="page-sub">
        把论坛的帖子按「内容相近 / 被互相引用 / 共用标签」连成一张网，方便顺着线索往下读。
        这张图是离线的：点了「重新布局」只是重画，不会重新计算。
      </div>
      <div class="kg-stats">
        <span class="kg-stat"><strong>${fmtNum(stats.posts ?? 0)}</strong> 篇帖子</span>
        <span class="kg-stat"><strong>${fmtNum(stats.tags ?? 0)}</strong> 个标签</span>
        <span class="kg-stat"><strong>${fmtNum(stats.nodes ?? 0)}</strong> 个节点</span>
        <span class="kg-stat"><strong>${fmtNum(stats.edges ?? 0)}</strong> 条连线</span>
        <span class="kg-stat"><strong>${fmtNum(stats.communities ?? 0)}</strong> 个聚类</span>
      </div>
      ${status?.error ? `<div class="kg-warn">上次生成时出错：${esc(status.error)}</div>` : ''}
    </section>

    <section class="card kg-card">
      <div class="kg-wrap">
        <canvas id="kg-canvas"></canvas>
        <aside class="kg-panel" id="kg-panel"></aside>
      </div>
      <div class="kg-legend">
        ${Object.entries(KG_TYPE_LABEL)
          .map(
            ([type, label]) =>
              `<span class="kg-legend-item"><i style="background:${KG_NODE_COLOR[type]}"></i>${esc(label)}</span>`,
          )
          .join('')}
        <span class="kg-hint">滚轮缩放 · 拖空白平移 · 拖节点挪位置</span>
      </div>
      <div class="kg-sub">点标签筛选</div>
      <div class="kg-chips" id="kg-tags">${kgTagChipsHtml()}</div>
    </section>`;

  kg.canvas = document.getElementById('kg-canvas');
  if (!kg.canvas || !kg.nodes.length) return;
  kgRefreshPalette();
  kgResize();
  kgLayout();
  kgRenderPanel();
  kgBind();

  const tags = document.getElementById('kg-tags');
  if (tags) {
    tags.addEventListener('click', (event) => {
      const button = event.target.closest('[data-kg-tag]');
      if (!button) return;
      const node = kg.byId.get(button.dataset.kgTag);
      kg.selected = kg.selected?.id === node?.id ? null : node ?? null;
      kgRenderPanel();
      kgDraw();
    });
  }

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      kgResize();
      kgDraw();
    }, 150);
  });

  kgStop();
  kgLoop();
}

async function viewGraph() {
  ui.app.innerHTML = loadingHtml();
  let payload;
  try {
    payload = await api('/api/knowledge/graph');
  } catch (error) {
    ui.app.innerHTML = `
      <div class="card">
        ${emptyHtml('🕸', '知识网络图还没有生成', '管理员跑一次 node scripts/build-graph.mjs 就能看到')}
        <div style="text-align:center"><a class="btn btn-sm" href="#/">返回首页</a></div>
      </div>`;
    return;
  }
  renderGraphPage(payload);
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

async function bootstrap() {
  // 首屏再套用一次本地主题（index.html 里的内联脚本已经先设过，避免闪烁），
  // 并监听系统配色变化，让「跟随系统」实时生效。
  applyTheme(readPreference(THEME_STORAGE_KEY, 'dark'), { silent: true, persist: false });
  if (typeof window.matchMedia === 'function') {
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const onSystemThemeChange = () => {
      if (state.theme === 'auto') applyTheme('auto', { silent: true, persist: false });
    };
    if (typeof media.addEventListener === 'function') media.addEventListener('change', onSystemThemeChange);
    else if (typeof media.addListener === 'function') media.addListener(onSystemThemeChange);
  }

  renderUserArea();
  await loadSite();
  await loadSession();
  renderSidebar();
  window.addEventListener('hashchange', route);
  await route();
  setInterval(refreshUnread, 60000);
}

bootstrap();
