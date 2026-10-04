# 接入论坛（胶水层）

note-studio 是**独立包**：它不认识论坛，论坛也只在 3 个地方提到它。本目录就是那 3 处改动。

已经在本仓的 AI 版论坛上应用并验证过：`Work/.inspect/forum-ai-full/forum/`
（`node note-studio/tests/browser/verify-integration.mjs` → 21 项全通过）。

---

## 步骤 1：拷一个文件

```bash
cp note-studio/integration/notes.js   <论坛>/src/notes.js
```

这个文件只做三件事，不含业务逻辑：

1. 从 `../forum-ai/src/index.mjs` 取既有的 `chat / extractJson / aiStatus`，注入给 note-studio；
2. 把论坛的 `ctx.user` 传给 note-studio（未登录传 `null`，模块内部会 401）；
3. 把路由表与静态分发交出去给 `server.js` 注册。

它会按顺序找 note-studio：`NOTE_STUDIO_PATH` → `<repo>/.inspect/forum-ai-full/forum/src/` 布局 →
`<repo>/src/` 与 `<repo>/note-studio/` 同级布局。布局不同就设环境变量：

```bash
set NOTE_STUDIO_PATH=D:\...\note-studio\src\index.mjs
```

## 步骤 2：论坛 `src/server.js` 改 3 处

**2.1 顶部加 1 行 import**（放在 `./ai.js` 那行后面）

```js
import { createNotes, defaultNotesDir } from './notes.js';
```

**2.2 在 `route()` 定义之后挂载路由**（放在 `const isAdmin = ...` 之前即可）

```js
/* ---------------- 学术笔记（note-studio 独立包） ---------------- */

const notes = createNotes({ dataDir: process.env.NOTES_DIR || defaultNotesDir(ROOT) });

for (const entry of notes.routes) {
  route(entry.method, entry.pattern, async (ctx) => {
    if (entry.method !== 'GET') rateLimit(`notes:${ctx.user?.id ?? ctx.ip}`, 60, 60 * 1000);
    const result = await entry.handler(ctx);
    return sendJson(ctx.res, result.status, result.body, result.headers ?? {});
  });
}
```

`rateLimit` 与 `sendJson` 都是论坛自己的函数——写操作直接复用论坛既有的限流桶，不另造一套。

**2.3 请求处理里加静态分流**（放在 `return await serveStatic(req, res, pathname);` 之前）

```js
    // 学术笔记编辑器：/notes 及其静态资源交给 note-studio 自己分发
    if (pathname === '/notes' || pathname.startsWith('/notes/')) {
      const asset = await notes.serveStatic(pathname);
      if (asset) {
        res.writeHead(asset.status, asset.headers);
        return req.method === 'HEAD' ? res.end() : res.end(asset.body);
      }
    }
```

> 必须放在论坛自己的 `serveStatic` **之前**：论坛的静态分发会把未知路径回落到 SPA 首页。

## 步骤 3：论坛 `public/index.html` 加 1 行入口

```html
<a class="btn btn-sm" href="/notes/" title="Markdown + LaTeX 学术笔记编辑器">📓 笔记</a>
```

---

## 完成后的行为

| 位置 | 行为 |
| --- | --- |
| `GET /notes/` | 编辑器页面（静态，无需登录也能打开；未登录时接口会 401，界面会提示） |
| `GET /api/notes/status` | 公开：模块版本 + AI 可用性（不含密钥） |
| 其余 `/api/notes/*` | 走论坛登录态；写操作受论坛限流 |
| 落盘 | `<论坛>/data/notes/<名字>.md` 与 `<名字>.json`，与 `data/forum.db` 并列，便于整体备份 |

## 为什么只改这几行

- **不改 `forum-ai`**：note-studio 只调用它的 `chat()`，提示词与结果归一化留在自己这边。
- **不改论坛前端 SPA**：编辑器是独立页面，导航只是普通链接，不用往 `public/app.js` 里塞视图。
- **不改数据模型**：笔记存在文件系统，不建表、不碰 `forum.db`。

## 自检

```bash
NODE_PATH=<装有 jsdom 的 node_modules> node note-studio/tests/browser/verify-integration.mjs
```

会用临时数据库与临时笔记目录起一个论坛实例，验证：编辑器页面、静态资源、路径穿越、未登录 401、
管理员登录后保存/读取/列表/删除、磁盘上确实是一对 `.md` + `.json`、未配 AI 时 503 语义。
