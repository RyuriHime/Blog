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
  '/api/markdown/preview': { html: '<p>ok</p>' },
  '/api/ai/site': { configured: false, ready: false },
  // 非成员视角的团队主页：详情里没有团队号、也没有公告（服务端就不给）。
  '/api/teams/outsider-group': { team: OUTSIDER_TEAM_FIXTURE, members: [], memberTotal: 0, scopes: SCOPES },
  '/api/teams/outsider-group/posts': { items: [], page: 1, perPage: 20, total: 0, totalPages: 0, sort: 'new' },
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
    },
    allTime: { total: 42 },
    budget: { envKey: 'AI_DAILY_TOTAL_LIMIT', unlimited: true, limit: 0, used: 0, remaining: null },
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
  else data = pickFixture(raw);
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
  // P3 的 AI 编辑台：能力授权 / 按块改写 / 审计与回滚。数据走 /api/ai-edit/*。
  ['AI 编辑台', 'ai-edit.js', 'viewAiEdit', []],
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
 *   ③ 再点一次和空内容时**不该**再发请求（收起是纯本地动作，空内容本地就能判断）。
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

    console.log(`  ${problems.length ? '❌' : '✅'} 交互：团队帖预览会问服务端、会摆结果、收起与空内容不再发请求`);
  } catch (error) {
    problems.push(`团队帖预览交互测试自身崩了：${error?.stack || error}`);
    console.log('  ❌ 交互：团队帖预览会问服务端、会摆结果、收起与空内容不再发请求');
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

    /* ③ 管理员审申请：面板拉待审列表 → 切页签 → 批准 */
    window.location.hash = '#/team/frontend-group';
    await team.viewTeam('frontend-group', new Map());
    click({ teamAction: 'toggle-requests' });
    await settle();
    // 视图是往 `[data-team-requests]` 这个空盒子里写 innerHTML 的
    //（`[data-team-requests-list]` 只是盒子里那张卡片，假 DOM 不会去解析 innerHTML）。
    const list = registered('[data-team-requests]');
    html = String(list.innerHTML);
    if (!html.includes('data-team-request-card')) problems.push('打开「加入申请」面板之后没有画出待审列表');
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

    /* ④ 创建者在设置里把团队从广场藏起来 */
    click({ teamAction: 'toggle-settings' });
    await settle();
    html = String(hero.innerHTML);
    if (!html.includes('data-team-field="listed"')) {
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

    console.log(`  ${problems.length ? '❌' : '✅'} 交互：路人递申请、管理员批申请、创建者能把团队藏起来`);
  } catch (error) {
    problems.push(`团队申请 / 审核交互测试自身崩了：${error?.stack || error}`);
    console.log('  ❌ 交互：路人递申请、管理员批申请、创建者能把团队藏起来');
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

if (problems.length) {
  console.log('\n发现的问题：');
  for (const item of problems) console.log(`  ❌ ${item}`);
  process.exit(1);
}
console.log(`  ✅ ${CASES.length} 个页面全部渲染通过，state 已就位`);
process.exit(0);
