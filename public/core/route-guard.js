// 页面代次（route generation）：给「上一页发出的、已经没人要的请求」发一张作废票。
//
// 为什么必须有：切页时旧页面发出的 GET 可能比新页面慢，等它回来时新页面早就画好了，
// 它的 then 会把整个 ui.app 覆盖回旧内容 —— 用户看到的是「点了链接，页面闪一下又跳回去」。
// 所以每个视图发出的请求都先记下「发起时的代次」，响应回来时对不上就直接把这份数据作废。
//
// 后台轮询（未读数、站点信息）不经过 route()，那时 routeInFlight 是 null，不受影响。
//
// 为什么单独一个文件：这个计数同时被 router.js（自增）和 api.js（比对）用到，
// 放在任何一边都会绕出循环 import。

let routeSeq = 0;
let routeInFlight = null;

/** 页面已被新路由取代时抛出的「作废」错误：各处 catch 看到 .aborted 就静默返回。 */
function routeAborted() {
  const error = new Error('页面已切换');
  error.aborted = true;
  return error;
}

/** route() 开头调用：开启新一代，之后发出的请求都算这一代。 */
function beginRoute() {
  routeSeq += 1;
  routeInFlight = routeSeq;
}

/** route() 结束调用（放 finally）：这之后发起的请求不再绑定任何页面。 */
function endRoute() {
  routeInFlight = null;
}

/** api() 用：这次请求发起时正在渲染的页面代次（不在视图里则为 null）。 */
function currentRouteSeq() {
  return routeInFlight;
}

/** api() 用：响应回来时对一下代次，页面早换了就作废这份数据。 */
function assertRouteCurrent(seq) {
  if (seq !== null && seq !== routeSeq) throw routeAborted();
}

// ── 导出 ──────────────────────────────────────────────────────────────
export { assertRouteCurrent };
export { beginRoute };
export { currentRouteSeq };
export { endRoute };
export { routeAborted };

/* @hand-written */
