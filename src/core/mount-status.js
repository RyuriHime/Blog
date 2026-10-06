// 挂载层状态的**延迟句柄**。
//
// 背景：`GET /api/site` 的响应里要带 `ai`（论坛 AI 阅读助手是否配好）与 `notes`
// （笔记 Agent 是否可用）两个字段，这两个状态由 `src/server.js` 在**运行时**从
// `forum-ai` / `note-agent` 两个自包含包里 import 出来。
//
// 但 `src/modules/core/` 是「论坛本体」模块，它**不允许**直接 import 那两个包
// （那会让 core 模块依赖具体实现，破坏「模块之间只通过 ctx 通信」的冻结契约）。
// 所以这里放一对空壳：core 模块 import 这个文件拿到函数，src/server.js 在启动时
// 调 registerMountStatus() 把真正的实现灌进来。
//
// 这是骨架里**第二个**可变绑定（第一个是 core/store.js 的 bindStore）。
// 规则：只能在启动时注册一次；没注册就调用会抛错，而不是悄悄返回 undefined
// —— 静默返回 undefined 会让 /api/site 少了两个字段，行为金标准测试却能漏掉。
const NOT_READY = '挂载层状态还没有注册：请先在 src/server.js 里调用 registerMountStatus()';

let forum = null;
let noteAgent = null;

/**
 * 注册挂载层状态的两个读取函数。
 * @param {{ forumAi?: () => any, noteAgent?: () => any }} handlers
 */
export function registerMountStatus(handlers = {}) {
  if (forum || noteAgent) throw new Error('挂载层状态已经注册过了，不能重复注册');
  if (typeof handlers.forumAi !== 'function') throw new Error('registerMountStatus 需要 forumAi 函数');
  if (typeof handlers.noteAgent !== 'function') throw new Error('registerMountStatus 需要 noteAgent 函数');
  forum = handlers.forumAi;
  noteAgent = handlers.noteAgent;
}

/** 论坛 AI 阅读助手的挂载状态（供 GET /api/site 读取）。 */
export function forumAiStatus() {
  if (!forum) throw new Error(NOT_READY);
  return forum();
}

/** 学术笔记整理 Agent 的挂载状态（供 GET /api/site 读取）。 */
export function noteAgentStatus() {
  if (!noteAgent) throw new Error(NOT_READY);
  return noteAgent();
}

/** 是否已经注册（自检用）。 */
export function mountStatusReady() {
  return Boolean(forum && noteAgent);
}
