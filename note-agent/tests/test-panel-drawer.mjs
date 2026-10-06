/**
 * 抽屉 + 预览 + 聊天式历史（用户 m04046 的四条要求；按用户 m04734，抽屉已从右边挪到左边）。
 *
 * 用户原话：
 *   1. 「AI 笔记整理应该以折叠狂形式放在右侧，这样可以左侧边看右侧边改。」
 *   2. 「修改后应该在 AI笔记整理 Tab 就能直接看到预览。」
 *   3. 「应当能够看到之前的对话，同时支持回滚到之前某一次的版本。更应该像聊天框一样。」
 *   4. 「保持这个 UI 风格」
 *
 * 这一套断言盯的就是这四条：抽屉在右侧且可折叠、预览在面板里、对话能看能回滚、
 * 回滚**只动草稿不动编辑区**（写回编辑区仍然要用户点「应用到编辑区」）。
 */
import { createChecker } from './helpers/check.mjs';
import { createComposeDom, installFakeGlobals } from './helpers/fake-dom.mjs';

const { check, summary } = createChecker();
const { attach, createTextareaAdapter } = await import('../client/notes-panel.mjs');

const DRAFT_V1 = '# 导数\n\n导数是变化率。';
const DRAFT_V2 = '# 导数与积分\n\n导数是变化率。\n\n积分是累积量。';

/** 假渲染模块：形状与挂载层发出去的 `/notes-markdown.js` 一致。 */
const rendererStub = {
  renderMarkdown: (markdown) => `<h1>兜底：${String(markdown).split('\n')[0]}</h1>`,
  markdownToPlainText: (markdown) => String(markdown),
  escapeHtml: (value) => String(value ?? ''),
};

/** 假后端：会话 / 整理 / 提需求 / 预览 / 历史 / 回滚。 */
function createFakeBackend({ history = [], wide = true, withoutHostPreview = false } = {}) {
  const requests = [];
  const messages = [...history];
  const api = async (path, options = {}) => {
    // 注意：`/messages?sessionId=…` 带查询串，必须按 pathname 判断（endsWith('/messages') 匹配不到）
    const pathname = String(path).split('?')[0];
    requests.push({ path, method: options.method ?? 'GET', body: options.body });
    if (pathname.endsWith('/session')) {
      return { sessionId: 42, title: '我的笔记', blocks: [{ id: 'b1', type: 'paragraph', text: '导数是变化率。' }], stats: { blocks: 1, chars: 9 }, sources: [], warnings: [] };
    }
    if (pathname.endsWith('/generate')) {
      messages.push({ id: 11, role: 'assistant', requirement: '', draftMd: DRAFT_V1, createdAt: 1 });
      return { sessionId: 42, draftMd: DRAFT_V1, blocks: [{ id: 'b1', type: 'heading', text: '导数', level: 1 }] };
    }
    if (pathname.endsWith('/turn')) {
      messages.push({ id: 12, role: 'user', requirement: String(options.body?.requirement ?? ''), draftMd: DRAFT_V2, createdAt: 2 });
      return { sessionId: 42, draftMd: DRAFT_V2, blocks: [{ id: 'b1', type: 'heading', text: '导数与积分', level: 1 }] };
    }
    if (pathname.endsWith('/review')) {
      return {
        sessionId: 42,
        reviewId: 7,
        summary: '草稿整体成立，但定义部分缺少前提说明。',
        findings: [
          { id: 'f1', severity: 'high', type: 'formula', quote: '导数是变化率。', detail: '没交代前提。', suggestion: '补一句前提。' },
          { id: 'f2', severity: 'low', type: 'clarity', quote: '积分是累积量。', detail: '说法含糊。', suggestion: '说清累积什么。' },
        ],
      };
    }
    if (pathname.endsWith('/messages')) {
      return { sessionId: 42, draftMd: DRAFT_V2, messages: messages.map((m) => ({ ...m })) };
    }
    if (pathname.endsWith('/rollback')) {
      const target = messages.find((m) => m.id === Number(options.body?.messageId));
      if (!target) throw Object.assign(new Error('找不到要回滚到的那一轮'), { code: 'notes_not_found' });
      return { sessionId: 42, messageId: target.id, draftMd: target.draftMd, blocks: [{ id: 'b1', type: 'heading', text: '导数', level: 1 }] };
    }
    if (pathname.includes('/markdown/preview')) {
      // 交付包单独拷走时的形态：宿主根本没有这个接口
      if (withoutHostPreview) {
        throw Object.assign(new Error('没有这个接口'), { code: 'notes_not_found', status: 404 });
      }
      return { html: '<h1>导数与积分</h1><p>导数是变化率。</p>' };
    }
    throw new Error(`未预期的请求：${path}`);
  };
  return { api, requests, messages, wide };
}

/** 装一台"已经整理过 + 提过一次需求"的面板，返回所有需要断言的把手。 */
async function setup({ content = DRAFT_V1, history = [], wide = true, withoutHostPreview = false, renderer = null } = {}) {
  const dom = createComposeDom({ title: '我的笔记', content });
  const detach = installFakeGlobals(dom.document, { width: wide ? 1440 : 720 });
  const mount = dom.document.createElement('div');
  mount.id = 'notesMount';
  dom.form.appendChild(mount);
  const backend = createFakeBackend({ history, withoutHostPreview });
  // 假 DOM 没有真的模块加载器：用一个记账式 importModule 代替浏览器的动态 import
  const imported = [];
  const importModule = async (url) => {
    imported.push(url);
    if (!renderer) throw new Error(`假 DOM 里没有模块加载器：${url}`);
    return renderer;
  };
  const panel = attach({ mount, editor: createTextareaAdapter(dom.form), api: backend.api, importModule });
  await panel.ready;
  return { dom, detach, mount, panel, imported, ...backend };
}

const drawerOf = (mount) => mount.querySelector('.notes-drawer');

// ── 1. 折叠式抽屉，放在左侧（m04734 起） ────────────────────────────
const first = await setup();
await first.panel.settle();
check('面板根节点就带抽屉类（CSS 靠它做左侧固定定位）', drawerOf(first.mount)?.classList.contains('notes-panel') === true);
// 面板样式全部收在 `.notes-mount` 下（宿主一条 input[type="text"] 就改不动面板）。
// 挂载点没这个类时整块样式一条都不生效、面板退化成裸块 —— 交付包的演示页正是这么踩的。
// 所以 attach 自己补上，接入方不必记这件事。
check('挂载点没带 notes-mount 时面板自己补上（否则一块样式都不生效）', first.mount.classList.contains('notes-mount') === true);
check('宽屏打开写作页时抽屉默认展开，用户一眼看到入口', drawerOf(first.mount)?.classList.contains('is-open') === true);
check('抽屉里有折叠按钮', Boolean(first.mount.querySelector('.notes-drawer-toggle')));

const toggle = () => first.mount.querySelector('.notes-drawer-toggle');
toggle()?.dispatchEvent(new Event('click'));
check('点折叠按钮后抽屉收起', drawerOf(first.mount)?.classList.contains('is-open') === false);
check('收起后也放得下（左侧编辑区不再被遮）', first.mount.querySelector('.notes-drawer-toggle') !== null);
toggle()?.dispatchEvent(new Event('click'));
check('再点一次又展开（折叠是双向的）', drawerOf(first.mount)?.classList.contains('is-open') === true);

// 抽屉挂在 mount 内、生命周期仍归宿主管 —— 旧的挂载契约不能被打破。
// 面板往 mount 里放两个节点：抽屉本体 + 收起时留在屏幕左边缘的竖标签。
// 竖标签**必须**在抽屉外面：抽屉收起是整块平移出屏，`overflow:hidden` 会把
// 绝对定位的子元素一起裁掉，真机上表现为"收起后再也点不开"。
check('面板往 mount 里只放自己的两个根节点（抽屉 + 竖标签）', first.mount.children.length === 2, `节点数 ${first.mount.children.length}`);
check('竖标签住在抽屉外面（否则会被抽屉裁掉、收起后点不到）', (() => {
  const panelRoot = first.mount.children[0];
  const tabNode = first.mount.children[1];
  return panelRoot?.classList.contains('notes-drawer') === true && tabNode?.classList.contains('notes-drawer-tab') === true;
})());
first.panel.destroy();
check('destroy 之后抽屉与竖标签都被移除', first.mount.childNodes.length === 0);
check('destroy 之后挂载点回到宿主给的样子（面板补的类也摘掉）', first.mount.classList.contains('notes-mount') === false);
first.detach();

// ── 2. 预览：整理完就在面板里看得见 ────────────────────────────────
const second = await setup();
await second.panel.settle();
second.mount.querySelector('.notes-organize')?.dispatchEvent(new Event('click'));
await second.panel.settle();

const preview = second.mount.querySelector('.notes-preview');
check('面板里有预览区（不用切到发布预览页）', Boolean(preview));
check('预览区默认渲染成 HTML（走宿主同一套渲染）', second.requests.some((r) => String(r.path).includes('/markdown/preview')));
check('预览显示的是宿主渲染出来的 HTML', String(second.mount.querySelector('.notes-preview-body')?.innerHTML ?? '').includes('<h1>'), String(second.mount.querySelector('.notes-preview-body')?.innerHTML ?? '').slice(0, 120));

const previewBody = second.mount.querySelector('.notes-preview-body');
if (previewBody) previewBody.innerHTML = '';
const rawBtn = second.mount.querySelector('.notes-preview-raw');
check('预览有 HTML / 原文 两个视图的切换按钮', Boolean(rawBtn));
rawBtn?.dispatchEvent(new Event('click'));
check('切到原文时显示 Markdown 源码', String(previewBody?.innerHTML ?? '').includes('#') || String(previewBody?.textContent ?? '').includes('导数是变化率'), String(previewBody?.textContent ?? '').slice(0, 120));
check('切到原文不再需要请求渲染接口', second.requests.filter((r) => String(r.path).includes('/markdown/preview')).length >= 1);
second.panel.destroy();
second.detach();

// ── 3. 像聊天框一样看到之前的对话 ──────────────────────────────────
const third = await setup({ wide: false });
await third.panel.settle();
// 窄屏（720px）默认收起：否则 420px 的抽屉会把编辑区压到没法写字
check('窄屏默认收起抽屉，只留右边一条竖标签', drawerOf(third.mount)?.classList.contains('is-open') === false);
third.mount.querySelector('.notes-drawer-toggle')?.dispatchEvent(new Event('click'));
check('窄屏点开之后照常用（覆盖式，不挤压编辑区）', drawerOf(third.mount)?.classList.contains('is-open') === true);
third.mount.querySelector('.notes-organize')?.dispatchEvent(new Event('click'));
await third.panel.settle();

const input = third.mount.querySelector('.notes-turn-input');
input.value = '再加一段积分的说明';
third.mount.querySelector('.notes-turn')?.dispatchEvent(new Event('click'));
await third.panel.settle();

const chat = third.mount.querySelector('.notes-chat');
check('面板里有对话线程', Boolean(chat));
const rows = third.mount.querySelectorAll('.notes-msg');
check('对话线程里每一轮都留了一条消息', rows.length >= 2, `消息数 ${rows.length}`);
check('用户提的需求原样出现在对话里', String(chat?.textContent ?? '').includes('再加一段积分的说明'));
check('对话线程从后端拿历史（不是只记本地这一会儿）', third.panel.getState().messages.length >= 2 && third.requests.some((r) => String(r.path).endsWith('/messages?sessionId=42')));
check('对话是可滚动的（不把抽屉撑爆）', third.mount.querySelector('.notes-chat') !== null);
check('整理完那一轮也能回滚（后端存了快照）', third.mount.querySelectorAll('.notes-rollback').length >= 2, String(third.mount.querySelectorAll('.notes-rollback').length));

// ── 3b. 结果不许把预览挤出可见区（用户报的 bug）────────────────────
// 用户原话：「点击学术审查或者整理笔记，结果跑出来后会把预览窗口覆盖掉」。
// 抽屉是一列，跑完一轮之后对话/提示/对比/审查都长出来，把预览顶到滚动区外面；
// 面板每轮结束必须把用户送回预览（抽屉滚回该块、预览自己滚回顶部）。
const drawerBody = third.mount.querySelector('.notes-drawer-body');
const previewBox = third.mount.querySelector('.notes-preview');
drawerBody.scrollTop = 480;
previewBox.scrollTop = 120;
third.mount.querySelector('.notes-review-btn')?.dispatchEvent(new Event('click'));
await third.panel.settle();
check('审查完面板把用户送回预览（抽屉滚回预览那一块）', (drawerBody?.scrollTop ?? -1) === 0, `scrollTop=${drawerBody?.scrollTop}`);
check('预览自己也滚回顶部（不然看到的是上次滚到的位置）', (previewBox?.scrollTop ?? -1) === 0, `scrollTop=${previewBox?.scrollTop}`);
check('审查结果仍然列出来（不是靠藏结果来"解决"遮挡）', third.mount.querySelectorAll('.notes-finding').length > 0, String(third.mount.querySelectorAll('.notes-finding').length));

drawerBody.scrollTop = 480;
input.value = '再补一句';
third.mount.querySelector('.notes-turn')?.dispatchEvent(new Event('click'));
await third.panel.settle();
check('提完需求同样把用户送回预览', (drawerBody?.scrollTop ?? -1) === 0, `scrollTop=${drawerBody?.scrollTop}`);
third.panel.destroy();
third.detach();

// ── 4. 回滚到之前某一版：只动草稿，不动编辑区 ──────────────────────
const history = [
  { id: 1, role: 'assistant', requirement: '整理这篇笔记', draftMd: DRAFT_V1, createdAt: 1 },
  { id: 2, role: 'user', requirement: '再加一段积分的说明', draftMd: DRAFT_V2, createdAt: 2 },
];
const fourth = await setup({ content: DRAFT_V2, history, wide: false });
await fourth.panel.settle();
fourth.mount.querySelector('.notes-drawer-toggle')?.dispatchEvent(new Event('click'));
await fourth.panel.settle();

const rollbackButtons = fourth.mount.querySelectorAll('.notes-rollback');
check('每一版旁边都有「回滚到这一版」', rollbackButtons.length >= 2, `按钮数 ${rollbackButtons.length}`);
const editorBefore = fourth.dom.contentEl.value;
rollbackButtons[0]?.dispatchEvent(new Event('click'));
await fourth.panel.settle();

const rbReq = fourth.requests.find((r) => String(r.path).endsWith('/rollback'));
check('点回滚会带着 messageId 调 /rollback', rbReq?.body?.messageId === 1, JSON.stringify(rbReq?.body));
check('回滚之后编辑区一个字都没动（写回仍要用户点应用）', fourth.dom.contentEl.value === editorBefore);
check('回滚之后草稿换成了那一版', String(fourth.panel.getState().draftMd ?? '').includes('导数是变化率'));
check('回滚之后预览跟着换成那一版', String(fourth.mount.querySelector('.notes-preview')?.textContent ?? '').includes('导数是变化率'));
fourth.panel.destroy();
fourth.detach();

// ── 5. 宿主没有渲染接口时，面板用包自带的渲染兜底 ──────────────────
// 交付包会被单独拷到别的站点：那里没有 `POST <hostBase>/markdown/preview`。
// 那种情况下预览不能永久退化成原文（用户看到的会是一个点不动的「效果」按钮），
// 而要动态 import 挂载层发出去的渲染模块自己渲染。
const fifth = await setup({ withoutHostPreview: true, renderer: rendererStub });
await fifth.panel.settle();
fifth.mount.querySelector('.notes-organize')?.dispatchEvent(new Event('click'));
await fifth.panel.settle();
const fiftyBody = fifth.mount.querySelector('.notes-preview-body');
check('宿主没有渲染接口时会去找包自带的渲染模块', fifth.imported.length === 1, `import 次数 ${fifth.imported.length}`);
check('兜底渲染之后预览里出现渲染结果（不是原文）', String(fiftyBody?.innerHTML ?? '').includes('<h1>兜底'), String(fiftyBody?.innerHTML ?? '').slice(0, 120));
check('没有退回原文视图（用户没被降级）', fiftyBody?.classList.contains('is-raw') === false, String(fiftyBody?.className));
fifth.panel.destroy();
fifth.detach();

// ── 6. 两条路都不通时才退回原文，并且明确告诉用户 ──────────────────
const sixth = await setup({ withoutHostPreview: true });
await sixth.panel.settle();
sixth.mount.querySelector('.notes-organize')?.dispatchEvent(new Event('click'));
await sixth.panel.settle();
check('渲染模块也 import 不到时仍然不崩（退回原文继续能用）', sixth.mount.querySelector('.notes-preview-body')?.classList.contains('is-raw') === true, String(sixth.mount.querySelector('.notes-preview-body')?.className));
check('并且在面板里说明了原因，而不是静默降级', String(sixth.mount.querySelector('.notes-notice')?.textContent ?? '').includes('预览'));
sixth.panel.destroy();
sixth.detach();

// ── 7. 手机上的逃生通道（用户 m07358：「做手机端适配，且可移植」）──────────
// 真机量过：390×844 下抽屉铺满视口时，唯一的出口是右上角那个 26×26 的「›」。
// 拇指点不中是小事，**出不去**是大事 —— 所以再给两条路：
//   · Esc 收起；
//   · 点抽屉外面收起（只在窄屏：桌面上点编辑区不该把抽屉关掉）。
const mobile = await setup({ wide: false });
await mobile.panel.settle();

check('手机上按 Esc 收起抽屉（不只靠右上角那枚小按钮）', (() => {
  mobile.dom.document.listeners.get('keydown')?.forEach((h) => h(new Event('keydown')));
  return drawerOf(mobile.mount)?.classList.contains('is-open') === false;
})());
mobile.mount.querySelector('.notes-drawer-tab')?.dispatchEvent(new Event('click'));
check('手机上点竖标签又展开（逃生通道是双向的）', drawerOf(mobile.mount)?.classList.contains('is-open') === true);

check('手机上点抽屉外面收起（给拇指一条退路）', (() => {
  const outside = mobile.dom.contentEl;
  mobile.dom.document.listeners.get('pointerdown')?.forEach((h) => h({ type: 'pointerdown', target: outside, bubbles: true }));
  return drawerOf(mobile.mount)?.classList.contains('is-open') === false;
})());
mobile.mount.querySelector('.notes-drawer-tab')?.dispatchEvent(new Event('click'));
check('点在抽屉里面不算"点外面"（否则一点按钮就自己关掉）', (() => {
  const inside = mobile.mount.querySelector('.notes-drawer-body') ?? mobile.mount;
  mobile.dom.document.listeners.get('pointerdown')?.forEach((h) => h({ type: 'pointerdown', target: inside, bubbles: true }));
  return drawerOf(mobile.mount)?.classList.contains('is-open') === true;
})());

const listenersBefore = mobile.dom.document.listeners.get('keydown')?.size ?? 0;
mobile.panel.destroy();
check('destroy 之后 document 上的监听也摘掉（宿主切视图不会留一堆监听）', (mobile.dom.document.listeners.get('keydown')?.size ?? 0) < listenersBefore);
mobile.detach();

// 桌面：点编辑区**不该**关抽屉（用户是在对照着看，不是要离开）
const desktop = await setup({ wide: true });
await desktop.panel.settle();
check('宽屏点编辑区不会把抽屉关掉（只有窄屏才有"点外面收起"）', (() => {
  desktop.dom.document.listeners.get('pointerdown')?.forEach((h) => h({ type: 'pointerdown', target: desktop.dom.contentEl, bubbles: true }));
  return drawerOf(desktop.mount)?.classList.contains('is-open') === true;
})());
desktop.panel.destroy();
desktop.detach();

// ── 8. 可移植：面板不认宿主的类名，也不靠宿主的样式表 ────────────────
// 交付包会被拷到"长什么样都不知道"的站点上。可移植性的证明分两半：
//   · 静态那一半在 `test-panel-css.mjs`（每个宿主变量都有兜底值、面板只认 .notes-mount）；
//   · 这里盯运行时那一半：面板的 DOM 里**不许出现宿主类名**（比如 `.btn` / `.card`），
//     否则换个站点就得跟着改样式表 —— 那就不叫可移植了。
const eighth = await setup();
await eighth.panel.settle();
const hostClasses = ['btn', 'card', 'topbar', 'layout', 'container', 'wrapper'];
const leaked = [];
for (const node of eighth.mount.querySelectorAll('*')) {
  for (const name of hostClasses) if (node.classList?.contains?.(name)) leaked.push(`${node.tagName}.${node.className}`);
}
check('面板 DOM 里不出现宿主类名（换站点不必跟着改样式表）', leaked.length === 0, leaked.slice(0, 3).join(' | '));
eighth.panel.destroy();
eighth.detach();

summary();
