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
export { buildIndexLines, buildMaterial, buildContext, clampText, splitByBudget, excerptAroundFocus, focusHeadings } from './material.mjs';
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
/**
 * 地图类调用（材料 / 目录 / 归并）的输出预算。
 *
 * 这几种调用要的是一整张地图的 JSON，而推理型模型会把预算先烧在思考上 ——
 * 实测线上 554 篇时 `finish_reason=length`、生成正好卡在 3000、正文为空。
 */
const CORPUS_MAP_MAX_TOKENS = 6000;
/** 分块草案的输出预算：每块只要 2-5 组，比整张地图小得多。 */
const CORPUS_PART_MAX_TOKENS = 2500;
/** 分块草案被截断时最多对半切几次（3 次 = 一块最多切成 1/8，再小就单篇了）。 */
const CORPUS_SPLIT_DEPTH = 3;

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

  const choice = payload?.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    // 上游偶尔会返回 200 但内容为空（大提示词、长输出更容易触发）；把现场带上，便于排查与重试
    throw new AiError('ai_empty_response', 'AI 接口没有返回内容', {
      finishReason: String(choice?.finish_reason ?? ''),
      usage: {
        prompt: Number(payload?.usage?.prompt_tokens ?? 0),
        completion: Number(payload?.usage?.completion_tokens ?? 0),
      },
      // 推理型模型把预算烧在思考上时，正文是空的、思考内容另有一栏
      hadReasoning: Boolean(choice?.message?.reasoning_content),
      rawHead: raw.replace(/\s+/g, ' ').slice(0, 200),
    });
  }

  return {
    text: content,
    finishReason: String(choice?.finish_reason ?? ''),
    model: payload?.model || config.model,
    usage: {
      prompt: Number(payload?.usage?.prompt_tokens ?? 0),
      completion: Number(payload?.usage?.completion_tokens ?? 0),
    },
    raw: payload,
  };
}

/**
 * 输出被 `max_tokens` 截断（`finish_reason=length`）。
 *
 * 两种表现都算：正文**空的**（推理型模型把预算烧在思考上，`ai_empty_response`）、
 * 以及**只写了半截 JSON**（解析不出来，`ai_bad_json`）。
 *
 * 这不是上游抖动：同样的预算再问一遍，结果只会一样。所以它**不重试**，
 * 而是让调用方「少问一点」（分块、对半切）或「给更多预算」。
 */
export function isTruncated(error) {
  if (String(error?.details?.finishReason ?? '') !== 'length') return false;
  return error?.code === 'ai_empty_response' || error?.code === 'ai_bad_json';
}

/** 这些错误重试有意义：上游抖动，而不是请求本身有问题。 */
function isTransient(error) {
  if (!(error instanceof AiError)) return false;
  if (isTruncated(error)) return false; // 预算不够，重试救不了
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
 * 但**被 `max_tokens` 截断**的那种（`finish_reason=length`）不重试 —— 同样预算问两遍还是半截，
 * 直接带着现场交给调用方去「少问一点」。
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
    const { text, model, usage, finishReason } = await chat(messages, chatOptions);
    const parsed = extractJson(text);
    if (parsed && typeof parsed === 'object') return { parsed, text, model, usage };
    lastError = new AiError('ai_bad_json', badJsonMessage, {
      rawOutput: rawOutputHead(text),
      finishReason,
      usage,
    });
    if (isTruncated(lastError)) break;
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
 * 另外两处「宁可地图糙一点，也别整页空白」的兜底：
 *   - 输出被 `max_tokens` 截断（`finish_reason=length`，推理模型常见；正文可能是空的，也可能是
 *     半截 JSON）时，不重试，而是**落到下一级**：目录被截断就改分块，某一块被截断就把它对半
 *     切开再问（直到单篇）；
 *   - 归并那一次失败时，直接用各块草案拼出主题与概述（并把失败记进 `failures`）。
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
      { temperature: 0.2, maxTokens: CORPUS_MAP_MAX_TOKENS, badJsonMessage, ...chatOptions },
    );
    return { report: normalizeSiteReport(parsed, list), model, usage, mode: 'material', included: full.included, truncated: false };
  }

  // 2) 大站：只发目录（全库整理要的是「有哪些文档、各属于什么方向」）
  const lines = buildIndexLines(list);
  const entries = list.map((doc, index) => ({ doc, line: lines[index] }));
  const indexText = lines.join('\n');
  if (indexText.length <= charLimit) {
    try {
      const { parsed, model, usage } = await chatJson(
        [
          { role: 'system', content: SITE_SYSTEM },
          { role: 'user', content: renderSiteUser({ count: list.length, material: indexText }) },
        ],
        { temperature: 0.2, maxTokens: CORPUS_MAP_MAX_TOKENS, badJsonMessage, ...chatOptions },
      );
      return { report: normalizeSiteReport(parsed, list), model, usage, mode: 'index', included: list.length, truncated: false };
    } catch (error) {
      // 目录不长、但这一次没问出可用的地图（被截断，或是半截 JSON）：别在这里失败，
      // 落到分块去「一次只问一小片」—— 小片更容易问完整
      if (!isTruncated(error) && error?.code !== 'ai_bad_json') throw error;
    }
  }

  // 3) 目录也塞不下（或一次问不完）：分块整理 → 归并
  const chunks = splitByBudget(entries, chunkChars, (entry) => entry.line);
  const parts = [];
  const failures = [];
  let prompt = 0;
  let completion = 0;
  let model = '';
  let lastError = null;

  /**
   * 问一块的分组草案。
   *
   * 这一块要是**输出被截断**（模型想太久），就把它对半切开再问 —— 一次问的篇数越少，
   * 输出越短，越问得完；切到单篇还截断才算这块失败（不重试，重试也是同样的结果）。
   */
  const collect = async (chunkEntries, partIndex, depth) => {
    const chunkDocs = chunkEntries.map((entry) => entry.doc);
    try {
      const { parsed, model: chunkModel, usage } = await chatJson(
        [
          { role: 'system', content: SITE_PART_SYSTEM },
          {
            role: 'user',
            content: renderSitePartUser({
              index: partIndex,
              total: chunks.length,
              count: chunkEntries.length,
              material: chunkEntries.map((entry) => entry.line).join('\n'),
            }),
          },
        ],
        { temperature: 0.2, maxTokens: CORPUS_PART_MAX_TOKENS, badJsonMessage: 'AI 返回的分组草案不是合法 JSON', ...chatOptions },
      );
      prompt += usage.prompt;
      completion += usage.completion;
      model = chunkModel || model;
      const part = normalizeSiteReport(parsed, chunkDocs);
      parts.push({ index: partIndex, count: chunkEntries.length, summary: part.summary, topics: part.topics });
    } catch (error) {
      lastError = error;
      if (isTruncated(error) && chunkEntries.length > 1 && depth < CORPUS_SPLIT_DEPTH) {
        const mid = Math.ceil(chunkEntries.length / 2);
        await collect(chunkEntries.slice(0, mid), partIndex, depth + 1);
        await collect(chunkEntries.slice(mid), partIndex, depth + 1);
        return;
      }
      failures.push({ part: partIndex, count: chunkEntries.length, error: String(error?.message ?? error).slice(0, 120) });
    }
  };

  for (const [index, chunk] of chunks.entries()) {
    await collect(chunk, index + 1, 0);
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

  let merged = null;
  try {
    merged = await chatJson(
      [
        { role: 'system', content: SITE_MERGE_SYSTEM },
        { role: 'user', content: renderSiteMergeUser({ count: list.length, parts: digest }) },
      ],
      { temperature: 0.2, maxTokens: CORPUS_MAP_MAX_TOKENS, badJsonMessage, ...chatOptions },
    );
    prompt += merged.usage.prompt;
    completion += merged.usage.completion;
    model = merged.model || model;
  } catch (error) {
    // 归并失败不抛：还有各块草案可以拼出一张地图，页面上有分组总比存一份空地图强
    lastError = error;
    failures.push({ part: 'merge', count: list.length, error: String(error?.message ?? error).slice(0, 120) });
  }

  const report = merged ? normalizeSiteReport(merged.parsed, list) : normalizeSiteReport({}, list);
  if (!report.topics.length) {
    // 归并没给出可用分组时，退回草案本身 —— 页面上有分组，总比存一份空地图强
    report.topics = parts
      .flatMap((part) => part.topics)
      .map((topic, index) => ({ ...topic, order: index + 1 }))
      .slice(0, 6);
    report.summary = report.summary || parts.map((part) => part.summary).filter(Boolean).join(' ').slice(0, 400);
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
 * 问答的输出预算（LOCAL PATCH，见 LOCAL-PATCHES.md 的 L 节）。
 *
 * 上游把问答的 `maxTokens` 写死成 1200：全站问答（14 篇材料、要带引用的 JSON）实测
 * 输出 992 就已经贴到上限，问题一宽就撞 `finish_reason=length` —— 上游对这种情况
 * 明确不重试（见 `isTruncated`），于是返回空正文 → `ai_empty_response` → 前端
 * 只看到「服务器开小差了」。这里把预算放宽，并允许 `AI_ASK_MAX_TOKENS` 覆盖。
 *
 * 注意：**不要**把这个变量名加进 `aiStatus()` 的 `envKeys`（`/api/site` 的 `ai`
 * 形状被 `scripts/check-golden.mjs` 冻着）。
 */
const ASK_MAX_TOKENS_DEFAULT = 3000;

/** 问答预算：环境变量优先，非法值退回默认。 */
function askMaxTokens(env) {
  const value = Number(env?.AI_ASK_MAX_TOKENS);
  return Number.isFinite(value) && value >= 200 ? Math.floor(value) : ASK_MAX_TOKENS_DEFAULT;
}

/**
 * 基于材料的问答。
 * @param {string} question
 * @param {Array<object>} docs 本次允许使用的材料
 * @param {{ scope?: 'document'|'corpus', charLimit?: number, chatOptions?: object }} [options]
 */
export async function answerQuestion(question, docs, options = {}) {
  const { scope = 'corpus', charLimit, chatOptions = {} } = options;
  const limit = charLimit ?? (scope === 'document' ? 16000 : 12000);
  const budget = askMaxTokens(chatOptions.env);
  // 单篇问答可以整篇喂（正文长才答得细）；全站问答每篇只留一段，靠命中处选取。
  const contentPerDoc = scope === 'document' ? 12000 : 1600;
  const focus = questionTerms(question);

  const ask = (list, cap, maxTokens) => {
    const material = buildMaterial(list, { charLimit: cap, withReplies: true, withContent: true, contentPerDoc, focus });
    return chatJson(
      [
        { role: 'system', content: ASK_SYSTEM },
        { role: 'user', content: renderAskUser({ scope, material: material.text, question: clampText(question, 500) }) },
      ],
      { temperature: 0.3, maxTokens, badJsonMessage: 'AI 返回的问答结果不是合法 JSON', ...chatOptions },
    ).then((result) => ({ ...result, material }));
  };

  let attempt;
  try {
    attempt = await ask(docs, limit, budget);
  } catch (error) {
    // 预算被烧光时上游不重试，但**材料少一半往往就答得完**：少喂几篇、预算翻倍再问一次。
    if (!isTruncated(error) || docs.length < 2) throw error;
    const half = docs.slice(0, Math.max(1, Math.ceil(docs.length / 2)));
    try {
      attempt = await ask(half, Math.max(4000, Math.floor(limit / 2)), Math.min(budget * 2, 8000));
    } catch (retryError) {
      // 两次都答不完：给一句用户看得懂的失败原因（前端对 `ai_*` 码会原样展示这句话）。
      if (isTruncated(retryError)) {
        throw new AiError(
          'ai_answer_truncated',
          '这次的资料太多，模型没能在预算内答完。把问题问得具体一点（或选中某一篇再问）会好很多。',
          retryError.details ?? error.details ?? {},
        );
      }
      throw retryError;
    }
  }

  const { parsed, model, usage, material } = attempt;
  const answer = normalizeAnswer(parsed, docs);
  return { answer, model, usage, truncated: material.truncated, included: material.included };
}

/**
 * 问题里的检索词：英文/数字串按 2 个字以上切，连续的汉字按 2 个字以上切。
 * 例：「想学习dfs，然后实现成代码」→ ['想学习', 'dfs', '然后实现成代码']
 * @param {string} question
 * @returns {string[]} 已去重、已转小写
 */
export function questionTerms(question) {
  return [...new Set(String(question ?? '').toLowerCase().match(/[a-z0-9_+#.]{2,}|[\u4e00-\u9fa5]{2,}/g) ?? [])];
}

/**
 * 汉字长词的「半截词」：整段汉字问句往往一个字都命中不了（「想学习」匹配不到「学习」），
 * 因此对 3 个字以上的连续汉字再切出 2 字片段，用低权重参与打分。
 */
function partialTerms(terms = []) {
  const grams = new Set();
  for (const term of terms) {
    if (!/^[\u4e00-\u9fa5]{3,}$/.test(term)) continue;
    for (let i = 0; i + 2 <= term.length; i += 1) grams.add(term.slice(i, i + 2));
  }
  for (const term of terms) grams.delete(term);
  return [...grams];
}

const HEADING_LINE = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/;
const BOLD_LINE = /^\s*\*\*([^*\n]{1,40})\*\*\s*$/;

/**
 * 一篇文档的小标题：Markdown 的 `#` 标题 + 整行加粗的「假标题」（wiki 正文里很常见）。
 * @param {string} text
 * @param {{ limit?: number }} [options]
 * @returns {string[]} 已转小写，最多 limit 条
 */
export function extractHeadings(text, { limit = 40 } = {}) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    const match = HEADING_LINE.exec(line) ?? BOLD_LINE.exec(line);
    if (!match) continue;
    const heading = String(match[1]).trim().toLowerCase();
    if (heading) out.push(heading);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 关键词检索打分：零依赖的中文/英文混合检索，用于在超预算时挑选最相关的文档。
 * 打分越高越相关；不修改传入对象。
 *
 * 权重刻意「标题 ≫ 小标题 > 标签/摘要/分类 > 正文 > 回复」：
 * 语料里 wiki 词条的正文动辄上万字，正文里的偶发命中几乎没有区分度。
 * @param {string} question
 * @param {Array<object>} docs
 * @returns {Array<{ doc: object, score: number, titleHit: number, headingHit: number, bodyHit: number }>} 已按分数降序排列
 */
export function rankDocuments(question, docs) {
  const terms = questionTerms(question);
  const partials = partialTerms(terms);
  const now = Date.now();
  const scored = (docs ?? []).map((doc) => {
    const title = String(doc.title ?? '').toLowerCase();
    const summary = String(doc.summary ?? '').toLowerCase();
    const category = String(doc.category ?? '').toLowerCase();
    const tags = (Array.isArray(doc.tags) ? doc.tags : []).join(' ').toLowerCase();
    const body = String(doc.content ?? '').toLowerCase();
    const replyText = (doc.replies ?? []).map((reply) => String(reply.content ?? '')).join(' ').toLowerCase();
    const headings = terms.length ? extractHeadings(doc.content ?? '').join(' \n ') : '';

    let score = 0;
    let titleHit = 0;
    let headingHit = 0;
    let bodyHit = 0;
    for (const term of terms) {
      if (title.includes(term)) {
        score += 20;
        titleHit += 1;
      }
      if (headings.includes(term)) {
        score += 9;
        headingHit += 1;
      }
      if (tags.includes(term)) score += 8;
      if (summary.includes(term)) score += 6;
      if (category.includes(term)) score += 5;
      if (body.includes(term)) {
        score += 2;
        bodyHit += 1;
      }
      if (replyText.includes(term)) score += 1;
    }
    // 半截词只用来把「学习」「代码」这类词排上来，权重压到不影响精确命中
    for (const gram of partials) {
      if (title.includes(gram)) score += 5;
      if (headings.includes(gram)) score += 3;
      if (body.includes(gram)) score += 1;
    }

    if (terms.length === 0) score += 1;
    score += Math.min(Number(doc.replyCount ?? doc.replies?.length ?? 0), 10) * 0.3;
    const age = Number(doc.updatedAt ?? doc.createdAt ?? now);
    score += Math.max(0, 6 - (now - age) / (7 * 24 * 3600 * 1000)) * 0.2;
    return { doc, score, titleHit, headingHit, bodyHit };
  });
  return scored.sort((a, b) => b.score - a.score || String(a.doc.id).localeCompare(String(b.doc.id)));
}

/**
 * 在字符预算内挑出该塞进上下文的文档。
 *
 * 分两档：**标题/小标题命中**的算强命中，正文偶然命中的算弱命中。
 * 有强命中时弱命中最多补 maxWeak 篇 —— 否则一句宽问题会把十几篇正文里
 * 恰好出现该词的文档拖进来，既慢又容易把答案预算烧光。
 * @param {string} question
 * @param {Array<object>} docs
 * @param {{ charBudget?: number, maxDocuments?: number, forceAll?: boolean, maxWeak?: number, contentPerDoc?: number }} [options]
 *   contentPerDoc：实际进材料的每篇正文字数（材料装配会按它截断，选材也得按它估体量，否则一篇长 wiki 就把预算吃光）
 */
export function selectForQuestion(
  question,
  docs,
  { charBudget = 11000, maxDocuments = 6, forceAll = false, maxWeak = 2, contentPerDoc = 1600 } = {},
) {
  const ranked = rankDocuments(question, docs);
  const strong = ranked.filter((item) => item.titleHit > 0 || item.headingHit > 0);
  const order = strong.length ? [...strong, ...ranked.filter((item) => item.titleHit === 0 && item.headingHit === 0)] : ranked;
  const weakCap = strong.length ? Math.max(0, Number(maxWeak) || 0) : maxDocuments;
  const picked = [];
  let used = 0;
  let weakUsed = 0;
  for (const item of order) {
    if (picked.length >= maxDocuments) break;
    const isWeak = strong.length > 0 && item.titleHit === 0 && item.headingHit === 0;
    if (isWeak && weakUsed >= weakCap) continue;
    const size =
      String(item.doc.title ?? '').length +
      Math.min(String(item.doc.content ?? '').length, contentPerDoc) +
      (item.doc.replies ?? []).reduce((sum, reply) => sum + String(reply.content ?? '').length, 0) +
      200;
    if (!forceAll && used + size > charBudget && picked.length > 0) break;
    picked.push(item.doc);
    used += size;
    if (isWeak) weakUsed += 1;
  }
  return {
    picked: picked.length ? picked : ranked.slice(0, 1).map((item) => item.doc),
    used,
    strong: strong.length,
    weak: weakUsed,
  };
}

