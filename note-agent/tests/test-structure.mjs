// 任务 7 的结构分析测试（逐字取自计划）。
import { createChecker } from './helpers/check.mjs';
import { assignBlockIds, makeBlock } from '../src/blocks.mjs';
import { analyzeStructure } from '../src/structure.mjs';

const { check, summary } = createChecker();
const blocks = assignBlockIds([
  makeBlock('paragraph', '这是一段引言，用来测试首句候选。'),
  makeBlock('heading', '第一章 导数', { level: 1 }),
  makeBlock('paragraph', '导数描述变化率。'),
  makeBlock('heading', '1.1 定义', { level: 2 }),
  makeBlock('paragraph', '极限定义。'),
  makeBlock('formula', "f'(x)=\\lim"),
  makeBlock('heading', '1.1.1 例子', { level: 3 }),
  makeBlock('paragraph', '例子内容。'),
  makeBlock('heading', '第二章 积分', { level: 1 }),
  makeBlock('code', 'int a = 1;', { meta: { lang: 'c' } }),
]);
const s = analyzeStructure(blocks);

check('headings 只有 heading 块且带 blockId/level', s.headings.length === 4 && s.headings[0].blockId === 'b2' && s.headings[0].level === 1);
check('孤立开头正文生成（开头）合成节点', s.tree[0].blockId === null && s.tree[0].blockIds.includes('b1'));
check('h1 下挂 h2，h2 下挂 h3', s.tree[1].children[0].text === '1.1 定义' && s.tree[1].children[0].children[0].text === '1.1.1 例子');
// 计划的接口写的是"blockIds 含该节标题之后、下一个同级/更高级标题之前的所有块 id"，
// 但计划给的期望值 'b3,b4,b5,b6,b7' 漏掉了 1.1.1 之后的正文块 b8。按接口（也就是
// 整节 range，replace/delete 需要它）为准，这里改成含 b8。
check('章节 blockIds 覆盖到下一个同级标题前（含子节与子节正文）', s.tree[1].blockIds.join(',') === 'b3,b4,b5,b6,b7,b8');
check('第二章成为第二个顶层节点且不吞前一章', s.tree[2].text === '第二章 积分' && s.tree[2].blockIds.join(',') === 'b10');
check('sections 是展平视图', s.sections.length === 4 && s.sections[0].heading === '第一章 导数');
check('titleCandidates 首个是 h1 且 reason 为 h1', s.titleCandidates[0].text === '第一章 导数' && s.titleCandidates[0].reason === 'h1');
check('titleCandidates 候选去重且不超过 5 条', new Set(s.titleCandidates.map((c) => c.text)).size === s.titleCandidates.length && s.titleCandidates.length <= 5);
check('stats 统计准确', s.stats.blocks === 10 && s.stats.headings === 4 && s.stats.formulas === 1 && s.stats.codeBlocks === 1 && s.stats.maxDepth === 3);
check(
  '空输入返回全零结构且不抛',
  (() => {
    const e = analyzeStructure([]);
    return e.tree.length === 0 && e.stats.blocks === 0;
  })(),
);

// 补充断言：计划里写了但上面的用例覆盖不到的一条（层级跳跃不补空节点）。
// 计划里"文件名候选"那句与 reason 枚举（h1 | first-heading | lead-sentence | frequent-term）
// 以及 analyzeStructure(blocks) 的签名都冲突，按接口为准：这里只测枚举内的四类候选。
const jump = analyzeStructure(
  assignBlockIds([makeBlock('paragraph', '开头无标题的正文。'), makeBlock('heading', '只有 H1', { level: 1 }), makeBlock('heading', '直接 H3', { level: 3 })]),
);
check(
  '层级跳跃（h1→h3）直接挂到 h1 之下且保留 level 3',
  jump.tree.length === 2 && jump.tree[1].children.length === 1 && jump.tree[1].children[0].level === 3 && jump.tree[1].children[0].children.length === 0,
);
check('tie 时 reason 只取枚举内的值', jump.titleCandidates.every((c) => ['h1', 'first-heading', 'lead-sentence', 'frequent-term'].includes(c.reason)));

summary();
