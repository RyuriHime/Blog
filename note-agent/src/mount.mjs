/**
 * 挂载层：note-agent 的"胶水"全部集中在这里。
 *
 * 宿主（论坛的 `src/server.js`）只需要两行：
 *   import { mountNoteAgent } from '../note-agent/src/mount.mjs';
 *   mountNoteAgent({ db, resolveUser }).attach(server);
 *
 * 机制与 `forum-ai/src/mount.mjs` 完全一致：抓住宿主已有的 request listener，
 * 只在 `isNotesPath` 命中时短路，其余请求原样交回。
 *
 * 这一层刻意**自带**请求体读取（JSON 与 multipart 各一条路径），
 * 因为宿主 `readJsonBody` 只吃 JSON（512KB），喂不了 multipart 的原始字节。
 */
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNotesStore } from './store-sqlite.mjs';
import { DEFAULT_CHAR_BUDGET } from './material.mjs';
import { createHandlers, handle, CONTRACT_VERSION } from './routes.mjs';
import { readRawBody, parseMultipart, UPLOAD_RULES } from './multipart.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = join(HERE, '..', 'client');
const CLIENT_FILE = join(CLIENT_DIR, 'notes-panel.mjs');
const CLIENT_URL = '/notes-panel.js';
/**
 * 面板样式表也由这里发出去（面板在自己的 head 里认领它）。
 *
 * 为什么要这么做：面板样式原来只存在于宿主的 `public/style.css` 里，接入方要手粘三百行；
 * 这个包的目标是"整个文件夹拷给别人就能用"，粘 CSS 是最容易漏的一步 —— 漏了面板会以
 * 裸 DOM 的样子糊在写作页右侧。样式跟着面板走之后，宿主只需要 5 处胶水（不再有第 6 处）。
 *
 * 样式表里的颜色全部走宿主的 CSS 变量，取不到时退回面板自带的 `--notes-*` 兜底值，
 * 所以放到一个没有主题变量的站点上也只是"朴素的深色"，不会变成白底黑字的裸块。
 */
const STYLE_FILE = join(CLIENT_DIR, 'notes-panel.css');
const STYLE_URL = '/notes-panel.css';
// 渲染兜底：面板在宿主没有 /markdown/preview 时，动态 import 这个模块自己渲染。
// 发出去的是零依赖的 markdown-core.mjs（同一份实现在 Node 与浏览器里都跑），
// 只负责"探测宿主"的 markdown.mjs 是 Node 专用，不发给浏览器。所以不存在两份实现漂移。
const MARKDOWN_FILE = join(HERE, 'markdown-core.mjs');
const MARKDOWN_URL = '/notes-markdown.js';

/** `attach` 幂等：同一个 server 只允许装一次。 */
const attached = new WeakSet();

/** 最近一次 mountNoteAgent 的状态快照，供宿主的 /api/site 同步取用。 */
let lastStatus = null;

/** 读取 JSON 请求体（语义与 forum-ai/src/mount.mjs 保持一致，便于两边对照）。
 *
 * 与 forum-ai 的唯一差别：超限时**不** `req.destroy()`，而是停掉累积、
 * 把余下的字节读掉（`req.resume()`）再报 413。
 * 原因是 `destroy()` 会直接掐断 socket，客户端拿到的是 `UND_ERR_SOCKET`
 * 而不是我们精心写的 413 —— 客户端还在上传途中，响应根本发不出去。
 */
export function readJsonBody(req, { limit = 256 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(Object.assign(new Error('请求体过大'), { status: 413, code: 'payload_too_large' }));
        return;
      }
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { status: 400, code: 'invalid_json' }));
      }
    });
    req.on('aborted', () => reject(Object.assign(new Error('请求已中断'), { status: 400, code: 'request_aborted' })));
    req.on('error', (error) => reject(Object.assign(error, { status: error?.status ?? 400, code: error?.code ?? 'request_error' })));
  });
}

function sendJson(res, status, body) {
  if (res.headersSent || res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * 静态资源的内存缓存：`路径 → Buffer`。
 *
 * 注释以前就写着"首次访问读盘一次，之后命中内存缓存直接写"，但代码里其实每次请求
 * 都 `readFileSync` —— 面板挂载时这几个文件是**同步**读的，等于每次都在事件循环上
 * 堵一下。这里把承诺补上：内容不再变（发版才变），进程活着就一直用内存里这份。
 */
const assetCache = new Map();

function loadAsset(file) {
  if (assetCache.has(file)) return assetCache.get(file);
  let buffer;
  try {
    buffer = readFileSync(file);
  } catch {
    return null;
  }
  assetCache.set(file, buffer);
  return buffer;
}

/** 把一个静态文件吐给响应（带 nosniff 与最小 CSP：这三份资源都是我们自己的）。 */
function sendAsset(res, file, contentType, what) {
  const buffer = loadAsset(file);
  if (!buffer) {
    return sendJson(res, 404, { ok: false, error: { code: 'notes_not_found', message: `${what}不存在` } });
  }
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': buffer.length,
    // 这三份资源是我们自己发的 JS/CSS：不许浏览器猜类型、不许被嵌进别的页面。
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
    // no-store 而不是 no-cache：no-cache 要浏览器回源确认，而这里没发 ETag /
    // Last-Modified，浏览器只能拿着旧副本继续用 —— 改了样式刷新页面也看不到，
    // 表现成"面板没样式/旧样式"，排查起来极费劲（真踩过）。这几份资源都很小，
    // 每次重新拉一遍比猜缓存划算；读盘那部分已经由上面的内存缓存兜住。
    'Cache-Control': 'no-store',
  });
  res.end(buffer);
}

/** 请求体是不是 multipart。 */
function isMultipart(req) {
  return /\bmultipart\/form-data\b/i.test(String(req.headers['content-type'] ?? ''));
}

/**
 * 写请求是不是同源发起的（CSRF 基线防御）。
 *
 * 判定用 `Origin`（没有就看 `Referer`）的 **host** 与请求自身的 `Host` 是否一致 ——
 * 不比对 config 里猜的域名/端口，代理、改端口、局域网 IP 都不会误伤。
 * 浏览器对同源请求**不带** `Origin`，所以不带头的请求（非浏览器客户端、测试、
 * 宿主内部调用）一律放行；只要带了头且对不上就拒。
 */
function isSameOrigin(req) {
  const host = String(req.headers.host ?? '').toLowerCase();
  if (!host) return true; // 拿不到 Host 就没法判，交给鉴权层
  for (const header of ['origin', 'referer']) {
    const raw = req.headers[header];
    if (typeof raw !== 'string' || raw.length === 0) continue;
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      return false; // 带了头但根本不是合法 URL ⇒ 不认
    }
    return parsed.host.toLowerCase() === host;
  }
  return true;
}

/** multipart 里需要是数字的字段。 */
const NUMERIC_FIELDS = ['sessionId', 'postId'];
/** multipart 里需要是布尔的字段。 */
const BOOLEAN_FIELDS = ['append'];

/**
 * 把 multipart 表单字段归一到与 JSON 请求同样的类型。
 *
 * multipart 的每个字段都是字符串，而同一套处理器既要服务 `application/json`
 * （那里 `postId: 12345` 是数字）又要服务带材料的表单。不归一的话
 * `post_id` 会以 `'12345'` 落库，`WHERE post_id = 12345` 永远配不上 ——
 * 症状是"同一篇帖子每次都新建工作台、材料要重传"。
 */
function normalizeFields(fields) {
  const out = { ...fields };
  for (const key of NUMERIC_FIELDS) {
    if (out[key] === undefined) continue;
    const text = String(out[key]).trim();
    if (text === '') { delete out[key]; continue; }
    const value = Number(text);
    out[key] = Number.isFinite(value) ? value : out[key];
  }
  for (const key of BOOLEAN_FIELDS) {
    if (out[key] === undefined) continue;
    out[key] = !/^(?:false|0|no)$/i.test(String(out[key]).trim());
  }
  return out;
}

/**
 * @param {{ db: object, resolveUser: Function, basePath?: string,
 *   env?: object, chatImpl?: Function|null, fetchImpl?: Function, quiet?: boolean,
 *   tablePrefix?: string, materialChars?: number }} options
 */
export function mountNoteAgent({
  db,
  resolveUser,
  basePath = '/api/notes',
  env = process.env,
  chatImpl = null,
  fetchImpl = fetch,
  quiet = true,
  tablePrefix = 'notes_',
  materialChars,
} = {}) {
  if (!db) throw new TypeError('mountNoteAgent 需要 db');
  if (typeof resolveUser !== 'function') throw new TypeError('mountNoteAgent 需要 resolveUser(req)');

  // 环境变量兜底：运维改 .env 就能调预算，不必改宿主代码。
  // 显式传参优先 —— 宿主里写死的值不该被环境悄悄覆盖。
  // 判据是 `materialChars === undefined`（原来是拿 `=== 24000` 当哨兵，于是宿主显式
  // 传 24000 也会被 NOTES_MATERIAL_CHARS 顶掉，与文档承诺的"显式传参优先"相反）。
  const envBudget = Number(env.NOTES_MATERIAL_CHARS);
  const budget = materialChars === undefined
    ? (Number.isFinite(envBudget) && envBudget > 0 ? envBudget : DEFAULT_CHAR_BUDGET)
    : materialChars;

  const store = createNotesStore({ db, tablePrefix, materialChars: budget });
  store.ensureSchema();
  const handlers = createHandlers({ store, env, chatImpl, fetchImpl });
  const prefix = basePath.replace(/\/+$/, '');
  const statusPath = `${prefix}/status`;

  function isNotesPath(pathname) {
    return pathname === statusPath || pathname.startsWith(`${prefix}/`);
  }

  /**
   * 宿主 `/api/site` 取的那份状态。
   *
   * 直接复用路由层的 `statusSnapshot()`：两处各写一份形状，迟早会出现
   * "宿主说已配置、面板说未配置"这种自相矛盾的现场（HTTP 那边曾经把 `materialChars`
   * 写死成默认值、`limits` 少 `requirement`/`reviewDraft`）。`budget` 由同一处 store 定下，
   * 所以两边报的数字必然一致。
   */
  function status() {
    return handlers.statusSnapshot();
  }

  async function attach(server) {    if (typeof server?.listeners !== 'function') throw new Error('attach(server) 需要传入 node:http 的 server 实例');
    if (attached.has(server)) return { store, handlers, basePath: prefix };
    attached.add(server);

    const original = server.listeners('request').slice();
    server.removeAllListeners('request');

    server.on('request', async (req, res) => {
      let pathname = '/';
      try {
        pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
      } catch {
        /* 保持 '/' */
      }

      // 面板脚本与样式表是静态资源，与 basePath 无关，也不需要用户身份
      if (pathname === CLIENT_URL && (req.method === 'GET' || req.method === 'HEAD')) {
        return sendAsset(res, CLIENT_FILE, 'text/javascript; charset=utf-8', '面板脚本');
      }
      if (pathname === STYLE_URL && (req.method === 'GET' || req.method === 'HEAD')) {
        return sendAsset(res, STYLE_FILE, 'text/css; charset=utf-8', '面板样式');
      }
      if (pathname === MARKDOWN_URL && (req.method === 'GET' || req.method === 'HEAD')) {
        return sendAsset(res, MARKDOWN_FILE, 'text/javascript; charset=utf-8', '渲染兜底模块');
      }

      if (isNotesPath(pathname)) {
        try {
          const relative = pathname.slice(prefix.length) || '/';
          const query = new URLSearchParams(new URL(req.url, 'http://localhost').search);
          const { user } = (await resolveUser(req)) ?? { user: null };
          // 跨站写操作闸门：插件只靠宿主的会话 cookie 鉴权，而 multipart 表单
          // 是"无预检"的跨源可提交类型（`<form enctype="multipart/form-data">`）。
          // 现代浏览器默认的 SameSite=Lax 已经拦住了跨站 POST 的 cookie，但那是
          // 宿主配置的**副作用**，不是这里的防御：一旦有人把 cookie 改成
          // SameSite=None，任何页面都能替用户改写草稿。所以自己再判一次。
          //
          // 顺序有意为之：先鉴权再看来源 —— 未登录的跨站请求仍然回 401，
          // 不会把这个闸门暴露成"帮你探测哪些路径存在"的工具。
          if (user && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !isSameOrigin(req)) {
            return sendJson(res, 403, {
              ok: false,
              error: { code: 'notes_forbidden_origin', message: '请求来源与本站不一致，已拒绝' },
            });
          }

          let body = {};
          let files = null;
          if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
            if (isMultipart(req)) {
              const raw = await readRawBody(req, { limit: UPLOAD_RULES.maxSessionBytes });
              const parsed = parseMultipart(raw, req.headers['content-type']);
              body = normalizeFields(parsed.fields ?? {});
              files = parsed.files ?? [];
            } else {
              body = await readJsonBody(req);
            }
          }

          const result = await handle(handlers, {
            method: req.method,
            pathname: relative,
            query,
            body,
            files,
            user: user ?? null,
            ip: req.socket?.remoteAddress ?? 'unknown',
          });
          return sendJson(res, result.status ?? 200, result.body);
        } catch (error) {
          const status = Number(error?.status ?? 500);
          return sendJson(res, status, {
            ok: false,
            error: {
              code: error?.code ?? 'notes_internal_error',
              message: status === 500 ? '整理服务出错了，请稍后重试' : (error?.message ?? '请求失败'),
            },
          });
        }
      }

      // 不是 notes 路径：交回宿主原有的 listener（按注册顺序，谁先响应算谁的）
      for (const listener of original) {
        if (res.writableEnded) break;
        await listener.call(server, req, res);
      }
    });

    if (!quiet) {
      console.log(`  → AI 笔记整理已挂载: ${prefix}/*（面板脚本 ${CLIENT_URL}，样式 ${STYLE_URL}，渲染兜底 ${MARKDOWN_URL}，表前缀 ${tablePrefix}）`);
    }
    return { store, handlers, basePath: prefix };
  }

  lastStatus = status;

  return { store, handlers, isNotesPath, match: isNotesPath, status, attach, basePath: prefix, clientUrl: CLIENT_URL };
}

/**
 * 最近一次挂载的状态，给宿主的 `/api/site` 直接调用（同步、不查库）。
 * 与 `forum-ai` 的 `forumAiStatus()` 形状保持一致：宿主不需要自己拼装字段。
 * 还没挂载时返回"未配置"的保守值，绝不抛。
 */
export function noteAgentStatus() {
  if (lastStatus) return lastStatus();
  return {
    configured: false,
    model: '',
    contractVersion: CONTRACT_VERSION,
    materialChars: 0,
    limits: { maxFileBytes: 0, maxSessionBytes: 0, maxFiles: 0 },
    extensions: [],
  };
}

export { CLIENT_URL, STYLE_URL, MARKDOWN_URL };
