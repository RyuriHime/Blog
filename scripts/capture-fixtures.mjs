/**
 * 给 check-frontend.mjs 采一份**真实接口响应**当假数据。
 *
 * 为什么要这么做：手写的假数据永远和真接口对不上（少一个 `week`、少一个 `followingCount`），
 * 于是「渲染失败」看起来像搬家切坏了代码，其实是假数据缺字段。
 * 让假数据从真服务器采回来，检查就只会在**真的改坏前端**时才红。
 *
 * 用法：node scripts/capture-fixtures.mjs
 * 产出：scripts/frontend-fixtures.json（{ 路径: 解包后的 data, __postId, __username, __peer }）
 *
 * 用的是**临时库 + 临时端口**，不碰 data/forum.db、不碰线上。
 * 本机没装 sqlite3、也不允许 spawn 管道时，这个脚本用 spawn + 文件重定向起服务器。
 * 采完会把临时库和日志删掉 —— 所以下一个人跑出来的帖子 id 可能和我这次不一样，
 * 这正是 `__postId` 要写进 fixtures 的原因。
 */
import { spawn } from 'node:child_process';
import { existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.FIXTURE_PORT || 3421);
const BASE = `http://127.0.0.1:${PORT}`;
const DB_FILE = join(ROOT, 'data', 'fixtures.db');
const LOG_FILE = join(ROOT, 'data', 'fixtures-server.log');
const OUT_FILE = join(ROOT, 'scripts', 'frontend-fixtures.json');

function clean(file) {
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(file + suffix, { force: true, recursive: true }); } catch { /* 不存在就算了 */ }
  }
}

async function waitForServer(timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${BASE}/api/site`);
      if (response.status === 200) return;
    } catch { /* 还没起来 */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`服务器 ${timeoutMs / 1000} 秒内没起来，看 ${LOG_FILE}`);
}

/** 极简 cookie 罐：只需要记住 forum_sid。 */
function createClient() {
  let cookie = '';
  return async function call(method, path, body) {
    const headers = { 'content-type': 'application/json' };
    if (cookie) headers.cookie = cookie;
    const response = await fetch(BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.getSetCookie?.() ?? [];
    for (const line of setCookie) {
      const pair = line.split(';')[0];
      if (pair.startsWith('forum_sid=')) cookie = pair;
    }
    let payload = null;
    try { payload = await response.json(); } catch { /* 非 JSON */ }
    return { status: response.status, payload };
  };
}

clean(DB_FILE);
const logFd = openSync(LOG_FILE, 'w');
const child = spawn(process.execPath, [join(ROOT, 'src', 'server.js')], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    DB_FILE,
    NOTES_DIR: join(ROOT, 'data', 'fixtures-notes'),
    AI_API_KEY: '',
    QUIET: '1',
  },
  stdio: ['ignore', logFd, logFd],
});

const fixtures = {};
const failures = [];

try {
  await waitForServer();
  const call = createClient();

  // 注册顺序有讲究：`/api/auth/register` 成功后会**签发新会话**并覆盖 cookie 罐，
  // 所以采样对象要**先**注册，之后再用 admin 登录，cookie 才是 admin 的。
  // （`/api/messages/:username` 是「我和 TA 的私信」，不能拿自己当对方 —— 服务端回 self_thread。）
  const pal = await call('POST', '/api/auth/register', {
    username: 'fixturepal',
    displayName: '采样对象',
    password: 'fixturepal123',
  });
  if (pal.status !== 200) failures.push(`注册采样对象失败：status=${pal.status} ${JSON.stringify(pal.payload)}`);

  // 登录成 admin，才有 /api/auth/me、/api/me/*、/api/admin/* 的真实形状。
  const login = await call('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  if (login.status !== 200) failures.push(`登录失败：status=${login.status} ${JSON.stringify(login.payload)}`);

  // 发一篇帖子，让 /api/posts/:id 有内容可采（同时验证写链路）。
  const created = await call('POST', '/api/posts', {
    boardId: 1,
    title: '假数据采样帖',
    content: '# 采样\n\n正文一段。\n\n- 列表项\n\n`code`',
  });
  const postId = created.payload?.data?.post?.id ?? created.payload?.data?.id ?? 1;
  if (created.status !== 200) failures.push(`发帖失败：status=${created.status} ${JSON.stringify(created.payload)}`);

  // 路径 → 要采集的请求。顺序无所谓，key 就是假 fetch 要匹配的路径。
  const targets = [
    ['GET', '/api/site'],
    ['GET', '/api/auth/me'],
    ['GET', '/api/posts?page=1&sort=new'],
    ['GET', `/api/posts/${postId}`],
    ['GET', '/api/posts?board=general'],
    ['GET', '/api/posts?q=采样'],
    ['GET', '/api/posts?bookmarked=1'],
    ['GET', '/api/posts?following=1'],
    ['GET', '/api/ranking'],
    ['GET', '/api/users/admin'],
    ['GET', '/api/me/categories'],
    ['GET', '/api/me/following'],
    ['GET', '/api/me/blocks'],
    ['GET', '/api/notifications'],
    ['GET', '/api/notifications/summary'],
    ['GET', '/api/checkin'],
    ['GET', '/api/messages'],
    ['GET', '/api/messages/fixturepal'],
    ['GET', '/api/knowledge/graph'],
    ['GET', '/api/knowledge/viewer'],
    ['GET', '/api/admin/overview'],
  ];

  for (const [method, path] of targets) {
    const result = await call(method, path);
    if (result.status !== 200) {
      failures.push(`${method} ${path} → ${result.status} ${JSON.stringify(result.payload)?.slice(0, 200)}`);
      continue;
    }
    // 信封是 { ok, data }：假 fetch 只需要 data。
    fixtures[path] = result.payload?.data ?? result.payload;
  }

  // 子库是**每次采样都重建**的，所以帖子 id 会变 —— 必须把当次的 id 一起存进 fixtures，
  // 否则「假 fetch 返回 /api/posts/9」会随着下次播种变成 404，页面渲染失败看起来像代码坏了。
  fixtures.__postId = postId;
  fixtures.__username = 'admin';
  fixtures.__peer = 'fixturepal';
  writeFileSync(OUT_FILE, `${JSON.stringify(fixtures, null, 2)}\n`, 'utf8');
  console.log(`✅ 采集 ${Object.keys(fixtures).filter((k) => !k.startsWith('__')).length} 条真实响应 → scripts/frontend-fixtures.json`);
  console.log(`   帖子 id = ${postId}（写进 fixtures.__postId，前端冒烟会用它）`);
  console.log('   路径清单：');
  for (const key of Object.keys(fixtures)) {
    if (key.startsWith('__')) continue;
    console.log(`     ${key}`);
  }
  if (failures.length) {
    console.log(`\n⚠️ ${failures.length} 条没采到：`);
    for (const line of failures) console.log(`   ${line}`);
  }
} catch (error) {
  console.error(`❌ ${error.message}`);
  if (existsSync(LOG_FILE)) {
    const log = readFileSync(LOG_FILE, 'utf8');
    const errors = log.split('\n').filter((line) => line.includes('[error]'));
    if (errors.length) console.error(errors.slice(0, 10).join('\n'));
  }
  process.exitCode = 1;
} finally {
  child.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 500));
  try { child.kill('SIGKILL'); } catch { /* 已经死了 */ }
  clean(DB_FILE);
  try { rmSync(LOG_FILE, { force: true, recursive: true }); } catch { /* 无所谓 */ }
  try { rmSync(join(ROOT, 'data', 'fixtures-notes'), { force: true, recursive: true }); } catch { /* 无所谓 */ }
}
