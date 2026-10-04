/**
 * routes 单元测试：框架无关的 HTTP 处理器 + 路由器。
 *
 * 这些测试**不碰真实文件系统、不碰真实 AI**：store 与 ai 都是注入的假实现，
 * 正好验证依赖注入的边界是否干净（处理器不该知道论坛的 ctx 细节）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  VERSION,
  NOTE_ERROR_STATUS,
  toResponse,
  createNoteHandlers,
  createNoteRouter,
} from '../src/routes.mjs';

const USER = { id: 7, username: 'alice', role: 'user' };

function fakeStore(overrides = {}) {
  const calls = { save: [], remove: [] };
  return {
    calls,
    async save(input) {
      calls.save.push(input);
      return { name: 'demo', mdPath: '/tmp/demo.md', jsonPath: '/tmp/demo.json', meta: { schema: 'note-studio/document@1' } };
    },
    async read(name) {
      if (name === 'missing') return null;
      return { name, markdown: '# hi', meta: { title: 'hi' }, metaRecovered: false };
    },
    async list() {
      return [{ name: 'demo', title: 'demo', updatedAt: '2026-10-02T00:00:00.000Z', bytes: 10 }];
    },
    async remove(name) {
      calls.remove.push(name);
      return name !== 'missing';
    },
    ...overrides,
  };
}

function fakeAi(overrides = {}) {
  return {
    configured: true,
    status: () => ({ configured: true, model: 'vision-x', baseUrl: 'https://example.com/v1', envKeys: [] }),
    async convertImage({ kind }) {
      return { markdown: '# 识别', latex: 'x^2', kind, model: 'vision-x', usage: { prompt: 1, completion: 2 }, at: 'now' };
    },
    async organizeNote() {
      return { title: '整理后', summary: 's', knowledgePoints: ['k'], tags: ['t'], outline: ['o'], suggestedMarkdown: '# 整理后', model: 'm', usage: {} };
    },
    async reviewNote() {
      return { score: 80, strengths: [], issues: [], suggestions: [], model: 'm', usage: {} };
    },
    ...overrides,
  };
}

function makeHandlers({ store = fakeStore(), ai = fakeAi(), currentUser = () => USER, beforeWrite } = {}) {
  return createNoteHandlers({ store, ai, currentUser, beforeWrite });
}

/* ------------------------------------------------------------------ */
/* 错误映射                                                            */
/* ------------------------------------------------------------------ */

test('toResponse：上游 AI 错误码映射到既有 HTTP 语义', () => {
  const cases = {
    ai_not_configured: 503,
    ai_timeout: 504,
    ai_rate_limited: 429,
    ai_unauthorized: 502,
    ai_unreachable: 502,
    ai_bad_json: 502,
    unauthenticated: 401,
    forbidden: 403,
    not_found: 404,
    bad_request: 400,
    too_large: 413,
  };
  for (const [code, status] of Object.entries(cases)) {
    const error = Object.assign(new Error('x'), { code });
    const response = toResponse(error);
    assert.equal(response.status, status, `${code} 应该映射成 ${status}`);
    assert.equal(response.body.ok, false);
    assert.equal(response.body.error.code, code);
  }
  assert.equal(NOTE_ERROR_STATUS.ai_not_configured, 503);
});

test('toResponse：未知错误收敛成 500，不外泄内部信息', () => {
  const response = toResponse(new Error('数据库连接串是 postgres://secret'));
  assert.equal(response.status, 500);
  assert.equal(response.body.error.code, 'internal_error');
  assert.ok(!response.body.error.message.includes('postgres://secret'));
});

/* ------------------------------------------------------------------ */
/* 处理器                                                             */
/* ------------------------------------------------------------------ */

test('status：公开可访问，带版本与 AI 状态且不含密钥', async () => {
  const handlers = makeHandlers();
  const response = await handlers.status({});
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.data.version, VERSION);
  assert.equal(response.body.data.ai.configured, true);
  assert.ok(!JSON.stringify(response.body).includes('AI_API_KEY'));
});

test('status：AI 未配置时也能用（编辑器仍可离线写笔记）', async () => {
  const handlers = createNoteHandlers({ store: fakeStore(), ai: null, currentUser: () => USER });
  const response = await handlers.status({});
  assert.equal(response.status, 200);
  assert.equal(response.body.data.ai.configured, false);
});

test('list：未登录 401，登录后返回列表', async () => {
  const anonymous = makeHandlers({ currentUser: () => null });
  assert.equal((await anonymous.list({})).status, 401);

  const handlers = makeHandlers();
  const response = await handlers.list({});
  assert.equal(response.status, 200);
  assert.equal(response.body.data.count, 1);
  assert.equal(response.body.data.notes[0].name, 'demo');
});

test('save：写入 .md + .json，并回传两个文件路径', async () => {
  const store = fakeStore();
  let hooked = 0;
  const handlers = makeHandlers({ store, beforeWrite: async () => { hooked += 1; } });
  const response = await handlers.save({ body: { name: '我的 笔记', markdown: '# T' } });

  assert.equal(response.status, 200);
  assert.equal(hooked, 1);
  assert.equal(store.calls.save[0].name, '我的 笔记');
  assert.equal(store.calls.save[0].markdown, '# T');
  assert.equal(response.body.data.mdPath, '/tmp/demo.md');
  assert.equal(response.body.data.jsonPath, '/tmp/demo.json');
});

test('save：正文缺失或类型不对 → 400', async () => {
  const handlers = makeHandlers();
  assert.equal((await handlers.save({ body: {} })).status, 400);
  assert.equal((await handlers.save({ body: { markdown: 123 } })).status, 400);
});

test('save：超长正文 → 413 too_large', async () => {
  const handlers = createNoteHandlers({ store: fakeStore(), ai: fakeAi(), currentUser: () => USER, limits: { maxCharacters: 100 } });
  const response = await handlers.save({ body: { markdown: 'x'.repeat(101) } });
  assert.equal(response.status, 413);
  assert.equal(response.body.error.code, 'too_large');
});

test('beforeWrite 抛错（例如限流）会原样映射', async () => {
  const handlers = makeHandlers({
    beforeWrite: async () => {
      throw Object.assign(new Error('太快了'), { status: 429, code: 'rate_limited' });
    },
  });
  const response = await handlers.save({ body: { markdown: 'x' } });
  assert.equal(response.status, 429);
  assert.equal(response.body.error.code, 'rate_limited');
});

test('getNote：存在返回正文与元数据，不存在 404', async () => {
  const handlers = makeHandlers();
  const found = await handlers.getNote({ params: { name: 'demo' } });
  assert.equal(found.status, 200);
  assert.equal(found.body.data.markdown, '# hi');
  assert.equal(found.body.data.meta.title, 'hi');

  const missing = await handlers.getNote({ params: { name: 'missing' } });
  assert.equal(missing.status, 404);
});

test('removeNote：删成功 200，删不存在 404', async () => {
  const handlers = makeHandlers();
  assert.equal((await handlers.removeNote({ params: { name: 'demo' } })).body.data.removed, true);
  assert.equal((await handlers.removeNote({ params: { name: 'missing' } })).status, 404);
});

test('convert：图片转写返回 markdown 与 latex', async () => {
  const handlers = makeHandlers();
  const response = await handlers.convert({ body: { dataUrl: 'data:image/png;base64,AAA', kind: 'both' } });
  assert.equal(response.status, 200);
  assert.equal(response.body.data.markdown, '# 识别');
  assert.equal(response.body.data.latex, 'x^2');
});

test('convert：缺图片 → 400；图片过大 → 413', async () => {
  const handlers = makeHandlers();
  assert.equal((await handlers.convert({ body: {} })).status, 400);
  assert.equal((await handlers.convert({ body: { dataUrl: 'not-an-image' } })).status, 400);

  const small = createNoteHandlers({ store: fakeStore(), ai: fakeAi(), currentUser: () => USER, limits: { maxImageBytes: 32 } });
  const response = await small.convert({ body: { dataUrl: `data:image/png;base64,${'A'.repeat(64)}` } });
  assert.equal(response.status, 413);
});

test('convert：AI 未配置时 503，而不是 500', async () => {
  const handlers = createNoteHandlers({
    store: fakeStore(),
    ai: fakeAi({ convertImage: async () => { throw Object.assign(new Error('没配'), { code: 'ai_not_configured' }); } }),
    currentUser: () => USER,
  });
  const response = await handlers.convert({ body: { dataUrl: 'data:image/png;base64,AAA' } });
  assert.equal(response.status, 503);
  assert.equal(response.body.error.code, 'ai_not_configured');
});

test('organize / review：未登录 401，登录返回结构化结果', async () => {
  const anonymous = makeHandlers({ currentUser: () => null });
  assert.equal((await anonymous.organize({ body: { content: 'x' } })).status, 401);
  assert.equal((await anonymous.review({ body: { content: 'x' } })).status, 401);

  const handlers = makeHandlers();
  const organized = await handlers.organize({ body: { title: 't', content: '正文' } });
  assert.equal(organized.status, 200);
  assert.equal(organized.body.data.title, '整理后');

  const reviewed = await handlers.review({ body: { title: 't', content: '正文' } });
  assert.equal(reviewed.status, 200);
  assert.equal(reviewed.body.data.score, 80);
});

test('organize：正文缺失 → 400', async () => {
  const handlers = makeHandlers();
  assert.equal((await handlers.organize({ body: {} })).status, 400);
});

/* ------------------------------------------------------------------ */
/* 路由器                                                             */
/* ------------------------------------------------------------------ */

test('router：按方法与路径匹配，并解析 :name', async () => {
  const route = createNoteRouter(makeHandlers());
  const hit = await route({ method: 'GET', pathname: '/api/notes/demo', body: {} });
  assert.equal(hit.status, 200);
  assert.equal(hit.body.data.name, 'demo');

  assert.equal(await route({ method: 'GET', pathname: '/api/notes/nope/nope', body: {} }), null);
  assert.equal(await route({ method: 'PUT', pathname: '/api/notes/demo', body: {} }), null);
});

test('router：静态路径优先于 :name，不会被吃掉', async () => {
  const route = createNoteRouter(makeHandlers());
  const status = await route({ method: 'GET', pathname: '/api/notes/status', body: {} });
  assert.equal(status.body.data.version, VERSION);
  assert.equal(status.body.data.notes, undefined);
});

test('router：处理器抛出的错误被收敛成响应，不会漏出去', async () => {
  const route = createNoteRouter(makeHandlers({ currentUser: () => null }));
  const response = await route({ method: 'POST', pathname: '/api/notes', body: { markdown: 'x' } });
  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, 'unauthenticated');
});

test('router：支持自定义前缀', async () => {
  const route = createNoteRouter(makeHandlers(), { prefix: '/notes-api' });
  assert.equal(await route({ method: 'GET', pathname: '/api/notes/status', body: {} }), null);
  assert.equal((await route({ method: 'GET', pathname: '/notes-api/status', body: {} })).status, 200);
});
