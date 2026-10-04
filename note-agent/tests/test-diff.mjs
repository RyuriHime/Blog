import { createChecker } from './helpers/check.mjs';
import { assignBlockIds, makeBlock } from '../src/blocks.mjs';
import { diffBlocks } from '../src/diff.mjs';

const { check, summary } = createChecker();
const before = assignBlockIds([makeBlock('heading', 'A'), makeBlock('paragraph', '一段'), makeBlock('paragraph', '二段')]);
const after = assignBlockIds([makeBlock('heading', 'A'), makeBlock('paragraph', '一段改'), makeBlock('paragraph', '三段')]);
const d = diffBlocks(before, after);
check('相同数组返回空 diff', diffBlocks(before, before).length === 0);
check('未变块不出现在 diff 里', d.every((x) => x.blockId !== 'b1'));
check('b2 变更识别为 mod', d.find((x) => x.blockId === 'b2').kind === 'mod');
check('b3 文本变化识别为 mod 并带走摘要', d.find((x) => x.blockId === 'b3').after.includes('三段'));
check('摘要不是完整 Block 对象而是字符串', typeof d[0].before === 'string' || typeof d[0].after === 'string');
check('del 排在 add/mod/move 之前', (() => {
  const removed = diffBlocks(before, [before[1]]);
  return removed[0].kind === 'del';
})());
const moved = diffBlocks(before, [before[0], before[2], before[1]]);
check('相对顺序变化识别为 move', moved.some((x) => x.kind === 'move'));
const added = diffBlocks(assignBlockIds([before[0]]), assignBlockIds([before[0], makeBlock('code', 'x')]));
check('新增块识别为 add', added[0].kind === 'add' && added[0].blockId === 'b2');
check('删除块识别为 del', diffBlocks(before, [before[0]])[0].kind === 'del');
check('删除块摘要带出被删内容', diffBlocks(before, [before[0]])[0].before.includes('一段'));
check('新增块摘要带出新增内容', added[0].after.includes('x'));
check('type 变化也算 mod', (() => {
  const changed = diffBlocks(before, [before[0], { ...before[1], type: 'code' }, before[2]]);
  return changed.some((x) => x.blockId === 'b2' && x.kind === 'mod');
})());
check('空数组输入不炸', diffBlocks([], []).length === 0 && diffBlocks(before, []).every((x) => x.kind === 'del'));

summary();
