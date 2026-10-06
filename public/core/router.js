// hash 路由：#/board/tech?page=2 这一套。
// 
// 三条硬约定：
//   1) 页面地址是**对外契约**（收藏夹、通知里的链接），新增页面只能加不能改；
//   2) 未登录访问需要登录的页面时，先跳 #/login 并把原地址记进 state.redirect；
//   3) 每个 viewXxx 自己负责把 ui.app.innerHTML 填好，route() 不兜底。

import { $, emptyHtml, toast, ui } from './dom.js';
import * as Admin from '../views/admin.js';
import * as Ai from '../views/ai.js';
import * as AiEdit from '../views/ai-edit.js';
import * as Auth from '../views/auth.js';
import * as Checkin from '../views/checkin.js';
import * as Compose from '../views/compose.js';
import * as Doc from '../views/doc.js';
import * as Events from './events.js';
import * as Feed from '../views/feed.js';
import * as Graph from '../views/graph.js';
import * as Message from '../views/messages.js';
import * as Notes from '../views/notes.js';
import * as Notif from '../views/notifications.js';
import * as Post from '../views/post.js';
import * as Session from './session.js';
import * as Settings from '../views/settings.js';
import * as Timeline from '../views/timeline.js';
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
  // 换页时也把动态的「全屏编辑」解开 —— 否则用户在展开状态下点了别的链接，
  // body 上那条 overflow:hidden 会跟着过去，整个新页面滚不动（查起来极其费解）。
  document.body.classList.remove('feed-fullscreen');
  Compose.destroyComposeNotesPanel(); // 换页时销毁写作页的 AI 工作台（见其定义处的说明）
  Session.renderSidebar();
  if (first !== 'search') ui.searchInput.value = query.get('q') || '';

  try {
    // v2：首页是**动态**时间线，不再是「板块 + 帖子列表」。
    if (!first) return await Timeline.viewTimeline(query);
    // 论坛形态下线（FR-FEED-12）：板块页没有替代页面，但**也不能变成死链**，
    // 统一回首页。`replace` 而不是赋值，免得用户按返回又弹回来。
    if (first === 'board') {
      toast('板块已经下线了，这里是新的动态首页', 'info');
      location.replace('#/');
      return await Timeline.viewTimeline(query);
    }
    // 搜索框搜的是动态（论坛没了，搜索的主要对象也就跟着变了）
    if (first === 'search') return await Timeline.viewTimeline(query);
    // 「关注流」并进动态流的一个筛选，不再单独占一个页面
    if (first === 'following') return await Timeline.viewTimeline(new URLSearchParams({ filter: 'following' }));
    if (first === 'post' && second) return await Post.viewPost(Number(second));
    if (first === 'new') return await Compose.viewCompose(null);
    if (first === 'edit' && second) return await Compose.viewCompose(Number(second));
    if (first === 'bookmarks') return await Feed.viewBookmarks(query);
    if (first === 'checkin') return await Checkin.viewCheckin();
    if (first === 'ai') return await Ai.viewAI();
    // AI 编辑台（P3）：能力授权 / 按块改写 / 审计与回滚。
    // 数据在 /api/ai-edit/*，**不是** /api/ai/* —— 那一段被 forum-ai 挂载层短路了。
    if (first === 'ai-edit') return await AiEdit.viewAiEdit();
    if (first === 'graph') return await Graph.viewGraph();
    if (first === 'notes') return await Notes.viewNotes();
    // 积木（v2 可编程帖子）：`/doc/:id/edit` 与 `/doc/:id/blocks` 必须排在
    // `/doc/:id` 前面，否则编辑页会被当成 id 是 "…/edit" 的文档（parts 里第三段会被丢掉）。
    // 两个入口进的是同一个编辑器，只是默认落在哪个模式上；`?mode=markdown` 可覆盖。
    if (first === 'docs') return await Doc.viewDocs(query);
    if (first === 'blocks') return await Doc.viewBlocks();
    if (first === 'doc' && second && parts[2] === 'edit') return await Doc.viewDocEdit(Number(second), query);
    if (first === 'doc' && second && parts[2] === 'blocks') return await Doc.viewDocEdit(Number(second), query);
    if (first === 'doc' && second) return await Doc.viewDoc(Number(second));
    // Wiki 多页面：`[[双链]]` 指向 `#/wiki/<标题>`，没建过的页就在那里建。
    // 不再 `decodeURIComponent` —— `parseHash` 已经把整条 hash 解过一次了，
    // 再解一次会把标题里本来就有的 `%` 吃掉。标题里的 `/` 用 join 兜住。
    if (first === 'wiki' && second) return await Doc.viewWiki(parts.slice(1).join('/'), query);
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
