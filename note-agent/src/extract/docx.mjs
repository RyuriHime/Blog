/**
 * DOCX 抽取：`word/document.xml` → 块序列。
 *
 * 用正则切段而不是通用 XML 解析器：OOXML 的文档结构固定，零依赖下这样最省事，
 * 而且我们只关心 w:p / w:tbl / w:t / w:instrText 这几个标签。
 */
import { openZip, ZipError } from '../zip.mjs';
import { createBlockSink, normalizeText } from './common.mjs';

const BODY_BLOCK_RE = /<w:tbl\b[\s\S]*?<\/w:tbl>|<w:p\b[\s\S]*?<\/w:p>/g;
const STYLE_RE = /<w:pStyle\b[^>]*w:val="([^"]*)"/;
const HEADING_STYLE_RE = /^(?:heading|标题)\s*([1-6])$/i;
const INSTR_RE = /<w:instrText\b[^>]*>([\s\S]*?)<\/w:instrText>/g;
const ROW_RE = /<w:tr\b[\s\S]*?<\/w:tr>/g;
const CELL_RE = /<w:tc\b[\s\S]*?<\/w:tc>/g;

/** 一个 w:p 的纯文本：所有 w:t 按顺序拼接，w:tab 当制表位，其余标签丢掉。 */
function paragraphText(xml) {
  return normalizeText(
    String(xml ?? '')
      .replace(/<w:tab\b[^>]*\/>/g, '\t')
      .replace(/<w:br\b[^>]*\/>/g, ' ')
      .replace(/<[^>]*>/g, ''),
  );
}

function headingLevel(xml) {
  const style = STYLE_RE.exec(String(xml ?? ''));
  if (!style) return 0;
  const match = HEADING_STYLE_RE.exec(style[1].trim());
  return match ? Number(match[1]) : 0;
}

/** 公式域（EMBED Equation.* \* MERGEFORMAT）的文本内容；不是公式域返回 null。 */
function fieldText(xml) {
  const source = String(xml ?? '');
  let found = false;
  for (const match of source.matchAll(INSTR_RE)) {
    if (/MERGEFORMAT/i.test(match[1])) found = true;
  }
  if (!found) return null;
  return paragraphText(source);
}

function tableRows(xml) {
  const rows = [];
  for (const rowMatch of String(xml ?? '').matchAll(ROW_RE)) {
    const cells = [];
    for (const cellMatch of rowMatch[0].matchAll(CELL_RE)) {
      cells.push(
        [...cellMatch[0].matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)]
          .map((p) => paragraphText(p[0]))
          .filter(Boolean)
          .join(' '),
      );
    }
    rows.push(cells);
  }
  return rows;
}

/**
 * @param {Buffer | Uint8Array} input
 * @returns {{ blocks: Array<object>, images: Array<object>, warnings: Array<object> }}
 */
export function extractDocx(input) {
  const archive = openZip(input);
  const documentXml = archive.get('word/document.xml');
  if (!documentXml) throw new ZipError('DOCX 里没有 word/document.xml');

  const sink = createBlockSink({ name: 'docx' });
  const xml = documentXml.toString('utf8');

  for (const match of xml.matchAll(BODY_BLOCK_RE)) {
    const chunk = match[0];
    if (chunk.startsWith('<w:tbl')) {
      const rows = tableRows(chunk);
      if (rows.length > 0) {
        sink.add({ type: 'table', text: rows.map((row) => `| ${row.join(' | ')} |`).join('\n'), meta: { rows } });
      }
      continue;
    }

    const field = fieldText(chunk);
    if (field !== null) {
      sink.add({ type: 'formula', text: field, meta: { source: 'docx-field' } });
      continue;
    }

    const level = headingLevel(chunk);
    const text = paragraphText(chunk);
    if (level > 0) sink.add({ type: 'heading', text, level });
    else sink.add({ type: 'paragraph', text });
  }

  for (const entry of archive.entries) {
    if (!entry.name.startsWith('word/media/') || entry.name.endsWith('/')) continue;
    sink.addImage({ name: entry.name.slice('word/media/'.length), data: entry.buffer });
  }

  if (sink.blocks.length === 0) sink.warning('empty_material', '这个 DOCX 里没有可提取的文字');
  return sink.finish();
}
