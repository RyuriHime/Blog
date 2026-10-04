/**
 * 关键词与相关度：
 *   1) 用 TF-IDF 给每篇文档取出「自身关键词」；
 *   2) 从种子文档取出「种子关键词」，即这篇文档的主题词；
 *   3) 计算每个文件相对种子文档的相关度（关键词重叠 + 向量余弦的加权融合）。
 *
 * 可单独复用：
 *   import { extractKeywords, relevanceToSeed } from './keywords.mjs'
 */
import { buildVectors, cosine, sharedTerms } from './text.mjs';

const number = (value, digits = 4) => Number(Number(value ?? 0).toFixed(digits));

/** 只出现在极少数文档里的词多为拼写噪声或专有名词，默认丢掉。 */
export const DEFAULT_MIN_DF = 2;

/** 文档出现在超过这个比例的文档里时，区分度不足，不适合当关键词。 */
export const DEFAULT_MAX_DF_RATIO = 0.5;

/**
 * 中文 n-gram 会产生大量「子串碎片」（例如「零依赖全栈」会切出 依赖/赖全/全栈/依赖全/赖全栈…）。
 * 这里做词汇压缩：只保留那些「没有被某个只多一个字的更优 gram 覆盖」的词项，
 * 让关键词变成「依赖 / 全栈 / 零依赖」这类可读的词，而不是碎片。
 */
export function compactCandidates(candidates, { margin = 1.08 } = {}) {
  const list = candidates.filter((item) => item.value > 0);
  const byTerm = new Map(list.map((item) => [item.term, item]));
  // 长的先处理：长 gram 永远比它的子串更具体
  const ordered = [...list].sort((a, b) => b.term.length - a.term.length || b.value - a.value);

  const keeper = new Map();
  for (const item of ordered) {
    const chars = [...item.term];
    let suppressed = false;
    for (let size = item.term.length + 1; size <= item.term.length + 2; size += 1) {
      for (let start = 0; start + size <= chars.length + 2; start += 1) {
        const supergram = chars.slice(Math.max(0, start - 1), Math.max(0, start - 1) + size).join('');
        if (supergram.length <= item.term.length) continue;
        if (!supergram.includes(item.term)) continue;
        const parent = keeper.get(supergram) ?? byTerm.get(supergram);
        if (parent && parent.value >= item.value * margin) {
          suppressed = true;
          break;
        }
      }
      if (suppressed) break;
    }
    if (!suppressed) keeper.set(item.term, item);
  }
  return [...keeper.values()];
}

/**
 * @param {Array<{id:string,title?:string,text?:string}>} docs
 * @param {{ topPerDoc?: number, minDf?: number, maxDfRatio?: number, compact?: boolean,
 *           longTermMinDf?: number, longTermPenalty?: number }} [options]
 */
export function extractKeywords(
  docs,
  {
    topPerDoc = 12,
    minDf = DEFAULT_MIN_DF,
    maxDfRatio = DEFAULT_MAX_DF_RATIO,
    compact = true,
    longTermMinDf = 2,
    longTermPenalty = 0.35,
  } = {},
) {
  const { vectors, idf, df, docCount } = buildVectors(docs);

  // 全库范围内的区分度过滤：太罕见 / 太普遍都不算关键词
  const keep = (token) => {
    const freq = df.get(token) ?? 0;
    if (docCount > 2 && freq < minDf) return false;
    if (freq / docCount > maxDfRatio && docCount > 3) return false;
    return true;
  };

  /**
   * 中文 3-gram 及以上如果只在一篇文档里出现过，很可能是把相邻词切碎后的碎片
   * （例如「会不会 / 会影响 / 切换的」）。这类词降权而不是丢弃，
   * 因为语料很小时真正的术语也可能只出现一次。
   */
  const lengthPenalty = (token) => {
    const isCjk = /^[\u3400-\u9fff]+$/.test(token);
    if (!isCjk) return 1;
    if ([...token].length < 3) return 1;
    return (df.get(token) ?? 0) < longTermMinDf ? longTermPenalty : 1;
  };

  const perDoc = new Map();
  const globalScores = new Map();

  for (const doc of docs) {
    const vector = vectors.get(doc.id) ?? new Map();
    const candidates = [...vector.entries()]
      .filter(([token]) => keep(token))
      .map(([term, weight]) => ({
        term,
        weight: number(weight * lengthPenalty(term), 6),
        idf: number(idf.get(term) ?? 1, 6),
        df: df.get(term) ?? 0,
      }));

    const chosen = compact
      ? compactCandidates(candidates.map((item) => ({ ...item, value: item.weight })))
          .sort((a, b) => b.weight - a.weight || a.term.localeCompare(b.term))
          .slice(0, topPerDoc)
          .map(({ value, ...rest }) => rest)
      : candidates.sort((a, b) => b.weight - a.weight).slice(0, topPerDoc);

    perDoc.set(doc.id, chosen);
    for (const item of chosen) globalScores.set(item.term, (globalScores.get(item.term) ?? 0) + item.weight);
  }

  const global = [...globalScores.entries()]
    .map(([term, weight]) => ({ term, weight: number(weight, 6), df: df.get(term) ?? 0 }))
    .sort((a, b) => b.weight - a.weight || a.term.localeCompare(b.term));

  return { perDoc, global, vectors, idf, df, docCount };
}

/** 粗略词频（用于报告展示，不必精确）。 */
function countIn(text, term) {
  if (!term) return 0;
  if (/^[\u3400-\u9fff]+$/.test(term)) {
    let count = 0;
    let index = text.indexOf(term);
    while (index !== -1) {
      count += 1;
      index = text.indexOf(term, index + term.length);
    }
    return count;
  }
  const matches = text.toLowerCase().match(new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g'));
  return matches ? matches.length : 0;
}

/**
 * 词表质量评估：中文 n-gram 难免切出碎片，这里给出一个可量化的「碎片率」，
 * 用来判断这次抽取是否可信（0 最好，越接近 1 说明关键词越碎）。
 * 判据：拉丁词与中文 2-gram 视为干净；中文 3-gram 及以上只有被反复使用（df/N 较高）才算干净。
 */
export function vocabularyQuality(terms, { minDfForLong = 3 } = {}) {
  const items = terms
    .map((item) => (typeof item === 'string' ? { term: item, df: minDfForLong } : item))
    .filter((item) => item?.term);
  if (items.length === 0) return { total: 0, clean: 0, noisy: 0, noiseRatio: 0, noisyTerms: [] };

  const isNoisy = (item) => {
    const term = String(item.term);
    // 纯数字（编号、章节号）没有语义价值
    if (/^\d+$/.test(term)) return true;
    const isCjk = /^[\u3400-\u9fff]+$/.test(term);
    if (!isCjk) return false;
    if ([...term].length === 2) return false;
    return (item.df ?? 0) < minDfForLong;
  };

  const noisyTerms = items.filter(isNoisy).map((item) => item.term);
  return {
    total: items.length,
    clean: items.length - noisyTerms.length,
    noisy: noisyTerms.length,
    noiseRatio: number(noisyTerms.length / items.length, 4),
    noisyTerms: noisyTerms.slice(0, 20),
  };
}

/**
 * 种子文档的关键词：优先用文档内 TF-IDF 排名（已做过词汇压缩），
 * 再叠加「标题命中」与「front matter 标签」的加权。
 * @param {{id:string,title?:string,text?:string,frontMatter?:object}} seedDoc
 * @param {ReturnType<typeof extractKeywords>} model
 */
export function seedKeywords(seedDoc, model, { top = 12, titleBoost = 1.6, tagBoost = 1.4 } = {}) {
  const vector = model.vectors.get(seedDoc.id) ?? new Map();
  const ranked = model.perDoc.get(seedDoc.id) ?? [];
  const tagged = new Set(
    ['tags', 'keywords', 'topics']
      .flatMap((key) => (Array.isArray(seedDoc.frontMatter?.[key]) ? seedDoc.frontMatter[key] : []))
      .map((item) => String(item).trim())
      .filter(Boolean),
  );

  return ranked
    .map((item) => {
      const inTitle = String(seedDoc.title ?? '').includes(item.term);
      const inTags = tagged.has(item.term);
      return {
        term: item.term,
        weight: number(item.weight, 6),
        idf: number(model.idf.get(item.term) ?? 1, 6),
        df: model.df.get(item.term) ?? 0,
        inTitle,
        inTags,
        score: number(item.weight * (inTitle ? titleBoost : 1) * (inTags ? tagBoost : 1)),
      };
    })
    .sort((a, b) => b.score - a.score || a.term.localeCompare(b.term))
    .slice(0, top);
}

/**
 * 计算一篇文档相对种子关键词集的相关度。
 * @param {{id:string}} doc
 * @param {ReturnType<typeof extractKeywords>} model
 * @param {Array<{term:string, score:number}>} seeds
 * @param {string} seedId
 * @param {{ keywordWeight?: number, cosineWeight?: number, matchedLimit?: number }} [options]
 * @returns {{ score:number, keywordScore:number, cosineScore:number, matched:Array<{term:string,weight:number}>, matchedCount:number }}
 */
export function relevanceToSeed(doc, model, seeds, seedId, { keywordWeight = 0.65, cosineWeight = 0.35, matchedLimit = 12 } = {}) {
  const seedVector = model.vectors.get(seedId) ?? new Map();
  const vector = model.vectors.get(doc.id) ?? new Map();
  const seedTerms = seeds.map((item) => item.term);

  const matched = seedTerms
    .map((term) => ({ term, weight: number(vector.get(term) ?? 0) }))
    .filter((item) => item.weight > 0)
    .sort((a, b) => b.weight - a.weight);

  const seedWeightSum = seedTerms.reduce((sum, term) => sum + (seedVector.get(term) ?? 0), 0) || 1;
  const matchedWeightSum = matched.reduce((sum, item) => sum + item.weight, 0);

  const keywordScore = number(matchedWeightSum / seedWeightSum);
  const cosineScore = number(cosine(seedVector, vector));
  const score = number(keywordScore * keywordWeight + cosineScore * cosineWeight);

  return {
    score,
    keywordScore,
    cosineScore,
    matched: matched.slice(0, matchedLimit),
    matchedCount: matched.length,
  };
}

/** 文档两两相似度（只保留高于阈值的对，避免 O(n²) 结果爆炸）。 */
export function pairwiseSimilarity(docs, model, { threshold = 0.12, limitPerDoc = 12 } = {}) {
  const edges = [];
  const vectors = docs.map((doc) => ({ id: doc.id, vector: model.vectors.get(doc.id) ?? new Map() }));

  for (let i = 0; i < vectors.length; i += 1) {
    const perDoc = [];
    for (let j = i + 1; j < vectors.length; j += 1) {
      const similarity = cosine(vectors[i].vector, vectors[j].vector);
      if (similarity < threshold) continue;
      perDoc.push({ from: vectors[i].id, to: vectors[j].id, similarity: number(similarity) });
    }
    perDoc.sort((a, b) => b.similarity - a.similarity);
    edges.push(...perDoc.slice(0, limitPerDoc));
  }

  return edges;
}

/** 公共词项（用于解释一条边的成因）。 */
export function explainEdge(model, fromId, toId, limit = 6) {
  return sharedTerms(model.vectors.get(fromId), model.vectors.get(toId), limit).map((item) => ({
    term: item.term,
    weight: number(item.weight, 6),
  }));
}
