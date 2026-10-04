import { createChecker, toLocalPath } from './helpers/check.mjs';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const { check, summary } = createChecker();
const url = (p) => new URL(`../examples/${p}`, import.meta.url);
const html = readFileSync(url('standalone.html'), 'utf8');
const server = readFileSync(url('server.mjs'), 'utf8');
const material = readFileSync(url('sample-material.md'), 'utf8');

check('样例材料含公式与表格', material.includes('$$') && material.includes('| --- |'));
check('standalone.html 用一个独立适配器接入面板', /attach\(\{[\s\S]*editor[\s\S]*\}\)/.test(html) && html.includes('createTextareaAdapter'));
check('standalone.html 不 import 宿主代码', !html.includes('forum-ai') && !html.includes('/app.js'));
check('server.mjs 用 mountNoteAgent 挂载', server.includes('mountNoteAgent('));

const PORT = Number(process.env.NOTES_DEMO_PORT || 3480);
// toLocalPath 而不是 .pathname：目录名里有中文/空格时 .pathname 留 %XX，node 找不到文件。
const child = spawn(process.execPath, [toLocalPath(url('server.mjs'))], { env: { ...process.env, NOTES_DEMO_PORT: String(PORT), AI_API_KEY: 'test' }, stdio: 'ignore' });
let up = false;
for (let i = 0; i < 40 && !up; i += 1) {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/api/notes/status`); up = r.ok; } catch { await new Promise((r) => setTimeout(r, 200)); }
}
check('应用样例服务能起来并响应 /api/notes/status', up);
const page = await fetch(`http://127.0.0.1:${PORT}/`);
check('应用样例首页可打开', page.status === 200 && (await page.text()).includes('notes-mount'));
child.kill();

summary();
