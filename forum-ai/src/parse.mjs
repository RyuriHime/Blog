/**
 * 解析与归一化层：把模型的自由输出收敛成稳定的数据结构。
 *
 * 这里做三件宿主最关心的事：
 *   1) 容错解析（模型可能包 ```json、加解释文字、少个括号）；
 *   2) 字段归一化（长度限制、枚举校验、缺省值）；
 *   3) **幻觉过滤**：模型编造的文档编号一律按真实材料过滤掉。
 */
import { DIFFICULTIES } from './prompts.mjs';

const clampText = (value, max) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

const asStringArray = (value, max = 8, each = 60) =>
  (Array.isArray(value) ? value : [])
    .map((item) => clampText(typeof item === 'string' ? item : item?.name ?? item?.title, each))
    .filter(Boolean)
    .slice(0, max);

const oneOf = (value, allowed, fallback) => (allowed.includes(clampText(value, 8)) ? clampText(value, 8) : fallback);

/**
 * 从模型输出里抠出一个 JSON 对象。
 * 支持 ```json 代码块、前后夹带说明、以及截取第一个平衡花括号块。
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

/** 兼容 documentId / postId / id 三种写法。 */
const idOf = (value) => {
  const candidate = value?.documentId ?? value?.postId ?? value?.id;
  const num = Number(candidate);
  return Number.isInteger(num) && num > 0 ? num : null;
};

/** 站内 Wiki 词条的编号（文档编号，与帖子编号是两套序列）。 */
const wikiIdOf = (value) => {
  const candidate = value?.wikiId ?? value?.wikiDocumentId;
  const num = Number(candidate);
  return Number.isInteger(num) && num > 0 ? num : null;
};

/**
 * 单篇解读归一化。
 *
 * 关于 recommend 里的编号：**只留清单里真实存在的**。
 *   - `documentId` 必须落在本次给出的帖子清单（knownIds）里；
 *   - `wikiId` 必须落在本次给出的站内 Wiki 词条里（knownWikiIds）；
 *   - 两个都不成立的条目**直接丢掉** —— 模型自己编的《XX 指南》这类篇目名
 *     没有任何落点，留在结果里只会让读者点到一个不存在的页面。
 * 宿主没传某一组编号时（例如没接 wiki），那一组不做校验、按原样保留。
 *
 * @param {object} parsed 模型返回的对象
 * @param {object} doc 原始文档（用于兜底摘要）
 * @param {{ knownIds?: Iterable<string|number>, knownWikiIds?: Iterable<string|number> }} [options]
 */
export function normalizeReview(parsed, doc = {}, { knownIds = null, knownWikiIds = null } = {}) {
  const known = knownIds ? new Set([...knownIds].map(String)) : null;
  const knownWiki = knownWikiIds ? new Set([...knownWikiIds].map(String)) : null;
  const review = {
    category: clampText(parsed.category, 20) || '其他',
    difficulty: oneOf(parsed.difficulty, DIFFICULTIES, '进阶'),
    summary: clampText(parsed.summary, 200),
    tags: asStringArray(parsed.tags, 6, 24),
    prereq: (Array.isArray(parsed.prereq) ? parsed.prereq : [])
      .map((item) => ({
        name: clampText(typeof item === 'string' ? item : item?.name, 40),
        why: clampText(item?.why, 60),
        level: oneOf(item?.level, DIFFICULTIES, '入门'),
      }))
      .filter((item) => item.name)
      .slice(0, 4),
    recommend: (Array.isArray(parsed.recommend) ? parsed.recommend : [])
      .map((item) => {
        const id = idOf(item);
        const wikiId = wikiIdOf(item);
        const keepPost = id !== null && (!known || known.has(String(id)));
        const keepWiki = wikiId !== null && (!knownWiki || knownWiki.has(String(wikiId)));
        if (!keepPost && !keepWiki) return null;
        return {
          documentId: keepPost ? id : null,
          wikiId: keepWiki ? wikiId : null,
          title: clampText(item?.title, 80),
          reason: clampText(item?.reason, 60),
          relation: clampText(item?.relation, 8) || '延伸',
        };
      })
      .filter((item) => item && item.title)
      .slice(0, 4),
  };
  if (!review.summary) review.summary = clampText(doc.content ?? doc.text ?? '', 120);
  return review;
}

/**
 * 全库整理归一化：过滤掉编号不存在的内容。
 * @param {object} parsed
 * @param {Array<object>} docs 本次材料中的真实文档
 */
export function normalizeSiteReport(parsed, docs = []) {
  const validIds = new Set(docs.map((doc) => Number(doc.id)).filter(Number.isInteger));

  const topics = (Array.isArray(parsed.topics) ? parsed.topics : [])
    .map((topic, index) => ({
      name: clampText(topic?.name, 30),
      summary: clampText(topic?.summary, 120),
      difficulty: oneOf(topic?.difficulty, DIFFICULTIES, '进阶'),
      documentIds: (Array.isArray(topic?.documentIds ?? topic?.postIds) ? topic.documentIds ?? topic.postIds : [])
        .map(Number)
        .filter((id) => validIds.has(id))
        .slice(0, 30),
      prereq: asStringArray(topic?.prereq, 4, 40),
      order: Number.isFinite(Number(topic?.order)) ? Number(topic.order) : index + 1,
    }))
    .filter((topic) => topic.name && topic.documentIds.length > 0)
    .sort((a, b) => a.order - b.order)
    .slice(0, 6);

  const readingPath = (Array.isArray(parsed.readingPath) ? parsed.readingPath : [])
    .map((step) => ({
      documentId: idOf(step) ?? Number(step?.documentId ?? step?.postId),
      title: clampText(step?.title, 80),
      reason: clampText(step?.reason, 80),
      level: oneOf(step?.level, DIFFICULTIES, '入门'),
    }))
    .filter((step) => validIds.has(step.documentId))
    .slice(0, 10);

  return {
    summary: clampText(parsed.summary, 400),
    topics,
    readingPath,
    dropped: {
      topics: (Array.isArray(parsed.topics) ? parsed.topics.length : 0) - topics.length,
      readingPath: (Array.isArray(parsed.readingPath) ? parsed.readingPath.length : 0) - readingPath.length,
    },
  };
}

/**
 * 问答归一化：引用里编造的编号被丢弃。
 * @param {object} parsed
 * @param {Array<object>} docs
 */
export function normalizeAnswer(parsed, docs = []) {
  const validIds = new Set(docs.map((doc) => Number(doc.id)).filter(Number.isInteger));
  const citations = (Array.isArray(parsed.citations) ? parsed.citations : [])
    .map((item) => ({
      documentId: idOf(item),
      title: clampText(item?.title, 80),
      quote: clampText(item?.quote, 100),
    }))
    .filter((item) => validIds.has(item.documentId) && item.title)
    .slice(0, 8);

  return {
    text: clampText(parsed.answer, 4000),
    citations,
    notes: asStringArray(parsed.notes, 4, 120),
    confidence: oneOf(parsed.confidence, ['high', 'medium', 'low'], 'medium'),
    droppedCitations: (Array.isArray(parsed.citations) ? parsed.citations.length : 0) - citations.length,
  };
}
