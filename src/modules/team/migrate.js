// team 模块自己的**守卫式迁移**。
//
// 为什么需要这里：`src/core/open-db-support.js` 的 `migrate()` 只管 core 自己的表
// （users / posts / notifications）。本模块的表靠两条路演进 ——
//   1. 纯新增表：`CREATE TABLE IF NOT EXISTS` 每次开库自动补（`team_files` / `team_messages`
//      那一轮就是这么加的，一行迁移都不用写）；
//   2. 给**已存在**的表加列：`CREATE TABLE IF NOT EXISTS` 对已经建好的表完全不生效，
//      只能在开库之后 `ALTER TABLE` —— 就是本文件干的事。
//
// 「团队号 + 团队公告」这一轮是第 2 种：四列全是加法，没有重建表、没有搬数据。
import { ensureColumn } from '../../core/open-db-support.js';
import { randomJoinCode } from './join-code.js';

/**
 * 老库里的团队在第一次启动时补一个团队号。
 *
 * 新库不用走这里：建队时 `routes.js` 就把号一起插进去了。这一步存在的唯一理由是
 * **线上已经有的那些团队** —— 它们建表时还没有 `join_code` 列，补列之后全是空串，
 * 不补号的话它们的成员在页面上看到的是「团队号：空」。
 *
 * 幂等：只有空串的行会被处理，第二次启动时一行都不剩。
 */
function backfillJoinCodes(db) {
  const rows = db
    .prepare("SELECT id FROM teams WHERE join_code = '' OR join_code IS NULL ORDER BY id ASC")
    .all();
  if (rows.length === 0) return;

  const taken = new Set(
    db
      .prepare("SELECT join_code FROM teams WHERE join_code <> ''")
      .all()
      .map((row) => String(row.join_code)),
  );
  const update = db.prepare('UPDATE teams SET join_code = ? WHERE id = ?');
  for (const row of rows) {
    let code = '';
    for (let attempt = 0; attempt < 40; attempt += 1) {
      code = randomJoinCode();
      if (!taken.has(code)) break;
      code = '';
    }
    if (!code) throw new Error('[team] 回填团队号时连续 40 次都撞号，请检查随机数来源');
    taken.add(code);
    update.run(code, row.id);
  }
}

/** 开库之后跑一次。每一步都必须**幂等**：它每次启动都会跑。 */
export function migrateTeamTables(db) {
  ensureColumn(db, 'teams', 'join_code', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'teams', 'announcement', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'teams', 'announcement_by', 'INTEGER');
  ensureColumn(db, 'teams', 'announcement_at', 'INTEGER');

  // 团队号的唯一索引为什么在这里、而不在 `schema.js` 的建表脚本里：
  // 建表脚本每次开库都会先跑一遍，而**老库的 teams 表那时还没有 join_code 列**
  // （列是本函数上面那几行才加的），在脚本里建这个索引会当场报「no such column」。
  // 顺序只能是「先加列、再建索引」，所以它跟着列一起住在这里。
  // 带 `WHERE join_code <> ''` 的部分索引：只约束有号的行 —— 老库回填期间那些还是空串的行
  // 因此可以并存，不需要先把它们编上号才能建索引。
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_teams_join_code ON teams (join_code) WHERE join_code <> ''`,
  );

  backfillJoinCodes(db);
}
