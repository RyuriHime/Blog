// 模块上下文（ctx）。
//
// 这是预铺骨架里最重要的一个文件：它决定了「五个业务模块能碰到什么」。
// 规则只有一条 —— **模块只能通过 ctx 拿东西，不许互相 import，也不许直接连数据库。**
//
// ctx 里出现的每一个成员，都是现在论坛本体已经在用的能力；
// 这一版没有为 v2 新增任何能力（那属于各模块自己的活），只是把已有能力摆到台面上。
import { HttpError, ensure, field, ok, rateLimit, readJsonBody, sendJson } from './http.js';
import { assertPostVisible, isOwner, isStaff, requireOwner, requireStaff, requireUser } from './guards.js';
import { DB_FILE, ROOT, SESSION_TTL_MS } from './paths.js';
import { routes } from './router.js';

/**
 * 造一个模块上下文。
 *
 * @param {object} options
 * @param {import('node:sqlite').DatabaseSync} options.db 已经建好表、跑完迁移的数据库句柄
 * @param {object} options.store 数据层（src/store.js 的 createStore 返回值）
 * @param {Function} options.route 路由登记器（src/core/router.js 的 route）
 * @param {{ add: Function, addScript: Function }} options.schemas 建表登记处
 * @param {{ afterReady: Function[] }} options.hooks 需要在服务起来之后跑的钩子
 */
export function createContext({ db, store, route, schemas, hooks }) {
  /**
   * 模块登记自己接口都往这里放，方便 /api/site 与骨架自检报出「现在装了哪些模块」。
   * @type {{ name: string, apiPrefix: string, owns: string[], reads: string[] }[]}
   */
  const modules = [];

  return {
    db,
    store,
    routes: {
      add: route,
      /** 已经登记的全部路由（含 method 与 pattern 原串），给契约自检用。 */
      list: () => routes.slice(),
    },
    schema: schemas,
    hooks,
    /** 模块登记自己之后，会出现在这个数组里。 */
    modules,
    http: {
      HttpError,
      ensure,
      field,
      ok,
      rateLimit,
      readJsonBody,
      sendJson,
    },
    guards: {
      assertPostVisible,
      isOwner,
      isStaff,
      requireOwner,
      requireStaff,
      requireUser,
    },
    options: {
      dbFile: DB_FILE,
      root: ROOT,
      sessionTtlMs: SESSION_TTL_MS,
    },
    log: (...args) => console.log(...args),
  };
}
