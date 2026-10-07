// HTTP 请求处理：从 src/server.js 原样搬过来的 `http.createServer(...)` 函数体。
//
// 搬过来只改了三处（都是把「原来在同文件里裸用」的名字换成 import）：
//   resolveUser / ensure / readJsonBody / sendJson / serveAvatar / serveStatic / rateLimit 变成 import
//   末尾的挂载（forum-ai + note-agent + listen）留在 src/server.js，因为它属于启动编排
//
// 它做四件事，顺序不能变：
//   1) /api/*            → 走路由表（先匹配路径，再匹配方法 → 404/405）
//   2) 非 GET/HEAD       → 405 纯文本
//   3) /avatars/*        → 头像文件
//   4) /notes 与 /notes/*→ 笔记编辑器静态资源（必须在 serveStatic 之前拦住，见下）
//   5) 其余              → 论坛静态资源（public/，兜底成 index.html）
import http from 'node:http';
import { AVATAR_URL_PREFIX, UPLOAD_URL_PREFIX } from './paths.js';
import { HttpError, ensure, rateLimit, readJsonBody, sendJson } from './http.js';
import { serveAvatar, serveStatic, serveUpload } from './static.js';
import { resolveUser } from './sessions.js';

/**
 * 造 HTTP 服务器，并把外部路由（目前只有 note-studio 的笔记接口）登记进路由表。
 *
 * ⚠️ 登记顺序很重要：**笔记路由必须排在业务模块之前**。
 * 路由匹配是 `routes.filter(...)` 取第一个方法匹配的条目，
 * 而笔记路由里有 `/api/notes/:name` 这种带占位符的宽口径，
 * 排到后面就会被更早注册的静态路径抢走（note-studio 自己的表里
 * `/:name` 也是排在静态路径之后的，靠顺序保证优先级）。
 *
 * @param {object} options
 * @param {import('node:sqlite').DatabaseSync} options.db
 * @param {{ method: string, regex: RegExp, keys: string[], handler: Function }[]} options.routes
 * @param {{ routes: {method:string,pattern:string,handler:Function}[], serveStatic: Function }} options.notes
 */
export function buildServer({ db, routes, notes }) {
  // note-studio 的路由是「宿主逐条注册」的设计，我们在这里替它登记。
  // 与搬运前逐字一致：先按 `:名字` 切出 keys 与正则，再包一层写操作限流。
  for (const entry of notes.routes) {
    const { method, pattern, handler } = entry;
    routes.push({
      method,
      regex: new RegExp(`^${pattern.replace(/:([A-Za-z_]+)/g, '([^/]+)')}$`),
      keys: [...pattern.matchAll(/:([A-Za-z_]+)/g)].map((match) => match[1]),
      handler: async (ctx) => {
        // 写操作加一道粗粒度护栏（note-studio 内部还有它自己的限额）
        if (method !== 'GET') rateLimit(`notes:${ctx.user?.id ?? ctx.ip}`, 60, 60 * 1000);
        const result = await handler(ctx);
        return sendJson(ctx.res, result.status, result.body, result.headers ?? {});
      },
    });
  }

  return http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    res.on('finish', () => {
      if (process.env.QUIET !== '1') {
        console.log(`${req.method} ${pathname}${url.search} → ${res.statusCode} (${Date.now() - started}ms)`);
      }
    });

    try {
      if (pathname.startsWith('/api/')) {
        const { user, sessionToken } = resolveUser(req);
        const matched = routes.filter((entry) => entry.regex.test(pathname));
        ensure(matched.length > 0, 404, 'not_found', '接口不存在');
        const entry = matched.find((candidate) => candidate.method === req.method);
        ensure(entry, 405, 'method_not_allowed', '请求方法不被支持');

        const match = entry.regex.exec(pathname);
        const params = Object.fromEntries(entry.keys.map((key, index) => [key, match[index + 1]]));
        // 请求体上限默认 512 KB；`entry.options.bodyLimit` 只有明确需要更大的路由才给
        // （目前只有团队文件上传，见 src/core/router.js 第 4 个形参的注释）。
        const bodyLimit = entry.options?.bodyLimit;
        const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJsonBody(req, bodyLimit) : {};
        await entry.handler({
          req,
          res,
          params,
          query: url.searchParams,
          body,
          user,
          sessionToken,
          ip: req.socket.remoteAddress || 'unknown',
        });
        return;
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Method Not Allowed');
      }
      if (pathname.startsWith(AVATAR_URL_PREFIX)) {
        return await serveAvatar(req, res, pathname);
      }
      // 正文图片：`![](/uploads/xx.png)`。和头像一样必须在 serveStatic 之前 ——
      // 它也不在 public/ 里，落到 SPA 兜底会回 index.html（图片变成一段 HTML）。
      if (pathname.startsWith(UPLOAD_URL_PREFIX)) {
        return await serveUpload(req, res, pathname);
      }
      // 笔记编辑器必须在 serveStatic 之前拦截：`/notes/` 没有扩展名，
      // 落到论坛的静态分发会被兜底成 SPA 的 index.html。
      if (pathname === '/notes' || pathname.startsWith('/notes/')) {
        const taken = await notes.serveStatic(req, res, pathname);
        if (taken !== false) return taken;
      }
      return await serveStatic(req, res, pathname);
    } catch (error) {
      const httpError =
        error instanceof HttpError ? error : new HttpError(500, 'internal_error', '服务器内部错误，请稍后再试');
      if (!(error instanceof HttpError)) {
        console.error('[error]', req.method, pathname, error);
      }
      if (!res.headersSent) {
        sendJson(res, httpError.status, {
          ok: false,
          error: { code: httpError.code, message: httpError.message },
        });
      } else {
        res.end();
      }
    }
  });
}
