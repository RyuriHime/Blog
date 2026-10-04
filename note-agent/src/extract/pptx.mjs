/**
 * PPTX 抽取：每张幻灯片 → heading + 正文块（+ 表格块）。
 *
 * 幻灯片顺序按文件名里的数字排（slide2 在 slide10 前），这一点很容易踩坑：
 * 按字典序排会把 slide10 排到 slide2 前面。
 */
import { openZip, ZipError } from '../zip.mjs';
import { createBlockSink, normalizeText } from './common.mjs';

const SLIDE_NAME_RE = /^ppt\/slides\/slide(\d+)\.xml$/;
const BODY_BLOCK_RE = /<a:tbl\b[\s\S]*?<\/a:tbl>|<p:sp\b[\s\S]*?<\/p:sp>/g;
const ROW_RE = /<a:tr\b[\s\S]*?<\/a:tr>/g;
const CELL_RE = /<a:tc\b[\s\S]*?<\/a:tc>/g;
const TEXT_RE = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g;

function texts(xml) {
  const out = [];
  for (const match of String(xml ?? '').matchAll(TEXT_RE)) {
    const text = normalizeText(match[1]);
    if (text.length > 0) out.push(text);
  }
  return out;
}

function tableRows(xml) {
  const rows = [];
  for (const rowMatch of String(xml ?? '').matchAll(ROW_RE)) {
    const cells = [];
    for (const cellMatch of rowMatch[0].matchAll(CELL_RE)) cells.push(texts(cellMatch[0]).join(' '));
    rows.push(cells);
  }
  return rows;
}

/**
 * @param {Buffer | Uint8Array} input
 * @returns {{ blocks: Array<object>, images: Array<object>, warnings: Array<object> }}
 */
export function extractPptx(input) {
  const archive = openZip(input);
  const slides = archive.entries
    .map((entry) => ({ entry, index: SLIDE_NAME_RE.exec(entry.name) }))
    .filter((item) => item.index !== null)
    .map((item) => ({ name: item.entry.name, number: Number(item.index[1]), buffer: item.entry.buffer }))
    .sort((a, b) => a.number - b.number);

  if (slides.length === 0) throw new ZipError('PPTX 里没有 ppt/slides/slideN.xml');

  const sink = createBlockSink({ name: 'pptx' });

  for (const [position, slide] of slides.entries()) {
    const xml = slide.buffer.toString('utf8');
    let heading = '';

    for (const match of xml.matchAll(BODY_BLOCK_RE)) {
      const chunk = match[0];
      if (chunk.startsWith('<a:tbl')) {
        const rows = tableRows(chunk);
        if (rows.length > 0) {
          sink.add({ type: 'table', text: rows.map((row) => `| ${row.join(' | ')} |`).join('\n'), meta: { rows } });
        }
        continue;
      }

      const parts = texts(chunk);
      if (parts.length === 0) continue;
      if (heading === '') {
        heading = parts[0];
        sink.add({ type: 'heading', text: heading, level: 2 });
        if (parts.length > 1) sink.add({ type: 'paragraph', text: parts.slice(1).join(' · ') });
      } else {
        sink.add({ type: 'paragraph', text: parts.join(' · ') });
      }
    }

    if (heading === '') sink.add({ type: 'heading', text: `第 ${position + 1} 张幻灯片`, level: 2 });
  }

  for (const entry of archive.entries) {
    if (!entry.name.startsWith('ppt/media/') || entry.name.endsWith('/')) continue;
    sink.addImage({ name: entry.name.slice('ppt/media/'.length), data: entry.buffer });
  }

  return sink.finish();
}
