/**
 * 一次性搬运工具：把 src/server.js 按固定行区间切进 src/core/ 与 src/modules/core/，
 * 并把 src/db.js 里的 SCHEMA 大字符串搬进 src/core/tables.sql.js。
 *
 * 为什么用脚本而不是手抄：这一步的成败标准是「一个字节都没变」。
 * 脚本按行号切片，切完立刻用 `node --check` 与金标准指纹验证；
 * 比人手复制粘贴可靠得多，也留下了「到底搬了什么」的可审计证据。
 *
 * 用法（只在预铺骨架那一次运行）：
 *   node docs/tools/extract-server-modules.mjs
 *
 * 注意：切片用的是「行区间」而不是语法树。改这个文件之前先跑一次测试。
 * 行区间基于 src/server.js 的 1837 行版本。
 *
 * 不生成的文件（它们比脚本版本更完整，是手写的，文件头带 @hand-written 标记）：
 *   - src/core/open-db.js —— 手工抽了 import 头，并加了循环 import 的说明
 *   - src/core/handler.js  —— 脚本只会切主体、不会补 import；手写版有完整的 import 头
 * 这两个文件由 writeIfGenerated() 保护，重复运行脚本不会覆盖它们。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

function read(relative) {
  return readFileSync(join(ROOT, relative), 'utf8');
}

function write(relative, content) {
  const target = join(ROOT, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  console.log(`  写入 ${relative}（${Buffer.byteLength(content)} 字节）`);
}

/**
 * 有几个 `src/core/*.js` 是**手写**的胶水（比脚本生成的版本更完整），
 * 脚本不该覆盖它们。判据是文件里带这行标记。
 */
function isHandWritten(relative) {
  try {
    return readFileSync(join(ROOT, relative), 'utf8').includes('@hand-written');
  } catch {
    return false;
  }
}

/** 只在目标不是手写版时才写。 */
function writeIfGenerated(relative, content) {
  if (isHandWritten(relative)) {
    console.log(`  跳过 ${relative}（手写版，标记 @hand-written）`);
    return;
  }
  write(relative, content);
}

/** 取 src/server.js 的 from-to 行（含两端，1 开始）。 */
const serverLines = read('src/server.js').split(/\r?\n/);
function slice(from, to) {
  return serverLines.slice(from - 1, to).join('\n');
}

const BANNER = '// 搬运自 src/server.js 的固定行区间（预铺骨架，逐字未改），见 docs/tools/extract-server-modules.mjs。';

console.log('从 src/server.js 搬运：');

/* --- src/core/router.js：427-436 --- */
write(
  'src/core/router.js',
  `${BANNER}
${slice(427, 436)}
export { route, routes };
`,
);

/* --- src/core/http.js：41-126 --- */
write(
  'src/core/http.js',
  `${BANNER}
${slice(41, 126)}
export {
  HttpError,
  ensure,
  res_,
  sendJson,
  ok,
  readJsonBody,
  parseCookies,
  buckets,
  rateLimit,
  field,
};
`,
);

/* --- src/core/json-file.js：697-703（readJsonFile，routes-a/b 共用） --- */
write(
  'src/core/json-file.js',
  `${BANNER}
import { readFile } from 'node:fs/promises';

${slice(697, 703)}
export { readJsonFile };
`,
);

/* --- src/core/guards.js：438-471 --- */
write(
  'src/core/guards.js',
  `${BANNER}
import { ensure } from './http.js';

${slice(438, 471)}
export { isOwner, isStaff, requireUser, requireStaff, requireOwner, assertPostVisible };
`,
);

/* --- src/core/shape.js：140-425 --- */
write(
  'src/core/shape.js',
  `${BANNER}
import { ensure, ok } from './http.js';
import { store } from './store.js';

${slice(140, 425)}
export {
  shapeUser,
  shapeAuthor,
  shapePostListRow,
  shapePostDetail,
  shapeReply,
  shapeNotification,
  shapePerson,
  shapeMessage,
  shapeConversation,
  shapeProfile,
  collectMentions,
  notifyMentions,
  shapeReposter,
  shapeCategory,
  resolveOwnCategory,
  assertPinAllowed,
  coinAvailability,
};
`,
);

/* --- src/core/store.js：真正的 store 由 bootstrap 绑定 --- */
writeIfGenerated(
  'src/core/store.js',
  `// @hand-written 数据层句柄。
//
// 为什么要有这个文件：序列化层（shape.js）、权限门、各路由分支都需要拿到 store，
// 但 store 必须在「建表 → 迁移 → 播种」之后才能创建。
// 所以这里先放一个占位，由 src/server.js 在 openDatabase() 之后调用 bindStore()。
//
// 这是本次预铺骨架里唯一的「可变绑定」。它换来的是：
// src/server.js 不必再导出一大堆内部函数，五个业务模块的 ctx 也只有一个来源。

/** @type {ReturnType<typeof import('../store.js').createStore> | null} */
let bound = null;

/** 由 src/server.js 在建库之后调用。重复绑定会直接报错，避免悄悄换库。 */
export function bindStore(store) {
  if (bound) throw new Error('store 已经绑定过了，不能再绑');
  bound = store;
  return store;
}

/** 仅供测试断言用：当前有没有绑定。 */
export function hasStore() {
  return bound !== null;
}

/**
 * 取当前 store。
 *
 * 用 Proxy 而不是 \`export let store\` 的原因：ESM 的 import 绑定虽然也是活的，
 * 但这里的调用点写作 \`store.xxx()\`，Proxy 能在没绑定时报出一句人能看懂的错，
 * 而不是 \`Cannot read properties of null\`。
 */
export const store = new Proxy(
  {},
  {
    get(_target, property) {
      if (!bound) throw new Error('store 还没有绑定：请先调用 bindStore()');
      const value = bound[property];
      return typeof value === 'function' ? value.bind(bound) : value;
    },
    has(_target, property) {
      return bound ? property in bound : false;
    },
  },
);
`,
);

/* --- src/core/tables.sql.js：8-201 的 SCHEMA 内容，登记进 schemas --- */
{
  const dbLines = read('src/db.js').split(/\r?\n/);
  const schemaBody = dbLines.slice(8, 200).join('\n'); // 9-200 行
  write(
    'src/core/tables.sql.js',
    `// 搬运自 src/db.js:8-201 的 SCHEMA 大字符串（预铺骨架，逐字未改，只去掉了外壳）。
// 18 张 core 表：users / sessions / boards / posts / replies / reactions / coins /
// bookmarks / follows / notifications / checkins / checkin_bonuses /
// profile_categories / reposts / moderation_logs / messages / blocks。
//
// 这里是唯一还留着一大块 SQL 的地方。拆成 18 个文件并不划算：
// 它们之间靠外键互相引用，拆开只会让「按什么顺序建表」变得更难看出。
// 各业务模块自己的表**不要**写在这里，走 schemas.add() 登记。
import { schemas } from './table.js';

export const CORE_SCHEMA = \`
${schemaBody}
\`;

schemas.addScript(CORE_SCHEMA, 'core');

/** 逐条切出单张表的建表语句，方便别的模块或测试按名字取用。 */
export function coreTableStatements() {
  return CORE_SCHEMA.split(/;\\s*(?=\\n|$)/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => \`\${item};\`);
}
`,
  );
}

/* --- src/core/sessions.js：1524-1649（登录会话 + 头像文件存取） --- */
write(
  'src/core/sessions.js',
  `${BANNER}
import { mkdirSync } from 'node:fs';
import { unlink, writeFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ensure, ok, parseCookies, res_ } from './http.js';
import { isOwner, isStaff } from './guards.js';
import { AVATAR_DIR, AVATAR_URL_PREFIX, MAX_AVATAR_BYTES, SESSION_COOKIE, SESSION_TTL_MS } from './paths.js';
import { shapeUser } from './shape.js';
import { MIME } from './static.js';

${slice(1524, 1649)}
export { issueSession, sessionCookie, resolveUser, sniffImageType, saveAvatarFile, removeAvatarFile };
`,
);

/* --- src/core/static.js：1651-1712（含 serveAvatar） --- */
write(
  'src/core/static.js',
  `${BANNER}
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { ensure } from './http.js';
import { AVATAR_DIR, AVATAR_URL_PREFIX, PUBLIC_DIR } from './paths.js';

${slice(1651, 1712)}
export { serveAvatar, serveStatic, MIME };
`,
);

/* --- 四个路由分支文件 --- */
const ROUTE_IMPORTS = [
  "import { HttpError, ensure, field, ok, rateLimit, res_ } from '../../core/http.js';",
  "import { readJsonFile } from '../../core/json-file.js';",
  "import { assertPinAllowed, coinAvailability, notifyMentions, resolveOwnCategory, shapeAuthor, shapeCategory, shapeConversation, shapeMessage, shapeNotification, shapePerson, shapePostDetail, shapePostListRow, shapeProfile, shapeReply, shapeReposter, shapeUser } from '../../core/shape.js';",
  "import { isOwner, isStaff, requireOwner, requireStaff, requireUser } from '../../core/guards.js';",
  "import { issueSession, removeAvatarFile, saveAvatarFile, sessionCookie } from '../../core/sessions.js';",
  "import { store } from '../../core/store.js';",
  "import { MAX_AVATAR_BYTES } from '../../core/paths.js';",
  "import { renderMarkdown, markdownToPlainText } from '../../markdown.js';",
  "import { hashPassword, verifyPassword } from '../../password.js';",
  "import { GRAPH_FILE, GRAPH_STATUS_FILE } from './graph-paths.js';",
];

const ROUTE_UNITS = [
  ['routes-a', 475, 696, '认证 / 资料 / 头像 / 密码 / 签到 / 个人主页分类'],
  ['routes-b', 705, 1003, '知识网络图 / 帖子列表 / 帖子详情 / 发帖 / 互动'],
  ['routes-c', 1004, 1407, '分类与置顶 / 收藏 / 关注 / 黑名单 / 私信'],
  ['routes-d', 1409, 1523, '消息通知 / 管理后台'],
];

for (const [file, from, to, what] of ROUTE_UNITS) {
  const handler = `registerRoutes${file.slice(-1).toUpperCase()}`;
  write(
    `src/modules/core/${file}.js`,
    `// core 路由：${what}
// ${BANNER}
${ROUTE_IMPORTS.join('\n')}

/** 登记本文件负责的路由。 */
export function ${handler}(route) {
${slice(from, to)
  .split('\n')
  .map((line) => (line.trim() === '' ? '' : `  ${line}`))
  .join('\n')}
}
`,
  );
}

/* --- src/modules/core/graph-paths.js：694-695 --- */
write(
  'src/modules/core/graph-paths.js',
  `${BANNER}
import { join } from 'node:path';
import { ROOT } from '../../core/paths.js';

${slice(694, 695)}
export { GRAPH_FILE, GRAPH_STATUS_FILE };
`,
);

/* --- src/core/open-db.js：把 openDatabase 的函数体切出去（888-912） --- */
{
  const dbLines = read('src/db.js').split(/\r?\n/);
  const body = dbLines.slice(887, 912).join('\n'); // 888-912 行
  writeIfGenerated(
    'src/core/open-db.js',
    `// @hand-written 由 docs/tools/extract-server-modules.mjs 生成过一次，之后手工整理。
// 搬运自 src/db.js:888-912 的 openDatabase 函数体（预铺骨架）。
// 只改了两处：形参多一个 schemas，第一处 db.exec(SCHEMA) → db.exec(schemas.toSql())。
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

${body.replace('export function openDatabase(file) {', 'export function openDatabase(file, schemas) {').replace('db.exec(SCHEMA);', 'db.exec(schemas.toSql());')}
`,
  );
}

/* --- src/db.js：把 SCHEMA 定义与 openDatabase 换成 import --- */
{
  const dbLines = read('src/db.js').split(/\r?\n/);
  const before = dbLines.slice(0, 7); // 1-7 行：import + 空行
  // 201-882 行：SCHEMA 之后、openDatabase 之前。
  // 这一段里 migrate / seed / 六个 backfill* / SEED_BOARDS / SEED_USERS **必须补 export**，
  // 因为搬到 src/core/open-db.js 的那份要回头 import 它们。
  // 补 export 只增不减，对老调用方（scripts/reset-db.mjs 等）零影响。
  const TO_EXPORT = [
    'const SEED_BOARDS = [',
    'const SEED_USERS = [',
    'function migrate(db) {',
    'function seed(db) {',
    'function backfillDemoAvatars(db) {',
    'function backfillProfileExtras(db) {',
    'function backfillNotifications(db) {',
    'function backfillDemoSocial(db) {',
    'function backfillReposts(db) {',
    'function backfillDemoMessages(db) {',
  ];
  const middle = dbLines.slice(200, 882).map((line) => {
    const hit = TO_EXPORT.find((needle) => line.startsWith(needle));
    return hit ? `export ${line}` : line;
  }); // 201-882 行
  const after = dbLines.slice(912); // 913 行起
  const rewritten = [
    ...before,
    "import { CORE_SCHEMA as SCHEMA } from './core/tables.sql.js';",
    // 刻意的循环 import：core/open-db.js 又回头 import 本文件的 migrate/seed/backfill*。
    // 两边引用的都是函数声明（有提升），且真正调用发生在启动时，所以安全。
    "import { openDatabase } from './core/open-db.js';",
    '',
    ...middle,
    'export { openDatabase };',
    ...after,
  ].join('\n');
  write('src/db.js', rewritten);
  console.log(`  src/db.js 从 ${dbLines.length} 行变成 ${rewritten.split('\n').length} 行`);
}

console.log('完成。');
