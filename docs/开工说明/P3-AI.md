> **📄 这份说明在仓库的 `docs/开工说明/` 里，也在「开工包」的 `P3-AI/` 里。**
> 下面提到的 `docs/skeleton.md` 在仓库里，可以直接打开；
> `docs/01-需求规格说明书.md` 等 `01`~`05` 那几份含服务器运维细节，**只在开工包里**，没有放进这个公开仓库。

# P3 · AI —— 开工说明

## 一、你要做的事，一句话

现有的 AI 只能「读完给你讲讲」。你要让它**能动手**：按积木块改稿、能拿权限、支持撤销回滚，编辑的时候可以边聊边改（vibe coding），并且有实时预览。

详细需求（逐条带编号）：`docs/01-需求规格说明书.md` 里 P3 那一段。

**好消息：底层已经有七成。** `forum-ai/` 那个包已经做了提示词、JSON 容错、缓存、批量分析、全库整理。你是**在它上面加一层**，不是从零写。

---

## 二、先看这几个文件（按顺序，30 分钟）

| 顺序 | 文件 | 看什么 |
|---|---|---|
| 1 | `docs/06-五路并行开工教程-人话版.md` | **先看这个**，怎么起服务、怎么写、怎么测 |
| 2 | `docs/skeleton.md` | 冻结契约的权威版（模块形状 / ctx / 响应信封 / 前缀分配 / 表归属） |
| 3 | `src/modules/ai/index.js` | **你的空壳**，注释里写清了归你什么、TODO 是什么、有什么坑 |
| 4 | `docs/01-需求规格说明书.md` | 你这一块的每一条需求（带编号和验收方法） |
| 5 | `src/modules/core/routes-a.js` 等四个文件 | 现有接口长什么样，照着抄风格 |

> 想看需求的人话版就翻 `docs/02-功能说明书-人话版.md`，但**动手写代码前以 `docs/skeleton.md` 的契约为准**。

> **特别推荐看的**：
> - `forum-ai/src/routes.mjs` —— **它已经占了 `/api/ai/*` 下这 8 条路由，你的新路径必须避开**：
>   `GET /api/ai/status`、`GET /api/ai/documents/:id`、`POST /api/ai/documents/:id/analyze`、
>   `POST /api/ai/documents/analyze-pending`、`GET /api/ai/corpus`、`POST /api/ai/corpus/analyze`、
>   `DELETE /api/ai/corpus`、`POST /api/ai/ask`
> - `forum-ai/src/mount.mjs` —— 它怎么挂到 `/api/ai` 上的；注意它的 `resolveUser` 要的是**信封** `{ user, sessionToken }`
> - `forum-ai/README.md` —— 提示词、JSON 容错、缓存都在这
> - `src/ai.js` —— **接线层**：`post` ↔ `document` 词汇、`postId` ↔ `documentId` 字段名。你要扩展 AI 能力，改动的边界就在这


---

## 三、你的地盘（只动这些）

### 后端

```
src/modules/ai/            ← 你的整个目录，随便建文件
   index.js                            ← 模块声明 + install(ctx) 里建表登记路由
```

**接口前缀：`/api/ai/*（只做加法）`** —— 只在这个前缀下加路由。

### 表的归属

| 表 | 谁建 | 说明 |
|---|---|---|
| `ai_capability_grants` | **你** | 能力授权：哪个用户、授予了哪项能力、什么时候、有效期 |
| `ai_op_logs` | **你** | AI 每次操作的日志：改了什么、谁批的、能不能回滚 |
| `ai_post_reviews` `ai_site_reports` | forum-ai | **是 forum-ai 运行时自己建的，不在建表清单里。你不许建、也不许改。** |
| `documents` `document_blocks` | P2 | **只读**，等 P2 先把表建出来 |
| `users` `posts` | core | 只读 |

建表**不要自己写 `CREATE TABLE` 执行**，要登记：

```js
ctx.schema.add('ai_capability_grants', `
  CREATE TABLE IF NOT EXISTS ai_capability_grants (
    ...
  );
`, 'ai');
```

表名必须出现在 `index.js` 的 `owns` 数组里，否则 `check-skeleton.mjs` 会报错。

### 前端

```
public/views/ai-edit.js      ← 新建，你的页面
public/css/94-ai-edit.css         ← 新建，你的样式（两位数字前缀决定加载顺序）
scripts/ai-smoke.mjs           ← 新建，你的端到端测试
```

注册页面要在 `public/app.js` 加一行 import、在 `public/core/router.js` 加一段路由。样式要在 `public/style.css` 顶部加一行 `@import`。

### 合并时你只动一行

`src/modules/index.js` 的 `MODULES` 数组里加一项：

```js
export const MODULES = [core, ai];
```

---

## 四、绝对不许碰的

| 不许动 | 为什么 |
|---|---|
| `src/core/*` | 全站地基：路由、数据库连接、权限门、出参格式、静态分发 |
| `src/modules/core/*` | 现有论坛本体（49 条接口全在这四个文件里） |
| `src/store.js` | 现有数据访问层，所有现成 SQL 都在这 |
| 别人目录里的任何文件 | `src/modules/<别的名字>/`、别人新建的 `public/views/*.js` |
| `scripts/check-*.mjs``smoke*.mjs` | 现有测试的判据，改了就等于自己给自己放水 |

**现有的 `public/views/*.js` 和 `public/css/*.css`：**不要改动它们**。现有的 AI 界面在 `public/views/ai.js`，你要新建 `public/views/ai-edit.js`**

---

## 五、起服务 + 跑测试

```bash
# Windows PowerShell
$env:PORT='3513'; $env:DB_FILE='data/p3.db'; node src/server.js
# macOS / Linux
PORT=3513 DB_FILE=data/p3.db node src/server.js
```

打开 `http://127.0.0.1:3513`，演示账号 `admin` / `admin123`。

**提交前必跑（缺一条都不许提交）：**

```bash
node scripts/check-skeleton.mjs     # 我的模块能单独拆掉吗
node scripts/check-golden.mjs       # 我有没有把现有行为改坏
node scripts/smoke.mjs              # 后端接口还正常吗
node scripts/check-frontend.mjs     # 18 个页面还渲染得出来吗
node scripts/ai-smoke.mjs          # 我自己的测试（要自己写）
```

---

## 六、贴给 AI 的话（每次任务开头都贴，一字别改）

```
这个项目已经冻结了下面这些约定，你写代码必须严格遵守，不许自己发明：

1. 模块形状：src/modules/ai/index.js 只导出
   { name, apiPrefix, owns, reads, install(ctx) }
   - owns 是我这个模块建的表，精确表名，不许和别的模块重复
   - 建表用 ctx.schema.add(表名, SQL, 'ai')，不要自己执行 CREATE TABLE
   - 登记路由用 ctx.routes.add(method, pattern, handler)

2. 响应格式（一个字都不许变）：
   成功  { "ok": true, "data": {…} }
   失败  { "ok": false, "error": { "code": "…", "message": "…" } }
   错误代号只许用这些：bad_request(400) unauthenticated(401) banned(403)
   forbidden(403) owner_only(403) not_found(404) conflict(409)
   rate_limited(429) ai_not_configured(503) ai_timeout(504)

3. 我的接口前缀是 /api/ai/*（只做加法），我只在这个前缀下加路由。

4. 我不许 import 别的模块的文件，也不许自己连数据库。
   要数据就用 ctx.db 直接读表，或者用 ctx.store 里已有的方法。

5. 可见范围枚举已冻结：scope = 'public' | 'followers' | 'team' | 'private'

6. 不许用 node --test 写测试（受限环境下会 EPERM）。
   照抄 scripts/smoke.mjs 的写法：起临时服务器 + 自己数断言，
   最后打印「通过 N 项，问题 0 项」。

7. 只允许修改下列文件，其它任何文件都不许改动：
   - src/modules/ai/ 下的文件
   - public/views/ai-edit.js
   - public/css/94-ai-edit.css
   - scripts/ai-smoke.mjs
   - src/modules/index.js（只允许加一行）
   - public/app.js 和 public/core/router.js（只允许各加一行注册）
   - public/style.css（只允许加一行 @import）

改完依次运行下面命令，把完整输出贴给我，红了先别改代码，告诉我红在哪一行：
node scripts/check-skeleton.mjs
node scripts/check-golden.mjs
node scripts/smoke.mjs
```

---

## 七、验收标准（做到这些才算完成）

- [ ] `ai_capability_grants` / `ai_op_logs` 两张表建起来并登记
- [ ] **六项能力默认全部关闭**，用户不授权就不能用；授权要能被撤销
- [ ] 每次 AI 操作都落一条 `ai_op_logs`，**能回滚**（改之前存一份旧值）
- [ ] AI 能按积木块改稿：说「帮我把这块改成投票」，它改的是**块**，不是整篇重写
- [ ] 支持实时预览（改一步看一步）
- [ ] 新路径**不与上面那 8 条 `/api/ai/*` 撞车**
- [ ] 未配置 API key 时返回 `ai_not_configured` 503，不是 500
- [ ] 超时返回 `ai_timeout` 504，限流返回 `ai_rate_limited` 429 —— 用**已有**的错误代号，别新造
- [ ] 未登录访问返回 **401 而不是 404**
- [ ] 自己的 `scripts/ai-smoke.mjs` 全绿，且 `check-golden` / `check-skeleton` / `smoke` / `smoke-ai` 都是绿的

---

## 八、你这一路最容易踩的坑

**坑 1：`/api/ai/*` 不是空地。** forum-ai 已经占了 8 条（上面列了）。你新加的路由起名要避开，比如用 `/api/ai/ops`、`/api/ai/grants`、`/api/ai/drafts` 这样的名字。

**坑 2：`ai_post_reviews` / `ai_site_reports` 不是你的表。** 它们是 forum-ai 在运行时自己建的，不在核心建表清单里。你要是把它们写进 `owns`，`check-skeleton.mjs` 会报「重复归属」。

**坑 3：权限不能只靠前端隐藏按钮。** 六项能力默认全关，**服务端**每次调用前都要查授权，而且每次调用落日志。这是需求里的硬要求。

**坑 4：AI 改东西必须先存旧值。** 需求写的是「每步可回滚」。最省事的做法是 `ai_op_logs` 里存 `before_json` / `after_json`，回滚就是写回 before。

**坑 5：AI 界面和本站路由/CSS 变量是耦合的。** forum-ai 的 README 明确写了「AI 界面未单独打包，与本站 SPA 路由和 CSS 变量耦合」。所以你的样式走 CSS 变量，别写死颜色。

**坑 6：全库整理很贵。** forum-ai 的已知短板，现有实现把所有帖子塞进上下文。你如果要批量操作，**必须做成分批 + 可中断 + 明确告知耗时**（需求里写的 14~44 秒要诚实告知）。

**坑 7：中文 n-gram 检索有噪声。** 碎片标签概率约 33%（forum-ai 自带 `quality.noiseRatio`），而且检索**不是语义的**（「性能」和「速度」互相不命中）。你要做「基于选定帖子集合的操作」时别指望它准，选中的集合要显式传给 AI。

---

## 九、常见问题

**Q：我可以改 `src/modules/core/routes-a.js` 里的一个小地方吗？**
A：不行。那是现有论坛的接口，改了 `check-golden.mjs` 会红，而且红在哪很难查。真有需求，先提出来。

**Q：我要的数据在别人的表里怎么办？**
A：用 `ctx.db` 直接读（表结构是公开的），或者看 `ctx.store` 里有没有现成的方法。**不要 import 别人的文件。**

**Q：我新增了文件，为什么测试没报错？**
A：因为哨兵没调。去 `scripts/check-encoding.mjs` 的 `REQUIRED_FILES` 里加上你的新文件，把 `MIN_CHECKED` 加 1；前端新增页面就同步调 `check-ui-contract.mjs` 的 `MIN_UI_CHECKS`。**不做这一步，测试会静默变绿、漏洞静默变大。**

**Q：`check-golden.mjs` 红了怎么办？**
A：说明你改到了现有行为。先 `git stash` 看你到底改了哪些文件，**大概率是你碰了 `src/core/` 或 `src/modules/core/` 里的东西**。绝对不要用 `--write` 重新采样来"修好"它——那是把行为改变合法化。

**Q：`node --test` 报 EPERM？**
A：预期内。这个项目**不用** `node --test`，照抄 `scripts/smoke.mjs` 的写法。
