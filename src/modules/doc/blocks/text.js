// 块引擎的文本工具：转义、围栏、公式定界符、表格。
//
// 全是纯函数，不碰数据库、不碰 HTTP —— 这样块引擎可以脱离服务器单测。

/** HTML 转义。块的内容全部来自用户，**任何**输出到 HTML 的地方都要先过这里。 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 换行 → `<br>`（先转义再换，顺序不能反）。 */
export function escapeHtmlMultiline(value) {
  return escapeHtml(value).replace(/\n/g, '<br>');
}

/**
 * 行内双链：`[[目标]]`、`[[目标|显示字]]`。
 *
 * 与 `markdown.js` 的 `WIKI` 不同：那条只认**独占一行**的双链（会被解析成 `wiki` 块），
 * 这条认的是**段落正文里夹着**的双链（`下一站：[[某页]]。`）—— 它不该把段落拆开，
 * 但也不能就这么原样显示成 `[[某页]]`，用户会以为双链坏了。
 */
const WIKI_TOKEN = /\[\[([^[\]|]+)(?:\|([^[\]]*))?\]\]/g;

/**
 * 转义 + 把行内双链变成真链接（**一次扫完，不要先转义再替换**）。
 *
 * 顺序不能反：先 `escapeHtml` 的话，标题里的 `&` 会变成 `&amp;`，
 * 再 `encodeURIComponent` 就编成 `%26amp%3B`，链接直接指到不存在的页。
 * 所以这里对**原文**切片：链接之外的片段照常转义，链接的目标与显示字各自转义。
 */
export function escapeHtmlWithWikiLinks(value, { multiline = false } = {}) {
  const raw = String(value ?? '');
  const plain = (chunk) => {
    const text = escapeHtml(chunk);
    return multiline ? text.replace(/\n/g, '<br>') : text;
  };
  let out = '';
  let last = 0;
  for (const match of raw.matchAll(WIKI_TOKEN)) {
    const name = String(match[1] ?? '').trim();
    out += plain(raw.slice(last, match.index));
    if (name === '') {
      out += plain(match[0]);
    } else {
      const text = String(match[2] ?? '').trim() || name;
      out +=
        `<a class="doc-wiki-link" data-wiki="${escapeHtml(name)}"` +
        ` href="#/wiki/${encodeURIComponent(name)}">${escapeHtml(text)}</a>`;
    }
    last = match.index + match[0].length;
  }
  return out + plain(raw.slice(last));
}

/**
 * 选一个不会和正文打架的围栏。
 *
 * note-agent 永远只用三个反引号 —— 正文里带 ``` 的代码块会被它切坏。
 * 这里取「正文里没出现过的最短围栏」，至少三个：
 * 三个反引号在所有 note-agent 能正确处理的输入上行为完全一致，
 * 只在它本来就处理错的输入上更正确。
 */
export function fenceFor(text) {
  const body = String(text ?? '');
  let ticks = 3;
  while (body.includes('`'.repeat(ticks))) ticks += 1;
  return '`'.repeat(ticks);
}

/** 块级公式的定界形式：$$…$$、\[…\]、$…$。 */
const DISPLAY_WRAPPERS = [
  { open: '$$', close: '$$' },
  { open: '\\[', close: '\\]' },
  { open: '$', close: '$' },
];
const FORMULA_ENVIRONMENTS = ['equation', 'align', 'gather', 'eqnarray'];

/**
 * 去掉 formula 块的外层定界符，只留公式本体。**与 note-agent 的同名函数逐字一致。**
 *
 * 为什么必须有它：模型从材料里看到 `$$\n…\n$$`（或 `\[…\]`、equation 环境）之后，
 * 经常把定界符**一起**写进 text；渲染侧若无条件再包一层，就得到 `$$\n$$\n…`，
 * 宿主与 KaTeX 都认不出来。
 */
export function unwrapFormula(text) {
  const value = String(text ?? '').trim();
  for (const { open, close } of DISPLAY_WRAPPERS) {
    if (value.length >= open.length + close.length && value.startsWith(open) && value.endsWith(close)) {
      return value.slice(open.length, value.length - close.length).trim();
    }
  }
  for (const name of FORMULA_ENVIRONMENTS) {
    const match = new RegExp(`^\\\\begin\\{${name}\\*?\\}([\\s\\S]*?)\\\\end\\{${name}\\*?\\}$`).exec(value);
    if (match) return match[1].trim();
  }
  return value;
}

/** 是不是 markdown 表格的分隔行（`| --- | :--: |`）。 */
export function isSeparatorRow(row) {
  if (!Array.isArray(row) || row.length === 0) return false;
  return row.every((cell) => /^\s*:?-{2,}:?\s*$/.test(String(cell ?? '')));
}

/** 单元格里的竖线要转义，否则表格列会对不上（note-agent 没做这一步）。 */
export function escapeCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|');
}

/** 按「没被反斜杠转义的竖线」切开一行表格。 */
export function splitRow(line) {
  const cells = [];
  let current = '';
  let escaped = false;
  for (const character of String(line ?? '')) {
    if (escaped) {
      current += character === '|' ? '|' : `\\${character}`;
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '|') {
      cells.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  cells.push(current);
  // 行首行尾各有一个竖线，切出来首尾是空串，丢掉。
  if (cells.length > 0 && cells[0].trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map((cell) => cell.trim());
}

/** 表格行 → markdown（与 note-agent 的输出逐字节一致，只是多做了竖线转义）。 */
export function rowsToMarkdown(rows) {
  const body = (Array.isArray(rows) ? rows : []).filter((row, index) => !(index > 0 && isSeparatorRow(row)));
  const width = body.reduce((max, row) => Math.max(max, row.length), 0);
  if (width === 0) return '';
  return body
    .map((row, index) => {
      const cells = Array.from({ length: width }, (_, i) => escapeCell(row[i] ?? ''));
      const line = `| ${cells.join(' | ')} |`;
      return index === 0 ? `${line}\n|${' --- |'.repeat(width)}` : line;
    })
    .join('\n');
}

/** 一段文本的「单行化」：换行折成空格。标题、来源这类字段用得到。 */
export function singleLine(value) {
  return String(value ?? '').replace(/\s*\n\s*/g, ' ').trim();
}
