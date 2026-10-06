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
import { markdownToPlainText, renderMarkdown } from '../markdown.js';

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

/* --- src/core/tables.sql.js：9-201 的 SCHEMA 内容，登记进 schemas --- */
{
  const dbLines = read('src/db.js').split(/\r?\n/);
  // ⚠️ 三层转义，顺序不能变：
  //   1. 先处理反斜杠（否则后面加进去的反斜杠会被再转一遍）；
  //   2. 再处理反引号 —— 源文件 :86 有 `+"`…`"+` 这种「用加号绕开反引号」的写法，里面的反引号
  //      在模板字符串里必须写成 \`，否则模板字符串当场被截断（这正是第一次搬运炸掉 db.js 的原因）；
  //   3. 最后把 ${ 写成 \${，防止 SQL 里的 ${ 被当成插值。
  // 切到 200 行（**不含** 201）：201 行是 SCHEMA 的收尾反引号 `` `; ``，
  // 而目标文件的外壳（下面的模板字符串）会自己补上收尾反引号，所以 201 行必须排除。
  const schemaBody = dbLines
    .slice(8, 200)
    .join('\n')
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${');
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
/* --- src/core/sessions.js：1560-1650（登录会话 + 头像文件存取） --- */
// 起点从 1524 改到 1560：1524-1558 还是 routes-d 的最后一条路由（管理后台的封禁接口），
// 从 1524 切会把那条路由拦腰截断、也会把 sessions 的开头注释丢掉。
write(
  'src/core/sessions.js',
  `${BANNER}
import { mkdirSync } from 'node:fs';
import { unlink, writeFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ensure, ok, parseCookies, res_ } from './http.js';
import { isOwner, isStaff } from './guards.js';
import { store } from './store.js';
import { AVATAR_DIR, AVATAR_URL_PREFIX, MAX_AVATAR_BYTES, SESSION_COOKIE, SESSION_TTL_MS } from './paths.js';
import { shapeUser } from './shape.js';
import { MIME } from './static.js';

${slice(1560, 1650)}
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
  "import { assertPostVisible, isOwner, isStaff, requireOwner, requireStaff, requireUser } from '../../core/guards.js';",
  "import { issueSession, removeAvatarFile, saveAvatarFile, sessionCookie } from '../../core/sessions.js';",
  "import { store } from '../../core/store.js';",
  "import { ANON, MAX_AVATAR_BYTES, ROOT } from '../../core/paths.js';",
  "import { readFile } from 'node:fs/promises';",
  "import { join } from 'node:path';",
  "import { renderMarkdown, markdownToPlainText } from '../../markdown.js';",
  "import { hashPassword, verifyPassword } from '../../password.js';",
  "import { GRAPH_FILE, GRAPH_STATUS_FILE } from './graph-paths.js';",
];

const ROUTE_UNITS = [
  ['routes-a', 475, 696, '认证 / 资料 / 头像 / 密码 / 签到 / 个人主页分类'],
  // routes-b 从 705 起（不是 701）：697-703 的 readJsonFile 单独搬进 src/core/json-file.js，
  // 若留在这里会切出一个半截函数。
  ['routes-b', 705, 1003, '知识网络图 / 帖子列表 / 帖子详情 / 发帖 / 互动'],
  ['routes-c', 1004, 1407, '分类与置顶 / 收藏 / 关注 / 黑名单 / 私信'],
  // routes-d 到 1558 结束（不是 1523）：1524-1558 还是管理后台封禁接口的**函数体后半段**，
  // 早切会把最后一条路由截断。
  ['routes-d', 1409, 1558, '消息通知 / 管理后台'],
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
  const body = dbLines
    .slice(887, 912) // 888-912 行
    .join('\n')
    // 第二个形参默认取本模块 import 进来的 schemas 登记处：
    // 传了就用传进来的（测试可以塞一个隔离的登记处），没传就用全局的。
    // 这样 scripts/reset-db.mjs 里那句 openDatabase(DB_FILE) 一个字都不用改。
    .replace('export function openDatabase(file) {', 'export function openDatabase(file, tables = schemas) {')
    .replace('db.exec(SCHEMA);', 'db.exec((tables ?? schemas).toSql());')
    // 函数体里调用的「原来同文件的私有函数」，现在都住在 core/open-db-support.js。
    .replace(/\bbackfillDemoAvatars\(/g, 'support.backfillDemoAvatars(')
    .replace(/\bbackfillProfileExtras\(/g, 'support.backfillProfileExtras(')
    .replace(/\bbackfillNotifications\(/g, 'support.backfillNotifications(')
    .replace(/\bbackfillDemoSocial\(/g, 'support.backfillDemoSocial(')
    .replace(/\bbackfillReposts\(/g, 'support.backfillReposts(')
    .replace(/\bbackfillDemoMessages\(/g, 'support.backfillDemoMessages(')
    .replace(/\bmigrate\(db\)/g, 'support.migrate(db)')
    .replace(/\bseed\(db\)/g, 'support.seed(db)')
    .replace(/\bSEED_BOARDS\.length\b/g, 'support.SEED_BOARDS.length')
    .replace(/\bSEED_USERS\.length\b/g, 'support.SEED_USERS.length');
  writeIfGenerated(
    'src/core/open-db.js',
    `// @generated 由 docs/tools/extract-server-modules.mjs 生成，请勿手改。
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

${body}
`,
  );
}

/* --- src/core/open-db-support.js：openDatabase 用到的私有函数、种子数据与规则常量（202-882 行） --- */
{
  const dbLines = read('src/db.js').split(/\r?\n/);
  // 这些顶层声明必须补 export：
  //   前 10 个是 openDatabase 自己直接调用的；
  //   后面那些常量则被 src/db.js 尾部的 re-export 引用（DEFAULT_BOARDS / COIN_RULES / …），
  //   它们原来定义在 202-882 这段里，搬过来之后 db.js 只能从这里 import 再 export 出去。
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
    'const COIN_SIGNUP_GRANT =',
    'const COIN_PER_POST_LIMIT =',
    'const CHECKIN_DAILY_REWARD =',
    'const CHECKIN_WEEKLY_BONUS =',
    'const CHECKIN_FULL_WEEK_DAYS =',
    'const PROFILE_PIN_LIMIT =',
    'const PROFILE_CATEGORY_LIMIT =',
    'const MESSAGE_ONE_WAY_DAILY_LIMIT =',
    'const MESSAGE_MAX_LENGTH =',
    'const VALUE_WEIGHTS = {',
  ];
  const supportBody = dbLines
    .slice(201, 882) // 202-882 行
    .map((line) => {
      const hit = TO_EXPORT.find((needle) => line.startsWith(needle));
      return hit ? `export ${line}` : line;
    })
    .join('\n');
  writeIfGenerated(
    'src/core/open-db-support.js',
    `// @generated 由 docs/tools/extract-server-modules.mjs 生成，请勿手改。
// 搬运自 src/db.js:202-882（预铺骨架，逐字未改，只在一批顶层声明前补了 export）。
//
// 这里放的是「原来和 SCHEMA、openDatabase 挤在同一个文件里」的东西：
//   SEED_BOARDS / SEED_USERS / 示例帖与回复数据 / migrate / seed / 六个 backfill*
//   以及一堆规则常量（投币、签到、个人主页、私信、价值权重）。
// 单独拆出来的理由是让依赖方向保持单向：
//   db.js → core/open-db.js → core/open-db-support.js
// 如果把这些函数和常量留在 db.js、再让 open-db.js 回头 import，就形成 db.js ↔ open-db.js 的循环 import。
//
// 这些常量在本文件被 export 之后，由 src/db.js 尾部再 re-export 一次
// （DEFAULT_BOARDS / COIN_RULES / CHECKIN_RULES / PROFILE_RULES / POST_VALUE_WEIGHTS /
//   MESSAGE_RULES / ROLES / STAFF_ROLES），所以 src/store.js 等老调用方一行都不用改。
import { DatabaseSync } from 'node:sqlite';
import { hashPassword } from '../password.js';
import { markdownToPlainText } from '../markdown.js';
import { addDays, dayString, todayString, weekDays, weekStartOf } from '../dates.js';

${supportBody}
`,
  );
}

/* --- src/db.js：把 SCHEMA、种子数据、openDatabase 换成 import --- */
//
// 剩下的 db.js 只做三件事：
//   1) 把 openDatabase 重新导出（scripts/reset-db.mjs 这类老调用方在用）；
//   2) 把内部常量包成对外友好的名字（DEFAULT_BOARDS / COIN_RULES / …）；
//   3) 保留 ROLES / STAFF_ROLES 这两个角色常量。
// 它引用的所有内部常量现在都住在 core/open-db-support.js，所以统一走命名空间导入，
// 用 support.xxx 前缀引用 —— 这样以后 support 里增删常量都不用回来改 import 清单。
{
  const dbLines = read('src/db.js').split(/\r?\n/);
  const CONSTANTS = [
    'SEED_BOARDS',
    'SEED_USERS',
    'COIN_SIGNUP_GRANT',
    'COIN_PER_POST_LIMIT',
    'CHECKIN_DAILY_REWARD',
    'CHECKIN_WEEKLY_BONUS',
    'CHECKIN_FULL_WEEK_DAYS',
    'PROFILE_PIN_LIMIT',
    'PROFILE_CATEGORY_LIMIT',
    'MESSAGE_ONE_WAY_DAILY_LIMIT',
    'MESSAGE_MAX_LENGTH',
    'VALUE_WEIGHTS',
  ];
  let tailBody = dbLines.slice(912).join('\n'); // 913 行起
  for (const name of CONSTANTS) {
    tailBody = tailBody.replace(new RegExp(`\\b${name}\\b`, 'g'), `support.${name}`);
  }
  const rewritten = [
    ...dbLines.slice(0, 7), // 1-7 行：node:sqlite / node:fs / node:path + 本项目三个模块
    '',
    // ⚠️ 这三行的顺序不能动：
    //   1) tables.sql.js 是**副作用导入** —— 它在模块顶层执行 schemas.addScript(CORE_SCHEMA, 'core')，
    //      把 18 张 core 表登记进 schemas 登记处；
    //   2) open-db.js 默认的 tables 参数就是那个 schemas 对象。
    // 如果 2 排在 1 前面，schemas 还是空的，db.exec(schemas.toSql()) 等于一句空 SQL，
    // 一张表都不会建，紧接着 migrate() 就会报 "no such table: users"。
    // 3) 依赖方向：db.js → core/open-db.js → core/open-db-support.js，全程单向，没有循环 import。
    //    最后这行只是把 openDatabase 重新导出，给 scripts/reset-db.mjs 这类老调用方继续用。
    "import './core/tables.sql.js'; // 副作用导入：把 18 张 core 表登记进 schemas（必须在下一行之前）",
    "import { openDatabase } from './core/open-db.js';",
    "import * as support from './core/open-db-support.js';",
    'export { openDatabase };',
    '',
    tailBody,
  ].join('\n');
  write('src/db.js', rewritten);
  console.log(`  src/db.js 从 ${dbLines.length} 行变成 ${rewritten.split('\n').length} 行`);
}

console.log('完成。');
