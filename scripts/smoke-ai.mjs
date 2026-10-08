/**
 * AI 功能端到端测试：起一个假的 OpenAI 兼容服务，把论坛服务接到它上面，
 * 覆盖「未配置降级 / 逐篇解读 / 全站整理 / 单篇问答 / 全站问答 / 缓存与过期 / 鉴权限流」。
 *
 *   node scripts/smoke-ai.mjs
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import { openSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..');
const SERVER = join(ROOT, 'src', 'server.js');
const DB_FILE = join(ROOT, 'data', `smoke-ai-${process.pid}.db`);
const LOG_FILE = join(ROOT, 'data', `smoke-ai-${process.pid}.log`);
const PORT = Number(process.env.SMOKE_AI_PORT || 3422);
const MOCK_PORT = PORT + 1;
const BASE = `http://127.0.0.1:${PORT}`;

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
/* 假的 OpenAI 兼容服务                                                */
/* ------------------------------------------------------------------ */

const mock = { calls: [], mode: 'analyze', failWith: null, maxPromptChars: 0, truncateOnce: false };

function mockReply(messages) {
  const system = String(messages?.[0]?.content ?? '');
  const user = String(messages?.[1]?.content ?? '');
  if (mock.failWith) return mock.failWith;
  if (system.includes('知识地图')) {
    const ids = [...user.matchAll(/\[#(\d+)\]/g)].map((m) => Number(m[1]));
    const uniq = [...new Set(ids)];
    return {
      summary: '这个社区主要在聊 Node 全栈、前端工程化与 Markdown 写作。',
      topics: [
        {
          name: 'Node 全栈',
          summary: '零依赖做后端与数据库',
          difficulty: '进阶',
          postIds: uniq.slice(0, 3),
          prereq: ['JavaScript 基础'],
          order: 1,
        },
        { name: '不存在主题', summary: 'postIds 全是假的，应被过滤', difficulty: '入门', postIds: [999999], prereq: [], order: 2 },
      ],
      readingPath: uniq.slice(0, 3).map((id, index) => ({
        postId: id,
        title: `第 ${index + 1} 篇`,
        reason: '按顺序读',
        level: index === 0 ? '入门' : '进阶',
      })),
    };
  }
  if (system.includes('内容整理助手')) {
    const ids = [...user.matchAll(/\[#(\d+)\]/g)].map((m) => Number(m[1]));
    return {
      category: '后端',
      difficulty: '进阶',
      summary: '讲如何用 Node 内置 SQLite 做零依赖全栈，包含建表与查询实践。',
      tags: ['Node.js', 'SQLite', '全栈'],
      prereq: [{ name: 'JavaScript 基础', why: '读懂示例代码', level: '入门' }],
      recommend: [
        { postId: ids[1] ?? null, title: '相关帖子', reason: '同一主题延伸', relation: '延伸' },
        // 只有标题、没有任何真实落点 —— 这就是线上出现过的那类鬼篇目，必须整条丢掉
        { postId: null, title: '不存在的指南', reason: '编号是编的，应被丢弃', relation: '对比' },
      ],
    };
  }
  return {
    answer: `根据材料，答案是 [#${[...user.matchAll(/\[#(\d+)\]/g)].map((m) => Number(m[1]))[0] ?? 1}]。`,
    citations: [
      { postId: [...user.matchAll(/\[#(\d+)\]/g)].map((m) => Number(m[1]))[0] ?? 1, title: '引用帖子', quote: '原文片段' },
      { postId: 999999, title: '假的引用', quote: '应被过滤' },
    ],
    notes: ['建议先补 JavaScript 基础'],
    confidence: 'high',
  };
}

const mockServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    if (!req.url.includes('/chat/completions')) {
      res.writeHead(404).end('{}');
      return;
    }
    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      /* 忽略 */
    }
    mock.calls.push({ headers: req.headers, body: parsed });
    // 模拟「输出预算被烧光」：上游 200，但 finish_reason=length 且正文为空。
    const userChars = String(parsed?.messages?.[1]?.content ?? '').length;
    const truncated = mock.truncateOnce || (mock.maxPromptChars > 0 && userChars > mock.maxPromptChars);
    if (mock.truncateOnce) mock.truncateOnce = false;
    if (truncated) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          model: parsed?.model ?? 'mock-model',
          choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'length' }],
          usage: { prompt_tokens: 123, completion_tokens: 45 },
        }),
      );
      return;
    }
    const content = mockReply(parsed?.messages);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        model: parsed?.model ?? 'mock-model',
        choices: [{ message: { role: 'assistant', content: JSON.stringify(content) } }],
        usage: { prompt_tokens: 123, completion_tokens: 45 },
      }),
    );
  });
});

/* ------------------------------------------------------------------ */
/* 客户端                                                              */
/* ------------------------------------------------------------------ */

function createClient() {
  let cookie = '';
  return {
    get cookie() {
      return cookie;
    },
    async call(path, { method = 'GET', body, raw = false } = {}) {
      const response = await fetch(BASE + path, {
        method,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'manual',
      });
      for (const value of response.headers.getSetCookie()) {
        const pair = value.split(';')[0];
        if (pair.startsWith('forum_sid=')) cookie = pair;
      }
      if (raw) return response;
      const json = await response.json().catch(() => null);
      return { status: response.status, body: json, data: json?.data, error: json?.error };
    },
  };
}

async function waitForServer(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/site`);
      if (response.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(150);
  }
  return false;
}

function startForum(env) {
  const logFd = openSync(LOG_FILE, 'w');
  return spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(PORT), DB_FILE, QUIET: '1', ...env },
    stdio: ['ignore', logFd, logFd],
  });
}

mkdirSync(join(ROOT, 'data'), { recursive: true });
for (const suffix of ['', '-wal', '-shm']) rmSync(DB_FILE + suffix, { force: true });
await new Promise((done) => mockServer.listen(MOCK_PORT, '127.0.0.1', done));

let child = null;

/** 等子进程真的退出：Windows 上刚被 kill 时它占着 .db，立刻删会失败（以前这里静默吞掉了）。 */
async function waitForExit(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  await Promise.race([new Promise((done) => proc.once('exit', done)), sleep(2000)]);
}

/** 删临时文件，删不掉就重试几次；返回是否删干净。 */
async function removeTempFile(file) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(file, { force: true });
      return true;
    } catch {
      await sleep(100);
    }
  }
  return false;
}

const finish = async (code) => {
  try {
    child?.kill();
  } catch {
    /* 忽略 */
  }
  await waitForExit(child);
  mockServer.close();
  const leftovers = [];
  for (const file of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`, LOG_FILE]) {
    if (!(await removeTempFile(file))) leftovers.push(file);
  }
  if (leftovers.length) console.warn(`⚠️  这些临时文件没能删掉，请手动清理：${leftovers.join('、')}`);
  process.exit(code);
};

try {
  /* ---------- 第一阶段：没配 AI_API_KEY ---------- */
  console.log('\n▶ 未配置 AI 时的降级行为');
  child = startForum({ AI_API_KEY: '', AI_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1` });
  if (!(await waitForServer(PORT))) {
    console.error('服务器启动失败：\n', readFileSync(LOG_FILE, 'utf8').slice(-3000));
    await finish(1);
  }

  const anon = createClient();
  const admin = createClient();
  const member = createClient();

  const site = await anon.call('/api/site');
  check('站点接口暴露 AI 状态', site.data?.ai?.configured === false, JSON.stringify(site.data?.ai));

  const anonAsk = await anon.call('/api/ai/ask', { method: 'POST', body: { question: '随便问问' } });
  check('未登录问答被拒绝（401）', anonAsk.status === 401, `status=${anonAsk.status}`);

  const adminLogin = await admin.call('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
  check('管理员登录成功', adminLogin.status === 200, `status=${adminLogin.status}`);
  const memberLogin = await member.call('/api/auth/login', { method: 'POST', body: { username: 'alice', password: 'demo1234' } });
  check('普通用户登录成功', memberLogin.status === 200, `status=${memberLogin.status}`);

  const noKey = await member.call('/api/ai/posts/1/analyze', { method: 'POST' });
  check(
    '未配置密钥时解读返回 503 ai_not_configured',
    noKey.status === 503 && noKey.error?.code === 'ai_not_configured',
    `status=${noKey.status} code=${noKey.error?.code}`,
  );
  check('未配置的提示里包含 AI_API_KEY', String(noKey.error?.message ?? '').includes('AI_API_KEY'));

  const noKeySite = await admin.call('/api/ai/site/analyze', { method: 'POST' });
  check('未配置密钥时全站整理返回 503', noKeySite.status === 503 && noKeySite.error?.code === 'ai_not_configured');

  const noKeyAsk = await member.call('/api/ai/ask', { method: 'POST', body: { question: '论坛讲什么' } });
  check('未配置密钥时问答返回 503', noKeyAsk.status === 503 && noKeyAsk.error?.code === 'ai_not_configured');

  const forbiddenSite = await member.call('/api/ai/site/analyze', { method: 'POST' });
  check('普通用户不能触发全站整理（403 或 503 前置校验）', [403, 503].includes(forbiddenSite.status), `status=${forbiddenSite.status}`);

  const cacheBefore = await member.call('/api/ai/posts/1');
  check('未解读时缓存为空', cacheBefore.status === 200 && cacheBefore.data.cached === null, JSON.stringify(cacheBefore.data?.cached));

  const missing = await member.call('/api/ai/posts/99999');
  check('不存在的帖子返回 404', missing.status === 404, `status=${missing.status}`);

  child.kill();
  await sleep(600);

  /* ---------- 第二阶段：接入假 AI 服务 ---------- */
  console.log('\n▶ 接入 OpenAI 兼容服务后的完整链路');
  mock.calls.length = 0;
  child = startForum({ AI_API_KEY: 'test-key-123', AI_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`, AI_MODEL: 'mock-model' });
  if (!(await waitForServer(PORT))) {
    console.error('服务器重启失败：\n', readFileSync(LOG_FILE, 'utf8').slice(-3000));
    await finish(1);
  }

  const admin2 = createClient();
  const member2 = createClient();
  const other = createClient();
  await admin2.call('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
  await member2.call('/api/auth/login', { method: 'POST', body: { username: 'alice', password: 'demo1234' } });
  await other.call('/api/auth/login', { method: 'POST', body: { username: 'bob', password: 'demo1234' } });

  const site2 = await admin2.call('/api/site');
  check('配置后站点接口标记为已启用', site2.data?.ai?.configured === true && site2.data.ai.model === 'mock-model', JSON.stringify(site2.data?.ai));

  const analyze = await member2.call('/api/ai/posts/2/analyze', { method: 'POST' });
  check('逐篇解读返回 200', analyze.status === 200, `status=${analyze.status} ${JSON.stringify(analyze.error)}`);
  const review = analyze.data?.review;
  check('解读包含分类与难度', review?.category === '后端' && review?.difficulty === '进阶', JSON.stringify(review));
  check('解读包含摘要', typeof review?.summary === 'string' && review.summary.length > 10, review?.summary);
  check('解读包含标签数组', Array.isArray(review?.tags) && review.tags.includes('SQLite'), JSON.stringify(review?.tags));
  check('解读包含前置知识', Array.isArray(review?.prereq) && review.prereq[0]?.name === 'JavaScript 基础', JSON.stringify(review?.prereq));
  check('推荐阅读只留有真实落点的条目（编造的整条丢弃）', Array.isArray(review?.recommend) && review.recommend.length === 1 && (review.recommend[0].postId ?? review.recommend[0].documentId) === 1, JSON.stringify(review?.recommend));
  check('记录 token 用量', review?.tokens?.prompt === 123 && review?.tokens?.completion === 45, JSON.stringify(review?.tokens));

  const sentAuth = mock.calls[0]?.headers?.authorization;
  check('服务端用 Bearer 携带密钥调用 AI', sentAuth === 'Bearer test-key-123', String(sentAuth));
  check('提示词里带上了帖子正文', String(mock.calls[0]?.body?.messages?.[1]?.content ?? '').includes('Node'));

  const cached = await member2.call('/api/ai/posts/2');
  check('解读结果已缓存入库', cached.data?.cached?.category === '后端', JSON.stringify(cached.data?.cached));
  check('刚解读完不算过期', cached.data?.stale === false, `stale=${cached.data?.stale}`);

  const analyze3 = await member2.call('/api/ai/posts/3/analyze', { method: 'POST' });
  check('第二篇也能解读', analyze3.status === 200 && analyze3.data.review.category === '后端');

  console.log('\n▶ 批量解读（管理员）');
  const forbiddenBatch = await member2.call('/api/ai/posts/analyze-pending', { method: 'POST', body: { limit: 5 } });
  check('普通用户不能批量解读（403）', forbiddenBatch.status === 403, `status=${forbiddenBatch.status}`);

  const anonBatch = await anon.call('/api/ai/posts/analyze-pending', { method: 'POST', body: {} });
  check('未登录不能批量解读（401）', anonBatch.status === 401, `status=${anonBatch.status}`);

  const batch1 = await admin2.call('/api/ai/posts/analyze-pending', { method: 'POST', body: { limit: 4 } });
  check('批量解读返回 200', batch1.status === 200, `status=${batch1.status} ${JSON.stringify(batch1.error)}`);
  check('按上限处理 4 篇', batch1.data?.processed === 4, JSON.stringify(batch1.data));
  check(
    '每篇都有结果明细',
    batch1.data.results.length === 4 && batch1.data.results.every((r) => r.postId && r.category),
    JSON.stringify(batch1.data.results),
  );
  check('返回剩余待整理数量', batch1.data.remaining > 0 && batch1.data.stats.pending === batch1.data.remaining, JSON.stringify(batch1.data.stats));

  const batch2 = await admin2.call('/api/ai/posts/analyze-pending', { method: 'POST', body: { limit: 20 } });
  check('一批可以处理完剩余帖子', batch2.data.processed === batch1.data.remaining, JSON.stringify(batch2.data));
  check(
    '两次批量不重复处理同一篇',
    batch2.data.results.every((r) => !batch1.data.results.some((x) => x.postId === r.postId)),
    JSON.stringify({ a: batch1.data.results.map((r) => r.postId), b: batch2.data.results.map((r) => r.postId) }),
  );
  check('处理完后没有待整理', batch2.data.stats.pending === 0, JSON.stringify(batch2.data.stats));
  check('全部帖子都拿到了分类', batch2.data.stats.analyzed === batch2.data.stats.posts, JSON.stringify(batch2.data.stats));

  const batch3 = await admin2.call('/api/ai/posts/analyze-pending', { method: 'POST', body: { limit: 4 } });
  check('没有待整理时返回空批次而不是报错', batch3.status === 200 && batch3.data.processed === 0 && batch3.data.results.length === 0, JSON.stringify(batch3.data));

  console.log('\n▶ 全站整理');
  const siteAnalyze = await admin2.call('/api/ai/site/analyze', { method: 'POST' });
  check('全站整理返回 200', siteAnalyze.status === 200, `status=${siteAnalyze.status} ${JSON.stringify(siteAnalyze.error)}`);
  check('返回主题数与阅读路径条数', siteAnalyze.data?.topics >= 1 && siteAnalyze.data?.readingPath >= 1, JSON.stringify(siteAnalyze.data));

  const siteIndex = await member2.call('/api/ai/site');
  check('全站整理结果可读回', siteIndex.status === 200 && siteIndex.data.report !== null, `status=${siteIndex.status}`);
  check('假主题（postIds 无效）被过滤', siteIndex.data.topics.length === 1, JSON.stringify(siteIndex.data.topics.map((t) => t.name)));
  check('主题下带出帖子摘要', siteIndex.data.topics[0].posts.length >= 1 && siteIndex.data.topics[0].posts[0].title.length > 0);
  check('阅读路径带出帖子对象', siteIndex.data.readingPath.every((step) => step.post && step.post.id), JSON.stringify(siteIndex.data.readingPath));
  check('统计里有已解读篇数', siteIndex.data.stats.analyzed >= 2, JSON.stringify(siteIndex.data.stats));
  check('整理后不算过期', siteIndex.data.stale === false, `stale=${siteIndex.data.stale}`);

  console.log('\n▶ 语料检索');
  const searchCommon = await member2.call(`/api/ai/search?q=${encodeURIComponent('的')}`);
  check('两个字以下不搜（minLength=2）', searchCommon.status === 200 && searchCommon.data?.total === 0 && searchCommon.data.minLength === 2, JSON.stringify(searchCommon.data).slice(0, 160));
  const searchBody = await member2.call(`/api/ai/search?q=${encodeURIComponent('Node')}`);
  check('语料检索返回 200 并带命中数', searchBody.status === 200 && typeof searchBody.data?.total === 'number', `status=${searchBody.status} ${JSON.stringify(searchBody.data).slice(0, 160)}`);
  check('检索结果带片段与出处', searchBody.data.items.every((item) => item.id && item.title && typeof item.snippet === 'string' && item.author !== undefined), JSON.stringify(searchBody.data.items[0] ?? {}).slice(0, 200));
  check('检索知道语料一共有多少篇', searchBody.data.documents >= 3, String(searchBody.data.documents));
  const knownTitle = String(siteIndex.data.readingPath?.[0]?.post?.title ?? siteIndex.data.topics[0].posts[0].title ?? '');
  const searchTitleWord = await member2.call(`/api/ai/search?q=${encodeURIComponent(knownTitle.slice(0, 2))}`);
  check('标题里的词能搜到且标成 inTitle', searchTitleWord.data?.total >= 1 && searchTitleWord.data.items.some((item) => item.inTitle === true), JSON.stringify(searchTitleWord.data.items.map((item) => item.inTitle)));
  const searchAnon = await anon.call(`/api/ai/search?q=${encodeURIComponent('Node')}`);
  check('未登录检索被拒绝（401）', searchAnon.status === 401, `status=${searchAnon.status}`);

  console.log('\n▶ 问答');
  const askPost = await member2.call('/api/ai/ask', { method: 'POST', body: { question: '这篇讲了什么？', postId: 2 } });
  check('单篇问答返回 200', askPost.status === 200, `status=${askPost.status} ${JSON.stringify(askPost.error)}`);
  check('单篇问答 scope=post', askPost.data?.scope === 'post' && askPost.data.postId === 2, JSON.stringify(askPost.data?.scope));
  check('单篇问答返回答案文本', String(askPost.data?.answer ?? '').length > 0);
  check('假引用被过滤掉', askPost.data.citations.length === 1 && askPost.data.citations[0].postId !== 999999, JSON.stringify(askPost.data.citations));
  check('返回置信度与备注', askPost.data.confidence === 'high' && askPost.data.notes.length === 1, JSON.stringify(askPost.data));

  const askSite = await member2.call('/api/ai/ask', { method: 'POST', body: { question: 'Markdown 写作有什么技巧？' } });
  check('全站问答返回 200', askSite.status === 200, `status=${askSite.status} ${JSON.stringify(askSite.error)}`);
  check('全站问答 scope=site 并统计纳入篇数', askSite.data?.scope === 'site' && askSite.data.included >= 1, JSON.stringify(askSite.data));
  check('全站问答材料含多篇帖子', askSite.data.included >= 3, `included=${askSite.data.included}`);
  check('全站问答选材有上限（不再把全库塞进材料）', askSite.data.included <= 6, `included=${askSite.data.included}`);

  const tooShort = await member2.call('/api/ai/ask', { method: 'POST', body: { question: 'x' } });
  check('过短问题被拒绝（400）', tooShort.status === 400, `status=${tooShort.status}`);
  const tooLong = await member2.call('/api/ai/ask', { method: 'POST', body: { question: 'x'.repeat(501) } });
  check('过长问题被拒绝（400）', tooLong.status === 400, `status=${tooLong.status}`);

  // 线上「问答永远 502」的根因：以前把 maxTokens 写死 1200，宽问题被截断成空正文。
  const askCall = mock.calls.find((call) => String(call.body?.messages?.[1]?.content ?? '').includes('Markdown 写作有什么技巧'));
  check('问答的输出预算不再是写死的 1200', askCall?.body?.max_tokens === 3000, String(askCall?.body?.max_tokens));
  const askPromptChars = String(askCall?.body?.messages?.[1]?.content ?? '').length;
  check('全站问答的材料压在 12000 字以内', askPromptChars <= 12000 + 3000, String(askPromptChars));

  // 回答挤成一大段（线上实测 1540 字、0 个换行）读不动：提示词必须明确要结构。
  const askSystem = String(askCall?.body?.messages?.[0]?.content ?? '');
  check('问答提示词要求分段与小标题', askSystem.includes('answer 的排版') && askSystem.includes('小节标题单独占一行'), askSystem.includes('answer 的排版') ? '已要求' : '没要求');
  check('问答提示词要求要点写成 - 列表', askSystem.includes('"- " 开头的列表'), '');

  // 上游截断（预算被烧光）：服务端自己砍半材料、把预算加倍再问一次，而不是把 502 甩给用户。
  mock.truncateOnce = true;
  const beforeRetry = mock.calls.length;
  const askRetry = await member2.call('/api/ai/ask', { method: 'POST', body: { question: 'Markdown 写作有什么技巧？' } });
  check('上游截断一次后，服务端自己砍半重问，最终返回 200', askRetry.status === 200, `status=${askRetry.status} ${JSON.stringify(askRetry.error)}`);
  const retryCalls = mock.calls.slice(beforeRetry);
  check('重问时把预算加倍到 6000', retryCalls.length === 2 && retryCalls[1].body.max_tokens === 6000, retryCalls.map((call) => call.body?.max_tokens).join(','));
  check(
    '重问的材料确实更短',
    String(retryCalls[1]?.body?.messages?.[1]?.content ?? '').length < String(retryCalls[0]?.body?.messages?.[1]?.content ?? '').length,
    `${String(retryCalls[0]?.body?.messages?.[1]?.content ?? '').length} → ${String(retryCalls[1]?.body?.messages?.[1]?.content ?? '').length}`,
  );

  // 砍半还是截断：给一句用户能照着做的话，而不是让前端显示「服务器开小差了」。
  mock.maxPromptChars = 1;
  const askTruncated = await member2.call('/api/ai/ask', { method: 'POST', body: { question: 'Markdown 写作有什么技巧？' } });
  check('两次都截断时返回 503 ai_answer_truncated', askTruncated.status === 503 && askTruncated.error?.code === 'ai_answer_truncated', `status=${askTruncated.status} ${JSON.stringify(askTruncated.error)}`);
  check('截断提示告诉用户怎么办', String(askTruncated.error?.message ?? '').includes('问得具体一点'), String(askTruncated.error?.message));
  mock.maxPromptChars = 0;

  console.log('\n▶ 检索与缓存过期');
  const retrieved = mock.calls.map((call) => String(call.body?.messages?.[1]?.content ?? ''));
  const markdownAsk = retrieved.find((text) => text.includes('Markdown 写作有什么技巧'));
  check('关键词命中的帖子排在材料前面', /材料[\s\S]*?\[#4\]/.test(markdownAsk ?? ''), (markdownAsk ?? '').slice(0, 200));

  // 帖子写入接口已经下线（`POST /api/posts` 一律 410 `posts_retired`），
  // 所以这里改「建一篇公开积木」—— 积木会顺带配一条影子帖（hidden = 0、deleted = 0），
  // 它也会进 AI 语料。顺带验 LOCAL PATCH（见 `forum-ai/LOCAL-PATCHES.md`）：
  // 解读缓存的过期改按**这一篇自己**的指纹判 —— 新增别篇不该让老解读过期，
  // 只有这一篇自己的正文变了才回队。
  const newDoc = await member2.call('/api/docs', {
    method: 'POST',
    body: {
      title: 'AI 测试新增的一篇积木',
      kind: 'post',
      scope: 'public',
      blocks: [{ type: 'paragraph', props: { text: '新增内容用于让语料指纹变化。' } }],
    },
  });
  check(
    '新增积木成功（影子帖一同进语料）',
    newDoc.status === 200 && Number(newDoc.data?.doc?.id) > 0,
    `status=${newDoc.status} ${JSON.stringify(newDoc.error ?? newDoc.body).slice(0, 160)}`,
  );
  const newDocId = newDoc.data?.doc?.id;
  const anchor = await member2.call(`/api/docs/${newDocId}/anchor`);
  const newPostId = Number(anchor.data?.post?.id);
  check('新积木的影子帖拿得到 id', newPostId > 0, JSON.stringify(anchor.data?.post ?? anchor.body).slice(0, 160));

  const afterChange = await member2.call('/api/ai/posts/2');
  check('新增别篇不让老解读过期（按篇判过期）', afterChange.data?.stale === false, `stale=${afterChange.data?.stale}`);

  const analyzedNew = await member2.call(`/api/ai/posts/${newPostId}/analyze`, { method: 'POST' });
  check('新建的那一篇解读成功', analyzedNew.status === 200, `status=${analyzedNew.status}`);
  const freshNew = await member2.call(`/api/ai/posts/${newPostId}`);
  check('刚解读完自己不算过期', freshNew.data?.stale === false, `stale=${freshNew.data?.stale}`);

  const newMd = await member2.call(`/api/docs/${newDocId}/markdown`);
  const wrote = await member2.call(`/api/docs/${newDocId}/markdown`, {
    method: 'PUT',
    body: { markdown: `${newMd.data?.markdown ?? ''}\n\n这一段是新加的：验「这一篇自己变了才标过期」。` },
  });
  check(
    '改这一篇自己的正文',
    wrote.status === 200,
    `status=${wrote.status} ${JSON.stringify(wrote.error ?? wrote.body).slice(0, 160)}`,
  );
  const changedSelf = await member2.call(`/api/ai/posts/${newPostId}`);
  check('这一篇自己变了才标过期', changedSelf.data?.stale === true, `stale=${changedSelf.data?.stale}`);

  const siteAfter = await member2.call('/api/ai/site');
  check('内容变化后全站整理仍标记过期', siteAfter.data?.stale === true, `stale=${siteAfter.data?.stale}`);

  console.log('\n▶ 失败现场与重试');
  mock.failWith = '抱歉，我暂时没法给出结构化结果。';
  const badJson = await member2.call('/api/ai/posts/3/analyze', { method: 'POST' });
  check('模型返回非 JSON → 502 ai_bad_json', badJson.status === 502 && badJson.error?.code === 'ai_bad_json', `status=${badJson.status} code=${badJson.error?.code}`);
  const badCache = await member2.call('/api/ai/posts/3');
  check(
    '失败现场留了模型原文（errorDetail）',
    badCache.data?.cached?.status === 'failed' && String(badCache.data.cached.errorDetail).includes('抱歉，我暂时没法给出结构化结果'),
    JSON.stringify(badCache.data?.cached).slice(0, 200),
  );
  mock.failWith = null;
  const retry = await member2.call('/api/ai/posts/3/analyze', { method: 'POST' });
  check('失败后重试即修好', retry.status === 200 && retry.data?.review?.status === 'done', JSON.stringify(retry.data?.review).slice(0, 140));
  const retryCache = await member2.call('/api/ai/posts/3');
  check('成功后清掉失败现场', retryCache.data?.cached?.status === 'done' && retryCache.data.cached.errorDetail === '', JSON.stringify(retryCache.data?.cached?.errorDetail));

  console.log('\n▶ AI 上游故障的处理');
  mock.failWith = null;
  const badModel = await member2.call('/api/ai/posts/5', { method: 'GET' });
  check('单篇缓存读取不受上游影响', badModel.status === 200);

  child.kill();
  await sleep(600);
  child = startForum({
    AI_API_KEY: 'test-key-123',
    AI_BASE_URL: `http://127.0.0.1:${MOCK_PORT + 9}/v1`,
    AI_MODEL: 'mock-model',
    AI_TIMEOUT_MS: '1500',
  });
  if (!(await waitForServer(PORT))) {
    console.error('服务器重启失败（不可达用例）\n');
    await finish(1);
  }
  const member3 = createClient();
  await member3.call('/api/auth/login', { method: 'POST', body: { username: 'alice', password: 'demo1234' } });
  const unreachable = await member3.call('/api/ai/posts/1/analyze', { method: 'POST' });
  check(
    'AI 服务不可达时返回 502 ai_unreachable',
    unreachable.status === 502 && unreachable.error?.code === 'ai_unreachable',
    `status=${unreachable.status} code=${unreachable.error?.code}`,
  );
  const failedCache = await member3.call('/api/ai/posts/1');
  check('失败的解读也被记录（便于排查）', failedCache.data?.cached?.status === 'failed' && failedCache.data.cached.error.length > 0, JSON.stringify(failedCache.data?.cached));
  const reread = await member3.call('/api/ai/posts/2');
  check('失败不影响已成功的缓存', reread.data?.cached?.category === '后端');

  console.log(`\n${'─'.repeat(46)}`);
  console.log(`通过 ${passed} 项，失败 ${failures.length} 项`);
  if (failures.length) {
    console.log('\n失败明细：');
    for (const item of failures) console.log(`  · ${item}`);
  }
  await finish(failures.length ? 1 : 0);
} catch (error) {
  console.error('\nAI 冒烟测试异常终止：', error);
  try {
    console.error('\n服务器日志尾部：\n', readFileSync(LOG_FILE, 'utf8').slice(-3000));
  } catch {
    /* 忽略 */
  }
  finish(1);
}
