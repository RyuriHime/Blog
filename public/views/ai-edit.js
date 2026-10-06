// AI 编辑台（P3）：选文档 → 选块 → 改块 → 真的落盘 / 回滚，外加能力授权与全站用量。
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
//   · src/modules/ai/routes.js   —— /api/ai-edit/*（能力、草拟、审计、回滚、用量）
//   · src/modules/doc/routes.js  —— /api/docs*（文档与块，PUT 才是真写进库）
//
// ⚠️ 「块」的形状是 P2 的原生 `{ type, props }`，type 只能是内置类型之一
// （heading/paragraph/list/code/table/formula/image/quote/poll/wiki/embed/app/script/subpage，
// 目前 14 种；清单以 P2 的 src/modules/doc/blocks/types.js 为准）。
// 以前这里是自造的「块类型 + 内容」两字段形状，服务端 blockPatchProblem() 会直接 400。

import { $, emptyHtml, esc, loadingHtml, toast, ui } from '../core/dom.js';
import { toastError } from '../core/errors.js';
import { api, withButtonBusy } from '../core/api.js';
import { navigate } from '../core/router.js';
import { state } from '../core/state.js';
import * as Fmt from '../core/format.js';

const RISK_LABEL = { low: '低风险', medium: '中风险', high: '高风险' };
const QUOTA_HINT = '0 表示不限次数';
const DEFAULT_INSTRUCTION = '把这块改成投票';
const NO_TARGET_HINT = '先选一篇文档和一个块：不选就不知道改的是哪儿';

/**
 * 内置块类型的中文名（目前 14 种）。块下拉里显示成 `b3 · 投票(poll) · 选哪个？`
 * 这里只是一张显示用的对照表，真正管放行的是服务端的 `AI_BLOCK_TYPE_NAMES` ——
 * 少一项不会报错，只会让那一类块在下拉里显示成英文原名（`BLOCK_LABEL[t] || t`）。
 */
const BLOCK_LABEL = {
  heading: '标题',
  paragraph: '段落',
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

/** 没选块时的占位内容，形状必须合法，否则草拟会被服务端 400 掉。 */
const DEFAULT_BLOCK = { type: 'paragraph', props: { text: '把这句话改成投票。' } };
const DEFAULT_BLOCK_TEXT = JSON.stringify(DEFAULT_BLOCK, null, 2);

const aeState = {
  capabilities: [],
  ops: [],
  total: 0,
  /** 草稿：{ opId, patch, before, instruction } —— FR-CAP-06 要求先看再落盘 */
  draft: null,
  /** 回滚交回来的旧值，展示用 */
  restore: null,
  configError: '',
  /**
   * 两个输入框的备份。aeRender() 是整体重建 DOM：重建时只能拿 draft 回填，
   * 而 draft 为 null 时就会退回默认值 —— 于是「草拟失败」会把用户刚敲进去的
   * 块 JSON 和改写要求整个抹掉。发起请求前先存一份，重建时优先用它。
   */
  instructionInput: '',
  blockInput: '',
  /* ---- 目标：改哪一篇的哪一个块 ---- */
  documents: [],
  /** 'mine'（我的）| 'all'（全站）：下拉取空的降级开关 */
  docScope: 'mine',
  docDegraded: false,
  docError: '',
  documentId: '',
  blocks: [],
  blockId: '',
  blocksLoading: false,
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

/* ---------- 目标：文档与块 ---------- */

function docLabel(doc) {
  const title = doc.title || '（无标题）';
  const kind = doc.kindLabel || doc.kind || '文档';
  return `${title} · ${kind}`;
}

function blockLabel(block) {
  const name = BLOCK_LABEL[block.type] || block.type || '未知';
  const props = block.props || {};
  const digest = String(props.question ?? props.text ?? props.title ?? props.code ?? '').replace(/\s+/g, ' ').trim();
  const short = digest.length > 24 ? `${digest.slice(0, 24)}…` : digest;
  return `${block.blockId} · ${name}(${block.type})${short ? ` · ${short}` : ''}`;
}

function aeOptionHtml(value, label, selected) {
  return `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`;
}

function findDocument(id) {
  return aeState.documents.find((doc) => String(doc.id) === String(id)) || null;
}

function findBlock(id) {
  return aeState.blocks.find((block) => String(block.blockId) === String(id)) || null;
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

function aeBlockSelectHtml() {
  // loadingHtml() 自带一层 .card，不要再套 .ae-placeholder（会双边框）。
  if (aeState.blocksLoading) return loadingHtml();
  if (!aeState.documentId) return '<div class="ae-placeholder">先选上面的文档，这里才会列出它的块。</div>';
  if (!aeState.blocks.length) return '<div class="ae-placeholder">这篇文档还没有块，换个文档或者先去编辑页加一块。</div>';
  const options = aeState.blocks
    .map((block) => aeOptionHtml(block.blockId, blockLabel(block), String(block.blockId) === String(aeState.blockId)))
    .join('');
  return `
      <select class="ae-input ae-select" data-ae-pick aria-label="选择块">
        <option value="">— 选一个块 —</option>
        ${options}
      </select>`;
}

function aeTargetHtml() {
  const doc = findDocument(aeState.documentId);
  const block = findBlock(aeState.blockId);
  const parts = [];
  if (doc) parts.push(`文档「${doc.title || '（无标题）'}」#${doc.id}`);
  if (block) parts.push(`块 ${block.blockId}（${BLOCK_LABEL[block.type] || block.type}）`);
  const ready = Boolean(aeState.documentId && aeState.blockId);
  return `
    <section class="card">
      <div class="card-head">
        <h2>目标</h2>
        <span class="ae-target-state">${ready ? '✅ 已锁定改动位置' : '未选定'}</span>
      </div>
      <div class="page-sub">
        草拟、落盘、回滚都作用在这里选中的那一块上。
        改完会先 <strong>PUT /api/docs/:id/blocks/:blockId</strong> 真写进文档，再记一条审计。
      </div>
      <div class="ae-target">
        <div class="ae-field">
          <label class="ae-field-label" for="ae-doc">文档</label>
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
          <label class="ae-field-label" for="ae-block-pick">块</label>
          ${aeBlockSelectHtml()}
          <div class="ae-field-hint">选中后块的 JSON 会填进下面的框，可以直接手改。</div>
        </div>
      </div>
      <div class="ae-target-line">${
        parts.length ? esc(parts.join(' → ')) : `<span class="ae-target-hint">${NO_TARGET_HINT}</span>`
      }</div>
      ${aeState.docError ? `<div class="ae-note">列表读不出来：${esc(aeState.docError)}</div>` : ''}
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
        六项能力<strong>默认全部关闭</strong>，不开就不许用，随时可以收回。
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

function shortJson(value) {
  try {
    return JSON.stringify(value ?? null, null, 2);
  } catch {
    return '（无法序列化）';
  }
}

function aeDraftHtml() {
  const draft = aeState.draft;
  const restore = aeState.restore;
  const ready = Boolean(aeState.documentId && aeState.blockId);
  const value = aeState.blockInput || DEFAULT_BLOCK_TEXT;
  const instruction = aeState.instructionInput || DEFAULT_INSTRUCTION;
  return `
    <section class="card">
      <div class="card-head">
        <h2>块内容与改写</h2>
        <span class="ae-target-state">${ready ? '可落盘' : '先选目标'}</span>
      </div>
      <div class="ae-target">
        <div class="ae-field">
          <label class="ae-field-label" for="ae-block">当前块 JSON（可手改）</label>
          <textarea class="ae-input ae-textarea" rows="7" data-ae-block aria-label="当前块 JSON">${esc(value)}</textarea>
        </div>
        <div class="ae-field">
          <label class="ae-field-label" for="ae-instr">改写要求</label>
          <input class="ae-input" type="text" data-ae-instruction value="${esc(instruction)}" aria-label="改写要求">
          <div class="ae-field-hint">${ready ? `改的是 ${esc(aeState.documentId)}:${esc(aeState.blockId)}` : NO_TARGET_HINT}</div>
          <div class="ae-cap-actions">
            <button class="btn btn-sm btn-primary" type="button" data-ae-act="draft"${ready ? '' : ' disabled'}>✨ 草拟改动</button>
            <button class="btn btn-sm" type="button" data-ae-act="apply"${aeState.draft ? '' : ' disabled'}>💾 落盘到文档</button>
            <button class="btn btn-sm" type="button" data-ae-act="discard"${aeState.draft ? '' : ' disabled'}>丢弃草稿</button>
          </div>
        </div>
      </div>
      ${
        draft
          ? `<div class="ae-preview">
              <div class="ae-preview-col">
                <div class="ae-preview-title">改动前</div>
                <pre class="ae-preview-code">${esc(shortJson(draft.before))}</pre>
              </div>
              <div class="ae-preview-col">
                <div class="ae-preview-title">模型建议</div>
                <pre class="ae-preview-code">${esc(shortJson(draft.patch))}</pre>
              </div>
            </div>
            <div class="ae-note">草稿只在浏览器里。点「落盘到文档」才会先写文档、再记审计。</div>`
          : ''
      }
      ${
        restore
          ? `<div class="ae-preview">
              <div class="ae-preview-col">
                <div class="ae-preview-title">回滚拿到的旧值</div>
                <pre class="ae-preview-code">${esc(shortJson(restore))}</pre>
              </div>
            </div>`
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
                ${chip(op.capability || '', 'soft')}
              </div>
              <div class="ae-op-meta">
                <span>${esc(op.targetId || '')}</span>
                <span>${esc(Fmt.fullTime(op.createdAt))}</span>
                ${op.reason ? `<span>${esc(op.reason)}</span>` : ''}
                ${op.rolledBackAt ? `<span>回滚于 ${esc(Fmt.fullTime(op.rolledBackAt))}</span>` : ''}
              </div>
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
    aeState.blockId = '';
    aeState.blocks = [];
    aeState.draft = null;
  }
}

async function aeLoadBlocks(documentId) {
  const token = ++blockToken;
  aeState.blocksLoading = true;
  aeState.blocks = [];
  aeState.blockId = '';
  aeRender();
  try {
    const data = await api(`/api/docs/${encodeURIComponent(documentId)}`);
    if (token !== blockToken) return; // 用户已经换了文档，这次结果作废
    aeState.blocks = data?.blocks ?? [];
    const first = aeState.blocks[0];
    if (first) {
      aeState.blockId = first.blockId;
      aeState.blockInput = JSON.stringify({ type: first.type, props: first.props }, null, 2);
    }
    aeState.docError = '';
  } catch (error) {
    if (token !== blockToken) return;
    aeState.docError = error.message;
  } finally {
    if (token === blockToken) {
      aeState.blocksLoading = false;
      aeRender();
    }
  }
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
  if (aeState.documentId) aeLoadBlocks(aeState.documentId);
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
  aeState.blockInput = '';
  aeState.instructionInput = '';
  aeState.docDegraded = false;
  aeState.docError = '';
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

/** 读「当前块」框里的 JSON，顺便把用户的原文记进 aeState.blockInput（重建 DOM 时要回填）。 */
function readBlockInput() {
  const raw = $('[data-ae-block]')?.value ?? '';
  aeState.blockInput = raw;
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { block: null, problem: '上面那块 JSON 解析不了，先修一下格式' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { block: null, problem: '块得是一个对象，形如 {"type":"paragraph","props":{…}}' };
  }
  if (!parsed.type || typeof parsed.props !== 'object' || parsed.props === null) {
    return { block: null, problem: '块必须有 type，props 得是对象（形如 {"type":"paragraph","props":{"text":"…"}}）' };
  }
  return { block: { type: parsed.type, props: parsed.props }, problem: '' };
}

async function aeDraft(button) {
  aeState.instructionInput = $('[data-ae-instruction]')?.value ?? '';
  const instruction = aeState.instructionInput.trim() || DEFAULT_INSTRUCTION;
  const { block, problem } = readBlockInput();
  aeState.blockInput = $('[data-ae-block]')?.value ?? aeState.blockInput;
  if (problem) {
    toast(problem, 'warn');
    return;
  }
  if (!aeState.documentId || !aeState.blockId) {
    toast(NO_TARGET_HINT, 'warn');
    return;
  }
  await withBusy(button, async () => {
    try {
      const data = await api('/api/ai-edit/draft', {
        method: 'POST',
        body: { block, instruction, documentId: aeState.documentId, blockId: aeState.blockId },
      });
      aeState.draft = data;
      aeState.restore = null;
      toast('草稿好了，先看再落盘', 'ok');
    } catch (error) {
      toast(
        error.code === 'ai_not_configured'
          ? '服务器没配 AI_API_KEY，去配一下才能用草拟'
          : error.message,
        'warn',
      );
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
  const blockId = draft.blockId || aeState.blockId;
  if (!documentId || !blockId) {
    toast(NO_TARGET_HINT, 'warn');
    return;
  }
  const after = { type: draft.patch?.type, props: draft.patch?.props ?? {} };
  const before = draft.before ?? null;
  await withBusy(button, async () => {
    try {
      await api(`/api/docs/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(blockId)}`, {
        method: 'PUT',
        body: after,
      });
    } catch (error) {
      toast(`文档没写成：${error.message}`, 'warn');
      return; // 文档没动，审计也不记，两边保持一致
    }
    try {
      await api('/api/ai-edit/ops', {
        method: 'POST',
        body: { documentId, blockId, before, after, reason: aeState.instructionInput.trim(), confirm: true },
      });
    } catch (error) {
      toast(`文档已改，但审计没记上：${error.message}`, 'warn');
      aeState.draft = null;
      await aeLoad();
      return;
    }
    aeState.draft = null;
    aeState.blockInput = JSON.stringify(after, null, 2);
    toast('已写进文档，并记了一条审计（可回滚）', 'ok');
    await aeLoad();
  });
}

/**
 * 回滚：**先 rollback，再 PUT 写回文档**。
 *
 * 为什么选这个顺序：rollback 接口在服务端是一条事务（校验 status=applied 之后
 * 立刻 UPDATE rolled_back_at/status 再返回 restore）。先 PUT 再 rollback 的话，
 * 写完盘万一 rollback 失败（能力被收回、已经被别人回滚过 → 403/409），文档已经
 * 变了、审计却还写着 applied —— 用户以为没回滚，其实文档回滚了。
 * 反过来失败只是「标记了回滚但文档没写回去」，提示里说清楚就行，用户可以重试。
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
    // targetId 的格式是 "<documentId>:<blockId>"（服务端 composeTargetId），
    // rollback 的返回里没有单独的 documentId/blockId，只能这样拆。
    const targetId = String(data?.targetId ?? '');
    const split = targetId.indexOf(':');
    const documentId = data?.documentId ?? (split > 0 ? targetId.slice(0, split) : '');
    const blockId = data?.blockId ?? (split > 0 ? targetId.slice(split + 1) : '');
    if (documentId && blockId && data?.restore) {
      try {
        await api(`/api/docs/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(blockId)}`, {
          method: 'PUT',
          body: { type: data.restore.type, props: data.restore.props ?? {} },
        });
        toast('已标记回滚，文档也写回旧内容了', 'ok');
      } catch (error) {
        toast(`已标记回滚，但文档没写回去：${error.message}`, 'warn');
      }
    } else {
      toast('已标记回滚（这条审计里没有可写回的块位置）', 'warn');
    }
    await aeLoad();
  });
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
  toast('草稿丢了，文档没动', 'info');
  aeRender();
}

/* ---------- 事件绑定（就地，不挂 window） ---------- */

function aeSyncTextarea() {
  const area = $('[data-ae-block]');
  if (area) aeState.blockInput = area.value;
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
    else if (act === 'toggle-scope') {
      aeState.docScope = aeState.docScope === 'mine' ? 'all' : 'mine';
      aeState.docDegraded = false;
      withBusy(node, aeLoadDocuments).then(() => {
        aeState.documentId = '';
        aeState.blockId = '';
        aeState.blocks = [];
        aeRender();
      });
    }
  });
  root.addEventListener('change', (event) => {
    const target = event.target;
    if (target.matches('[data-ae-doc]')) {
      aeSyncTextarea();
      aeState.documentId = target.value;
      aeState.blockId = '';
      aeState.blocks = [];
      aeState.draft = null;
      aeState.restore = null;
      if (aeState.documentId) aeLoadBlocks(aeState.documentId);
      else aeRender();
      return;
    }
    if (target.matches('[data-ae-pick]')) {
      aeSyncTextarea();
      aeState.blockId = target.value;
      const block = findBlock(aeState.blockId);
      if (block) aeState.blockInput = JSON.stringify({ type: block.type, props: block.props }, null, 2);
      aeState.draft = null;
      aeState.restore = null;
      aeRender();
    }
  });
}

export { viewAiEdit };

/* @hand-written */

