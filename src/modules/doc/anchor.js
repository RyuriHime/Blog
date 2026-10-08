// 影子行（互动锚点）—— 让既有互动链路原封不动地服务文档。
//
// 为什么需要它：赞 / 踩 / 收藏 / 通知 / 个人主页置顶
// 全部认 `posts.id`。文档有独立身份（`#/doc/:id`），如果不留锚点，
// 这几条链路每一个都要新写一遍（还要重跑 check-golden 的指纹）。
// 留一条「影子行」= 零改动复用，代价见下面第 3 条。
//
// 三条实测出来的硬约束（改这个文件前先读）：
//
// 1. 锚点必须 `deleted = 0`。
//    赞/踩走 `store.postById`（src/store.js 的 `WHERE p.id = ? AND p.deleted = 0`），
//    收藏同样走 `postById`。`deleted = 1` 的影子行互动接口一律找不到。
//
// 2. 而 `deleted = 0` 的行**必然**被所有帖子列表收录
//    （`src/store.js` 的 `buildFilter()` 第一句就是 `p.deleted = 0`）。
//    所以锚点只能靠 `hidden` 把自己藏起来，而 `hidden` 的语义是
//    「非 staff 非作者 404」（src/core/guards.js 的 `assertPostVisible`）。
//
// 3. => **已知短板**：`followers` / `team` 可见的文档，关注者点不了赞（会 404）。
//    core 的互动接口只认 `hidden`，不认文档的可见范围。本轮不动 core，
//    两条备选（改 core / 非公开档不做外部互动）记在设计文档 §2.5 里。
//    作者和 staff 不受影响（`assertPostVisible` 放行这两类人）。
import {
  DOC_BOARD_DESCRIPTION,
  DOC_BOARD_ICON,
  DOC_BOARD_NAME,
  DOC_BOARD_SLUG,
  DOC_BOARD_SORT,
} from './schema.js';

/**
 * 系统板块的 id，不存在就建（幂等）。
 *
 * 注意 `boards` 表**没有 `created_at` 列**（设计文档 §2.5 的示例 SQL 里有，
 * 那是错的；以 src/core/tables.sql.js 为准）。所以这里只写五列。
 */
export function ensureAnchorBoard(db) {
  db.prepare('INSERT OR IGNORE INTO boards (slug, name, description, icon, sort_order) VALUES (?, ?, ?, ?, ?)').run(
    DOC_BOARD_SLUG,
    DOC_BOARD_NAME,
    DOC_BOARD_DESCRIPTION,
    DOC_BOARD_ICON,
    DOC_BOARD_SORT,
  );
  const row = db.prepare('SELECT id FROM boards WHERE slug = ?').get(DOC_BOARD_SLUG);
  return Number(row?.id ?? 0);
}

/** 锚点行要不要对外隐藏：只有 `public` 文档的影子行能被旧列表看见。 */
export function anchorHidden(scope) {
  return scope === 'public' ? 0 : 1;
}

/**
 * wiki 站的页**不**出现在「积木」板块列表里（§6.1：一个帖子一个 wiki，页是站里的块）。
 *
 * 页照样要留影子行（赞 / 收藏 / 通知认 `posts.id`），但列表查询对**所有人**
 * 都滤掉 `hidden = 1`（`src/store.js:426`），所以把页的影子行藏起来正好是我们要的效果，
 * 而且一行 core 都不用改。
 */
export const STATION_PAGE_HIDDEN = 1;

/**
 * 建一条影子行，返回它的 posts.id。
 *
 * `hidden` 传 `null`（默认）= 按 scope 自动算；传 `1` = 强制藏起来 ——
 * 「从没发布过的草稿」要它：那篇的 scope 通常就是 `public`，不藏的话
 * `anchorHidden('public')` 会给 0，一条还没发布的草稿的影子行就漏进动态流和板块列表了。
 */
export function createAnchor(db, { userId, title, content, scope, now, hidden = null }) {
  const boardId = ensureAnchorBoard(db);
  const result = db
    .prepare(
      `INSERT INTO posts (board_id, user_id, title, content, views, pinned, locked, deleted, hidden, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, 0, 0, 0, ?, ?, ?)`,
    )
    .run(boardId, userId, title, content, hidden === null || hidden === undefined ? anchorHidden(scope) : (hidden ? 1 : 0), now, now);
  return Number(result.lastInsertRowid);
}

/**
 * 同步影子行。**只改真的变了的列**：`views` / `pinned` 这些是旧链路的财产，
 * 每次保存都重写一遍会把用户的置顶和阅读数抹掉。
 */
export function syncAnchor(db, anchorId, { title, content, scope, deleted, now, hidden = null }) {
  if (!anchorId) return;
  db.prepare('UPDATE posts SET title = ?, content = ?, hidden = ?, deleted = ?, updated_at = ? WHERE id = ?').run(
    title,
    content,
    hidden === null || hidden === undefined ? anchorHidden(scope) : (hidden ? 1 : 0),
    deleted ? 1 : 0,
    now,
    anchorId,
  );
}

/** 影子行还在不在（导出/调试用）。 */
export function anchorRow(db, anchorId) {
  if (!anchorId) return null;
  return db.prepare('SELECT id, board_id, user_id, title, content, hidden, deleted FROM posts WHERE id = ?').get(anchorId);
}
