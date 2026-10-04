/**
 * AI 适配器：**优先用旁边的 `forum-ai`，没有就用自带的兜底实现**。
 *
 * 为什么要有这一层：这个包要能整个文件夹拷给别人。
 * `forum-ai` 是它的兄弟目录（相对 import），拷走的机器上未必有；
 * 兜底实现（`./ai-local.mjs`）提供同样的 `aiConfig / aiStatus / chat` 与同一套错误码，
 * 于是「没有 forum-ai」时面板主流程照常可用；接进论坛的仓库里则仍然走 forum-ai 的真实实现。
 *
 * 三条设计约束（改这个文件前先读）：
 *   1. 业务代码只 import 本文件，不直接 import forum-ai —— 否则兜底就是摆设；
 *   2. **不能有顶层 await**：`src/index.mjs` 是服务端入口，同步 ESM 图更好排查；
 *      于是"文件在不在"用 `createRequire(...).resolve` 同步判断，再决定要不要动态 import；
 *      动态 import 的 Promise 在模块求值结束后才 settle，所以 `loadAi()` 是**运行时**解析，
 *      第一次真实调用（/generate、/turn、/review）一定晚于它 —— 模块求值期不碰 aiConfig；
 *   3. 探测结果缓存一次，之后不再重复判断。
 */
import { createRequire } from 'node:module';
import * as bundledImpl from './ai-local.mjs';

const FORUM_AI = '../../forum-ai/src/ai.mjs';
const FORUM_AI_PARSE = '../../forum-ai/src/parse.mjs';

function exists(specifier) {
  try {
    createRequire(import.meta.url).resolve(specifier);
    return true;
  } catch {
    return false;
  }
}

let forumAi = null;
let forumAiParse = null;
if (exists(FORUM_AI) && exists(FORUM_AI_PARSE)) {
  // 静态说明符（不是变量）才能被打包器/静态分析看见，所以这里不能用循环或拼接。
  import(FORUM_AI)
    .then((module) => {
      forumAi = module;
      return import(FORUM_AI_PARSE);
    })
    .then((module) => {
      forumAiParse = module;
    })
    .catch(() => {
      // forum-ai 在场但它自己 import 失败（比如缺依赖）—— 当作不在，退回兜底。
      forumAi = null;
      forumAiParse = null;
    });
}

/** 这一进程实际用的是哪套实现：`'forum-ai'` 或 `'bundled'`（探测还没落地时报 bundled）。 */
export function aiSource() {
  return forumAi && forumAiParse ? 'forum-ai' : 'bundled';
}

/** 取这一进程该用的实现。测试可绕过（直接 import ai-local.mjs）。 */
export function loadAi() {
  if (forumAi && forumAiParse) {
    return {
      source: 'forum-ai',
      chat: forumAi.chat,
      aiConfig: forumAi.aiConfig,
      aiStatus: forumAi.aiStatus,
      AiError: forumAi.AiError,
      NOT_CONFIGURED_MESSAGE: forumAi.NOT_CONFIGURED_MESSAGE ?? '',
      extractJson: forumAiParse.extractJson,
    };
  }
  return {
    source: 'bundled',
    chat: bundledImpl.chat,
    aiConfig: bundledImpl.aiConfig,
    aiStatus: bundledImpl.aiStatus,
    AiError: bundledImpl.AiError,
    NOT_CONFIGURED_MESSAGE: bundledImpl.NOT_CONFIGURED_MESSAGE_TEXT,
    extractJson: bundledImpl.extractJson,
  };
}

export function aiConfig(env = process.env) {
  return loadAi().aiConfig(env);
}

export function aiStatus(env = process.env) {
  return loadAi().aiStatus(env);
}

/**
 * 调一次 chat completion。**薄封装**：`chatImpl` 注入（测试替身、宿主自带实现）优先，
 * 由 orchestrator / review 在各自的默认参数里决定；本函数只负责"落到哪套实现"。
 */
export function chat(messages, options = {}) {
  return loadAi().chat(messages, options);
}
