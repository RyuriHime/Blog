// AI 编辑台（P3）：能力授权 / 块级改写草稿 / 操作日志与回滚。
//
// ⚠️ 前缀是 `ai-edit` 不是 `ai`。`/api/ai/` 整段被 forum-ai 的挂载层短路了
// （forum-ai/src/mount.mjs:255 的 isAiPath + :330-344 的兜底 404），注册在那下面的
// 宿主路由永远收不到请求。`/api/ai-edit/` 不以 `/api/ai/` 开头，落回宿主路由表。
//
// ⚠️ 这一页的控件全部**就地绑定**（跟知识网络图、学术笔记一个做法），不接
// public/core/events.js 里那个中央 `data-action` 分发 —— 那个 switch 是
// check-ui-contract.mjs 盯着的公共地带，谁都别往里塞自己的动作。
//
// 数据全部来自 P3 自己的模块（src/modules/ai/routes.js，八条路由）。

import { $, emptyHtml, esc, loadingHtml, toast, ui } from '../core/dom.js';
import { api, withButtonBusy } from '../core/api.js';
import { navigate } from '../core/router.js';
import { state } from '../core/state.js';
import * as Fmt from '../core/format.js';

const RISK_LABEL = { low: '低风险', medium: '中风险', high: '高风险' };
const QUOTA_HINT = '0 表示不限次数';
const DEFAULT_INSTRUCTION = '把这块改成投票';

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
};

const chip = (text, kind = '') => `<span class="ai-chip ${kind}">${esc(text)}</span>`;

function riskKind(risk) {
  return risk === 'high' ? 'warn' : risk === 'medium' ? 'soft' : 'ok';
}

function aeHeadHtml() {
  const granted = aeState.capabilities.filter((item) => item.granted).length;
  const used = aeState.capabilities.reduce((sum, item) => sum + item.usedToday, 0);
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
        <span class="ae-stat"><strong class="ae-stat-num">${Fmt.fmtNum(granted)}/6</strong><span class="ae-stat-label">已授权能力</span></span>
        <span class="ae-stat"><strong class="ae-stat-num">${Fmt.fmtNum(aeState.total)}</strong><span class="ae-stat-label">审计日志</span></span>
        <span class="ae-stat"><strong class="ae-stat-num">${Fmt.fmtNum(used)}</strong><span class="ae-stat-label">今日已用</span></span>
      </div>
      ${
        aeState.configError
          ? `<div class="ae-note">⚙️ ${esc(aeState.configError)}</div>`
          : ''
      }
    </section>`;
}

function aeCapHtml(cap) {
  const stateChip = cap.granted
    ? chip('已授权', 'ok')
    : chip('未授权', 'soft');
  const quotaText = cap.dailyQuota > 0 ? `今日 ${cap.usedToday}/${cap.dailyQuota}` : `${QUOTA_HINT}`;
  return `
    <div class="ae-cap${cap.granted ? ' is-on' : ''}">
      <div class="ae-cap-top">
        <span class="ae-cap-name">${esc(cap.label)}</span>
        ${chip(RISK_LABEL[cap.risk] ?? cap.risk, riskKind(cap.risk))}
        ${stateChip}
      </div>
      <div class="ae-cap-body">
        <code class="ae-cap-key">${esc(cap.key)}</code>
        <span class="hint">${esc(quotaText)}</span>
      </div>
      <div class="ae-cap-meta">
        <label class="ae-field">
          <span class="ae-field-label">每日配额</span>
          <input class="ae-quota" type="number" min="0" max="1000" step="1"
                 value="${Number(cap.dailyQuota ?? 0)}" data-ae-quota="${esc(cap.key)}" />
        </label>
        ${
          cap.highRisk
            ? `<label class="ae-confirm">
                 <input type="checkbox" data-ae-confirm="${esc(cap.key)}" />
                 <span>我知道这是高风险能力</span>
               </label>`
            : ''
        }
      </div>
      <div class="ae-cap-actions">
        <button class="btn btn-sm btn-primary" type="button" data-ae-act="grant" data-ae-cap="${esc(cap.key)}">授权</button>
        ${
          cap.granted
            ? `<button class="btn btn-sm btn-danger" type="button" data-ae-act="revoke" data-ae-cap="${esc(cap.key)}">收回</button>`
            : ''
        }
      </div>
    </div>`;
}

function aeCapsHtml() {
  if (!aeState.capabilities.length) {
    return `<section class="card">${emptyHtml('🎛', '没读到能力目录', '服务端 /api/ai-edit/capabilities 没有返回内容')}</section>`;
  }
  return `
    <section class="card">
      <div class="card-head">
        <span class="card-title">🎛 能力授权</span>
        <span class="hint">高风险能力开启前要额外勾选确认</span>
      </div>
      <div class="ae-grid">${aeState.capabilities.map(aeCapHtml).join('')}</div>
    </section>`;
}

function aeDraftHtml() {
  const draft = aeState.draft;
  const preview = draft
    ? `
      <div class="ae-preview">
        <div class="ae-preview-col">
          <div class="ae-preview-title">改之前</div>
          <pre class="ae-preview-code">${esc(JSON.stringify(draft.before ?? null, null, 2))}</pre>
        </div>
        <div class="ae-preview-col">
          <div class="ae-preview-title">AI 想改成</div>
          <pre class="ae-preview-code">${esc(JSON.stringify(draft.patch ?? null, null, 2))}</pre>
        </div>
      </div>
      <div class="ae-cap-actions">
        <button class="btn btn-sm btn-primary" type="button" data-ae-act="apply">确认并留档</button>
        <button class="btn btn-sm btn-ghost" type="button" data-ae-act="discard">丢掉这份草稿</button>
        <span class="hint">草稿只是预览（日志 #${Fmt.fmtNum(draft.opId)}，状态 preview）。确认后才会记成 applied 并可回滚。</span>
      </div>`
    : `<div class="hint">还没有草稿。填好当前块和改写要求，点「让 AI 草拟改动」。</div>`;

  const restore = aeState.restore
    ? `
      <div class="ae-preview">
        <div class="ae-preview-col">
          <div class="ae-preview-title">回滚交回来的旧值</div>
          <pre class="ae-preview-code">${esc(JSON.stringify(aeState.restore, null, 2))}</pre>
        </div>
      </div>
      <div class="hint">真正写回积木块由 P2 的 <code>/api/docs/*</code> 完成 —— 那边才是 <code>document_blocks</code> 的拥有者。</div>`
    : '';

  return `
    <section class="card">
      <div class="card-head">
        <span class="card-title">📝 按块改写</span>
        <span class="hint">改的是<strong>一个块</strong>，不是整篇重写</span>
      </div>
      <div class="ae-field">
        <span class="ae-field-label">当前块（JSON）</span>
        <textarea class="ae-textarea" data-ae-block rows="5" spellcheck="false">${esc(
          aeState.blockInput ||
            JSON.stringify(
              draft?.before ?? { blockType: 'paragraph', content: { text: '把这句话改成投票。' } },
              null,
              2,
            ),
        )}</textarea>
      </div>
      <div class="ae-field">
        <span class="ae-field-label">改写要求</span>
        <input class="ae-input" data-ae-instruction maxlength="2000"
               placeholder="${esc(DEFAULT_INSTRUCTION)}"
               value="${esc(aeState.instructionInput || draft?.instruction || '')}" />
      </div>
      <div class="ae-cap-actions">
        <button class="btn btn-sm btn-primary" type="button" data-ae-act="draft">✨ 让 AI 草拟改动</button>
        <span class="hint">需要先授权「修改内容」；模型调用按用户限流 10 次/分钟</span>
      </div>
      ${preview}
      ${restore}
    </section>`;
}

function aeStatusKind(status) {
  if (status === 'applied') return 'ok';
  if (status === 'preview') return 'soft';
  if (status === 'rolled_back') return 'cat';
  return 'warn';
}

function aeOpsHtml() {
  const rows = aeState.ops
    .map(
      (op) => `
      <div class="ae-op">
        <div class="ae-op-main">
          <div class="ae-op-title">
            <code>#${Fmt.fmtNum(op.id)}</code>
            ${chip(op.action, 'soft')}
            ${chip(op.status, aeStatusKind(op.status))}
            <span class="hint">${esc(op.capability)}${op.targetId ? ` · 目标 ${esc(op.targetId)}` : ''}</span>
          </div>
          <div class="ae-op-meta">
            ${Fmt.timeAgo(op.createdAt)}${op.reason ? ` · ${esc(op.reason)}` : ''}
            ${op.rolledBackAt ? ` · ${Fmt.timeAgo(op.rolledBackAt)}已回滚` : ''}
          </div>
        </div>
        <div class="ae-op-actions">
          ${
            op.canRollback
              ? `<button class="btn btn-sm" type="button" data-ae-act="rollback" data-ae-id="${op.id}">↩ 回滚</button>`
              : '<span class="hint">—</span>'
          }
        </div>
      </div>`,
    )
    .join('');

  return `
    <section class="card">
      <div class="card-head">
        <span class="card-title">🧾 审计日志</span>
        <span class="hint">最近 ${Fmt.fmtNum(aeState.ops.length)} 条 / 共 ${Fmt.fmtNum(aeState.total)} 条</span>
      </div>
      ${
        aeState.ops.length
          ? `<div class="ae-ops">${rows}</div>`
          : emptyHtml('🧾', '还没有 AI 操作记录', '授权、收回、草拟、落盘、回滚都会在这里留一行')
      }
    </section>`;
}

function aeRender() {
  ui.app.innerHTML =
    `<div data-ae-root>` +
    aeHeadHtml() +
    aeCapsHtml() +
    aeDraftHtml() +
    aeOpsHtml() +
    `</div>`;
  aeBind();
}

async function aeLoad() {
  const [caps, ops] = await Promise.all([
    api('/api/ai-edit/capabilities'),
    api('/api/ai-edit/ops?limit=30'),
  ]);
  aeState.capabilities = caps.capabilities ?? [];
  aeState.ops = ops.ops ?? [];
  aeState.total = ops.total ?? aeState.ops.length;
  aeState.configError = '';
}

async function viewAiEdit() {
  ui.app.innerHTML = loadingHtml();
  if (!state.me) {
    // 未登录：跟学术笔记一样，记下想去的地方再跳登录。
    state.redirect = '/ai-edit';
    navigate('/login');
    return;
  }
  try {
    await aeLoad();
  } catch (error) {
    if (error.code === 'ai_not_configured') {
      aeState.configError = 'AI 还没有配置，设置环境变量 AI_API_KEY 后才能调用模型（授权与审计不受影响）。';
    }
    ui.app.innerHTML = `<div class="card">${emptyHtml('🤖', 'AI 编辑台打不开', esc(error.message || '请稍后再试'))}</div>`;
    return;
  }
  aeRender();
}

/* ------------------------------------------------------------------ */
/* 交互：全部就地绑定，不接中央 data-action 分发                        */

async function aeGrant(button, capability) {
  const cap = aeState.capabilities.find((item) => item.key === capability);
  if (!cap) return;
  const quotaInput = $(`[data-ae-quota="${capability}"]`);
  const dailyQuota = Number(quotaInput?.value ?? 0);
  if (!Number.isInteger(dailyQuota) || dailyQuota < 0 || dailyQuota > 1000) {
    toast('每日配额要填 0~1000 的整数（0 表示不限次数）', 'error');
    return;
  }
  const confirmBox = $(`[data-ae-confirm="${capability}"]`);
  if (cap.highRisk && !confirmBox?.checked) {
    toast(`「${cap.label}」是高风险能力，先勾选确认框`, 'error');
    return;
  }
  await withButtonBusy(button, async () => {
    try {
      const body = { capability, dailyQuota };
      if (cap.highRisk) body.confirm = true;
      await api('/api/ai-edit/grants', { method: 'POST', body });
      toast(`已授权「${cap.label}」`, 'success');
      await aeLoad();
      aeRender();
    } catch (error) {
      toast(error.message, 'error');
    }
  });
}

async function aeRevoke(button, capability) {
  await withButtonBusy(button, async () => {
    try {
      await api(`/api/ai-edit/grants/${encodeURIComponent(capability)}`, { method: 'DELETE' });
      toast('已收回，立即失效', 'success');
      await aeLoad();
      aeRender();
    } catch (error) {
      toast(error.message, 'error');
    }
  });
}

async function aeRollback(button, id) {
  await withButtonBusy(button, async () => {
    try {
      const data = await api(`/api/ai-edit/ops/${id}/rollback`, { method: 'POST' });
      aeState.restore = data.restore ?? null;
      toast(`已回滚 #${id}，旧值已取回`, 'success');
      await aeLoad();
      aeRender();
    } catch (error) {
      toast(error.message, 'error');
    }
  });
}

async function aeDraft(button) {
  const instruction = $('[data-ae-instruction]')?.value?.trim() ?? '';
  if (!instruction) {
    toast('先写一句改写要求', 'error');
    return;
  }
  let block;
  const rawBlock = $('[data-ae-block]')?.value ?? '';
  try {
    block = JSON.parse(rawBlock || 'null');
  } catch {
    toast('当前块不是合法的 JSON', 'error');
    return;
  }
  // 请求之前先把输入留一份：失败分支会 aeRender() 重建 DOM，
  // 不留的话用户刚敲的块 JSON 和改写要求会被抹成默认值。
  aeState.instructionInput = instruction;
  aeState.blockInput = rawBlock;
  await withButtonBusy(button, async () => {
    try {
      const data = await api('/api/ai-edit/draft', {
        method: 'POST',
        body: { instruction, block, blockId: String(block?.id ?? '') },
      });
      aeState.draft = { opId: data.opId, patch: data.patch, before: block, instruction };
      aeState.restore = null;
      toast(`模型 ${data.model} 给了一版改动，先看看再决定`, 'success');
      await aeLoad();
      aeRender();
    } catch (error) {
      // 503 ai_not_configured / 504 ai_timeout / 502 ai_* 都会走到这里，
      // 错误代号沿用既有清单，不新造（FR-AI-15）。
      if (error.code === 'ai_not_configured') {
        aeState.configError = 'AI 还没有配置，设置环境变量 AI_API_KEY 后才能调用模型（授权与审计不受影响）。';
      }
      toast(error.message, 'error');
      aeRender();
    }
  });
}

async function aeApply(button) {
  const draft = aeState.draft;
  if (!draft) return;
  await withButtonBusy(button, async () => {
    try {
      const data = await api('/api/ai-edit/ops', {
        method: 'POST',
        body: {
          capability: 'edit_content',
          targetType: 'document_block',
          targetId: String(draft.before?.id ?? ''),
          before: draft.before,
          after: draft.patch,
          reason: draft.instruction,
          confirm: true,
        },
      });
      aeState.draft = null;
      // 这一版已经落盘了，改写要求清空；块留在框里，方便接着对同一块提下一步要求。
      aeState.instructionInput = '';
      toast(`已记成操作 #${data.opId}，可以回滚`, 'success');
      await aeLoad();
      aeRender();
    } catch (error) {
      toast(error.message, 'error');
    }
  });
}

function aeDiscard() {
  aeState.draft = null;
  aeState.restore = null;
  aeState.instructionInput = '';
  aeState.blockInput = '';
  aeRender();
}

function aeBind() {
  // 控件一律用 data-ae-* 找，不用 id —— id 选择器会被 check-ui-contract.mjs 当成
  // 「必须存在于 index.html 的挂载点」，而这一页的元素是运行时自己画出来的。
  const root = $('[data-ae-root]');
  if (!root) return;
  root.addEventListener('click', (event) => {
    const node = event.target.closest('[data-ae-act]');
    if (!node) return;
    const act = node.dataset.aeAct;
    if (act === 'refresh') {
      aeLoad().then(aeRender).catch((error) => toast(error.message, 'error'));
      return;
    }
    if (act === 'grant') return void aeGrant(node, node.dataset.aeCap ?? '');
    if (act === 'revoke') return void aeRevoke(node, node.dataset.aeCap ?? '');
    if (act === 'rollback') return void aeRollback(node, Number(node.dataset.aeId));
    if (act === 'draft') return void aeDraft(node);
    if (act === 'apply') return void aeApply(node);
    if (act === 'discard') return void aeDiscard();
  });
}

// ── 导出 ──────────────────────────────────────────────────────────────
export { viewAiEdit };

/* @hand-written */
