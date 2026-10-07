/**
 * 交付包自带渲染兜底（TDD RED 先行）。
 *
 * 背景：面板的「效果」预览原本只认宿主自己的渲染接口 `POST <hostBase>/markdown/preview`。
 * 交付包被单独拷走时那个接口根本不存在（同事手上的站点没有它），预览就永久退化成原文，
 * 用户看到的是一个死掉的「效果」按钮。所以本包要自带一个渲染器，并在服务端把它作为
 * 静态资源发出去，让浏览器也能动态 import 它。
 */
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { createChecker } from './helpers/check.mjs';
import { loadMarkdown, markdownSource } from '../src/markdown.mjs';
import * as core from '../src/markdown-core.mjs';
import { inSync } from '../../scripts/sync-markdown-core.mjs';

const { check, skip, summary } = createChecker();

const HOST_RENDERER = new URL('../../src/markdown.js', import.meta.url);
const hasHost = existsSync(HOST_RENDERER);

const SAMPLE = [
  '# 标题',
  '',
  '正文一句话。',
  '',
  '- 一',
  '- 二',
  '',
  '```js',
  'const a = 1;',
  '```',
].join('\n');

// ── 1. 选路 ──────────────────────────────────────────────────────────────
check(
  '渲染器来源与「宿主在不在」的文件系统事实一致',
  markdownSource() === (hasHost ? 'host' : 'bundled'),
  `事实 ${hasHost ? 'host' : 'bundled'}，实际 ${markdownSource()}`,
);

check('loadMarkdown() 拿到的渲染函数可用', typeof loadMarkdown().renderMarkdown === 'function');

// ── 2. 渲染能力 ──────────────────────────────────────────────────────────
const rendered = loadMarkdown().renderMarkdown(SAMPLE);
check('渲染标题', /<h1>标题<\/h1>/.test(rendered), rendered);
check('渲染段落', /<p>正文一句话。<\/p>/.test(rendered), rendered);
check('渲染无序列表', /<ul><li>一<\/li><li>二<\/li><\/ul>/.test(rendered), rendered);
check('渲染围栏代码块并带上语言', /<pre class="md-code"><code class="language-js">/.test(rendered), rendered);

const xss = loadMarkdown().renderMarkdown('<img src=x onerror="alert(1)">\n\n<script>alert(2)</script>');
check('先转义 HTML 再注入白名单标签（没有裸 img）', !xss.includes('<img'), xss);
check('先转义 HTML 再注入白名单标签（没有裸 script）', !xss.includes('<script'), xss);
check('被转义的内容确实变成了实体', xss.includes('&lt;script&gt;'), xss);
check(
  'javascript: 伪协议被丢掉，不会变成链接',
  !loadMarkdown().renderMarkdown('[点我](javascript:alert(1))').includes('javascript:') &&
    !loadMarkdown().renderMarkdown('[点我](javascript:alert(1))').includes('<a '),
);
check(
  '行内代码里的星号不会被当成斜体',
  !loadMarkdown().renderMarkdown('看 `a * b * c` 这段').includes('<em>'),
);

// ── 3. 兜底拷贝必须与宿主「逐字一致」（真正的漂移守卫）───────────────────
// 这里原来比较的是 `loadMarkdown()` 与宿主本身 —— 而宿主在的时候 `loadMarkdown()`
// 返回的**就是**宿主自己的函数（见 src/markdown.mjs），所以那条断言恒真。
// 后果是真出过一次：宿主后来加了块级 `$$` 公式处理，这份拷贝没跟上，
// 面板「效果」预览里多行公式永远显示成源码，而所有测试还是绿的。
// 现在两层都查：先比两个文件的正文，再拿同一批输入比渲染输出。
if (hasHost) {
  const host = await import(HOST_RENDERER.href);

  check(
    '兜底拷贝的正文与宿主渲染器逐字一致（漂移守卫）',
    inSync(),
    '两个文件已经漂移 —— 跑一次 `node scripts/sync-markdown-core.mjs`',
  );

  const corpus = [
    SAMPLE,
    '',
    '> 引用\n\n---\n\n**粗体** 与 *斜体*',
    '1. 甲\n2. 乙',
    '- 一级\n  - 二级\n    - 三级',
    '上面一行\n$$\nE = mc^2\n$$\n下面一行',
    '| 列 | 值 |\n| --- | ---: |\n| 甲 | 1 |',
    '[站内](#/post/1) 和 [站外](https://a.com) 和 ![图](/a.png "标题")',
    '字面 \\*星号\\* 与 `代码` 与 ~~删掉~~',
  ];
  const renderDiff = corpus.find((s) => core.renderMarkdown(s) !== host.renderMarkdown(s));
  check(
    '同一批输入下，兜底渲染器与宿主逐字一致',
    renderDiff === undefined,
    `样本「${String(renderDiff).slice(0, 24)}」输出不同`,
  );

  const plainSamples = [
    '# 标题\n\n正文 *强调* 与 `代码`',
    '![图](a.png) 说明',
    'x'.repeat(200),
    '| 列 | 值 |\n| --- | --- |\n| 甲 | 1 |',
    '- 一\n  - 二',
  ];
  const plainDiff = plainSamples.find((s) => core.markdownToPlainText(s) !== host.markdownToPlainText(s));
  check(
    'markdownToPlainText 与宿主逐字一致',
    plainDiff === undefined,
    `样本「${String(plainDiff).slice(0, 24)}」输出不同`,
  );
} else {
  skip('兜底拷贝的正文与宿主渲染器逐字一致（漂移守卫）', '单独拷走的包，旁边没有宿主');
  skip('同一批输入下，兜底渲染器与宿主逐字一致', '单独拷走的包，旁边没有宿主');
  skip('markdownToPlainText 与宿主逐字一致', '单独拷走的包，旁边没有宿主');
}

// ── 4. 兜底渲染器本身也要能独立工作 ──────────────────────────────────────
check(
  '包自带的兜底渲染器能独立渲染同一份样本',
  core.renderMarkdown(SAMPLE).includes('<li>一</li>'),
);

// ── 5. 浏览器能不能用：发出去的那份必须零 Node 依赖 ─────────────────────
const coreSource = readFileSync(new URL('../src/markdown-core.mjs', import.meta.url), 'utf8');
check(
  '发给浏览器的渲染模块不含任何 node: 导入',
  !/from\s+'node:/.test(coreSource) && !/require\(/.test(coreSource),
  '含有 node: 导入，浏览器会直接报错',
);
check('发给浏览器的渲染模块导出面板要用的两个函数', /export function renderMarkdown/.test(coreSource) && /export function markdownToPlainText/.test(coreSource));

const bridgeSource = readFileSync(new URL('../src/markdown.mjs', import.meta.url), 'utf8');
check('负责探测宿主的桥只导给 Node（所以它自己可以 import node:module）', /node:module/.test(bridgeSource));

summary();
