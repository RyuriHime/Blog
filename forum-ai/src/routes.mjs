/**
 * HTTP 路由层：与框架无关的处理器集合。
 *
 * 每个 handler 接收一个 context，返回 { status, body }，不碰 req/res，
 * 因此可以直接挂到原生 node:http，也可以包成 Express/Koa/Fastify 的中间件。
 *
 * 约定（与格社一致，宿主可按需改）：
 *   成功 { ok: true, data }
 *   失败 { ok: false, error: { code, message } }
 *
 * 挂载示例（原生 http）见 README 的「接入自己的后端」一节。
 */
import {
  AiError,
  aiStatus,
  reviewDocument,
  reviewCorpus,
  answerQuestion,
  selectForQuestion,
} from './ai.mjs';

/** AI 错误码 → HTTP 状态码。 */
export const AI_ERROR_STATUS = {
  ai_not_configured: 503,
  ai_timeout: 504,
  ai_rate_limited: 429,
  ai_unauthorized: 502,
  ai_unreachable: 502,
  ai_upstream_error: 502,
  ai_bad_response: 502,
  ai_empty_response: 502,
  ai_bad_json: 502,
};

export const ok = (data, headers) => ({ status: 200, body: { ok: true, data }, headers });
export const fail = (status, code, message) => ({ status, body: { ok: false, error: { code, message } } });

const errorText = (error) => String(error?.message ?? error).slice(0, 300);

/**
 * 失败时模型原始输出的开头一段（`ai.mjs` 在 `ai_bad_json` 上挂在 `details.rawOutput`）。
 * 存进缓存的 `errorDetail` 列：下次再出现「不是合法 JSON」，能直接看出是截断还是格式错，
 * 不用再去猜（失败记录里只有一句错误文案是查不出原因的）。
 */
const errorDetailText = (error) => String(error?.details?.rawOutput ?? '').slice(0, 600);

/**
 * 上游空响应的现场：`ai_empty_response` 会把 `finish_reason` 与用量挂在 details 上。
 *
 * 报告表没有 `error_detail` 列（有意不动表结构），所以把这点线索拼进 error 文案 ——
 * 只留一句「AI 接口没有返回内容」是分不清「被限流」「被截断」还是「提示词太长」的。
 */
const errorHint = (error) => {
  const reason = String(error?.details?.finishReason ?? '');
  const prompt = Number(error?.details?.usage?.prompt ?? 0);
  const completion = Number(error?.details?.usage?.completion ?? 0);
  const reasoning = error?.details?.hadReasoning ? '，模型只产出了思考内容' : '';
  if (!reason && !prompt && !completion) return '';
  return `（finish_reason=${reason || '无'}，提示 ${prompt} / 生成 ${completion} tokens${reasoning}）`;
};

/** 把任意异常收敛成统一响应。 */
export function toResponse(error) {
  if (error instanceof AiError) {
    const status = AI_ERROR_STATUS[error.code] ?? 502;
    return fail(status, error.code, error.message);
  }
  if (error && typeof error.status === 'number' && error.code) {
    return fail(error.status, error.code, error.message);
  }
  return fail(500, 'internal_error', errorText(error) || '服务器内部错误');
}

/** 宿主必须提供的上下文校验。 */
function requireContext(deps, names) {
  for (const name of names) {
    if (typeof deps?.[name] !== 'function') {
      throw new Error(`AI 路由需要 context.${name}()，请检查挂载配置`);
    }
  }
}

/**
 * 生成全部 AI 路由处理器。
 *
 * @param {object} deps
 * @param {object} deps.store            createAiStore() 的返回值
 * @param {(req:object) => Promise<object>|object} deps.getDocument  按 id 取单个文档
 * @param {(ctx:object) => object|null} deps.currentUser             当前用户（未登录返回 null）
 * @param {(ctx:object) => boolean} [deps.isAdmin]                   是否管理员
 * @param {(ctx:object) => (void|Promise<void>)} [deps.beforeWrite]  写操作前的钩子（限流、审计）
 * @param {(id:string) => string} [deps.normalizeId]                 文档 id 归一化
 * @param {number} [deps.batchLimit]                                 批量解读单次上限，默认 10
 * @param {() => Array<object>} [deps.wikiPages]                     站内 Wiki 词条（`{ id, title, anchorPostId? }`，id 是文档编号）
 * @param {object} [deps.env]                                        AI 配置来源，默认 process.env
 * @returns {object} 处理器集合
 */
export function createAiHandlers(deps = {}) {
  const {
    store,
    getDocument,
    currentUser,
    isAdmin = () => false,
    beforeWrite = async () => {},
    normalizeId = (id) => String(id),
    batchLimit = 10,
    wikiPages = () => [],
    env = process.env,
  } = deps;

  // deps.store 是 createAiStore() 返回的对象，其余三个必须是函数
  requireContext(deps, ['getDocument', 'currentUser']);
  if (!store) throw new Error('AI 路由需要 context.store（createAiStore() 的返回值）');  for (const method of ['reviewOf', 'saveReview', 'pendingDocuments', 'corpusDocuments', 'corpusHash']) {
    if (typeof store?.[method] !== 'function') throw new Error(`store 缺少方法 ${method}()`);
  }

  const requireUser = (ctx) => {
    const user = currentUser(ctx);
    if (!user) {
      const error = new Error('请先登录');
      error.status = 401;
      error.code = 'unauthenticated';
      throw error;
    }
    return user;
  };

  const requireAdmin = (ctx) => {
    const user = requireUser(ctx);
    if (!isAdmin(ctx)) {
      const error = new Error('需要管理员权限');
      error.status = 403;
      error.code = 'forbidden';
      throw error;
    }
    return user;
  };

  /**
   * 推荐池：解读过的文档优先（带摘要，模型更容易判断相关性），
   * 数量不够时用还没解读的文档补位（只有标题）。
   *
   * 冷启动时库里的文档都没解读过 —— 如果只认「已解读」，新站点的推荐阅读会全部是空的。
   *
   * 排除 wiki 页的影子帖：它们的阅读地址在 `#/doc/<编号>` 那边，
   * 走「站内 Wiki 词条」清单推荐（见 wikiPool），否则会被推荐成隐藏帖子。
   */
  function recommendPool(selfId, { limit = 12, minReviewed = 6 } = {}) {
    const wikiAnchors = new Set(wikiPageList().map((page) => String(page.anchorPostId ?? '')).filter(Boolean));
    const all = store
      .corpusDocuments({ withContent: false, withReplies: false })
      .filter((item) => String(item.id) !== String(selfId) && !wikiAnchors.has(String(item.id)));
    const reviewed = [];
    const unreviewed = [];
    for (const item of all) {
      const review = store.reviewOf(item.id);
      if (review?.status === 'done') reviewed.push({ ...item, summary: review.summary || item.summary || '' });
      else unreviewed.push(item);
    }
    const pool = [...reviewed];
    if (pool.length < minReviewed) pool.push(...unreviewed.slice(0, limit - pool.length));
    return pool.slice(0, limit);
  }

  /** 宿主给的站内 Wiki 词条清单（读库失败不该让解读整体失败）。 */
  function wikiPageList() {
    try {
      const list = typeof wikiPages === 'function' ? wikiPages() : [];
      return Array.isArray(list) ? list : [];
    } catch (error) {
      console.error('[ai] 读取站内 Wiki 词条失败:', error?.message ?? error);
      return [];
    }
  }

  /** 字符二元组重合数：中文没有空格，按二字窗口比对是最省事的相关度近似。 */
  function bigramOverlap(left, right) {
    if (!left || !right) return 0;
    const grams = (text) => {
      const out = new Set();
      for (let i = 0; i + 1 < text.length; i += 1) out.add(text.slice(i, i + 2));
      return out;
    };
    const a = grams(left);
    const b = grams(right);
    let hit = 0;
    for (const gram of a) if (b.has(gram)) hit += 1;
    return hit;
  }

  /**
   * 站内检索：从全部 Wiki 词条里挑出与本篇相关的若干条（不是「先从库里抓一批再让模型挑」，
   * 而是先按关键词命中排一遍序，模型的候选清单只放这些）。
   *
   * 打分口径：词条标题直接出现在本篇标题/正文里 +6；与本篇标题的二字重合 ×2。
   * 标题里没露出一丝痕迹的词条不进候选 —— 宁缺毋滥，反正提示词里也说了可以给空数组。
   */
  function wikiPool(doc, { limit = 24 } = {}) {
    const pages = wikiPageList();
    if (!pages.length) return [];
    const hay = `${doc?.title ?? ''}\n${doc?.content ?? ''}`.toLowerCase();
    const selfTitle = String(doc?.title ?? '').toLowerCase();
    const scored = [];
    for (const page of pages) {
      const title = String(page.title ?? '').trim();
      if (!title) continue;
      const key = title.toLowerCase();
      let score = 0;
      if (key.length >= 2 && hay.includes(key)) score += 6;
      score += bigramOverlap(key, selfTitle) * 2;
      if (score > 0) scored.push({ ...page, score });
    }
    scored.sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));
    return scored.slice(0, limit);
  }

  /** 单篇解读（逐篇接口与批量接口共用）。 */
  async function runReview(documentId) {
    const id = normalizeId(documentId);
    const doc = await getDocument(id);
    if (!doc) {
      const error = new Error(`文档 ${id} 不存在`);
      error.status = 404;
      error.code = 'not_found';
      throw error;
    }

    // LOCAL PATCH (see LOCAL-PATCHES.md): 记的是**这一篇自己**的指纹，
    // 不是整站语料指纹 —— 否则任何一篇别的帖子动过，这篇的解读也算过期。
    const contentHash = store.documentHash(id);
    const siblings = recommendPool(id);
    const wiki = wikiPool(doc);

    let analyzed;
    try {
      analyzed = await reviewDocument(doc, siblings, { chatOptions: { env }, wikiPages: wiki });
    } catch (error) {
      // 「没配密钥」是环境问题，不该污染这篇文档的缓存
      if (!(error instanceof AiError && error.code === 'ai_not_configured')) {
        store.saveReview(
          { documentId: id, status: 'failed', error: errorText(error), errorDetail: errorDetailText(error) },
          { contentHash },
        );
      }
      throw error;
    }

    const saved = store.saveReview(
      {
        documentId: id,
        status: 'done',
        ...analyzed.review,
        model: analyzed.model,
        tokens: analyzed.usage,
        error: '',
      },
      { contentHash },
    );
    return { documentId: id, title: doc.title, review: saved };
  }

  return {
    /** GET /api/ai/status —— 无需登录，前端用来决定是否显示配置提示。 */
    async status() {
      return ok(aiStatus(env));
    },

    /** GET /api/ai/documents/:id —— 读取某篇的缓存解读（含过期标记）。 */
    async getReview(ctx) {
      const id = normalizeId(ctx.params.id);
      const doc = await getDocument(id);
      if (!doc) return fail(404, 'not_found', '文档不存在或已删除');
      const cached = store.reviewOf(id);
      return ok({
        document: { id, title: doc.title },
        cached: cached ?? null,
        // LOCAL PATCH (see LOCAL-PATCHES.md): 逐篇比，见 store.documentHash。
        stale: Boolean(cached) && cached.contentHash !== store.documentHash(id),
      });
    },

    /** POST /api/ai/documents/:id/analyze —— 生成/刷新该篇解读。 */
    async analyzeDocument(ctx) {
      requireUser(ctx);
      await beforeWrite(ctx);
      try {
        return ok(await runReview(ctx.params.id));
      } catch (error) {
        return toResponse(error);
      }
    },

    /** POST /api/ai/documents/analyze-pending —— 批量解读（默认仅管理员）。 */
    async analyzePending(ctx) {
      requireAdmin(ctx);
      await beforeWrite(ctx);
      const requested = Number(ctx.body?.limit ?? batchLimit) || batchLimit;
      const limit = Math.min(Math.max(requested, 1), 50);
      const pending = store.pendingDocuments({ limit });
      const totalBefore = store.countPending();

      if (pending.length === 0) {
        return ok({
          processed: 0,
          failed: 0,
          remaining: 0,
          results: [],
          stats: { ...store.reviewStats(), pending: 0 },
        });
      }

      const results = [];
      for (const documentId of pending) {
        try {
          const done = await runReview(documentId);
          results.push({ documentId, title: done.title, status: 'done', category: done.review.category });
        } catch (error) {
          results.push({ documentId, status: 'failed', error: errorText(error), errorDetail: errorDetailText(error) });
          // 上游整体故障（超时/鉴权/不可达）时没必要把剩下的都试一遍
          if (error instanceof AiError && error.code !== 'ai_bad_json') {
            const response = toResponse(error);
            return {
              ...response,
              body: {
                ...response.body,
                data: {
                  processed: results.filter((item) => item.status === 'done').length,
                  failed: results.filter((item) => item.status !== 'done').length,
                  remaining: Math.max(0, totalBefore - results.filter((item) => item.status === 'done').length),
                  results,
                  stats: { ...store.reviewStats(), pending: store.countPending() },
                },
              },
              partial: true,
            };
          }
        }
      }

      const processed = results.filter((item) => item.status === 'done').length;
      return ok({
        processed,
        failed: results.length - processed,
        remaining: Math.max(0, totalBefore - processed),
        results,
        stats: { ...store.reviewStats(), pending: store.countPending() },
      });
    },

    /** GET /api/ai/corpus —— 全库整理结果 + 主题分组 + 阅读路线 + 统计。 */
    async getCorpusReport(ctx) {
      const report = store.latestReport();
      const stats = {
        ...store.reviewStats(),
        pending: store.countPending(),
        corpus: store.corpusStats(),
      };
      if (!report) return ok({ report: null, stale: true, stats, topics: [], readingPath: [], documents: [] });

      const orderedIds = [
        ...report.readingPath.map((step) => step.documentId),
        ...report.topics.flatMap((topic) => topic.documentIds ?? []),
      ].filter((id) => id !== null && id !== undefined);
      const uniqueIds = [...new Set(orderedIds.map(String))];
      const rows = store.corpusDocuments({ withContent: false, withReplies: false, ids: uniqueIds });
      const byId = new Map(rows.map((row) => [String(row.id), row]));

      const brief = (row) => {
        const review = store.reviewOf(row.id);
        return {
          id: row.id,
          title: row.title,
          board: row.board ?? row.meta?.board ?? '',
          author: row.author ?? '',
          replyCount: row.replyCount ?? 0,
          category: review?.category ?? '',
          difficulty: review?.difficulty ?? '',
          summary: review?.summary ?? '',
          tags: review?.tags ?? [],
        };
      };

      return ok({
        report,
        stale: store.reportIsStale(report),
        stats,
        topics: report.topics.map((topic) => ({
          ...topic,
          documents: (topic.documentIds ?? []).map((id) => byId.get(String(id))).filter(Boolean).map(brief),
        })),
        readingPath: report.readingPath
          .map((step) => {
            const row = byId.get(String(step.documentId));
            return row ? { ...step, document: brief(row) } : null;
          })
          .filter(Boolean),
        documents: rows.map(brief),
      });
    },

    /** POST /api/ai/corpus/analyze —— 重新整理全库（默认仅管理员）。 */
    async analyzeCorpus(ctx) {
      const user = requireAdmin(ctx);
      await beforeWrite(ctx);
      const documents = store.corpusDocuments({ withContent: true, withReplies: true });
      if (documents.length === 0) return fail(400, 'no_content', '当前没有可整理的文档');

      const corpusHash = store.corpusHash();
      try {
        const { report, model, usage, mode, chunks, included, failures } = await reviewCorpus(documents, { chatOptions: { env } });
        const saved = store.saveReport(
          { ...report, documentCount: documents.length, model, tokens: usage },
          { corpusHash, createdBy: user?.id ?? null },
        );
        return ok({
          report: saved,
          topics: report.topics.length,
          readingPath: report.readingPath.length,
          dropped: report.dropped,
          tokens: usage,
          // 这次是怎么问出来的：一次问完 / 只发目录 / 分块整理 —— 出问题时一眼能看出走的哪条路
          mode,
          included,
          ...(chunks ? { chunks } : {}),
          ...(Array.isArray(failures) && failures.length ? { failures } : {}),
        });
      } catch (error) {
        store.saveReport(
          { status: 'failed', error: `${errorText(error)}${errorHint(error)}` },
          { corpusHash, createdBy: user?.id ?? null },
        );
        return toResponse(error);
      }
    },

    /** DELETE /api/ai/corpus —— 清空整理缓存（解读 + 报告）。 */
    async clearCache(ctx) {
      requireAdmin(ctx);
      await beforeWrite(ctx);
      return ok({ cleared: true, ...store.clearAll() });
    },

    /** POST /api/ai/ask —— 问答，body { question, documentId? }。 */
    async ask(ctx) {
      requireUser(ctx);
      await beforeWrite(ctx);
      const question = String(ctx.body?.question ?? '').trim();
      if (question.length < 2) return fail(400, 'bad_request', '问题太短了');
      if (question.length > 500) return fail(400, 'bad_request', '问题太长了（最多 500 字）');

      const rawId = ctx.body?.documentId ?? ctx.body?.postId;
      const scope = rawId === undefined || rawId === null || rawId === '' ? 'corpus' : 'document';
      const documentId = scope === 'document' ? normalizeId(rawId) : null;

      let picked;
      let truncated = false;
      if (scope === 'document') {
        const doc = await getDocument(documentId);
        if (!doc) return fail(404, 'not_found', '文档不存在或已删除');
        picked = store.corpusDocuments({ withContent: true, withReplies: true, ids: [documentId] });
        if (picked.length === 0) picked = [doc];
      } else {
        const all = store.corpusDocuments({ withContent: true, withReplies: true });
        const selected = selectForQuestion(question, all);
        picked = selected.picked;
        truncated = picked.length < all.length;
      }

      try {
        const result = await answerQuestion(question, picked, { scope, chatOptions: { env } });
        return ok({
          scope,
          documentId,
          question,
          answer: result.answer.text,
          citations: result.answer.citations,
          notes: result.answer.notes,
          confidence: result.answer.confidence,
          droppedCitations: result.answer.droppedCitations,
          model: result.model,
          included: picked.length,
          truncated: truncated || result.truncated,
          tokens: result.usage,
        });
      } catch (error) {
        return toResponse(error);
      }
    },
  };
}

/**
 * 原生 node:http 挂载助手：把 handlers 里匹配到的处理器接到路径上。
 * @param {object} handlers createAiHandlers() 的结果
 * @param {{ prefix?: string }} [options]
 * @returns {(ctx: { method:string, pathname:string, params:object, body:object, raw?:object }) => Promise<object|null>}
 */
export function createAiRouter(handlers, { prefix = '/api/ai' } = {}) {
  const table = [
    ['GET', `${prefix}/status`, handlers.status, false],
    ['GET', `${prefix}/documents/:id`, handlers.getReview, true],
    ['POST', `${prefix}/documents/:id/analyze`, handlers.analyzeDocument, true],
    ['POST', `${prefix}/documents/analyze-pending`, handlers.analyzePending, true],
    ['GET', `${prefix}/corpus`, handlers.getCorpusReport, true],
    ['POST', `${prefix}/corpus/analyze`, handlers.analyzeCorpus, true],
    ['DELETE', `${prefix}/corpus`, handlers.clearCache, true],
    ['POST', `${prefix}/ask`, handlers.ask, true],
  ].map(([method, pattern, handler, needsParams]) => {
    const keys = [];
    const regex = new RegExp(
      `^${pattern.replace(/:([A-Za-z_]+)/g, (_match, key) => {
        keys.push(key);
        return '([^/]+)';
      })}$`,
    );
    return { method, regex, keys, handler, needsParams };
  });

  return async function route(ctx) {
    for (const entry of table) {
      if (entry.method !== ctx.method) continue;
      const match = entry.regex.exec(ctx.pathname);
      if (!match) continue;
      const params = entry.needsParams
        ? Object.fromEntries(entry.keys.map((key, index) => [key, decodeURIComponent(match[index + 1])]))
        : {};
      try {
        return await entry.handler({ ...ctx, params });
      } catch (error) {
        // 处理器直接抛出的错误（未登录、越权等）也收敛成统一响应，调用方不必再包 try/catch
        return toResponse(error);
      }
    }
    return null;
  };
}
