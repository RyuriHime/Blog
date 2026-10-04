/**
 * 产物渲染：本次运行的 README.md（数据说明）+ 单文件 viewer.html（力导向知识网络图）。
 * 两者都是纯字符串模板，不依赖任何库。
 */

export const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

const fmtPct = (value) => `${(Number(value ?? 0) * 100).toFixed(1)}%`;

/** 数据说明文档（写进输出目录）。 */
export function renderReportMarkdown({ manifest, tags, related, weak, communities }) {
  const seedKeywords = manifest.seed.keywords.map((item) => item.term);
  const lines = [];

  lines.push('# 知识整理产物', '');
  lines.push(`- 生成时间：${manifest.generatedAt}`);
  lines.push(`- 种子文档：\`${manifest.options.seed}\`（${manifest.seed.title}）`);
  lines.push(`- 扫描目录：\`${manifest.options.dir}\``);
  lines.push(`- 参与分析：${manifest.counts.analyzedFiles} 个文件（跳过 ${manifest.counts.skipped} 个）`);
  lines.push(`- 判定相关：${manifest.counts.related} 个 / 弱相关：${manifest.counts.weak} 个`);
  lines.push(`- 用到的参数：${Object.entries(manifest.options)
    .filter(([key, value]) => !['seed', 'seedAbsolute', 'dir', 'out', 'excludes'].includes(key) && value !== undefined)
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join('|') : value}`)
    .join('、')}`);
  lines.push('');

  lines.push('## 种子主题词', '');
  lines.push(seedKeywords.map((term) => `\`${term}\``).join('、') || '（无）');
  lines.push('');

  lines.push('## 文件清单（按相关度）', '');
  lines.push('| # | 文件 | 相关度 | 置信度 | 命中主题词 | 标签 |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  const ordered = [...related, ...weak];
  ordered.forEach((entry, index) => {
    lines.push(
      `| ${index + 1} | \`${entry.path}\` | ${fmtPct(entry.relevance.score)} | ${entry.confidence} | ${
        entry.relevance.matched.map((item) => item.term).join('、') || '—'
      } | ${entry.tags.map((tag) => tag.tag).join('、') || '—'} |`,
    );
  });
  lines.push('');

  lines.push('## 标签索引（Top 30）', '');
  lines.push('| 标签 | 文件数 | 来源 | 文件 |');
  lines.push('| --- | --- | --- | --- |');
  for (const tag of tags.tags.slice(0, 30)) {
    lines.push(`| \`${tag.tag}\` | ${tag.count} | ${tag.sources.join('/')} | ${tag.files.slice(0, 5).map((file) => `\`${file}\``).join('、')}${tag.files.length > 5 ? ' …' : ''} |`);
  }
  lines.push('');

  if (communities?.length) {
    lines.push('## 内容聚类', '');
    communities.slice(0, 12).forEach((group) => {
      lines.push(`### 社区 ${group.id}（${group.size} 个文件）`);
      if (group.topTags.length) lines.push(`- 主要标签：${group.topTags.map((tag) => `\`${tag}\``).join('、')}`);
      lines.push(`- 代表文件：${group.files.slice(0, 5).map((file) => `\`${file.id}\``).join('、')}`);
      lines.push('');
    });
  }

  lines.push('## 产物文件', '');
  lines.push('| 文件 | 内容 |');
  lines.push('| --- | --- |');
  lines.push('| `manifest.json` | 运行参数、统计、图统计、聚类摘要 |');
  lines.push('| `documents.json` | 每个文件的关键词、标签、相关度、命中证据 |');
  lines.push('| `tags.json` | 标签 → 文件倒排索引、标签共现 |');
  lines.push('| `graph.json` | 知识网络图（节点 + 边 + 证据） |');
  lines.push('| `graph.compact.json` | 精简图，适合前端可视化 |');
  lines.push('| `viewer.html` | 打开即可看的可视化，无需服务器 |');
  lines.push('');

  lines.push('## 数据结构', '');
  lines.push('```jsonc');
  lines.push('// graph.compact.json');
  lines.push('{');
  lines.push('  "seedId": "seed:README.md",');
  lines.push('  "nodes": [{ "id": "doc:docs/a.md", "type": "document|seed|tag", "label": "标题",');
  lines.push('             "relevance": 0.42, "confidence": "high", "tags": ["..."], "degree": 7, "community": 1 }],');
  lines.push('  "edges": [{ "from": "seed:README.md", "to": "doc:docs/a.md",');
  lines.push('             "type": "seed_topic|similar|explicit_link|tagged|tag_cooccurrence", "weight": 0.42 }]');
  lines.push('}');
  lines.push('```');
  lines.push('');

  return `${lines.join('\n')}\n`;
}

/** 单文件可视化：力导向布局 + 类型着色 + 点击看详情。 */
export function renderViewerHtml({ compact, manifest }) {
  const data = JSON.stringify({ compact: { nodes: compact.nodes, edges: compact.edges }, meta: {
    seedTitle: manifest.seed.title,
    seedPath: manifest.options.seed,
    dir: manifest.options.dir,
    generatedAt: manifest.generatedAt,
    seedKeywords: manifest.seed.keywords.map((item) => item.term),
    counts: manifest.counts,
  } });

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>知识网络图 · ${escapeHtml(manifest.seed.title)}</title>
<style>
  :root { --bg:#0b0f16; --panel:#141b29; --border:#243044; --text:#e8eef7; --dim:#a6b3c6; --muted:#77869c;
          --accent:#5b8cff; --seed:#ffb454; --tag:#43d39e; --doc:#5b8cff; }
  * { box-sizing:border-box; }
  body { margin:0; height:100vh; display:grid; grid-template-columns:1fr 340px; background:var(--bg); color:var(--text);
         font:14px/1.65 "Segoe UI",system-ui,"Microsoft YaHei",sans-serif; }
  #stage { position:relative; overflow:hidden; }
  canvas { display:block; width:100%; height:100%; cursor:grab; }
  canvas.dragging { cursor:grabbing; }
  header { position:absolute; top:14px; left:16px; max-width:calc(100% - 32px); pointer-events:none; }
  header h1 { margin:0 0 4px; font-size:17px; }
  header .meta { color:var(--muted); font-size:12px; }
  .legend { position:absolute; bottom:14px; left:16px; display:flex; gap:14px; flex-wrap:wrap; font-size:12px; color:var(--dim);
            background:rgba(11,15,22,.82); border:1px solid var(--border); border-radius:10px; padding:8px 12px; }
  .legend i { display:inline-block; width:9px; height:9px; border-radius:50%; margin-right:5px; }
  aside { border-left:1px solid var(--border); background:var(--panel); overflow:auto; padding:16px; }
  aside h2 { font-size:14px; margin:0 0 10px; color:var(--dim); }
  .chips { display:flex; flex-wrap:wrap; gap:5px; margin-bottom:16px; }
  .chip { font-size:12px; padding:2px 8px; border-radius:999px; border:1px solid var(--border); color:var(--dim); }
  .chip.seed { color:var(--seed); border-color:rgba(255,180,84,.4); }
  .chip.tag { color:var(--tag); border-color:rgba(67,211,158,.35); }
  .stat { display:flex; justify-content:space-between; padding:5px 0; border-bottom:1px dashed var(--border); font-size:13px; }
  .stat span:last-child { color:var(--text); }
  #detail { margin-top:16px; font-size:13px; }
  #detail .title { font-weight:600; margin-bottom:6px; word-break:break-all; }
  #detail .row { color:var(--dim); margin:3px 0; word-break:break-all; }
  #detail a { color:var(--accent); }
  .empty { color:var(--muted); font-size:13px; }
  ul.tags { list-style:none; margin:0; padding:0; }
  ul.tags li { display:flex; justify-content:space-between; padding:4px 0; border-bottom:1px dashed var(--border); font-size:13px; }
  ul.tags li span:last-child { color:var(--muted); }
  input[type=search] { width:100%; margin-bottom:12px; padding:7px 10px; border-radius:8px; border:1px solid var(--border);
                       background:var(--bg); color:var(--text); }
</style>
</head>
<body>
<div id="stage">
  <header>
    <h1>🕸 知识网络图</h1>
    <div class="meta" id="meta"></div>
  </header>
  <canvas id="canvas"></canvas>
  <div class="legend">
    <span><i style="background:var(--seed)"></i>种子文档</span>
    <span><i style="background:var(--doc)"></i>文件</span>
    <span><i style="background:var(--tag)"></i>标签</span>
    <span><i style="background:#6b7a90"></i>范围外引用</span>
    <span>拖动可平移 · 滚轮缩放 · 点击节点看详情</span>
  </div>
</div>
<aside>
  <h2>概览</h2>
  <div id="stats"></div>
  <h2 style="margin-top:18px">种子主题词</h2>
  <div class="chips" id="seedKeywords"></div>
  <h2>标签</h2>
  <input type="search" id="tagFilter" placeholder="过滤标签…" />
  <ul class="tags" id="tagList"></ul>
  <h2 style="margin-top:18px">节点详情</h2>
  <div id="detail" class="empty">点击左侧任意节点查看详情。</div>
</aside>
<script id="payload" type="application/json">${data}</script>
<script>
(function () {
  const payload = JSON.parse(document.getElementById('payload').textContent);
  const nodes = payload.compact.nodes.map((n) => Object.assign({}, n));
  const edges = payload.compact.edges.slice();
  const meta = payload.meta;

  document.getElementById('meta').textContent =
    '种子：' + meta.seedPath + ' · 目录：' + meta.dir + ' · ' + meta.generatedAt;

  const typeColor = { seed: '#ffb454', document: '#5b8cff', tag: '#43d39e', external: '#6b7a90' };
  const radiusOf = (node) => (node.type === 'seed' ? 16 : node.type === 'tag' ? 5 + Math.min(9, node.degree * 0.5)
    : node.type === 'external' ? 5 : 6 + Math.min(14, (node.relevance || 0) * 42 + node.degree * 0.3));

  // 概览
  const stats = [
    ['文件数', meta.counts.analyzedFiles],
    ['相关文件', meta.counts.related],
    ['标签数', meta.counts.tags],
    ['节点 / 边', meta.counts.nodes + ' / ' + meta.counts.edges],
    ['社区数', meta.counts.communities],
  ];
  document.getElementById('stats').innerHTML = stats
    .map((row) => '<div class="stat"><span>' + row[0] + '</span><span>' + row[1] + '</span></div>')
    .join('');
  document.getElementById('seedKeywords').innerHTML = meta.seedKeywords
    .map((term) => '<span class="chip seed">' + term + '</span>')
    .join('');

  const tagNodes = nodes.filter((n) => n.type === 'tag').sort((a, b) => b.degree - a.degree);
  document.getElementById('tagList').innerHTML = tagNodes
    .map((n) => '<li><span>' + n.label + '</span><span>' + n.degree + '</span></li>')
    .join('');

  // 邻接
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const adjacency = new Map(nodes.map((n) => [n.id, []]));
  for (const edge of edges) {
    if (!adjacency.has(edge.from) || !adjacency.has(edge.to)) continue;
    adjacency.get(edge.from).push({ id: edge.to, edge: edge });
    adjacency.get(edge.to).push({ id: edge.from, edge: edge });
  }

  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');
  let width = 0;
  let height = 0;
  let scale = 1;
  let offsetX = 0;
  let offsetY = 0;
  let selected = null;
  let hover = null;

  function resize() {
    const ratio = window.devicePixelRatio || 1;
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  }
  window.addEventListener('resize', resize);

  // 初始化布局：种子居中，文件按社区分扇区，标签在外圈
  const seed = nodes.find((n) => n.type === 'seed');
  const docs = nodes.filter((n) => n.type === 'document');
  const communityIds = [...new Set(docs.map((n) => n.community).filter((v) => v != null))].sort((a, b) => a - b);
  const sectorOf = new Map(communityIds.map((id, index) => [id, (index / Math.max(1, communityIds.length)) * Math.PI * 2]));
  const cx = () => width / 2;
  const cy = () => height / 2;
  const baseRadius = () => Math.min(width, height) * 0.32;

  nodes.forEach((node, index) => {
    if (node.type === 'seed') {
      node.x = cx();
      node.y = cy();
    } else if (node.type === 'document') {
      const angle = (sectorOf.get(node.community) ?? (index / nodes.length) * Math.PI * 2) + (index % 7) * 0.06;
      const r = baseRadius() * (0.45 + ((index * 37) % 100) / 220);
      node.x = cx() + Math.cos(angle) * r;
      node.y = cy() + Math.sin(angle) * r;
    } else {
      const angle = (index / Math.max(1, tagNodes.length)) * Math.PI * 2;
      node.x = cx() + Math.cos(angle) * baseRadius() * 1.85;
      node.y = cy() + Math.sin(angle) * baseRadius() * 1.85;
    }
    node.vx = 0;
    node.vy = 0;
  });

  // 力导向：斥力 + 弹簧 + 轻微向心
  function simulate() {
    const k = 0.00035 * (width + height);
    for (const node of nodes) {
      const dx = cx() - node.x;
      const dy = cy() - node.y;
      node.vx += dx * 0.0004;
      node.vy += dy * 0.0004;
    }
    for (let i = 0; i < nodes.length; i += 1) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j += 1) {
        const b = nodes[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distSq = dx * dx + dy * dy + 0.01;
        if (distSq > 90000) continue;
        const force = (k * 90) / distSq;
        const dist = Math.sqrt(distSq);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.vx -= fx;
        a.vy -= fy;
        b.vx += fx;
        b.vy += fy;
      }
    }
    for (const edge of edges) {
      const a = byId.get(edge.from);
      const b = byId.get(edge.to);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) + 0.01;
      const target = edge.type === 'seed_topic' ? 130 : edge.type === 'similar' ? 110 : 190;
      const strength = edge.type === 'tagged' ? 0.004 : 0.02;
      const force = (dist - target) * strength;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }
    for (const node of nodes) {
      node.vx *= 0.72;
      node.vy *= 0.72;
      if (node === dragNode) continue;
      node.x += Math.max(-18, Math.min(18, node.vx));
      node.y += Math.max(-18, Math.min(18, node.vy));
    }
  }

  function draw() {
    ctx.clearRect(0, 0, width, height);
    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);

    for (const edge of edges) {
      const a = byId.get(edge.from);
      const b = byId.get(edge.to);
      if (!a || !b) continue;
      const active = !selected || selected === a.id || selected === b.id;
      if (edge.type === 'tagged') {
        ctx.strokeStyle = active ? 'rgba(67,211,158,0.16)' : 'rgba(67,211,158,0.05)';
        ctx.lineWidth = 0.6;
      } else if (edge.type === 'similar') {
        ctx.strokeStyle = active ? 'rgba(91,140,255,0.34)' : 'rgba(91,140,255,0.08)';
        ctx.lineWidth = 0.6 + Math.min(2.2, edge.weight * 7);
      } else if (edge.type === 'seed_topic') {
        ctx.strokeStyle = active ? 'rgba(255,180,84,0.72)' : 'rgba(255,180,84,0.14)';
        ctx.lineWidth = 1 + Math.min(3.4, edge.weight * 10);
      } else if (edge.type === 'explicit_link') {
        ctx.strokeStyle = active ? 'rgba(255,255,255,0.42)' : 'rgba(255,255,255,0.1)';
        ctx.lineWidth = 1;
      } else {
        ctx.strokeStyle = active ? 'rgba(120,134,156,0.3)' : 'rgba(120,134,156,0.08)';
        ctx.lineWidth = 0.5;
      }
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    for (const node of nodes) {
      const r = radiusOf(node);
      const dim = selected && selected !== node.id && !adjacency.get(selected)?.some((n) => n.id === node.id);
      ctx.globalAlpha = dim ? 0.22 : 1;
      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
      ctx.fillStyle = typeColor[node.type] || '#888';
      ctx.fill();
      if (node === hover || node.id === selected) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#fff';
        ctx.stroke();
      }
      if (node.type !== 'tag' || r > 9 || node === hover) {
        ctx.globalAlpha = dim ? 0.3 : 0.92;
        ctx.fillStyle = '#dbe4f0';
        ctx.font = (node.type === 'seed' ? '12px' : '10.5px') + ' "Segoe UI",system-ui,sans-serif';
        ctx.textAlign = 'center';
        const label = node.label.length > 22 ? node.label.slice(0, 21) + '…' : node.label;
        ctx.fillText(label, node.x, node.y - r - 4);
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  function screenToWorld(px, py) {
    return { x: (px - offsetX) / scale, y: (py - offsetY) / scale };
  }

  function nodeAt(px, py) {
    const point = screenToWorld(px, py);
    let best = null;
    let bestDist = Infinity;
    for (const node of nodes) {
      const dx = node.x - point.x;
      const dy = node.y - point.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const r = radiusOf(node) + 4;
      if (dist <= r && dist < bestDist) {
        best = node;
        bestDist = dist;
      }
    }
    return best;
  }

  let dragNode = null;
  let panning = false;
  let last = { x: 0, y: 0 };

  canvas.addEventListener('pointerdown', (event) => {
    const rect = canvas.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    const node = nodeAt(px, py);
    if (node) {
      dragNode = node;
      select(node);
    } else {
      panning = true;
      canvas.classList.add('dragging');
      last = { x: event.clientX, y: event.clientY };
    }
    canvas.setPointerCapture(event.pointerId);
  });

  canvas.addEventListener('pointermove', (event) => {
    const rect = canvas.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    if (dragNode) {
      const point = screenToWorld(px, py);
      dragNode.x = point.x;
      dragNode.y = point.y;
    } else if (panning) {
      offsetX += event.clientX - last.x;
      offsetY += event.clientY - last.y;
      last = { x: event.clientX, y: event.clientY };
    } else {
      hover = nodeAt(px, py);
    }
  });

  canvas.addEventListener('pointerup', () => {
    dragNode = null;
    panning = false;
    canvas.classList.remove('dragging');
  });

  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    const before = screenToWorld(px, py);
    const factor = event.deltaY < 0 ? 1.12 : 0.89;
    scale = Math.max(0.2, Math.min(4, scale * factor));
    const after = screenToWorld(px, py);
    offsetX += (after.x - before.x) * scale;
    offsetY += (after.y - before.y) * scale;
  }, { passive: false });

  function select(node) {
    selected = node.id;
    const neighbours = adjacency.get(node.id) || [];
    const group = (type) => neighbours.filter((n) => byId.get(n.id)?.type === type).length;
    const rows = [];
    rows.push('<div class="title">' + (node.type === 'tag' ? '#' : '') + node.label + '</div>');
    rows.push('<div class="row">类型：' + node.type + (node.community ? ' · 社区 ' + node.community : '') + '</div>');
    if (node.relevance != null) rows.push('<div class="row">相关度：' + (node.relevance * 100).toFixed(1) + '% · 置信度 ' + (node.confidence || '-') + '</div>');
    if (node.tags && node.tags.length) rows.push('<div class="row">标签：' + node.tags.join('、') + '</div>');
    rows.push('<div class="row">连接：' + neighbours.length + '（文件 ' + group('document') + ' · 标签 ' + group('tag') + '）</div>');
    if (node.id.startsWith('doc:')) {
      const path = node.id.slice(4);
      rows.push('<div class="row">路径：' + path + '</div>');
      const linked = neighbours.filter((n) => n.edge.type === 'seed_topic' || n.edge.type === 'similar').slice(0, 6);
      if (linked.length) rows.push('<div class="row">关联：' + linked.map((n) => byId.get(n.id)?.label || n.id).join('、') + '</div>');
    }
    document.getElementById('detail').className = '';
    document.getElementById('detail').innerHTML = rows.join('');
  }

  document.getElementById('tagFilter').addEventListener('input', (event) => {
    const keyword = event.target.value.trim().toLowerCase();
    document.getElementById('tagList').innerHTML = tagNodes
      .filter((n) => !keyword || n.label.toLowerCase().includes(keyword))
      .map((n) => '<li><span>' + n.label + '</span><span>' + n.degree + '</span></li>')
      .join('');
  });

  resize();
  let ticks = 0;
  function frame() {
    if (ticks < 600) {
      simulate();
      ticks += 1;
    }
    draw();
    requestAnimationFrame(frame);
  }
  frame();
})();
</script>
</body>
</html>
`;
}
