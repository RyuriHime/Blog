/**
 * 编码体检：确认所有源码都是干净的 UTF-8（没有 BOM、乱码替换字符或 CP936 误读留下的私用区字符）。
 *
 * 用法：node scripts/check-encoding.mjs
 *
 * ⚠️ 骨架改造后的重要变化：这份检查原来按**文件路径**写死「这个文件必须含哪些中文」，
 *    而 v2 骨架把 `src/server.js` / `src/db.js` / `public/app.js` 拆成了几十个文件，
 *    路径一换，那些断言就**静默失效**（找不到路径 → 断言根本不跑 → 测试还是绿的）。
 *    现在改成「片段 → 允许出现的文件清单」：片段只要在清单里任一文件里找到即算通过，
 *    找不到就报错。再配三条「不下降」哨兵：
 *      1. MIN_CHECKED：受检文件数不得少于骨架改造时的实测值；
 *      2. REQUIRED_FILES：新布局里的关键文件必须存在；
 *      3. 每条片段断言必须真的执行过（missing 与未执行分开计数）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const TARGETS = ['src', 'public', 'scripts', 'forum-ai/src', 'note-agent/src', 'note-studio/src', 'package.json', 'README.md', 'start.cmd'];

/**
 * 骨架改造时实测的受检文件数。只许涨，不许跌。
 * 108 是「后端刚拆完」时的数；153 是前端拆迁 + 前端冒烟脚本进 scripts/ 之后的数；
 * 155 是多了 capture-fixtures.mjs 与 frontend-fixtures.json 之后的数。
 * 可编程帖子（P2）落地后实测 187，抬到 187。
 * v2 骨架 + 团队（P4）合进 main 后实测 196；删掉知识网络图（knowledge-pack 7 个 mjs、
 * public/views/graph.js、public/css/96-graph.css、scripts/build-graph.mjs、
 * scripts/check-graph-ui.mjs、src/modules/core/graph-paths.js、src/core/json-file.js）
 * 后落回 183。
 * AI 编辑台（P3：public/views/ai-edit.js、public/css/94-ai-edit.css、scripts/ai-smoke.mjs
 * 三个新文件）合进来之后实测 193，抬到 193。
 * 这个数字存在的意义：前端文件被搬走却没同步检查脚本时，哨兵必须响。
 * 删掉签到功能时 `public/views/checkin.js` 整个文件被删，受检数从 195 落到 194：
 * 这是**故意的减一**，所以下限跟着降到 194；片段断言也同步删掉了签到 / 排行榜那几条。
 * 起始页（P5：public/views/start.js、public/css/25-start.css）进来之后加回两个，实测 196，抬到 196。
 */
const MIN_CHECKED = Number(process.env.MIN_CHECKED || 196);

/** 新布局里必须存在的关键文件。少一个就说明有人把文件搬走却没同步这份检查。 */
const REQUIRED_FILES = [
  'src/server.js',
  'src/db.js',
  'src/store.js',
  'src/markdown.js',
  'src/password.js',
  'src/dates.js',
  'src/notes.js',
  'src/core/index.js',
  'src/core/paths.js',
  'src/core/router.js',
  'src/core/guards.js',
  'src/core/shape.js',
  'src/core/sessions.js',
  'src/core/static.js',
  'src/core/handler.js',
  'src/core/context.js',
  'src/core/open-db.js',
  'src/core/open-db-support.js',
  'src/core/tables.sql.js',
  'src/core/mount-status.js',
  'src/modules/index.js',
  'src/modules/core/index.js',
  'src/modules/core/routes-a.js',
  'src/modules/core/routes-b.js',
  'src/modules/core/routes-c.js',
  'src/modules/core/routes-d.js',
  'src/modules/feed/index.js',
  'src/modules/doc/index.js',
  'src/modules/ai/index.js',
  'src/modules/team/index.js',
  'src/modules/ui/index.js',
  'public/index.html',
  'public/app.js',
  'public/style.css',
  // 前端拆迁后的关键文件：核心层 11 个 + 页面 13 个 + 样式分片（挑「入口 / 主题 / 列表」三个，
  // 其余分片由 MIN_CHECKED 与片段断言兜底）。
  'public/core/dom.js',
  'public/core/state.js',
  'public/core/router.js',
  'public/core/events.js',
  'public/views/feed.js',
  'public/views/notes.js',
  'public/views/timeline.js',
  'src/modules/feed/schema.js',
  'src/modules/feed/queries.js',
  'src/modules/feed/routes.js',
  'src/modules/feed/shape.js',
  'public/css/00-themes.css',
  'public/css/10-base.css',
  'public/css/30-feed.css',
  'public/css/31-timeline.css',
  // 前端冒烟与它的假数据（假数据是从真服务器采回来的，见 scripts/capture-fixtures.mjs）。
  'scripts/check-frontend.mjs',
  'scripts/capture-fixtures.mjs',
  'scripts/frontend-fixtures.json',
  'scripts/check-golden.mjs',
  'scripts/check-skeleton.mjs',
  'scripts/feed-smoke.mjs',
  'scripts/ai-smoke.mjs',
  'src/modules/ai/schema.js',
  'src/modules/ai/routes.js',
  'src/modules/ai/sections.js',
  // 界面冒烟（P5，顶栏入口 + 右栏抽屉）：新增文件必须登记，否则它被搬走哨兵不会响。
  'scripts/ui-smoke.mjs',
  // 起始页（P5）：新页面 + 它自己的样式分片。
  'public/views/start.js',
  'public/css/25-start.css',
  // 可编程帖子（P2，积木）：后端模块、块引擎、沙箱、页面、样式与它自己的冒烟脚本。
  'src/modules/doc/schema.js',
  'src/modules/doc/queries.js',
  'src/modules/doc/routes.js',
  'src/modules/doc/shape.js',
  'src/modules/doc/store.js',
  'src/modules/doc/visibility.js',
  'src/modules/doc/anchor.js',
  'src/modules/doc/templates.js',
  'src/modules/doc/sandbox.js',
  'src/modules/doc/blocks/index.js',
  'src/modules/doc/blocks/types.js',
  'src/modules/doc/blocks/registry.js',
  'src/modules/doc/blocks/markdown.js',
  'src/modules/doc/blocks/html.js',
  'src/modules/doc/blocks/bind.js',
  'src/modules/doc/blocks/ops.js',
  'src/modules/doc/blocks/validate.js',
  'src/modules/doc/blocks/agent.js',
  'src/modules/doc/blocks/plain.js',
  'src/modules/doc/blocks/text.js',
  'public/core/sandbox.js',
  'public/views/doc.js',
  'public/views/doc-blocks.js',
  'public/css/41-doc.css',
  'scripts/doc-smoke.mjs',
  // 团队（P4）：三张表、SQL、路由、形状、页面、样式分片与它自己的冒烟脚本。
  'src/modules/team/schema.js',
  'src/modules/team/queries.js',
  'src/modules/team/routes.js',
  'src/modules/team/shape.js',
  'public/views/team.js',
  'public/css/86-team.css',
  'scripts/team-smoke.mjs',
  // AI 编辑台（P3 前端）：能力授权可视化页面 + 它的样式分片。
  'public/views/ai-edit.js',
  'public/css/94-ai-edit.css',
];

/**
 * 每个中文片段必须出现在**清单里的某个文件**中。
 * 允许给多个候选文件：骨架搬家后同一段文案可能落在不同的文件里。
 */
const EXPECTED = [
  ['格社已启动', ['src/server.js']],
  ['分类不存在或不属于你', ['src/core/shape.js']],
  ['只支持「赞」或「踩」', ['src/modules/core/routes-b.js']],
  ['把老的 likes 表迁进 reactions 后删除', ['src/core/open-db-support.js']],
  ['头像：预设 emoji 或上传图片', ['src/core/sessions.js']],
  ['需要管理团队身份', ['src/core/guards.js']],
  ['黑名单', ['src/store.js']],

  ['数据访问层', ['src/store.js']],
  ['同一用户对同一帖子只能赞或踩；重复点击同一个则取消。', ['src/store.js']],
  ['隐藏 / 取消隐藏', ['src/store.js']],
  ['互相关注', ['src/store.js']],
  ['私信', ['src/store.js']],

  ['日期工具', ['src/dates.js']],
  ['自然周', ['src/dates.js']],
  ['极简 Markdown 渲染器', ['src/markdown.js']],
  ['恒定时间比对', ['src/password.js']],

  // 建表 SQL 搬进了 src/core/tables.sql.js，播种与回填文案搬进了 src/core/open-db-support.js
  ['评价：赞 / 踩（同一用户对同一帖子只能二选一）', ['src/core/tables.sql.js']],
  ['个人主页的文章分类', ['src/core/tables.sql.js']],
  ['转发（同一用户对同一篇只留一条', ['src/core/tables.sql.js']],
  ['综合讨论', ['src/core/open-db-support.js']],
  ['预设 emoji 头像', ['src/core/open-db-support.js']],
  ['私信规则', ['src/core/open-db-support.js']],
  ['站长：建站者', ['src/db.js', 'src/core/open-db-support.js']],

  ['格社', ['public/index.html']],
  ['搜索动态', ['public/index.html']],
  ['forum:theme', ['public/index.html']],
  ['首屏前应用背景主题', ['public/index.html']],

  // ⚠️ 前端也拆了：`public/app.js` 从 4254 行拆成 `public/core/*` + `public/views/*`，
  //    样式拆成 `public/css/*`（`public/style.css` 只剩 @import）。
  //    所以候选文件名必须换成**搬过去以后真正含有该文案**的那个文件；
  //    仍保留 `public/app.js` 当候选是没用的 —— 它现在只是个 44 行的装配文件。
  ['消息通知', ['public/core/session.js', 'public/views/feed.js', 'public/views/user.js']],
  ['这篇文章暂时不能转发', ['public/core/events.js']],
  ['转发会出现在你的主页', ['public/views/post.js']],
  ['跟随系统', ['public/core/theme.js', 'src/core/open-db-support.js']],
  ['暖阳', ['public/core/theme.js', 'public/css/00-themes.css']],
  ['奶黄', ['public/core/theme.js', 'public/css/00-themes.css']],
  ['正在压缩图片', ['public/core/events.js']],
  ['站长可以任命管理员', ['public/views/admin.js']],
  ['背景主题', ['public/core/theme.js', 'public/css/00-themes.css', 'public/css/76-theme-switch.css']],

  // v2 动态系统（P1）。这些片段一头两用：既证明中文没被编码搞坏，
  // 也证明**文件真的写进去了**（文件名在、内容空着的半成品一样会被抓住）。
  ['说点什么', ['public/views/timeline.js']],
  ['发布成功', ['public/views/timeline.js']],
  ['引用了帖子', ['public/views/timeline.js']],
  ['内联编辑框', ['public/css/31-timeline.css']],
  ['冻结枚举', ['src/modules/feed/schema.js']],
  ['SQL 占位符', ['src/modules/feed/queries.js']],
  ['只能删除自己的动态', ['src/modules/feed/routes.js']],
  ['拉黑之后看不到对方的公开动态', ['scripts/feed-smoke.mjs']],

  ['消息铃铛', ['public/css/75-social.css']],
  ['评价按钮', ['public/css/75-social.css']],
  ['转发按钮与转发区', ['public/css/78-repost.css']],
  ['暖阳：琥珀黄深色', ['public/css/00-themes.css']],
  ['头像设置', ['public/css/77-avatar.css']],
  ['角色与内容管理', ['public/css/85-roles.css']],
  ['私信与黑名单', ['public/css/88-messages.css']],

  ['端到端冒烟测试', ['scripts/smoke.mjs']],
  ['设置预设 emoji 头像成功', ['scripts/smoke.mjs']],
  ['角色与管理员分配', ['scripts/smoke.mjs']],
  ['单方面关注每天只能发一条', ['scripts/smoke.mjs']],

  // 可编程帖子（P2，积木）：新模块与它的前端。
  ['积木', ['src/modules/doc/schema.js']],
  ['不认识的模板', ['src/modules/doc/store.js']],
  ['只有管理员能开关沙箱', ['src/modules/doc/store.js']],
  ['这篇笔记太长了', ['src/modules/doc/store.js']],
  ['沙箱不能申请', ['src/modules/doc/store.js']],
  ['doc 模块的 SQL 层', ['src/modules/doc/queries.js']],
  ['笔记与个人主页的接线', ['src/modules/doc/routes.js']],
  ['沙箱已被管理员禁用', ['src/modules/doc/sandbox.js']],
  ['块类型注册表', ['src/modules/doc/blocks/registry.js']],
  ['8 个内置模板', ['src/modules/doc/templates.js']],
  ['积木广场', ['public/views/doc.js']],
  ['块类型表', ['public/views/doc.js']],
  ['这个积木还没写代码', ['src/modules/doc/sandbox.js']],
  ['积木广场', ['public/core/session.js']],
  ['端到端', ['scripts/doc-smoke.mjs']],
  ['块引擎', ['scripts/doc-smoke.mjs']],

  // 团队（P4）：可见性判定在服务端、401 与 404 的分工、版本冲突。
  ['团队（P4）的数据表', ['src/modules/team/schema.js']],
  ['团队（P4）自己的 SQL', ['src/modules/team/queries.js']],
  ['团队（P4）的接口', ['src/modules/team/routes.js']],
  ['404 与 403 的差别本身就是一个探测信道', ['src/modules/team/routes.js']],
  ['只有团队的创建者可以解散团队', ['src/modules/team/routes.js']],
  ['只有作者本人可以编辑这篇帖子', ['src/modules/team/routes.js']],
  ['有人在你之前改过了', ['src/modules/team/routes.js']],
  ['团队（P4）：团队列表', ['public/views/team.js']],
  ['86-team.css', ['public/css/86-team.css']],
  ['前端藏起来不叫权限', ['scripts/team-smoke.mjs']],
  ['移开自动收回', ['scripts/ui-smoke.mjs']],
  ['左边是站务公告，右边三块分别是动态、积木广场和团队', ['public/views/start.js']],
];

function walk(target, files = []) {
  const full = join(ROOT, target);
  if (!existsSync(full)) return files;
  const info = statSync(full);
  if (info.isFile()) {
    files.push(full);
    return files;
  }
  for (const entry of readdirSync(full)) {
    if (entry === 'node_modules' || entry === 'data') continue;
    walk(join(target, entry), files);
  }
  return files;
}

const problems = [];

/* --- 0. 关键文件必须存在 -------------------------------------------------- */
for (const rel of REQUIRED_FILES) {
  if (!existsSync(join(ROOT, rel))) problems.push(`缺少关键文件 ${rel}（骨架布局被改动？）`);
}

/* --- 1. 逐文件体检 -------------------------------------------------------- */
const checkedFiles = [];
let checked = 0;
const texts = new Map();

for (const target of TARGETS) {
  for (const file of walk(target)) {
    const rel = relative(ROOT, file).split('\\').join('/');
    const buffer = readFileSync(file);
    checked += 1;
    checkedFiles.push(rel);

    if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
      problems.push(`${rel}: 文件带 UTF-8 BOM`);
    }
    const text = buffer.toString('utf8');
    texts.set(rel, text);
    if (text.includes('\uFFFD')) problems.push(`${rel}: 含替换字符 U+FFFD（解码失败）`);
    if (/[\uE000-\uF8FF]/.test(text)) problems.push(`${rel}: 含私用区字符（疑似 CP936 误读留下的乱码）`);
    if (/[ÃÂ][\u0080-\u00BF]/.test(text)) problems.push(`${rel}: 疑似 Latin-1 乱码`);

    // 批处理文件有额外要求：cmd.exe 按 OEM 代码页逐行解析，
    // 所以必须是 CRLF 换行 + 纯 ASCII，否则会被拆成乱码命令（曾经踩过这个坑）。
    if (rel.toLowerCase().endsWith('.cmd') || rel.toLowerCase().endsWith('.bat')) {
      if (!text.includes('\r\n')) problems.push(`${rel}: 批处理文件必须用 CRLF 换行（当前是 LF）`);
      const bareLf = (text.match(/(?<!\r)\n/g) ?? []).length;
      if (bareLf > 0) problems.push(`${rel}: 有 ${bareLf} 处裸 LF 换行`);
      const nonAscii = [...new Set([...text].filter((char) => char.charCodeAt(0) > 126 && char !== '\r' && char !== '\n'))];
      if (nonAscii.length) {
        problems.push(`${rel}: 批处理文件含非 ASCII 字符「${nonAscii.join('')}」，会被 cmd 误解码（跑 npm run fix:cmd 修复换行，中文请交给 Node 输出）`);
      }
    }
  }
}

/* --- 2. 中文片段的跨文件检索 --------------------------------------------- */
let snippetChecks = 0;
for (const [snippet, candidates] of EXPECTED) {
  snippetChecks += 1;
  const hit = candidates.some((rel) => (texts.get(rel) ?? '').includes(snippet));
  if (!hit) {
    problems.push(`所有候选文件里都找不到预期中文片段「${snippet}」（候选：${candidates.join(' / ')}）`);
  }
}

/* --- 3. 不下降哨兵 -------------------------------------------------------- */
if (checked < MIN_CHECKED) {
  problems.push(`受检文件数从 ${MIN_CHECKED} 掉到 ${checked}：有目录没被扫描到（TARGETS 或 walk 被改坏了？）`);
}
if (snippetChecks !== EXPECTED.length) {
  problems.push(`片段断言只执行了 ${snippetChecks} / ${EXPECTED.length} 条`);
}

console.log(`已检查 ${checked} 个文件（下限 ${MIN_CHECKED}），中文片段断言 ${snippetChecks} 条`);
if (problems.length === 0) {
  console.log('✅ 所有文件编码正常，中文内容完整');
  process.exit(0);
}
console.log(`❌ 发现 ${problems.length} 个问题：`);
for (const problem of problems) console.log(`  · ${problem}`);
process.exit(1);
