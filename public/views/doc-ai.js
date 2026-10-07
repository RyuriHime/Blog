// 积木编辑器**左侧**的 AI 抽屉（P3「修复 3」的前端口）。
//
// 它只管一个区域：编辑区左边这块对话。作者说一句话，AI 就改右边那片正文 ——
// 改 Markdown（格式整理）、审一遍（原「AI 学术审查」的接班人）、加一个积木块、
// 写一段积木脚本，走的都是同一句话这条路。
//
// 三条纪律：
//   1. **提示词不在这里**。模型侧的积木说明书是 `src/modules/ai/syntax.js`（服务端
//      的提示词逐字用它），前端只负责把「当前正文 + 这句话」发出去、把回来的东西摆出来。
//      在这儿再写一份「怎么写积木」的提示词，就等着两边漂移。
//   2. **先预览、再写入**。写入只写进右侧编辑区，落盘仍然是页面上那颗「保存」的事 ——
//      抽屉不替作者下「这次改动算数」的决定。
//   3. **抽屉自己绝不把编辑器带下水**：没授权 / 没配 key / 模型超时，一律变成日志里的
//      一句人话，右边的编辑照常能用。
//
// 后端是 `/api/ai-edit/*`（`src/modules/ai/routes.js`）：
//   POST /draft-range  scope=document  { documentId, markdown, instruction } → 整篇草稿
//   POST /review       { documentId, markdown }                             → 只出意见
// 落盘不由这里做（`ai-edit` 页面才管落盘与回滚），这里只把文本写回编辑区。

import { $, esc } from '../core/dom.js';
import { api } from '../core/api.js';
import { apiErrorText } from '../core/errors.js';

/** 快捷指令：把最常用的三件事变成按钮（照既有 AI 抽屉那颗「学术审查」的口径）。 */
const QUICK = [
  ['📐 格式整理', '把这一篇的格式整理一遍：标题层级、列表、表格口径统一，事实一个字都不要动'],
  ['🧱 加个积木', '在文末加一个能用的积木块（投票 / 小应用 / 脚本里挑最合适的一种），块体写完整'],
  ['✂️ 精简一半', '把这一篇压缩到一半长度，保留结论与全部数字，删掉重复和空话'],
];

const SEVERITY = { high: '高', medium: '中', low: '低' };

/** 一次草稿（还没写进编辑区）：`{ kind:'draft'|'template', ... }`，按按钮时用。 */
let pending = [];

/** 当前挂着的那个抽屉；切页面时由 `destroyDocAi()` 收掉。 */
let live = null;

/** 最后一次发出的请求（`{ kind:'draft'|'review', instruction }`）：授权成功后拿它重跑一遍。 */
let lastAsk = null;

/** 左侧抽屉的骨架。`documentId` 只是为了在标题栏写清楚「改的是哪一篇」。 */
export function docAiHtml(documentId) {
  return `<aside class="card doc-ai" data-doc-ai>
    <div class="card-head doc-ai-head">
      <span class="card-title">🤖 AI 助手</span>
      <span class="doc-ai-docid">#${esc(String(documentId ?? ''))}</span>
      <button class="btn btn-sm btn-ghost" type="button" data-doc-ai-action="collapse" title="收起抽屉">‹</button>
    </div>
    <div class="doc-ai-body">
      <div class="doc-ai-log" data-doc-ai-log>
        <div class="doc-ai-note">在下面说一句话，AI 就改右边这片正文：整理格式、学术审查、加积木块、写积木脚本都行。</div>
      </div>
      <div class="doc-ai-quick" data-doc-ai-quick>
        ${QUICK.map((item, index) => `<button class="btn btn-sm btn-ghost" type="button" data-doc-ai-quick="${index}">${esc(item[0])}</button>`).join('')}
      </div>
      <textarea class="doc-input doc-textarea doc-ai-input" data-doc-ai-input rows="3" placeholder="例如：把这一节改得更紧凑；给文末加一个投票积木"></textarea>
      <div class="doc-actions">
        <button class="btn btn-sm btn-primary" type="button" data-doc-ai-action="send">说给 AI</button>
        <button class="btn btn-sm btn-ghost" type="button" data-doc-ai-action="review">学术审查</button>
      </div>
      <div class="doc-hint" data-doc-ai-status></div>
    </div>
    <button class="doc-ai-tab" type="button" data-doc-ai-action="collapse" title="展开 AI 助手">🤖</button>
  </aside>`;
}

/**
 * 挂上抽屉。
 *
 * `getText()` 回编辑区此刻的正文（积木模式下回空串：那一页没有一段完整文本可发），
 * `setText(markdown, options)` 把 AI 的结果写回右侧编辑区（**不落盘**；`options.reload`
 * 表示服务端已经自己写盘了，客户端只需重新拉一次）。
 * 两者都由 `doc.js` 提供 —— 抽屉不认识「三种编辑模式」，它只认识「左边说、右边改」。
 */
export function mountDocAi(options = {}) {
  destroyDocAi();
  // 参数逐个落地、不用解构：`scripts/check-frontend.mjs` 的「裸调用」扫描会数函数参数，
  // 而它按逗号切分 `{ a, b }` 这种写法时会把最后一个名字连右花括号一起吃掉 —— 那个名字
  // 于是成了「没声明就调用」，一条假红。
  const mount = options.mount;
  const documentId = options.documentId;
  const getText = typeof options.getText === 'function' ? options.getText : () => '';
  const setText = typeof options.setText === 'function' ? options.setText : () => {};
  const root = mount instanceof Element ? mount : document.querySelector('[data-doc-ai]');
  if (!root) return null;

  const log = root.querySelector('[data-doc-ai-log]');
  const input = root.querySelector('[data-doc-ai-input]');
  const status = root.querySelector('[data-doc-ai-status]');
  const sendBtn = root.querySelector('[data-doc-ai-action="send"]');
  const reviewBtn = root.querySelector('[data-doc-ai-action="review"]');

  const say = (html) => {
    if (!log) return;
    const turn = document.createElement('div');
    turn.className = 'doc-ai-turn';
    turn.innerHTML = html;
    log.appendChild(turn);
    log.scrollTop = log.scrollHeight;
  };

  const hint = (text) => {
    if (status) status.textContent = text;
  };

  /** 发一次「整篇改写」并把预览摆进日志。`instruction` 是作者那句话（或某条审查建议）。 */
  async function draft(instruction) {
    const text = String(getText() ?? '');
    if (text.trim() === '') {
      hint('右边还是空的 —— 先写两句，AI 才有东西可改。');
      return;
    }
    say(`<div class="doc-ai-said">${esc(instruction)}</div>`);
    lastAsk = { kind: 'draft', instruction };
    const busy = (on) => {
      if (sendBtn) sendBtn.disabled = on;
      if (reviewBtn) reviewBtn.disabled = on;
      hint(on ? '正在让模型改…（整篇改写可能要十几秒）' : '');
    };
    busy(true);
    try {
      const data = await api('/api/ai-edit/draft-range', {
        method: 'POST',
        body: { documentId, scope: 'document', markdown: text, instruction },
      });
      const patch = data?.patch ?? {};
      if (patch.template) {
        pending.push({ kind: 'template', key: String(patch.template), title: String(patch.title ?? '') });
        say(
          `<div class="doc-ai-card"><div class="doc-ai-card-head">模型选了站内模板「${esc(patch.template)}」</div>` +
            `<div class="doc-hint">套用会把整篇现有的块换成这个模板的块。</div>` +
            `<div class="doc-actions"><button class="btn btn-sm" type="button" data-doc-ai-apply="${pending.length - 1}">套用这个模板</button></div></div>`,
        );
      } else {
        const markdown = String(patch.markdown ?? '');
        pending.push({ kind: 'draft', markdown });
        say(
          `<div class="doc-ai-card"><div class="doc-ai-card-head">改好了（模型 ${esc(String(data?.model ?? '')) || '未署名'}）</div>` +
            `<pre class="doc-ai-pre">${esc(markdown)}</pre>` +
            `<div class="doc-actions"><button class="btn btn-sm btn-primary" type="button" data-doc-ai-apply="${pending.length - 1}">写入编辑区</button></div>` +
            `<div class="doc-hint">只写进编辑器，不落盘 —— 看过之后点页面上那颗「保存」才算数。</div></div>`,
        );
      }
      hint('');
    } catch (error) {
      say(errorCard(error));
      hint('');
    } finally {
      busy(false);
    }
  }

  /** 审查：只出意见，一个字都不改（与 `/review` 的口径一致）。 */
  async function review(instruction = '') {
    const text = String(getText() ?? '');
    if (text.trim() === '') {
      hint('右边还是空的 —— 先写两句再审。');
      return;
    }
    say(`<div class="doc-ai-said">${esc(instruction ? `审查：${instruction}` : '学术审查')}</div>`);
    lastAsk = { kind: 'review', instruction };
    const busy = (on) => {
      if (sendBtn) sendBtn.disabled = on;
      if (reviewBtn) reviewBtn.disabled = on;
      hint(on ? '正在审…' : '');
    };
    busy(true);
    try {
      const data = await api('/api/ai-edit/review', {
        method: 'POST',
        body: { documentId, markdown: text, instruction },
      });
      const findings = Array.isArray(data?.findings) ? data.findings : [];
      if (findings.length === 0) {
        say(`<div class="doc-ai-card"><div class="doc-ai-card-head">审完了，没挑出问题</div></div>`);
      } else {
        say(
          `<div class="doc-ai-card"><div class="doc-ai-card-head">审出 ${findings.length} 条${data?.dropped ? `（另有 ${esc(String(data.dropped))} 条引用对不上原文，已丢）` : ''}</div>` +
            findings
              .map((item, index) => {
                const suggestion = String(item?.suggestion ?? '');
                pending.push({ kind: 'draft', markdown: '', suggestion, instruction: suggestion });
                return (
                  `<div class="doc-ai-finding"><div class="doc-ai-sev" data-sev="${esc(String(item?.severity ?? 'low'))}">${esc(SEVERITY[item?.severity] ?? '低')}</div>` +
                  `<div><div class="doc-ai-issue">${esc(String(item?.issue ?? ''))}</div>` +
                  (item?.quote ? `<div class="doc-ai-quote">${esc(String(item.quote))}</div>` : '') +
                  `<div class="doc-hint">${esc(suggestion)}</div>` +
                  (suggestion
                    ? `<div class="doc-actions"><button class="btn btn-sm btn-ghost" type="button" data-doc-ai-suggest="${pending.length - 1}">照这条改</button></div>`
                    : '') +
                  `</div></div>`
                );
              })
              .join('') +
            `</div>`,
        );
      }
      hint('');
    } catch (error) {
      say(errorCard(error));
      hint('');
    } finally {
      busy(false);
    }
  }

  /**
   * 403 那颗授权按钮：就地给自己授权（`edit_content` 是高风险能力，服务端强制 confirm），
   * 授权成了就把刚才那句话原样重跑一遍 —— 作者不该为了一道墙重打一遍指令。
   */
  async function grantAndRetry(capability) {
    hint('正在授权…');
    try {
      const data = await api('/api/ai-edit/grants', {
        method: 'POST',
        body: { capability, confirm: true },
      });
      say(
        `<div class="doc-ai-card"><div class="doc-ai-card-head">已授权「${esc(String(data?.capability ?? capability))}」</div>` +
          `<div class="doc-hint">这一下是你自己点的；想收回就去「AI 编辑台」，那里也能设每日次数。</div></div>`,
      );
      const ask = lastAsk;
      if (ask && ask.kind === 'review') await review(String(ask.instruction ?? ''));
      else if (ask) await draft(String(ask.instruction ?? ''));
      else hint('授权好了 —— 再说一句就行。');
    } catch (error) {
      hint(`授权失败：${aiFailure(error)}`);
    }
  }

  /** 把预览真的写进右侧编辑区（或套用模板 —— 那一条得让服务端动手）。 */
  async function apply(index) {
    const item = pending[index];
    if (!item) return;
    if (item.kind === 'template') {
      try {
        const data = await api(`/api/docs/${encodeURIComponent(documentId)}/apply-template`, {
          method: 'POST',
          body: { key: item.key, mode: 'replace' },
        });
        setText(String(data?.source ?? data?.markdown ?? ''), { reload: true });
        hint('模板已套用（服务端已经写盘了）—— 要看块列表就刷新一下。');
      } catch (error) {
        hint(`套用模板失败：${aiFailure(error)}`);
      }
      return;
    }
    if (typeof item.suggestion === 'string' && item.markdown === '') {
      // 「照这条改」：先把建议当指令跑一次草稿，再让作者写入。
      await draft(item.suggestion);
      return;
    }
    setText(item.markdown);
    hint('已经写进右边了 —— 看过之后点「保存」才算数。');
  }

  const onClick = (event) => {
    const quick = event.target?.closest?.('[data-doc-ai-quick]');
    if (quick && root.contains(quick)) {
      const index = Number(quick.getAttribute('data-doc-ai-quick'));
      const item = QUICK[index];
      if (item) void draft(item[1]);
      return;
    }
    const applyBtn = event.target?.closest?.('[data-doc-ai-apply]');
    if (applyBtn && root.contains(applyBtn)) {
      void apply(Number(applyBtn.getAttribute('data-doc-ai-apply')));
      return;
    }
    const suggestBtn = event.target?.closest?.('[data-doc-ai-suggest]');
    if (suggestBtn && root.contains(suggestBtn)) {
      void apply(Number(suggestBtn.getAttribute('data-doc-ai-suggest')));
      return;
    }
    const grantBtn = event.target?.closest?.('[data-doc-ai-grant]');
    if (grantBtn && root.contains(grantBtn)) {
      void grantAndRetry(String(grantBtn.getAttribute('data-doc-ai-grant') ?? 'edit_content'));
      return;
    }
    const action = event.target?.closest?.('[data-doc-ai-action]');
    if (!action || !root.contains(action)) return;
    const name = action.getAttribute('data-doc-ai-action');
    if (name === 'collapse') {
      root.classList.toggle('is-collapsed');
      return;
    }
    if (name === 'send') {
      const instruction = String(input?.value ?? '').trim();
      if (instruction === '') {
        hint('先写一句要 AI 干什么。');
        return;
      }
      if (input) input.value = '';
      void draft(instruction);
      return;
    }
    if (name === 'review') void review();
  };

  const onKeydown = (event) => {
    // Ctrl/⌘ + Enter 发送：一句话说完就发，不用把手从键盘上挪开。
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (sendBtn) sendBtn.click();
    }
  };

  root.addEventListener('click', onClick);
  input?.addEventListener('keydown', onKeydown);

  const handle = {
    // 写成属性箭头函数而不是方法简写：静态扫描会把 `destroy()` 这种简写当成一次裸调用。
    destroy: () => {
      root.removeEventListener?.('click', onClick);
      input?.removeEventListener?.('keydown', onKeydown);
      if (live === handle) live = null;
    },
    root,
  };
  live = handle;
  return handle;
}

export function destroyDocAi() {
  if (live && typeof live.destroy === 'function') live.destroy();
  live = null;
  pending = [];
}

/** 把接口错误翻成一句人话 —— 授权/没配 key 这两条是作者真会撞上的。 */
function aiFailure(error) {
  const status = Number(error?.status) || 0;
  if (status === 403) return '没有「修改内容」这项能力授权：去「AI 编辑台」授权之后再回来。';
  if (status === 503) return '这台服务器没配 AI key（AI_API_KEY），模型调不动。';
  if (status === 429) return '调用太密了（每分钟 5 次），过一会儿再说。';
  if (status === 504) return '模型这次超时了，再试一次。';
  return `AI 调用失败：${apiErrorText(error)}`;
}

/**
 * 失败卡片。授权那条要给一颗**能点的按钮** —— 403 是作者最先撞上的墙（六项能力默认全关），
 * 点一下就地授权、再把刚才那句话重跑一遍，别让人自己去找「AI 编辑台」再回来重打指令。
 */
function errorCard(error) {
  const status = Number(error?.status) || 0;
  if (status === 403) {
    return (
      '<div class="doc-ai-card doc-ai-error">没有「修改内容」这项能力授权。' +
      '<div class="doc-actions">' +
      '<button class="btn btn-sm btn-primary" type="button" data-doc-ai-grant="edit_content">授权「修改内容」并重试</button>' +
      '<a class="btn btn-sm btn-ghost" href="#/ai-edit">去 AI 编辑台</a>' +
      '</div>' +
      '<div class="doc-hint">授权是高风险操作，按下去就算你确认；随时能在 AI 编辑台收回。</div></div>'
    );
  }
  return `<div class="doc-ai-card doc-ai-error">${esc(aiFailure(error))}</div>`;
}
