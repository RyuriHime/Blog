/**
 * AI 笔记整理面板（浏览器端）—— 右侧可折叠抽屉 + 预览 + 聊天式历史。
 *
 * 设计前提（用户 m02709 / m02726 / m04046 定的调子）：
 *
 * 1. **面板盯着编辑区**。它一挂载就读编辑区、之后一直跟着用户打字更新自己的认知
 *    （块数、字数、结构）。这一切都在本地或轻量接口上完成，**不跑模型**。
 * 2. **用户点才花钱**。整理 / 提需求 / 审查三个动作各自对应一次显式点击。
 * 3. **作用对象永远是"编辑区此刻的内容"**，不是某个上传的文件。
 *    材料文件只是补充来源 —— 想起来了才传，传了就并入正文之后。
 * 4. **AI 不改编辑区**。结果先落在面板里给用户看（预览 + 对比 + 聊天），
 *    用户点「应用到编辑区」才写回 —— 写回之后仍然由宿主原有的「发布」按钮决定要不要落库。
 * 5. **抽屉形态**（m04046 第 1 条）：固定在窗口右侧，左侧编辑区照样能看能改；
 *    窄屏自动变成覆盖式，用户随时能折叠成一条竖标签。
 * 6. **对话式历史**（m04046 第 3 条）：每一轮都留在对话线程里，任何一轮都能
 *    「回滚到这一版」—— 回滚只换草稿与预览，**不碰编辑区**。
 *
 * 这个文件**不 import 任何后端模块**（浏览器里没有构建步骤，也没有 node: 内置模块），
 * 只通过 `fetch('/api/notes/*')` 与后端说话。请勿在此处引入 node: 内置模块。
 */

export const contractVersion = '1';

/** 面板样式表由挂载层（`src/mount.mjs`）当静态资源发出来，与面板脚本同一个来源。 */
export const STYLESHEET_URL = '/notes-panel.css';

/**
 * 认领面板样式表（幂等）。
 *
 * 为什么让面板自己带样式：这个包要能整个拷给别人用。样式留在宿主的 `style.css` 里时，
 * 接入方最容易漏的就是"粘那三百行 CSS"，漏了面板会以裸 DOM 的样子出现在写作页右侧。
 *
 * 宿主已经把样式烘进自己的样式表也不冲突：同一份 CSS 再来一遍，选择器与值完全一致。
 * 任何异常都不许冒泡 —— 样式是装饰，不是流程。
 */
export function ensureStylesheet(url = STYLESHEET_URL) {
  const doc = globalThis.document;
  if (!url || !doc?.head) return false;
  const existing = typeof doc.querySelector === 'function' ? doc.querySelector(`link[data-notes-style="${url}"]`) : null;
  if (existing) return false;
  const link = doc.createElement('link');
  link.rel = 'stylesheet';
  link.href = url;
  link.setAttribute('data-notes-style', url);
  doc.head.appendChild(link);
  return true;
}

/**
 * 包自带的 Markdown 渲染模块（由挂载层当静态资源发出来）。
 *
 * 预览优先打宿主的 `POST <hostBase>/markdown/preview` —— 那是站内真实渲染，
 * 与用户点"预览"看到的结果 100% 一致。宿主没有这个接口时（交付包被单独拷到
 * 别的站点就是这种形态）退回到这里：动态 import 同一个渲染器自己渲染，
 * 而不是让「效果」按钮变成一个永远只能看原文的死按钮。
 */
export const RENDERER_URL = '/notes-markdown.js';

/** 浏览器的动态 import；测试里可以换成一个记账式替身。 */
export function defaultImport(url) {
  return import(/* @vite-ignore */ url);
}

/** 面板用到的全部用户可见文案（方便统一改口径）。 */
export const TEXT = {
  panelTitle: 'AI 笔记整理',
  watching: '正在跟随编辑区',
  emptyEditor: '编辑区还是空的：先写点内容，或展开"补充材料"上传一份',
  blocks: '块',
  chars: '字',
  headings: '级标题',
  noOutline: '还没有小标题',
  draft: '草稿',
  organize: '整理这篇笔记',
  organizing: '正在整理…',
  generate: '整理',
  requirementLabel: '想怎么改？（可留空）',
  requirementPlaceholder: '例如：把第二段改写成要点列表，公式统一成 LaTeX',
  turn: '提需求',
  turning: '正在按你的要求改…',
  materials: '补充材料（可选）',
  materialsHint: '有原始资料才需要：PDF / Word / PPT / Markdown / 文本，会并入正文之后一起整理',
  pickFile: '选择文件',
  apply: '应用到编辑区',
  applying: '正在写回…',
  applied: '已应用到编辑区，确认无误后照常点发布即可',
  stale: '编辑区在这之后改过了，重新整理一次再应用',
  diffTitle: '整理结果对比',
  noDiff: '还没有整理结果',
  unchanged: '这次没有需要改动的地方，草稿保持原样',
  review: '学术审查',
  reviewing: '正在审查…',
  reviewTitle: '审查意见',
  applyHigh: '一键应用高优先级修改',
  applyHighDone: '已应用高优先级建议',
  noReview: '还没有审查结果',
  needsMore: '模型想确认',
  skippedTitle: '没生效的指令',
  usage: '本轮机时',
  unconfigured: '这个站点还没有配置 AI 接口，请联系管理员',
  emptyDraft: '先写点内容再审查',
  error: '出错了',
  historyTitle: '历史记录',
  // ── 抽屉 / 预览 / 对话（m04046） ──
  drawerTabs: 'AI 笔记整理',
  collapse: '收起',
  expand: '展开 AI 笔记整理',
  previewTitle: '效果预览',
  previewHtml: '效果',
  previewRaw: '原文',
  previewRefresh: '刷新预览',
  previewFallback: '这个站点没有渲染接口，预览暂时只能看原文（渲染由面板自带的渲染器负责时会自动恢复）',
  previewEmpty: '还没有内容可以预览',
  previewLoading: '正在生成预览…',
  chatTitle: '对话记录',
  chatEmpty: '还没有对话：写下要求，或者点「整理」。',
  historyFailed: '历史记录没取回来（不影响这次整理）',
  rollback: '回滚到这一版',
  rollbackDone: '已回到这一版（编辑区没动，确认后点「应用到编辑区」）',
  rolledBack: '已回滚',
  backToLatest: '回到最新版本',
  chatOrganize: '整理了这篇笔记',
  chatReview: '做了一次学术审查',
  chatYou: '你',
};

/** 与宿主 `public/app.js` 的 `api()` 同语义：解 `{ok,data}`，失败抛带 code 的 Error。 */
export async function defaultApi(path, options = {}) {
  const { method = 'GET', body, headers } = options;
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  const response = await fetch(path, {
    method,
    headers: body && !isForm ? { 'Content-Type': 'application/json', ...(headers ?? {}) } : headers,
    body: body && !isForm ? JSON.stringify(body) : body,
    credentials: 'same-origin',
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok || !payload?.ok) {
    const error = new Error(payload?.error?.message || `请求失败（HTTP ${response.status}）`);
    error.code = payload?.error?.code ?? 'http_error';
    error.status = response.status;
    throw error;
  }
  return payload.data;
}

/** 扫出 Markdown 里的图片，喂给契约里的可选 `getImages()`。 */
export function imagesFromMarkdown(markdown) {
  const out = [];
  const pattern = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let match = pattern.exec(String(markdown ?? ''));
  while (match) {
    out.push({ src: match[2], alt: match[1] });
    match = pattern.exec(String(markdown ?? ''));
  }
  return out;
}

/**
 * v1 自带的编辑器适配器：当前编辑区就是 `#title` + `#content` 两个表单元素。
 *
 * 未来的 Markdown/LaTeX 所见即所得编辑器接进来时，只要实现 EDITOR-CONTRACT.md 里
 * 那三个方法即可，面板一行都不用改。
 */
export function createTextareaAdapter(root) {
  const titleEl = findField(root, 'title');
  const contentEl = findField(root, 'content');
  if (!contentEl) throw new Error('createTextareaAdapter 需要一个带 #content 的表单');

  const announce = () => {
    // 真实的编辑区要在写回后通知宿主（预览、自动保存都靠它）；假 DOM 里没有 Event 构造器
    try {
      const EventCtor = contentEl.ownerDocument?.defaultView?.Event ?? globalThis.Event;
      if (typeof EventCtor === 'function') {
        contentEl.dispatchEvent(new EventCtor('input', { bubbles: true }));
      }
    } catch {
      /* 派发不了就算了：面板自己的状态不依赖宿主收到事件 */
    }
  };

  return {
    getDoc() {
      return { title: titleEl?.value ?? '', markdown: contentEl.value ?? '' };
    },
    setDoc({ title, markdown, mode = 'replace' } = {}) {
      if (typeof title === 'string' && title.length > 0 && titleEl) titleEl.value = title;
      if (typeof markdown === 'string') {
        contentEl.value = mode === 'append' ? `${contentEl.value ?? ''}${markdown}` : markdown;
      }
      announce();
    },
    onChange(cb) {
      const bound = () => cb(this.getDoc());
      contentEl.addEventListener('input', bound);
      if (titleEl) titleEl.addEventListener('input', bound);
      return () => {
        contentEl.removeEventListener('input', bound);
        titleEl?.removeEventListener('input', bound);
      };
    },
    getImages() {
      return imagesFromMarkdown(contentEl.value);
    },
    buildImageUrl(src) {
      return src;
    },
    scrollTo() {},
    insertText(text) {
      contentEl.value = `${contentEl.value ?? ''}${text}`;
      announce();
    },
  };
}

/**
 * 盯着编辑区：内容一改就回调（默认防抖 400ms）。
 *
 * 这是"实时"两个字的全部实现 —— 它只观察，不请求、不花钱。
 * 返回的 `stop()` 幂等；`flush()` 让调用方在用户点按钮时立刻拿到最新值。
 */
export function createEditorMonitor(editor, onChange, { debounceMs = 400 } = {}) {
  let timer = null;
  let stopped = false;
  let last = editor.getDoc();
  const emit = () => {
    if (stopped) return;
    last = editor.getDoc();
    onChange(last);
  };
  const schedule = () => {
    if (stopped) return;
    if (timer === null) {
      timer = setTimeout(() => {
        timer = null;
        emit();
      }, debounceMs);
    }
  };
  const unsubscribe = typeof editor.onChange === 'function' ? editor.onChange(() => schedule()) : () => {};
  return {
    flush() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      emit();
      return last;
    },
    stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      unsubscribe();
    },
  };
}

/** 找表单字段：先按 id/name 找，再退回到遍历（假 DOM 与自定义表单都能命中）。 */
function findField(root, id) {
  if (!root) return null;
  const direct = root.querySelector?.(`#${id}`) ?? root.querySelector?.(`[name="${id}"]`);
  if (direct) return direct;
  if (root.elements?.[id]) return root.elements[id];
  const queue = [...(root.children ?? [])];
  while (queue.length > 0) {
    const node = queue.shift();
    if (!node) continue;
    if (node.id === id) return node;
    if (node.attributes?.get?.('name') === id) return node;
    for (const child of node.children ?? node.childNodes ?? []) queue.push(child);
  }
  return null;
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'html') node.innerHTML = String(value);
    else if (key === 'onClick') node.addEventListener('click', value);
    else node.setAttribute(key, String(value));
  }
  for (const child of children) node.appendChild(child);
  return node;
}

/** 前后块序列的最小对比视图（刻意不和后端 diff.mjs 共用：浏览器里 import 不到它）。 */
export function diffBlocks(before, after) {
  const out = [];
  const summarize = (block) => `${block.type}: ${String(block.text ?? '').slice(0, 60)}`;
  const beforeIds = new Set((before ?? []).map((block) => block.id));
  const afterById = new Map((after ?? []).map((block) => [block.id, block]));
  for (const block of before ?? []) {
    if (!afterById.has(block.id)) out.push({ kind: 'del', blockId: block.id, before: summarize(block) });
  }
  for (const block of after ?? []) {
    if (!beforeIds.has(block.id)) out.push({ kind: 'add', blockId: block.id, after: summarize(block) });
    else {
      const old = (before ?? []).find((item) => item.id === block.id);
      if (old && old.text !== block.text) out.push({ kind: 'mod', blockId: block.id, before: summarize(old), after: summarize(block) });
    }
  }
  return out;
}

/**
 * 同一个 mount 上只允许有一块面板。
 *
 * 宿主切视图时会重新渲染编辑表单（`ui.app.innerHTML = ...`），拿到的是一个**新的**
 * mount 元素；旧面板的 DOM 虽然跟着旧容器一起被丢掉了，但它的 `onChange` 订阅
 * 还在编辑器的旧适配器上、防抖定时器还在跑。这里按 mount 记账，重复 attach
 * 先把上一个收掉，避免出现两块面板或在切视图后继续发请求。
 */
const ATTACHED = new WeakMap();

/** 抽屉默认展开的宽度门槛：够宽才敢把编辑区挤窄，窄屏一律先收起。 */
const WIDE_ENOUGH = '(min-width: 1080px)';

function prefersOpen() {
  const mm = globalThis.window?.matchMedia;
  if (typeof mm !== 'function') return true;
  try {
    return mm(WIDE_ENOUGH).matches;
  } catch {
    return true;
  }
}

/**
 * 把面板挂到 `mount` 上（渲染成窗口右侧的可折叠抽屉）。
 *
 * @param {object} options
 * @param {Element} options.mount  面板容器（建议放在编辑表单内部）
 * @param {object} options.editor  符合 EDITOR-CONTRACT.md 的适配器
 * @param {string} [options.apiBase]
 * @param {Function} [options.api]
 * @param {number|null} [options.postId] 当前编辑的帖子 id（复用已有工作台）
 * @param {string} [options.hostBase] 宿主接口前缀（预览渲染复用宿主的 Markdown 渲染）
 * @returns {{ ready: Promise<object>, settle(): Promise<void>, flush(): Promise<void>,
 *   refresh(): Promise<object>, setOpen(open: boolean): void, getState(): object, destroy(): void }}
 */
export function attach({
  mount,
  editor,
  apiBase = '/api/notes',
  api = defaultApi,
  postId = null,
  debounceMs = 400,
  hostBase = '/api',
  stylesheet = STYLESHEET_URL,
  rendererUrl = RENDERER_URL,
  importModule = defaultImport,
} = {}) {
  if (!mount) throw new Error('attach 需要一个 mount 容器');
  const missing = ['getDoc', 'setDoc', 'onChange'].filter((name) => typeof editor?.[name] !== 'function');
  if (missing.length > 0) throw new Error(`编辑器适配器缺少必需方法：${missing.join(' / ')}`);

  // 面板样式由挂载层当静态资源发出来，这里自己认领 —— 宿主因此**不需要**往自己的
  // style.css 里粘三百行样式（拷给别人时最容易漏的一步）。宿主已经把样式烘进自己的
  // 样式表时留着这条 link 也无害：同一份 CSS 再来一遍，选择器与值完全一致。
  ensureStylesheet(stylesheet);

  // 同一个 mount 被重复 attach（切换视图 / 热重载）时先收掉上一块
  const previous = ATTACHED.get(mount);
  if (previous && typeof previous.destroy === 'function') {
    try {
      previous.destroy();
    } catch {
      // 收尾失败不该拦住新面板
    }
  }

  const state = {
    sessionId: null,
    title: '',
    tags: [],
    before: [],
    blocks: [],
    // 模型手上那份草稿的 Markdown。它和编辑区可能不一致 —— 用户提了需求但还没点
    // 「应用到编辑区」时就是这样，状态胶囊必须把这件事说出来。
    draftMd: null,
    diff: [],
    review: null,
    usage: null,
    sources: [],
    skipped: [],
    warnings: [],
    needsMore: [],
    busy: false,
    dirty: false,
    syncedDraft: null,
    notice: '',
    noticeKind: 'info',
    // ── 抽屉 / 预览 / 对话 ──
    open: prefersOpen(),
    previewMode: 'html',
    previewHtml: '',
    previewPending: false,
    // 宿主没有 /markdown/preview 且包自带渲染器也拿不到时置 true：预览只能用原文看，
    // 这时提示条要一直把原因写在面板上，而不是被下一轮的成功提示冲掉。
    previewFallback: false,
    messages: [],
    rolledBackTo: null,
    /** 已经排队等补跑的那个任务（见 run()：被"忙"挡下的同步不丢，收尾时补跑）。 */
    syncQueued: null,
  };

  // ── DOM 骨架（全部建在 mount 内部：生命周期仍归宿主管） ──────────
  const root = el('div', { class: 'notes-panel notes-drawer is-open' });
  root.id = root.id || undefined;

  const tab = el('button', { type: 'button', class: 'notes-drawer-tab', text: `✨ ${TEXT.drawerTabs}` });
  tab.setAttribute('aria-label', TEXT.expand);

  const head = el('div', { class: 'notes-head' });
  const titleEl = el('div', { class: 'notes-title', text: `✨ ${TEXT.panelTitle}` });
  const statusEl = el('div', { class: 'notes-status' });
  // 两个状态胶囊分开：左边永远是**编辑区**的实时情况，右边是模型的**草稿**。
  // 合成一个会骗人 —— 真机上提需求之后草稿从 154 字变成 220 字而编辑区没动，
  // 只说"正在跟随编辑区 · 7 块 · 220 字"会让用户以为编辑区里已经有 220 字了。
  const editorStatusEl = el('div', { class: 'notes-status' });
  const statusBox = el('div', { class: 'notes-status-box' });
  const collapseBtn = el('button', { type: 'button', class: 'notes-drawer-toggle', text: '›' });
  collapseBtn.setAttribute('aria-label', TEXT.collapse);
  statusBox.appendChild(editorStatusEl);
  statusBox.appendChild(statusEl);
  head.appendChild(titleEl);
  head.appendChild(statusBox);
  head.appendChild(collapseBtn);

  const outlineEl = el('div', { class: 'notes-outline' });

  // ── 预览（m04046 第 2 条）：整理完就在面板里看得见 ──────────────
  const previewEl = el('div', { class: 'notes-preview' });
  const previewHead = el('div', { class: 'notes-preview-head' });
  previewHead.appendChild(el('span', { class: 'notes-section-title', text: TEXT.previewTitle }));
  const htmlBtn = el('button', { type: 'button', class: 'notes-mini notes-preview-html is-active', text: TEXT.previewHtml });
  const rawBtn = el('button', { type: 'button', class: 'notes-mini notes-preview-raw', text: TEXT.previewRaw });
  const refreshBtn = el('button', { type: 'button', class: 'notes-mini notes-preview-refresh', text: '⟳' });
  refreshBtn.setAttribute('aria-label', TEXT.previewRefresh);
  previewHead.appendChild(htmlBtn);
  previewHead.appendChild(rawBtn);
  previewHead.appendChild(refreshBtn);
  const previewBody = el('div', { class: 'notes-preview-body' });
  previewEl.appendChild(previewHead);
  previewEl.appendChild(previewBody);

  // ── 聊天式对话（m04046 第 3 条） ────────────────────────────────
  const chatEl = el('div', { class: 'notes-chat-box' });
  const chatHead = el('div', { class: 'notes-chat-head' });
  chatHead.appendChild(el('span', { class: 'notes-section-title', text: TEXT.chatTitle }));
  const latestBtn = el('button', { type: 'button', class: 'notes-mini notes-back-latest', text: TEXT.backToLatest });
  latestBtn.style.display = 'none';
  chatHead.appendChild(latestBtn);
  const chatList = el('div', { class: 'notes-chat' });
  chatEl.appendChild(chatHead);
  chatEl.appendChild(chatList);

  const actions = el('div', { class: 'notes-actions' });
  const organizeBtn = el('button', { type: 'button', class: 'btn btn-sm notes-btn notes-organize', text: TEXT.organize });
  const applyBtn = el('button', { type: 'button', class: 'btn btn-sm notes-btn notes-apply', text: TEXT.apply });
  const reviewBtn = el('button', { type: 'button', class: 'btn btn-sm notes-btn notes-review-btn', text: TEXT.review });
  actions.appendChild(organizeBtn);
  actions.appendChild(applyBtn);
  actions.appendChild(reviewBtn);

  const turnRow = el('div', { class: 'notes-turn-row' });
  const turnInput = el('input', { type: 'text', class: 'notes-turn-input', placeholder: TEXT.requirementPlaceholder, maxlength: '1000' });
  const turnBtn = el('button', { type: 'button', class: 'btn btn-sm notes-btn notes-turn', text: TEXT.turn });
  turnRow.appendChild(turnInput);
  turnRow.appendChild(turnBtn);

  const materials = el('details', { class: 'notes-materials' });
  materials.appendChild(el('summary', { class: 'notes-materials-summary', text: TEXT.materials }));
  materials.appendChild(el('div', { class: 'notes-hint', text: `${TEXT.materialsHint}（可选）` }));
  const fileRow = el('div', { class: 'notes-file-row' });
  const fileInput = el('input', { type: 'file', class: 'notes-file', multiple: 'multiple' });
  fileRow.appendChild(fileInput);
  materials.appendChild(fileRow);
  const sourceList = el('div', { class: 'notes-sources' });
  materials.appendChild(sourceList);

  const noticeEl = el('div', { class: 'notes-notice is-info' });
  const diffEl = el('div', { class: 'notes-diff' });
  const reviewEl = el('div', { class: 'notes-review' });

  // 抽屉里的分区顺序：先说清"我在整理什么"，再给预览，再是对话，最后是结果细节。
  // 预览排在最前是有意的：结果区（对话/提示/对比/审查）跑完一轮就会长出来把下面顶下去，
  // 每轮结束时 revealPreview() 会把抽屉滚回顶部，让用户第一眼看到的就是最新草稿。
  const sections = el('div', { class: 'notes-drawer-body' });
  sections.appendChild(outlineEl);
  sections.appendChild(previewEl);
  sections.appendChild(chatEl);
  sections.appendChild(noticeEl);
  sections.appendChild(diffEl);
  sections.appendChild(reviewEl);
  sections.appendChild(materials);

  const foot = el('div', { class: 'notes-drawer-foot' });
  foot.appendChild(actions);
  foot.appendChild(turnRow);

  root.appendChild(head);
  root.appendChild(sections);
  root.appendChild(foot);
  // 收起时留在屏幕左边缘的竖标签：必须挂在**抽屉外面**。
  // 抽屉收起是整块平移出屏，`overflow:hidden` 会把绝对定位的子元素一起裁掉 ——
  // 真机上表现为"收起后再也点不开"（标签还在 DOM 里，但落在视口外）。
  // 面板样式全部收在 `.notes-mount` 下（宿主一条 input[type="text"] 之类的泛化选择器
  // 就改不动面板）。挂载点少了这个类，整块样式一条都不生效、面板退化成裸块 ——
  // 交付包的演示页就这么踩过一次。所以这里自己补上，别让接入方记这件事。
  const mountClassAdded = Boolean(mount.classList) && !mount.classList.contains('notes-mount');
  if (mountClassAdded) mount.classList.add('notes-mount');
  mount.appendChild(root);
  mount.appendChild(tab);

  // ── 抽屉开合 ────────────────────────────────────────────────────
  function renderDrawer() {
    root.className = state.open ? 'notes-panel notes-drawer is-open' : 'notes-panel notes-drawer';
    collapseBtn.textContent = state.open ? '›' : '‹';
    if (document.body?.classList) document.body.classList.toggle('notes-drawer-open', state.open);
  }

  function toggleDrawer(force) {
    state.open = force === undefined ? !state.open : Boolean(force);
    renderDrawer();
  }

  // ── 手机上的逃生通道 ────────────────────────────────────────────
  // 真机量过（390×844）：抽屉铺满视口时，唯一的出口是右上角那枚 26×26 的「›」，
  // 拇指点不中。所以再给两条路 —— 但只在小屏生效，桌面上点编辑区不该把抽屉关掉
  // （那时候用户是"一边看一边改"，不是要离开）。
  const narrowEnough = () => {
    const mm = globalThis.window?.matchMedia;
    if (typeof mm !== 'function') return false;
    try {
      return !mm(WIDE_ENOUGH).matches;
    } catch {
      return false;
    }
  };

  const isInside = (target) => {
    if (!target) return false;
    // 点竖标签、点抽屉、点挂载点里的别的东西都不算"外面"
    return Boolean(root.contains?.(target) || tab.contains?.(target) || target === tab);
  };

  const onKeydown = (event) => {
    // Esc 收起：手机上滑不到那枚小按钮，键盘也不一定有，但有就该能用
    if (event?.key !== 'Escape' || !state.open) return;
    toggleDrawer(false);
  };

  const onPointerDown = (event) => {
    // 只在窄屏、且抽屉开着的时候认这件事
    if (!state.open || !narrowEnough()) return;
    // composedPath 能拿到影子 DOM 里的真实路径；拿不到就用 target 兜着
    const target = typeof event?.composedPath === 'function'
      ? event.composedPath()[0]
      : event?.target;
    if (isInside(target)) return;
    toggleDrawer(false);
  };

  document.addEventListener('keydown', onKeydown);
  document.addEventListener('pointerdown', onPointerDown);

  // ── 渲染 ────────────────────────────────────────────────────────
  function renderOutline() {
    const bits = [`${state.blocks.length} ${TEXT.blocks}`, `${draftChars()} ${TEXT.chars}`];
    const headings = state.blocks.filter((block) => block.type === 'heading').length;
    if (headings > 0) bits.push(`${headings} ${TEXT.headings}`);
    statusEl.textContent = `${TEXT.draft} · ${bits.join(' · ')}`;
    // 编辑区那一侧：永远报编辑区此刻的真实长度，不掺草稿的数字。
    const doc = editor.getDoc();
    const editorChars = String(doc.markdown ?? '').trim().length;
    const editorBits = [`${TEXT.watching}`, `${editorChars} ${TEXT.chars}`];
    const diverged = typeof state.draftMd === 'string'
      && state.draftMd.trim() !== String(doc.markdown ?? '').trim();
    if (diverged) {
      // 提了需求还没应用时明说草稿有多少字，别让用户以为编辑区里已经是那个长度
      editorBits.push(`（${TEXT.draft} ${draftChars()} ${TEXT.chars}）`);
    }
    editorStatusEl.textContent = editorBits.join(' · ');
    const titles = state.blocks.filter((block) => block.type === 'heading').slice(0, 6).map((block) => block.text);
    outlineEl.textContent = titles.length > 0 ? titles.join(' ／ ') : TEXT.noOutline;
  }

  function draftChars() {
    return state.blocks.reduce((sum, block) => sum + String(block.text ?? '').length, 0);
  }

  function notice(message, kind = 'info') {
    state.notice = message;
    state.noticeKind = kind;
    renderNotice();
  }

  /**
   * 渲染提示条。
   *
   * 「预览只能用原文看」这条要盖过其它提示：它描述的是一个持续存在的状态，
   * 而普通提示（"整理完成，确认后点应用到编辑区"）是这一轮的一次性消息 ——
   * 不特判的话，紧接着的一次成功操作就会把它冲掉，用户再也看不到原因。
   */
  function renderNotice() {
    const fallback = state.previewFallback && state.previewMode === 'raw';
    const message = fallback ? TEXT.previewFallback : state.notice;
    const kind = fallback ? 'warn' : state.noticeKind;
    noticeEl.className = `notes-notice is-${kind}`;
    noticeEl.textContent = message;
    noticeEl.style.display = message ? '' : 'none';
  }

  function renderButtons() {
    const empty = editor.getDoc().markdown.trim().length === 0;
    organizeBtn.disabled = state.busy;
    turnBtn.disabled = state.busy;
    reviewBtn.disabled = state.busy || empty;
    applyBtn.disabled = state.busy || state.blocks.length === 0 || state.dirty;
    organizeBtn.textContent = state.busy ? TEXT.organizing : TEXT.organize;
    turnBtn.textContent = state.busy ? TEXT.turning : TEXT.turn;
    reviewBtn.textContent = state.busy ? TEXT.reviewing : TEXT.review;
    applyBtn.textContent = state.busy ? TEXT.applying : TEXT.apply;
  }

  function renderSources() {
    sourceList.replaceChildren();
    for (const source of state.sources) {
      const label = source.kind === 'failed' ? `${source.name}（读取失败）` : source.name;
      sourceList.appendChild(el('span', { class: 'notes-source', text: label }));
    }
  }

  function renderDiff() {
    diffEl.replaceChildren();
    const caption = el('div', { class: 'notes-section-title', text: TEXT.diffTitle });
    diffEl.appendChild(caption);
    if (state.diff.length === 0) {
      // 区分"还没整理过"和"整理过了但模型认为不需要改"——后者要说清楚，
      // 否则用户点完按钮看到空栏，会以为功能坏了。
      const ran = state.before.length > 0 && state.blocks.length > 0 && Boolean(state.usage);
      diffEl.appendChild(el('div', { class: 'notes-muted', text: ran ? TEXT.unchanged : TEXT.noDiff }));
    } else {
      const list = el('div', { class: 'notes-diff-list' });
      for (const item of state.diff) {
        const row = el('div', { class: `notes-diff-item is-${item.kind}` });
        const label = item.kind === 'add' ? '新增' : item.kind === 'del' ? '删除' : '修改';
        row.appendChild(el('span', { class: `notes-tag is-${item.kind}`, text: label }));
        // 修改过的块把"改前 → 改后"都摆出来，用户才能判断要不要接受
        const text = el('span', { class: 'notes-diff-text' });
        if (item.kind === 'mod') {
          text.appendChild(el('s', { class: 'notes-diff-before', text: item.before ?? '' }));
          text.appendChild(el('span', { class: 'notes-diff-arrow', text: ' → ' }));
          text.appendChild(el('span', { class: 'notes-diff-after', text: item.after ?? '' }));
        } else {
          text.textContent = item.after ?? item.before ?? '';
        }
        row.appendChild(text);
        list.appendChild(row);
      }
      diffEl.appendChild(list);
    }
    if (state.skipped.length > 0) {
      const skipped = el('div', { class: 'notes-skipped' });
      skipped.appendChild(el('div', { class: 'notes-section-title', text: TEXT.skippedTitle }));
      for (const item of state.skipped) skipped.appendChild(el('div', { class: 'notes-muted', text: item.message ?? item.reason }));
      diffEl.appendChild(skipped);
    }
    if (state.needsMore.length > 0) {
      const needs = el('div', { class: 'notes-needs' });
      needs.appendChild(el('div', { class: 'notes-section-title', text: TEXT.needsMore }));
      for (const question of state.needsMore) needs.appendChild(el('div', { class: 'notes-muted', text: String(question) }));
      diffEl.appendChild(needs);
    }
    if (state.usage) {
      diffEl.appendChild(el('div', { class: 'notes-usage', text: `${TEXT.usage}：${state.usage.prompt ?? 0} / ${state.usage.completion ?? 0} tokens` }));
    }
    if (state.dirty) diffEl.appendChild(el('div', { class: 'notes-notice is-warn', text: TEXT.stale }));
  }

  function renderReview() {
    reviewEl.replaceChildren();
    reviewEl.appendChild(el('div', { class: 'notes-section-title', text: TEXT.reviewTitle }));
    if (!state.review) {
      reviewEl.appendChild(el('div', { class: 'notes-muted', text: TEXT.noReview }));
      return;
    }
    reviewEl.appendChild(el('div', { class: 'notes-muted', text: state.review.summary ?? '' }));
    const list = el('div', { class: 'notes-findings' });
    for (const finding of state.review.findings ?? []) {
      const card = el('div', { class: `notes-finding is-${finding.severity}` });
      const meta = el('div', { class: 'notes-finding-head' });
      meta.appendChild(el('span', { class: `notes-tag is-${finding.severity}`, text: finding.severity }));
      meta.appendChild(el('span', { class: 'notes-finding-kind', text: finding.kind }));
      card.appendChild(meta);
      card.appendChild(el('div', { class: 'notes-finding-quote', text: `「${finding.quote}」` }));
      card.appendChild(el('div', { class: 'notes-finding-issue', text: finding.issue }));
      card.appendChild(el('div', { class: 'notes-finding-suggestion', text: finding.suggestion }));
      list.appendChild(card);
    }
    reviewEl.appendChild(list);
    const highs = (state.review.findings ?? []).filter((item) => item.severity === 'high');
    const applicable = highs.filter((item) => item.patch);
    const applyReviewBtn = el('button', {
      type: 'button',
      class: 'btn btn-sm notes-btn notes-apply-review',
      text: TEXT.applyHigh,
    });
    applyReviewBtn.disabled = state.busy || applicable.length === 0;
    applyReviewBtn.addEventListener('click', () => run(applyHigh));
    reviewEl.appendChild(applyReviewBtn);
  }

  /** 预览：HTML 用宿主渲染接口（与站内真实渲染 100% 一致），原文直接显示草稿。 */
  function renderPreview() {
    htmlBtn.className = state.previewMode === 'html' ? 'notes-mini notes-preview-html is-active' : 'notes-mini notes-preview-html';
    rawBtn.className = state.previewMode === 'raw' ? 'notes-mini notes-preview-raw is-active' : 'notes-mini notes-preview-raw';
    refreshBtn.disabled = state.busy;
    previewBody.className = state.previewMode === 'raw' ? 'notes-preview-body is-raw' : 'notes-preview-body';
    if (state.previewMode === 'raw') {
      const markdown = currentDraftOrDraft();
      previewBody.textContent = markdown.trim().length > 0 ? markdown : TEXT.previewEmpty;
      return;
    }
    previewBody.innerHTML = state.previewHtml;
    if (!state.previewHtml) {
      previewBody.textContent = state.previewPending ? TEXT.previewLoading : TEXT.previewEmpty;
    }
  }

  /** 预览的正文来源：优先模型手上那份草稿，没有草稿就是编辑区此刻的内容。 */
  function currentDraftOrDraft() {
    return typeof state.draftMd === 'string' && state.draftMd.length > 0 ? state.draftMd : currentDraft();
  }

  /** 打一次宿主的 Markdown 渲染接口。草稿没变就不会重复打（只在用户要看时打）。 */
  async function refreshPreview({ force = false } = {}) {
    if (state.previewMode !== 'html') return;
    if (!force && !state.previewPending) return;
    const markdown = currentDraftOrDraft();
    if (markdown.trim().length === 0) {
      state.previewHtml = '';
      state.previewPending = false;
      renderPreview();
      return;
    }
    try {
      const data = await api(`${hostBase}/markdown/preview`, { method: 'POST', body: { content: markdown } });
      // 顺序护栏：两个请求同时在飞时，先发的可能后到。渲染的是**哪一版**由发起时的
      // markdown 决定，回来时草稿已经变了就整份丢弃，别让旧结果盖掉新的。
      if (markdown !== currentDraftOrDraft()) return;
      state.previewHtml = String(data?.html ?? '');
      state.previewPending = false;
      state.previewFallback = false;
    } catch {
      // 宿主没有渲染接口（交付包被单独拷到别的站点就是这样）：用包自带的渲染器顶上。
      const html = await renderBundled(markdown);
      if (markdown !== currentDraftOrDraft()) return;
      if (html === null) {
        // 两条路都不通时才退回原文，并且把原因说出来 —— 静默降级会让人以为是渲染坏了。
        // `previewPending` 必须在这里收掉：留着的话会永久显示"渲染中"，
        // 而且 746 行的 `!state.previewPending` 判据会让后面每次 refreshPreview 都白跑一遍失败路径。
        state.previewPending = false;
        state.previewMode = 'raw';
        state.previewFallback = true;
      } else {
        state.previewHtml = html;
        state.previewPending = false;
        state.previewFallback = false;
      }
    }
    renderPreview();
    renderNotice();
  }

  /**
   * 用包自带的渲染器渲染一份 Markdown。
   *
   * 模块只 import 一次（浏览器会缓存模块，但这里再存一层，避免重复走动态 import 的失败路径）。
   * 拿不到就返回 null，由调用方决定怎么退化。
   */
  let bundledRenderer; // undefined = 还没试过；null = 试过但拿不到
  async function renderBundled(markdown) {
    if (bundledRenderer === undefined) {
      try {
        const mod = await importModule(rendererUrl);
        bundledRenderer = mod && typeof mod.renderMarkdown === 'function' ? mod : null;
      } catch {
        bundledRenderer = null;
      }
    }
    if (!bundledRenderer) return null;
    try {
      return String(bundledRenderer.renderMarkdown(markdown) ?? '');
    } catch {
      return null;
    }
  }

  /**
   * 把「当前草稿预览」送回用户眼前。
   *
   * 真机 bug（用户报的）：「点击学术审查或者整理笔记，结果跑出来后会把预览窗口覆盖掉」——
   * 抽屉是一列，跑完一轮之后对话、提示、对比、审查卡都长出来，把预览顶出滚动区；
   * 用户看到的是结果把预览"盖住"了。所以每轮结束都把抽屉滚回顶部、预览自己也滚回顶部。
   */
  function revealPreview() {
    if (typeof sections.scrollTop === 'number') sections.scrollTop = 0;
    if (typeof previewEl.scrollTop === 'number') previewEl.scrollTop = 0;
  }

  /** 对话线程：每一轮都是"谁说了什么 + 这一版能不能回去"。 */
  function renderChat() {
    latestBtn.style.display = state.rolledBackTo === null ? 'none' : '';
    chatList.replaceChildren();
    if (state.messages.length === 0) {
      chatList.appendChild(el('div', { class: 'notes-muted', text: TEXT.chatEmpty }));
      return;
    }
    state.messages.forEach((message, index) => {
      const rolled = state.rolledBackTo !== null && index > state.rolledBackTo;
      const mine = message.role === 'user';
      const row = el('div', { class: `notes-msg ${mine ? 'is-user' : 'is-assistant'}${rolled ? ' is-rolled' : ''}` });
      row.appendChild(el('div', { class: 'notes-msg-who', text: mine ? TEXT.chatYou : TEXT.panelTitle }));
      // 服务端**不**返回 `kind`：对话历史里只有「整理」与「追问」两种 assistant 消息
      //（学术审查走 /review，落在审查卡里，从不写进 messages 表）。以前这里判
      // `message.kind === 'review'` 是一条永远走不到的分支，refresh 后审查过的会话
      // 也不会显示成审查。所以：有 requirement 就显示要求原文，没有就是「整理了这篇笔记」。
      const body = message.requirement ? message.requirement : TEXT.chatOrganize;
      row.appendChild(el('div', { class: 'notes-msg-text', text: body }));
      if (message.draftMd) {
        const badge = el('div', { class: 'notes-msg-meta', text: `${String(message.draftMd).trim().length} ${TEXT.chars}` });
        row.appendChild(badge);
      }
      if (rolled) row.appendChild(el('span', { class: 'notes-tag is-rolled', text: TEXT.rolledBack }));
      else if (message.canRollback) {
        const button = el('button', { type: 'button', class: 'notes-mini notes-rollback', text: TEXT.rollback });
        button.disabled = state.busy;
        button.addEventListener('click', () => run(() => rollbackTo(message)));
        row.appendChild(button);
      }
      chatList.appendChild(row);
    });
  }

  function render() {
    renderDrawer();
    renderOutline();
    renderButtons();
    renderSources();
    renderNotice();
    renderDiff();
    renderReview();
    renderPreview();
    renderChat();
  }

  // ── 动作 ────────────────────────────────────────────────────────
  function currentDraft() {
    return editor.getDoc().markdown ?? '';
  }

  /**
   * 把本地已知的轮次对齐后端：谁有快照、谁还能回滚。
   *
   * 取历史失败时**不能装没事**：以前这里 `catch { return; }`，而调用方早已把
   * `historyLoaded` 置真，于是这一次会话再也不会重试，界面上也一个字都不提示 ——
   * 用户看到的是"历史凭空少了"，排查时完全不知道是网络失败。现在改成：提示一次、
   * 并把 `historyLoaded` 放回去，让下一次动作（或下一次同步）自然重试。
   *
   * `renderChat()` 故意留在 try 外面：渲染失败必须冒出来 —— 真机上出现过
   * "历史明明取回来了，但 `renderChat()` 抛异常被这个 catch 一起吞掉，
   * 面板看起来像没有历史"，排查成本极高。
   */
  async function loadHistory() {
    let rows = [];
    try {
      const data = await api(`${apiBase}/messages?sessionId=${encodeURIComponent(state.sessionId)}`);
      rows = Array.isArray(data?.messages) ? data.messages : [];
    } catch (error) {
      state.historyLoaded = false; // 允许下一次动作重试
      notice(`${TEXT.historyFailed}：${error?.message ?? error}`, 'warn');
      return;
    }
    state.messages = rows.map((row) => ({
      id: row.id,
      role: row.role,
      requirement: row.requirement ?? '',
      draftMd: typeof row.draftMd === 'string' ? row.draftMd : '',
      kind: row.kind ?? '',
      canRollback: typeof row.draftMd === 'string' && row.draftMd.trim().length > 0 && row.id !== undefined,
    }));
    renderChat();
  }

  /** 本地记一轮对话（后端也会记一份，刷新后从 /messages 取回）。 */
  function pushMessage(message) {
    state.messages = [...state.messages, message];
    renderChat();
  }

  /** 同步编辑区内容到工作台。这就是"实时监控"落地的地方：不发模型请求。 */
  async function sync({ resetBaseline = true } = {}) {
    const doc = editor.getDoc();
    if (String(doc.markdown ?? '').trim().length === 0 && !state.sessionId) {
      state.blocks = [];
      state.syncedDraft = null;
      render();
      return state;
    }
    const payload = { draft: doc.markdown, title: doc.title, sessionId: state.sessionId, postId };
    const data = await api(`${apiBase}/session`, { method: 'POST', body: payload });
    state.sessionId = data.sessionId ?? state.sessionId;
    state.title = data.title ?? state.title;
    state.blocks = data.blocks ?? [];
    // 基线 = 编辑区此刻的块。没有它，整理结果就无法与"整理前"比较，
    // 对比栏会把每一个块都显示成"新增"（真机踩过：7 块全标新增，看起来像整篇重写）。
    if (resetBaseline) state.before = state.blocks;
    state.syncedDraft = doc.markdown;
    state.draftMd = null;
    state.dirty = false;
    state.previewPending = true;
    render();
    // 历史只在第一次拿到会话号时拉一次（之后每次动作都会再对齐一次）
    if (!state.historyLoaded && state.sessionId) {
      state.historyLoaded = true;
      await loadHistory();
    }
    await refreshPreview();
    return state;
  }

  async function organize() {
    const doc = editor.getDoc();
    if (String(doc.markdown ?? '').trim().length === 0 && !(fileInput.files?.length > 0)) {
      notice(TEXT.emptyEditor, 'warn');
      return;
    }
    // 有材料就用 multipart 一起送（材料并入正文之后），否则纯 JSON
    const files = fileInput.files ? [...fileInput.files] : [];
    const requirement = String(turnInput.value ?? '');
    let body;
    if (files.length > 0) {
      body = new FormData();
      body.append('draft', doc.markdown ?? '');
      body.append('title', doc.title ?? '');
      body.append('requirement', requirement);
      if (state.sessionId) body.append('sessionId', String(state.sessionId));
      if (postId) body.append('postId', String(postId));
      for (const file of files) body.append('files', file, file.name);
    } else {
      body = { draft: doc.markdown, title: doc.title, sessionId: state.sessionId, postId, requirement };
    }
    const data = await api(`${apiBase}/generate`, { method: 'POST', body });
    // 先留住"整理前"的块再做替换，否则 diff 的基线就丢了
    const blocksBefore = state.before.length > 0 ? state.before : state.blocks;
    state.sessionId = data.sessionId ?? state.sessionId;
    state.title = data.title ?? state.title;
    state.tags = data.tags ?? state.tags;
    state.blocks = data.blocks ?? state.blocks;
    state.diff = diffBlocks(blocksBefore, state.blocks);
    state.before = blocksBefore;
    state.draftMd = typeof data.draftMd === 'string' ? data.draftMd : null;
    state.skipped = data.skipped ?? [];
    state.needsMore = data.needsMore ?? [];
    state.warnings = data.warnings ?? [];
    state.usage = data.usage ?? null;
    state.review = null;
    state.dirty = false;
    state.rolledBackTo = null;
    state.previewPending = true;
    fileInput.value = '';
    pushMessage({
      id: undefined, role: 'assistant', kind: 'organize', requirement: '',
      draftMd: state.draftMd ?? '', canRollback: false,
    });
    // 后端会为这一轮存一份快照；拉回来才能回滚到它
    await loadHistory();
    notice(data.notes?.[0] ?? '整理完成，确认后点「应用到编辑区」', 'ok');
    render();
    await refreshPreview();
    revealPreview();
  }

  async function applyToEditor() {
    const data = await api(`${apiBase}/apply`, { method: 'POST', body: { sessionId: state.sessionId } });
    const markdown = data.draftMd ?? '';
    state.blocks = data.blocks ?? state.blocks;
    state.title = data.title ?? state.title;
    // 应用之后编辑区与草稿重新一致，状态胶囊不该再报"草稿 N 字"
    state.draftMd = null;
    // 基线保持在"整理前"，这样用户应用之后仍然看得到这次改了什么；
    // 下一次 sync 会把它重置成编辑区此刻的状态。
    state.dirty = false;
    state.previewPending = true;
    editor.setDoc({ title: state.title, markdown });
    notice(TEXT.applied, 'ok');
    render();
    await refreshPreview({ force: true });
    revealPreview();
  }

  async function turn() {
    const requirement = String(turnInput.value ?? '').trim();
    if (requirement.length === 0) {
      notice('先写下你的要求', 'warn');
      return;
    }
    const data = await api(`${apiBase}/turn`, {
      method: 'POST',
      body: { sessionId: state.sessionId, draft: currentDraft(), title: editor.getDoc().title, requirement },
    });
    const blocksBefore = state.before.length > 0 ? state.before : state.blocks;
    state.sessionId = data.sessionId ?? state.sessionId;
    state.title = data.title ?? state.title;
    state.blocks = data.blocks ?? state.blocks;
    state.diff = diffBlocks(blocksBefore, state.blocks);
    state.before = blocksBefore;
    state.draftMd = typeof data.draftMd === 'string' ? data.draftMd : state.draftMd;
    state.skipped = data.skipped ?? [];
    state.needsMore = data.needsMore ?? [];
    state.usage = data.usage ?? null;
    state.dirty = false;
    state.rolledBackTo = null;
    state.previewPending = true;
    turnInput.value = '';
    pushMessage({ id: undefined, role: 'user', kind: 'turn', requirement, draftMd: state.draftMd ?? '', canRollback: false });
    await loadHistory();
    notice(data.notes?.[0] ?? '已按你的要求改好，确认后点「应用到编辑区」', 'ok');
    render();
    await refreshPreview();
    revealPreview();
  }

  async function review() {
    const draft = currentDraft();
    if (draft.trim().length === 0) {
      notice(TEXT.emptyDraft, 'warn');
      return;
    }
    const data = await api(`${apiBase}/review`, {
      method: 'POST',
      body: { sessionId: state.sessionId, draft, title: editor.getDoc().title },
    });
    state.review = data;
    state.sessionId = data.sessionId ?? state.sessionId;
    pushMessage({ id: undefined, role: 'assistant', kind: 'review', requirement: '', draftMd: '', canRollback: false });
    notice((data.findings ?? []).length > 0 ? `找到 ${data.findings.length} 条意见` : '没发现明显问题', 'ok');
    render();
    revealPreview();
  }

  async function applyHigh() {
    const data = await api(`${apiBase}/review/${state.review?.reviewId}/apply`, {
      method: 'POST',
      body: { draft: currentDraft() },
    });
    const markdown = data.draftMd ?? currentDraft();
    editor.setDoc({ markdown });
    state.dirty = false;
    state.previewPending = true;
    notice(TEXT.applyHighDone, 'ok');
    render();
    await refreshPreview({ force: true });
    revealPreview();
  }

  /**
   * 回滚到某一轮结束时的草稿。
   *
   * 只换草稿与预览 —— **编辑区一个字都不动**，用户确认后自己点「应用到编辑区」。
   * 这也是后端 `/rollback` 的语义：回滚不是撤销历史，历史照旧留着。
   */
  async function rollbackTo(message) {
    if (message.id === undefined) return;
    const data = await api(`${apiBase}/rollback`, { method: 'POST', body: { sessionId: state.sessionId, messageId: message.id } });
    state.draftMd = typeof data?.draftMd === 'string' ? data.draftMd : message.draftMd;
    state.blocks = data?.blocks ?? state.blocks;
    state.title = data?.title ?? state.title;
    state.diff = [];
    state.dirty = false;
    state.previewPending = true;
    const index = state.messages.findIndex((row) => row.id === message.id);
    state.rolledBackTo = index >= 0 ? index : null;
    // 回滚本身也留痕迹：后端加了一条消息，重新拉一次对齐 id
    await loadHistory();
    notice(TEXT.rollbackDone, 'ok');
    render();
    await refreshPreview({ force: true });
    revealPreview();
  }

  /** 回到最新那一版（等价于回滚到最后一轮）。 */
  async function backToLatest() {
    const latest = [...state.messages].reverse().find((row) => row.canRollback && typeof row.draftMd === 'string' && row.draftMd.length > 0);
    if (!latest) {
      state.rolledBackTo = null;
      renderChat();
      return;
    }
    state.rolledBackTo = null;
    await rollbackTo(latest);
    state.rolledBackTo = null;
    renderChat();
  }

  let pending = Promise.resolve();
  /**
   * 排在队尾的同步：被"忙"挡下的同步会转存到这里，等当前任务收尾时补跑。
   *
   * 为什么不能直接丢：`sync()` 是"编辑区实时监控"的末端，它负责把 `syncedDraft`
   * 推到编辑区此刻的内容。丢掉一次，`syncedDraft` 就停在旧文本、`state.dirty` 恒真，
   * 「应用到编辑区」会一直灰着 —— 用户明明停手了，按钮却像坏了一样。
   * 只留最后一个（不是队列）：同步是幂等的，跑最新那一版就够。
   */
  let queuedSync = null;
  function scheduleResync(task) {
    state.syncQueued = null; // 从这一刻起，最新那次同步可以重新排队
    run(task);
  }
  /**
   * 统一的忙碌/错误包装：一次只跑一件事，出错也只提示不炸面板。
   *
   * 这里有一条不能破的契约：**`pending` 永远不 reject**。
   * 它被 `attach()` 当 `ready` 交出去，也是 `settle()`/`flush()` 的返回值；只要它
   * 变成 rejected，之后每一次 `run()` 都会立刻跟着失败（`.then` 的回调不会执行），
   * 而且调用方多半没挂 `.catch` ⇒ 面板静默死掉 + unhandled rejection。
   * 所以 `renderButtons()` / `render()` 这些自己会抛的渲染函数也必须待在 try 里。
   */
  function run(task) {
    pending = pending.then(async () => {
      try {
        if (state.busy) {
          // 忙的时候**不丢任务**：排到下一个宏任务补跑（用 setTimeout 而不是立刻递归，
          // 否则 `pending` 会在微任务里自我接力，把当前这轮之后的所有事都饿死）。
          // 同一个任务只排一次：`sync()` 是幂等的，跑最新那一版就够。
          //
          // 诚实记录：这条分支是防御性的。审计说它会让「应用到编辑区」永久置灰，
          // 但我没能构造出一条真能区分"丢"与"补跑"的测试 —— `run()` 的回调排在
          // promise 链尾，等它执行时 `state.busy` 通常已经被上一轮的 finally 清掉了，
          // 所以"被丢"的任务往往还是跑到了（`tests/test-panel-queue.mjs` 实测两种实现
          // 都通过）。留着它是因为"忙时不静默丢任务"本身是对的不变量，代价只有一个
          // 空队列判断。
          if (state.syncQueued === task) return;
          state.syncQueued = task;
          setTimeout(() => scheduleResync(task), 0);
          return;
        }
        state.busy = true;
        queuedSync = task;
        renderButtons();
        try {
          await task();
        } catch (error) {
          notice(`${TEXT.error}：${error?.message ?? error}`, 'error');
        } finally {
          state.busy = false;
          queuedSync = null;
        }
      } catch (error) {
        // 连 renderButtons 都炸了：面板已经不可信，但至少不能让链 reject。
        state.busy = false;
        queuedSync = null;
        notice(`${TEXT.error}：${error?.message ?? error}`, 'error');
      } finally {
        try {
          render();
        } catch {
          // 渲染层自身的问题不再往上冒：链必须保持 resolved。
        }
      }
    });
    return pending;
  }

  organizeBtn.addEventListener('click', () => run(organize));
  applyBtn.addEventListener('click', () => run(applyToEditor));
  turnBtn.addEventListener('click', () => run(turn));
  reviewBtn.addEventListener('click', () => run(review));
  collapseBtn.addEventListener('click', () => toggleDrawer());
  tab.addEventListener('click', () => toggleDrawer(true));
  latestBtn.addEventListener('click', () => run(backToLatest));
  htmlBtn.addEventListener('click', () => {
    state.previewMode = 'html';
    renderPreview();
    run(refreshPreview);
  });
  rawBtn.addEventListener('click', () => {
    state.previewMode = 'raw';
    renderPreview();
  });
  refreshBtn.addEventListener('click', () => run(() => refreshPreview({ force: true })));

  // ── 实时监控：编辑区一改，面板就知道（不花钱） ────────────────────
  const monitor = createEditorMonitor(
    editor,
    () => {
      state.dirty = state.syncedDraft !== null && editor.getDoc().markdown !== state.syncedDraft;
      renderButtons();
      renderDiff();
      run(sync);
    },
    { debounceMs },
  );

  render();
  const ready = run(sync);

  const panel = {
    ready,
    settle: () => pending,
    /**
     * 立刻把"待处理的编辑区变化"同步一次，并等它跑完。
     *
     * 用户点按钮时不需要它（动作自己会带上最新草稿）；它的用处是让宿主与测试
     * 有一个确定的时刻可以说"面板现在看到的编辑区就是最新的"。
     */
    flush: () => {
      monitor.flush();
      return pending.then(() => pending);
    },
    refresh: () => run(sync),
    /** 折叠/展开抽屉（宿主也可以在进写作页时调它）。 */
    setOpen: (open) => toggleDrawer(open),
    getState: () => ({ ...state }),
    destroy() {
      monitor.stop();
      if (ATTACHED.get(mount) === panel) ATTACHED.delete(mount);
      // 逃生通道的两条监听挂在 document 上，得自己摘 —— 宿主切视图不会替我们清
      document.removeEventListener('keydown', onKeydown);
      document.removeEventListener('pointerdown', onPointerDown);
      if (document.body?.classList) document.body.classList.remove('notes-drawer-open');
      root.remove?.();
      if (root.parentNode) root.parentNode.removeChild(root);
      // 竖标签是根节点的兄弟，得单独摘掉，否则离开写作页会留一条孤儿标签
      tab.remove?.();
      if (tab.parentNode) tab.parentNode.removeChild(tab);
      // 挂载点那个类是面板自己补的，摘干净（宿主本来就有的话不动它）
      if (mountClassAdded) mount.classList.remove('notes-mount');
    },
  };
  ATTACHED.set(mount, panel);
  return panel;
}

/** 供宿主在 `<script type="module" src="/notes-panel.js">` 之后取用。 */
if (typeof window !== 'undefined') {
  window.NotesAgent = { contractVersion, attach, createTextareaAdapter, createEditorMonitor, imagesFromMarkdown, defaultApi, TEXT };
}
