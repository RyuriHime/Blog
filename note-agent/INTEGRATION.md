# 接进一个已有站点：6 处胶水

这个包不要求宿主改任何现有逻辑，也**不要求宿主写任何面板 CSS**（只需要给挂载点留一条
`display: block`，见第 6 节）。
接进去 = 加一个目录 + 追加 6 处代码；撤掉 = 删目录 + 撤这 6 处，不留痕。

> 本文以"围炉论坛"这份 Node 原生 http 服务为例（它就是本包的第一个宿主）。
> 换成 Express / Koa / Fastify 也一样：**能拿到 `node:http` 的 `server` 实例**、
> **有一个能按 `req` 认出用户的函数**、**有一个 `node:sqlite` 的 `DatabaseSync`**，就够了。

---

## 0. 前置条件

| 需要什么 | 为什么 | 没有会怎样 |
| --- | --- | --- |
| `node:sqlite` 的 `DatabaseSync` 实例 | 会话/草稿/历史/审查结果都落在这 11 张 `notes_*` 表里 | `mountNoteAgent({db})` 直接抛 `mountNoteAgent 需要 db` |
| `resolveUser(req) → {user} \| {user:null}` | 面板是"我的工作台"，要按用户隔离 | 抛 `mountNoteAgent 需要 resolveUser(req)` |
| Node ≥ 22.5（要 `node:sqlite`） | 存储层零依赖就靠它 | 起不来 |
| （可选）宿主的 AI 包在场 | 在就用它，不在就用本包自带的兜底实现 | 不影响启动，只会切到 `aiSource: "bundled"` |

**AI 层是可选的，不用为了它改任何 import。** 本包所有模型调用都收口在 `src/ai.mjs`：
它启动时探测兄弟目录 `../../forum-ai/src/ai.mjs`，**在就用，不在就用自带的兜底实现**
（`src/ai-local.mjs` + `src/json-local.mjs`，请求形状与错误码逐条对齐，有测试钉着）。
当前用的哪套可以问接口：`GET /api/notes/status` → `aiSource: "forum-ai" | "bundled"`。

所以两种目录形态都能跑：

```
your-site/                          your-site/
├── forum-ai/     ← 有就用它的 AI 实现   ├── note-agent/   ← 自带兜底，照样跑
├── note-agent/   ← 整个拷进来          ├── src/server.js
├── src/server.js                     └── public/
└── public/
```

想换成你们自己的 AI 模块（比如内部网关），只要实现三个函数并改 `src/ai.mjs` 一处：

```js
export function aiConfig(env)   // → { apiKey, baseUrl, model, timeoutMs, maxTokens, configured }
export function aiStatus(env)   // → 不含密钥的状态（面板拿它决定按钮是否可用）
export async function chat(messages, options)  // → { text, model, usage: { prompt, completion }, raw }
export function extractJson(text)              // → 解析失败返回 null，别抛
```

环境变量沿用 OpenAI 兼容那一套：`AI_BASE_URL`（默认 `https://api.deepseek.com/v1`）、
`AI_API_KEY`（必填）、`AI_MODEL`（默认 `deepseek-chat`）、`AI_TIMEOUT_MS`、`AI_MAX_TOKENS`。
本包另外认 `NOTES_MATERIAL_CHARS`（默认 24000）。

---

## 1. 后端：import 并挂载

在 `src/server.js` 里加（放在你已有的路由注册**之后**、`server.listen()` **之前**）：

```js
// ── AI 笔记整理 Agent（note-agent/）────────────────────────────────
import { mountNoteAgent, noteAgentStatus } from '../note-agent/src/index.mjs';

const notes = mountNoteAgent({
  db,                                   // node:sqlite 的 DatabaseSync
  resolveUser: (req) => ({ user: currentUser(req) }),  // 与宿主同一套登录判定
});
notes.attach(server);                   // 必须在 listen() 之前：它要接 request 事件
```

`notes.attach(server)` 做了两件事：把 `${basePath}/*` 的请求接过去，把面板脚本、样式与
渲染兜底模块（`/notes-panel.js`、`/notes-panel.css`、`/notes-markdown.js`）当静态资源发出去。

**`attach()` 会短路哪些路径**（其余原样交回宿主 listener，所以**不能**排在既有路由前面抢路由）：

| 路径 | 说明 |
| --- | --- |
| `/notes-panel.js`、`/notes-panel.css`、`/notes-markdown.js` | 面板脚本、样式、渲染兜底模块，GET/HEAD，不需要登录 |
| `${basePath}/status`、`${basePath}/…` | 默认 `/api/notes/*`，全部 13 条接口 |

可选项（都有合理默认值）：

```js
mountNoteAgent({
  db,
  resolveUser,
  basePath: '/api/notes',   // 改前缀
  materialChars: 24000,     // 发给模型的材料字符预算
  tablePrefix: 'notes_',    // 表前缀，避开宿主既有表
  quiet: true,              // false 时打印挂载日志
});
```

> 材料**不落盘**：上传的 Markdown/DOCX/PDF 在内存里抽成文本后直接进 `notes_materials` 表，
> 所以没有"上传目录"这个配置项，也不用给挂载层准备可写目录。

## 2. 后端：把状态挂到已有的 `/api/site`

宿主前端要问"这个站点配好 AI 了吗"，加一处就够：

```js
route('GET', '/api/site', (ctx) => ok({
  notes: notes.status(),   // 见 API-REFERENCE.md 的 GET /status
}));
```

（论坛副本里这一行在 `src/server.js` 的 `/api/site` 处理器里；`/api/site` 本来就是公开接口。）

## 3. 前端：加载面板脚本

`public/index.html` 的 `<head>` 或 `</body>` 前加一行：

```html
<script type="module" src="/notes-panel.js"></script>
```

它是 `note-agent/client/notes-panel.mjs`，**没有任何构建步骤**，直接就是浏览器能吃的 ESM。

> 唯一不要把 `src/index.mjs` 引进浏览器的原因：它会拉进 `node:sqlite` 与 `node:fs`。

## 4. 前端：写作页加挂载点

在写作用的表单里加一个空 div（论坛副本在 `public/app.js` 的正文输入框**之后**）：

```js
// public/app.js：正文与工具栏之后
<div id="notesMount" class="notes-mount"></div>
```

## 5. 前端：挂载面板（守卫式）

同一处、紧跟挂载点之后：

```js
// public/app.js：面板挂载（脚本没加载成功时静默跳过，写作页照常可用）
if (window.NotesAgent) {
  window.NotesAgent.attach({
    mount: $('#notesMount'),
    editor: window.NotesAgent.createTextareaAdapter($('#composeForm')),
    postId: post?.id ?? null,      // 编辑已有帖子时复用同一篇的工作台
  });
}
```

`postId` 传了以后，同一篇帖子再次打开会接上上次的会话（`sessionForPost`）；
新帖（`postId: null`）按编辑区内容建新会话。

**换编辑器**（不是 textarea，而是富文本 / CodeMirror / 自研所见即所得）：
写一个实现 `getDoc / setDoc / onChange`（+ 可选 `getImages / buildImageUrl / scrollTo`）的适配器，
把 `editor:` 换成它即可 —— 面板代码一行都不用改，见 [`EDITOR-CONTRACT.md`](EDITOR-CONTRACT.md)。

---

## 6. 前端：给挂载点留一条样式（第 6 处，也是最后 1 行）

面板会自己把 `notes-mount` 加到挂载点上，但"这个 div 别被你的布局当成 inline 元素"这件事
只能由宿主声明。加一行就够：

```css
/* public/style.css：面板挂载点（面板自己的样式在 /notes-panel.css，不用往这里粘） */
.notes-mount { display: block; }
```

## 7. 不需要做的事（这一节以前是"第 6 处胶水"）

- **不用往 `public/style.css` 里粘面板样式。** 面板样式跟着面板走：
  `note-agent/client/notes-panel.css` 由挂载层在 `/notes-panel.css` 发出去，面板自己往
  `document.head` 认领一条 `<link>`。样式里的颜色一律走宿主主题变量
  （`--panel` / `--text` / `--accent` …），取不到时退回面板自带的 `--notes-*` 兜底值 ——
  所以放到一个完全没有主题变量的站点上，也只是"朴素"，不会是白底黑字的裸块。
- **不用建表。** 11 张 `notes_*` 表在首次挂载时 `CREATE TABLE IF NOT EXISTS` 建好，
  老库会自动补列（`notes_messages.draft_md` 就是增量加列加出来的）。
- **不用改宿主的 Markdown 渲染器。** 面板的"效果预览"直接调宿主已有的
  `POST /api/markdown/preview`（论坛副本在 `public/app.js` 的"预览"按钮后面那条），
  所以预览与发布后的渲染**天然一致**，不会出现"预览好看、发出去两样"。
  宿主**没有**这个接口也能用：面板会退一步动态 import 挂载层发出的
  `/notes-markdown.js`（就是本包自带的 `src/markdown-core.mjs`）自己渲染；
  两条路都不通才退回"原文"视图，并在面板上写明原因。
  想让它和站内渲染完全一致，就照 `note-agent/examples/server.mjs` 里的 `handlePreview()`
  加一个 20 行的接口即可（渲染直接用宿主自己的 `src/markdown.js`）。
- **不用写 AI 接口。** 三个花钱的动作（`/generate`、`/turn`、`/review`）都走 `src/ai.mjs`：
  旁边有 `forum-ai` 就用它，没有就用包自带的兜底实现 —— 两种情况都不用宿主写代码。

---

## 8. 回滚清单

```bash
rm -rf note-agent/          # 1. 删目录
```

再把上面 6 处追加的代码删掉即可。数据库里的 11 张 `notes_*` 表可以留着（不占多少空间，
也不被宿主任何业务逻辑读写），想彻底清干净就：

```sql
DROP TABLE notes_sessions, notes_materials, notes_attachments, notes_messages,
           notes_reviews, notes_assets, notes_review_items, notes_turn_logs,
           notes_usage, notes_prefs, notes_schema_meta;
```

**本包不写宿主的任何业务表**，所以回滚不会丢用户的帖子与草稿。

---

## 9. 接完自查这 6 条

1. `curl -s localhost:PORT/api/notes/status` → `{"ok":true,"data":{"configured":true,"aiSource":"bundled",…}}`
   （`configured:false` 说明 `AI_API_KEY` 没配好，界面会提示"这个站点还没有配置 AI 接口"；
   `aiSource` 告诉你当前用的是宿主的 AI 包还是本包自带的兜底实现）。
2. `curl -sI localhost:PORT/notes-panel.js` → 200 + `text/javascript`。
3. `curl -sI localhost:PORT/notes-panel.css` → 200 + `text/css`。
4. `curl -sI localhost:PORT/notes-markdown.js` → 200 + `text/javascript`（宿主没有
   `/markdown/preview` 时，面板的「效果」预览靠它）。
5. 打开写作页：左侧出现抽屉（窄屏是一条竖标签），编辑区打字时抽屉顶部的字数跟着变，
   **此时网络面板里没有模型调用**。
6. 宿主原有的发布/预览/草稿功能照旧 —— 面板只在用户点「应用到编辑区」时调 `editor.setDoc()`。
