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
//      因为点赞 / 收藏两个核心接口只认 `posts` 那一行。
import { HttpError } from '../../core/http.js';
import { isStaff, postListExclude } from '../../core/guards.js';
import {
  DOC_KINDS,
  DOC_SCOPES,
  MAX_DOC_BLOCKS,
  MAX_DOC_BODY_BYTES,
  MAX_DOC_REVISIONS,
  MAX_DOC_TITLE,
  BLOCK_TYPE_PATTERN,
  BLOCK_ID_PATTERN,
  DERIVED_ID_PATTERN,
  DERIVED_SCOPES,
  MAX_DERIVED_BLOCKS,
  MAX_DERIVED_PROPS_BYTES,
  MAX_DERIVED_TOTAL_BYTES,
  MAX_APP_CODE,
  MAX_APP_STATE,
  APP_MODES,
  APP_STATE_SCOPES,
  SANDBOX_CAPABILITIES,
  MAX_SCRIPT_CODE,
  MAX_SCRIPT_TEMPLATES,
  MAX_SCRIPT_TEMPLATE_NAME,
  MAX_SCRIPT_TEMPLATE_DESC,
  MAX_DOC_TAGS,
  MAX_TAG_TEXT,
} from './schema.js';
import { createAnchor, syncAnchor, STATION_PAGE_HIDDEN } from './anchor.js';
import { blockFromRow } from './queries.js';
import { createVisibility, detectTeams, isPrivateDraft, visibilityConditions } from './visibility.js';
import {
  blocksToMarkdown,
  blocksToPlainText,
  coerceProps,
  getBlockType,
  ID_BEARING_TYPES,
  isSandboxType,
  listBlockTypes as engineListBlockTypes,
  markdownToBlocks,
  parseSourceBlocks,
  registerBlockType,
  renderBlocks,
  toSource,
} from './blocks/index.js';
import { applyDocOps, MAX_OPS } from './blocks/ops.js';
import { escapeHtml, plainInline } from './blocks/text.js';
import { ANNOUNCE_TEMPLATE, hasTemplate, STATION_TEMPLATE, templateBlocks, templateList, WIKI_TEMPLATE } from './templates.js';
import { checkProfile, isProfileCard, isProfileHostApp, profileBlockedMessage, profileHostHtml, profileSeedBlocks, PROFILE_CARD_APP, PROFILE_CARD_HTML, PROFILE_DATA_APPS, PROFILE_POSTS_APP, PROFILE_PINNED_APP, PROFILE_REPOSTS_APP, PROFILE_STATS_APP, PROFILE_TAGS_APP } from './profile-rules.js';
import { KIND_LABELS, REASON_LABELS, SCOPE_LABELS, shapeDoc, shapeRevision, shapeSettings } from './shape.js';

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

  /**
   * 标签：接受数组，也接受「逗号 / 空格 / 顿号 / # 分开」的一整串（编辑器里就是一个输入框）。
   *
   * 三条规矩：单个标签最长 MAX_TAG_TEXT；一篇最多 MAX_DOC_TAGS 个；重复的合并。
   * 比较重复用大小写不敏感（`CSS` 与 `css` 是同一个标签），但**保留作者写下的那个写法**。
   * 空数组是合法值 —— 「把这篇文章的标签清空」必须能表达。
   */
  function normalizeTags(value) {
    const raw = Array.isArray(value)
      ? value
      : String(value ?? '')
          .split(/[,，#、\s]+/)
          .filter(Boolean);
    const list = [];
    const seen = new Set();
    for (const item of raw) {
      const text = singleLineText(String(item ?? '')).replace(/^#+/, '');
      if (!text) continue;
      if (text.length > MAX_TAG_TEXT) throw badRequest(`标签「${text}」太长了，最多 ${MAX_TAG_TEXT} 个字`);
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      list.push(text);
    }
    if (list.length > MAX_DOC_TAGS) throw badRequest(`一篇最多 ${MAX_DOC_TAGS} 个标签`);
    return list;
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

  /**
   * 「要动**正文**了」的入口：`mustEdit` + 把草稿行的时间戳推一下。
   *
   * **它不负责进草稿箱**。「保存 / 自动保存只进草稿箱」这件事只对**作者在编辑器里**成立；
   * 而 API 层面的写正文（`PUT …/markdown`、块增删改、`ops`、套模板、回滚）在草稿箱出现之前
   * 就是「立刻生效」，第 1-12 章的端到端断言全建在那条行为上 —— 所以这里只做一件事：
   * 这篇**已经在草稿箱里**就把 `updated_at` 推一下，没有草稿行就什么都不做，写下去就是线上内容。
   *
   * 进草稿箱是**显式**动作，只有一个入口：`enterDraft`（`POST /api/docs/:id/draft`，编辑器
   * 在第一次写正文之前跑一次）。
   */
  function mustEditBody(id, viewer) {
    const row = mustEdit(id, viewer);
    if (queries.draftOf(row.id)) queries.touchDraft({ documentId: row.id, now: now() });
    return row;
  }

  /**
   * 显式进草稿箱（`POST /api/docs/:id/draft`）。
   *
   * 编辑器在**第一次写正文之前**调一次。跑完这篇就变成「草稿行 + 线上快照」的形态：
   * 之后的保存只动工作副本，读者看到的还是留底的那一份，直到点「发布」。已经在草稿箱里的
   * 再调一次是无害的（`beginDraft` 只推时间戳）。
   */
  function enterDraft({ id, viewer } = {}) {
    const row = mustEdit(id, viewer);
    beginDraft(row.id, now());
    return present(mustExist(row.id), viewer);
  }

  /**
   * 进草稿箱。
   *
   * 只有一条规则：`doc_drafts` 里**已经有行**就什么都不做（线上版早就留过了）。
   * 没有行 = 这篇目前是「线上内容就是 `document_blocks`」（老库、刚发布完、或者建的时候
   * 就没走草稿箱），所以要**先把此刻的正文拷进 `doc_published_blocks` 留底**，再允许改工作副本。
   *
   * 顺序不能反：必须在写之前跑。放在写之后（比如挂在 `snapshot` 上）就把作者刚改完的
   * 那一版当成线上版了 —— 等于第一次改动会直接发布出去。
   */
  function beginDraft(documentId, at) {
    if (queries.draftOf(documentId)) {
      queries.touchDraft({ documentId, now: at });
      return;
    }
    queries.copyPublishedBlocks({ documentId, now: at });
    queries.enterDraftBox({ documentId, published: 1, now: at });
  }

  function readBlocks(documentId) {
    return queries.blocksOf(documentId).map(blockFromRow);
  }

  /**
   * 读者该看哪一份正文。
   *
   * - 有草稿行 + **已经发布过** + 看客改不动它 → 读线上快照（`doc_published_blocks`）；
   * - 其余（包括没草稿行的老库、以及作者/staff 自己）→ 读工作副本 `document_blocks`。
   *
   * 「从没发布过的草稿」到不了这里：`canView` 已经不让人读它了。
   */
  function readBlocksFor(docRow, viewer) {
    if (docRow.draft_document_id && docRow.draft_published && !canEdit(docRow, viewer)) {
      return queries.publishedBlocksOf(docRow.id).map(blockFromRow);
    }
    return readBlocks(docRow.id);
  }

  /** `doc_settings` 的原始行（没有就是 null —— 读路径绝不顺手造一行）。 */
  function readSettings(documentId) {
    return queries.settingsOf(documentId) ?? null;
  }

  /**
   * 编辑器要用的源码：`doc_settings.source_text`（作者最后一次逐字节输入）优先；
   * 老文档还没存过就现场用 `toSource(blocks)` 生成一份 —— **不落库**，
   * 作者第一次保存时它才成为基准。
   */
  function sourceOf(settingsRow, blocks) {
    const stored = settingsRow?.source_text;
    if (typeof stored === 'string' && stored !== '') return stored;
    return toSource(blocks);
  }

  /* ---------------- 派生层：脚本产出的块 ---------------- */

  /**
   * 派生行 → 渲染层认识的块形状。
   *
   * 它们**不是**正文：不进 `document_blocks`、不产生修订、不算作者编辑。
   * 渲染时接在真块之后（`present` 里拼），打上 `derived: true` 让前端标出来。
   */
  function derivedRows(documentId, viewer) {
    return queries.derivedBlocks(documentId, viewer?.id ?? 0).map((row) => {
      let props = {};
      try {
        const parsed = JSON.parse(String(row.props_json ?? '{}'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) props = parsed;
      } catch {
        props = {};
      }
      return {
        block_id: String(row.block_id),
        type: String(row.type),
        version: 1,
        props,
        derived: true,
        scope: String(row.scope),
      };
    });
  }

  /**
   * 「采纳为真块」（§4.5）：把一条脚本产出**固化进正文**。
   *
   * 这就是一次普通的文档写：新块拿到自己的 `b\d+`、接到末尾、写一条 `adopt` 修订、
   * 产出行删掉。此后它与别的块没有区别 —— 脚本可以再改它，但那是改正文了。
   */
  function adoptDerived({ id, viewer, blockId = '', scope = 'user' } = {}) {
    const row = mustEditBody(id, viewer);
    const at = now();
    const scopeName = DERIVED_SCOPES.includes(scope) ? scope : 'user';
    const owner = scopeName === 'shared' ? 0 : viewer?.id ?? 0;
    const found = queries.derivedBlockRow(row.id, scopeName, owner, String(blockId ?? '').slice(0, 32));
    if (!found) throw new HttpError(404, 'not_found', '找不到这个脚本产出块');
    const typeDef = getBlockType(String(found.type));
    if (!typeDef) throw badRequest(`这个产出块的类型已经不存在了：${found.type}`);
    let props = {};
    try {
      const parsed = JSON.parse(String(found.props_json ?? '{}'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) props = parsed;
    } catch {
      props = {};
    }
    const shaped = serializeBlock({ type: typeDef.name, props });
    const newBlockId = `b${queries.nextBlockNumber(row.id)}`;
    queries.insertBlockRow({
      documentId: row.id,
      blockId: newBlockId,
      type: shaped.type,
      version: shaped.version,
      position: queries.maxPosition(row.id) + 1,
      propsJson: shaped.propsJson,
      now: at,
    });
    queries.deleteDerivedBlock(row.id, scopeName, owner, String(found.block_id));
    snapshot(row.id, 'adopt', viewer?.id ?? null, at);
    // 源头也得跟上：采纳进来的块现在在正文里，编辑器要看得见它。
    const nextBlocks = readBlocks(row.id);
    queries.setSourceText({ documentId: row.id, sourceText: toSource(nextBlocks), now: at });
    return { ...present(row, viewer), adopted: { blockId: newBlockId, from: String(found.block_id) } };
  }

  /**
   * `blocks.derived` 能力（§4.4）：脚本**画块**的那条路。
   *
   * 三道闸：① 作者得先打开「脚本可以改块」（默认关）；② 得登录；
   * ③ 类型必须注册过 —— 脚本不能凭一个能力把任意 HTML 塞进别人的页面，
   * 它只能产出「已知类型的块」，渲染仍然走同一条管线（照样转义）。
   */
  function derivedPayload({ row, viewer, payload, at }) {
    const scope = DERIVED_SCOPES.includes(payload?.scope) ? payload.scope : 'user';
    const owner = scope === 'shared' ? 0 : viewer?.id ?? 0;
    const op = ['list', 'put', 'delete'].includes(String(payload?.op)) ? String(payload.op) : 'list';
    const settings = readSettings(row.id);
    const canWrite = Number(settings?.allow_script_write) === 1;

    if (op === 'list') {
      return { scope, canWrite, blocks: derivedRows(row.id, viewer).map((block) => ({ id: block.block_id, type: block.type, props: block.props, scope: block.scope })) };
    }

    if (!canWrite) {
      throw new HttpError(403, 'owner_only', '这篇帖子没有打开「脚本可以改块」这个开关');
    }
    if (!viewer) throw new HttpError(401, 'unauthenticated', '脚本要写块，先请登录');

    const blockId = String(payload?.blockId ?? '').slice(0, 32);
    if (!DERIVED_ID_PATTERN.test(blockId)) {
      throw badRequest('脚本产出块的 id 只能是字母、数字、下划线和短横线（1–32 个字符）');
    }
    if (op === 'delete') {
      queries.deleteDerivedBlock(row.id, scope, owner, blockId);
      return { scope, blockId, deleted: true };
    }

    const typeDef = getBlockType(String(payload?.type ?? ''));
    if (!typeDef) throw badRequest(`不认识的块类型：${payload?.type}`);
    const props = coerceProps(typeDef, payload?.props && typeof payload.props === 'object' ? payload.props : {});
    const propsJson = JSON.stringify(props);
    if (propsJson.length > MAX_DERIVED_PROPS_BYTES) {
      throw badRequest(`脚本产出块最多 ${Math.round(MAX_DERIVED_PROPS_BYTES / 1024)}KB，这个超了`);
    }
    const existing = queries.derivedBlockRow(row.id, scope, owner, blockId);
    if (!existing && queries.countDerivedBlocks(row.id, scope, owner) >= MAX_DERIVED_BLOCKS) {
      throw badRequest(`一篇帖子最多 ${MAX_DERIVED_BLOCKS} 个脚本产出块`);
    }
    const before = existing ? String(existing.props_json ?? '').length : 0;
    if (queries.derivedBytesOfDocument(row.id) - before + propsJson.length > MAX_DERIVED_TOTAL_BYTES) {
      throw badRequest(`这篇帖子的脚本产出加起来太大了（上限 ${Math.round(MAX_DERIVED_TOTAL_BYTES / 1024)}KB）`);
    }
    const position = existing ? Number(existing.position) : queries.maxDerivedPosition(row.id, scope, owner) + 1;
    queries.upsertDerivedBlock({
      documentId: row.id,
      scope,
      userId: owner,
      blockId,
      type: typeDef.name,
      propsJson,
      position,
      now: at,
    });
    return { scope, blockId, type: typeDef.name, props };
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

  /**
   * 最长公共子序列：`pick[j]` 是 `b[j]` 配上的 `a` 下标（没配上为 -1）。
   * 用来把「没写 id 的新块」和「旧行」对齐 —— 键（类型 + 规范化 props）相同才算同一个块。
   */
  function alignBlocks(a, b) {
    const n = a.length;
    const m = b.length;
    const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        table[i][j] = a[i] === b[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }
    const pick = new Array(m).fill(-1);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        pick[j] = i;
        i += 1;
        j += 1;
      } else if (table[i + 1][j] >= table[i][j + 1]) {
        i += 1;
      } else {
        j += 1;
      }
    }
    return pick;
  }

  /** 块的「身份键」：类型 + 规范化 props。改过内容的块对不上，就当作新块。 */
  function blockKey(type, propsJson) {
    return `${type}\u0000${propsJson}`;
  }

  /**
   * 写块序列 —— **按 id 对齐**，不再「先全删再全插」。
   *
   * 老实现每次保存都把整篇块删掉重插，而块 id 是按位置发的，于是在开头插一段
   * 就会让后面所有 id 后移：投给 poll 的票、沙箱状态、`bind` 引用全被当孤儿清掉（丢数据）。
   * 现在三步：
   *   1. 带显式 id 的块（源码里写了 `{#b3}` / `<!-- b3 -->`）就用那个 id，身份不动；
   *   2. 没写 id 的块与「旧行里没被占走的那些」做 LCS 对齐，键相同就留住旧 id；
   *   3. 只插真正新增的、删真正消失的、更新真正变了的。
   * 即便因此丢了一个 id，也只可能丢在纯文字块上：有副数据（票 / 状态 / bind 目标）的块
   * 在源码里必然带显式 id（见 `blocks/markdown.js` 的 `sourceIdsToMark`）。
   */
  function writeBlocks(documentId, blocks, at) {
    assertBudget(blocks.length);
    const shapedList = blocks.map((block) => serializeBlock(block));
    const oldRows = queries.blocksOf(documentId);
    const oldById = new Map(oldRows.map((row) => [String(row.block_id), row]));

    // 显式 id 先占位：位置对齐不许碰它们。
    const taken = new Set();
    const explicitIds = shapedList.map((shaped) => {
      const id = String(shaped.block_id ?? '');
      if (id === '' || !BLOCK_ID_PATTERN.test(id) || taken.has(id)) return '';
      taken.add(id);
      return id;
    });

    const freeOld = oldRows.filter((row) => !taken.has(String(row.block_id)));
    const freeNew = [];
    shapedList.forEach((shaped, index) => {
      if (explicitIds[index] === '') freeNew.push(index);
    });
    const pick = alignBlocks(
      freeOld.map((row) => blockKey(row.type, row.props_json)),
      freeNew.map((index) => blockKey(shapedList[index].type, shapedList[index].propsJson)),
    );
    const pairedWith = new Map();
    freeNew.forEach((index, position) => {
      if (pick[position] >= 0) pairedWith.set(index, freeOld[pick[position]]);
    });

    // LCS 没配上的按顺序两两补齐 —— 但**只在两边都不是「带副数据的块」时**。
    // 改一个标题的错字不该换掉它的块 id（老实现会把整篇 id 平移，这里保住它）；
    // 而一个 poll 的 id 绝不能交给别的块（那等于让票"继承"过去）。
    const usedOld = new Set([...pairedWith.values()].map((row) => String(row.block_id)));
    const leftovers = freeOld.filter((row) => !usedOld.has(String(row.block_id)));
    let cursor = 0;
    for (const index of freeNew) {
      if (pairedWith.has(index)) continue;
      const shaped = shapedList[index];
      while (cursor < leftovers.length) {
        const candidate = leftovers[cursor];
        cursor += 1;
        if (ID_BEARING_TYPES.has(String(candidate.type)) || ID_BEARING_TYPES.has(shaped.type)) continue;
        pairedWith.set(index, candidate);
        break;
      }
    }

    let nextNumber = queries.nextBlockNumber(documentId);
    const keep = new Set();
    const plan = shapedList.map((shaped, index) => {
      let blockId = explicitIds[index];
      if (blockId === '') {
        const old = pairedWith.get(index) ?? null;
        if (old) {
          blockId = String(old.block_id);
        } else {
          while (taken.has(`b${nextNumber}`)) nextNumber += 1;
          blockId = `b${nextNumber}`;
          nextNumber += 1;
        }
      }
      taken.add(blockId);
      keep.add(blockId);
      return { shaped, blockId, old: oldById.get(blockId) ?? null };
    });

    plan.forEach(({ shaped, blockId, old }, index) => {
      const position = index + 1;
      if (!old) {
        queries.insertBlockRow({
          documentId,
          blockId,
          type: shaped.type,
          version: shaped.version,
          position,
          propsJson: shaped.propsJson,
          now: at,
        });
        return;
      }
      if (old.type !== shaped.type
        || Number(old.type_version) !== shaped.version
        || String(old.props_json) !== shaped.propsJson) {
        queries.updateBlockRow({
          documentId,
          blockId,
          type: shaped.type,
          version: shaped.version,
          propsJson: shaped.propsJson,
          now: at,
        });
      }
      if (Number(old.position) !== position) {
        queries.setBlockPosition({ documentId, blockId, position, now: at });
      }
    });

    for (const row of oldRows) {
      const blockId = String(row.block_id);
      if (!keep.has(blockId)) queries.deleteBlockRow(documentId, blockId);
    }

    // 剩下的孤儿数据才真的没有主人：投给已被删掉的投票块的票、已被删块的状态。
    reconcilePollVotes(documentId);
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
   *
   * 需求 2 追加了三个**个人主页专用**的来源（`profile-posts` / `profile-pinned` /
   * `profile-tags`）：主页上的「发表过的积木贴 / 置顶推荐 / 我的标签」也是块，
   * 但块里存的是「我都要哪些」，条数是渲染时现查的 —— 这样主页上看到的条数
   * 天然等于点进去的条数（需求 3 的统一口径）。
   */
  function materializeSources(blocks, documentId) {
    const out = blocks.map((block) => {
      const source = block.props?.source;
      if (!source || typeof source !== 'object') return block;
      if (source.kind === 'revisions') {
        const limit = Math.min(Math.max(Number(source.limit) || 10, 1), 50);
        const rows = queries.listRevisions(documentId, limit);
        const text = rows.map((row) => `- r${row.revision} · ${stamp(row.created_at)} · ${row.display_name || row.username || '—'} · ${REASON_LABELS[row.reason] ?? row.reason}`).join('\n');
        return { ...block, props: { ...block.props, text } };
      }
      if (!String(source.kind ?? '').startsWith('profile-')) return block;
      const row = db.prepare('SELECT user_id FROM documents WHERE id = ? AND deleted = 0').get(documentId);
      if (!row) return { ...block, props: { ...block.props, text: '' } };
      const limit = Math.min(Math.max(Number(source.limit) || 20, 1), 50);
      return { ...block, props: { ...block.props, text: profileSourceText(source.kind, Number(row.user_id), limit) } };
    });
    return out;
  }

  /**
   * 个人主页的来源块渲染成什么（只出 Markdown 列表/段落文字，交给 `list` 块自己的渲染）。
   *
   * 口径与个人主页列表**完全同源**：`deleted = 0` + `hidden = 0` + 登记在案的排除条件
   * （wiki 页、profile 文档的影子行），所以「块里数出来的条数」= 「主页列表里的条数」。
   */
  function profileSourceText(kind, userId, limit) {
    const parts = ['p.deleted = 0', 'p.hidden = 0', 'p.user_id = ?'];
    const params = [userId];
    const excluded = postListExclude();
    if (excluded) {
      if (!excluded.params.length) parts.push(excluded.clause);
      else throw new Error('帖子列出的排除条件不能带参数：来源块会把它拼进预编译语句');
    }
    if (kind === 'profile-tags') {
      const rows = db
        .prepare(
          `SELECT t.tag AS tag, COUNT(*) AS count FROM posts p JOIN doc_tags t ON t.document_id = p.id
           WHERE ${parts.join(' AND ')} GROUP BY t.tag COLLATE NOCASE ORDER BY count DESC, t.tag COLLATE NOCASE ASC LIMIT ${limit}`,
        )
        .all(...params);
      return rows.map((tag) => `- 🏷 ${tag.tag}（${tag.count}）`).join('\n');
    }
    if (kind === 'profile-pinned') parts.push('p.profile_pinned = 1');
    const pinnedFirst = kind === 'profile-pinned' ? '' : 'p.profile_pinned DESC, ';
    const rows = db
      .prepare(
        `SELECT p.id, p.title, p.updated_at, p.profile_pinned FROM posts p
         WHERE ${parts.join(' AND ')} ORDER BY ${pinnedFirst}p.updated_at DESC, p.id DESC LIMIT ${limit}`,
      )
      .all(...params);
    return rows.map((post) => `- [${plainInline(String(post.title ?? '') || '（无标题）')}](#/post/${post.id})${post.profile_pinned ? ' 📌' : ''}`).join('\n');
  }

  /**
   * 需求 2 的「不可删除 / 不可移动」：个人主页的**名片块**必须在第一位。
   *
   * 为什么在**读**的时候补而不是只在写的时候拦：老用户早就有主页文档了
   * （本机上站长那份 id=15 是上一轮建的，只有普通块），一次「缺失就补」比
   * 逼所有人手动加一块体验好得多，也不会把老主页判成非法。
   * 幂等：块还在就什么都不做。
   */
  function ensureProfileCard(row, viewer) {
    // 返回值只有两种：`undefined`（什么都没做），或**名片那一块的新形状**。
    // 不能回整份块序列 —— 调用方还要用 `readBlocksFor()` 拿到「读者该看哪一版」
    // （有未发布草稿时，读者只能看发布出去的那一份），回整份会把草稿感知短路掉。
    if (String(row.kind ?? '') !== 'profile') return undefined;
    if (!canEdit(row, viewer)) return undefined;
    // `readBlocks()` 已经过了一遍 `blockFromRow()`（props 就挂在 `block.props` 上），
    // 这里**不能**再套一次 —— 第二次解析时 `props_json` 早就被换成 `props` 了，
    // 解析出来是空对象，`isProfileCard()` 永远为假，名片就永远补不上（踩过的坑）。
    const blocks = readBlocks(row.id);
    const existing = blocks.find((item) => isProfileCard(item));
    // 已经有一张名片的，只做一件事：把它的内容对齐成**宿主占位**。
    // 上一轮的种子把名片写成一整段沙箱脚本（自己画头像和昵称），那一份渲染出来既没有
    // 关注 / 私信 / 拉黑，也没法做到「不允许编辑」。对齐是**单调的**：它要么本来就是占位
    //（什么都不做），要么是我们自己上一轮写的脚本（换成占位）。用户自己写进名片块的代码
    // 不会被覆盖 —— 那条分支见 `materializeProfileCard`。
    if (existing) {
      const current = String(existing.props?.code ?? '');
      if (current.trim() !== PROFILE_CARD_HTML && current.includes('data-profile-card')) {
        const at = now();
        // 名字也**对齐**成识别标记：老名片是上一轮的种子写出来的（app 名就是这一串），
        // 但万一有人改过它，就以内容为准把它纠回来 —— 否则「只能有一张名片」的判定会漏。
        const props = { ...existing.props, app: PROFILE_CARD_APP, code: PROFILE_CARD_HTML };
        const typeDef = getBlockType(existing.type);
        if (typeDef) {
          const shaped = serializeBlock({ block_id: existing.block_id, type: existing.type, version: typeDef.version, props });
          queries.updateBlockRow({
            documentId: row.id,
            blockId: existing.block_id,
            type: shaped.type,
            version: shaped.version,
            propsJson: shaped.propsJson,
            now: at,
          });
          snapshot(row.id, 'edit', viewer.id, at);
          syncDocumentAnchor(mustExist(row.id), at);
          // 就地返回**对齐后**的那一块：`present()` 随后会拿它替换掉同名块，
          // 不然这次读到的还是对齐前那份旧代码（会渲染成一大块白框）。
          return blockFromRow({ ...existing, props_json: shaped.propsJson });
        }
      }
      return undefined;
    }
    if (blocks.length >= MAX_DOC_BLOCKS) return undefined;
    const block = profileSeedBlocks().find(isProfileCard);
    if (!block) return undefined;
    const typeDef = getBlockType(block.type);
    if (!typeDef) return undefined;
    const at = now();
    const blockId = `b${queries.nextBlockNumber(row.id)}`;
    const place = blocks.length ? Math.min(...blocks.map((item) => Number(item.position) || 0)) - 1 : 0;
    const shaped = serializeBlock({ block_id: blockId, type: block.type, version: typeDef.version, props: block.props });
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
    // 补出来的名片块必须是**第一块**：它的 position 比谁都小。
    // 只回这一块的新形状（`undefined` 之外的唯一返回值），由 `present()` 合进正文。
    return blockFromRow({ document_id: row.id, block_id: blockId, type: shaped.type, type_version: shaped.version, position: place, props_json: shaped.propsJson });
  }

  /**
   * 需求 2 的「不允许删除、编辑、移动位置」：名片块的内容**由宿主渲染**。
   *
   * 块里存的是占位 `PROFILE_CARD_HTML`，渲染前把它换成真正的卡片 —— 头像、昵称、
   * 角色、加入时间、个性签名，以及关注 / 私信 / 拉黑三个按钮。为什么不让沙箱脚本自己画：
   * 这三个按钮的动作与**看客相对**的状态（我关注他了吗 / 我拉黑他了吗 / 今天私信还剩几条）
   * 早就由页面实现了，沙箱里重写一遍既拿不到这些状态，还要把关注、拉黑逻辑抄第二遍。
   *
   * 老主页（上一轮建的那份只有普通块的文档）走同一条路：`ensureProfileCard` 补块时写的就是
   * 这个占位，所以「主页上那张卡片」在翻新前后长得一模一样，用户不需要手动迁移。
   */
  function profileCardHtml(docRow, viewer) {
    const user = db
      .prepare('SELECT id, username, display_name, bio, avatar, role, created_at FROM users WHERE id = ?')
      .get(Number(docRow.user_id));
    if (!user) return PROFILE_CARD_HTML;
    const me = viewer ? Number(viewer.id) : 0;
    const isMe = me !== 0 && me === Number(user.id);
    const display = String(user.display_name ?? user.username ?? '');
    const first = display.trim().slice(0, 1).toUpperCase() || '?';
    let hash = 0;
    for (const char of display || '?') hash = (hash * 31 + char.codePointAt(0)) % 360;
    const avatar = String(user.avatar ?? '').trim();
    let avatarHtml = `<span class="avatar avatar-lg" style="--hue:${hash}" aria-hidden="true">${escapeHtml(first)}</span>`;
    if (/^emoji:[^:]+:\d+$/.test(avatar)) {
      const [, emoji, hue] = avatar.split(':');
      avatarHtml = `<span class="avatar avatar-emoji avatar-lg" style="--hue:${Number(hue) || 210}" aria-hidden="true">${escapeHtml(emoji)}</span>`;
    } else if (avatar.startsWith('file:/avatars/')) {
      avatarHtml = `<span class="avatar avatar-img avatar-lg" aria-hidden="true"><img src="${escapeHtml(avatar.slice(5))}" alt="" loading="lazy" /></span>`;
    }
    const roleTag =
      user.role === 'owner'
        ? '<span class="tag tag-owner">👑 站长</span>'
        : user.role === 'admin'
          ? '<span class="tag tag-admin">🛡️ 管理员</span>'
          : '';
    let actions = '';
    if (isMe) {
      actions =
        '<a class="btn btn-sm" href="#/settings">⚙️ 账号设置</a>' +
        '<a class="btn btn-sm" href="#/bookmarks">⭐ 我的收藏</a>' +
        '<a class="btn btn-sm btn-primary" href="#/docs">🧩 去积木广场写作</a>' +
        // 「翻新我的主页」就长在名片块上：这一块是主页的第一块，入口放在这里最顺手
        // （旧主页的模板里也有一个同样的按钮，那份在没有积木主页时才出现）。
        `<a class="btn btn-sm" href="#/doc/${Number(docRow.id)}/edit?mode=blocks" title="个人主页是一篇积木文档：块可以自由增删改，只有这一块锁着">✏️ 翻新我的主页</a>`;
    } else {
      // 未登录的看客与登录的看客看到的是**同一排按钮**（关注 / 私信 / 拉黑），
      // 与旧主页那张硬编码卡片完全一致 —— 需求 5「对目前的用户个人主页做最小修改」。
      // 没登录时三个状态一律按「未关注 / 未拉黑」算，点下去由事件总线引导登录。
      const following = me !== 0 ? db.prepare('SELECT 1 AS hit FROM follows WHERE follower_id = ? AND followee_id = ?').get(me, Number(user.id)) : null;
      const blocked = me !== 0 ? db.prepare('SELECT 1 AS hit FROM blocks WHERE blocker_id = ? AND blocked_id = ?').get(me, Number(user.id)) : null;
      const mutual = me !== 0 && Boolean(following) && Boolean(db.prepare('SELECT 1 AS hit FROM follows WHERE follower_id = ? AND followee_id = ?').get(Number(user.id), me));
      // 类名先算好再拼进模板：`class="…${…'…'…}…"` 这种写法会让 `scripts/check-ui-contract.mjs`
      // 的「服务端产出的类名也都有 CSS」扫描器把引号当成类名的一部分（扫出 `btn-danger'` 这类垃圾）。
      const followCls = following ? 'btn' : 'btn btn-primary';
      const dmCls = mutual ? 'btn btn-sm btn-primary' : 'btn btn-sm';
      const blockCls = blocked ? 'btn btn-sm btn-danger' : 'btn btn-sm';
      actions =
        `<button class="${followCls}" data-action="follow" data-user="${Number(user.id)}" data-name="${escapeHtml(display)}" ${blocked ? 'disabled' : ''}>${following ? '✓ 已关注' : '＋ 关注'}</button>` +
        `<a class="${dmCls}" href="#/messages/${encodeURIComponent(String(user.username))}">✉️ 私信</a>` +
        `<button class="${blockCls}" data-action="block-user" data-id="${Number(user.id)}" data-blocked="${blocked ? '1' : '0'}" data-name="${escapeHtml(display)}">${blocked ? '🚫 解除拉黑' : '🚫 拉黑'}</button>`;
    }
    return [
      '<div class="profile-head" data-profile-card>',
      `  ${avatarHtml}`,
      '  <div class="profile-info">',
      `    <h1 style="font-size:21px">${escapeHtml(display)} ${roleTag}</h1>`,
      `    <div class="page-sub">@${escapeHtml(String(user.username))} · 加入于 ${timeAgoText(Number(user.created_at ?? 0))}</div>`,
      user.bio ? `    <p class="profile-bio">${escapeHtml(String(user.bio))}</p>` : '    <p class="profile-bio hint">这位用户还没有写个性签名</p>',
      '  </div>',
      `  <div class="profile-actions">${actions}</div>`,
      '</div>',
    ].join('\n');
  }

  /**
   * 渲染**之前**把名片块的占位换成真正的卡片（只换这一个块的 code，其余块一个字节都不动）。
   *
   * 关键：**存进库的、以及交给编辑器的 `blocks` 永远是占位那一份**。
   * 只有 `renderBlocks()` 拿到的这一份才带真卡片。这样做有两个理由：
   *   1. 名片块「不允许编辑」才立得住 —— 编辑器里若看到真卡片，用户一保存就把这段
   *      宿主 HTML 写回块里，`updateBlock` 的名片锁会直接 400，好好的保存被卡住；
   *   2. 卡片里的「我关注他了吗 / 我拉黑他了吗」是**跟着看客变的**，绝不能落库。
   */
  function materializeProfileCard(blocks, docRow, viewer) {
    if (String(docRow.kind ?? '') !== 'profile') return blocks;
    let index = -1;
    for (let i = 0; i < blocks.length; i += 1) {
      if (isProfileCard(blocks[i])) { index = i; break; }
    }
    if (index < 0) return blocks;
    const card = blocks[index];
    const code = String(card?.props?.code ?? '');
    // 只认占位那一份：用户（或旧版本）写进别的代码时原样保留，不偷偷覆盖人家的东西。
    if (code.trim() !== PROFILE_CARD_HTML) return blocks;
    const next = blocks.slice();
    next[index] = { ...card, props: { ...card.props, code: profileCardHtml(docRow, viewer) } };
    return next;
  }

  /**
   * 需求 1/2 的第二件事：**其余五块（统计 / 标签 / 置顶 / 积木贴 / 动态）也由宿主渲染**。
   *
   * 为什么不能让它们在沙箱里自己画：改造前的个人主页用的是站点自己的 UI
   *（`.stat-grid` 统计格、`.card` 卡片、`.post-compact` 列表 —— 见 `public/views/user.js`
   * 与 `public/core/widgets.js`）。沙箱是一个 `srcdoc` iframe，**拿不到站点 CSS**，
   * 于是同一个块在玻璃房里只能是一块白框 + 一串朴素蓝链。把这几块挪到宿主渲染，
   * 主页在块化之后长得和改造前一样，差别只是「东西变成了块」。
   *
   * 口径与 `Sandbox.profile()` 完全同源（同一批查询），所以块里看到的条数
   * 永远等于主页列表里的条数（需求 3 的统一口径在主页上也成立）。
   */
  function materializeProfileBlocks(blocks, docRow, viewer) {
    if (String(docRow.kind ?? '') !== 'profile') return blocks;
    const userId = Number(docRow.user_id);
    let stats = null;
    const statsOf = () => {
      if (!stats) stats = profileStatsOf(userId, viewer);
      return stats;
    };
    return blocks.map((block) => {
      const app = String(block.props?.app ?? '');
      if (!isProfileHostApp(app)) return block;
      const code = String(block.props?.code ?? '');
      // 占位没被改过才接管；用户自己写的代码原样进沙箱（块是自由的）。
      if (code.trim() !== profileHostHtml(app)) return block;
      const html = app === PROFILE_CARD_APP
        ? profileCardHtml(docRow, viewer)
        : profileBlockHtml(app, statsOf(), docRow);
      if (html === null) return block;
      return { ...block, props: { ...block.props, code: html } };
    });
  }

  /**
   * 五块主食（除了名片）画成什么。类名全部取自改造前的个人主页，
   * 所以不需要任何新样式 —— 有样式的那几个（`.card` / `.card-head` / `.card-title` /
   * `.stat-grid` / `.chip-list` / `.chip` / `.post-compact` / `.compact-row`）本来就在。
   */
  function profileBlockHtml(app, stats, docRow) {
    if (!stats) return '';
    if (app === PROFILE_STATS_APP) {
      const cell = (label, value) => `<div class="stat"><div class="stat-value">${Math.max(0, Number(value) || 0)}</div><div class="stat-label">${label}</div></div>`;
      return [
        '<div class="stat-grid stat-grid-wide">',
        cell('文章', stats.postCount),
        cell('回复', stats.replyCount),
        cell('获赞', stats.likeCount),
        cell('获踩', stats.dislikeCount),
        cell('关注者', stats.followerCount),
        cell('关注中', stats.followingCount),
        '</div>',
      ].join('');
    }
    if (app === PROFILE_TAGS_APP) {
      const chips = stats.tags
        .map(
          (tag) =>
            `<span class="chip"><a class="chip-label" href="#/u/${encodeURIComponent(stats.username)}?tag=${encodeURIComponent(tag.name)}">🏷 ${escapeHtml(tag.name)} <span class="chip-count">${Number(tag.postCount) || 0}</span></a></span>`,
        )
        .join('');
      return profileCardSection('🏷 我的标签', stats.tags.length, `<div class="chip-list">${chips}</div>`, '还没有贴过标签：在积木编辑器里给一篇积木贴个标签，这里就会多出一项。');
    }
    if (app === PROFILE_PINNED_APP) {
      const rows = profileCompactRows(stats.posts.filter((post) => post.pinned), true);
      return profileCardSection('📌 积木贴置顶推荐', rows.count, rows.html, '还没有置顶推荐：在下面每一篇上点「📌 置顶」就会出现在这里。');
    }
    if (app === PROFILE_POSTS_APP) {
      const rows = profileCompactRows(stats.posts, false);
      return profileCardSection('🧩 发表过的积木贴', rows.count, rows.html, '还没有发过积木贴：去积木广场写一篇吧。');
    }
    if (app === PROFILE_REPOSTS_APP) {
      const rows = profileCompactRows(stats.reposts, false);
      return profileCardSection('💬 发表过的动态', rows.count, rows.html, '还没有转发过动态。');
    }
    return null;
  }

  /** 一张卡片（改造前主页那种 `.card` + `.card-head` + 列表）。 */
  function profileCardSection(title, count, body, empty) {
    const inner = count > 0 ? body : `<div class="hint">${empty}</div>`;
    return `<section class="card"><div class="card-head"><span class="card-title">${title}（${Math.max(0, Number(count) || 0)}）</span></div>${inner}</section>`;
  }

  /** 改造前主页的「紧凑」排法（`.post-compact` / `.compact-row`）。 */
  function profileCompactRows(items, pinned) {
    const list = Array.isArray(items) ? items : [];
    const rows = list
      .map((post) => {
        // 类名先算成变量再拼进模板：在 class 属性里直接写三元表达式时，那个字符串里的
        // 引号会被契约测试的静态扫描器当成类名的一部分（见 `scripts/check-ui-contract.mjs`）。
        const isPinned = pinned || post.pinned;
        const rowCls = isPinned ? 'compact-row is-pinned' : 'compact-row';
        return (
          `<div class="${rowCls}">` +
          `<a class="compact-title" href="${escapeHtml(post.url ?? `#/post/${post.id}`)}">${isPinned ? '📌 ' : ''}${escapeHtml(post.title || '（无标题）')}</a>` +
          `<span class="compact-meta">${timeAgoText(post.updatedAt)}</span></div>`
        );
      })
      .join('');
    return { count: list.length, html: `<div class="post-compact">${rows}</div>` };
  }

  /** 短时间的「加入于」文案（服务端这一份不引前端模块，8 个档位够主页用）。 */
  function timeAgoText(at) {
    if (!at) return '很久以前';
    const days = Math.floor((Date.now() - at) / 86400000);
    if (days <= 0) return '今天';
    if (days < 30) return `${days} 天前`;
    if (days < 365) return `${Math.floor(days / 30)} 个月前`;
    return `${Math.floor(days / 365)} 年前`;
  }

  /** 保存前的判定（需求 2）：不合法就 400，一个字节都不写。 */
  function assertProfileBlocks(row, blocks) {
    if (String(row.kind ?? '') !== 'profile') return;
    const result = checkProfile({ blocks, title: row.title });
    if (!result.ok) throw badRequest(profileBlockedMessage(result));
  }

  /**
   * 名片块必须在第一位（需求 2 的「不许移动位置」）。
   *
   * 已有的名片块**本身**不许挪（`moveBlock` 在写之前就拦了）；这条拦的是另一半：
   * 别的块不许插到它前面。它只读一次块表，所以是**写之前的**判定 —— 没有事务可用
   * （`queries.js` 这一层压根没有事务），所以规则一律在写之前挡。
   */
  function assertCardFirst(row) {
    if (String(row.kind ?? '') !== 'profile') return;
    const blocks = readBlocks(row.id);
    if (!blocks.some((item) => isProfileCard(blockFromRow(item)))) return;   // 还没名片的（老主页）交给 ensureProfileCard 补
    if (isProfileCard(blockFromRow(blocks[0]))) return;
    throw badRequest(`「${PROFILE_CARD_APP}」块必须在第一位，别的块不能插到它前面`);
  }

  /**
   * 目录（ToC）：只收标题块，锚点用**稳定块 id**。
   *
   * 为什么不扫 DOM：右栏要在正文渲染之前就画出来，`#/wiki/<站>/<页>` 的站内跳转
   * 也要一份不依赖前端的目录；而块 id 在服务端本来就是唯一的，
   * 不需要 slug（slug 会撞、会随标题改动失效）。
   * 锚点是 `h-<blockId>`（见 `blocks/types.js` 的 heading.toHtml）。
   */
  function tocOf(blocks) {
    return blocks
      .filter((block) => block.type === 'heading')
      .map((block) => ({
        blockId: String(block.block_id),
        level: Math.min(Math.max(Number(block.props?.level) || 1, 1), 6),
        // 目录显示的是**纯文字**：标题里的 `**粗体**` / 徽章图 / 链接不该抄进来（见 plainInline）。
        text: plainInline(String(block.props?.text ?? '')),
      }));
  }

  /**
   * 渲染上下文（§4.4 / §6.4）。
   *
   * 除了沙箱开关，还要给渲染管线两样**只有服务端查得到**的东西：
   *   - `wikiTitles`：所有看得见的 wiki 页标题，双链据此决定蓝 / 红（红链 = 还没写）；
   *   - `pageTitles`：`subpage` 卡片要显示的标题，按页面 id 现查（改标题卡片跟着变）。
   * 两样都只在真用得上时才去查库 —— 普通帖子里的段落不该为 wiki 付一次查询。
   */
  function renderOptions(docRow, viewer, blocks, { sandboxDisabled = null } = {}) {
    const options = {
      sandboxDisabled: sandboxDisabled === null ? Boolean(docRow.sandbox_disabled) : Boolean(sandboxDisabled),
      documentId: docRow.id,
    };
    const list = Array.isArray(blocks) ? blocks : [];
    const wantsLinks = list.some((block) => block.type === 'wiki' || String(block?.props?.text ?? '').includes('[['));
    if (wantsLinks) {
      // 红链判断是「存在且我看得见」：小写化之后比较（标题查库走 COLLATE NOCASE）。
      const set = new Set();
      for (const title of queries.wikiPageTitles({ visible: visibilityConditions(viewer, hasTeams) })) {
        set.add(String(title).toLowerCase());
      }
      if (docRow.title) set.add(String(docRow.title).toLowerCase());
      options.wikiTitles = set;
    }
    const ids = [...new Set(list
      .filter((block) => block.type === 'subpage')
      .map((block) => String(block?.props?.doc ?? '').trim())
      .filter((value) => /^\d+$/.test(value)))];
    if (ids.length) {
      const map = {};
      for (const row of queries.titlesOf(ids)) map[String(row.id)] = row.title;
      options.pageTitles = map;
    }
    return options;
  }

  /** 影子行同步：public 才带标题与摘要，其余范围写空串（少泄露一点是一点）。 */
  function syncDocumentAnchor(docRow, at) {
    const anchorId = docRow?.anchor_post_id;
    if (!anchorId) return;
    // 有草稿的时候，影子行跟着**线上那一份**走：摘要是给列表页 / 动态流看的，
    // 不能剧透作者还没发布的东西（工作副本里可能已经把整篇删了一半）。
    const drafting = Boolean(docRow.draft_document_id);
    const unpublished = drafting && !docRow.draft_published;
    const liveBlocks = drafting ? queries.publishedBlocksOf(docRow.id).map(blockFromRow) : readBlocks(docRow.id);
    const isPublic = docRow.scope === 'public' && !unpublished;
    const excerpt = isPublic ? blocksToPlainText(liveBlocks, 400) : '';
    // 从没发布过的草稿把影子行藏起来：它的 scope 通常就是 `public`，不藏就会被
    // `anchorHidden('public')` 放行，一条还没发布的东西直接漏进动态流和板块列表。
    // wiki 站里的页同理（§6.1）：页是站里的块，不该在「积木」板块里另立一行。
    // 站本体（`template='station'`）不藏 —— 它本来就是一个正常帖子，正好是「一个帖子一个 wiki」。
    const hidden = unpublished || (docRow.template === WIKI_TEMPLATE && stationIdOf(docRow.id) !== 0) ? STATION_PAGE_HIDDEN : null;
    syncAnchor(db, anchorId, {
      title: isPublic ? docRow.title : '',
      content: excerpt,
      scope: docRow.scope,
      deleted: Boolean(docRow.deleted),
      now: at,
      hidden,
    });
  }

  /**
   * 互动能力。
   *
   * `canReact` 必须与 `src/core/guards.js` 的 `assertPostVisible` **同规则**：
   * 核心的赞 / 踩 / 收藏只认影子行的 `hidden`，而 `hidden` 又只由 scope 决定。
   * 前端照着它藏按钮，才不会出现"点了就 404"的按钮。
   *
   * 「同规则」落地成两件事，改一处必须改另一处：
   *   1. 这里直接复用 `canView`（public / 作者 / staff / 关注者 / 同队）；
   *   2. `src/modules/doc/index.js` 把同一条判定登记给 core（`addPostVisibility`）。
   */
  function abilitiesOf(docRow, viewer) {
    const interactionAllowed = canView(docRow, viewer);
    return {
      canView: true,
      canEdit: canEdit(docRow, viewer),
      canReact: interactionAllowed,
    };
  }

  /** 详情形状（列表、创建、更新、回滚共用这一个出口）。 */
  function present(docRow, viewer) {
    // 需求 2：个人主页的名片块「缺失就补 / 老名片对齐成占位」（幂等，只对改得动这篇的人动手）。
    // 它只回**名片那一块**的新形状（或 `undefined`），正文走下面那条草稿感知的读法。
    const ensured = ensureProfileCard(docRow, viewer);
    const settingsRow = readSettings(docRow.id);
    // 注意：这里的 `blocks` 是**没被 materialize 过**的原始块。
    // 源码要的是作者写下的东西，不是「此刻渲染出来的修订列表」。
    // 读哪一份由身份决定（有未发布的改动时，读者只能看见发布出去的那一份）。
    // 名片那块（`ensured`）是补/对齐出来的单块，合进来即可 —— 不能拿它短路这一行。
    let blocks = readBlocksFor(docRow, viewer);
    if (ensured) {
      const at = blocks.findIndex((item) => String(item.block_id) === String(ensured.block_id));
      if (at >= 0) {
        const next = blocks.slice();
        next[at] = ensured;
        blocks = next;
      } else {
        blocks = [ensured, ...blocks];
      }
    }
    const materialized = materializeSources(blocks, docRow.id);
    // 脚本产出的派生块**接在真块之后**：真块序列一个字节都不动，派生层是叠加物（§4.4）。
    const derived = derivedRows(docRow.id, viewer);
    const living = derived.length ? [...materialized, ...derived] : materialized;
    // 需求 2：主页那六块在**渲染时**才被换成真正的 UI（名片卡 / 统计格 / 标签 / 置顶 / 帖子 / 动态）。
    // 注意顺序：`blocks`（给编辑器和 API 的那一份）里始终是占位 —— 见 `materializeProfileBlocks`。
    const forRender = materializeProfileBlocks(living, docRow, viewer);
    // `sandboxDisabled` 要交给渲染层：沙箱块据此**连 iframe 都不建**（§6.4）。
    const rendered = renderBlocks(forRender, renderOptions(docRow, viewer, living));
    const abilities = abilitiesOf(docRow, viewer);
    const data = {
      doc: shapeDoc(docRow, queries.tagsOf(docRow.id)),
      blocks: living.map((block) => ({
        blockId: block.block_id,
        type: block.type,
        version: Number(block.version) || 1,
        props: block.props ?? {},
        ...(block.derived ? { derived: true, scope: block.scope } : {}),
      })),
      html: rendered.html,
      toc: tocOf(living),
      warnings: rendered.warnings,
      abilities,
      settings: shapeSettings(settingsRow),
    };
    // 站里的页（或站本体）额外带上左树 / 前后页：三栏布局一次拿齐，不再发第二个请求。
    const wiki = wikiContext(docRow, viewer);
    if (wiki) data.wiki = wiki;
    // 源码只给改得动的人：它带着块 id，是编辑器的起点，不是读者需要的东西。
    if (abilities.canEdit) data.source = sourceOf(settingsRow, blocks);
    return data;
  }

  /**
   * 这篇文档的互动锚点（影子行）是哪一行帖子。
   *
   * 阅读页要拿它去拉赞 / 踩 / 收藏 / AI 解读的现状 —— 那些数据全在
   * `posts` 那一行上（见 `anchor.js` 的「为什么需要它」）。回 `0` 表示
   * 「没有锚点」或「这篇你看不见」，两种情况调用方都给空互动条，不区分。
   */
  function anchorPostIdOf({ id, viewer } = {}) {
    const row = mustSee(id, viewer);
    return Number(row.anchor_post_id) || 0;
  }

  /**
   * 反查：这一行帖子是**哪篇积木**的影子行（帖子详情页要拿它指回积木页）。
   *
   * 影子行本身不对外展示，所以这里也过一遍 `canView`：看不见的文档
   * 一律回 `null`（和互动接口的 404 同一个态度）。
   */
  function documentByAnchorFor({ postId, viewer } = {}) {
    const anchorId = Number(postId);
    if (!Number.isInteger(anchorId) || anchorId <= 0) return null;
    const row = queries.documentByAnchor(anchorId);
    if (!row || !canView(row, viewer)) return null;
    return { id: Number(row.id), title: String(row.title ?? ''), scope: row.scope };
  }

  /**
   * 源码预览：解析 + 渲染，**一个字都不落库**。
   *
   * 编辑器右侧那块靠它 —— 所以它必须便宜（不写库、不建修订、不动 `source_text`），
   * 也必须诚实：`warnings` 原样带回，别替作者过滤掉。
   */
  function previewMarkdown({ id, viewer, markdown } = {}) {
    const row = mustEdit(id, viewer);
    const parsed = parseSourceBlocks(String(markdown ?? ''));
    const rendered = renderBlocks(parsed.blocks, renderOptions(row, viewer, parsed.blocks));
    return {
      documentId: row.id,
      html: rendered.html,
      warnings: [...parsed.warnings, ...rendered.warnings],
      // props 要带全：预览里的沙箱 iframe 拿它当 `init` 消息（与阅读页同一套挂载代码）。
      blocks: parsed.blocks.map((block) => ({
        blockId: block.block_id,
        type: block.type,
        version: Number(block.version) || 1,
        props: block.props ?? {},
      })),
    };
  }

  /* ---------------- 位置计算 ---------------- */
  /**
   * 算出新块该放在哪个 position。
   *
   * 优先取中点（1 和 2 之间写 1.5），这样插入一块不必重排整篇；
   * 但反复往同一个缝里插会把浮点差值磨到精度以下，那时就重排一次 1..n。
   */
  function computePosition(documentId, { after = null, before = null, position = null, kind = '' } = {}) {
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

    // 需求 2：个人主页放新块时，谁都不许排到名片块前面（名片永远第一位）。
    // 拦截放在这里而不是每个调用点：`addBlock` / `moveBlock` 都走这一个算位置的函数。
    if (kind === 'profile' && rows.length) {
      const card = rows.find((row) => isProfileCard(blockFromRow(row)));
      if (card && target <= Number(card.position)) {
        throw badRequest(`「${PROFILE_CARD_APP}」块必须在第一位，别的块不能插到它前面`);
      }
    }

    const collides = rows.some((row) => Math.abs(Number(row.position) - target) < 1e-9);
    if (!collides) return target;

    // 浮点被磨平了：整篇重排成 1..n，再算一次。
    const at = now();
    rows.forEach((row, index) => queries.setBlockPosition({ documentId, blockId: row.block_id, position: index + 1, now: at }));
    return computePosition(documentId, { after, before, position, kind });
  }

  /* ---------------- 文档 ---------------- */

  function listDocuments({ viewer, kind = '', scope = '', tag = '', wiki = '', template = '', mine = false, drafts = false, q = '', page = 1, limit = 20, sort = 'updated' } = {}) {
    const visible = visibilityConditions(viewer, hasTeams);
    const { rows, total } = queries.listDocuments({
      viewerId: viewer?.id ?? null,
      visible,
      kind,
      scope,
      tag: singleLineText(String(tag ?? '')).replace(/^#+/, ''),
      // `wiki` 三态：`''`（默认）不列站里的页、`all` 都列、`only` 只要站里的页。
      wiki: wiki === 'all' || wiki === 'only' ? wiki : '',
      // 点名要某一类模板：首页/公告页靠 `template=announce` 找站务公告。
      template: String(template ?? ''),
      mine: Boolean(mine),
      // 草稿箱：只看我自己有草稿的（`#/docs?drafts=1`）。
      drafts: Boolean(drafts),
      q: String(q ?? ''),
      page,
      limit,
      sort,
    });
    // 标签一次问一批（N+1 会把列表页变成 20 次查询）。
    const byDoc = queries.tagsFor(rows.map((row) => row.id));
    return {
      documents: rows.map((row) => shapeDoc(row, byDoc.get(Number(row.id)) ?? [])),
      total,
      page: Math.max(Number(page) || 1, 1),
      limit: Math.min(Math.max(Number(limit) || 20, 1), 50),
      wiki: wiki === 'all' || wiki === 'only' ? wiki : '',
    };
  }

  /**
   * 重排站务公告（只有站长和管理员调得动）。
   *
   * 入参是**完整的期望顺序** —— `ids` 从头到尾就是希望看到的先后，不是「把 A 挪到 B 前面」。
   * 为什么不做「挪一下」：全部 `sort_order` 都还是 0 的时候，「相邻两行换一下」这个动作
   * 根本表达不出来，两个 0 谁前谁后由创建时间兜底，改完还是老样子。所以一次重排就把
   * 整份编号重写一遍：第一篇 `N*10`，最后一篇 `10`。留 10 的步长是为了以后插一篇
   * 不必把所有人重编号。
   *
   * **不在 `ids` 里的公告一律不动。** 但如果它的 `sort_order` 还是 0，它就会落到所有
   * 排过序的后面 —— 这正是想要的默认：新写的公告沉底，想让它上首页就手动往上挪。
   *
   * 只认 `template=announce`：这个接口不该被拿来给别人的积木排序。
   */
  function reorderAnnouncements({ viewer, ids = [] } = {}) {
    if (!isStaff(viewer)) throw new HttpError(403, 'owner_only', '只有站长和管理员能调公告顺序');

    const list = [];
    for (const value of Array.isArray(ids) ? ids : []) {
      const id = Number(value);
      if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'bad_ids', '公告编号得是正整数');
      if (list.includes(id)) throw new HttpError(400, 'bad_ids', '同一篇公告出现了两次');
      list.push(id);
    }
    if (!list.length) throw new HttpError(400, 'bad_ids', '没给要排的公告');

    for (const id of list) {
      const row = mustExist(id);
      if (String(row.template ?? '') !== ANNOUNCE_TEMPLATE) {
        throw new HttpError(400, 'not_announce', '只能排站务公告');
      }
    }

    const at = now();
    // 没变的那几篇不写：省下 `doc_settings.updated_at` 的无谓跳动，
    // 也让「只往上挪了一格」这种常见操作只落两次写。
    const before = queries.sortOrdersOf(list);
    list.forEach((id, index) => {
      const next = (list.length - index) * 10;
      if (before.get(id) === next) return;
      queries.setSortOrder({ documentId: id, sortOrder: next, now: at });
    });
    return { order: list };
  }

  /**
   * 用过的标签 + 篇数（广场的标签云、编辑器的候选项）。
   *
   * 门槛是「至少有一篇看得见的文档在用」：标签没有独立的生命周期，
   * 它是从用法里长出来的 —— 最后一篇带它的文档删了，它就该消失。
   */
  function listTags({ viewer, limit = 24 } = {}) {
    const visible = visibilityConditions(viewer, hasTeams);
    return { tags: queries.popularTags({ visible, limit }), maxTags: MAX_DOC_TAGS, maxTagLength: MAX_TAG_TEXT };
  }

  function getDocument(id, viewer) {
    const row = mustSee(id, viewer);
    // 触发点②（§6.7）：老 wiki 页第一次被打开时就地收编进站 —— 幂等，
    // 而且只有能改这一页的人才收编得动（`attachPageToStation` 走作者身份）。
    if (String(row.template ?? '') === WIKI_TEMPLATE && stationIdOf(row.id) === 0 && canEdit(row, viewer)) {
      const station = ensureDefaultStation({ viewer });
      attachPageToStation({ station, pageRow: mustExist(row.id), viewer });
      return present(mustExist(row.id), viewer);
    }
    return present(row, viewer);
  }

  /** 建一篇文档：正文 + 影子行 + 修订 1，一步不少。 */
  function createDocument({ viewer, title, kind = 'post', scope = 'public', template = '', tags = null, blocks = null, reason = 'create', draft = false } = {}) {
    if (!viewer) throw new HttpError(401, 'unauthenticated', '请先登录');
    const cleanTitle = normalizeTitle(title);
    const cleanKind = normalizeKind(kind);
    const cleanScope = normalizeScope(scope);
    // 先校验标签：坏标签要在**建影子行之前**就被挡下来，否则会留下一行没人认领的帖子。
    const cleanTags = normalizeTags(tags);
    const cleanTemplate = String(template ?? '');
    if (cleanTemplate && !hasTemplate(cleanTemplate)) throw badRequest(`不认识的模板：${cleanTemplate}`);
    // 站务公告只有站长和管理员能建（`visibility.js` 的 canEdit 管改，这里管建）。
    if (cleanTemplate === ANNOUNCE_TEMPLATE && !isStaff(viewer)) {
      throw new HttpError(403, 'owner_only', '站务公告只有站长和管理员能写');
    }
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
    } else if (cleanKind === 'profile') {
      // 需求 1/2：个人主页的**初始块**（名片 + 统计 + 标签 + 置顶 + 帖子 + 动态）。
      // 老客户端建 profile 文档不带 `template`，上面那条分支会给出空列表 ——
      // 一个空白主页是「合法」的，但对用户等于什么都没有，所以在这里 seed。
      list = profileSeedBlocks().map((block, index) => ({ ...block, block_id: `b${index + 1}` }));
    } else {
      list = [];
    }
    assertBudget(list.length);

    const at = now();
    const isPublic = cleanScope === 'public';
    // `draft` 的语义见 schema.js 的 doc_drafts 长注释：**默认直接发布**（老客户端 / 老 API
    // 语义一个字都不变），只有编辑器新建那条路显式传 `draft: true` 才是「先放草稿箱」。
    const asDraft = draft === true;
    // 影子行先建：文档行上要存它的 id（锚点反过来不用存文档 id，靠 anchor_post_id 找回来）。
    const anchorPostId = createAnchor(db, {
      userId: viewer.id,
      title: isPublic && !asDraft ? cleanTitle : '',
      content: isPublic && !asDraft ? blocksToPlainText(list, 400) : '',
      scope: cleanScope,
      now: at,
      // 还没发布的东西影子行一律先藏着（`anchorHidden('public')` 会给 0，不藏就漏了）。
      hidden: asDraft ? STATION_PAGE_HIDDEN : null,
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
    // published = 0：从没发布过。正文照旧写进 document_blocks（= 工作副本），
    // 发布那一刻才拷进 doc_published_blocks。
    if (asDraft) queries.enterDraftBox({ documentId: id, published: 0, now: at });
    writeBlocks(id, list, at);
    if (cleanTags.length) queries.replaceTags({ documentId: id, tags: cleanTags, now: at });
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
  /**
   * 按用户名取个人主页。**读不到就当场把这一份变成积木主页**（见 `upgradeProfileDocument` /
   * `createProfileDocument`）：改造前的老主页在库里没有文档，靠这条路按需补齐，
   * 于是每个人的 `#/u/:name` 都是「以积木帖子为底层」的那一版。
   */
  function getProfileDocument({ username = '', viewer = null } = {}) {
    const name = String(username ?? '').trim();
    let row = queries.profileDocumentByUsername(name);
    if (!row) {
      const user = db.prepare('SELECT id, username, display_name FROM users WHERE username = ?').get(name);
      if (!user) return null;
      try {
        row = createProfileDocument(user);
      } catch (error) {
        console.warn(`[doc] 给 ${name} 建积木主页失败：${error?.message ?? error}`);
        return null;
      }
    } else if (canView(row, viewer)) {
      try {
        if (upgradeProfileDocument(Number(row.id), Number(row.user_id))) row = mustExist(Number(row.id));
      } catch (error) {
        console.warn(`[doc] 把 ${name} 的主页变积木失败：${error?.message ?? error}`);
      }
    }
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
      // 红链点出来的老路也能把页补进站：写了一次双链、点了「建这一页」，
      // 结果它不在任何树的下面 —— 那才是真的奇怪。
      if (canEdit(existing, viewer) && stationIdOf(existing.id) === 0) {
        attachPageToStation({ station: ensureDefaultStation({ viewer }), pageRow: mustExist(existing.id), viewer });
      }
      return { ...present(mustExist(existing.id), viewer), created: false };
    }
    const data = createDocument({ viewer, title, kind: 'post', scope, template: WIKI_TEMPLATE, reason: 'template' });
    attachPageToStation({ station: ensureDefaultStation({ viewer }), pageRow: mustExist(data.doc.id), viewer });
    return { ...present(mustExist(data.doc.id), viewer), created: true };
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

  /* ---------------- Wiki 站（§6：一个帖子一个 wiki） ---------------- */

  /** 这一页归在哪个站（0 = 不归任何站，普通帖子 / 还没收编的老页）。 */
  function stationIdOf(documentId) {
    return Number(readSettings(documentId)?.station_id) || 0;
  }

  /** 站的本体行：`template='station'` 的那篇文档（它照旧是一个正常帖子）。 */
  function stationRow(stationId) {
    return queries.stationDocument(Number(stationId)) ?? null;
  }

  /** 站里的页（已按可见性过滤 + `canView` 复核），铺平成「树的中序遍历」。 */
  function stationPages(stationId, viewer) {
    const rows = queries
      .pagesOfStation({ stationId: Number(stationId), visible: visibilityConditions(viewer, hasTeams) })
      .filter((row) => canView(row, viewer))
      .map((row) => ({
        id: row.id,
        title: row.title,
        scope: row.scope,
        username: row.username ?? '',
        updatedAt: row.updated_at,
        parentId: Number(row.parent_id) || 0,
        sortOrder: Number(row.sort_order) || 0,
        icon: row.icon || '',
      }));
    return flattenTree(rows);
  }

  /**
   * 把「父 → 子」关系铺成一根线（前序遍历），顺带记下每一页的层级。
   *
   * 上一页 / 下一页就是这根线上的邻居；`depth` 给前端画缩进。
   * 环（两页互相当父）不能让渲染卡死：走不到的页一律追加在末尾。
   */
  function flattenTree(pages) {
    const children = new Map();
    for (const page of pages) {
      const key = page.parentId;
      if (!children.has(key)) children.set(key, []);
      children.get(key).push(page);
    }
    for (const list of children.values()) {
      list.sort((a, b) => (a.sortOrder - b.sortOrder) || a.title.localeCompare(b.title, 'zh'));
    }
    const flat = [];
    const seen = new Set();
    const walk = (parentId, depth) => {
      for (const page of children.get(parentId) ?? []) {
        if (seen.has(page.id)) continue;
        seen.add(page.id);
        flat.push({ ...page, depth });
        walk(page.id, depth + 1);
      }
    };
    walk(0, 0);
    for (const page of pages) if (!seen.has(page.id)) flat.push({ ...page, depth: 0 });
    return flat;
  }

  function briefPage(page) {
    return page ? { id: page.id, title: page.title, icon: page.icon ?? '' } : null;
  }

  function briefStation(row, viewer) {
    return {
      id: row.id,
      title: row.title,
      scope: row.scope,
      username: row.username ?? '',
      canEdit: canEdit(row, viewer),
      updatedAt: row.updated_at,
    };
  }

  /** 一篇文档所在的站（含树与前后页）；不在任何站里就返回 null。 */
  function wikiContext(docRow, viewer) {
    const isStation = String(docRow.template ?? '') === STATION_TEMPLATE;
    const stationId = isStation ? docRow.id : stationIdOf(docRow.id);
    if (!stationId) return null;
    const station = isStation ? docRow : stationRow(stationId);
    if (!station || !canView(station, viewer)) return null;
    const pages = stationPages(station.id, viewer);
    const index = pages.findIndex((page) => page.id === docRow.id);
    return {
      station: briefStation(station, viewer),
      pages,
      current: isStation ? 0 : docRow.id,
      prev: index > 0 ? briefPage(pages[index - 1]) : null,
      next: index >= 0 && index + 1 < pages.length ? briefPage(pages[index + 1]) : null,
    };
  }

  /** `#/wiki`：所有看得见的站 + 每个站有多少页。 */
  function listStations({ viewer = null } = {}) {
    const stations = queries
      .stations({ visible: visibilityConditions(viewer, hasTeams) })
      .filter((row) => canView(row, viewer))
      .map((row) => ({
        id: row.id,
        title: row.title,
        scope: row.scope,
        username: row.username ?? '',
        pages: Number(row.pages) || 0,
        updatedAt: row.updated_at,
      }));
    return { stations, nav: wikiNav({ viewer }) };
  }

  /**
   * 打开一个站：按 id 或按名字（`#/wiki/<站>/<页>` 那条路由只有名字可用）。
   *
   * `pageTitle` 给了就顺便把那一页的 `present()` 一起回 —— 三栏页面的左树、右 ToC、
   * 上一页 / 下一页一次拿齐，前端不用再发第二个请求（也就不会闪一下空壳）。
   */
  function getStation({ id = 0, title = '', pageTitle = '', viewer = null } = {}) {
    const row = id ? stationRow(id) : queries.stationByTitle(String(title ?? '').trim());
    if (!row || !canView(row, viewer)) return { found: false, station: null, pages: [] };
    const payload = {
      found: true,
      station: briefStation(row, viewer),
      pages: stationPages(row.id, viewer),
      doc: null,
    };
    const wanted = String(pageTitle ?? '').trim();
    if (wanted) {
      // 同名页可能有别的站的（标题只在一个站里有意义），只认属于**这个站**的那一篇。
      const page = queries
        .documentsByTitle(wanted, WIKI_TEMPLATE)
        .find((candidate) => stationIdOf(candidate.id) === row.id);
      if (page && canView(page, viewer)) payload.doc = present(page, viewer);
    } else {
      // `#/wiki/<站>` 没有指名哪一页：站本身就是一篇普通帖子，直接给它的正文当首页。
      payload.doc = present(row, viewer);
    }
    return payload;
  }

  /** 在站里新建一页，并把它挂到站的目录上（站里的卡片 = `subpage` 块）。 */
  function createStationPage({ stationId, viewer, title, parentId = 0, icon = '' } = {}) {
    const station = stationRow(stationId);
    if (!station || !canView(station, viewer)) throw notFound(viewer);
    if (!canEdit(station, viewer)) throw new HttpError(403, 'owner_only', '只有这个 wiki 的作者能加页');
    const cleanTitle = singleLineText(title).slice(0, MAX_DOC_TITLE);
    if (!cleanTitle) throw badRequest('页面名不能为空');
    const existing = queries.documentByTitle(cleanTitle, WIKI_TEMPLATE);
    if (existing) {
      attachPageToStation({ station, pageRow: existing, viewer });
      return { ...present(mustExist(existing.id), viewer), created: false };
    }
    const data = createDocument({
      viewer,
      title: cleanTitle,
      kind: 'post',
      scope: station.scope,
      template: WIKI_TEMPLATE,
      reason: 'template',
    });
    const pageRow = mustExist(data.doc.id);
    attachPageToStation({ station, pageRow, viewer, parentId, icon });
    return { ...present(mustExist(pageRow.id), viewer), created: true };
  }

  /**
   * 把一页挂到站上：设 `station_id` → 往站文档追加一块 `subpage` → 藏起它的影子行。
   *
   * **幂等**是硬要求：站的目录、页的归属，两边都要「做过了就什么都不发生」。
   */
  function attachPageToStation({ station, pageRow, viewer, parentId = null, icon = null } = {}) {
    const at = now();
    const before = readSettings(pageRow.id);
    const stationId = station.id;
    const sameStation = Number(before?.station_id) === stationId;
    const order = Number(before?.sort_order) || 0;
    queries.setStationId({
      documentId: pageRow.id,
      stationId,
      parentId: parentId === null ? Number(before?.parent_id) || 0 : Number(parentId) || 0,
      sortOrder: order,
      now: at,
    });
    // 站的目录里补一块子页卡。已经挂过（同一页 id 的 subpage 块）就不重复追加。
    const blocks = readBlocks(stationId);
    const already = blocks.some((block) => block.type === 'subpage' && String(block.props?.doc ?? '') === String(pageRow.id));
    if (!already) {
      const typeDef = getBlockType('subpage');
      const shaped = serializeBlock({
        block_id: `b${queries.nextBlockNumber(stationId)}`,
        type: 'subpage',
        version: typeDef?.version ?? 1,
        props: { doc: String(pageRow.id), mode: 'card', title: '', note: '' },
      });
      assertBudget(blocks.length + 1);
      queries.insertBlockRow({
        documentId: stationId,
        blockId: shaped.block_id ?? '',
        type: shaped.type,
        version: shaped.version,
        position: blocks.length + 1,
        propsJson: shaped.propsJson,
        now: at,
      });
      // 站的源码（`source_text`）跟着重生成：站内搜索与编辑器都读它。
      queries.setSourceText({ documentId: stationId, sourceText: toSource(readBlocks(stationId)), now: at });
      snapshot(stationId, 'template', viewer?.id ?? pageRow.user_id, at);
      syncDocumentAnchor(mustExist(stationId), at);
    }
    if (!sameStation) {
      // 老页原来没有 `source_text`（那是后加的列）：收编时顺手按现在的块补一份，
      // 否则站内搜索（搜的就是 `source_text`）会把老页漏掉。
      if (!String(before?.source_text ?? '').trim()) {
        queries.setSourceText({ documentId: pageRow.id, sourceText: toSource(readBlocks(pageRow.id)), now: at });
      }
      snapshot(pageRow.id, 'template', viewer?.id ?? pageRow.user_id, at);
    }
    syncDocumentAnchor(mustExist(pageRow.id), at);
    return { stationId, attached: !sameStation };
  }

  /**
   * 幂等收编：把还没有归站的 wiki 页（`station_id = 0`）全部挂到一个站上。
   *
   * 两个触发点共用这一条路（§6.7）：`GET /api/docs/wiki` 全量收编；
   * 以及任何一页被 `GET /api/docs/:id` 打开时就地收编。第二条是必须的 ——
   * 老页的链接到处都是，不能指望作者先去点一次站列表。
   */
  function ensurePagesAttached({ viewer } = {}) {
    const orphans = queries.orphanPages(200);
    if (orphans.length === 0) return { attached: 0, stationId: 0 };
    // 匿名访客触发（老链接点进来、站列表被爬）时，以第一篇孤儿页的作者当这次迁移的
    // 「执行人」：收编是系统动作，但改归属得有人担责，用页作者自己最稳 —— 别人的页照旧不碰。
    // 不这样做会出现「站建出来了、页一个都没挂上」的半吊子状态。
    const actor = viewer ?? { id: orphans[0].user_id };
    const station = ensureDefaultStation({ viewer: actor });
    let attached = 0;
    for (const page of orphans) {
      const pageRow = mustExist(page.id);
      // 只有页的作者（或 staff）能把它挂上：替别人改归属是越权。
      if (!canEdit(pageRow, actor)) continue;
      attachPageToStation({ station, pageRow, viewer: actor });
      attached += 1;
    }
    return { attached, stationId: station.id };
  }

  /** 默认站：第一篇站；一篇都没有就建一个叫「Wiki」的公开站（幂等）。 */
  function ensureDefaultStation({ viewer } = {}) {
    const rows = queries.stations({ visible: visibilityConditions(viewer ?? null, hasTeams) });
    const usable = rows.filter((row) => canEdit(row, viewer));
    if (usable.length > 0) return mustExist(usable[0].id);
    return mustExist(createStation({ viewer, title: 'Wiki', scope: 'public' }).doc.id);
  }

  /** 建一个站：就是建一篇普通帖子（`kind='post'`） + `station` 模板。 */
  function createStation({ viewer, title = '', scope = 'public' } = {}) {
    const cleanTitle = singleLineText(title).slice(0, MAX_DOC_TITLE);
    return createDocument({
      viewer,
      title: cleanTitle || 'Wiki',
      kind: 'post',
      scope,
      template: STATION_TEMPLATE,
      reason: 'template',
    });
  }

  /** 站内搜索：标题 + 作者敲的原文两个 LIKE，只搜本站、只搜看得见的页。 */
  function searchStation({ stationId, q, viewer = null } = {}) {
    const station = stationRow(stationId);
    if (!station || !canView(station, viewer)) throw notFound(viewer);
    const query = singleLineText(q).slice(0, 80);
    if (!query) return { stationId: station.id, query: '', results: [] };
    const results = queries
      .searchStationPages({
        stationId: station.id,
        q: query,
        visible: visibilityConditions(viewer, hasTeams),
        limit: 50,
      })
      .filter((row) => canView(row, viewer))
      .map((row) => ({
        id: row.id,
        title: row.title,
        parentId: Number(row.parent_id) || 0,
        // 摘要：从原文里摘一句带关键词的，找不到就从开头截。
        excerpt: excerptAround(String(row.source_text ?? ''), query, 90),
      }));
    return { stationId: station.id, query, results };
  }

  /** 从原文里摘一句带关键词的上下文（搜不到就截开头），供搜索结果显示。 */
  function excerptAround(text, keyword, width) {
    const flat = text.replace(/\s+/g, ' ').trim();
    const at = flat.toLowerCase().indexOf(String(keyword).toLowerCase());
    if (at < 0) return flat.slice(0, width);
    const start = Math.max(0, at - Math.floor(width / 3));
    return `${start > 0 ? '…' : ''}${flat.slice(start, start + width)}`;
  }

  /**
   * 改一页在站里的位置（父页 / 排序 / 图标）。
   * 和 `putSettings` 分开：这组字段是**站**说了算，不是页自己说了算。
   */
  function moveStationPage({ stationId, id, viewer, parentId, sortOrder, icon } = {}) {
    const station = stationRow(stationId);
    if (!station || !canView(station, viewer)) throw notFound(viewer);
    const row = mustEdit(id, viewer);
    if (stationIdOf(row.id) !== station.id) throw badRequest('这一页不在这个 wiki 里');
    const before = readSettings(row.id);
    const nextParent = parentId === undefined ? Number(before?.parent_id) || 0 : Math.max(Number(parentId) || 0, 0);
    if (nextParent === row.id) throw badRequest('一页不能把自己当父页');
    const at = now();
    queries.setStationId({
      documentId: row.id,
      stationId: station.id,
      parentId: nextParent,
      sortOrder: sortOrder === undefined ? Number(before?.sort_order) || 0 : Math.trunc(Number(sortOrder) || 0),
      now: at,
    });
    if (icon !== undefined) {
      queries.upsertSettings({
        documentId: row.id,
        allowScriptWrite: Boolean(before?.allow_script_write),
        appMode: String(before?.app_mode ?? 'inline'),
        stationId: station.id,
        parentId: nextParent,
        sortOrder: sortOrder === undefined ? Number(before?.sort_order) || 0 : Math.trunc(Number(sortOrder) || 0),
        icon: singleLineText(icon).slice(0, 32),
        sourceText: String(before?.source_text ?? ''),
        now: at,
      });
    }
    return { stationId: station.id, id: row.id, parentId: nextParent, pages: stationPages(station.id, viewer) };
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

  function updateDocument({ id, viewer, title, scope, template, tags } = {}) {
    const row = mustEdit(id, viewer);
    const cleanTitle = title === undefined ? row.title : normalizeTitle(title);
    const cleanScope = scope === undefined ? row.scope : normalizeScope(scope);
    const cleanTemplate = template === undefined ? String(row.template ?? '') : String(template ?? '');
    if (cleanTemplate && !hasTemplate(cleanTemplate)) throw badRequest(`不认识的模板：${cleanTemplate}`);
    // 标签同理：`undefined` = 不动它（改标题的老客户端不该顺手把标签清空）。
    const cleanTags = tags === undefined ? null : normalizeTags(tags);
    const at = now();
    queries.updateDocumentMeta({ id: row.id, title: cleanTitle, scope: cleanScope, template: cleanTemplate, updatedAt: at });
    if (cleanTags) queries.replaceTags({ documentId: row.id, tags: cleanTags, now: at });
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
    // 标签也一样：留着只会让标签云指向一堆看不见的文档。
    queries.deleteTagsOfDocument(row.id);
    // 草稿两表跟着走：文档都没了，线上版和草稿行都是孤儿。
    queries.clearDraft(row.id);
    queries.deletePublishedBlocks(row.id);
    syncDocumentAnchor({ ...row, deleted: 1 }, at);
    return { id: row.id, deleted: true };
  }

  /**
   * 发布：把工作副本（= 草稿）拷成线上版，然后撤掉草稿行。
   *
   * 撤掉草稿行就是「这篇没有未发布的改动了」——`document_blocks` 重新成为读者看到的那一份
   * （`readBlocksFor` 只在草稿行还在时才去读快照）。所以发布**不需要**改任何写块路径。
   *
   * 用 `mustEdit` 而不是 `mustEditBody`：本来就没有改动、也没草稿行的文档再点一次「发布」
   * 应该是无害的，不该顺手给它造出一行草稿（那会让它显示成「有未发布的改动」）。
   */
  function publishDocument({ id, viewer } = {}) {
    const row = mustEdit(id, viewer);
    const at = now();
    // 没有草稿行 = 这篇对外那一份本来就是 `document_blocks`，没什么要固化的（重复发布也走这里）。
    if (row.draft_document_id) queries.copyPublishedBlocks({ documentId: row.id, now: at });
    queries.clearDraft(row.id);
    const fresh = mustExist(row.id);
    // 影子行的摘要 / 隐藏状态跟着回到「已经发布」的样子（公开档会在这里从 hidden 里放出来）。
    syncDocumentAnchor(fresh, at);
    return present(fresh, viewer);
  }

  /* ---------------- 块 ---------------- */

  function addBlock({ id, viewer, type, props = {}, after = null, before = null, position = null } = {}) {
    const row = mustEditBody(id, viewer);
    const typeDef = getBlockType(type);
    if (!typeDef) throw badRequest(`不认识的块类型：${type}`);
    assertBudget(queries.countBlocks(row.id) + 1);
    const at = now();
    const blockId = `b${queries.nextBlockNumber(row.id)}`;
    const place = computePosition(row.id, { after, before, position, kind: row.kind });
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
    const row = mustEditBody(id, viewer);
    const existing = queries.blockRow(row.id, blockId);
    if (!existing) throw new HttpError(404, 'not_found', `找不到块 ${blockId}`);
    const nextType = type === undefined ? existing.type : String(type);
    const typeDef = getBlockType(nextType);
    if (!typeDef) throw badRequest(`不认识的块类型：${nextType}`);
    const nextProps = props === undefined ? JSON.parse(existing.props_json || '{}') : props;
    // 需求 2：「个人主页名片」块**不允许编辑** —— 它的内容由宿主（页面）渲染。
    // 改它只允许一种情况：把内容写成/保持成那个占位标记（幂等的保存不该被拒）。
    if (isProfileCard(blockFromRow(existing))) {
      const nextApp = String(nextProps?.app ?? '');
      const nextCode = String(nextProps?.code ?? '').trim();
      if (nextApp !== PROFILE_CARD_APP || (nextCode && nextCode !== PROFILE_CARD_HTML)) {
        throw badRequest(`「${PROFILE_CARD_APP}」块由主页自己渲染（头像 / 昵称 / 签名 / 关注 / 私信 / 拉黑），不许编辑；要改个人信息请去账号设置`);
      }
    }
    const shaped = serializeBlock({ block_id: blockId, type: nextType, version: typeDef.version, props: nextProps });
    // 需求 2：主页改**一块**也要过判定 —— 否则把别的块改成 `props.app='个人主页名片'`
    // 就会绕开「名片只能有一个」，整页判定（`assertProfileBlocks`）只在建/删/挪时跑。
    if (String(row.kind ?? '') === 'profile') {
      const after = readBlocks(row.id)
        .map((item) => blockFromRow(item))
        .map((item) => (String(item.block_id) === String(blockId) ? { ...item, type: shaped.type, props: JSON.parse(shaped.propsJson || '{}') } : item));
      assertProfileBlocks(row, after);
    }
    const at = now();
    queries.updateBlockRow({ documentId: row.id, blockId, type: shaped.type, version: shaped.version, propsJson: shaped.propsJson, now: at });
    snapshot(row.id, 'edit', viewer.id, at);
    reconcilePollVotes(row.id);
    reconcileAppState(row.id);
    syncDocumentAnchor(mustExist(row.id), at);
    return { block: { blockId, type: shaped.type, version: shaped.version, props: shaped.props } };
  }

  function deleteBlock({ id, viewer, blockId } = {}) {
    const row = mustEditBody(id, viewer);
    const existing = queries.blockRow(row.id, blockId);
    if (!existing) throw new HttpError(404, 'not_found', `找不到块 ${blockId}`);
    // 需求 2：个人主页的名片块不许删（它是"头像 / 昵称 / 签名 / 关注"那一框，锁着的）。
    if (String(row.kind ?? '') === 'profile' && isProfileCard(blockFromRow(existing))) {
      throw badRequest(`「${PROFILE_CARD_APP}」块不许删除 —— 主页靠它显示你是谁`);
    }
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
    const row = mustEditBody(id, viewer);
    const existing = queries.blockRow(row.id, blockId);
    if (!existing) throw new HttpError(404, 'not_found', `找不到块 ${blockId}`);
    if (after === blockId || before === blockId) throw badRequest('不能把块挪到自己旁边');
    // 需求 2：名片块的**位置**也不许动（它可以编辑，但永远在第一位）。
    if (String(row.kind ?? '') === 'profile' && isProfileCard(blockFromRow(existing))) {
      throw badRequest(`「${PROFILE_CARD_APP}」块必须在第一位，位置不能移动`);
    }
    const at = now();
    const place = computePosition(row.id, { after, before, position, kind: row.kind });
    queries.setBlockPosition({ documentId: row.id, blockId, position: place, now: at });
    // 挪完之后名片块如果不在第一位，说明是**别的块**插到了它前面 —— 也不许（规则是"名片在第一位"）。
    assertCardFirst(row, viewer);
    snapshot(row.id, 'edit', viewer.id, at);
    syncDocumentAnchor(mustExist(row.id), at);
    return { blockId, position: place, blocks: present(mustExist(row.id), viewer).blocks };
  }

  /** 拖拽排序：给一份完整的块 id 顺序，一次落库（顺便把 position 重排成整数）。 */
  function reorderBlocks({ id, viewer, order } = {}) {
    const row = mustEditBody(id, viewer);
    if (!Array.isArray(order) || order.length === 0) throw badRequest('order 必须是非空数组');
    const rows = queries.blocksOf(row.id);
    const known = new Set(rows.map((item) => item.block_id));
    const seen = new Set();
    for (const blockId of order) {
      if (!known.has(blockId)) throw badRequest(`找不到块 ${blockId}`);
      if (seen.has(blockId)) throw badRequest(`order 里重复了块 ${blockId}`);
      seen.add(blockId);
    }
    // 需求 2：整篇重排时名片块也必须留在第一位（写之前挡，免得排完了再回滚）。
    if (String(row.kind ?? '') === 'profile') {
      const card = rows.find((item) => isProfileCard(blockFromRow(item)));
      if (card && order.includes(card.block_id) && order[0] !== card.block_id) {
        throw badRequest(`「${PROFILE_CARD_APP}」块必须在第一位，位置不能移动`);
      }
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
    const row = mustEditBody(id, viewer);
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

  function putMarkdown({ id, viewer, markdown, title, confirm = false } = {}) {
    const row = mustEditBody(id, viewer);
    const text = typeof markdown === 'string' ? markdown : '';
    if (Buffer.byteLength(text, 'utf8') > MAX_DOC_BODY_BYTES) throw badRequest('正文太大了（上限 256 KB）');
    // 没写 id 的块**不发号**：交给 writeBlocks 按旧序列对齐，块 id 才不会整篇平移。
    const parsed = parseSourceBlocks(text);
    const before = queries.countBlocks(row.id);
    // 防手滑第 1 道：源码非空却一块都没解析出来 —— 多半是语法写坏了，宁可拒绝。
    if (text.trim() !== '' && parsed.blocks.length === 0) throw badRequest('源码没能解析出任何块');
    // 防手滑第 2 道：块数暴跌不直接拒绝，但要作者再点一次确认（`?confirm=1`）。
    if (!confirm && before >= 4 && parsed.blocks.length * 2 < before) {
      throw new HttpError(409, 'conflict', `块数从 ${before} 掉到 ${parsed.blocks.length}，确认这样存？`);
    }
    const at = now();
    const cleanTitle = title === undefined ? row.title : normalizeTitle(title);
    queries.updateDocumentMeta({ id: row.id, title: cleanTitle, scope: row.scope, template: row.template, updatedAt: at });
    writeBlocks(row.id, parsed.blocks, at);
    // 源码逐字节留着：解析器是有损的（表格分隔行被剥、嵌套列表被吞成一个块），
    // 编辑器的往返基准必须是作者自己写下的那份文本，而不是「解析再拼回来」。
    queries.setSourceText({ documentId: row.id, sourceText: text, now: at });
    snapshot(row.id, 'edit', viewer.id, at);
    const fresh = mustExist(row.id);
    syncDocumentAnchor(fresh, at);
    return present(fresh, viewer);
  }

  /* ---------------- 每篇一份的设置 ---------------- */

  /**
   * 改这篇文档自己的开关（只有作者改得动）。
   *
   * `station_id` / `parent_id` / `sort_order` **刻意不在这里改**：页面归哪个站、
   * 在站里排第几，是站说了算，不是页自己说了算（见 Wiki 那组接口）。
   */
  function putSettings({ id, viewer, allowScriptWrite, appMode, icon } = {}) {
    const row = mustEdit(id, viewer);
    const before = readSettings(row.id);
    const nextAppMode = appMode === undefined ? String(before?.app_mode ?? 'inline') : String(appMode);
    if (!APP_MODES.includes(nextAppMode)) throw badRequest(`不认识的展现方式：${nextAppMode}`);
    const at = now();
    queries.upsertSettings({
      documentId: row.id,
      // 这一条是「脚本能不能改这篇帖子」，**默认只能是「不能」**：
      // 只有明确传了真值才打开，别的（undefined 就沿用旧值）一律按关闭算。
      allowScriptWrite: allowScriptWrite === undefined
        ? Boolean(before?.allow_script_write)
        : allowScriptWrite === true || allowScriptWrite === 1 || allowScriptWrite === '1',
      appMode: nextAppMode,
      stationId: Number(before?.station_id) || 0,
      parentId: Number(before?.parent_id) || 0,
      sortOrder: Number(before?.sort_order) || 0,
      icon: icon === undefined ? String(before?.icon ?? '') : singleLineText(icon).slice(0, 32),
      sourceText: String(before?.source_text ?? ''),
      now: at,
    });
    const fresh = mustExist(row.id);
    syncDocumentAnchor(fresh, at);
    return present(fresh, viewer);
  }

  /* ---------------- 模板 ---------------- */

  function applyTemplate({ id, viewer, key, mode = 'replace' } = {}) {
    const row = mustEditBody(id, viewer);
    if (!hasTemplate(key)) throw badRequest(`不认识的模板：${key}`);
    if (mode !== 'replace' && mode !== 'append') throw badRequest('mode 只能是 replace 或 append');
    const at = now();
    const incoming = templateBlocks(key);
    let list;
    if (mode === 'append') {
      // 追加：旧块**保住自己的 id**（票 / 沙箱状态 / bind 都挂在上面），
      // 新块从现有最大号往后发。
      const base = queries.nextBlockNumber(row.id) - 1;
      list = [
        ...readBlocks(row.id),
        ...incoming.map((block, index) => ({ ...block, block_id: `b${base + index + 1}` })),
      ];
    } else {
      // 覆盖前先留一条旧快照：模板是"一键换掉整篇"，没有快照就真的找不回来了。
      snapshot(row.id, 'template', viewer.id, at);
      // 覆盖：新 id 一律从旧号之后开始，旧行会被真删掉，不会跟模板的块撞号
      //（撞号会让旧块的票 / 状态被"继承"到一块完全不相干的块上）。
      const base = queries.nextBlockNumber(row.id);
      list = incoming.map((block, index) => ({ ...block, block_id: `b${base + index}` }));
    }
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
    const row = mustEditBody(id, viewer);
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
    if (name === 'blocks.derived') return { capability: name, value: derivedPayload({ row, viewer, payload, at }) };
    // 需求 2：个人主页的「个人信息 API」—— `Sandbox.profile()` 走这条。
    if (name === 'profile') return { capability: name, value: profilePayload(row, viewer) };
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

  /**
   * `profile` 能力（需求 2）：把**主页所属那个人**的公开信息递进沙箱。
   *
   * 为什么按「文档的主人」而不是「正在看的人」：主页上的块说的是这个人的事，
   * 读者换了不该让数字跟着换。数据与 `GET /api/docs/profile/:username/stats`
   * 走同一个 `profilePayload`，所以「接口看到的」与「块里看到的」永远一致。
   */
  function profilePayload(row, viewer) {
    const owner = db.prepare('SELECT user_id FROM documents WHERE id = ? AND deleted = 0').get(row.id);
    const userId = Number(owner?.user_id ?? row.user_id ?? 0);
    if (!userId) return { found: false };
    const stats = profileStatsOf(userId, viewer);
    if (!stats) return { found: false };
    return { found: true, ...stats };
  }

  /**
   * 计数口径（「这个人有多少篇帖子」）里那两项人不在的排除条件。
   *
   * 与 `src/store.js` 的 `countFilter` 是同一个意思，但那一个是 core 的私有函数
   * （本模块 import 不到）；这里的条件全是**无参数**的常量子句，所以能直接拼。
   * 记着：条件式计数必须 `SUM(CASE WHEN … THEN 1 ELSE 0 END)`，`COUNT(*)` 数的是行存在。
   */
  function profileCountFilter(alias = 'p') {
    const parts = [`${alias}.deleted = 0`, `${alias}.hidden = 0`];
    const excluded = postListExclude();
    if (excluded && !excluded.params.length) {
      parts.push(alias === 'p' ? excluded.clause : excluded.clause.replace(/\bp\./g, ''));
    }
    return parts.join(' AND ');
  }

  /** `profile` 能力与 `GET /api/docs/profile/:username/stats` 共用的那份数据。 */
  /** 某张表在不在。个人主页要读 `replies` / `reactions` / `reposts`，它们都不在本模块名下。 */
  function hasTable(name) {
    return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
  }

  function profileStatsOf(userId, viewer) {
    const gated = profileVisibleSql(viewer);
    const row = db
      .prepare(
        `SELECT u.id, u.username, u.display_name, u.bio, u.avatar, u.role, u.created_at,
                (SELECT COALESCE(SUM(CASE WHEN ${profileCountFilter('p')} THEN 1 ELSE 0 END), 0) FROM posts p WHERE p.user_id = u.id) AS post_count,
                (SELECT COUNT(*) FROM follows f WHERE f.followee_id = u.id) AS follower_count,
                (SELECT COUNT(*) FROM follows f WHERE f.follower_id = u.id) AS following_count
         FROM users u WHERE u.id = ?`,
      )
      .get(userId);
    if (!row) return null;
    // 「回复 / 获赞 / 获踩」和改造前的个人主页统计格用的是同一批数字（`src/store.js` 的 userProfile 同款）。
    const replyCount = hasTable('replies')
      ? Number(db.prepare('SELECT COUNT(*) AS count FROM replies WHERE user_id = ? AND deleted = 0').get(userId)?.count ?? 0)
      : 0;
    const reactions = hasTable('reactions')
      ? db
          .prepare(
            `SELECT
               (SELECT COUNT(*) FROM reactions rx JOIN posts p2 ON p2.id = rx.post_id
                 WHERE p2.user_id = ? AND p2.deleted = 0 AND rx.kind = 'like') AS likes,
               (SELECT COUNT(*) FROM reactions rx JOIN posts p2 ON p2.id = rx.post_id
                 WHERE p2.user_id = ? AND p2.deleted = 0 AND rx.kind = 'dislike') AS dislikes`,
          )
          .get(userId, userId)
      : null;
    const posts = profileListOf(userId, gated, { limit: 20, pinned: false });
    const reposts = profileRepostsOf(userId, 20);
    const tags = db
      .prepare(
        `SELECT t.tag AS tag, COUNT(*) AS count FROM posts p JOIN doc_tags t ON t.document_id = p.id
         WHERE p.user_id = ? AND p.deleted = 0 AND p.hidden = 0 GROUP BY t.tag COLLATE NOCASE ORDER BY count DESC, t.tag COLLATE NOCASE ASC LIMIT 30`,
      )
      .all(userId);
    return {
      id: Number(row.id),
      username: row.username,
      displayName: row.display_name ?? row.username,
      bio: row.bio ?? '',
      avatar: row.avatar ?? '',
      role: row.role,
      createdAt: Number(row.created_at ?? 0),
      postCount: Number(row.post_count ?? 0),
      replyCount,
      likeCount: Number(reactions?.likes ?? 0),
      dislikeCount: Number(reactions?.dislikes ?? 0),
      repostCount: reposts.length,
      followerCount: Number(row.follower_count ?? 0),
      followingCount: Number(row.following_count ?? 0),
      pinnedCount: posts.filter((post) => post.pinned).length,
      tags: tags.map((tag) => ({ name: tag.tag, postCount: Number(tag.count) })),
      posts,
    };
  }

  /**
   * 读者能看见的积木贴（与 `visibility.js` 的 `canView` 同一口径）。
   *
   * 为什么不复用 `visibilityConditions()`：那一条拼的是 `d.scope`，是给
   * `listDocuments` 的 `documents d` 用的；这里查的是影子行 `posts p`，
   * 文档只用来当「公开了没有」的判断依据。
   */
  function profileVisibleSql(viewer) {
    if (isStaff(viewer)) return { where: '', params: [] };
    if (!viewer) return { where: "EXISTS (SELECT 1 FROM documents d WHERE d.anchor_post_id = p.id AND d.scope = 'public')", params: [] };
    return {
      where: "EXISTS (SELECT 1 FROM documents d WHERE d.anchor_post_id = p.id AND (d.scope = 'public' OR d.user_id = ?))",
      params: [viewer.id],
    };
  }

  /** 主页列出的积木贴（`pinned: true` 只取置顶那几篇）。 */
  function profileListOf(userId, gated, { limit = 20, pinned = false } = {}) {
    const params = [userId, ...gated.params];
    const parts = ['p.user_id = ?', 'p.deleted = 0', 'p.hidden = 0'];
    if (gated.where) parts.push(gated.where);
    const excluded = postListExclude();
    if (excluded && !excluded.params.length) parts.push(excluded.clause);
    if (pinned) parts.push('p.profile_pinned = 1');
    const rows = db
      .prepare(
        `SELECT p.id, p.title, p.updated_at, p.profile_pinned, d.title AS doc_title
         FROM posts p LEFT JOIN documents d ON d.anchor_post_id = p.id
         WHERE ${parts.join(' AND ')} ORDER BY p.profile_pinned DESC, p.updated_at DESC, p.id DESC LIMIT ${Math.min(Math.max(limit, 1), 50)}`,
      )
      .all(...params);
    return rows.map((row) => ({
      id: Number(row.id),
      title: plainInline(String(row.doc_title ?? row.title ?? '')) || '（无标题）',
      updatedAt: Number(row.updated_at ?? 0),
      pinned: Boolean(row.profile_pinned),
      url: `#/post/${Number(row.id)}`,
    }));
  }

  /** 主页列出的动态（转发）。`reposts` 表不在本模块名下，所以只出 id、标题与时间。 */
  function profileRepostsOf(userId, limit) {
    if (!hasTable('reposts')) return [];
    const rows = db
      .prepare(
        `SELECT r.post_id, r.created_at, p.title AS post_title, d.title AS doc_title
         FROM reposts r
         LEFT JOIN posts p ON p.id = r.post_id
         LEFT JOIN documents d ON d.anchor_post_id = r.post_id
         WHERE r.user_id = ? ORDER BY r.created_at DESC LIMIT ${Math.min(Math.max(limit, 1), 50)}`,
      )
      .all(userId);
    return rows.map((row) => ({
      id: Number(row.post_id),
      title: plainInline(String(row.doc_title ?? row.post_title ?? '')) || '（无标题）',
      updatedAt: Number(row.created_at ?? 0),
      pinned: false,
      url: `#/post/${Number(row.post_id)}`,
    }));
  }

  /** `GET /api/docs/profile/:username/stats` 的出口（需求 2 的「个人信息 API」）。 */
  function getProfileStats({ username, viewer } = {}) {
    const row = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(String(username ?? ''));
    if (!row) throw new HttpError(404, 'not_found', '这个人不存在');
    const stats = profileStatsOf(Number(row.id), viewer);
    if (!stats) throw new HttpError(404, 'not_found', '这个人不存在');
    return stats;
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

  /* ---------- 脚本模板：开发者功能里把常用的脚本片段存下来 ---------- */

  /** 模板一律按登录用户隔离：别人的模板既看不见也改不动。 */
  function templateViewer(viewer) {
    if (!viewer) throw new HttpError(401, 'unauthenticated', '要管理脚本模板得先登录');
    return viewer;
  }

  function templateRow(row) {
    return {
      id: Number(row.id),
      name: String(row.name),
      description: String(row.description ?? ''),
      code: String(row.code ?? ''),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  function listScriptTemplates({ viewer } = {}) {
    const user = templateViewer(viewer);
    return {
      templates: queries.scriptTemplatesOfUser(user.id).map(templateRow),
      limit: MAX_SCRIPT_TEMPLATES,
      maxName: MAX_SCRIPT_TEMPLATE_NAME,
      maxDescription: MAX_SCRIPT_TEMPLATE_DESC,
      maxCode: MAX_SCRIPT_CODE,
    };
  }

  function readTemplateInput(payload) {
    const name = singleLineText(payload?.name);
    if (name.length === 0) throw badRequest('模板得先起个名字');
    if (name.length > MAX_SCRIPT_TEMPLATE_NAME) throw badRequest(`模板名最多 ${MAX_SCRIPT_TEMPLATE_NAME} 个字`);
    const description = singleLineText(payload?.description);
    if (description.length > MAX_SCRIPT_TEMPLATE_DESC) throw badRequest(`模板说明最多 ${MAX_SCRIPT_TEMPLATE_DESC} 个字`);
    const code = typeof payload?.code === 'string' ? payload.code : '';
    if (code.trim().length === 0) throw badRequest('模板里得有点脚本代码');
    if (code.length > MAX_SCRIPT_CODE) throw badRequest(`脚本最多 ${MAX_SCRIPT_CODE} 个字符`);
    return { name, description, code };
  }

  /** 新建（id 省略）或覆盖（带 id）一个模板；同一个人不允许两个同名模板。 */
  function saveScriptTemplate({ viewer, id = null, payload } = {}) {
    const user = templateViewer(viewer);
    const { name, description, code } = readTemplateInput(payload);
    const at = now();
    const targetId = Number.isInteger(id) && id > 0 ? id : null;
    const clash = queries.scriptTemplateIdOfName(user.id, name);
    if (targetId === null) {
      if (queries.countScriptTemplatesOfUser(user.id) >= MAX_SCRIPT_TEMPLATES) {
        throw badRequest(`脚本模板最多 ${MAX_SCRIPT_TEMPLATES} 个，先删掉几个再存`);
      }
      if (clash) throw new HttpError(409, 'conflict', `你已经有一个叫「${name}」的模板了`);
      queries.insertScriptTemplate({ userId: user.id, name, description, code, now: at });
      const created = queries.scriptTemplateIdOfName(user.id, name);
      return { template: { id: Number(created?.id ?? 0), name, description, code, createdAt: at, updatedAt: at } };
    }
    const row = queries.scriptTemplateOf({ id: targetId, userId: user.id });
    if (!row) throw new HttpError(404, 'not_found', '没有这个模板');
    if (clash && Number(clash.id) !== targetId) throw new HttpError(409, 'conflict', `你已经有一个叫「${name}」的模板了`);
    queries.updateScriptTemplate({ id: targetId, userId: user.id, name, description, code, now: at });
    return { template: { id: targetId, name, description, code, createdAt: Number(row.created_at), updatedAt: at } };
  }

  function deleteScriptTemplate({ viewer, id } = {}) {
    const user = templateViewer(viewer);
    const row = queries.scriptTemplateOf({ id, userId: user.id });
    if (!row) throw new HttpError(404, 'not_found', '没有这个模板');
    queries.deleteScriptTemplate({ id, userId: user.id });
    return { deleted: Number(id) };
  }

  /* ---------------- 帖子功能下线：一次性迁移 ---------------- */

  /** 站务公告原来挂在哪个板块上（`src/core/open-db-support.js` 的种子数据）。 */
  const ANNOUNCE_BOARD_SLUG = 'meta';

  /**
   * 上一版主页种子产出的块（统计写成沙箱脚本、标签 / 置顶 / 帖子 / 动态是 `list` 来源块、
   * 外加四个小标题）。它们长什么样只有我那版种子会这样拼，所以迁移时能放心换掉。
   */
  const OLD_PROFILE_HEADINGS = ['我的标签', '积木贴置顶推荐', '发表过的积木贴', '发表过的动态'];
  function isOldProfileSeedBlock(block) {
    const type = String(block?.type ?? '');
    const props = block?.props ?? {};
    if (type === 'list' && String(props.source?.kind ?? '').startsWith('profile-')) return true;
    if (type === 'app' && String(props.app ?? '') === PROFILE_STATS_APP) return true;
    if (type === 'heading') {
      const text = String(props.text ?? '').trim();
      return OLD_PROFILE_HEADINGS.some((label) => text.includes(label));
    }
    return false;
  }

  /**
   * 需求 1/2：个人主页一律变成积木页 —— **读到谁的主页就把谁的那份变成积木**（幂等）。
   *
   * 为什么是「读到才做」而不是「启动时全库扫一遍」：建文档要建影子行，建影子行会惰性创建
   * 「积木」板块（`anchor.js` 的 `ensureAnchorBoard`），而「系统板块只在真的建了文档时才出现」
   * 是骨架的硬纪律（`scripts/doc-smoke.mjs` 开头就写着，`check-golden` 的 `/api/site` 也认它）。
   * 启动时给所有人补主页 = 空库里凭空多出一个板块。所以走 `#/u/:name` 那条路时按需做，
   * 和「打开一页 wiki：有就返回，没有就当场建」同一个套路。
   *
   * 三种情况：
   *   1. 还没有主页文档 → 按种子建一份（名片 / 数据统计 / 我的标签 / 置顶推荐 /
   *      发表过的积木贴 / 发表过的动态）。
   *   2. 主页是上一版种子建的（统计块还是沙箱脚本、标签列表是 `list` 来源块）→ 换成新六块。
   *      只在这些块**全部**是我那版种子产出的东西时才重排，绝不碰用户自己写的块。
   *   3. 主页有自己的内容（比如站长那篇 paragraph / quote / app 时钟）→ 原样留着，
   *      只在缺名片时补名片、缺那五块数据块时补它们 —— 一个字都不删。
   */
  function profileSeedList() {
    return profileSeedBlocks().map((block) => ({ type: block.type, version: block.version ?? 1, props: block.props }));
  }

  /** 第 2、3 种情况：把一篇已有的主页文档补成积木主页。已经是了就不动，返回要不要写。 */
  function upgradeProfileDocument(documentId, userId) {
    const blocks = readBlocks(documentId);
    // 已经有新的数据块了 → 这一篇已经是积木主页，不动。
    if (blocks.some((block) => PROFILE_DATA_APPS.includes(String(block.props?.app ?? '')))) return false;
    const seed = profileSeedList();
    const card = blocks.find((block) => isProfileCard(block));
    const rest = blocks.filter((block) => String(block.block_id) !== String(card?.block_id ?? ''));
    // 只有「整篇都是我上一版种子拼出来的」才整篇换掉；不然用户自己写的块一律留着。
    const keep = rest.every(isOldProfileSeedBlock) ? [] : rest.map((block) => ({ type: block.type, version: block.version ?? 1, props: block.props }));
    const at = now();
    const list = [...seed.slice(0, 1), ...keep, ...seed.slice(1)].map((block, index) => ({ ...block, block_id: `b${index + 1}` }));
    writeBlocks(documentId, list, at);
    snapshot(documentId, 'import', userId, at);
    syncDocumentAnchor(mustExist(documentId), at);
    return true;
  }

  /** 第 1 种情况：还没有主页文档就按种子建一份（走 `createDocument`，影子行与板块都由它按规矩建）。 */
  function createProfileDocument(user) {
    const userId = Number(user.id);
    const label = String(user.display_name ?? user.username ?? '').trim() || `用户 ${userId}`;
    const made = createDocument({ viewer: { id: userId, role: 'user' }, kind: 'profile', title: `${label} 的主页`, reason: 'import' });
    return mustExist(Number(made?.doc?.id));
  }

  /**
   * 给「还没有积木的活帖」各补一篇积木（幂等：补过一次下次就查不到了）。
   *
   * 帖子功能下线后，`#/post/:id` 一律重定向到对应积木 —— 那么没有积木的老帖
   * 就没有去处了。这个函数把这类帖子一次性补成积木：**帖子本身不动**，
   * 只在上头挂一篇文档（`anchor_post_id` 指着它），于是：
   *   - 旧的点赞 / 收藏 / 回复仍然认那篇影子帖，一样能点；
   *   - `#/post/:id` 反查到文档，把人送到 `#/doc/:id`。
   *
   * 几处刻意的选择：
   *   - **不调 `createAnchor` / `syncAnchor`**：帖子就是锚点本身，再建一条影子帖
   *     会多出一篇空帖；`syncAnchor` 还会拿积木正文覆盖原帖正文。
   *   - `hidden` 的帖子迁成 `scope='private'`：那是版务藏起来的内容，
   *     不能因为换了个壳就又出现在广场上。
   *   - `meta` 板块的帖子（站务公告）迁成 `template='announce'`，
   *     从此一条公告 = 一篇积木，且只有站长和管理员能改。
   *   - 时间沿用原帖的，公告列表的「按发布时间」才不会乱。
   *
   * 单篇失败只跳过它自己（在启动路径上，一条坏数据不该拦住整个服务起来）。
   */
  function migrateLegacyPosts() {
    const posts = queries.postsMissingDocument();
    const skipped = [];
    let created = 0;
    for (const post of posts) {
      try {
        const createdAt = Number(post.created_at) || now();
        const at = Number(post.updated_at) || createdAt;
        const source = String(post.content ?? '');
        const list = markdownToBlocks(source).map((block, index) => ({ ...block, block_id: `b${index + 1}` }));
        assertBudget(list.length);
        const title = normalizeTitle(post.title) || `帖子 #${post.id}`;
        const isAnnounce = String(post.board_slug ?? '') === ANNOUNCE_BOARD_SLUG;
        const id = queries.insertDocument({
          userId: Number(post.user_id),
          kind: 'post',
          title,
          scope: post.hidden ? 'private' : 'public',
          template: isAnnounce ? ANNOUNCE_TEMPLATE : '',
          anchorPostId: Number(post.id),
          now: at,
          createdAt,
          updatedAt: at,
        });
        writeBlocks(id, list, at);
        // `reason: 'import'` —— 这不是人写的修订，是搬过来的。
        snapshot(id, 'import', Number(post.user_id), at);
        created += 1;
      } catch (error) {
        skipped.push({ postId: Number(post.id), message: error?.message ?? String(error) });
      }
    }
    if (created || skipped.length) {
      console.log(`[doc] 老帖迁移：新建 ${created} 篇积木${skipped.length ? `，跳过 ${skipped.length} 篇` : ''}`);
      for (const item of skipped) console.warn(`[doc] 老帖 #${item.postId} 迁移失败：${item.message}`);
    }
    return { created, skipped };
  }

  return {
    listDocuments,
    reorderAnnouncements,
    getDocument,
    createDocument,
    updateDocument,
    enterDraft,
    publishDocument,
    deleteDocument,
    addBlock,
    updateBlock,
    deleteBlock,
    moveBlock,
    reorderBlocks,
    runOps,
    getMarkdown,
    putMarkdown,
    previewMarkdown,
    putSettings,
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
    adoptDerived,
    listCapabilityLogs,
    importNote,
    getNoteDocument,
    getProfileDocument,
    getProfileStats,
    getWikiPage,
    openWikiPage,
    wikiNav,
    setWikiMeta,
    listStations,
    getStation,
    createStation,
    createStationPage,
    moveStationPage,
    searchStation,
    ensurePagesAttached,
    getPollState,
    votePoll,
    anchorPostIdOf,
    documentByAnchorFor,
    listTags,
    listScriptTemplates,
    saveScriptTemplate,
    deleteScriptTemplate,
    migrateLegacyPosts,
  };
}
