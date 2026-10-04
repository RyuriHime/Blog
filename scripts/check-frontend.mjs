/**
 * 前端冒烟：在 Node 里用最小 DOM 垫片把 public/ 的前端跑起来。
 *
 * 为什么需要它：`check-public-modules.mjs` 只能证明「import 头是对的」，
 * 证明不了 `bootstrap()` 跑得通、视图渲染得出来。搬家时最常见的坏法是
 * 「函数体被切掉一半」或「漏了某条 import」，这两种都只在真正执行时才炸。
 *
 * 这个脚本做三件事：
 *   1) 造一个够用的假 DOM（元素、classList、dataset、innerHTML、addEventListener…）；
 *   2) 把 fetch 全部拦下来，按路径返回**真实接口响应**（见下）；
 *   3) import 入口 app.js（它会自动 bootstrap()），然后依次渲染 18 个页面，
 *      任何一个抛异常就报出来。
 *
 * 【重要】假数据不再是手写的，而是从真服务器采回来的：
 *   `scripts/frontend-fixtures.json`（由 `scripts/capture-fixtures.mjs` 生成）。
 *   手写假数据时吃过亏 —— 少一个 `week` / `followingCount` / `isMe` 就会让页面渲染失败，
 *   看起来像搬家切坏了代码，其实是假数据缺字段。用真响应就不会有这种假警报。
 *   接口改了形状就重新采一次：
 *     node scripts/capture-fixtures.mjs && node scripts/check-frontend.mjs
 *
 * 用法：node scripts/check-frontend.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_FILE = join(ROOT, 'scripts', 'frontend-fixtures.json');

/* ---------- 1. 假 DOM ---------- */
const listeners = new Map(); // "type:selector" -> handler 数
function makeElement(tag = 'div') {
  const el = {
    tagName: tag.toUpperCase(),
    className: '',
    id: '',
    hidden: false,
    disabled: false,
    value: '',
    checked: false,
    dataset: {},
    style: {},
    children: [],
    childNodes: [],
    textContent: '',
    _html: '',
    files: [],
    classList: {
      add() {}, remove() {}, toggle() {}, contains: () => false,
    },
    get innerHTML() { return this._html; },
    set innerHTML(value) { this._html = String(value); },
    get outerHTML() { return this._html; },
    set outerHTML(value) { this._html = String(value); },
    append() {}, appendChild() {}, remove() {}, removeChild() {},
    insertAdjacentHTML() {},
    addEventListener(type) {
      const key = `${type}`;
      listeners.set(key, (listeners.get(key) ?? 0) + 1);
    },
    removeEventListener() {},
    querySelector: () => makeElement(),
    querySelectorAll: () => [],
    closest: () => null,
    contains: () => false,
    focus() {}, blur() {}, click() {}, scrollTo() {},
    getBoundingClientRect: () => ({ width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600 }),
    getContext: () => ({
      clearRect() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {},
      arc() {}, closePath() {}, save() {}, restore() {}, translate() {}, scale() {}, setTransform() {},
      measureText: () => ({ width: 10 }), fillText() {}, strokeText() {}, drawImage() {},
      createLinearGradient: () => ({ addColorStop() {} }),
      set fillStyle(v) {}, get fillStyle() { return ''; },
      set strokeStyle(v) {}, get strokeStyle() { return ''; },
      set lineWidth(v) {}, get lineWidth() { return 1; },
      set font(v) {}, get font() { return ''; },
      set globalAlpha(v) {}, get globalAlpha() { return 1; },
    }),
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    scrollIntoView() {}, setSelectionRange() {},
    form: null,
    parentNode: null,
  };
  return el;
}

const documentElement = makeElement('html');
const app = makeElement('main');
const root = {
  documentElement,
  body: makeElement('body'),
  createElement: (tag) => makeElement(tag),
  createTextNode: (text) => ({ textContent: text }),
  querySelector: (selector) => {
    if (selector === '#app') return app;
    return makeElement();
  },
  querySelectorAll: () => [],
  getElementById: (id) => (id === 'app' ? app : makeElement()),
  addEventListener: (type) => listeners.set(type, (listeners.get(type) ?? 0) + 1),
  removeEventListener() {},
  head: makeElement('head'),
  cookie: '',
  title: '',
};

globalThis.document = root;
globalThis.window = {
  document: root,
  location: { hash: '', href: 'http://localhost/', pathname: '/', search: '' },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  history: { replaceState() {}, pushState() {} },
  addEventListener: (type) => listeners.set(type, (listeners.get(type) ?? 0) + 1),
  removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
  scrollTo() {}, alert() {}, confirm: () => true, prompt: () => null,
  requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 0),
  cancelAnimationFrame() {}, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
  devicePixelRatio: 1, innerWidth: 1280, innerHeight: 800,
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  NotesAgent: undefined,
};
globalThis.localStorage = globalThis.window.localStorage;
globalThis.location = globalThis.window.location;
globalThis.matchMedia = globalThis.window.matchMedia;
globalThis.requestAnimationFrame = globalThis.window.requestAnimationFrame;
globalThis.cancelAnimationFrame = () => {};
globalThis.getComputedStyle = globalThis.window.getComputedStyle;
globalThis.devicePixelRatio = 1;
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};
globalThis.confirm = () => true;
globalThis.alert = () => {};
globalThis.Image = class { set src(v) { this.onload?.(); } };
globalThis.URL.createObjectURL = () => 'blob:fake';
globalThis.URL.revokeObjectURL = () => {};

/* ---------- 2. 假 fetch（数据来自真服务器采样的 frontend-fixtures.json） ---------- */
if (!existsSync(FIXTURE_FILE)) {
  console.error('缺少 docs/tools/frontend-fixtures.json。');
  console.error('先跑一次：node docs/tools/capture-frontend-fixtures.mjs');
  process.exit(1);
}
const FIXTURES = JSON.parse(readFileSync(FIXTURE_FILE, 'utf8'));

/**
 * 子库每次采样都会重建，帖子的自增 id 会变。采样时把当次的 id 存进 `__postId`，
 * 这里把请求里的数字 id 换成它，假数据才能命中。
 */
const FIXTURE_POST_ID = String(FIXTURES.__postId ?? 1);
const FIXTURE_USERNAME = String(FIXTURES.__username ?? 'admin');
const FIXTURE_PEER = String(FIXTURES.__peer ?? FIXTURE_USERNAME);

/** 采样时用过的路径（去掉 __ 元数据）。 */
const FIXTURE_KEYS = Object.keys(FIXTURES).filter((key) => !key.startsWith('__'));

/** 知识图与可视化页在临时库里还没生成（真接口会 404），这里给个空壳让页面仍然渲染。 */
const EMPTY_GRAPH = { nodes: [], edges: [], tags: [], generatedAt: Date.now() };
const EXTRA = {
  '/api/knowledge/graph': EMPTY_GRAPH,
  '/api/knowledge/viewer': { ready: false },
  '/api/markdown/preview': { html: '<p>ok</p>' },
  '/api/ai/site': { configured: false, ready: false },
  '/api/knowledge/status': { ready: false },
};

/**
 * 路径匹配：先比完整「路径+查询串」（`?bookmarked=1` 这种要能区分开），
 * 再退回到只比路径（丢掉查询串）。**取最后一个匹配**，这样后写的具体规则能覆盖前缀规则。
 */
function pickFixture(fullPath) {
  // 页面会请求「当前这篇帖子」，id 是运行时才知道的 —— 统一折算成采样时的 id。
  const normalized = fullPath
    .replace(/^(.*\/api\/posts\/)\d+/, `$1${FIXTURE_POST_ID}`)
    .replace(/^(.*\/api\/ai\/posts\/)\d+/, `$1${FIXTURE_POST_ID}`)
    .replace(/^(.*\/api\/messages\/)[^?]+/, `$1${FIXTURE_PEER}`);
  const bare = normalized.split('?')[0];
  const candidates = [
    ...FIXTURE_KEYS.filter((key) => key.split('?')[0] === bare),
    ...Object.keys(EXTRA).filter((key) => key.split('?')[0] === bare),
  ];
  if (!candidates.length) return undefined;
  const chosen = candidates[candidates.length - 1];
  return chosen in EXTRA ? EXTRA[chosen] : FIXTURES[chosen];
}

const unknownPaths = new Set();

let fetchCount = 0;
globalThis.fetch = async (url, options = {}) => {
  fetchCount += 1;
  const raw = String(url).replace(/^https?:\/\/[^/]+/, '');
  const data = pickFixture(raw);
  if (data === undefined) unknownPaths.add(raw.split('?')[0]);
  return {
    ok: true,
    status: 200,
    headers: { getSetCookie: () => [], get: () => 'application/json' },
    json: async () => ({ ok: true, data: data ?? {} }),
    text: async () => JSON.stringify({ ok: true, data: data ?? {} }),
    _url: url,
    _options: options,
  };
};
globalThis.window.fetch = globalThis.fetch;

/* ---------- 3. 跑起来 ---------- */
const problems = [];
process.on('uncaughtException', (error) => problems.push(`未捕获异常：${error.message}`));
process.on('unhandledRejection', (error) => problems.push(`未处理的 Promise 失败：${error?.message ?? error}`));

let App;
try {
  // 入口自己会 bootstrap()；bootstrap 里 await 的请求由上面的假 fetch 兜住。
  App = await import(pathToFileURL(join(ROOT, 'public', 'app.js')).href);
  // bootstrap() 在 import 阶段已经启动但还没结束，等一拍让它把 state 填好。
  await new Promise((resolve) => setTimeout(resolve, 50));
} catch (error) {
  console.log(`  ❌ 入口 import 失败：${error.message}`);
  process.exit(1);
}
console.log(`  ✅ 入口 app.js 装载成功（bootstrap() 未抛异常，发起了 ${fetchCount} 次请求）`);
void App;

// 依次渲染每个页面：直接调视图函数，绕过 hash 路由，测的是「渲染会不会炸」。
const feedMod = () => import(pathToFileURL(join(ROOT, 'public', 'views', 'feed.js')).href);
const view = (file) => import(pathToFileURL(join(ROOT, 'public', 'views', file)).href);

const CASES = [
  ['首页', 'feed.js', 'viewHome', [new Map()]],
  ['版块', 'feed.js', 'viewBoard', ['general', new Map()]],
  ['搜索', 'feed.js', 'viewSearch', [new Map()]],
  ['收藏', 'feed.js', 'viewBookmarks', [new Map()]],
  ['关注流', 'feed.js', 'viewFollowing', []],
  ['个人主页', 'user.js', 'viewUser', ['admin', new Map()]],
  ['排行榜', 'user.js', 'viewRanking', [new Map()]],
  ['签到', 'checkin.js', 'viewCheckin', []],
  ['设置', 'settings.js', 'viewSettings', []],
  ['通知', 'notifications.js', 'viewNotifications', [new Map()]],
  ['私信列表', 'messages.js', 'viewMessages', []],
  ['私信会话', 'messages.js', 'viewThread', [FIXTURE_PEER]],
  ['帖子详情', 'post.js', 'viewPost', [1]],
  ['发帖页', 'compose.js', 'viewCompose', [null]],
  ['登录页', 'auth.js', 'viewAuth', ['login']],
  ['注册页', 'auth.js', 'viewAuth', ['register']],
  ['AI 助手', 'ai.js', 'viewAI', []],
  ['管理后台', 'admin.js', 'viewAdmin', []],
];

let rendered = 0;
for (const [label, file, fn, argv] of CASES) {
  let target;
  try {
    target = await view(file);
  } catch (error) {
    problems.push(`${label}：加载 views/${file} 失败 ${error.message}`);
    continue;
  }
  const handler = target?.[fn];
  if (typeof handler !== 'function') {
    problems.push(`${label}：${file} 没有导出 ${fn}`);
    continue;
  }
  // 视图里的 `me` / `site` 依赖 bootstrap 拉回来的数据，这里保证它们已就位。
  try {
    await handler(...argv);
    rendered += 1;
  } catch (error) {
    const top = (error.stack ?? '').split('\n').slice(0, 3).join(' | ');
    problems.push(`${label}（${file}.${fn}）渲染失败：${error.message}  ← ${top}`);
  }
}
console.log(`  ${problems.length ? '❌' : '✅'} 渲染 ${rendered}/${CASES.length} 个页面`);
void feedMod;

// 把 bootstrap 拉回来的 state 直接看一眼，确认关键字段真的落到了 state 上。
const { state } = await import(pathToFileURL(join(ROOT, 'public', 'core', 'state.js')).href);
if (!state.site || !Array.isArray(state.site.boards) || state.site.boards.length === 0) {
  problems.push('bootstrap 之后 state.site.boards 还是空的');
}
if (!state.theme) problems.push('state.theme 没被初始化');

if (problems.length) {
  console.log('\n发现的问题：');
  for (const item of problems) console.log(`  ❌ ${item}`);
  process.exit(1);
}
console.log('  ✅ 18 个页面全部渲染通过，state 已就位');
process.exit(0);
