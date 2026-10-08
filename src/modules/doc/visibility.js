// 可见范围（scope）的判定 —— 一篇文档谁能读、谁能改。
//
// 与 `src/modules/feed/queries.js` 的 `visibilityConditions` **逐条对齐**，
// 但有一个明确的、写在这里的差别，别当成 bug：
//
//   feed 刻意不做 staff 越权（那里的注释原话是「动态是私人内容，
//   管理员能翻别人私密动态是隐私事故」）。而文档要接管理后台
//   （§4.5 的权限矩阵），所以这一版**给 staff 放行**。
//   这是设计文档 §2.6 已经批准的行为；改动它就是改需求，不是修 bug。
//
// 「未登录读非公开」返回 401、「登录了但读不到」返回 404：
// 403 / 401 的区分是验收标准 ⑪，而不可见时必须 404 ——
// 403 会顺带泄露「这篇文档存在」。
import { isStaff } from '../../core/guards.js';
import { ANNOUNCE_TEMPLATE } from './templates.js';

/** `team_members` 表在不在（探测一次，与 feed 同一个技巧）。 */
export function detectTeams(db) {
  return Boolean(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'team_members'").get(),
  );
}

/**
 * 「从没发布过的草稿」：`doc_drafts` 里有一行，但 `published = 0`。
 *
 * 它不是一个更窄的可见范围，而是**还没对外存在**：只有作者本人的草稿箱里看得见。
 * staff 也不放行 —— 站长能翻别人的半成品是隐私事故（feed 里那句注释是同一个道理），
 * 也和「越权一律 404」这条硬约定一致。
 *
 * 判据来自 `queries.js` 的 `DOC_COLUMNS`：没有草稿行时 `draft_document_id` 是 null。
 * 所以老库、以及刚发布完的文档（草稿行已删）天然为假 —— **不需要任何回填**。
 */
export function isPrivateDraft(doc) {
  return Boolean(doc?.draft_document_id) && !doc.draft_published;
}

export function createVisibility({ db, hasTeams }) {
  const follows = db.prepare('SELECT 1 AS hit FROM follows WHERE follower_id = ? AND followee_id = ? LIMIT 1');
  const sameTeam = hasTeams
    ? db.prepare(
        'SELECT 1 AS hit FROM team_members mine JOIN team_members theirs ON theirs.team_id = mine.team_id WHERE mine.user_id = ? AND theirs.user_id = ? LIMIT 1',
      )
    : null;

  /** 这篇文档对这个人可见吗？`doc` 可以是 null（调用方负责转成 404）。 */
  function canView(doc, viewer) {
    if (!doc || doc.deleted) return false;
    // 从没发布过的草稿：只有作者本人的草稿箱里看得见（读者一律 404）。
    if (isPrivateDraft(doc)) return Boolean(viewer) && viewer.id === doc.user_id;
    if (doc.scope === 'public') return true;
    // 非公开：必须先登录。调用方看到 `viewer` 为空时要回 401 而不是 404。
    if (!viewer) return false;
    if (isStaff(viewer)) return true;
    if (viewer.id === doc.user_id) return true;
    if (doc.scope === 'followers') return Boolean(follows.get(viewer.id, doc.user_id));
    if (doc.scope === 'team') return Boolean(sameTeam?.get(viewer.id, doc.user_id));
    return false; // private
  }

  /** 改 / 删 / 套模板 / 回滚：作者或 staff。 */
  function canEdit(doc, viewer) {
    if (!doc || doc.deleted || !viewer) return false;
    // 没发布过的草稿连 staff 也不动：见 isPrivateDraft 的注释。
    if (isPrivateDraft(doc)) return viewer.id === doc.user_id;
    // 站务公告是站方的口子：只有站长和管理员能改。它从「meta 板块的帖子」
    // 迁移过来时作者可能是当年的普通用户，所以这里**不看作者**。
    if (doc.template === ANNOUNCE_TEMPLATE) return isStaff(viewer);
    return isStaff(viewer) || viewer.id === doc.user_id;
  }

  return { canView, canEdit };
}

/**
 * 列表查询用的可见范围 SQL 片段。返回 `{sql, params}` 或 null（staff 不加条件）。
 *
 * 参数顺序只由这里决定，调用方拼装时**必须原样带上 params**，
 * 不许自己数问号 —— feed 的 v1 就是这么出的 500。
 */
export function visibilityConditions(viewer, hasTeams) {
  if (!viewer) return { sql: "d.scope = 'public'", params: [] };
  if (isStaff(viewer)) return null;

  const parts = ['d.scope = ?', 'd.user_id = ?'];
  const params = ['public', viewer.id];
  parts.push("(d.scope = 'followers' AND EXISTS (SELECT 1 FROM follows fo WHERE fo.follower_id = ? AND fo.followee_id = d.user_id))");
  params.push(viewer.id);
  if (hasTeams) {
    parts.push(
      "(d.scope = 'team' AND EXISTS (SELECT 1 FROM team_members mine JOIN team_members theirs ON theirs.team_id = mine.team_id WHERE mine.user_id = ? AND theirs.user_id = d.user_id))",
    );
    params.push(viewer.id);
  }
  return { sql: `(${parts.join(' OR ')})`, params };
}
