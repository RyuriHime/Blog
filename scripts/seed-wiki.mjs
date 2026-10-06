// 给「一个帖子一个 wiki」铺内容：建一个站，往里放两页 ——
//   1.「源码教程」：讲清源码是什么、怎么写、沙箱里能调什么；
//   2.「投票示例」：一个真能点、票数存在服务端的脚本块。
//
// 这对站点是有意义的初始内容，不是一次性脚本：换台服务器也能空手跑出来。
//   BASE=http://127.0.0.1:3512 node scripts/seed-wiki.mjs
//
// 幂等：站和页都按标题找，找得到就复用（同名页不会建第二份）。
const BASE = (process.env.BASE ?? 'http://127.0.0.1:3512').replace(/\/$/, '');
const USERNAME = process.env.SEED_USER ?? 'admin';
const PASSWORD = process.env.SEED_PASS ?? 'admin123';

const F3 = '```';
const F4 = '````';

let cookie = '';
async function call(path, init = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...(init.headers ?? {}),
    },
  });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((item) => item.split(';')[0]).join('; ');
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

/* ------------------------------------------------------------------ 文案 */

const STATION_TITLE = '可编程帖子手册';
const STATION_INTRO = [
  '# 可编程帖子手册',
  '',
  '这是一篇**帖子**，也是一个 **wiki 站**：它就是目录本身。',
  '站里的每一页都是独立的一篇文档（各自有作者、修订、权限），',
  '在这里以卡片的形式挂出来 —— 页面标题改了，卡片跟着改。',
  '',
  '左边是树（可以套子页），右边是页内目录，底下能上一页 / 下一页翻。',
  '',
  '## 从这个站开始',
  '',
  '- 先看 [[源码教程]]：一篇帖子 = 一份源码，积木就是源码里的一段。',
  '- 再看 [[投票示例]]：一个真能点、票数存在服务端的脚本块。',
  '',
  '> 想动手就点右上角的「＋ 新建页面」，新页会直接落到这个站里。',
].join('\n');

const TUTORIAL_TITLE = '源码教程';
const TUTORIAL = [
  '# 源码教程',
  '',
  '一句话：**一篇帖子就是一份源码**。想法写在 Markdown 里，积木写成',
  `\`${F3}doc:类型\``,
  '围栏包着的一段 JSON。保存之后它既是你看到的原文，也是站上的真块 ——',
  '文章、投票、代码、小应用都从这一份文本里长出来。',
  '',
  '编辑器有三个视图：**Markdown**（只写想法）、**源码**（想法 + 积木）、**积木**（表单）。',
  '三者共享同一份草稿，切换之前会先存，所以怎么切都不会丢字。',
  '',
  '## 1. Markdown 照常写',
  '',
  `${F4}markdown`,
  '# 一级标题',
  '',
  '普通段落，可以放**粗体**、*斜体*、`行内代码`、$a^2+b^2=c^2$。',
  '',
  '- 列表项一',
  '- 列表项二',
  '',
  '> 引用也可以，末行写「—— 某人」就成了出处。',
  '',
  '| 列 | 值 |',
  '| --- | --- |',
  '| 甲 | 1 |',
  '',
  '还有两种本站特产：`[[双链]]` 指向别的页（不存在就是**红链**，点一下能建），',
  '以及 `![说明](/uploads/xx.png)` 贴图。',
  `${F4}`,
  '',
  '## 2. 积木 = 一段带 `doc:` 的围栏',
  '',
  '积木块的正文是 **JSON**，块类型由信息串给出：',
  '',
  `${F4}markdown`,
  `${F3}doc:poll`,
  '{',
  '  "question": "今天吃什么？",',
  '  "options": [',
  '    { "id": "a", "text": "面" },',
  '    { "id": "b", "text": "饭" }',
  '  ]',
  '}',
  `${F3}`,
  `${F4}`,
  '',
  '下面就是它的实际效果（这是**真的**投票块，不是截图）：',
  '',
  `${F3}doc:poll`,
  '{',
  '  "question": "今天吃什么？",',
  '  "options": [',
  '    { "id": "noodle", "text": "面" },',
  '    { "id": "rice", "text": "饭" },',
  '    { "id": "salad", "text": "沙拉" }',
  '  ]',
  '}',
  `${F3}`,
  '',
  '已有的积木类型（在「积木」视图里也能直接挑）：标题、段落、列表、代码、表格、公式、图片、',
  '引用、投票、双链、嵌入、小应用、脚本、子页。JSON 里的字段由类型自己声明，写错了会被',
  '校验挡住并给出原因，不会悄悄丢字段。',
  '',
  '## 3. id：块的身份证',
  '',
  '块默认按位置编号（`b1`、`b2`…）。**被引用的块要有稳定 id**，写法是在信息串后面加 `{#b3}`：',
  '',
  `${F4}markdown`,
  `${F3}doc:poll {#b7}`,
  '{ "question": "…", "options": [ … ] }',
  `${F3}`,
  `${F4}`,
  '',
  '普通 Markdown 块（标题 / 段落 / 表格 / 引用 / 列表 / 图片 / 双链）没有信息串，',
  'id 写在它**上一行**：',
  '',
  `${F4}markdown`,
  '<!-- b7 -->',
  '## 这一行标题的 id 是 b7',
  `${F4}`,
  '',
  '什么时候会自动出现这种标记行？只有三种情况：块自己有用 `bind` 取值、有别的块绑它、',
  '或者它是投票 / 小应用 / 脚本。日常写作时源码是干净的，不用管它。',
  '',
  '在开头插一段话，后面的块 id 不会集体搬家 —— 保存是按 id 对齐的，',
  '所以投票的票、小应用的状态、块间绑定都不会错位。',
  '',
  '## 4. `doc:script`：直接往帖子上写代码',
  '',
  '脚本块是唯一的例外：它的块体是**原始 JavaScript**，不是 JSON。',
  '',
  `${F4}markdown`,
  `${F3}doc:script`,
  '// 这段代码在读者的浏览器里跑，服务端从不执行用户代码。',
  'Sandbox.onInit(function () {',
  "  Sandbox.doc().then(function (doc) { console.log('这是第', doc.id, '篇帖子'); });",
  '});',
  `${F3}`,
  `${F4}`,
  '',
  '一个帖子最多一块脚本。它跑在一个 `sandbox="allow-scripts"` 的 iframe 里：',
  '读不到本站的 DOM 与 cookie，也**没有网络**（CSP 是 `default-src \'none\'`，',
  '外面既没有代理也没有白名单）。能用的东西只有下面这几样，都是走消息向宿主申请的：',
  '',
  '| 调用 | 拿到什么 |',
  '| --- | --- |',
  '| `Sandbox.props` / `Sandbox.inputs` | 这个块的属性与输入 |',
  '| `Sandbox.doc()` | 本篇的元信息 `{ id, title, kind, author, updatedAt }` |',
  '| `Sandbox.blocks()` | 本篇每一块 `{ id, type, props }` |',
  '| `Sandbox.viewer()` | 正在看的人 `{ loggedIn, id, username, displayName, staff }` |',
  '| `Sandbox.state.get(scope)` / `set(value, scope)` | 持久状态：默认「我自己一份」，`\'shared\'` 是全站一份 |',
  '| `Sandbox.render.list()` / `put(id, type, props, scope)` / `remove(id, scope)` | 脚本画出来的块（写进**派生层**） |',
  '| `Sandbox.render.canWrite()` | 这篇帖子允许脚本写块吗（作者在设置里开） |',
  '| `Sandbox.value(值)` | 把结果交回宿主（块间联动取值用） |',
  '| `Sandbox.resize()` | 高度变了告诉宿主（一般不用管，会自动量） |',
  '',
  '沙箱只能读到「这篇帖子自己的块」—— `Sandbox.blocks()` 不会给你别人的帖子。',
  '写状态（`state.set`）需要登录；**画块**（`render.put`）还要作者在设置里打开',
  '「允许脚本写块」，默认是关的。',
  '',
  '## 5. 脚本画出来的块 = 派生层',
  '',
  '脚本不该偷偷改你的正文。它 `render.put` 出来的块进的是**派生层**：',
  '照常渲染、能参与绑定、能按「我自己一份」或「全站一份」持久化，',
  '但**不进正文、不生成修订、不算作者写的字**，渲染时排在真块后面并标着「脚本产出」。',
  '',
  '作者觉得哪一块值得固化，就在编辑器里点「采纳为真块」：那块派生块会被抄进正文、',
  '记一条修订，从此它和别的块一样接受编辑。',
  '',
  '## 6. 保存、修订、防手滑',
  '',
  '- 每次保存都会留一条修订，可以随时回滚、导出。',
  '- 源码里一个块都解析不出来时**拒绝保存**（免得一段手滑把整篇清空）。',
  '- 块数掉到一半以下会先问一句「确认这样存？」，确认后才写。',
  '- 保存后编辑器会用服务端回传的源码重置基线，所以「存完编辑区变空」这类事不会发生。',
  '',
  '## 7. 站这一层',
  '',
  '- `#/wiki` 是所有看得见的站；一个站 = 一篇帖子，站的正文就是首页。',
  '- 站里的页各自是独立文档，**不会**出现在「积木」板块的列表里（它们是站的零件）。',
  '- 左树支持子页：在新页面时选父页，或者在源码里用 `subpage` 块指定 `doc` 与 `mode`。',
  '- 站内搜索会翻页的正文；`[[不存在的页]]` 是红链，点一下就能建。',
  '',
  '## 8. 自己搭一个 wiki（两条路，用的都是普通积木）',
  '',
  '「站」**不是另写的一套功能**，它是三样普通东西拼出来的：',
  '',
  '1. 一篇普通帖子 —— 形态选「**Wiki 站**」（`template: station`）。',
  '2. 一套挂在首页上的 **`subpage` 积木**（就是上面那种页卡片）。',
  '3. 每一页 = 一篇普通文档 —— 形态「**Wiki 页面**」（`template: page`），各自有作者、修订、权限。',
  '',
  '**路 A：用模板搭。** 新建一篇 → 在「积木」视图的模板栏里挑「Wiki 站」 → 保存。',
  '它立刻就是站（左树、右目录都会长出来），再点左树底下的「＋ 新建页面」添页。',
  '任何一篇普通帖子套上这个模板也会变成站 —— 套模板只是把 `template` 这个字段改成 `station`。',
  '',
  '**路 B：用源码搭。** 新建一篇帖子，源码写成下面这样（`doc` 填那一页的 id；',
  '打开那一页时地址栏 `#/doc/数字` 里的数字就是它）：',
  '',
  `${F4}markdown`,
  '# 我的站',
  '',
  '这个站的说明。',
  '',
  `${F3}doc:subpage`,
  '{ "doc": "30", "mode": "card", "title": "", "note": "一句话说明" }',
  `${F3}`,
  '',
  `${F3}doc:subpage`,
  '{ "doc": "31", "mode": "card", "title": "", "note": "" }',
  `${F3}`,
  `${F4}`,
  '',
  '`mode` 是 `card`（卡片列在首页）或 `full`（整页嵌进来）；`title` 留空就现查那一页的真标题，',
  '那一页改名之后这里会跟着变。想让某一页当别的页的子页，给它一个 `parentId` 就行 ——',
  '「＋ 新建页面」旁边那个接口 `PUT /api/docs/wiki/station/<站 id>/pages/<页 id>` 就是干这个的。',
  '',
  '**路 C（等价的一步到位）**：直接调 `POST /api/docs/wiki/stations` 建站、',
  '`POST /api/docs/wiki/station/<站 id>/pages` 建页 —— 这两个接口做的事，就是上面那些块与字段。',
].join('\n');

const POLL_TITLE = '投票示例';
const POLL = [
  '# 投票示例：用源码写一个会统计的投票',
  '',
  '这一段是普通 Markdown。下面是**脚本块** —— 块体是原始 JavaScript，',
  '在读者的浏览器里跑（服务端从不执行用户代码）。票数走服务端的「全站共享状态」，',
  '所以谁投都算，刷新、换设备、换浏览器都一样。',
  '',
  `${F3}doc:script`,
  "var OPTIONS = ['红队', '蓝队', '绿队'];",
  'var counts = [0, 0, 0];',
  'var mine = -1;',
  '',
  'var box = document.createElement("div");',
  'box.style.cssText = "border:1px solid #2b3a52;border-radius:10px;padding:12px 14px;max-width:520px";',
  'box.innerHTML =',
  '  \'<p style="margin:0 0 8px;font-weight:600">你支持哪一队？</p>\' +',
  '  \'<div class="row" style="display:flex;gap:8px;flex-wrap:wrap"></div>\' +',
  '  \'<p class="sum" style="margin:10px 0 0;opacity:.75"></p>\' +',
  '  \'<p class="me" style="margin:4px 0 0;opacity:.75"></p>\';',
  'document.body.appendChild(box);',
  'var row = box.querySelector(".row");',
  'var sum = box.querySelector(".sum");',
  'var me = box.querySelector(".me");',
  '',
  'function paint() {',
  '  var total = counts.reduce(function (a, b) { return a + b; }, 0);',
  '  var buttons = row.querySelectorAll("button");',
  '  for (var i = 0; i < buttons.length; i += 1) {',
  '    var text = OPTIONS[i] + " · " + counts[i];',
  '    if (total > 0) text += "（" + Math.round((counts[i] / total) * 100) + "%）";',
  '    buttons[i].textContent = text;',
  '    buttons[i].style.cssText = "font:inherit;padding:4px 10px;border-radius:999px;border:1px solid " +',
  '      (i === mine ? "#8fb2ff" : "#2b3a52") + ";background:" + (i === mine ? "#26364f" : "transparent") +',
  '      ";color:inherit;cursor:" + (mine >= 0 ? "default" : "pointer");',
  '  }',
  '  sum.textContent = "共 " + total + " 票";',
  '  me.textContent = mine >= 0 ? "你投了：" + OPTIONS[mine] : "一人一票，投完就改不了";',
  '  Sandbox.resize();',
  '}',
  '',
  'function vote(index) {',
  '  if (mine >= 0) return;',
  '  Sandbox.viewer().then(function (viewer) {',
  '    if (!viewer.loggedIn) {',
  '      me.textContent = "登录之后才能投票";',
  '      return;',
  '    }',
  '    counts[index] += 1;',
  '    mine = index;',
  '    return Promise.all([',
  '      Sandbox.state.set({ counts: counts }, "shared"),',
  '      Sandbox.state.set({ pick: index })',
  '    ]).then(paint);',
  '  });',
  '}',
  '',
  'for (var i = 0; i < OPTIONS.length; i += 1) {',
  '  (function (index) {',
  '    var button = document.createElement("button");',
  '    button.type = "button";',
  '    button.addEventListener("click", function () { vote(index); });',
  '    row.appendChild(button);',
  '  })(i);',
  '}',
  '',
  'Sandbox.onInit(function () {',
  '  return Promise.all([',
  '    Sandbox.state.get("shared"),',
  '    Sandbox.state.get()',
  '  ]).then(function (rows) {',
  '    var shared = rows[0] && rows[0].counts;',
  '    if (shared && shared.length === OPTIONS.length) counts = shared.slice();',
  '    var picked = rows[1] && rows[1].pick;',
  '    if (typeof picked === "number") mine = picked;',
  '    paint();',
  '  });',
  '});',
  `${F3}`,
  '',
  '## 它是怎么存下来的',
  '',
  '- `Sandbox.state.set({ counts }, \'shared\')` —— **全站一份**：所有访客看到的都是这一份票数。',
  '- `Sandbox.state.set({ pick })` —— 不传范围就是**我自己一份**：用来记住你投过哪一项。',
  '- 读的人不用登录（`state.get` 人人可读），写的人要登录（`state.set` 需要身份）。',
  '',
  '## 换成你自己的投票',
  '',
  '改 `OPTIONS` 那一行就行。想让票数按「每个人一份」互不干扰，把 `\'shared\'` 去掉；',
  '想画表格、图表、排行榜，用 `Sandbox.render.put(id, type, props)` 把块写进派生层',
  '（那需要作者在帖子设置里打开「允许脚本写块」）。',
].join('\n');

/* ------------------------------------------------------------------ 流程 */

const login = await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: USERNAME, password: PASSWORD }) });
if (login.status !== 200) {
  console.error(`登录失败：${login.status} ${JSON.stringify(login.body)}`);
  process.exit(1);
}
console.log('登录 ✓', USERNAME);

const stations = await call('/api/docs/wiki/stations');
let station = (stations.body?.data?.stations ?? []).find((item) => item.title === STATION_TITLE);
if (!station) {
  const created = await call('/api/docs/wiki/stations', {
    method: 'POST',
    body: JSON.stringify({ title: STATION_TITLE, scope: 'public' }),
  });
  if (created.status !== 200) {
    console.error(`建站失败：${created.status} ${JSON.stringify(created.body)}`);
    process.exit(1);
  }
  station = created.body.data.doc;
  console.log(`建站 ✓ ${station.title}（#${station.id}）`);
} else {
  console.log(`复用已有的站 ✓ ${station.title}（#${station.id}）`);
}

const pageIds = [];
for (const [index, [title, source]] of [[TUTORIAL_TITLE, TUTORIAL], [POLL_TITLE, POLL]].entries()) {
  const page = await call(`/api/docs/wiki/station/${station.id}/pages`, {
    method: 'POST',
    body: JSON.stringify({ title }),
  });
  if (page.status !== 200) {
    console.error(`建页失败 ${title}：${page.status} ${JSON.stringify(page.body)}`);
    process.exit(1);
  }
  const id = page.body.data.doc.id;
  pageIds.push({ id, title });
  // 站内顺序按这里的顺序钉死（默认都是 0，会退化成按标题排）。
  await call(`/api/docs/wiki/station/${station.id}/pages/${id}`, { method: 'PUT', body: JSON.stringify({ sortOrder: index + 1 }) });
  const put = await call(`/api/docs/${id}/markdown?confirm=1`, { method: 'PUT', body: JSON.stringify({ markdown: source }) });
  console.log(`页 ${page.body.data.created ? '新建' : '复用'} ✓ ${title}（#${id}）正文 ${put.status === 200 ? '✓' : `✗ ${put.status}`}`);
}

// 站的首页正文：导语 + 两张页卡片。卡片用 `subpage` 块写死（`doc` 填页的 id），
// 这样首页的顺序就是这里写的顺序，重跑也不会发散。
const cards = pageIds
  .map((page) => [`${F3}doc:subpage`, JSON.stringify({ doc: String(page.id), mode: 'card', title: '', note: '' }, null, 2), F3].join('\n'))
  .join('\n\n');
const home = await call(`/api/docs/${station.id}/markdown?confirm=1`, {
  method: 'PUT',
  body: JSON.stringify({ markdown: `${STATION_INTRO}\n\n${cards}\n` }),
});
console.log(`首页正文 ${home.status === 200 ? '✓' : `✗ ${home.status} ${JSON.stringify(home.body)}`}`);

// 站里可能还有被自动收编进来的老页（`template='page'` 的老文档第一次被打开就会归站）：
// 把它们的顺序压到这两页后面，教程和示例就一直在最上面。
const all = await call(`/api/docs/wiki/station?id=${station.id}`);
let below = 100;
for (const page of all.body?.data?.pages ?? []) {
  if (pageIds.some((mine) => mine.id === page.id)) continue;
  await call(`/api/docs/wiki/station/${station.id}/pages/${page.id}`, { method: 'PUT', body: JSON.stringify({ sortOrder: (below += 1) }) });
}

const check = await call(`/api/docs/wiki/station?id=${station.id}`);
const data = check.body?.data ?? {};
console.log(`\n站 #${station.id}「${data.station?.title}」共 ${(data.pages ?? []).length} 页：`);
for (const page of data.pages ?? []) {
  console.log(`  ${'  '.repeat(page.depth)}- ${page.title}（#${page.id}）`);
}
console.log(`首页卡片 ${(data.doc?.html ?? '').includes('doc-subpage') ? '✓' : '✗'}，页内目录 ${(data.doc?.toc ?? []).length} 条`);
console.log(`\n打开：${BASE}/#/wiki/${encodeURIComponent(data.station?.title ?? STATION_TITLE)}`);
