/**
 * note-agent 统一出口。
 *
 * 两种用法：
 *  1. 嵌进已有服务：`import { mountNoteAgent, noteAgentStatus } from './note-agent/src/index.mjs'`
 *  2. 只想用某个纯函数（比如自己写 HTTP 层）：从这里按名取，别去深挖 src/ 下的文件名。
 *
 * 浏览器端不在这个出口里 —— 前端面板是 `client/notes-panel.mjs`，
 * 由挂载层当静态资源以 `/notes-panel.js` 提供，浏览器**不能** import 本文件
 * （它会拉进 node:sqlite 与 node:fs）。
 */
export { mountNoteAgent, noteAgentStatus, CLIENT_URL, STYLE_URL, MARKDOWN_URL } from './mount.mjs';
export { createHandlers, handle, NotesError, ERROR_STATUS, CONTRACT_VERSION, FEATURES } from './routes.mjs';
export { createNotesStore, SCHEMA_VERSION } from './store-sqlite.mjs';

export { BLOCK_TYPES, BLOCK_ID_RE, isBlockId, makeBlock, assignBlockIds, blocksToMarkdown, blocksToPlainText, countBlocks } from './blocks.mjs';
export { extractMaterial, extractSession } from './extract/index.mjs';
export { analyzeStructure } from './structure.mjs';
export { normalizeFormulas, normalizeBlocks, looksLikeFormula } from './formulas.mjs';
export { buildMaterial, buildMessages, DEFAULT_CHAR_BUDGET } from './material.mjs';
export { OP_KINDS, applyOps, validateOp } from './ops.mjs';
export { extractJsonTolerant } from './json.mjs';
export { diffBlocks } from './diff.mjs';
export { generate, turn } from './orchestrator.mjs';
export { reviewDraft, applyReviewPatch, buildReviewOps } from './review.mjs';
export { UPLOAD_RULES, parseMultipart, readRawBody, decodeFilename, classifyUpload, UploadError } from './multipart.mjs';
export { ZipError, openZip, listZipEntries, readZipEntry } from './zip.mjs';
export { ORGANIZE_SYSTEM, TURN_SYSTEM, REVIEW_SYSTEM, FINDING_KINDS, MAX_MATERIAL_CHARS } from './prompts.mjs';
// 模型预算与重试策略：推理模型（deepseek-flash）的思维链会吃满 max_tokens，
// 这些数字不是随便定的，改之前先看 limits.mjs 顶部的实测记录。
export {
  MODEL_MAX_TOKENS, TURN_MAX_TOKENS, RETRY_MAX_TOKENS, MODEL_TIMEOUT_MS, RETRYABLE_CODES,
} from './limits.mjs';
// Markdown 渲染桥：优先用宿主自己的渲染器，旁边没有就用包自带的兜底实现。
// 面板的「效果」预览靠它 —— 宿主没有 /markdown/preview 时也不会退化成只能看原文。
export { loadMarkdown, markdownSource, renderMarkdown, markdownToPlainText, escapeHtml } from './markdown.mjs';
