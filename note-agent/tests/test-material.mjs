import { createChecker } from './helpers/check.mjs';
import { assignBlockIds, makeBlock } from '../src/blocks.mjs';
import { analyzeStructure } from '../src/structure.mjs';
import { buildMaterial, buildMessages, DEFAULT_CHAR_BUDGET, estimateChars } from '../src/material.mjs';

const { check, summary } = createChecker();

const blocks = assignBlockIds([
  makeBlock('heading', '导数', { level: 1 }),
  makeBlock('paragraph', '导数是变化率。'),
  makeBlock('code', 'x'.repeat(500), { meta: { lang: 'js' } }),
  makeBlock('heading', '积分', { level: 1 }),
  makeBlock('paragraph', '积分是累积。'),
]);
const structure = analyzeStructure(blocks);

const m = buildMaterial(blocks, [], { charBudget: DEFAULT_CHAR_BUDGET, structure });
check('默认预算 24000', DEFAULT_CHAR_BUDGET === 24000);
check('材料含结构大纲与正文两段', m.text.includes('## 材料结构') && m.text.includes('## 材料正文'));
check('正文每块带 id 前缀', m.text.includes('[b2] 导数是变化率。'));
check('未超预算时不丢块', m.droppedBlocks.length === 0 && m.usedBlocks.length === 5);
check('heading 块在正文里带层级标记', m.text.includes('[b1] # 导数') && m.text.includes('[b4] # 积分'));
check('formula 块用 $$ 包裹', (() => {
  const withFormula = assignBlockIds([makeBlock('formula', 'a^2 + b^2 = c^2')]);
  const built = buildMaterial(withFormula, [], {});
  return built.text.includes('$$\na^2 + b^2 = c^2\n$$');
})());
// 【真机验收发现】模型从材料里看到 `$$` 会照样写回 op.text，于是 formula 块的 text
// 自带定界符，再包一层就成了 `$$\n$$\n…`，宿主渲染器与 KaTeX 都认不出来。
check('formula 块自带 $$ 时不再套一层（真机验收 bug）', (() => {
  const withFormula = assignBlockIds([makeBlock('formula', '$$f(x) = x^2$$')]);
  const built = buildMaterial(withFormula, [], {});
  return !built.text.includes('$$$') && built.text.includes('$$\nf(x) = x^2\n$$');
})());
check('formula 块自带 equation 环境时归一为 $$', (() => {
  const withFormula = assignBlockIds([makeBlock('formula', '\\begin{equation}\nE = mc^2\n\\end{equation}')]);
  const built = buildMaterial(withFormula, [], {});
  return built.text.includes('$$\nE = mc^2\n$$') && !built.text.includes('\\begin{equation}');
})());
check('image 块写成 markdown 图片', (() => {
  const withImage = assignBlockIds([makeBlock('image', '示意图', { meta: { src: 'a.png' } })]);
  const built = buildMaterial(withImage, [], {});
  return built.text.includes('![示意图](a.png)');
})());
check('estimateChars 与 text.length 同口径', estimateChars(m.text) === m.text.length);

const small = buildMaterial(blocks, [], { charBudget: 60, structure });
check('超预算时整块丢弃（不截断半块）', small.chars <= 60 + 200 && small.droppedBlocks.length > 0);
check('丢弃从最后开始且 heading 优先保留', small.usedBlocks.map((b) => b.id).includes('b5') === false && small.usedBlocks.map((b) => b.id).includes('b1'));
check('被丢的块都在 droppedBlocks 里', small.droppedBlocks.includes('b5'));

// 优先级：预算刚好只够放下 heading + 一段时，先丢段落而不是 heading
// （注意预算要大于结构大纲本身，否则会把所有正文都丢掉，测不到优先级）
const twoPara = assignBlockIds([
  makeBlock('heading', 'A', { level: 1 }),
  makeBlock('paragraph', '第一段' + '啊'.repeat(30)),
  makeBlock('paragraph', '第二段' + '啊'.repeat(30)),
]);
const full = buildMaterial(twoPara, [], {});
const tight = buildMaterial(twoPara, [], { charBudget: full.chars - 1 });
check('段落先于 heading 被丢', tight.droppedBlocks.includes('b3') && !tight.droppedBlocks.includes('b2') && tight.usedBlocks.some((b) => b.id === 'b1'));

const assets = [
  { blockId: 'b9', name: 'i9.png', dataUrl: 'data:image/png;base64,QQ==', mime: 'image/png', bytes: 1 },
  { blockId: 'b2', name: 'i2.png', dataUrl: 'data:image/png;base64,QQ==', mime: 'image/png', bytes: 1 },
  ...Array.from({ length: 5 }, (_, i) => ({ blockId: `b${20 + i}`, name: `i${i}.png`, dataUrl: 'data:image/png;base64,QQ==', mime: 'image/png', bytes: 1 })),
];
const withImages = buildMaterial(blocks, assets, { structure });
check('图片按 blockId 升序取前 6 张', withImages.images.length === 6 && withImages.images[0].blockId === 'b2' && withImages.images[5].blockId === 'b23');
check('图片顺序确实是 blockId 数字升序', withImages.images.map((i) => i.blockId).join(',') === 'b2,b9,b20,b21,b22,b23');

const tooBig = buildMaterial(blocks, [{ blockId: 'b2', name: 'big.png', dataUrl: 'data:image/png;base64,QQ==', mime: 'image/png', bytes: 3 * 1024 * 1024 }], { structure });
check('超过 2MB 的图片被跳过并在材料中留痕', tooBig.images.length === 0 && tooBig.text.includes('超过 2MB'));

const noImage = buildMessages({ system: 'S', material: m.text, draft: '# 草稿', requirement: '按主题重组' });
check('无图片时 user.content 是字符串', typeof noImage[1].content === 'string' && noImage[1].content.includes('按主题重组') && noImage[1].content.includes('# 草稿'));
check('system 段原样透传', noImage[0].role === 'system' && noImage[0].content === 'S');

const withImage = buildMessages({ system: 'S', material: m.text, draft: '', requirement: '', images: withImages.images.slice(0, 2) });
check('有图片时 content 为多模态数组且含 image_url', Array.isArray(withImage[1].content) && withImage[1].content[1].type === 'image_url' && withImage[1].content[1].image_url.url.startsWith('data:image/png'));
check('requirement 为空时省略该段', !withImage[1].content[0].text.includes('用户最新要求'));
check('有图片时文本里带图号与块 id 锚点', withImage[1].content[0].text.includes('[图 1 对应 b2]'));
check('多模态数组里图片项数量与 images 一致', withImage[1].content.filter((item) => item.type === 'image_url').length === 2);

summary();
