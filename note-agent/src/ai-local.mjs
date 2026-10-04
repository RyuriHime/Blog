/**
 * 兜底的 AI 客户端：当 `forum-ai/` 不在旁边时用它，保证这个包**单独拷走也能跑**。
 *
 * 三种用法（真实实现 / 兜底实现）的**边界与错误码完全一致**，所以上层（orchestrator / review）
 * 不需要知道自己在跟谁说话：
 *   - `aiConfig(env)`    读 AI_BASE_URL / AI_API_KEY / AI_MODEL / AI_TIMEOUT_MS / AI_MAX_TOKENS，字段与 forum-ai 逐字一致；
 *   - `chat(...)`        打 `POST {baseUrl}/chat/completions`，返回 `{ text, model, usage:{prompt,completion}, raw }`，
 *                        错误码沿用 `ai_not_configured` / `ai_timeout` / `ai_unreachable` / `ai_unauthorized` /
 *                        `ai_rate_limited` / `ai_upstream_error` / `ai_bad_response` / `ai_empty_response`；
 *   - `extractJson`      是 `parse.mjs` 的**原文拷贝**，不是重写 —— JSON 解析是安全边界，版本一旦分叉就会出玄学。
 *
 * 选它还是选 forum-ai 由 `src/ai.mjs` 决定，业务代码只 import 那一个。
 */

/** 与 forum-ai 同款：带稳定 code 的错误类型，宿主据此映射 HTTP 状态码。 */
export class AiError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AiError';
    this.code = code;
    this.details = details;
  }
}

const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';
const DEFAULT_MODEL = 'deepseek-chat';
const NOT_CONFIGURED_MESSAGE =
  'AI 未配置：请在启动服务前设置环境变量 AI_API_KEY（可选 AI_BASE_URL / AI_MODEL），例如 AI_API_KEY=sk-xxx node server.js';

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

/** 对外只暴露状态，不回传密钥本身。 */
export function aiStatus(env = process.env) {
  const { configured, model, baseUrl } = aiConfig(env);
  return {
    configured,
    model: configured ? model : null,
    baseUrl: configured ? baseUrl : null,
    timeoutMs: configured ? aiConfig(env).timeoutMs : null,
  };
}

function ensureConfigured(env) {
  const config = aiConfig(env);
  if (!config.configured) throw new AiError('ai_not_configured', NOT_CONFIGURED_MESSAGE);
  return config;
}

/**
 * 调一次 OpenAI 兼容的 chat completion。
 * @param {Array<{role:string,content:string}>} messages
 * @param {{ temperature?:number, maxTokens?:number, json?:boolean, fetchImpl?:Function,
 *           signal?:AbortSignal, env?:object, timeoutMs?:number }} [options]
 * @returns {Promise<{ text:string, model:string, usage:{prompt:number,completion:number}, raw:any }>}
 */
export async function chat(messages, options = {}) {
  const { temperature = 0.2, maxTokens, json = true, fetchImpl = fetch, signal, env = process.env } = options;
  const config = ensureConfigured(env);
  // 调用方（limits.mjs 的 MODEL_TIMEOUT_MS）优先于环境变量 —— 推理模型的思维链很慢，
  // 这个包自己会把超时开到 180s，不能被 AI_TIMEOUT_MS 的默认 60s 顶掉。
  const timeoutMs = Number(options.timeoutMs ?? config.timeoutMs);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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
      throw new AiError('ai_timeout', `AI 接口超时（${timeoutMs}ms），可调大 AI_TIMEOUT_MS 后重试`);
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

  // 推理模型（deepseek-flash 这类）的思维链会计入 completion_tokens：
  // 预算被思维链吃光时正文就是空串，必须当成可重试失败，而不是"模型没话说"。
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

export const NOT_CONFIGURED_MESSAGE_TEXT = NOT_CONFIGURED_MESSAGE;

/**
 * 顺带把兜底 JSON 抠取转出去：`src/ai.mjs` 会把 `chat` 与 `extractJson` 一起交付给上层，
 * 所以两套实现都从这里取，调用方不必知道文件怎么分的。
 */
export { extractJson } from './json-local.mjs';
