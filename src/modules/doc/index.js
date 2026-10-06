// 可编程帖子（P2）—— 学术笔记升级成「有序积木块」的文档。
//
// 归属：文档本身、文档的块、文档的修订、块类型注册表、沙箱能力审计、笔记对照表。
// 不拥有：posts / reactions（那是 core 的表，可编程帖子只是**另一种帖子形态**）。
//
// ── 为什么表在 import 期登记，而不是在 install(ctx) 里 ──
// 开库动作发生在 `src/server.js` 里，那时 `schemas` 必须已经满员。
// 所以下面的 `schemas.addScript(...)` 是模块顶层语句（副作用导入），
// 和 `src/modules/feed/index.js`、`src/core/tables.sql.js` 用的是同一个套路。
import { schemas } from '../../core/schema.js';
import { addPostListExclude, addPostVisibility } from '../../core/guards.js';
import { DOC_SCHEMA } from './schema.js';
import { migrateDocTables } from './migrate.js';
import { createDocQueries } from './queries.js';
import { createDocStore } from './store.js';
import { registerDocRoutes } from './routes.js';
import { loadBlockTypes } from './blocks/index.js';
import { createVisibility, detectTeams } from './visibility.js';
import { WIKI_TEMPLATE } from './templates.js';

// 副作用：登记本模块的十四张表（必须在开库之前，见文件头注释）。
schemas.addScript(DOC_SCHEMA, 'doc');

export default {
  name: 'doc',
  /** 新前缀。写完在这里登记路由，不要往 /api/posts 上加东西。 */
  apiPrefix: '/api/docs',
  /** 本模块**拥有**的表。十四张都是新增表，v1 的表一张都不动。 */
  owns: [
    'documents',
    'document_blocks',
    'document_revisions',
    'doc_block_types',
    'doc_capability_logs',
    'note_documents',
    'doc_poll_votes',
    'doc_wiki_pages',
    'doc_app_state',
    'doc_settings',
    'doc_script_blocks',
    'doc_site_state',
    'doc_script_templates',
    'doc_tags',
  ],
  /**
   * 会读、但不拥有的表。
   *
   * ⚠️ `boards` 在这里有一个**唯一的例外**：`doc` 会往 `boards` 里写一行
   * 「积木」系统板块（见 `src/modules/doc/anchor.js`）。
   * 这么做的原因写在那个文件里 —— 互动接口（赞/踩/收藏）全部只认 `posts` 的行，
   * 而 `posts.board_id` 是 NOT NULL 外键，所以影子行必须挂在一个真实板块下。
   * 这一行是幂等创建的（`INSERT OR IGNORE`），而且**惰性**创建：
   * 只有真的建了第一篇文档才会出现，新库上一个字都不加。
   */
  reads: ['users', 'posts', 'reactions', 'boards'],
  install(ctx) {
    // 顺序不能换：先补老库的结构（守卫式迁移，幂等），
    // 再把数据库里注册过的块类型装进注册表，最后建 store ——
    // 否则「渲染一篇用了自定义类型的文档」会退化成占位。
    migrateDocTables(ctx.db);
    loadBlockTypes(ctx.db);
    const queries = createDocQueries(ctx.db);
    const store = createDocStore({ db: ctx.db, queries });

    // 影子行的可见性：core 只认 `hidden`，而 `hidden` 只由文档 scope 决定。
    // 把「这篇文档这个人看得见吗」登记给 core，关注者才能给 followers / team
    // 的积木点赞（否则一律 404，见 src/modules/doc/anchor.js 第 3 条）。
    const { canView } = createVisibility({ db: ctx.db, hasTeams: detectTeams(ctx.db) });
    addPostVisibility((post, reqCtx) => {
      const row = queries.documentByAnchor(post.id);
      return Boolean(row && canView(row, reqCtx?.user));
    });

    // wiki 站的**页**不是帖子：一个 wiki 是一篇帖子，页是站里的内容。
    //
    // 页照样留影子行（赞 / 收藏 / 通知全认 `posts.id`），它也被 `hidden = 1` 藏进了
    // 积木板块 —— 但 `hidden` 挡不住带 `includeHidden` 的列表：作者打开**自己的**
    // 个人主页就能看见 wiki 的每一页（staff 视角同理），看起来像「一个 wiki 发了一堆帖子」。
    // 所以这里给 core 的列表再上一把锁：模板是 `page` 的文档，它的影子行**谁都别列**。
    // 站本身（`template = 'station'`）不在此列 —— 它就该以一篇帖子的身份出现在主页上。
    addPostListExclude(() => ({
      sql: `NOT EXISTS (SELECT 1 FROM documents d WHERE d.anchor_post_id = p.id AND d.template = '${WIKI_TEMPLATE}')`,
      params: [],
    }));

    registerDocRoutes(ctx, { store, queries });
  },
};
