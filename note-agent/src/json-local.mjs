/**
 * 兜底的 JSON 抠取：`forum-ai/src/parse.mjs` 里 `extractJson` 的**同款语义**实现。
 *
 * 为什么要单独一份、而不是在 ai-local 里带一个：
 *   `extractJson` 是安全边界（模型输出 → 结构化数据），它被 `src/json.mjs` 直接用。
 *   本包要在"没有 forum-ai"时也能跑，就需要这份实现与 `src/ai.mjs` 的兜底**并列**，
 *   互不 import，避免绕圈。两边的一致性由 `tests/test-ai-fallback.mjs` 用固定样本核对。
 *
 * 支持：```json 代码块、前后夹带说明文字、截取第一个平衡花括号块。
 * @param {string} text
 * @returns {object|null}
 */
export function extractJson(text) {
  const raw = String(text ?? '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;

  try {
    const direct = JSON.parse(candidate);
    if (direct && typeof direct === 'object') return direct;
  } catch {
    /* 继续尝试花括号截取 */
  }

  const start = candidate.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i += 1) {
    const char = candidate[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(candidate.slice(start, i + 1));
          return parsed && typeof parsed === 'object' ? parsed : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
