/**
 * 文件扫描：递归收集文档、解析 YAML front matter（极简子集）、抽取标题与站内引用。
 *
 * 可单独复用：
 *   import { scanDirectory } from './scan.mjs'
 *   const docs = await scanDirectory({ dir: './docs', extensions: ['.md'] })
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';

/** 默认不进入的目录（第三方依赖、版本库、构建产物）。 */
export const DEFAULT_EXCLUDES = [
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  'vendor',
  'data',
];

/** 超长文件截断上限，避免一篇巨型文档把统计带偏。 */
const MAX_CHARS = 200000;

/** 极简 front matter：只认 key: value 与 - 列表，不做嵌套与多行。 */
export function parseFrontMatter(raw) {
  const text = String(raw ?? '');
  if (!text.startsWith('---')) return { data: {}, body: text };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { data: {}, body: text };

  const data = {};
  let listKey = null;
  for (const line of text.slice(3, end).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const itemMatch = trimmed.match(/^-\s+(.*)$/);
    if (itemMatch && listKey) {
      data[listKey].push(itemMatch[1].replace(/^["']|["']$/g, ''));
      continue;
    }
    const pair = trimmed.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (!pair) continue;
    const key = pair[1];
    const value = pair[2].trim();
    const inlineList = value.match(/^\[(.*)\]$/);
    if (inlineList) {
      data[key] = inlineList[1]
        .split(/[,，;；]/)
        .map((item) => item.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
      listKey = null;
    } else if (value === '') {
      data[key] = [];
      listKey = key;
    } else {
      data[key] = value.replace(/^["']|["']$/g, '');
      listKey = null;
    }
  }
  return { data, body: text.slice(end + 4).replace(/^\r?\n/, '') };
}

/** 从正文里取第一个一级/二级标题作为标题候选。 */
export function firstHeading(body) {
  const match = String(body ?? '').match(/^\s{0,3}#{1,2}\s+(.+)$/m);
  return match ? match[1].trim().replace(/[*_`]/g, '') : '';
}

/** 去掉代码块与行内代码，避免示例代码污染关键词统计。 */
export function stripCode(body) {
  return String(body ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/`[^`\n]*`/g, ' ');
}

/**
 * 去掉「引用类」文本：markdown 链接地址、裸文件名、URL。
 * 链接文字（可读的标题）保留，只丢掉路径本身，否则 `./00-post-1.md` 这种路径会变成关键词。
 */
export function stripReferences(body) {
  return String(body ?? '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]]+)\]\]/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/(?:^|[\s(])[\w./-]+\.(?:md|markdown|mdx|txt|png|jpe?g|svg|json)\b/gi, ' ');
}

/** 抽取 markdown 链接与裸文件名引用（两类都当作「显式引用」）。 */
export function extractLinks(body) {
  const links = new Set();
  for (const match of String(body ?? '').matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    links.add(match[1]);
  }
  for (const match of String(body ?? '').matchAll(/\[\[([^\]]+)\]\]/g)) {
    links.add(match[1]);
  }
  for (const match of String(body ?? '').matchAll(/(?:^|[\s(])([\w./-]+\.(?:md|markdown|txt|mdx))/gi)) {
    links.add(match[1]);
  }
  return [...links];
}

/** 统计 markdown 结构信息，便于产出更细的标签。 */
export function structureStats(body) {
  const text = String(body ?? '');
  return {
    headings: (text.match(/^\s{0,3}#{1,6}\s+/gm) ?? []).length,
    codeBlocks: (text.match(/```/g) ?? []).length >> 1,
    links: (text.match(/\[[^\]]*\]\([^)]+\)/g) ?? []).length,
    chars: text.length,
  };
}

async function walk(dir, { extensions, excludes, maxFiles, maxDepth, depth = 0, out = [], onSkip }) {
  if (out.length >= maxFiles || depth > maxDepth) return out;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    onSkip?.(dir, error.code ?? String(error));
    return out;
  }
  for (const entry of entries) {
    if (out.length >= maxFiles) break;
    if (entry.name.startsWith('.') && entry.name !== '.') {
      if (excludes.includes(entry.name)) continue;
    }
    if (excludes.includes(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, { extensions, excludes, maxFiles, maxDepth, depth: depth + 1, out, onSkip });
    } else if (entry.isFile() && extensions.includes(extname(entry.name).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 扫描目录下的文档。
 * @param {{ dir: string, extensions?: string[], excludes?: string[], maxFiles?: number, maxDepth?: number, followLinks?: boolean }} options
 * @returns {Promise<{ root: string, documents: Array<object>, skipped: Array<{path:string,reason:string}> }>}
 */
export async function scanDirectory({
  dir,
  extensions = ['.md', '.markdown', '.mdx', '.txt'],
  excludes = DEFAULT_EXCLUDES,
  maxFiles = 2000,
  maxDepth = 12,
} = {}) {
  const root = resolve(dir);
  const skipped = [];
  const files = await walk(root, {
    extensions,
    excludes,
    maxFiles,
    maxDepth,
    onSkip: (path, reason) => skipped.push({ path, reason }),
  });

  const documents = [];
  for (const file of files) {
    let raw;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      skipped.push({ path: file, reason: error.code ?? String(error) });
      continue;
    }
    const limited = raw.length > MAX_CHARS ? raw.slice(0, MAX_CHARS) : raw;
    const { data, body } = parseFrontMatter(limited);
    const relPath = relative(root, file).split(sep).join('/');
    const title = String(data.title ?? '').trim() || firstHeading(body) || relPath.replace(/\.[^.]+$/, '');
    const links = extractLinks(body);
    documents.push({
      id: relPath,
      path: relPath,
      absolutePath: file,
      title,
      frontMatter: data,
      body,
      text: stripReferences(stripCode(body)),
      links,
      structure: structureStats(body),
      bytes: limited.length,
    });
  }

  documents.sort((a, b) => a.path.localeCompare(b.path));
  return { root, documents, skipped };
}

/** 读一个独立文件（用作种子文档），复用同一套解析。 */
export async function readDocument(file, { root } = {}) {
  const absolute = resolve(file);
  const info = await stat(absolute);
  if (!info.isFile()) throw new Error(`不是文件: ${absolute}`);
  const raw = await readFile(absolute, 'utf8');
  const limited = raw.length > MAX_CHARS ? raw.slice(0, MAX_CHARS) : raw;
  const { data, body } = parseFrontMatter(limited);
  const base = root ? relative(resolve(root), absolute).split(sep).join('/') : absolute;
  return {
    id: base,
    path: base,
    absolutePath: absolute,
    title: String(data.title ?? '').trim() || firstHeading(body) || base.replace(/\.[^.]+$/, ''),
    frontMatter: data,
    body,
    text: stripReferences(stripCode(body)),
    links: extractLinks(body),
    structure: structureStats(body),
    bytes: limited.length,
  };
}
