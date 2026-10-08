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

## F. 站内 Wiki 推荐（乙类，本轮新增）—— 让 `recommend` 只落在真实存在的地方

**现象**：线上每篇帖子底下的「📚 推荐阅读」里会出现《积木使用指南》《AI 编辑台：改写与回滚实战》《Sandbox API 完整参考手册》这类**站里根本没有的篇目**。点不了（没有链接），但读者会以为站里有这些文章。

**原因**（作者包的原始设计，不是 bug，但会在我们的站上出问题）：

1. 提示词 `src/prompts.mjs` 的 `ANALYZE_SYSTEM` 原文是「recommend 给 2-4 条：材料里列出的其它文档，documentId 必须填真实存在的编号；**没有合适的就填 null 并给出标题建议**」——「给标题建议」就是邀请模型编篇目名。
2. `src/parse.mjs` 的 `normalizeReview()` 对没有编号的条目保留 `{documentId: null, external: false, title}`：作者原本用 `external: true` 表示"库里没有、只是建议"，但**模型自己编的条目连编号都没给**（`id === null` ⇒ `external: false`），于是走了"内链"分支却只有标题，前端渲染成一段纯文本。
3. 更根本的是：作者包的语料里只有宿主喂给它的材料，**模型无从知道站里到底有什么**。我们的站还有一整套「积木」文档（含 519 页的 OI Wiki 站点），模型完全看不到。

**我们的修法**（四层，缺一不可）：

| 位置 | 改动 |
|---|---|
| `src/mount.mjs` | 新增 `createWikiPageSource(db)`：只读地枚举本站积木模块里 `template='page'` 且 `station_id > 0` 的文档（`documents` ⨝ `doc_settings` ⨝ 站点标题，能读到 `doc_wiki_pages.category` 就带上）。**缺表/缺列时退化成空数组**（作者包单独跑或宿主的插件模块没装时不报错）。经 `createAiHandlers({ …, wikiPages })` 注入。 |
| `src/routes.mjs` | `wikiPool(doc)`：拿上一步的整份 wiki 清单，按「命中文档标题或正文 +6 / 与本篇标题的二字重合 ×2」做**站内检索**，取分数最高的 24 条进提示词。另外 `recommendPool()` 里把 **wiki 页的影子帖**（`anchorPostId`）从「可推荐的其它帖子」清单里剔除——影子帖是隐藏的，给出去就是死链。 |
| `src/prompts.mjs` | 新增 `renderWikiList()` 与提示词的 `【站内 Wiki 词条】` 段；recommend 的规则改成**只能从「可推荐的站内帖子」与「站内 Wiki 词条」两份清单里挑**，`documentId` / `wikiId` 必须照抄清单里的编号、标题必须照抄，**编造一律丢弃**（宁可空数组）；「还没写、但值得先学的知识点」改放 `prereq`。 |
| `src/parse.mjs` | `normalizeReview()` 新增 `knownWikiIds` 与 `wikiId` 字段：**`documentId` 与 `wikiId` 两个编号都不在清单里的条目整条丢弃**（不再是"标成 external 留着"）。`external` 字段随之删除。 |
| `public/views/ai.js` | `recommend` 渲染多一条分支：`wikiId` 优先，走 `#/doc/<编号>`（**文档编号不是帖子编号**，wiki 页的影子帖是隐藏的，只能链到积木阅读页），并挂一个「站内 Wiki」标签。 |

**注意编号体系**：本站 `documents.id` 与 `posts.id` 是**两套序列**（wiki 页 `documents/118` 的影子帖是 `posts/142`）。给读者的链接必须用**文档编号**走 `#/doc/…`，所以提示词里两个编号分开列（`[#12]` = 帖子、`[W#118]` = wiki 词条）。

**同步改过的作者文件**（作者更新包时按上面表格重打）：`README.md` 3.1 节的 `recommend` 示例与"关于编号"的说明、`selftest.mjs`（新增 wiki 用例与四条断言）、`selftest-mount.mjs`（断言改成"没有落点的条目被丢掉"）、`examples/demo.mjs`（示例数据与打印格式；`examples/demo-output.json` 是它的产物，改完要重跑一次 `node forum-ai/examples/demo.mjs` 覆盖生成）。

---

## G. 失败篇目的重试优先级 + 失败现场（甲类，本轮新增）

线上 `GET /api/ai/site` 停在 `stats.failed = 3`，点多少次「⚡ 解读未整理的帖子」都修不好。查下来是两个独立的毛病。

### G1（甲类）失败的篇目永远轮不到重试

**现象**：全站 508 篇「从未解读」，那 3 篇失败的排在队尾，批量解读的 `limit` 根本够不到它们 —— 只能手动一篇篇点。

**原因**：`src/store-sqlite.mjs` 的 `pendingDocuments()` 顺序是 `[...never, ...failed, ...stale].slice(0, limit)`，而挂载层 `batchLimit = 10`。

**我们的修法**：顺序改成 `[...failed, ...never, ...stale]` —— 失败的最该优先重试；`stale`（内容变了）仍排最后，不值得抢在「从没解读过」前面。README 里的注释一并改。

### G2（甲类）失败不留现场，事后只能靠猜

**现象**：缓存里只有一句「AI 返回的解读结果不是合法 JSON」。到底是 `max_tokens` 截断、还是正文里的非法转义，无从判断。

**原因**：`src/routes.mjs` 的失败分支只写 `saveReview({ status: 'failed', error: errorText(error) })`；`src/ai.mjs` 抛 `ai_bad_json` 时也没把模型原文带出来。

**我们的修法**：

| 位置 | 改动 |
|---|---|
| `src/ai.mjs` | 新增导出 `rawOutputHead(text)`（折成一行、留前 500 字、附「（全文 N 字）」）；`ai_bad_json` 的三个抛出点（解读 / 整理 / 问答）都挂上 `details.rawOutput` |
| `src/store-sqlite.mjs` | `ai_document_reviews` 新增 `error_detail` 列：`CREATE TABLE` 里加一栏，并对旧库做一次 `PRAGMA table_info` + `ALTER TABLE` 迁移（`CREATE TABLE IF NOT EXISTS` 不会补列）。`shapeReviewRow` 里 `done` 的 `errorDetail` 一律读成空串（重新解读成功即清空现场） |
| `src/routes.mjs` | 新增 `errorDetailText(error)`：取 `error.details.rawOutput`、裁到 600 字；`analyzeDocument` 与 `analyzePending` 的失败分支都把它和 `error` 一起写进缓存/结果 |
| `README.md` | 说明 `error`（一句文案）与 `error_detail`（模型原文前 500 字）的分工 |

**同步改过的作者文件**：`selftest.mjs`（新增「失败也把模型原文存进 errorDetail」「失败的篇目排在从未解读的前面」「待整理顺序：失败 → 从未解读 → 内容已变」「rawOutputHead 截断与折行」「失败现场落库」等断言）、`selftest-mount.mjs`、`scripts/smoke-ai.mjs` 的相应断言。

---

## H. 全站总览「空响应」：上游抖动重试 + 三级降级（甲类，本轮新增）

**现象**：`POST /api/ai/site/analyze`（别名 `/api/ai/corpus/analyze`）在线上连续 502：

```json
{"ok":false,"error":{"code":"ai_empty_response","message":"AI 接口没有返回内容"}}
```

13 秒就返回 —— 不是超时，是上游回了 200 但 `choices[0].message.content` 是空的。`GET /api/ai/site` 里
`report.status = 'failed'`、`report.error = 'AI 接口没有返回内容'`，`stats.corpus` 显示 **554 篇 / 192,389 字符**。

**原因**（两条叠加）：

1. `src/ai.mjs` 的 `chat()` 只发一次请求，空响应直接抛错 —— 上游偶发的空响应没有任何补救。
2. `reviewCorpus` 把「全库正文」塞进一次请求（默认 `charLimit = 60000`）。554 篇的正文有 19 万字符，
   提示词一长，上游就更容易返回空内容。README 里原本把这件事写成「需要自己实现分批汇总」。

**我们的修法**：

| 位置 | 改动 |
|---|---|
| `src/ai.mjs` | 拆出 `chatOnce()`；`chat()` 变成**重试循环**：`isTransient(error)`（空响应 / 连不上 / 超时 / 限流 / 5xx·408·409）才重试，退避 `retryDelayMs × 第几次`；次数 `AI_RETRIES`（默认 2，即最多 3 次请求）、间隔 `AI_RETRY_DELAY_MS`（默认 600），读法统一走 `aiConfig()`。`ai_empty_response` 的 `details` 带上 `finishReason` 与用量 |
| `src/ai.mjs` | 新增内部 `chatJson()`：把「调一次 + 解析 JSON」包成可重试的一步（`ai_bad_json` 默认重试 2 次）；三个能力都改走它 |
| `src/prompts.mjs` | 新增 `SITE_PART_SYSTEM`（分块草案）与 `SITE_MERGE_SYSTEM`（归并成地图）+ `renderSitePartUser` / `renderSiteMergeUser` |
| `src/material.mjs` | 新增 `buildIndexLines(docs)`（一行式目录：`[#12] 《标题》 分类=… 难度=… 板块=… 回复=n`）与 `splitByBudget(items, charLimit, sizeOf)` |
| `src/ai.mjs` | `reviewCorpus` 三级降级：正文塞得下 → 一次问完（`mode='material'`）；超预算 → **只发目录**（`mode='index'`）；目录也超预算 → 按 `chunkChars`（默认 12000）分块出草案再归并（`mode='chunked'`）。某一块失败**不影响整体**（记进 `failures`）；归并没给出分组时退回草案本身。返回值多出 `mode` / `included` / `chunks` / `failures` |
| `src/routes.mjs` | `analyzeCorpus` 把 `mode` / `included` / `chunks` / `failures` 透传给前端；失败时把 `finish_reason` 与用量拼进 `error` 文案（报告表没有 `error_detail` 列，有意不动表结构） |
| `README.md` | 3.2 节说明三级降级与返回值；配置表补 `AI_RETRIES` / `AI_RETRY_DELAY_MS` 与「哪些错误会重试」 |

**一处刻意的克制**：`/api/site` 的 `ai` 对象形状被 `scripts/check-golden.mjs` 冻着（它是「用户能感知到的行为一个字都没变」的硬证据），
所以重试次数**没有**塞进 `aiStatus()` 的顶层字段 —— `envKeys` 里只多了两个变量名（数组，指纹只看类型），要读配置用 `aiConfig()`。
第一版把 `retries` 加进响应，CI 的金标准检查立刻报 `ai:{…,retries:number}` vs 旧指纹，于是改成现在这样。

**顺带修的**：`answerQuestion` 的语料预算 48000 → 24000、`selectForQuestion` 的 `charBudget` 40000 → 24000
（同样是为了别把上游逼到返回空内容）。

**同步改过的作者文件**：`selftest.mjs` 新增 25 项断言（配置与重试参数、空响应重试 / 重试上限 / `AI_RETRIES=0` /
密钥错不重试 / 限流会重试、`buildIndexLines` 与 `splitByBudget`、三级降级各自一次、目录里不含正文、
分块 token 累加、某块失败照样出地图），并给假 AI 服务加了 `emptyTimes` / `failPart` 两个开关；`README.md` 的自测项数
与覆盖清单同步。

---

## I. 全站总览仍然失败：这次是**输出被截断**，不是上游抖动（甲类，本轮新增）

**现象**：重试 + 三级降级上线后，线上 `POST /api/ai/site/analyze` 还是 502 `ai_empty_response`。
但 `GET /api/ai/site` 的 `report.error`（H 节里刚加的那点现场线索）写得很清楚：

```
AI 接口没有返回内容（finish_reason=length，提示 8840 / 生成 3000 tokens）
```

**原因**：`finish_reason=length` + 生成量正好卡在 3000 = **撞上了 `max_tokens` 的墙**，正文还没开始写就没了。
也就是说「重试」这条修法在这里是错的药：同样的预算再问一百遍，还是同样的截断。554 篇的目录一次问一整张地图，
推理型模型把预算先烧在思考上，就轮不到正文了。

**我们的修法**（思路：截断说明「一次问得太多」，那就少问一点 / 多给一点预算，而不是重试）：

| 位置 | 改动 |
|---|---|
| `src/ai.mjs` | 新增 `export function isTruncated(error)`（`ai_empty_response` 且 `details.finishReason === 'length'`），并从 `isTransient()` 里**排除**它 —— 截断一次就放弃，不浪费两次重试 |
| `src/ai.mjs` | 地图类调用（材料 / 目录 / 归并）生成预算 3000 → `CORPUS_MAP_MAX_TOKENS = 6000`；分块草案 1500 → `CORPUS_PART_MAX_TOKENS = 2500` |
| `src/ai.mjs` | 2 级（只发目录）包上 try/catch：**被截断就落到分块**，别在这里整页失败 |
| `src/ai.mjs` | 3 级的每一块被截断时**对半切开再问**（`CORPUS_SPLIT_DEPTH = 3`，最多切到 1/8，再小就是单篇）：问的篇数越少，输出越短，越问得完。切到单篇还截断才算这块失败 |
| `src/ai.mjs` | 归并那一次失败**不抛错**：用各块草案拼出主题与概述（并把 `{ part: 'merge', … }` 记进 `failures`）—— 页面上有分组，总比存一份空地图强 |
| `src/routes.mjs` | `errorHint()` 多带一句「模型只产出了思考内容」（`details.hadReasoning`），下次一眼能分清是「被截断」还是「上游发抖」 |
| `README.md` | 3.2 节补「输出被截断怎么办」 |

**同步改过的作者文件**：`selftest.mjs` 再加 13 项断言（截断一次就放弃、截断现场带 `finish_reason` / 生成量、
`isTruncated` 只认 `length`、目录被截断自动改走分块、地图调用预算 6000、块被截断对半切开后每一片都问得完、
归并失败用草案兜底并把失败记下来、兜底也给概述），假 AI 服务再加 `truncateIndex` / `truncatePartOver`（按
「本部分 N 篇」超过阈值就回截断）两个开关。

### I2（甲类，同日补）半截 JSON 也算截断

这一版上线后线上确实出图了，但响应里 `failures = 6` —— 有 6 片内容被跳过。看现场就知道漏在哪：
模型有时不是「一个字没写」，而是**写了半截 JSON 就被 `max_tokens` 掐掉**，`content` 非空、`extractJson`
解析失败，于是被归成 `ai_bad_json`，而我们只把「正文为空的 `ai_empty_response`」当成截断，
这 6 片既没对半切、也没重试，直接算失败。

**修法**：

| 位置 | 改动 |
|---|---|
| `src/ai.mjs` | `chatOnce()` 的返回值带上 `finishReason`（原来只在报错时才带），这样「解析失败」也能知道是不是被掐断的 |
| `src/ai.mjs` | `isTruncated()` 认两种：`ai_empty_response`（正文空）**或** `ai_bad_json`（半截 JSON），都要求 `finishReason === 'length'` |
| `src/ai.mjs` | `chatJson()` 解析失败时把 `finishReason` / `usage` 记进错误；**被截断就不重问第二遍**（同样预算还是半截），把现场交给调用方去「少问一点」 |
| `src/ai.mjs` | 2 级（只发目录）的兜底从「被截断」放宽到「截断或半截 JSON」——一次问太大问不出合法 JSON，就落到分块去问小片 |

**同步改过的作者文件**：`selftest.mjs` 再 +5 项（半截 JSON 认得出是截断、不重问第二遍、现场留着模型原文、
目录问成半截 JSON 也改走分块、块问成半截 JSON 时对半切开后没有失败块），假 AI 服务再加
`truncateIndexJson` / `truncatePartJsonOver` 两个开关（回半截 JSON + `finish_reason=length`）。

---

## J. 逐篇判过期：「待整理」永远等于全站总数（甲类）

**现象**：`#/ai`「AI 阅读助手」页头同时写着 **563 篇已解读** 和 **563 篇待整理**，黄色提示「论坛内容有更新，这份整理可能已经过时，建议重新整理」也一直亮着。
两个数不可能同时都对：既然全站都解读过了，待整理就不该等于全站；那个「内容有更新」也不是全站一起更新。

**原因**：存解读时写进 `content_hash` 的是 **`store.corpusHash()`** —— 整站语料指纹（`篇数:最新更新时间:回复数:正文总字符数`，见
`src/store-sqlite.mjs` 的 `fingerprintOf()`），而 `pendingDocuments()` 又拿它去跟**当前整站指纹**比。于是论坛里
**任何**一篇帖子或一条回复被写过，全站每一篇的旧解读都同时落进 `stale` 桶 ——「待整理」永远 = 全站总数，
这也让「批量解读」每次都想把 563 篇重跑一遍。线上实测：抽三篇的 `content_hash` 分别是 `554:1791389447994:3:192724`、
`554:1791389447994:3:192724`、`555:1791420236171:3:192534`，而当时整站指纹已经是 `564:…:3:192568` 的口径 —— 三篇都在
「内容已变」里躺着，其实它们自己一个字都没改。

**我们的修法**（区分两种粒度：单篇解读按单篇判，全站报告按整站判）：

| 位置 | 改动 |
|---|---|
| `src/store-sqlite.mjs` | 新增 `export function documentHashes(ids = null)`：返回 `Map<documentId, 指纹>`，对 `corpusDocuments({ withContent: true, withReplies: true, ids })` 里的每一篇跑一次 `fingerprintOf([doc])`（= 这一篇的正文长度 + 它自己的最新更新时间 + 它自己的回复数） |
| `src/store-sqlite.mjs` | 新增 `documentHash(documentId)` 作为单篇快捷方式（`documentHashes([id])` 取不出就回 `''`） |
| `src/store-sqlite.mjs` | `pendingDocuments()` 里 `const hash = api.corpusHash()` 改成 `const hashes = api.documentHashes()`，判断改成 `review.content_hash !== hashes.get(String(row.document_id))` —— 「内容已变化」现在是**这一篇自己**变了 |
| `src/routes.mjs` | `runReview()` 存的是 `store.documentHash(id)`（原来 `store.corpusHash()`）；`getReview()` 返回的 `stale` 同样按 `store.documentHash(id)` 比 |
| `src/store-sqlite.mjs` | `corpusHash()` 与 `reportIsStale()` **有意不动**：「整理全站」的报告本来就是全站粒度，别的帖子新增/改动让报告过期是对的（这一条与页头黄色提示的语义一致） |

改完之后：3 篇已解读、其中 1 篇正文被改过 → 待整理是 1 篇（就是被改的那篇 + 从没解读过的），
不再是全站总数；`/api/ai/site` 的 `stale`（报告过期）仍然是「语料动过就 true」，两者不再互相冒充。

**同步改过的作者文件**：`README.md`（4.2 的接口示例改成 `documentHash(1)` / `documentHashes()`、`saveReview(…, { contentHash: store.documentHash(1) })`；
3.x「缓存与过期」讲清逐篇与整站两种指纹；「批量解读的优先级」顺序与 `LOCAL PATCH G1` 对齐；自测项数同步）、
`selftest.mjs`（+3 项：「每篇有自己的指纹」「新增别篇不让旧解读过期」「这一篇自己变了才回队」，原来那条「内容变化后旧解读算过期」拆成按篇的两条）、
`scripts/smoke-ai.mjs`（+5 项：新积木的影子帖拿得到 id、新增别篇不让老解读过期、新建那篇解读成功、刚解读完自己不算过期、改这一篇自己的 Markdown 才标过期；原来那条「全站整理仍标记过期」保留）。

### J2（甲类，同日补）老账要一次性换成逐篇指纹

只改判据还不够：线上那 563 条解读里存的都是**当时的整站指纹**（`554:…` / `555:…`），
换成按篇比之后它们依然全部对不上，「待整理」还是 563 —— 修完反而看不出变化。

**修法**：`createAiStore()` 建完 store 时跑一次 `api.backfillDocumentHashes()`（幂等）。
逐篇指纹一定以 `1:` 开头（只算一篇），凡是**不以 `1:` 开头**的 `content_hash` 就是老账。旧值反推不出
「这一篇当时」的指纹，只能拿时间戳判：

| 情况 | 处理 |
|---|---|
| 这一篇自己（正文 + 它自己的回复）在**最后一次解读之后没动过** | 直接补上当前逐篇指纹 → 不算过期（这些正是被整站指纹连累的误报） |
| 最后一次解读之后**动过**（正文更新或来了新回复） | 保留旧值 → 继续算「内容已变」，宁可多问一次也不假装它没过期 |
| 索引里已经没有它 | 不动（交给「从未解读 / 已消失」那套逻辑） |

**同步改过的作者文件**：`selftest.mjs`（+6 项：老库的整站指纹会一直算过期、补齐补了几篇、补完就不在待整理里、
补齐幂等、解读之后动过的老账不补、只有真动过的那篇留在待整理；用独立的 `:memory:` 库验，不干扰别的用例）、
`README.md`（4.2 的示例补上 `backfillDocumentHashes()` 与「老库升级」一句）。

---

## K. wiki 页正文进语料（乙类）

**现象**：线上论坛 42 篇真帖 + 522 个 wiki 页影子帖 = 564 篇语料，但 `/api/ai/site` 的 `corpus.chars` 只有 192,568（平均 341 字/篇）。于是「问全站」问 wiki 里的东西（例如「博弈论」）答不出来，`#/ai` 的「搜标题」也搜不到 —— 等于 522 篇 wiki 对 AI 只留了个标题。

**原因**：wiki 页的正文在 `doc_settings.source_text`，而它的影子帖 `posts.content` 只存了**页面前 400 字的纯文本**
（宿主 `src/modules/doc/store.js` 的 `syncDocumentAnchor()` 写的是 `blocksToPlainText(liveBlocks, 400)`）。
包内语料源 `createForumDocumentSource()` 读的正是 `posts.content`，所以 AI 只看到每页开头那 400 字。

**我们的修法**（宿主的影子帖不动；包内语料源优先用整页正文）：

| 位置 | 改动 |
|---|---|
| `src/mount.mjs` | 新增 `pickPageText(db)`：探测 `documents JOIN doc_settings`（`template = 'page'`、`anchor_post_id > 0`，有 `deleted` / `scope` 就再排除掉删除与非公开的），返回 `(limit) => Map<影子帖 id, { text, updatedAt }>`；`text` 是 `source_text` 截到 `limit`，`updatedAt` 取文档与 `doc_settings` 里较新的那个；探测不到表就回 `null`（老库/别的宿主照旧） |
| `src/mount.mjs` | `createForumDocumentSource()` 拼每一篇时：**页面正文比影子帖摘要长就用页面正文**（短或为空就保持原样，零回归）；`updatedAt` 取两者较大值 —— 改了页这一篇的逐篇指纹就变，旧解读自然回「待整理」（J 节的判据） |

**同步改过的作者文件**：`selftest-mount.mjs` 新增「▶ wiki 页正文进语料」7 项（整页正文替换摘要、页面自己的修改时间进 `updatedAt`、
页正文更短时保留摘要、普通帖一字不变、影子帖不存在的页不会凭空多出一篇、宿主没有积木表时语料照旧）；
`README.md` 的「语料从哪来」同步成「wiki 页用整页正文」。

---

## L. 问答的输出预算写死 1200（甲类）

**现象**：线上 `#/ai`「问全站」对宽问题**一律 502**，前端显示「服务器开小差了，请稍后再试」；同一个框问「Markdown 是什么」能成，
问「博弈论」就失败。实测：成功的全站问答 `completion = 992` tokens —— **已经贴着 1200 的墙**；失败例 5.4 秒返回 `ai_empty_response`
（上游 200、正文为空、`finish_reason=length`），不是网络抖动。

**原因**：`src/ai.mjs` 的 `answerQuestion()` 把 `maxTokens` 写死成 **1200**（别的调用都走 `aiConfig()` 的 `AI_MAX_TOKENS`，默认 2000）。
全站问答要吐一段结构化 JSON（答案 + 引用 + 备注 + 置信度），宽问题还没写完正文预算就烧光了 —— 与 I / I2 节同源。

**我们的修法**（同一思路：截断说明「问得太多 / 预算太小」，重试没用）：

| 位置 | 改动 |
|---|---|
| `src/ai.mjs` | 问答预算改成 `askMaxTokens(env)`：读 `AI_ASK_MAX_TOKENS`，默认 3000。**故意不列进 `aiStatus().envKeys`** —— `/api/site` 的 ai 形状被宿主 `check-golden` 冻着 |
| `src/ai.mjs` | 被截断（`isTruncated`）且材料不止一篇时：**材料砍半 + 预算加倍**（上限 8000）重问一次；再被截断就抛 `ai_answer_truncated`（文案是给用户看的：把问题问得具体一点，或选中某一篇再问） |
| `src/routes.mjs` | `AI_ERROR_STATUS` 加 `ai_answer_truncated: 503` |
| 宿主 `public/core/errors.js` | `ai_*` 的失败文案**原样透出**：原来 5xx 一律换成「服务器开小差了，请稍后再试」，把「AI 还没配置」「这次的资料太多…」这些照着能做的事都糊掉了 |

**同步改过的作者文件**：`selftest.mjs` 新增「▶ 问答预算与截断自适应」9 项（默认预算 3000、`AI_ASK_MAX_TOKENS` 生效、
`envKeys` 里没有它、截断后砍半重问且预算加倍、重问的材料更短、两次都截断时抛 `ai_answer_truncated`、单篇不重问）；
`scripts/smoke-ai.mjs` 新增 6 项（问答请求 `max_tokens = 3000`、截断后重问一次且预算是 6000、材料更短、两次都截断时 503 `ai_answer_truncated`、
提示里告诉用户怎么办）；`README.md` 问答一节补预算与自适应。

---

## M. 没有语料检索：「搜标题」搜不到 wiki，也搜不到正文（乙类）

**现象**：`#/ai` 页头那个框写着「搜标题…」，但它只是**在前端已经渲染出来的前 30 行上按标题过滤**
（宿主 `public/views/ai.js` 的 `AI_LIST_LIMIT = 30`），而这份列表又只来自 `/api/ai/site` 报告里 `readingPath` + `topics[].documentIds`
去重后的 80 条。于是在线上：wiki 词条搜不到（它们大多不在报告列表里），**就算在，也只能按标题搜 —— 正文里写了什么都搜不出来**。
用户原话：「这里的搜索无法搜到wiki」。K 节把整页正文喂进了语料之后，这一条就变成明摆着的缺口：内容有了，没有检索的入口。

**原因**：作者包**根本没有检索接口** —— `createAiRouter()` 只暴露 `GET /status`、`GET /posts/:id`、`POST /posts/:id/analyze`、
`POST /posts/analyze-pending`、`GET /site`、`POST /site/analyze`、`DELETE /site`、`DELETE /cache`、`POST /ask`（AI 侧没有 search 路由）。
语料只被当成「喂给模型的材料」，从来没被当成一个可以查的库。

**我们的修法**（不改宿主语料，只在包内加一条只读检索 + 宿主前端接上）：

| 位置 | 改动 |
|---|---|
| `src/store-sqlite.mjs` | 新增 `excerptAround(text, at, matchLength, { width = 50, max = 160 })`（命中处左右各 50 字、截 160、两端补 `…`）与 api `searchCorpus({ query, limit })`：遍历 `ai_corpus_index` 的标题 + 正文做大小写无关子串匹配，返回 `{ query, documents, total, items: [{ id, title, board, author, replyCount, updatedAt, inTitle, snippet }] }`；排序 = 标题命中（越靠前越优先）→ 正文命中（越靠前越优先）→ 回复多的；`limit` 夹 1..50 |
| `src/routes.mjs` | 新增 `GET /search?q=&limit=`（**要登录**）：handler 的 ctx 里没有 query 字段，所以自己从 `ctx.req.url` 解析；两字以下只回 `{ minLength: 2, total: 0, items: [] }`；每个命中项附 `wiki: true/false`（用 `wikiPageList()` 的影子帖 id 集合判断），前端据此画「Wiki 词条」小标 |
| `src/mount.mjs` | 路由表加 `['GET', `${basePath}/search`, handlers.search, false]` |
| 宿主 `public/views/ai.js` | 输入框占位改成「搜标题或正文…」，新增 `aiSearchHitsHtml()` / `aiSearchHitHtml()` 与 `<div class="ai-hits" data-ai-hits hidden></div>` 落点 |
| 宿主 `public/core/events.js` | 本地按标题过滤照旧（列表不必等后端），另加 250ms 防抖的后端检索；回来时输入已变就丢弃；失败把原因写进结果卡的头一行 |
| 宿主 `public/css/95-ai.css` | `.ai-hits` / `.ai-hit` / `.ai-hit-tag` 等一整套样式 |

**同步改过的作者文件**：`selftest.mjs` 在「▶ SQLite 存储层」加 7 项（正文命中、命中片段、语料总数、标题命中优先、板块与回复数、limit 只截条数、空关键词）；
`selftest-mount.mjs` 加「▶ 语料检索」7 项（200、正文命中、片段、标题命中、limit、两字以下 `minLength`、未登录 401）；
`scripts/smoke-ai.mjs` 加 6 项（同样这几种，走真实 HTTP）；宿主 `scripts/check-frontend.mjs`（`#/ai` 渲染出的 `data-ai-hits` / 新占位 / 老的本地过滤钩子）
与 `scripts/check-ui-contract.mjs`（真的打到 `/api/ai/search`、有防抖与最短长度、结果有落点）各加守卫；`README.md` 接口表补 `GET /search`。

---

## N. 问答的回答挤成一大段：提示词没要结构，宿主也只把换行换成 `<br />`（甲类 + 乙类）

**现象**：线上「问全站」的回答读不动。实测「博弈论」那一次：`answer` **1540 字、换行 0 个** ——
`**1. 博弈论是什么** … - 合作/非合作博弈：… - 对称/非对称博弈：… [#365]` 全部挤在同一行里；
宿主再 `esc()` 一遍、只把 `\n` 换成 `<br />`，于是 `**` 标记、列表符号、引用编号都原样露在正文里。
用户原话：「格式能好看一点吗，可读性强一点」。

**原因**（两头都有）：

- **甲类**：`src/prompts.mjs` 的 `ASK_SYSTEM` 只写了「中文回答，条理清晰」，从没要求分段 / 小标题 / 列表 ——
  模型于是把整篇答案写成一个 JSON 字符串，一个换行都没有；
- **乙类**：宿主 `public/views/ai.js` 的 `aiAnswerHtml()` 只有 `${esc(data.answer).replace(/\n/g, '<br />')}`，
  既没有 Markdown 渲染，也没有排版样式。

**我们的修法**：

| 位置 | 改动 |
|---|---|
| `src/prompts.mjs` | `ASK_SYSTEM` 增加「answer 的排版」5 条：先用一两句给结论再展开；小节标题**单独占一行**（`**小节标题**`，需要时带序号）；并列要点写成 `- ` 一条一行；段落之间空一行（JSON 里就是 `\n\n`）；不用表格、非必要不用代码块；`[#编号]` 紧跟对应那句话 |
| 宿主 `public/views/ai.js` | 新增 `aiNormalizeAnswerMd()` / `aiAnswerBlocks()` / `aiAnswerBodyHtml()` / `aiInlineHtml()` / `aiCiteChips()`：先还原「模型把结构全写在一行里」（编号小标题、短加粗+冒号、行内 `- ` 要点前面断开 —— 整段出现两次以上 `- ` 才当列表，免得 `a - b` 这种减法被拆），再按块渲染段落 / 小标题 / 有序无序列表 / 引用 / 代码 / 分隔线；行内渲染 `**粗体**`、`` `代码` ``、Markdown 链接，并把 `[#37]`、`[#37, #42]` 变成可点的出处小标 |
| 宿主 `public/views/ai.js` | 回答卡片顶部多一行「你的问题」（用后端本来就返回的 `data.question`） |
| 宿主 `public/css/95-ai.css` | `.ai-answer-q` / `.ai-p` / `.ai-h2~4` / `.ai-answer-list` / `.ai-quote` / `.ai-pre` / `.ai-rule` / `.ai-code` / `.ai-link` / `.ai-inline-cite` 一整套；正文 `max-width: 78ch`、行高 1.9 |

**同步改过的作者文件**：`scripts/smoke-ai.mjs` 加 2 项（问答提示词里真的有「answer 的排版」「小节标题单独占一行」「`- ` 开头的列表」）；
宿主 `scripts/check-ui-contract.mjs` 加 3 项（回答走 `aiAnswerBodyHtml`、出处标 `ai-inline-cite`、不再用 `<br />` 顶替分段）。

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
| `node forum-ai/selftest-mount.mjs` | 通过 49 项，失败 0 项 |
| `node forum-ai/selftest.mjs` | 通过 177 项，失败 0 项 |
| `node scripts/smoke-ai.mjs` | 通过 84 项，失败 0 项 |
| `node scripts/smoke.mjs` | 通过 237 项，失败 0 项 |
| `node scripts/check-golden.mjs` | 通过 88 项，差异 0 项（对外行为与改造前一致） |
| `node scripts/check-ui-contract.mjs` | 通过 325 项（下限 317），问题 0 项 |
| `node scripts/check-encoding.mjs` | 已检查 210 个文件（下限 205），中文片段断言 84 条 |

合计 **960 项**（2026-10 复跑实测；数量随轮次增删会变，以各脚本自己打印的下限为准）。另外 `node scripts/check-encoding.mjs` 在 Linux 上会报 `ENOENT ... start.cmd` —— 它硬编码要检查 `start.cmd`（Windows 专用文件、故意不上传），**这个失败是预期的，不是问题**。
