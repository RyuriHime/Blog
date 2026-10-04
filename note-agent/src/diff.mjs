/**
 * 块级 diff：把"应用 op 之前"和"应用 op 之后"的块数组压成几条人能读的变更。
 *
 * 面板上要显示的就是它 —— 用户点"应用"之前得先看清到底动了哪些块。
 * 刻意不做 LCS：块级粒度上「id 交集 + 文本/类型比对 + 相对顺序比对」已经够用，
 * 而且结果稳定可测（LCS 在大量相同文本的块上会给出反直觉的对齐）。
 */
import { summarizeBlock } from './ops.mjs';

/** 判断两个块除 id 外是否等价。 */
function sameBlock(a, b) {
  if (!a || !b) return false;
  if (a.type !== b.type) return false;
  if (String(a.text ?? '') !== String(b.text ?? '')) return false;
  return Number(a.level ?? a.meta?.level ?? 0) === Number(b.level ?? b.meta?.level ?? 0);
}

/**
 * @param {Array<object>} before
 * @param {Array<object>} after
 * @returns {Array<{kind:'add'|'del'|'mod'|'move', blockId:string, before?:string, after?:string}>}
 */
export function diffBlocks(before, after) {
  const beforeList = Array.isArray(before) ? before : [];
  const afterList = Array.isArray(after) ? after : [];
  const beforeById = new Map(beforeList.map((block) => [block.id, block]));
  const afterIds = new Set(afterList.map((block) => block.id));

  const result = [];

  // 1. del：在 before 里有、after 里没有的，按 before 的顺序
  for (const block of beforeList) {
    if (!afterIds.has(block.id)) {
      result.push({ kind: 'del', blockId: block.id, before: summarizeBlock(block) });
    }
  }

  // 2~3. add / mod：按 after 的顺序。move 需要遍历完才能判定，所以先记着，最后追加。
  const moves = [];
  const beforeOrder = new Map(beforeList.map((block, index) => [block.id, index]));
  let maxSeen = -1;

  for (let index = 0; index < afterList.length; index += 1) {
    const block = afterList[index];
    const old = beforeById.get(block.id);

    if (!old) {
      result.push({ kind: 'add', blockId: block.id, after: summarizeBlock(block) });
      continue;
    }
    if (!sameBlock(old, block)) {
      result.push({ kind: 'mod', blockId: block.id, before: summarizeBlock(old), after: summarizeBlock(block) });
      continue;
    }
    // 未改动的共同块：相对顺序变化就记 move。
    // 判据是这个块在 before 里的下标比之前见过的最大值还小 —— 说明它在 after 里被提前了，
    // 也就是原来的顺序被打乱了。只对未改动的块判定，避免"重写过的块"同时报 mod 和 move。
    const beforeIndex = beforeOrder.get(block.id);
    if (beforeIndex < maxSeen) moves.push({ kind: 'move', blockId: block.id });
    maxSeen = Math.max(maxSeen, beforeIndex);
  }

  return [...result, ...moves];
}
