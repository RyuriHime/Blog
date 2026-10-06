// 搬运自 src/server.js 的固定行区间（预铺骨架，逐字未改），见 docs/tools/extract-server-modules.mjs。
//
// 骨架里加了两处「只为自检服务」的东西，分发逻辑一行没动：
//   1) push 时多存一个 `pattern` 原串 —— 没有它就没法回答「这条路由属于哪个接口前缀」，
//      也没法查「两条路由是不是撞了」。
//   2) 支持「先取 add 再调用」的写法（`const add = routes.add; add('GET', path, handler)`）。
//      模块用解构拿到 add 之后 this 就丢了，所以 add 必须是普通函数而不是方法。
//      49 条既有路由都是 `route('GET', '/api/...', handler)` 形式，走的是同一条路。
// 分发逻辑一行没动；第三处（`options`）是「团队文件上传」那一轮加的，
// 见下面第 4 个形参的注释。
const routes = [];

/**
 * 登记一条路由。
 *
 * @param {'GET'|'POST'|'PUT'|'PATCH'|'DELETE'} method
 * @param {string} pattern `/api/teams/:id/files` 这样带 `:参数` 的路径
 * @param {Function} handler 收到 `{ req, res, params, query, body, user }`
 * @param {{ bodyLimit?: number } | null} [options]
 *   `bodyLimit`：**这条路由**的请求体上限，缺省沿用 `readJsonBody` 的 512 KB。
 *   为什么要逐路由给：团队文件柜要收 4 MB 的文件（base64 之后 5.33 MB），
 *   但其余所有接口都该维持 512 KB —— 抬全站上限等于让每一个接口都更容易被
 *   一条巨大的请求体打死。上限贴着需要它的那一条路由走。
 */
function route(method, pattern, handler, options = null) {
  const keys = [];
  const source = pattern.replace(/:([A-Za-z_]+)/g, (_match, key) => {
    keys.push(key);
    return '([^/]+)';
  });
  routes.push({ method, pattern, regex: new RegExp(`^${source}$`), keys, handler, options });
}
export { route, routes };
