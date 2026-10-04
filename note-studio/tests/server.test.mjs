/**
 * server 集成测试：真起 HTTP 服务、真落盘、真发请求。
 *
 * 只依赖 node:http 与内置 fetch，零依赖。覆盖「保存为一个 .md + 一个 .json」这条主线。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startNoteServer } from '../src/server.mjs';

let app;
let dataDir;
let publicDir;

before(async () => {
  const root = await mkdtemp(join(tmpdir(), 'note-studio-http-'));
  dataDir = join(root, 'data');
  publicDir = join(root, 'public');
  await mkdir(publicDir, { recursive: true });
  await writeFile(join(publicDir, 'index.html'), '<!doctype html><title>note studio</title><div id="app"></div>', 'utf8');
  await writeFile(join(publicDir, 'studio.js'), 'window.__studio = true;', 'utf8');

  app = await startNoteServer({ port: 0, dir: dataDir, publicDir, quiet: true });
});

after(async () => {
  await app?.close();
  if (publicDir) await rm(join(publicDir, '..'), { recursive: true, force: true });
});

const api = (path, options) => fetch(`${app.url}${path}`, options);
const postJson = (path, body) =>
  api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('status：公开接口，返回版本与 AI 状态', async () => {
  const response = await api('/api/notes/status');
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.data.version, '1.0.0');
  assert.equal(payload.data.ai.configured, false);
});

test('根路径重定向到编辑器', async () => {
  const response = await api('/', { redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/notes/');
});

test('编辑器页面与静态资源可访问', async () => {
  const page = await api('/notes/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /note studio/);

  const script = await api('/notes/studio.js');
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /javascript/);
});

test('静态路径穿越被挡住', async () => {
  const response = await api('/notes/../../package.json');
  assert.equal(response.status, 404);
  assert.ok(!(await response.text()).includes('note-studio'));
});

test('保存：写出 .md 与 .json 两个文件', async () => {
  const markdown = '# 集成测试\n\n行内公式 $E = mc^2$，块级：\n\n$$\n\\int_0^1 x\\,dx\n$$\n';
  const response = await postJson('/api/notes', { name: '集成 笔记', markdown });
  assert.equal(response.status, 200);

  const payload = await response.json();
  assert.equal(payload.data.name, '集成-笔记');
  assert.equal(payload.data.files.markdown, '集成-笔记.md');
  assert.equal(payload.data.files.meta, '集成-笔记.json');

  const md = await readFile(join(dataDir, '集成-笔记.md'), 'utf8');
  assert.equal(md, markdown);

  const meta = JSON.parse(await readFile(join(dataDir, '集成-笔记.json'), 'utf8'));
  assert.equal(meta.schema, 'note-studio/document@1');
  assert.equal(meta.title, '集成测试');
  assert.equal(meta.math.inline, 1);
  assert.equal(meta.math.display, 1);
  assert.equal(meta.file.sha256.length, 64);
});

test('读取与列表：读回正文，列表里有这篇', async () => {
  const one = await api('/api/notes/集成-笔记');
  assert.equal(one.status, 200);
  const payload = await one.json();
  assert.match(payload.data.markdown, /集成测试/);
  assert.equal(payload.data.meta.title, '集成测试');

  const list = await (await api('/api/notes')).json();
  assert.ok(list.data.notes.some((note) => note.name === '集成-笔记'));
});

test('保存：请求体不是合法 JSON → 400', async () => {
  const response = await api('/api/notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.equal(payload.error.code, 'bad_request');
});

test('保存：缺少 markdown → 400', async () => {
  const response = await postJson('/api/notes', { name: 'x' });
  assert.equal(response.status, 400);
});

test('convert：没有注入 AI 时 503 ai_not_configured（而不是 500）', async () => {
  const response = await postJson('/api/notes/convert', { dataUrl: 'data:image/png;base64,AAA' });
  assert.equal(response.status, 503);
  const payload = await response.json();
  assert.equal(payload.error.code, 'ai_not_configured');
});

test('删除：删掉一对文件，再读 404', async () => {
  const response = await api('/api/notes/集成-笔记', { method: 'DELETE' });
  assert.equal(response.status, 200);

  await assert.rejects(() => stat(join(dataDir, '集成-笔记.md')));
  await assert.rejects(() => stat(join(dataDir, '集成-笔记.json')));

  const again = await api('/api/notes/集成-笔记');
  assert.equal(again.status, 404);
  const payload = await again.json();
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'not_found');
});

test('未知接口：404 且保持统一响应外壳', async () => {
  const response = await api('/api/notes/a/b/c/deep');
  assert.equal(response.status, 404);
  const payload = await response.json();
  assert.equal(payload.ok, false);
});
