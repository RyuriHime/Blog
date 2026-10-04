/**
 * 把「AI 阅读助手」挂到任意已存在的论坛 server 上 —— 不需要改宿主的业务代码。
 *
 * 宿主只需要在 server.js 里加两行：
 *
 *   import { mountForumAi } from '../forum-ai/src/mount.mjs';
 *   mountForumAi({ db, resolveUser, baseDir: ROOT, aiDir: join(ROOT, 'forum-ai') });
 *
 * 本模块自己负责：
 *   - 建自己的 AI 缓存表（CREATE TABLE IF NOT EXISTS，只增不改，不动宿主任何表）
 *   - 从宿主的 posts / replies / users / boards 表读语料（按表名探测，兼容不同版本）
 *   - 解析 forum_sid 会话（复用宿主传进来的 resolveUser）
 *   - 提供 8 个 /api/ai/* 接口 + 1 个 ai 状态字段
 *
 * 因此它对宿主代码的侵入只有 2 行 import/调用。
 */
import { createAiHandlers } from './routes.mjs';
import { createAiStore } from './store-sqlite.mjs';
import { aiStatus } from './ai.mjs';

/** 极简 cookie 解析。 */
function parseCookies(header) {
  const out = new Map();
  for (const part of String(header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    out.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  return out;
}

/** 读取 JSON 请求体（带大小上限，避免被塞爆内存）。 */
export function readJsonBody(req, { limit = 256 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('请求体过大'), { status: 413, code: 'payload_too_large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { status: 400, code: 'bad_json' }));
      }
    });
    req.on('error', reject);
  });
}

const json = (res, status, body) => {
  if (res.headersSent) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
};

/**
 * 表名探测：不同版本的论坛表名/列名可能略有差异，这里按候选名逐个试。
 * @returns {string|null}
 */
function pickTable(db, candidates) {
  for (const name of candidates) {
    try {
      db.prepare(`SELECT 1 FROM ${name} LIMIT 1`).get();
      return name;
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

function columnsOf(db, table) {
  try {
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
  } catch {
    return new Set();
  }
}

/**
 * 论坛数据 → 通用文档数组。只读，不写宿主任何表。
 */
export function createForumDocumentSource(db, { contentLimit = 20000 } = {}) {
  const schema = {
    posts: pickTable(db, ['posts']),
    replies: pickTable(db, ['replies']),
    users: pickTable(db, ['users']),
    boards: pickTable(db, ['boards']),
  };
  if (!schema.posts) throw new Error('mountForumAi: 没有找到 posts 表，无法读取语料');
  const postCols = columnsOf(db, schema.posts);
  const userCols = schema.users ? columnsOf(db, schema.users) : new Set();
  const boardCols = schema.boards ? columnsOf(db, schema.boards) : new Set();

  const deletedFilter = postCols.has('deleted') ? 'AND p.deleted = 0' : '';
  const select = [
    'p.id AS id',
    'p.title AS title',
    `substr(p.content, 1, ${Number(contentLimit)}) AS content`,
    postCols.has('created_at') ? 'p.created_at AS created_at' : '0 AS created_at',
    postCols.has('updated_at') ? 'p.updated_at AS updated_at' : 'p.created_at AS updated_at',
    postCols.has('board_id') ? 'p.board_id AS board_id' : 'NULL AS board_id',
    postCols.has('user_id') ? 'p.user_id AS user_id' : 'NULL AS user_id',
  ];

  const joins = [];
  if (schema.boards && boardCols.has('name') && postCols.has('board_id')) {
    joins.push(`LEFT JOIN ${schema.boards} b ON b.id = p.board_id`);
    select.push('b.name AS board_name');
  }
  if (schema.users && userCols.has('display_name') && postCols.has('user_id')) {
    joins.push(`LEFT JOIN ${schema.users} u ON u.id = p.user_id`);
    select.push('u.display_name AS author_name');
  }

  const postsSql = `SELECT ${select.join(', ')} FROM ${schema.posts} p ${joins.join(' ')} WHERE 1=1 ${deletedFilter} ORDER BY p.id ASC`;
  const repliesSql = schema.replies
    ? `SELECT r.post_id AS post_id, r.content AS content, ${
        columnsOf(db, schema.replies).has('created_at') ? 'r.created_at' : '0'
      } AS created_at${schema.users && userCols.has('display_name') ? ', u.display_name AS author_name' : ''}
       FROM ${schema.replies} r${schema.users && userCols.has('display_name') ? ` LEFT JOIN ${schema.users} u ON u.id = r.user_id` : ''}
       WHERE ${columnsOf(db, schema.replies).has('deleted') ? 'r.deleted = 0' : '1=1'} ORDER BY r.id ASC`
    : null;

  return function documentSource() {
    const posts = db.prepare(postsSql).all();
    const byPost = new Map();
    if (repliesSql) {
      for (const reply of db.prepare(repliesSql).all()) {
        const id = String(reply.post_id);
        if (!byPost.has(id)) byPost.set(id, []);
        byPost.get(id).push({
          content: String(reply.content ?? ''),
          author: reply.author_name ?? '',
          createdAt: Number(reply.created_at ?? 0),
        });
      }
    }
    return posts.map((row) => ({
      id: String(row.id),
      title: String(row.title ?? ''),
      content: String(row.content ?? ''),
      board: row.board_name ?? '',
      author: row.author_name ?? '',
      createdAt: Number(row.created_at ?? 0),
      updatedAt: Number(row.updated_at ?? 0),
      replies: byPost.get(String(row.id)) ?? [],
      replyCount: (byPost.get(String(row.id)) ?? []).length,
    }));
  };
}

/**
 * 挂载 AI 助手。
 *
 * @param {object} options
 * @param {object} options.db                    node:sqlite 的 DatabaseSync（宿主的连接）
 * @param {Function} options.resolveUser         (req) => { user, sessionToken }，宿主自己的会话解析
 * @param {string} [options.basePath='/api/ai']  AI 接口前缀
 * @param {boolean} [options.handleSetup=true]   是否自己处理请求/响应（true 时返回一个 attach 函数）
 * @param {number} [options.batchLimit=10]       批量解读单次上限
 * @param {boolean} [options.quiet=true]         是否打印挂载日志
 * @returns {{ handlers: object, match(method, pathname): object|null, attach(server): object }}
 */
export function mountForumAi({
  db,
  resolveUser,
  basePath = '/api/ai',
  handleSetup = true,
  batchLimit = 10,
  quiet = true,
  tablePrefix = 'ai_',
  // LOCAL PATCH (see LOCAL-PATCHES.md): the shipped mount layer never calls
  // store.syncCorpus(), so ai_corpus_index stays empty and every AI endpoint
  // answers 404 / 400. We re-index on every AI request instead of throttling:
  // corpusHash() is derived from the index table, so the sync has to be current
  // before any staleness check, otherwise changed content is reported as fresh.
  //
  // LOCAL PATCH (see LOCAL-PATCHES.md): upstream is inconsistent about the
  // `scope` label. Its mount selftest asserts the generic vocabulary
  // ('document' | 'corpus'), while its forum smoke test asserts the forum
  // vocabulary ('post' | 'site'). Since the two suites mount their own server,
  // make the choice explicit instead of silently breaking one of them.
  scopeVocabulary = 'generic',
} = {}) {
  if (!db) throw new Error('mountForumAi 需要 db（宿主已有的 node:sqlite 连接）');
  if (typeof resolveUser !== 'function') {
    throw new Error('mountForumAi 需要 resolveUser(req)，直接传宿主 server.js 里已有的那个函数即可');
  }

  const store = createAiStore({ db, documentSource: createForumDocumentSource(db), tablePrefix });

  const getDocument = (id) => store.corpusDocuments({ withContent: true, withReplies: true, ids: [id] })[0] ?? null;

  const handlers = createAiHandlers({
    store,
    getDocument,
    currentUser: (ctx) => ctx.user ?? null,
    isAdmin: (ctx) => String(ctx.user?.role ?? '') === 'admin' || String(ctx.user?.role ?? '') === 'owner',
    batchLimit,
    normalizeId: (id) => String(id),
  });

  // 路由表（顺序敏感：静态段要排在 :id 之前）
  const routes = [
    ['GET', `${basePath}/status`, handlers.status, false],
    ['GET', `${basePath}/posts/:id`, handlers.getReview, true],
    ['POST', `${basePath}/posts/:id/analyze`, handlers.analyzeDocument, true],
    ['POST', `${basePath}/posts/analyze-pending`, handlers.analyzePending, true],
    ['GET', `${basePath}/site`, handlers.getCorpusReport, true],
    ['POST', `${basePath}/site/analyze`, handlers.analyzeCorpus, true],
    ['DELETE', `${basePath}/site`, handlers.clearCache, true],
    ['DELETE', `${basePath}/cache`, handlers.clearCache, true],
    ['POST', `${basePath}/ask`, handlers.ask, true],
    // 兼容通用包的文档命名，方便别的前端复用同一套接口
    ['GET', `${basePath}/documents/:id`, handlers.getReview, true],
    ['POST', `${basePath}/documents/:id/analyze`, handlers.analyzeDocument, true],
    ['POST', `${basePath}/documents/analyze-pending`, handlers.analyzePending, true],
    ['GET', `${basePath}/corpus`, handlers.getCorpusReport, true],
    ['POST', `${basePath}/corpus/analyze`, handlers.analyzeCorpus, true],
  ].map(([method, pattern, handler, needsParams]) => {
    const keys = [];
    const regex = new RegExp(
      `^${pattern.replace(/:([A-Za-z_]+)/g, (_m, key) => {
        keys.push(key);
        return '([^/]+)';
      })}$`,
    );
    return { method, regex, keys, handler, needsParams };
  });

  function match(method, pathname) {
    for (const entry of routes) {
      if (entry.method !== method) continue;
      const hit = entry.regex.exec(pathname);
      if (!hit) continue;
      const params = entry.needsParams
        ? Object.fromEntries(entry.keys.map((key, index) => [key, decodeURIComponent(hit[index + 1])]))
        : {};
      return { handler: entry.handler, params };
    }
    return null;
  }

  const isAiPath = (pathname) => pathname === `${basePath}/status` || pathname.startsWith(`${basePath}/`);

  /**
   * 自己处理请求：包住宿主的 request listener，在本包路径上短路。
   * 宿主代码只需要：
   *   const server = http.createServer(async (req, res) => { ...原有逻辑... });
   *   mountForumAi({ db, resolveUser }).attach(server);
   */
  /* LOCAL PATCH: forum flavour aliases.
   *
   * The mount layer speaks the generic vocabulary (document / documentId /
   * documents) and answers with scope 'document' | 'corpus', while the forum UI
   * and the forum smoke tests speak the forum vocabulary (post / postId / posts)
   * and expect scope 'post' | 'site'. Upstream bridges the two inside src/ai.js,
   * but that adapter belongs to the host-integration path and is never loaded on
   * this route. Instead of editing the frontend and the tests, alias the
   * outgoing payload once, at the single response point in attach(). Aliasing is
   * additive and idempotent: every generic key is kept, and the forum spellings
   * are added alongside. The only exception is the `scope` label, which has a
   * different value per vocabulary and so is switched by scopeVocabulary.
   */
  const SCOPE_ALIAS = scopeVocabulary === 'forum' ? { document: 'post', corpus: 'site' } : {};

  function asPostId(value) {
    if (typeof value === 'number') return value;
    const text = String(value ?? '');
    return /^\d+$/.test(text) ? Number(text) : value;
  }

  function forumAlias(value, seen = new Set()) {
    if (!value || typeof value !== 'object') return value;
    if (seen.has(value)) return value;
    seen.add(value);

    if (Array.isArray(value)) {
      for (const item of value) forumAlias(item, seen);
      return value;
    }

    for (const key of Object.keys(value)) forumAlias(value[key], seen);

    // documentId <-> postId (both spellings, so either reader finds it)
    if (value.documentId !== undefined && value.postId === undefined) value.postId = asPostId(value.documentId);
    if (value.postId !== undefined && value.documentId === undefined) value.documentId = asPostId(value.postId);

    // documents -> posts (an array of documents, or a plain count)
    if (value.documents !== undefined && value.posts === undefined) value.posts = value.documents;

    // document -> post (single document object)
    if (value.document && typeof value.document === 'object' && value.post === undefined) value.post = value.document;

    // Post briefs carry a bare `id`; the UI resolves links through postId.
    if (value.id !== undefined && value.title !== undefined && value.postId === undefined) {
      value.postId = asPostId(value.id);
      value.documentId = asPostId(value.id);
    }

    if (typeof value.scope === 'string' && SCOPE_ALIAS[value.scope]) value.scope = SCOPE_ALIAS[value.scope];

    return value;
  }

  function attach(server) {
    if (typeof server?.listeners !== 'function') throw new Error('attach(server) 需要传入 node:http 的 server 实例');
    const original = server.listeners('request').slice();
    server.removeAllListeners('request');

    server.on('request', async (req, res) => {
      let pathname = '/';
      try {
        pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
      } catch {
        /* 保持 '/' */
      }

      if (isAiPath(pathname)) {
        // LOCAL PATCH: re-index the host's posts so the AI endpoints have a
        // corpus to work with, and so corpusHash() reflects the current state
        // when staleness is checked. /status carries no corpus data and is
        // polled often, so it is skipped.
        if (pathname !== `${basePath}/status`) {
          try {
            store.syncCorpus();
          } catch (error) {
            console.error('[ai] syncCorpus failed:', error?.message ?? error);
          }
        }

        const hit = match(req.method, pathname);
        if (!hit) return json(res, 404, { ok: false, error: { code: 'not_found', message: ' AI 接口不存在' } });

        try {
          const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJsonBody(req) : {};
          const { user } = (await resolveUser(req)) ?? { user: null };
          const result = await hit.handler({
            req,
            res,
            params: hit.params,
            body,
            user: user ?? null,
          });
          // LOCAL PATCH: hand the payload to the forum flavour before serialising.
          if (result.body?.ok === true && result.body.data) forumAlias(result.body.data);
          return json(res, result.status ?? 200, result.body);
        } catch (error) {
          const status = Number(error?.status ?? 500);
          return json(res, status, {
            ok: false,
            error: { code: error?.code ?? 'internal_error', message: error?.message ?? '服务器内部错误' },
          });
        }
      }

      // 不是 AI 路径：交回宿主原有的 listener（可能有多个，按注册顺序调用，谁先响应算谁的）
      for (const listener of original) {
        if (res.writableEnded) break;
        await listener.call(server, req, res);
      }
    });

    if (!quiet) {
      console.log(`  → AI 阅读助手已挂载: ${basePath}/*（语料索引与缓存表前缀 ${tablePrefix}）`);
    }
    return { store, handlers, match, basePath };
  }

  return {
    store,
    handlers,
    match,
    isAiPath,
    status: () => aiStatus(),
    attach: handleSetup ? attach : undefined,
  };
}

/**
 * aiStatus 的轻量包装：给宿主的 /api/site 可以直接调用（同步、不查库）。
 */
export function forumAiStatus() {
  return aiStatus();
}
