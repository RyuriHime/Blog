// 搬运自 src/server.js 的固定行区间（预铺骨架，逐字未改），见 docs/tools/extract-server-modules.mjs。
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { ensure } from './http.js';
import { AVATAR_DIR, AVATAR_URL_PREFIX, PUBLIC_DIR } from './paths.js';

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
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

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
export { serveAvatar, serveStatic, MIME };
