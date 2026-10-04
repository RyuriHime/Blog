/**
 * 面板「忙的时候不丢任务」契约测试。
 *
 * `run()` 里 `if (state.busy) return;` 会静默丢掉排队中的任务。要可靠地抓到它，必须
 * 让**第二次** `sync()` 正好落在第一次 `sync()` 还在飞的窗口里：
 *
 *   - 旧行为：第二次 `run(sync)` 被丢 → `syncedDraft` 停在旧文本、`state.dirty` 恒真
 *     → 「应用到编辑区」一直灰着，直到用户再敲一个字。
 *   - 新行为：补跑到下一个宏任务，等忙收尾后重新执行，把 `syncedDraft` 推到此刻的内容。
 *
 * 这正是真机场景：打开一篇笔记，首次同步还没回来时就接着打字。
 */
import { createChecker } from './helpers/check.mjs';
import { createComposeDom, installFakeGlobals } from './helpers/fake-dom.mjs';

const { check, summary } = createChecker();

const dom = createComposeDom({ title: '我的笔记', content: '# 导数\n\n导数是变化率。' });
const restore = installFakeGlobals(dom.document);
const { attach } = await import('../client/notes-panel.mjs');

function createDeferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

const calls = [];
/** 第一次 `/session` 卡住（"打开笔记时首次同步还没回来"）。 */
const firstSessionGate = createDeferred();
let sessionCalls = 0;
const api = async (path, options = {}) => {
  calls.push({ path, draft: String(options.body?.draft ?? '') });
  if (path.endsWith('/session')) {
    sessionCalls += 1;
    if (sessionCalls === 1) await firstSessionGate.promise;
    return { sessionId: 42, title: '我的笔记', blocks: [], stats: { blocks: 0, chars: 0 }, sources: [], warnings: [] };
  }
  if (path.endsWith('/markdown/preview')) return { html: '<p>预览</p>' };
  return {};
};

const mount = dom.document.createElement('div');
mount.id = 'notesMount';
dom.form.appendChild(mount);

let onChange = null;
const fakeEditor = {
  getDoc: () => ({ title: dom.titleEl.value, markdown: dom.contentEl.value }),
  onChange: (handler) => { onChange = handler; return () => { onChange = null; }; },
  setDoc: () => {},
};

const panel = attach({ mount, editor: fakeEditor, api });
// 注意：不能 await panel.ready —— 它挂在被卡住的首次同步上。
for (let i = 0; i < 20; i += 1) await Promise.resolve();
check('首次同步已经发出并卡在那里', sessionCalls === 1 && panel.getState().busy === true);

// 首次同步还在飞的时候改正文（等防抖窗口走完，监控才回调）
const edited = `${dom.contentEl.value}\n\n打字的第二句。`;
dom.contentEl.value = edited;
onChange();
await new Promise((resolve) => setTimeout(resolve, 500));
check('监控已经触发过一次，而首次同步仍卡着', panel.getState().busy === true);

// ── 放行首次同步：这次改动必须被补上 ────────────────────────────────
firstSessionGate.resolve();
for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
await panel.settle();
for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
await panel.settle();

const state = panel.getState();
check(
  '首次同步还没回来时打的那句话，最后被同步上了（没有静默丢掉）',
  state.syncedDraft === edited,
  JSON.stringify({ syncedDraft: state.syncedDraft }),
);
check('同步之后面板不脏（「应用到编辑区」不会被永久置灰）', state.dirty === false, JSON.stringify({ dirty: state.dirty }));
check('忙碌状态已经收尾', state.busy === false);
check('补跑确实又打了一次 /session', sessionCalls >= 2, String(sessionCalls));

panel.destroy();
restore();
summary();
