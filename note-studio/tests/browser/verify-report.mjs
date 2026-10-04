/**
 * 校验验收报告本身：用 jsdom 加载 acceptance/output/acceptance-report.html，
 * 让它像浏览器一样加载 ../../public/ 下的真实资源，确认报告里的「渲染结果」确实渲染出来了。
 *
 * 运行：
 *   NODE_PATH=<装有 jsdom 的 node_modules> node tests/browser/verify-report.mjs
 *   REPORT=/path/to/acceptance-report.html node tests/browser/verify-report.mjs
 */
import { createRequire } from 'node:module';
import { readFile, access } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { JSDOM } = require(process.env.JSDOM_PATH || 'jsdom');

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const REPORT = process.env.REPORT || join(ROOT, 'acceptance', 'output', 'acceptance-report.html');
const PHOTO = process.env.PHOTO || join(ROOT, 'acceptance', 'sample', 'sample-note-photo.png');

const html = await readFile(REPORT, 'utf8');
const dom = new JSDOM(html, {
  url: pathToFileURL(REPORT).href,
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
});
const { window } = dom;
window.TextEncoder = TextEncoder;

await new Promise((resolve) => {
  window.addEventListener('load', resolve);
  setTimeout(resolve, 8000);
});
await new Promise((resolve) => setTimeout(resolve, 500));

const preview = window.document.getElementById('preview');

// 只看「可见文字」有没有残留 $ 源码：KaTeX 的 MathML 里本来就带着原始 TeX，而且被 CSS 隐藏。
const visible = preview.cloneNode(true);
visible.querySelectorAll('.katex-mathml').forEach((node) => node.remove());
const visibleText = visible.textContent;

const checks = [
  ['报告有结论横幅', Boolean(window.document.querySelector('.verdict'))],
  ['报告有验收标准表（≥15 行）', window.document.querySelectorAll('table tbody tr').length >= 15],
  ['渲染区块不再是「渲染中…」', !preview.textContent.trim().startsWith('渲染中')],
  ['渲染区块真的产出了 KaTeX 公式', preview.querySelectorAll('.katex').length >= 5],
  ['可见文字里没有残留 $ 源码', !/\$[^$\n]{2,}\$/.test(visibleText)],
  ['MathML annotation 保存了原始 TeX（可视化往返靠它）', preview.innerHTML.includes('application/x-tex')],
  ['渲染区块里有表格与任务清单', Boolean(preview.querySelector('table')) && Boolean(preview.querySelector('input[type=checkbox]'))],
  ['样例图片存在', await access(PHOTO).then(() => true).catch(() => false)],
];

let failed = 0;
for (const [name, ok] of checks) {
  if (!ok) failed += 1;
  console.log(`${ok ? '✔' : '✘'} ${name}`);
}
console.log('');
console.log(`报告中渲染出的公式数：${preview.querySelectorAll('.katex').length}`);
console.log(failed ? `FAIL：${failed} 项` : `PASS：${checks.length} 项检查全部通过`);
process.exit(failed ? 1 : 0);
