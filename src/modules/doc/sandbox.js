// 沙箱（`app` 块 / 自定义逻辑块）的服务端一侧。
//
// **服务端从不执行用户代码。** 这里只做三件事：
//   1. 把 `props.code` 拼进一份自带 CSP 的文档；
//   2. 把这份文档 HTML 转义后塞进 iframe 的 `srcdoc` 属性；
//   3. 把 iframe 交出去。
// 所以「沙箱逃逸」在服务端这一侧没有攻击面 —— 代码根本不在服务器上跑。
//
// 隔离靠两个属性，缺一不可：
//   `sandbox="allow-scripts"` 且**不给** `allow-same-origin` → iframe 在不透明源里，
//     读不到父页面 DOM、localStorage、document.cookie，也没有同源 fetch 凭据；
//   文档自己那条 `Content-Security-Policy: default-src 'none'` → 发不出网络请求、
//     加载不了外部脚本与图片，数据出不去。
// 其余 `allow-*` 一个都不给：不能弹窗、不能跳顶层、不能下载、不能进全屏。
import {
  MAX_APP_CODE,
  SANDBOX_CSP,
  SANDBOX_IFRAME_ATTRS,
  SANDBOX_MESSAGES,
} from './schema.js';
import { escapeHtml } from './blocks/text.js';

/**
 * iframe 内部的握手脚本。
 *
 * 它在**用户代码之前**跑，负责三件事：
 *   - 定义 `window.Sandbox`（`props` / `inputs` / `request()` / `value()` / `resize()`）；
 *   - 向宿主发 `ready` 完成握手；
 *   - 把自身高度报回去（宿主据此调 iframe 高度，用户不用管滚动条）。
 *
 * 这里**不解析也不信任**宿主消息以外的东西，宿主那边的白名单在 `public/core/sandbox.js`。
 */
function bootstrapScript() {
  return [
    '<script>',
    '(function () {',
    '  var MAX = 20000;',
    '  var seq = 0;',
    '  var pending = {};',
    '  function send(message) { try { parent.postMessage(message, "*"); } catch (error) {} }',
    '  function measure() {',
    '    var doc = document.documentElement;',
    '    var body = document.body;',
    '    var height = Math.max(doc ? doc.scrollHeight : 0, body ? body.scrollHeight : 0);',
    '    if (!height) return;',
    '    send({ type: "resize", height: Math.max(0, Math.min(MAX, height)) });',
    '  }',
    '  var api = {',
    '    props: {},',
    '    inputs: {},',
    '    // 向宿主申请一个能力。宿主只认白名单里的名字，其余一律拒绝（并记一条审计）。',
    '    // `payload` 是能力自己的参数（`state` 用它传 {op, scope, value}）。',
    '    request: function (capability, payload) {',
    '      return new Promise(function (resolve, reject) {',
    '        var id = ++seq;',
    '        pending[id] = { resolve: resolve, reject: reject };',
    '        send({ type: "request", capability: capability, payload: payload, id: id });',
    '        setTimeout(function () {',
    '          if (!pending[id]) return;',
    '          delete pending[id];',
    '          reject(new Error("capability timeout"));',
    '        }, 5000);',
    '      });',
    '    },',
    '    // 把结果交回宿主（块间联动用它取值）。',
    '    value: function (value) { send({ type: "value", value: value }); },',
    '    resize: measure',
    '  };',
    '  // ── 上面是原始能力；下面是「写起来像一门语言」的那层 ──',
    '  // 每一次调用仍然是一次能力申请，所以服务端那份审计记得住「哪个块读了什么」。',
    '  // api.doc()     这篇文档的元信息 { id, title, kind, author, updatedAt }',
    '  // api.blocks()  正文里每一块的 { id, type, props } —— 按别的块算东西靠它',
    '  // api.viewer()  正在看的人 { loggedIn, id, username, displayName, staff }',
    '  // api.state     持久状态：get(scope) / set(value, scope)，不传 scope 就是「我自己的一份」',
    '  api.doc = function () { return api.request("doc-meta"); };',
    '  api.blocks = function () {',
    '    return api.request("doc-blocks").then(function (r) { return (r && r.blocks) || []; });',
    '  };',
    '  api.viewer = function () { return api.request("viewer"); };',
    '  // api.render 脚本画块：list() / canWrite() / put(id, type, props, scope) / remove(id, scope)',
    '  // 它写的是**派生层**（doc_script_blocks），不动正文；作者可以「采纳为真块」把它们固化下来。',
    '  api.render = {',
    '    list: function (scope) {',
    '      return api.request("blocks.derived", { op: "list", scope: scope }).then(function (r) { return (r && r.blocks) || []; });',
    '    },',
    '    canWrite: function (scope) {',
    '      return api.request("blocks.derived", { op: "list", scope: scope }).then(function (r) { return Boolean(r && r.canWrite); });',
    '    },',
    '    put: function (id, type, props, scope) {',
    '      return api.request("blocks.derived", { op: "put", blockId: id, type: type, props: props, scope: scope });',
    '    },',
    '    remove: function (id, scope) {',
    '      return api.request("blocks.derived", { op: "delete", blockId: id, scope: scope });',
    '    }',
    '  };',
    '  api.state = {',
    '    get: function (scope) {',
    '      return api.request("state", { op: "get", scope: scope }).then(function (r) { return r ? r.value : null; });',
    '    },',
    '    set: function (value, scope) {',
    '      return api.request("state", { op: "set", scope: scope, value: value }).then(function (r) { return r ? r.value : null; });',
    '    }',
    '  };',
    '  window.Sandbox = api;',
    '  window.addEventListener("message", function (event) {',
    '    var data = event && event.data;',
    '    if (!data || typeof data !== "object") return;',
    '    if (data.type === "init") {',
    '      api.props = data.props || {};',
    '      api.inputs = data.inputs || {};',
    '      if (typeof api.onInit === "function") { try { api.onInit(api.props, api.inputs); } catch (error) {} }',
    '      measure();',
    '      return;',
    '    }',
    '    if (data.type === "capability" && data.id && pending[data.id]) {',
    '      var slot = pending[data.id];',
    '      delete pending[data.id];',
    '      if (data.ok) slot.resolve(data.value);',
    '      else slot.reject(new Error(data.message || "capability denied"));',
    '    }',
    '  });',
    '  document.addEventListener("DOMContentLoaded", function () {',
    '    measure();',
    '    if (window.ResizeObserver && document.body) {',
    '      try { new ResizeObserver(measure).observe(document.body); } catch (error) {}',
    '    }',
    '  });',
    '  send({ type: "ready" });',
    '})();',
    '<\/script>',
  ].join('\n');
}

/** 沙箱文档里的一点基础排版 —— 不引外部字体，也不放宽 CSP。 */
const SANDBOX_STYLE = [
  'html,body{margin:0;padding:8px 10px;background:transparent;color:#e8eef7;',
  'font:13px/1.7 "Segoe UI",system-ui,-apple-system,"Microsoft YaHei","PingFang SC",sans-serif}',
  'a{color:#8fb2ff}',
  'button,input,select,textarea{font:inherit;color:inherit}',
].join('');

/**
 * 拼出 iframe 里那份文档。
 * 用户代码原样放进 `<body>`（它想写 HTML 就写 HTML，想写 `<script>` 就写 `<script>`）；
 * 整个文档随后会被 `escapeHtml` 转义进 `srcdoc` 属性，所以它逃不出这个属性。
 */
export function buildSandboxDocument(code) {
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}">`,
    `<style>${SANDBOX_STYLE}</style>`,
    bootstrapScript(),
    '</head><body>',
    String(code ?? ''),
    '</body></html>',
  ].join('');
}

/**
 * `app` 块的内部 HTML（`shell()` 已经包了外层 div）。
 *
 * 三种结果，一条降级链：
 *   作者 / staff 关掉了沙箱 → 「沙箱已禁用」占位（连 iframe 都不建）
 *   没写代码              → 「还没写代码」占位
 *   有代码                → 一个 `sandbox="allow-scripts"` 的 iframe
 */
export function sandboxInner(props, block, options = {}) {
  const code = typeof props?.code === 'string' ? props.code : '';
  const label = escapeHtml(props?.app || props?.title || props?.label || options.label || '小应用');

  if (options.sandboxDisabled) {
    return (
      `<div class="doc-app-slot doc-app-disabled" data-app="${label}">` +
      '<p>这篇文档的沙箱已被管理员禁用，小应用暂时不会运行。</p></div>'
    );
  }
  if (!code.trim()) {
    return (
      `<div class="doc-app-slot doc-app-empty" data-app="${label}">` +
      '<p>这个积木还没写代码。</p></div>'
    );
  }

  const document_html = buildSandboxDocument(code);
  const id = escapeHtml(block?.block_id ?? '');
  return (
    `<iframe class="doc-app-frame" data-doc-block="${id}" data-app="${label}" ` +
    `title="${label}" ${SANDBOX_IFRAME_ATTRS} ` +
    `srcdoc="${escapeHtml(document_html)}"></iframe>`
  );
}

/**
 * 这个块类型是不是沙箱块（要跑用户代码）。
 *
 * 内置的 `app` 与 `script` 都算；用户注册的类型只要声明了 `renderer_kind: 'sandbox'` 也算 ——
 * 否则「注册沙箱块」就只是一句空话：注册得出来，渲染时是一个空 div。
 * 参数既收类型名（字符串）也收类型定义（注册表里的对象）。
 */
export function isSandboxType(type) {
  if (type && typeof type === 'object') {
    return type.name === 'app' || type.name === 'script' || type.renderer_kind === 'sandbox';
  }
  const name = String(type ?? '');
  return name === 'app' || name === 'script';
}

/** 宿主接受的消息类型（前端 `public/core/sandbox.js` 用同一份清单）。 */
export const HOST_ACCEPTED_MESSAGES = [...SANDBOX_MESSAGES];

export { MAX_APP_CODE };
