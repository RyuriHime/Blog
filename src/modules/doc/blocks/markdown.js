// markdown ⇄ 块。
//
// 三个方向都被当成**契约**：
//   `blocksToMarkdown` 在旧 7 种类型上的输出必须与 note-agent 逐字节相同（一个 id 都不输出）；
//   `toSource` 是编辑器用的带 id 版本，`toSource → parseSourceBlocks → toSource` 必须逐字节往返；
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
// 结构化围栏的信息串：`doc:poll {#b3}`（id 可选，老源码里没有）。
const DOC_FENCE_INFO = /^doc:([A-Za-z0-9_-]+)\s*(?:\{#([A-Za-z0-9_-]+)\})?$/;
// 天然 markdown 块上一行的 id 标记：`<!-- b3 -->`。
const ID_MARKER = /^<!--\s*(b[0-9]+)\s*-->$/;

/**
 * 哪些块 id **必须**写进源码：这些块带着服务端副数据（票 / 沙箱状态 / 绑定目标），
 * id 一漂移，数据就被当成孤儿清掉。纯文字块的 id 可以随位置重发，源码也就保持干净。
 *（`store.js` 的按 id 对齐也用它 —— 一个 poll 的 id 绝不交给别的块。）
 */
export const ID_BEARING_TYPES = new Set(['poll', 'app', 'script']);

/** 一个块 → markdown 片段（空字符串表示这块不输出）。 */
function markdownForBlock(block) {
  const type = getBlockType(block?.type);
  if (!type) return '';
  const props = coerceProps(type, block?.props ?? {});
  const piece = type.toMarkdown(props);
  return piece === undefined || piece === null ? '' : String(piece);
}

/**
 * 哪些块算「正文」——可以并成一段 `prose` 的纯文字块。
 *
 * 只有这三种：它们既不挂服务端副数据，也没有专属的渲染器与样式。
 * `table` / `formula` / `image` / `code` 各自有 CSS 与测试钉着（`doc-block-formula`
 * 之类），`heading` 是分块的天然边界，结构化围栏（`doc:poll` …）更不用说。
 */
const PROSE_TYPES = new Set(['paragraph', 'list', 'quote']);

/** 一段 `prose` 最多装多少字符；超了就切一刀，别让一个块变成整篇文章。 */
const PROSE_MAX_CHARS = 16000;

/**
 * 把连续的「正文块」并成一个 `prose` 块。
 *
 * 为什么要有这一步：源 markdown 里句子之间常有空行，逐行状态机就会把一篇正常文章
 * 拆成几十个一段话一块的块（用户的原话是「避免出现一句话一块」）。
 * 合并只发生在**被切点隔开的同一小节内部**，切点是：标题、代码/表格/公式/图片/双链、
 * 任何结构化围栏块、任何自己带 id 的块。
 *
 * 合并后的 `props.text` 就是这些小块的 markdown 原样、用空行连接 ——
 * 所以 `toMarkdown` 原样吐出去以后，重新解析还是同一段文字（往返逐字节成立）。
 * 带 id 的块不参与合并（除了作为一段的**开头**）：`<!-- b3 -->` 标记只作用于下一个块，
 * 并进来就会把它吃掉，`bind.from` 的指向会漂。
 */
function mergeProse(raw) {
  const merged = [];
  let text = '';
  let entry = null;

  const flush = () => {
    if (entry) merged.push(entry);
    entry = null;
    text = '';
  };

  for (const item of raw) {
    const piece = PROSE_TYPES.has(item.type) && item.structured !== true ? markdownForBlock(item).trim() : '';
    if (piece === '') {
      flush();
      merged.push(item);
      continue;
    }
    const hasId = String(item.blockId ?? '') !== '';
    const tooLong = text !== '' && text.length + piece.length + 2 > PROSE_MAX_CHARS;
    // 一段的第一项永远接住（它自己带 id 就把 id 挂到合并后的块上）；
    // 之后的项只要自己带 id、或本段快满了，就切一刀另起一段。
    if (entry !== null && (hasId || tooLong)) flush();
    if (entry === null) {
      entry = { type: 'prose', props: { text: piece }, blockId: item.blockId };
      text = piece;
      continue;
    }
    text = `${text}\n\n${piece}`;
    entry.props.text = text;
  }
  flush();
  return merged;
}

/** 块数组 → markdown（与 note-agent 一样用空行连接，丢空片段）。 */
export function blocksToMarkdown(blocks) {
  const list = Array.isArray(blocks) ? blocks : [];
  return list
    .map((block) => markdownForBlock(block))
    .filter((piece) => piece.length > 0)
    .join('\n\n');
}

/**
 * 哪些 id 要出现在源码里（§3.1 三条判据）：
 *   (a) 自己有 `bind.from` 的块 —— 记下自己，别人才能反过来引用它；
 *   (b) 每一个 `bind.from` 指向的目标 —— 漂了别人就绑错块；
 *   (c) `ID_BEARING_TYPES` 里的块 —— 它们挂着票 / 状态 / 代码。
 */
function sourceIdsToMark(blocks, derivedBlocks = []) {
  const marked = new Set();
  const scan = (list) => {
    for (const block of Array.isArray(list) ? list : []) {
      const id = String(block?.block_id ?? '');
      const from = String(block?.props?.bind?.from ?? '');
      if (from === '') continue;
      if (id !== '') marked.add(id); // (a)
      marked.add(from); // (b)
    }
  };
  scan(blocks);
  scan(derivedBlocks);
  for (const block of Array.isArray(blocks) ? blocks : []) {
    const id = String(block?.block_id ?? '');
    const type = String(block?.type ?? '');
    if (id !== '' && ID_BEARING_TYPES.has(type)) marked.add(id); // (c)
  }
  return marked;
}

/** 结构化围栏的第一行：```` ```doc:poll ````（可选带一个已有的 id）。 */
const DOC_FENCE_FIRST = /^(`{3,})doc:([A-Za-z0-9_-]+)(\s*\{#[A-Za-z0-9_-]+\})?\s*$/;

/** 把一个块的片段加上 id：结构化块写进信息串，天然 markdown 块写成上一行的注释。 */
function withSourceId(piece, id) {
  const lines = piece.split('\n');
  const head = DOC_FENCE_FIRST.exec(lines[0]);
  if (head) {
    if (head[3]) return piece; // 已经有 id 了，不重复写
    lines[0] = `${head[1]}doc:${head[2]} {#${id}}`;
    return lines.join('\n');
  }
  return `<!-- ${id} -->\n${piece}`;
}

/**
 * 块数组 → **带 id 的源码**（编辑器与 `PUT /api/docs/:id/markdown` 用的就是这个）。
 *
 * 与 `blocksToMarkdown` 只差两处：结构化块的信息串带 `{#id}`，
 * 需要固定 id 的天然 markdown 块上一行写 `<!-- id -->`。其余逐字节相同，
 * 所以「同样输入 → 同样文本」，往返不发散。
 *
 * `derivedBlocks`（脚本产出的派生块）只参与判据 (b)：它们绑谁，谁就得有 id。
 */
export function toSource(blocks, { derivedBlocks = [] } = {}) {
  const list = Array.isArray(blocks) ? blocks : [];
  const marked = sourceIdsToMark(list, derivedBlocks);
  return list
    .map((block) => {
      const piece = markdownForBlock(block);
      const id = String(block?.block_id ?? '');
      if (id === '' || !marked.has(id) || piece === '') return piece;
      return withSourceId(piece, id);
    })
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
 * 解析顺序很重要：围栏（含 `doc:` 结构化块）→ 公式 → 空行 → id 标记 → 标题 → 图片 →
 * 双链 → 表格 → 引用 → 列表 → 段落兜底。列表与表格要**整段吞掉**连续行，
 * 否则 `- 甲\n- 乙` 会被拆成两个块。
 *
 * `positionalIds: false` 时，**没写 id 的块 `block_id` 留成空串** —— 这是「请按旧序列
 * 给我对齐一个 id」的信号，给 store 的按 id 对齐写入用（见 `parseSourceBlocks`）。
 * 默认 `true`：老路径照旧按位置发号，`markdownToBlocks` 的调用方一字不用改。
 */
export function parseBlocks(markdown, { positionalIds = true, granularity = 'section' } = {}) {
  const text = String(markdown ?? '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const raw = [];
  let paragraph = null;
  let index = 0;
  // 上一行 `<!-- b3 -->` 记下的 id，交给**下一个**推入的块。
  let pendingId = '';

  const flushParagraph = () => {
    if (paragraph !== null) {
      raw.push({ type: 'paragraph', props: { text: paragraph }, blockId: pendingId });
      paragraph = null;
      pendingId = '';
    }
  };

  /** 推入一个块；`explicitId`（写在围栏信息串里的）优先于上一行的标记行。 */
  const pushRaw = (type, props, explicitId = '', structured = false) => {
    raw.push({ type, props, blockId: explicitId || pendingId, structured });
    pendingId = '';
  };

  while (index < lines.length && raw.length < MAX_DOC_BLOCKS) {
    const line = lines[index];

    const fence = FENCE_OPEN.exec(line);
    if (fence) {
      flushParagraph();
      const { info, body, next } = readFence(lines, index);
      if (info.startsWith('doc:')) {
        const shape = DOC_FENCE_INFO.exec(info);
        const kind = shape ? shape[1] : info.slice(4);
        const explicitId = shape && shape[2] ? shape[2] : '';
        const type = getBlockType(kind);
        if (type && type.sourceBody === 'raw') {
          // 源码体就是原始代码（`doc:script`），不做 JSON 解析。
          pushRaw(kind, { code: body }, explicitId, true);
        } else {
          let parsed = null;
          try {
            parsed = JSON.parse(body);
          } catch {
            parsed = null;
          }
          if (type && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            pushRaw(kind, parsed, explicitId, true);
          } else {
            // 结构化块坏了就退回代码块 —— 至少内容还在，不会被悄悄丢掉。
            pushRaw('code', { text: body, lang: kind }, '', true);
          }
        }
      } else {
        pushRaw('code', { text: body, lang: info }, '', true);
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
      pushRaw('formula', { text: body.join('\n') });
      index = Math.min(cursor + 1, lines.length);
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      index += 1;
      continue;
    }

    // id 标记行：只作用于后面那个块，中间隔空行也不算断。
    const marker = ID_MARKER.exec(line.trim());
    if (marker) {
      flushParagraph();
      pendingId = marker[1];
      index += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      pushRaw('heading', { level: heading[1].length, text: heading[2].trim() });
      index += 1;
      continue;
    }

    const trimmed = line.trim();
    const image = IMAGE.exec(trimmed);
    if (image) {
      flushParagraph();
      pushRaw('image', { alt: image[1], src: image[2] });
      index += 1;
      continue;
    }

    const wiki = WIKI.exec(trimmed);
    if (wiki) {
      flushParagraph();
      pushRaw('wiki', { target: wiki[1], label: wiki[2] ?? '' });
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
      pushRaw('table', { text: '', rows: rows.filter((row, i) => !(i > 0 && isSeparatorRow(row))) });
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
      pushRaw('quote', { text: parts.join('\n'), source });
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
      pushRaw('list', { text: parts.join('\n') });
      index = cursor;
      continue;
    }

    paragraph = paragraph === null ? line : `${paragraph}\n${line}`;
    index += 1;
  }

  flushParagraph();

  // 分块粒度：`section`（默认）把同一小节里的正文并成 `prose` 块，
  // `block` 保留「一段话一个块」的老行为（老调用方 / 需要逐块对齐时用）。
  const entries = granularity === 'section' ? mergeProse(raw) : raw;

  const blocks = [];
  const warnings = [];
  // 显式 id 先占位：位置发号要绕开它们，免得撞号（也免得整篇重排）。
  const claimed = new Set();
  for (const entry of entries) {
    const id = String(entry.blockId ?? '');
    if (id !== '' && BLOCK_ID_PATTERN.test(id)) claimed.add(id);
  }
  const used = new Set();
  let next = 1;
  for (const entry of entries) {
    const type = getBlockType(entry.type);
    if (!type) {
      warnings.push({ block_id: '', code: 'unknown_type', message: `解析出未注册的块类型「${entry.type}」` });
      continue;
    }
    const wanted = String(entry.blockId ?? '');
    let blockId = wanted !== '' && BLOCK_ID_PATTERN.test(wanted) && !used.has(wanted) ? wanted : '';
    if (blockId === '' && positionalIds) {
      while (used.has(`b${next}`) || claimed.has(`b${next}`)) next += 1;
      blockId = `b${next}`;
      next += 1;
    }
    used.add(blockId);
    blocks.push({
      block_id: blockId,
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

/**
 * 保存源码那条路用的解析：**不给没写 id 的块发号**（`block_id: ''`）。
 * 「这个块是谁」由 store 的按 id 对齐（LCS）决定，解析器不猜。
 */
export function parseSourceBlocks(markdown) {
  return parseBlocks(markdown, { positionalIds: false });
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
