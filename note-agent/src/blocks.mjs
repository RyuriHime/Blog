/**
 * Block 协议：note-agent 内部唯一的"文档"表示。
 *
 * 一个 Block 形如 { id, type, text, level?, meta? }，
 * id 由 assignBlockIds() 单点生成（b1…bn），一旦生成永不重排。
 */

/** 七种块类型，顺序固定（测试与序列化都依赖这个顺序）。 */
export const BLOCK_TYPES = ['heading', 'paragraph', 'list', 'code', 'table', 'formula', 'image'];

/** 块 id 的形状：b + 至少一位数字。 */
export const BLOCK_ID_RE = /^b\d+$/;

export function isBlockId(value) {
  return typeof value === 'string' && BLOCK_ID_RE.test(value);
}

/** 块级公式的定界形式：$$…$$、\[…\]、\begin{equation|align|gather|eqnarray}…\end{…} */
const DISPLAY_WRAPPERS = [
  { open: '$$', close: '$$' },
  { open: '\\[', close: '\\]' },
  { open: '$', close: '$' },
];
const FORMULA_ENVIRONMENTS = ['equation', 'align', 'gather', 'eqnarray'];

/**
 * 去掉 formula 块的外层定界符，只留公式本体。
 *
 * 为什么必须有这个函数：模型从材料里看到 `$$\n…\n$$`（或 `\[…\]`、equation 环境）之后，
 * 经常把定界符**一起**写进 op.text；渲染侧若无条件再包一层，就得到 `$$\n$$\n…`，
 * 宿主的 markdown 渲染器与 KaTeX 都认不出来 —— 真机验收整篇显示公式全废就是这个原因。
 * 所以凡是"把公式显示成块"的地方，都要先过这里。
 */
export function unwrapFormula(text) {
  const value = String(text ?? '').trim();
  for (const { open, close } of DISPLAY_WRAPPERS) {
    if (value.length >= open.length + close.length && value.startsWith(open) && value.endsWith(close)) {
      return value.slice(open.length, value.length - close.length).trim();
    }
  }
  for (const name of FORMULA_ENVIRONMENTS) {
    const match = new RegExp(`^\\\\begin\\{${name}\\*?\\}([\\s\\S]*?)\\\\end\\{${name}\\*?\\}$`).exec(value);
    if (match) return match[1].trim();
  }
  return value;
}

/**
 * 造一个块。`type` 不在 BLOCK_TYPES 里是编程错误，直接 TypeError（不走 HTTP 错误码）。
 * @param {string} type
 * @param {string} text
 * @param {{ level?: number, meta?: object }} [extra]
 */
export function makeBlock(type, text, extra = {}) {
  if (!BLOCK_TYPES.includes(type)) throw new TypeError(`未知的块类型：${type}`);
  const block = { type, text: String(text ?? '') };
  if (extra.level !== undefined) block.level = extra.level;
  if (extra.meta !== undefined) block.meta = extra.meta;
  return block;
}

/**
 * 会话级单点重编号：忽略入参里可能存在的 id，从 b1 顺序重排。
 * 返回新数组与新对象 —— 调用方常把同一个块数组复用给多次 diff，绝不能共享引用。
 * @param {Array<object>} blocks
 */
export function assignBlockIds(blocks) {
  return (Array.isArray(blocks) ? blocks : []).map((block, index) => ({ ...block, id: `b${index + 1}` }));
}

/** 是不是 markdown 表格的分隔行（`| --- | :--: |`，也接受不带竖线的写法）。 */
function isSeparatorRow(row) {
  if (!Array.isArray(row) || row.length === 0) return false;
  return row.every((cell) => /^\s*:?-{2,}:?\s*$/.test(String(cell ?? '')));
}

/** 单个块的 markdown 片段（不含块间空行）。 */
function blockToMarkdown(block) {
  const text = String(block?.text ?? '');
  switch (block?.type) {
    case 'heading': {
      const level = Math.min(Math.max(Number(block.level) || 1, 1), 6);
      return `${'#'.repeat(level)} ${text}`;
    }
    case 'list':
      return text;
    case 'code': {
      const lang = block.meta?.lang ? String(block.meta.lang) : '';
      return `\`\`\`${lang}\n${text}\n\`\`\``;
    }
    case 'table': {
      const rows = Array.isArray(block.meta?.rows) ? block.meta.rows : [];
      if (rows.length === 0) return text;
      // 抽取阶段会把源表格的分隔行（`| --- |`）留在 meta.rows 里，好让行号与源文件对齐；
      // 这里统一只输出一行分隔行，否则草稿里会出现两行（真机验收踩到过）。
      const body = rows.filter((row, index) => !(index > 0 && isSeparatorRow(row)));
      const width = body.reduce((max, row) => Math.max(max, row.length), 0);
      return body
        .map((row, index) => {
          const cells = Array.from({ length: width }, (_, i) => String(row[i] ?? ''));
          const line = `| ${cells.join(' | ')} |`;
          return index === 0 ? `${line}\n|${' --- |'.repeat(width)}` : line;
        })
        .join('\n');
    }
    case 'formula':
      // 先剥掉定界符再包：模型常常把 `$$…$$`（或 `\[…\]`、equation 环境）一起放进
      // formula 块的 text，无条件包一层就会得到 `$$\n$$\n…`（真机验收踩到过）。
      return `$$\n${unwrapFormula(text)}\n$$`;
    case 'image': {
      const alt = block.meta?.alt ? String(block.meta.alt) : '图片';
      const src = block.meta?.src ? String(block.meta.src) : '';
      return `![${alt}](${src})`;
    }
    default:
      return text;
  }
}

/** 块数组 → markdown（块间恰一个空行，结尾无换行）。 */
export function blocksToMarkdown(blocks) {
  return (Array.isArray(blocks) ? blocks : [])
    .map(blockToMarkdown)
    .filter((piece) => piece.length > 0)
    .join('\n\n');
}

/** 块数组 → 去掉 markdown 噪音的纯文本（喂给模型的紧凑形式）。 */
export function blocksToPlainText(blocks, limit = 24000) {
  const parts = [];
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (!block) continue;
    const text = String(block.text ?? '');
    if (block.type === 'image') {
      parts.push(`[图片] ${block.meta?.alt ?? ''}`.trim());
      continue;
    }
    if (block.type === 'table') {
      const rows = Array.isArray(block.meta?.rows) ? block.meta.rows : [];
      parts.push(rows.map((row) => row.join(' | ')).join('\n') || text);
      continue;
    }
    if (text.length > 0) parts.push(text);
  }
  const plain = parts.join('\n\n');
  if (plain.length <= limit) return plain;
  const keep = Math.max(0, limit - 1);
  return `${plain.slice(0, keep).trimEnd()}…`;
}

/** 统计块总数与分型，用来给前端显示"识别到 N 个块"。 */
export function countBlocks(blocks) {
  const byType = {};
  let total = 0;
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (!block) continue;
    total += 1;
    byType[block.type] = (byType[block.type] ?? 0) + 1;
  }
  return { total, byType };
}
