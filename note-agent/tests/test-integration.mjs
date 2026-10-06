/**
 * 任务 18：宿主胶水 6 处 + 端到端回归。
 *
 * 这个文件是唯一"从外面看宿主"的测试：它读宿主的源码确认 6 处胶水都只是**追加**，
 * 然后真起一次宿主服务，确认既有接口没被抢走、note-agent 的接口与面板脚本可用。
 */
import { createChecker, toLocalPath } from './helpers/check.mjs';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const { check, summary } = createChecker();
const ROOT = new URL('../../', import.meta.url);

/**
 * 宿主源码/样式的**全部**内容，而不是某一个文件。
 *
 * v2 骨架把 `src/server.js`、`public/app.js`、`public/style.css` 拆成了薄壳
 * （`style.css` 现在只有一串 `@import`），6 处胶水散到了各分片里。以前这里
 * 分别只读那一个文件，于是断言要么查不到（红）、要么对着空文件（永远真）。
 * 把整棵树拼起来，这些断言才回到它们本来的意思：**宿主里确实有这几行，
 * 且没有第二份**。
 */
function readTree(dir, ext) {
  const base = new URL(dir, ROOT);
  let names = [];
  try {
    names = readdirSync(base, { recursive: true }).map(String);
  } catch {
    return '';
  }
  return names
    .filter((name) => name.endsWith(ext))
    .sort()
    .map((name) => {
      try {
        return readFileSync(new URL(name.split('\\').join('/'), base), 'utf8');
      } catch {
        return '';
      }
    })
    .join('\n');
}

const server = readTree('src/', '.js');
const appJs = readTree('public/', '.js');
const html = readFileSync(new URL('public/index.html', ROOT), 'utf8');
const css = readTree('public/', '.css');

check('server.js 只多了 1 行 note-agent import', (server.match(/from '\.\.\/note-agent\/src\/mount\.mjs'/g) ?? []).length === 1);
check('server.js 挂载 note-agent 且排在 forum-ai 之后', server.indexOf('mountNoteAgent(') > server.indexOf('mountForumAi('));
check('/api/site 暴露 notes 状态', /notes:\s*noteAgentStatus\(\)/.test(server));
check('index.html 加载面板模块', html.includes('/notes-panel.js'));
check('app.js 用守卫方式挂面板（失败静默降级）', /if \(window\.NotesAgent\)/.test(appJs));
// 面板样式跟着面板走：宿主样式表里不该有第二份（`.notes-mount` 除外 —— 那是 host 自己的挂载点）
check('宿主 style.css 里没有第二份面板样式', ['.notes-drawer', '.notes-diff', '.notes-finding', '.notes-preview'].every((c) => !css.includes(c)));
check('面板样式由 note-agent 自己提供（/notes-panel.css）', css.length > 0 && !css.includes('--notes-fallback-panel'));
// 面板要长得跟接入方自己的界面一致，就不能依赖宿主给什么按钮/输入框样式：
// 论坛那条 `input[type="text"]` 的优先级（0,1,1）比面板的 `.notes-turn-input`（0,1,0）还高，
// 一度把面板输入框改成了 10px 内边距（面板要 9px）。收进宿主给的 `.notes-mount` 才有把握
// （锚在挂载点而不是 `.notes-panel`，因为折叠竖标签是根节点的兄弟，收不进 `.notes-panel`）。
check(
  '面板样式把规则收在 .notes-mount 下（宿主泛化选择器改不动它）',
  !css.includes('--notes-fallback-panel') && /\.notes-mount\s+\.notes-turn-input\s*\{/.test(readFileSync(new URL('../client/notes-panel.css', import.meta.url), 'utf8')),
);
// 竖标签是面板插进挂载点的第二个根节点、与抽屉并列，必须按子代选择器收 —— 收错成
// `.notes-mount > .notes-panel.notes-drawer-tab` 时它一条规则都用不上，是个裸按钮（真踩过）。
check(
  '折叠竖标签按挂载点的子代收（收错成 .notes-panel 前缀就一条都匹配不上）',
  (() => {
    const panelCss = readFileSync(new URL('../client/notes-panel.css', import.meta.url), 'utf8');
    return panelCss.includes('.notes-mount > .notes-drawer-tab') && !panelCss.includes('.notes-panel.notes-drawer-tab');
  })(),
);
check('面板相关类名没有遗漏到 check-ui-contract 之外', (() => {
  const tokens = new Set([...appJs.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)).filter((c) => c.startsWith('notes-')));
  return [...tokens].every((c) => c === 'notes-mount' || css.includes(`.${c}`));
})());
// 挂载点必须带 notes-mount 这个类：面板样式全部收在它下面，少了它面板就是一堆裸块。
// 接入方自己写了这个类最好；漏了也没关系 —— 面板 attach 时会自己补（见下方那条断言）。
check('宿主写作页给的挂载点带 notes-mount 类', appJs.includes('id="notesMount" class="notes-mount"'));
check(
  '面板对没带 notes-mount 的挂载点自己补类（接入方漏了也不会退化成裸块）',
  readFileSync(new URL('../client/notes-panel.mjs', import.meta.url), 'utf8').includes("mount.classList.add('notes-mount')"),
);

// 起真实宿主服务，跑一遍端到端
const dir = mkdtempSync(join(tmpdir(), 'notes-e2e-'));
const PORT = Number(process.env.NOTES_E2E_PORT || 3490);
// toLocalPath 而不是 .pathname：目录名里有中文/空格时 .pathname 留 %XX，node 找不到文件。
const child = spawn(process.execPath, [toLocalPath(new URL('src/server.js', ROOT))], {
  env: { ...process.env, PORT: String(PORT), DB_FILE: join(dir, 'e2e.db'), AVATAR_DIR: join(dir, 'avatars'), QUIET: '1', AI_API_KEY: 'test', AI_MODEL: 'test' },
  stdio: 'ignore',
});
let site = null;
for (let i = 0; i < 60 && !site; i += 1) { try { const r = await fetch(`http://127.0.0.1:${PORT}/api/site`); if (r.ok) site = (await r.json()).data; } catch { await new Promise((r) => setTimeout(r, 200)); } }
check('宿主站点仍能起来（既有行为未破）', Boolean(site) && site.ok !== false);
check('/api/site 里出现 notes 状态', Boolean(site?.notes) && site.notes.contractVersion === '1');
// note-agent 挂在哪个前缀下由接入方决定：本站的 /api/notes 已经被 note-studio 占了，
// 所以这里把它挂在 /api/note-agent（见 ADAPT-NOTE-STUDIO.md）。两个前缀都试一遍，
// 哪个能返回契约版本就算通过 —— 这样换成别的宿主也仍然成立。
let notesStatus = null;
for (const prefix of ['/api/note-agent', '/api/notes']) {
  const r = await fetch(`http://127.0.0.1:${PORT}${prefix}/status`);
  if (r.status !== 200) continue;
  if ((await r.json())?.data?.contractVersion !== '1') continue;
  notesStatus = r;
  break;
}
check('宿主上 note-agent 的 /status 可用（未登录也放行）', Boolean(notesStatus));
const panel = await fetch(`http://127.0.0.1:${PORT}/notes-panel.js`);
check('宿主上 /notes-panel.js 可用', panel.status === 200);
const panelCss = await fetch(`http://127.0.0.1:${PORT}/notes-panel.css`);
check('宿主上 /notes-panel.css 可用（面板样式跟着面板走）', panelCss.status === 200 && (await panelCss.text()).includes('.notes-drawer'));
// 真机踩过的坑：旧的宿主进程没有这条路由，样式 404 ⇒ 面板 DOM 全在、样式全丢，
// 看上去就像"UI 回退到旧版"。三条静态资源必须一起在，否则面板等于没样式。
const cssText = await (await fetch(`http://127.0.0.1:${PORT}/notes-panel.css`)).text();
check('面板样式里带上了抽屉定位（不是只剩一堆无样式块）', cssText.includes('position: fixed') && cssText.includes('420px'), `len=${cssText.length}`);
const renderer = await fetch(`http://127.0.0.1:${PORT}/notes-markdown.js`);
check('宿主上 /notes-markdown.js 可用（渲染兜底模块）', renderer.status === 200 && (await renderer.text()).includes('renderMarkdown'));
const forumAi = await fetch(`http://127.0.0.1:${PORT}/api/ai/status`);
check('forum-ai 未被 note-agent 抢走路由', forumAi.status === 200);
child.kill();

rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
summary();
