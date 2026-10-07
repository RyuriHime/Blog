/**
 * Markdown 渲染回归：把「渲染器坏过的地方」一条条钉住。
 *
 * 用法：node scripts/check-markdown.mjs
 *
 * 为什么单独搞一份：`src/markdown.js` 是全站唯一的正文渲染器
 * （帖子、回复、团队帖、积木页段落、通知摘要、`POST /api/markdown/preview` 都走它），
 * 但它原来的实现是「先整段转义、再一串 `replace`」——
 * 每一轮 replace 的产物都会变成下一轮的输入，于是链接被后面几轮啃掉，
 * 而所有既有测试都只喂了最简单的 `**加粗**`，一条都没照出来。
 *
 * 这里不追求覆盖 Markdown 规范，只钉**实际坏过、且用户看得见**的那些行为。
 * 每条断言都要能说出「以前错成什么样」，说不出来就不该待在这个文件里。
 */
import { markdownToPlainText, renderMarkdown } from '../src/markdown.js';
import { escapeHtmlWithWikiLinks } from '../src/modules/doc/blocks/text.js';
import { inSync } from './sync-markdown-core.mjs';

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${name}`);
    return true;
  }
  failed += 1;
  console.log(`  ❌ ${name}${detail ? `  —— ${detail}` : ''}`);
  return false;
}

/**
 * 用例表。`contains` 是必须出现的片段，`notContains` 是**绝不能**出现的片段
 * （后者才是以前真正出错的地方，比前者更值钱）。
 */
const CASES = [
  // ── 链接：用户点名的就是这一组 ────────────────────────────────────────
  {
    name: '站内路由链接 `#/…` 能点（以前被 sanitizeUrl 杀成 href="#"）',
    input: '[看这篇](#/post/12)',
    contains: ['<a href="#/post/12">看这篇</a>'],
    notContains: ['href="#"'],
  },
  {
    name: '相对路径链接能点（以前同样被杀成 href="#"）',
    input: '[文件](./docs/a.md)',
    contains: ['<a href="./docs/a.md">文件</a>'],
    notContains: ['href="#"'],
  },
  {
    name: '根路径链接能点',
    input: '[设置](/settings)',
    contains: ['<a href="/settings">设置</a>'],
    notContains: ['href="#"'],
  },
  {
    name: '站内链接不带 target=_blank（站内跳转不该开新标签页）',
    input: '[看这篇](#/post/12)',
    notContains: ['target="_blank"'],
  },
  {
    name: '外链带 target=_blank 且 rel 里带 noopener',
    input: '[外站](https://example.com/a)',
    contains: ['target="_blank"', 'noopener'],
  },
  {
    name: 'URL 里的括号完整保留（以前被截成 …/Foo_(bar）',
    input: '[维基](https://zh.wikipedia.org/wiki/Foo_(bar))',
    contains: ['href="https://zh.wikipedia.org/wiki/Foo_(bar)"'],
    notContains: ['(bar</a>)'],
  },
  {
    name: '链接可以带标题',
    input: '[外站](https://example.com "首页")',
    contains: ['title="首页"'],
  },
  {
    name: '链接标签里允许配平的方括号（以前整条不成链接）',
    input: '[a [b] c](/x)',
    contains: ['<a href="/x">a [b] c</a>'],
  },
  {
    name: '链接标签里的强调照常渲染',
    input: '[**重点**](/x)',
    contains: ['<a href="/x"><strong>重点</strong></a>'],
  },
  {
    name: '自动链接 `<https://…>` 仍然可用',
    input: '<https://auto.link/x>',
    contains: ['href="https://auto.link/x"'],
  },
  {
    name: 'mailto: 仍然可用',
    input: '[写信](mailto:a@b.com)',
    contains: ['href="mailto:a@b.com"'],
  },
  {
    name: '裸 URL 自动成链接',
    input: '看这里 https://bare.example.com/a 就好了',
    contains: ['<a href="https://bare.example.com/a"'],
  },
  {
    name: '裸 URL 结尾的中文标点不算进网址',
    input: '看 https://bare.example.com/a。',
    contains: ['href="https://bare.example.com/a"'],
    notContains: ['href="https://bare.example.com/a。"'],
  },
  {
    name: '裸 URL 结尾的英文句号不算进网址',
    input: 'See https://bare.example.com/a.',
    contains: ['href="https://bare.example.com/a"'],
    notContains: ['href="https://bare.example.com/a."'],
  },

  // ── 危险目标：宁可不链接，也不能假装能点 ─────────────────────────────
  {
    name: 'javascript: 伪协议不产生链接，也不留下协议名',
    input: '[点我](javascript:alert(1))',
    contains: ['点我'],
    notContains: ['<a ', 'javascript:'],
  },
  {
    name: 'data: 伪协议不产生链接',
    input: '[点我](data:text/html;base64,PHNjcmlwdD4=)',
    notContains: ['<a ', 'data:'],
  },
  {
    name: '协议相对地址 `//host` 不当成站内链接放行',
    input: '[点我](//evil.example.com/x)',
    notContains: ['<a '],
  },

  // ── 图片 ────────────────────────────────────────────────────────────
  {
    name: '带标题的图片是图片（以前被后面的链接规则吃掉，还留个 `!`）',
    input: '![图](/a.png "标题")',
    contains: ['<img src="/a.png"', 'alt="图"', 'title="标题"'],
    notContains: ['!<a'],
  },
  {
    name: '不带标题的图片照旧',
    input: '![图](/a.png)',
    contains: ['<img src="/a.png"', 'alt="图"'],
  },

  // ── 转义与代码 ───────────────────────────────────────────────────────
  {
    name: '反斜杠转义生效，且反斜杠本身不留在正文里（以前输出「\\<em>星号\\</em>」）',
    input: '字面 \\*星号\\* 不斜',
    contains: ['字面 *星号* 不斜'],
    notContains: ['<em>', '\\*'],
  },
  {
    name: '行内代码里的星号不会被当成斜体',
    input: '`a * b * c`',
    contains: ['<code>a * b * c</code>'],
    notContains: ['<em>'],
  },
  {
    name: '行内代码里的链接语法不会被解析',
    input: '`[x](/y)`',
    contains: ['<code>[x](/y)</code>'],
    notContains: ['<a '],
  },
  {
    name: 'HTML 被转义（没有裸 script 标签）',
    input: '<script>alert(1)</script>',
    contains: ['&lt;script&gt;'],
    notContains: ['<script>'],
  },
  {
    // 关键不是「有没有出现 onmouseover 这几个字」，而是它有没有**跑到 href 属性外面**。
    // 逃出去的话输出里会多出一个独立的属性（前面是空格），那才是注入。
    name: 'URL 里的引号被转义，不会从 href 属性里逃出去',
    input: '[x](https://a.com/?q="onmouseover=alert(1))',
    contains: ['&quot;'],
    notContains: [' onmouseover='],
  },

  // ── 表格（用户说的「图表」）────────────────────────────────────────────
  {
    name: 'GFM 表格渲染成 table（以前是一段带竖线的 <p>）',
    input: '| 列 | 值 |\n| --- | --- |\n| 甲 | 1 |',
    contains: ['<div class="md-table">', '<table>', '<thead>', '<th>列</th>', '<td>甲</td>'],
    notContains: ['<br>| --- |'],
  },
  {
    name: '表格对齐写法翻译成 style',
    input: '| a | b | c |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |',
    contains: ['text-align:center', 'text-align:right'],
  },
  {
    name: '表格前后的段落不会被吃进表格',
    input: '上面\n\n| a |\n| --- |\n| 1 |\n\n下面',
    contains: ['<p>上面</p>', '<p>下面</p>'],
  },
  {
    name: '代码块里的竖线不会触发表格',
    input: '```\n| a | b |\n| --- | --- |\n```',
    contains: ['md-code'],
    notContains: ['md-table'],
  },
  {
    name: '表格单元格里可以放链接',
    input: '| a |\n| --- |\n| [x](/y) |',
    contains: ['<td><a href="/y">x</a></td>'],
  },

  // ── 列表 ────────────────────────────────────────────────────────────
  {
    name: '嵌套无序列表真的嵌进去（以前被压平成三个同级 li）',
    input: '- 一级\n  - 二级\n    - 三级',
    contains: ['<li>一级<ul>', '<li>二级<ul>', '<li>三级</li>'],
  },
  {
    name: '嵌套有序列表同理',
    input: '1. 一\n   1. 二',
    contains: ['<ol>', '<li>一<ol>'],
  },
  {
    name: '顶层无序列表输出不变（既有测试钉着这一条）',
    input: '- 一\n- 二',
    contains: ['<ul><li>一</li><li>二</li></ul>'],
  },

  // ── 不能回归的老行为 ──────────────────────────────────────────────────
  {
    name: '行内公式原样留给前端 KaTeX（服务端从不排版公式）',
    input: '$a+b$',
    contains: ['$a+b$'],
  },
  {
    name: '块级公式仍然独占成段',
    input: '$$\nE = mc^2\n$$',
    contains: ['$$'],
  },
  {
    name: '正文紧挨着块级公式也要认出来',
    input: '上面一行\n$$\nE = mc^2\n$$\n下面一行',
    contains: ['$$'],
  },
  {
    name: '没收尾的 $$ 不吞掉后面的正文，也不原地打转',
    input: '$$\nE = mc^2\n\n后面的正文还在',
    contains: ['后面的正文还在'],
  },
  {
    name: '标题照旧',
    input: '# 标题',
    contains: ['<h1>标题</h1>'],
  },
  {
    name: '引用照旧',
    input: '> 引用一句话',
    contains: ['<blockquote>'],
  },
  {
    name: '分割线照旧',
    input: '---',
    contains: ['<hr>'],
  },
  {
    name: '围栏代码块带上语言类名',
    input: '```js\nconst a = 1;\n```',
    contains: ['class="md-code"', 'class="language-js"'],
  },
  {
    name: '段落里的换行变成 <br>',
    input: '第一行\n第二行',
    contains: ['<br>'],
  },
];

console.log('Markdown 渲染回归');
for (const testCase of CASES) {
  const html = renderMarkdown(testCase.input);
  const miss = (testCase.contains ?? []).filter((fragment) => !html.includes(fragment));
  const bad = (testCase.notContains ?? []).filter((fragment) => html.includes(fragment));
  const detail = [
    miss.length > 0 ? `缺少 ${miss.map((f) => JSON.stringify(f)).join(' ')}` : '',
    bad.length > 0 ? `不该出现 ${bad.map((f) => JSON.stringify(f)).join(' ')}` : '',
  ]
    .filter(Boolean)
    .join('；');
  check(testCase.name, detail === '', `${detail}｜实际输出 ${JSON.stringify(html).slice(0, 150)}`);
}

// ── 兜底拷贝不能漂移 ────────────────────────────────────────────────────
// note-agent 的「效果」预览在没有宿主时会动态 import 这份拷贝；
// 它以前是 `src/markdown.js` 的手抄副本，抄漏了块级 `$$`，而且没有任何东西会红。
console.log('兜底拷贝');
check('note-agent/src/markdown-core.mjs 与 src/markdown.js 正文逐字一致', inSync(), '跑 node scripts/sync-markdown-core.mjs');
{
  const samples = [
    '# 标题\n\n**加粗** 与 *斜体* 与 `代码`',
    '| a | b |\n| --- | --- |\n| 1 | 2 |',
    '- 一级\n  - 二级',
    '[站内](#/x) 和 [站外](https://a.com) 和 ![图](/a.png "t")',
    '$$ x $$\n\n正文',
    '',
  ];
  const diff = samples.find((s) => renderMarkdown(s) !== renderMarkdown(s));
  check('渲染器对自己的同一份输入是确定的', diff === undefined, `样本 ${JSON.stringify(diff)}`);
}

// ── 摘要（通知 / 卡片都用它）──────────────────────────────────────────────
console.log('markdownToPlainText');
{
  const plain = markdownToPlainText('**加粗** 和 [链接](https://a.com) 和 `代码`');
  check('去掉强调记号', !plain.includes('**'), plain);
  check('链接只留文字', plain.includes('链接') && !plain.includes('https://a.com'), plain);
  check('去掉行内代码的反引号', !plain.includes('`'), plain);
}
{
  const plain = markdownToPlainText('| 列 | 值 |\n| --- | --- |\n| 甲 | 1 |');
  check('表格不留下分隔行', !plain.includes('---'), plain);
  check('表格内容还在', plain.includes('列') && plain.includes('甲'), plain);
}
{
  const plain = markdownToPlainText('# 标题\n\n正文', 4);
  check('超过限度会截断', plain.length <= 4 + 1, plain);
}

// ── 积木页正文块：双链优先，其余交给行内渲染器 ─────────────────────────────
console.log('积木页正文块');
{
  const html = escapeHtmlWithWikiLinks('看 [[某页]] 和 [外链](https://a.com)');
  check('双链仍是 wiki 链接', html.includes('class="doc-wiki-link"') && html.includes('#/wiki/'), html);
  check('普通的 [文字](url) 也成链接了', html.includes('<a href="https://a.com"'), html);
}
{
  const html = escapeHtmlWithWikiLinks('标题里的 & 不能二次编码：[[A&B]]');
  check('双链目标只编码一次（& 不是 %26amp%3B）', html.includes('href="#/wiki/A%26B"'), html);
}
{
  const html = escapeHtmlWithWikiLinks('**加粗**\n第二行', { multiline: true });
  check('多行模式：强调生效且换行变 <br>', html.includes('<strong>加粗</strong>') && html.includes('<br>'), html);
}
{
  const html = escapeHtmlWithWikiLinks('<script>x</script>');
  check('积木页正文照样转义', !html.includes('<script>'), html);
}
{
  const html = escapeHtmlWithWikiLinks('[[没了]]', { existing: new Set(['还在']) });
  check('红链标记仍在', html.includes('is-missing'), html);
}

// ── 用例数量哨兵 ────────────────────────────────────────────────────────
// 有人「精简」掉一半用例时，这份检查必须自己叫出来。
check('用例数没被悄悄删掉', CASES.length >= 40, `实际 ${CASES.length} 条`);

console.log(`  通过 ${passed} 项，失败 ${failed} 项`);
console.log(`#RESULT ${JSON.stringify({ passed, failed })}`);
if (failed > 0) process.exitCode = 1;
