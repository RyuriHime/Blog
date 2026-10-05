# 围炉论坛 · 一个可以真正跑起来的论坛网站

零依赖的全栈论坛：**后端 Node 内置 `http` + `node:sqlite`，前端原生 JS，没有 `npm install`，没有构建步骤**。
克隆下来一条命令就能访问，界面是深色现代风格，功能覆盖一个社区论坛该有的完整闭环。

```
├── 板块分区 ── 5 个预置板块（技术交流 / 问答求助 / 分享创造 / 综合讨论 / 站务公告）
├── 账号体系 ── 注册、登录、会话保持（HttpOnly Cookie + scrypt 密码哈希）
├── 账号设置 ── 修改头像、昵称、个性签名、修改密码（改密后其它设备强制下线）
├── 每日签到 ── 每天 +1 币；一个自然周全勤，下周一再领 +3 币
├── 内容发布 ── 发帖 / 编辑 / 删除，Markdown 渲染 + 实时预览，@提及
├── 讨论互动 ── 回复、置顶、锁定
├── 文章评价 ── 👍 点赞 / 👎 踩（互斥）+ 🪙 投币（注册送币、单帖上限、币转给作者、无每日补足）+ ⭐ 收藏
├── 转发分享 ── 🔁 带评语转发到自己的主页、可撤销、可复制链接，原作者收到通知
├── 价值排行 ── 赞/币/藏/踩加权算文章价值 V，个人权重 W = ΣV，文章榜 + 作者榜 + 时间窗
├── 个人主页 ── 作者自建分类、列表/卡片/紧凑三种排版、置顶推荐（最多 3 篇）、转发列表
├── 关注关系 ── 关注作者，首页「我关注的」只看 TA 们的帖子
├── 私信 ── ✉️ 互相关注不限量；单方面关注每天 1 条；未关注需先关注
├── 黑名单 ── 🚫 被拉黑者无法关注 / 私信 / 查看我的文章，双向内容互不可见
├── 消息通知 ── 回复 / 点赞 / 踩 / 投币 / 转发 / 关注 / @提及 / 关注的人发新帖 / 管理操作
├── 背景主题 ── 🎨 暗夜 / 极夜 / 明亮 / 暖阳 / 奶黄 / 森林 / 暮紫 + 跟随系统，选择记在本地
├── 个性头像 ── 🖼️ 12 个预设表情或上传图片（客户端压缩、服务端校验落盘）
├── 角色权限 ── 👑 站长（唯一，可任命管理员）/ 🛡️ 管理员 / 成员，三级权限
├── 内容管理 ── 管理团队可**隐藏**（可逆，访客 404）或**删除**任何文章，全程留痕
├── 检索导航 ── 全文搜索、最新/最新回复/最热三种排序、分页
└── 管理后台 ── 数据看板、任命管理员、隐藏/删除文章、封禁用户、审计日志
```

---

## 0. 这个仓库里有什么

论坛本体 + 四个**互相独立**的扩展包。少装任何一个，其余部分照常跑。

| 目录 | 是什么 | 版本 | 单独验一下 |
| --- | --- | --- | --- |
| `src/` `public/` `scripts/` | 论坛本体：后端（`node:http` + `node:sqlite`）、原生前端、检查脚本 | 1.3.0 | `npm test` |
| `forum-ai/` | AI 层：站点分析、阅读助手，对接任意 OpenAI 兼容接口 | 1.0.0 | `node forum-ai/selftest.mjs` |
| `knowledge-pack/` | 把帖子算成知识网络图（`#/graph`）。**纯本地计算，不调用 AI、不花钱** | 1.0.0 | `npm run check:graph` |
| `note-studio/` | 学术笔记子系统：Markdown + LaTeX 可视化编辑、拍照转文字、导出 | 1.0.0 | `node note-studio/tests/run.mjs` |
| `note-agent/` | 挂在写帖页和笔记编辑器上的「AI 工作台」抽屉 | 0.1.0 | `npm run test:notes` |

### 密钥放哪

**仓库里一个密钥都没有** —— `data/`、`.env`、日志、打包产物都在 `.gitignore` 里。AI 功能全部从环境变量读配置：

```bash
AI_API_KEY=<你的 key> \
AI_BASE_URL=<OpenAI 兼容接口地址> \
AI_MODEL=<模型名> \
node src/server.js
```

不设也能跑：论坛本体、知识网络图、笔记编辑都不需要 AI，只有 AI 相关的按钮会提示「未配置」。**动手改代码前先确认自己的 `AI_API_KEY` 没有写进任何文件。**

### 数据在哪

运行时数据全在 `data/`（SQLite 库、头像、生成的知识图），**不进版本库** —— 里面是真实帖子内容。删掉整个 `data/` 就等于重置成全新站点，下次启动会自动建表并写入示例数据。

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
示例账号自带「上周全勤」的签到记录，所以**第一次签到就能领到 1 + 3 币**，方便你直接看到全勤奖效果。

---

## 2. 互动机制说明

### 每日签到 📅

- 每天签到 **+1 币**，同一自然日内不能重复签到；
- 按**自然周（周一至周日）**统计：一周 7 天全部签到即「全勤」，**在下周一签到（或你下一次签到时）额外补发 +3 币**；
- 全勤奖按周记账（`checkin_bonuses`），同一周只会发一次，不会重复发；
- 断签不影响已获得的全勤奖，只是那一周不再算全勤；
- 签到页 `#/checkin` 有本周进度、最近 35 天打卡日历、连续签到天数、累计签到次数与全勤奖记录；侧栏卡片会显示本周进度和「全勤奖待领」提示。

### 投币 🪙

**没有「每日补足」**：币不会随着时间自动回涨，只会从三个地方进账 ——

1. **注册赠送 10 币**（一次性）；
2. **每日签到**：每天 +1 币，一个自然周全勤再 +3 币；
3. **别人给你的文章投的币**（投出的币直接转进作者账户）。

规则与限制：

- 对同一篇文章最多投 **2 币**（可以一次投 1 币，分两次投满）；
- 不能给自己的文章投币；
- 投币按钮旁边始终显示「可用 N 币」，余额花完就是花完，得去签到或等别人投你；
- 币花完时按钮会变虚线灰态并直接写出原因：「币不够了：去「每日签到」领币（每天 1 币，全勤再 +3），或等别人给你的文章投币」。

这样币就成了一种**真正稀缺的货币**：投出去就没了，所以投币是"最肉疼"的认可，也因此在我们下面的价值公式里权重最高。

**能不能投币由服务端判定**：`GET /api/posts/:id` 会返回 `post.coin`，包含 `available`、`reason`（`ok` / `self` / `per_post_limit` / `insufficient_coins` / `anonymous`）、`message`、`balance`、`myCoins`、`perPostLimit`、`signupGrant`。前端只是照着展示：

- 可投 → 按钮高亮，hover 提示「投 1 币给作者（可用 N 币，单帖上限 2 币）」；
- 不可投 → 按钮变为虚线灰态并**在旁边直接写出原因**，**点它还会再弹一次提示**，不会出现「点了没反应」的情况。

### 评价：赞 / 踩

同一用户对同一篇文章只能「赞」或「踩」二选一，重复点同一个按钮表示取消，改主意时直接点另一个即可（会自动清掉原来的）。
热度排序的公式是 `赞×4 + 币×5 + 回复×3 − 踩×2 + 浏览×0.1`（列表排序用），与下面的**价值分**是两套口径：前者看热度，后者看质量。

### 转发 🔁

- 帖子详情页和动作栏都有「🔁 转发」：可以**带一句评语**转发，评语可以随时改（同一篇只保留一条转发）；
- 转发会出现在**你的主页「🔁 转发」分类**里，别人点进去能看到你的评语和原文；
- 原作者会收到「转发了你的文章」通知；帖子详情页有完整的转发列表；
- 可以随时「撤销转发」；「🔗 复制链接」把帖子地址复制到剪贴板，方便分享到站外；
- 不能转发自己的文章（自己的文章直接用复制链接）。

### 价值排行榜 🏆

`#/ranking` 页有两个榜：**文章价值榜**（按 V 排序）和**作者权重榜**（按 W = ΣV 排序，可切「按总权重 / 按篇均」），都支持 `全部时间 / 近 30 天 / 近 7 天` 时间窗。侧栏也有前 5 名的实时榜单。

**权重公式**（常量都在 `src/db.js` 的 `VALUE_WEIGHTS`，改完重启即可生效）：

```
① 踩的软化   D' = 3·踩 / (踩 + 3)                 踩越多边际影响越小，最多相当于 3 次踩
② 基础分     S  = 1·赞 + 5·币 + 3·收藏 − 3·D'
③ 文章价值   V  = 100·S / (|S| + 50)              饱和映射，天然落在 −100 ~ +100
④ 个人权重   W  = Σ V（该作者所有未删除文章）
```

设计理由：

- **投币权重最高（5）**：它最稀缺——每天只补足 10 币、单帖上限 2 币、还不能自投，投币是最"肉疼"的认可；
- **收藏（3）> 点赞（1）**：收藏代表"以后还要回来看"，比顺手点赞更强的价值信号；
- **踩用软化函数**：`3D/(D+3)` 让第 1 个踩影响最大、后续递减（1 踩 ≈ −0.75 分，10 踩 ≈ −6.9 分，上限 −9），避免围攻把一篇文章直接打成负无穷；
- **饱和映射**：`100·S/(|S|+50)` 让分数有界且边际递减——S=50 恰好 50 分，S=150 得 75 分，S=450 得 90 分。既避免一篇爆款碾压整个榜单，也让负分同样被压缩；
- **个人权重用求和**：鼓励"多写几篇有价值的"，而不是"一篇爆款吃一辈子"；同时提供「按篇均」视图给单篇质量高的作者。

举例：一篇拿到 `3 赞 + 1 币 + 1 收藏 + 1 踩` 的文章，
`D' = 3/(1+3) = 0.75`，`S = 3 + 5 + 3 − 2.25 = 8.75`，`V = 100×8.75/(8.75+50) ≈ 14.89`。

> 转发（🔁）目前只作为传播数据展示，**不计入**价值分（你要求的口径是赞/币/藏/踩四项）。想把它作为第 5 个信号，只需在 `VALUE_WEIGHTS` 里加一个 `repost` 权重，并在 `src/store.js` 的 `BASE_SCORE_SQL` 里加一项即可。

### 个人主页：分类 / 排版 / 置顶推荐 🗂

- **分类**：作者可以自建分类（最多 8 个），在发帖或编辑时归入，也可以在自己主页的文章下方用下拉框随手调整；删除分类不会删文章，文章会回到「未分类」；
- **筛选**：主页顶部有 `全部 / 各分类 / 未分类` 标签，带每类文章数；
- **排版**：右上角可切换 `☰ 列表 / ▦ 卡片 / ≡ 紧凑` 三种排版，选择记在浏览器本地（`localStorage`）；
- **置顶推荐**：作者可以把最多 **3 篇**文章置顶到主页顶部（单独的「📌 置顶推荐」区块），与管理员的全站置顶互不影响。

### 关注 👥

关注作者后：首页出现「我关注的」标签页；作者发新帖会推送通知；个人主页可以查看 TA 的关注者 / 关注列表和统计；在「我的关注」里可以随时取关。

### 消息通知 🔔

顶栏铃铛带未读数徽标（每 60 秒自动刷新一次），触发规则：

| 事件 | 通知谁 | 类型 |
| --- | --- | --- |
| 有人回复你的帖子 | 楼主 | `post_reply` |
| 有人赞 / 踩你的帖子 | 作者 | `post_like` / `post_dislike` |
| 有人给你的帖子投币 | 作者 | `post_coin` |
| 有人关注你 | 被关注者 | `follow` |
| 有人在正文 / 回复里 @你 | 被提及者 | `mention` |
| 你关注的人发了新帖 | 关注者 | `following_post` |
| 管理员删除你的帖子 | 作者 | `moderation` |
| 注册成功 | 本人 | `system` |

两条防打扰规则：**不给自己发通知**；**同一个人对同一对象的同类未读通知只保留一条**。通知支持「只看未读」「全部标为已读」，点击即跳转并自动已读。

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

`#/settings` 的「头像」卡片（顶栏、帖子列表、回复、主页、排行榜、关注列表里的头像都是同一个）：

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
| **看不到你发的文章** | 列表 / 搜索 / 首页 / 排行榜里都不出现；**通过直链打开也是 404**（避免绕过） |
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

- **🙈 隐藏**：可逆。文章对普通访客与搜索引擎直接 404，也不出现在板块列表、搜索、首页、排行榜里；**作者本人仍然能看到**（详情页顶部有醒目提示 + 隐藏原因），管理团队也照常可见并带「已隐藏」标记。隐藏期间访客无法点赞/投币/回复/转发（一律 404）。填写的隐藏原因会随通知发给作者。
- **🗑 删除**：软删除，作者和管理团队都看不到，数据仍留在库里。

**审计日志**：隐藏/恢复、删除、封禁/解封、任命/收回管理员都会写进 `moderation_logs`，后台「📜 管理操作记录」里能看到操作人、动作、对象、原因和时间。

**防呆规则**：站长不能被降级或封禁（避免把唯一站长弄丢）；管理团队成员之间不能互相封禁（只有站长能处理管理员）；不能把别人直接设成站长。

### 账号设置 ⚙️

`#/settings` 页面提供：

- **头像**：预设表情 / 上传图片 / 恢复默认（见上）；
- **个人资料**：修改昵称（1-20 字符）与个性签名（≤100 字符，展示在个人主页）；
- **外观**：背景主题选择（与顶栏 🎨 同步）；
- **修改密码**：需要输入当前密码，新密码至少 6 位且不能与旧密码相同；**改密成功后其它设备上的会话会被立即吊销**，当前浏览器保持登录；
- **签到与资产**：连续签到、累计签到、本周进度、可用币，并可一键签到；
- **账号信息**：用户名（不可改）、身份、注册时间、状态。

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
│       ├── feed/  doc/  ai/  team/  ui/   # 五路并行的空壳（见 docs/skeleton.md）
├── public/
│   ├── index.html               # 页面外壳（顶栏 / 侧栏 / 挂载点）
│   ├── app.js                   # 薄入口（≤120 行）：只做 bootstrap
│   ├── style.css                # 只剩 20 行 @import，按前缀顺序拼回原级联顺序
│   ├── core/                    # 前端核心层：state / dom / api / router / theme / events …
│   ├── views/                   # 页面：feed / user / post / compose / ai / admin / notes / graph …
│   └── css/                     # 20 个样式分片（00-themes … 97-notes）
├── scripts/
│   ├── smoke.mjs                # 后端端到端冒烟测试（242 项）
│   ├── check-golden.mjs         # ★ 行为金标准：96 条请求的状态码 + 响应结构指纹
│   ├── check-skeleton.mjs       # ★ 骨架自检：模块解耦证明 + 薄入口行数
│   ├── check-ui-contract.mjs    # 前端契约检查：CSS 类名 + API 字段 + 主题/头像/角色/私信结构
│   ├── check-encoding.mjs       # 源码编码体检（BOM / 乱码 / 批处理换行与 ASCII）
│   ├── check-graph-ui.mjs / check-notes-ui.mjs / notes-smoke.mjs / smoke-ai.mjs
│   ├── fix-cmd.mjs              # 把 .cmd 规范化为 CRLF + 去 BOM
│   └── reset-db.mjs             # 清库并重新播种
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
| `#/` | 首页：Hero + 讨论列表（全部 / 我关注的）+ 排序切换 |
| `#/board/tech` | 板块页（`general` / `tech` / `qa` / `share` / `meta`） |
| `#/post/:id` | 帖子详情：Markdown 正文、赞/踩/投币/收藏/关注作者、回复列表与回复框 |
| `#/new`、`#/edit/:id` | 发帖 / 编辑，带 Markdown 工具栏、分类选择与「主页置顶」开关 |
| `#/checkin` | 每日签到：今日状态、本周进度、35 天日历、全勤奖记录 |
| `#/ranking` | 价值排行榜：文章价值榜 + 作者权重榜（含时间窗与公式说明） |
| `#/settings` | 账号设置：资料、密码、签到与资产、账号信息 |
| `#/u/:username` | 个人主页：分类筛选、三种排版、置顶推荐、关注者与关注列表 |
| `#/notifications` | 消息通知（全部 / 只看未读） |
| `#/following` | 我的关注 |
| `#/bookmarks` | 我的收藏 |
| `#/search?q=关键词` | 全文搜索（标题 + 正文） |
| `#/login`、`#/register` | 登录 / 注册 |
| `#/admin` | 管理后台（仅管理员） |
| `#/docs` | 积木广场：可编程帖子 / 笔记 / 主页文档的列表，支持 `?kind=` `?scope=` `?mine=1` `?q=` |
| `#/doc/:id` | 积木阅读页：块渲染结果、降级警告、修订记录、导出/导入、赞/踩/投币/收藏（锚点走既有帖子接口） |
| `#/doc/:id/edit` | 积木编辑器：逐块编辑、上下移动、Markdown 双向、`ops` 增量改动、套模板、回滚、沙箱开关 |
| `#/doc/:id/blocks` | 同一个编辑器的高级入口（默认落在积木模式）：块列表 + 当前块的 props 表单 |
| `#/blocks` | 块类型表：12 种内置块类型的声明式 schema 速查、「怎么自己编一个块」的指南 + 注册自己的块类型（可带渲染模板） |
| `#/wiki/:name` | Wiki 多页面：`[[双链]]` 的落点；左侧是分类边栏（页内筛选 + 新建页，作者多一个「改分类」），有这一页就渲染它，没有就给「建这一页」（`?create=1` 一步进编辑器） |

---

## 5. REST API

所有接口返回统一结构：成功 `{ ok: true, data }`，失败 `{ ok: false, error: { code, message } }`。

| 方法 | 路径 | 说明 | 权限 |
| --- | --- | --- | --- |
| POST | `/api/auth/register` | 注册（用户名 3-20 位字母数字下划线，密码 ≥6 位） | 公开 |
| POST | `/api/auth/login` | 登录，下发 `forum_sid` Cookie | 公开 |
| POST | `/api/auth/logout` | 退出登录 | 登录 |
| POST | `/api/auth/password` | 修改密码（校验旧密码，吊销其它会话） | 登录 |
| GET | `/api/auth/me` | 当前用户 + 未读数（含可用币） | 公开 |
| POST | `/api/me/profile` | 修改昵称 / 个性签名 | 登录 |
| POST | `/api/me/avatar` | 设置头像：`{type:'emoji'\|'upload'\|'reset'}` | 登录 |
| GET | `/avatars/:file` | 读取上传的头像文件（长缓存 + nosniff） | 公开 |
| GET | `/api/checkin` | 签到状态：今日、连续天数、本周进度、日历、待领全勤奖 | 登录 |
| POST | `/api/checkin` | 执行签到（+1 币，必要时补发全勤奖） | 登录 |
| GET | `/api/me/categories` | 我的主页分类（含文章数） | 登录 |
| POST | `/api/me/categories` | 新建分类（≤8 个） | 登录 |
| PUT | `/api/me/categories/:id` | 重命名分类 | 登录 |
| DELETE | `/api/me/categories/:id` | 删除分类（文章回到未分类） | 登录 |
| GET | `/api/site` | 板块列表 + 站点统计 + 投币/签到/主页规则 + 热门帖子 | 公开 |
| GET | `/api/posts` | 帖子列表，支持 `board` `q` `author` `sort` `page` `perPage` `bookmarked` `following` | 公开 |
| POST | `/api/posts` | 发帖（可带 `categoryId`、`profilePinned`） | 登录 |
| GET | `/api/posts/:id` | 帖子详情（含回复、我的评价状态、可投币状态） | 公开 |
| PUT | `/api/posts/:id` | 编辑帖子 | 作者/管理员 |
| DELETE | `/api/posts/:id` | 删除帖子（软删除，管理员删他人帖子会通知作者） | 作者/管理员 |
| POST | `/api/posts/:id/reaction` | 赞 / 踩，body `{ kind: 'like' \| 'dislike' }` | 登录 |
| POST | `/api/posts/:id/coin` | 投币，body `{ amount }` | 登录 |
| POST | `/api/posts/:id/bookmark` | 收藏 / 取消收藏 | 登录 |
| POST | `/api/posts/:id/repost` | 转发（带评语，同一篇只留一条，重复转发=更新评语） | 登录 |
| DELETE | `/api/posts/:id/repost` | 撤销转发 | 登录 |
| GET | `/api/ranking` | 排行榜，支持 `window=all\|7\|30`、`limit`、`minPosts` | 公开 |
| POST | `/api/posts/:id/category` | 把文章归入自己的分类（`null` 表示取消） | 作者 |
| POST | `/api/posts/:id/profile-pin` | 主页置顶 / 取消置顶（≤3 篇） | 作者 |
| POST | `/api/posts/:id/replies` | 发表回复（通知楼主、@提及） | 登录 |
| DELETE | `/api/replies/:id` | 删除回复 | 回复者/楼主/管理员 |
| POST | `/api/users/:id/follow` | 关注 / 取关 | 登录 |
| GET | `/api/users/:username` | 个人主页：统计 + 分类 + 关注者/关注 + 文章（`?category=<id\|none>`） | 公开 |
| GET | `/api/me/following` | 我的关注列表 + 计数 + 余额 | 登录 |
| GET | `/api/notifications` | 通知列表，支持 `filter=unread` `page` `perPage` | 登录 |
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
| GET | `/api/docs` | 积木文档列表，支持 `kind` `scope` `mine=1` `q` `page` `limit` `sort` | 公开（按可见范围过滤） |
| POST | `/api/docs` | 新建积木文档，body `{ title, kind, scope, template }`；`kind='profile'` 一个用户至多一份 | 登录 |
| GET | `/api/docs/:id` | 文档详情：`{ doc, blocks, html, warnings, abilities }` | 按 scope |
| PUT | `/api/docs/:id` | 改标题 / 可见范围 / 模板名 | 作者/管理员 |
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
| GET | `/api/docs/meta/templates` | 模板清单 + `kinds` + `scopes` 枚举（唯一真相） | 公开 |
| GET | `/api/docs/meta/block-types` | 块类型清单（内置 12 种 ∪ 库里注册的），含声明式 schema | 公开 |
| POST | `/api/docs/meta/block-types` | 注册自定义块类型（名字 `^[a-z][a-z0-9_]{0,31}$`，内置名与重名 409）；`rendererKind:'declarative'` 可带 `renderer:{html:'…{{字段}}…'}`（会剥掉 script/内联事件/`javascript:`），`'sandbox'` 则用 schema 里的 `code` 走玻璃房 | 登录 |
| POST | `/api/docs/meta/import` | 按 `forum-doc/1` 格式导入一份新文档 | 登录 |
| POST | `/api/docs/notes/import` | 把一篇笔记接成文档，body `{ name, title, markdown, scope }`；幂等 | 登录（只能导自己的） |
| GET | `/api/docs/notes/lookup` | 按 `ownerId` + `name` 找笔记对应的文档；用 `{ found }` 标记而不是 404 | 按 scope |
| GET | `/api/docs/profile/:username` | 按用户名找 `kind='profile'` 的主页文档；同样用 `{ found }` 标记 | 按 scope |
| GET | `/api/docs/wiki` | wiki 目录：`{ pages, categories }`（只列当前用户看得见的页；没分类的排最后） | 公开（按可见范围过滤） |
| GET | `/api/docs/wiki/:name` | 按标题找一页 wiki（`template='page'`），连同 `nav` 边栏一起回；看不见与不存在都回 `{ found:false }` | 按 scope |
| POST | `/api/docs/wiki/:name` | 打开或**新建**一页 wiki（body `{ scope }`，默认 `public`）；返回 `created` 标记 | 登录 |
| PUT | `/api/docs/:id/wiki` | 给一页 wiki 定分类与排序，body `{ category, sortOrder }`；回新的 `nav` | 作者/管理员 |

---

## 6. 数据模型

```
users(id, username, display_name, password_hash, role, bio, avatar, banned,   -- role: owner | admin | member
      coin_balance, coin_refresh_at, created_at)   -- coin_refresh_at 为历史字段，已不再读写
sessions(token, user_id, created_at, expires_at)
boards(id, slug, name, description, icon, sort_order)
posts(id, board_id, user_id, title, content, views, pinned, locked, deleted,
      category_id, profile_pinned, profile_pinned_at, created_at, updated_at,
      hidden, hidden_at, hidden_by, hidden_reason)
replies(id, post_id, user_id, content, deleted, created_at)
reactions(user_id, post_id, kind)        -- kind: like | dislike，联合主键保证赞踩互斥
coins(user_id, post_id, amount)          -- 单帖累计上限 2，作者收币
bookmarks(user_id, post_id, created_at)  -- 私密收藏
follows(follower_id, followee_id, created_at)
notifications(id, user_id, actor_id, type, post_id, reply_id, excerpt, read_at, created_at)
checkins(id, user_id, day, reward, created_at)              -- 一天一行，(user_id, day) 唯一
checkin_bonuses(user_id, week_start, amount, created_at)    -- 全勤奖账本，一周只发一次
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
                created_by, created_at, updated_at)   -- 全局注册表，内置 12 种优先、不可被覆盖
doc_capability_logs(id, document_id, block_id, capability, user_id, allowed, created_at)
                    -- 沙箱能力调用的审计流水：被拒也记一行
note_documents(user_id, note_name, document_id, created_at)
                    -- 笔记子系统 ⇄ documents 的接线表，(user_id, note_name) 唯一
```

设计要点：

- **软删除**：删帖/删回复只置 `deleted = 1`，数据可追溯，也不会破坏点赞、收藏的外键。
- **签到按自然周**：日期统一用本地时区的 `YYYY-MM-DD` 字符串（见 `src/dates.js`），避免时间戳做日历运算的时区坑；全勤判定 = 某个已结束的自然周里有 7 条不同日期的签到记录。
- **余额只增不减**：每日刷新是 `coin_balance = MAX(coin_balance, 10)`，所以签到赚的币不会被第二天的刷新清空。
- **评价互斥**：`reactions` 用 `(user_id, post_id)` 做主键，一个用户对一篇文章只可能有一行记录。
- **投币/签到事务**：扣币、加币、记账包在 `BEGIN IMMEDIATE` 事务里，失败自动回滚。
- **通知去重**：写通知前先查「同一 actor + 同一类型 + 同一对象 + 未读」是否存在，存在就跳过。
- **分类归属校验**：只能把文章放进自己的分类，服务端逐次校验，前端下拉框只是便利。
- **积木的影子行**：每份文档在 `posts` 里留一条只做互动锚点的行（`anchor_post_id`），赞/踩/投币/收藏/通知/价值榜因此**零改动**复用；`hidden` 由文档 scope 决定，`public` 的文档还会把标题与纯文本摘要同步过去，所以旧列表与搜索照样能用它。代价（已知短板）：`hidden=1` 的影子行对非站长非作者是 404，所以 `followers` / `team` 可见的文档，**别人点不了赞**。
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

1. 建新表（`reactions` / `coins` / `follows` / `notifications` / `checkins` / `checkin_bonuses` / `profile_categories` / `reposts`）；
2. 给 `users` 补 `coin_balance` / `coin_refresh_at`，给 `posts` 补 `category_id` / `profile_pinned` / `profile_pinned_at`；
3. 把旧的 `likes` 表数据搬进 `reactions` 后删掉旧表，并把已有的回复 / 点赞 / 关注**回填成消息通知**；
4. 首次升级时给示例账号补上演示用的分类、主页置顶和签到记录（`checkins` 或 `profile_categories` 非空就跳过，真实用户不会被塞假数据）；
5. 转发表为空时给示例账号补几条演示转发。

`data/backup-pre-upgrade.db` 是第一次升级前的自动备份（含 `-wal` / `-shm`），确认没问题后可以删掉。

---

## 7. 安全设计

- 密码使用 **scrypt** 加盐哈希（`scrypt$salt$hash`），校验用 `timingSafeEqual` 恒定时间比对。
- 会话是随机 24 字节 token，存库并设 30 天过期，Cookie 为 `HttpOnly; SameSite=Lax`；被封禁用户的会话会被立即删除；改密后其它会话全部吊销。
- **Markdown 渲染先整体 HTML 转义，再注入白名单标签**，因此正文里的 `<script>` 只会原样显示（冒烟测试有专门用例覆盖）。
- 链接白名单：仅允许 `http(s)` / `mailto` / 站内相对路径，`javascript:` 等伪协议会被降级为 `#`。
- 所有 SQL 使用预编译参数绑定，不存在字符串拼接注入。
- 登录、注册、发帖、回帖、签到、改密、转发都有基于内存桶的速率限制；请求体大小、各字段长度均有限制。
- 投币、签到、分类、置顶、转发等写操作全部在服务端校验规则（额度、上限、归属、不能自投/自转），前端置灰只是体验优化。
- 静态文件做了路径穿越校验，响应带 `X-Content-Type-Options: nosniff`。

---

## 8. 测试

```bash
node scripts/check-golden.mjs      # ★ 行为金标准：96 条请求的状态码 + 响应结构，一条都不能变
node scripts/check-skeleton.mjs    # ★ 骨架自检：模块能不能独立拆掉、薄入口有没有变胖
node scripts/check-frontend.mjs    # ★ 前端渲染冒烟：18 个页面全部渲染一遍
node scripts/smoke.mjs             # 后端端到端：242 项（临时独立库+端口，跑完自动清理）
node scripts/smoke-ai.mjs          # AI 接口端到端：61 项
node scripts/check-ui-contract.mjs # 前端契约：CSS 类名 + API 字段 + 主题/头像/角色/私信结构
node scripts/check-encoding.mjs    # 源码编码体检：BOM / 乱码 / 关键中文内容
node scripts/check-graph-ui.mjs    # 知识网络图 UI
node scripts/check-notes-ui.mjs    # 笔记 UI
node scripts/notes-smoke.mjs       # 笔记接口
node scripts/capture-fixtures.mjs  # 重采前端冒烟用的假数据（改了接口形状才需要跑）
node scripts/reset-db.mjs          # 清空数据库并重新播种
```

一次跑完（`npm test` 就是这一串）：

```
check-encoding 162 文件 / 61 断言 · check-skeleton 47 项 · check-golden 96 项 0 差异
check-frontend 21 个页面 · feed-smoke 95 · smoke 242 · smoke-ai 61 · check-ui-contract 200
check-graph-ui 24 · check-notes-ui 33 · notes-smoke 44
```

**`check-golden.mjs` 是这套测试里最该先跑的一个**：它把 96 条固定请求的「状态码 + 响应 JSON 的键结构」
与 `scripts/golden.json` 逐条比对，**只管结构不管取值**（不会因为你发了一篇新帖就红）。
重构、搬家、改前端时先跑它 —— 绿了才说明「用户能感知到的行为一个字都没变」。
真的有意改了行为，用 `--write` 重采指纹，并在提交信息里说明为什么。
（`--dump` 只打印不比对；指纹文件不存在时它会**直接报错退出**，因为「改造完再补采」等于没测。）


覆盖范围：静态资源与 SPA 回落、注册登录登出、投币规则与上限与「不可投币的四种原因」、**取消每日补足（把 coin_refresh_at 改成一万小时前再登录，余额仍然是 0，仍然投不了币；文案也指向签到而不是"明天刷新"）**、签到（首次 +1、全勤补发 +3、同日重复签到 409 且不重复加币、日历结构）、主页分类（增删改查、上限、归属校验、按分类/未分类筛选）、主页置顶（上限 3 篇、取消置顶、越权 403）、**转发（成功计数、重复转发只改评语、撤销、不能自转、不能未登录转发、转发者列表、主页转发分类、通知原作者）**、**价值排行榜（权重常量下发、公式数值逐项验证、作者权重=Σ文章价值、降序、时间窗筛选、作者榜字段）**、账号设置（昵称签名校验、改密校验旧密码、改密后其它会话失效 / 当前会话保留 / 新旧密码登录）、重复用户名、会话保持、分页、全文搜索、Markdown 转义、赞踩互斥、收藏、关注与关注流、消息通知的收件人与去重、越权访问后台、封禁等。

其中「公式数值逐项验证」会在运行库里真的造一篇 `3 赞 + 1 币 + 1 收藏 + 1 踩` 的文章，断言接口返回的 `baseScore = 8.75`、`valueScore ≈ 14.89`，并检查它进入榜单后分数一致、作者权重等于其所有文章价值之和 —— 公式改了而 SQL 没同步的话，测试会立刻红。

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
停掉服务，执行 `node scripts/reset-db.mjs`（相当于删掉 `data/forum.db` 重新播种）。

**Q：想调整规则数值？**
都在 `src/db.js` 顶部（实体在 `src/core/open-db-support.js`）：`COIN_SIGNUP_GRANT`（注册赠送币数）、`COIN_PER_POST_LIMIT`（单帖投币上限）、`CHECKIN_DAILY_REWARD`（签到奖励）、`CHECKIN_WEEKLY_BONUS`（全勤奖）、`PROFILE_PIN_LIMIT`（主页置顶数）、`PROFILE_CATEGORY_LIMIT`（分类数上限）、`VALUE_WEIGHTS`（价值公式里赞/币/藏/踩的权重、踩的软化系数、半饱和点）。

**Q：排行榜的分数怎么和我想的不一样？**
价值分是**质量口径**（赞/币/藏/踩加权 + 饱和映射），不是热度。若想看热度，用首页的「🔥 最热」排序（`赞×4 + 币×5 + 回复×3 − 踩×2 + 浏览×0.1`）。价值分的完整推导和举例见上面「价值排行榜」一节。

**Q：签到为什么没发全勤奖？**
全勤奖按**已结束的自然周**结算：某一周（周一至周日）7 天都签到，之后**下次签到时**才补发。所以周一签到通常就是领奖的时刻；如果断签了一周，那一周就不算全勤。

**Q：想部署到线上？**
把它挂在 Nginx/Caddy 后面即可（记得配 HTTPS 并把 Cookie 换成 `Secure`），单进程足够支撑小型社区；`data/forum.db` 记得做定时备份。上线的第一件事是**改掉 admin 的演示密码**（登录后到 `#/settings` 修改）。

**Q：想扩展功能？**
先读 [`docs/skeleton.md`](docs/skeleton.md)。现在的分工是：**表结构**由 `src/modules/<模块>/index.js` 的 `owns`
声明、建表 SQL 用 `ctx.schema.add(...)` 登记；**接口**用 `ctx.routes.add(method, pattern, handler)` 注册，
响应统一走 `ctx.http.ok()`；**权限**用 `ctx.guards.requireUser/requireStaff/…`；**前端页面**加一个
`public/views/x.js` 并在 `public/core/router.js` 的 if 链里接一行。
不要 import 隔壁模块的文件（模块之间只通过 `ctx` 通信，`check-skeleton.mjs` 会抓）。
新增通知类型只需调用 `store.createNotification()`，并在 `public/core/session.js` 的 `NOTIF_META` 里补一条文案。
**改完务必跑 `node scripts/check-golden.mjs`** —— 它保证你没顺手改坏现有页面。

