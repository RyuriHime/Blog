// @hand-written 数据层句柄。
//
// 为什么要有这个文件：序列化层（shape.js）、权限门、各路由分支都需要拿到 store，
// 但 store 必须在「建表 → 迁移 → 播种」之后才能创建。
// 所以这里先放一个占位，由 src/server.js 在 openDatabase() 之后调用 bindStore()。
//
// 这是本次预铺骨架里唯一的「可变绑定」。它换来的是：
// src/server.js 不必再导出一大堆内部函数，五个业务模块的 ctx 也只有一个来源。

/** @type {ReturnType<typeof import('../store.js').createStore> | null} */
let bound = null;

/** 由 src/server.js 在建库之后调用。重复绑定会直接报错，避免悄悄换库。 */
export function bindStore(store) {
  if (bound) throw new Error('store 已经绑定过了，不能再绑');
  bound = store;
  return store;
}

/** 仅供测试断言用：当前有没有绑定。 */
export function hasStore() {
  return bound !== null;
}

/**
 * 取当前 store。
 *
 * 用 Proxy 而不是 `export let store` 的原因：ESM 的 import 绑定虽然也是活的，
 * 但这里的调用点写作 `store.xxx()`，Proxy 能在没绑定时报出一句人能看懂的错，
 * 而不是 `Cannot read properties of null`。
 */
export const store = new Proxy(
  {},
  {
    get(_target, property) {
      if (!bound) throw new Error('store 还没有绑定：请先调用 bindStore()');
      const value = bound[property];
      return typeof value === 'function' ? value.bind(bound) : value;
    },
    has(_target, property) {
      return bound ? property in bound : false;
    },
  },
);
