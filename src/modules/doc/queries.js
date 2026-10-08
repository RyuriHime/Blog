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

/** 文档的取列清单（带作者信息 + 草稿状态 —— 列表和详情必须同一份形状）。 */
const DOC_COLUMNS = `d.id, d.user_id, d.kind, d.title, d.scope, d.template, d.anchor_post_id,
  d.sandbox_disabled, d.deleted, d.created_at, d.updated_at,
  (SELECT dr.published FROM doc_drafts dr WHERE dr.document_id = d.id) AS draft_published,
  (SELECT dr.document_id FROM doc_drafts dr WHERE dr.document_id = d.id) AS draft_document_id,
  u.username, u.display_name, u.avatar, u.role`;

// 草稿状态用关联子查询而不是 JOIN：`DOC_COLUMNS` 有几处自带 FROM（noteDocument、站内页树），
// 那些地方没有 `dr` 别名，写成 JOIN 会让它们全炸。子查询只依赖 `d.id`，到哪儿都对。
const DOC_SOURCE = `FROM documents d JOIN users u ON u.id = d.user_id`;

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
     * 站里的页可能和其它站里的页重名（`title` 其实只在一个站里有意义）。
     * 打开「站 + 页」时要把候选都拿出来，再挑属于**这个站**的那一篇。
     */
    documentsByTitle(title, template = null) {
      const where = ['d.title = ? COLLATE NOCASE', 'd.deleted = 0'];
      const params = [String(title)];
      if (template) {
        where.push('d.template = ?');
        params.push(String(template));
      }
      return all(`SELECT ${DOC_COLUMNS} ${DOC_SOURCE} WHERE ${where.join(' AND ')} ORDER BY d.id ASC LIMIT 20`, params);
    },

    /**
     * Wiki 用：按标题找一页。
     *
     * `template` 是「这一篇算不算 wiki 页」的标记（见 templates.js 的 `page`），
     * 不传就只按标题找。标题按 NOCASE 比 —— `[[格社]]` 与 `[[格社 ]]` 得是同一页。
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
    listDocuments({ viewerId = null, visible = null, kind = '', scope = '', tag = '', wiki = '', template = '', mine = false, drafts = false, q = '', page = 1, limit = 20, sort = 'updated' } = {}) {
      const conditions = ['d.deleted = 0'];
      const params = [];
      if (kind && DOC_KINDS.includes(kind)) {
        conditions.push('d.kind = ?');
        params.push(kind);
      } else {
        // 个人主页（`kind = 'profile'`）不进广场 —— 它是「这个人的主页」，
        // 从 `#/u/:username` 那条路看，铺在广场上只是一堆同名卡片。点名要 profile 才给。
        conditions.push("d.kind <> 'profile'");
      }
      if (scope) {
        conditions.push('d.scope = ?');
        params.push(scope);
      }
      if (template) {
        // 点名要某一类模板（首页/公告页要 `template=announce`）。
        conditions.push('d.template = ?');
        params.push(template);
      } else if (visible) {
        // 站务公告不进积木广场 —— 整条广场列表（没点名模板的那一次查询）里，
        // 非 staff（含未登录）看不到 `announce`。首页与公告页点名要它，
        // 所以那条路走上面的分支，不受这句影响。
        conditions.push("d.template <> 'announce'");
      }
      // 按标签筛选：EXISTS 而不是 JOIN —— JOIN 会让一篇带两个匹配标签的文档出现两次。
      // COLLATE NOCASE：手工敲进地址栏的 `?tag=css` 也该命中作者写的 `CSS`。
      if (tag) {
        conditions.push('EXISTS (SELECT 1 FROM doc_tags dt WHERE dt.document_id = d.id AND dt.tag = ? COLLATE NOCASE)');
        params.push(tag);
      }
      // 挂在 wiki 站里的页（`doc_settings.station_id` 非 0）默认不在广场列出来：
      // 导进来的一个 OI Wiki 就是 519 页，全铺在广场上会把别人写的东西淹掉；
      // 它们按站自己的目录树看（`#/wiki`）。`?wiki=all` 才都列、`?wiki=only` 则只要站里的页
      //（广场前端不再有那颗开关，`#/docs?wiki=all` 也不再往下传 —— 这套参数留给接口本身）。
      if (wiki === 'only') {
        conditions.push('EXISTS (SELECT 1 FROM doc_settings s WHERE s.document_id = d.id AND COALESCE(s.station_id, 0) <> 0)');
      } else if (wiki !== 'all') {
        conditions.push('NOT EXISTS (SELECT 1 FROM doc_settings s WHERE s.document_id = d.id AND COALESCE(s.station_id, 0) <> 0)');
      }
      if (mine) {
        if (!viewerId) return { rows: [], total: 0 };
        conditions.push('d.user_id = ?');
        params.push(viewerId);
      }
      // 草稿箱（`?drafts=1`，积木广场的「📥 草稿箱」按钮走这条）。
      // 只看**我自己**有草稿行的那些 —— 别人的草稿一行都不给看（连存在都不暴露）。
      // 默认反过来：「从没发布过」的草稿不进任何列表，**连作者自己的普通列表也不进**
      // （它住在草稿箱里）；「发布过、又有新改动」的照旧出现 —— 对外那一份还活着。
      if (drafts) {
        if (!viewerId) return { rows: [], total: 0 };
        conditions.push('d.user_id = ? AND EXISTS (SELECT 1 FROM doc_drafts dd WHERE dd.document_id = d.id)');
        params.push(viewerId);
      } else {
        conditions.push('NOT EXISTS (SELECT 1 FROM doc_drafts dd WHERE dd.document_id = d.id AND dd.published = 0)');
      }
      if (q) {
        // 标题、**正文**、**标签**都要搜得到：正文不在 `documents` 表里，它在块表里；
        // 标签在 `doc_tags` 里 —— 点积木上的 tag 就是把 tag 填进搜索框再搜一次，
        // 没有这一条，点上去就是空列表。
        // 搜的是「线上那一份」的块 —— 有草稿行的看发布快照（`doc_published_blocks`），
        // 没有草稿行的看 `document_blocks`。**未发布的草稿改动不进搜索结果**（别剧透）。
        const like = `%${q.replace(/[%_]/g, (ch) => `\\${ch}`)}%`;
        conditions.push(
          `(d.title LIKE ?
            OR EXISTS (SELECT 1 FROM doc_tags dt WHERE dt.document_id = d.id AND dt.tag LIKE ?)
            OR EXISTS (SELECT 1 FROM doc_published_blocks pb WHERE pb.document_id = d.id AND pb.props_json LIKE ?)
            OR (NOT EXISTS (SELECT 1 FROM doc_drafts dd WHERE dd.document_id = d.id)
                AND EXISTS (SELECT 1 FROM document_blocks b WHERE b.document_id = d.id AND b.props_json LIKE ?)))`,
        );
        params.push(like, like, like, like);
      }
      if (visible) {
        conditions.push(visible.sql);
        params.push(...visible.params);
      }
      const where = conditions.join(' AND ');
      // `sort=order` 是**站务公告**那条路：排过序的（`sort_order != 0`）排在前面、大的更靠前，
      // 没排过的一律是 0，退回创建时间倒序 —— 于是「一次都没调过顺序」看到的就是老行为，
      // 站长动过一次之后整份顺序才变成显式的（见 `store.reorderAnnouncements`）。
      // 用关联子查询而不是 JOIN `doc_settings`：`DOC_SOURCE` 有六处自带 FROM，
      // 加一个 JOIN 会牵连一片只想要 `documents` 的查询。
      const order =
        sort === 'order'
          ? 'COALESCE((SELECT ds.sort_order FROM doc_settings ds WHERE ds.document_id = d.id), 0) DESC, d.created_at DESC'
          : sort === 'created'
            ? 'd.created_at DESC'
            : sort === 'title'
              ? 'd.title ASC, d.id DESC'
              : 'd.updated_at DESC, d.id DESC';
      const size = Math.min(Math.max(Number(limit) || 20, 1), 50);
      const offset = (Math.max(Number(page) || 1, 1) - 1) * size;

      const total = Number(get(`SELECT COUNT(*) AS n FROM documents d WHERE ${where}`, params)?.n ?? 0);
      const rows = all(`SELECT ${DOC_COLUMNS} ${DOC_SOURCE} WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`, [...params, size, offset]);
      return { rows, total };
    },

    insertDocument({ userId, kind, title, scope, template, anchorPostId, now, createdAt = now, updatedAt = now }) {
      const result = run(
        `INSERT INTO documents (user_id, kind, title, scope, template, anchor_post_id, sandbox_disabled, deleted, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
        [userId, kind, title, scope, template, anchorPostId, createdAt, updatedAt],
      );
      return Number(result.lastInsertRowid);
    },

    /**
     * 「还没有积木的活帖」—— 帖子功能下线时的一次性迁移要的那张名单。
     *
     * 只读 posts / boards 两张别人家的表（模块清单里 `reads` 已声明），
     * 一行都不改：迁移是「给帖子补一篇积木」，不是「改帖子」。
     */
    postsMissingDocument() {
      return all(
        `SELECT p.id, p.user_id, p.board_id, b.slug AS board_slug, p.title, p.content,
                p.hidden, p.created_at, p.updated_at
           FROM posts p
           LEFT JOIN boards b ON b.id = p.board_id
          WHERE p.deleted = 0
            AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.anchor_post_id = p.id)
          ORDER BY p.id ASC`,
      );
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

    /* ---------------- 草稿箱 ---------------- */

    /** 草稿行；没有就是「这篇没有草稿」（`document_blocks` 直接是线上内容）。 */
    draftOf(documentId) {
      return get('SELECT document_id, published, created_at, updated_at FROM doc_drafts WHERE document_id = ?', [documentId]) ?? null;
    },

    /**
     * 进草稿箱。**已有行就什么都不做** —— `published` 是「这篇对外存在过没有」的既成事实，
     * 不能被一次插入覆盖（覆盖了就会把已发布文档的线上版弄丢）。
     */
    enterDraftBox({ documentId, published = 1, now }) {
      run(
        `INSERT INTO doc_drafts (document_id, published, created_at, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(document_id) DO NOTHING`,
        [documentId, published ? 1 : 0, now, now],
      );
    },

    /** 草稿又改了：只动时间戳（草稿箱按它倒序排）。回改了没有。 */
    touchDraft({ documentId, now }) {
      return Number(run('UPDATE doc_drafts SET updated_at = ? WHERE document_id = ?', [now, documentId]).changes ?? 0);
    },

    clearDraft(documentId) {
      run('DELETE FROM doc_drafts WHERE document_id = ?', [documentId]);
    },

    /** 线上版正文（发布那一刻的快照；没有草稿行时没人读它）。 */
    publishedBlocksOf(documentId) {
      return all(`SELECT ${BLOCK_COLUMNS} FROM doc_published_blocks WHERE document_id = ? ORDER BY position ASC, id ASC`, [documentId]);
    },

    /**
     * 把当前 `document_blocks` 整份拷成线上版。
     *
     * 两个调用方共用：**发布**（拷改完的那份给读者）与 **beginDraft**（拷改之前的那份留底）。
     * 先删后插：块可能被删过，留着旧行会让读者看到作者已经拿掉的东西。
     */
    copyPublishedBlocks({ documentId, now }) {
      run('DELETE FROM doc_published_blocks WHERE document_id = ?', [documentId]);
      run(
        `INSERT INTO doc_published_blocks (document_id, block_id, type, type_version, position, props_json, created_at, updated_at)
         SELECT document_id, block_id, type, type_version, position, props_json, created_at, ?
           FROM document_blocks WHERE document_id = ? ORDER BY position ASC, id ASC`,
        [now, documentId],
      );
    },

    deletePublishedBlocks(documentId) {
      run('DELETE FROM doc_published_blocks WHERE document_id = ?', [documentId]);
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

    /* ---------- 每篇文档一份的设置（doc_settings，第二轮） ---------- */

    /**
     * 这篇文档的设置行；**没有就返回 null**（调用方按默认值算）。
     * 刻意不在这里造默认行：绝大多数文档一辈子不改设置，
     * 每次 GET 顺手 INSERT 一行会把「读接口」变成「写接口」。
     */
    settingsOf(documentId) {
      return (
        get('SELECT document_id, allow_script_write, app_mode, station_id, parent_id, sort_order, icon, source_text, updated_at FROM doc_settings WHERE document_id = ?', [
          documentId,
        ]) ?? null
      );
    },

    /** 整行 upsert（store 传的是「合并后的完整设置」，所以这里不做部分更新）。 */
    upsertSettings({ documentId, allowScriptWrite, appMode, stationId, parentId, sortOrder, icon, sourceText, now }) {
      run(
        `INSERT INTO doc_settings (document_id, allow_script_write, app_mode, station_id, parent_id, sort_order, icon, source_text, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (document_id) DO UPDATE SET
           allow_script_write = excluded.allow_script_write,
           app_mode           = excluded.app_mode,
           station_id         = excluded.station_id,
           parent_id          = excluded.parent_id,
           sort_order         = excluded.sort_order,
           icon               = excluded.icon,
           source_text        = excluded.source_text,
           updated_at         = excluded.updated_at`,
        [documentId, allowScriptWrite ? 1 : 0, appMode, stationId, parentId, sortOrder, icon, sourceText, now],
      );
    },

    /**
     * 只动 `source_text`（保存源码的热路径）。
     * 单独一条而不是先读后写整行：读-改-写在两个人同时保存时会互相踩掉对方刚改的开关。
     */
    setSourceText({ documentId, sourceText, now }) {
      run(
        `INSERT INTO doc_settings (document_id, source_text, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (document_id) DO UPDATE SET source_text = excluded.source_text, updated_at = excluded.updated_at`,
        [documentId, sourceText, now],
      );
    },

    /** 只动 `station_id`（迁移收编一页时用，别碰作者可能已经设过的其它开关）。 */
    setStationId({ documentId, stationId, parentId, sortOrder, now }) {
      run(
        `INSERT INTO doc_settings (document_id, station_id, parent_id, sort_order, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (document_id) DO UPDATE SET station_id = excluded.station_id, parent_id = excluded.parent_id, sort_order = excluded.sort_order, updated_at = excluded.updated_at`,
        [documentId, stationId, parentId, sortOrder, now],
      );
    },

    /**
     * 只动一篇的 `sort_order`（站务公告的手动顺序，见 `store.reorderAnnouncements`）。
     *
     * 为什么不复用上面的 `upsertSettings`：那个函数一次写全部八列，调用方得先把现有值
     * 读出来再原样写回 —— 中间任何一次并发编辑都会被默默覆盖掉。排顺序只碰一列。
     *
     * 行不存在时直接插一行（其余列全靠 DDL 默认值），所以「第一次给某篇排顺序」
     * 不需要先建 settings 行。
     */
    setSortOrder({ documentId, sortOrder, now }) {
      run(
        `INSERT INTO doc_settings (document_id, sort_order, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (document_id) DO UPDATE SET sort_order = excluded.sort_order, updated_at = excluded.updated_at`,
        [documentId, Math.trunc(Number(sortOrder) || 0), now],
      );
    },

    /** 一批文档各自的 `sort_order`（一次查完，别在循环里一篇篇查）。 */
    sortOrdersOf(ids = []) {
      const list = ids.map((value) => Number(value)).filter((id) => Number.isInteger(id) && id > 0);
      if (!list.length) return new Map();
      const holes = list.map(() => '?').join(', ');
      const rows = all(
        `SELECT document_id, sort_order FROM doc_settings WHERE document_id IN (${holes})`,
        list,
      );
      return new Map(rows.map((row) => [Number(row.document_id), Number(row.sort_order) || 0]));
    },

    /* ---------- Wiki 站与站内页面（第二轮） ---------- */

    /** 一行的站本体（`template='station'`，kind 照旧是 post => 它照旧是一个正常帖子）。 */
    stationDocument(stationId) {
      return (
        get(`SELECT ${DOC_COLUMNS} ${DOC_SOURCE} WHERE d.id = ? AND d.template = 'station' AND d.deleted = 0`, [stationId]) ?? null
      );
    },

    /** 按标题找一个站（`#/wiki/<名字>` 老语义的兼容入口）。 */
    stationByTitle(title) {
      return (
        get(
          `SELECT ${DOC_COLUMNS} ${DOC_SOURCE} WHERE d.template = 'station' AND d.title = ? COLLATE NOCASE AND d.deleted = 0 ORDER BY d.id ASC LIMIT 1`,
          [String(title)],
        ) ?? null
      );
    },

    /**
     * 站列表。`pages` 是站里的页数 —— 站卡片上要显示「12 页」。
     * 只数 `deleted = 0` 的页，逻辑删除的页不该算进目录里。
     */
    stations({ visible = null } = {}) {
      const where = ["d.template = 'station'", 'd.deleted = 0'];
      const params = [];
      if (visible) {
        where.push(visible.sql);
        params.push(...visible.params);
      }
      return all(
        `SELECT ${DOC_COLUMNS},
                (SELECT COUNT(*) FROM doc_settings s
                   JOIN documents p ON p.id = s.document_id
                  WHERE s.station_id = d.id AND p.deleted = 0) AS pages
           FROM documents d JOIN users u ON u.id = d.user_id
          WHERE ${where.join(' AND ')}
          ORDER BY d.updated_at DESC, d.id DESC`,
        params,
      );
    },

    /**
     * 一个站里的所有页（带树需要的 parent_id / sort_order / icon）。
     *
     * `visible` 必须给：树是**唯一一处「把一个站的所有页一次性端出来」**的地方，
     * 漏一个条件就是泄露别人的私有页。
     */
    pagesOfStation({ stationId, visible = null } = {}) {
      const where = ["d.template = 'page'", 'd.deleted = 0', 's.station_id = ?'];
      const params = [stationId];
      if (visible) {
        where.push(visible.sql);
        params.push(...visible.params);
      }
      return all(
        `SELECT d.id, d.title, d.scope, d.user_id, d.updated_at, u.username, u.display_name,
                s.parent_id, s.sort_order, s.icon, s.source_text
           FROM documents d
           JOIN users u ON u.id = d.user_id
           JOIN doc_settings s ON s.document_id = d.id
          WHERE ${where.join(' AND ')}
          ORDER BY s.parent_id ASC, s.sort_order ASC, d.title COLLATE NOCASE ASC`,
        params,
      );
    },

    /**
     * 还没归站的 wiki 页（`template='page'` 且没有 station_id）。
     * 迁移用：幂等收编就是「把这一批各挂到一个站上，下次查就是空集」。
     */
    orphanPages(limit = 200) {
      return all(
        `SELECT d.id, d.title, d.user_id, d.created_at, d.updated_at
           FROM documents d
           LEFT JOIN doc_settings s ON s.document_id = d.id
          WHERE d.template = 'page' AND d.deleted = 0 AND COALESCE(s.station_id, 0) = 0
          ORDER BY d.id ASC LIMIT ?`,
        [Math.min(Math.max(Number(limit) || 200, 1), 500)],
      );
    },

    /**
     * 所有**看得见的** wiki 页标题 —— 红链判断（§6.4）只要标题，所以别把整行拖出来。
     *
     * 双链是正文里的文本，可能指向任何一个站里的页，所以这里不按站过滤：
     * 只要「这一页确实存在且我看得见」，它就不该画成红的。
     */
    wikiPageTitles({ visible = null } = {}) {
      const where = ["d.template = 'page'", 'd.deleted = 0'];
      const params = [];
      if (visible) {
        where.push(visible.sql);
        params.push(...visible.params);
      }
      return all(`SELECT d.title FROM documents d WHERE ${where.join(' AND ')}`, params).map((row) => String(row.title));
    },

    /** 一批文档 id → 标题。`subpage` 卡片在渲染时现查标题，改完标题卡片跟着变。 */
    titlesOf(ids = []) {
      const list = (Array.isArray(ids) ? ids : [])
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0)
        .slice(0, 200);
      if (list.length === 0) return [];
      const holes = list.map(() => '?').join(', ');
      return all(`SELECT id, title FROM documents WHERE id IN (${holes}) AND deleted = 0`, list);
    },

    /**
     * 站内搜索。**不建新表、不搞 FTS**：标题 + `source_text` 两个 LIKE 就够用，
     * 而且 `source_text` 是作者敲的原文（比「解析再拼回来」的块序列更忠实）。
     * `%` / `_` 按字面量处理（ESCAPE 子句），否则用户搜 `100%` 会命中全站。
     */
    searchStationPages({ stationId, q, visible = null, limit = 50 } = {}) {
      const pattern = `%${String(q ?? '').replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
      const where = ["d.template = 'page'", 'd.deleted = 0', 's.station_id = ?', "(d.title LIKE ? ESCAPE '\\' OR s.source_text LIKE ? ESCAPE '\\')"];
      const params = [stationId, pattern, pattern];
      if (visible) {
        where.push(visible.sql);
        params.push(...visible.params);
      }
      return all(
        `SELECT d.id, d.title, d.scope, d.user_id, d.updated_at, s.parent_id, s.source_text
           FROM documents d
           JOIN doc_settings s ON s.document_id = d.id
          WHERE ${where.join(' AND ')}
          ORDER BY d.updated_at DESC, d.id DESC
          LIMIT ?`,
        [...params, Math.min(Math.max(Number(limit) || 50, 1), 50)],
      );
    },

    /* ---------- 派生层：脚本产出的块（doc_script_blocks，第二轮） ---------- */

    /**
     * 这篇文档的派生行：**全站共享的 + 当前访问者自己的**，按位置排。
     * 未登录（userId = null）只看得到 shared —— 这正好是「脚本能画什么」的天然边界。
     */
    derivedBlocks(documentId, userId = null) {
      return all(
        `SELECT document_id, scope, user_id, block_id, type, props_json, position, updated_at
           FROM doc_script_blocks
          WHERE document_id = ? AND (scope = 'shared' OR (scope = 'user' AND user_id = ?))
          ORDER BY position ASC, block_id ASC`,
        [documentId, Number(userId) || 0],
      );
    },

    derivedBlockRow(documentId, scope, userId, blockId) {
      return (
        get('SELECT document_id, scope, user_id, block_id, type, props_json, position, updated_at FROM doc_script_blocks WHERE document_id = ? AND scope = ? AND user_id = ? AND block_id = ?', [
          documentId,
          scope,
          userId,
          blockId,
        ]) ?? null
      );
    },

    upsertDerivedBlock({ documentId, scope, userId, blockId, type, propsJson, position, now }) {
      run(
        `INSERT INTO doc_script_blocks (document_id, scope, user_id, block_id, type, props_json, position, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (document_id, scope, user_id, block_id) DO UPDATE SET
           type = excluded.type, props_json = excluded.props_json, position = excluded.position, updated_at = excluded.updated_at`,
        [documentId, scope, userId, blockId, type, propsJson, position, now],
      );
    },

    deleteDerivedBlock(documentId, scope, userId, blockId) {
      run('DELETE FROM doc_script_blocks WHERE document_id = ? AND scope = ? AND user_id = ? AND block_id = ?', [
        documentId,
        scope,
        userId,
        blockId,
      ]);
    },

    deleteDerivedBlockEverywhere(documentId, blockId) {
      run('DELETE FROM doc_script_blocks WHERE document_id = ? AND block_id = ?', [documentId, blockId]);
    },

    deleteDerivedBlocksOfDocument(documentId) {
      run('DELETE FROM doc_script_blocks WHERE document_id = ?', [documentId]);
    },

    countDerivedBlocks(documentId, scope, userId) {
      return Number(
        get('SELECT COUNT(*) AS n FROM doc_script_blocks WHERE document_id = ? AND scope = ? AND user_id = ?', [documentId, scope, userId])?.n ?? 0,
      );
    },

    /** 整篇派生层的字节数（配额判定用；`length()` 在 SQLite 里数的是字符，够用）。 */
    derivedBytesOfDocument(documentId) {
      return Number(get('SELECT COALESCE(SUM(LENGTH(props_json)), 0) AS n FROM doc_script_blocks WHERE document_id = ?', [documentId])?.n ?? 0);
    },

    maxDerivedPosition(documentId, scope, userId) {
      const row = get('SELECT MAX(position) AS p FROM doc_script_blocks WHERE document_id = ? AND scope = ? AND user_id = ?', [
        documentId,
        scope,
        userId,
      ]);
      return row?.p == null ? 0 : Number(row.p);
    },

    /* ---------- 全站共享状态（doc_site_state，第二轮） ---------- */

    siteStateOf(namespace, key, userId = 0) {
      return get('SELECT value, updated_at FROM doc_site_state WHERE namespace = ? AND key = ? AND user_id = ?', [namespace, key, userId]) ?? null;
    },

    upsertSiteState({ namespace, key, userId = 0, value, now }) {
      run(
        `INSERT INTO doc_site_state (namespace, key, user_id, value, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (namespace, key, user_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [namespace, key, userId, value, now],
      );
    },

    countSiteStateKeys(namespace) {
      return Number(get('SELECT COUNT(*) AS n FROM doc_site_state WHERE namespace = ?', [namespace])?.n ?? 0);
    },

    /** namespace 级联清空（staff 用；脚本块被删时也走它回收）。 */
    deleteSiteStateOfNamespace(namespace) {
      run('DELETE FROM doc_site_state WHERE namespace = ?', [namespace]);
    },

    /* ---------- 脚本模板（doc_script_templates，第三轮：开发者功能） ---------- */

    scriptTemplatesOfUser(userId) {
      return all(
        `SELECT id, name, description, code, created_at, updated_at
           FROM doc_script_templates
          WHERE user_id = ?
          ORDER BY updated_at DESC, id DESC`,
        [userId],
      );
    },

    scriptTemplateOf({ id, userId }) {
      return (
        get('SELECT id, name, description, code, created_at, updated_at FROM doc_script_templates WHERE id = ? AND user_id = ?', [id, userId]) ?? null
      );
    },

    scriptTemplateIdOfName(userId, name) {
      return get('SELECT id FROM doc_script_templates WHERE user_id = ? AND name = ?', [userId, name]) ?? null;
    },

    countScriptTemplatesOfUser(userId) {
      return Number(get('SELECT COUNT(*) AS n FROM doc_script_templates WHERE user_id = ?', [userId])?.n ?? 0);
    },

    insertScriptTemplate({ userId, name, description, code, now }) {
      run(
        `INSERT INTO doc_script_templates (user_id, name, description, code, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [userId, name, description, code, now, now],
      );
    },

    updateScriptTemplate({ id, userId, name, description, code, now }) {
      run('UPDATE doc_script_templates SET name = ?, description = ?, code = ?, updated_at = ? WHERE id = ? AND user_id = ?', [
        name,
        description,
        code,
        now,
        id,
        userId,
      ]);
    },

    deleteScriptTemplate({ id, userId }) {
      run('DELETE FROM doc_script_templates WHERE id = ? AND user_id = ?', [id, userId]);
    },

    /* ---------- 标签（doc_tags，第四轮：替代下线的学术笔记） ---------- */

    /**
     * 一篇的标签，**按作者写的顺序**回（`rowid` 就是插入顺序）。
     * 不按字典序：作者把「学术笔记」写在最前面，卡片上就该排在最前面；
     * 换个排法会让「我只想调一下顺序」变成做不到的事。
     */
    tagsOf(documentId) {
      return all('SELECT tag FROM doc_tags WHERE document_id = ? ORDER BY rowid ASC', [documentId]).map((row) => String(row.tag));
    },

    /**
     * 一次问一批：列表页每张卡片都要标签，逐个查就是 N+1。
     * 回 `Map<documentId, string[]>`（没有标签的文档不在表里，调用方 `?? []`）。
     * 同一篇内同样按 rowid（作者顺序），跨篇按 document_id。
     */
    tagsFor(ids) {
      const list = (ids ?? []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0);
      const byDoc = new Map();
      if (list.length === 0) return byDoc;
      const holes = list.map(() => '?').join(', ');
      const rows = all(`SELECT document_id, tag FROM doc_tags WHERE document_id IN (${holes}) ORDER BY document_id ASC, rowid ASC`, list);
      for (const row of rows) {
        const key = Number(row.document_id);
        if (!byDoc.has(key)) byDoc.set(key, []);
        byDoc.get(key).push(String(row.tag));
      }
      return byDoc;
    },

    /** 覆盖式写入：标签是一份名单，不是可增删的条目（改一次 = 删光重写）。 */
    replaceTags({ documentId, tags = [], now }) {
      run('DELETE FROM doc_tags WHERE document_id = ?', [documentId]);
      for (const tag of tags) {
        run('INSERT OR IGNORE INTO doc_tags (document_id, tag, created_at) VALUES (?, ?, ?)', [documentId, String(tag), now]);
      }
    },

    deleteTagsOfDocument(documentId) {
      run('DELETE FROM doc_tags WHERE document_id = ?', [documentId]);
    },

    /**
     * 用过的标签 + 各自篇数（广场的标签云、编辑器的候选项都读它）。
     *
     * `visible` 与列表是同一份：标签云不能把「别人看不见的文档的标签」漏出来。
     */
    popularTags({ visible = null, limit = 24 } = {}) {
      const conditions = ['d.deleted = 0'];
      const params = [];
      if (visible) {
        conditions.push(visible.sql);
        params.push(...visible.params);
      }
      const size = Math.min(Math.max(Number(limit) || 24, 1), 100);
      const rows = all(
        `SELECT t.tag AS tag, COUNT(*) AS n
           FROM doc_tags t JOIN documents d ON d.id = t.document_id
          WHERE ${conditions.join(' AND ')}
          GROUP BY t.tag
          ORDER BY n DESC, t.tag ASC
          LIMIT ?`,
        [...params, size],
      );
      return rows.map((row) => ({ tag: String(row.tag), count: Number(row.n) }));
    },
  };
}
