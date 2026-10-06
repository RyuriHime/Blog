// HTTP 客户端：统一的 fetch 包装 + 信封拆解 + 401 跳登录 + 忙碌态按钮。
// 
// 三个约定（与后端 src/core/http.js 一一对应）：
//   1) 成功 = { ok: true, data }，失败 = { ok: false, error: { code, message } }；
//   2) 未登录返回 401，前端**不要**自己猜，直接跳 #/login；
//   3) 所有错误都必须抛出 Error（带 .code），别返回 undefined 让调用方猜。

import { $ } from './dom.js';
import { assertRouteCurrent, currentRouteSeq } from './route-guard.js';
import { state } from './state.js';
import * as Session from './session.js';

async function api(path, options = {}) {
  const { method = 'GET', body } = options;
  const seq = currentRouteSeq(); // 发起这次请求时正在渲染的页面代次（不在视图里则为 null）
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    throw new Error('网络请求失败，请检查服务是否在运行');
  }
  assertRouteCurrent(seq); // 页面早换了，这份数据作废（抛出 .aborted 的错误）
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    /* 忽略解析失败 */
  }
  if (!response.ok || !payload?.ok) {
    const error = new Error(payload?.error?.message || `请求失败（HTTP ${response.status}）`);
    error.code = payload?.error?.code;
    error.status = response.status;
    if (response.status === 401) {
      state.me = null;
      state.unread = 0;
      Session.renderUserArea();
    }
    throw error;
  }
  return payload.data;
}
async function withButtonBusy(button, task) {
  if (!button) return task();
  button.disabled = true;
  try {
    return await task();
  } finally {
    button.disabled = false;
  }
}

// ── 导出 ──────────────────────────────────────────────────────────────
export { api };
export { withButtonBusy };

/* @hand-written */
