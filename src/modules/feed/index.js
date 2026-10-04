// 动态（P1）—— 把「论坛板块 + 帖子 + 回复」换成一条时间线。
//
// 归属：动态本身、动态的点赞、动态的可见范围。
// 不拥有：posts / replies / reactions（那是 core 的表，动态只是**引用**帖子）。
//
// 现在这个文件是**空壳**：install() 里什么也不做，站点行为与 v1 完全一致。
// 请在这里写你自己的东西，不要去改 src/modules/ 下别人文件夹里的文件。
export default {
  name: 'feed',
  /** 新前缀。写完在这里登记路由，不要往 /api/posts 上加东西。 */
  apiPrefix: '/api/feed',
  owns: ['feed_items', 'feed_reactions'],
  /** 会读、但不拥有的表（只读，不许写）。 */
  reads: ['users', 'posts', 'follows', 'blocks', 'notifications'],
  install(ctx) {
    // TODO(P1)：在这里建表、登记路由。
    //   建表：ctx.schema.add('feed_items', `CREATE TABLE IF NOT EXISTS ...`, 'feed')
    //         —— 表名必须在这个模块的 owns 数组里，否则 check-skeleton 会报错。
    //   路由：ctx.routes.add('GET', '/api/feed', handler)
    //         —— handler 拿到的 ctx 见 src/core/context.js；判登录用 ctx-guards。
    //         注意：install() 拿到的 ctx 是**模块上下文**，与路由 handler 收到的请求 ctx 同名但不同物。
    void ctx;
  },
};
