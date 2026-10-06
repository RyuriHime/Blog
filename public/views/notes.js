// 学术笔记工作台页（note-studio 的宿主页面）。

import { $, emptyHtml, esc, loadingHtml, toast, ui } from '../core/dom.js';
import { api } from '../core/api.js';
import { apiErrorText, toastError } from '../core/errors.js';
import { navigate } from '../core/router.js';
import { state } from '../core/state.js';
import * as Fmt from '../core/format.js';

const NT_KATEX = {
  css: '/notes/vendor/katex/katex.min.css',
  js: '/notes/vendor/katex/katex.min.js',
  autoRender: '/notes/vendor/katex/contrib/auto-render.min.js',
};
const ntState = { tab: 'mine', mine: [], publicCount: 0, square: [], reading: null, busy: false };
const ntScripts = new Map();
function ntLoadScript(src) {
  if (ntScripts.has(src)) return ntScripts.get(src);
  const task = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`脚本加载失败：${src}`));
    document.head.appendChild(script);
  });
  ntScripts.set(src, task);
  return task;
}
function ntStyleOnce(id, href) {
  if (document.getElementById(id)) return;
  const link = document.createElement('link');
  link.id = id;
  link.rel = 'stylesheet';
  link.href = href;
  document.head.appendChild(link);
}

// 复用 note-studio 自带的离线 KaTeX（就在 /notes/vendor 下），不拉任何 CDN。
async function ntEnsureKatex() {
  ntStyleOnce('nt-katex-css', NT_KATEX.css);
  await ntLoadScript(NT_KATEX.js);
  await ntLoadScript(NT_KATEX.autoRender);
}
function ntRenderMath(root) {
  if (!root) return;
  ntEnsureKatex()
    .then(() => {
      if (typeof window.renderMathInElement === 'function') {
        window.renderMathInElement(root, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '\\[', right: '\\]', display: true },
            { left: '$', right: '$', display: false },
            { left: '\\(', right: '\\)', display: false },
          ],
          throwOnError: false,
        });
      }
    })
    .catch(() => {
      /* KaTeX 没取到就当纯文本看，不影响阅读 */
    });
}
async function ntReload() {
  const [mine, square] = await Promise.all([api('/api/notes-mine'), api('/api/notes-square')]);
  ntState.mine = mine.notes ?? [];
  ntState.publicCount = mine.publicCount ?? ntState.mine.filter((note) => note.public).length;
  ntState.square = square.notes ?? [];
}
async function viewNotes() {
  ui.app.innerHTML = loadingHtml();
  if (!state.me) {
    state.redirect = '/notes';
    navigate('/login');
    return;
  }
  ntState.tab = 'mine';
  ntState.reading = null;
  try {
    await ntReload();
  } catch (error) {
    if (error?.aborted) return; // 页面已经切走了
    const text = apiErrorText(error);
    if (!text) return; // 已经处理过（例如已跳登录页）
    ui.app.innerHTML = `<div class="card">${emptyHtml('📓', '笔记功能暂时打不开', esc(text))}</div>`;
    return;
  }
  ntRender();
}
function ntRender() {
  if (ntState.reading) {
    ntRenderReading();
    return;
  }
  const { mine, square } = ntState;

  const head = `
    <section class="card">
      <div class="card-head">
        <h1 style="font-size:21px">📓 学术笔记</h1>
        <a class="btn btn-sm btn-primary" href="/notes/" target="_blank" rel="noopener">✏️ 打开编辑器</a>
      </div>
      <div class="page-sub">支持 Markdown 与 LaTeX 公式，图片可以转成文字或公式，也有 AI 帮你整理和审阅。笔记默认私密，只有你自己看得到；想分享就点「公开」。</div>
      <div class="nt-stats">
        <span class="nt-stat"><strong>${Fmt.fmtNum(mine.length)}</strong> 篇我的笔记</span>
        <span class="nt-stat"><strong>${Fmt.fmtNum(ntState.publicCount)}</strong> 篇已公开</span>
        <span class="nt-stat"><strong>${Fmt.fmtNum(square.length)}</strong> 篇广场可见</span>
      </div>
    </section>`;

  const tabs = `
    <div class="nt-tabs" id="ntTabs">
      <button class="nt-tab${ntState.tab === 'mine' ? ' is-on' : ''}" type="button" data-nt-tab="mine">📒 我的笔记</button>
      <button class="nt-tab${ntState.tab === 'square' ? ' is-on' : ''}" type="button" data-nt-tab="square">🌐 公开广场${square.length ? ` (${Fmt.fmtNum(square.length)})` : ''}</button>
    </div>`;

  const list = ntState.tab === 'mine' ? ntMineHtml(mine) : ntSquareHtml(square);
  ui.app.innerHTML = head + tabs + list;
  ntBind();
}
function ntMineHtml(notes) {
  if (!notes.length) {
    return `<section class="card" id="ntList">${emptyHtml(
      '📝',
      '你还没有笔记',
      '点右上角「打开编辑器」写第一篇 —— 新笔记默认是私密的，只有你自己看得到',
    )}</section>`;
  }
  const rows = notes
    .map(
      (note) => `
      <div class="nt-item">
        <div class="nt-item-main">
          <div class="nt-item-title">
            <span>${esc(note.title || note.name)}</span>
            ${note.public ? '<span class="nt-tag is-public">已公开</span>' : '<span class="nt-tag">私密</span>'}
          </div>
          <div class="nt-item-meta">${Fmt.timeAgo(note.updatedAt)}更新 · ${Fmt.fmtNum(note.bytes)} 字节${note.public && note.sharedAt ? ` · ${Fmt.timeAgo(note.sharedAt)}公开` : ''}</div>
        </div>
        <div class="nt-item-actions">
          <button class="btn btn-sm" type="button" data-nt-act="${note.public ? 'unpublish' : 'publish'}" data-nt-name="${esc(note.name)}">${note.public ? '🙈 取消公开' : '🌐 公开'}</button>
          <button class="btn btn-sm btn-danger" type="button" data-nt-act="delete" data-nt-name="${esc(note.name)}">🗑 删除</button>
        </div>
      </div>`,
    )
    .join('');
  return `<section class="card" id="ntList"><div class="nt-list">${rows}</div></section>`;
}
function ntSquareHtml(notes) {
  if (!notes.length) {
    return `<section class="card" id="ntList">${emptyHtml('🌐', '广场上还没有笔记', '大家公开出来的笔记会出现在这里')}</section>`;
  }
  const rows = notes
    .map(
      (note) => `
      <div class="nt-item is-clickable" data-nt-open="1" data-nt-owner="${esc(note.ownerId)}" data-nt-name="${esc(note.name)}">
        <div class="nt-item-main">
          <div class="nt-item-title"><span>${esc(note.title || note.name)}</span></div>
          <div class="nt-item-meta">${esc(note.ownerName || note.ownerId)} · ${Fmt.timeAgo(note.updatedAt)}更新 · 约 ${Fmt.fmtNum(note.readingMinutes ?? 1)} 分钟</div>
          ${note.excerpt ? `<div class="nt-excerpt">${esc(note.excerpt)}</div>` : ''}
        </div>
        <div class="nt-item-actions"><span class="nt-open">阅读 →</span></div>
      </div>`,
    )
    .join('');
  return `<section class="card" id="ntList"><div class="nt-list">${rows}</div></section>`;
}
function ntRenderReading() {
  const note = ntState.reading;
  const owner = note.owner?.name || note.owner?.id || '';
  ui.app.innerHTML = `
    <section class="card">
      <div class="card-head">
        <h1 style="font-size:21px">${esc(note.title || note.name)}</h1>
        <button class="btn btn-sm" type="button" id="ntBack">← 返回广场</button>
      </div>
      <div class="page-sub">${esc(owner)} 的公开笔记 · ${Fmt.timeAgo(note.updatedAt)}更新</div>
    </section>
    <section class="card">
      <article class="md nt-article" id="ntArticle">${note.html || `<p>${esc(note.markdown || '')}</p>`}</article>
    </section>`;
  const back = document.getElementById('ntBack');
  if (back) {
    back.addEventListener('click', () => {
      ntState.reading = null;
      ntRender();
    });
  }
  // note.html 是服务端用 src/markdown.js 渲染的：先全量转义再注入白名单标签，不会带出脚本。
  ntRenderMath(document.getElementById('ntArticle'));
}
function ntBind() {
  const tabs = document.getElementById('ntTabs');
  if (tabs) {
    tabs.addEventListener('click', (event) => {
      const button = event.target.closest('[data-nt-tab]');
      if (!button) return;
      ntState.tab = button.dataset.ntTab === 'square' ? 'square' : 'mine';
      ntRender();
    });
  }
  const list = document.getElementById('ntList');
  if (list) list.addEventListener('click', ntOnListClick);
}
async function ntOnListClick(event) {
  if (ntState.busy) return;

  const open = event.target.closest('[data-nt-open]');
  if (open) {
    await ntOpenNote(open.dataset.ntOwner, open.dataset.ntName);
    return;
  }

  const button = event.target.closest('[data-nt-act]');
  if (!button) return;
  const { ntAct, ntName } = button.dataset;
  const path = `/api/notes/${encodeURIComponent(ntName)}`;

  if (ntAct === 'delete') {
    if (!window.confirm(`确定删掉「${ntName}」吗？删了就找不回来了。`)) return;
    await ntMutate(path, 'DELETE', '笔记已删除');
  } else if (ntAct === 'publish') {
    await ntMutate(`${path}/publish`, 'POST', '已公开，广场上能看到了');
  } else if (ntAct === 'unpublish') {
    await ntMutate(`${path}/unpublish`, 'POST', '已取消公开，别人看不到这篇了');
  }
}
async function ntMutate(path, method, successMessage) {
  ntState.busy = true;
  try {
    await api(path, { method });
    toast(successMessage, 'success');
    await ntReload();
    ntRender();
  } catch (error) {
    toastError(error, '操作失败');
  } finally {
    ntState.busy = false;
  }
}
/**
 * §8.1 积木优先：这一篇笔记如果已经长成了一份文档，就用文档渲染。
 * 读的是 /api/docs/notes/lookup（笔记名 → 文档），失败一律返回 null 退回文件路径 ——
 * 接线是「优先」而不是「替代」，老笔记一条都不能打不开。
 */
async function ntDocFor(ownerId, name) {
  try {
    const found = await api(
      `/api/docs/notes/lookup?ownerId=${encodeURIComponent(ownerId)}&name=${encodeURIComponent(name)}`,
    );
    if (!found || found.found !== true || !found.doc) return null;
    const data = await api(`/api/docs/${found.doc.id}`);
    if (!data || !data.html) return null;
    if (data.doc && data.doc.deleted === true) return null;
    if (data.abilities && data.abilities.canView === false) return null;
    const authorName = (data.doc.author && data.doc.author.username) || '';
    return {
      name,
      title: (data.doc && data.doc.title) || name,
      html: data.html,
      markdown: '',
      owner: { id: ownerId, name: authorName || String(ownerId) },
      updatedAt: data.doc && data.doc.updatedAt,
      readingMinutes: 1,
    };
  } catch (error) {
    return null;
  }
}

/**
 * 打开自己公开出来的笔记时顺手把它导成一份文档（幂等，服务端只对变化写修订）。
 * 失败不抛 —— 导入是加分项，不该挡住阅读。
 */
async function ntImportDoc(note, name) {
  try {
    await api('/api/docs/notes/import', {
      method: 'POST',
      body: {
        name,
        title: note.title || name,
        markdown: note.markdown || '',
        scope: note.public ? 'public' : 'private',
      },
    });
  } catch (error) {
    /* 导入失败退回文件路径，不打扰读者 */
  }
}
async function ntOpenNote(ownerId, name) {
  ntState.busy = true;
  try {
    const note = await api(`/api/notes-square/${encodeURIComponent(ownerId)}/${encodeURIComponent(name)}`);
    if (!note || !note.html) throw new Error('这篇笔记已经不再公开了');
    if (state.me && String(state.me.id) === String(ownerId)) await ntImportDoc(note, name);
    const brick = await ntDocFor(ownerId, name);
    if (brick) {
      ntState.reading = brick;
      ntRender();
      return;
    }
    ntState.reading = note;
    ntRender();
  } catch (error) {
    toastError(error, '打不开这篇笔记');
  } finally {
    ntState.busy = false;
  }
}

// ── 导出 ──────────────────────────────────────────────────────────────
export { NT_KATEX };
export { ntState };
export { ntScripts };
export { ntLoadScript };
export { ntStyleOnce };
export { ntEnsureKatex };
export { ntRenderMath };
export { ntReload };
export { viewNotes };
export { ntRender };
export { ntMineHtml };
export { ntSquareHtml };
export { ntRenderReading };
export { ntBind };
export { ntOnListClick };
export { ntMutate };
export { ntOpenNote };

/* @hand-written */
