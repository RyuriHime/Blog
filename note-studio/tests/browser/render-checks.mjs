/**
 * 渲染检查（可复用）：在 jsdom 里执行 note-studio 的**同一套**前端资源，返回检查结果。
 *
 * 由两处共用：
 *   - tests/browser/verify-render.mjs   （命令行自检，打印结果）
 *   - acceptance/run.mjs                （把结果写进验收报告）
 *
 * jsdom 只用于验证，不是本包的依赖。
 */
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const PUBLIC = fileURLToPath(new URL('../../public/', import.meta.url));

/** 样例：行内公式 + 块级公式 + 代码块里的 $ + 任务清单 + 表格。 */
export const RENDER_SAMPLE = [
  '# 渲染自检标题',
  '',
  '行内公式 $E = mc^2$ 与块级公式：',
  '',
  '$$',
  '\\int_0^1 x\\,dx = \\frac{1}{2}',
  '$$',
  '',
  '```js',
  'const price = 100; // 这里的 $ 不是公式，$HOME 也不是',
  '```',
  '',
  '- [x] 已完成的任务',
  '- [ ] 未完成的任务',
  '',
  '| A | B |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
].join('\n');

/** 载入 jsdom；失败时返回 null（调用方据此标记为「跳过」而不是「失败」）。 */
function loadJsdom() {
  try {
    const require = createRequire(import.meta.url);
    const { JSDOM } = require(process.env.JSDOM_PATH || 'jsdom');
    return JSDOM ?? null;
  } catch {
    return null;
  }
}

/**
 * 跑一遍渲染检查。
 * @returns {Promise<{ skipped: boolean, reason?: string, math?: number,
 *                     checks: Array<{name:string, ok:boolean}> }>}
 */
export async function runRenderChecks({ sample = RENDER_SAMPLE } = {}) {
  const JSDOM = loadJsdom();
  if (!JSDOM) {
    return { skipped: true, reason: '没有找到 jsdom（设置 JSDOM_PATH 或 NODE_PATH 后重试）', checks: [] };
  }

  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="host"></div></body></html>', {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'http://127.0.0.1/notes/selfcheck.html',
  });
  const { window } = dom;
  window.TextEncoder = TextEncoder;
  window.TextDecoder = TextDecoder;

  for (const file of [
    'vendor/marked/marked.min.js',
    'vendor/katex/katex.min.js',
    'vendor/katex/contrib/auto-render.min.js',
    'vendor/turndown/turndown.js',
    'vendor/turndown/turndown-plugin-gfm.js',
    'render.js',
  ]) {
    const element = window.document.createElement('script');
    element.textContent = await readFile(join(PUBLIC, file), 'utf8');
    window.document.head.appendChild(element);
  }

  const host = window.document.getElementById('host');
  const checks = [];
  const check = (name, ok) => checks.push({ name, ok });
  let math = 0;

  try {
    math = window.NoteRender.renderInto(host, sample).math;
    const meta = window.NoteRender.previewMeta(sample, 'self check');

    check('KaTeX 渲染出公式（≥2）', math >= 2);
    check('DOM 里有 .katex 节点', host.querySelectorAll('.katex').length >= 2);
    check('页面上不再残留 $ 源码', !host.textContent.includes('$E = mc^2$'));
    check('MathML annotation 保存了原始 TeX', (host.querySelector('annotation[encoding="application/x-tex"]')?.textContent ?? '').includes('E = mc^2'));
    check('标题渲染成 h1', Boolean(host.querySelector('h1')));
    check('代码块保留且内部不渲染公式', host.querySelectorAll('pre code').length === 1 && host.querySelectorAll('pre .katex').length === 0);
    check('表格渲染', Boolean(host.querySelector('table')));
    check('统计：行内公式=1', meta.math.inline === 1);
    check('统计：块级公式=1', meta.math.display === 1);
    check('统计：任务 2 项 / 完成 1 项', meta.tasks.total === 2 && meta.tasks.checked === 1);
    check('文件名消毒（self check → self-check）', meta.file.baseName === 'self-check');

    const turndown = new window.TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      bulletListMarker: '-',
      emDelimiter: '*',
      strongDelimiter: '**',
    });
    turndown.use(window.turndownPluginGfm.gfm);
    const markdown = window.NoteRender.createSerializer(turndown)(host);

    check('往返：标题保留', /^#\s*渲染自检标题/m.test(markdown));
    check('往返：行内公式还原为 $E = mc^2$', markdown.includes('$E = mc^2$'));
    check('往返：块级公式还原（反斜杠没被转义）', markdown.includes('$$') && markdown.includes('\\int_0^1'));
    check('往返：代码块保留', markdown.includes('```') && markdown.includes('$HOME'));
    check('往返：任务清单保留', /\[x\]/.test(markdown) && /\[ \]/.test(markdown));
    check('往返：表格保留', markdown.includes('| A | B |'));

    /* ---- 块级公式：各种写法都要渲染成块级，且结构合法 ---- */
    const insideParagraph = (element) => {
      let node = element.parentElement;
      while (node) {
        if (node.tagName === 'P') return true;
        node = node.parentElement;
      }
      return false;
    };

    const displayCases = [
      ['独占一段', '$$\n\\int_0^1 x\\,dx\n$$'],
      ['紧跟段落（中间没有空行）', '前面一段话\n$$\na=b\n$$'],
      ['写在一行里', '$$a^2+b^2=c^2$$'],
      ['紧跟在段落后面、块内含空行', '前言\n\n$$\n\nx = y\n\n$$\n'],
      ['文档开头就是', '$$\na=b\n$$\n\n后面是正文'],
      ['连续两个', '$$\na=b\n$$\n\n中间文字\n\n$$\nc=d\n$$\n'],
    ];
    for (const [name, markdownCase] of displayCases) {
      window.NoteRender.renderInto(host, markdownCase);
      const displays = [...host.querySelectorAll('.katex-display')];
      const nested = displays.filter(insideParagraph).length;
      check(
        `块级公式「${name}」渲染为块级且不嵌在 <p> 里`,
        displays.length > 0 && nested === 0,
        `渲染 ${displays.length} 个 · 其中嵌在 <p> 里 ${nested} 个`,
      );
    }

    /* ---- 行内公式扫描器（不用 lookbehind）的语义 ---- */
    const inlineCases = [
      ['$a$', 1, 0],
      ['$a$ 与 $b$', 2, 0],
      ['$a$ 与 $$b$$', 1, 1],
      ['未闭合的 $5 元', 0, 0],
      ['转义的 $a\\$b$', 1, 0],
    ];
    for (const [markdownCase, wantInline, wantDisplay] of inlineCases) {
      const counted = window.NoteRender.previewMeta(markdownCase, 'probe').math;
      check(
        `公式计数「${markdownCase}」= 行内 ${wantInline} / 块级 ${wantDisplay}`,
        counted.inline === wantInline && counted.display === wantDisplay,
        `实际 行内 ${counted.inline} / 块级 ${counted.display}`,
      );
    }

    const renderSource = await readFile(join(PUBLIC, 'render.js'), 'utf8');
    const withoutComments = renderSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    check('不使用正则 lookbehind（旧 Safari / Firefox 也能解析）', !/\(\?<[=!]/.test(withoutComments));

    return { skipped: false, math, roundTrip: markdown, checks };
  } catch (error) {
    check(`执行未抛异常（${error?.message ?? error}）`, false);
    return { skipped: false, math, roundTrip: '', checks };
  }
}
