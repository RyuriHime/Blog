/**
 * 文本处理：分词、停用词、轻量词干、中文 n-gram、TF-IDF。
 *
 * 零依赖、纯函数，可单独被人复用：
 *   import { tokenize, buildVectors, cosine } from './lib/text.mjs'
 *
 * 设计要点：
 * - 英文/数字：按非字母数字切分，转小写，去停用词，做保守的词干归一（只砍复数与常见后缀）；
 * - 中文：切出 2-gram 与 3-gram，这样不需要词典也能得到「知识图谱」这类短语；
 * - 所有打分都基于文档集合自身的统计，因此不需要外部词表。
 */

/* ------------------------------------------------------------------ */
/* 停用词                                                              */
/* ------------------------------------------------------------------ */

/** 英文停用词：只放真正的功能词，不放技术词（技术词是有效标签）。 */
export const STOPWORDS_EN = new Set(
  `a an the and or but if then else for while of to in on at by with from as is are was were be been being
   this that these those it its it's their there here what which who whom whose when where why how
   not no nor so than too very can could should would will shall may might must do does did done doing
   have has had having i you he she we they me him her us them my your his its our their
   about above after again against all am any because before below between both during each few
   further into more most other some such only own same s t just don now
   also use used using make makes made get gets got give gives given take takes taken
   one two three first second next last new old more less many much lot lots thing things`
    .split(/\s+/)
    .filter(Boolean),
);

/**
 * 中文停用词与「结构性噪声」：这些词在任何中文技术文档里都高频，做标签没有区分度。
 * 注意：这里刻意不包含「知识/图谱/数据/文件」等可能是主题词的词，避免把主题词砍掉。
 */
export const STOPWORDS_ZH = new Set(
  `的 了 和 与 或 及 等 是 在 有 我 你 他 她 它 们 这 那 哪 什么 怎么 如何 为什么
   一个 一些 一种 一样 这个 那个 这些 那些 我们 你们 他们 自己 可以 可能 应该 需要
   因为 所以 但是 而且 如果 虽然 然后 于是 因此 其中 以及 并且 或者 不过 只是 还是
   如果 因为 所以 但是 而且 如果 虽然 然后 于是 因此 其中 以及 并且 或者 不过 只是 还是
   这是 那是 这些 那些 这次 本次 有了 可以 一下 一个 一种
   已经 正在 将会 能够 必须 不要 不能 没有 就是 也是 都是 还有 另外 例如 比如 等等
   通过 关于 对于 由于 根据 按照 使用 进行 实现 提供 支持 包含 包括 主要 相关 相应
   以上 以下 之后 之前 同时 目前 当前 一般 通常 往往 尽量 尽量 直接 具体 简单 复杂
   东西 时候 情况 问题 方式 方法 内容 部分 方面 过程 结果 作用 意义 影响 目的 原因
   第一 第二 第三 首先 其次 最后 总之 综上 总结 如下 上述 下面 上面 本文 本章 本节
   一种 每个 各个 各种 多个 两个 三个 某些 某个 其它 其他 其余 任何 所有 全部 整个
   大 小 多 少 高 低 快 慢 好 坏 新 旧 长 短 前 后 左 右 上 下 里 外 中 间`
    .split(/\s+/)
    .filter(Boolean),
);

/* ------------------------------------------------------------------ */
/* 分词                                                                */
/* ------------------------------------------------------------------ */

const CJK = '\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff';
const TOKEN_RE = new RegExp(`[A-Za-z][A-Za-z0-9_+#]*|\\d+(?:\\.\\d+)?|[${CJK}]+`, 'g');

/** 保守词干：只处理复数与最常见的派生后缀，避免把 sql/go/css 这类短词砍坏。 */
export function stem(word) {
  let out = word;
  if (out.length > 4) {
    out = out
      .replace(/(?:ies)$/, 'y')
      .replace(/(?:sses)$/, 'ss')
      .replace(/(?:xes|ches|shes)$/, '')
      .replace(/(?<=[^s])s$/, '');
  }
  if (out.length > 5) {
    out = out.replace(/(?:ing|edly|ingly|ments|ment|ness|tion|ally)$/, '').replace(/(?:ed|ly)$/, '');
  }
  return out.length >= 2 ? out : word;
}

/** 中文片段 → 2-gram 与 3-gram（去重后返回）。 */
function cjkGrams(chunk) {
  const grams = new Set();
  const chars = [...chunk];
  for (let size = 2; size <= 3; size += 1) {
    for (let i = 0; i + size <= chars.length; i += 1) {
      const gram = chars.slice(i, i + size).join('');
      if (STOPWORDS_ZH.has(gram)) continue;
      // 纯数字/标点混入的 gram 直接丢
      if (!new RegExp(`[${CJK}]`).test(gram)) continue;
      grams.add(gram);
    }
  }
  return grams;
}

/**
 * 分词入口。
 * @param {string} text
 * @param {{ minLength?: number, maxTokens?: number }} [options]
 * @returns {string[]} 归一化后的词项（保留重复，便于统计词频）
 */
export function tokenize(text, { minLength = 2, maxTokens = 40000 } = {}) {
  const tokens = [];
  const source = String(text ?? '');
  for (const match of source.matchAll(TOKEN_RE)) {
    const raw = match[0];
    if (/^[A-Za-z]/.test(raw)) {
      const lowered = raw.toLowerCase().replace(/^[._-]+|[._-]+$/g, '');
      if (lowered.length < minLength || STOPWORDS_EN.has(lowered)) continue;
      tokens.push(stem(lowered));
    } else if (/^\d/.test(raw)) {
      if (raw.length >= 2) tokens.push(raw);
    } else {
      for (const gram of cjkGrams(raw)) tokens.push(gram);
    }
    if (tokens.length >= maxTokens) break;
  }
  return tokens;
}

/** 词频表。 */
export function termFrequencies(tokens) {
  const tf = new Map();
  for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
  return tf;
}

/* ------------------------------------------------------------------ */
/* TF-IDF                                                             */
/* ------------------------------------------------------------------ */

/**
 * 对一组文档建立 TF-IDF 向量。
 * @param {Array<{ id: string, text: string, title?: string }>} docs
 * @returns {{ vectors: Map<string, Map<string, number>>, idf: Map<string, number>, df: Map<string, number>, docCount: number }}
 */
export function buildVectors(docs, { minLength = 2 } = {}) {
  const tfMaps = new Map();
  const df = new Map();

  for (const doc of docs) {
    const tokens = tokenize(`${doc.title ?? ''} ${doc.title ?? ''} ${doc.text ?? ''}`, { minLength });
    const tf = termFrequencies(tokens);
    tfMaps.set(doc.id, tf);
    for (const token of tf.keys()) df.set(token, (df.get(token) ?? 0) + 1);
  }

  const docCount = docs.length || 1;
  const idf = new Map();
  for (const [token, count] of df) idf.set(token, Math.log((docCount + 1) / (count + 1)) + 1);

  // 亚线性 TF：1 + log(tf)，避免长文档靠堆词频取胜
  const vectors = new Map();
  for (const [id, tf] of tfMaps) {
    const vector = new Map();
    let sumSquares = 0;
    for (const [token, count] of tf) {
      const weight = (1 + Math.log(count)) * (idf.get(token) ?? 1);
      vector.set(token, weight);
      sumSquares += weight * weight;
    }
    const norm = Math.sqrt(sumSquares) || 1;
    for (const [token, weight] of vector) vector.set(token, weight / norm);
    vectors.set(id, vector);
  }

  return { vectors, idf, df, docCount };
}

/** 两个已归一化向量的余弦相似度。 */
export function cosine(a, b) {
  if (!a || !b || a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [token, weight] of small) {
    const other = large.get(token);
    if (other) dot += weight * other;
  }
  return dot;
}

/** 找出两个向量的公共词项（按两边权重乘积降序）。 */
export function sharedTerms(a, b, limit = 0) {
  if (!a || !b) return [];
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  const shared = [];
  for (const [token, weight] of small) {
    const other = large.get(token);
    if (other) shared.push({ term: token, weight: weight * other });
  }
  shared.sort((x, y) => y.weight - x.weight);
  return limit > 0 ? shared.slice(0, limit) : shared;
}
