# 积木帖子（可编程帖子）· 设计规格（Spec）

- 状态：**待评审**
- 关联需求：[P2-积木帖子.md](<D:\Project1\Blog\docs\开工说明\P2-积木帖子.md>)、[01-需求规格说明书.md](<D:\Project1\Docs\01-需求规格说明书.md>) §2.4 / §5.1、[02-功能说明书-人话版.md](<D:\Project1\Docs\02-功能说明书-人话版.md>)
- 权威基线：`D:\Project1\Blog`（分支 `v2-skeleton` @ `19cfef1`）
- 基线测试：14 组全绿（`check-encoding` 162/61 · `check-skeleton` 47/0 · `check-golden` 96/0 · `check-frontend` 21 页 · `smoke` 242/0 · `smoke-ai` 61/0 · `feed-smoke` 95/0 · `check-ui-contract` 200/0 · `check-graph-ui` 24/0 · `check-notes-ui` 33/0 · `notes-smoke` 44/0 · `note-studio/tests` · `forum-ai/selftest` 92/0 · `knowledge-pack/selftest` 56/0）
- 目标：把「内容」从一坨 Markdown 变成**一串有序的积木块**，并把这件事做成新站的**底座** —— 积木帖子、笔记、个人主页都建在同一套 `documents` 上。

---

## 0. 意图与成功标准

### 0.1 意图

用户下达的原话：

> 开始写可编程帖子（积木帖子）吧，记得看所有的计划。用 /brainstorming 和 /test-driven-development 。一样，给出预览后，我说能交付再推上去。

以及三道定了方向的选择题，用户的选择是：

| 问题 | 用户的选择 | 含义 |
|---|---|---|
| 积木帖子与旧 `posts` 的关系 | 「**以前的帖子废除了，现在帖子是动态。积木帖子会是新网站的底层逻辑，主要是服务于包括笔记功能所有的能用可编程帖子的部分。**」 | 旧论坛形态（板块 + 帖子）已经是上一代；`documents` 是**新站的内容底座**，笔记、个人主页、积木帖子都挂在它上面。**不与 `posts` 一一对应。** |
| 互动（赞/踩/投币/收藏/价值分）挂在哪 | **A. 独立身份 + 复用 `posts` 做互动锚点** | 每篇文档在 `posts` 里留一条「影子行」只做互动锚点；core 的互动链路**一个字不改** |
| 本轮做到哪 | **甲「底座先行」** | 本轮连**笔记页与个人主页**都改到 `documents` 上 |

所以本轮要交付的是一根**能承重的底座**，而不是一个孤立的页面。

### 0.2 成功标准

1. 一篇积木帖子能从「建 → 套模板 → 块级编辑 → 看 → 导出 → 导入」走完，且**块是库里的实体**（`document_blocks` 一行一个块），不是 Markdown 里的字符串。
2. **块间能联动**：一块的值能被另一块读到，且**环检测住了**（检测到环不是死循环，是降级 + 警告）。
3. **未知类型不炸**：未注册的块类型、坏 JSON、非法 props → 渲染占位卡 + 响应里带 `warnings[]`，**绝不白屏**。
4. **Markdown 往返不丢**：`blocks → markdown → blocks` 幂等，存量 `posts.content` 可无损转块。
5. **可执行块跑在玻璃房里**：能看见、能碰，但撞不出去（拿不到父页面 DOM、Cookie、网络）。
6. **旧的互动全绿**：赞/踩/投币/收藏/通知/价值分/个人主页置顶对公开的积木帖子**零改动可用**。
7. **笔记与个人主页真的接到底座上**（这是「甲」的核心），且旧的笔记路径**一条都没删**。
8. 全程 14 组测试 + 新增的 `doc-smoke` 全绿，`check-golden` 一次都没 `--write` 过。

### 0.3 明确不做（YAGNI）

- **不做实时协作通道**（WebSocket / presence / 多光标）—— 那是 P4 团队的事，本轮一个字节都不碰。
- **不做 AI 对块的直接操作**（「对选定块做操作」是 P3，本轮最多把现有 AI 抽屉嵌进普通编辑页）。
- **不做服务端执行用户代码**。用户代码永远只在浏览器 iframe 里跑；服务端只做存储、校验、包装与转义。
- **不改 `src/core/*`、`src/modules/core/*`、`src/store.js`、`note-agent/`**。影子行带来的可见性短板（§2.5）本轮**登记为已知短板，不修**。
- **不做积木帖子的评论树**。评论暂时仍挂在影子帖的 `replies` 上（core 已有），但本轮不专门做 UI。
- **不做块级权限**（一块一个可见范围）—— 可见范围是文档级的。

---

## 1. 现状与关键发现

### 1.1 落点

| 东西 | 现状 | 本轮 |
|---|---|---|
| `src/modules/doc/index.js` | 23 行空壳，`owns: ['documents','document_blocks']`，`install(ctx)` 里只有 `void ctx` | 填满 |
| `src/modules/index.js` | `MODULES = [core, feed, doc, ai, team, ui]` | **不动** |
| 表登记方式 | `feed` 用 `schemas.addScript(FEED_SCHEMA, 'feed')` 写在**模块顶层**（副作用导入），因为开库发生在 `src/server.js` 的 import 期 | 照抄 |
| `installModules` 的守则 | 模块声明了 `apiPrefix` 且 `owns` 非空却**一条路由都没登记**就直接报错 | 必须同时登记路由 |
| `public/app.js` | 44 行，入口只有一个 | 加一行 import |
| `public/style.css` | 24 行，纯 `@import` | 加一行 |
| `src/core/schema.js` | 只做转发：`export { schemas } from './table.js'` + `tablesWithoutOwner` / `ownedButNotRegistered` | 用它登记表 |

### 1.2 「块」这套东西已经存在，但没有实体

`note-agent/src/blocks.mjs` 已经有 `BLOCK_TYPES = ['heading','paragraph','list','code','table','formula','image']`、`BLOCK_ID_RE = /^b\d+$/`、`makeBlock()`、`assignBlockIds()`、`blocksToMarkdown()`、`blocksToPlainText()`；`note-agent/src/ops.mjs` 已经有 7 种 op、别名归一化、审计字段。

**但它们活在编辑器会话里**（`notes_sessions` / `notes_messages`），帖子存库后仍是一整坨 `posts.content`。这就是需求文档里的 FR-DOC-01 / FR-DOC-02（两个 P0）：**库里没有「块」这个实体**。

### 1.3 三个实测出来的硬约束

**① 表登记必须发生在 import 期。** `src/modules/feed/index.js:24` 的 `schemas.addScript(FEED_SCHEMA, 'feed')` 是**顶层语句**，不在 `install(ctx)` 里。原因写在那个文件的注释里：开库动作发生在 `src/server.js` 调 `openDatabase()` 的时候，那时 `schemas` 必须已经满员。照抄。

**② 影子行的 `deleted` 必须是 0。** 三个互动接口都要它：

| 接口 | 位置 | 要求 |
|---|---|---|
| 赞 / 踩 | `src/modules/core/routes-b.js:254` → `store.postById` | `src/store.js:606` 的 `WHERE p.id = ? AND p.deleted = 0` |
| 投币 | `src/modules/core/routes-b.js:283-284` → `store.postRow` + `ensure(post && !post.deleted)` | `deleted = 0` |
| 收藏 | `src/modules/core/routes-c.js:161` → `store.postById` | `p.deleted = 0` |

**③ 而 `deleted = 0` 的行必然被所有帖子列表收录。** `src/store.js:412-423` 的 `buildFilter()` 第一句就是 `const where = ['p.deleted = 0']`。所以影子行一定会在旧列表里露脸 —— 这是「复用互动锚点」这条路**买不到免票**的地方，只能把它设计得体面（§2.5）。

### 1.4 前端入口纪律

`public/app.js` 保持 44 行：新视图只加一行 `import`，路由只加一段 `public/core/router.js` 注册，样式只加一行 `public/style.css`。`check-frontend.mjs` 会真起服务渲染 21 个页面，新页面必须进那份清单。

---

## 2. 数据模型

四张表，全部归 `doc` 模块（写进 `owns` —— 否则 `ownedButNotRegistered()` 会在启动时报错）。

### 2.1 `documents` —— 一篇内容

```
id            INTEGER PRIMARY KEY AUTOINCREMENT
user_id       INTEGER NOT NULL            -- 作者，逻辑外键 users(id)
kind          TEXT NOT NULL DEFAULT 'post'   -- 'post' | 'note' | 'profile'
title         TEXT NOT NULL DEFAULT ''
scope         TEXT NOT NULL DEFAULT 'public' -- 'public' | 'followers' | 'team' | 'private'
template      TEXT NOT NULL DEFAULT ''       -- 套过的模板 key
anchor_post_id INTEGER                        -- 影子行 id（§2.5），NULL 表示还没建
sandbox_disabled INTEGER NOT NULL DEFAULT 0   -- staff 可置 1，全站禁用该文档的沙箱块
deleted       INTEGER NOT NULL DEFAULT 0
created_at    INTEGER NOT NULL
updated_at    INTEGER NOT NULL
```

索引：`(user_id, kind, deleted)`、`(scope, deleted, updated_at)`。

**为什么 `kind` 放在同一张表而不是三张表**：笔记、个人主页、积木帖子共享同一套块引擎、同一套编辑流程、同一套导出格式，只有「列表怎么查」「权限怎么判」不同。三张表会让块引擎写成三份。

### 2.2 `document_blocks` —— 块序列本体

```
id           INTEGER PRIMARY KEY AUTOINCREMENT
document_id  INTEGER NOT NULL
block_id     TEXT NOT NULL              -- 'b1'..'bn'，文档内唯一，一旦分配永不重排
type         TEXT NOT NULL              -- 单独一列（需求坑 #4）
position     REAL NOT NULL              -- REAL（需求坑 #2 / 验收 ②）
props_json   TEXT NOT NULL DEFAULT '{}'
type_version INTEGER NOT NULL DEFAULT 1 -- 块类型版本（FR-BLOCK-06）
created_at   INTEGER NOT NULL
updated_at   INTEGER NOT NULL
UNIQUE (document_id, block_id)
```

索引：`(document_id, position)`。

**`position` 用 REAL 的意义**（验收标准 ②）：插到「1 和 2 之间」写 `1.5` 即可，**不必把后面所有块 `+1`**。这对「块级编辑器每次插入都重写整篇」是决定性的 —— 一次插入只写一行。浮点精度耗尽时（相邻差 < 1e-6）才做一次整篇重排，这件事**只在服务端发生**，前端只管提交「插在谁后面」。

**`type` 单独一列而不是塞进 `props_json`**（需求坑 #4）：可以按类型建索引、可以只查「这篇文档有哪些 `app` 块」、可以在不改 JSON 的情况下迁移类型，也让 SQL 层面的排查（`SELECT type, count(*) FROM document_blocks GROUP BY type`）成为可能。

### 2.3 `document_revisions` —— 修订快照

```
id          INTEGER PRIMARY KEY AUTOINCREMENT
document_id INTEGER NOT NULL
revision    INTEGER NOT NULL             -- 1, 2, 3 …
title       TEXT NOT NULL DEFAULT ''
blocks_json TEXT NOT NULL
author_id   INTEGER NOT NULL
reason      TEXT NOT NULL                -- 'create'|'edit'|'ops'|'template'|'import'|'rollback'
created_at  INTEGER NOT NULL
UNIQUE (document_id, revision)
```

每篇文档**保留最近 50 条**，更老的删掉（`DELETE … WHERE document_id = ? AND revision <= ?`）。

**这张表一次买三件事**，所以不是过度设计：

1. Wiki 模板要求的「**修订记录**」（FR-TPL-02）—— 渲染时直接查这张表，不用块自己维护。
2. **撤销 / 重做与整篇回滚**（FR-EDIT-08）—— 块级 Ctrl+Z 是前端栈，整篇回滚走 `POST /api/docs/:id/rollback`。
3. **套模板前的自动存档**（FR-TPL-04 的「替换要提示」）—— `apply-template(mode='replace')` 先写一条 `reason='template'` 的快照，用户后悔了能回来。

### 2.4 `doc_block_types` —— 自定义块类型注册表

```
name               TEXT PRIMARY KEY
label              TEXT NOT NULL
icon               TEXT NOT NULL DEFAULT ''
version            INTEGER NOT NULL DEFAULT 1
props_schema_json  TEXT NOT NULL DEFAULT '{}'
renderer_kind      TEXT NOT NULL           -- 'declarative' | 'sandbox'
renderer_json      TEXT NOT NULL DEFAULT '{}'
created_by         INTEGER NOT NULL
created_at         INTEGER NOT NULL
```

这是 FR-BLOCK-04「**不改核心代码就能注册新块类型**」的唯一诚实实现。如果「注册」意味着改 `src/modules/doc/blocks/*.js`，那它就不是注册，是改代码。有了这张表，「新增一种块类型」= `INSERT` 一行（走 `POST /api/docs/meta/block-types`）。

**注册表 = 内置 12 个 ∪ 这张表**。冲突时以内置为准（内置类型不许被用户覆盖，否则别人能把 `heading` 重新定义成任意东西）。

`renderer_kind` 只允许两个值，**没有第三个**：`declarative`（用 `renderer_json` 描述的声明式渲染：字段、模板串、受限的表达式）或 `sandbox`（渲染成一个 `app` 块，跑在 §6 的玻璃房里）。**不允许往表里塞服务端代码** —— 这是这张表不变成 RCE 漏洞的唯一理由。

### 2.5 影子行（互动锚点）—— 复用 `posts` 的完整规格与代价

这是「选 A」的全部代价所在，写清楚。

**建一次系统板块：**

```sql
INSERT OR IGNORE INTO boards (slug, name, icon, description, sort_order, created_at)
VALUES ('documents', '积木', '🧩', '可编程帖子、笔记与个人主页的互动锚点', 999, ?);
```

幂等，只在第一次需要时执行。它不出现在任何导航里。

**每篇文档一行 `posts`：**

| 列 | 值 | 为什么 |
|---|---|---|
| `board_id` | 系统板块 id | 让锚点集中在一个没人访问的板块里，不污染真实板块 |
| `user_id` | 文档作者 | 通知、@、价值分要能找到作者 |
| `title` | 文档标题（仅 `public`） | 让旧列表/搜索可用 |
| `content` | 块序列纯文本摘要，前 400 字（仅 `public`） | 同上；`POST_LIST_COLUMNS` 取的就是 `substr(p.content,1,400)` |
| `deleted` | 跟随文档（文档软删 → 锚点 `deleted=1`） | 决定互动接口能不能找到它 |
| `hidden` | `public` → `0`；其余 → `1` | `hidden=1` 让 `buildFilter` 排除它，且 `assertPostVisible` 对外人 404 |
| `category_id` | `NULL` | 与个人主页分类无关 |
| `profile_pinned` | 保持可写 | **白捡的收益**：个人主页置顶对积木帖子直接可用 |

**同步时机**：创建文档、改标题、改可见范围、块序列变更（throttle：只在 `content` 摘要真的变了才写）、删除文档。

**代价（必须知情）：**

`src/core/guards.js` 里 `assertPostVisible(post, ctx)` 的语义是「`hidden=1` 的帖子对**非 staff 非作者**返回 404」。core 的互动接口（赞/踩/投币/收藏）只认 `hidden`，**不认文档的可见范围**。于是：

> **`followers` / `team` 可见的文档，别人点赞 / 投币 / 收藏会 404。**

谁受影响：文档作者没事（作者永远可见）；staff 没事；**关注者受影响** —— 他们能读到文档，但点不了赞。

**为什么不顺手修掉**：要修就得改 `assertPostVisible` 或互动接口，让它们认「文档可见范围」。这是 `src/core/*` 与 `src/modules/core/*` 的地盘，属别人的工作面，而且改它会牵动 `check-golden` 里 96 项对外行为断言。所以本轮**登记为已知短板**。

**两条备选（留给后续轮次）**：

1. 动 core：给 `assertPostVisible` 加一个「可见范围」概念，让互动接口认它（正统，但要动 core 且要重跑 golden）。
2. 非公开文档不做外部互动：只保留作者自己的收藏，UI 上不显示赞/币按钮（省事，但「保留点赞投币」这条需求在非公开档上就落空了）。

**反向收益**：`public` 文档的 赞 / 踩 / 投币 / 收藏 / 通知 / 价值分 / 个人主页置顶 **一个字都不用改**，全部走既有链路。

### 2.6 可见范围（`scope`）的判定

与 `feed` 模块**逐条对齐**，包括那个「探测一次」的技巧：

```js
const hasTeams = Boolean(ctx.db.prepare(
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'team_members'"
).get());
```

| scope | 谁能读 |
|---|---|
| `public` | 所有人（含未登录） |
| `followers` | 作者 + 关注了作者的人 + staff |
| `team` | 作者 + 同队的人 + staff。**`team_members` 表不存在时，除了作者和 staff，谁也看不到** —— 宁可少显示，绝不降级成公开 |
| `private` | 作者 + staff |

**未登录访问**：`public` → 200；其余 → **401**（不是 404）。写操作未登录 → **401**（验收标准 ⑪）。

**不可见时的响应是 404 而不是 403** —— 403 会泄露「这篇文档存在」。

### 2.7 `doc_capability_logs` —— 沙箱能力申请的审计

```
id            INTEGER PRIMARY KEY
document_id   INTEGER NOT NULL
block_id      TEXT    NOT NULL DEFAULT ''
capability    TEXT    NOT NULL
user_id       INTEGER
allowed       INTEGER NOT NULL DEFAULT 0
created_at    INTEGER NOT NULL
```

索引 `idx_doc_capability_logs_doc(document_id, created_at DESC)`。

追加型（**没有 `updated_at`，也不提供删除或修改接口**）：审计一旦能被改，它就不是审计了。

三个刻意的设计：

- **被拒绝的申请也记一行**（`allowed = 0`）。最该留下的记录恰恰是「有人试过申请 `user-token`」。
- `user_id` 记的是**访问者**，不是文档作者。沙箱跑在谁的浏览器里，就是谁在申请（见 §6.2）。
- 这张表是**唯一**允许沙箱读取任何东西的路径，而每一行都可查 —— 想拿到什么必须经过这里，而这里是可审计的。

---

## 3. 块引擎

### 3.1 12 个内置类型

**7 个既有（原样兼容）**：`heading` `paragraph` `list` `code` `table` `formula` `image`
**5 个新增**：`quote` `poll` `wiki` `embed` `app`

兼容红线这么守：

- **不 import 也不修改 `note-agent/src/blocks.mjs`**。理由有两条：① 它是另一个子系统，让新底座反过来依赖它，方向就反了；② `makeBlock()` 对未知类型**抛 `TypeError`**，而这正是 FR-BLOCK-05 要求废掉的行为 —— 改它就会让 `note-agent` 的既有测试变红。
- `doc` 模块自带一份注册表，**旧 7 类在里面的顺序、名字、`blocksToMarkdown` 输出与 `note-agent` 逐字相同**。
- 用一条**「契约对拍」测试**守住：断言 doc 注册表里前 7 个类型名与顺序 `===` `note-agent/src/blocks.mjs` 的 `BLOCK_TYPES`，并对固定样例断言两边的 `blocksToMarkdown()` 输出**逐字节相同**。这样两边的块序列可以互换，存量笔记能迁进来，导出的文档也能喂回笔记。

### 3.2 块的形状与注册

```js
registerBlockType({
  name: 'poll',              // 唯一标识
  version: 1,                // 类型版本（FR-BLOCK-06）
  label: '投票',             // 编辑器里显示的名字
  icon: '🗳️',
  props: {                   // 声明式 schema：类型、必填、长度上限、枚举
    question: { type: 'text', required: true, max: 200 },
    options:  { type: 'list', required: true, max: 20, item: { type: 'text', max: 80 } },
    multiple: { type: 'bool', default: false },
  },
  render(props, ctx) { /* → HTML 字符串（转义由 ctx.esc 保证） */ },
  editor(props) { /* → 表单 HTML */ },
  plain(props) { /* → 纯文本（喂给 blocksToPlainText / 搜索摘要） */ },
});
```

**注册表 = 内置 12 个 ∪ `doc_block_types` 表里的自定义类型**。内置优先，冲突时内置胜（用户不能重定义 `heading`）。

### 3.3 三条钉死的行为（每条都有对应的失败测试）

**① 降级不崩（FR-BLOCK-05 / FR-BLOCK-06）**

任何一处不正常 —— 类型没注册、`props_json` 是坏 JSON、props 不满足 schema、块类型版本比当前实现更新 —— 一律渲染：

```html
<div class="doc-block doc-block-unknown">该块无法显示（原因：未知类型 xxx）</div>
```

**绝不抛异常、绝不白屏**，并且响应里带 `warnings: [{ blockId, type, reason }]`，让用户和排查者都能看见「哪一块、为什么」。位置信息（`position`）在降级后仍然保留，所以一块坏掉不影响其它块的顺序。

**② Markdown 往返（FR-BLOCK-09 / FR-DOC-02）**

- `blocksToMarkdown(blocks)`：用既有的 7 类语义（与 note-agent 逐字节对齐，由契约对拍测试守住）。
- `markdownToBlocks(md)`：**新增**。7 类足以覆盖 95% 的存量 `posts.content`。
- **属性测试**：100 篇样例断言 `blocks(md(x)) == blocks(x)`（幂等）。这是「存量帖子可以无损转块」与「两套编辑模式共用一份数据」的数学保证 —— 没有它，用户在普通模式改一次字，块的 id 就会全部重排，AI 会话里引用的 `b3` 就指错了。
- 无法表达的 Markdown 结构（比如嵌套表格）落到最近的类型上，**丢信息必须留痕**：`markdownToBlocks` 返回 `{ blocks, warnings }`。

**③ 块间联动（FR-BLOCK-07）**

块可以在 props 里声明引用：

```js
{ bind: { from: 'b3', field: 'result' } }
```

渲染前做一次**拓扑解析**：

1. 收集所有 `bind`，建图。
2. 拓扑排序求值顺序。
3. **检测到环**（`b2` 引用 `b4`、`b4` 引用 `b2`）→ **把这些块降级为占位并警告**，绝不递归求值、绝不死循环。
4. 引用了不存在的 `blockId` → 该块降级并警告（原因：`missing_ref`）。

**落地时必须记住的一条**：`bind` 是**跨块约定**，不写在任何块的 `props` schema 里，而 `coerceProps` 会把 schema 未声明的键一律丢掉。所以 `src/modules/doc/blocks/validate.js` 里有一张 `RESERVED_KEYS = ['bind']`，专门把它认下来（格式不对就丢掉 + 一条警告，**不让整块降级** —— 块自己还有默认值可渲染）。不这么做的话，引擎测试全绿而用户永远存不进一条联动：他会以为是自己写错了。编辑器的块表单里也带了一行「联动」输入（来源块号 + 字段名），否则这个能力在产品里只剩一个后端函数。

---

## 4. 接口清单（`/api/docs/*`）

信封沿用全局约定：成功 `{ ok: true, data }`，失败 `{ ok: false, error: { code, message } }`。错误码只用 `bad_request(400) / unauthenticated(401) / forbidden(403) / owner_only(403) / not_found(404) / conflict(409) / rate_limited(429)`。

### 4.1 文档

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/docs` | 列表。`?kind=note&scope=&mine=1&q=&page=1&limit=20&sort=updated` |
| `POST` | `/api/docs` | 建。`{title, kind, scope, template, blocks?}` → 建行 + 初始块 + 影子行 + revision 1 |
| `GET` | `/api/docs/:id` | 详情：`{doc, blocks, warnings, abilities:{canEdit,canReact,canCoin}, anchorPostId}` |
| `PUT` | `/api/docs/:id` | 改元数据 `{title?, scope?, template?}`（标题/可见范围变更时同步影子行） |
| `DELETE` | `/api/docs/:id` | 软删（文档与影子行一起 `deleted=1`） |

### 4.2 块

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/docs/:id/blocks` | 插块 `{type, props, after?\|before?\|position?}` → 返回带新 `blockId` 的块 |
| `PUT` | `/api/docs/:id/blocks/:blockId` | 改块（props / type） |
| `DELETE` | `/api/docs/:id/blocks/:blockId` | 删块 |
| `POST` | `/api/docs/:id/blocks/:blockId/move` | 换位 `{after?\|before?\|position?}` |
| `POST` | `/api/docs/:id/reorder` | 批量换序 `{order:[blockId…]}`（拖拽一次性提交） |
| `POST` | `/api/docs/:id/ops` | 应用一批 op（沿用 `note-agent/src/ops.mjs` 的语义与审计字段，供 AI 与批量编辑用） |

### 4.3 两种编辑模式

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/docs/:id/markdown` | 块序列 → Markdown（普通编辑模式的初始值） |
| `PUT` | `/api/docs/:id/markdown` | **整篇 Markdown 覆盖保存**：内部 `markdownToBlocks()` 后替换块序列（FR-DOC-02 的双向同步在这里落地） |

普通编辑与高级编辑**共用同一份块序列**：普通模式是块序列的 Markdown 投影，高级模式是块序列本身。所以「用普通模式改一次字就丢掉块结构」这件事在数据层就不可能发生。

### 4.4 模板 / 类型 / 导入导出 / 修订

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/docs/meta/templates` | 内置模板清单 |
| `GET` | `/api/docs/meta/block-types` | 注册表（内置 + 自定义） |
| `POST` | `/api/docs/meta/block-types` | 注册自定义类型（FR-BLOCK-04） |
| `POST` | `/api/docs/:id/apply-template` | 套模板 `{key, mode:'replace'\|'append'}`（`replace` 先存快照） |
| `GET` | `/api/docs/:id/export` | 导出 `{format:'forum-doc/1', doc, blocks}` |
| `POST` | `/api/docs/meta/import` | 导入（`blockId` 重新分配；未知类型原样保留） |
| `GET` | `/api/docs/:id/revisions` | 修订列表 |
| `POST` | `/api/docs/:id/rollback` | 回滚 `{revision}` → 生成新 revision（`reason='rollback'`） |
| `GET` | `/api/docs/wiki/:name` | 按标题找一页 wiki（`template='page'`）；看不见与不存在都是 `{found:false}` |
| `POST` | `/api/docs/wiki/:name` | 打开或新建一页 wiki `{scope}`（默认 `public`），返回 `created` |

> **路径为什么这么摆**：`/api/docs/:id` 是两段式，所以任何两段式的固定路径（`/api/docs/import`、`/api/docs/block-types`）都会和它撞。辅助接口一律放到**三段式**的 `/api/docs/meta/*` 下，从结构上不可能撞。`check-skeleton` 只查「方法+路径完全相同」的重复，查不出这种歧义，所以这条纪律得靠结构来保证。

### 4.5 权限矩阵

| 操作 | 谁可以 |
|---|---|
| 建 | 登录用户 |
| 读 | 按 `scope`（§2.6）；未登录读非公开 → 401；不可见 → 404 |
| 改 / 删 / 套模板 / 回滚 | 作者 或 staff |
| 注册块类型 | 登录用户（`created_by` 记名）；内置类型名不可占用 → 409。**注意这是全局注册表**：一个人注册的类型所有人都能用，所以每次注册必须记名、且后续要能在管理后台撤掉 |
| 置 `sandbox_disabled` | 仅 staff（FR-SANDBOX-08） |
| 赞 / 踩 / 投币 / 收藏 | **走 core 既有接口**，本轮不加新接口 |

限流：块操作与沙箱调用走 `ctx.http.rateLimit`。

---

## 5. 编辑体验

### 5.1 两个模式

**普通编辑**（`#/doc/:id/edit`）—— 给所有人用：

- 一个 Markdown 编辑区，复用既有 compose 的**实时 LaTeX 预览**。
- 右侧嵌**现有的 AI 抽屉**（`/notes-panel.js`，由 `note-agent/src/mount.mjs` 提供）。本轮只做「嵌得进去、能开、能改文本」，**「AI 直接对块操作」是 P3**。
- 保存走 `PUT /api/docs/:id/markdown`。

**高级编辑**（`#/doc/:id/blocks`）—— 给愿意用的人：

- 左：块列表（拖拽换序、插入、删除、折叠、显示类型与 `blockId`）。
- 中：块预览（就是最终渲染结果）。
- 右：**当前块的 props 表单**，由块的 `editor(props)` 生成。
- 保存按块粒度走 `POST/PUT/DELETE/move` —— 改一个块**只写一行**（这正是 `position REAL` 的红利）。

### 5.2 模式互切与脏标记

- 切换模式前若有未保存改动 → 提示先保存（因为两个模式写的是同一份块序列，不保存就切会让用户以为改动生效了）。
- 脏标记 = 前端记录「最后一次保存的 revision 号」，与 `GET /api/docs/:id` 返回的当前 revision 不同即脏。
- 撤销/重做：块级操作用前端栈；整篇回滚走 `POST /api/docs/:id/rollback`（FR-EDIT-08 的持久层已经由 `document_revisions` 备好）。

### 5.3 前端的注册纪律

三行，一个都不能少：

1. `public/app.js` 加一行 `import './views/doc.js'`（**文件必须保持 44 行**）。
2. `public/core/router.js` 加 `#/doc/:id`、`#/doc/:id/edit`、`#/doc/:id/blocks`、`#/docs`（我的积木）四段路由。
3. `public/style.css` 顶部加一行 `@import './css/41-doc.css'`（两位数字前缀决定加载顺序）。

新文件：`public/views/doc.js`、`public/css/41-doc.css`、`public/views/doc-blocks.js`（高级编辑的块列表与 props 表单，避免单文件过大）。

### 5.4 落地说明（S4 实际采用的形状）

- **两个模式在同一个页面里用页签切**（`#/doc/:id/edit` 与 `#/doc/:id/blocks` 进的是同一个编辑器，后者只是默认落在积木模式上），而不是两个独立页面 —— 切模式不用重新拉一遍文档。
- **实时预览复用 `POST /api/markdown/preview`**（compose 的「预览」按钮走的是同一个接口，LaTeX 在这一层渲染）。区别是这里**防抖 400ms 自动跑**，不需要点按钮；预览失败只把原因写在状态位里，不挡编辑。
- **AI 抽屉复用 `/notes-panel.js` 的 `window.NotesAgent.attach`**，编辑器侧只需要提供一个带 `name="content"` 的 textarea（`createTextareaAdapter` 就是按这个找编辑区的）。抽屉拿不到时只提示一句，Markdown 编辑照常能用。
- **高级编辑没有做左/中/右三栏**，而是「一列块卡片」：每张卡片自带预览、props 表单、保存/上移/下移/删除。三栏在窄屏上会挤成一条缝，而块本来就该是一张张独立编辑的。`position REAL` 的红利照拿 —— 改一个块仍然只写一行。
- 编辑器里**没有全局保存**：块粒度、标题+范围、Markdown 各管各的按钮。

---

## 6. 沙箱（`app` 块 / 自定义逻辑块）

**玻璃房的定义在这里落地。**

### 6.1 隔离手段

```html
<iframe sandbox="allow-scripts" loading="lazy"
        srcdoc="<!doctype html><meta http-equiv='Content-Security-Policy'
               content=&quot;default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'&quot;>…">
```

| 措施 | 挡住的攻击 |
|---|---|
| `sandbox="allow-scripts"` 且**不给** `allow-same-origin` | iframe 处于**不透明源**：读不到父页面 DOM、`localStorage`、`document.cookie`，也没有同源 `fetch` 凭据 |
| iframe 内 CSP `default-src 'none'` | 发不出网络请求、加载不了外部脚本与图片 → 数据出不去 |
| 宿主 → iframe 只传结构化数据（`props` / `inputs`） | 传不过函数，注入不了宿主代码 |
| iframe → 宿主只接受白名单消息 | 见 §6.2 |
| `allow-scripts` 之外一个都不给 | 不能弹窗（`allow-modals`）、不能跳转顶层（`allow-top-navigation`）、不能下载（`allow-downloads`）、不能进全屏 |

**服务端从不执行用户代码。** 服务端对 `app` 块只做三件事：存 `props.code`（有长度上限）、渲染时转义与包装、把它交给浏览器。所以「沙箱逃逸」在服务端这一侧没有攻击面 —— 用户代码根本不在服务器上跑。

### 6.2 通信白名单

宿主 → iframe：`{ type: 'init', props, inputs }`（`inputs` 是联动解析出来的只读值）。
iframe → 宿主，**只有这四种接受，其余一律丢弃并计数**：

| 消息 | 作用 | 限制 |
|---|---|---|
| `{type:'ready'}` | 握手成功 | watchdog 的依据 |
| `{type:'resize', height}` | 自适应高度 | `height` 必须是有界的数字（0…20000），否则丢弃 |
| `{type:'value', value}` | 把结果交给宿主（联动用） | `value` 必须是 JSON 可序列化且体积有上限 |
| `{type:'request', capability, payload}` | 申请能力（白名单里的少数几个） | 能力名不在白名单 → 拒绝并记一条审计 |

### 6.3 稳定性与限额

- **watchdog**：iframe 发出 `ready` 之前的时限（2 秒）内没到 → 降级为占位卡「此块运行失败」，并进 `warnings`。
- **消息频率上限**：宿主侧计数（200 条/秒），超了停止响应并降级 —— 防死循环把浏览器卡死。
- **体积上限**：`props.code` 与 `value` 都有长度上限；超了在保存时就 `bad_request`（不是等到渲染时）。
- **审计**：能力调用记日志（块 id、文档 id、能力名、时间）。

### 6.4 管理员禁用（FR-SANDBOX-08）

`documents.sandbox_disabled = 1`（仅 staff 可置）→ 该文档的所有沙箱块渲染为「沙箱已禁用」占位。管理后台不需要改页面：先有接口，UI 挂到既有 admin 页的一个按钮上。

### 6.5 落地说明（实现时定的细节）

| 项 | 定值 | 为什么 |
|---|---|---|
| 服务端拼文档 | `src/modules/doc/sandbox.js` 的 `buildSandboxDocument(code)` | 纯字符串拼接，不碰数据库、不碰网络 |
| iframe 属性 | `SANDBOX_IFRAME_ATTRS = 'sandbox="allow-scripts" loading="lazy" referrerpolicy="no-referrer"'` | `referrerpolicy` 顺手挡掉「沙箱页把当前文档 URL 当 referer 发出去」 |
| CSP | `SANDBOX_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'"` | 只放行内联，外联一条都不给 |
| `props.code` 上限 | `MAX_APP_CODE = 8000` | 超了**在保存时**就 400（见下） |
| 握手时限 | `SANDBOX_READY_MS = 2000` | 超时 → 占位「这个小应用运行失败了。」 |
| 消息频率 | `SANDBOX_MESSAGES_PER_SECOND = 200` | 超了 → 占位「发消息太频繁，已经停止运行。」 |
| 能力白名单 | `SANDBOX_CAPABILITIES = ['doc-meta']` | 第一版只给一个只读能力：文档自己的公开元信息 |
| 种进 iframe 的 API | `window.Sandbox = {props, inputs, request(), value(), resize(), onInit}` | 用户代码在文档里就用这个对象 |
| 接口 | `POST /api/docs/:id/capabilities`（登录用户，问的人是**访问者**）、`GET /api/docs/:id/capabilities`（仅 staff，审计）、`POST /api/docs/:id/sandbox`（仅 staff，逃生开关） | 见 §4.5 |

**为什么代码长度必须在保存时就拒，而不是靠 `coerceProps` 截断**：`coerceProps` 对超长字符串的策略是「截断 + 警告」，这对普通文本没问题；但对**代码**是危险行为 —— 用户会以为存进去了，跑起来却是半截程序，而错误现场离保存操作很远。所以 `store.serializeBlock()` 对 `app` 块单独检查 `props.code.length > MAX_APP_CODE` 并直接 400。

**前端宿主 `public/core/sandbox.js`** 承担 §6.2 / §6.3 的宿主一侧：按 `event.source` 认领消息（不看数据里自称的 id，否则两个 iframe 可以互相冒充）、2 秒看门狗、200 条/秒计数、`resize` 应用到 `iframe.style.height`、`request` 一律转发到服务端接口并在被拒时回一条 `{type:'capability', ok:false}`（不回的话沙箱里的 Promise 要悬 5 秒）。**前端不做任何本地放行判断** —— 前端放行等于没放行。

---

## 7. 内置模板

`src/modules/doc/templates.js` 定义 7 个模板，每个 = 一段块序列：

| key | 名字 | 结构 |
|---|---|---|
| `blank` | 空白 | 一个 `paragraph` |
| `page` | **Wiki 页面**（多页面的那一页） | 标题(`heading h1`) → 正文(`paragraph`) → 相关页面(`heading h2` + `wiki`) |
| `academic` | 学术笔记 | 标题 → 摘要(`quote`) → 一/二/三级标题 → 公式(`formula`) → 代码(`code`) → 参考文献(`list`) |
| `wiki` | **Wiki 词条**（优先） | 标题 → 摘要(`quote`) → 若干章节(`heading h2` + `paragraph`) → 词条互链(`wiki`) → **修订记录**(`heading h2` + 由 `document_revisions` 自动填充的 `list`) |
| `poll` | 投票问卷 | 说明 → 若干 `poll` 块 → 结果说明 |
| `datatable` | 数据表 | 标题 → `table` → 说明 |
| `lab` | 实验记录 | 目的 / 材料 / 步骤(`list`) / 观察(`table`) / 结论 |

> `page` 是**多页面 wiki 的那一页**，同时是「这一篇算 wiki 页」的机器标记：`/api/docs/wiki/:name` 只按 `template='page'` 找页（`templates.js` 的 `WIKI_TEMPLATE`）。不这么标记的话，一篇标题恰好同名的普通帖子会把 wiki 页顶掉。多页面 = 一堆 `page` 文档靠 `[[目标]]` 互链（§3.2 的 `wiki` 块渲染成指向 `#/wiki/<标题>` 的真链接）。

**Wiki 模板的「修订记录」**（FR-TPL-02）不靠用户手写：那个 `list` 块声明 `props.source = { kind: 'revisions', limit: 10 }`，渲染时从 `document_revisions` 取最近 10 条（版本号 + 时间 + 作者 + 变更原因）。这是把 §2.3 那张表用起来的第一处。

**套模板**（FR-TPL-04）：`POST /api/docs/:id/apply-template`，`mode='replace'` 时**先写一条 `reason='template'` 的快照**，再替换块序列。用户后悔了能回滚。

**导入导出往返**（验收标准 ⑤）：导出 `{format:'forum-doc/1', doc:{title,kind,scope,template}, blocks:[{blockId,type,version,props}]}`；导入时 `blockId` 全部重新分配（避免与目标文档冲突），**未知类型原样保留**（存得下、渲染成占位、再导出还是一样的 JSON）。

---

## 8. 笔记与个人主页接线（「甲」的核心）

### 8.1 笔记 —— `documents.kind = 'note'`

现状：`src/notes.js`（410 行）把笔记正文存在**文件系统** `data/notes/` 里（`safeDirName` / `readTextOrNull` / `readJsonFile` / `writeJsonFile`），发布到「笔记广场」（`publishNote` / `collectPublicNotes` / `listSquare` / `readSquareNote`）。

**只加不改**：

- `src/notes.js` 的既有函数与路由**一个都不删**（`notes-smoke` 44 项 + `check-notes-ui` 33 项守着它们）。
- 新增一个「文件笔记 → document」的惰性导入：读到一篇只在文件系统里、库里没有对应 document 的笔记时，**按需**建一条 `documents` 行（`reason='import'`，走 `markdownToBlocks`），下次就直接读库。
- `public/views/notes.js` 的「我的笔记 / 笔记广场」改成**优先读 documents**，读不到再退回旧的文件路径。

这就是需求文档 FR-DOC-03 的「迁移期允许无块的帖子存在，读取时按需惰性建块，不得要求一次性全量转换」。

### 8.2 个人主页 —— `documents.kind = 'profile'`

- 每个用户至多一份 profile 文档（在查询层保证；不做 `UNIQUE` 索引，因为软删过的行会占位）。
- `public/views/user.js` **优先渲染** profile 文档的块序列；没有则退回现在的 `bio` + 帖子列表。
- 个人主页置顶**直接复用现有的 `profile_pinned`**（§2.5 的锚点红利），不新建字段。

### 8.3 落地说明（S6 实际采用的形状）

**没有改 `src/notes.js`，也没有改 `src/server.js`。** 理由：`docs/skeleton.md` 底线 2「不改别人的文件」；而且「往 `createNotes` 注入 `docs`、在 `sessionFor` 里换读源」会动到 note-studio 的 8 条官方路由，`notes-smoke` 44 项全压在它们上面，风险远大于收益。所以走**前端优先 + 三条只读/幂等的新接口**：

- **第 6 张表 `note_documents(user_id, note_name, document_id, created_at)` + `UNIQUE(user_id, note_name)`**：把「谁的哪篇笔记」和文档 id 对上。**不给 `documents` 加列**，因为 `CREATE TABLE IF NOT EXISTS` 对已存在的表是空操作，加列得用 core 的 `ensureColumn`（那就是动 core）；新表则每次开库都会补建，老库也能长出来。
- **`POST /api/docs/notes/import`**（只导自己的笔记）：走 `markdownToBlocks` 建块、`reason='import'` 写修订、按 scope 建/同步影子行。**幂等** —— 块序列没变就不写修订（前端每次打开笔记都会调一次，否则 50 条上限当天被冲光）；标题/可见范围变了才补一条。
- **`GET /api/docs/notes/lookup?ownerId=&name=`、`GET /api/docs/profile/:username`**：都用 **200 + `{found:true|false}`** 而不是 404 —— 调用方拿它当「要不要退回老路径」的分支，404 在日志里会变成噪音。
- **客户端**：`public/views/notes.js` 的 `ntOpenNote` 先顺手 `import`（仅当看的是自己的笔记），再 `ntDocFor` 拿文档渲染，**任何一步失败都静默退回原来的文件路径**；`public/views/user.js` 拿 `hasProfileDoc` 决定主页正文用文档还是原来的「签名 + 帖子列表」。
- **`createDocument` 复用不了**：它硬写 `user_id = viewer.id`（`src/modules/doc/store.js`），而「笔记广场」里读别人笔记的人不是笔记主人，替他建文档会让影子行作者 / scope / 修订 author 全错位。所以导入走独立的 `importNote`。
- **顺手补的 `abilities.canView`**：`present()` 只在可见性检查之后调用，所以它恒为 `true`；加这一项是为了让前端的「拿不到就说看不见」守卫有个真字段可读（原来 `data.abilities.canView === false` 永远不成立）。

---

## 9. 实施步骤（每一步之后都必须全绿）

| 步 | 内容 | 这一步结束时的证据 | 状态 |
|---|---|---|---|
| **S1** | 数据层：4 张表 + 顶层 `schemas.addScript` + 影子行基础设施（系统板块 ensure / 建锚点 / 同步 / 随删） | 表建起来、`position` 是 REAL、`block_id` 文档内唯一、`ownedButNotRegistered` 为空、插 `1.5` 不重排后续块 | ✅ |
| **S2** | 块引擎纯函数层：注册表 / 12 类型 / `validateProps` / `renderBlock` 降级 / `blocksToMarkdown` + `markdownToBlocks` 往返 / `bind` 拓扑解析 | 往返属性测试 100 篇幂等；环检测降级不挂；未注册类型出占位卡 | ✅ |
| **S3** | 接口：`/api/docs/*` 全套 + 权限矩阵 + 影子行联动 | `scripts/doc-smoke.mjs` 全绿；401/404 矩阵逐条断言 | ✅ |
| **S4** | 前端：`public/views/doc.js` + `doc-blocks.js` + `public/css/41-doc.css` + 三行注册 | `check-frontend` 多渲染出 4 个页面（`#/docs`、`#/doc/:id`、`/edit`、`/blocks`）；`public/app.js` 仍是 44 行 | ✅ |
| **S5** | 沙箱：`app` 块 iframe 渲染 + 消息白名单 + watchdog + 限额 + 管理员禁用 + 第 5 张表 `doc_capability_logs` | 一个真能跑的自定义块；一个死循环块被 watchdog 降级；`default-src 'none'` 断言 | ✅ |
| **S6** | 接线：笔记（惰性导入 + 视图优先读库）、个人主页（优先渲染 profile 文档） | 旧的 44 + 33 项笔记测试全绿（证明没删旧路） | ✅ |
| **S7** | 哨兵与文档：`check-encoding` 的 `REQUIRED_FILES`/`MIN_CHECKED`、`check-ui-contract` 的 `MIN_UI_CHECKS`、`docs/skeleton.md` 表归属表、README 接口清单 | 15 组全绿 | ✅ |

**每完成一步就跑全套 15 组**，不许攒着跑。

---

## 10. 测试策略（TDD）

**新增：`scripts/doc-smoke.mjs`**（照抄 `scripts/smoke.mjs` 的结构，**不许用 `node --test`** —— 在 Windows 沙箱里会 EPERM）。覆盖：

1. **表结构**：4 张表存在、列类型正确、`UNIQUE(document_id, block_id)` 真的生效（插重复 `block_id` 必须失败）。
2. **`position` REAL**：插到 1 与 2 之间写 `1.5`，断言后续块的 `position` **一个都没变**。
3. **降级**：未注册类型 / 坏 JSON / 非法 props / 引用缺失 → 占位卡 + `warnings` 各一条。
4. **Markdown 往返**：100 篇样例 `blocks(md(x)) == blocks(x)`。
5. **契约对拍**：doc 注册表前 7 类名与顺序 `=== note-agent/src/blocks.mjs` 的 `BLOCK_TYPES`；两边 `blocksToMarkdown()` 对固定样例逐字节相同。
6. **op 语义**：`applyOps` 不抛异常、不改入参（沿用 note-agent 的铁律）。
7. **导入导出往返**：导出再导入，块序列（类型 + props）完全相同。
8. **权限矩阵**：四种 scope ×（作者 / 关注者 / 同队 / 外人 / staff / 未登录）逐格断言 200 / 401 / 404。
9. **影子行**：建文档后 `posts` 多一行且 `board_id` 是系统板块；赞/踩/投币/收藏**真的能通过 core 既有接口操作 `anchor_post_id`**；`private` 文档的锚点 `hidden=1` 且不出现在 `/api/posts` 里。
10. **模板**：套 `wiki` 模板得到的块序列含「修订记录」块；`replace` 模式确实先存了快照。
11. **沙箱护栏**：`srcdoc` 里含 `default-src 'none'` 且 `sandbox` 属性**不含** `allow-same-origin`。

**哨兵必须同步更新**（否则测试会静默变绿）：

- `scripts/check-encoding.mjs` 的 `REQUIRED_FILES` 加新文件、`MIN_CHECKED` 从 162 提到新值。
- `scripts/check-ui-contract.mjs` 的 `MIN_UI_CHECKS` 从 200 提到新值。
- `scripts/check-frontend.mjs` 的页面清单加新页面。

**`check-golden` 红了绝对不许用 `--write` 修** —— 它红了就意味着我们改了对外行为。

---

## 11. 风险与待确认

| 风险 | 影响 | 处置 |
|---|---|---|
| 影子行必然出现在旧帖子列表里 | 个人主页「帖子」栏、搜索会多出积木帖子的行 | 这是「复用互动锚点」的固有代价；`public` 文档同步标题与摘要让它**体面**，非公开的 `hidden=1` 不出现 |
| **非公开文档别人点不了赞**（§2.5） | `followers`/`team` 档的互动缺失 | 登记为已知短板；要修得动 core，留后续轮次 |
| 笔记接线要碰 `src/notes.js` 与 `public/views/notes.js` | 44 + 33 项既有测试可能变红 | **只加不删**；每一步先跑基线，红了的当步修 |
| 沙箱是客户端隔离 | 不是服务端安全边界 | 用户代码永不在服务器执行（§6.1）；这是设计选择，不是遗漏 |
| `public/app.js` 必须保持 44 行 | 入口膨胀 | 新视图全部走 `public/views/doc*.js`；`check-skeleton` 会查行数 |
| 四张表 + 五个新类型 + 沙箱 + 两处接线，一轮做完偏大 | 交付周期 | 按 §9 分 7 步，**每步都可停下来看**；S1+S2+S3 就能先给你一个能建能读的积木帖子 |

**待确认：**

1. §2.5 那个代价（非公开文档别人点不了赞）**接受还是走备选**？
2. 笔记接线会碰 `src/notes.js`（只加不改）+ `public/views/notes.js`，你确认吗？
3. 个人主页做 `documents.kind='profile'` 而不是新建一张 profile 表 —— 同意吗？
4. `doc_block_types` 是**全局注册表**（一个人注册的类型所有人可用）。是「登录用户都能注册」（贴合 FR-BLOCK-04 的「第三方可注册」）还是「只有 staff 能注册」（更好管）？我倾向先开放 + 记名 + 管理后台能撤，用起来再收紧。

---

## 12. 验收清单

对照 P2 开工说明的 12 条验收标准：

| # | 标准 | 落在哪 |
|---|---|---|
| ① | 两张表通过 `schemas.addScript` 登记建起 | §2.1 §2.2 · S1 |
| ② | `position` 是 REAL，插到 1 和 2 之间写 1.5 且不重排后续块 | §2.2 · S1 · 测试 2 |
| ③ | 块有类型字段，能表示 文字/Wiki/外链表/投票/小程序 | §3.1（12 类型：`paragraph` `wiki` `embed` `poll` `app`） |
| ④ | 块之间能联动，一块的值能被另一块读到 | §3.3③ · S2 · 测试 3 |
| ⑤ | 能导入导出整个文档，JSON 往返不丢信息 | §4.4 §7 · 测试 7 |
| ⑥ | 「编辑」= 现有 LaTeX 实时预览 + AI 抽屉 | §5.1 |
| ⑦ | 「高级编辑」能写小块逻辑，**必须跑在沙箱里** | §5.1 §6 |
| ⑧ | Wiki 内置模板一键套用 | §7 |
| ⑨ | 个人主页也能用可编程帖子 | §8.2 |
| ⑩ | tag / 点赞 / 投币全部保留，价值分公式一字不改 | §2.5（影子行让 core 链路零改动） |
| ⑪ | 未登录访问返回 401 而不是 404 | §2.6 §4.5 · 测试 8 |
| ⑫ | `doc-smoke` 全绿且 `check-golden`/`check-skeleton`/`smoke` 都绿 | §9 S7 · §10 |

对照需求文档额外的功能项：

| 需求 | 落在哪 |
|---|---|
| FR-DOC-01 帖子本体持有块序列 | §2.2（`document_blocks` 一行一个块） |
| FR-DOC-02 双向同步 `posts.content` ⇄ 块序列 | §4.3（`PUT/GET /api/docs/:id/markdown`）+ §2.5（锚点摘要同步） |
| FR-DOC-03 惰性建块，不全量转换 | §8.1 |
| FR-BLOCK-04 不改核心代码注册新类型 | §2.4 `doc_block_types` + §4.4 |
| FR-BLOCK-05 未知类型优雅降级 | §3.3① |
| FR-BLOCK-06 类型版本与 props 校验可观测 | §2.2 `type_version` + §3.3① 的 `warnings[]` |
| FR-BLOCK-07 块间联动 | §3.3③ |
| FR-BLOCK-09 Markdown → 块 | §3.3② |
| FR-EDIT-08 撤销/重做/回滚 | §2.3 + §5.2 |
| FR-TPL-02 Wiki 修订记录 | §2.3 + §7 |
| FR-TPL-04 套模板要提示 | §7（`replace` 先存快照） |
| FR-SANDBOX-08 管理员可禁用 | §6.4 |
| FR-PROFILE 个人主页 | §8.2 |
| FR-KEEP-* 互动全保留 | §2.5 |

---

## 13. 交付验收（用户点名的五件事）

用户给出的**交付线**是五条具体能演示的事，不是抽象标准。§9 的 S1–S7 全部 ✅ 之后，
逐条对照补的洞与对应测试（都在 `scripts/doc-smoke.mjs` 的 `【S8】交付验收` 段，325 项里的 38 项）：

| # | 用户要的 | 原来缺什么 | 补成什么样 | 测试 |
|---|---|---|---|---|
| ① | 给出**可编程帖子的编程逻辑**——怎么自己编一个块 | `renderer_json` 存得进库，**却没有任何代码读它**：注册出来的类型永远渲染成「字段名→值」的表，「注册一个块类型」是句空话 | `registry.js` 的 `genericHtml` 读 `renderer_json.html`，`{{字段}}` 一律转义；模板本身过 `sanitizeTemplate()`（剥 `<script>` / 内联事件 / `javascript:`——注册是登录用户就能做的，模板会出现在每个访客的页面上）。`#/blocks` 加「怎么自己编一个块」指南：两条路（声明式模板 / 沙箱代码）+ 沙箱能用的全部 API 片段 + 块的底层形状 | 8.1（注册→加块→按模板渲染、危险构造被剥、沙箱型真给 iframe） |
| ② | 从模板**拉出一个投票块**，并能**显示、编辑源码** | 编辑器只有 schema 表单，`bind`、自定义类型的 `config`、多出来的选项字段**在界面上根本没有入口**（S2 测过 `coerceProps` 保留 `bind`，但用户存不进去） | `doc-blocks.js` 的 `sourceHtml(block)`：每块一张「源码（props JSON）」折叠框 + `readSource()`；按钮 `data-doc-action="source-save"` 走同一条 `PUT /api/docs/:id/blocks/:blockId`。坏 JSON 报人话、不清空 | 8.2（poll 模板有投票块、源码改得动、写坏只降级不 500） |
| ③ | 从模板**重拉一个可编辑的 wiki 模板**，能**多页面编辑** | `wiki` 块只渲染成 `<a>` 标签，**没有 href、点了什么也不会发生**；没有任何「这一篇是 wiki 页」的概念 | 新增 `page` 模板（= 多页面的一页，同时是 `WIKI_TEMPLATE='page'` 这个机器标记）；`wiki` 块渲染出真 `href="#/wiki/<标题>"`；`GET/POST /api/docs/wiki/:name` 找页/建页（看不见与不存在都回 `found:false`，不泄漏存在性）；前端 `#/wiki/:name` 路由 + 「建这一页」 | 8.3（建页/幂等/匿名可读/私有不泄漏/href/匿名建页 401） |
| ④ | **不用模板**从零开始用编程写出一个功能 | 路径本身是通的（`blank` + 「插入一块」选 `app`），但没有证据；自定义沙箱类型又是空的（同 ①） | `isSandboxType()` 改成既认 `app` 也认 `renderer_kind:'sandbox'`；`sandboxInner` 的标题回落到 `props.title/label`；`genericHtml` 把沙箱类型交给同一间玻璃房。测试真的走一遍「blank → PUT markdown → POST 一块 poll」 | 8.2 末两条 + 8.1（`s8clock` 沙箱型自定义块） |
| ⑤ | 用回**原本的 markdown + LaTeX** 简单编辑 | 编辑器只有积木模式一栏，**没有 Markdown 模式的实时预览、没有 AI 抽屉、没有 `/blocks` 入口**（§5.1 当时没落地） | 见 §5.4：Markdown 模式是两栏（左 textarea 带 `name="content"`、右 `.doc-md-preview`）+ 400ms 防抖打 `POST /api/markdown/preview`（LaTeX 在这一层渲染）+ `window.NotesAgent.attach()` | 8.4（PUT/GET markdown 往返、`$$` 已渲染、`/api/markdown/preview` 可用） |

**一条教训（写在这里免得重踩）**：`core/handler.js:71` 是拿 `url.pathname` 直接跑路由正则的，**路径参数不会自动百分号解码**。第一版 `/api/docs/wiki/:name` 因此把标题存成了 `S8%20%E6%80%BB%E8%A7%88%E9%A1%B5`——而前端按 `encodeURIComponent(title)` 去查又是同一个编码串，两边「自洽」地错着，只有人眼看列表才发现标题是乱码。`readWikiName()` 里补了一次 `decodeURIComponent`（解坏了原样用）。**新加带非 ASCII 的路径参数时要记得自己解码。**

### 13.1 演示时暴露出来的两处「看着像坏了」

跑通五条之后拿真数据看了一遍，发现两个不报错、但用户一眼就会觉得坏掉的地方，都补了：

1. **双链只认独占一行**。`markdown.js` 的 `WIKI = /^\[\[…\]\]$/` 要求整行就是一条双链（这样才会解析成 `wiki` 块）。于是 `下一站：[[某页]]。` 里的那条**连显示都不显示成链接**，就是一段 `[[某页]]` 原文 —— 用户在句子里写双链是再自然不过的事。
   补法：`blocks/text.js` 新增 `escapeHtmlWithWikiLinks(value, { multiline })`，`paragraph` / `list` / `quote` 三个散文块改用它。**顺序不能反**：先 `escapeHtml` 再替换的话，标题里的 `&` 会变成 `&amp;`，`encodeURIComponent` 之后就是 `%26amp%3B`，链接直接指到不存在的页 —— 所以这个函数对**原文**切片，链接之外的片段照常转义，目标与显示字各自转义。
2. **积木页里的公式是一行源码**。`renderMarkdown` 从不排公式（整个站点的数学都在客户端排），而积木的两个视图（阅读视图、Markdown 实时预览）都没调那一步，所以 `$E=mc^2$` 就那么原样躺着。
   补法：`public/views/doc.js` 从 `./notes.js` 引入站点原本的 `ntRenderMath`，在阅读视图渲染完之后调 `ntRenderMath($('.doc-body'))`、在 Markdown 预览 `innerHTML` 之后调 `ntRenderMath(box)` —— 与 `views/timeline.js` 同一个助手（离线 KaTeX，`/notes/vendor/katex/**` 是公开资源，见 `src/notes.js:378`），**没有第二份数学渲染实现**。渲染必须在 `innerHTML` 之后，`renderMathInElement` 只处理已经在 DOM 里的节点。
3. **`formula` 块本来就是一行公式源码**。`types.js` 的 `formula.toHtml` 只吐 `<span class="doc-formula-src">…裸 LaTeX…</span>`，而 `renderMathInElement` 只认带定界符的文本节点 —— 一个叫「公式」的块，读者看到的是等宽字体里的 `\int_0^1`。
   补法：`toHtml` 改成 `<div class="doc-formula-render">$$…$$</div>` + 一个折叠的 `<details class="doc-formula-src-wrap">` 装源码。定界符必须从服务端发出来（客户端数学渲染是全局约定，见上一条）；源码留一份是给「KaTeX 不支持这个环境」时的退路。**别把定界符叠成 `$$$$`**：块里自己写了 `$$…$$` 时先走 `unwrapFormula` 剥一层（note-agent 的既有约定），`doc-smoke` 2.3b 有断言盯着。

---

## 14. 用户实测后的五条 bug（第二轮）

§13 的五条交付线走通之后，用户在真服务上手点了一遍，回了五条（其中第 4 条把性质说透了）：

| # | 用户原话 | 根因 | 落地 |
|---|---|---|---|
| ① | 「投票页不能点投票」 | `blocks/types.js` 的 `poll.toHtml` 把票数**写死成 0**：没有接口、没有点击处理，页面上是一排看不出能点的选项 | 票落 `doc_poll_votes`（主键 `(document_id, block_id, option_id, user_id)`）；`GET /api/docs/:id/polls` 读、`POST …/vote` 写；选项渲染成真 `<button role="radio/checkbox">`；前端 `paintPollCard` 只填数字与 `aria-checked` |
| ② | 「自定义编程页的警告渲染失效」 | 块降级的提示是**服务端**在 `blocks/html.js` 里拼的 `class="doc-block-warning"`，而 `check-ui-contract` 的「类名都要有 CSS」只扫 `public/` —— 这条检查逻辑上永远检查不到服务端拼出来的类 | 补 `.doc-block-warning / .doc-block-tpl / .doc-block-fields / .doc-poll-hint` 四条规则；`check-ui-contract` 加了一段**扫 `src/modules/doc/**` 里 `class="…"` 字面量**的断言（拼接出来的名字跳过），`MIN_UI_CHECKS` 207 → 210 |
| ③ | 「wiki 页并不是正常 wiki 的样子，没有边栏提供分类，只是单纯带链接的页而已」 | `/api/docs/wiki/:name` 只回一页正文，没有页面清单也没有分类 —— 「wiki」退化成一页带链接的普通帖子 | 新表 `doc_wiki_pages`（分类 + 排序）；`GET /api/docs/wiki` 出目录；`PUT /api/docs/:id/wiki` 定分类；`wikiNav()` 随页面一起回，`#/wiki/:name` 与 `#/doc/:id` **两个入口都有边栏**；前端两栏布局 + 分类分组 + 页内筛选 + 新建页 |
| ④ | 「编程自由度不够」→ 追问后定性：「你的编程的主语言 json 本质只是数据整理用的语言，而不是真正能写功能的语言」 | 沙箱只有一个只读 `doc-meta`，**没有任何持久化** —— 能算，但存不下东西，于是「写功能」只能靠模板拼字符串 | 能力白名单扩成 `doc-meta / doc-blocks / viewer / state`；新表 `doc_app_state`（`user` 各人一份 / `shared` 全站一份，写下要登录）；`Sandbox` 加 `doc()` / `blocks()` / `viewer()` / `state.get/set()`；`MAX_APP_CODE` 8000 → 20000；编辑器给代码字段专用高框 + `STARTER_CODE` 能跑的最小示例 |
| ⑤ | 「新建积木帖子不仅 UI 不好看而且很混乱，难以看懂操作」 | 新建面板是一个标题框 + 一个模板下拉框；进编辑器之后是「插入块」的密集表单，没有说明哪一步该做什么（库里还留着用户试出来的半成品：`template` 与 `title` 都是空串、只有一块 poll） | 新建面板改成**三步向导 + 模板卡片**（带模板说明，选中的写进隐藏框——`formValues()` 按 `[name]` 遍历，radio 只会取到最后一个）；编辑器开头加「积木模式：四步」说明卡；每块**底部**再放一个「保存本块」（表单一长，顶上那个就滚出屏幕了）；联动从摊开的输入框收进默认折叠的 `<details>` |

### 14.1 一条原则：运行期数据不写回 `props`

①②④ 都碰到同一个岔路：票数、沙箱状态要不要顺手写进块的 `props`？

**不写。** `props` 是**内容**：改一次产生一条修订、导出/回滚都以它为准。把运行期数据混进去，等于「作者改一个选项 = 改掉所有人投的票」「回滚一次 = 抹掉所有人的打卡」。所以票进 `doc_poll_votes`、状态进 `doc_app_state`，两者都在块/文档被删时顺带清理（`reconcilePollVotes` / `reconcileAppState`），不留孤儿行。

### 14.2 三条踩过的坑（写在这里免得重踩）

1. **`DOC_SCHEMA` 内部不能出现反引号**。`export const DOC_SCHEMA = \`…\`` 整段是模板字符串，注释里写 `` `Sandbox.state` `` 会当场 `SyntaxError: Unexpected identifier`，服务器 20 秒起不来（表现为 `doc-smoke` 0 项、`check-ui-contract` 只跑到 61 项）。**这是第二次踩**，第一次是 `` `documents WHERE template='page'` ``。
2. **`wikiNav()` 必须在 SQL 里就过一遍可见范围**。第一版 `listWikiPages()` 只 `SELECT d.id, d.title, …`，没有 `d.scope` / `d.user_id`；调用方再 `canView(row, viewer)` 时 `row.scope` 是 `undefined`，于是**每一页都被滤掉** —— 症状是管理员看得见目录、访客的边栏是空的（看着像前端没渲染，其实是查询少了两列）。现在两件事都做：SQL 里走 `visibilityConditions`，回来再 `canView` 复核。
3. **`grid` / `flex` 会压过 `hidden` 属性**。边栏的页内筛选靠 `[hidden]`，而 `display: grid` 的容器里那个属性不再生效，必须显式补 `.doc-wiki-nav-link[hidden] { display: none; }`（`check-ui-contract` 有断言盯着这一条）。

### 14.3 沙箱 API（`Sandbox`，全部在 iframe 里）

| 调用 | 作用 | 服务端能力 |
|---|---|---|
| `Sandbox.props` / `Sandbox.inputs` | 这一块的 props、页面输入 | 无（宿主直接递进来的） |
| `Sandbox.value(v)` / `Sandbox.resize()` | 把值交回宿主 / 按内容调高 iframe | 无（消息白名单里的 `value` / `resize`） |
| `await Sandbox.doc()` | 文档元信息 `{ id, title, kind, author, updatedAt }` | `doc-meta` |
| `await Sandbox.blocks()` | 正文里每一块 `{ id, type, props }` | `doc-blocks` |
| `await Sandbox.viewer()` | 正在看的人 `{ loggedIn, id, username, displayName, staff }` | `viewer` |
| `await Sandbox.state.get(scope)` | 读持久状态（默认 `'user'`） | `state` |
| `await Sandbox.state.set(v, scope)` | 写持久状态（要登录） | `state` |
| `await Sandbox.request(capability, payload)` | 上面每一条的底层形式 | 白名单 |

**成功时 resolve 的就是值本身，失败才 reject** —— 不要写 `if (r.ok)`（`#/blocks` 的指南里原来就是那么教的，已改）。
