/**
 * note-studio —— 学术笔记编辑器（独立可搬运）。
 *
 * 分层：
 *   meta       文档基础数据（→ .json）
 *   ai-bridge  唯一消费既有 forum-ai chat() 的适配层
 *   store      双写持久化：<name>.md + <name>.json
 *   routes     框架无关 HTTP 处理器（注入 store / ai / currentUser）
 *   static     编辑器静态资源分发
 *   server     独立入口（挂在论坛里时用不到）
 */
export { SCHEMA, GENERATOR, analyzeDocument, countWords, hashText, slugifyFilename } from './meta.mjs';

export {
  NoteAiError,
  IMAGE_PROMPTS,
  ORGANIZE_SYSTEM,
  REVIEW_SYSTEM,
  buildImageMessages,
  parseImageResult,
  defaultExtractJson,
  createAiBridge,
  loadForumChat,
} from './ai-bridge.mjs';

export { createNoteStore } from './store.mjs';

export {
  VERSION,
  NOTE_ERROR_STATUS,
  DEFAULT_LIMITS,
  ok,
  fail,
  toResponse,
  createNoteHandlers,
  createNoteRoutes,
  createNoteRouter,
} from './routes.mjs';

export { MIME, createStaticHandler } from './static.mjs';

export {
  LOCAL_USER,
  PUBLIC_DIR,
  DEFAULT_DATA_DIR,
  createNoteServer,
  startNoteServer,
  createServerAi,
} from './server.mjs';
