// hash 路由：#/board/tech?page=2 这一套。
// 
// 三条硬约定：
//   1) 页面地址是**对外契约**（收藏夹、通知里的链接），新增页面只能加不能改；
//   2) 未登录访问需要登录的页面时，先跳 #/login 并把原地址记进 state.redirect；
//   3) 每个 viewXxx 自己负责把 ui.app.innerHTML 填好，route() 不兜底。

import { $, emptyHtml, toast, ui } from './dom.js';
import { apiErrorText } from './errors.js';
import { state } from './state.js';
import * as Admin from '../views/admin.js';
import * as Ai from '../views/ai.js';
import * as AiEdit from '../views/ai-edit.js';
import * as Auth from '../views/auth.js';
import * as Compose from '../views/compose.js';
import * as Doc from '../views/doc.js';
import * as Events from './events.js';
import * as Feed from '../views/feed.js';
import * as Guide from '../views/guide.js';
import * as Message from '../views/messages.js';
import * as Notes from '../views/notes.js';
import * as Notif from '../views/notifications.js';
import * as Post from '../views/post.js';
import { beginRoute, endRoute } from './route-guard.js';
import * as Session from './session.js';
import * as Settings from '../views/settings.js';
import * as Start from '../views/start.js';
import * as Team from '../views/team.js';
import * as Timeline from '../views/timeline.js';
import * as User from '../views/user.js';

/**
 * P5：本次页面加载里，动态首页（#/）有没有被访问过。
 * 只用来判断「未登录的人是不是刚打开站点」—— 见 route() 里 !first 那一段。
 */
let homeSeen = false;

function parseHash() {
  const raw = location.hash.replace(/^#/, '');
  // 只解码**路径**，查询串原样交给 URLSearchParams —— 整条 hash 一起 decodeURIComponent
  // 会先把查询串里 `+` 的编码 `%2B` 还原成 `+`，接着被 URLSearchParams 当成空格，
  // 于是搜「C++」真正搜的是「C  」。查询串的解码是 URLSearchParams 自己的活。
  const [rawPath = '', queryString = ''] = (raw || '/').split('?');
  let path = rawPath;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    path = rawPath;
  }
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

  // 标记新页面：这一轮之前发出的请求，回来时会被 api() 判为过期并丢弃（见 route-guard.js）
  beginRoute();

  window.scrollTo({ top: 0 });
  Events.closeMenus(); // 换页时收起用户菜单 / 主题菜单
  // 换页时也把动态的「全屏编辑」解开 —— 否则用户在展开状态下点了别的链接，
  // body 上那条 overflow:hidden 会跟着过去，整个新页面滚不动（查起来极其费解）。
  document.body.classList.remove('feed-fullscreen');
  // 同理：wiki 站页面会把论坛侧栏让开（`body.doc-wide`），换页时先摘掉，
  // 由积木的阅读页在真的需要时再加回来 —— 不然离开 wiki 之后首页也少一栏。
  document.body.classList.remove('doc-wide');
  Compose.destroyComposeNotesPanel(); // 换页时销毁写作页的 AI 工作台（见其定义处的说明）
  Session.renderSidebar();
  if (first !== 'search') ui.searchInput.value = query.get('q') || '';

  try {
    // v2：首页是**动态**时间线，不再是「板块 + 帖子列表」。
    //
    // P5：未登录的人**第一次**落在 #/ 时先看起始页（左公告 + 右三块入口）。
    //   为什么要分「第一次」：起始页上那块「动态」指向的就是 #/，
    //   要是每次 #/ 都转走，点「动态」会立刻被弹回起始页 —— 死循环一样的体验。
    //   只认不带查询串的 #/；`#/?filter=mine` 这类筛选照常进动态流。
    if (!first) {
      const firstHomeVisit = !homeSeen;
      homeSeen = true;
      if (firstHomeVisit && !state.me && !query.toString()) {
        location.replace('#/start');
        return await Start.viewStart();
      }
      return await Timeline.viewTimeline(query);
    }
    // 论坛形态下线（FR-FEED-12）：板块页没有替代页面，但**也不能变成死链**，
    // 统一回首页。`replace` 而不是赋值，免得用户按返回又弹回来。
    if (first === 'board') {
      toast('板块已经下线了，这里是新的动态首页', 'info');
      location.replace('#/');
      return await Timeline.viewTimeline(query);
    }
    // 搜索框搜的是动态（论坛没了，搜索的主要对象也就跟着变了）
    if (first === 'search') return await Timeline.viewTimeline(query);
    // `#/following` 是「我关注的人」**名单**（`public/views/feed.js` 的 viewFollowing：
    // 头像 + 昵称 + 一键取关）。关注**流**（只看 TA 们发的动态）是动态流的一个筛选，
    // 走 `#/?filter=following`。两件事别再并成一个 ——
    // 并了之后名单页就没了入口（函数还在，只是没有任何地址能到达），
    // 于是「我到底关注了谁」反而没地方看。这个坑真踩过。
    if (first === 'following') return await Feed.viewFollowing();
    if (first === 'post' && second) return await Post.viewPost(Number(second));
    if (first === 'new') return await Compose.viewCompose(null);
    if (first === 'edit' && second) return await Compose.viewCompose(Number(second));
    if (first === 'bookmarks') return await Feed.viewBookmarks(query);
    if (first === 'ai') return await Ai.viewAI();
    // AI 编辑台（P3）：能力授权 / 按块改写 / 审计与回滚。
    // 数据在 /api/ai-edit/*，**不是** /api/ai/* —— 那一段被 forum-ai 挂载层短路了。
    // （P5 的顶栏快捷入口原本还有一个 `#/graph`，知识网络图整条删除后一并去掉了。）
    if (first === 'ai-edit') return await AiEdit.viewAiEdit();
    if (first === 'notes') return await Notes.viewNotes();
    // 积木（v2 可编程帖子）：`/doc/:id/edit` 与 `/doc/:id/blocks` 必须排在
    // `/doc/:id` 前面，否则编辑页会被当成 id 是 "…/edit" 的文档（parts 里第三段会被丢掉）。
    // 两个入口进的是同一个编辑器，只是默认落在哪个模式上；`?mode=markdown` 可覆盖。
    if (first === 'docs') return await Doc.viewDocs(query);
    // `#/blocks` 是块类型表的老地址（README、侧栏、doc-smoke 都还引用它）——
    // 它和 `#/dev` 进的是同一页：块类型表挪进了「开发者功能」，页面本身没下线。
    if (first === 'blocks') return await Doc.viewBlocks();
    if (first === 'dev') return await Doc.viewDev();
    // 积木教程：讲清楚「积木是什么、怎么用、怎么写自己的块」，纯文档页。
    if (first === 'guide') return await Guide.viewGuide();
    if (first === 'doc' && second && parts[2] === 'edit') return await Doc.viewDocEdit(Number(second), query);
    if (first === 'doc' && second && parts[2] === 'blocks') return await Doc.viewDocEdit(Number(second), query);
    if (first === 'doc' && second) return await Doc.viewDoc(Number(second));
    // Wiki 多页面：`[[双链]]` 指向 `#/wiki/<标题>`，没建过的页就在那里建。
    // 不再 `decodeURIComponent` —— `parseHash` 已经把整条 hash 解过一次了，
    // 再解一次会把标题里本来就有的 `%` 吃掉。标题里的 `/` 用 join 兜住。
    if (first === 'wiki' && second) return await Doc.viewWiki(parts.slice(1).join('/'), query);
    // 团队（P4）：`#/teams` 是列表，`#/team/<slug>` 是某个团队的主页。
    // 两段路径各自的第一段就不同（teams / team），所以顺序上没有依赖；
    // 第二段传的是 **slug 字符串**（后端两种都收，但地址里露出来的应该是 slug），
    // 不再解一次码 —— parseHash 已经把整条 hash 解过了。
    if (first === 'teams') return await Team.viewTeams(query);
    // 团队帖子详情：`#/team/<slug>/post/<id>`。**必须排在上面那行之前**，
    // 否则整条地址会被当成「slug 叫 xxx/post/12 的团队主页」（多余的两段直接丢掉，
    // 症状是点进详情却渲染出团队主页，而且看不出哪里错了）。
    if (first === 'team' && second && parts[2] === 'post' && parts[3]) {
      return await Team.viewTeamPost(second, Number(parts[3]), query);
    }
    if (first === 'team' && second) return await Team.viewTeam(second, query);
    // `#/wiki`：所有看得见的站（一个帖子一个 wiki 里的「一个帖子」列表）。
    if (first === 'wiki') return await Doc.viewWikiIndex();
    if (first === 'settings') return await Settings.viewSettings();
    // P5：起始页（左公告 / 右三块入口）。独立地址，`#/` 的语义一个字没改。
    if (first === 'start') return await Start.viewStart();
    if (first === 'notifications') return await Notif.viewNotifications(query);
    if (first === 'messages' && second) return await Message.viewThread(second);
    if (first === 'messages') return await Message.viewMessages();
    if (first === 'u' && second) return await User.viewUser(second, query);
    if (first === 'login') return await Auth.viewAuth('login');
    if (first === 'register') return await Auth.viewAuth('register');
    if (first === 'admin') return await Admin.viewAdmin();
    ui.app.innerHTML = `<div class="card">${emptyHtml('🧭', '页面不存在', '返回首页继续逛逛')}</div>`;
  } catch (error) {
    if (error?.aborted) return; // 已被新页面取代，别再往新页面上画错误卡
    const text = apiErrorText(error);
    if (!text) return; // 已经处理过（例如已跳登录页），不用再画一张卡
    ui.app.innerHTML = `<div class="card">${emptyHtml('😵', text)}
      <div style="text-align:center"><a class="btn btn-sm" href="#/">返回首页</a></div></div>`;
    toast(text, 'error');
  } finally {
    endRoute();
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
