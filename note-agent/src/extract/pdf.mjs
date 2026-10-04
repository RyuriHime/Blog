/**
 * PDF 抽取（尽力而为）。
 *
 * 零依赖下没法做真正的 PDF 解析器：这里只做两件事——
 *   1. 找出所有 `stream … endstream` 段，FlateDecode 的用 zlib 解开；
 *   2. 在这些段里扫 `(...)Tj` / `[...]TJ` / `(...)'` 文本操作符。
 * 扫描件（没有文本层）拿不到东西是正常的，所以**绝不抛异常**：
 * 一律降级成 blocks: [] + 明确的 warning，让上层把警告展示给用户。
 */
import { inflateSync, inflateRawSync } from 'node:zlib';
import { createBlockSink, normalizeText } from './common.mjs';

const PAGE_RE = /\/Type\s*\/Page\b/g;

/** 找出所有 stream 段的字节范围。 */
function findStreams(buffer) {
  const ranges = [];
  let cursor = 0;
  while (cursor < buffer.length) {
    const start = buffer.indexOf('stream', cursor);
    if (start < 0) break;
    let dataAt = start + 'stream'.length;
    if (buffer[dataAt] === 0x0d) dataAt += 1;
    if (buffer[dataAt] === 0x0a) dataAt += 1;
    const end = buffer.indexOf('endstream', dataAt);
    if (end < 0) break;
    let dataEnd = end;
    if (buffer[dataEnd - 1] === 0x0a) dataEnd -= 1;
    if (buffer[dataEnd - 1] === 0x0d) dataEnd -= 1;
    if (dataEnd > dataAt) ranges.push([dataAt, dataEnd]);
    cursor = end + 'endstream'.length;
  }
  return ranges;
}

/**
 * 单个内容流解压后的上限。PDF 里 `1 KB 压缩 → 1 GB 明文` 的炸弹同样会把宿主进程打爆，
 * 所以解压必须带硬闸；超限就当"解不开"，走下面既有的降级路径（warning + 跳过）。
 */
const MAX_STREAM_BYTES = 8 * 1024 * 1024;

function decodeStream(buffer, sink) {
  try {
    return inflateSync(buffer, { maxOutputLength: MAX_STREAM_BYTES }).toString('latin1');
  } catch {
    // 不是 zlib 包裹（可能是 raw deflate、解压炸弹，或根本没压缩）
  }
  try {
    return inflateRawSync(buffer, { maxOutputLength: MAX_STREAM_BYTES }).toString('latin1');
  } catch {
    // 当纯文本处理（未压缩的内容流也是合法的）
  }
  if (/^[\x09\x0a\x0d\x20-\x7e]*$/.test(buffer.toString('latin1'))) return buffer.toString('latin1');
  sink.warning('stream_skipped', '有一个内容流解不开（不是 zlib 也不是明文），已跳过');
  return '';
}

const SIMPLE_ESCAPES = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };

/** 从一个 `(` 开始读出配对到 `)` 的字符串，返回 [文本, 下一个下标]；不配对返回 null。 */
function readLiteralString(source, start) {
  const out = [];
  let depth = 1;
  let index = start + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === '\\') {
      const next = source[index + 1] ?? '';
      if (/[0-7]/.test(next)) {
        const octal = /^[0-7]{1,3}/.exec(source.slice(index + 1, index + 4))[0];
        out.push(String.fromCharCode(Number.parseInt(octal, 8)));
        index += 1 + octal.length;
        continue;
      }
      out.push(next === '\n' ? '' : SIMPLE_ESCAPES[next] ?? next);
      index += 2;
      continue;
    }
    if (char === '(') {
      depth += 1;
      out.push(char);
      index += 1;
      continue;
    }
    if (char === ')') {
      depth -= 1;
      if (depth === 0) return [out.join(''), index + 1];
      out.push(char);
      index += 1;
      continue;
    }
    out.push(char);
    index += 1;
  }
  return null;
}

/** 从内容流里按顺序抽出所有文本操作符的文字。 */
export function extractTextOperators(source) {
  const pieces = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === '(') {
      const literal = readLiteralString(source, index);
      if (!literal) break;
      const [text, next] = literal;
      const operator = /^\s*(Tj|TJ|'|")/.exec(source.slice(next, next + 6));
      if (operator) pieces.push(text);
      index = next;
      continue;
    }
    if (char === '[') {
      // 必须按字面串扫描找 `]`：TJ 数组里的字符串可以合法地含 `]`
      //（PDF 里 `[(见 [1])]TJ` 这类引注很常见）。以前用 indexOf(']') 找结束符，
      // 会在字符串内部提前截断，随后的 `/^\s*TJ/` 判定失败 ⇒ 整段文字被静默丢掉。
      const scanned = scanTjArray(source, index);
      if (!scanned) break;
      if (scanned.tj) pieces.push(scanned.parts.join(''));
      index = scanned.next;
      continue;
    }
    index += 1;
  }
  return pieces;
}

/**
 * 扫过一整个 `[ … ]TJ` 数组。
 *
 * 只认两种东西：`(` 开头的字面串（用 `readLiteralString` 跳，里面的 `]` 不算结束符）
 * 和 `]` 结束符。其余字符（数字、`-`、空白等位移量）直接跳过。
 *
 * @returns {{ parts: string[], next: number, tj: boolean } | null} 找不到结束符返回 null
 */
function scanTjArray(source, start) {
  const parts = [];
  let index = start + 1;
  let closed = false;
  while (index < source.length) {
    const char = source[index];
    if (char === '(') {
      const literal = readLiteralString(source, index);
      if (!literal) return null;
      parts.push(literal[0]);
      index = literal[1];
      continue;
    }
    if (char === ']') {
      closed = true;
      index += 1;
      break;
    }
    index += 1;
  }
  if (!closed) return null;
  const operator = /^\s*TJ/.exec(source.slice(index, index + 4));
  return { parts, next: index, tj: Boolean(operator) };
}

function paragraphsFrom(pieces) {
  const text = normalizeText(pieces.join(' '));
  if (text.length === 0) return [];
  return text
    .split(/\s{2,}/)
    .map((piece) => piece.trim())
    .filter(Boolean);
}

/**
 * @param {Buffer | Uint8Array} input
 * @returns {{ blocks: Array<object>, images: Array<object>, warnings: Array<object> }}
 */
export function extractPdf(input) {
  const sink = createBlockSink({ name: 'pdf' });
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input ?? []);

  try {
    const pageCount = [...buffer.toString('latin1').matchAll(PAGE_RE)].length;
    const pieces = [];
    for (const [from, to] of findStreams(buffer)) {
      const content = decodeStream(buffer.subarray(from, to), sink);
      if (content.length === 0) continue;
      pieces.push(...extractTextOperators(content));
    }

    for (const paragraph of paragraphsFrom(pieces)) sink.add({ type: 'paragraph', text: paragraph });

    if (sink.blocks.length === 0) {
      sink.warning(
        'pdf_no_text_layer',
        '这个 PDF 没有文本层（可能是扫描件或纯图片），建议改用图片上传或手动粘贴内容',
      );
    }

    const result = sink.finish();
    return { ...result, meta: { pageCount } };
  } catch (error) {
    return { blocks: [], images: [], warnings: [{ code: 'pdf_parse_failed', message: `PDF 解析失败：${error.message}` }] };
  }
}
