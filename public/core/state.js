// 前端共享状态与常量。
// 
// 为什么单独一个文件：app.js 是 public/ 里**最后一个**加载的模块，而 core/*.js
// 会被它 import。把 state 留在 app.js 里，core/theme.js 之类的模块就会在
// 初始化之前去读 state.theme（undefined），主题会在刷新时闪一下。
// 
// 规矩：这里只放「数据 + 常量」，不放函数。谁要读就 import 谁。

const state = {
  me: null,
  unread: 0,
  messageUnread: 0,
  theme: 'dark',
  site: {
    boards: [],
    stats: { users: 0, posts: 0, replies: 0 },
    hotPosts: [],
    profileRules: { pinLimit: 3, categoryLimit: 8 },
    messageRules: { oneWayDailyLimit: 1, maxLength: 1000 },
  },
  redirect: '/',
};
const PROFILE_LAYOUTS = [
  ['list', '☰ 列表'],
  ['cards', '▦ 卡片'],
  ['compact', '≡ 紧凑'],
];

/* ------------------------------------------------------------------ */
/* 本地偏好                                                            */
const AVATAR_EMOJIS = [
  ['🦊', 24],
  ['🐳', 198],
  ['🌻', 45],
  ['🧭', 212],
  ['🚀', 265],
  ['🐼', 160],
  ['🦉', 275],
  ['🍀', 130],
  ['⚡', 48],
  ['🎧', 300],
  ['🌙', 230],
  ['🔥', 12],
];

/** 头像字段的两种取值：`emoji:字符:色相` / `file:/avatars/xxx.png`；空串表示用昵称首字母 */

// ── 导出 ──────────────────────────────────────────────────────────────
export { state };
export { PROFILE_LAYOUTS };
export { AVATAR_EMOJIS };

/* @hand-written */
