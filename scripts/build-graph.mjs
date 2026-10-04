#!/usr/bin/env node
/**
 * 生成「知识网络图」。
 *
 *   node scripts/build-graph.mjs                    # 用置顶帖当种子（没有就选浏览量最高的）
 *   node scripts/build-graph.mjs --seed 10          # 指定某篇帖子当种子
 *   node scripts/build-graph.mjs --db <path>        # 指定数据库（默认 data/forum.db）
 *
 * 做了什么（三步）：
 *   1. 用只读方式打开论坛数据库，把帖子导出成 markdown 语料（data/knowledge/corpus/）
 *   2. 直接 import knowledge-pack，以「种子帖」为中心算出一张关系网
 *   3. 把结果（节点/边/统计）清洗后整理成 data/knowledge/graph.json，给网页读
 *
 * 产物全部写在 data/ 里 —— 部署脚本从不碰 data/，所以重新部署不会丢。
 *
 * 注意：数据库一律以 readOnly 打开，不建表、不迁移、不写入。
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WORK = join(ROOT, 'data', 'knowledge');
const CORPUS = join(WORK, 'corpus');
const OUT = join(WORK, 'out');
const GRAPH_FILE = join(WORK, 'graph.json');
const STATUS_FILE = join(WORK, 'status.json');
const LOCK_FILE = join(WORK, 'running.lock');

/** 极简参数解析：--key value 与 --flag。 */
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item.startsWith('--')) {
      const key = item.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[key] = next;
        i += 1;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(item);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const DB_FILE = args.db || process.env.DB_FILE || join(ROOT, 'data', 'forum.db');

function log(...parts) {
  if (!args.quiet) console.log('[graph]', ...parts);
}

/** 把文本切成中英混合的词元，用于「相关阅读」的粗匹配。 */
function tokensOf(text) {
  const source = String(text ?? '').toLowerCase();
  const out = new Set();
  for (const word of source.match(/[a-z][a-z0-9+#.-]{2,}/g) ?? []) out.add(word);
  for (const run of source.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
    for (let i = 0; i < run.length - 1; i += 1) out.add(run.slice(i, i + 2));
  }
  return out;
}

function readForum(dbFile) {
  if (!existsSync(dbFile)) throw new Error(`找不到数据库：${dbFile}`);
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const has = (table, column) =>
      db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);

    const filters = ['p.deleted = 0'];
    if (has('posts', 'hidden')) filters.push('COALESCE(p.hidden, 0) = 0');

    const posts = db
      .prepare(
        `SELECT p.id, p.title, p.content, p.views, p.pinned, p.created_at,
                b.slug AS boardSlug, b.name AS board, u.display_name AS author
         FROM posts p
         JOIN boards b ON b.id = p.board_id
         JOIN users u ON u.id = p.user_id
         WHERE ${filters.join(' AND ')}
         ORDER BY p.id`,
      )
      .all();

    const replies = db
      .prepare(
        `SELECT r.post_id, r.content, u.display_name AS author
         FROM replies r JOIN users u ON u.id = r.user_id
         WHERE r.deleted = 0 ORDER BY r.id`,
      )
      .all();

    return { posts, replies };
  } finally {
    db.close();
  }
}

const fileOf = (id) => `${String(id).padStart(4, '0')}-post-${id}.md`;
const seedFileOf = (id) => `00-seed-post-${id}.md`;

/** 同板块 + 关键词重叠，粗挑两篇「相关阅读」（这是启发式，不是人工指定）。 */
function relatedFor(post, all, tokensById) {
  const mine = tokensById.get(post.id);
  return all
    .filter((other) => other.id !== post.id)
    .map((other) => {
      let overlap = 0;
      for (const token of tokensById.get(other.id)) if (mine.has(token)) overlap += 1;
      const score = Math.min(overlap, 8) + (other.boardSlug === post.boardSlug ? 2 : 0);
      return { other, score, overlap };
    })
    .filter((item) => item.overlap >= 2)
    .sort((a, b) => b.score - a.score || a.other.id - b.other.id)
    .slice(0, 2)
    .map((item) => item.other);
}

function postMarkdown(post, { seed, replies, related, fileOfOther }) {
  const lines = ['---'];
  lines.push(`title: ${JSON.stringify(String(post.title))}`);
  lines.push(`postId: ${post.id}`);
  lines.push(`board: ${JSON.stringify(String(post.board))}`);
  lines.push(`boardSlug: ${JSON.stringify(String(post.boardSlug))}`);
  lines.push(`author: ${JSON.stringify(String(post.author))}`);
  lines.push(`tags: [${JSON.stringify(String(post.board))}]`);
  lines.push('---', '', `# ${post.title}`, '', String(post.content ?? '').trim(), '');

  const postReplies = replies.filter((reply) => reply.post_id === post.id);
  if (postReplies.length && !seed) {
    lines.push('## 讨论回复', '');
    for (const reply of postReplies) {
      const text = String(reply.content ?? '').replace(/\s+/g, ' ').trim();
      if (text) lines.push(`- **${reply.author}**：${text}`);
    }
    lines.push('');
  }
  if (related.length) {
    lines.push('## 相关阅读', '');
    for (const other of related) {
      lines.push(`- [${other.title}](./${fileOfOther(other.id)})`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

/* ------------------------------------------------------------------ */
/* 标签清洗                                                            */
/* ------------------------------------------------------------------ */

/*
 * knowledge-pack 的中文切分是「2-gram + 3-gram 全偏移」的：不需要词典就能得到
 * 「知识图谱」这类短语，代价是必然同时产出碎片 —— 「零依赖」必然同时得到
 * `零依` / `依赖`，「代码块」必然同时得到 `代码` / `码块`。碎片和完整词权重相同，
 * 直接画出来就是一团垃圾。
 *
 * 包自己的单元测试明确断言了这个行为（改包内部会让它的 selftest 变红，实测 56 → 54），
 * 所以不动包内部，改在自己的层里清洗：噪声表 → 权重门槛 → 最长匹配吸收。
 */

/** 实测观测到的垃圾标签：口语碎片、疑问句残留、论坛站点通用词。 */
const TAG_NOISE = new Set([
  '会不会', '不会', '会不', '不会影', '会影响', '会影', '路由会', '由会不',
  '大家', '一条', '作者', '帖子', '记得', '清楚', '写清', '喜欢', '加个', '够用',
  '标题', '提交', '建议', '感觉', '觉得', '平时', '时候', '东西', '一下', '分享',
  '直接', '一般', '内容', '现在', '已经', '还是', '还有', '另外', '例如', '比如',
  '等等', '其实', '反正', '这里', '那里', '怎么', '什么', '为什么', '如何',
  // 第二轮上线后从线上图里捞出来的残留口语词（2026-10-01 实测）
  '一遍', '常用', '没法', '各位', '用什么', '更新', '一直', '有点', '不少', '不太',
]);

/** 关键词标签的最低权重；低于它的基本都是偶发碎片。板块标签（meta）不受此限。 */
const TAG_MIN_WEIGHT = 0.15;

/** 读 knowledge-pack 的 tags.json，拿到每个标签的权重与来源（meta = 来自 front matter）。 */
async function loadTagMeta() {
  try {
    const raw = JSON.parse(await readFile(join(OUT, 'tags.json'), 'utf8'));
    return new Map((raw.tags ?? []).map((item) => [item.tag, item]));
  } catch {
    return new Map();
  }
}

/** 与标签同一套噪声表 + 碎片判定，作用在种子主题词上。 */
function cleanSeedKeywords(items, isFragment) {
  return items.filter((item) => {
    const term = String(item.term ?? '');
    if (!term || TAG_NOISE.has(term)) return false;
    if (/^\d+$/.test(term)) return false;
    if (term.length < 2) return false;
    return !isFragment(term);
  });
}

/**
 * 统计语料里所有 2~5 字中文 n-gram 的出现次数。
 * 用作「最长匹配吸收」的比较基准（见 makeFragmentTest）。
 */
function ngramCounts(texts, minSize = 2, maxSize = 5) {
  const bySize = new Map();
  for (const text of texts) {
    for (const run of String(text ?? '').match(/[\u4e00-\u9fff]+/g) ?? []) {
      const chars = [...run];
      for (let size = minSize; size <= maxSize; size += 1) {
        if (size > chars.length) break;
        if (!bySize.has(size)) bySize.set(size, new Map());
        const bucket = bySize.get(size);
        for (let i = 0; i + size <= chars.length; i += 1) {
          const gram = chars.slice(i, i + size).join('');
          bucket.set(gram, (bucket.get(gram) ?? 0) + 1);
        }
      }
    }
  }
  return bySize;
}

/**
 * 造一个「碎片判定」函数。
 *
 * 包的切分只到 3-gram，所以「零依赖做全栈」里的 `赖做全` 永远等不到它的完整形式，
 * 光靠标签之间互相比对吸收不掉。这里改成：拿语料里的 n-gram 当基准，若存在一个更长
 * 的 n-gram 包含该词、且出现次数不少于它，就认定它是碎片。
 *
 * 频次那一项是关键：`零依赖` 虽然也出现在 `零依赖做` 里，但它自己出现 3 次、包含它的
 * 那个 4-gram 只出现 1 次，所以 `零依赖` 是真词，不会被误杀。
 */
function makeFragmentTest(bySize) {
  return function isFragment(term) {
    const own = bySize.get(term.length)?.get(term) ?? 0;
    if (own === 0) return false;
    for (let size = term.length + 1; size <= term.length + 3; size += 1) {
      const bucket = bySize.get(size);
      if (!bucket) continue;
      for (const [other, count] of bucket) {
        if (count >= own && other.includes(term)) return true;
      }
    }
    return false;
  };
}

/** 丢掉噪声标签、吸收碎片，重算 degree，清掉指向已删节点的边与自环。 */
function pruneGraph(nodes, edges, communities, tagMeta, authorNames, isFragment) {
  const labelOf = (node) => String(node.label ?? '');
  const isNoise = (label) => {
    if (TAG_NOISE.has(label)) return true;
    if (authorNames.has(label)) return true; // 人名（「站长」）不是知识标签
    if (/^\d+$/.test(label)) return true; // 纯数字（版本号、年份）
    if (!/[\u4e00-\u9fff]/.test(label) && label.length < 3) return true; // 过短的英文碎片
    return false;
  };

  const tagNodes = nodes.filter((node) => node.type === 'tag');
  const stage1 = tagNodes.filter((node) => {
    const label = labelOf(node);
    const meta = tagMeta.get(label);
    if ((meta?.sources ?? []).includes('meta')) return true; // 板块名，永远保留
    if (isNoise(label)) return false;
    return (meta?.weight ?? 0) >= TAG_MIN_WEIGHT;
  });

  // 最长匹配吸收：碎片和完整词同时出现时只留完整词
  const kept = stage1.filter((node) => !isFragment(labelOf(node)));

  const keptIds = new Set(kept.map((node) => node.id));
  const keptLabels = new Set(kept.map(labelOf));
  const dropped = new Set(tagNodes.filter((node) => !keptIds.has(node.id)).map((node) => node.id));

  const nextEdges = edges
    .filter((edge) => !dropped.has(edge.from) && !dropped.has(edge.to) && edge.from !== edge.to)
    .map((edge) => ({ ...edge }));

  const degree = new Map();
  for (const edge of nextEdges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  }

  const nextNodes = nodes
    .filter((node) => node.type !== 'tag' || keptIds.has(node.id))
    .map((node) => ({ ...node, degree: degree.get(node.id) ?? 0 }));

  const nextCommunities = communities.map((community) => ({
    ...community,
    topTags: (community.topTags ?? []).filter((tag) => keptLabels.has(tag)),
  }));

  return {
    nodes: nextNodes,
    edges: nextEdges,
    communities: nextCommunities,
    before: tagNodes.length,
    after: kept.length,
    removedNoise: tagNodes.length - stage1.length,
    removedAbsorbed: stage1.length - kept.length,
  };
}

async function writeStatus(payload) {
  await mkdir(WORK, { recursive: true });
  await writeFile(STATUS_FILE, `${JSON.stringify({ ...payload, at: Date.now() }, null, 2)}\n`, 'utf8');
}

/**
 * 挑种子帖。种子决定整张图「以谁为中心」，所以不能随手指定。
 *
 * 这里绕了两个弯，都记下来免得以后又改回去：
 *  1. 一开始挑「回复最多 → 正文最长 → 浏览量最高」。线上一条回复都没有，就退化成
 *     「正文最长」，把版规公告顶成了中心，画出来全是「点赞/投币/收藏」这种没信息量的词。
 *  2. 改成挑最居中的那篇（谁和其他帖子的共同词最多，统计学上叫 medoid）。**结果还是版规帖** ——
 *     因为版规帖又长又啥都提一句，跟谁都有共同词，这正是相似度里的 hubness 问题。
 *     所以先按板块把它们排除掉：站务公告讲的是「论坛怎么用」，不是知识内容。
 *
 * 最终规则：候选 = 非站务板块 + 至少 20 个词元（挡掉「测试」这种一句话帖），
 * 在候选里挑与其他帖平均相似度最高的那篇。相似度用词元集合上的余弦，
 * 按两边词元数的几何平均归一，又长又水的帖子不会因为词多就自动获胜。
 */
const META_BOARD_SLUGS = new Set(['meta', 'notice', 'announcement', 'site', 'about']);

function pickSeed(posts, wanted) {
  if (wanted) {
    const found = posts.find((post) => String(post.id) === String(wanted));
    if (!found) throw new Error(`找不到 id=${wanted} 的帖子（可能已删除或隐藏）`);
    return found;
  }

  const tokens = new Map(posts.map((post) => [post.id, tokensOf(`${post.title} ${post.content}`)]));
  const candidates = posts.filter(
    (post) => !META_BOARD_SLUGS.has(post.boardSlug) && tokens.get(post.id).size >= 20,
  );
  const pool = candidates.length ? candidates : posts;

  let best = pool[0];
  let bestScore = -1;
  for (const post of pool) {
    const mine = tokens.get(post.id);
    let total = 0;
    for (const other of posts) {
      if (other.id === post.id) continue;
      const theirs = tokens.get(other.id);
      let shared = 0;
      for (const token of mine) if (theirs.has(token)) shared += 1;
      total += shared / Math.sqrt(mine.size * theirs.size);
    }
    const score = total / Math.max(1, posts.length - 1);
    if (score > bestScore) {
      bestScore = score;
      best = post;
    }
  }
  if (candidates.length && candidates.length < posts.length) {
    log(`种子候选 ${candidates.length}/${posts.length} 篇（已排除站务公告板块与过短的帖子）`);
  }
  return best;
}

async function main() {
  await mkdir(WORK, { recursive: true });
  await writeFile(LOCK_FILE, `${JSON.stringify({ pid: process.pid, startedAt: Date.now() })}\n`, 'utf8');

  const started = Date.now();
  const { posts, replies } = readForum(DB_FILE);
  if (!posts.length) throw new Error('数据库里没有可用的帖子');

  const seed = pickSeed(posts, args.seed);
  log(`共 ${posts.length} 篇帖子，种子帖 = #${seed.id} ${seed.title}`);

  const tokensById = new Map(posts.map((post) => [post.id, tokensOf(`${post.title} ${post.content}`)]));

  await rm(CORPUS, { recursive: true, force: true });
  await rm(OUT, { recursive: true, force: true });
  await mkdir(CORPUS, { recursive: true });

  const fileToPost = new Map();
  for (const post of posts) {
    const isSeed = post.id === seed.id;
    const file = isSeed ? seedFileOf(post.id) : fileOf(post.id);
    fileToPost.set(file, post.id);
    const related = isSeed ? [] : relatedFor(post, posts, tokensById);
    await writeFile(
      join(CORPUS, file),
      postMarkdown(post, { seed: isSeed, replies, related, fileOfOther: fileOf }),
      'utf8',
    );
  }
  log(`语料已导出到 ${CORPUS}（${posts.length} 个文件，其中 1 个是种子）`);

  // 直接 import 跑，不另开子进程：更快，而且错误是真正的异常（子进程管道在受限环境下会被拒）
  const { runKnowledgePack } = await import('../knowledge-pack/src/cli.mjs');
  const result = await runKnowledgePack(
    {
      seed: join(CORPUS, seedFileOf(seed.id)),
      dir: CORPUS,
      out: OUT,
      quiet: true,
      // 默认 0.12 对 400 字上下的短帖太严，跑出来只有 1 条「内容相似」边
      similarity: 0.08,
    },
    { cwd: join(ROOT, 'knowledge-pack') },
  );

  const compact = JSON.parse(await readFile(join(OUT, 'graph.compact.json'), 'utf8'));
  let manifest = result?.manifest ?? {};
  if (!manifest || !Object.keys(manifest).length) {
    try {
      manifest = JSON.parse(await readFile(join(OUT, 'manifest.json'), 'utf8'));
    } catch {
      manifest = {};
    }
  }
  log(`knowledge-pack 产出 ${(result?.files ?? []).length} 个文件；manifest 键 = ${Object.keys(manifest).join(', ')}`);

  // 给文档节点补上 postId / board，前端才能点一下跳到那篇帖子
  const nodes = compact.nodes.map((node) => {
    const file = String(node.id).replace(/^(doc|seed):/, '');
    const postId = fileToPost.get(file);
    if (postId == null) return node;
    const post = posts.find((item) => item.id === postId);
    return { ...node, postId, board: post?.board ?? null, boardSlug: post?.boardSlug ?? null };
  });

  const tagMeta = await loadTagMeta();
  const authorNames = new Set(posts.map((post) => String(post.author ?? '')));
  const isFragment = makeFragmentTest(ngramCounts(posts.map((post) => `${post.title} ${post.content}`)));
  const pruned = pruneGraph(nodes, compact.edges, compact.communities ?? [], tagMeta, authorNames, isFragment);
  log(
    `标签清洗：${pruned.before} → ${pruned.after} 个（噪声 ${pruned.removedNoise} 个、碎片 ${pruned.removedAbsorbed} 个）`,
  );

  const related = pruned.nodes.filter(
    (n) => n.type === 'document' && n.relevance != null && n.confidence !== 'none',
  ).length;
  const graph = {
    generatedAt: Date.now(),
    seed: { postId: seed.id, title: seed.title, board: seed.board },
    stats: {
      posts: posts.length,
      analyzed: Math.max(0, posts.length - 1),
      related,
      tags: pruned.nodes.filter((n) => n.type === 'tag').length,
      nodes: pruned.nodes.length,
      edges: pruned.edges.length,
      communities: pruned.communities.length,
    },
    // 种子主题词在 manifest.seed.keywords 里，不在 manifest 顶层
    seedKeywords: cleanSeedKeywords(manifest.seed?.keywords ?? [], isFragment).map((item) => ({
      term: item.term,
      score: item.score ?? item.weight ?? 0,
    })),
    nodeTypes: compact.nodeTypes ?? {},
    edgeTypes: compact.edgeTypes ?? {},
    nodes: pruned.nodes,
    edges: pruned.edges,
    communities: pruned.communities,
  };

  await writeFile(GRAPH_FILE, `${JSON.stringify(graph)}\n`, 'utf8');
  await writeStatus({
    ok: true,
    seedPostId: seed.id,
    seedTitle: seed.title,
    stats: graph.stats,
    ms: Date.now() - started,
    error: null,
  });
  log(
    `完成：${graph.stats.nodes} 个节点 / ${graph.stats.edges} 条边 / ${graph.stats.communities} 个社区，` +
      `耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
  log(`产物：${GRAPH_FILE}`);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error('[graph] 失败：', message);
  await writeStatus({ ok: false, error: message, seedPostId: null, seedTitle: null, stats: null });
  process.exitCode = 1;
} finally {
  await rm(LOCK_FILE, { force: true });
}
