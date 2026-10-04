// 薄入口：只负责「启动编排」，不含任何业务逻辑。
//
// 原来的 src/server.js 有 1837 行，把基础设施、权限、19 组接口全挤在一个文件里，
// 五个人同时改会天天冲突，所以按「谁拥有什么」拆成：
//
//   src/core/           基础设施（http / router / guards / shape / sessions / static / 建表登记处）
//   src/modules/core/   论坛本体现有接口（逐行搬运，行为一字未改）
//   src/modules/<名字>/  五块新功能各自一个文件夹（feed / doc / ai / team / ui）
//
// 这个文件只做七件事，顺序不能变：
//   1) 把 core 的表登记进 schemas（import ./db.js 时的副作用导入触发）
//   2) 打开数据库（迁移 + 首次播种）
//   3) 建数据层 store，绑定到 core/store.js 的延迟句柄
//   4) 建模块上下文 ctx，把六个模块装上（core + 五块新功能）
//   5) 造笔记子系统（note-studio 接线层）
//   6) 造 HTTP 服务器，把论坛 AI 与笔记 Agent 挂上去
//   7) listen + 信号处理
//
// ⚠️ 路由登记顺序 = 优先级。core 的路由由 installModules() 登记，
//    而 buildServer() 会在它们之前把笔记路由塞进同一张表 —— 理由见 core/handler.js 的注释。
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
  routes as routeTable,
  schemas,
  store as storeHandle,
} from './core/index.js';
import { installModules } from './modules/index.js';

/* 1-2. 建库 ---------------------------------------------------------------- */
// core 的 18 张表是在 import './db.js' 时、由 `import './core/tables.sql.js'` 的副作用登记进 schemas 的。
// openDatabase 第二个参数不传也会用全局 schemas；这里显式传一次，方便测试塞一个隔离的登记处。
const { db, seeded, notifications: backfilledNotifications } = openDatabase(DB_FILE, schemas);

/* 3. 数据层 ---------------------------------------------------------------- */
// store 必须在这里建：openDatabase 之前模块里的 store 句柄是空的。
const store = createStore(db);
bindStore(store);
store.purgeExpiredSessions();
setInterval(() => store.purgeExpiredSessions(), 60 * 60 * 1000).unref();

/* 4. 模块 ------------------------------------------------------------------ */
const ctx = createContext({
  db,
  store,
  route: (method, pattern, handler) => {
    const keys = [];
    const source = pattern.replace(/:([A-Za-z_]+)/g, (_match, key) => {
      keys.push(key);
      return '([^/]+)';
    });
    routeTable.push({ method, regex: new RegExp(`^${source}$`), keys, handler });
  },
  schemas,
  hooks: { afterReady: [] },
});
const installedModules = installModules(ctx);
const activeModules = installedModules.filter((module) => module.name !== 'core').map((module) => module.name);

/* 4.5 挂载层状态 ------------------------------------------------------------ */
// GET /api/site 要返回 ai / notes 两个状态字段，但 core 模块不许直接 import
// forum-ai / note-agent（模块之间只通过 ctx 通信）。所以把真正的读取函数注册进
// core/mount-status.js 的延迟句柄里。
registerMountStatus({ forumAi: forumAiStatus, noteAgent: noteAgentStatus });

/* 5. 笔记子系统 ------------------------------------------------------------ */
const notes = createNotes({
  dataDir: process.env.NOTES_DIR || defaultNotesDir(ROOT),
  userById: (id) => store.userById(id),
  resolveUser,
});

/* 6. HTTP ------------------------------------------------------------------ */
const server = buildServer({ db, routes: routeTable, notes, ctx });

// 论坛 AI 阅读助手。它只短路 /api/ai/*，其余请求原样交回上面的 handler。
// 它自己建 ai_* 表（CREATE TABLE IF NOT EXISTS），不写论坛任何业务表。
//
// ⚠️ 这里必须传 `./core/sessions.js` 的 `resolveUser` **原函数**，它的契约是
// `(req) => { user, sessionToken }`（见 forum-ai/src/mount.mjs:348 与
// note-agent/src/mount.mjs:282 的 `const { user } = await resolveUser(req)`）。
// 早期骨架版这里传的是 `(req) => resolveUser(req).user`，返回值是「一行用户」而不是
// 「信封」，解构出 `user: undefined` → 所有 /api/ai/* POST 一律 401
// `unauthenticated`。这个错误 GET 看不出来（GET 只读缓存不校验身份），只有 smoke-ai 抓得到。
mountForumAi({
  db,
  resolveUser,
  quiet: false,
  scopeVocabulary: 'forum',
}).attach(server);

// 学术笔记整理 Agent。前缀**必须**显式给成 /api/note-agent：
// 它的默认值是 /api/notes，而那个前缀已经被 note-studio 的接线层占了，
// 且它命中即短路、连 404 都不回退 —— 用默认值会把笔记接口整棵吃掉。
mountNoteAgent({
  db,
  resolveUser,
  basePath: '/api/note-agent',
  quiet: false,
}).attach(server);

/* 7. 启动 ------------------------------------------------------------------ */
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

// storeHandle 只是为了让「core/store.js 的延迟句柄」在这个文件里有个引用点，
// 骨架自检会断言这里确实用了 bindStore。
void storeHandle;
