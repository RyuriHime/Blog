// 搬运自 src/server.js 的固定行区间（预铺骨架，逐字未改），见 docs/tools/extract-server-modules.mjs。
//
// 骨架里加了两处「只为自检服务」的东西，分发逻辑一行没动：
//   1) push 时多存一个 `pattern` 原串 —— 没有它就没法回答「这条路由属于哪个接口前缀」，
//      也没法查「两条路由是不是撞了」。
//   2) 支持「先取 add 再调用」的写法（`const add = routes.add; add('GET', path, handler)`）。
//      模块用解构拿到 add 之后 this 就丢了，所以 add 必须是普通函数而不是方法。
//      49 条既有路由都是 `route('GET', '/api/...', handler)` 形式，走的是同一条路。
const routes = [];

function route(method, pattern, handler) {
  const keys = [];
  const source = pattern.replace(/:([A-Za-z_]+)/g, (_match, key) => {
    keys.push(key);
    return '([^/]+)';
  });
  routes.push({ method, pattern, regex: new RegExp(`^${source}$`), keys, handler });
}
export { route, routes };
