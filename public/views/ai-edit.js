// AI 编辑台（P3）：选文档 → 选范围（整篇 / 按小节）→ 草拟 → 真的落盘 / 回滚，
// 外加能力授权与全站用量。
//
// 粒度**只有两种**，这是刻意的：
//   · 整篇（scope = 'document'）：把整篇 Markdown 交给模型。最贵，也最容易改坏结构。
//   · 按小节（scope = 'section'）：按小标题把文档切成若干节，只把选中的那一节发出去。
// 以前那种「选一个块、改一个块」的单块流程**已经拿掉了**：块太小，改一句话要点三次
// 下拉，而作者真正想说的是「这一节重写一下」。单块的 `POST /api/ai-edit/draft` 接口
// 还在（scripts/ai-smoke.mjs 里钉着它），只是这一页不再用它。
//
// ⚠️ 前缀是 `ai-edit` 不是 `ai`。`/api/ai/` 整段被 forum-ai 的挂载层短路了
// （forum-ai/src/mount.mjs:255 的 isAiPath + :330-344 的兜底 404），注册在那下面的
// 宿主路由永远收不到请求。`/api/ai-edit/` 不以 `/api/ai/` 开头，落回宿主路由表。
//
// ⚠️ 这一页的控件全部**就地绑定**（跟知识网络图、学术笔记一个做法），不接
// public/core/events.js 里那个中央 `data-action` 分发 —— 那个 switch 是
// check-ui-contract.mjs 盯着的公共地带，谁都别往里塞自己的动作。
//
// 数据来自两个模块：
//   · src/modules/ai/routes.js   —— /api/ai-edit/*（切分小节、草拟、审计、回滚、用量）
//   · src/modules/doc/routes.js  —— /api/docs*（文档与块，PUT / POST 才是真写进库）
//
// ⚠️ 块的形状是 P2 的原生 `{ blockId, type, version, props }`，type 只能是内置类型之一
// （heading/paragraph/prose/list/code/table/formula/image/quote/poll/wiki/embed/app/script/subpage，
// 目前 15 种；清单以 P2 的 src/modules/doc/blocks/types.js 为准）。这一页发出去的块
// 一律裁成 `{ blockId, type, props }` —— 服务端的 sectionBlocksProblem() 会逐项校验。
//
// ⚠️ 小节**不在前端切**。切分算法只有一个实现：src/modules/ai/sections.js。前端把整篇的
// 块丢给 `POST /api/ai-edit/sections`，拿它给回来的清单渲染下拉。两边各切一份必然漂移，
// 而漂移的表现是「下拉里选第 3 节，实际改到别的块」。

import { $, emptyHtml, esc, loadingHtml, toast, ui } from '../core/dom.js';
import { apiErrorText, toastError } from '../core/errors.js';
import { api, withButtonBusy } from '../core/api.js';
import { navigate } from '../core/router.js';
import { state } from '../core/state.js';
import * as Fmt from '../core/format.js';
// 预览面板里的 `app` / `script` 块要真的跑起来（跟 doc.js 的预览一个做法），
// 公式要交给 KaTeX 渲染 —— 两者都**只用**，不改 core 与别的页面。
import { attachSandbox, unmountSandboxes } from '../core/sandbox.js';
import { ntRenderMath } from './notes.js';

const RISK_LABEL = { low: '低风险', medium: '中风险', high: '高风险' };
const QUOTA_HINT = '0 表示不限次数';
const DEFAULT_INSTRUCTION = '把这一节改得更紧凑，事实不要动';
const NO_TARGET_HINT = '先选一篇文档，再选改哪儿（整篇或某一节）：不选就不知道改的是哪儿';

/** 范围下拉里「整篇」那一项的 value；小节是 `section:<index>`。 */
const SCOPE_DOC = 'document';
const SCOPE_SECTION = 'section:';

/** 服务端的 AI_MAX_SECTION_BLOCKS：一节超过这个块数就塞不进一批 op（一批最多 50 条）。 */
const MAX_SECTION_BLOCKS = 50;
/** 服务端的 AI_MAX_RANGE_CHARS：整篇 / 一节发出去的字符上限。 */
const MAX_RANGE_CHARS = 40000;

/**
 * 内置块类型的中文名（目前 15 种）。只用在预览与操作记录里做显示，
 * 真正管放行的是服务端的 AI_BLOCK_TYPE_NAMES —— 少一项不会报错，
 * 只会让那一类块显示成英文原名（`BLOCK_LABEL[t] || t`）。
 */
const BLOCK_LABEL = {
  heading: '标题',
  paragraph: '段落',
  prose: '小节正文',
  list: '列表',
  code: '代码',
  table: '表格',
  formula: '公式',
  image: '图片',
  quote: '引用',
  poll: '投票',
  wiki: '百科卡片',
  embed: '嵌入',
  app: '小应用',
  script: '脚本',
  subpage: '子页',
};

const TARGET_LABEL = { document: '整篇', doc_section: '按小节', block: '单块', document_block: '单块' };

const aeState = {
  capabilities: [],
  ops: [],
  total: 0,
  /** 草稿：draft-range 的返回 —— FR-CAP-06 要求先看再落盘 */
  draft: null,
  /** 回滚交回来的旧值，展示用 */
  restore: null,
  /** 整篇落盘撞上 409（块数暴跌）时挂这儿，等用户点确认 */
  pendingConflict: null,
  configError: '',
  /**
   * 改写要求的备份。aeRender() 是整体重建 DOM：重建时只能拿它回填，
   * 否则「草拟失败」会把用户刚敲进去的要求整个抹掉。
   * 字段名 instructionInput / blockInput 是 scripts/ai-smoke.mjs 的静态哨兵，别改名。
   * `blockInput` 现在装的是**要发出去的那份内容**（整篇 Markdown 或一节块 JSON）：
   * 界面上不再有 JSON 框，它只是草拟的载荷备份（重建 DOM 时不至于丢）。
   */
  instructionInput: '',
  blockInput: '',
  /* ---- 预览（改动前 / 模型建议）：两个面板都是渲染出来的 HTML，界面上不出现 JSON ---- */
  /** 改动前的 Markdown：整篇 = 全文；按小节 = 从全文里切出来的那一节 */
  beforeMarkdown: '',
  /** 上面这份 Markdown 的来路说明（切不准时写「显示的是整篇」） */
  beforeNote: '',
  /* ---- 目标：改哪一篇的哪个范围 ---- */
  documents: [],
  /** 'mine'（我的）| 'all'（全站）：下拉取空的降级开关 */
  docScope: 'mine',
  docDegraded: false,
  docError: '',
  documentId: '',
  docTitle: '',
  /**
   * 这一篇你改不改得动 —— 取 `GET /api/docs/:id` 的 `data.abilities.canEdit`。
   *
   * 文档列表项里**不带** abilities（src/modules/doc/shape.js 的 shapeDoc 只给 author/scope/时间），
   * 而「我名下没有文档就自动切全站」那条路会让普通用户看到别人的文档：那种文档
   * `POST /api/docs/:id/preview` 会 403（P2 的 mustEdit），落盘也会 403。
   * 所以锁定文档之后立刻按 canEdit 把草拟/落盘禁掉，别留个转圈让人干等。
   * 拿不到 abilities 时按「能改」处理（列表接口本来就不给，缺了就锁死反而更糟）。
   */
  canEdit: true,
  blocks: [],
  /** 服务端切好的小节清单（POST /api/ai-edit/sections） */
  sections: [],
  sectionsTotal: 0,
  sectionsError: '',
  blocksLoading: false,
  /** '' | 'document' | 'section:<index>' */
  rangeValue: '',
  /** 读范围内容失败（整篇 Markdown 取不回来 / 找不到那一节） */
  rangeError: '',
  markdownLoading: false,
  docMarkdown: null,
  /** docMarkdown 是哪一篇的（换文档要重取） */
  docMarkdownFor: '',
  /* ---- 全站用量（管理员专属） ---- */
  /** null=没拿到；>=400 时整个区块静默隐藏 */
  usage: null,
  usageStatus: 0,
  usageError: '',
};

let loadToken = 0;
let blockToken = 0;

const chip = (text, kind = '') => `<span class="ai-chip ${kind}">${esc(text)}</span>`;

function riskKind(risk) {
  return risk === 'high' ? 'warn' : risk === 'medium' ? 'soft' : 'ok';
}

/** 长文本截断：操作记录里 before/after 可能是整篇 Markdown，不能整段铺满页面。 */
function clip(text, limit) {
  const value = String(text ?? '');
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n…（还有 ${value.length - limit} 字符，已截断）`;
}

function shortJson(value, limit = 1200) {
  try {
    return clip(typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2), limit);
  } catch {
    return '（无法序列化）';
  }
}

/* ---------- 范围（整篇 / 某一节） ---------- */

function parseRange(value) {
  const raw = String(value ?? '');
  if (raw === SCOPE_DOC) return { kind: 'document' };
  if (raw.startsWith(SCOPE_SECTION)) {
    const index = Number(raw.slice(SCOPE_SECTION.length));
    return Number.isInteger(index) && index >= 0 ? { kind: 'section', index } : null;
  }
  return null;
}

function currentRange() {
  return parseRange(aeState.rangeValue);
}

function findSection(index) {
  return aeState.sections.find((section) => Number(section.index) === Number(index)) ?? null;
}

/** 发给服务端的块：只留 { blockId, type, props }，多余的键别往里塞。 */
function toRangeBlock(block) {
  return { blockId: block.blockId, type: block.type, props: block.props ?? {} };
}

/** 这一节在文档里的块（按文档顺序），用于渲染「范围内容」框。 */
function sectionBodyBlocks(section) {
  const ids = new Set(section?.blockIds ?? []);
  if (!ids.size) return [];
  return aeState.blocks.filter((block) => ids.has(block.blockId)).map(toRangeBlock);
}

function rangeLabel() {
  const range = currentRange();
  if (!range) return '';
  if (range.kind === 'document') {
    const total = aeState.sectionsTotal || aeState.blocks.length;
    return `整篇（共 ${total} 块）`;
  }
  const section = findSection(range.index);
  if (!section) return `第 ${range.index + 1} 节`;
  return `第 ${Number(section.index) + 1} 节 · ${section.heading || '（无标题）'}（${section.blockCount} 块）`;
}

/* ---------- 目标：文档与范围 ---------- */

function docLabel(doc) {
  const title = doc.title || '（无标题）';
  const kind = doc.kindLabel || doc.kind || '文档';
  return `${title} · ${kind}`;
}

function blockLabel(block) {
  const name = BLOCK_LABEL[block?.type] || block?.type || '未知';
  const props = block?.props || {};
  const digest = String(props.question ?? props.text ?? props.title ?? props.code ?? '').replace(/\s+/g, ' ').trim();
  const short = digest.length > 24 ? `${digest.slice(0, 24)}…` : digest;
  return `${block?.blockId ?? '?'} · ${name}（${block?.type ?? '?'}）${short ? ` · ${short}` : ''}`;
}

function aeOptionHtml(value, label, selected) {
  return `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`;
}

function findDocument(id) {
  return aeState.documents.find((doc) => String(doc.id) === String(id)) || null;
}

function aeDocSelectHtml() {
  const options = aeState.documents
    .map((doc) => aeOptionHtml(doc.id, docLabel(doc), String(doc.id) === String(aeState.documentId)))
    .join('');
  const empty =
    aeState.docScope === 'all'
      ? '站内一篇积木文档都没有，先去 #/blocks 建一篇'
      : '你名下还没有积木文档，去 #/blocks 建一篇，或点上面的「看全站」';
  return `
      <select class="ae-input ae-select" data-ae-doc aria-label="选择文档">
        <option value="">— 选一篇文档 —</option>
        ${options}
        ${options ? '' : `<option value="" disabled>${esc(empty)}</option>`}
      </select>`;
}

function aeRangeSelectHtml() {
  if (aeState.blocksLoading) return '<div class="ae-placeholder">正在读这篇文档的块，并让服务端切分小节…</div>';
  if (!aeState.documentId) return '<div class="ae-placeholder">先选上面的文档，这里才会列出它的范围（整篇 / 各小节）。</div>';
  if (aeState.sectionsError) {
    return `<div class="ae-placeholder">小节切分失败：${esc(aeState.sectionsError)}（仍然可以选「整篇」）</div>`;
  }
  if (!aeState.blocks.length) return '<div class="ae-placeholder">这篇文档还没有块，换个文档或者先去编辑页加一块。</div>';
  const total = aeState.sectionsTotal || aeState.blocks.length;
  const options = aeState.sections
    .map((section) => {
      const index = Number(section.index);
      const heading = section.heading || '（无标题）';
      const label = `第 ${index + 1} 节 · ${heading}（${section.blockCount} 块）`;
      if (section.tooLarge) {
        // 服务端说这一节超过一批 50 条 op 的上限：能看不能选，理由写在标签里。
        return `<option value="" disabled>${esc(`${label} —— 这一节 ${section.blockCount} 块，超过一批 ${MAX_SECTION_BLOCKS} 条的上限，不能选`)}</option>`;
      }
      const value = `${SCOPE_SECTION}${index}`;
      return aeOptionHtml(value, label, value === aeState.rangeValue);
    })
    .join('');
  return `
      <select class="ae-input ae-select" data-ae-range aria-label="选择改动范围">
        ${aeOptionHtml(SCOPE_DOC, `整篇（共 ${total} 块）`, aeState.rangeValue === SCOPE_DOC)}
        ${options}
      </select>`;
}

function aeRangeHintHtml() {
  if (!aeState.documentId) return '';
  if (aeState.sectionsError) return '小节清单读不到，只剩「整篇」可选；可以先刷新一次再试。';
  const range = currentRange();
  if (!range) return '';
  if (range.kind === 'document') {
    return `整篇 rewrite 会把 <code>GET /api/docs/:id/markdown</code> 取回来的全文发出去 —— 这是最贵的动作。`;
  }
  const section = findSection(range.index);
  if (!section) return '这一节已经不在了（文档被改过），重新选一次范围。';
  const chars = Number(section.chars) || 0;
  const over = chars > MAX_RANGE_CHARS ? ` —— 已经超过服务端 ${MAX_RANGE_CHARS} 字符的上限，请拆成几节分别改` : '';
  return `这一节 ${section.blockCount} 块、约 ${chars} 字符${over}。`;
}

function aeTargetHtml() {
  const doc = findDocument(aeState.documentId);
  const range = currentRange();
  const parts = [];
  if (doc) parts.push(`文档「${doc.title || '（无标题）'}」#${doc.id}`);
  if (doc && range) parts.push(rangeLabel());
  const ready = Boolean(aeState.documentId && range);
  return `
    <section class="card">
      <div class="card-head">
        <h2>目标</h2>
        <span class="ae-target-state">${ready ? '✅ 已锁定改动范围' : '未选定'}</span>
      </div>
      <div class="page-sub">
        两种粒度：<strong>整篇</strong>（整篇 Markdown 交给模型，最贵）或
        <strong>按小节</strong>（按小标题切，只发选中的那一节）。
        草拟、落盘、回滚都作用在这里选中的范围上。
        落盘会<strong>先写文档、后记审计</strong>，改过的都能回滚。
      </div>
      <div class="ae-target">
        <div class="ae-field">
          <div class="ae-field-label">文档</div>
          ${aeDocSelectHtml()}
          <div class="ae-field-hint">
            ${
              aeState.docScope === 'mine'
                ? '只看自己的文档（<code>mine=1</code>）'
                : '看全站文档（已从「我的文档」降级）'
            }
            <button class="btn btn-sm" type="button" data-ae-act="toggle-scope">${
              aeState.docScope === 'mine' ? '看全站' : '只看我的'
            }</button>
          </div>
        </div>
        <div class="ae-field">
          <div class="ae-field-label">范围</div>
          ${aeRangeSelectHtml()}
          <div class="ae-field-hint">${
            aeState.documentId
              ? `切分小节由服务端做（<code>POST /api/ai-edit/sections</code>），只读不改，不需要能力授权。${aeRangeHintHtml()}`
              : '整篇 = 全文；按小节 = 按小标题切开，只会把选中的那一节发给模型。'
          }</div>
        </div>
      </div>
      <div class="ae-target-line">${
        parts.length ? esc(parts.join(' → ')) : `<span class="ae-target-hint">${NO_TARGET_HINT}</span>`
      }</div>
      ${aeState.docError ? `<div class="ae-note">列表读不出来：${esc(aeState.docError)}</div>` : ''}
      ${
        aeState.documentId && !aeState.canEdit
          ? '<div class="ae-note">这篇不是你写的，AI 编辑台只改得动自己名下的文档 —— 可以看，但草拟与落盘都关掉了。</div>'
          : ''
      }
      ${aeState.rangeError ? `<div class="ae-note">范围内容读不出来：${esc(aeState.rangeError)}</div>` : ''}
      ${aeState.docDegraded ? '<div class="ae-note">你名下还没有文档，已经自动切成全站列表。</div>' : ''}
    </section>`;
}

/* ---------- 顶部统计 ---------- */

function aeHeadHtml() {
  const granted = aeState.capabilities.filter((item) => item.granted).length;
  const used = aeState.capabilities.reduce((sum, item) => sum + (item.usedToday ?? 0), 0);
  return `
    <section class="card">
      <div class="card-head">
        <h1 style="font-size:21px">🤖 AI 编辑台</h1>
        <button class="btn btn-sm" type="button" data-ae-act="refresh">↻ 刷新</button>
      </div>
      <div class="page-sub">
        六项能力<strong>默认全部关闭</strong>，不开就不许用，随时可以收回。草拟要的是
        <code>edit_content</code>。
        每次使用都会留一条审计日志，改过的东西都能回滚。开关在服务端生效，不只是这一页藏个按钮。
      </div>
      <div class="ae-stats">
        <div class="ae-stat">
          <div class="ae-stat-num">${granted}/6</div>
          <div class="ae-stat-label">已授权能力</div>
        </div>
        <div class="ae-stat">
          <div class="ae-stat-num">${aeState.total}</div>
          <div class="ae-stat-label">审计日志</div>
        </div>
        <div class="ae-stat">
          <div class="ae-stat-num">${used}</div>
          <div class="ae-stat-label">今日已用</div>
        </div>
      </div>
      ${
        aeState.configError
          ? `<div class="ae-note">${esc(aeState.configError)}</div>`
          : ''
      }
    </section>`;
}

/* ---------- 全站用量（管理员专属） ---------- */

function aeUsageTopListHtml(today) {
  const rows = (today.topUsers ?? []).slice(0, 5);
  if (!rows.length) return '<div class="ae-usage-line">今天还没有人用过。</div>';
  return `<div class="ae-usage-top">${rows
    .map(
      (row) =>
        `<div class="ae-usage-user"><span class="ae-usage-name">${esc(row.username || `用户 ${row.userId}`)}</span><span class="ae-usage-count">${row.count ?? 0} 次</span></div>`,
    )
    .join('')}</div>`;
}

function aeUsageHtml() {
  if (!aeState.usage) return '';
  const today = aeState.usage.today ?? {};
  const budget = aeState.usage.budget ?? {};
  const allTime = aeState.usage.allTime ?? {};
  const byAction = (today.byAction ?? []).map((row) => `${row.action} ${row.count}`).join(' · ');
  const budgetText = budget.unlimited
    ? '未设全站上限'
    : `${budget.used ?? 0}/${budget.limit ?? 0}${budget.remaining === null || budget.remaining === undefined ? '' : `（还剩 ${budget.remaining}）`}`;
  return `
    <section class="card">
      <div class="card-head">
        <h2>全站用量</h2>
        <span class="ae-target-state">仅管理员可见</span>
      </div>
      <div class="page-sub">按调用次数统计（这张表没存 token 用量，所以没有金额）。</div>
      <div class="ae-usage">
        <div class="ae-usage-grid">
          <div class="ae-stat">
            <div class="ae-stat-num">${today.total ?? 0}</div>
            <div class="ae-stat-label">今日调用</div>
          </div>
          <div class="ae-stat">
            <div class="ae-stat-num">${today.billed ?? 0}</div>
            <div class="ae-stat-label">计费次数</div>
          </div>
          <div class="ae-stat">
            <div class="ae-stat-num">${today.blocked ?? 0}</div>
            <div class="ae-stat-label">被挡次数</div>
          </div>
          <div class="ae-stat">
            <div class="ae-stat-num">${today.users ?? 0}</div>
            <div class="ae-stat-label">涉及用户</div>
          </div>
        </div>
        <div class="ae-usage-line">全站上限（${esc(budget.envKey || 'AI_DAILY_TOTAL_LIMIT')}）：<strong>${esc(budgetText)}</strong></div>
        <div class="ae-usage-line">历史累计：${allTime.total ?? 0} 次${byAction ? ` · 今日动作：${esc(byAction)}` : ''}</div>
        ${aeUsageTopListHtml(today)}
      </div>
      ${aeState.usageError ? `<div class="ae-note">用量面板读不到：${esc(aeState.usageError)}</div>` : ''}
    </section>`;
}

/* ---------- 能力授权 ---------- */

function aeCapHtml(cap) {
  const on = Boolean(cap.granted);
  return `
    <div class="ae-cap${on ? ' is-on' : ''}" data-ae-cap="${esc(cap.key)}">
      <div class="ae-cap-top">
        <span class="ae-cap-name">${esc(cap.label || cap.key)}</span>
        ${chip(RISK_LABEL[cap.risk] || cap.risk || '未知', riskKind(cap.risk))}
        ${on ? chip('已授权', 'ok') : chip('未授权', 'soft')}
      </div>
      <div class="ae-cap-body">
        <div class="ae-cap-key">${esc(cap.key)}</div>
        <div class="ae-cap-meta">
          <span>今日已用 ${cap.usedToday ?? 0}</span>
          <span>每日配额 ${cap.dailyQuota ?? 0}${on ? '' : `（${QUOTA_HINT}）`}</span>
          ${cap.expiresAt ? `<span>到期 ${esc(Fmt.fullTime(cap.expiresAt))}</span>` : '<span>长期有效</span>'}
        </div>
      </div>
      <div class="ae-cap-actions">
        <label class="ae-quota">配额
          <input class="ae-input" type="number" min="0" max="1000" step="1"
            value="${Number.isFinite(Number(cap.dailyQuota)) ? Number(cap.dailyQuota) : 0}"
            data-ae-quota aria-label="每日配额">
        </label>
        ${
          on
            ? `<button class="btn btn-sm" type="button" data-ae-act="revoke" data-ae-cap="${esc(cap.key)}">收回</button>`
            : `<button class="btn btn-sm btn-primary" type="button" data-ae-act="grant" data-ae-cap="${esc(cap.key)}">授权</button>`
        }
      </div>
      ${
        cap.highRisk
          ? `<label class="ae-confirm"><input type="checkbox" data-ae-confirm> 这是高风险能力，我确认授权（服务端要求 confirm）</label>`
          : ''
      }
    </div>`;
}

function aeCapsHtml() {
  if (!aeState.capabilities.length) {
    return `<section class="card">${emptyHtml('🎛', '没读到能力目录', '服务端 /api/ai-edit/capabilities 没有返回内容')}</section>`;
  }
  return `
    <section class="card">
      <div class="card-head">
        <h2>能力开关</h2>
        <span class="ae-target-state">默认全部关闭</span>
      </div>
      <div class="ae-grid">${aeState.capabilities.map(aeCapHtml).join('')}</div>
    </section>`;
}

/* ---------- 草稿与落盘 ---------- */

function draftIsDocument(draft) {
  return (draft?.scope ?? '') === 'document';
}

/**
 * 两个块「一不一样」（只比落盘真正依赖的 type 与 props，键序无关）。
 * 服务端的 `changedCount` 是按这个口径数出来的；拿不到它时前端退化成自己比一遍。
 */
function blockSame(a, b) {
  if (!a || !b) return false;
  if (String(a.type ?? '') !== String(b.type ?? '')) return false;
  const propsA = a.props && typeof a.props === 'object' ? a.props : {};
  const propsB = b.props && typeof b.props === 'object' ? b.props : {};
  const keysA = Object.keys(propsA).sort();
  const keysB = Object.keys(propsB).sort();
  if (keysA.length !== keysB.length) return false;
  for (const [index, key] of keysA.entries()) {
    if (key !== keysB[index]) return false;
    if (JSON.stringify(propsA[key]) !== JSON.stringify(propsB[key])) return false;
  }
  return true;
}

/** 按小节草拟出来的这一节一共几块（`before` 是整节原块）。 */
function draftSectionTotal(draft) {
  return Array.isArray(draft?.before) ? draft.before.length : 0;
}

/** 服务端说「真的改了几块」；没有这个字段就自己跟 before 比一遍。 */
function draftChangedCount(draft) {
  const stated = Number(draft?.changedCount);
  if (Number.isFinite(stated)) return stated;
  const before = Array.isArray(draft?.before) ? draft.before : [];
  const after = Array.isArray(draft?.patch?.blocks) ? draft.patch.blocks : [];
  const byId = new Map(before.map((block) => [String(block?.blockId ?? ''), block]));
  let changed = 0;
  for (const block of after) {
    const old = byId.get(String(block?.blockId ?? ''));
    if (!old || !blockSame(old, block)) changed += 1;
  }
  return changed;
}

function draftHasChange(draft) {
  if (!draft) return false;
  if (draftIsDocument(draft)) {
    return String(draft.patch?.markdown ?? '') !== String(draft.before?.markdown ?? '');
  }
  return draftChangedCount(draft) > 0;
}

function draftMetaText(draft) {
  const bits = [draftIsDocument(draft) ? '整篇' : '按小节'];
  if (draft.model) bits.push(`模型 ${draft.model}`);
  if (!draftIsDocument(draft)) {
    const total = draftSectionTotal(draft);
    bits.push(total ? `改了 ${draftChangedCount(draft)} 块 / 这一节共 ${total} 块` : `改了 ${draftChangedCount(draft)} 块`);
  }
  // 服务端会把模型写歪的形状就地摆正（`src/modules/ai/programs.js`：自造字段、
  // 裸写的 `doc:app` 之类）。静悄悄替模型收拾干净最难查，所以这里明说。
  if (typeof draft.repairs === 'string' && draft.repairs !== '') bits.push(`已摆正形状：${draft.repairs}`);
  if (!draftHasChange(draft)) bits.push('模型这次没改动任何内容');
  return bits.join(' · ');
}

/* ---------- 预览：渲染一律交给 P2 的渲染器，界面上不出现 JSON ---------- */

/**
 * 预览 HTML 的小缓存。键是「文档 + Markdown 原文」——
 * Markdown 一变键就变，所以落盘后重新拉一次自然拿到新渲染，不会读到旧画面。
 */
const previewCache = new Map();
const PREVIEW_CACHE_MAX = 12;

function aePreviewKey(documentId, markdown) {
  return `${documentId}\u0000${markdown}`;
}

function aeRememberPreview(key, entry) {
  previewCache.set(key, entry);
  // 只留最近几条（一篇文档的整篇 + 几节片段），别让长 Markdown 一直占着内存。
  while (previewCache.size > PREVIEW_CACHE_MAX) {
    const oldest = previewCache.keys().next();
    if (oldest.done) break;
    previewCache.delete(oldest.value);
  }
}

/** 换文档时清掉：缓存里那些预览是另一篇的。 */
function aeClearPreviews() {
  previewCache.clear();
}

/** warnings 原样显示（P2 的解析器会诚实地说哪儿有损），字符串与 {message} 两种形状都认。 */
function aePreviewWarningText(entry) {
  const items = Array.isArray(entry?.warnings) ? entry.warnings : [];
  const text = items
    .map((item) => (typeof item === 'string' ? item : String(item?.message ?? item?.text ?? '')))
    .filter(Boolean)
    .join('；');
  return text ? `解析提示：${text}` : '';
}

/** 预览里的 `app` / `script` 块的 iframe 挂上宿主（照 doc.js 的 mountSandboxes 抄）。 */
function aeMountSandboxes(root, blocks) {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  const byId = new Map((Array.isArray(blocks) ? blocks : []).map((block) => [block?.blockId, block]));
  let frames = [];
  try {
    frames = Array.from(root.querySelectorAll('iframe.doc-app-frame') ?? []);
  } catch {
    frames = [];
  }
  for (const frame of frames) {
    try {
      attachSandbox(frame, byId.get(frame?.dataset?.docBlock ?? '') ?? null, {
        documentId: aeState.documentId,
        // 预览里的脚本往派生层写时**不**重画整页 —— 那会把刚草拟出来的面板冲掉。
        onDerivedChange: null,
      });
    } catch (error) {
      console.warn('[ai-edit] 预览里的沙箱没挂上：', error);
    }
  }
}

/** 把一份渲染结果画进某个面板（before / after）；面板可能已经被重建，所以每次现找。 */
function aePaintPreview(slot, entry) {
  const body = $(`[data-ae-panel="${slot}"]`);
  if (!body) return; // 面板已经不在了（换了文档 / 丢了草稿），这次结果作废
  if (entry?.error) {
    // 渲染失败不等于内容坏了：草稿还在，落盘照走。
    body.innerHTML = `<div class="ae-placeholder">预览渲染不出来：${esc(entry.error)}（内容本身没丢，落盘不受影响）</div>`;
  } else if (!entry?.html) {
    body.innerHTML = '<div class="ae-placeholder">这段内容没有渲染出任何东西（可能是空的）。</div>';
  } else {
    body.innerHTML = entry.html;
    aeMountSandboxes(body, entry.blocks);
    try {
      ntRenderMath(body);
    } catch {
      /* 公式渲染是加分项，失败不影响别的 */
    }
  }
  const warn = $(`[data-ae-panel-warn="${slot}"]`);
  if (warn) warn.textContent = aePreviewWarningText(entry);
}

/** 取一段 Markdown 的渲染结果并画进面板；渲染走 POST /api/docs/:id/preview（纯读，不落库）。 */
async function aeFillPreview(slot, markdown, documentId) {
  const key = aePreviewKey(documentId, markdown);
  const cached = previewCache.get(key);
  if (cached) {
    aePaintPreview(slot, cached);
    return;
  }
  let entry = null;
  try {
    const data = await api(`/api/docs/${encodeURIComponent(documentId)}/preview`, {
      method: 'POST',
      body: { markdown },
    });
    entry = {
      html: String(data?.html ?? ''),
      warnings: Array.isArray(data?.warnings) ? data.warnings : [],
      blocks: Array.isArray(data?.blocks) ? data.blocks : [],
      error: '',
    };
  } catch (error) {
    // 403 是这条路最常见的失败（文档不是你写的），别让它变成一句干巴巴的 forbidden。
    const text =
      error?.status === 403 || error?.code === 'forbidden'
        ? `预览被拒了：这个文档你没有编辑权${error.message ? `（${error.message}）` : ''} —— 落盘同样会被拒。`
        : error.message;
    entry = { html: '', warnings: [], blocks: [], error: text };
  }
  if (String(aeState.documentId) !== String(documentId)) return; // 用户换了文档，这次结果作废
  if (!entry.error) aeRememberPreview(key, entry);
  aePaintPreview(slot, entry);
}

/**
 * 画草稿卡片上的两个预览面板。aeRender() 末尾调一次（不 await）。
 *
 * 顺序上先 `unmountSandboxes()` 再逐个画：上一轮渲染的 iframe 已经被 innerHTML 丢掉，
 * 而它们的看门狗还挂在 registry 里；但**只清这一次** —— 每画一个面板都清一遍会把
 * 另一个面板刚挂上的看门狗掐掉。
 */
async function aePaintPreviews() {
  const documentId = aeState.documentId;
  if (!documentId) return;
  if (!aeState.canEdit) return; // 没有编辑权：P2 的 /preview 会 403，别去撞
  const plans = [];
  if (aeState.beforeMarkdown && $('[data-ae-panel="before"]')) plans.push(['before', aeState.beforeMarkdown]);
  const after = String(aeState.draft?.patch?.markdown ?? '');
  if (after && $('[data-ae-panel="after"]')) plans.push(['after', after]);
  if (!plans.length) return;
  try {
    unmountSandboxes();
  } catch {
    /* 清不掉也不影响预览的静态部分 */
  }
  for (const [slot, markdown] of plans) {
    await aeFillPreview(slot, markdown, documentId); // 串行：两个面板都要挂沙箱，先后分明
    if (String(aeState.documentId) !== String(documentId)) return;
  }
}

/* ---------- 按小节显示时：从整篇 Markdown 里切出这一节（只用于显示） ---------- */

const SLICE_MISS_NOTE = '这一节在 Markdown 里定位不准，显示的是整篇 —— 请以左边全文为准。';

/**
 * 一行是不是标题行（`# 标题`）；是的话给出级别与标题文字。
 *
 * 这里**不用**拼正则去匹配标题文字：直接比较行首 `#` 的数量与标题文本，
 * 既省掉转义正则元字符那一步，也不会因为标题里有 `.` `(` `*` 而匹配错。
 */
function markdownHeadingAt(line) {
  const found = /^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/.exec(String(line ?? ''));
  if (!found) return null;
  return { level: found[1].length, text: found[2].replace(/\s+/g, ' ').trim() };
}

/**
 * 从整篇 Markdown 里切出某一节的片段 —— **只用于显示**，永远不用它写盘
 * （写盘走块 + `POST /api/docs/:id/ops`，跟这里无关）。
 *
 * 切法（用 `/sections` 给的 heading / level）：从那个标题行开始，
 * 到下一个「同级或更高级」的标题行之前。
 *
 * 容错优先：锚点找不到 / 找到多个 / 切出来是空 → **退回整篇**并写明，
 * 绝不因为切错就让整个面板报错。
 */
function sliceSectionMarkdown(markdown, section) {
  const text = String(markdown ?? '');
  const miss = () => ({ text, note: SLICE_MISS_NOTE });
  if (!text) return { text: '', note: '' };
  const level = Number(section?.level) || 0;
  const heading = String(section?.heading ?? '').replace(/\s+/g, ' ').trim();
  // level 0 / 空标题 = 第一节「开头（第一个小标题之前）」。
  if (level < 1 || level > 6 || !heading) return sliceOpeningSection(text);
  const lines = text.split('\n');
  const exact = [];
  const loose = [];
  for (let at = 0; at < lines.length; at += 1) {
    const found = markdownHeadingAt(lines[at]);
    if (!found || found.text !== heading) continue;
    // 服务端把标题截到 80 字，截断过的标题这里必然对不上 —— 那几行算「宽松命中」，
    // 只有它孤零零一条时才敢用。
    (found.level === level ? exact : loose).push(at);
  }
  const starts = exact.length ? exact : loose;
  if (starts.length !== 1) return miss();
  const start = starts[0];
  let end = lines.length;
  for (let at = start + 1; at < lines.length; at += 1) {
    const found = markdownHeadingAt(lines[at]);
    if (found && found.level <= level) {
      end = at;
      break;
    }
  }
  const sliced = lines.slice(start, end).join('\n').trim();
  return sliced ? { text: sliced, note: '' } : miss();
}

/** 第一节（第一个小标题之前）：文首到第一个标题行之前；切出来是空就当没对准。 */
function sliceOpeningSection(text) {
  const lines = text.split('\n');
  let end = lines.length; // 整篇一个标题都没有：这一节就是全文，不算切错
  for (let at = 0; at < lines.length; at += 1) {
    if (markdownHeadingAt(lines[at])) {
      end = at;
      break;
    }
  }
  const sliced = lines.slice(0, end).join('\n').trim();
  return sliced ? { text: sliced, note: '' } : { text, note: SLICE_MISS_NOTE };
}

/** 一个预览面板：标题 + 渲染容器（.md 是站点现成的正文排版）+ 解析提示。 */
function aePreviewPanelHtml(slot, title, bodyHtml, note) {
  return `
        <div class="ae-preview-col">
          <div class="ae-preview-title">${esc(title)}</div>
          ${bodyHtml}
          <div class="ae-preview-warn" data-ae-panel-warn="${slot}"></div>
          ${note ? `<div class="ae-field-hint">${esc(note)}</div>` : ''}
        </div>`;
}

/** 渲染容器的占位（真内容由 aePaintPreview() 画进去）。 */
function aePreviewSlotHtml(slot) {
  return `<div class="ae-preview-body md" data-ae-panel="${slot}"><div class="ae-placeholder">正在渲染预览…</div></div>`;
}

/** 整篇才给的「看 Markdown 源码」—— 默认折叠；Markdown 不是 JSON，允许露出来。 */
function aeWholeDocSourceHtml(draft, afterMarkdown) {
  if (!draft || !draftIsDocument(draft)) return '';
  const before = String(draft.before?.markdown ?? '');
  return `
      <details class="ae-source">
        <summary>看 Markdown 源码（改动前 / 模型建议）</summary>
        <div class="ae-preview">
          <div class="ae-preview-col">
            <div class="ae-preview-title">改动前</div>
            <pre class="ae-preview-code">${esc(clip(before, 4000))}</pre>
          </div>
          <div class="ae-preview-col">
            <div class="ae-preview-title">模型建议</div>
            <pre class="ae-preview-code">${esc(clip(afterMarkdown, 4000))}</pre>
          </div>
        </div>
      </details>`;
}

function aeConflictHtml() {
  const conflict = aeState.pendingConflict;
  if (!conflict) return '';
  return `
      <div class="ae-note ae-conflict">
        <div>${esc(conflict.message || '块数会暴跌，确认这样存？')}</div>
        <div class="ae-cap-actions">
          <button class="btn btn-sm btn-primary" type="button" data-ae-act="confirm-write">确认，就这么存</button>
          <button class="btn btn-sm" type="button" data-ae-act="cancel-write">取消</button>
        </div>
      </div>`;
}

function aeDraftHtml() {
  const draft = aeState.draft;
  const restore = aeState.restore;
  const range = currentRange();
  const ready = Boolean(aeState.documentId && range);
  const isDoc = range?.kind === 'document';
  const instruction = aeState.instructionInput || DEFAULT_INSTRUCTION;
  // 「改动前」那份 Markdown 的长度 —— 只有整篇的价钱跟它直接相关。
  const chars = String(aeState.beforeMarkdown ?? '').length;
  const tooBig = chars > MAX_RANGE_CHARS;
  const section = range?.kind === 'section' ? findSection(range.index) : null;
  const costHint = isDoc
    ? `整篇改写是最贵的动作：这一篇 ${chars} 字符${
        tooBig ? `，已经超过服务端 ${MAX_RANGE_CHARS} 字符的上限 —— 整篇太大就改用「按小节」` : ''
      }。`
    : '按小节只把选中的这一节发给模型，比整篇便宜。';
  const afterMarkdown = String(draft?.patch?.markdown ?? '');
  const beforeReady = Boolean(ready && aeState.beforeMarkdown && !aeState.markdownLoading);
  const afterReady = Boolean(draft && afterMarkdown);
  const previewHtml = !ready
    ? ''
    : !aeState.canEdit
      ? `
      <div class="ae-field">
        <div class="ae-field-label">范围内容（渲染预览，只读）</div>
        <div class="ae-placeholder">这篇不是你写的，预览与草拟都用不了（P2 的渲染接口只对有编辑权的人开放）。</div>
      </div>`
      : `
      <div class="ae-field">
        <div class="ae-field-label">范围内容（渲染预览，只读）</div>
        <div class="ae-preview">
          ${aePreviewPanelHtml(
            'before',
            isDoc ? '改动前（整篇）' : `改动前（第 ${Number(section?.index ?? 0) + 1} 节）`,
            beforeReady
              ? aePreviewSlotHtml('before')
              : `<div class="ae-placeholder">${
                  aeState.markdownLoading ? '正在取这篇的 Markdown…' : '这一节/这一篇暂时没有可渲染的内容。'
                }</div>`,
            aeState.beforeNote,
          )}
          ${aePreviewPanelHtml(
            'after',
            isDoc ? '模型建议（整篇）' : '模型建议（这一节）',
            afterReady ? aePreviewSlotHtml('after') : '<div class="ae-placeholder">点「草拟改动」之后，这里显示模型建议渲染出来的样子。</div>',
            '',
          )}
        </div>
        <div class="ae-field-hint">
          两个面板都是<strong>真的渲染</strong>（走 P2 的 <code>POST /api/docs/:id/preview</code>，
          只读、不落库、不建修订）；草稿本身只在浏览器里。
          ${
            isDoc
              ? '按小节没有源码框；整篇的 Markdown 源码在下面折叠着。'
              : '这一页不显示块 JSON —— 落盘走块，预览走 Markdown。'
          }
        </div>
      </div>`;
  return `
    <section class="card">
      <div class="card-head">
        <h2>草稿</h2>
        <span class="ae-target-state">${
          draft ? (draftHasChange(draft) ? '草稿就绪，可以落盘' : '模型没有改动') : ready ? '可以草拟' : '先选目标'
        }</span>
      </div>
      <div class="ae-target-line">${
        range ? esc(rangeLabel()) : `<span class="ae-target-hint">${NO_TARGET_HINT}</span>`
      }</div>
      ${previewHtml}
      <div class="ae-field">
        <div class="ae-field-label">改写要求</div>
        <input class="ae-input" type="text" data-ae-instruction value="${esc(instruction)}" aria-label="改写要求"
          maxlength="2000">
        <div class="ae-field-hint">${ready ? costHint : ''}${
          ready ? `范围：${esc(aeState.documentId ? `${aeState.documentId} → ${rangeLabel()}` : '')}` : ''
        }</div>
      </div>
      <div class="ae-cap-actions">
        <button class="btn btn-sm btn-primary" type="button" data-ae-act="draft"${
          ready && aeState.canEdit && !aeState.markdownLoading && beforeReady ? '' : ' disabled'
        }>✨ 草拟改动</button>
        <button class="btn btn-sm" type="button" data-ae-act="apply"${
          draft && draftHasChange(draft) && aeState.canEdit ? '' : ' disabled'
        }>💾 落盘到文档</button>
        <button class="btn btn-sm" type="button" data-ae-act="discard"${draft ? '' : ' disabled'}>丢弃草稿</button>
      </div>
      ${
        aeState.documentId && !aeState.canEdit
          ? '<div class="ae-note">这篇不是你写的：草拟与落盘都关掉了（换一篇自己名下的文档再改）。</div>'
          : ''
      }
      ${aeConflictHtml()}
      ${
        draft
          ? `<div class="ae-note">
        草稿${esc(draftMetaText(draft)) ? `：${esc(draftMetaText(draft))}。` : '。'}
        草稿只在浏览器里 —— 点「落盘到文档」才会写文档，然后再记一条审计。
      </div>`
          : ''
      }
      ${aeWholeDocSourceHtml(draft, afterMarkdown)}
      ${
        restore
          ? `<div class="ae-note">回滚时服务端交回的旧值：${esc(snapshotText(restore, 600))}</div>`
          : ''
      }
    </section>`;
}

/* ---------- 审计日志 ---------- */

function aeStatusKind(status) {
  if (status === 'applied') return 'ok';
  if (status === 'preview') return 'soft';
  if (status === 'rolled_back') return 'cat';
  return 'warn';
}

const STATUS_LABEL = { applied: '已落盘', preview: '仅预览', rolled_back: '已回滚' };

/** 一条快照（before / after）的值 → 给人看的短文本，长的截断。 */
function snapshotText(value, limit = 700) {
  if (value === null || value === undefined) return '（空）';
  if (Array.isArray(value)) {
    if (!value.length) return '（空数组）';
    return clip(value.map(blockLabel).join('\n'), limit);
  }
  if (typeof value === 'object' && typeof value.markdown === 'string') return clip(value.markdown, limit);
  return shortJson(value, limit);
}

function snapshotKindLabel(value) {
  if (Array.isArray(value)) return '按小节';
  if (value && typeof value === 'object' && typeof value.markdown === 'string') return '整篇';
  return '单块';
}

function aeOpSnapshotHtml(op) {
  if (op.before === null || op.before === undefined || op.after === null || op.after === undefined) return '';
  return `
            <details class="ae-op-detail">
              <summary>${esc(`${snapshotKindLabel(op.before)} · 看改动前 / 改动后`)}</summary>
              <div class="ae-preview">
                <div class="ae-preview-col">
                  <div class="ae-preview-title">改动前</div>
                  <pre class="ae-preview-code">${esc(snapshotText(op.before))}</pre>
                </div>
                <div class="ae-preview-col">
                  <div class="ae-preview-title">改动后</div>
                  <pre class="ae-preview-code">${esc(snapshotText(op.after))}</pre>
                </div>
              </div>
            </details>`;
}

function aeOpsHtml() {
  if (!aeState.ops.length) {
    return `<section class="card">${emptyHtml('🗂', '还没有操作记录', '用过草拟或落盘之后，这里会留一条带 before/after 的审计')}</section>`;
  }
  return `
    <section class="card">
      <div class="card-head">
        <h2>审计日志</h2>
        <span class="ae-target-state">共 ${aeState.total} 条</span>
      </div>
      <div class="ae-ops">
        ${aeState.ops
          .map(
            (op) => `
          <div class="ae-op">
            <div class="ae-op-main">
              <div class="ae-op-title">
                #${op.id} ${esc(op.action || 'edit')}
                ${chip(STATUS_LABEL[op.status] || op.status || '未知', aeStatusKind(op.status))}
                ${chip(TARGET_LABEL[op.targetType] || op.targetType || '未知', 'soft')}
              </div>
              <div class="ae-op-meta">
                <span>${esc(op.targetId || '')}</span>
                <span>${esc(Fmt.fullTime(op.createdAt))}</span>
                ${op.reason ? `<span>${esc(op.reason)}</span>` : ''}
                ${op.rolledBackAt ? `<span>回滚于 ${esc(Fmt.fullTime(op.rolledBackAt))}</span>` : ''}
              </div>
              ${aeOpSnapshotHtml(op)}
            </div>
            <div class="ae-op-actions">
              ${
                op.canRollback
                  ? `<button class="btn btn-sm" type="button" data-ae-act="rollback" data-ae-id="${esc(op.id)}">↩ 回滚</button>`
                  : '<span class="ae-op-meta">不可回滚</span>'
              }
            </div>
          </div>`,
          )
          .join('')}
      </div>
      <div class="ae-note">回滚会把审计里记下的旧值写回文档：按小节写回那一批块，整篇写回整份 Markdown。</div>
    </section>`;
}

function aeRender() {
  ui.app.innerHTML =
    '<div data-ae-root>' +
    aeHeadHtml() +
    aeTargetHtml() +
    aeDraftHtml() +
    aeCapsHtml() +
    aeUsageHtml() +
    aeOpsHtml() +
    '</div>';
  aeBind();
  // 预览面板是异步渲染进去的（走 /preview），重建 DOM 之后补画一次。
  // 不 await：渲染慢不该拖住按钮状态与整页交互。
  void aePaintPreviews();
}

/* ---------- 读数据 ---------- */

async function aeLoadDocuments() {
  const mine = aeState.docScope === 'mine';
  let data = null;
  try {
    data = await api(`/api/docs?limit=50${mine ? '&mine=1' : ''}`);
  } catch (error) {
    aeState.docError = error.message;
    aeState.documents = [];
    return;
  }
  let documents = data?.documents ?? [];
  // mine=1 是「我的」，对还没建过文档的人永远是空的 —— 与其让他看一个空下拉，
  // 不如退化成全站列表（看清楚这一篇是谁的，再决定要不要改）。
  if (mine && !documents.length) {
    try {
      const all = await api('/api/docs?limit=50');
      documents = all?.documents ?? [];
      aeState.docDegraded = documents.length > 0;
      aeState.docScope = 'all';
    } catch (error) {
      aeState.docError = error.message;
    }
  }
  aeState.documents = documents;
  // 之前选中的文档这轮没出现在列表里（被删了 / 切了 scope），目标作废，别拿旧 id 去写。
  if (aeState.documentId && !findDocument(aeState.documentId)) {
    aeState.documentId = '';
    aeState.docTitle = '';
    aeState.blocks = [];
    aeState.sections = [];
    aeState.rangeValue = '';
    aeState.blockInput = '';
    aeState.beforeMarkdown = '';
    aeState.beforeNote = '';
    aeState.docMarkdown = null;
    aeState.docMarkdownFor = '';
    aeState.draft = null;
    aeState.pendingConflict = null;
    aeState.canEdit = true;
    aeClearPreviews();
  }
}

/**
 * 读一篇文档的块，然后让**服务端**切小节（切分算法只在 src/modules/ai/sections.js）。
 *
 * 顺序不能反、也不能自己切：下拉里的小节与 draft-range 校验的那一节必须是同一份清单，
 * 否则会出现「选了第 3 节，实际改到别的块」。
 */
async function aeLoadBlocks(documentId) {
  const token = ++blockToken;
  const keepRange = aeState.rangeValue;
  aeState.blocksLoading = true;
  aeState.blocks = [];
  aeState.sections = [];
  aeState.sectionsError = '';
  aeState.rangeError = '';
  aeState.rangeValue = '';
  aeState.docMarkdown = null;
  aeState.docMarkdownFor = '';
  aeState.beforeMarkdown = '';
  aeState.beforeNote = '';
  aeState.markdownLoading = false;
  aeState.pendingConflict = null;
  aeState.canEdit = true; // 这一篇的判定还没回来，先别锁（见 canEdit 的注释）
  aeClearPreviews(); // 换了文档，缓存里的预览是另一篇的
  aeRender();
  let blocks = [];
  try {
    const data = await api(`/api/docs/${encodeURIComponent(documentId)}`);
    if (token !== blockToken) return; // 用户已经换了文档，这次结果作废
    blocks = data?.blocks ?? [];
    aeState.blocks = blocks;
    aeState.docTitle = data?.doc?.title ?? '';
    // 列表接口不给 abilities；只有明确写了 false 才当「改不动」。
    aeState.canEdit = data?.abilities?.canEdit !== false;
    aeState.docError = '';
  } catch (error) {
    if (token !== blockToken) return;
    aeState.docError = error.message;
    aeState.canEdit = true; // 读不出来时别顺手把按钮锁死，让人自己试
    aeState.blocksLoading = false;
    aeRender();
    return;
  }
  if (blocks.length) {
    try {
      const split = await api('/api/ai-edit/sections', {
        method: 'POST',
        body: { blocks: blocks.map(toRangeBlock) },
      });
      if (token !== blockToken) return;
      aeState.sections = split?.sections ?? [];
      aeState.sectionsTotal = split?.total ?? blocks.length;
      aeState.sectionsError = '';
    } catch (error) {
      if (token !== blockToken) return;
      aeState.sections = [];
      aeState.sectionsError = error.message;
    }
  }
  if (token !== blockToken) return;
  aeState.blocksLoading = false;
  const kept = parseRange(keepRange);
  const keepOk = Boolean(kept) && (kept.kind === 'document' || Boolean(findSection(kept.index)));
  aeState.rangeValue = blocks.length ? (keepOk ? keepRange : SCOPE_DOC) : '';
  aeRender();
  if (aeState.rangeValue) await aeLoadRangeContent(aeState.rangeValue, token);
}

/**
 * 准备选中范围的「改动前」内容。
 *
 * 两个预览面板都只认 Markdown（渲染走 P2 的 `/preview`），所以**两种粒度都要先有 Markdown**：
 *   · 整篇  → `GET /api/docs/:id/markdown` 的全文，原样交给 /preview；
 *   · 按小节 → 同一份全文里按 `/sections` 给的 heading/level 切出这一节（切不准就退回整篇并写明）。
 * 块 JSON 不再出现在界面上；按小节草拟要发的 blocks 直接由 `/sections` 的 blockIds 筛出来。
 */
async function aeLoadRangeContent(value, token = blockToken) {
  const range = parseRange(value);
  aeState.rangeValue = range ? value : '';
  if (!range || !aeState.documentId) {
    aeState.blockInput = '';
    aeState.beforeMarkdown = '';
    aeState.beforeNote = '';
    aeState.rangeError = '';
    aeRender();
    return;
  }
  const section = range.kind === 'section' ? findSection(range.index) : null;
  if (range.kind === 'section' && !section) {
    aeState.blockInput = '';
    aeState.beforeMarkdown = '';
    aeState.beforeNote = '';
    aeState.rangeError = `找不到第 ${range.index + 1} 节，重新选一次范围`;
    aeRender();
    return;
  }
  aeState.rangeError = '';
  const documentId = aeState.documentId;
  // 整篇 Markdown 在切换范围（整篇 ↔ 小节）之间复用：同一篇文档不重复拉。
  const cached = aeState.docMarkdownFor === documentId ? aeState.docMarkdown : null;
  if (!cached) {
    aeState.markdownLoading = true;
    aeState.docMarkdown = null;
    aeState.docMarkdownFor = '';
    aeState.beforeMarkdown = '';
    aeState.beforeNote = '';
    aeRender();
    let data = null;
    try {
      data = await api(`/api/docs/${encodeURIComponent(documentId)}/markdown`);
    } catch (error) {
      if (token !== blockToken) return;
      aeState.docMarkdown = null;
      aeState.docMarkdownFor = '';
      aeState.beforeMarkdown = '';
      aeState.beforeNote = '';
      aeState.markdownLoading = false;
      aeState.rangeError = error.message;
      aeRender();
      return;
    }
    if (token !== blockToken) return;
    aeState.docMarkdown = data ?? null;
    aeState.docMarkdownFor = documentId;
    aeState.markdownLoading = false;
  }
  aeFillBeforeMarkdown(range, section);
  aeRender();
}

/** 按范围把「改动前」的 Markdown 与草拟载荷定下来（切不准只影响显示，不影响落盘）。 */
function aeFillBeforeMarkdown(range, section) {
  const full = String(aeState.docMarkdown?.markdown ?? '');
  if (range.kind === 'document') {
    aeState.blockInput = full;
    aeState.beforeMarkdown = full;
    aeState.beforeNote = '';
    return;
  }
  aeState.blockInput = JSON.stringify(sectionBodyBlocks(section));
  const sliced = sliceSectionMarkdown(full, section);
  aeState.beforeMarkdown = sliced.text;
  aeState.beforeNote = sliced.note;
}

/** 只动 usage，不重建能力/审计（它们各自有自己的失败提示）。 */
async function aeLoadUsage() {
  try {
    const data = await api('/api/ai-edit/usage');
    aeState.usage = data ?? {};
    aeState.usageStatus = 200;
    aeState.usageError = '';
  } catch (error) {
    aeState.usage = null;
    aeState.usageStatus = error.status ?? 0;
    // 非管理员（403）/ 未登录（401）静默隐藏整个区块 —— 这一区本来就不给他们看。
    aeState.usageError = aeState.usageStatus === 200 ? error.message : '';
  }
}

async function aeLoad() {
  const token = ++loadToken;
  try {
    const [caps, ops] = await Promise.all([
      api('/api/ai-edit/capabilities'),
      api('/api/ai-edit/ops?limit=30'),
    ]);
    if (token !== loadToken) return;
    aeState.capabilities = caps?.capabilities ?? [];
    aeState.ops = ops?.ops ?? [];
    aeState.total = ops?.total ?? 0;
    aeState.configError = '';
  } catch (error) {
    if (token !== loadToken) return;
    if (error.code === 'ai_not_configured') {
      aeState.configError = '服务器没配 AI_API_KEY，去配一下才能用草拟（落盘/回滚不受影响）。';
    } else {
      aeState.configError = error.message;
    }
  }
  await aeLoadDocuments(); // 先拿文档列表，才能把上次选中的文档重新选中
  if (token !== loadToken) return;
  aeLoadUsage();
  if (aeState.documentId) await aeLoadBlocks(aeState.documentId);
  else aeRender();
}

async function viewAiEdit() {
  if (!state.me) {
    state.redirect = '/ai-edit';
    navigate('/login');
    return;
  }
  aeState.draft = null;
  aeState.restore = null;
  aeState.pendingConflict = null;
  aeState.blockInput = '';
  aeState.beforeMarkdown = '';
  aeState.beforeNote = '';
  aeState.docMarkdown = null;
  aeState.docMarkdownFor = '';
  aeClearPreviews();
  aeState.canEdit = true;
  aeState.instructionInput = '';
  aeState.docDegraded = false;
  aeState.docError = '';
  aeState.rangeError = '';
  aeState.usageStatus = 0;
  aeState.usageError = '';
  ui.app.innerHTML = loadingHtml();
  await aeLoad();
  aeRender();
}

/* ---------- 动作 ---------- */

/** 按钮忙状态包装：转发给 core/api.js 的 withButtonBusy，只是名字短一点。 */
function withBusy(button, task) {
  return withButtonBusy(button, task);
}

/**
 * 草拟失败的提示。core/errors.js 的 apiErrorText() 会把 >=500 一律说成
 * 「服务器开小差了」—— 那样就把「没配 key」（503 ai_not_configured）和
 * 「没有能力授权」（403）这两个最需要说清楚的失败糊掉了，所以这里先按 code 认一遍。
 */
function aeToastError(error, fallback = '') {
  const code = error?.code ?? '';
  const known = {
    ai_not_configured: '服务器没配 AI_API_KEY，去配一下才能用「草拟」（落盘与回滚不受影响）',
    ai_timeout: '模型超时了：等一会儿再试，或者改成「按小节」把范围缩小',
    ai_rate_limited: 'AI 上游限流了，歇一会儿再试',
    ai_bad_json: '模型吐回来的内容不是合法 JSON，可以直接重试一次',
    ai_unauthorized: 'AI 上游不认这个 key，去检查 AI_API_KEY',
    ai_upstream_error: 'AI 上游报错了，等一会儿再试',
    ai_unreachable: '连不上 AI 上游，检查网络与 AI_BASE_URL',
    rate_limited: '操作太频繁了：每个用户每分钟最多 5 次，歇一会儿再试',
  }[code];
  if (known) {
    toast(known, 'warn');
    return;
  }
  if (error?.status === 403) {
    toast(`没有授权：${error.message}（改内容要 edit_content 能力，去下面的「能力开关」里打开）`, 'warn');
    return;
  }
  const text = apiErrorText(error);
  if (text) toast(text, 'warn');
  else if (fallback) toast(fallback, 'warn');
}

async function aeDraft(button) {
  aeState.instructionInput = $('[data-ae-instruction]')?.value ?? '';
  const instruction = aeState.instructionInput.trim() || DEFAULT_INSTRUCTION;
  const range = currentRange();
  if (!aeState.documentId || !range) {
    toast(NO_TARGET_HINT, 'warn');
    return;
  }
  if (!aeState.canEdit) {
    toast('这篇不是你写的，AI 编辑台只改得动自己名下的文档（按钮也关着）', 'warn');
    return;
  }
  let body = null;
  if (range.kind === 'document') {
    // 整篇没有手改的框了：发出去的就是 `GET /api/docs/:id/markdown` 取回来的那一份。
    const markdown = String(aeState.blockInput ?? '');
    if (!markdown.trim()) {
      toast('还没取到整篇正文（或者这一篇本来就是空的），等一下再点草拟', 'warn');
      return;
    }
    if (markdown.length > MAX_RANGE_CHARS) {
      toast(
        `整篇有 ${markdown.length} 字符，超过服务端 ${MAX_RANGE_CHARS} 的上限 —— 整篇改写是最贵的动作，这一篇请改用「按小节」`,
        'warn',
      );
      return;
    }
    body = {
      scope: 'document',
      documentId: aeState.documentId,
      markdown,
      title: aeState.docMarkdown?.title,
      instruction,
    };
  } else {
    const section = findSection(range.index);
    if (!section) {
      toast('这一节已经不在了，重新选一次范围', 'warn');
      return;
    }
    // 块直接由 `/sections` 给的 blockIds 从原文里筛，界面上不再有可手改的 JSON。
    const blocks = sectionBodyBlocks(section);
    if (!blocks.length) {
      toast('这一节里没有块，换一节再试', 'warn');
      return;
    }
    if (blocks.length > MAX_SECTION_BLOCKS) {
      toast(`这一节 ${blocks.length} 块，超过一批 ${MAX_SECTION_BLOCKS} 条的上限`, 'warn');
      return;
    }
    const chars = JSON.stringify(blocks).length;
    if (chars > MAX_RANGE_CHARS) {
      toast(`这一节约 ${chars} 字符，超过服务端 ${MAX_RANGE_CHARS} 的上限 —— 拆成几节分别改`, 'warn');
      return;
    }
    body = {
      scope: 'section',
      documentId: aeState.documentId,
      heading: section.heading,
      blocks,
      instruction,
    };
  }
  await withBusy(button, async () => {
    try {
      const data = await api('/api/ai-edit/draft-range', { method: 'POST', body });
      aeState.draft = data;
      aeState.restore = null;
      aeState.pendingConflict = null;
      if (draftHasChange(data)) toast('草稿好了，先看再落盘', 'ok');
      else toast('模型这次没改动任何内容，可以先看看它给的回执', 'info');
    } catch (error) {
      aeToastError(error, '草拟失败了，等一会儿再试');
    }
    aeRender();
  });
}

/**
 * 落盘：**先写文档，后记审计**。
 *
 * 顺序为什么不能反：审计说的是「文档已经被改成这样了」，先记审计再写盘，
 * 一旦写盘失败，日志里就躺着一条「已落盘」而文档根本没变 —— 之后照它回滚
 * 反而会把别的改动覆盖掉。反过来写盘成功、审计失败只是少一条记录（下面会
 * 明确 toast 出来），危害小得多。
 */
async function aeApply(button) {
  const draft = aeState.draft;
  if (!draft) return;
  const documentId = draft.documentId || aeState.documentId;
  if (!documentId) {
    toast(NO_TARGET_HINT, 'warn');
    return;
  }
  const reason = (aeState.instructionInput || '').trim();
  if (draftIsDocument(draft)) await aeApplyDocument(button, draft, documentId, reason);
  else await aeApplySection(button, draft, documentId, reason);
}

/**
 * 按小节落盘：`patch.blocks` 现在就是**整节收齐**的那一份（块 id 与 `before` 一一对应，
 * 少一块服务端在 /draft-range 就 502 了），所以照原样当 after 发，不需要前端自己合并。
 * 真正写盘时只挑「比对后确实变了」的块发 replace —— 没变的块没必要抬 version、重算派生层。
 */
async function aeApplySection(button, draft, documentId, reason) {
  const patch = Array.isArray(draft.patch?.blocks) ? draft.patch.blocks : [];
  if (!patch.length) {
    toast('这次草稿里没有可落盘的块，重新草拟一次', 'warn');
    return;
  }
  if (patch.length > MAX_SECTION_BLOCKS) {
    toast(`一次最多写 ${MAX_SECTION_BLOCKS} 块，这一节有 ${patch.length} 块 —— 拆成几节分别改`, 'warn');
    return;
  }
  const before = (Array.isArray(draft.before) ? draft.before : []).map(toRangeBlock);
  const after = patch.map(toRangeBlock);
  // before / after 的 blockId 必须一一对应（服务端也是这么查的，对不上就 400）。
  const aligned =
    before.length === after.length &&
    before.every((block, at) => block.blockId === after[at].blockId);
  if (!aligned) {
    toast('草稿里的块和文档对不上（blockId 变了），先重新草拟一次', 'warn');
    return;
  }
  const changed = after.filter((block, at) => !blockSame(before[at], block));
  if (!changed.length) {
    toast('模型这次没有真正改动任何块，没什么可落盘的', 'warn');
    return;
  }
  const ops = changed.map((block) => ({
    op: 'replace',
    target: block.blockId,
    type: block.type,
    props: block.props ?? {},
  }));
  await withBusy(button, async () => {
    let result = null;
    try {
      result = await api(`/api/docs/${encodeURIComponent(documentId)}/ops`, { method: 'POST', body: { ops } });
    } catch (error) {
      toast(`文档没写成：${error.message}`, 'warn');
      return; // 文档没动，审计也不记，两边保持一致
    }
    const rejected = Array.isArray(result?.rejected) ? result.rejected : [];
    if (rejected.length) {
      // 有块没写进去：如实说是哪几块，并且**不记审计** —— 文档现在不是草稿说的那个样子，
      // 记一条「已落盘」会让之后照它回滚把别的块覆盖掉。
      const detail = rejected
        .map((item) => {
          const target = ops[item.index]?.target ?? `第 ${(item.index ?? 0) + 1} 条`;
          return `${target}（${item.message || item.reason || '没能应用'}）`;
        })
        .join('；');
      toast(`${rejected.length} 块没写进去：${detail}。审计没有记，修好再落一次。`, 'warn');
      aeState.draft = null;
      await aeLoad();
      return;
    }
    try {
      await api('/api/ai-edit/ops', {
        method: 'POST',
        body: { scope: 'section', documentId, before, after, reason, confirm: true },
      });
    } catch (error) {
      toast(`文档已改，但审计没记上：${error.message}`, 'warn');
      aeState.draft = null;
      await aeLoad();
      return;
    }
    aeState.draft = null;
    toast('已写进文档，并记了一条审计（可回滚）', 'ok');
    await aeLoad();
  });
}

/** 整篇：PUT /api/docs/:id/markdown；块数暴跌时服务端回 409，先让用户确认再带 ?confirm=1。 */
async function aeApplyDocument(button, draft, documentId, reason) {
  const markdown = String(draft.patch?.markdown ?? '');
  if (!markdown.trim()) {
    toast('模型给的整篇正文是空的，不能把文档清空', 'warn');
    return;
  }
  const title = draft.patch?.title ?? draft.before?.title;
  const after = title === undefined ? { markdown } : { markdown, title };
  const before = { markdown: String(draft.before?.markdown ?? '') };
  if (draft.before?.title !== undefined) before.title = draft.before.title;
  await withBusy(button, async () => {
    try {
      await api(`/api/docs/${encodeURIComponent(documentId)}/markdown`, {
        method: 'PUT',
        body: after,
      });
    } catch (error) {
      if (error?.status === 409 || error?.code === 'conflict') {
        // 别自动带 confirm：块数暴跌多半是把语法写坏了，得让作者亲眼看一眼再决定。
        aeState.pendingConflict = {
          documentId,
          markdown,
          title: after.title,
          message: `${error.message}（确认后会用 <code>?confirm=1</code> 再存一次）`,
          reason,
          before,
          after,
          record: true,
        };
        toast('块数会暴跌，先确认再存', 'warn');
        aeRender();
        return;
      }
      toast(`文档没写成：${error.message}`, 'warn');
      return; // 文档没动，审计也不记，两边保持一致
    }
    await aeRecordDocument(documentId, before, after, reason);
  });
}

/** 整篇落盘的第二半：记审计。写盘成功但审计失败时只说清楚，不回滚文档。 */
async function aeRecordDocument(documentId, before, after, reason) {
  try {
    await api('/api/ai-edit/ops', {
      method: 'POST',
      body: { scope: 'document', documentId, before, after, reason, confirm: true },
    });
  } catch (error) {
    toast(`文档已改，但审计没记上：${error.message}`, 'warn');
    aeState.draft = null;
    await aeLoad();
    return;
  }
  aeState.draft = null;
  toast('已写进文档，并记了一条审计（可回滚）', 'ok');
  await aeLoad();
}

/** 用户在 409 面板上点了「确认，就这么存」。 */
async function aeConfirmWrite(button) {
  const conflict = aeState.pendingConflict;
  if (!conflict) return;
  await withBusy(button, async () => {
    try {
      await api(`/api/docs/${encodeURIComponent(conflict.documentId)}/markdown?confirm=1`, {
        method: 'PUT',
        body: conflict.title === undefined ? { markdown: conflict.markdown } : { markdown: conflict.markdown, title: conflict.title },
      });
    } catch (error) {
      toast(`文档还是没写成：${error.message}`, 'warn');
      return;
    }
    aeState.pendingConflict = null;
    if (conflict.record) {
      await aeRecordDocument(conflict.documentId, conflict.before, conflict.after, conflict.reason);
      return;
    }
    toast('已写回文档', 'ok');
    await aeLoad();
  });
}

function aeCancelWrite() {
  aeState.pendingConflict = null;
  toast('没写盘，文档没动', 'info');
  aeRender();
}

/**
 * 回滚：**先 rollback，再写回文档**。
 *
 * 为什么选这个顺序：rollback 接口在服务端是一条事务（校验 status=applied 之后
 * 立刻 UPDATE rolled_back_at/status 再返回 restore）。先写盘再 rollback 的话，
 * 写完盘万一 rollback 失败（能力被收回、已经被别人回滚过 → 403/409），文档已经
 * 变了、审计却还写着 applied —— 用户以为没回滚，其实文档回滚了。
 * 反过来失败只是「标记了回滚但文档没写回去」，提示里说清楚就行，用户可以重试。
 *
 * `restore` 有三种形状，必须按形状分支：
 *   · 数组 [{blockId,type,props}] → 小节，走 POST /api/docs/:id/ops 一批 replace
 *   · {markdown,title?}           → 整篇，走 PUT /api/docs/:id/markdown
 *   · {type,props}                → 单块（旧审计），走 PUT /api/docs/:id/blocks/:blockId
 */
async function aeRollback(button, id) {
  await withBusy(button, async () => {
    let data = null;
    try {
      data = await api(`/api/ai-edit/ops/${encodeURIComponent(id)}/rollback`, { method: 'POST' });
    } catch (error) {
      toastError(error);
      return;
    }
    aeState.restore = data?.restore ?? null;
    // targetId 的格式是 "<documentId>:<label>"（服务端 composeTargetId）。
    // label 可能是块 id、`b1~b9`、`section(n)` 或整篇的 `*` —— 只有 documentId 有用。
    const targetId = String(data?.targetId ?? '');
    const split = targetId.indexOf(':');
    const documentId = split > 0 ? targetId.slice(0, split) : '';
    const label = split > 0 ? targetId.slice(split + 1) : '';
    const restore = data?.restore ?? null;
    if (!documentId || restore === null || restore === undefined) {
      toast('已标记回滚（这条审计里没有可写回的位置）', 'warn');
      await aeLoad();
      return;
    }
    if (Array.isArray(restore)) {
      await aeRollbackSection(documentId, restore);
    } else if (typeof restore === 'object' && typeof restore.markdown === 'string') {
      await aeRollbackDocument(documentId, restore);
    } else if (typeof restore === 'object' && restore.type) {
      await aeRollbackBlock(documentId, label, restore);
    } else {
      toast('已标记回滚，但这条审计的旧值形状不认识，没敢写回文档', 'warn');
    }
    await aeLoad();
  });
}

async function aeRollbackSection(documentId, restore) {
  const ops = restore
    .filter((block) => block && typeof block.blockId === 'string' && block.blockId)
    .map((block) => ({ op: 'replace', target: block.blockId, type: block.type, props: block.props ?? {} }));
  if (!ops.length) {
    toast('已标记回滚，但审计里的旧值没有块，没写回文档', 'warn');
    return;
  }
  if (ops.length > MAX_SECTION_BLOCKS) {
    toast(`审计里有 ${ops.length} 块，超过一批 ${MAX_SECTION_BLOCKS} 条的上限，没法一次写回`, 'warn');
    return;
  }
  try {
    const result = await api(`/api/docs/${encodeURIComponent(documentId)}/ops`, { method: 'POST', body: { ops } });
    const rejected = Array.isArray(result?.rejected) ? result.rejected : [];
    if (rejected.length) {
      const detail = rejected
        .map((item) => `${ops[item.index]?.target ?? '?'}（${item.message || item.reason || '没能应用'}）`)
        .join('；');
      toast(`已标记回滚，但有 ${rejected.length} 块没写回去：${detail}`, 'warn');
      return;
    }
    toast('已标记回滚，这一节的块也写回旧内容了', 'ok');
  } catch (error) {
    toast(`已标记回滚，但文档没写回去：${error.message}`, 'warn');
  }
}

async function aeRollbackDocument(documentId, restore) {
  const body = restore.title === undefined ? { markdown: restore.markdown } : { markdown: restore.markdown, title: restore.title };
  try {
    await api(`/api/docs/${encodeURIComponent(documentId)}/markdown`, { method: 'PUT', body });
  } catch (error) {
    if (error?.status === 409 || error?.code === 'conflict') {
      // 回滚也会撞上「块数暴跌」这道闸门：交给用户确认，别自动带 confirm。
      aeState.pendingConflict = {
        documentId,
        markdown: restore.markdown,
        title: restore.title,
        message: `回滚整篇时撞上防手滑检查：${error.message}`,
        record: false,
      };
      toast('回滚要写的旧正文会让块数暴跌，先确认', 'warn');
      aeRender();
      return;
    }
    toast(`已标记回滚，但文档没写回去：${error.message}`, 'warn');
    return;
  }
  toast('已标记回滚，整篇也写回旧内容了', 'ok');
}

async function aeRollbackBlock(documentId, blockId, restore) {
  if (!blockId || blockId.includes('~') || blockId.includes('*') || blockId.includes('(')) {
    toast('已标记回滚，但这条审计是单块模式（这一页已经没有单块流程），没写回文档', 'warn');
    return;
  }
  try {
    await api(`/api/docs/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(blockId)}`, {
      method: 'PUT',
      body: { type: restore.type, props: restore.props ?? {} },
    });
    toast('已标记回滚，块也写回旧内容了', 'ok');
  } catch (error) {
    toast(`已标记回滚，但文档没写回去：${error.message}`, 'warn');
  }
}

async function aeGrant(button, capability) {
  const card = button.closest('[data-ae-cap]') ?? $('[data-ae-root]');
  const quotaInput = card?.querySelector('[data-ae-quota]') ?? $('[data-ae-quota]');
  const confirmInput = card?.querySelector('[data-ae-confirm]') ?? $('[data-ae-confirm]');
  const dailyQuota = Math.max(0, Math.round(Number(quotaInput?.value ?? 0) || 0));
  const body = { capability, dailyQuota };
  const cap = aeState.capabilities.find((item) => item.key === capability);
  if (cap?.highRisk) {
    if (!confirmInput?.checked) {
      toast('这是高风险能力，先勾上确认再授权', 'warn');
      return;
    }
    body.confirm = true;
  }
  await withBusy(button, async () => {
    try {
      await api('/api/ai-edit/grants', { method: 'POST', body });
      toast(`已授权 ${capability}`, 'ok');
    } catch (error) {
      toastError(error);
    }
    await aeLoad();
  });
}

async function aeRevoke(button, capability) {
  await withBusy(button, async () => {
    try {
      await api(`/api/ai-edit/grants/${encodeURIComponent(capability)}`, { method: 'DELETE' });
      toast(`已收回 ${capability}`, 'ok');
    } catch (error) {
      toastError(error);
    }
    await aeLoad();
  });
}

function aeDiscard() {
  aeState.draft = null;
  aeState.restore = null;
  aeState.pendingConflict = null;
  toast('草稿丢了，文档没动', 'info');
  aeRender();
}

/* ---------- 事件绑定（就地，不挂 window） ---------- */

/**
 * 重建 DOM 前收起用户手打的字。
 *
 * 「范围内容」现在是渲染出来的只读预览，没有可手改的框了 —— 这里只剩指令输入框；
 * `blockInput` 由范围决定（整篇 Markdown / 这一节的块），不再从界面上读。
 */
function aeSyncTextarea() {
  const line = $('[data-ae-instruction]');
  if (line) aeState.instructionInput = line.value;
}

function aeBind() {
  const root = $('[data-ae-root]');
  if (!root) return;
  root.addEventListener('click', (event) => {
    const node = event.target.closest('[data-ae-act]');
    if (!node) return;
    const act = node.dataset.aeAct;
    aeSyncTextarea();
    if (act === 'refresh') withBusy(node, aeLoad).then(aeRender);
    else if (act === 'grant') aeGrant(node, node.dataset.aeCap);
    else if (act === 'revoke') aeRevoke(node, node.dataset.aeCap);
    else if (act === 'rollback') aeRollback(node, node.dataset.aeId);
    else if (act === 'draft') aeDraft(node);
    else if (act === 'apply') aeApply(node);
    else if (act === 'discard') aeDiscard();
    else if (act === 'confirm-write') aeConfirmWrite(node);
    else if (act === 'cancel-write') aeCancelWrite();
    else if (act === 'toggle-scope') {
      aeState.docScope = aeState.docScope === 'mine' ? 'all' : 'mine';
      aeState.docDegraded = false;
      withBusy(node, aeLoadDocuments).then(() => {
        aeState.documentId = '';
        aeState.docTitle = '';
        aeState.blocks = [];
        aeState.sections = [];
        aeState.rangeValue = '';
        aeState.blockInput = '';
        aeRender();
      });
    }
  });
  root.addEventListener('change', (event) => {
    const target = event.target;
    if (target.matches('[data-ae-doc]')) {
      aeSyncTextarea();
      aeState.documentId = target.value;
      aeState.docTitle = '';
      aeState.blocks = [];
      aeState.sections = [];
      aeState.rangeValue = '';
      aeState.blockInput = '';
      aeState.draft = null;
      aeState.restore = null;
      aeState.pendingConflict = null;
      aeState.canEdit = true;
      aeState.beforeMarkdown = '';
      aeState.beforeNote = '';
      if (aeState.documentId) aeLoadBlocks(aeState.documentId);
      else aeRender();
      return;
    }
    if (target.matches('[data-ae-range]')) {
      aeSyncTextarea();
      aeState.draft = null;
      aeState.restore = null;
      aeState.pendingConflict = null;
      const value = target.value;
      if (!value) {
        aeState.rangeValue = '';
        aeState.blockInput = '';
        aeRender();
        return;
      }
      aeLoadRangeContent(value);
    }
  });
}

export { viewAiEdit };

/* @hand-written */
