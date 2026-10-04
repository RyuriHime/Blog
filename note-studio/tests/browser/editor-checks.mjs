/**
 * 正式编辑器（public/index.html）的操作检查（可复用）。
 *
 * 覆盖：打开即渲染、手动编辑、图片转写入口在编辑工具栏、
 * **预览/侧栏各自可折叠且收起后仍有明确入口**、只留编辑栏、模式切换、离线降级、导出。
 *
 * 由两处共用：
 *   - tests/browser/verify-editor.mjs （命令行自检）
 *   - acceptance/run.mjs              （写进验收报告，AC-17）
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

export async function runEditorChecks() {
  const JSDOM = loadJsdom();
  if (!JSDOM) return { skipped: true, reason: '没有找到 jsdom（设置 JSDOM_PATH 或 NODE_PATH 后重试）', checks: [] };

  const page = join(PUBLIC, 'index.html');
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
  await wait(400);

  const $ = (id) => window.document.getElementById(id);
  const fire = (el, type) => el.dispatchEvent(new window.Event(type, { bubbles: true }));
  const collapsed = (el) => el.classList.contains('collapsed');
  const checks = [];
  const check = (name, ok, extra = '') => checks.push({ name, ok, extra });
  const preview = $('preview');
  const main = window.document.querySelector('main');

  try {
    // 1. 打开即渲染
    check('打开即渲染出示例内容（含公式）', preview.querySelectorAll('.katex').length >= 2, `${preview.querySelectorAll('.katex').length} 个`);

    // 2. 侧栏结构：图片转写不再单独一栏
    const tabs = [...window.document.querySelectorAll('.tab')].map((tab) => tab.textContent.trim());
    check('侧栏不再有「图片转写」页签', !tabs.includes('图片转写'), tabs.join(' / '));
    check('侧栏剩下 3 个页签', tabs.length === 3, tabs.join(' / '));

    // 3. 图片转写入口在编辑工具栏，面板属于编辑区
    check('图片转写入口在编辑工具栏里', $('toolbar').contains($('btnConvertToggle')));
    check('图片转写面板属于编辑区（没有另起一栏）', $('convertPanel').closest('.pane') === $('source').closest('.pane'));
    check('图片转写面板默认收起', $('convertPanel').hidden === true);
    $('btnConvertToggle').click();
    await wait(120);
    check('点工具栏按钮可展开图片转写', $('convertPanel').hidden === false);
    $('btnCloseConvert').click();
    await wait(120);
    check('图片转写可收起', $('convertPanel').hidden === true);

    // 4. 布局开关：全部在左侧功能栏；收起后 display:none（不占空间）
    const styleOf = (id) => window.getComputedStyle($(id)).display;
    const tabActive = (name) => window.document.querySelector(`.tab-body[data-body="${name}"]`).classList.contains('active');

    check('预览开关在左侧工具栏', $('toolbar').contains($('btnPreview')));
    check('AI 助手开关在左侧工具栏', $('toolbar').contains($('btnAi')));
    check('文件数据开关在左侧工具栏', $('toolbar').contains($('btnData')));
    check('「只留编辑」在左侧工具栏', $('toolbar').contains($('btnFocus')));
    check('宽屏下预览与侧栏是右侧网格列（竖排），不是下方横条', window.getComputedStyle($('previewPane')).position !== 'fixed' && window.getComputedStyle($('sidebar')).position !== 'fixed');

    check('实时预览默认打开', styleOf('previewPane') !== 'none');
    $('btnPreview').click();
    await wait(150);
    check('收起预览后 display:none（一点空间都不占）', styleOf('previewPane') === 'none' && main.classList.contains('no-preview'));
    check('收起后按钮不再高亮', !$('btnPreview').classList.contains('active'));
    $('btnPreview').click();
    await wait(150);
    check('再点工具栏「预览」即可打开', styleOf('previewPane') !== 'none' && $('btnPreview').classList.contains('active'));
    check('重新打开后预览内容还在', preview.querySelectorAll('.katex').length >= 2);
    $('btnHidePreview').click();
    await wait(150);
    check('预览面板自带的「收起 ✕」也能用', styleOf('previewPane') === 'none');
    $('btnPreview').click();
    await wait(150);

    // 5. 侧栏（AI 助手 / 文件数据）开关也在左侧工具栏
    check('侧栏默认打开', styleOf('sidebar') !== 'none');
    $('btnAi').click();
    await wait(150);
    check('点「AI 助手」收起侧栏，且不占空间', styleOf('sidebar') === 'none' && main.classList.contains('no-sidebar'));
    $('btnAi').click();
    await wait(150);
    check('再点「AI 助手」打开侧栏并停在 AI 页签', styleOf('sidebar') !== 'none' && tabActive('ai') && $('btnAi').classList.contains('active'));
    $('btnData').click();
    await wait(150);
    check('点「文件数据」切换到对应页签并保持打开', styleOf('sidebar') !== 'none' && tabActive('info') && $('btnData').classList.contains('active'));
    $('btnData').click();
    await wait(150);
    check('再点「文件数据」收起侧栏', styleOf('sidebar') === 'none');
    $('btnAi').click();
    await wait(150);

    // 6. 只留编辑栏
    $('btnFocus').click();
    await wait(150);
    check(
      '「只留编辑」后两栏都是 display:none（零占位）',
      styleOf('previewPane') === 'none' && styleOf('sidebar') === 'none' && main.classList.contains('no-preview') && main.classList.contains('no-sidebar'),
    );
    check('只留编辑时编辑区仍在', $('source').hidden === false);
    $('btnFocus').click();
    await wait(150);
    check('再点一次恢复三栏', styleOf('previewPane') !== 'none' && styleOf('sidebar') !== 'none');

    // 7. 窄屏预案：贴右侧抽屉（竖排），而不是横着堆到下方
    const css = await readFile(join(PUBLIC, 'studio.css'), 'utf8');
    check(
      '窄屏（≤1000px）把预览/侧栏改为贴右侧抽屉',
      /@media \(max-width: 1000px\)/.test(css) && /position:\s*fixed/.test(css) && /right:\s*0/.test(css),
    );

    // 7. 手动编辑
    $('source').value = '# 编辑器手写测试\n\n公式 $x^2+y^2=z^2$。\n';
    fire($('source'), 'input');
    await wait(450);
    check('手动编辑：预览立刻更新', preview.textContent.includes('编辑器手写测试'));
    check('手动编辑：公式被渲染', preview.querySelectorAll('.katex').length >= 1, `${preview.querySelectorAll('.katex').length} 个`);
    check('手动编辑：统计区跟着更新', $('statsTable').textContent.includes('字符数'));

    // 7b. 块级公式：必须真的渲染成块级、结构合法、且**不被 CSS 裁切**
    const documentSample = [
      '# TEST',
      '',
      '行内公式：$E = mc^2$；块级公式：',
      '',
      '$$',
      '\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}',
      '$$',
      '',
      '- [x] 三种模式',
    ].join('\n');
    $('source').value = documentSample;
    fire($('source'), 'input');
    await wait(500);

    const displays = [...preview.querySelectorAll('.katex-display')];
    const insideParagraph = displays.some((element) => {
      let parent = element.parentElement;
      while (parent) {
        if (parent.tagName === 'P') return true;
        parent = parent.parentElement;
      }
      return false;
    });
    const overflowY = displays.length ? window.getComputedStyle(displays[0]).overflowY : '';

    check('块级公式（含 \\int 上下限）渲染成块级', displays.length === 1, `${displays.length} 个`);
    check('块级公式没有被嵌进 <p>', !insideParagraph);
    check('块级公式没有被 CSS 裁切（overflow-y 不是 hidden）', overflowY !== 'hidden', `overflow-y=${overflowY}`);

    // 8. 模式切换（预览状态由用户决定，不再被模式强制改变）
    window.document.querySelector('.mode[data-mode="wysiwyg"]').click();
    await wait(200);
    check('可视化模式：编辑区即预览，渲染出公式', $('wysiwyg').hidden === false && $('wysiwyg').querySelectorAll('.katex').length >= 1);
    check('可视化模式：预览保持你的开关状态', !collapsed($('previewPane')));
    window.document.querySelector('.mode[data-mode="split"]').click();
    await wait(200);
    check('切回分栏：预览仍在并已重绘', !collapsed($('previewPane')) && preview.querySelectorAll('.katex').length >= 1);

    // 9. 离线降级：没有服务时给出提示，AI 按钮不会崩
    check('离线时给出「离线草稿模式」提示', /离线草稿模式/.test($('alert').textContent), $('alert').textContent.slice(0, 24));
    let threw = null;
    try {
      $('btnOrganize').click();
      await wait(400);
    } catch (error) {
      threw = error;
    }
    check('离线时点「AI 整理」不崩，给出错误提示', threw === null && $('aiResult').textContent.trim().length > 0, $('aiResult').textContent.trim().slice(0, 30));

    let exportThrew = null;
    try {
      $('btnDownloadMd').click();
      await wait(120);
    } catch (error) {
      exportThrew = error;
    }
    const statusText = $('statusText').textContent;
    check(
      '点「下载 .md」不抛异常，且失败时给出可读提示',
      exportThrew === null && (/已导出/.test(statusText) || /不允许直接下载/.test(statusText)),
      statusText,
    );

    return { skipped: false, checks };
  } catch (error) {
    check(`执行未抛异常（${error?.message ?? error}）`, false);
    return { skipped: false, checks };
  }
}
