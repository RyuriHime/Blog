/**
 * Markdown 渲染桥：优先用宿主自己的渲染器，旁边没有宿主就用本包自带的兜底实现。
 *
 * 为什么需要它：面板的「效果」预览要与站内真实渲染 100% 一致，所以优先借用宿主的渲染函数；
 * 但交付包会被单独拷到没有宿主的目录里跑（`examples/server.mjs` 就是那种形态），
 * 那时也必须能渲染，否则演示页的「效果」按钮是个死按钮。
 *
 * 分两层的原因：浏览器也要用同一个渲染器（面板打不通宿主 `/markdown/preview` 时，
 * 会动态 import 挂载层发出去的 `/notes-markdown.js`）。浏览器不能求值 `node:module`，
 * 所以真正的实现放在零依赖的 `markdown-core.mjs` 里，本文件只负责"探测宿主"。
 *
 * 注意：本文件是 Node 专用（import 了 `node:module`），**不要**把它发给浏览器。
 */
import { createRequire } from 'node:module';
import * as core from './markdown-core.mjs';

const require = createRequire(import.meta.url);
const HOST_MODULE = '../../src/markdown.js';

export const { renderMarkdown, markdownToPlainText, escapeHtml } = core;

let hostResolved = false;
let hostModule = null;

/** 探测宿主的渲染器是否存在（同步，结果缓存）。 */
function resolveHost() {
  if (hostResolved) return hostModule;
  hostResolved = true;
  try {
    hostModule = require(HOST_MODULE);
  } catch {
    hostModule = null;
  }
  return hostModule;
}

/** 现在用的是哪一套：`'host'` 或 `'bundled'`。 */
export function markdownSource() {
  return resolveHost() ? 'host' : 'bundled';
}

/** 取当前生效的渲染器（宿主在场就是宿主那份；字段缺失时逐项退回兜底）。 */
export function loadMarkdown() {
  const host = resolveHost();
  if (!host) {
    return { renderMarkdown: core.renderMarkdown, markdownToPlainText: core.markdownToPlainText, escapeHtml: core.escapeHtml };
  }
  return {
    renderMarkdown: typeof host.renderMarkdown === 'function' ? host.renderMarkdown : core.renderMarkdown,
    markdownToPlainText:
      typeof host.markdownToPlainText === 'function' ? host.markdownToPlainText : core.markdownToPlainText,
    escapeHtml: typeof host.escapeHtml === 'function' ? host.escapeHtml : core.escapeHtml,
  };
}
