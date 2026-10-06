// localStorage 偏好的读写。KEY 常量集中在这里，index.html 的首屏内联脚本里
// 硬编码了 THEME_STORAGE_KEY 的值 —— 改这里必须同步改那边，check-ui-contract 会查。

function readPreference(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
function writePreference(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 隐私模式下忽略 */
  }
}
const profileLayout = () => readPreference('forum:profileLayout', 'list');
// 积木广场的排法：grid（一行多个）还是 list（从上往下列下来）。
// 读和写必须用同一个 key —— events.js 里那个 'forum:Prefs.profileLayout'
// 就是写错 key 的反例（个人主页布局因此从来没被记住）。
const docsLayout = () => readPreference('forum:docsLayout', 'grid');

/* ------------------------------------------------------------------ */
/* 背景主题                                                            */
/* ------------------------------------------------------------------ */

// 这个 key 必须和 index.html 首屏脚本里的字面量一致
const THEME_STORAGE_KEY = 'forum:theme';

// ── 导出 ──────────────────────────────────────────────────────────────
export { readPreference };
export { writePreference };
export { profileLayout };
export { docsLayout };
export { THEME_STORAGE_KEY };

/* @hand-written */
