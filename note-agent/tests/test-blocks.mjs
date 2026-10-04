// 任务 6 的块协议测试。
// 注意：计划里这条断言写得含糊，按计划 Step 4 的指示改成明确断言。
import { createChecker } from './helpers/check.mjs';
import { assignBlockIds, blocksToMarkdown, blocksToPlainText, countBlocks, makeBlock } from '../src/blocks.mjs';

const { check, summary } = createChecker();

const blocks = [
  makeBlock('heading', '导数', { level: 2 }),
  makeBlock('paragraph', '导数是变化率。'),
  makeBlock('code', 'const a = 1;', { meta: { lang: 'js' } }),
  makeBlock('table', '', { meta: { rows: [['量', '含义'], ["f'", '斜率']] } }),
  makeBlock('formula', "f'(x) = \\lim_{h\\to 0}", {}),
  makeBlock('image', '', { meta: { alt: '图 1 割线趋近切线', src: '/notes-assets/x.png' } }),
];

const numbered = assignBlockIds([{ type: 'paragraph', text: 'a', id: 'b99' }, { type: 'paragraph', text: 'b' }]);
check('assignBlockIds 从 b1 重排且忽略传入 id', numbered[0].id === 'b1' && numbered[1].id === 'b2');
check('assignBlockIds 不修改入参', blocks[0].id === undefined && blocks.every((block) => block.id === undefined));
check('assignBlockIds 返回新对象', numbered[0] !== blocks[0]);
check(
  'makeBlock 拒绝非法 type',
  (() => {
    try {
      makeBlock('nope', 'x');
      return false;
    } catch {
      return true;
    }
  })(),
);

const doc = assignBlockIds(blocks);
const md = blocksToMarkdown(doc);
check('markdown 标题用 ## 前缀', md.startsWith('## 导数'));
check('markdown 表格含分隔行', md.includes('| 量 | 含义 |') && md.includes('| --- | --- |'));
// 【真机验收 bug】抽取阶段会把源表格的分隔行留在 meta.rows 里（与 GFM 行号对齐），
// 渲染时如果无条件再补一行，草稿里就会出现两行 `| --- | --- |`。
check('已有分隔行的表格不再补一行（真机验收 bug）', (() => {
  const withSep = assignBlockIds([
    makeBlock('table', '', { meta: { rows: [['函数', '导数'], ['---', '---'], ['$x^n$', '$n x^{n-1}$']] } }),
  ]);
  const out = blocksToMarkdown(withSep);
  const seps = out.split('\n').filter((line) => /^\|\s*-{2,}/.test(line.trim()));
  return seps.length === 1 && out.includes('| 函数 | 导数 |') && out.includes('| $x^n$ | $n x^{n-1}$ |');
})());
check('没有分隔行的表格仍然补一行', (() => {
  const noSep = assignBlockIds([makeBlock('table', '', { meta: { rows: [['函数', '导数'], ['$x^n$', '$n x^{n-1}$']] } })]);
  const out = blocksToMarkdown(noSep);
  return out.split('\n').filter((line) => /^\|\s*-{2,}/.test(line.trim())).length === 1;
})());
check('markdown 公式用 $$ 包裹', md.includes("$$\nf'(x) = \\lim_{h\\to 0}\n$$"));
check('markdown 图片带 alt 与 src', md.includes('![图 1 割线趋近切线](/notes-assets/x.png)'));
check('markdown 代码用围栏并带语言', md.includes('```js\nconst a = 1;\n```'));
check('markdown 结尾无多余空行', md.endsWith('\n') === false);
// 【真机验收 bug】模型会把 `$$…$$` 一起写进 formula 块的 text；这里再包一层就废了。
check('formula 块自带 $$ 时 markdown 不双包（真机验收 bug）', (() => {
  const wrapped = assignBlockIds([makeBlock('formula', '$$f(x) = x^2$$')]);
  const out = blocksToMarkdown(wrapped);
  return out === '$$\nf(x) = x^2\n$$';
})());
check('formula 块自带 equation 环境时 markdown 归一为 $$', (() => {
  const env = assignBlockIds([makeBlock('formula', '\\begin{equation}\nE = mc^2\n\\end{equation}')]);
  const out = blocksToMarkdown(env);
  return out === '$$\nE = mc^2\n$$';
})());

const plain = blocksToPlainText(doc, 24000);
check('plain text 不含 markdown 围栏与管道', !plain.includes('```') && !plain.includes('| ---'));
check('plain text 里图片变成 [图片] 且标题保留', plain.includes('[图片]') && plain.includes('导数'));
const short = blocksToPlainText(doc, 12);
// 截断后的长度必须 <= limit（省略号也算在里面），否则前端把它塞进 24000 字符预算就会超。
check('plain text 超限时截断到上限内并补省略号', short.length <= 12 && short.endsWith('…'));

const counted = countBlocks(doc);
check('countBlocks 给出总数与分型', counted.total === 6 && counted.byType.heading === 1 && counted.byType.code === 1);

summary();
