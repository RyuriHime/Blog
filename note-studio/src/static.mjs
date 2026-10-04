/**
 * static —— 编辑器静态资源的分发（框架无关）。
 *
 * 返回 `{ status, headers, body }`；`null` 表示「这个前缀不归我管」，交给宿主。
 * 挂载到论坛时，论坛的静态目录与它互不干扰。
 */
import { extname, join, resolve, sep } from 'node:path';
import { readFile as nodeReadFile } from 'node:fs/promises';

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

const notFound = () => ({
  status: 404,
  headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  body: Buffer.from('404 Not Found', 'utf8'),
});

/**
 * @param {{ root: string, prefix?: string, readFile?: Function }} options
 * @returns {(pathname: string) => Promise<{status:number,headers:object,body:Buffer}|null>}
 */
export function createStaticHandler({ root, prefix = '/notes', readFile = nodeReadFile } = {}) {
  if (!root) throw new Error('createStaticHandler 需要 root（编辑器静态目录）');
  const rootDir = resolve(root);

  return async function serve(pathname) {
    const clean = String(pathname ?? '');
    if (clean !== prefix && !clean.startsWith(`${prefix}/`)) return null;

    const raw = clean.slice(prefix.length).replace(/^\/+/, '') || 'index.html';

    let decoded;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      return notFound();
    }

    // 先做纯字符串判定，再拼接路径：绝不把可疑路径交给 readFile
    const segments = decoded.split(/[\\/]+/).filter((segment) => segment !== '');
    if (segments.some((segment) => segment === '..' || segment === '.')) return notFound();

    const target = join(rootDir, ...segments);
    if (target !== rootDir && !target.startsWith(rootDir + sep)) return notFound();

    let body;
    try {
      body = await readFile(target);
    } catch {
      return notFound();
    }

    return {
      status: 200,
      headers: {
        'Content-Type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': body.length,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      },
      body,
    };
  };
}
