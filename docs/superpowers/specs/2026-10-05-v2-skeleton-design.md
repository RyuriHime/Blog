# v2 预铺骨架 · 设计规格（Spec）

- 状态：**待评审**
- 关联需求：[01-需求规格说明书.md](<D:\Project1\Docs\01-需求规格说明书.md>)、[04-五人分工方案-人话版.md](<D:\Project1\Docs\04-五人分工方案-人话版.md>)
- 权威基线：`D:\Project1\Blog`（GitHub `RyuriHime/Blog` @ `1d7d868`，`package.json` 自报 `version 1.3.0`）
- 目标：把代码布局改造成**五个互不依赖的工作面**，让五个人能同时开工、合并只追加一行。

---

## 0. 意图与成功标准

### 0.1 意图

用户要求：「写预铺骨架 + 冻结接口，写到能够五路并行的状态，然后写成新的 README。保证网站还能正常运行的情况下（不改网站的当下部分），然后把代码扔到 github 上。」

所以本次要交付的**不是新功能**，而是：

1. 一个**契约**：每个功能块长什么样、能碰什么、装在哪儿。
2. 一个**布局**：五个块各有自己的文件夹，互不重叠。
3. 一套**测试**：既能证明「搬家没改行为」，又能证明「块真的解耦」。
4. 一份**新 README**：把上面三件事写给五个人看。
5. 一次**推送**（新分支，不是 `main`）。

### 0.2 成功标准

| # | 标准 | 怎么验 |
|---|---|---|
| S1 | 网站行为**逐字节不变** | `check-golden` 指纹与改造前完全一致 |
| S2 | 现有六套测试**全部全绿** | `node scripts/*.mjs` 逐个跑 |
| S3 | 五个块**真的能独立** | `check-skeleton` 造「缺掉某一块」的临时树，服务器仍能起来 |
| S4 | 合并只需追加一行 | 汇总点只剩一个手写清单文件（5 行 import） |
| S5 | 部署不会因为新目录而失败 | `deploy.sh` 白名单 + 硬校验；`public/` 自动递归复制 |
| S6 | 没有泄漏任何密钥 | 提交前全库扫 `AI_API_KEY` / `sk-` / `ghp_` / `AI_BASE_URL` |

### 0.3 明确不做（YAGNI）

- **不写** `feed_items` / `documents` / `document_blocks` / `ai_capability_grants` / `teams` 等五块业务表和它们的接口 —— 那是各人自己的活。
- **不改**任何界面视觉、文案、交互。
- **不碰** `data/`、`notes_*` 表、`note-agent/`、`note-studio/`、`forum-ai/`、`knowledge-pack/` 的内部。
- **不碰**线上服务器；不推 `main`。
- **不做**客户端构建（保持零依赖、无打包）。

---

## 1. 现状：三个「打架点」

五个人现在没法同时开工，原因只有三个手写的大清单：

| 打架点 | 位置 | 规模 |
|---|---|---|
| 路由清单 | `src/server.js:427-436` 的 `routes` 数组 + `:475`–`:1522` 的 49 个 `route(...)` 调用 | 1,837 行 / 67,590 B |
| 建表清单 | `src/db.js:8-201` 的 `SCHEMA` 大字符串（18 张表） | 939 行 / 36,712 B |
| 视图清单 | `public/app.js:2639` 的 `route()` if 链 + 19 个 `viewXxx` | 4,254 行 / 178,887 B |

**预铺的本质：把这三个「手写大清单」换成「扫文件夹」。** 换完之后，「我加功能会不会碰到别人的代码」这个问题在物理上不会发生。

### 1.1 已经踩过、这次必须一起修的坑

| 坑 | 证据 | 这次怎么处置 |
|---|---|---|
| 部署脚本只替换 `src public scripts` 三个目录，新目录不在白名单 = 代码推上去但**根本没部署**，且 `src/server.js` 引用不存在的文件会让服务起不来 → 健康检查失败 → 自动回滚 | `forum-ai/LOCAL-PATCHES.md:103-113` | §6.2：加白名单 + 硬校验；并让 `src/server.js` 与 `public/app.js` **仍是入口**（老部署脚本即使没更新也照常工作） |
| `check-encoding.mjs` 用**注册表**按文件路径查「必须包含的中文片段」；文件一搬家，覆盖就静默流失 | `scripts/check-encoding.mjs:13-24` | §5.1：改成按**目录**聚合扫描，并加「受检文件数不得下降」哨兵 |
| `check-ui-contract.mjs` 只 `readFileSync` 三个固定路径；改用 `className`/组件封装会让「用到的类都有定义」这条断言**静默失效** | `scripts/check-ui-contract.mjs:30-32`、`:36-43` | §5.2：改成读**清单**（core + views + modules + css），并加「断言数量不得下降」哨兵 |

---

## 2. 目录布局

```
src/
  server.js              ← 仍是入口（保持对老部署脚本兼容），但只留装配代码
  core/                  ← 第一步建一次，之后没人再碰
    routes.js            ← 路由匹配器（纯函数，可单测）
    http.js              ← sendJson / ok / readJsonBody / parseCookies / rateLimit / HttpError / ensure / field
    guards.js            ← requireUser / requireStaff / requireOwner / assertPostVisible
    shape.js             ← shapeUser / shapePostListRow / shapeReply / … （响应形状，契约的一部分）
    schema.js            ← 建表注册器 + ensureColumn + idempotent 记账
    context.js           ← 组装 ctx（routes / schema / store / db / http / guards / shape / platform）
    static.js            ← serveStatic / 头像
    platform.js          ← 平台路由：/api/auth/* /api/me/* /api/site /api/markdown/preview
                            /api/knowledge/* /api/notifications/* /api/admin/* · 签到 · 分类 · 关注 · 私信 · 黑名单
    tables.sql.js        ← 现有 18 张表（原样搬过来，一行不改内容）
  modules/               ← 五个人的地盘，一人一个文件夹
    _registry.js         ← 唯一的清单：5 行 import + 一个 installAll()
    feed/index.js        ← P1 动态
    doc/index.js         ← P2 可编程帖子
    ai/index.js          ← P3 AI（壳，指向现有 notes.js / forum-ai / note-agent）
    team/index.js        ← P4 团队
    ui/index.js          ← P5 界面资产清单
  notes.js db.js store.js markdown.js dates.js password.js   ← 原地不动
public/
  index.html             ← 不动（入口）
  app.js                 ← 变成装配层：import core + views + modules，然后启动
  style.css              ← 变成 @import 入口（保持单文件加载路径不变）
  core/                  ← 前端内核（ui / state / api / format / theme / dom / toast / pref / router）
  views/                 ← 19 个现有视图，按域拆
  modules/               ← 前端的五个工作面：feed.js doc.js ai-panel.js team.js ui-kit.js
  css/                   ← base.css + 五个块的样式文件
scripts/
  check-skeleton.mjs     ← 新：骨架契约（目录/契约/解耦）
  check-golden.mjs       ← 新：行为指纹（防重构改行为）
  golden.json            ← 新：改造前采到的指纹
docs/superpowers/specs/  ← 本 spec
```

### 2.1 为什么 `src/server.js` 和 `public/app.js` 保留为入口

用户的部署流程是「只换 `src/ public/ scripts/`」，且服务器上还有一个我不掌控的 `deploy.sh`。**保留原入口路径**让这次改造对老部署脚本**完全安全**：

- `src/server.js` 仍存在、仍可 `node src/server.js` → 老脚本照常部署。
- `public/app.js` 仍存在、`public/index.html` 仍只引用 `/app.js` → 前端加载路径不变。
- 新增的 `src/core/`、`src/modules/`、`public/core/`、`public/views/`、`public/modules/`、`public/css/` 都是**纯新增目录**。

这样即使 `deploy.sh` 忘了加白名单，最坏情况是「新目录没上传 → 服务起不来 → 自动回滚 → 线上不受影响」，而**不是**静默部署一个半残的站点。

### 2.2 `public/` 为什么不需要改部署脚本

`src/core/static.js` 的 `serveStatic` 是从磁盘按路径读文件的（不是内存清单），所以 `public/` 下新增的任何子目录**自动可访问**。只有 `src/modules/` 需要进服务器白名单（如果 `deploy.sh` 用的是 tar 解包，它本来就会带全部目录 —— 这一点在 §6.2 里做成「两种实现都安全」）。

---

## 3. 冻结契约（本次的核心产出）

### 3.1 模块契约

每个 `src/modules/<name>/index.js` 必须导出：

```js
export const name = 'feed';                    // 模块名，唯一
export const apiPrefix = '/api/feed';          // 它占的路由前缀（'core' 表示不占）
export const owns = ['feed_items', 'feed_reactions'];   // 它建的表的**精确名字**
export const reads = [];                       // 它允许读别人的表（空数组 = 只读自己的）
export function install(ctx) { /* 注册路由 + 建表 */ }
```

`owners` 表会由 `check-skeleton` 做两件事：
1. 每个表的**前缀/归属唯一**，不得两个模块声明同一张表。
2. 模块源码里出现的每个 `CREATE TABLE IF NOT EXISTS <t>` 都必须在自己的 `owns` 里；**否则报错**（这就是「不写别人的表」的物理约束）。

### 3.2 `ctx` 契约（只暴露这些）

```js
ctx = {
  db,                    // node:sqlite 的 DatabaseSync
  store,                 // createStore(db)（历史数据访问层）
  routes,                // { add(method, pattern, handler) }
  schema,                // { add(sql), column(table, name, definition) }
  http,                  // { ok, sendJson, readJsonBody, parseCookies, HttpError, ensure, field, rateLimit }
  guards,                // { requireUser, requireStaff, requireOwner, assertPostVisible, isOwner, isStaff }
  shape,                 // { user, author, postListRow, postDetail, reply, notification, person, message, category, … }
  hooks,                 // { afterReady(fn) } 挂载后的钩子（note-agent / forum-ai 用）
  options: { dbFile, root, sessionTtlMs, avatarUrlPrefix },
  log,
}
```

**没有 `ctx.other`、不允许模块互相 `import`。** 模块之间只能用冻结的字段名共享数据（`scope` / `team_id` / `document_id`），或者由 `_registry.js` 显式把某个模块的公开函数传进来（例如后续团队模块需要 `vis.visibleTo(scope, teamId, user)`）。这条纪律防止五个人互相缠在一起。

### 3.3 接口信封（沿用现状，不新造）

```
成功： { "ok": true, "data": { ... } }
失败： { "ok": false, "error": { "code": "...", "message": "..." } }
```

错误代号：`unauthenticated` 401 · `banned` 403 · `forbidden` 403 · `owner_only` 403 · `not_found` 404 · `bad_request` 400 · `conflict` 409 · `ai_not_configured` 503 · `ai_timeout` 504 · `ai_rate_limited` 429

### 3.4 路径前缀分配

| 前缀 | 归属 |
|---|---|
| `/api/auth/*` `/api/me/*` `/api/site` `/api/markdown/preview` `/api/knowledge/*` `/api/notifications/*` `/api/admin/*` `/api/ranking` `/api/users/*` `/api/messages/*` `/api/posts/*` `/api/replies/*` `/api/checkin` `/api/me/categories` | **core**（历史功能，原地保留） |
| `/api/feed/*` | P1 动态（本次只建空壳） |
| `/api/docs/*` | P2 可编程帖子（本次只建空壳） |
| `/api/ai/*` | P3（本次只建壳，指向现有 `notes.js` / `forum-ai` / `note-agent`） |
| `/api/teams/*` | P4 团队（本次只建空壳） |
| 不新增 | P5 界面 |

### 3.5 建表顺序契约

`boards` 是 `posts.board_id` 的外键目标，所以**建表必须一次事务、顺序执行**：core 表 → 各模块表（按 `_registry.js` 顺序）→ `ensureColumn` 迁移 → 播种/回填判据不变。

### 3.6 表归属表（冻结，写进 README）

| 表 | 归属 |
|---|---|
| `users` `sessions` `boards` `posts` `replies` `reactions` `coins` `bookmarks` `follows` `notifications` `checkins` `checkin_bonuses` `profile_categories` `reposts` `moderation_logs` `messages` `blocks` | **core** |
| `ai_post_reviews` `ai_site_reports` | `forum-ai`（现有挂载层，不动） |
| `notes_*`（11 张） | `note-agent`（现有挂载层，不动） |
| `feed_items` `feed_reactions` | P1 |
| `documents` `document_blocks` | P2 |
| `ai_capability_grants` `ai_op_logs` | P3 |
| `teams` `team_members` | P4 |
| 无 | P5 |

---

## 4. 实施步骤（每步之后都必须全绿）

| 步 | 做什么 | 验证 |
|---|---|---|
| 0 | 建 git 分支 `v2-skeleton`；确认工作树干净 | `git status` |
| 1 | 写 `check-golden.mjs`，在**未改动**的代码上采指纹存 `scripts/golden.json` | 指纹文件生成，覆盖 49 条路由 + 6 个页面 |
| 2 | **先写** `check-skeleton.mjs`，跑一次看它**红** | 红在「目录不存在」 |
| 3 | 抽 `src/core/*`：`routes` → `http` → `guards` → `shape` → `schema` → `tables.sql` → `static` → `platform` → `context`；`server.js` 只剩装配 | `check-golden` 绿 + 六套测试绿 |
| 4 | 建五个 `src/modules/<name>/index.js` 空壳 + `_registry.js` | `check-skeleton` 部分转绿 |
| 5 | 拆 `public/app.js` → `public/core/*` + `public/views/*`；`app.js` 变装配层 | `check-golden` 绿（前端由契约测试覆盖）+ 契约测试绿 |
| 6 | 拆 `public/style.css` → `public/css/*`，`style.css` 变 `@import` 入口 | 契约测试绿；浏览器实测 8 套主题 |
| 7 | 扩 `check-encoding` + `check-ui-contract` 到新布局，加**不下降哨兵** | 两套测试绿且受检数/断言数 ≥ 改造前 |
| 8 | 更新 `deploy.sh` 白名单 + 硬校验；更新 CI；更新 `package.json` scripts | 故意造错能拦下 |
| 9 | 写新 README | 人工读 |
| 10 | 扫密钥 → 提交 → 推 `v2-skeleton` | 推送成功，`main` 未动 |

---

## 5. 测试策略（TDD）

### 5.1 `scripts/check-golden.mjs`（防「搬家改行为」）

**这是本次最重要的测试**，因为它让「大规模搬家」变成可验证的操作。

做法：起临时服务器（临时端口 + 临时库）→ 按固定顺序执行一串请求（注册/登录/发帖/互动/分页/私信/通知/管理/越权）→ 把每条请求的 `方法 + 路径 + 状态码 + 响应 JSON 的键集合（递归排序）` 记成一行 → 与 `scripts/golden.json` 比对，任何一行不同就失败并打印差异。

要点：
- 只比**键集合与状态码**，不比具体值（时间戳、id 会变）。
- 用临时库保证确定性：先 `reset-db` 再起服务，或直接用 `DB_FILE=data/golden.db` 并**先删除**。
- 改造前先采一次指纹；**如果指纹是在改造后采的，这个测试就毫无价值**，所以步 1 必须在任何代码改动之前完成。

### 5.2 `scripts/check-skeleton.mjs`（防「块之间偷偷耦合」）

断言清单：

1. 五个模块目录 + `index.js` 存在，且导出 `name` / `apiPrefix` / `owns` / `reads` / `install`。
2. `owns` 里的表**没有跨模块重复**。
3. 每个模块源码里的 `CREATE TABLE IF NOT EXISTS <t>` 的 `<t>` 都在自己的 `owns` 里（不写别人的表）。
4. 模块源码里**不得**出现 `from 'node:sqlite'` / `new DatabaseSync`（不许绕过 `ctx`）。
5. 模块源码里**不得**出现对另一个模块的相对 import（不许互相缠）。
6. `_registry.js` 是**唯一**列模块的地方（扫全库，除了它和 `check-skeleton` 自己，没有别处 import 五个模块）。
7. **解耦证明**：把每个模块目录**逐个**临时改名（模拟「这块还没做」）→ 服务器仍能正常起来并响应 `GET /api/site` → 改回来。任何一块缺了就起不来 = 解耦失败。
8. 反向哨兵：`src/server.js` 必须 ≤ 120 行、`public/app.js` 必须 ≤ 120 行。

### 5.3 现有测试的演进

| 测试 | 改什么 |
|---|---|
| `check-encoding.mjs` | `EXPECTED` 从「写死文件路径」改成「按目录聚合」；切出来的文件各自带自己那几条片段；加哨兵：受检文件数 **≥ 23**（改造前实测 `已检查 23 个文件`） |
| `check-ui-contract.mjs` | `appJs` / `styleCss` 改成读**清单**（`public/app.js` + `public/core/*` + `public/views/*` + `public/modules/*`；`public/style.css` + `public/css/*`）；加哨兵：断言数 **≥ 175**（改造前实测 `通过 175 项，问题 0 项`） |
| `smoke.mjs` / `smoke-ai.mjs` / `notes-smoke.mjs` / `check-graph-ui.mjs` / `check-notes-ui.mjs` | **不改** —— 它们是黑盒 HTTP 测试，正是「行为不变」的第二道证据 |
| `note-agent/scripts/run-tests.mjs`、`note-studio/tests/run.mjs`、`forum-ai/selftest.mjs` | **不改** |

> 这两套测试的原设计有个共同弱点：**文件一搬家，覆盖就静默流失，而且测试还是绿的**。所以两个哨兵（受检文件数、断言数）不是可选项。

---

## 6. 部署与 CI

### 6.1 兼容性设计

| 风险 | 处置 |
|---|---|
| 老 `deploy.sh` 白名单不含 `src/modules/` | `src/server.js` 仍是入口 → 老脚本行为不变；README 给出补白名单的一行改动 |
| `public/` 新子目录 | 无需改动（`serveStatic` 从磁盘读） |
| 服务器 `deploy.sh` 若用 tar 解包 | 白名单可能是「一个数组」而非「三个目录」，两种实现都要安全 → §6.2 的硬校验是兜底 |

### 6.2 `src/server.js` 加自检（不依赖服务器脚本就能发现问题）

启动时若 `src/modules/_registry.js` 里的某个模块文件不存在，**直接报错退出并给出人话原因**（而不是抛一个 `ERR_MODULE_NOT_FOUND` 堆栈）。这样部署缺文件时会立刻失败 → 健康检查失败 → 自动回滚。

### 6.3 CI

`.github/workflows/checks.yml` 的步骤清单里**加两条**：`node scripts/check-skeleton.mjs` 和 `node scripts/check-golden.mjs`。`package.json` 的 `test` 脚本同样加这两条（保持「本地跑的就是 CI 跑的」）。

### 6.4 推送纪律

- **推到 `v2-skeleton`，不推 `main`** → 不触发服务器自动部署，线上零影响。
- 提交前扫密钥：全文搜 `AI_API_KEY` 的字面值、`sk-`、`ghp_`、`github_pat_`、以及任何 `.env`。本项目 `.gitignore` 已排除 `data/`、`.env*`、`*.db`、`*.log`、`.tmp*/`。
- token **只**出现在 git remote URL 里（本地 `.git/config`），绝不写进任何被提交的文件。推送后把 remote 改回不带 token 的 URL。

---

## 7. 风险与待确认

| # | 风险 | 影响 | 处置 |
|---|---|---|---|
| K1 | 拆 `app.js`（4,254 行）时改坏前端行为 | 高 | 先采契约测试；前端只搬家不改逻辑；每次搬完立刻跑契约测试 + 浏览器实测 |
| K2 | `check-ui-contract` 的类名扫描因搬家失效 | 中（静默） | §5.3 改成读清单 + 断言数哨兵 |
| K3 | 拆 `db.js` 的 `SCHEMA` 时改动 SQL 文本 | 高 | **逐字节搬运**：把 `:8-201` 的整段原文切到 `core/tables.sql.js`，不改一个字符；由一个「拼接后必须等于改造前字符串」的测试守住 |
| K4 | 服务器 `deploy.sh` 实现未知（不在仓库里） | 中 | §2.1 保留原入口 + §6.2 启动自检 + README 给出白名单补法 |
| K5 | `git init` 在非仓库目录 + 首次推送体量 | 低 | 用已克隆的 `D:\Project1\Blog`（已有完整历史，与 GitHub 一致） |
| K6 | 沙箱里 `npm` 管道受限 | 低 | 所有测试都用 `node scripts/xxx.mjs` 直接跑，不经 npm |

### 待确认

1. **工作目录用哪个？** 我建议在已克隆的 `D:\Project1\Blog` 上做（它有完整 git 历史，与 GitHub `1d7d868` 一致）；你的原始快照 `D:\Project1\Blog-main` 保持不动作为对照。
2. **`src/core/` vs 更扁平的结构** —— 已在上一轮问过，取 `src/core/` + `src/modules/`。

---

## 8. 验收清单（本次交付的完成定义）

- [ ] `node scripts/check-golden.mjs` 与改造前指纹**完全一致**
- [ ] `node scripts/check-skeleton.mjs` 全绿，含「逐个缺块服务器仍能起来」8 条断言
- [ ] `node scripts/check-encoding.mjs` 绿，且**受检文件数 ≥ 23**
- [ ] `node scripts/check-ui-contract.mjs` 绿，且**断言数 ≥ 175**
- [ ] `node scripts/smoke.mjs` / `smoke-ai.mjs` / `notes-smoke.mjs` / `check-graph-ui.mjs` / `check-notes-ui.mjs` 全绿
- [ ] `node note-agent/scripts/run-tests.mjs` / `node note-studio/tests/run.mjs` / `node forum-ai/selftest.mjs` 全绿
- [ ] `src/server.js` ≤ 120 行；`public/app.js` ≤ 120 行
- [ ] 浏览器实测：8 套主题、19 个页面、手机 375px 宽可用
- [ ] `deploy.sh` 白名单已含 `src/modules/`；故意删一个模块文件时启动**明确报错**
- [ ] 新 README 写好，包含冻结契约、表归属、五块边界、本地跑法
- [ ] 全库无密钥泄漏；已推 `v2-skeleton`；`main` 未动
