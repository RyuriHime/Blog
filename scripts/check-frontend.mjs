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
 *   3) import 入口 app.js（它会自动 bootstrap()），然后依次渲染每个页面（见文件末尾的 CASES），
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
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_FILE = join(ROOT, 'scripts', 'frontend-fixtures.json');

/* ---------- 1. 假 DOM ---------- */
const listeners = new Map(); // "type:selector" -> handler 数

/**
 * 选择器 → 元素 的登记表。
 *
 * 为什么需要它：原来 `querySelector` 每次都 `return makeElement()`（**每次都是新对象**），
 * 于是「先把值写进输入框、重画之后再读出来」这类断言永远不可能成立 ——
 * 读回来的是另一个空对象。可它偏偏是最容易出 bug 的一类：
 * `renderShell()` 会把整个编辑框重新 innerHTML 一遍，用户正在写的字能不能留住全看这条路径。
 * 同选择器返回同一对象之后，这一整类交互才测得到。
 */
const elementRegistry = new Map();
function registered(selector) {
  if (!elementRegistry.has(selector)) elementRegistry.set(selector, makeElement());
  return elementRegistry.get(selector);
}

/** 表单类选择器：给元素塞 innerHTML = 真实 DOM 里把它们换成新元素（值自然清零）。 */
const FORM_SELECTORS = ['[data-feed-input]', '[data-feed-ref-input]', '[data-feed-scope]'];

function makeElement(tag = 'div') {
  const el = {
    _handlers: [],
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
      _set: new Set(),
      add(name) { this._set.add(name); },
      remove(name) { this._set.delete(name); },
      toggle(name, force) { if (force === undefined) { this._set.has(name) ? this._set.delete(name) : this._set.add(name); } else if (force) this._set.add(name); else this._set.delete(name); },
      contains(name) { return this._set.has(name); },
    },
    get innerHTML() { return this._html; },
    set innerHTML(value) {
      this._html = String(value);
      triggerRender(this, this._html);
    },
    get outerHTML() { return this._html; },
    set outerHTML(value) { this._html = String(value); },
    append() {}, appendChild() {}, remove() { this._removed = true; }, removeChild() {},
    insertAdjacentHTML() {},
    addEventListener(type, handler) {
      this._handlers.push({ type, handler });
      const key = `${type}`;
      listeners.set(key, (listeners.get(key) ?? 0) + 1);
    },
    removeEventListener() {},
    querySelector: (selector) => registered(selector),
    querySelectorAll: () => [],
    closest: () => null,
    contains: () => false,
    // 注意：这里必须是**方法简写**而不是箭头函数。箭头函数里的 `this` 是模块作用域（ES module 里是 undefined），
    // 于是任何视图里的一句 `event.target.matches('[data-xxx]')` 都会抛
    // `TypeError: Cannot set properties of undefined (setting '_lastMatch')` ——
    // 异常又被上面的 uncaughtException/unhandledRejection 处理器吃掉，
    // 表现是「脚本跑到一半就没了、exit=0、什么错都不报」，非常难查。别改回箭头函数。
    matches(selector) { this._lastMatch = selector; return false; },
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

/**
 * 「重画外壳」= 表单值清零。
 *
 * 真实 DOM 里 `app.innerHTML = '<textarea …></textarea>'` 会把旧的 textarea 换成新的空框，
 * 用户正在写的字就没了。**这个 bug 类只有让「重画清空 value」才测得出来。**
 * 假 DOM 不解析 HTML，所以用一个近似：重画的标记里出现过哪个表单选择器，就把谁的值清零。
 *
 * 只在**外壳容器**（`#app`）上触发：`syncPreview()` 那种给一个小方块塞 innerHTML 的动作
 * 不会碰到别处的输入框，反过来做会造出真实浏览器里不存在的失败。
 */
let SHELL = null;
let renderCount = 0;
function triggerRender(element, html) {
  if (element !== SHELL) return;
  renderCount += 1;
  for (const selector of FORM_SELECTORS) {
    if (!html.includes(selector.slice(1, -1))) continue;
    const node = elementRegistry.get(selector);
    if (node) node.value = '';
  }
}

/** 派发一个事件给某个元素上的监听器（假 DOM 不会自己冒泡，所以直接调）。 */
function dispatch(element, type, target, extra = {}) {
  for (const item of element._handlers ?? []) {
    if (item.type !== type) continue;
    item.handler({ type, target, preventDefault() {}, stopPropagation() {}, ...extra });
  }
}

/** 等一拍：有些处理函数是 `fn().catch(...)` 形式派发的，没有 await。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

const documentElement = makeElement('html');
const app = makeElement('main');
SHELL = app;
const root = {
  documentElement,
  body: makeElement('body'),
  createElement: (tag) => makeElement(tag),
  createTextNode: (text) => ({ textContent: text }),
  querySelector: (selector) => {
    if (selector === '#app') return app;
    return registered(selector);
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

/** 四档可见范围。团队页的兜底清单要和后端 shape.js 的 SCOPE_OPTIONS 一致。 */
const SCOPES = [
  { value: 'public', label: '公开' },
  { value: 'followers', label: '仅关注我的人' },
  { value: 'team', label: '仅团队' },
  { value: 'private', label: '仅自己' },
];

/** 一个团队的真形状（P4）。列表、详情、帖子三个接口共用同一份，免得形状漂移。 */
const TEAM_FIXTURE = {
  id: 1,
  slug: 'frontend-group',
  name: '前端小组',
  intro: '一起把前端做出来。',
  joinPolicy: 'open',
  joinPolicyLabel: '谁都能加入',
  owner: { id: 1, username: FIXTURE_USERNAME, displayName: '站长', avatar: null },
  memberCount: 1,
  postCount: 1,
  myRole: 'owner',
  myRoleLabel: '创建者',
  canManage: true,
  joined: true,
  canJoin: false,
  createdAt: Date.now() - 86400000,
  updatedAt: Date.now() - 3600000,
};

const EXTRA = {
  '/api/markdown/preview': { html: '<p>ok</p>' },
  '/api/ai/site': { configured: false, ready: false },
  // 积木（doc 模块）的四个页面要用的接口。采集器还没采这几条 ——
  // 手工给一小份真形状，渲染得出来就够了；接口形状改了就跟着改这里。
  '/api/docs/meta/block-types': {
    types: [
      { name: 'heading', version: 1, label: '标题', icon: 'H', editor: 'text+level', builtin: true, rendererKind: 'declarative', schema: { text: { type: 'string', required: true, singleLine: true, maxLength: 300, label: '标题文字' }, level: { type: 'number', min: 1, max: 6, default: 1, label: '级别' } } },
      { name: 'poll', version: 1, label: '投票', icon: '📊', editor: 'poll', builtin: true, rendererKind: 'declarative', schema: { question: { type: 'string', required: true, singleLine: true, maxLength: 200, label: '问题' }, options: { type: 'options', minItems: 2, maxItems: 10, label: '选项' }, multiple: { type: 'boolean', default: false, label: '可多选' } } },
      { name: 'table', version: 1, label: '表格', icon: '▦', editor: 'table', builtin: true, rendererKind: 'declarative', schema: { rows: { type: 'rows', default: [], maxRows: 50, maxCols: 12, label: '表格' } } },
    ],
  },
  '/api/docs/meta/templates': {
    templates: [
      { key: 'blank', title: '空白', description: '一块空正文' },
      { key: 'wiki', title: '双链 wiki', description: '带修订记录的条目' },
    ],
    kinds: [
      { value: 'post', label: '积木帖子' },
      { value: 'note', label: '笔记' },
      { value: 'profile', label: '个人主页' },
    ],
    scopes: [
      { value: 'public', label: '公开' },
      { value: 'followers', label: '仅关注我的人' },
      { value: 'team', label: '仅团队' },
      { value: 'private', label: '仅自己' },
    ],
  },
  '/api/docs': {
    total: 1,
    page: 1,
    limit: 20,
    documents: [
      {
        id: 1,
        kind: 'post',
        kindLabel: '积木帖子',
        title: '采样用的积木帖子',
        scope: 'public',
        scopeLabel: '公开',
        template: 'wiki',
        anchorPostId: FIXTURE_POST_ID,
        author: { id: 1, username: FIXTURE_USERNAME, displayName: '站长', avatar: null, role: 'owner' },
        createdAt: Date.now() - 86400000,
        updatedAt: Date.now() - 3600000,
        edited: true,
      },
    ],
  },
  '/api/docs/1': {
    doc: {
      id: 1,
      kind: 'post',
      kindLabel: '积木帖子',
      title: '采样用的积木帖子',
      scope: 'public',
      scopeLabel: '公开',
      template: 'wiki',
      anchorPostId: FIXTURE_POST_ID,
      sandboxDisabled: false,
      deleted: false,
      author: { id: 1, username: FIXTURE_USERNAME, displayName: '站长', avatar: null, role: 'owner' },
      createdAt: Date.now() - 86400000,
      updatedAt: Date.now() - 3600000,
      edited: true,
    },
    blocks: [
      { blockId: 'b1', type: 'heading', version: 1, props: { text: '采样标题', level: 2 } },
      { blockId: 'b2', type: 'poll', version: 1, props: { question: '选哪个？', options: [{ id: 'o1', text: '甲' }, { id: 'o2', text: '乙' }], multiple: false } },
    ],
    html: '<div class="doc-block doc-block-heading" data-block-id="b1" data-block-type="heading"><h2>采样标题</h2></div>\n<div class="doc-block doc-block-unknown" data-block-id="b9" data-block-type="ghost">这一块降级了</div>',
    warnings: [{ block_id: 'b9', code: 'unknown_type', message: '不认识的块类型：ghost' }],
    abilities: { canView: true, canEdit: true, canReact: true, canCoin: true },
  },
  '/api/docs/1/markdown': { title: '采样用的积木帖子', markdown: '## 采样标题\n\n- 甲\n- 乙', updatedAt: Date.now() - 3600000 },
  '/api/docs/1/revisions': {
    revisions: [
      { revision: 2, reason: 'edit', reasonLabel: '编辑', authorId: 1, author: { id: 1, username: FIXTURE_USERNAME, displayName: '站长' }, createdAt: Date.now() - 3600000 },
      { revision: 1, reason: 'create', reasonLabel: '创建', authorId: 1, author: { id: 1, username: FIXTURE_USERNAME, displayName: '站长' }, createdAt: Date.now() - 86400000 },
    ],
  },
  // 团队（P4）的路由是 `#/teams`（列表）与 `#/team/<slug>`（主页）。
  // 采集器还没采这几条，先手工给真形状 —— 接口形状改了就跟着改这里。
  '/api/teams': {
    items: [TEAM_FIXTURE],
    page: 1,
    perPage: 20,
    total: 1,
    totalPages: 1,
    filter: 'all',
  },
  '/api/teams/frontend-group': {
    team: TEAM_FIXTURE,
    members: [
      {
        user: { id: 1, username: FIXTURE_USERNAME, displayName: '站长', avatar: null, role: 'owner' },
        teamRole: 'owner',
        teamRoleLabel: '创建者',
        joinedAt: Date.now() - 86400000,
      },
    ],
    memberTotal: 1,
    scopes: SCOPES,
  },
  '/api/teams/frontend-group/posts': {
    items: [
      {
        id: 1,
        teamId: 1,
        team: { id: 1, slug: 'frontend-group', name: '前端小组' },
        title: '团队第一条帖子',
        content: '大家好，这里是团队的地盘。',
        contentHtml: '<p>大家好，这里是团队的地盘。</p>',
        scope: 'team',
        scopeLabel: '仅团队',
        scopeIcon: '🎽',
        version: 2,
        author: { id: 1, username: FIXTURE_USERNAME, displayName: '站长', avatar: null, role: 'owner' },
        editor: { id: 1, username: FIXTURE_USERNAME, displayName: '站长' },
        canEdit: true,
        canDelete: true,
        createdAt: Date.now() - 7200000,
        updatedAt: Date.now() - 3600000,
        edited: true,
      },
    ],
    page: 1,
    perPage: 20,
    total: 1,
    totalPages: 1,
    scopes: SCOPES,
    myRole: 'owner',
  },
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
/** 所有请求都记下来：点按钮的那条路径里「到底发出去了什么」只有这里看得到。 */
const REQUESTS = [];

let fetchCount = 0;
globalThis.fetch = async (url, options = {}) => {
  fetchCount += 1;
  const raw = String(url).replace(/^https?:\/\/[^/]+/, '');
  const method = String(options.method || 'GET').toUpperCase();
  REQUESTS.push({ url: raw, method, body: options.body ? JSON.parse(options.body) : null });
  // 建团队：假数据里给它一条真形状的响应（否则 data.team.slug 会是 undefined，报错像是代码坏了）
  const created = { team: { ...TEAM_FIXTURE, slug: 'new-team-1', name: '新团队' } };
  const data = method === 'POST' && raw.split('?')[0] === '/api/teams' ? created : pickFixture(raw);
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
  // v2 首页 = 动态时间线
  ['动态首页', 'timeline.js', 'viewTimeline', [new Map()]],
  ['动态·我关注的', 'timeline.js', 'viewTimeline', [new URLSearchParams({ filter: 'following' })]],
  ['动态·搜索', 'timeline.js', 'viewTimeline', [new URLSearchParams({ q: '采样' })]],
  // v1 的帖子列表页：`#/` 已经不再走它们了，但函数还在、还能渲染，
  // 所以继续测 —— 哪天要下线这批代码，删函数的同时把这四行一起删。
  ['帖子列表（旧首页）', 'feed.js', 'viewHome', [new Map()]],
  ['版块（已下线）', 'feed.js', 'viewBoard', ['general', new Map()]],
  ['帖子搜索（旧）', 'feed.js', 'viewSearch', [new Map()]],
  ['收藏', 'feed.js', 'viewBookmarks', [new Map()]],
  ['关注流（旧）', 'feed.js', 'viewFollowing', []],
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
  // v2 积木（可编程帖子）的四个页面。正文 HTML 由后端出，这里测的是外壳会不会炸。
  ['积木广场', 'doc.js', 'viewDocs', [new Map()]],
  ['积木阅读页', 'doc.js', 'viewDoc', [1]],
  ['积木编辑器', 'doc.js', 'viewDocEdit', [1, new Map()]],
  ['积木 Markdown 模式', 'doc.js', 'viewDocEdit', [1, new Map([['mode', 'markdown']])]],
  ['块类型表', 'doc.js', 'viewBlocks', []],
  // 没建过的那一页：走的是「还不存在」分支（`found:false`），因此必渲染成一张建页卡。
  ['Wiki 页面', 'doc.js', 'viewWiki', ['没建过的页', new Map()]],
  // v2 团队（P4）的两个页面。slug 必须和上面 EXTRA 里的键对得上，
  // 否则假 fetch 只会回一个空壳 —— 页面照样不炸，但等于什么都没测到。
  ['团队列表', 'team.js', 'viewTeams', [new Map()]],
  ['团队·我加入的', 'team.js', 'viewTeams', [new Map([['mine', '1']])]],
  ['团队主页', 'team.js', 'viewTeam', ['frontend-group', new Map()]],
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

/* ---------- 4. 交互：编辑框里的草稿必须扛得住外壳重画 ---------- */
/*
 * 为什么单独测这三条：动态首页的编辑框是**模块级状态 + 重画外壳**的组合，
 * 而「点赞/取消编辑/保存/删除」都会走 `renderShell()`。
 * 一旦状态漏同步，用户正在写的字就会在点一下别的按钮之后无声消失 ——
 * 渲染类断言（上面 21 个页面）**永远发现不了**，因为渲染只关心有没有画出东西。
 */
{
  const timeline = await view('timeline.js');
  const input = registered('[data-feed-input]');
  const scope = registered('[data-feed-scope]');
  const refInput = registered('[data-feed-ref-input]');

  // 假 DOM 不解析 HTML，所以「用户打字 / 选范围」用派发事件来模拟。
  // 真实浏览器里 target 就是那个输入框（值在派发之前已经改好了），这里照做。
  const fire = (element, type, selector, value) => {
    element.value = value;
    element.matches = (candidate) => candidate === selector;
    dispatch(app, type, element);
  };
  fire(input, 'input', '[data-feed-input]', '半截草稿，还没写完');
  fire(refInput, 'input', '[data-feed-ref-input]', '12');
  fire(scope, 'change', '[data-feed-scope]', 'private');

  if (input.value !== '半截草稿，还没写完') problems.push('草稿没有在 input 事件里同步进模块状态');
  if (scope.value !== 'private') problems.push('可见范围没有在 change 事件里同步进模块状态');

  // 重画一次外壳（viewTimeline 会先 renderShell() 再取数据）
  await timeline.viewTimeline(new Map());

  if (renderCount === 0) problems.push('整轮测试里一次外壳重画都没有触发，假 DOM 的近似没生效');
  if (input.value !== '半截草稿，还没写完') problems.push(`外壳重画后草稿丢了（现在是 ${JSON.stringify(input.value)}）`);
  if (scope.value !== 'private') problems.push(`外壳重画后可见范围回到了 ${JSON.stringify(scope.value)}`);
  if (refInput.value !== '12') problems.push(`外壳重画后引用输入框里的编号丢了（现在是 ${JSON.stringify(refInput.value)}）`);
  console.log(`  ${problems.length ? '❌' : '✅'} 交互：外壳重画后草稿 / 可见范围 / 引用编号都还在（重画 ${renderCount} 次）`);

  /* ---- 引用帖子：用掉的编号不能留在框里，取消引用不能留下旧标题 ---- */
  const refRow = registered('[data-feed-ref-row]');
  const chip = registered('[data-feed-ref-chip]');

  // 真实 DOM 里输入框就在这一行里面，假 DOM 得自己接上这个父子关系
  refInput.closest = (selector) => (selector === '[data-feed-ref-row]' ? refRow : null);
  fire(refInput, 'input', '[data-feed-ref-input]', '1');
  refInput.closest = (selector) => (selector === '[data-feed-ref-row]' ? refRow : null);
  dispatch(app, 'keydown', refInput, { key: 'Enter' });
  await settle();

  if (refInput.value !== '') problems.push(`引用确认之后编号还留在框里（现在是 ${JSON.stringify(refInput.value)}），下次重画就会冒出来`);
  if (!String(chip.innerHTML).includes('引用')) problems.push('引用确认之后没看到那颗 chip');

  // 点「取消引用」：chip 必须清空
  const clearNode = { dataset: { feedAction: 'clear-ref' }, matches: () => false };
  clearNode.closest = (selector) => (selector === '[data-feed-action]' ? clearNode : null);
  dispatch(app, 'click', clearNode);
  await settle();

  if (String(chip.innerHTML).trim() !== '') {
    problems.push(`点了「取消引用」之后 chip 里还留着 ${JSON.stringify(String(chip.innerHTML).slice(0, 40))}`);
  }
  console.log(`  ${problems.length ? '❌' : '✅'} 交互：引用确认后编号会腾空、取消引用后 chip 会清空`);
}

/* ---- 交互：点「＋ 新建团队」必须真的把表单打开 ----
 *
 * 为什么单独测这一条：团队列表页的 `viewTeams()` 一进来就 `resetTransient()`，
 * 而 `resetTransient()` 会把 `panel` 清成 null。于是「先设 panel = 'create'、
 * 再重画页面」这个写法会自己把刚点开的面板抹掉 —— 用户看到的现象是
 * **点「＋ 新建团队」毫无反应**，而渲染类断言全绿（页面确实画出来了，
 * 画出来的是那个还没被点开的按钮）。这类「点了等于没点」只有真派发一次点击才测得到。
 */
{
  // 这一段自己有 try/catch：脚本装了 uncaughtException / unhandledRejection 处理器，
  // 顶层 await 之后抛出来的异常会被它们吞掉（表现是「跑到这里就没了、exit=0、什么错都不报」）。
  // 包一层才能看见真正的错 —— 写这段时正是被这个坑住了很久。
  try {
    const team = await view('team.js');
    const createBox = registered('[data-team-create]');

    await team.viewTeams(new Map());
    if (String(createBox.innerHTML).includes('data-team-field="name"')) {
      problems.push('团队列表一渲染就把新建表单展开了（应该是折叠的）');
    }

    // 点「＋ 新建团队」：真实 DOM 里事件目标是按钮本身，closest 往上找到带 data-team-action 的它
    const openNode = { dataset: { teamAction: 'open-create' }, matches: () => false };
    openNode.closest = (selector) => (selector === '[data-team-action]' ? openNode : null);
    dispatch(app, 'click', openNode);
    await settle();

    const opened = String(createBox.innerHTML).includes('data-team-field="name"');
    if (!opened) {
      problems.push('点了「＋ 新建团队」之后表单没出现 —— panel 被重画页面时的 resetTransient() 抹掉了');
    }

    // 填名字 → 点「建好了」：请求体里必须有这个名字，建完还要跳到新团队的主页。
    // 假 DOM 不解析 HTML，属性得手工补：`closest` 接上父子关系（team.js 读的是
    // `event.target.closest('[data-team-field]')`，不是 matches），`dataset.teamField` 是它真正读的字段名。
    const nameInput = registered('[data-team-field="name"]');
    nameInput.value = '前端小组·新';
    nameInput.closest = (selector) => (selector === '[data-team-field]' ? nameInput : null);
    nameInput.dataset.teamField = 'name';
    dispatch(app, 'input', nameInput);

    const submitNode = { dataset: { teamAction: 'create-team' }, disabled: false, matches: () => false };
    submitNode.closest = (selector) => (selector === '[data-team-action]' ? submitNode : null);
    REQUESTS.length = 0;
    dispatch(app, 'click', submitNode);
    await settle();

    const post = REQUESTS.find((item) => item.method === 'POST' && item.url.split('?')[0] === '/api/teams');
    if (!post) problems.push('点「建好了」之后没有发出 POST /api/teams');
    else if (post.body?.name !== '前端小组·新') {
      problems.push(`建团队发出去的队名不对：${JSON.stringify(post.body?.name)}（草稿没有从输入框同步进 teamState.draft）`);
    }
    // 真浏览器里 location.hash 会自动带上 `#`，假 DOM 不会 —— 两种都认。
    if (!String(window.location.hash).replace(/^#/, '').startsWith('/team/')) {
      problems.push(`建完团队没有跳到团队主页（hash = ${JSON.stringify(window.location.hash)}）`);
    }

    console.log(`  ${problems.length ? '❌' : '✅'} 交互：新建团队的表单能打开、队名能提交、建完会跳转`);
  } catch (error) {
    problems.push(`团队交互测试自身崩了：${error?.stack || error}`);
    console.log('  ❌ 交互：新建团队的表单能打开、队名能提交、建完会跳转');
  }
}

/* ---- 静态扫描：不许出现「裸调用一个既没 import、也没在本文件声明」的名字 ----
 *
 * 为什么加这一段：`public/core/events.js` 与 `public/core/session.js` 曾经只 `import * as Router`
 * 却直接写 `navigate('/')`，于是「退出登录 / 登录成功 / 发帖成功 / 搜索」这四条路径一点就
 * `navigate is not defined`。渲染测试全绿 —— 因为这几条路径只在**用户点了按钮**时才走到。
 * 这类错误 lint 不跑就没人看得见，所以在这里钉住。
 */
{
  const walkJs = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walkJs(join(dir, entry.name)) : [join(dir, entry.name)],
    );

  // 关键字不是函数名；浏览器/Node 内置的全局可以随便调。
  const NOT_A_CALL = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'new', 'delete',
    'await', 'case', 'do', 'else', 'in', 'of', 'void', 'yield', 'throw', 'super', 'this', 'async',
  ]);
  const BUILT_IN = new Set([
    'document', 'window', 'console', 'fetch', 'JSON', 'Math', 'Object', 'Array', 'String', 'Number',
    'Boolean', 'Promise', 'Set', 'Map', 'Date', 'Error', 'URL', 'URLSearchParams', 'setTimeout',
    'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame',
    'alert', 'confirm', 'prompt', 'isNaN', 'parseInt', 'parseFloat', 'encodeURIComponent',
    'decodeURIComponent', 'localStorage', 'sessionStorage', 'navigator', 'IntersectionObserver',
    'MutationObserver', 'WeakMap', 'Symbol', 'RegExp', 'Intl', 'queueMicrotask', 'structuredClone',
    'CustomEvent', 'Event', 'FormData', 'Blob', 'FileReader', 'TextEncoder', 'btoa', 'atob',
    'history', 'location', 'getComputedStyle', 'matchMedia', 'Image', 'Audio', 'Notification',
    'Element', 'Function', 'globalThis', 'undefined', 'NaN', 'Infinity',
  ]);

  // 先把注释和字符串（含跨行模板串）整个抠掉，只留空格，行号才不会跑偏。
  const blankOut = (source) =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
      .replace(/'(?:[^'\\\n]|\\.)*'/g, '""')
      .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
      .replace(/`(?:[^`\\]|\\.)*`/g, (m) => m.replace(/[^\n]/g, ' '));

  const namesKnownTo = (source) => {
    const known = new Set();
    for (const m of source.matchAll(/import\s*(?:\*\s*as\s+([\w$]+)|\{([^}]*)\}|([\w$]+))\s*from/g)) {
      if (m[1]) known.add(m[1]);
      if (m[2]) for (const part of m[2].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop().trim();
        if (name) known.add(name);
      }
      if (m[3]) known.add(m[3]);
    }
    for (const m of source.matchAll(/\b(?:function|class|const|let|var)\s+([\w$]+)/g)) known.add(m[1]);
    for (const m of source.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}/g)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(':').pop().split('=')[0].trim();
        if (name) known.add(name);
      }
    }
    for (const m of source.matchAll(/\b(?:const|let|var)\s*\[([^\]]*)\]/g)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split('=')[0].trim();
        if (name) known.add(name);
      }
    }
    for (const m of source.matchAll(/function\s*[\w$]*\s*\(([^)]*)\)/g)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split('=')[0].trim().replace(/^\.\.\./, '');
        if (name) known.add(name);
      }
    }
    for (const m of source.matchAll(/\(([^()]*)\)\s*=>/g)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split('=')[0].trim().replace(/^\.\.\./, '');
        if (name) known.add(name);
      }
    }
    for (const m of source.matchAll(/([\w$]+)\s*=>/g)) known.add(m[1]);
    return known;
  };

  let scanned = 0;
  const publicDir = join(ROOT, 'public');
  for (const file of walkJs(publicDir).filter((item) => item.endsWith('.js'))) {
    const raw = readFileSync(file, 'utf8');
    const known = namesKnownTo(raw);
    const lines = blankOut(raw).split('\n');
    scanned++;
    lines.forEach((line, index) => {
      for (const m of line.matchAll(/(?<![\w.$])([a-zA-Z_$][\w$]*)\s*\(/g)) {
        const name = m[1];
        if (NOT_A_CALL.has(name) || BUILT_IN.has(name) || known.has(name)) continue;
        problems.push(
          `${file.slice(ROOT.length + 1)}:${index + 1} 裸调用了 ${name}() —— 既没 import 也没在本文件声明，点到这条路径就会 ReferenceError`,
        );
      }
    });
  }
  if (scanned < 25) problems.push(`只扫到 ${scanned} 个前端模块，文件枚举八成坏了（正常是二十九个）`);
  console.log(`  ${problems.length ? '❌' : '✅'} 静态：${scanned} 个前端模块里没有「裸调用未定义的名字」`);
}

if (problems.length) {
  console.log('\n发现的问题：');
  for (const item of problems) console.log(`  ❌ ${item}`);
  process.exit(1);
}
console.log(`  ✅ ${CASES.length} 个页面全部渲染通过，state 已就位`);
process.exit(0);
