// 界面翻新（P5）—— 向轻量化靠拢：改视觉与交互，不改数据。
//
// 归属：**不拥有任何表**（这个模块是纯表现层，动数据就要回到自己的模块去加接口）。
//
// 现在这个文件是**空壳**：install() 里什么也不做，站点行为与 v1 完全一致。
// 请在这里写你自己的东西，不要去改 src/modules/ 下别人文件夹里的文件。
export default {
  name: 'ui',
  /** 不新增接口前缀 —— 界面翻新不应该改后端协议。 */
  apiPrefix: null,
  owns: [],
  /** 会读、但不拥有的表（只读，不许写）。 */
  reads: ['users', 'posts', 'boards', 'notifications'],
  install(ctx) {
    // TODO(P5)：界面翻新不改数据，所以这里大概率一直留空。
    //   你的主战场是 public/css/* 与 public/views/*：
    //     8 套主题（auto / dark / midnight / light / amber / sand / forest / violet）**必须全部保留**；
    //     「轻」不等于「空」—— 签到、投币、价值榜、私信、黑名单、笔记这些功能一个都不能砍；
    //     手机端 375px 宽要能用。
    //   如果确实需要后端配合（例如多返回一个字段），去对应模块加接口，不要在这里偷偷建表。
    void ctx;
  },
};
