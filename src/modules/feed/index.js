// 动态模块（P1）：把「板块 + 帖子 + 回复」那套论坛形态换成一条时间线。
//
//   owns  feed_items / feed_reactions / feed_replies   —— 三张表都归本模块，别的表一律只读
//                                                        （唯一的例外是对 core 的 `reposts`
//                                                         发一次删除，见下面 `reads` 的说明）
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
import { installPostRepostSync } from './post-repost.js';
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
   * 会读、但不拥有的表。
   * `users` / `follows` / `blocks` / `posts` 用来做可见范围与引用卡片；
   * `reposts` 用来分辨动态里那张帖子卡片是「🔁 转发」还是「🔗 引用」
   *（两者都是 `ref_post_id` 指着一篇帖子，见 `ITEM_COLUMNS` 的 `ref_repost`）；
   * `team_members` 归 P4，表存在时可见范围里的 `team` 档自动生效（不存在就跳过）。
   *
   * **`reposts` 是唯一一处例外：本模块会对它发一次写** —— 删掉一张「转发了帖子」
   * 的动态卡片时，要请 `ctx.store.deleteRepost()` 把帖子那边那条转发记录一起撤掉，
   * 否则帖子页还写着「已转发」而卡片已经没了（见 `routes.js` 的 `DELETE /api/feed/:id`）。
   * 走共享数据层、不写裸 SQL，也不算「拥有」这张表；和 doc 往 core 的 `boards`
   * 写一行「积木」板块是同一类跨模块动作。
   */
  reads: ['users', 'follows', 'blocks', 'posts', 'reposts', 'team_members'],
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

    /**
     * 给**已经存在**的 `feed_items` 补 `ref_feed_id`。
     *
     * `CREATE TABLE IF NOT EXISTS` 只保证表在，不会给老表加列 —— 线上那张
     * `feed_items` 是最早一版建的，光改建表语句它一辈子也长不出这一列。
     * 所以这里照 `team_members` 那个探测的思路补一次 ALTER：先看 `PRAGMA table_info`
     * 有没有，没有才加（重复 ALTER 会直接报错，不能闭着眼睛跑）。
     * 新库上这一列建表时就带着，这里什么也不做。
     */
    const columns = ctx.db.prepare('PRAGMA table_info(feed_items)').all().map((row) => row.name);
    if (!columns.includes('ref_feed_id')) {
      ctx.db.exec('ALTER TABLE feed_items ADD COLUMN ref_feed_id INTEGER');
    }

    const queries = createFeedQueries(ctx.db, { hasTeams });
    registerFeedRoutes(ctx, { queries });

    /**
     * 订上 core 的转发事件：帖子 / 积木帖被转发时，在动态流里落一张卡片。
     *
     * 转发的落点按 B 站那套语义统一到动态流（动态转动态本来就是这样），
     * 详见 `./post-repost.js` 的文件头。core 只广播，落不落卡片由本模块决定 ——
     * core 不碰 `feed_items`，本模块也不碰 `reposts` 的写。
     */
    installPostRepostSync(queries);
  },
};
