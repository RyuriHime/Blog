/**
 * 把宿主渲染器同步成交付包自带的兜底渲染器。
 *
 * 背景：`note-agent/src/markdown-core.mjs` 是 `src/markdown.js` 的一份**拷贝**，
 * 服务端会把它当静态资源发出去（挂在 `/notes-markdown.js`），让交付包被单独拷到
 * 别的站点、打不通宿主的 `POST /markdown/preview` 时，面板的「效果」预览还能渲染。
 *
 * 拷贝型代码最怕的就是**悄悄漂移**：这里就真出过一次 —— 宿主后来加了块级 `$$` 公式
 * 处理，这份拷贝没跟上，于是面板预览里多行公式永远显示成一串源码，而所有测试都是绿的
 * （当时那条「与宿主逐字一致」的用例比较的其实是宿主自己跟宿主自己，恒真）。
 *
 * 所以现在改成一件事：**正文逐字复制，只有文件头那段注释不同**，并且
 *   1. `node scripts/sync-markdown-core.mjs`        重新生成（改完宿主渲染器就跑一下）
 *   2. `node scripts/sync-markdown-core.mjs --check` 只检查，不同步就 exit 1（给 CI/测试用）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'src', 'markdown.js');
const TARGET = join(ROOT, 'note-agent', 'src', 'markdown-core.mjs');

const HEADER = `/**
 * 纯 Markdown 渲染实现（零依赖，Node 与浏览器都能跑）。
 *
 * 这是"宿主没有渲染器时"的兜底：面板的「效果」预览默认打宿主的
 * \`POST <hostBase>/markdown/preview\`（与站内真实渲染 100% 一致）；打不通时，
 * 浏览器会动态 import 这个模块（挂载层把它发在 \`/notes-markdown.js\`）自己渲染，
 * 于是交付包被单独拷到别的站点时，「效果」按钮依然点的动。
 *
 * 安全模型与宿主 \`src/markdown.js\` 一致：先把全部 HTML 转义，再只注入白名单标签，
 * 因此不存在 XSS 注入面。
 *
 * ⚠️ 本文件是 \`src/markdown.js\` 正文的**逐字拷贝**（只有上面这段注释不同）。
 *    以前它是一份悄悄漂移的旧拷贝 —— 少了块级 \`$$\` 处理，面板预览里多行公式
 *    永远显示成源码，而测试还是绿的。现在由 \`scripts/sync-markdown-core.mjs\`
 *    生成、由 \`note-agent/tests/test-markdown.mjs\` 守着：改了宿主渲染器就
 *    跑一次 \`node scripts/sync-markdown-core.mjs\`，忘了跑测试会直接报红。
 */`;

/**
 * 找出头部块注释的结尾。
 * 必须从第 3 个字符之后开始找：开头的三字符起始标记自己就含一对「星号 + 斜杠」
 * （在索引 1），从 0 找的话会当场命中，整个文件都会被当成「正文」。
 */
function headerEnd(text, label) {
  const end = text.indexOf('*/', 3);
  if (end === -1) throw new Error(`${label} 里找不到头部注释的结尾`);
  return end + 2;
}

/** 取出宿主渲染器的正文（第一段块注释之后的所有内容，原样保留）。 */
export function hostBody() {
  const source = readFileSync(SOURCE, 'utf8');
  return source.slice(headerEnd(source, relative(ROOT, SOURCE)));
}

/** 应该写进兜底拷贝的完整内容。 */
export function expectedContent() {
  // 这里**不能**再补一个换行：hostBody() 是从宿主头部注释的收尾标记之后切起的，
  // 开头本来就带着那个换行。多补一个会让生成结果与 inSync() 的判断差一个字节，
  // 于是「刚同步完就报漂移」。
  return `${HEADER}${hostBody()}`;
}

/** 正文是否已经一致（不含头部注释）。 */
export function inSync() {
  const target = readFileSync(TARGET, 'utf8');
  return target.slice(headerEnd(target, relative(ROOT, TARGET))) === hostBody();
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('sync-markdown-core.mjs')) {
  const checkOnly = process.argv.includes('--check');
  const target = relative(ROOT, TARGET).replace(/\\/g, '/');
  if (inSync()) {
    console.log(`✅ ${target} 与 src/markdown.js 正文逐字一致`);
  } else if (checkOnly) {
    console.error(`❌ ${target} 与 src/markdown.js 已经漂移，跑 node scripts/sync-markdown-core.mjs 同步`);
    process.exit(1);
  } else {
    writeFileSync(TARGET, expectedContent());
    console.log(`✍️  已重新生成 ${target}（正文来自 src/markdown.js，逐字复制）`);
  }
}
