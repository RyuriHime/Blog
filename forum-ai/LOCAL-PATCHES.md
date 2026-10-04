# LOCAL-PATCHES.md — 我们对作者交付包做的改动

这份文件记录：**为了让作者的 `forum-ai` 能挂到我们的 v1.3.0 论坛上，我们改了作者包的哪些地方、为什么改**。

以后作者再给新版本（比如 `forum-ai` 更新了），**这些补丁要重新打一遍**，否则会出现"AI 页面空白""接口全 404"这类问题。每条补丁都在源码里用 `LOCAL PATCH` 注释标了位置。

改动分两类：
- **甲类是"作者包的缺陷"**（必须修，否则功能根本不通）→ 建议转告作者。
- **乙类是"我们这版的适配"**（可选，是为了配合我们已有的前端和测试）。

---

## A. `forum-ai/src/mount.mjs` —— 三处补丁

### A1（甲类）挂载层从来不调用 `store.syncCorpus()`

**现象**：挂上之后，`GET /api/ai/site` 返回 `stats.corpus.documents = 0`，`GET /api/ai/posts/:id` 一律 404，`POST /api/ai/site/analyze` 返回 400 `no_content`。整个 AI 功能等于废的。

**原因**：`store-sqlite.mjs:169 syncCorpus()` 是唯一往语料索引表 `ai_corpus_index` 写数据的入口；`routes.mjs` 里从头到尾没有任何一处调用它（只调 `pendingDocuments` / `corpusDocuments` 读）。索引表永远是空的，所以 AI 看不到任何帖子。

**证据**：作者自己的测试 `forum-ai/selftest-mount.mjs:173` 和 `forum-ai/examples/demo.mjs:216` 都是**在测试里手动调用 `syncCorpus()`** —— 说明作者知道要有人来调，但 `INTEGRATION.md` 里一个字都没提宿主需要做这件事。

**我们的修法**：在 `attach()` 里，每个 AI 请求进来时先同步一次（`/status` 例外，它被前端频繁轮询且不含语料数据）。

一开始我加了"3 秒内只同步一次"的节流，**这是错的**：`corpusHash()` 是从索引表算出来的，节流会让内容变了以后哈希还没更新，于是"缓存过期"检测失灵（作者测试里"内容变化后缓存标记为过期"两项失败）。改成**每次请求都同步**后全绿。同步成本 = 读一遍宿主 posts + 若干 upsert，和挂载层本来就每次都在做的 `corpusHash()`（要读全部正文和回复）是同一量级，小站完全可接受。

### A2（乙类）响应字段名：通用词汇 vs 论坛词汇

**现象**：作者的 `scripts/smoke-ai.mjs`（论坛 AI 端到端测试）3 项失败 + 最后崩在 `TypeError: Cannot read properties of undefined (reading 'length')`。

**原因**：挂载层输出**通用词汇** `documentId` / `documents` / `document`，而作者的**前端和测试**用的是**论坛词汇** `postId` / `posts` / `post`。

作者其实写了这个适配层，就是 `src/ai.js`（文件头自己写明："形状适配：把通用包归一化后的 `documentId` 映射回论坛既有的 `postId` 字段，保证 8 个既有 AI 路由、前端和冒烟测试的实现都不用改"）—— 但 **`src/ai.js` 属于"宿主内集成"路线（作者自己的 `src/server.js` 用它），挂载层这条路根本不加载它**。所以挂载路线缺了这层适配。

**我们的修法**：在 `attach()` 唯一那个响应出口（`return json(res, result.status ?? 200, result.body);` 之前）加一个 `forumAlias()`，递归地把论坛写法**附加**上去（不改名、不删除，可重复执行）：

| 通用写法 | 同时提供论坛写法 |
|---|---|
| `documentId` | `postId`（纯数字字符串会转成数字） |
| `documents`（数组） | `posts` |
| `documents`（数字，统计） | `posts` |
| `document`（对象） | `post` |
| brief 的裸 `id` | `postId` + `documentId` |

这样**作者的前端和作者的测试都不用改**就能跑通。加完之后 `smoke-ai.mjs` 从"3 失败+崩溃"变成只剩 2 项失败（就是下面的 A3）。

### A3（甲类）作者自己两套测试对 `scope` 的取值互相矛盾

这是 A2 修完之后剩下的最后 2 项失败。冲突很直接，就在作者自己的两个文件里：

| 文件 | 断言 |
|---|---|
| `forum-ai/selftest-mount.mjs:208` | `askOne.body.data.scope === 'document'` |
| `forum-ai/selftest-mount.mjs:211` | `askAll.body.data.scope === 'corpus'` |
| `scripts/smoke-ai.mjs:335` | `askPost.data.scope === 'post'` |
| `scripts/smoke-ai.mjs:342` | `askSite.data.scope === 'site'` |

**同一个字段，两套测试要两个不同的值，不可能同时满足。** 作者对这个字段的取向已经从 `document/corpus` 漂到 `post/site`（作者自己的测试名 `单篇问答 → 200 且 scope=post` 写的却是 `'post'`，而断言写的是 `'document'` —— 改名时漏改标签，正是漂移的痕迹；作者的宿主路线 `src/server.js:841` 用的也是 `'post' | 'site'`）。

**我们的修法**：不偏袒任何一方，把它做成**显式选项**：

```js
scopeVocabulary = 'generic',   // 'generic' → Document/Corpus 词汇；'forum' → Post/Site 词汇
```

- 默认 `'generic'` → 作者的 `selftest-mount.mjs` 原样通过（它是裸调用 `mountForumAi({db, resolveUser, quiet:true})`，不吃我们的参数）。
- 我们的 `src/server.js` 传 `scopeVocabulary: 'forum'` → 作者的 `smoke-ai.mjs` 通过。

**结果：作者的两套测试可以同时全绿**，不用靠"接受 2 项失败"来蒙混。

---

## B. `src/server.js` —— 4 行

```js
import { mountForumAi, forumAiStatus } from '../forum-ai/src/mount.mjs';   // 顶部 import 区
mountForumAi({ db, resolveUser, quiet: false, scopeVocabulary: 'forum' }).attach(server);  // server.listen 之前
ai: forumAiStatus(),                                                       // GET /api/site 的响应里
```

- 用宿主**已有的** `db`（`src/server.js:124 openDatabase()` 的返回值）和**已有的** `resolveUser`（`src/server.js:1520`，签名刚好就是挂载层要的 `(req) => ({user, sessionToken})`，**不需要包装函数**）。挂载层只建自己的 `ai_*` 表，**不给宿主表加列、不改宿主数据、不走宿主的 store.js**。
- `attach()` 只短路 `/api/ai/*`，其它请求按顺序交回宿主原来的 request 监听器。宿主自己会对未知 `/api/*` 抛 404，所以挂载必须在它之前短路 —— 因它挂在 `server.listen` 之前、且 `attach` 是把宿主的监听器摘下来再排在自己后面，位置正好。
- `ai: forumAiStatus()` 是**必须的**：前端 `aiConfigured()` 读的是 `state.site?.ai?.configured`，我们 v1.3.0 的 `/api/site` 原本没有这个字段，不加的话前端会一直认为"AI 未配置"而不显示功能。

## C. `public/app.js` —— 6 处加入 + 1 处修改

1. **作者 AI 整块**（281 行）插在 `/* 视图：管理后台 */` 之前。
2. **改 1 处**：`viewAI()` 里 `const isAdmin = state.me.role === 'admin';` → `isStaffUser(state.me)`。因为我们这版有三级角色（`member` / `admin` / `owner`），站长也该能触发"批量解读""重新整理全站"。
3. 侧栏加入口：`<a class="side-link" href="#/ai">🤖 AI 阅读助手</a>`（在"我的收藏"和"账号设置"之间）。
4. `viewPost()` 改成 `Promise.all` 多取一次 `/api/ai/posts/:id`（失败时 `catch` 成 `{cached:null, stale:false}`，**AI 挂了不影响帖子页**）。
5. 帖子正文下方插入 `${aiPostPanelHtml(post, aiInfo)}`。
6. 路由加 `if (first === 'ai') return await viewAI();`。
7. 点击分发加 3 个 `case`（`ai-analyze` / `ai-analyze-pending` / `ai-site-analyze`）+ 表单分发加 `if (action === 'ai-ask')`。

全部照抄作者代码，只做上面第 2 条这一处适配。作者声明的函数签名（`toast` / `api` / `requireLogin` / `withButtonBusy`）我们这版全都有且参数一致，所以抄过来即可用。

## D. `public/style.css` —— 追加作者"AI 阅读助手"整段（235 行）

作者那段用到的 **43 个 `.ai-*` 类、19 个 CSS 变量**我们这版全都有定义，实测"用到的类 43 / 定义的类 43 / 没被用到的类 0"，无遗漏无冗余。

---

## E. `deploy.sh` —— 让一键部署认识 `forum-ai/`

**原脚本只替换 `src public scripts`**，`forum-ai/` 不会被复制上去 → `src/server.js` 的 `import '../forum-ai/src/mount.mjs'` 会找不到文件 → 服务起不来 → 健康检查失败 → 自动回滚（不会弄坏线上，但等于白部署一次）。

改动：
1. 校验阶段：对 `forum-ai/` 也跑 `node --check`；并新增一条硬校验 —— **如果 `src/server.js` 引用了 `forum-ai/src/mount.mjs` 而包里没有它，直接拒绝部署**。
2. 备份阶段：`forum-ai/` 一并备份（回滚要用）。
3. 替换阶段：包里**有** `forum-ai/` 才替换（这样不带 AI 的包也能正常部署）。
4. 回滚阶段：`rm -rf "$APP/forum-ai"` 再从事先的备份恢复。

**铁律不变：任何情况下都不碰 `/opt/dsh-forum/data`。**

---

## 附：作者包的其它小问题（不影响功能，仅记录）

1. `forum-ai/src/mount.mjs` 顶部的用法注释写的是 `mountForumAi({ db, resolveUser, baseDir: ROOT, aiDir: join(ROOT,'forum-ai') })`，但**实际函数签名没有 `baseDir` / `aiDir` 这两个参数**（注释与实现不一致）。
2. `forum-ai/INTEGRATION.md` 没有提到宿主必须调用 `syncCorpus()`（就是 A1），照它做会得到一个完全不工作的 AI。
3. 作者的两套测试对 `scope` 取值矛盾（A3）。
4. 分发的大包 `deploy/manifest.json` 里 `sizes{}` 汇总块是旧数字（和同文件 `files[]` 的逐条大小不一致）；`RELEASE.md` 的 "49.7 KB / 96.3 KB" 就是抄自这个错的汇总块。已核实**没有任何代码读这个文件**，纯文档问题。

---

## 验证方式（改完怎么确认没搞坏）

改了 `forum-ai` 之后，必须跑这 5 套，**要全绿**：

| 测试 | 期望 |
|---|---|
| `node forum-ai/selftest-mount.mjs` | 通过 34 项，失败 0 项 |
| `node forum-ai/selftest.mjs` | 通过 92 项，失败 0 项 |
| `node scripts/smoke-ai.mjs` | 通过 61 项，失败 0 项 |
| `node scripts/smoke.mjs` | 通过 242 项，失败 0 项 |
| `node scripts/check-ui-contract.mjs` | 通过 175 项，问题 0 项 |

合计 **604 项**。另外 `node scripts/check-encoding.mjs` 在 Linux 上会报 `ENOENT ... start.cmd` —— 它硬编码要检查 `start.cmd`（Windows 专用文件、故意不上传），**这个失败是预期的，不是问题**。
