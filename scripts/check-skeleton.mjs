/**
 * 骨架自检（spec §5.2 的八条断言）。
 *
 *  1) 五个业务模块目录都在，且导出 name / apiPrefix / owns / reads / install
 *  2) owns 在模块之间不重复（一张表只能有一个主人）
 *  3) 源码里每一段 CREATE TABLE 的表名，都必须被某个模块的 owns 认领
 *  4) 业务模块不许直接连数据库（node:sqlite / DatabaseSync / openDatabase）
 *  5) 业务模块不许互相 import（模块之间只能通过 ctx 说话）
 *  6) src/modules/index.js 是唯一列举业务模块的地方
 *  7) 解耦证明：把任一业务模块目录改名之后，服务器必须**明确报错**（而不是静默启动半残）
 *  8) 反向哨兵：入口文件不许重新长胖（src/server.js ≤ 120 行、public/app.js ≤ 120 行）
 *
 * 用法：node scripts/check-skeleton.mjs
 * 环境变量：SKELETON_PORT 默认 3417
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const MODULES_DIR = join(ROOT, 'src', 'modules');
const PORT = Number(process.env.SKELETON_PORT || 3417);
const BASE = `http://127.0.0.1:${PORT}`;

/** 五块业务模块（core 是论坛本体，不算「并行的五路」）。 */
const BUSINESS = ['feed', 'doc', 'ai', 'team', 'ui'];
/**
 * 骨架期允许「owns 里声明了、但还没建表」的清单 —— 也就是五路各自的表。
 * 它们是各模块施工时才建的（骨架只把名字与归属先冻结下来）。
 * 这张清单**只允许变短**：某块真正落地之后，把它的表从这里删掉，
 * 「owns 里声明的表都真的建了」就自动开始管它了。
 */
const PLANNED_EMPTY = new Set([
  // feed_items / feed_reactions 已由 P1（动态）落地建表，2026-10 从这里移除。
  // documents / document_blocks / document_revisions / doc_block_types
  //   已由 P2（积木帖子）落地建表，2026-10 从这里移除。
  // teams / team_members / team_posts
  //   已由 P4（团队）落地建表，2026-10 从这里移除。
  // 你要是看到这张清单少了什么，说明那块功能已经真的开工了 —— 这是设计如此。
  // ai_capability_grants / ai_op_logs 已由 P3（AI 能力层）落地建表，2026-10 从这里移除。
]);
/** 骨架交付时的入口长度上限。接手后写业务代码请写进模块，不要往入口堆。 */
const MAX_SERVER_LINES = Number(process.env.MAX_SERVER_LINES || 120);
const MAX_APP_LINES = Number(process.env.MAX_APP_LINES || 120);

const problems = [];
const notes = [];
const check = (name, condition, detail = '') => {
  if (condition) notes.push(`  ✅ ${name}`);
  else problems.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

const read = (file) => readFileSync(file, 'utf8');
const SKIP_DIRS = new Set(['.git', 'node_modules', '.tmp']);
const rel = (file) => file.slice(ROOT.length + 1).split('\\').join('/');

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** 把一个目录下所有文件的「相对路径 + 内容」压成一个指纹，用于证明自检没有改动源码。 */
function fingerprint(dir) {
  const hash = createHash('sha256');
  for (const file of walk(dir).sort()) {
    hash.update(rel(file));
    hash.update(readFileSync(file));
  }
  return hash.digest('hex');
}

/* ---------- 1. 模块目录与导出形状 ---------- */

const moduleFiles = {};
for (const name of BUSINESS) {
  const file = join(MODULES_DIR, name, 'index.js');
  moduleFiles[name] = file;
  check(`模块目录 src/modules/${name}/index.js 存在`, existsSync(file));
}

const mods = {};
for (const name of BUSINESS) {
  if (!existsSync(moduleFiles[name])) continue;
  try {
    mods[name] = (await import(pathToFileURL(moduleFiles[name]).href)).default;
  } catch (error) {
    problems.push(`模块 ${name} 导入失败：${error.message}`);
  }
}
// core 也必须过同一套形状检查：它的 owns 是 17 张既有表，漏一张就没人认领。
try {
  mods.core = (await import(pathToFileURL(join(MODULES_DIR, 'core', 'index.js')).href)).default;
} catch (error) {
  problems.push(`模块 core 导入失败：${error.message}`);
}

for (const [name, module] of Object.entries(mods)) {
  const shapeOk =
    module?.name === name &&
    typeof module.install === 'function' &&
    Array.isArray(module.owns) &&
    ('apiPrefix' in module) &&
    Array.isArray(module.reads ?? []);
  check(
    `模块 ${name} 导出了 name/apiPrefix/owns/reads/install`,
    shapeOk,
    JSON.stringify({ name: module?.name, owns: module?.owns, apiPrefix: module?.apiPrefix, install: typeof module?.install }),
  );
  check(`模块 ${name} 的 name 与目录名一致`, module?.name === name, `name=${module?.name}`);
  check(
    `模块 ${name} 的 apiPrefix 是 null、/api 或以 /api/ 开头`,
    module?.apiPrefix === null || module?.apiPrefix === '/api' || (typeof module?.apiPrefix === 'string' && module.apiPrefix.startsWith('/api/')),
    String(module?.apiPrefix),
  );
}

/* ---------- 2. owns 不重复 ---------- */

const owned = new Map();
for (const [name, module] of Object.entries(mods)) {
  for (const table of module.owns ?? []) {
    if (owned.has(table)) problems.push(`表 ${table} 被 ${owned.get(table)} 与 ${name} 同时声明拥有`);
    else owned.set(table, name);
  }
}
check('owns 在模块之间没有重复声明', !problems.some((item) => item.includes('同时声明拥有')));

/* ---------- 3. 每一段 CREATE TABLE 都有主人 ---------- */

const sources = walk(join(ROOT, 'src')).filter((file) => file.endsWith('.js'));
const declared = new Map(); // 表名 -> 声明它的文件
for (const file of sources) {
  for (const match of read(file).matchAll(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([A-Za-z_]\w*)/gi)) {
    const table = match[1];
    if (!declared.has(table)) declared.set(table, rel(file));
  }
}
check('源码里确实扫到了 CREATE TABLE（否则「都有主人」是空话）', declared.size >= 17, `count=${declared.size}`);

const orphans = [...declared.keys()].filter((table) => !owned.has(table));
check(
  '每一张 CREATE TABLE 的表都被某个模块的 owns 认领',
  orphans.length === 0,
  orphans.map((table) => `${table}(${declared.get(table)})`).join(', '),
);

const ghosts = [...owned.keys()].filter((table) => !declared.has(table));
const unplannedGhosts = ghosts.filter((table) => !PLANNED_EMPTY.has(table));
check(
  'owns 里声明的表都真的建了（除了骨架期约定好还没建的）',
  unplannedGhosts.length === 0,
  unplannedGhosts.join(', '),
);
// 防止 PLANNED_EMPTY 被当成万能挡箭牌：它只能装「某块模块已经落地建表」的过渡项。
for (const table of PLANNED_EMPTY) {
  if (!owned.has(table)) problems.push(`PLANNED_EMPTY 里的 ${table} 没有任何模块声明拥有，请从清单里删掉`);
}
const stale = [...PLANNED_EMPTY].filter((table) => declared.has(table));
if (stale.length) {
  problems.push(`PLANNED_EMPTY 里的 ${stale.join('、')} 已经建表了，请从清单里删掉（让上面那条开始管它）`);
}

/* ---------- 4. 模块不许直接连数据库 ---------- */

const DB_SMELL = [/from\s+['"]node:sqlite['"]/, /\bnew\s+DatabaseSync\b/, /\bopenDatabase\s*\(/];
for (const name of BUSINESS) {
  const dir = join(MODULES_DIR, name);
  if (!existsSync(dir)) continue;
  const hits = [];
  for (const file of walk(dir)) {
    read(file)
      .split('\n')
      .forEach((line, index) => {
        if (DB_SMELL.some((pattern) => pattern.test(line))) hits.push(`${rel(file)}:${index + 1}`);
      });
  }
  check(`模块 ${name} 没有直接连数据库（只能走 ctx.store / ctx.db）`, hits.length === 0, hits.join(', '));
}

/* ---------- 5. 模块不许互相 import ---------- */

for (const name of BUSINESS) {
  const dir = join(MODULES_DIR, name);
  if (!existsSync(dir)) continue;
  const hits = [];
  for (const file of walk(dir)) {
    read(file)
      .split('\n')
      .forEach((line, index) => {
        const match = /from\s+['"](\.[^'"]+)['"]/.exec(line);
        if (!match) return;
        // 解析成仓库相对路径，只要落在 src/modules/<别的模块>/ 里就算越界。
        const target = resolve(join(file, '..'), match[1]);
        const other = BUSINESS.find((item) => item !== name && target.startsWith(join(MODULES_DIR, item) + '\\'));
        if (other) hits.push(`${rel(file)}:${index + 1} → ${other}`);
      });
  }
  check(`模块 ${name} 没有 import 其它业务模块`, hits.length === 0, hits.join(', '));
}

/* ---------- 6. 名册是唯一列举模块的地方 ---------- */

const registryPath = join(MODULES_DIR, 'index.js');
const outsiders = [];
for (const file of walk(join(ROOT, 'src'))) {
  if (file === registryPath) continue;
  read(file)
    .split('\n')
    .forEach((line, index) => {
      if (/from\s+['"]\.\/modules\/(feed|doc|ai|team|ui)\/index\.js['"]/.test(line)) {
        outsiders.push(`${rel(file)}:${index + 1}`);
      }
    });
}
check('src/modules/index.js 是唯一列举业务模块的地方', outsiders.length === 0, outsiders.join(', '));

/* ---------- 7. 解耦证明：某块目录没了，服务器必须明确报错 ---------- */

/**
 * 跑一次服务器，等它自己退出（或 15 秒超时后杀掉），把输出读回来。
 *
 * 注意：这里**不能**用 `stdio: ['ignore','pipe','pipe']`。在受限沙箱下
 * Node 的管道 stdio 会直接 EPERM（\\.\pipe 建不出来），而把输出重定向到
 * 临时文件是允许的。scripts/smoke*.mjs 用管道能跑，是因为那些脚本只在
 * CI/正常环境跑；本自检要保证在沙箱里也能跑。
 */
function runServerOnce(env = {}) {
  const logFile = join(ROOT, 'data', 'skeleton-check-server.log');
  mkdirSync(join(ROOT, 'data'), { recursive: true });
  const fd = openSync(logFile, 'w');
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [join(ROOT, 'src', 'server.js')], {
      env: { ...process.env, PORT: String(PORT), QUIET: '1', ...env },
      stdio: ['ignore', fd, fd],
    });
    const finish = (code) => {
      let output = '';
      try {
        output = readFileSync(logFile, 'utf8');
      } catch {
        /* 忽略 */
      }
      try {
        rmSync(logFile, { force: true });
      } catch {
        /* 忽略 */
      }
      resolvePromise({ code, output });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, 15000);
    child.on('error', (error) => {
      clearTimeout(timer);
      finish(`spawn-error: ${error.message}`);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      finish(code);
    });
  });
}

const before = fingerprint(MODULES_DIR);
for (const name of BUSINESS) {
  const dir = join(MODULES_DIR, name);
  if (!existsSync(dir)) continue;
  const parked = `${dir}.__parked__`;
  let result;
  try {
    renameSync(dir, parked);
    result = await runServerOnce({ SKELETON_EXPECT_FAIL: name });
  } finally {
    if (existsSync(parked) && !existsSync(dir)) renameSync(parked, dir);
  }
  const mentioned = result.output.includes(`${name}\\index.js`) || result.output.includes(`${name}/index.js`);
  check(
    `把 src/modules/${name}/ 移走后服务器明确报错退出（不是静默半残）`,
    result.code !== 0 && mentioned,
    `exit=${result.code} 提到该模块=${mentioned} 输出尾部=${result.output.trim().split('\n').slice(-2).join(' | ').slice(0, 200)}`,
  );
}

const after = fingerprint(MODULES_DIR);
check('解耦证明跑完之后 src/modules/ 逐字节复原', before === after, `${before.slice(0, 12)} → ${after.slice(0, 12)}`);

/* 五块都在时，服务器必须正常起来并响应 /api/site（证明上面第 7 条不是因为「服务器根本起不来」才通过的）。 */
for (const suffix of ['', '-wal', '-shm']) rmSync(join(ROOT, 'data', 'skeleton.db') + suffix, { force: true });
mkdirSync(join(ROOT, 'data'), { recursive: true });
const logFd = openSync(join(ROOT, 'data', 'skeleton-server.log'), 'w');
const healthy = spawn(process.execPath, [join(ROOT, 'src', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), QUIET: '1', DB_FILE: join(ROOT, 'data', 'skeleton.db'), AVATAR_DIR: join(ROOT, 'data', 'skeleton-avatars') },
  stdio: ['ignore', logFd, logFd],
});
let siteOk = false;
try {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && !siteOk) {
    try {
      const response = await fetch(`${BASE}/api/site`);
      siteOk = response.ok;
    } catch {
      await sleep(180);
    }
  }
} finally {
  healthy.kill();
  await sleep(300);
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(join(ROOT, 'data', 'skeleton.db') + suffix, { force: true });
    } catch {
      /* 忽略 */
    }
  }
  try {
    rmSync(join(ROOT, 'data', 'skeleton-avatars'), { recursive: true, force: true });
    rmSync(join(ROOT, 'data', 'skeleton-server.log'), { force: true });
  } catch {
    /* 忽略 */
  }
}
check('五块都在时服务器能起来并响应 GET /api/site', siteOk);

/* ---------- 8. 反向哨兵：入口不许重新长胖 ---------- */

const serverLines = read(join(ROOT, 'src', 'server.js')).split('\n').length;
check(
  `src/server.js 不超过 ${MAX_SERVER_LINES} 行（现在是 ${serverLines} 行）`,
  serverLines <= MAX_SERVER_LINES,
  '业务代码请写进 src/modules/<name>/，不要往入口堆',
);

const publicApp = join(ROOT, 'public', 'app.js');
if (existsSync(publicApp)) {
  const appLines = read(publicApp).split('\n').length;
  check(
    `public/app.js 不超过 ${MAX_APP_LINES} 行（现在是 ${appLines} 行）`,
    appLines <= MAX_APP_LINES,
    '前端代码请写进 public/core/ 与 public/views/，不要往入口堆',
  );
}

/* ---------- 输出 ---------- */

for (const line of notes) console.log(line);

console.log(`\n${'─'.repeat(46)}`);
console.log(`通过 ${notes.length} 项，问题 ${problems.length} 项`);
for (const problem of problems) console.log(`  ❌ ${problem}`);
process.exit(problems.length ? 1 : 0);
