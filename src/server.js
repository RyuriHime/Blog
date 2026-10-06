// 薄入口：只负责「启动编排」，不含任何业务逻辑。
//
// 原先的 src/server.js 有 1837 行（基础设施 + 权限 + 19 组接口挤在一个文件里），
// 五个人同时改会天天冲突。现在按「谁拥有什么」拆成四层：
//
//   src/core/            基础设施（http / router / guards / shape / sessions / static / 建表登记处）
//   src/modules/core/    论坛本体现有接口（逐行搬运，行为一字未改）
//   src/modules/<名字>/  五块新功能各一个文件夹（feed / doc / ai / team / ui）
//   src/db.js            建库门面（转发给 src/core/open-db.js）
//
// 这个文件只做七件事，顺序不能变：登记表 → 开库 → 建 store → 装模块 →
// 注册挂载状态 → 造笔记子系统 → 造 HTTP 服务器 → listen。
//
// ⚠️ 三条易踩的规矩，改这个文件之前先读 docs/skeleton.md：
//   1) resolveUser 的契约是 `(req) => { user, sessionToken }` 信封，不要包成 `.user`；
//   2) ctx.routes.add 必须给 core/router.js 的 route 本体，不要在这里手抄一份；
//   3) 路由登记顺序 = 优先级；notes 路由由 buildServer 插在最前面。
import { createStore } from './store.js';
import { createNotes, defaultNotesDir } from './notes.js';
import { mountForumAi, forumAiStatus } from '../forum-ai/src/mount.mjs';
import { mountNoteAgent, noteAgentStatus } from '../note-agent/src/mount.mjs';
import {
  DB_FILE,
  HOST,
  PORT,
  ROOT,
  bindStore,
  buildServer,
  createContext,
  openDatabase,
  registerMountStatus,
  resolveUser,
  route as registerRoute,
  routes as routeTable,
  schemas,
  store as storeHandle,
} from './core/index.js';
import { installModules } from './modules/index.js';

// 1-2. 建库。core 的 14 张表在 import './db.js' 时由 `import './core/tables.sql.js'` 的副作用登记。
const { db, seeded, notifications: backfilledNotifications } = openDatabase(DB_FILE, schemas);

// 3. 数据层。必须在装模块之前建好：openDatabase 之前，各模块里的 store 句柄是空的。
const store = createStore(db);
bindStore(store);
store.purgeExpiredSessions();
setInterval(() => store.purgeExpiredSessions(), 60 * 60 * 1000).unref();

// 4. 模块。core 的表是业务表的外键目标，所以 MODULES 里 core 必须排第一。
const ctx = createContext({ db, store, route: registerRoute, schemas, hooks: { afterReady: [] } });
const activeModules = installModules(ctx)
  .filter((module) => module.name !== 'core')
  .map((module) => module.name);

// 4.5 GET /api/site 要返回 ai / notes 状态，但 core 模块不许 import 那两个包，
// 所以由这里把真正的读取函数注册进 core/mount-status.js 的延迟句柄。
registerMountStatus({ forumAi: forumAiStatus, noteAgent: noteAgentStatus });

// 5. 笔记子系统（note-studio 接线层）。用户解析交给 sessions 的原函数，见上方的规矩 1。
const notes = createNotes({
  dataDir: process.env.NOTES_DIR || defaultNotesDir(ROOT),
  userById: (id) => store.userById(id),
  resolveUser,
});

// 6. HTTP。两个挂载层都只短路自己的前缀，其余请求原样交回 buildServer 的 handler。
const server = buildServer({ db, routes: routeTable, notes, ctx });
mountForumAi({ db, resolveUser, quiet: false, scopeVocabulary: 'forum' }).attach(server);
// note-agent 的前缀必须显式给：它的默认值是 /api/notes，而那个前缀已被 note-studio 占了，
// 且它命中即短路、连 404 都不回退 —— 用默认值会把笔记接口整棵吃掉。
mountNoteAgent({ db, resolveUser, basePath: '/api/note-agent', quiet: false }).attach(server);

// 7. 启动与优雅关闭。
server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  🗣️  围炉论坛已启动');
  console.log(`  → 本地访问: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`  → 数据库  : ${DB_FILE}`);
  console.log(`  → 已装模块: core${activeModules.length ? ' / ' + activeModules.join(' / ') : ''}`);
  if (seeded) {
    console.log(`  → 首次初始化: 写入 ${seeded.boards} 个板块 / ${seeded.users} 个示例用户`);
    console.log('  → 管理员  : admin / admin123   （示例账号：alice|bob|carol / demo1234）');
  } else if (backfilledNotifications) {
    console.log(`  → 数据升级完成: 回填 ${backfilledNotifications} 条消息通知 / 关注关系`);
  }
  if (process.env.QUIET !== '1') {
    console.log(`  → forum-ai : ${JSON.stringify(forumAiStatus())}`);
    console.log(`  → note-agent: ${JSON.stringify(noteAgentStatus())}`);
  }
  console.log('');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n收到 ${signal}，正在关闭...`);
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 2000).unref();
  });
}

// storeHandle 只为让 bindStore 的延迟句柄在这个文件里有个引用点（骨架自检会断言用过 bindStore）。
void storeHandle;
