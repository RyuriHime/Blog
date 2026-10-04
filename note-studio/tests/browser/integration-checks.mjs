/**
 * 论坛 × note-studio 集成检查（可复用）。
 *
 * 由两处共用：
 *   - tests/browser/verify-integration.mjs （AI 版论坛，命令行自检）
 *   - tests/browser/verify-root-forum.mjs  （根目录版论坛，无 forum-ai）
 *   - acceptance/run.mjs                   （把结果写进验收报告）
 *
 * 做法：直接 import 论坛的 server.js —— 它在模块顶层 listen，所以不需要 spawn 子进程
 * （受限沙箱下 spawn + 管道会 EPERM）。用临时 DB 与临时笔记目录，不碰仓库原有数据。
 *
 * 注意：调用方跑完后应当 process.exit()，因为论坛的监听句柄无法从外部关闭。
 */
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {{ forumEntry: string, noteStudioEntry?: string, port?: number,
 *           expectForumAi?: boolean }} options
 * @returns {Promise<{ checks: Array<{name:string, ok:boolean, extra?:string}>, noteMarkdown: string, meta: object }>}
 */
export async function runForumIntegrationChecks({
  forumEntry,
  noteStudioEntry,
  port = 3012,
  expectForumAi = true,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'forum-notes-'));
  const NOTES_DIR = join(root, 'notes');

  process.env.PORT = String(port);
  process.env.HOST = '127.0.0.1';
  process.env.DB_FILE = join(root, 'forum.db');
  process.env.NOTES_DIR = NOTES_DIR;
  process.env.QUIET = '1';
  if (noteStudioEntry) process.env.NOTE_STUDIO_PATH = pathToFileURL(noteStudioEntry).href;

  const checks = [];
  const check = (name, ok, extra = '') => checks.push({ name, ok, extra });
  const base = `http://127.0.0.1:${port}`;

  await import(pathToFileURL(forumEntry).href);

  let up = false;
  for (let i = 0; i < 40 && !up; i += 1) {
    try {
      up = (await fetch(`${base}/api/site`)).ok;
    } catch {
      await wait(150);
    }
  }
  check('论坛启动成功', up);
  if (!up) return { checks, noteMarkdown: '', meta: {} };

  const home = await (await fetch(`${base}/`)).text();
  check('首页出现「📓 笔记」入口（只加了一行导航）', home.includes('/notes/') && home.includes('笔记'));

  const editor = await fetch(`${base}/notes/`);
  const editorHtml = await editor.text();
  check('编辑器页面 200', editor.status === 200);
  check('编辑器页面确实是 note-studio', editorHtml.includes('note-studio'));
  check('编辑器 JS 可访问', (await fetch(`${base}/notes/studio.js`)).status === 200);
  check('渲染层 render.js 可访问', (await fetch(`${base}/notes/render.js`)).status === 200);
  check('KaTeX 资源可访问（离线内置）', (await fetch(`${base}/notes/vendor/katex/katex.min.js`)).status === 200);
  check('编辑器静态路径穿越被挡', (await fetch(`${base}/notes/../../package.json`)).status === 404);

  const status = await (await fetch(`${base}/api/notes/status`)).json();
  check('未登录也能读 /api/notes/status', status.ok === true && typeof status.data.version === 'string');
  check(
    expectForumAi ? 'status 报告 AI 已接线（缺 key 时仍为未配置）' : 'status 报告 AI 未配置（本布局没有 forum-ai）',
    status.data.ai.configured === false,
  );

  check('未登录读列表 → 401', (await fetch(`${base}/api/notes`)).status === 401);
  check(
    '未登录保存 → 401',
    (await fetch(`${base}/api/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: 'x' }),
    })).status === 401,
  );

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  check('沿用论坛登录态：管理员登录成功', login.status === 200 && cookie.startsWith('forum_sid='));

  const noteMarkdown = '# 集成笔记\n\n行内 $E=mc^2$，块级：\n\n$$\n\\oint \\vec{B}\\cdot d\\vec{l}\n$$\n';
  const saved = await fetch(`${base}/api/notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ name: '论坛集成 笔记', markdown: noteMarkdown }),
  });
  const savedPayload = await saved.json();
  check('登录后可保存', saved.status === 200 && savedPayload.ok === true);
  check(
    '返回 .md + .json 两个文件名',
    savedPayload.data?.files?.markdown === '论坛集成-笔记.md' && savedPayload.data?.files?.meta === '论坛集成-笔记.json',
  );

  const files = (await readdir(NOTES_DIR)).sort();
  check(
    '磁盘上确实是一对文件',
    files.length === 2 && files.includes('论坛集成-笔记.md') && files.includes('论坛集成-笔记.json'),
    files.join(' + '),
  );
  const meta = JSON.parse(await readFile(join(NOTES_DIR, '论坛集成-笔记.json'), 'utf8'));
  check('json 记录了基础数据（schema / sha256 / 公式计数）', meta.schema === 'note-studio/document@1' && meta.file.sha256.length === 64 && meta.math.display === 1);
  check('md 内容与提交的一致', (await readFile(join(NOTES_DIR, '论坛集成-笔记.md'), 'utf8')) === noteMarkdown);

  const list = await (await fetch(`${base}/api/notes`, { headers: { Cookie: cookie } })).json();
  check('列表里能查到', list.ok === true && list.data.notes.some((note) => note.name === '论坛集成-笔记'));

  const one = await (await fetch(`${base}/api/notes/${encodeURIComponent('论坛集成-笔记')}`, { headers: { Cookie: cookie } })).json();
  check('读回正文（中文文件名解码正确）', one.ok === true && one.data.markdown === noteMarkdown);

  const convert = await fetch(`${base}/api/notes/convert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ dataUrl: 'data:image/png;base64,AAA' }),
  });
  const convertBody = await convert.json();
  check(
    '没配 AI_KEY 时图片转写 → 503 ai_not_configured（不是 500）',
    convert.status === 503 && convertBody.error.code === 'ai_not_configured',
  );

  check('删除成功', (await fetch(`${base}/api/notes/${encodeURIComponent('论坛集成-笔记')}`, { method: 'DELETE', headers: { Cookie: cookie } })).status === 200);
  check('删完目录为空', (await readdir(NOTES_DIR)).length === 0);
  check('论坛既有页面未受影响（首页仍返回 200）', (await fetch(`${base}/`)).status === 200);

  return { checks, noteMarkdown, meta };
}
