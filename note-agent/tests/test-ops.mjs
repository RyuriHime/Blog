import { createChecker } from './helpers/check.mjs';
import { assignBlockIds, makeBlock, isBlockId } from '../src/blocks.mjs';
import { applyOps, validateOp, OP_KINDS } from '../src/ops.mjs';

const { check, summary } = createChecker();
const base = assignBlockIds([makeBlock('heading', '旧标题', { level: 1 }), makeBlock('paragraph', '第一段'), makeBlock('paragraph', '第二段')]);

const r = applyOps(base, [
  { kind: 'setTitle', text: '新的文章标题' },
  { kind: 'replace', target: 'b2', text: '第一段（已改写）' },
  { kind: 'insert', after: 'b2', type: 'paragraph', text: '插入的新段' },
  { kind: 'delete', target: 'b3' },
  { kind: 'setTags', tags: ['微积分', '导数', '导数', ''] },
]);
check('五个 op 全部 applied', r.applied.length === 5 && r.skipped.length === 0);
check('setTitle 结果独立返回', r.title === '新的文章标题');
check('replace 生效', r.blocks.find((b) => b.id === 'b2').text === '第一段（已改写）');
check('insert 插到目标之后且 id 递增', r.blocks[2].text === '插入的新段' && Number(r.blocks[2].id.slice(1)) === 4);
check('delete 移除块但不重排其余 id', r.blocks.map((b) => b.id).join(',') === 'b1,b2,b4');
check('setTags 去重去空', r.tags.join(',') === '微积分,导数');

const halluc = applyOps(base, [{ kind: 'replace', target: 'b99', text: 'x' }, { kind: 'insert', after: 'b42', type: 'paragraph', text: 'y' }, { kind: 'frobnicate', text: 'z' }]);
check('【RF-5】幻觉 id 与非法 kind 只进 skipped 不污染草稿', halluc.skipped.length === 3 && halluc.applied.length === 0 && halluc.blocks.map((b) => b.id).join(',') === 'b1,b2,b3');
check('【RF-5】skip 原因可读', halluc.skipped[0].reason === 'unknown_target' && halluc.skipped[2].reason === 'unknown_kind');
check('【RF-5】skipped 保留原始下标与 kind 便于面板展示', halluc.skipped[0].index === 0 && halluc.skipped[0].kind === 'replace' && halluc.skipped[0].target === 'b99');
check('【RF-5】入参 blocks 不被修改', base.map((b) => b.id).join(',') === 'b1,b2,b3' && base[1].text === '第一段');

const long = applyOps(base, [{ kind: 'setTitle', text: '标'.repeat(200) }]);
check('setTitle 超 80 字被截断', long.title.length === 80);
const manyTags = applyOps(base, [{ kind: 'setTags', tags: ['a', 'b', 'c', 'd', 'e', 'f'] }]);
check('标签最多 5 个', manyTags.tags.length === 5);

const longText = applyOps(base, [{ kind: 'replace', target: 'b2', text: '字'.repeat(25000) }]);
check('超长正文进 skipped 且不改块', longText.skipped.length === 1 && longText.skipped[0].reason === 'text_too_long' && longText.blocks[1].text === '第一段');

const fmt = applyOps(base, [{ kind: 'format', markdown: '# 全篇' }, { kind: 'replace', target: 'b2', text: 'x' }]);
check('format 之后的操作被跳过并说明原因', fmt.skipped[0].reason === 'overridden_by_format');
check('format 提供整篇 markdown', fmt.markdown === '# 全篇' && fmt.applied.length === 1);
check('validateOp 校验目标格式', validateOp({ kind: 'replace', target: 'B1' }).ok === false && validateOp({ kind: 'replace', target: 'b1', text: 'x' }).ok === true);
check('validateOp 拒绝空文本', validateOp({ kind: 'insert', after: 'b1', type: 'paragraph', text: '   ' }).reason === 'empty_text');
check('validateOp 拒绝未知块类型', validateOp({ kind: 'insert', after: 'b1', type: 'nope', text: 'x' }).reason === 'unknown_type');
check('validateOp 拒绝非法标签', validateOp({ kind: 'setTags', tags: ['x'.repeat(30)] }).reason === 'bad_tags');
check('validateOp 拒绝未知 kind', validateOp({ kind: 'frobnicate' }).reason === 'unknown_kind');
check('validateOp 通过时回传 op 本身', validateOp({ kind: 'setTitle', text: 't' }).op.kind === 'setTitle');
check('OP_KINDS 恰好 7 种', OP_KINDS.length === 7 && OP_KINDS.join(',') === 'setTitle,replace,insert,delete,setTags,setCaption,format');

const del = applyOps(base, [{ kind: 'delete', target: 'b2' }, { kind: 'replace', target: 'b2', text: '再来一次' }]);
check('delete 之后再引用同一目标 → unknown_target', del.skipped.length === 1 && del.skipped[0].reason === 'unknown_target');

const insertStart = applyOps(base, [{ kind: 'insert', after: 'start', type: 'paragraph', text: '开头段' }]);
check('after=start 插到最前', insertStart.blocks[0].text === '开头段');
const insertNull = applyOps(base, [{ kind: 'insert', after: null, type: 'paragraph', text: '开头段' }]);
check('after=null 同样插到最前', insertNull.blocks[0].text === '开头段');

const caption = applyOps(base, [{ kind: 'setCaption', target: 'b2', text: '图 1：导数示意' }]);
check('setCaption 写入 meta.caption 且不覆盖正文', caption.blocks[1].meta.caption === '图 1：导数示意' && caption.blocks[1].text === '第一段');

const capped = applyOps(base, Array.from({ length: 45 }, (_, i) => ({ kind: 'insert', after: 'b1', type: 'paragraph', text: `第 ${i} 段` })));
check('insert 数量上限 40', capped.applied.length === 40 && capped.skipped.some((s) => s.reason === 'too_many_inserts'));

/* ------------------------------------------------------------------ */
/* 【回归】insert 的 id 生成：第 2 条起曾经全部撞成 `bNaN`                    */
/* ------------------------------------------------------------------ */
// nextBlockId 里 `for (const id of counter) max = Math.max(max, Number(id))`，
// 而 counter 存的是 'b3' 这样的 id 字符串 —— Number('b3') 是 NaN，
// Math.max(0, NaN) 也是 NaN，于是第 2 条 insert 起 id 全变成 'bNaN'：
// 后续针对它的 op 一律 bad_target，面板的 diff 也会拿到重复 id。
const multiInsert = applyOps(base, [
  { kind: 'insert', after: 'b1', type: 'paragraph', text: '甲' },
  { kind: 'insert', after: 'b1', type: 'paragraph', text: '乙' },
  { kind: 'insert', after: 'b1', type: 'paragraph', text: '丙' },
]);
const multiIds = multiInsert.blocks.map((b) => b.id);
check(
  '【回归】一次插多块时每块 id 都合法且互不相同',
  multiIds.every((id) => isBlockId(id)) && new Set(multiIds).size === multiIds.length,
  `ids=${JSON.stringify(multiIds)}`,
);
check(
  '【回归】insert 出来的块都在（文本对得上）',
  ['甲', '乙', '丙'].every((text) => multiInsert.blocks.some((b) => b.text === text)),
  JSON.stringify(multiInsert.blocks.map((b) => b.text)),
);
check(
  '【回归】插到同一锚点之后的多块按给出顺序排（首插紧随锚点）',
  multiInsert.blocks.map((b) => b.text).join('|') === '旧标题|甲|乙|丙|第一段|第二段',
  JSON.stringify(multiInsert.blocks.map((b) => b.text)),
);
check('【回归】applyOps 对畸形入参（数组里有 null）不抛异常', (() => {
  try {
    applyOps([null, makeBlock('paragraph', '正常块')], [], {});
    return true;
  } catch {
    return false;
  }
})());

/* ------------------------------------------------------------------ */
/* 【真机验收】模型实际返回的字段名与提示词约定不一致时，不能静默失效          */
/* ------------------------------------------------------------------ */
// 真机跑 /turn 时模型回的是 {"op":"replace","target":"b2","after":"新正文"}：
// 用 `op` 表示指令名、用 `after` 表示新内容，而提示词约定的是 kind + text。
// 这种"意思完全对得上、只是键名不同"的返回必须照样生效 —— 否则用户提了要求，
// 面板显示"整改完成"，实际一个字都没改（unknown_kind 被吞进 skipped）。
const aliasReplace = applyOps(base, [{ op: 'replace', target: 'b2', after: '改写后的第一段' }]);
check('【真机验收】op/after 写法的 replace 也要生效', aliasReplace.applied.length === 1 && aliasReplace.blocks[1].text === '改写后的第一段', JSON.stringify(aliasReplace.skipped));
check('【真机验收】别名 op 记为 replace', aliasReplace.applied[0].kind === 'replace');
const aliasText = applyOps(base, [{ op: 'replace', target: 'b2', text: '用 text 的新正文' }]);
check('【真机验收】op + text 组合同样生效', aliasText.blocks[1].text === '用 text 的新正文');
const aliasInsert = applyOps(base, [{ op: 'insert', after: 'b1', type: 'paragraph', after_text: '插进来的段落' }]);
check('【真机验收】别名 insert 生效', aliasInsert.applied.length === 1);
const aliasTitle = applyOps(base, [{ op: 'setTitle', title: '别名标题' }]);
check('【真机验收】别名 setTitle 生效', aliasTitle.title === '别名标题', JSON.stringify(aliasTitle.skipped));
check('【真机验收】validateOp 也认别名', validateOp({ op: 'replace', target: 'b1', after: 'x' }).ok === true);
check('【真机验收】别名与正式写法并存时以正式写法为准', applyOps(base, [{ kind: 'replace', op: 'delete', target: 'b2', text: '正式写法赢' }]).blocks[1].text === '正式写法赢');
check('【真机验收】别名也救不了未知指令名', validateOp({ op: 'frobnicate', target: 'b1' }).reason === 'unknown_kind');

summary();
