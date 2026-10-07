/**
 * 纯 Markdown 渲染实现（零依赖，Node 与浏览器都能跑）。
 *
 * 这是"宿主没有渲染器时"的兜底：面板的「效果」预览默认打宿主的
 * `POST <hostBase>/markdown/preview`（与站内真实渲染 100% 一致）；打不通时，
 * 浏览器会动态 import 这个模块（挂载层把它发在 `/notes-markdown.js`）自己渲染，
 * 于是交付包被单独拷到别的站点时，「效果」按钮依然点的动。
 *
 * 安全模型与宿主 `src/markdown.js` 一致：先把全部 HTML 转义，再只注入白名单标签，
 * 因此不存在 XSS 注入面。
 *
 * ⚠️ 本文件是 `src/markdown.js` 正文的**逐字拷贝**（只有上面这段注释不同）。
 *    以前它是一份悄悄漂移的旧拷贝 —— 少了块级 `$$` 处理，面板预览里多行公式
 *    永远显示成源码，而测试还是绿的。现在由 `scripts/sync-markdown-core.mjs`
 *    生成、由 `note-agent/tests/test-markdown.mjs` 守着：改了宿主渲染器就
 *    跑一次 `node scripts/sync-markdown-core.mjs`，忘了跑测试会直接报红。
 */

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

const ABSOLUTE_URL_RE = /^(?:https?:\/\/|mailto:)/i;
const HAS_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * 把链接目标分成两类。
 *
 *   { kind: 'external', href } —— http(s)/mailto，开新标签打开
 *   { kind: 'internal', href } —— 站内（`#/post/12`、`/docs/a.md`、`./a.md`），原地跳转
 *   null                       —— 不认识或不安全，调用方应退化成纯文字
 *
 * 这张白名单以前只放行 `http(s)/mailto` 和 `/` 开头的绝对路径，于是 `#/post/12`
 * 这种站内路由和 `./a.md` 这种相对路径**全部**被替换成 `href="#"` —— 帖子里
 * 互相指路的链接一个都点不动，还看不出哪里错了（渲染出来仍是个蓝色链接）。
 */
function resolveUrl(raw) {
  const url = String(raw ?? '').trim().replace(/^["']|["']$/g, '');
  if (url === '') return null;
  // 控制字符与换行一律不认：`java\nscript:` 这类拆分把戏要在这里就断掉。
  if (/[\u0000-\u001f\u007f]/.test(url)) return null;
  if (ABSOLUTE_URL_RE.test(url)) return { kind: 'external', href: url };
  // `//evil.com` 是协议相对地址，会跳到站外 —— 不能当成站内路径放过去。
  if (url.startsWith('//')) return null;
  // 剩下还带协议头的（javascript:、data:、vbscript:…）一律拒绝。
  if (HAS_SCHEME_RE.test(url)) return null;
  return { kind: 'internal', href: url };
}

/** 生成 `<a>`。目标不合法时退化成纯文字，而不是留一个点不动的 `#` 假装能点。 */
function anchorHtml(labelHtml, rawUrl, rawTitle = '') {
  const target = resolveUrl(rawUrl);
  if (!target) return labelHtml;
  const href = escapeHtml(target.href);
  // `[文字](url "提示")` 里的提示要真的挂上去 —— 否则用户写了也看不见。
  const title = rawTitle ? ` title="${escapeHtml(rawTitle)}"` : '';
  if (target.kind === 'external') {
    return `<a href="${href}"${title} target="_blank" rel="noopener nofollow">${labelHtml}</a>`;
  }
  return `<a href="${href}"${title}>${labelHtml}</a>`;
}

/**
 * 从 `[` 开始解析 `[标签](目标 "标题")`。
 * 标签里允许**配平**的方括号与转义反斜杠；目标里的括号也要配平，
 * 所以 `https://zh.wikipedia.org/wiki/Foo_(bar)` 不会被截成 `Foo_(bar`。
 */
function matchLink(src, start) {
  if (src[start] !== '[') return null;

  let depth = 0;
  let close = -1;
  for (let at = start; at < src.length; at += 1) {
    const ch = src[at];
    if (ch === '\\') {
      at += 1;
      continue;
    }
    if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) {
        close = at;
        break;
      }
    } else if (ch === '\n') {
      return null; // 标签不跨行
    }
  }
  if (close === -1 || src[close + 1] !== '(') return null;
  const label = src.slice(start + 1, close);
  if (label === '') return null;

  let at = close + 2;
  let url = '';
  let parens = 0;
  for (; at < src.length; at += 1) {
    const ch = src[at];
    if (ch === '\\' && at + 1 < src.length) {
      url += src[at + 1];
      at += 1;
      continue;
    }
    if (ch === '(') {
      parens += 1;
      url += ch;
      continue;
    }
    if (ch === ')') {
      if (parens === 0) break;
      parens -= 1;
      url += ch;
      continue;
    }
    if (/\s/.test(ch)) break;
    url += ch;
  }
  if (url === '') return null;

  if (src[at] === ')') return { label, url, title: '', end: at + 1 };

  // 目标后面还跟着东西：只可能是可选的标题（其余一律当格式错误）。
  if (!(at < src.length && /\s/.test(src[at]))) return null;
  let t = at;
  while (t < src.length && /\s/.test(src[t])) t += 1;
  const quote = src[t];
  if (quote !== '"' && quote !== "'") return null;
  const endQuote = src.indexOf(quote, t + 1);
  if (endQuote === -1) return null;
  const title = src.slice(t + 1, endQuote);
  t = endQuote + 1;
  while (t < src.length && /\s/.test(src[t])) t += 1;
  if (src[t] !== ')') return null;
  return { label, url, title, end: t + 1 };
}

/** 找强调收尾标记。内容不能为空、不能跨行；`***x***` 这种更长的 run 留给更长的规则。 */
function findEmphasis(src, start, width, marker) {
  const open = marker.repeat(width);
  const contentStart = start + width;
  if (width === 2 && src[contentStart] === marker) return -1;
  let at = contentStart + 1;
  while (at <= src.length) {
    const found = src.indexOf(open, at);
    if (found === -1) return -1;
    if (src.slice(contentStart, found).includes('\n')) return -1;
    if (src[found - 1] === marker || src[found + width] === marker) {
      at = found + 1;
      continue;
    }
    return found;
  }
  return -1;
}

/** 裸链接的收尾标点不算 URL 的一部分（「见 https://a.com/b。」里的句号）。 */
const TRAILING_PUNCT_RE = /[.,;:!?、。，；：！？）】」』’”]+$/u;

/**
 * 行内 HTML 白名单：只放行下面这些「排版用」标签，别的照旧转义成文字。
 *
 * 为什么需要：技术文档里 `<kbd>`（按键）、`<br>`（表格单元格里换行）、`<sup>`/`<sub>`
 * 是家常便饭，全转义掉读起来就是一堆尖括号（OI-wiki 里 `<kbd>` 出现了 326 次）。
 *
 * 安全边界没有变：仍然是「原文扫描 → 白名单拼装」，`<img src>` 与 `<a href>` 的目标
 * 照样过 `resolveUrl`（`javascript:` 一律拒绝）；白名单标签**不接受属性**（`<kbd style=…>`
 * 只会留下 `<kbd>`），只有 `img` / `a` 有各自的属性小名单。
 */
const RAW_HTML_TAGS = new Set([
  'a', 'b', 'big', 'br', 'cite', 'code', 'del', 'dfn', 'em', 'i', 'img', 'ins',
  'kbd', 'mark', 'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'u', 'var',
]);
const VOID_HTML_TAGS = new Set(['br', 'img']);
const RAW_HTML_RE = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[a-zA-Z_:][-a-zA-Z0-9_:.]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>/;
const HTML_ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
const SIZE_ATTR_RE = /^\d{1,4}$/;

/** `img` / `a` 的属性名单。返回 null 表示「这条不算 HTML」，调用方应退化成纯文字。 */
function rawHtmlAttrs(tag, raw) {
  if (tag !== 'a' && tag !== 'img') return raw.trim() === '' ? '' : null;
  const found = new Map();
  let item;
  HTML_ATTR_RE.lastIndex = 0;
  while ((item = HTML_ATTR_RE.exec(raw)) !== null) {
    found.set(item[1].toLowerCase(), item[2] ?? item[3] ?? item[4] ?? '');
  }
  if (tag === 'a') {
    const target = resolveUrl(found.get('href') ?? '');
    if (!target) return null;
    const title = found.has('title') ? ` title="${escapeHtml(found.get('title'))}"` : '';
    const extra = target.kind === 'external' ? ' target="_blank" rel="noopener nofollow"' : '';
    return ` href="${escapeHtml(target.href)}"${title}${extra}`;
  }
  const target = resolveUrl(found.get('src') ?? '');
  if (!target) return null;
  let out = ` src="${escapeHtml(target.href)}"`;
  if (found.has('alt')) out += ` alt="${escapeHtml(found.get('alt'))}"`;
  for (const name of ['width', 'height']) {
    const value = String(found.get(name) ?? '').replace(/px$/i, '');
    if (SIZE_ATTR_RE.test(value)) out += ` ${name}="${value}"`;
  }
  return out;
}

/** 认出白名单里的行内 HTML；认不出返回 null（调用方照旧转义）。 */
function matchRawHtml(src, start, noLinks) {
  const match = RAW_HTML_RE.exec(src.slice(start));
  if (!match) return null;
  const tag = match[2].toLowerCase();
  if (!RAW_HTML_TAGS.has(tag)) return null;
  const end = start + match[0].length;
  if (match[1] === '/') return VOID_HTML_TAGS.has(tag) ? null : { html: `</${tag}>`, end };
  if (tag === 'a' && noLinks) return null;
  const attrs = rawHtmlAttrs(tag, match[3]);
  if (attrs === null) return null;
  return { html: `<${tag}${attrs}>`, end };
}

/**
 * 行内渲染。输入是**原文**（不是转义过的），输出是安全的 HTML。
 * `noLinks` 用于链接标签的内部：HTML 不允许 `<a>` 套 `<a>`，
 * 浏览器会把外层强行闭合，整块排版就散了（通知列表踩过这个坑）。
 *
 * `wikiLinks` / `wikiExisting`：把积木页的**行内双链** `[[目标]]`（可写 `[[目标|显示字]]`）
 * 也认成链接。默认关着 —— 普通帖子里 `[[x]]` 就是两个字面方括号，不能偷偷改语义；
 * 只有积木的正文（`prose` 块的渲染）才打开它，那里 `[[x]]`
 * 与 `blocks/text.js` 的 `escapeHtmlWithWikiLinks` 是同一种约定（红链也一致）。
 */
export function renderInline(source, options = {}) {
  const { noLinks = false, wikiLinks = false, wikiExisting = null } = options;
  const src = String(source ?? '');
  const out = [];
  let text = '';
  let i = 0;

  const flush = () => {
    if (text) {
      out.push(escapeHtml(text));
      text = '';
    }
  };
  const push = (html) => {
    flush();
    out.push(html);
  };

  while (i < src.length) {
    const ch = src[i];

    // 反斜杠定界的公式：`\[…\]` 行间、`\(…\)` 行内，两个都是留给前端 KaTeX 的。
    // ⚠️ 这一条**必须排在下面的反斜杠转义前面**：`\[` 和 `\(` 都在转义字符表里，
    // 一旦被那条规则吃掉反斜杠，auto-render 就再也配不上定界符，公式永远显示成源码；
    // 顺带 `\\`（LaTeX 换行）也会被压成单个 `\`，矩阵的换行全废。
    if (ch === '\\' && (src[i + 1] === '[' || src[i + 1] === '(')) {
      const closer = src[i + 1] === '[' ? '\\]' : '\\)';
      const closeAt = src.indexOf(closer, i + 2);
      if (closeAt !== -1) {
        const whole = src.slice(i, closeAt + closer.length);
        push(escapeHtml(whole));
        i += whole.length;
        continue;
      }
    }

    // 反斜杠转义：`\*` 就是字面的星号，反斜杠本身不显示。
    if (ch === '\\' && i + 1 < src.length && /[\\`*_{}[\]()#+\-.!>~$|]/.test(src[i + 1])) {
      text += src[i + 1];
      i += 2;
      continue;
    }

    // 行内代码：两边反引号的数量必须一致（``` 不能和 ` 配对）。
    if (ch === '`') {
      const open = /^`+/.exec(src.slice(i))[0];
      const closeAt = src.indexOf(open, i + open.length);
      if (closeAt !== -1) {
        let code = src.slice(i + open.length, closeAt);
        // CommonMark：首尾各去掉一个空格（`` ` `` 这种写法用来把反引号包进去）。
        if (code.length > 1 && code.startsWith(' ') && code.endsWith(' ') && code.trim() !== '') {
          code = code.slice(1, -1);
        }
        push(`<code>${escapeHtml(code.replace(/\n/g, ' '))}</code>`);
        i = closeAt + open.length;
        continue;
      }
      text += open;
      i += open.length;
      continue;
    }

    // 公式原样留着交给前端 KaTeX 的 auto-render，但**不能被强调规则碰到**。
    // `$\sum _{i = 0} ^n a_i$` 里那对下划线在 markdown 眼里是斜体标记，
    // 一旦被替换成 <em>…</em>，开头和收尾的 `$` 就落到两个不同的文本节点里，
    // auto-render 再也配不上这对定界符，公式永远显示成源码。
    if (ch === '$') {
      const math = /^\$\$([^\n]+?)\$\$|^\$([^\n$]+?)\$/.exec(src.slice(i));
      if (math) {
        push(escapeHtml(math[0]));
        i += math[0].length;
        continue;
      }
    }

    // 图片 ![alt](url "标题")
    if (ch === '!' && src[i + 1] === '[') {
      const img = matchLink(src, i + 1);
      if (img) {
        const target = resolveUrl(img.url);
        if (target) {
          const title = img.title ? ` title="${escapeHtml(img.title)}"` : '';
          push(
            `<img src="${escapeHtml(target.href)}" alt="${escapeHtml(img.label)}"` +
              ` loading="lazy"${title}>`,
          );
        } else {
          push(escapeHtml(src.slice(i, img.end)));
        }
        i = img.end;
        continue;
      }
    }

    // 积木页的行内双链：`[[目标]]`、`[[目标|显示字]]`。
    // 必须在下面的 `[标签](地址)` 分支**之前**：`[[x]]` 不满足那条规则（没有 `](`），
    // 顺序不换也不会被吃掉，但放在前面读起来才像「先认双链、再认普通链接」。
    if (wikiLinks && ch === '[' && src[i + 1] === '[') {
      const wiki = /^\[\[([^[\]|]+)(?:\|([^[\]]*))?\]\]/.exec(src.slice(i));
      const name = wiki ? String(wiki[1]).trim() : '';
      if (name !== '') {
        const text = String(wiki[2] ?? '').trim() || name;
        const missing = wikiExisting instanceof Set && !wikiExisting.has(name.toLowerCase()) ? ' is-missing' : '';
        push(
          `<a class="doc-wiki-link${missing}" data-wiki="${escapeHtml(name)}"` +
            ` href="#/wiki/${encodeURIComponent(name)}">${escapeHtml(text)}</a>`,
        );
        i += wiki[0].length;
        continue;
      }
    }

    // 链接 [标签](url "标题")
    if (ch === '[' && !noLinks) {
      const link = matchLink(src, i);
      if (link) {
        push(anchorHtml(renderInline(link.label, { ...options, noLinks: true }), link.url, link.title));
        i = link.end;
        continue;
      }
    }

    // 行内 HTML 白名单（`<kbd>` / `<br>` / `<sup>`…，见上面 RAW_HTML_TAGS）。
    // 排在自动链接之前：`<https://…>` 的 `https` 不在白名单里，认不出来就往下走。
    if (ch === '<') {
      const raw = matchRawHtml(src, i, noLinks);
      if (raw) {
        push(raw.html);
        i = raw.end;
        continue;
      }
    }

    // 自动链接 <https://…> / <mailto:…>
    if (ch === '<') {
      const auto = /^<(https?:\/\/[^\s<>]+|mailto:[^\s<>]+)>/i.exec(src.slice(i));
      if (auto) {
        push(anchorHtml(escapeHtml(auto[1]), auto[1]));
        i += auto[0].length;
        continue;
      }
    }

    // 裸链接。前一个字符必须是分隔符，否则 `abc://` 或 URL 中间那一截会被当成新链接。
    if (
      (ch === 'h' || ch === 'H') &&
      !noLinks &&
      /^https?:\/\//i.test(src.slice(i)) &&
      !/[\w/]/.test(src[i - 1] ?? '')
    ) {
      let end = i;
      while (end < src.length && !/[\s<]/.test(src[end])) end += 1;
      let url = src.slice(i, end).replace(TRAILING_PUNCT_RE, '');
      // 括号要配平：「(见 https://a.com/(x))」里最后那个 `)` 属于外层括号。
      while (
        url.endsWith(')') &&
        (url.match(/\(/g) ?? []).length < (url.match(/\)/g) ?? []).length
      ) {
        url = url.slice(0, -1);
      }
      push(anchorHtml(escapeHtml(url), url));
      i += url.length;
      continue;
    }

    // 删除线
    if (ch === '~' && src[i + 1] === '~') {
      const close = src.indexOf('~~', i + 2);
      if (close > i + 2 && !src.slice(i + 2, close).includes('\n')) {
        push(`<del>${renderInline(src.slice(i + 2, close), options)}</del>`);
        i = close + 2;
        continue;
      }
    }

    // 粗体
    if ((ch === '*' || ch === '_') && src[i + 1] === ch) {
      const close = findEmphasis(src, i, 2, ch);
      if (close !== -1) {
        push(`<strong>${renderInline(src.slice(i + 2, close), options)}</strong>`);
        i = close + 2;
        continue;
      }
    }

    // 斜体
    if (ch === '*' || ch === '_') {
      const close = findEmphasis(src, i, 1, ch);
      if (close !== -1) {
        push(`<em>${renderInline(src.slice(i + 1, close), options)}</em>`);
        i = close + 1;
        continue;
      }
    }

    text += ch;
    i += 1;
  }

  flush();
  return out.join('');
}

// 围栏长度是 3 个起、可以更长：````text 这种四连反引号是合法 Markdown（上游写
// 「代码里还嵌着 ``` 的示例」时就得用它），只认恰好三个会把整段当成正文吐出来。
const FENCE_RE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR_RE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE_RE = /^\s{0,3}>\s?/;
const LIST_ITEM_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

function listItemOf(line) {
  const match = LIST_ITEM_RE.exec(line);
  if (!match) return null;
  return {
    indent: match[1].replace(/\t/g, '    ').length,
    ordered: /\d/.test(match[2]),
    text: match[3],
  };
}

/** 拆一行表格：去掉首尾的 `|`，按未转义的 `|` 切，各格 trim。 */
function splitTableRow(line) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells = [];
  let cell = '';
  for (let at = 0; at < trimmed.length; at += 1) {
    const ch = trimmed[at];
    if (ch === '\\' && trimmed[at + 1] === '|') {
      cell += '|';
      at += 1;
      continue;
    }
    if (ch === '|') {
      cells.push(cell);
      cell = '';
      continue;
    }
    cell += ch;
  }
  cells.push(cell);
  return cells.map((item) => item.trim());
}

function isDelimiterRow(line) {
  if (!line.includes('-')) return false;
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

/** 这一行是不是一张表格的开头（本行带 `|`，下一行是 `---` 分隔行）。 */
function startsTable(lines, index) {
  return (
    typeof lines[index] === 'string' &&
    lines[index].includes('|') &&
    typeof lines[index + 1] === 'string' &&
    isDelimiterRow(lines[index + 1])
  );
}

function splitAlign(cell) {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  return '';
}

function buildTable(lines, start, html, inlineOpts) {
  const head = splitTableRow(lines[start]);
  const aligns = splitTableRow(lines[start + 1]).map(splitAlign);
  let i = start + 2;
  const rows = [];
  while (i < lines.length && !/^\s*$/.test(lines[i]) && lines[i].includes('|')) {
    rows.push(splitTableRow(lines[i]));
    i += 1;
  }
  const cell = (tag, content, index) => {
    const align = aligns[index] ?? '';
    const style = align && align !== 'left' ? ` style="text-align:${align}"` : '';
    return `<${tag}${style}>${renderInline(content, inlineOpts)}</${tag}>`;
  };
  const headRow = `<tr>${head.map((item, n) => cell('th', item, n)).join('')}</tr>`;
  const bodyRows = rows
    .map((row) => {
      const padded = head.map((_unused, n) => row[n] ?? '');
      return `<tr>${padded.map((item, n) => cell('td', item, n)).join('')}</tr>`;
    })
    .join('');
  html.push(
    `<div class="md-table"><table><thead>${headRow}</thead>` +
      (bodyRows ? `<tbody>${bodyRows}</tbody>` : '') +
      `</table></div>`,
  );
  return i;
}

/**
 * 收集一段列表。缩进更深的行归上一级（子列表或续行），
 * 所以 `- 一级` + 缩进两格的 `- 二级` 会真的渲染成嵌套的 `<ul>`，
 * 而不是像以前那样被压平成同级条目。
 */
function buildList(lines, start, inlineOpts) {
  const first = listItemOf(lines[start]);
  if (!first) return null;
  const ordered = first.ordered;
  const baseIndent = first.indent;
  const tag = ordered ? 'ol' : 'ul';
  const items = [];
  let i = start;

  while (i < lines.length) {
    const item = listItemOf(lines[i]);
    if (!item || item.indent !== baseIndent || item.ordered !== ordered) break;
    const parts = [item.text];
    const childLines = [];
    i += 1;

    // 列表项里起头的块公式：`-   $$` + 缩进若干行的公式体 + 缩进的 `$$`。
    // 上游（OI-wiki 的「性质」小节）大量这么写；不认的话定界符会被拼进正文，
    // KaTeX 永远配不上，多行公式就整条显示成源码。
    if (item.text === '$$') {
      const mathBody = [];
      let close = -1;
      let cursor = i;
      while (cursor < lines.length) {
        const raw = lines[cursor];
        const indent = raw.match(/^\s*/)[0].replace(/\t/g, '    ').length;
        if (!/^\s*$/.test(raw) && indent <= baseIndent) break; // 已经出了这个列表项
        if (raw.trim() === '$$') {
          close = cursor;
          break;
        }
        mathBody.push(raw.trim());
        cursor += 1;
      }
      if (close >= 0) {
        items.push(`<li><p>$$${escapeHtml(mathBody.join('\n'))}$$</p></li>`);
        i = close + 1;
        continue;
      }
      // 没有配对收尾：不当公式，落到下面按普通条目处理（照旧不吞后面的内容）。
    }

    while (i < lines.length && !/^\s*$/.test(lines[i])) {
      const raw = lines[i];
      const indent = raw.match(/^\s*/)[0].replace(/\t/g, '    ').length;
      if (indent <= baseIndent) break;
      // 子块统一按「父项缩进 + 2」剥掉一层，递归时就是干净的顶层列表。
      childLines.push(raw.slice(Math.min(indent, baseIndent + 2)));
      i += 1;
    }

    const nested = childLines.length ? buildList(childLines, 0, inlineOpts) : null;
    const body = renderInline(parts.join(' '), inlineOpts);
    const child = nested
      ? nested.html
      : childLines.length
        ? `<p>${renderInline(childLines.map((line) => line.trim()).join(' '), inlineOpts)}</p>`
        : '';
    items.push(`<li>${body}${child}</li>`);
  }

  return { html: `<${tag}>${items.join('')}</${tag}>`, next: i };
}

/**
 * 渲染一段 Markdown。
 *
 * `wikiLinks` / `wikiExisting` 只给积木的正文用（见上面的 `renderInline`）：
 * 打开之后 `[[目标]]` 会渲染成 `#/wiki/<目标>` 的站内链接。普通帖子不传，行为与以前一致。
 */
export function renderMarkdown(source, { wikiLinks = false, wikiExisting = null } = {}) {
  const inlineOpts = { wikiLinks, wikiExisting };
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
  const html = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*$/.test(line)) {
      i += 1;
      continue;
    }

    const fence = line.match(FENCE_RE);
    if (fence) {
      const marker = fence[1];
      const lang = fence[2];
      const buffer = [];
      i += 1;
      const closing = new RegExp(`^\\s*${marker}`);
      while (i < lines.length && !closing.test(lines[i])) {
        buffer.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1; // 跳过结束围栏
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : '';
      html.push(`<pre class="md-code"><code${cls}>${escapeHtml(buffer.join('\n'))}</code></pre>`);
      continue;
    }

    // 独占若干行的块间公式：一行 `$$` 起、一行 `$$` 收。
    // 不能让它落到段落分支 —— 段落是按行拼 `<br>` 的，定界符会被 `<br>` 隔开，
    // KaTeX 的 auto-render 一样配不上，多行的块公式就永远显示成源码。
    if (/^\s*\$\$\s*$/.test(line)) {
      // 先找配对收尾。找不到就**不当块公式**：代码围栏可以吞到文件尾（那是
      // CommonMark 规定的），但 `$$` 吞到文件尾会把用户后面写的整篇正文
      // 变成一条居中的公式 —— 只是少打一个 `$$` 而已，代价太大。
      let close = i + 1;
      while (close < lines.length) {
        // 撞到代码围栏也当没配对：`$$` 里不会有围栏，跑到围栏后面找 `$$`
        // 只会把一整段代码（或一段提示块）吞进公式。
        if (FENCE_RE.test(lines[close])) break;
        if (/^\s*\$\$\s*$/.test(lines[close])) break;
        close += 1;
      }
      if (close < lines.length && !FENCE_RE.test(lines[close])) {
        const buffer = lines.slice(i + 1, close);
        i = close + 1; // 跳过收尾的 $$
        html.push(`<p>$$${escapeHtml(buffer.join('\n'))}$$</p>`);
        continue;
      }
      // 落到下面：交给段落分支，定界符原样留着当文字。
    }

    const heading = line.match(HEADING_RE);
    if (heading) {
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(heading[2], inlineOpts)}</h${level}>`);
      i += 1;
      continue;
    }

    if (HR_RE.test(line)) {
      html.push('<hr>');
      i += 1;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const buffer = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) {
        buffer.push(lines[i].replace(QUOTE_RE, ''));
        i += 1;
      }
      html.push(`<blockquote>${renderMarkdown(buffer.join('\n'), inlineOpts)}</blockquote>`);
      continue;
    }

    if (startsTable(lines, i)) {
      i = buildTable(lines, i, html, inlineOpts);
      continue;
    }

    if (LIST_ITEM_RE.test(line)) {
      const list = buildList(lines, i, inlineOpts);
      if (list) {
        html.push(list.html);
        i = list.next;
        continue;
      }
    }

    const paragraph = [];
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !FENCE_RE.test(lines[i]) &&
      // 段落收集器必须在独占一行的 `$$` 前停住，否则「文字 + 紧接块公式」
      // 会被整段按 `<br>` 拼起来，块公式的定界符就被 `<br>` 隔开、
      // KaTeX 配不上（上面那个 $$ 分支永远轮不到）。
      !/^\s*\$\$\s*$/.test(lines[i]) &&
      !HEADING_RE.test(lines[i]) &&
      !QUOTE_RE.test(lines[i]) &&
      !LIST_ITEM_RE.test(lines[i]) &&
      !HR_RE.test(lines[i]) &&
      !startsTable(lines, i)
    ) {
      paragraph.push(lines[i]);
      i += 1;
    }
    if (paragraph.length === 0) {
      // 收集器一行都没收进来（最典型的是：独占一行的 `$$` 后面没有配对收尾，
      // 上面那个分支故意不接、这里又刚被新加的停止条件挡住）。
      // 必须**强制前进一行**，否则 while 原地打转、i 永不增加 —— 会直接把
      // node 跑到 OOM。把这一行当纯文字输出即可。
      html.push(`<p>${renderInline(line, inlineOpts)}</p>`);
      i += 1;
      continue;
    }
    html.push(`<p>${paragraph.map((item) => renderInline(item, inlineOpts)).join('<br>')}</p>`);
  }

  return html.join('\n');
}

/** 列表页摘要：去掉常见 Markdown 标记，压缩空白。 */
export function markdownToPlainText(source, limit = 160) {
  const plain = String(source ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}>+\s?/gm, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    // 表格分隔行整行丢掉，其余行的 `|` 换成空格，别让摘要里竖着一排管道符。
    .replace(/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/gm, '')
    .replace(/^\s*\|(.*)\|\s*$/gm, (_m, inner) => inner.replace(/\|/g, ' '))
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/\\/g, '')
    .replace(/[*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > limit ? `${plain.slice(0, limit)}…` : plain;
}
