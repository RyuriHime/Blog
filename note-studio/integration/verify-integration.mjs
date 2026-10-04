/**
 * 论坛 × note-studio 集成验证（真实 HTTP、真实落盘、真实登录态）。
 *
 * 直接 import 论坛的 server.js —— 它自己在模块顶层 listen，因此不需要 spawn 子进程
 * （沙箱下 spawn + 管道会 EPERM）。用临时 DB 与临时笔记目录，不碰仓库原有数据。
 */
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'forum-notes-'));
const DB_FILE = join(root, 'forum.db');
const NOTES_DIR = join(root, 'notes');
const PORT = 3012;

process.env.PORT = String(PORT);
process.env.HOST = '127.0.0.1';
process.env.DB_FILE = DB_FILE;
process.env.NOTES_DIR = NOTES_DIR;
process.env.QUIET = '1';

const FORUM = 'file:///D:/deepseek/work%20area/Work/.inspect/forum-ai-full/forum/src/server.js';
await import(FORUM);

const base = `http://127.0.0.1:${PORT}`;
const checks = [];

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function ready() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const response = await fetch(`${base}/api/site`);
      if (response.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await wait(150);
  }
  return false;
}

const check = (name, ok, extra = '') => checks.push({ name, ok, extra });
const text = (response) => response.text();

check('论坛起来了', await ready());

/* 1. 论坛首页带上了笔记入口 */
const home = await text(await fetch(`${base}/`));
check('首页出现「📓 笔记」入口', home.includes('/notes/') && home.includes('笔记'));

/* 2. 编辑器页面由 note-studio 分发 */
const editor = await fetch(`${base}/notes/`);
const editorHtml = await text(editor);
check('编辑器页面 200', editor.status === 200);
check('编辑器页面含 note-studio 标记', editorHtml.includes('note-studio'));
check('编辑器静态资源可访问', (await fetch(`${base}/notes/studio.js`)).status === 200);
check('KaTeX 资源可访问', (await fetch(`${base}/notes/vendor/katex/katex.min.js`)).status === 200);
check('编辑器路径穿越被挡', (await fetch(`${base}/notes/../../package.json`)).status === 404);

/* 3. 未登录：状态公开，写操作 401 */
const status = await (await fetch(`${base}/api/notes/status`)).json();
check('未登录也能读 /api/notes/status', status.ok === true && typeof status.data.version === 'string');
check('未登录读列表 401', (await fetch(`${base}/api/notes`)).status === 401);
check(
  '未登录保存 401',
  (await fetch(`${base}/api/notes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ markdown: 'x' }) })).status === 401,
);

/* 4. 登录后台论坛账号，走完整链路 */
const login = await fetch(`${base}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123' }),
});
const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
check('管理员登录成功', login.status === 200 && cookie.startsWith('forum_sid='));

const markdown = '# 集成笔记\n\n行内 $E=mc^2$，块级：\n\n$$\n\\oint \\vec{B}\\cdot d\\vec{l}\n$$\n';
const saved = await fetch(`${base}/api/notes`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: cookie },
  body: JSON.stringify({ name: '论坛集成 笔记', markdown }),
});
const savedPayload = await saved.json();
check('登录后可保存', saved.status === 200 && savedPayload.ok === true);
check('返回两个文件名', savedPayload.data?.files?.markdown === '论坛集成-笔记.md' && savedPayload.data?.files?.meta === '论坛集成-笔记.json');

/* 5. 磁盘上真的是一对文件 */
const files = (await readdir(NOTES_DIR)).sort();
check('磁盘上是 .md + .json', files.length === 2 && files.includes('论坛集成-笔记.md') && files.includes('论坛集成-笔记.json'), files.join(','));
const meta = JSON.parse(await readFile(join(NOTES_DIR, '论坛集成-笔记.json'), 'utf8'));
check('json 记录了基础数据', meta.schema === 'note-studio/document@1' && meta.file.sha256.length === 64 && meta.math.display === 1);
check('md 内容一致', (await readFile(join(NOTES_DIR, '论坛集成-笔记.md'), 'utf8')) === markdown);

/* 6. 列表与读取 */
const list = await (await fetch(`${base}/api/notes`, { headers: { Cookie: cookie } })).json();
check('列表里有这篇', list.ok === true && list.data.notes.some((note) => note.name === '论坛集成-笔记'));

const one = await (await fetch(`${base}/api/notes/${encodeURIComponent('论坛集成-笔记')}`, { headers: { Cookie: cookie } })).json();
check('读回正文', one.ok === true && one.data.markdown === markdown);

/* 7. AI 未配置时的降级语义（沿用 forum-ai 的 503） */
const convert = await fetch(`${base}/api/notes/convert`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: cookie },
  body: JSON.stringify({ dataUrl: 'data:image/png;base64,AAA' }),
});
check('未配 AI 时图片转写 503 ai_not_configured', convert.status === 503 && (await convert.json()).error.code === 'ai_not_configured');

/* 8. 删除 */
check('删除成功', (await fetch(`${base}/api/notes/${encodeURIComponent('论坛集成-笔记')}`, { method: 'DELETE', headers: { Cookie: cookie } })).status === 200);
check('删完目录为空', (await readdir(NOTES_DIR)).length === 0);

/* 汇总 */
let failed = 0;
for (const item of checks) {
  if (!item.ok) failed += 1;
  console.log(`${item.ok ? '✔' : '✘'} ${item.name}${item.extra ? `  (${item.extra})` : ''}`);
}
console.log('');
console.log(failed ? `FAIL：${failed} 项未通过` : `PASS：${checks.length} 项集成检查全部通过`);
process.exit(failed ? 1 : 0);
