/**
 * render.js —— 纯渲染与统计层（浏览器端）。
 *
 * 与 UI 解耦：不碰任何具体元素之外的全局状态，输入 Markdown、输出 HTML / 统计对象。
 * 这样它既能被编辑器使用，也能被 selfcheck.html 直接验证「公式到底渲染出来没有」。
 *
 * 依赖 vendor/ 下的 marked 与 KaTeX（auto-render 提供 renderMathInElement）。
 */
(function (global) {
  'use strict';

  const KATEX_OPTIONS = {
    delimiters: [
      { left: '$$', right: '$$', display: true },
      { left: '\\[', right: '\\]', display: true },
      { left: '$', right: '$', display: false },
      { left: '\\(', right: '\\)', display: false },
    ],
    ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code', 'option'],
    throwOnError: false,
  };

  /** 按代码围栏切段：围栏里的 $ 不能当公式。 */
  function splitFences(text) {
    const lines = String(text ?? '').split('\n');
    const segments = [];
    let buffer = [];
    let fence = null;

    const flush = (code) => {
      if (buffer.length) segments.push({ code, text: buffer.join('\n') });
      buffer = [];
    };

    for (const line of lines) {
      const match = line.match(/^\s*(`{3,}|~{3,})/);
      if (!fence && match) {
        flush(false);
        fence = match[1][0];
        buffer.push(line);
        continue;
      }
      if (fence && match && match[1][0] === fence) {
        buffer.push(line);
        flush(true);
        fence = null;
        continue;
      }
      buffer.push(line);
    }
    flush(Boolean(fence));
    return segments;
  }

  /**
   * 扫描行内公式 `$...$`（不用正则 lookbehind）。
   *
   * lookbehind（`(?<!$)`）在 Safari < 16.4、Firefox < 78 等浏览器里会直接抛
   * SyntaxError —— 那会让**整个 render.js 解析失败**，页面连行内公式都不渲染。
   * 所以这里改成一个显式扫描器：逐个字符走，遇到成对的 `$$` 就跳过（留给块级公式）。
   *
   * @param {string} text
   * @param {(tex: string) => string} push 命中的 TeX 交给它换回占位符
   */
  function replaceInlineMath(text, push) {
    let out = '';
    let index = 0;

    while (index < text.length) {
      if (text[index] !== '$') {
        out += text[index];
        index += 1;
        continue;
      }

      // 连续的 $：两个及以上一律跳过，交给块级公式或原样保留
      let run = 0;
      while (text[index + run] === '$') run += 1;
      if (run >= 2) {
        out += text.slice(index, index + run);
        index += run;
        continue;
      }

      // 单个 $：往后找配对的单个 $（不跨行，反斜杠转义要跳过）
      let cursor = index + 1;
      let close = -1;
      while (cursor < text.length) {
        const ch = text[cursor];
        if (ch === '\\') { cursor += 2; continue; }
        if (ch === '\n') break;
        if (ch === '$') {
          if (text[cursor + 1] === '$') { cursor += 2; continue; }
          close = cursor;
          break;
        }
        cursor += 1;
      }

      if (close === -1) {
        out += text[index];
        index += 1;
        continue;
      }
      out += push(text.slice(index + 1, close).trim());
      index = close + 1;
    }

    return out;
  }

  /** 公式 → 占位符，避免 marked 把 a_b_c 变成斜体。 */
  function protectMath(markdown) {
    const store = [];
    const parts = splitFences(markdown).map((segment) => {
      if (segment.code) return segment.text;
      const push = (tex, display) => {
        store.push({ tex, display });
        return `@@MATH${store.length - 1}@@`;
      };

      // 块级公式一律补成「独占一段」：否则 `正文\n$$…$$` 会被 CommonMark 当成同一段落，
      // 渲染出来就是块级元素嵌在 <p> 里的非法结构，浏览器表现不一致。
      let text = segment.text
        .replace(/\$\$([\s\S]+?)\$\$/g, (_m, tex) => `\n\n${push(tex.trim(), true)}\n\n`)
        .replace(/\n{3,}/g, '\n\n');

      text = replaceInlineMath(text, (tex) => push(tex, false));
      return text;
    });
    return { markdown: parts.join('\n'), store };
  }

  /**
   * 把占位符换回 `$$…$$` / `$…$`。
   *
   * 特别注意：**独占一段的块级公式要提到 `<p>` 外面**。
   * 否则会得到 `<p><span class="katex-display">…` 这种「块级元素嵌在段落里」的非法结构，
   * 浏览器对它的布局处理并不一致（可能表现为块级公式显示不出来或位置怪异）。
   */
  function restoreMath(html, store) {
    const hoisted = String(html).replace(/<p>\s*@@MATH(\d+)@@\s*<\/p>/g, (match, index) => {
      const item = store[Number(index)];
      return item && item.display ? `\n$$${item.tex}$$\n` : match;
    });

    return hoisted.replace(/@@MATH(\d+)@@/g, (match, index) => {
      const item = store[Number(index)];
      if (!item) return match;
      return item.display ? `\n\n$$${item.tex}$$\n\n` : `$${item.tex}$`;
    });
  }

  /** Markdown → HTML（公式保持原样，等待 KaTeX 接管）。 */
  function markdownToHtml(markdown) {
    const guarded = protectMath(markdown);
    const html = global.marked.parse(guarded.markdown, { gfm: true, breaks: false });
    return restoreMath(html, guarded.store);
  }

  /**
   * 渲染到容器并交给 KaTeX。
   * @returns {{ html: string, math: number }} 渲染出的公式个数（用于自检与状态栏）
   */
  function renderInto(element, markdown) {
    element.innerHTML = markdownToHtml(markdown);
    if (global.renderMathInElement) {
      try {
        global.renderMathInElement(element, KATEX_OPTIONS);
      } catch (error) {
        console.warn('KaTeX 渲染失败', error);
      }
    }
    return { html: element.innerHTML, math: element.querySelectorAll('.katex').length };
  }

  /* ---------------- contenteditable → Markdown ---------------- */

  /** 从 KaTeX 产物里取回原始 TeX（KaTeX 把它放在 MathML 的 annotation 里）。 */
  function texOf(node) {
    const annotation = node.querySelector('annotation[encoding="application/x-tex"]');
    return annotation ? annotation.textContent : '';
  }

  /**
   * 造一个「DOM → Markdown」的序列化器。
   *
   * 关键点：公式必须先换成占位符再交给 turndown。turndown 会转义反斜杠，
   * 直接把 TeX 放进去会把 `\int` 变成 `\\int`，可视化模式一保存就把公式写坏了。
   */
  function createSerializer(turndownInstance) {
    return function serialize(element) {
      const clone = element.cloneNode(true);
      const document_ = element.ownerDocument;
      const store = [];
      const token = (tex, display) => {
        store.push(display ? `$$${tex}$$` : `$${tex}$`);
        return `@@TEX${store.length - 1}@@`;
      };

      clone.querySelectorAll('.katex-display').forEach((node) => {
        node.replaceWith(document_.createTextNode(`\n\n${token(texOf(node), true)}\n\n`));
      });
      clone.querySelectorAll('.katex').forEach((node) => {
        node.replaceWith(document_.createTextNode(token(texOf(node), false)));
      });

      return turndownInstance
        .turndown(clone.innerHTML)
        .replace(/@@TEX(\d+)@@/g, (match, index) => store[Number(index)] ?? match)
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    };
  }

  /* ---------------- 客户端统计预览 ---------------- */

  const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g;
  const LATIN = /[A-Za-z0-9]+(?:['’._-][A-Za-z0-9]+)*/g;

  function slugify(name) {
    return (
      String(name ?? '')
        .split(/[\\/]/).pop()
        .replace(/\.(md|markdown|mdx|txt|text|json)$/i, '')
        .replace(/[\u0000-\u001f<>:"|?*]/g, '-')
        .replace(/\s+/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^[.\-\s]+|[.\-\s]+$/g, '')
        .slice(0, 80) || 'note'
    );
  }

  function maskCode(text) {
    const lines = String(text ?? '').split('\n');
    let fence = false;
    let marker = '';
    return lines
      .map((line) => {
        const match = line.match(/^\s*(`{3,}|~{3,})/);
        if (!fence && match) {
          fence = true;
          marker = match[1][0];
          return ' '.repeat(line.length);
        }
        if (fence) {
          if (match && match[1][0] === marker) fence = false;
          return ' '.repeat(line.length);
        }
        return line.replace(/(`+)[^`]*?\1/g, (m) => ' '.repeat(m.length));
      })
      .join('\n');
  }

  /**
   * 与服务端 meta.mjs 同口径的预览统计（字段名一致）。
   * 用于「文件数据」面板与离线导出；保存到服务器后以服务端返回的 JSON 为准。
   */
  function previewMeta(markdown, name, options = {}) {
    const { conversions = [], createdAt = null, updatedAt = null } = options;
    const text = String(markdown ?? '');
    const masked = maskCode(text);
    const cjk = (text.match(CJK) ?? []).length;
    const latin = (text.match(LATIN) ?? []).length;
    const lines = text.length ? text.split('\n') : [];

    const headings = [];
    masked.split('\n').forEach((line, index) => {
      const match = line.match(/^(#{1,6})\s+(.*?)\s*$/);
      if (match) headings.push({ level: match[1].length, text: match[2], line: index + 1 });
    });

    const display = (masked.match(/\$\$[\s\S]+?\$\$/g) ?? []).length;
    const withoutDisplay = masked.replace(/\$\$[\s\S]+?\$\$/g, ' ');
    let inline = 0;
    replaceInlineMath(withoutDisplay, () => { inline += 1; return ''; });

    const images = (masked.match(/!\[[^\]]*\]\([^)\s]+/g) ?? []).length;
    const links = (masked.replace(/!\[[^\]]*\]\([^)\s]+/g, ' ').match(/\[[^\]]*\]\([^)\s]+/g) ?? []).length;
    const fenceLines = (text.match(/^\s*(`{3,}|~{3,})/gm) ?? []).length;
    const blocks = Math.ceil(fenceLines / 2);
    const tables = (masked.match(/^\s*\|?(\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/gm) ?? []).length;
    const tasks = masked.match(/^\s*[-*+]\s+\[([ xX])\]\s+/gm) ?? [];

    return {
      schema: 'note-studio/document@1',
      generator: { name: 'note-studio', version: '1.0.0' },
      file: {
        name: `${slugify(name)}.md`,
        baseName: slugify(name),
        extension: '.md',
        mimeType: 'text/markdown; charset=utf-8',
        encoding: 'utf-8',
        bytes: new TextEncoder().encode(text).length,
        lines: lines.length,
        sha256: null,
      },
      title: headings.length ? headings[0].text : '',
      stats: {
        characters: text.length,
        charactersNoSpaces: text.replace(/\s/g, '').length,
        words: cjk + latin,
        cjkCharacters: cjk,
        latinWords: latin,
        lines: lines.length,
        nonEmptyLines: lines.filter((line) => line.trim() !== '').length,
        paragraphs: text.split(/\n\s*\n/).filter((block) => block.trim() !== '').length,
        readingMinutes: Math.max(1, Math.ceil(cjk / 300 + latin / 200)),
      },
      structure: { maxDepth: headings.reduce((max, item) => Math.max(max, item.level), 0), headings },
      math: { inline, display, total: inline + display },
      media: { images, links },
      code: { fences: blocks },
      tables,
      tasks: {
        total: tasks.length,
        checked: tasks.filter((item) => /\[[xX]\]/.test(item)).length,
        unchecked: tasks.filter((item) => /\[ \]/.test(item)).length,
      },
      timestamps: { createdAt, updatedAt, savedAt: null },
      ai: { conversions },
    };
  }

  global.NoteRender = {
    KATEX_OPTIONS,
    splitFences,
    protectMath,
    restoreMath,
    replaceInlineMath,
    markdownToHtml,
    renderInto,
    texOf,
    createSerializer,
    previewMeta,
    slugify,
    maskCode,
  };
})(window);
