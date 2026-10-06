// DOM 小工具：$(选择器)、ui（挂载点）、esc（HTML 转义）、emptyHtml、loadingHtml、toast。
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

// ── 导出 ──────────────────────────────────────────────────────────────
export { ui };
export { $ };
export { ESCAPES };
export { esc };
export { emptyHtml };
export { loadingHtml };
export { toast };

/* @hand-written */
