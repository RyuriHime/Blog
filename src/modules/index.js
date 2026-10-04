// 模块名册 —— **这是全仓库唯一一处列举业务模块的地方。**
//
// 要加一块新功能（比如「团队」），只做两件事：
//   1) 在 src/modules/ 下建一个文件夹，导出 name / apiPrefix / owns / reads / install(ctx)
//   2) 在下面这个数组里加一行 import 与一项
// 别的地方（src/server.js、src/core/*）一个字都不用改。
//
// scripts/check-skeleton.mjs 会检查「除了这个文件，没有第二处 import 业务模块」。
import { readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import core from './core/index.js';
import feed from './feed/index.js';
import doc from './doc/index.js';
import ai from './ai/index.js';
import team from './team/index.js';
import ui from './ui/index.js';

/** src/modules/ 的绝对路径（自检用）。 */
const DEFAULT_MODULES_DIR = dirname(fileURLToPath(import.meta.url));

/** 名册顺序 = 建表顺序 = 路由登记顺序。core 必须排第一（它的表是其它表的外键目标）。 */
export const MODULES = [core, feed, doc, ai, team, ui];

/**
 * 启动自检：src/modules/ 下的每个文件夹都必须在名册里。
 *
 * 「文件夹建好了、忘了在名册里加一行」是最容易犯又最难发现的错 —— 服务照常启动、
 * 测试照常通过，只有那一个模块的路由 404。所以启动时直接报错。
 * （反过来「名册里有一项、文件夹不存在」不用在这查：静态 import 会立刻
 *  ERR_MODULE_NOT_FOUND，deploy.sh 的健康检查会拦住。）
 *
 * @param {string} [modulesDir]
 * @returns {string[]} 实际存在的模块文件夹名
 */
export function assertModuleFolders(modulesDir = DEFAULT_MODULES_DIR) {
  const found = readdirSync(modulesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const registered = new Set(MODULES.map((module) => module.name));
  const missing = found.filter((name) => !registered.has(name));
  if (missing.length) {
    throw new Error(`src/modules/ 下有 ${missing.join('、')}，但没有登记进 src/modules/index.js 的 MODULES 名册`);
  }
  return found;
}

/**
 * 把名册里所有模块装上。
 *
 * 每个模块的 install(ctx) 里可以做三件事：登记自己的表、登记自己的路由、登记 afterReady 钩子。
 * 返回一份「装了什么」的清单，供启动日志与 /api/site 使用。
 *
 * 顺带守两条容易被绕过的契约（违反就直接报错，不给「静默半残」的机会）：
 *   1) 声明了 apiPrefix 的模块必须真的登记了属于该前缀的路由 —— 空壳模块在骨架期是正常的，
 *      所以这条只在模块自称 owns 非空（= 声称已经落地）时才生效；
 *   2) 不许两条路由的「方法 + 路径」完全相同 —— 后一条永远不会被匹配到，是纯静默故障。
 *
 * @param {ReturnType<import('../core/context.js').createContext>} ctx
 */
export function installModules(ctx) {
  assertModuleFolders();

  const before = ctx.routes.list().length;
  const installed = [];
  for (const module of MODULES) {
    if (typeof module.install === 'function') module.install(ctx);
    const mine = ctx.routes.list().slice(before);
    if (module.apiPrefix && (module.owns?.length ?? 0) > 0 && mine.length === 0) {
      throw new Error(`模块 ${module.name} 声明了接口前缀 ${module.apiPrefix} 却一条路由都没登记`);
    }
    installed.push({
      name: module.name,
      apiPrefix: module.apiPrefix,
      owns: module.owns,
      reads: module.reads ?? [],
    });
  }

  const seen = new Set();
  for (const entry of ctx.routes.list()) {
    const key = `${entry.method} ${entry.pattern}`;
    if (seen.has(key)) throw new Error(`路由重复登记：${key}`);
    seen.add(key);
  }

  return installed;
}

export { DEFAULT_MODULES_DIR };
