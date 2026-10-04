# 把 AI 笔记整理 Agent 接进 note-studio（新编辑器适配流程）

> 读者：维护 `http://<你的服务器地址>:8080/notes/`（note-studio）的同学。
> 结论先放前面：**编辑器那边要加一个「对外钩子」（约 15 行）+ 一个挂载点、一个 `<script type="module">`、一个适配器文件，一共 4 处改动**；
> 面板本身一行都不用改 —— 面板只通过 `EDITOR-CONTRACT.md` 里那三个方法跟编辑区打交道。
>
> 本文按**两层证据**写：(a) 已上线那份源码（`/notes/` 9916 B、`/notes/studio.js` 35244 B、`/notes/render.js` 9229 B、`public/app.js` 180689 B 都读过）；
> (b) **2026-10 用真账号在你们站点上跑了一遍**（`/#/notes` 与 `/notes/` 都用 Playwright 打开，登录后逐项核对了 DOM id、`window` 全局、`/api/notes/status` 响应、状态栏文案）。
> (c) **2026-10-02 又把 `/notes/` 的 HTML 原文整页抓下来逐行核过**（`/api/auth/login` 登进 `测试账号` → `GET /notes/`），第 9 节的删除清单与第 4 节那张锚点表就是照原文行号写的。
> 因此下面凡是没有标 ⚠️ 的，都是**已核验事实**；标 ⚠️ 的才是"按源码推断、但没在你们站点上跑过"的少数几处。

---

## 1. 「适配」到底适配什么

三段东西，只有**中间一段**需要你们动手：

```
① AI 笔记整理 Agent（我们的包，87 个文件）—— 面板 = 右侧固定抽屉
        ↕  只认 EDITOR-CONTRACT.md 的 3 个方法（getDoc / setDoc / onChange）
② 适配器（你们写，约 20 行）—— 把 note-studio 的内部 API 翻译成那 3 个方法
        ↕
③ note-studio（你们的编辑器）—— 双模式（#source textarea / #wysiwyg 所见即所得）+ KaTeX 预览
```

面板**不碰**你们的 DOM、不读你们的 `localStorage`、不发任何模型请求（你不点它就不花钱）。
它自己往 `document.head` 认领一条 `<link href="/notes-panel.css">`，其它一切都在挂载点里。

**装上去以后多了什么**（对照你们现有的 `AI 整理` / `AI 审阅` 侧栏）：

| 能力 | note-studio 侧栏现有 | 我们的面板 |
| --- | --- | --- |
| AI 整理 / 审阅 | ✅ 一轮，手动「应用」 | ✅ 一轮或多轮，可带补充材料 |
| 对话式多轮 | ❌ | ✅ 有会话记录，可连续提需求 |
| 草稿隔离 | ❌ 直接改正文 | ✅ 模型动草稿，你点「应用到编辑区」才落到正文 |
| 回滚 | ❌ | ✅ 每一轮留快照，可回到任意一轮、可「回到最新」 |
| 预览 | 用编辑器自己的预览 | 抽屉顶部自带效果/原文切换（复用你们的 `/api/markdown/preview`） |
| 图片参与理解 | 图片转写（`/convert`） | 编辑区已有图片直接递给模型（可选实现） |
| 手机端 | 三栏在小屏会挤 | ≤1080px 默认收起、≤480px 铺满 + 三条逃生通道 |

**交付决定：原来的 AI 侧栏就不要了，只留我们的抽屉。** 同一页放两个 AI 助手会让人不知道该点哪个
（一个改草稿、一个直接改正文，行为还不一样），所以**不要共存**。具体怎么下线见第 9 节——
接口层不用动（两套前缀本来就不同），只是把入口收掉。

---

## 2. 现在缺什么：studio.js 是闭合的 IIFE

`studio.js` 现在是：

```js
(function () {
  const state = { name, markdown, mode, … };
  function replaceAll(text) { … }        // :233  改整篇正文的唯一入口
  function onSourceInput() { … }         // 绑 #source 的 input
  function scheduleUpdate() { … }        // :408  setTimeout(…, 200) → refreshPreview/refreshInfo/persistDraft
  async function boot() { … }            // :912
  …
  boot();
})();
```

`state` / `replaceAll` / `scheduleUpdate` 全在闭包里，**外面一个都拿不到**，所以面板没法知道"现在正文是什么"、也没法"把整理结果写回去"。
要做的就是开一扇最小的窗（第 4 节）。

**这一点已在你们站点上实测确认**：`/notes/` 页面上 `window` 里只有 `NoteRender`（object，你们自己的渲染器），
**没有任何编辑器实例钩子**（`window.NoteStudio` 之类的都没有）。所以第 4 节 ③ 是**必须做**的，不是可选项。

⚠️ 另外记住两个**真实存在**的坑（都在源码里）：

1. **所见即所得模式下 `#source.value` 是滞后的。**
   `enterWysiwyg()` 之后 `#source` 被 `hidden`，只有 `#wysiwyg` 的 input 监听里会
   `state.markdown = serializeWysiwyg(); $('source').value = state.markdown;`；
   `leaveWysiwyg()` 才做一次完整序列化。**所以适配器绝不能直接读 `#source.value`**，
   必须走第 4 节的 `getMarkdown()`（内部按模式取）。
2. **`refreshPreview()` 在 wysiwyg 模式下直接 `return`**（`if (state.mode === 'wysiwyg') return;`），
   所以"写回正文"之后别指望它帮你刷新，得自己调 `scheduleUpdate()` 或 `leaveWysiwyg()`。

---

## 3. 事前准备：服务端先挂上（否则面板浏览器里一直在转）

面板的接口和静态资源由挂载层提供，**和你们的 `/api/notes/*` 是两套东西**，
所以第一步是给它在你们服务端找一块地儿挂上。

⚠️ **路径碰撞（必须看）**：`mountNoteAgent({ basePath })` 的默认值是 `/api/notes`，
它会把 `pathname === '/api/notes/status'` 或 `pathname.startsWith('/api/notes/')` **全部截胡** ——
而你们的 `GET /api/notes`（笔记列表）、`POST /api/notes`（保存）、`/api/notes/:name`、
`/api/notes/status`、`/api/notes/ai/organize`、`/api/notes/ai/review` 正好都在这棵树下。
**必须换一块前缀**，例如 `/api/note-agent`：

```js
// 你们 server 里（挂在已有 request listener 上，机制与 forum-ai 一致）
import { mountNoteAgent } from '../note-agent/src/mount.mjs';

mountNoteAgent({
  db,                       // 你们的 node:sqlite DatabaseSync 实例
  resolveUser,              // (req) => ({ user, sessionToken }) | null，照抄你们给论坛路由用的那个
  basePath: '/api/note-agent',   // ← 必须改，别用默认的 /api/notes
  quiet: false,
}).attach(server);
```

它建自己的 `notes_*` 表（`CREATE TABLE IF NOT EXISTS`），**不写你们的任何表**；
静态资源与 `basePath` 无关，固定发在 `/notes-panel.js`、`/notes-panel.css`、`/notes-markdown.js`。

**前置条件**（都满足才起得来）：Node ≥ 22.5（要 `node:sqlite`）、一个可写的 SQLite 库、
`AI_API_KEY`（缺了面板能打开但按钮会告诉你没配置模型）。`AI_BASE_URL` 默认 `https://api.deepseek.com/v1`，`AI_MODEL` 默认 `deepseek-chat`。
**不需要**给上传材料准备落盘目录：材料（Markdown/DOCX/PPTX/PDF）在内存里抽成文本后写进 `notes_materials` 表，
图片以 data URL 写进 `notes_attachments` 表（各表各自有上限，见 `API-REFERENCE.md`）。

**自检**：`curl -s http://127.0.0.1:8080/api/note-agent/status` 应当回
`{"ok":true,"data":{"configured":true,"model":"…","aiSource":"forum-ai"|"bundled","features":[…],"contractVersion":…,"materialChars":…,"limits":{…}}}`。
（`aiSource` 是 `forum-ai` 表示复用了同仓的 `forum-ai/src`，`bundled` 表示走自带兜底。）

**你们现在的 `/api/notes/status` 已实测**（匿名可访问，2026-10 真机）：回的是一个**同形状的 `ok/data` 信封**，但字段是你们自己的：

```json
{"ok":true,"data":{"version":"1.0.0",
  "ai":{"configured":true,"model":"deepseek-flash","baseUrl":"https://api.deepseek.com",
        "envKeys":["AI_BASE_URL","AI_API_KEY","AI_MODEL","AI_TIMEOUT_MS","AI_MAX_TOKENS"]},
  "limits":{"maxCharacters":400000,"maxImageBytes":8388608}}}
```

它**没有** `aiSource` / `features` / `contractVersion` / `materialChars`，`limits` 里也是 `maxCharacters` / `maxImageBytes`（不是我们的 `maxFileBytes` / `maxSessionBytes` / `maxFiles` / `requirement` / `reviewDraft`）。
所以两个 `/api/notes/status` 长得**很像但不是一个东西** —— 正因为像，才更要把前缀分开（第 3 节开头那条），别让挂载层把你们的接口截胡了。

---

## 4. 编辑器要改的 4 处（全部是加法）

先给你们一份**真机核验过的锚点**（2026-10 在 `/notes/` 上实测，`window` 全局只有 `NoteRender`，没有编辑器钩子）：

| 我们要用的东西 | 真机实测的 id | 说明 |
| --- | --- | --- |
| 正文（源文本） | `#source`（`textarea`） | 点号 `$()` 取；所见即所得模式下它滞后，见第 2 节 |
| 所见即所得正文 | `#wysiwyg`（`div`） | 该模式下的正文在这里 |
| 文件名 / 标题 | `#fileName`（`input`，实测值「我的笔记」） | 钩子里当标题用 |
| 新建 | `#btnNew` | 换文档后要喊一声 |
| 保存到服务器 | `#btnSave` | 与面板无关，别混 |
| 自带 AI 页签（**要下线**） | 工具栏 `#btnAi`、页签 `.tab[data-tab="ai"]`、内容块 `.tab-body[data-body="ai"]` | 里面装着 `#btnOrganize` / `#btnReview` / `#aiResult`，三处一起删；见第 9 节 |
| 图片转写：结果框 / 插入 / 全替换 | `#resultBox`、`#btnInsertResult`、`#btnReplaceAll` | `#btnReplaceAll` 是"用转写结果换掉整篇"的入口 |
| 模式切换 | 三个**无 id** 的 `button.mode`（「源码」「分栏」「可视化」，当前项带 `active`） | 所以钩子里别按 id 找模式按钮，直接改 `state.mode` |
| 预览 / 状态栏 | `#previewPane`、`#preview`、`#renderStatus`、`#statusText`、`#statusStats`、`#statusMode` | 排版让位见第 7 节 |
| 侧栏容器（**保留**） | `#sidebar`（`aside`） | 里面还有「文件数据」「我的笔记」两块，别整个藏掉；见第 9 节 |

### ① `notes/index.html`：加一个挂载点

放在 `</body>` 前就行（抽屉是 `position: fixed`，不占布局）：

```html
<div id="notesPanelMount" class="notes-mount"></div>
```

`class="notes-mount"` 建议写上（面板样式全部收在它下面，写早一步样式就早一步生效）；
漏了也不会坏 —— `attach()` 会自己补上、`destroy()` 再摘掉。

### ② `notes/index.html`：加载面板脚本

```html
<script type="module">
  import { attach } from '/notes-panel.js';
  import { noteStudioAdapter } from './studio-adapter.js';   // 见第 5 节
  attach({
    mount: document.getElementById('notesPanelMount'),
    editor: noteStudioAdapter(window.NoteStudio),
    apiBase: '/api/note-agent',   // ← 与第 3 节的 basePath 一致
    hostBase: '/api',             // 预览打 /api/markdown/preview（你们本来就有这个接口）
  });
</script>
```

### ③ `studio.js`：把 IIFE 的返回值挂出来（约 15 行）

在 `boot();` 那一行**之前**加：

```js
  // ---- 对外钩子：给 AI 笔记整理面板用（EDITOR-CONTRACT v1）----
  window.NoteStudio = {
    version: '1',
    getMarkdown: () => (state.mode === 'wysiwyg' ? serializeWysiwyg() : $('source').value),
    getTitle: () => $('fileName').value || state.name || '',
    setTitle(name) {
      if (typeof name !== 'string' || !name) return;
      state.name = name;
      $('fileName').value = name;
    },
    setMarkdown(markdown) {
      if (typeof markdown !== 'string') return;
      if (state.mode === 'wysiwyg') leaveWysiwyg();   // 否则 replaceAll 写的是隐藏 textarea，用户看不见
      replaceAll(markdown);                           // :233 它会自己同步 state.markdown / #source / 预览
      scheduleUpdate();                               // :408 兜底刷新预览、信息栏与本地草稿
    },
    subscribe(cb) {
      const fns = [cb];
      const emit = () => {
        const doc = { title: this.getTitle(), markdown: this.getMarkdown() };
        fns.forEach((fn) => { try { fn(doc); } catch { /* 单个订阅者出错不该影响编辑器 */ } });
      };
      // 草稿要 flush 之后再通知，否则读到的还是上一次的内容
      const emitSoon = () => setTimeout(emit, 0);
      $('source').addEventListener('input', emitSoon);
      $('wysiwyg').addEventListener('input', emitSoon);
      $('btnNew').addEventListener('click', emitSoon);
      window.addEventListener('note-studio:doc-changed', emitSoon);
      return () => {
        const i = fns.indexOf(cb);
        if (i >= 0) fns.splice(i, 1);
      };
    },
  };
```

### ④ `studio.js`：在几处"正文换了"之后喊一声

`subscribe()` 里只挂了 `#source`/`#wysiwyg`/`#btnNew`，剩下这些是 JS 直接改 `state.markdown` 的，喊一声就行：

- `openNote(name)`（`:733`）：写完 `state.markdown = data.markdown; $('source').value = data.markdown;` 之后
  `window.dispatchEvent(new Event('note-studio:doc-changed'));`
- `setMode(mode)`（`:320`）末尾：同上（切到 wysiwyg 后 `#source` 就不可信了）
- 「图片转写」里点了 **`#btnReplaceAll`**（用转写结果换掉整篇，`:880` 的 `$('btnReplaceAll').onclick = () => replaceAll($('resultBox').value)`）之后：同上
- ~~你们**自己侧栏**里那个「应用整理后的正文」按钮之后~~：**这一条按第 9 节下线 AI 页签之后就不需要了**
  （它叫 **`#btnApplyMarkdown`**，是 AI 结果渲染时**动态创建**的 —— `notes_studio.js:558` 生成、`:567` 绑 `onclick`；
  第 9 节把承载它的 `data-body="ai"` 整块删掉之后，这个按钮不会再出现，`$('btnApplyMarkdown').onclick = …`
  会因为 `$()` 返回 `null` 而**静默跳过**，不会报错）

> 真机核验：`$` 就是 `const $ = (id) => document.getElementById(id);`（`notes_studio.js:14`），
> 上面这些 id 全部实测存在。⚠️ 但"哪几个函数会改 `state.markdown`"是按源码读出来的，你们改过代码的话以实际为准 ——
> 判据很简单：**凡是让 `state.markdown` 变的路径都要喊一声**，漏一处就只是那一路不实时刷新，不会坏。

> **顺手提一个我们读代码时发现的小隐忧**（不改也能用）：上面 `subscribe()` 的 `return` 只把回调从数组里删掉，
> 三个 `addEventListener` 与 `window.addEventListener` 并没有解绑。面板只会订阅一次、也从不 `destroy()`，
> 所以现在不会出问题；但如果有别的代码反复订阅，监听器会累积。要稳妥就把订阅器句柄一起返回、在 `return` 里
> `removeEventListener` 掉。**这是建议，不是适配必需项。**

### ⑤ 新增 `notes/studio-adapter.js`（约 20 行，见下一节）

改完刷新 `/notes/`：右侧应当出现抽屉，左下角状态胶囊显示「正在跟随编辑区 · N 字」。

---

## 5. 适配器（对接 `EDITOR-CONTRACT.md`）

```js
// notes/studio-adapter.js —— 把 window.NoteStudio 翻译成面板认的三个方法
export function noteStudioAdapter(studio) {
  if (!studio) throw new Error('note-studio 还没挂载（window.NoteStudio 为空）');
  return {
    getDoc: () => ({ title: studio.getTitle(), markdown: studio.getMarkdown() }),
    setDoc({ title, markdown, mode = 'replace' } = {}) {
      if (typeof title === 'string') studio.setTitle(title);
      if (typeof markdown !== 'string') return;
      const current = studio.getMarkdown();
      studio.setMarkdown(mode === 'append' ? `${current}${current.endsWith('\n') ? '' : '\n'}${markdown}` : markdown);
    },
    onChange(cb) {
      return studio.subscribe((doc) => cb(doc));
    },
    // 可选：编辑区里已有的图片（不实现就等于"这个编辑器没有图片"）
    // getImages: () => [...document.querySelectorAll('#preview img')].map((img) => ({ src: img.getAttribute('src'), alt: img.alt })),
  };
}
```

契约里的硬要求（`EDITOR-CONTRACT.md` 第 1、4 节）：

- `getDoc().markdown` 必须是**源文本**（`$…$`、`$$…$$`、`![alt](src)` 原样），不能是渲染后的 HTML —— 上面走 `state.markdown` 天然满足。
- `setDoc()` 之后编辑器内部模型与 DOM 都更新，并派发一次变更事件（`replaceAll` + `scheduleUpdate()` 已覆盖）。
- `onChange()` 返回的取消函数可重复调用；`destroy()` 之后不再触发。
- 面板只往 `mount` 里写节点，**不要**把这个 `div` 放进会被虚拟 DOM 整体重建的子树（你们是纯原生，天然安全）。

---

## 6. 预览渲染复用你们自己的接口（但结果里没有公式）

面板「效果」预览会打 `POST <hostBase>/markdown/preview`，体 `{content}`，读回 `{html}` ——
**你们已经在用这个接口**（`app.js:3089` 的写帖预览），所以 `hostBase: '/api'` 就是对的，
预览与站内帖子渲染完全一致。

**真机核验过的一处落差（建议看一眼）**：你们站内**帖子**的公式是**客户端**补渲染的 ——
`ntRenderMath()`（`app.js:3467`）在 `/#/notes` 的阅读视图上动态加载 `/notes/vendor/katex/*` 后调 `renderMathInElement`。
而 `POST /api/markdown/preview` 是**服务端 Markdown → HTML**，不含 KaTeX；论坛自己的 `public/style.css` 里
一条 `katex` 规则都没有（`grep -c katex` = 0），而 note-studio 用的是自带 CSS。
⇒ 结论：**走 `hostBase: '/api'` 的预览里，`$…$` / `$$…$$` 会以原文出现**（不会报错，只是不好看）。
两个选择：

1. 你们的预览接口也接一下 KaTeX（服务端渲染，或者返回后让前端 `renderMathInElement` 一次）；
2. 用面板自带的兜底渲染器 —— 但它同样**不认公式**。

这条是"锦上添花"，不影响整理结果本身：**面板发给模型的永远是源文本**（`$…$` 原样），
所以公式在材料与生成里都是对的，只是预览席位上不好看。

接不通 `/api/markdown/preview` 时的兜底（不用你们做任何事）：面板会动态 `import('/notes-markdown.js')`
用自带渲染器顶上；它也不认公式，所以"能接通就用你们的接口"仍然成立。

---

## 7. 排版冲突：抽屉会盖住右边 420px

面板是 `position: fixed; right: 0; width: min(420px, 100dvw)`，展开时会盖住你页面右侧 420px
（也就是你们的预览栏 + `aside#sidebar`）。面板展开时会给 `document.body` 挂一个 `notes-drawer-open` 类，收起时摘掉，**三种处理随你挑**：

```css
/* A. 什么都不做：抽屉盖着就盖着，用户可以把预览关掉（你们已有 👁 预览 / no-preview） */
/* B. 工作区整体左移（推荐） */
body.notes-drawer-open .workspace { padding-right: 432px; }
/* C. 让编辑器自己的预览栏让位（两个预览不重复） */
body.notes-drawer-open #previewPane { display: none; }
```

**真机核验过的布局事实**（`notes_studio.css:114-126`）：`.workspace` 是
`grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 340px`（源码栏 / 预览栏 / 侧栏），
收起时靠加 `.no-preview` / `.no-sidebar` 类**减列**（`display: none`），不是靠拖宽度。
所以：

- 选 B 时**作用在 `.workspace` 上**（它的 `padding` 本来就是收缩的），比作用在 `main` 上稳；
  `432px = 420px（抽屉）+ 12px（右边距）`。
- 视口 ≲1280px 时 B 会把源码栏压到 ~420px 以下，这时可以叠加 C（`@media (max-width: 1280px) { … }`）。
- 你们已有「👁 预览」开关，B + C 组合起来用户仍能自己找回空间；A 最省事但抽屉会压住侧栏。
- 我们的论坛用的是 B 那一类做法（给主内容留右内边距）。

---

## 8. 手机端不用适配

面板自带断点：≤1080px 默认收起只留右侧竖标签、≤480px 铺满整屏；
窄屏有三条逃生通道（右上角 `›`、`Esc`、点抽屉外面）、触控目标 ≥44px、`padding` 带 `env(safe-area-inset-*)`。
你们唯一要保证的是页面 `<head>` 里有：

```html
<meta name="viewport" content="width=device-width, initial-scale=1">
```

**这一条你们已经有了**（2026-10 在 `/notes/` 上实测读到，`/#/notes` 与 `/` 也都有），所以第 8 节实际上**不用改任何东西**。

**没有它的后果**：浏览器的布局视口会当成 980px，抽屉会以为自己"够宽"而默认展开、还跑到屏幕外去
（我们的演示页就这么翻过一辆车）。

---

## 9. 下线编辑器自己的 AI 页签（**必做**，不是可选项）

**结论先说：原来的「AI 整理 / AI 审阅」侧栏不要了，只留我们的抽屉。**

理由不是"我们的更好"，而是**两个助手并排放在同一页，用户没有任何办法知道该点哪一个**：
你们侧栏改的是正文本身、我们的抽屉改的是草稿（要点「应用到编辑区」才落回正文），
行为不一样却长得很像，教一遍也记不住。留一套就够了。

接口层**不用动**：两套前缀本来就不同（你们的 `/api/notes/ai/*` vs 我们的 `/api/note-agent/*`），
把入口收掉即可，服务端那些路由留着不碍事（也可以顺手删）。

### 9.1 先看清结构：AI 只是侧栏三个页签里的一个

**⚠️ 这一节我先前写错过**：原来写"藏掉 `aside#sidebar` 就全下线"，那是错的。2026-10 我登录你们站点
把 `/notes/` 的 HTML 原文抓下来（`/api/auth/login` JSON 登录 → `GET /notes/` 200）逐行核过，
`#sidebar` 里同时装着三块互不相干的东西：

```
aside#sidebar
├── 页签  .tab[data-tab="ai"]    AI 助手      ← 要下线的是这个
│        .tab[data-tab="info"]  文件数据      ← 编辑器本来的功能，要留
│        .tab[data-tab="notes"] 我的笔记      ← 编辑器本来的功能，要留
├── div.tab-body[data-body="ai"]     #btnOrganize / #btnReview / #aiResult      ← 只在第一块里
├── div.tab-body[data-body="info"]   #statsTable / #outline / #jsonView / #btnCopyJson
└── div.tab-body[data-body="notes"]  #notesList / #btnRefreshNotes / #btnDeleteNote
```

所以**藏整个 `#sidebar` 会顺手删掉「文件数据」和「我的笔记」**——那不是我们的东西，别动。

### 9.2 改法：删两处 + 改一处 class（**推荐**）

在 `/notes/` 的 HTML 里，按真机行号（你们文件对不上就按 `data-tab` / `data-body` 找）：

**① 删掉工具栏那颗 AI 开关**（`btnAi` 只控制 AI 页签，AI 页签没了它就没意义）：

```html
<!-- 删除这一行（真机 L66） -->
<button type="button" class="tool" id="btnAi" title="显示 / 隐藏 AI 助手（打开后在右侧竖排）">🤖 AI 助手</button>
```

**② 删掉 AI 页签按钮，顺手把「文件数据」设成默认页签**（真机 L145-147）：

```html
<div class="tabs" role="tablist">
  <!-- 删掉： <button type="button" class="tab active" data-tab="ai">AI 助手</button> -->
  <button type="button" class="tab active" data-tab="info">文件数据</button>
  <button type="button" class="tab" data-tab="notes">我的笔记</button>
</div>
```

**③ 删掉 AI 页签的内容块，把 `active` 移给「文件数据」**（真机 L151-162，从 `data-body="ai"` 到它的 `</div>`）：

```html
<!-- 整块删掉：
<div class="tab-body active" data-body="ai">
  <div class="row">
    <button type="button" id="btnOrganize" class="btn small primary">AI 整理</button>
    <button type="button" id="btnReview" class="btn small">AI 审阅</button>
  </div>
  <p class="hint">整理与审阅都以当前正文为材料，结果只在**你点应用时**才写回正文。</p>
  <div id="aiResult" class="ai-result">…</div>
</div>
-->

<!-- 原来是 <div class="tab-body" data-body="info">，给它加上 active： -->
<div class="tab-body active" data-body="info">
```

**为什么直接删、不用 `display: none`**：这些 id 在 `studio.js` 里都是
`$('btnOrganize').onclick = …` 这种形式绑的（`$ = (id) => document.getElementById(id)`，`notes_studio.js:14`），
元素不在 DOM 里就**静默跳过**，不会抛错——所以删元素比藏元素更干净，也不用碰 `studio.js` 任何逻辑。
**踩坑：别只删 `#aiResult` 就以为完事**，`#btnOrganize` / `#btnReview` 是它的兄弟节点，三个要一起删。

### 9.3 不想动 HTML 也能做（运行时移除）

如果你们的 `/notes/` 是构建产物、不好改源文件，加一段一次性的启动脚本等效：

```js
// 放在 studio.js 之后（或 DOMContentLoaded 里）
for (const sel of ['#btnAi', '.tab[data-tab="ai"]', '.tab-body[data-body="ai"]']) {
  document.querySelector(sel)?.remove();
}
// 默认页签改到「文件数据」，否则侧栏会停在一个已被删掉、看起来像"坏了"的 AI 页
for (const sel of ['.tab[data-tab="info"]', '.tab-body[data-body="info"]']) {
  document.querySelector(sel)?.classList.add('active');
}
```

### 9.4 服务端可以怎么处理（可选）

`/api/notes/ai/*` 这些路由留着不影响任何东西，想清理就删。**不建议**保留成"备用入口"——
那等于把刚收掉的第二个助手又开了一条小路。

### 9.5 附：真机读到的原侧栏文案（留作对照，确认没有漏掉别的入口）

> AI 助手 / 文件数据 / 我的笔记 · **AI 整理** / **AI 审阅** ·
> 「整理与审阅都以当前正文为材料，结果只在**你点应用时**才写回正文。」·
> 「还没有结果。先写点内容，再点上面的按钮。」· 「就绪 · AI：deepseek-flash」

入口一共两处，都在上面：工具栏 `#btnAi`（真机 L66）与页签 `.tab[data-tab="ai"]`（L145）；
真正的按钮 `#btnOrganize`（L153）、`#btnReview`（L154）、结果区 `#aiResult`（L158）都在
`data-body="ai"` 之内。除此之外页面里**没有**别的 AI 入口（我把 `/notes/` 全文 20 个 `button` 列过一遍）。

---

## 10. 验收（你们也可以照这个自测）

**没账号也能自测**：把我们的交付包拷到任意机器，
`node note-agent/examples/server.mjs`（或 `start-demo.ps1`，默认 `http://127.0.0.1:3480`），
那是一个自带假编辑器的独立页，能验证面板本身；生产接入要多验下面这些。

**浏览器里逐条看（我这边已经用 Playwright 在你们站点上跑过前面几条）**：

1. `/notes/` 打开 → 右侧出现抽屉，胶囊显示「正在跟随编辑区 · N 字」，**不会触发任何模型调用**
   （面板只在编辑区变化后打一次 `/api/note-agent/session` 同步草稿，`generate`/`turn`/`review` 一个都不发）。
2. 在 `#source` 打字 → 胶囊字数跟着变，仍**不触发模型**。
3. 切到 `wysiwyg` 打字 → 胶囊跟着变（验证第 2 节第 1 个坑：读的不是隐藏 textarea）。
4. 打开一篇已有笔记（`openNote`）→ 胶囊字数变（验证第 4 节 ④ 的 `note-studio:doc-changed`）。
5. 点「整理这篇笔记」→ 抽屉里出对话与对比；**编辑区正文一字不变**。
6. 点「应用到编辑区」→ `#source` 变成草稿内容，编辑器自己的预览跟着刷新。
7. 再点一轮 → 回滚到上一轮 → 抽屉预览变了，编辑区**不变**（草稿与正文两条轨道）。
8. 把窗口缩到 390px → 抽屉默认收起、只剩竖标签；点竖标签展开；`Esc` 收起。
9. 全程 `console` 零报错、零 4xx（`/notes-panel.css`、`/notes-panel.js`、`/notes-markdown.js` 都该是 200）。
   ⚠️ `:8080` 上**不要**拿这些绝对路径去比对 —— 你们把面板挂上之后它们才是 200；挂之前是 404，属正常。

---

## 11. 速查

| 东西 | 值 |
| --- | --- |
| 面板脚本 / 样式 / 渲染兜底 | `/notes-panel.js`、`/notes-panel.css`、`/notes-markdown.js`（都由挂载层发，`Cache-Control: no-store`） |
| 服务端挂载 | `mountNoteAgent({ db, resolveUser, basePath: '/api/note-agent' }).attach(server)` |
| 编辑器侧新增 | `#notesPanelMount.notes-mount`、`<script type="module">`（挂 `/notes-panel.js` + `studio-adapter.js`）、`window.NoteStudio` 钩子、`studio-adapter.js`、几处 doc-changed 通知 |
| 编辑器侧**删除** | 工具栏 `#btnAi`、页签 `.tab[data-tab="ai"]`、内容块 `.tab-body[data-body="ai"]`（内含 `#btnOrganize`/`#btnReview`/`#aiResult`），并把 `active` 移给「文件数据」（见第 9 节）——**保留 `aside#sidebar` 本身**，里面还有「文件数据」「我的笔记」 |
| 已核验的编辑器锚点 | `#source` / `#wysiwyg` / `#fileName` / `#btnNew` / `#btnReplaceAll` / `#previewPane` / `aside#sidebar` / `#statusText`；`window` 里只有 `NoteRender`，**没有**编辑器钩子 |
| 契约 | `EDITOR-CONTRACT.md`（`getDoc` / `setDoc` / `onChange`，契约版本 `1`） |
| 接口参考 | `API-REFERENCE.md`（13 个端点、错误码表） |
| 嵌入已有站点 | `INTEGRATION.md` |
| 交付包总览 / 常见问题 | `HANDOFF.md` |
| 面板能做什么 | `README.md` |

**我们这边可以立刻做的**：给你们 `studio.js` + `studio-adapter.js` 的完整补丁（按上面 ③④⑤ 拼好，直接可贴），
以及一个能在 `:3480` 演示页上跑通的 Playwright 自测脚本。需要的话说一声。

**本文的核实程度**（免得你们重复劳动）：

- 已真机核验：`/#/notes` 与 `/notes/` 的路由与标题、`window` 全局（只有 `NoteRender`）、第 4 节那张表的全部 id、
  `#btnApplyMarkdown` 是动态生成（`notes_studio.js:558`/`:567`）、`$ = (id) => document.getElementById(id)`（`:14`）、
  `.workspace` 的三列网格与 `no-preview`/`no-sidebar` 减列规则（`notes_studio.css:114-126`）、
  三页的 `<meta name="viewport">`、`/api/notes/status` 的真实响应、自带侧栏的文案与"点应用才写回"的说法、
  状态栏口径（`297 字 · 1 标题 · 2 公式`）。
- **已抓 `/notes/` 原文逐行核过**（不只是浏览器里看）：`#sidebar` 的三个页签与三块
  `data-body="ai"/"info"/"notes"` 的从属关系、AI 入口只有两处（工具栏 `#btnAi` 与页签 `data-tab="ai"`）、
  页面全部 20 个带 id 的 `button` 的清单 —— 第 9 节的删除清单就是照这个写的（真机行号 L66 / L145 / L151-162）。
- 按源码读出、未在你们站点上逐条跑：第 4 节 ④ 里"哪几处会改 `state.markdown`"（判据已写在那一节）、
  第 2 节两个坑的行号、`scheduleUpdate()` 的 200ms 去抖。
- 我们**没有**验证：把面板真接到 `/notes/` 之后的端到端效果（那要改你们的代码）。第 10 节就是为此写的清单。

---

## 12. 给同事的一句话摘要（可以直接转）

> 原来的 **AI 助手页签请下线**（工具栏 `#btnAi` + 页签 `.tab[data-tab="ai"]` + 内容块
> `.tab-body[data-body="ai"]`，里面是 `#btnOrganize`/`#btnReview`/`#aiResult`），
> 把默认页签改成「文件数据」。**不要藏整个 `aside#sidebar`** —— 它里面还有「文件数据」和「我的笔记」。
> 我们那边也不再从 `#btnApplyMarkdown` 取通知了。AI 只用我们的右侧抽屉一套。
> 服务端 `/api/notes/ai/*` 留不留都行，不影响。
