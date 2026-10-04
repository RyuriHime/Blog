/**
 * 面板的静态契约：导出了什么、碰了哪些东西、文档在不在。
 *
 * 交互行为（实时监控编辑区、点才跑模型）在 `test-panel-live.mjs` 里测。
 */
import { createChecker } from './helpers/check.mjs';
import { readFileSync } from 'node:fs';
import { createComposeDom, installFakeGlobals } from './helpers/fake-dom.mjs';

const { check, summary } = createChecker();
const dom = createComposeDom({ title: '原标题', content: '# 旧草稿' });
const restore = installFakeGlobals(dom.document);

const { contractVersion, attach, createTextareaAdapter, createEditorMonitor, TEXT } = await import('../client/notes-panel.mjs');

check('contractVersion 为字符串 1', contractVersion === '1');
check('导出 attach 与 createTextareaAdapter', typeof attach === 'function' && typeof createTextareaAdapter === 'function');
check('导出 createEditorMonitor（实时监控是公开能力）', typeof createEditorMonitor === 'function');

const editor = createTextareaAdapter(dom.form);
check('适配器 getDoc 读宿主表单', editor.getDoc().title === '原标题' && editor.getDoc().markdown === '# 旧草稿');
editor.setDoc({ markdown: '# 新草稿' });
check('适配器 setDoc 写回编辑区', dom.contentEl.value === '# 新草稿');

const withImage = createComposeDom({ content: '![图1](/a.png)\n\n正文' });
check('适配器 getImages 从 markdown 里扫图', createTextareaAdapter(withImage.form).getImages()[0].src === '/a.png');

// 监控器只观察、不请求
let seen = 0;
const monitor = createEditorMonitor(editor, () => { seen += 1; }, { debounceMs: 5 });
dom.contentEl.value = '# 又改了';
dom.contentEl.dispatchEvent(new Event('input', { bubbles: true }));
await new Promise((resolve) => setTimeout(resolve, 30));
check('monitor 观察到编辑区变化', seen === 1);
monitor.stop();
dom.contentEl.value = '# 停止之后';
dom.contentEl.dispatchEvent(new Event('input', { bubbles: true }));
await new Promise((resolve) => setTimeout(resolve, 30));
check('monitor.stop() 之后不再回调（幂等）', seen === 1);
monitor.stop();

const mount = dom.document.createElement('div');
mount.id = 'notesMount';
dom.form.appendChild(mount);
const handle = attach({ mount, editor, api: async () => ({ sessionId: 1, title: 't', blocks: [], stats: {}, sources: [], warnings: [] }) });
// 面板往 mount 里放两个节点：抽屉本体 + 收起时留在屏幕右边缘的竖标签（见 test-panel-drawer.mjs）
const panelRoots = () => [...mount.children].filter((node) => String(node.className).includes('notes-'));
check('attach 在 mount 内建面板且不碰 mount 之外', panelRoots().length === 2 && typeof handle.destroy === 'function', `节点数 ${mount.children.length}`);
check('面板文案常量集中且齐全', Boolean(TEXT.organize && TEXT.apply && TEXT.turn && TEXT.review && TEXT.applyHigh && TEXT.watching));
check('面板暴露 ready / settle / flush / getState', ['ready', 'settle', 'flush', 'getState'].every((key) => handle[key] !== undefined));
await handle.ready;
handle.destroy();
check('destroy 清掉面板节点', mount.children.length === 0);

const source = readFileSync(new URL('../client/notes-panel.mjs', import.meta.url), 'utf8');
check('面板不 import 任何后端模块（只走 HTTP）', !/^import .*\.\.\/src\//m.test(source) && !/forum-ai/.test(source));
check('面板不读写 localStorage', !/localStorage/.test(source));
check('契约文档存在且列出 3 个必填方法', (() => {
  const doc = readFileSync(new URL('../EDITOR-CONTRACT.md', import.meta.url), 'utf8');
  return ['getDoc', 'setDoc', 'onChange'].every((method) => doc.includes(method));
})());

restore();
summary();
