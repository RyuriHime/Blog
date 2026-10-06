// 快速验证新的 core 骨架能不能独立把库建起来、表建全、种子灌进去。
// 用法：node docs/tools/check-core-boot.mjs
import { existsSync, rmSync } from 'node:fs';
import { openDatabase } from '../../src/db.js';
import { schemas } from '../../src/core/table.js';

const file = 'data/core-boot-check.db';
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(file + suffix)) rmSync(file + suffix);
}

const { db, seeded } = openDatabase(file);

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all()
  .map((row) => row.name);

const expected = [
  'boards',
  'bookmarks',
  'blocks',
  'coins',
  'follows',
  'messages',
  'moderation_logs',
  'notifications',
  'posts',
  'profile_categories',
  'reactions',
  'replies',
  'reposts',
  'sessions',
  'users',
];

console.log(`建表 ${tables.length} 张：${tables.join(', ')}`);
const missing = expected.filter((name) => !tables.includes(name));
const extra = tables.filter((name) => !expected.includes(name));
console.log(`缺少：${missing.length ? missing.join(', ') : '（无）'}`);
console.log(`多余：${extra.length ? extra.join(', ') : '（无）'}`);

console.log(`schemas.names() = ${schemas.names().length} 张：${schemas.names().join(', ')}`);
console.log(`播种：${JSON.stringify(seeded)}`);
console.log(`users=${db.prepare('SELECT COUNT(*) AS n FROM users').get().n}`);
console.log(`posts=${db.prepare('SELECT COUNT(*) AS n FROM posts').get().n}`);
console.log(`replies=${db.prepare('SELECT COUNT(*) AS n FROM replies').get().n}`);

db.close();
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(file + suffix)) rmSync(file + suffix);
}

if (missing.length) process.exit(1);
console.log('\n✅ core 骨架能独立建库、建全 17 张表并完成播种');
