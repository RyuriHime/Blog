/**
 * meta —— 文档「基础数据」层。
 *
 * 只做纯计算：给定 Markdown 文本，算出统计、结构、公式、媒体、代码块等，
 * 产出可写入 `<name>.json` 的元数据对象。
 *
 * 这一层**不知道 AI、不知道存储、不知道 HTTP**，因此可以独立测试。
 * 所有函数都是纯函数（除了按需读取传入的文本），没有副作用。
 */
import { createHash } from 'node:crypto';

/** 元数据 schema 版本：字段增减时递增，方便下游判断。 */
export const SCHEMA = 'note-studio/document@1';

/** 生成器标识，写进每一份 .json。 */
export const GENERATOR = Object.freeze({ name: 'note-studio', version: '1.0.0' });

const MAX_BASE_NAME = 80;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const KNOWN_EXTENSION = /\.(md|markdown|mdx|txt|text|json)$/i;
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g;
const LATIN_WORD = /[A-Za-z0-9]+(?:['’._-][A-Za-z0-9]+)*/g;

/**
 * 把任意用户输入消毒成一个安全的文件名主干（不含扩展名）。
 *
 * 规则：切断路径 → 去掉已知扩展名 → 非法字符与空白变连字符 → 折叠连字符 →
 * 去掉首尾的点/连字符 → 规避 Windows 保留名 → 截断到 80 字符。
 */
export function slugifyFilename(name, fallback = 'note') {
  let value = String(name ?? '');
  // 只取最后一段，天然阻断 ../ 与绝对路径
  value = value.split(/[\\/]/).pop() ?? '';
  value = value.replace(KNOWN_EXTENSION, '');
  value = value.replace(/[\u0000-\u001f<>:"|?*]/g, '-');
  value = value.replace(/\s+/g, '-');
  value = value.replace(/-{2,}/g, '-');
  value = value.replace(/^[.\-\s]+/, '').replace(/[.\-\s]+$/, '');
  if (WINDOWS_RESERVED.test(value)) value = `_${value}`;
  if (value.length > MAX_BASE_NAME) {
    value = value.slice(0, MAX_BASE_NAME).replace(/[.\-\s]+$/, '');
  }
  return value || fallback;
}

/**
 * 中英文混合分词计数：CJK 按字计，拉丁按词计。
 * @returns {{ words: number, latinWords: number, cjkCharacters: number }}
 */
export function countWords(text) {
  const value = String(text ?? '');
  const cjkCharacters = (value.match(CJK) ?? []).length;
  const latinWords = (value.match(LATIN_WORD) ?? []).length;
  return { words: cjkCharacters + latinWords, latinWords, cjkCharacters };
}

/** 文本的 sha256（十六进制），用于 json 里记录内容指纹。 */
export function hashText(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

/* ------------------------------------------------------------------ */
/* 内部工具                                                            */
/* ------------------------------------------------------------------ */

const blankOut = (text) => text.replace(/[^\n]/g, ' ');

/**
 * 把代码围栏与行内代码替换成等长空白。
 *
 * 这样标题 / 公式 / 任务清单的识别就不会被代码里的 `#`、`$` 误伤，
 * 同时**保持字符索引与行号不变**，行号仍然准确。
 */
function maskCode(text) {
  const lines = String(text ?? '').split('\n');
  let inFence = false;
  let marker = '';
  const masked = lines.map((line) => {
    const fence = line.match(/^\s*(`{3,}|~{3,})/);
    if (!inFence && fence) {
      inFence = true;
      marker = fence[1][0];
      return blankOut(line);
    }
    if (inFence) {
      if (fence && fence[1][0] === marker) inFence = false;
      return blankOut(line);
    }
    return line.replace(/(`+)[^`]*?\1/g, blankOut);
  });
  return masked.join('\n');
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

function headingSlug(text) {
  return String(text)
    .trim()
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
}

function parseHeadings(masked) {
  const headings = [];
  masked.split('\n').forEach((line, index) => {
    const match = line.match(/^(#{1,6})\s+(.*?)\s*$/);
    if (!match) return;
    const text = match[2].replace(/\s*#+\s*$/, '').trim();
    headings.push({
      level: match[1].length,
      text,
      line: index + 1,
      slug: headingSlug(text),
    });
  });
  return headings;
}

function buildOutline(headings) {
  const outline = [];
  const stack = [];
  for (const heading of headings) {
    const node = { ...heading, children: [] };
    while (stack.length && stack[stack.length - 1].level >= node.level) stack.pop();
    if (stack.length) stack[stack.length - 1].children.push(node);
    else outline.push(node);
    stack.push(node);
  }
  return outline;
}

function parseMath(masked) {
  const found = [];

  // 先吃掉块级公式，避免 $$…$$ 被当成两个行内公式
  const withoutDisplay = masked.replace(/\$\$([\s\S]+?)\$\$/g, (match, tex, offset) => {
    found.push({ type: 'display', tex: tex.trim(), line: lineOf(masked, offset) });
    return blankOut(match);
  });

  withoutDisplay.replace(/(?<!\$)\$(?!\$)((?:\\.|[^$\n])+?)\$(?!\$)/g, (match, tex, offset) => {
    found.push({ type: 'inline', tex: tex.trim(), line: lineOf(withoutDisplay, offset) });
    return match;
  });

  found.sort((a, b) => a.line - b.line);
  return {
    inline: found.filter((item) => item.type === 'inline').length,
    display: found.filter((item) => item.type === 'display').length,
    total: found.length,
    expressions: found,
  };
}

function parseMedia(masked) {
  const images = [];
  const withoutImages = masked.replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g,
    (match, alt, url, title) => {
      images.push(title === undefined ? { alt, url } : { alt, url, title });
      return blankOut(match);
    },
  );

  const links = [];
  withoutImages.replace(
    /\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g,
    (match, text, url, title) => {
      links.push(title === undefined ? { text, url } : { text, url, title });
      return match;
    },
  );

  return { images, links };
}

function parseCode(text) {
  const lines = String(text ?? '').split('\n');
  const blocks = [];
  let current = null;

  for (const line of lines) {
    const open = line.match(/^\s*(`{3,}|~{3,})\s*([^\s`]*)\s*$/);
    if (!current && open) {
      current = { language: open[2] || '', body: [] };
      continue;
    }
    if (current && /^\s*(`{3,}|~{3,})/.test(line)) {
      blocks.push(current);
      current = null;
      continue;
    }
    if (current) current.body.push(line);
  }
  if (current) blocks.push(current);

  return {
    fences: blocks.length,
    blocks: blocks.map((block) => ({
      language: block.language,
      lines: block.body.length,
      characters: block.body.join('\n').length,
    })),
  };
}

function parseTasks(masked) {
  const items = masked.match(/^\s*[-*+]\s+\[([ xX])\]\s+/gm) ?? [];
  const checked = items.filter((item) => /\[[xX]\]/.test(item)).length;
  return { total: items.length, checked, unchecked: items.length - checked };
}

function parseTables(masked) {
  const separators = masked.match(/^\s*\|?(\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/gm) ?? [];
  return separators.length;
}

function parseStats(text) {
  const value = String(text ?? '');
  const { words, latinWords, cjkCharacters } = countWords(value);
  const lines = value.length ? value.split('\n') : [];
  const paragraphs = value.split(/\n\s*\n/).filter((block) => block.trim() !== '');
  return {
    characters: value.length,
    charactersNoSpaces: value.replace(/\s/g, '').length,
    words,
    cjkCharacters,
    latinWords,
    lines: lines.length,
    nonEmptyLines: lines.filter((line) => line.trim() !== '').length,
    paragraphs: paragraphs.length,
    readingMinutes: Math.max(1, Math.ceil(cjkCharacters / 300 + latinWords / 200)),
  };
}

/* ------------------------------------------------------------------ */
/* 主入口                                                              */
/* ------------------------------------------------------------------ */

/**
 * 计算一份笔记的基础数据。
 *
 * @param {string} markdown 笔记正文
 * @param {{ filename?: string, createdAt?: string|null, updatedAt?: string|null,
 *           savedAt?: string|null, ai?: Array<object> }} [options]
 * @returns {object} 可直接序列化为 `<name>.json` 的元数据
 */
export function analyzeDocument(markdown, options = {}) {
  const { filename = 'note', createdAt = null, updatedAt = null, savedAt = null, ai = [] } = options;
  const text = String(markdown ?? '');
  const masked = maskCode(text);

  const headings = parseHeadings(masked);
  const stats = parseStats(text);
  const baseName = slugifyFilename(filename);

  return {
    schema: SCHEMA,
    generator: { ...GENERATOR },
    file: {
      name: `${baseName}.md`,
      baseName,
      extension: '.md',
      mimeType: 'text/markdown; charset=utf-8',
      encoding: 'utf-8',
      bytes: Buffer.byteLength(text, 'utf8'),
      lines: stats.lines,
      sha256: hashText(text),
    },
    title: headings.length ? headings[0].text : '',
    stats,
    structure: {
      maxDepth: headings.reduce((max, heading) => Math.max(max, heading.level), 0),
      headings,
      outline: buildOutline(headings),
    },
    math: parseMath(masked),
    media: parseMedia(masked),
    code: parseCode(text),
    tables: parseTables(masked),
    tasks: parseTasks(masked),
    timestamps: { createdAt, updatedAt, savedAt },
    ai: { conversions: Array.isArray(ai) ? ai.map((item) => ({ ...item })) : [] },
  };
}
