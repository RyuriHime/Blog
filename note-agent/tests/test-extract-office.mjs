import { createChecker } from './helpers/check.mjs';
import { buildZip } from './helpers/zip-fixture.mjs';
import { extractDocx } from '../src/extract/docx.mjs';
import { extractPptx } from '../src/extract/pptx.mjs';
import { extractPdf } from '../src/extract/pdf.mjs';

const { check, summary } = createChecker();

/* ---------- DOCX ---------- */

const P = (text, style = '') =>
  `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t>${text}</w:t></w:r></w:p>`;

const docx = buildZip([
  { name: '[Content_Types].xml', data: '<Types/>' },
  {
    name: 'word/document.xml',
    data:
      `<w:document><w:body>${P('标题行', 'Heading1')}${P('正文一')}${P('正文二')}` +
      `<w:tbl><w:tr><w:tc>${P('列A')}</w:tc><w:tc>${P('列B')}</w:tc></w:tr></w:tbl>` +
      `</w:body></w:document>`,
  },
  { name: 'word/media/image1.png', data: 'PNGDATA', stored: true },
]);
const d = extractDocx(docx);
check('DOCX 标题样式 → heading level 1', d.blocks[0].type === 'heading' && d.blocks[0].level === 1 && d.blocks[0].text === '标题行');
check('DOCX 普通段落保留', d.blocks[1].text === '正文一' && d.blocks[2].text === '正文二');
check('DOCX 表格成 table 块', d.blocks[3].type === 'table' && d.blocks[3].meta.rows[0].join('|') === '列A|列B');
check('DOCX 内嵌图片带 dataUrl 与 mime', d.images[0].mime === 'image/png' && d.images[0].dataUrl.startsWith('data:image/png;base64,'));
// 真 bug：`addImage` 以前不写 `bytes`，于是 routes.mjs 的 `Number(image.bytes) || 0`
// 在附件表里永远存 0（面板与排查都看不出这张图多大）。这里量的是**原始字节**，
// 不是 base64 的长度（base64 约 1.37 倍）。
check('【回归】图片带上原始字节数（不是 base64 长度）', Number.isInteger(d.images[0].bytes) && d.images[0].bytes === 7 && d.images[0].dataUrl.length > d.images[0].bytes, JSON.stringify({ bytes: d.images[0].bytes, dataUrlLength: d.images[0].dataUrl.length }));
check('【回归】字节数与 dataUrl 解出来的长度一致', Buffer.from(d.images[0].dataUrl.split(',')[1], 'base64').length === d.images[0].bytes);

const spacedZip = buildZip([
  { name: 'word/document.xml', data: `<w:document><w:body>${P('标题行', 'heading 1')}${P('正文')}</w:body></w:document>` },
]);
const d2 = extractDocx(spacedZip);
check('DOCX 样式名大小写与空格不敏感', d2.blocks[0].type === 'heading' && d2.blocks[0].level === 1);

const chineseStyleZip = buildZip([
  { name: 'word/document.xml', data: `<w:document><w:body>${P('三级标题', '标题 3')}${P('正文')}</w:body></w:document>` },
]);
check('DOCX 中文「标题 3」样式认成 level 3', extractDocx(chineseStyleZip).blocks[0].level === 3);

const fieldZip = buildZip([
  {
    name: 'word/document.xml',
    data:
      '<w:document><w:body><w:p><w:r><w:instrText xml:space="preserve"> EMBED Equation.3 \\* MERGEFORMAT </w:instrText></w:r>' +
      '<w:r><w:t>x^2 + y^2 = z^2</w:t></w:r></w:p></w:body></w:document>',
  },
]);
const field = extractDocx(fieldZip).blocks[0];
check('DOCX 公式域 → formula 块', field.type === 'formula' && field.meta.source === 'docx-field' && field.text.includes('x^2'));

const bigImageZip = buildZip([
  { name: 'word/document.xml', data: `<w:document><w:body>${P('正文')}</w:body></w:document>` },
  { name: 'word/media/image1.png', data: Buffer.alloc(2 * 1024 * 1024 + 1, 1), stored: true },
]);
const bigImage = extractDocx(bigImageZip);
check('DOCX 超过 2MB 的图片被跳过并给警告', bigImage.images.length === 0 && bigImage.warnings.some((w) => w.code === 'image_skipped'));

const oddImageZip = buildZip([
  { name: 'word/document.xml', data: `<w:document><w:body>${P('正文')}</w:body></w:document>` },
  { name: 'word/media/image1.emf', data: 'EMFDATA', stored: true },
]);
check('DOCX 不支持的图片格式被跳过并给警告', extractDocx(oddImageZip).images.length === 0 && extractDocx(oddImageZip).warnings.some((w) => w.code === 'image_skipped'));

let code = '';
try {
  extractDocx(buildZip([{ name: 'x.txt', data: 'no document' }]));
} catch (e) {
  code = e.code;
}
check('【RF-1】缺 word/document.xml 抛 zip_bad_archive', code === 'zip_bad_archive');

let code2 = '';
try {
  extractDocx(Buffer.from('这根本不是 ZIP'));
} catch (e) {
  code2 = e.code;
}
check('【RF-1】完全不是 ZIP 也是 zip_bad_archive', code2 === 'zip_bad_archive');

/* ---------- PPTX ---------- */

const slide = (text) =>
  `<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;

const pptx = buildZip([
  { name: 'ppt/slides/slide10.xml', data: slide('第十页') },
  { name: 'ppt/slides/slide2.xml', data: slide('第二页') },
  { name: 'ppt/slides/slide1.xml', data: '<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>第一页 标题</a:t></a:r></a:p><a:p><a:r><a:t>第一页 要点</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>' },
  { name: 'ppt/media/image1.png', data: 'P', stored: true },
]);
const p = extractPptx(pptx);
const headings = p.blocks.filter((b) => b.type === 'heading');
check('PPTX 幻灯片按数值排序（slide2 在 slide10 前）', headings[1].text === '第二页' && headings[2].text === '第十页');
check('PPTX 每页一个 heading 且 level 为 2', headings.length === 3 && headings.every((b) => b.level === 2));
check('PPTX 同页其余文字合成正文块', p.blocks.some((b) => b.type === 'paragraph' && b.text.includes('第一页 要点')));
check('PPTX 图片被收集', p.images.length === 1 && p.images[0].mime === 'image/png');

let code3 = '';
try {
  extractPptx(buildZip([{ name: 'ppt/presentation.xml', data: '<p:presentation/>' }]));
} catch (e) {
  code3 = e.code;
}
check('【RF-1】没有幻灯片时抛 zip_bad_archive', code3 === 'zip_bad_archive');

/* ---------- PDF ---------- */

const stream = (text) => Buffer.from(`BT /F1 12 Tf (${text}) Tj ET`, 'latin1');
const pdfSource = Buffer.concat([
  Buffer.from('%PDF-1.4\n1 0 obj\n/Type /Page\nendobj\n2 0 obj\n<< /Length 40 >>\nstream\n', 'latin1'),
  stream('Derivative is a rate.'),
  Buffer.from('\nendstream\nendobj\n%%EOF', 'latin1'),
]);
const pdf = extractPdf(pdfSource);
check('PDF 抽出 Tj 文本并成为 paragraph', pdf.blocks[0].type === 'paragraph' && pdf.blocks[0].text.includes('Derivative is a rate.'));

const escaped = extractPdf(Buffer.from('%PDF-1.4\nstream\nBT (\\(a\\) and \\\\b) Tj ET\nendstream\n%%%%EOF', 'latin1'));
check('PDF 抽出转义括号与反斜杠', escaped.blocks[0].text === '(a) and \\b');

// 【回归】TJ 数组里含 `]` 时不能提前截断。
// 以前用 source.indexOf(']') 找数组结束符，字符串内部的 `]`（PDF 引注里很常见）
// 会让扫描提前结束，随后的 /^\s*TJ/ 判定失败 ⇒ 整段文字被静默丢掉。
const tjArray = extractPdf(
  Buffer.from('%PDF-1.4\nstream\nBT [(see [1]) -250 (and (2))] TJ ET\nendstream\n%%%%EOF', 'latin1'),
);
check(
  '【回归】TJ 数组里含 ] 也能整段抽出',
  tjArray.blocks[0]?.type === 'paragraph' && tjArray.blocks[0].text === 'see [1]and (2)',
);

const tjEscaped = extractPdf(
  Buffer.from('%PDF-1.4\nstream\nBT [(a\\]b) -250 (c)] TJ ET\nendstream\n%%%%EOF', 'latin1'),
);
check('【回归】TJ 数组里的转义 ] 也照常处理', tjEscaped.blocks[0]?.text === 'a]bc');

const scan = extractPdf(Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nstream\n', 'latin1'));
check('【RF-2】没有文本层时给 pdf_no_text_layer 警告且 blocks 为空', scan.blocks.length === 0 && scan.warnings[0].code === 'pdf_no_text_layer');
check('【RF-2】PDF 解析绝不抛异常', (() => {
  try {
    extractPdf(Buffer.from('not a pdf at all'));
    return true;
  } catch {
    return false;
  }
})());

summary();
