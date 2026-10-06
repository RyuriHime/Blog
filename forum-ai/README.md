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
node selftest.mjs                 # 92 项自测
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
  "recommend": [                     // 推荐阅读
    { "documentId": 5, "external": false, "title": "SQLite 分页优化", "reason": "同主题性能侧", "relation": "延伸" },
    { "documentId": null, "external": true, "title": "（库里没有的推荐）", "reason": "…", "relation": "对比" }
  ]
}
```

> **关于 `recommend` 的编号**：编号必须来自本次材料。模型编造的编号会被清成 `documentId: null` 并标 `external: true`，宿主的 UI 看到 `external` 就只显示标题、不生成站内链接——这样既不会把编造的编号变成死链，又保留了「值得补读但库里没有」的建议。

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
store.corpusHash();                    // 语料指纹：变了说明缓存过期
store.pendingDocuments({ limit: 10 }); // 待整理：没解读过 → 失败 → 内容已变化
store.saveReview({ documentId: 1, status: 'done', category: '数据库', /* … */ }, { contentHash: store.corpusHash() });
store.reviewOf(1);
store.latestReport();
store.clearAll();
```

建表由 `createAiStore` 自动完成（`ai_document_reviews` / `ai_corpus_reports` / `ai_corpus_index`）。

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
- **缓存与过期**：语料指纹 = 文档数 + 最新更新时间 + 回复数 + 正文总字符数。指纹变化 → `stale: true` → 前端提示重新解读。
- **失败不污染缓存**：「没配密钥」不写入缓存；上游故障写入 `status: 'failed'` 并保留错误信息，便于排查。
- **批量解读的优先级**：没解读过 → 解读失败 → 内容已变化；上游整体故障时立即返回部分结果（`partial: true`），不会把剩下的都试一遍。
- **并发安全**：同一文档重复解读是覆盖写（`ON CONFLICT DO UPDATE`）；批量为串行，避免把上游打爆。

## 6. 自测覆盖（92 项，无需真实密钥）

```
▶ 配置与降级      未配置抛错、状态不含密钥、映射成 503
▶ JSON 容错       代码块 / 前后夹带 / 嵌套 / 字符串内花括号 / 非法输入
▶ 归一化          枚举回落、长度限制、缺摘要兜底、**编号幻觉过滤**、数量截断
▶ 材料装配        预算截断、首篇保留、可关回复
▶ 三个能力        字段与用量、推荐编号校验、引用过滤
▶ 上游错误        401/429/500 → 稳定错误码与状态码
▶ 检索选择        命中排序、预算控制、空问题
▶ SQLite 缓存     索引同步、指纹稳定与变化、缓存读写、过期判定、批量优先级
▶ HTTP 处理器     未登录 401、非管理员 403、未配置 503 且不写脏缓存、404、
                  问答 scope、参数校验、清缓存、**上游故障的部分失败语义**
```

## 7. 已知限制

- **没有向量检索**：问答选材靠关键词打分，同义改写（「性能」vs「速度」）不会互相命中。要语义检索，把 `rankDocuments` 换成你的向量召回即可，其余不用动。
- **中文分类靠模型**：`category` 依赖提示词里的固定词表，模型偶尔会给出词表外的值，此时回落成「其他」。
- **单轮对话**：问答是无状态的一次性调用，没有多轮上下文与追问。
- **材料上限**：单篇解读正文截断到 3000 字/篇（`buildMaterial` 的 `contentPerDoc`），全库整理总预算 60000 字符；超大库会只覆盖前面的文档，需要自己实现分批汇总。
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
├── selftest.mjs          # 92 项自测
└── README.md
```

## 9. 谁在用

- **格社**（同仓 `../`）：用它做「AI 阅读助手」——帖子详情页的解读与「就这篇提问」、`#/ai` 页的全站知识地图与「问全站」。
  论坛侧只保留了一个薄接线层 `../src/ai.js`（把 post/document 词汇与 `postId`/`documentId` 字段名对齐），算法与提示词全部来自本包。

> 该演示站点的 AI 界面（`#/ai`、帖子页 AI 区块）的 HTML/CSS 没有打进本包，因为那部分和站点框架强耦合；本包交付的是**能力 + 缓存 + HTTP 契约**这三层可直接复用的部分。
