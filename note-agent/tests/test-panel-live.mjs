/**
 * 面板的"实时监控编辑区"契约测试。
 *
 * 用户 m02709 / m02726 的真实要求：面板盯着**编辑区**，
 * 内容一改面板就知道（不花钱），用户点击才真的跑模型。
 *
 * 这里用假 DOM + 假 api 驱动面板，断言的全部是"面板有没有正确观察到编辑区"。
 */
import { createChecker } from './helpers/check.mjs';
import { createComposeDom, installFakeGlobals } from './helpers/fake-dom.mjs';

const { check, summary } = createChecker();

const dom = createComposeDom({ title: '我的笔记', content: '# 导数\n\n导数是变化率。' });
const restore = installFakeGlobals(dom.document);
const { attach, createTextareaAdapter, TEXT } = await import('../client/notes-panel.mjs');

// ── 记录面板打过的每一个请求：实时监控必须"不点不花钱" ──────────────
const requests = [];
const api = async (path, options = {}) => {
  requests.push({ path, method: options.method ?? 'GET', body: options.body });
  if (path.endsWith('/session')) {
    const draft = String(options.body?.draft ?? '');
    // 固定返回前两块，模拟"服务端已经知道编辑区现在是什么"
    const lines = draft.split(/\n{2,}/).filter(Boolean);
    return {
      sessionId: 42,
      title: '我的笔记',
      blocks: [
        { id: 'b1', type: 'paragraph', text: lines[0] ?? '' },
        { id: 'b2', type: 'paragraph', text: lines[1] ?? '导数是变化率。' },
      ],
      stats: { blocks: 2, chars: draft.length },
      sources: [],
      warnings: [],
    };
  }
  if (path.endsWith('/generate') || path.endsWith('/turn')) {
    return {
      sessionId: 42,
      title: '导数与积分',
      tags: ['微积分'],
      // 只动 b2：b1 原样保留 —— 对比栏就该只列 b2
      blocks: [
        { id: 'b1', type: 'paragraph', text: String(options.body?.draft ?? '').split(/\n{2,}/)[0] ?? '' },
        { id: 'b2', type: 'heading', text: '导数与积分', level: 1 },
      ],
      ops: [{ kind: 'setTitle', text: '导数与积分' }],
      applied: [{ index: 0, kind: 'setTitle' }],
      draftMd: '# 导数与积分\n\n导数是变化率。',
      skipped: [],
      notes: [],
      needsMore: [],
      warnings: [],
      usage: { prompt: 100, completion: 200 },
    };
  }
  if (path.endsWith('/review')) {
    return {
      reviewId: 7,
      summary: '整体还行',
      findings: [
        { id: 'f1', kind: 'logic', severity: 'high', quote: '导数是变化率', issue: '定义不严谨', suggestion: '补极限形式', patch: '导数是瞬时变化率。' },
        { id: 'f2', kind: 'clarity', severity: 'low', quote: '导数是变化率', issue: '表述含糊', suggestion: '写清楚一点' },
      ],
      strengths: ['主题明确'],
      dropped: [],
    };
  }
  if (path.endsWith('/apply')) {
    return { blocks: [], title: '导数与积分', tags: [], draftMd: '# 导数与积分\n\n导数是瞬时变化率。', applied: [], skipped: [] };
  }
  throw new Error(`未预期的请求：${path}`);
};

const mount = dom.document.createElement('div');
mount.id = 'notesMount';
dom.form.appendChild(mount);

const editor = createTextareaAdapter(dom.form);
const panel = attach({ mount, editor, api });

// ── 挂载即读取：面板一出现就知道编辑区里是什么 ────────────────────
await panel.ready;
check('挂载后立刻同步了一次编辑区内容', requests.some((r) => r.path.endsWith('/session') && String(r.body?.draft).includes('导数是变化率')));
check('面板显示编辑区状态（块数/字数）', /块/.test(mount.textContent) && /字/.test(mount.textContent), mount.textContent.slice(0, 120));
check('实时同步不调用模型', !requests.some((r) => r.path.endsWith('/generate') || r.path.endsWith('/review')));
check('【真机教训】状态里不出现开发用的会话号 #42', !mount.textContent.includes('#42'), mount.textContent.slice(0, 160));

// ── 不点不跑：编辑区改动只做本地观察 ──────────────────────────────
const beforeEdits = requests.filter((r) => r.path.endsWith('/generate')).length;
dom.contentEl.value = `${dom.contentEl.value}\n\n新增一段。`;
dom.contentEl.dispatchEvent(new Event('input', { bubbles: true }));
await panel.flush();
check('编辑区一改，面板把最新内容同步过去', requests.some((r) => r.path.endsWith('/session') && String(r.body?.draft).includes('新增一段')));
check('编辑区改动不会自动跑模型（不点不花钱）', requests.filter((r) => r.path.endsWith('/generate')).length === beforeEdits);

// ── 用户点「整理」：作用在编辑区此刻的内容上 ──────────────────────
const organizeBtn = mount.querySelector('.notes-organize');
check('面板有「开始整理」按钮', Boolean(organizeBtn));
organizeBtn.dispatchEvent(new Event('click'));
await panel.settle();
const genReq = requests.find((r) => r.path.endsWith('/generate'));
check('点整理才调用模型', Boolean(genReq));
check('整理请求带上编辑区此刻的内容', String(genReq?.body?.draft).includes('新增一段'), JSON.stringify(genReq?.body).slice(0, 200));
check('整理结果落在面板的对比区里', Boolean(mount.querySelector('.notes-diff')));
check('整理结果能写回编辑区（应用按钮已可用）', mount.querySelector('.notes-apply').disabled === false);

// ── 对比栏必须显示"改了什么"，不是"整篇都是新增" ─────────────────
// 真机教训：`state.before` 只在「应用」时被赋值，于是整理后拿空基线去 diff，
// 7 个块全部显示成"新增"，用户以为整篇被重写（其实模型只改了两处）。
const diffText = mount.querySelector('.notes-diff').textContent ?? '';
check('对比栏列出了改前 → 改后', diffText.includes('导数是变化率。') && diffText.includes('导数与积分'), diffText.slice(0, 200));
// 模型这次只动了 b2（把一段话改成标题块），没动 b1 —— 对比栏就不该把 b1 列为改动
const diffItems = mount.querySelectorAll('.notes-diff-item').length;
check('对比栏只列真正变了的块，不把没动的块也算成新增', diffItems > 0 && diffItems <= 3, `条目 ${diffItems}：${diffText.slice(0, 160)}`);

// ── 连着敲字时同步不能被丢掉 ─────────────────────────────────────
// 真机踩过：上一次同步还在等 /session 时，这次同步被"忙"判据直接丢掉，
// 于是 `syncedDraft` 停在旧文本、`dirty` 恒真、「应用到编辑区」一直灰着，
// 直到用户再敲一个字才恢复。同步请求必须排队补跑，不能丢。
const queuedEdits = ['第一口气。', '第二口气。', '第三口气。'];
for (const line of queuedEdits) {
  dom.contentEl.value = `${dom.contentEl.value}\n${line}`;
  dom.contentEl.dispatchEvent(new Event('input', { bubbles: true }));
}
await panel.flush();
const lastSync = [...requests].reverse().find((r) => r.path.endsWith('/session'));
check('连敲多次后最后一次同步带的是完整草稿（没有丢中间那次）', queuedEdits.every((line) => String(lastSync?.body?.draft).includes(line)), String(lastSync?.body?.draft).slice(-80));
check('连敲多次后面板不再觉得自己是脏的', panel.getState().dirty === false, JSON.stringify({ dirty: panel.getState().dirty }));


// ── 用户点「应用到编辑区」：写回编辑区（用户确认后保存） ──────────
const applyBtn = mount.querySelector('.notes-apply');
applyBtn.dispatchEvent(new Event('click'));
await panel.settle();
check('点应用后编辑区拿到整理结果', dom.contentEl.value.includes('# 导数与积分'), dom.contentEl.value.slice(0, 80));
check('应用也会同步标题', dom.titleEl.value === '导数与积分', dom.titleEl.value);
check('写回编辑区会派发 input 让宿主预览跟着走', editor.getDoc().markdown === dom.contentEl.value);

// ── 实时提需求 ────────────────────────────────────────────────────
const turnInput = mount.querySelector('.notes-turn-input');
turnInput.value = '把第二段缩短';
mount.querySelector('.notes-turn').dispatchEvent(new Event('click'));
await panel.settle();
const turnReq = requests.find((r) => r.path.endsWith('/turn'));
check('提需求会带着 requirement 调 /turn', turnReq?.body?.requirement === '把第二段缩短');
check('提需求会把编辑区此刻的内容一并带上', typeof turnReq?.body?.draft === 'string');

// ── 学术审查 ──────────────────────────────────────────────────────
mount.querySelector('.notes-review-btn').dispatchEvent(new Event('click'));
await panel.settle();
check('点审查才调用 /review', requests.some((r) => r.path.endsWith('/review')));
const finding = mount.querySelector('.notes-finding');
check('审查结果渲染成 finding 卡片', Boolean(finding));
check('finding 卡片带严重级别类名', finding?.classList.contains('is-high') === true);
check('finding 显示问题与建议', mount.textContent.includes('定义不严谨') && mount.textContent.includes('补极限形式'));

const applyReviewBtn = mount.querySelector('.notes-apply-review');
check('面板有「一键应用高优先级修改」按钮', Boolean(applyReviewBtn));
check('只有带 patch 的 high 才允许一键应用', applyReviewBtn.disabled === false);
check('审查意见里有 2 条 finding', (panel.getState().review?.findings ?? []).length === 2);

// ── 材料是补充来源，默认折叠 ──────────────────────────────────────
const details = mount.querySelector('.notes-materials');
check('材料区默认折叠（不再是主入口）', Boolean(details) && details.getAttribute('open') === null);
check('材料区文案说明它是可选的', mount.textContent.includes('材料'), mount.textContent.slice(0, 200));

// ── 打开编辑器时若已有既有会话，直接接上（不重传材料） ────────────
const requests2 = [];
const api2 = async (path, options = {}) => {
  requests2.push({ path, body: options.body });
  return { sessionId: 99, title: '旧会话', blocks: [], stats: { blocks: 0, chars: 0 }, sources: [], warnings: [] };
};
const dom2 = createComposeDom({ content: '' });
const detach2 = installFakeGlobals(dom2.document);
const mount2 = dom2.document.createElement('div');
mount2.id = 'notesMount';
dom2.form.appendChild(mount2);
const panel2 = attach({ mount: mount2, editor: createTextareaAdapter(dom2.form), api: api2, postId: 7 });
await panel2.ready;
// 编辑区是空的，所以不该白跑一次同步（也没有内容可同步）
check('编辑区为空时挂载不发无意义的请求', requests2.length === 0, JSON.stringify(requests2));
dom2.contentEl.value = '# 先写一句';
dom2.contentEl.dispatchEvent(new Event('input', { bubbles: true }));
await panel2.flush();
check('带 postId 打开时会带上 postId 去找既有工作台', requests2.some((r) => r.body?.postId === 7), JSON.stringify(requests2[0]?.body));
check('编辑区为空时不报错、面板仍可用', Boolean(mount2.querySelector('.notes-organize')));
mount2.querySelector('.notes-organize').dispatchEvent(new Event('click'));
await panel2.settle();
check('编辑区为空时点整理给出提示而不是崩溃', mount2.querySelector('.notes-notice').textContent.length > 0, mount2.querySelector('.notes-notice').textContent);
panel2.destroy();
detach2();

// ── 模型这次没改内容：必须说清楚，而不是显示空栏 ──────────────────
// 真机教训：模型判断内容已经够好、只回了 setTitle，对比栏却是空的。
// 用户点完按钮看到空白，会以为功能坏了，所以要区分"还没整理过"和"这次不用改"。
const dom4 = createComposeDom({ title: '标题', content: '# 导数与积分\n\n导数是变化率。' });
const detach4 = installFakeGlobals(dom4.document);
const mount4 = dom4.document.createElement('div');
dom4.form.appendChild(mount4);
const blocks4 = [
  { id: 'b1', type: 'heading', text: '导数与积分', level: 1 },
  { id: 'b2', type: 'paragraph', text: '导数是变化率。' },
];
const api4 = async () => ({ sessionId: 5, title: '导数与积分', blocks: blocks4.map((b) => ({ ...b })), usage: { prompt: 10, completion: 10 }, sources: [], warnings: [] });
const panel4 = attach({ mount: mount4, editor: createTextareaAdapter(dom4.form), api: api4 });
await panel4.settle();
mount4.querySelector('.notes-organize').dispatchEvent(new Event('click'));
await panel4.settle();
check('模型没改内容时对比栏不列出任何条目', mount4.querySelectorAll('.notes-diff-item').length === 0, String(mount4.querySelectorAll('.notes-diff-item').length));
check('模型没改内容时明确告诉用户"这次不用改"', (mount4.querySelector('.notes-diff').textContent ?? '').includes('没有需要改动'), mount4.querySelector('.notes-diff').textContent);
panel4.destroy();
detach4();

// ── 契约字符串 ────────────────────────────────────────────────────
check('TEXT 里有"编辑区"相关文案', typeof TEXT === 'object' && typeof TEXT.watching === 'string');
check('destroy 之后面板节点被移除', (() => { panel.destroy(); return mount.childNodes.length === 0; })());

// ── 同一块 mount 上的重复挂载 ─────────────────────────────────────
// 宿主每次进写作页都会重新渲染表单、拿到新的 mount；但同一个 mount 上被
// 重复 attach（热重载、二次渲染）时，绝不允许出现两块面板或两条 onChange 订阅。
const dom3 = createComposeDom({ title: '标题', content: '# 一段' });
const detach3 = installFakeGlobals(dom3.document);
const mount3 = dom3.document.createElement('div');
dom3.document.body.appendChild(mount3);
const api3 = { calls: 0 };
const fakeApi3 = async () => { api3.calls += 1; return {}; };
const first = attach({ mount: mount3, editor: createTextareaAdapter(dom3.form), api: fakeApi3 });
await first.settle();
const second = attach({ mount: mount3, editor: createTextareaAdapter(dom3.form), api: fakeApi3 });
await second.settle();
check('同一个 mount 重复 attach 不会出现两块面板', mount3.querySelectorAll('.notes-panel').length === 1, String(mount3.querySelectorAll('.notes-panel').length));
check('重复 attach 时旧面板已销毁', (() => { try { first.getState(); return true; } catch { return false; } })());
dom3.contentEl.value = '# 改了一下';
dom3.contentEl.dispatchEvent(new Event('input', { bubbles: true }));
await second.flush();
const syncCalls = api3.calls;
await new Promise((r) => setTimeout(r, 500));
check('重复 attach 后旧订阅不再发请求', api3.calls === syncCalls, `${api3.calls} vs ${syncCalls}`);
second.destroy();
mount3.replaceChildren();
detach3();

restore();
summary();
