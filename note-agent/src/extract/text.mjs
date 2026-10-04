/**
 * 纯文本 / Markdown 抽取（零依赖）。
 *
 * 产出的是"块"（Block）而不是 HTML：块是整理 Agent 的最小寻址单位，
 * 每个块有稳定的 id（b1…bn），Ops 与 diff 都靠 id 定位。
 *
 * id 规则与 `src/blocks.mjs` / 任务 6 的 `assignBlockIds()` 一致：从 b1 开始按顺序编号。
 */
import { BLOCK_TYPES } from '../blocks.mjs';

const GFM_FENCE_RE = /^ {0,3}(?:```|~~~)/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s+/;
const BLOCKQUOTE_RE = /^\s*>/;
const SINGLE_LINE_DISPLAY_MATH_RE = /^\s*\$\$.+\$\$\s*$/;
const SINGLE_LINE_BRACKET_MATH_RE = /^\s*\\\[[\s\S]*\\\]\s*$/;

/** 这个段落文本整体是不是一条公式（任务 7 的完整规则由 formulas.mjs 负责）。 */
export function looksLikeFormula(text) {
  const value = String(text ?? '').trim();
  if (value.length === 0) return false;
  if (value.startsWith('$$') && value.endsWith('$$') && value.length > 4) return true;
  if (value.startsWith('\\[') && value.endsWith('\\]')) return true;
  if (SINGLE_LINE_DISPLAY_MATH_RE.test(value)) return true;
  if (SINGLE_LINE_BRACKET_MATH_RE.test(value)) return true;
  return false;
}

export function isTableSeparator(line) {
  const text = String(line ?? '').trim();
  if (!text.includes('-')) return false;
  return /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(text);
}

export function isTableRow(line) {
  return String(line ?? '').includes('|');
}

function splitTableCells(line) {
  let text = String(line ?? '').trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|')) text = text.slice(0, -1);
  return text.split('|').map((cell) => cell.trim());
}

function isListStart(line) {
  return LIST_ITEM_RE.test(line) || BLOCKQUOTE_RE.test(line) || /^\s*`[^`]/.test(line);
}

/**
 * 从原始文本抽块。
 * @param {Buffer | Uint8Array | string} input
 * @param {{ name?: string }} [options]
 * @returns {{ blocks: Array<{ id: string, type: string, text: string, level?: number, meta?: object }>, images: [], warnings: Array<{ code: string, message: string }> }}
 */
export function extractText(input, { name = 'material' } = {}) {
  const source = normalizeSource(input);
  const lines = source.split('\n');

  /** @type {Array<{ id: string, type: string, text: string, level?: number, meta?: object }>} */
  const blocks = [];
  const warnings = [];
  const push = (block) => {
    if (!BLOCK_TYPES.includes(block.type)) throw new Error(`未知块类型 ${block.type}`);
    blocks.push({ id: `b${blocks.length + 1}`, ...block });
  };

  let index = 0;
  let paragraph = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const text = paragraph.join('\n').trim();
    paragraph = [];
    if (text.length === 0) return;
    if (looksLikeFormula(text)) push({ type: 'formula', text });
    else push({ type: 'paragraph', text });
  };

  while (index < lines.length) {
    const line = lines[index] ?? '';

    // 1. 围栏代码块：优先级最高，块内一切原样保留
    if (GFM_FENCE_RE.test(line)) {
      flushParagraph();
      const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      const fence = fenceMatch ? fenceMatch[1] : '```';
      // 语言标记：只在反引号围栏上认（`~~~` 后面带字的是 info string 的散文，不是语言名）
      const info = fenceMatch ? line.trim().slice(fence.length).trim() : '';
      const lang = fence.startsWith('`') ? (/^[^\s`]+/.exec(info) ?? [''])[0] : '';
      const fenceChar = fence[0];
      const fenceMin = fence.length;
      /**
       * 收尾判定按 GFM 来：**同一个字符**、且**不短于**开启围栏。
       *
       * 以前只判 `/^ {0,3}(?:`{3,}|~{3,})/`，于是 ```` ``` ```` 开的块会被
       * `~~~~` 或 ```` ```` ```` 这种别的围栏关掉，块的内容被切错。
       */
      const closesFence = (candidate) => {
        // 注意用 `[ \t]*` 而不是 `\s*`：`$` 不加 `m` 标志时只匹配**整个字符串末尾**，
        // 而 `\s` 能吃换行 —— `/^ {0,3}```{3,}\s*$/` 会把「``` 换行 任意内容 换行 ```」
        // 整段判成"一行收尾围栏"，块内容被吃掉。
        const head = new RegExp(`^ {0,3}\\${fenceChar}{${fenceMin},}[ \\t]*$`);
        return head.test(candidate);
      };
      const body = [];
      index += 1;
      while (index < lines.length && !closesFence(lines[index] ?? '')) {
        body.push(lines[index] ?? '');
        index += 1;
      }
      if (index < lines.length) index += 1; // 吃掉收尾围栏
      const content = [...body];
      if (content.length > 0 && content[content.length - 1].trim() === '') content.pop();
      push({ type: 'code', text: content.join('\n'), meta: { lang, fence } });
      continue;
    }

    // 2. 标题
    const heading = HEADING_RE.exec(line);
    if (heading) {
      flushParagraph();
      push({ type: 'heading', text: heading[2].trim(), level: Math.min(6, heading[1].length) });
      index += 1;
      continue;
    }

    // 3. 表格：当前行有 | 且下一行是分隔行
    if (isTableRow(line) && isTableSeparator(lines[index + 1] ?? '')) {
      flushParagraph();
      // rows 里连分隔行一起保留：`| 表头 |` 是 rows[0]、`| --- |` 是 rows[1]、第一条数据是 rows[2]，
      // 这样"数据行"的位置与 GFM 表格的行号一致，模型引用行号时不会错位。
      const rows = [splitTableCells(line), splitTableCells(lines[index + 1] ?? '')];
      // 列数按分隔行定：GFM 里第一行分隔行之后的行**全是数据行**，再来一条
      // `| --- |` 也只是被当数据。以前用 `isTableRow` 收行，第二条分隔行会被
      // 当成数据吞进去（表格多出一行假的）。
      const columns = rows[1].length;
      index += 2; // 表头 + 分隔行
      // GFM：第一行分隔行之后 **只有"像数据"的行**才算数据；再来一条 `| --- |`
      // 属于分隔行重复，不能收进数据（否则"数据行下标"与用户看到的表格错位）。
      // 跳过它而不是就此收尾 —— 用户从别处粘表格时常连着贴两条分隔行，
      // 后面真正的数据行还得接上。
      while (index < lines.length && isTableRow(lines[index] ?? '')) {
        if (lines[index] === undefined) break;
        if (isTableSeparator(lines[index] ?? '')) {
          index += 1;
          continue;
        }
        if (splitTableCells(lines[index] ?? '').length !== columns) break;
        rows.push(splitTableCells(lines[index] ?? ''));
        index += 1;
      }
      push({ type: 'table', text: rows.map((row) => `| ${row.join(' | ')} |`).join('\n'), meta: { rows } });
      continue;
    }

    // 4. 独占整行的块级公式（$$…$$ / \[…\]，可跨行）
    const trimmed = line.trim();
    if (trimmed === '$$' || trimmed === '\\[') {
      const closer = trimmed === '$$' ? '$$' : '\\]';
      const body = [];
      index += 1;
      while (index < lines.length && (lines[index] ?? '').trim() !== closer) {
        body.push(lines[index] ?? '');
        index += 1;
      }
      const closed = index < lines.length;
      if (closed) index += 1;
      const text = [trimmed, ...body, ...(closed ? [closer] : [])].join('\n');
      flushParagraph();
      push({ type: 'formula', text });
      continue;
    }

    // 5. 列表 / 引用：连同缩进的续行合并成一个 list 块
    if (isListStart(line)) {
      flushParagraph();
      const items = [line];
      index += 1;
      while (index < lines.length) {
        const next = lines[index] ?? '';
        if (next.trim() === '' || GFM_FENCE_RE.test(next) || HEADING_RE.test(next)) break;
        if (!isListStart(next) && !/^ {2,}\S/.test(next)) break;
        items.push(next);
        index += 1;
      }
      push({ type: 'list', text: items.join('\n') });
      continue;
    }

    // 6. 段落的起点：整段就是一条公式
    if (trimmed !== '' && (SINGLE_LINE_DISPLAY_MATH_RE.test(trimmed) || SINGLE_LINE_BRACKET_MATH_RE.test(trimmed))) {
      flushParagraph();
      push({ type: 'formula', text: trimmed });
      index += 1;
      continue;
    }

    // 7. 普通段落：连续行合并
    if (trimmed === '') {
      flushParagraph();
      index += 1;
      continue;
    }
    paragraph.push(line);
    index += 1;
  }
  flushParagraph();

  if (blocks.length === 0) {
    warnings.push({ code: 'empty_material', message: '这个文件没有可提取的文字' });
  }

  return { blocks, images: [], warnings };
}

/** 去掉 BOM、统一换行、剥掉首尾空行。 */
export function normalizeSource(input) {
  const text = typeof input === 'string' ? input : Buffer.from(input ?? []).toString('utf8');
  return text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n+$/, '');
}
