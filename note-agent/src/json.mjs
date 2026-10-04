/**
 * 模型输出的 JSON 解析（比 `forum-ai` 的版本多一层抢救）。
 *
 * 真机实测（deepseek-flash 跑 `/review`）：模型会把**未转义的双引号**直接写进字符串值里 ——
 * 它用中文引号时没问题，可一旦写成 `"二、积分"整节只有这一句话`，这段 JSON 在标准解析器
 * 眼里就坏了：花括号数量完全平衡、`finish_reason` 是 `stop`、文本一个不少，
 * 但 `JSON.parse` 抛 `SyntaxError`，用户看到的是"模型没有返回可解析的 JSON"。
 *
 * 所以这里在 `extractJson` 之后再试一次：扫描并修掉字符串内部的裸双引号，
 * 能把这份"本来完全可用"的结果救回来。仍然解析不出来才返回 null —— 铁律不变：
 * 宁可报错，绝不放行猜出来的内容。
 *
 * 第一层的 `extractJson` 走 `./ai.mjs` 的适配器：旁边有 `forum-ai` 就用它，
 * 没有就用 `./json-local.mjs` 的同款实现（这样"整个包拷走"时这一层不会断）。
 */
import { loadAi } from './ai.mjs';

/** 字符串值里允许出现的转义字符，其余裸反斜杠会被补成 `\\`。 */
const SIMPLE_ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u']);

/**
 * 从 `text` 里抠出一个 JSON 对象。
 *
 * @param {unknown} text 模型返回的原始文本
 * @returns {object|null}
 */
export function extractJsonTolerant(text) {
  const strict = loadAi().extractJson(text);
  // `extractJson` 对顶层数组也会返回（数组也是 `typeof 'object'`），
  // 但契约要求顶层是对象 —— 放过去只会让下游拿到 `parsed.findings === undefined` 而不报错。
  if (strict !== null && !Array.isArray(strict)) return strict;
  const raw = String(text ?? '').trim();
  if (raw.length === 0) return null;
  if (raw.startsWith('[')) return null;
  for (const candidate of candidates(raw)) {
    const repaired = repairObject(candidate);
    if (repaired === null) continue;
    try {
      const parsed = JSON.parse(repaired);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      /* 这个候选没救活，试下一个 */
    }
  }
  return null;
}

/** 依次尝试：去掉 ```json 围栏后的整体、以及第一个 `{` 到最后一个 `}` 的片段。 */
function* candidates(raw) {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const list = [];
  if (fenced) list.push(fenced[1].trim());
  list.push(raw);
  for (const text of list) {
    // 顶层是数组时不要从里面抠对象 —— 契约要求顶层是对象，
    // 而 `[{...}]` 里的第一个 `{` 是数组元素，抠出来会变成"成功"。
    if (text.trimStart().startsWith('[')) continue;
    yield text;
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    // 只有当这个 `{` 是一段**说明文字之后的**对象时才值得单独抠出来重试；
    // 直接以 `{` 开头的文本已经整段试过了，再抠一次只会把数组元素放进来。
    if (start > 0 && end > start) yield text.slice(start, end + 1);
  }
}

/**
 * 逐字符重写这个对象字面量，修掉字符串内部的裸双引号与非法转义。
 *
 * 判定"这个引号是字符串的结束还是内部裸引号"的规则：向后看，跳过空白后
 * 遇到 `:`、`,`、`}`、`]` 就说明它是结束引号，否则是内容里的裸引号，补上转义。
 *
 * @param {string} source
 * @returns {string|null} 修好的文本；结构明显不对（括号不平衡）时返回 null
 */
function repairObject(source) {
  const out = [];
  let inString = false;
  let depth = 0;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (!inString) {
      if (char === '{' || char === '[') depth += 1;
      else if (char === '}' || char === ']') depth -= 1;
      if (char === '"') inString = true;
      out.push(char);
      continue;
    }
    // 字符串内部
    if (char === '\\') {
      const next = source[i + 1];
      if (next !== undefined && SIMPLE_ESCAPES.has(next)) {
        out.push(char, next);
        i += 1;
      } else {
        out.push('\\\\');
      }
      continue;
    }
    if (char === '"') {
      if (isClosingQuote(source, i + 1)) {
        inString = false;
        out.push(char);
      } else {
        out.push('\\"');
      }
      continue;
    }
    if (char === '\n') out.push('\\n');
    else if (char === '\r') out.push('\\r');
    else if (char === '\t') out.push('\\t');
    else out.push(char);
  }
  if (inString || depth !== 0) return null;
  return out.join('');
}

/** 结束引号的判据：跳过空白后是 `:`、`,`、`}`、`]` 或文本结束。 */
function isClosingQuote(source, index) {
  let i = index;
  while (i < source.length && /\s/.test(source[i])) i += 1;
  if (i >= source.length) return true;
  return [':', ',', '}', ']'].includes(source[i]);
}
