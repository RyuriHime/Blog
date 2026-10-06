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

/* @hand-written */
