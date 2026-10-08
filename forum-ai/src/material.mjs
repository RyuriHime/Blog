/**
 * 材料装配层：把文档对象拼成提示词里的文本材料，并在字符预算内截断。
 *
 * 这里刻意不依赖任何存储：宿主把文档查出来传进来即可，
 * 因此同一套 AI 层既能用在 SQLite 站点，也能用在内存数据或 ES 检索结果上。
 */

export const clampText = (value, max) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/** 把正文压成一行（和 clampText 一样的折叠规则），供「围着命中词截取」算偏移用。 */
const flatten = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

/**
 * 取一段「围着命中词」的正文。
 *
 * 纯 clampText 是从头截 max 个字，而 wiki 词条的命中段落常常在 3000 字之后 ——
 * 结果就是「检索命中了，但模型看不到」。命中词不在开头时，从它前面留 lead 个字开始截。
 * @param {string} value
 * @param {string[]} focus 小写关键词（questionTerms 的产物）
 * @param {number} max 截取长度
 * @param {{ lead?: number }} [options]
 */
export function excerptAroundFocus(value, focus = [], max = 3000, { lead = 240 } = {}) {
  const flat = flatten(value);
  const size = Math.max(1, Number(max) || 1);
  if (flat.length <= size) return flat;
  // lead 不能大过窗口，否则命中词会落在截出来的那段之外（小 max 时尤其明显）
  const back = Math.max(0, Math.min(Number(lead) || 0, Math.floor(size / 3)));
  const haystack = flat.toLowerCase();
  let at = -1;
  for (const term of focus ?? []) {
    const key = String(term ?? '').toLowerCase();
    if (key.length < 2) continue;
    const hit = haystack.indexOf(key);
    if (hit >= 0 && (at < 0 || hit < at)) at = hit;
  }
  if (at <= back) return flat.slice(0, size);
  const start = at - back;
  const end = Math.min(flat.length, start + size);
  return `…${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

/**
 * 材料里额外报一下「命中词出现在哪几个小标题里」。
 * 模型看到 `相关小节：DFS 实现` 就知道正文里有这块，比只给一段正文更有方向。
 * @param {string} value 正文
 * @param {string[]} focus 小写关键词
 * @param {{ limit?: number, headingChars?: number }} [options]
 */
export function focusHeadings(value, focus = [], { limit = 4, headingChars = 40 } = {}) {
  const terms = (focus ?? []).map((term) => String(term ?? '').toLowerCase()).filter((term) => term.length >= 2);
  if (terms.length === 0) return [];
  const out = [];
  for (const line of String(value ?? '').split('\n')) {
    const match = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line) ?? /^\s*\*\*([^*\n]{1,40})\*\*\s*$/.exec(line);
    if (!match) continue;
    const text = match[1].trim();
    const lower = text.toLowerCase();
    if (terms.some((term) => lower.includes(term))) {
      out.push(clampText(text, headingChars));
      if (out.length >= limit) break;
    }
  }
  return out;
}


/**
 * 把一批文档拼成材料文本。
 * @param {Array<object>} docs 文档：{ id, title, content, board?, author?, tags?, category?, difficulty?, summary?, replies? }
 * @param {{ charLimit?: number, withReplies?: boolean, withContent?: boolean, contentPerDoc?: number, replyPerDoc?: number, focus?: string[] }} [options]
 *   focus：问题里的关键词（`questionTerms` 的产物）。给了它就从命中处截正文，并额外报出命中的小标题。
 * @returns {{ text: string, included: number, truncated: boolean, chars: number }}
 */
export function buildMaterial(
  docs,
  { charLimit = 48000, withReplies = true, withContent = true, contentPerDoc = 3000, replyPerDoc = 400, focus = [] } = {},
) {
  const blocks = [];
  let used = 0;
  let truncated = false;
  const hasFocus = Array.isArray(focus) && focus.length > 0;

  for (const [index, doc] of (docs ?? []).entries()) {
    const parts = [`[#${doc.id}] 《${doc.title}》`];
    const meta = [
      doc.board ? `板块=${doc.board}` : '',
      doc.author ? `作者=${doc.author}` : '',
      doc.replyCount != null ? `回复=${doc.replyCount}` : doc.replies?.length ? `回复=${doc.replies.length}` : '',
      doc.category ? `分类=${doc.category}` : '',
      doc.difficulty ? `难度=${doc.difficulty}` : '',
      doc.summary ? `摘要=${doc.summary}` : '',
      (Array.isArray(doc.tags) ? doc.tags : []).length ? `标签=${doc.tags.join('、')}` : '',
    ]
      .filter(Boolean)
      .join(' ');
    if (meta) parts.push(meta);

    const raw = doc.content ?? doc.text ?? '';
    if (hasFocus) {
      const headings = focusHeadings(raw, focus);
      if (headings.length) parts.push(`相关小节：${headings.join(' / ')}`);
    }

    let block = `${parts.join('\n')}\n`;
    if (withContent) {
      const body = hasFocus ? excerptAroundFocus(raw, focus, contentPerDoc) : clampText(raw, contentPerDoc);
      block += `正文：${body}\n`;
    }
    if (withReplies && Array.isArray(doc.replies) && doc.replies.length) {
      const lines = doc.replies.map(
        (reply) => `  - ${reply.author ?? reply.display_name ?? '匿名'}：${clampText(reply.content, replyPerDoc)}`,
      );
      block += `回复：\n${lines.join('\n')}\n`;
    }

    if (used + block.length > charLimit) {
      // 第一篇无论如何都要进去，避免预算太小导致材料为空
      if (index > 0) {
        truncated = true;
        break;
      }
      block = block.slice(0, charLimit);
      truncated = true;
    }
    blocks.push(block);
    used += block.length;
  }

  return { text: blocks.join('\n'), included: blocks.length, truncated, chars: used };
}

/** buildMaterial 的别名，便于从论坛代码平滑迁移。 */
export const buildContext = buildMaterial;

/**
 * 一行式文档目录：只留「编号 + 标题 + 归类信息」，不带正文。
 *
 * 全库整理（主题地图）靠的是「有哪些文档、各自属于什么方向」，
 * 不需要正文；因此大库可以改用目录，让同样的字符预算覆盖更多文档。
 * @param {Array<object>} docs
 * @param {{ withSummary?: boolean, summaryChars?: number }} [options]
 * @returns {string[]} 与 docs 一一对应的行
 */
export function buildIndexLines(docs, { withSummary = false, summaryChars = 60 } = {}) {
  return (docs ?? []).map((doc) => {
    const meta = [
      doc.category ? `分类=${clampText(doc.category, 20)}` : '',
      doc.difficulty ? `难度=${clampText(doc.difficulty, 6)}` : '',
      doc.board ? `板块=${clampText(doc.board, 20)}` : '',
      doc.replyCount ? `回复=${Number(doc.replyCount) || 0}` : '',
      withSummary && doc.summary ? `摘要=${clampText(doc.summary, summaryChars)}` : '',
    ]
      .filter(Boolean)
      .join(' ');
    const head = `[#${doc.id}] 《${clampText(doc.title, 80)}》`;
    return meta ? `${head} ${meta}` : head;
  });
}

/**
 * 按字符预算把一组条目切成若干块（每块至少一条，超长条目自成一块）。
 * @template T
 * @param {T[]} items
 * @param {number} charLimit 每块预算
 * @param {(item: T, index: number) => string} [sizeOf] 取条目文本（默认把条目当字符串）
 * @returns {T[][]}
 */
export function splitByBudget(items, charLimit, sizeOf = (item) => String(item ?? '')) {
  const budget = Math.max(1, Number(charLimit) || 1);
  const chunks = [];
  let current = [];
  let used = 0;
  for (const [index, item] of (items ?? []).entries()) {
    const size = sizeOf(item, index).length + 1;
    if (current.length && used + size > budget) {
      chunks.push(current);
      current = [];
      used = 0;
    }
    current.push(item);
    used += size;
  }
  if (current.length) chunks.push(current);
  return chunks;
}
