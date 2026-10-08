/* @hand-written */
// 积木语法说明书 —— 喂给模型的「块到底长什么样」。
//
// 为什么单开一个文件：这些字串是**提示词**，同时又是 ai 模块能拿到的唯一一份
// 「P2 的块形状」。骨架规范（`scripts/check-skeleton.mjs` 规则 5）不许业务模块互相
// import，所以这里是**手抄的一份**，漂移由 `scripts/ai-smoke.mjs` 的哨兵盯着：它拿
// `GET /api/docs/meta/block-types` 比对 `AI_BLOCK_TYPES` 的名字与顺序，另比对
// `AI_TEMPLATE_KEYS` 与 `src/modules/doc/templates.js` 的 8 个 key。
//
// 踩坑记录（别重蹈）：
//   · 老提示词只写了「正文 / 标题 / 代码 / 引用 / 投票 / 图片 / 子页」，于是
//     ① poll 的 options 被写成 `["选项一","选项二"]`，跟 P2 的 `[{id,text}]` 对不上；
//     ② `app`（小应用）压根没在提示词里出现过 —— 用户说「帮我做个投票」「写个小程序」
//        时，模型只敢把字写进 paragraph，谁也生成不出能跑的块；
//   · 老提示词用的是自造的 `{ blockType, content }`，模型照着发明了不存在的 `vote` 类型。
//   · 线上文档 548：「照抄源码里的 ```` ```doc:poll {#b2} ```` 时把两边反引号丢了」，
//     整段 JSON 被当成正文打印出来（详见 `AI_FENCE_GUIDE` 与 `programs.js` 文件头）。
// 所以这一份要**具体到字段**：类型名、每类块的 props、围栏写法（含 `{#id}`）、沙箱里能用什么。
//
// 改动纪律：这里改字不会让任何门禁红（`blockPromptRules()` 的函数名没有被断言，
// 但 `AI_BLOCK_TYPES` / `AI_TEMPLATE_KEYS` 的字面量被 ai-smoke 第 19 节盯着），
// 所以更要靠人盯着 —— 改 P2 的块形状时，这份说明书必须同批改。

/**
 * 站内现成的 8 个文档模板 key（出处 `src/modules/doc/templates.js` 的 `TEMPLATES`）。
 *
 * 模型判断「这一篇正好是某个模板」时只回 `{"template":"<key>"}`，前端走现成的
 * `POST /api/docs/:id/apply-template` 落盘 —— 模板是站里维护好的成品，比现场编更准。
 * 手抄 + 哨兵，理由同上。
 */
export const AI_TEMPLATE_KEYS = Object.freeze([
  { key: 'blank', title: '空白文档', description: '一个正文块，从零开始写。' },
  { key: 'station', title: 'Wiki 站', description: '一个站一篇帖子：说明 + 目录，每一页以积木块挂进来。' },
  { key: 'page', title: 'Wiki 页面', description: '一页起头：标题 + 正文 + 相关页面。多页面 wiki 就建多篇。' },
  { key: 'academic', title: '学术笔记', description: '摘要 → 章节 → 公式 → 代码 → 参考文献。' },
  { key: 'wiki', title: 'Wiki 词条', description: '定义、章节、词条互链，以及自动填充的修订记录。' },
  { key: 'poll', title: '投票问卷', description: '说明 → 若干投票 → 结果说明。' },
  { key: 'datatable', title: '数据表', description: '标题 + 一张表 + 口径说明。' },
  { key: 'lab', title: '实验记录', description: '目的 / 材料 / 步骤 / 观察 / 结论。' },
]);

/** 每类块的 props —— 逐字对应 `src/modules/doc/blocks/types.js` 的 schema。 */
export const AI_BLOCK_PROP_GUIDE = Object.freeze([
  '各类型的 props 字段（只能填这些名字，字段没提到的就别编）：',
  '标题 heading {"text":"小标题","level":2}（level 1~6，默认 1）；',
  '正文 paragraph {"text":"一段文字"}；',
  '小节正文 prose {"text":"一小节的 Markdown"}\\n（**P2 现在默认的正文块**：解析器把同一小节里连续的正文并成一块，text 里可以有 "- 甲\\n- 乙" 这样的列表、"> 引用"、空行；看见 prose 就整块改写，别为了「更细」把它拆回 paragraph / list）',
  '（上面两种都是正文，区别只是粒度：一个 prose = 一个小节，一段一句话那种写法已经不用了）；',
  '折叠块 fold {"title":"点开看细节","kind":"note","open":false,"text":"收起来的整段 Markdown"}',
  '（**一大段可折叠的正文**：需要「先给结论、细节收起来」时用它 —— text 里可以有列表、表格、代码围栏，甚至套一层 fold；不要把 fold 拆成十个小段，也不要为了「更细」把里面的东西搬出去）；',
  '列表 list {"text":"- 甲\\n- 乙"}（Markdown 记法，一项一行）；',
  '代码 code {"text":"console.log(1)","lang":"js"}（lang 可省）；',
  '表格 table {"text":"表头 | 表头\\n--- | ---\\n甲 | 乙","rows":[["甲","乙"]]}（rows 可省，会自动从 text 解析）；',
  '公式 formula {"text":"E = mc^2"}（只写 LaTeX 主体，不要 $$）；',
  '图片 image {"src":"https://…/a.png","alt":"说明","text":"图注"}（src 必填）；',
  '引用 quote {"text":"被引的原话","source":"—— 出处"}；',
  '投票 poll {"question":"选哪个？","options":[{"id":"o1","text":"甲"},{"id":"o2","text":"乙"}],"multiple":false}',
  '（options 必须 2~10 项、每项是 {"id","text"} 两个字段，**不是**字符串数组；id 用 o1/o2/o3 这类短标识，不许重复）；',
  '双链 wiki {"target":"另一篇的标题","label":"显示文字","note":"小注"}；',
  '嵌入 embed {"url":"https://…","title":"标题","height":360}（height 120~800）；',
  '小应用 app {"app":"计数器","config":{},"code":"<button id=c>0</button><script>…<\\/script>"}',
  '（**会跑的块**：一段完整的 HTML + JS 小界面，跑在隔离 iframe 里 —— 用户说「帮我做个 XX 小工具 / 小界面 / 小程序」就用它）；',
  '脚本 script {"code":"const s = await Sandbox.blocks(); …"}',
  '（**也是会跑的块**：裸 JavaScript，没有 HTML 外壳，通过 window.Sandbox 读文档、并用 Sandbox.render.put 画「派生块」；一篇文档**最多一块** script）；',
  '子页 subpage {"doc":"页面标题","mode":"card","title":"卡片标题","note":"说明"}（doc 填标题或文档 id，拿不准就留空）。',
]);

/**
 * 沙箱里到底能用什么（出处 `src/modules/doc/sandbox.js` 的 `bootstrapScript()`）。
 *
 * 报给模型是为了让它写出来的代码**第一次就能跑**：沙箱没有网络、能力要申请、
 * 申请 5 秒超时 —— 不说明的话模型十有八九会写 `fetch`，然后在页面上静默失败。
 */
export const AI_SANDBOX_GUIDE = Object.freeze([
  '跑代码的块里能用 `window.Sandbox`：`Sandbox.props`/`Sandbox.inputs` 是这块的 props 与输入；',
  '`Sandbox.resize()` 在高度变了以后调一次；`Sandbox.value(v)` 回传一个值；`Sandbox.onInit(fn)` 注册初始化（init 可能早于你的注册到达，框架会兜住）。',
  '要数据得**申请能力**（`await Sandbox.request("doc-meta")`，超时 5 秒会 reject，记得 try/catch）：',
  '`doc-meta`（`Sandbox.doc()` 拿 {id,title,kind,author,updatedAt}）、`doc-blocks`（`Sandbox.blocks()` 拿全部块的 {id,type,props}）、',
  '`viewer`（`Sandbox.viewer()` 拿当前访客）、`state`（`Sandbox.state.get()/set()`，登录后才存得下）、',
  '`blocks.derived`（`Sandbox.render.list/canWrite/put/remove` —— 画「派生块」，不动正文）、`site.read`（读站点信息，兜底实现）、',
  '`profile`（`Sandbox.profile()` 拿**主页主人**的信息：{id,username,displayName,bio,avatar,role,postCount,repostCount,followerCount,followingCount,pinnedCount,tags,posts}；',
  '等价于 `GET /api/docs/profile/<用户名>/stats`。文档 kind 是 `profile` 时就是「个人主页」：',
  '主页显示「发过的文章数」必须用 `postCount`（它和下面列出来的条数同口径，一个 wiki 站只算一篇），不要自己去数 `Sandbox.blocks()`；',
  '主页保存前要过「块规则」：`app` 块 `props.app = \'个人主页名片\'` 的那一块**必须存在、必须是第一块、不许删**，',
  '其余块随用户自由增删改；不满足就存不下去 —— 改主页的块时别删名片块、别把别的块挪到它前面），',
  '沙箱里**没有网络**（CSP `default-src \'none\'`）、拿不到父页面、也不能用外部图片或 CDN；',
  '样式请写内联，或直接写 `<style>`；每次能力调用都算配额（60 次/分钟），循环里别反复 request。',
]);

/** 「照着一句话造功能」时给模型的取舍规则。 */
export const AI_AUTHORING_GUIDE = Object.freeze([
  '用户要的东西如果是**站内已有的块类型**能做出来的，就直接产出那种块，别用正文描述它：',
  '· 要投票 / 问卷 / 收集选择 → `poll` 块（不要写成正文里的选项列表）；',
  '· 要计数器、小工具、小界面、能点的东西 → `app` 块（自己写 HTML + JS，代码要完整可跑）；',
  '· 要让页面根据文档内容自己长出一块 → `script` 块（一篇最多一块）；',
  '· 要公式 → `formula` 块；要引原文 → `quote` 块；要挂别的页面 → `wiki` 或 `subpage` 块；',
  '· 用户明确要「就按某个模板来」时，整篇改写可以只回 {"template":"<模板 key>"}（见下），一行 Markdown 都不用写。',
  '代码块要能直接跑：不要 `import`、不要占位符、不要 TODO，用 `document.getElementById` 这类沙箱里也有的能力。',
]);

/**
 * 「照抄围栏块」的三条铁律 —— 线上文档 548 的教训（`programs.js` 文件头也记了这一笔）。
 *
 * 模型看到的是 `src/modules/doc/blocks/markdown.js` 的 `blocksToSource()` 导出的源码，
 * 那里围栏块的信息串**自带块 id**（`doc:poll {#b2}`）。那次模型把上下两行反引号丢了、
 * 只留下 `doc:poll {#b2}` 那半行：P2 的解析器只认围栏，于是整段 JSON 被当成正文打印
 * 在页面上；而且投票的票数、评论这些都挂在块 id 上，id 一丢内容也跟着丢。
 *
 * 落地端还有一道形状纠正层兜底（`programs.js`：裸块补围栏、`{#id}` 原样带回去），
 * 但**提示词先讲清楚**才是治本 —— 纠正层救不回来的形状照样会漏给用户。
 */
export const AI_FENCE_GUIDE = Object.freeze([
  '源码里的积木块长这样（信息串后面那个 `{#b2}` 是**块 id**，表示「这块的身份证是 b2」）：',
  '```doc:poll {#b2}\\n{"question":"选哪个？","options":[{"id":"o1","text":"甲"},{"id":"o2","text":"乙"}],"multiple":false}\\n```',
  '照抄 / 改写围栏块的三条铁律：',
  '· 三行缺一不可：开头那行（三个反引号 + doc:<块类型> + 可能跟一个 {#id}）、JSON 正文、结尾那行三个反引号；',
  '· `{#b2}` 这一小段**必须原样留着**，不许删、不许改：票数 / 评论 / 引用都挂在块 id 上，丢了 id 等于换了一块；',
  '· 最常犯的错是只抄 `doc:poll {#b2}` 那一行、把两边的反引号去掉 —— 那一行会被当成普通正文，',
  '  后面的 JSON 会一字不落地打印在页面上，块也就没了。',
  '要改的只是围栏体里的字段值；类型名、字段名、块 id 一个字都别动。',
]);
