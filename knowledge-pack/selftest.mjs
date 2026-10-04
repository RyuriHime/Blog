#!/usr/bin/env node
/**
 * 自测：用 fixtures/corpus 里的中文语料跑完整流程，校验产物结构与判定结果。
 *
 *   node selftest.mjs
 *
 * 断言的都是「语义正确性」，不是快照：
 *   - 种子主题词应该抓到性能/优化这类词；
 *   - 讲性能的文档必须被判为相关，讲产品/周报的必须被判为弱相关；
 *   - 显式 markdown 链接必须变成 explicit_link 边；
 *   - 产物文件齐全且 JSON 可解析。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runKnowledgePack } from './src/cli.mjs';
import { tokenize, buildVectors, cosine, stem } from './src/text.mjs';
import { parseFrontMatter, extractLinks, stripCode } from './src/scan.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(HERE, 'fixtures', 'corpus');
const SEED = join(CORPUS, 'seed-performance.md');

let passed = 0;
const failures = [];
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('\n▶ 单元：文本处理');
check('英文分词并小写', tokenize('Node.js SQLITE query').includes('node'));
check('英文复数被归一', stem('optimizations') === stem('optimization'), `${stem('optimizations')} vs ${stem('optimization')}`);
check('短词不被砍坏', stem('sql') === 'sql' && stem('go') === 'go' && stem('css') === 'css');
check('中文切出 2-gram 短语', tokenize('前端性能优化').includes('性能'), tokenize('前端性能优化').join(','));
check('中文停用词被过滤', !tokenize('这是一篇关于性能的文章').includes('这是'));
check('纯标点不产生词项', tokenize('!!! ... ---').length === 0);

console.log('\n▶ 单元：front matter 与链接');
const fm = parseFrontMatter('---\ntitle: 标题\ntags: [a, b]\n---\n正文');
check('front matter 标题解析正确', fm.data.title === '标题', JSON.stringify(fm.data));
check('front matter 列表解析正确', Array.isArray(fm.data.tags) && fm.data.tags.length === 2, JSON.stringify(fm.data.tags));
check('front matter 被剥离出正文', fm.body.trim() === '正文', fm.body);
check('markdown 链接被抽取', extractLinks('见 [A](./a.md) 与 [B](http://x/y)').length === 2);
check('裸文件名引用被抽取', extractLinks('参考 spec.md 里的描述').includes('spec.md'));
check('代码块被剥离', !stripCode('```\nsecret\n```\n正文').includes('secret'));

console.log('\n▶ 单元：向量');
const vectors = buildVectors([
  { id: 'a', title: '性能优化', text: '前端性能优化 首屏渲染' },
  { id: 'b', title: '性能监控', text: '性能监控 首屏渲染指标' },
  { id: 'c', title: '周报', text: '周报写作 结构建议' },
]);
const simAB = cosine(vectors.vectors.get('a'), vectors.vectors.get('b'));
const simAC = cosine(vectors.vectors.get('a'), vectors.vectors.get('c'));
check('同主题文档相似度更高', simAB > simAC, `${simAB.toFixed(3)} vs ${simAC.toFixed(3)}`);
check('相似度在 0..1 之间', simAB > 0 && simAB <= 1 && simAC >= 0, `${simAB} / ${simAC}`);

console.log('\n▶ 端到端：完整流程');
const out = await mkdtemp(join(tmpdir(), 'knowledge-pack-'));
let result;
try {
  result = await runKnowledgePack({ seed: SEED, dir: CORPUS, out, quiet: true }, { cwd: HERE });

  const seedTerms = result.manifest.seed.keywords.map((item) => item.term);
  check('提取到种子主题词', seedTerms.length >= 5, seedTerms.join(','));
  check('主题词覆盖性能相关概念', seedTerms.some((term) => term.includes('性能') || term.includes('优化')), seedTerms.join(','));
  check('主题词不是一堆 n-gram 碎片', result.manifest.quality.seedKeywords.noiseRatio <= 0.6, JSON.stringify(result.manifest.quality.seedKeywords));
  check('文件关键词也基本干净', result.manifest.quality.fileKeywords.noiseRatio <= 0.6, JSON.stringify(result.manifest.quality.fileKeywords));

  const relatedIds = result.related.map((entry) => entry.id);
  const weakIds = result.weak.map((entry) => entry.id);
  check('性能类文档被判为相关', relatedIds.includes('build-tools.md') && relatedIds.includes('http-cache.md'), relatedIds.join(','));
  check('产品/周报类被判为弱相关', weakIds.includes('product-review.md') && weakIds.includes('team-weekly.md'), `related=${relatedIds.join(',')} weak=${weakIds.join(',')}`);
  check('种子文档自己不重复出现在结果里', !relatedIds.includes('seed-performance.md') && !weakIds.includes('seed-performance.md'));

  const httpCache = result.related.find((entry) => entry.id === 'http-cache.md');
  check('相关文档带命中证据', (httpCache?.relevance.matched.length ?? 0) > 0, JSON.stringify(httpCache?.relevance.matched));
  check('相关文档打了标签', (httpCache?.tags.length ?? 0) > 0, JSON.stringify(httpCache?.tags));
  check('front matter 标签进入标签集', httpCache?.tags.some((tag) => tag.tag === '网络' || tag.tag === '性能'), JSON.stringify(httpCache?.tags.map((t) => t.tag)));
  check('置信度分级存在', ['high', 'medium', 'low'].includes(httpCache?.confidence), httpCache?.confidence);

  const tagNames = result.tags.tags.map((tag) => tag.tag);
  check('标签索引非空', tagNames.length >= 4, tagNames.join(','));
  check('标签索引带文件列表', result.tags.tags.every((tag) => tag.files.length > 0));
  check('标签共现被计算', result.tags.cooccurrence.length > 0, String(result.tags.cooccurrence.length));

  const edgeTypes = new Set(result.graph.edges.map((edge) => edge.type));
  check('存在种子→文件边', edgeTypes.has('seed_topic'), [...edgeTypes].join(','));
  check('存在文件相似边', edgeTypes.has('similar'), [...edgeTypes].join(','));
  check('显式引用变成 explicit_link 边', edgeTypes.has('explicit_link'), [...edgeTypes].join(','));
  check('存在 文件→标签 边', edgeTypes.has('tagged'), [...edgeTypes].join(','));
  check('存在标签共现边', edgeTypes.has('tag_cooccurrence'), [...edgeTypes].join(','));
  check('种子节点唯一', result.graph.nodes.filter((node) => node.type === 'seed').length === 1);
  check('每条边两端都存在', result.graph.edges.every((edge) => result.graph.nodes.some((n) => n.id === edge.from) && result.graph.nodes.some((n) => n.id === edge.to)));
  check('聚类给了社区号', result.manifest.communities.length >= 1 && result.manifest.communities[0].size >= 1, JSON.stringify(result.manifest.communities.slice(0, 3).map((c) => c.size)));

  const files = ['manifest.json', 'documents.json', 'tags.json', 'graph.json', 'graph.compact.json', 'README.md', 'viewer.html'];
  for (const name of files) {
    check(`产物存在: ${name}`, existsSync(join(out, name)));
  }

  const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
  const documents = JSON.parse(await readFile(join(out, 'documents.json'), 'utf8'));
  const graph = JSON.parse(await readFile(join(out, 'graph.json'), 'utf8'));
  const compact = JSON.parse(await readFile(join(out, 'graph.compact.json'), 'utf8'));
  check('manifest 记录扫描与统计', manifest.counts.analyzedFiles >= 9 && manifest.counts.edges > 0, JSON.stringify(manifest.counts));
  check('documents 分相关/弱相关两组', Array.isArray(documents.related) && Array.isArray(documents.weak));
  check('graph 里保留边证据', graph.edges.some((edge) => edge.type === 'seed_topic' && edge.evidence.keywords.length > 0));
  check('紧凑图每节点带度数', compact.nodes.every((node) => typeof node.degree === 'number'));
  check('紧凑图不含 evidence 大字段', compact.edges.every((edge) => edge.evidence === undefined));
  check('README 产物说明非空', (await readFile(join(out, 'README.md'), 'utf8')).includes('种子主题词'));
  check('viewer.html 内嵌数据', (await readFile(join(out, 'viewer.html'), 'utf8')).includes('application/json'));

  console.log('\n▶ 参数与边界');
  const emptyDir = await mkdtemp(join(tmpdir(), 'knowledge-empty-'));
  const empty = await runKnowledgePack({ seed: SEED, dir: emptyDir, out, quiet: true }, { cwd: HERE });
  check('空目录不报错', empty.manifest.counts.analyzedFiles === 0, JSON.stringify(empty.manifest.counts));
  check('空目录时图只有种子节点', empty.graph.nodes.length === 1 && empty.graph.edges.length === 0, `${empty.graph.nodes.length}/${empty.graph.edges.length}`);
  await rm(emptyDir, { recursive: true, force: true });

  const nested = await mkdtemp(join(tmpdir(), 'knowledge-exclude-'));
  await writeFile(join(nested, 'keep.md'), '# 保留\n\n性能优化 首屏渲染。\n', 'utf8');
  await writeFile(join(nested, 'skip.txt'), 'skip', 'utf8');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(nested, 'node_modules'), { recursive: true });
  await writeFile(join(nested, 'node_modules', 'dep.md'), '# 依赖\n\n不该被扫到。\n', 'utf8');
  const excluded = await runKnowledgePack({ seed: SEED, dir: nested, out, ext: '.md', quiet: true }, { cwd: HERE });
  check('扩展名过滤生效（.txt 被排除）', !excluded.related.concat(excluded.weak).some((e) => e.id.endsWith('.txt')), JSON.stringify(excluded.related.concat(excluded.weak).map((e) => e.id)));
  check('node_modules 被排除', !excluded.related.concat(excluded.weak).some((e) => e.id.includes('node_modules')), JSON.stringify(excluded.related.concat(excluded.weak).map((e) => e.id)));
  await rm(nested, { recursive: true, force: true });

  let missingSeed = '';
  try {
    await runKnowledgePack({ dir: CORPUS }, { cwd: HERE });
  } catch (error) {
    missingSeed = error.message;
  }
  check('缺少 --seed 时报错清晰', missingSeed.includes('--seed'), missingSeed);

  let badNumber = '';
  try {
    await runKnowledgePack({ seed: SEED, dir: CORPUS, similarity: 'abc' }, { cwd: HERE });
  } catch (error) {
    badNumber = error.message;
  }
  check('非法数字参数被拒绝', badNumber.includes('--similarity') || badNumber.includes('similarity'), badNumber);
} finally {
  await rm(out, { recursive: true, force: true });
}

console.log(`\n${'─'.repeat(46)}`);
console.log(`通过 ${passed} 项，失败 ${failures.length} 项`);
if (failures.length) {
  console.log('\n失败明细：');
  for (const item of failures) console.log(`  · ${item}`);
  process.exit(1);
}
