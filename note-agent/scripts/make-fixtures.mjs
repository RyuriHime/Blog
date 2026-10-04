/**
 * 生成测试夹具：`tests/fixtures/{sample.docx,sample.pptx,text-only.pdf,scanned.pdf}`。
 *
 * 为什么要造这些文件而不是提交二进制：本仓库零依赖、无版本控制，二进制进仓库没法 review；
 * 造出来还能精确控制"含表格 / 含图片 / 无文本层"这些分支。跑一次即可，产物已提交。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { buildZip, tinyPng } from '../src/zip-write.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '..', 'tests', 'fixtures');

const PNG = tinyPng();

/** 一份最小但合法的 DOCX：h1 标题 + 两段正文 + 一个表格 + 一张内嵌图。 */
function makeDocx() {
  const paragraph = (text, extra = '') => `<w:p>${extra}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
${paragraph('第一章 导数', '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>')}
${paragraph('导数是函数在某一点的变化率，记作 $f\'(x)$。')}
${paragraph('求导的基本法则包括乘积法则与链式法则。')}
<w:tbl>
<w:tr><w:tc><w:p><w:r><w:t>函数</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>导数</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>x^2</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>2x</w:t></w:r></w:p></w:tc></w:tr>
</w:tbl>
${paragraph('下图是切线示意图。')}
<w:p><w:r><w:drawing><wp:inline><a:graphic><a:blip r:embed="rId5"/></a:graphic></wp:inline></w:drawing></w:r></w:p>
</w:body>
</w:document>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  return buildZip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'word/document.xml', data: document },
    { name: 'word/media/image1.png', data: PNG },
  ]);
}

/** 三张幻灯片的 PPTX，其中第二张带图片；特意让文件名是 slide1/2/10 之外的顺序。 */
function makePptx() {
  const slide = (title, body, withImage = false) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
<p:cSld><p:spTree>
<p:sp><p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p><a:p><a:r><a:t>${body}</a:t></a:r></a:p></p:txBody></p:sp>
${withImage ? '<p:sp><p:pic><p:blipFill><a:blip r:embed="rId9"/></p:blipFill></p:pic></p:sp>' : ''}
</p:spTree></p:cSld>
</p:sld>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
</Types>`;

  return buildZip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>' },
    { name: 'ppt/slides/slide1.xml', data: slide('第一讲 极限', '极限是导数的基础') },
    { name: 'ppt/slides/slide2.xml', data: slide('第二讲 导数', '导数是变化率', true) },
    { name: 'ppt/slides/slide10.xml', data: slide('第十讲 积分', '积分是导数的逆运算') },
    { name: 'ppt/media/image1.png', data: PNG },
  ]);
}

/**
 * 手写一个带文本层的极简 PDF：内容流用 FlateDecode（真实 PDF 的常见形式），解压后有 `(…) Tj`。
 *
 * 文本特意用 ASCII：PDF 的字面字符串按 latin1 字节流编码，非 ASCII 需要 CID 字体与 ToUnicode 映射，
 * 我们的抽取器（有意）不解析 ToUnicode —— 中文材料的测试由 docx/pptx 夹具覆盖。
 */
function makeTextPdf() {
  const lines = ['Chapter 1 Derivatives', 'A derivative is a rate of change.', "f'(x) = lim (f(x+h)-f(x))/h"];
  const content = `BT /F1 12 Tf 72 720 Td 14 TL\n${lines.map((line) => `(${line.replace(/([()\\])/g, '\\$1')}) Tj T*`).join('\n')}\nET`;
  const packed = deflateSync(Buffer.from(content, 'latin1'));
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${packed.length} /Filter /FlateDecode >>\nstream\n${packed.toString('latin1')}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  return assemblePdf(objects);
}

/** 扫描件：只有图片流，没有任何文本操作符 —— 用来测 `pdf_no_text_layer`。 */
function makeScannedPdf() {
  const imageData = '0'.repeat(256);
  const content = 'q 595 0 0 842 0 0 cm /Im0 Do Q';
  const packed = deflateSync(Buffer.from(content, 'latin1'));
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /XObject << /Im0 5 0 R >> >> >>',
    `<< /Length ${packed.length} /Filter /FlateDecode >>\nstream\n${packed.toString('latin1')}\nendstream`,
    `<< /Type /XObject /Subtype /Image /Width 16 /Height 16 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${imageData.length} >>\nstream\n${imageData}\nendstream`,
  ];
  return assemblePdf(objects);
}

/** 拼出合法的 xref/trailer。offsets 按 latin1 字节算，所以全程用 latin1 拼字符串。 */
function assemblePdf(objects) {
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

export function writeFixtures() {
  mkdirSync(FIXTURES, { recursive: true });
  const written = [];
  const put = (name, data) => {
    const path = join(FIXTURES, name);
    writeFileSync(path, data);
    written.push({ name, bytes: data.length });
  };
  put('sample.docx', makeDocx());
  put('sample.pptx', makePptx());
  put('text-only.pdf', makeTextPdf());
  put('scanned.pdf', makeScannedPdf());
  return written;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const written = writeFixtures();
  console.log(`已生成 ${written.length} 个夹具于 ${FIXTURES}`);
  for (const item of written) console.log(`  ${item.name}  ${item.bytes} 字节`);
}
