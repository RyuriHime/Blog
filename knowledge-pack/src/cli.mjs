#!/usr/bin/env node
/**
 * 知识整理 CLI：输入一篇种子文档 + 一个目录，输出标签与知识网络图 JSON。
 *
 *   node src/cli.mjs --seed <文档> --dir <目录> [--out <输出目录>] [更多选项]
 *   node src/cli.mjs --help
 *
 * 产物（写入 --out，默认 <目录>/../knowledge-out）：
 *   manifest.json   本次运行的参数与统计
 *   documents.json  每个文件的关键词、标签、相关度
 *   tags.json       标签 → 文件倒排索引 + 标签共现
 *   graph.json      知识网络图（完整）
 *   graph.compact.json  精简图（可视化用）
 *   README.md       本次产物的说明
 *   viewer.html     单文件可视化（打开即可看，不需要服务器）
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDocument, scanDirectory, DEFAULT_EXCLUDES } from './scan.mjs';
import { extractKeywords, relevanceToSeed, seedKeywords, pairwiseSimilarity, explainEdge, vocabularyQuality } from './keywords.mjs';
import { assignTags, buildTagIndex, selectRelated } from './tags.mjs';
import { buildGraph, graphStats, detectCommunities, toCompact, EDGE_TYPES, NODE_TYPES } from './graph.mjs';
import { renderReportMarkdown, renderViewerHtml } from './report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, '..');

const DEFAULTS = {
  extensions: ['.md', '.markdown', '.mdx', '.txt'],
  excludes: DEFAULT_EXCLUDES,
  topKeywords: 12,
  seedKeywords: 12,
  maxTags: 8,
  minDf: 2,
  maxDfRatio: 0.5,
  similarity: 0.12,
  minScore: 0.08,
  maxFiles: 2000,
  maxDepth: 12,
  out: null,
  quiet: false,
};

const HELP = `知识整理：文档关键词 → 全量检索打标签 → 知识网络图 JSON

用法
  node src/cli.mjs --seed <种子文档> --dir <待扫描目录> [选项]

必填
  --seed <file>        种子文档（要分析主题的那一篇，.md/.txt）
  --dir <dir>          要扫描的全部文件所在目录

选项
  --out <dir>          产物输出目录，默认 <dir>/../knowledge-out
  --ext <a,b,c>        参与扫描的扩展名，默认 .md,.markdown,.mdx,.txt
  --exclude <a,b>      额外排除的目录名（默认已含 node_modules/.git/dist/build/data 等）
  --top-keywords <n>   每篇文件保留的关键词数，默认 ${DEFAULTS.topKeywords}
  --seed-keywords <n>  种子文档抽取的主题词数，默认 ${DEFAULTS.seedKeywords}
  --max-tags <n>       每篇文件最多标签数，默认 ${DEFAULTS.maxTags}
  --min-df <n>         词项至少出现在几篇文档里才算关键词，默认 ${DEFAULTS.minDf}
  --max-df-ratio <r>   词项出现在超过该比例文档时丢弃，默认 ${DEFAULTS.maxDfRatio}
  --similarity <r>     文件之间建立相似边的余弦阈值，默认 ${DEFAULTS.similarity}
  --min-score <r>      判定为「与种子相关」的最低相关度，默认 ${DEFAULTS.minScore}
  --max-files <n>      最多扫描文件数，默认 ${DEFAULTS.maxFiles}
  --max-depth <n>      最大递归深度，默认 ${DEFAULTS.maxDepth}
  --quiet              少打印日志
  --help               显示本帮助

示例
  node src/cli.mjs --seed README.md --dir . --out ../knowledge-out
  node src/cli.mjs --seed docs/spec.md --dir docs --ext .md --similarity 0.2
`;

/** 极简参数解析：只支持 --key value 与 --flag。 */
export function parseArgs(argv = []) {
  const options = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      rest.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (key === 'help' || key === 'quiet') {
      options[key] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`参数 --${key} 缺少取值`);
    }
    options[key] = value;
    i += 1;
  }
  return { options, rest };
}

function toNumber(value, fallback, { min = -Infinity, max = Infinity, name }) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`参数 ${name} 需要是数字，收到 "${value}"`);
  if (parsed < min || parsed > max) throw new Error(`参数 ${name} 超出范围 [${min}, ${max}]：${parsed}`);
  return parsed;
}

export function normalizeOptions(options, { cwd = process.cwd() } = {}) {
  if (!options.seed) throw new Error('缺少必填参数 --seed（要分析主题的那篇文档）');
  if (!options.dir) throw new Error('缺少必填参数 --dir（要扫描的目录）');

  const seed = resolve(cwd, options.seed);
  const dir = resolve(cwd, options.dir);
  const out = resolve(cwd, options.out ?? join(dir, '..', 'knowledge-out'));
  const extensions = options.ext
    ? String(options.ext)
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean)
        .map((item) => (item.startsWith('.') ? item : `.${item}`))
    : DEFAULTS.extensions;
  const extraExcludes = options.exclude
    ? String(options.exclude)
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    : [];

  return {
    seed,
    dir,
    out,
    extensions,
    excludes: [...new Set([...DEFAULTS.excludes, ...extraExcludes])],
    topKeywords: toNumber(options['top-keywords'], DEFAULTS.topKeywords, { min: 1, max: 200, name: '--top-keywords' }),
    seedKeywordCount: toNumber(options['seed-keywords'], DEFAULTS.seedKeywords, { min: 1, max: 200, name: '--seed-keywords' }),
    maxTags: toNumber(options['max-tags'], DEFAULTS.maxTags, { min: 1, max: 50, name: '--max-tags' }),
    minDf: toNumber(options['min-df'], DEFAULTS.minDf, { min: 1, max: 1000, name: '--min-df' }),
    maxDfRatio: toNumber(options['max-df-ratio'], DEFAULTS.maxDfRatio, { min: 0.01, max: 1, name: '--max-df-ratio' }),
    similarity: toNumber(options.similarity, DEFAULTS.similarity, { min: 0, max: 1, name: '--similarity' }),
    minScore: toNumber(options['min-score'], DEFAULTS.minScore, { min: 0, max: 1, name: '--min-score' }),
    maxFiles: toNumber(options['max-files'], DEFAULTS.maxFiles, { min: 1, max: 100000, name: '--max-files' }),
    maxDepth: toNumber(options['max-depth'], DEFAULTS.maxDepth, { min: 0, max: 100, name: '--max-depth' }),
    quiet: Boolean(options.quiet),
  };
}

const log = (quiet, ...args) => {
  if (!quiet) console.log(...args);
};

/**
 * 主流程。可被当作库调用：runKnowledgePack({ seed, dir, out, ... })
 * @returns {Promise<{ out: string, manifest: object, files: string[] }>}
 */
export async function runKnowledgePack(rawOptions, { cwd = process.cwd() } = {}) {
  const startedAt = Date.now();
  const options = normalizeOptions(rawOptions, { cwd });

  log(options.quiet, `▶ 读取种子文档: ${options.seed}`);
  const seedDoc = await readDocument(options.seed);

  log(options.quiet, `▶ 扫描目录: ${options.dir}`);
  const { documents, skipped } = await scanDirectory({
    dir: options.dir,
    extensions: options.extensions,
    excludes: options.excludes,
    maxFiles: options.maxFiles,
    maxDepth: options.maxDepth,
  });
  log(options.quiet, `  收集到 ${documents.length} 个文件${skipped.length ? `，跳过 ${skipped.length} 个` : ''}`);

  // 种子文档若在扫描范围内，用同一份内容，避免重复计算
  const seedInCorpus = documents.find((doc) => resolve(doc.absolutePath) === options.seed);
  const seed = seedInCorpus ?? { ...seedDoc, id: 'seed', path: relative(options.dir, options.seed).split(sep).join('/') || seedDoc.path };

  const allDocs = seedInCorpus ? documents : [seed, ...documents];
  log(options.quiet, '▶ 统计 TF-IDF 与关键词');
  const model = extractKeywords(allDocs, { topPerDoc: options.topKeywords, minDf: options.minDf, maxDfRatio: options.maxDfRatio });

  const seeds = seedKeywords(seed, model, { top: options.seedKeywordCount });
  log(options.quiet, `  种子主题词: ${seeds.map((item) => item.term).join(' / ')}`);

  const similarityEdges = pairwiseSimilarity(documents, model, { threshold: options.similarity });
  log(options.quiet, `▶ 计算相关度与标签（相似边 ${similarityEdges.length} 条）`);

  const entries = documents.map((doc) => {
    const keywords = model.perDoc.get(doc.id) ?? [];
    const relevance = relevanceToSeed(doc, model, seeds, seed.id);
    const { tags, primaryTag, confidence } = assignTags({ doc, seeds, keywords, relevance }, { maxTags: options.maxTags });
    return {
      id: doc.id,
      path: doc.path,
      title: doc.title,
      chars: doc.structure.chars,
      structure: doc.structure,
      frontMatter: doc.frontMatter,
      links: doc.links,
      keywords,
      relevance,
      tags,
      primaryTag,
      confidence,
      community: null,
    };
  });

  // 种子文档自身不进 entries（它是查询起点）；如果语料里包含它，也不要重复列出来
  const fileEntries = entries.filter((entry) => entry.id !== seed.id);

  const tagIndex = buildTagIndex(fileEntries);
  const { related, weak } = selectRelated(fileEntries, { minScore: options.minScore });

  const graph = buildGraph(
    {
      seed: { ...seed, keywords: seeds, chars: seed.structure?.chars ?? seed.text?.length ?? 0 },
      entries: fileEntries,
      similarityEdges,
      tagIndex,
      helpers: { explain: (from, to) => explainEdge(model, from, to) },
    },
    { useTagNodes: true },
  );

  const communities = detectCommunities(graph);
  for (const entry of fileEntries) entry.community = communities.get(`doc:${entry.id}`) ?? null;

  const stats = graphStats(graph);
  const communitySummary = summarizeCommunities(communities, fileEntries, graph);
  const quality = {
    fileKeywords: vocabularyQuality(fileEntries.flatMap((entry) => entry.keywords)),
    seedKeywords: vocabularyQuality(seeds),
  };

  const manifest = {
    generator: 'knowledge-pack',
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    options: {
      seed: relative(options.dir, options.seed).split(sep).join('/') || options.seed,
      seedAbsolute: options.seed,
      dir: options.dir,
      out: options.out,
      extensions: options.extensions,
      excludes: options.excludes,
      topKeywords: options.topKeywords,
      seedKeywordCount: options.seedKeywordCount,
      maxTags: options.maxTags,
      minDf: options.minDf,
      maxDfRatio: options.maxDfRatio,
      similarity: options.similarity,
      minScore: options.minScore,
      maxFiles: options.maxFiles,
      maxDepth: options.maxDepth,
    },
    seed: {
      id: seed.id,
      path: seed.path,
      title: seed.title,
      chars: seed.structure?.chars ?? 0,
      keywords: seeds,
    },
    counts: {
      scannedFiles: documents.length,
      analyzedFiles: fileEntries.length,
      related: related.length,
      weak: fileEntries.length - related.length,
      tags: tagIndex.tags.length,
      tagPairs: tagIndex.cooccurrence.length,
      nodes: stats.nodes,
      edges: stats.edges,
      communities: communitySummary.length,
      connectedComponents: stats.components,
      skipped: skipped.length,
    },
    graphStats: stats,
    quality,
    communities: communitySummary,
    skipped: skipped.slice(0, 50),
    outputs: [
      'manifest.json',
      'documents.json',
      'tags.json',
      'graph.json',
      'graph.compact.json',
      'README.md',
      'viewer.html',
    ],
  };

  const documentsPayload = {
    seed: { id: seed.id, path: seed.path, title: seed.title, keywords: seeds },
    summary: {
      analyzed: fileEntries.length,
      related: related.length,
      byConfidence: countBy(fileEntries, (entry) => entry.confidence),
    },
    related: related.map(toDocumentRecord),
    weak: weak.map(toDocumentRecord),
  };

  const tagsPayload = {
    tags: tagIndex.tags,
    cooccurrence: tagIndex.cooccurrence.slice(0, 500),
    stats: {
      total: tagIndex.tags.length,
      singleUse: tagIndex.tags.filter((tag) => tag.count === 1).length,
      mostUsed: tagIndex.tags.slice(0, 10).map((tag) => ({ tag: tag.tag, count: tag.count })),
    },
  };

  const graphPayload = {
    directed: false,
    nodeTypes: NODE_TYPES,
    edgeTypes: EDGE_TYPES,
    seedId: `seed:${seed.id}`,
    ...graph,
  };

  const compactPayload = {
    seedId: `seed:${seed.id}`,
    nodeTypes: NODE_TYPES,
    edgeTypes: EDGE_TYPES,
    communities: communitySummary.map((item) => ({ id: item.id, size: item.size, topTags: item.topTags })),
    ...toCompact(graph, communities),
  };

  await mkdir(options.out, { recursive: true });
  const files = [];
  const write = async (name, data, asJson = true) => {
    const target = join(options.out, name);
    await writeFile(target, asJson ? `${JSON.stringify(data, null, 2)}\n` : data, 'utf8');
    files.push(target);
    log(options.quiet, `  ✔ ${name}`);
  };

  await write('manifest.json', manifest);
  await write('documents.json', documentsPayload);
  await write('tags.json', tagsPayload);
  await write('graph.json', graphPayload);
  await write('graph.compact.json', compactPayload);
  await write('README.md', renderReportMarkdown({ manifest, tags: tagIndex, related, weak, communities: communitySummary }), false);
  await write('viewer.html', renderViewerHtml({ compact: compactPayload, manifest }), false);

  log(options.quiet, `\n完成：${options.out}（${files.length} 个文件，用时 ${manifest.durationMs}ms）`);
  return { out: options.out, manifest, files, related, weak, tags: tagIndex, graph, compact: compactPayload };
}

function toDocumentRecord(entry) {
  return {
    id: entry.id,
    path: entry.path,
    title: entry.title,
    relevance: entry.relevance.score,
    confidence: entry.confidence,
    matchedKeywords: entry.relevance.matched.map((item) => item.term),
    keywords: entry.keywords.map((item) => item.term),
    tags: entry.tags.map((tag) => tag.tag),
    tagDetail: entry.tags,
    primaryTag: entry.primaryTag,
    community: entry.community,
    chars: entry.chars,
    links: entry.links,
    frontMatter: entry.frontMatter,
  };
}

function countBy(items, keyOf) {
  const out = {};
  for (const item of items) {
    const key = keyOf(item);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

function summarizeCommunities(communities, entries, graph) {
  const groups = new Map();
  for (const entry of entries) {
    const id = communities.get(`doc:${entry.id}`);
    if (id === undefined) continue;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(entry);
  }
  return [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([id, members]) => {
      const tagWeight = new Map();
      for (const member of members) {
        for (const tag of member.tags) tagWeight.set(tag.tag, (tagWeight.get(tag.tag) ?? 0) + tag.score);
      }
      return {
        id,
        size: members.length,
        topTags: [...tagWeight.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([tag]) => tag),
        files: members
          .slice()
          .sort((a, b) => b.relevance.score - a.relevance.score)
          .slice(0, 12)
          .map((member) => ({ id: member.id, title: member.title, relevance: member.relevance.score })),
      };
    });
}

/* ------------------------------------------------------------------ */
/* CLI 入口                                                            */
/* ------------------------------------------------------------------ */

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const { options } = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    process.exit(0);
  }
  try {
    await runKnowledgePack(options, { cwd: process.cwd() });
  } catch (error) {
    console.error(`\n[错误] ${error.message}`);
    console.error('用 --help 查看可用参数。');
    process.exit(1);
  }
}

export { DEFAULTS, HELP, PKG_ROOT };
