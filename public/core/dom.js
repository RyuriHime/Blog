// DOM 小工具：$(选择器)、ui（挂载点）、esc（HTML 转义）、emptyHtml、loadingHtml、toast、copyText。
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
 * 复制文本到剪贴板，返回是否成功。
 *
 * 为什么不能直接用 navigator.clipboard：它带 `[SecureContext]`，
 * **只在 https / localhost / file:// 里存在**。本站线上是
 * `http://47.106.123.230:8080/`（公网 IP + 明文 HTTP，没有 nginx 也没有 443），
 * 在那里 `navigator.clipboard` 是 undefined —— 「复制」按钮点了什么也不会发生。
 * 而本地开发恰好跑在 localhost（属于安全上下文），所以这个洞在开发机上**永远复现不出来**。
 *
 * 退化路径用 `document.execCommand('copy')`：它已被标记废弃，但没有安全上下文限制，
 * 在 http 页面上照样能写进剪贴板，且必须有用户手势（我们本来就点了一下按钮）。
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

  // execCommand 只对「可选中」的元素生效：先塞一个不可见的 textarea，选中它再复制，
  // 无论成败都在 finally 里删掉。
  const holder = document.createElement('textarea');
  holder.value = value;
  holder.setAttribute('readonly', '');
  // 注意：不能写 display:none / visibility:hidden —— 那样选不中，execCommand 必然失败。
  // 挪到视口外 + 压到 1px 才是通行写法。
  holder.style.cssText = 'position:fixed;top:0;left:-9999px;width:1px;height:1px;opacity:0;';
  document.body.append(holder);
  try {
    holder.select();
    // iOS Safari 只认 setSelectionRange，光 select() 复制出来是空串。
    holder.setSelectionRange(0, value.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    holder.remove();
  }
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

/* @hand-written */
