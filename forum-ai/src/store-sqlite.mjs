/**
 * SQLite 存储适配层：缓存解读结果、全站报告，并维护一份「语料索引」。
 *
 * 与宿主解耦的关键设计：**本包不读宿主的业务表**。
 * 宿主提供一个 documentSource（同步或异步函数），返回文档数组：
 *
 *   const store = createAiStore({
 *     db,                                          // node:sqlite DatabaseSync 实例
 *     documentSource: () => store.corpusPosts(),    // 返回 [{ id, title, content, replies, ... }]
 *     tablePrefix: 'ai_',                           // 可选，默认 'ai_'
 *   });
 *   store.syncCorpus();                             // 把文档写入本包的索引表
 *
 * 索引表存的是「标题/摘要/正文/回复」的纯文本快照，用来算语料指纹、
 * 做关键词检索与装配提示词材料。业务数据变更后调用 syncCorpus() 即可。
 */
import { rankDocuments as rankDocs, selectForQuestion as selectDocs } from './ai.mjs';

const DEFAULT_PREFIX = 'ai_';

/** 语料指纹：任何文档新增/修改/回复都会改变它，用来判断缓存是否过期。 */
function fingerprintOf(documents) {
  let postCount = 0;
  let replyCount = 0;
  let latest = 0;
  let chars = 0;
  for (const doc of documents) {
    postCount += 1;
    chars += String(doc.content ?? '').length;
    latest = Math.max(latest, Number(doc.updatedAt ?? doc.createdAt ?? 0));
    for (const reply of doc.replies ?? []) {
      replyCount += 1;
      latest = Math.max(latest, Number(reply.createdAt ?? 0));
    }
  }
  return `${postCount}:${latest}:${replyCount}:${chars}`;
}

export function createAiStore({ db, documentSource, tablePrefix = DEFAULT_PREFIX } = {}) {
  if (!db) throw new Error('createAiStore 需要 db（node:sqlite 的 DatabaseSync 实例）');
  if (typeof documentSource !== 'function') throw new Error('createAiStore 需要 documentSource()，用来提供文档列表');
  const P = tablePrefix;

  db.exec(`
    CREATE TABLE IF NOT EXISTS ${P}document_reviews (
      document_id       TEXT PRIMARY KEY,
      status            TEXT    NOT NULL DEFAULT 'done',
      category          TEXT    NOT NULL DEFAULT '',
      difficulty        TEXT    NOT NULL DEFAULT '',
      summary           TEXT    NOT NULL DEFAULT '',
      tags_json         TEXT    NOT NULL DEFAULT '[]',
      prereq_json       TEXT    NOT NULL DEFAULT '[]',
      recommend_json    TEXT    NOT NULL DEFAULT '[]',
      model             TEXT    NOT NULL DEFAULT '',
      content_hash      TEXT    NOT NULL DEFAULT '',
      prompt_tokens     INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      error             TEXT    NOT NULL DEFAULT '',
      error_detail      TEXT    NOT NULL DEFAULT '',
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_${P}reviews_category ON ${P}document_reviews(category);

    CREATE TABLE IF NOT EXISTS ${P}corpus_reports (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      status            TEXT    NOT NULL DEFAULT 'done',
      topics_json       TEXT    NOT NULL DEFAULT '[]',
      reading_path_json TEXT    NOT NULL DEFAULT '[]',
      summary           TEXT    NOT NULL DEFAULT '',
      document_count    INTEGER NOT NULL DEFAULT 0,
      model             TEXT    NOT NULL DEFAULT '',
      corpus_hash       TEXT    NOT NULL DEFAULT '',
      prompt_tokens     INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      error             TEXT    NOT NULL DEFAULT '',
      created_by        TEXT,
      created_at        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_${P}reports_created ON ${P}corpus_reports(created_at DESC);

    CREATE TABLE IF NOT EXISTS ${P}corpus_index (
      document_id  TEXT PRIMARY KEY,
      title        TEXT NOT NULL DEFAULT '',
      content      TEXT NOT NULL DEFAULT '',
      replies_json TEXT NOT NULL DEFAULT '[]',
      meta_json    TEXT NOT NULL DEFAULT '{}',
      reply_count  INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL DEFAULT 0,
      updated_at   INTEGER NOT NULL DEFAULT 0
    );
  `);

  // 旧库升级：`error_detail` 是后来加的列，`CREATE TABLE IF NOT EXISTS` 不会补，得自己 ALTER。
  // （存的是模型原始输出的开头一段 —— 失败时只有一句「不是合法 JSON」根本判断不出是截断还是格式错。）
  const reviewColumns = new Set(
    db.prepare(`PRAGMA table_info(${P}document_reviews)`).all().map((row) => row.name),
  );
  if (!reviewColumns.has('error_detail')) {
    db.exec(`ALTER TABLE ${P}document_reviews ADD COLUMN error_detail TEXT NOT NULL DEFAULT ''`);
  }

  const statements = {
    reviewByDoc: db.prepare(`SELECT * FROM ${P}document_reviews WHERE document_id = ?`),
    reviewsByIds: db.prepare(`SELECT * FROM ${P}document_reviews`),
    upsertReview: db.prepare(`
      INSERT INTO ${P}document_reviews
        (document_id, status, category, difficulty, summary, tags_json, prereq_json, recommend_json,
         model, content_hash, prompt_tokens, completion_tokens, error, error_detail, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(document_id) DO UPDATE SET
        status = excluded.status, category = excluded.category, difficulty = excluded.difficulty,
        summary = excluded.summary, tags_json = excluded.tags_json, prereq_json = excluded.prereq_json,
        recommend_json = excluded.recommend_json, model = excluded.model, content_hash = excluded.content_hash,
        prompt_tokens = excluded.prompt_tokens, completion_tokens = excluded.completion_tokens,
        error = excluded.error, error_detail = excluded.error_detail, updated_at = excluded.updated_at`),
    deleteReview: db.prepare(`DELETE FROM ${P}document_reviews WHERE document_id = ?`),
    // LOCAL PATCH (see LOCAL-PATCHES.md): 旧库补齐逐篇指纹时用（见 backfillDocumentHashes）。
    setReviewHash: db.prepare(`UPDATE ${P}document_reviews SET content_hash = ? WHERE document_id = ?`),
    countDone: db.prepare(`SELECT COUNT(*) AS count FROM ${P}document_reviews WHERE status = 'done'`),
    countFailed: db.prepare(`SELECT COUNT(*) AS count FROM ${P}document_reviews WHERE status <> 'done'`),
    clearReviews: db.prepare(`DELETE FROM ${P}document_reviews`),
    insertReport: db.prepare(`
      INSERT INTO ${P}corpus_reports
        (status, topics_json, reading_path_json, summary, document_count, model, corpus_hash,
         prompt_tokens, completion_tokens, error, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    latestReport: db.prepare(`SELECT * FROM ${P}corpus_reports ORDER BY created_at DESC, id DESC LIMIT 1`),
    reportById: db.prepare(`SELECT * FROM ${P}corpus_reports WHERE id = ?`),
    clearReports: db.prepare(`DELETE FROM ${P}corpus_reports`),
    listIndex: db.prepare(`SELECT * FROM ${P}corpus_index ORDER BY document_id ASC`),
    upsertIndex: db.prepare(`
      INSERT INTO ${P}corpus_index (document_id, title, content, replies_json, meta_json, reply_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(document_id) DO UPDATE SET
        title = excluded.title, content = excluded.content, replies_json = excluded.replies_json,
        meta_json = excluded.meta_json, reply_count = excluded.reply_count, updated_at = excluded.updated_at`),
    indexIds: db.prepare(`SELECT document_id FROM ${P}corpus_index`),
    deleteIndex: db.prepare(`DELETE FROM ${P}corpus_index WHERE document_id = ?`),
  };

  const safeJson = (text, fallback) => {
    try {
      const value = JSON.parse(text ?? '');
      return value ?? fallback;
    } catch {
      return fallback;
    }
  };

  /** 索引行里「这一篇自己的内容时间」：正文更新时间与它自己的回复里最晚的一条。 */
  const latestContentAt = (row) => {
    let latest = Math.max(Number(row.updated_at ?? 0), Number(row.created_at ?? 0));
    for (const reply of safeJson(row.replies_json, [])) {
      latest = Math.max(latest, Number(reply.createdAt ?? 0));
    }
    return latest;
  };

  /** 索引行 → 这一篇自己的指纹（形状与 documentHash() 一致）。 */
  const fingerprintOfIndexRow = (row) =>
    fingerprintOf([
      {
        content: row.content,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        replies: safeJson(row.replies_json, []),
      },
    ]);

  const shapeReviewRow = (row) =>
    row && {
      documentId: row.document_id,
      status: row.status,
      category: row.category,
      difficulty: row.difficulty,
      summary: row.summary,
      tags: safeJson(row.tags_json, []),
      prereq: safeJson(row.prereq_json, []),
      recommend: safeJson(row.recommend_json, []),
      model: row.model,
      contentHash: row.content_hash,
      tokens: { prompt: row.prompt_tokens, completion: row.completion_tokens },
      error: row.status === 'done' ? '' : row.error,
      errorDetail: row.status === 'done' ? '' : (row.error_detail ?? ''),
      updatedAt: row.updated_at,
    };

  const shapeReportRow = (row) =>
    row && {
      id: row.id,
      status: row.status,
      summary: row.summary,
      topics: safeJson(row.topics_json, []),
      readingPath: safeJson(row.reading_path_json, []),
      documentCount: row.document_count,
      model: row.model,
      corpusHash: row.corpus_hash,
      tokens: { prompt: row.prompt_tokens, completion: row.completion_tokens },
      error: row.status === 'done' ? '' : row.error,
      createdAt: row.created_at,
    };

  const api = {
    /* ---------------- 语料索引 ---------------- */

    /** 从宿主拉取文档并写入索引表（删除已不存在的文档）。返回索引统计。 */
    syncCorpus() {
      const documents = documentSource();
      if (!Array.isArray(documents)) throw new Error('documentSource() 必须返回数组');
      const now = Date.now();
      const keep = new Set();

      for (const doc of documents) {
        const id = String(doc.id);
        keep.add(id);
        const { content, ...meta } = doc;
        statements.upsertIndex.run(
          id,
          String(doc.title ?? ''),
          String(content ?? doc.text ?? ''),
          JSON.stringify(doc.replies ?? []),
          JSON.stringify(meta),
          Number(doc.replyCount ?? doc.replies?.length ?? 0),
          Number(doc.createdAt ?? 0),
          Number(doc.updatedAt ?? doc.createdAt ?? now),
        );
      }
      for (const row of statements.indexIds.all()) {
        if (!keep.has(String(row.document_id))) statements.deleteIndex.run(row.document_id);
      }
      return api.corpusStats();
    },

    /** 索引里的文档（默认带正文与回复），结构可直接喂给 ai.mjs。 */
    corpusDocuments({ withContent = true, withReplies = true, ids = null } = {}) {
      const keep = ids ? new Set(ids.map(String)) : null;
      return statements.listIndex
        .all()
        .filter((row) => !keep || keep.has(String(row.document_id)))
        .map((row) => {
          const meta = safeJson(row.meta_json, {});
          const replies = withReplies ? safeJson(row.replies_json, []) : [];
          return {
            ...meta,
            id: row.document_id,
            title: row.title,
            content: withContent ? row.content : '',
            replies,
            replyCount: row.reply_count,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          };
        });
    },

    corpusStats() {
      const rows = statements.listIndex.all();
      let replies = 0;
      let chars = 0;
      let updatedAt = 0;
      for (const row of rows) {
        replies += Number(row.reply_count);
        chars += String(row.content ?? '').length;
        updatedAt = Math.max(updatedAt, Number(row.updated_at));
      }
      return { documents: rows.length, replies, chars, updatedAt };
    },

    corpusHash() {
      return fingerprintOf(api.corpusDocuments({ withContent: true, withReplies: true }));
    },

    /*
     * LOCAL PATCH (see LOCAL-PATCHES.md): 每篇自己的指纹。
     *
     * 上游把**整站语料指纹**写进每一篇解读（`{ contentHash: store.corpusHash() }`），
     * 于是任何一篇帖子或一条回复动过，全站所有旧解读都算「内容已变」——
     * 「待整理」永远等于全站总数，页面上的黄色提示也一直亮着。
     * 这里按篇算指纹（同一篇的正文 / 自己的回复 / 更新时间），只给「这一篇自己变了」
     * 用；「整理全站」那份报告仍然是整站粒度，继续用 corpusHash()。
     */
    documentHashes(ids = null) {
      const hashes = new Map();
      for (const doc of api.corpusDocuments({ withContent: true, withReplies: true, ids })) {
        hashes.set(String(doc.id), fingerprintOf([doc]));
      }
      return hashes;
    },

    documentHash(documentId) {
      return api.documentHashes([documentId]).get(String(documentId)) ?? '';
    },

    /*
     * LOCAL PATCH (see LOCAL-PATCHES.md): 旧库一次性补齐逐篇指纹。
     *
     * 换成按篇判之后，老账里存的**整站**指纹（`564:1791433912605:3:192568`）全都对不上，
     * 「待整理」还是等于全站总数 —— 光改判据不够，得把这些老账改写成逐篇指纹。
     * 旧值反推不出「这一篇当时」的指纹，只能拿时间戳判：
     *   这篇自己（正文 + 它自己的回复）在最后一次解读之后没动过 → 补上当前逐篇指纹；
     *   动过 → 保留旧值，继续算「内容已变」（宁可多问一次，也不假装它没过期）。
     * 逐篇指纹一定以 `1:` 开头（只算一篇），所以这条迁移天然幂等：跑过一次就不再动它。
     * 返回补了几篇。
     */
    backfillDocumentHashes() {
      const legacy = statements.reviewsByIds
        .all()
        .filter((row) => row.content_hash && !String(row.content_hash).startsWith('1:'));
      if (legacy.length === 0) return 0;
      const index = new Map(statements.listIndex.all().map((row) => [String(row.document_id), row]));
      let repaired = 0;
      for (const review of legacy) {
        const row = index.get(String(review.document_id));
        if (!row) continue; // 索引里没有它（已被删）→ 交给「从未解读 / 已消失」那套逻辑
        const reviewAt = Number(review.updated_at || review.created_at || 0);
        if (reviewAt <= 0 || latestContentAt(row) > reviewAt) continue;
        statements.setReviewHash.run(fingerprintOfIndexRow(row), String(review.document_id));
        repaired += 1;
      }
      return repaired;
    },

    /* ---------------- 单篇解读缓存 ---------------- */

    reviewOf(documentId) {
      return shapeReviewRow(statements.reviewByDoc.get(String(documentId))) ?? null;
    },

    reviewsFor(ids = []) {
      const keep = new Set(ids.map(String));
      return statements.reviewsByIds
        .all()
        .filter((row) => keep.has(String(row.document_id)))
        .map(shapeReviewRow);
    },

    saveReview(review = {}, { contentHash = '' } = {}) {
      const now = Date.now();
      statements.upsertReview.run(
        String(review.documentId),
        review.status ?? 'done',
        review.category ?? '',
        review.difficulty ?? '',
        review.summary ?? '',
        JSON.stringify(review.tags ?? []),
        JSON.stringify(review.prereq ?? []),
        JSON.stringify(review.recommend ?? []),
        review.model ?? '',
        contentHash,
        Number(review.tokens?.prompt ?? 0),
        Number(review.tokens?.completion ?? 0),
        review.error ?? '',
        review.errorDetail ?? '',
        now,
        now,
      );
      return api.reviewOf(review.documentId);
    },

    deleteReview(documentId) {
      return statements.deleteReview.run(String(documentId));
    },

    reviewStats() {
      return {
        analyzed: Number(statements.countDone.get().count),
        failed: Number(statements.countFailed.get().count),
        documents: api.corpusStats().documents,
      };
    },

    /**
     * 待整理的文档：解读失败 → 没解读过 → 内容已变化（**这一篇自己**变了，见 documentHashes）。
     *
     * 失败必须排在最前面：批量接口一次只取 `limit` 条（默认 10），大站动辄几百篇「没解读过」，
     * 排在它们后面的失败篇目**永远轮不到重试** —— 页面上那句「解读失败」就再也消不掉了。
     * 「内容已变化」留在最后是有意的：它已经有解读可看，先把没解读过的补上更划算。
     */
    pendingDocuments({ limit = 10 } = {}) {
      // LOCAL PATCH (see LOCAL-PATCHES.md): 逐篇指纹，不是整站指纹（见 documentHashes）。
      const hashes = api.documentHashes();
      const reviews = new Map(
        statements.reviewsByIds.all().map((row) => [String(row.document_id), row]),
      );
      const never = [];
      const failed = [];
      const stale = [];
      for (const row of statements.listIndex.all()) {
        const review = reviews.get(String(row.document_id));
        if (!review) never.push(row.document_id);
        else if (review.status !== 'done') failed.push(row.document_id);
        else if (review.content_hash && review.content_hash !== hashes.get(String(row.document_id))) {
          stale.push(row.document_id);
        }
      }
      return [...failed, ...never, ...stale].slice(0, Math.max(1, limit));
    },

    countPending() {
      return api.pendingDocuments({ limit: Number.MAX_SAFE_INTEGER }).length;
    },

    /* ---------------- 全站报告 ---------------- */

    latestReport() {
      return shapeReportRow(statements.latestReport.get()) ?? null;
    },

    saveReport(report = {}, { corpusHash = '', createdBy = null } = {}) {
      const info = statements.insertReport.run(
        report.status ?? 'done',
        JSON.stringify(report.topics ?? []),
        JSON.stringify(report.readingPath ?? []),
        report.summary ?? '',
        Number(report.documentCount ?? 0),
        report.model ?? '',
        corpusHash,
        Number(report.tokens?.prompt ?? 0),
        Number(report.tokens?.completion ?? 0),
        report.error ?? '',
        createdBy == null ? null : String(createdBy),
        Date.now(),
      );
      return shapeReportRow(statements.reportById.get(Number(info.lastInsertRowid)));
    },

    /** 报告是否已过期（语料变过）。 */
    reportIsStale(report = api.latestReport()) {
      if (!report) return true;
      return report.corpusHash !== api.corpusHash();
    },

    clearAll() {
      const reviews = Number(statements.clearReviews.run().changes);
      const reports = Number(statements.clearReports.run().changes);
      return { reviews, reports };
    },

    /* ---------------- 检索 ---------------- */

    rankDocuments(question, documents = api.corpusDocuments()) {
      return rankDocs(question, documents);
    },

    selectForQuestion(question, options) {
      return selectDocs(question, api.corpusDocuments(), options);
    },
  };

  // LOCAL PATCH (see LOCAL-PATCHES.md): 老库里的整站指纹在这里一次性换成逐篇指纹（幂等）。
  api.backfillDocumentHashes();

  return api;
}
