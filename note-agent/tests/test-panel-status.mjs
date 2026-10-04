/**
 * 状态胶囊不能骗人。
 *
 * 真机教训（第四轮验收）：用户提了需求、模型改出了 220 字的草稿，但用户还没点
 * 「应用到编辑区」—— 编辑区里仍然是 154 字。当时面板只有一个胶囊，写着
 * 「正在跟随编辑区 · 7 块 · 220 字」，读起来就像编辑区已经有 220 字了。
 *
 * 现在拆成两颗：左边报**编辑区此刻**的真实长度，右边报模型手上的**草稿**。
 */
import { createChecker } from './helpers/check.mjs';
import { createComposeDom, installFakeGlobals } from './helpers/fake-dom.mjs';

const { check, summary } = createChecker();

const EDITOR_MD = '# 导数\n\n导数是变化率。';
const DRAFT_MD = '# 导数与积分\n\n导数是变化率。\n\n积分是累积量。';

const dom = createComposeDom({ title: '导数', content: EDITOR_MD });
installFakeGlobals(dom.document);
const { attach, createTextareaAdapter } = await import('../client/notes-panel.mjs');

const api = async (path) => {
  if (path.endsWith('/session')) {
    return {
      sessionId: 9,
      blocks: [{ id: 'b1', type: 'heading', text: '# 导数', level: 1 }],
      stats: { blocks: 1, chars: EDITOR_MD.length },
      sources: [],
      warnings: [],
    };
  }
  if (path.endsWith('/generate')) {
    return {
      sessionId: 9,
      title: '导数与积分',
      tags: [],
      blocks: [
        { id: 'b1', type: 'heading', text: '导数与积分', level: 1 },
        { id: 'b2', type: 'paragraph', text: '导数是变化率。' },
        { id: 'b3', type: 'paragraph', text: '积分是累积量。' },
      ],
      ops: [{ kind: 'setTitle', text: '导数与积分' }],
      applied: [{ index: 0, kind: 'setTitle' }],
      draftMd: DRAFT_MD,
      skipped: [],
      notes: [],
      needsMore: [],
      warnings: [],
      usage: { prompt: 100, completion: 200 },
    };
  }
  if (path.endsWith('/apply')) {
    return {
      sessionId: 9,
      title: '导数与积分',
      blocks: [{ id: 'b1', type: 'heading', text: '导数与积分', level: 1 }],
      draftMd: DRAFT_MD,
      applied: [],
      skipped: [],
      usage: { prompt: 100, completion: 200 },
    };
  }
  throw new Error(`未预期的请求：${path}`);
};

const mount = dom.document.createElement('div');
dom.form.appendChild(mount);
const editor = createTextareaAdapter(dom.form);
const panel = attach({ mount, editor, api });
await panel.ready;

const statusText = () => mount.querySelector('.notes-status')?.textContent ?? '';
const chips = () => mount.querySelectorAll('.notes-status').map((node) => node.textContent);

check('面板里有状态胶囊', mount.querySelectorAll('.notes-status').length >= 1, JSON.stringify(chips()));
check('还没整理时，状态胶囊报的是编辑区的内容', statusText().includes('正在跟随编辑区'), statusText());

mount.querySelector('.notes-organize').dispatchEvent(new Event('click'));
await panel.settle();

check('整理之后草稿已经和编辑区不一样了（模型改了标题）', panel.getState().draftMd === DRAFT_MD);
const afterOrganize = chips();
check('状态区拆成两颗胶囊：编辑区 + 草稿', afterOrganize.length === 2, JSON.stringify(afterOrganize));
check('编辑区那颗报的是编辑区此刻的长度，不是草稿的长度', afterOrganize[0].includes('正在跟随编辑区') && afterOrganize[0].includes(`${EDITOR_MD.trim().length} 字`) && !afterOrganize[0].includes(`${DRAFT_MD.trim().length} 字`), afterOrganize[0]);
check('草稿那颗明说是草稿', afterOrganize[1].includes('草稿'), afterOrganize[1]);
check('编辑区那颗也点出草稿字数，避免被误读成"编辑区已经有这么长"', afterOrganize[0].includes('草稿'), afterOrganize[0]);
check('编辑区没有被偷偷改写（用户没点应用）', dom.contentEl.value === EDITOR_MD);

mount.querySelector('.notes-apply').dispatchEvent(new Event('click'));
await panel.settle();
const afterApply = chips();
check('应用之后编辑区拿到草稿', dom.contentEl.value === DRAFT_MD);
check('应用之后不再报"草稿 N 字"（两边已经一致）', !afterApply[0].includes('草稿'), afterApply[0]);
check('应用之后编辑区那颗报的就是新长度', afterApply[0].includes(`${DRAFT_MD.trim().length} 字`), afterApply[0]);

summary();
