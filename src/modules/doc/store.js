// doc 模块的服务层：权限判断、修订快照、影子行同步、块序列的读写。
//
// 分层（与 feed 一致，别再拆细）：
//   queries.js  只有 SQL
//   store.js    只有业务（谁能看 / 谁能改 / 改完要留什么证据）
//   routes.js   只有 HTTP（解析参数、给状态码）
//
// 三条贯穿全文件的硬约定：
//   1. 越权一律 **404**（不是 403）—— 403 会告诉攻击者"这个 id 是存在的"。
//   2. 每次改变块序列都写一条修订（S1 起就是设计的一部分，不是补丁）。
//   3. 影子行跟着文档走：scope 变、标题变、删除，都要同步过去，
//      因为点赞 / 投币 / 收藏三个核心接口只认 `posts` 那一行。
import { HttpError } from '../../core/http.js';
import { isStaff } from '../../core/guards.js';
import {
  DOC_KINDS,
  DOC_SCOPES,
  MAX_DOC_BLOCKS,
  MAX_DOC_BODY_BYTES,
  MAX_DOC_REVISIONS,
  MAX_DOC_TITLE,
  BLOCK_TYPE_PATTERN,
  MAX_APP_CODE,
  MAX_APP_STATE,
  APP_STATE_SCOPES,
  SANDBOX_CAPABILITIES,
} from './schema.js';
import { createAnchor, syncAnchor } from './anchor.js';
import { blockFromRow } from './queries.js';
import { createVisibility, detectTeams, visibilityConditions } from './visibility.js';
import {
  blocksToMarkdown,
  blocksToPlainText,
  coerceProps,
  getBlockType,
  isSandboxType,
  listBlockTypes as engineListBlockTypes,
  markdownToBlocks,
  registerBlockType,
  renderBlocks,
} from './blocks/index.js';
import { applyDocOps, MAX_OPS } from './blocks/ops.js';
import { hasTemplate, templateBlocks, templateList, WIKI_TEMPLATE } from './templates.js';
import { KIND_LABELS, REASON_LABELS, SCOPE_LABELS, shapeDoc, shapeRevision } from './shape.js';

/** 一条 op 被拒的原因 → 给人看的话（前端直接显示，不再自己映射一遍）。 */
const OP_REASON_LABELS = {
  unknown_kind: '不认识的改动类型',
  bad_target: '找不到要改的块',
  unknown_type: '不认识的块类型',
  empty_text: '内容为空',
  text_too_long: '内容太长',
  too_many_ops: '一次改动太多条',
};

function stamp(ms) {
  return new Date(Number(ms) || 0).toISOString().slice(0, 16).replace('T', ' ');
}

function badRequest(message) {
  return new HttpError(400, 'bad_request', message);
}

/** 不可见就当不存在（登陆与否决定 401 还是 404）。 */
function notFound(viewer) {
  return viewer ? new HttpError(404, 'not_found', '文档不存在') : new HttpError(401, 'unauthenticated', '请先登录');
}

/**
 * @param {{db:object, queries:object, now?:() => number}} deps
 */
export function createDocStore({ db, queries, now = () => Date.now() }) {
  const hasTeams = detectTeams(db);
  const { canView, canEdit } = createVisibility({ db, hasTeams });

  /* ---------------- 内部工具 ---------------- */

  function normalizeTitle(value, { required = false } = {}) {
    const text = typeof value === 'string' ? value.replace(/[\r\n]+/g, ' ').trim() : '';
    if (!text && required) throw badRequest('标题不能为空');
    if (text.length > MAX_DOC_TITLE) throw badRequest(`标题不能超过 ${MAX_DOC_TITLE} 个字`);
    return text;
  }

  /** 单行文本：换行 / 连续空白压成一个空格，再去掉首尾空白。分类这类字段用。 */
  function singleLineText(value) {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  }

  function normalizeKind(value) {    const kind = String(value ?? 'post');
    if (!DOC_KINDS.includes(kind)) throw badRequest(`不认识的文档类型：${kind}`);
    return kind;
  }

  function normalizeScope(value) {
    const scope = String(value ?? 'public');
    if (!DOC_SCOPES.includes(scope)) throw badRequest(`不认识的可见范围：${scope}`);
    return scope;
  }

  /** 取一行文档；不存在 / 已删 → 404。不做权限判断。 */
  function mustExist(id) {
    const row = queries.documentById(id);
    if (!row || row.deleted) throw new HttpError(404, 'not_found', '文档不存在');
    return row;
  }

  /** 取一行文档，并要求当前用户**看得见**。 */
  function mustSee(id, viewer) {
    const row = queries.documentById(id);
    if (!row || row.deleted) throw new HttpError(404, 'not_found', '文档不存在');
    if (!canView(row, viewer)) throw notFound(viewer);
    return row;
  }

  /** 取一行文档，并要求当前用户**改得动**。不可见一律 404；可见但不是自己的 403。 */
  function mustEdit(id, viewer) {
    const row = mustSee(id, viewer);
    if (!canEdit(row, viewer)) throw new HttpError(403, 'forbidden', '不能修改别人的文档');
    return row;
  }

  function readBlocks(documentId) {
    return queries.blocksOf(documentId).map(blockFromRow);
  }

  /**
   * 把 props 规范成可存的形式：注册过的类型走 `coerceProps` 补默认值，
   * 没注册过的（导入进来的未知块）**原样保留** —— 我们不该毁掉别人的数据。
   */
  function serializeBlock(block) {
    const typeDef = getBlockType(block?.type);
    // 沙箱代码在**保存时**就卡住长度（§6.3）。
    // 不能靠 coerceProps 的「超长字符串截断」，因为那对代码是危险行为：
    // 用户会以为存进去了，跑起来却是半截程序。这里宁可报错。
    if (typeDef?.name === 'app') {
      const raw = block?.props?.code;
      if (typeof raw === 'string' && raw.length > MAX_APP_CODE) {
        throw badRequest(`代码太长了：最多 ${MAX_APP_CODE} 个字符，现在 ${raw.length} 个`);
      }
    }
    const props = typeDef ? coerceProps(typeDef, block?.props) : block?.props && typeof block.props === 'object' ? block.props : {};
    return {
      block_id: block?.block_id,
      type: String(block?.type ?? ''),
      version: Number(block?.version) || typeDef?.version || 1,
      props,
      propsJson: JSON.stringify(props),
    };
  }

  function assertBudget(count) {
    if (count > MAX_DOC_BLOCKS) throw badRequest(`一篇文档最多 ${MAX_DOC_BLOCKS} 块，当前 ${count} 块`);
  }

  /** 整篇替换块序列（Markdown 导入、ops、套模板、回滚都走它）。 */
  function writeBlocks(documentId, blocks, at) {
    assertBudget(blocks.length);
    queries.deleteBlocksOf(documentId);
    for (const [index, block] of blocks.entries()) {
      const shaped = serializeBlock(block);
      if (!shaped.block_id || !/^b\d+$/.test(shaped.block_id)) shaped.block_id = `b${index + 1}`;
      queries.insertBlockRow({
        documentId,
        blockId: shaped.block_id,
        type: shaped.type,
        version: shaped.version,
        position: index + 1,
        propsJson: shaped.propsJson,
        now: at,
      });
    }
    // 整批换过块序列之后，投给「已经被换掉的投票块 / 已经删掉的选项」的票必须清掉。
    reconcilePollVotes(documentId);
    // 同理：被换掉的块存过的沙箱状态也没有主人了。
    reconcileAppState(documentId);
  }

  /** 写入一条修订（并裁掉过老的）。每次改动块序列后调用。 */
  function snapshot(documentId, reason, authorId, at) {
    const revision = queries.latestRevisionNumber(documentId) + 1;
    queries.insertRevisionRow({
      documentId,
      revision,
      blocksJson: JSON.stringify(readBlocks(documentId)),
      reason,
      authorId,
      now: at,
    });
    queries.pruneRevisions(documentId, MAX_DOC_REVISIONS);
    return revision;
  }

  /**
   * 把 `source.kind = 'revisions'` 的列表在**渲染前**填成真实内容（FR-TPL-02）。
   * 只影响返回值，不落库 —— 修订记录要永远是"此刻"的。
   */
  function materializeSources(blocks, documentId) {
    return blocks.map((block) => {
      const source = block.props?.source;
      if (!source || typeof source !== 'object' || source.kind !== 'revisions') return block;
      const limit = Math.min(Math.max(Number(source.limit) || 10, 1), 50);
      const rows = queries.listRevisions(documentId, limit);
      const text = rows.map((row) => `- r${row.revision} · ${stamp(row.created_at)} · ${row.display_name || row.username || '—'} · ${REASON_LABELS[row.reason] ?? row.reason}`).join('\n');
      return { ...block, props: { ...block.props, text } };
    });
  }

  /** 影子行同步：public 才带标题与摘要，其余范围写空串（少泄露一点是一点）。 */
  function syncDocumentAnchor(docRow, at) {
    const anchorId = docRow?.anchor_post_id;
    if (!anchorId) return;
    const isPublic = docRow.scope === 'public';
    const excerpt = isPublic ? blocksToPlainText(readBlocks(docRow.id), 400) : '';
    syncAnchor(db, anchorId, {
      title: isPublic ? docRow.title : '',
      content: excerpt,
      scope: docRow.scope,
      deleted: Boolean(docRow.deleted),
      now: at,
    });
  }

  /**
   * 互动能力。
   *
   * `canReact` / `canCoin` 必须与 `src/core/guards.js` 的 `assertPostVisible` **同规则**：
   * 核心的赞 / 踩 / 投币 / 收藏只认影子行的 `hidden`，而 `hidden` 又只由 scope 决定。
   * 前端照着它藏按钮，才不会出现"点了就 404"的按钮。
   */
  function abilitiesOf(docRow, viewer) {
    const interactionAllowed = docRow.scope === 'public' || Boolean(viewer && (isStaff(viewer) || viewer.id === docRow.user_id));
    return {
      canView: true,
      canEdit: canEdit(docRow, viewer),
      canReact: interactionAllowed,
      canCoin: interactionAllowed,
    };
  }

  /** 详情形状（列表、创建、更新、回滚共用这一个出口）。 */
  function present(docRow, viewer) {
    const blocks = readBlocks(docRow.id);
    const materialized = materializeSources(blocks, docRow.id);
    // `sandboxDisabled` 要交给渲染层：沙箱块据此**连 iframe 都不建**（§6.4）。
    const rendered = renderBlocks(materialized, {
      sandboxDisabled: Boolean(docRow.sandbox_disabled),
      documentId: docRow.id,
    });
    return {
      doc: shapeDoc(docRow),
      blocks: materialized.map((block) => ({
        blockId: block.block_id,
        type: block.type,
        version: Number(block.version) || 1,
        props: block.props ?? {},
      })),
      html: rendered.html,
      warnings: rendered.warnings,
      abilities: abilitiesOf(docRow, viewer),
    };
  }

  /* ---------------- 位置计算 ---------------- */

  /**
   * 算出新块该放在哪个 position。
   *
   * 优先取中点（1 和 2 之间写 1.5），这样插入一块不必重排整篇；
   * 但反复往同一个缝里插会把浮点差值磨到精度以下，那时就重排一次 1..n。
   */
  function computePosition(documentId, { after = null, before = null, position = null } = {}) {
    const rows = queries.blocksOf(documentId);
    if (typeof position === 'number' && Number.isFinite(position)) return position;

    const indexOf = (blockId) => rows.findIndex((row) => row.block_id === blockId);
    let target;
    if (after === 'start') {
      target = rows.length ? rows[0].position - 1 : 1;
    } else if (after) {
      const index = indexOf(after);
      if (index < 0) throw badRequest(`找不到块 ${after}`);
      const next = rows[index + 1];
      target = next ? (rows[index].position + next.position) / 2 : rows[index].position + 1;
    } else if (before) {
      const index = indexOf(before);
      if (index < 0) throw badRequest(`找不到块 ${before}`);
      target = index === 0 ? rows[0].position - 1 : (rows[index - 1].position + rows[index].position) / 2;
    } else {
      target = rows.length ? rows[rows.length - 1].position + 1 : 1;
    }

    const collides = rows.some((row) => Math.abs(Number(row.position) - target) < 1e-9);
    if (!collides) return target;

    // 浮点被磨平了：整篇重排成 1..n，再算一次。
    const at = now();
    rows.forEach((row, index) => queries.setBlockPosition({ documentId, blockId: row.block_id, position: index + 1, now: at }));
    return computePosition(documentId, { after, before, position });
  }

  /* ---------------- 文档 ---------------- */

  function listDocuments({ viewer, kind = '', scope = '', mine = false, q = '', page = 1, limit = 20, sort = 'updated' } = {}) {
    const visible = visibilityConditions(viewer, hasTeams);
    const { rows, total } = queries.listDocuments({
      viewerId: viewer?.id ?? null,
      visible,
      kind,
      scope,
      mine: Boolean(mine),
      q: String(q ?? ''),
      page,
      limit,
      sort,
    });
    return {
      documents: rows.map((row) => shapeDoc(row)),
      total,
      page: Math.max(Number(page) || 1, 1),
      limit: Math.min(Math.max(Number(limit) || 20, 1), 50),
    };
  }

  function getDocument(id, viewer) {
    const row = mustSee(id, viewer);
    return present(row, viewer);
  }

  /** 建一篇文档：正文 + 影子行 + 修订 1，一步不少。 */
  function createDocument({ viewer, title, kind = 'post', scope = 'public', template = '', blocks = null, reason = 'create' } = {}) {
    if (!viewer) throw new HttpError(401, 'unauthenticated', '请先登录');
    const cleanTitle = normalizeTitle(title);
    const cleanKind = normalizeKind(kind);
    const cleanScope = normalizeScope(scope);
    const cleanTemplate = String(template ?? '');
    if (cleanTemplate && !hasTemplate(cleanTemplate)) throw badRequest(`不认识的模板：${cleanTemplate}`);
    // 一个用户至多一份 profile 文档（§8.2）：已经有了就把那一篇原样交回去，
    // 而不是再建一份 —— 否则 `#/u/:name` 每次刷新可能渲染出不同的主页。
    if (cleanKind === 'profile') {
      const existing = queries.activeProfileDocument(viewer.id);
      if (existing) return present(existing, viewer);
    }

    let list;
    if (Array.isArray(blocks) && blocks.length > 0) {
      list = blocks.map((block, index) => ({
        block_id: /^b\d+$/.test(String(block?.block_id ?? '')) ? block.block_id : `b${index + 1}`,
        type: String(block?.type ?? ''),
        version: Number(block?.version) || 1,
        props: block?.props && typeof block.props === 'object' ? block.props : {},
      }));
    } else if (cleanTemplate) {
      list = templateBlocks(cleanTemplate).map((block, index) => ({ ...block, block_id: `b${index + 1}` }));
    } else {
      list = [];
    }
    assertBudget(list.length);

    const at = now();
    const isPublic = cleanScope === 'public';
    // 影子行先建：文档行上要存它的 id（锚点反过来不用存文档 id，靠 anchor_post_id 找回来）。
    const anchorPostId = createAnchor(db, {
      userId: viewer.id,
      title: isPublic ? cleanTitle : '',
      content: isPublic ? blocksToPlainText(list, 400) : '',
      scope: cleanScope,
      now: at,
    });
    const id = queries.insertDocument({
      userId: viewer.id,
      kind: cleanKind,
      title: cleanTitle,
      scope: cleanScope,
      template: cleanTemplate,
      anchorPostId,
      now: at,
    });
    writeBlocks(id, list, at);
    snapshot(id, reason, viewer.id, at);
    return present(mustExist(id), viewer);
  }

  /* ---------------- 笔记与个人主页的接线（§8） ---------------- */

  /**
   * 文件笔记的惰性导入（§8.1 / FR-DOC-03）。
   *
   * 笔记的正文这一轮**不搬家**，还住在 data/notes/ 里；这里只是「读到一篇还没进过库的
   * 笔记时，按需把它变成一篇文档」，并把对照关系记进 note_documents，下次就直接读库。
   *
   * 幂等：同一 (viewer, noteName) 再来一次会**复用**已经建好的那一篇。
   * 块序列没变就**不写修订** —— 前端每次打开笔记都会调一次，真写的话 50 条上限当天被冲光。
   * 只允许导入自己的笔记（`viewer` 就是主人）：替别人建文档会让影子行的作者错位。
   */
  function importNote({ viewer, noteName = '', title = '', markdown = '', scope = 'private' } = {}) {
    if (!viewer) throw new HttpError(401, 'unauthenticated', '请先登录');
    const cleanName = String(noteName ?? '').trim();
    const cleanTitle = normalizeTitle(title) || normalizeTitle(cleanName);
    const cleanScope = normalizeScope(scope);
    const text = typeof markdown === 'string' ? markdown : '';
    if (Buffer.byteLength(text, 'utf8') > MAX_DOC_BODY_BYTES) throw badRequest('这篇笔记太长了，超过单篇上限');

    const list = markdownToBlocks(text).map((block, index) => ({ ...block, block_id: `b${index + 1}` }));
    assertBudget(list.length);
    const at = now();

    const linked = cleanName ? queries.noteDocument(viewer.id, cleanName) : null;
    if (linked) {
      const changed = JSON.stringify(readBlocks(linked.id)) !== JSON.stringify(list);
      const metaChanged = linked.title !== cleanTitle || linked.scope !== cleanScope;
      if (changed) {
        writeBlocks(linked.id, list, at);
        snapshot(linked.id, 'import', viewer.id, at);
      }
      if (metaChanged) {
        queries.updateDocumentMeta({ id: linked.id, title: cleanTitle, scope: cleanScope, template: linked.template, updatedAt: at });
        if (!changed) snapshot(linked.id, 'import', viewer.id, at);
      }
      const fresh = mustExist(linked.id);
      if (changed || metaChanged) syncDocumentAnchor(fresh, at);
      return present(fresh, viewer);
    }

    const isPublic = cleanScope === 'public';
    const anchorPostId = createAnchor(db, {
      userId: viewer.id,
      title: isPublic ? cleanTitle : '',
      content: isPublic ? blocksToPlainText(list, 400) : '',
      scope: cleanScope,
      now: at,
    });
    const id = queries.insertDocument({
      userId: viewer.id,
      kind: 'note',
      title: cleanTitle,
      scope: cleanScope,
      template: '',
      anchorPostId,
      now: at,
    });
    writeBlocks(id, list, at);
    snapshot(id, 'import', viewer.id, at);
    if (cleanName) queries.linkNoteDocument({ userId: viewer.id, noteName: cleanName, documentId: id, now: at });
    return present(mustExist(id), viewer);
  }

  /**
   * 按「笔记主人 + 笔记名」读已经导入的那一篇文档；没有 / 看不见 → null。
   * 返回 null 而不是抛 404，是因为调用方（笔记页）要拿它当「要不要退回文件路径」的分支。
   */
  function getNoteDocument({ ownerId, noteName = '', viewer = null } = {}) {
    const userId = Number(ownerId);
    const cleanName = String(noteName ?? '').trim();
    if (!Number.isInteger(userId) || userId <= 0 || !cleanName) return null;
    const row = queries.noteDocument(userId, cleanName);
    if (!row || !canView(row, viewer)) return null;
    return present(row, viewer);
  }

  /** 个人主页用：按用户名找 profile 文档（§8.2）。没有 / 看不见 → null。 */
  function getProfileDocument({ username = '', viewer = null } = {}) {
    const row = queries.profileDocumentByUsername(String(username ?? '').trim());
    if (!row || !canView(row, viewer)) return null;
    return present(row, viewer);
  }

  /* ---------------- Wiki 多页面（`[[目标]]` 的落点） ---------------- */

  /**
   * 按标题找一页 wiki。
   *
   * 「是不是 wiki 页」的判据是 `template = 'page'`（templates.js 的 WIKI_TEMPLATE），
   * 不是「标题恰好相同」—— 否则一篇普通帖子会把同名 wiki 页顶掉。
   * 看不见（私有的别人的页）返回 null，前端据此只说「还没有这一页」，
   * 不泄露「其实有、只是你看不见」。
   */
  function getWikiPage({ name = '', viewer = null } = {}) {
    const title = String(name ?? '').trim();
    if (!title) return null;
    const row = queries.documentByTitle(title, WIKI_TEMPLATE);
    if (!row || !canView(row, viewer)) return null;
    return present(row, viewer);
  }

  /**
   * 打开一页 wiki：有就返回，没有就**当场建**（`[[还没有的页]]` 是 wiki 的正常用法）。
   *
   * 新建时用 `page` 模板、kind 固定 post、scope 由调用方给（默认 public —— wiki 的意义
   * 就在于别人也读得到）。返回 `{ ...presentation, created }`。
   */
  function openWikiPage({ viewer, name = '', scope = 'public' } = {}) {
    if (!viewer) throw new HttpError(401, 'unauthenticated', '请先登录');
    const title = String(name ?? '').trim();
    if (!title) throw badRequest('页面名不能为空');
    if (title.length > MAX_DOC_TITLE) throw badRequest(`页面名太长了（上限 ${MAX_DOC_TITLE} 个字）`);
    const existing = queries.documentByTitle(title, WIKI_TEMPLATE);
    if (existing) {
      if (!canView(existing, viewer)) throw notFound(viewer);
      return { ...present(existing, viewer), created: false };
    }
    const data = createDocument({ viewer, title, kind: 'post', scope, template: WIKI_TEMPLATE, reason: 'template' });
    return { ...data, created: true };
  }

  /**
   * wiki 边栏要的目录：分类（含每类页数）+ 每一页。
   * 只列当前用户**看得见**的页 —— 私有页不能因为名字出现在边栏里而泄露存在性。
   */
  function wikiNav({ viewer = null } = {}) {
    // 范围条件在 SQL 里就过一遍（和 listDocuments 同一条路），
    // 再 `canView` 复核一次：wiki 目录是唯一一处「把所有页一次性端出来」的地方，
    // 漏一页就是泄露，多滤一页就是边栏空着 —— 宁可查两遍。
    const pages = queries
      .listWikiPages({ visible: visibilityConditions(viewer, hasTeams) })
      .filter((row) => canView(row, viewer))
      .map((row) => ({
        id: row.id,
        title: row.title,
        category: row.category || '',
        author: row.username ?? '',
        updatedAt: row.updated_at,
      }));
    const counts = new Map();
    for (const page of pages) counts.set(page.category, (counts.get(page.category) ?? 0) + 1);
    const categories = [...counts.entries()]
      .map(([name, count]) => ({ name, pages: count }))
      .sort((a, b) => (a.name === '' ? 1 : b.name === '' ? -1 : a.name.localeCompare(b.name, 'zh')));
    return { pages, categories };
  }

  /** 设置一页 wiki 的分类与排序。只有能编辑这一页的人能动。 */
  function setWikiMeta({ id, viewer, category = '', sortOrder = 0 } = {}) {
    const row = mustEdit(id, viewer);
    if (String(row.template ?? '') !== WIKI_TEMPLATE) throw badRequest('只有 wiki 页（page 模板）才有分类');
    const clean = singleLineText(category).slice(0, 40);
    const order = Number.isFinite(Number(sortOrder)) ? Math.trunc(Number(sortOrder)) : 0;
    const at = now();
    queries.upsertWikiMeta({ documentId: row.id, category: clean, sortOrder: order, now: at });
    return { id: row.id, category: clean, sortOrder: order, nav: wikiNav({ viewer }) };
  }

  /* ---------------- 投票（§5.2：投票块要真的能投） ---------------- */

  /**
   * 一篇文档里所有投票块的当前票数。
   * 返回的 map **一定会包含文档里每一个 poll 块**（哪怕 0 票），
   * 否则前端拿到 `{polls:{}}` 就分不清「没人投」和「接口没回来」。
   */
  function pollBuckets(documentId, viewer) {
    const polls = {};
    const blank = () => ({ counts: {}, total: 0, voters: 0, mine: [] });
    for (const block of readBlocks(documentId)) {
      if (block.type !== 'poll') continue;
      // `multiple` 跟着桶一起给前端：单选改票时它得知道「换一个 = 换掉原来那个」，
      // 否则会提交两个选项、被后端按「单选只能选一个」打回来。
      polls[block.block_id] = { ...blank(), multiple: block.props?.multiple === true };
    }
    for (const item of queries.pollTallies(documentId)) {
      const bucket = (polls[item.block_id] ??= blank());
      bucket.counts[item.option_id] = Number(item.votes);
      bucket.total += Number(item.votes);
    }
    for (const item of queries.pollVoters(documentId)) {
      const bucket = (polls[item.block_id] ??= blank());
      bucket.voters += 1;
    }
    for (const item of queries.myPollVotes(documentId, viewer?.id ?? null)) {
      const bucket = (polls[item.block_id] ??= blank());
      bucket.mine.push(item.option_id);
    }
    return polls;
  }

  /** 读投票状态。未登录也能看（`mine` 为空），票数本来就是对所有人公开的。 */
  function getPollState({ id, viewer = null } = {}) {
    const row = mustSee(id, viewer);
    return { id: row.id, polls: pollBuckets(row.id, viewer) };
  }

  /**
   * 投一票。`options` 是**这次要选的选项 id 数组**（单选就一个）。
   *
   * 语义（前端要跟它对齐）：
   * - 必须登录 —— 票挂在人身上，否则既防不了刷、也显示不出「我投了什么」；
   * - 文档必须看得见（`mustSee`），块必须是 poll；
   * - 选项必须是这一块**当前**声明过的 id（作者删掉的选项投不进去）；
   * - 提交 = **改票**，不是累加：先把我的旧票清掉再落新票。所以前端多选时
   *   必须提交「完整的选择集合」，而不是刚点的那一个。
   * - **空数组 = 撤销我的票**（再点一次自己选中的那项）。但「给了几个选项、
   *   一个都不合法」仍然是 400 —— 那是调用方写错了，不是想撤销。
   */
  function votePoll({ id, viewer = null, blockId = '', options = [] } = {}) {
    if (!viewer) throw new HttpError(401, 'unauthenticated', '投票前请先登录');
    const row = mustSee(id, viewer);
    const block = readBlocks(row.id).find((item) => item.block_id === String(blockId ?? ''));
    if (!block) throw new HttpError(404, 'not_found', `找不到块 ${blockId}`);
    if (block.type !== 'poll') throw badRequest('这一块不是投票块');
    const valid = new Set((block.props.options ?? []).map((option) => option.id));
    const asked = [...new Set((Array.isArray(options) ? options : [options]).map((item) => String(item ?? '')))];
    const picked = asked.filter((item) => valid.has(item));
    if (asked.length && !picked.length) throw badRequest('请至少选一个选项');
    if (!block.props.multiple && picked.length > 1) throw badRequest('这是单选投票，一次只能选一个');
    const at = now();
    queries.clearMyPollVotes(row.id, blockId, viewer.id);
    for (const optionId of picked) {
      queries.insertPollVote({ documentId: row.id, blockId, optionId, userId: viewer.id, now: at });
    }
    return { id: row.id, blockId, ...pollBuckets(row.id, viewer)[blockId] };
  }

  /**
   * 清掉「已经没有主」的票：块被删了、块不再是 poll、或者选项被作者删掉了。
   * 改 Markdown、套模板、回滚、ops 都会整批换掉块序列，所以这些路径都要调它，
   * 否则库里会留下投给不存在选项的票（票数对不上，且永远清不掉）。
   */
  function reconcilePollVotes(documentId) {
    const polls = readBlocks(documentId).filter((item) => item.type === 'poll');
    const alive = new Set(polls.map((item) => item.block_id));
    for (const item of queries.pollVoteBlocks(documentId)) {
      if (!alive.has(item.block_id)) queries.deletePollVotesOfBlock(documentId, item.block_id);
    }
    for (const block of polls) {
      queries.prunePollVotes(
        documentId,
        block.block_id,
        (block.props.options ?? []).map((option) => option.id),
      );
    }
  }

  function updateDocument({ id, viewer, title, scope, template } = {}) {
    const row = mustEdit(id, viewer);
    const cleanTitle = title === undefined ? row.title : normalizeTitle(title);
    const cleanScope = scope === undefined ? row.scope : normalizeScope(scope);
    const cleanTemplate = template === undefined ? String(row.template ?? '') : String(template ?? '');
    if (cleanTemplate && !hasTemplate(cleanTemplate)) throw badRequest(`不认识的模板：${cleanTemplate}`);
    const at = now();
    queries.updateDocumentMeta({ id: row.id, title: cleanTitle, scope: cleanScope, template: cleanTemplate, updatedAt: at });
    // 元信息变了只写修订、不动块序列（修订表存的是块，但 reason 会记成 edit）。
    snapshot(row.id, 'edit', viewer.id, at);
    const fresh = mustExist(row.id);
    syncDocumentAnchor(fresh, at);
    return present(fresh, viewer);
  }

  function deleteDocument({ id, viewer } = {}) {
    const row = mustEdit(id, viewer);
    const at = now();
    queries.softDeleteDocument(row.id, at);
    // 文档删掉之后它的票再也读不到，留着只会让库越来越大。
    queries.deletePollVotesOfDocument(row.id);
    // 沙箱块的状态同理：文档都没了，状态也不该继续占地方。
    queries.deleteAppStatesOfDocument(row.id);
    syncDocumentAnchor({ ...row, deleted: 1 }, at);
    return { id: row.id, deleted: true };
  }

  /* ---------------- 块 ---------------- */

  function addBlock({ id, viewer, type, props = {}, after = null, before = null, position = null } = {}) {
    const row = mustEdit(id, viewer);
    const typeDef = getBlockType(type);
    if (!typeDef) throw badRequest(`不认识的块类型：${type}`);
    assertBudget(queries.countBlocks(row.id) + 1);
    const at = now();
    const blockId = `b${queries.nextBlockNumber(row.id)}`;
    const place = computePosition(row.id, { after, before, position });
    const shaped = serializeBlock({ block_id: blockId, type, version: typeDef.version, props });
    queries.insertBlockRow({
      documentId: row.id,
      blockId,
      type: shaped.type,
      version: shaped.version,
      position: place,
      propsJson: shaped.propsJson,
      now: at,
    });
    snapshot(row.id, 'edit', viewer.id, at);
    syncDocumentAnchor(mustExist(row.id), at);
    return { block: { blockId, type: shaped.type, version: shaped.version, props: shaped.props }, blocks: present(mustExist(row.id), viewer).blocks };
  }

  function updateBlock({ id, viewer, blockId, type, props } = {}) {
    const row = mustEdit(id, viewer);
    const existing = queries.blockRow(row.id, blockId);
    if (!existing) throw new HttpError(404, 'not_found', `找不到块 ${blockId}`);
    const nextType = type === undefined ? existing.type : String(type);
    const typeDef = getBlockType(nextType);
    if (!typeDef) throw badRequest(`不认识的块类型：${nextType}`);
    const nextProps = props === undefined ? JSON.parse(existing.props_json || '{}') : props;
    const shaped = serializeBlock({ block_id: blockId, type: nextType, version: typeDef.version, props: nextProps });
    const at = now();
    queries.updateBlockRow({ documentId: row.id, blockId, type: shaped.type, version: shaped.version, propsJson: shaped.propsJson, now: at });
    snapshot(row.id, 'edit', viewer.id, at);
    reconcilePollVotes(row.id);
    reconcileAppState(row.id);
    syncDocumentAnchor(mustExist(row.id), at);
    return { block: { blockId, type: shaped.type, version: shaped.version, props: shaped.props } };
  }

  function deleteBlock({ id, viewer, blockId } = {}) {
    const row = mustEdit(id, viewer);
    const existing = queries.blockRow(row.id, blockId);
    if (!existing) throw new HttpError(404, 'not_found', `找不到块 ${blockId}`);
    const at = now();
    queries.deleteBlockRow(row.id, blockId);
    snapshot(row.id, 'edit', viewer.id, at);
    reconcilePollVotes(row.id);
    // 块没了，它存的状态也就没有主人了（下次 reconcile 也会兜住，这里顺手清干净）。
    queries.deleteAppStatesOfBlock(row.id, blockId);
    syncDocumentAnchor(mustExist(row.id), at);
    return { blockId, deleted: true };
  }

  function moveBlock({ id, viewer, blockId, after = null, before = null, position = null } = {}) {
    const row = mustEdit(id, viewer);
    const existing = queries.blockRow(row.id, blockId);
    if (!existing) throw new HttpError(404, 'not_found', `找不到块 ${blockId}`);
    if (after === blockId || before === blockId) throw badRequest('不能把块挪到自己旁边');
    const at = now();
    const place = computePosition(row.id, { after, before, position });
    queries.setBlockPosition({ documentId: row.id, blockId, position: place, now: at });
    snapshot(row.id, 'edit', viewer.id, at);
    syncDocumentAnchor(mustExist(row.id), at);
    return { blockId, position: place, blocks: present(mustExist(row.id), viewer).blocks };
  }

  /** 拖拽排序：给一份完整的块 id 顺序，一次落库（顺便把 position 重排成整数）。 */
  function reorderBlocks({ id, viewer, order } = {}) {
    const row = mustEdit(id, viewer);
    if (!Array.isArray(order) || order.length === 0) throw badRequest('order 必须是非空数组');
    const rows = queries.blocksOf(row.id);
    const known = new Set(rows.map((item) => item.block_id));
    const seen = new Set();
    for (const blockId of order) {
      if (!known.has(blockId)) throw badRequest(`找不到块 ${blockId}`);
      if (seen.has(blockId)) throw badRequest(`order 里重复了块 ${blockId}`);
      seen.add(blockId);
    }
    const at = now();
    let cursor = 1;
    for (const blockId of order) queries.setBlockPosition({ documentId: row.id, blockId, position: cursor++, now: at });
    for (const item of rows) {
      if (seen.has(item.block_id)) continue;
      queries.setBlockPosition({ documentId: row.id, blockId: item.block_id, position: cursor++, now: at });
    }
    snapshot(row.id, 'edit', viewer.id, at);
    syncDocumentAnchor(mustExist(row.id), at);
    return { blocks: present(mustExist(row.id), viewer).blocks };
  }

  /* ---------------- 批量 op ---------------- */

  function runOps({ id, viewer, ops } = {}) {
    const row = mustEdit(id, viewer);
    if (!Array.isArray(ops)) throw badRequest('ops 必须是数组');
    if (ops.length > MAX_OPS) throw badRequest(`一次最多 ${MAX_OPS} 条 op`);
    const at = now();
    // 注意：ops 必须作用在**原始块**上，不能作用在 materializeSources 的结果上 ——
    // 那会把"修订记录"这一刻的文本固化进库，从此再也不更新。
    const result = applyDocOps(readBlocks(row.id), ops, {
      startNumber: queries.nextBlockNumber(row.id),
      isKnownType: (type) => Boolean(getBlockType(type)),
    });

    if (result.title !== null) {
      const cleanTitle = normalizeTitle(result.title, { required: true });
      queries.updateDocumentMeta({ id: row.id, title: cleanTitle, scope: row.scope, template: row.template, updatedAt: at });
    }
    writeBlocks(row.id, result.blocks, at);
    snapshot(row.id, 'ops', viewer.id, at);
    const fresh = mustExist(row.id);
    syncDocumentAnchor(fresh, at);
    return {
      applied: result.applied,
      rejected: result.rejected.map((item) => ({ ...item, message: OP_REASON_LABELS[item.reason] ?? '这一条没能应用' })),
      document: present(fresh, viewer),
    };
  }

  /* ---------------- Markdown 读写 ---------------- */

  function getMarkdown({ id, viewer } = {}) {
    const row = mustSee(id, viewer);
    return { title: row.title, markdown: blocksToMarkdown(readBlocks(row.id)), updatedAt: row.updated_at };
  }

  function putMarkdown({ id, viewer, markdown, title } = {}) {
    const row = mustEdit(id, viewer);
    const text = typeof markdown === 'string' ? markdown : '';
    if (Buffer.byteLength(text, 'utf8') > MAX_DOC_BODY_BYTES) throw badRequest('正文太大了（上限 256 KB）');
    const blocks = markdownToBlocks(text);
    assertBudget(blocks.length);
    const at = now();
    const cleanTitle = title === undefined ? row.title : normalizeTitle(title);
    queries.updateDocumentMeta({ id: row.id, title: cleanTitle, scope: row.scope, template: row.template, updatedAt: at });
    writeBlocks(row.id, blocks, at);
    snapshot(row.id, 'edit', viewer.id, at);
    const fresh = mustExist(row.id);
    syncDocumentAnchor(fresh, at);
    return present(fresh, viewer);
  }

  /* ---------------- 模板 ---------------- */

  function applyTemplate({ id, viewer, key, mode = 'replace' } = {}) {
    const row = mustEdit(id, viewer);
    if (!hasTemplate(key)) throw badRequest(`不认识的模板：${key}`);
    if (mode !== 'replace' && mode !== 'append') throw badRequest('mode 只能是 replace 或 append');
    const at = now();
    let list;
    if (mode === 'append') {
      list = [...readBlocks(row.id), ...templateBlocks(key)];
    } else {
      // 覆盖前先留一条旧快照：模板是"一键换掉整篇"，没有快照就真的找不回来了。
      snapshot(row.id, 'template', viewer.id, at);
      list = templateBlocks(key);
    }
    const base = queries.nextBlockNumber(row.id) - 1;
    list = list.map((block, index) => ({ ...block, block_id: `b${base + index + 1}` }));
    assertBudget(list.length);
    writeBlocks(row.id, list, at);
    queries.updateDocumentMeta({ id: row.id, title: row.title, scope: row.scope, template: String(key), updatedAt: at });
    snapshot(row.id, 'template', viewer.id, at);
    const fresh = mustExist(row.id);
    syncDocumentAnchor(fresh, at);
    return present(fresh, viewer);
  }

  /* ---------------- 导入导出 ---------------- */

  const EXPORT_FORMAT = 'forum-doc/1';

  function exportDocument({ id, viewer } = {}) {
    const row = mustSee(id, viewer);
    return {
      format: EXPORT_FORMAT,
      doc: { title: row.title, kind: row.kind, scope: row.scope, template: row.template },
      blocks: readBlocks(row.id).map((block) => ({ blockId: block.block_id, type: block.type, version: block.version, props: block.props })),
      exportedAt: now(),
    };
  }

  function importDocument({ viewer, payload, scope } = {}) {
    if (!viewer) throw new HttpError(401, 'unauthenticated', '请先登录');
    if (!payload || typeof payload !== 'object') throw badRequest('payload 必须是一个对象');
    if (payload.format !== EXPORT_FORMAT) throw badRequest(`不认识的格式：${payload.format}（期望 ${EXPORT_FORMAT}）`);
    const source = Array.isArray(payload.blocks) ? payload.blocks : [];
    if (source.length > MAX_DOC_BLOCKS) throw badRequest(`一篇文档最多 ${MAX_DOC_BLOCKS} 块`);
    const blocks = source.map((block, index) => ({
      block_id: `b${index + 1}`,
      type: String(block?.type ?? ''),
      version: Number(block?.version) || 1,
      props: block?.props && typeof block.props === 'object' ? block.props : {},
    }));
    const doc = payload.doc && typeof payload.doc === 'object' ? payload.doc : {};
    return createDocument({
      viewer,
      title: doc.title ?? '',
      kind: doc.kind ?? 'post',
      scope: scope ?? doc.scope ?? 'private',
      template: doc.template ?? '',
      blocks,
      reason: 'import',
    });
  }

  /* ---------------- 修订与回滚 ---------------- */

  function listRevisions({ id, viewer } = {}) {
    const row = mustSee(id, viewer);
    return { revisions: queries.listRevisions(row.id, MAX_DOC_REVISIONS).map(shapeRevision) };
  }

  function rollback({ id, viewer, revision } = {}) {
    const row = mustEdit(id, viewer);
    const target = queries.revisionByNumber(row.id, Number(revision));
    if (!target) throw new HttpError(404, 'not_found', `找不到修订 r${revision}`);
    let blocks;
    try {
      const parsed = JSON.parse(target.blocks_json ?? '[]');
      blocks = Array.isArray(parsed) ? parsed : [];
    } catch {
      throw badRequest(`修订 r${revision} 的内容坏了，无法回滚`);
    }
    const at = now();
    writeBlocks(row.id, blocks, at);
    snapshot(row.id, 'rollback', viewer.id, at);
    const fresh = mustExist(row.id);
    syncDocumentAnchor(fresh, at);
    return present(fresh, viewer);
  }

  /* ---------------- 自定义块类型 ---------------- */

  function registerCustomBlockType({ viewer, name, version, label, icon, rendererKind = 'declarative', propsSchema = {}, renderer = '' } = {}) {
    if (!viewer) throw new HttpError(401, 'unauthenticated', '请先登录');
    const cleanName = String(name ?? '');
    if (!BLOCK_TYPE_PATTERN.test(cleanName)) throw badRequest(`块类型名不合法：${cleanName}（要求小写字母开头，只含小写字母 / 数字 / 下划线，最长 32）`);
    if (getBlockType(cleanName)) {
      throw new HttpError(409, 'conflict', isBuiltin(cleanName) ? `「${cleanName}」是内置块类型，不能重名` : `块类型「${cleanName}」已经存在`);
    }
    if (rendererKind !== 'declarative' && rendererKind !== 'sandbox') throw badRequest('rendererKind 只能是 declarative 或 sandbox');
    if (propsSchema && typeof propsSchema !== 'object') throw badRequest('propsSchema 必须是对象');
    const at = now();
    queries.insertBlockTypeRow({
      name: cleanName,
      version: Number(version) || 1,
      label: String(label ?? cleanName),
      icon: String(icon ?? '▢'),
      propsSchemaJson: JSON.stringify(propsSchema ?? {}),
      rendererKind,
      rendererJson: typeof renderer === 'string' ? renderer : JSON.stringify(renderer ?? ''),
      createdBy: viewer.id,
      now: at,
    });
    const def = registerBlockType(
      { name: cleanName, version: Number(version) || 1, label, icon, schema: propsSchema, renderer_kind: rendererKind, renderer_json: typeof renderer === 'string' ? renderer : JSON.stringify(renderer ?? '') },
      { origin: 'database' },
    );
    return { type: { name: def.name, version: def.version, label: def.label, icon: def.icon, rendererKind: def.renderer_kind, schema: def.schema } };
  }

  function isBuiltin(name) {
    return Boolean(getBlockType(name)) && !queries.blockTypeRow(name);
  }

  /* ---------------- 沙箱 ---------------- */

  /**
   * 关掉 / 打开一篇文档的沙箱（FR-SANDBOX-08）。**只有 staff 能动。**
   *
   * 这是逃生开关：某篇文档里的小应用把浏览器卡死了，管理员不必删帖，
   * 关一次沙箱，这篇文档的所有 `app` 块就渲染成占位（连 iframe 都不建）。
   */
  function setSandboxDisabled({ id, viewer, disabled }) {
    const row = mustExist(id);
    if (!isStaff(viewer)) throw new HttpError(403, 'owner_only', '只有管理员能开关沙箱');
    const at = now();
    queries.setSandboxDisabled(row.id, disabled ? 1 : 0, at);
    return { id: row.id, sandboxDisabled: Boolean(disabled) };
  }

  /**
   * 沙箱里的代码向宿主申请一个能力（§6.2 / §6.3）。
   *
   * 白名单之外的**一律拒绝，但仍然记一条审计** —— 被拒的尝试恰恰是最该留下的记录。
   * 沙箱是不透明源，它自己读不到任何东西；「能干什么」完全由 `SANDBOX_CAPABILITIES`
   * 决定，而每一条都经过这里、都留痕。
   *
   * `payload` 是能力自己的参数（目前只有 `state` 用得上：`{op, scope, value}`）。
   * 它只被当作**数据**看待 —— 不认识就忽略，不做任何求值。
   */
  function requestCapability({ id, viewer, blockId = '', capability, payload = null }) {
    const row = mustSee(id, viewer);
    const at = now();
    const name = String(capability ?? '');
    const allowed = SANDBOX_CAPABILITIES.includes(name);
    queries.insertCapabilityLog({
      documentId: row.id,
      blockId: String(blockId ?? '').slice(0, 32),
      capability: name.slice(0, 64),
      userId: viewer?.id ?? null,
      allowed: allowed ? 1 : 0,
      now: at,
    });
    if (!allowed) {
      throw new HttpError(403, 'owner_only', `沙箱不能申请「${name}」这个能力`);
    }
    const block = findBlock(row, blockId);
    if (!block) throw badRequest('这个块不在这篇文档里，能力申请被拒绝');
    if (name === 'viewer') return { capability: name, value: viewerPayload(viewer) };
    if (name === 'doc-blocks') return { capability: name, value: blocksPayload(row) };
    if (name === 'state') return { capability: name, value: sandboxState({ row, blockId: block.block_id, viewer, payload, at }) };
    return {
      capability: name,
      value: {
        id: row.id,
        title: row.title,
        kind: row.kind,
        author: { username: row.username, displayName: row.display_name ?? row.username },
        updatedAt: Number(row.updated_at),
      },
    };
  }

  /** `viewer` 能力：不透明源里连「我登录了吗」都读不到，所以要把答案递进去。 */
  function viewerPayload(viewer) {
    if (!viewer) return { loggedIn: false, id: null, username: '', displayName: '', staff: false, author: false };
    return {
      loggedIn: true,
      id: viewer.id,
      username: viewer.username,
      displayName: viewer.display_name ?? viewer.username,
      staff: isStaff(viewer),
      author: false,
    };
  }

  /** `doc-blocks` 能力：正文里每一块的公开形状。代码因此能「按别的块算点东西」。 */
  function blocksPayload(row) {
    return {
      id: row.id,
      blocks: readBlocks(row.id).map((block) => ({
        id: block.block_id,
        type: block.type,
        props: block.props,
      })),
    };
  }

  /**
   * `state` 能力 —— 沙箱块的持久状态。
   *
   * 作用域两种：`user`（默认，按访客各存一份）与 `shared`（全站一份）。
   * 写要登录（不然任何人都能刷别人的共享状态）；读匿名也给，
   * 因为状态本来就是给页面上所有人看的展示内容。
   */
  function sandboxState({ row, blockId, viewer, payload, at }) {
    const op = String(payload?.op ?? 'get') === 'set' ? 'set' : 'get';
    const scope = APP_STATE_SCOPES.includes(payload?.scope) ? payload.scope : 'user';
    const owner = scope === 'shared' ? 0 : viewer?.id ?? 0;
    if (op === 'get') {
      const found = queries.appStateOf(row.id, blockId, scope, owner);
      if (!found) return { scope, value: null, updatedAt: null };
      let value = null;
      try {
        value = JSON.parse(String(found.value));
      } catch {
        value = null;
      }
      return { scope, value, updatedAt: Number(found.updated_at) };
    }
    if (!viewer) throw new HttpError(401, 'unauthenticated', '要保存状态得先登录');
    let text;
    try {
      text = JSON.stringify(payload?.value ?? null);
    } catch {
      throw badRequest('这个状态存不下来（不是能序列化的 JSON）');
    }
    if (text === undefined) text = 'null';
    if (text.length > MAX_APP_STATE) throw badRequest(`状态太大了（上限 ${MAX_APP_STATE} 个字符）`);
    queries.upsertAppState({ documentId: row.id, blockId, scope, userId: owner, value: text, now: at });
    return { scope, value: payload?.value ?? null, updatedAt: at };
  }

  /** 沙箱里每一次 `request` 都要落到真实块上 —— 拿不到块就直接拒。 */
  function findBlock(row, blockId) {
    const wanted = String(blockId ?? '');
    if (!wanted) return null;
    return readBlocks(row.id).find((block) => block.block_id === wanted) ?? null;
  }

  /** 块没了 / 块不再是沙箱块时，把它存过的状态一并清掉（不留孤儿行）。 */
  function reconcileAppState(documentId) {
    const alive = new Set(readBlocks(documentId).filter((block) => isSandboxType(block.type)).map((block) => block.block_id));
    for (const blockId of queries.appStateBlocks(documentId)) {
      if (!alive.has(blockId)) queries.deleteAppStatesOfBlock(documentId, blockId);
    }
  }

  /** 审计清单（管理后台 / 排障用）。 */
  function listCapabilityLogs({ id, viewer, limit = 50 } = {}) {
    const row = mustExist(id);
    if (!isStaff(viewer)) throw new HttpError(403, 'owner_only', '只有管理员能看审计记录');
    return {
      logs: queries.capabilityLogsOf(row.id, Math.min(Math.max(Number(limit) || 50, 1), 200)).map((entry) => ({
        blockId: entry.block_id,
        capability: entry.capability,
        userId: entry.user_id,
        allowed: Boolean(entry.allowed),
        createdAt: Number(entry.created_at),
      })),
    };
  }

  function listCustomBlockTypes() {
    return queries.customBlockTypes().map((row) => ({
      name: row.name,
      version: Number(row.version) || 1,
      label: row.label,
      icon: row.icon,
      rendererKind: row.renderer_kind,
      schema: safeJson(row.props_schema_json),
      createdBy: row.created_by,
      createdAt: Number(row.created_at),
    }));
  }

  /** 模板清单（`GET /api/docs/meta/templates`）。 */
  function listTemplates() {
    return templateList();
  }

  /**
   * 编辑器下拉框要用的 kind / scope 清单。
   *
   * 为什么必须由后端给：这两个枚举的真相在 `src/modules/doc/schema.js`，
   * 前端再抄一份「公开 / 仅关注我的人 / 仅团队 / 仅自己」，
   * 加一档的时候就会漏掉一处 —— 而漏掉的表现是"选了但它不生效"。
   */
  function listKinds() {
    return DOC_KINDS.map((value) => ({ value, label: KIND_LABELS[value] ?? value }));
  }

  function listScopes() {
    return DOC_SCOPES.map((value) => ({ value, label: SCOPE_LABELS[value] ?? value }));
  }

  /**
   * 注册表清单（`GET /api/docs/meta/block-types`）。
   *
   * 内置与自定义共用一个出口：前端只想知道"有哪些类型、各自要填什么"，
   * 不该为了画一个下拉框去区分来源。
   */
  function listBlockTypes() {
    const custom = new Set(queries.customBlockTypes().map((row) => row.name));
    return engineListBlockTypes().map((type) => ({
      name: type.name,
      version: type.version,
      label: type.label,
      icon: type.icon,
      editor: type.editor,
      schema: type.schema,
      builtin: !custom.has(type.name),
      rendererKind: type.renderer_kind === 'sandbox' ? 'sandbox' : 'declarative',
    }));
  }

  function safeJson(text) {
    try {
      const parsed = JSON.parse(String(text ?? '{}'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  return {
    listDocuments,
    getDocument,
    createDocument,
    updateDocument,
    deleteDocument,
    addBlock,
    updateBlock,
    deleteBlock,
    moveBlock,
    reorderBlocks,
    runOps,
    getMarkdown,
    putMarkdown,
    applyTemplate,
    exportDocument,
    importDocument,
    listRevisions,
    rollback,
    registerCustomBlockType,
    listCustomBlockTypes,
    listTemplates,
    listKinds,
    listScopes,
    listBlockTypes,
    setSandboxDisabled,
    requestCapability,
    listCapabilityLogs,
    importNote,
    getNoteDocument,
    getProfileDocument,
    getWikiPage,
    openWikiPage,
    wikiNav,
    setWikiMeta,
    getPollState,
    votePoll,
  };
}
