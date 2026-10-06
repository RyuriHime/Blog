// 团队（P4）—— 团队主页、仅团队可见、成员共同编辑。
//
// 归属：团队本身、团队成员关系。
// 不拥有：posts / documents（团队只是给它们加一个「谁可见 / 谁能改」的维度）。
//
// 现在这个文件是**空壳**：install() 里什么也不做，站点行为与 v1 完全一致。
// 请在这里写你自己的东西，不要去改 src/modules/ 下别人文件夹里的文件。
export default {
  name: 'team',
  /** 新前缀。写完在这里登记路由，不要往 /api/posts 上加东西。 */
  apiPrefix: '/api/teams',
  owns: ['teams', 'team_members'],
  /** 会读、但不拥有的表（只读，不许写）。 */
  reads: ['users', 'posts', 'documents', 'notifications'],
  install(ctx) {
    // TODO(P4)：在这里建表、登记路由。
    //   建表：ctx.schema.add('teams', `CREATE TABLE IF NOT EXISTS ...`, 'team')
    //   可见范围要复用 core 已经冻结的四档枚举：
    //     'public' | 'followers' | 'team' | 'private'
    //   判定必须在服务端做，不能只靠前端隐藏按钮。
    //   多人协同编辑：v1 是「谁最后保存谁算数」，建议先做版本号 + 冲突提示。
    void ctx;
  },
};
