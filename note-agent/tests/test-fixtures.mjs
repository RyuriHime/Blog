import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChecker } from './helpers/check.mjs';
import { extractMaterial } from '../src/extract/index.mjs';

/**
 * 夹具是 `scripts/make-fixtures.mjs` 生成的（零依赖、可复现）。
 * 这些断言同时验证两件事：夹具本身是"真"的容器，抽取器能读懂它们。
 */
const { check, summary } = createChecker();
const HERE = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(join(HERE, 'fixtures', name));

const docx = await extractMaterial({ filename: 'sample.docx', data: read('sample.docx') });
check('sample.docx 抽出 heading + 两段正文 + 表格 + 图', docx.kind === 'docx' && docx.blocks.length === 5 && docx.images.length === 1);
check('sample.docx 的 Heading1 变成 h1', docx.blocks[0].type === 'heading' && docx.blocks[0].level === 1 && docx.blocks[0].text === '第一章 导数');
check('sample.docx 的表格保留 rows 二维结构', (() => {
  const table = docx.blocks.find((b) => b.type === 'table');
  return table.meta.rows.length === 2 && table.meta.rows[0][0] === '函数' && table.meta.rows[1][1] === '2x';
})());
check('sample.docx 的内嵌图带上 dataUrl', docx.images[0].mime === 'image/png' && docx.images[0].dataUrl.startsWith('data:image/png;base64,'));

const pptx = await extractMaterial({ filename: 'sample.pptx', data: read('sample.pptx') });
check('sample.pptx 抽出 3 页 × 2 块', pptx.kind === 'pptx' && pptx.blocks.length === 6);
check('sample.pptx 按幻灯片数值排序（slide10 最后）', pptx.blocks[4].text === '第十讲 积分');

const pdf = await extractMaterial({ filename: 'text-only.pdf', data: read('text-only.pdf') });
check('text-only.pdf 抽出可读文本', pdf.kind === 'pdf' && pdf.blocks.length === 1 && pdf.blocks[0].text.includes('Chapter 1 Derivatives'));
check('【RF-2】text-only.pdf 不报"没有文本层"', pdf.warnings.every((w) => w.code !== 'pdf_no_text_layer'));

const scanned = await extractMaterial({ filename: 'scanned.pdf', data: read('scanned.pdf') });
check('【RF-2】scanned.pdf 明确报 pdf_no_text_layer 而不是抛错', scanned.blocks.length === 0 && scanned.warnings.some((w) => w.code === 'pdf_no_text_layer'));

summary();
