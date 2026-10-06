// team 模块自己的**守卫式迁移**。
//
// 为什么需要这里：`src/core/open-db-support.js` 的 `migrate()` 只管 core 自己的表
// （users / posts / notifications）。本模块的表靠两条路演进 ——
//   1. 纯新增表：`CREATE TABLE IF NOT EXISTS` 每次开库自动补（`team_files` / `team_messages` /
//      `team_join_requests` 就是这条路，一行迁移都不用写）；
//   2. 给**已存在**的表加列：`CREATE TABLE IF NOT EXISTS` 对已经建好的表完全不生效，
//      只能在开库之后 `ALTER TABLE`；
//   3. 改**已存在**表的约束（CHECK 之类）：约束改不了，只能按新 DDL 重建表再搬数据
//      （`ensureTeamJoinPolicy`，照抄 `src/modules/doc/migrate.js` 那套）。
//
// 「团队号 + 团队公告」那一轮是第 2 种：四列全是加法，没有重建表、没有搬数据。
// 「申请加入 + 团队广场开关」这一轮是 2 + 3 种：加 `listed` 列，
// 并把 `join_policy` 的 CHECK 从 `('open','invite')` 换成 `('open','apply')`。
import { ensureColumn } from '../../core/open-db-support.js';
import { randomJoinCode } from './join-code.js';
import { teamTableDdl } from './schema.js';

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

/**
 * 把一条 DDL 里指向 `teams_old` 的外键改回 `teams`。
 *
 * `ALTER TABLE ... RENAME TO` 改写别的表里的 REFERENCES 时，写进去的是**带双引号的**
 * 新表名（`"teams_old"`）；但旧版本的 SQLite 或手写的 DDL 也可能是裸名字，
 * 所以两种都换掉。
 */
function fixTeamsReferences(sql) {
  return String(sql).replace(/"teams_old"/g, 'teams').replace(/\bteams_old\b/g, 'teams');
}

/** 把 `CREATE TABLE ... <原名>` 换成 `CREATE TABLE ... <新名>`，列定义一个字不动。 */
function renameTableInDdl(ddl, as) {
  return ddl.replace(
    /^(\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?)(["[`]?)[A-Za-z_][\w$]*\2/i,
    (match, prefix, quote) => `${prefix}${quote}${as}${quote}`,
  );
}

/**
 * **自愈**：把「外键被改写成 `teams_old`」的表按它自己的 DDL 重建一遍。
 *
 * 为什么需要它：`ensureTeamJoinPolicy` 早期版本用 `ALTER TABLE teams RENAME TO teams_old`
 * 来重建 teams，而 SQLite ≥ 3.25 在 `PRAGMA legacy_alter_table = OFF`（默认）下会顺手把
 * 其它表 DDL 里的 `REFERENCES teams(id)` 改写成 `REFERENCES "teams_old"(id)`。
 * 旧表随后被 DROP，这六张子表（team_members / team_posts / team_replies / team_files /
 * team_messages / team_join_requests）就指向了一个不存在的表 —— 之后任何一次写入都报
 * `no such table: main.teams_old`，表现为「用团队号加入 / 发帖 / 退队 / 群聊 / 传文件 / 回复」
 * 清一色 500。已经跑过那段迁移的库（本地与线上）都得靠这里救回来。
 *
 * 为什么要重建、而不是直接改 `sqlite_master`：node:sqlite 开库时用的是防御模式，
 * `PRAGMA writable_schema = ON` 设不进去（读回来还是 0），`UPDATE sqlite_master` 会当场报
 * 「table sqlite_master may not be modified」。重建表是纯 DDL + 数据搬运，没有这个限制，
 * 而且搬完数据由 SQLite 自己重算外键图 —— 比手改 schema 文本可靠。
 *
 * 幂等：库里没有 `teams_old` 的影子时一行都不动，修完再启动也不会重跑。
 */
function repairTeamsReferences(db) {
  const broken = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE '%teams_old%' ORDER BY name ASC")
    .all()
    .map((row) => String(row.name));
  if (broken.length === 0) return;

  rebuildTables(db, broken, fixTeamsReferences);

  // 修完必须验一遍：这里问的是 SQLite 自己重算出来的外键图，不是我们对字符串的判断。
  const problems = db.prepare('PRAGMA foreign_key_check').all();
  if (problems.length > 0) {
    throw new Error(`[team] 修完 teams_old 外键后仍然对不上：${JSON.stringify(problems)}`);
  }
}

/**
 * 按每张表**当前存着的** DDL 重建它们（只把 DDL 交给 `mapSql` 改一改）。
 *
 * 为什么要用存着的 DDL、而不是从 `schema.js` 里摘：这里修的可能是「当前代码已经不再
 * 生成、但线上还活着」的形状；照抄现状再定点改一处，比按新 DDL 重建安全得多
 * （新 DDL 里可能已经有了这表当时还没有的列）。
 *
 * 三步是「先建临时表 → 搬数据 → 删旧表 → 改名」，**不是**「先把旧表改名」：
 * 先改名就会踩到上面那个 REFERENCES 改写的坑，而先建新表的话，
 * 改名时旧名字已经不存在，没有任何表引用它，SQLite 无从改写。
 * 保险起见仍然显式关掉 `legacy_alter_table` 的默认改写行为。
 */
function rebuildTables(db, tables, mapSql) {
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('PRAGMA legacy_alter_table = ON');
  try {
    db.exec('BEGIN');
    for (const table of tables) {
      const temp = `${table}__repaired`;
      const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
      const indexes = db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL")
        .all(table)
        .map((item) => mapSql(String(item.sql)));
      db.exec(`DROP TABLE IF EXISTS ${temp}`);
      db.exec(renameTableInDdl(mapSql(String(row?.sql ?? '')), temp));
      db.exec(`INSERT INTO ${temp} SELECT * FROM ${table}`);
      db.exec(`DROP TABLE ${table}`);
      db.exec(`ALTER TABLE ${temp} RENAME TO ${table}`);
      // 索引跟着表一起被 DROP 带走了，重建完再补回来。
      for (const index of indexes) db.exec(index);
    }
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

/**
 * 重建 `teams`，把 `join_policy` 的 CHECK 从 `('open','invite')` 换成 `('open','apply')`。
 *
 * CHECK 是刻在表结构里的，改它只有一条路：按新 DDL 建一张新表、把数据搬过去、换回原名。
 * 老库里的 `invite` 语义与新库的 `apply` 是同一条（「不是谁想进就能进，得有人批」），
 * 所以搬数据时把它翻译成 `apply` —— 线上那几个「需要邀请」的团队设置不会丢。
 *
 * 三个容易踩的点（`src/modules/doc/migrate.js` 那份是同一个套路）：
 *   1) `PRAGMA foreign_keys = OFF` 必须在 `BEGIN` **之前**：PRAGMA 在事务里改不动。
 *   2) **顺序必须是「先建新表 → 搬数据 → 删旧表 → 把新表改名」**，不能先把 teams 改名成
 *      `teams_old`。SQLite ≥ 3.25 在 `PRAGMA legacy_alter_table = OFF`（默认）下会顺手把
 *      别的表 DDL 里的 `REFERENCES teams(id)` 改写成指向新名字，而旧表下面就要被 DROP ——
 *      六张子表（team_members / team_posts / team_replies / team_files / team_messages /
 *      team_join_requests）于是全部指向 `teams_old`，之后任何写入都报
 *      `no such table: main.teams_old`。这个改写只看 `legacy_alter_table`，
 *      **与 `foreign_keys` 无关**（老注释写反了，害过一次线上故障，已由
 *      `repairTeamsReferences` 兜底修复）。先建新表就没有旧名字可被引用，改写无从发生。
 *   3) 索引被 DROP 带走，所以先把它们的 SQL 抓在手里，等新表改名成 teams 之后再逐条重跑。
 */
function ensureTeamJoinPolicy(db) {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'teams'")
    .get();
  const sql = String(row?.sql ?? '');
  // 开库本身就是 CREATE TABLE IF NOT EXISTS：表不存在说明它是刚按新 DDL 建的；
  // 语句里已经带 `'apply'` 说明它要么是新库、要么重建过。两种都不用管。
  if (sql === '' || sql.includes("'apply'")) return;

  const before = db.prepare('PRAGMA table_info(teams)').all().map((column) => String(column.name));
  const indexes = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'teams' AND sql IS NOT NULL")
    .all()
    .map((item) => String(item.sql));

  const temp = 'teams__rebuilt';
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('PRAGMA legacy_alter_table = ON');
  try {
    db.exec('BEGIN');
    db.exec(`DROP TABLE IF EXISTS ${temp}`);
    // 新表用同一份 DDL，只换个名字；建好之后再问一次列名：搬数据只搬「两边都有」的列。
    // 老库没有 `listed`（本轮新加的），它就静静地拿新表的默认值 1 —— 团队照旧出现在广场上。
    db.exec(teamTableDdl('teams', temp));
    const after = db.prepare(`PRAGMA table_info('${temp}')`).all().map((column) => String(column.name));
    const columns = after.filter((name) => before.includes(name));
    const read = (name) =>
      name === 'join_policy' ? "CASE WHEN join_policy = 'invite' THEN 'apply' ELSE join_policy END" : name;
    db.exec(
      `INSERT INTO ${temp} (${columns.join(', ')})
       SELECT ${columns.map(read).join(', ')} FROM teams`,
    );
    db.exec('DROP TABLE teams');
    db.exec(`ALTER TABLE ${temp} RENAME TO teams`);
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
export function migrateTeamTables(db) {
  // 第一件事是自愈：老版本那段「先改名再重建」在库里留下的 `teams_old` 外键要先修掉，
  // 否则下面每一步碰这些子表都会 500（而且它们本来也写不进去）。
  repairTeamsReferences(db);

  ensureColumn(db, 'teams', 'join_code', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'teams', 'announcement', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'teams', 'announcement_by', 'INTEGER');
  ensureColumn(db, 'teams', 'announcement_at', 'INTEGER');

  // 建约束这一步放在加列之后：重建时搬数据要能看见上面那几列。
  ensureTeamJoinPolicy(db);
  // 重建过的库这里已经带着 `listed` 了（新 DDL 里就有），这一行是给「表已重建、
  // 但列是后来才加的」那种中间状态兜底；新库上它是空转。
  ensureColumn(db, 'teams', 'listed', 'INTEGER NOT NULL DEFAULT 1');

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
