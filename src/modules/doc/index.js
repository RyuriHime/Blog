// 可编程帖子（P2）—— 学术笔记升级成「有序积木块」的文档。
//
// 归属：文档本身、文档的块。
// 不拥有：posts / reactions / coins（那是 core 的表，可编程帖子只是**另一种帖子形态**）。
//
// 现在这个文件是**空壳**：install() 里什么也不做，站点行为与 v1 完全一致。
// 请在这里写你自己的东西，不要去改 src/modules/ 下别人文件夹里的文件。
export default {
  name: 'doc',
  /** 新前缀。写完在这里登记路由，不要往 /api/posts 上加东西。 */
  apiPrefix: '/api/docs',
  owns: ['documents', 'document_blocks'],
  /** 会读、但不拥有的表（只读，不许写）。 */
  reads: ['users', 'posts', 'reactions'],
  install(ctx) {
    // TODO(P2)：在这里建表、登记路由。
    //   建表：ctx.schema.add('documents', `CREATE TABLE IF NOT EXISTS ...`, 'doc')
    //   顺序列：document_blocks.position 用 REAL，这样「插到 3 和 4 之间」可以写 3.5，
    //           不必把后面所有块的 position 全部 +1。
    //   路由：ctx.routes.add('GET', '/api/docs', handler)
    void ctx;
  },
};
