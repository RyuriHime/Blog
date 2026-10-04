/**
 * 公式归一化：把五花八门的 LaTeX 定界符统一成 markdown 数学写法。
 *
 * 三条硬规则（都来自实测会踩的坑）：
 *   1. **代码优先** —— 代码块与行内代码先换成占位符，里面的 `$` 一律不参与替换。
 *      否则 `print("$")` 会被当成公式开头，整篇文档从这里开始错位。
 *   2. **未配平不动** —— 同一行里 `$` 个数为奇数就认为用户是在写"价格 $5 和 $6"，
 *      整行原样返回。宁可漏转，不可把正文搅烂。
 *   3. **幂等** —— 归一化结果再归一化必须一模一样，否则"实时改写"会反复抖动。
 */
import { BLOCK_TYPES, unwrapFormula } from './blocks.mjs';

/** 显示公式：$$ … $$、\[ … \]、\begin{equation|align|gather|eqnarray}…\end{…} */
const DISPLAY_RE = /^\$\$[\s\S]*\$\$$/;
const BRACKET_RE = /^\\\[[\s\S]*\\\]$/;
const ENV_RE = /^\\begin\{(equation|align|gather|eqnarray)\*?\}[\s\S]*\\end\{\1\*?\}$/;

const ENVIRONMENTS = ['equation', 'align', 'gather', 'eqnarray'];
const PLACEHOLDER_OPEN = '\u0000';
const PLACEHOLDER_CLOSE = '\u0001';

/** 这个块的文本本身就是一条公式吗（用于抽取阶段判定 formula 块）。 */
export function looksLikeFormula(text) {
  const value = String(text ?? '').trim();
  if (value.length === 0) return false;
  return DISPLAY_RE.test(value) || BRACKET_RE.test(value) || ENV_RE.test(value);
}

/**
 * 把代码段换成占位符，返回 [带占位符的文本, 代码段数组]。
 *
 * 逐行状态机而不是整篇正则：整篇正则里的 `(`+)([\s\S]*?)\1` 会用开头三个反引号
 * 去配后面的三个反引号，把围栏之间的内容一起吞掉。
 */
function maskCode(source) {
  const literals = [];
  const stash = (code) => {
    literals.push(code);
    return `${PLACEHOLDER_OPEN}${literals.length - 1}${PLACEHOLDER_CLOSE}`;
  };

  const lines = source.split('\n');
  const out = [];
  let inFence = false;
  let fenceChars = '';

  for (const line of lines) {
    const fenceMatch = /^\s*(`{3,})/.exec(line);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceChars = fenceMatch[1];
        out.push(stash(line));
      } else {
        inFence = false;
        fenceChars = '';
        out.push(stash(line));
      }
      continue;
    }
    if (inFence) {
      out.push(stash(line));
      continue;
    }
    // 行内代码：反引号串（含多重反引号）。这里只处理非围栏行，所以不会和 ``` 打架。
    out.push(line.replace(/(`+)([\s\S]*?)\1/g, (match) => stash(match)));
  }

  return [out.join('\n'), literals];
}

function unmaskCode(text, literals) {
  return text.replace(new RegExp(`${PLACEHOLDER_OPEN}(\\d+)${PLACEHOLDER_CLOSE}`, 'g'), (match, index) => literals[Number(index)] ?? '');
}

/**
 * 文本级替换：\[ … \] / \( … \) / equation 等环境。
 *
 * 先算出"哪些行的 `$` 是配平的"，只对这些行做替换，再把结果切回行。
 * 这样既有整体替换的能力（环境与 \[ \] 常跨行），又不会去碰
 * "价格是 $5 和 $6"这种未配平的行 —— 只对它整行原样返回。
 */
function convertText(text) {
  const lines = String(text ?? '').split('\n');
  const balanced = lines.map((line) => dollarCount(line) % 2 === 0);

  let value = String(text ?? '');
  for (const name of ENVIRONMENTS) {
    const open = `\\\\begin\\{${name}\\*?\\}`;
    const close = `\\\\end\\{${name}\\*?\\}`;
    value = value.replace(new RegExp(`${open}([\\s\\S]*?)${close}`, 'g'), (match, body) => `$$\n${trimEdges(body)}\n$$`);
  }
  value = value.replace(/\\\[([\s\S]*?)\\\]/g, (match, body) => `$$\n${strip(body)}\n$$`);
  value = value.replace(/\\\(([\s\S]*?)\\\)/g, (match, body) => `$${strip(body)}$`);

  const converted = value.split('\n');
  // 行数相同时逐行回退未配平的行；行数变了（说明发生了跨行替换）就整体采用，
  // 因为跨行替换必然由配平的定界符触发。
  if (converted.length === lines.length) {
    return converted.map((line, index) => (balanced[index] ? line : lines[index])).join('\n');
  }
  return value;
}

function strip(body) {
  return String(body ?? '').trim();
}

function trimEdges(body) {
  return String(body ?? '').replace(/^\n+/, '').replace(/\n+$/, '');
}

/** 同一行里 `$` 的个数（此时代码段已经变成占位符，不会数错）。 */
function dollarCount(line) {
  return (line.match(/\$/g) ?? []).length;
}

/**
 * @param {string} text
 * @returns {string}
 */
export function normalizeFormulas(text) {
  const source = String(text ?? '');
  if (source.length === 0) return source;

  const [masked, literals] = maskCode(source);
  const converted = convertText(masked);
  // 这里**不需要**再做一遍逐行 `$` 奇偶检查：配平判定已经在 convertText 里做完，
  // 未配平的行它整行原样退回（且那些行原本就是 $ 个数为偶数的），所以转换结果里
  // 每一行都是配平的。曾经这里写的是 `(dollarCount(line) % 2 === 0 ? line : line)`，
  // 两个分支都返回 line，等于什么都没做、还让人以为这里有兜底。
  return unmaskCode(converted, literals);
}

/**
 * 去掉 formula 块的外层定界符，只留公式本体。
 *
 * 实现放在 `blocks.mjs`（那一层更基础、要被 `blocksToMarkdown` 用到），这里转出，
 * 让"公式相关"的入口继续集中在 formulas.mjs。模型的常见行为是把 `$$…$$` 一起写进
 * op.text；渲染侧如果无条件再包一层就得到 `$$\n$$\n…`，宿主渲染器与 KaTeX 都认不出来。
 */
export { unwrapFormula };

/**
 * 对块数组做公式归一化。**不修改入参对象**，被改动的块返回新对象。
 * @param {Array<object>} blocks
 * @returns {{ blocks: Array<object>, changed: number }}
 */
export function normalizeBlocks(blocks) {
  const list = Array.isArray(blocks) ? blocks : [];
  let changed = 0;
  const out = list.map((block) => {
    if (!block || !BLOCK_TYPES.includes(block.type)) return block;
    if (block.type === 'formula') {
      const text = unwrapFormula(block.text);
      const next = { ...block, text, meta: { ...(block.meta ?? {}), display: true } };
      if (next.text !== String(block.text ?? '') || block.meta?.display !== true) changed += 1;
      return next;
    }
    if (block.type === 'paragraph' || block.type === 'list') {
      const text = normalizeFormulas(block.text);
      if (text === String(block.text ?? '')) return block;
      changed += 1;
      return { ...block, text };
    }
    return block;
  });
  return { blocks: out, changed };
}
