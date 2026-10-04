/** 清空并重新播种数据库：node scripts/reset-db.mjs */
import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db.js';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const DB_FILE = process.env.DB_FILE || join(ROOT, 'data', 'forum.db');

for (const suffix of ['', '-wal', '-shm']) {
  rmSync(DB_FILE + suffix, { force: true });
}
const { seeded } = openDatabase(DB_FILE);
console.log(`已重建数据库：${DB_FILE}`);
console.log(seeded ? `已写入 ${seeded.boards} 个板块 / ${seeded.users} 个示例用户` : '（空库）');
