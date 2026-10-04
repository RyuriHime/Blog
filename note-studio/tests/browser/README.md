# 可选自检（浏览器 / 集成）

本目录的两个脚本**不属于**零依赖测试套件（`node ../run.mjs` 才是）。它们需要额外的 `jsdom`，
只在你想验证「公式真的渲染出来了」和「接入论坛后端到端没坏」时跑。

```bash
mkdir verify && cd verify && npm i jsdom      # 或 pnpm add jsdom
cd -

NODE_PATH=<verify>/node_modules node tests/browser/verify-render.mjs
NODE_PATH=<verify>/node_modules node tests/browser/verify-integration.mjs
```

| 脚本 | 覆盖 | 结果 |
| --- | --- | --- |
| `verify-render.mjs` | 用 jsdom 执行 **同一套** 前端资源：KaTeX 是否真的产出 `.katex`、**块级公式是否渲染成块级且不嵌在 `<p>` 里（6 种写法）**、页面是否还残留 `$` 源码、代码块里的 `$` 是否被误判、行内公式扫描器的计数、以及可视化模式的往返（KaTeX 产物 → 原始 TeX → Markdown） | 29 项 |
| `verify-integration.mjs` | 直接 import 论坛 `server.js`（它自己 listen，不需要 spawn）：临时库 + 临时目录起真实服务，验证编辑器页面、静态资源、路径穿越、未登录 401、管理员登录后保存/读取/列表/删除、磁盘上确实是一对 `.md` + `.json`、未配 AI 时 503 | 21 项 |

## 为什么用 jsdom 而不是无头浏览器

本机（Windows + DSH 沙箱）下 Chrome/Edge **起不来**：

```
FATAL:mojo\public\cpp\platform\platform_channel.cc:187 Check failed: . : 拒绝访问。(0x5)
```

浏览器多进程 IPC 依赖命名管道，受限沙箱不允许。jsdom 能在 Node 里执行同样的前端代码，
足以验证「渲染管线的行为」，只是没有真实排版引擎。

`verify-integration.mjs` 用 `FORUM_ENTRY` 指定论坛入口（默认取本仓 `.inspect/forum-ai-full/forum/src/server.js`）：

```bash
FORUM_ENTRY=/path/to/forum/src/server.js node tests/browser/verify-integration.mjs
```
