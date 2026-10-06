// 核心模块：现在论坛本体的全部功能都挂在这里。
//
// 它的代码是从原来的 src/server.js 按行区间**逐字搬过来**的（见
// docs/tools/extract-server-modules.mjs），只加了函数外壳与 import 头。
// 搬运的目的是让「论坛本体」和「五块新功能」在目录上平起平坐：
// 新功能各自一个文件夹，谁也不去改别人的文件。
import { registerRoutesA } from './routes-a.js';
import { registerRoutesB } from './routes-b.js';
import { registerRoutesC } from './routes-c.js';
import { registerRoutesD } from './routes-d.js';

export default {
  name: 'core',
  /** core 用的是已有前缀，一块新功能必须给自己单独的 /api/<名字>/* 前缀。 */
  apiPrefix: '/api',
  /** core 拥有的表：论坛本体现有全部 18 张（搬迁前后一字不差，顺序也不动）。 */
  owns: [
    'users',
    'sessions',
    'boards',
    'posts',
    'replies',
    'reactions',
    'coins',
    'bookmarks',
    'follows',
    'notifications',
    'checkins',
    'checkin_bonuses',
    'profile_categories',
    'reposts',
    'moderation_logs',
    'messages',
    'blocks',
  ],
  /** core 会读但不拥有的表（forum-ai / note-agent 自己建、自己管）。 */
  reads: [],
  install(ctx) {
    const { routes } = ctx;
    // 顺序即优先级，与搬运前一致：认证 → 内容 → 社交 → 通知与管理。
    registerRoutesA(routes.add);
    registerRoutesB(routes.add);
    registerRoutesC(routes.add);
    registerRoutesD(routes.add);
  },
};
