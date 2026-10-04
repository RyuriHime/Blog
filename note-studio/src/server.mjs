/**
 * server —— note-studio 的独立入口（零依赖，只用 node:http）。
 *
 * 它让本模块**可以脱离论坛单独跑起来**：`node src/server.mjs` 然后打开 /notes。
 * 挂在论坛里时不需要这个文件——论坛自己有 HTTP 服务与登录态，直接用 routes.mjs。
 *
 * 单机模式下没有账号体系，因此固定注入一个本地用户；接入论坛时由论坛注入真实用户。
 */
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createNoteStore } from './store.mjs';
import { createNoteHandlers, createNoteRouter, toResponse } from './routes.mjs';
import { createStaticHandler } from './static.mjs';
import { createAiBridge, loadForumChat } from './ai-bridge.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIR = join(HERE, '..', 'public');
export const DEFAULT_DATA_DIR = join(HERE, '..', 'data', 'notes');

/** 单机模式的固定用户。 */
export const LOCAL_USER = Object.freeze({ id: 'local', username: 'local', displayName: '本机用户', role: 'admin' });

const MAX_BODY_BYTES = 12 * 1024 * 1024;

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('请求体过大');
      error.status = 413;
      error.code = 'too_large';
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('请求体不是合法 JSON');
    error.status = 400;
    error.code = 'bad_request';
    throw error;
  }
}

function send(res, response) {
  if (!response) {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: false, error: { code: 'not_found', message: '接口不存在' } }));
  }
  res.writeHead(response.status, { 'Content-Type': 'application/json; charset=utf-8', ...(response.headers ?? {}) });
  res.end(JSON.stringify(response.body));
}

/**
 * 组装（但不监听）一个 note-studio HTTP 服务。
 *
 * @param {{ dir?: string, publicDir?: string, prefix?: string, ai?: object,
 *           currentUser?: Function, quiet?: boolean }} [options]
 */
export function createNoteServer({
  dir = DEFAULT_DATA_DIR,
  publicDir = PUBLIC_DIR,
  prefix = '/notes',
  ai = null,
  currentUser = () => LOCAL_USER,
  quiet = false,
} = {}) {
  const store = createNoteStore({ dir });
  const handlers = createNoteHandlers({ store, ai, currentUser });
  const route = createNoteRouter(handlers, { prefix: '/api/notes' });
  const serveStatic = createStaticHandler({ root: publicDir, prefix });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    try {
      if (pathname === '/') {
        res.writeHead(302, { Location: `${prefix}/` });
        return res.end();
      }

      if (pathname.startsWith('/api/notes')) {
        const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJsonBody(req) : {};
        const result = await route({ method: req.method, pathname, query: url.searchParams, body, req });
        return send(res, result);
      }

      const asset = await serveStatic(pathname);
      if (asset) {
        res.writeHead(asset.status, asset.headers);
        return req.method === 'HEAD' ? res.end() : res.end(asset.body);
      }

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    } catch (error) {
      const response = toResponse(error);
      res.writeHead(response.status, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(response.body));
    }
  });

  if (!quiet) {
    server.on('request', (req) => {
      if (process.env.QUIET !== '1') console.log(`${req.method} ${req.url}`);
    });
  }

  return { server, store, handlers, route, serveStatic };
}

/**
 * 启动服务并返回真实地址；port 传 0 时由系统分配。
 */
export async function startNoteServer({ port = 3001, host = '127.0.0.1', ...options } = {}) {
  const { server } = createNoteServer(options);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${address.port}`;
  return {
    server,
    url,
    port: address.port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** 用既有的 forum-ai 接口造一个 AI 桥；没配 AI_API_KEY 时返回未配置的桥。 */
export async function createServerAi(env = process.env) {
  try {
    const loaded = await loadForumChat({ env });
    return createAiBridge({ ...loaded, env });
  } catch {
    return createAiBridge({ env });
  }
}

/* 直接运行时：node src/server.mjs */
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const port = Number(process.env.PORT || 3001);
  const host = process.env.HOST || '127.0.0.1';
  const ai = await createServerAi();
  const { url, port: actual } = await startNoteServer({ port, host, ai, dir: process.env.NOTES_DIR || DEFAULT_DATA_DIR });
  console.log('');
  console.log('  📓 note-studio 已启动');
  console.log(`  → 编辑器: ${url}/notes/`);
  console.log(`  → 接口  : ${url}/api/notes/status`);
  console.log(`  → AI    : ${ai.configured ? '已接入（复用 forum-ai）' : '未配置（编辑器仍可离线使用）'}`);
  console.log('');
  void actual;
}
