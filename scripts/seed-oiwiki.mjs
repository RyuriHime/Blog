/**
 * 把 OI-wiki 的 `docs/**.md` 导入成站内的一个 wiki 站（默认名「OI Wiki」）。
 *
 * ── 为什么直接建 store，不走 HTTP ──
 * `src/modules/doc/routes.js:66` 对每个写动作限流 60 次 / 10 分钟。465 页要「建页 + 写正文」
 * 两轮，走接口得一个多小时。这里照 `src/server.js` 的第 1–3 步（开库 → 建 store）在进程里
 * 直接调用数据层，不挂 HTTP、不注册任何路由 —— 权限判断、修订快照、影子行同步全都照旧走
 * `createDocStore` 里那几条硬约定。
 *
 * ── 方言转换（mkdocs-material → 本站积木）──
 *   `??? note "标题"` / `???+ note` / `!!! note` → 一个 `doc:fold` 折叠块
 *       （`???` 收起来、`???+` 与 `!!!` 展开；嵌套在折叠块里的再套一层会退化成 `**标题**` 段落，
 *        因为折叠块的正文是**块内的 markdown**，渲染器不再有块类型可用）
 *   `=== "标签"`                              → 一个 `doc:fold` 折叠块（一个标签一块）
 *   `[^id]` 引用 + `[^id]: 定义`               → 正文里发 `<sup>N</sup>`，文末按**首次引用顺序**列脚注
 *   `![图](images/x.svg)`                     → 图片拷进 `data/uploads/oi-wiki/…`，引用改 `/uploads/oi-wiki/…`
 *   `[字](../basic/bucket-sort.md#锚点)`       → `[[那一页的标题|字]]`（锚点丢弃：块 id 是重排的）
 *   行内 `<kbd>` / `<br>` / `<sup>` 等         → 原样留着（`src/markdown.js` 的行内白名单）
 *
 * ── 源码放在哪 ──
 * 上游源码**随仓库走**：`oi-wiki-src/OI-wiki-master`（`docs/` + `mkdocs.yml`，来历与许可见
 * `oi-wiki-src/README.md`）。老习惯把源码摆在仓库外面（`../oi-wiki-src/OI-wiki-master`）也照样认，
 * 两边都有时以仓库内那份为准；`--src <目录>` 可以指定别处。
 *
 * ── 在线上跑（内容在库里，不在 git 里）──
 * 服务器上的定时部署**只换 `src/ public/ scripts/`**（见 `docs/skeleton.md` §5），数据库从来不参与，
 * 所以「推上 main」不会让线上多出这个站 —— 要在服务器上手动跑一次这条命令，它会**复用同名站**
 * （线上已经有站长手建的空站就叫「OI Wiki」，见 `:607` 那段按标题查站的逻辑），把 519 页填进去：
 *
 *   cd <git clone 目录>                                  # oi-wiki-src/ 在这个 clone 里
 *   DB_FILE=/opt/.../data/forum.db node scripts/seed-oiwiki.mjs --user RyuriHime
 *
 * `--user` 是**以谁的身份**建站建页（默认 `admin`，那是本地演示账号；线上通常没有它）。
 * 图片按 `UPLOAD_DIR`（即数据库旁边的 `uploads/`）落盘，所以 DB_FILE 指对了图就跟着对。
 *
 * 用法：
 *   node scripts/seed-oiwiki.mjs                    # 导入到 data/p2-preview.db
 *   DB_FILE=data/forum.db node scripts/seed-oiwiki.mjs
 *   node scripts/seed-oiwiki.mjs --user RyuriHime    # 线上：以站长账号导入
 *   node scripts/seed-oiwiki.mjs --dry --limit 8    # 只转换不落库，打印每页大小 / 块数
 *   node scripts/seed-oiwiki.mjs --tree             # 只补 mkdocs 目录树（叶子正文不动）
 *   node scripts/seed-oiwiki.mjs --station "OI Wiki" --only dp/
 *   node scripts/seed-oiwiki.mjs --tree --extras    # 连没进 nav 的文件一起发布
 *   node scripts/seed-oiwiki.mjs --src /path/to/OI-wiki-master
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ---------------- 命令行 ---------------- */

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback = '') => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback;
};

const DRY = flag('dry');
// 只补目录结构：叶子正文上次已经写对了，重跑时跳过它们的 `putMarkdown`（目录页与站首页照写）。
const TREE_ONLY = flag('tree') || flag('no-content');
// 默认只发布 `nav:` 里列过的文件：没进目录的文件（`edit-landing.md`、`intro/docker-deploy.md`）
// 在上游站点里也不是给读者看的正文页，硬导进来只会得到句子式的怪页名。加 `--extras` 才一并发布。
const INCLUDE_EXTRAS = flag('extras');
// `buildPages()` 里被跳过的 nav 之外文件（只在提示里用，`--extras` 时为空）。
let skippedExtras = [];
const LIMIT = Number(opt('limit', '0')) || 0;
const ONLY = opt('only', '');
const STATION_TITLE = opt('station', 'OI Wiki');
// 以谁的身份建站建页。默认 `admin` 是本地演示账号；线上（真实社区）通常没有这个账号，
// 必须用 `--user <用户名>` 指一个真实存在的账号，否则 bootStore() 会明确报错退出。
const VIEWER_USERNAME = opt('user', 'admin');
// `DB_FILE` 必须在 import core 之前定下：`src/core/paths.js` 在模块求值那一刻就把常量定死了。
if (!process.env.DB_FILE) process.env.DB_FILE = join(ROOT, 'data', 'p2-preview.db');

// 上游源码优先用仓库里那份（`oi-wiki-src/OI-wiki-master`），其次才是仓库外面的老位置；
// 两份都没有时（服务器上就是这种情况 —— 部署只换 src/ public/ scripts/，仓库根上不去）
// 现从 GitHub 取一份到缓存目录。细节见 scripts/fetch-oiwiki.mjs。
const SRC_CANDIDATES = [
  join(ROOT, 'oi-wiki-src', 'OI-wiki-master'),
  join(ROOT, '..', 'oi-wiki-src', 'OI-wiki-master'),
];
let srcRoot = opt('src', '') || SRC_CANDIDATES.find((dir) => existsSync(join(dir, 'docs'))) || '';
if (!existsSync(join(srcRoot || SRC_CANDIDATES[0], 'docs')) && !flag('no-fetch')) {
  const { SOURCE_DIR_NAME, defaultCacheDir, downloadSource } = await import('./fetch-oiwiki.mjs');
  const cacheDir = resolve(opt('fetch-dir', defaultCacheDir(process.env.DB_FILE)), SOURCE_DIR_NAME);
  console.log(`本地没有源码，现从 GitHub 取一份（缓存在 ${cacheDir}）…`);
  try {
    await downloadSource({ targetDir: cacheDir });
    srcRoot = cacheDir;
  } catch (error) {
    console.error(error.message);
  }
}
const SRC_ROOT = resolve(srcRoot || SRC_CANDIDATES[0]);
const DOCS_DIR = resolve(opt('dir', join(SRC_ROOT, 'docs')));
// 图片默认落在**数据库旁边**的 `uploads/oi-wiki/` —— 跟 `src/core/paths.js:34` 的 UPLOAD_DIR 同一条推导
// （`DB_FILE` 在哪个目录，`uploads/` 就在哪个目录）。本地跑等于原来的 `data/uploads/oi-wiki`；
// 线上把 DB_FILE 指到别处时，图也跟着落过去，正文里的 `/uploads/oi-wiki/…` 才不会成死链。
const { UPLOAD_DIR } = await import('../src/core/paths.js');
const IMAGE_ROOT = resolve(opt('images', join(UPLOAD_DIR, 'oi-wiki')));
const UPLOAD_URL = opt('url', '/uploads/oi-wiki');

/* ---------------- 转换器 ---------------- */

/** `??? note "标题"` / `???+` / `!!!` 的那一行。 */
const ADMONITION_RE = /^(\s*)(\?\?\?\+?|!!!)\s*([A-Za-z0-9_-]*)\s*(?:"([^"]*)"|'([^']*)')?\s*$/;
/** `=== "标签"` 的那一行（mkdocs 的 content tabs）。 */
const TAB_RE = /^(\s*)===\s*(?:"([^"]*)"|'([^']*)'|(.+?))\s*$/;

const KIND_TITLES = {
  note: '注意', info: '说明', tip: '提示', warning: '警告', caution: '小心', danger: '危险',
  example: '示例', abstract: '摘要', summary: '摘要', tldr: '摘要', details: '细节',
  success: '成功', failure: '失败', question: '思考', bug: '缺陷', quote: '引用',
};

const FOLD_MAX_CHARS = 60000;

/** 上游在 mkdocs 的 nav 里挂着、源文件却是 0 字节的占位页（如 `ds/seg-in-balanced.md`）。 */
const EMPTY_PAGE_NOTE = '> 上游这一页还是空的（OI Wiki 里就是一个占位文件）。';

/** 挑一根正文里没出现过的围栏（和 `blocks/text.js` 的 `fenceFor` 同一套规则）。 */
function pickFence(text) {
  let n = 3;
  while (new RegExp(`\`{${n},}`).test(text)) n += 1;
  return '`'.repeat(n);
}

/** 一个折叠块（结构化围栏，和 `structuredMarkdown('fold', props)` 逐字同形）。 */
function foldFence({ kind, title, open, text }) {
  const payload = `doc:fold\n${JSON.stringify({ title, kind, open, text }, null, 2)}`;
  const fence = pickFence(payload);
  return `${fence}${payload}\n${fence}`;
}

/** 标题行 + 正文（折叠块装不下时的退路，也是嵌套折叠块的降级形态）。 */
function plainSection(title, text) {
  return text ? `**${title}**\n\n${text}` : `**${title}**`;
}

/** 收集一段缩进正文（空行跟着走，缩进不够就停）。 */
function collectIndented(lines, start, indent) {
  const body = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) {
      body.push('');
      i += 1;
      continue;
    }
    if (/^\s*/.exec(line)[0].length < indent) break;
    body.push(line.slice(indent));
    i += 1;
  }
  while (body.length && /^\s*$/.test(body[body.length - 1])) body.pop();
  return { body, next: i };
}

/**
 * 页脚的定义行：`[^id]: 定义`（续行缩进两格以上）。
 *
 * 定义一个都不改内容，只从正文里摘出来 —— 编号要等正文里第一次引用它时才发
 * （所以只被定义、没被引用的脚注不会出现在文末）。
 */
function extractFootnoteDefs(lines) {
  const defs = new Map();
  const kept = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^\[\^([^\]\s]+)\]:\s*(.*)$/.exec(lines[i]);
    if (!m) {
      kept.push(lines[i]);
      continue;
    }
    const parts = [m[2]];
    let j = i + 1;
    while (j < lines.length && /^\s{2,}\S/.test(lines[j]) && !/^\[\^/.test(lines[j].trim())) {
      parts.push(lines[j].trim());
      j += 1;
    }
    defs.set(m[1], parts.join(' ').trim());
    i = j - 1;
  }
  return { defs, kept };
}

/**
 * 头部元信息：OI Wiki 的 md 把 `author:` / `disqus:` / `pagetime:` / `title:` 这几行
 * 直接写在第一行，**不套 `---`**。只认这几类已知的键、且最多 6 行，免得误删正文里
 * 长得像 `key: value` 的句子。
 */
const META_KEY_RE = /^(author|authors|disqus|pagetime|title|description|tags|date|updated|hide|comments|search|exclude|redirect|icon|robots)\s*:/i;

function stripHeaderMeta(lines) {
  let n = 0;
  while (n < lines.length && n < 6 && META_KEY_RE.test(lines[n])) n += 1;
  if (n === 0) return lines;
  let i = n;
  while (i < lines.length && lines[i].trim() === '') i += 1;
  return lines.slice(i);
}

/** 一整篇：正文 + 文末脚注表。 */
function convertSource(source, ctx) {
  const cleaned = String(source)
    .replace(/^\uFEFF/, '')
    // front matter（`---` 包起来的几条元信息：title / disqus / pagetime），本站不吃
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
    // mkdocs 里那些「点一下目录」的小脚本、样式块：渲染器一律转义，留着就是一坨源码
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    // 只做排版用的包裹标签：摘掉标签、留下内容（里面的 <a>/<img> 在白名单里）
    .replace(/<\/?(?:div|center|font|section)\b[^>]*>/gi, '');
  const raw = stripHeaderMeta(cleaned.replace(/\r\n?/g, '\n').split('\n'));
  const { defs, kept } = extractFootnoteDefs(raw);
  ctx.footnoteDefs = defs;
  const out = convertLines(kept, ctx, 0);
  if (ctx.footnoteNumbers.size) {
    const items = [...ctx.footnoteNumbers.entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([id, n]) => `${n}. ${inline(ctx.footnoteDefs.get(id) ?? '', ctx)}`);
    out.push('', '---', '', '### 脚注', '', ...items);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * mkdocs 的片段包含：`--8<-- "docs/basic/code/x.cpp:core"`。
 *
 * 带 `:core` 时取文件里 `[start:core]` 和 `[end:core]` 之间的行（标记行本身不要），
 * 找不到段标记就把整份文件搬进来；文件不存在就原样留着（宁可露出源码里那一行，
 * 也别悄悄吞掉）。调用方传的是整段围栏，返回同样长度的行数组。
 */
const SNIPPET_RE = /^(\s*)--8<--\s+"([^"]+)"\s*$/;

function snippetBody(target, ctx) {
  const m = /^([^:]+?)(?::([A-Za-z0-9_.-]+))?$/.exec(target);
  if (!m) {
    ctx.snippetMissing += 1;
    return null;
  }
  const full = resolve(SRC_ROOT, m[1]);
  if (!existsSync(full)) {
    ctx.snippetMissing += 1;
    return null;
  }
  let body = readFileSync(full, 'utf8').replace(/\r\n?/g, '\n').split('\n');
  const section = m[2] ?? '';
  if (section) {
    const start = body.findIndex((row) => row.includes(`[start:${section}]`));
    const end = body.findIndex((row) => row.includes(`[end:${section}]`));
    if (start >= 0 && end > start) body = body.slice(start + 1, end);
    else ctx.snippetNoSection += 1;
  }
  body = body.filter((row) => !row.includes('--8<--'));
  while (body.length && body[0].trim() === '') body.shift();
  while (body.length && body[body.length - 1].trim() === '') body.pop();
  ctx.snippets += 1;
  return body.length ? body : null;
}

function expandSnippets(lines, ctx) {
  if (!lines.some((line) => SNIPPET_RE.test(line))) return lines;
  const out = [];
  for (const line of lines) {
    const m = SNIPPET_RE.exec(line);
    const body = m ? snippetBody(m[2], ctx) : null;
    if (!body) {
      out.push(line);
      continue;
    }
    for (const row of body) out.push(row === '' ? '' : m[1] + row);
  }
  return out;
}

/** 逐行扫：围栏整段搬走（顺带展开 `--8<--` 片段），折叠块 / 标签页各自收成一块。 */
function convertLines(lines, ctx, depth) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      const mark = fence[1][0];
      const len = fence[1].length;
      const close = new RegExp(`^\\s*${mark === '`' ? '`' : '~'}{${len},}\\s*$`);
      const block = [line];
      i += 1;
      while (i < lines.length) {
        block.push(lines[i]);
        const done = close.test(lines[i]);
        i += 1;
        if (done) break;
      }
      out.push(...expandSnippets(block, ctx));
      continue;
    }
    if (/^\s*$/.test(line)) {
      out.push('');
      i += 1;
      continue;
    }

    const adm = ADMONITION_RE.exec(line);
    if (adm) {
      const inner = collectIndented(lines, i + 1, adm[1].length + 4);
      const kind = adm[3] || '';
      // 标题也要过一遍行内改写：上游会把脚注引用写在提示块标题里（`??? note "见[^ref1]"`），
      // 不换就会在页面上留一个 `[^ref1]` 的方括号。
      const titled = (adm[4] ?? adm[5] ?? '').trim();
      const title = (titled ? inline(titled, ctx) : '') || KIND_TITLES[kind] || kind || '展开';
      const open = adm[2] === '???+' || adm[2] === '!!!';
      const text = convertLines(inner.body, ctx, depth + 1).join('\n').trim();
      out.push(
        depth === 0 && text && text.length <= FOLD_MAX_CHARS
          ? foldFence({ kind, title, open, text })
          : plainSection(title, text),
      );
      i = inner.next;
      continue;
    }

    const tab = TAB_RE.exec(line);
    if (tab) {
      const inner = collectIndented(lines, i + 1, tab[1].length + 4);
      const tabTitle = (tab[2] ?? tab[3] ?? tab[4] ?? '').trim();
      const title = (tabTitle ? inline(tabTitle, ctx) : '') || '示例';
      const text = convertLines(inner.body, ctx, depth + 1).join('\n').trim();
      out.push(
        depth === 0 && text && text.length <= FOLD_MAX_CHARS
          ? foldFence({ kind: 'example', title, open: false, text })
          : plainSection(title, text),
      );
      i = inner.next;
      continue;
    }

    out.push(inline(line, ctx));
    i += 1;
  }
  return out;
}

/** 行内改写：注释、脚注引用、图片、<img>、站内 .md 链接。 */
function inline(text, ctx) {
  if (!text || text.indexOf('[') < 0 && text.indexOf('<') < 0 && text.indexOf('!') < 0) return text;
  let out = text.replace(/<!--[\s\S]*?-->/g, '');
  out = out.replace(/\[\^([^\]\s]+)\]/g, (whole, id) => {
    const n = footnoteNumber(id, ctx);
    return n ? `<sup>${n}</sup>` : whole;
  });
  out = out.replace(/!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g, (whole, alt, url) => {
    const next = ctx.imageUrl(url);
    return next ? `![${alt}](${next})` : whole;
  });
  out = out.replace(/<img\s[^>]*?src=("([^"]*)"|'([^']*)')[^>]*>/gi, (whole, _all, dq, sq) => {
    const old = dq ?? sq;
    const next = ctx.imageUrl(old);
    return next && old ? whole.split(old).join(next) : whole;
  });
  out = out.replace(/\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g, (whole, label, url) => {
    const next = ctx.linkUrl(url, label);
    return next === null ? whole : next;
  });
  return out;
}

function footnoteNumber(id, ctx) {
  if (!ctx.footnoteDefs.has(id)) return 0;
  let n = ctx.footnoteNumbers.get(id);
  if (!n) {
    n = ctx.footnoteNumbers.size + 1;
    ctx.footnoteNumbers.set(id, n);
  }
  return n;
}

/** 外链、协议相对、data: 一律不动；本地文件才交回给调用方。 */
function localTarget(rawUrl) {
  const url = String(rawUrl ?? '').replace(/^<|>$/g, '').trim();
  if (!url || url.startsWith('#') || url.startsWith('//')) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return '';
  return url;
}

/* ---------------- 页面清单（mkdocs nav → 站内目录树） ---------------- */

function parseNav(yaml) {
  const lines = yaml.split('\n');
  const start = lines.findIndex((line) => /^nav:\s*$/.test(line));
  if (start < 0) return [];
  const nodes = [];
  const stack = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') continue;
    if (/^\S/.test(line)) break;
    const m = /^(\s*)-\s*(.*)$/.exec(line);
    if (!m) continue;
    const indent = m[1].length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack.length ? stack[stack.length - 1] : null;
    const rest = m[2].trim();
    const leaf = /^(?:"([^"]*)"|'([^']*)'|(.*?))\s*:\s*([^\s:]+\.md)\s*$/.exec(rest);
    const node = { indent, parent, children: [], title: '', path: '', file: false, pageId: 0 };
    if (leaf) {
      node.title = (leaf[1] ?? leaf[2] ?? leaf[3] ?? '').trim();
      node.path = leaf[4];
      node.file = true;
    } else {
      node.title = rest.replace(/:\s*$/, '').trim();
    }
    if (parent) parent.children.push(node);
    nodes.push(node);
    stack.push(node);
  }
  return nodes;
}

function walkMarkdown(dir, base = dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walkMarkdown(full, base));
    else if (entry.name.endsWith('.md')) found.push(relative(base, full).split(sep).join('/'));
  }
  return found.sort();
}

/** 标题最后要能写进 `[[双链]]` 和 URL，`[]|` 这些必须先摘掉。 */
function cleanTitle(value) {
  return String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[[\]|<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

/** 第一个 `#` 标题 —— 要躲开代码块里的 `# 注释`（`intro/docker-deploy.md` 就是栽在这上面）。 */
function firstHeading(text) {
  let fence = '';
  for (const line of text.split(/\r?\n/)) {
    const marker = /^\s*(```|~~~)/.exec(line);
    if (marker) {
      fence = fence ? '' : marker[1];
      continue;
    }
    if (fence) continue;
    const m = /^#\s+(.+)$/.exec(line);
    if (m) return cleanTitle(m[1]);
  }
  return '';
}

/** 整份清单：nav 的目录与叶子都成页（前序），nav 之外的文件接在后面。 */
function buildPages() {
  const navFile = join(SRC_ROOT, 'mkdocs.yml');
  const nodes = existsSync(navFile) ? parseNav(readFileSync(navFile, 'utf8')) : [];
  const leaves = nodes.filter((node) => node.file);
  const inNav = new Set(leaves.map((node) => node.path));
  const leafTitles = new Set(leaves.map((node) => cleanTitle(node.title)));

  const sectionOf = (node) => {
    for (let cur = node.parent; cur; cur = cur.parent) {
      if (!cur.file && cur.title) return cur.title;
    }
    return '';
  };

  const pages = [];
  const used = new Map();
  // 按 nav 的书写顺序遍历（前序：目录写在它的子项之前）⇒ 父页总是先建好。
  for (const node of nodes) {
    if (!node.file) {
      const title = cleanTitle(node.title);
      // 目录标题跟某一页撞车时（OI Wiki 里是「并查集」「堆」「二叉搜索树 & 平衡树」），
      // 页面保住自己的名字，这一层目录不单独成页，子页挂到更上一层的目录页上去。
      if (!title || leafTitles.has(title) || used.has(title)) {
        node.section = false;
        continue;
      }
      used.set(title, node);
      node.finalTitle = title;
      node.section = true;
      pages.push({ path: '', title, node, section: true });
      continue;
    }
    if (!existsSync(join(DOCS_DIR, node.path))) {
      console.warn(`⚠ nav 指的 ${node.path} 不存在，跳过`);
      continue;
    }
    let title = cleanTitle(node.title) || cleanTitle(node.path.replace(/\.md$/, '').split('/').pop());
    if (used.has(title)) {
      const section = cleanTitle(sectionOf(node));
      let alt = section ? `${title}（${section}）` : `${title}（${node.path.split('/')[0]}）`;
      let k = 2;
      while (used.has(alt)) {
        alt = `${title}（${section || node.path.split('/')[0]} ${k}）`;
        k += 1;
      }
      title = alt;
    }
    used.set(title, node);
    node.finalTitle = title;
    pages.push({ path: node.path, title, node });
  }

  const extras = walkMarkdown(DOCS_DIR).filter((path) => !inNav.has(path));
  skippedExtras = [];
  for (const path of extras) {
    if (!INCLUDE_EXTRAS) {
      skippedExtras.push(path);
      continue;
    }
    const text = readFileSync(join(DOCS_DIR, path), 'utf8');
    // nav 之外的文件：先找 `#` 标题（要躲开代码块），没有就拿第一行正文当页名；
    // 两样都没有（`edit-landing.md` 这种空壳）就不进站 —— 它们本来就不是给读者看的。
    let title = firstHeading(text);
    if (!title) {
      const line = stripHeaderMeta(text.split(/\r?\n/)).find((raw) => raw.trim() && !/^\s*(#|>|\||```|~~~)/.test(raw));
      title = line ? cleanTitle(line.replace(/[*_`]/g, '')).slice(0, 40) : '';
    }
    if (!title) {
      console.warn(`⚠ nav 之外的 ${path} 没有正文，跳过`);
      continue;
    }
    if (used.has(title)) title = `${title}（${path.split('/')[0]}）`;
    if (used.has(title)) title = `${title} ${pages.length + 1}`;
    used.set(title, { path });
    pages.push({ path, title, node: null, extra: true });
  }

  const total = new Map();
  for (const page of pages) {
    const list = total.get(page.title) ?? [];
    list.push(page.path);
    total.set(page.title, list);
  }
  const clash = [...total.entries()].filter(([, list]) => list.length > 1);
  if (clash.length) console.warn('⚠ 标题仍然撞车：', JSON.stringify(clash));
  return pages;
}

/* ---------------- 落库 ---------------- */

async function bootStore() {
  // 副作用导入：这一步会把 core 的 14 张表与各模块的表登记进 `schemas`，
  // 必须在 `openDatabase` 之前发生（`src/server.js` 第 1–3 步）。
  await import('../src/db.js');
  await import('../src/modules/index.js');
  const core = await import('../src/core/index.js');
  const { createStore } = await import('../src/store.js');
  const { migrateDocTables } = await import('../src/modules/doc/migrate.js');
  const { loadBlockTypes } = await import('../src/modules/doc/blocks/index.js');
  const { createDocQueries } = await import('../src/modules/doc/queries.js');
  const { createDocStore } = await import('../src/modules/doc/store.js');

  const { db } = core.openDatabase(process.env.DB_FILE, core.schemas);
  const coreStore = createStore(db);
  core.bindStore(coreStore);
  migrateDocTables(db);
  loadBlockTypes(db);
  const store = createDocStore({ db, queries: createDocQueries(db) });

  const row = db.prepare('SELECT id FROM users WHERE username = ?').get(VIEWER_USERNAME);
  if (!row) {
    throw new Error(
      `库里没有「${VIEWER_USERNAME}」这个账号（默认找的是本地演示账号 admin，线上通常没有它）。\n` +
        '用 `--user <用户名>` 指定以谁的身份导入，例如线上：`--user RyuriHime`。',
    );
  }
  const viewer = coreStore.userById(row.id);
  return { db, coreStore, store, viewer };
}

async function main() {
  if (!existsSync(DOCS_DIR)) {
    throw new Error(
      `找不到 OI-wiki 源码目录：${DOCS_DIR}\n` +
        '仓库里的 `oi-wiki-src/` 一起 clone 下来就有；别处那份用 `--src <OI-wiki-master 目录>` 指过去。',
    );
  }
  const pages = buildPages();
  const sectionPages = pages.filter((page) => page.section);
  const leafPages = pages.filter((page) => !page.section);
  console.log(`源目录: ${DOCS_DIR}`);
  console.log(`页数  : ${leafPages.length} 篇正文（nav 收录 ${leafPages.filter((p) => !p.extra).length}，nav 之外 ${leafPages.filter((p) => p.extra).length}）+ ${sectionPages.length} 个目录页`);
  if (skippedExtras.length) {
    console.log(`跳过  : nav 之外的 ${skippedExtras.length} 个文件（${skippedExtras.join('、')}）—— 要一起发布就加 --extras`);
  }
  if (TREE_ONLY) console.log('模式  : --tree（只补目录结构，不重写正文）');

  const pathToTitle = new Map(leafPages.map((page) => [page.path, page.title]));
  const stats = {
    images: 0, folds: 0, footnotes: 0, bytes: 0, biggest: [], blocks: [],
    snippets: 0, snippetMissing: 0, snippetNoSection: 0,
  };

  let targets = pages;
  if (ONLY) targets = targets.filter((page) => page.path.includes(ONLY));
  if (LIMIT > 0) targets = targets.slice(0, LIMIT);

  const { parseSourceBlocks } = await import('../src/modules/doc/blocks/markdown.js');

  // 先把所有页转换出来：转换是纯函数（只多了一个「按需拷图片」的副作用），
  // 写完一页再转化下一页会让失败难以复现。
  const converted = targets.map((page) => {
    // 目录页没有源文件：正文是「标题 + 子页卡片」，等所有子页都建好之后再写（见下面的 childrenOf）。
    if (page.section) return { page, markdown: '', blocks: 0, size: 0 };
    const ctx = makeContext(page.path, pathToTitle);
    // 0 字节的占位页给一句说明：空页在读的时候看着像坏了。
    const source = convertSource(readFileSync(join(DOCS_DIR, page.path), 'utf8'), ctx);
    const markdown = source.trim() === '' ? EMPTY_PAGE_NOTE : source;
    const parsed = parseSourceBlocks(markdown);
    const size = Buffer.byteLength(markdown, 'utf8');
    stats.folds += (markdown.match(/`{3,}doc:fold/g) ?? []).length;
    stats.footnotes += ctx.footnoteNumbers.size;
    stats.images += ctx.images;
    stats.snippets += ctx.snippets;
    stats.snippetMissing += ctx.snippetMissing;
    stats.snippetNoSection += ctx.snippetNoSection;
    stats.bytes += size;
    stats.biggest.push([page.path, size, parsed.blocks.length]);
    stats.blocks.push([page.path, parsed.blocks.length]);
    return { page, markdown, blocks: parsed.blocks.length, size };
  });

  stats.biggest.sort((a, b) => b[1] - a[1]);
  console.log(`转换完: 共 ${(stats.bytes / 1024 / 1024).toFixed(1)} MB，折叠块 ${stats.folds} 个，脚注 ${stats.footnotes} 条，图片 ${stats.images} 张，代码片段 ${stats.snippets} 个`);
  if (stats.snippetMissing || stats.snippetNoSection) {
    console.log(`代码片段：文件缺失 ${stats.snippetMissing} 个，段标记没找到 ${stats.snippetNoSection} 个（这些位置原样保留 --8<-- 行）`);
  }
  console.log('最大的 5 页:', stats.biggest.slice(0, 5).map(([p, s, b]) => `${p} ${(s / 1024).toFixed(0)}KB/${b}块`).join(' | '));
  const over = stats.biggest.filter(([, size, blocks]) => size > 256 * 1024 || blocks > 500);
  if (over.length) console.warn('⚠ 超过单篇上限的页:', over.map(([p, s, b]) => `${p} ${(s / 1024).toFixed(0)}KB/${b}块`).join(' | '));
  if (DRY) {
    const sample = converted.find((item) => item.markdown);
    console.log('\n--dry：只转换不落库。样例：\n');
    console.log(sample ? sample.markdown.slice(0, 1200) : '（没有选中任何页）');
    return;
  }

  const { store, viewer } = await bootStore();
  const stations = store.listStations({ viewer }).stations ?? [];
  let station = stations.find((item) => item.title === STATION_TITLE);
  if (station) {
    console.log(`复用已有的站 #${station.id}「${station.title}」`);
  } else {
    const created = store.createStation({ viewer, title: STATION_TITLE, scope: 'public' });
    station = created.doc ?? created;
    console.log(`建了新站 #${station.id}「${STATION_TITLE}」`);
  }

  // 循环前先把站首页清成一行标题：`createStationPage` 每挂一页都会往站文档追加一张
  // subpage 卡片（`attachPageToStation`，`assertBudget` 上限 500 块）。目录页也算页数，
  // 465 篇正文 + 51 个目录页已经越过 500，所以循环里还要每隔几十页再清一次。
  const resetHome = () => {
    try {
      store.putMarkdown({ id: station.id, viewer, markdown: `# ${STATION_TITLE}`, confirm: true });
    } catch (error) {
      console.warn(`站首页清空失败（继续）：${error?.message ?? error}`);
    }
  };
  resetHome();

  const failures = [];
  let index = 0;
  for (const item of converted) {
    index += 1;
    const { page } = item;
    try {
      const parentNode = page.node ? nearestPageAncestor(page.node) : null;
      const parentId = parentNode?.pageId ?? 0;
      const created = store.createStationPage({ stationId: station.id, viewer, title: page.title, parentId });
      const doc = created.doc ?? created;
      page.pageId = doc.id;
      if (page.node) page.node.pageId = doc.id;
      store.moveStationPage({
        stationId: station.id,
        id: doc.id,
        viewer,
        parentId,
        sortOrder: index,
      });
      // `--tree` 跳过正文重写（上次已经写对了），但目录页的卡片与 nav 之外的零散页还是照写。
      if (!TREE_ONLY || page.section || page.extra) {
        store.putMarkdown({ id: doc.id, viewer, markdown: item.markdown, confirm: true });
      }
      if (index % 25 === 0 || index === converted.length) {
        console.log(`  … ${index}/${converted.length}：${page.title}（${item.blocks} 块，${(item.size / 1024).toFixed(0)}KB）`);
      }
      if (index % 50 === 0) resetHome();
    } catch (error) {
      failures.push([page.path || page.title, error?.message ?? String(error)]);
      console.warn(`✗ ${page.path || page.title}: ${error?.message ?? error}`);
    }
  }

  // 目录页的正文：标题 + 直接子页的卡片（卡片上的标题留空 = 现查真标题，改页名也跟着变）。
  const childrenOf = new Map();
  for (const item of converted) {
    const parentNode = item.page.node ? nearestPageAncestor(item.page.node) : null;
    const parentId = parentNode?.pageId ?? 0;
    if (!parentId) continue;
    const list = childrenOf.get(parentId) ?? [];
    list.push(item);
    childrenOf.set(parentId, list);
  }
  let sectionWritten = 0;
  for (const item of converted) {
    if (!item.page.section || !item.page.pageId) continue;
    const kids = (childrenOf.get(item.page.pageId) ?? []).filter((kid) => kid.page.pageId);
    if (!kids.length) continue;
    const body = [`# ${item.page.title}`, ''];
    for (const kid of kids) {
      body.push('```doc:subpage', JSON.stringify({ doc: String(kid.page.pageId), mode: 'card', title: '', note: '' }, null, 2), '```', '');
    }
    try {
      store.putMarkdown({ id: item.page.pageId, viewer, markdown: body.join('\n'), confirm: true });
      sectionWritten += 1;
    } catch (error) {
      failures.push([item.page.title, error?.message ?? String(error)]);
      console.warn(`✗ 目录页 ${item.page.title}: ${error?.message ?? error}`);
    }
  }
  console.log(`目录页写好：${sectionWritten} 个（各带子页卡片）`);

  // 站首页放在最后写：`createStationPage` 每挂一页就往站文档追加一张卡片，这一写把它们换成真正的目录。
  const tops = converted.filter((item) => item.page.pageId && (!item.page.node || !nearestPageAncestor(item.page.node)));
  const home = [`# ${STATION_TITLE}`, '', `这里收录 [OI Wiki](https://oi-wiki.org) 的 **${leafPages.length} 篇**正文，按它原本的目录树整理成站内 wiki（外加 ${sectionPages.length} 个目录页）。左侧是目录树，下面是大块入口。`, '', '## 从哪几块看起', ''];
  for (const item of tops.slice(0, 24)) {
    home.push('```doc:subpage', JSON.stringify({ doc: String(item.page.pageId), mode: 'card', title: '', note: '' }, null, 2), '```', '');
  }
  try {
    store.putMarkdown({ id: station.id, viewer, markdown: home.join('\n'), confirm: true });
    console.log(`站首页写好：${tops.length} 个顶级入口`);
  } catch (error) {
    failures.push(['<站首页>', error?.message ?? String(error)]);
    console.warn(`✗ 站首页: ${error?.message ?? error}`);
  }

  console.log(`\n完成：成功 ${converted.length - failures.length}，失败 ${failures.length}`);
  for (const [path, message] of failures.slice(0, 20)) console.log(`  ✗ ${path}: ${message}`);
}

/** 沿 nav 往上找最近的「已经有自己页面」的祖先（目录节点也会成页）：那就是父页。 */
function nearestPageAncestor(node) {
  for (let cur = node?.parent; cur; cur = cur.parent) {
    if (cur.pageId) return cur;
  }
  return null;
}

function makeContext(file, pathToTitle) {
  const ctx = {
    file,
    pathToTitle,
    footnoteDefs: new Map(),
    footnoteNumbers: new Map(),
    imageUrl(url) {
      const local = localTarget(url);
      if (!local) return '';
      const target = local.split('#')[0];
      if (!target) return '';
      const resolvedPath = posix.normalize(posix.join(posix.dirname(file), target));
      if (resolvedPath.startsWith('..') || resolvedPath.startsWith('/')) return '';
      const abs = join(DOCS_DIR, resolvedPath.split('/').join(sep));
      if (!existsSync(abs) || !statSync(abs).isFile()) return '';
      if (!DRY) {
        const dest = join(IMAGE_ROOT, resolvedPath.split('/').join(sep));
        if (!existsSync(dest) || statSync(dest).size !== statSync(abs).size) {
          mkdirSync(dirname(dest), { recursive: true });
          copyFileSync(abs, dest);
        }
      }
      ctx.images += 1;
      return `${UPLOAD_URL}/${resolvedPath.split('/').map(encodeURIComponent).join('/')}`;
    },
    linkUrl(url, label) {
      const local = localTarget(url);
      if (!local) return null;
      const target = local.split('#')[0];
      if (!target) return null;
      const resolvedPath = posix.normalize(posix.join(posix.dirname(file), target));
      if (/\.md$/i.test(resolvedPath)) {
        const title = pathToTitle.get(resolvedPath);
        if (!title) return null; // 站外（或没导入）的 .md：原样留着
        const show = String(label ?? '').trim();
        return !show || show === title ? `[[${title}]]` : `[[${title}|${show}]]`;
      }
      const moved = ctx.imageUrl(local);
      return moved ? `[${label}](${moved})` : null;
    },
    images: 0,
    snippets: 0,
    snippetMissing: 0,
    snippetNoSection: 0,
  };
  return ctx;
}

await main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
