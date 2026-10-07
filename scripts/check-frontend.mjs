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
    select() {},
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
/**
 * `document.execCommand('copy')` 的调用记录。
 *
 * 非安全上下文（http + 局域网 IP）里 `navigator.clipboard` 是 undefined，团队号的
 * 「复制」按钮只能靠 textarea + execCommand 这一档 —— 这个数组就是那条路走没走通的证据。
 * 见 `public/core/dom.js` 的 `copyText()`。
 */
const execCommands = [];
const root = {
  documentElement,
  body: makeElement('body'),
  createElement: (tag) => makeElement(tag),
  createTextNode: (text) => ({ textContent: text }),
  execCommand: (command) => { execCommands.push(command); return true; },
  /**
   * `copyText()` 的 execCommand 那一档会先读一次「用户原本的选区」，复制完再还回去
   * （见 `public/core/dom.js` 的 `execCommandCopy`）。假 DOM 里没有选区，
   * 给一个空选区就够了：那条路照常走到 `execCommand('copy')`。
   */
  getSelection: () => null,
  createRange: () => ({ selectNodeContents() {}, setStart() {}, setEnd() {} }),
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

// 假 localStorage 要能**真的存取**：个人主页三种排版（列表 / 卡片 / 紧凑）就靠它记住选择，
// 恒返回 null 的桩会让「排版切了却没换」这类问题在测试里完全看不见。
const prefStore = new Map();

globalThis.document = root;
globalThis.window = {
  document: root,
  location: { hash: '', href: 'http://localhost/', pathname: '/', search: '' },
  localStorage: {
    getItem: (key) => (prefStore.has(key) ? prefStore.get(key) : null),
    setItem: (key, value) => {
      prefStore.set(key, String(value));
    },
    removeItem: (key) => {
      prefStore.delete(key);
    },
    clear: () => prefStore.clear(),
  },
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
  canApply: false,
  // 「申请加入」那几个字段：站长自己是创建者，没有申请要递，也看不到自己的申请记录；
  // 待审条数只在管理员视角才有值（服务端对非管理员一律给 0）。
  myRequest: null,
  pendingRequestCount: 0,
  // 「藏在团队广场外面」这个开关：默认是出现在广场上。
  listed: true,
  // 团队号与公告只给成员看（服务端在 shape.js 里就拦掉了），站长视角两个都有。
  joinCode: 'K7M2QP',
  announcement: {
    text: '周五晚上八点，聊一下下个版本做啥。',
    editedAt: Date.now() - 1800000,
    author: { id: 1, username: FIXTURE_USERNAME, displayName: '站长' },
  },
  createdAt: Date.now() - 86400000,
  updatedAt: Date.now() - 3600000,
};

/**
 * 非成员视角的同一个团队：`joinCode` 与 `announcement` 都是 null。
 * 专门用来断言「页面上不会把团队号画给外人」—— 这正是服务端那道门的意义所在。
 */
const OUTSIDER_TEAM_FIXTURE = {
  ...TEAM_FIXTURE,
  slug: 'outsider-group',
  name: '路过的团队',
  myRole: null,
  myRoleLabel: null,
  canManage: false,
  joined: false,
  canJoin: true,
  canApply: false,
  joinCode: null,
  announcement: null,
};

/**
 * 「需要申请」的团队（`joinPolicy: 'apply'`），路人视角：不能直接进，只能递申请。
 *
 * 这一份夹具专门守着「申请加入」这条线 —— 少画一个「申请加入」按钮，路人就再也进不来了。
 */
const APPLY_TEAM_FIXTURE = {
  ...OUTSIDER_TEAM_FIXTURE,
  slug: 'apply-group',
  name: '要审核的团队',
  joinPolicy: 'apply',
  joinPolicyLabel: '需要申请',
  canJoin: false,
  canApply: true,
};

/** 同一个人递完申请之后的样子：申请记录挂着，按钮变成「撤回申请」，不能再递第二次。 */
const PENDING_TEAM_FIXTURE = {
  ...APPLY_TEAM_FIXTURE,
  slug: 'pending-group',
  name: '等审核的团队',
  canApply: false,
  myRequest: { id: 7, status: 'pending', createdAt: Date.now() - 600000 },
};

/**
 * 待审申请列表（`GET /api/teams/<slug>/join-requests` 的 items）。
 *
 * 两条都用得上：一条带了理由、一条没写 —— 空理由那一条在页面上会画成「（没写理由）」，
 * 少了这个分支，用户会以为界面坏了。
 */
const TEAM_JOIN_REQUEST_FIXTURES = [
  {
    id: 41,
    teamId: 1,
    status: 'pending',
    statusLabel: '等待审核',
    message: '我想进来看看，写过两年 Vue。',
    user: { id: 9, username: 'newcomer', displayName: '新来的', avatar: null },
    decidedAt: null,
    decidedBy: null,
    createdAt: Date.now() - 900000,
    updatedAt: Date.now() - 900000,
    mine: false,
    canDecide: true,
  },
  {
    id: 40,
    teamId: 1,
    status: 'pending',
    statusLabel: '等待审核',
    message: '',
    user: { id: 10, username: 'quiet', displayName: '闷葫芦', avatar: null },
    decidedAt: null,
    decidedBy: null,
    createdAt: Date.now() - 1800000,
    updatedAt: Date.now() - 1800000,
    mine: false,
    canDecide: true,
  },
];

/**
 * 团队帖详情页与列表页共用的一条帖子。
 *
 * 服务端两个接口下发的是同一个 shape（`shapeTeamPost`），所以夹具也只留一份 ——
 * 哪天 `replyCount` 之类的字段改了名，这里改一处，列表页和详情页一起跟着变。
 */
const TEAM_POST_FIXTURE = {
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
  // 列表页上那个「💬 N 条回复」徽标读的就是它。
  replyCount: 2,
  author: { id: 1, username: FIXTURE_USERNAME, displayName: '站长', avatar: null, role: 'owner' },
  editor: { id: 1, username: FIXTURE_USERNAME, displayName: '站长' },
  canEdit: true,
  canDelete: true,
  createdAt: Date.now() - 7200000,
  updatedAt: Date.now() - 3600000,
  edited: true,
};

/**
 * 帖子下面的两条回复：第一条是站长自己写的（能删），第二条是别人写的（删不了）。
 * 「只给作者和管理员画删除按钮」这条规矩就靠第二条来验。
 */
const TEAM_REPLY_FIXTURES = [
  {
    id: 11,
    postId: 1,
    teamId: 1,
    content: '那我把接口先定下来，晚上发群里。',
    contentHtml: '<p>那我把接口先定下来，晚上发群里。</p>',
    author: { id: 1, username: FIXTURE_USERNAME, displayName: '站长', avatar: null, role: 'owner' },
    canDelete: true,
    createdAt: Date.now() - 1800000,
  },
  {
    id: 12,
    postId: 1,
    teamId: 1,
    content: '接口清单我补了两条，见文件柜。',
    contentHtml: '<p>接口清单我补了两条，见文件柜。</p>',
    author: { id: 2, username: FIXTURE_PEER, displayName: '小狐', avatar: null, role: 'member' },
    canDelete: false,
    createdAt: Date.now() - 600000,
  },
];

const EXTRA = {
  // 「看别人的主页」视角：把采样到的**自己**主页夹具翻一个 `isMe`。
  // 页面用例里那一条个人主页跑的是自己视角（夹具 `/api/users/admin` 的 `user.isMe`
  // 就是 true），文案与卡片位置都跟自己视角绑着，所以别人视角得单独摆一份。
  '/api/users/not-me': {
    ...FIXTURES['/api/users/admin'],
    user: { ...FIXTURES['/api/users/admin'].user, isMe: false, username: 'not-me', displayName: '别人' },
  },
  '/api/markdown/preview': { html: '<p>ok</p>' },
  // AI 助手：这份夹具故意给「有整理结果 + 主题 + 篇数超过一屏」的真实形状，
  // 因为线上就是这个形状（554 篇文档 / 166 篇在主题里 / 171 篇逐篇分类）。只给
  // `configured:false` 的空壳会让整块 `<details>` 折叠、筛选与「只显示前 30 条」的
  // 渲染路径一次都跑不到。35 篇 > AI_LIST_LIMIT(30)，正好压到 data-clip 那条分支。
  '/api/ai/site': {
    configured: true,
    ready: true,
    stale: false,
    stats: { analyzed: 337, failed: 1, documents: 554, pending: 393, corpus: { documents: 554, replies: 3, chars: 192724, posts: 554 } },
    report: { status: 'done', model: 'deepseek-flash', createdAt: Date.now() - 3600000, documentCount: 554, summary: '全站帖子按主题聚类后的知识地图。' },
    topics: [
      {
        name: '语言基础、工具环境与竞赛入门',
        difficulty: '入门',
        prereq: [],
        summary: '从 Hello, World! 到本地环境。',
        posts: [{ id: 117, title: 'Hello, World!', board: '积木', author: 'admin', summary: '第一份代码。' }],
      },
      {
        name: '算法基础：复杂度、排序、搜索与动态规划',
        difficulty: '进阶',
        prereq: ['语言基础'],
        posts: [{ id: 206, title: '动态规划部分简介', board: '积木', author: 'admin' }],
      },
    ],
    readingPath: [{ post: { id: 117, title: 'Hello, World!' }, level: '入门', reason: '先跑通再说。' }],
    posts: Array.from({ length: 35 }, (_, index) => ({
      id: 100 + index,
      title: `帖子标题 ${index + 1}`,
      board: '积木',
      author: 'admin',
      replyCount: index % 3,
      summary: index % 2 ? '' : `第 ${index + 1} 篇的摘要。`,
      // 前 30 篇已解读、后 5 篇未解读：三个筛选按钮与搜索都得有东西可筛。
      category: index < 30 ? '算法基础' : null,
      difficulty: index < 30 ? '入门' : null,
    })),
  },
  // 非成员视角的团队主页：详情里没有团队号、也没有公告（服务端就不给）。
  '/api/teams/outsider-group': { team: OUTSIDER_TEAM_FIXTURE, members: [], memberTotal: 0, scopes: SCOPES },
  // 列表里摆一条**别人发的**帖：`canEdit: false` 时不该画「编辑」，
  // 但「💬 回复」必须还在（点它就是「进详情页去回」）。
  '/api/teams/outsider-group/posts': {
    items: [
      {
        ...TEAM_POST_FIXTURE,
        canEdit: false,
        canDelete: false,
        scope: 'public',
        scopeLabel: '公开',
        scopeIcon: '🌍',
        replyCount: 1,
      },
    ],
    page: 1,
    perPage: 20,
    total: 1,
    totalPages: 1,
    sort: 'new',
  },
  // 「需要申请」的团队：路人只能递申请，不能直接进。这两个 slug 是申请那条线上的哨兵。
  '/api/teams/apply-group': { team: APPLY_TEAM_FIXTURE, members: [], memberTotal: 0, scopes: SCOPES },
  '/api/teams/apply-group/posts': { items: [], page: 1, perPage: 20, total: 0, totalPages: 0, sort: 'new' },
  // 已经递过申请、还在等审核：按钮要变成「撤回申请」，不能让他再递一次。
  '/api/teams/pending-group': { team: PENDING_TEAM_FIXTURE, members: [], memberTotal: 0, scopes: SCOPES },
  '/api/teams/pending-group/posts': { items: [], page: 1, perPage: 20, total: 0, totalPages: 0, sort: 'new' },
  // 管理员打开「加入申请」面板时拉的那份待审列表。路径比 `/api/teams/frontend-group`
  // 长，但 pickFixture 是精确比对，两条互不干扰。
  '/api/teams/frontend-group/join-requests': {
    items: TEAM_JOIN_REQUEST_FIXTURES,
    page: 1,
    perPage: 20,
    total: TEAM_JOIN_REQUEST_FIXTURES.length,
    totalPages: 1,
    status: 'pending',
    pendingTotal: TEAM_JOIN_REQUEST_FIXTURES.length,
  },
  // 团队帖详情 `#/team/<slug>/post/<id>`：一条帖子 + 它下面的回复。
  // 这两条的路径要写在 `/posts` 那一条**后面**（pickFixture 取最后一个匹配）。
  '/api/teams/frontend-group/posts/1': { post: TEAM_POST_FIXTURE },
  '/api/teams/frontend-group/posts/1/replies': {
    items: TEAM_REPLY_FIXTURES,
    page: 1,
    perPage: 20,
    total: 2,
    totalPages: 1,
  },
  // 非成员点进一篇公开帖：帖子看得见，回复框只剩一句「加入之后才能回复」。
  '/api/teams/outsider-group/posts/1': {
    post: {
      ...TEAM_POST_FIXTURE,
      team: { id: 2, slug: 'outsider-group', name: '路过的团队' },
      scope: 'public',
      scopeLabel: '公开',
      scopeIcon: '🌍',
      canEdit: false,
      canDelete: false,
      replyCount: 1,
    },
  },
  '/api/teams/outsider-group/posts/1/replies': {
    items: [TEAM_REPLY_FIXTURES[0]],
    page: 1,
    perPage: 20,
    total: 1,
    totalPages: 1,
  },
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
  // 标签上限 + 「大家在用」。**必须给一条真的**：空表渲染不出标签徽章那段 HTML。
  '/api/docs/meta/tags': {
    maxTags: 5,
    maxTagLength: 24,
    tags: [
      { tag: '学术笔记', count: 7 },
      { tag: '公式', count: 3 },
    ],
  },
  // 开发者功能里的「我的脚本模板」。**必须给一条真的**：空表只会渲染出一句
  // 「还没有模板」，卡片那段 HTML（以及卡片里的 Fmt.timeAgo）根本没被跑到。
  '/api/docs/meta/script-templates': {
    limit: 50,
    maxName: 40,
    maxDescription: 200,
    maxCode: 20000,
    templates: [
      {
        id: 1,
        name: '打卡本',
        description: '每天点一下',
        code: '<h3>今天做了什么</h3>\n<button id="ping" type="button">记一笔</button>\n<script>\n  Sandbox.resize();\n</script>',
        createdAt: Date.now() - 86400000,
        updatedAt: Date.now() - 3600000,
      },
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
      // 阅读页与编辑器都要渲染标签；列表那一条（/api/docs）故意**不带** tags，
      // 顺带钉住「没有 tags 字段的老响应也不能炸」。
      tags: ['学术笔记', '公式'],
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
    abilities: { canView: true, canEdit: true, canReact: true },
  },
  '/api/docs/1/markdown': { title: '采样用的积木帖子', markdown: '## 采样标题\n\n- 甲\n- 乙', updatedAt: Date.now() - 3600000 },
  '/api/docs/1/revisions': {
    revisions: [
      { revision: 2, reason: 'edit', reasonLabel: '编辑', authorId: 1, author: { id: 1, username: FIXTURE_USERNAME, displayName: '站长' }, createdAt: Date.now() - 3600000 },
      { revision: 1, reason: 'create', reasonLabel: '创建', authorId: 1, author: { id: 1, username: FIXTURE_USERNAME, displayName: '站长' }, createdAt: Date.now() - 86400000 },
    ],
  },
  // 阅读页的互动条（点赞 / 收藏 / 转发 / AI 解读）与帖子页的「已经搬进积木」横幅，
  // 分别走这两条接口。**空夹具会让它们整段渲染不到**：互动条只会写一句「还没有互动锚点」，
  // 横幅压根不出现 —— 渲染测试照样全绿，等于新代码没被跑过。所以这里给真形状：
  // `/anchor` 回的是**列表形状**的影子帖（见 `src/modules/doc/routes.js`），
  // 逐字对齐 `shapePostListRow`，一个字段都不能少（少一个按钮就少一个）。
  '/api/docs/1/anchor': {
    post: {
      id: Number(FIXTURE_POST_ID),
      title: '采样用的积木帖子',
      excerpt: '采样 正文一段。',
      board: { id: 6, slug: 'documents', name: '积木', icon: '🧩' },
      author: { id: 1, username: FIXTURE_USERNAME, displayName: '站长', role: 'owner', avatar: 'emoji:🧭:212' },
      category: null,
      profilePinned: false,
      views: 3,
      replyCount: 0,
      likeCount: 2,
      dislikeCount: 0,
      bookmarkCount: 1,
      repostCount: 0,
      liked: true,
      disliked: false,
      bookmarked: true,
      reposted: false,
      authorFollowed: true,
      hidden: false,
      hiddenAt: null,
      hiddenReason: '',
      hiddenBy: null,
      pinned: false,
      locked: false,
      createdAt: Date.now() - 86400000,
      updatedAt: Date.now() - 3600000,
      lastActiveAt: Date.now() - 3600000,
    },
  },
  // 反查「这条帖子是不是某篇积木的影子行」。有值 → 帖子页顶上出现横幅（`movedNoteHtml`）。
  [`/api/docs/by-anchor/${FIXTURE_POST_ID}`]: { doc: { id: 1, title: '采样用的积木帖子', scope: 'public' } },
  // P3 的 AI 编辑台（能力目录 / 审计 / 全站用量）。采集器还没采这三条，先手工给真形状，
  // 形状以 `src/modules/ai/routes.js` 的 capabilities / shapeOp / usage 三处为准。
  // 【为什么必须带上 expiresAt 与 rolledBackAt】这两处曾经写成 `Fmt.time(...)`，而
  // `public/core/format.js` 只导出 timeAgo / fullTime —— 于是线上 `#/ai-edit` 整页
  // `TypeError: Fmt.time is not a function`。空夹具下这两行根本渲染不到，渲染测试照样全绿，
  // 所以夹具里必须有「已授权的临时授权」和「已落盘 + 已回滚过」的记录把这两行真的跑一遍。
  '/api/ai-edit/capabilities': {
    capabilities: [
      { key: 'read_post', label: '读帖子', risk: 'low', highRisk: false, granted: true, dailyQuota: 50, usedToday: 3, expiresAt: Date.now() + 86400000 },
      { key: 'edit_content', label: '改内容', risk: 'high', highRisk: true, granted: false, dailyQuota: 0, usedToday: 0, expiresAt: null },
    ],
  },
  '/api/ai-edit/ops': {
    ops: [
      {
        id: 12,
        capability: 'edit_content',
        action: 'apply',
        targetType: 'document_block',
        targetId: '1:b2',
        status: 'rolled_back',
        reason: '采样：把段落改成投票',
        before: { type: 'paragraph', props: { text: '旧正文' } },
        after: { type: 'poll', props: { question: '选哪个？', options: [{ id: 'o1', text: '甲' }, { id: 'o2', text: '乙' }], multiple: false } },
        createdAt: Date.now() - 7200000,
        rolledBackAt: Date.now() - 3600000,
        canRollback: false,
      },
      {
        id: 13,
        capability: 'edit_content',
        action: 'apply',
        targetType: 'document_block',
        targetId: '1:b1',
        status: 'applied',
        reason: '',
        before: { type: 'quote', props: { text: '旧引用' } },
        after: { type: 'heading', props: { text: '采样标题', level: 2 } },
        createdAt: Date.now() - 600000,
        rolledBackAt: null,
        canRollback: true,
      },
    ],
    total: 2,
    limit: 30,
  },
  '/api/ai-edit/usage': {
    scope: 'site',
    since: Date.now() - 3600000,
    today: {
      total: 5,
      billed: 3,
      blocked: 1,
      users: 1,
      byAction: [{ action: 'apply', count: 3 }, { action: 'draft', count: 2 }],
      topUsers: [{ userId: 1, username: FIXTURE_USERNAME, displayName: '站长', count: 5 }],
      // token / 金额也必须是真形状（`tokens` + `cost` + 顶层 `pricing`）：渲染测试只走到
      // 夹具给得出来的分支，缺了这几块，「今日花费 ¥x」那一行永远不会被渲染到，
      // 就算它把 `Fmt.fmtNum` 写成不存在的东西也照样全绿（这个坑踩过一次，见上面 660 行）。
      // `missing: 1` 是故意的：要让「有几次没拿到用量」那句警告也真的渲染一遍。
      tokens: { prompt: 12000, cached: 4000, completion: 3000, total: 15000, calls: 3, missing: 1 },
      cost: { yuan: 0.02008, peakYuan: 0, offPeakYuan: 0.02008, currency: 'CNY', unit: '元/百万 tokens' },
    },
    allTime: {
      total: 42,
      tokens: { prompt: 300000, cached: 90000, completion: 50000, total: 350000, calls: 42, missing: 0 },
      cost: { yuan: 0.8236, peakYuan: 0.4, offPeakYuan: 0.4236, currency: 'CNY', unit: '元/百万 tokens' },
    },
    pricing: {
      model: 'deepseek-flash',
      known: true,
      label: 'DeepSeek-V4.1-Flash',
      inputMiss: 2,
      inputHit: 0.04,
      output: 8,
      unit: '元/百万 tokens',
      currency: 'CNY',
      offPeakFactor: 0.5,
      peakNow: false,
      source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
      envKeys: {
        inputMiss: 'AI_PRICE_INPUT_PER_M',
        inputHit: 'AI_PRICE_CACHE_HIT_PER_M',
        output: 'AI_PRICE_OUTPUT_PER_M',
      },
      note: '按官方价目表算（DeepSeek-V4.1-Flash）：缓存未命中输入 2、缓存命中输入 0.04、输出 8 元/百万 tokens（高峰价，空闲时段减半）；此刻是空闲时段。',
    },
    budget: { envKey: 'AI_DAILY_TOTAL_LIMIT', unlimited: true, limit: 0, used: 0, remaining: null },
    note: '次数与 token 用量分开统计：次数是配额闸门的口径，金额 = token × 单价（按调用时刻的高峰/空闲档位估算，单价抄自官方价目表）。',
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
    // 故意比 members 多一个：详情页只列前一批，多出来的人要点「查看全部」才拉 ——
    // 交互测试正是冲着这个入口去的。
    memberTotal: 2,
    scopes: SCOPES,
  },
  '/api/teams/frontend-group/posts': {
    items: [TEAM_POST_FIXTURE],
    page: 1,
    perPage: 20,
    total: 1,
    totalPages: 1,
    scopes: SCOPES,
    myRole: 'owner',
  },
  // 成员名单（点「查看全部 N 位成员」时拉的那条）与团队的两块新区域。
  '/api/teams/frontend-group/members': {
    items: [
      {
        user: { id: 1, username: FIXTURE_USERNAME, displayName: '站长', avatar: null, role: 'owner' },
        teamRole: 'owner',
        teamRoleLabel: '创建者',
        joinedAt: Date.now() - 86400000,
      },
      {
        user: { id: 2, username: FIXTURE_PEER, displayName: '小狐', avatar: null, role: 'member' },
        teamRole: 'member',
        teamRoleLabel: '成员',
        joinedAt: Date.now() - 3600000,
      },
    ],
    total: 2,
  },
  '/api/teams/frontend-group/files': {
    items: [
      {
        id: 7,
        teamId: 1,
        team: { id: 1, slug: 'frontend-group', name: '前端小组' },
        name: '团队约定.md',
        size: 2048,
        sizeLabel: '2.0 KB',
        mime: 'text/markdown',
        uploader: { id: 1, username: FIXTURE_USERNAME, displayName: '站长', avatar: null },
        downloadUrl: '/api/team-files/7',
        canDelete: true,
        createdAt: Date.now() - 1800000,
      },
    ],
    page: 1,
    perPage: 20,
    total: 1,
    totalPages: 1,
    maxBytes: 4 * 1024 * 1024,
  },
  '/api/teams/frontend-group/messages': {
    items: [
      {
        id: 21,
        teamId: 1,
        content: '晚上一起把文件柜试一下',
        author: { id: 1, username: FIXTURE_USERNAME, displayName: '站长', avatar: null, role: 'owner' },
        canDelete: true,
        createdAt: Date.now() - 600000,
      },
    ],
    latestId: 21,
    total: 1,
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

/**
 * 测试想让某一条路**回失败**时填的表：`'PUT /api/docs/1/markdown'` → `{status, code, message}`。
 *
 * 为什么需要：自动保存里有一段专门处理「服务端说这次改动会让块数暴跌」（409），
 * 而这条路只有在假 fetch 能按指令回 409 时才走得到 —— 否则那段代码测了等于没测。
 */
const FORCED_FAILURES = new Map();

/**
 * `/api/feed/:id/reaction` 的假服务端状态（`Map<动态 id, 'like' | 'dislike'>`）。
 *
 * 为什么要单独维护一份：真服务端的 `queries.setReaction()` 是「同一个再来一次 = 取消」，
 * 而这个接口**只收 `'like'` / `'dislike'` 两个字面量**（`src/modules/feed/routes.js` 的
 * bad_kind 校验）。前端要是自己算出「取消」再发个 null 过来，就该跟线上一样吃 400 ——
 * 这个 400 必须能在假 DOM 里复现，否则「手滑点错了取消不掉」这种 bug 永远照不出来。
 */
const FEED_REACTIONS = new Map();

/**
 * `/api/feed/:id/replies` 的假服务端状态（`Map<动态 id, 回复数组>`）。
 * 语义照抄 `src/modules/feed/queries.js` 的 insertReply / listReplies / softDeleteReply。
 */
const FEED_REPLIES = new Map();

/**
 * `/api/feed/:id/repost` 的假服务端状态（`Map<原动态 id, { repostId, comment }>`）。
 * 语义照抄 `src/modules/feed/routes.js` 的那两条：同一条只留一条转发
 * （再转是更新转发语，`updated=true`），撤销是软删。
 */
const FEED_REPOSTS = new Map();

/**
 * `POST /api/posts/:id/repost` 的假服务端状态（`Map<帖子 id, 转发语>`）。
 *
 * 积木页用的就是这条接口 —— 转发记在**影子行**上（见 `src/modules/doc/routes.js`
 * 里互动锚点那段注释），所以积木页的转发区测试吃的也是这份状态：
 * 转完它会重读 `/api/docs/:id/anchor` 来重画互动条，夹具要是死的，
 * 「转完按钮还写着『🔁 转发 0』」这种半截状态就照不出来了。
 */
const POST_REPOSTS = new Map();

let fetchCount = 0;
globalThis.fetch = async (url, options = {}) => {
  fetchCount += 1;
  const raw = String(url).replace(/^https?:\/\/[^/]+/, '');
  const method = String(options.method || 'GET').toUpperCase();
  const payload = options.body ? JSON.parse(options.body) : null;
  REQUESTS.push({ url: raw, method, body: payload });
  const bare = raw.split('?')[0];
  // 建团队 / 传文件 / 发消息这三条 POST 要回自己那一小块真形状 ——
  // 否则页面会拿到 undefined 去渲染，报出来的错看着像代码坏了，其实只是夹具缺了。
  const created = { team: { ...TEAM_FIXTURE, slug: 'new-team-1', name: '新团队' } };
  const uploaded = {
    file: {
      id: 8,
      teamId: 1,
      team: { id: 1, slug: 'frontend-group', name: '前端小组' },
      name: payload?.name ?? '新传的文件.png',
      size: 1024,
      sizeLabel: '1.0 KB',
      mime: 'image/png',
      uploader: { id: 1, username: FIXTURE_USERNAME, displayName: '站长', avatar: null },
      downloadUrl: '/api/team-files/8',
      canDelete: true,
      createdAt: Date.now(),
    },
  };
  const sent = {
    message: {
      id: 22,
      teamId: 1,
      content: payload?.content ?? '收到',
      author: { id: 1, username: FIXTURE_USERNAME, displayName: '站长', avatar: null, role: 'owner' },
      canDelete: true,
      createdAt: Date.now(),
    },
  };
  // 这一轮要回失败（比如 kind 不合法）时走这个出口，见下面的 `/api/feed/:id/reaction`。
  let failure = null;
  let data;
  if (method === 'POST' && bare === '/api/teams') data = created;
  else if (method === 'POST' && bare === '/api/teams/join-by-code') data = { team: TEAM_FIXTURE, joined: true };
  else if (method === 'PUT' && /^\/api\/teams\/[^/]+\/announcement$/.test(bare)) {
    // 服务端回的是「更新后的团队 + 通知了几个人」，前端要靠这两个字段重画和报数。
    data = {
      team: {
        ...TEAM_FIXTURE,
        announcement: {
          text: payload?.announcement ?? '',
          editedAt: Date.now(),
          author: { id: 1, username: FIXTURE_USERNAME, displayName: '站长' },
        },
      },
      notified: 3,
    };
  } else if (method === 'POST' && /^\/api\/teams\/[^/]+\/posts\/\d+\/replies$/.test(bare)) {
    // 发回复：服务端回「刚建好的那一条」，前端拿到之后照样重拉整段列表 ——
    // 顺序和条数只由服务端说了算（这里是唯一能看到请求体对不对的地方）。
    data = {
      reply: {
        id: 33,
        postId: 1,
        teamId: 1,
        content: payload?.content ?? '',
        contentHtml: `<p>${payload?.content ?? ''}</p>`,
        author: { id: 1, username: FIXTURE_USERNAME, displayName: '站长', avatar: null, role: 'owner' },
        canDelete: true,
        createdAt: Date.now(),
      },
    };
  } else if (method === 'DELETE' && /^\/api\/teams\/[^/]+\/posts\/\d+\/replies\/\d+$/.test(bare)) {
    data = { deleted: true, id: 11, replyCount: 1 };
  } else if (method === 'POST' && /^\/api\/teams\/[^/]+\/join$/.test(bare)) {
    // 递申请：服务端回 requested=true（不是 joined），前端据此换一句话，并重画整页。
    data = {
      team: APPLY_TEAM_FIXTURE,
      joined: false,
      requested: true,
      request: {
        id: 42,
        teamId: 1,
        status: 'pending',
        statusLabel: '等待审核',
        message: payload?.message ?? '',
        user: { id: 1, username: FIXTURE_USERNAME, displayName: '站长', avatar: null },
        decidedAt: null,
        decidedBy: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        mine: true,
        canDecide: false,
      },
    };
  } else if (method === 'PUT' && /^\/api\/teams\/[^/]+\/join-requests\/\d+$/.test(bare)) {
    data = {
      request: {
        ...TEAM_JOIN_REQUEST_FIXTURES[0],
        status: payload?.action === 'reject' ? 'rejected' : 'approved',
        statusLabel: payload?.action === 'reject' ? '已拒绝' : '已批准',
        decidedAt: Date.now(),
        decidedBy: { id: 1, username: FIXTURE_USERNAME, displayName: '站长' },
        canDecide: false,
      },
      member: {
        id: 9,
        user: { id: 9, username: 'newcomer', displayName: '新来的', avatar: null },
        teamRole: 'member',
        teamRoleLabel: '成员',
        joinedAt: Date.now(),
      },
      team: { ...TEAM_FIXTURE, memberCount: 2, pendingRequestCount: 1 },
    };
  } else if (method === 'DELETE' && /^\/api\/teams\/[^/]+\/join-requests\/\d+$/.test(bare)) {
    data = { removed: true, id: 41, team: { ...TEAM_FIXTURE, pendingRequestCount: 1 } };
  } else if (method === 'PUT' && /^\/api\/teams\/[^/]+$/.test(bare)) {
    // 保存团队设置：服务端回更新后的团队（`listed` 也在这里被写回去）。
    data = {
      team: {
        ...TEAM_FIXTURE,
        name: payload?.name ?? TEAM_FIXTURE.name,
        intro: payload?.intro ?? TEAM_FIXTURE.intro,
        joinPolicy: payload?.joinPolicy === 'apply' ? 'apply' : 'open',
        joinPolicyLabel: payload?.joinPolicy === 'apply' ? '需要申请' : '谁都能加入',
        listed: payload?.listed !== '0',
      },
    };
  } else if (method === 'POST' && bare === '/api/teams/frontend-group/files') data = uploaded;
  else if (method === 'POST' && bare === '/api/teams/frontend-group/messages') data = sent;
  else if (method === 'POST' && /^\/api\/feed\/\d+\/reaction$/.test(bare)) {
    // 照抄真服务端的两件事：
    //   ① 入参校验：只认 'like' / 'dislike'（`src/modules/feed/routes.js` 的 bad_kind）。
    //      前端自己算出来的 null 在这里就该跟线上一样吃 400，不能悄悄放过 ——
    //      少了这一条，「手滑点错了取消不掉」这种 bug 在假 DOM 里永远照不出来。
    //   ② `queries.setReaction()` 的语义：同一个再来一次 = 取消，换一个 = 改判。
    const feedId = Number(bare.split('/')[3]);
    const kind = payload?.kind;
    if (kind !== 'like' && kind !== 'dislike') {
      failure = { status: 400, code: 'bad_kind', message: '只支持「赞」或「踩」' };
    } else {
      const after = FEED_REACTIONS.get(feedId) === kind ? null : kind;
      if (after) FEED_REACTIONS.set(feedId, after);
      else FEED_REACTIONS.delete(feedId);
      data = {
        liked: after === 'like',
        disliked: after === 'dislike',
        likeCount: after === 'like' ? 1 : 0,
        dislikeCount: after === 'dislike' ? 1 : 0,
      };
    }
  } else if (method === 'GET' && /^\/api\/feed\/\d+\/replies$/.test(bare)) {
    // 回复列表是**按需拉**的：`/api/feed` 列表接口只给 `replyCount` 这个数字，
    // 谁也没展开的时候一条回复都不该去拉。见下面「动态回复」那段交互测试。
    const feedId = Number(bare.split('/')[3]);
    const replies = FEED_REPLIES.get(feedId) ?? [];
    data = { itemId: feedId, replies, replyCount: replies.length };
  } else if (method === 'POST' && /^\/api\/feed\/\d+\/replies$/.test(bare)) {
    // 照抄服务端 `field(content, { min: 1, max: MAX_FEED_REPLY_CONTENT, label: '回复内容' })`：
    // 先 trim 再判长（`src/core/http.js:88`），空串和纯空格都该吃 400。
    const feedId = Number(bare.split('/')[3]);
    const content = String(payload?.content ?? '').replace(/\r\n?/g, '\n').trim();
    if (content.length < 1) failure = { status: 400, code: 'invalid_field', message: '回复内容至少需要 1 个字符' };
    else if (content.length > 2000) failure = { status: 400, code: 'invalid_field', message: '回复内容不能超过 2000 个字符' };
    else {
      const replies = FEED_REPLIES.get(feedId) ?? [];
      const reply = {
        id: 9000 + replies.length + 1,
        itemId: feedId,
        content,
        contentHtml: `<p>${content.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>`,
        author: { id: 2, username: 'frontend-user', displayName: '前端测试', avatar: null, role: 'member' },
        createdAt: Date.now(),
      };
      replies.push(reply);
      FEED_REPLIES.set(feedId, replies);
      data = { reply, replyCount: replies.length };
    }
  } else if (method === 'DELETE' && /^\/api\/feed\/\d+\/replies\/\d+$/.test(bare)) {
    const parts = bare.split('/');
    const feedId = Number(parts[3]);
    const replyId = Number(parts[5]);
    const replies = (FEED_REPLIES.get(feedId) ?? []).filter((entry) => entry.id !== replyId);
    FEED_REPLIES.set(feedId, replies);
    data = { deleted: true, id: replyId, replyCount: replies.length };
  } else if (method === 'GET' && /^\/api\/docs\/\d+\/anchor$/.test(bare)) {
    // 影子行的转发状态**必须跟着 POST_REPOSTS 走**。夹具是采样时冻住的死对象，
    // 积木页转完再读这条接口只会拿回 `repostCount: 0` —— 而「转完互动条还写着
    // 『🔁 转发 0』、下面却已经列出你」正是这段 UI 最想抓的半截状态。
    const fixture = pickFixture('/api/docs/1/anchor');
    const reposted = POST_REPOSTS.has(Number(FIXTURE_POST_ID));
    // 名单也要跟着走：真服务端这条接口回 `reposters`，前端靠它认出「名单里有我」
    // 才画得出「撤销转发」。夹具只给一个空数组的话，转完只会看到一句
    // 「还没有人转发」—— 用户找不到撤销入口，正是要抓的那种半截状态。
    const reposters = reposted
      ? [
          {
            repostId: 1,
            comment: POST_REPOSTS.get(Number(FIXTURE_POST_ID)),
            createdAt: Date.now(),
            user: { id: 1, username: FIXTURE_USERNAME, displayName: '站长', role: 'owner', avatar: null },
          },
        ]
      : [];
    data = { ...fixture, post: { ...fixture.post, reposted, repostCount: reposters.length }, reposters };
  } else if (method === 'POST' && /^\/api\/posts\/\d+\/repost$/.test(bare)) {
    // 照抄 `src/modules/core/routes-c.js`：同一人同一篇只留一条，
    // 再转是改转发语（`updated=true`，计数不会变成 2）。
    const postId = Number(bare.split('/')[3]);
    const previous = POST_REPOSTS.has(postId);
    const comment = String(payload?.comment ?? '').replace(/\r\n?/g, '\n').trim();
    if (comment.length > 300) failure = { status: 400, code: 'invalid_field', message: '转发语不能超过 300 个字符' };
    else {
      POST_REPOSTS.set(postId, comment);
      data = { reposted: true, updated: previous, repostCount: 1, comment };
    }
  } else if (method === 'DELETE' && /^\/api\/posts\/\d+\/repost$/.test(bare)) {
    const postId = Number(bare.split('/')[3]);
    if (!POST_REPOSTS.has(postId)) failure = { status: 400, code: 'not_reposted', message: '你还没有转发过这篇' };
    else {
      POST_REPOSTS.delete(postId);
      data = { reposted: false, repostCount: 0 };
    }
  } else if (method === 'POST' && /^\/api\/feed\/\d+\/repost$/.test(bare)) {
    // 照抄 `src/modules/feed/routes.js`：转发 = 一条新动态，`refFeed` 指回原动态；
    // 同一人同一条只留一条，再转是改转发语（`updated=true`，计数不变）。
    const feedId = Number(bare.split('/')[3]);
    const previous = FEED_REPOSTS.get(feedId) ?? null;
    const comment = String(payload?.comment ?? '').replace(/\r\n?/g, '\n').trim();
    const repostId = previous?.repostId ?? 9500 + FEED_REPOSTS.size + 1;
    FEED_REPOSTS.set(feedId, { repostId, comment });
    data = {
      reposted: true,
      updated: Boolean(previous),
      itemId: repostId,
      repostCount: 1,
      item: {
        id: repostId,
        content: comment,
        contentHtml: comment ? `<p>${comment}</p>` : '',
        scope: 'public',
        scopeLabel: '公开',
        teamId: null,
        images: [],
        ref: null,
        refFeed: {
          id: feedId,
          content: '原动态的正文',
          contentHtml: '<p>原动态的正文</p>',
          deleted: false,
          createdAt: Date.now(),
          author: { id: 1, username: 'frontend-origin', displayName: '原动态作者', avatar: null, role: 'member' },
        },
        author: { id: 2, username: 'frontend-user', displayName: '前端测试', avatar: null, role: 'member' },
        likeCount: 0,
        dislikeCount: 0,
        replyCount: 0,
        liked: false,
        disliked: false,
        repostCount: 0,
        reposted: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        edited: false,
      },
    };
  } else if (method === 'DELETE' && /^\/api\/feed\/\d+\/repost$/.test(bare)) {
    const feedId = Number(bare.split('/')[3]);
    FEED_REPOSTS.delete(feedId);
    data = { reposted: false, repostCount: 0 };
  } else if (method === 'PUT' && /^\/api\/docs\/\d+\/markdown$/.test(bare)) {
    // 真服务端的 `PUT /markdown` 回的是**整份详情**（`store.putMarkdown` 末尾 `present(fresh)`：
    // doc / blocks / html / abilities / settings，改得动的人还有 source），不是 GET 那份
    // `{title, markdown}`。自动保存要靠这次响应把「脏基线」对齐到服务端真存下来的那份 ——
    // 形状给错，编辑器会一直以为自己还脏着，测出来的「存完不脏了」就是假的。
    const detail = pickFixture(bare.replace(/\/markdown$/, '')) ?? {};
    data = { ...detail, markdown: payload?.markdown ?? '' };
  } else data = pickFixture(raw);
  // 「让某一条路回失败」的出口（自动保存那条路上的 409 就靠它）。
  const forced = FORCED_FAILURES.get(`${method} ${bare}`);
  if (forced) failure = forced;
  if (failure) {
    const body = { ok: false, error: { code: failure.code, message: failure.message } };
    return {
      ok: false,
      status: failure.status,
      headers: { getSetCookie: () => [], get: () => 'application/json' },
      json: async () => body,
      text: async () => JSON.stringify(body),
      _url: url,
      _options: options,
    };
  }
  if (data === undefined) unknownPaths.add(bare);
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
  // P5 的起始页：m05506 起它就占 `#/`（不论登录与否都是默认落点），老地址 `#/start` 是别名
  // （见 core/router.js）。它拉四个现成接口（站务公告 / 动态 / 积木 / 团队），任何一个挂了
  // 都要照常出页面 —— 正好是「渲染会不会炸」这条检查最该盯的一页。
  ['起始页', 'start.js', 'viewStart', []],
  // 站务公告列表页 `#/announcements`：首页那块只放 5 条（用户明确要求），
  // 全部公告 + 翻页在这一页。两页吃的是同一个接口（`/api/posts?board=meta`），
  // 所以首页那块改了要连这一页一起看。
  ['站务公告', 'start.js', 'viewAnnouncements', [new Map()]],
  ['站务公告·第 2 页', 'start.js', 'viewAnnouncements', [new URLSearchParams({ page: '2' })]],
  // 动态流：以前它是 `#/`，m05506 起搬到 `#/feed`（`#/?filter=…` 之类也跟着搬过去）。
  ['动态流', 'timeline.js', 'viewTimeline', [new Map()]],
  ['动态·我关注的', 'timeline.js', 'viewTimeline', [new URLSearchParams({ filter: 'following' })]],
  ['动态·搜索', 'timeline.js', 'viewTimeline', [new URLSearchParams({ q: '采样' })]],
  // 「关注列表」= 我关注了谁的**名单**（头像 + 一键取关），跟上面那条「动态·我关注的」
  // （关注**流**：只看 TA 们发的帖子）不是一回事。地址 `#/following`，别再被改道去动态流。
  ['关注列表', 'feed.js', 'viewFollowing', []],
  // v1 的帖子列表页：`#/` 已经不再走它们了，但函数还在、还能渲染，
  // 所以继续测 —— 哪天要下线这批代码，删函数的同时把这四行一起删。
  ['帖子列表（旧首页）', 'feed.js', 'viewHome', [new Map()]],
  ['版块（已下线）', 'feed.js', 'viewBoard', ['general', new Map()]],
  ['帖子搜索（旧）', 'feed.js', 'viewSearch', [new Map()]],
  ['收藏', 'feed.js', 'viewBookmarks', [new Map()]],
  ['个人主页', 'user.js', 'viewUser', ['admin', new Map()]],
  ['设置', 'settings.js', 'viewSettings', []],
  ['通知', 'notifications.js', 'viewNotifications', [new Map()]],
  ['私信列表', 'messages.js', 'viewMessages', []],
  ['私信会话', 'messages.js', 'viewThread', [FIXTURE_PEER]],
  ['帖子详情', 'post.js', 'viewPost', [1]],
  ['发帖页', 'compose.js', 'viewCompose', [null]],
  ['登录页', 'auth.js', 'viewAuth', ['login']],
  ['注册页', 'auth.js', 'viewAuth', ['register']],
  ['AI 助手', 'ai.js', 'viewAI', []],
  // P3 的 AI 编辑台：能力授权 / 按块改写 / 审计与回滚。数据走 /api/ai-edit/*。
  ['AI 编辑台', 'ai-edit.js', 'viewAiEdit', []],
  ['管理后台', 'admin.js', 'viewAdmin', []],
  // v2 积木（可编程帖子）的四个页面。正文 HTML 由后端出，这里测的是外壳会不会炸。
  ['积木广场', 'doc.js', 'viewDocs', [new Map()]],
  ['积木阅读页', 'doc.js', 'viewDoc', [1]],
  ['积木编辑器', 'doc.js', 'viewDocEdit', [1, new Map()]],
  ['积木 Markdown 模式', 'doc.js', 'viewDocEdit', [1, new Map([['mode', 'markdown']])]],
  ['块类型表', 'doc.js', 'viewBlocks', []],
  // 「块类型表」挪进了开发者功能（`#/dev`），老地址 `#/blocks` 进的是同一页 ——
  // 这两行都留着：前者是契约（doc-smoke 认这个标签），后者是实际入口。
  ['开发者功能', 'doc.js', 'viewDev', []],
  // 积木教程：纯文档页，只拉一次块类型清单。
  ['积木教程', 'guide.js', 'viewGuide', []],
  // 没建过的那一页：走的是「还不存在」分支（`found:false`），因此必渲染成一张建页卡。
  ['Wiki 页面', 'doc.js', 'viewWiki', ['没建过的页', new Map()]],
  // v2 团队（P4）的两个页面。slug 必须和上面 EXTRA 里的键对得上，
  // 否则假 fetch 只会回一个空壳 —— 页面照样不炸，但等于什么都没测到。
  ['团队列表', 'team.js', 'viewTeams', [new Map()]],
  ['团队·我加入的', 'team.js', 'viewTeams', [new Map([['mine', '1']])]],
  ['团队主页', 'team.js', 'viewTeam', ['frontend-group', new Map()]],
  ['团队·文件页签', 'team.js', 'viewTeam', ['frontend-group', new Map([['tab', 'files']])]],
  ['团队·群聊页签', 'team.js', 'viewTeam', ['frontend-group', new Map([['tab', 'chat']])]],
  // 非成员视角：团队号与公告都是 null，页面上这两块必须整个不出现。
  ['团队主页·非成员', 'team.js', 'viewTeam', ['outsider-group', new Map()]],
  // 「需要申请」的团队：路人的按钮是「申请加入」不是「加入团队」。
  ['团队主页·要申请', 'team.js', 'viewTeam', ['apply-group', new Map()]],
  // 已经递过申请、还在等审核：按钮变成「撤回申请」。
  ['团队主页·等审核', 'team.js', 'viewTeam', ['pending-group', new Map()]],
  // 团队帖详情 `#/team/<slug>/post/<id>`：点标题进去看的那一页（帖子 + 回复串 + 回复框）。
  ['团队帖详情', 'team.js', 'viewTeamPost', ['frontend-group', 1, new Map()]],
  // 非成员进公开帖：帖子看得见，回复框要变成「加入之后才能回复」。
  ['团队帖详情·非成员', 'team.js', 'viewTeamPost', ['outsider-group', 1, new Map()]],
];

/**
 * 扫「一个 `<a>` 里又套着另一个 `<a>`」。
 *
 * 为什么非扫不可：HTML 解析器碰到「已经有一个 `<a>` 开着时再来一个 `<a>` 起始标签」，
 * 会**隐含地闭合外层那个**（规范里写死了这条），于是外层链接只包住最前面那一小截，
 * 后面的内容全掉到链接外面去。`#/notifications` 就这么坏过：
 * `notif-item` 是个 `<a>`，里面又嵌了个 `<a class="notif-actor">` 指作者主页 ——
 * 结果每条通知只剩一个 30px 的图标方块，正文全跑到卡片左边缘逐行堆着，未读蓝点掉在最左边。
 * 这个假 DOM 不解析 HTML（`innerHTML` 只存字符串），所以「只有真解析器才会犯的错」
 * 只能自己在字符串上扫一遍。
 *
 * 返回第一处嵌套的外层开头（截一小段方便定位），没有就返回 null。
 */
function nestedAnchorAt(html) {
  let depth = 0;
  let outer = -1;
  for (const m of html.matchAll(/<a(?:\s[^>]*)?>|<\/a>/gi)) {
    if (m[0][1] === '/') {
      if (depth > 0) depth -= 1;
      if (depth === 0) outer = -1;
      continue;
    }
    depth += 1;
    if (depth === 1) outer = m.index;
    else if (outer >= 0) return html.slice(outer, outer + 160).replace(/\s+/g, ' ');
  }
  return null;
}

let rendered = 0;
let pagesScanned = 0;
/** 「自己看自己」那条关注名单卡守卫到底跑没跑（守卫的自检，见上面的哨兵传统）。 */
let ownerFollowCardsChecked = 0;
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
    const pageHtml = String(app.innerHTML);
    if (pageHtml.length > 200) pagesScanned += 1;
    const nested = nestedAnchorAt(pageHtml);
    if (nested) {
      problems.push(
        `${label}：渲染出的 HTML 里有一个 <a> 套着另一个 <a> —— 浏览器会强行闭合外层，布局会散架。外层是 ${nested}`,
      );
    }
    // 自己看自己时，两张关注名单卡必须在文章列表**上面**，文案也要换成「我的…」。
    // 它们原先钉在页面最底下：文章一多就得整页滚到底才看得见，用户反馈的
    // 「在自己的主页上看不到我关注的人」就是这么来的（接口一直是对的，是位置太靠后）。
    if (label === '个人主页') {
      ownerFollowCardsChecked += 1;
      const followAt = pageHtml.indexOf('我关注的人');
      const postsAt = pageHtml.indexOf('profile-posts');
      if (followAt < 0) problems.push('个人主页（自己视角）：没有渲染出「我关注的人」卡');
      if (!pageHtml.includes('我的关注者')) problems.push('个人主页（自己视角）：「关注者」那张卡没有换成「我的关注者」');
      if (followAt >= 0 && postsAt >= 0 && followAt > postsAt) {
        problems.push('个人主页（自己视角）：「我关注的人」卡排在文章列表下面，文章一多就又看不见了');
      }
    }
  } catch (error) {
    const top = (error.stack ?? '').split('\n').slice(0, 3).join(' | ');
    problems.push(`${label}（${file}.${fn}）渲染失败：${error.message}  ← ${top}`);
  }
}
console.log(`  ${problems.length ? '❌' : '✅'} 渲染 ${rendered}/${CASES.length} 个页面`);

/* ---- 个人主页的「别人视角」：文案必须变回「关注者 / TA 关注的人」，卡片仍在最底下 ----
 *
 * 为什么单独跑一遍：上面那条只覆盖自己视角（夹具 isMe:true）。两张关注名单卡现在
 * 是**同一个字符串**在两个位置各插一次，`isOwner` 三元要是写反了，自己视角照样全绿，
 * 而别人主页会变成「我的关注者 / 我关注的人」、卡片还会莫名跑到文章前面。
 */
{
  let outsiderOk = false;
  try {
    const userView = await view('user.js');
    await userView.viewUser('not-me', new Map());
    const html = String(app.innerHTML);
    const followAt = html.indexOf('TA 关注的人');
    const postsAt = html.indexOf('profile-posts');
    outsiderOk = true;
    if (followAt < 0) problems.push('个人主页（别人视角）：没有渲染出「TA 关注的人」卡');
    if (!html.includes('关注者')) problems.push('个人主页（别人视角）：「关注者」那张卡不见了');
    if (html.includes('我关注的人') || html.includes('我的关注者')) {
      problems.push('个人主页（别人视角）：文案串成自己视角了（「我关注的人 / 我的关注者」只该出现在自己的主页上）');
    }
    if (followAt >= 0 && postsAt >= 0 && followAt < postsAt) {
      problems.push('个人主页（别人视角）：关注名单卡跑到文章列表上面了 —— 提前只该发生在自己视角');
    }
  } catch (error) {
    problems.push(`个人主页（别人视角）渲染失败：${error.message}`);
  }
  if (!outsiderOk) problems.push('个人主页（别人视角）那条检查没跑起来');
}

/* ---- 个人主页三种排法：`☰ 列表`（默认）/ `▦ 卡片` / `≡ 紧凑` ----
 *
 * 为什么单独跑一遍：这三个按钮把选择写进 localStorage，读取端要是读的是另一个键
 * （events.js 曾经写成 'forum:Prefs.profileLayout'），点按钮就会「看着有反应、
 * 重渲染又回列表」—— `check-ui-contract` 只查键名字面量，这里查**渲染真的换了**。
 */
{
  let layoutOk = false;
  try {
    const userView = await view('user.js');
    const layouts = [
      ['list', 'class="post-list"'],
      ['cards', 'class="post-cards"'],
      ['compact', 'class="post-compact"'],
    ];
    for (const [value, marker] of layouts) {
      globalThis.localStorage.setItem('forum:profileLayout', value);
      await userView.viewUser('admin', new Map());
      const html = String(app.innerHTML);
      if (!html.includes(marker)) problems.push(`个人主页排版「${value}」没有渲染出 ${marker}`);
    }
    globalThis.localStorage.removeItem('forum:profileLayout');
    layoutOk = true;
  } catch (error) {
    problems.push(`个人主页三种排版渲染失败：${error.message}`);
  }
  if (!layoutOk) problems.push('个人主页三种排版那条检查没跑起来');
}

/* 守卫的自检与覆盖哨兵。一个「什么都不报」的检测器跟没有检测器一样糟：
 * 假 DOM 不解析 HTML，万一以后 `app.innerHTML` 取不到东西，上面那条扫描会一路绿灯地假通过。 */
if (!nestedAnchorAt('<a href="#/a">x<a href="#/b">y</a></a>')) {
  problems.push('嵌套 <a> 的检测器失灵了：喂一段已知的嵌套都抓不到');
}
if (pagesScanned < 30) {
  problems.push(`只拿到 ${pagesScanned} 个页面的 HTML（正常是三十多个），嵌套 <a> 那条守卫等于没生效`);
}
// 同理：CASES 里要是哪天没有「自己看自己」的个人主页，上面那条关注名单卡的检查
// 会一声不吭地跳过（`label` 对不上），看起来还是全绿。
if (ownerFollowCardsChecked !== 1) {
  problems.push(`「自己看自己」的关注名单卡守卫跑了 ${ownerFollowCardsChecked} 次（应该正好 1 次）—— 检查等于没生效`);
}
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

  /*
   * ---- 「仅团队」必须真的挑一个团队 ----
   *
   * 这一档以前是坏的：接口把 `team_id` 写死成 null，可见性 SQL 永远匹配不上，
   * 于是「仅团队」静默退化成「仅自己」—— 作者以为发给了队友，队友一条也看不到。
   * 所以这里钉三件事：公开档不画选择器、选团队时才去问、没挑就发不出去。
   */
  const teamSlot = registered('[data-feed-team-slot]');
  const scopeHint = registered('[data-feed-scope-hint]');
  const feedPosts = () => REQUESTS.filter((item) => item.method === 'POST' && item.url.split('?')[0] === '/api/feed').length;

  fire(scope, 'change', '[data-feed-scope]', 'public');
  if (String(teamSlot.innerHTML).includes('data-feed-team')) problems.push('选了「公开」却还画着团队选择器');
  if (scopeHint.hidden !== true) problems.push('选了「公开」还挂着「只有某个队能看」的提醒');

  const postsBeforeTeam = feedPosts();
  fire(scope, 'change', '[data-feed-scope]', 'team');
  await settle();
  await settle();
  const teamHtml = String(teamSlot.innerHTML);
  if (!teamHtml.includes('data-feed-team')) problems.push('选了「仅团队」却没画出团队选择器 —— 用户根本没法挑队，只能吃 400');
  if (!teamHtml.includes(TEAM_FIXTURE.name)) problems.push(`团队选择器里没有「${TEAM_FIXTURE.name}」这个队`);
  // 提醒那行是用 `textContent` 写的（假 DOM 不解析 HTML，读 innerHTML 会永远是空的）
  if (scopeHint.hidden === true || !String(scopeHint.textContent).includes(TEAM_FIXTURE.name)) {
    problems.push('「仅团队」时那行提醒没写出队名 —— 挑错队是静默失败，发之前得看得见');
  }

  // 挑好队再发：请求体里必须带上团队编号（服务端才存得下真的 team_id）
  const publishBtn = makeElement('button');
  publishBtn.dataset = { feedAction: 'publish' };
  publishBtn.closest = (selector) => (selector === '[data-feed-action]' ? publishBtn : null);
  fire(input, 'input', '[data-feed-input]', '只给队里看的一条');
  const teamSelect = registered('[data-feed-team]');
  teamSelect.value = String(TEAM_FIXTURE.id);
  teamSelect.matches = (candidate) => candidate === '[data-feed-team]';
  dispatch(app, 'change', teamSelect);
  dispatch(app, 'click', publishBtn);
  await settle();
  await settle();
  const teamPost = REQUESTS.filter((item) => item.method === 'POST' && item.url.split('?')[0] === '/api/feed').pop();
  // 假 fetch 存下来的 body 可能是字符串也可能是对象，两种都认
  const teamBody = typeof teamPost?.body === 'string' ? JSON.parse(teamPost.body) : teamPost?.body ?? null;
  if (teamBody?.scope !== 'team') problems.push(`选了「仅团队」却按 ${JSON.stringify(teamBody?.scope)} 发出去`);
  if (teamBody?.teamId !== TEAM_FIXTURE.id) problems.push(`请求体里没带上团队编号（现在是 ${JSON.stringify(teamBody?.teamId)}）`);

  console.log(`  ${problems.length ? '❌' : '✅'} 交互：「仅团队」才画团队选择器、发出去的请求带着队号`);

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

/* ---- 交互：动态流的「赞 / 踩」点第二次必须是**取消**，不能变成 400 ----
 *
 * 为什么单独测这一条：服务端 `queries.setReaction()` 本来就是「同一个再来一次 = 取消」，
 * 但那个接口的入参校验只认 'like' / 'dislike'（见上面假 fetch 里复刻的 bad_kind）。
 * 前端要是「贴心地」自己算出取消、发个 `{ kind: null }` 过去，换回来的就是
 * 400 +「只支持「赞」或「踩」」—— 用户看到的现象是**手滑点错了就取消不掉**。
 *
 * `feed-smoke.mjs` 照不出这个：它直接发 'like'，走的不是前端那条路。
 * 渲染类断言更照不出来：页面确实画出来了，画出来的按钮点下去发什么它不管。
 */
{
  const timeline = await view('timeline.js');
  const FEED_KEY = '/api/feed?filter=all&page=1';
  const item = pickFixture(FEED_KEY).items[0];
  // 把这条动态摆成「我已经赞过了」—— 「取消」要走的正是这条路
  const saved = { liked: item.liked, likeCount: item.likeCount };
  item.liked = true;
  item.likeCount = 1;
  FEED_REACTIONS.set(item.id, 'like');
  await timeline.viewTimeline(new Map());

  const before = REQUESTS.length;
  const reactNode = { dataset: { feedAction: 'react', id: String(item.id), kind: 'like' }, matches: () => false };
  reactNode.closest = (selector) => (selector === '[data-feed-action]' ? reactNode : null);
  dispatch(app, 'click', reactNode);
  await settle();

  const sent = REQUESTS.slice(before).filter((entry) => entry.url.includes('/reaction'));
  if (!sent.length) {
    problems.push('首页动态流点「赞」之后没有请求 /api/feed/:id/reaction');
  } else if (sent[0].body?.kind !== 'like' && sent[0].body?.kind !== 'dislike') {
    problems.push(
      `取消点赞发出去的 kind 是 ${JSON.stringify(sent[0].body?.kind)} —— 服务端只认 'like' / 'dislike'，` +
        '会回 400 bad_kind，用户看到的是「手滑点错了取消不掉」；取不取消该由服务端 toggle，前端别自己算。',
    );
  }
  console.log(`  ${problems.length ? '❌' : '✅'} 交互：动态流的赞点第二次 = 取消（发的是字面量，不是 null）`);

  item.liked = saved.liked;
  item.likeCount = saved.likeCount;
  FEED_REACTIONS.delete(item.id);
}

/* ---- 交互：动态底下的回复 —— 按需拉、发得出去、收起来不再拉 ----
 *
 * 为什么单独测这一条：`/api/feed` 列表接口**只给 `replyCount` 这个数字**，
 * 一句回复正文都不带（一页 20 条动态，谁也没展开的时候不该多打 20 次请求）。
 * 所以「点了 💬 到底有没有去拉」是纯前端的事，`feed-smoke.mjs` 照不到 ——
 * 它直接调 `/api/feed/:id/replies`，走的不是前端那条路。
 *
 * 反过来，「渲染出来了」也证明不了「点了会去拉」：按钮画得再对，
 * 点下去什么都不发生的话，用户看到的就是**一串没有下文的数字**。
 */
{
  const timeline = await view('timeline.js');
  const FEED_KEY = '/api/feed?filter=all&page=1';
  const item = pickFixture(FEED_KEY).items[0];
  const savedCount = item.replyCount;
  item.replyCount = 0;
  FEED_REPLIES.delete(item.id);
  await timeline.viewTimeline(new Map());

  const repliesGet = () => REQUESTS.filter((entry) => /\/replies$/.test(entry.url) && entry.method === 'GET');
  if (repliesGet().length) {
    problems.push(`只是渲染一遍动态流就发了 ${repliesGet().length} 次回复请求 —— 回复要展开才拉，否则一页 20 条就是 20 次白跑`);
  }

  const box = registered(`[data-feed-replies-box="${item.id}"]`);
  box.hidden = true;
  box.innerHTML = '';

  // ① 展开
  const btn = makeElement('button');
  btn.dataset = { feedAction: 'replies', id: String(item.id) };
  // 假 DOM 的 `closest` 默认恒返回 null，而 timeline.js 的点击委托第一句就是
  // `event.target.closest('[data-feed-action]')` —— 不接这根线，点下去什么都不会发生。
  btn.closest = (selector) => (selector === '[data-feed-action]' ? btn : null);
  dispatch(app, 'click', btn);
  await settle();
  if (!repliesGet().length) problems.push('点「💬 回复」之后没有请求 /api/feed/:id/replies');
  if (box.hidden) problems.push('点「💬 回复」之后回复盒子还是 hidden —— 用户点了等于没点');
  if (!box.innerHTML.includes('data-feed-reply-form')) {
    problems.push('展开了却没有画出回复输入框（服务端返回的 replies 没被用上？）');
  }

  // ② 发一条
  const form = registered('[data-feed-reply-form]');
  form.dataset = { id: String(item.id) };
  form.closest = (selector) => (selector === '[data-feed-reply-form]' ? form : null);
  // 假 DOM 的 `querySelector` 也是查注册表，键就是**选择器原串**：
  // 视图里写的是 `form.querySelector('textarea[name="content"]')`，所以这里必须用同一个串，
  // 写成 `'[data-feed-reply-form] textarea[name="content"]'` 会拿到另一个空元素。
  const textarea = registered('textarea[name="content"]');
  textarea.value = '第一条回复';
  const beforePost = REQUESTS.length;
  dispatch(app, 'submit', form);
  await settle();
  const posted = REQUESTS.slice(beforePost).filter((entry) => entry.url === `/api/feed/${item.id}/replies` && entry.method === 'POST');
  if (!posted.length) problems.push('在动态底下发回复之后没有 POST /api/feed/:id/replies');
  else if (posted[0].body?.content !== '第一条回复') {
    problems.push(`发出去的回复正文是 ${JSON.stringify(posted[0].body?.content)}，不是输入框里的原文`);
  }
  if (!box.innerHTML.includes('第一条回复')) problems.push('发完之后回复区没有重画，用户看不到自己刚发的那条');
  const countNode = registered(`[data-feed-replies="${item.id}"]`);
  if (countNode.textContent !== '1') {
    problems.push(`发完回复之后计数还是 ${JSON.stringify(countNode.textContent)} —— 按钮上的数字没跟着走`);
  }

  // ③ 收起来之后再点开，要不要重新拉？—— 要（不然看到的是旧列表）
  const opensBefore = repliesGet().length;
  dispatch(app, 'click', btn);
  await settle();
  if (!box.hidden) problems.push('再点一次「💬 回复」没有把回复区收起来');
  if (repliesGet().length !== opensBefore) problems.push('光是收起来就又把回复拉了一遍 —— 白跑一趟');
  dispatch(app, 'click', btn);
  await settle();
  if (repliesGet().length <= opensBefore) {
    problems.push('收起来再展开没有重新拉回复 —— 别人在这期间回的话，用户永远看不到');
  }

  // ④ 空回复不该发出去（服务端的 min:1 只是兜底，白跑一趟还弹个红条）
  textarea.value = '   ';
  const beforeEmpty = REQUESTS.length;
  dispatch(app, 'submit', form);
  await settle();
  if (REQUESTS.slice(beforeEmpty).some((entry) => entry.url === `/api/feed/${item.id}/replies` && entry.method === 'POST')) {
    problems.push('空回复也发了 POST —— 该在本地拦下来');
  }
  console.log(`  ${problems.length ? '❌' : '✅'} 交互：动态的回复按需拉、发得出去、空回复本地拦、收起再开重新拉`);

  item.replyCount = savedCount;
  FEED_REPLIES.delete(item.id);
}

/* ---- 交互：动态的转发 —— 点开才画输入框、发得出去、转不了的画静态计数 ----
 *
 * 两件事只有在这里才照得到：
 *  ① 「转发」那一块是**点开才画**的（一页 20 条动态不该预渲染 20 个 textarea）；
 *  ② 转不了的时候（不是公开的动态）画的是**静态计数而不是一颗按钮** ——
 *     `feed-smoke.mjs` 只能证明服务端会回 403 repost_scope，
 *     证明不了前端没画那颗「点了只会弹红条」的按钮。前面几轮修的正是这类毛病。
 *  ③ 反过来，**自己的动态必须有按钮** —— 自己的也能转，别再退回静态计数。
 */
{
  const timeline = await view('timeline.js');
  const FEED_KEY = '/api/feed?filter=all&page=1';
  const item = pickFixture(FEED_KEY).items[0];
  const saved = {
    scope: item.scope,
    repostCount: item.repostCount,
    reposted: item.reposted,
    authorId: item.author.id,
  };
  item.scope = 'public';
  item.repostCount = 0;
  item.reposted = false;
  // 保证是「公开的」——只有可见范围会影响能不能转，作者是不是自己不影响。
  item.author.id = (state.me?.id ?? 1) + 999;
  FEED_REPOSTS.delete(item.id);
  await timeline.viewTimeline(new Map());

  const box = registered(`[data-feed-repost-box="${item.id}"]`);
  box.hidden = true;
  box.innerHTML = '';

  const repostPosts = () => REQUESTS.filter((entry) => /\/repost$/.test(entry.url) && entry.method === 'POST');
  // 卡片是 `list.innerHTML = data.items.map(feedItemHtml).join('')` 画出来的，
  // 而假 DOM 的 `innerHTML` 只是一段字符串（不解析），所以「画没画那颗按钮」
  // 要直接查**列表那一层**的字符串 —— 查 `app.innerHTML` 只有外壳，查不到卡片。
  // 也**不能**用 `registered('[data-feed-action="repost"]')` 判空：那个注册表查不到就现建一个，永远非空。
  const rendered = () => String(registered('[data-feed-list]').innerHTML);
  const hasRepostButton = (id) => rendered().includes(`data-feed-action="repost" data-id="${id}"`);

  // ① 只是渲染，不该已经画出输入框，也不该有任何转发请求
  if (repostPosts().length) problems.push('只是渲染一遍动态流就发了转发请求 —— 转发要点开才做');
  if (rendered().includes('data-feed-repost-form')) {
    problems.push('还没点开「🔁」就已经把转发表单画出来了 —— 一页 20 条就是 20 个 textarea');
  }
  if (!hasRepostButton(item.id)) {
    problems.push('公开的、别人的动态上没有「🔁 转发」按钮 —— 用户没有转发的入口');
  }

  // ② 点开。按钮得自己造：卡片是一段字符串，注册表里没有那个节点。
  const btn = makeElement('button');
  btn.dataset = { feedAction: 'repost', id: String(item.id) };
  // 假 DOM 的 `closest` 默认恒返回 null，而点击委托第一句就是
  // `event.target.closest('[data-feed-action]')` —— 不接这根线，点下去什么都不会发生。
  btn.closest = (selector) => (selector === '[data-feed-action]' ? btn : null);
  dispatch(app, 'click', btn);
  await settle();
  if (box.hidden) problems.push('点「🔁」之后转发盒子还是 hidden —— 用户点了等于没点');
  if (!box.innerHTML.includes('data-feed-repost-form')) {
    problems.push('点开了却没有画出转发输入框');
  }

  // ③ 发出去：请求体要是**当前**输入框里的原文，计数与输入框都要跟着变
  const form = registered('[data-feed-repost-form]');
  const textarea = registered('textarea[name="comment"]');
  // 注册表查不到就现建一个**空**元素，`dataset.id` 是 undefined ——
  // 不补上的话 `submitRepost` 里 `Number(form.dataset.id)` 得到 NaN，
  // `itemCache.get(NaN)` 取不到东西，函数在第一行就 return 了（一个请求都不发）。
  form.dataset = { id: String(item.id) };
  textarea.value = ' 这条我要转 ';
  form.querySelector = (selector) => (selector === 'textarea[name="content"]' || selector === 'textarea[name="comment"]' ? textarea : null);
  form.querySelectorAll = () => [];
  // 提交委托里是 `event.target.closest('[data-feed-repost-form]')` —— 假 DOM 的
  // `closest` 默认恒返回 null，不接这根线表单根本走不到 submitRepost。
  form.closest = (selector) => (selector === '[data-feed-repost-form]' ? form : null);
  const before = repostPosts().length;
  dispatch(app, 'submit', form);
  await settle();
  const sent = repostPosts().slice(before);
  if (!sent.length) problems.push('提交转发表单之后没有发 POST /api/feed/:id/repost');
  else if (sent[0].body?.comment !== '这条我要转') {
    problems.push(`转发语发出去是 ${JSON.stringify(sent[0].body?.comment)} —— 应该发用户当前输入的原文（trim 过）`);
  }
  const countNode = registered(`[data-feed-reposts="${item.id}"]`);
  if (countNode.textContent !== '1') {
    problems.push(`转完计数还是 ${JSON.stringify(countNode.textContent)} —— 按钮上的数字没跟着走`);
  }

  // ④ 自己的动态：也该有那颗按钮 —— 自己的也能转（转出去是一条引用自己的新动态）
  const second = pickFixture(FEED_KEY).items[1] ?? null;
  const mine = second ?? item;
  const savedMine = { authorId: mine.author.id, scope: mine.scope };
  mine.author.id = state.me?.id ?? 1;
  mine.scope = 'public';
  await timeline.viewTimeline(new Map());
  if (!hasRepostButton(mine.id)) {
    problems.push('自己的动态上没有「🔁 转发」按钮 —— 自己的动态也能转，不该画成静态计数');
  }

  // ⑤ 不是公开的动态：同样不该画按钮（服务端会回 403 repost_scope）
  mine.author.id = (state.me?.id ?? 1) + 999;
  mine.scope = 'followers';
  await timeline.viewTimeline(new Map());
  if (hasRepostButton(mine.id)) {
    problems.push('非公开的动态也画了「🔁 转发」按钮 —— 点下去服务端只会回 403 repost_scope');
  }

  console.log(`  ${problems.length ? '❌' : '✅'} 交互：转发点开才画框、发得出当前原文、计数跟着走、转不了的画静态计数`);

  item.scope = saved.scope;
  item.repostCount = saved.repostCount;
  item.reposted = saved.reposted;
  item.author.id = saved.authorId;
  mine.author.id = savedMine.authorId;
  mine.scope = savedMine.scope;
  FEED_REPOSTS.delete(item.id);
  await timeline.viewTimeline(new Map());
}

/* ---- 交互：卡片上「转发了帖子」和「引用了帖子」得说得出区别 ----
 *
 * 两条路都是往动态里放一张 `ref_post_id` 指着某篇帖子的卡，渲染出来长得一模一样；
 * 唯一的区别是 `reposts` 里有没有那一条 —— `shapeFeedItem` 把它算成 `ref.repost`。
 * 标签写错了，用户会以为自己在看引用，其实对方是转发（或者反过来）。
 */
{
  const timeline = await view('timeline.js');
  const FEED_KEY = '/api/feed?filter=all&page=1';
  const target = pickFixture(FEED_KEY).items[0];
  const savedRef = target.ref;
  const labelOf = () => {
    const html = String(registered('[data-feed-list]').innerHTML);
    const hit = html.match(/(🔁 转发了帖子|🔗 引用了帖子)/);
    return hit ? hit[1] : '';
  };

  target.ref = { id: 1, title: '被引用的帖子', deleted: false, repost: true, author: { id: 1, username: 'admin', displayName: '站长', role: 'owner', avatar: '' } };
  await timeline.viewTimeline(new Map());
  if (labelOf() !== '🔁 转发了帖子') {
    problems.push(`转发出来的卡片写着 ${JSON.stringify(labelOf() || '（没有标签）')} —— 转过这篇就该写「🔁 转发了帖子」`);
  }

  target.ref.repost = false;
  await timeline.viewTimeline(new Map());
  if (labelOf() !== '🔗 引用了帖子') {
    problems.push(`没转过的卡片写着 ${JSON.stringify(labelOf() || '（没有标签）')} —— 只是引用就该写「🔗 引用了帖子」`);
  }

  target.ref = savedRef;
  await timeline.viewTimeline(new Map());
  console.log(`  ${problems.length ? '❌' : '✅'} 交互：转发出来的卡片写「转发了帖子」、纯引用写「引用了帖子」`);
}

/* ---- 交互：动态流的筛选标签和翻页都留在动态流里 ----
 *
 * 为什么单独测：这三个标签曾经写成 `routeQuery('/', …)`，点「我关注的」直接把人弹回首页
 * ——功能没坏，但用户看到的是「点了就跳走」，只会当成坏了。翻页那条同理。
 * 标签是纯字符串拼出来的 `<a href>`，假 DOM 照得到，不需要真浏览器。
 */
{
  const timeline = await view('timeline.js');
  const tabHref = (label) => {
    const html = String(app.innerHTML);
    const hit = html.match(new RegExp(`<a class="feed-tab[^"]*" href="([^"]*)"[^>]*>${label}</a>`));
    return hit ? hit[1] : '';
  };

  await timeline.viewTimeline(new Map());
  const all = tabHref('全部');
  const following = tabHref('我关注的');
  const mine = tabHref('我的');
  if (all !== '#/feed') {
    problems.push(`「全部」标签指向 ${JSON.stringify(all || '（没找到）')} —— 该指向 #/feed，指到别处就是点了弹走`);
  }
  if (following !== '#/feed?filter=following') {
    problems.push(`「我关注的」标签指向 ${JSON.stringify(following || '（没找到）')} —— 该是 #/feed?filter=following，不然点了会弹回首页`);
  }
  if (mine !== '#/feed?filter=mine') {
    problems.push(`「我的」标签指向 ${JSON.stringify(mine || '（没找到）')} —— 该是 #/feed?filter=mine`);
  }

  // 搜索时切筛选不能把关键词丢掉。
  // 注意：href 是拼进 HTML 的，`&` 会被 esc() 转成 `&amp;` —— 浏览器读属性时再解回来，
  // 这里也照着解一次，不然断言比的是转义后的字符串。
  await timeline.viewTimeline(new Map([['q', '计数器']]));
  const searched = tabHref('我关注的').replace(/&amp;/g, '&');
  if (searched !== '#/feed?q=%E8%AE%A1%E6%95%B0%E5%99%A8&filter=following') {
    problems.push(`在搜索结果里，「我关注的」指向 ${JSON.stringify(searched || '（没找到）')} —— 切筛选不该把搜索词丢掉`);
  }
  await timeline.viewTimeline(new Map());
  console.log(`  ${problems.length ? '❌' : '✅'} 交互：动态流的三个筛选标签都指向 #/feed（搜索词会带过去），点了不会弹回首页`);
}

/* ---- 交互：积木页的转发区 —— 转得出、发完留在原地、撤销得掉 ----
 *
 * 为什么单独测：积木页的转发**故意没走 core 那条路**。`public/core/events.js` 里
 * 处理完转发/撤销都会 `Post.viewPost()` 把人甩回帖子页 —— 那是帖子页该有的行为，
 * 积木页得留在原地（见 `public/views/post.js` 里 `repostSectionHtml` 上面那段 JSDoc，
 * 以及 `public/views/doc.js` 的 `refreshDocRepost`）。`doc-smoke.mjs` 只打接口，
 * 「点了到底跳没跳页、互动条有没有跟着重画」只有这里照得到。
 */
{
  const doc = await view('doc.js');
  const anchorId = Number(FIXTURE_POST_ID);
  const anchor = pickFixture('/api/docs/1/anchor');
  const savedAuthorId = anchor.post.author.id;
  // 夹具里这篇的作者就是当前登录用户（都是 id 1）——**这正好是想要的**：
  // 自己的积木帖子以前在转发区只显示一句「自己的文章不用转发」，表单压根不出现，
  // 于是作者在自己帖子上点 🔁 什么都看不到。现在自己的也能转，表单必须照画。
  anchor.post.author.id = state.me?.id ?? 1;
  POST_REPOSTS.delete(anchorId);
  await doc.viewDoc(1);
  // `mountInteraction(doc)` 在 `public/views/doc.js:1130` 是**不 await 的**
  // （`mountInteraction(doc).catch(...)`，互动条加载失败不该拖垮整页）。
  // 所以 `viewDoc` 返回时 anchor 那一趟还没回来，这里必须自己等一拍。
  await settle();
  await settle();

  const host = registered('[data-doc-repost]');
  const bar = registered('[data-doc-interact-bar]');
  if (!host.innerHTML.includes('data-doc-form="repost"')) {
    problems.push('积木页的转发区没画出来 —— 影子行在，那颗「🔁 转发」点了也没地方去');
  }
  if (anchor.post.author.id === (state.me?.id ?? 1) && !host.innerHTML.includes('确认转发')) {
    problems.push('自己的积木帖子上转发区没有「确认转发」按钮 —— 自己的文章也能转，别再显示「不用转发」');
  }

  // ① 提交
  const form = registered('[data-doc-form="repost"]');
  form.dataset = { docForm: 'repost', id: String(anchorId) };
  // `public/views/doc.js` 的 `formValues()` 走 `form.querySelectorAll('[name]')`，
  // 而假 DOM 的 `querySelectorAll` 恒返回空数组 —— 不接这根线，发出去的转发语永远是空串，
  // 「转发语到底有没有跟着表单走」就成了测不到的空话。
  form.querySelectorAll = (selector) =>
    selector === '[name]' ? [{ name: 'comment', type: 'textarea', value: ' 这块值得一转 ' }] : [];
  const beforePost = REQUESTS.length;
  dispatch(app, 'submit', form);
  await settle();

  const posted = REQUESTS.slice(beforePost).filter((entry) => entry.url === `/api/posts/${anchorId}/repost` && entry.method === 'POST');
  if (!posted.length) problems.push('在积木页点「确认转发」之后没有 POST /api/posts/:id/repost');
  else if (posted[0].body?.comment !== '这块值得一转') {
    problems.push(`积木页发出去的转发语是 ${JSON.stringify(posted[0].body?.comment)}，不是输入框里的原文（该 trim 的也没 trim）`);
  }
  // 互动条上的那颗按钮文案与计数，是**单独**从 anchor 接口重画的：
  // 只重画下面转发区的话，页面上会同时出现「🔁 转发 0」和「名单里有你」。
  if (!bar.innerHTML.includes('已转发')) {
    problems.push('转完之后互动条没有重画 —— 按钮还写着「🔁 转发」，下面却已经列出你了');
  }
  if (!host.innerHTML.includes('撤销转发')) {
    problems.push('转完之后转发区没有重画 —— 看不到自己转过了，也找不到撤销入口');
  }

  // ② 撤销：先确认再删，删完还要回到积木页（不是帖子页）
  const cancel = makeElement('button');
  cancel.dataset = { docAction: 'repost-cancel', id: String(anchorId) };
  cancel.closest = (selector) => (selector === '[data-doc-action]' ? cancel : null);
  const realConfirm = globalThis.confirm;
  globalThis.confirm = () => true;
  const beforeDelete = REQUESTS.length;
  dispatch(app, 'click', cancel);
  await settle();
  globalThis.confirm = realConfirm;

  const deleted = REQUESTS.slice(beforeDelete).filter((entry) => entry.url === `/api/posts/${anchorId}/repost` && entry.method === 'DELETE');
  if (!deleted.length) problems.push('在积木页点「撤销转发」之后没有 DELETE /api/posts/:id/repost');
  if (host.innerHTML.includes('撤销转发')) {
    problems.push('撤销之后转发区没有回到「确认转发」—— 用户以为还转着，再点一次只会吃 400 not_reposted');
  }
  console.log(`  ${problems.length ? '❌' : '✅'} 交互：积木页转得出、发完留在原地、撤销得掉、互动条跟着重画`);

  anchor.post.author.id = savedAuthorId;
  POST_REPOSTS.delete(anchorId);
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

/* ---- 交互：文件页签能传文件、群聊能发言、成员名单能展开 ----
 *
 * 这三条路径都只有「点了之后」才走到：渲染类断言看得到外壳画出来了，
 * 但事件委托有没有接上、请求体里装了什么，只有真派发一次事件才测得到。
 * 注意假 DOM 不解析 HTML：`[data-team-chat-list]` 不是 `[data-team-chat]` 的子节点，
 * 各是各的注册元素 —— 断言要打在真正被赋值的那个盒子上。
 */
{
  try {
    const team = await view('team.js');
    const filesBox = registered('[data-team-files]');
    const chatList = registered('[data-team-chat-list]');
    const membersBox = registered('[data-team-members]');

    /* ① 文件页签：列表要有名字、下载地址、人话大小 */
    await team.viewTeam('frontend-group', new Map([['tab', 'files']]));
    await settle();
    if (!String(filesBox.innerHTML).includes('团队约定.md')) problems.push('文件页签没有渲染出文件列表');
    if (!String(filesBox.innerHTML).includes('/api/team-files/7')) problems.push('文件行里没有下载地址');
    if (!String(filesBox.innerHTML).includes('2.0 KB')) problems.push('文件行里没有人话大小');

    /* ② 选一个超过上限的文件：客户端就该拦下来，一个请求都不能发出去 */
    const picker = registered('[data-team-file-picker]');
    picker.closest = (selector) => (selector === '[data-team-file-picker]' ? picker : null);
    picker.files = [{ name: '太大了.bin', size: 8 * 1024 * 1024 }];
    picker.value = 'C:\\假路径\\太大了.bin';
    REQUESTS.length = 0;
    dispatch(app, 'change', picker);
    await settle();
    if (REQUESTS.some((item) => item.method === 'POST' && item.url.includes('/files'))) {
      problems.push('超过上限的文件还是发出去了（客户端那道拦截没起作用）');
    }
    if (picker.value !== '') problems.push('被拦住之后没有清空文件选择框（再选同一个文件不会再触发 change）');

    /* ③ 换成小文件：这次要真发出去，请求体里带文件名与 data URL。
          FileReader 是浏览器 API，假 DOM 里没有 —— 补一个最小的替身。 */
    globalThis.FileReader = class {
      readAsDataURL() {
        this.result = 'data:image/png;base64,AAAA';
        this.onload?.();
      }
    };
    picker.files = [{ name: '截图.png', size: 1024 }];
    REQUESTS.length = 0;
    dispatch(app, 'change', picker);
    await settle();
    const upload = REQUESTS.find((item) => item.method === 'POST' && item.url.split('?')[0] === '/api/teams/frontend-group/files');
    if (!upload) problems.push('选好文件之后没有发出上传请求');
    else if (upload.body?.name !== '截图.png') problems.push(`上传请求里的文件名不对：${JSON.stringify(upload.body?.name)}`);
    else if (!String(upload.body?.dataUrl || '').startsWith('data:')) problems.push('上传请求里没有带 data URL');
    if (!String(filesBox.innerHTML).includes('截图.png')) problems.push('上传成功后没有把新文件补进列表里');

    /* ④ 群聊：输入框里的字要能发出去，发完立刻出现在列表里 */
    await team.viewTeam('frontend-group', new Map([['tab', 'chat']]));
    await settle();
    if (!String(chatList.innerHTML).includes('晚上一起把文件柜试一下')) problems.push('群聊页签没有渲染出历史消息');
    const chatInput = registered('[data-team-field="message"]');
    chatInput.closest = (selector) => (selector === '[data-team-field]' ? chatInput : null);
    chatInput.dataset.teamField = 'message';
    chatInput.value = '我也在看';
    dispatch(app, 'input', chatInput);
    const sendNode = { dataset: { teamAction: 'send-message' }, disabled: false, matches: () => false };
    sendNode.closest = (selector) => (selector === '[data-team-action]' ? sendNode : null);
    REQUESTS.length = 0;
    dispatch(app, 'click', sendNode);
    await settle();
    const message = REQUESTS.find((item) => item.method === 'POST' && item.url.split('?')[0] === '/api/teams/frontend-group/messages');
    if (!message) problems.push('点「发送」之后没有发出消息请求');
    else if (message.body?.content !== '我也在看') problems.push(`发出去的消息不对：${JSON.stringify(message.body?.content)}`);
    if (!String(chatList.innerHTML).includes('我也在看')) problems.push('自己发的消息没有立刻出现在聊天列表里');

    /* ⑤ 成员名单：默认只列前几位，点「查看全部」才把完整名单拉回来 */
    await team.viewTeam('frontend-group', new Map());
    await settle();
    if (!String(membersBox.innerHTML).includes('查看全部')) problems.push('成员人数多于已列出的名单时，没有给出「查看全部」的入口');
    const moreNode = { dataset: { teamAction: 'load-all-members' }, disabled: false, matches: () => false };
    moreNode.closest = (selector) => (selector === '[data-team-action]' ? moreNode : null);
    REQUESTS.length = 0;
    dispatch(app, 'click', moreNode);
    await settle();
    if (!REQUESTS.some((item) => item.method === 'GET' && item.url.split('?')[0] === '/api/teams/frontend-group/members')) {
      problems.push('点「查看全部」之后没有去拉完整名单');
    }
    if (!String(membersBox.innerHTML).includes('小狐')) problems.push('拉回完整名单之后没有重画成员区（还是那几位）');
    if (!String(membersBox.innerHTML).includes('收起名单')) problems.push('展开之后没有给出「收起名单」的入口');

    console.log(`  ${problems.length ? '❌' : '✅'} 交互：文件能传、群聊能发、成员名单能展开`);
  } catch (error) {
    problems.push(`团队文件柜/群聊交互测试自身崩了：${error?.stack || error}`);
    console.log('  ❌ 交互：文件能传、群聊能发、成员名单能展开');
  }
}

/* ---- 交互：团队帖的「👁 预览」真的去问了服务端、也真的把结果摆出来 ----
 *
 * 为什么单独测这一条：`预览` 是纯前端动作，渲染断言只能证明按钮画出来了。
 * 真正会坏的地方只有点一下才看得见：
 *   ① `/api/markdown/preview` 发了没有、请求体里装的是不是输入框里的原文
 *      （装错了 = 预览的和发出去的永远不是一回事）；
 *   ② 回来的 HTML 有没有塞进预览盒、盒子有没有从 hidden 里放出来
 *      （漏了任何一步 = 用户点了按钮什么都没发生）；
 *   ③ 再点一次和空内容时**不该**再发请求（收起是纯本地动作，空内容本地就能判断）；
 *   ④ 预览**开着**时改内容要重新渲染（这是补的：以前只有开关、没有跟随，
 *      表现是「改完字预览还是老的」）；收起来时改内容则一个请求都不该发。
 *
 * 公式排版（`ntRenderMath`）在这一层测不到：它要等 KaTeX 脚本 onload，
 * 而假 DOM 的 `head.appendChild()` 是空实现，那个 promise 永远不会 settle ——
 * 不崩，但也不会跑。公式那一段由 `check-ui-contract.mjs` 的静态守卫盯着。
 */
{
  try {
    const team = await view('team.js');
    // 发帖框是塞进 `[data-team-composer]` 的（team.js:823-824），
    // 而假 DOM 不解析 HTML —— `[data-team-editor]` 只是同一段字符串里的一个标记，
    // 它的 innerHTML 永远是空串，断言必须打在前者身上。
    const composerBox = registered('[data-team-composer]');
    const textarea = registered('[data-team-field="content"]');
    const previewBox = registered('[data-team-preview]');
    // 委托读的是 `dataset.teamField`（不是选择器）——假 DOM 不会从选择器里反推，
    // 后面的 ④⑤ 要往这个输入框里打字，就得先把字段名补上，否则监听第一个 `if` 就 return 了。
    textarea.dataset.teamField = 'content';

    await team.viewTeam('frontend-group', new Map());
    await settle();
    if (!String(composerBox.innerHTML).includes('data-team-editor')) {
      problems.push('团队成员看自己的团队页时，没有出现发帖框（data-team-editor）');
    }
    if (!String(composerBox.innerHTML).includes('data-team-preview')) {
      problems.push('发帖框里没有预览盒（data-team-preview）');
    }
    if (!String(composerBox.innerHTML).includes('data-team-action="preview"')) {
      problems.push('发帖框里没有「预览」按钮');
    }
    if (!String(composerBox.innerHTML).includes('LaTeX')) {
      problems.push('发帖框的提示里没有告诉用户支持 Markdown 与 $LaTeX$');
    }

    // `togglePreview` 先 `node.closest('[data-team-editor]')` 找到外壳，
    // 再在外壳里 `querySelector` 那两个盒子。外壳的 querySelector 默认就是
    // `registered(selector)`（makeElement 里那行），正好接上，只需要把按钮的 closest 补全。
    const previewNode = makeElement('button');
    previewNode.dataset.teamAction = 'preview';
    previewNode.closest = (selector) =>
      selector === '[data-team-action]' ? previewNode : selector === '[data-team-editor]' ? registered('[data-team-editor]') : null;

    /* ① 写点东西点预览：要发请求、发的是原文、结果要摆出来 */
    textarea.value = '**重点**：质能方程 $E=mc^2$';
    previewBox.hidden = true;
    previewBox.innerHTML = '';
    REQUESTS.length = 0;
    dispatch(app, 'click', previewNode);
    await settle();

    const preview = REQUESTS.find((item) => item.method === 'POST' && item.url.split('?')[0] === '/api/markdown/preview');
    if (!preview) problems.push('点「预览」之后没有去请求 /api/markdown/preview');
    else if (preview.body?.content !== '**重点**：质能方程 $E=mc^2$') {
      problems.push(`预览请求里装的不是输入框里的原文：${JSON.stringify(preview.body?.content)}`);
    }
    if (previewBox.hidden) problems.push('点「预览」之后预览盒还是藏着的（用户什么都看不到）');
    if (!String(previewBox.innerHTML).includes('<p>ok</p>')) problems.push('预览回来的 HTML 没有塞进预览盒');
    if (!String(previewNode.textContent).includes('收起')) problems.push('展开预览之后按钮没有变成「收起预览」');

    /* ② 再点一次：收起来，且**不该**再问一次服务端 */
    REQUESTS.length = 0;
    dispatch(app, 'click', previewNode);
    await settle();
    if (!previewBox.hidden) problems.push('再点一次没有把预览盒藏回去');
    if (REQUESTS.some((item) => item.url.includes('/api/markdown/preview'))) {
      problems.push('收起预览时又发了一次预览请求（收起是纯本地动作）');
    }

    /* ③ 空内容：本地就该说「还没写内容」，别拿空白去问服务端 */
    textarea.value = '   ';
    REQUESTS.length = 0;
    dispatch(app, 'click', previewNode);
    await settle();
    if (!String(previewBox.innerHTML).includes('还没写内容')) problems.push('内容为空时预览盒没有给出提示');
    if (REQUESTS.some((item) => item.url.includes('/api/markdown/preview'))) {
      problems.push('内容为空还是去问了服务端（本地就能判断）');
    }

    /* ④ 预览**开着**的时候接着打字：防抖一到就拿新原文重画
     *
     * 这一条是补的：以前 `togglePreview` 只管开关，输入框上没有任何监听，
     * 表现是「改完字预览还是老的，得先收起再点开一次才更新」——渲染断言看不出来。
     * 防抖 400ms 是跟积木页（`views/doc.js` 的 `mdPreviewTimer`）对齐的，
     * 所以这里必须等过它，`settle()` 那 30ms 不够。
     */
    textarea.closest = (selector) =>
      selector === '[data-team-field]' ? textarea : selector === '[data-team-editor]' ? registered('[data-team-editor]') : null;
    textarea.value = '改过的内容';
    previewBox.innerHTML = '';
    REQUESTS.length = 0;
    dispatch(app, 'input', textarea);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const live = REQUESTS.find((item) => item.method === 'POST' && item.url.split('?')[0] === '/api/markdown/preview');
    if (!live) problems.push('预览开着时改内容，没有重新请求 /api/markdown/preview（预览是死的）');
    else if (live.body?.content !== '改过的内容') {
      problems.push(`预览重画时装的不是当前原文：${JSON.stringify(live.body?.content)}`);
    }
    if (!String(previewBox.innerHTML).includes('<p>ok</p>')) problems.push('预览重画之后盒子里的 HTML 没有换');

    /* ⑤ 预览**收起来**时打字：一个请求都不该发 */
    REQUESTS.length = 0;
    dispatch(app, 'click', previewNode);
    await settle();
    textarea.value = '收起来之后又改了';
    dispatch(app, 'input', textarea);
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (REQUESTS.some((item) => item.url.includes('/api/markdown/preview'))) {
      problems.push('预览收起来之后改内容还在发预览请求（没展开就不该问服务端）');
    }

    console.log(`  ${problems.length ? '❌' : '✅'} 交互：团队帖预览会问服务端、会摆结果、收起与空内容不再发请求、开着时跟着打字走`);
  } catch (error) {
    problems.push(`团队帖预览交互测试自身崩了：${error?.stack || error}`);
    console.log('  ❌ 交互：团队帖预览会问服务端、会摆结果、收起与空内容不再发请求、开着时跟着打字走');
  }
}

/* ---- 交互：凭团队号加入 + 团队公告的编辑与保存 ----
 *
 * 为什么单独测这一条：
 *  ① 「用团队号加入」是纯前端拼的请求（`POST /api/teams/join-by-code`）。渲染断言只证明那个框画出来了，
 *     框里填了字、点下去到底发出了什么、有没有跳进团队页，只有真派发一次点击才知道；
 *  ② 公告保存后前端要拿服务端回的 `notified` 报数、并且把编辑态收回去 —— 这两步断了，
 *     用户会以为白写了（页面还停在编辑框里）；
 *  ③ 非成员那一页上，团队号和公告必须**整个不出现**：服务端已经不给这两个字段了，
 *     前端要是自己补一版，等于把「需要邀请」这个设置当场作废。
 */
{
  try {
    const team = await view('team.js');
    const joinBox = registered('[data-team-join]');
    const hero = registered('[data-team-hero]');

    await team.viewTeams(new Map());
    await settle();
    if (!String(joinBox.innerHTML).includes('data-team-field="code"')) {
      problems.push('团队广场上没有「用团队号加入」的输入框');
    }

    /* ① 抄一个团队号进去：大小写、短横线都不讲究，服务端会折叠（这里只验原样发出去） */
    const codeInput = registered('[data-team-field="code"]');
    codeInput.dataset.teamField = 'code';
    // 委托读的是 `event.target.closest('[data-team-field]')`（不是 matches），dataset.teamField 才是字段名。
    codeInput.closest = (selector) => (selector === '[data-team-field]' ? codeInput : null);
    codeInput.value = 'k7m2qp';
    dispatch(app, 'input', codeInput);

    const joinNode = { dataset: { teamAction: 'join-by-code' }, disabled: false, matches: () => false };
    joinNode.closest = (selector) => (selector === '[data-team-action]' ? joinNode : null);
    REQUESTS.length = 0;
    dispatch(app, 'click', joinNode);
    await settle();
    const joinReq = REQUESTS.find((item) => item.method === 'POST' && item.url.split('?')[0] === '/api/teams/join-by-code');
    if (!joinReq) problems.push('点「加入」之后没有发出 POST /api/teams/join-by-code');
    else if (joinReq.body?.code !== 'k7m2qp') {
      problems.push(`凭团队号加入时发出去的号不对：${JSON.stringify(joinReq.body?.code)}（草稿没从输入框同步进 teamState.draft？）`);
    }
    if (!String(window.location.hash).replace(/^#/, '').startsWith('/team/')) {
      problems.push(`凭团队号加入之后没有跳进团队页，现在停在 ${window.location.hash}`);
    }

    /* ② 站长视角：团队号与公告都在，改完公告要回到只读态并显示新正文 */
    // 公告保存走的是 `currentSlug()`（从地址里现取 slug），所以地址得先真的落到这个团队上，
    // 否则请求会打到上一场交互留下的那个 slug（这里踩过：打到了 new-team-1）。
    window.location.hash = '#/team/frontend-group';
    await team.viewTeam('frontend-group', new Map());
    await settle();
    if (!String(hero.innerHTML).includes('data-team-code')) problems.push('成员看团队主页时没有团队号那一行');
    if (!String(hero.innerHTML).includes('K7M2QP')) problems.push('团队号没有真的画出来');
    if (!String(hero.innerHTML).includes('data-team-notice')) problems.push('成员看团队主页时没有公告卡片');

    const editNode = { dataset: { teamAction: 'edit-announcement' }, disabled: false, matches: () => false };
    editNode.closest = (selector) => (selector === '[data-team-action]' ? editNode : null);
    dispatch(app, 'click', editNode);
    await settle();
    if (!String(hero.innerHTML).includes('data-team-field="announcement"')) {
      problems.push('点「改公告」之后没有出现编辑框（团长改不了公告）');
    }

    const noticeInput = registered('[data-team-field="announcement"]');
    noticeInput.dataset.teamField = 'announcement';
    noticeInput.closest = (selector) => (selector === '[data-team-field]' ? noticeInput : null);
    noticeInput.value = '改期到周六晚上八点。';
    dispatch(app, 'input', noticeInput);

    const saveNode = { dataset: { teamAction: 'save-announcement' }, disabled: false, matches: () => false };
    saveNode.closest = (selector) => (selector === '[data-team-action]' ? saveNode : null);
    REQUESTS.length = 0;
    dispatch(app, 'click', saveNode);
    await settle();
    const noticeReq = REQUESTS.find(
      (item) => item.method === 'PUT' && item.url.split('?')[0] === '/api/teams/frontend-group/announcement',
    );
    if (!noticeReq) problems.push('点「保存公告」之后没有发出 PUT .../announcement');
    else if (noticeReq.body?.announcement !== '改期到周六晚上八点。') {
      problems.push(`公告正文发出去不对：${JSON.stringify(noticeReq.body?.announcement)}`);
    }
    if (String(hero.innerHTML).includes('data-team-field="announcement"')) {
      problems.push('保存之后还停在编辑态（编辑框没收回去）');
    }
    if (!String(hero.innerHTML).includes('改期到周六晚上八点。')) {
      problems.push('保存之后公告卡片上没显示新正文');
    }

    /* ③ 非成员视角：团队号与公告整块不出现 */
    await team.viewTeam('outsider-group', new Map());
    await settle();
    const outsiderHero = String(hero.innerHTML);
    if (outsiderHero.includes('data-team-code')) problems.push('非成员那一页上画出了团队号（等于把「需要邀请」作废）');
    if (outsiderHero.includes('data-team-notice')) problems.push('非成员那一页上画出了公告卡片');
    if (!outsiderHero.includes('加入团队')) problems.push('非成员那一页上反而没有「加入团队」按钮');

    console.log(`  ${problems.length ? '❌' : '✅'} 交互：凭团队号加入会跳队，公告能改能存，非成员看不到号与公告`);
  } catch (error) {
    problems.push(`团队号 / 公告交互测试自身崩了：${error?.stack || error}`);
    console.log('  ❌ 交互：凭团队号加入会跳队，公告能改能存，非成员看不到号与公告');
  }
}

/* ---- 交互：团队帖详情页与回复 ----------------------------------------------------
 *
 * 为什么单独测这一条：点标题进详情、发回复、删回复、点「复制」抄团队号 ——
 * 这四件事全都只在**用户点了按钮**之后才发生，渲染类断言一个都看不见。
 * 团队号的「复制」之前就是这种坏法：按钮在、样式也在，点下去却什么也没发生。
 */
{
  try {
    const team = await view('team.js');
    const detail = registered('[data-team-post-detail]');
    const replies = registered('[data-team-replies]');
    const form = registered('[data-team-reply-form]');

    // 地址要真的落在详情页上：发回复 / 删回复走的都是 `currentSlug()`（从地址里现取），
    // 停在上一场的团队上就会把回复发到别的团队去。
    window.location.hash = '#/team/frontend-group/post/1';
    await team.viewTeamPost('frontend-group', 1, new Map());
    await settle();

    /* ① 详情页把帖子与回复都画出来了 */
    const detailHtml = String(detail.innerHTML);
    if (!detailHtml.includes('团队第一条帖子')) problems.push('详情页上没有帖子标题');
    if (!detailHtml.includes('大家好，这里是团队的地盘。')) problems.push('详情页上没有帖子正文');
    if (!detailHtml.includes('data-team-reply-count')) problems.push('详情页上没有「N 条回复」那一行');
    if (detailHtml.includes('data-team-action="edit-post"')) {
      problems.push('详情页上画了「编辑」：编辑流程收尾会 refreshTeam()，在详情页点会把人甩回团队主页');
    }

    const replyHtml = String(replies.innerHTML);
    if (!replyHtml.includes('那我把接口先定下来')) problems.push('详情页上没有画出已有的回复');
    if (!replyHtml.includes('小狐')) problems.push('详情页上没有画出别人的回复');
    const deleteButtons = (replyHtml.match(/data-team-action="delete-reply"/g) ?? []).length;
    if (deleteButtons !== 1) {
      problems.push(`回复上的「删除」只该出现在自己能删的那一条上，实际画了 ${deleteButtons} 个`);
    }
    if (!String(form.innerHTML).includes('data-team-field="reply"')) problems.push('成员在详情页上没有回复框');

    /* ② 写一条回复发出去：请求体、输入框清空、列表重拉 */
    const box = registered('[data-team-field="reply"]');
    box.dataset.teamField = 'reply';
    // 委托读的是 `event.target.closest('[data-team-field]')`（不是 matches），见上面团队号那一段。
    box.closest = (selector) => (selector === '[data-team-field]' ? box : null);
    box.value = '接口我今晚发到群里。';
    dispatch(app, 'input', box);

    // 真浏览器里这两个属性在同一个 textarea 上；假 DOM 是按选择器各发一个元素，
    // 所以「清空」这一条要盯着视图真正去取的那个（`[data-team-reply-field]`）。
    const replyField = registered('[data-team-reply-field]');
    replyField.value = '接口我今晚发到群里。';

    const replyNode = { dataset: { teamAction: 'create-reply', teamPost: '1' }, disabled: false, matches: () => false };
    replyNode.closest = (selector) => (selector === '[data-team-action]' ? replyNode : null);
    REQUESTS.length = 0;
    dispatch(app, 'click', replyNode);
    await settle();
    const replyReq = REQUESTS.find(
      (item) => item.method === 'POST' && item.url.split('?')[0] === '/api/teams/frontend-group/posts/1/replies',
    );
    if (!replyReq) problems.push('点「回复」之后没有发出 POST …/posts/1/replies');
    else if (replyReq.body?.content !== '接口我今晚发到群里。') {
      problems.push(`回复内容发出去不对：${JSON.stringify(replyReq.body?.content)}（草稿没从输入框同步进 teamState.draft？）`);
    }
    if (replyField.value !== '') problems.push('发完回复之后输入框没有清空');
    if (!REQUESTS.some((item) => item.method === 'GET' && item.url.split('?')[0] === '/api/teams/frontend-group/posts/1/replies')) {
      problems.push('发完回复之后没有重拉回复列表（顺序与条数应该由服务端说了算）');
    }

    /* ③ 删一条回复 */
    const deleteNode = {
      dataset: { teamAction: 'delete-reply', teamPost: '1', teamReply: '11' },
      disabled: false,
      matches: () => false,
    };
    deleteNode.closest = (selector) => (selector === '[data-team-action]' ? deleteNode : null);
    REQUESTS.length = 0;
    dispatch(app, 'click', deleteNode);
    await settle();
    if (!REQUESTS.some((item) => item.method === 'DELETE' && item.url.split('?')[0] === '/api/teams/frontend-group/posts/1/replies/11')) {
      problems.push('点回复上的「删除」没有发出 DELETE …/replies/11');
    }

    /* ④ 团队号的「复制」在非安全上下文里也要真的复制 */
    // Node 里本来就没有剪贴板；真有的话这一段测的就不是「退到 execCommand」那条路了。
    if (globalThis.navigator?.clipboard?.writeText) {
      problems.push('测试环境居然有 navigator.clipboard —— 这一条就没在测非安全上下文那条路');
    }
    const copyNode = { dataset: { teamAction: 'copy-join-code', code: 'K7M2QP' }, disabled: false, matches: () => false };
    copyNode.closest = (selector) => (selector === '[data-team-action]' ? copyNode : null);
    execCommands.length = 0;
    dispatch(app, 'click', copyNode);
    await settle();
    if (!execCommands.includes('copy')) {
      problems.push('非安全上下文里点「复制团队号」没有走到 execCommand 那一档（clipboard API 在 http + 局域网地址下是 undefined）');
    }

    console.log(`  ${problems.length ? '❌' : '✅'} 交互：帖子点得进详情、回复发得出删得掉、团队号在非安全上下文也能复制`);
  } catch (error) {
    problems.push(`团队帖详情 / 回复交互测试自身崩了：${error?.stack || error}`);
    console.log('  ❌ 交互：帖子点得进详情、回复发得出删得掉、团队号在非安全上下文也能复制');
  }
}

/* ---- 交互：路人递申请 → 管理员批申请 → 创建者把团队藏起来 ----
 *
 * 这一段自带 try/catch 的理由和上面那段一样：脚本装了 uncaughtException 处理器，
 * 顶层 await 之后抛出来的异常会被吞掉，整个脚本会以 exit 0 静悄悄地过去。
 */
{
  try {
    const team = await view('team.js');
    const hero = registered('[data-team-hero]');
    const click = (dataset) => {
      const node = { dataset, disabled: false, matches: () => false };
      node.closest = (selector) => (selector === '[data-team-action]' ? node : null);
      dispatch(app, 'click', node);
      return node;
    };
    let html = '';

    /* ① 路人看「需要申请」的团队：给的是「申请加入」，不是直接进 */
    window.location.hash = '#/team/apply-group';
    await team.viewTeam('apply-group', new Map());
    html = String(hero.innerHTML);
    if (!html.includes('data-team-action="apply-team"')) {
      problems.push('「需要申请」的团队在路人眼里没有「申请加入」按钮');
    }
    if (html.includes('data-team-action="join-team"')) {
      problems.push('「需要申请」的团队居然直接给了「加入团队」——申请那道门形同虚设');
    }

    click({ teamAction: 'apply-team' });
    await settle();
    html = String(hero.innerHTML);
    if (!html.includes('data-team-field="applyMessage"')) problems.push('点「申请加入」之后没有出现填理由的框');

    const applyBox = registered('[data-team-field="applyMessage"]');
    applyBox.dataset.teamField = 'applyMessage';
    // 委托读的是 `event.target.closest('[data-team-field]')`（不是 matches），下同。
    applyBox.closest = (selector) => (selector === '[data-team-field]' ? applyBox : null);
    applyBox.value = '我在做前端，想找人一起看看代码。';
    dispatch(app, 'input', applyBox);
    REQUESTS.length = 0;
    click({ teamAction: 'submit-apply' });
    await settle();
    const applyReq = REQUESTS.find(
      (item) => item.method === 'POST' && item.url.split('?')[0] === '/api/teams/apply-group/join',
    );
    if (!applyReq) problems.push('点「递申请」没有发出 POST …/apply-group/join');
    else if (applyReq.body?.message !== '我在做前端，想找人一起看看代码。') {
      problems.push(`申请理由发出去不对：${JSON.stringify(applyReq.body?.message)}（applyMessage 没同步进草稿？）`);
    }

    /* ② 已经递过申请的人：看得到「审核中」，能把申请收回来 */
    window.location.hash = '#/team/pending-group';
    await team.viewTeam('pending-group', new Map());
    html = String(hero.innerHTML);
    if (!html.includes('data-team-request-pending')) problems.push('递过申请的人在团队页上看不到「申请审核中」');
    if (html.includes('data-team-action="apply-team"')) {
      problems.push('还在等审核，页面上却又画着「申请加入」——点一下就会递出第二条');
    }
    REQUESTS.length = 0;
    click({ teamAction: 'withdraw-request' });
    await settle();
    if (!REQUESTS.some((item) => item.method === 'DELETE' && item.url.split('?')[0] === '/api/teams/pending-group/join-requests/7')) {
      problems.push('点「撤回申请」没有发出 DELETE …/join-requests/7');
    }

    /* ③ 管理员审申请：抽屉里拉待审列表 → 切页签 → 批准 */
    window.location.hash = '#/team/frontend-group';
    await team.viewTeam('frontend-group', new Map());
    click({ teamAction: 'toggle-requests' });
    await settle();
    // 抽屉是壳体：视图先往 `[data-team-drawer]` 里塞整套 `<div class="team-drawer">…`，
    // 申请列表再由 renderJoinRequests 写进其中的 `[data-team-drawer-body]`。
    // 假 DOM 不解析 innerHTML，所以这两层要各查各的。
    const drawer = registered('[data-team-drawer]');
    const drawerHtml = String(drawer.innerHTML);
    if (!drawerHtml.includes('data-team-drawer-panel="requests"')) {
      problems.push('点「📨 加入申请」没有弹出抽屉');
    }
    if (!drawerHtml.includes('team-drawer-mask')) problems.push('抽屉没有遮罩（点空白处关不掉）');
    if (!drawerHtml.includes('data-team-action="close-panel"')) problems.push('抽屉上没有「关闭」出口');
    if (!drawerHtml.includes('data-team-drawer-body')) problems.push('抽屉没有装内容的那一层');
    if (String(hero.innerHTML).includes('data-team-drawer')) {
      problems.push('抽屉居然画进了 hero 里（它该是 fixed 的一层，不该把主页顶下去）');
    }

    const list = registered('[data-team-drawer-body]');
    html = String(list.innerHTML);
    if (!html.includes('data-team-request-card')) problems.push('打开「加入申请」抽屉之后没有画出待审列表');
    if (!html.includes('新来的')) problems.push('待审列表里没有画出申请人');
    if (!html.includes('（没写理由）')) problems.push('申请没写理由时没有画成「（没写理由）」');
    const approveButtons = (html.match(/data-team-action="approve-request"/g) ?? []).length;
    if (approveButtons !== 2) problems.push(`待审两条却画了 ${approveButtons} 个「批准加入」按钮`);

    REQUESTS.length = 0;
    click({ teamAction: 'requests-status', status: 'rejected' });
    await settle();
    if (!REQUESTS.some((item) => item.method === 'GET' && item.url.includes('/join-requests?status=rejected'))) {
      problems.push('切「已拒绝」页签没有带上 status=rejected 重拉列表');
    }

    const approveNode = { dataset: { teamAction: 'approve-request', teamRequest: '41' }, disabled: false, matches: () => false };
    approveNode.closest = (selector) => (selector === '[data-team-action]' ? approveNode : null);
    REQUESTS.length = 0;
    dispatch(app, 'click', approveNode);
    await settle();
    const approveReq = REQUESTS.find(
      (item) => item.method === 'PUT' && item.url.split('?')[0] === '/api/teams/frontend-group/join-requests/41',
    );
    if (!approveReq) problems.push('点「批准加入」没有发出 PUT …/join-requests/41');
    else if (approveReq.body?.action !== 'approve') {
      problems.push(`批准请求的动作不对：${JSON.stringify(approveReq.body)}（应该是 { action: 'approve' }）`);
    }

    /* ④ 创建者在设置里把团队从广场藏起来（设置表单也住在抽屉里） */
    click({ teamAction: 'toggle-settings' });
    await settle();
    const settingsDrawer = String(registered('[data-team-drawer]').innerHTML);
    if (!settingsDrawer.includes('data-team-drawer-panel="settings"')) {
      problems.push('点「团队设置」没有弹出设置抽屉');
    }
    if (String(hero.innerHTML).includes('data-team-field="listed"')) {
      problems.push('「出现在团队广场」那个开关还留在主页 hero 里（应该只出现在设置抽屉里）');
    }
    // 设置表单是**外层抽屉 innerHTML 字符串**的一部分；
    // 只有申请列表会被 renderJoinRequests 直接写进 `[data-team-drawer-body]`。
    // 假 DOM 不解析 innerHTML，所以这里只能在外层字符串上找。
    if (!settingsDrawer.includes('data-team-field="listed"')) {
      problems.push('创建者打开团队设置之后看不到「出现在团队广场」那个开关');
    }
    const listedField = registered('[data-team-field="listed"]');
    listedField.dataset.teamField = 'listed';
    listedField.closest = (selector) => (selector === '[data-team-field]' ? listedField : null);
    listedField.value = '0';
    dispatch(app, 'input', listedField);

    const saveNode = { dataset: { teamAction: 'save-settings' }, disabled: false, matches: () => false };
    saveNode.closest = (selector) => (selector === '[data-team-action]' ? saveNode : null);
    REQUESTS.length = 0;
    dispatch(app, 'click', saveNode);
    await settle();
    const settingsReq = REQUESTS.find(
      (item) => item.method === 'PUT' && item.url.split('?')[0] === '/api/teams/frontend-group',
    );
    if (!settingsReq) problems.push('点「保存设置」没有发出 PUT /api/teams/frontend-group');
    else if (settingsReq.body?.listed !== '0') {
      problems.push(`隐藏开关没送出去：listed=${JSON.stringify(settingsReq.body?.listed)}（teamListedValue 读的是草稿）`);
    } else if (!settingsReq.body?.name) {
      problems.push('保存设置时把团队名送成了空串 —— 只想点一下保存，结果名字被改没');
    }

    /* ⑤ 「💬 回复」按钮：列表上点它跳进详情页的回复框，详情页里点它只挪光标 */
    window.location.hash = '#/team/outsider-group';
    await team.viewTeam('outsider-group', new Map());
    const postListHtml = String(registered('[data-team-posts]').innerHTML);
    if (!postListHtml.includes('data-team-action="reply-post"')) {
      problems.push('列表里的帖子没有「💬 回复」按钮');
    }
    if (postListHtml.includes('data-team-action="edit-post"')) {
      problems.push('别人发的帖子（canEdit=false）居然画出了「编辑」按钮');
    }

    REQUESTS.length = 0;
    click({ teamAction: 'reply-post', teamPost: '1' });
    await settle();
    if (!String(window.location.hash).includes('/team/outsider-group/post/1?reply=1')) {
      problems.push(`列表上点「回复」没有落到详情页的回复框（hash = ${JSON.stringify(window.location.hash)}）`);
    }
    if (REQUESTS.length) problems.push('列表上点「回复」不该自己发请求（接口交给详情页去拉）');

    // 已经在详情页：再点一次只聚焦，不跳页、不重画（否则读到一半的位置就没了）。
    window.location.hash = '#/team/frontend-group/post/1';
    await team.viewTeamPost('frontend-group', 1, new Map());
    const focusBox = registered('[data-team-reply-field]');
    let focused = 0;
    focusBox.focus = () => {
      focused += 1;
    };
    const stayHash = String(window.location.hash);
    click({ teamAction: 'reply-post', teamPost: '1' });
    await settle();
    if (focused !== 1) problems.push('在详情页点「回复」没有把光标送进回复框');
    if (String(window.location.hash) !== stayHash) problems.push('在详情页点「回复」居然跳走了（该原地聚焦）');

    // 列表上那个按钮走的是 `?reply=1` 这条路：详情页画完就该自己把光标送进去。
    let autoFocused = 0;
    focusBox.focus = () => {
      autoFocused += 1;
    };
    await team.viewTeamPost('frontend-group', 1, new Map([['reply', '1']]));
    if (autoFocused !== 1) problems.push('带 ?reply=1 进详情页没有自动聚焦回复框');

    console.log(`  ${problems.length ? '❌' : '✅'} 交互：路人递申请、管理员批申请、创建者能把团队藏起来、编辑权只归作者`);
  } catch (error) {
    problems.push(`团队申请 / 审核交互测试自身崩了：${error?.stack || error}`);
    console.log('  ❌ 交互：路人递申请、管理员批申请、创建者能把团队藏起来、编辑权只归作者');
  }
}

/* ---- 交互：编辑器的自动保存 ----
 *
 * 为什么单独测这一条：`views/doc.js` 的自动保存是「作者忘了点保存，东西也得留下来」这**一条**
 * 承诺的全部实现，而静态哨兵（doc-smoke 的 S4）只能证明那些名字写在文件里 —— 定时器到底响没响、
 * 送出去的是哪一条请求、服务端拒绝之后界面说什么，只有让假 DOM 真跑一遍才看得见。
 * 钉住五件事：
 *   ① 改完停手一会儿，PUT 自己发出去了，而且**只发该发的那一条**（没顺手把标题/可见范围也重写一遍）；
 *   ② 存完那颗灯说「已自动保存」（作者得知道东西存下去了，而不是等关页面才发现全丢了）；
 *   ③ 没到最小间隔就不重复存 —— 修订记录只有 50 条（`MAX_DOC_REVISIONS`），
 *      敲一下存一次等于把「回滚到昨天那一版」这个真需求弄没了；
 *   ④ 撞上服务端「块数暴跌」的 409：安静这条路**绝不替作者点确认框**、也绝不自己带 `?confirm=1` 重来；
 *   ⑤ 离开编辑页（切到阅读页）之前，排着的那一发会**尽力**发出去。
 *
 * 计时器是真的：`AUTO_SAVE_IDLE_MS` 是 2500ms，所以这一段的等待是实打实的（一共约 8 秒）。
 * 假 DOM 里 `document.querySelectorAll` 一律回空数组，所以积木模式的「哪几块脏了」测不到
 * （那一半由 doc-smoke 的静态哨兵盯着），这里测的是它旁边那条路：改标题也会自动存。
 */
{
  const titleBox = registered('[data-doc-title]');
  const scopeBox = registered('[data-doc-scope]');
  const tagsBox = registered('[data-doc-tags]');
  const scriptBox = registered('[data-doc-script-write]');
  const mdBox = registered('[data-doc-markdown]');
  const saveLight = registered('[data-doc-save-status]');
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const putsTo = (path) => REQUESTS.filter((item) => item.method === 'PUT' && item.url.split('?')[0] === path);

  try {
    const docView = await view('doc.js');
    const detail = pickFixture('/api/docs/1');
    await docView.viewDocEdit(1, new Map([['mode', 'markdown']]));
    await settle();

    // 假 DOM 不解析 HTML，所以那些 `value="…"` 得按真页面的样子摆一遍。
    // 不摆的话 `saveAll()` 会以「标题不能为空」整条跳过 —— 那就不是在测自动保存了。
    titleBox.value = detail.doc.title;
    scopeBox.value = detail.doc.scope;
    tagsBox.value = (detail.doc.tags ?? []).join(', ');
    scopeBox.dataset.docScope = '';
    titleBox.dataset.docTitle = '';
    tagsBox.dataset.docTags = '';
    mdBox.dataset.docMarkdown = '';
    mdBox.value = '## 采样标题\n\n- 甲\n- 乙\n\n- 丙';

    /* ① 服务端说「这次改动会让块数暴跌」：安静这条路不该替作者确认，也不该自己重来一遍 */
    let confirms = 0;
    const realConfirm = window.confirm;
    window.confirm = () => {
      confirms += 1;
      return true;
    };
    globalThis.confirm = window.confirm;
    FORCED_FAILURES.set('PUT /api/docs/1/markdown', { status: 409, code: 'conflict', message: '块数从 6 掉到 2，确认这样存？' });
    REQUESTS.length = 0;
    dispatch(app, 'input', mdBox);
    await wait(3000);
    const rejected = putsTo('/api/docs/1/markdown');
    if (rejected.length !== 1) problems.push(`自动保存撞上 409 之前发了 ${rejected.length} 次 PUT /markdown（该是一次，然后停下来问人）`);
    if (confirms !== 0) problems.push('自动保存撞上「块数暴跌」，居然替作者弹了确认框（那是「这次改动算数」的决定，只有人能点）');
    if (REQUESTS.some((item) => String(item.url).includes('confirm=1'))) problems.push('自动保存撞上 409 之后自己带 ?confirm=1 重来了（等于替作者按了确认）');
    if (!String(saveLight.textContent).includes('跳过')) problems.push(`自动保存被服务端拒了，那颗灯却没说明原因：「${saveLight.textContent}」`);
    if (saveLight.dataset.docSaveKind !== 'warn') problems.push(`被服务端拒了之后那颗灯该是 warn，现在是 ${saveLight.dataset.docSaveKind}`);

    /* ② 正常那一发：请求送出去、正文是新的、那颗灯说「已自动保存」 */
    FORCED_FAILURES.delete('PUT /api/docs/1/markdown');
    mdBox.value = '## 采样标题\n\n- 甲\n- 乙\n\n- 丙\n\n- 丁';
    REQUESTS.length = 0;
    dispatch(app, 'input', mdBox);
    await wait(3000);
    const saved = putsTo('/api/docs/1/markdown');
    if (saved.length !== 1) problems.push(`改完停手 3 秒，PUT /api/docs/1/markdown 发了 ${saved.length} 次（该是一次）`);
    else if (!String(saved[0].body?.markdown).includes('- 丁')) problems.push(`自动保存送出去的正文不对：${JSON.stringify(saved[0].body?.markdown)}`);
    if (REQUESTS.length !== saved.length) {
      problems.push(`自动保存顺手发了别的请求：${REQUESTS.map((item) => `${item.method} ${item.url}`).join('、')}`);
    }
    if (!String(saveLight.textContent).includes('已自动保存')) problems.push(`存完那颗灯还写着「${saveLight.textContent}」`);
    if (saveLight.dataset.docSaveKind !== 'ok') problems.push(`存完那颗灯的颜色不是 ok：${saveLight.dataset.docSaveKind}`);

    /* ③ 刚存完又敲：最小间隔之内不许再存一次 */
    mdBox.value = '## 采样标题\n\n- 甲\n- 乙\n\n- 丙\n\n- 丁\n\n- 戊';
    REQUESTS.length = 0;
    dispatch(app, 'input', mdBox);
    await wait(3000);
    if (putsTo('/api/docs/1/markdown').length) problems.push('刚存完 3 秒又存了一次 —— 最小间隔没生效，50 条修订记录会被刷满');

    /* ④ 离开编辑页：排着的那一发放出去（作者切走也算「这一段写完了」） */
    REQUESTS.length = 0;
    await docView.viewDoc(1);
    await settle();
    if (!putsTo('/api/docs/1/markdown').length) problems.push('切到阅读页之前没有把排着的自动保存放出去（那几十个字就这么没了）');

    /* ⑤ 积木模式改标题：没有文本草稿，自动保存同样得管（那边靠离开时那一发验证） */
    await docView.viewDocEdit(1, new Map([['mode', 'blocks']]));
    await settle();
    titleBox.value = '改过的标题';
    REQUESTS.length = 0;
    dispatch(app, 'input', titleBox);
    await docView.viewDoc(1);
    await settle();
    const metaSaved = putsTo('/api/docs/1').find((item) => item.body?.title === '改过的标题');
    if (!metaSaved) problems.push('在积木模式下改标题，离开时没有自动存（标题也是「这篇改好了」的一部分）');
    if (putsTo('/api/docs/1/markdown').length) problems.push('积木模式下改标题，居然还顺手发了一条 PUT /markdown');

    window.confirm = realConfirm;
    globalThis.confirm = realConfirm;
    FORCED_FAILURES.delete('PUT /api/docs/1/markdown');
    console.log(`  ${problems.length ? '❌' : '✅'} 交互：自动保存会自己存、存完报告、不到间隔不重复存、撞 409 不替作者确认、离开前尽力存一发`);
  } catch (error) {
    problems.push(`自动保存交互测试自身崩了：${error?.stack || error}`);
    console.log('  ❌ 交互：自动保存会自己存、存完报告、不到间隔不重复存、撞 409 不替作者确认、离开前尽力存一发');
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
    // 对象字面量 / 类体里的**简写方法**（`restore() { … }`）也是定义。
    // 下面按行扫「名字后面跟括号」的启发式分不清定义与调用，会把这类方法当成裸调用，
    // 所以先把这些名字登记成「本文件声明过」。
    for (const m of source.matchAll(/([\w$]+)\s*\([^()]*\)\s*\{/g)) known.add(m[1]);
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

  // 只抠注释与单/双引号字符串，**保留模板串**：`${...}` 插值里的代码还得看得见。
  // （`blankOut` 会把整段模板串换成空格，而下面要抓的那类错恰恰全藏在插值里。）
  const blankOutKeepingTemplates = (source) =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
      .replace(/'(?:[^'\\\n]|\\.)*'/g, '""')
      .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');

  /** 一个文件到底导出了哪些名字（`export function/const` 与 `export { … }` 两种写法都算）。 */
  const exportCache = new Map();
  const exportedNamesOf = (filePath) => {
    if (!exportCache.has(filePath)) {
      const names = new Set();
      let source = '';
      try {
        source = readFileSync(filePath, 'utf8');
      } catch {
        // 读不到就当「没有导出」，交给调用处按「模块不存在」处理。
      }
      for (const m of source.matchAll(/export\s+(?:async\s+)?(?:function|class)\s+([\w$]+)/g)) names.add(m[1]);
      for (const m of source.matchAll(/export\s+(?:const|let|var)\s+([\w$]+)/g)) names.add(m[1]);
      for (const m of source.matchAll(/export\s*\{([^}]*)\}/g)) {
        for (const part of m[1].split(',')) {
          const name = part.trim().split(/\s+as\s+/).pop().trim();
          if (name) names.add(name);
        }
      }
      if (/export\s+default/.test(source)) names.add('default');
      exportCache.set(filePath, names);
    }
    return exportCache.get(filePath);
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

    /* 名字空间成员：`import * as Fmt from '../core/format.js'` 之后写 `Fmt.time(...)`，
     * 而 format.js 压根没导出 `time` —— 线上 `#/ai-edit` 整页就报
     * `TypeError: Fmt.time is not a function`（这条比下面那条更阴：渲染测试用的空夹具
     * 走不到那三行插值，全绿）。上面那条规则只盯 `名字(`，前面带点的成员调用被
     * `(?<![\w.$])` 一律跳过，所以这一类必须在这里单独钉。 */
    const codeLines = blankOutKeepingTemplates(raw).split('\n');
    for (const imp of raw.matchAll(/import\s*\*\s*as\s+([\w$]+)\s+from\s*'([^']+)'/g)) {
      const alias = imp[1];
      const spec = imp[2];
      if (!spec.startsWith('.')) continue; // 裸模块名（node: 之类）不在这儿管
      const base = join(dirname(file), spec);
      const target = existsSync(base) ? base : existsSync(`${base}.js`) ? `${base}.js` : null;
      if (!target) {
        problems.push(`${file.slice(ROOT.length + 1)} 里 \`import * as ${alias} from '${spec}'\` 指的文件不存在`);
        continue;
      }
      const exported = exportedNamesOf(target);
      if (!exported.size) continue; // 抓不出导出（比如整段 re-export）就不乱报
      const memberPattern = new RegExp(`(?<![\\w$.])${alias}\\.([a-zA-Z_$][\\w$]*)`, 'g');
      codeLines.forEach((line, index) => {
        for (const use of line.matchAll(memberPattern)) {
          if (exported.has(use[1])) continue;
          problems.push(
            `${file.slice(ROOT.length + 1)}:${index + 1} 调了 ${alias}.${use[1]}，但 ${spec} 根本没导出这个名字 —— 运行到就是 TypeError`,
          );
        }
      });
    }

    /* 具名导入写错名字也一样：`import { toastError } from '../core/errors.js'` 若那边叫别的，
     * 上面那条「裸调用」规则反倒会把它当成已知名字放过去。 */
    for (const imp of raw.matchAll(/import\s*\{([^}]*)\}\s*from\s*'(\.[^']+)'/g)) {
      const base = join(dirname(file), imp[2]);
      const target = existsSync(base) ? base : existsSync(`${base}.js`) ? `${base}.js` : null;
      if (!target) continue;
      const exported = exportedNamesOf(target);
      if (!exported.size) continue;
      for (const part of imp[1].split(',')) {
        const piece = part.trim();
        if (!piece) continue;
        const original = piece.split(/\s+as\s+/)[0].trim();
        const local = piece.split(/\s+as\s+/).pop().trim();
        if (exported.has(original)) continue;
        problems.push(`${file.slice(ROOT.length + 1)} 从 ${imp[2]} 导入了 ${local}，但那边没导出 ${original}`);
      }
    }
  }
  if (scanned < 25) problems.push(`只扫到 ${scanned} 个前端模块，文件枚举八成坏了（正常是二十九个）`);
  console.log(`  ${problems.length ? '❌' : '✅'} 静态：${scanned} 个前端模块里没有「裸调用未定义的名字」，也没有「调了隔壁模块没导出的成员」`);
}

/*
 * 换页要拆沙箱：积木里的小应用是「页面的附庸」，人跳走了它就该死。
 *
 * 积木自己的 `leaveDocPage()` 只覆盖它那几条出口（返回广场、删掉、换篇……），
 * 用户直接点侧栏或站内链接跳走时走不到 —— 兜底必须落在 router 上。
 * 不拆的两个后果都不好查：看门狗两秒后去动已经摘掉的 iframe；
 * 已经 ready 的沙箱整场会话留在 registry 里，人走了它还在后台活着、还发得出请求。
 *
 * 这条断言是**真的挂一个沙箱再换页**，不是 grep 源码里有没有那几个字。
 */
{
  const Sandbox = await import(pathToFileURL(join(ROOT, 'public', 'core', 'sandbox.js')).href);
  const { route } = await import(pathToFileURL(join(ROOT, 'public', 'core', 'router.js')).href);
  const frame = makeElement('iframe');
  frame.contentWindow = {}; // 假 DOM 的 iframe 没有 contentWindow，attachSandbox 靠它当 registry 的键
  Sandbox.attachSandbox(frame, { block_id: 'b-sandbox', props: {} }, {});
  const mounted = Sandbox.sandboxCount();
  if (mounted !== 1) problems.push(`刚挂上的沙箱没进 registry（sandboxCount = ${mounted}），这条断言就等于没测`);

  window.location.hash = '#/feed';
  await route();
  const left = Sandbox.sandboxCount();
  if (left !== 0) {
    problems.push(`换页之后还挂着 ${left} 个沙箱 —— 人已经离开那篇积木帖子了，小应用却还在后台跑（router.js 换页时要 unmountSandboxes）`);
  }
  console.log('  ✅ 交互：换页会把积木的小应用沙箱拆干净（不拆就是人走了它还在跑）');
}

/*
 * ---- 站务公告：首页只放 5 条，全部在 `#/announcements` ----
 *
 * 「主页只显示 5 个」是用户明确提的要求，所以这里**真发一次请求**看它要了几条：
 * 要多了（比如顺手写上 perPage=20）首页就会变成 20 条，而那种错在肉眼上很难发现 ——
 * 接口照常返回、页面照常好看，只是悄悄多了 15 条。
 */
{
  const Start = await import(pathToFileURL(join(ROOT, 'public', 'views', 'start.js')).href);
  const postsRequests = () => REQUESTS.filter((item) => item.method === 'GET' && item.url.startsWith('/api/posts?'));

  const beforeHome = postsRequests().length;
  await Start.viewStart();
  const homeReqs = postsRequests().slice(beforeHome);
  const homeAnnounce = homeReqs.find((item) => item.url.includes('board=meta'));
  if (!homeAnnounce) problems.push('首页根本没去取站务公告 —— 那块会永远是空的');
  else if (!/\bperPage=5\b/.test(homeAnnounce.url)) {
    problems.push(`首页取公告时写了 ${homeAnnounce.url} —— 用户要求主页只显示 5 条，perPage 必须是 5`);
  }
  // 假 DOM 不解析 innerHTML，所以只能在这一页还挂着的时候从字符串里找入口
  if (!/class="announce-more" href="#\/announcements"/.test(String(app.innerHTML))) {
    problems.push('首页公告块上没有去 #/announcements 的入口 —— 用户点不进「全部」');
  }

  const beforeAll = postsRequests().length;
  await Start.viewAnnouncements(new URLSearchParams({ page: '2' }));
  const allReqs = postsRequests().slice(beforeAll);
  const allAnnounce = allReqs.find((item) => item.url.includes('board=meta'));
  if (!allAnnounce) problems.push('公告页没去取公告');
  else if (!/\bpage=2\b/.test(allAnnounce.url)) {
    problems.push(`公告页第 2 页取的是 ${allAnnounce.url} —— 页码没带上，翻页会一直停在第 1 页`);
  }
  console.log('  ✅ 交互：公告页翻页带着页码去取，首页那块只肯要 5 条');
}

if (problems.length) {
  console.log('\n发现的问题：');
  for (const item of problems) console.log(`  ❌ ${item}`);
  process.exit(1);
}
console.log(`  ✅ ${CASES.length} 个页面全部渲染通过，state 已就位`);
process.exit(0);
