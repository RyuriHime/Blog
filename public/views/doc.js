// 积木（可编程帖子 / 笔记 / 个人主页）的页面。
//
//   积木广场     #/docs            列表 + 筛选 + 新建
//   阅读页       #/doc/:id         外壳 + 后端渲染好的正文
//   编辑器       #/doc/:id/edit    积木模式 / Markdown 模式
//   开发者功能   #/dev             块类型表（速查 + 注册）+ 我自己的脚本模板
//
// `#/blocks` 是登记在案的旧地址（README、侧栏、doc-smoke 都引用它），
// 它进的还是这一页 —— 块类型表只是从「独立一个 Tab」挪进了开发者功能里，
// 页面本身没有下线，旧书签照样能打开。
//
// 两条贯穿全文件的纪律：
//   1. **正文的 HTML 一律由后端出**（`src/modules/doc/blocks/html.js`）。
//      前端只画外壳、只发请求。想「在浏览器里先把块渲染一遍」的冲动要忍住 ——
//      那等于把块引擎实现两遍，出错时你分不清是哪一遍错了。
//   2. **编辑器只有一个「保存」**（`saveAll()`）：标题、可见范围、正文一起存。
//      「标题和正文分开存」是给实现找的方便，不是给作者找的方便 —— 作者心里
//      「这篇改完了」是一件事。块仍然一块一块写进后端（一次 PUT 一块），
//      但那是 `saveAll()` 内部的事，作者不用知道。
//
// 权限只做「藏按钮」，真正的判断在后端 —— 前端藏起来的按钮不叫权限。

import { $, emptyHtml, esc, loadingHtml, toast, ui } from '../core/dom.js';
import { api, withButtonBusy } from '../core/api.js';
import { toastError } from '../core/errors.js';
import { navigate } from '../core/router.js';
import { state, DOC_LAYOUTS } from '../core/state.js';
import * as Fmt from '../core/format.js';
import * as Prefs from '../core/preferences.js';
import * as Blocks from './doc-blocks.js';
import * as Ai from './ai.js';
import { reactionBarHtml } from './post.js';
import { attachSandbox, unmountSandboxes } from '../core/sandbox.js';
import { ntRenderMath } from './notes.js';

/** 元数据只拉一次：块类型表 / 模板表 / 两个枚举，整个会话里不会变。 */
const docState = {
  types: [],
  templates: [],
  kinds: [],
  scopes: [],
  popularTags: [],
  maxTags: 5,
  maxTagLength: 24,
  editor: null,
  viewing: null,
  stationId: 0,
  listQuery: null,
};

/** 开发者功能里的「我的脚本模板」：只对登录用户有意义，没登录就是一份空表。 */
const scriptTemplateState = { templates: [], limit: 0, maxCode: 0, loaded: false, failed: false };

/** Markdown 模式的两件外挂的生命周期手柄（防抖句柄 + AI 抽屉实例）。 */
let mdPreviewTimer = null;
let mdNotesPanel = null;

async function loadMeta(force = false) {
  if (!force && docState.types.length > 0) return;
  const [types, meta, tags] = await Promise.all([
    api('/api/docs/meta/block-types'),
    api('/api/docs/meta/templates'),
    // 标签上限与「大家在用的标签」都从服务端来：客户端不该自己发明一份 5 / 24。
    // 拉不到不算事故（老服务器 / 离线），退成一份空表，编辑器照常能用。
    api('/api/docs/meta/tags').catch(() => ({ tags: [], maxTags: 5, maxTagLength: 24 })),
  ]);
  docState.types = types.types ?? [];
  docState.templates = meta.templates ?? [];
  docState.kinds = meta.kinds ?? [];
  docState.scopes = meta.scopes ?? [];
  docState.popularTags = tags.tags ?? [];
  docState.maxTags = Number(tags.maxTags ?? 5);
  docState.maxTagLength = Number(tags.maxTagLength ?? 24);
}

/**
 * 拉一次「我的脚本模板」。
 *
 * 未登录时这个接口是 401 —— 那一页对游客也开着（教程、块类型表都看得见），
 * 所以这里**不能让它把整页带崩**：失败就当成一份空表，页面上照常显示「登录后可以存」。
 */
async function loadScriptTemplates(force = false) {
  if (scriptTemplateState.loaded && !force) return;
  scriptTemplateState.loaded = true;
  scriptTemplateState.failed = false;
  try {
    const data = await api('/api/docs/meta/script-templates');
    scriptTemplateState.templates = data.templates ?? [];
    scriptTemplateState.limit = Number(data.limit ?? 0);
    scriptTemplateState.maxCode = Number(data.maxCode ?? 0);
  } catch {
    scriptTemplateState.templates = [];
    scriptTemplateState.failed = true;
  }
}

const scriptTemplateById = (id) => scriptTemplateState.templates.find((item) => Number(item.id) === Number(id)) ?? null;


const typeDef = (name) => docState.types.find((item) => item.name === name) ?? null;

/** 表单取值：`querySelectorAll` 在假 DOM 里返回空数组，所以这段永远安全。 */
function formValues(form) {
  const values = {};
  for (const node of form.querySelectorAll('[name]')) {
    values[node.name] = node.type === 'checkbox' ? node.checked : node.value;
  }
  return values;
}

const optionsHtml = (list, current) =>
  list
    .map((item) => `<option value="${esc(item.value)}"${item.value === current ? ' selected' : ''}>${esc(item.label)}</option>`)
    .join('');

/**
 * 标签框里的字 → 数组。分隔符跟服务端同一套：逗号 / 中文逗号 / 顿号 / # / 空白。
 *
 * 服务端才是权威（那里也会挡），这里先挡一道的理由是界面：不挡住的话，
 * 会是「标题存进去了、标签被退回」的半截状态 —— 作者看到的是「存好了」。
 */
function parseTags(text) {
  const list = [];
  for (const raw of String(text ?? '').split(/[,，#、\s]+/)) {
    const tag = raw.trim().replace(/^#+/, '');
    if (!tag) continue;
    if (tag.length > docState.maxTagLength) return { error: `标签「${tag}」太长了，最多 ${docState.maxTagLength} 个字` };
    if (list.some((item) => item.toLowerCase() === tag.toLowerCase())) continue;
    list.push(tag);
  }
  if (list.length > docState.maxTags) return { error: `一篇最多 ${docState.maxTags} 个标签` };
  return { tags: list };
}

const scopeOptionsHtml = (current) => optionsHtml(docState.scopes, current);

function download(filename, payload) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/* ------------------------------------------------------------------ */
/* 积木广场                                                            */
/* ------------------------------------------------------------------ */

/** 标签徽章：点一下就去看「所有同标签的积木」。 */
function tagChipsHtml(tags) {
  return (tags ?? [])
    .filter((tag) => typeof tag === 'string' && tag)
    .map((tag) => `<a class="doc-tag" href="#/docs?tag=${encodeURIComponent(tag)}">#${esc(tag)}</a>`)
    .join('');
}

function docCardHtml(doc) {
  const author = doc.author ?? {};
  const tags = tagChipsHtml(doc.tags);
  return `<div class="doc-card-item">
  <a class="doc-card" href="#/doc/${esc(doc.id)}">
    <div class="doc-card-title">${esc(doc.title || '（无标题）')}</div>
    <div class="doc-badges">
      <span class="doc-badge doc-badge-kind">${esc(doc.kindLabel ?? '')}</span>
      <span class="doc-badge doc-badge-scope">${esc(doc.scopeLabel ?? '')}</span>
    </div>
    <div class="doc-card-meta">${esc(author.displayName ?? author.username ?? '')} · ${esc(Fmt.timeAgo(doc.updatedAt))}</div>
  </a>
  ${tags ? `<div class="doc-card-tags">${tags}</div>` : ''}
</div>`;
}

/**
 * 「新建一篇」= **一次点击就落到 Markdown 编辑区**。
 *
 * 以前这里要先摊一个表单（标题 / 形态 / 范围），再摊一墙模板卡片 ——
 * 结果是「一个字都还没写，先做三道选择题」。现在直接建一篇标题叫「未命名」的，
 * 建完立刻跳进编辑器：标题在编辑页顶部改，可见范围也在那儿改，
 * 想换形态、想写脚本、想套模板都在编辑页里切。
 */
async function newDocAndEdit() {
  const created = await api('/api/docs', {
    method: 'POST',
    body: { title: '未命名', kind: 'post', scope: 'public', template: '' },
  });
  toast('建好了，开始写吧');
  return navigate(`/doc/${created.doc.id}/edit`);
}

/**
 * 积木广场：`#/docs?kind=&mine=1&q=&tag=`。
 *
 * 两种排法（`forum:docsLayout`）：grid = 一行多个的平铺，list = 从上往下列下来。
 * 排法只影响这一个列表的壳，卡片本身是同一个函数渲染的。
 */
async function viewDocs(query = new URLSearchParams()) {
  leaveDocPage();
  await loadMeta();
  docState.listQuery = new URLSearchParams(query);
  const kind = query.get('kind') ?? '';
  const mine = query.get('mine') === '1';
  const q = query.get('q') ?? '';
  const tag = query.get('tag') ?? '';
  const layout = Prefs.docsLayout() === 'list' ? 'list' : 'grid';
  const params = new URLSearchParams();
  if (kind) params.set('kind', kind);
  if (mine) params.set('mine', '1');
  if (q) params.set('q', q);
  if (tag) params.set('tag', tag);
  const data = await api(`/api/docs${params.toString() ? `?${params}` : ''}`);
  const documents = data.documents ?? [];
  const layoutTabs = DOC_LAYOUTS.map(
    ([key, label]) =>
      `<button class="tab ${layout === key ? 'is-active' : ''}" type="button" data-doc-action="layout" data-layout="${key}">${label}</button>`,
  ).join('');

  ui.app.innerHTML = `
    <div class="card doc-panel">
      <div class="card-head">
        <span class="card-title">🧩 积木广场</span>
        <span class="hint">${Fmt.fmtNum(data.total ?? documents.length)} 篇</span>
      </div>
      ${
        tag
          ? `<div class="doc-active-tag">正在看标签 <strong>#${esc(tag)}</strong><a class="btn btn-sm btn-ghost" href="#/docs">看全部</a></div>`
          : ''
      }
      <form class="doc-filters" data-doc-form="filter">
        <input type="hidden" name="tag" value="${esc(tag)}">
        <input class="doc-input" type="search" name="q" value="${esc(q)}" placeholder="搜标题或正文摘要…">
        <select class="doc-input doc-select" name="kind">
          <option value="">全部形态</option>
          ${optionsHtml(docState.kinds.filter((item) => item.value !== 'note'), kind)}
        </select>
        <label class="doc-check-label"><input type="checkbox" class="doc-check" name="mine"${mine ? ' checked' : ''}>只看我的</label>
        <button class="btn btn-sm btn-primary" type="submit">筛选</button>
      </form>
      <div class="doc-actions">
        ${state.me ? '<button class="btn btn-sm" type="button" data-doc-action="new">＋ 新建一篇</button>' : '<a class="btn btn-sm" href="#/login">登录后可以新建</a>'}
        <a class="btn btn-sm" href="#/wiki">⧉ Wiki 站</a>
        <a class="btn btn-sm btn-ghost" href="#/dev">🛠 开发者功能</a>
        <div class="tabs tabs-sm doc-layout-tabs">${layoutTabs}</div>
      </div>
    </div>
    ${
      documents.length
        ? `<div class="${layout === 'list' ? 'doc-list' : 'doc-grid'}">${documents.map(docCardHtml).join('')}</div>`
        : `<div class="card">${emptyHtml('🧩', '还没有积木', '换一个筛选条件，或者新建一篇')}</div>`
    }`;

  ensureDelegate();
}

/* ------------------------------------------------------------------ */
/* 阅读页                                                              */
/* ------------------------------------------------------------------ */

function warningsHtml(warnings) {
  return `<div class="card doc-warn">
    <div class="card-head"><span class="card-title">⚠️ 有 ${warnings.length} 块降级了</span></div>
    <ul class="doc-schema">${warnings
      .map((item) => `<li><code class="doc-code">${esc(item.block_id ?? '?')}</code> ${esc(item.message ?? item.code ?? '')}</li>`)
      .join('')}</ul>
    <div class="doc-hint">降级的块不会让整篇白屏，也不会抛异常 —— 它们只是显示成占位。</div>
  </div>`;
}

/**
 * 互动区。赞 / 踩 / 投币 / 收藏 / 转发 / 关注 / AI 解读**就在积木页里**。
 *
 * 这些数据全都长在影子行（`posts` 那一行）上 —— 但那是存放位置，不是使用位置。
 * 积木才是正文的正式形态，帖子只是它的影子；让读者为了点个赞跳走是本末倒置。
 *
 * 具体那条互动条交给 `views/post.js` 的 `reactionBarHtml` 画：同一份实现、同一套事件
 * （`core/events.js` 里 reaction / coin / bookmark 都按 `data-id` 找帖子，这里给的就是
 * 影子行 id），所以积木页和帖子页的行为不会两边不一样。真正的数据由
 * `GET /api/docs/:id/anchor` 按当前访客读出来（见 `mountInteraction`）。
 */
function interactHtml(doc, abilities) {
  if (!doc.anchorPostId) return '';
  if (!abilities.canReact) {
    // 看不见这篇的人也看不见这条 —— 前端只负责不画按钮，能不能动在后端。
    return `<div class="card doc-interact">
      <div class="doc-hint">这篇对「${esc(doc.scopeLabel ?? '不公开')}」可见。赞 / 投币 / 收藏记在它的互动锚点上，只有看得见这篇的人给得上。</div>
    </div>`;
  }
  return `<div class="card doc-interact">
    <div class="doc-interact-bar" data-doc-interact-bar><div class="doc-hint">互动条加载中…</div></div>
    <div class="doc-interact-ai" data-doc-interact-ai></div>
  </div>`;
}

/**
 * 阅读页的互动条 + AI 解读面板：正文挂好之后再异步填。
 *
 * 为什么分开取：正文是「谁都能看的那部分」，互动状态是「按访客算的那部分」——
 * 后者慢、还依赖登录，不该拖着文章不让显示。
 */
async function mountInteraction(doc) {
  const anchorHost = $('[data-doc-interact-bar]');
  if (!anchorHost || !doc.anchorPostId) return;
  const anchorId = Number(doc.anchorPostId);
  const bar = anchorHost;
  let post = null;
  try {
    const data = await api(`/api/docs/${doc.id}/anchor`);
    post = data?.post ?? null;
  } catch (error) {
    bar.innerHTML = `<div class="doc-hint">互动条没读出来：${esc(error.message)}</div>`;
    return;
  }
  if (!post) {
    bar.innerHTML = '<div class="doc-hint">这篇还没有互动锚点（刚建出来或还在同步），刷新一下就有了。</div>';
    return;
  }
  bar.innerHTML = reactionBarHtml(post);
  const aiHost = $('[data-doc-interact-ai]');
  if (!aiHost) return;
  // AI 面板按 postId 工作（它读的是帖子表），影子行 id 就是它的 postId。
  let aiInfo = { cached: null, stale: false };
  try {
    aiInfo = await api(`/api/ai/posts/${anchorId}`);
  } catch {
    aiInfo = { cached: null, stale: false };
  }
  aiHost.innerHTML = Ai.aiPostPanelHtml(post, aiInfo);
}

function docActionsHtml(doc, abilities) {
  const bits = [];
  if (abilities.canEdit) {
    bits.push(`<a class="btn btn-sm btn-primary" href="#/doc/${esc(doc.id)}/edit">编辑</a>`);
    bits.push('<button class="btn btn-sm" type="button" data-doc-action="revisions">修订记录</button>');
    bits.push('<button class="btn btn-sm" type="button" data-doc-action="export">导出</button>');
    bits.push('<button class="btn btn-sm btn-ghost" type="button" data-doc-action="delete">删除</button>');
  }
  bits.push('<a class="btn btn-sm btn-ghost" href="#/docs">回广场</a>');
  return bits.join('');
}

/** 离开积木页面时的统一收尾：先收外挂，再拆沙箱，最后换 DOM。 */
function leaveDocPage() {
  if (mdPreviewTimer) {
    clearTimeout(mdPreviewTimer);
    mdPreviewTimer = null;
  }
  if (mdNotesPanel && typeof mdNotesPanel.destroy === 'function') {
    try {
      mdNotesPanel.destroy();
    } catch (error) {
      console.warn('[notes-agent] 积木工作台销毁失败：', error);
    }
  }
  mdNotesPanel = null;
  unmountSandboxes();
  // wiki 站是三栏（左树 / 中正文 / 右目录），再叠上论坛自己的 306px 侧栏
  //（我的账户、热榜）正文就只剩三百来像素 —— 所以站页面挂 `body.doc-wide`
  // 把侧栏让开（规则见 41-doc.css；换页时由 router 统一摘掉）。
  document.body.classList.remove('doc-wide');
  ui.app.innerHTML = loadingHtml();
}

/**
 * 阅读页渲染完把每个 `app` 块的 iframe 挂上宿主（§6.3 的看门狗在这里起算）。
 * 块数据从**服务端返回的 `blocks`** 里取，不从 DOM 里反推 ——
 * props 是 `init` 消息要送的东西，DOM 里只剩一份转义过的 HTML。
 */
function mountSandboxes(data, root = ui.app, onDerivedChange = scheduleDerivedReload) {
  const blocks = new Map((data.blocks ?? []).map((block) => [block.blockId, block]));
  const documentId = data.doc?.id;
  const frames = typeof root.querySelectorAll === 'function'
    ? root.querySelectorAll('iframe.doc-app-frame')
    : [];
  for (const frame of frames) {
    const block = blocks.get(frame.dataset?.docBlock ?? '');
    attachSandbox(frame, block, { documentId, onDerivedChange });
  }
}

/** 上一次渲染出来的正文 HTML 与文档 id（脚本产出后判断要不要重画）。 */
let lastRenderedHtml = '';
let lastRenderedId = null;
let derivedReloadTimer = 0;

/**
 * 脚本往派生层写了东西（`blocks.derived` 的 put / delete）→ 重新拉一次这篇文档。
 *
 * 250ms 防抖：一个脚本循环里连写十块，只该重画一次。
 * 重画之前必须 `unmountSandboxes()` —— 旧 iframe 会被 innerHTML 丢掉，
 * 而它们的看门狗还挂在 registry 里（见 core/sandbox.js 的注释）。
 */
function scheduleDerivedReload() {
  if (derivedReloadTimer) clearTimeout(derivedReloadTimer);
  derivedReloadTimer = setTimeout(async () => {
    derivedReloadTimer = 0;
    const id = docState.viewing;
    if (!id) return;
    try {
      const fresh = await api(`/api/docs/${id}`);
      if (docState.viewing !== id) return;
      if (lastRenderedId === id && String(fresh?.html ?? '') === lastRenderedHtml) return;
      unmountSandboxes();
      renderDoc(fresh);
    } catch (error) {
      console.warn('[doc] 脚本产出刷新失败：', error);
    }
  }, 250);
}

/**
 * Wiki 边栏：分类 → 页面。
 *
 * `nav` 完全由后端给（`GET /api/docs/wiki` 与 `GET /api/docs/wiki/:name` 都带），
 * 而且**只含看得见的页** —— 私有页不能因为名字出现在目录里而泄露存在性。
 * 前端一行过滤逻辑都不写，就是照单渲染。
 */
function wikiNavHtml(nav, doc) {
  const categories = nav?.categories ?? [];
  const pages = nav?.pages ?? [];
  const current = String(doc?.title ?? '');
  const me = pages.find((page) => page.title === current);
  const groups = categories.length ? categories : [{ name: '', count: pages.length }];
  const groupHtml = groups
    .map((group) => {
      const items = pages.filter((page) => (page.category ?? '') === group.name);
      if (items.length === 0) return '';
      const links = items
        .map(
          (page) =>
            `<a class="doc-wiki-nav-link${page.title === current ? ' is-current' : ''}" href="#/wiki/${encodeURIComponent(page.title)}" data-wiki-title="${esc(page.title)}">${esc(page.title)}</a>`,
        )
        .join('');
      return `<div class="doc-wiki-nav-group" data-wiki-group>
        <div class="doc-wiki-nav-cat"><span>${esc(group.name || '未分类')}</span><span>${Number(group.count) || items.length}</span></div>
        ${links}
      </div>`;
    })
    .join('');
  const tools = [];
  if (state.me) {
    tools.push(
      `<input class="doc-input" type="search" data-wiki-filter placeholder="按标题筛选…" aria-label="筛选 wiki 页面">`,
      `<input class="doc-input" type="text" data-wiki-new-name placeholder="新页面标题" aria-label="新页面标题">`,
      `<button class="btn btn-sm" type="button" data-doc-action="wiki-new">新建页面</button>`,
    );
  }
  if (doc?.abilities?.canEdit) {
    tools.push(
      `<input class="doc-input" type="text" data-wiki-category value="${esc(me?.category ?? '')}" placeholder="这一页的分类" aria-label="这一页的分类">`,
      `<button class="btn btn-sm" type="button" data-doc-action="wiki-cat">${me ? '改分类' : '存分类'}</button>`,
    );
  }
  return `<aside class="doc-wiki-nav">
    <div class="doc-wiki-nav-head"><span>⧉ Wiki 目录</span><span class="hint">${pages.length} 页</span></div>
    <div data-wiki-groups>${groupHtml || '<div class="doc-wiki-nav-empty">目录还是空的。</div>'}</div>
    <div class="doc-wiki-nav-hidden" data-wiki-nothing hidden>没有匹配的页面。</div>
    ${tools.length ? `<div class="doc-wiki-nav-tools">${tools.join('')}</div>` : ''}
  </aside>`;
}

/** 边栏里的筛选框：纯前端过滤已经渲染好的链接，不发请求。 */
function mountWikiNav() {
  const box = $('[data-wiki-filter]');
  if (!box || typeof box.addEventListener !== 'function') return;
  box.addEventListener('input', () => {
    const needle = String(box.value ?? '').trim().toLowerCase();
    const links = typeof ui.app.querySelectorAll === 'function' ? ui.app.querySelectorAll('[data-wiki-title]') : [];
    let visible = 0;
    for (const link of links) {
      const match = !needle || String(link.dataset?.wikiTitle ?? '').toLowerCase().includes(needle);
      if (link.hidden !== undefined) link.hidden = !match;
      if (match) visible += 1;
    }
    const groups = typeof ui.app.querySelectorAll === 'function' ? ui.app.querySelectorAll('[data-wiki-group]') : [];
    for (const group of groups) {
      const any = typeof group.querySelectorAll === 'function' ? group.querySelectorAll('[data-wiki-title]') : [];
      const hit = needle ? [...any].some((link) => !link.hidden) : true;
      if (group.hidden !== undefined) group.hidden = !hit;
    }
    const nothing = $('[data-wiki-nothing]');
    if (nothing && nothing.hidden !== undefined) nothing.hidden = needle ? visible > 0 : true;
  });
}

/* ------------------------------------------------------------------ */
/* Wiki 站（§6：一个帖子一个 wiki）                                    */
/* ------------------------------------------------------------------ */

/**
 * 左栏：站名 + 站内搜索 + 页面树。
 *
 * 树是**服务端铺好的一根线**（`wiki.pages`，前序遍历 + `depth`），前端只画缩进 ——
 * 谁是谁的子页是数据，不是样式，前端再算一遍就会有两份真相。
 */
function stationTreeHtml(wiki) {
  const station = wiki?.station ?? {};
  const pages = wiki?.pages ?? [];
  const current = Number(wiki?.current) || 0;
  const items = pages
    .map((page) => {
      const depth = Math.min(Math.max(Number(page.depth) || 0, 0), 6);
      const icon = page.icon ? `<span class="doc-wiki-tree-icon">${esc(page.icon)}</span>` : '';
      return `<a class="doc-wiki-nav-link doc-wiki-tree-link${page.id === current ? ' is-current' : ''}"`
        + ` data-depth="${depth}" data-wiki-title="${esc(page.title)}" data-wiki-page="${page.id}"`
        + ` href="#/wiki/${encodeURIComponent(station.title ?? '')}/${encodeURIComponent(page.title)}">${icon}${esc(page.title)}</a>`;
    })
    .join('');
  const tools = [];
  if (station.canEdit) {
    tools.push(
      `<input class="doc-input" type="text" data-wiki-new-name placeholder="新页面标题" aria-label="新页面标题">`,
      `<button class="btn btn-sm" type="button" data-doc-action="wiki-new">＋ 新建页面</button>`,
    );
  }
  return `<aside class="doc-wiki-nav doc-wiki-side">
    <div class="doc-wiki-nav-head"><a href="#/wiki" class="doc-wiki-nav-back">⧉ Wiki 站</a><span class="hint">${pages.length} 页</span></div>
    <div class="doc-wiki-station-name">${esc(station.title ?? '')}</div>
    <input class="doc-input doc-wiki-search" type="search" data-wiki-search placeholder="站内搜索…" aria-label="站内搜索">
    <div class="doc-wiki-tree" data-wiki-tree>${
      items || '<div class="doc-wiki-nav-empty">这个站还没有页。</div>'
    }</div>
    <div class="doc-wiki-nav-hidden" data-wiki-nothing hidden>没有匹配的页面。</div>
    ${tools.length ? `<div class="doc-wiki-nav-tools">${tools.join('')}</div>` : ''}
  </aside>`;
}

/** 右栏：目录（标题块）。锚点用稳定块 id（`h-<blockId>`），服务端算好给的。 */
function stationTocHtml(toc) {
  const list = Array.isArray(toc) ? toc : [];
  if (list.length === 0) return '';
  const links = list
    .map((item) => {
      const level = Math.min(Math.max(Number(item.level) || 1, 1), 6);
      return `<a class="doc-wiki-toc-link" data-toc-anchor="h-${esc(item.blockId)}" data-level="${level}" href="#">${esc(item.text)}</a>`;
    })
    .join('');
  return `<aside class="doc-wiki-toc"><div class="doc-wiki-toc-head">本页目录</div>${links}</aside>`;
}

/** 底部「上一页 / 下一页」：树中线上的邻居，边界就整块不画。 */
function stationPagerHtml(wiki) {
  const prev = wiki?.prev;
  const next = wiki?.next;
  if (!prev && !next) return '';
  const station = wiki?.station ?? {};
  const link = (page, dir) => (page
    ? `<a class="doc-wiki-pager-link ${dir === 'prev' ? 'doc-wiki-pager-prev' : 'doc-wiki-pager-next'}" href="#/wiki/${encodeURIComponent(station.title ?? '')}/${encodeURIComponent(page.title)}">
        <span class="doc-wiki-pager-label">${dir === 'prev' ? '← 上一页' : '下一页 →'}</span>
        <span class="doc-wiki-pager-title">${esc(page.icon ? `${page.icon} ` : '')}${esc(page.title)}</span>
      </a>`
    : '<span class="doc-wiki-pager-hole"></span>');
  return `<nav class="doc-wiki-pager">${link(prev, 'prev')}${link(next, 'next')}</nav>`;
}

/** 三栏外壳：左树 / 中正文 / 右目录，正文底下接上一页下一页。 */
function stationShellHtml(inner, wiki, toc) {
  return `<div class="doc-wiki-layout doc-wiki-station">
    ${stationTreeHtml(wiki)}
    <div class="doc-wiki-main">${inner}${stationPagerHtml(wiki)}</div>
    ${stationTocHtml(toc)}
  </div>`;
}

/**
 * 站里的交互：站内搜索、目录跳转、滚动高亮。
 *
 * 搜索**真的走服务端**（`/api/docs/wiki/station/:id/search`，标题 + 原文两个 LIKE）：
 * 只在已经拿到的那棵树里过滤，翻不到正文里的字，那就不叫站内搜索。
 */
function mountStationTools(wiki) {
  const stationId = Number(wiki?.station?.id) || 0;
  docState.stationId = stationId;
  const tree = $('[data-wiki-tree]');
  const original = tree ? tree.innerHTML : '';
  // 目录：点一下滚到那个标题。**不能**用 `href="#h-b3"` —— hash 是路由，
  // 改 hash 会触发一次路由跳转（`#h-b3` 会被当成一个页面名）。
  const tocLinks = typeof ui.app.querySelectorAll === 'function' ? ui.app.querySelectorAll('[data-toc-anchor]') : [];
  for (const link of tocLinks) {
    if (typeof link.addEventListener !== 'function') continue;
    link.addEventListener('click', (event) => {
      event.preventDefault();
      const target = document.getElementById?.(link.dataset?.tocAnchor ?? '');
      target?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    });
  }
  const search = $('[data-wiki-search]');
  if (!search || typeof search.addEventListener !== 'function' || !tree) return;
  let timer = null;
  let alive = true;
  search.addEventListener('input', () => {
    const q = String(search.value ?? '').trim();
    if (timer) clearTimeout(timer);
    if (q === '') {
      tree.innerHTML = original;
      return;
    }
    timer = setTimeout(async () => {
      try {
        const found = await api(`/api/docs/wiki/station/${stationId}/search?q=${encodeURIComponent(q)}`);
        if (!alive) return;
        const results = found?.results ?? [];
        tree.innerHTML = results.length
          ? results
            .map((item) => `<a class="doc-wiki-nav-link doc-wiki-search-hit" data-wiki-page="${item.id}" href="#/doc/${item.id}">
                <span class="doc-wiki-search-title">${esc(item.title)}</span>
                <span class="doc-wiki-search-excerpt">${esc(item.excerpt ?? '')}</span>
              </a>`)
            .join('')
          : '<div class="doc-wiki-nav-empty">没有搜到。</div>';
      } catch (error) {
        console.warn('[doc] 站内搜索失败：', error);
      }
    }, 220);
  });
}

/** `#/wiki`：所有看得见的站。 */
async function viewWikiIndex() {
  leaveDocPage();
  await loadMeta();
  docState.viewing = null;
  docState.editor = null;
  const data = await api('/api/docs/wiki/stations');
  const stations = data?.stations ?? [];
  const cards = stations
    .map(
      (station) => `<a class="card doc-station-card" href="#/wiki/${encodeURIComponent(station.title)}">
        <div class="doc-station-title">⧉ ${esc(station.title)}</div>
        <div class="doc-station-meta">${esc(station.username || '—')} · ${Number(station.pages) || 0} 页</div>
      </a>`,
    )
    .join('');
  ui.app.innerHTML = `<div class="card doc-panel">
    <div class="card-head"><span class="card-title">⧉ Wiki 站</span><span class="hint">一个帖子一个 wiki</span></div>
    <div class="doc-station-list">${cards || '<div class="doc-hint">还没有 wiki 站。</div>'}</div>
    <div class="doc-station-new">
      ${
        state.me
          ? `<input class="doc-wiki-search" data-wiki-station-name maxlength="80" placeholder="新站的名字，例如「算法笔记」">
      <button class="btn" data-doc-action="wiki-new-station" type="button">＋ 新建一个 wiki</button>`
          : '<a class="btn btn-sm" href="#/login">登录后可以建站</a>'
      }
    </div>
    <div class="doc-hint">站里的页是独立文档，用 <code>[[双链]]</code> 互相链；站本身就是一个普通帖子。</div>
  </div>`;
}

/** `#/wiki` 上那个「＋ 新建一个 wiki」：建完直接开站（站首页就是你说的那篇帖子）。 */
async function newStationFromInput() {
  const input = $('[data-wiki-station-name]');
  const title = (input?.value ?? '').trim() || 'Wiki';
  const created = await api('/api/docs/wiki/stations', { method: 'POST', body: { title, scope: 'public' } });
  const row = created?.doc ?? {};
  toast('站建好了，往里加页就行');
  return navigate(`/wiki/${encodeURIComponent(row.title ?? title)}`);
}



/* ------------------------------------------------------------------ */
/* 投票                                                                */
/* ------------------------------------------------------------------ */

/**
 * 票数**不在正文 HTML 里**（服务端渲染时它还不知道谁投了什么），
 * 所以阅读页渲染完之后再补一次 `GET /api/docs/:id/polls` 把数字填进去。
 *
 * 选项结构仍然全是后端画的（见 `blocks/types.js` 的 poll.toHtml），
 * 这里只改数字、宽度、勾选状态，不动结构。
 */
function pollFootText(bucket, mine, multiple) {
  const total = Number(bucket?.total) || 0;
  const voters = Number(bucket?.voters) || 0;
  if (mine.length === 0) return total === 0 ? '还没有人投票，点一个试试' : `${total} 票 · ${voters} 人参与`;
  const own = mine.map((id) => id).join('、');
  return `你投了 ${own}${multiple ? '（可多选，改完再点一次提交）' : ''} · 共 ${total} 票 · ${voters} 人参与`;
}

function paintPollCard(card, bucket) {
  const blockId = card?.dataset?.blockId ?? '';
  const list = card.querySelector?.('.doc-poll-options');
  const mine = Array.isArray(bucket?.mine) ? bucket.mine : [];
  const mineSet = new Set(mine);
  const counts = bucket?.counts ?? {};
  const total = Number(bucket?.total) || 0;
  if (card.dataset) card.dataset.pollMultiple = bucket?.multiple ? '1' : '';
  for (const item of list?.children ?? []) {
    const optionId = item.dataset?.optionId ?? '';
    const count = Number(counts[optionId]) || 0;
    const button = item.querySelector?.('.doc-poll-choice');
    if (!button) continue;
    if (typeof button.setAttribute === 'function') {
      button.setAttribute('aria-checked', mineSet.has(optionId) ? 'true' : 'false');
    }
    if (button.classList?.toggle) button.classList.toggle('is-mine', mineSet.has(optionId));
    const mark = item.querySelector?.('.doc-poll-mark');
    if (mark) mark.innerHTML = mineSet.has(optionId) ? '✔' : '';
    // 条宽与百分数**同一份数**算出来：YouTube 那种「一条胶囊按得票率填满 + 右边百分数」。
    const percent = total > 0 ? Math.round((count / total) * 100) : 0;
    const percentNode = item.querySelector?.('.doc-poll-percent');
    if (percentNode) percentNode.innerHTML = `${percent}%`;
    const bar = item.querySelector?.('.doc-poll-bar');
    if (bar) bar.style = `width:${percent}%`;
    if (button.dataset) button.dataset.pollMine = mineSet.has(optionId) ? '1' : '';
  }
  // 角上那块「你投了哪几个」的提示也归这个桶管，免得数字与勾选各说各话。
  if (card.dataset) card.dataset.pollMine = mine.join(' ');
  const foot = card.querySelector?.('[data-poll-foot]');
  if (foot) {
    foot.classList?.remove?.('is-error');
    foot.innerHTML = esc(pollFootText(bucket, mine));
    if (foot.dataset) foot.dataset.pollBlock = blockId;
  }
}

function pollCardNodes() {
  if (typeof ui.app.querySelectorAll !== 'function') return [];
  return [...ui.app.querySelectorAll('[data-block-type="poll"]')];
}

async function loadPolls(documentId) {
  const cards = pollCardNodes();
  if (!documentId || cards.length === 0) return;
  try {
    const data = await api(`/api/docs/${documentId}/polls`);
    const polls = data?.polls ?? {};
    for (const card of cards) paintPollCard(card, polls[card.dataset?.blockId ?? ''] ?? null);
  } catch (error) {
    for (const card of cards) {
      const foot = card.querySelector?.('[data-poll-foot]');
      if (!foot) continue;
      foot.classList?.add?.('is-error');
      foot.innerHTML = `票数没读出来：${esc(error.message)}`;
    }
  }
}

/** 点一下选项 → 提交**完整**的选择集合（后端把「提交」当改票，不是累加）。 */
async function votePoll(node) {
  const documentId = docState.viewing;
  const blockId = node?.dataset?.blockId ?? '';
  const optionId = node?.dataset?.optionId ?? '';
  if (!documentId || !blockId || !optionId) return;
  if (!state.me) {
    toast('投票前请先登录', 'error');
    return;
  }
  let card = null;
  for (const item of pollCardNodes()) {
    if ((item.dataset?.blockId ?? '') === blockId) card = item;
  }
  if (!card) return;
  const multiple = card.dataset?.pollMultiple === '1';
  const chosen = new Set();
  for (const option of card.querySelector?.('.doc-poll-options')?.children ?? []) {
    const button = option.querySelector?.('.doc-poll-choice');
    if (button?.dataset?.pollMine) chosen.add(option.dataset?.optionId ?? '');
  }
  if (chosen.has(optionId)) {
    chosen.delete(optionId); // 再点一次 = 撤掉这一票
  } else if (multiple) {
    chosen.add(optionId);
  } else {
    chosen.clear(); // 单选：换一个就是换掉原来那个，不能两个一起交
    chosen.add(optionId);
  }
  const data = await api(`/api/docs/${documentId}/blocks/${blockId}/vote`, {
    method: 'POST',
    body: { options: [...chosen] },
  });
  for (const item of pollCardNodes()) {
    if ((item.dataset?.blockId ?? '') === blockId) paintPollCard(item, data);
  }
}

function renderDoc(data) {
  const doc = data.doc ?? {};
  const author = doc.author ?? {};
  const abilities = data.abilities ?? {};
  const warnings = data.warnings ?? [];
  // 脚本写完派生块之后要重画正文，靠这个指纹判断「真的改出东西了没有」——
  // 没变就不重画，免得 iframe 里的脚本被反复重建（脚本重跑又会写一次）。
  lastRenderedHtml = String(data.html ?? '');
  lastRenderedId = doc.id ?? null;
  const article = `
    <article class="doc-page">
      <header class="card doc-header">
        <div class="doc-badges">
          <span class="doc-badge doc-badge-kind">${esc(doc.kindLabel ?? '')}</span>
          <span class="doc-badge doc-badge-scope">${esc(doc.scopeLabel ?? '')}</span>
          ${doc.edited ? '<span class="doc-badge">已编辑</span>' : ''}
        </div>
        ${tagChipsHtml(doc.tags) ? `<div class="doc-tags">${tagChipsHtml(doc.tags)}</div>` : ''}
        <h1 class="doc-title">${esc(doc.title || '（无标题）')}</h1>
        <div class="doc-byline">
          <a href="#/u/${encodeURIComponent(author.username ?? '')}">${esc(author.displayName ?? author.username ?? '匿名')}</a>
          · 更新于 ${esc(Fmt.timeAgo(doc.updatedAt))}
          ${doc.template ? ` · 套过模板 ${esc(doc.template)}` : ''}
        </div>
        <div class="doc-actions">${docActionsHtml(doc, abilities)}</div>
      </header>
      ${warnings.length ? warningsHtml(warnings) : ''}
      <div class="doc-body">${data.html ?? ''}</div>
      ${interactHtml(doc, abilities)}
      <div class="card doc-revisions" data-doc-revisions hidden></div>
    </article>`;
  // wiki 页多一条分类边栏。用后端给的 `nav` 判断，不在前端猜「这算不算 wiki」。
  if (data.wiki) {
    // 站里的页：三栏（左树 / 中正文 / 右目录）。整站页面让开论坛侧栏换取宽度。
    document.body.classList.add('doc-wide');
    ui.app.innerHTML = stationShellHtml(article, data.wiki, data.toc);
  } else if (data.nav) {
    ui.app.innerHTML = `<div class="doc-wiki-layout">${wikiNavHtml(data.nav, doc)}<div class="doc-wiki-main">${article}</div></div>`;
  } else {
    ui.app.innerHTML = article;
  }
  ensureDelegate();
  mountSandboxes(data);
  if (data.wiki) mountStationTools(data.wiki);
  else if (data.nav) mountWikiNav();
  loadPolls(doc.id).catch((error) => console.warn('[doc] 票数加载失败：', error));
  mountInteraction(doc).catch((error) => console.warn('[doc] 互动条加载失败：', error));
  // 公式渲染必须在 innerHTML 之后 —— renderMathInElement 只处理**已经在 DOM 里**的节点
  // （论坛那边同样如此，见 views/timeline.js 的同名注释）。块里的 `$…$` 才不是一行源码。
  ntRenderMath($('.doc-body'));
}

/** 阅读页：`#/doc/:id`。 */
async function viewDoc(id) {
  leaveDocPage();
  await loadMeta();
  docState.viewing = id;
  docState.editor = null;
  renderDoc(await api(`/api/docs/${id}`));
}

/* ------------------------------------------------------------------ */
/* Wiki 多页面                                                         */
/* ------------------------------------------------------------------ */

/**
 * `#/wiki/<标题>` —— `[[双链]]` 的落点。
 *
 * 有这一页就按阅读页渲染（外加「编辑这一页」）；没有就给出**建这一页**的按钮。
 * 「没有」与「你看不见」在这里是同一句话（后端 `getWikiPage` 对看不见的也回 found:false），
 * 不然一个私有页面的存在就泄漏了。
 */
async function viewWiki(name, query = new URLSearchParams()) {
  leaveDocPage();
  await loadMeta();
  const raw = String(name ?? '').trim();
  // 1) 整串是不是一个**站**的名字？是就开站（`#/wiki/<站>`）。站先判 —— 站名和页名
  //    撞车时以站为准，因为「站」才是这个 wiki 的入口。
  const asStation = await api(`/api/docs/wiki/station?title=${encodeURIComponent(raw)}`);
  if (asStation?.found) {
    if (asStation.doc) return renderDoc(asStation.doc);
    return renderMissingWikiPage(raw, asStation);
  }
  // 2) `#/wiki/<站>/<页>`：按**第一个** `/` 切一刀再试。只切一刀是因为页名里
  //    本来就可能有 `/`（`[[某某/某某]]`），切多了就会去开一个不存在的页。
  const slash = raw.indexOf('/');
  if (slash > 0) {
    const stationTitle = raw.slice(0, slash).trim();
    const pageTitle = raw.slice(slash + 1).trim();
    const hit = await api(`/api/docs/wiki/station?title=${encodeURIComponent(stationTitle)}&page=${encodeURIComponent(pageTitle)}`);
    if (hit?.found) {
      if (hit.doc) return renderDoc(hit.doc);
      return renderMissingWikiPage(pageTitle, hit);
    }
  }
  // 3) 老语义：按页名找（`[[双链]]` 的落点）。页已经被收编进站的话，它的
  //    `present()` 里自带 `wiki`，到这儿照样是三栏。
  const found = await api(`/api/docs/wiki/${encodeURIComponent(raw)}`);
  if (found?.found && found.doc) {
    docState.viewing = found.doc.id;
    docState.editor = null;
    renderDoc(found);
    return;
  }
  docState.viewing = null;
  docState.editor = null;
  renderMissingWikiPage(raw, null, found?.nav);
  if (query.get('create') === '1' && state.me) {
    // 从双链点进来的「建这一页」就一步到位：直接落进编辑器，不用再点一次。
    await openWikiPage(raw);
  }
}

/**
 * 「这一页还不存在」。
 *
 * 站里有这棵树就照给（wiki 的意义就是「从目录里换个地方继续看」，停在一页空白上就没法走了）；
 * 没有站信息（老的双链落点）就退回老的分类边栏 `nav`。
 */
function renderMissingWikiPage(title, station = null, nav = null) {
  const body = `<div class="card doc-panel">
      <div class="card-head"><span class="card-title">⧉ ${esc(title || '（空标题）')}</span><span class="hint">Wiki 页面</span></div>
      <div class="doc-hint">这一页还不存在。${state.me ? `建好之后它就是一页空白的 wiki，别的页面用 [[${esc(title)}]] 就能链过来。` : '登录之后可以把它建出来。'}</div>
      <div class="doc-actions">
        ${state.me ? `<button class="btn btn-sm btn-primary" type="button" data-doc-action="wiki-open" data-wiki-name="${esc(title)}">建这一页</button>` : '<a class="btn btn-sm" href="#/login">去登录</a>'}
        <a class="btn btn-sm" href="#/docs">回积木帖</a>
      </div>
    </div>`;
  if (station) {
    document.body.classList.add('doc-wide');
    ui.app.innerHTML = stationShellHtml(body, { ...station, current: 0, prev: null, next: null }, []);
  } else {
    ui.app.innerHTML = `<div class="doc-wiki-layout">${wikiNavHtml(nav, null)}<div class="doc-wiki-main">${body}</div></div>`;
  }
  ensureDelegate();
  if (station) mountStationTools(station);
  else mountWikiNav();
}

/** 建（或打开）一页 wiki 然后进编辑器 —— 已经有了就只是打开。 */
async function openWikiPage(name) {
  const title = String(name ?? '').trim();
  if (!title) return;
  const page = await api(`/api/docs/wiki/${encodeURIComponent(title)}`, { method: 'POST', body: { scope: 'public' } });
  toast(page.created ? '这一页建好了，开始写吧' : '这一页已经有了，直接打开');
  return navigate(`/doc/${page.doc.id}/edit`);
}

/** 在指定站里建页（`＋ 新建页面` 走这条）—— 建完自动挂在站的目录上，然后进编辑器。 */
async function createStationPageIn(stationId, title) {
  const page = await api(`/api/docs/wiki/station/${stationId}/pages`, { method: 'POST', body: { title } });
  toast(page.created ? '这一页建好了，开始写吧' : '这一页已经有了，直接打开');
  return navigate(`/doc/${page.doc.id}/edit`);
}

/* ------------------------------------------------------------------ */
/* 编辑器                                                              */
/* ------------------------------------------------------------------ */

function blockCardHtml(block, index, blocks) {
  const def = typeDef(block.type);
  const prev = blocks[index - 1]?.blockId ?? null;
  const next = blocks[index + 1]?.blockId ?? null;
  const id = esc(block.blockId);
  const fields = def
    ? Blocks.formHtml(def, block.props, `doc-${block.blockId}`)
    : `<div class="doc-hint">这种块类型（${esc(block.type)}）现在不在注册表里，填什么都不会被渲染。</div>`;
  return `<div class="doc-block-card" data-doc-card="${id}">
    <div class="doc-block-head">
      <span class="doc-block-title">${esc(def?.icon ?? '▢')} ${esc(Blocks.summarize(block, def))} <code class="doc-code">${id}</code></span>
      <span class="doc-actions">
        <button class="btn btn-sm btn-ghost" type="button" data-doc-action="up" data-block-id="${id}"${prev ? '' : ' disabled'}>↑</button>
        <button class="btn btn-sm btn-ghost" type="button" data-doc-action="down" data-block-id="${id}"${next ? '' : ' disabled'}>↓</button>
        <button class="btn btn-sm btn-ghost" type="button" data-doc-action="block-delete" data-block-id="${id}">删除</button>
        <button class="btn btn-sm btn-primary" type="button" data-doc-action="block-save" data-block-id="${id}">保存本块</button>
      </span>
    </div>
    ${fields}
    ${Blocks.sourceHtml(block)}
    <div class="doc-actions doc-block-foot">
      <button class="btn btn-sm btn-primary" type="button" data-doc-action="block-save" data-block-id="${id}">保存本块</button>
      <span class="doc-hint">字段填完点这里 —— 表单一长，右上角那个按钮就滚出屏幕了，所以底下再放一个。</span>
    </div>
  </div>`;
}

function blocksEditorHtml(blocks) {
  const cards = blocks.map((block, index) => blockCardHtml(block, index, blocks)).join('');
  return `<div class="card doc-panel doc-howto">
      <div class="card-head"><span class="card-title">🧱 积木模式：四步</span><span class="hint">这张卡是说明书，不参与正文</span></div>
      <ol class="doc-steps">
        <li><span class="doc-step-no">1</span>写正文：最下面「➕ 插入一块」选一种类型 —— 新块加在<strong>末尾</strong>，再用块头的 ↑ ↓ 挪到想要的位置，然后在块里填字段。</li>
        <li><span class="doc-step-no">2</span>改标题和「谁可以看」：就在这张卡上面的两个输入框里改。</li>
        <li><span class="doc-step-no">3</span>点这张卡里的<strong>「保存」</strong>：标题、可见范围和这一页上所有改过的块<strong>一起存</strong>就完了。</li>
        <li><span class="doc-step-no">4</span>只想存一块（比如表单一长、别的块还要接着改），每块自己的<strong>「保存本块」</strong>也在；要直接改数据就展开块里的「源码」。</li>
      </ol>
    </div>
    <div class="doc-editor">
      ${
        cards ||
        `<div class="card">${emptyHtml('🧱', '这篇还没有块', '从下面的「插入一块」开始，或者切到 Markdown 模式贴一篇进来')}</div>`
      }
    </div>
    <div class="card doc-panel">
      <div class="card-head"><span class="card-title">➕ 插入一块</span><span class="hint">加在末尾，插好再往上挪</span></div>
      <div class="doc-actions">
        <select class="doc-input doc-select" data-doc-insert-type>
          ${docState.types.map((type) => `<option value="${esc(type.name)}">${esc(type.icon ?? '')} ${esc(type.label ?? type.name)}</option>`).join('')}
        </select>
        <button class="btn btn-sm btn-primary" type="button" data-doc-action="insert">加一块</button>
        <a class="btn btn-sm btn-ghost" href="#/dev">想自己编一种块？看开发者功能</a>
      </div>
    </div>`;
}

/**
 * 源码模式 —— 这一轮的主编辑面（§5.1）。
 *
 * 一整篇就是一段文本：正文是 Markdown，积木是 ` ```doc:类型 ` 的围栏，
 * 脚本块是 ` ```doc:script ` 后面直接跟 JS 原文。右边是**真的渲染**：
 * 走 `POST /api/docs/:id/preview`，解析 + `renderBlocks`，不落库，
 * 所以 `app` / `script` 块的 iframe 在里面真的会跑起来。
 *
 * 为什么不做 CodeMirror：仓库的规矩是「零依赖、无构建」，而沙箱化的环境里
 * 没有网络、拉不到 vendor。一个 `textarea` + 服务端预览已经能写脚本、能看结果。
 */
function sourceEditorHtml(source) {
  // `name="content"` 与 Markdown 模式同款：AI 抽屉的 textarea 适配器按它找人。
  return `<div class="card doc-panel">
    <div class="card-head">
      <span class="card-title">⚡ 源码模式</span>
      <span class="hint">整篇就是这段文本；右边实时预览，脚本会真的跑起来</span>
    </div>
    <div class="doc-md-grid">
      <div class="doc-md-edit" data-doc-editor-host>
        <textarea class="doc-input doc-textarea doc-md" name="content" data-doc-source rows="26" spellcheck="false">${esc(source ?? '')}</textarea>
      </div>
      <div class="doc-md-side">
        <div class="doc-md-preview" data-doc-preview><div class="md"><div class="hint">右边跟着打字实时更新。</div></div></div>
        <div id="docNotesMount" class="notes-mount"></div>
      </div>
    </div>
    <div class="doc-actions">
      <button class="btn btn-sm btn-ghost" type="button" data-doc-action="src-reload">重新拉取</button>
      <span class="doc-hint" data-doc-src-status>改完点上方的「保存」—— 标题、可见范围和这段源码一起存。</span>
    </div>
    <div class="doc-hint">
      正文直接写 Markdown（标题 / 段落 / 列表 / 表格 / 代码围栏 / $$公式$$ / 图片 / [[双链]]）；
      积木写成一段 \`\`\`doc:poll 这样的围栏，块体是它的属性 JSON；
      \`\`\`doc:script 的块体是**原始 JS**（不是 JSON）。
      块 id（\`{#b3}\`）是票、脚本产出、块间联动认的锚，保存时会自动带上，不用手写。
    </div>
  </div>`;
}

/** 源码模式的挂载：Tab 缩进 + 实时预览 + AI 抽屉（与 Markdown 模式共用同一份面板）。 */
function mountSourceTools() {
  const editor = docState.editor;
  const textarea = $('[data-doc-source]');
  if (!editor || !textarea) return;
  const box = $('[data-doc-preview] .md');
  const status = $('[data-doc-src-status]');

  const paint = () => {
    if (paint.timer) clearTimeout(paint.timer);
    paint.timer = setTimeout(async () => {
      paint.timer = 0;
      const text = textarea.value ?? '';
      if (!box) return;
      if (text.trim() === '') {
        box.innerHTML = '<div class="hint">右边跟着打字实时更新。</div>';
        return;
      }
      try {
        const data = await api(`/api/docs/${editor.id}/preview`, {
          method: 'POST',
          body: { markdown: text },
        });
        // 旧 iframe 会被 innerHTML 丢掉，但它们的看门狗还挂在 registry 里 —— 先清。
        unmountSandboxes();
        box.innerHTML = data.html || '<div class="hint">（这段源码没有渲染出内容）</div>';
        ntRenderMath(box);
        // 预览里的沙箱**不接** onDerivedChange：脚本写派生层时重画 ui.app 会把编辑器整个冲掉。
        mountSandboxes({ blocks: data.blocks, doc: { id: data.documentId } }, box, null);
        if (status) {
          status.textContent = (data.warnings ?? []).map((item) => item.message).join('；');
        }
      } catch (error) {
        if (status) status.textContent = `预览失败：${error.message}`;
      }
    }, 400);
  };

  textarea.addEventListener('input', paint);
  // Tab 键插两个空格 —— 源码里要写脚本，没有缩进等于没法写。
  textarea.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    event.preventDefault();
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? 0;
    if (typeof textarea.setRangeText === 'function') textarea.setRangeText('  ', start, end, 'end');
    else textarea.value = `${textarea.value.slice(0, start)}  ${textarea.value.slice(end)}`;
    paint();
  });

  paint();
  mountNotesPanel(document.getElementById('docNotesMount'), $('[data-doc-editor-host]'), status);
}

/**
 * 把「这段文本就是这篇的正文」交给服务端。
 *
 * 两个文本视图（纯 Markdown / 源码）共用同一条路：服务端解析、按 id 对齐、写回
 * `source_text`，再把对齐之后的 `source` 与 `blocks` 还回来 —— 客户端**绝不**自己推定
 * 「存完应该长什么样」，对齐是服务端才做得了的事（LCS + id 归属）。
 */
async function putDraft(text, force = false) {
  const editor = docState.editor;
  const data = await api(`/api/docs/${editor.id}/markdown${force ? '?confirm=1' : ''}`, {
    method: 'PUT',
    body: { markdown: text },
  });
  editor.data = data;
  return data;
}

/**
 * 跑一次「写正文」的动作，撞上服务端那道「块数暴跌」的 409 就问一次、再带 `?confirm=1` 重来。
 * 返回 `null` 表示作者点了取消 —— 调用方必须原地不动，不能把界面切走。
 */
async function withShrinkConfirm(task) {
  try {
    return await task(false);
  } catch (error) {
    if (Number(error?.status) !== 409) throw error;
    if (!window.confirm(`${error.message}（点确定就照这样存）`)) return null;
    return task(true);
  }
}

/** 当前视图里那段没保存的文本，连同它的「脏基线」；积木视图没有文本框，回 null。 */
function currentDraft() {
  const editor = docState.editor;
  if (!editor) return null;
  const el = editor.mode === 'source' ? $('[data-doc-source]') : editor.mode === 'markdown' ? $('[data-doc-markdown]') : null;
  if (!el) return null;
  const baseline = editor.mode === 'source' ? (editor.data?.source ?? '') : (editor.markdown ?? '');
  return { el, text: el.value ?? '', baseline };
}

/**
 * 切视图之前把改动存下去。
 *
 * 为什么切视图一定要存：三个视图是**同一篇帖子的三种看法**，而块与 id 的真相在服务端
 * （Markdown 视图里根本没有 id，源码视图里有）。「在 Markdown 里写一半就切过去拼积木」
 * 只有两条路 —— 让服务端把这段文本解析成块，或者在客户端再养一份解析器。后者是第二份
 * 真相，迟早对不上；所以选前者。
 *
 * 存的时机只在**真的改了**（`text !== baseline`）才算数：来回点页签不该平白多出修订。
 */
async function flushDraft() {
  const draft = currentDraft();
  if (!draft || draft.text === draft.baseline) return true;
  const data = await withShrinkConfirm((force) => putDraft(draft.text, force));
  if (!data) return false;
  if (docState.editor.mode === 'markdown') docState.editor.markdown = draft.text;
  toast('切换前先把改动存下了');
  return true;
}

/** 重新拉一次源码（放弃本地改动）。 */
async function reloadSource() {
  const editor = docState.editor;
  const data = await api(`/api/docs/${editor.id}`);
  absorb(data);
  toast('拿回服务端的版本了');
}

/**
 * 纯 Markdown 视图能**如实**表达的块：正文类的这些。
 *
 * 判据只认块类型，不认「Markdown 里能不能打出来」—— 因为出问题的不是打字，
 * 是**看见的和你改的不是一回事**：`poll` / `app` / `script` / 自定义块在纯 Markdown 里
 * 只能退化成一坨围栏 JSON（` ```doc:poll `），作者在其中改错一个字符就毁了整块。
 */
const MARKDOWN_VIEW_TYPES = new Set(['heading', 'paragraph', 'list', 'quote', 'code', 'table', 'formula', 'image', 'wiki']);

/** 这篇能不能用纯 Markdown 编辑？不能就回一句「为什么」（能就回空串）。 */
function markdownViewBlocked(blocks) {
  const exotic = (blocks ?? []).filter((block) => !MARKDOWN_VIEW_TYPES.has(String(block?.type ?? '')));
  if (exotic.length === 0) return '';
  const names = [...new Set(exotic.map((block) => String(block.type)))].join(' / ');
  return `这篇里有 Markdown 表达不了的积木（${names}），所以这一页只读 —— 点上面的「⚡ 源码模式」改。`;
}

function markdownEditorHtml(markdown, blocked = '') {
  // `name="content"` 不是装饰：`NotesAgent.createTextareaAdapter()` 就是按 `#content`
  // 或 `[name="content"]` 找编辑区的，改了它 AI 抽屉就挂不上去。
  const ro = blocked ? ' readonly' : '';
  return `<div class="card doc-panel">
    <div class="card-head"><span class="card-title">📝 纯 Markdown</span><span class="hint">右边跟着打字实时更新；保存会把整篇的块换成这份 Markdown 解析出来的块</span></div>
    ${blocked ? `<div class="doc-hint doc-md-blocked">⚠ ${esc(blocked)}</div>` : ''}
    <div class="doc-md-grid">
      <div class="doc-md-edit" id="docMdHost" data-doc-editor-host>
        <textarea class="doc-input doc-textarea doc-md" name="content" data-doc-markdown rows="18" spellcheck="false"${ro}>${esc(markdown ?? '')}</textarea>
      </div>
      <div class="doc-md-side">
        <div class="doc-md-preview" data-doc-preview><div class="md"><span class="hint">开始打字就有预览。</span></div></div>
        <div id="docNotesMount"></div>
      </div>
    </div>
    <div class="doc-actions">
      <button class="btn btn-sm btn-ghost" type="button" data-doc-action="md-reload">重新拉取</button>
      <span class="doc-hint" data-doc-md-status>改完点上方的「保存」—— 标题、可见范围和这段正文一起存。</span>
    </div>
    <div class="doc-hint">支持标题 / 段落 / 列表 / 代码围栏 / 表格 / $$公式$$ / 图片 / 引用 / [[双链]]；结构化块（\`\`\`doc:poll 这种）在这里只读，请去源码模式改。</div>
  </div>`;
}

/**
 * Markdown 模式的两件外挂：实时预览 + 现有的 AI 抽屉。
 *
 * 预览复用站点既有的 `POST /api/markdown/preview`（compose 的「预览」按钮走的就是
 * 它，LaTeX 也在这一层渲染），只是这里改成**防抖自动跑**，不需要点按钮。
 * AI 抽屉复用 `/notes-panel.js` 的 `window.NotesAgent.attach`（与 compose 同一份），
 * 所以「AI 改文本」的能力是白捡的，没有第二份实现。
 *
 * 两个都**只做锦上添花**：拿不到就把原因写在状态里，绝不让编辑器本身挂掉。
 */
function mountMarkdownTools(blocked = '') {
  const textarea = $('[data-doc-markdown]');
  const box = $('[data-doc-preview] .md');
  const status = $('[data-doc-md-status]');

  if (textarea && box) {
    const paint = async () => {
      const text = textarea.value ?? '';
      if (text.trim() === '') {
        box.innerHTML = '<span class="hint">开始打字就有预览。</span>';
        return;
      }
      try {
        const { html } = await api('/api/markdown/preview', { method: 'POST', body: { content: text } });
        box.innerHTML = html || '<span class="hint">（空内容）</span>';
        // LaTeX 走的是站点原本那一套（离线 KaTeX，见 views/notes.js）。
        // 服务端只吐 `$…$` 原文，公式得在 innerHTML 之后才排得出来。
        ntRenderMath(box);
      } catch (error) {
        box.innerHTML = `<span class="hint">预览渲染失败：${esc(error.message)}</span>`;
      }
    };
    if (typeof textarea.addEventListener === 'function') {
      textarea.addEventListener('input', () => {
        if (mdPreviewTimer) clearTimeout(mdPreviewTimer);
        mdPreviewTimer = setTimeout(() => {
          mdPreviewTimer = null;
          paint();
        }, 400);
      });
    }
    paint();
  }

  const mount = document.getElementById('docNotesMount');
  const host = document.getElementById('docMdHost');
  // 只读的 Markdown 页**不挂 AI 抽屉**：适配器的 `setDoc` 直接写 `textarea.value`，
  // readonly 拦不住它 —— 挂上去就等于留了一条绕过「这一页改不了」的后门。
  if (blocked) {
    if (status) status.textContent = '这一页只读，AI 抽屉在源码模式里可用';
    return;
  }
  mountNotesPanel(mount, host, status);
}

/**
 * AI 抽屉（`/notes-panel.js` 的 `window.NotesAgent.attach`，与 compose 同一份）。
 *
 * 适配器就是契约里的 `createTextareaAdapter`：它按 `[name="content"]` 找编辑区，
 * 所以源码模式那个 textarea 特意也叫 `content` —— 编辑器换了形态，契约不用换。
 * 挂不上（脚本没加载、假 DOM）就只写一句状态：**绝不让编辑器本身挂掉**。
 */
function mountNotesPanel(mount, host, status) {
  const agent = typeof window === 'undefined' ? null : window.NotesAgent;
  if (!mount || !agent || typeof agent.attach !== 'function' || typeof agent.createTextareaAdapter !== 'function') {
    if (status) status.textContent = mount ? 'AI 抽屉没加载（/notes-panel.js 不在）' : '';
    return null;
  }
  try {
    mdNotesPanel = agent.attach({ mount, editor: agent.createTextareaAdapter(host) });
    return mdNotesPanel;
  } catch (error) {
    console.warn('[notes-agent] 积木编辑器挂载失败：', error);
    mdNotesPanel = null;
    if (status) status.textContent = 'AI 抽屉挂载失败，编辑照常能用';
    return null;
  }
}

/**
 * 模板栏 —— **只在积木模式里出现**。
 *
 * 放在这里是因为套模板的实质是「换一整套块」，只有正对着块列表时这个决定才有意义；
 * 「新建一篇」那条路上已经没有任何模板入口了（见 `newDocAndEdit`）。
 */
function templatePanelHtml() {
  return `<div class="card doc-panel doc-tpl-bar">
    <div class="card-head">
      <span class="card-title">🧩 模板</span>
      <span class="hint">套用会把整篇现有的块换成模板的块（旧的留在修订记录里，随时能滚回来）</span>
    </div>
    <div class="doc-actions">
      <select class="doc-input doc-select" data-doc-template>
        <option value="">选一个模板…</option>
        ${docState.templates.map((item) => `<option value="${esc(item.key)}">${esc(item.title)}</option>`).join('')}
      </select>
      <button class="btn btn-sm" type="button" data-doc-action="apply-template">套用模板（替换全部块）</button>
    </div>
  </div>`;
}

function toolboxHtml(doc) {
  return `<div class="card doc-panel">
    <div class="card-head"><span class="card-title">🧰 工具箱</span></div>
    <div class="doc-actions">
      <button class="btn btn-sm" type="button" data-doc-action="revisions">修订记录</button>
      <button class="btn btn-sm" type="button" data-doc-action="export">导出 JSON</button>
      <button class="btn btn-sm" type="button" data-doc-action="import-toggle">导入 JSON</button>
      ${doc.anchorPostId ? `<a class="btn btn-sm btn-ghost" href="#/post/${esc(doc.anchorPostId)}">互动锚点</a>` : ''}
      <button class="btn btn-sm btn-ghost" type="button" data-doc-action="delete">删除这篇</button>
    </div>
    <form class="doc-new" data-doc-form="import" hidden>
      <textarea class="doc-input doc-textarea" name="payload" rows="6" placeholder="把导出的 JSON 贴进来"></textarea>
      <div class="doc-new-row">
        <select class="doc-input doc-select" name="scope">${scopeOptionsHtml('private')}</select>
        <button class="btn btn-sm btn-primary" type="submit">导入成新的一篇</button>
      </div>
    </form>
  </div>`;
}

function renderEditor() {
  const editor = docState.editor;
  const doc = editor.data.doc ?? {};
  const blocks = editor.data.blocks ?? [];
  const mdBlocked = markdownViewBlocked(blocks);
  ui.app.innerHTML = `
    <div class="card doc-panel">
      <div class="card-head">
        <span class="card-title">✏️ 编辑「${esc(doc.title || '无标题')}」</span>
        <a class="tag" href="#/doc/${esc(doc.id)}">看阅读页</a>
      </div>
      <div class="doc-meta">
        <label class="doc-field"><span class="doc-field-label">标题</span>
          <input class="doc-input" data-doc-title maxlength="120" value="${esc(doc.title ?? '')}">
        </label>
        <label class="doc-field"><span class="doc-field-label">谁可以看</span>
          <select class="doc-input doc-select" data-doc-scope>${scopeOptionsHtml(doc.scope)}</select>
        </label>
        <label class="doc-field doc-field-wide"><span class="doc-field-label">标签</span>
          <input class="doc-input" data-doc-tags maxlength="160" value="${esc((doc.tags ?? []).join(', '))}"
            placeholder="逗号隔开，最多 ${docState.maxTags} 个，例：学术笔记, 公式">
        </label>
        ${
          docState.popularTags.length
            ? `<div class="doc-tag-picks"><span class="doc-hint">大家在用：</span>${docState.popularTags
                .slice(0, 8)
                .map((item) => `<button class="doc-tag doc-tag-pick" type="button" data-doc-tag-pick="${esc(item.tag)}">#${esc(item.tag)}<span class="doc-tag-count">${Fmt.fmtNum(item.count)}</span></button>`)
                .join('')}</div>`
            : ''
        }
        <label class="doc-check-label"><input class="doc-check" type="checkbox" data-doc-script-write${editor.data.settings?.allowScriptWrite ? ' checked' : ''}>
          允许脚本改块（打开后，沙箱里的 <code class="doc-code">Sandbox.render</code> 能往派生层写块）</label>
      </div>
      <div class="doc-actions">
        <button class="btn btn-sm btn-primary" type="button" data-doc-action="save-all">保存</button>
        <span class="doc-hint">标题、可见范围、正文一起存 —— 不用先存一样再存另一样。</span>
      </div>
      <div class="doc-tabs">
        <button class="doc-tab${editor.mode === 'markdown' ? ' doc-tab-on' : ''}" type="button" data-doc-tab="markdown">📝 纯 Markdown${mdBlocked ? ' ⚠' : ''}</button>
        <button class="doc-tab${editor.mode === 'source' ? ' doc-tab-on' : ''}" type="button" data-doc-tab="source">⚡ 源码模式</button>
        <button class="doc-tab${editor.mode === 'blocks' ? ' doc-tab-on' : ''}" type="button" data-doc-tab="blocks">🧱 积木模式</button>
      </div>
    </div>
    ${
      editor.mode === 'source'
        ? sourceEditorHtml(editor.data.source ?? '')
        : editor.mode === 'markdown'
          ? markdownEditorHtml(editor.markdown, mdBlocked)
          : `${blocksEditorHtml(blocks)}${templatePanelHtml()}`
    }
    ${toolboxHtml(doc)}
    <div class="card doc-revisions" data-doc-revisions hidden></div>`;
  ensureDelegate();
  if (editor.mode === 'markdown') mountMarkdownTools(mdBlocked);
  if (editor.mode === 'source') mountSourceTools();
}

/** 保存一次之后统一用后端的新形状重画 —— 永不本地推定服务端状态。 */
function absorb(data) {
  docState.editor.data = data;
  renderEditor();
}

/** 两份 props 是不是一回事（不比键顺序）。判断「这块改过没有」用。 */
function sameProps(a, b) {
  const stable = (value) => {
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
    if (value && typeof value === 'object') {
      return `{${Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
        .join(',')}}`;
    }
    return JSON.stringify(value ?? null);
  };
  return stable(a ?? {}) === stable(b ?? {});
}

/**
 * 积木模式的正文：把**这一页上所有改过的块**一起存。
 *
 * 块仍然是一块一条 PUT（块的语义本来就独立，服务端也是这么存的），但那是实现细节：
 * 作者点「保存」时心里想的是「这一篇我改完了」，不是「b7 那个块我改完了」。
 *
 * 回 `null` = 有个块填得不对（必填没填之类）—— 这时**一块都不存**。宁可什么都不存
 * 让作者改完再点一次，也不要留下「前三块存了、第四块没存」这种谁也说不清的状态。
 */
async function saveDirtyBlocks() {
  const editor = docState.editor;
  const blocks = editor.data.blocks ?? [];
  const queued = [];
  for (const card of document.querySelectorAll('[data-doc-card]')) {
    const blockId = card.dataset?.docCard ?? '';
    const block = blocks.find((item) => item.blockId === blockId);
    if (!block) continue;
    const { props, problems } = Blocks.readForm(card, typeDef(block.type));
    if (problems.length > 0) {
      toast(problems[0], 'error');
      return null;
    }
    if (sameProps(props, block.props)) continue;
    queued.push({ blockId, props });
  }
  let fresh = blocks;
  for (const item of queued) {
    // 顺序发，不并发：块之间有顺序（position），并发写同一条序列对不上。
    const result = await api(`/api/docs/${editor.id}/blocks/${item.blockId}`, {
      method: 'PUT',
      body: { props: item.props },
    });
    fresh = result.blocks ?? fresh;
  }
  editor.data = { ...editor.data, blocks: fresh };
  return queued.length;
}

/**
 * 编辑器唯一的「保存」：标题 + 可见范围 + 正文，一次点完。
 *
 * 为什么必须是一个动作：这三样在作者心里是同一件事（「这篇改好了」）。拆成
 * 「保存标题与范围」+「保存本块」+「保存 Markdown」是照着存储结构设计的界面 ——
 * 作者得先学会服务端怎么分表，才能把文章存对。界面该跟着人走，不是跟着表走。
 *
 * 服务端该是几条请求还是几条（块的语义独立、正文有对齐逻辑），那些都发生在这一层之下。
 */
async function saveAll() {
  const editor = docState.editor;
  if (!editor) return;
  const doc = editor.data.doc ?? {};
  const title = ($('[data-doc-title]')?.value ?? '').trim();
  if (title === '') {
    toast('标题不能为空', 'error');
    return;
  }
  const scope = $('[data-doc-scope]')?.value ?? doc.scope ?? 'public';
  const scriptWrite = Boolean($('[data-doc-script-write]')?.checked);
  const parsedTags = parseTags($('[data-doc-tags]')?.value ?? (doc.tags ?? []).join(', '));
  if (parsedTags.error) {
    toast(parsedTags.error, 'error');
    return;
  }
  const tags = parsedTags.tags;
  const tagsChanged = tags.join('\n') !== (doc.tags ?? []).join('\n');
  const metaChanged = title !== (doc.title ?? '') || scope !== (doc.scope ?? 'public') || tagsChanged;
  const settingsChanged = scriptWrite !== Boolean(editor.data.settings?.allowScriptWrite);
  const draft = currentDraft();

  // 1) 文档级属性。**改了才发** —— 每次都发一遍会平白多出修订记录（修订列表是给人看的）。
  if (metaChanged) {
    editor.data = await api(`/api/docs/${editor.id}`, {
      method: 'PUT',
      body: { title, scope, template: doc.template ?? '', tags },
    });
  }
  if (settingsChanged) {
    editor.data = await api(`/api/docs/${editor.id}/settings`, {
      method: 'PUT',
      body: { allowScriptWrite: scriptWrite },
    });
  }

  // 2) 正文。
  let contentSaved = 0;
  if (editor.mode === 'blocks') {
    const saved = await saveDirtyBlocks();
    if (saved === null) {
      // 有块填错了：已经把话说清楚了，界面原地不动，别把作者敲的东西弄丢。
      renderEditor();
      return;
    }
    contentSaved = saved;
  } else if (draft && draft.text !== draft.baseline) {
    const data = await withShrinkConfirm((force) => putDraft(draft.text, force));
    if (!data) {
      toast('正文没存：你在确认框里点了取消', 'error');
      renderEditor();
      return;
    }
    if (editor.mode === 'markdown') editor.markdown = draft.text;
    contentSaved = 1;
  }

  // 3) 重画（本地推定「存完该长什么样」迟早对不上）。
  //    Markdown 模式**必须重新拉一次**：编辑区画的 `editor.markdown` 是上次拉的文本，
  //    不重拉就等于把作者刚敲的东西从框里抹掉（空文档上尤其明显：直接变空白）；
  //    顺带也把脏基线对齐到服务端真存下来的那份（解析是有损的：表格分隔行、嵌套列表会被改写）。
  if (editor.mode === 'markdown') await loadMarkdown();
  else renderEditor();

  if (!metaChanged && !settingsChanged && !contentSaved) {
    toast('没有改动要存');
    return;
  }
  const bits = [];
  if (metaChanged) {
    const metaBits = [];
    if (title !== (doc.title ?? '')) metaBits.push('标题');
    if (scope !== (doc.scope ?? 'public')) metaBits.push('可见范围');
    if (tagsChanged) metaBits.push('标签');
    bits.push(metaBits.join('、'));
  }
  if (settingsChanged) bits.push(`「允许脚本改块」已${scriptWrite ? '打开' : '关闭'}`);
  if (contentSaved) bits.push(editor.mode === 'blocks' ? `${contentSaved} 个块` : '正文');
  toast(`存好了：${bits.join('、')}`);
}

/**
 * 保存「源码」框里的 props JSON（进阶入口）。
 *
 * 与 `saveBlock` 的区别只有一处：值从源码框来，不从表单来。
 * 坏 JSON **不清空、不静默** —— 报一条人话把用户的输入留在原地。
 */
async function saveBlockSource(blockId) {
  const editor = docState.editor;
  const card = $(`[data-doc-card="${blockId}"]`);
  if (!editor || !card) return;
  const props = Blocks.readSource(card);
  if (props === null) {
    toast('源码不是合法的 JSON 对象（要写成 { "字段": 值 } 这样）', 'error');
    return;
  }
  const result = await api(`/api/docs/${editor.id}/blocks/${blockId}`, { method: 'PUT', body: { props } });
  const fresh = (editor.data.blocks ?? []).map((item) => (item.blockId === blockId ? result.block : item));
  absorb({ ...editor.data, blocks: fresh });
  toast(`${blockId} 的源码存好了`);
}

async function saveBlock(blockId) {  const editor = docState.editor;
  const card = $(`[data-doc-card="${blockId}"]`);
  const block = (editor.data.blocks ?? []).find((item) => item.blockId === blockId);
  if (!card || !block) return;
  const def = typeDef(block.type);
  const { props, problems } = Blocks.readForm(card, def);
  if (problems.length > 0) {
    toast(problems[0], 'error');
    return; // 不静默丢掉用户敲进去的东西，让他自己改
  }
  const result = await api(`/api/docs/${editor.id}/blocks/${blockId}`, { method: 'PUT', body: { props } });
  const fresh = (editor.data.blocks ?? []).map((item) => (item.blockId === blockId ? result.block : item));
  absorb({ ...editor.data, blocks: fresh });
  toast(`${blockId} 保存好了`);
}

async function moveBlock(blockId, direction) {
  const editor = docState.editor;
  const blocks = editor.data.blocks ?? [];
  const index = blocks.findIndex((item) => item.blockId === blockId);
  if (index < 0) return;
  const neighbour = direction === 'up' ? blocks[index - 1] : blocks[index + 1];
  if (!neighbour) return;
  const body = direction === 'up' ? { before: neighbour.blockId } : { after: neighbour.blockId };
  const result = await api(`/api/docs/${editor.id}/blocks/${blockId}/move`, { method: 'POST', body });
  absorb({ ...editor.data, blocks: result.blocks ?? [] });
}

async function insertBlock() {
  const editor = docState.editor;
  const name = $('[data-doc-insert-type]')?.value ?? '';
  const def = typeDef(name);
  if (!def) {
    toast('选一个块类型', 'error');
    return;
  }
  const result = await api(`/api/docs/${editor.id}/blocks`, {
    method: 'POST',
    body: { type: name, props: Blocks.starterProps(def) },
  });
  absorb({ ...editor.data, blocks: result.blocks ?? [] });
  toast('加了一块，填完记得保存本块');
}

async function loadMarkdown() {
  const editor = docState.editor;
  const data = await api(`/api/docs/${editor.id}/markdown`);
  editor.markdown = data.markdown ?? '';
  renderEditor();
}

async function showRevisions() {
  const id = docState.editor ? docState.editor.id : docState.viewing;
  const data = await api(`/api/docs/${id}/revisions`);
  const revisions = data.revisions ?? [];
  const panel = $('[data-doc-revisions]');
  if (!panel) return;
  panel.hidden = false;
  panel.innerHTML = `
    <div class="card-head"><span class="card-title">🕓 修订记录</span><span class="hint">最近 ${revisions.length} 条</span></div>
    <ul class="doc-revision-list">${revisions
      .map(
        (item) => `<li class="doc-revision">
          <span class="doc-revision-head">r${esc(item.revision)} · ${esc(item.reasonLabel)} · ${esc(Fmt.timeAgo(item.createdAt))}${
            item.author ? ` · ${esc(item.author.displayName)}` : ''
          }</span>
          <button class="btn btn-sm btn-ghost" type="button" data-doc-action="rollback" data-revision="${esc(item.revision)}">回滚到这一版</button>
        </li>`,
      )
      .join('')}</ul>
    <div class="doc-hint">回滚本身也会记一条修订，所以滚错了还能再滚回来。</div>`;
  ensureDelegate();
}

async function rollback(revision) {
  const editor = docState.editor;
  if (!editor) return;
  const data = await api(`/api/docs/${editor.id}/rollback`, { method: 'POST', body: { revision } });
  absorb(data);
  toast(`回到 r${revision} 了`);
}

async function exportDoc(id) {
  const payload = await api(`/api/docs/${id}/export`);
  download(`doc-${id}.json`, payload);
}

async function deleteDoc(id) {
  if (!confirm('确定删掉这篇吗？影子帖子会一起软删，点赞收藏的数据不会丢。')) return;
  await api(`/api/docs/${id}`, { method: 'DELETE' });
  toast('删掉了');
  navigate('/docs');
}

/** 编辑器：`#/doc/:id/edit`。 */
async function viewDocEdit(id, query = new URLSearchParams()) {
  leaveDocPage();
  await loadMeta();
  const data = await api(`/api/docs/${id}`);
  if (!data.abilities?.canEdit) {
    toast('只有作者和站务能编辑这篇文档', 'error');
    return navigate(`/doc/${id}`);
  }
  // 默认进**纯 Markdown**：这一轮的主编辑面是「先写字」，积木与脚本是后面才切过去的事。
  const wanted = query.get('mode') ?? 'markdown';
  docState.editor = {
    id,
    data,
    mode: wanted === 'source' || wanted === 'blocks' ? wanted : 'markdown',
    markdown: '',
  };
  if (docState.editor.mode === 'markdown') return loadMarkdown();
  renderEditor();
}

/* ------------------------------------------------------------------ */
/* 开发者功能                                                          */
/* ------------------------------------------------------------------ */

/**
 * 开发者功能：`#/dev`（登记在案的旧地址 `#/blocks` 也进这一页）。
 *
 * 两件事合在一页：
 *   · **块类型表** —— 平台上有哪些块类型、各自的 props 长什么样、怎么注册一种新的；
 *   · **我的脚本模板** —— 把常写的沙箱脚本存下来，下次一键起一篇。
 * 前者是「平台能有哪些块」，后者是「我自己常用哪几段代码」，都是开发时才看的东西，
 * 所以不再各占一个入口。
 */
async function viewDev() {
  leaveDocPage();
  docState.editor = null;
  await loadMeta(true);
  await loadScriptTemplates(true);
  const builtin = docState.types.filter((type) => type.builtin);
  const custom = docState.types.filter((type) => !type.builtin);
  const card = (type, mark) => `<div class="card doc-type-card">
    <div class="card-head">
      <span class="card-title">${esc(type.icon ?? '▢')} ${esc(type.label ?? type.name)}</span>
      <span class="doc-badge">${mark} · v${esc(type.version ?? 1)} · ${esc(type.rendererKind ?? 'declarative')}</span>
    </div>
    <code class="doc-code">${esc(type.name)}</code>
    ${Blocks.schemaHtml(type)}
  </div>`;

  ui.app.innerHTML = `
    <div class="card doc-panel">
      <div class="card-head"><span class="card-title">🧱 块类型表</span><span class="hint">${docState.types.length} 种</span></div>
      <div class="doc-hint">新增一种块类型<strong>不用改核心代码</strong>：填一份 schema 就能在编辑器里出现，也能被文档引用。内置的 ${builtin.length} 种不可覆盖。</div>
      <form class="doc-new" data-doc-form="register">
        <div class="doc-new-row">
          <input class="doc-input" name="name" maxlength="32" placeholder="类型名（小写字母开头，如 timeline）">
          <input class="doc-input" name="label" maxlength="40" placeholder="中文名">
          <input class="doc-input" name="icon" maxlength="8" placeholder="图标">
          <select class="doc-input doc-select" name="rendererKind" data-doc-type-kind>
            <option value="declarative">declarative（只靠 schema 渲染）</option>
            <option value="sandbox">sandbox（在沙箱里跑代码）</option>
          </select>
        </div>
        <label class="doc-field"><span class="doc-field-label">props schema（JSON）</span>
          <textarea class="doc-input doc-textarea" name="propsSchema" data-doc-type-schema rows="5" spellcheck="false">{"text": {"type": "string", "required": true, "label": "内容"}}</textarea>
        </label>
        <label class="doc-field"><span class="doc-field-label">渲染模板（只对 declarative 生效，HTML，用 \`{{字段}}\` 取值）</span>
          <textarea class="doc-input doc-textarea" name="renderer" data-doc-type-renderer rows="4" spellcheck="false" placeholder="&lt;h3 class=&quot;doc-tpl-title&quot;&gt;{{text}}&lt;/h3&gt;"></textarea>
          <span class="doc-hint" data-doc-type-note></span>
        </label>
        <div class="doc-actions">
          ${state.me ? '<button class="btn btn-sm btn-primary" type="submit">注册</button>' : '<a class="btn btn-sm" href="#/login">登录后可以注册</a>'}
        </div>
      </form>
    </div>
    ${scriptTemplatesHtml()}
    ${guideHtml()}
    <div class="doc-grid">${builtin.map((type) => card(type, '内置')).join('')}</div>
    ${custom.length ? `<div class="doc-grid">${custom.map((type) => card(type, '自定义')).join('')}</div>` : ''}`;
  ensureDelegate();
  mountTypeForm();
}

/** 旧地址 `#/blocks` 进的还是这一页 —— 名字留着，避免书签与测试里的地址变成死链。 */
const viewBlocks = viewDev;

/* ------------------------------------------------------------------ */
/* 脚本模板（开发者功能里保存自己的脚本）                                */
/* ------------------------------------------------------------------ */

/**
 * 「我的脚本模板」这张卡：表单 + 自己存过的模板。
 *
 * 模板里存的就是一段沙箱脚本（同一个块里跑的 HTML/JS），
 * 所以「保存」= 把开发时写得顺手的代码收起来，「用它新建一篇」= 省掉从零粘贴。
 */
function scriptTemplatesHtml() {
  const list = scriptTemplateState.templates;
  const limit = scriptTemplateState.limit > 0 ? ` / ${scriptTemplateState.limit}` : '';
  const cards = list.length
    ? `<div class="doc-grid">${list.map(scriptTemplateCard).join('')}</div>`
    : `<div class="doc-hint">${
        scriptTemplateState.failed
          ? '登录之后这里会列出你自己的脚本模板。'
          : '还没有模板。把下面那段代码存起来，下次就能一键起一篇。'
      }</div>`;

  return `<div class="card doc-panel" data-doc-template-panel>
    <div class="card-head"><span class="card-title">🗂 我的脚本模板</span><span class="hint">${list.length}${limit} 个</span></div>
    <div class="doc-hint">模板只自己可见。存的是<strong>一段沙箱脚本</strong>：「用它新建一篇」会建一篇只带这一块的积木，直接进编辑器。<br>
      代码里带 HTML 标签就建成 <code class="doc-code">小应用</code> 块（画界面），纯 JS 就建成 <code class="doc-code">脚本</code> 块（画别的块）。</div>
    <form class="doc-new" data-doc-form="script-template">
      <input type="hidden" name="id" value="">
      <div class="doc-new-row">
        <input class="doc-input" name="name" maxlength="40" placeholder="模板名（如 打卡本）">
        <input class="doc-input" name="description" maxlength="200" placeholder="一句话说明（选填）">
      </div>
      <label class="doc-field"><span class="doc-field-label">脚本代码（HTML / JS，在访客浏览器的沙箱里跑）</span>
        <textarea class="doc-input doc-textarea doc-src-box" name="code" rows="8" spellcheck="false" placeholder="&lt;h3&gt;标题&lt;/h3&gt;&#10;&lt;script&gt; Sandbox.resize(); &lt;/script&gt;"></textarea>
      </label>
      <div class="doc-actions">
        ${
          state.me
            ? '<button class="btn btn-sm btn-primary" type="submit">保存模板</button><button class="btn btn-sm btn-ghost" type="button" data-doc-action="tpl-reset">清空表单</button>'
            : '<a class="btn btn-sm" href="#/login">登录后可以存模板</a>'
        }
        <button class="btn btn-sm btn-ghost" type="button" data-doc-action="tpl-sample">填入示例代码</button>
      </div>
    </form>
    ${cards}
  </div>`;
}

function scriptTemplateCard(item) {
  const size = typeof item.code === 'string' ? item.code.length : 0;
  return `<div class="card doc-type-card">
    <div class="card-head">
      <span class="card-title">🗂 ${esc(item.name)}</span>
      <span class="doc-badge">${size} 字符 · ${esc(Fmt.timeAgo(item.updatedAt))}</span>
    </div>
    ${item.description ? `<div class="doc-hint">${esc(item.description)}</div>` : ''}
    <textarea class="doc-input doc-textarea doc-src-box" rows="4" readonly spellcheck="false">${esc(item.code ?? '')}</textarea>
    <div class="doc-actions">
      <button class="btn btn-sm" type="button" data-doc-action="tpl-load" data-doc-script-template="${esc(item.id)}">编辑这段</button>
      <button class="btn btn-sm btn-primary" type="button" data-doc-action="tpl-new" data-doc-script-template="${esc(item.id)}">用它新建一篇</button>
      <button class="btn btn-sm btn-ghost" type="button" data-doc-action="tpl-delete" data-doc-script-template="${esc(item.id)}">删除</button>
    </div>
  </div>`;
}

const tplField = (name) => $(`[data-doc-form="script-template"] [name="${name}"]`);

/** 把一份模板（或空值）填进表单：`id` 决定这是「新建」还是「覆盖那一条」。 */
function fillScriptTemplateForm(item) {
  const id = tplField('id');
  const name = tplField('name');
  const description = tplField('description');
  const code = tplField('code');
  if (id) id.value = item ? String(item.id) : '';
  if (name) name.value = item ? String(item.name ?? '') : '';
  if (description) description.value = item ? String(item.description ?? '') : '';
  if (code) code.value = item ? String(item.code ?? '') : '';
  const submit = $('[data-doc-form="script-template"] [type="submit"]');
  if (submit) submit.textContent = item ? '保存修改' : '保存模板';
}

/**
 * 「用它新建一篇」：建一篇只带一个脚本块的积木，然后直接进编辑器。
 *
 * 存模板时不问「这是哪一类块」，建的时候按内容认：
 *   · 带 HTML 标签（`<div>`、`<script>`…）→ **小应用**块（`app`，画界面的那种）；
 *   · 纯 JS → **脚本**块（`script`，帖子级脚本，用来画别的块）。
 * 这两类块的 `code` 语义本来就不同：`script` 的正文是裸 JS（服务端会自己包 `<script>`），
 * `app` 的正文是一整段 HTML/JS 文档。认错了块会变成一片看不懂的源码，所以这里要点一下。
 */
async function newDocFromScriptTemplate(item) {
  const source = String(item.code ?? '');
  const html = /<\/?[a-z][\w-]*(\s[^>]*)?>/i.test(source);
  const block = html
    ? { type: 'app', props: { app: item.name || '', config: {}, code: source } }
    : { type: 'script', props: { code: source } };
  const created = await api('/api/docs', {
    method: 'POST',
    body: {
      title: item.name || '未命名',
      kind: 'post',
      scope: 'public',
      template: '',
      blocks: [block],
    },
  });
  toast(`用「${item.name}」建好了一篇（${html ? '小应用' : '脚本'}块）`);
  navigate(`/doc/${created.doc.id}/edit`);
}


/* 注册表单的两个默认值。差别只有一处：**沙箱类型必须声明一个 code 字段** ——
 * `sandboxInner()` 就是读 `props.code` 来当程序正文的，schema 里没有它，
 * 块建出来只会是一句「这个积木还没写代码」，用户看不出是哪里没填。 */
const DECLARATIVE_SCHEMA_SAMPLE = `{
  "text": { "type": "string", "required": true, "label": "内容" }
}`;

const SANDBOX_SCHEMA_SAMPLE = `{
  "app": { "type": "string", "singleLine": true, "maxLength": 40, "label": "应用名" },
  "code": { "type": "string", "maxLength": 20000, "label": "代码（HTML / JS）" }
}`;

const DECLARATIVE_NOTE =
  '留空就渲染成「字段名 → 值」的表；填了就按模板出 HTML。取值一律转义，模板里的 script / 内联事件 / javascript: 会被剥掉 —— 模板会出现在每个访客的页面上。';

const SANDBOX_NOTE =
  '沙箱类型不用模板：上面 schema 里声明的那个 code 字段就是程序正文，它在访客浏览器的玻璃房里跑（沙箱 API 见下面那一节）。';

/** 选 declarative / sandbox 时把默认值和说明换掉 —— 两条路的岔口就在这一个下拉框。 */
function mountTypeForm() {
  const select = $('[data-doc-type-kind]');
  const schema = $('[data-doc-type-schema]');
  const renderer = $('[data-doc-type-renderer]');
  const note = $('[data-doc-type-note]');
  const apply = () => {
    const sandbox = String(select?.value ?? '') === 'sandbox';
    if (schema) schema.value = sandbox ? SANDBOX_SCHEMA_SAMPLE : DECLARATIVE_SCHEMA_SAMPLE;
    if (note) note.textContent = sandbox ? SANDBOX_NOTE : DECLARATIVE_NOTE;
    if (renderer && sandbox) {
      renderer.value = '';
      renderer.disabled = true;
    } else if (renderer) {
      renderer.disabled = false;
    }
  };
  apply();
  if (typeof select?.addEventListener === 'function') select.addEventListener('change', apply);
}

/**
 * 「怎么自己编一个块」—— 这一页存在的理由就是回答这个问题。
 *
 * 两条路，都要真的能跑：
 *   声明式（schema + 渲染模板）＝ 把已有字段换个样子摆出来；
 *   沙箱（sandbox + code）＝ 真的写一段程序，在访客浏览器的玻璃房里跑。
 * 底下还摊开块的**底层形状**：要手写或程序化生成积木时，看到的就这三样。
 */
function guideHtml() {
  return `<div class="card doc-panel doc-guide">
    <div class="card-head"><span class="card-title">🧩 怎么自己编一个块</span><span class="hint">两条路，都在这个页面上能试</span></div>
    <ol class="doc-guide-list">
      <li><strong>声明式块</strong>：上面填一份 props schema（字段名 → 类型 / 必填 / 上限），再给一段渲染模板，HTML 里用 <code class="doc-code">{{字段名}}</code> 取值。
        适合「把已有字段换个样子摆出来」——时间线、卡片、徽章都是这种。注册完在文档编辑器的「插入一块」里就能选到。</li>
      <li><strong>沙箱块</strong>：<code class="doc-code">rendererKind</code> 选 sandbox，schema 里声明一个 <code class="doc-code">code</code> 字段，块里写的 HTML/JS 会在一个<strong>拿不到本站身份的 iframe</strong> 里跑
        （<code class="doc-code">sandbox="allow-scripts"</code>，没有 <code class="doc-code">allow-same-origin</code>，CSP 是 <code class="doc-code">default-src 'none'</code>）。
        <strong>这才是能写功能的那条路</strong>：JSON 只当数据，行为写在 JS 里（见下）。</li>
    </ol>
    <div class="doc-guide-code"><span class="doc-hint">沙箱里能用的全部东西（没有别的了）：</span>
      <textarea class="doc-input doc-textarea doc-src-box" data-doc-guide-sample rows="9" spellcheck="false" readonly>${esc(GUIDE_SNIPPET)}</textarea>
    </div>
    <div class="doc-hint">沙箱 API 一览：<code class="doc-code">Sandbox.props</code>（本块字段）、<code class="doc-code">Sandbox.doc()</code>（文档元信息）、
      <code class="doc-code">Sandbox.blocks()</code>（正文里其它块，按别的块算东西靠它）、<code class="doc-code">Sandbox.viewer()</code>（谁在看）、
      <code class="doc-code">Sandbox.state.get() / set(value)</code>（<strong>存在服务端的持久状态</strong>，刷新、换个访客都还在）、
      <code class="doc-code">Sandbox.value(v)</code>（交回宿主给联动用）、<code class="doc-code">Sandbox.resize()</code>。
      这些全是 Promise；每次调用都是一次可审计的能力申请，宿主有权拒绝，被拒时 Promise 会 reject。</div>
    <div class="doc-hint">块的底层形状就三样：<code class="doc-code">{ block_id: 'b3', type: '块类型名', version: 1, props: { … } }</code>。
      它在 Markdown 里就是一围栏 —— <code class="doc-code">\`\`\`doc:块类型名</code> 后面跟一份 props JSON，导出再导入不会丢。
      想让 A 块每次渲染都取 B 块的值，在 A 的 props 里写 <code class="doc-code">"bind": {"from": "b3", "field": "text"}</code>（或直接用块卡片上的「联动」两个框）。
      任何一块都能在编辑器里展开「源码」直接改 JSON。</div>
    <div class="doc-hint">写多页面 wiki 时，双链的写法是 <code class="doc-code">[[目标页]]</code> 或 <code class="doc-code">[[目标页|显示字]]</code>：<strong>独占一行</strong>会变成一个「双链」块，夹在句子中间就当场变成一个链接。
      两种写法都会落到 <code class="doc-code">#/wiki/目标页</code> —— 还没建过的页也给一个「建这一页」，不是死链。</div>
    <div class="doc-hint">不想要模板也行：<a href="#/docs">新建一篇</a>选「空白文档」，再在编辑器里「插入一块」选 <strong>⚙ 小应用</strong>，把代码填进去就是一篇从零写起的功能文档。</div>
  </div>`;
}

const GUIDE_SNIPPET = `<!-- Sandbox.props 是这个块的全部字段；Sandbox.resize() 让宿主跟着内容长高。 -->
<h3>打卡本</h3>
<p id="who">…</p>
<button id="ping">今天打一次卡</button>
<ul id="log"></ul>
<script>
  (async () => {
    // 想知道什么就申请什么 —— 沙箱是不透明源，自己读不到任何本站信息。
    const me = await Sandbox.viewer();   // { loggedIn, username, displayName, staff }
    const doc = await Sandbox.doc();     // { id, title, kind, author, updatedAt }
    document.getElementById('who').textContent =
      (me.loggedIn ? '@' + me.username : '（未登录：看得到，存不下）') + ' 正在看《' + doc.title + '》';

    // 状态存在服务端（按「块 + 我」各一份），刷新页面、明天再来都还在。
    let days = (await Sandbox.state.get()) || [];
    const paint = () => {
      document.getElementById('log').innerHTML = days.map((d) => '<li>' + d + '</li>').join('');
      Sandbox.resize();
    };
    document.getElementById('ping').onclick = async () => {
      const today = new Date().toISOString().slice(0, 10);
      if (days.indexOf(today) >= 0) return;
      days = days.concat([today]);
      await Sandbox.state.set(days);
      paint();
    };
    paint();
  })();
</script>`;

/** 脚本模板表单的「填入示例代码」：一段最短的、在沙箱里真的跑得起来的脚本。 */
const TEMPLATE_SAMPLE = `<h3 id="title">今天做了什么</h3>
<button id="ping" type="button">记一笔</button>
<ul id="log"></ul>
<script>
  (async () => {
    // 沙箱拿不到本站身份，想知道什么就申请什么（被拒时 Promise 会 reject）。
    const me = await Sandbox.viewer();
    document.getElementById('title').textContent =
      (me.loggedIn ? '@' + me.username : '访客') + ' 的记录';

    // 状态存在服务端（按「块 + 人」各一份），刷新、明天再来都还在。
    let items = (await Sandbox.state.get()) || [];
    const paint = () => {
      document.getElementById('log').innerHTML = items.map((x) => '<li>' + x + '</li>').join('');
      Sandbox.resize();
    };
    document.getElementById('ping').onclick = async () => {
      items = items.concat([new Date().toISOString().slice(0, 16).replace('T', ' ')]);
      await Sandbox.state.set(items);
      paint();
    };
    paint();
  })();
</script>`;

/* ------------------------------------------------------------------ */
/* 事件（挂在 ui.app 上，只挂一次）                                     */
/* ------------------------------------------------------------------ */

let delegated = false;

function ensureDelegate() {
  if (delegated) return;
  delegated = true;
  ui.app.addEventListener('click', onAppClick);
  ui.app.addEventListener('submit', onAppSubmit);
}

function findAction(target) {
  return typeof target?.closest === 'function' ? target.closest('[data-doc-action]') : null;
}

async function onAppClick(event) {
  // Tab 切换先判：它不是一个「动作」，但它也是 click。
  const tab = typeof event.target?.closest === 'function' ? event.target.closest('[data-doc-tab]') : null;
  if (tab) return onTabClick(tab.dataset.docTab);
  // 「大家在用」的标签：点一下就是往标签框里追加一个，不直接存 —— 存还是按「保存」。
  const pick = typeof event.target?.closest === 'function' ? event.target.closest('[data-doc-tag-pick]') : null;
  if (pick) {
    const input = $('[data-doc-tags]');
    const tag = pick.dataset.docTagPick ?? '';
    if (input && tag && !input.value.includes(tag)) {
      const current = input.value.trim().replace(/[,\s]+$/, '');
      input.value = current ? `${current}, ${tag}` : tag;
    }
    return;
  }
  const node = findAction(event.target);
  if (!node) return;
  const action = node.dataset.docAction;
  const blockId = node.dataset.blockId;
  const editor = docState.editor;
  const currentId = docState.editor ? docState.editor.id : docState.viewing;
  const withBusy = (task) => withButtonBusy(node, task).catch((error) => toastError(error));

  if (action === 'new') return withBusy(newDocAndEdit);
  if (action === 'layout') {
    // 只记一个偏好，然后整页重画 —— 列表的排法不是文档的一部分。
    // 重画要用「当前这份筛选条件」，否则切一下排法就把搜的关键词丢了。
    const layout = node.dataset.layout;
    if (layout) Prefs.writePreference('forum:docsLayout', layout === 'list' ? 'list' : 'grid');
    return withBusy(() => viewDocs(docState.listQuery ?? new URLSearchParams()));
  }
  if (action === 'import-toggle') {
    const panel = $('[data-doc-form="import"]');
    if (panel) panel.hidden = !panel.hidden;
    return;
  }
  if (action === 'block-save') return withBusy(() => saveBlock(blockId));
  if (action === 'source-save') return withBusy(() => saveBlockSource(blockId));
  if (action === 'wiki-open') return withBusy(() => openWikiPage(node.dataset.wikiName));
  if (action === 'wiki-new-station') return withBusy(newStationFromInput);
  if (action === 'wiki-new') {
    const name = String($('[data-wiki-new-name]')?.value ?? '').trim();
    if (!name) {
      toast('先写一个页面标题', 'error');
      return;
    }
    // 站在三栏页面上时，新页要挂到**这个**站上；老的双链落点没有站，才退回默认站。
    const stationId = Number(docState.stationId) || 0;
    return withBusy(() => (stationId ? createStationPageIn(stationId, name) : openWikiPage(name)));
  }
  if (action === 'wiki-cat') {
    const id = docState.viewing;
    const category = String($('[data-wiki-category]')?.value ?? '');
    return withBusy(async () => {
      await api(`/api/docs/${id}/wiki`, { method: 'PUT', body: { category } });
      toast(category ? `归到「${category}」了` : '取消分类了');
      // 边栏顺序跟着分类变，整页重画最省事（nav 与正文是同一个响应里的东西）。
      await viewDoc(id);
    });
  }
  if (action === 'poll-vote') return withBusy(() => votePoll(node));
  if (action === 'up') return withBusy(() => moveBlock(blockId, 'up'));
  if (action === 'down') return withBusy(() => moveBlock(blockId, 'down'));
  if (action === 'block-delete') {
    if (!confirm(`删掉 ${blockId} 吗？`)) return;
    return withBusy(async () => {
      await api(`/api/docs/${currentId}/blocks/${blockId}`, { method: 'DELETE' });
      absorb({ ...editor.data, blocks: (editor.data.blocks ?? []).filter((item) => item.blockId !== blockId) });
    });
  }
  if (action === 'insert') return withBusy(insertBlock);
  if (action === 'save-all') return withBusy(saveAll);
  if (action === 'md-reload') return withBusy(loadMarkdown);
  if (action === 'src-reload') return withBusy(reloadSource);
  if (action === 'apply-template') {
    const key = $('[data-doc-template]')?.value ?? '';
    if (!key) {
      toast('先选一个模板', 'error');
      return;
    }
    if (!confirm('套模板会把整篇现有的块换成模板的块（旧的会留在修订记录里）。继续吗？')) return;
    return withBusy(async () => {
      absorb(await api(`/api/docs/${currentId}/apply-template`, { method: 'POST', body: { key, mode: 'replace' } }));
      toast('模板套好了');
    });
  }
  if (action === 'revisions') return withBusy(() => showRevisions());
  if (action === 'rollback') return withBusy(() => rollback(Number(node.dataset.revision)));
  if (action === 'export') return withBusy(() => exportDoc(currentId));
  if (action === 'delete') return withBusy(() => deleteDoc(currentId));

  /* 开发者功能（`#/dev`）里的脚本模板 */
  if (action === 'tpl-load') {
    const item = scriptTemplateById(node.dataset.docScriptTemplate);
    if (!item) return;
    fillScriptTemplateForm(item);
    toast(`把「${item.name}」填进表单了，改完点保存`);
    return;
  }
  if (action === 'tpl-reset') {
    fillScriptTemplateForm(null);
    return;
  }
  if (action === 'tpl-sample') {
    const code = tplField('code');
    if (code) code.value = TEMPLATE_SAMPLE;
    return;
  }
  if (action === 'tpl-delete') {
    const item = scriptTemplateById(node.dataset.docScriptTemplate);
    if (!item) return;
    if (!confirm(`删掉模板「${item.name}」吗？`)) return;
    return withBusy(async () => {
      await api(`/api/docs/meta/script-templates/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
      await loadScriptTemplates(true);
      toast(`「${item.name}」删了`);
      return viewDev();
    });
  }
  if (action === 'tpl-new') {
    const item = scriptTemplateById(node.dataset.docScriptTemplate);
    if (!item) return;
    return withBusy(() => newDocFromScriptTemplate(item));
  }
}

async function onAppSubmit(event) {
  const form = event.target?.dataset?.docForm ? event.target : null;
  if (!form) return;
  event.preventDefault();
  const values = formValues(form);
  const button = form.querySelector('[type="submit"]');
  await withButtonBusy(button, async () => {
    try {
      if (form.dataset.docForm === 'filter') {
        const params = new URLSearchParams();
        if (values.q) params.set('q', values.q);
        if (values.kind) params.set('kind', values.kind);
        if (values.mine) params.set('mine', '1');
        // 标签是从卡片上点进来的，筛选表单里带着一个 hidden 的 tag：不清空它，
        // 否则「在某个标签里搜标题」一按筛选就变回全站了。
        if (values.tag) params.set('tag', values.tag);
        return navigate(`/docs${params.toString() ? `?${params}` : ''}`);
      }
      if (form.dataset.docForm === 'import') {
        let payload;
        try {
          payload = JSON.parse(values.payload ?? '');
        } catch {
          return toast('贴进来的不是合法 JSON', 'error');
        }
        const created = await api('/api/docs/meta/import', { method: 'POST', body: { payload, scope: values.scope } });
        toast('导入好了');
        return navigate(`/doc/${created.doc.id}/edit`);
      }
      if (form.dataset.docForm === 'register') {
        let propsSchema;
        try {
          propsSchema = JSON.parse(values.propsSchema ?? '{}');
        } catch {
          return toast('props schema 不是合法 JSON', 'error');
        }
        // 渲染模板是可选的；写了就当 `renderer_json` 存下来（服务端会剥掉危险构造）。
        const renderer = String(values.renderer ?? '').trim();
        await api('/api/docs/meta/block-types', {
          method: 'POST',
          body: {
            name: values.name,
            label: values.label,
            icon: values.icon,
            rendererKind: values.rendererKind,
            propsSchema,
            renderer: renderer ? { html: renderer } : '',
          },
        });
        toast('注册好了，去编辑器里就能用了');
        return viewDev();
      }
      if (form.dataset.docForm === 'script-template') {
        const id = Number(values.id) || 0;
        const body = { name: values.name, description: values.description, code: values.code };
        if (id) body.id = id;
        await api('/api/docs/meta/script-templates', { method: 'POST', body });
        toast(id ? '模板改了' : '模板存好了，下次一键起一篇');
        await loadScriptTemplates(true);
        return viewDev();
      }
      return undefined;
    } catch (error) {
      toastError(error);
      return undefined;
    }
  });
}

/**
 * 重新拉一次这篇的完整形状（`doc` + `blocks` + `source` + `settings`）。
 *
 * 为什么需要：积木视图的每一次改动走的是块接口（`PUT/POST /api/docs/:id/blocks…`），
 * 它们**只回 block(s)**，不回 `source` —— 于是 `editor.data.source` 会停在旧文本上。
 * 切到源码视图前不重取，作者看到的就是上一版源码。
 */
async function refreshEditorData() {
  const editor = docState.editor;
  editor.data = await api(`/api/docs/${editor.id}`);
  return editor.data;
}

/**
 * 编辑器里的三个视图页签。
 *
 * 切之前先 `flushDraft()`：这样「Markdown 里写一半 → 切过去拼积木 → 再切回来」
 * 一路都不会丢东西，而且积木/源码视图看到的是**服务端解析出来**的那份。
 * 作者在「块数暴跌」的确认框上点了取消，就原地不动 —— 半途切走会让他以为改动没了。
 */
async function onTabClick(mode) {
  const editor = docState.editor;
  if (!editor || editor.mode === mode) return;
  try {
    if (!(await flushDraft())) return;
    editor.mode = mode;
    if (mode === 'markdown') return await loadMarkdown();
    // 积木视图里可能刚改过块（那些接口不回 source），切过去之前把整篇重取一遍。
    await refreshEditorData();
    renderEditor();
  } catch (error) {
    toastError(error);
  }
}

// ── 导出 ──────────────────────────────────────────────────────────────
export { viewDocs };
export { viewDoc };
export { viewWiki };
export { viewWikiIndex };
export { viewDocEdit };
export { viewDev };
export { viewBlocks };

/* @hand-written */
