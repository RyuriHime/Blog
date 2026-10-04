/**
 * 测试运行器：把全部 *.test.mjs 在**同一个进程**里加载。
 *
 * 为什么不用 `node --test tests/`：那个内置 runner 会为每个文件 spawn 子进程并用管道
 * 收集输出；在有沙箱限制的环境里会直接 EPERM。同进程加载同样会走 node:test 的断言与
 * 退出码语义，且零依赖。
 */
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const files = (await readdir(here)).filter((name) => name.endsWith('.test.mjs')).sort();

if (files.length === 0) {
  console.error('没有找到测试文件');
  process.exitCode = 1;
} else {
  for (const file of files) {
    await import(new URL(file, import.meta.url));
  }
}
