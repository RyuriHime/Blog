/**
 * 一次性搬运脚本：把 public/style.css 按「章节注释」的边界切进 public/css/*.css。
 *
 * 用法：node docs/tools/split-css.mjs
 *
 * 与 extract-app-modules.mjs 是同一套路子，但简单得多 —— CSS 没有括号嵌套，
 * 只要按行号切、保证**每一行都有归宿**即可。
 *
 * 两条硬规矩（否则线上会静默变样）：
 *
 * 1) **级联顺序不能动。** 原 style.css 是「后面的规则覆盖前面」。切完以后由
 *    public/style.css 用一串 `@import` 按**原顺序**拉回来（文件名两位前缀掌控顺序），
 *    所以优先级完全不变。`@import` 必须写在文件最前面（CSS 规范要求）。
 *
 * 2) **每一行都要落到某个分片里。** 脚本跑完会打印「覆盖自检」，分片行数之和
 *    必须正好等于原文件行数。少一行就说明有样式被丢掉了 —— 而丢掉一条规则不会报错，
 *    只会悄悄少一个圆角。
 *
 * ⚠️ 不幂等：重跑前先 `Copy-Item .tmp-app/style.css.orig public/style.css -Force`。
 * ⚠️ 绝不用 PowerShell 读写这些 CSS（会被 GBK/UTF-8 双重编码搞坏）。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE = join(ROOT, 'public', 'style.css');
const lines = readFileSync(SOURCE, 'utf8').split('\n');

// 这份 style.css 里没有 @import；这段是防御性的 —— 万一以后有人加了，
// 它会被挑出来放到入口文件最前面，不会跟着某个分片漂走。
const isImport = (line) => /^\s*@import\b/.test(line);
const baseImports = lines.filter(isImport);
const body = lines.filter((line) => !isImport(line));

/**
 * 分片表。`start` 是该章节标题所在的**行号**（1-based，见原文件的注释行），
 * 每片一直切到「下一片 start 的前一行」。
 *
 * ⚠️ 为什么按「章节」而不是按「界面区域」切：原文件本来就是按章节注释组织的
 * （`/* ---------------- 帖子列表 ---------------- *&#47;`），照它的边界切，
 * 每一行的归属都没有歧义，也不用手工挑行号。真正的价值不在于文件名好看，
 * 而在于**五个人改样式时不会天天冲突**：P1 只碰 30-feed.css，P5 只碰 10/20。
 */
const CHUNKS = [
  { file: 'public/css/00-themes.css', start: 33, header: '8 套主题：变量与 [data-theme] 选择器。**必须最先加载**，后面的所有分片都依赖这些变量。' },
  { file: 'public/css/10-base.css', start: 234, header: 'reset、顶栏与整体布局骨架。' },
  { file: 'public/css/20-components.css', start: 439, header: '通用零件：卡片 / 面板、首页 Hero、按钮、标签。五个人都会用到，改前先打招呼。' },
  { file: 'public/css/30-feed.css', start: 614, header: '帖子列表（P1 动态的主战场）：列表 / 卡片 / 紧凑三种布局。' },
  { file: 'public/css/40-post.css', start: 733, header: '头像、分页、帖子详情、Markdown 渲染、回复区。' },
  { file: 'public/css/50-forms.css', start: 1016, header: '表单控件与输入框。' },
  { file: 'public/css/55-sidebar.css', start: 1105, header: '侧栏与右栏的零件。' },
  { file: 'public/css/60-admin.css', start: 1202, header: '管理后台。' },
  { file: 'public/css/65-helpers.css', start: 1260, header: '空状态、加载占位、Toast。' },
  { file: 'public/css/70-responsive.css', start: 1340, header: '响应式断点。⚠️ 手机端 375px 必须可用，这是验收项（FR-UI-08）。' },
  { file: 'public/css/75-social.css', start: 1370, header: 'v1.1 新增：通知铃铛、侧栏账户卡、评价按钮。' },
  { file: 'public/css/76-theme-switch.css', start: 1521, header: 'v1.4 新增：主题按钮与弹层、设置页里的主题选择卡片。' },
  { file: 'public/css/77-avatar.css', start: 1623, header: 'v1.5 新增：头像设置。' },
  { file: 'public/css/78-repost.css', start: 1674, header: 'v1.3 新增：转发区。（原 78-repost-ranking.css：排行榜与公式卡已随功能删除）' },
  { file: 'public/css/80-profile.css', start: 1873, header: 'v1.2 新增：个人主页分类与置顶、账号设置。（原 80-checkin-profile.css：签到已随功能删除）' },
  { file: 'public/css/85-roles.css', start: 2139, header: 'v1.6 新增：角色标签与内容管理。' },
  { file: 'public/css/88-messages.css', start: 2188, header: 'v1.7 新增：私信与黑名单。' },
  { file: 'public/css/95-ai.css', start: 2655, header: 'AI 阅读助手（forum-ai 的展示层）。' },
  { file: 'public/css/96-graph.css', start: 2891, header: '知识网络图（#/graph）。' },
  { file: 'public/css/97-notes.css', start: 3010, header: '学术笔记（#/notes）宿主样式。' },
];

const HAND_WRITTEN = '/* @hand-written */';

/* ---------- 切片 ----------
 * 1-32 行是文件开头的 `:root` 暗色变量表，与紧跟其后的 8 套主题是同一层东西
 * （主题块就是靠覆盖这些变量生效的），所以它归 00-themes.css，**而且必须排在最前**：
 * CSS 的覆盖顺序 = 文件顺序，:root 跑到主题块后面就等于把暗色又盖回去了。
 */
const PRELUDE_FILE = 'public/css/00-themes.css';
const ordered = [...CHUNKS].sort((a, b) => a.start - b.start);
const written = new Map();

written.set(PRELUDE_FILE, {
  header: '`:root` 暗色变量表 + 8 套主题（`[data-theme]` 选择器）。**必须最先加载**，后面的分片都依赖这些变量。',
  lines: lines.slice(0, 32).filter((line) => !isImport(line)),
});

for (let index = 0; index < ordered.length; index += 1) {
  const chunk = ordered[index];
  const next = ordered[index + 1];
  const end = next ? next.start - 1 : lines.length;
  const slice = lines.slice(chunk.start - 1, end).filter((line) => !isImport(line));
  const slot = written.get(chunk.file) ?? { header: chunk.header, lines: [] };
  if (slot.lines.length) slot.lines.push('');
  slot.lines.push(...slice);
  written.set(chunk.file, slot);
}

/* ---------- 写分片 ---------- */
mkdirSync(join(ROOT, 'public', 'css'), { recursive: true });
let totalWritten = 0;
for (const [file, slot] of written) {
  const content = [
    `/* ${file.replace('public/css/', '')} —— ${slot.header}`,
    ' *',
    ' * 本文件由 docs/tools/split-css.mjs 从原先的单体 public/style.css 切出来。',
    ' * 改样式请直接改这里；**不要**去改 public/style.css（它现在只是一个 @import 清单）。',
    ' */',
    '',
    ...slot.lines,
    '',
    HAND_WRITTEN,
    '',
  ].join('\n');
  writeFileSync(join(ROOT, file), content, 'utf8');
  totalWritten += slot.lines.length;
  console.log(`写入 ${file}（${slot.lines.length} 行）`);
}

/* ---------- public/style.css 只留 @import 清单 ---------- */
const importOrder = [...written.keys()]
  .map((file) => file.replace('public/css/', ''))
  .sort((a, b) => a.localeCompare(b, 'en')); // 两位前缀排序 = 原级联顺序
const styleContent = [
  '/* 样式入口 —— 只放 @import，按**原始级联顺序**把 public/css/ 下的分片拉回来。',
  ' *',
  ' * ⚠️ 三条不能破的规矩：',
  ' *   1) `@import` 必须写在文件最前面（CSS 规范），所以这个文件不能出现任何真实规则；',
  ' *   2) 分片顺序 = 覆盖顺序，调整顺序等于改样式，改前想清楚；',
  ' *   3) 新增分片请放到 public/css/ 下并在这里加一行，文件名用两位前缀控制位置。',
  ' */',
  '',
  ...baseImports,
  ...importOrder.map((name) => `@import url('./css/${name}');`),
  '',
].join('\n');
writeFileSync(SOURCE, styleContent, 'utf8');
console.log(`写入 public/style.css（${importOrder.length} 条 @import）`);

/* ---------- 覆盖自检 ----------
 * 光数行数不够稳（分片之间的分隔空行会让计数差 ±1）。真正的判据是
 * **「所有分片的非空行，按顺序拼起来，必须与原文件的非空行逐字节相同」**。
 * 这能抓出「少了一行」，也能抓出「顺序被换了」——而顺序对 CSS 就是优先级。
 */
const nonEmpty = (list) => list.map((line) => line.replace(/\s+$/, '')).filter((line) => line !== '');
// ⚠️ 拼接顺序必须用**文件名**排（两位前缀即原级联顺序），不能用 Map 的插入顺序 ——
// 插入顺序是「谁先被切到谁在前」，而切片的先后跟文件顺序无关。
const byName = (a, b) => a.localeCompare(b, 'en');
const merged = [];
for (const [, slot] of [...written.entries()].sort((a, b) => byName(a[0], b[0]))) {
  merged.push(...nonEmpty(slot.lines));
}
const original = nonEmpty(body);
const mismatch = (() => {
  if (merged.length !== original.length) return `行数不同：分片 ${merged.length} 行 vs 原文件 ${original.length} 行`;
  for (let index = 0; index < original.length; index += 1) {
    if (merged[index] !== original[index]) {
      return `第 ${index + 1} 行不同：\n  分片  : ${merged[index]}\n  原文件: ${original[index]}`;
    }
  }
  return null;
})();

console.log(`覆盖自检：原文件 ${lines.length} 行（其中 @import ${baseImports.length} 行），非空行 ${original.length} 行`);
console.log(`          分片共 ${totalWritten} 行，非空行 ${merged.length} 行`);
if (mismatch) {
  console.error(`❌ 覆盖自检没通过：${mismatch}`);
  process.exit(1);
}
console.log('✅ 覆盖自检通过（每一行样式都在，顺序也一致）');
