/**
 * note-agent 自己的 SQLite 存储层。
 *
 * 三条铁律（与 forum-ai 的 store-sqlite 同源）：
 *   1. **只增不改** —— 全部 `CREATE TABLE IF NOT EXISTS`，表名前缀 `notes_`，绝不碰宿主的 SCHEMA；
 *   2. **自己的连接** —— 复用宿主传进来的 `db` 句柄，但只操作 `notes_*` 表；
 *   3. **时间戳用 `Date.now()`**（宿主约定），不用 SQLite 的 `datetime()`。
 *
 * 所有方法都是同步的，与宿主 `createStore(db)` 的风格一致。
 */

const SCHEMA_VERSION = '1';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notes_sessions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL,
  post_id       INTEGER,
  title         TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'draft',
  draft_md      TEXT NOT NULL DEFAULT '',
  blocks_json   TEXT NOT NULL DEFAULT '[]',
  tags_json     TEXT NOT NULL DEFAULT '[]',
  material_chars INTEGER NOT NULL DEFAULT 0,
  source_count  INTEGER NOT NULL DEFAULT 0,
  model         TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_sessions_user ON notes_sessions(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS notes_materials (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  name        TEXT NOT NULL DEFAULT '',
  bytes       INTEGER NOT NULL DEFAULT 0,
  blocks_json TEXT NOT NULL DEFAULT '[]',
  images_json TEXT NOT NULL DEFAULT '[]',
  warnings_json TEXT NOT NULL DEFAULT '[]',
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_materials_session ON notes_materials(session_id);

CREATE TABLE IF NOT EXISTS notes_attachments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  name       TEXT NOT NULL,
  mime       TEXT NOT NULL DEFAULT 'application/octet-stream',
  bytes      INTEGER NOT NULL DEFAULT 0,
  path       TEXT,
  data_url   TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_attachments_session ON notes_attachments(session_id);

CREATE TABLE IF NOT EXISTS notes_messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    INTEGER NOT NULL,
  role          TEXT NOT NULL,
  requirement   TEXT NOT NULL DEFAULT '',
  draft_md      TEXT NOT NULL DEFAULT '',
  ops_json      TEXT NOT NULL DEFAULT '[]',
  skipped_json  TEXT NOT NULL DEFAULT '[]',
  warnings_json TEXT NOT NULL DEFAULT '[]',
  usage_json    TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_messages_session ON notes_messages(session_id);

CREATE TABLE IF NOT EXISTS notes_reviews (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    INTEGER,
  post_id       INTEGER,
  user_id       INTEGER NOT NULL,
  content_hash  TEXT NOT NULL,
  summary       TEXT NOT NULL DEFAULT '',
  findings_json TEXT NOT NULL DEFAULT '[]',
  model         TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_reviews_hash ON notes_reviews(user_id, content_hash);

-- 素材索引：会话内存里的图片资产映射（服务 /assets/:id 用）
CREATE TABLE IF NOT EXISTS notes_assets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  block_id   TEXT NOT NULL DEFAULT '',
  name       TEXT NOT NULL DEFAULT '',
  mime       TEXT NOT NULL DEFAULT '',
  bytes      INTEGER NOT NULL DEFAULT 0,
  path       TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_assets_session ON notes_assets(session_id, block_id);

-- 审查明细：每条 finding 的处置结果（便于面板显示"哪几条已应用"）
CREATE TABLE IF NOT EXISTS notes_review_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id  INTEGER NOT NULL,
  finding_id TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT '',
  severity   TEXT NOT NULL DEFAULT '',
  quote      TEXT NOT NULL DEFAULT '',
  applied    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_review_items_review ON notes_review_items(review_id);

-- 轮次日志：实时提需求的每一轮做成了什么
CREATE TABLE IF NOT EXISTS notes_turn_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER NOT NULL,
  requirement TEXT NOT NULL DEFAULT '',
  applied     INTEGER NOT NULL DEFAULT 0,
  skipped     INTEGER NOT NULL DEFAULT 0,
  needs_more  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_turn_logs_session ON notes_turn_logs(session_id);

-- 用量累计：按用户/会话累计 token，面板上显示"这轮花了多少"
CREATE TABLE IF NOT EXISTS notes_usage (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  session_id INTEGER,
  model      TEXT NOT NULL DEFAULT '',
  prompt     INTEGER NOT NULL DEFAULT 0,
  completion INTEGER NOT NULL DEFAULT 0,
  calls      INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_usage_user ON notes_usage(user_id, session_id);

-- 用户偏好：面板行为的少量开关（例如是否自动跑一遍学术审查）
CREATE TABLE IF NOT EXISTS notes_prefs (
  user_id    INTEGER NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
);

-- schema 版本：将来加列时靠它判断，不改动宿主 migrate()
CREATE TABLE IF NOT EXISTS notes_schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

function toJson(value, fallback) {
  try {
    const text = JSON.stringify(value ?? fallback);
    return typeof text === 'string' ? text : JSON.stringify(fallback);
  } catch {
    return JSON.stringify(fallback);
  }
}

function parseJson(text, fallback) {
  if (typeof text !== 'string' || text.length === 0) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/**
 * @param {{ db: object, tablePrefix?: string, materialChars?: number }} options
 */
export function createNotesStore({ db, tablePrefix = 'notes_', materialChars = 24000 } = {}) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('createNotesStore 需要一个 node:sqlite 的 DatabaseSync 实例');
  }
  const prefix = tablePrefix;
  const t = (name) => `${prefix}${name}`;

  /** 延迟 prepare：第一次用到某条语句时才编译，之后复用。 */
  const cache = new Map();
  function stmt(sql) {
    let prepared = cache.get(sql);
    if (!prepared) {
      prepared = db.prepare(sql);
      cache.set(sql, prepared);
    }
    return prepared;
  }

  function ensureSchema() {
    db.exec(SCHEMA);
    // 增量加列：老库里的 notes_messages 没有 draft_md（快照是后来才加的）。
    // `CREATE TABLE IF NOT EXISTS` 不会给已存在的表补列，所以这里显式查一次再 ALTER。
    // 刻意不动 SCHEMA_VERSION —— 数据形状向后兼容，老库加完列就能直接跑。
    const columns = db.prepare(`PRAGMA table_info(${t('messages')})`).all().map((row) => row.name);
    if (!columns.includes('draft_md')) {
      db.exec(`ALTER TABLE ${t('messages')} ADD COLUMN draft_md TEXT NOT NULL DEFAULT ''`);
      cache.clear(); // 之前 prepare 过的 SELECT * 缓存里没有这一列
    }
    stmt(`INSERT INTO ${t('schema_meta')} (key, value) VALUES ('version', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(SCHEMA_VERSION);
  }

  function sessionById(id) {
    return stmt(`SELECT * FROM ${t('sessions')} WHERE id = ?`).get(id) ?? null;
  }

  function sessionForUser(id, userId) {
    const row = stmt(`SELECT * FROM ${t('sessions')} WHERE id = ? AND user_id = ?`).get(id, userId);
    return row ?? null;
  }

  function listSessions(userId, { limit = 20 } = {}) {
    return stmt(`SELECT * FROM ${t('sessions')} WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?`)
      .all(userId, Math.max(1, Math.min(200, Number(limit) || 20)));
  }

  /**
   * 找一个用户在某篇帖子下的整理会话。
   *
   * 面板把它当"这篇帖子的工作台"用：草稿与材料都挂在这条会话上，所以同一篇帖子
   * 反复打开时应当复用同一条，而不是每次新建（否则材料要重传、历史会散成几十条）。
   * `postId` 为 0（新建帖子、还没有 id）时返回 null，由调用方决定要不要新建。
   */
  function sessionForPost(userId, postId) {
    const id = Number(postId);
    if (!Number.isInteger(id) || id <= 0) return null;
    return stmt(`SELECT * FROM ${t('sessions')} WHERE user_id = ? AND post_id = ? ORDER BY updated_at DESC LIMIT 1`)
      .get(userId, id) ?? null;
  }

  function createSession({ userId, postId = null, title = '', blocks = [], images = [], sources = [], materialChars: chars = 0, model = '' }) {
    const now = Date.now();
    const info = stmt(`INSERT INTO ${t('sessions')}
      (user_id, post_id, title, status, draft_md, blocks_json, tags_json, material_chars, source_count, model, created_at, updated_at)
      VALUES (?, ?, ?, 'draft', '', ?, '[]', ?, ?, ?, ?, ?)`)
      .run(userId, postId, title, toJson(blocks, []), Number(chars) || 0, (sources ?? []).length, model || null, now, now);
    const id = Number(info.lastInsertRowid);
    addMaterials(id, sources);
    return id;
  }

  function updateDraft(sessionId, { blocks = [], title = '', tags = [], draftMd = '', status = 'draft', postId } = {}) {
    // postId 是可选的**回填**：面板在写作页保存时才知道帖子 id（新建帖子先是 0，
    // 发布后才有），所以只有显式传进来才动 post_id 这一列 —— 否则会把已回填的值抹掉。
    const id = Number(postId);
    const withPost = Number.isInteger(id) && id > 0;
    if (withPost) {
      stmt(`UPDATE ${t('sessions')} SET blocks_json = ?, title = ?, tags_json = ?, draft_md = ?, status = ?, post_id = ?, updated_at = ?
        WHERE id = ?`)
        .run(toJson(blocks, []), title, toJson(tags, []), draftMd, status, id, Date.now(), sessionId);
      return;
    }
    stmt(`UPDATE ${t('sessions')} SET blocks_json = ?, title = ?, tags_json = ?, draft_md = ?, status = ?, updated_at = ?
      WHERE id = ?`)
      .run(toJson(blocks, []), title, toJson(tags, []), draftMd, status, Date.now(), sessionId);
  }

  function addMaterials(sessionId, sources) {
    const list = Array.isArray(sources) ? sources : [];
    const now = Date.now();
    const insert = stmt(`INSERT INTO ${t('materials')}
      (session_id, kind, name, bytes, blocks_json, images_json, warnings_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const source of list) {
      insert.run(
        sessionId,
        String(source?.kind ?? 'text'),
        String(source?.name ?? ''),
        Number(source?.bytes) || 0,
        toJson(source?.blocks, []),
        toJson(source?.images, []),
        toJson(source?.warnings, []),
        now,
      );
    }
  }

  function listMaterials(sessionId) {
    return stmt(`SELECT * FROM ${t('materials')} WHERE session_id = ? ORDER BY id ASC`).all(sessionId);
  }

  function addAttachment({ sessionId, name, mime = 'application/octet-stream', bytes = 0, dataUrl = null, path = null }) {
    const info = stmt(`INSERT INTO ${t('attachments')} (session_id, name, mime, bytes, path, data_url, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(sessionId, name, mime, Number(bytes) || 0, path, dataUrl, Date.now());
    return Number(info.lastInsertRowid);
  }

  function attachmentById(id) {
    return stmt(`SELECT * FROM ${t('attachments')} WHERE id = ?`).get(id) ?? null;
  }

  function listAttachments(sessionId) {
    return stmt(`SELECT * FROM ${t('attachments')} WHERE session_id = ? ORDER BY id ASC`).all(sessionId);
  }

  /**
   * 把一条会话的附件裁到最多 `keep` 条（留最新的）。
   *
   * 为什么必须有：`POST /session` 每次上传材料都会把图逐张写进附件表，而每轮
   * `/generate` 又只取前 `MAX_IMAGES` 张。不裁的话，反复上传能在磁盘上无限堆积
   * 图片 base64 —— 增长完全由客户端控制，服务端却没有上限。
   */
  function trimAttachments(sessionId, keep) {
    const limit = Number.isInteger(keep) && keep > 0 ? keep : 0;
    return stmt(`DELETE FROM ${t('attachments')}
      WHERE session_id = ? AND id NOT IN (
        SELECT id FROM ${t('attachments')} WHERE session_id = ? ORDER BY id DESC LIMIT ?
      )`).run(sessionId, sessionId, limit).changes;
  }

  /** 同上，裁材料行（每条材料都存着它自己的 blocks_json，重复上传会成倍长）。 */
  function trimMaterials(sessionId, keep) {
    const limit = Number.isInteger(keep) && keep > 0 ? keep : 0;
    return stmt(`DELETE FROM ${t('materials')}
      WHERE session_id = ? AND id NOT IN (
        SELECT id FROM ${t('materials')} WHERE session_id = ? ORDER BY id DESC LIMIT ?
      )`).run(sessionId, sessionId, limit).changes;
  }

  /**
   * 记一轮消息。`draftMd` 是**这一轮结束后的整篇草稿**（快照）。
   *
   * 存快照而不是重放 ops：回滚到第 N 轮只要读一次快照再 updateDraft 就完事，
   * 而重放一旦遇到被跳过的 op 或模型输出的细微差别，还原出来的稿子跟当时
   * 用户看到的那份就不一样了 —— 回滚必须回到"当时那一版"，不能"差不多那一版"。
   */
  function addMessage({ sessionId, role, requirement = '', draftMd = '', ops = [], skipped = [], warnings = [], usage = {} }) {
    const info = stmt(`INSERT INTO ${t('messages')}
      (session_id, role, requirement, draft_md, ops_json, skipped_json, warnings_json, usage_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(sessionId, role, requirement, String(draftMd ?? ''), toJson(ops, []), toJson(skipped, []), toJson(warnings, []), toJson(usage, {}), Date.now());
    return Number(info.lastInsertRowid);
  }

  /**
   * 一轮一条，每条都带整篇草稿快照（几 KB）。不加 LIMIT 的话，一条聊了很多轮的
   * 会话能把 `GET /session/:id` / `GET /messages` / `/turn` 的历史一次性塞满响应。
   * 只取最近 `limit` 条、再翻回时间正序 —— 面板的会话列表本来就是"最近的在下面"。
   */
  function listMessages(sessionId, { limit = 200 } = {}) {
    const take = Number.isInteger(limit) && limit > 0 ? limit : 0;
    if (take === 0) return stmt(`SELECT * FROM ${t('messages')} WHERE session_id = ? ORDER BY id ASC`).all(sessionId);
    const rows = stmt(`SELECT * FROM ${t('messages')} WHERE session_id = ? ORDER BY id DESC LIMIT ?`).all(sessionId, take);
    return rows.reverse();
  }

  /** 单条消息（回滚前要确认它属于这条会话）。 */
  function messageById(sessionId, messageId) {
    return stmt(`SELECT * FROM ${t('messages')} WHERE id = ? AND session_id = ?`).get(messageId, sessionId) ?? null;
  }

  function saveReview({ sessionId = null, postId = null, userId, contentHash, summary = '', findings = [], model = '' }) {
    const info = stmt(`INSERT INTO ${t('reviews')}
      (session_id, post_id, user_id, content_hash, summary, findings_json, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(sessionId, postId, userId, contentHash, summary, toJson(findings, []), model || null, Date.now());
    return Number(info.lastInsertRowid);
  }

  function reviewById(id, userId) {
    return stmt(`SELECT * FROM ${t('reviews')} WHERE id = ? AND user_id = ?`).get(id, userId) ?? null;
  }

  /**
   * 覆盖同一条审查记录（按 content_hash 命中时用）。
   *
   * 缓存命中不能只复用 id 却不落库：那样接口回给界面的是**这次模型的新结论**，
   * 库里存的还是上一版，点「应用修改」时吃的是旧 findings —— 界面和落库各说一套。
   */
  function updateReview(id, { summary = '', findings = [], model = '' } = {}) {
    stmt(`UPDATE ${t('reviews')} SET summary = ?, findings_json = ?, model = ? WHERE id = ?`)
      .run(summary, toJson(findings, []), model || null, id);
    return id;
  }

  /** 重新落这一条审查的条目：旧 item 连同 applied 状态一起清掉，避免新旧混着算。 */
  function replaceReviewItems(reviewId, findings = []) {
    stmt(`DELETE FROM ${t('review_items')} WHERE review_id = ?`).run(reviewId);
    for (const finding of findings) {
      addReviewItem({ reviewId, findingId: finding.id, kind: finding.kind, severity: finding.severity, quote: finding.quote });
    }
  }

  function listReviews({ userId, limit = 20 } = {}) {
    return stmt(`SELECT * FROM ${t('reviews')} WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`)
      .all(userId, Math.max(1, Math.min(200, Number(limit) || 20)));
  }

  function listReviewsBySession(sessionId) {
    return stmt(`SELECT * FROM ${t('reviews')} WHERE session_id = ? ORDER BY created_at DESC`).all(sessionId);
  }

  /** 同一份草稿（content_hash 相同）不必重复审查。 */
  function reviewByHash(userId, contentHash) {
    return stmt(`SELECT * FROM ${t('reviews')} WHERE user_id = ? AND content_hash = ? ORDER BY created_at DESC`).get(userId, contentHash) ?? null;
  }

  function addAsset({ sessionId, blockId = '', name = '', mime = '', bytes = 0, path = null }) {
    const info = stmt(`INSERT INTO ${t('assets')} (session_id, block_id, name, mime, bytes, path, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(sessionId, blockId, name, mime, Number(bytes) || 0, path, Date.now());
    return Number(info.lastInsertRowid);
  }

  function assetById(id) {
    return stmt(`SELECT * FROM ${t('assets')} WHERE id = ?`).get(id) ?? null;
  }

  function listAssets(sessionId) {
    return stmt(`SELECT * FROM ${t('assets')} WHERE session_id = ? ORDER BY id ASC`).all(sessionId);
  }

  function addReviewItem({ reviewId, findingId, kind = '', severity = '', quote = '', applied = 0 }) {
    const info = stmt(`INSERT INTO ${t('review_items')} (review_id, finding_id, kind, severity, quote, applied, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(reviewId, findingId, kind, severity, quote, applied ? 1 : 0, Date.now());
    return Number(info.lastInsertRowid);
  }

  function listReviewItems(reviewId) {
    return stmt(`SELECT * FROM ${t('review_items')} WHERE review_id = ? ORDER BY id ASC`).all(reviewId);
  }

  function markReviewItemApplied(reviewId, findingId) {
    stmt(`UPDATE ${t('review_items')} SET applied = 1 WHERE review_id = ? AND finding_id = ?`).run(reviewId, findingId);
  }

  function addTurnLog({ sessionId, requirement = '', applied = 0, skipped = 0, needsMore = 0 }) {
    const info = stmt(`INSERT INTO ${t('turn_logs')} (session_id, requirement, applied, skipped, needs_more, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(sessionId, requirement, Number(applied) || 0, Number(skipped) || 0, Number(needsMore) || 0, Date.now());
    return Number(info.lastInsertRowid);
  }

  function listTurnLogs(sessionId) {
    return stmt(`SELECT * FROM ${t('turn_logs')} WHERE session_id = ? ORDER BY id ASC`).all(sessionId);
  }

  function addUsage({ userId, sessionId = null, model = '', prompt = 0, completion = 0, calls = 1 }) {
    const info = stmt(`INSERT INTO ${t('usage')} (user_id, session_id, model, prompt, completion, calls, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(userId, sessionId, model, Number(prompt) || 0, Number(completion) || 0, Number(calls) || 1, Date.now());
    return Number(info.lastInsertRowid);
  }

  function usageSummary(userId, sessionId = null) {
    const row = sessionId === null
      ? stmt(`SELECT COALESCE(SUM(prompt), 0) AS prompt, COALESCE(SUM(completion), 0) AS completion, COUNT(*) AS calls
          FROM ${t('usage')} WHERE user_id = ?`).get(userId)
      : stmt(`SELECT COALESCE(SUM(prompt), 0) AS prompt, COALESCE(SUM(completion), 0) AS completion, COUNT(*) AS calls
          FROM ${t('usage')} WHERE user_id = ? AND session_id = ?`).get(userId, sessionId);
    return { prompt: Number(row?.prompt ?? 0), completion: Number(row?.completion ?? 0), calls: Number(row?.calls ?? 0) };
  }

  function setPref(userId, key, value) {
    stmt(`INSERT INTO ${t('prefs')} (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(userId, key, String(value ?? ''), Date.now());
  }

  function getPref(userId, key) {
    const row = stmt(`SELECT value FROM ${t('prefs')} WHERE user_id = ? AND key = ?`).get(userId, key);
    return row ? row.value : null;
  }

  function stats(userId) {
    const sessions = stmt(`SELECT COUNT(*) AS n, COALESCE(MAX(updated_at), 0) AS last FROM ${t('sessions')} WHERE user_id = ?`).get(userId);
    const reviews = stmt(`SELECT COUNT(*) AS n, COALESCE(MAX(created_at), 0) AS last FROM ${t('reviews')} WHERE user_id = ?`).get(userId);
    const lastAt = Math.max(Number(sessions?.last ?? 0), Number(reviews?.last ?? 0));
    return {
      sessions: Number(sessions?.n ?? 0),
      reviews: Number(reviews?.n ?? 0),
      lastAt: lastAt > 0 ? lastAt : null,
      usage: usageSummary(userId),
    };
  }

  return {
    ensureSchema,
    schemaVersion: SCHEMA_VERSION,
    tablePrefix: prefix,
    materialChars,
    createSession,
    sessionById,
    sessionForUser,
    sessionForPost,
    listSessions,
    updateDraft,
    addMaterials,
    listMaterials,
    addAttachment,
    attachmentById,
    listAttachments,
    trimAttachments,
    trimMaterials,
    addMessage,
    listMessages,
    messageById,
    saveReview,
    reviewById,
    updateReview,
    replaceReviewItems,
    listReviews,
    listReviewsBySession,
    reviewByHash,
    addAsset,
    assetById,
    listAssets,
    addReviewItem,
    listReviewItems,
    markReviewItemApplied,
    addTurnLog,
    listTurnLogs,
    addUsage,
    usageSummary,
    setPref,
    getPref,
    stats,
  };
}

export { SCHEMA_VERSION };
export { parseJson, toJson };
