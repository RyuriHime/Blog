// 任务 8 的公式归一化测试（逐字取自计划，末尾补两条覆盖 normalizeBlocks 的边界）。
import { createChecker } from './helpers/check.mjs';
import { assignBlockIds, makeBlock } from '../src/blocks.mjs';
import { looksLikeFormula, normalizeFormulas, normalizeBlocks } from '../src/formulas.mjs';

const { check, summary } = createChecker();

check('【RF-4】\\[ … \\] 归一为 $$', normalizeFormulas('前面 \\[ a^2+b^2=c^2 \\] 后面') === '前面 $$\na^2+b^2=c^2\n$$ 后面');
check('【RF-4】\\( … \\) 归一为 $', normalizeFormulas('行内 \\(x+y\\) 结束') === '行内 $x+y$ 结束');
check('【RF-4】equation 环境归一为 $$ 并保留换行', normalizeFormulas('\\begin{equation}\na = b + c\n\\end{equation}') === '$$\na = b + c\n$$');
check('【RF-4】\\begin{align} 与星号变体同样处理', normalizeFormulas('\\begin{align*}\nx &= 1\n\\end{align*}') === '$$\nx &= 1\n$$');
check('【RF-4】已合法的 $$ 保持不动', normalizeFormulas('$$\nE = mc^2\n$$') === '$$\nE = mc^2\n$$');
check('【RF-4】行内代码里的 $ 不动', normalizeFormulas('用 `$x$` 表示变量') === '用 `$x$` 表示变量');
check('【RF-4】围栏代码块里的 \\[ \\] 不动', normalizeFormulas('```\n\\[ a \\]\n```') === '```\n\\[ a \\]\n```');
check('【RF-4】$ 未配平时整行不动', normalizeFormulas('价格是 $5 和 $6') === '价格是 $5 和 $6');
// 回归：未配平那一行必须**逐字**留下，同时同一段里其它行照常归一化。
// 以前的实现末尾还有一句 `dollarCount(line) % 2 === 0 ? line : line`（两分支相同、
// 什么都不做），所以这条真正钉的是 convertText 里的 balanced 回退逻辑。
check(
  '【回归】未配平的行原样保留，其余行照常归一化',
  normalizeFormulas('价格是 $5 和 $6\n公式 \\[x\\]\n再一句 $7') === '价格是 $5 和 $6\n公式 $$\nx\n$$\n再一句 $7',
  JSON.stringify(normalizeFormulas('价格是 $5 和 $6\n公式 \\[x\\]\n再一句 $7')),
);
const once = normalizeFormulas('文本 \\[x\\] 与 \\(y\\)');
check('【RF-4】幂等：再归一化不变', normalizeFormulas(once) === once);
check('looksLikeFormula 认得 $$ / \\[ / equation', looksLikeFormula('$$a$$') && looksLikeFormula('\\[a\\]') && looksLikeFormula('\\begin{align}\na\n\\end{align}'));
check('looksLikeFormula 拒绝普通句子', !looksLikeFormula('导数是变化率') && !looksLikeFormula('$5 和 $6'));

const result = normalizeBlocks(assignBlockIds([makeBlock('formula', '\\[ f(x) = x^2 \\]'), makeBlock('paragraph', '行内 \\(y\\)')]));
check('normalizeBlocks 去掉 formula 外层定界符并标 display', result.blocks[0].text === 'f(x) = x^2' && result.blocks[0].meta.display === true);
check('normalizeBlocks 报告改动块数', result.changed === 2);
check('normalizeBlocks 不修改入参', result.changed === 2 && result.blocks[0].text === 'f(x) = x^2');

// 补充：入参对象不被就地改写（计划 Step 3 明确要求"不修改入参对象"）。
const source = assignBlockIds([makeBlock('formula', '\\[ a \\]')]);
const normalized = normalizeBlocks(source);
check('normalizeBlocks 不改动入参对象', source[0].text === '\\[ a \\]' && source[0].meta === undefined && normalized.blocks[0] !== source[0]);

// 补充：$$ 定界符的 formula 块去掉 $$ 后 meta.display 仍为 true。
const display = normalizeBlocks(assignBlockIds([makeBlock('formula', '$$\nA = B\n$$')]));
check('已有 $$ 的 formula 块去定界符且标 display', display.blocks[0].text === 'A = B' && display.blocks[0].meta.display === true && display.changed === 1);

summary();
