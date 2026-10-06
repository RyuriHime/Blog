// doc 模块自己的**守卫式迁移**。
//
// 为什么需要这里：`src/core/open-db-support.js` 的 `ensureColumn` 只覆盖 core 的两张表
// （`users` / `posts`），doc 的表靠两条路演进来 ——
//   1. 纯新增表：`CREATE TABLE IF NOT EXISTS` 每次开库自动补，什么都不用写；
//   2. 改**已存在**表的约束：只能重建表，就是本文件干的事。
//
// 重建表有一条纪律：用 `schema.js` 里那份 DDL（`docTableDdl`），不许抄第二遍。
// 第二条纪律：**不许把旧表改名**（`RENAME TO …_old`）—— SQLite 会顺手改写别的表里的
// `REFERENCES`，见下面 `ensureAdoptRevisionReason` 里的注释。正确顺序是「先建新表 → 搬 → 删旧 → 改名」。
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
  //
  // `legacy_alter_table = ON` 是**必须**的：SQLite 3.25+ 的 `ALTER TABLE … RENAME TO`
  // 会顺手改写其它表 DDL 里的 `REFERENCES`，这条开关才是决定因素（默认 OFF），
  // 跟 `foreign_keys` 一点关系都没有 —— 团队那边就因为误信「关外键就没事」把六张子表
  // 指向了一张被删掉的 `teams_old`，线上 500 了一次（详见 README 里那段）。
  // 这条迁移今天还没有子表引用 `document_revisions`，但别等有了再踩。
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('PRAGMA legacy_alter_table = ON');
  try {
    db.exec('BEGIN');
    // 顺序：先建临时名字的新表 → 搬数据 → 删旧表 → 把新表改名回来。
    // 反过来（先把旧表改成 `document_revisions_old`）会改写别的表的 REFERENCES，见上。
    const temp = 'document_revisions__rebuilt';
    db.exec(`DROP TABLE IF EXISTS ${temp}`);
    db.exec(docTableDdl('document_revisions', temp));
    db.exec(
      `INSERT INTO ${temp} (id, document_id, revision, blocks_json, reason, author_id, created_at)
       SELECT id, document_id, revision, blocks_json, reason, author_id, created_at FROM document_revisions`,
    );
    db.exec('DROP TABLE document_revisions');
    db.exec(`ALTER TABLE ${temp} RENAME TO document_revisions`);
    // 索引跟着旧表一起被 DROP 带走 —— 所以重建放在改名之后。
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
    db.exec('PRAGMA legacy_alter_table = OFF');
    db.exec('PRAGMA foreign_keys = ON');
  }
}

/** 开库之后跑一次。每一步都必须**幂等**：它每次启动都会跑。 */
export function migrateDocTables(db) {
  ensureAdoptRevisionReason(db);
}
