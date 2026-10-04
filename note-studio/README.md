# note-studio · 学术笔记编辑器

给「围炉论坛」加的一块**独立可搬运**的学术笔记子系统：

- **Markdown + LaTeX 可视化编辑** —— 源码 / 分栏 / 所见即所得三种模式，公式实时渲染（KaTeX 内置，完全离线）；
- **图片转 Markdown / LaTeX** —— 拍下来的板书、论文截图直接转成带公式的 Markdown；
- **AI 整理 / AI 审阅** —— 生成标题、摘要、知识点、标签、大纲，或审查逻辑并给修改建议；
- **保存为一个 `.md` 文件和一个记录基础数据的 `.json`** —— 这就是交付物本身。

三件事都不自己造轮子：**AI 一律走仓库里既有的 [`forum-ai`](../.inspect/forum-ai/src/index.mjs) 接口**（同一个网关、同一套 `AI_*` 环境变量、同一套错误码），本包不含任何 AI 客户端、密钥管理或模型配置。

---

## 1. 快速开始

### 1.1 独立运行（不接论坛）

```bash
cd note-studio
node src/server.mjs          # 默认 http://127.0.0.1:3001/notes/
```

浏览器打开 <http://127.0.0.1:3001/notes/> 即可编辑。没有 `npm install`，没有构建步骤，只需要 Node 18+（用 `node:sqlite` 的功能才需要 22.5+，本包不依赖它）。

单机模式没有账号体系，会固定注入一个本地用户；笔记写在 `note-studio/data/notes/`。

### 1.2 接入论坛

把胶水文件拷进论坛，改 3 处（合计约 5 行）。详见 [`integration/README.md`](integration/README.md)：

```bash
cp integration/notes.js  <论坛>/src/notes.js
```

1. `<论坛>/src/server.js`：加 1 行 import、1 段路由挂载（4 行）、1 段静态分流（6 行）；
2. `<论坛>/public/index.html`：顶栏加 1 行「📓 笔记」入口。

接好后：编辑器在 `/notes/`，接口在 `/api/notes/*`，**沿用论坛的登录态**（未登录读写会被 401）。

### 1.3 跑一遍应用样例

```bash
node examples/demo.mjs
```

样例自带一个**假 AI 服务**（OpenAI 兼容），所以不需要真实密钥就能端到端跑通：
图片转写 → AI 整理 → AI 审阅 → 落盘，产物在 `examples/output/`（一个 `.md` + 一个 `.json`）。

> **前提**：这个样例要调用既有的 `forum-ai`（本包按约定不自带 AI 客户端）。找不到时它会打印指引并退出，
> 可用 `set FORUM_AI_PATH=<...>\forum-ai\src\index.mjs` 指定。只想看编辑/渲染/导出的话不需要 AI ——
> 直接打开 [`public/playground.html`](public/playground.html) 即可。

### 1.4 一键验收（给「能不能收」用）

```bash
node acceptance/run.mjs
# 然后打开 acceptance/output/acceptance-report.html
```

一条命令跑出全部证据（离线自足、渲染与往返、落盘与 json 一致性、图片转写契约、AI 复用与降级、
安全、81 项零依赖测试、两种论坛布局的集成检查），并生成一份**可审查的 HTML 报告**：
每条标准配「验证方式 + 实际数值」，第三节的渲染结果是**用你自己的渲染管线现算的**，不是截图。

要验真实识别质量（需要支持图片的模型）：

```bash
set AI_API_KEY=sk-xxx
set AI_MODEL=<视觉模型>
node acceptance/run.mjs --live
```

详见 [`acceptance/README.md`](acceptance/README.md)。

### 1.5 可操作样例（想直接上手就用这个）

打开 **[`public/playground.html`](public/playground.html)**（双击即可，无需任何服务）：

- **手动编辑**：左边直接打字就能写（源码 / 分栏 / **可视化**三种模式），工具栏可插入标题、列表、引用、代码块、表格、行内与块级公式，选中文字可加粗/斜体；
- **图片转写就在编辑工具栏里**（🖼 按钮展开，可收起），不在右侧另占一栏：点「载入样例照片」→「开始转写」→「插入到光标处」；
- **布局开关也都在工具栏**：👁 预览、🗂 文件数据、⛶ 只留编辑；收起后不占空间，打开后在右侧竖排；
- 点「导出 .md」「导出 .json」下载的是**真实文件**。

顶部徽标会显示当前形态：**双击打开 = 离线模式**（编辑/渲染/导出可用，转写为明确标注的模拟）；
**用本地服务打开 = 服务端模式**（`http://127.0.0.1:3001/notes/playground.html`，转写走真实的既有 AI 接口）。

---

## 2. 编辑器怎么用

| 区域 | 说明 |
| --- | --- |
| 顶栏 | 文件名、三种模式、新建、保存到服务器、下载 `.md` / `.json` / 导出两个 |
| 左栏 | 编辑区 + 工具栏：格式按钮、**🖼 图片转写**、以及全部**布局开关**（👁 预览 / 🤖 AI 助手 / 🗂 文件数据 / ⛶ 只留编辑） |
| 中栏 | 实时预览（可收起；收起后**完全不占空间**） |
| 右栏 | **AI 助手** / **文件数据** / **我的笔记**（同样可收起、不占空间） |

**布局开关**（都在左侧工具栏里，状态记在浏览器本地）：

- **👁 预览 / 🤖 AI 助手 / 🗂 文件数据**：各自独立开关，按钮高亮表示「已打开」；点「🗂 文件数据」会打开侧栏并切到该页签，再点一次收起；
- **⛶ 只留编辑**：一键收起预览与侧栏，只剩编辑栏；再点恢复；
- **收起 = `display:none`**，一点空间都不占（不会留一条空栏）；打开后它们都在**右侧竖排**，不会横在编辑区下面；
- 窄屏（≤1000px）下编辑区占满一行，预览与侧栏改为**贴右边的抽屉**，依然是竖排。

- **可视化模式**：`contenteditable` 里直接编辑渲染后的内容，行首输入 `# `、`- `、`1. `、`> `、```` ``` ```` 会即时成形；切回源码模式时用 turndown 回落成 Markdown，**公式按 KaTeX 里保存的原始 TeX 还原**（不会把 `\int` 写成 `\\int`）。
- **图片转写**：点工具栏的 **🖼 图片转写** 展开面板（在编辑区上方，可随时收起）→ 点击 / 拖拽 / `Ctrl+V` 粘贴图片 → 选择目标（Markdown+LaTeX / 只要 Markdown / 只要 LaTeX）→ 结果可插入光标处或替换全文，并记入 `.json` 的 `ai.conversions`。
- **实时预览 / 侧栏**：开关都在左侧工具栏（👁 预览、🤖 AI 助手、🗂 文件数据、⛶ 只留编辑）；收起后不占空间，打开后在右侧竖排。
- **AI 助手**：整理与审阅都以当前正文为材料，**只有你点「应用」时才写回正文**，避免模型悄悄改坏笔记。
- **离线草稿模式**：直接双击打开 `public/index.html` 也能编辑与导出 `.md` / `.json`（浏览器端 `render.js` 会算同样的统计），只是保存到服务器与 AI 功能不可用。

---

## 3. 复用既有 AI 接口（重点）

```
forum-ai/src/index.mjs   ←  既有接口，本包只调用它，不修改它
        ▲ chat(messages, options)
        │
note-studio/src/ai-bridge.mjs   ← 唯一接触 AI 的模块（提示词 + 结果归一化）
        ▲ { chat, extractJson, aiStatus }  依赖注入
        │
论坛 src/notes.js  ← 告诉 note-studio「forum-ai 在哪」
```

- 本包**不读环境变量里的密钥、不发 HTTP 到上游、不做重试**——`AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` / `AI_TIMEOUT_MS` / `AI_MAX_TOKENS` 全部由 `forum-ai` 解释。
- 上游错误码（`ai_not_configured` / `ai_timeout` / `ai_rate_limited` / `ai_unreachable` / `ai_bad_json` …）**原样透传**，宿主的状态码映射继续生效。
- 独立运行时用 `loadForumChat({ env })` 从 `FORUM_AI_PATH`（默认 `../../forum-ai/src/index.mjs`）加载同一个接口。
- ⚠️ 图片转写需要**视觉模型**：`AI_MODEL` 要指向支持图片输入的模型（`deepseek-chat` 是纯文本模型）。未配置时接口返回 503 `ai_not_configured`，编辑器仍可离线使用。

---

## 4. HTTP 契约

统一响应：成功 `{ ok: true, data }`，失败 `{ ok: false, error: { code, message } }`。

| 方法 | 路径 | 说明 | 权限 |
| --- | --- | --- | --- |
| GET | `/api/notes/status` | 模块版本 + AI 可用性（不回传密钥） | 公开 |
| GET | `/api/notes` | 笔记列表（按更新时间倒序） | 登录 |
| POST | `/api/notes` | 保存：写 `<name>.md` 与 `<name>.json` | 登录 |
| GET | `/api/notes/:name` | 读取单篇（正文 + 元数据） | 登录 |
| DELETE | `/api/notes/:name` | 删除一对文件 | 登录 |
| POST | `/api/notes/convert` | 图片 → Markdown / LaTeX | 登录 |
| POST | `/api/notes/ai/organize` | AI 整理（标题/摘要/知识点/标签/大纲） | 登录 |
| POST | `/api/notes/ai/review` | AI 审阅（问题与修改建议） | 登录 |

错误码：`unauthenticated→401`、`forbidden→403`、`not_found→404`、`bad_request→400`、`too_large→413`、`rate_limited→429`、`ai_not_configured→503`、`ai_timeout→504`、其余上游错误 `→502`。

---

## 5. `.json` 里记录的基础数据

```jsonc
{
  "schema": "note-studio/document@1",
  "generator": { "name": "note-studio", "version": "1.0.0" },
  "file": { "name": "demo-note.md", "baseName": "demo-note", "extension": ".md",
            "mimeType": "text/markdown; charset=utf-8", "encoding": "utf-8",
            "bytes": 296, "lines": 10, "sha256": "ea445dce…" },
  "title": "电磁感应实验记录（整理版）",
  "stats": { "characters": 142, "charactersNoSpaces": 118, "words": 78, "cjkCharacters": 62,
             "latinWords": 16, "lines": 10, "nonEmptyLines": 8, "paragraphs": 4, "readingMinutes": 1 },
  "structure": { "maxDepth": 2, "headings": [ { "level": 1, "text": "…", "line": 1, "slug": "…" } ],
                 "outline": [ { "level": 1, "text": "…", "children": [] } ] },
  "math": { "inline": 2, "display": 0, "total": 2,
            "expressions": [ { "type": "inline", "tex": "N = 200", "line": 3 } ] },
  "media": { "images": [], "links": [] },
  "code": { "fences": 0, "blocks": [] },
  "tables": 0,
  "tasks": { "total": 0, "checked": 0, "unchecked": 0 },
  "timestamps": { "createdAt": "…", "updatedAt": "…", "savedAt": "…" },
  "ai": { "conversions": [ { "kind": "both", "model": "demo-vision", "at": "…", "source": "实验台照片.png" } ] }
}
```

统计口径：CJK 按字计、拉丁按词计；阅读时长 = `CJK/300 + 拉丁词/200` 分钟向上取整（最少 1 分钟）；
`bytes` 与 `sha256` 都基于**最终写入的 Markdown 文本**（UTF-8）；代码块内的 `#`、`$` 不会污染标题与公式统计。

---

## 6. 目录结构

```
note-studio/
├── src/
│   ├── meta.mjs        # 文档基础数据（→ .json），纯函数
│   ├── ai-bridge.mjs   # 唯一消费 forum-ai chat() 的适配层
│   ├── store.mjs       # 双写持久化：<name>.md + <name>.json（原子写、路径消毒）
│   ├── routes.mjs      # 框架无关 HTTP 处理器（注入 store / ai / currentUser）
│   ├── static.mjs      # 编辑器静态分发（防路径穿越）
│   ├── server.mjs      # 独立入口（挂在论坛里时用不到）
│   └── index.mjs       # 统一出口
├── public/
│   ├── index.html      # 编辑器页面
│   ├── studio.js       # UI 装配（模式、工具栏、四个面板）
│   ├── render.js       # 纯渲染与统计（Markdown → HTML → KaTeX；DOM → Markdown）
│   ├── selfcheck.html  # 浏览器内自检页
│   ├── playground.html # 可操作样例的外壳（手写）
│   ├── playground.js   # 可操作样例的逻辑（手写）
│   ├── playground-data.js # 样例数据（生成：内嵌样例笔记 + 样例照片）
│   └── vendor/         # KaTeX（含字体）/ marked / turndown，共约 1.4 MB，离线可用
├── tests/              # 零依赖测试（node:test）
│   └── browser/        # 可选的浏览器 / 集成 / 报告自检（需要 jsdom）
├── acceptance/         # 验收包：一条命令出证据 + 可审查的 HTML 报告
│   ├── run.mjs         # 验收主脚本
│   ├── README.md       # 怎么验收
│   ├── sample/         # 固定样例：笔记 .md + 笔记照片 .png
│   ├── output/         # 报告与真实产物（生成的）
│   └── tools/          # 样例图片生成脚本（可选，Python + Pillow）
├── examples/           # 应用样例（自带假 AI 服务）+ 产物
├── integration/        # 交付给论坛的胶水文件与补丁说明
└── README.md
```

---

## 7. 测试

```bash
node tests/run.mjs        # 81 项单元 + 集成测试，零依赖
```

> 用 `tests/run.mjs` 而不是 `node --test tests/`：内置 runner 会为每个文件 spawn 子进程并用管道收输出，
> 在受限沙箱下会 EPERM。单进程加载同样具备 `node:test` 的断言与退出码语义。

| 文件 | 覆盖 |
| --- | --- |
| `tests/meta.test.mjs` | 统计口径、标题/大纲、公式与代码块互不污染、文件名消毒、sha256 |
| `tests/ai-bridge.test.mjs` | 多模态消息形状、**必须关掉 json_object**、上游错误码透传、结果归一化与幻觉字段裁剪 |
| `tests/store.test.mjs` | `.md` + `.json` 双写、读回一致、列表、删除、原子写、路径穿越拒绝 |
| `tests/routes.test.mjs` | 状态码映射、401/403/400/404/413、`beforeWrite` 钩子、路由优先级 |
| `tests/static.test.mjs` | 前缀匹配、Content-Type、路径穿越（`..`、`%2e%2e`） |
| `tests/server.test.mjs` | 真起 HTTP、真落盘：保存两个文件、读回、删除、错误外壳 |

另有两个可选自检（需要 `jsdom`，仅验证用，不是本包依赖）：

```bash
NODE_PATH=<装有 jsdom 的 node_modules> node tests/browser/verify-render.mjs       # 29 项：公式渲染 + 块级公式结构 + 往返正确性
NODE_PATH=<装有 jsdom 的 node_modules> node tests/browser/verify-integration.mjs  # 21 项：论坛 × note-studio 真实登录态端到端
```

> 本机的 Chrome/Edge 在沙箱下起不来（mojo 命名管道被拒），所以浏览器验证用 jsdom 执行**同一套**前端资源。

---

## 8. 已知限制

- 图片识别依赖上游视觉模型，本包不做本地 OCR。
- 单机文件存储（`data/notes/`），没有并发编辑锁；同一篇同时保存是「后写覆盖」。
- 可视化模式是 Typora-lite 子集（标题 / 列表 / 引用 / 代码块 / 公式），复杂排版建议用源码模式。
- 图片转写单张上限 8 MB（`routes.mjs` 的 `DEFAULT_LIMITS.maxImageBytes`），正文 40 万字符。
- AI 整理/审阅是单轮调用，没有多轮追问。
