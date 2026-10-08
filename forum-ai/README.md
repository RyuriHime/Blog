# forum-ai · 可复用的 AI 内容理解层

给一堆**文档**，它返回结构化结论：

| 能力 | 输入 | 输出 |
| --- | --- | --- |
| `reviewDocument` | 一篇文档 + 可推荐的其它文档 | 分类 / 难度 / 摘要 / 标签 / **前置知识** / **推荐阅读** |
| `reviewCorpus` | 全部文档 | 主题分组 + **推荐阅读路线** + 全景概述 |
| `answerQuestion` | 问题 + 允许使用的材料 | 答案 + **引用出处** + 备注 + 置信度 |

**零依赖**（只用 Node 内置模块）、**OpenAI 兼容**（DeepSeek / OpenAI / 任何兼容网关）、**密钥只在服务端**。
目录可以整个拷给别人，不需要 `npm install`，没有构建步骤。

---

## 1. 环境要求

- Node.js **18+**（用到内置 `fetch`；SQLite 缓存层需要 **22.5+** 的 `node:sqlite`）
- 一个 OpenAI 兼容的 API key（不配也能跑，但所有能力会抛出 `ai_not_configured`）

## 2. 快速开始

```bash
export AI_API_KEY=sk-xxx          # Windows: set AI_API_KEY=sk-xxx
node examples/demo.mjs            # 用假的 AI 服务跑一遍全流程，产出 examples/demo-output.json
node selftest.mjs                 # 151 项自测
```

最小代码（不需要数据库、不需要 HTTP）：

```js
import { reviewDocument, answerQuestion } from './src/index.mjs';

const doc = { id: 2, title: 'Node.js 内置 SQLite 实践', content: '正文 Markdown…' };
const others = [{ id: 5, title: 'SQLite 分页优化', summary: '深分页变慢怎么办' }];

const { review } = await reviewDocument(doc, others);
console.log(review.category, review.difficulty, review.tags, review.prereq, review.recommend);

const { answer } = await answerQuestion('这个方案省掉了什么？', [doc], { scope: 'document' });
console.log(answer.text, answer.citations, answer.confidence);
```

### 配置项（环境变量）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `AI_API_KEY` | 无 | 必填；未配置时所有能力抛 `AiError('ai_not_configured')` |
| `AI_BASE_URL` | `https://api.deepseek.com/v1` | 兼容网关地址（不要带 `/chat/completions`） |
| `AI_MODEL` | `deepseek-chat` | 模型名 |
| `AI_TIMEOUT_MS` | `60000` | 单次请求超时 |
| `AI_MAX_TOKENS` | `2000` | 单次回复上限（全库整理内部会调到 3000） |
| `AI_ASK_MAX_TOKENS` | `4000` | 问答（`answerQuestion`）的输出上限；被截断时会把材料缩到三分之一、预算用满 8000 再问一次 |
| `AI_RETRIES` | `2` | 上游抖动时的重试次数（共 `1 + n` 次请求）；`0` 表示不重试 |
| `AI_RETRY_DELAY_MS` | `600` | 重试间隔基数，第 n 次重试前等 `n × 该值` |

**哪些错误会重试**：200 但内容为空（`ai_empty_response`）、连不上（`ai_unreachable`）、超时（`ai_timeout`）、
限流（`ai_rate_limited`）、5xx/408/409。**不会重试**：密钥错（`ai_unauthorized`）、返回的不是 JSON、
未配置。重试到上限仍然失败时抛最后一个错误（`ai_empty_response` 会把 `finish_reason` 与用量挂在 `details` 上）。

也可以不读环境变量，直接给每次调用传 `chatOptions.env`：

```js
await reviewDocument(doc, [], { chatOptions: { env: { AI_API_KEY: 'sk-x', AI_MODEL: 'gpt-4o-mini', AI_BASE_URL: 'https://api.openai.com/v1' } } });
```

## 3. 数据结构

### 3.1 单篇解读 `review`

```jsonc
{
  "category": "数据库",              // 固定词表，见 prompts.mjs 的 CATEGORY_HINT
  "difficulty": "进阶",              // 入门 | 进阶 | 深入
  "summary": "实测 Node.js 内置 SQLite……",
  "tags": ["Node.js", "SQLite", "零依赖"],
  "prereq": [                        // 前置知识
    { "name": "JavaScript 基础", "why": "读懂示例代码", "level": "入门" }
  ],
  "recommend": [                     // 推荐阅读：只能落在真实存在的篇目上
    { "documentId": 5, "wikiId": null, "title": "SQLite 分页优化", "reason": "同主题性能侧", "relation": "延伸" },
    { "documentId": null, "wikiId": 118, "title": "string", "reason": "先看 STL 定义", "relation": "先读" }
  ]
}
```

> **关于 `recommend` 的编号**：每一条都必须落在本次给出的两份清单里 ——
> `documentId` 来自「可推荐的站内帖子」，`wikiId` 来自「站内 Wiki 词条」（宿主接的是本站积木模块的
> `documents` 表，编号是**文档编号**，UI 走 `#/doc/<编号>`，因为 wiki 页的影子帖是隐藏的）。
> 两个编号都不成立的条目**整条丢弃**：模型自己编的《XX 指南》《XX 手册》这类没有落点的标题不会进结果，
> 宁可 `recommend` 是空数组。想推荐「还没写、但值得先学的知识点」就放进 `prereq`。

### 3.2 全库整理 `report`

```jsonc
{
  "summary": "……全景概述……",
  "topics": [
    { "name": "Node 零依赖全栈", "summary": "…", "difficulty": "进阶",
      "documentIds": [2, 5], "prereq": ["JavaScript 基础", "SQL 基本语法"], "order": 1 }
  ],
  "readingPath": [
    { "documentId": 1, "title": "先读版规", "reason": "了解社区约定", "level": "入门" }
  ],
  "dropped": { "topics": 1, "readingPath": 1 }   // 被过滤掉的编造条目数
}
```

`documentIds` 里不存在的编号会被剔除；编号全假的主题会被整组丢弃。

**站点变大之后**：把全库正文塞进一次请求，上游会返回 200 但**内容为空**（提示词一长就容易踩到）。
所以 `reviewCorpus` 会自己三级降级，返回值里带上走的是哪一条路：

```jsonc
{
  "report": { /* 同上 */ },
  "model": "deepseek-chat",
  "usage": { "prompt": 15234, "completion": 2312 },
  "mode": "material",      // material=正文塞得下一次问完 | index=只发目录 | chunked=分块整理再归并
  "included": 554,         // 这次实际覆盖到的文档数
  "truncated": false,
  "chunks": 12,            // 仅 chunked：分成几块
  "failures": [{ "part": 3, "count": 50, "error": "…" }]   // 仅 chunked：哪几块整理失败了
}
```

- **index**：正文超预算时改用「编号 + 标题 + 归类」的一行式目录（`buildIndexLines`），
  全库整理要的本来就是「有哪些文档、各属于什么方向」，554 篇的目录只有 1.7 万字符。
- **chunked**：目录也超预算时按 `chunkChars`（默认 12000）分块，每块出一份分组草案（`SITE_PART_SYSTEM`），
  再用 `SITE_MERGE_SYSTEM` 把草案归并成最终地图；**某一块失败不影响整体**（记进 `failures`），
  归并没给可用分组时退回草案本身，宁可地图糙一点也别只剩一份空报告。

**输出被 `max_tokens` 截断时**（`finish_reason=length`；推理型模型很容易踩到，表现是正文为空，或者**只写了半截 JSON**）：

- 截断**不重试** —— 同样的预算再问一遍还是同样的结果；`isTruncated(error)` 认这两种情况
  （`ai_empty_response` 正文空 / `ai_bad_json` 半截 JSON）；
- 「只发目录」被截断（或只写回半截 JSON）时自动**落到分块**；
- 分块里某一块被截断时把它**对半切开再问**（最多切到单篇），问的篇数越少越问得完；
- 归并那一次失败时用**各块草案**拼出主题与概述，并把 `{ "part": "merge", … }` 记进 `failures`；
- 地图类调用（材料 / 目录 / 归并）的生成预算给到 6000，分块草案 2500（`CORPUS_MAP_MAX_TOKENS` /
  `CORPUS_PART_MAX_TOKENS`），都能自己调。

### 3.3 问答 `answer`

```jsonc
{
  "text": "材料里 [#2] 说明……",
  "citations": [{ "documentId": 2, "title": "…", "quote": "省掉第三方依赖" }],
  "notes": ["先把 SQL 索引补上"],
  "confidence": "high",              // high | medium | low
  "droppedCitations": 1              // 被过滤掉的编造引用数
}
```

**问答的预算**：`answerQuestion` 的输出上限默认 4000（`AI_ASK_MAX_TOKENS`），比单篇解读高 ——
它要吐答案 + 引用 + 备注 + 置信度，宽问题很容易把预算烧光。**被截断时**（`isTruncated`，材料不止一篇）
它会自己把材料缩到**三分之一**、预算用满（上限 8000）再问一次，并且**在提问末尾加一句【上一次】**：
上次是被预算掐断的、这次只给要点、要代码就给 20 行以内的片段、`answer` 控制在 400 字以内
（实测「想学习dfs，然后实现成代码」这种要代码的宽问题：3000/6000 两次都被掐断，问题不在材料而在答案本身太长）；
仍然被截断就抛 `ai_answer_truncated`（文案是给用户看的：把问题问得具体一点，或选中某一篇再问），
而不是把上游的空响应直接甩出去。

**answer 的排版**：`ASK_SYSTEM` 明确要求 `text` 是带结构的 Markdown —— 先用一两句给结论，
小节标题单独占一行（`**小节标题**`，可带序号），并列要点写成 `- ` 一条一行，段落之间空一行
（JSON 里就是 `\n\n`），`[#编号]` 紧跟对应那句话，**并且整篇 answer 控制在 800 字以内**、
要写代码时只给 20 行以内的最小片段（不给多份变体）、`citations` 最多 8 条
（给「够用的结论 + 关键细节」，不是复述材料 —— 这样既不截断也快）。宿主照 Markdown 渲染即可；
不这么要求时模型会把 1500 字连标点都摊在一行里（见 `LOCAL-PATCHES.md` N 节）。

**问全站怎么选材**（见 `LOCAL-PATCHES.md` O 节）：`questionTerms()` 把问题切成检索词，
`rankDocuments()` 按 **标题 20 / 小标题 9** / 标签 8 / 摘要 6 / 分类 5 / 正文 2 / 回复 1 打分，
`selectForQuestion()` **先收标题与小标题命中的篇目**（有强命中时纯正文命中最多再补 `maxWeak = 2` 篇，默认
`charBudget = 11000`、`maxDocuments = 6`），`buildMaterial()` 再按 `contentPerDoc` 从**命中处**截正文
（`excerptAroundFocus`）并把命中的小标题列成 `相关小节：A / B` 附上。全站问答的材料上限是 12000 字符、
每篇 1600 字符；单篇问答仍是整篇（16000）。

## 4. 接入自己的后端

### 4.1 只用能力层（最省事）

```js
import { reviewDocument, reviewCorpus, answerQuestion, selectForQuestion, aiStatus } from 'forum-ai';
```

把文档查出来传进去即可，本层不关心你的存储。

### 4.2 加上 SQLite 缓存层

本包**不读你的业务表**，它自己维护一份语料索引，通过 `documentSource` 同步：

```js
import { DatabaseSync } from 'node:sqlite';
import { createAiStore } from 'forum-ai/store-sqlite';

const db = new DatabaseSync('./data/app.db');
const store = createAiStore({
  db,
  documentSource: () => posts.map((post) => ({          // 返回你的文档数组
    id: post.id,
    title: post.title,
    content: post.body,                                  // Markdown 正文
    replies: post.replies ?? [],                         // 可选，会一起进材料
    createdAt: post.created_at,
    updatedAt: post.updated_at,
  })),
  tablePrefix: 'ai_',                                    // 可选，默认 ai_
});

store.syncCorpus();                    // 业务数据变化后调用一次
store.corpusHash();                    // 整站语料指纹：变了说明「全站整理」的报告过期
store.documentHash(1);                 // 单篇指纹：这一篇自己的正文/回复变了才变
store.documentHashes();                // Map<documentId, 单篇指纹>
store.pendingDocuments({ limit = 10 }); // 待整理：失败过 → 没解读过 → 这一篇自己变了
store.saveReview({ documentId: 1, status: 'done', category: '数据库', /* … */ }, { contentHash: store.documentHash(1) });
store.reviewOf(1);
store.latestReport();
store.clearAll();
```

**`documentSource` 给的 `content` 就是语料本身**：包只看得见你返回的这段文字 —— 检索打分、
问答材料、指纹都基于它。所以别喂摘要或占位（比如「页面前 400 字」这种），要喂**整篇正文**；
文档正文存在别处（比如另建了页面表的宿主）时，请在 `documentSource` 里就把它拼进来。

老库升级：`createAiStore()` 建 store 时会跑一次 `store.backfillDocumentHashes()`（幂等）——
历史数据里若存的是**整站**指纹（早于「逐篇判过期」那版写下的），就在这里换成这一篇自己的指纹：
这篇自己（正文 + 它的回复）在最后一次解读之后没动过的直接补上，动过的保留原值继续算「内容已变」。

建表由 `createAiStore` 自动完成（`ai_document_reviews` / `ai_corpus_reports` / `ai_corpus_index`）。
`ai_document_reviews` 里除了 `error`（一句错误文案），还有 `error_detail`（**模型原始输出的开头 500 字**）——
解读失败时两栏都会写上，重新解读成功时清空。有了它，事后能直接看出失败是 `max_tokens` 截断、
还是字符串里带了非法转义，不用靠猜（`ai_bad_json` 的 `AiError.details.rawOutput` 就是往这里落的）。

### 4.3 直接用 HTTP 处理器（框架无关）

处理器返回 `{ status, body }`，不碰 `req`/`res`，可以挂到任何框架：

```js
import { createAiHandlers, createAiRouter } from 'forum-ai/routes';

const handlers = createAiHandlers({
  store,
  getDocument: (id) => myRepo.find(id),
  currentUser: (ctx) => ctx.user ?? null,
  isAdmin: (ctx) => ctx.user?.role === 'admin',
  beforeWrite: async (ctx) => { /* 限流、审计 */ },
  batchLimit: 10,
});

const route = createAiRouter(handlers);   // 默认前缀 /api/ai

// 原生 node:http
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const body = ['POST', 'PUT'].includes(req.method) ? await readJson(req) : {};
  const result = await route({ method: req.method, pathname: url.pathname, body, user: await currentUser(req) });
  if (!result) return notFound(res);
  res.writeHead(result.status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(result.body));
});
```

| 方法 | 路径 | 说明 | 权限 |
| --- | --- | --- | --- |
| GET | `/api/ai/status` | AI 是否已配置（不回传密钥） | 公开 |
| GET | `/api/ai/documents/:id` | 读取缓存解读 + 是否过期 | 公开 |
| POST | `/api/ai/documents/:id/analyze` | 生成/刷新单篇解读 | 登录 |
| POST | `/api/ai/documents/analyze-pending` | 批量解读待整理，`{ limit ≤ 50 }` | 管理员 |
| GET | `/api/ai/corpus` | 整理结果 + 主题分组 + 阅读路线 + 统计 | 登录 |
| POST | `/api/ai/corpus/analyze` | 重新整理全库 | 管理员 |
| DELETE | `/api/ai/corpus` | 清空解读与报告缓存 | 管理员 |
| POST | `/api/ai/ask` | 问答，`{ question, documentId? }` | 登录 |
| GET | `/api/ai/search?q=&limit=` | 语料检索（标题 + 正文，`q` 至少 2 字） | 登录 |

统一响应：成功 `{ ok: true, data }`，失败 `{ ok: false, error: { code, message } }`。
错误码与状态码的映射见 `routes.mjs` 的 `AI_ERROR_STATUS`：

| 错误码 | HTTP | 含义 |
| --- | --- | --- |
| `ai_not_configured` | 503 | 没配 `AI_API_KEY` |
| `ai_timeout` | 504 | 上游超时（可调大 `AI_TIMEOUT_MS`） |
| `ai_unreachable` | 502 | 连不上上游 |
| `ai_unauthorized` | 502 | 密钥无效或无权限 |
| `ai_rate_limited` | 429 | 上游限流/额度不足 |
| `ai_bad_json` | 502 | 模型没按 JSON 输出（已尝试容错仍失败） |
| `ai_upstream_error` | 502 | 其它上游错误 |

## 5. 算法与工程细节

- **提示词与调用分离**：`prompts.mjs` 只放指令与渲染函数，想换输出结构，改它 + `parse.mjs` 的归一化即可，`ai.mjs` 不用动。
- **JSON 容错**：兼容 ```json 代码块、前后夹带说明、以及截取第一个平衡花括号块；仍失败才抛 `ai_bad_json`。
- **材料预算**：`buildMaterial` 按字符预算拼材料并截断，第一篇永远保留；超预算时先截断长正文，不会出现空材料。
- **检索**：`rankDocuments` 是零依赖的关键词打分（标题 12 / 标签 8 / 摘要 6 / 分类 5 / 正文 3 / 回复 2，叠加热度与新鲜度）；`selectForQuestion` 在预算内按分数取前 N 篇，语料小的时候等于全量。
- **缓存与过期**：**逐篇**指纹 = 这一篇的正文/回复/更新时间（`documentHash(id)`）；**整站**指纹 = 文档数 + 最新更新时间 + 回复数 + 正文总字符数（`corpusHash()`）。单篇解读只按前者判过期（`stale: true`），「全站整理」的报告按后者判（别的帖子新增/改动也算报告过期）。
- **失败不污染缓存**：「没配密钥」不写入缓存；上游故障写入 `status: 'failed'` 并保留错误信息，便于排查。
- **批量解读的优先级**：解读失败 → 没解读过 → 这一篇自己变了；上游整体故障时立即返回部分结果（`partial: true`），不会把剩下的都试一遍。
- **并发安全**：同一文档重复解读是覆盖写（`ON CONFLICT DO UPDATE`）；批量为串行，避免把上游打爆。

## 6. 自测覆盖（192 项，无需真实密钥）

```
▶ 配置与降级      未配置抛错、状态不含密钥、映射成 503
▶ JSON 容错       代码块 / 前后夹带 / 嵌套 / 字符串内花括号 / 非法输入
▶ 归一化          枚举回落、长度限制、缺摘要兜底、**编号幻觉过滤**、数量截断
▶ 材料装配        预算截断、首篇保留、可关回复、**一行式目录**、命中处截取（带 `…` 与 `相关小节：`）
▶ 三个能力        字段与用量、推荐编号校验、引用过滤
▶ 上游抖动        空响应自动重试、重试上限、AI_RETRIES=0、密钥错不重试、限流会重试
▶ 上游错误        401/429/500 → 稳定错误码与状态码
▶ 分级降级        小站一次问完 / 大站只发目录（正文绝不进提示词）/ 超大站分块 + 归并 / 某块失败照样出地图
▶ 输出截断        不重试（只打一次上游）/ 半截 JSON 也算截断 / 目录截断自动落分块 / 块截断对半切开 / 归并失败用草案兜底
▶ 问答预算        默认 4000（不再是写死的 1200）/ AI_ASK_MAX_TOKENS 生效 / 截断后缩到三分之一重问、重问要求短答案（【上一次】）、再截断抛 ai_answer_truncated / 单篇不重问 / 提示词要求 answer 自带结构（分段、小标题单独一行、`- ` 列表）与 800 字上限 / 全站材料压在 12000 字以内
▶ 检索选择        命中排序（**标题 > 小标题 > 正文**）、有强命中时弱命中只补 2 篇、长文档不再一票吃光预算、小标题抽取、问题分词、预算控制、空问题
▶ 语料检索        标题命中（inTitle）/ 正文命中 / 命中片段带上下文 / limit 只截返回条数 / 空关键词
▶ SQLite 缓存     索引同步、逐篇指纹与整站指纹、缓存读写、过期判定（新增别篇不算过期）、老库补齐逐篇指纹、批量优先级、失败现场落库
▶ HTTP 处理器     未登录 401、非管理员 403、未配置 503 且不写脏缓存、404、
                  问答 scope、参数校验、清缓存、**上游故障的部分失败语义**
```

## 7. 已知限制

- **没有向量检索**：问答选材靠关键词打分（`questionTerms` + 标题/小标题/正文分层权重），同义改写（「性能」vs「速度」）不会互相命中。要语义检索，把 `rankDocuments` 换成你的向量召回即可，其余不用动。
- **中文分类靠模型**：`category` 依赖提示词里的固定词表，模型偶尔会给出词表外的值，此时回落成「其他」。
- **单轮对话**：问答是无状态的一次性调用，没有多轮上下文与追问。
- **材料上限**：单篇解读正文截断到 3000 字/篇（`buildMaterial` 的 `contentPerDoc`），全库整理总预算 24000 字符；
  问答另有一套：全站问答材料上限 12000 字符、每篇 1600 字符（从命中处截取），单篇问答整篇 16000 字符。
  超预算时会自动退到「只发目录」或「分块整理再归并」（见 3.2），不需要自己实现分批汇总。
- **一次整理的耗时**：`index` 是一次请求；`chunked` 是 `块数 + 1` 次，站点很大时会明显变慢（逐块串行）。
- **token 计费**：全库整理是最贵的一次调用（所有文档都要进上下文），建议在管理后台手动触发。

## 8. 目录结构

```
forum-ai/
├── src/
│   ├── index.mjs         # 统一出口（推荐 import 这个）
│   ├── ai.mjs            # 三个能力 + chat + 检索选择
│   ├── prompts.mjs       # 提示词（可替换）
│   ├── parse.mjs         # JSON 容错 + 归一化 + 幻觉过滤
│   ├── material.mjs      # 材料装配与预算截断
│   ├── store-sqlite.mjs  # SQLite 缓存层（自带索引表，不读宿主业务表）
│   └── routes.mjs        # 框架无关的 HTTP 处理器 + 路由器
├── examples/
│   ├── demo.mjs          # 端到端演示（自带假 AI 服务）
│   └── demo-output.json  # 演示产物：真实数据结构长什么样
├── selftest.mjs          # 151 项自测
└── README.md
```

## 9. 谁在用

- **格社**（同仓 `../`）：用它做「AI 阅读助手」——帖子详情页的解读与「就这篇提问」、`#/ai` 页的全站知识地图与「问全站」。
  论坛侧只保留了一个薄接线层 `../src/ai.js`（把 post/document 词汇与 `postId`/`documentId` 字段名对齐），算法与提示词全部来自本包。

> 该演示站点的 AI 界面（`#/ai`、帖子页 AI 区块）的 HTML/CSS 没有打进本包，因为那部分和站点框架强耦合；本包交付的是**能力 + 缓存 + HTTP 契约**这三层可直接复用的部分。
