/**
 * 结构分析：块数组 → 大纲树 / 章节表 / 标题候选 / 统计。
 *
 * 纯函数、确定性：同样的块永远得到同样的结构，方便前端把结果缓存起来做 diff。
 * 构树用显式栈（不用递归），层级跳跃（h1 → h3）**不**补空节点 ——
 * 补出来的空章节会污染大纲，宁可让 level 如实为 3。
 */
import { countBlocks } from './blocks.mjs';

const STOP_WORDS = ['的', '了', '是', '和', '与', '在', '一个', '我们', '可以', '这个', '那个', '以及', '因为', '所以', '但是'];

const LEAD_SENTENCE_LIMIT = 40;
const MAX_TITLE_CANDIDATES = 5;

function node(heading) {
  return { blockId: heading?.id ?? null, level: heading?.level ?? 0, text: heading?.text ?? '（开头）', children: [], blockIds: [] };
}

/**
 * 大纲树 + 树上的块归属。
 *
 * 用合成根（level 0）统一处理"标题之前的孤立正文"：所有块都先挂到**最内层**那个
 * 以它前面最近的标题为界的节点上，再自底向上把子节点的 blockIds 并进父节点。
 * 于是"第一章"的 range 天然覆盖 1.1、1.1.1 及其正文 —— 这正是 replace/delete
 * 这类整节操作需要的语义。合成根永远不返回给调用方，它的 children 才是 tree。
 */
function buildTree(blocks) {
  const synthetic = node(null);
  const stack = [synthetic];

  for (const block of blocks) {
    if (block.type === 'heading') {
      const level = Number(block.level) || 1;
      while (stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop();
      const created = node({ ...block, level });
      const parent = stack[stack.length - 1];
      // 标题块同时属于父节点的 range（父节点只统计到下一个同级标题之前，含子标题本身）
      parent.blockIds.push(block.id);
      parent.children.push(created);
      stack.push(created);
      continue;
    }
    stack[stack.length - 1].blockIds.push(block.id);
  }

  for (const child of synthetic.children) collect(child);
  // 合成根也是顶层节点、还会被返回给调用方，但它**不能**再跑一遍 collect：
  // 那会把已经并好的子章节 range 重复追加一次。它的 range = 自己的孤立正文 + 直接子节点的 range。
  collect(synthetic, { descendantsDone: true });

  // 合成根带孤立正文时把它放回顶层（tree[0]）。注意用展开而不是 unshift：
  // unshift 会就地改 synthetic.children，让 tree 里出现两份章节。
  return synthetic.blockIds.length > 0 ? [synthetic, ...synthetic.children] : [...synthetic.children];

  function collect(item, { descendantsDone = false } = {}) {
    const nested = [];
    if (!descendantsDone) {
      for (const child of item.children) {
        collect(child);
        nested.push(...child.blockIds);
      }
    } else {
      for (const child of item.children) nested.push(...child.blockIds);
    }
    item.blockIds = [...item.blockIds, ...nested];
  }
}

function flatten(nodes, blocksById, out = []) {
  for (const item of nodes) {
    const charCount = item.blockIds.reduce((sum, id) => sum + (blocksById.get(id)?.text?.length ?? 0), 0);
    out.push({ heading: item.text, level: item.level, blockCount: item.blockIds.length, charCount });
    flatten(item.children, blocksById, out);
  }
  return out;
}

/** 最大标题层级（合成根的 level 0 不算）。 */
function treeDepth(nodes) {
  let depth = 0;
  for (const item of nodes) depth = Math.max(depth, item.level, treeDepth(item.children));
  return depth;
}

/** 首段首句：按中英文句号/问号/感叹号切，取第一段带文字的段落。 */
function leadSentence(blocks) {
  for (const block of blocks) {
    if (block.type !== 'paragraph' && block.type !== 'list') continue;
    const text = String(block.text ?? '').replace(/\s+/g, ' ').trim();
    if (text.length === 0) continue;
    const sentence = /^[^。！？.!?]+[。！？.!?]?/.exec(text)?.[0] ?? text;
    const trimmed = sentence.trim();
    return trimmed.length > LEAD_SENTENCE_LIMIT ? `${trimmed.slice(0, LEAD_SENTENCE_LIMIT)}…` : trimmed;
  }
  return '';
}

/** 出现最多的实词（长度 ≥2、非停用词）。中文没有分词，按 2–6 字的连续汉字片 + 英文单词取。 */
function frequentTerm(blocks) {
  const counts = new Map();
  for (const block of blocks) {
    if (block.type !== 'paragraph' && block.type !== 'heading' && block.type !== 'list') continue;
    const text = String(block.text ?? '');
    for (const match of text.matchAll(/[A-Za-z][A-Za-z0-9-]{1,}/g)) bump(match[0].toLowerCase());
    for (const match of text.matchAll(/[\u4e00-\u9fa5]{2,}/g)) {
      const run = match[0];
      for (let size = 2; size <= Math.min(4, run.length); size += 1) {
        for (let start = 0; start + size <= run.length; start += 1) bump(run.slice(start, start + size));
      }
    }
  }

  let best = '';
  let bestCount = 0;
  for (const [term, count] of counts) {
    if (count > bestCount || (count === bestCount && term.length > best.length)) {
      best = term;
      bestCount = count;
    }
  }
  return bestCount >= 2 ? best : '';

  function bump(term) {
    if (term.length < 2 || STOP_WORDS.includes(term)) return;
    counts.set(term, (counts.get(term) ?? 0) + 1);
  }
}

/** 标题候选：按分数降序，同一文本只留最高分那条。 */
function titleCandidates(blocks, headings) {
  const scored = [];
  const firstH1 = headings.find((heading) => heading.level === 1);
  if (firstH1) scored.push({ text: firstH1.text, reason: 'h1', score: 60 });
  else if (headings.length > 0) scored.push({ text: headings[0].text, reason: 'first-heading', score: 40 });

  const lead = leadSentence(blocks);
  if (lead) scored.push({ text: lead, reason: 'lead-sentence', score: 20 });

  const term = frequentTerm(blocks);
  if (term) scored.push({ text: term, reason: 'frequent-term', score: 10 });

  const best = new Map();
  for (const candidate of scored) {
    const text = candidate.text.trim();
    if (text.length === 0) continue;
    const existing = best.get(text);
    if (!existing || candidate.score > existing.score) best.set(text, { ...candidate, text });
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, MAX_TITLE_CANDIDATES);
}

/**
 * @param {Array<object>} blocks
 * @returns {{ headings: Array<object>, tree: Array<object>, sections: Array<object>, titleCandidates: Array<object>, stats: object }}
 */
export function analyzeStructure(blocks) {
  const list = Array.isArray(blocks) ? blocks.filter(Boolean) : [];
  const headings = list.filter((block) => block.type === 'heading').map((block) => ({ blockId: block.id, level: Number(block.level) || 1, text: String(block.text ?? '') }));

  const tree = buildTree(list);
  const blocksById = new Map(list.map((block) => [block.id, block]));
  const counted = countBlocks(list);
  // sections 只展平真正的章节；"（开头）"合成节点不是章节，不进目录
  const sectionRoots = tree.filter((item) => item.blockId !== null);

  return {
    headings,
    tree,
    sections: flatten(sectionRoots, blocksById),
    titleCandidates: titleCandidates(list, headings),
    stats: {
      blocks: counted.total,
      headings: headings.length,
      paragraphs: counted.byType.paragraph ?? 0,
      codeBlocks: counted.byType.code ?? 0,
      tables: counted.byType.table ?? 0,
      formulas: counted.byType.formula ?? 0,
      images: counted.byType.image ?? 0,
      chars: list.reduce((sum, block) => sum + String(block.text ?? '').length, 0),
      maxDepth: treeDepth(tree),
    },
  };
}
