// 搬运自 src/server.js 的固定行区间（预铺骨架，逐字未改），见 docs/tools/extract-server-modules.mjs。
const routes = [];

function route(method, pattern, handler) {
  const keys = [];
  const source = pattern.replace(/:([A-Za-z_]+)/g, (_match, key) => {
    keys.push(key);
    return '([^/]+)';
  });
  routes.push({ method, regex: new RegExp(`^${source}$`), keys, handler });
}
export { route, routes };
