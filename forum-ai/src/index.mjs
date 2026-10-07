/**
 * forum-ai —— 可复用的 AI 内容理解层。
 *
 * 三个能力：
 *   reviewDocument(doc, siblings)     单篇解读：分类 / 难度 / 摘要 / 标签 / 前置知识 / 推荐阅读
 *   reviewCorpus(docs)                全库整理：主题分组 + 推荐阅读路线
 *   answerQuestion(question, docs)    基于材料的问答（带引用与置信度）
 *
 * 两层可选装配：
 *   createAiStore({ db, documentSource })   SQLite 缓存与语料索引
 *   createAiHandlers({ store, ... })        HTTP 处理器（框架无关）
 *
 * 最小示例：
 *   import { reviewDocument, aiStatus } from 'forum-ai';
 *   const { review } = await reviewDocument({ id: 1, title: '标题', content: '正文' });
 */
export {
  AiError,
  aiConfig,
  aiStatus,
  chat,
  reviewDocument,
  reviewCorpus,
  answerQuestion,
  rankDocuments,
  selectForQuestion,
  rawOutputHead,
} from './ai.mjs';

export {
  ANALYZE_SYSTEM,
  SITE_SYSTEM,
  SITE_PART_SYSTEM,
  SITE_MERGE_SYSTEM,
  ASK_SYSTEM,
  NOT_CONFIGURED_MESSAGE,
  CATEGORY_HINT,
  DIFFICULTIES,
  renderAnalyzeUser,
  renderSiteUser,
  renderSitePartUser,
  renderSiteMergeUser,
  renderAskUser,
  renderSiblingList,
  renderWikiList,
} from './prompts.mjs';

export {
  extractJson,
  normalizeReview,
  normalizeSiteReport,
  normalizeAnswer,
} from './parse.mjs';

export { buildIndexLines, buildMaterial, buildContext, clampText, splitByBudget } from './material.mjs';

export { createAiStore } from './store-sqlite.mjs';

export {
  mountForumAi,
  createForumDocumentSource,
  createWikiPageSource,
  readJsonBody,
  forumAiStatus,
} from './mount.mjs';

export {
  createAiHandlers,
  createAiRouter,
  toResponse,
  ok,
  fail,
  AI_ERROR_STATUS,
} from './routes.mjs';

export const VERSION = '1.0.0';
