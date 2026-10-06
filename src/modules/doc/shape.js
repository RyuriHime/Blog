// doc 模块的对外形状（HTTP 的 `data` 里就是它）。
//
// 与 `src/modules/feed/shape.js` 同一条纪律：只有一个地方把数据库行变成 JSON。
// 列表、详情、创建、回滚四个接口共用这一份 —— 形状有第二份实现，
// 就会有「列表有这个字段、详情没有」这类时好时坏的 bug。
import { DOC_KINDS, DOC_SCOPES } from './schema.js';

/** 可见范围的中文名（必须与 feed 的说法一致）。 */
const SCOPE_LABELS = {
  public: '公开',
  followers: '仅关注我的人',
  team: '仅团队',
  private: '仅自己',
};

/** 文档形态的中文名。 */
const KIND_LABELS = {
  post: '积木帖子',
  note: '笔记',
  profile: '个人主页',
};

/** 修订原因的中文名（Wiki 模板的「修订记录」直接显示它）。 */
const REASON_LABELS = {
  create: '创建',
  edit: '编辑',
  ops: '批量编辑',
  template: '套模板',
  import: '导入',
  rollback: '回滚',
  adopt: '采纳脚本产出',
};

/** `doc_settings` 的默认值（老文档还没有这一行的时候）。 */
const SETTINGS_DEFAULTS = {
  allowScriptWrite: false,
  appMode: 'inline',
  stationId: 0,
  parentId: 0,
  sortOrder: 0,
  icon: '',
};

/**
 * 一行 `doc_settings` → 对外形状（没有行就给默认值）。
 *
 * `sourceText` **不外发**：它只属于编辑器，是 `present()` 里那条单独的 `source` 字段。
 */
export function shapeSettings(row) {
  if (!row) return { ...SETTINGS_DEFAULTS };
  return {
    allowScriptWrite: Boolean(row.allow_script_write),
    appMode: row.app_mode === 'fullpage' ? 'fullpage' : 'inline',
    stationId: Number(row.station_id) || 0,
    parentId: Number(row.parent_id) || 0,
    sortOrder: Number(row.sort_order) || 0,
    icon: String(row.icon ?? ''),
  };
}

/** 一行 `documents`（带作者信息）→ 对外形状。 */
export function shapeDoc(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: DOC_KINDS.includes(row.kind) ? row.kind : 'post',
    kindLabel: KIND_LABELS[row.kind] ?? KIND_LABELS.post,
    title: String(row.title ?? ''),
    scope: DOC_SCOPES.includes(row.scope) ? row.scope : 'public',
    scopeLabel: SCOPE_LABELS[row.scope] ?? SCOPE_LABELS.public,
    template: String(row.template ?? ''),
    anchorPostId: row.anchor_post_id == null ? null : Number(row.anchor_post_id),
    sandboxDisabled: Boolean(row.sandbox_disabled),
    deleted: Boolean(row.deleted),
    author: {
      id: row.user_id,
      username: row.username,
      displayName: row.display_name || row.username,
      avatar: row.avatar ?? null,
      role: row.role ?? 'member',
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    edited: Number(row.updated_at) > Number(row.created_at),
  };
}

/** 列表用的轻形状：不带 blocks / warnings / abilities。 */
export function shapeDocSummary(row) {
  const doc = shapeDoc(row);
  if (!doc) return null;
  return {
    id: doc.id,
    kind: doc.kind,
    kindLabel: doc.kindLabel,
    title: doc.title,
    scope: doc.scope,
    scopeLabel: doc.scopeLabel,
    template: doc.template,
    anchorPostId: doc.anchorPostId,
    author: doc.author,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    edited: doc.edited,
  };
}

/** 一块对外形状（内存里就是这个形状，这里只做一次兜底）。 */
export function shapeBlock(block) {
  return {
    blockId: block.block_id,
    type: block.type,
    version: Number(block.version) || 1,
    props: block.props ?? {},
  };
}

export function shapeBlocks(blocks) {
  return (blocks ?? []).map(shapeBlock);
}

/** 一行 `document_revisions` → 对外形状。 */
export function shapeRevision(row) {
  return {
    revision: Number(row.revision),
    reason: row.reason,
    reasonLabel: REASON_LABELS[row.reason] ?? row.reason,
    authorId: row.author_id,
    author: row.username
      ? { id: row.author_id, username: row.username, displayName: row.display_name || row.username }
      : null,
    createdAt: Number(row.created_at),
  };
}

export { SCOPE_LABELS, KIND_LABELS, REASON_LABELS, SETTINGS_DEFAULTS };
