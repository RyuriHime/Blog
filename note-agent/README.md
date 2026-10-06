# note-agent —— AI 笔记整理 Agent + AI 学术编辑 Agent

**你写你的，它盯着看；你点一下，它才动手。**

把这个编辑区变成一个能整理、能审稿的工作台：面板实时读着你正在写的内容（结构、公式、代码、表格、图片都认），
你说一句要求它就改一处，改完先给你看 diff，你点头才写回编辑区。
手上还有 Word / PPT / PDF 原始资料时，可以作为**补充材料**丢进来一起理解。

它是一个**零依赖、可嵌进任意编辑器**的独立包：本来是给格社的写作页做的，
但代码里没有一行假设宿主是论坛 —— 整个包只依赖 Node 内置模块，对外只有一个挂载函数和一套 HTTP 接口。

- **零依赖**：没有 `dependencies`、没有 `devDependencies`、没有构建步骤。只用 `node:http` / `node:sqlite` / `node:zlib` / `node:fs` 这些内置模块。
- **AI 层可插拔，且自带一份**：模型调用统一收口在 `src/ai.mjs`。旁边有宿主的 AI 包（本仓库里是 `forum-ai`）就用它；没有就用包自带的兜底实现（`src/ai-local.mjs`），所以**单独拷走也能跑**。想知道当前用的哪套，看 `GET /api/notes/status` 的 `aiSource`。
- **不改宿主代码**：接进宿主只需要 **6 处追加**（见 [`INTEGRATION.md`](INTEGRATION.md)），回滚就是删目录 + 撤这 6 处。
- **样式自带**：面板的 CSS 跟着面板走（`client/notes-panel.css`，挂载层在 `/notes-panel.css` 发出去，面板自己认领），宿主**不用**往自己的样式表里粘面板样式 —— 只需给挂载点留一行 `.notes-mount { display: block; }`；取不到宿主主题变量时退回面板自带兜底色。
- **可换编辑器**：面板不绑死 textarea。只要宿主编辑器实现 3 个必填方法 + 3 个可选方法（见 [`EDITOR-CONTRACT.md`](EDITOR-CONTRACT.md)），就能直接植入。
- **不点不花钱**：面板只在编辑时同步"编辑区现在是什么"（纯解析，不调模型）；整理与审查都发生在点击那一刻。

---

## 一、需求里点名的九项能力，分别落在哪

| 需求.md 里的能力 | 实现位置 | 说明 |
| --- | --- | --- |
| 内容识别 | `src/extract/` | 编辑区 Markdown + DOCX / PPTX / PDF / 文本五种源，按顺序抽成统一块序列 |
| 结构分析 | `src/structure.mjs` | 出标题树、章节平铺表、标题候选、统计 |
| 提取知识点 | `src/orchestrator.mjs` | 提示词要求模型只用材料里的信息归纳 |
| 生成标题 | `src/prompts.mjs` + `orchestrator` | 先给结构候选，再由模型定稿，超 80 字自动截断 |
| 段落整理 | `src/ops.mjs` | 通过 `replace` / `insert` / `delete` 三种块级指令落地 |
| 公式转换 | `src/formulas.mjs` | `\[ \]`、`\( \)`、`equation` 环境统一成 `$$` / `$`，代码块内不动 |
| 图片说明 | `src/material.mjs` | 编辑区里已有的图片连同材料一起发给模型，产出 `meta.caption` |
| 标签生成 | `src/orchestrator.mjs` | 模型给标签，去重去空、最多 5 个、每个 ≤20 字 |
| 文章排版 | `src/blocks.mjs` | 块序列 ↔ Markdown 双向，写回编辑区 |

「AI 学术编辑 Agent」是另一半：`src/review.mjs` 审查内容与逻辑，产出带原文引用的修改建议，可一键应用高危项。

## 二、AI 整理怎么"实时提需求、确认后保存"

这是设计里最要紧的一条语义。**实时**指的是内容实时（面板始终知道编辑区现在是什么），
不是"自动跑模型"——不点按钮就不会有一次模型调用。拆成四步：

1. **实时跟随。** 面板挂载时读一次编辑区，之后每次编辑（防抖 400ms）把最新内容同步进工作台。
   这一步只做解析与结构分析，**不调模型**；所以你一边打字，面板顶部的块数、字符数、大纲会跟着变。
2. **不点「应用」之前，编辑区一个字都不变。** 整理结果只存在于会话里（`notes_sessions.draft_md`），面板自己显示 diff。
3. **每次提要求只动该动的地方。** `/turn` 走的是「最小 op」协议：模型只能返回 `replace` / `insert` / `delete` 这类块级指令，改不动的就返回 `needsMore` 反问，而不是整篇重写。
4. **确认后才写回。** 点「应用到编辑区」→ 面板调 `editor.setDoc()`，走的是宿主编辑器自己的写入路径，所以宿主的撤销、脏标记、快捷键全都照常工作。

真正落库发生在用户点宿主原有的「发布 / 保存」时（面板在 submit 前调一次 `/save` 回填 `session_id`），或者用户显式点「存为草稿」。

> 补充材料是可选的：只有你手上还有 Word / PPT / PDF 时，才展开「补充材料」把文件丢进去，
> 它们会**接在编辑区内容之后**一起理解（编辑区永远是主体）。不上传任何文件，九项能力一样都能用。

### 2.1 面板长什么样：左侧抽屉 + 预览 + 对话

面板不是正文下面的一张卡片，而是**固定在窗口左侧的可折叠抽屉**（420px）。右边留给宿主自己的
侧栏（论坛右侧就有一条站点侧栏抽屉），左边放它不会撞车；抽屉展开时把正文推到右边，编辑区照样看。
抽屉里从上到下是：

| 区域 | 作用 |
| --- | --- |
| 状态胶囊 | 左边永远是**编辑区此刻**的块数/字数，右边是**模型手上那份草稿**的；两者不一致时会补一句「（草稿 N 字）」 |
| 效果预览 | 整理完立刻能看到渲染结果，与站内发布后的渲染**同一套**（复用宿主 `POST /api/markdown/preview`，不是面板自己写的渲染器）；右上角小按钮在「效果 / 原文」之间切换。**它钉在抽屉顶部**，不会被跑出来的结果顶走 |
| 对话记录 | 每一轮都留一条（你提的需求、每轮草稿字数），**任何一轮都能点「回滚到这一版」** |
| 整理结果对比 | 只列真正变了的块 |
| 审查意见 | 学术审查的 findings 卡片 + 一键应用高危项 |
| 补充材料 | 默认折叠，可选 |

窄屏（≤1080px）时抽屉默认收起，只留左边一条竖标签；点它展开、点 › 收起。
（实现上那条竖标签是**抽屉的兄弟节点**而不是子节点：抽屉收起是整块 `transform` 平移出屏，
而它带 `overflow: hidden`，绝对定位的子元素会被一起裁掉——真机上表现为"收起后再也点不开"。）
回滚的语义和「应用」一致：**只换草稿与预览，绝不碰编辑区**，写回仍然要你点「应用到编辑区」；
历史只增不减，回滚过的旧轮会灰掉但不会消失。
（抽屉的正文是一条 flex 列，跑完一轮会长出对话/提示/对比/审查卡。两处保证预览不被"盖住"：
正文里每一块都 `flex: none`——不许收缩，放不下就让抽屉整体滚动；`.notes-preview` 自己是 `position: sticky`，
底部还贴了一条底色补丁，钉住时不会透出下面滚过去的内容。）

**手机上（≤480px）** 抽屉铺满整个屏幕（`100dvw` / `100dvh`），展开时左侧编辑区看不到——所以
逃生通道有三条：右上角那枚 `›`、**按 Esc**、**点抽屉外面**（只有在窄屏认这两下；桌面上点编辑区
不会把抽屉关掉，那时候你是在"一边看一边改"）。触控尺寸统一撑到 **≥44px 高**（收起按钮、效果/原文/
刷新、补充材料那一行、提需求输入框），并给刘海屏留了 `env(safe-area-inset-*)`；抽屉里的滚动
`overscroll-behavior: contain`，手指在面板里滑动不会带着底下的页面一起动。
这些都在面板自己的样式表里，**接进新站点不用做任何事**——面板只认挂载点的 `.notes-mount`。

两个真机上踩过的坑，写在这儿免得再犯：`.notes-turn-input` 的 `flex-basis` 不能写成像素值
（窄屏折成竖排时 `flex-basis` 量的是**高度**，`flex: 1 1 240px` 会让输入框变成 240px 高，
把抽屉底栏顶到 459px、对话与审查卡全被挤出屏幕）；抽屉正文里每一块都得 `flex: none`。

面板的样式全部收在挂载点的 `.notes-mount` 类下面（`.notes-mount > .notes-drawer-tab` 之类）。
这样宿主任何泛化选择器 —— 比如 `input[type="text"], textarea { … }`，它比单类选择器优先级高 ——
都改不动面板，面板在哪个站点都长一样。挂载点漏写这个类时 `attach()` 会自己补上、
`destroy()` 再摘掉，所以**写不写都不会坏**；写上更好，样式生效更早一步。

## 三、快速开始

### 3.1 只想先跑起来看看

```bash
node examples/server.mjs
# 打开 http://127.0.0.1:3480
```

`examples/` 里是一个**完全独立于论坛**的最小服务（`node:http` + `node:sqlite`，没有一行宿主代码）和一个自带假编辑器的 `standalone.html`。它是"这个包能脱离论坛单独使用"的证明，也是新编辑器接入时的参照。

> 真跑模型需要 `AI_API_KEY`。只想起服务、点着玩界面，可以先 `AI_API_KEY=test node examples/server.mjs`。

### 3.2 接进已有服务

```js
import { mountNoteAgent, noteAgentStatus } from './note-agent/src/index.mjs';

const agent = mountNoteAgent({ db, resolveUser });   // db 是 node:sqlite 的 DatabaseSync
agent.attach(server);                                // 必须在 server.listen() 之前
```

前端加一行 `<script type="module" src="/notes-panel.js"></script>`，写页面时：

```js
import { attach, createTextareaAdapter } from '/notes-panel.js';
attach({ mount: document.querySelector('#notesMount'), editor: createTextareaAdapter(document.querySelector('#composeForm')) });
```

完整步骤（含 6 处胶水的确切改法与回滚清单）：[`INTEGRATION.md`](INTEGRATION.md)。
换一个非 textarea 的编辑器：[`EDITOR-CONTRACT.md`](EDITOR-CONTRACT.md)。
接进一个**真实存在的新编辑器**（note-studio：双模式 + KaTeX，含 5 处改动与适配器全文）：[`ADAPT-NOTE-STUDIO.md`](ADAPT-NOTE-STUDIO.md)。
把整个包交给同事（要求、限制、验收清单）：[`HANDOFF.md`](HANDOFF.md)。

> **浏览器端不要 import `src/index.mjs`** —— 它会拉进 `node:sqlite` 和 `node:fs`。浏览器只认 `/notes-panel.js`，也就是 `client/notes-panel.mjs`。

## 四、HTTP 接口

全部挂在 `basePath`（默认 `/api/notes`）下，由挂载层短路，**不经过宿主的 JSON body 读取器**（因为要自己处理 multipart）。成功一律 `{ ok: true, data }`，失败一律 `{ ok: false, error: { code, message } }`。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/status` | 是否配好 AI、模型名、契约版本、限额。**唯一不需要登录的接口** |
| POST | `/session` | multipart 上传材料，建会话 + 抽取 + 结构分析。**这一阶段一次模型都不调** |
| POST | `/generate` | 首轮整理：出标题、标签、块级 op、图说 |
| POST | `/turn` | 实时提需求（1–1000 字），只动该动的块 |
| POST | `/apply` | 把待应用的 op 落到会话草稿，返回可写回编辑区的 markdown |
| POST | `/save` | 回填 `postId` 或把草稿存为会话 |
| GET | `/sessions` | 我的会话列表 |
| GET | `/session/:id` | 会话详情（草稿、材料、消息、审查、用量） |
| GET | `/messages` | 这一条工作台的对话记录（每轮带草稿快照 `draftMd` 与 `createdAt`）。单独开一个 GET 是因为快照是整篇草稿，不必每次刷新都拖着走 |
| POST | `/rollback` | 把草稿恢复到某一轮结束时的样子（`{sessionId, messageId}`）。**只动草稿与预览，不碰编辑区**；回滚本身也留一条消息，历史只增不减 |
| POST | `/review` | 学术审查：内容与逻辑，产出带引用的建议 |
| POST | `/review/:id/apply` | 一键应用高危项（只改 `high` 且有 patch 的） |
| GET | `/assets/:id` | **恒返回 404** —— 图片只读不存，服务端不留副本 |

状态码：`400 notes_bad_request`、`401 unauthorized`、`404 notes_not_found`、`413 notes_too_large / payload_too_large`、`415 notes_unsupported_type`、`422 notes_extract_failed`、`429 ai_rate_limited`、`502 ai_*`、`503 notes_not_configured`、`504 ai_timeout`。

`/generate`、`/turn`、`/review` 三个真正花钱的接口按用户限流 **10 次/分钟**。

## 五、环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `AI_API_KEY` | 无 | **本包不读它**，是宿主的 AI 包在读；面板用它判断"AI 是否配置好" |
| `AI_MODEL` | `deepseek-chat` | 同上，最终由宿主的 AI 包决定 |
| `NOTES_MATERIAL_CHARS` | `24000` | 发给模型的材料字符预算，超了按类型整块丢弃（绝不截断半块） |

> 材料**不落盘**，所以没有"上传目录"这类配置项：上传文件在内存里抽成文本后直接进
> `notes_materials` 表，挂载层不需要任何可写目录。

显式传参优先于环境变量：`mountNoteAgent({ materialChars: 5000 })` 不会被 `NOTES_MATERIAL_CHARS` 覆盖。

**token 预算**：`deepseek-flash` 这类推理模型会把 `max_tokens` 花在思维链上，**而且思维链往往比正文长得多**。真机实测（900 字草稿）：

| 调用 | 预算 | 思维链 | 正文 | 结果 |
| --- | --- | --- | --- | --- |
| 审查 | 4000 | **4000**（吃满） | 0 字符 | `finish_reason: length`，正文一个字都没有 |
| 审查 | 8000 | 6108 | 2513 字符 | 完整 JSON |
| 审查 | 16000 | 10163 | 2667 字符 | 完整 JSON（同一段草稿，思维链浮动很大） |

所以预算按最坏情况给：**首轮整理与审查 `16000`，微调与自动追问 `8000`**，重试上限 `32000`（见 `src/limits.mjs`，那里记着上面这组实测数字）。这些数字故意不做成配置项 —— 调小了不是"输出变短"，而是**一个字都没有**。

代价是慢：16000 预算的一次调用实测 14~44 秒（取决于思维链长度），所以 `/generate`、`/turn`、`/review` 的界面文案与超时（180 秒）都按"要等一会儿"设计。

**被截断 / 空正文时自动重试一次**：只要这一次没拿到可解析的 JSON —— 不管是"半个 JSON"还是 `chat()` 直接抛 `ai_empty_response`（思维链吃满预算的典型表现）—— 四个入口（`/generate`、`/turn`、`/review`、以及整理循环内部的自动追问）都会**收紧提示（要求"只输出 JSON"）+ 加倍预算再试一次**，仍失败才报错。只在第一次确实失败时才多花这一次钱。用户看到的错误文案是「模型这次思考得太长……」，而不是 502。鉴权、限流、超时**不重试**（重试也是白等一轮）。

## 六、测试

```bash
# 单跑本包（不需要宿主仓库）
node note-agent/scripts/run-tests.mjs

# 在宿主仓库里跑全部六套（含真站点 + 假模型的端到端）
node scripts/run-tests.mjs
```

把 `note-agent/` 单独拷走时（没有宿主仓库、没有 `forum-ai` 兄弟目录）：
`test-docs.mjs` 与 `test-integration.mjs` 会**自动跳过并打印原因**；AI 层自动切到包自带的兜底实现，
`test-ai-fallback.mjs` 照样全绿。所以两个环境下都是「全部测试通过」，只是套数与提示不同：

| 在哪跑 | 输出 | 说明 |
| --- | --- | --- |
| 论坛仓库里 | `AI 实现 = forum-ai`、`通过 31 / 31` | 全量 |
| 单独拷走 | `AI 实现 = bundled`、`通过 29 / 29（跳过 2 个需要宿主的）` | 少了"从外面看宿主"的两套 |

端到端那套（`scripts/smoke-notes.mjs`）会真起宿主站点和一个假 OpenAI 兼容服务，走完「上传 → 整理 → 提需求 → 应用 → 审查 → 应用修改 → 发布 → 读回」，并断言**没有任何请求真的发出到互联网**。

未实际发起模型调用就能测的原因：`generate` / `turn` / `reviewDraft` 都接受 `chatImpl` 注入，测试里塞一个假 chat 就能精确控制模型返回什么、看它收到什么提示词。

### 6.1 模型返回的 JSON 不干净时怎么办

推理模型经常写出**合法意图、非法语法**的 JSON —— 真机上稳定复现过一次：它把引号写进了字符串值内部（`"…一篇题为"导数与积分"的笔记…"`），花括号完全平衡、`finish_reason` 是 `stop`，但标准解析器直接失败，用户看到的是 502。

所以解析分两层：先试 `forum-ai/src/parse.mjs` 的严格解析，失败后交给 `note-agent/src/json.mjs` 的 `extractJsonTolerant()` 做一次**保守重写**再解析（裸引号补成 `\"`、裸反斜杠补成 `\\` 以保住 LaTeX、裸控制字符转义）。它不是"猜内容"：括号不平衡、字符串没闭合、顶层不是对象，一律返回 `null`，宁可报错也不放行编造的结果。

## 七、已知限制

- **PDF 只支持带文本层的**。扫描件抽不出字，会明确给 `pdf_no_text_layer` 警告而不是假装成功；中文 PDF 也一样（字面字符串是 latin1 字节流，正确解析需要 CID/ToUnicode 映射，本包有意不做）。
- **图片只读不存**。材料里的图片只在当轮请求内传给模型，服务端不留副本，所以 `/assets/:id` 恒 404。单张 ≤2MB，一轮最多发 6 张。
- **不做上传图片自动转 Markdown/LaTeX**。那是宿主编辑器的活；本包只负责"编辑区里已经有的图片要参与理解"。
- **不做版本控制**。草稿只保留最新一份（`notes_sessions.draft_md`）。撤销靠宿主编辑器自己的 undo。
- **不写入宿主的任何业务表**。只建自己的 11 张 `notes_*` 表（全部 `CREATE TABLE IF NOT EXISTS`，不加外键）。
- **只懂七种块**：`heading` / `paragraph` / `list` / `code` / `table` / `formula` / `image`。宿主渲染器若支持别的（比如引用块），会被归进 `list`。

## 八、目录结构

```
note-agent/
├── README.md            ← 本文件（能力 / 语义 / 接口 / 限制）
├── HANDOFF.md           ← 交给别人时先看这个：要求、快速开始、验收清单、文件清单
├── INTEGRATION.md       ← 6 处胶水的确切改法与回滚
├── EDITOR-CONTRACT.md   ← 换编辑器要实现什么
├── ADAPT-NOTE-STUDIO.md ← 接进 note-studio 的实际流程（5 处改动 + 适配器全文）
├── API-REFERENCE.md     ← 13 个接口的请求 / 响应 / 错误码
├── LOCAL-TESTING.md     ← 自己动手点着验收的八步清单
├── CHECKPOINTS.md       ← 各任务的 RED→GREEN 台账（含每次踩的坑）
├── src/
│   ├── index.mjs        ← 统一出口（服务端用；浏览器不要 import）
│   ├── mount.mjs        ← 挂载层：短路路由、解析 body、发面板脚本与样式
│   ├── routes.mjs       ← 13 条接口的处理器（框架无关，可纯函数测试）
│   ├── extract/         ← docx / pptx / pdf / text 抽取
│   ├── zip.mjs          ← 最小 ZIP 读取器（DOCX/PPTX 是 ZIP）与 CRC 校验
│   ├── multipart.mjs    ← 零依赖 multipart 解析与上传白名单
│   ├── blocks.mjs       ← 块协议与 Markdown 序列化
│   ├── structure.mjs    ← 结构分析
│   ├── formulas.mjs     ← 公式归一化
│   ├── material.mjs     ← 材料装配与预算裁剪
│   ├── prompts.mjs      ← 三段 system 提示词
│   ├── limits.mjs       ← 模型预算、超时与重试策略（含真机实测数字）
│   ├── json.mjs         ← 容错 JSON 解析（推理模型写坏引号时的保守重写）
│   ├── ai.mjs           ← AI 层适配器：旁边有 forum-ai 就用它，没有就用兜底
│   ├── ai-local.mjs     ← 兜底 AI 调用（错误码与 forum-ai 逐条对齐）
│   ├── json-local.mjs   ← 兜底严格 JSON 解析
│   ├── ops.mjs          ← 块级改动协议（7 种 op）
│   ├── diff.mjs         ← 给面板看的块级 diff
│   ├── orchestrator.mjs ← 整理循环
│   ├── review.mjs       ← 学术审查
│   └── store-sqlite.mjs ← 11 张 notes_* 表
├── client/
│   ├── notes-panel.mjs  ← 前端面板 + textarea 适配器（挂载层发成 /notes-panel.js）
│   └── notes-panel.css  ← 面板样式唯一来源（挂载层发成 /notes-panel.css）
├── tests/               ← 测试文件 + 夹具 + 假 DOM / 假模型替身
├── scripts/             ← 测试入口、夹具生成、样式整理
└── examples/            ← 独立演示服务与页面
```

