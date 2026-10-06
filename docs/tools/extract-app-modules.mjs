/**
 * 一次性搬运脚本：把 public/app.js 按「顶层声明」的边界切进 public/core/* 与 public/views/*。
 *
 * 用法：node docs/tools/extract-app-modules.mjs
 *
 * 设计要点（读之前先看这三条，否则会觉得下面的做法很绕）：
 *
 * 1) **不改任何调用点。** app.js 里的写法一个字都不动，靠 `import * as X from '...'`
 *    保留原函数名在作用域里。所以「搬家」和「改逻辑」被彻底分开：check-golden /
 *    check-ui-contract / smoke 全绿 = 行为没变。
 * 2) **模块内部一律用命名空间前缀**（`Fmt.fmtNum`、`Dom.esc`），绝不 `import { fmtNum }`，
 *    这样搬第二块时不用回头改第一块的 import 头。
 * 3) **共享状态放 core/state.js。** app.js 是 public/ 里最后一个加载的文件，而
 *    core/*.js 会被它 import —— 所以 state 必须提前初始化好，不能在 app.js 里建。
 *
 * 本脚本会覆盖目标文件的**开头区块**（到 `/* @hand-written *​/` 标记为止），
 * 标记之后的内容原样保留，方便人工在生成结果后面追加东西。
 *
 * ⚠️ 历史脚本，**别再跑**：它的名单还停留在搬家那一刻，里面的 `views/checkin.js` /
 *    `viewRanking` / `checkinCardHtml` 都已经随「签到与价值排行下线」删掉了，
 *    照着跑会把删掉的文件和函数又生成出来。这里留着只为记录当初怎么切的。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findBlocks } from './scan-app-decls.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP = join(ROOT, 'public', 'app.js');

const source = readFileSync(APP, 'utf8');
const lines = source.split('\n');

/* ---------- 1. 找出每个顶层块的起止行 ---------- */
// 一定要用 scan-app-decls.mjs 的状态机，不要在这里重新数花括号：
// app.js 里满是模板字符串（`${x}` 里还嵌模板字符串）与正则字面量，朴素数括号会把块切歪。
const decls = findBlocks(source).map((block) => ({ ...block, name: block.name ?? `@${block.label}`, anon: !block.name }));

// 具名块才进 byName；匿名块靠行号引用（见 EXTRA）。
const byName = new Map(decls.filter((item) => !item.anon).map((item) => [item.name, item]));
const missing = (names) => names.filter((name) => !byName.has(name));

/* ---------- 2. 分块表 ---------- */

/** @type {{file:string, ns:string|null, header:string, names:string[]}[]} */
const CHUNKS = [
  {
    file: 'public/core/state.js',
    ns: null,
    header: [
      '// 前端共享状态与常量。',
      '//',
      '// 为什么单独一个文件：app.js 是 public/ 里**最后一个**加载的模块，而 core/*.js',
      '// 会被它 import。把 state 留在 app.js 里，core/theme.js 之类的模块就会在',
      '// 初始化之前去读 state.theme（undefined），主题会在刷新时闪一下。',
      '//',
      '// 规矩：这里只放「数据 + 常量」，不放函数。谁要读就 import 谁。',
    ].join('\n'),
    names: ['state', 'PROFILE_LAYOUTS', 'AVATAR_EMOJIS'],
  },
  {
    file: 'public/core/dom.js',
    ns: 'Dom',
    header: [
      '// DOM 小工具：$(选择器)、ui（挂载点）、esc（HTML 转义）、emptyHtml、loadingHtml、toast。',
      '//',
      '// `ui` 在这里而不是 state.js：它要在模块求值时就抓到 #app / #sidebar 等挂载点，',
      '// 这些元素在 index.html 的 <body> 里、脚本执行时已经存在。',
    ].join('\n'),
    names: ['ui', '$', 'ESCAPES', 'esc', 'emptyHtml', 'loadingHtml', 'toast'],
  },
  {
    file: 'public/core/format.js',
    ns: 'Fmt',
    header: [
      '// 纯格式化：转义、时间、数字、中文日期、角色标签、规则回退值。',
      '// 这一块不含任何 DOM 操作，也没有副作用 —— 可以直接在 node 里 import 来测。',
    ].join('\n'),
    names: [
      'timeAgo',
      'fullTime',
      'fmtNum',
      'weekdayCn',
      'monthDayCn',
      'isStaffRole',
      'isStaffUser',
      'roleLabel',
      'roleTag',
      'coinRules',
      'checkinRules',
      'profileRules',
    ],
  },
  {
    file: 'public/core/preferences.js',
    ns: 'Prefs',
    header: [
      '// localStorage 偏好的读写。KEY 常量集中在这里，index.html 的首屏内联脚本里',
      '// 硬编码了 THEME_STORAGE_KEY 的值 —— 改这里必须同步改那边，check-ui-contract 会查。',
    ].join('\n'),
    names: ['readPreference', 'writePreference', 'profileLayout', 'THEME_STORAGE_KEY'],
  },
  {
    file: 'public/core/api.js',
    ns: 'Api',
    header: [
      '// HTTP 客户端：统一的 fetch 包装 + 信封拆解 + 401 跳登录 + 忙碌态按钮。',
      '//',
      '// 三个约定（与后端 src/core/http.js 一一对应）：',
      '//   1) 成功 = { ok: true, data }，失败 = { ok: false, error: { code, message } }；',
      '//   2) 未登录返回 401，前端**不要**自己猜，直接跳 #/login；',
      '//   3) 所有错误都必须抛出 Error（带 .code），别返回 undefined 让调用方猜。',
    ].join('\n'),
    names: ['api', 'withButtonBusy'],
  },
  {
    file: 'public/core/theme.js',
    ns: 'Theme',
    header: [
      '// 8 套主题：定义、色块预览、选择器渲染、应用与持久化。',
      '//',
      '// ⚠️ 8 套主题是线上版就有的功能，v2 的 UI 翻新**只允许增删样式，不允许减少主题数**。',
      '// themeSwatchHtml 里的色值必须与 public/css/*.css 里的真实取值一致，',
      '// scripts/check-ui-contract.mjs 会逐套比对（预览和实际不一样会报错）。',
    ].join('\n'),
    names: ['THEMES', 'themeMeta', 'resolveTheme', 'systemPrefersLight', 'themeSwatchHtml', 'themeOptionsHtml', 'renderThemeArea', 'applyTheme'],
  },
  {
    file: 'public/core/avatar.js',
    ns: 'Avatar',
    header: [
      '// 头像渲染：emoji 头像是「emoji:hue」拼出来的，上传头像是文件地址。',
      '// 两种形态都要能渲成 <img>/<span>，且大小档位固定（见 avatarHtml 的 size 参数）。',
    ].join('\n'),
    names: ['hueOf', 'avatarParts', 'avatarHtml'],
  },
  {
    file: 'public/core/events.js',
    ns: 'Events',
    header: [
      '// 全局事件委托：整个前端只有这一处 click / submit / change 监听。',
      '//',
      '// 为什么这样设计：19 个视图都是把 HTML 字符串赋给 ui.app.innerHTML，元素随时被',
      '// 整体替换，逐元素 addEventListener 会随替换一起丢。所以统一在 document 上委托，',
      '// 靠 data-action="xxx" 属性分发。新增动作 = 在下面的 switch 里加一个 case。',
    ].join('\n'),
    names: ['closeMenus', 'closeMenu', 'currentUsername', 'refreshProfile'],
  },
  {
    file: 'public/core/session.js',
    ns: 'Session',
    header: [
      '// 会话与站点数据：登录态、未读数、签到、币规则、消息未读。',
      '// 这些数据在多个视图里被读，所以读回来一律写进 core/state.js 的 state 对象。',
    ].join('\n'),
    names: [
      'bootstrap',
      'loadSite',
      'loadSession',
      'loadCheckin',
      'refreshUnread',
      'refreshMessageUnread',
      'renderUserArea',
      'renderSidebar',
      'requireLogin',
      'checkinCardHtml',
    ],
  },
  {
    file: 'public/core/widgets.js',
    ns: 'Widgets',
    header: [
      '// 通用界面零件：帖子卡片（列表/卡片/紧凑三种布局）、分页、排序页签、版块下拉、',
      '// 作者工具条、徽章、统计行、公式说明卡、私信配额提示。',
      '// 五路并行时，这些是**共享**零件 —— 要改先看别人用没用到。',
    ].join('\n'),
    names: [
      'postBadgesHtml',
      'postMetaStatsHtml',
      'ownerToolsHtml',
      'postListHtml',
      'postCardsHtml',
      'postCompactHtml',
      'profilePostsHtml',
      'pageNumbers',
      'paginationHtml',
      'sortTabsHtml',
      'feedTabsHtml',
      'personChipHtml',
      'boardOptions',
      'formulaCardHtml',
      'rankBadgeClass',
      'RANKING_WINDOWS',
      'messageQuotaHtml',
    ],
  },
  {
    file: 'public/core/router.js',
    ns: 'Router',
    header: [
      '// hash 路由：#/board/tech?page=2 这一套。',
      '//',
      '// 三条硬约定：',
      '//   1) 页面地址是**对外契约**（收藏夹、通知里的链接），新增页面只能加不能改；',
      '//   2) 未登录访问需要登录的页面时，先跳 #/login 并把原地址记进 state.redirect；',
      '//   3) 每个 viewXxx 自己负责把 ui.app.innerHTML 填好，route() 不兜底。',
    ].join('\n'),
    names: ['route', 'parseHash', 'navigate', 'routeQuery'],
  },
  { file: 'public/views/feed.js', ns: 'Feed', header: '// 首页 / 版块 / 搜索 / 收藏 / 关注 四处「帖子列表」型页面。', names: ['renderPostListSection', 'viewHome', 'viewBoard', 'viewSearch', 'viewBookmarks', 'viewFollowing'] },
  { file: 'public/views/user.js', ns: 'User', header: '// 个人主页与排行榜。', names: ['viewUser', 'viewRanking'] },
  { file: 'public/views/checkin.js', ns: 'Checkin', header: '// 签到日历页。', names: ['viewCheckin'] },
  { file: 'public/views/settings.js', ns: 'Settings', header: '// 账号设置页（资料 / 头像 / 密码 / 主题 / 外观）。', names: ['viewSettings'] },
  { file: 'public/views/notifications.js', ns: 'Notif', header: '// 通知中心。', names: ['NOTIF_META', 'notifTarget', 'notifHtml', 'viewNotifications'] },
  { file: 'public/views/messages.js', ns: 'Message', header: '// 私信：会话列表与单条会话。', names: ['viewMessages', 'viewThread'] },
  { file: 'public/views/post.js', ns: 'Post', header: '// 帖子详情页：正文、评价栏、投币、转发列表、回复。', names: ['replyHtml', 'reactionBarHtml', 'repostSectionHtml', 'viewPost'] },
  { file: 'public/views/compose.js', ns: 'Compose', header: '// 发帖/编辑页，以及右侧的 AI 笔记抽屉（note-studio panel）。', names: ['composeNotesPanel', 'destroyComposeNotesPanel', 'mountComposeNotesPanel', 'viewCompose', 'applyMarkdown', 'applyAvatarResult', 'compressImageFile', 'lockCoinButton'] },
  { file: 'public/views/auth.js', ns: 'Auth', header: '// 登录 / 注册页。', names: ['viewAuth'] },
  { file: 'public/views/ai.js', ns: 'Ai', header: ['// AI 阅读助手页：站点总览、单帖分析、提问。', '//', '// ⚠️ 这里只是**展示层**。所有 /api/ai/* 请求都由后端 forum-ai 挂载层处理，', '// 前端不许在这里拼提示词、也不许自己算分析结果。'].join('\n'), names: ['aiConfigured', 'aiNoticeHtml', 'aiChip', 'aiIdOf', 'aiPostLink', 'aiAskFormHtml', 'aiAnswerHtml', 'aiReviewCardHtml', 'aiPostPanelHtml', 'viewAI'] },
  { file: 'public/views/admin.js', ns: 'Admin', header: '// 管理后台：统计、用户与角色、隐藏帖子、审计日志。', names: ['viewAdmin'] },
  { file: 'public/views/notes.js', ns: 'Notes', header: '// 学术笔记工作台页（note-studio 的宿主页面）。', names: ['NT_KATEX', 'ntState', 'ntScripts', 'ntLoadScript', 'ntStyleOnce', 'ntEnsureKatex', 'ntRenderMath', 'ntReload', 'viewNotes', 'ntRender', 'ntMineHtml', 'ntSquareHtml', 'ntRenderReading', 'ntBind', 'ntOnListClick', 'ntMutate', 'ntOpenNote'] },
  { file: 'public/views/graph.js', ns: 'Graph', header: '// 知识网络图：canvas 力导向布局 + 侧栏面板。', names: ['KG_NODE_COLOR', 'KG_EDGE_STYLE', 'KG_TYPE_LABEL', 'kg', 'kgRadius', 'kgLayout', 'kgResize', 'kgStep', 'kgFocus', 'kgIsDim', 'kgToWorld', 'kgNodeAt', 'kgDraw', 'kgPalette', 'kgRefreshPalette', 'kgStop', 'kgLoop', 'kgNeighbors', 'kgPanelHtml', 'kgRenderPanel', 'kgBind', 'kgTagChipsHtml', 'renderGraphPage', 'viewGraph'] },
];

/**
 * 匿名顶层块（事件监听器本体、启动调用）。
 *
 * 用**源码行号**引用，不用标签：5 个 `document.addEventListener` 在扫描器眼里都叫
 * `@document.on`，标签分不出来谁是谁。这里的 `start` 是**从 1 开始的行号**（人读的号），
 * 转换在下面统一做 —— 直接写 0-based 下标极易差一行。
 * 行号只在 app.js 本身被手改后才失效，那时这里会直接报错说找不到，不会静默错搬。
 */
const EXTRA = [
  { file: 'public/core/events.js', line: 2701 }, // click 委托（约 470 行，整个前端的交互都在这）
  { file: 'public/core/events.js', line: 3273 }, // change
  { file: 'public/core/events.js', line: 3315 }, // submit
  { file: 'public/core/events.js', line: 3473 }, // 搜索框 submit
  { file: 'public/core/events.js', line: 3479 }, // keydown（ESC 关菜单）
];

for (const entry of EXTRA) {
  const start = entry.line - 1;
  const block = decls.find((item) => item.start === start);
  const chunk = CHUNKS.find((item) => item.file === entry.file);
  if (!block || !chunk) {
    console.error(
      `❌ EXTRA 找不到第 ${entry.line} 行开始的顶层块（app.js 被手改过？）\n` +
        `   实际块数=${decls.length}，落在这一行附近的块：\n` +
        decls
          .filter((item) => Math.abs(item.start - start) <= 3)
          .map((item) => `     start=${item.start} end=${item.end} name=${item.name}`)
          .join('\n'),
    );
    process.exit(1);
  }
  chunk.names.push(block.name);
  block.forced = entry.file;
}
console.log(`[extract] 顶层块 ${decls.length} 个（匿名 ${decls.filter((item) => item.anon).length} 个），EXTRA 已认领 ${EXTRA.length} 个`);

/* ---------- 3. 校验：每个顶层声明都被分到正好一块 ---------- */

const assigned = new Map();
const dupes = [];
for (const chunk of CHUNKS) {
  for (const name of chunk.names) {
    // 匿名块可以有多个同名（5 个 `document.addEventListener` 都叫 `@document.on`），
    // 它们靠行号区分，所以只对具名块查重。
    if (name.startsWith('@')) {
      assigned.set(`${name}#${assigned.size}`, chunk.file);
      continue;
    }
    if (assigned.has(name)) dupes.push(`${name}（${assigned.get(name)} 与 ${chunk.file}）`);
    assigned.set(name, chunk.file);
  }
}
if (dupes.length) {
  console.error('❌ 同一个名字被分到多块：\n  ' + dupes.join('\n  '));
  process.exit(1);
}
const notFound = [...assigned.keys()].filter((name) => !name.startsWith('@') && !byName.has(name));
if (notFound.length) {
  console.error('❌ 这些名字在 app.js 里找不到顶层声明：\n  ' + notFound.join('\n  '));
  process.exit(1);
}
// 匿名块（事件监听器、bootstrap() 调用）不在 assigned 里 —— 它们由 EXTRA 按行号认领。
for (const item of decls) {
  if (!item.anon && !assigned.has(item.name)) {
    console.error(`❌ ${item.name} 在 CHUNKS 里没有被分到任何一块`);
    process.exit(1);
  }
  // `bootstrap()` 那一句由脚本自己生成（见第 5 节），不需要 EXTRA 认领，所以放行。
  if (item.anon && !item.forced && item.name !== '@bootstrap()') {
    console.error(`❌ 匿名块 ${item.name}（第 ${item.start + 1} 行）没有被 EXTRA 认领`);
    process.exit(1);
  }
}
const unassigned = [];
if (unassigned.length) {
  console.error('❌ 这些顶层声明没有被分到任何一块：\n  ' + unassigned.join('\n  '));
  process.exit(1);
}

/* ---------- 4. 生成各模块文件 ---------- */

/** 算出「从 fromFile 到 toFile」的相对 import 路径（两者都是 public/ 下的仓库相对路径）。 */
function relativeFrom(fromFile, toFile) {
  const fromDir = fromFile.split('/').slice(0, -1); // ['public','core']
  const toParts = toFile.split('/').slice(0, -1); // ['public','views']
  const toName = toFile.split('/').pop();
  let common = 0;
  while (common < fromDir.length && common < toParts.length && fromDir[common] === toParts[common]) common += 1;
  const up = fromDir.length - common;
  const down = toParts.slice(common);
  const prefix = up ? '../'.repeat(up) : './';
  return `${prefix}${down.length ? `${down.join('/')}/` : ''}${toName}`;
}

/**
 * 生成模块的 import 头。
 *
 * core/ 下的模块之间是同级（`./dom.js`），views/ 下的引用 core/ 要退一级（`../core/dom.js`），
 * views 之间也退一级 —— 之前的实现把「public/core/views/user.js」这种路径算错，
 * 生成的 import 直接 Cannot find module。统一交给 relativeFrom 算，别再手拼。
 */
/**
 * 「共享单例 / 高频小工具」用具名 import，不用 `Dom.ui` 这种带命名空间的写法。
 *
 * 为什么：搬家是**逐字节搬运正文**，正文里写的是 `ui.app.innerHTML = …`、`esc(x)`、
 * `state.site`。如果这里生成 `import * as Dom`，正文里的 `ui` 就没人定义了
 * （实测报 `ui is not defined`，17 个文件全挂）。用具名 import 就能让正文一个字不改。
 * 冲突风险很低（这些名字是大写/前缀风格），真撞了 `check-public-modules.mjs` 会立刻报出来。
 */
const SHARED_IMPORTS = new Map([
  ['ui', 'public/core/dom.js'],
  ['$', 'public/core/dom.js'],
  ['esc', 'public/core/dom.js'],
  ['emptyHtml', 'public/core/dom.js'],
  ['loadingHtml', 'public/core/dom.js'],
  ['toast', 'public/core/dom.js'],
  ['api', 'public/core/api.js'],
  ['withButtonBusy', 'public/core/api.js'],
  ['state', 'public/core/state.js'],
  ['navigate', 'public/core/router.js'],
  ['routeQuery', 'public/core/router.js'],
]);

/**
 * 把「跨块的裸名字引用」改写成**命名空间形式**：`feedTabsHtml(` → `Widgets.feedTabsHtml(`。
 *
 * 为什么必须改写而不是 import 一堆裸名字：搬家是逐字节搬运，正文里写的是
 * `feedTabsHtml(feed, basePath, query)`、`navigate('/login')`、`profileLayout()`。
 * 如果只给「少数几个」名字做具名 import，剩下的一律留在原地，就会漏 ——
 * 实测 `feedTabsHtml` / `profileLayout` / `RANKING_WINDOWS` / `applyTheme` 都是这么漏的，
 * 而且**只在浏览器运行时**才暴露成 `X is not defined`（静态检查、import 检查全绿）。
 *
 * 改成「凡跨块引用一律加命名空间前缀」之后，规则统一了：正文里的裸名字只可能指向
 * 本源自己的声明，跨块的必然带前缀，漏 import 就从「可能」变成「不可能」。
 *
 * 匹配用 `(^|[^\w$.])名字(?![A-Za-z0-9_$])`：前面不能是 `.`（否则是别的对象的同名属性），
 * 后面不能紧跟标识符字符。字符串与注释里的同名词也会被改写 —— 无害（只影响文案），
 * 而且原文件里本来就没有同名的自由标识符。
 */
/**
 * 这个块是否用到了某个顶层名字（用于决定 import 哪几个具名符号）。
 *
 * ⚠️ 判据必须排除两种「看起来像但其实不是自由标识符」的位置：
 *   1) 前面是 `.`  → `x.esc(...)` 是别人的属性；
 *   2) 后面紧跟 `:`（且前面是行首/`,`/`{`）→ **对象字面量的键**。
 * 第 2 条踩过：`state.js` 里写了 `coinRules: { … }`，被误判成引用 `coinRules`，
 * 于是键被改写成 `Fmt.coinRules: { … }`，语法错 `Unexpected token '.'`（21 个文件全挂）。
 */
function usesName(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_$.])${escaped}(?![A-Za-z0-9_$]|\\s*:)`, 'm').test(text);
}

function rewriteCrossChunkRefs(file, own, text) {
  const names = new Set(
    [...assigned.keys()]
      .filter((name) => assigned.get(name) !== file && !own.has(name))
      .filter((name) => !SHARED_IMPORTS.has(name)), // 具名 import 进来的名字保持裸写
  );
  const needed = new Set();
  // ⚠️ 具名 import 的名字（ui / $ / esc / api / state …）也要记账！
  // 早期版本把它们从改写里排除掉就完事了，结果导出清单里没有它们 ——
  // 生成的文件里裸写 `state.me = null`、`api(...)` 却根本没有那行 import
  // （实测 public/core/api.js 第 8 行只 import 了 Session，第 34 行却在用 state）。
  for (const name of SHARED_IMPORTS.keys()) {
    if (own.has(name)) continue;
    if (usesName(text, name)) needed.add(`\u0000shared\u0000${name}`);
  }
  // ⚠️ 用「按标识符分词 + 回调替换」而不是 `$1` 反向引用：
  // 用 `String.replace(re, '$1Ns.name')` 时，一旦左边界捕获到换行/空白，
  // 前一行会被整段吃掉（实测 `api(...)\n  .then(...)` 被改成 `api(...)\n\n  .then(...)`，
  // user.js 里 `[...].map(...)` 也断成两截）。回调版本只替换匹配到的那一个词。
  //
  // 词边界只能靠「前一个字符是不是 `.`」判断：分词器不认识点号，
  // `x.map(...)` 会送进来一个裸的 `map`，不加这个判断就会改成 `Widgets.map(...)`。
  let out = '';
  let last = 0;
  for (const match of text.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
    const word = match[0];
    const before = match.index > 0 ? text[match.index - 1] : '';
    const after = text.slice(match.index + word.length).match(/^\s*/)[0];
    const afterChar = text[match.index + word.length] ?? '';
    out += text.slice(last, match.index);
    last = match.index + word.length;
    // 三种位置不改写：属性访问（前面是 `.`）、对象字面量的键（后面是 `:`）、
    // 以及本来就不在跨块名单里的名字。
    if (before === '.' || !names.has(word) || afterChar === ':') {
      out += word;
      continue;
    }
    // 对象的简写属性 `{ fmtNum }` / 标签属性都不受影响；这里只处理真正的自由引用。
    const target = CHUNKS.find((item) => item.file === assigned.get(word));
    if (!target || !target.ns) {
      needed.add(`${word}\u0000${assigned.get(word)}`); // 无命名空间：具名 import
      out += word;
      continue;
    }
    needed.add(`${target.ns}\u0000${assigned.get(word)}`);
    out += `${target.ns}.${word}`;
  }
  out += text.slice(last);
  return { text: out, needed };
}

/**
 * 把 rewriteCrossChunkRefs 收集到的 `命名空间\0文件` 条目变成 import 行。
 *
 * 两种形态：
 *   - 有命名空间的块 → `import * as Widgets from '../core/widgets.js';`
 *   - 没有命名空间的块（core/state.js 这种纯数据文件）→ 具名 import。
 * 同一个文件只出一种形态，避免「既 import * as 又 import { }」。
 */
const importHeader = (chunk, needed) => {
  const byFile = new Map(); // file -> { ns: string|null, names: Set<string> }
  for (const entry of needed) {
    // 共享具名 import 的记账格式是 `\0shared\0名字`，单独走一条路。
    if (entry.startsWith('\u0000shared\u0000')) {
      const name = entry.slice('\u0000shared\u0000'.length);
      const file = SHARED_IMPORTS.get(name);
      if (!file || file === chunk.file) continue;
      if (!byFile.has(file)) byFile.set(file, { ns: null, names: new Set() });
      byFile.get(file).names.add(name);
      continue;
    }
    const [ns, file] = entry.split('\u0000');
    const target = CHUNKS.find((item) => item.file === file);
    const hasNs = target ? target.ns : null;
    if (!byFile.has(file)) byFile.set(file, { ns: hasNs, names: new Set() });
    const slot = byFile.get(file);
    if (hasNs) slot.ns = hasNs;
    else slot.names.add(ns); // 无命名空间时第一段存的是「名字」本身
  }
  const linesOut = [];
  for (const [file, slot] of byFile) {
    if (file === chunk.file) continue;
    const from = relativeFrom(chunk.file, file);
    if (slot.ns) {
      linesOut.push(`import * as ${slot.ns} from '${from}';`);
    } else if (slot.names.size) {
      linesOut.push(`import { ${[...slot.names].sort().join(', ')} } from '${from}';`);
    }
  }
  return linesOut.sort((a, b) => a.localeCompare(b, 'en'));
};

/**
 * 把若干顶层块的正文按**源码顺序**切出来。
 *
 * 正文取到「下一个顶层块开始的那一行之前」为止，然后去掉尾部的空行与纯注释/分隔线
 * （它们属于章节分隔，不该跟着搬家）。
 *
 * ❗ 两个必须记住的前提：
 *   1) 「下一个块」必须是**全体顶层块**的顺序表，包含匿名的 `document.addEventListener`。
 *      只看具名声明的话，事件委托那 470 行会被前一个声明的正文卷走 ——
 *      实测 public/core/api.js 因此从 59 行涨到 540 行。
 *   2) 必须**先按 start 排序再切**：`next.start` 只在按源码顺序排列时才是当前块的终点。
 */
const DECOR = /^(?:\s*$|\s*\/\*[/*=\-\s]*\*\/\s*|\s*\/\/\s*[-─=]{4,}\s*)$/;

/**
 * 「下一个块的起点」表 —— 必须在**全体顶层块**（含匿名块）的源码顺序上算。
 *
 * ⚠️ 不能按「本块声明的顺序」去数下一个：`const RANKING_WINDOWS = [` 这种不带分号的
 * 声明，只有靠后面那个真正的「下一个顶层块」才能确定它到哪结束。同理 `const x = {…};`
 * 只有靠全局表才不会把元数据 `RANKING_WINDOWS = [...]` 甩到别的文件里。
 */
const nextStartOf = new Map();
{
  const ordered = [...decls].sort((a, b) => a.start - b.start);
  for (let index = 0; index < ordered.length; index += 1) {
    const next = ordered[index + 1];
    nextStartOf.set(ordered[index], next ? next.start : lines.length);
  }
}

function bodiesOf(names) {
  const wanted = new Set(names);
  const out = [];
  for (const block of [...decls].sort((a, b) => a.start - b.start)) {
    if (!wanted.has(block.name)) continue;
    const raw = lines.slice(block.start, nextStartOf.get(block) ?? lines.length);
    // 先把结尾的「空行 + 装饰性分隔注释」（`/* ---- */`）去掉 —— 它们不属于任何声明。
    // 注意用 `replace(/\s+$/)` 而不是只删空字符串行：`\n` 不在 DECOR 的字符类里，
    // 留着它后面的块注释判据就永远够不到，抬头注释会原地不动。
    let end = raw.length;
    while (end > 0 && DECOR.test(raw[end - 1])) end -= 1;
    while (end > 0 && !raw[end - 1].replace(/\s+$/, '')) end -= 1;
    // 再把夹在「下一个声明的抬头注释」拦腰截断的**多行块注释**收拾干净。
    // 症状：`/* 知识网络图（knowledge-pack） */` 这种章节横幅被下一个声明的区间卷进来，
    // 于是 Graph 的抬头跑到了 Notes 的文件尾。判据很窄，只认「多行 `/*` 注释，且它后面
    // 只跟着装饰性行」——单行 JSDoc（`/** 初始摆位：… */`）不会命中，会被原样保留。
    for (let index = 0; index < end; index += 1) {
      if (!/^\s*\/\*/.test(raw[index])) continue;
      let close = -1;
      for (let scan = index; scan < end; scan += 1) {
        if (/\*\//.test(raw[scan])) { close = scan; break; }
      }
      if (close < 0 || close === index) continue; // 单行注释（`/* … */` 或 `/* --- */`）
      let tail = close + 1;
      // `// ── 导出 ──` 这种分隔线也是装饰，但它不在 DECOR 的字面量里（短横/长横/等号那一类），
      // 所以单独放行一行，否则 `*/`、`// ── 导出 ──` 会把判据卡住，抬头注释就留在文件尾。
      if (tail < end && /^\s*\/\/\s*[─=-]{3,}/.test(raw[tail])) tail += 1;
      while (tail < end && DECOR.test(raw[tail])) tail += 1;
      if (tail === end) end = index; // 这个块注释之后全是装饰行 → 它是「下一个声明的抬头」
    }
    while (end > 0 && DECOR.test(raw[end - 1])) end -= 1;
    out.push(raw.slice(0, end).join('\n'));
  }
  return out;
}

const HAND_WRITTEN = '/* @hand-written */';

for (const chunk of CHUNKS) {
  const own = new Set(chunk.names);
  // 先按顺序切出正文，再统一把「跨块裸名字」改写成命名空间形式 ——
  // 改写必须在组装 import 头之前做，否则 import 头不知道要引谁。
  const rewritten = bodiesOf(chunk.names).map((body) => rewriteCrossChunkRefs(chunk.file, own, body));
  const moved = rewritten.map((item) => item.text);
  if (process.env.EXTRACT_DEBUG === 'bodies') {
    for (let index = 0; index < moved.length; index += 1) {
      const name = chunk.names.filter((n) => !n.startsWith('@'))[index];
      const body = moved[index];
      if (body.includes('\n\n    .') || body.includes('\n    .')) {
        const at = body.indexOf('\n    .');
        console.log(`[debug] ${chunk.file} 第 ${index} 个块（${name}）在 .map 前有空行：`);
        console.log(JSON.stringify(body.slice(Math.max(0, at - 120), at + 20)));
      }
    }
  }
  const needed = new Set();
  for (const item of rewritten) for (const entry of item.needed) needed.add(entry);

  const header = chunk.header.split('\n').map((line) => (line ? `// ${line.replace(/^\/\/ ?/, '')}` : '//'));
  const imports = importHeader(chunk, needed);
  const exports = chunk.names
    .filter((name) => !name.startsWith('@')) // 匿名块（事件委托）不是标识符，没法 export
    .map((name) => `export { ${name} };`);

  const content = [
    ...header,
    '',
    ...imports,
    imports.length ? '' : null,
    ...moved,
    '',
    '// ── 导出 ──────────────────────────────────────────────────────────────',
    ...exports,
    '',
    HAND_WRITTEN,
    '',
  ]
    .filter((line) => line !== null)
    .join('\n');

  const target = join(ROOT, chunk.file);
  mkdirSync(dirname(target), { recursive: true });
  const existing = existsSync(target) ? readFileSync(target, 'utf8') : '';
  const marker = existing.indexOf(HAND_WRITTEN);
  const tail = marker >= 0 ? existing.slice(marker + HAND_WRITTEN.length + 1) : '';
  writeFileSync(target, content + tail, 'utf8');
  console.log(`写入 ${chunk.file}（${chunk.names.length} 个声明，${content.split('\n').length} 行）`);
}

/* ---------- 5. app.js —— 薄入口 ---------- */
// 搬家后 app.js 不再保留任何原声明（19 个视图全部进了 views/，工具函数全部进了 core/），
// 它只做三件事：把命名空间 import 进来、把 state 里的关键数据挂好、调用 bootstrap()。
// 这正是骨架要的形状：一个「装配文件」，五个人永远不用改它。

const importLines = [];
for (const chunk of CHUNKS) {
  if (!chunk.ns) continue; // core/state.js 用具名 import
  const relative = chunk.file.replace(/^public\//, '');
  importLines.push(`import * as ${chunk.ns} from './${relative}';`);
}
importLines.sort((a, b) => a.localeCompare(b, 'en'));

const appContent = [
  '// 前端薄入口：只负责「装配」，不含业务逻辑。',
  '//',
  '// 原先的 public/app.js 有 4254 行，19 个视图、路由分发、主题、状态全挤在一起，',
  '// 五个人同时改会天天冲突。现在按「谁拥有什么」拆成：',
  '//',
  '//   public/core/    基础设施（状态 / DOM / 格式 / 主题 / 请求 / 事件 / 会话 / 零件 / 路由）',
  '//   public/views/   11 个页面，每页一个文件',
  '//   public/css/     样式分片（按界面区域切，最后由 /style.css 兜底全局）',
  '//',
  '// ⚠️ index.html 里的 <script type="module" src="/app.js"> 必须**唯一且最后**执行：',
  '//   app.js 是唯一有顶层副作用（bootstrap()）的文件，其余模块只被 import。',
  '//   新增一块功能（feed / doc / ai / team / ui）时：在 public/modules/<名字>.js 里写，',
  '//   然后在 app.js 里加一行 import 即可，别把逻辑塞回这里。',
  '',
  ...importLines,
  '',
  '/* 启动 -------------------------------------------------------------------- */',
  '// 整个前端唯一一处「顶层副作用」：装主题、拉站点数据与会话、渲染侧栏、挂 hashchange、',
  '// 然后跑第一次路由。放在入口文件里是为了让「谁启动应用」一眼可见。',
  "import { bootstrap } from './core/session.js';",
  'bootstrap();',
  '',
].join('\n');

writeFileSync(APP, appContent, 'utf8');
console.log(`写入 public/app.js（${appContent.split('\n').length} 行）`);

/* ---------- 6. 结构自检 ---------- */
// 自检三条：
//   a) 每个块里出现的名字都在那个块里声明/导出（抓「切歪了」）；
//   b) 每个被引用、但不在本源里的顶层名字，都要有一条对应的 import（抓「漏 import」）；
//      —— 这条不查会等到浏览器里 `X is not defined` 才发现。
//   c) 整个 app.js 的每一行都必须有归宿（要么进某个模块，要么留在 app.js），
//      用来证明「搬家没丢代码」。
let exportProblems = 0;
for (const chunk of CHUNKS) {
  const text = readFileSync(join(ROOT, chunk.file), 'utf8');
  const declaredInFile = new Set();
  for (const block of decls) {
    if (block.forced === chunk.file || assigned.get(block.name) === chunk.file) declaredInFile.add(block.name);
  }
  for (const name of declaredInFile) {
    // 匿名块（`export { @document.on }`）没法用「声明关键字 + 名字」的形式校验，跳过。
    if (name.startsWith('@')) continue;
    const declared = new RegExp(
      `^(?:export\\s+)?(?:async\\s+function|function|const|let|var|class)\\s+${name.replace(/\$/g, '\\$')}(?![\\w$])`,
      'm',
    ).test(text);
    const exported = new RegExp(`^export \\{ ${name.replace(/\$/g, '\\$')} \\};$`, 'm').test(text);
    if (!declared || !exported) {
      console.error(`❌ ${chunk.file} 的 ${name}：声明=${declared} 导出=${exported}`);
      exportProblems += 1;
    }
  }
}
console.log(exportProblems ? `❌ ${exportProblems} 个声明缺导出` : '✅ 所有搬走的声明都已导出');

/* ---------- 7. 覆盖自检：原 app.js 的每一行都必须有归宿 ---------- */
// 这是「搬家没丢代码」的硬证据。注意**不能**用「正文行数」来算 —— 正文会刻意丢掉
// 块之间的空行、分隔注释和章节注释（那些属于排版，不跟块走）。所以这里按
// **区间并集**数：每个块声明的 [start, end] 覆盖了哪些行，加上文件头的行、
// 加上块与块之间的空隙行，必须正好等于原文件总行数。少一行就说明某次切片丢了代码。
{
  const covered = new Set();
  for (const item of decls) for (let index = item.start; index <= item.end; index += 1) covered.add(index);
  const total = lines.length;
  const headerLines = Math.min(...decls.map((item) => item.start));
  const gapLines = total - covered.size - headerLines;
  console.log(
    `覆盖自检：原文件 ${total} 行 = 声明区间 ${covered.size} 行 + 文件头 ${headerLines} 行 + 块间空行/注释 ${gapLines} 行`,
  );
  const accounted = covered.size + headerLines + gapLines;
  if (accounted !== total || gapLines < 0) {
    console.error(`❌ 覆盖自检没通过：只对上了 ${accounted} 行，原文件 ${total} 行（块间 ${gapLines} 行）`);
    process.exit(1);
  }
  console.log('✅ 覆盖自检通过（每一行都有归宿，没有整块丢失）');
}
