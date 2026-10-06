// AI 参与编辑（P3）—— 在现有 AI 阅读助手上扩展「总结 / 分析 / 帮写 / 能力授权」。
//
// 归属：能力授权、AI 操作日志。
// 不拥有：ai_post_reviews / ai_site_reports（那是 forum-ai 自己建、自己管的表）。
//
// 现在这个文件是**空壳**：install() 里什么也不做，站点行为与 v1 完全一致。
// 请在这里写你自己的东西，不要去改 src/modules/ 下别人文件夹里的文件。
export default {
  name: 'ai',
  /** 扩展现有的 /api/ai/*（forum-ai 已经占了这个前缀，只做加法）。 */
  apiPrefix: '/api/ai',
  owns: ['ai_capability_grants', 'ai_op_logs'],
  /** 会读、但不拥有的表（只读，不许写）。 */
  reads: ['users', 'posts', 'documents', 'document_blocks'],
  install(ctx) {
    // TODO(P3)：在这里建表、登记路由。
    //   建表：ctx.schema.add('ai_capability_grants', `CREATE TABLE IF NOT EXISTS ...`, 'ai')
    //   六项能力默认**全部关闭**，必须由用户显式授权；每次调用都要落 ai_op_logs。
    //   路由前缀 /api/ai/* 已经属于 forum-ai，新增路径不要和它已有的 8 条撞车。
    void ctx;
  },
};
