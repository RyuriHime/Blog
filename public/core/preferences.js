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
// 读和写必须用**同一个 key**：这里读 'forum:profileLayout'，events.js 就得写
// 'forum:profileLayout'。曾经写的是 'forum:Prefs.profileLayout'（多一个 `Prefs.`），
// 于是三个排版按钮点了没反应、选择永远记不住 —— 现在 check-ui-contract 会查
// 「被 readPreference 读到的键，必须有人按同一个字面量写」。
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
