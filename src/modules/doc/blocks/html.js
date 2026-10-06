// 服务端渲染：块数组 → HTML。
//
// 这是**唯一的安全边界**。所有块类型都只往这里吐已经转义过的片段，
// 而这里负责三件事：
//   1. 先跑 `resolveBinds`（联动解析 + 环检测），渲染阶段再也看不到 bind；
//   2. 逐块校验 props —— 校验不过就**降级成占位**，绝不抛异常、绝不白屏（FR-BLOCK-05）；
//   3. 未注册的类型、以及比当前实现更新的块版本，同样降级成占位。
import { getBlockType } from './registry.js';
import { resolveBinds } from './bind.js';
import { validateProps } from './validate.js';
import { escapeHtml } from './text.js';

/** 一块坏掉的块长什么样：可辨认、可点击定位、不带任何可执行内容。 */
function placeholder(block, message) {
  const id = escapeHtml(block?.block_id ?? '');
  const type = escapeHtml(block?.type ?? '');
  return (
    `<div class="doc-block doc-block-unknown" data-block-id="${id}" data-block-type="${type}">` +
    `<p class="doc-block-warning">${escapeHtml(message)}</p>` +
    '</div>'
  );
}

/**
 * 渲染一篇文章的全部块。
 *
 * @param {Array} blocks 块数组
 * @param {object} [options] 传给各块 `toHtml` 的上下文（`resolveBinds:false` 可跳过联动解析）
 * @returns {{ html: string, warnings: Array<{block_id: string, code: string, message: string}> }}
 */
export function renderBlocks(blocks, options = {}) {
  const list = Array.isArray(blocks) ? blocks : [];
  const resolved = options.resolveBinds === false ? { blocks: list, warnings: [] } : resolveBinds(list);
  const warnings = [...resolved.warnings];
  const parts = [];

  for (const block of resolved.blocks) {
    if (!block || typeof block !== 'object') continue;
    const type = getBlockType(block.type);
    if (!type) {
      const message = `未注册的块类型「${String(block.type ?? '')}」`;
      parts.push(placeholder(block, message));
      warnings.push({ block_id: String(block.block_id ?? ''), code: 'unknown_type', message });
      continue;
    }

    // 比当前实现更新的块版本：宁可降级，也不要按老规则解释新字段。
    const version = Number(block.version);
    if (Number.isFinite(version) && version > type.version) {
      const message = `块类型「${type.name}」的版本 ${version} 比本站支持的 ${type.version} 新`;
      parts.push(placeholder(block, message));
      warnings.push({ block_id: String(block.block_id ?? ''), code: 'future_version', message });
      continue;
    }

    const result = validateProps(type, block.props);
    if (!result.ok) {
      parts.push(placeholder(block, result.problem));
      warnings.push({ block_id: String(block.block_id ?? ''), code: 'bad_props', message: result.problem });
      continue;
    }

    parts.push(type.toHtml(result.value, block, options));
  }

  return { html: parts.join('\n'), warnings };
}

export { placeholder };
