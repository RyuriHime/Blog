#!/usr/bin/env node
/*
 * 知识网络图（#/graph）的静态接线检查。
 *
 * 为什么要有它：浏览器里的 canvas 页面没法在服务器上自动点，但「路由有没有接上、
 * 模板里的类名样式表里有没有、按钮 id 和 getElementById 对不对得上」这些都能静态查出来，
 * 而这类错误恰恰是最容易手滑写错、又最晚才被发现的。
 *
 * 用法：node scripts/check-graph-ui.mjs
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const APP = join(ROOT, 'public', 'app.js');
const CSS = join(ROOT, 'public', 'style.css');
const SERVER = join(ROOT, 'src', 'server.js');
// deploy.sh 不一定和代码包放在一起（它只在本机发布目录里）；常见的几处都找一下，
// 一个都找不到就跳过这几项检查（见文件末尾），不算失败。
const DEPLOY_CANDIDATES = [
  join(ROOT, 'deploy.sh'),
  join(ROOT, '..', 'deploy.sh'),
];

const [app, css, server] = await Promise.all([
  readFile(APP, 'utf8'),
  readFile(CSS, 'utf8'),
  readFile(SERVER, 'utf8'),
]);

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
const start = app.indexOf('知识网络图（knowledge-pack）');
const end = app.indexOf('/* 启动', start);
const block = start >= 0 && end > start ? app.slice(start, end) : '';

console.log('\n▶ 前端：知识网络图接线');

check('app.js 里能找到知识网络图代码块', block.length > 0);
check('定义了 async function viewGraph()', /async function viewGraph\(\)/.test(block));
check('定义了 function renderGraphPage(', /function renderGraphPage\(/.test(app));
check('路由已接上 #/graph', /if \(first === 'graph'\) return await viewGraph\(\);/.test(app));
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
check(
  'getElementById 的 id 都在模板里出现过',
  dangling.length === 0,
  dangling.join(', '),
);
check('画布 id 是 kg-canvas', ids.has('kg-canvas'));
check('右侧详情面板 id 是 kg-panel', ids.has('kg-panel'));

// 契约检查脚本会要求每个 data-action 都有对应的 switch case。
// 新页面刻意不用 data-action，改用 id 在视图内部绑定，这里守住这条约定。
check('新页面没有引入 data-action（避免和契约检查打架）', !/data-action=/.test(block));

console.log('\n▶ 后端：只读接口');

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

console.log('\n──────────────────────────────────────────────');
console.log(`通过 ${pass} 项，问题 ${fail} 项`);
process.exitCode = fail === 0 ? 0 : 1;
