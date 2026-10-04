// 任务 6 的抽取编排测试。
// 计划里 `一源失败其余仍可用` 那条把 await 放在 check 外面（会先抛出来炸掉整个文件），
// 已改成先算再断言。
import { createChecker } from './helpers/check.mjs';
import { buildZip } from './helpers/zip-fixture.mjs';
import { extractMaterial, extractSession } from '../src/extract/index.mjs';

const { check, summary } = createChecker();

const md = { filename: 'a.md', mime: 'text/markdown', data: Buffer.from('# A\n\n正文', 'utf8') };
const docx = {
  filename: 'b.docx',
  mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  data: buildZip([
    { name: 'word/document.xml', data: '<w:document><w:body><w:p><w:r><w:t>B 正文</w:t></w:r></w:p></w:body></w:document>' },
  ]),
};
const brokenDocx = { filename: 'bad.docx', mime: '', data: Buffer.from('x') };

const single = await extractMaterial(md);
check('单源抽取带 kind/name/bytes', single.kind === 'text' && single.name === 'a.md' && single.bytes === md.data.length);
check('单源抽取出编号后的块', single.blocks[0].id === 'b1' && single.blocks[0].type === 'heading');
check('单源抽取同时给出 images 与 warnings 数组', Array.isArray(single.images) && Array.isArray(single.warnings));

const session = await extractSession([md, docx]);
const expectedIds = session.blocks.map((_, index) => `b${index + 1}`).join(',');
check('多源块统一连续编号（不重置）', session.blocks.map((block) => block.id).join(',') === expectedIds);
check('多源保留每源名字', session.sources.map((source) => source.name).join(',') === 'a.md,b.docx');
check('多源给出去重后的警告与图片数组', Array.isArray(session.warnings) && Array.isArray(session.images));

const partial = await extractSession([md, brokenDocx]);
check('一源失败其余仍可用', partial.sources.length === 2 && partial.sources[0].kind === 'text');
check(
  '【RF-1】失败源记为 failed 并带人话说明',
  partial.sources[1].kind === 'failed' &&
    typeof partial.sources[1].error.message === 'string' &&
    partial.sources[1].error.message.length > 0 &&
    partial.warnings.length > 0,
);

// 【回归】两份材料各带一张图时，图片 id 必须全局唯一。
// 以前每份文件的内嵌图计数器都从 1 重开 ⇒ 两张图都叫 img1，模型收到的
// 「图 1 对应 img1」与实际材料里的图对不上（多源上传时每张图都错位）。
const docxWithImage = (text) => ({
  filename: `${text}.docx`,
  mime: '',
  data: buildZip([
    {
      name: 'word/document.xml',
      data: `<w:document><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
    },
    { name: 'word/media/image1.png', data: 'PNGDATA', stored: true },
  ]),
});
const twoImages = await extractSession([docxWithImage('甲'), docxWithImage('乙')]);
const imageIds = twoImages.images.map((image) => image.id);
check(
  '【回归】多源内嵌图片 id 不撞车',
  twoImages.images.length === 2 && new Set(imageIds).size === 2 && imageIds[0] !== imageIds[1],
);
check('【回归】多源图片 id 仍然是 imgN 形状', imageIds.every((id) => /^img\d+$/.test(id)));

let code = '';
try {
  await extractSession([{ filename: 'bad.bin', mime: '', data: Buffer.from([0xff, 0xfe]) }]);
} catch (error) {
  code = error.code;
}
check('全部源失败时抛出最后一个错误码', code === 'notes_unsupported_type');

let manyCode = '';
try {
  await extractSession(Array.from({ length: 11 }, () => md));
} catch (error) {
  manyCode = error.code;
}
check('超过 10 个源被拒绝', manyCode === 'notes_bad_request');

let emptyCode = '';
try {
  await extractSession([]);
} catch (error) {
  emptyCode = error.code;
}
check('一个文件都没给时拒绝', emptyCode === 'notes_bad_request');

summary();
