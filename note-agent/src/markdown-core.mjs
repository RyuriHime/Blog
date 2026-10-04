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
      !HEADING_RE.test(lines[i]) &&
      !QUOTE_RE.test(lines[i]) &&
      !UL_RE.test(lines[i]) &&
      !OL_RE.test(lines[i]) &&
      !HR_RE.test(lines[i])
    ) {
      paragraph.push(lines[i]);
      i += 1;
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
