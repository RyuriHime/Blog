/**
 * 一次性排查脚本：为什么 smoke-ai 的「第二个客户端登录后请求 /api/ai/* 还是 401」。
 * 复刻 smoke-ai 的客户端与登录序列，打印 cookie 与 /api/ai/* 的状态。用完即删。
 */
import { spawn } from 'node:child_process';
import { openSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const DB_FILE = join(ROOT, 'data', 'probe-ai.db');
const LOG_FILE = join(ROOT, 'data', 'probe-ai-server.log');
const PORT = 3433;

for (const suffix of ['', '-wal', '-shm']) rmSync(DB_FILE + suffix, { force: true, recursive: true });
mkdirSync(dirname(DB_FILE), { recursive: true });

const logFd = openSync(LOG_FILE, 'w');
const child = spawn(process.execPath, [join(ROOT, 'src', 'server.js')], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DB_FILE, QUIET: '1', AI_API_KEY: '' },
  stdio: ['ignore', logFd, logFd],
});

const base = `http://127.0.0.1:${PORT}`;

async function waitReady() {
  for (let index = 0; index < 60; index += 1) {
    try {
      const response = await fetch(`${base}/api/site`);
      if (response.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

function createClient(label) {
  let cookie = '';
  return {
    label,
    get cookie() {
      return cookie;
    },
    async call(path, options = {}) {
      const headers = { ...(options.headers ?? {}) };
      if (cookie) headers.Cookie = cookie;
      if (options.body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetch(`${base}${path}`, {
        method: options.method ?? 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        redirect: 'manual',
      });
      const raw = await response.text();
      const setCookies = response.headers.getSetCookie();
      for (const value of setCookies) {
        const pair = value.split(';')[0];
        if (pair.startsWith('forum_sid=')) cookie = pair;
      }
      return { status: response.status, setCookies, cookie, body: raw.slice(0, 300) };
    },
  };
}

const up = await waitReady();
console.log('服务器起来了:', up);

const admin = createClient('admin');
const r1 = await admin.call('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
console.log('[1] 首次登录 status=', r1.status, 'setCookies=', JSON.stringify(r1.setCookies), 'cookie=', r1.cookie);
const me1 = await admin.call('/api/auth/me');
console.log('[2] /api/auth/me status=', me1.status, 'body=', me1.body);

const admin2 = createClient('admin2');
const r2 = await admin2.call('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
console.log('[3] 第二次登录 status=', r2.status, 'setCookies=', JSON.stringify(r2.setCookies), 'cookie=', r2.cookie);
const me2 = await admin2.call('/api/auth/me');
console.log('[4] /api/auth/me status=', me2.status, 'body=', me2.body);
const ai2 = await admin2.call('/api/ai/posts/2', { method: 'GET' });
console.log('[5] GET  /api/ai/posts/2 status=', ai2.status, 'body=', ai2.body);
const aiPost = await admin2.call('/api/ai/posts/2/analyze', { method: 'POST' });
console.log('[6] POST /api/ai/posts/2/analyze status=', aiPost.status, 'body=', aiPost.body);
const aiPostBody = await admin2.call('/api/ai/posts/2/analyze', { method: 'POST', body: { force: true } });
console.log('[7] POST (带 body) status=', aiPostBody.status, 'body=', aiPostBody.body);
const meAgain = await admin2.call('/api/auth/me');
console.log('[8] 之后 /api/auth/me status=', meAgain.status, 'body=', meAgain.body);
const me1Later = await admin.call('/api/auth/me');
console.log('[8b] 第一个客户端的 /api/auth/me status=', me1Later.status, 'body=', me1Later.body.slice(0, 120));
const aiAgain = await admin2.call('/api/ai/posts/2', { method: 'GET' });
console.log('[9] 之后 GET /api/ai/posts/2 status=', aiAgain.status, 'body=', aiAgain.body);

child.kill();
console.log('\n=== 服务器日志 ===');
const { readFileSync } = await import('node:fs');
console.log(readFileSync(LOG_FILE, 'utf8').split('\n').slice(-25).join('\n'));
