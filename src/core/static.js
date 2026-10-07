// 搬运自 src/server.js 的固定行区间（预铺骨架，逐字未改），见 docs/tools/extract-server-modules.mjs。
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { ensure } from './http.js';
import { AVATAR_DIR, AVATAR_URL_PREFIX, PUBLIC_DIR, UPLOAD_DIR, UPLOAD_URL_PREFIX } from './paths.js';

/** 静态提供头像文件 */
async function serveAvatar(req, res, pathname) {
  const name = decodeURIComponent(pathname.slice(AVATAR_URL_PREFIX.length));
  ensure(/^[A-Za-z0-9._-]+$/.test(name) && !name.includes('..'), 400, 'bad_avatar_name', '头像地址不合法');
  const target = normalize(join(AVATAR_DIR, name));
  ensure(target.startsWith(normalize(AVATAR_DIR)), 400, 'bad_avatar_name', '头像地址不合法');

  try {
    const body = await readFile(target);
    res.writeHead(200, {
      'Content-Type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': body.length,
      // 文件名里带随机串、内容永不变，可以放心长缓存
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    return res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404 Not Found');
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.apng': 'image/apng',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
};

/** 正文图片允许的后缀（`serveUpload` 用；不是图片的一律 404，免得变成任意文件下载口）。 */
const UPLOAD_EXT = new Set([
  '.svg', '.png', '.jpg', '.jpeg', '.gif', '.apng', '.webp', '.avif', '.bmp', '.ico', '.mp4', '.webm',
]);

/**
 * 子路径每一段允许的字符。
 *
 * 比头像那条宽：这里要装的是**别人的图片树**，文件名里出现中文是常态
 * （OI-wiki 里就有一张 `SCOI2005-互不侵犯.png`），所以按 Unicode 字母 / 数字放行，
 * 但仍然只放「一个正常文件名」该有的字符 —— 空白、反斜杠、冒号这些一律拒绝。
 */
const UPLOAD_PART_RE = /^[\p{L}\p{N}._@%#()+&-]+$/u;

/**
 * 静态提供帖子正文里的图片：`/uploads/<任意子路径>`。
 *
 * 与头像的两处差别：
 *   1. **允许多级子目录**（导入一棵 wiki 的图片树时，全平铺在一个目录里没法看），
 *      所以按 `/` 逐段校验，而不是整串一条正则；
 *   2. 后缀白名单只放图片 / 视频 —— 这个目录是给用户传内容用的，
 *      不能让它顺手变成「穿到 data/ 里下一个任意文件」的下载口。
 */
async function serveUpload(req, res, pathname) {
  const raw = decodeURIComponent(pathname.slice(UPLOAD_URL_PREFIX.length));
  const parts = raw.split('/').filter((part) => part !== '');
  const safe =
    parts.length > 0 &&
    parts.every((part) => part !== '.' && part !== '..' && UPLOAD_PART_RE.test(part));
  const target = safe ? normalize(join(UPLOAD_DIR, ...parts)) : '';
  const inside =
    safe && (target === UPLOAD_DIR || target.startsWith(UPLOAD_DIR + (process.platform === 'win32' ? '\\' : '/')));
  const ext = safe ? extname(target).toLowerCase() : '';
  ensure(inside && UPLOAD_EXT.has(ext), 404, 'not_found', '没有这张图片');

  try {
    const body = await readFile(target);
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Content-Length': body.length,
      // 文件名是内容的一部分（导入时按原路径落盘），改了名字就换了地址，可以缓存一天。
      'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    return res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404 Not Found');
  }
}

async function serveStatic(req, res, pathname) {  let relative = decodeURIComponent(pathname).replace(/^\/+/, '');
  if (relative === '') relative = 'index.html';
  const target = normalize(join(PUBLIC_DIR, relative));
  const inside =
    target === PUBLIC_DIR || target.startsWith(PUBLIC_DIR + (process.platform === 'win32' ? '\\' : '/'));
  const candidates = inside && extname(target) ? [target] : [join(PUBLIC_DIR, 'index.html')];

  for (const candidate of candidates) {
    try {
      const body = await readFile(candidate);
      res.writeHead(200, {
        'Content-Type': MIME[extname(candidate).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': body.length,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',      });
      if (req.method === 'HEAD') return res.end();
      return res.end(body);
    } catch {
      /* 尝试下一个候选路径 */
    }
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404 Not Found');
}
export { serveAvatar, serveUpload, serveStatic, MIME };
