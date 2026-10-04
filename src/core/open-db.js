// @hand-written 由 docs/tools/extract-server-modules.mjs 生成过一次，之后手工整理。
// 建库实现（从 src/db.js 原样搬过来的 openDatabase 函数体）。
//
// 这是预铺骨架里唯一一处「函数体搬家」：因为 src/core/database.js 要在建表时
// 把写死的 SCHEMA 换成 schemas.toSql()，而 ESM 的 re-export 没有办法注入新形参，
// 所以函数体必须离开 src/db.js。搬过来只改了两行：
//   - 第一行 `db.exec(SCHEMA)` → `db.exec(schemas.toSql())`
//   - 形参多一个 `schemas`
// 其余（WAL / 外键 / busy_timeout / migrate / 播种判据 / 六个回填）逐字未动。
//
// 这里对 src/db.js 有一个**刻意的循环 import**：
//   src/db.js  →  src/core/open-db.js   （为了继续导出 openDatabase）
//   src/core/open-db.js  →  src/db.js   （为了拿 migrate / seed / backfill*）
// 这是安全的：两边互相引用的都是**函数声明**（有提升），而且真正调用发生在
// 两个模块都求值完之后（建库发生在启动时，不是模块求值时）。
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  SEED_BOARDS,
  SEED_USERS,
  backfillDemoAvatars,
  backfillDemoMessages,
  backfillDemoSocial,
  backfillNotifications,
  backfillProfileExtras,
  backfillReposts,
  migrate,
  seed,
} from '../db.js';

/**
 * 打开（必要时创建）数据库并完成建表 / 迁移 / 首次播种。
 * @param {string} file 数据库文件路径，':memory:' 表示内存库（测试用）
 * @param {{ toSql: () => string }} schemas 建表登记处（见 src/core/table.js）
 */
export function openDatabase(file, schemas) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(schemas.toSql());
  migrate(db);

  const { count } = db.prepare('SELECT COUNT(*) AS count FROM boards').get();
  let seeded = null;
  if (Number(count) === 0) {
    seed(db);
    seeded = { boards: SEED_BOARDS.length, users: SEED_USERS.length };
  } else {
    backfillDemoSocial(db);
  }
  const notifications = backfillNotifications(db);
  const profileExtras = backfillProfileExtras(db);
  const reposts = backfillReposts(db);
  const avatars = backfillDemoAvatars(db);
  const messages = backfillDemoMessages(db);

  return { db, seeded, notifications, profileExtras, reposts, avatars, messages };
}
