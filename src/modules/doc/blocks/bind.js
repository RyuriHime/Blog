// 块间联动：`props.bind = { from: 'b3', field: 'result' }`。
//
// 设计目标是「渲染前把联动解析掉，并且**检测到环就降级**」——
// 一个用户写出来的环绝不能变成服务器的死循环。
//
// 纯函数，不碰数据库：入参块数组，出参**新数组**（不改调用方的对象）。

/** 沿 bind.from 一路上溯，返回 chain（自己在前、源头在后）或一个坏掉的原因。 */
function chainFor(blockId, byId) {
  const chain = [];
  const seen = new Set();
  let id = blockId;
  while (id) {
    if (seen.has(id)) return { problem: `块间联动成了环：${[...chain, id].join(' → ')}`, chain };
    const block = byId.get(id);
    if (!block) {
      const from = byId.get(chain[chain.length - 1] ?? '')?.props?.bind?.from;
      return { problem: `块间联动指向了不存在的块「${from ?? id}」`, chain };
    }
    seen.add(id);
    chain.push(id);
    const bind = block.props?.bind;
    id = bind && typeof bind === 'object' ? String(bind.from ?? '') : '';
  }
  return { chain };
}

/**
 * 解析全部联动。
 *
 * 返回 `{ blocks, warnings }`：
 * - `blocks` 是新数组，联动的字段已经被上游的值覆盖，**所有 `bind` 都被删掉**
 *   （这样渲染阶段再也看不到 bind，也就不可能递归）；
 * - 环上、或者指向不存在块的块，`bind` 同样被删掉并配一条警告 ——
 *   渲染阶段会因为没有 bind 而正常渲染它原本的默认值，绝不崩。
 */
export function resolveBinds(blocks) {
  const list = Array.isArray(blocks) ? blocks : [];
  const byId = new Map();
  for (const block of list) {
    if (block && typeof block.block_id === 'string') byId.set(block.block_id, block);
  }

  const warnings = [];
  const broken = new Set();
  const resolvedProps = new Map();

  for (const block of list) {
    const bind = block?.props?.bind;
    if (!bind || typeof bind !== 'object') continue;
    const { problem, chain } = chainFor(block.block_id, byId);
    if (problem) {
      for (const id of chain) broken.add(id);
      warnings.push({ block_id: block.block_id, code: 'bind_cycle', message: problem });
      continue;
    }
    // chain 是「自己 → 源头」，反过来就是源头在前，正好是拓扑序。
    for (const id of [...chain].reverse()) {
      const target = byId.get(id);
      const itsBind = target?.props?.bind;
      if (!itsBind || typeof itsBind !== 'object') continue;
      const from = byId.get(String(itsBind.from ?? ''));
      const sourceProps = resolvedProps.get(from.block_id) ?? from.props ?? {};
      const field = String(itsBind.field ?? 'text');
      if (sourceProps[field] === undefined || sourceProps[field] === null) {
        broken.add(id);
        warnings.push({ block_id: id, code: 'bind_field', message: `上游块没有可以联动的字段「${field}」` });
        continue;
      }
      resolvedProps.set(id, { ...(resolvedProps.get(id) ?? target.props), [field]: sourceProps[field] });
    }
  }

  const out = list.map((block) => {
    if (!block || typeof block !== 'object') return block;
    const props = { ...(resolvedProps.get(block.block_id) ?? block.props ?? {}) };
    // 无论成功、成环还是指空，bind 一律不留给渲染阶段。
    delete props.bind;
    if (broken.has(block.block_id)) delete props.bind;
    return { ...block, props };
  });

  return { blocks: out, warnings };
}
