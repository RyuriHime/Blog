# 格社：格万物之理，聚同好之言

> 一个可以真正跑起来的论坛网站。

零依赖的全栈论坛：**后端 Node 内置 `http` + `node:sqlite`，前端原生 JS，没有 `npm install`，没有构建步骤**。
克隆下来一条命令就能访问，界面是深色现代风格，功能覆盖一个社区论坛该有的完整闭环。

```
├── 板块分区 ── 5 个预置板块（技术交流 / 问答求助 / 分享创造 / 综合讨论 / 站务公告）
├── 账号体系 ── 注册、登录、会话保持（HttpOnly Cookie + scrypt 密码哈希）
├── 账号设置 ── 修改头像、昵称、个性签名、修改密码（改密后其它设备强制下线）
├── 内容发布 ── 发帖 / 编辑 / 删除，Markdown 渲染 + 实时预览，@提及
├── 讨论互动 ── 回复、置顶、锁定
├── 文章评价 ── 👍 点赞 / 👎 踩（互斥）+ ⭐ 收藏
├── 转发分享 ── 🔁 带评语转发到自己的主页（帖子）或动态流（动态），可撤销、可复制链接，原作者收到通知
├── 个人主页 ── 作者自建分类、列表/卡片/紧凑三种排版、置顶推荐（最多 3 篇）、转发列表
├── 关注关系 ── 关注作者，首页「我关注的」只看 TA 们的帖子
├── 私信 ── ✉️ 互相关注不限量；单方面关注每天 1 条；未关注需先关注
├── 黑名单 ── 🚫 被拉黑者无法关注 / 私信 / 查看我的文章，双向内容互不可见
├── 消息通知 ── 回复 / 点赞 / 踩 / 转发 / 关注 / @提及 / 关注的人发新帖 / 管理操作 / 团队公告
├── 背景主题 ── 🎨 暗夜 / 极夜 / 明亮 / 暖阳 / 奶黄 / 森林 / 暮紫 + 跟随系统，选择记在本地
├── 个性头像 ── 🖼️ 12 个预设表情或上传图片（客户端压缩、服务端校验落盘）
├── 角色权限 ── 👑 站长（唯一，可任命管理员）/ 🛡️ 管理员 / 成员，三级权限
├── 团队 ── 🎽 团队广场与团队主页：成员名单、团长任命管理员 / 踢人、**加入方式（谁都能加入 / 需要申请）与加入审核**、**可以把团队从广场藏起来**、**6 位团队号凭号加入**、成员只能编辑自己发的帖（`canEdit` 绑作者本人，管理员也不行）、改自己的帖不静默覆盖（版本号 + 冲突提示）、每篇帖都有「💬 回复」
├── 团队帖 ── 📄 帖子点得进独立详情页（`#/team/<slug>/post/<id>`），帖子下面能回复、能删自己的回复，正文与回复都支持 Markdown + LaTeX 公式
├── 团队空间 ── 📢 团队公告（团长 / 管理员可改，保存后全队各收一条通知）+ 📁 文件柜（成员上传下载，单文件 4 MB，一律按附件下发）+ 🗨️ 群聊（5 秒增量拉取），未登录 401、非成员 403
├── 内容管理 ── 管理团队可**隐藏**（可逆，访客 404）或**删除**任何文章，全程留痕
├── 检索导航 ── 全文搜索、最新/最新回复/最热三种排序、分页
└── 管理后台 ── 数据看板、任命管理员、隐藏/删除文章、封禁用户、审计日志
```

---

## 0. 这个仓库里有什么

论坛本体 + 三个**互相独立**的扩展包。少装任何一个，其余部分照常跑。

| 目录 | 是什么 | 版本 | 单独验一下 |
| --- | --- | --- | --- |
| `src/` `public/` `scripts/` | 论坛本体：后端（`node:http` + `node:sqlite`）、原生前端、检查脚本 | 1.3.0 | `npm test` |
| `forum-ai/` | AI 层：站点分析、阅读助手，对接任意 OpenAI 兼容接口 | 1.0.0 | `node forum-ai/selftest.mjs` |
| `note-studio/` | 学术笔记子系统：Markdown + LaTeX 可视化编辑、拍照转文字、导出 | 1.0.0 | `node note-studio/tests/run.mjs` |
| `note-agent/` | 挂在写帖页和笔记编辑器上的「AI 工作台」抽屉（写帖页随发帖下线后再没有地址能到达，见 §10.1 最后一条） | 0.1.0 | `npm run test:notes` |

### 密钥放哪

**仓库里一个密钥都没有** —— `data/`、`.env`、日志、打包产物都在 `.gitignore` 里。AI 功能全部从环境变量读配置：

```bash
AI_API_KEY=<你的 key> \
AI_BASE_URL=<OpenAI 兼容接口地址> \
AI_MODEL=<模型名> \
node src/server.js
```

不设也能跑：论坛本体、笔记编辑都不需要 AI，只有 AI 相关的按钮会提示「未配置」。**动手改代码前先确认自己的 `AI_API_KEY` 没有写进任何文件。**

### 数据在哪

运行时数据全在 `data/`（SQLite 库、头像），**不进版本库** —— 里面是真实帖子内容。删掉整个 `data/` 就等于重置成全新站点，下次启动会自动建表并写入示例数据。

---

## 1. 快速开始

### 方式 A：双击启动（Windows）

双击 `start.cmd`，然后浏览器打开 <http://127.0.0.1:3000>。

脚本会自动寻找 Node（先查 PATH，再查 DSH 内置运行时），无需配置环境变量。

### 方式 B：命令行

```bash
node src/server.js                    # 默认 http://127.0.0.1:3000
PORT=4000 node src/server.js          # 换端口（Windows: set PORT=4000 && node src/server.js）
HOST=0.0.0.0 node src/server.js       # 允许局域网内其它设备访问
```

> 要求 Node **22.5+**（`node:sqlite` 内置模块），推荐 Node 24。首次运行会自动建表并写入示例数据。

### 演示账号

| 账号 | 密码 | 角色 | 说明 |
| --- | --- | --- | --- |
| `admin` | `admin123` | 管理员 | 可进入 `#/admin` 管理后台 |
| `alice` | `demo1234` | 普通用户 | 示例用户之间已互相有关注关系 |
| `bob` | `demo1234` | 普通用户 | |
| `carol` | `demo1234` | 普通用户 | |

也可以直接点「注册」创建自己的账号；**库中第一个注册的用户会自动成为管理员**，新账号还会收到一条欢迎通知。

---

## 2. 互动机制说明

### 评价：赞 / 踩

同一用户对同一篇文章只能「赞」或「踩」二选一，重复点同一个按钮表示取消，改主意时直接点另一个即可（会自动清掉原来的）。
热度排序的公式是 `赞×4 + 回复×3 − 踩×2 + 浏览×0.1`（列表排序用），看的是热度而不是质量。

### 转发 🔁

**帖子**（详情页、积木阅读页的互动条上都有那颗「🔁」）：

- 可以**带一句评语**转发，评语可以随时改（同一篇只保留一条转发）；
- 转发会**同时落到两处**：一是**你的主页「🔁 转发」分类**里（别人点进去能看到你的评语和原文），
  二是**动态流**里的一条新动态（卡片上写着「🔁 转发了帖子」，点进去就是那篇帖子）——
  这一条是照着 B 站来的：「转发视频也是发到动态，转发动态也是发到动态」，转发的落点只有动态流一处；
- 原作者会收到「转发了你的文章」通知；帖子详情页有完整的转发列表；
- 可以随时「撤销转发」；「🔗 复制链接」把帖子地址复制到剪贴板，方便分享到站外；
- **自己的文章也能转发** —— 转发不是「分享给别人」，而是「把它放进我主页的『🔁 转发』分类」，
  对作者来说那是个自己给自己置顶的位置。自己转自己不发通知（`createNotification` 里
  `actorId === userId` 直接返回 null），所以不会出现「你转发了你自己的文章」。
- **不是公开的帖子（仅关注者 / 仅团队的积木帖）转得出去，但不往动态流里落卡片** ——
  卡片上印着标题，而动态流是所有人可见的，落一张就等于把标题漏出去、点进去还 404。
  转发本身照常生效（个人主页那个分类是按访客过滤的），只是没有公开的那张卡。
- 「🔁 转发了帖子」和「🔗 引用了帖子」在动态流里长得几乎一样（都是 `ref_post_id` 指着一篇帖子），
  区别只在于 `reposts` 里有没有那一条 —— 服务端把它算成 `ref.repost`，前端照着它写标签。
  core 只管记转发与发通知，然后 `emitRepost()` 广播一个事件（`src/core/repost-events.js`），
  落卡片是 feed 模块自己的事（`src/modules/feed/post-repost.js`）—— core 不许 import 业务模块。

**动态**（动态流每张卡片底部的「🔁」）：

- 转发出去的就是**一条普通动态**，只是它内嵌着原动态（`ref_feed_id` 指着它）——
  所以转发自带动态的一切：可见范围、回复、点赞/踩、出现在「我的」里；
- 同样**带评语**、同一人同一条只留一条（再转 = 改评语）、可撤销、原作者收到「转发了你的动态」通知；
- **只有公开的动态能转发**：动态有 `公开 / 仅关注者 / 团队 / 私密`，而转发出去那条是公开的，
  允许转发就等于把「只给我关注者看」的内容搬到别人面前；
- **自己的动态也能转**（转出去就是一条引用自己的新动态，等于自己给自己带一句评语）；
  唯一画成**静态计数**（不是可按的按钮）的是**非公开**的动态，点下去不会吃 403；
- 原动态被删掉后转发**不会跟着消失**，内嵌卡片改显示「原动态已删除」，转发语还在。

### 个人主页：分类 / 排版 / 置顶推荐 🗂

- **分类**：作者可以自建分类（最多 8 个），在发帖或编辑时归入，也可以在自己主页的文章下方用下拉框随手调整；删除分类不会删文章，文章会回到「未分类」；
- **筛选**：主页顶部有 `全部 / 各分类 / 未分类` 标签，带每类文章数；
- **排版**：右上角可切换 `☰ 列表 / ▦ 卡片 / ≡ 紧凑` 三种排版，选择记在浏览器本地（`localStorage`）。⚠️ 改这套排版时，读写的 `localStorage` 键必须**逐字一致**：这里曾经写成 `forum:Prefs.profileLayout`（读取端用的是 `forum:profileLayout`），按钮点了等于没点、选中的排法永远记不住 —— 现在 `check-ui-contract` 有一条静态守卫查「读到的键必须有人按同一个字面量写」，`check-frontend` 还会把三种排法各渲染一遍；
- **置顶推荐**：作者可以把最多 **3 篇**文章置顶到主页顶部（单独的「📌 置顶推荐」区块），与管理员的全站置顶互不影响。

### 关注 👥

关注作者后：首页出现「我关注的」标签页；作者发新帖会推送通知；个人主页可以查看 TA 的关注者 / 关注的人和统计；在「📋 关注列表」（`#/following`，侧栏和用户菜单都有入口）里可以随时取关。

个人主页的「关注者」和「TA 关注的人」两张卡、以及关注列表页，用的是同一套按钮：**已经关注的人显示「✓ 已关注」**，再点一次就取消关注（按钮随即翻回「＋ 关注」，关注列表页的名单与计数一起刷新）。每次点击都是「切换」，不会出现「明明关注了却显示 ＋ 关注、点一下反而取关」。

**看自己的主页时**，这两张卡换成自己视角的文案（「我的关注者 / 我关注的人」），并且**排在文章列表上面**、还给一个进「📋 关注列表」的入口 —— 放在页面最底下时，文章一多就得整页滚到底才看得见（「我到底关注了谁」等于没地方看）。别人看你的主页时它们仍在最底下。

### 消息通知 🔔

顶栏铃铛带未读数徽标（每 60 秒自动刷新一次），触发规则：

| 事件 | 通知谁 | 类型 |
| --- | --- | --- |
| 有人回复你的帖子 | 楼主 | `post_reply` |
| 有人赞 / 踩你的帖子 | 作者 | `post_like` / `post_dislike` |
| 有人关注你 | 被关注者 | `follow` |
| 有人在正文 / 回复里 @你 | 被提及者 | `mention` |
| 你关注的人发了新帖 | 关注者 | `following_post` |
| 管理员删除你的帖子 | 作者 | `moderation` |
| 团队公告发布 / 修改 | 该团队全体成员 | `team_announcement` |
| 注册成功 | 本人 | `system` |

两条防打扰规则：**不给自己发通知**；**同一个人对同一对象的同类未读通知只保留一条**。通知支持「只看未读」「全部标为已读」，点击即跳转并自动已读。

> **团队公告是唯一的例外**：它不做未读合并（公告改一次就该响一次），点击跳回该团队主页。团队解散后这条通知不再跳转，退回发公告的人的主页。

### 背景主题 🎨

顶栏的 🎨 按钮（或 `#/settings` 里的「外观」卡片）可以在 8 种背景主题间随时切换：

| 主题 | 说明 |
| --- | --- |
| 暗夜 | 默认的深蓝夜色 |
| 极夜 | 纯黑 OLED，夜间最省电 |
| 明亮 | 浅色日间主题 |
| **暖阳** | **琥珀黄深色**：暖褐底 + 金色主色 |
| **奶黄** | **米黄纸感浅色**：淡黄底 + 琥珀主色 |
| 森林 | 墨绿护眼配色 |
| 暮紫 | 紫罗兰夜色 |
| 跟随系统 | 按操作系统的深/浅色偏好自动选择，系统切换时页面实时跟随 |

> 「黄色」有两种常见理解，所以一次给了两个：想要**暖黄深色**用「暖阳」，想要**亮黄/米黄浅色**用「奶黄」。
> 不喜欢哪个从 `public/core/theme.js` 的 `THEMES` 和 `public/css/00-themes.css` 的对应块里删掉即可。

实现要点：

- 主题就是 `<html data-theme="...">` 一个属性，所有配色都走 CSS 变量（`:root` 的默认值 + `html[data-theme='x']` 覆盖），**没有任何 JS 拼样式**；
- 选择存在 `localStorage['forum:theme']`，并且 `index.html` 的 `<head>` 里有一段**首屏内联脚本**在 CSS 生效前就把主题写到 `<html>` 上，所以刷新不会闪一下默认配色；
- 每个主题都声明了 `color-scheme`，原生滚动条、表单控件、下拉框会跟着一起变；
- 页面背景的那个径向光晕也是变量（`--bg-glow`），所以每个主题连背景氛围都不一样。

> 契约测试会校验：主题列表里的每个主题在 CSS 里都有变量块、关键变量（`--bg`/`--panel`/`--text`/`--topbar-bg`/`--code-block-bg`）齐全、声明了 `color-scheme`、**选择面板里的预览色块与 CSS 真实取值一致**、以及首屏脚本与 `app.js` 用的是同一个 localStorage key —— 加了新主题却忘了写 CSS 的话，测试会直接报出来。

### 个性头像 🖼️

`#/settings` 的「头像」卡片（顶栏、帖子列表、回复、主页、关注列表里的头像都是同一个）：

- **12 个预设表情**：点一下就换，底层存成 `emoji:🦊:24`（表情 + 色相，色相决定底色渐变）；
- **上传图片**：浏览器先用 canvas 把图**居中裁成正方形并压到 256×256 的 JPEG**再上传，所以手机拍的几 MB 照片也不会把服务端撑爆；
- **恢复默认**：回到「昵称首字母 + 按昵称生成的色相」的默认头像。

服务端的处理与限制：

- 只认 `data:image/(png|jpeg|webp);base64,...`，**按文件头的魔数判断真实类型**，不接受 SVG／GIF／伪装文件（SVG 能带脚本，直接拒掉）；
- 解码后 ≤ **256 KB**，超过返回 `image_too_large`；内容与声明格式不一致也会被拒；
- 文件落在 `data/avatars/u<用户ID>-<时间>-<随机>.png`，库里只存 `file:/avatars/xxx.png`；
- `GET /avatars/<文件名>` 只允许 `[A-Za-z0-9._-]+` 且不允许 `..`（防目录穿越），响应带 `Content-Type` + `nosniff` + 一年 `immutable` 缓存；
- 换头像时会**删掉旧文件**，不会在磁盘上越积越多。

### 私信 ✉️

顶栏 ✉️（带未读角标）→ `#/messages` 会话列表 → `#/messages/<用户名>` 聊天页。规则按关注关系分档：

| 关系 | 能发多少 |
| --- | --- |
| **互相关注** | **不限量** |
| **单方面关注**（你关注了 TA，或 TA 关注了你） | **每天 1 条**，按本地自然日算，第二天 0 点重置 |
| 完全没有关注关系 | 不能发（`403 no_relation`，提示「先关注对方或等对方回关」） |
| 任意一方拉黑 | 不能发（`403 blocked_me` / `blocked_by_me`） |
| 自己给自己 | 不能发（`400 self_message`） |

实现要点：

- `POST /api/messages/:username` 在服务端**每次都重新判定**（`store.messageAvailability()`），前端拿到的 `availability` 只用来渲染提示，改不动规则；
- 超额返回 **429 + `daily_limit`**，响应里带 `remainingToday` 与 `resetsAt`（下次重置时间），前端直接显示「今天还剩 N 条」；
- 单条上限 1000 字，发送频率限制 60 条 / 10 分钟；打开会话即把对方发来的消息标记为已读，并给收件人写一条 `message` 类型通知（点通知直接跳进会话）；
- 会话列表用 `ROW_NUMBER() OVER (PARTITION BY peer_id)` 取每个对端的最后一条，附带未读数，已排除双向拉黑的人。

### 黑名单 🚫

在对方主页点「🚫 拉黑」（`#/settings` 里有黑名单管理卡片可一键解除）。拉黑后：

| 效果 | 说明 |
| --- | --- |
| 无法关注你 | `POST /api/users/:id/follow` → `403 blocked_me` |
| 无法给你发私信 | 发信与开会话都 403 |
| **看不到你发的文章** | 列表 / 搜索 / 首页里都不出现；**通过直链打开也是 404**（避免绕过） |
| 看不到你的主页 | `GET /api/users/:username` → 404（对方「查无此人」） |
| 你的内容对你的可见性 | 你也不用再看 TA 的：列表、榜单、评论都会互相过滤（`blocks` 表双向子查询） |
| 自动解除关注 | 拉黑时同时清掉双向关注关系，不会再出现「拉黑了还互相关注」 |
| 评论 | 被拉黑者在你可见的帖子下的回复，也会从你的视角里过滤掉 |

反向（我拉黑了别人）时我仍能打开对方主页——会看到红色提示条和「解除拉黑」按钮，方便后悔；但内容区是空的。

### 角色与内容管理 👑

三级角色（`users.role`）：

| 角色 | 怎么来的 | 能做什么 |
| --- | --- | --- |
| 👑 **站长 owner** | 建站者，**全站唯一**（示例库里的 `admin`；从旧版本升级时最早的管理员自动成为站长） | 一切权限，**包括任命/收回管理员**；自己的角色不可更改 |
| 🛡️ **管理员 admin** | 由站长在「管理后台 → 用户管理」里任命 | **隐藏或删除任何文章**、封禁普通成员、查看后台与审计日志；不能任命管理员、不能封禁其它管理团队成员 |
| 成员 member | 注册即是 | 管理自己的内容（编辑/删除自己的文章、分类、置顶等） |

**隐藏 vs 删除**（管理团队两者都能做）：

- **🙈 隐藏**：可逆。文章对普通访客与搜索引擎直接 404，也不出现在板块列表、搜索、首页里；**作者本人仍然能看到**（详情页顶部有醒目提示 + 隐藏原因），管理团队也照常可见并带「已隐藏」标记。隐藏期间访客无法点赞/回复/转发（一律 404）。填写的隐藏原因会随通知发给作者。
- **🗑 删除**：软删除，作者和管理团队都看不到，数据仍留在库里。

**审计日志**：隐藏/恢复、删除、封禁/解封、任命/收回管理员都会写进 `moderation_logs`，后台「📜 管理操作记录」里能看到操作人、动作、对象、原因和时间。

**防呆规则**：站长不能被降级或封禁（避免把唯一站长弄丢）；管理团队成员之间不能互相封禁（只有站长能处理管理员）；不能把别人直接设成站长。

### 团队 🎽

`#/teams` 是公开的团队广场（`?mine=1` 只看我加入的），`#/team/<slug>` 是团队主页，`#/team/<slug>/post/<id>` 是**团队帖详情页**。团队主页最上面是**团队公告**，下面有三个页签：

- **📢 团队公告**：团长和管理员可以写 / 改（≤ 2000 字，提交空串就等于撤下）。保存之后**队里每个人各收一条通知**（写公告的人除外）—— 这是站里唯一不做未读合并的通知类型，公告改一次就响一次。公告**只有成员看得见**：团队主页本身公开，可公告里常有「周五开会」这类内部安排，不该挂在公开页面上，通知也只发给成员。
- **💬 讨论**：团队帖。列表里点标题就进**详情页**，帖子下面是一串回复（`?rpage=` 翻页）。可见范围仍是全站那四档（公开 / 仅关注我的人 / 仅团队 / 仅自己），成员**只能编辑自己发的帖**（`canEdit` 绑的是作者本人，服务端不是作者一律 403，管理员也不行 —— 想补充就回帖）：保存时带上 `version`，对不上就 409 让你选留哪一份，不会静默覆盖（同一个人的两个标签页就够触发它）。每篇帖右边都有「💬 回复」：列表上点它直接落进详情页的回复框（`?reply=1`），在详情页点它就是原地把光标送进去。（编辑 / 删除按钮只画在团队主页的列表上，详情页不画 —— 那条编辑流程收尾时要整页重画团队主页，在详情页点它会把人莫名送回主页。）
- **📁 文件柜**：成员上传文件（单个 ≤ 4 MB）。文件名里的路径会被削平（`../../etc/passwd` 只会留下 `passwd`），下载一律按附件下发。上传者是本人或团队管理员才能删。
- **🗨️ 群聊**：团队内的聊天记录，每 5 秒增量拉一次（`?after=<id>`）。消息 ≤ 1000 字，作者本人和团队管理员可以删。

**团队帖详情页与回复**：

- **正文与回复都走服务端 Markdown + LaTeX**：公式交给 KaTeX，四种分隔符都认（`$E=mc^2$`、`$$…$$`、`\(…\)`、`\[…\]`）。渲染必须在 `innerHTML` **之后** —— `renderMathInElement` 只处理已经在 DOM 里的节点。团队帖列表、详情页正文、每一条回复都渲染一遍。
- **一条回复只有三个字段**：正文（1–5000 字）、作者、时间。它比帖子少 `scope` / `version` / `editor` —— 它是一句话，不是一篇文档，没有并发编辑与可见范围可谈。
- **回复的可见性完全跟着帖子**：`/api/teams/:id/posts/:postId/replies` 先判「这篇帖子你看不看得见」，再判「你是不是成员」。所以公开帖下面的回复**路人读得到**（能读不能回，回帖 403）；「仅团队」的帖子对未登录回 401、对已登录的局外人回 404 —— 顺序反过来的话，403 那句「加入这个团队之后才能回复」就等于隔着一堵墙承认帖子存在。
- **删除只认作者和团队管理员**，路径里带着 `:postId`（一条回复属于哪篇帖子写在 URL 里，拿别条帖子下的回复 id 来删直接 404）。**重复删返回成功**（0 行改动也是「它现在没了」），前端重试一次不该看到报错；删除响应顺带把最新的 `replyCount` 带回来，详情页删完不用再问一次「现在几条了」。
- **`canDelete` 由服务端算**（作者本人 ∨ 团队 owner / admin），前端只是照着画按钮 —— 权限不在浏览器里判。

**每个团队都有一个 6 位团队号**，建队时自动生成。字母表去掉了 `I` / `L` / `O` / `U` —— 念错、听错、抄错基本都从这几个字符来（`1`/`l`/`I` 都当 `1`，`0`/`O` 都当 `0`）。在团队广场填上号就能加入，**不看这个团队要不要申请**：写着「需要申请」的团队也走这里，号本身就是那封邀请函。号**只给成员看**；抄成小写、带空格或短横线都不讲究，服务端统一折叠。团队号旁边的「**复制**」走三段退：`navigator.clipboard` → 临时 `textarea` + `execCommand('copy')` → 选中号 + 一句「按 Ctrl+C」—— 剪贴板 API 只在**安全上下文**（https 或 `localhost`）存在，局域网 `http://192.168.x.x:3000` 上它是 `undefined`，只赌它就会「点了没反应」。

**加入方式：谁都能加入 / 需要申请**，以及随之而来的审核：

- 每个团队有两档：`open`（谁都能加入）与 `apply`（需要申请）。**改这一档是团长和管理员都能做的**（和改队名、简介同一条线）。
- 申请式团队的路人在团队主页上看到的是「申请加入」（被拒过就是「再申请一次」），点开写一句理由（可以留空，≤ 200 字）再递；递出去之后顶部变成「⏳ 申请审核中」，可以自己撤回。
- 团长和管理员点「📨 加入申请」打开审批抽屉（从屏幕右侧滑出来，ESC 或点遮罩关掉）：待审 / 已批准 / 已拒绝 / 全部 四档页签，批准就入队（成员数立刻 +1），拒绝只是不让他进 —— **被拒之后还能再申请一次**（新建一条，旧的那条留作记录）。
- **同一人对同一团队同时只能有一条待审申请**：靠 `team_join_requests` 上的部分唯一索引（`WHERE status = 'pending'`）挡住，不靠应用层判重。两个管理员同时点「批准」只有一个能成功，另一个拿到「这条申请已经处理过了」。
- **团队号照样绕过申请**：号本身就是邀请函。所以「需要申请」挡的是「在广场上逛到就能进」，不是挡「被人请进来」。
- 这一段是**替代「拉进团队」的**：原来团长 / 管理员敲一个用户名就能把人拽进来，当事人连知都不知道、也没有拒绝的机会，现在那条路整个删掉了（`POST /api/teams/:id/members` 只留下 GET）。
- 通知：有人递申请 → 全体团长 / 管理员各一条（**走去重**，同一个人反复递只有一条未读，和公告的 `dedupe:false` 正相反）；批准 / 拒绝 → 申请人一条。三种类型分别是 `team_join_request` / `team_join_approved` / `team_join_rejected`。

**团队要不要出现在团队广场上**：

- 创建者可以在团队设置（也是一个从右侧滑出的抽屉）里选「出现」还是「不显示」。这是**创建者独有**的一条线（管理员带着 `listed` 去改会拿到 403）——和「解散团队」同一条线。
- 藏起来只是「不被发现」：广场列表里不再出现它，但**团队主页、团队号、帖子链接照旧能用**；已经加入的成员在自己的广场列表里仍然看得到自己那个隐藏团队（卡片上标一个 🙈「已隐藏」），不然他连怎么回队里都不知道。

**团队里的角色**（`team_members.role`，和全站三级角色是两套东西）：

| 角色 | 怎么来的 | 能做什么 |
| --- | --- | --- |
| 🎽 **创建者 owner** | 建团队的人，全队唯一 | 改团队设置（含**加入方式**）、**决定团队要不要出现在团队广场上**、**任命/撤销管理员**、踢人、**写团队公告**、**审核加入申请**、删任何团队帖 / 回复 / 文件、解散团队；**不能退出自己的团队**（只能解散） |
| 🛡️ **管理员 admin** | 由创建者任命 | 改团队设置（含**加入方式**）、**审核加入申请**、**踢人**、**写团队公告**、删任何团队帖 / 回复 / 文件；**不能**改「要不要出现在广场上」（那条线只归创建者） |
| 成员 member | 凭团队号直接加入，或递申请被团长 / 管理员批准 | 发帖、**回复**、传/下文件、群聊 |

站长在团队里**没有任何后门**（原因见 API 一节）。踢人是管理员就行，**改角色只有创建者能做** —— 服务端与前端按钮是同一口径。

### 账号设置 ⚙️

`#/settings` 页面提供：

- **头像**：预设表情 / 上传图片 / 恢复默认（见上）；
- **个人资料**：修改昵称（1-20 字符）与个性签名（≤100 字符，展示在个人主页）；
- **外观**：背景主题选择（与顶栏 🎨 同步）；
- **修改密码**：需要输入当前密码，新密码至少 6 位且不能与旧密码相同；**改密成功后其它设备上的会话会被立即吊销**，当前浏览器保持登录；
- **账号信息**：用户名（不可改）、身份、注册时间、状态。

> **登录失败要说人话**：`POST /api/auth/login` 在密码错时回的是 **401** + `bad_credentials`
> + 「用户名或密码不对」—— 这是全站唯一一个「401 但带着真话」的接口。前端 `public/core/errors.js`
> 的 `apiErrorText` 以前只看状态码，把所有 401 一律当成会话过期（清本地登录态、跳登录页、
> 弹「登录状态已失效，请重新登录」，然后返回空串表示「已经处理过了、别再提示」），于是那句
> 真话被吞掉，用户在登录页把密码打错，看到的是让他去重新登录。
> 现在两条规矩：① `bad_credentials` 直接原样交给用户；② **只有本来登录着**（`state.me` 非空）
> 才算过期 —— 游客撞上 401 该听到的是「这个操作要先登录」，而不是「你的登录状态失效了」。

---

## 3. 目录结构

```
forum/
├── start.cmd                    # Windows 一键启动（纯 ASCII + CRLF，见文末维护提示）
├── package.json                 # 只有 scripts / engines，没有 dependencies
├── docs/
│   ├── skeleton.md              # ★ 预铺骨架说明：目录布局 / 冻结契约 / 五路并行 / 怎么加功能
│   └── superpowers/specs/       # 改造设计文档（spec）
├── src/
│   ├── server.js                # 薄入口（≤120 行）：装配 store / ctx / 模块 / 静态服务
│   ├── store.js                 # 数据访问层（全部 SQL 集中在这里）
│   ├── db.js                    # 门面：登记建表脚本 + 转出 openDatabase 与全部规则常量
│   ├── core/                    # 框架层：路由表 / 上下文 / 守卫 / 响应形状 / 建表登记
│   │   ├── router.js            #   route(method, pattern, handler) 注册表
│   │   ├── context.js           #   ctx：模块能拿到的全部东西（唯一通信面）
│   │   ├── tables.sql.js        #   18 张核心表的建表 SQL（与旧 SCHEMA 逐字节相同）
│   │   ├── open-db.js           #   openDatabase()：建表 → 迁移 → 播种
│   │   └── …                    #   http / guards / shape / static / sessions / paths
│   └── modules/                 # 功能层：每个模块一个文件夹，互不 import
│       ├── index.js             #   ★ 全仓库唯一列举模块的名册（MODULES）
│       ├── core/                #   现有论坛本体（auth / posts / replies / 社交 / 管理）
│       ├── feed/ doc/ ai/ team/  ui/      # 拆分出来的功能模块（见 docs/skeleton.md）
├── public/
│   ├── index.html               # 页面外壳（顶栏 / 侧栏 / 挂载点）
│   ├── app.js                   # 薄入口（≤120 行）：只做 bootstrap
│   ├── style.css                # 只剩 20 行 @import，按前缀顺序拼回原级联顺序
│   ├── core/                    # 前端核心层：state / dom / api / router / theme / events …
│   ├── views/                   # 页面：feed / user / post / compose / timeline / messages / notes / doc / team / ai / admin …
│   └── css/                     # 22 个样式分片（00-themes … 97-notes）
├── scripts/
│   ├── smoke.mjs                # 后端端到端冒烟测试（238 项）
│   ├── check-golden.mjs         # ★ 行为金标准：88 条请求的状态码 + 响应结构指纹
│   ├── check-skeleton.mjs       # ★ 骨架自检：模块解耦证明 + 薄入口行数
│   ├── check-ui-contract.mjs    # 前端契约检查：CSS 类名 + API 字段 + 主题/头像/角色/私信结构
│   ├── check-encoding.mjs       # 源码编码体检（BOM / 乱码 / 批处理换行与 ASCII）
│   ├── check-markdown.mjs       # ★ 正文渲染回归：链接 / 表格 / 嵌套列表 / 转义 / 行内 HTML 白名单
│   ├── sync-markdown-core.mjs   # 同步 note-agent 的兜底渲染器（--check 当漂移守卫）
│   ├── seed-oiwiki.mjs          # ★ 把 OI-wiki 的 mkdocs 源码导成站内 wiki 站（本地没源码时自己从 GitHub 取）
│   ├── fetch-oiwiki.mjs         #   取一份 OI-wiki 源码快照：下 GitHub 的 tar.gz 自己解包（零依赖）
│   ├── check-notes-ui.mjs / check-frontend.mjs / notes-smoke.mjs / smoke-ai.mjs
│   ├── ai-smoke.mjs / ui-smoke.mjs / feed-smoke.mjs / doc-smoke.mjs / team-smoke.mjs
│   ├── fix-cmd.mjs              # 把 .cmd 规范化为 CRLF + 去 BOM
│   └── reset-db.mjs             # 清库并重新播种（危险操作，必须加 --yes）
├── oi-wiki-src/                 # OI Wiki 上游源码快照（原样拷贝，不是本站写的代码）
│   ├── README.md                #   来历 / 许可 / 怎么更新（CC BY-SA 4.0）
│   └── OI-wiki-master/          #   docs/（465 篇 md + 680 张图）+ mkdocs.yml —— seed-oiwiki.mjs 读它
└── data/forum.db                # SQLite 数据文件（首次运行自动生成）
```

> 想动手改代码，先读 **[`docs/skeleton.md`](docs/skeleton.md)** —— 那里写清了冻结契约（模块怎么被装载、
> 哪些表归谁、接口前缀怎么分、五个人怎么并行开工），以及「加一个新模块要动哪几行」。

> **维护提示（踩过的坑）**：`start.cmd` 必须保持 **CRLF 换行 + 纯 ASCII + 无 BOM**。
> cmd.exe 是按本地代码页逐行解析批处理的，如果脚本里写了 UTF-8 中文、或用了 LF 换行，
> 整份脚本会被拆成乱码命令（表现为 `'defined' is not recognized`、`'tp:' is not recognized` 之类），
> 结果是"找不到 Node"。所以脚本里只放英文提示 + 开头 `chcp 65001`，
> 中文横幅交给 Node 服务输出；换行被编辑器改坏时跑 `npm run fix:cmd` 修回来，
> `node scripts/check-encoding.mjs` 也会把这类问题当作错误报出来。

---

## 4. 页面与路由（hash 路由）

| 路由 | 页面 |
| --- | --- |
| `#/` | **起始页**（m05506 起就是网站的默认落点，**不论登录与否**）：左边站务公告，右边三块入口（动态 / 积木广场 / 团队） |
| `#/feed` | 动态流：全部 / 我关注的 / 我的，`?filter=following`、`?filter=mine`、`?q=关键词`、`?page=`。**以前这是 `#/`，m05506 与起始页对调了地址**（老书签请改用这里） |
| `#/feed/:id` | **单条动态**：「← 回动态流」加一张完整卡片。转发卡片的引用块点进来就是这一页 —— 回复通知是按「被回复卡片的作者」发的，看不到源动态就等于别人在转发底下聊你的动态、你一条通知都收不到 |
| `#/start` | 起始页的老地址，保留成别名（进的是同一页，不会断链） |
| `#/announcements` | **站务公告**（`?page=`）：全部公告，从新到旧、每页 20 条，读的是 `GET /api/docs?template=announce&sort=created`。公告**已经不是帖子**（`meta` 板块的老公告启动时由 `store.migrateLegacyPosts()` 一次性搬成了这类积木）：只有站长 / 管理员写得动，也**不进积木广场**（普通用户在广场里看不到它们），但首页与这一页人人可见；staff 在起始页和这一页都多一颗「＋ 写公告」。起始页那块**只放最近 5 条**，右下角「查看全部」点到这儿。`#/board/meta` 也直接落到这一页 |
| `#/board/tech` | 板块页（`general` / `tech` / `qa` / `share` / `meta`） |
| `#/post/:id` | **（已下线，一切指向它的链接都改道）** 老的帖子详情页：路由还认，但**不再渲染帖子** —— `public/views/post.js` 的 `viewPost(id)` 拿 `GET /api/docs/by-anchor/:id` 反查这篇帖子是哪篇积木的影子行，查到就 `location.replace('#/doc/<docId>')`（老收藏、动态流、通知、搜索结果、站外链接全落在这一句上，所以没有哪条路还能真打开一张帖子页）；反查不到（真被删了）显示一张「这篇帖子没有对应的积木」的卡片。**代码没删**：`replyHtml` / `reactionBarHtml` / `repostSectionHtml` 这三样仍被积木阅读页复用，只是那两个通往帖子的「编辑帖子 / 删除帖子」按钮在积木页里不画（`{ docMode: true }`） |
| `#/new` | **（已下线）** 老的发帖地址：`toast` 一句「帖子功能已经下线，写作请到积木广场」然后落到 `#/docs`。写作入口只剩积木广场那颗「＋ 新建一篇」，`public/core/session.js` 用户菜单里的「✏️ 发布新帖」已经删掉 |
| `#/edit/:id` | **（已下线）** 老的改帖地址：`viewLegacyEdit(id)` 同样按锚点反查积木，查到就送去 `#/doc/<docId>/edit`（弹一句「帖子已经搬进积木了，这里是它的编辑器」），查不到落回 `#/docs` |
| `#/settings` | 账号设置：资料、密码、账号信息 |
| `#/u/:username` | 个人主页：分类筛选、三种排版、置顶推荐、关注者与关注列表 |
| `#/notifications` | 消息通知（全部 / 只看未读） |
| `#/following` | 📋 关注列表：我关注了**谁**（头像 + 昵称 + 「✓ 已关注」按钮，点一下就取关）。关注**流**（只看 TA 们发的帖子）是动态流的一个筛选，走 `#/feed?filter=following` |
| `#/bookmarks` | 我的收藏 |
| `#/search?q=关键词` | 全文搜索（标题 + 正文），落在动态流上（等价于 `#/feed?q=…`） |
| `#/login`、`#/register` | 登录 / 注册 |
| `#/admin` | 管理后台（仅管理员） |
| `#/docs` | 积木广场：可编程帖子 / 笔记 / 主页文档的列表，支持 `?kind=` `?scope=` `?mine=1` `?q=` `?tag=标签`（点卡片上的标签就是跳到这儿）`?drafts=1`（**草稿箱**：只有自己有草稿的那些，卡片上带「草稿」徽章）；两种排法 `▦ 网格` / `☰ 列表`（从上往下列下来），选择记在本地偏好 `forum:docsLayout` 里 |
| `#/doc/:id` | 积木阅读页：块渲染结果、降级警告、修订记录、导出/导入、顶部挂着**标签**（点一下看同标签的积木），底下是**互动条**（点赞 / 踩 / 收藏 / 转发 / 关注作者 + AI 解读）—— 它挂在文档的锚点帖上，走 `GET /api/docs/:id/anchor`，不再需要跳到帖子页 |
| `#/doc/:id/edit` | 积木编辑器：逐块编辑、上下移动、Markdown 双向、`ops` 增量改动、套模板、回滚、沙箱开关、标签（跟着同一个「保存」一起存）；**两种编辑面（⚡ 源码 / 🧱 积木模式）里所有文本框都支持 `Tab` 缩进、`Shift+Tab` 退一级**（选中多行就整块缩进；用制表符，不是空格）；**Markdown / 源码模式左侧挂着一个 AI 抽屉**（`public/views/doc-ai.js`）—— 对着它说一句话，右边这段正文就跟着改（整理格式、学术审查、加个积木块、写积木脚本），走的是 `/api/ai-edit/*` 同一套，结果只写回编辑区，落盘还是那颗「保存」 |
| `#/doc/:id/blocks` | 同一个编辑器的高级入口（默认落在积木模式）：块列表 + 当前块的 props 表单 |
| `#/blocks` | 块类型表的老地址：进的是同一页 `#/dev`（页面没下线，收藏夹里的链接照样能开） |
| `#/dev` | 开发者功能：块类型表（内置/自定义类型的 schema 速查 + 注册自己的块类型）+「我的脚本模板」（把自己常写的沙箱代码存下来，一键新建一篇只带这一块的积木） |
| `#/guide` | 积木教程：写给用积木的人 —— 新建一篇、编辑器三档怎么用、一次「保存」都存什么、谁可以看、怎么分享、**标签（怎么打、怎么按标签找）**、读者能做什么，后半截是进阶（让积木跑代码的两种块、能申请的六项能力、超时与失败怎么接、七个能直接抄的样例、存脚本模板、给全站加新块类型）；末节是 **18. 应用示例：从零开始建一个 OI Wiki** |
| `#/ai-edit` | **AI 编辑台**：给模型授权（**目录里只有「修改内容」一项，默认关闭**）→ 草拟（**只预览**）→ 确认才落盘 → 每一步都留审计、可回滚。也能**审查**一篇（原「AI 学术审查」的接班人：按块给意见、引用不到原文的意见会被丢掉）与让模型整篇**套站内模板**。页面底部是**用量面板**：每个人都能看到自己今日/本周/本月的 token 与估算金额（按北京时间算钱、按 UTC 日算配额次数），站长/管理员多一层全站账单（今日、本月/本周汇总、**本月每天**的明细与预算）。入口在 AI 页面里的「🎛 AI 编辑台」 |
| `#/notes` | **（已下线，入口不再出现）** 老的学术笔记宿主页：路由与页面都留着，直接输地址还能看以前写的笔记，顶上写着「已经并进积木了 —— 给积木打 `#学术笔记` 标签」。代码没删（`public/views/notes.js`、`src/notes.js`、`note-studio/`），只是界面上不再提它 |
| `#/wiki/:name` | Wiki 多页面：`[[双链]]` 的落点；左侧是分类边栏（页内筛选 + 新建页，作者多一个「改分类」），有这一页就渲染它，没有就给「建这一页」（`?create=1` 一步进编辑器） |
| `#/teams` | 团队列表：公开团队广场（**被创建者藏起来的团队不出现**），`?mine=1` 只看我加入的，`?page=` 翻页；未登录也能看。顶上是「🔑 用团队号加入」，填 6 位号直接进队（登录后才显示） |
| `#/team/:slug` | 团队主页：最上面是**团队公告**（只有成员看得见）与团队号（点「复制」发给要拉的人）、团队简介与成员、发帖框、帖子列表（按四档可见范围过滤，标题点进详情页，右侧显示「💬 N 条回复」）；成员在这里**只能编辑自己发的帖**（别人发的帖右边只有「💬 回复」，编辑 / 删除按钮只画在团队主页列表上）。三个页签 `?tab=discuss`（默认）/ `?tab=files`（文件柜）/ `?tab=chat`（群聊）；`?page=` 翻帖子、`?fpage=` 翻文件。没加入的人看到的是「加入团队」（`open`）或「申请加入」（`apply`，被拒过就是「再申请一次」），递过申请是「⏳ 申请审核中 + 撤回申请」；团长 / 管理员多一个「📨 加入申请」抽屉（待审 / 已批准 / 已拒绝 / 全部；批准 / 拒绝 / 撤销），创建者的团队设置（同一个抽屉位）里多一个「出现在团队广场」开关。每篇帖右边都有「💬 回复」：列表上点它落进详情页的回复框（`?reply=1`），在详情页点它就是原地把光标送进去 |
| `#/team/:slug/post/:postId` | **团队帖详情页**：面包屑 + 帖子正文（Markdown + LaTeX）与回复数，下面是一串回复（时间正序，`?rpage=` 翻页）与回复框（未登录给「去登录」、非成员给加入提示）。管理员的删除按钮只画在自己能删的那条上 |

### 站里那个 519 页的 OI Wiki 是怎么来的

`#/wiki/OI%20Wiki` 这个站（463 篇正文 + 56 个目录页，按 OI-wiki 原本的 mkdocs 目录树排三层）不是手点的 —— **`scripts/seed-oiwiki.mjs`** 把 [OI-wiki](https://github.com/OI-wiki/OI-wiki) 的 `docs/**.md` 整仓导进来的：

| 上游的写法 | 导入之后 |
| --- | --- |
| mkdocs `nav:` 里的**目录**节点（14 个顶层 / 40 个二级 / 5 个三级） | 各自是一页「目录页」，正文 = 一级标题 + 直接子页的 `subpage` 卡片（所以点进去就是下一层的地图） |
| `??? "标题"` / `???+ "标题"` / `!!!` 折叠块（2940 个） | `fold` 折叠块（`???` 收起、`???+`/`!!!` 展开；嵌在折叠块里的折叠块降级成加粗小标题） |
| `=== "C++"` / `=== "Python"` 标签页 | 一个 `fold`（同一段代码的多种语言收在一起） |
| `--8<-- "path/to/file:section"`（667 处，带 `[start:x]` / `[end:x]` 标记） | 现场把片段展开进正文（原文件在 `oi-wiki-src/` 里，和 md 一起存着） |
| `[^1]` / `[^name]` 脚注（387 条） | `<sup>N</sup>` + 文末「### 脚注」有序列表（按引用顺序重新编号，上游的脚注 id 大多是名字不是数字） |
| 正文里的本地图片（641 张，含中文文件名） | 拷进 `UPLOAD_DIR` 并改写成 `/uploads/oi-wiki/…`（走 `src/core/static.js` 的 `serveUpload`） |
| `[文字](another.md)` 本地互链 | `[[那一页的标题]]` 行内双链（标题写错就是红链，点一下当场建页） |
| `<kbd>` / `<br>` / `<sup>` 这些行内 HTML | 原样留着（`src/markdown.js` 的行内白名单，别的标签照旧转义） |

```bash
node scripts/seed-oiwiki.mjs --dry --limit 8   # 只转 8 页，打印每页大小与块数
node scripts/seed-oiwiki.mjs                   # 真导入（默认写 data/p2-preview.db）
node scripts/seed-oiwiki.mjs --tree            # 只补目录树，叶子正文不动（重跑很快）
node scripts/seed-oiwiki.mjs --only dp/        # 只导一个子目录
node scripts/seed-oiwiki.mjs --tree --extras   # 连没进 nav 的文件也发布
node scripts/seed-oiwiki.mjs --src <目录>      # 换一份源码（默认就是仓库里那份）
node scripts/seed-oiwiki.mjs --no-fetch        # 不许联网取源码（本地没有就直接报错）
DB_FILE=/opt/app/data/forum.db node scripts/seed-oiwiki.mjs --user RyuriHime   # 线上：写正式库
```

> **线上不用管，它自己会导**：这 519 页是**数据库内容**（`data/` 被 `.gitignore` 忽略），而部署只换
> `src/ public/ scripts/` 三个目录（`docs/skeleton.md` §5）—— 所以「推上 main」本身搬不动内容。
> 于是反过来做：**让代码自己搬**。服务起来之后（`ctx.hooks.afterReady`，登记在
> `src/modules/doc/index.js`、执行在 `src/server.js` 的 listen 回调里），`src/modules/doc/oiwiki-autoseed.js`
> 会看一眼库里有没有一个**同名、0 页**的「OI Wiki」站；有就起个**子进程**跑导入器把 519 页填进去，
> 日志直接进服务器日志，**不挡启动**（失败也只留一行）。几个条件：
>
> - 站名得正好是「OI Wiki」（标题相同才认），并且是 0 页；导完就是 519 页，所以只可能跑一次。
>   成功后会写一个 `oi-wiki-imported.flag`（落在库旁边）—— 有它就不再自动填了，哪怕你后来把页删光。
> - 导入器本地找不到源码时会**自己从 GitHub 取一份**（`scripts/fetch-oiwiki.mjs`：下 GitHub 打的 tar.gz,
>   自己解包到库旁边的 `oi-wiki-src-cache/`，零依赖）—— 服务器本来就每 3 分钟连一次 GitHub 拉 main，这条路是通的。
>   首次多花几十秒下载，之后走缓存。
> - `--user <用户名>` 指定以谁的身份建站建页：自动导入用的是**那个站自己的作者**；
>   `scripts/seed-oiwiki.mjs:650` 按标题复用同名站，不会另建一个。图片落在 `UPLOAD_DIR`
>   （跟着 `DB_FILE` 走，即数据库旁边的 `uploads/`）。
> - 不想让它自动导：`OIWIKI_AUTOIMPORT=0`。手跑也行（本地与服务器同一条）：
>
>   ```bash
>   DB_FILE=<部署目录>/data/forum.db node scripts/seed-oiwiki.mjs --user RyuriHime
>   ```
>
>   跑完不用重启（页面与目录树都是每次请求现查库）。

> **源码跟着仓库走**：上游那份 `docs/` + `mkdocs.yml` 就放在 **`oi-wiki-src/OI-wiki-master/`**
> （2919 个文件 / 50.9 MB，原样拷贝，一个字没改过），所以 `git clone` 下来就能离线导入，
> 不必再去下载 OI-wiki。来历、许可与更新办法见 [`oi-wiki-src/README.md`](oi-wiki-src/README.md)；
> 源码放在仓库外面（`../oi-wiki-src/OI-wiki-master`）也照样认，两边都有时以仓库内那份为准。
> 上游许可是 **CC BY-SA 4.0**（除代码部分外，详见其 README），导进来的正文保留原文与出处链接。

> **不走 HTTP**：`PUT /api/docs/:id/markdown` 这类写接口每用户每 10 分钟只给 60 次
> （`src/modules/doc/routes.js` 的 `write()` 里那个 `rateLimit`），519 页要跑一个多小时；
> 脚本改成在进程里 `openDatabase` + `createDocStore` 直接拿 store 写库，几分钟跑完。
> 也因此它跟着 `DB_FILE` 走 —— 指向哪个库就写哪个库，**默认写的是预览库**，别对着正式库随手跑。
> 同一件事用人手做一遍的过程写在积木教程的末节（`#/guide` 的「18. 应用示例」）。

---

## 5. REST API

所有接口返回统一结构：成功 `{ ok: true, data }`，失败 `{ ok: false, error: { code, message } }`。

| 方法 | 路径 | 说明 | 权限 |
| --- | --- | --- | --- |
| POST | `/api/auth/register` | 注册（用户名 3-20 位字母数字下划线，密码 ≥6 位） | 公开 |
| POST | `/api/auth/login` | 登录，下发 `forum_sid` Cookie | 公开 |
| POST | `/api/auth/logout` | 退出登录 | 登录 |
| POST | `/api/auth/password` | 修改密码（校验旧密码，吊销其它会话） | 登录 |
| GET | `/api/auth/me` | 当前用户 + 未读数 | 公开 |
| POST | `/api/me/profile` | 修改昵称 / 个性签名 | 登录 |
| POST | `/api/me/avatar` | 设置头像：`{type:'emoji'\|'upload'\|'reset'}` | 登录 |
| GET | `/avatars/:file` | 读取上传的头像文件（长缓存 + nosniff） | 公开 |
| GET | `/uploads/:path` | 读取站内上传的图片 / 视频（积木正文里的图就落在这儿，如 `/uploads/oi-wiki/dp/images/x.png`）；按 `/` 分段校验路径（允许中文名，但拒掉 `.` / `..` 与空白、反斜杠、冒号这类怪字符），扩展名白名单 svg/png/jpg/jpeg/gif/apng/webp/avif/bmp/ico/mp4/webm，命中就回 `Cache-Control: public, max-age=86400`；落盘目录由 `UPLOAD_DIR` 决定（默认跟 `DB_FILE` 同级） | 公开 |
| GET | `/api/me/categories` | 我的主页分类（含文章数） | 登录 |
| POST | `/api/me/categories` | 新建分类（≤8 个） | 登录 |
| PUT | `/api/me/categories/:id` | 重命名分类 | 登录 |
| DELETE | `/api/me/categories/:id` | 删除分类（文章回到未分类） | 登录 |
| GET | `/api/site` | 板块列表 + 站点统计 + 主页规则 + 热门帖子 | 公开 |
| GET | `/api/posts` | 帖子列表，支持 `board` `q` `author` `sort` `page` `perPage` `bookmarked` `following` | 公开 |
| POST | `/api/posts` | **（已下线）** 发帖 —— 一律 `410` + 错误码 `posts_retired`（响应体那句「帖子功能已经下线，请到积木广场写作（#/docs）」）；写作改走 `POST /api/docs`。**为什么是 410 而不是 401 / 403 / 404**：410 Gone 的语义是「这个资源曾经在、现在永久没了」，正好是这次的意思 —— 它不是权限不够（403）、也不是帖号敲错（404），**重试、换账号、换 token 都没用**；而 404 会让人以为 URL 写错了、去翻文档找正确写法 | 公开（谁调都是 410） |
| GET | `/api/posts/:id` | 帖子详情（含回复、我的评价状态）—— 对影子帖照旧可用，但帖子详情页已经不渲染它：`#/post/:id` 只拿 `GET /api/docs/by-anchor/:id` 反查积木 | 公开 |
| PUT | `/api/posts/:id` | **（已下线）** 编辑帖子 —— 一律 `410` `posts_retired`（同上一行的「为什么」）。改内容请改它对应的积木：`#/edit/:id` 会把你送进 `#/doc/<id>/edit` | 公开（谁调都是 410） |
| DELETE | `/api/posts/:id` | **（已下线）** 删除帖子 —— 一律 `410` `posts_retired`。删积木走 `DELETE /api/docs/:id`（它会连影子行一起收拾） | 公开（谁调都是 410） |
| POST | `/api/posts/:id/reaction` | 赞 / 踩，body `{ kind: 'like' \| 'dislike' }` | 登录 |
| POST | `/api/posts/:id/bookmark` | 收藏 / 取消收藏 | 登录 |
| POST | `/api/posts/:id/repost` | 转发（带评语，同一篇只留一条，重复转发=更新评语） | 登录 |
| DELETE | `/api/posts/:id/repost` | 撤销转发 | 登录 |
| POST | `/api/posts/:id/category` | 把文章归入自己的分类（`null` 表示取消） | 作者 |
| POST | `/api/posts/:id/profile-pin` | 主页置顶 / 取消置顶（≤3 篇） | 作者 |
| POST | `/api/posts/:id/replies` | 发表回复（通知楼主、@提及） | 登录 |
| DELETE | `/api/replies/:id` | 删除回复 | 回复者/楼主/管理员 |
| POST | `/api/users/:id/follow` | 关注 / 取关 | 登录 |
| GET | `/api/users/:username` | 个人主页：统计 + 分类 + 关注者/关注 + 文章（`?category=<id\|none>`） | 公开 |
| GET | `/api/me/following` | 我的关注列表 + 计数 | 登录 |
| GET | `/api/notifications` | 通知列表，支持 `filter=unread` `page` `perPage`（上限 50）。每行带 `post` / `actor` / `team`；`team_announcement` 的 `team` 用来跳回团队主页 | 登录 |
| GET | `/api/notifications/summary` | 未读数（铃铛轮询用） | 登录 |
| POST | `/api/notifications/:id/read` | 单条已读 | 登录 |
| POST | `/api/notifications/read-all` | 全部已读 | 登录 |
| POST | `/api/markdown/preview` | Markdown 渲染预览 | 登录 |
| GET | `/api/admin/overview` | 后台看板（统计 + 用户 + 最近帖子） | 管理员 |
| POST | `/api/admin/posts/:id/hide` | 隐藏 / 恢复文章，body `{hidden, reason}` | 站长/管理员 |
| POST | `/api/users/:id/block` | 拉黑 / 解除拉黑，body `{blocked}` | 登录 |
| GET | `/api/me/blocks` | 我的黑名单 | 登录 |
| GET | `/api/messages` | 会话列表（含未读数与规则） | 登录 |
| GET | `/api/messages/summary` | 未读私信数（顶栏角标） | 登录 |
| GET | `/api/messages/:username` | 会话详情（打开即标记已读） | 登录 |
| POST | `/api/messages/:username` | 发私信（互关不限量 / 单向每天 1 条） | 登录 |
| POST | `/api/admin/users/:id/role` | 任命 / 收回管理员（`role: 'admin'\|'member'`） | **仅站长** |
| POST | `/api/admin/users/:id/ban` | 封禁 / 解封（立即踢掉该用户全部会话；不能封禁站长） | 站长/管理员 |
| GET | `/api/docs` | 积木文档列表，支持 `kind` `scope` `mine=1` `drafts=1`（草稿箱：只列**我自己**有草稿的那些）`q` `tag`（按标签筛，大小写不敏感）`template`（点名 `template=announce` 就是首页 / 公告页读站务公告那条路）`page` `limit` `sort` | 公开（按可见范围过滤；**不点名 `template` 时对非 staff 隐藏 `announce`**，所以公告不会混进积木广场） |
| POST | `/api/docs` | 新建积木文档，body `{ title, kind, scope, template, tags, blocks, draft }`（标签最多 5 个、每个 24 字）；`kind='profile'` 一个用户至多一份；`draft: true` = 建出来先落在**草稿箱**（读者看不到，点「发布」才对外），不传就是建好即发布（与以前一致） | 登录 |
| GET | `/api/docs/:id` | 文档详情：`{ doc, blocks, html, warnings, abilities }`（`doc.tags` 是字符串数组） | 按 scope |
| PUT | `/api/docs/:id` | 改标题 / 可见范围 / 模板名 / 标签（`tags` 不传 = 不动，传 `[]` = 清空） | 作者/管理员 |
| POST | `/api/docs/:id/draft` | **进草稿箱**：把此刻的正文留底成对外那一份，之后的正文保存只动工作副本（读者看不到），直到发布。编辑器在**第一次写正文之前**调一次；幂等 | 作者/管理员 |
| POST | `/api/docs/:id/publish` | **发布**：把工作副本（草稿）拷成对外那一份，清掉草稿行并同步影子行；没有草稿行时是幂等的空操作 | 作者/管理员 |
| DELETE | `/api/docs/:id` | 软删除文档并同步影子行 | 作者/管理员 |
| POST | `/api/docs/:id/blocks` | 新增一块，body `{ type, props, after\|before\|position }` | 作者/管理员 |
| PUT | `/api/docs/:id/blocks/:blockId` | 改一块的 props | 作者/管理员 |
| DELETE | `/api/docs/:id/blocks/:blockId` | 删一块 | 作者/管理员 |
| POST | `/api/docs/:id/blocks/:blockId/move` | 移动一块，body `{ after\|before }` | 作者/管理员 |
| POST | `/api/docs/:id/reorder` | 整体重排，body `{ order: [blockId] }` | 作者/管理员 |
| POST | `/api/docs/:id/ops` | 声明式增量改动，body `{ ops: [...] }`；返回 `{ applied, rejected }` | 作者/管理员 |
| GET/PUT | `/api/docs/:id/markdown` | 文档 ⇄ Markdown（双向无损投影） | 读按 scope / 写作者 |
| POST | `/api/docs/:id/apply-template` | 套模板，body `{ key, mode:'replace'\|'append' }` | 作者/管理员 |
| GET | `/api/docs/:id/export` | 导出为 `forum-doc/1` 格式 JSON | 读按 scope |
| GET | `/api/docs/:id/revisions` | 修订记录（保留最近 50 条） | 读按 scope |
| POST | `/api/docs/:id/rollback` | 回滚到某一版，body `{ revision }` | 作者/管理员 |
| POST | `/api/docs/:id/capabilities` | 沙箱块申请能力，body `{ blockId, capability, payload }`；能力限 `doc-meta` / `doc-blocks` / `viewer` / `state` 四种，放行与否都记审计 | 登录 |
| GET | `/api/docs/:id/capabilities` | 沙箱能力调用审计（最近 `limit` 条） | 站长/管理员 |
| POST | `/api/docs/:id/sandbox` | 开关沙箱，body `{ disabled }` | 站长/管理员 |
| GET | `/api/docs/:id/polls` | 这篇文档里每个 `poll` 块的票数：`{ polls: { bN: { counts, total, voters, mine, multiple } } }`（0 票的块也有桶） | 读按 scope |
| POST | `/api/docs/:id/blocks/:blockId/vote` | 投票，body `{ options: [...] }`（**提交完整选择集合**，不是增量）；再投即改票 | 登录 |
| GET | `/api/docs/:id/anchor` | 这篇的**互动锚点帖**：`{ post }`（帖子列表形状），还没同步出锚点就是 `{ post: null }`；**不涨浏览量**（阅读页的互动条用它，而不是去调 `/api/posts/:id`） | 按 scope |
| GET | `/api/docs/by-anchor/:postId` | 反查：这条帖子是哪篇积木的影子行？`{ doc: { id, title, scope } }`，看不见就是 `{ doc: null }`（`#/post/:id` 与 `#/edit/:id` 的改道都靠它反查） | 按 scope |
| GET | `/api/docs/meta/templates` | 模板清单 + `kinds` + `scopes` 枚举（唯一真相）。对外永远只有 **8 个** —— 注册表里其实还躺着第 9 个 `announce`（`staffOnly: true`），`templateList()` 会把它滤掉，只给站务公告用，新建积木时看不见它 | 公开 |
| GET | `/api/docs/meta/block-types` | 块类型清单（内置 15 种 ∪ 库里注册的），含声明式 schema | 公开 |
| POST | `/api/docs/meta/block-types` | 注册自定义块类型（名字 `^[a-z][a-z0-9_]{0,31}$`，内置名与重名 409）；`rendererKind:'declarative'` 可带 `renderer:{html:'…{{字段}}…'}`（会剥掉 script/内联事件/`javascript:`），`'sandbox'` 则用 schema 里的 `code` 走玻璃房 | 登录 |
| POST | `/api/docs/meta/import` | 按 `forum-doc/1` 格式导入一份新文档 | 登录 |
| GET | `/api/docs/meta/script-templates` | 我的脚本模板清单：`{ templates, limit, maxName, maxDescription, maxCode }`（模板只自己可见） | 登录 |
| GET | `/api/docs/meta/tags` | 标签用过的清单 `{ tags: [{ tag, count }], maxTags: 5, maxTagLength: 24 }`（只统计**当前用户看得见**的文档 —— 私有文档的标签不在这里泄露存在性）；编辑器的「标签框上限 + 大家在用」用它 | 公开 |
| POST | `/api/docs/meta/script-templates` | 存一个脚本模板，body `{ id?, name, description?, code }`；不带 `id` 是新建（重名 409、超过 50 个 400），带 `id` 是覆盖 | 登录（只能改自己的） |
| DELETE | `/api/docs/meta/script-templates/:id` | 删掉自己的一个脚本模板（别人的 / 不存在的统一 404） | 登录（只能删自己的） |
| POST | `/api/docs/notes/import` | 把一篇笔记接成文档，body `{ name, title, markdown, scope }`；幂等 | 登录（只能导自己的） |
| GET | `/api/docs/notes/lookup` | 按 `ownerId` + `name` 找笔记对应的文档；用 `{ found }` 标记而不是 404 | 按 scope |
| GET | `/api/docs/profile/:username` | 按用户名找 `kind='profile'` 的主页文档；同样用 `{ found }` 标记 | 按 scope |
| GET | `/api/docs/wiki` | wiki 目录：`{ pages, categories }`（只列当前用户看得见的页；没分类的排最后） | 公开（按可见范围过滤） |
| GET | `/api/docs/wiki/:name` | 按标题找一页 wiki（`template='page'`），连同 `nav` 边栏一起回；看不见与不存在都回 `{ found:false }` | 按 scope |
| POST | `/api/docs/wiki/:name` | 打开或**新建**一页 wiki（body `{ scope }`，默认 `public`）；返回 `created` 标记 | 登录 |
| PUT | `/api/docs/:id/wiki` | 给一页 wiki 定分类与排序，body `{ category, sortOrder }`；回新的 `nav` | 作者/管理员 |
| GET | `/api/teams` | 团队列表，支持 `mine=1`（我加入的）`page` `perPage`；未登录也能看 | 公开 |
| POST | `/api/teams` | 建团队，body `{ name, slug?, intro?, joinPolicy? }`；中文名派生不出 slug 时自动生成 `team-xxxx`；**建好就带一个 6 位团队号，之后不会变** | 登录（每小时 5 个） |
| GET | `/api/teams/:id` | 团队详情（`:id` 可以是数字 id 或 slug）：`{ team, members, memberTotal, scopes }`；`team.joinCode` 与 `team.announcement` **只对成员给值**，外人拿到 `null` | 公开 |
| PUT | `/api/teams/:id` | 改名字 / 简介 / **加入方式**；body 里再带 `listed`（`'1'` / `'0'`）时还改「要不要出现在团队广场」——这一项**只有创建者**能动，管理员带上它会 403；`listed` 取值不是是/否 → 400 `bad_flag` | 团队管理员（`listed` 仅创建者） |
| PUT | `/api/teams/:id/announcement` | 写 / 改团队公告，body `{ announcement }`（≤ 2000 字，空串 = 撤下）；正文非空时给全体成员各发一条 `team_announcement` 通知，返回 `{ team, notified }`（`notified` = 实际收到的人数） | 团队管理员（每 10 分钟 10 次） |
| DELETE | `/api/teams/:id` | 解散团队（软删除） | **仅创建者** |
| GET | `/api/teams/:id/members` | 成员列表（创建者 → 管理员 → 成员，同类按加入时间）。**拉人进团队的 `POST` 已经删掉**，成员只能自己加入、递申请或凭团队号进来 | 公开 |
| POST | `/api/teams/join-by-code` | 凭 6 位团队号加入，body `{ code }`。**故意不看加入方式**：号就是邀请函，`apply` 的团队也走这里。号错 → 404 `team_not_found`，位数不对 → 400 `bad_join_code`；已经是成员就幂等返回 | 登录（每 10 分钟 20 次） |
| POST | `/api/teams/:id/join` | 加入团队。`open` 直接进（`joined:true`）；`apply` 递一条申请（body `{ message? }` ≤ 200 字，回 `requested:true` + `request`，同时给全体团长 / 管理员发 `team_join_request` 通知，已在待审就返回原来那条、不重复发）； | 登录 |
| POST | `/api/teams/:id/leave` | 退出团队；创建者不能退出（只能解散或转交） | 登录 |
| GET | `/api/teams/:id/join-requests` | 加入申请列表，`?status=pending`（默认）/`approved`/`rejected`/`all`，`?page=`；回 `{ items, page, perPage, total, totalPages, status, pendingTotal }`，每条带申请人的用户名 / 头像与 `canDecide` | 团队管理员 |
| PUT | `/api/teams/:id/join-requests/:requestId` | 批 / 拒，body `{ action: 'approve' \| 'reject' }`。批准顺便入队并给申请人发 `team_join_approved`，拒绝发 `team_join_rejected`，回 `{ request, member, team }`；已经处理过的 → 400 `join_request_decided`，`action` 不认识 → 400 `bad_action` | 团队管理员 |
| DELETE | `/api/teams/:id/join-requests/:requestId` | 撤销 / 清掉一条申请记录 | 申请人本人或团队管理员 |
| PUT | `/api/teams/:id/members/:userId` | 改成员角色（只能设 `admin` / `member`） | 仅创建者 |
| DELETE | `/api/teams/:id/members/:userId` | 踢人，或自己退自己；创建者不可被移出 | 团队管理员 |
| GET | `/api/teams/:id/posts` | 团队帖子列表；未登录只会看到 `public` 的那几条 | 按 scope |
| POST | `/api/teams/:id/posts` | 在团队里发帖，body `{ title, content, scope }` | 团队成员（每 10 分钟 30 条） |
| GET | `/api/teams/:id/posts/:postId` | 帖子详情。**未登录访问非公开帖 → 401；已登录但无权 → 404**（404 而不是 403，否则能枚举出「哪些帖子存在」） | 按 scope |
| PUT | `/api/teams/:id/posts/:postId` | 保存，body `{ title, content, scope, version, force? }`。版本对不上 → **409 `conflict`**，带上 `force:true` 再提交才覆盖 | 作者或任何能看见它的团队成员 |
| DELETE | `/api/teams/:id/posts/:postId` | 删帖（软删除）。**与编辑故意不对称**：不可逆的破坏性操作只留给作者和团队管理员 | 作者/团队管理员 |
| GET | `/api/teams/:id/posts/:postId/replies` | 帖子下面的回复，时间**正序**（回复是对话）分页 `{ items, page, perPage, total, totalPages }`。可见性**完全跟着帖子**：公开帖路人读得到，「仅团队」的对未登录 401、局外人 404 | 按帖子的 scope |
| POST | `/api/teams/:id/posts/:postId/replies` | 回复，body `{ content }`（1–5000 字）。**先判帖子看不看得见，再判是不是成员** —— 反过来，403 那句「加入这个团队之后才能回复」就是隔着墙承认帖子存在 | 团队成员（每 10 分钟 60 条） |
| DELETE | `/api/teams/:id/posts/:postId/replies/:replyId` | 删回复（软删除），回 `{ deleted, id, replyCount }`。路径带着 `:postId`，跨帖拼 id 直接 404；**重复删返回成功**（幂等） | 作者本人 / 团队管理员 |
| GET | `/api/teams/:id/files` | 文件柜列表 `{ items, page, perPage, total, totalPages, maxBytes }`；每行带 `downloadUrl` 与 `canDelete` | 团队成员 |
| POST | `/api/teams/:id/files` | 上传，body `{ name, dataUrl }`（`data:<mime>;base64,` 的 data URL，单个 ≤ 4 MB）。**这一条路由的请求体上限单独放宽到 6 MB** | 团队成员（每 10 分钟 30 个） |
| DELETE | `/api/teams/:id/files/:fileId` | 删文件（先软删库、再删盘） | 上传者 / 团队管理员 |
| GET | `/api/team-files/:fileId` | 下载。直接回二进制附件（`attachment` + `application/octet-stream` + `nosniff`），**不是** `{ok,data}` 信封 | 团队成员（404 之外的越权一律 403） |
| GET | `/api/teams/:id/messages` | 群聊记录 `{ items, latestId, total }`；`?after=<id>` 只取新的（前端 5 秒轮询用）、`?limit=`（默认 30，上限 100） | 团队成员 |
| POST | `/api/teams/:id/messages` | 发消息，body `{ content }`（1-1000 字） | 团队成员（每分钟 60 条） |
| DELETE | `/api/teams/:id/messages/:messageId` | 删消息 | 作者 / 团队管理员 |

**AI 编辑台（`/api/ai-edit`）** —— 前缀为什么不是 `/api/ai/`：`forum-ai` 的挂载层把 `/api/ai/` 下**所有**路径都短路了（没命中它那 15 条路由就直接 404，永远不回宿主路由表），所以宿主自己的 AI 路由另起一段前缀。
这一套的链路是「**先授权能力 → 再草拟（只预览）→ 确认后才落盘 → 每一步留审计**」；落盘本身仍由前端调上面那张表里的 P2 接口完成，AI 模块不自己写文档（这样沙箱、块校验、快照、`blocks.derived` 那套规则一套都不用重写）。

| 方法 | 路径 | 说明 | 权限 |
| --- | --- | --- | --- |
| GET | `/api/ai-edit/capabilities` | 能力目录 + 我的授权状态（**目录里只有 `edit_content` 一项**，默认关闭；另外五项没接线的空开关 2026-10 已删） | 登录 |
| GET | `/api/ai-edit/grants` | 我的授权列表（有效期 + 每日额度） | 登录 |
| POST | `/api/ai-edit/grants` | 授权；高风险能力（现在只有 `edit_content`）要 `confirm: true` | 登录 |
| DELETE | `/api/ai-edit/grants/:capability` | 收回授权（立即失效） | 登录 |
| GET | `/api/ai-edit/ops` | 我的 AI 操作日志（预览 / 已落盘 / 被拦下三类） | 登录 |
| POST | `/api/ai-edit/ops` | 提交一次改动：不带 `confirm` 只预览；带 `confirm: true` 过全站预算闸门并记一条 applied 审计。`scope` 支持 `block` / `section` / `document` | 登录 + `edit_content` |
| POST | `/api/ai-edit/ops/:id/rollback` | 回滚一次操作 | 登录 + `edit_content` |
| POST | `/api/ai-edit/draft` | 草拟**一块**，body `{ instruction, block, documentId?, blockId? }` | 登录 + `edit_content`（10 次/分钟） |
| POST | `/api/ai-edit/sections` | 按 `#` 标题把块切成小节（纯切分：不调模型、不落库、不花钱） | 登录 |
| POST | `/api/ai-edit/draft-range` | 草拟**一节或整篇**；整篇的 patch 要么是 `{ markdown }`，要么只回 `{ template: '<模板 key>' }`（此时 `writeTo` 指向 `/api/docs/:id/apply-template`，模板 key 只能是站里那 8 个） | 登录 + `edit_content`（5 次/分钟） |
| POST | `/api/ai-edit/review` | **审查**（原「AI 学术审查」的接班人）：body `{ documentId, blocks? \| markdown?, instruction? }` → `{ summary, findings: [{ blockId, kind, severity, quote, issue, suggestion, patch }], strengths, dropped }`。**只出意见、不落盘**；`quote` 在原文里找不到的意见会被丢掉并计入 `dropped` | 登录 + `edit_content`（5 次/分钟） |
| GET | `/api/ai-edit/usage` | **我的**用量与估算金额（今日/本周/本月，token + 次数）。响应按人分层：`scope: 'me'` 只带 `me` 这一块；站长/管理员拿到的是 `scope: 'site'`，额外带 `site`（全站今日、本月/本周汇总、**本月每天**的明细与预算状态）。全站那块**不在普通用户的响应里**，不是前端藏起来 | 登录 |

> **提示词才是这一层真正的产品**：块类型有十几种、其中两种还会**跑代码**（`app` 小应用 / `script` 脚本），光把类型名字丢给模型，它既不知道 `poll` 的 `options` 是 `[{id,text}]`、也不知道沙箱里能申请什么能力、更不知道申请会 5 秒超时 —— 于是用户说「帮我做个投票」，回来的只是一段正文。
> 所以 `src/modules/ai/syntax.js` 里手写了一份**给模型看的积木说明书**：每类块的 props 逐字示例、结构化围栏写法、沙箱六项能力与超时、以及「什么时候该用 `app` 而不是正文」的取舍规则；`blockPromptRules()` 每次把它拼进系统提示词。
> 这份说明书是**手抄**的（骨架规范不许业务模块互相 import），漂移由 `scripts/ai-smoke.mjs` 第 19 节的哨兵盯着：块类型清单与 8 个模板 key 都跟 P2 的真相逐项对拍，对不上就红。


> **团队为什么没有站长后门**：团队管理只认 `team_members` 里的 owner / admin，站长（`role='owner'`）也不例外。
> 一旦站长能管理任意团队，他就能把自己加进一个「需要申请」的团队然后读到里面的帖子 —— 那是一条提权通道。
> 读取侧同理：少给一个后门最多是管理员看不到，多给一个就是一次不可逆的泄露（内容还会被搜索、被 AI 索引）。
>
> **上传为什么走 JSON + base64**：全站零依赖、不引 npm，手写 multipart 解析要处理 boundary、分片、多文件、
> 每个字段的 CRLF，上百行边界代码只换来省掉 33% 的编码膨胀 —— 不划算。代价是这条路由要单独放宽请求体上限，
> 所以 `route()` 多了第 4 个可选参数 `{ bodyLimit }`，**只有上传用它**；抬全站上限等于让每条接口都更容易被大请求体打死。
>
> **文件柜与群聊不做拉黑过滤**（帖子与动态会做）：团队是成员制空间，拉黑是广场层面的关系。
> 套进来只会让聊天记录出现空洞、文件柜莫名少东西 —— 是想过之后决定的，不是漏了。
> 两条都只认 `team_members`：未登录 401，登录了但不是成员 403（团队主页本身公开，装 404 没意义，要守的是里面的东西）。
> 下载一律按附件下发：即使有人传 `.html` / `.svg`，也不会在本站源里被当成页面渲染（存储型 XSS 的常见入口）。
>
> **团队号为什么只发给成员**：团队号能直接进队、绕过「需要申请」，等于一张万能门票 ——
> 泄露给外人，`join_policy='apply'` 这个设置就作废了。所以 `shapeTeam` 里它与公告同一道门：
> `joined || canManage` 才给值，否则一律 `null`（连「有没有号」都看不出来）。
> 凭号加入**不受加入方式限制**是故意的：号就是那封邀请函，再叠一层设置只会让人卡在门口。
> 号用 `crypto.randomInt` 生成、建队时定死没有「换号」操作，配合部分唯一索引（`WHERE join_code <> ''`）
> 与启动时的幂等回填 —— 老库的团队也能补上号，空串不参与唯一性，所以补列、补号、建索引的先后顺序不会打架。
>
> **为什么把「拉进团队」删掉**：原来团长 / 管理员敲一个用户名就能把人拽进来，当事人连知都不知道、
> 也没有拒绝的机会；而且被拉进来的人不需要任何同意，等于把「谁能进」这件事整个交给了别人。
> 现在的两条路都要当事人自己动手：**凭团队号加入**（号 = 邀请函）或**递申请被批准**。
> 顺带一个好处：把「加入方式」设成 `apply` 之后，审核记录（谁在什么时候申请、写了什么理由、谁批的）
> 全部留在 `team_join_requests` 里，出事能查；拉人那条路是查不出痕迹的。
> 旧库的 `join_policy='invite'` 在重建表时翻译成 `'apply'`（语义一样：都得有人批），迁移是幂等的。
> **重建表时踩过的坑（一次真实的线上 500，值得引以为戒）**：最早那版重建是
> `ALTER TABLE teams RENAME TO teams_old` → 建新表 → 搬数据 → `DROP TABLE teams_old`。
> 那段代码的注释写着「先把外键关掉，RENAME 就不会去改别的表里的 `REFERENCES`」——
> **这条是错的**：SQLite 3.25+ 的 `ALTER TABLE … RENAME TO` 会顺手改写其它表 DDL 里的
> `REFERENCES "teams_old"(id)`，只看 `PRAGMA legacy_alter_table`（默认 OFF），**与 `foreign_keys` 无关**。
> 于是六张子表都指向了一张已经被删掉的表：用团队号加入（写 `team_members`）、团队发帖（写 `team_posts`）、
> 退出团队（删 `team_members`）、群聊、文件柜、回复 —— 全部报 `no such table: main.teams_old`，对外统一是 500
> `internal_error`。**新库不受影响**，所以十二套自检（用的都是新库）全绿也照样漏掉了它。
> 现在的两处保险：重建一律「先建新表 → 搬数据 → 删旧表 → 把新表改名」（全程不改旧表的名字），
> 并在 `migrateTeamTables` 的第一步跑一次**幂等自愈**（扫 `sqlite_master` 里还引用 `teams_old` 的表，
> 按存下来的 DDL 原地重建它们），所以本地与线上那两份已经坏掉的库，**升级后第一次启动就自己好了**。
> `team-smoke` 里两个场景（上一版形状的老库 / 照老写法弄坏的库）把这件事钉住了。
> doc 那边重建 `document_revisions`（让 `reason` 的 CHECK 收下 `adopt`）原来用的是同一套错顺序，
> 只是今天还没有任何表引用它、所以没炸 —— 一并改成正确顺序并钉进契约，别等有了子表再踩第二次。
> 「要不要出现在团队广场」是**创建者独有**的一条线（和「解散团队」同级）：管理员能改队名 / 简介 / 加入方式，
> 但带 `listed` 去改会 403 —— 藏不藏一个团队是它的身份问题，不是日常运营。
> 隐藏只是「不被发现」：广场列表不再列它，团队主页、团队号、帖子链接照旧能用，
> 已加入的成员在自己的列表里还看得见（否则他连怎么回队里都不知道）。
>
> **公告为什么不合并通知**：其余通知都靠「同一 actor + 同一类型 + 同一对象 + 未读只留一条」防打扰，
> 公告是**一次广播**，改一次就该响一次，所以 `createNotification` 为此多了一个 `dedupe: false`。
> 清空公告（空串）不发通知 —— 没有正文可看，把人叫来只看一条「公告撤了」是打扰。
> 写公告的人自己不算收件人（`createNotification` 本来就不给自己发），所以 `notified` = 成员数 − 1。
> 加入申请**走默认去重**：同一个人反复递申请（被拒 → 再申请）只会留一条未读，
> 团长不需要看十条一模一样的「有人想加入」。三条通知（`team_join_request` / `team_join_approved` /
> `team_join_rejected`）都跳 `#/team/<slug>`，点进去就是那个团队。

---

## 6. 数据模型

```
users(id, username, display_name, password_hash, role, bio, avatar, banned,   -- role: owner | admin | member
      created_at)
sessions(token, user_id, created_at, expires_at)
boards(id, slug, name, description, icon, sort_order)
posts(id, board_id, user_id, title, content, views, pinned, locked, deleted,
      category_id, profile_pinned, profile_pinned_at, created_at, updated_at,
      hidden, hidden_at, hidden_by, hidden_reason)
replies(id, post_id, user_id, content, deleted, created_at)
reactions(user_id, post_id, kind)        -- kind: like | dislike，联合主键保证赞踩互斥
bookmarks(user_id, post_id, created_at)  -- 私密收藏
follows(follower_id, followee_id, created_at)
notifications(id, user_id, actor_id, type, post_id, reply_id, team_id, excerpt, read_at, created_at)
                                             -- team_id 只有团队公告用，指回是哪个队发的（故意不加外键：
                                             -- teams 归团队模块自建，两边谁先建不确定，理由同 feed_items.team_id）
reposts(id, post_id, user_id, comment, created_at)          -- 转发，(user_id, post_id) 唯一
profile_categories(id, user_id, name, sort_order, created_at)
moderation_logs(id, actor_id, action, target_type, target_id, target_label, reason, created_at)
messages(id, sender_id, recipient_id, content, read_at, created_at)
blocks(blocker_id, blocked_id, created_at)   -- 黑名单，主键 (blocker_id, blocked_id)

-- 可编程帖子（积木，P2）：写在 src/modules/doc/，不放进 src/core/open-db-support.js
documents(id, user_id, kind, title, scope, template, anchor_post_id,
          sandbox_disabled, deleted, created_at, updated_at)   -- kind: post | note | profile
document_blocks(id, document_id, block_id, type, type_version, position, props_json,
                created_at, updated_at)   -- block_id 形如 b1，(document_id, block_id) 唯一；position 是 REAL，插中间取中点
document_revisions(id, document_id, revision, blocks_json, reason, author_id, created_at)
                    -- reason: create | edit | ops | template | import | rollback，每篇保留最近 50 条
doc_block_types(name, version, label, icon, props_schema_json, renderer_kind, renderer_json,
                created_by, created_at, updated_at)   -- 全局注册表，内置 15 种优先、不可被覆盖
doc_script_templates(id, user_id, name, description, code, created_at, updated_at)
                    -- 「我的脚本模板」（开发者功能）：(user_id, name) 唯一，每人最多 50 个，
                    --   code 是沙箱脚本原文；存下来只为「一键新建一篇」时少粘一次
doc_capability_logs(id, document_id, block_id, capability, user_id, allowed, created_at)
                    -- 沙箱能力调用的审计流水：被拒也记一行
doc_tags(document_id, tag, created_at)
                    -- 积木的标签，主键 (document_id, tag)，索引 (tag, document_id)。
                    --   单开一张表而不是给 documents 加列：已存在的库上 CREATE TABLE IF NOT EXISTS
                    --   不会补列，而 core 的 ensureColumn 只管 users / posts（「新状态开新表」是既定习惯）。
                    --   一篇最多 5 个、每个最多 24 字；标签是用户自由写的词，不是预置枚举。
                    --   点标签进 #/docs?tag=xxx（后端 GET /api/docs?tag=，大小写不敏感）。
                    --   学术笔记功能已并进这里：写积木打 #学术笔记 标签即可（#/notes 入口下线、代码保留）
note_documents(user_id, note_name, document_id, created_at)
                    -- 笔记子系统 ⇄ documents 的接线表，(user_id, note_name) 唯一

-- 团队（P4）：写在 src/modules/team/，不放进 src/core/open-db-support.js
teams(id, slug, name, intro, owner_id, join_policy, listed, join_code, announcement,
      announcement_by, announcement_at, deleted, created_at, updated_at)
                    -- slug 唯一（团队地址，如 #/team/wenlan）；join_policy: open | apply
                    --   open = 谁都能加入；apply = 递申请、由团长 / 管理员批准
                    --   （老库的 invite 在重建表时翻译成 apply，只是改名的等价语义；
                    --    重建**不能**把旧表改名成 teams_old —— 见上面那段线上 500）
                    -- listed: 1 | 0 —— 要不要出现在团队广场上，**只有创建者**能改；
                    --   0 只是「不被发现」，团队主页 / 团队号 / 帖子链接照旧可用
                    -- join_code 是 6 位团队号：部分唯一索引 WHERE join_code <> ''（空串不参与唯一性，
                    -- 老行才能先补列、再补号、最后建索引）；索引不写在核心建表脚本里，
                    -- 因为老库执行那段 SQL 时这一列还不存在
                    -- announcement 空串 = 没有公告；撤下时 announcement_by / announcement_at 一并置空
team_members(team_id, user_id, role, joined_at)
                    -- 主键 (team_id, user_id)：一个人在一个团队只有一行
                    -- role: owner | admin | member，owner 唯一且不可退出
team_join_requests(id, team_id, user_id, message, status, decided_by, decided_at,
                   created_at, updated_at)
                    -- 加入申请：status: pending | approved | rejected（拒绝后可以再申请一条新的，
                    -- 旧的那条留着当记录）；message 是申请理由，≤ 200 字，可空
                    -- decided_by / decided_at 记「谁在什么时候批的」，出事能查
                    -- 部分唯一索引 idx_team_join_requests_pending(team_id, user_id)
                    --   WHERE status = 'pending'：同一人对同一团队同时只能有一条待审，
                    --   靠数据库挡并发，不靠应用层先查后写（两个管理员同时点批准只有一个能成功）
team_posts(id, team_id, user_id, title, content, scope, version, updated_by,
           deleted, created_at, updated_at)
                    -- scope 与 feed / documents 共用同一套四档枚举
                    -- version 从 1 开始，保存时把版本号带上；对不上就是 409，
                    -- 不静默覆盖 —— 这是「改自己的帖（同一个人的两个标签页）也不静默覆盖」的落点
team_replies(id, post_id, team_id, user_id, content, deleted, created_at)
                    -- 帖子下面的一句话：**故意不带 scope / version** —— 可见范围由它挂着的那篇帖子
                    -- 决定（回复的可见性就是帖子的可见性），并发编辑对一个回复框也没意义
                    -- team_id 是故意冗余的一份：判「我在这队里是什么角色」不用绕道 team_posts
                    -- 索引 idx_team_replies_post(post_id, deleted, created_at, id) 正是列表那条查询的形状；
                    -- 软删除只置 deleted = 1，删完留一行壳，编号不乱
team_files(id, team_id, user_id, name, mime, size, stored_name, deleted, created_at)
                    -- name 是用户给的名字（只做展示），stored_name 是服务端合成的磁盘名
                    -- 删文件 = 软删库 + 删盘，顺序不能反（先删库再删盘，盘删失败也不会留下
                    -- 一条指向不存在文件的记录）
team_messages(id, team_id, user_id, content, deleted, created_at)
                    -- 群聊按 id 递增读（？after=<id> 增量拉），列表展示时再翻成正序
```

设计要点：

- **软删除**：删帖/删回复只置 `deleted = 1`，数据可追溯，也不会破坏点赞、收藏的外键。
- **日期只按天算**：日历相关的日期统一用本地时区的 `YYYY-MM-DD` 字符串（见 `src/dates.js`），避开用时间戳做日历运算的时区坑。
- **评价互斥**：`reactions` 用 `(user_id, post_id)` 做主键，一个用户对一篇文章只可能有一行记录。
- **通知去重**：写通知前先查「同一 actor + 同一类型 + 同一对象 + 未读」是否存在，存在就跳过。**团队公告是例外**（`createNotification({ dedupe: false })`）：一次广播要响一次是一次，改两回就该有两条未读。
- **分类归属校验**：只能把文章放进自己的分类，服务端逐次校验，前端下拉框只是便利。
- **积木的影子行**：每份文档在 `posts` 里留一条只做互动锚点的行（`anchor_post_id`），赞/踩/收藏/通知因此**零改动**复用；`hidden` 由文档 scope 决定，`public` 的文档还会把标题与纯文本摘要同步过去，所以旧列表与搜索照样能用它。代价（已知短板）：`hidden=1` 的影子行对非站长非作者是 404，所以 `followers` / `team` 可见的文档，**别人点不了赞**。
- **降级永不白屏**：块类型没注册、`props_json` 坏了、props 不合法、`bind` 成环、沙箱 2 秒没 `ready` —— 一律渲染成 `doc-block-unknown` 占位并往响应的 `warnings[]` 里记一条，绝不抛异常。
- **沙箱是浏览器给的，不是自己写的**：`<iframe sandbox="allow-scripts">`（**不给** `allow-same-origin`）+ iframe 内 CSP `default-src 'none'`，服务端从不执行用户代码，只做转义与拼装；消息白名单只有 `ready` / `resize` / `value` / `request` 四种，能力调用逐条记审计。用户注册的沙箱块类型（`rendererKind:'sandbox'`）走的是同一个玻璃房，不是另一条路。
- **JSON 是数据，JavaScript 才是行为**：`props` + schema 只负责「这块有哪些字段」（数据），凡是「这块要做什么」（行为）都写在 `app` 块的 `code` 里，跑在沙箱 iframe 中。沙箱里那套 `Sandbox` API 是真能落东西的：`Sandbox.props` / `inputs` / `value(v)` / `resize()` 之外，`Sandbox.doc()` 读文档元信息、`Sandbox.blocks()` 读正文里每一块（能「按别的块算点东西」）、`Sandbox.viewer()` 读正在看的人（不透明源里连「我登录了吗」都读不到，所以由宿主递进去）、`Sandbox.state.get(scope)` / `set(value, scope)` **把状态存到服务端**（`user` 作用域各人一份、`shared` 全站一份；写下要登录，读匿名也给）。每个 API 都是一次可审计的能力申请，白名单之外一律 403 且照样留一行 `allowed=0`。**记住 `request()` 成功时 resolve 的就是值本身**（失败才 reject），不要写 `if (r.ok)`。
- **状态与内容分家**：投票的票落在 `doc_poll_votes`、沙箱状态落在 `doc_app_state`，**都不写回 `props`**。理由是同一条：`props` 是内容，改一次产生一条修订，把运行期数据写进去等于「作者改个选项 = 改掉所有人投的票」。两处都在块/文档被删时顺带清理，不留孤儿行。
- **块是可编程的，而且是真能编的**：`POST /api/docs/meta/block-types` 注册的声明式类型如果带了 `renderer:{html:'…{{字段}}…'}`，渲染时就按它出 HTML（`{{字段}}` 一律转义，模板里的 `<script>` / 内联事件 / `javascript:` 在渲染那一步被剥掉——注册是登录用户就能做的，模板会出现在每个访客的页面上）；不带模板才退回「字段名 → 值」的表。块的底层形状只有三样：`{ block_id, type, version, props }`，Markdown 里就是一围栏 ` ```doc:<类型> `；每一块在编辑器里都能展开「源码」直接改 props JSON，`bind` 是唯一保留字段。
- **Wiki 是有目录的多页面，不是一页带链接的帖子**：`template='page'` 标记「这一篇是 wiki 页」，`[[目标]]` 渲染成指向 `#/wiki/<标题>` 的真链接，`GET /api/docs/wiki/:name` 找页、`POST` 打开或**新建**（`[[还没写的页]]` 是正常用法），`PUT /api/docs/:id/wiki` 定分类与排序。`#/wiki/<标题>` 与 `#/doc/:id` 两个入口都会带回同一个 `nav` 边栏（分类分组 + 页内筛选 + 新建页；作者多一个「改分类」）——「有没有边栏」不该取决于用户从哪个链接点进来。边栏只列**当前用户看得见**的页：私有页不能因为名字出现在目录里而泄露存在性。双链在正文里怎么写都行：**独占一行**会被解析成一个 `wiki` 块（在 Markdown 往返里也是 `[[目标]]`），**夹在句子里**就是一个行内链接。
- **投票块是真的能投的**：服务端把选项渲染成 `<button>` 而不是裸 `<li>`（键盘能 Tab、屏幕阅读器认得出这是一组选项），票数由 `GET /api/docs/:id/polls` 填、点击走 `POST …/vote`。提交的是**完整选择集合**而不是增量：单选换一个就是换掉原来那个，再点自己那项是撤销。
- **公式复用站点原本那一套**：服务端只吐 `$…$` 原文，粘在积木页面与 Markdown 预览里的 `ntRenderMath(root)`（`public/views/notes.js` 的离线 KaTeX，`/notes/vendor/katex/**`）在 `innerHTML` 之后才排版 —— 与论坛动态那边完全同一条路，没有第二份数学渲染实现。**行间公式也一样**：`formula` 块渲染出 `$$…$$` 交给客户端 KaTeX，LaTeX 源码折叠在下面（排版失败时至少还看得到自己写了什么）。

### 从 v1.0 / v1.1 / v1.2 升级

升级是**原地完成**的，`openDatabase()` 里做了五件事：

1. 建新表（`reactions` / `follows` / `notifications` / `profile_categories` / `reposts`）；
2. 给 `posts` 补 `category_id` / `profile_pinned` / `profile_pinned_at`；
3. 把旧的 `likes` 表数据搬进 `reactions` 后删掉旧表，并把已有的回复 / 点赞 / 关注**回填成消息通知**；
4. 首次升级时给示例账号补上演示用的分类与主页置顶（`profile_categories` 非空就跳过，真实用户不会被塞假数据）；
5. 转发表为空时给示例账号补几条演示转发。

> 旧库里的 `checkins` / `checkin_bonuses`（签到）两张表、`coins` 表与 `users.coin_balance` / `users.coin_refresh_at` 两列**都不主动删除**：签到与价值排行、币系统都已下线（新库不再建这些表 / 列），但没人愿意在升级时替你丢掉历史数据。留着不占事，想清掉自己 `DROP TABLE` / `DROP COLUMN` 即可。

`data/backup-pre-upgrade.db` 是第一次升级前的自动备份（含 `-wal` / `-shm`），确认没问题后可以删掉。

---

## 7. 安全设计

- 密码使用 **scrypt** 加盐哈希（`scrypt$salt$hash`），校验用 `timingSafeEqual` 恒定时间比对。
- 会话是随机 24 字节 token，存库并设 30 天过期，Cookie 为 `HttpOnly; SameSite=Lax`；被封禁用户的会话会被立即删除；改密后其它会话全部吊销。
- **Markdown 渲染先整体 HTML 转义，再注入白名单标签**，因此正文里的 `<script>` 只会原样显示（冒烟测试有专门用例覆盖）。
- 链接白名单：仅允许 `http(s)` / `mailto` / 站内相对路径，`javascript:` 等伪协议会被降级为 `#`。
- 所有 SQL 使用预编译参数绑定，不存在字符串拼接注入。
- 登录、注册、发帖、回帖、改密、转发都有基于内存桶的速率限制；请求体大小、各字段长度均有限制。
- 分类、置顶、转发等写操作全部在服务端校验规则（上限、归属、可见范围），前端置灰只是体验优化。
- 静态文件做了路径穿越校验，响应带 `X-Content-Type-Options: nosniff`。

---

## 8. 测试

```bash
node scripts/check-golden.mjs      # ★ 行为金标准：88 条请求的状态码 + 响应结构，一条都不能变
node scripts/check-skeleton.mjs    # ★ 骨架自检：模块能不能独立拆掉、薄入口有没有变胖
node scripts/check-markdown.mjs    # ★ 正文渲染回归：72 项（站内链接 / 带括号 URL / 表格 / 嵌套列表 / 转义 / 危险协议 / 行内 HTML 白名单 / 列表里的块公式 / 兜底拷贝同步）
node scripts/check-frontend.mjs    # ★ 前端渲染冒烟：43 个页面全部渲染一遍 + 关注列表 / 主页关注名单卡（自己视角排文章前面、别人视角仍在最底下）/ 团队的文件柜/群聊/成员名单/团队号/公告/加入申请与审核/隐藏开关/设置与申请改右侧抽屉/帖子预览与详情回复（「💬 回复」按钮、编辑权只归作者）/ 动态回复 / 动态转发（点开才画框、发得出当前原文、计数跟着走、转不了的画静态计数）/ 积木页转发（转得出、发完留在原地、撤销得掉、互动条跟着重画）/ 转发出来的卡片写「转发了帖子」而纯引用写「引用了帖子」/ 转发的引用卡带着 `#/feed/<原动态 id>`（原动态删了就变回死块，不再假装能点）/ 公告页翻页带页码而首页那块只要 5 条 / AI 编辑台的用量面板（自己那份三行 + 全站的今日/本周/本月、「本月每天」那张表的五列表头、三路来源清单与每路本月自己的钱 —— 「首次渲染就得在场」，用法接口故意晚一个宏任务回来盯着它）/ 交互 + 裸调用未定义名字的静态扫描
node scripts/smoke.mjs             # 后端端到端：237 项（临时独立库+端口，跑完自动清理）
node scripts/smoke-ai.mjs          # AI 接口端到端：93 项（含逐篇过期判定：新增别篇不让老解读过期、改了这一篇自己才标过期；删掉的那篇不再算进已解读（记进 orphans）；问答预算 4000、问答关掉思考模式（只有解读/整理全站开着）与「被截断就缩材料、在提问里要短答案再问、再截断给一句人话」；回答排版要求（分段 / 小标题 / `- ` 列表）与 800 字上限；上游 JSON 里带字面换行也能解析；语料检索（标题 + 正文）与未登录 401；全站问答的选材上限与材料体积）
node scripts/ai-smoke.mjs          # AI 接口端到端（更细的一套：校验 / 限流 / 额度 / 审查 / 模板与提示词漂移哨兵 / 能力目录只列接上了线的能力 / 用量面板分层 / 三源合并（论坛 AI 与笔记那两本账也进面板、逐篇解读只进全站）/ 跨日界的计数口径哨兵）：486 项
node scripts/feed-smoke.mjs        # 动态流端到端：191 项（含动态回复、动态转发、帖子转发也发到动态、「仅团队」的可见范围）
node scripts/doc-smoke.mjs         # 积木（可编程帖子）端到端：694 项（含阅读页的回复区与转发区）
node scripts/team-smoke.mjs        # 团队端到端：306 项（可见范围 / 越权 / 版本冲突 / 编辑权只归作者 / 文件柜 / 群聊 / 团队号 / 公告通知 / Markdown 与公式 / 帖子回复 / 加入申请与审核 / 隐藏团队 / 老库升级与坏库自愈）
node scripts/check-ui-contract.mjs # 前端契约：CSS 类名 + API 字段 + 主题/头像/角色/私信/团队号/公告/剪贴板/公式/关注列表（已关注按钮）/详情与回复/申请与隐藏结构/编辑权与侧边抽屉/表重建与自愈/币已下线/本地偏好键读写一致（通过项数不下降哨兵：317）
node scripts/ui-smoke.mjs          # 首页外壳轻量化 + 右侧栏抽屉 + 起始页与动态流地址 + 站务公告列表页 + 单条动态 #/feed/<id>（m05506 契约）+ 编辑区与积木块字段框的 Tab 缩进 + 登录失败的文案（401 不等于「登录过期」）：96 项
node scripts/check-encoding.mjs    # 源码编码体检：BOM / 乱码 / 关键中文内容
node scripts/check-notes-ui.mjs    # 笔记 UI
node scripts/notes-smoke.mjs       # 笔记接口
node scripts/sync-markdown-core.mjs        # 改了 src/markdown.js 之后同步 note-agent 的兜底拷贝
node scripts/sync-markdown-core.mjs --check # 只检查有没有漂移（CI 也跑这条）
node scripts/capture-fixtures.mjs  # 重采前端冒烟用的假数据（改了接口形状才需要跑）
```

> ⚠️ `scripts/reset-db.mjs` **不属于测试流程**（它以前被列在上面这段里，容易照着复制粘贴）：它会删掉 `data/forum.db`（连带 `-wal` / `-shm`）再重新播种，用户、帖子、私信全部**不可恢复**，`data/` 又不在版本库里。要清库请按「常见问题」里那条走，并且必须显式加 `--yes`。

> ⚠️ **正文渲染器只有一份**：`src/markdown.js`。`note-agent/src/markdown-core.mjs` 是它发给浏览器的**逐字拷贝**（面板在宿主没有 `/markdown/preview` 时用它兜底）。
> 改了宿主就必须跑一次 `node scripts/sync-markdown-core.mjs`，否则 `check-markdown.mjs` 与 note-agent 的测试都会红。
> 这条守卫是补上的：这份拷贝曾经漏掉块级 `$$` 公式而没有任何测试发现 —— 原来那条「与宿主一致」的断言比较的是宿主**自己**，恒真。

一次跑完（`npm test` 就是上面这些，15 组）：

```
check-encoding 211 文件 / 84 断言 · check-skeleton 47 项 · check-golden 88 项 0 差异
check-markdown 72 · check-frontend 43 个页面 + 34 个模块静态扫描 · smoke 237 · smoke-ai 93
ai-smoke 518 · feed-smoke 191 · doc-smoke 694 · team-smoke 306
check-ui-contract 325 · check-notes-ui 33 · notes-smoke 44 · ui-smoke 96
```

> 知识网络图（`knowledge-pack/` + `#/graph` + `/api/knowledge/*`）已在 2026-10 整条链路删除：
> 本地 `data/knowledge` 一直是空的，线上那两条接口永远回 `graph_not_built`，页面点进去只有一句
> 「知识网络图还没有生成」。现在这两个地址返回的是统一的 404 `not_found`，
> 而 `scripts/golden.json` 里的指纹只比对「状态码 + 键结构」，形状没变，所以指纹不用重采。
> 附带好处：以前本地留着 `data/knowledge/` 会让 `check-golden` 报两处假差异，这个坑跟着一起没了。

另外三组在各自的包里，`npm test` 不带它们：

```
node note-studio/tests/run.mjs        # 学术笔记子系统
node forum-ai/selftest.mjs            # AI 层：209 项
npm run test:notes                    # AI 工作台抽屉：32 个文件 / 724 条断言
```

**`check-golden.mjs` 是这套测试里最该先跑的一个**：它把 88 条固定请求的「状态码 + 响应 JSON 的键结构」
与 `scripts/golden.json` 逐条比对，**只管结构不管取值**（不会因为你发了一篇新帖就红）。
重构、搬家、改前端时先跑它 —— 绿了才说明「用户能感知到的行为一个字都没变」。
真的有意改了行为，用 `--write` 重采指纹，并在提交信息里说明为什么。
（`--dump` 只打印不比对；指纹文件不存在时它会**直接报错退出**，因为「改造完再补采」等于没测。）
「帖子写入下线」就是这么办的一次：88 条里只有 7 条指纹重采 —— `post-create` 系列
025 / 026 / 027 从 200 / 400 / 401 变成 410，`post-update` 的 028 / 029 从 404 变成 410，
`post-delete` 的 079 / 080 从 404 变成 410；其余 81 条（读接口、互动接口、后台接口）一字未动。

覆盖范围：静态资源与 SPA 回落、注册登录登出、**发帖 / 改帖 / 删帖接口已下线（`POST /api/posts`、`PUT /api/posts/:id`、`DELETE /api/posts/:id` 一律 410 `posts_retired`，读接口与互动接口照旧；互动那些断言现在打在**积木的影子锚点帖**上 —— 赞 / 踩 / 收藏 / 回复 / 转发走的还是影子行的 `posts.id`，所以用例照旧跑绿）**、**投币已下线（`POST /api/posts/:id/coin` 一律 404，`/api/site` 不再下发 `coinRules`，帖子形状里没有 `coinCount` / `myCoins` / `coinBalance`）**、主页分类（增删改查、上限、归属校验、按分类/未分类筛选）、主页置顶（上限 3 篇、取消置顶、越权 403）、**转发（成功计数、重复转发只改评语、撤销、自己的也能转、不能未登录转发、转发者列表、主页转发分类、通知原作者且自己转自己不发通知；动态转发与「帖子转发也发到动态」见 `feed-smoke.mjs`）**、**签到与价值排行已下线（`/api/checkin`、`/api/ranking` 一律 404，`/api/site` 不再下发签到规则与价值权重，帖子形状里没有 `baseScore` / `valueScore`，个人主页没有 `coinsReceived`）**、账号设置（昵称签名校验、改密校验旧密码、改密后其它会话失效 / 当前会话保留 / 新旧密码登录）、重复用户名、会话保持、分页、全文搜索、Markdown 转义、赞踩互斥、收藏、关注与关注流、消息通知的收件人与去重、越权访问后台、封禁等。

`check-ui-contract` 另有 15 条**静态守卫**钉住「删干净了」：签到与价值排行那边 7 条 —— 签到页文件不存在、服务端没有那两条路由、`CHECKIN_*` / `VALUE_WEIGHTS` / `rankPosts` / `checkin_bonuses` 等名字一个都不剩、样式分片只剩 `78-repost.css` 与 `80-profile.css`；币这边 8 条 —— 投币路由不存在、`COIN_RULES` / `COIN_SIGNUP_GRANT` / `COIN_PER_POST_LIMIT` / `coinAvailability` / `coinState` / `giveCoin` / `coinByUserPost` / `upsertCoin` / `addCoins` / `spendCoins` / `totalCoins` / `coin_count` 这些名字一个都不剩、`tables.sql.js` 不建 `coins` 表且它不在 core 的 `owns` 清单里、帖子与用户形状里没有 `coinCount` / `myCoins` / `coinBalance` / `canCoin`、`/api/site` 不下发 `coinRules`、通知类型里没有 `post_coin`、前端没有 `data-action="coin"` 与「我的资产」卡、样式里没有 `.coin-chip`。想把这套东西加回来的人，先得来改这几条断言。（这 15 条都匹配**去掉注释后**的源码，所以注释里写「旧库的 `coins` 表不主动删」不会把它们弄红。）

---

## 9. 常见问题

**Q：提示找不到 `node:sqlite` / 启动即报错？**
需要 Node 22.5 以上；用 `node -v` 确认，升级后重试。

**Q：端口被占用？**
`set PORT=4000 && node src/server.js`（PowerShell：`$env:PORT=4000; node src/server.js`）。
如果是上一次没关干净的服务，先 `netstat -ano | findstr :3000` 找到 PID 再 `taskkill /PID <pid> /F`。

**Q：想让同事在局域网访问？**
`set HOST=0.0.0.0 && node src/server.js`，然后用本机内网 IP 访问，例如 `http://192.168.1.10:3000`。

**Q：数据想全部重来（并获得最新版示例数据）？**
先停掉服务，然后**先跑一次不带参数的** `node scripts/reset-db.mjs`：它只列出将要删除的文件（用户、帖子、私信都在里面，删掉不可恢复）。确认这就是你要清的库，再加上 `--yes` 重跑：

```bash
node scripts/reset-db.mjs --yes
```

Windows 上如果报文件被占用，说明服务或测试脚本还在跑，关掉再试。

**Q：想调整规则数值？**
都在 `src/db.js` 顶部（实体在 `src/core/open-db-support.js`）：`PROFILE_PIN_LIMIT`（主页置顶数）、`PROFILE_CATEGORY_LIMIT`（分类数上限）。

**Q：排行榜、签到和币去哪了？**
删掉了（用户要求）。签到、价值排行、以及**币**这套东西都删掉了；赞/踩/收藏/转发/关注/回复这些评价方式不受影响。

**Q：想部署到线上？**
把它挂在 Nginx/Caddy 后面即可（记得配 HTTPS 并把 Cookie 换成 `Secure`），单进程足够支撑小型社区；`data/forum.db` 记得做定时备份。上线的第一件事是**改掉 admin 的演示密码**（登录后到 `#/settings` 修改）。

**Q：想扩展功能？**
先读 [`docs/skeleton.md`](docs/skeleton.md)。现在的分工是：**表结构**由 `src/modules/<模块>/index.js` 的 `owns`
声明、建表 SQL 用 `ctx.schema.add(...)` 登记；**接口**用 `ctx.routes.add(method, pattern, handler)` 注册，
响应统一走 `ctx.http.ok()`；**权限**用 `ctx.guards.requireUser/requireStaff/…`；**前端页面**加一个
`public/views/x.js` 并在 `public/core/router.js` 的 if 链里接一行。
不要 import 隔壁模块的文件（模块之间只通过 `ctx` 通信，`check-skeleton.mjs` 会抓）。
新增通知类型只需调用 `store.createNotification()`，并在 `public/views/notifications.js` 的 `NOTIF_META` 里补一条文案。
（要「每条都响、不合并未读」就传 `dedupe: false`；要让通知能跳回某个团队，传 `teamId` 并把类型加进
`public/views/notifications.js` 的 `notifTarget()`，团队公告就是照这个路子接的。）
**改完务必跑 `node scripts/check-golden.mjs`** —— 它保证你没顺手改坏现有页面。

---

## 10. 已知短板与还没做的

这一节是**诚实的缺口清单**，不是路线图承诺。每条都写清现象和根因，方便想接手的人直接定位。

### 10.1 帖子已经退成纯粹的互动锚点（写入下线，留档）

**一句话**：帖子功能整体废除 —— 站内**一切**通往 `#/post/:id` 的链接都改道它对应的积木
（`public/views/post.js` 的 `viewPost(id)` 用 `GET /api/docs/by-anchor/:id` 反查，查到就
`location.replace('#/doc/<docId>')`；`#/edit/:id` 同理送去 `#/doc/<docId>/edit`），
`POST /api/posts`、`PUT /api/posts/:id`、`DELETE /api/posts/:id` 一律 `410` `posts_retired`，
而正文、回复、评价、AI 面板**全部只在积木页上**。这一节解释的是**为什么 `posts` 这张表和它的
「影子行」还留着** —— 留着不是「还没搬完」，是互动数据本来就长在那儿。

**为什么不删 `posts`**：所有互动认的都是 `posts.id`，不是 `documents.id` ——
赞 / 踩（`reactions.post_id`）、收藏（`bookmarks.post_id`）、回复（`replies.post_id`）、
转发（`reposts.post_id`）、通知（`notifications.post_id`）、个人主页置顶
（`posts.profile_pinned` / `profile_pinned_at`）全是挂在它上面的列或外键
（`src/modules/core/tables.sql.js`，清一色 `REFERENCES posts(id) ON DELETE CASCADE`）。
所以建文档时会顺手插一条「影子行」当互动锚点（`src/modules/doc/anchor.js` 的 `createAnchor`）；
**文档 → 影子帖**那根线记在 `documents.anchor_post_id` 上，反向（拿到 `postId` 问「这是哪篇积木」）
只能靠 `GET /api/docs/by-anchor/:postId` 反查 —— 两个老地址的改道靠的就是它。

**以前的现象**：`#/doc/:id` 阅读页上**没有点赞 / 踩 / 收藏 / 转发**的按钮，
只有一张卡片写着「去帖子里互动」，点过去跳到 `#/post/:anchorPostId` —— 同一条内容两个地址，
一个是积木页（只能读），一个是帖子页（才能互动）。

**现在**：阅读页自己就有一条互动条。它向 `GET /api/docs/:id/anchor` 要「这一篇的互动锚点帖」
（帖子列表形状，回复也一趟带回来），然后把帖子页那套按钮原样画出来
（`public/views/post.js` 导出的 `reactionBarHtml(post, { docMode: true })`，连提交后
**就地改 DOM** 的事件处理都不用改，见 `public/core/events.js` 的 `reaction` / `bookmark` 两段），
转发区（`repostSectionHtml`）与 AI 解读面板（`public/views/ai.js` 的 `aiPostPanelHtml`）
也一起搬了过来。帖子页那边**没有横幅了** —— 页面整个不渲染，只剩一次改道（`viewPost()`）；
反查不到积木时才显示一张「这篇帖子没有对应的积木」的卡片，请人去积木广场。

**根因**：`documents` 和 `posts` 是两张表。所有互动（赞/踩/收藏/通知）都认 `posts.id`，
所以建文档时会顺手插一条「影子行」当互动锚点（`src/modules/doc/anchor.js`）。
但影子行有两条互相打架的硬约束：

1. 它必须 `deleted = 0` —— 赞/踩走 `src/store.js` 的 `WHERE p.id = ? AND p.deleted = 0`，
   `deleted = 1` 就找不到这条影子行，互动全部 404；
2. 而 `deleted = 0` 的行**必然**被所有帖子列表收录（`src/store.js:379` 的 `buildFilter()` 第一句就是 `p.deleted = 0`），
   只能靠 `hidden` 把自己藏起来，而 `hidden` 的语义是「非 staff 非作者 404」（`src/core/guards.js` 的 `assertPostVisible`）。

于是 `src/modules/doc/anchor.js` 的 `anchorHidden(scope)` 只对 `scope === 'public'` 返回 0。
**原来的结果**：`followers` / `team` / `private` 可见的积木帖子，除了作者和 staff，**别人一点赞就 404**。

**修法（都做了，而且没碰 `buildFilter()`）**：

- **前端**：阅读页的互动条（那一摊 UI 现在只剩积木页这一处 —— 帖子页那道横幅随页面一起没了，见上）。
- **core 只开一个注入口**：`src/core/guards.js` 新增 `addPostVisibility(fn)`，
  `assertPostVisible()` 在原来的 staff/作者放行之后，再问一遍注册进来的判定 ——
  **它只能放行，不能拦**（谁都不认还是 404）。
- **doc 模块登记自己的可见性**：`src/modules/doc/index.js` 把 `visibility.js` 的 `canView`
  包成一个判定注册进去（`queries.documentByAnchor(post.id)` + `canView(row, viewer)`），
  于是「看得见这篇积木的人」= 「能对它的影子行点赞的人」。
- **`abilities` 跟着走**：`src/modules/doc/store.js` 的 `abilitiesOf` 里 `canReact`
  改成复用同一条 `canView`（改一处必须改另一处，注释写在那儿了），否则前端还会把按钮藏起来。

**这一摊现在的样子**：上面那几条修法一条都没拆（`addPostVisibility` 注入口、doc 模块登记的
`canView`、`abilitiesOf` 里 `canReact` 与它同规则），只是守的从「帖子页」换成了「积木页」。
回复**也已经搬进积木页**：`public/views/doc.js` 的 `interactHtml()` 铺出
`<div class="doc-interact-replies" data-doc-replies>` 这个容器，`mountInteraction()` 用
`GET /api/docs/:id/anchor` 拿回 `replies` / `replyCount` / `canReply` 之后交给
`docRepliesHtml(post, data)` 渲染（每条回复复用 `views/post.js` 的 `replyHtml`，
`deleteAction` 换成 `reply-delete`）；发帖框是 `data-doc-form="reply"` 的表单，
提交仍打 core 那条 `POST /api/posts/:id/replies`（回复在库里还是长在影子行上），
删回复走 `data-doc-action="reply-delete"` → `DELETE /api/replies/:id`，删完只重画讨论区、
留在积木页。帖子页没有回复框了 —— 它整个不渲染。

**还剩什么**：

- 影子行的 `views` / `pinned` 是旧链路的财产，`syncAnchor` 刻意不重写这两列，
  所以「积木页的阅读数」和「影子帖的阅读数」仍是两个不同的东西；
  `GET /api/docs/:id/anchor` 也**故意不 `bumpViews`** —— 看一遍积木不该涨影子帖的浏览量。
- 公开的积木仍然会以「影子帖」的形态出现在**首页动态流和全文搜索**里（这是有意的：
  内容能被搜到），点进去落到 `#/post/:id`，那里再把你改道到积木页 ——
  帖子页上那条「已经搬进积木」的横幅随着页面一起没了，改道本身就是横幅要干的事。
- **老帖的搬家**：`POST /api/posts` 关死之后，库里早就存在的老帖靠启动时那一次
  `store.migrateLegacyPosts()` 补成积木（幂等，`src/modules/doc/index.js` 启动时调一次，
  生产库实测 8 篇；`template = 'meta'` 板块的帖子迁成 `announce`，也就是站务公告）。
- **老的写作页没地址了**：`public/views/compose.js` 的 `viewCompose()` 还在 —— 发帖表单、
  图片上传、实时预览，以及挂在 `#composeForm` 上的 `window.NotesAgent`「AI 笔记整理」抽屉 ——
  但 `#/new` 已经不再渲染它，`public/core/router.js` 里也没有第二个路由调这个函数，
  全站只剩 `Compose.destroyComposeNotesPanel()` 这一处引用（换页时收干净）。
  也就是说 `note-agent/` 那套抽屉目前没有可达的宿主页 —— 积木的 Markdown 模式现在挂的是
  `public/views/doc-ai.js` 那个抽屉（见 §10.2），重新接一遍是另一件事，这里先记一笔。

### 10.2 积木这一摊还没开发的

按「影响从大到小」排：

| 缺口 | 现状 |
| --- | --- |
| **积木编辑器的 AI 抽屉只在文本视图里** | 抽屉（`public/views/doc-ai.js`）挂在 Markdown 与源码模式**左侧**，改的就是右边那段文本；积木模式没有一段完整正文可发，所以那儿只有块列表（要 AI 就切到源码模式），块模式也没有「让 AI 写一块」这种能力 |
| **块类型撤不掉** | 注册接口 `POST /api/docs/meta/block-types` 对**所有登录用户**开放（记 `created_by`），但没有删除/停用接口，也没有管理后台界面 —— 注册错了只能改库 |
| **沙箱能力只有六个，而且有一个没实装** | 白名单是 `doc-meta` / `doc-blocks` / `viewer` / `state` / `blocks.derived` / `site.read`（见 `src/modules/doc/schema.js` 的 `SANDBOX_CAPABILITIES`）。没有网络请求、没有跨文档读、也不能通过沙箱改文档正文（`POST /api/docs/:id/ops` 存在但沙箱没接）。**`site.read` 目前走的是 `requestCapability` 的兜底分支，回的载荷和 `doc-meta` 一样**（`src/modules/doc/store.js:1795`）—— 名单里留着这个名字，但还没有站内数据给它 |
| **块间联动只会取值** | `bind` 只支持「取另一块的某个字段来渲染」，没有条件、循环、计算 |
| **保存没有冲突检测** | 保存是后写覆盖，没有 `If-Match` / 版本号；两个人同时编辑，后保存的那个赢 |
| **没有实时协作** | 没有光标共享、没有在线状态、没有块级锁 |
| **修订只有整体回滚** | `GET /api/docs/:id/revisions` 能列出历史，`POST .../rollback` 能整体回到某一版，但**没有逐行 diff 视图** |
| **导入总是新建** | `POST /api/docs/meta/import` 每次都建一篇新文档，没有「按标题合并/覆盖」 |
| **广场只有第一页** | 接口支持 `page` / `limit` / `sort`，前端只有搜索框 + 形态筛选 + 「只看我的」，**没有翻页器也没有排序选择器**（总篇数倒是显示了） |
| **权限只到文档级** | 没有块级权限、没有「只允许某人编辑某一块」 |
| **Wiki 还很薄** | 分类只有一级且不能重命名页面（改名 = 新建一页 + 软删旧的）、没有重定向、没有「谁链到我」的反向链接列表 |
| **投票还很薄** | 没有截止时间、没有「投过才能看结果」的配置、没有匿名投票 |
| **移动端只做了折行** | 窄屏是把两栏折成一栏，没有专门的小屏编辑体验 |

