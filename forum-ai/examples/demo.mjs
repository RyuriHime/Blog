#!/usr/bin/env node
/**
 * 端到端演示：不需要真实密钥。
 *
 * 本脚本会起一个假的 OpenAI 兼容服务，然后依次跑：
 *   1) 单篇解读（分类 / 难度 / 摘要 / 标签 / 前置知识 / 推荐阅读）
 *   2) 全库整理（主题分组 + 推荐阅读路线）
 *   3) 单篇问答 与 全库问答
 *   4) SQLite 缓存层：批量待整理、缓存写入、过期判定
 * 并把结果写成 examples/demo-output.json 供下游查看真实数据结构。
 *
 *   node examples/demo.mjs
 */
import http from 'node:http';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  reviewDocument,
  reviewCorpus,
  answerQuestion,
  rankDocuments,
  createAiStore,
  createAiHandlers,
} from '../src/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'demo-output.json');

/* ---------------- 演示语料（中文，含交叉主题） ---------------- */

const DOCUMENTS = [
  {
    id: '1',
    title: '论坛版规与发帖指南',
    board: '站务公告',
    author: '站长',
    content: '发帖请写清背景、结论与复现步骤；技术问题请贴最小可复现示例。',
    replies: [{ author: 'alice', content: '收到，会照这个来' }],
    createdAt: Date.now() - 9 * 86400000,
    updatedAt: Date.now() - 9 * 86400000,
  },
  {
    id: '2',
    title: 'Node.js 24 内置 SQLite 上手实测：零依赖做全栈',
    board: '技术交流',
    author: 'Bob',
    content: 'node:sqlite 可以直接建表查询，省掉第三方依赖；配合内置 http 模块就能做一个完整后端。',
    replies: [
      { author: 'alice', content: '零依赖这点很香，部署省事' },
      { author: 'carol', content: '迁移工具怎么做？' },
    ],
    createdAt: Date.now() - 3 * 86400000,
    updatedAt: Date.now() - 3 * 86400000,
  },
  {
    id: '3',
    title: '求助：前端 SPA 用 hash 路由会不会影响 SEO？',
    board: '问答求助',
    author: 'Carol',
    content: '我们的站点用 hash 路由，搜索引擎基本抓不到内容，有什么办法兼顾？',
    replies: [{ author: 'Bob', content: '可以考虑预渲染或换成 history 路由' }],
    createdAt: Date.now() - 2 * 86400000,
    updatedAt: Date.now() - 2 * 86400000,
  },
  {
    id: '4',
    title: '分享：我整理的 12 个 Markdown 写作小技巧',
    board: '分享创造',
    author: 'alice',
    content: '一行一句、善用列表与引用、代码块标注语言，长文加目录。',
    replies: [],
    createdAt: Date.now() - 5 * 86400000,
    updatedAt: Date.now() - 5 * 86400000,
  },
  {
    id: '5',
    title: 'SQLite 分页查询在大数据量下变慢，怎么优化？',
    board: '问答求助',
    author: 'Bob',
    content: 'LIMIT OFFSET 在深分页时很慢，是否该换成基于游标的分页？索引要怎么建？',
    replies: [{ author: 'carol', content: '我们换成 keyset 分页后快了很多' }],
    createdAt: Date.now() - 86400000,
    updatedAt: Date.now() - 86400000,
  },
];

const SEED = DOCUMENTS[1]; // 以「Node 零依赖全栈」为主题

/* ---------------- 假 AI 服务 ---------------- */

const mock = { calls: [] };

function reply(userText) {
  const ids = [...new Set([...userText.matchAll(/\[#([\w.-]+)\]/g)].map((m) => m[1]))];
  const wikiIds = [...new Set([...userText.matchAll(/\[W#([\w.-]+)\]/g)].map((m) => m[1]))];
  if (userText.includes('全库材料')) {
    return {
      summary: '这批文档围绕三条线展开：零依赖的 Node 全栈实践、SQLite 的查询与分页优化、以及前端路由与写作规范这类工程细节。',
      topics: [
        {
          name: 'Node 零依赖全栈',
          summary: '用内置模块替代第三方框架与驱动',
          difficulty: '进阶',
          documentIds: ids.filter((id) => ['2', '5'].includes(id)),
          prereq: ['JavaScript 基础', 'SQL 基本语法'],
          order: 1,
        },
        {
          name: '前端工程与 SEO',
          summary: 'SPA 路由选型与可被检索的取舍',
          difficulty: '进阶',
          documentIds: ids.filter((id) => ['3'].includes(id)),
          prereq: ['HTTP 基础'],
          order: 2,
        },
        {
          name: '内容与协作规范',
          summary: '写作技巧与社区约定',
          difficulty: '入门',
          documentIds: ids.filter((id) => ['1', '4'].includes(id)),
          prereq: [],
          order: 3,
        },
        // 故意给一个材料里不存在的编号，验证服务端会把它过滤掉
        { name: '不存在的主题', summary: '编号是编造的', difficulty: '入门', documentIds: ['999999'], prereq: [], order: 4 },
      ],
      readingPath: [
        { documentId: '1', title: '先读版规', reason: '了解社区约定', level: '入门' },
        { documentId: '4', title: '写清楚再说', reason: '表达是协作前提', level: '入门' },
        { documentId: '2', title: 'Node 内置 SQLite', reason: '主线起点', level: '进阶' },
        { documentId: '5', title: '分页优化', reason: '承接上一步深入', level: '深入' },
        { documentId: '999999', title: '编造的文档', reason: '应被过滤', level: '入门' },
      ],
    };
  }
  if (userText.includes('本篇材料')) {
    return {
      category: '数据库',
      difficulty: '进阶',
      summary: '实测 Node.js 内置 SQLite，用零依赖方式完成建表与查询，说明什么场景下不必引入第三方驱动。',
      tags: ['Node.js', 'SQLite', '零依赖', '全栈'],
      prereq: [
        { name: 'JavaScript 基础', why: '读懂示例代码', level: '入门' },
        { name: 'SQL 基本语法', why: '看懂建表与查询', level: '入门' },
      ],
      recommend: [
        { documentId: ids.find((id) => id !== '2') ?? null, title: 'SQLite 分页优化', reason: '同主题的性能侧', relation: '延伸' },
        // 没编号的纯标题：验证「编造的篇目」整条被丢掉
        { documentId: null, title: '（编造的指南）', reason: '验证幻觉过滤', relation: '对比' },
        { wikiId: wikiIds[0], title: '线段树', reason: '站内 OI Wiki 词条', relation: '先读' },
      ],
    };
  }
  return {
    answer: '材料里 [#2] 说明 node:sqlite 可以省掉第三方驱动，[#5] 则讨论了深分页变慢的问题，建议先补 SQL 索引基础再看分页优化。',
    citations: [
      { documentId: ids[0] ?? '2', title: 'Node.js 24 内置 SQLite 上手实测', quote: '省掉第三方依赖' },
      { documentId: '999999', title: '编造的引用', quote: '应被过滤' },
    ],
    notes: ['先把 SQL 索引补上，再读分页那篇收益最大。'],
    confidence: 'high',
  };
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    const parsed = JSON.parse(body || '{}');
    mock.calls.push(parsed);
    const userText = String(parsed?.messages?.[1]?.content ?? '');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        model: 'demo-mock',
        choices: [{ message: { content: JSON.stringify(reply(userText)) } }],
        usage: { prompt_tokens: 800 + userText.length, completion_tokens: 200 },
      }),
    );
  });
});

const PORT = Number(process.env.DEMO_PORT || 3681);
await new Promise((done) => server.listen(PORT, '127.0.0.1', done));
const env = { AI_API_KEY: 'demo-key', AI_BASE_URL: `http://127.0.0.1:${PORT}/v1`, AI_MODEL: 'demo-mock' };

try {
  console.log('▶ 环境:', JSON.stringify({ ...env, AI_API_KEY: '(hidden)' }));

  console.log('\n▶ 1. 单篇解读');
  const DEMO_WIKI = [
    { id: 501, title: '线段树', station: 'OI Wiki', category: '数据结构' },
    { id: 502, title: 'string', station: 'OI Wiki', category: 'STL' },
  ];
  const single = await reviewDocument(SEED, DOCUMENTS.filter((doc) => doc.id !== SEED.id), {
    chatOptions: { env },
    wikiPages: DEMO_WIKI,
  });
  console.log(`  分类=${single.review.category} 难度=${single.review.difficulty} 标签=${single.review.tags.join('/')}`);
  console.log(`  前置知识: ${single.review.prereq.map((item) => item.name).join('、')}`);
  console.log(
    `  推荐阅读: ${single.review.recommend
      .map((item) => `${item.title}${item.documentId ? `(#${item.documentId})` : item.wikiId ? `(wiki #${item.wikiId})` : '(无落点)'}`)
      .join('、')}`,
  );

  console.log('\n▶ 2. 全库整理');
  const corpus = await reviewCorpus(DOCUMENTS, { chatOptions: { env } });
  console.log(`  主题 ${corpus.report.topics.length} 组，阅读路线 ${corpus.report.readingPath.length} 步`);
  for (const topic of corpus.report.topics) {
    console.log(`   · ${topic.name}（${topic.difficulty}）文档 ${topic.documentIds.map((id) => `#${id}`).join(',')}`);
  }
  console.log(`  被过滤掉的编造条目: ${JSON.stringify(corpus.report.dropped)}`);

  console.log('\n▶ 3. 问答');
  const askOne = await answerQuestion('这个方案省掉了什么？', [SEED], { scope: 'document', chatOptions: { env } });
  const askAll = await answerQuestion('入门应该先读哪几篇？', DOCUMENTS, { scope: 'corpus', chatOptions: { env } });
  console.log(`  单篇: ${askOne.answer.text.slice(0, 60)}… 引用 ${askOne.answer.citations.length} 条（丢弃 ${askOne.answer.droppedCitations} 条编造）`);
  console.log(`  全库: 纳入 ${askAll.included} 篇，引用 ${askAll.answer.citations.map((c) => `#${c.documentId}`).join(',')}`);

  console.log('\n▶ 4. 检索排序');
  const ranked = rankDocuments('SQLite 分页怎么优化', DOCUMENTS);
  console.log(`  ${ranked.slice(0, 3).map((item) => `#${item.doc.id}(${item.score.toFixed(1)})`).join(' > ')}`);

  console.log('\n▶ 5. SQLite 缓存层');
  const db = new DatabaseSync(':memory:');
  const store = createAiStore({ db, documentSource: () => DOCUMENTS, tablePrefix: 'ai_' });
  store.syncCorpus();
  console.log(`  索引: ${JSON.stringify(store.corpusStats())}`);
  console.log(`  待整理: ${store.countPending()} 篇`);

  const handlers = createAiHandlers({
    store,
    getDocument: (id) => store.corpusDocuments({ withContent: true, withReplies: true, ids: [id] })[0] ?? null,
    currentUser: (ctx) => ctx.user ?? null,
    isAdmin: (ctx) => ctx.user?.role === 'admin',
    env,
  });

  const batch = await handlers.analyzePending({ user: { id: 'admin', role: 'admin' }, body: { limit: 3 } });
  console.log(`  批量解读: processed=${batch.body.data.processed} failed=${batch.body.data.failed} remaining=${batch.body.data.remaining}`);
  const rest = await handlers.analyzePending({ user: { id: 'admin', role: 'admin' }, body: { limit: 10 } });
  console.log(`  再跑一批: processed=${rest.body.data.processed} pending=${rest.body.data.stats.pending}`);

  const report = await handlers.analyzeCorpus({ user: { id: 'admin', role: 'admin' }, body: {} });
  console.log(`  全库整理入库: topics=${report.body.data.topics} readingPath=${report.body.data.readingPath}`);
  const view = await handlers.getCorpusReport({ user: { id: 'admin', role: 'admin' } });
  console.log(`  读回: documents=${view.body.data.documents.length} stale=${view.body.data.stale}`);

  const ask = await handlers.ask({ user: { id: 'alice' }, body: { question: '分页怎么优化？' } });
  console.log(`  问答: scope=${ask.body.data.scope} included=${ask.body.data.included} citations=${ask.body.data.citations.length}`);

  const noKey = await createAiHandlers({
    store,
    getDocument: () => DOCUMENTS[0],
    currentUser: (ctx) => ctx.user ?? null,
    env: {},
  }).analyzeDocument({ params: { id: '1' }, user: { id: 'a' }, body: {} });
  console.log(`  未配置降级: HTTP ${noKey.status} ${noKey.body.error.code}`);

  const artifact = {
    generatedAt: new Date().toISOString(),
    note: '本文件由 examples/demo.mjs 用「假的 OpenAI 兼容服务」生成，用于展示真实数据结构；换成真实模型后字段完全一致。',
    environment: { ...env, AI_API_KEY: '(demo)' },
    corpus: { count: DOCUMENTS.length, documents: DOCUMENTS.map((doc) => ({ id: doc.id, title: doc.title, board: doc.board })) },
    capabilities: {
      reviewDocument: single,
      reviewCorpus: corpus,
      askDocument: askOne,
      askCorpus: askAll,
    },
    ranking: ranked.map((item) => ({ documentId: item.doc.id, score: Number(item.score.toFixed(3)) })),
    storage: {
      corpus: store.corpusStats(),
      reviewStats: store.reviewStats(),
      pending: store.countPending(),
      corpusHash: store.corpusHash(),
      report: store.latestReport(),
    },
    http: {
      lastBatch: batch.body.data,
      corpusView: {
        stale: view.body.data.stale,
        stats: view.body.data.stats,
        topics: view.body.data.topics,
        readingPath: view.body.data.readingPath,
      },
      ask: ask.body.data,
      notConfigured: { status: noKey.status, body: noKey.body },
    },
    requests: {
      count: mock.calls.length,
      models: [...new Set(mock.calls.map((call) => call.model))],
      hasJsonResponseFormat: mock.calls.every((call) => call.response_format?.type === 'json_object'),
    },
  };

  await writeFile(OUT, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  console.log(`\n产物已写出: ${OUT}`);
  db.close();
} finally {
  server.close();
}
