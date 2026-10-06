// doc 模块自己的**守卫式迁移**。
//
// 为什么需要这里：`src/core/open-db-support.js` 的 `ensureColumn` 只覆盖 core 的两张表
// （`users` / `posts`），doc 的表靠两条路演进来 ——
//   1. 纯新增表：`CREATE TABLE IF NOT EXISTS` 每次开库自动补，什么都不用写；
//   2. 改**已存在**表的约束：只能重建表，就是本文件干的事。
//
// 重建表有一条纪律：用 `schema.js` 里那份 DDL（`docTableDdl`），不许抄第二遍。
import { docTableDdl } from './schema.js';

/** 重建 `document_revisions`，让 `reason` 的 CHECK 允许 `adopt`（脚本产出被采纳为真块）。 */
function ensureAdoptRevisionReason(db) {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'document_revisions'")
    .get();
  const sql = String(row?.sql ?? '');
  // 开库本身就是 CREATE TABLE IF NOT EXISTS：表在就说明它是**旧形状**，表不在就不用管
  // （`doc` 的建表脚本刚刚按新 DDL 建好了）。
  if (sql === '' || sql.includes("'adopt'")) return;

  const indexes = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'document_revisions' AND sql IS NOT NULL")
    .all()
    .map((item) => String(item.sql));

  // PRAGMA 在事务里改不动，所以必须在 BEGIN 之前设。
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    db.exec('ALTER TABLE document_revisions RENAME TO document_revisions_old');
    db.exec(docTableDdl('document_revisions'));
    db.exec(
      `INSERT INTO document_revisions (id, document_id, revision, blocks_json, reason, author_id, created_at)
       SELECT id, document_id, revision, blocks_json, reason, author_id, created_at FROM document_revisions_old`,
    );
    // 索引跟着表一起被 RENAME 带走，DROP 又把它删掉 —— 所以重建放在 DROP 之后。
    db.exec('DROP TABLE document_revisions_old');
    for (const index of indexes) db.exec(index);
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 回滚本身失败说明连接已经坏了，抛原来那个错更有用。
    }
    throw error;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

/** 开库之后跑一次。每一步都必须**幂等**：它每次启动都会跑。 */
export function migrateDocTables(db) {
  ensureAdoptRevisionReason(db);
}
