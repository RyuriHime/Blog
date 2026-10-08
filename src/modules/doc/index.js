// 可编程帖子（P2）—— 学术笔记升级成「有序积木块」的文档。
//
// 归属：文档本身、文档的块、文档的修订、块类型注册表、沙箱能力审计、笔记对照表、
// 草稿行与「上一次发布的那一份块」（见 `./schema.js` 里 doc_drafts / doc_published_blocks 的注释）。
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
import { autoImportOiwiki } from './oiwiki-autoseed.js';

// 副作用：登记本模块的十六张表（必须在开库之前，见文件头注释）。
schemas.addScript(DOC_SCHEMA, 'doc');

// wiki 站的**页**不是帖子：一个 wiki 是一篇帖子，页是站里的内容。
//
// 页照样留影子行（赞 / 收藏 / 通知全认 `posts.id`），它也被 `hidden = 1` 藏进了
// 积木板块 —— 但 `hidden` 挡不住带 `includeHidden` 的列表：作者打开**自己的**
// 个人主页就能看见 wiki 的每一页（staff 视角同理），看起来像「一个 wiki 发了一堆帖子」。
// 所以这里给 core 的列表再上一把锁：模板是 `page` 的文档，它的影子行**谁都别列**。
// 站本身（`template = 'station'`）不在此列 —— 它就该以一篇帖子的身份出现在主页上。
//
// ⚠️ 登记放在**模块顶层**（而不是 `install()` 里和别的登记挤在一起），因为
// `src/store.js` 要在建表时就把这条条件拼进「这个人有多少篇帖子」的计数子查询里，
// 而 `src/server.js` 的顺序是「开库 → createStore → installModules」：
// 放 install 里就晚了半步 —— 列表（请求期读登记处）对、计数（建 store 期读一次）不对，
// 于是主页显示 12 篇、计数写 15 篇。顶层登记和 `schemas.addScript` 同一个套路。
//
// 需求 1：`kind = 'profile'` 的个人主页文档**也不是帖子** —— 它是"这个人的主页"，
// 更不该出现在动态流 / 板块列表里（广场列表本来就带 `d.kind <> 'profile'`，
// 但那是「文档列表」；影子行还得靠这条一起挡掉）。同一把锁，一起上。
addPostListExclude(() => ({
  sql: `NOT EXISTS (SELECT 1 FROM documents d WHERE d.anchor_post_id = p.id AND (d.template = '${WIKI_TEMPLATE}' OR d.kind = 'profile'))`,
  params: [],
}))

export default {
  name: 'doc',
  /** 新前缀。写完在这里登记路由，不要往 /api/posts 上加东西。 */
  apiPrefix: '/api/docs',
  /** 本模块**拥有**的表。十六张都是新增表，v1 的表一张都不动。 */
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
    'doc_drafts',
    'doc_published_blocks',
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
      if (!row) return false;
      // 站务的「隐藏」压过积木的可见性。
      //
      // 影子行的 `hidden` 平时是**推导值**：公开积木一律 0（`anchor.js` 的
      // `anchorHidden`），非公开积木一律 1，只由 scope 决定。所以「公开积木 + 影子行
      // hidden = 1」只可能是一种情况：staff 在后台把这篇文章隐藏了（`POST
      // /api/admin/posts/:id/hide`）。这时候要是还按 scope 放行，隐藏对访客就失效了
      // —— 这是老代码没有、老帖全部迁成积木之后才露出来的坑（迁移前那篇帖子没有对应
      // 文档，判定函数拿不到 row，自然 404）。
      //
      // wiki 的「页」是唯一例外：它是公开文档，影子行却按设计就是 hidden = 1
      //（`store.js` 的 `STATION_PAGE_HIDDEN`），不能当成站务隐藏处理。
      if (post.hidden && row.scope === 'public' && row.template !== WIKI_TEMPLATE) return false;
      return canView(row, reqCtx?.user);
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

    // 帖子功能下线后 `#/post/:id` 一律改道积木，所以「还没有积木的活帖」要补一篇
    // —— 幂等、同步、数据量很小（生产库实测 8 篇）。见 store.migrateLegacyPosts。
    store.migrateLegacyPosts();

    // 起完之后的一次性后台活儿：站里有「OI Wiki」空站时，自己把它导满。
    // 为什么必须由**代码**来干这件事：那 519 页是数据库内容，而部署只换
    // src/ public/ scripts/ 三个目录，仓库根与 oi-wiki-src/ 都上不了服务器 ——
    // 详见 src/modules/doc/oiwiki-autoseed.js 的文件头。
    ctx.hooks?.afterReady?.push(() => autoImportOiwiki({ ctx, queries }));
  },
};
