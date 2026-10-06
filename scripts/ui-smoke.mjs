/**
 * 界面冒烟（P5 自己的端到端检查）。
 *
 * 守的是「右栏抽屉」这条交互：
 *   · 默认收起 —— 右边缘只留一条把手，主内容区吃满整宽
 *   · 悬停滑出 —— 鼠标移到把手/面板上滑出，移开自动收回
 *   · 可缩放   —— 面板左边缘能拖动改宽（200–520），记住设置，双击恢复默认
 *   · 键盘可达 —— 把手是 button、带 aria-expanded/aria-controls，Tab 聚焦也能滑出
 *   · 窄屏不退化 —— ≤900px 还原成静态侧栏（触屏没有 hover），把手隐藏
 *
 * 做法与 check-notes-ui.mjs 一个路子：读源码字面量 + 起临时服务器确认静态资源真发得出去。
 * （悬停/拖拽的真实行为无法在这个环境里用无头浏览器验证，所以这里守的是「接线与样式齐不齐」，
 *   另外用 jsdom 在仓库外做一遍真实事件验证。）
 *
 * 用法：node scripts/ui-smoke.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const SERVER = join(ROOT, 'src', 'server.js');
const DATA_DIR = join(ROOT, 'data');
const DB_FILE = join(DATA_DIR, 'ui-smoke.db');
const LOG_FILE = join(DATA_DIR, 'ui-smoke-server.log');
const PORT = Number(process.env.UI_SMOKE_PORT || 3418);
const BASE = `http://127.0.0.1:${PORT}`;

/** 不下降哨兵：断言条数（不含最后这条哨兵自己）。只允许往上加，不许改小。 */
const MIN_PASS = 41;

let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  OK  ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  !!  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const read = (rel) => {
  const file = join(PUBLIC, rel);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
};

const session = read('core/session.js');
const sidebarCss = read('css/55-sidebar.css');
const baseCss = read('css/10-base.css');
const responsiveCss = read('css/70-responsive.css');
const appJs = read('app.js');
const indexHtml = read('index.html');

/* ================================================================== */
/* 一、把手与面板结构（源码字面量）                                    */
/* ================================================================== */

console.log('\n▶ 抽屉的接线（public/core/session.js）');

check('渲染了右侧把手 id="sidebar-handle"', session.includes('id="sidebar-handle"'));
check('把手是 <button>（键盘可达，不是 div）', /<button[^>]*id="sidebar-handle"/.test(session));
check('把手带 aria-expanded（展开状态可被读屏感知）', /id="sidebar-handle"[\s\S]{0,200}aria-expanded/.test(session) || /aria-expanded[\s\S]{0,200}id="sidebar-handle"/.test(session));
check('把手带 aria-controls="sidebar-panel"', session.includes('aria-controls="sidebar-panel"'));
check('渲染了面板 id="sidebar-panel"', session.includes('id="sidebar-panel"'));
check('渲染了拖拽带 id="sidebar-resizer"', session.includes('id="sidebar-resizer"'));
check('面板里仍然是原来的卡片（动态卡还在）', session.includes('card-title">🌊 动态'));

/* ================================================================== */
/* 二、行为常量与事件                                                  */
/* ================================================================== */

console.log('\n▶ 收起 / 滑出 / 拖宽的行为');

check('最小宽度常量 200', /SIDEBAR_MIN_WIDTH\s*=\s*200/.test(session), '找不到 SIDEBAR_MIN_WIDTH = 200');
check('最大宽度常量 520', /SIDEBAR_MAX_WIDTH\s*=\s*520/.test(session), '找不到 SIDEBAR_MAX_WIDTH = 520');
check('默认宽度常量 306', /SIDEBAR_DEFAULT_WIDTH\s*=\s*306/.test(session), '找不到 SIDEBAR_DEFAULT_WIDTH = 306');
check('宽度存进 localStorage（forum:sidebarWidth）', session.includes('forum:sidebarWidth'));
check('悬停滑出：绑了 mouseenter', session.includes("addEventListener('mouseenter'"));
check('移开收回：绑了 mouseleave 且有延迟常量', session.includes("addEventListener('mouseleave'") && /SIDEBAR_HIDE_DELAY\s*=\s*\d+/.test(session));
check('键盘可达：绑了 focusin（Tab 聚焦也滑出）', session.includes("addEventListener('focusin'"));
check('拖拽调宽：绑了 pointerdown 且 clamp 到区间内', session.includes("addEventListener('pointerdown'") && /clampSidebarWidth|Math\.min\(SIDEBAR_MAX_WIDTH/.test(session));
check('双击拖拽带恢复默认宽度', session.includes("addEventListener('dblclick'"));
check('开关抽屉会切 is-open 类并同步 aria-expanded', /classList\.toggle\('is-open'/.test(session) && /setAttribute\('aria-expanded'/.test(session));
check('取把手用的是类选择器（动态元素的 id 不能在 JS 里用 $(\'#…\') 查，会被 UI 契约检查拦下）', session.includes("querySelector('.sidebar-handle')") && !session.includes("$('#sidebar-handle')"));

/* ================================================================== */
/* 三、样式分片                                                        */
/* ================================================================== */

console.log('\n▶ 样式（public/css/55-sidebar.css）');

check('.sidebar-handle 有定义', /\.sidebar-handle\s*\{/.test(sidebarCss));
check('.sidebar-panel 有定义', /\.sidebar-panel\s*\{/.test(sidebarCss));
check('.sidebar-resizer 有定义', /\.sidebar-resizer\s*\{/.test(sidebarCss));
check('收起态：位移挂在容器上（把手与面板是一块，一起出一起回）', /\.sidebar\s*\{[^}]*translateX\(var\(--sidebar-width/.test(sidebarCss));
check('展开态 .sidebar.is-open 里是 translateX(0)', /\.sidebar\.is-open\s*\{[^}]*translateX\(0\)/.test(sidebarCss));
check('面板自己没有位移规则（否则移开面板时把手会留在半路）', !/\.sidebar-panel\s*\{[^}]*transform:/.test(sidebarCss));
check('有过渡动画', /transition[\s\S]{0,60}transform|transform[\s\S]{0,60}transition/.test(sidebarCss));
check('面板宽度走 CSS 变量且默认 306px', /var\(--sidebar-width,\s*306px\)/.test(sidebarCss));
check('收起时容器不吃点击（只有把手/面板可点）', /\.sidebar\s*\{[\s\S]*?pointer-events:\s*none/.test(baseCss + sidebarCss));
check('把手是一条窄条（宽度 ≤ 40px）', /\.sidebar-handle\s*\{[\s\S]*?width:\s*(?:[1-3]?\d)px/.test(sidebarCss));

/* ================================================================== */
/* 四、布局与窄屏                                                      */
/* ================================================================== */

console.log('\n▶ 布局与窄屏');

check('.layout 已是单列（不再给右栏预留 306px）', /\.layout\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)\s*;/.test(baseCss) && !/\.layout\s*\{[\s\S]*?306px/.test(baseCss));
check('基础样式里侧栏是固定定位的抽屉', /\.sidebar\s*\{[\s\S]*?position:\s*fixed/.test(sidebarCss) || /\.sidebar\s*\{[\s\S]*?position:\s*fixed/.test(baseCss));
check('≤900px 侧栏回到静态（触屏不做浮层）', /@media\s*\(max-width:\s*900px\)[\s\S]*?\.sidebar\s*\{[\s\S]*?position:\s*static/.test(baseCss + responsiveCss));
check('≤900px 把手隐藏', /@media\s*\(max-width:\s*900px\)[\s\S]*?\.sidebar-handle\s*\{[\s\S]*?display:\s*none/.test(baseCss + responsiveCss));
check('≤900px 容器不再位移（还原成静态侧栏）', /@media\s*\(max-width:\s*900px\)[\s\S]*?\.sidebar\s*\{[^}]*transform:\s*none/.test(baseCss + responsiveCss));

/* ================================================================== */
/* 五、契约：源码里用到的类名都得在 CSS 里有定义                        */
/* ================================================================== */

console.log('\n▶ 契约（新类名必须有样式，否则 check-ui-contract 会红）');

const allCss = read('css/00-themes.css') + baseCss + sidebarCss + responsiveCss + read('css/20-components.css');
for (const cls of ['sidebar-handle', 'sidebar-panel', 'sidebar-resizer']) {
  check(`.${cls} 在样式表里有定义`, new RegExp(`\\.${cls}\\b`).test(allCss));
}

/* ================================================================== */
/* 六、真实服务：静态资源发得出去                                      */
/* ================================================================== */

console.log('\n▶ 临时服务器（静态分发）');

mkdirSync(DATA_DIR, { recursive: true });
const fd = openSync(LOG_FILE, 'w');
const child = spawn(process.execPath, [SERVER], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), DB_FILE },
  stdio: ['ignore', fd, fd],
});

let ready = false;
for (let i = 0; i < 60; i += 1) {
  try {
    const res = await fetch(`${BASE}/`);
    if (res.ok) {
      ready = true;
      break;
    }
  } catch {
    /* 还没起来 */
  }
  await sleep(250);
}
check('临时服务器起来了', ready);

if (ready) {
  const home = await fetch(`${BASE}/`);
  const homeHtml = await home.text();
  check('GET / 返回 200 且是入口页', home.status === 200 && homeHtml.includes('/app.js'));

  const style = await fetch(`${BASE}/style.css`);
  check('GET /style.css 200 且 @import 了 55-sidebar.css', style.status === 200 && (await style.text()).includes('55-sidebar.css'));

  const frag = await fetch(`${BASE}/css/55-sidebar.css`);
  const fragText = await frag.text();
  check('GET /css/55-sidebar.css 200 且含 .sidebar-panel', frag.status === 200 && fragText.includes('.sidebar-panel'));

  const sess = await fetch(`${BASE}/core/session.js`);
  check('GET /core/session.js 200 且含 sidebar-handle', sess.status === 200 && (await sess.text()).includes('sidebar-handle'));
}

child.kill();
await sleep(200);
rmSync(DB_FILE, { force: true });
rmSync(`${DB_FILE}-shm`, { force: true });
rmSync(`${DB_FILE}-wal`, { force: true });
rmSync(LOG_FILE, { force: true });

/* ================================================================== */
/* 汇总                                                                */
/* ================================================================== */

console.log('\n──────────────────────────────────────────────');
check(`断言数量不低于哨兵（${MIN_PASS} 项）`, passed >= MIN_PASS, `实际只有 ${passed} 项通过`);

if (passed < MIN_PASS) {
  console.log(`  ❌ 通过项数从 ${MIN_PASS} 掉到 ${passed}：有断言没被执行（文件被搬走却没同步本检查？）`);
}

console.log(`通过 ${passed} 项，问题 ${failures.length} 项`);
if (failures.length) {
  console.log('');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
void appJs;
void indexHtml;
