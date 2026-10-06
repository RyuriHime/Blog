// doc 模块的 SQL 层。
//
// 这个文件里**只有 SQL 和拼装 SQL 的规则**，没有业务判断：
// 「谁能看」「改完要不要写修订」「影子行怎么同步」都在 store.js。
//
// 两条纪律直接抄自 feed（那边付过学费）：
//
// 1. 每个查询都必须过 `bind(sql, params)`：占位符个数 ≠ 实参个数当场抛错。
//    动态（P1）的 v1 就是 `listPostsByIds` 的 `?` 顺序写错，
//    转发列表 500，而 smoke 242 项 + check-ui-contract 175 项**全绿**。
// 2. 条件只能由成对的 `{sql, params}` 拼出来，不许自己数问号。
import { DOC_KINDS } from './schema.js';

/** 占位符个数与实参个数必须相等 —— 这是上面那条事故的防线。 */
function bind(sql, params) {
  const expected = (sql.match(/\?/g) ?? []).length;
  if (expected !== params.length) {
    throw new Error(`SQL 占位符个数（${expected}）与参数个数（${params.length}）不一致：${sql}`);
  }
  return [sql, params];
}

/** 文档的取列清单（带作者信息 —— 列表和详情必须同一份形状）。 */
const DOC_COLUMNS = `d.id, d.user_id, d.kind, d.title, d.scope, d.template, d.anchor_post_id,
  d.sandbox_disabled, d.deleted, d.created_at, d.updated_at,
  u.username, u.display_name, u.avatar, u.role`;

const DOC_SOURCE = 'FROM documents d JOIN users u ON u.id = d.user_id';

const BLOCK_COLUMNS = 'document_id, block_id, type, type_version, position, props_json, created_at, updated_at';

/** 块行 → 内存形状。坏 JSON 不当异常：渲染层会把这一块降级成占位。 */
export function blockFromRow(row) {
  let props = {};
  try {
    const parsed = JSON.parse(row.props_json ?? '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) props = parsed;
  } catch {
    props = {};
  }
  return {
    block_id: row.block_id,
    type: row.type,
    version: Number(row.type_version) || 1,
    props,
  };
}

export function createDocQueries(db) {
  const all = (sql, params = []) => {
    const [text, args] = bind(sql, params);
    return db.prepare(text).all(...args);
  };
  const get = (sql, params = []) => {
    const [text, args] = bind(sql, params);
    return db.prepare(text).get(...args);
  };
  const run = (sql, params = []) => {
    const [text, args] = bind(sql, params);
    return db.prepare(text).run(...args);
  };

  return {
    /* ---------------- 文档 ---------------- */

    documentById(id) {
      return get(`SELECT ${DOC_COLUMNS} ${DOC_SOURCE} WHERE d.id = ?`, [id]) ?? null;
    },

    documentByAnchor(anchorPostId) {
      return get(`SELECT ${DOC_COLUMNS} ${DOC_SOURCE} WHERE d.anchor_post_id = ? AND d.deleted = 0`, [anchorPostId]) ?? null;
    },

    /** 一个用户至多一份 profile 文档（在查询层保证，见设计文档 §8.2）。 */
    activeProfileDocument(userId) {
      return (
        get(`SELECT ${DOC_COLUMNS} ${DOC_SOURCE} WHERE d.user_id = ? AND d.kind = 'profile' AND d.deleted = 0 ORDER BY d.id DESC LIMIT 1`, [
          userId,
        ]) ?? null
      );
    },

    /** 个人主页用：按用户名找 profile 文档（§8.2 前端 `#/u/:name` 优先渲染它）。 */
    profileDocumentByUsername(username) {
      return (
        get(
          `SELECT ${DOC_COLUMNS} ${DOC_SOURCE} WHERE u.username = ? COLLATE NOCASE AND d.kind = 'profile' AND d.deleted = 0 ORDER BY d.id DESC LIMIT 1`,
          [String(username)],
        ) ?? null
      );
    },

    /**
     * Wiki 用：按标题找一页。
     *
     * `template` 是「这一篇算不算 wiki 页」的标记（见 templates.js 的 `page`），
     * 不传就只按标题找。标题按 NOCASE 比 —— `[[围炉]]` 与 `[[围炉 ]]` 得是同一页。
     */
    documentByTitle(title, template = null) {
      const where = ['d.title = ? COLLATE NOCASE', 'd.deleted = 0'];
      const params = [String(title)];
      if (template) {
        where.push('d.template = ?');
        params.push(String(template));
      }
      return get(`SELECT ${DOC_COLUMNS} ${DOC_SOURCE} WHERE ${where.join(' AND ')} ORDER BY d.id ASC LIMIT 1`, params) ?? null;
    },

    /**
     * 列表。`visible` 由 visibility.js 给出（null = staff，不加范围条件）。
     * `viewerId` 只用于 `mine=1`。
     */
    listDocuments({ viewerId = null, visible = null, kind = '', scope = '', mine = false, q = '', page = 1, limit = 20, sort = 'updated' } = {}) {
      const conditions = ['d.deleted = 0'];
      const params = [];
      if (kind && DOC_KINDS.includes(kind)) {
        conditions.push('d.kind = ?');
        params.push(kind);
      }
      if (scope) {
        conditions.push('d.scope = ?');
        params.push(scope);
      }
      if (mine) {
        if (!viewerId) return { rows: [], total: 0 };
        conditions.push('d.user_id = ?');
        params.push(viewerId);
      }
      if (q) {
        conditions.push('d.title LIKE ?');
        params.push(`%${q.replace(/[%_]/g, (ch) => `\\${ch}`)}%`);
      }
      if (visible) {
        conditions.push(visible.sql);
        params.push(...visible.params);
      }
      const where = conditions.join(' AND ');
      const order =
        sort === 'created' ? 'd.created_at DESC' : sort === 'title' ? 'd.title ASC, d.id DESC' : 'd.updated_at DESC, d.id DESC';
      const size = Math.min(Math.max(Number(limit) || 20, 1), 50);
      const offset = (Math.max(Number(page) || 1, 1) - 1) * size;

      const total = Number(get(`SELECT COUNT(*) AS n FROM documents d WHERE ${where}`, params)?.n ?? 0);
      const rows = all(`SELECT ${DOC_COLUMNS} ${DOC_SOURCE} WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`, [...params, size, offset]);
      return { rows, total };
    },

    insertDocument({ userId, kind, title, scope, template, anchorPostId, now }) {
      const result = run(
        `INSERT INTO documents (user_id, kind, title, scope, template, anchor_post_id, sandbox_disabled, deleted, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
        [userId, kind, title, scope, template, anchorPostId, now, now],
      );
      return Number(result.lastInsertRowid);
    },

    updateDocumentMeta({ id, title, scope, template, updatedAt }) {
      run('UPDATE documents SET title = ?, scope = ?, template = ?, updated_at = ? WHERE id = ?', [title, scope, template, updatedAt, id]);
    },

    setSandboxDisabled(id, disabled, now) {
      run('UPDATE documents SET sandbox_disabled = ?, updated_at = ? WHERE id = ?', [disabled ? 1 : 0, now, id]);
    },

    softDeleteDocument(id, now) {
      run('UPDATE documents SET deleted = 1, updated_at = ? WHERE id = ?', [now, id]);
    },

    /* ---------------- 块 ---------------- */

    blocksOf(documentId) {
      return all(`SELECT ${BLOCK_COLUMNS} FROM document_blocks WHERE document_id = ? ORDER BY position ASC, id ASC`, [documentId]);
    },

    blockRow(documentId, blockId) {
      return get(`SELECT ${BLOCK_COLUMNS} FROM document_blocks WHERE document_id = ? AND block_id = ?`, [documentId, blockId]) ?? null;
    },

    /** 下一个块号：**只增不减**，删掉的号不回收（否则 bind 会指到别的块上）。 */
    nextBlockNumber(documentId) {
      const row = get('SELECT MAX(CAST(SUBSTR(block_id, 2) AS INTEGER)) AS n FROM document_blocks WHERE document_id = ?', [documentId]);
      return Number(row?.n ?? 0) + 1;
    },

    maxPosition(documentId) {
      const row = get('SELECT MAX(position) AS p FROM document_blocks WHERE document_id = ?', [documentId]);
      return row?.p == null ? 0 : Number(row.p);
    },

    insertBlockRow({ documentId, blockId, type, version, position, propsJson, now }) {
      run(
        `INSERT INTO document_blocks (document_id, block_id, type, type_version, position, props_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [documentId, blockId, type, version, position, propsJson, now, now],
      );
    },

    updateBlockRow({ documentId, blockId, type, version, propsJson, now }) {
      run('UPDATE document_blocks SET type = ?, type_version = ?, props_json = ?, updated_at = ? WHERE document_id = ? AND block_id = ?', [
        type,
        version,
        propsJson,
        now,
        documentId,
        blockId,
      ]);
    },

    setBlockPosition({ documentId, blockId, position, now }) {
      run('UPDATE document_blocks SET position = ?, updated_at = ? WHERE document_id = ? AND block_id = ?', [
        position,
        now,
        documentId,
        blockId,
      ]);
    },

    deleteBlockRow(documentId, blockId) {
      run('DELETE FROM document_blocks WHERE document_id = ? AND block_id = ?', [documentId, blockId]);
    },

    deleteBlocksOf(documentId) {
      run('DELETE FROM document_blocks WHERE document_id = ?', [documentId]);
    },

    countBlocks(documentId) {
      return Number(get('SELECT COUNT(*) AS n FROM document_blocks WHERE document_id = ?', [documentId])?.n ?? 0);
    },

    /** 这篇文档用到了哪些类型（导入时判断"未知类型原样保留"要不要提示）。 */
    usedTypes(documentId) {
      return all('SELECT DISTINCT type FROM document_blocks WHERE document_id = ?', [documentId]).map((row) => row.type);
    },

    /* ---------------- 修订 ---------------- */

    listRevisions(documentId, limit = 50) {
      return all(
        `SELECT r.revision, r.reason, r.author_id, r.created_at, u.username, u.display_name
         FROM document_revisions r LEFT JOIN users u ON u.id = r.author_id
         WHERE r.document_id = ? ORDER BY r.revision DESC LIMIT ?`,
        [documentId, Math.min(Math.max(Number(limit) || 50, 1), 200)],
      );
    },

    revisionByNumber(documentId, revision) {
      return (
        get('SELECT revision, blocks_json, reason, author_id, created_at FROM document_revisions WHERE document_id = ? AND revision = ?', [
          documentId,
          revision,
        ]) ?? null
      );
    },

    latestRevisionNumber(documentId) {
      return Number(get('SELECT MAX(revision) AS n FROM document_revisions WHERE document_id = ?', [documentId])?.n ?? 0);
    },

    insertRevisionRow({ documentId, revision, blocksJson, reason, authorId, now }) {
      run(
        `INSERT INTO document_revisions (document_id, revision, blocks_json, reason, author_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [documentId, revision, blocksJson, reason, authorId, now],
      );
    },

    /** 只保留最近 keep 条（超出范围的理由：修订表会随每次保存线性长大）。 */
    pruneRevisions(documentId, keep) {
      run(
        `DELETE FROM document_revisions
         WHERE document_id = ? AND revision NOT IN (
           SELECT revision FROM document_revisions WHERE document_id = ? ORDER BY revision DESC LIMIT ?
         )`,
        [documentId, documentId, keep],
      );
    },

    /* ---------------- 自定义块类型 ---------------- */

    customBlockTypes() {
      return all('SELECT name, version, label, icon, props_schema_json, renderer_kind, renderer_json, created_by, created_at FROM doc_block_types ORDER BY name ASC', []);
    },

    blockTypeRow(name) {
      return get('SELECT name, version, label, icon, props_schema_json, renderer_kind, renderer_json, created_by FROM doc_block_types WHERE name = ?', [name]) ?? null;
    },

    insertBlockTypeRow({ name, version, label, icon, propsSchemaJson, rendererKind, rendererJson, createdBy, now }) {
      run(
        `INSERT INTO doc_block_types (name, version, label, icon, props_schema_json, renderer_kind, renderer_json, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [name, version, label, icon, propsSchemaJson, rendererKind, rendererJson, createdBy, now, now],
      );
    },

    deleteBlockTypeRow(name) {
      run('DELETE FROM doc_block_types WHERE name = ?', [name]);
    },

    /* ---------- 沙箱审计 ---------- */

    insertCapabilityLog({ documentId, blockId, capability, userId, allowed, now }) {
      run(
        'INSERT INTO doc_capability_logs (document_id, block_id, capability, user_id, allowed, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [documentId, blockId, capability, userId, allowed, now],
      );
    },

    capabilityLogsOf(documentId, limit = 50) {
      return all(
        'SELECT block_id, capability, user_id, allowed, created_at FROM doc_capability_logs WHERE document_id = ? ORDER BY id DESC LIMIT ?',
        [documentId, limit],
      );
    },

    /* ---------- 笔记 → 文档（§8.1 惰性导入的对照表） ---------- */

    noteDocument(userId, noteName) {
      return get(
        `SELECT ${DOC_COLUMNS}
           FROM note_documents n
           JOIN documents d ON d.id = n.document_id
           JOIN users u ON u.id = d.user_id
          WHERE n.user_id = ? AND n.note_name = ? AND d.deleted = 0`,
        [userId, noteName],
      );
    },

    linkNoteDocument({ userId, noteName, documentId, now }) {
      run(
        'INSERT INTO note_documents (user_id, note_name, document_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, note_name) DO UPDATE SET document_id = excluded.document_id',
        [userId, noteName, documentId, now],
      );
    },

    unlinkNoteDocument(userId, noteName) {
      run('DELETE FROM note_documents WHERE user_id = ? AND note_name = ?', [userId, noteName]);
    },

    /* ---------- 投票块的票（§5.2） ---------- */

    /** 一篇文档里每个选项各几票。一次查回来，避免按块循环查库。 */
    pollTallies(documentId) {
      return all(
        `SELECT block_id, option_id, COUNT(*) AS votes
           FROM doc_poll_votes
          WHERE document_id = ?
          GROUP BY block_id, option_id`,
        [documentId],
      );
    },

    /** 谁投了几票（只用来算「参与人数」与「我投了什么」）。 */
    pollVoters(documentId) {
      return all(
        'SELECT block_id, user_id FROM doc_poll_votes WHERE document_id = ? GROUP BY block_id, user_id',
        [documentId],
      );
    },

    /** 当前用户在这篇文档里投过哪些选项。未登录时传 null，直接返回空数组。 */
    myPollVotes(documentId, userId) {
      if (!userId) return [];
      return all('SELECT block_id, option_id FROM doc_poll_votes WHERE document_id = ? AND user_id = ?', [
        documentId,
        userId,
      ]);
    },

    clearMyPollVotes(documentId, blockId, userId) {
      run('DELETE FROM doc_poll_votes WHERE document_id = ? AND block_id = ? AND user_id = ?', [
        documentId,
        blockId,
        userId,
      ]);
    },

    insertPollVote({ documentId, blockId, optionId, userId, now }) {
      run(
        'INSERT OR IGNORE INTO doc_poll_votes (document_id, block_id, option_id, user_id, created_at) VALUES (?, ?, ?, ?, ?)',
        [documentId, blockId, optionId, userId, now],
      );
    },

    /**
     * 把投给「已经不存在的选项」的票清掉。
     * 作者删掉一个选项之后，那些票既算不进任何一栏、又会永远留在库里 —— 必须清。
     * `validOptionIds` 为空数组时不要调用（那会把整块的票删光，通常是块被删了）。
     */
    prunePollVotes(documentId, blockId, validOptionIds) {
      if (!validOptionIds.length) return run('DELETE FROM doc_poll_votes WHERE document_id = ? AND block_id = ?', [documentId, blockId]);
      const holes = validOptionIds.map(() => '?').join(', ');
      return run(
        `DELETE FROM doc_poll_votes WHERE document_id = ? AND block_id = ? AND option_id NOT IN (${holes})`,
        [documentId, blockId, ...validOptionIds],
      );
    },

    deletePollVotesOfBlock(documentId, blockId) {
      run('DELETE FROM doc_poll_votes WHERE document_id = ? AND block_id = ?', [documentId, blockId]);
    },

    /** 这篇文档里**存着票**的块号（用来找出「票还在、块已经没了」的孤儿票）。 */
    pollVoteBlocks(documentId) {
      return all('SELECT DISTINCT block_id FROM doc_poll_votes WHERE document_id = ?', [documentId]);
    },

    deletePollVotesOfDocument(documentId) {
      run('DELETE FROM doc_poll_votes WHERE document_id = ?', [documentId]);
    },

    /* ---------- wiki 的分类与排序（§7.3） ---------- */

    /** 所有分类的页数。空分类（没进过 `doc_wiki_pages` 的页）用 '' 归到「未分类」。 */
    wikiCategories() {
      return all(
        `SELECT COALESCE(w.category, '') AS category, COUNT(*) AS pages
           FROM documents d
           LEFT JOIN doc_wiki_pages w ON w.document_id = d.id
          WHERE d.template = 'page' AND d.deleted = 0
          GROUP BY COALESCE(w.category, '')
          ORDER BY category = '' , category`,
      );
    },

    /**
     * wiki 边栏要用的页面清单。
     * 页面清单来自 `documents`（凡是 `template='page'` 的活跃文档都算一页），
     * 分类与排序来自 `doc_wiki_pages`（没登记过的页 LEFT JOIN 出 ''，归到「未分类」）。
     */
    /**
     * wiki 目录。`visible` 由 visibility.js 给出（null = staff，不加范围条件）——
     * **必须带上 `d.scope` / `d.user_id`**：调用方还要再过一遍 `canView`，
     * 少了这两列它会把每一页都当成「scope 未知」而滤掉，
     * 结果就是管理员看得见目录、访客看不到（症状：边栏对着匿名用户是空的）。
     */
    listWikiPages({ visible = null } = {}) {
      const where = ["d.template = 'page'", 'd.deleted = 0'];
      const params = [];
      if (visible) {
        where.push(visible.sql);
        params.push(...visible.params);
      }
      return all(
        `SELECT d.id, d.title, d.scope, d.user_id, d.updated_at, u.username,
                COALESCE(w.category, '') AS category, COALESCE(w.sort_order, 0) AS sort_order
           FROM documents d
           JOIN users u ON u.id = d.user_id
           LEFT JOIN doc_wiki_pages w ON w.document_id = d.id
          WHERE ${where.join(' AND ')}
          ORDER BY category = '', category, sort_order, d.title COLLATE NOCASE`,
        params,
      );
    },

    wikiMetaOf(documentId) {
      return get('SELECT category, sort_order FROM doc_wiki_pages WHERE document_id = ?', [documentId]);
    },

    upsertWikiMeta({ documentId, category, sortOrder, now }) {
      run(
        `INSERT INTO doc_wiki_pages (document_id, category, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (document_id) DO UPDATE SET category = excluded.category, sort_order = excluded.sort_order, updated_at = excluded.updated_at`,
        [documentId, category, sortOrder, now, now],
      );
    },

    /* --- 沙箱块的持久状态（`Sandbox.state`）----------------------------- */

    appStateOf(documentId, blockId, scope, userId) {
      return (
        get('SELECT value, updated_at FROM doc_app_state WHERE document_id = ? AND block_id = ? AND scope = ? AND user_id = ?', [
          documentId,
          blockId,
          scope,
          userId,
        ]) ?? null
      );
    },

    upsertAppState({ documentId, blockId, scope, userId, value, now }) {
      run(
        `INSERT INTO doc_app_state (document_id, block_id, scope, user_id, value, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (document_id, block_id, scope, user_id)
         DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [documentId, blockId, scope, userId, value, now],
      );
    },

    /** 块没了，它存的状态也没意义 —— 删块 / 改块类型时清掉。 */
    deleteAppStatesOfBlock(documentId, blockId) {
      run('DELETE FROM doc_app_state WHERE document_id = ? AND block_id = ?', [documentId, blockId]);
    },

    deleteAppStatesOfDocument(documentId) {
      run('DELETE FROM doc_app_state WHERE document_id = ?', [documentId]);
    },

    /** 一块一块地数：正文里还有哪些块 id 有状态，用来找出「块已删、状态还在」的孤儿行。 */
    appStateBlocks(documentId) {
      return all('SELECT DISTINCT block_id FROM doc_app_state WHERE document_id = ?', [documentId]).map((row) => String(row.block_id));
    },
  };
}
