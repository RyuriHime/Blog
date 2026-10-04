/**
 * 面板样式表的整理器（幂等）：
 *
 *   node note-agent/scripts/sync-panel-css.mjs
 *
 * 它会重写 `client/notes-panel.css`：把文件正文里已有的规则原样留下，只重新生成
 * 顶部的横幅与 `--notes-*` 兜底块 —— 于是这份文件可以放心地被"人"编辑，
 * 再跑一次不会把你写的东西抹掉，只是把兜底链补齐。
 *
 * ⚠️ 这里**不再从 `public/style.css` 抄**。样式表是单一来源：面板样式只活在
 * `client/notes-panel.css`，由挂载层在 `/notes-panel.css` 发出去，面板自己认领。
 * 宿主 `public/style.css` 里那份已经删掉 —— 两份拷贝是交付包里最容易腐烂的东西。
 *
 * 零依赖：只用 node:fs / node:path / node:url。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_CSS = join(HERE, '..', 'client', 'notes-panel.css');

const BANNER = `/* ------------------------------------------------------------------ */
/* AI 笔记整理面板样式（note-agent/client/notes-panel.css）             */
/* ------------------------------------------------------------------ */
/* 这份文件是面板样式的**唯一来源**：由 note-agent 的挂载层在           */
/* /notes-panel.css 发出去，面板自己往 head 里认领。宿主不需要把这几百   */
/* 行粘进自己的样式表 —— 交付包里最容易漏的就是这一步。                 */
/*                                                                      */
/* 颜色一律走宿主主题变量，取不到时退回下面这组 --notes-* 兜底值：       */
/* 放到一个完全没有主题变量的站点上也只是"朴素"，不会变成白底黑字的裸块。*/
/*                                                                      */
/* 规则一律收在 .notes-mount 下（宿主只管给一个空容器，别的一概不假设），  */
/* 否则宿主一条 input[type="text"] 规则就能把面板的输入框改样。           */
/*                                                                      */
/* 改完样式跑 node note-agent/scripts/sync-panel-css.mjs 整理兜底块；    */
/* tests/test-panel-css.mjs 会核对类名齐不齐、有没有直接引用宿主变量。   */`;

/** 宿主主题变量取不到时的兜底值（深色，与论坛的 midnight 主题同调）。 */
const FALLBACK = `:root {
  --notes-fallback-bg: #0f1117;
  --notes-fallback-bg-soft: #111725;
  --notes-fallback-panel: #151823;
  --notes-fallback-panel-2: #1b1f2c;
  --notes-fallback-border: #262b3a;
  --notes-fallback-border-soft: #1f2432;
  --notes-fallback-text: #e6e9f2;
  --notes-fallback-text-dim: #a9b0c4;
  --notes-fallback-muted: #7d849b;
  --notes-fallback-accent: #6d8bff;
  --notes-fallback-accent-2: #8f6dff;
  --notes-fallback-accent-soft: rgba(109, 139, 255, 0.14);
  --notes-fallback-success: #4ec9a0;
  --notes-fallback-warn: #e0b060;
  --notes-fallback-danger: #ef6b6b;
  --notes-fallback-radius: 12px;
  --notes-fallback-radius-sm: 8px;
  --notes-fallback-shadow: 0 18px 40px rgba(0, 0, 0, 0.45);
  --notes-fallback-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --notes-bg: var(--bg, var(--notes-fallback-bg));
  --notes-bg-soft: var(--bg-soft, var(--notes-fallback-bg-soft));
  --notes-panel: var(--panel, var(--notes-fallback-panel));
  --notes-panel-2: var(--panel-2, var(--notes-fallback-panel-2));
  --notes-border: var(--border, var(--notes-fallback-border));
  --notes-border-soft: var(--border-soft, var(--notes-fallback-border-soft));
  --notes-text: var(--text, var(--notes-fallback-text));
  --notes-text-dim: var(--text-dim, var(--notes-fallback-text-dim));
  --notes-muted: var(--muted, var(--notes-fallback-muted));
  --notes-accent: var(--accent, var(--notes-fallback-accent));
  --notes-accent-2: var(--accent-2, var(--notes-fallback-accent-2));
  --notes-accent-soft: var(--accent-soft, var(--notes-fallback-accent-soft));
  --notes-success: var(--success, var(--notes-fallback-success));
  --notes-warn: var(--warn, var(--notes-fallback-warn));
  --notes-danger: var(--danger, var(--notes-fallback-danger));
  --notes-radius: var(--radius, var(--notes-fallback-radius));
  --notes-radius-sm: var(--radius-sm, var(--notes-fallback-radius-sm));
  --notes-shadow: var(--shadow, var(--notes-fallback-shadow));
  --notes-mono: var(--mono, var(--notes-fallback-mono));
}`;

/** 剥掉旧横幅与旧兜底块，留下纯规则正文。 */
export function stripDecorations(css) {
  const rootEnd = css.indexOf('}');
  const body = rootEnd >= 0 && css.includes('--notes-fallback-bg') ? css.slice(rootEnd + 1) : css;
  // 头部的注释块（含旧横幅）全部丢掉：横幅由 BANNER 重新生成
  return body.replace(/^(?:\s*\/\*[\s\S]*?\*\/\s*)+/, '').trim();
}

/**
 * 找出选择器后面那个 `{` —— 跳过引号、括号与注释，免得把
 * `[data-x="{"]` 或 `@media (min-width: 1081px)` 里的字符当成块的开头。
 */
function findOpenBrace(css, from) {
  let quote = '';
  let depth = 0;
  for (let i = from; i < css.length; i += 1) {
    const ch = css[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end < 0 ? css.length : end + 1;
    } else if (ch === '{' && depth === 0) return i;
    else if (ch === '}' && depth === 0) return -1;
  }
  return -1;
}

/** 从 `start`（指向 `{`）取出整块，返回 `[块内容, 块之后的下标]`。 */
function takeBlock(css, start) {
  let depth = 0;
  for (let i = start; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return [css.slice(start + 1, i), i + 1];
    }
  }
  return [css.slice(start + 1), css.length];
}

/** 按顶层逗号拆分选择器 —— `:is(h1, h2)` 里的逗号不算分隔符。 */
function splitTopLevel(selector) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of selector) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

/**
 * 面板自己那几块**在根节点上或与根节点并列**：
 *
 *   <div id="notesMount" class="notes-mount">   ← 宿主给的挂载点
 *     <div class="notes-panel notes-drawer is-open">…</div>
 *     <button class="notes-drawer-tab">…</button>   ← 是根节点的兄弟
 *   </div>
 *
 * 所以这两个类名必须收成 `.notes-mount > .notes-x` 这种**子代**选择器，
 * 收成后代选择器 `.notes-mount .notes-drawer-tab` 会一条都匹配不上 —— 真踩过：
 * 样式表在、DOM 也在，折叠竖标签就是一个样式都没生效，看着像面板坏了。
 */
const DIRECT_CHILD_OF_MOUNT = ['notes-panel', 'notes-drawer', 'notes-drawer-tab'];

/** 已经收好的选择器前缀，无论是哪一版留下的，重新收之前都先剥掉（保证幂等）。 */
const SCOPED_PREFIX = /^\.notes-(?:mount|panel)\s+/;

/**
 * 把一条选择器收进面板自己的作用域（幂等：已经收好的片段剥掉再收一遍）。
 *
 * 四种情况分开处理，写错了都会"静默失效"：
 *  1. 光秃秃的 `.notes-panel` —— 根节点自己，收成 `.notes-mount > .notes-panel`；
 *  2. `.notes-panel …`（面板自己写的作用域）—— 换成 `.notes-mount …`；
 *  3. 根节点与折叠竖标签（`.notes-drawer` / `.notes-drawer-tab`）—— 收成
 *     `.notes-mount > .notes-x`，它们是挂载点的直接子级、彼此是兄弟；
 *  4. 宿主布局规则（`body.notes-drawer-open …`）原样留着（它本来就在改宿主元素），
 *     其余子块收成后代选择器 `.notes-mount .notes-x`。
 *
 * 为什么锚在宿主给的 `.notes-mount`：折叠竖标签与根节点是兄弟，任何以 `.notes-panel`
 * 开头的写法都收不住它 —— 收不住就等于那一条规则从来没生效过。
 */
function scopeSelector(selector) {
  const indent = (/^([^\S\n]*)/.exec(selector) ?? ['', ''])[1];
  const parts = splitTopLevel(selector.replace(/\s*\n\s*/g, ', '))
    .map((part) => part.trim().replace(/,$/, '').trim())
    .filter(Boolean)
    .map((part) => {
      if (part.startsWith('body.')) return part;
      // 已经收好的片段先剥回原始形态，保证"再跑一遍"结果一致
      let restored = part.replace(SCOPED_PREFIX, '');
      // 根节点自己：`.notes-panel`（或已收成 `.notes-mount > .notes-panel`）
      if (restored === '.notes-panel' || /^\.notes-panel\.notes-drawer/.test(restored)) {
        return `.notes-mount > ${restored}`;
      }
      if (restored === '.notes-drawer' || restored === '.notes-drawer-tab') {
        return `.notes-mount > ${restored}`;
      }
      // `.notes-panel .notes-x` —— 换成挂载点作用域；已经被换过的原样留着
      if (restored.startsWith('.notes-panel')) return `.notes-mount${restored.slice('.notes-panel'.length)}`;
      if (restored.startsWith('.notes-mount ')) return restored;
      const first = /^\.([a-z0-9-]+)/.exec(restored);
      if (first && DIRECT_CHILD_OF_MOUNT.includes(first[1])) return `.notes-mount > ${restored}`;
      return `.notes-mount ${restored}`;
    });
  // 多行选择器：逗号吊在行尾，后续片段与第一条同样缩进 —— 这样"再切一次"得到的
  // 片段与上一轮逐字节相同（幂等），也不会在片段之间漏掉逗号。
  return parts.map((part, i) => (i === parts.length - 1 ? part : `${part},`)).join(`\n${indent}`);
}

/**
 * 把一条选择器还原成 `.notes-panel xxx,` 逐条一行的规范形态（幂等）。
 *
 * 只保留行首缩进 —— 这样"再跑一遍"重新切分出来的各个片段也带着同样多的空白，
 * 结果逐字节相同。**别在这里用 `\s`**：那样会把上一轮的缩进当成新片段的前导空白，
 * 每跑一次就多出一层缩进。
 */
function normalizeScoped(selector) {
  const indent = (/^([^\S\n]*)/.exec(selector) ?? ['', ''])[1];
  return `${indent}${scopeSelector(selector).trim()}`;
}

/**
 * 把面板规则统一收进宿主给的 `.notes-mount`（幂等）。
 *
 * 为什么非要收：面板只能假设"宿主给了我一个空容器"，别的什么都不能假设。
 * 论坛 `public/style.css` 里那条
 *   `input[type="text"], … { padding: 10px 12px; … }`
 * 的优先级是 (0,1,1)，比面板自己的 `.notes-turn-input` (0,1,0) 还高 ——
 * 于是同一个面板在论坛里输入框 47px 高、在演示页里 40px 高。加一层
 * `.notes-mount` 前缀把面板规则的优先级抬到宿主泛化选择器之上，面板在哪都长一样。
 *
 * 锚在 `.notes-mount`（而不是面板自己的 `.notes-panel`）是因为折叠竖标签是根节点的
 * **兄弟**，`.notes-panel` 前缀收不住它 —— 收不住就等于那一条规则从来没生效过。
 */
export function scopePanelRules(css) {
  let out = '';
  let i = 0;
  while (i < css.length) {
    const ch = css[i];
    if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      const stop = end < 0 ? css.length : end + 2;
      out += css.slice(i, stop);
      i = stop;
      continue;
    }
    if (/\s/.test(ch)) {
      out += ch;
      i += 1;
      continue;
    }
    const brace = findOpenBrace(css, i);
    if (brace < 0) {
      out += css.slice(i);
      break;
    }
    const raw = css.slice(i, brace);
    const selector = raw.trim();
    const [block, next] = takeBlock(css, brace);
    if (selector.startsWith('@')) {
      // @media 里可能还套着规则；@keyframes 的 0%/100% 不是选择器，原样留着
      const inner = selector.startsWith('@media') ? scopePanelRules(block) : block;
      out += `${raw}{${inner}}`;
    } else {
      out += `${normalizeScoped(selector)}{${block}}`;
    }
    i = next;
  }
  return out;
}

/** 生成 client/notes-panel.css 的完整内容（幂等：正文原样保留）。 */
export function buildPanelCss(current) {
  const body = current.includes('--notes-fallback-bg') ? stripDecorations(current) : current.trim();
  return `${BANNER}\n\n${FALLBACK}\n\n${scopePanelRules(body)}\n`;
}

/** 把已整理过的版本再整理一遍必须是**逐字节**相同，否则每次 sync 都会改文件。 */

function main() {
  const current = readFileSync(PANEL_CSS, 'utf8');
  const next = buildPanelCss(current);
  if (next === current) {
    console.log('notes-panel.css 已经是最新形态');
    return;
  }
  writeFileSync(PANEL_CSS, next, 'utf8');
  console.log(`已整理 ${PANEL_CSS}（${next.length} 字符）`);
}

if (process.argv[1] && join(process.argv[1]) === fileURLToPath(import.meta.url)) main();

