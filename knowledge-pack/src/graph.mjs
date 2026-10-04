/**
 * 知识网络图：把「种子文档 / 所有文件 / 标签」建成节点，把
 * 「种子→文件（相关）」「文件↔文件（相似 / 显式引用）」「标签↔标签（共现）」建成边。
 *
 * 可单独复用：
 *   import { buildGraph, graphStats, toCompact } from './graph.mjs'
 */

export const EDGE_TYPES = {
  seed_topic: '种子主题匹配',
  similar: '内容相似',
  explicit_link: '文档内显式引用',
  tagged: '文档带有该标签',
  tag_cooccurrence: '标签共现',
};

export const NODE_TYPES = {
  seed: '种子文档',
  document: '文档',
  tag: '标签',
  external: '范围外被引用文件',
};

const number = (value, digits = 4) => Number(Number(value ?? 0).toFixed(digits));

/**
 * @param {object} args
 * @param {object} args.seed                  种子文档（含 id/title/keywords）
 * @param {Array<object>} args.entries        每个文件的分析结果
 * @param {Array<{from:string,to:string,similarity:number}>} args.similarityEdges
 * @param {Array<object>} args.tagIndex       标签索引（来自 buildTagIndex）
 * @param {{ explain?: (from:string,to:string)=>Array<{term:string,weight:number}> }} [args.helpers]
 * @param {{ useTagNodes?: boolean, maxTagEdges?: number, explicitLinkType?: string }} [options]
 */
export function buildGraph(
  { seed, entries, similarityEdges = [], tagIndex = { tags: [], cooccurrence: [] }, helpers = {} },
  { useTagNodes = true, maxTagEdges = 400 } = {},
) {
  const nodes = [];
  const edges = [];

  /* ---- 种子节点 ---- */
  nodes.push({
    id: `seed:${seed.id}`,
    type: 'seed',
    label: seed.title,
    path: seed.path,
    keywords: (seed.keywords ?? []).map((item) => item.term),
    meta: { chars: seed.chars ?? 0, keywordCount: (seed.keywords ?? []).length },
  });

  /* ---- 文档节点 ---- */
  for (const entry of entries) {
    nodes.push({
      id: `doc:${entry.id}`,
      type: 'document',
      label: entry.title,
      path: entry.path,
      tags: entry.tags.map((tag) => tag.tag),
      keywords: entry.keywords.map((item) => item.term),
      relevance: entry.relevance.score,
      confidence: entry.confidence,
      meta: {
        chars: entry.chars,
        matchedKeywords: entry.relevance.matched.map((item) => item.term),
        structure: entry.structure,
      },
    });

    if (entry.relevance.score > 0) {
      edges.push({
        id: `seed:${seed.id}->doc:${entry.id}`,
        from: `seed:${seed.id}`,
        to: `doc:${entry.id}`,
        type: 'seed_topic',
        directed: true,
        weight: entry.relevance.score,
        reason: `命中 ${entry.relevance.matchedCount} 个种子关键词`,
        evidence: {
          keywords: entry.relevance.matched.map((item) => item.term),
          keywordScore: entry.relevance.keywordScore,
          cosineScore: entry.relevance.cosineScore,
        },
      });
    }
  }

  /* ---- 文件之间的相似边 ---- */
  // 相似度计算包含了种子文档，这里要把指向它的端点改写成种子节点，否则会出现悬空边
  const seedNodeId = `seed:${seed.id}`;
  const docNodeId = (id) => (id === seed.id ? seedNodeId : `doc:${id}`);
  const seenSimilar = new Set();
  for (const edge of similarityEdges) {
    const fromId = docNodeId(edge.from);
    const toId = docNodeId(edge.to);
    if (fromId === toId) continue;
    const key = [fromId, toId].sort().join('|');
    if (seenSimilar.has(key)) continue;
    seenSimilar.add(key);
    edges.push({
      id: `${fromId}<->${toId}`,
      from: fromId,
      to: toId,
      type: 'similar',
      directed: false,
      weight: edge.similarity,
      reason: 'TF-IDF 向量余弦相似',
      evidence: { sharedTerms: helpers.explain ? helpers.explain(edge.from, edge.to) : [] },
    });
  }

  /* ---- 文档内显式引用 ---- */
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const byStem = new Map();
  for (const entry of entries) {
    const stem = entry.path.replace(/\.[^.]+$/, '').toLowerCase();
    byStem.set(stem, entry.id);
    byStem.set(stem.split('/').pop(), entry.id);
  }
  // 种子文档也在语料里出现过的话，引用它要落到种子节点上，而不是新建一个外部节点
  const seedStem = String(seed.path ?? seed.id).replace(/\.[^.]+$/, '').toLowerCase();
  byId.set(seed.id, seed.id);
  byStem.set(seedStem, seed.id);
  byStem.set(seedStem.split('/').pop(), seed.id);
  const known = new Set(nodes.map((node) => node.id));
  const externals = new Set();
  for (const entry of entries) {
    for (const link of entry.links ?? []) {
      const cleaned = String(link).replace(/^\.\//, '').split('#')[0].trim();
      if (!cleaned || /^[a-z]+:\/\//i.test(cleaned)) continue;
      const stem = cleaned.replace(/\.[^.]+$/, '').toLowerCase();
      const target = byId.has(cleaned) ? cleaned : byStem.get(stem) ?? byStem.get(stem.split('/').pop());
      const targetId = target ? docNodeId(target) : `external:${cleaned}`;
      if (targetId === `doc:${entry.id}`) continue;

      // 指向扫描范围之外的文件时补一个外部节点，保证边两端都存在
      if (!known.has(targetId)) {
        known.add(targetId);
        externals.add(cleaned);
        nodes.push({
          id: targetId,
          type: 'external',
          label: cleaned,
          tags: [],
          keywords: [],
          meta: { external: true, reason: '被文档引用但不在扫描范围内' },
        });
      }

      edges.push({
        id: `doc:${entry.id}->${targetId}`,
        from: `doc:${entry.id}`,
        to: targetId,
        type: 'explicit_link',
        directed: true,
        weight: 1,
        reason: '文档内写明了引用',
        evidence: { link: cleaned, external: !target },
      });
    }
  }

  /* ---- 标签节点与共现边 ---- */
  if (useTagNodes) {
    const limitedTags = tagIndex.tags.slice(0, 120);
    const tagSet = new Set(limitedTags.map((tag) => tag.tag));
    for (const tag of limitedTags) {
      nodes.push({
        id: `tag:${tag.tag}`,
        type: 'tag',
        label: tag.tag,
        meta: { count: tag.count, weight: tag.weight, sources: tag.sources },
      });
      for (const file of tag.files.slice(0, 100)) {
        edges.push({
          id: `doc:${file}->tag:${tag.tag}`,
          from: `doc:${file}`,
          to: `tag:${tag.tag}`,
          type: 'tagged',
          directed: true,
          weight: 1,
          reason: '该文件带有此标签',
          evidence: {},
        });
      }
    }
    for (const pair of tagIndex.cooccurrence) {
      if (!tagSet.has(pair.from) || !tagSet.has(pair.to)) continue;
      edges.push({
        id: `tag:${pair.from}<->tag:${pair.to}`,
        from: `tag:${pair.from}`,
        to: `tag:${pair.to}`,
        type: 'tag_cooccurrence',
        directed: false,
        weight: number(pair.count / Math.max(1, limitedTags.length), 6),
        reason: `共同出现在 ${pair.count} 个文件`,
        evidence: { count: pair.count, files: pair.files },
      });
      if (edges.length > 20000 + maxTagEdges) break;
    }
  }

  return { nodes, edges };
}

/** 图统计：度数、密度、连通分量（只看文件节点）、标签社区。 */
export function graphStats(graph) {
  const adjacency = new Map();
  for (const node of graph.nodes) adjacency.set(node.id, new Set());
  for (const edge of graph.edges) {
    adjacency.get(edge.from)?.add(edge.to);
    adjacency.get(edge.to)?.add(edge.from);
  }

  const degrees = [...adjacency.entries()]
    .map(([id, neighbours]) => ({ id, degree: neighbours.size }))
    .sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id));

  const documentIds = graph.nodes.filter((node) => node.type === 'seed' || node.type === 'document').map((node) => node.id);
  const seen = new Set();
  const components = [];
  for (const id of documentIds) {
    if (seen.has(id)) continue;
    const stack = [id];
    const component = [];
    seen.add(id);
    while (stack.length) {
      const current = stack.pop();
      component.push(current);
      for (const neighbour of adjacency.get(current) ?? []) {
        if (seen.has(neighbour)) continue;
        seen.add(neighbour);
        stack.push(neighbour);
      }
    }
    components.push(component.sort());
  }
  components.sort((a, b) => b.length - a.length);

  const nodeCount = graph.nodes.length;
  const possible = (nodeCount * (nodeCount - 1)) / 2 || 1;

  return {
    nodes: nodeCount,
    edges: graph.edges.length,
    nodesByType: countBy(graph.nodes, (node) => node.type),
    edgesByType: countBy(graph.edges, (edge) => edge.type),
    density: number(graph.edges.length / possible, 6),
    topByDegree: degrees.slice(0, 10),
    components: components.length,
    componentSizes: components.slice(0, 10).map((component) => component.length),
    isolates: degrees.filter((item) => item.degree === 0).map((item) => item.id),
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

/**
 * 轻量社区划分（确定性标签传播）：只用文件之间的相似边，给每个文件一个社区号。
 * @returns {Map<string, number>} nodeId → community
 */
export function detectCommunities(graph, { iterations = 12 } = {}) {
  const labels = new Map();
  const order = [];
  for (const node of graph.nodes) {
    if (node.type === 'tag' || node.type === 'external') continue;
    labels.set(node.id, node.id);
    order.push(node.id);
  }
  order.sort();

  // 邻接表按全部节点建立，外部引用节点也要出现在社区图里（只是不参与标签传播）
  const adjacency = new Map(graph.nodes.map((node) => [node.id, []]));
  for (const edge of graph.edges) {
    if (!adjacency.has(edge.from) || !adjacency.has(edge.to)) continue;
    if (edge.type === 'explicit_link' || edge.type === 'tagged') continue;
    adjacency.get(edge.from).push({ id: edge.to, weight: edge.weight });
    adjacency.get(edge.to).push({ id: edge.from, weight: edge.weight });
  }

  for (let round = 0; round < iterations; round += 1) {
    let changed = false;
    for (const id of order) {
      const tally = new Map();
      for (const neighbour of adjacency.get(id) ?? []) {
        const label = labels.get(neighbour.id);
        tally.set(label, (tally.get(label) ?? 0) + neighbour.weight);
      }
      if (tally.size === 0) continue;
      let best = labels.get(id);
      let bestWeight = -1;
      for (const [label, weight] of [...tally.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        if (weight > bestWeight) {
          best = label;
          bestWeight = weight;
        }
      }
      if (best !== labels.get(id)) {
        labels.set(id, best);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // 归一化成 1..n 的社区号，按社区大小降序
  const groups = new Map();
  for (const [id, label] of labels) {
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(id);
  }
  const ordered = [...groups.values()].sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
  const result = new Map();
  ordered.forEach((members, index) => {
    for (const id of members) result.set(id, index + 1);
  });
  return result;
}

/** 压成可视化友好的结构（去掉 evidence 里的大数组）。 */
export function toCompact(graph, communities) {
  const degree = new Map();
  for (const edge of graph.edges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  }
  return {
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      label: node.label,
      relevance: node.relevance ?? null,
      confidence: node.confidence ?? null,
      tags: (node.tags ?? []).slice(0, 6),
      degree: degree.get(node.id) ?? 0,
      community: communities?.get(node.id) ?? null,
    })),
    edges: graph.edges.map((edge) => ({
      from: edge.from,
      to: edge.to,
      type: edge.type,
      weight: edge.weight,
    })),
  };
}
