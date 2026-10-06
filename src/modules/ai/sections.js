// 小节切分 —— 「按小标题改」用的那把小刀。
//
// 背景（用户 2026-10 的需求）：AI 编辑台原来只能改**单块**，太碎了 ——
// 「把这一块改成投票」对整篇文章没有意义。现在只留两种粒度：**整篇** 与 **按小节**。
// 小节的定义就是人眼看到的那个：每一个 `heading` 块（标题）起一节，到下一个标题之前结束；
// 第一个标题之前的那些块算「开头」一节。
//
// 为什么单独一个文件、而不在前端顺手切一刀：
//   1. 切分结果有两个用处 —— 前端拿它渲染「改哪一节」的下拉，服务端拿它校验
//      「你发来的这堆块确实是连着的同一节，而且都在这一节里」。
//      两边各写一份必然会漂移，飘了就是「下拉里选的是第 3 节，实际改到别的块」。
//   2. 放在服务端，`scripts/ai-smoke.mjs` 能对着真实函数断言（边界：第一块就是标题、
//      两个标题挨着、没有标题、空数组），不用去 DOM 里抠前端代码。
//
// 这个文件**不碰数据库、不调模型、不认识 P2 的表**：输入就是 `[{ blockId, type, props }]`，
// 输出就是小节清单。P2 拥有 documents / document_blocks，我只读（`reads` 里已登记）。

import { AI_SECTION_HEADING_TYPE, AI_MAX_SECTION_BLOCKS } from './schema.js';

/** 第一个小标题之前的那一节在界面上的名字。 */
export const SECTION_OPENING_LABEL = '开头（第一个小标题之前）';

/** 小节名（标题文字）在清单里的长度上限，免得下拉被一整段正文撑爆。 */
export const SECTION_MAX_HEADING_CHARS = 80;

function headingText(block) {
  const raw = block && typeof block === 'object' && block.props && typeof block.props === 'object'
    ? block.props.text
    : '';
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (text === '') return '（无标题）';
  return text.length > SECTION_MAX_HEADING_CHARS ? `${text.slice(0, SECTION_MAX_HEADING_CHARS)}…` : text;
}

/** 标题级别只用于界面缩进，取不到就按 2 级（正文小标题的默认值）。 */
function headingLevel(block) {
  const raw = block && typeof block === 'object' && block.props && typeof block.props === 'object'
    ? Number(block.props.level)
    : NaN;
  if (!Number.isInteger(raw) || raw < 1 || raw > 6) return 2;
  return raw;
}

/** 这一节的体量（字符数）：界面上如实标出来，因为「一节越大越贵」。 */
function blockChars(block) {
  try {
    return JSON.stringify(block ?? null).length;
  } catch {
    return 0;
  }
}

/**
 * 把一串块切成小节。
 *
 * 返回 `[{ index, blockId, heading, level, blockCount, blockIds, chars, tooLarge }]`：
 *   - `index`      —— 下拉里的取值（0 起）
 *   - `blockId`    —— 这一节第一块（标题块）的 id，服务端按它认出「你选的是哪一节」
 *   - `blockIds`   —— 这一节的全部块 id，顺序就是文档里的顺序
 *   - `tooLarge`   —— 块数超过一批 `ops` 的上限（P2 的 MAX_OPS=50），界面上禁用该选项
 *
 * 容错：不是对象、缺 props、缺 blockId 的块一律**照样算一块**（`blockId` 记空串），
 * 因为这是渲染用的清单；真正要落盘时 `routes.js` 会逐块严格校验。
 */
export function splitSections(blocks) {
  const list = Array.isArray(blocks) ? blocks : [];
  /** @type {{ index: number, blockId: string, heading: string, level: number, blockIds: string[], chars: number }[]} */
  const sections = [];

  for (const block of list) {
    const isHeading = block && typeof block === 'object' && block.type === AI_SECTION_HEADING_TYPE;
    if (isHeading || sections.length === 0) {
      sections.push({
        index: sections.length,
        blockId: isHeading ? String(block.blockId ?? '') : '',
        heading: isHeading ? headingText(block) : SECTION_OPENING_LABEL,
        level: isHeading ? headingLevel(block) : 0,
        blockIds: [],
        chars: 0,
      });
    }
    const current = sections[sections.length - 1];
    current.blockIds.push(String(block?.blockId ?? ''));
    current.chars += blockChars(block);
  }

  return sections.map((section) => ({
    index: section.index,
    blockId: section.blockId,
    heading: section.heading,
    level: section.level,
    blockCount: section.blockIds.length,
    blockIds: section.blockIds,
    chars: section.chars,
    tooLarge: section.blockIds.length > AI_MAX_SECTION_BLOCKS,
  }));
}
