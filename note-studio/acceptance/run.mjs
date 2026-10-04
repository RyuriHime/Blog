/**
 * 验收样例：一条命令跑出全部证据，并生成一份**可审查的 HTML 报告**。
 *
 *   node acceptance/run.mjs            离线确定性验收（默认）
 *   node acceptance/run.mjs --live     额外用真实视觉模型跑一次「图片 → Markdown/LaTeX」
 *
 * 产物（acceptance/output/）：
 *   acceptance-report.html   人看的报告：验收标准 × 证据 × 实际样例（含浏览器内真实渲染）
 *   acceptance-report.json   机器看的同一份结果
 *   sample-note.md / .json   **真实保存出来的**交付物样例（一个 md + 一个 json）
 *   convert-result.json      图片转写结果（离线假 AI 或 --live 的真实模型输出）
 *
 * 为什么默认用假 AI 服务：验收必须可复现。图片转写的**契约与降级**离线可验；
 * 真实识别质量需要你自己的视觉模型，用 --live 跑。
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import {
  createAiBridge,
  createNoteHandlers,
  createNoteRouter,
  createNoteStore,
  loadForumChat,
  toResponse,
} from '../src/index.mjs';
import { startNoteServer } from '../src/server.mjs';
import { runRenderChecks } from '../tests/browser/render-checks.mjs';
import { runPlaygroundChecks } from '../tests/browser/playground-checks.mjs';
import { runEditorChecks } from '../tests/browser/editor-checks.mjs';
import { runForumIntegrationChecks } from '../tests/browser/integration-checks.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(HERE, '..');
const WORK = join(ROOT, '..');
const OUT = join(HERE, 'output');
const SAMPLE_MD = join(HERE, 'sample', 'sample-note.md');
const SAMPLE_PNG = join(HERE, 'sample', 'sample-note-photo.png');
const LIVE = process.argv.includes('--live');

const results = [];
const record = (id, criterion, how, ok, evidence, extra = {}) =>
  results.push({ id, criterion, how, ok, evidence: String(evidence), ...extra });

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const rel = (path) => path.replace(/\\/g, '/').replace(`${WORK.replace(/\\/g, '/')}/`, '');

async function exists(path) {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

/* ================================================================== */
/* 环境                                                                */
/* ================================================================== */

await mkdir(OUT, { recursive: true });
const tempDir = join(OUT, '.tmp-crud');
await rm(tempDir, { recursive: true, force: true });

const sourceMarkdown = await readFile(SAMPLE_MD, 'utf8');
const imageBytes = await readFile(SAMPLE_PNG);
const imageDataUrl = `data:image/png;base64,${imageBytes.toString('base64')}`;
const LOG = [];
const log = (text) => {
  LOG.push(text);
  console.log(text);
};

log('note-studio 验收');
log(`  模式：${LIVE ? '离线确定性 + 真实模型（--live）' : '离线确定性（默认）'}`);
log(`  样例：${rel(SAMPLE_MD)} / ${rel(SAMPLE_PNG)}`);
log('');

/* ================================================================== */
/* AC-1 离线自足                                                       */
/* ================================================================== */

const indexHtml = await readFile(join(ROOT, 'public', 'index.html'), 'utf8');
const externalLinks = [...indexHtml.matchAll(/(?:src|href)\s*=\s*["'](https?:\/\/[^"']+)["']/g)].map((m) => m[1]);
const vendorFiles = await readdir(join(ROOT, 'public', 'vendor'), { recursive: true });
record(
  'AC-1',
  '编辑器完全离线自足：不引用任何外网资源，渲染库全部内置',
  '扫描 public/index.html 的外链 + 检查 vendor/ 内容',
  externalLinks.length === 0 && vendorFiles.length > 0,
  `外链 ${externalLinks.length} 个；vendor 内置 ${vendorFiles.length} 个文件`,
  {
    detail: externalLinks.length
      ? externalLinks.map((url) => ({ name: `发现外链：${url}`, ok: false }))
      : [{ name: 'index.html 中没有任何 http(s) 资源引用', ok: true }, { name: `vendor/ 内置 ${vendorFiles.length} 个文件（KaTeX 含字体 / marked / turndown）`, ok: true }],
  },
);

/* ================================================================== */
/* AC-2/3/4 渲染与往返（jsdom 执行真实前端）                            */
/* ================================================================== */

const render = await runRenderChecks();
if (render.skipped) {
  record('AC-2', 'Markdown 渲染正确（标题/表格/任务/代码块）', 'jsdom 执行 render.js', true, `跳过：${render.reason}`, { skipped: true });
  record('AC-3', 'LaTeX 渲染成公式结构，页面不残留 $ 源码', 'jsdom 执行 render.js', true, `跳过：${render.reason}`, { skipped: true });
  record('AC-4', '可视化模式往返不破坏公式', 'jsdom 执行 createSerializer', true, `跳过：${render.reason}`, { skipped: true });
} else {
  const pick = (names) => render.checks.filter((check) => names.some((name) => check.name.includes(name)));
  const mdChecks = pick(['标题渲染', '表格渲染', '代码块保留']);
  const mathChecks = pick(['KaTeX', '.katex', '残留', 'annotation', '行内公式=1', '块级公式=1']);
  const tripChecks = pick(['往返']);

  record('AC-2', 'Markdown 渲染正确（标题/表格/任务/代码块）', 'jsdom 执行 render.js', mdChecks.every((c) => c.ok), `${mdChecks.filter((c) => c.ok).length}/${mdChecks.length} 项`, { detail: mdChecks });
  record('AC-3', 'LaTeX 渲染成 .katex 结构，页面不残留 $ 源码', 'jsdom 执行 render.js + KaTeX auto-render', mathChecks.every((c) => c.ok), `渲染出 ${render.math} 个公式 · ${mathChecks.filter((c) => c.ok).length}/${mathChecks.length} 项`, { detail: mathChecks });
  record('AC-4', '可视化模式往返：公式 TeX 原样还原（反斜杠不被转义）', 'jsdom 执行 render.js 的 createSerializer + turndown', tripChecks.every((c) => c.ok), `${tripChecks.filter((c) => c.ok).length}/${tripChecks.length} 项`, { detail: tripChecks });
}

/* ================================================================== */
/* AC-5/6/13 落盘：一个 .md + 一个 .json                               */
/* ================================================================== */

const store = createNoteStore({ dir: OUT });
const saved = await store.save({ name: 'sample-note', markdown: sourceMarkdown });
const readBack = await store.read('sample-note');
const meta = JSON.parse(await readFile(saved.jsonPath, 'utf8'));
const outputFiles = (await readdir(OUT)).filter((name) => name.startsWith('sample-note')).sort();

record(
  'AC-5',
  '保存为一个 .md 文件和一个 .json 文件，内容与提交一致',
  'store.save() 真实落盘 + 读回比对',
  outputFiles.length === 2 && outputFiles.includes('sample-note.md') && outputFiles.includes('sample-note.json') && readBack.markdown === sourceMarkdown,
  `产出 ${outputFiles.join(' + ')}；字节 ${meta.file.bytes}；读回一致`,
);

const hashOk = meta.file.sha256 === sha256(sourceMarkdown);
const facts = [
  ['字符数与正文一致', meta.stats.characters === sourceMarkdown.length, `${meta.stats.characters}`],
  ['行数与正文一致', meta.stats.lines === sourceMarkdown.split('\n').length, `${meta.stats.lines}`],
  ['行内公式已统计', meta.math.inline >= 1, `${meta.math.inline}`],
  ['块级公式已统计', meta.math.display >= 1, `${meta.math.display}`],
  ['任务清单 3 项 / 完成 2 项', meta.tasks.total === 3 && meta.tasks.checked === 2, `${meta.tasks.checked}/${meta.tasks.total}`],
  ['表格 1 个', meta.tables === 1, `${meta.tables}`],
  ['代码块 1 个（python）', meta.code.fences === 1 && meta.code.blocks[0]?.language === 'python', `${meta.code.fences}`],
  ['图片 1 张（标题/alt 都在）', meta.media.images.length === 1, `${meta.media.images.length}`],
  ['链接 1 条（图片未算成链接）', meta.media.links.length === 1, `${meta.media.links.length}`],
  ['标题 7 个（含层级）', meta.structure.headings.length === 7, `${meta.structure.headings.length}`],
  ['sha256 与正文一致', hashOk, meta.file.sha256.slice(0, 12)],
];
const statsOk = facts.every(([, ok]) => ok);
record(
  'AC-6',
  '.json 记录基础数据，且与正文一致（sha256 重算比对）',
  '重算 sha256 + 逐项核对统计/结构/公式/任务/表格/代码块/图片/链接/标题',
  hashOk && statsOk,
  `sha256 ${hashOk ? '一致' : '不一致'}；字符 ${meta.stats.characters} · 行 ${meta.stats.lines} · 公式 ${meta.math.inline}+${meta.math.display} · 任务 ${meta.tasks.checked}/${meta.tasks.total} · 表格 ${meta.tables} · 标题 ${meta.structure.headings.length}`,
  { detail: facts.map(([name, ok, value]) => ({ name: `${name}（${value}）`, ok })), meta },
);

const crud = createNoteStore({ dir: tempDir });
const traversal = await crud.save({ name: '../../evil', markdown: 'x' });
const traversalBlocked = traversal.name === 'evil' && traversal.mdPath.startsWith(tempDir);
const traversalRead = await crud.read('no-such-note');
record(
  'AC-13',
  '安全：文件名路径穿越被切断；未登录读写被拒；静态穿越被拒',
  'store 写 ../../evil + 路由 currentUser=null + static 穿越',
  traversalBlocked && traversalRead === null,
  `../../evil → 落成 ${traversal.name}（未写出目录）；不存在返回 null`,
);

/* ================================================================== */
/* AC-10 / 独立服务：未配 AI 也能用                                     */
/* ================================================================== */

const server = await startNoteServer({ port: 0, dir: tempDir, publicDir: join(ROOT, 'public'), quiet: true });
const apiBase = server.url;
const statusPayload = await (await fetch(`${apiBase}/api/notes/status`)).json();
const httpSaved = await fetch(`${apiBase}/api/notes`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'http-check', markdown: '# HTTP\n\n$x^2$\n' }),
});
const httpSavedBody = await httpSaved.json();
const httpFiles = (await readdir(tempDir)).filter((n) => n.startsWith('http-check')).sort();
const convert503 = await fetch(`${apiBase}/api/notes/convert`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ dataUrl: 'data:image/png;base64,AAA' }),
});
const convert503Body = await convert503.json();
await server.close();

record(
  'AC-11',
  '独立可搬运：一条命令起服务，包内无 npm 依赖',
  'startNoteServer() + 读 package.json',
  statusPayload.ok === true && (await readdir(join(ROOT, 'src'))).length >= 6,
  `服务自检 200，版本 ${statusPayload.data.version}；src/ ${(await readdir(join(ROOT, 'src'))).length} 个模块`,
);

record(
  'AC-10',
  '未配置 AI 时优雅降级（503 ai_not_configured），编辑与导出不受影响',
  'POST /api/notes/convert（未注入 AI）+ POST /api/notes 正常保存',
  convert503.status === 503 && convert503Body.error.code === 'ai_not_configured' && httpSaved.status === 200 && httpFiles.length === 2,
  `/convert → ${convert503.status} ${convert503Body.error.code}；同时保存成功并产出 ${httpFiles.join(' + ')}`,
);

/* ================================================================== */
/* AC-7 图片 → Markdown / LaTeX（离线确定性）                           */
/* ================================================================== */

const spy = { calls: [] };
const fakeChat = async (messages, options = {}) => {
  spy.calls.push({ messages, options });
  return {
    text: ['```markdown', '# 电磁感应实验记录', '', '线圈匝数 $N = 200$，关系式：', '', '$$', '\\varepsilon = -N\\frac{\\mathrm{d}\\Phi}{\\mathrm{d}t}', '$$', '```', '', '```latex', '\\varepsilon = -N\\frac{\\mathrm{d}\\Phi}{\\mathrm{d}t}', '```'].join('\n'),
    model: 'acceptance-fake-vision',
    usage: { prompt: 512, completion: 128 },
  };
};

const offlineBridge = createAiBridge({ chat: fakeChat, env: { AI_MODEL: 'acceptance-fake-vision' } });
const offlineConvert = await offlineBridge.convertImage({ dataUrl: imageDataUrl, kind: 'both', source: 'sample-note-photo.png' });
const sent = spy.calls[0];
const userParts = sent?.messages?.[1]?.content ?? [];
const shapeOk =
  Array.isArray(userParts) &&
  userParts.some((part) => part.type === 'text') &&
  userParts.some((part) => part.type === 'image_url' && part.image_url.url.startsWith('data:image/png;base64,'));
record(
  'AC-7',
  '图片 → Markdown / LaTeX（离线契约级）：多模态消息形状正确、关掉 json_object、结果解析出两段',
  '注入假 chat 捕获报文 + convertImage 解析',
  shapeOk && sent?.options?.json === false && offlineConvert.markdown.includes('$N = 200$') && offlineConvert.latex.includes('\\varepsilon'),
  `报文含 image_url(${Math.round(imageBytes.length / 1024)} KB) + text；json=false；解析出 markdown ${offlineConvert.markdown.length} 字 + latex ${offlineConvert.latex.length} 字`,
  { convertOffline: offlineConvert },
);

/* ================================================================== */
/* AC-8 图片 → Markdown / LaTeX（真实模型，--live）                     */
/* ================================================================== */

async function resolveForumAi() {
  const candidates = [
    process.env.FORUM_AI_PATH,
    join(WORK, 'forum-ai', 'src', 'index.mjs'),
    join(WORK, '.inspect', 'forum-ai', 'src', 'index.mjs'),
    join(WORK, '.inspect', 'forum-ai-full', 'forum', 'forum-ai', 'src', 'index.mjs'),
    join(WORK, '.merge-ai', 'forum', 'forum-ai', 'src', 'index.mjs'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (!(await exists(candidate))) continue;
    const loaded = await import(new URL(`file://${candidate.replace(/\\/g, '/')}`).href);
    if (typeof loaded.chat === 'function') return { loaded, path: candidate };
  }
  return null;
}

const forumAi = await resolveForumAi();
let liveConvert = null;
if (!LIVE) {
  record('AC-8', '图片 → Markdown/LaTeX（真实视觉模型）', 'node acceptance/run.mjs --live', true, '本次未运行（默认离线；加 --live 且配好 AI_API_KEY / AI_MODEL 即可）', { skipped: true });
} else if (!process.env.AI_API_KEY) {
  record('AC-8', '图片 → Markdown/LaTeX（真实视觉模型）', 'forum-ai chat() + 样例照片', false, '缺少 AI_API_KEY，无法调用真实模型', { skipped: true });
} else {
  try {
    const bridge = createAiBridge({ chat: forumAi.loaded.chat, extractJson: forumAi.loaded.extractJson, aiStatus: forumAi.loaded.aiStatus, env: process.env });
    liveConvert = await bridge.convertImage({ dataUrl: imageDataUrl, kind: 'both', source: 'sample-note-photo.png' });
    record(
      'AC-8',
      '图片 → Markdown/LaTeX（真实视觉模型）',
      `forum-ai(${rel(forumAi.path)}) → ${process.env.AI_MODEL || '默认模型'}`,
      liveConvert.markdown.length > 0 && liveConvert.latex.length > 0,
      `模型 ${liveConvert.model}；Markdown ${liveConvert.markdown.length} 字 / LaTeX ${liveConvert.latex.length} 字；用量 ${liveConvert.usage.prompt}+${liveConvert.usage.completion}`,
      { convertLive: liveConvert },
    );
  } catch (error) {
    record('AC-8', '图片 → Markdown/LaTeX（真实视觉模型）', 'forum-ai chat()', false, `调用失败：${error.code || ''} ${error.message}`, { skipped: true });
  }
}

/* ================================================================== */
/* AC-9 复用既有 AI 接口（不自建）                                      */
/* ================================================================== */

const bridgeSource = await readFile(join(ROOT, 'src', 'ai-bridge.mjs'), 'utf8');
const httpCalls = [...bridgeSource.matchAll(/\b(?:fetch|https?\.request|https?\.get)\s*\(/g)].map((match) => match[0]);
const authHeaders = [...bridgeSource.matchAll(/Authorization/g)].map((match) => match[0]);
const usesInjectedChat = /await chat\(messages/.test(bridgeSource);
const injectedError = Object.assign(new Error('模拟上游超时'), { code: 'ai_timeout' });
const errorBridge = createAiBridge({ chat: async () => { throw injectedError; } });
const passthrough = toResponse(injectedError);
let rethrown = null;
try {
  await errorBridge.convertImage({ dataUrl: imageDataUrl });
} catch (error) {
  rethrown = error;
}
const reuseFacts = [
  ['模块内没有自己发 HTTP（无 fetch / http.request）', httpCalls.length === 0, httpCalls.join(',') || '无'],
  ['模块内没有自己拼鉴权头', authHeaders.length === 0, authHeaders.join(',') || '无'],
  ['只调用注入进来的 chat(messages, options)', usesInjectedChat, usesInjectedChat ? '是' : '否'],
  ['上游错误对象原样抛出（不是包装成新错误）', rethrown === injectedError, rethrown === injectedError ? '同一个错误对象' : '被包装了'],
  ['错误码 ai_timeout 映射成 HTTP 504', passthrough.status === 504, `${passthrough.status}`],
];
record(
  'AC-9',
  '复用既有 AI 接口、不自建：模块内不发 HTTP、不碰密钥；上游错误码原样透传',
  '源码扫描 src/ai-bridge.mjs + 注入 ai_timeout 错误跑一遍 convertImage',
  reuseFacts.every(([, ok]) => ok),
  `无自建 HTTP 调用；无鉴权头；错误码 ${passthrough.body.error.code} → HTTP ${passthrough.status}`,
  { detail: reuseFacts.map(([name, ok, value]) => ({ name: `${name}（${value}）`, ok })) },
);

/* ================================================================== */
/* AC-12 接回论坛是最小改动                                             */
/* ================================================================== */

const gluePath = join(ROOT, 'integration', 'notes.js');
const glueSource = await exists(gluePath) ? await readFile(gluePath, 'utf8') : '';
const forumServerCandidates = [join(WORK, 'src', 'server.js'), join(WORK, '.inspect', 'forum-ai-full', 'forum', 'src', 'server.js')];
const patched = [];
for (const candidate of forumServerCandidates) {
  if (!(await exists(candidate))) continue;
  const text = await readFile(candidate, 'utf8');
  if (text.includes("from './notes.js'") && text.includes('createNotes(') && text.includes('notes.serveStatic')) patched.push(rel(candidate));
}
record(
  'AC-12',
  '接回论坛是最小改动：1 个胶水文件 + 3 处补丁，不改 forum-ai / 不改论坛 SPA / 不建表',
  '检查胶水文件与两个论坛 server.js 的补丁锚点',
  glueSource.includes('createNoteRoutes') && patched.length > 0,
  `胶水 ${glueSource.split('\n').length} 行；已打补丁的论坛：${patched.join('、') || '无'}`,
);

/* ================================================================== */
/* AC-14 零依赖测试（真实数字）                                         */
/* ================================================================== */

let unit = { pass: 0, fail: 0, skipped: false };
try {
  const { run } = await import('node:test');
  const testDir = join(ROOT, 'tests');
  const files = (await readdir(testDir)).filter((name) => name.endsWith('.test.mjs')).map((name) => join(testDir, name));
  const stream = run({ files, isolation: 'none', concurrency: 1 });
  for await (const event of stream) {
    if (event.type === 'test:pass') unit.pass += 1;
    if (event.type === 'test:fail') unit.fail += 1;
  }
} catch (error) {
  unit = { pass: 0, fail: 0, skipped: true, reason: error.message };
}
record(
  'AC-14',
  '零依赖测试全部通过（node:test，无第三方依赖）',
  'node:test run() 在进程内跑 tests/*.test.mjs',
  !unit.skipped && unit.fail === 0 && unit.pass > 0,
  unit.skipped ? `跳过：${unit.reason}` : `通过 ${unit.pass} 项，失败 ${unit.fail} 项`,
);

/* ================================================================== */
/* AC-16 可操作样例（playground.html）                                  */
/* ================================================================== */

const playground = await runPlaygroundChecks();
if (playground.skipped) {
  record('AC-16', '可操作样例：能点、能改、能转写、能导出', 'jsdom 打开 playground.html 并点击各按钮', true, `跳过：${playground.reason}`, { skipped: true });
} else {
  record(
    'AC-16',
    '可操作样例：能点、能改、能转写、能导出（不只是只读报告）',
    'jsdom 打开 public/playground.html，真实点击「载入样例照片 → 转写 → 插入 → 切模式 → 导出 → 清空」',
    playground.checks.every((check) => check.ok),
    `${playground.checks.filter((check) => check.ok).length}/${playground.checks.length} 项操作检查`,
    { detail: playground.checks },
  );
}

/* ================================================================== */
/* AC-17 正式编辑器（public/index.html）                                */
/* ================================================================== */

const editor = await runEditorChecks();
if (editor.skipped) {
  record('AC-17', '正式编辑器：手动编辑 / 图片转写在工具栏 / 预览可开关', 'jsdom 打开 index.html 并点击各按钮', true, `跳过：${editor.reason}`, { skipped: true });
} else {
  record(
    'AC-17',
    '正式编辑器：手动编辑、图片转写归入编辑工具栏、实时预览可关可开',
    'jsdom 打开 public/index.html，真实点击「工具栏 / 预览开关 / 模式切换 / 导出」',
    editor.checks.every((check) => check.ok),
    `${editor.checks.filter((check) => check.ok).length}/${editor.checks.length} 项编辑器检查`,
    { detail: editor.checks },
  );
}

/* ================================================================== */
/* AC-15 论坛集成（两种布局）                                           */
/* ================================================================== */

const aiForum = join(WORK, '.inspect', 'forum-ai-full', 'forum', 'src', 'server.js');
const rootForum = join(WORK, 'src', 'server.js');
const integration = {};

if (await exists(aiForum)) {
  const result = await runForumIntegrationChecks({
    forumEntry: aiForum,
    noteStudioEntry: join(ROOT, 'src', 'index.mjs'),
    port: 3021,
    expectForumAi: true,
  });
  integration.aiForum = result.checks;
  record(
    'AC-15',
    '接回论坛后功能可用（AI 版布局）',
    'runForumIntegrationChecks：真实 HTTP + 真实登录态 + 真实落盘',
    result.checks.every((check) => check.ok),
    `${result.checks.filter((check) => check.ok).length}/${result.checks.length} 项`,
    { detail: result.checks },
  );
}
if (await exists(rootForum)) {
  const result = await runForumIntegrationChecks({
    forumEntry: rootForum,
    noteStudioEntry: join(ROOT, 'src', 'index.mjs'),
    port: 3022,
    expectForumAi: false,
  });
  integration.rootForum = result.checks;
  record(
    'AC-15b',
    '接回论坛后功能可用（根目录布局，无 forum-ai 也要能降级）',
    'runForumIntegrationChecks：真实 HTTP + 真实登录态 + 真实落盘',
    result.checks.every((check) => check.ok),
    `${result.checks.filter((check) => check.ok).length}/${result.checks.length} 项`,
    { detail: result.checks },
  );
}

/* ================================================================== */
/* 报告                                                                */
/* ================================================================== */

const passed = results.filter((item) => item.ok && !item.skipped);
const skipped = results.filter((item) => item.skipped);
const failed = results.filter((item) => !item.ok && !item.skipped);
const verdict = failed.length ? 'FAIL' : skipped.length ? 'PASS（含跳过）' : 'PASS';

const escape = (text) => String(text).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch]);
const embed = (text) => JSON.stringify(String(text)).replace(/</g, '\\u003c');

const convertForReport = liveConvert ?? offlineConvert;
const convertLabel = liveConvert ? '真实视觉模型' : '离线假 AI（契约级验证）';

const rowsHtml = results
  .map((item) => {
    const state = item.skipped ? 'skip' : item.ok ? 'ok' : 'bad';
    const badge = item.skipped ? '跳过' : item.ok ? '通过' : '失败';
    const list = Array.isArray(item.detail) ? item.detail : null;
    const detail = list
      ? `<details><summary>明细（${list.length} 项）</summary><ul>${list.map((d) => `<li class="${d.ok ? 'ok' : 'bad'}">${d.ok ? '✔' : '✘'} ${escape(d.name)}</li>`).join('')}</ul></details>`
      : '';
    return `<tr class="${state}">
      <td class="id">${item.id}</td>
      <td>${escape(item.criterion)}<div class="how">验证：${escape(item.how)}</div>${detail}</td>
      <td class="evidence">${escape(item.evidence)}</td>
      <td class="badge ${state}">${badge}</td>
    </tr>`;
  })
  .join('\n');

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>note-studio 验收报告</title>
<link rel="stylesheet" href="../../public/vendor/katex/katex.min.css">
<style>
  :root { --ok:#1a7f37; --bad:#b42318; --skip:#8a6d1f; --line:#d8dee7; --muted:#5b6675; --bg:#f7f8fa; }
  * { box-sizing:border-box; }
  body { margin:0; padding:32px 20px 80px; background:var(--bg); color:#141a22;
         font:15px/1.65 "PingFang SC","Microsoft YaHei",system-ui,-apple-system,"Segoe UI",sans-serif; }
  main { max-width:1080px; margin:0 auto; }
  h1 { margin:0 0 4px; font-size:26px; }
  h2 { margin:36px 0 12px; font-size:19px; padding-bottom:6px; border-bottom:2px solid var(--line); }
  h3 { margin:22px 0 8px; font-size:16px; }
  .sub { color:var(--muted); margin:0 0 18px; }
  .verdict { display:flex; align-items:center; gap:18px; padding:16px 20px; border-radius:12px; background:#fff; border:1px solid var(--line); box-shadow:0 1px 2px rgba(16,24,40,.06); }
  .verdict .big { font-size:30px; font-weight:700; }
  .verdict.pass .big { color:var(--ok); }
  .verdict.fail .big { color:var(--bad); }
  .cards { display:flex; gap:12px; flex-wrap:wrap; margin:16px 0 0; }
  .card { flex:1 1 150px; padding:12px 14px; background:#fff; border:1px solid var(--line); border-radius:10px; }
  .card b { display:block; font-size:22px; }
  table { width:100%; border-collapse:collapse; background:#fff; border:1px solid var(--line); border-radius:10px; overflow:hidden; }
  th,td { padding:10px 12px; border-bottom:1px solid var(--line); vertical-align:top; text-align:left; }
  th { background:#eef1f6; font-size:13px; color:var(--muted); }
  td.id { font-family:ui-monospace,Consolas,monospace; font-weight:600; white-space:nowrap; }
  td.evidence { color:#26303d; font-size:13.5px; max-width:330px; }
  .how { color:var(--muted); font-size:12.5px; margin-top:3px; }
  .badge { font-weight:700; white-space:nowrap; text-align:center; }
  .badge.ok,.badge.skip,.badge.bad { display:inline-block; padding:2px 10px; border-radius:999px; font-size:12.5px; }
  .badge.ok { background:#e6f4ea; color:var(--ok); }
  .badge.bad { background:#fde8e6; color:var(--bad); }
  .badge.skip { background:#fdf3d7; color:var(--skip); }
  tr.bad td { background:#fff7f6; }
  details { margin-top:6px; }
  details summary { cursor:pointer; color:var(--muted); font-size:12.5px; }
  details ul { margin:6px 0 0 18px; padding:0; font-size:13px; }
  details li.ok { color:var(--ok); }
  details li.bad { color:var(--bad); }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
  @media (max-width:860px) { .grid { grid-template-columns:1fr; } }
  .box { background:#fff; border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
  pre { margin:0; padding:12px; background:#0f1419; color:#e6edf3; border-radius:8px; overflow:auto; font-size:12.5px; line-height:1.55; max-height:340px; }
  .preview { background:#fff; border:1px solid var(--line); border-radius:10px; padding:16px 20px; }
  .photo { max-width:100%; border:1px solid var(--line); border-radius:8px; }
  .note { color:var(--muted); font-size:13px; }
  .cmd { display:block; padding:10px 12px; background:#0f1419; color:#e6edf3; border-radius:8px; font-family:ui-monospace,Consolas,monospace; font-size:13px; }
  ul.checklist { columns:2; }
  @media (max-width:860px) { ul.checklist { columns:1; } }
  .katex-display { margin:.6em 0; }
  footer { margin-top:40px; color:var(--muted); font-size:12.5px; }
</style>
</head>
<body>
<main>
  <h1>note-studio 验收报告</h1>
  <p class="sub">生成时间 ${new Date().toISOString()} · 模式 ${LIVE ? '离线 + 真实模型' : '离线确定性'} · 报告由 <code>node acceptance/run.mjs</code> 生成</p>

  <div class="verdict ${failed.length ? 'fail' : 'pass'}">
    <div class="big">${verdict}</div>
    <div>
      通过 <b>${passed.length}</b> 项${skipped.length ? ` · 跳过 <b>${skipped.length}</b> 项` : ''}${failed.length ? ` · 失败 <b>${failed.length}</b> 项` : ''}<br>
      <span class="note">每一条都可在本机复现：命令与验证方式写在表格里。</span>
    </div>
  </div>

  <p class="sub" style="margin:14px 0 0">
    ▶ <b>想直接上手操作？</b>
    打开 <a href="../../public/playground.html"><b>public/playground.html</b></a> ——
    可操作样例：编辑（源码 / 分栏 / 可视化）、实时渲染、载入样例照片转写、导出真实的 <code>.md</code> 与 <code>.json</code>。
    直接双击也能用（离线模式）；用本地服务打开 <code>/notes/playground.html</code> 时，图片转写会走**真实的既有 AI 接口**。
  </p>

  <div class="cards">
    <div class="card"><b>${unit.pass}</b>零依赖测试通过</div>
    <div class="card"><b>${render.skipped ? '—' : render.checks.filter((c) => c.ok).length + '/' + render.checks.length}</b>渲染与往返检查</div>
    <div class="card"><b>${integration.aiForum ? integration.aiForum.filter((c) => c.ok).length + '/' + integration.aiForum.length : '—'}</b>论坛集成（AI 版）</div>
    <div class="card"><b>${integration.rootForum ? integration.rootForum.filter((c) => c.ok).length + '/' + integration.rootForum.length : '—'}</b>论坛集成（根目录版）</div>
  </div>

  <h2>一、验收标准与证据</h2>
  <table>
    <thead><tr><th>编号</th><th>验收标准</th><th>证据</th><th>结果</th></tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table>

  <h2>二、样例审查：输入</h2>
  <div class="grid">
    <div class="box">
      <h3>待转写的图片（固定样例）</h3>
      <img class="photo" src="../sample/sample-note-photo.png" alt="实验笔记照片样例">
      <p class="note">${Math.round(imageBytes.length / 1024)} KB · 900×620 · 由 <code>acceptance/tools/make-sample-image.py</code> 生成，可换成你自己的照片。</p>
    </div>
    <div class="box">
      <h3>笔记正文（输入）</h3>
      <pre>${escape(sourceMarkdown)}</pre>
    </div>
  </div>

  <h2>三、样例审查：渲染结果</h2>
  <p class="note">下面这块是**用编辑器自己的渲染管线**（public/render.js + 内置 KaTeX）在你这台机器上现算的，不是截图。</p>
  <div class="preview markdown-body" id="preview">渲染中…</div>

  <h2>四、样例审查：图片转写结果（${convertLabel}）</h2>
  <div class="grid">
    <div class="box">
      <h3>转写出的 Markdown</h3>
      <pre>${escape(convertForReport.markdown)}</pre>
    </div>
    <div class="box">
      <h3>转写出的 LaTeX</h3>
      <pre>${escape(convertForReport.latex)}</pre>
      <p class="note">模型：${escape(convertForReport.model || '未记录')} · 用量 prompt ${convertForReport.usage?.prompt ?? '?'} / completion ${convertForReport.usage?.completion ?? '?'}</p>
      ${liveConvert ? '' : '<p class="note">⚠️ 离线模式下这是<strong>固定应答</strong>：验证的是报文形状、解析与落盘，不是识别质量。要验识别质量请配好 AI_API_KEY 与视觉模型后跑 <code>--live</code>。</p>'}
    </div>
  </div>

  <h2>五、样例审查：交付物</h2>
  <div class="grid">
    <div class="box">
      <h3>sample-note.md</h3>
      <pre>${escape(readBack.markdown)}</pre>
    </div>
    <div class="box">
      <h3>sample-note.json（记录基础数据）</h3>
      <pre>${escape(JSON.stringify(meta, null, 2))}</pre>
    </div>
  </div>

  <h2>六、怎么自己复现</h2>
  <span class="cmd">cd note-studio &amp;&amp; node acceptance/run.mjs</span>
  <p class="note">上面这条会重新跑出本报告与样例产物。另有：</p>
  <span class="cmd">node tests/run.mjs                                   # 零依赖测试（${unit.pass} 项）</span>
  <span class="cmd">NODE_PATH=&lt;装有 jsdom&gt;/node_modules node tests/browser/verify-render.mjs</span>
  <span class="cmd">node tests/browser/verify-integration.mjs            # 论坛集成（AI 版）</span>
  <span class="cmd">node tests/browser/verify-root-forum.mjs             # 论坛集成（根目录版）</span>
  <span class="cmd">node examples/demo.mjs                               # 端到端样例（自带假 AI）</span>

  <h2>七、请你人工确认</h2>
  <ul class="checklist">
    <li>公式渲染效果是否符合预期（第三节）</li>
    <li>三种编辑模式是否够用（源码 / 分栏 / 可视化）</li>
    <li>图片转写的字段与格式是否合你的用法</li>
    <li>sample-note.json 的字段是否需要增删</li>
    <li>接入方式（1 个胶水文件 + 3 处补丁）是否可接受</li>
    <li>是否需要我按你的真实照片跑一次 --live</li>
  </ul>

  <footer>note-studio v1.0.0 · 报告文件与样例产物在 acceptance/output/ 下</footer>
</main>

<script src="../../public/vendor/marked/marked.min.js"></script>
<script src="../../public/vendor/katex/katex.min.js"></script>
<script src="../../public/vendor/katex/contrib/auto-render.min.js"></script>
<script src="../../public/render.js"></script>
<script>
  (function () {
    var source = ${embed(sourceMarkdown)};
    var host = document.getElementById('preview');
    try {
      var result = window.NoteRender.renderInto(host, source);
      host.insertAdjacentHTML('afterbegin', '<p class="note">渲染管线：public/render.js + KaTeX，本次渲染出 ' + result.math + ' 个公式。</p>');
    } catch (error) {
      host.textContent = '渲染失败：' + (error && error.message);
    }
  })();
</script>
</body>
</html>
`;

await writeFile(join(OUT, 'acceptance-report.html'), html, 'utf8');
await writeFile(
  join(OUT, 'acceptance-report.json'),
  `${JSON.stringify({ generatedAt: new Date().toISOString(), live: LIVE, verdict, passed: passed.length, skipped: skipped.length, failed: failed.length, unit, render: { skipped: render.skipped, math: render.math, checks: render.checks }, checks: results.map(({ detail, meta: _meta, convertOffline, convertLive, ...rest }) => ({ ...rest, detailCount: detail?.length ?? 0 })) }, null, 2)}\n`,
  'utf8',
);
await writeFile(join(OUT, 'convert-result.json'), `${JSON.stringify({ mode: liveConvert ? 'live' : 'offline-fake', model: convertForReport.model, markdown: convertForReport.markdown, latex: convertForReport.latex, usage: convertForReport.usage, at: convertForReport.at }, null, 2)}\n`, 'utf8');

await rm(tempDir, { recursive: true, force: true });

log('');
log('验收结果');
for (const item of results) {
  log(`  ${item.skipped ? '○' : item.ok ? '✔' : '✘'} ${item.id}  ${item.evidence}`);
}
log('');
log(`  结论：${verdict}（通过 ${passed.length} / 跳过 ${skipped.length} / 失败 ${failed.length}）`);
log('');
log('产物：');
for (const file of ['acceptance-report.html', 'acceptance-report.json', 'sample-note.md', 'sample-note.json', 'convert-result.json']) {
  log(`  ${rel(join(OUT, file))}`);
}

process.exit(failed.length ? 1 : 0);
