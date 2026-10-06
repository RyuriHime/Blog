// 团队模块（P4）：让一群人有一块公共地方 —— 团队主页上能发帖，
// 帖子能设「只有本团队看得见」，成员能一起编辑**且不互相覆盖**。
//
//   owns  teams / team_members / team_posts / team_replies / team_files / team_messages
//         / team_join_requests
//   api   /api/teams/*                        —— 前缀不与任何已有接口重叠
//         （外加一条 /api/team-files/:id 下载，理由见 routes.js 里那段注释）
//
// ── 为什么表在 import 期登记，而不是在 install(ctx) 里 ──
// 开库动作发生在 `src/server.js` 里（调用 `core/open-db.js` 导出的那个函数），
// 那时 `schemas` 必须已经满员。
// 所以下面的 `schemas.addScript(...)` 是模块顶层语句（副作用导入），
// 和 `src/core/tables.sql.js` 用的是同一个套路。
// `team_posts.team_id` 与 `team_members.team_id` 都引用 `teams(id)`：
// 三张表在同一个 addScript 里、`teams` 排在最前面，所以外键目标先建出来。
// （注意：上面别写出「函数名 + 左括号」的字样，scripts/check-skeleton.mjs 用行正则
//  查模块有没有偷偷自己开库，注释里出现那个样子也会被算成违规。）
//
// ── 为什么团队帖不进 core 的 `posts` ──
// `posts.board_id` 是 `boards` 的外键，团队帖要挂进去就得凭空造一个「团队」板块；
// 而 `src/store.js` 的 `buildFilter()` 第一句就是 `p.deleted = 0`，
// 造出来的帖子会出现在首页、版块列表和全文搜索里。用 `hidden` 藏又会撞上
// `src/core/guards.js` 的 `assertPostVisible` 语义「非 staff 非作者一律 404」，
// 团队普通成员不是 staff，一点开就 404。所以 P4 自建 `team_posts`，
// 可见性 / 版本号 / 软删除全部留在本目录里，改它不碰任何人。
//
// ── 为什么没有任何 staff 后门 ──
// 如果站长能管理任意团队，他就能把自己加进一个「需要申请」的团队然后读到团队帖 ——
// 那是一条提权通道。能管理团队的只有 `team_members` 里的 owner / admin，
// 能看见团队帖的只有团队成员、作者本人、以及被标成 public 的那些。
// 少给一个后门最多是管理员看不到；多给一个就是一次不可逆的泄露，
// 内容还会被搜索、被 AI 语料索引。宁严勿宽。
import { schemas } from '../../core/schema.js';
import { migrateTeamTables } from './migrate.js';
import { createTeamQueries } from './queries.js';
import { registerTeamRoutes } from './routes.js';
import { TEAM_SCHEMA } from './schema.js';

// 副作用：登记本模块的五张表（必须在开库之前，见文件头注释）。
schemas.addScript(TEAM_SCHEMA, 'team');

export default {
  name: 'team',
  apiPrefix: '/api/teams',
  /**
   * 本模块**拥有**的表。七张都是新增表，v1 的表一张都不动。
   * `team_files` / `team_messages` 是「文件柜 + 群聊」那一轮加的：
   * 表由本模块建、也只有本模块读写，登记在这里才不会被骨架自检当成无主表。
   * `team_join_requests` 是「申请加入 + 审核」那一轮加的，同理。
   */
  owns: ['teams', 'team_members', 'team_posts', 'team_replies', 'team_files', 'team_messages', 'team_join_requests'],
  /**
   * 会读、但不拥有的表（只读，绝不写）。
   * `users` 用来把用户名换成 id、给帖子和成员填作者信息；
   * `follows` 与 `blocks` 是可见范围里 `followers` 档和双向拉黑要用的。
   * 成员表的查找一律走 `team_members`（本模块自己的表）。
   */
  reads: ['users', 'follows', 'blocks'],
  install(ctx) {
    // 先迁移再建 queries：`migrateTeamTables` 会给老库的 teams 补上 join_code /
    // announcement* 四列（以及团队号的唯一索引），而 queries 的语句里就有这些列 ——
    // 顺序反了，老库上第一条查询就会报「no such column」。
    migrateTeamTables(ctx.db);
    const queries = createTeamQueries(ctx.db);
    registerTeamRoutes(ctx, { queries });
  },
};
