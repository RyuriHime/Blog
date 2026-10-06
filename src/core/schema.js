// 建表登记处门面。
//
// 真正的实现只有 60 行，在 src/core/table.js。这里之所以还留一层：
// 1) 让模块 import 到的是「稳定的门面」，实现细节以后可以换；
// 2) 提供两个骨架自检用的查询（谁登记了表、有没有登记了却没主的东西）。
export { schemas } from './table.js';
import { schemas } from './table.js';

/**
 * 找出「登记了但没人认领」的表。
 * @param {{ owns: string[] }[]} modules
 * @returns {string[]} 没有归属的表名
 */
export function tablesWithoutOwner(modules) {
  const claimed = new Set(modules.flatMap((module) => module.owns));
  return schemas.names().filter((name) => !claimed.has(name));
}

/**
 * 找出「某个模块说自己拥有、但其实没登记（或写错名字）」的表。
 * @param {{ name: string, owns: string[] }[]} modules
 * @returns {{ module: string, table: string }[]}
 */
export function ownedButNotRegistered(modules) {
  const registered = new Set(schemas.names());
  const problems = [];
  for (const module of modules) {
    for (const table of module.owns) {
      if (!registered.has(table)) problems.push({ module: module.name, table });
    }
  }
  return problems;
}
