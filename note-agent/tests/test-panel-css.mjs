/**
 * 面板样式表跟着面板走（交付包能脱离论坛单独用的前提）。
 *
 * 背景：面板样式原来只活在宿主的 `public/style.css` 里，接入方要手粘三百行 —— 这是
 * 交付包里最容易漏的一步，漏了面板会以裸 DOM 的样子糊在写作页右侧。现在样式是**单一来源**：
 * `client/notes-panel.css`，挂载层在 `/notes-panel.css` 发出去，面板自己往 head 里认领。
 *
 * 这个文件盯三件事：
 *   1. 挂载层真的发了、面板真的认领了（只生成文件不发，等于没做）；
 *   2. 面板 CSS 不许直接引用宿主主题变量（`var(--panel)` 这种），必须走 `--notes-*`
 *      兜底链 —— 否则拷到一个没有主题变量的站点上会退化成裸 DOM；
 *   3. 面板写出来的每个类名都得有样式（漏一个就是一块没穿衣服的 DOM），
 *      并且宿主 `style.css` 里**不该**再有第二份面板样式 —— 后一组要看宿主，
 *      包被单独拷走时自动跳过（`skip()`），不报红。
 */
import { readFileSync } from 'node:fs';
import { createChecker } from './helpers/check.mjs';
import { buildPanelCss } from '../scripts/sync-panel-css.mjs';

const { check, skip, summary } = createChecker();
const read = (path) => {
  try {
    return readFileSync(new URL(path, import.meta.url), 'utf8');
  } catch {
    return '';
  }
};

const panelCss = read('../client/notes-panel.css');
const hostCss = read('../../public/style.css');
const mount = read('../src/mount.mjs');
const client = read('../client/notes-panel.mjs');

check('client/notes-panel.css 存在且不是空文件', panelCss.length > 4000, `${panelCss.length} 字符`);
check(
  '整理脚本是幂等的（跑第二遍不会改动文件）',
  buildPanelCss(panelCss) === panelCss,
  `${buildPanelCss(panelCss).length} vs ${panelCss.length}`,
);

// 面板 CSS 里引用的主题变量必须全部走兜底链
const bare = [...panelCss.matchAll(/var\(--([a-z0-9-]+)\)/g)]
  .map((m) => m[1])
  .filter((name) => !name.startsWith('notes-'));
check('面板 CSS 不直接引用宿主主题变量（全部走 --notes-* 兜底链）', bare.length === 0, [...new Set(bare)].join('、'));
check(
  '兜底值里每个 --notes-* 都有宿主优先、兜底其次的取值链',
  ['panel', 'text', 'border', 'accent', 'muted'].every((name) =>
    new RegExp(`--notes-${name}: var\\(--${name}[a-z0-9-]*, var\\(--notes-fallback-`).test(panelCss),
  ),
);

// 「用了但没定义」的变量是静默杀手：`var(--notes-bg-soft)` 一旦没定义，浏览器不会报错，
// 整条声明直接作废 —— 属性退回宿主样式或初始值，看起来就像"某个元素颜色不对"。
// 真机上就踩过：`--notes-bg-soft` 从来没定义过，输入框背景一直是透明的。
const usedVars = new Set([...panelCss.matchAll(/var\((--notes-[a-z0-9-]+)/g)].map((m) => m[1]));
const definedVars = new Set([...panelCss.matchAll(/(--notes-[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
const undefinedVars = [...usedVars].filter((name) => !definedVars.has(name));
check(
  '面板用到的 --notes-* 变量全部有定义（没定义的 var() 会让整条声明失效）',
  undefinedVars.length === 0,
  undefinedVars.join('、'),
);
check(
  '每个兜底变量都有对应取值链（有 fallback 值却没有 --notes-xxx: var(...) 就是漏接）',
  [...definedVars]
    .filter((name) => name.startsWith('--notes-fallback-'))
    .map((name) => name.replace('--notes-fallback-', '--notes-'))
    .every((name) => definedVars.has(name)),
  [...definedVars].filter((name) => name.startsWith('--notes-fallback-')).map((n) => n.replace('--notes-fallback-', '--notes-')).filter((n) => !definedVars.has(n)).join('、'),
);
// 软背景是面板里最常用来"垫一层"的颜色（输入框、状态胶囊、材料区）
check(
  '软背景走的是宿主的 --bg-soft（论坛的输入框就是这个底色）',
  /--notes-bg-soft:\s*var\(--bg-soft,\s*var\(--notes-fallback-bg-soft\)\)/.test(panelCss)
    && /--notes-fallback-bg-soft:\s*#[0-9a-f]{3,8}/i.test(panelCss),
);

// 隔离：面板自己的规则必须比宿主"泛化选择器"更具体，否则宿主一条
// `input[type="text"] { padding: 10px 12px }` 就能把面板的输入框改样（真机上就是这样，
// 同一个面板在论坛里 47px 高、在演示页里 40px 高）。
// 做法：面板规则一律收进宿主给的 `.notes-mount`（挂载点是宿主唯一必须提供的钩子）。
const unscoped = panelCss
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => /^\.notes-/.test(line) && line.includes('{'))
  .filter((line) => !line.startsWith('.notes-mount'));
check(
  '面板规则一律收在 .notes-mount 下（否则会被宿主的泛化选择器改样）',
  unscoped.length === 0,
  unscoped.slice(0, 3).join(' | '),
);
// 收作用域那一遍要认真切选择器：`:is(h1, h2)` 里的逗号不是选择器分隔符，
// 拆错就会写出 `.notes-mount :is(h1,` + `.notes-mount h2)` 这种废规则（真发生过）。
check(
  '收作用域没拆坏 :is()/多行选择器（没有 ,, 或半截选择器）',
  panelCss.split('\n').every((line) => !line.includes(',,') && !/^\s*\.notes-mount\s+[a-z0-9-]+\s*[,)]/.test(line)),
);
// 面板的根节点与折叠竖标签是**兄弟**，都直接挂在挂载点下面：
//   <div id="notesMount"> <div class="notes-panel notes-drawer">…</div> <button class="notes-drawer-tab">…</button> </div>
// 所以这两条必须收成子代选择器 `.notes-mount > .notes-x`；收成后代选择器一条都匹配不上。
// 症状极像"面板坏了"：DOM 在、样式表也在，折叠标签却是个裸按钮（真踩过）。
check(
  '根节点与折叠竖标签按挂载点的直接子级收（它们都在挂载点下面、彼此是兄弟）',
  /\.notes-mount\s*>\s*\.notes-panel\s*\{/.test(panelCss)
    && /\.notes-mount\s*>\s*\.notes-panel\.notes-drawer\s*\{/.test(panelCss)
    && /\.notes-mount\s*>\s*\.notes-drawer-tab\s*\{/.test(panelCss)
    && !/\.notes-mount\s+\.notes-drawer-tab\s*\{/.test(panelCss)
    && !/\.notes-mount\s*>\s*\.notes-panel\.notes-drawer-tab\s*\{/.test(panelCss),
    '竖标签写成 .notes-panel.notes-drawer-tab 是收错了：它没有 notes-panel 这个类',
);
check('子块用后代选择器收（根节点之下的每一块）', /\.notes-mount\s+\.notes-drawer-body\s*\{/.test(panelCss) && /\.notes-mount\s+\.notes-turn-input\s*\{/.test(panelCss));

// 挂载层与面板两侧的接线
check('挂载层把面板样式表当静态资源发出去', mount.includes("const STYLE_URL = '/notes-panel.css'") && mount.includes('STYLE_FILE'));
check('挂载层按 text/css 回这两类资源', mount.includes("'text/css; charset=utf-8'") && mount.includes("'text/javascript; charset=utf-8'"));
check('面板自己认领样式表（宿主不必手粘 CSS）', client.includes('ensureStylesheet(stylesheet)') && client.includes("export const STYLESHEET_URL = '/notes-panel.css'"));

// 面板用到的类名必须全在样式表里有定义（漏一个就是一块裸 DOM）
const used = new Set();
for (const m of client.matchAll(/class:\s*'([^']+)'/g)) {
  for (const name of m[1].split(/\s+/)) if (name.startsWith('notes-')) used.add(name);
}
// 还有一类是渲染后才挂上去的：`classList.toggle('is-rolled')` 这种
for (const m of client.matchAll(/classList\.(?:add|toggle|remove)\('([^']+)'/g)) {
  if (m[1].startsWith('notes-')) used.add(m[1]);
}
const missing = [...used].filter((name) => !panelCss.includes(`.${name}`));
check('面板写出的类名在样式表里都有定义', missing.length === 0, missing.join('、'));

// 可移植性：面板在**没有主题变量**的站点上也得好用。
// 这一组是静态的、永远能跑的静态断言（真机验证在手机视口那一轮）：
//   · 面板自己引用 `var(--x, —)` 时 x 必须**不是** `--notes-*`（那是宿主主题变量），
//     而且必须给兜底第二参 —— 否则拷到一个干净站点上颜色整条作废；
//   · 面板不许定义 `--notes-*` 之外的主题变量（那会污染宿主页面）。
const fallbackless = [...panelCss.matchAll(/var\(\s*(--[a-z0-9-]+)\s*(,)?/g)]
  .filter((m) => !m[1].startsWith('--notes-'))
  .filter((m) => !m[2])
  .map((m) => m[1]);
check('面板引用宿主主题变量时一律带兜底值（干净站点上也认得出颜色）', fallbackless.length === 0, [...new Set(fallbackless)].join('、'));
// 收作用域那一步会补兜底链；顺手钉住"兜底值一个都不能少"。
const fallbackDefs = new Set([...panelCss.matchAll(/--notes-fallback-([a-z0-9-]+)\s*:/g)].map((m) => m[1]));
const needsFallback = new Set(
  [...panelCss.matchAll(/--notes-([a-z0-9-]+):\s*var\(--([a-z0-9-]+),\s*var\(--notes-fallback-/g)].map((m) => m[1]),
);
const missingFallback = [...needsFallback].filter((name) => !fallbackDefs.has(name));
check('每个接了宿主变量的 --notes-* 都有真正的兜底值', missingFallback.length === 0, missingFallback.join('、'));

// 手机端：这一组盯的是"拇指能不能用"，静态可测的部分全部钉在这里。
// 真机（390×844 / 320×720）已经量过：抽屉本身不溢出、不报错，但收起入口与
// 一堆小按钮只有 21~26px 高，拇指难点 —— 这是这一轮要修的。
const phones = [...panelCss.matchAll(/@media\s*\(max-width:\s*(\d+)px\)\s*\{/g)].map((m) => Number(m[1]));
const phoneStart = panelCss.search(/@media\s*\(max-width:\s*480px\)\s*\{/);
check('面板为手机单独列了一组断点（≤480px，不动平板那组 760px 的布局）', phoneStart >= 0 && phones.some((w) => w <= 480), phones.join('、'));
const phoneBlock = phoneStart < 0 ? '' : panelCss.slice(phoneStart, phoneStart + 2600);
check(
  '手机断点里抽屉铺满视口（100dvw / 100dvh，不靠 420px 定宽）',
  /100dvw/.test(phoneBlock) && /100dvh/.test(phoneBlock),
);
check(
  '手机断点里给刘海屏留了安全区（safe-area-inset，不支持的浏览器退 0）',
  /env\(safe-area-inset-(top|bottom|left|right)\s*,\s*0px\)/.test(phoneBlock),
);
check(
  '手机断点里交互元素撑到拇指够得着（≥44px，收起按钮/预览小按钮/输入框）',
  /min-height:\s*44px/.test(phoneBlock)
    && /touch-action:\s*manipulation/.test(phoneBlock),
  '44 = 常用触控下限：手机上点不中是最常见的"看着没问题其实不能用"',
);
check(
  '手机断点里抽屉正文不把滚动传给宿主页面（overscroll-behavior: contain）',
  /overscroll-behavior:\s*contain/.test(phoneBlock),
);
// 真机量到（390×844，抽屉开着）：只有图标、没有文字的按钮**高度够宽不够** ——
// 收起按钮 26×44、预览刷新 29×44。高度那条断言看不出这件事，因为它们本来就有行高。
// 拇指要的是"面积"，所以只写 min-height 是漏的，必须同时钉住 min-width。
check(
  '手机断点里只有图标的按钮宽度也够（≥44px，不能只有 min-height）',
  /min-width:\s*44px/.test(phoneBlock),
  '真机实测：收起按钮 26 宽、预览刷新 29 宽 —— 高度 44 掩盖了它们点不中',
);
// 真机量到（390×844）：抽屉收起时文档 scrollWidth 489 > 视口 390，能往左滑出 99px。
// **但元凶不是面板**：把 `.notes-mount` 整块 remove 之后仍然是 489 —— 那是宿主论坛
// 顶栏 `.topnav`(306) + `#user-area`(173) 在 nowrap 的 flex 行里撑出去的（宿主自己的
// 移动端问题，不在这个包的职责内，所以本文件不写"面板去给它止血"的断言）。
// 面板能保证、也该钉住的是自己这边：抽屉永远不超出视口。
check(
  '手机断点里抽屉不超出视口（100dvw 之外还给一条 max-width 兜底）',
  /width:\s*100dvw/.test(phoneBlock) && /max-width:\s*100%/.test(phoneBlock),
  '面板自己不溢出（真机已量），宿主顶栏那 99px 是另一件事',
);
// 提需求输入框在窄屏会跟着 `.notes-turn-row` 折成竖排，而它原本写的是
// `flex: 1 1 240px` —— 竖排时 flex-basis 量的是**高度**，输入框当场变成 240px 高，
// 把抽屉底栏顶到 459px、对话与审查卡全被挤出屏幕（真机上就这么翻过车）。
// 所以：flex-basis 必须是 auto，并且给一个上界。
check(
  '提需求输入框不会因为窄屏折成竖排而被拉高（flex-basis 不能是像素值）',
  /\.notes-mount \.notes-turn-input\{[^}]*flex:\s*1 1 auto/.test(panelCss)
    && /\.notes-mount \.notes-turn-input\{[^}]*max-height:\s*\d+px/.test(panelCss),
  '写成 `flex: 1 1 240px` 时，窄屏竖排会把 240px 当高度用',
);

// 单一来源：宿主样式表里不该再有第二份面板样式（两份拷贝必然腐烂）。
// 唯一的例外是 `.notes-mount` —— 那个空容器是**宿主自己的标记**，面板没加载时它也在，
// 所以宿主可以（也应该）给它一条布局定义。除此之外一个 `.notes-*` 都不许有。
//
// 这一组断言看的是**宿主**的样式表与标记；包被单独拷走时没有宿主可看，跳过而不是报红。
const hasHost = hostCss.length > 0 && read('../../public/index.html').length > 0;
if (!hasHost) {
  skip('宿主 style.css 里没有第二份面板样式（单一来源，只允许挂载点那一条）', '单独拷走的包，旁边没有宿主');
  skip('宿主为挂载点留了一条定义（否则写作页上那个空容器没有归属）', '同上');
  skip('面板样式只由 note-agent 提供（宿主没有引用别的 notes CSS）', '同上');
} else {
  const HOST_MAY_DEFINE = new Set(['notes-mount']);
  const hostPanelRules = [...hostCss.matchAll(/\.notes-[a-z0-9-]+/g)]
    .map((m) => m[0].slice(1))
    .filter((name) => !HOST_MAY_DEFINE.has(name));
  check(
    '宿主 style.css 里没有第二份面板样式（单一来源，只允许挂载点那一条）',
    hostPanelRules.length === 0,
    [...new Set(hostPanelRules)].join('、'),
  );
  check(
    '宿主为挂载点留了一条定义（否则写作页上那个空容器没有归属）',
    /\.notes-mount\s*\{/.test(hostCss),
  );
  check('面板样式只由 note-agent 提供（宿主没有引用别的 notes CSS）', !read('../../public/index.html').includes('notes-panel.css'));
}

summary();
