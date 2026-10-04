// 模块名册 —— **这是全仓库唯一一处列举业务模块的地方。**
//
// 要加一块新功能（比如「团队」），只做两件事：
//   1) 在 src/modules/ 下建一个文件夹，导出 name / apiPrefix / owns / reads / install(ctx)
//   2) 在下面这个数组里加一行 import 与一项
// 别的地方（src/server.js、src/core/*）一个字都不用改。
//
// scripts/check-skeleton.mjs 会检查「除了这个文件，没有第二处 import 业务模块」。
import core from './core/index.js';
import feed from './feed/index.js';
import doc from './doc/index.js';
import ai from './ai/index.js';
import team from './team/index.js';
import ui from './ui/index.js';

/** 名册顺序 = 建表顺序 = 路由登记顺序。core 必须排第一（它的表是其它表的外键目标）。 */
export const MODULES = [core, feed, doc, ai, team, ui];

/**
 * 把名册里所有模块装上。
 *
 * 每个模块的 install(ctx) 里可以做三件事：登记自己的表、登记自己的路由、登记 afterReady 钩子。
 * 返回一份「装了什么」的清单，供启动日志与 /api/site 使用。
 *
 * @param {ReturnType<import('../core/context.js').createContext>} ctx
 */
export function installModules(ctx) {
  const installed = [];
  for (const module of MODULES) {
    if (typeof module.install === 'function') module.install(ctx);
    installed.push({
      name: module.name,
      apiPrefix: module.apiPrefix,
      owns: module.owns,
      reads: module.reads ?? [],
    });
  }
  return installed;
}
