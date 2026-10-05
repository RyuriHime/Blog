// 与 note-agent 的块表示互转。
//
// note-agent 的块是 `{id, type, text, level?, meta?}`（见 `note-agent/src/blocks.mjs`），
// 文档引擎的块是 `{block_id, type, version, props}`。
// 两边刻意**不共享代码**：note-agent 冻结着 88 个测试，动它的风险远大于复制这几十行；
// 而这里有一条对拍测试（`scripts/doc-smoke.mjs` 的 S2.3）守着「同一批块序列化出的 markdown 逐字节相同」。
import { BLOCK_ID_PATTERN } from '../schema.js';

/** 与 note-agent 对拍的 7 种类型（顺序就是 `agent.BLOCK_TYPES` 的顺序）。 */
export const AGENT_BLOCK_TYPES = ['heading', 'paragraph', 'list', 'code', 'table', 'formula', 'image'];

/** note-agent 的块 → 文档引擎的块。 */
export function fromNoteAgentBlocks(blocks) {
  return (Array.isArray(blocks) ? blocks : []).map((raw, index) => {
    const type = String(raw?.type ?? '');
    const id = String(raw?.id ?? '');
    const block_id = BLOCK_ID_PATTERN.test(id) ? id : `b${index + 1}`;
    const props = {};
    if (raw?.text !== undefined && raw?.text !== null) props.text = String(raw.text);
    if (raw?.level !== undefined && raw?.level !== null) props.level = raw.level;
    const meta = raw?.meta && typeof raw.meta === 'object' ? raw.meta : null;
    if (meta) {
      if (meta.lang !== undefined && meta.lang !== '') props.lang = String(meta.lang);
      if (Array.isArray(meta.rows)) {
        props.rows = meta.rows.map((row) =>
          Array.isArray(row) ? row.map((cell) => String(cell ?? '')) : [String(row ?? '')],
        );
      }
      if (meta.alt !== undefined) props.alt = String(meta.alt);
      if (meta.src !== undefined) props.src = String(meta.src);
    }
    return { block_id, type, version: 1, props };
  });
}

/** 文档引擎的块 → note-agent 的块（导出 / 交给 note-agent 继续处理时用）。 */
export function toNoteAgentBlocks(blocks) {
  return (Array.isArray(blocks) ? blocks : []).map((block, index) => {
    const type = String(block?.type ?? '');
    const props = block?.props && typeof block.props === 'object' ? block.props : {};
    const id = BLOCK_ID_PATTERN.test(String(block?.block_id ?? '')) ? String(block.block_id) : `b${index + 1}`;
    const out = { id, type };
    if (props.text !== undefined) out.text = String(props.text);
    if (type === 'heading' && props.level !== undefined) out.level = Number(props.level);
    if (type === 'code' && props.lang) out.meta = { lang: String(props.lang) };
    if (type === 'table' && Array.isArray(props.rows)) out.meta = { rows: props.rows };
    if (type === 'image') out.meta = { alt: props.alt ?? '', src: props.src ?? '' };
    return out;
  });
}
