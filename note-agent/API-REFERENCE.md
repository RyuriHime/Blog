# HTTP 接口参考（契约版本 1）

面板与后端之间只有这一套接口。全部挂在 `basePath`（默认 `/api/notes`）下，
由挂载层短路处理，**不经过宿主的 JSON body 读取器**（因为要自己处理 multipart）。

- 成功：`{ "ok": true, "data": { … } }`
- 失败：`{ "ok": false, "error": { "code": "…", "message": "…", "details"?: … } }`
- 身份：除 `GET /status` 外全部要登录（走宿主的 `resolveUser`）；查别人的会话一律 404。
- 限流：`/generate`、`/turn`、`/review` 三个花钱的接口按 **每个用户每个接口 10 次/分钟** 限流，
  超出回 `429 ai_rate_limited`「操作太频繁，请等一分钟再试」。

---

## 数据形状

后面反复出现的几个结构，先集中定义：

### block（块）

```jsonc
{
  "id": "b3",                     // 由 assignBlockIds() 生成，稳定、可被 op 引用
  "type": "heading",              // heading | paragraph | list | code | table | formula | image
  "text": "一、导数的定义",
  "level": 2,                     // 仅 heading
  "ordered": false,               // 仅 list
  "lang": "js",                   // 仅 code
  "meta": { "rows": [["a","b"],["-","-"],["1","2"]], "caption": "…" }  // table / image
}
```

块只有这七种。宿主渲染器若支持别的（如引用块），会被归进 `list`。

### structure（结构分析）

```jsonc
{
  "headings": [{ "id": "b3", "level": 2, "text": "一、导数的定义" }],
  "tree": [ … ],                  // 嵌套的章节树
  "sections": [{ "id": "b3", "title": "一、导数的定义", "blockIds": ["b3","b4"], "range": [2,3] }],
  "titleCandidates": [{ "text": "导数与积分", "score": 100, "reason": "首个一级标题" }],
  "stats": { "blocks": 7, "chars": 293, "headings": 3 }
}
```

### op（块级改动指令）

模型**只能**返回这 7 种指令，不允许整篇重写。字段名以 `src/prompts.mjs` 与
`src/ops.mjs` 的 `validateOp` 为准（下表是从这两处抄下来的，改代码时请一起改文档）：

| op | 字段 | 作用 |
| --- | --- | --- |
| `setTitle` | `text` | 只改标题 |
| `replace` | `target`, `text` | 换掉一整块的内容（块 id 不变） |
| `insert` | `after`, `type`, `text` | 在 `after` 那块**后面**插入新块 |
| `delete` | `target` | 删掉一块 |
| `setTags` | `tags` | 只改标签 |
| `setCaption` | `target`, `text` | 给图片块补说明 |
| `format` | `markdown` | 整篇重写（只在必须时用） |

- `target` / `after` 都是**块 id 字符串**（`b1`、`b12`），不是块对象；没有 `before` 这种写法。
- `insert` 的 `type` 取 `heading | paragraph | list | code | table | formula | image`；
  省略时按 `paragraph` 处理。
- 兼容写法（历史原因，面板与真机都出现过）：`op` 等价于 `kind`，`afterId` 等价于 `after`，
  `blockId` 等价于 `target`。
- 校验失败不是 500：整条 op 会被丢进 `/apply` 的 `skipped` 并带 `reason`
  （`unknown_kind`、`bad_target`、`empty_text` …），其余 op 照常应用。

`/apply` 返回的 `applied` / `skipped` 是这两类的明细（`skipped` 里带原因）。

### diff

`diffBlocks(before, after)` 的输出，面板"整理结果对比"就渲染它：

```jsonc
[{ "kind": "mod", "blockId": "b4", "before": { …block… }, "after": { …block… } }]   // kind: add | del | mod
```

### finding（审查意见）

字段名以 `src/prompts.mjs` 的 `REVIEW_SYSTEM` 与 `src/review.mjs` 的落库形状为准：

```jsonc
{
  "id": "f1",
  "kind": "logic",                // logic | fact | structure | clarity | citation | formula
  "severity": "high",             // high | medium | low
  "quote": "导数是变化率。",        // 必须是草稿里的原文片段，且 ≥ 6 个字
  "issue": "没交代极限存在的前提。",
  "suggestion": "补一句「若该极限存在」。",
  "patch": "导数是函数在某点的瞬时变化率。"   // 可精确替换 quote 时给新文字，否则空串
}
```

- `quote` 少于 6 个字、或**在草稿里找不到**，这条 finding 会被丢掉（`dropped` 里能看到
  `quote_not_found` / `bad_kind`），不会落库。
- 只有 `severity === 'high'` 且给了 `patch` 的条目会被 `/review/:id/apply` 真正替换。

### message（对话轮次）

```jsonc
{
  "id": 12,
  "role": "user",                 // generate 落 assistant、turn 落 user（历史命名，取的是"谁发起"）
  "requirement": "把那段改写成要点",
  "createdAt": 1730000000000,
  "ops": [ …op… ],
  "skipped": [ … ],
  "warnings": [ … ],
  "usage": { "prompt": 711, "completion": 978 },
  "draftMd": "# 导数与积分\n\n…"    // 这一轮结束后的整篇草稿快照（回滚就靠它）
}
```

### usage

```jsonc
{ "prompt": 711, "completion": 978, "calls": 1 }
```

---

## 1. `GET /status`

是否配好 AI、模型名、契约版本与限额。**唯一不需要登录的接口**（适合挂在宿主的 `/api/site` 上）。

```jsonc
{
  "configured": true,
  "model": "deepseek-flash",
  "aiSource": "forum-ai",        // 或 "bundled"
  "contractVersion": "1",
  "materialChars": 24000,
  "limits": { "maxFileBytes": 4194304, "maxSessionBytes": 12582912, "maxFiles": 10, "requirement": 1000, "reviewDraft": 20000 },
  "extensions": [".md", ".markdown", ".txt", ".docx", ".pptx", ".pdf"]
}
```

`configured` 是 AI 层对 `AI_API_KEY` 的判断结果；为 false 时花钱的接口一律回 `503 notes_not_configured`。
`aiSource` 说明**这一轮是谁在跟模型说话**：`"forum-ai"` = 旁边有宿主的 AI 包，用的就是它；
`"bundled"` = 旁边没有，用的是本包自带的兜底实现（`src/ai-local.mjs`）。
两套的请求形状与错误码逐条对齐，所以面板与调用方不需要区分；
排查"到底连的哪个网关"时看这个字段最省事。

## 2. `POST /session`

建会话（或复用同一篇帖子/同一份编辑区的会话）+ 抽取材料 + 结构分析。**这一阶段一次模型都不调。**

请求（`Content-Type: application/json`）：

```jsonc
{
  "draft": "# 导数\n\n导数是变化率。",   // 编辑区此刻的 Markdown（≤20000 字）
  "sessionId": 8,                       // 可选：接着已有工作台干
  "postId": 12345,                      // 可选：编辑已有帖子时复用它的会话
  "title": "导数与积分"                  // 可选：编辑区标题
}
```

要上传补充材料时改用 `multipart/form-data`，字段同上，外加同名 `files` 多个文件
（≤10 个、单个 ≤4MB、合计 ≤12MB；`.md/.markdown/.txt/.docx/.pptx/.pdf` 白名单，
按魔数优先判定真实类型）。

响应：

```jsonc
{
  "sessionId": 8,
  "title": "导数与积分",
  "blocks": [ …block… ],
  "stats": { "blocks": 7, "chars": 293, "headings": 3 },
  "structure": { …structure… },
  "sources": [{ "kind": "markdown", "name": "sample-material.md", "bytes": 812 }],
  "warnings": ["scanned.pdf 没有文本层，跳过"]
}
```

**状态码是 200**（不是 201）。空草稿且无材料时回 `400 notes_bad_request`
「编辑区还是空的：先写点内容，或上传一份材料」。

## 3. `POST /generate` — 首轮整理（花钱）

```jsonc
{ "sessionId": 8, "draft": "…编辑区最新内容…", "title": "…", "requirement": "可选的额外要求" }
```

响应：

```jsonc
{
  "sessionId": 8,
  "title": "导数与积分：从变化率到累积量",
  "tags": ["微积分", "导数"],
  "blocks": [ …整理后的块… ],
  "ops": [ …op… ],
  "applied": [ … ],
  "draftMd": "…整理后的整篇草稿…",
  "skipped": [{ "op": "…", "reason": "找不到目标块" }],
  "notes": ["标题取自材料里的一级标题"],
  "needsMore": ["积分一节材料里只有一句话，要不要按标准教材补？"],
  "warnings": [],
  "model": "deepseek-flash",
  "usage": { "prompt": 1997, "completion": 3107, "calls": 1 },
  "material": { "chars": 1283, "images": 0 }
}
```

`needsMore` 不是错误：模型发现材料里没有的东西会反问，**不会凭空编**。

## 4. `POST /turn` — 提需求（花钱）

```jsonc
{ "sessionId": 8, "draft": "…", "requirement": "把第二段改写成要点列表" }
```

`requirement` 必填、1–1000 字，否则 400。响应与 `/generate` 相同（少一个 `material`）
—— 区别只在语义：`/turn` 走"最小改动"，只需要动一两块。

## 5. `POST /apply`

把待应用的 op 落到会话草稿，返回可写回编辑区的 Markdown。**不花钱。**

```jsonc
{ "sessionId": 8, "ops": [ … ] }   // ops 省略时用该会话待应用的指令
```

```jsonc
{ "blocks": [ … ], "title": "…", "tags": [ … ], "draftMd": "…", "applied": [ … ], "skipped": [ … ] }
```

## 6. `POST /save`

回填 `postId`，或把草稿存为会话（用户点"存为草稿"时）。

```jsonc
{ "sessionId": 8, "postId": 12345, "title": "…", "draftMd": "…" }
// → { "sessionId": 8, "postId": 12345, "saved": true }
```

## 7. `GET /sessions`

我的工作台列表（默认 20 条，`?limit=` 可调）。

```jsonc
{ "sessions": [{ "id": 8, "title": "…", "status": "draft", "postId": 12345, "sourceCount": 1,
                 "materialChars": 1283, "tags": [ … ], "createdAt": …, "updatedAt": … }] }
```

## 8. `GET /session/:id`

会话详情（不含草稿快照的历史，那个走 `/messages`）。

```jsonc
{
  "session": { "id": 8, "title": "…", "status": "draft", "postId": 12345,
               "draftMd": "…", "blocks": [ … ], "tags": [ … ], "createdAt": …, "updatedAt": … },
  "materials": [{ "kind": "docx", "name": "笔记.docx", "bytes": 8123, "warnings": [] }],
  "messages": [ …message… ],
  "reviews": [{ "id": 3, "summary": "…", "createdAt": … }],
  "usage": { "prompt": 5489, "completion": 6012, "calls": 4 }
}
```

## 9. `GET /messages?sessionId=8`

聊天式历史（每轮带草稿快照）。单独一个接口是因为快照是整篇草稿，
没必要每次刷新都拖着走。

```jsonc
{ "sessionId": 8, "draftMd": "…", "messages": [ …message… ] }
```

## 10. `POST /rollback`

把草稿恢复成某一轮结束时的样子。

```jsonc
{ "sessionId": 8, "messageId": 11 }
// → { "sessionId": 8, "messageId": 11, "title": "…", "draftMd": "…", "blocks": [ … ], "structure": { … } }
```

语义边界（很重要）：

- 只改**草稿与预览**，**绝不碰编辑区** —— 写回编辑区仍然要用户点「应用到编辑区」。
- 历史**只增不减**：回滚本身也留一条 assistant 消息（`requirement: "回滚到第 11 轮"`），
  所以"什么时候回滚过"在对话里看得见，被跨过的轮次也不会消失。
- 那一轮没有快照（老数据）回 `400 notes_bad_request`「那一轮没有留下草稿快照，没法回滚」；
  `messageId` 不属于这个会话回 `404 notes_not_found`。

## 11. `POST /review` — 学术审查（花钱）

```jsonc
{ "sessionId": 8, "draft": "…", "scope": "content" }
```

```jsonc
{
  "reviewId": 7,
  "sessionId": 8,
  "summary": "草稿只有六十来个字……",
  "findings": [ …finding… ],
  "strengths": ["公式用 $$ 独立成行，好读"],
  "dropped": [{ "id": "f9", "reason": "引用的原文找不到" }],
  "model": "deepseek-flash"
}
```

同一份内容（按 sha 哈希）重复审查会复用已有的 `reviewId`，**不重复存库**。
`dropped` 是被丢弃的建议：`quote` 在草稿里找不到的 finding 一律不返回（防编造）。

## 12. `POST /review/:id/apply`

一键应用高优先级建议。**只改 `severity: "high"` 且有现成修改的项。**

```jsonc
{ "reviewId": 7, "draft": "…" }   // draft 省略时用会话里的草稿
// → { "reviewId": 7, "draftMd": "…", "applied": [ …finding… ], "skipped": [ … ] }
```

## 13. `GET /assets/:id`

**恒返回 404。** 图片只读不存：材料里的图片只在当轮请求内传给模型，服务端不留副本。

```jsonc
{ "ok": false, "error": { "code": "notes_not_found", "message": "图片只读不存：材料里的图片只在本轮请求内传给模型，服务端不留副本" } }
```

---

## 静态资源（不是 `${basePath}` 下的接口）

挂载层 `attach(server)` 会顺手把这三份文件发出去（GET/HEAD，不需要登录，`Cache-Control: no-store`）：

| 路径 | 内容 | 谁在用 |
| --- | --- | --- |
| `/notes-panel.js` | `client/notes-panel.mjs` | 宿主页面 `<script type="module">` 加载它 |
| `/notes-panel.css` | `client/notes-panel.css` | 面板自己 `ensureStylesheet()` 认领 |
| `/notes-markdown.js` | `src/markdown-core.mjs` | 宿主没有渲染接口时的「效果」预览兜底 |

文件名与路径由挂载层写死（`CLIENT_URL` / `STYLE_URL` / `MARKDOWN_URL`，`src/index.mjs` 里也导出了），
宿主前缀 `basePath` 不影响它们。

---

## 宿主可选的 1 个接口：`POST /markdown/preview`

面板的「效果预览」会打 `<hostBase>/markdown/preview`（默认 `/api/markdown/preview`）：

```jsonc
// 请求
{ "content": "# 标题\n\n正文" }
// 响应（形状随意，面板只读 data.html）
{ "ok": true, "data": { "html": "<h1>标题</h1>\n<p>正文</p>" } }
```

- **有它最好**：那是宿主站内自己的渲染器，预览与发布后的效果天然一致。
- **没有它也行**：面板退一步动态 import `/notes-markdown.js` 自己渲染；两条路都不通才
  退回"原文"视图，并在面板上写明原因。
- 40 行的现成实现见 [`examples/server.mjs`](examples/server.mjs) 的 `handlePreview()`。

---

## 错误码表

| code | HTTP | 含义 / 用户看到的话 |
| --- | --- | --- |
| `notes_bad_request` | 400 | 参数不对（如空草稿、需求为空、缺 `messageId`） |
| `unauthorized` | 401 | 没登录 |
| `notes_not_found` | 404 | 会话/消息/审查结果不存在，或**不属于你** |
| `notes_too_large` | 413 | 草稿超 20000 字 / 材料超限 |
| `payload_too_large` | 413 | 请求体超 256KB |
| `notes_unsupported_type` | 415 | 上传了白名单外的文件类型 |
| `notes_extract_failed` | 422 | 材料抽不出文本（如损坏的 DOCX） |
| `notes_not_configured` | 503 | 站点没配 `AI_API_KEY` |
| `ai_rate_limited` | 429 | 一分钟内点太多次（10 次/分钟） |
| `ai_timeout` | 504 | 模型超时（默认 180 秒） |
| `ai_not_configured` | 503 | AI 包缺 key |
| `ai_unreachable` / `ai_unauthorized` / `ai_upstream_error` / `ai_bad_response` / `ai_empty_response` / `ai_bad_json` | 502 | 上游模型的问题；`ai_empty_response` 是"思维链把预算吃满、正文一个字都没有"，本包会自动加倍预算重试一次 |
| 其他未识别 code | 500 | 消息被换成「整理服务出错了，请稍后重试」（不外泄内部细节） |

## 附：限流与预算

- 限流：滑动窗口 60 秒，键是 `${用户id}:${路由}`，`/generate` `/turn` `/review` 各 10 次/分钟。
- token 预算（`src/limits.mjs`，含真机实测数字）：首轮整理与审查 16000、
  微调与自动追问 8000、重试上限 32000。这些数字**故意不做成配置项** ——
  调小了不是"输出变短"，而是正文一个字都没有（推理模型会把预算吃在思维链上）。
- 被截断或拿到空正文时，四个入口都会**收紧提示 + 加倍预算重试一次**；
  鉴权、限流、超时**不重试**。
