// markdown ⇄ 块。
//
// 两个方向都被当成**契约**：
//   `blocksToMarkdown` 在旧 7 种类型上的输出必须与 note-agent 逐字节相同；
//   `markdownToBlocks(markdownToBlocks)` 必须能往返（100 篇随机文档的属性测试守着）。
//
// 解析器是一个行式状态机：先把行按「块的开头」归类，再逐块消费。
// 遇到任何看不懂的东西都退回段落，**从不抛异常**。
import { BLOCK_ID_PATTERN, MAX_DOC_BLOCKS } from '../schema.js';
import { getBlockType } from './registry.js';
import { coerceProps } from './validate.js';
import { isSeparatorRow, splitRow } from './text.js';

const FENCE_OPEN = /^(`{3,})\s*(.*)$/;
const FENCE_CLOSE = /^`{3,}\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const IMAGE = /^!\[([\s\S]*)\]\(([^()]*)\)\s*$/;
const WIKI = /^\[\[([^\][|]+)(?:\|([^\]]*))?\]\]$/;
const QUOTE_LINE = /^\s*>/;
const LIST_LINE = /^\s*(?:[-*+]|\d{1,9}[.)])\s+\S/;

/** 一个块 → markdown 片段（空字符串表示这块不输出）。 */
function markdownForBlock(block) {
  const type = getBlockType(block?.type);
  if (!type) return '';
  const props = coerceProps(type, block?.props ?? {});
  const piece = type.toMarkdown(props);
  return piece === undefined || piece === null ? '' : String(piece);
}

/** 块数组 → markdown（与 note-agent 一样用空行连接，丢空片段）。 */
export function blocksToMarkdown(blocks) {
  const list = Array.isArray(blocks) ? blocks : [];
  return list
    .map((block) => markdownForBlock(block))
    .filter((piece) => piece.length > 0)
    .join('\n\n');
}

/** 读一段围栏，返回 `{info, body, next}`（`next` 是围栏之后的行号）。 */
function readFence(lines, start) {
  const ticks = FENCE_OPEN.exec(lines[start])[1];
  const info = String(FENCE_OPEN.exec(lines[start])[2] ?? '').trim();
  const body = [];
  let index = start + 1;
  while (index < lines.length) {
    if (FENCE_CLOSE.test(lines[index]) && lines[index].trim().length >= ticks.length) break;
    body.push(lines[index]);
    index += 1;
  }
  return { info, body: body.join('\n'), next: Math.min(index + 1, lines.length) };
}

/**
 * markdown → `{blocks, warnings}`。
 *
 * 解析顺序很重要：围栏（含 `doc:` 结构化块）→ 公式 → 空行 → 标题 → 图片 → 双链 →
 * 表格 → 引用 → 列表 → 段落兜底。列表与表格要**整段吞掉**连续行，
 * 否则 `- 甲\n- 乙` 会被拆成两个块。
 */
export function parseBlocks(markdown) {
  const text = String(markdown ?? '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const raw = [];
  let paragraph = null;
  let index = 0;

  const flushParagraph = () => {
    if (paragraph !== null) {
      raw.push({ type: 'paragraph', props: { text: paragraph } });
      paragraph = null;
    }
  };

  while (index < lines.length && raw.length < MAX_DOC_BLOCKS) {
    const line = lines[index];

    const fence = FENCE_OPEN.exec(line);
    if (fence) {
      flushParagraph();
      const { info, body, next } = readFence(lines, index);
      if (info.startsWith('doc:')) {
        const kind = info.slice(4);
        const type = getBlockType(kind);
        let parsed = null;
        try {
          parsed = JSON.parse(body);
        } catch {
          parsed = null;
        }
        if (type && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          raw.push({ type: kind, props: parsed });
        } else {
          // 结构化块坏了就退回代码块 —— 至少内容还在，不会被悄悄丢掉。
          raw.push({ type: 'code', props: { text: body, lang: kind } });
        }
      } else {
        raw.push({ type: 'code', props: { text: body, lang: info } });
      }
      index = next;
      continue;
    }

    if (line.trim() === '$$') {
      flushParagraph();
      const body = [];
      let cursor = index + 1;
      while (cursor < lines.length && lines[cursor].trim() !== '$$') {
        body.push(lines[cursor]);
        cursor += 1;
      }
      raw.push({ type: 'formula', props: { text: body.join('\n') } });
      index = Math.min(cursor + 1, lines.length);
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      index += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      raw.push({ type: 'heading', props: { level: heading[1].length, text: heading[2].trim() } });
      index += 1;
      continue;
    }

    const trimmed = line.trim();
    const image = IMAGE.exec(trimmed);
    if (image) {
      flushParagraph();
      raw.push({ type: 'image', props: { alt: image[1], src: image[2] } });
      index += 1;
      continue;
    }

    const wiki = WIKI.exec(trimmed);
    if (wiki) {
      flushParagraph();
      raw.push({ type: 'wiki', props: { target: wiki[1], label: wiki[2] ?? '' } });
      index += 1;
      continue;
    }

    if (trimmed.startsWith('|')) {
      flushParagraph();
      const rows = [];
      let cursor = index;
      while (cursor < lines.length && lines[cursor].trim().startsWith('|')) {
        rows.push(splitRow(lines[cursor]));
        cursor += 1;
      }
      // 源文件里常留着 `| --- | --- |` 的分隔行，结构化时去掉。
      raw.push({ type: 'table', props: { text: '', rows: rows.filter((row, i) => !(i > 0 && isSeparatorRow(row))) } });
      index = cursor;
      continue;
    }

    if (QUOTE_LINE.test(line)) {
      flushParagraph();
      const parts = [];
      let cursor = index;
      while (cursor < lines.length && QUOTE_LINE.test(lines[cursor])) {
        parts.push(lines[cursor].replace(/^\s*>\s?/, ''));
        cursor += 1;
      }
      let source = '';
      if (parts.length > 1 && /^——\s*/.test(parts[parts.length - 1])) {
        source = parts.pop().replace(/^——\s*/, '').trim();
      }
      raw.push({ type: 'quote', props: { text: parts.join('\n'), source } });
      index = cursor;
      continue;
    }

    if (LIST_LINE.test(line)) {
      flushParagraph();
      const parts = [];
      let cursor = index;
      while (cursor < lines.length && LIST_LINE.test(lines[cursor])) {
        parts.push(lines[cursor]);
        cursor += 1;
      }
      raw.push({ type: 'list', props: { text: parts.join('\n') } });
      index = cursor;
      continue;
    }

    paragraph = paragraph === null ? line : `${paragraph}\n${line}`;
    index += 1;
  }

  flushParagraph();

  const blocks = [];
  const warnings = [];
  for (const entry of raw) {
    const type = getBlockType(entry.type);
    if (!type) {
      warnings.push({ block_id: '', code: 'unknown_type', message: `解析出未注册的块类型「${entry.type}」` });
      continue;
    }
    blocks.push({
      block_id: `b${blocks.length + 1}`,
      type: entry.type,
      version: 1,
      props: coerceProps(type, entry.props),
    });
  }
  return { blocks, warnings };
}

/** markdown → 块数组（只要块，不要警告）。 */
export function markdownToBlocks(markdown) {
  return parseBlocks(markdown).blocks;
}

/** `document_blocks.blocks_json` / `document_revisions.blocks_json` → `{blocks, warnings}`。 */
export function parseBlocksJson(text) {
  const source = String(text ?? '').trim();
  if (source === '') return { blocks: [], warnings: [] };
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    return {
      blocks: [],
      warnings: [{ block_id: '', code: 'bad_json', message: `块数据不是合法的 JSON：${error?.message ?? error}` }],
    };
  }
  if (!Array.isArray(parsed)) {
    return { blocks: [], warnings: [{ block_id: '', code: 'bad_json', message: '块数据必须是一个数组' }] };
  }

  const blocks = [];
  const warnings = [];
  for (const [position, entry] of parsed.slice(0, MAX_DOC_BLOCKS).entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      warnings.push({ block_id: '', code: 'bad_block', message: `第 ${position + 1} 个块不是一个对象` });
      continue;
    }
    const type = String(entry.type ?? '');
    const block_id = BLOCK_ID_PATTERN.test(String(entry.block_id ?? '')) ? String(entry.block_id) : `b${position + 1}`;
    const version = Number(entry.version);
    const typeDef = getBlockType(type);
    const props = entry.props && typeof entry.props === 'object' && !Array.isArray(entry.props) ? entry.props : {};
    blocks.push({
      block_id,
      type,
      version: Number.isFinite(version) && version > 0 ? Math.floor(version) : 1,
      // 未注册的类型原样留着 —— 渲染阶段会把它降级成占位，用户才知道哪块坏了。
      props: typeDef ? coerceProps(typeDef, props) : props,
    });
  }
  return { blocks, warnings };
}

/** 块数组 → 存库用的 JSON 字符串。 */
export function blocksToJson(blocks) {
  return JSON.stringify(Array.isArray(blocks) ? blocks : []);
}
