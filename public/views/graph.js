// 知识网络图：canvas 力导向布局 + 侧栏面板。

import { $, emptyHtml, esc, loadingHtml, ui } from '../core/dom.js';
import { api } from '../core/api.js';
import * as Fmt from '../core/format.js';

const KG_NODE_COLOR = { seed: '#ffb454', document: '#5b8cff', tag: '#43d39e', external: '#6b7a90' };
const KG_EDGE_STYLE = {
  seed_topic: { color: '#ffb454', alpha: 0.72, target: 130, strength: 0.02 },
  similar: { color: '#5b8cff', alpha: 0.34, target: 110, strength: 0.02 },
  explicit_link: { color: '#ffffff', alpha: 0.42, target: 190, strength: 0.02 },
  tagged: { color: '#43d39e', alpha: 0.16, target: 190, strength: 0.004 },
  tag_cooccurrence: { color: '#6b7a90', alpha: 0.3, target: 190, strength: 0.02 },
};
const KG_TYPE_LABEL = { seed: '种子帖', document: '帖子', tag: '标签', external: '范围外文件' };
const kg = {
  nodes: [],
  edges: [],
  byId: new Map(),
  neighbors: new Map(),
  meta: null,
  selected: null,
  hover: null,
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  width: 0,
  height: 0,
  ticks: 0,
  raf: 0,
  canvas: null,
  ctx: null,
  drag: null,
  pan: null,
};
function kgRadius(node) {
  if (node.type === 'seed') return 16;
  if (node.type === 'tag') return 5 + Math.min(9, (node.degree ?? 0) * 0.5);
  return 6 + Math.min(14, (node.relevance ?? 0) * 42 + (node.degree ?? 0) * 0.3);
}

/** 初始摆位：撒在一个圆环上，让力导向自己去收敛（比全堆在中心快）。 */
function kgLayout() {
  const cx = kg.width / 2;
  const cy = kg.height / 2;
  const radius = Math.min(kg.width, kg.height) * 0.34;
  kg.nodes.forEach((node, index) => {
    const angle = (index / Math.max(1, kg.nodes.length)) * Math.PI * 2;
    const jitter = 0.65 + Math.random() * 0.5;
    node.x = cx + Math.cos(angle) * radius * jitter;
    node.y = cy + Math.sin(angle) * radius * jitter;
    node.vx = 0;
    node.vy = 0;
  });
  kg.ticks = 0;
}
function kgResize() {
  const canvas = kg.canvas;
  if (!canvas) return;
  const rect = canvas.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  kg.width = Math.max(320, Math.round(rect.width));
  kg.height = Math.max(320, Math.round(rect.height));
  canvas.width = Math.round(kg.width * dpr);
  canvas.height = Math.round(kg.height * dpr);
  canvas.style.width = `${kg.width}px`;
  canvas.style.height = `${kg.height}px`;
  kg.ctx = canvas.getContext('2d');
  kg.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (!kg.nodes.some((node) => Number.isFinite(node.x))) kgLayout();
}

/** 一帧物理：向心 + 两两斥力 + 边的弹簧 + 阻尼（参数与原版 viewer 一致）。 */
function kgStep() {
  const { nodes, edges } = kg;
  const repulsion = 0.00035 * (kg.width + kg.height);
  const cx = kg.width / 2;
  const cy = kg.height / 2;

  for (const node of nodes) {
    node.vx += (cx - node.x) * 0.0004;
    node.vy += (cy - node.y) * 0.0004;
  }

  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i];
      const b = nodes[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      let distSq = dx * dx + dy * dy;
      if (distSq > 90000) continue;
      if (distSq < 1) distSq = 1;
      const force = (repulsion * 90) / distSq;
      const dist = Math.sqrt(distSq) || 1;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      a.vx -= fx;
      a.vy -= fy;
      b.vx += fx;
      b.vy += fy;
    }
  }

  for (const edge of edges) {
    const style = KG_EDGE_STYLE[edge.type] ?? KG_EDGE_STYLE.tag_cooccurrence;
    const a = kg.byId.get(edge.from);
    const b = kg.byId.get(edge.to);
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const delta = (dist - style.target) * style.strength;
    const fx = (dx / dist) * delta;
    const fy = (dy / dist) * delta;
    a.vx += fx;
    a.vy += fy;
    b.vx -= fx;
    b.vy -= fy;
  }

  for (const node of nodes) {
    node.vx *= 0.72;
    node.vy *= 0.72;
    node.vx = Math.max(-18, Math.min(18, node.vx));
    node.vy = Math.max(-18, Math.min(18, node.vy));
    node.x += node.vx;
    node.y += node.vy;
  }
  kg.ticks += 1;
}

/** 当前高亮的是谁：选中的节点，否则鼠标悬停的节点。 */
function kgFocus() {
  return kg.selected ?? kg.hover;
}
function kgIsDim(node) {
  const focus = kgFocus();
  if (!focus || node.id === focus.id) return false;
  return !(kg.neighbors.get(focus.id)?.has(node.id) ?? false);
}
function kgToWorld(clientX, clientY) {
  const rect = kg.canvas.getBoundingClientRect();
  return {
    x: (clientX - rect.left - kg.offsetX) / kg.scale,
    y: (clientY - rect.top - kg.offsetY) / kg.scale,
  };
}
function kgNodeAt(worldX, worldY) {
  for (let i = kg.nodes.length - 1; i >= 0; i -= 1) {
    const node = kg.nodes[i];
    const radius = kgRadius(node) + 4;
    const dx = worldX - node.x;
    const dy = worldY - node.y;
    if (dx * dx + dy * dy <= radius * radius) return node;
  }
  return null;
}
function kgDraw() {
  const ctx = kg.ctx;
  if (!ctx) return;
  ctx.clearRect(0, 0, kg.width, kg.height);
  ctx.save();
  ctx.translate(kg.offsetX, kg.offsetY);
  ctx.scale(kg.scale, kg.scale);

  for (const edge of kg.edges) {
    const style = KG_EDGE_STYLE[edge.type] ?? KG_EDGE_STYLE.tag_cooccurrence;
    const a = kg.byId.get(edge.from);
    const b = kg.byId.get(edge.to);
    if (!a || !b) continue;
    const dim = kgIsDim(a) && kgIsDim(b);
    ctx.globalAlpha = dim ? style.alpha * 0.25 : style.alpha;
    ctx.strokeStyle = style.color;
    ctx.lineWidth = (edge.weight ?? 1) > 2 ? 1.6 : 1;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  for (const node of kg.nodes) {
    const radius = kgRadius(node);
    const dim = kgIsDim(node);
    const focused = kgFocus()?.id === node.id;
    ctx.globalAlpha = dim ? 0.22 : 1;
    ctx.beginPath();
    ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = KG_NODE_COLOR[node.type] ?? '#6b7a90';
    ctx.fill();
    if (focused) {
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
    }
    if (kg.scale > 0.55) {
      ctx.globalAlpha = dim ? 0.25 : 0.92;
      ctx.fillStyle = kgPalette.text;
      ctx.font = `${node.type === 'tag' ? 11 : 12}px ${kgPalette.font}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(node.label, node.x, node.y + radius + 3);
    }
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

/** 主题切换时重新取色（画布不会自己跟着 CSS 变量变）。 */
const kgPalette = { text: '#e8eef7', font: 'sans-serif' };
function kgRefreshPalette() {
  const style = getComputedStyle(document.documentElement);
  kgPalette.text = style.getPropertyValue('--text').trim() || '#e8eef7';
  kgPalette.font = style.getPropertyValue('--font').trim() || 'sans-serif';
}
function kgStop() {
  if (kg.raf) cancelAnimationFrame(kg.raf);
  kg.raf = 0;
}

/** 主循环：前 600 帧算布局，之后只重画（跟原版一样，避免一直抖）。 */
function kgLoop() {
  if (!kg.canvas || !kg.canvas.isConnected) {
    kgStop();
    return;
  }
  if (kg.ticks < 600) kgStep();
  kgDraw();
  kg.raf = requestAnimationFrame(kgLoop);
}
function kgNeighbors() {
  kg.neighbors = new Map(kg.nodes.map((node) => [node.id, new Set()]));
  for (const edge of kg.edges) {
    kg.neighbors.get(edge.from)?.add(edge.to);
    kg.neighbors.get(edge.to)?.add(edge.from);
  }
}
function kgPanelHtml() {
  const focus = kgFocus();
  if (!focus) {
    const meta = kg.meta ?? {};
    const seed = meta.seed ?? {};
    const keywords = (meta.seedKeywords ?? []).map((item) => `<span class="kg-chip is-static">${esc(item.term)}</span>`).join('');
    return `
      <div class="kg-panel-title">🧭 关于这张图</div>
      <p class="kg-hint">每篇帖子是一个蓝点，标签是绿点，橙色大点是你选的主题（种子帖）。离种子越近、相关度越高，连线越亮。</p>
      <div class="kg-row"><span>主题</span><strong>${esc(seed.title ?? '—')}</strong></div>
      <div class="kg-row"><span>板块</span><strong>${esc(seed.board ?? '—')}</strong></div>
      ${keywords ? `<div class="kg-sub">主题词</div><div class="kg-chips">${keywords}</div>` : ''}
      <p class="kg-hint">点一个点看它的详情；点标签可以只留下它的邻居；点帖子会直接跳过去。</p>`;
  }
  const meta = kg.byId.get(focus.id) ?? {};
  const isPost = focus.type === 'document' || focus.type === 'seed';
  const neighbors = kg.neighbors.get(focus.id) ?? new Set();
  const rows = [
    `<div class="kg-row"><span>类型</span><strong>${esc(KG_TYPE_LABEL[focus.type] ?? focus.type)}</strong></div>`,
    `<div class="kg-row"><span>连线</span><strong>${neighbors.size} 条</strong></div>`,
  ];
  if (isPost) {
    if (focus.relevance != null) rows.push(`<div class="kg-row"><span>相关度</span><strong>${(focus.relevance * 100).toFixed(1)}%</strong></div>`);
    if (focus.confidence) rows.push(`<div class="kg-row"><span>置信度</span><strong>${esc(focus.confidence)}</strong></div>`);
    if (focus.board) rows.push(`<div class="kg-row"><span>板块</span><strong>${esc(focus.board)}</strong></div>`);
  }
  return `
    <div class="kg-panel-title">${esc(focus.label)}</div>
    ${rows.join('')}
    ${
      isPost && focus.postId != null
        ? `<a class="btn btn-sm btn-primary kg-open" href="#/post/${focus.postId}">打开这篇帖子</a>`
        : '<p class="kg-hint">点空白处可以取消选择。</p>'
    }`;
}
function kgRenderPanel() {
  const panel = document.getElementById('kg-panel');
  if (panel) panel.innerHTML = kgPanelHtml();
}
function kgBind() {
  const canvas = kg.canvas;
  if (!canvas) return;

  canvas.addEventListener('pointerdown', (event) => {
    const world = kgToWorld(event.clientX, event.clientY);
    const node = kgNodeAt(world.x, world.y);
    canvas.setPointerCapture(event.pointerId);
    if (node) {
      kg.selected = kg.selected?.id === node.id ? null : node;
      kg.drag = node;
    } else {
      kg.pan = { x: event.clientX - kg.offsetX, y: event.clientY - kg.offsetY };
    }
    kgRenderPanel();
  });

  canvas.addEventListener('pointermove', (event) => {
    if (kg.drag) {
      const world = kgToWorld(event.clientX, event.clientY);
      kg.drag.x = world.x;
      kg.drag.y = world.y;
      kg.drag.vx = 0;
      kg.drag.vy = 0;
      return;
    }
    if (kg.pan) {
      kg.offsetX = event.clientX - kg.pan.x;
      kg.offsetY = event.clientY - kg.pan.y;
      return;
    }
    const world = kgToWorld(event.clientX, event.clientY);
    const node = kgNodeAt(world.x, world.y);
    canvas.style.cursor = node ? 'pointer' : 'grab';
    if ((node?.id ?? null) !== (kg.hover?.id ?? null)) {
      kg.hover = node;
      kgRenderPanel();
    }
  });

  const endDrag = (event) => {
    if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    kg.drag = null;
    kg.pan = null;
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    const factor = event.deltaY < 0 ? 1.12 : 0.89;
    const next = Math.max(0.2, Math.min(4, kg.scale * factor));
    // 以鼠标位置为锚点缩放
    kg.offsetX = px - ((px - kg.offsetX) * next) / kg.scale;
    kg.offsetY = py - ((py - kg.offsetY) * next) / kg.scale;
    kg.scale = next;
  }, { passive: false });

  const refit = document.getElementById('kgRefit');
  if (refit) refit.onclick = () => {
    kg.scale = 1;
    kg.offsetX = 0;
    kg.offsetY = 0;
  };
  const relayout = document.getElementById('kgRelayout');
  if (relayout) relayout.onclick = () => {
    kgLayout();
    kgDraw();
  };
  const clear = document.getElementById('kgClear');
  if (clear) clear.onclick = () => {
    kg.selected = null;
    kgRenderPanel();
  };
}
function kgTagChipsHtml() {
  return kg.nodes
    .filter((node) => node.type === 'tag')
    .sort((a, b) => (b.degree ?? 0) - (a.degree ?? 0))
    .map((node) => `<button class="kg-chip" type="button" data-kg-tag="${esc(node.id)}">${esc(node.label)}</button>`)
    .join('');
}
function renderGraphPage(payload) {
  const { graph, status } = payload;
  const stats = graph.stats ?? {};
  kg.meta = graph;
  kg.nodes = (graph.nodes ?? []).map((node) => ({ ...node }));
  kg.edges = graph.edges ?? [];
  kg.byId = new Map(kg.nodes.map((node) => [node.id, node]));
  kgNeighbors();
  kg.selected = null;
  kg.hover = null;

  ui.app.innerHTML = `
    <section class="card">
      <div class="card-head">
        <h1 style="font-size:21px">🕸 知识网络图</h1>
        <div class="kg-actions">
          <button class="btn btn-sm" type="button" id="kgRefit">🎯 回到中心</button>
          <button class="btn btn-sm" type="button" id="kgRelayout">🔄 重新布局</button>
          <button class="btn btn-sm" type="button" id="kgClear">✖ 取消选择</button>
          <a class="btn btn-sm" href="/api/knowledge/viewer" target="_blank" rel="noopener">↗ 打开原版大图</a>
        </div>
      </div>
      <div class="page-sub">
        把论坛的帖子按「内容相近 / 被互相引用 / 共用标签」连成一张网，方便顺着线索往下读。
        这张图是离线的：点了「重新布局」只是重画，不会重新计算。
      </div>
      <div class="kg-stats">
        <span class="kg-stat"><strong>${Fmt.fmtNum(stats.posts ?? 0)}</strong> 篇帖子</span>
        <span class="kg-stat"><strong>${Fmt.fmtNum(stats.tags ?? 0)}</strong> 个标签</span>
        <span class="kg-stat"><strong>${Fmt.fmtNum(stats.nodes ?? 0)}</strong> 个节点</span>
        <span class="kg-stat"><strong>${Fmt.fmtNum(stats.edges ?? 0)}</strong> 条连线</span>
        <span class="kg-stat"><strong>${Fmt.fmtNum(stats.communities ?? 0)}</strong> 个聚类</span>
      </div>
      ${status?.error ? `<div class="kg-warn">上次生成时出错：${esc(status.error)}</div>` : ''}
    </section>

    <section class="card kg-card">
      <div class="kg-wrap">
        <canvas id="kg-canvas"></canvas>
        <aside class="kg-panel" id="kg-panel"></aside>
      </div>
      <div class="kg-legend">
        ${Object.entries(KG_TYPE_LABEL)
          .map(
            ([type, label]) =>
              `<span class="kg-legend-item"><i style="background:${KG_NODE_COLOR[type]}"></i>${esc(label)}</span>`,
          )
          .join('')}
        <span class="kg-hint">滚轮缩放 · 拖空白平移 · 拖节点挪位置</span>
      </div>
      <div class="kg-sub">点标签筛选</div>
      <div class="kg-chips" id="kg-tags">${kgTagChipsHtml()}</div>
    </section>`;

  kg.canvas = document.getElementById('kg-canvas');
  if (!kg.canvas || !kg.nodes.length) return;
  kgRefreshPalette();
  kgResize();
  kgLayout();
  kgRenderPanel();
  kgBind();

  const tags = document.getElementById('kg-tags');
  if (tags) {
    tags.addEventListener('click', (event) => {
      const button = event.target.closest('[data-kg-tag]');
      if (!button) return;
      const node = kg.byId.get(button.dataset.kgTag);
      kg.selected = kg.selected?.id === node?.id ? null : node ?? null;
      kgRenderPanel();
      kgDraw();
    });
  }

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      kgResize();
      kgDraw();
    }, 150);
  });

  kgStop();
  kgLoop();
}
async function viewGraph() {
  ui.app.innerHTML = loadingHtml();
  let payload;
  try {
    payload = await api('/api/knowledge/graph');
  } catch (error) {
    ui.app.innerHTML = `
      <div class="card">
        ${emptyHtml('🕸', '知识网络图还没有生成', '管理员跑一次 node scripts/build-graph.mjs 就能看到')}
        <div style="text-align:center"><a class="btn btn-sm" href="#/">返回首页</a></div>
      </div>`;
    return;
  }
  renderGraphPage(payload);
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */

// ── 导出 ──────────────────────────────────────────────────────────────
export { KG_NODE_COLOR };
export { KG_EDGE_STYLE };
export { KG_TYPE_LABEL };
export { kg };
export { kgRadius };
export { kgLayout };
export { kgResize };
export { kgStep };
export { kgFocus };
export { kgIsDim };
export { kgToWorld };
export { kgNodeAt };
export { kgDraw };
export { kgPalette };
export { kgRefreshPalette };
export { kgStop };
export { kgLoop };
export { kgNeighbors };
export { kgPanelHtml };
export { kgRenderPanel };
export { kgBind };
export { kgTagChipsHtml };
export { renderGraphPage };
export { viewGraph };

/* @hand-written */
