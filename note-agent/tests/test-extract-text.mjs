import { createChecker } from './helpers/check.mjs';
import { extractText } from '../src/extract/text.mjs';

const { check, summary } = createChecker();
const src = ['# 导数', '', '导数是变化率。', '', '- 定义', '- 几何意义', '', '```js', 'const a = 1; // $$不解析$$', '```', '', '| 量 | 含义 |', '| --- | --- |', "| f' | 斜率 |", '', '$$', "f'(x) = \\lim_{h\\to 0} \\frac{f(x+h)-f(x)}{h}", '$$'].join('\r\n');

const { blocks, images, warnings } = extractText(Buffer.from(src, 'utf8'), { name: '导数.md' });
check('CRLF 输入被规整且首块是 h1', blocks[0].type === 'heading' && blocks[0].level === 1 && blocks[0].text === '导数');
check('段落合并连续行', blocks[1].type === 'paragraph' && blocks[1].text === '导数是变化率。');
check('列表识别为单个 list 块并保留条目', blocks[2].type === 'list' && blocks[2].text.includes('- 定义') && blocks[2].text.includes('- 几何意义'));
check('代码块是单个 code 块且语言为 js', blocks[3].type === 'code' && blocks[3].meta.lang === 'js');
check('【RF-4】代码块里的 $$ 不被当成公式块', blocks[3].text.includes('$$不解析$$') && blocks.filter((b) => b.type === 'formula').length === 1);
check('表格识别出二维行', blocks[4].type === 'table' && blocks[4].meta.rows[2][0] === "f'");
check('display math 识别为 formula 块', blocks[5].type === 'formula' && blocks[5].text.includes('\\lim_{h\\to 0}'));
check('block id 连续递增 b1…bn', blocks.map((b) => b.id).join(',') === blocks.map((_, i) => `b${i + 1}`).join(','));
check('纯文本没有图片也没有警告', images.length === 0 && warnings.length === 0);

const empty = extractText(Buffer.from('   \r\n\r\n', 'utf8'));
check('空材料给出 empty_material 警告而不是抛错', empty.blocks.length === 0 && empty.warnings[0].code === 'empty_material');

// ── 围栏收尾必须"同字符且不短于"开启围栏（GFM） ────────────────────
// 真机场景：文档里用 ```` ```` ```` 开了一段 shell 示例，示例正文里又有一行
// ``` 用来演示"怎么开代码块"。旧实现见到任意 ```/~~~ 就收尾，于是那段示例被腰斩。
const longerOpen = [
  '````shell',
  'echo 下面这样开代码块：',
  '```',
  'echo 结束',
  '````',
].join('\n');
const longerOpenOut = extractText(Buffer.from(longerOpen, 'utf8'));
check('【回归】短于开启围栏的反引号行不算收尾', longerOpenOut.blocks.length === 1 && longerOpenOut.blocks[0].type === 'code', JSON.stringify(longerOpenOut.blocks));
check('【回归】围栏里的演示行原样保留在代码块里', longerOpenOut.blocks[0].text.includes('```') && longerOpenOut.blocks[0].text.includes('echo 结束'), longerOpenOut.blocks[0].text);

const tildeCloses = ['```', 'code', '~~~', 'still code', '```'].join('\n');
const tildeOut = extractText(Buffer.from(tildeCloses, 'utf8'));
check('【回归】另一种围栏字符不能收尾', tildeOut.blocks.length === 1 && tildeOut.blocks[0].text.includes('~~~'), JSON.stringify(tildeOut.blocks));

const longerFence = ['~~~', 'a', '~~~~', 'b', '~~~'].join('\n');
const longerOut = extractText(Buffer.from(longerFence, 'utf8'));
check('【回归】更长的同字符围栏可以收尾', longerOut.blocks[0].text === 'a', JSON.stringify(longerOut.blocks[0].text));

// 🔴 真 bug 修复：第二条分隔行不再被当成数据行吞进表格。
// 用户从别处粘表格时很容易连着贴两条 `| --- |`，旧实现会把它算成一行数据
//（表格行数 +1、模型引用行号就错位）。
const doubleSeparator = [
  '| 量 | 含义 |',
  '| --- | --- |',
  '| --- | --- |',
  "| f' | 斜率 |",
].join('\n');
const tableOut = extractText(Buffer.from(doubleSeparator, 'utf8'));
check('【回归】连续两条分隔行不再被当成数据行', tableOut.blocks.length === 1 && tableOut.blocks[0].meta.rows.length === 3, JSON.stringify(tableOut.blocks.map((b) => b.meta?.rows?.length)));
check('【回归】被跳过的分隔行之后的数据行照常收进来', tableOut.blocks[0].meta.rows[2][0] === "f'", JSON.stringify(tableOut.blocks[0].meta.rows));

summary();
