/**
 * 一次性校验：把 public/ 下的每个前端模块在 Node 里 import 一遍。
 *
 * 浏览器里 ESM 报错只是一行红字，不好排查；在 Node 里 import 会把
 * 「找不到的导出（又叫人肉链接错误）」「语法错」「模块顶层访问 document」一次性报出来。
 * 能过这一关，说明 import 头是对的，剩下的问题只可能在运行时（DOM/api）。
 *
 * 用法：node docs/tools/check-public-modules.mjs
 */
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/* 最小的 DOM/window 垫片：只够模块顶层求值用，不模拟任何行为。 */
const noop = () => {};
const fakeNode = new Proxy(
  {},
  {
    get: (_target, key) => {
      if (key === 'append' || key === 'appendChild' || key === 'remove' || key === 'addEventListener') return noop;
      if (key === 'classList') return { add: noop, remove: noop, toggle: noop, contains: () => false };
      if (key === 'dataset') return {};
      if (key === 'style') return {};
      if (key === 'children') return [];
      return '';
    },
    set: () => true,
  },
);
globalThis.document = {
  querySelector: () => fakeNode,
  querySelectorAll: () => [],
  createElement: () => fakeNode,
  getElementById: () => fakeNode,
  addEventListener: noop,
  documentElement: fakeNode,
  body: fakeNode,
};
globalThis.window = {
  addEventListener: noop,
  matchMedia: () => ({ matches: false, addEventListener: noop, addListener: noop }),
  location: { hash: '', href: 'http://localhost/' },
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  scrollTo: noop,
  NotesAgent: undefined,
};
globalThis.localStorage = globalThis.window.localStorage;
globalThis.location = globalThis.window.location;
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, data: {} }), headers: { getSetCookie: () => [] } });
globalThis.matchMedia = globalThis.window.matchMedia;
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.cancelAnimationFrame = noop;

const files = [];
for (const dir of ['core', 'views']) {
  const full = join(ROOT, 'public', dir);
  if (!existsSync(full)) continue;
  for (const name of readdirSync(full)) if (name.endsWith('.js')) files.push(join(full, name));
}
files.push(join(ROOT, 'public', 'app.js'));

let failed = 0;
for (const file of files) {
  const label = file.slice(ROOT.length + 1).split('\\').join('/');
  try {
    await import(pathToFileURL(file).href);
    console.log(`  ✅ ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`  ❌ ${label} — ${error.message}`);
  }
}
console.log(`\n共 ${files.length} 个模块，失败 ${failed} 个`);
process.exit(failed ? 1 : 0);
