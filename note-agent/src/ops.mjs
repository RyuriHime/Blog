/**
 * Op 协议：模型不许直接吐一整篇新草稿，只能给出"块级最小改动"。
 *
 * 这样做的三个理由：
 *   1. **可审** —— 用户在面板上逐条看到"改了第几块、从什么改成什么"，而不是面对一整篇被重写的文章。
 *   2. **可拒** —— 单条 op 目标不存在就直接 skip，幻觉块 id 污染不了草稿【RF-5】。
 *   3. **省 token** —— 微调一轮只回受影响的块，不用把全文再吐一遍。
 *
 * 铁律：`applyOps` **绝不抛异常**，也绝不修改入参。模型给什么怪东西都要变成 skipped。
 */
import { BLOCK_TYPES, BLOCK_ID_RE, isBlockId } from './blocks.mjs';

export const OP_KINDS = ['setTitle', 'replace', 'insert', 'delete', 'setTags', 'setCaption', 'format'];

/** 单条 op 的正文上限，与宿主正文上限（20000）保持一致。 */
export const MAX_OP_TEXT = 20000;
export const MAX_TITLE = 80;
export const MAX_TAGS = 5;
export const MAX_TAG_LENGTH = 20;
/** 单轮最多允许插入多少块，挡住模型"复制粘贴 500 段"这种行为。 */
export const MAX_INSERTS = 40;

const TARGETLESS_KINDS = ['setTitle', 'setTags', 'format'];
const TEXT_KINDS = ['replace', 'insert', 'setCaption'];

/**
 * 模型偶尔会用同义的键名来描述同一件事。
 *
 * 真机实测（deepseek-flash 跑 `/turn`）：提示词里约定的是
 * `{ "kind": "replace", "target": "b2", "text": "新内容" }`，
 * 模型回的是 `{ "op": "replace", "target": "b2", "after": "新内容" }` ——
 * 意思完全对得上，只是把指令名写成 `op`、把新内容写成 `after`。
 *
 * 这类返回**必须照样生效**：否则用户提了要求、面板显示"已处理"，
 * 而草稿一个字都没改（每条 op 都进 skipped 的 `unknown_kind`）。
 * 铁律不变：任何仍然认不出来的东西一律进 skipped，绝不放行。
 */
const KIND_ALIASES = ['op', 'action', 'type_of_op', 'operation', 'do'];
const TEXT_ALIASES = ['after', 'content', 'newText', 'new_text', 'newContent', 'after_text'];
const TITLE_ALIASES = ['title', 'newTitle'];

function pickString(source, keys) {
  for (const key of keys) if (typeof source[key] === 'string') return source[key];
  return '';
}

function pickKind(op) {
  if (typeof op.kind === 'string') return op.kind;
  for (const alias of KIND_ALIASES) {
    if (typeof op[alias] === 'string' && OP_KINDS.includes(op[alias])) return op[alias];
  }
  return undefined;
}

/**
 * 只为了**展示**：把模型写的指令名还原出来（认不出正式 kind 时也尽量给个名字）。
 *
 * `validateOp` 拒绝了一条 op 之后，面板要告诉用户"第几条指令没生效"，
 * 这时得把 `{ "op": "replace" }` 里的 `replace` 显示出来，而不是 `undefined`。
 *
 * @param {unknown} op
 * @returns {string|undefined}
 */
export function rawKindOf(op) {
  if (!op || typeof op !== 'object') return undefined;
  if (typeof op.kind === 'string') return op.kind;
  for (const alias of KIND_ALIASES) {
    if (typeof op[alias] === 'string') return op[alias];
  }
  return undefined;
}

function textOf(op, kind) {
  if (typeof op.text === 'string') return op.text;
  if (typeof op.markdown === 'string') return op.markdown;
  // `after` 对 insert 是"插在哪之后"，只有 replace/setCaption 才把它当正文
  if ((kind === 'replace' || kind === 'setCaption') && typeof op.after === 'string') return op.after;
  return pickString(op, ['content', 'newText', 'new_text', 'new_content', 'after_text']);
}

/**
 * 把模型返回的一条 op 归一到正式形状（`kind` + `text`）。
 *
 * 归一化后 `applyOps` 只认正式字段，别名不会漏进结果里 —— 面板显示的
 * `applied` 里每条都是规范的 `kind`。
 */
export function normalizeOp(op) {
  if (!op || typeof op !== 'object') return null;
  const kind = pickKind(op);
  if (!OP_KINDS.includes(kind)) return null;
  const normalized = { ...op, kind };
  if (TEXT_KINDS.includes(kind)) normalized.text = textOf(op, kind);
  if (kind === 'setTitle') {
    normalized.text = typeof op.text === 'string' ? op.text : pickString(op, TITLE_ALIASES);
  }
  if (kind === 'format' && typeof op.markdown !== 'string') normalized.markdown = '';
  if (kind === 'insert') {
    // insert 的 `after` 只表示插入位置：模型写成 `after_text` 时把正文接过来
    if (typeof normalized.text !== 'string' || normalized.text.length === 0) {
      normalized.text = pickString(op, ['after_text', 'content', 'newText']);
    }
  }
  return normalized;
}

/**
 * 校验单条 op。返回 `{ ok: true, op }` 或 `{ ok: false, reason }`。
 *
 * `ok: true` 时回传的是**归一化后**的 op（别名已换成正式字段）。
 *
 * @param {unknown} op
 * @returns {{ok:true, op:object} | {ok:false, reason:string}}
 */
export function validateOp(input) {
  if (!input || typeof input !== 'object') return { ok: false, reason: 'unknown_kind' };
  const op = normalizeOp(input);
  if (!op) return { ok: false, reason: 'unknown_kind' };
  const kind = op.kind;

  if (kind === 'insert') {
    if (op.after !== null && op.after !== undefined && op.after !== 'start' && !isBlockId(op.after)) {
      return { ok: false, reason: 'bad_target' };
    }
    if (!BLOCK_TYPES.includes(op.type)) return { ok: false, reason: 'unknown_type' };
  }
  if (kind === 'replace' || kind === 'delete' || kind === 'setCaption') {
    if (!isBlockId(op.target)) return { ok: false, reason: 'bad_target' };
  }
  if (kind === 'setTags') {
    if (!Array.isArray(op.tags)) return { ok: false, reason: 'bad_tags' };
    const cleaned = op.tags.map((tag) => String(tag ?? '').trim()).filter((tag) => tag.length > 0 && tag.length <= MAX_TAG_LENGTH);
    if (op.tags.some((tag) => String(tag ?? '').trim().length > MAX_TAG_LENGTH)) return { ok: false, reason: 'bad_tags' };
    if (cleaned.length === 0 && op.tags.length > 0) return { ok: false, reason: 'bad_tags' };
  }
  if (kind === 'format') {
    if (typeof op.markdown !== 'string' || op.markdown.trim().length === 0) return { ok: false, reason: 'empty_text' };
    if (op.markdown.length > MAX_OP_TEXT) return { ok: false, reason: 'text_too_long' };
  }
  if (TEXT_KINDS.includes(kind) || kind === 'setTitle') {
    const text = op.text ?? '';
    if (text.trim().length === 0) return { ok: false, reason: 'empty_text' };
    if (text.length > MAX_OP_TEXT) return { ok: false, reason: 'text_too_long' };
  }
  return { ok: true, op };
}

/** 一条 diff/展示用的单行摘要：type + 前 60 字。 */
function summarize(block) {
  if (!block) return '';
  const text = String(block.text ?? '').replace(/\s+/g, ' ').trim();
  const head = text.length > 60 ? `${text.slice(0, 60)}…` : text;
  return `${block.type}: ${head}`;
}

function nextBlockId(blocks, counter) {
  let max = 0;
  const consider = (id) => {
    const match = /^b(\d+)$/.exec(String(id ?? ''));
    if (match) max = Math.max(max, Number(match[1]));
  };
  for (const block of blocks) consider(block?.id);
  // counter 里存的是 'b3' 这种 id 字符串，不是数字 —— 直接 Number('b3') 会得到 NaN，
  // 而 Math.max(0, NaN) 也是 NaN，于是第 2 条 insert 起 id 全变 'bNaN'（后续针对它的
  // op 一律 bad_target，面板的 diff 也会拿到重复 id）。必须按同一个正则解析。
  for (const id of counter) consider(id);
  return `b${max + 1}`;
}

/**
 * 应用一串 op。绝不抛异常、绝不修改入参。
 *
 * @param {Array<object>} blocks
 * @param {Array<object>} ops
 * @param {{title?:string, tags?:string[], maxInserts?:number}} options
 * @returns {{blocks:Array<object>, title:string, tags:string[], markdown:string|null, applied:Array<object>, skipped:Array<object>, changedBlocks:string[]}}
 */
export function applyOps(blocks, ops, { title = '', tags = [], maxInserts = MAX_INSERTS } = {}) {
  // 入参可能夹着 null/undefined（宿主解析 JSON 出错时就会这样），
  // 这里必须兜住：`block.meta` 对 null 会抛 TypeError，而本函数的契约是「绝不抛异常」。
  let working = (Array.isArray(blocks) ? blocks : []).map((block) => ({
    ...(block ?? {}),
    meta: { ...((block && typeof block === 'object' ? block.meta : null) ?? {}) },
  }));
  const applied = [];
  const skipped = [];
  const counter = new Set();
  // 本轮插入的块：after 锚点 → 目前接在它后面的最后一条新块 id（保证同锚点多插的顺序）
  const afterTail = new Map();
  let nextTitle = String(title ?? '');
  let nextTags = Array.isArray(tags) ? tags.slice() : [];
  let markdown = null;
  let inserts = 0;
  let overridden = false;

  const indexOf = (blockId) => {
    const match = /^b(\d+)$/.exec(String(blockId));
    if (!match) return -1;
    const wanted = Number(match[1]);
    for (let i = 0; i < working.length; i += 1) {
      const idMatch = /^b(\d+)$/.exec(String(working[i].id));
      if (idMatch && Number(idMatch[1]) === wanted) return i;
    }
    return -1;
  };

  const list = Array.isArray(ops) ? ops : [];
  list.forEach((raw, index) => {
    // 先归一化再校验：模型写成 `op`/`after` 这类同义键名时照样能用（见 normalizeOp）
    const verdict = validateOp(raw);
    const normalized = verdict.ok ? verdict.op : null;
    const kind = normalized ? normalized.kind : (raw && typeof raw === 'object' ? pickKind(raw) : undefined);
    if (overridden) {
      skipped.push({ index, kind, reason: 'overridden_by_format' });
      return;
    }
    if (!verdict.ok) {
      skipped.push({ index, kind, reason: verdict.reason, target: raw?.target ?? raw?.after ?? undefined });
      return;
    }
    const op = normalized;

    if (kind === 'setTitle') {
      const raw = String(op.text);
      const value = raw.length > MAX_TITLE ? raw.slice(0, MAX_TITLE) : raw;
      nextTitle = value;
      if (raw.length > MAX_TITLE) {
        skipped.push({ index, kind, reason: 'text_too_long', warning: true, message: `标题超过 ${MAX_TITLE} 字，已截断` });
      }
      applied.push({ index, kind });
      return;
    }

    if (kind === 'setTags') {
      const seen = new Set();
      const cleaned = [];
      for (const tag of op.tags) {
        const value = String(tag ?? '').trim();
        if (value.length === 0 || value.length > MAX_TAG_LENGTH) continue;
        if (seen.has(value)) continue;
        seen.add(value);
        cleaned.push(value);
        if (cleaned.length >= MAX_TAGS) break;
      }
      nextTags = cleaned;
      applied.push({ index, kind });
      return;
    }

    if (kind === 'format') {
      markdown = String(op.markdown);
      // 整篇替换语义：后面所有 op 都不再需要（它们是基于旧草稿算出来的）
      applied.push({ index, kind });
      overridden = true;
      return;
    }

    if (kind === 'insert') {
      if (inserts >= maxInserts) {
        skipped.push({ index, kind, reason: 'too_many_inserts', target: op.after ?? undefined });
        return;
      }
      const block = { id: nextBlockId(working, counter), type: op.type, text: String(op.text), meta: {} };
      counter.add(block.id);
      const after = op.after ?? 'start';
      if (after === 'start') {
        working = [block, ...working];
      } else {
        // 一批 op 里可能有好几条都挂在同一个锚点后面（模型把要补的段落一次列出来时
        // 很常见）。这时后来的必须接在前一条**新插入块**之后，否则整批会被倒序插进去：
        // after 的「上一块」记在 afterTail 里，跟着链走到底。
        let tail = after;
        while (afterTail.has(tail)) tail = afterTail.get(tail);
        const at = indexOf(tail);
        if (at < 0) {
          skipped.push({ index, kind, reason: 'unknown_target', target: after });
          return;
        }
        working = [...working.slice(0, at + 1), block, ...working.slice(at + 1)];
        afterTail.set(tail, block.id);
      }
      inserts += 1;
      applied.push({ index, kind, blockId: block.id });
      return;
    }

    const at = indexOf(op.target);
    if (at < 0) {
      skipped.push({ index, kind, reason: 'unknown_target', target: op.target });
      return;
    }

    if (kind === 'replace') {
      working[at] = { ...working[at], text: String(op.text) };
      applied.push({ index, kind, blockId: op.target });
      return;
    }
    if (kind === 'setCaption') {
      working[at] = { ...working[at], meta: { ...working[at].meta, caption: String(op.text) } };
      applied.push({ index, kind, blockId: op.target });
      return;
    }
    // delete：只从数组移除，不重排其余 id（id 是稳定锚点，重排会让后续 op 全错位）
    working = working.filter((block, i) => i !== at);
    applied.push({ index, kind, blockId: op.target });
  });

  return {
    blocks: working,
    title: nextTitle,
    tags: nextTags,
    markdown,
    applied,
    skipped,
    changedBlocks: applied.filter((entry) => entry.blockId).map((entry) => entry.blockId),
  };
}

export { summarize as summarizeBlock };
