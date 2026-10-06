#!/usr/bin/env node
/*
 * 知识网络图（#/graph）的静态接线检查。
 *
 * 为什么要有它：浏览器里的 canvas 页面没法在服务器上自动点，但「路由有没有接上、
 * 模板里的类名样式表里有没有、按钮 id 和 getElementById 对不对得上」这些都能静态查出来，
 * 而这类错误恰恰是最容易手滑写错、又最晚才被发现的。
 *
 * ⚠️ 骨架改造后的变化（第二次调整）：前端也拆了。
 *    `public/app.js` 从 4254 行的单体拆成 `public/core/*` + `public/views/*`，
 *    样式拆成 `public/css/*`（`public/style.css` 只剩一串 @import）。
 *    所以这里也改成**递归扫描整个 public/ 目录**：`.js` 拼成一份「全前端源码」、
 *    `.css` 拼成一份「全样式源码」，断言照旧但不再依赖 `app.js` 这个具体文件。
 *    同样的理由，MIN_PASS 哨兵保留：通过项数不得少于骨架改造时的实测值。
 *
 * 用法：node scripts/check-graph-ui.mjs
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PUBLIC = join(ROOT, 'public');
const SRC = join(ROOT, 'src');

/** 骨架改造时的通过项数下限。只许涨，不许跌。 */
const MIN_PASS = Number(process.env.MIN_PASS || 24);

// deploy.sh 不一定和代码包放在一起（它只在本机发布目录里）；常见的几处都找一下，
// 一个都找不到就跳过这几项检查（见文件末尾），不算失败。
const DEPLOY_CANDIDATES = [join(ROOT, 'deploy.sh'), join(ROOT, '..', 'deploy.sh')];

/** 递归收集目录下指定后缀的文件。 */
async function collectSource(dir, suffix, files = []) {
  for (const entry of await readdir(dir)) {
    const full = join(dir, entry);
    const info = await stat(full);
    if (info.isDirectory()) await collectSource(full, suffix, files);
    else if (entry.endsWith(suffix)) files.push(full);
  }
  return files;
}

const [jsFiles, cssFiles, srcFiles] = await Promise.all([
  collectSource(PUBLIC, '.js'),
  collectSource(PUBLIC, '.css'),
  collectSource(SRC, '.js'),
]);
const [jsTexts, cssTexts, srcTexts] = await Promise.all([
  Promise.all(jsFiles.map((file) => readFile(file, 'utf8'))),
  Promise.all(cssFiles.map((file) => readFile(file, 'utf8'))),
  Promise.all(srcFiles.map((file) => readFile(file, 'utf8'))),
]);
const app = jsTexts.join('\n');
const css = cssTexts.join('\n');
const server = srcTexts.join('\n');

const rel = (file) => relative(ROOT, file).split('\\').join('/');

/**
 * 知识网络图现在**单独一个文件**（`public/views/graph.js`），切段落直接认这个文件最准。
 * 原先靠 `app.indexOf('知识网络图（knowledge-pack）')` 找段落起点，前端一拆文件就返回 0
 * —— 这也是「测试静默失效」的典型：block 为空时后面所有断言都会失败而不是被跳过，
 * 所以必须保留一条「block 非空」的硬断言当哨兵。
 */
const graphFile = await readFile(join(PUBLIC, 'views', 'graph.js'), 'utf8');

let pass = 0;
let fail = 0;

function check(label, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  ✅ ${label}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${label}${detail ? `  — ${detail}` : ''}`);
  }
}

/** 只取「知识网络图」那一段，避免把别的视图的类名/ id 算进来。 */
const block = graphFile;

console.log('\n▶ 前端：知识网络图接线');

check('前端能找到知识网络图代码块', block.length > 0, `块长 ${block.length}`);
check('定义了 async function viewGraph()', /async function viewGraph\(\)/.test(block));
check('定义了 function renderGraphPage(', /function renderGraphPage\(/.test(app));
// 路由分发现在在 `public/core/router.js` 里，而且调用带命名空间前缀（`Graph.viewGraph()`）。
// 正则写成「`viewGraph()` 结尾」即可兼容两种写法，不必锁死前缀。
check('路由已接上 #/graph', /if \(first === 'graph'\) return await [\w.]*viewGraph\(\);/.test(app));
check('侧栏有「知识网络图」入口', /class="side-link" href="#\/graph"/.test(app));
check(
  '侧栏入口和路由用的同一个地址',
  /href="#\/graph"/.test(app) && /first === 'graph'/.test(app),
);
check('页面公开可看（不强制登录）', !/navigate\('\/login'\)/.test(block));
check('走 /api/knowledge/graph 取数', /api\('\/api\/knowledge\/graph'\)/.test(block));
check('图没生成时给的是「还没生成」而不是报错页', /知识网络图还没有生成/.test(block));

console.log('\n▶ 前端：canvas 与样式');

const classNames = new Set();
for (const m of block.matchAll(/class="([^"$]*?)"/g)) {
  for (const token of m[1].split(/\s+/)) if (token.startsWith('kg-')) classNames.add(token);
}
check('模板里用到了 kg-* 类名', classNames.size > 0, `找到 ${classNames.size} 个`);
const missing = [...classNames].filter((name) => !css.includes(`.${name}`));
check('所有 kg-* 类名都在 style.css 里定义了', missing.length === 0, missing.join(', '));
check('style.css 有 #kg-canvas 画布样式', /#kg-canvas\s*\{/.test(css));
check('style.css 有窄屏适配', /@media[\s\S]{0,200}\.kg-wrap/.test(css));

const ids = new Set([...block.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]));
const declared = new Set([...block.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const dangling = [...ids].filter((id) => !declared.has(id));
check('getElementById 的 id 都在模板里出现过', dangling.length === 0, dangling.join(', '));
check('画布 id 是 kg-canvas', ids.has('kg-canvas'));
check('右侧详情面板 id 是 kg-panel', ids.has('kg-panel'));

// 契约检查脚本会要求每个 data-action 都有对应的 switch case。
// 新页面刻意不用 data-action，改用 id 在视图内部绑定，这里守住这条约定。
check('新页面没有引入 data-action（避免和契约检查打架）', !/data-action=/.test(block));

console.log('\n▶ 后端：只读接口');
console.log(`  （前端扫描 ${jsFiles.length} 个 .js、${cssFiles.length} 个 .css；后端扫描 ${srcFiles.length} 个 .js 拼成源码；命中后端文件：${srcFiles.map(rel).filter((f) => f.includes('graph-paths') || f.includes('routes-b')).join(', ')}）`);

check("注册了 GET /api/knowledge/graph", /'\/api\/knowledge\/graph'/.test(server));
check("注册了 GET /api/knowledge/viewer", /'\/api\/knowledge\/viewer'/.test(server));
check('图文件路径在 data/knowledge 下', /data',\s*'knowledge',\s*'graph\.json'/.test(server));
check('状态文件路径在 data/knowledge 下', /data',\s*'knowledge',\s*'status\.json'/.test(server));
check('图不存在时返回 404 而不是崩', /graph_not_built/.test(server));
check('viewer 不存在时返回 404', /viewer_not_built/.test(server));
check(
  'viewer 用 text/html 且带 nosniff',
  /text\/html; charset=utf-8/.test(server) && /X-Content-Type-Options/.test(server),
);

console.log('\n▶ 部署：knowledge-pack 要跟着走');

let deploy = null;
for (const candidate of DEPLOY_CANDIDATES) {
  try {
    deploy = await readFile(candidate, 'utf8');
    break;
  } catch {
    /* 换下一个候选路径 */
  }
}

if (deploy) {
  check('deploy.sh 会把 knowledge-pack 一起换上去', /for d in src public scripts knowledge-pack;/.test(deploy));
  check('deploy.sh 会备份 knowledge-pack', /cp -a "\$APP\/knowledge-pack"/.test(deploy));
  check('回滚时会连 knowledge-pack 一起还原', /rm -rf "\$APP\/src" "\$APP\/public" "\$APP\/scripts" "\$APP\/forum-ai" "\$APP\/knowledge-pack"/.test(deploy));
  check('缺 knowledge-pack 时部署直接失败（不会部署到一半）', /imports knowledge-pack\/src\/cli\.mjs but the archive has no knowledge-pack/.test(deploy));
} else {
  console.log('  ⚠️  跳过：找不到 deploy.sh（它不在代码包里，只在本机发布目录）');
}

/* 不下降哨兵：通过项数不得少于骨架改造时的实测值。 */
if (pass < MIN_PASS) {
  fail += 1;
  console.log(`  ❌ 通过项数从 ${MIN_PASS} 掉到 ${pass}：有断言没被执行（文件被搬走却没同步本检查？）`);
}

console.log('\n──────────────────────────────────────────────');
console.log(`通过 ${pass} 项，问题 ${fail} 项`);
process.exitCode = fail === 0 ? 0 : 1;
