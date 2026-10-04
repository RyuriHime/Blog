/**
 * 打标签：把「种子主题词 / 文件自身关键词 / 目录域 / front matter 标签」合成每个文件的标签集，
 * 并建立一个倒排索引（标签 → 文件），供检索与知识网络使用。
 *
 * 可单独复用：
 *   import { assignTags, buildTagIndex } from './tags.mjs'
 */

/** 标签来源及其权重（决定排序，也写进产物里便于追溯）。 */
export const TAG_SOURCES = {
  seed: { weight: 3.0, label: '种子主题词' },
  keyword: { weight: 2.0, label: '文件关键词' },
  domain: { weight: 1.2, label: '目录域' },
  meta: { weight: 3.5, label: 'front matter' },
  title: { weight: 1.5, label: '标题词' },
};

export const CONFIDENCE_LEVELS = [
  { name: 'high', min: 0.34 },
  { name: 'medium', min: 0.16 },
  { name: 'low', min: 0.06 },
  { name: 'none', min: 0 },
];

export function confidenceOf(score) {
  for (const level of CONFIDENCE_LEVELS) {
    if (score >= level.min) return level.name;
  }
  return 'none';
}

/** 目录域标签：取文件所在目录名（不含根）作为弱标签。 */
function domainTags(path) {
  const parts = String(path ?? '').split('/');
  parts.pop();
  return parts.filter((part) => part && !/^\d+$/.test(part)).slice(-2);
}

/**
 * 给一篇文档分配标签。
 * @param {object} args
 * @param {object} args.doc              文档（含 path/title/frontMatter）
 * @param {Array<{term:string,score:number}>} args.seeds 种子关键词
 * @param {Array<{term:string,weight:number}>} args.keywords 该文件自身关键词
 * @param {{score:number, matched:Array<{term:string,weight:number}>}} args.relevance
 * @param {{ maxTags?: number, metadataKeys?: string[] }} [options]
 */
export function assignTags({ doc, seeds, keywords, relevance }, { maxTags = 8, metadataKeys = ['tags', 'keywords', 'topics'] } = {}) {
  const buckets = new Map();
  const add = (tag, source, score) => {
    const clean = String(tag ?? '').trim();
    if (!clean || clean.length > 40) return;
    const key = clean.toLowerCase();
    const entry = buckets.get(key) ?? { tag: clean, sources: new Set(), score: 0 };
    entry.sources.add(source);
    entry.score += score * (TAG_SOURCES[source]?.weight ?? 1);
    buckets.set(key, entry);
  };

  // front matter 里的显式标签优先级最高
  for (const key of metadataKeys) {
    const value = doc.frontMatter?.[key];
    if (Array.isArray(value)) for (const item of value) add(item, 'meta', 1);
    else if (typeof value === 'string' && value.trim()) {
      for (const item of value.split(/[,，;；\s]+/)) if (item.trim()) add(item, 'meta', 1);
    }
  }

  // 命中种子的词
  const seedTerms = new Set(seeds.map((item) => item.term));
  for (const item of relevance.matched ?? []) add(item.term, 'seed', item.weight + 0.5);
  for (const seed of seeds) {
    if (String(doc.title ?? '').toLowerCase().includes(seed.term)) add(seed.term, 'seed', seed.score);
  }

  // 文件自身关键词
  for (const item of keywords ?? []) add(item.term, 'keyword', item.weight);

  // 目录域
  for (const domain of domainTags(doc.path)) add(domain, 'domain', 1);

  const tags = [...buckets.values()]
    .map((entry) => ({
      tag: entry.tag,
      score: Number(entry.score.toFixed(4)),
      sources: [...entry.sources].sort(),
    }))
    .sort((a, b) => b.score - a.score || a.tag.localeCompare(b.tag))
    .slice(0, maxTags);

  return {
    tags,
    primaryTag: tags[0]?.tag ?? null,
    confidence: confidenceOf(relevance.score),
  };
}

/**
 * 标签 → 文件 倒排索引，并给出标签之间的共现关系（知识网络的第二层）。
 */
export function buildTagIndex(entries) {
  const index = new Map();
  for (const entry of entries) {
    for (const tag of entry.tags) {
      const node = index.get(tag.tag) ?? { tag: tag.tag, files: [], totalScore: 0, sources: new Set() };
      node.files.push(entry.id);
      node.totalScore += tag.score;
      for (const source of tag.sources) node.sources.add(source);
      index.set(tag.tag, node);
    }
  }

  const tags = [...index.values()]
    .map((node) => ({
      tag: node.tag,
      count: node.files.length,
      files: node.files.sort(),
      weight: Number(node.totalScore.toFixed(4)),
      sources: [...node.sources].sort(),
    }))
    .sort((a, b) => b.count - a.count || b.weight - a.weight || a.tag.localeCompare(b.tag));

  // 标签共现
  const cooccurrence = [];
  for (let i = 0; i < tags.length; i += 1) {
    for (let j = i + 1; j < tags.length; j += 1) {
      const shared = tags[i].files.filter((file) => tags[j].files.includes(file));
      if (shared.length === 0) continue;
      cooccurrence.push({
        from: tags[i].tag,
        to: tags[j].tag,
        count: shared.length,
        files: shared,
      });
    }
  }
  cooccurrence.sort((a, b) => b.count - a.count || a.from.localeCompare(b.from));

  return { tags, cooccurrence };
}

/**
 * 把「命中种子的文件」和「只是共享标签的文件」区分开：前者才是这篇文档真正相关的资料。
 */
export function selectRelated(entries, { minScore = 0.08, minMatched = 1 } = {}) {
  const related = [];
  const weak = [];
  for (const entry of entries) {
    if (entry.relevance.score >= minScore && entry.relevance.matchedCount >= minMatched) related.push(entry);
    else weak.push(entry);
  }
  related.sort((a, b) => b.relevance.score - a.relevance.score);
  weak.sort((a, b) => b.relevance.score - a.relevance.score);
  return { related, weak };
}
