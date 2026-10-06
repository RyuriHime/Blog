/**
 * 极简 Markdown 渲染器（服务器端使用）。
 * 设计目标：安全第一 —— 先转义全部 HTML，再只注入白名单标签，因此不存在 XSS 注入面。
 * 支持：标题、粗体、斜体、删除线、行内代码、代码块、引用、有序/无序列表、分割线、链接、图片、自动链接。
 */

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

/** 只允许 http(s)/mailto/站内相对路径，其余一律降级为 #，防止 javascript: 等伪协议。 */
function sanitizeUrl(raw) {
  const url = String(raw ?? '').trim().replace(/^["']|["']$/g, '');
  if (/^(https?:\/\/|mailto:)/i.test(url)) return escapeHtml(url);
  if (url.startsWith('/') && !url.startsWith('//')) return escapeHtml(url);
  return '#';
}

function renderInline(escapedText) {
  const codeSpans = [];

  // 行内代码先抽成占位符，避免其中的 * _ [ ] 被后续规则误处理。
  let out = escapedText.replace(/`([^`\n]+)`/g, (_match, code) => {
    codeSpans.push(code);
    return `\u0000C${codeSpans.length - 1}\u0000`;
  });

  // 公式也要先抽走。`$\sum _{i = 0} ^n a_i$` 里那对下划线在 markdown 眼里是
  // 斜体标记，会被替换成 <em>…</em> —— 于是开头和收尾的 `$` 落到两个不同的
  // 文本节点里，KaTeX 的 auto-render 再也配不上这对定界符，公式就原样显示成
  // 一串源码。抽成占位符之后，强调规则再也碰不到公式内部。
  // 必须在行内代码**之后**：「`$5`」里的美元号不是公式。
  const mathSpans = [];
  out = out.replace(/\$\$([^\n]+?)\$\$|\$([^\n$]+?)\$/g, (match) => {
    mathSpans.push(match);
    return `\u0000M${mathSpans.length - 1}\u0000`;
  });

  out = out.replace(
    /!\[([^\]]*)\]\(([^)\s]+)\)/g,
    (_match, alt, url) => `<img src="${sanitizeUrl(url)}" alt="${alt}" loading="lazy">`,
  );
  out = out.replace(
    /\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g,
    (_match, label, url) =>
      `<a href="${sanitizeUrl(url)}" target="_blank" rel="noopener nofollow">${label}</a>`,
  );
  out = out.replace(
    /&lt;((?:https?:\/\/|mailto:)[^\s&]+)&gt;/g,
    (_match, url) =>
      `<a href="${sanitizeUrl(url)}" target="_blank" rel="noopener nofollow">${url}</a>`,
  );
  out = out.replace(/\*\*([^*\n]+)\*\*|__([^_\n]+)__/g, (_m, a, b) => `<strong>${a ?? b}</strong>`);
  out = out.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, (_m, pre, inner) => `${pre}<em>${inner}</em>`);
  out = out.replace(/(^|[^_\w])_([^_\n]+)_(?!_)/g, (_m, pre, inner) => `${pre}<em>${inner}</em>`);
  out = out.replace(/~~([^~\n]+)~~/g, (_m, inner) => `<del>${inner}</del>`);

  // 公式占位符要**在**代码占位符之前还原，两者互不嵌套，顺序其实无所谓；
  // 分开写只是为了让「抽走的东西一定被放回来」这件事一眼可见。
  out = out.replace(/\u0000M(\d+)\u0000/g, (_match, index) => mathSpans[Number(index)]);

  return out.replace(/\u0000C(\d+)\u0000/g, (_m, index) => `<code>${codeSpans[Number(index)]}</code>`);
}

const FENCE_RE = /^\s*(```|~~~)\s*([\w+#.-]*)\s*$/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR_RE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE_RE = /^\s{0,3}>\s?/;
const UL_RE = /^\s*[-*+]\s+/;
const OL_RE = /^\s*\d+[.)]\s+/;

export function renderMarkdown(source) {
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
      while (close < lines.length && !/^\s*\$\$\s*$/.test(lines[close])) close += 1;
      if (close < lines.length) {
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
      html.push(`<h${level}>${renderInline(escapeHtml(heading[2]))}</h${level}>`);
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
      html.push(`<blockquote>${renderMarkdown(buffer.join('\n'))}</blockquote>`);
      continue;
    }

    if (UL_RE.test(line) || OL_RE.test(line)) {
      const ordered = OL_RE.test(line);
      const itemRe = ordered ? OL_RE : UL_RE;
      const items = [];
      while (i < lines.length && itemRe.test(lines[i])) {
        items.push(lines[i].replace(itemRe, ''));
        i += 1;
      }
      const tag = ordered ? 'ol' : 'ul';
      html.push(
        `<${tag}>${items.map((item) => `<li>${renderInline(escapeHtml(item))}</li>`).join('')}</${tag}>`,
      );
      continue;
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
      !UL_RE.test(lines[i]) &&
      !OL_RE.test(lines[i]) &&
      !HR_RE.test(lines[i])
    ) {
      paragraph.push(lines[i]);
      i += 1;
    }
    if (paragraph.length === 0) {
      // 收集器一行都没收进来（最典型的是：独占一行的 `$$` 后面没有配对收尾，
      // 上面那个分支故意不接、这里又刚被新加的停止条件挡住）。
      // 必须**强制前进一行**，否则 while 原地打转、i 永不增加 —— 会直接把
      // node 跑到 OOM。把这一行当纯文字输出即可。
      html.push(`<p>${renderInline(escapeHtml(line))}</p>`);
      i += 1;
      continue;
    }
    html.push(`<p>${paragraph.map((item) => renderInline(escapeHtml(item))).join('<br>')}</p>`);
  }

  return html.join('\n');
}

/** 列表页摘要：去掉常见 Markdown 标记，压缩空白。 */
export function markdownToPlainText(source, limit = 160) {
  const plain = String(source ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}>+\s?/gm, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/[*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > limit ? `${plain.slice(0, limit)}…` : plain;
}
