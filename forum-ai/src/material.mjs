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
