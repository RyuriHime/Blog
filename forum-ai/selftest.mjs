#!/usr/bin/env node
/**
 * 自测：不需要真实密钥，自己起一个假的 OpenAI 兼容服务。
 *
 *   node selftest.mjs
 *
 * 覆盖：配置与降级、JSON 容错、幻觉过滤、缓存与过期、批量优先级、
 *       检索排序、HTTP 处理器的状态码与部分失败语义。
 */
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  AiError,
  aiStatus,
  chat,
  extractJson,
  normalizeReview,
  normalizeSiteReport,
  normalizeAnswer,
  buildMaterial,
  reviewDocument,
  reviewCorpus,
  answerQuestion,
  rankDocuments,
  selectForQuestion,
  createAiStore,
  createAiHandlers,
  createAiRouter,
  toResponse,
} from './src/index.mjs';

let passed = 0;
const failures = [];
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/* ------------------------------------------------------------------ */
/* 假 AI 服务                                                          */
/* ------------------------------------------------------------------ */

const mock = { calls: [], mode: 'ok' };

function mockReply(userText) {
  const ids = [...userText.matchAll(/\[#([\w.-]+)\]/g)].map((m) => m[1]);
  const wikiIds = [...userText.matchAll(/\[W#([\w.-]+)\]/g)].map((m) => m[1]);
  if (mock.mode === 'bad-json') return '抱歉，我无法回答。';
  if (mock.mode === 'fenced') {
    return null; // 由调用方包成 ```json
  }
  if (userText.includes('全库材料')) {
    return {
      summary: '全库概述。',
      topics: [
        { name: '主题甲', summary: '甲', difficulty: '入门', documentIds: [ids[0], 'not-a-number'], prereq: ['基础'], order: 1 },
        { name: '假主题', summary: '编号不存在', difficulty: '入门', documentIds: ['999999'], prereq: [], order: 2 },
      ],
      readingPath: [
        { documentId: ids[0], title: '先读', reason: '入门', level: '入门' },
        { documentId: '999999', title: '假的', reason: '应被过滤', level: '入门' },
      ],
    };
  }
  if (userText.includes('本篇材料')) {
    return {
      category: '后端',
      difficulty: '进阶',
      summary: '这是摘要。',
      tags: ['Node.js', 'SQLite'],
      prereq: [{ name: 'JavaScript', why: '读代码', level: '入门' }],
      recommend: [
        { documentId: ids[1], title: '相关文档', reason: '延伸', relation: '延伸' },
        { documentId: '999999', title: '不存在的文档', reason: '假的', relation: '对比' },
        // 真正的鬼篇目：连编号都没有，纯标题（2026-10 线上解读里出现过《XX 手册》这类）
        { documentId: null, title: '不存在的指南', reason: '编的', relation: '延伸' },
        { wikiId: wikiIds[0], title: '线段树', reason: 'OI 词条', relation: '先读' },
        { wikiId: '999999', title: '不存在的词条', reason: '假的', relation: '延伸' },
      ],
    };
  }
  return {
    answer: '依据材料可以得出结论 [#1]。',
    citations: [
      { documentId: ids[0], title: '引用一', quote: '片段' },
      { documentId: '999999', title: '假引用', quote: '应被过滤' },
    ],
    notes: ['建议先补基础'],
    confidence: 'high',
  };
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    const parsed = JSON.parse(body || '{}');
    mock.calls.push({ url: req.url, headers: req.headers, body: parsed });
    if (mock.mode === 'http-500') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'boom' }));
      return;
    }
    if (mock.mode === 'http-401') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (mock.mode === 'http-429') {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    const userText = String(parsed?.messages?.[1]?.content ?? '');
    const reply = mockReply(userText);
    const content =
      reply === null
        ? '```json\n' + JSON.stringify({ category: '前端', difficulty: '入门', summary: '代码块包裹的 JSON', tags: ['css'], prereq: [], recommend: [] }) + '\n```'
        : typeof reply === 'string'
          ? reply
          : JSON.stringify(reply);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        model: 'mock-model',
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 11, completion_tokens: 7 },
      }),
    );
  });
});

const PORT = Number(process.env.PORT || 3661);
await new Promise((done) => server.listen(PORT, '127.0.0.1', done));
const env = { AI_API_KEY: 'test-key', AI_BASE_URL: `http://127.0.0.1:${PORT}/v1`, AI_MODEL: 'mock-model' };

const DOCS = [
  {
    id: '1',
    title: 'Node.js 内置 SQLite 实践',
    content: '用 node:sqlite 做零依赖存储，包含建表与分页优化。',
    board: '技术',
    author: 'alice',
    replies: [{ author: 'bob', content: '分页那里讲得清楚', createdAt: Date.now() }],
    createdAt: Date.now() - 86400000,
    updatedAt: Date.now() - 86400000,
  },
  { id: '2', title: '前端性能优化', content: '首屏渲染与缓存策略。', board: '前端', createdAt: Date.now() - 3600000, updatedAt: Date.now() - 3600000 },
  { id: '3', title: 'Markdown 写作技巧', content: '一行一句，结构清晰。', board: '写作', createdAt: Date.now() - 7200000, updatedAt: Date.now() - 7200000 },
];

try {
  /* ---------------- 配置与降级 ---------------- */
  console.log('\n▶ 配置与降级');
  check('未配置时 aiStatus.configured=false', aiStatus({}).configured === false);
  check('配置后返回模型名', aiStatus(env).configured === true && aiStatus(env).model === 'mock-model');
  check('状态里不包含密钥', JSON.stringify(aiStatus(env)).includes('test-key') === false);
  let notConfigured = null;
  try {
    await chat([{ role: 'user', content: 'hi' }], { env: {} });
  } catch (error) {
    notConfigured = error;
  }
  check('未配置时抛 ai_not_configured', notConfigured instanceof AiError && notConfigured.code === 'ai_not_configured', notConfigured?.code);
  check('提示里告诉怎么配', String(notConfigured?.message).includes('AI_API_KEY'));
  check('未配置错误映射成 503', toResponse(notConfigured).status === 503);

  /* ---------------- JSON 容错 ---------------- */
  console.log('\n▶ JSON 容错与归一化');
  check('直接解析对象', extractJson('{"a":1}')?.a === 1);
  check('解析 ```json 包裹', extractJson('```json\n{"a":2}\n```')?.a === 2);
  check('解析前后夹带说明', extractJson('好的，结果是 {"a":3} 以上。')?.a === 3);
  check('解析嵌套对象', extractJson('前言 {"a":{"b":[1,2]}} 结尾')?.a?.b?.length === 2);
  check('非法输入返回 null', extractJson('完全不是 JSON') === null);
  check('字符串里的花括号不干扰', extractJson('{"a":"}"}')?.a === '}');

  const review = normalizeReview({ category: '后端', difficulty: '不存在的难度', summary: 's', tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], prereq: [{ name: 'x' }], recommend: [] }, {});
  check('难度枚举非法时回落', review.difficulty === '进阶', review.difficulty);
  check('标签数量被限制', review.tags.length === 6, String(review.tags.length));
  check('前置知识带默认难度', review.prereq[0].level === '入门');
  check('缺少摘要时用正文兜底', normalizeReview({}, { content: '正文内容' }).summary === '正文内容');

  const report = normalizeSiteReport(
    { summary: 's', topics: [{ name: 'T', documentIds: [1, 99] }, { name: 'X', documentIds: [99] }], readingPath: [{ documentId: 1 }, { documentId: 99 }] },
    [{ id: 1 }],
  );
  check('主题里的假编号被过滤', report.topics[0].documentIds.length === 1);
  check('编号全假的主题被整组丢弃', report.topics.length === 1, String(report.topics.length));
  check('阅读路线里的假编号被过滤', report.readingPath.length === 1);
  check('记录被丢弃的数量', report.dropped.topics === 1 && report.dropped.readingPath === 1, JSON.stringify(report.dropped));

  const answer = normalizeAnswer({ answer: 'a', citations: [{ documentId: 1, title: '有效引用' }, { documentId: 99, title: 'x' }], confidence: 'weird' }, [{ id: 1 }]);
  check('引用里的假编号被过滤', answer.citations.length === 1 && answer.citations[0].documentId === 1 && answer.droppedCitations === 1, JSON.stringify(answer));
  check('置信度非法时回落 medium', answer.confidence === 'medium');
  check('兼容 postId 写法', normalizeAnswer({ citations: [{ postId: 1, title: 'x' }] }, [{ id: 1 }]).citations[0].documentId === 1);

  /* ---------------- 材料装配 ---------------- */
  console.log('\n▶ 材料装配');
  const material = buildMaterial(DOCS, { charLimit: 100000 });
  check('材料包含编号与标题', material.text.includes('[#1]') && material.text.includes('Node.js 内置 SQLite'));
  check('材料包含回复', material.text.includes('分页那里讲得清楚'));
  check('材料统计包含篇数', material.included === 3);
  const tiny = buildMaterial(DOCS, { charLimit: 50 });
  check('预算极小时只保留能放下的部分', tiny.included < DOCS.length && tiny.truncated === true, JSON.stringify({ included: tiny.included, chars: tiny.chars }));
  check('预算被真正卡住', tiny.text.length <= 50 + 8, String(tiny.text.length));
  check('可以关闭回复', buildMaterial(DOCS, { withReplies: false }).text.includes('分页那里') === false);

  /* ---------------- 三个能力 ---------------- */
  console.log('\n▶ 单篇解读 / 全库整理 / 问答');
  const WIKI = [
    { id: 501, title: '线段树', station: 'OI Wiki', category: '数据结构' },
    { id: 502, title: 'string', station: 'OI Wiki', category: 'STL' },
  ];
  const single = await reviewDocument(DOCS[0], DOCS.slice(1), { chatOptions: { env }, wikiPages: WIKI });
  check('解读返回分类', single.review.category === '后端', single.review.category);
  check('解读返回 token 用量', single.usage.prompt === 11 && single.usage.completion === 7);
  check('解读带上模型名', single.model === 'mock-model');
  check('推荐里的真实编号保留', single.review.recommend.some((item) => item.documentId === 2), JSON.stringify(single.review.recommend));
  check('推荐里的站内 Wiki 词条保留 wikiId', single.review.recommend.some((item) => item.wikiId === 501), JSON.stringify(single.review.recommend));
  check(
    '每条推荐都有真实落点（没有只剩标题的鬼篇目）',
    single.review.recommend.length > 0 && single.review.recommend.every((item) => item.documentId || item.wikiId),
    JSON.stringify(single.review.recommend),
  );
  check(
    '编造的篇目（假编号 / 无编号）整条丢掉',
    ['不存在的文档', '不存在的指南', '不存在的词条'].every((title) => !single.review.recommend.some((item) => item.title === title)),
    JSON.stringify(single.review.recommend),
  );
  const strictReview = normalizeReview(
    { recommend: [{ documentId: 999999, title: 'x' }, { wikiId: 999, title: 'y' }, { documentId: 2, wikiId: 501, title: '两边都对得上' }] },
    {},
    { knownIds: [1, 2], knownWikiIds: [501] },
  );
  check('未知帖子编号被整条丢弃', strictReview.recommend.every((item) => item.title !== 'x'), JSON.stringify(strictReview.recommend));
  check('未知 wiki 编号被整条丢弃', strictReview.recommend.every((item) => item.title !== 'y'), JSON.stringify(strictReview.recommend));
  check('同时给两个编号时两个都保留', strictReview.recommend[0]?.documentId === 2 && strictReview.recommend[0]?.wikiId === 501, JSON.stringify(strictReview.recommend));

  const corpus = await reviewCorpus(DOCS, { chatOptions: { env } });
  check('全库整理返回主题', corpus.report.topics.length === 1 && corpus.report.topics[0].documentIds.length >= 1, JSON.stringify(corpus.report.topics));
  check('全库整理返回阅读路线', corpus.report.readingPath.length === 1);
  check('请求里带 Bearer 密钥', mock.calls.at(-1).headers.authorization === 'Bearer test-key');

  const asked = await answerQuestion('分页怎么优化？', DOCS.slice(0, 1), { scope: 'document', chatOptions: { env } });
  check('问答返回答案与引用', asked.answer.text.length > 0 && asked.answer.citations.length === 1, JSON.stringify(asked.answer.citations));
  check('问答保留备注与置信度', asked.answer.notes.length === 1 && asked.answer.confidence === 'high');

  /* ---------------- 上游错误 ---------------- */
  console.log('\n▶ 上游错误映射');
  for (const [mode, code, status] of [
    ['http-401', 'ai_unauthorized', 502],
    ['http-429', 'ai_rate_limited', 429],
    ['http-500', 'ai_upstream_error', 502],
  ]) {
    mock.mode = mode;
    let caught = null;
    try {
      await chat([{ role: 'user', content: 'x' }], { env });
    } catch (error) {
      caught = error;
    }
    check(`${mode} → ${code}`, caught?.code === code, caught?.code);
    check(`${mode} 映射为 HTTP ${status}`, toResponse(caught).status === status, String(toResponse(caught).status));
  }
  mock.mode = 'bad-json';
  let badJson = null;
  try {
    await reviewDocument(DOCS[0], [], { chatOptions: { env } });
  } catch (error) {
    badJson = error;
  }
  check('模型返回非 JSON → ai_bad_json', badJson?.code === 'ai_bad_json', badJson?.code);
  mock.mode = 'fenced';
  const fenced = await reviewDocument(DOCS[0], [], { chatOptions: { env } });
  check('```json 包裹也能解析', fenced.review.category === '前端', fenced.review.category);
  mock.mode = 'ok';

  /* ---------------- 检索 ---------------- */
  console.log('\n▶ 检索与选择');
  const ranked = rankDocuments('SQLite 分页', DOCS);
  check('关键词命中的文档排第一', String(ranked[0].doc.id) === '1', JSON.stringify(ranked.map((r) => [r.doc.id, r.score])));
  const rankedEmpty = rankDocuments('', DOCS);
  check('空问题不报错且有序', rankedEmpty.length === 3);
  const selected = selectForQuestion('性能', DOCS, { charBudget: 10, maxDocuments: 2 });
  check('预算极小时也返回至少一篇', selected.picked.length >= 1);
  const selectedAll = selectForQuestion('性能', DOCS, { charBudget: 100000 });
  check('预算充足时全选', selectedAll.picked.length === 3);

  /* ---------------- 存储层 ---------------- */
  console.log('\n▶ SQLite 存储层');
  const db = new DatabaseSync(':memory:');
  let source = DOCS;
  const store = createAiStore({ db, documentSource: () => source, tablePrefix: 'ai_' });
  const synced = store.syncCorpus();
  check('syncCorpus 写入索引', synced.documents === 3 && synced.replies === 1, JSON.stringify(synced));
  check('corpusDocuments 带回正文与回复', store.corpusDocuments()[0].content.includes('node:sqlite') && store.corpusDocuments()[0].replies.length === 1);
  const hashBefore = store.corpusHash();
  check('指纹稳定', store.corpusHash() === hashBefore);

  check('初始无缓存', store.reviewOf('1') === null);
  check('初始全是待整理', store.countPending() === 3 && store.pendingDocuments({ limit: 2 }).length === 2, JSON.stringify(store.pendingDocuments({ limit: 2 })));
  const savedReview = store.saveReview(
    { documentId: '1', status: 'done', category: '数据库', difficulty: '进阶', summary: 's', tags: ['sqlite'], prereq: [], recommend: [], model: 'm', tokens: { prompt: 3, completion: 2 } },
    { contentHash: hashBefore },
  );
  check('保存解读可读回', savedReview.category === '数据库' && savedReview.tokens.prompt === 3);
  check('已解读的不在待整理里', store.pendingDocuments({ limit: 10 }).includes('1') === false);
  check('统计已解读数量', store.reviewStats().analyzed === 1 && store.reviewStats().failed === 0);

  source = [...DOCS, { id: '4', title: '新文档', content: '新增内容' }];
  store.syncCorpus();
  check('内容变化后指纹改变', store.corpusHash() !== hashBefore);
  check('内容变化后旧解读算过期', store.pendingDocuments({ limit: 10 }).includes('1') === true);
  check('reportIsStale 对空报告返回 true', store.reportIsStale() === true);

  const savedReport = store.saveReport(
    { status: 'done', summary: 'r', topics: [{ name: 't', documentIds: ['1'] }], readingPath: [{ documentId: '1' }], documentCount: 4, model: 'm', tokens: { prompt: 5, completion: 6 } },
    { corpusHash: 'abc', createdBy: 'u1' },
  );
  check('报告可保存并读回最新', store.latestReport().id === savedReport.id && savedReport.topics.length === 1);
  check('报告 tokens 归一化', savedReport.tokens.prompt === 5);
  check('报告过期判定（hash 不同）', store.reportIsStale() === true);
  store.saveReport({ status: 'done', documentCount: 4 }, { corpusHash: store.corpusHash() });
  check('hash 一致时报告不过期', store.reportIsStale() === false);

  const cleared = store.clearAll();
  check('clearAll 清掉解读与报告', cleared.reviews === 1 && cleared.reports === 2, JSON.stringify(cleared));
  check('清理后索引还在', store.corpusStats().documents === 4);

  /* ---------------- HTTP 处理器 ---------------- */
  console.log('\n▶ HTTP 处理器');
  const handlers = createAiHandlers({
    store,
    getDocument: (id) => store.corpusDocuments({ withContent: true, withReplies: true, ids: [id] })[0] ?? null,
    currentUser: (ctx) => ctx.user ?? null,
    isAdmin: (ctx) => ctx.user?.role === 'admin',
    normalizeId: (id) => String(id),
    env,
  });
  const router = createAiRouter(handlers);
  /** 直接调处理器时，把抛出的错误按路由的规则收敛成响应，便于断言。 */
  const call = async (handler, ctx = {}) => {
    try {
      return await handler(ctx);
    } catch (error) {
      return toResponse(error);
    }
  };

  const statusRes = await router({ method: 'GET', pathname: '/api/ai/status' });
  check('GET status 无需登录', statusRes.status === 200 && statusRes.body.data.configured === true, JSON.stringify(statusRes.body));

  const anonAsk = await router({ method: 'POST', pathname: '/api/ai/ask', body: { question: '你好' } });
  check('未登录问答返回 401', anonAsk.status === 401 && anonAsk.body.error.code === 'unauthenticated', JSON.stringify(anonAsk.body));

  const unconfiguredHandlers = createAiHandlers({
    store,
    getDocument: (id) => store.corpusDocuments({ withContent: true, withReplies: true, ids: [id] })[0] ?? null,
    currentUser: (ctx) => ctx.user ?? null,
    isAdmin: (ctx) => ctx.user?.role === 'admin',
    env: {},
  });
  const noKey = await call(unconfiguredHandlers.analyzeDocument, { params: { id: '2' }, user: { id: 'u1' }, body: {} });
  check('未配置密钥 → 503 ai_not_configured', noKey.status === 503 && noKey.body.error.code === 'ai_not_configured', JSON.stringify(noKey.body));
  check('未配置不写脏缓存', store.reviewOf('2') === null);
  const noKeyCorpus = await call(unconfiguredHandlers.analyzeCorpus, { user: { id: 'u1', role: 'admin' }, body: {} });
  check('未配置时全库整理也返回 503', noKeyCorpus.status === 503, JSON.stringify(noKeyCorpus.body));

  const missing = await call(handlers.getReview, { params: { id: '404' } });
  check('不存在的文档 → 404', missing.status === 404);

  const memberBatch = await call(handlers.analyzePending, { user: { id: 'u1', role: 'member' }, body: {} });
  check('普通用户批量解读 → 403', memberBatch.status === 403, JSON.stringify(memberBatch.body));

  const analyzeOne = await call(handlers.analyzeDocument, { params: { id: '2' }, user: { id: 'u1' }, body: {} });
  check('解读单篇 → 200', analyzeOne.status === 200 && analyzeOne.body.data.review.category === '后端', JSON.stringify(analyzeOne.body).slice(0, 200));

  const batch = await call(handlers.analyzePending, { user: { id: 'u1', role: 'admin' }, body: { limit: 2 } });
  check('管理员批量解读 → 200', batch.status === 200 && batch.body.data.processed === 2, JSON.stringify(batch.body.data).slice(0, 200));
  check('批量返回剩余数量', typeof batch.body.data.remaining === 'number' && typeof batch.body.data.stats.pending === 'number');

  const corpusRes = await call(handlers.analyzeCorpus, { user: { id: 'u1', role: 'admin' }, body: {} });
  check('全库整理 → 200', corpusRes.status === 200 && corpusRes.body.data.topics >= 1, JSON.stringify(corpusRes.body).slice(0, 200));
  const corpusGet = await call(handlers.getCorpusReport, { user: { id: 'u1', role: 'admin' } });
  check('读回整理结果带 documents', corpusGet.status === 200 && corpusGet.body.data.documents.length >= 1, JSON.stringify(corpusGet.body.data).slice(0, 160));
  check('主题里带出文档对象', corpusGet.body.data.topics[0].documents.every((doc) => doc.id !== undefined));

  const askRes = await call(handlers.ask, { user: { id: 'u1' }, body: { question: '分页怎么优化', documentId: '1' } });
  check('单篇问答 → 200 且 scope 正确', askRes.status === 200 && askRes.body.data.scope === 'document', JSON.stringify(askRes.body).slice(0, 160));
  check('假引用被过滤', askRes.body.data.citations.every((c) => c.documentId !== 999999));
  const askCorpus = await call(handlers.ask, { user: { id: 'u1' }, body: { question: '有哪些内容' } });
  check('全库问答 → scope=corpus 且统计纳入篇数', askCorpus.body.data.scope === 'corpus' && askCorpus.body.data.included >= 1);

  const tooShort = await call(handlers.ask, { user: { id: 'u1' }, body: { question: 'x' } });
  check('过短问题 → 400', tooShort.status === 400);
  const tooLong = await call(handlers.ask, { user: { id: 'u1' }, body: { question: 'x'.repeat(501) } });
  check('过长问题 → 400', tooLong.status === 400);

  const cleared2 = await call(handlers.clearCache, { user: { id: 'u1', role: 'admin' } });
  check('清空缓存 → 200', cleared2.status === 200 && cleared2.body.data.cleared === true);

  // 上游整体故障时的部分失败语义
  mock.mode = 'http-500';
  const partial = await call(handlers.analyzePending, { user: { id: 'u1', role: 'admin' }, body: { limit: 2 } });
  check('上游故障时返回部分结果 + 502', partial.status === 502 && partial.partial === true && Array.isArray(partial.body.data?.results), JSON.stringify(partial.body).slice(0, 200));
  check('部分失败也记录了失败明细', partial.body.data.results.some((item) => item.status === 'failed'));
  mock.mode = 'ok';

  const unmatched = await router({ method: 'GET', pathname: '/api/ai/nope' });
  check('未匹配路由返回 null', unmatched === null);

  db.close();
} finally {
  server.close();
  await sleep(50);
}

console.log(`\n${'─'.repeat(46)}`);
console.log(`通过 ${passed} 项，失败 ${failures.length} 项`);
if (failures.length) {
  console.log('\n失败明细：');
  for (const item of failures) console.log(`  · ${item}`);
  process.exit(1);
}
