/**
 * 笔记子系统端到端冒烟测试：起一个临时服务器（独立数据库 + 独立笔记目录），
 * 跑真实 HTTP 请求，重点验证论坛自己的四条规矩：
 *
 *   1) 笔记按人分目录 —— 别人看不到我的
 *   2) 默认私密       —— 不公开发布，广场里就没有
 *   3) 公开后可见     —— 公开了别人才能看，而且只能看
 *   4) 删不掉别人的   —— 删除请求只会命中自己的目录
 *
 * 用法：node scripts/notes-smoke.mjs
 */
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const SERVER = join(ROOT, 'src', 'server.js');
const DB_FILE = join(ROOT, 'data', 'notes-smoke.db');
const AVATAR_DIR = join(ROOT, 'data', 'notes-smoke-avatars');
const NOTES_DIR = join(ROOT, 'data', 'notes-smoke');
const LOG_FILE = join(ROOT, 'data', 'notes-smoke-server.log');
const PORT = Number(process.env.NOTES_SMOKE_PORT || 3417);
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  OK  ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  !!  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** 带 cookie 罐的极简 HTTP 客户端 */
function createClient() {
  let cookie = '';
  return {
    get cookie() {
      return cookie;
    },
    async call(path, { method = 'GET', body, raw = false } = {}) {
      const response = await fetch(BASE + path, {
        method,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      if (raw) return { status: response.status, text: await response.text(), headers: response.headers };
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      return { status: response.status, payload, data: payload?.data };
    },
  };
}

/* ------------------------------------------------------------------ */

for (const suffix of ['', '-wal', '-shm']) rmSync(DB_FILE + suffix, { force: true });
rmSync(AVATAR_DIR, { recursive: true, force: true });
rmSync(NOTES_DIR, { recursive: true, force: true });
mkdirSync(join(ROOT, 'data'), { recursive: true });

const logFd = openSync(LOG_FILE, 'w');
const child = spawn(process.execPath, [SERVER], {
  env: { ...process.env, PORT: String(PORT), DB_FILE, AVATAR_DIR, NOTES_DIR, QUIET: '1' },
  stdio: ['ignore', logFd, logFd],
});

/** 关掉服务并清理临时文件 */
async function shutdown(code) {
  child.kill();
  await sleep(150);
  rmSync(LOG_FILE, { force: true });
  for (const suffix of ['', '-wal', '-shm']) rmSync(DB_FILE + suffix, { force: true });
  rmSync(AVATAR_DIR, { recursive: true, force: true });
  rmSync(NOTES_DIR, { recursive: true, force: true });
  console.log('');
  console.log(`  通过 ${passed} 项，失败 ${failures.length} 项`);
  for (const item of failures) console.log(`    - ${item}`);
  process.exit(code);
}

// 等服务器起来
let up = false;
for (let i = 0; i < 60; i += 1) {
  try {
    const response = await fetch(`${BASE}/api/notes/status`);
    if (response.ok) {
      up = true;
      break;
    }
  } catch {
    /* 还没起来 */
  }
  await sleep(150);
}
if (!up) {
  console.log('服务器没起来，日志：');
  try {
    console.log(readFileSync(LOG_FILE, 'utf8').slice(-3000));
  } catch {
    /* ignore */
  }
  await shutdown(1);
}

console.log('');
console.log('笔记子系统冒烟测试');
console.log('');

/* -------------------- 准备两个用户 -------------------- */

const anon = createClient();
const alice = createClient();
const bob = createClient();

const aliceLogin = await alice.call('/api/auth/login', { method: 'POST', body: { username: 'alice', password: 'demo1234' } });
check('alice 登录成功', aliceLogin.status === 200, `status=${aliceLogin.status}`);
const bobLogin = await bob.call('/api/auth/login', { method: 'POST', body: { username: 'bob', password: 'demo1234' } });
check('bob 登录成功', bobLogin.status === 200, `status=${bobLogin.status}`);

/* -------------------- 1. 编辑器静态资源 -------------------- */

const anonEditor = await anon.call('/notes/', { raw: true });
check('未登录访问 /notes/ 被挡住（提示页）', anonEditor.status === 403 && anonEditor.text.includes('请先登录'), `status=${anonEditor.status}`);

const editor = await alice.call('/notes/', { raw: true });
check('登录后 /notes/ 200', editor.status === 200, `status=${editor.status}`);
check('/notes/ 返回的是编辑器本体', editor.text.includes('note-studio') || editor.text.includes('studio.js'));

const katex = await alice.call('/notes/vendor/katex/katex.min.js', { raw: true });
check('离线 KaTeX 能取到', katex.status === 200 && katex.text.length > 1000, `status=${katex.status} len=${katex.text.length}`);

const traversal = await alice.call('/notes/../src/server.js', { raw: true });
check('编辑器静态分发挡住目录穿越', traversal.status === 404 || !traversal.text.includes('mountForumAi'), `status=${traversal.status}`);

/* -------------------- 2. 未登录的接口 -------------------- */

const anonMine = await anon.call('/api/notes-mine');
check('未登录 /api/notes-mine → 401', anonMine.status === 401, `status=${anonMine.status}`);
const anonSquare = await anon.call('/api/notes-square');
check('未登录 /api/notes-square → 401', anonSquare.status === 401, `status=${anonSquare.status}`);
const anonList = await anon.call('/api/notes');
check('未登录 /api/notes → 401', anonList.status === 401, `status=${anonList.status}`);
const status = await anon.call('/api/notes/status');
check('/api/notes/status 公开可读', status.status === 200, `status=${status.status}`);

/* -------------------- 3. 保存笔记（按人分目录） -------------------- */

const aliceSave = await alice.call('/api/notes', {
  method: 'POST',
  body: { name: 'alice-热力学笔记', markdown: '# 热力学第一定律\n\n$\\Delta U = Q - W$\n\n这是 alice 的私密笔记。' },
});
check('alice 保存笔记成功', aliceSave.status === 200, `status=${aliceSave.status}`);

const bobSave = await bob.call('/api/notes', {
  method: 'POST',
  body: { name: 'bob-线代笔记', markdown: '# 线性代数\n\n矩阵乘法不满足交换律。' },
});
check('bob 保存笔记成功', bobSave.status === 200, `status=${bobSave.status}`);

const aliceList = await alice.call('/api/notes');
const aliceNames = JSON.stringify(aliceList.data?.items ?? aliceList.data ?? []);
check('alice 的列表里有自己的笔记', aliceNames.includes('alice-热力学笔记'), aliceNames.slice(0, 200));
check('alice 的列表里没有 bob 的笔记', !aliceNames.includes('bob-线代笔记'));

const bobList = await bob.call('/api/notes');
const bobNames = JSON.stringify(bobList.data?.items ?? bobList.data ?? []);
check('bob 的列表里有自己的笔记', bobNames.includes('bob-线代笔记'));
check('bob 的列表里没有 alice 的笔记', !bobNames.includes('alice-热力学笔记'));

// 落盘位置：data/notes/<用户id>/<名字>.md
const noteDirs = readdirSync(NOTES_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory());
check('笔记目录按用户分开（两个用户两个目录）', noteDirs.length === 2, `实际 ${noteDirs.length}：${noteDirs.map((d) => d.name).join(',')}`);

/* -------------------- 4. 默认私密 -------------------- */

const aliceMine = await alice.call('/api/notes-mine');
check('alice 能看到自己的笔记列表', aliceMine.status === 200 && aliceMine.data.count === 1, JSON.stringify(aliceMine.data));
check('alice 的笔记默认是私密', aliceMine.data.notes[0].public === false);

const bobSquare0 = await bob.call('/api/notes-square');
check('广场默认是空的（没人公开过）', bobSquare0.status === 200 && bobSquare0.data.count === 0, JSON.stringify(bobSquare0.data));

/* -------------------- 5. 公开之后 -------------------- */

const pub = await alice.call('/api/notes/alice-热力学笔记/publish', { method: 'POST' });
check('alice 公开自己的笔记成功', pub.status === 200 && pub.data.public === true, JSON.stringify(pub.data));

const aliceMine1 = await alice.call('/api/notes-mine');
check('公开标记回读正确', aliceMine1.data.notes[0].public === true);

const bobSquare1 = await bob.call('/api/notes-square');
check('bob 在广场里看到 alice 公开的笔记', bobSquare1.status === 200 && bobSquare1.data.count === 1, JSON.stringify(bobSquare1.data));
check(
  '广场条目带作者名（显示名，不是 id）',
  String(bobSquare1.data.notes[0]?.ownerName ?? '').toLowerCase() === 'alice',
  JSON.stringify(bobSquare1.data.notes[0]),
);
check('广场条目带摘要', Boolean(bobSquare1.data.notes[0]?.excerpt), JSON.stringify(bobSquare1.data.notes[0]?.excerpt));

const read = await bob.call(`/api/notes-square/${bobSquare1.data.notes[0].ownerId}/alice-热力学笔记`);
check('bob 能读 alice 公开的笔记正文', read.status === 200 && read.data.markdown.includes('热力学第一定律'), `status=${read.status}`);
check('正文附带服务端渲染的 HTML', typeof read.data.html === 'string' && read.data.html.includes('<h1'));
check('渲染结果里没有可执行脚本', !/<script/i.test(read.data.html ?? ''));

/* -------------------- 6. 不能删别人的 -------------------- */

const bobDeleteAlice = await bob.call('/api/notes/alice-热力学笔记', { method: 'DELETE' });
check('bob 删 alice 的笔记失败', bobDeleteAlice.status === 404, `status=${bobDeleteAlice.status}`);

const aliceStillThere = await alice.call('/api/notes-mine');
check('alice 的笔记还在（没被删掉）', aliceStillThere.data.count === 1, JSON.stringify(aliceStillThere.data));

const bobReadPrivate = await bob.call(`/api/notes-square/${bobSquare1.data.notes[0].ownerId}/bob-线代笔记`);
check('bob 读自己未公开的笔记（走广场接口）也是 404', bobReadPrivate.status === 404, `status=${bobReadPrivate.status}`);

/* -------------------- 7. 取消公开 = 隐藏 -------------------- */

const unsub = await alice.call('/api/notes/alice-热力学笔记/unpublish', { method: 'POST' });
check('alice 取消公开成功', unsub.status === 200 && unsub.data.public === false, JSON.stringify(unsub.data));

const bobSquare2 = await bob.call('/api/notes-square');
check('取消公开后广场里没有了', bobSquare2.data.count === 0, JSON.stringify(bobSquare2.data));

const bobReadAfter = await bob.call(`/api/notes-square/${bobSquare1.data.notes[0].ownerId}/alice-热力学笔记`);
check('取消公开后 bob 也读不到了', bobReadAfter.status === 404, `status=${bobReadAfter.status}`);

const aliceStillOwn = await alice.call('/api/notes-mine');
check('取消公开后 alice 自己还看得到', aliceStillOwn.data.count === 1 && aliceStillOwn.data.notes[0].public === false);

/* -------------------- 8. 孤儿公开标记 -------------------- */

await alice.call('/api/notes/alice-热力学笔记/publish', { method: 'POST' });
const aliceDir = noteDirs.map((entry) => entry.name).find((name) => {
  try {
    return readdirSync(join(NOTES_DIR, name)).some((file) => file.includes('alice-热力学笔记'));
  } catch {
    return false;
  }
});
rmSync(join(NOTES_DIR, aliceDir, 'alice-热力学笔记.md'), { force: true });
const bobSquare3 = await bob.call('/api/notes-square');
check('正文被删后广场不留幽灵条目（孤儿标记被跳过）', bobSquare3.data.count === 0, JSON.stringify(bobSquare3.data));
check('孤儿标记文件确实还在（测的是跳过而不是删除）', readdirSync(join(NOTES_DIR, aliceDir)).some((f) => f.endsWith('.share.json')));
writeFileSync(join(NOTES_DIR, aliceDir, 'alice-热力学笔记.md'), '# 热力学第一定律\n\n恢复的正文。\n', 'utf8');

/* -------------------- 9. 删除自己的 -------------------- */

const aliceDelete = await alice.call('/api/notes/alice-热力学笔记', { method: 'DELETE' });
check('alice 删自己的笔记成功', aliceDelete.status === 200, `status=${aliceDelete.status}`);
const aliceMine2 = await alice.call('/api/notes-mine');
check('删除后 alice 的列表为空', aliceMine2.data.count === 0, JSON.stringify(aliceMine2.data));

const bobDeleteOwn = await bob.call('/api/notes/bob-线代笔记', { method: 'DELETE' });
check('bob 删自己的笔记成功', bobDeleteOwn.status === 200, `status=${bobDeleteOwn.status}`);

/* -------------------- 10. 名字里有斜杠等特殊字符 -------------------- */

const weird = await alice.call('/api/notes', {
  method: 'POST',
  body: { name: '../../逃逸', markdown: '# 试试路径逃逸' },
});
check('奇怪的笔记名被消毒后保存成功', weird.status === 200, `status=${weird.status}`);
const escaped = readdirSync(NOTES_DIR, { withFileTypes: true }).some(
  (entry) => entry.isDirectory() && entry.name.startsWith('..'),
);
check('没有写出 data/notes 之外', !escaped);

/* -------------------- 收尾 -------------------- */

console.log('');
const serverLog = readFileSync(LOG_FILE, 'utf8');
check('服务端日志里没有异常堆栈', !serverLog.includes('[error]'), serverLog.slice(-500));

await shutdown(failures.length === 0 ? 0 : 1);
