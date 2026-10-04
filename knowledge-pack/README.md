# knowledge-pack · 文档知识整理包

给它**一篇种子文档**和一个**目录**，它会：

1. 从种子文档抽出**主题词**（关键词）；
2. 扫描目录里的**全部文件**，逐个算相关度、检索命中；
3. 给每个文件**打标签**（种子主题词 / 文件自身关键词 / 目录域 / front matter 标签）；
4. 建一张**知识网络图**（文件 ↔ 文件 ↔ 标签）；
5. 输出 **JSON**（+ 一份 README + 一个免服务器的可视化页面）。

**零依赖**：只用 Node 内置模块，不需要 `npm install`，没有构建步骤。整个目录可以直接拷给别人。

---

## 1. 环境要求

- Node.js **18+**（用到内置 `fetch`/`node:test` 之外的标准库，实测 Node 24 通过）
- 无需数据库、无需 API key、无需联网

## 2. 快速开始

```bash
# 最小用法：以 seed.md 为主题，扫描 ./docs
node src/cli.mjs --seed ./seed.md --dir ./docs

# 指定输出目录与阈值
node src/cli.mjs --seed ./seed.md --dir ./docs --out ./knowledge-out --similarity 0.2 --max-tags 10

# 看全部参数
node src/cli.mjs --help
```

产物默认写到 `<dir>/../knowledge-out`。**先跑一遍自带示例**（用 9 篇真实中文帖子当语料）：

```bash
node examples/export-forum-corpus.mjs --run   # 导出示例语料 + 跑一遍，产物在 examples/knowledge-out/
node examples/inspect-output.mjs              # 把产物里的关键结论打印出来
```

> `examples/export-forum-corpus.mjs` 只负责「造一份真实中文语料」，它需要一份论坛 SQLite 库（默认取 `../data/forum.db`，可用 `FORUM_DB` 指定）。**核心流程不依赖它**，你自己的语料直接给 `--dir` 就行。

## 3. CLI 参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--seed <file>` | 必填 | 种子文档，要分析主题的那一篇 |
| `--dir <dir>` | 必填 | 要扫描的目录（递归） |
| `--out <dir>` | `<dir>/../knowledge-out` | 产物输出目录 |
| `--ext <a,b,c>` | `.md,.markdown,.mdx,.txt` | 参与扫描的扩展名 |
| `--exclude <a,b>` | 见下 | 额外排除的目录名 |
| `--top-keywords <n>` | 12 | 每篇文件保留的关键词数 |
| `--seed-keywords <n>` | 12 | 种子文档抽多少主题词 |
| `--max-tags <n>` | 8 | 每篇文件最多几个标签 |
| `--min-df <n>` | 2 | 词项至少出现在几篇文档里才算关键词 |
| `--max-df-ratio <r>` | 0.5 | 词项出现在超过该比例文档时丢弃（区分度不足） |
| `--similarity <r>` | 0.12 | 文件之间建立「相似」边的余弦阈值 |
| `--min-score <r>` | 0.08 | 判定「与种子相关」的最低相关度 |
| `--max-files <n>` | 2000 | 最多扫描文件数 |
| `--max-depth <n>` | 12 | 最大递归深度 |
| `--quiet` | 关 | 少打印日志 |

默认排除目录：`node_modules .git .svn .hg dist build out coverage .next .nuxt .cache __pycache__ .venv venv vendor data`。

## 4. 产物说明

| 文件 | 内容 |
| --- | --- |
| `manifest.json` | 运行参数、语料统计、图统计、聚类摘要、**关键词质量指标** |
| `documents.json` | 每个文件的关键词 / 标签 / 相关度 / 命中证据，分 `related` 与 `weak` 两组 |
| `tags.json` | 标签 → 文件倒排索引、标签共现、标签统计 |
| `graph.json` | 知识网络图：节点 + 边 + **边的成因证据** |
| `graph.compact.json` | 精简图，适合直接喂给前端可视化 |
| `README.md` | 本次运行的数据说明（自动生成，含文件清单与标签表） |
| `viewer.html` | 双击即可看的力导向图，无需服务器（内嵌数据） |

### 4.1 `graph.compact.json`（整合方最常用）

```jsonc
{
  "seedId": "seed:docs/spec.md",
  "nodeTypes": { "seed": "种子文档", "document": "文档", "tag": "标签", "external": "范围外被引用文件" },
  "edgeTypes": {
    "seed_topic": "种子主题匹配",
    "similar": "内容相似",
    "explicit_link": "文档内显式引用",
    "tagged": "文档带此标签",
    "tag_cooccurrence": "标签共现"
  },
  "nodes": [
    {
      "id": "doc:docs/a.md",
      "type": "document",
      "label": "标题",
      "relevance": 0.354,        // 相对种子文档的相关度 0..1
      "confidence": "high",      // high | medium | low | none
      "tags": ["零依赖", "node"],
      "degree": 9,               // 图中连接数
      "community": 2             // 聚类编号
    }
  ],
  "edges": [
    { "from": "seed:docs/spec.md", "to": "doc:docs/a.md", "type": "seed_topic", "weight": 0.354 }
  ]
}
```

`graph.json` 是同一张图的完整版，额外带 `reason` 与 `evidence`，例如：

```jsonc
{
  "type": "seed_topic",
  "from": "seed:docs/spec.md", "to": "doc:docs/a.md",
  "weight": 0.354,
  "reason": "命中 6 个种子关键词",
  "evidence": { "keywords": ["node", "零依赖"], "keywordScore": 0.41, "cosineScore": 0.23 }
}
```

### 4.2 `tags.json`

```jsonc
{
  "tags": [
    { "tag": "零依赖", "count": 3, "files": ["01-post-1.md", "02-post-2.md"], "weight": 4.2, "sources": ["keyword", "seed"] }
  ],
  "cooccurrence": [ { "from": "零依赖", "to": "node", "count": 3, "files": ["..."] } ],
  "stats": { "total": 42, "singleUse": 28, "mostUsed": [{ "tag": "论坛", "count": 9 }] }
}
```

`documents.json` 里每个文件长这样：

```jsonc
{
  "id": "02-post-2.md",
  "path": "02-post-2.md",
  "title": "Node.js 24 内置 SQLite 上手实测",
  "relevance": 0.354,
  "confidence": "high",
  "matchedKeywords": ["node", "零依赖", "依赖"],
  "keywords": ["sqlite", "依赖", "全栈"],
  "tags": ["技术交流", "零依赖", "node"],
  "tagDetail": [ { "tag": "零依赖", "score": 2.31, "sources": ["keyword", "seed"] } ],
  "community": 2,
  "chars": 308,
  "links": ["./07-post-7.md"],
  "frontMatter": { "title": "...", "tags": ["技术交流", "论坛"] }
}
```

## 5. 算法说明（够用来判断结果可不可信）

- **分词**：拉丁词按字母数字切分、转小写、保守词干归一（只砍复数与常见后缀，`sql`/`go`/`css` 不会被砍坏）；中文切 2-gram 与 3-gram；中英文停用词表内置。
- **词汇压缩**：中文 n-gram 会产生「子串碎片」（`零依赖全栈` → `赖全/栈怎`）。压缩规则是：若某个只多一个字的 gram 在本文档里权重更高，就丢掉这个碎片；同时对「只在 1 篇文档里出现过的 3-gram 及以上中文词」降权，因为那多半是切碎出来的。
- **权重**：亚线性 TF（`1 + log(tf)`）× IDF（`log((N+1)/(df+1)) + 1`），向量归一化后做余弦。
- **相关度** = `0.65 × 命中种子的权重占比 + 0.35 × 与种子的余弦相似度`；再按阈值分成 `related` / `weak`，并给出 `high/medium/low/none` 置信度。
- **打标签**：`front matter(×3.5) > 种子主题词(×3.0) > 文件关键词(×2.0) > 标题词(×1.5) > 目录域(×1.2)`，同名词合并累加，取 Top N。
- **知识网络**：相似边用余弦阈值过滤并限制每点最多 12 条，避免 O(n²) 爆炸；标签边来自倒排索引；显式引用边来自 markdown 链接（指向扫描范围之外的文件会生成 `external` 节点，保证边两端都存在）。
- **聚类**：确定性标签传播（同一输入必得同一结果），只走 `seed_topic` / `similar` 边。
- **质量自检**：`manifest.json` 的 `quality` 给出关键词的**碎片率**（`noiseRatio`）。经验值：中文语料 `≤ 0.35` 算健康；若明显偏高，说明语料太短或术语太分散，可以调大 `--min-df`、减小 `--top-keywords`。

## 6. 当库用（不写 CLI 也能整合）

```js
import { runKnowledgePack } from './src/cli.mjs';

const result = await runKnowledgePack({
  seed: '/abs/path/seed.md',
  dir: '/abs/path/docs',
  out: '/abs/path/out',
  similarity: 0.15,
  quiet: true,
});

console.log(result.manifest.counts);      // 统计
console.log(result.related.length);       // 相关文件数
console.log(result.tags.tags.slice(0, 5)); // 标签
console.log(result.graph.nodes.length);   // 图规模
```

也可以只用其中一层：

```js
import { scanDirectory } from './src/scan.mjs';
import { extractKeywords, relevanceToSeed, seedKeywords } from './src/keywords.mjs';
import { assignTags, buildTagIndex } from './src/tags.mjs';
import { buildGraph, graphStats, detectCommunities } from './src/graph.mjs';
import { tokenize, buildVectors, cosine } from './src/text.mjs';
```

各模块职责：

| 模块 | 职责 |
| --- | --- |
| `src/text.mjs` | 分词、停用词、词干、TF-IDF、余弦 |
| `src/scan.mjs` | 递归收集文件、front matter、标题、引用抽取、去代码/去引用 |
| `src/keywords.mjs` | 关键词抽取与压缩、种子主题词、相关度、相似边、质量指标 |
| `src/tags.mjs` | 标签分配、倒排索引、标签共现、相关/弱相关划分 |
| `src/graph.mjs` | 图构建、图统计、社区划分、精简图 |
| `src/report.mjs` | 产物 README 与可视化页面渲染 |
| `src/cli.mjs` | 参数解析与全流程编排 |

## 7. 自测

```bash
node selftest.mjs
```

自测用的是 `fixtures/corpus/` 里的 10 篇中文 fixture（性能主题 5 篇 + 无关主题若干），断言的是**语义正确性**而不是快照：

- 种子文档必须抽出「性能/优化」这类主题词；
- 讲性能的文档必须判为相关，讲产品/周报的必须判为弱相关；
- markdown 显式链接必须变成 `explicit_link` 边；
- 每条边两端必须都存在、产物必须齐全且 JSON 可解析、标签索引必须带文件列表；
- 空目录不报错、`node_modules` 与被排除扩展名不会被扫到、非法参数要明确报错。

## 8. 已知限制

- **中文没有词典**：靠 n-gram + 压缩，短文本或术语分散时仍会看到碎片（用 `quality.noiseRatio` 判断）。想要更干净可以接一个分词器，替换 `src/text.mjs` 的 `tokenize()` 即可，其余模块不用改。
- **不是语义检索**：只看词面统计，同义改写（「性能」vs「速度」）不会互相命中。
- **单篇种子**：一次只围绕一篇文档算主题。要多主题请跑多次，或把多篇合并成一个种子文件。
- **显式引用只识别相对路径**：`[x](./a.md)`、`[[a]]`、裸文件名 `a.md`；跨库的 URL 与锚点不会建边。
- **大语料**：两两相似度是 O(n²) 的词表交集，实测 2000 篇以内可接受；更大规模建议先按目录分批跑，或把 `--similarity` 阈值调高。

## 9. 目录结构

```
knowledge-pack/
├── src/
│   ├── cli.mjs         # 入口：参数解析 + 全流程编排（也可当库调用）
│   ├── text.mjs        # 分词 / 停用词 / TF-IDF / 余弦
│   ├── scan.mjs        # 目录扫描 / front matter / 引用抽取
│   ├── keywords.mjs    # 关键词与相关度
│   ├── tags.mjs        # 打标签与倒排索引
│   ├── graph.mjs       # 知识网络图
│   └── report.mjs      # 产物 README 与 viewer.html
├── fixtures/corpus/    # 自测语料（中文，含相关与无关文档）
├── examples/
│   ├── export-forum-corpus.mjs  # 把论坛帖子导出成 markdown 语料
│   ├── inspect-output.mjs       # 打印产物的关键结论
│   ├── forum-corpus/            # 示例语料（9 篇真实中文帖子 + 1 篇种子）
│   └── knowledge-out/           # 一次真实运行的产物样本（7 个文件）
├── selftest.mjs        # 56 项自测
└── README.md           # 本文档
```

## 10. 交给下游时怎么用

最短路径：

```bash
node src/cli.mjs --seed <你的种子文档> --dir <你的资料目录> --out <输出目录>
```

然后把 `<输出目录>/knowledge-out/graph.compact.json` 当作知识网络的输入：

- `nodes[].relevance` + `nodes[].confidence` → 决定「推荐阅读 / 前置知识」的排序；
- `nodes[].tags` → 直接当分类标签；
- `edges[]` 按 `type` 过滤 → 想要「谁和谁相关」就看 `similar`，想要「谁引用了谁」就看 `explicit_link`，想要「主题簇」就看 `tag_cooccurrence` 或 `community`；
- 需要向用户解释「为什么它们相关」时，读 `graph.json` 里同一条边的 `evidence`。
