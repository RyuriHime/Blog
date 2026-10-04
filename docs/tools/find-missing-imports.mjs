/**
 * 一次性排查脚本：找出「生成出来的 core 文件里用了、但既没定义也没 import 的顶层名字」。
 *
 * 做法：
 *   1. 从基线 .tmp/src/server.js 里抠出所有顶层声明名（const/let/function/class/import）。
 *   2. 对每个生成文件，先算「本文件定义的名字」+「本文件 import 的名字」。
 *   3. 在剩下的标识符里，凡是出现在基线顶层声明表里的，就是漏 import 的。
 *
 * 用法：node docs/tools/find-missing-imports.mjs
 * 排查完即可删除。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/* --- 1. 基线顶层声明表 ---------------------------------------------------- */
const baseline = read('.tmp/src/server.js');

const topLevel = new Set();
for (const match of baseline.matchAll(/^(?:export\s+)?(?:const|let|var|function|async function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
  topLevel.add(match[1]);
}
// import 进来的名字也算基线里「可用的名字」
for (const match of baseline.matchAll(/^import\s+([\s\S]*?)\s+from\s+'/gm)) {
  for (const piece of match[1].replace(/[{}]/g, ',').split(',')) {
    const name = piece.trim().split(/\s+as\s+/).pop().trim();
    if (/^[A-Za-z_$][\w$]*$/.test(name)) topLevel.add(name);
  }
}
// 全局内置（Node / JS）白名单：这些不算「漏 import」
for (const name of [
  'process', 'console', 'Buffer', 'URL', 'URLSearchParams', 'setTimeout', 'setInterval',
  'clearTimeout', 'clearInterval', 'setImmediate', 'structuredClone', 'fetch', 'TextEncoder',
  'TextDecoder', 'AbortController', 'performance', 'queueMicrotask', 'JSON', 'Math', 'Date',
  'Number', 'String', 'Boolean', 'Array', 'Object', 'Map', 'Set', 'WeakMap', 'Promise', 'RegExp',
  'Error', 'TypeError', 'RangeError', 'Symbol', 'BigInt', 'Intl', 'parseInt', 'parseFloat',
  'isNaN', 'isFinite', 'decodeURIComponent', 'encodeURIComponent', 'globalThis', 'Reflect',
  'Proxy', 'Infinity', 'NaN', 'undefined', 'null', 'true', 'false', 'this', 'require', 'module',
  'exports', '__dirname', '__filename', 'async', 'await', 'function', 'return', 'typeof', 'new',
  'delete', 'void', 'in', 'of', 'instanceof', 'class', 'const', 'let', 'var', 'if', 'else',
  'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'try', 'catch', 'finally',
  'throw', 'yield', 'import', 'export', 'from', 'as', 'default', 'extends', 'super', 'static',
  'get', 'set',
]) {
  topLevel.delete(name);
}

/* --- 2. 逐个文件比对 ------------------------------------------------------ */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = [
  ...walk(join(ROOT, 'src', 'core')),
  ...walk(join(ROOT, 'src', 'modules')),
];

let problems = 0;
for (const full of files) {
  const source = readFileSync(full, 'utf8');
  const label = relative(ROOT, full).replace(/\\/g, '/');

  // 本文件定义的名字（含 import 进来的、形参、局部变量、解构）
  const local = new Set();
  for (const match of source.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) local.add(match[1]);
  for (const match of source.matchAll(/(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) local.add(match[1]);
  for (const match of source.matchAll(/import\s+([\s\S]*?)\s+from\s+['"]/g)) {
    for (const piece of match[1].replace(/[{}*]/g, ',').split(',')) {
      const name = piece.trim().split(/\s+as\s+/).pop().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) local.add(name);
    }
  }
  // 形参与局部解构 / 属性简写太吵，只关心「基线里的顶层名」
  // e.g. function foo(a, b) / ({ x, y }) / const { x, y } = ...
  for (const match of source.matchAll(/function[^(]*\(([^)]*)\)/g)) {
    for (const piece of match[1].split(',')) {
      const name = piece.trim().replace(/^\.\.\./, '').split(/[=:]/)[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) local.add(name);
    }
  }
  for (const match of source.matchAll(/(?:const|let|var)\s*[{[]([\s\S]*?)[}\]]\s*=/g)) {
    for (const piece of match[1].split(',')) {
      const name = piece.trim().split(':').pop().trim().replace(/^\.\.\./, '');
      if (/^[A-Za-z_$][\w$]*$/.test(name)) local.add(name);
    }
  }
  // 箭头函数形参
  for (const match of source.matchAll(/\(([^()]*)\)\s*=>/g)) {
    for (const piece of match[1].split(',')) {
      const name = piece.trim().replace(/^\.\.\./, '').split(/[=:]/)[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) local.add(name);
    }
  }
  for (const match of source.matchAll(/(?:^|[\s(,{])([A-Za-z_$][\w$]*)\s*=>/g)) local.add(match[1]);
  // 对象方法简写 foo() {}
  for (const match of source.matchAll(/^\s{2,}([A-Za-z_$][\w$]*)\s*\(/gm)) local.add(match[1]);
  // for (const x of ...) / catch (e)
  for (const match of source.matchAll(/\(\s*([A-Za-z_$][\w$]*)\s*(?:of|in)\s/g)) local.add(match[1]);
  for (const match of source.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)/g)) local.add(match[1]);

  const used = new Set();
  for (const match of source.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)/g)) used.add(match[1]);

  const missing = [...used].filter((name) => topLevel.has(name) && !local.has(name));
  if (missing.length) {
    problems += 1;
    console.log(`${label} 缺少 import: ${missing.join(', ')}`);
  }
}

console.log(problems ? `\n共 ${problems} 个文件有漏 import` : '\n没有发现漏 import');
