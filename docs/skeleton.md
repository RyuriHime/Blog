# 预铺骨架说明（v2-skeleton）

这份文档写给**接下来要在这个仓库里加功能的五个人**。

先说结论：骨架已经把「五个人同时改同一个文件」这件事消掉了。每个人有自己的文件夹、
自己的接口前缀、自己的表、自己的页面文件、自己的样式分片、自己的端口和测试。
**只要遵守下文的冻结契约，五个人的改动合起来只需要动 `src/modules/index.js` 里的一行。**

> 这份骨架改造的**唯一硬指标**是：用户能感知到的行为一个字都没变。
> 判据是 `node scripts/check-golden.mjs` —— 96 条固定请求的状态码与响应结构指纹。
> 做任何改动之前先把它跑绿，改完再跑一次，还是绿，才算没改坏东西。

---

## 0. 一分钟看懂现在的目录

```
src/
├── server.js            薄入口，86 行。装配顺序：开库 → store → ctx → 装模块 → 挂载层 → 起 HTTP
├── db.js                门面：登记建表脚本 + 转出 openDatabase 与全部规则常量
├── store.js             数据访问层（现有论坛的全部 SQL 仍在这里）
├── core/                框架层，与业务无关，五个人都不许改（要改先说一声）
│   ├── paths.js         路径与端口常量（DB_FILE / PUBLIC_DIR / AVATAR_DIR / ANON …）
│   ├── router.js        route(method, pattern, handler) + routes 数组
│   ├── context.js       createContext()：生成 ctx，模块能拿到的全部东西
│   ├── guards.js        requireUser / requireStaff / requireOwner / assertPostVisible
│   ├── http.js          ok / sendJson / readJsonBody / HttpError / ensure / field / rateLimit
│   ├── shape.js         出参形状（shapePostListRow / shapeUser / shapeNotification …）
│   ├── table.js         建表脚本登记处（schemas.addScript / schemas.add / schemas.toSql）
│   ├── tables.sql.js    18 张核心表的建表 SQL，与改造前的 SCHEMA 逐字节相同
│   ├── open-db.js       openDatabase()：建表 → 迁移 → 判断要不要播种 → 回填
│   ├── open-db-support.js  迁移 / 播种 / 六个回填函数 / 全部规则常量
│   ├── handler.js       buildServer()：组装 http server、404/405、静态资源
│   ├── static.js        静态文件分发（从磁盘按路径读，新子目录自动可访问）
│   ├── sessions.js      会话签发 / 解析（resolveUser 是挂载层要的信封形状）
│   ├── mount-status.js  延迟句柄：/api/site 要报的 forum-ai / note-agent 状态
│   └── index.js         门面，re-export 以上全部（避免模块写一长串 import 路径）
└── modules/
    ├── index.js         ★ 全仓库唯一列举模块的地方（MODULES 名册）
    ├── core/            现有论坛本体（认证 / 帖子 / 回复 / 社交 / 通知 / 管理）
    │   ├── index.js     模块声明（name/apiPrefix/owns/reads/install）
    │   └── routes-a.js  认证与站点      routes-b.js  帖子与互动
    │       routes-c.js  社交与通知      routes-d.js  管理与上传
    ├── feed/            🅿️ P1 动态
    ├── doc/             🅿️ P2 可编程帖子（积木）
    ├── ai/              🅿️ P3 AI
    ├── team/            🅿️ P4 团队
    └── ui/              🅿️ P5 界面（无接口、无表）

public/
├── index.html           页面外壳（5 个挂载点：app / sidebar / user-area / search-input / toasts）
├── app.js               薄入口，44 行，只做 bootstrap
├── style.css            只剩 25 行 @import（按文件名前缀顺序拼回原级联顺序）
├── core/                前端核心层 12 个：state dom format preferences api theme avatar
│                        events session widgets router sandbox
│                        （sandbox.js = 沙箱宿主：消息白名单 / 看门狗 / 频率上限 / resize）
├── views/               页面 15 个：feed user checkin settings notifications messages post
│                        compose auth ai admin notes doc timeline team
│                        （+ doc-blocks.js = 积木编辑器的零件层，不是页面）
└── css/                 样式分片 22 个：00-themes 10-base 20-components 30-feed 31-timeline
                         40-post 41-doc 50-forms 55-sidebar 60-admin 65-helpers 70-responsive
                         75-social 76-theme-switch 77-avatar 78-repost-ranking 80-checkin-profile
                         85-roles 86-team 88-messages 95-ai 97-notes
```

---

## 1. 冻结契约（**不要改这五样**）

想让五路改动能无冲突合并，就得有不可动摇的接缝。下面五样是接缝。

### 1.1 模块的形状

每个 `src/modules/<名字>/index.js` 只导出这五样：

```js
export default {
  name: 'feed',              // 必须与目录名一致
  apiPrefix: '/api/feed',    // 这个模块独占的接口前缀；没有接口写 null
  owns: ['feed_items', 'feed_reactions'],   // 这个模块**建**的表，精确表名
  reads: ['users', 'posts', 'follows'],     // 这个模块**读**别人建的表
  install(ctx) { /* 在这里登记表与路由 */ },
};
```

- `owns` 里的表名**不许和别的模块重复**（`check-skeleton.mjs` 会抓）。
- 五个业务模块**不许** `from 'node:sqlite'`、不许 `new DatabaseSync`、**不许 import 隔壁模块的文件**。
  数据库连接、SQL 执行、跨模块数据都通过 `ctx` 拿。这样任何一个模块被单独删掉，
  服务器仍然起得来（`check-skeleton.mjs` 会把模块目录临时改名来证明这一点）。
- 登记表用 `ctx.schema.add(表名, SQL, '模块名')`；登记路由用 `ctx.routes.add(...)`。
  模块自己 `CREATE TABLE` 是不行的 —— 迁移和建表顺序都要能被统一检查。

### 1.2 模块能拿到的全部东西（`ctx`）

```
ctx.db        node:sqlite 的 DatabaseSync 连接
ctx.store     现有数据访问层（能读 users / posts / follows / blocks / notifications 等）
ctx.routes.add(method, pattern, handler)   注册接口
ctx.schema    建表登记处：.add(表名, SQL, owner) / .names() / .ownerOf(表名)
ctx.http      ok / sendJson / readJsonBody / parseCookies / HttpError / ensure / field / rateLimit
ctx.guards    requireUser / requireStaff / requireOwner / assertPostVisible / isOwner / isStaff
ctx.shape     出参形状函数
ctx.hooks.afterReady   服务器起来后要跑的回调
ctx.options   { dbFile, root, sessionTtlMs }
ctx.log       日志
```

**没有 `ctx.other`，也不许自己去 import 别的模块。** 需要别人模块的数据，就用
`ctx.db` 直接读表（那是公开的 schema），或者找 `ctx.store` 里已有的方法。

### 1.3 响应信封（一个字都不许变）

```js
// 成功
{ "ok": true, "data": {…} }
// 失败
{ "ok": false, "error": { "code": "unauthenticated", "message": "请先登录" } }
```

错误代号沿用现有值，**不要新造同义词**：
`bad_request` 400 · `unauthenticated` 401 · `banned` 403 · `forbidden` 403 · `owner_only` 403 ·
`not_found` 404 · `method_not_allowed` 405 · `conflict` 409 · `daily_limit` 429 · `rate_limited` 429 ·
`ai_not_configured` 503 · `ai_timeout` 504 · `ai_rate_limited` 429 ·
`ai_unreachable` / `ai_unauthorized` / `ai_bad_json` / `ai_upstream_error` 502。

> 未登录访问需要登录的接口返回的是 **401 而不是 404**（这是现有行为，别"顺手修"）。

### 1.4 接口前缀分配

| 前缀 | 归谁 |
| --- | --- |
| `/api/auth` `/api/me` `/api/site` `/api/markdown` `/api/knowledge` `/api/notifications` `/api/admin` `/api/ranking` `/api/users` `/api/messages` `/api/posts` `/api/replies` `/api/checkin` | core（现有论坛本体） |
| `/api/feed/*` | 🅿️ P1 动态 |
| `/api/docs/*` | 🅿️ P2 可编程帖子 |
| `/api/ai/*` | 🅿️ P3 AI（注意：`forum-ai` 已占用 8 条 `/api/ai/...`，别撞） |
| `/api/teams/*` | 🅿️ P4 团队 |
| 不新增接口 | 🅿️ P5 界面 |

`installModules()` 会检查重复登记，撞了就抛错说清楚是哪条路由。

### 1.5 表归谁

| 表 | 归谁 |
| --- | --- |
| `users` `sessions` `boards` `posts` `replies` `reactions` `coins` `bookmarks` `follows` `notifications` `checkins` `checkin_bonuses` `profile_categories` `reposts` `moderation_logs` `messages` `blocks` | core |
| `ai_post_reviews` `ai_site_reports` | forum-ai（运行时自己建，不在核心建表清单里） |
| `notes_*` | note-studio / note-agent |
| `feed_items` `feed_reactions` | 🅿️ P1 |
| `documents` `document_blocks` `document_revisions` `doc_block_types` `doc_capability_logs` `note_documents` | 🅿️ P2 |
| `ai_capability_grants` `ai_op_logs` | 🅿️ P3 |
| `teams` `team_members` `team_posts` | 🅿️ P4 |

**`boards` 是 `posts.board_id` 的外键目标，`checkin_bonuses` / `documents` 这些也都要参与外键，
所以建表顺序必须由 core 统一控制**，不许模块自己抢跑。

---

## 2. 五路怎么并行（不打架的四条底线）

| 人 | 前缀 | 新目录 | 本地端口 | 新表 | 前端文件 |
| --- | --- | --- | --- | --- | --- |
| P1 动态 | `/api/feed/*` | `src/modules/feed/` | 3511 | `feed_items` `feed_reactions` | `public/views/feed2.js` 之类新文件 + `public/css/31-feed2.css` |
| P2 可编程帖子 | `/api/docs/*` | `src/modules/doc/` | 3492 | `documents` `document_blocks` `document_revisions` `doc_block_types` `doc_capability_logs` `note_documents` | `public/views/doc.js` + `public/css/41-doc.css` |
| P3 AI | `/api/ai/*` | `src/modules/ai/` | 3513 | `ai_capability_grants` `ai_op_logs` | `public/views/ai-edit.js` + `public/css/94-ai-edit.css` |
| P4 团队 | `/api/teams/*` | `src/modules/team/` | 3514 | `teams` `team_members` `team_posts` | `public/views/team.js` + `public/css/86-team.css` |
| P5 界面 | 不新增 | `src/modules/ui/` | 3515 | 无 | 随便改 `public/css/*`（**新功能别改，只改现有观感**） |

**四条底线：**

1. **不写别人的表**：只在 `owns` 里声明、只 `ctx.schema.add()` 自己的表。
2. **不改别人的文件**：`src/core/*`、`src/modules/core/*`、`src/store.js`、已有的
   `public/views/*.js` / `public/css/*.css` 需要改动时，**先提出来**，别自己动手。
3. **不等别人做完**：每个人用 `git worktree` 或自己的分支开工，本地起自己的端口、
   自己的库（`DB_FILE=data/p1.db` 这样），互不阻塞。

> **落地进度（2026-10）**：P1 动态、P2 积木、P4 团队**都已经进过代码**——`src/modules/feed/`、
> `src/modules/doc/`、`src/modules/team/` 不再是空壳，各自的 `<名字>-smoke.mjs` 都在跑。
> P3（AI）与 P5（界面）的目录仍是空壳。
>
> **团队（P4）与这份规格有一处出入**：团队帖没有放进 `posts`，也没有复用 P2 的 `documents`，
> 而是自建了第三张表 `team_posts`。理由写在 `src/modules/team/schema.js` 的文件头：
> 挂进 `posts` 就得凭空造一个「团队」板块、还会漂进首页与全文搜索，用 `hidden` 藏又会撞上
> `assertPostVisible` 的「非 staff 非作者一律 404」；而 `documents` 没有 `team_id` 也没有
> `version`，表达不了「这一篇属于哪个团队」、也撑不起「一起编辑且不互相覆盖」。
4. **合并只动一行**：把自己的模块加进 `src/modules/index.js` 的 `MODULES` 名册。
   名册里有、`src/modules/` 下却没有对应文件夹，或反过来，`installModules()` 会直接抛错。

**合并顺序建议 P2 → P1 → P5 → P3 → P4**（先合表结构最稳的，最后合最容易和界面打架的）。

---

## 3. 怎么加一个新模块（照着抄）

1. 建目录 `src/modules/<名字>/index.js`，抄 `src/modules/feed/index.js` 的形状。
2. 建表（如果有）：

   ```js
   install(ctx) {
     ctx.schema.add('feed_items', `
       CREATE TABLE IF NOT EXISTS feed_items (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         user_id INTEGER NOT NULL REFERENCES users(id),
         body TEXT NOT NULL,
         scope TEXT NOT NULL DEFAULT 'public' CHECK (scope IN ('public','followers','team','private')),
         created_at INTEGER NOT NULL
       );
     `, 'feed');

     ctx.routes.add('GET', '/api/feed', async (ctx2) => ctx2.http.ok(ctx2.res, { items: [] }));
   }
   ```

3. 在 `src/modules/index.js` 的 `MODULES` 数组里加一项 —— **就这一行**。
4. 跑 `node scripts/check-skeleton.mjs`：它会证明你这个模块**可以被单独拆掉**，
   服务器仍然起得来（它真的会把目录临时改名再起一次服务器）。
5. 跑 `node scripts/check-golden.mjs`：确认没改坏现有行为。

### 冻结的枚举（五个人都用同一套）

```js
scope = 'public' | 'followers' | 'team' | 'private'
```

积木顺序列 `document_blocks.position` 用 **REAL 浮点数**，这样在 1 和 2 之间插一块写 `1.5`
就行，不用重排整张表。

---

## 4. 有哪些测试，各自守什么

| 脚本 | 守什么 | 现在 |
| --- | --- | --- |
| `check-golden.mjs` | **行为金标准**：96 条固定请求的状态码 + 响应结构 | 96 项 0 差异 |
| `check-skeleton.mjs` | 骨架本身：模块解耦证明 + 薄入口行数 + 表归属 | 47 项 |
| `check-frontend.mjs` | **前端整页渲染**：最小 DOM 垫片 + 真响应假数据，30 个页面全渲染 | 30/30 |
| `smoke.mjs` | 后端端到端（起真服务打接口） | 253 项 |
| `smoke-ai.mjs` | AI 接口端到端 | 61 项 |
| `feed-smoke.mjs` / `doc-smoke.mjs` / `team-smoke.mjs` | 动态流 / 积木 / 团队的接口端到端 | 95 / 392 / 97 项 |
| `check-ui-contract.mjs` | 前端类名 / API 字段 / 主题 / 头像 / 角色 / 私信结构 | 219 项 |
| `check-encoding.mjs` | 编码体检（BOM / 乱码 / 关键中文片段） | 183 文件 / 87 断言 |
| `check-notes-ui.mjs` | 笔记的前端结构 | 33 项 |
| `notes-smoke.mjs` / `forum-ai/selftest.mjs` / `note-studio/tests/run.mjs` | 子系统 | 44 / 92 / — |
| `note-agent/scripts/run-tests.mjs` | note-agent | CI 上跑（本机受限沙箱下 spawn 管道会 EPERM） |

**三套静态检查都带「不下降」哨兵**（`MIN_CHECKED` / `MIN_UI_CHECKS` / `MIN_PASS`），
`check-encoding.mjs` 还有一份 `REQUIRED_FILES` 关键文件表。
意思是：**你把文件搬走却没同步检查脚本，测试会红**，而不是静默变绿。
改造时这两件事必须一起做：

- 新增/搬动文件 → 更新 `scripts/check-encoding.mjs` 的 `REQUIRED_FILES` 与 `MIN_CHECKED`；
- 前端新增页面/样式 → 更新 `scripts/check-ui-contract.mjs` 的 `MIN_UI_CHECKS`。

---

## 5. 部署与推送纪律

- **`deploy.sh` 只替换 `src/ public/ scripts/` 三个目录**。新增的顶层目录不会被部署。
  所以新模块必须放在 `src/modules/` 里面（在 `src/` 下），不要新开顶层目录。
- `public/` 不需要改部署脚本：静态分发是**从磁盘按路径读**的，新子目录自动可访问。
- **任何时候都不要碰服务器上的数据目录。** 部署只换 `src/ public/ scripts/`，数据库从来不参与。
- **推 `v2-skeleton` 或你自己的功能分支，不要推 `main`**：服务器上的定时任务会拉 `main`
  并按 CI 结果部署，推 `main` 就等于上线。
- `src/server.js` 启动时会自己检查模块文件在不在（缺文件就明确报错退出），
  所以「只上传了一半」会让健康检查失败并自动回滚，而不是静默跑一个半残站点。

---

## 6. 骨架改造做过的验证（放心用）

- **`tables.sql.js` 里的 18 张表建表 SQL 与改造前的 `SCHEMA` 逐字节相同**（7605 字符对 7605 字符）。
- **`src/db.js` 三段拆分后，`openDatabase()` 能独立建全 17 张表并完成播种**
  （建表 17 张 / 缺少无 / 多余无 / 播种 5 板块 4 用户 / users=4 posts=8 replies=15）。
- **前端拆迁：4255 行 `app.js` → 44 行入口 + 24 个模块，覆盖自检证明每一行都有归宿**
  （声明区间 3959 行 + 文件头 2 行 + 块间空行/注释 294 行 = 4255 行）。
- **样式拆迁：2669 个非空行按分片顺序拼回来与原文件逐行相同**。
- 全部测试转绿（见上表）。
