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
const MIN_PASS = 55;

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
/* 三·2、输入框：别让 <input class="input"> 裸奔成浏览器默认外观        */
/* ================================================================== */

console.log('\n▶ 输入框（「粘贴帖子链接」那一行）');

const timelineCss = read('css/31-timeline.css');
const formsCss = read('css/50-forms.css');

check(
  '「粘贴帖子链接」那一行有自己的主题样式（不再是浏览器默认的白框）',
  /\.composer-ref-row\s+\.input\s*\{[^}]*(background|border)\s*:/.test(timelineCss),
  '引用框只有 flex:1，没有背景/边框声明',
);
check(
  '基础表单样式覆盖 .input（没写 type 的 input 属性选择器匹配不到，会漏成默认外观）',
  /(^|\n)\s*\.input\s*[,{]/.test(formsCss),
  '50-forms.css 的基础控件选择器里没有 .input',
);

/* ================================================================== */
/* 三·3、侧栏内容裁剪 + 固定（pin）                                    */
/* ================================================================== */

console.log('\n▶ 侧栏内容与固定');

check(
  '侧栏不再渲染「📅 每日签到」卡（签到功能已整条下线，这张卡是它最后的残留）',
  !/const checkinCard = state\.me/.test(session) && !/\$\{checkinCard\}/.test(session),
);
check('侧栏不再渲染「🏆 价值排行榜」卡', !session.includes('card-title">🏆 价值排行榜'));
check('侧栏不再渲染「🔥 热门讨论」卡', !session.includes('card-title">🔥 热门讨论'));
check('侧栏里也不再算热门列表（hotPosts 那个 map 去掉了）', !session.includes('state.site.hotPosts'));
check(
  '签到 / 排行榜整条下线后，用户菜单里也没留下点不动的死链',
  !/menu-item" href="#\/checkin"/.test(session) && !/menu-item" href="#\/ranking"/.test(session),
);
check(
  '固定（pin）：状态存进 localStorage（forum:sidebarPinned）',
  session.includes('forum:sidebarPinned') && /Prefs\.writePreference\(SIDEBAR_PIN_KEY/.test(session),
);
check(
  '固定（pin）：点把手 = 钉住 / 取消钉住',
  /function toggleSidebarPin\s*\(/.test(session) && /closest\?\.\('\.sidebar-handle'\)\)\s*toggleSidebarPin\(\)/.test(session),
);
check(
  '固定（pin）：钉住后 mouseleave 不收回',
  /mouseleave'[\s\S]{0,220}?state\.sidebarPinned\)\s*return/.test(session),
);
check(
  '固定（pin）：钉住后焦点离开也不收回',
  /focusout'[\s\S]{0,220}?state\.sidebarPinned\)\s*return/.test(session),
);
check('固定（pin）：把手有钉住态（is-pinned + 图钉图标 + aria-pressed）', /classList\.toggle\('is-pinned'/.test(session) && session.includes('sidebar-handle-icon-pin') && /setAttribute\('aria-pressed'/.test(session));
check('固定（pin）：钉住的样式在 55-sidebar.css 里', /\.sidebar\.is-pinned\s+\.sidebar-handle/.test(sidebarCss) && /\.sidebar-handle-icon-pin\s*\{/.test(sidebarCss));
check(
  '侧栏不再用榜单后，首屏不再为空榜多打一次请求（loadSite 里那次 /api/ranking?limit=5 去掉了）',
  !/api\/ranking\?limit=5/.test(session),
);

/* ================================================================== */
/* 三·4、起始页（`#/`）与动态流（`#/feed`）—— m05506 起两个地址对调     */
/* ================================================================== */

console.log('\n▶ 起始页（#/）与动态流（#/feed）');

const routerJs = read('core/router.js');
const styleEntryCss = read('style.css');
const startJs = read('views/start.js');
const startCss = read('css/25-start.css');

// 只要求「导出里有 viewStart」，不写死整份导出清单 —— 起始页后来又多了
// `viewAnnouncements` 与 `ANNOUNCE_BOARD`，写死的话每加一个导出都要来改这条。
check(
  '新页面文件存在并导出 viewStart',
  /async function viewStart\s*\(/.test(startJs) && /export \{[^}]*\bviewStart\b[^}]*\}/.test(startJs),
  'views/start.js 里找不到 viewStart 或它没被导出',
);
check(
  '站务公告列表页：路由 #/announcements 指向 Start.viewAnnouncements',
  /first === 'announcements'[\s\S]{0,60}?Start\.viewAnnouncements\(query\)/.test(routerJs),
  'router.js 里没有 #/announcements 分支',
);
check(
  '公告页复用现成接口（/api/docs?template=announce&sort=created&limit&page），没为新页面加后端',
  /\/api\/docs\?template=\$\{ANNOUNCE_TEMPLATE\}&sort=created&limit=\$\{limit\}&page=\$\{page\}/.test(startJs)
    && /const ANNOUNCE_TEMPLATE = 'announce'/.test(startJs)
    && !/\/api\/announce/.test(startJs),
  '公告页没走 /api/docs?template=announce（已有的积木接口），或者偷偷加了 /api/announce 这种专用后端',
);
check(
  '公告页会翻页，页码走 paginationHtml（团队页同一套零件）',
  /paginationHtml\(page, totalPages/.test(startJs) && /#\/announcements\?page=/.test(startJs),
);
check(
  '首页那块仍然只放 5 条（取接口时就只要 5 条，取回来再截一道）',
  /ANNOUNCE_COUNT = 5/.test(startJs)
    && /FETCH_PER_PAGE = 5/.test(startJs)
    && /slice\(0, ANNOUNCE_COUNT\)/.test(startJs),
  '首页公告要么要多了、要么没截 —— 用户明确要求主页只显示 5 条',
);
check(
  '首页公告卡上有去#/announcements 的「查看全部」入口',
  /class="announce-more" href="#\/announcements"/.test(startJs),
  '首页那块没有入口，用户看不到全部公告',
);
check(
  '公告页的新类名都有样式（否则 check-ui-contract 会红）',
  ['.announce-more', '.announce-head', '.announce-page', '.announce-list', '.announce-row', '.announce-link', '.announce-pin', '.announce-excerpt', '.announce-row-meta', '.announce-pager'].every(
    (sel) => new RegExp(`\\${sel}\\b`).test(startCss),
  ),
);
check(
  '`#/` 直接渲染起始页 —— 无论登录与否（不再有 state.me 那半条件）',
  /if \(!first\) return await Start\.viewStart\(\)/.test(routerJs)
    && !/!state\.me[\s\S]{0,120}?'#\/start'/.test(routerJs),
  'router.js 的 #/ 分支还是「只有未登录的第一次访问才转起始页」的老逻辑',
);
check(
  '老地址 #/start 保留成别名（进的是同一页，不是死链）',
  /first === 'start'[\s\S]{0,40}?Start\.viewStart\(\)/.test(routerJs),
);
check(
  '动态流搬到 #/feed（查询串也跟着走）',
  // 中间那段现在多了「有 second 就进单条动态」的分支，所以窗口放宽到 400 字符 ——
  // 钉的是「`first === 'feed'` 之后确实会走到 `viewTimeline(query)`」，不是中间有几个字。
  /first === 'feed'[\s\S]{0,400}?Timeline\.viewTimeline\(query\)/.test(routerJs),
);
// 转发卡片的引用块以前是死块，别人在转发底下回复时通知发给了转发的人、原作者收不到。
// 给原动态一个地址是那条链路的解药，所以单独钉住它。
check(
  '单条动态有自己的地址 #/feed/<id>（转发卡片点得回原动态去评论）',
  /first === 'feed'[\s\S]{0,200}?Timeline\.viewFeedItem\(Number\(second\)\)/.test(routerJs),
);
check(
  '三块入口分别指向 动态 #/feed · 积木广场 #/docs · 团队 #/teams',
  /href="\$\{href\}"/.test(startJs) && /href: '#\/feed'/.test(startJs) && /href: '#\/docs'/.test(startJs) && /href: '#\/teams'/.test(startJs),
);
check(
  '首页那块公告取的是同一个积木接口（template=announce），limit 固定 5 条',
  /safeApi\(announceApi\(FETCH_PER_PAGE, 1\)/.test(startJs)
    && /const FETCH_PER_PAGE = 5/.test(startJs)
    && !/\/api\/posts\?board=/.test(startJs),
  '首页公告没走 /api/docs?template=announce&limit=5（或者还在按板块取帖子）',
);
check('公告取不到时有兜底文案（不是空白一块）', /还没有公告|emptyHtml\(/.test(startJs));
check(
  '三块预览用的都是现成接口：/api/posts · /api/docs · /api/teams',
  /\/api\/posts\?/.test(startJs) && /\/api\/docs/.test(startJs) && /\/api\/teams/.test(startJs),
);
check('新样式分片 25-start.css 已挂进 style.css', /25-start\.css/.test(styleEntryCss));
check(
  '起始页关键类名都有样式（两栏骨架 + 三块入口 + 标题）',
  ['.start-page', '.start-title', '.start-columns', '.start-announce', '.start-entries', '.start-entry'].every((sel) => new RegExp(`\\${sel}\\b`).test(startCss)),
);
check('≤900px 两栏堆成一栏', /@media\s*\(max-width:\s*900px\)[\s\S]*?\.start-columns\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/.test(startCss + responsiveCss));
check(
  '起始页有两个常驻入口：用户菜单 + 侧栏（都指向 #/）',
  /menu-item" href="#\/"/.test(session) && /side-link" href="#\/"/.test(session),
);
check(
  '侧栏的动态入口全部改指 #/feed（不再拿 #/ 当动态）',
  /side-link" href="#\/feed"/.test(session) && /side-link" href="#\/feed\?filter=following"/.test(session) && !/#\/\?filter=/.test(session),
  'session.js 里还留着 #/?filter=… 那种老地址',
);

/* ================================================================== */
/* 三·5、顶栏：发动态按钮已删（发布入口改由编辑框和用户菜单承担）        */
/* ================================================================== */

console.log('\n▶ 顶栏与发布入口');

check(
  '顶栏不再有「✏️ 发动态」按钮（注释里提到不算，只认那个 <a>）',
  !/<a[^>]*>\s*✏️\s*发动态\s*<\/a>/.test(indexHtml),
  'index.html 里还留着发动态按钮',
);
check('顶栏的其它东西没动（主题按钮容器 + 用户区 + 挂载点都还在）', /id="theme-area"/.test(indexHtml) && /id="user-area"/.test(indexHtml) && /id="app"/.test(indexHtml) && /id="sidebar"/.test(indexHtml));
check(
  '发布入口改成积木广场：用户菜单里没有了 #/new，改指 #/docs',
  !/href="#\/new"/.test(session) && /menu-item" href="#\/docs">🧩 积木广场/.test(session),
  'session.js 的用户菜单里还留着 #/new，或者没挂上 #/docs',
);
check(
  '老地址 #/new 仍然认：router 把它送去 #/docs，并提示「帖子功能已经下线」',
  /if \(first === 'new'\) \{[\s\S]{0,220}?location\.replace\('#\/docs'\)/.test(routerJs)
    && /帖子功能已经下线/.test(routerJs),
  'router.js 里 #/new 没有被重定向到 #/docs',
);
check('首页顶部仍有编辑框可发帖（feed-composer）', /feed-composer/.test(read('views/timeline.js')));

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
