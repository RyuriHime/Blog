# 交付说明：AI 笔记整理 / 学术编辑 Agent

这个文件夹 + 它的兄弟目录 `forum-ai/` 就是全部。**没有 npm install、没有构建步骤、没有外网依赖**，
`node note-agent/examples/server.mjs` 就能跑起来看界面。

- 想先看效果 → [§2 三十秒跑起来](#2-三十秒跑起来)
- 想接进自己的站点 → [`INTEGRATION.md`](INTEGRATION.md)（6 处胶水）+ [`API-REFERENCE.md`](API-REFERENCE.md)
- 想换成自己的编辑器 → [`EDITOR-CONTRACT.md`](EDITOR-CONTRACT.md)
- 想自己点着验收 → [`LOCAL-TESTING.md`](LOCAL-TESTING.md)（八步）
- 想知道设计取舍与踩过的坑 → [`CHECKPOINTS.md`](CHECKPOINTS.md)

---

## 1. 这是什么

写作页左侧的一个**工作台抽屉**。它盯着编辑器里的正文，你点按钮它才动手：

| 你做什么 | 它做什么 | 花钱吗 |
| --- | --- | --- |
| 正常打字 | 实时更新块数/字数/大纲（纯解析） | 不花 |
| 点「整理这篇笔记」 | 出标题、标签、结构化的块级改动 | 花一次 |
| 写一句要求点「提需求」 | 只改该改的那一两块，改不动的反问你 | 花一次 |
| 点「学术审查」 | 按学术写作标准给带原文引用的意见（可一键应用高危项） | 花一次 |
| 点「应用到编辑区」 | 才真正写回编辑器（走宿主自己的写入路径，撤销/脏标记都照常） | 不花 |
| 点某一轮的「回滚到这一版」 | 换掉草稿与预览，**不碰编辑区** | 不花 |

四条设计前提（也是它跟"上传文件帮我整理"那类工具的根本区别）：

1. **面板盯着编辑区**，不是盯着某个上传的文件 —— 上传的材料只是**可选补充**；
2. **不点不花钱** —— 整理/提需求/审查三件事各对应一次显式点击；
3. **AI 不改编辑区** —— 结果先落在面板里给你看（预览 + 对比 + 对话），你点头才写回；
4. **改最小的地方** —— 模型只能返回 7 种块级指令（`setTitle`/`replace`/`insert`/`delete`/`setTags`/`setCaption`/`format`），
   不允许整篇重写；改不动就返回 `needsMore` 反问你，而不是编。

零依赖是真的：`note-agent/package.json` 里没有 `dependencies`、没有 `devDependencies`，
只用 `node:http` / `node:sqlite` / `node:zlib` / `node:fs` 这些内置模块。

---

## 2. 三十秒跑起来

```bash
node note-agent/examples/server.mjs
# 打开 http://127.0.0.1:3480
```

这是**完全独立于任何站点**的最小服务（Node 原生 http + `node:sqlite`，数据库落在系统临时目录），
里面自带一个假编辑器页面。只想起服务点着玩界面：

```bash
AI_API_KEY=test node note-agent/examples/server.mjs      # Windows: $env:AI_API_KEY='test'
```

要真跑模型，把它换成你自己的 key：

```bash
AI_API_KEY=sk-xxxx AI_BASE_URL=https://api.deepseek.com AI_MODEL=deepseek-flash \
  node note-agent/examples/server.mjs
```

> 配置读取由 AI 层负责（`src/ai.mjs`）：旁边有 `forum-ai` 就用它，没有就用本包自带的兜底实现。
> 两种情况下读的都是同一组环境变量。只要 `AI_API_KEY` 没配好，`/api/notes/status` 就回
> `configured:false`，界面上的按钮会提示"这个站点还没有配置 AI 接口"。

---

## 3. 前置条件（就两条）

| 条件 | 细节 | 为什么 |
| --- | --- | --- |
| **Node ≥ 22.5** | 需要 `node:sqlite`（本项目在 24.21 上开发与验收） | 存储层零依赖就靠它 |
| **一个能写文件的目录** | 默认与数据库同目录；`notes_*` 11 张表会建在那里 | 会话/草稿/历史/审查结果 |

**关于 `forum-ai`：可选，不是前置条件。** 这个包原本与论坛共用 `forum-ai` 的 AI 调用层，
交付时改成了**两套实现二选一**（`src/ai.mjs` 自动选）：

| 情况 | 用的是谁 | 怎么知道的 |
| --- | --- | --- |
| `note-agent/` 旁边有 `forum-ai/` 目录（= 在论坛仓库里） | `forum-ai` 的真实实现 | `GET /api/notes/status` 的 `aiSource` 是 `"forum-ai"`；跑测试时入口会打印一行 `AI 实现 = forum-ai` |
| 旁边没有（= 单独拷给同事） | 本包自带的兜底实现 `src/ai-local.mjs` | 同上，报 `"bundled"` |

两套实现的**请求形状与错误码逐条对齐**（有测试钉着：`tests/test-ai-fallback.mjs` 把同一组参数
喂给两边，比对发出去的 HTTP 请求体），所以业务代码不需要知道自己跟谁说话。
唯一的功能差异：论坛站点自带的那些扩展能力与本包无关，兜底实现不提供 —— 本包用不到。

没有 Node 22.5？把 `node -v` 的输出发我，存储层换 `better-sqlite3` 是唯一要改的地方。

---

## 4. 三种用法，挑一种

### A. 当独立服务（最快，适合先看看）
`node note-agent/examples/server.mjs` —— 见上一节。

### B. 接进已有站点（真正要做的）
6 处追加，不动宿主任何既有逻辑：
1. 后端 `mountNoteAgent({db, resolveUser})` + `agent.attach(server)`；
2. 后端把 `notes.status()` 挂到已有的 `/api/site`；
3. 前端加 `<script type="module" src="/notes-panel.js"></script>`；
4. 写作页加一个空容器 `<div id="notesMount" class="notes-mount"></div>`；
5. 前端 `window.NotesAgent.attach({mount, editor, postId})`；
6. 样式表加一行 `.notes-mount { display: block; }`（只有这一行）。

**不需要**粘面板样式（面板样式自己带着，走 `/notes-panel.css`）、**不需要**建表、
**不需要**写任何 AI 接口。逐条 diff 与回滚清单见 [`INTEGRATION.md`](INTEGRATION.md)。

### C. 只搬前端面板（如果你们的后端已经是别的语言）
面板只认 13 个 HTTP 接口 + 1 个宿主接口（`POST /markdown/preview`，用于"效果预览"），
按 [`API-REFERENCE.md`](API-REFERENCE.md) 实现即可；面板脚本是零依赖的浏览器 ESM，
`client/notes-panel.mjs` + `client/notes-panel.css` 两个文件就够。

预览接口可以选择不实现：拿不到它时面板会去 import 挂载层发出来的
`/notes-markdown.js`（就是本包自带的渲染器 `src/markdown-core.mjs`）自己渲染，
所以「效果」按钮在别的站点上照样能用；只有连那个模块也取不到时，才退回"原文"视图，
并在面板上写明原因（不会静默降级成看不懂的一句话）。

---

## 5. 你会看到的界面

```
┌─ AI 笔记整理 ─────────────┐┌─ 写作页 ────────────────────────────────┐
│ ● 正在跟随编辑区 · 122 字  › ││  标题 [__________________________]      │
│ ● 草稿 · 6 块 · 104 字      ││  正文                                   │
├───────────────────────────┤│  ┌───────────────────────────────────┐  │
│ 效果预览    [效果][原文][⟳] ││  │ $$ f'(x_0) = \lim_{h \to 0} … $$  │  │
│ ← 钉在抽屉顶部，不会被顶走   ││  │ ## 二、积分                        │  │
├───────────────────────────┤│  └───────────────────────────────────┘  │
│ 对话记录                   ││  [发布帖子] [预览]                      │
│  AI｜整理了这篇笔记  122 字 │└─────────────────────────────────────────┘
│  [回滚到这一版]             │
│  你｜把那段改写成要点  180 字│
├───────────────────────────┤
│ [整理这篇笔记][应用到编辑区] │
│ [想怎么改？__________][提需求]│
└───────────────────────────┘
```

- 抽屉固定左侧 420px（右边留给宿主自己的侧栏），右边照常看编辑区；窄屏（≤1080px）默认收成左边缘一条竖标签。
- 顶部两颗胶囊：左边永远是**编辑区此刻**的字数，右边是**模型手上那份草稿**的；
  两者不一致时会补一句「（草稿 N 字）」—— 提醒你"草稿还没写回编辑区"。
- 预览走宿主自己的 Markdown 渲染，所以**预览与发布后的样子天然一致**。
- 回滚过的旧轮会灰掉但**不删**（历史可审计），旁边有「回到最新」。

---

## 6. 限制与坑（先知道，省得以为是 bug）

| 现象 | 真相 |
| --- | --- |
| 扫描版 PDF 抽不出字 | 有意为之：只支持带文本层的 PDF，会明确给 `pdf_no_text_layer` 警告，不假装成功。中文 PDF 也一样（需要 CID/ToUnicode 映射，本包不做） |
| 公式显示成 `$$…$$` 原文 | 宿主渲染器有没有数学排版是宿主的事；本包保证"公式源文本被识别、归一、原样写回"，不负责渲染 |
| 一次整理要等十几秒到一分钟 | 推理模型会把预算花在思维链上：实测 14~44 秒/次。界面文案与 180 秒超时都按"要等一会儿"设计 |
| 模型偶尔返回坏 JSON | 有容错：先严格解析，失败后做**保守重写**再试（裸引号补 `\"`、裸反斜杠补 `\\` 保住 LaTeX）；括号不平衡 / 字符串没闭合一律判失败，宁可报错也不放行编造的结果 |
| 一分钟点超过 10 次被拒 | 限流：`/generate` `/turn` `/review` 各 10 次/分钟 |
| 「应用到编辑区」之前刷新页面，草稿还在吗 | 在。草稿落在 `notes_sessions.draft_md`，同一篇帖子重新打开会接上（靠 `postId`） |
| 图片 | **只读不存**：材料里的图片只在当轮请求内传给模型，服务端不留副本，所以 `/assets/:id` 恒 404。单张 ≤2MB |
| 版本控制 | 本包不做整篇版本树：草稿只保留最新一份 + 每轮快照（用于回滚）。撤销靠宿主编辑器自己的 undo |
| 块类型只有七种 | `heading / paragraph / list / code / table / formula / image`。宿主渲染器若支持引用块之类，会被归进 `list` |
| 独立拷走时测试会不会红 | 不会：`test-docs.mjs` / `test-integration.mjs` 与依赖 `forum-ai` 的用例会自动**跳过并打印原因**；在宿主仓库里跑则是全量 |
| 手机上页面能横向晃出一点 | **不是本包造成的，本包也不负责修**：390px 视口下文档宽 489px，把本包的面板整块 `remove()` 之后仍是 489 —— 撑出去的是宿主顶栏。详见下面「已知的宿主侧问题」 |

### 已知的宿主侧问题（记录在案，未修，因为不在本包职责内）

真机验收（390×844，Playwright + Edge，宿主 `public/style.css` 原样）量到：`document.documentElement.scrollWidth = 489`，视口 390，即手机上手机会多出一段可横滑的 99px。

排查结论（三步都做过，可复现）：

1. 把 `.notes-mount` 下所有子节点 `remove()` 之后 `scrollWidth` 仍是 **489** ⇒ 与本包面板无关；
2. 再删掉宿主 `.topbar` 才回落到 **390** ⇒ 溢出源在顶栏；
3. 撑出去的是 `.topnav`（宽 306，`left 183 → right 489`）与 `#user-area`（宽 173，`left 316 → right 489`），两者同处 `flex-wrap: nowrap; overflow-x: visible` 的 `.topbar-inner`（宽 390、`scrollWidth 489`）内；`.layout` 与 `.sidebar` 都在 390 以内。

试过且**无效**的三个修法：`html { overflow-x: clip }`、`html { overflow-x: hidden }`、给抽屉 `overflow: hidden` —— 三者都只是裁，不是消除溢出源（`scrollWidth` 仍 489）。

本包这一侧该保证的事情已经钉住了：抽屉 `width: 100dvw` + `max-width: 100%`，自身不超出视口；手机上唯一可靠的收起出口是抽屉内的 `‹` 按钮与 `Escape`，两者都已撑到 44×44（触控下限）。要修顶栏得改宿主 `public/style.css`（例如窄屏让 `.topbar-inner` 折行或把 `.topnav` 收进溢出菜单），那是论坛的事，因此这里只记录不代改。

---

## 7. 怎么验证它真的能用

```bash
# 1. 本包的测试（零依赖，不需要宿主仓库）
node note-agent/scripts/run-tests.mjs

# 2. 起演示服务，照 LOCAL-TESTING.md 的八步点一遍
node note-agent/examples/server.mjs
```

在宿主仓库里还有六套（含真站点 + 假模型的端到端）：

```bash
node scripts/run-tests.mjs
```

端到端那套会真起站点和一个假 OpenAI 兼容服务，走完
「打字 → 整理 → 提需求 → 应用 → 审查 → 应用修改 → 回滚 → 发布 → 读回」，
并断言**没有任何请求真的发出到互联网**。

---

## 8. 文件清单（87 个文件）

```
note-agent/
├── README.md            能力 / 语义 / 接口 / 限制（先看这个）
├── HANDOFF.md           本文件
├── INTEGRATION.md       6 处胶水的确切改法与回滚
├── EDITOR-CONTRACT.md   换编辑器要实现什么（含 ≤20 行适配器示例）
├── API-REFERENCE.md     13 个接口的请求 / 响应 / 错误码
├── LOCAL-TESTING.md     自己动手验收的八步清单
├── CHECKPOINTS.md       各任务的 RED→GREEN 台账（含踩过的坑）
├── package.json         零依赖；main = src/index.mjs
├── src/                 30 个服务端模块
│   ├── index.mjs        统一出口（服务端用；浏览器不要 import）
│   ├── mount.mjs        挂载层：短路路由、解析 body、发面板脚本/样式/渲染模块
│   ├── routes.mjs       13 条接口的处理器（框架无关，可纯函数测试）
│   ├── store-sqlite.mjs 11 张 notes_* 表
│   ├── orchestrator.mjs 整理循环   review.mjs 学术审查
│   ├── ai.mjs           AI 适配器：旁边有 forum-ai 就用它，没有就用兜底
│   ├── ai-local.mjs     兜底 AI 调用（aiConfig / chat，错误码与 forum-ai 对齐）
│   ├── json-local.mjs   兜底 extractJson   json.mjs 容错解析（多一层抢救）
│   ├── markdown.mjs     渲染桥：宿主有 src/markdown.js 就用它（Node 专用）
│   ├── markdown-core.mjs 零依赖渲染器（浏览器也跑这份，发成 /notes-markdown.js）
│   ├── ops.mjs blocks.mjs diff.mjs structure.mjs formulas.mjs material.mjs prompts.mjs
│   ├── limits.mjs zip.mjs zip-write.mjs multipart.mjs uploads-meta.mjs
│   └── extract/         docx / pptx / pdf / text 抽取（5 个文件 + index）
├── client/
│   ├── notes-panel.mjs  前端面板 + textarea 适配器（挂载层发成 /notes-panel.js）
│   └── notes-panel.css  面板样式唯一来源（挂载层发成 /notes-panel.css）
├── tests/               40 个文件：32 个 test-*.mjs + 4 个夹具 + 4 个替身
│   ├── fixtures/        sample.docx、sample.pptx、scanned.pdf、text-only.pdf
│   └── helpers/         check.mjs（断言）、fake-dom.mjs、fake-chat.mjs、zip-fixture.mjs
├── scripts/             run-tests.mjs（测试入口）、make-fixtures.mjs、sync-panel-css.mjs
└── examples/            server.mjs（独立演示服务）、standalone.html、sample-material.md
```

---

## 9. 常见问题

**Q：能不能不装 `forum-ai`？**
本来就必须装（4 行相对 import），现在**不装也能跑**：`src/ai.mjs` 会自动选用包自带的兜底实现
（`src/ai-local.mjs` + `src/json-local.mjs`）。想换成你们自己的 AI 模块，改 `src/ai.mjs` 一处即可——
要求只有三个函数：`aiConfig(env)`、`aiStatus(env)`、`chat(messages, options)`，
外加一个 `extractJson(text)`。包本身不关心模型是哪家，只要说 OpenAI 兼容的话。
不确定当前用的是哪套？看 `GET /api/notes/status` 的 `aiSource`。

**Q：能不能用 PostgreSQL / MySQL？**
目前只实现了 `node:sqlite` 存储层（`src/store-sqlite.mjs`，11 张表）。接口是按
"一个 store 对象"设计的，换实现要照 `store-sqlite.mjs` 的方法签名重写一个——
大概是这个包里唯一一处真正绑死环境的地方。

**Q：面板会改宿主的数据库吗？**
不会。只建自己的 11 张 `notes_*` 表，全部 `CREATE TABLE IF NOT EXISTS`，不加外键，
不读写宿主任何业务表。删掉整个目录 + 撤 6 处胶水 = 完全回滚。

**Q：为什么"提需求"和"整理"都要花钱，而"打字跟随"不花？**
因为跟随只做本地解析与结构分析（`src/extract/` + `src/structure.mjs`），一次网络请求都没有；
只有三个按钮会走到 `forum-ai` 的 `chat()`。

**Q：模型把我的内容改坏了怎么办？**
三件事兜着：① 它只能改块级指令，不能整篇重写；② 改完先在面板里给你看 diff；③ 写回编辑区
（`editor.setDoc()`）走宿主自己的写入路径，所以宿主的撤销（Ctrl+Z）照常有效；
④ 对话里任何一轮都能回滚，历史只增不减。

**Q：要多少 token / 多少钱？**
见 [`README.md` §五](README.md)。简单说：一次首轮整理约 2000 prompt + 3000 completion；
审查因为要读完草稿，prompt 会更大。预算（16000/8000，重试 32000）写在 `src/limits.mjs` 里，
**故意不做成配置项**——调小了不是"输出变短"，而是正文一个字都没有。
