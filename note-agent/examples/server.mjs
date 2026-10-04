/**
 * 应用样例：一个**最小独立服务**，只有 note-agent 自己。
 *
 * 它不依赖论坛的任何代码 —— 目的有两个：
 *   1. 让人在没有论坛的情况下也能试用整理面板（`node examples/server.mjs`）；
 *   2. 证明 `mountNoteAgent()` 是自包含的：给它一个 db 与一个 resolveUser 就能跑。
 *
 * 数据库落在系统临时目录，重启即清空。真跑模型需要 AI_API_KEY：
 *   AI_API_KEY=sk-xxx node examples/server.mjs
 * 不配也能跑：面板会显示"未配置 AI 接口"，其余静态页面正常。
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { mountNoteAgent } from '../src/mount.mjs';
import { renderMarkdown, markdownSource } from '../src/markdown.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.NOTES_DEMO_PORT || 3480);
const HOST = process.env.NOTES_DEMO_HOST || '127.0.0.1';
const DB_FILE = process.env.NOTES_DEMO_DB || join(tmpdir(), `notes-demo-${process.pid}.db`);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

/** 只服务 examples/ 目录下的文件：没有任何"上传目录"或用户内容参与，所以不需要防穿越之外的花活。 */
function serveExample(pathname, res) {
  const relative = pathname === '/' ? 'standalone.html' : pathname.replace(/^\/+/, '');
  const file = normalize(join(HERE, relative));
  if (!file.startsWith(HERE)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('forbidden');
    return;
  }
  let body;
  try {
    body = readFileSync(file);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }
  const ext = file.slice(file.lastIndexOf('.'));
  res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream', 'Content-Length': body.length, 'Cache-Control': 'no-cache' });
  res.end(body);
}

const db = new DatabaseSync(DB_FILE);
const agent = mountNoteAgent({
  db,
  // 样例里所有人都是同一个演示用户：真接入时换成宿主的 resolveUser(req)
  resolveUser: () => ({ user: { id: 1, name: 'demo' } }),
  quiet: false,
});

/**
 * 站点的 Markdown 渲染接口。
 *
 * 面板的「效果」预览会打 `POST <hostBase>/markdown/preview`；真接入时那是宿主自己的渲染器
 * （与站内真实渲染 100% 一致）。这个演示服务原本没有它，于是演示页的「效果」按钮只能退化成原文 ——
 * 补上它，演示页才和真实站点一样。渲染器优先用宿主的 `src/markdown.js`，
 * 单独拷走时用包自带的 `src/markdown-core.mjs`（两者输出逐字一致，有测试盯着）。
 */
function handlePreview(req, res) {
  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > 512 * 1024) {
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    let content = '';
    try {
      content = String(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}').content ?? '');
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: { code: 'invalid_json', message: '请求体不是合法 JSON' } }));
      return;
    }
    const html = renderMarkdown(content.slice(0, 20000));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, data: { html } }));
  });
}

const server = createServer((req, res) => {
  const pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  if (pathname === '/api/markdown/preview' && req.method === 'POST') {
    handlePreview(req, res);
    return;
  }
  if (pathname === '/api/notes/status' || pathname.startsWith('/api/notes/')) {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: { code: 'notes_not_found', message: '接口不存在' } }));
    return;
  }
  serveExample(pathname, res);
});

// 挂载层要把自己的 listener 插在**前面**，所以必须在 listen() 之前调用
agent.attach(server);

server.listen(PORT, HOST, () => {
  console.log(`note-agent 样例已启动：http://${HOST}:${PORT}/`);
  console.log(`  AI：${process.env.AI_API_KEY ? `已配置（${process.env.AI_MODEL || 'deepseek-chat'}）` : '未配置（只演示界面）'}`);
  console.log(`  数据库：${DB_FILE}`);
  console.log(`  渲染：${markdownSource() === 'host' ? '宿主 src/markdown.js' : '包自带 markdown-core.mjs'}（供面板的「效果」预览用）`);
});
