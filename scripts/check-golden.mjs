/**
 * 行为金标准（golden fingerprint）。
 *
 * 目的：在「大规模搬家」式的重构中，证明**网站对外的行为一个字节都没变**。
 * 做法：起一个临时服务器（独立端口 + 独立数据库），按固定顺序打一串真实 HTTP 请求，
 *       把每条请求的「方法 + 路径 + 状态码 + 响应 JSON 的键结构」压成一行指纹；
 *       然后和 scripts/golden.json 里改造前采到的指纹逐行比对。
 *
 * 只比「键结构 + 状态码」，**不比具体取值** —— id、时间戳、计数本来就会变。
 * 这样一来：逻辑改动、字段改名、字段增删、状态码变化、接口消失，全都会被抓到；
 * 而随机 id 和时间不会造成误报。
 *
 * 用法：
 *   node scripts/check-golden.mjs            # 比对（CI 与日常用这个）
 *   node scripts/check-golden.mjs --write    # 重新采一份指纹（只在「确认行为就该变」时用）
 *   node scripts/check-golden.mjs --dump     # 只打印当前指纹，不比对
 *
 * ⚠️ 只有在**故意的**行为变更之后才允许 --write。用 --write 去「修」一个红掉的比对，
 *    等于把这个测试废掉。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const SERVER = join(ROOT, 'src', 'server.js');
const GOLDEN = join(ROOT, 'scripts', 'golden.json');
const DB_FILE = join(ROOT, 'data', 'golden.db');
const AVATAR_DIR = join(ROOT, 'data', 'golden-avatars');
const LOG_FILE = join(ROOT, 'data', 'golden-server.log');
const PORT = Number(process.env.GOLDEN_PORT || 3419);
const BASE = `http://127.0.0.1:${PORT}`;

const MODE = process.argv.includes('--write')
  ? 'write'
  : process.argv.includes('--dump')
    ? 'dump'
    : 'compare';

/* ------------------------------------------------------------------ */
/* 指纹：把任意 JSON 压成「键结构」                                     */
/* ------------------------------------------------------------------ */

/**
 * 把 JSON 值压成稳定的结构描述：
 *   对象 → { 键名: 子结构 }（键排序）
 *   数组 → [ 元素结构的并集 ]（并用 `#n` 表示元素个数所在范围，不记具体值）
 *   其它 → 类型名
 * 目标：字段名、嵌套形状、字段增删都能被抓到；具体数值不会造成误报。
 */
function shapeOf(value, depth = 0) {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const inner = new Set(value.map((item) => shapeOf(item, depth + 1)));
    return `[${[...inner].sort().join(' | ')}]`;
  }
  const type = typeof value;
  if (type === 'object') {
    if (depth > 6) return '{…}';
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${key}:${shapeOf(value[key], depth + 1)}`).join(',')}}`;
  }
  return type;
}

/* ------------------------------------------------------------------ */
/* 极简客户端（与 smoke.mjs 同一套约定）                               */
/* ------------------------------------------------------------------ */

function createClient() {
  let cookie = '';
  return {
    get cookie() {
      return cookie;
    },
    async call(path, { method = 'GET', body } = {}) {
      const response = await fetch(BASE + path, {
        method,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'manual',
      });
      for (const value of response.headers.getSetCookie()) {
        const pair = value.split(';')[0];
        if (pair.startsWith('forum_sid=')) cookie = pair;
      }
      let json = null;
      try {
        json = await response.json();
      } catch {
        json = null;
      }
      return { status: response.status, body: json };
    },
  };
}

/* ------------------------------------------------------------------ */
/* 固定请求序列                                                        */
/* ------------------------------------------------------------------ */

const lines = [];
let step = 0;

/** 记录一次调用。label 用来说明这一步在验什么；path 里带 id 的用占位符。 */
async function record(label, client, path, options = {}) {
  step += 1;
  const { method = 'GET', body } = options;
  const result = await client.call(path, options);
  // 状态码 + 顶层信封结构 + data 的结构（error 的结构也一起记）
  const envelope = result.body === null ? 'no-json' : shapeOf(result.body);
  lines.push(
    `${String(step).padStart(3, '0')} ${method.padEnd(6)} ${label.padEnd(42)} ${String(result.status).padEnd(3)} ${envelope}`,
  );
  return result;
}

/* ------------------------------------------------------------------ */
/* 启动服务器                                                          */
/* ------------------------------------------------------------------ */

async function startServer() {
  mkdirSync(AVATAR_DIR, { recursive: true });
  const logFd = openSync(LOG_FILE, 'w');
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DB_FILE,
      AVATAR_DIR,
      NOTES_DIR: join(ROOT, 'data', 'golden-notes'),
      QUIET: '1',
      AI_API_KEY: '',
    },
    stdio: ['ignore', logFd, logFd],
  });

  for (let i = 0; i < 120; i += 1) {
    await sleep(100);
    try {
      const response = await fetch(`${BASE}/api/site`);
      if (response.status === 200) return child;
    } catch {
      /* 还没起来 */
    }
  }
  throw new Error(`服务器 12 秒内没起来，看 ${LOG_FILE}`);
}

/* ------------------------------------------------------------------ */

let server = null;

try {
  // 每次都用干净的库：指纹必须可重复
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${DB_FILE}${suffix}`, { force: true });
  }
  rmSync(join(ROOT, 'data', 'golden-notes'), { recursive: true, force: true });

  server = await startServer();

  const anon = createClient();
  const admin = createClient();
  const alice = createClient();
  const bob = createClient();
  const member = createClient();

  /* --- 站点与公开读 --- */
  await record('site', anon, '/api/site');
  await record('post-list-default', anon, '/api/posts');
  await record('post-list-paged', anon, '/api/posts?perPage=2&page=2');
  await record('post-list-sort-hot', anon, '/api/posts?sort=hot');
  await record('post-list-search', anon, '/api/posts?q=sqlite');
  await record('post-list-by-board', anon, '/api/posts?board=general');
  await record('post-detail', anon, '/api/posts/1');
  await record('post-detail-missing', anon, '/api/posts/99999');
  await record('user-profile', anon, '/api/users/alice');
  await record('user-profile-missing', anon, '/api/users/nobody_here_at_all');

  /* --- 认证 --- */
  await record('auth-me-anon', anon, '/api/auth/me');
  await record('login-admin-ok', admin, '/api/auth/login', {
    method: 'POST',
    body: { username: 'admin', password: 'admin123' },
  });
  await record('login-wrong-password', anon, '/api/auth/login', {
    method: 'POST',
    body: { username: 'admin', password: 'nope-nope' },
  });
  await record('login-alice', alice, '/api/auth/login', {
    method: 'POST',
    body: { username: 'alice', password: 'demo1234' },
  });
  await record('login-bob', bob, '/api/auth/login', {
    method: 'POST',
    body: { username: 'bob', password: 'demo1234' },
  });
  await record('register-new', member, '/api/auth/register', {
    method: 'POST',
    body: { username: 'golden_member', password: 'secret123' },
  });
  await record('register-duplicate', anon, '/api/auth/register', {
    method: 'POST',
    body: { username: 'golden_member', password: 'secret123' },
  });
  await record('register-bad-username', anon, '/api/auth/register', {
    method: 'POST',
    body: { username: 'ab', password: 'secret123' },
  });
  await record('auth-me-member', member, '/api/auth/me');
  await record('me-profile-update', member, '/api/me/profile', {
    method: 'POST',
    body: { displayName: '金标准', bio: '指纹测试用' },
  });
  await record('me-profile-too-long', member, '/api/me/profile', {
    method: 'POST',
    body: { bio: 'x'.repeat(101) },
  });
  await record('me-avatar-set', member, '/api/me/avatar', {
    method: 'POST',
    body: { avatar: '🦊' },
  });
  await record('me-avatar-bad', member, '/api/me/avatar', {
    method: 'POST',
    body: { avatar: 'not-an-emoji-at-all' },
  });
  await record('auth-password-wrong', member, '/api/auth/password', {
    method: 'POST',
    body: { currentPassword: 'wrong', newPassword: 'newsecret123' },
  });

  /* --- 发帖与编辑 --- */
  const created = await record('post-create', member, '/api/posts', {
    method: 'POST',
    body: { boardId: 1, title: '金标准测试帖', content: '# 标题\n\n正文 **加粗** 与 $x^2$ 公式' },
  });
  const newId = created.body?.data?.post?.id ?? 0;
  await record('post-create-validation', member, '/api/posts', {
    method: 'POST',
    body: { boardId: 1, title: 'x', content: 'yy' },
  });
  await record('post-create-anon', anon, '/api/posts', {
    method: 'POST',
    body: { boardId: 1, title: '未登录', content: 'x' },
  });
  await record('post-update', member, `/api/posts/${newId}`, {
    method: 'PUT',
    body: { boardId: 1, title: '金标准测试帖（改）', content: '改过了' },
  });
  await record('post-update-forbidden', bob, `/api/posts/${newId}`, {
    method: 'PUT',
    body: { boardId: 1, title: '越权改', content: 'x' },
  });
  await record('markdown-preview', member, '/api/markdown/preview', {
    method: 'POST',
    body: { content: '# 标题\n\n**加粗** `代码` $a+b$' },
  });

  /* --- 互动 --- */
  await record('post-reaction-like', alice, `/api/posts/${newId}/reaction`, {
    method: 'POST',
    body: { kind: 'like' },
  });
  await record('post-reaction-flip', alice, `/api/posts/${newId}/reaction`, {
    method: 'POST',
    body: { kind: 'dislike' },
  });
  await record('post-reaction-bad-kind', alice, `/api/posts/${newId}/reaction`, {
    method: 'POST',
    body: { kind: 'love' },
  });
  await record('post-reaction-self', member, `/api/posts/${newId}/reaction`, {
    method: 'POST',
    body: { kind: 'like' },
  });
  await record('post-bookmark', alice, `/api/posts/${newId}/bookmark`, { method: 'POST' });
  await record('post-repost-create', alice, `/api/posts/${newId}/repost`, {
    method: 'POST',
    body: { comment: '转发一下' },
  });
  await record('post-repost-delete', alice, `/api/posts/${newId}/repost`, { method: 'DELETE' });
  await record('post-reply-create', alice, `/api/posts/${newId}/replies`, {
    method: 'POST',
    body: { content: '第一条回复' },
  });
  await record('post-category-set', member, `/api/posts/${newId}/category`, {
    method: 'POST',
    body: { categoryId: null },
  });
  await record('post-profile-pin', member, `/api/posts/${newId}/profile-pin`, {
    method: 'POST',
    body: { pinned: true },
  });
  await record('post-profile-unpin', member, `/api/posts/${newId}/profile-pin`, {
    method: 'POST',
    body: { pinned: false },
  });
  await record('post-detail-after-actions', anon, `/api/posts/${newId}`);

  /* --- 回复删除 --- */
  const replyId = 1;
  await record('reply-delete-forbidden', bob, `/api/replies/${replyId}`, { method: 'DELETE' });
  await record('reply-delete', alice, `/api/replies/${replyId}`, { method: 'DELETE' });

  /* --- 关注 / 黑名单 / 私信 --- */
  await record('follow-alice-bob', alice, '/api/users/4/follow', { method: 'POST' });
  await record('follow-self', alice, '/api/users/3/follow', { method: 'POST' });
  await record('block-bob-carol', bob, '/api/users/5/block', { method: 'POST' });
  await record('me-blocks', bob, '/api/me/blocks');
  await record('messages-summary', alice, '/api/messages/summary');
  await record('messages-consent', alice, '/api/messages', { method: 'POST' });
  await record('messages-thread', alice, '/api/messages/bob');
  await record('messages-send', alice, '/api/messages/carol', {
    method: 'POST',
    body: { content: '你好' },
  });

  /* --- 分类 / 收藏 / 关注流（签到与排行榜已下线，这里不再记录） --- */
  await record('categories-list', member, '/api/me/categories');
  const cat = await record('categories-create', member, '/api/me/categories', {
    method: 'POST',
    body: { name: '金标准分类' },
  });
  const catId = cat.body?.data?.category?.id ?? 0;
  await record('categories-duplicate', member, '/api/me/categories', {
    method: 'POST',
    body: { name: '金标准分类' },
  });
  await record('categories-rename', member, `/api/me/categories/${catId}`, {
    method: 'PUT',
    body: { name: '金标准分类（改）' },
  });
  await record('categories-delete', member, `/api/me/categories/${catId}`, { method: 'DELETE' });
  await record('bookmarks-list', alice, '/api/posts?bookmarked=1');
  await record('following-list', alice, '/api/me/following');
  await record('following-feed', alice, '/api/posts?following=1');

  /* --- 通知 --- */
  await record('notifications-list', member, '/api/notifications');
  await record('notifications-unread', member, '/api/notifications?filter=unread');
  await record('notifications-summary', member, '/api/notifications/summary');
  await record('notifications-read-one', member, '/api/notifications/1/read', { method: 'POST' });
  await record('notifications-read-all', member, '/api/notifications/read-all', { method: 'POST' });
  await record('notifications-anon', anon, '/api/notifications');

  /* --- 知识网络图 --- */
  await record('knowledge-graph', anon, '/api/knowledge/graph');
  await record('knowledge-viewer', anon, '/api/knowledge/viewer');

  /* --- 管理 --- */
  await record('admin-overview-anon', anon, '/api/admin/overview');
  await record('admin-overview-member', member, '/api/admin/overview');
  await record('admin-overview-admin', admin, '/api/admin/overview');
  await record('admin-post-hide', admin, `/api/admin/posts/${newId}/hide`, {
    method: 'POST',
    body: { reason: '金标准测试' },
  });
  await record('admin-post-hide-hidden-from-anon', anon, `/api/posts/${newId}`);
  await record('admin-post-unhide', admin, `/api/admin/posts/${newId}/hide`, {
    method: 'POST',
    body: { reason: '', hidden: false },
  });
  await record('admin-role-change', admin, '/api/admin/users/6/role', {
    method: 'POST',
    body: { role: 'admin' },
  });
  await record('admin-role-change-unauthorized', member, '/api/admin/users/6/role', {
    method: 'POST',
    body: { role: 'member' },
  });
  await record('admin-ban', admin, '/api/admin/users/6/ban', {
    method: 'POST',
    body: { banned: true, reason: '金标准测试' },
  });
  await record('admin-unban', admin, '/api/admin/users/6/ban', {
    method: 'POST',
    body: { banned: false },
  });

  /* --- 删除与登出 --- */
  await record('post-delete-forbidden', bob, `/api/posts/${newId}`, { method: 'DELETE' });
  await record('post-delete', member, `/api/posts/${newId}`, { method: 'DELETE' });
  await record('logout', member, '/api/auth/logout', { method: 'POST' });

  /* --- 静态资源与页面 --- */
  await record('page-root', anon, '/');
  await record('page-app-js', anon, '/app.js');
  await record('page-style-css', anon, '/style.css');
  await record('page-settings-hash', anon, '/settings');
  await record('page-notes-portal', anon, '/notes/');
  const unknown = await anon.call('/api/definitely/not/a/route');
  lines.push(
    `${String(++step).padStart(3, '0')} GET    ${'unknown-api-route'.padEnd(42)} ${String(unknown.status).padEnd(3)} ${unknown.body === null ? 'no-json' : shapeOf(unknown.body)}`,
  );
  const methodNotAllowed = await anon.call('/api/site', { method: 'DELETE' });
  lines.push(
    `${String(++step).padStart(3, '0')} DELETE ${'method-not-allowed-on-api-site'.padEnd(42)} ${String(methodNotAllowed.status).padEnd(3)} ${methodNotAllowed.body === null ? 'no-json' : shapeOf(methodNotAllowed.body)}`,
  );
} finally {
  if (server) {
    server.kill();
    await sleep(300);
    try {
      server.kill('SIGKILL');
    } catch {
      /* 已经退出了 */
    }
  }
}

/* ------------------------------------------------------------------ */

const header = [
  '# 行为金标准指纹 —— 「接口 + 状态码 + 响应键结构」的快照。',
  '# 由 scripts/check-golden.mjs 生成与比对。不要手工编辑。',
  '# 只有确认某个行为变更是故意的，才用 `node scripts/check-golden.mjs --write` 重采。',
  `# 条目数：${lines.length}`,
];
const current = [...header, ...lines].join('\n') + '\n';

if (MODE === 'dump') {
  console.log(current);
  process.exit(0);
}

if (MODE === 'write') {
  writeFileSync(GOLDEN, current, 'utf8');
  console.log(`已写入指纹：${GOLDEN}`);
  console.log(`共 ${lines.length} 条。`);
  process.exit(0);
}

if (!existsSync(GOLDEN)) {
  console.error('❌ 还没有金标准指纹：scripts/golden.json 不存在。');
  console.error('   先在有已知良好行为的分支上运行： node scripts/check-golden.mjs --write');
  console.error('   （改造完成之后再补采指纹是不行的：那样它只能证明「改造后代码自洽」，');
  console.error('     无法证明「行为和改造前一样」。）');
  process.exit(1);
}

const expectedLines = readFileSync(GOLDEN, 'utf8')
  .split(/\r?\n/)
  .filter((line) => line && !line.startsWith('#'));

if (expectedLines.length !== lines.length) {
  console.error(`❌ 指纹条目数变了：改造前 ${expectedLines.length} 条，现在 ${lines.length} 条。`);
  console.error('   条目数变化意味着请求序列本身被改了 —— 请确认这是有意的，');
  console.error('   然后用 --write 重采，并在提交信息里说明原因。');
  process.exit(1);
}

const diffs = [];
for (let i = 0; i < lines.length; i += 1) {
  if (lines[i] !== expectedLines[i]) {
    diffs.push({ before: expectedLines[i], after: lines[i] });
  }
}

console.log('');
console.log('──────────────────────────────────────────────');
if (diffs.length === 0) {
  console.log(`通过 ${lines.length} 项，差异 0 项`);
  console.log('✅ 对外行为与改造前完全一致');
  process.exit(0);
}

console.log(`❌ 发现 ${diffs.length} 处行为差异：`);
for (const diff of diffs) {
  console.log('');
  console.log(`  改造前: ${diff.before}`);
  console.log(`  现在  : ${diff.after}`);
}
console.log('');
console.log('如果这是无意的 → 说明重构改坏了行为，请修回去。');
console.log('如果这是有意的 → 用 --write 重采，并在提交信息里说明。');
process.exit(1);
