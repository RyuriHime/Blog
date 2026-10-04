/**
 * static 单元测试：编辑器静态资源的分发。
 *
 * 重点在**路径穿越**：编辑器页面是挂在论坛同一台服务器上的，
 * 不能因为一个 ../ 就读到仓库里的任意文件。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MIME, createStaticHandler } from '../src/static.mjs';

const FILES = {
  'index.html': '<!doctype html><title>studio</title>',
  'studio.js': 'console.log(1)',
  'studio.css': 'body{}',
  'vendor/katex/katex.min.js': 'window.katex={}',
};

const readFile = async (path) => {
  const key = path.replace(/\\/g, '/').split('/').slice(-1)[0];
  const match = Object.keys(FILES).find((name) => name.endsWith(key));
  if (match === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  return Buffer.from(FILES[match], 'utf8');
};

const handler = (options = {}) => createStaticHandler({ root: 'C:/app/public', readFile, ...options });

test('挂载路径返回编辑器首页', async () => {
  for (const pathname of ['/notes', '/notes/']) {
    const response = await handler()(pathname);
    assert.equal(response.status, 200);
    assert.match(response.body.toString('utf8'), /studio/);
    assert.equal(response.headers['Content-Type'], 'text/html; charset=utf-8');
  }
});

test('按扩展名给出 Content-Type', async () => {
  const js = await handler()('/notes/studio.js');
  assert.match(js.headers['Content-Type'], /javascript/);
  const css = await handler()('/notes/studio.css');
  assert.match(css.headers['Content-Type'], /css/);
});

test('支持自定义挂载前缀', async () => {
  assert.equal(await handler({ prefix: '/x' })('/notes'), null);
  assert.equal((await handler({ prefix: '/x' })('/x/')).status, 200);
});

test('前缀之外的路径交给宿主（返回 null）', async () => {
  assert.equal(await handler()('/style.css'), null);
  assert.equal(await handler()('/'), null);
  assert.equal(await handler()('/api/notes/status'), null);
});

test('路径穿越被挡住，绝不读到根目录之外', async () => {
  const read = [];
  const spy = async (path) => {
    read.push(String(path));
    return readFile(path);
  };
  const guarded = createStaticHandler({ root: 'C:/app/public', readFile: spy });

  for (const attack of ['/notes/../../secret.txt', '/notes/..%2f..%2fsecret.txt', '/notes/%2e%2e/%2e%2e/secret']) {
    const response = await guarded(attack);
    assert.ok(response === null || response.status === 404, `${attack} 不应被放行`);
  }
  for (const path of read) {
    assert.ok(!path.replace(/\\/g, '/').includes('secret'), `不该尝试读取 ${path}`);
  }
});

test('缺失的资源返回 404（而不是 null，避免宿主回落到 SPA）', async () => {
  const response = await handler()('/notes/nope.js');
  assert.equal(response.status, 404);
});

test('MIME 表覆盖编辑器要用的类型', () => {
  assert.equal(MIME['.html'], 'text/html; charset=utf-8');
  assert.ok(MIME['.js']);
  assert.ok(MIME['.css']);
  assert.ok(MIME['.woff2']);
  assert.ok(MIME['.svg']);
});
