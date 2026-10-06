# 可编程帖子（积木）· 第二轮翻新 — 设计规格（Spec）

- 状态：**待评审**
- 关联需求：用户本轮口述的四条（§0.1）、《团队协作规范.md》、[P2-积木帖子.md](<D:\Project1\Blog\docs\开工说明\P2-积木帖子.md>)
- 前置 spec：[2026-10-05-programmable-posts-design.md](<D:\Project1\Blog\docs\superpowers\specs\2026-10-05-programmable-posts-design.md>)（第一轮，已交付并上线）
- 权威基线：`D:\Project1\Blog`，分支 `v2-skeleton` @ `4199280`（= `origin/v2-skeleton`，工作树干净）
- 本轮开发分支：**`feat/doc`**（P2。基线与上游同为 `4199280`，远端此时还没有 `feat/doc`）
- 目标：把积木从「一个只会改 JSON 的表单集合」变成**能直接写代码、能撑起 Wiki、能写小程序**的内容底座。

---

## 0. 意图与成功标准

### 0.1 意图（用户原话，本轮起点）

> https://github.com/RyuriHime/Blog，blog_main 是我 copy 下来的工作文件夹。接下来拟合我要开始将可编程帖子（积木）功能全面翻新。1. 极大的加大编程的自由度，底层逻辑不再是目前的只能改变 json 的逻辑，而是能够直接往帖子上写代码的逻辑。2. UI 改善/加强。目前的编辑方式过于冗长复。3. WIKI 模板需要实现像 oi-wiki 或者 ctf-wiki 的样式，同时 wiki 应当是一个帖子一个 wiki，而不是一个 wiki 内多个帖子， 帖子只是里面的一个积木块。同时积木的编辑应当非常简单，最好直接对每个积木块沿用目前的 markdown 编辑器，或者直接编辑源码。 4. 你要保证能让积木帖子实现很多复杂的东西，甚至是小程序。

补充指示：目录用 `<https://github.com/RyuriHime/Blog>`（工作目标为 `D:\Project1\Blog`）；「按照团队协作规范.md 干活，能复用目前论坛上的代码就用，能用 github 上有的源码就用」。

第二轮实测后用户又亲口列了五条毛病（这些是本次翻新的直接动因）：

1. 「投票页不能点投票」
2. 「自定义编程页的警告渲染失效」
3. 「wiki 页并不是正常 wiki 的样子，没有边栏提供分类，只是单纯带链接的页而已」
4. 「编程自由度不够」→「你的编程的主语言 json 本质只是数据整理用的语言，而不是真正能写功能的语言」
5. 「新建积木帖子不仅 UI 不好看而且很混乱，难以看懂操作」

### 0.2 本轮九道选择题的答案（已逐题确认）

| # | 问题 | 用户的选择 | 对本设计的意义 |
|---|---|---|---|
| Q1 | 编程模型 | **A + B**：「帖子级脚本 + 块当数据」**且**「一篇帖子 = 一个完整前端应用」 | 帖子级脚本能增删改查本帖的块；整页可以是一个 iframe 应用。**未选**服务端执行用户代码 |
| Q2 | Wiki 模型 | **γ**：站是一篇帖子（目录/索引），站里的页仍是独立文档但**不生成影子帖**，并在站文档里以积木块形式挂上去 | 一个帖子一个 wiki；页用 `doc_settings.station_id` 归站 |
| Q3 | 「小程序」能力 | 八选六：② 全站共享持久数据 ③ 脚本读写本帖块 ④ 读站内其它内容 ⑤ 多页面/全屏/自己的前进后退 ⑥ 跨帖复用代码（① 网络/外部库见 Q7 被砍；服务端定时、文件上传/摄像头/录音未选） | 6 个新能力面 |
| Q4 | 编辑面 | **(i) 单一源码视图**，自定义补充：「同时支持用模板」 | 一篇帖子就是一段文本；旧块表单降级为折叠辅助面板 |
| Q5 | 破契约的边界 | **(1) 只重写积木自己那一摊** | 可改 `src/modules/doc/**`、`public/views/doc*.js`、`public/css/41-doc.css`、`scripts/*doc*`、doc 自己的表与断言；**`src/core/*`、`src/modules/core/*` 一个字不动**，需要时回来问 |
| Q6 | 脚本写块的语义 | **C + 开关**：写进独立的**派生层**，不进 `document_blocks`、不产生修订、不算作者编辑；作者可「采纳为真块」；**每篇一个开关，默认「脚本只能读」** | 派生存 `doc_script_blocks` |
| Q7 | 网络与外部库 | 自定义回答：**「放弃了。不给网」** | 沙箱 CSP 保持 `default-src 'none'`；无代理、无 CDN 白名单、无运行期外部库 |
| Q8 | 跨帖复用代码 | **A**：自定义块类型升级成「**能带代码的组件**」 | 复用现有 `doc_block_types` + `#/blocks`，**零 DDL** |
| Q9 | 单一源码视图的实现路径 | **丙**：块为真相 + 源码带稳定 id | 解析结果仍是 `document_blocks`；源码可以带 `{#id}` |

设计逐节确认记录：第 1 节数据模型 ✓、第 2 节源码格式与往返 ✓、第 3 节脚本运行时与能力 ✓、第 4 节编辑器 UI ✓（结构化块围栏**不发明新方言**，继续用 JSON）、第 5 节 Wiki ✓、第 6 节测试/验收/风险/步骤 ✓。

### 0.3 成功标准

1. **能直接往帖子上写代码**：帖子级 `script` 块拿到全文块列表，能产出派生块，能跑出一个真程序（实时计票 / 排行榜 / 多人房间）。
2. **编辑不再冗长复杂**：`#/doc/:id/edit` 一屏完成 —— CodeMirror 源码视图 + 实时预览 + 模板下拉；新建从 5 步压到 1 屏。
3. **Wiki 真的像 wiki**：一篇帖子 = 一个站；左树 / 正文 / 右 ToC 三栏；红链能建页；站内搜索；子页不出现在积木广场。
4. **能写小程序**：`app_mode='fullpage'` 的整屏应用，有自己的路由、前进后退、站内共享状态。
5. **一行老内容都不丢**：升级后 11 篇文档 / 32 篇帖子、7 个 app 块、全部投票票数、`callout` 自定义类型、双链原样还在。
6. **论坛本体零改动**：`check-golden` 的 96 项行为指纹全程保持绿，一次都不 `--write`。

### 0.4 明确不做（YAGNI）

- 不做服务端执行用户代码（`renderer_kind` 仍是 `'declarative' | 'sandbox'` 两种）。
- 不做网络：不建服务端代理、不开 CDN 白名单、运行期零外联。
- 不做沙箱后台定时任务、不做文件上传 / 摄像头 / 录音。
- 不做实时协作通道（WebSocket / presence / 多光标）—— 那是 P4 的事。
- 不做块级权限（可见范围仍是文档级的）。
- 不碰 `src/core/*`、`src/modules/core/*`、`src/server.js`、`src/notes.js`。
- 不改 `note-agent/EDITOR-CONTRACT.md`，不做编辑器的双向实时同步（保存是显式的）。
- 不做自动保存。

---

## 1. 现状：今天有什么，以及毛病具体在哪

### 1.1 已经跑起来的部分（本轮全部复用，不重写）

- **块引擎**：`src/modules/doc/blocks/{types,registry,validate,ops,markdown,html,bind,text,plain,agent}.js`。12 种内置块（`types.js:41-324`）：`heading` `paragraph` `list` `code` `table` `formula` `image` `quote` `poll` `wiki` `embed` `app`；前 7 种是与 `note-agent/src/blocks.mjs` 的**冻结契约**。
- **渲染唯一出口**：`store.js:242-262 present(row, viewer)` → `renderBlocks(materialized, {sandboxDisabled, documentId})`（`blocks/html.js:31-62`）→ `{doc, blocks, html, warnings, abilities}`。前端 `public/views/doc.js:463` 直接 `innerHTML`，**前端绝不重实现块渲染**。
- **降级不崩**：未注册类型 / 坏 JSON / schema 违规 / 更新的类型版本 → `placeholder`（`html.js:14-22`）+ `warnings[]`（`unknown_type` / `bad_props` / `future_version`）。
- **块间联动**：`blocks/bind.js:37 resolveBinds` + `chainFor(:9)`，环检测报 `bind_cycle`，字段缺失报 `bind_field`，`RESERVED_KEYS = ['bind']`（`validate.js:132`）。
- **沙箱**：`src/modules/doc/sandbox.js`（服务端只拼文档，**从不执行**）+ `public/core/sandbox.js`（宿主侧按 `event.source` 认领、看门狗 `SANDBOX_READY_MS=2000`、限流 `SANDBOX_MESSAGES_PER_SECOND=200`、`unmountSandboxes()`）。能力 `SANDBOX_CAPABILITIES = ['doc-meta','doc-blocks','viewer','state']`，消息 `['ready','resize','value','request']`，审计表 `doc_capability_logs`，出口 `POST /api/docs/:id/capabilities`（`store.js:955-986`）。
- **模板**：`templates.js` 7 键（`blank` `page` `academic` `wiki` `poll` `datatable` `lab`），`WIKI_TEMPLATE = 'page'`。
- **Wiki 雏形**：`wiki` 块（`[[a|b]]` 双链）+ `template='page'` 的文档 + `doc_wiki_pages(category, sort_order)` + `store.wikiNav`（`store.js:510-530`）+ `public/views/doc.js:259-325` 的侧栏。
- **每块表单**：`public/views/doc-blocks.js`（304 行，纯按 props schema 生成，**不认识任何块名**）+ `schemaHtml` 驱动 `#/blocks`。

### 1.2 毛病在哪（六个，都对着用户的抱怨）

| # | 抱怨 | 准确位置 |
|---|---|---|
| 1 | 「只能改 JSON」 | `registry.js:45-51 renderTemplate` 只支持 `{{标识符}}`，不许表达式/循环/条件；spec 第一轮 §2.4 承诺过「受限的表达式」，**从未落地**。声明式就是终点 |
| 2 | 「编辑方式过于冗长复杂」 | 加一块并保存要 **N+3 次点击**（`poll` 6 次、`app` 6 次）；「保存本块」在同一张卡片出现两次（`doc.js:561` + `:567`）；每张卡片恒有两个折叠面板（源码 JSON + 块间联动） |
| 3 | 「wiki 没有边栏提供分类」 | `doc_wiki_pages` **没有 parent_id、没有 ToC、没有 prev/next**；`wikiNav` 是个平铺列表 |
| 4 | 「wiki 不是一个帖子一个 wiki」 | 每个 `page` 文档都生成一条影子帖，于是「一个 wiki = 一篇帖子 + N 篇帖子」 |
| 5 | 「投票页不能点投票」 | 已在第二轮修（`doc_poll_votes` + `GET /polls` + `POST /vote`），本轮**不能弄坏** |
| 6 | 一个没人发现的**数据丢失 bug** | `store.putMarkdown:789` → `writeBlocks:157-177` **先 `deleteBlocksOf` 再全插**，而 id 由 `parseBlocks` 按位置发（`markdown.js:207`）。在文首插一段 → 整篇 `block_id` 后移 → `doc_poll_votes` 的票、`doc_app_state` 的状态被 `reconcile*` 当孤儿清掉、`bind` 指到隔壁块 |

---

## 2. 数据模型

### 2.1 三张新表（全部走 `CREATE TABLE IF NOT EXISTS`，老库开库时纯加法补建）

```sql
CREATE TABLE IF NOT EXISTS doc_settings (
  document_id INTEGER PRIMARY KEY REFERENCES documents(id),
  allow_script_write INTEGER NOT NULL DEFAULT 0,
  app_mode TEXT NOT NULL DEFAULT 'inline' CHECK (app_mode IN ('inline','fullpage')),
  station_id INTEGER NOT NULL DEFAULT 0,
  parent_id INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  icon TEXT NOT NULL DEFAULT '',
  source_text TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS doc_script_blocks (
  document_id INTEGER NOT NULL REFERENCES documents(id),
  scope TEXT NOT NULL DEFAULT 'user' CHECK (scope IN ('user','shared')),
  user_id INTEGER NOT NULL DEFAULT 0,
  block_id TEXT NOT NULL,
  type TEXT NOT NULL,
  props_json TEXT NOT NULL DEFAULT '{}',
  position REAL NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (document_id, scope, user_id, block_id)
);
CREATE TABLE IF NOT EXISTS doc_site_state (
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  user_id INTEGER NOT NULL DEFAULT 0,
  value TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (namespace, key, user_id)
);
```

**为什么另开表而不是给现有表加列**：`documents` / `doc_app_state` 都是既存表，而 `src/core/open-db-support.js:250-268` 的 `ensureColumn` **只覆盖 `users` 与 `posts`** —— doc 的表在老库上加不上列（`src/modules/doc/schema.js:206` 的注释写明了这一点）。新表由 `DOC_SCHEMA` 的 `CREATE TABLE IF NOT EXISTS` 每次开库自动补建。真要给 doc 表加列，就在 `src/modules/doc/index.js` 的 `install(ctx)` 里写守卫式 ALTER（那里拿得到 `ctx.db`）。

**两个已踩过的坑，必须遵守**：`DOC_SCHEMA` 是模板字符串，**内部不许出现反引号**（第一轮因此 `SyntaxError`、服务死 20 秒，踩了两次）；`addScript` 按 `;` 切语句，**除语句结尾外不许有分号**。

### 2.2 派生层（Q6）

- 渲染时 `present()` 把 `scope='shared'` 的行 + 当前访问者 `scope='user'` 的行，按 `position` 排在真块**之后**，标记 `derived: true`；真块序列一个字节都不动。
- **脚本永远写不进 `document_blocks`。** `allow_script_write`（默认 0）只控制「能不能往派生层写」。默认状态下脚本就是只读的。
- 能力 `blocks.derived` 经 `POST /api/docs/:id/capabilities` 走服务端裁决；**放行与拒绝都写 `doc_capability_logs`**（复用 `store.js:955-986`）。
- 配额：每篇每 scope 派生块 ≤ 100、单块 props ≤ 8KB、整篇派生 ≤ 64KB。超限 → 一条警告，**不是 500**。
- 「采纳为真块」= 一次普通文档写：派生行拷进 `document_blocks`（发新 id、`position` 接到末尾）、写一条 `reason='adopt'` 修订、删掉那些派生行。

### 2.3 影子行规则变更（Q2 + Q5 授权）

只有「`template='page'` **且** `station_id != 0`」的文档不再生成/同步锚点帖。`kind='profile'`、普通 `post`、`note`、以及 `template='page'` 但还没归站的孤儿页**全部照旧**。

于是：站本身（`template='station'`、`kind='post'`）照旧是一篇正常帖子、照旧出现在板块里 —— 这就是「一个帖子一个 wiki」；而它的子页不在广场里出现，只通过站的树到达。

### 2.4 零 DDL 的「能带代码的自定义块类型」（Q8 A）

`doc_block_types.renderer_kind` 的 CHECK 只允许 `'declarative' | 'sandbox'`，但：

- `blocks/registry.js:58-75 genericHtml` 已经把 `renderer_kind === 'sandbox'` 路由到 `sandboxInner`；
- `sandbox.js:185-188 isSandboxType` 已把 `renderer_kind === 'sandbox'` 与内置 `app` 一并当沙箱块。

所以「带代码的组件」**零 DDL**：`renderer_kind = 'sandbox'`、代码放 `renderer_json.code`、字段声明继续用 `props_schema_json`。**唯一要改的**是渲染管线：在进 `sandboxInner` 之前把类型里的 `code` 合进 props —— 因为 `sandboxInner`（`sandbox.js:152-176`）只看 `props.code`（`const code = typeof props?.code === 'string' ? props.code : '';`，在 `:153`）。

### 2.5 老内容接法

| 存量 | 处理 |
|---|---|
| 3 篇 `template='page'`（`station_id=0`） | 保持是 wiki 页；首次 `GET /api/docs/wiki` 时收进自动创建的站，并**撤销影子帖**（带护栏，见 §6.7） |
| 1 篇 `template='wiki'`（词条） | **保持原样**，继续是一篇普通帖子 |
| `doc_wiki_pages` 2 行 | `category` → 树上的目录页，`sort_order` 照搬；旧表保留可读，作为迁移输入 |
| 7 个 `app` 块 | 一字不改，继续按 `props.code` 跑 |
| 1 个自定义类型 `callout`（declarative） | 继续走模板渲染，`renderer_kind` 不动 |
| 32 篇帖子 + 其余影子行 | 不变 |

---

## 3. 源码格式与往返

### 3.1 语法：只加三样

今天 `doc:` 围栏**已经是**源码格式：`structuredMarkdown(kind, props)`（`types.js:35-39`）输出 `fenceFor(json) + 'doc:' + kind + '\n' + JSON.stringify(props, null, 2) + '\n' + fence`；`parseBlocks`（`markdown.js:78-102`）对 `info.startsWith('doc:')` 取 `info.slice(4)` 当类型、`JSON.parse(body)` 当 props，坏了退回 `code` 块（`:95`）。本轮**不发明新方言**，只给已有语法补上块身份：

1. ```` ```doc:<类型> {#b3} ```` —— 结构化块的信息串后面可以跟 id。解析时把 `doc:poll {#b3}` 拆成 `kind='poll'` + `id='b3'`；**id 必须在 `coerceProps` 之前摘掉**，否则会被当未声明字段丢掉（`validate.js:180` 的警告）。
2. `<!-- b3 -->` 独立一行 —— 天然 markdown 块（标题/段落/列表/表格/引用/图片/双链）要固定 id 时，写在块的**上一行**。序列化时**只在 id 真的会被引用时才输出**，判据是「(a) 它自己有 `bind`；(b) 别的真块或派生块的 `bind` 指向它；(c) 类型属于 `poll` / `app` / `script`（有服务端副数据）」—— 三条都不满足就一个标记都不写，正常写作时源码保持干净。
3. ```` ```doc:script ```` —— 帖子级脚本。**块体是原始 JS 源码，不是 JSON**。这是 `doc:` 命名空间里唯一的例外，为的是脚本以代码形态出现在源码里，而不是被 JSON 转义成一坨 `\n`。`script.toMarkdown` 继续用 `fenceFor(code)` 挑安全围栏长度（脚本里常有反引号）。

### 3.2 两个序列化入口 + 一个解析器

- `toNoteAgent(blocks)` = 今天的 `blocksToMarkdown`（`markdown.js:32-38`），**一个 id 都不输出**。`doc-smoke` 2.3 与 note-agent 的逐字节对拍（`scripts/doc-smoke.mjs:306`）继续钉在它身上，冻结契约一个字不改。
- `toSource(blocks)` = **带 id 的版本，由服务端生成**：作者打开编辑器时作为初始源码（`GET /api/docs/:id` 的 `source` 字段），以及 `doc_settings.source_text` 为空时的现场补写（§3.4）。**前端不自己拼源码。**
- `parseBlocks(text)` 两种都吃：有 id 用 id，没有就按位置发 `b{n}`（`markdown.js:207` 现状）。
- 往返不变式改成「`toSource` → 解析 → 再 `toSource` 逐字节相同」，100 篇随机文档那条属性测试（`doc-smoke.mjs:381`）照旧守着，只换入口。

### 3.3 保存改为按 id 对齐 upsert（顺手修掉 §1.2 第 6 条那个丢数据 bug）

`writeBlocks`（`store.js:157-177`）从「先全删再全插」改成：

1. 解析出新序列；
2. 没有 id 的块，用「旧序列 ↔ 新序列」LCS 对齐（键 = `type` + 规范化 props 的稳定哈希），旧 id 尽量留给没动过的块；真正新增的块从 `max(旧号)+1` 起发号；
3. 按 id **upsert** 变了的行、**删除**新序列里没有的 id；
4. `doc_poll_votes`、`doc_app_state`、`bind` 引用的 `b3`、`UNIQUE(document_id, block_id)` 于是天然存活；`reconcilePollVotes`（`store.js:174` / `:617`）与 `reconcileAppState`（`:176` / `:1056`）只清真正被删的块。

`writeBlocks` 的其他调用方一并受益：`store.js:379`（套模板）、`:413`、`:442`、`:771`、`:798`、`:823`、`:888`（导入）。

### 3.4 `source_text`：编辑器永远不会吃掉你敲的 markdown

解析器是有损的（表格分隔行会被剥 `markdown.js:157`；嵌套列表被吞成一个 `list` 块 `:183-189`；看不懂的一律退回段落 `:192`）。所以：

- `doc_settings.source_text` **逐字节**存作者最后一次输入的原文。编辑器的往返基准是它，不是「解析再拼回来」。
- `document_blocks` 仍然是渲染 / 投票 / 绑定 / 沙箱状态 / 修订的**唯一依据**；**只读路径完全不走 `source_text`**，读者侧行为与今天一字不差。
- 保存流程：解析源码 → 对齐 id → 写块 → 写回 `source_text` → 快照修订。
- 老文档 `source_text` 为空时，首次打开用 `toSource(blocks)` 现场生成一份，之后归作者所有。

### 3.5 三道防手滑

1. 解析出 **0 块**而源码非空 → 400，**不写库**，报「源码没能解析出任何块」。
2. 块数**暴跌**（新块数 < 旧块数的一半且旧块数 ≥ 4）→ 409 `conflict`，前端弹「块数从 12 掉到 3，确定这样存？」→ 用户确认后带 `?confirm=1` 再发一次。这就是「不拒绝，但要再点一次确认」的落地形式。
3. props 超预算 / 块数超 `MAX_DOC_BLOCKS=500` → 沿用今天那条 400（`assertBudget` `store.js:152-154`），**不做部分保存**。

---

## 4. 脚本运行时与能力

### 4.1 脚本是一块真块（第 13 种内置类型 `script`）

**本 spec 更正第 3 节口头稿的一处**：脚本**不进** `doc_settings.script_code`，而是作为一块真块存在。理由：块自动获得修订 / 回滚 / 导出 / 导入 / markdown 往返；放 settings 里等于脚本永远回不了滚。第 2 节定的 ```` ```doc:script ```` 原始代码围栏就是这块块的正文。因此 `doc_settings` 里**没有** `script_code` 列。

- props：`{ code: { type:'string', default:'', maxLength: MAX_SCRIPT_CODE = 20000 }, config: { type:'object', default:{} } }`。
- **每篇文档最多一块**。这条校验放不进 `coerceProps`（它只看单个块的 props，看不到文档），所以放在 store 的写入路径上、和 `assertBudget` 同一层；超标回 `badRequest('一篇帖子只能有一个脚本块')`。
- `sandbox.js:185-188 isSandboxType` 要加上内置 `script`；它照旧经 `sandboxInner` 渲染（`props.code` 现成可用）。
- 阅读视图里 inline 模式渲染成一枚「脚本」小标（可展开看代码）；`app_mode='fullpage'` 时由宿主挂一块铺满视口的 iframe。

### 4.2 两块各自跑在哪：共用现有沙箱，只是给的 API 不同

| | 老 `app` 块（inline 积木） | 新 `script` 块（帖子级） |
|---|---|---|
| 运行位置 | 自己的 iframe | 自己的 iframe（fullpage 时铺满整屏） |
| 拿到什么 | 只有自己的 `props` | 全文块列表 + 站点只读数据 + 路由 + 状态 |
| 能写什么 | 什么都不写 | 派生层（受开关限制），**永远写不进 `document_blocks`** |
| 每篇几块 | 任意 | 最多一块 |

两者共用 `src/modules/doc/sandbox.js` + `public/core/sandbox.js` 的同一套看门狗、限流、`event.source` 认领逻辑。**不改沙箱内核，只加能力。** 宿主通过 iframe 上的 `data-app-api="script"` 区分要挂哪套 bootstrap。

### 4.3 能力清单（全部服务端裁决 + 全量审计）

复用今天已有的四个：`doc-meta` / `doc-blocks` / `viewer` / `state`。新增两个、扩一个：

- **`doc-blocks`（已有）** → 脚本读全文：返回按位置排好的 `[{ blockId, type, props, derived: false }]`。这是「脚本读写本帖的块」里**读**的那一半，今天已经存在，直接复用。
- **`blocks.derived`（新）** → 派生层增删改查。载荷：`{ op:'list' }` / `{ op:'upsert', blockId, type, props }` / `{ op:'remove', blockId }` / `{ op:'clear' }`。`list` 永远允许（它只回访客本来就看得见的东西）；其余三个**只在 `allow_script_write=1` 时放行**，否则 403 并记一条 `allowed=0` 的审计行。
- **`state`（扩）** → 现在吃 `scope ∈ user|shared`；加第三个 `scope='site'`（全站共享：排行榜、多人房间、长期累积票数）。`site` 落在 `doc_site_state`，`namespace` 的规则是：**自定义沙箱块类型用类型名**（于是同一个组件在所有引用它的帖子之间共享一份全局数据），**内置 `script` 块用 `doc:<documentId>`**。配额：单值 ≤ 4KB、每 namespace ≤ 1000 键、按用户限流。
- **`site.read`（新）** → 读站内其它内容的只读出口。载荷：`{ op:'boards' }` / `{ op:'posts', board?, limit?, offset? }` / `{ op:'post', id }` / `{ op:'users', limit? }` / `{ op:'docs', kind?, limit? }`。**硬规则：只回 `scope='public'` 且未删除的行**，分页 ≤ 50，绝不含邮箱等私密字段。这是本轮唯一新增的信息暴露面，规则要写死。

**服务端能力限流（新增）**：每个 (访客, 文档) 每分钟最多 60 次能力调用，超了回 `rate_limited` 并记审计。沙箱那侧的 200 条/秒只是消息频率，管不到服务端压力。

### 4.4 派生块是「数据」，不是「HTML」

脚本产出的派生块，其 `type` **必须是已注册的块类型**，props 照样走 `coerceProps` 校验，渲染照样走同一个 `renderBlocks`。脚本**不能凭空塞 HTML 进别人的页面** —— 它想画任意界面，只能画在**自己那个不透明源的 iframe 里**（碰不到论坛 DOM、Cookie、localStorage）。于是「能写小程序」和「不会变成 XSS 跳板」同时成立。

派生块在阅读页显示在真块**之后**，带 `derived: true` 和一枚「脚本产出」小标；`bind` 可以引用它们的字段。

### 4.5 路由、多页面、全屏（纯前端，不走服务端能力）

宿主给 iframe 一对消息：`route.get()` / `route.push(path)`，映射到 `#/doc/:id/app/<path>`；页面 `hashchange` 反向推给 iframe。iframe 内部自己切页 = 多页面应用；`app_mode='fullpage'` = 整屏。这样「自己的前进后退」天然接上浏览器历史，不用造新机制。

### 4.6 跨帖复用代码只留一条路（Q8 A）

**带代码的自定义块类型**（§2.4）。作者在 `#/blocks` 定义一次，别的帖子插入时只填 props。不另开「代码库」表、不加 `import` 机制。

### 4.7 清理与配额

- 「采纳为真块」时顺带清孤儿派生行；staff 可按 namespace 一键清空全站状态。
- 派生层配额见 §2.2。脚本块被删 / 停用时，它的派生行与 `site` 状态可被回收。

---

## 5. 编辑器 UI

### 5.1 新长相

`#/doc/:id/edit` **默认就是源码视图**，不再有「积木 / Markdown」两个 tab。

- 顶栏：标题、可见范围、**套用模板**、保存、AI 抽屉、帮助；
- 左栏（主）：源码，CodeMirror；
- 右栏：**实时预览**（渲染出来的帖子本身）。点预览里任意块 → 左栏滚到对应围栏并选中；
- 底栏：**折叠的「逐块表单」**辅助面板（§5.6）。
- 窄屏：两栏变上下，预览可折叠。

旧地址 `#/doc/:id/blocks` **保留不 404**（团队规范第 8 节：旧地址必须还能打开）——它重定向到源码视图并自动展开某一块的表单。

### 5.2 编辑器本体：vendored CodeMirror 5.65.16

- **24 个文件、约 109KB**，放 `public/vendor/codemirror/`（和 `note-studio/public/vendor/` 里的 KaTeX 一个待遇）：`lib/codemirror.min.js`(58942B) + `lib/codemirror.min.css`(1776B)、`mode/{markdown 5714B, javascript 6374B, xml 2680B, yaml 1093B, css 8835B}`、`addon/{edit/closebrackets 1774B, edit/matchbrackets 1639B, selection/active-line 836B, search/search 2464B, search/searchcursor 2232B, dialog/dialog 1175B+383B, hint/show-hint 4201B+455B, comment/comment 1889B, fold/foldcode 1346B, fold/foldgutter 1379B+381B, fold/markdown-fold 656B, display/placeholder 937B, scroll/simplescrollbars 1418B+504B}`。全部是经典 `<script>`/`<link>`，**零构建**。已逐个探过 CDN，25/25 全部 200。
- **懒加载**：首次进编辑页才注入 `<script>`/`<link>`，顺序 `codemirror.min.js` → 模式 → 插件。所以 **`public/index.html` 一个字都不用改**，也不用给每个访客付这 59KB。
- 围栏内高亮：CodeMirror 5 的 markdown 模式有 innerMode 机制，```` ```js ```` 直接可用；```` ```doc:script ```` 注册一个 MIME 别名指到 javascript。
- 主题：跟 `document.documentElement.dataset.theme` 走。不引第三方主题，直接用 `public/css/00-themes.css` 里现成的 7 套变量（`--bg` / `--bg-soft` / `--border` / `--text` / `--muted` / `--accent` / `--mono`）写一套皮肤，切主题时 `cm.refresh()`。
- 功能：行号、当前行、括号匹配 + 自动闭合、Ctrl-F 搜索、Ctrl-/ 注释、围栏折叠、Tab 缩进（不跳焦点）、Ctrl-S 保存。

### 5.3 关键韧性设计：编辑器必须能降级

`scripts/check-frontend.mjs` 在**假 DOM** 里渲染页面。要是 `viewDocEdit` 硬依赖 CodeMirror，那个测试立刻炸。所以 **CodeMirror 挂载是尽力而为的**：懒加载失败、或环境没有真实 DOM 时，自动退化成普通 `<textarea>`。三个好处：`check-frontend` 现有的 doc fixture 几乎不用动；真实浏览器里是完整编辑器；加载失败也不至于没法写帖子。

### 5.4 保存

`Ctrl-S` / 保存按钮 → `PUT /api/docs/:id/markdown`，body 是源码原文。服务端按 §3.3–§3.5 处理。

- 0 块 → 400，不写库；块数暴跌 → 409，确认后带 `?confirm=1` 重发；超预算 → 400。
- **不做自动保存**（避免半截源码把投票 / 脚本块覆盖掉），只在切页时提示未保存。
- 保存成功后右栏整体重渲染（响应里本来就有 `html`），不做局部 DOM 补丁；尽量保住光标位置。
- 响应同时回 `source`（= 服务端最终存下的 `source_text`）与 `blocks`；编辑器拿它**重置「未保存」基线与脏标记** —— 这样 LCS 对齐 / 发号的结果和前端所见永远一致。

### 5.5 AI 抽屉：给它写一个新适配器，契约一个字不改

现在 `createTextareaAdapter` 读 `#title` + `#content`；新编辑器不是 textarea，所以按 `note-agent/EDITOR-CONTRACT.md` 写 `createCodeMirrorAdapter`：

- `getDoc()` → `{ title, markdown: cm.getValue() }`（公式 `$…$`、图片 `![]()` 本来就是源文本，契约里「公式和图片必须以源文本进出」天然满足）；
- `setDoc({ title?, markdown?, mode })` 支持 `replace` / `append`，写完 `cm.setValue` 并派发 change；
- `onChange` 走 `cm.on('change')`，返回可用的退订函数；
- `insertText` / `scrollTo` / `getImages` 一并实现。

**`note-agent/` 与契约文件零改动。**

### 5.6 旧块表单降级，但不删

`public/views/doc-blocks.js`（304 行，`schemaHtml` 还在驱动 `#/blocks`）原样保留，位置从「主界面」变成「折叠的辅助面板」：点预览里的块 → 面板展开该块的 schema 表单 → 改完写回源码里那段围栏。理由是投票选项、表格行这类结构化数据用表单确实比手写快，而且这套代码已经写好并测过了 —— **复用胜过重写**。

### 5.7 模板

- `#/docs` 的新建向导与模板保留（Q4：「同时支持用模板」）；
- 编辑器里加「套用模板」：把模板的块**追加**到源码末尾（不覆盖已有内容），因为作者可能已经写了一半；追加前先按 id / 内容哈希去重，且**模板带 `script` 块而目标已经有一个时跳过它并提示**（§4.1 的「一篇一个」不能被套模板绕过）；
- `#/blocks` 要显示新增的块类型。

### 5.8 文件清单（全在 P2 名下）

- **新增**：`public/views/doc-editor.js`、`public/vendor/codemirror/**`、`public/views/doc-preview.js`（可选）。
- **改动**：`public/views/doc.js`、`public/css/41-doc.css`（追加）、`scripts/check-encoding.mjs`、`scripts/check-frontend.mjs`、`scripts/check-ui-contract.mjs`。
- **不碰**：`public/index.html`、`public/app.js`（`import './views/doc.js'` 已在）、`public/core/*`、`src/core/*`、`src/modules/core/*`。
- `public/views/doc.js` 顶部静态 `import './doc-editor.js'`（所以 `app.js` 那行不用动）。**`doc-editor.js` 自己必须在假 DOM 下不炸**：只用 `document.createElement` 一类基础 API、不假设有真实布局；CodeMirror 只能经 §5.3 的懒加载 + 回退路径进入。

---

## 6. Wiki（γ 模型 + oi-wiki / ctf-wiki 的样子）

### 6.1 结构

- **站** = 普通文档：`kind='post'`、`template='station'`（第 8 个模板）。照旧有影子帖、照旧出现在板块里 —— **这就是「一个帖子一个 wiki」**。
- **页** = 独立文档：`template='page'`，在 `doc_settings` 记 `station_id` / `parent_id` / `sort_order` / `icon`。`station_id != 0` 的页**不再生成影子帖**（§2.3）。
- **挂载**：站在它的源码里为每一页写一块新积木 **`subpage`**（第 14 种内置类型，label「子页」，props `{ doc, mode: 'card'|'full', title? }`）。站的落地页 = 目录 + 每页一张卡；而**树本身**读 `doc_settings`。在站里点「新建页面」时服务端**自动**把对应 `subpage` 块追加到站源码末尾。
- **分类就是层级**：不保留「分类」这第二套维度。一页有子页就是目录页（oi-wiki 的「图论」索引页就是这个形状）。

### 6.2 三栏布局

- **左栏**：站名 + 站内搜索框 + 可折叠的页面树（当前页高亮，带 `icon`）；作者能看到「＋新建页面」。
- **中栏**：正文。标题带 `§` 锚点链接、代码块带语言标签和复制按钮、表格斑马纹、提示框**直接复用已有的自定义类型 `callout`**。
- **右栏**：**ToC**，从本页标题生成，滚动高亮。窄屏时右栏收进正文顶部折叠，左栏变抽屉。
- **底部**：上一页 / 下一页（树的中序遍历），边界处不显示。

### 6.3 锚点与 ToC 怎么来的（服务端算，不靠 JS）

- `heading.toHtml`（`types.js:54-57`）从只出 `<h1>…</h1>` 改成带 `id="h-<blockId>"` —— 用稳定块 id 而不是 slug，天然唯一、不会撞。
- `present()` 顺手返回 `toc: [{ blockId, level, text }]`，前端据此渲染右栏和 `§`。锚点跳转走查询参数：`#/wiki/<站>/<页>?h=h-b12`，现有路由本来就解析 `query`。
- 这条只改 HTML，**不动前 7 种块的 markdown 冻结契约**（2.3 逐字节对拍比的是 markdown，不比 HTML）。

### 6.4 红链：本节最想加的东西

`[[不存在的页]]` 不再是一个死链，而是渲染成**红链**（`.doc-wiki-link.is-missing`）。登录用户点它 → 弹「创建这一页」→ 服务端一次做完四件事：建页文档、挂进树的当前位置、把 `subpage` 块追加到站源码、把原先那条双链自动改写成指向新页。未登录时红链只提示「这一页还不存在」，**不弹创建框、不发请求**。**这是 wiki 之所以是 wiki 的那个动作**，也把 γ 模型（独立文档）和「一个帖子」的体验接上了。

双链解析顺序改成：**先在本站里找 → 再全站找 → 找不到就是红链**。旧的单页语义不受影响。

### 6.5 搜索

`GET /api/docs/wiki/:station/search?q=`。**不建新表、不搞 FTS** —— 用 §3.4 刚存的 `doc_settings.source_text` 做 `LIKE`（标题 + 源码两处），只搜本站的页、只搜**这个访客看得到的**页，`%` / `_` 转义，结果上限 50 条并带摘要高亮。`source_text` 就是 markdown 原文，比搜 `props_json` 干净得多。

### 6.6 路由（旧地址一个都不许断）

| 地址 | 行为 |
|---|---|
| `#/wiki` | 站列表（所有你看得到的站） |
| `#/wiki/:名字` | 老语义：按名字找页；若那是站名就打开站 |
| `#/wiki/:站/:页` | 新语义：明确指定 |
| `#/doc/:id` | 照旧直接打开某页（页没有影子帖，这就是它的直达入口） |
| `#/doc/:id/blocks` | 重定向到源码视图并展开该块表单 |

`readWikiName()` 里那个 `decodeURIComponent` 的坑已经在库里了，新增的两段式解析继续走它（`src/core/handler.js:71` 拿的是**未解码**的 `url.pathname`）。

### 6.7 迁移（幂等，跑两遍结果一致）

触发点有**两个**，两条路都幂等：**①** 升级后第一次 `GET /api/docs/wiki`（一次性全量收编）；**②** 任何 `template='page'` 且 `station_id=0` 的文档第一次被 `GET /api/docs/:id` 打开时（就地只收编这一篇）—— 这样即使没人打开过 wiki 列表，被直接访问的老页也不会一直挂着影子帖。

1. 若存在 `template='page'` 且 `station_id=0` 的文档，创建一个站（`template='station'`、作者取第一篇页的作者、标题「Wiki」）；
2. 每篇页设 `station_id`，补一个 `subpage` 块到站源码，**顺手用 `toSource(blocks)` 把 `source_text` 补上**（否则站内搜索会漏掉所有老页，§6.5），写一条 `reason='template'` 修订；
3. **撤销它们的影子帖**，但带护栏：影子帖**已有回复或赞就不删**，只停止同步（它继续当一篇普通帖子活着）；删的只可能是没人搭理过的空壳；
4. `doc_wiki_pages` 的 `category` 生成树上的目录页、`sort_order` 照搬。

### 6.8 权限

页的可见范围就是它自己的 `scope`；**站也不能泄漏子页标题** —— 树在 SQL 里就按可见性过滤，拿到行之后再 `canView` 复查一遍（第一轮那条老 bug 就是这么来的：少一个 `d.scope` 列会让每个访客的侧栏都空掉）。私有站里的页不出现在任何别人的树、搜索、上一页/下一页里。

### 6.9 样式

新增类名全部加进 `public/css/41-doc.css`（`check-ui-contract.mjs:140-167` 会扫服务端拼的每一个 `class="…"`，缺规则直接红），并复用已有的 `.doc-wiki-layout` / `.doc-wiki-nav*` / `.is-current` 一族；「`display:grid/flex` 会盖掉 `[hidden]`，必须显式补 `[hidden]{display:none}`」那个老坑继续钉住。

---

## 7. 接口清单

响应信封仍是 `{ ok: true, data }` / `{ ok: false, error: { code, message } }`（团队规范第 8 节冻结）。错误码沿用现有集合：`bad_request` / `unauthorized` / `forbidden` / `owner_only` / `not_found` / `conflict` / `rate_limited`。

### 7.1 改动

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/docs/:id` | `data` 增加 `settings`（`allowScriptWrite`/`appMode`/`stationId`/`parentId`/`sortOrder`/`icon`）、`toc`；`blocks[]` 里出现 `derived: true` 的行；**作者**额外拿到 `source`（编辑器初始源码，见 §3.2） |
| PUT | `/api/docs/:id/markdown` | body = 源码原文；`?confirm=1` 跳过暴跌确认；按 §3.3–§3.5 处理 |
| POST | `/api/docs/:id/capabilities` | 能力名新增 `blocks.derived`、`site.read`；`state` 新增 `scope='site'`；新增服务端限流（60 次/分/人/文档） |
| GET | `/api/docs/wiki` | 从「nav」改为**站列表** |
| PUT | `/api/docs/:id/wiki` | **下线**：原来的「设分类」不再有意义（分类就是层级）。同一职能交给下面的 `PUT /api/docs/:id/settings` |

### 7.2 新增

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/docs/wiki/:station` | `{ station, tree, toc, prev, next }`，树已按可见性过滤 |
| GET | `/api/docs/wiki/:station/search?q=` | 站内搜索，≤ 50 条 |
| POST | `/api/docs/wiki/:station/pages` | 建页 + 挂树 + 自动追加 `subpage` 块；body `{ title, parentId? }` |
| POST | `/api/docs/:id/derived/adopt` | 「采纳为真块」，body `{ blockIds: [...] }`，作者 only |
| PUT | `/api/docs/:id/settings` | 取代刚下线的 `PUT /api/docs/:id/wiki`；作者可改 `allowScriptWrite` / `appMode` / `stationId` / `parentId` / `sortOrder` / `icon` |

**路由登记顺序纪律**：`src/modules/doc/routes.js:3-10` 明写了登记顺序规则。`/api/docs/wiki/*` 必须继续登记在两段式 `/api/docs/:id` 之前，否则 `wiki` 会被当成 id（第一轮踩过）。

### 7.3 块类型与模板的计数变化

- 内置块类型 **12 → 14**：新增 `script`（第 13）、`subpage`（第 14）。前 7 种的冻结契约不变。
- 模板 **7 → 8**：新增 `station`（Wiki 站）。`templates.js` 的 `WIKI_TEMPLATE = 'page'` 继续是「这是一页」的机器标记。
- 受影响的断言：`check-ui-contract.mjs` 的 `types.length===12` → 14、`templates.length===7` → 8、`MIN_UI_CHECKS` 上调；`doc-smoke.mjs` 的 2.1 类型清单、2.4 新类型计数、S7 模板计数。

---

## 8. 测试策略

规矩是死的（团队规范红线 10）：**不用 `node --test`**，照抄现有写法 —— 自起临时端口、临时库、自己数断言。改动的只有五个脚本，全在 P2 名下：

| 脚本 | 改什么 |
|---|---|
| `scripts/doc-smoke.mjs`（1954 行 / 392 项） | 2.1 类型清单 12→14；2.4 新类型计数 +2；S7 模板 7→8；扩 8.3；**新增 S9 脚本运行时**、**S10 Wiki 站**；补「编辑不再删票」回归 |
| `scripts/check-ui-contract.mjs` | `types.length===12`→`14`；`templates.length===7`→`8`；`MIN_UI_CHECKS` 按新增断言数**只上调不下调**（哨兵，规范第 4 节）；**把 `public/vendor/**` 排除出扫描** |
| `scripts/check-frontend.mjs` | 渲染清单加新编辑页；靠 §5.3 的降级回退，5 个老 fixture 不动 |
| `scripts/check-encoding.mjs` | 新文件加进白名单（`:93-117`）与中文标题表（`:203-218`）；**`public/vendor/**` 加进跳过名单** |
| `scripts/check-skeleton.mjs` | 确认 doc 新表归属正确、`:220` 的深度 import 禁令没被踩 |

**`check-golden.mjs` 的 96 项一个字都不改** —— 它必须一直绿，这是「没碰论坛本体」的机器证明。

`public/vendor/**` 是 minified 第三方代码，`check-encoding` 与 `check-ui-contract` 必须显式跳过它（KaTeX 躲在 `note-studio/public/` 下从没撞过这个问题；我们的 vendor 在 `public/` 里，会撞）。**vendored 文件绝不手改。**

### 8.1 新增测试清单

**S9 脚本运行时**：脚本能读到全文块；开关关闭时 `blocks.derived` 被拒**并且留下 `allowed=0` 的审计行**；打开后能写派生层且渲染带 `derived` 标记；「采纳为真块」产生一条 `reason='adopt'` 修订并清掉派生行；`site` 状态配额与限流；`site.read` 只回 public（**换账号验证看不到私密帖**）；能力限流 60 次/分生效；fullpage 路由同步；**脚本永远写不进 `document_blocks`**。

**S10 Wiki 站**：树的顺序按 `sort_order`；嵌套子页；**换账号后私有页在树 / 搜索 / 前后翻里全部消失**；ToC 锚点确实能定位；上一页/下一页在边界正确；红链点击真能建页且原双链被改写；迁移跑两遍结果一致（幂等）；老 `#/wiki/:名字` 仍能打开；`station_id != 0` 的页**没有**影子帖。

**回归**：改前先写一条「在文首插一段后，原有投票票数仍在」的失败测试，再让 §3.3 的实现把它变绿。

---

## 9. 实施步骤

七段，每段都能独立验证、独立提交（都在 `feat/doc` 上）：

1. **开分支**：`git switch -c feat/doc origin/v2-skeleton`（基线 `4199280`）。先跑一遍五个检查脚本，确认起点全绿。
2. **数据层**：`doc_settings` / `doc_script_blocks` / `doc_site_state` 三张新表进 `DOC_SCHEMA`；`present()` 返回 `toc`；`heading.toHtml` 加 `id`。
3. **源码格式**：`{#id}` / `<!-- id -->` / `doc:script`；`toSource` / `parseBlocks` 两种都吃；按 id 对齐 upsert；`source_text` —— **顺手修掉删票 bug + 回归测试**。
4. **运行时**：`script` 块类型；`blocks.derived` / `site.read` / `state.site` 三个能力；派生层渲染与「采纳为真块」；能力限流。
5. **编辑器**：vendor CodeMirror、`doc-editor.js`、实时预览、AI 适配器、表单降级、模板下拉。
6. **Wiki**：`station` 模板 + `subpage` 块 + 树 / ToC / 红链 / 搜索 + 幂等迁移。
7. **收尾**：五个检查脚本跟上、哨兵数字上调、相关文档跟新，`check-golden` / `check-skeleton` / `smoke` / `check-frontend` / `check-encoding` 全绿。

每段结束都跑：`check-golden` + `check-skeleton` + `smoke` + `check-encoding`；前端段再加 `check-frontend`。

---

## 10. 风险与对策

| # | 风险 | 对策 |
|---|---|---|
| R1 | 编辑器吃掉作者写的 markdown（解析器有损） | `source_text` 逐字留存；**只读路径完全不走它**；三道防手滑。有损这件事被关在编辑器里，读者侧零影响 |
| R2 | 老库加不上列 / CHECK 改不动 | 一切新结构走**新表** + `CREATE TABLE IF NOT EXISTS`；真要 ALTER 就在 doc 模块 `install(ctx)` 里写守卫式迁移 |
| R3 | 迁移把有互动的帖子删了 | 护栏：影子帖有回复或赞就**不删**，只停同步 |
| R4 | 脚本变成 XSS 跳板 | 不透明源 iframe；派生块 `type` 必须是已注册类型；props 走 `coerceProps`；渲染走同一个 `renderBlocks`；服务端从不执行用户代码 |
| R5 | 改了 392 项断言，怕放水 | 只改积木那一摊；`check-golden` 96 项做反向证明；哨兵数字只上调不下调 |
| R6 | 现存删票 bug 一直没人发现 | §3.3 按 id 对齐 upsert 顺手修掉，并补回归测试 |
| R7 | 密钥红线 | 用户已选「不给网」，所以不建代理、不接外部服务、**不需要任何 token**（规范红线 6 天然规避）。网络只在**开发期**用来 vendor 那 24 个文件，**运行期零外联**，沙箱 CSP 一个字不改 |
| R8 | 站文档的 500 块上限 | 一页一个 `subpage` 块，500 页以内很宽裕；到顶就拒绝加页并明确提示，不静默丢 |
| R9 | CodeMirror 与站点主题不搭 | 只用 `00-themes.css` 已有的 7 套变量写皮肤；切主题时 `cm.refresh()`；再不行就用 §5.3 的 textarea 回退 |
| R10 | `public/vendor/**` 撞上两个扫描脚本 | 两个脚本各加一条 vendor 跳过，并在文件头注明「第三方 minified，勿改」 |

---

## 11. 验收清单

| 用户要求 | 怎么验 |
|---|---|
| ① 编程自由度：直接往帖子上写代码 | 帖子级 `script` 块拿到全文块列表，能写出派生块；跑一个真程序（实时计票 / 排行榜） |
| ② 编辑方式不再冗长复杂 | `#/doc/:id/edit` 一屏：CodeMirror 源码视图 + 实时预览；新建从 5 步变 1 屏；模板下拉 |
| ③ WIKI 像 oi-wiki / ctf-wiki，且一个帖子一个 wiki | 打开站那篇帖子就是 wiki：左树 / 正文 / 右 ToC + 红链 + 站内搜索；子页不出现在积木广场 |
| ④ 能做复杂东西甚至小程序 | 一个 `app_mode='fullpage'` 的整屏应用：自己的路由、站内共享状态、多页面 |
| ⑤ 老内容不丢 | 升级后 11 篇文档 / 32 篇帖子、7 个 app 块、投票票数、`callout`、双链原样还在 |
| ⑥ 论坛本体零改动 | `check-golden` 96 项全程绿；`git diff --name-only` 里没有 `src/core/`、`src/modules/core/` |

---

## 12. 团队规范合规检查

| 规范条款 | 本设计 |
|---|---|
| 只往自己那条 `feat/*` 推 | 开发分支 `feat/doc`；不推 `main`、不推 `v2-skeleton`、不 force push |
| 红线 4：不许改 `src/core/`、`src/modules/core/` | 全部改动落在 `src/modules/doc/**`、`public/views/doc*.js`、`public/css/41-doc.css`、`public/vendor/**`、`scripts/*doc*`、`docs/**` |
| 红线 7：不许自己 `CREATE TABLE` / 自己连数据库 | 三张新表都进 `DOC_SCHEMA`，走模块自己的 schema 脚本（`schemas.addScript(DOC_SCHEMA, 'doc')`） |
| 红线 8 + 第 8 节：响应信封冻结 | 全部沿用 `{ ok, data }` / `{ ok, error: { code, message } }` |
| 第 8 节：四样契约冻结 | 可见范围枚举不变；`document_blocks.position` 继续 `REAL`；信封不变；旧页面地址（`#/post/:id`、`#/u/:username`、`#/settings`、`#/doc/:id/blocks`、`#/wiki/:名字`）全部还能打开 |
| 红线 9：不新开顶层目录 | vendored 文件放 `public/vendor/codemirror/`，没有新顶层目录 |
| 红线 10：不用 `node --test` | 全部测试沿用现有自起端口 + 临时库 + 自数断言的写法 |
| 第 3.4 节：提交前必跑 | `check-golden` / `check-skeleton` / `smoke` / `check-frontend` / `check-encoding` 全绿才提交 |
| 第 4 节：新增文件要上调哨兵 | `MIN_UI_CHECKS`、`check-encoding` 文件数、`types.length`、`templates.length` 一并上调 |
| 第 5 节：合并顺序 P2 先合 | 本轮就是把 P2 做成地基（表结构最稳的那一路） |
