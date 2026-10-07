#!/usr/bin/env node
// 把 OI-wiki 的源码（docs/ + mkdocs.yml）弄到本机来，给 scripts/seed-oiwiki.mjs 用。
//
// 为什么需要它：内容在数据库里，而**部署只替换 src/ public/ scripts/ 三个目录**
// （docs/skeleton.md §5），服务器上既没有仓库根、也没有 oi-wiki-src/，
// 所以在服务器上跑导入之前，得先把源码取下来。
//
// 取法：下 GitHub 现打的 tar.gz，在内存里 gunzip + 走一遍 tar，只挑出
// `OI-wiki-master/` 这一棵子树写到缓存目录 —— 于是整条链上**零依赖、零外部命令**
// （不用 unzip / tar / git），Windows 和 Linux 都一样。
//
// 用法：
//   node scripts/fetch-oiwiki.mjs                     # 取到默认缓存目录
//   node scripts/fetch-oiwiki.mjs --dir <目录>        # 换缓存目录
//   node scripts/fetch-oiwiki.mjs --force             # 已经取过也重取
//   node scripts/fetch-oiwiki.mjs --list              # 只列出压缩包里的路径（调试用）
//
// 单位换算：上游那份 docs/ 约 2800 个文件 / 45 MB，下载约 40 MB。
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..');

/** 仓库里 vendored 的那份源码（本地开发时就在这儿，不需要下载）。 */
export const VENDORED_SRC = join(ROOT, 'oi-wiki-src', 'OI-wiki-master');

/** 压缩包里那棵子树的名字：GitHub 打的包顶层是 `<仓库>-<分支>/`，里面是 `OI-wiki-master/`。 */
export const SOURCE_DIR_NAME = 'OI-wiki-master';

/**
 * 按顺序试的下载地址。第一个是本仓库自己的快照 —— 与 oi-wiki-src/ 逐字一致，
 * 页数/块数与开发时验过的那份对得上；仓库不是公开的话再退回上游 master。
 */
export const SOURCE_URLS = [
  'https://codeload.github.com/RyuriHime/Blog/tar.gz/refs/heads/main',
  'https://github.com/RyuriHime/Blog/archive/refs/heads/main.tar.gz',
  'https://codeload.github.com/OI-wiki/OI-wiki/tar.gz/refs/heads/master',
  'https://github.com/OI-wiki/OI-wiki/archive/refs/heads/master.tar.gz',
];

/** 默认缓存目录：放在数据库旁边，重启不丢，也不进仓库。 */
export function defaultCacheDir(dbFile) {
  return join(dirname(dbFile || join(ROOT, 'data', 'forum.db')), 'oi-wiki-src-cache');
}

function readCString(buffer, start, length) {
  const slice = buffer.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8');
}

/** pax 扩展头（GitHub 打的包里长路径都走这里）：一堆 `长度 键=值\n`。 */
function parsePax(buffer) {
  const out = {};
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number(buffer.subarray(offset, space).toString('utf8'));
    if (!Number.isFinite(length) || length <= 0) break;
    const record = buffer.subarray(space + 1, offset + length - 1).toString('utf8'); // 末尾是 \n
    const eq = record.indexOf('=');
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    offset += length;
  }
  return out;
}

/**
 * 走一遍 tar（不落盘），把每个普通文件交给 onFile(path, data)。
 * 只需要认识这几种：普通文件（'0' / '\0' / '7'）、目录（'5'）、pax 头（'x' / 'g'）。
 */
export function walkTar(buffer, onFile) {
  let offset = 0;
  let entryPax = null;
  let globalPax = null;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    let zero = true;
    for (let i = 0; i < 512; i += 1) {
      if (header[i] !== 0) { zero = false; break; }
    }
    if (zero) break; // 结尾是两块全零
    let name = readCString(header, 0, 100);
    const prefix = readCString(header, 345, 155);
    if (prefix) name = `${prefix}/${name}`;
    const rawSize = readCString(header, 124, 12).trim();
    const size = rawSize ? Number.parseInt(rawSize, 8) || 0 : 0;
    const type = String.fromCharCode(header[156] || 0x30);
    const start = offset + 512;
    const end = Math.min(start + size, buffer.length);
    if (type === 'x' || type === 'g') {
      const pax = parsePax(buffer.subarray(start, end));
      if (type === 'g') globalPax = { ...(globalPax ?? {}), ...pax };
      else entryPax = pax;
    } else if (type === '0' || type === '\0' || type === '7') {
      const path = entryPax?.path ?? globalPax?.path ?? name;
      onFile(path, buffer.subarray(start, end));
      entryPax = null;
    } else if (type === '5') {
      entryPax = null;
    }
    const next = start + Math.ceil(size / 512) * 512;
    if (next <= offset) break; // 光标不前进就收工（防呆，别死循环）
    offset = next;
  }
}

/** 从 tar.gz 里只挑出 `<SOURCE_DIR_NAME>/` 这棵子树，写到 targetDir 下（targetDir 里就是 OI-wiki-master/）。 */
export function extractSource(buffer, targetDir, { onProgress } = {}) {
  const gz = gunzipSync(buffer);
  const wanted = `${SOURCE_DIR_NAME}/`;
  const written = [];
  if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
  walkTar(gz, (path, data) => {
    const index = path.indexOf(`/${wanted}`);
    const rest = index >= 0
      ? path.slice(index + 1 + wanted.length)
      : (path.startsWith(wanted) ? path.slice(wanted.length) : '');
    if (!rest || rest.endsWith('/')) return;
    const dest = join(targetDir, ...rest.split('/'));
    if (!resolve(dest).startsWith(resolve(targetDir) + sep)) return; // 别被 ../ 带出去
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, data);
    written.push(rest);
    if (onProgress && written.length % 500 === 0) onProgress(written.length);
  });
  return written;
}

/** 按顺序试各个地址，成功一个就停。返回 `{ url, bytes, files }`。 */
export async function downloadSource({ urls = SOURCE_URLS, targetDir, log = console.log, timeoutMs = 15 * 60 * 1000 } = {}) {
  const errors = [];
  for (const url of urls) {
    const started = Date.now();
    try {
      log(`下载 ${url}`);
      const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      log(`  收到 ${(buffer.length / 1048576).toFixed(1)} MB（${((Date.now() - started) / 1000).toFixed(1)}s），解包里…`);
      const files = extractSource(buffer, targetDir, { onProgress: (n) => log(`  已写出 ${n} 个文件`) });
      if (!files.length) throw new Error('压缩包里没找到 OI-wiki-master/');
      const docs = files.filter((path) => path.startsWith('docs/')).length;
      log(`  解出 ${files.length} 个文件（其中 docs/ 下 ${docs} 个）→ ${targetDir}`);
      return { url, bytes: buffer.length, files: files.length };
    } catch (error) {
      errors.push(`${url} → ${error.message}`);
      log(`  失败：${error.message}`);
    }
  }
  throw new Error(`四个地址都没取到源码：\n  ${errors.join('\n  ')}`);
}

function option(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? '');
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

async function main() {
  const targetDir = resolve(option('dir', defaultCacheDir(process.env.DB_FILE)) , SOURCE_DIR_NAME);
  const docsDir = join(targetDir, 'docs');
  if (flag('list')) {
    const response = await fetch(SOURCE_URLS[0], { redirect: 'follow', signal: AbortSignal.timeout(15 * 60 * 1000) });
    const buffer = Buffer.from(await response.arrayBuffer());
    const gz = gunzipSync(buffer);
    let count = 0;
    walkTar(gz, (path) => {
      if (count < 12) console.log(path);
      count += 1;
    });
    console.log(`…共 ${count} 个文件`);
    return;
  }
  if (existsSync(docsDir) && !flag('force')) {
    console.log(`已经取过了：${docsDir}（要重取加 --force）`);
    return;
  }
  console.log(`缓存目录: ${targetDir}`);
  const result = await downloadSource({ targetDir, log: (line) => console.log(line) });
  console.log(`完成：${result.files} 个文件，来自 ${result.url}`);
  console.log(`导入：node scripts/seed-oiwiki.mjs --src ${targetDir} --user <用户名>`);
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  await main();
}
