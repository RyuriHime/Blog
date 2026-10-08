#!/usr/bin/env node
/**
 * 集成测试：证明「把 AI 阅读助手挂到别人已有的 server 上」真的只需要两行。
 *
 *   node selftest-mount.mjs
 *
 * 测试里的宿主故意写得极简：只有一个 GET /api/posts 和一个 GET /，
 * 表结构也是精简版（posts/replies/users/boards 只留必要列），
 * 用来证明挂载层不依赖我这个仓库的论坛实现。
 */
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createForumDocumentSource, mountForumAi } from './src/mount.mjs';

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

/* ---------------- 1. 最小宿主：表结构精简，只读语料 ---------------- */

const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, banned INTEGER DEFAULT 0);
  CREATE TABLE boards (id INTEGER PRIMARY KEY, name TEXT);
  CREATE TABLE posts (
    id INTEGER PRIMARY KEY, board_id INTEGER, user_id INTEGER,
    title TEXT, content TEXT, deleted INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER
  );
  CREATE TABLE replies (
    id INTEGER PRIMARY KEY, post_id INTEGER, user_id INTEGER, content TEXT,
    deleted INTEGER DEFAULT 0, created_at INTEGER
  );
  CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id INTEGER, expires_at INTEGER);
`);
const now = Date.now();
db.exec(`
  INSERT INTO users (id, username, display_name, role) VALUES
    (1, 'admin', '站长', 'admin'), (2, 'alice', 'Alice', 'member');
  INSERT INTO boards (id, name) VALUES (1, '技术交流'), (2, '问答求助');
  INSERT INTO posts (id, board_id, user_id, title, content, created_at, updated_at) VALUES
    (1, 1, 2, 'Node.js 内置 SQLite 实践', 'node:sqlite 可以省掉第三方依赖，建表与查询都够用。', ${now - 86400000}, ${now - 86400000}),
    (2, 2, 1, 'SQLite 深分页变慢怎么优化', 'LIMIT OFFSET 在深分页时很慢，考虑换成 keyset 分页。', ${now - 3600000}, ${now - 3600000}),
    (3, 1, 2, '已删除的帖子', '不该进语料', 0, 0);
  UPDATE posts SET deleted = 1 WHERE id = 3;
  INSERT INTO replies (id, post_id, user_id, content, created_at) VALUES
    (1, 1, 1, '零依赖这点很香', ${now - 80000000});
  INSERT INTO sessions (token, user_id, expires_at) VALUES
    ('admin-token', 1, ${now + 86400000}), ('alice-token', 2, ${now + 86400000});
`);

/** 宿主自己的会话解析（真实论坛里就是 server.js 里的 resolveUser）。 */
function resolveUser(req) {
  const token = /forum_sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
  if (!token) return { user: null };
  const session = db.prepare('SELECT user_id, expires_at FROM sessions WHERE token = ?').get(token);
  if (!session || Number(session.expires_at) < Date.now()) return { user: null };
  const user = db.prepare('SELECT id, username, display_name AS displayName, role FROM users WHERE id = ?').get(session.user_id);
  return { user: user ?? null, sessionToken: token };
}

const hostHits = [];
const hostServer = http.createServer(async (req, res) => {
  hostHits.push(`${req.method} ${req.url}`);
  if (req.url === '/api/posts') {
    const items = db.prepare('SELECT id, title FROM posts WHERE deleted = 0').all();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, data: { items } }));
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<h1>我是宿主首页</h1>');
});

/* ---------------- 2. 两行挂载 ---------------- */

const mounted = mountForumAi({ db, resolveUser, quiet: true });
mounted.attach(hostServer);

const PORT = Number(process.env.PORT || 3731);
await new Promise((done) => hostServer.listen(PORT, '127.0.0.1', done));
const BASE = `http://127.0.0.1:${PORT}`;

async function call(path, { method = 'GET', body, cookie } = {}) {
  const response = await fetch(BASE + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  return { status: response.status, body: parsed, text };
}

/* ---------------- 3. 假 AI 服务（异步，不能阻塞事件循环） ---------------- */

const mock = { calls: 0, prompts: [] };
const aiServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    mock.calls += 1;
    const userText = String(JSON.parse(raw || '{}')?.messages?.[1]?.content ?? '');
    mock.prompts.push(userText);
    const ids = [...new Set([...userText.matchAll(/\[#([\w.-]+)\]/g)].map((m) => m[1]))];
    const payload = userText.includes('全库材料')
      ? {
          summary: '这批文档围绕 Node 与 SQLite 展开。',
          topics: [{ name: 'SQLite 实践', summary: '零依赖与分页优化', difficulty: '进阶', documentIds: ids, prereq: ['SQL 基础'], order: 1 }],
          readingPath: ids.map((id, index) => ({ documentId: id, title: `第 ${index + 1} 篇`, reason: '按顺序读', level: index ? '进阶' : '入门' })),
        }
      : userText.includes('本篇材料')
        ? {
            category: '数据库',
            difficulty: '进阶',
            summary: '讲零依赖使用内置 SQLite。',
            tags: ['Node.js', 'SQLite'],
            prereq: [{ name: 'JavaScript', why: '读代码', level: '入门' }],
            recommend: [
              { documentId: ids.find((id) => id !== '1') ?? null, title: '同主题延伸', reason: '性能侧', relation: '延伸' },
              { documentId: null, title: '编造的手册', reason: '没有编号', relation: '对比' },
            ],
          }
        : {
            answer: '材料里 [#1] 提到省掉第三方依赖，[#2] 讨论深分页优化。',
            citations: [
              { documentId: ids[0] ?? '1', title: 'Node.js 内置 SQLite 实践', quote: '省掉第三方依赖' },
              { documentId: '999999', title: '编造引用', quote: '应被过滤' },
            ],
            notes: ['建议先补 SQL 索引'],
            confidence: 'high',
          };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ model: 'mount-mock', choices: [{ message: { content: JSON.stringify(payload) } }], usage: { prompt_tokens: 9, completion_tokens: 4 } }));
  });
});
const AI_PORT = PORT + 1;
await new Promise((done) => aiServer.listen(AI_PORT, '127.0.0.1', done));
process.env.AI_API_KEY = 'mount-key';
process.env.AI_BASE_URL = `http://127.0.0.1:${AI_PORT}/v1`;
process.env.AI_MODEL = 'mount-mock';

try {
  console.log('\n▶ 宿主原有功能不被影响');
  const home = await call('/');
  check('宿主首页仍然正常（HTML）', home.status === 200 && home.text.includes('我是宿主首页'), home.text.slice(0, 60));
  const posts = await call('/api/posts');
  check('宿主原有接口仍然正常', posts.status === 200 && posts.body.data.items.length === 2, JSON.stringify(posts.body).slice(0, 120));
  check('宿主收到的是自己的请求', hostHits.includes('GET /api/posts'));
  check('AI 请求没有落到宿主逻辑里', !hostHits.some((hit) => hit.includes('/api/ai')));

  console.log('\n▶ AI 接口被挂载（不需要改宿主路由表）');
  const status = await call('/api/ai/status');
  check('GET /api/ai/status → 200', status.status === 200 && status.body.data.configured === true, JSON.stringify(status.body));
  const anon = await call('/api/ai/ask', { method: 'POST', body: { question: '测试' } });
  check('未登录 → 401（不是 404，说明路由真的挂上了）', anon.status === 401 && anon.body.error.code === 'unauthenticated', JSON.stringify(anon.body));
  const unknown = await call('/api/ai/nope');
  check('不存在的 AI 子路径 → 404', unknown.status === 404, String(unknown.status));

  console.log('\n▶ 语料来自宿主的表（且自动忽略已删除帖子）');
  const before = mounted.store.corpusStats();
  const indexed = mounted.store.syncCorpus();
  check('索引到 2 篇未删除帖子', indexed.documents === 2, JSON.stringify(indexed));
  check('回复也被同步', indexed.replies === 1, JSON.stringify(indexed));
  const docs = mounted.store.corpusDocuments();
  check('文档带出标题与板块名', docs[0].title.includes('SQLite') && docs[0].board === '技术交流', JSON.stringify(docs[0]).slice(0, 160));
  check('已删除帖子没有进语料', !docs.some((doc) => doc.title.includes('已删除')));
  check('文档 id 是字符串（兼容通用包契约）', typeof docs[0].id === 'string');
  check('宿主表没有被写入 AI 字段', !db.prepare('PRAGMA table_info(posts)').all().some((col) => col.name.startsWith('ai_')));

  console.log('\n▶ 语料检索（标题 + 正文）');
  const searchBody = await call('/api/ai/search?q=keyset', { cookie: 'forum_sid=alice-token' });
  check('登录后检索 → 200', searchBody.status === 200, JSON.stringify(searchBody.body).slice(0, 160));
  check(
    '正文命中也能搜到（不只是标题）',
    searchBody.body.data.total === 1 && searchBody.body.data.items[0].id === '2' && searchBody.body.data.items[0].inTitle === false,
    JSON.stringify(searchBody.body.data).slice(0, 200),
  );
  check('命中片段带着上下文与关键词', /keyset/.test(String(searchBody.body.data.items[0].snippet)), String(searchBody.body.data.items[0].snippet));
  const titleHit = await call('/api/ai/search?q=SQLite', { cookie: 'forum_sid=alice-token' });
  check(
    '标题命中的都算命中',
    titleHit.body.data.total === 2 && titleHit.body.data.items.every((item) => item.inTitle === true),
    JSON.stringify(titleHit.body.data.items.map((item) => item.id)),
  );
  const searchLimit = await call('/api/ai/search?q=SQLite&limit=1', { cookie: 'forum_sid=alice-token' });
  check('limit 只截返回条数、total 仍是全部命中', searchLimit.body.data.items.length === 1 && searchLimit.body.data.total === 2, JSON.stringify(searchLimit.body.data).slice(0, 120));
  const tooShort = await call('/api/ai/search?q=深', { cookie: 'forum_sid=alice-token' });
  check('一个字不搜（minLength=2）', tooShort.body.data.total === 0 && tooShort.body.data.minLength === 2, JSON.stringify(tooShort.body.data).slice(0, 120));
  const searchAnon = await call('/api/ai/search?q=SQLite');
  check('未登录检索 → 401', searchAnon.status === 401, String(searchAnon.status));

  console.log('\n▶ 解读（普通用户）');
  const analyze = await call('/api/ai/posts/1/analyze', { method: 'POST', body: {}, cookie: 'forum_sid=alice-token' });
  check('登录后解读 → 200', analyze.status === 200, JSON.stringify(analyze.body).slice(0, 200));
  const review = analyze.body.data?.review;
  check('解读字段完整', review?.category === '数据库' && review.difficulty === '进阶' && review.tags.includes('SQLite'), JSON.stringify(review).slice(0, 200));
  check('前置知识解析正确', review.prereq[0].name === 'JavaScript');
  check(
    '编号真实的推荐保留、只剩标题的编造条目被丢掉',
    review.recommend.some((item) => item.documentId === 2) &&
      review.recommend.every((item) => item.documentId || item.wikiId) &&
      !review.recommend.some((item) => item.title === '编造的手册'),
    JSON.stringify(review.recommend),
  );
  check('推荐池在冷启动时不再为空（未解读的帖子也能被推荐）', /可推荐的站内帖子[\s\S]*\[#2\]/.test(String(mock.prompts.at(-1))), String(mock.prompts.at(-1)).slice(-160).replace(/\n/g, ' | '));
  check('宿主没有积木表时，Wiki 词条清单退化成空', /【站内 Wiki 词条】\n（这篇没有匹配到站内 Wiki 词条）/.test(String(mock.prompts.at(-1))), String(mock.prompts.at(-1)).slice(-120).replace(/\n/g, ' | '));

  const cached = await call('/api/ai/posts/1');
  check('缓存可读回且未过期', cached.status === 200 && cached.body.data.cached.category === '数据库' && cached.body.data.stale === false, JSON.stringify(cached.body).slice(0, 160));

  console.log('\n▶ 批量与全站整理（权限）');
  const memberBatch = await call('/api/ai/posts/analyze-pending', { method: 'POST', body: {}, cookie: 'forum_sid=alice-token' });
  check('普通用户批量 → 403', memberBatch.status === 403, String(memberBatch.status));
  const adminBatch = await call('/api/ai/posts/analyze-pending', { method: 'POST', body: { limit: 5 }, cookie: 'forum_sid=admin-token' });
  check('管理员批量 → 200 并处理剩余', adminBatch.status === 200 && adminBatch.body.data.processed >= 1, JSON.stringify(adminBatch.body.data).slice(0, 160));
  const siteAnalyze = await call('/api/ai/site/analyze', { method: 'POST', body: {}, cookie: 'forum_sid=admin-token' });
  check('全站整理 → 200', siteAnalyze.status === 200 && siteAnalyze.body.data.topics >= 1, JSON.stringify(siteAnalyze.body).slice(0, 160));
  const siteGet = await call('/api/ai/site', { cookie: 'forum_sid=alice-token' });
  check('读回整理结果带帖子对象', siteGet.status === 200 && siteGet.body.data.documents.length >= 1, JSON.stringify(siteGet.body.data).slice(0, 160));
  check('主题里带出文档编号（documentIds，兼容 postIds）', (siteGet.body.data.topics[0].documentIds ?? siteGet.body.data.topics[0].postIds ?? []).length >= 1, JSON.stringify(siteGet.body.data.topics[0]).slice(0, 200));
  const indexedNow = mounted.store.corpusStats();
  check('索引里的文档数与宿主帖子数一致', indexedNow.documents === 2, JSON.stringify(indexedNow));
  console.log('\n▶ 问答');
  const askOne = await call('/api/ai/ask', { method: 'POST', body: { question: '省掉了什么？', postId: 1 }, cookie: 'forum_sid=alice-token' });
  check('单篇问答 → 200 且 scope=post', askOne.status === 200 && askOne.body.data.scope === 'document', JSON.stringify(askOne.body).slice(0, 160));
  check('编造引用被过滤', askOne.body.data.citations.every((item) => item.postId !== 999999));
  const askAll = await call('/api/ai/ask', { method: 'POST', body: { question: '有哪些内容' }, cookie: 'forum_sid=alice-token' });
  check('全站问答 → scope=corpus', askAll.body.data.scope === 'corpus' && askAll.body.data.included >= 1, JSON.stringify(askAll.body.data).slice(0, 160));

  console.log('\n▶ 通用包的文档命名也能用（方便别的前端复用）');
  const docRoute = await call('/api/ai/documents/1', { cookie: 'forum_sid=alice-token' });
  check('GET /api/ai/documents/:id → 200', docRoute.status === 200 && docRoute.body.data.document.id === '1', JSON.stringify(docRoute.body).slice(0, 160));

  console.log('\n▶ 未配置密钥时的降级（重启一个未配置的连接）');
  const backupKey = process.env.AI_API_KEY;
  delete process.env.AI_API_KEY;
  const noKey = await call('/api/ai/posts/2/analyze', { method: 'POST', body: {}, cookie: 'forum_sid=alice-token' });
  check('未配置 → 503 ai_not_configured', noKey.status === 503 && noKey.body.error.code === 'ai_not_configured', JSON.stringify(noKey.body));
  // 这里直接查表，因为帖子 2 在批量解读阶段已经缓存过「成功」结果了
  const failedRows = db.prepare("SELECT COUNT(*) AS c FROM ai_document_reviews WHERE status = 'failed'").get().c;
  check('未配置不在缓存里写失败记录（避免脏数据）', failedRows === 0, `failed 行数=${failedRows}`);
  process.env.AI_API_KEY = backupKey;

  console.log('\n▶ wiki 页正文进语料（LOCAL PATCH K）');
  const wikiDb = new DatabaseSync(':memory:');
  wikiDb.exec(`
    CREATE TABLE posts (
      id INTEGER PRIMARY KEY, title TEXT, content TEXT,
      deleted INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE documents (
      id INTEGER PRIMARY KEY, title TEXT, template TEXT, scope TEXT,
      anchor_post_id INTEGER, deleted INTEGER DEFAULT 0, updated_at INTEGER
    );
    CREATE TABLE doc_settings (
      document_id INTEGER PRIMARY KEY, station_id INTEGER DEFAULT 0,
      source_text TEXT DEFAULT '', updated_at INTEGER
    );
  `);
  const pageAt = Date.now();
  wikiDb.exec(`
    INSERT INTO posts (id, title, content, created_at, updated_at) VALUES
      (1, '普通帖', '帖子正文', ${pageAt - 5000}, ${pageAt - 5000}),
      (2, '15-puzzle', '页面前 400 字的摘要', ${pageAt - 9000}, ${pageAt - 9000}),
      (3, '短页', '摘要比页正文长', ${pageAt - 9000}, ${pageAt - 9000});
    INSERT INTO documents (id, title, template, scope, anchor_post_id, updated_at) VALUES
      (10, '15-puzzle', 'page', 'public', 2, ${pageAt}),
      (11, '短页', 'page', 'public', 3, ${pageAt}),
      (12, '没有影子帖的页', 'page', 'public', 404, ${pageAt});
    INSERT INTO doc_settings (document_id, station_id, source_text, updated_at) VALUES
      (10, 23, '## 简介\n15-拼图的**整页正文**，比影子帖摘要长得多。', ${pageAt}),
      (11, 23, '短', ${pageAt}),
      (12, 23, '这是没有影子帖的页', ${pageAt});
  `);
  const pageSource = createForumDocumentSource(wikiDb, { contentLimit: 20000 })();
  const pageDoc = pageSource.find((doc) => doc.id === '2');
  const shortDoc = pageSource.find((doc) => doc.id === '3');
  const plainDoc = pageSource.find((doc) => doc.id === '1');
  check(
    'wiki 页的影子帖用整页正文（不再是前 400 字摘要）',
    pageDoc?.content.includes('整页正文') && !pageDoc.content.includes('前 400 字'),
    String(pageDoc?.content).slice(0, 60),
  );
  check('页面自己的修改时间进了 updatedAt（改页 → 旧解读回待整理）', pageDoc?.updatedAt === pageAt, String(pageDoc?.updatedAt));
  check('页正文比摘要短时保留摘要', shortDoc?.content === '摘要比页正文长', String(shortDoc?.content));
  check('页正文为空时不改影子帖', shortDoc?.updatedAt === pageAt);
  check('普通帖子一个字都没变', plainDoc?.content === '帖子正文' && plainDoc?.updatedAt === pageAt - 5000, JSON.stringify(plainDoc));
  check('影子帖不存在的页不会凭空多出一篇', pageSource.length === 3, String(pageSource.length));
  const noPageSource = createForumDocumentSource(db)();
  check('宿主没有积木表时语料照旧（只读 posts）', noPageSource[0].content.startsWith('node:sqlite'), String(noPageSource[0].content).slice(0, 40));
  wikiDb.close();

  console.log('\n▶ 清缓存');
  const cleared = await call('/api/ai/cache', { method: 'DELETE', cookie: 'forum_sid=admin-token' });
  check('DELETE /api/ai/cache → 200', cleared.status === 200 && cleared.body.data.cleared === true, JSON.stringify(cleared.body));
  check('清完后待整理回到全部', mounted.store.countPending() >= 2, String(mounted.store.countPending()));
  check('AI 调用确实发给了上游', mock.calls >= 4, String(mock.calls));
} catch (error) {
  console.error('集成测试异常终止：', error);
  failures.push(error.message);
} finally {
  hostServer.close();
  aiServer.close();
  db.close();
}

console.log(`\n${'─'.repeat(46)}`);
console.log(`通过 ${passed} 项，失败 ${failures.length} 项`);
if (failures.length) {
  for (const item of failures) console.log(`  · ${item}`);
  process.exit(1);
}
