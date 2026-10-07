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
| `node forum-ai/selftest-mount.mjs` | 通过 35 项，失败 0 项 |
| `node forum-ai/selftest.mjs` | 通过 146 项，失败 0 项 |
| `node scripts/smoke-ai.mjs` | 通过 65 项，失败 0 项 |
| `node scripts/smoke.mjs` | 通过 238 项，失败 0 项 |
| `node scripts/check-golden.mjs` | 通过 88 项，差异 0 项（对外行为与改造前一致） |
| `node scripts/check-ui-contract.mjs` | 通过 317 项（下限 317），问题 0 项 |
| `node scripts/check-encoding.mjs` | 已检查 207 个文件（下限 205），中文片段断言 84 条 |

合计 **801 项**（2026-10 复跑实测；数量随轮次增删会变，以各脚本自己打印的下限为准）。另外 `node scripts/check-encoding.mjs` 在 Linux 上会报 `ENOENT ... start.cmd` —— 它硬编码要检查 `start.cmd`（Windows 专用文件、故意不上传），**这个失败是预期的，不是问题**。
