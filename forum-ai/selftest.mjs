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
  aiConfig,
  aiStatus,
  chat,
  extractJson,
  normalizeReview,
  normalizeSiteReport,
  normalizeAnswer,
  buildMaterial,
  buildIndexLines,
  splitByBudget,
  reviewDocument,
  reviewCorpus,
  answerQuestion,
  rankDocuments,
  selectForQuestion,
  questionTerms,
  extractHeadings,
  excerptAroundFocus,
  createAiStore,
  createAiHandlers,
  createAiRouter,
  toResponse,
  rawOutputHead,
  isTruncated,
  AI_ERROR_STATUS,
} from './src/index.mjs';
import { ASK_SYSTEM } from './src/prompts.mjs';
import { repairJsonControlChars, repairJsonQuotes } from './src/parse.mjs';

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

const mock = { calls: [], mode: 'ok', emptyTimes: 0, failPart: null, truncateOverChars: 0, truncateJsonOverChars: 0, truncateIndex: false, truncateIndexJson: false, truncatePartOver: 0, truncatePartJsonOver: 0, failMerge: false };

function mockReply(userText) {
  const ids = [...userText.matchAll(/\[#([\w.-]+)\]/g)].map((m) => m[1]);
  const wikiIds = [...userText.matchAll(/\[W#([\w.-]+)\]/g)].map((m) => m[1]);
  if (mock.mode === 'bad-json') return '抱歉，我无法回答。';
  if (mock.mode === 'fenced') {
    return null; // 由调用方包成 ```json
  }
  if (userText.includes('【全库目录 · 第')) {
    return {
      summary: '这一部分的小结。',
      topics: [{ name: `分支${ids[0] ?? 1}`, summary: '分组', difficulty: '入门', documentIds: ids.slice(0, 3), prereq: [], order: 1 }],
    };
  }
  if (userText.includes('全库材料') || userText.includes('【全库概况】')) {
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
    const userText = String(parsed?.messages?.at(-1)?.content ?? '');
    const partCount = Number(/本部分 (\d+) 篇/.exec(userText)?.[1] ?? 0);
    const truncate = () => {
      // 输出撞上 max_tokens：正文为空、finish_reason=length、生成量正好等于预算（线上 554 篇时就是这样）
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          model: 'mock-model',
          choices: [{ message: { content: '' }, finish_reason: 'length' }],
          usage: { prompt_tokens: 11, completion_tokens: 3000 },
        }),
      );
    };
    const partialJson = () => {
      // 也是撞上 max_tokens，但这次模型已经写到了半截 JSON：解析不出来，finish_reason 仍是 length
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          model: 'mock-model',
          choices: [{ message: { content: '{"summary":"被截断的概述","topics":[{"name":"半截' }, finish_reason: 'length' }],
          usage: { prompt_tokens: 11, completion_tokens: 3000 },
        }),
      );
    };
    if (mock.truncateOverChars && userText.length > mock.truncateOverChars) {
      truncate();
      return;
    }
    if (mock.truncateJsonOverChars && userText.length > mock.truncateJsonOverChars) {
      partialJson();
      return;
    }
    if (mock.truncateIndex && userText.includes('【全库材料】')) {
      truncate();
      return;
    }
    if (mock.truncateIndexJson && userText.includes('【全库材料】')) {
      partialJson();
      return;
    }
    if (mock.truncatePartOver && partCount > mock.truncatePartOver) {
      // 一次问的篇数太多 → 模型想不完，被输出预算截断
      truncate();
      return;
    }
    if (mock.truncatePartJsonOver && partCount > mock.truncatePartJsonOver) {
      partialJson();
      return;
    }
    if (mock.failMerge && userText.includes('【全库概况】')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: 'mock-model', choices: [{ message: { content: '这张地图我拼不出来。' } }], usage: { prompt_tokens: 11, completion_tokens: 7 } }));
      return;
    }
    if (mock.emptyTimes > 0) {
      // 上游偶尔会 200 但内容为空 —— 这正是线上全站总览失败的样子
      mock.emptyTimes -= 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: 'mock-model', choices: [{ message: { content: '' }, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 0 } }));
      return;
    }
    if (mock.failPart && userText.includes(`第 ${mock.failPart}/`)) {
      // 让指定的那一块目录整理不出 JSON
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: 'mock-model', choices: [{ message: { content: '这批目录我看不出来。' } }], usage: { prompt_tokens: 11, completion_tokens: 7 } }));
      return;
    }
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
  check('字符串里的裸换行也能解析', extractJson('{"answer":"第一行\n第二行"}')?.answer === '第一行\n第二行');
  check('代码块里的多个裸换行也能解析', extractJson('{"answer":"看这段：\n```python\nprint(1)\n```"}')?.answer?.includes('```python') === true);
  check('字符串里的裸制表符也能解析', extractJson('{"a":"x\ty"}')?.a === 'x\ty');
  check('已经转义过的换行不受影响', extractJson('{"a":"x\\ny"}')?.a === 'x\ny');
  check('转义只发生在字符串内部', repairJsonControlChars('{"a":"x\ny"}\n') === '{"a":"x\\ny"}\n', JSON.stringify(repairJsonControlChars('{"a":"x\ny"}\n')));
  check('字符串里的孤引号也能解析', extractJson('{"answer":"print("hi")"}')?.answer === 'print("hi")');
  check('孤引号修复不碰正常的字段分隔', extractJson('{"a":"x","b":"y"}')?.b === 'y');
  check('已转义的引号不受影响', extractJson('{"a":"他说\\"早\\""}')?.a === '他说"早"');
  check('孤引号修复是最后手段（合法的先走直解析）', repairJsonQuotes('{"a":"x","b":"y"}') === '{"a":"x","b":"y"}', repairJsonQuotes('{"a":"x","b":"y"}'));

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

  // 命中词在 3000 字之后时，从开头截等于没喂；要从命中处截，并报出命中的小标题。
  const longDoc = {
    id: '9',
    title: '长词条',
    content: `${'前面都是无关的铺垫。'.repeat(200)}\n## DFS 的实现\n递归写法与显式栈写法。`,
  };
  const focused = buildMaterial([longDoc], { charLimit: 100000, contentPerDoc: 300, focus: ['dfs'] });
  check('正文从命中处截（不再只看开头）', focused.text.includes('## DFS 的实现'), focused.text.slice(0, 120));
  check('截出来的片段带省略号', focused.text.includes('…'));
  check('材料里报出命中的小标题', focused.text.includes('相关小节：DFS 的实现'), focused.text);
  const notFocused = buildMaterial([longDoc], { charLimit: 100000, contentPerDoc: 300 });
  check('不给 focus 时行为不变（仍从头截）', notFocused.text.includes('## DFS 的实现') === false);
  check('excerptAroundFocus 命中词不在开头时从中间取', excerptAroundFocus(`开头${'填充'.repeat(400)}命中词结尾`, ['命中词'], 200).includes('命中词'));


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
  check(
    '整理全站没关思考模式（只有问答那条路才关）',
    mock.calls.at(-1)?.body?.thinking === undefined,
    JSON.stringify(mock.calls.at(-1)?.body?.thinking),
  );

  const asked = await answerQuestion('分页怎么优化？', DOCS.slice(0, 1), { scope: 'document', chatOptions: { env } });
  check('问答返回答案与引用', asked.answer.text.length > 0 && asked.answer.citations.length === 1, JSON.stringify(asked.answer.citations));
  check('问答保留备注与置信度', asked.answer.notes.length === 1 && asked.answer.confidence === 'high');

  /* ---------------- 问答的输出预算与截断自适应（LOCAL PATCH L） ---------------- */
  console.log('\n▶ 问答预算与截断自适应');
  mock.calls.length = 0;
  await answerQuestion('分页怎么优化？', DOCS.slice(0, 2), { scope: 'corpus', chatOptions: { env } });
  check('问答默认输出预算放宽到 4000（上游写死 1200，宽问题必被截断）', mock.calls.at(-1)?.body?.max_tokens === 4000, String(mock.calls.at(-1)?.body?.max_tokens));
  check(
    '问答请求显式关掉思考模式（默认开着，思维链又慢又吃预算）',
    mock.calls.at(-1)?.body?.thinking?.type === 'disabled',
    JSON.stringify(mock.calls.at(-1)?.body?.thinking),
  );
  mock.calls.length = 0;
  await answerQuestion('分页怎么优化？', DOCS.slice(0, 2), { scope: 'corpus', chatOptions: { env: { ...env, AI_ASK_MAX_TOKENS: '5000' } } });
  check('预算可以用 AI_ASK_MAX_TOKENS 覆盖', mock.calls.at(-1)?.body?.max_tokens === 5000, String(mock.calls.at(-1)?.body?.max_tokens));
  check('新变量没有混进 /api/site 的 ai 形状里', !aiStatus(env).envKeys.includes('AI_ASK_MAX_TOKENS'), JSON.stringify(aiStatus(env).envKeys));
  // 提示词从没要求过结构：线上实测一次 1540 字的回答里换行是 0 个，模型把整篇答案摊成一行。
  check(
    '提示词要求 answer 自带结构（分段 / 小标题单独一行 / - 列表）',
    ASK_SYSTEM.includes('answer 的排版') && ASK_SYSTEM.includes('小节标题单独占一行') && ASK_SYSTEM.includes('"- " 开头的列表'),
    '',
  );

  // 材料一多就被截断：6 篇长文档 > 6000 字（截断），缩到三分之一后 < 6000 字（答得完）
  const bigAskDocs = Array.from({ length: 6 }, (_, index) => ({
    id: `ask-${index + 1}`,
    title: `长文档 ${index + 1}`,
    content: `正文哨兵${index + 1} `.repeat(200),
    board: '技术',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }));
  mock.calls.length = 0;
  mock.truncateOverChars = 6000;
  const retried = await answerQuestion('这些文档讲什么？', bigAskDocs, { scope: 'corpus', chatOptions: { env } });
  check('被截断时自动少喂一部分再问一次', mock.calls.length === 2 && retried.answer.text.length > 0, `calls=${mock.calls.length}`);
  check('第二次问的预算翻倍（封顶 8000）', mock.calls.at(-1)?.body?.max_tokens === 8000, String(mock.calls.at(-1)?.body?.max_tokens));
  check(
    '第二次问的少喂到三分之一（不是一半）',
    mock.calls.at(-1)?.body?.messages?.at(-1)?.content?.includes('长文档 2') === true &&
      mock.calls.at(-1)?.body?.messages?.at(-1)?.content?.includes('长文档 3') === false,
    '',
  );
  check('第二次问的明确要求短答案', String(mock.calls.at(-1)?.body?.messages?.at(-1)?.content ?? '').includes('【上一次】'), '');
  check(
    '第二次的材料确实变短了',
    String(mock.calls.at(-1)?.body?.messages?.at(-1)?.content ?? '').length < String(mock.calls[0]?.body?.messages?.at(-1)?.content ?? '').length,
    `${String(mock.calls[0]?.body?.messages?.at(-1)?.content ?? '').length} → ${String(mock.calls.at(-1)?.body?.messages?.at(-1)?.content ?? '').length}`,
  );

  // 全站问答：每篇只喂命中处的一段，材料整体压在 12000 字以内，并带上命中的小标题
  const focusingDocs = Array.from({ length: 5 }, (_, index) => ({
    id: `focus-${index + 1}`,
    title: `词条 ${index + 1}`,
    content: `## DFS 的实现 ${index + 1}\n${'铺垫内容。'.repeat(1200)}`,
  }));
  mock.calls.length = 0;
  await answerQuestion('dfs 怎么实现', focusingDocs, { scope: 'corpus', chatOptions: { env } });
  const focusPrompt = String(mock.calls.at(-1)?.body?.messages?.at(-1)?.content ?? '');
  check('全站问答的材料压在 12000 字以内', focusPrompt.length <= 12000 + 2000, String(focusPrompt.length));
  check('材料里带上命中的小标题（不用模型自己找）', focusPrompt.includes('相关小节：DFS 的实现 1'), focusPrompt.slice(0, 160));

  mock.calls.length = 0;
  mock.truncateOverChars = 200; // 砍半后仍然超预算：两次都答不完
  let truncatedAskError = null;
  try {
    await answerQuestion('这些文档讲什么？', bigAskDocs, { scope: 'corpus', chatOptions: { env } });
  } catch (error) {
    truncatedAskError = error;
  }
  check('两次都答不完 → ai_answer_truncated（不再假装是「服务器开小差」）', truncatedAskError?.code === 'ai_answer_truncated' && mock.calls.length === 2, `${truncatedAskError?.code}/calls=${mock.calls.length}`);
  check('这个错误码被宿主映射成 503', AI_ERROR_STATUS.ai_answer_truncated === 503, String(AI_ERROR_STATUS.ai_answer_truncated));

  mock.calls.length = 0;
  let singleTruncatedError = null;
  try {
    await answerQuestion('这篇讲什么？', [bigAskDocs[0]], { scope: 'document', chatOptions: { env } });
  } catch (error) {
    singleTruncatedError = error;
  }
  check('只有一篇材料时不重复问（砍半没意义，照原样抛错）', singleTruncatedError?.code === 'ai_empty_response' && mock.calls.length === 1, `${singleTruncatedError?.code}/calls=${mock.calls.length}`);
  mock.truncateOverChars = 0;

  /* ---------------- 上游抖动：空响应与重试 ---------------- */
  console.log('\n▶ 上游抖动与重试');
  const retryEnv = { ...env, AI_RETRY_DELAY_MS: '0' };
  check('默认重试 2 次（共 3 次请求）', aiConfig(env).retries === 2, String(aiConfig(env).retries));
  check('重试次数可以由环境变量改', aiConfig({ ...env, AI_RETRIES: '0' }).retries === 0);
  check('重试间隔默认 600ms，也能改', aiConfig(env).retryDelayMs === 600 && aiConfig({ ...env, AI_RETRY_DELAY_MS: '50' }).retryDelayMs === 50);
  check('状态里列出重试相关的环境变量', aiStatus(env).envKeys.includes('AI_RETRIES') && aiStatus(env).envKeys.includes('AI_RETRY_DELAY_MS'));
  check('状态里不新增顶层字段（/api/site 的形状是冻的）', JSON.stringify(Object.keys(aiStatus(env))) === JSON.stringify(['configured', 'model', 'baseUrl', 'envKeys']), JSON.stringify(Object.keys(aiStatus(env))));

  mock.calls.length = 0;
  mock.emptyTimes = 2;
  const recovered = await chat([{ role: 'user', content: 'hi' }], { env: retryEnv });
  check('空响应会自动重试，最终拿到内容', typeof recovered.text === 'string' && recovered.text.length > 0 && mock.calls.length === 3, `calls=${mock.calls.length}`);

  mock.calls.length = 0;
  mock.emptyTimes = 99;
  let emptyError = null;
  try {
    await chat([{ role: 'user', content: 'hi' }], { env: retryEnv });
  } catch (error) {
    emptyError = error;
  }
  check('一直空响应 → 抛 ai_empty_response', emptyError?.code === 'ai_empty_response', emptyError?.code);
  check('重试到上限就不再打上游', mock.calls.length === 3, `calls=${mock.calls.length}`);
  check(
    '空响应错误带上现场（finish_reason / usage）',
    typeof emptyError?.details?.finishReason === 'string' && Number(emptyError?.details?.usage?.prompt) === 11,
    JSON.stringify(emptyError?.details),
  );

  mock.calls.length = 0;
  mock.emptyTimes = 1;
  let noRetryError = null;
  try {
    await chat([{ role: 'user', content: 'hi' }], { env: { ...retryEnv, AI_RETRIES: '0' } });
  } catch (error) {
    noRetryError = error;
  }
  check('AI_RETRIES=0 时一次就放弃', noRetryError?.code === 'ai_empty_response' && mock.calls.length === 1, `calls=${mock.calls.length}`);

  mock.mode = 'http-401';
  mock.calls.length = 0;
  let authError = null;
  try {
    await chat([{ role: 'user', content: 'hi' }], { env: retryEnv });
  } catch (error) {
    authError = error;
  }
  check('密钥错这类错误不重试', authError?.code === 'ai_unauthorized' && mock.calls.length === 1, `calls=${mock.calls.length} code=${authError?.code}`);

  mock.mode = 'http-429';
  mock.calls.length = 0;
  let limitedError = null;
  try {
    await chat([{ role: 'user', content: 'hi' }], { env: retryEnv });
  } catch (error) {
    limitedError = error;
  }
  check('限流会被重试', limitedError?.code === 'ai_rate_limited' && mock.calls.length === 3, `calls=${mock.calls.length}`);
  mock.mode = 'ok';

  /* ---------------- 全库整理的分级降级 ---------------- */
  console.log('\n▶ 全库整理的分级降级');
  const oneLine = buildIndexLines([{ id: 7, title: '甲', category: '技术', difficulty: '入门', board: '技术', replyCount: 3 }]);
  check('目录行只有编号 + 标题 + 归类', oneLine[0] === '[#7] 《甲》 分类=技术 难度=入门 板块=技术 回复=3', oneLine[0]);
  check('目录行不带正文', buildIndexLines(DOCS)[0].includes('零依赖存储') === false, buildIndexLines(DOCS)[0]);
  check(
    'splitByBudget 按预算切块',
    JSON.stringify(splitByBudget(['aaa', 'bbb', 'ccc'], 5)) === '[["aaa"],["bbb"],["ccc"]]' &&
      JSON.stringify(splitByBudget(['aaa', 'bbb'], 100)) === '[["aaa","bbb"]]',
    JSON.stringify(splitByBudget(['aaa', 'bbb', 'ccc'], 5)),
  );

  mock.calls.length = 0;
  const smallCorpus = await reviewCorpus(DOCS, { chatOptions: { env: retryEnv }, charLimit: 100000 });
  check('小站：一次问完（mode=material）', smallCorpus.mode === 'material' && mock.calls.length === 1, `${smallCorpus.mode}/${mock.calls.length}`);
  check('小站报告里记下模式与篇数', smallCorpus.included === DOCS.length && smallCorpus.truncated === false, JSON.stringify({ included: smallCorpus.included }));

  const bigDocs = Array.from({ length: 40 }, (_, index) => ({
    id: String(index + 1),
    title: `文档 ${index + 1}`,
    content: `正文哨兵${index + 1} `.repeat(200),
    board: '技术',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }));

  mock.calls.length = 0;
  const indexed = await reviewCorpus(bigDocs, { chatOptions: { env: retryEnv }, charLimit: 24000 });
  const indexedText = String(mock.calls[0]?.body?.messages?.[1]?.content ?? '');
  check('大站：正文塞不下时改成只发目录（mode=index）', indexed.mode === 'index' && mock.calls.length === 1, `${indexed.mode}/${mock.calls.length}`);
  check('目录里不再出现正文（这就是当初空响应的根因）', indexedText.includes('正文哨兵') === false, `len=${indexedText.length}`);
  check('目录把每一篇都列上了', indexedText.includes('[#40]') && indexedText.includes('《文档 40》'));
  check('目录模式下仍给出主题与阅读路线', indexed.report.topics.length > 0 && indexed.included === 40, JSON.stringify(indexed.report.topics.map((topic) => topic.name)));

  mock.calls.length = 0;
  const chunked = await reviewCorpus(bigDocs, { chatOptions: { env: retryEnv }, charLimit: 600, chunkChars: 400 });
  const lastPrompt = String(mock.calls.at(-1)?.body?.messages?.[1]?.content ?? '');
  check('超大站：目录也塞不下时分块整理（mode=chunked）', chunked.mode === 'chunked' && chunked.chunks > 1, `${chunked.mode}/${chunked.chunks}`);
  check('最后一定有一次归并', lastPrompt.includes('【全库概况】'), lastPrompt.slice(0, 40));
  check('分块后 token 逐块累加', chunked.usage.prompt === 11 * (chunked.chunks + 1), `prompt=${chunked.usage.prompt} chunks=${chunked.chunks}`);
  check('归并后的地图有主题', chunked.report.topics.length > 0 && chunked.failures.length === 0, JSON.stringify(chunked.report.topics.map((topic) => topic.name)));

  mock.calls.length = 0;
  mock.failPart = 2;
  const partialCorpus = await reviewCorpus(bigDocs, { chatOptions: { env: retryEnv }, charLimit: 600, chunkChars: 400 });
  mock.failPart = null;
  check('某一块失败也能出地图', partialCorpus.mode === 'chunked' && partialCorpus.report.topics.length > 0, JSON.stringify(partialCorpus.report.topics.map((topic) => topic.name)));
  check(
    '失败的那一块记在 failures 里',
    partialCorpus.failures.length === 1 && partialCorpus.failures[0]?.part === 2 && typeof partialCorpus.failures[0]?.error === 'string',
    JSON.stringify(partialCorpus.failures),
  );

  /* ---------------- 输出被截断（finish_reason=length） ---------------- */
  console.log('\n▶ 输出被截断（max_tokens 不够，不是上游抖动）');
  mock.calls.length = 0;
  mock.truncateOverChars = 10;
  let truncatedError = null;
  try {
    await chat([{ role: 'user', content: '这一句足够长，会被假服务判成截断' }], { env: retryEnv });
  } catch (error) {
    truncatedError = error;
  }
  check('截断报的是 ai_empty_response', truncatedError?.code === 'ai_empty_response', truncatedError?.code);
  check('截断不当成抖动：一次就放弃，不浪费重试', mock.calls.length === 1, `calls=${mock.calls.length}`);
  check('截断现场带上 finish_reason=length 与生成量', truncatedError?.details?.finishReason === 'length' && Number(truncatedError?.details?.usage?.completion) === 3000, JSON.stringify(truncatedError?.details));
  check(
    'isTruncated 只认 finish_reason=length',
    isTruncated(truncatedError) === true && isTruncated(new AiError('ai_empty_response', '空', { finishReason: 'stop' })) === false,
    JSON.stringify({ truncated: isTruncated(truncatedError) }),
  );
  mock.truncateOverChars = 0;

  // 目录一次问不完 → 自动落到分块（而不是整页失败）
  mock.calls.length = 0;
  mock.truncateIndex = true;
  const overlongIndex = await reviewCorpus(bigDocs, { chatOptions: { env: retryEnv }, charLimit: 24000, chunkChars: 400 });
  mock.truncateIndex = false;
  check('目录被截断时自动改走分块（mode=chunked）', overlongIndex.mode === 'chunked' && overlongIndex.chunks > 1, `${overlongIndex.mode}/${overlongIndex.chunks}`);
  check('地图类调用的生成预算给到 6000', mock.calls[0]?.body?.max_tokens === 6000, String(mock.calls[0]?.body?.max_tokens));
  check('落到分块后照样出地图', overlongIndex.report.topics.length > 0 && overlongIndex.failures.length === 0, JSON.stringify(overlongIndex.failures));

  // 块本身被截断 → 对半切开再问，直到问得完（问的篇数越少，越问得完）
  mock.calls.length = 0;
  mock.truncatePartOver = 12;
  const halved = await reviewCorpus(bigDocs, { chatOptions: { env: retryEnv }, charLimit: 600, chunkChars: 400 });
  mock.truncatePartOver = 0;
  check('块被截断时对半切开（比块数多问了若干次）', halved.mode === 'chunked' && mock.calls.length > halved.chunks + 1, `calls=${mock.calls.length} chunks=${halved.chunks}`);
  check('切开之后每一片都问得完（没有失败块）', halved.failures.length === 0, JSON.stringify(halved.failures));
  check('对半切之后地图仍是完整的', halved.report.topics.length > 0, JSON.stringify(halved.report.topics.map((topic) => topic.name)));

  // 归并失败 → 用各块草案兜底，别存一份空地图
  mock.calls.length = 0;
  mock.failMerge = true;
  const draftsFallback = await reviewCorpus(bigDocs, { chatOptions: { env: retryEnv }, charLimit: 600, chunkChars: 400 });
  mock.failMerge = false;
  check('归并失败时用各块草案兜底，地图仍有主题', draftsFallback.report.topics.length > 0, JSON.stringify(draftsFallback.report.topics.map((topic) => topic.name)));
  check('兜底时把归并失败记进 failures', draftsFallback.failures.some((failure) => failure.part === 'merge') === true, JSON.stringify(draftsFallback.failures));
  check('兜底也给出概述文本', String(draftsFallback.report.summary ?? '').length > 0, draftsFallback.report.summary);

  // 半截 JSON：也是被 max_tokens 截断，只是这次模型已经写了一半（线上全站总览出现过这种）
  mock.calls.length = 0;
  mock.truncateJsonOverChars = 10;
  let halfJsonError = null;
  try {
    await reviewDocument(DOCS[0], [], { chatOptions: { env: retryEnv } });
  } catch (error) {
    halfJsonError = error;
  }
  mock.truncateJsonOverChars = 0;
  check(
    '半截 JSON 认得出是截断（ai_bad_json + finish_reason=length）',
    halfJsonError?.code === 'ai_bad_json' && halfJsonError?.details?.finishReason === 'length' && isTruncated(halfJsonError) === true,
    JSON.stringify({ code: halfJsonError?.code, finishReason: halfJsonError?.details?.finishReason, truncated: isTruncated(halfJsonError) }),
  );
  check('半截 JSON 不重问第二遍（同样预算还是半截）', mock.calls.length === 1, `calls=${mock.calls.length}`);
  check('半截 JSON 现场留着模型原文', typeof halfJsonError?.details?.rawOutput === 'string' && halfJsonError.details.rawOutput.length > 0, String(halfJsonError?.details?.rawOutput).slice(0, 40));

  // 目录问成半截 JSON → 也落到分块
  mock.calls.length = 0;
  mock.truncateIndexJson = true;
  const halfIndex = await reviewCorpus(bigDocs, { chatOptions: { env: retryEnv }, charLimit: 24000, chunkChars: 400 });
  mock.truncateIndexJson = false;
  check('目录问成半截 JSON 时也改走分块', halfIndex.mode === 'chunked' && halfIndex.failures.length === 0 && halfIndex.report.topics.length > 0, `${halfIndex.mode}/${halfIndex.failures.length}`);

  // 某一块问成半截 JSON → 也对半切开
  mock.calls.length = 0;
  mock.truncatePartJsonOver = 12;
  const halvedHalfJson = await reviewCorpus(bigDocs, { chatOptions: { env: retryEnv }, charLimit: 600, chunkChars: 400 });
  mock.truncatePartJsonOver = 0;
  check(
    '块问成半截 JSON 时也对半切开（没有失败块）',
    halvedHalfJson.mode === 'chunked' && halvedHalfJson.failures.length === 0 && mock.calls.length > halvedHalfJson.chunks + 1,
    `calls=${mock.calls.length} chunks=${halvedHalfJson.chunks} failures=${halvedHalfJson.failures.length}`,
  );

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
  check('失败时把模型原文挂进 details.rawOutput', badJson?.details?.rawOutput === '抱歉，我无法回答。', badJson?.details?.rawOutput);
  const hinted = toResponse(new AiError('ai_bad_json', 'AI 返回的问答结果不是合法 JSON', { finishReason: 'stop', usage: { prompt: 5491, completion: 2871 } }));
  check(
    '坏 JSON 的响应带上现场（finish_reason 与用量）',
    hinted.body.error.message.includes('finish_reason=stop') && hinted.body.error.message.includes('5491'),
    hinted.body.error.message,
  );
  check('别的错误不拼现场', toResponse(new AiError('ai_timeout', '超时')).body.error.message === '超时');
  check('rawOutputHead 短的照原样、折成一行', rawOutputHead('a\n\n b ') === 'a b', JSON.stringify(rawOutputHead('a\n\n b ')));
  const rawLong = rawOutputHead('x'.repeat(900));
  check(
    'rawOutputHead 长的截到 500 字并标全文长度',
    rawLong.startsWith('x'.repeat(500)) && rawLong.endsWith('（全文 900 字）') && rawLong.length < 540,
    String(rawLong.length),
  );
  check('rawOutputHead 容得下 null', rawOutputHead(null) === '');
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

  // 标题 ≫ 小标题 > 正文：正文里的偶发命中不该压过标题/小标题命中
  const TIRED = [
    { id: 'body', title: '杂谈', content: '这里顺便提到了 dfs 两个字。' },
    { id: 'head', title: '图论基础', content: '## DFS 的实现\n递归与显式栈。' },
    { id: 'title', title: 'DFS 入门', content: '深度优先搜索的基本写法。' },
  ];
  const tiredRanked = rankDocuments('dfs 怎么实现', TIRED);
  check('标题命中排在小标题命中前面', String(tiredRanked[0].doc.id) === 'title', JSON.stringify(tiredRanked.map((r) => [r.doc.id, r.score, r.titleHit, r.headingHit])));
  check('小标题命中排在纯正文命中前面', String(tiredRanked[1].doc.id) === 'head', String(tiredRanked[1]?.doc?.id));
  const tiered = selectForQuestion('dfs 怎么实现', [...TIRED, { id: 'w1', title: '甲', content: 'dfs' }, { id: 'w2', title: '乙', content: 'dfs' }, { id: 'w3', title: '丙', content: 'dfs' }], { charBudget: 100000, maxDocuments: 8, maxWeak: 1 });
  check('有强命中时，纯正文命中的最多补 maxWeak 篇', tiered.picked.length === 3 && tiered.weak === 1, JSON.stringify({ picked: tiered.picked.map((doc) => doc.id), strong: tiered.strong, weak: tiered.weak }));
  check('选材按「进材料后的字数」估体量（长文档不再一票吃光预算）', selectForQuestion('dfs', [{ id: 'big', title: 'DFS 大全', content: 'x'.repeat(50000) }, { id: 'two', title: 'DFS 续', content: 'y'.repeat(50000) }], { charBudget: 5000 }).picked.length === 2);
  check('小标题抽取认得 # 标题与整行加粗', extractHeadings('# 一\n正文\n**二**\n### 三').join(',') === '一,二,三', extractHeadings('# 一\n正文\n**二**\n### 三').join(','));
  const terms = questionTerms('想学习dfs，然后实现成代码');
  check('问题分词包含英文词与汉字段', terms.includes('dfs') && terms.includes('想学习'), JSON.stringify(terms));

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
  // LOCAL PATCH (see LOCAL-PATCHES.md): 解读缓存记的是**这一篇自己**的指纹。
  const hashOf1 = store.documentHash('1');
  check('每篇有自己的指纹', Boolean(hashOf1) && hashOf1 !== store.documentHash('2') && hashOf1 !== hashBefore);

  // LOCAL PATCH (see LOCAL-PATCHES.md): 语料检索（标题 + 正文）。
  const searchBody = store.searchCorpus({ query: '分页' });
  check(
    '正文命中也能搜到（不是只搜标题）',
    searchBody.total === 1 && searchBody.items[0].id === '1' && searchBody.items[0].inTitle === false,
    JSON.stringify(searchBody).slice(0, 200),
  );
  check('命中片段带上下文', searchBody.items[0].snippet.includes('分页'), String(searchBody.items[0].snippet));
  check('检索知道一共多少篇', searchBody.documents === 3, String(searchBody.documents));
  const searchTitle = store.searchCorpus({ query: 'SQLite' });
  check('标题命中标成 inTitle 并排在前面', searchTitle.total === 1 && searchTitle.items[0].inTitle === true, JSON.stringify(searchTitle.items.map((item) => item.id)));
  check('命中带板块与回复数', searchTitle.items[0].board === '技术' && searchTitle.items[0].replyCount === 1, JSON.stringify(searchTitle.items[0]));
  const searchLimit = store.searchCorpus({ query: '一', limit: 1 });
  check('limit 只截返回条数', searchLimit.items.length <= 1, JSON.stringify({ total: searchLimit.total, got: searchLimit.items.length }));
  check('空关键词什么都不返回', store.searchCorpus({ query: '   ' }).total === 0);

  check('初始无缓存', store.reviewOf('1') === null);
  check('初始全是待整理', store.countPending() === 3 && store.pendingDocuments({ limit: 2 }).length === 2, JSON.stringify(store.pendingDocuments({ limit: 2 })));
  const savedReview = store.saveReview(
    { documentId: '1', status: 'done', category: '数据库', difficulty: '进阶', summary: 's', tags: ['sqlite'], prereq: [], recommend: [], model: 'm', tokens: { prompt: 3, completion: 2 } },
    { contentHash: hashOf1 },
  );
  check('保存解读可读回', savedReview.category === '数据库' && savedReview.tokens.prompt === 3);
  check('已解读的不在待整理里', store.pendingDocuments({ limit: 10 }).includes('1') === false);
  check('统计已解读数量', store.reviewStats().analyzed === 1 && store.reviewStats().failed === 0);

  const failedReview = store.saveReview(
    { documentId: '2', status: 'failed', error: 'AI 返回的解读结果不是合法 JSON', errorDetail: '{"category": "数据' },
    { contentHash: store.documentHash('2') },
  );
  check('失败也把模型原文存进 errorDetail', failedReview.errorDetail === '{"category": "数据' && store.reviewOf('2').errorDetail === '{"category": "数据', JSON.stringify(failedReview));
  check('失败的篇目排在从未解读的前面', store.pendingDocuments({ limit: 2 }).join(',') === '2,3', JSON.stringify(store.pendingDocuments({ limit: 10 })));
  check('统计里失败与已解读分开记', store.reviewStats().analyzed === 1 && store.reviewStats().failed === 1);

  source = [...DOCS, { id: '4', title: '新文档', content: '新增内容' }];
  store.syncCorpus();
  check('内容变化后指纹改变', store.corpusHash() !== hashBefore);
  check('新增别篇不让旧解读过期（按篇判过期）', store.pendingDocuments({ limit: 10 }).includes('1') === false);
  check('还没解读过的新篇照样待整理', store.pendingDocuments({ limit: 10 }).join(',') === '2,3,4', JSON.stringify(store.pendingDocuments({ limit: 10 })));

  source = source.map((doc) => (doc.id === '1' ? { ...doc, content: `${doc.content}（改过）` } : doc));
  store.syncCorpus();
  check('这一篇自己变了才回队', store.pendingDocuments({ limit: 10 }).includes('1') === true);
  check('待整理顺序：失败 → 从未解读 → 这一篇自己变了', store.pendingDocuments({ limit: 10 }).join(',') === '2,3,4,1', JSON.stringify(store.pendingDocuments({ limit: 10 })));

  // LOCAL PATCH (see LOCAL-PATCHES.md): 老库里的**整站**指纹要被一次性换成逐篇指纹，
  // 否则改完判据之后那些老账会永远算「内容已变」，「待整理」还是等于全站总数。
  {
    const legacyDocs = [
      { id: 'L1', title: '老账一', content: '正文', createdAt: 1000, updatedAt: 1000, replies: [] },
      { id: 'L2', title: '老账二', content: '正文二', createdAt: 2000, updatedAt: 2000, replies: [] },
    ];
    const legacyStore = createAiStore({
      db: new DatabaseSync(':memory:'),
      documentSource: () => legacyDocs,
      tablePrefix: 'ai_',
    });
    legacyStore.syncCorpus();
    // 老账：解读里存的是当时的整站语料指纹（`2:…`），换成按篇判之后它就一直对不上。
    legacyStore.saveReview(
      { documentId: 'L1', status: 'done', category: 'x', summary: 's', model: 'm' },
      { contentHash: legacyStore.corpusHash() },
    );
    check('老库的整站指纹会一直算过期', legacyStore.pendingDocuments({ limit: 10 }).includes('L1') === true);
    check('补齐逐篇指纹：补了 1 篇', legacyStore.backfillDocumentHashes() === 1);
    check('补完就不在待整理里', legacyStore.pendingDocuments({ limit: 10 }).includes('L1') === false);
    check('补齐是幂等的（再跑不用补）', legacyStore.backfillDocumentHashes() === 0);

    // 解读之后这一篇自己动过 → 不补，保留「内容已变」（宁可多问一次，也不假装它没过期）。
    legacyStore.saveReview(
      { documentId: 'L2', status: 'done', category: 'y', summary: 's2', model: 'm' },
      { contentHash: legacyStore.corpusHash() },
    );
    legacyDocs[1] = { ...legacyDocs[1], content: '正文二（改过）', updatedAt: 9999999999999 };
    legacyStore.syncCorpus();
    check('解读之后动过的老账不补', legacyStore.backfillDocumentHashes() === 0);
    check('只有真动过的那篇留在待整理', legacyStore.pendingDocuments({ limit: 10 }).join(',') === 'L2');
  }

  // LOCAL PATCH (see LOCAL-PATCHES.md 的 P 节): 语料里已经消失的文档，它的旧解读不该再算进「已解读」，
  // 否则页头会出现「已解读 573 > 语料 567」这种自相矛盾的数字。
  {
    let orphanDocs = [
      { id: 'O1', title: '在册一', content: '正文一', createdAt: 1000, updatedAt: 1000, replies: [] },
      { id: 'O2', title: '在册二', content: '正文二', createdAt: 2000, updatedAt: 2000, replies: [] },
    ];
    const orphanStore = createAiStore({
      db: new DatabaseSync(':memory:'),
      documentSource: () => orphanDocs,
      tablePrefix: 'ai_',
    });
    orphanStore.syncCorpus();
    orphanStore.saveReview(
      { documentId: 'O1', status: 'done', category: 'a', summary: 's', model: 'm' },
      { contentHash: orphanStore.documentHash('O1') },
    );
    orphanStore.saveReview(
      { documentId: 'O2', status: 'failed', error: '不是合法 JSON' },
      { contentHash: orphanStore.documentHash('O2') },
    );
    const bothStats = orphanStore.reviewStats();
    check(
      '两篇都在语料里时，已解读与失败各算一篇',
      bothStats.analyzed === 1 && bothStats.failed === 1 && bothStats.orphans === 0 && bothStats.documents === 2,
      JSON.stringify(bothStats),
    );

    orphanDocs = [orphanDocs[0]];
    orphanStore.syncCorpus();
    const orphanStats = orphanStore.reviewStats();
    check(
      '语料里删掉的篇目不再算进「已解读 / 失败」',
      orphanStats.analyzed === 1 && orphanStats.failed === 0 && orphanStats.documents === 1,
      JSON.stringify(orphanStats),
    );
    check('删掉的旧解读单独用 orphans 报到（不删缓存，也不冒充失败）', orphanStats.orphans === 1, JSON.stringify(orphanStats));
    check('已解读永远不会超过语料篇数', orphanStats.analyzed <= orphanStats.documents, JSON.stringify(orphanStats));
  }

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
  check('clearAll 清掉解读与报告', cleared.reviews === 2 && cleared.reports === 2, JSON.stringify(cleared));
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

  // 失败时留下现场：错误码进 error，模型原文进 errorDetail
  mock.mode = 'bad-json';
  const badOne = await call(handlers.analyzeDocument, { params: { id: '3' }, user: { id: 'u1' }, body: {} });
  check('解读失败 → 502 ai_bad_json', badOne.status === 502 && badOne.body.error.code === 'ai_bad_json', JSON.stringify(badOne.body).slice(0, 160));
  check('失败现场落库：模型原文进 errorDetail', store.reviewOf('3')?.errorDetail === '抱歉，我无法回答。', JSON.stringify(store.reviewOf('3')));
  check('失败的篇目回到待整理队首（下次优先重试）', store.pendingDocuments({ limit: 1 }).join(',') === '3', JSON.stringify(store.pendingDocuments({ limit: 5 })));
  mock.mode = 'ok';

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
