// 学术笔记（#/notes）前端静态契约检查。
// 只切「学术笔记」那一段代码来看，
// 免得把别的视图的类名 / id 算进来。
//
// 用法：node scripts/check-notes-ui.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 递归收集 public/ 下指定后缀的文件。
 *
 * ⚠️ 骨架改造后的变化（第二次调整）：前端拆成了 `public/core/*` + `public/views/*`，
 * 样式拆成 `public/css/*`。原先直接 `readFileSync('public/app.js')` 会在文件一搬家后
 * **静默失效**（断言全都不跑、测试却还是绿的），所以这里改成扫整个目录。
 */
function collect(dir, suffix, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collect(full, suffix, out);
    else if (entry.endsWith(suffix)) out.push(full);
  }
  return out;
}

const PUBLIC = join(ROOT, 'public');
const app = collect(PUBLIC, '.js').map((file) => readFileSync(file, 'utf8')).join('\n');
const css = collect(PUBLIC, '.css').map((file) => readFileSync(file, 'utf8')).join('\n');
const html = readFileSync(join(PUBLIC, 'index.html'), 'utf8');
// 笔记页现在单独一个文件，切段落直接认这个文件最准（不用再靠「下一个视图的注释」定位）。
const notesFile = readFileSync(join(PUBLIC, 'views', 'notes.js'), 'utf8');

let pass = 0;
const problems = [];

/** 骨架改造时的通过项数下限。只许涨，不许跌。 */
const MIN_PASS = Number(process.env.MIN_PASS || 33);

function check(label, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log(`  ✅ ${label}`);
  } else {
    problems.push(label);
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/* ---------------------------------------------------------------- */
/* 切出笔记那一段                                                     */
/* ---------------------------------------------------------------- */

// v2 把笔记拆成了独立文件，所以这里直接认文件，
// 不用再靠「下一个视图的注释」当下标（main 上那个 `/* 启动` 定位法就是为单文件写的）。
const block = notesFile;

console.log('\n▶ 前端：学术笔记接线');

check('app.js 里能找到学术笔记代码块', block.length > 0);
check('定义了 async function viewNotes()', /async function viewNotes\(\)/.test(block));
// 路由分发现在在 `public/core/router.js` 里，而且调用带命名空间前缀（`Notes.viewNotes()`）。
// 正则写成「`viewNotes()` 结尾」即可兼容两种写法，不必锁死前缀。
check('路由已接上 #/notes', /if \(first === 'notes'\) return await [\w.]*viewNotes\(\);/.test(app));
// P5：这个入口从侧栏搬到了顶栏「发动态」旁边（public/core/session.js 里的 .top-link）。
// 断言放宽成「顶栏或侧栏有它」，但仍然是「锚点 + 链接类名 + 正确 href」，不会变成恒真。
check('界面上有「学术笔记」入口（顶栏或侧栏）', /class="(?:side-link|top-link)" href="#\/notes"/.test(app));
check(
  '侧栏入口和路由用的同一个地址',
  /href="#\/notes"/.test(app) && /first === 'notes'/.test(app),
);
check(
  '笔记页要求登录',
  /if \(!state\.me\) \{[\s\S]{0,120}navigate\('\/login'\);/.test(block),
);
check('登录后会带着 redirect 回来', /state\.redirect = '\/notes'/.test(block));

console.log('\n▶ 前端：接口约定');

check('走 /api/notes-mine 取「我的笔记」', /api\('\/api\/notes-mine'\)/.test(block));
check('走 /api/notes-square 取「公开广场」', /api\('\/api\/notes-square'\)/.test(block));
check(
  '读别人的公开笔记走 /api/notes-square/:owner/:name',
  /\/api\/notes-square\/\$\{encodeURIComponent\(ownerId\)\}\/\$\{encodeURIComponent\(name\)\}/.test(block),
);
check('公开走 POST …/publish', /\/publish`, 'POST'/.test(block));
check('取消公开走 POST …/unpublish', /\/unpublish`, 'POST'/.test(block));
check('删除走 DELETE', /await ntMutate\(path, 'DELETE'/.test(block));
check('删除前有二次确认', /window\.confirm\(/.test(block));
check('笔记名做了 URL 编码', /encodeURIComponent\(ntName\)/.test(block));

console.log('\n▶ 前端：渲染与安全');

check('正文用服务端渲染好的 html', /\$\{note\.html \|\|/.test(block));
check('正文容器带 .md 样式类', /class="md nt-article"/.test(block));
check(
  '所有插值都过了 esc()（没直接拼裸字段进 HTML）',
  !/\$\{note\.(title|name|excerpt|ownerName)\}/.test(block),
);
check('没接中央的 data-action 分发（不动 UI 契约那边）', !/data-action=/.test(block));
check('用 id / data-nt-* 就地绑定', /data-nt-act=/.test(block) && /data-nt-tab/.test(block));

console.log('\n▶ 前端：公式渲染');

check('KaTeX 用的是 note-studio 自带的离线文件', /'\/notes\/vendor\/katex\/katex\.min\.js'/.test(block));
check('自动渲染脚本也是离线自带的', /'\/notes\/vendor\/katex\/contrib\/auto-render\.min\.js'/.test(block));
check('样式也是离线自带的', /'\/notes\/vendor\/katex\/katex\.min\.css'/.test(block));
check('没有引用任何外部 CDN', !/https?:\/\/(?!47\.106)/.test(block));
check('行内与块级公式定界符都配了', /\{ left: '\$\$', right: '\$\$', display: true \}/.test(block));
check('渲染失败不炸页面（throwOnError: false）', /throwOnError: false/.test(block));

console.log('\n▶ 前端：样式');

const classNames = new Set();
for (const m of block.matchAll(/class="([^"$]*?)"/g)) {
  for (const token of m[1].split(/\s+/)) if (token.startsWith('nt-')) classNames.add(token);
}
check('模板里用到了 nt-* 类名', classNames.size > 0, `找到 ${classNames.size} 个：${[...classNames].join(', ')}`);
const missing = [...classNames].filter((name) => !css.includes(`.${name}`));
check('所有 nt-* 类名都在 style.css 里定义了', missing.length === 0, missing.join(', '));
check('style.css 里有笔记段的注释分节', css.includes('学术笔记（#/notes）'));

console.log('\n▶ 前端：说明文案');

check('空列表给了引导文案', /你还没有笔记/.test(block) && /广场上还没有笔记/.test(block));
check('页面写明了默认私密', /笔记默认私密/.test(block));
check('有新窗口打开编辑器的入口', /href="\/notes\/" target="_blank"/.test(block));
check('入口只加在侧栏，没动 index.html 顶栏', !html.includes('#/notes') && !html.includes('/notes/'));

console.log('\n' + '─'.repeat(46));
/* 不下降哨兵：通过项数不得少于骨架改造时的实测值。 */
if (pass < MIN_PASS) {
  problems.push(`通过项数从 ${MIN_PASS} 掉到 ${pass}：有断言没被执行（文件被搬走却没同步本检查？）`);
  console.log(`  ❌ 通过项数从 ${MIN_PASS} 掉到 ${pass}：有断言没被执行（文件被搬走却没同步本检查？）`);
}
console.log(`通过 ${pass} 项，问题 ${problems.length} 项`);
if (problems.length) {
  console.log('  - ' + problems.join('\n  - '));
  process.exit(1);
}
