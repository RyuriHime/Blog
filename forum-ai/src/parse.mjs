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
 * 把 JSON **字符串里面**的裸控制字符转义掉。
 *
 * 模型写代码块时经常直接在 JSON 字符串里换行（而不是写成 `\n`），这在 JSON 规范里是非法字符，
 * `JSON.parse` 直接报错 —— 但它想表达的就是换行。这里按字面意思转义，而不是把整段判成坏 JSON。
 * 已经是合法转义（`\n`、`\t`、`\"`）的部分原样保留。
 * @param {string} text
 * @returns {string}
 */
export function repairJsonControlChars(text) {
  const raw = String(text ?? '');
  let out = '';
  let inString = false;
  let escaped = false;
  for (const char of raw) {
    if (inString) {
      if (escaped) {
        out += char;
        escaped = false;
        continue;
      }
      if (char === '\\') {
        out += char;
        escaped = true;
        continue;
      }
      if (char === '"') {
        out += char;
        inString = false;
        continue;
      }
      const code = char.charCodeAt(0);
      if (code < 0x20) {
        out += char === '\n' ? '\\n' : char === '\r' ? '\\r' : char === '\t' ? '\\t' : `\\u${code.toString(16).padStart(4, '0')}`;
        continue;
      }
      out += char;
      continue;
    }
    if (char === '"') inString = true;
    out += char;
  }
  return out;
}

/**
 * 把 JSON 字符串里**没转义的双引号**补上转义 —— 模型写代码时的另一种常见坏法：
 * `{"answer":"print("hi")"}` 这种，`JSON.parse` 一样直接报错。
 *
 * 怎么判断一个 `"` 是「字符串结束」还是「内容里的孤引号」：看它后面第一个非空白字符，
 * 只有 `,` `:` `}` `]` 或者到头了才算结束，否则当成内容里的引号转义掉。
 * 这是个有损的启发式，所以只在别的办法都解析不出来时才用（见 `extractJson`）。
 * @param {string} text
 * @returns {string}
 */
export function repairJsonQuotes(text) {
  const raw = String(text ?? '');
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if (escaped) {
      out += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      out += char;
      escaped = true;
      continue;
    }
    if (char !== '"') {
      out += char;
      continue;
    }
    if (!inString) {
      inString = true;
      out += char;
      continue;
    }
    const next = raw.slice(i + 1).match(/\S/)?.[0] ?? '';
    if (next === '' || next === ',' || next === ':' || next === '}' || next === ']') {
      inString = false;
      out += char;
      continue;
    }
    out += '\\"';
  }
  return out;
}

/** 从 `{` 开始按花括号配平截一个对象出来（字符串里的花括号不算）。 */
function sliceJsonObject(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
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
          const parsed = JSON.parse(text.slice(start, i + 1));
          return parsed && typeof parsed === 'object' ? parsed : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * 从模型输出里抠出一个 JSON 对象。
 * 支持整段 ```json 代码块包裹、前后夹带说明、以及截取第一个平衡花括号块；
 * 整段解析不了时再试两次修补版本：先转义字符串里的裸控制字符（`repairJsonControlChars`），
 * 再把没转义的孤引号补上（`repairJsonQuotes`）。
 * @returns {object|null}
 */
export function extractJson(text) {
  const raw = String(text ?? '').trim();
  // 只有「整段就是 ```json … ``` 」才算代码块包裹：答案自己带的 ```python 片段不能当外壳切
  const fenced = raw.match(/^\s*```(?:json)?\s*([\s\S]*)\s*```\s*$/i);
  const candidates = fenced ? [fenced[1].trim(), raw] : [raw];

  for (const candidate of candidates) {
    const withControlChars = repairJsonControlChars(candidate);
    for (const attempt of [candidate, withControlChars, repairJsonQuotes(withControlChars)]) {
      try {
        const direct = JSON.parse(attempt);
        if (direct && typeof direct === 'object') return direct;
      } catch {
        /* 继续尝试花括号截取 */
      }
      const sliced = sliceJsonObject(attempt);
      if (sliced) return sliced;
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
