// 块数组的两个投影：纯文本摘要（影子行的 content、搜索用）与计数（列表页用）。
import { getBlockType } from './registry.js';
import { coerceProps } from './validate.js';

/**
 * 块 → 纯文本摘要。
 *
 * 影子行（`posts.content`）与搜索结果都用它：帖子列表只认纯文本，
 * 把整篇块 JSON 塞进去会让列表页原样吐出花括号。
 */
export function blocksToPlainText(blocks, limit = 24000) {
  const list = Array.isArray(blocks) ? blocks : [];
  const pieces = [];
  for (const block of list) {
    const type = getBlockType(block?.type);
    if (!type) continue;
    const props = coerceProps(type, block?.props ?? {});
    const piece = String(type.toPlain(props) ?? '').trim();
    if (piece.length > 0) pieces.push(piece);
  }
  const text = pieces.join('\n\n');
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

/** 块计数（含分型），列表页与统计用。 */
export function countBlocks(blocks) {
  const list = Array.isArray(blocks) ? blocks : [];
  const byType = {};
  for (const block of list) {
    const name = String(block?.type ?? 'unknown');
    byType[name] = (byType[name] ?? 0) + 1;
  }
  return { total: list.length, byType };
}
