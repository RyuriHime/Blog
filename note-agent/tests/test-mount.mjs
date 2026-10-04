import { createChecker } from './helpers/check.mjs';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { mountNoteAgent } from '../src/mount.mjs';
import { createFakeChat } from './helpers/fake-chat.mjs';

const { check, summary } = createChecker();
const dir = mkdtempSync(join(tmpdir(), 'notes-mount-'));
mkdirSync(join(dir, 'client'), { recursive: true });
const db = new DatabaseSync(join(dir, 't.db'));
const fake = createFakeChat([{ title: 'T', tags: [], ops: [], notes: [], warnings: [] }]);
const agent = mountNoteAgent({ db, resolveUser: (req) => ({ user: { id: 1, name: 'u' } }), env: { AI_API_KEY: 'k' }, chatImpl: fake.chatImpl, quiet: true });

// 一个"宿主" listener，用来证明未命中的请求确实交回原 listener
let hostHits = 0;
const server = createServer((req, res) => { hostHits += 1; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, data: { from: 'host' } })); });
agent.attach(server);
agent.attach(server); // 幂等性检查
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const statusRes = await fetch(`${base}/api/notes/status`);
const statusBody = await statusRes.json();
check('命中 /api/notes/status 时不落到宿主 listener', hostHits === 0 && statusBody.ok === true && statusBody.data.configured === true);
check('status 带 contractVersion', statusBody.data.contractVersion === '1');

// 【回归】HTTP /status 与挂载层 status() 报的必须是同一个预算。
// 原来 HTTP 那边写死 DEFAULT_CHAR_BUDGET(24000)，宿主传 5000 时两个接口各说一套。
{
  const budgetDir = mkdtempSync(join(tmpdir(), 'notes-mount-budget-'));
  const budgetDb = new DatabaseSync(join(budgetDir, 'b.db'));
  const budgetExplicit = mountNoteAgent({
    db: budgetDb, resolveUser: () => ({ user: { id: 1 } }), env: { AI_API_KEY: 'k' }, chatImpl: fake.chatImpl, quiet: true, materialChars: 5000,
  });
  const budgetServer = createServer((req, res) => { res.writeHead(200); res.end('{}'); });
  budgetExplicit.attach(budgetServer);
  await new Promise((r) => budgetServer.listen(0, '127.0.0.1', r));
  const budgetBody = await (await fetch(`http://127.0.0.1:${budgetServer.address().port}/api/notes/status`)).json();
  check('【回归】HTTP /status 的 materialChars 与挂载层一致', budgetBody.data.materialChars === 5000, String(budgetBody.data.materialChars));
  // 两处各写一份状态的后果：宿主 /api/site 看到一套、面板 /status 看到另一套。
  // 现在两边都取路由层的 statusSnapshot()，这里把两份逐键钉在一起。
  const mountedState = budgetExplicit.status();
  const same = JSON.stringify(Object.keys(mountedState).sort()) === JSON.stringify(Object.keys(budgetBody.data).sort())
    && JSON.stringify(mountedState) === JSON.stringify(budgetBody.data);
  check('【回归】挂载层 status() 与 HTTP /status 逐键一致', same, `mounted=${JSON.stringify(mountedState)} http=${JSON.stringify(budgetBody.data)}`);
  check('【回归】状态里带上了 aiSource / features / limits.requirement', mountedState.aiSource !== undefined && Array.isArray(mountedState.features) && mountedState.limits.requirement > 0, JSON.stringify(mountedState.limits));
  await new Promise((r) => budgetServer.close(r));
  // 不在这里删临时库：Windows 上 DatabaseSync 还开着句柄，删目录会 EPERM。
  budgetDb.close();
  rmSync(budgetDir, { recursive: true, force: true });
}

const hostRes = await fetch(`${base}/api/site`);
check('未命中的请求交回宿主 listener', hostHits === 1 && (await hostRes.json()).data.from === 'host');

const form = new FormData();
form.append('files', new Blob([Buffer.from('# 导数\n\n内容', 'utf8')], { type: 'text/markdown' }), '笔记.md');
form.append('postId', '778899');
const upRes = await fetch(`${base}/api/notes/session`, { method: 'POST', body: form });
const upBody = await upRes.json();
check('multipart 上传由挂载层自己解析（不经过宿主的 JSON 读取器）', upRes.status === 200 && upBody.data.sessionId > 0);
check('【RF-3】中文文件名在 multipart 往返后保留', upBody.data.sources[0].name === '笔记.md');

// multipart 的字段全是字符串：必须归一成数字后再落库，否则 post_id 存成 '778899'、
// 下一次按数字查就配不上，症状是"同一篇帖子每次都新建工作台"。
const reuseForm = new FormData();
reuseForm.append('files', new Blob([Buffer.from('# 导数\n\n内容', 'utf8')], { type: 'text/markdown' }), '笔记.md');
reuseForm.append('postId', '778899');
const reuseRes = await fetch(`${base}/api/notes/session`, { method: 'POST', body: reuseForm });
const reuseBody = await reuseRes.json();
check('multipart 里的 postId 归一成数字：同一篇帖子复用工作台', reuseBody.data.sessionId === upBody.data.sessionId, `${reuseBody.data.sessionId} vs ${upBody.data.sessionId}`);

// 编辑区里的文字走 JSON 路径（不上传文件）：这是用户真实用法
const typedRes = await fetch(`${base}/api/notes/session`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ draft: '# 直接写的\n\n正文一段', sessionId: upBody.data.sessionId }),
});
const typedBody = await typedRes.json();
check('编辑区内容走 JSON 就能同步进已有工作台', typedRes.status === 200 && typedBody.data.blocks.some((b) => b.text.includes('直接写的')));

const badRes = await fetch(`${base}/api/notes/turn`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'not json' });
check('非法 JSON 返回 400 invalid_json 且不崩', badRes.status === 400 && (await badRes.json()).error.code === 'invalid_json');
const bigRes = await fetch(`${base}/api/notes/turn`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(300 * 1024) });
check('超 256KB 的 JSON 返回 413 payload_too_large', bigRes.status === 413 && (await bigRes.json()).error.code === 'payload_too_large');

const scriptRes = await fetch(`${base}/notes-panel.js`);
check('挂载层把 client/notes-panel.mjs 当 /notes-panel.js 提供', scriptRes.headers.get('content-type').includes('javascript'));

// 面板样式跟着面板走：接入方不再需要往自己的 style.css 里粘三百行
const styleRes = await fetch(`${base}/notes-panel.css`);
const styleText = await styleRes.text();
check('挂载层把 client/notes-panel.css 当 /notes-panel.css 提供', styleRes.status === 200 && styleRes.headers.get('content-type').includes('text/css'));
check('样式表内容真的是面板样式（不是 404 页面或空文件）', styleText.includes('.notes-drawer') && styleText.includes('.notes-preview'), `${styleText.length} 字符`);
check('样式表对宿主主题变量有兜底（拷到没主题变量的站点也不裸）', styleText.includes('--notes-fallback-panel'));

// 渲染兜底也要跟着面板走：宿主没有 /markdown/preview 时，浏览器能直接 import 这个模块自己渲染
const mdRes = await fetch(`${base}/notes-markdown.js`);
const mdText = await mdRes.text();
check('挂载层把 src/markdown.mjs 当 /notes-markdown.js 提供', mdRes.status === 200 && mdRes.headers.get('content-type').includes('javascript'), `status=${mdRes.status} type=${mdRes.headers.get('content-type')}`);

// 【安全】静态资源也要带防嗅探头：不设的话浏览器可能把 .js 当别的类型处理。
check(
  '【安全】静态资源带 nosniff / 不许被嵌框',
  [scriptRes, styleRes, mdRes].every((res) => (res.headers.get('x-content-type-options') ?? '').includes('nosniff') && res.headers.get('x-frame-options') === 'DENY'),
  [scriptRes, styleRes, mdRes].map((res) => `${res.headers.get('x-content-type-options')}/${res.headers.get('x-frame-options')}`).join(' | '),
);
check('渲染模块真的是一个能用的 ES 模块', mdText.includes('export function renderMarkdown') && mdText.includes('export function markdownToPlainText'), `${mdText.length} 字符`);

// 静态资源必须 no-store：只写 no-cache 而没发 ETag/Last-Modified 时，浏览器会拿着
// 旧副本继续用 —— 改完样式刷新页面看不到变化，表现成"面板没样式"，极难排查（真踩过）。
check(
  '面板静态资源要求浏览器每次都取新的（no-store，避免改了样式刷新看不到）',
  [scriptRes, styleRes, mdRes].every((res) => /no-store/.test(res.headers.get('cache-control') ?? '')),
  [scriptRes, styleRes, mdRes].map((res) => res.headers.get('cache-control')).join(' | '),
);

// 环境变量兜底：运维改 .env 就能调预算，不必改代码。
// 显式传参优先于环境变量（宿主里写死的值不该被环境覆盖）。
const fromEnv = mountNoteAgent({
  db,
  resolveUser: () => ({ user: null }),
  env: { AI_API_KEY: 'k', NOTES_MATERIAL_CHARS: '8000', NOTES_UPLOAD_DIR: join(dir, 'up') },
  quiet: true,
});
check('NOTES_MATERIAL_CHARS 能作为默认预算', fromEnv.status().materialChars === 8000, String(fromEnv.status().materialChars));
// 回归：`uploadDir` / `NOTES_UPLOAD_DIR` 曾经被挂载层收下、一路传到 store 再原样导出，
// 但**从来没有任何代码往里写文件**（材料只进 notes_materials 表的文本列），文档却把它
// 写成"上传材料的落盘目录"。已整体删除，这条断言防止它被无意中加回来。
check(
  '【回归】不存在的落盘配置没有留在对外对象上',
  !('uploadDir' in fromEnv.store) && fromEnv.status().limits.uploadDir === undefined,
  Object.keys(fromEnv.store).filter((key) => /upload/i.test(key)).join(',') || '(无)',
);
const explicit = mountNoteAgent({
  db,
  resolveUser: () => ({ user: null }),
  env: { AI_API_KEY: 'k', NOTES_MATERIAL_CHARS: '8000', NOTES_UPLOAD_DIR: join(dir, 'up') },
  materialChars: 5000,
  quiet: true,
});
check('显式传参优先于环境变量', explicit.status().materialChars === 5000, String(explicit.status().materialChars));

/* ------------------------------------------------------------------ */
/* 【安全】跨站写操作闸门                                                */
/* ------------------------------------------------------------------ */
// 插件只靠宿主的会话 cookie 鉴权，而 multipart 表单是"无预检"的跨源可提交类型。
// SameSite=Lax 是宿主配置带来的副作用，不是这里的防御：一旦改成 SameSite=None，
// 任意页面都能替用户改写草稿、花掉用户的额度。这里自己判一次来源。
const csrfRes = await fetch(`${base}/api/notes/session`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
  body: JSON.stringify({ draft: '# 别人替我写的' }),
});
const csrfBody = await csrfRes.json();
check('【安全】跨站 Origin 的写请求被 403 拒绝', csrfRes.status === 403 && csrfBody.error?.code === 'notes_forbidden_origin', `${csrfRes.status} ${JSON.stringify(csrfBody)}`);
// 同源带 Origin 在真实浏览器里也会出现，必须照常放行，别把正常路径拦掉。
const sameOriginRes = await fetch(`${base}/api/notes/session`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: base },
  body: JSON.stringify({ draft: '# 同源正常写入' }),
});
check('【回归】同源带 Origin 的写请求照常放行', sameOriginRes.status === 200, String(sameOriginRes.status));
// 坏掉的 Origin 头同样不许放行（不是合法 URL ⇒ 不认）。
const badOriginRes = await fetch(`${base}/api/notes/session`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: 'not a url' },
  body: JSON.stringify({ draft: '# 坏来源' }),
});
check('【安全】畸形的 Origin 头也被拒', badOriginRes.status === 403, String(badOriginRes.status));

await new Promise((r) => server.close(r));
db.close(); rmSync(dir, { recursive: true, force: true });
summary();
