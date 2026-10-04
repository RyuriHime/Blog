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
 */
import {
  ANALYZE_SYSTEM,
  SITE_SYSTEM,
  ASK_SYSTEM,
  NOT_CONFIGURED_MESSAGE,
  renderAnalyzeUser,
  renderSiteUser,
  renderAskUser,
  renderSiblingList,
} from './prompts.mjs';
import { extractJson, normalizeReview, normalizeSiteReport, normalizeAnswer } from './parse.mjs';
import { buildMaterial, clampText } from './material.mjs';

export { extractJson } from './parse.mjs';
export { buildMaterial, buildContext, clampText } from './material.mjs';
export {
  ANALYZE_SYSTEM,
  SITE_SYSTEM,
  ASK_SYSTEM,
  NOT_CONFIGURED_MESSAGE,
} from './prompts.mjs';

const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';
const DEFAULT_MODEL = 'deepseek-chat';

/** 统一的错误类型：带稳定的 code，便于宿主映射成自己的 HTTP 状态码。 */
export class AiError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AiError';
    this.code = code;
    this.details = details;
  }
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
    configured: Boolean(apiKey),
  };
}

/** 对外暴露的状态：永远不回传密钥本身。 */
export function aiStatus(env = process.env) {
  const { configured, model, baseUrl } = aiConfig(env);
  return {
    configured,
    model: configured ? model : null,
    baseUrl: configured ? baseUrl : null,
    envKeys: ['AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL', 'AI_TIMEOUT_MS', 'AI_MAX_TOKENS'],
  };
}

function ensureConfigured(env) {
  const config = aiConfig(env);
  if (!config.configured) throw new AiError('ai_not_configured', NOT_CONFIGURED_MESSAGE);
  return config;
}

/**
 * 调用一次 OpenAI 兼容的 chat completion。
 * @param {Array<{role:string,content:string}>} messages
 * @param {{ temperature?: number, maxTokens?: number, json?: boolean, fetchImpl?: Function,
 *           signal?: AbortSignal, env?: object }} [options]
 * @returns {Promise<{ text:string, model:string, usage:{prompt:number,completion:number}, raw:any }>}
 */
export async function chat(messages, options = {}) {
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
    throw new AiError('ai_empty_response', 'AI 接口没有返回内容');
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

/**
 * 单篇解读。
 *
 * recommend 里的编号会按「本次材料里真实存在的文档」校验：
 * 存在的保留编号（宿主可渲染成内链），不存在的清成 null 并标 `external: true`
 * （宿主只显示标题，避免把编造的编号当成站内链接）。
 *
 * @param {object} doc 文档：{ id, title, content, board?, author?, tags?, replies? }
 * @param {Array<object>} [siblings] 可推荐的其它文档（只要 id/title/summary 即可）
 * @param {{ charLimit?: number, chatOptions?: object }} [options]
 * @returns {Promise<{ review: object, model: string, usage: object }>}
 */
export async function reviewDocument(doc, siblings = [], options = {}) {
  const { charLimit = 12000, chatOptions = {} } = options;
  const material = buildMaterial([doc], { charLimit, withReplies: true, withContent: true });
  const { text, model, usage } = await chat(
    [
      { role: 'system', content: ANALYZE_SYSTEM },
      { role: 'user', content: renderAnalyzeUser({ material: material.text, siblings: renderSiblingList(siblings, doc.id) }) },
    ],
    { temperature: 0.2, ...chatOptions },
  );

  const parsed = extractJson(text);
  if (!parsed || typeof parsed !== 'object') throw new AiError('ai_bad_json', 'AI 返回的解读结果不是合法 JSON');

  const knownIds = new Set([doc.id, ...siblings.map((item) => item.id)].map(String));
  const review = normalizeReview(parsed, doc, { knownIds });
  return { review, model, usage, truncated: material.truncated };
}

/**
 * 全库整理：主题分组 + 阅读路线。
 * @param {Array<object>} docs
 * @param {{ charLimit?: number, chatOptions?: object }} [options]
 */
export async function reviewCorpus(docs, options = {}) {
  const { charLimit = 60000, chatOptions = {} } = options;
  const material = buildMaterial(docs, { charLimit, withReplies: true, withContent: true });
  const { text, model, usage } = await chat(
    [
      { role: 'system', content: SITE_SYSTEM },
      { role: 'user', content: renderSiteUser({ count: docs.length, material: material.text }) },
    ],
    { temperature: 0.2, maxTokens: 3000, ...chatOptions },
  );

  const parsed = extractJson(text);
  if (!parsed || typeof parsed !== 'object') throw new AiError('ai_bad_json', 'AI 返回的整理结果不是合法 JSON');
  const report = normalizeSiteReport(parsed, docs);
  return { report, model, usage, truncated: material.truncated };
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
    charLimit: charLimit ?? (scope === 'document' ? 16000 : 48000),
    withReplies: true,
    withContent: true,
  });
  const { text, model, usage } = await chat(
    [
      { role: 'system', content: ASK_SYSTEM },
      { role: 'user', content: renderAskUser({ scope, material: material.text, question: clampText(question, 500) }) },
    ],
    { temperature: 0.3, maxTokens: 1200, ...chatOptions },
  );

  const parsed = extractJson(text);
  if (!parsed || typeof parsed !== 'object') throw new AiError('ai_bad_json', 'AI 返回的问答结果不是合法 JSON');
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
export function selectForQuestion(question, docs, { charBudget = 40000, maxDocuments = 14, forceAll = false } = {}) {
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
