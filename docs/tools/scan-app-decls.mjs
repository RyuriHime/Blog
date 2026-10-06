/**
 * 一次性扫描器：找出 JS 源码里每个「顶层块」的起止行。
 *
 * 为什么需要它：public/app.js 有 4254 行，要按「谁拥有什么」拆成 24 个文件，
 * 而切分必须**逐字节正确**。靠肉眼划行号会错，靠数括号也会错 —— 这个文件里
 * 到处是模板字符串（`${x}` 里还有 `{}`）、正则字面量（`/[&<>"']/g`）、
 * 嵌套模板字符串（`'…' : \`<span>…</span>\``）。任何一种朴素做法都会把块切歪，
 * 切歪的症状是生成的文件在语法错的位置报 `Unexpected token`。
 *
 * 所以这里做一个真正的**逐字符状态机**：把注释 / 字符串 / 模板字符串（含嵌套的
 * `${}` 插值）/ 正则字面量全部「掩码」成空格，只在真实代码上数括号。
 *
 * 掩码里最容易踩的坑（都真的踩过，别改回去）：
 *   1) `/` 是正则还是除号，只看它前面那个字符 —— 用「本行出现过运算符就按正则」的模糊
 *      判断，会把 `.join('')`、`.replace(/…/g, '')` 里 `)` 之后的除号当成正则起头，
 *      一路吞到行尾，括号深度再也回不到零（viewUser 的跨度会停在 1054 而不是 1073）。
 *   2) 模板字符串里的 `${` 要压栈：插值内部还可能再嵌模板字符串。只用一个
 *      `templateDepth` 计数器，遇到最外层 `${…}` 的收尾 `}` 会误判成「回到模板模式」，
 *      而模板字面量的收尾反引号就再也认不出来，后面的 `}` 全被当字符串吃掉。
 *
 * 用法：node docs/tools/scan-app-decls.mjs [文件]
 */
import { readFileSync } from 'node:fs';

const OPENERS = '({[';
const CLOSERS = ')}]';
const REGEX_AFTER_CHAR = '(,=:[!&|?{};+-*%<>~^';
const REGEX_AFTER_WORD = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'case', 'delete', 'void', 'new', 'do', 'else', 'yield', 'await',
]);

/**
 * 把一行里的非代码字符替换成空格。返回掩码后的行。
 *
 * @param {string} line
 * @param {{ mode: ('code'|'template'|'regex-class'|'line-comment'|'block-comment')[], quote: (string|null), escape: boolean, braceDepth: number[], prevChar: string, prevWord: string }} state
 */
function maskLine(line, state) {
  let out = '';
  for (let at = 0; at < line.length; at += 1) {
    const char = line[at];
    const next = line[at + 1];
    const mode = state.mode[state.mode.length - 1];

    // ── 块注释 ──────────────────────────────────────────────────────────
    if (mode === 'block-comment') {
      if (char === '*' && next === '/') {
        state.mode.pop();
        out += '  ';
        at += 1;
      } else out += ' ';
      continue;
    }

    // ── 模板字符串 ──────────────────────────────────────────────────────
    if (mode === 'template') {
      if (state.escape) {
        state.escape = false;
        out += ' ';
        continue;
      }
      if (char === '\\') {
        state.escape = true;
        out += ' ';
        continue;
      }
      if (char === '`') {
        state.mode.pop();
        out += ' ';
        continue;
      }
      if (char === '$' && next === '{') {
        // 进入插值：切回代码模式，并给这次插值记一个自己的「代码括号深度」。
        state.mode.push('code');
        state.braceDepth.push(0);
        out += '  ';
        at += 1;
        continue;
      }
      out += ' ';
      continue;
    }

    // ── 单/双引号字符串 ────────────────────────────────────────────────
    if (mode === 'string') {
      if (state.escape) {
        state.escape = false;
        out += ' ';
        continue;
      }
      if (char === '\\') {
        state.escape = true;
        out += ' ';
        continue;
      }
      if (char === state.quote) {
        state.mode.pop();
        state.quote = null;
      }
      out += ' ';
      continue;
    }

    // ── 代码模式（含插值内部的代码） ────────────────────────────────────
    if (char === '/' && next === '/') break; // 行注释：本行后续全丢掉
    if (char === '/' && next === '*') {
      state.mode.push('block-comment');
      out += '  ';
      at += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      state.mode.push('string');
      state.quote = char;
      out += ' ';
      continue;
    }
    if (char === '`') {
      state.mode.push('template');
      state.escape = false;
      out += ' ';
      continue;
    }

    if (char === '/') {
      // 正则字面量 vs 除号：只看 `/` 前面那个字符（ECMAScript 的实际规则就是这样）。
      const isRegex =
        state.prevChar === '' ||
        REGEX_AFTER_CHAR.includes(state.prevChar) ||
        (state.prevWord !== '' && REGEX_AFTER_WORD.has(state.prevWord));
      if (isRegex) {
        let inClass = false;
        out += ' ';
        at += 1;
        for (; at < line.length; at += 1) {
          const rc = line[at];
          if (rc === '\\') {
            out += '  ';
            at += 1;
            continue;
          }
          if (rc === '[') inClass = true;
          else if (rc === ']') inClass = false;
          else if (rc === '/' && !inClass) break;
          out += ' ';
        }
        if (at < line.length) out += ' ';
        state.prevChar = '/';
        state.prevWord = '';
        continue;
      }
    }

    // 插值里的括号深度：归零就说明这次 `${...}` 结束了，切回模板字符串。
    if (state.braceDepth.length && (OPENERS.includes(char) || CLOSERS.includes(char))) {
      state.braceDepth[state.braceDepth.length - 1] += OPENERS.includes(char) ? 1 : -1;
      if (state.braceDepth[state.braceDepth.length - 1] <= 0 && char === '}') {
        state.braceDepth.pop();
        state.mode.pop(); // 回到 template
        out += ' ';
        state.prevChar = char;
        state.prevWord = '';
        continue;
      }
    }

    out += char;
    if (char.trim()) {
      state.prevChar = char;
      if (/[A-Za-z0-9_$]/.test(char)) state.prevWord += char;
      else state.prevWord = '';
    }
  }
  return out;
}

/** 返回掩码后的整个文件（按行）。 */
export function maskSource(source) {
  const state = { mode: ['code'], quote: null, escape: false, braceDepth: [], prevChar: '', prevWord: '' };
  return source.split('\n').map((line) => maskLine(line, state));
}

const DECL = /^(?:export\s+)?(?:async\s+function|function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/;

/** 顶层「匿名语句」的识别（这些也是 app.js 的一块，搬家时必须整体带走）。 */
// ⚠️ 这些模式跑在**掩码后**的行上，所以字符串字面量已经变成空格：
// `document.addEventListener('click', …)` 实际长这样 → `document.addEventListener(       , …)`。
// 因此事件名不能靠引号匹配（掩码里没有引号），只能用 `[^,]*` 吃到第一个逗号。
const ANON = [
  [/^document\.addEventListener\(\s*(\w+)/, (match) => `document.${match[1]}`],
  [/^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.addEventListener\(/, (match) => `${match[1]}.on`],
  [/^([A-Za-z_$][\w$]*)\(\)\s*;?$/, (match) => `${match[1]}()`],
];

function anonLabel(maskedLine) {
  for (const [pattern, label] of ANON) {
    const match = pattern.exec(maskedLine);
    if (match) return label(match);
  }
  return null;
}

/**
 * 顶格的裸调用语句（`bootstrap();`、`document.addEventListener(…);`）——
 * 必须先于 DECL 判断，见 findBlocks 里的注释。允许一个属性前缀。
 */
const BARE_CALL = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\(/;

/**
 * 找出所有顶层「块」：具名声明 + 顶层匿名语句（事件监听、启动调用）。
 *
 * 为什么必须连匿名语句一起找：搬家时「正文 = 到下一个顶层块为止」，
 * 如果漏掉 `document.addEventListener('click', ...)`（app.js 里约 470 行），
 * 前一个声明的正文就会把它一起卷走 —— 实测 public/core/api.js 因此从 59 行涨到 540 行。
 *
 * @returns {{ name: (string|null), label: string, start: number, end: number }[]}
 */
export function findBlocks(source) {
  const lines = source.split('\n');
  const masked = maskSource(source);
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    // ⚠️ 顺序不能反：`bootstrap();` 这一行同时满足「顶格标识符后跟括号」和
    // DECL 里 `var` 那个分支（`bootstrap` 后面正好是括号），先跑 DECL 就会把
    // 「调用」记成一个名叫 bootstrap 的声明，于是真正的 `function bootstrap` 和它
    // 撞名、后者覆盖前者，`bootstrap();` 那行就永远没人认领。
    const anonymous = BARE_CALL.test(masked[index]) ? anonLabel(masked[index]) : null;
    const match = anonymous ? null : DECL.exec(lines[index]);
    if (!match && !anonymous) continue;
    let depth = 0;
    let opened = false;
    let end = index;
    for (let cursor = index; cursor < lines.length; cursor += 1) {
      // 下一行如果是顶格声明，说明上一句已经结束（不能只看 `;`：
      // `const emptyHtml = (…) =>` 这种合法写法本身不带分号）。
      if (cursor > index && DECL.test(lines[cursor])) break;
      const maskedLine = masked[cursor] ?? '';
      for (const char of maskedLine) {
        if (OPENERS.includes(char)) {
          depth += 1;
          opened = true;
        } else if (CLOSERS.includes(char)) depth -= 1;
      }
      end = cursor;
      if ((!opened || depth <= 0) && /[;}]$/.test(maskedLine.trimEnd())) break;
      // 文件最后一行也兜底（掩码里可能把收尾的 `;` 吃掉）。
      if (cursor === lines.length - 1) break;
    }
    blocks.push({ name: match ? match[1] : null, label: match ? match[1] : anonymous, start: index, end });
    index = end;
  }
  return blocks;
}

/**
 * 找出所有顶层声明的名字与起止行（0-based，含）。
 * @returns {{ name: string, start: number, end: number }[]}
 */
export function findDecls(source) {
  return findBlocks(source)
    .filter((block) => block.name)
    .map((block) => ({ name: block.name, start: block.start, end: block.end }));
}

// 直接运行时打印清单，便于人工核对。
if (process.argv[1] && /scan-app-decls\.mjs$/.test(process.argv[1].split('\\').join('/'))) {
  const file = process.argv[2] ?? 'public/app.js';
  const source = readFileSync(file, 'utf8');
  const lines = source.split('\n');
  const blocks = findBlocks(source);
  console.log(`${file}：${blocks.length} 个顶层块（其中匿名 ${blocks.filter((b) => !b.name).length} 个）`);
  for (const block of blocks) {
    const tail = lines[block.end].trim();
    const label = block.name ?? `@${block.label}`;
    console.log(`  ${label.padEnd(26)} ${String(block.start + 1).padStart(5)}-${String(block.end + 1).padStart(5)}  ${tail.slice(0, 44)}`);
  }
}
