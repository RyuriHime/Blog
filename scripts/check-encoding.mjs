/**
 * 编码体检：确认所有源码都是干净的 UTF-8（没有 BOM、乱码替换字符或 CP936 误读留下的私用区字符）。
 * 用法：node scripts/check-encoding.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const TARGETS = ['src', 'public', 'scripts', 'package.json', 'README.md', 'start.cmd'];

/** 每个文件必须包含的中文片段，用来确认没有被转码破坏。 */
const EXPECTED = {
  'src/server.js': ['围炉论坛已启动', '不能给自己的帖子投币', '只支持「赞」或「踩」', '每日签到', '排行榜', '头像：预设 emoji 或上传图片', '需要管理团队身份', '黑名单'],
  'src/store.js': ['数据访问层', '已取消「每天补足」机制', '签到：+1 币', '文章价值榜', '隐藏 / 取消隐藏', '互相关注'],
  'src/dates.js': ['日期工具', '自然周'],
  'src/db.js': ['综合讨论', '投币：单帖每人最多 2 币', '个人主页的文章分类', '转发（同一用户对同一篇只留一条', '预设 emoji 头像', '站长：建站者', '私信规则'],
  'src/markdown.js': ['极简 Markdown 渲染器'],
  'src/password.js': ['恒定时间比对'],
  'public/index.html': ['围炉论坛', '搜索帖子标题或内容', 'forum:theme', '首屏前应用背景主题'],
  'public/app.js': ['消息通知', '投币成功，感谢支持作者', '价值排行榜', '转发会出现在你的主页', '跟随系统', '暖阳', '奶黄', '正在压缩图片', '站长可以任命管理员', '私信'],
  'public/style.css': ['消息铃铛', '评价 / 投币按钮', '转发按钮与转发区', '背景主题', '暖阳：琥珀黄深色', '头像设置', '角色与内容管理', '私信与黑名单'],
  'scripts/smoke.mjs': ['端到端冒烟测试', '每日签到', '价值排行榜', '设置预设 emoji 头像成功', '角色与管理员分配', '单方面关注每天只能发一条'],
};

function walk(target, files = []) {
  const full = join(ROOT, target);
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
let checked = 0;

for (const target of TARGETS) {
  for (const file of walk(target)) {
    const rel = relative(ROOT, file).split('\\').join('/');
    const buffer = readFileSync(file);
    checked += 1;

    if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
      problems.push(`${rel}: 文件带 UTF-8 BOM`);
    }
    const text = buffer.toString('utf8');
    if (text.includes('\uFFFD')) problems.push(`${rel}: 含替换字符 U+FFFD（解码失败）`);
    if (/[\uE000-\uF8FF]/.test(text)) problems.push(`${rel}: 含私用区字符（疑似 CP936 误读留下的乱码）`);
    if (/[ÃÂ][\u0080-\u00BF]/.test(text)) problems.push(`${rel}: 疑似 Latin-1 乱码`);

    for (const snippet of EXPECTED[rel] ?? []) {
      if (!text.includes(snippet)) problems.push(`${rel}: 缺少预期内容「${snippet}」`);
    }

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

console.log(`已检查 ${checked} 个文件`);
if (problems.length === 0) {
  console.log('✅ 所有文件编码正常，中文内容完整');
  process.exit(0);
}
console.log(`❌ 发现 ${problems.length} 个问题：`);
for (const problem of problems) console.log(`  · ${problem}`);
process.exit(1);
