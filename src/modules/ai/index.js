// AI 参与编辑（P3）—— 能力授权 + 操作审计 + 回滚。
//
//   owns  ai_capability_grants / ai_op_logs  —— 只有这两张表，别的表一律只读
//   api   /api/ai-edit/*                     —— 见下面「为什么不是 /api/ai」的说明
//
// 不拥有：ai_post_reviews / ai_site_reports（forum-ai 运行时自建自管，写进 owns 会被
// scripts/check-skeleton.mjs 判成重复归属）。
//
// ── 为什么表在 import 期登记，而不是在 install(ctx) 里 ──
// 开库动作发生在 `src/server.js` 里（调用 `core/open-db.js` 导出的那个函数），
// 那时 `schemas` 必须已经满员。所以这里的 `schemas.addScript(...)` 是模块顶层语句，
// 和 `src/core/tables.sql.js`、`src/modules/feed/index.js` 用的是同一个套路。
// 顺序：`src/server.js` 先 import `./store.js`（登记 14 张 core 表），
// 再 import `./modules/index.js`（登记这两张表）—— 所以 `ai_op_logs.user_id`
// 引用 `users(id)` 时外键目标已经存在。
// （注意：上面别写出「函数名 + 左括号」的字样，scripts/check-skeleton.mjs 用行正则
//  查模块有没有偷偷自己开库，注释里出现那个样子也会被算成违规。）
//
// ── 为什么 apiPrefix 不是 docs/skeleton.md 里写的 '/api/ai' ──
// forum-ai 的挂载层把 `/api/ai/` 整段短路了（forum-ai/src/mount.mjs:255 的 isAiPath
// 与 :330-344 的兜底 404），挂在它下面的宿主路由**永远收不到请求**。
// `/api/ai-edit` 不以 `/api/ai/` 开头，会正常落回宿主路由表。
// 这是对冻结契约的一处偏离，需要向团队报备：见同目录 routes.js 顶部的详细说明。
import { schemas } from '../../core/schema.js';
import { registerAiRoutes } from './routes.js';
import { AI_SCHEMA } from './schema.js';

// 副作用：登记本模块的两张表（必须在开库之前，见文件头注释）。
schemas.addScript(AI_SCHEMA, 'ai');

export default {
  name: 'ai',
  /** 只做加法；具体前缀取值理由见文件头。 */
  apiPrefix: '/api/ai-edit',
  /** 本模块**拥有**的表。两张都是新增表，既有表一张都不动。 */
  owns: ['ai_capability_grants', 'ai_op_logs'],
  /**
   * 会读、但不拥有的表（只读，绝不写）。
   * `documents` / `document_blocks` 归 P2，`users` / `posts` 归 core。
   */
  reads: ['users', 'posts', 'documents', 'document_blocks'],
  install(ctx) {
    registerAiRoutes(ctx);
  },
};
