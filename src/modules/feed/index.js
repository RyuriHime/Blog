// 动态模块（P1）：把「板块 + 帖子 + 回复」那套论坛形态换成一条时间线。
//
//   owns  feed_items / feed_reactions / feed_replies   —— 三张表都归本模块，别的表一律只读
//   api   /api/feed/*                                   —— 前缀不与任何已有接口重叠
//
// ── 为什么表在 import 期登记，而不是在 install(ctx) 里 ──
// 开库动作发生在 `src/server.js` 里（调用 `core/open-db.js` 导出的那个函数），
// 那时 `schemas` 必须已经满员。
// 所以这里的 `schemas.addScript(...)` 是模块顶层语句（副作用导入），
// 和 `src/core/tables.sql.js` 用的是同一个套路。
// 顺序：`src/server.js` 先 import `./store.js`（它 import `./db.js` → 登记 14 张 core 表），
// 再 import `./modules/index.js`（登记本模块的三张表）—— 所以 `feed_items.user_id`
// 引用 `users(id)` 时外键目标已经存在。
// （注意：上面别写出「函数名 + 左括号」的字样，scripts/check-skeleton.mjs 用行正则
//  查模块有没有偷偷自己开库，注释里出现那个样子也会被算成违规。）
//
// 加一块新功能就照这个文件抄：文件夹 + `src/modules/index.js` 一行，别处都不用动。
import { schemas } from '../../core/schema.js';
import { createFeedQueries } from './queries.js';
import { registerFeedRoutes } from './routes.js';
import { FEED_SCHEMA } from './schema.js';

// 副作用：登记本模块的三张表（必须在 openDatabase 之前，见文件头注释）。
schemas.addScript(FEED_SCHEMA, 'feed');

export default {
  name: 'feed',
  apiPrefix: '/api/feed',
  /** 本模块**拥有**的表。三张都是新增表，v1 的表一张都不动。 */
  owns: ['feed_items', 'feed_reactions', 'feed_replies'],
  /**
   * 会读、但不拥有的表（只读，绝不写）。
   * `users` / `follows` / `blocks` / `posts` 用来做可见范围与引用卡片；
   * `team_members` 归 P4，表存在时可见范围里的 `team` 档自动生效（不存在就跳过）。
   */
  reads: ['users', 'follows', 'blocks', 'posts', 'team_members'],
  install(ctx) {
    /**
     * P4 还没建 `team_members` 时，`scope='team'` 的动态**谁也看不到**（包括作者以外的人）。
     *
     * 用「探测一次」而不是「写死 false」：P4 建好那张表以后，
     * 这一档自动开始工作，不需要再回来改 P1 的代码 —— 五个人并行时这很重要。
     * 用「谁也看不到」而不是「降级成公开」：宁可少显示，不能把私密内容漏出去。
     */
    const hasTeams = Boolean(
      ctx.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'team_members'").get(),
    );

    const queries = createFeedQueries(ctx.db, { hasTeams });
    registerFeedRoutes(ctx, { queries });
  },
};
