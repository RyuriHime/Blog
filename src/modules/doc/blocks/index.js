// 块引擎的统一出口。纯函数层：不碰数据库、不碰 HTTP，可以直接被脚本 import 单测。
export { BUILTIN_TYPES } from './types.js';
export {
  getBlockType,
  listBlockTypes,
  loadBlockTypes,
  registerBlockType,
  resetDatabaseTypes,
} from './registry.js';
export { coerceProps, validateProps } from './validate.js';
export { placeholder, renderBlocks } from './html.js';
export { resolveBinds } from './bind.js';
export {
  blocksToJson,
  blocksToMarkdown,
  ID_BEARING_TYPES,
  markdownToBlocks,
  parseBlocks,
  parseBlocksJson,
  parseSourceBlocks,
  toSource,
} from './markdown.js';
export { blocksToPlainText, countBlocks } from './plain.js';
export { AGENT_BLOCK_TYPES, fromNoteAgentBlocks, toNoteAgentBlocks } from './agent.js';
export { buildSandboxDocument, isSandboxType, sandboxInner } from '../sandbox.js';
