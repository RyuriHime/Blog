// hash 路由：#/board/tech?page=2 这一套。
// 
// 三条硬约定：
//   1) 页面地址是**对外契约**（收藏夹、通知里的链接），新增页面只能加不能改；
//   2) 未登录访问需要登录的页面时，先跳 #/login 并把原地址记进 state.redirect；
//   3) 每个 viewXxx 自己负责把 ui.app.innerHTML 填好，route() 不兜底。

import { $, emptyHtml, toast, ui } from './dom.js';
import * as Admin from '../views/admin.js';
import * as Ai from '../views/ai.js';
import * as Auth from '../views/auth.js';
import * as Checkin from '../views/checkin.js';
import * as Compose from '../views/compose.js';
import * as Events from './events.js';
import * as Feed from '../views/feed.js';
import * as Graph from '../views/graph.js';
import * as Message from '../views/messages.js';
import * as Notes from '../views/notes.js';
import * as Notif from '../views/notifications.js';
import * as Post from '../views/post.js';
import * as Session from './session.js';
import * as Settings from '../views/settings.js';
import * as User from '../views/user.js';

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
async function route() {
  const { path, query } = parseHash();
  const parts = path.split('/').filter(Boolean);
  const [first, second] = parts;

  window.scrollTo({ top: 0 });
  Events.closeMenus(); // 换页时收起用户菜单 / 主题菜单
  Compose.destroyComposeNotesPanel(); // 换页时销毁写作页的 AI 工作台（见其定义处的说明）
  if (first !== 'board') Session.renderSidebar(null);
  if (first !== 'search') ui.searchInput.value = query.get('q') || '';

  try {
    if (!first) return await Feed.viewHome(query);
    if (first === 'board' && second) return await Feed.viewBoard(second, query);
    if (first === 'post' && second) return await Post.viewPost(Number(second));
    if (first === 'new') return await Compose.viewCompose(null);
    if (first === 'edit' && second) return await Compose.viewCompose(Number(second));
    if (first === 'search') return await Feed.viewSearch(query);
    if (first === 'bookmarks') return await Feed.viewBookmarks(query);
    if (first === 'following') return await Feed.viewFollowing();
    if (first === 'checkin') return await Checkin.viewCheckin();
    if (first === 'ai') return await Ai.viewAI();
    if (first === 'graph') return await Graph.viewGraph();
    if (first === 'notes') return await Notes.viewNotes();
    if (first === 'ranking') return await User.viewRanking(query);
    if (first === 'settings') return await Settings.viewSettings();
    if (first === 'notifications') return await Notif.viewNotifications(query);
    if (first === 'messages' && second) return await Message.viewThread(second);
    if (first === 'messages') return await Message.viewMessages();
    if (first === 'u' && second) return await User.viewUser(second, query);
    if (first === 'login') return await Auth.viewAuth('login');
    if (first === 'register') return await Auth.viewAuth('register');
    if (first === 'admin') return await Admin.viewAdmin();
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

// ── 导出 ──────────────────────────────────────────────────────────────
export { route };
export { parseHash };
export { navigate };
export { routeQuery };

/* @hand-written */
