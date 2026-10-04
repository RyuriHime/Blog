/**
 * 一个够用的假 DOM —— 只为在 Node 里测面板，不追求实现 DOM 标准。
 *
 * 面板只用到这里列出的子集：createElement / className / textContent / value /
 * setAttribute / appendChild / replaceChildren / remove / querySelector(All) /
 * addEventListener + dispatchEvent。所以这个假实现也只需要这些。
 *
 * 关键点：**id 与 name 都会被登记**，因为面板用 `#title` / `#content` 这类选择器
 * 找表单字段（真实 DOM 里它们本来就在）。
 */

class FakeClassList {
  constructor() {
    this.set = new Set();
  }

  add(...names) {
    for (const name of names) this.set.add(name);
  }

  remove(...names) {
    for (const name of names) this.set.delete(name);
  }

  contains(name) {
    return this.set.has(name);
  }

  toggle(name, force) {
    const on = force === undefined ? !this.set.has(name) : force;
    if (on) this.set.add(name);
    else this.set.delete(name);
    return on;
  }

  toString() {
    return [...this.set].join(' ');
  }
}

export class FakeElement {
  constructor(tagName = 'div', ownerDocument = null) {
    this.tagName = String(tagName).toUpperCase();
    this.ownerDocument = ownerDocument;
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = new Map();
    // 假 DOM 不解析 CSS：`style` 只记账。`setProperty` 是真 DOM 也有的方法，
    // 面板用它写 CSS 变量（抽屉宽度），这里就照着记账。
    this.style = {
      setProperty(name, value) {
        this[name] = String(value);
      },
      removeProperty(name) {
        delete this[name];
      },
    };
    this.listeners = new Map();
    this.value = '';
    this._textContent = '';
    this._id = '';
    this._className = '';
    this.classList = new FakeClassList();
    this.files = null;
    this.type = '';
    this.disabled = false;
  }

  get id() {
    return this._id;
  }

  set id(value) {
    this._id = String(value);
    if (this.ownerDocument) this.ownerDocument.register(this);
  }

  get className() {
    return this._className;
  }

  set className(value) {
    this._className = String(value);
    this.classList = new FakeClassList();
    for (const name of this._className.split(/\s+/).filter(Boolean)) this.classList.add(name);
  }

  /** 假 DOM 不解析 CSS 变量：`style` 只记账，`style.x = undefined` 会被记成字符串。 */
  applyStyle(props = {}) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null) delete this.style[key];
      else this.style[key] = String(value);
    }
  }

  get children() {
    return this.childNodes.filter((node) => node instanceof FakeElement);
  }

  /**
   * 真实 DOM 里 textContent 会带上所有后代文本，面板的提示/状态文案全靠它。
   * 假 DOM 也必须递归，否则以「面板有没有把话说出来」为断言的测试全部失真。
   */
  get textContent() {
    if (this._textContent) return this._textContent;
    return this.children.map((child) => child.textContent).join('');
  }

  set textContent(value) {
    this._textContent = value === undefined || value === null ? '' : String(value);
  }

  /**
   * 假 DOM 不解析 HTML：宿主的 `renderMarkdown` 输出（预览区）会原样存成文本。
   *
   * 这是**刻意的**简化 —— 面板里只有一处会用 innerHTML（把宿主渲染好的预览
   * 塞进 `.notes-preview-body`），测试只需要断言"面板拿到了服务端渲染的 HTML
   * 并且把它显示出来了"，不需要一个排版引擎。副作用是 textContent 里看到的是
   * 带标签的原文，别拿它当渲染结果断言。
   */
  get innerHTML() {
    return this._innerHTML ?? '';
  }

  set innerHTML(value) {
    this._innerHTML = value === undefined || value === null ? '' : String(value);
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    this._textContent = this._innerHTML;
  }

  setAttribute(name, value) {
    const key = String(name);
    this.attributes.set(key, String(value));
    if (key === 'id') this.id = String(value);
    if (key === 'class') this.className = String(value);
    if (key === 'name' && this.ownerDocument) this.ownerDocument.register(this, 'name');
  }

  getAttribute(name) {
    return this.attributes.has(String(name)) ? this.attributes.get(String(name)) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(String(name));
  }

  appendChild(child) {
    if (!child) return child;
    this._textContent = '';
    child.parentNode = this;
    this.childNodes.push(child);
    if (child instanceof FakeElement && this.ownerDocument) {
      this.ownerDocument.register(child);
      this.ownerDocument.register(child, 'name');
    }
    return child;
  }

  /**
   * 真实 DOM 的 `node.contains(other)`：other 是自己或自己的后代吗。
   * 面板要用它判断"这次点击落在抽屉里还是外面"（手机上点外面收起抽屉）。
   * 少了它，`root.contains?.(target)` 一律 undefined ⇒ 每次点击都算"外面"。
   */
  contains(other) {
    if (!other) return false;
    let node = other;
    while (node) {
      if (node === this) return true;
      node = node.parentNode ?? null;
    }
    return false;
  }

  replaceChildren(...nodes) {
    for (const node of this.childNodes) node.parentNode = null;
    this.childNodes = [];
    this._textContent = '';
    for (const node of nodes) this.appendChild(node);
  }

  remove() {
    if (!this.parentNode) return;
    const index = this.parentNode.childNodes.indexOf(this);
    if (index >= 0) this.parentNode.childNodes.splice(index, 1);
    this.parentNode = null;
  }

  removeChild(child) {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }

  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler);
  }

  /** 派发事件并调用 handler；返回是否被 preventDefault。 */
  dispatchEvent(event) {
    const payload = event ?? {};
    if (!payload.type) throw new TypeError('dispatchEvent 需要一个带 type 的事件');
    if (!payload.target) payload.target = this;
    payload.preventDefault ??= () => { payload.defaultPrevented = true; };
    for (const handler of [...(this.listeners.get(payload.type) ?? [])]) handler.call(this, payload);
    return Boolean(payload.defaultPrevented);
  }

  /** 假 DOM 里不做布局，滚动只是记账，供测试断言"面板确实把用户送过去了"。 */
  scrollIntoView() {
    this.scrolledIntoView = true;
  }

  /**
   * 记账式滚动位置。真实 DOM 里 `el.scrollTop = 0` 就是把这块滚回顶部；
   * 面板用它把"当前草稿预览"顶回可见区（真机 bug：跑完整理/审查后，
   * 结果区把预览挤出抽屉的可见范围，用户以为预览被覆盖了）。
   */
  get scrollTop() {
    return this._scrollTop ?? 0;
  }

  set scrollTop(value) {
    this._scrollTop = Number(value) || 0;
  }

  /** 让测试能问"这块是不是被滚过、有没有滚回顶部"。 */
  get scrolled() {
    return Boolean(this.scrolledIntoView) || (this._scrollTop ?? 0) !== 0;
  }

  matches(selector) {
    const text = String(selector).trim();
    if (text.startsWith('#')) return this._id === text.slice(1);
    if (text.startsWith('.')) return this.classList.contains(text.slice(1));
    return this.tagName === text.toUpperCase();
  }

  _descendants(out = []) {
    for (const child of this.children) {
      out.push(child);
      child._descendants(out);
    }
    return out;
  }

  querySelectorAll(selector) {
    return this._descendants().filter((node) => node.matches(selector));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

export class FakeDocument {
  constructor() {
    this.byId = new Map();
    this.byName = new Map();
    this.head = new FakeElement('head', this);
    this.body = new FakeElement('body', this);
    this.listeners = new Map();
  }

  register(element, kind = 'id') {
    const key = kind === 'name' ? element.getAttribute?.('name') ?? null : element.id;
    if (!key) return;
    const bucket = kind === 'name' ? this.byName : this.byId;
    bucket.set(key, element);
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }

  getElementById(id) {
    return this.byId.get(String(id)) ?? null;
  }

  /*
   * 面板会往 head 里认领一条自己的样式表（`ensureStylesheet()`），
   * 所以这里既要认 body 的 id，也要认 head 里挂上去的节点。
   */
  querySelector(selector) {
    return this.body.querySelector(selector) ?? this.head.querySelector(selector) ?? null;
  }

  querySelectorAll(selector) {
    return [...this.body.querySelectorAll(selector), ...this.head.querySelectorAll(selector)];
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }

  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler);
  }
}

/** 造一个骨架：`<form id="composeForm"><input id="title"><textarea id="content"></textarea></form>` */
export function createComposeDom({ title = '', content = '' } = {}) {
  const document = new FakeDocument();
  const form = document.createElement('form');
  form.id = 'composeForm';
  const titleEl = document.createElement('input');
  titleEl.id = 'title';
  titleEl.setAttribute('name', 'title');
  titleEl.value = title;
  const contentEl = document.createElement('textarea');
  contentEl.id = 'content';
  contentEl.setAttribute('name', 'content');
  contentEl.value = content;
  form.appendChild(titleEl);
  form.appendChild(contentEl);
  document.body.appendChild(form);
  return { document, form, titleEl, contentEl };
}

/** 让 `document.createElement('div')` 这类调用能拿到 ownerDocument（面板依赖它登记 id）。 */
export function installFakeGlobals(document, { width = 1440 } = {}) {
  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    Event: globalThis.Event,
    PointerEvent: globalThis.PointerEvent,
  };
  globalThis.document = document;
  globalThis.window = globalThis.window ?? {};
  globalThis.window.document = document;
  // 假 DOM 用一个最小的"事件"，真实浏览器里就是 Event 构造器
  class FakeEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.bubbles = Boolean(init.bubbles);
    }

    /**
     * 真实事件的目标链（`target` 自己排第一）。面板用 `composedPath()[0]` 取真实目标，
     * 所以这里也得给一条，否则假 DOM 里"点在抽屉里面"会被判成"点在外面"。
     */
    composedPath() {
      const path = [];
      let node = this.target ?? null;
      while (node) {
        path.push(node);
        node = node.parentNode ?? null;
      }
      return path;
    }
  }
  globalThis.Event = FakeEvent;
  // 面板的"点外面收起"监听的是 pointerdown；真实浏览器里它是 PointerEvent。
  // 假 DOM 里给一个同名的最小实现，测试就能用 `new PointerEvent('pointerdown')` 造事件。
  globalThis.PointerEvent = FakeEvent;

  /**
   * 极简 matchMedia：只为让面板能问一句"现在够宽吗"（宽屏默认展开抽屉）。
   *
   * 不做查询解析，只回答最简单的 `(min-width: NNNpx)`；`width` 由测试给定，
   * 面板那边不许依赖 resize 事件（假 DOM 里没有），所以这里也不派发 change。
   */
  globalThis.window.innerWidth = width;
  globalThis.window.matchMedia = (query) => {
    const min = Number(/min-width:\s*(\d+)px/.exec(String(query))?.[1] ?? 0);
    const max = Number(/max-width:\s*(\d+)px/.exec(String(query))?.[1] ?? Infinity);
    return {
      media: String(query),
      matches: width >= min && width <= max,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    };
  };

  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  };
}
