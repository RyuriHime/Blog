# 把「AI 阅读助手」合并进你现在的论坛（不改你的业务代码）

> 目标：在你**已经更新过的那版论坛**（带转发 / 私信 / 黑名单 / 头像 / 三级角色 / 主题的那版）上加 AI 功能，
> **不需要**回退版本，**不需要**替换 `src/server.js`，**不需要**动你的路由表。

## 一句话原理

AI 部分被封装成一个**自包含挂载层** `forum-ai/src/mount.mjs`。它自己接管 `/api/ai/*` 路径，
把其它请求原样交还给你的 server，所以它对你代码的全部侵入是**两行**：

```js
import { mountForumAi } from './forum-ai/src/mount.mjs';   // ① 顶部 import
mountForumAi({ db, resolveUser }).attach(server);          // ② 建完 server 之后调用一次
```

只有一个前提：`db` 是**你已经在用的那个 `node:sqlite` 连接**，`resolveUser` 是**你 `server.js` 里已有的那个函数**
（返回 `{ user }`，`user` 里带 `id` / `role`）。

---

## 一、最小合并步骤（5 分钟）

假设你的目录长这样：

```
your-forum/
├── src/server.js          ← 你要改的只有这一个文件（加 2 行）
├── src/store.js
├── public/
└── forum-ai/              ← 把这个目录整个拷进来
```

### 第 1 步：拷目录

把交付包里的 `forum-ai/` 整个拷到你的论坛根目录（和 `src/` 平级）。

### 第 2 步：改 `src/server.js`，加两行

```js
// ① 顶部，和你已有的 import 放一起
import { mountForumAi } from '../forum-ai/src/mount.mjs';

// ……你原来的代码全部不动……

const server = http.createServer(async (req, res) => {
  // ……你原来的整段请求处理逻辑，一个字都不用改……
});

// ② 在 server.listen(...) 之前，挂上 AI
mountForumAi({
  db,                 // 你已有的 node:sqlite 连接
  resolveUser,        // 你已有的会话解析函数（名字不同就换成你的）
  quiet: false,       // 想在启动日志里看到挂载信息就设 false
}).attach(server);

server.listen(PORT, HOST, () => { /* 你原来的启动日志 */ });
```

**就这样，AI 的 8 个接口已经可用了。** 不需要改路由表、不需要改数据层、不需要建表（挂载层会自己建它的 `ai_*` 表，用
`CREATE TABLE IF NOT EXISTS`，只增不改）。

### 第 3 步：验证（不用配 AI key 也能验一半）

```bash
# 3.1 AI 路由挂上了（未登录应该是 401，不是 404）
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3000/api/ai/posts/analyze-pending
# 期望 401

# 3.2 状态接口
curl -s http://127.0.0.1:3000/api/ai/status
# 期望 {"ok":true,"data":{"configured":false,...}}（没配 key 时 configured=false）

# 3.3 你自己的接口没被影响
curl -s http://127.0.0.1:3000/api/site | head -c 120
curl -s http://127.0.0.1:3000/api/posts | head -c 120
```

配好 key 之后（`AI_API_KEY` 等环境变量，或宿主的 `.env` 机制）：

```bash
# 3.4 解读一篇（id 换成你库里真实的帖子 id；需要先登录拿 cookie）
curl -s -b cookie.txt -X POST http://127.0.0.1:3000/api/ai/posts/2/analyze | head -c 300
# 期望 200，data.review 里有 category / difficulty / summary / tags / prereq / recommend
```

---

## 二、挂载层对你数据做了什么（读什么、写什么）

**只读**以下表（按表名/列名探测，缺列会自动降级，不会报错）：

| 读什么 | 用途 |
| --- | --- |
| `posts.id / title / content / board_id / user_id / created_at / updated_at / deleted` | 语料正文（`deleted=1` 自动排除） |
| `replies.post_id / content / user_id / created_at / deleted` | 回复一起进语料 |
| `boards.name` | 材料里标注板块 |
| `users.display_name` | 材料里标注作者 |

**只写**自己前缀的表（可配置 `tablePrefix`，默认 `ai_`）：

| 表 | 用途 |
| --- | --- |
| `ai_document_reviews` | 每篇的解读缓存（含语料指纹、token 用量、失败原因） |
| `ai_corpus_reports` | 全站整理的历史报告（取最新一份） |
| `ai_corpus_index` | 语料索引（标题/正文/回复快照），用来算指纹和检索 |

> **不会**给你的 `posts` / `users` 等表加任何列，也不会改任何现有行的数据。
> 另外它**不走你的 store.js**，直接用传进来的 `db` 连接查询，所以你的数据层不用改。

---

## 三、接口清单

| 方法 | 路径 | 说明 | 权限 |
| --- | --- | --- | --- |
| GET | `/api/ai/status` | AI 是否已配置（不回传密钥） | 公开 |
| GET | `/api/ai/posts/:id` | 读取缓存解读 + 是否过期 | 公开 |
| POST | `/api/ai/posts/:id/analyze` | 生成/刷新单篇解读 | 登录 |
| POST | `/api/ai/posts/analyze-pending` | 批量解读待整理，`{ limit ≤ 50 }` | 管理员 |
| GET | `/api/ai/site` | 全站整理结果 + 主题分组 + 阅读路线 + 统计 | 登录 |
| POST | `/api/ai/site/analyze` | 重新整理全站 | 管理员 |
| DELETE | `/api/ai/site` | 清空整理缓存 | 管理员 |
| DELETE | `/api/ai/cache` | 清空解读与整理缓存 | 管理员 |
| POST | `/api/ai/ask` | 问答，`{ question, postId? }` | 登录 |
| GET/POST | `/api/ai/documents/...` | 同上，只是用通用包的 `document` 命名 | 同上 |

响应格式与你的站点一致：成功 `{ ok: true, data }`，失败 `{ ok: false, error: { code, message } }`。

权限判断用的是 `user.role`：**`admin` 与 `owner` 都算管理员**（所以你那版的三级角色能直接用）。

---

## 四、前端怎么接（这部分和框架耦合，需要你抄代码）

后端接口是通用的，但 `#/ai` 页面和帖子页的 AI 区块是在**我这个仓库的前端**里写的，用的是我的 SPA 路由与 CSS 变量。
合并方式：把下面这些**整段抄**到你的 `public/app.js` / `public/style.css`。

| 从哪抄 | 抄什么 | 对应界面 |
| --- | --- | --- |
| `public/app.js` | `viewAI()` | `#/ai` 页：全站知识地图、主题分组、推荐阅读路线、逐篇分类清单、问全站 |
| `public/app.js` | `aiPostPanelHtml()` / `aiReviewCardHtml()` / `aiAnswerHtml()` / `aiAskFormHtml()` / `aiChip()` / `aiConfigured()` / `aiNoticeHtml()` / `aiIdOf()` | 帖子详情页的「🤖 AI 阅读助手」区块（解读 / 前置知识 / 推荐阅读 / 就这篇提问） |
| `public/app.js` | `case 'ai-analyze'` / `case 'ai-analyze-pending'` / `case 'ai-site-analyze'`（点击分发里）与 `if (action === 'ai-ask')`（表单分发里） | 三个按钮 + 问答表单的交互 |
| `public/app.js` | 路由表里加 `if (first === 'ai') return await viewAI();` | `#/ai` 能访问 |
| `public/app.js` | 侧栏加 `<a class="side-link" href="#/ai">🤖 AI 阅读助手</a>` | 入口 |
| `public/app.js` | `viewPost()` 里 `Promise.all` 多取一次 `/api/ai/posts/${id}`，并把 `${aiPostPanelHtml(post, aiInfo)}` 插进正文之后 | 帖子页 AI 区块的数据 |
| `public/style.css` | 文件末尾「AI 阅读助手」整段（约 150 行，`.ai-panel / .ai-chip / .ai-answer ...`） | 样式 |

**字段名兼容**：接口同时给 `postId` 和 `documentId`，前端用 `aiIdOf()` 取任一即可；你照抄就不会踩坑。

---

## 五、合并后的验收清单

| # | 检查 | 命令 / 位置 | 期望 |
| --- | --- | --- | --- |
| 1 | 你原有接口没坏 | `curl /api/site`、`/api/posts`、`/api/ai/...` 之外的任意接口 | 和合并前一致 |
| 2 | AI 路由挂上 | `POST /api/ai/posts/analyze-pending` 未登录 | 401（不是 404） |
| 3 | 语料读到了 | 登录后 `GET /api/ai/site` → `stats.corpus.documents` | 等于你库里未删除帖子数 |
| 4 | 解读可用 | 帖子页点「✨ 解读这篇」 | 出现分类/难度/摘要/标签/前置知识/推荐阅读 |
| 5 | 推荐不是空的 | 同上，看「📚 推荐阅读」 | 至少 1 条指向站内帖子 |
| 6 | 幻觉编号被挡 | 同上 | 编造的编号显示为纯文本（无链接），不是死链 |
| 7 | 全站整理 | `#/ai` 点「🧭 重新整理全站」 | 出主题分组 + 阅读路线 |
| 8 | 问答带引用 | `#/ai` 问一句 | 回答 + 引用出处 + 置信度 |
| 9 | 未配 key 的降级 | 清空 `AI_API_KEY` 重启后调接口 | 503 `ai_not_configured`，论坛其它功能正常 |
| 10 | 你的表没被改 | `PRAGMA table_info(posts)` | 没有 `ai_` 开头的列 |

## 六、回归测试（可以在合并后直接跑）

交付包里带了 34 项**挂载层集成测试**，它起一个极简宿主（只有 `posts`/`replies` 表）来验证挂载行为，
不需要真密钥（自带假 AI 服务）：

```bash
node forum-ai/selftest-mount.mjs      # 34 项：宿主不受影响 / 路由挂载 / 语料读取 / 解读 / 权限 / 降级 / 清缓存
node forum-ai/selftest.mjs            # 92 项：能力层本身（含 JSON 容错、幻觉过滤、缓存过期）
```

两个都应该是 `失败 0 项`。这两个测试**不会碰你的数据库**（用内存库），可以放心在服务器上跑。

---

## 七、常见问题

**Q：`resolveUser` 在我那边不叫这个名字？**
传你的那个函数就行，签名要求只有一条：`(req) => ({ user })` 或 `(req) => user`，异步也可以。
如果你的 `resolveUser` 只返回 `user` 对象，包一层：`resolveUser: async (req) => ({ user: yourResolve(req) })`。

**Q：我的帖子内容不在 `posts.content` 里？**
`mount.mjs` 的 `createForumDocumentSource()` 就是「宿主数据 → 文档数组」的适配点，
它是导出的，你可以自己写一个 `documentSource` 传进 `createAiStore`，不需要改包。

**Q：挂载会不会抢我的路由？**
只在 `pathname` 等于 `/api/ai/status` 或以 `/api/ai/` 开头时短路，其它请求**原样**交给你的 listener。
前缀可以改：`mountForumAi({ ..., basePath: '/api/assistant' })`。

**Q：表和我不在一个库里？**
`db` 传哪个连接，AI 表就建在哪个库里；语料也从同一个连接读。

**Q：性能影响？**
挂载层只在 AI 路径上工作，普通请求只多一次字符串前缀判断。语料检索与入库都在 AI 调用时发生。
