/**
 * 操作样例的检查（可复用）：用 jsdom 打开 public/playground.html，真的去点按钮，
 * 确认页面不仅「能打开」，而且「能操作」：载入图片 → 转写 → 插入 → 切换模式 → 导出。
 *
 * 由两处共用：
 *   - tests/browser/verify-playground.mjs （命令行自检）
 *   - acceptance/run.mjs                  （写进验收报告，AC-16）
 */
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

const PUBLIC = fileURLToPath(new URL('../../public/', import.meta.url));

function loadJsdom() {
  try {
    const require = createRequire(import.meta.url);
    const { JSDOM } = require(process.env.JSDOM_PATH || 'jsdom');
    return JSDOM ?? null;
  } catch {
    return null;
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @returns {Promise<{ skipped: boolean, reason?: string,
 *                     checks: Array<{name:string, ok:boolean, extra?:string}>, math?: number }>}
 */
export async function runPlaygroundChecks() {
  const JSDOM = loadJsdom();
  if (!JSDOM) return { skipped: true, reason: '没有找到 jsdom（设置 JSDOM_PATH 或 NODE_PATH 后重试）', checks: [] };

  const page = join(PUBLIC, 'playground.html');
  const dom = new JSDOM(await readFile(page, 'utf8'), {
    url: pathToFileURL(page).href,
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  window.TextEncoder = TextEncoder;
  window.TextDecoder = TextDecoder;

  await new Promise((resolve) => {
    window.addEventListener('load', resolve);
    setTimeout(resolve, 8000);
  });
  await wait(300);

  const $ = (id) => window.document.getElementById(id);
  const checks = [];
  const check = (name, ok, extra = '') => checks.push({ name, ok, extra });
  const preview = $('preview');

  try {
    check('打开即载入样例笔记', $('source').value.includes('电磁感应实验记录'));
    const math = preview.querySelectorAll('.katex').length;
    check('打开即渲染出 KaTeX 公式', math >= 5, `${math} 个`);
    check('预览里有表格与任务清单', Boolean(preview.querySelector('table')) && Boolean(preview.querySelector('input[type=checkbox]')));
    check('徽标标明运行形态（服务端 / 离线）', /离线模式|服务端模式/.test($('modeBadge').textContent), $('modeBadge').textContent);
    check('文件数据面板有统计', $('stats').querySelectorAll('tr').length >= 10, `${$('stats').querySelectorAll('tr').length} 行`);
    check('JSON 预览可读', $('jsonView').textContent.includes('note-studio/document@1'));

    // ---- 手动编辑：清空后自己打字（这是最该被验的一条：它不是只读页面）----
    const fire = (el, type) => el.dispatchEvent(new window.Event(type, { bubbles: true }));
    const charsOf = () => Number(($('stats').textContent.match(/字符数(\d+)/) || [])[1] || -1);

    $('btnClear').click();
    await wait(150);
    $('source').value = '# 手打的标题\n\n这是手打段落，含公式 $a^2+b^2=c^2$。\n';
    fire($('source'), 'input');
    await wait(400);
    check('手动编辑：打字后预览立刻更新', preview.textContent.includes('手打的标题'));
    check('手动编辑：打字后的公式被渲染', preview.querySelectorAll('.katex').length >= 1, `${preview.querySelectorAll('.katex').length} 个`);
    const before = charsOf();
    check('手动编辑：统计面板有字符数', before > 0, `${before}`);

    $('source').value += '再补一行。\n';
    fire($('source'), 'input');
    await wait(400);
    check('手动编辑：统计随之增加', charsOf() > before, `${before} → ${charsOf()}`);
    check('手动编辑：JSON 面板跟着变', $('jsonView').textContent.includes('手打的标题'));

    // ---- 工具栏：在光标处插入 Markdown 片段 ----
    $('source').value = '';
    fire($('source'), 'input');
    await wait(250);
    window.document.querySelector('#toolbar [data-snippet="h2"]').click();
    await wait(150);
    check('工具栏：插入 H2', $('source').value.includes('## '));
    window.document.querySelector('#toolbar [data-snippet="mathblock"]').click();
    await wait(250);
    check('工具栏：插入块级公式（反斜杠没被吃掉）', $('source').value.includes('\\int_0^1'), $('source').value.replace(/\n/g, '⏎').slice(0, 40));
    check('工具栏：插入后预览渲染出公式', preview.querySelectorAll('.katex').length >= 1, `${preview.querySelectorAll('.katex').length} 个`);
    window.document.querySelector('#toolbar [data-wrap="bold"]').click();
    await wait(150);
    check('工具栏：加粗包裹选区/占位', $('source').value.includes('**文字**'));

    // ---- 布局：图片转写归入左侧工具栏；实时预览可开可关 ----
    check('图片转写入口在左侧编辑工具栏里', Boolean(window.document.querySelector('#toolbar #btnConvertToggle')));
    check('图片转写面板属于编辑区（没有另起一栏）', $('convertPanel').closest('.pane') === $('editorPane'));
    check('右侧不再有「图片转写」独立页签', !window.document.querySelector('[data-tab="convert"]'));
    check('图片转写面板默认收起', $('convertPanel').hidden === true);

    $('btnConvertToggle').click();
    await wait(120);
    check('点工具栏按钮可展开图片转写', $('convertPanel').hidden === false);
    $('btnCloseConvert').click();
    await wait(120);
    check('图片转写可收起', $('convertPanel').hidden === true);

    const styleOf = (id) => window.getComputedStyle($(id)).display;
    const main = window.document.querySelector('main');

    check('预览开关在左侧工具栏', $('toolbar').contains($('btnPreview')));
    check('右侧栏开关在左侧工具栏', $('toolbar').contains($('btnSidebar')));
    check('「只留编辑」在左侧工具栏', $('toolbar').contains($('btnFocus')));
    check('宽屏下预览/右侧栏是右侧网格列（竖排），不是下方横条', window.getComputedStyle($('previewPane')).position !== 'fixed' && window.getComputedStyle($('sidebar')).position !== 'fixed');

    check('实时预览默认打开', styleOf('previewPane') !== 'none');
    $('btnPreview').click();
    await wait(150);
    check('收起预览后 display:none（一点空间都不占）', styleOf('previewPane') === 'none' && main.classList.contains('no-preview'));
    check('收起后按钮不再高亮', !$('btnPreview').classList.contains('active'));
    $('btnPreview').click();
    await wait(150);
    check('再点工具栏「预览」即可打开', styleOf('previewPane') !== 'none' && $('btnPreview').classList.contains('active'));
    check('重新打开后预览内容仍在（没被清空）', preview.textContent.includes('小标题') && preview.querySelectorAll('.katex').length >= 1);
    $('btnHidePreview').click();
    await wait(150);
    check('预览面板自带的「收起 ✕」也能用', styleOf('previewPane') === 'none');
    $('btnPreview').click();
    await wait(150);

    check('右侧栏默认打开', styleOf('sidebar') !== 'none');
    $('btnSidebar').click();
    await wait(150);
    check('点「文件数据」收起右侧栏，且不占空间', styleOf('sidebar') === 'none' && main.classList.contains('no-sidebar'));
    $('btnSidebar').click();
    await wait(150);
    check('再点「文件数据」打开右侧栏', styleOf('sidebar') !== 'none' && $('btnSidebar').classList.contains('active'));

    $('btnFocus').click();
    await wait(150);
    check('「只留编辑」后两栏都是 display:none（零占位）', styleOf('previewPane') === 'none' && styleOf('sidebar') === 'none');
    $('btnFocus').click();
    await wait(150);
    check('再点一次恢复三栏', styleOf('previewPane') !== 'none' && styleOf('sidebar') !== 'none');

    // 恢复样例，后面的检查基于样例内容
    $('btnSample').click();
    await wait(300);
    check('「载入样例笔记」可恢复', $('source').value.includes('电磁感应实验记录') && preview.querySelectorAll('.katex').length >= 5);

    // ---- 图片转写（面板在左侧工具栏里打开）----
    $('btnConvertToggle').click();
    await wait(120);
    $('btnLoadSamplePhoto').click();
    await wait(120);
    check('载入样例照片后转写按钮可用', $('btnConvert').disabled === false);
    check('照片以内嵌 data URL 显示（离线也能用）', $('photo').src.startsWith('data:image/png;base64,') && $('photo').hidden === false);

    $('btnConvert').click();
    await wait(900);
    const out = $('convertOut');
    check('转写结果非空且含 LaTeX', out.hidden === false && out.textContent.includes('\\varepsilon'), `${out.textContent.length} 字`);
    check('转写后出现「插入 / 替换」按钮', $('insertRow').hidden === false);
    check('明确标注了真实接口 / 模拟应答', /真实接口|模拟应答|离线模式/.test($('convertNote').textContent), $('convertNote').textContent.slice(0, 34));

    const beforeInsert = $('source').value.length;
    $('btnInsert').click();
    await wait(120);
    check('插入到光标处：正文变长', $('source').value.length > beforeInsert, `${beforeInsert} → ${$('source').value.length}`);

    window.document.querySelector('#modeSeg button[data-mode="wysiwyg"]').click();
    await wait(120);
    const wysOk = $('wysiwyg').hidden === false && $('wysiwyg').querySelectorAll('.katex').length >= 5;
    window.document.querySelector('#modeSeg button[data-mode="split"]').click();
    await wait(120);
    check('可视化模式可切换且其中公式已渲染', wysOk);
    check('切回后正文仍在', $('source').value.includes('电磁感应实验记录'));

    let threw = null;
    try {
      $('btnMd').click();
      await wait(80);
    } catch (error) {
      threw = error;
    }
    check('点「导出 .md」不抛异常', threw === null, $('status').textContent);

    $('btnClear').click();
    await wait(80);
    check('「清空」可用', $('source').value === '' && preview.querySelectorAll('.katex').length === 0);

    return { skipped: false, checks, math };
  } catch (error) {
    check(`执行未抛异常（${error?.message ?? error}）`, false);
    return { skipped: false, checks };
  }
}
