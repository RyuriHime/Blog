/**
 * 清空并重新播种数据库。
 *
 * 这是仓库里**唯一**会删数据的脚本：它直接删掉 DB_FILE（连带 -wal / -shm）再重新播种，
 * 删掉的内容不可恢复（data/ 已在 .gitignore 里，没有别的副本），所以必须显式确认。
 *
 *   node scripts/reset-db.mjs               只列出将要删除的文件，然后退出（不删）
 *   node scripts/reset-db.mjs --yes         确认删除并重新播种
 *   node scripts/reset-db.mjs --yes --db=x.db   换个库（也可以继续用 DB_FILE 环境变量）
 *
 * 想清的是测试库就别用这个脚本：smoke / 契约测试各自用临时库，跑完自己清理。
 */
import { existsSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db.js';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const args = process.argv.slice(2);
const confirmed = args.includes('--yes') || process.env.RESET_DB_CONFIRM === '1';
const dbArg = args.find((arg) => arg.startsWith('--db='));
const DB_FILE = dbArg ? resolve(dbArg.slice('--db='.length)) : process.env.DB_FILE || join(ROOT, 'data', 'forum.db');

const targets = ['', '-wal', '-shm'].map((suffix) => DB_FILE + suffix).filter((file) => existsSync(file));

if (targets.length && !confirmed) {
  console.log('将要删除并重建的数据库：');
  for (const file of targets) console.log(`  · ${file}（${statSync(file).size} 字节）`);
  console.log('');
  console.log('这些文件会被永久删除：用户、帖子、私信全都在里面，删了无法恢复。');
  console.log('确认这就是你要清的库之后，加上 --yes 重跑：');
  console.log('  node scripts/reset-db.mjs --yes');
  process.exit(1);
}

if (targets.length) {
  for (const file of targets) console.log(`已删除 ${file}`);
} else {
  console.log(`没有找到已有的数据库文件（${DB_FILE}），直接新建并播种。`);
}

for (const file of [...targets]) rmSync(file, { force: true });
const { seeded } = openDatabase(DB_FILE);
console.log(`已重建数据库：${DB_FILE}`);
console.log(seeded ? `已写入 ${seeded.boards} 个板块 / ${seeded.users} 个示例用户` : '（空库）');
