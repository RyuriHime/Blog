// DOM 小工具：$(选择器)、ui（挂载点）、esc（HTML 转义）、emptyHtml、loadingHtml、toast、copyText、selectText。
// 
// `ui` 在这里而不是 state.js：它要在模块求值时就抓到 #app / #sidebar 等挂载点，
// 这些元素在 index.html 的 <body> 里、脚本执行时已经存在。

const $ = (selector, root = document) => root.querySelector(selector);
const ui = {
  app: $('#app'),
  sidebar: $('#sidebar'),
  userArea: $('#user-area'),
  searchForm: $('#search-form'),
  searchInput: $('#search-input'),
  toasts: $('#toasts'),
};
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPES[char]);
function toast(message, type = 'info') {
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.textContent = message;
  ui.toasts.append(node);
  setTimeout(() => node.remove(), 3200);
}
function loadingHtml() {
  return `<div class="card"><div class="skeleton">
    <div class="sk-line" style="width:38%"></div>
    <div class="sk-line" style="width:88%"></div>
    <div class="sk-line" style="width:74%"></div>
    <div class="sk-line" style="width:56%"></div>
  </div></div>`;
}
const emptyHtml = (emoji, title, hint = '') =>
  `<div class="empty"><span class="emoji">${emoji}</span><div>${esc(title)}</div>${
    hint ? `<div class="hint">${esc(hint)}</div>` : ''
  }</div>`;

/** 未登录时先去登录页，登录后回到原处。 */

/**
 * 用 `document.execCommand('copy')` 复制，返回是否成功。
 *
 * 写法照抄 clipboard.js（跑了十年、覆盖全部浏览器的那一份）：
 * 把一个不可见的 textarea 挪到视口外，选中它再复制。
 *   ① 不能写 `display:none` / `visibility:hidden` —— 那样根本选不中，必然失败；
 *   ② 复制完要把用户**原来的选区还回去**，否则页面上原本选中的东西会莫名消失。
 */
function execCommandCopy(value) {
  const holder = document.createElement('textarea');
  holder.value = value;
  holder.setAttribute('readonly', '');
  holder.style.position = 'absolute';
  holder.style.top = '0';
  holder.style.left = '-9999px';
  document.body.append(holder);

  const selection = document.getSelection();
  const previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  let ok = false;
  try {
    holder.select();
    // iOS Safari 只认 setSelectionRange，光 select() 复制出来是空串。
    holder.setSelectionRange(0, value.length);
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  } finally {
    holder.remove();
    if (previous && selection) {
      selection.removeAllRanges();
      selection.addRange(previous);
    }
  }
  return ok;
}

/**
 * 复制文本到剪贴板，返回是否成功。
 *
 * 为什么不能直接用 navigator.clipboard：它带 `[SecureContext]`，
 * **只在 https / localhost / file:// 里存在**。本站线上是
 * `http://47.106.123.230:8080/`（公网 IP + 明文 HTTP，没有 nginx 也没有 443），
 * 在那里 `navigator.clipboard` 是 undefined —— 「复制」按钮点了什么也不会发生。
 * 而本地开发恰好跑在 localhost（属于安全上下文），所以这个洞在开发机上**永远复现不出来**。
 *
 * 退化路径 `execCommand('copy')` 虽已被标记废弃，但**没有安全上下文限制**，
 * 在 http 页面上照样能写进剪贴板（clipboard.js 这类库一直这么干）。
 * 两条路都失败时返回 false，由调用方决定怎么跟用户交代 —— 绝不能默默什么都不做。
 */
async function copyText(text) {
  const value = String(text ?? '');
  if (!value) return false;

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      /* 用户拒了权限、或页面不在前台 —— 落到下面的退化路径 */
    }
  }

  return execCommandCopy(value);
}

/**
 * 把某个元素里的文字选中，配合「请按 Ctrl+C」使用。
 *
 * 为什么这条一定管用：浏览器对**键盘 / 菜单触发的复制**是无条件放行的
 * （Blink 的 `CanWriteClipboard` 对 `kMenuOrKeyBinding` 直接 return true），
 * 而 `execCommand('copy')` 属于脚本触发，要检查用户手势。
 * 两条脚本路径都失败时，「选中 + Ctrl+C」是唯一还能用的保底。
 */
function selectText(node) {
  if (!node) return false;
  const selection = document.getSelection();
  if (!selection) return false;
  const range = document.createRange();
  range.selectNodeContents(node);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

/**
 * 在新标签页里打开一个站内地址，并把**焦点**交给新标签页，返回是否真的开了。
 *
 * 为什么不用 `<a target="_blank">`：那样必须配 `rel="noopener"`（否则新页面能改回
 * `window.opener.location`，是经典的劫持面），而规范规定带 `noopener` 时
 * `window.open` 返回 `null` —— 拿不到句柄就没法 `focus()`，可「焦点要落到新标签页上」
 * 正是需求的一部分。所以自己开：先拿句柄，再手动切断 `opener`，最后聚焦。
 *
 * 被浏览器拦掉弹窗时返回 false，调用方就不要 `preventDefault()`，
 * 让这次点击退回家常行为（否则用户点了会毫无反应）。
 */
function openTab(href) {
  const opened = window.open(href, '_blank');
  if (!opened) return false;
  try {
    opened.opener = null;
    opened.focus();
  } catch {
    /* 跨域句柄跳转后可能写不动；能开的已经开了，聚焦失败不该影响这次点击 */
  }
  return true;
}

/**
 * 让 Tab 在文本框里**真的缩进**，而不是把焦点跳到下一个控件上。
 *
 * 为什么要有这个：写代码、写脚本的地方，Tab 不能缩进等于没法写 ——
 * 用户只能手打空格，还得数着打几个。这是站内被抱怨最久的一条
 * （早先一条测试动态的正文干脆叫 `imveryangrybecauseicantusetabinthecodeblocks`）。
 *
 * `target` 可以是 textarea 本身，也可以是**装着 textarea 的容器** ——
 * 容器那种走事件委托。积木模式的块是随时插入、随时整页重画的，
 * 一个个挂监听会漏掉后来的那些；委托只挂一次，永远不漏。
 *
 * 行为（和常见编辑器对齐）：
 *   · 没选中东西：Tab 在光标处插一个制表符；Shift+Tab 往左退一级缩进。
 *   · 选中了东西：Tab 把碰到的每一行都缩进一级，Shift+Tab 反向，选区保留。
 *
 * 改完派发一次 `input`：实时预览、自动保存这些都是挂在 `input` 上的既有监听，
 * 这里不该绕过它们去调私有函数。
 */
const OUTDENT_RE = /^(\t| {1,4})/;

/** 写回内容 + 选区，再派发 input。假 DOM 没有 Event / dispatchEvent，吞掉即可 —— 缩进本身已经生效。 */
function writeTextarea(textarea, value, start, end) {
  textarea.value = value;
  if (typeof textarea.setSelectionRange === 'function') textarea.setSelectionRange(start, end);
  try {
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  } catch {
    /* 无头测试里的假 DOM */
  }
}

function applyIndent(textarea, unit, outdent) {
  const value = String(textarea.value ?? '');
  let start = Number(textarea.selectionStart ?? 0);
  let end = Number(textarea.selectionEnd ?? 0);
  if (!Number.isFinite(start) || start < 0) start = 0;
  if (!Number.isFinite(end) || end < 0) end = 0;
  if (end < start) [start, end] = [end, start];

  const lineStartOf = (index) => value.lastIndexOf('\n', Math.max(0, index - 1)) + 1;

  // 没选区：只在光标处动一个缩进单位，整行不跟着挪 —— 写 Markdown 时这样最可预期。
  if (start === end) {
    if (!outdent) {
      writeTextarea(textarea, value.slice(0, start) + unit + value.slice(end), start + unit.length, start + unit.length);
      return;
    }
    const lineFrom = lineStartOf(start);
    const leading = value.slice(lineFrom).match(OUTDENT_RE)?.[0] ?? '';
    if (!leading) return;
    // 整行退一级，光标跟着左移同样的格数（不会退到上一行去）。
    const at = Math.max(lineFrom, start - leading.length);
    writeTextarea(textarea, value.slice(0, lineFrom) + value.slice(lineFrom + leading.length), at, at);
    return;
  }

  // 有选区：碰到的每一行整行缩进 / 反缩进。
  const from = lineStartOf(start);
  // 选区正好停在某一行的行首时，那一行不算被碰到。
  const to = end === lineStartOf(end) ? end - 1 : (() => {
    const newline = value.indexOf('\n', end);
    return newline === -1 ? value.length : newline;
  })();
  const chunk = value.slice(from, to);
  if (!chunk) return;
  const lines = chunk.split('\n');
  const mapped = lines.map((line) => (outdent ? line.replace(OUTDENT_RE, '') : unit + line));
  const changed = mapped.join('\n');
  const next = value.slice(0, from) + changed + value.slice(to);
  // 光标按实际增删的字数平移，再夹回合法范围 —— 整块反缩进时第一行会变短，
  // 不夹的话选区左端会跑到 0 左边去（假 DOM 里就照出来了）。
  const nextStart = Math.max(0, Math.min(next.length, start + (mapped[0].length - lines[0].length)));
  const nextEnd = Math.max(nextStart, Math.min(next.length, end + (changed.length - chunk.length)));
  writeTextarea(textarea, next, nextStart, nextEnd);
}

function indentTextarea(target, options = {}) {
  if (typeof target?.addEventListener !== 'function') return;
  const unit = options.unit ?? '\t';
  target.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const textarea = event.target;
    if (textarea?.tagName !== 'TEXTAREA') return;
    event.preventDefault();
    applyIndent(textarea, unit, Boolean(event.shiftKey));
  });
}

// ── 导出 ──────────────────────────────────────────────────────────────
export { ui };
export { $ };
export { ESCAPES };
export { esc };
export { emptyHtml };
export { loadingHtml };
export { toast };
export { copyText };
export { selectText };
export { openTab };
export { indentTextarea };

/* @hand-written */
