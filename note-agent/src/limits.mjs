/**
 * 模型调用的预算与重试策略（四个入口共用，避免各处写各自的数字）。
 *
 * 真机验收实测（`deepseek-flash`，2026-10）：
 *   审查一篇 900 字的草稿 → `completion_tokens: 4000` 里 **4000 全是 reasoning_tokens**，
 *   正文是空的、`finish_reason: 'length'`；`forum-ai` 的 `chat()` 对空正文抛 `ai_empty_response`。
 *   调到 8000 时 reasoning 用掉 6108、正文 2513 字符、JSON 完整；
 *   同一段草稿 reasoning 的浮动范围实测 2481 ~ 10163 token。
 *
 * 结论：这类推理模型的思维链开销**远大于**正文，预算给少了不是"输出变短"，而是**一个字都没有**。
 * 所以预算按最坏情况给足，并且把「空正文」和「半个 JSON」当成同一类可重试失败。
 *
 * 另外 `forum-ai` 的超时是 `AI_TIMEOUT_MS`（默认 60 秒），而 16000 token 的一次调用实测
 * 要 33~44 秒 —— 草稿再长就会撞超时，所以这里单独给本包一个更宽的超时。
 */

/** 首轮/审查的预算。 */
export const MODEL_MAX_TOKENS = 16000;
/** 微调与自动追问的预算（输出是"最小改动"，比首轮小）。 */
export const TURN_MAX_TOKENS = 8000;
/** 重试时的预算上限；注意别超过模型的 max_output_tokens。 */
export const RETRY_MAX_TOKENS = 32000;
/** 本包自己传给 forum-ai 的超时（`chat()` 的 `options.timeoutMs` 优先于 `AI_TIMEOUT_MS`）。 */
export const MODEL_TIMEOUT_MS = 180000;
/** 重试时追加的收紧提示。 */
export const COMPACT_SUFFIX = '\n\n这次只输出 JSON，不要任何解释、前言或总结文字。';

/**
 * 这些错误码代表"这一次没拿到可用输出"，值得加预算重试一次：
 *   - `ai_empty_response`：思维链吃满预算，正文一个字都没有（真机最常见）
 *   - `ai_bad_json` / `ai_upstream_error` / `ai_unreachable`：上游偶发
 * 鉴权、限流、超时不在此列 —— 重试也是白花时间。
 */
export const RETRYABLE_CODES = ['ai_empty_response', 'ai_bad_json', 'ai_upstream_error', 'ai_unreachable'];

/** 解析结果是否可用。`extractJson` 失败返回的就是 `null`，而 `typeof null === 'object'`。 */
export function usable(value) {
  return value !== null && typeof value === 'object';
}

/** 上游是否因为预算用尽被截断（`forum-ai` 把原始响应留在 `raw` 里）。 */
export function wasTruncated(response) {
  const reason = response?.finishReason ?? response?.raw?.choices?.[0]?.finish_reason ?? response?.raw?.finishReason;
  return reason === 'length';
}

/** 预算用尽时的报错文案：要让用户知道"不是你的草稿有问题，是模型想太久了"。 */
export const TRUNCATED_MESSAGE = '模型这次思考得太长，没能把结果写完。内容太长时可以分小节处理，或再试一次。';
