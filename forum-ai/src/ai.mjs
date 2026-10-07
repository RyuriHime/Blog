/**
 * forum-ai 核心：与任何具体站点无关的 AI 内容理解层。
 *
 * 它只做三件事，输入输出都是普通对象，因此可以被任何后端复用：
 *   1) reviewDocument(doc, siblings)  单篇解读：分类 / 难度 / 摘要 / 标签 / 前置知识 / 推荐阅读
 *   2) reviewCorpus(docs)             全库整理：主题分组 + 推荐阅读路线 + 全景概述
 *   3) answerQuestion(question, docs) 基于给定材料的问答（带引用与置信度）
 *
 * 接入任何 OpenAI 兼容的 /chat/completions 服务；密钥只在服务端。
 *
 *   AI_BASE_URL   默认 https://api.deepseek.com/v1
 *   AI_API_KEY    必填，未配置时所有能力抛出 AiError('ai_not_configured')
 *   AI_MODEL      默认 deepseek-chat
 *   AI_TIMEOUT_MS 默认 60000
 *   AI_MAX_TOKENS 默认 2000
 *   AI_RETRIES    默认 2：上游「200 但没内容」「5xx」「连不上」「超时」时重试几次
 *   AI_RETRY_DELAY_MS 默认 600：重试间隔（第 n 次重试等 n × 该值）
 */
import {
  ANALYZE_SYSTEM,
  SITE_SYSTEM,
  SITE_PART_SYSTEM,
  SITE_MERGE_SYSTEM,
  ASK_SYSTEM,
  NOT_CONFIGURED_MESSAGE,
  renderAnalyzeUser,
  renderSiteUser,
  renderSitePartUser,
  renderSiteMergeUser,
  renderAskUser,
  renderSiblingList,
  renderWikiList,
} from './prompts.mjs';
import { extractJson, normalizeReview, normalizeSiteReport, normalizeAnswer } from './parse.mjs';
import { buildIndexLines, buildMaterial, clampText, splitByBudget } from './material.mjs';

export { extractJson } from './parse.mjs';
export { buildIndexLines, buildMaterial, buildContext, clampText, splitByBudget } from './material.mjs';
export {
  ANALYZE_SYSTEM,
  SITE_SYSTEM,
  SITE_PART_SYSTEM,
  SITE_MERGE_SYSTEM,
  ASK_SYSTEM,
  NOT_CONFIGURED_MESSAGE,
} from './prompts.mjs';

const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';
const DEFAULT_MODEL = 'deepseek-chat';
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 600;
/** 单次「全库整理」给模型的材料上限（字符）；超了就改走目录 / 分块。 */
const CORPUS_CHAR_LIMIT = 24000;
/** 分块整理时每块的字符上限。 */
const CORPUS_CHUNK_CHARS = 12000;

/** 统一的错误类型：带稳定的 code，便于宿主映射成自己的 HTTP 状态码。 */
export class AiError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AiError';
    this.code = code;
    this.details = details;
  }
}

/**
 * 失败时留给排查用的「现场」：模型原始输出的开头一段。
 *
 * 光有一句「AI 返回的解读结果不是合法 JSON」是查不出原因的 —— 到底是 `max_tokens` 截断、
 * 还是字符串里带了非法转义，只有看了原文才知道。所以把开头 500 字（折成一行）挂进
 * `AiError.details.rawOutput`，宿主存进缓存的 `errorDetail` 列。
 */
const RAW_OUTPUT_LIMIT = 500;
export function rawOutputHead(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (flat.length <= RAW_OUTPUT_LIMIT) return flat;
  return `${flat.slice(0, RAW_OUTPUT_LIMIT)}…（全文 ${flat.length} 字）`;
}

export function aiConfig(env = process.env) {
  const apiKey = env.AI_API_KEY || '';
  const baseUrl = (env.AI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  return {
    apiKey,
    baseUrl,
    model: env.AI_MODEL || DEFAULT_MODEL,
    timeoutMs: Number(env.AI_TIMEOUT_MS || 60000),
    maxTokens: Number(env.AI_MAX_TOKENS || 2000),
    retries: Math.max(0, Number(env.AI_RETRIES ?? DEFAULT_RETRIES) || 0),
    retryDelayMs: Math.max(0, Number(env.AI_RETRY_DELAY_MS ?? DEFAULT_RETRY_DELAY_MS) || 0),
    configured: Boolean(apiKey),
  };
}

/**
 * 对外暴露的状态：永远不回传密钥本身。
 *
 * 这里**只加环境变量名，不加新的顶层字段** —— `/api/site` 的 `ai` 对象形状被
 * `scripts/check-golden.mjs` 冻着（它是「用户能感知到的行为一个字都没变」的硬证据）；
 * 重试次数这类配置项请用 `aiConfig()` 读，别塞进 HTTP 响应。
 */
export function aiStatus(env = process.env) {
  const { configured, model, baseUrl } = aiConfig(env);
  return {
    configured,
    model: configured ? model : null,
    baseUrl: configured ? baseUrl : null,
    envKeys: [
      'AI_BASE_URL',
      'AI_API_KEY',
      'AI_MODEL',
      'AI_TIMEOUT_MS',
      'AI_MAX_TOKENS',
      'AI_RETRIES',
      'AI_RETRY_DELAY_MS',
    ],
  };
}

function ensureConfigured(env) {
  const config = aiConfig(env);
  if (!config.configured) throw new AiError('ai_not_configured', NOT_CONFIGURED_MESSAGE);
  return config;
}

/**
 * 调用一次 OpenAI 兼容的 chat completion（不带重试，重试逻辑在 chat 里）。
 * @param {Array<{role:string,content:string}>} messages
 * @param {{ temperature?: number, maxTokens?: number, json?: boolean, fetchImpl?: Function,
 *           signal?: AbortSignal, env?: object }} [options]
 * @returns {Promise<{ text:string, model:string, usage:{prompt:number,completion:number}, raw:any }>}
 */
async function chatOnce(messages, options = {}) {
  const { temperature = 0.2, maxTokens, json = true, fetchImpl = fetch, signal, env = process.env } = options;
  const config = ensureConfigured(env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  let response;
  try {
    response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature,
        max_tokens: maxTokens ?? config.maxTokens,
        ...(json ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new AiError('ai_timeout', `AI 接口超时（${config.timeoutMs}ms），可调大 AI_TIMEOUT_MS 后重试`);
    }
    throw new AiError('ai_unreachable', `无法连接 AI 接口：${error?.message || error}`);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }

  const raw = await response.text();
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new AiError('ai_unauthorized', 'AI 接口鉴权失败：请检查 AI_API_KEY 是否正确、是否有权限');
    }
    if (response.status === 429) {
      throw new AiError('ai_rate_limited', 'AI 接口限流或额度不足（429），请稍后重试');
    }
    throw new AiError('ai_upstream_error', `AI 接口返回 ${response.status}：${raw.replace(/\s+/g, ' ').slice(0, 200)}`, {
      status: response.status,
    });
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new AiError('ai_bad_response', 'AI 接口返回的不是合法 JSON');
  }

  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    // 上游偶尔会返回 200 但内容为空（大提示词更容易触发）；把现场带上，便于排查与重试
    throw new AiError('ai_empty_response', 'AI 接口没有返回内容', {
      finishReason: String(payload?.choices?.[0]?.finish_reason ?? ''),
      usage: {
        prompt: Number(payload?.usage?.prompt_tokens ?? 0),
        completion: Number(payload?.usage?.completion_tokens ?? 0),
      },
      rawHead: raw.replace(/\s+/g, ' ').slice(0, 200),
    });
  }

  return {
    text: content,
    model: payload?.model || config.model,
    usage: {
      prompt: Number(payload?.usage?.prompt_tokens ?? 0),
      completion: Number(payload?.usage?.completion_tokens ?? 0),
    },
    raw: payload,
  };
}

/** 这些错误重试有意义：上游抖动，而不是请求本身有问题。 */
function isTransient(error) {
  if (!(error instanceof AiError)) return false;
  if (error.code === 'ai_empty_response' || error.code === 'ai_unreachable' || error.code === 'ai_timeout') return true;
  // 429（限流）是「等一会儿再来」，不是请求错了
  if (error.code === 'ai_rate_limited') return true;
  if (error.code === 'ai_upstream_error') {
    const status = Number(error.details?.status ?? 0);
    return status === 408 || status === 409 || status === 429 || status >= 500;
  }
  return false;
}

const sleep = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

/**
 * 调用模型，并对**上游抖动**自动重试。
 *
 * 触发重试的情况：200 但内容为空、连接失败、超时、429/5xx。
 * 次数由 AI_RETRIES 控制（默认 2 次重试，即最多 3 次请求），间隔 AI_RETRY_DELAY_MS。
 *
 * @param {Array<{role:string,content:string}>} messages
 * @param {{ attempts?: number, onRetry?: Function }} [options] 其余选项透传给单次请求
 */
export async function chat(messages, options = {}) {
  const { attempts, onRetry, env = process.env, ...rest } = options;
  const { retries, retryDelayMs } = aiConfig(env);
  const maxAttempts = Math.max(1, Number(attempts ?? retries + 1) || 1);
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await chatOnce(messages, { ...rest, env });
    } catch (error) {
      lastError = error;
      if (!isTransient(error) || attempt === maxAttempts) break;
      if (typeof onRetry === 'function') onRetry({ attempt, maxAttempts, error });
      await sleep(retryDelayMs * attempt);
    }
  }
  throw lastError;
}

/**
 * 调一次模型并要求它给出可解析的 JSON。
 *
 * 模型偶尔会返回半截 JSON（尤其是长输出），这种也重试：jsonAttempts 默认 2 次。
 * @returns {Promise<{ parsed: object, text: string, model: string, usage: object }>}
 */
async function chatJson(messages, options = {}) {
  const {
    badJsonMessage = 'AI 返回的结果不是合法 JSON',
    jsonAttempts = 2,
    onRetry,
    ...chatOptions
  } = options;
  let lastError = null;

  for (let attempt = 1; attempt <= Math.max(1, jsonAttempts); attempt += 1) {
    const { text, model, usage } = await chat(messages, chatOptions);
    const parsed = extractJson(text);
    if (parsed && typeof parsed === 'object') return { parsed, text, model, usage };
    lastError = new AiError('ai_bad_json', badJsonMessage, { rawOutput: rawOutputHead(text) });
    if (attempt < jsonAttempts && typeof onRetry === 'function') onRetry({ attempt, lastError });
  }
  throw lastError;
}

/**
 * 单篇解读。
 *
 * recommend 里的编号会按「本次给出的清单」校验：
 *   - 站内帖子编号必须在 `siblings` 里（保留 documentId，宿主渲染成 `#/post/<id>`）；
 *   - 站内 Wiki 词条编号必须在 `options.wikiPages` 里（保留 wikiId，
 *     宿主渲染成 `#/doc/<id>`，因为 wiki 页的影子帖是隐藏的）；
 *   - 两个都不成立的条目直接丢掉 —— 不允许「没有落点的推荐」进结果。
 *
 * @param {object} doc 文档：{ id, title, content, board?, author?, tags?, replies? }
 * @param {Array<object>} [siblings] 可推荐的其它文档（只要 id/title/summary 即可）
 * @param {{ charLimit?: number, chatOptions?: object, wikiPages?: Array<object> }} [options]
 *        `wikiPages`：站内 Wiki 词条候选，每项 `{ id, title, category?, station? }`，
 *        其中 `id` 是**文档编号**。
 * @returns {Promise<{ review: object, model: string, usage: object }>}
 */
export async function reviewDocument(doc, siblings = [], options = {}) {
  const { charLimit = 12000, chatOptions = {}, wikiPages = [] } = options;
  const material = buildMaterial([doc], { charLimit, withReplies: true, withContent: true });
  const { parsed, model, usage } = await chatJson(
    [
      { role: 'system', content: ANALYZE_SYSTEM },
      {
        role: 'user',
        content: renderAnalyzeUser({
          material: material.text,
          siblings: renderSiblingList(siblings, doc.id),
          wiki: renderWikiList(wikiPages),
        }),
      },
    ],
    { temperature: 0.2, badJsonMessage: 'AI 返回的解读结果不是合法 JSON', ...chatOptions },
  );

  const knownIds = new Set([doc.id, ...siblings.map((item) => item.id)].map(String));
  const knownWikiIds = new Set(wikiPages.map((item) => item.id).map(String));
  const review = normalizeReview(parsed, doc, { knownIds, knownWikiIds });
  return { review, model, usage, truncated: material.truncated };
}

/**
 * 全库整理：主题分组 + 阅读路线。
 *
 * 站点一大，「把全库正文塞进一次请求」就会超出上游能稳定处理的长度
 * （表现为 200 但没有内容）。所以这里按三级降级：
 *   1) 材料（含正文）在 charLimit 内 → 一次问完（小站，保持原行为）；
 *   2) 改用**目录**（编号+标题+归类，不带正文）仍超预算 → 只发目录；
 *   3) 目录也超预算 → 按 chunkChars 分块整理，再把各块的分组草案归并成最终地图。
 *
 * @param {Array<object>} docs
 * @param {{ charLimit?: number, chunkChars?: number, chatOptions?: object, onProgress?: Function }} [options]
 * @returns {Promise<{ report: object, model: string, usage: object, mode: string, included: number,
 *                     truncated: boolean, chunks?: number, failures?: Array<object> }>}
 */
export async function reviewCorpus(docs, options = {}) {
  const {
    charLimit = CORPUS_CHAR_LIMIT,
    chunkChars = CORPUS_CHUNK_CHARS,
    chatOptions = {},
    onProgress,
  } = options;
  const list = Array.isArray(docs) ? docs : [];
  const badJsonMessage = 'AI 返回的整理结果不是合法 JSON';

  // 1) 小站：材料含正文也塞得下
  const full = buildMaterial(list, { charLimit, withReplies: true, withContent: true });
  if (!full.truncated) {
    const { parsed, model, usage } = await chatJson(
      [
        { role: 'system', content: SITE_SYSTEM },
        { role: 'user', content: renderSiteUser({ count: list.length, material: full.text }) },
      ],
      { temperature: 0.2, maxTokens: 3000, badJsonMessage, ...chatOptions },
    );
    return { report: normalizeSiteReport(parsed, list), model, usage, mode: 'material', included: full.included, truncated: false };
  }

  // 2) 大站：只发目录（全库整理要的是「有哪些文档、各属于什么方向」）
  const lines = buildIndexLines(list);
  const entries = list.map((doc, index) => ({ doc, line: lines[index] }));
  const indexText = lines.join('\n');
  if (indexText.length <= charLimit) {
    const { parsed, model, usage } = await chatJson(
      [
        { role: 'system', content: SITE_SYSTEM },
        { role: 'user', content: renderSiteUser({ count: list.length, material: indexText }) },
      ],
      { temperature: 0.2, maxTokens: 3000, badJsonMessage, ...chatOptions },
    );
    return { report: normalizeSiteReport(parsed, list), model, usage, mode: 'index', included: list.length, truncated: false };
  }

  // 3) 目录也塞不下：分块整理 → 归并
  const chunks = splitByBudget(entries, chunkChars, (entry) => entry.line);
  const parts = [];
  const failures = [];
  let prompt = 0;
  let completion = 0;
  let model = '';
  let lastError = null;

  for (const [index, chunk] of chunks.entries()) {
    const chunkDocs = chunk.map((entry) => entry.doc);
    try {
      const { parsed, model: chunkModel, usage } = await chatJson(
        [
          { role: 'system', content: SITE_PART_SYSTEM },
          {
            role: 'user',
            content: renderSitePartUser({
              index: index + 1,
              total: chunks.length,
              count: chunk.length,
              material: chunk.map((entry) => entry.line).join('\n'),
            }),
          },
        ],
        { temperature: 0.2, maxTokens: 1500, badJsonMessage: 'AI 返回的分组草案不是合法 JSON', ...chatOptions },
      );
      prompt += usage.prompt;
      completion += usage.completion;
      model = chunkModel || model;
      const part = normalizeSiteReport(parsed, chunkDocs);
      parts.push({ index: index + 1, count: chunk.length, summary: part.summary, topics: part.topics });
    } catch (error) {
      lastError = error;
      failures.push({ part: index + 1, count: chunk.length, error: String(error?.message ?? error).slice(0, 120) });
    }
    if (typeof onProgress === 'function') onProgress({ index: index + 1, total: chunks.length, failures: failures.length });
  }

  if (!parts.length) throw lastError ?? new AiError('ai_empty_response', 'AI 接口没有返回内容');

  const digest = parts
    .map((part) =>
      [`【第 ${part.index} 部分】${part.count} 篇${part.summary ? `：${part.summary}` : ''}`]
        .concat(
          part.topics.map(
            (topic) =>
              `- ${topic.name}（${topic.difficulty}）：${topic.summary} 编号：${topic.documentIds.map((id) => `[#${id}]`).join(' ')}`,
          ),
        )
        .join('\n'),
    )
    .join('\n\n');

  const merged = await chatJson(
    [
      { role: 'system', content: SITE_MERGE_SYSTEM },
      { role: 'user', content: renderSiteMergeUser({ count: list.length, parts: digest }) },
    ],
    { temperature: 0.2, maxTokens: 3000, badJsonMessage, ...chatOptions },
  );
  prompt += merged.usage.prompt;
  completion += merged.usage.completion;
  model = merged.model || model;

  const report = normalizeSiteReport(merged.parsed, list);
  if (!report.topics.length) {
    // 归并没给出可用分组时，退回草案本身 —— 页面上有分组，总比存一份空地图强
    report.topics = parts
      .flatMap((part) => part.topics)
      .map((topic, index) => ({ ...topic, order: index + 1 }))
      .slice(0, 6);
    report.dropped = { ...report.dropped, topics: 0 };
  }

  return {
    report,
    model,
    usage: { prompt, completion },
    mode: 'chunked',
    included: list.length,
    truncated: false,
    chunks: chunks.length,
    failures,
  };
}

/**
 * 基于材料的问答。
 * @param {string} question
 * @param {Array<object>} docs 本次允许使用的材料
 * @param {{ scope?: 'document'|'corpus', charLimit?: number, chatOptions?: object }} [options]
 */
export async function answerQuestion(question, docs, options = {}) {
  const { scope = 'corpus', charLimit, chatOptions = {} } = options;
  const material = buildMaterial(docs, {
    charLimit: charLimit ?? (scope === 'document' ? 16000 : 24000),
    withReplies: true,
    withContent: true,
  });
  const { parsed, model, usage } = await chatJson(
    [
      { role: 'system', content: ASK_SYSTEM },
      { role: 'user', content: renderAskUser({ scope, material: material.text, question: clampText(question, 500) }) },
    ],
    { temperature: 0.3, maxTokens: 1200, badJsonMessage: 'AI 返回的问答结果不是合法 JSON', ...chatOptions },
  );

  const answer = normalizeAnswer(parsed, docs);
  return { answer, model, usage, truncated: material.truncated, included: material.included };
}

/**
 * 关键词检索打分：零依赖的中文/英文混合检索，用于在超预算时挑选最相关的文档。
 * 打分越高越相关；不修改传入对象。
 * @param {string} question
 * @param {Array<object>} docs
 * @returns {Array<{ doc: object, score: number }>} 已按分数降序排列
 */
export function rankDocuments(question, docs) {
  const terms = [...new Set(String(question ?? '').toLowerCase().match(/[a-z0-9_+#.]{2,}|[\u4e00-\u9fa5]{2,}/g) ?? [])];
  const now = Date.now();
  const scored = docs.map((doc) => {
    const title = String(doc.title ?? '').toLowerCase();
    const summary = String(doc.summary ?? '').toLowerCase();
    const category = String(doc.category ?? '').toLowerCase();
    const tags = (Array.isArray(doc.tags) ? doc.tags : []).join(' ').toLowerCase();
    const body = String(doc.content ?? '').toLowerCase();
    const replyText = (doc.replies ?? []).map((reply) => String(reply.content ?? '')).join(' ').toLowerCase();

    let score = 0;
    for (const term of terms) {
      if (title.includes(term)) score += 12;
      if (tags.includes(term)) score += 8;
      if (summary.includes(term)) score += 6;
      if (category.includes(term)) score += 5;
      if (body.includes(term)) score += 3;
      if (replyText.includes(term)) score += 2;
    }
    if (terms.length === 0) score += 1;
    score += Math.min(Number(doc.replyCount ?? doc.replies?.length ?? 0), 10) * 0.3;
    const age = Number(doc.updatedAt ?? doc.createdAt ?? now);
    score += Math.max(0, 6 - (now - age) / (7 * 24 * 3600 * 1000)) * 0.2;
    return { doc, score };
  });
  return scored.sort((a, b) => b.score - a.score || String(a.doc.id).localeCompare(String(b.doc.id)));
}

/**
 * 在字符预算内挑出该塞进上下文的文档。
 * @param {string} question
 * @param {Array<object>} docs
 * @param {{ charBudget?: number, maxDocuments?: number, forceAll?: boolean }} [options]
 */
export function selectForQuestion(question, docs, { charBudget = 24000, maxDocuments = 14, forceAll = false } = {}) {
  const ranked = rankDocuments(question, docs);
  const picked = [];
  let used = 0;
  for (const { doc } of ranked) {
    const size =
      String(doc.title ?? '').length +
      String(doc.content ?? '').length +
      (doc.replies ?? []).reduce((sum, reply) => sum + String(reply.content ?? '').length, 0) +
      200;
    if (picked.length >= maxDocuments) break;
    if (!forceAll && used + size > charBudget && picked.length > 0) break;
    picked.push(doc);
    used += size;
  }
  return { picked: picked.length ? picked : ranked.slice(0, 1).map((item) => item.doc), used };
}
