// @generated 由 docs/tools/extract-server-modules.mjs 生成，请勿手改。
// 搬运自 src/db.js:888-912 的 openDatabase 函数体（预铺骨架，只改了签名与一行建表调用）。
//
// 依赖方向是单向的：本文件 → ./open-db-support.js。
// 这里**不要**回头 import ../db.js —— 那会和 db.js 形成循环 import，
// 让 ESM 的求值顺序变得难以推理（db.js 为了给老调用方留 openDatabase，也要 import 本文件）。
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { schemas } from './table.js';
import * as support from './open-db-support.js';

export function openDatabase(file, tables = schemas) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec((tables ?? schemas).toSql());
  support.migrate(db);

  const { count } = db.prepare('SELECT COUNT(*) AS count FROM boards').get();
  let seeded = null;
  if (Number(count) === 0) {
    support.seed(db);
    seeded = { boards: support.SEED_BOARDS.length, users: support.SEED_USERS.length };
  } else {
    support.backfillDemoSocial(db);
  }
  const notifications = support.backfillNotifications(db);
  const profileExtras = support.backfillProfileExtras(db);
  const reposts = support.backfillReposts(db);
  const avatars = support.backfillDemoAvatars(db);
  const messages = support.backfillDemoMessages(db);

  return { db, seeded, notifications, profileExtras, reposts, avatars, messages };
}
