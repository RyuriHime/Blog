// 12 种内置块类型。
//
// 前 7 种（heading paragraph list code table formula image）**是从 note-agent 冻结下来的契约**：
// 名字、`b\d+` 的 id 形状、markdown 输出，全部逐字节保持一致 ——
// 老笔记（note-agent / note-studio 里已经有 88 个测试守着的那套块）可以原样搬过来，
// 两边序列化出来的 markdown 可以直接互换。
// `src/modules/doc/blocks/agent.js` 负责两种表示之间的搬运，
// `scripts/doc-smoke.mjs` 里有一条对拍测试守着这个契约。
//
// 后 5 种（quote poll wiki embed app）是这个模块新增的。
//
// 每个类型的形状：
//   { name, version, label, icon, editor, schema, toMarkdown, toPlain, toHtml }
// 其中 `schema` 是声明式的 props 形状（见 validate.js），
// `toHtml` 是**服务端**渲染（唯一的安全边界：所有文本都已经转义）。
import { BLOCK_TYPE_PATTERN, MAX_APP_CODE, MAX_SCRIPT_CODE } from '../schema.js';
import { sandboxInner } from '../sandbox.js';
import {
  escapeCell,
  escapeHtml,
  escapeHtmlMultiline,
  escapeHtmlWithWikiLinks,
  fenceFor,
  rowsToMarkdown,
  unwrapFormula,
} from './text.js';

/** 用一个 div 包住块内容（所有块共用的外壳）。 */
function shell(type, block, inner) {
  const id = escapeHtml(block?.block_id ?? '');
  // 脚本产出的派生块打个标记：前端据此加一条「脚本产出」的小标，
  // 读者才分得清「作者写的」与「跑出来的」。
  const derived = block?.derived ? ' doc-derived' : '';
  return `<div class="doc-block doc-block-${type}${derived}" data-block-id="${id}" data-block-type="${type}">${inner}</div>`;
}

/** 结构化的类型用 `doc:` 围栏存 markdown（markdown 本身表达不了投票 / 小应用）。 */
function structuredMarkdown(kind, props) {
  const json = JSON.stringify(props, null, 2);
  const fence = fenceFor(json);
  return `${fence}doc:${kind}\n${json}\n${fence}`;
}

/**
 * **源码体不是 JSON** 的结构化块（目前只有 `doc:script`）：块体原样进出。
 * 脚本得以代码的形态待在源码里，而不是被 JSON 转义成一行带 `\n` 的字符串。
 */
function rawMarkdown(kind, body) {
  const text = String(body ?? '');
  const fence = fenceFor(text);
  return `${fence}doc:${kind}\n${text}\n${fence}`;
}

export const BUILTIN_TYPES = [
  {
    name: 'heading',
    version: 1,
    label: '标题',
    icon: 'H',
    editor: 'text+level',
    schema: {
      text: { type: 'string', required: true, singleLine: true, maxLength: 300, label: '标题文字' },
      level: { type: 'number', min: 1, max: 6, default: 1, label: '级别' },
    },
    toMarkdown: (props) => `${'#'.repeat(Math.min(Math.max(Number(props.level) || 1, 1), 6))} ${props.text}`,
    toPlain: (props) => props.text,
    toHtml: (props, block) => {
      const level = Math.min(Math.max(Number(props.level) || 1, 1), 6);
      // `id="h-<blockId>"`：右栏 ToC 与「上一页 / 下一页」之外还有 `#/wiki/<站>/<页>?h=h-b12`
      // 这种站内跳转，它们都需要一个**不随标题改动而失效**的锚点 —— 稳定块 id 正好是。
      // 块 id 在服务端保证唯一（`b` 加数字），所以这里不需要 slug，也不会撞。
      const anchor = block?.block_id ? ` id="h-${escapeHtml(block.block_id)}"` : '';
      return shell('heading', block, `<h${level}${anchor}>${escapeHtml(props.text)}</h${level}>`);
    },
  },
  {
    name: 'paragraph',
    version: 1,
    label: '正文',
    icon: '¶',
    editor: 'text',
    schema: {
      text: { type: 'string', required: true, maxLength: 20000, label: '正文' },
    },
    toMarkdown: (props) => props.text,
    toPlain: (props) => props.text,
    toHtml: (props, block) => shell('paragraph', block, `<p>${escapeHtmlWithWikiLinks(props.text, { multiline: true })}</p>`),
  },
  {
    name: 'list',
    version: 1,
    label: '列表',
    icon: '≣',
    editor: 'text',
    schema: {
      // text 不是必填：Wiki 模板的「修订记录」就是一张**由 document_revisions 填充**的列表，
      // 它存的时候没有正文，只有 source（见下面的 source 字段与 templates.js）。
      text: { type: 'string', default: '', maxLength: 20000, label: '列表内容' },
      // 数据来源。目前只认 { kind: 'revisions', limit }（FR-TPL-02）。
      source: { type: 'object', default: {}, label: '来源' },
    },
    toMarkdown: (props) => {
      const text = String(props.text ?? '');
      if (text.trim().length > 0) return text;
      // 没有正文但有来源（修订记录这种）时，用结构化围栏存 ——
      // 否则它会序列化成空串，被 blocksToMarkdown 过滤掉，往返就丢了这一块。
      return props.source && Object.keys(props.source).length > 0 ? structuredMarkdown('list', props) : text;
    },
    toPlain: (props) => props.text,
    toHtml: (props, block) => shell('list', block, `<div class="doc-list-body">${escapeHtmlWithWikiLinks(props.text, { multiline: true })}</div>`),
  },
  {
    name: 'code',
    version: 1,
    label: '代码',
    icon: '</>',
    editor: 'code',
    schema: {
      text: { type: 'string', required: true, maxLength: 20000, label: '代码' },
      lang: { type: 'string', singleLine: true, default: '', maxLength: 24, label: '语言' },
    },
    toMarkdown: (props) => {
      const fence = fenceFor(props.text);
      return `${fence}${props.lang ?? ''}\n${props.text}\n${fence}`;
    },
    toPlain: (props) => props.text,
    toHtml: (props, block) => {
      const language = props.lang ? ` class="language-${escapeHtml(props.lang)}"` : '';
      return shell('code', block, `<pre><code${language}>${escapeHtml(props.text)}</code></pre>`);
    },
  },
  {
    name: 'table',
    version: 1,
    label: '表格',
    icon: '▦',
    editor: 'table',
    schema: {
      text: { type: 'string', default: '', maxLength: 20000, label: '表格原文' },
      rows: { type: 'rows', default: [], maxRows: 50, maxCols: 12, label: '表格' },
    },
    // 与 note-agent 逐字一致：没有结构化行时退回原文。
    toMarkdown: (props) => (Array.isArray(props.rows) && props.rows.length > 0 ? rowsToMarkdown(props.rows) : props.text),
    toPlain: (props) => {
      const rows = Array.isArray(props.rows) ? props.rows : [];
      return rows.length > 0 ? rows.map((row) => row.join(' | ')).join('\n') : props.text;
    },
    toHtml: (props, block) => {
      const rows = Array.isArray(props.rows) ? props.rows : [];
      if (rows.length === 0) return shell('table', block, `<p>${escapeHtmlMultiline(props.text)}</p>`);
      const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
      const cell = (value, tag) => `<${tag}>${escapeHtml(value)}</${tag}>`;
      const head = Array.from({ length: width }, (_, i) => cell(rows[0][i] ?? '', 'th')).join('');
      const body = rows
        .slice(1)
        .map((row) => `<tr>${Array.from({ length: width }, (_, i) => cell(row[i] ?? '', 'td')).join('')}</tr>`)
        .join('');
      return shell('table', block, `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`);
    },
  },
  {
    name: 'formula',
    version: 1,
    label: '公式',
    icon: '∑',
    editor: 'formula',
    schema: {
      text: { type: 'string', required: true, maxLength: 4000, label: '公式' },
    },
    // 先剥定界符再包 —— 与 note-agent 一致，见 text.js 的 unwrapFormula。
    toMarkdown: (props) => `$$\n${unwrapFormula(props.text)}\n$$`,
    toPlain: (props) => props.text,
    // `$$…$$` 是给**客户端** KaTeX 看的定界符：本站所有数学都在客户端排
    // （服务端 renderMarkdown 从不排公式），而 renderMathInElement 只认带定界符的文本节点 ——
    // 只吐裸 LaTeX 的话，读者看到的是一行公式源码，不是一个公式。
    // 源码折叠在后面：排版失败（KaTeX 不支持的环境）时至少还看得到自己写了什么。
    toHtml: (props, block) => {
      const body = escapeHtml(unwrapFormula(props.text));
      return shell(
        'formula',
        block,
        `<div class="doc-formula-render">$$${body}$$</div>`
          + '<details class="doc-formula-src-wrap"><summary class="doc-formula-src-head">源码</summary>'
          + `<span class="doc-formula-src">${body}</span></details>`,
      );
    },
  },
  {
    name: 'image',
    version: 1,
    label: '图片',
    icon: '▣',
    editor: 'image',
    schema: {
      // note-agent 的 image 块带着一个从不使用的 text（图注的旧位置），
      // 留着它是为了让 note-agent 的块**原样**搬过来还能原样搬回去。
      text: { type: 'string', default: '', maxLength: 20000, label: '图注原文' },
      alt: { type: 'string', singleLine: true, default: '', maxLength: 200, label: '替代文字' },
      src: { type: 'string', singleLine: true, required: true, maxLength: 2000, label: '图片地址' },
    },
    toMarkdown: (props) => `![${props.alt ? String(props.alt) : '图片'}](${props.src ? String(props.src) : ''})`,
    toPlain: (props) => `[图片] ${props.alt ?? ''}`.trim(),
    toHtml: (props, block) =>
      shell(
        'image',
        block,
        `<img src="${escapeHtml(props.src)}" alt="${escapeHtml(props.alt ?? '')}" loading="lazy" referrerpolicy="no-referrer">`,
      ),
  },
  {
    name: 'quote',
    version: 1,
    label: '引用',
    icon: '❝',
    editor: 'quote',
    schema: {
      text: { type: 'string', required: true, maxLength: 4000, label: '引用内容' },
      source: { type: 'string', singleLine: true, default: '', maxLength: 200, label: '出处' },
    },
    toMarkdown: (props) => {
      const lines = String(props.text ?? '').split('\n').map((line) => `> ${line}`);
      if (props.source) lines.push(`> —— ${props.source}`);
      return lines.join('\n');
    },
    toPlain: (props) => (props.source ? `${props.text}\n—— ${props.source}` : props.text),
    toHtml: (props, block) => {
      const cite = props.source ? `<cite>—— ${escapeHtml(props.source)}</cite>` : '';
      return shell('quote', block, `<blockquote>${escapeHtmlWithWikiLinks(props.text, { multiline: true })}${cite}</blockquote>`);
    },
  },
  {
    name: 'poll',
    version: 1,
    label: '投票',
    icon: '☑',
    editor: 'poll',
    schema: {
      question: { type: 'string', required: true, singleLine: true, maxLength: 200, label: '问题' },
      options: { type: 'options', default: [], minItems: 2, maxItems: 10, maxItemLength: 80, label: '选项' },
      multiple: { type: 'boolean', default: false, label: '可多选' },
    },
    toMarkdown: (props) => structuredMarkdown('poll', props),
    toPlain: (props) => `${props.question}\n${(props.options ?? []).map((option) => `· ${option.text}`).join('\n')}`,
    // 投票块的 HTML **由服务端一次画全**（含票数条、勾选标记、底部汇总行），
    // 前端只负责把 `/api/docs/:id/polls` 拿到的数字填进去 ——
    // 前端要是自己拼一份选项出来，块引擎就实现两遍了（见 doc.js 文件头第 1 条纪律）。
    // `role` 按单选/多选给出，用真正的 <button> 而不是给 <li> 挂 role：
    // 键盘 Tab / 空格能用，屏幕阅读器也认得出这是一组选项。
    toHtml: (props, block) => {
      const id = escapeHtml(block?.block_id ?? '');
      const role = props.multiple ? 'checkbox' : 'radio';
      const options = (props.options ?? [])
        .map((option) => {
          const optionId = escapeHtml(option.id);
          return (
            `<li class="doc-poll-option" data-option-id="${optionId}">` +
            `<button class="doc-poll-choice" type="button" role="${role}" aria-checked="false"` +
            ` data-doc-action="poll-vote" data-block-id="${id}" data-option-id="${optionId}">` +
            '<span class="doc-poll-bar" aria-hidden="true"></span>' +
            '<span class="doc-poll-mark" aria-hidden="true"></span>' +
            `<span class="doc-poll-text">${escapeHtml(option.text)}</span>` +
            '<span class="doc-poll-count">0</span>' +
            '</button></li>'
          );
        })
        .join('');
      const hint = props.multiple ? '<span class="doc-poll-hint">可多选</span>' : '';
      return shell(
        'poll',
        block,
        `<p class="doc-poll-question">${escapeHtml(props.question)}${hint}</p>` +
          `<ul class="doc-poll-options">${options}</ul>` +
          '<p class="doc-poll-foot" data-poll-foot>载入票数…</p>',
      );
    },
  },
  {
    name: 'wiki',
    version: 1,
    label: '双链',
    icon: '⧉',
    editor: 'wiki',
    schema: {
      target: { type: 'string', required: true, singleLine: true, maxLength: 200, label: '指向' },
      label: { type: 'string', singleLine: true, default: '', maxLength: 200, label: '显示文字' },
      note: { type: 'string', default: '', maxLength: 400, label: '备注' },
    },
    // label 为空时省略，这样 `[[目标]]` 与 `[[目标|目标]]` 都不会丢失信息。
    toMarkdown: (props) => (props.label ? `[[${props.target}|${props.label}]]` : `[[${props.target}]]`),
    toPlain: (props) => props.target,
    toHtml: (props, block) => {
      const text = props.label || props.target;
      // 给一个真 href：双链是 wiki 的**导航**，不只是装饰 —— `#/wiki/<标题>`
      // 由前端路由接管（找不到页面时给出「建这一页」）。`data-wiki` 留着给脚本用。
      // `encodeURIComponent` 不会编码单引号，但 href 用的是双引号，`"` 会被编码成 %22，安全。
      return shell(
        'wiki',
        block,
        `<a class="doc-wiki-link" data-wiki="${escapeHtml(props.target)}" href="#/wiki/${encodeURIComponent(props.target)}">${escapeHtml(text)}</a>`,
      );
    },
  },
  {
    name: 'embed',
    version: 1,
    label: '嵌入',
    icon: '⇱',
    editor: 'embed',
    schema: {
      url: { type: 'string', required: true, singleLine: true, maxLength: 2000, label: '地址' },
      title: { type: 'string', singleLine: true, default: '', maxLength: 200, label: '标题' },
      height: { type: 'number', min: 120, max: 800, default: 320, label: '高度' },
    },
    toMarkdown: (props) => structuredMarkdown('embed', props),
    toPlain: (props) => props.url,
    toHtml: (props, block) => {
      const title = props.title ? escapeHtml(props.title) : escapeHtml(props.url);
      return shell(
        'embed',
        block,
        `<a class="doc-embed-link" href="${escapeHtml(props.url)}" rel="noopener noreferrer nofollow" target="_blank">${title}</a>`,
      );
    },
  },
  {
    name: 'app',
    version: 1,
    label: '小应用',
    icon: '⚙',
    editor: 'app',
    schema: {
      app: { type: 'string', default: '', singleLine: true, maxLength: 40, label: '应用名（只是个标题）' },
      config: { type: 'object', default: {}, label: '配置' },
      // 这段代码**只在浏览器的玻璃房里跑**，服务端从不执行它（见 ../sandbox.js 的长注释）。
      code: { type: 'string', default: '', maxLength: MAX_APP_CODE, label: '代码（HTML / JS）' },
    },
    toMarkdown: (props) => structuredMarkdown('app', props),
    toPlain: (props) => props.app || '小应用',
    toHtml: (props, block, options) => shell('app', block, sandboxInner(props, block, options)),
  },
  {
    // 第 13 种：**帖子级脚本**。一篇最多一块（这条校验在 store 的写入层，见 `assertOneScript`）。
    //
    // 与 `app` 的关键差别有两处：
    //   1. `sourceBody: 'raw'` —— 源码里它是 ```` ```doc:script ```` 围栏包着的**原始 JS**，
    //      不是 JSON（见 `blocks/markdown.js` 的解析分支）；
    //   2. 它不画自己的界面，而是**画别的块**：脚本通过 `blocks.derived` 能力
    //      把块写进派生层（`doc_script_blocks`），派生层再照常走渲染管线。
    name: 'script',
    version: 1,
    label: '脚本',
    icon: '⌘',
    editor: 'code',
    sourceBody: 'raw',
    schema: {
      // 代码只在读者的浏览器里跑，服务端从不执行（见 ../sandbox.js 的长注释）。
      code: { type: 'string', default: '', maxLength: MAX_SCRIPT_CODE, label: 'JavaScript' },
    },
    toMarkdown: (props) => rawMarkdown('script', props.code),
    toPlain: () => '',
    toHtml: (props, block, options) => shell(
      'script',
      block,
      sandboxInner({ ...props, app: '脚本' }, block, options),
    ),
  },
];

/** 自查：内置类型的名字必须合法、不许重复。启动时（模块 import 期）跑一次。 */
{
  const seen = new Set();
  for (const type of BUILTIN_TYPES) {
    if (!BLOCK_TYPE_PATTERN.test(type.name)) throw new Error(`内置块类型名不合法：${type.name}`);
    if (seen.has(type.name)) throw new Error(`内置块类型重复：${type.name}`);
    seen.add(type.name);
  }
}

/** 竖线转义的重导出，供 markdown 解析复用。 */
export { escapeCell };
