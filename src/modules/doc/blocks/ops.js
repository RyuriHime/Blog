// 一批 op 的应用器（`POST /api/docs/:id/ops`）。
//
// 语义与审计字段沿用 `note-agent/src/ops.mjs`，但**不能直接 import 它**：
// 那边是围绕旧块形状（`{id, type, text}`）写的，`validateOp` 里还钉着
// note-agent 自己那 7 个类型 —— 拿它来校验会让新增的 5 种块全部被拒。
// 所以这里只沿用语义（kind 归一化、`applied` / `rejected` + reason、绝不抛异常）：
//
//   insert  {after: 'b1'|'start'|null, type, props}
//   replace {target, type?, props}
//   delete  {target}
//   move    {target, after: 'b2'|'start'|null}
//   setTitle{text}
//
// 和 note-agent 一样的硬约定：**绝不抛异常、绝不修改入参**。
// 半路出错就跳过那一条（进 `rejected`），剩下的照常应用 ——
// 一批 op 里有一条坏的，不该让整批白干。
import { BLOCK_ID_PATTERN, MAX_DOC_TITLE } from '../schema.js';

export const OP_KINDS = ['insert', 'replace', 'delete', 'move', 'setTitle'];

/** 一批最多多少条（AI 一次改太多说明它跑偏了）。 */
export const MAX_OPS = 50;

/** 单条文本的上限，与 note-agent 的 MAX_OP_TEXT 同一个量级。 */
export const MAX_OP_TEXT = 20000;

/** 一条 op 的 kind：认 `kind`，也认 `op`（模型两种写法都会吐）。 */
function kindOf(op) {
  if (!op || typeof op !== 'object') return '';
  const raw = typeof op.kind === 'string' ? op.kind : typeof op.op === 'string' ? op.op : '';
  // 别名：note-agent 的 setCaption / format 在这里对应的就是 replace。
  if (raw === 'setCaption' || raw === 'format') return 'replace';
  return raw;
}

function isTarget(value) {
  return typeof value === 'string' && BLOCK_ID_PATTERN.test(value);
}

/** `after` 归一化：`null` / `'end'` / 空串 都表示"放到最后"。 */
function normalizeAfter(value) {
  if (value === 'start') return 'start';
  if (isTarget(value)) return value;
  return null;
}

function summaryOf(block) {
  const props = block?.props ?? {};
  const text = String(props.text ?? props.question ?? props.target ?? props.url ?? props.app ?? '');
  const head = text.replace(/\s+/g, ' ').trim().slice(0, 60);
  return `${block?.type ?? '?'}: ${head}`;
}

/** 把一块挪到 `after` 之后（`start` = 最前），返回新数组。 */
function moveWithin(list, blockId, after) {
  const index = list.findIndex((block) => block.block_id === blockId);
  if (index < 0) return null;
  const next = [...list];
  const [block] = next.splice(index, 1);
  if (after === 'start') {
    next.unshift(block);
  } else {
    const at = next.findIndex((item) => item.block_id === after);
    next.splice(at < 0 ? next.length : at + 1, 0, block);
  }
  return next;
}

/**
 * 应用一批 op。
 *
 * @param {Array<object>} blocks 当前块序列（不会被修改）
 * @param {Array<object>} ops
 * @param {{startNumber?:number, isKnownType?:(t:string)=>boolean}} options
 *   `startNumber` 是"下一个可用块号"（= 库里最大块号 + 1），
 *   同一批里的 insert 会从这里依次取号，后面的 op 就能引用新块。
 * @returns {{blocks:Array, title:string|null, applied:Array, rejected:Array}}
 */
export function applyDocOps(blocks, ops, { startNumber = 1, isKnownType = () => true } = {}) {
  let list = (Array.isArray(blocks) ? blocks : []).map((block) => ({ ...block, props: { ...(block.props ?? {}) } }));
  const applied = [];
  const rejected = [];
  let title = null;
  let counter = Number(startNumber) > 0 ? Number(startNumber) : 1;

  const incoming = Array.isArray(ops) ? ops : [];
  if (incoming.length > MAX_OPS) {
    return { blocks: list, title, applied, rejected: incoming.map((_, index) => ({ index, reason: 'too_many_ops' })) };
  }

  for (const [index, op] of incoming.entries()) {
    const kind = kindOf(op);
    if (!OP_KINDS.includes(kind)) {
      rejected.push({ index, reason: 'unknown_kind' });
      continue;
    }

    if (kind === 'setTitle') {
      const text = typeof op.text === 'string' ? op.text : typeof op.title === 'string' ? op.title : '';
      const clean = text.replace(/[\r\n]+/g, ' ').trim();
      if (!clean) {
        rejected.push({ index, reason: 'empty_text' });
        continue;
      }
      if (clean.length > MAX_DOC_TITLE) {
        rejected.push({ index, reason: 'text_too_long' });
        continue;
      }
      title = clean;
      applied.push({ kind, title: clean });
      continue;
    }

    if (kind === 'insert') {
      const type = String(op.type ?? '');
      const after = normalizeAfter(op.after);
      if (!isKnownType(type)) {
        rejected.push({ index, reason: 'unknown_type' });
        continue;
      }
      if (op.after !== undefined && op.after !== null && after === null) {
        rejected.push({ index, reason: 'bad_target' });
        continue;
      }
      const blockId = `b${counter}`;
      counter += 1;
      const block = {
        block_id: blockId,
        type,
        version: Number(op.version) || 1,
        props: op.props && typeof op.props === 'object' ? op.props : {},
      };
      const at = after === 'start' ? -1 : after === null ? list.length - 1 : list.findIndex((item) => item.block_id === after);
      if (after !== null && after !== 'start' && at < 0) {
        rejected.push({ index, reason: 'bad_target' });
        counter -= 1;
        continue;
      }
      list.splice(at + 1, 0, block);
      applied.push({ kind, blockId, summary: summaryOf(block) });
      continue;
    }

    const target = op.target ?? op.block_id;
    if (!isTarget(target)) {
      rejected.push({ index, reason: 'bad_target' });
      continue;
    }
    const found = list.find((block) => block.block_id === target);
    if (!found) {
      rejected.push({ index, reason: 'bad_target' });
      continue;
    }

    if (kind === 'delete') {
      list = list.filter((block) => block.block_id !== target);
      applied.push({ kind, blockId: target, summary: summaryOf(found) });
      continue;
    }

    if (kind === 'move') {
      const after = normalizeAfter(op.after);
      if (after !== null && after !== 'start' && !list.some((block) => block.block_id === after)) {
        rejected.push({ index, reason: 'bad_target' });
        continue;
      }
      list = moveWithin(list, target, after) ?? list;
      applied.push({ kind, blockId: target });
      continue;
    }

    // replace
    const nextType = op.type === undefined ? found.type : String(op.type);
    if (!isKnownType(nextType)) {
      rejected.push({ index, reason: 'unknown_type' });
      continue;
    }
    const props = op.props && typeof op.props === 'object' ? op.props : null;
    const text = typeof op.text === 'string' ? op.text : null;
    if (!props && text === null) {
      rejected.push({ index, reason: 'empty_text' });
      continue;
    }
    if (text !== null && text.length > MAX_OP_TEXT) {
      rejected.push({ index, reason: 'text_too_long' });
      continue;
    }
    const updated = {
      ...found,
      type: nextType,
      props: props ? { ...props } : { ...found.props, text },
    };
    list = list.map((block) => (block.block_id === target ? updated : block));
    applied.push({ kind, blockId: target, summary: summaryOf(updated) });
  }

  return { blocks: list, title, applied, rejected };
}
