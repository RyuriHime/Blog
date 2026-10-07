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

/**
 * 把一批文档拼成材料文本。
 * @param {Array<object>} docs 文档：{ id, title, content, board?, author?, tags?, category?, difficulty?, summary?, replies? }
 * @param {{ charLimit?: number, withReplies?: boolean, withContent?: boolean, contentPerDoc?: number, replyPerDoc?: number }} [options]
 * @returns {{ text: string, included: number, truncated: boolean, chars: number }}
 */
export function buildMaterial(
  docs,
  { charLimit = 48000, withReplies = true, withContent = true, contentPerDoc = 3000, replyPerDoc = 400 } = {},
) {
  const blocks = [];
  let used = 0;
  let truncated = false;

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

    let block = `${parts.join('\n')}\n`;
    if (withContent) block += `正文：${clampText(doc.content ?? doc.text ?? '', contentPerDoc)}\n`;
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
