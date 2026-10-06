// 接口错误的统一出口：把各种失败翻译成「一句给用户看的话」。
//
// 为什么要单独一个文件：这一层要同时用到 dom（toast）、state、session（renderUserArea），
// 塞进 dom.js（最底层）或 api.js（会话那层）都会让依赖方向拧过来。
//
// 为什么不 import router.js：router.js 的 catch 也要调这里的 apiErrorText，
// 两边互相 import 会绕成环形依赖。登录跳转那两行直接用 location.hash 写，
// 效果和 navigate('/login') 等价（见下面的注释）。
//
// 两个出口：
//   apiErrorText(error) → 返回要给用户看的文案；返回空串表示「已经处理过了，别再提示」
//   toastError(error)   → catch 里的统一收尾：过期响应静默丢弃，其余按 apiErrorText 分流后弹提示

import { toast } from './dom.js';
import * as Session from './session.js';
import { state } from './state.js';

/**
 * 把接口错误统一分流成一句给用户看的话。
 * 返回空字符串表示「已经处理过了，不要再提示」（目前只有会话失效这条）。
 */
function apiErrorText(error) {
  const status = error?.status;
  const code = error?.code;
  if (status === 401 || code === 'login_required' || code === 'unauthorized') {
    // 会话过期：清掉本地登录态、记住来路、送去登录页，回来还能接着原路走
    state.me = null;
    state.unread = 0;
    Session.renderUserArea();
    state.redirect = location.hash.replace(/^#/, '') || '/';
    // 等价于 navigate('/login')：只有确实不在登录页时才写 hash，
    // 所以不会走到 navigate 里「同地址就重新 route()」那个分支。
    const here = location.hash.replace(/^#/, '').split('?')[0] || '/';
    if (here !== '/login') location.hash = '/login';
    toast('登录状态已失效，请重新登录', 'error');
    return '';
  }
  if (status === 429 || code === 'rate_limited') return '操作太频繁了，歇一会儿再试';
  if (status === 403) return error?.message || '没有权限执行这个操作';
  if (status >= 500) return '服务器开小差了，请稍后再试';
  return error?.message || '操作失败';
}

/** catch 里的统一出口：过期响应静默丢弃，其余按 apiErrorText 分流后弹提示。 */
function toastError(error, fallback = '') {
  if (error?.aborted) return;
  const text = apiErrorText(error) || fallback;
  if (text) toast(text, 'error');
}

// ── 导出 ──────────────────────────────────────────────────────────────
export { apiErrorText };
export { toastError };

/* @hand-written */
