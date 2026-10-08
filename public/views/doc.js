// 积木（可编程帖子 / 笔记 / 个人主页）的页面。
//
//   积木广场     #/docs            列表 + 筛选 + 新建
//   阅读页       #/doc/:id         外壳 + 后端渲染好的正文
//   编辑器       #/doc/:id/edit    源码模式 / 积木模式
//   开发者功能   #/dev             块类型表（速查 + 注册）+ 我自己的脚本模板
//
// `#/blocks` 是登记在案的旧地址（README、侧栏、doc-smoke 都引用它），
// 它进的还是这一页 —— 块类型表只是从「独立一个 Tab」挪进了开发者功能里，
// 页面本身没有下线，旧书签照样能打开。
//
// 三条贯穿全文件的纪律：
//   1. **正文的 HTML 一律由后端出**（`src/modules/doc/blocks/html.js`）。
//      前端只画外壳、只发请求。想「在浏览器里先把块渲染一遍」的冲动要忍住 ——
//      那等于把块引擎实现两遍，出错时你分不清是哪一遍错了。
//   2. **编辑器只有一个「保存」**（`saveAll()`）：标题、可见范围、正文一起存。
//      「标题和正文分开存」是给实现找的方便，不是给作者找的方便 —— 作者心里
//      「这篇改完了」是一件事。块仍然一块一块写进后端（一次 PUT 一块），
//      但那是 `saveAll()` 内部的事，作者不用知道。
//   3. **自动保存是默认，那颗「保存」是「立刻存」**（`scheduleAutoSave()` →
//      `saveAll({ quiet: true })`）。自动保存不是第二条保存路，而是同一个
//      `saveAll()` 换一副安静面孔：不弹提示、不重画（重画会把作者正打的那行字
//      连光标一起冲掉），**也绝不替作者点「块数暴跌」那个确认框** ——
//      静悄悄替人做决定最难查，所以那颗状态灯把每一次自动保存都明说出来。
//
// 权限只做「藏按钮」，真正的判断在后端 —— 前端藏起来的按钮不叫权限。

import { $, emptyHtml, esc, indentTextarea, loadingHtml, toast, ui } from '../core/dom.js';
import { api, withButtonBusy } from '../core/api.js';
import { toastError } from '../core/errors.js';
import { navigate } from '../core/router.js';
import { state, DOC_LAYOUTS } from '../core/state.js';
import * as Fmt from '../core/format.js';
import * as Prefs from '../core/preferences.js';
import * as Blocks from './doc-blocks.js';
import * as Ai from './ai.js';
import { reactionBarHtml, replyHtml, repostSectionHtml } from './post.js';
import { attachSandbox, unmountSandboxes } from '../core/sandbox.js';
import { ntRenderMath } from './notes.js';
import * as DocAi from './doc-ai.js';
import { checkProfile, isProfileCard, profileBlockedMessage, PROFILE_CARD_APP } from '../core/profile-rules.js';

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

/** 左侧 AI 抽屉的生命周期手柄。 */
let mdAiPanel = null;

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

/** 标签徽章：点一下就把这个标签填进广场的搜索框（搜标题/正文/标签都能命中）。 */
function tagChipsHtml(tags) {
  return (tags ?? [])
    .filter((tag) => typeof tag === 'string' && tag)
    .map((tag) => `<a class="doc-tag" href="#/docs?q=${encodeURIComponent(tag)}">#${esc(tag)}</a>`)
    .join('');
}

/** 「草稿」徽章：有草稿行 = 工作副本与对外那一份分家了；`published=false` = 从来没发布过。 */
function draftBadgeHtml(doc) {
  if (!doc?.draft) return '';
  return `<span class="doc-badge doc-badge-draft">${doc.published ? '有未发布的改动' : '草稿'}</span>`;
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
      ${draftBadgeHtml(doc)}
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
    body: { title: '未命名', kind: 'post', scope: 'public', template: '', draft: true },
  });
  toast('建好了，先放在草稿箱：点「发布」别人才看得到');
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
  const drafts = query.get('drafts') === '1';
  const q = query.get('q') ?? '';
  const tag = query.get('tag') ?? '';
  // 挂在 wiki 站里的页不在广场列（一个导进来的 OI Wiki 就 519 页，会把别人的积木淹掉）：
  // 想看它们去 `#/wiki` 走站的目录树。广场上不再有「连站里的页一起列」那颗开关。
  const layout = Prefs.docsLayout() === 'list' ? 'list' : 'grid';
  const params = new URLSearchParams();
  if (kind) params.set('kind', kind);
  if (mine) params.set('mine', '1');
  if (drafts) params.set('drafts', '1');
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
        <span class="card-title">${drafts ? '📥 草稿箱' : '🧩 积木广场'}</span>
        <span class="hint">${Fmt.fmtNum(data.total ?? documents.length)} 篇${drafts ? '（没发布的改动只有你自己看得见）' : '（不含 wiki 站里的页）'}</span>
      </div>
      ${
        tag
          ? `<div class="doc-active-tag">正在看标签 <strong>#${esc(tag)}</strong><a class="btn btn-sm btn-ghost" href="#/docs">看全部</a></div>`
          : ''
      }
      <form class="doc-filters" data-doc-form="filter">
        <input type="hidden" name="tag" value="${esc(tag)}">
        <input class="doc-input" type="search" name="q" value="${esc(q)}" placeholder="搜标题、正文或标签…">
        <label class="doc-check-label"><input type="checkbox" class="doc-check" name="mine" data-doc-auto${mine ? ' checked' : ''}>只看我的</label>
        <button class="btn btn-sm btn-primary" type="submit">筛选</button>
      </form>
      <div class="doc-actions">
        ${state.me ? '<button class="btn btn-sm" type="button" data-doc-action="new">＋ 新建一篇</button>' : '<a class="btn btn-sm" href="#/login">登录后可以新建</a>'}
        ${state.me ? `<a class="btn btn-sm${drafts ? ' btn-primary' : ''}" href="#/docs?drafts=1">📥 草稿箱</a>` : ''}
        <a class="btn btn-sm" href="#/wiki">⧉ Wiki 站</a>
        <a class="btn btn-sm btn-ghost" href="#/dev">🛠 开发者功能</a>
        <div class="tabs tabs-sm doc-layout-tabs">${layoutTabs}</div>
      </div>
    </div>
    ${
      documents.length
        ? `<div class="${layout === 'list' ? 'doc-list' : 'doc-grid'}">${documents.map(docCardHtml).join('')}</div>`
        : drafts
          ? `<div class="card">${emptyHtml('📥', '草稿箱是空的', '编辑器里按「保存」的改动会落在草稿箱，按「发布」别人才看得到')}</div>`
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
 * 互动区。赞 / 踩 / 收藏 / 转发 / 关注 / AI 解读**就在积木页里**。
 *
 * 这些数据全都长在影子行（`posts` 那一行）上 —— 但那是存放位置，不是使用位置。
 * 积木才是正文的正式形态，帖子只是它的影子；让读者为了点个赞跳走是本末倒置。
 *
 * 具体那条互动条交给 `views/post.js` 的 `reactionBarHtml` 画：同一份实现、同一套事件
 * （`core/events.js` 里 reaction / bookmark 都按 `data-id` 找帖子，这里给的就是
 * 影子行 id），所以积木页和帖子页的行为不会两边不一样。真正的数据由
 * `GET /api/docs/:id/anchor` 按当前访客读出来（见 `mountInteraction`）。
 */
function interactHtml(doc, abilities) {
  if (!doc.anchorPostId) return '';
  if (!abilities.canReact) {
    // 看不见这篇的人也看不见这条 —— 前端只负责不画按钮，能不能动在后端。
    return `<div class="card doc-interact">
      <div class="doc-hint">这篇对「${esc(doc.scopeLabel ?? '不公开')}」可见。赞 / 踩 / 收藏记在它的互动锚点上，只有看得见这篇的人给得上。</div>
      <div class="doc-interact-replies" data-doc-replies></div>
    </div>`;
  }
  return `<div class="card doc-interact">
    <div class="doc-interact-bar" data-doc-interact-bar><div class="doc-hint">互动条加载中…</div></div>
    <div class="doc-interact-replies" data-doc-replies></div>
    <div class="doc-interact-repost" data-doc-repost></div>
    <div class="doc-interact-ai" data-doc-interact-ai></div>
  </div>`;
}

/**
 * 讨论区：回复列表 + 发表框。
 *
 * 回复和互动条长在同一行影子帖子上（`GET /api/docs/:id/anchor` 一趟都给了），
 * 所以这里只是把 `views/post.js` 那份回复卡片原样铺开 —— 同一份实现、同一套样式，
 * 积木页和帖子页看到的回复不会两边不一样。
 *
 * 唯一的差别是删除按钮：帖子页删完回帖子页，积木页删完要留在积木页，
 * 所以传 `deleteAction: 'reply-delete'` 改由本文件自己的 `data-doc-action` 接。
 */
function docRepliesHtml(post, data) {
  const replies = data?.replies ?? [];
  const total = data?.replyCount ?? replies.length;
  const list = replies.length
    ? replies.map((reply) => replyHtml(reply, post, { deleteAction: 'reply-delete' })).join('')
    : emptyHtml('💭', '还没有人回复', '有疑问就在下面问一句，作者会收到通知');

  // 「能不能发」只决定画不画输入框；真发得出去吗由后端那条
  // `POST /api/posts/:id/replies` 判（它认影子行的 locked，也认登录状态）。
  let compose;
  if (data?.canReply) {
    compose = `<form class="form doc-reply-form" data-doc-form="reply" data-id="${post.id}">
      <div class="field">
        <textarea name="content" placeholder="写下你的回复…（支持 Markdown，@某人 可以提醒 TA）" required maxlength="5000"></textarea>
      </div>
      <div class="form-error" data-error hidden></div>
      <div class="form-actions">
        <button class="btn btn-sm btn-primary" type="submit">发表回复</button>
        <button class="btn btn-sm btn-ghost" type="button" data-action="preview" data-target="reply">预览</button>
      </div>
      <div class="preview-box" data-preview hidden></div>
    </form>`;
  } else if (post.locked && state.me) {
    compose = '<div class="hint">这篇的讨论已经锁定，暂时无法回复。</div>';
  } else {
    compose = `<div class="hint" style="margin-bottom:10px">登录后即可参与讨论。</div>
      <div class="form-actions">
        <a class="btn btn-sm btn-primary" href="#/login">登录</a>
        <a class="btn btn-sm" href="#/register">注册新账号</a>
      </div>`;
  }

  return `<div class="doc-replies-head"><span class="card-title">💬 讨论（${total}）</span></div>
    ${list}
    ${compose}`;
}

/**
 * 阅读页的互动条 + 讨论区 + AI 解读面板：正文挂好之后再异步填。
 *
 * 为什么分开取：正文是「谁都能看的那部分」，互动状态是「按访客算的那部分」——
 * 后者慢、还依赖登录，不该拖着文章不让显示。
 */
async function mountInteraction(doc) {
  const bar = $('[data-doc-interact-bar]');
  const repliesHost = $('[data-doc-replies]');
  const repostHost = $('[data-doc-repost]');
  if (!doc.anchorPostId || (!bar && !repliesHost && !repostHost)) return;
  const anchorId = Number(doc.anchorPostId);
  let data = null;
  try {
    data = await api(`/api/docs/${doc.id}/anchor`);
  } catch (error) {
    const note = `<div class="doc-hint">互动信息没读出来：${esc(error.message)}</div>`;
    if (bar) bar.innerHTML = note;
    if (repliesHost) repliesHost.innerHTML = note;
    if (repostHost) repostHost.innerHTML = note;
    return;
  }
  const post = data?.post ?? null;
  if (!post) {
    if (bar) bar.innerHTML = '<div class="doc-hint">这篇还没有互动锚点（刚建出来或还在同步），刷新一下就有了。</div>';
    if (repliesHost) repliesHost.innerHTML = '<div class="doc-hint">还没有互动锚点，暂时不能回复。</div>';
    if (repostHost) repostHost.innerHTML = '';
    return;
  }
  if (bar) bar.innerHTML = reactionBarHtml(post, { docMode: true });
  if (repliesHost) repliesHost.innerHTML = docRepliesHtml(post, data);
  if (repostHost) repostHost.innerHTML = repostSectionHtml(post, data.reposters ?? [], { docMode: true });
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

/**
 * 回复发出去 / 删掉之后，只重画讨论区那一块，不整页刷新。
 *
 * 只认文档 id：帖子和回复都由 `GET /api/docs/:id/anchor` 一趟给回来，
 * 所以重画不需要手头留着上一次的 post。
 */
async function refreshDocReplies(docId) {
  const host = $('[data-doc-replies]');
  const id = Number(docId);
  if (!host || !Number.isInteger(id) || id <= 0) return;
  const data = await api(`/api/docs/${id}/anchor`);
  const post = data?.post ?? null;
  host.innerHTML = post ? docRepliesHtml(post, data) : '<div class="doc-hint">还没有互动锚点，暂时不能回复。</div>';
}

/**
 * 转发成功 / 撤销之后：重画互动条与转发区，不整页刷新。
 *
 * 为什么连互动条一起重画：那颗「🔁 转发 / 已转发」按钮的文案和计数就长在互动条上
 * （`views/post.js` 的 `reactionBarHtml`）。只重画转发区的话，按钮会停在「🔁 转发 0」
 * 而下面已经把你列进去了 —— 一眼就是坏的。
 */
async function refreshDocRepost(docId) {
  const bar = $('[data-doc-interact-bar]');
  const host = $('[data-doc-repost]');
  const id = Number(docId);
  if ((!bar && !host) || !Number.isInteger(id) || id <= 0) return;
  const data = await api(`/api/docs/${id}/anchor`);
  const post = data?.post ?? null;
  if (!post) return;
  if (bar) bar.innerHTML = reactionBarHtml(post, { docMode: true });
  if (host) host.innerHTML = repostSectionHtml(post, data.reposters ?? [], { docMode: true });
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

/** 离开积木页面时的统一收尾：先把这一页的活儿收尾，再收外挂、拆沙箱，最后换 DOM。 */
function leaveDocPage() {
  // 自动保存先跑：`flushAutoSave()` 会**同步**把框里的字读出来（发请求是它自己的事），
  // 所以这一句必须排在下面那句 `ui.app.innerHTML = loadingHtml()` 之前 ——
  // 顺序反了，等于把作者刚敲的那几行字连同 DOM 一起扔掉。
  // 切页不留人：这一发发出去就不再等回音（回音回来时这一页早换了，按
  // `core/route-guard.js` 的规矩作废），真没赶上还有 `beforeunload` 那句提醒兜着。
  const rescue = flushAutoSave('leave');
  if (rescue && typeof rescue.catch === 'function') rescue.catch(() => {});
  // 换代：还挂着的定时器回来时什么也别干 —— 它们读的是**这个**页面上的 DOM。
  retireAutoSave();
  // 左侧 AI 抽屉自己收：它挂的是它自己的监听（`./doc-ai.js`），这里只管把它拆掉。
  try {
    DocAi.destroyDocAi();
  } catch (error) {
    console.warn('[doc-ai] 积木编辑器左侧抽屉销毁失败：', error);
  }
  mdAiPanel = null;
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

/** 折叠状态存本地：同一台机器下次进来还是你上次那份展开的样子。 */
function wikiTreeKey(stationId) {
  return `dsh.wikiTree.${Number(stationId) || 0}`;
}

function readTreeOpen(stationId) {
  try {
    const raw = globalThis.localStorage?.getItem(wikiTreeKey(stationId));
    const list = raw ? JSON.parse(raw) : null;
    return new Set(Array.isArray(list) ? list.map(Number).filter((id) => id > 0) : []);
  } catch (error) {
    console.warn('[doc] 目录树的展开状态读不出来：', error);
    return new Set();
  }
}

function writeTreeOpen(stationId, open) {
  try {
    globalThis.localStorage?.setItem(wikiTreeKey(stationId), JSON.stringify([...open]));
  } catch (error) {
    console.warn('[doc] 目录树的展开状态存不下来：', error);
  }
}

/**
 * 左树滚动位置也存本地。
 *
 * 换页 = 整棵左栏重新渲染，新节点 `scrollTop` 从 0 开始 —— 点了一页又跳回顶上，
 * 519 页的站等于每次都从头找。存的是滚动位置（`scrollTop`），不是哪一行。
 */
function wikiScrollKey(stationId) {
  return `dsh.wikiScroll.${Number(stationId) || 0}`;
}

function readTreeScroll(stationId) {
  try {
    const raw = globalThis.localStorage?.getItem(wikiScrollKey(stationId));
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch (error) {
    console.warn('[doc] 目录树的滚动位置读不出来：', error);
    return 0;
  }
}

function writeTreeScroll(stationId, top) {
  try {
    globalThis.localStorage?.setItem(wikiScrollKey(stationId), String(Math.max(0, Math.round(Number(top) || 0))));
  } catch (error) {
    console.warn('[doc] 目录树的滚动位置存不下来：', error);
  }
}

/**
 * 目录树的展开 / 收起。
 *
 * 默认只把**通向当前这一页的那条链**打开：519 页的站全展开是十几屏，
 * 全收起又让人找不到自己在哪。用户点过的状态优先，存在 `localStorage` 里。
 *
 * 树是一根线（前序遍历 + `parentId`），所以「某一页可不可见」=
 * 它到根的这条链上每一环都处于展开态 —— 一行代码，不用递归。
 */
function mountWikiTree(wiki, tree) {
  const stationId = Number(wiki?.station?.id) || 0;
  const pages = Array.isArray(wiki?.pages) ? wiki.pages : [];
  const current = Number(wiki?.current) || 0;
  const parentOf = new Map(pages.map((page) => [Number(page.id) || 0, Number(page.parentId) || 0]));
  const open = readTreeOpen(stationId);
  if (open.size === 0) {
    for (let id = current; id; id = parentOf.get(id) || 0) open.add(id);
  }
  const nodes = () => (typeof tree?.querySelectorAll === 'function' ? [...tree.querySelectorAll('[data-wiki-node]')] : []);
  const apply = () => {
    for (const row of nodes()) {
      const id = Number(row.dataset?.wikiNode) || 0;
      let visible = true;
      for (let up = parentOf.get(id) || 0; up; up = parentOf.get(up) || 0) {
        if (!open.has(up)) {
          visible = false;
          break;
        }
      }
      if (row.hidden !== undefined) row.hidden = !visible;
      const toggle = typeof row.querySelector === 'function' ? row.querySelector('[data-wiki-toggle]') : null;
      if (toggle && open.has(id)) {
        toggle.textContent = '▾';
        if (toggle.setAttribute) toggle.setAttribute('aria-expanded', 'true');
      } else if (toggle) {
        toggle.textContent = '▸';
        if (toggle.setAttribute) toggle.setAttribute('aria-expanded', 'false');
      }
    }
  };
  const bind = () => {
    if (typeof tree?.querySelectorAll !== 'function') return;
    for (const toggle of tree.querySelectorAll('[data-wiki-toggle]')) {
      if (typeof toggle.addEventListener !== 'function') continue;
      toggle.addEventListener('click', (event) => {
        event.preventDefault?.();
        event.stopPropagation?.();
        const id = Number(toggle.dataset?.wikiToggle) || 0;
        if (!id) return;
        if (open.has(id)) open.delete(id);
        else open.add(id);
        writeTreeOpen(stationId, open);
        apply();
      });
    }
  };
  bind();
  apply();

  /**
   * 左树的滚动位置。
   *
   * 换页 = 整棵左栏重新渲染，新节点 `scrollTop` 从 0 开始 —— 在 519 页的站里点一页
   * 又跳回顶上，等于每次都从头找。所以两头都做：滚动时把位置存下来，
   * 上来先还原；要还原的位置根本看不到当前那一页时，再把当前行挪进视野（只挪最少的一截）。
   */
  const holder = typeof tree?.closest === 'function' ? tree.closest('.doc-wiki-nav') : null;
  const scroller = holder ?? tree;
  const keepScroll = () => {
    if (!scroller || typeof scroller.addEventListener !== 'function') return;
    let ticking = false;
    scroller.addEventListener('scroll', () => {
      const flush = () => {
        ticking = false;
        writeTreeScroll(stationId, scroller.scrollTop);
      };
      if (ticking) return;
      ticking = true;
      if (typeof globalThis.requestAnimationFrame === 'function') globalThis.requestAnimationFrame(flush);
      else flush();
    });
  };
  const restoreScroll = () => {
    if (!scroller || scroller.scrollTop === undefined) return;
    const saved = readTreeScroll(stationId);
    if (saved > 0) scroller.scrollTop = saved;
    const row = nodes().find((item) => Number(item.dataset?.wikiNode) === current);
    if (!row || row.hidden) return;
    const top = Number(row.offsetTop) || 0;
    const height = Number(row.offsetHeight) || 0;
    const view = Number(scroller.clientHeight) || 0;
    const at = Number(scroller.scrollTop) || 0;
    if (top < at || top + height > at + view) {
      row.scrollIntoView?.({ block: saved > 0 ? 'nearest' : 'center' });
    }
  };
  keepScroll();
  restoreScroll();

  return {
    // 站内搜索清空时会把 `innerHTML` 换回旧的那份字符串：行是**新节点**，得重新接管。
    restore() {
      bind();
      apply();
      restoreScroll();
    },
    expandAll() {
      for (const page of pages) open.add(Number(page.id) || 0);
      writeTreeOpen(stationId, open);
      apply();
    },
    collapseAll() {
      open.clear();
      writeTreeOpen(stationId, open);
      apply();
    },
  };
}

/**
 * 左栏：站名 + 站内搜索 + 页面树。
 *
 * 树是**服务端铺好的一根线**（`wiki.pages`，前序遍历 + `depth` + `parentId`），
 * 前端只画缩进与折叠开关 —— 谁是谁的子页是数据，不是样式，前端再算一遍就会有两份真相。
 *
 * 每一页一行（`.doc-wiki-tree-row`），行首那个三角是**折叠开关**：
 * OI Wiki 那种 519 页的站全铺出来能拉出十几屏，全收起又让人找不到自己在哪，
 * 所以默认只把「通向当前这一页」的那条链打开（见 `mountWikiTree`）。
 */
function stationTreeHtml(wiki) {
  const station = wiki?.station ?? {};
  const pages = wiki?.pages ?? [];
  const current = Number(wiki?.current) || 0;
  // 前序遍历里「下一页比我深」就等于「我有子页」——不用再建第二棵树。
  const branches = new Set();
  for (let i = 0; i + 1 < pages.length; i += 1) {
    if ((Number(pages[i + 1]?.depth) || 0) > (Number(pages[i]?.depth) || 0)) branches.add(Number(pages[i]?.id) || 0);
  }
  const items = pages
    .map((page) => {
      const depth = Math.min(Math.max(Number(page.depth) || 0, 0), 6);
      const icon = page.icon ? `<span class="doc-wiki-tree-icon">${esc(page.icon)}</span>` : '';
      const toggle = branches.has(Number(page.id) || 0)
        ? `<button class="doc-wiki-tree-toggle" type="button" data-wiki-toggle="${page.id}"`
          + ` aria-expanded="false" title="展开 / 收起子页" aria-label="展开或收起子页">▸</button>`
        : '<span class="doc-wiki-tree-dot" aria-hidden="true"></span>';
      const link = `<a class="doc-wiki-nav-link doc-wiki-tree-link${page.id === current ? ' is-current' : ''}"`
        + ` data-depth="${depth}" data-wiki-title="${esc(page.title)}" data-wiki-page="${page.id}"`
        + ` href="#/wiki/${encodeURIComponent(station.title ?? '')}/${encodeURIComponent(page.title)}">${icon}${esc(page.title)}</a>`;
      return `<div class="doc-wiki-tree-row" data-wiki-node="${page.id}"`
        + ` data-wiki-parent="${Number(page.parentId) || 0}" data-depth="${depth}">${toggle}${link}</div>`;
    })
    .join('');
  const tools = [];
  if (station.canEdit) {
    tools.push(
      `<input class="doc-input" type="text" data-wiki-new-name placeholder="新页面标题" aria-label="新页面标题">`,
      `<button class="btn btn-sm" type="button" data-doc-action="wiki-new">＋ 新建页面</button>`,
    );
  }
  const treeTools = pages.length > 1
    ? '<button class="btn btn-sm btn-ghost" type="button" data-wiki-tree-all>全部展开</button>'
      + '<button class="btn btn-sm btn-ghost" type="button" data-wiki-tree-none>全部收起</button>'
    : '';
  return `<aside class="doc-wiki-nav doc-wiki-side">
    <div class="doc-wiki-nav-head"><a href="#/wiki" class="doc-wiki-nav-back">⧉ Wiki 站</a><span class="hint">${pages.length} 页</span></div>
    <div class="doc-wiki-station-name">${esc(station.title ?? '')}</div>
    <input class="doc-input doc-wiki-search" type="search" data-wiki-search placeholder="站内搜索…" aria-label="站内搜索">
    <div class="doc-wiki-tree" data-wiki-tree>${
      items || '<div class="doc-wiki-nav-empty">这个站还没有页。</div>'
    }</div>
    <div class="doc-wiki-nav-hidden" data-wiki-nothing hidden>没有匹配的页面。</div>
    ${treeTools ? `<div class="doc-wiki-tree-tools">${treeTools}</div>` : ''}
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
  // 树的折叠开关：默认只展开通向当前页的那条链（见 mountWikiTree）。
  const treeState = tree ? mountWikiTree(wiki, tree) : null;
  const expandAll = $('[data-wiki-tree-all]');
  if (expandAll && typeof expandAll.addEventListener === 'function') {
    expandAll.addEventListener('click', () => treeState?.expandAll());
  }
  const collapseAll = $('[data-wiki-tree-none]');
  if (collapseAll && typeof collapseAll.addEventListener === 'function') {
    collapseAll.addEventListener('click', () => treeState?.collapseAll());
  }
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
      // 换回来的是新节点：折叠开关要重新接管，展开状态还按用户点过的那份。
      treeState?.restore();
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

/**
 * 作者自己的「草稿」提示条。
 *
 * 只给能编辑的人看：读者拿到的一直是线上那一份（`readBlocksFor` 按身份分流），
 * 对他们没什么可提示的。作者则必须知道**自己现在看的是工作副本** ——
 * 否则他会以为「我改了、广场上也还挂着，那别人应该看到了」。
 */
function draftNoteHtml(doc, abilities) {
  if (!doc?.draft || !abilities?.canEdit) return '';
  const text = doc.published
    ? '你有还没发布的改动：下面是你自己的草稿，别人看到的还是上一次发布的那一版。'
    : '这篇还没发布过，现在只有你自己看得到。';
  return `<div class="card doc-draft-note">
    <span>📥 ${esc(text)}</span>
    <a class="btn btn-sm" href="#/doc/${esc(doc.id)}/edit">去编辑器发布</a>
  </div>`;
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
      ${draftNoteHtml(doc, abilities)}
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

function blockCardHtml(block, index, blocks, locked = false) {
  const def = typeDef(block.type);
  const prev = blocks[index - 1]?.blockId ?? null;
  const next = blocks[index + 1]?.blockId ?? null;
  const id = esc(block.blockId);
  const fields = def
    ? Blocks.formHtml(def, block.props, `doc-${block.blockId}`)
    : `<div class="doc-hint">这种块类型（${esc(block.type)}）现在不在注册表里，填什么都不会被渲染。</div>`;
  // 需求 2：「个人主页名片」块（头像 / 昵称 / 签名 / 关注 / 私信 / 拉黑）**锁着** ——
  // 内容可以编辑，但**删除**与**上下移动**都不给按钮。服务端同样会 400，这里只是
  // 不画那颗点了一定失败的按钮（前端不靠它兜底，双保险）。
  const actions = locked
    ? `<span class="doc-lock" title="这一块是主页名片，锁着：内容可以改，位置固定在第一，也不许删">🔒 锁定</span>
        <button class="btn btn-sm btn-primary" type="button" data-doc-action="block-save" data-block-id="${id}">保存本块</button>`
    : `<button class="btn btn-sm btn-ghost" type="button" data-doc-action="up" data-block-id="${id}"${prev ? '' : ' disabled'}>↑</button>
        <button class="btn btn-sm btn-ghost" type="button" data-doc-action="down" data-block-id="${id}"${next ? '' : ' disabled'}>↓</button>
        <button class="btn btn-sm btn-ghost" type="button" data-doc-action="block-delete" data-block-id="${id}">删除</button>
        <button class="btn btn-sm btn-primary" type="button" data-doc-action="block-save" data-block-id="${id}">保存本块</button>`;
  return `<div class="doc-block-card${locked ? ' is-locked' : ''}" data-doc-card="${id}"${locked ? ' data-doc-locked="1"' : ''}>
    <div class="doc-block-head">
      <span class="doc-block-title">${esc(def?.icon ?? '▢')} ${esc(Blocks.summarize(block, def))} <code class="doc-code">${id}</code></span>
      <span class="doc-actions">${actions}</span>
    </div>
    ${fields}
    ${Blocks.sourceHtml(block)}
    <div class="doc-actions doc-block-foot">
      <button class="btn btn-sm btn-primary" type="button" data-doc-action="block-save" data-block-id="${id}">保存本块</button>
      <span class="doc-hint">字段填完点这里 —— 表单一长，右上角那个按钮就滚出屏幕了，所以底下再放一个。</span>
    </div>
  </div>`;
}

function blocksEditorHtml(blocks, kind = '') {
  const cards = blocks
    .map((block, index) => blockCardHtml(block, index, blocks, String(kind) === 'profile' && isProfileCard(block)))
    .join('');
  return `<div class="card doc-panel doc-howto">
      <div class="card-head"><span class="card-title">🧱 积木模式：四步</span><span class="hint">这张卡是说明书，不参与正文</span></div>
      <ol class="doc-steps">
        <li><span class="doc-step-no">1</span>写正文：最下面「➕ 插入一块」选一种类型 —— 新块加在<strong>末尾</strong>，再用块头的 ↑ ↓ 挪到想要的位置，然后在块里填字段。</li>
        <li><span class="doc-step-no">2</span>改标题和「谁可以看」：就在这张卡上面的两个输入框里改。</li>
        <li><span class="doc-step-no">3</span>点这张卡里的<strong>「保存」</strong>：标题、可见范围和这一页上所有改过的块<strong>一起存</strong>就完了（不点也没事：停手 ${AUTO_SAVE_SECONDS} 秒会自动存一次，「保存」只是「现在就存」）。</li>
        <li><span class="doc-step-no">4</span>只想存一块（比如表单一长、别的块还要接着改），每块自己的<strong>「保存本块」</strong>也在；要直接改数据就展开块里的「源码」。</li>
      </ol>
    </div>
    <div class="doc-editor">
      ${
        cards ||
        `<div class="card">${emptyHtml('🧱', '这篇还没有块', '从下面的「插入一块」开始，或者切到源码模式贴一篇进来')}</div>`
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
/**
 * 源码视图顶上的 Markdown 工具条。
 *
 * 每个按钮只做一件事：把 Markdown 记号裹到当前选区（没选东西就插占位文字并选中它），
 * 然后让 textarea 派发一次 `input` —— 自动保存与右侧实时预览都挂在那条线上，不用另接。
 *
 * 动作名与「动态」那边的编辑器（`compose.js`）保持一致（bold/italic/code/block/
 * quote/list/link/mention），这里按源码模式的需要多给了标题、表格、分隔线，
 * 以及一组公式：行内 `$…$`、行间 `$$…$$`，还有分式 / 根号 / 求和 / 积分 / 上下标。
 */
function mdToolbarHtml() {
  const tool = (kind, label, title) =>
    `<button class="doc-md-tool" type="button" data-doc-action="md" data-doc-md="${kind}" title="${esc(title)}">${label}</button>`;
  return `<div class="doc-md-toolbar" data-doc-md-toolbar role="toolbar" aria-label="Markdown 工具条">
    <span class="doc-md-tool-group">
      ${tool('bold', '<b>B</b>', '粗体')}
      ${tool('italic', '<i>I</i>', '斜体')}
      ${tool('strike', '<s>S</s>', '删除线')}
      ${tool('code', '&lt;/&gt;', '行内代码')}
      ${tool('block', '{ }', '代码块')}
    </span>
    <span class="doc-md-tool-group">
      ${tool('h2', 'H2', '二级标题')}
      ${tool('h3', 'H3', '三级标题')}
      ${tool('quote', '❝', '引用')}
      ${tool('list', '•', '无序列表')}
      ${tool('olist', '1.', '有序列表')}
      ${tool('hr', '—', '分隔线')}
    </span>
    <span class="doc-md-tool-group">
      ${tool('link', '🔗', '链接')}
      ${tool('image', '🖼', '图片')}
      ${tool('table', '▦', '表格')}
      ${tool('mention', '@', '@提及')}
    </span>
    <span class="doc-md-tool-group doc-md-tool-math">
      <span class="doc-md-tool-label">公式</span>
      ${tool('math', '$x$', '行内公式 $…$')}
      ${tool('mathblock', '$$', '行间公式 $$…$$')}
      ${tool('frac', 'a/b', '分式 \\frac{a}{b}')}
      ${tool('sqrt', '√', '根号 \\sqrt{x}')}
      ${tool('sum', '∑', '求和 \\sum')}
      ${tool('int', '∫', '积分 \\int')}
      ${tool('script', 'x²', '上标 ^{}')}
      ${tool('subscript', 'x₂', '下标 _{}')}
    </span>
    <span class="doc-md-tool-group doc-md-tool-right">
      <button class="doc-md-tool${docState.previewOff ? ' is-off' : ''}" type="button" data-doc-action="preview-toggle"
        aria-pressed="${docState.previewOff ? 'false' : 'true'}"
        title="收起 / 展开右边的实时预览（收起后编辑区吃满整宽）">👁 预览</button>
    </span>
  </div>`;
}

/** 工具条的落点：把记号裹进选区 / 前缀整行 / 另起一段插入。 */
function applyMdTool(kind) {
  const area = $('[data-doc-source]');
  if (!docState.editor || !area || !kind) return;
  const value = area.value ?? '';
  const start = area.selectionStart ?? 0;
  const end = area.selectionEnd ?? 0;
  const picked = value.slice(start, end);

  const wrap = (before, after, placeholder) => {
    const body = picked || placeholder;
    area.value = `${value.slice(0, start)}${before}${body}${after}${value.slice(end)}`;
    area.setSelectionRange(start + before.length, start + before.length + body.length);
  };
  const prefixLines = (prefix) => {
    const lineStart = value.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
    const found = value.indexOf('\n', end);
    const lineEnd = found === -1 ? value.length : found;
    const block = value.slice(lineStart, lineEnd) || '这一行';
    const next = block
      .split('\n')
      .map((line, index) => `${prefix.replace('$1', String(index + 1))}${line}`)
      .join('\n');
    area.value = `${value.slice(0, lineStart)}${next}${value.slice(lineEnd)}`;
    area.setSelectionRange(lineStart, lineStart + next.length);
  };
  const insertBlock = (text) => {
    const at = end || start;
    const head = value.slice(0, at);
    const gap = head && !head.endsWith('\n') ? '\n\n' : '';
    area.value = `${head}${gap}${text}\n${value.slice(at)}`;
    const caret = head.length + gap.length + text.length + 1;
    area.setSelectionRange(caret, caret);
  };

  if (kind === 'bold') wrap('**', '**', '粗体');
  else if (kind === 'italic') wrap('*', '*', '斜体');
  else if (kind === 'strike') wrap('~~', '~~', '删除线');
  else if (kind === 'code') wrap('`', '`', 'code');
  else if (kind === 'block') wrap('\n```js\n', '\n```\n', '// 在这里写代码');
  else if (kind === 'h2') prefixLines('## ');
  else if (kind === 'h3') prefixLines('### ');
  else if (kind === 'quote') prefixLines('> ');
  else if (kind === 'list') prefixLines('- ');
  else if (kind === 'olist') prefixLines('$1. ');
  else if (kind === 'hr') insertBlock('---');
  else if (kind === 'link') wrap('[', '](https://example.com)', '链接文字');
  else if (kind === 'image') wrap('![', '](https://example.com/a.png)', '图片说明');
  else if (kind === 'mention') wrap('@', ' ', 'username');
  else if (kind === 'table') insertBlock('| 列 1 | 列 2 |\n| --- | --- |\n| 内容 | 内容 |');
  else if (kind === 'math') wrap('$', '$', '\\frac{a}{b}');
  else if (kind === 'mathblock') insertBlock('$$\n\\frac{a}{b}\n$$');
  else if (kind === 'frac') wrap('$\\frac{', '}{b}$', 'a');
  else if (kind === 'sqrt') wrap('$\\sqrt{', '}$', 'x');
  else if (kind === 'sum') wrap('$\\sum_{', '}^{n}$', 'i=1');
  else if (kind === 'int') wrap('$\\int_{', '}^{b}$', 'a');
  else if (kind === 'script') wrap('^{', '}', '2');
  else if (kind === 'subscript') wrap('_{', '}', 'i');
  else return;

  area.focus();
  // 派发一次 input：自动保存与右侧实时预览都监听它，工具条不必自己再走一遍。
  area.dispatchEvent(new Event('input', { bubbles: true }));
}

function sourceEditorHtml(source) {
  // `name="content"` 是 AI 抽屉与旧外挂认「编辑区」用的：这里就是那个唯一的文本编辑框。
  return `<div class="card doc-panel">
    <div class="card-head">
      <span class="card-title">⚡ 源码（支持 Markdown/LaTeX）</span>
      <span class="hint">整篇就是这段文本；右边实时预览，脚本会真的跑起来</span>
    </div>
    <div class="doc-md-wrap">
      ${DocAi.docAiHtml(docState.editor?.id ?? '')}
      <div class="doc-md-grid">
        <div class="doc-md-edit" data-doc-editor-host>
          ${mdToolbarHtml()}
          <textarea class="doc-input doc-textarea doc-md" name="content" data-doc-source rows="26" spellcheck="false">${esc(source ?? '')}</textarea>
        </div>
        <div class="doc-md-side">
          <div class="doc-md-preview" data-doc-preview><div class="md"><div class="hint">右边跟着打字实时更新。</div></div></div>
        </div>
      </div>
    </div>
    <div class="doc-actions">
      <button class="btn btn-sm btn-ghost" type="button" data-doc-action="src-reload">重新拉取</button>
      <span class="doc-hint" data-doc-src-status>停手 ${AUTO_SAVE_SECONDS} 秒自动存；这里也会显示 AI 抽屉的状态。</span>
    </div>
    <div class="doc-hint">
      正文直接写 Markdown（标题 / 段落 / 列表 / 表格 / 代码围栏 / $$公式$$ / 图片 / [[双链]]）；
      积木写成一段 \`\`\`doc:poll 这样的围栏，块体是它的属性 JSON；
      \`\`\`doc:script 的块体是**原始 JS**（不是 JSON）。
      块 id（\`{#b3}\`）是票、脚本产出、块间联动认的锚，保存时会自动带上，不用手写。
    </div>
  </div>`;
}

/** 源码模式的挂载：Tab 缩进 + 实时预览 + AI 抽屉。 */
function mountSourceTools() {
  const editor = docState.editor;
  const textarea = $('[data-doc-source]');
  if (!editor || !textarea) return;
  // 预览开关的状态在挂载时贴回来：源码模式每存一次都会整块重画，
  // 光靠点按钮时切一次类名，重画之后就丢了。
  $('.doc-md-wrap')?.classList.toggle('is-preview-off', Boolean(docState.previewOff));
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
  // Tab 缩进不在这儿挂：它是 `ensureDelegate()` 里挂在 `ui.app` 上的**一份**委托，
  // 源码 textarea 与积木模式的每个块字段框共用（见 `../core/dom.js` 的 `indentTextarea`）。
  // 以前这里自己挂了一份、只插两个空格，积木模式那边就完全没有 —— 一块一块填代码的人按 Tab 只会跳走焦点。

  paint();
  mountDocAiPanel(status);
}

/**
 * 把「这段文本就是这篇的正文」交给服务端。
 *
 * 源码视图走这一条路：服务端解析、按 id 对齐、写回
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
  const el = editor.mode === 'source' ? $('[data-doc-source]') : null;
  if (!el) return null;
  const baseline = editor.mode === 'source' ? (editor.data?.source ?? '') : '';
  return { el, text: el.value ?? '', baseline };
}

/**
 * 切视图之前把改动存下去。
 *
 * 为什么切视图一定要存：两个视图是**同一篇帖子的两种看法**，而块与 id 的真相在服务端
 * （源码文本里写下的块围栏，要靠服务端解析才成为块）。「在源码里写一半就切过去拼积木」
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
  toast('切换前先把改动存下了');
  return true;
}

/* ------------------------------------------------------------------ *
 * 自动保存
 *
 * 为什么要有：作者写的是一篇要发出去的东西，而「保存」是一颗他随时会忘的按钮。
 * 忘了点的代价是**全丢**（切页、刷新、关标签页都会把框里的字带走），这个代价
 * 跟「多点一次按钮」完全不成比例。
 *
 * 为什么不是「每敲一下就存」：服务端每写一次正文/块就记一条修订（`store.js` 的
 * `snapshot()`），而一篇只留 50 条（`MAX_DOC_REVISIONS`）。存太勤，作者写半小时就能
 * 把修订表刷满，「回滚到昨天那一版」这个真需求反而没了 —— 所以自动保存的原则是
 * **尽量少存几次，但一次都不许丢**。
 * ------------------------------------------------------------------ */

/** 停手多久算「这一段写完了」。 */
const AUTO_SAVE_IDLE_MS = 2500;
/** 两次自动保存之间至少隔这么久（护住那 50 条修订记录）。 */
const AUTO_SAVE_MIN_GAP_MS = 10000;
/** 一直在打字也得存一次的上限 —— 没有它，作者不停地写就永远等不到那 2.5 秒的安静。 */
const AUTO_SAVE_MAX_WAIT_MS = 30000;
/** 说给作者听的秒数（上面那个常量改了，这里的文案自己跟着改）。 */
const AUTO_SAVE_SECONDS = Math.round(AUTO_SAVE_IDLE_MS / 1000);
/** 那颗状态灯一开始（以及「什么都没改」时）说的话。 */
const AUTO_SAVE_IDLE_TEXT = `停手 ${AUTO_SAVE_SECONDS} 秒自动存（「保存」是立刻存）—— 标题、可见范围、正文一起存。`;

/**
 * 编辑器自己那几个控件（`data-doc-*` 上的字段名）。
 *
 * 只有它们能触发自动保存：`ui.app` 上还挂着别的表单（导入、注册块类型、脚本模板），
 * 在那些框里打字顺手把正文存一遍，是拿作者没说过的话去写库。
 */
const EDITOR_FIELDS = ['docTitle', 'docScope', 'docTags', 'docScriptWrite', 'docSource'];

/**
 * 自动保存的进度。
 *
 * 全是模块级的：`renderEditor()` 会把状态灯那个元素换掉，但「存到哪一步了」是页面级的
 * 事实，不能跟着 DOM 一起被换掉。`gen` 是「编辑器这一代」的编号 —— 切页之后旧定时器
 * 回来时靠它认出「我已经不是当前这一页的人了」。
 */
const autoSave = {
  gen: 0,
  timer: 0,
  hard: 0,
  saving: false,
  queued: false,
  last: 0,
  pending: false,
  status: '',
  kind: 'idle',
};

/** 状态里那个时间：只要「时:分:秒」—— 作者看的是「刚才存过没有」。 */
function clockText(timestamp) {
  const date = new Date(timestamp);
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((part) => String(part).padStart(2, '0')).join(':');
}

/**
 * 把那颗灯点亮（`[data-doc-save-status]`）。
 *
 * `kind` 只做颜色：`ok` 绿 / `dirty` 黄 / `busy` 蓝 / `warn` 黄 / `failed` 红。
 * 颜色挂在 `data-doc-save-kind` 上、不拼进类名 —— 拼类名会在模板里留下一个半截的
 * `doc-save-`（见 `autoSaveStatusHtml()` 那段注释）。
 * 元素不在（页面已经切走）就只记状态、不碰 DOM —— 切页之后还去写旧页面，写的是
 * 别人家的 DOM。状态本身留着，重画时由 `autoSaveStatusHtml()` 原样恢复。
 */
function paintAutoSaveStatus(text, kind = 'idle') {
  autoSave.status = text;
  autoSave.kind = kind;
  const el = $('[data-doc-save-status]');
  if (!el) return;
  el.textContent = text;
  el.className = 'doc-hint doc-save';
  el.dataset.docSaveKind = kind;
}

/**
 * 那颗灯（重画时得把它连同当前状态一起画回去，否则每次重画都像「刚打开这一页」）。
 *
 * 状态文字一律转义：里面会出现服务端来的错误消息（`error.message`）。
 *
 * 类名是**两个字面量**、颜色另外交给 `data-doc-save-kind`：老写法把状态后缀直接拼在
 * class 属性里（`doc-hint doc-save doc-save-${kind}` 那一串），而
 * `scripts/check-ui-contract.mjs` 扫到的类名会是「doc-save-」（它把 `${…}` 换成空格），
 * 于是那条「模板里的类名都得有 CSS」会假红一次 —— 而真给 `.doc-save-` 写一条样式是不可能的。
 * （连注释里都别写出那个带引号的 class 属性：这个扫的是源码文本，注释照样命中。）
 */
function autoSaveStatusHtml() {
  const text = autoSave.status || AUTO_SAVE_IDLE_TEXT;
  const kind = autoSave.kind || 'idle';
  return `<span class="doc-hint doc-save" data-doc-save-kind="${kind}" data-doc-save-status>${esc(text)}</span>`;
}

/**
 * 这一页上**所有改过但还没存**的块（表单里的值 vs 服务端那一份）。
 *
 * 只读、不发请求：`saveAll()` 与离开前的提醒都要用它，而「想知道有没有脏块」不该
 * 顺手写一次库。回 `{ queued, problem }` —— `problem` 是「某块填得不对」的第一句
 * 人话（说不清是哪一块，但必须让作者知道为什么一块都没存）。
 */
function collectDirtyBlocks() {
  const editor = docState.editor;
  const blocks = editor?.data?.blocks ?? [];
  const queued = [];
  let problem = '';
  for (const card of document.querySelectorAll('[data-doc-card]')) {
    const blockId = card.dataset?.docCard ?? '';
    const block = blocks.find((item) => item.blockId === blockId);
    if (!block) continue;
    const { props, problems } = Blocks.readForm(card, typeDef(block.type));
    if (problems.length > 0) {
      if (!problem) problem = problems[0];
      continue; // 这一块填得不对不影响别的块「脏不脏」—— 但一块都不会存（见 `saveAll()`）
    }
    if (sameProps(props, block.props)) continue;
    queued.push({ blockId, props });
  }
  return { queued, problem };
}

/**
 * 编辑区里还有没有「没存下去」的东西。
 *
 * 用途只有一个：关标签页 / 切页之前要不要提醒、要不要抢救一次。所以它必须**现读 DOM**，
 * 谁的话都不信 —— 缓存说「存过了」而框里其实还有字，是最坏的一种错。
 */
function hasUnsavedWork() {
  const editor = docState.editor;
  if (!editor) return false;
  const doc = editor.data?.doc ?? {};
  const draft = currentDraft();
  if (draft && draft.text !== draft.baseline) return true;
  const titleEl = $('[data-doc-title]');
  if (titleEl && String(titleEl.value ?? '').trim() !== String(doc.title ?? '')) return true;
  const scopeEl = $('[data-doc-scope]');
  if (scopeEl && String(scopeEl.value ?? '') !== String(doc.scope ?? 'public')) return true;
  const tagsEl = $('[data-doc-tags]');
  if (tagsEl && typeof tagsEl.value === 'string') {
    const parsed = parseTags(tagsEl.value);
    if (!parsed.error && parsed.tags.join('\n') !== (doc.tags ?? []).join('\n')) return true;
  }
  const scriptEl = $('[data-doc-script-write]');
  if (scriptEl && typeof scriptEl.checked === 'boolean' && scriptEl.checked !== Boolean(editor.data?.settings?.allowScriptWrite)) return true;
  // 积木模式：脏块也算没存（别的页面上没有块卡片，这一句自然恒假）。
  return collectDirtyBlocks().queued.length > 0;
}

/**
 * 敲了一下（或改了标题 / 可见范围 / 标签 / 某个块的字段）→ 排一次自动保存。
 *
 * 只排、不立刻发：连着敲十下只该存一次。两个定时器分工 —— `timer` 是「停手就存」，
 * 每敲一下往后推；`hard` 是「一直在打字也得存」，排上就不动。排的时候**不弹任何提示**：
 * 作者正写着，界面只该安静地记一笔，然后在那颗灯上写清楚现在是什么状态。
 */
function scheduleAutoSave() {
  if (!docState.editor) return;
  autoSave.pending = true;
  const gen = autoSave.gen;
  if (autoSave.timer) clearTimeout(autoSave.timer);
  // 上一次自动保存（或手动保存）才刚过：把这一发推到最小间隔之后。
  // 排队，但别挤在一起 —— 挤在一起才是把修订记录刷满的原因。
  const wait = Math.max(AUTO_SAVE_IDLE_MS, AUTO_SAVE_MIN_GAP_MS - (Date.now() - autoSave.last));
  autoSave.timer = setTimeout(() => {
    autoSave.timer = 0;
    if (gen !== autoSave.gen) return;
    runAutoSave('idle');
  }, wait);
  if (!autoSave.hard) {
    autoSave.hard = setTimeout(() => {
      autoSave.hard = 0;
      if (gen !== autoSave.gen) return;
      runAutoSave('long');
    }, AUTO_SAVE_MAX_WAIT_MS);
  }
  paintAutoSaveStatus(
    autoSave.saving ? '正在保存…' : `有改动 —— 停手 ${AUTO_SAVE_SECONDS} 秒自动存`,
    autoSave.saving ? 'busy' : 'dirty',
  );
}

/** 取消排着的自动保存（手动点「保存」、切视图、切页时都要）。 */
function cancelAutoSave() {
  if (autoSave.timer) clearTimeout(autoSave.timer);
  if (autoSave.hard) clearTimeout(autoSave.hard);
  autoSave.timer = 0;
  autoSave.hard = 0;
  autoSave.pending = false;
}

/**
 * 换一代：把上一页的定时器、排队标记、上次保存时刻全部作废。
 *
 * 不做这一步，「在 A 篇里排着的定时器」会在 B 篇里响 —— 存下去的是另一篇的字。
 */
function retireAutoSave() {
  cancelAutoSave();
  autoSave.gen += 1;
  autoSave.saving = false;
  autoSave.queued = false;
  autoSave.last = 0;
}

/**
 * 跑一次自动保存 —— 安静版的 `saveAll()`。
 *
 * 三件「安静」由 `saveAll({ quiet: true })` 负责（不弹提示、不重画、不替作者点确认框）；
 * 这里负责的是**不并发**（正在存就把这一发排到存完之后）和**不撒谎**：
 * 跳过了就说清为什么（标题空着、块没填完、撞上「块数暴跌」），失败了就说失败 ——
 * 静悄悄存不上，作者会一直以为一切正常，直到关掉页面。
 */
async function runAutoSave(reason = 'idle') {
  const editor = docState.editor;
  if (!editor) return;
  const gen = autoSave.gen;
  if (autoSave.saving) {
    autoSave.queued = true; // 正在存：存完补一次，别让作者这一下白敲
    return;
  }
  autoSave.saving = true;
  paintAutoSaveStatus('正在保存…', 'busy');
  try {
    const result = await saveAll({ quiet: true });
    if (gen !== autoSave.gen) return; // 页面已经切走：写盘照落，但界面不是我们管的了
    if (result?.skipped) {
      paintAutoSaveStatus(`自动保存先跳过：${result.skipped}`, 'warn');
    } else if (result?.changed) {
      autoSave.last = Date.now();
      paintAutoSaveStatus(`已自动保存 · ${clockText(autoSave.last)}`, 'ok');
    } else if (autoSave.last) {
      paintAutoSaveStatus(`已自动保存 · ${clockText(autoSave.last)}`, 'ok');
    } else {
      paintAutoSaveStatus(AUTO_SAVE_IDLE_TEXT, 'idle');
    }
  } catch (error) {
    // 页面早换了：这份响应按 `core/route-guard.js` 作废（写盘该落的已经落了）。
    if (error?.aborted) return;
    if (gen !== autoSave.gen) return;
    paintAutoSaveStatus(`自动保存失败：${error?.message ?? '未知错误'}（点「保存」重试）`, 'failed');
    console.warn(`[doc] 自动保存失败（${reason}）：`, error);
  } finally {
    autoSave.saving = false;
    if (gen === autoSave.gen) {
      autoSave.pending = false;
      if (autoSave.queued) {
        autoSave.queued = false;
        scheduleAutoSave();
      }
    }
  }
}

/**
 * 立刻存一次，不等那两个定时器。用在三处：页面要走了、标签页要藏起来了、切视图之前。
 *
 * 「页面要走」这一路是**尽力而为**：请求发出去就不再等回音（回音回来时这一页早换了，
 * 按规矩作废）。为什么不等：拦着不让作者走比丢一次自动保存更讨厌，而且「敲一下到
 * 2.5 秒」这个窗口本来就小，真没赶上还有 `beforeunload` 兜着。
 */
function flushAutoSave(reason = 'now') {
  if (!docState.editor) return null;
  if (!autoSave.pending && !hasUnsavedWork()) return null;
  cancelAutoSave();
  return runAutoSave(reason);
}

/* 关标签页 / 刷新 / 切到后台之前那几句话。
 *
 * `beforeunload` 里**只提醒、不抢救**：在那儿发请求是靠运气（浏览器随时能把这一页
 * 干掉，Safari 与移动端尤其），存一个「也许存了」的东西比明说「还没存」更坏。
 * 真要把字救下来，是 `visibilitychange` / `pagehide` 那两条的事 —— 切走标签页、
 * 手机从后台被系统杀掉，都还会给一次机会。
 */
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('beforeunload', (event) => {
    if (!hasUnsavedWork()) return undefined;
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    if (event) event.returnValue = '';
    return '';
  });
  const rescueBeforeHide = () => {
    if (!autoSave.pending && !hasUnsavedWork()) return;
    const task = flushAutoSave('hide');
    // 这一发谁都不等它：失败了也不该冒出一个未处理的 Promise（见 check-frontend 的 unhandledRejection）。
    if (task && typeof task.catch === 'function') task.catch(() => {});
  };
  window.addEventListener('visibilitychange', () => {
    if (document.hidden === true || document.visibilityState === 'hidden') rescueBeforeHide();
  });
  window.addEventListener('pagehide', rescueBeforeHide);
}

/**
 * 编辑器里的每一次敲键、每一次改下拉。
 *
 * 只认编辑器自己那几个控件（标题 / 可见范围 / 标签 / 脚本开关 / 正文文本框 / 块卡片里的字段）。
 * 两个例外：块卡片里的「源码」框**不自动存**（它是一整份 props JSON，敲到一半必然是
 * 坏 JSON），普通表单页（导入、注册块类型、脚本模板）也一概不碰。
 */
function onEditorInput(event) {
  if (!docState.editor) return;
  const target = event?.target;
  if (typeof target?.closest !== 'function') return;
  if (target.closest('[data-doc-form]')) return;
  if (target.closest('[data-doc-src-box]')) {
    paintAutoSaveStatus('源码框有改动 —— 存它请点那一块自己的「保存本块」', 'warn');
    return;
  }
  const dataset = target.dataset ?? {};
  if (!EDITOR_FIELDS.some((key) => key in dataset) && !target.closest('[data-doc-card]')) return;
  scheduleAutoSave();
}

/** 重新拉一次源码（放弃本地改动）。 */
async function reloadSource() {
  const editor = docState.editor;
  const data = await api(`/api/docs/${editor.id}`);
  absorb(data);
  toast('拿回服务端的版本了');
}

/**
 * 编辑区**左侧**那个 AI 抽屉（画它的是 `./doc-ai.js`）。
 *
 * 它只管一块地方，所以三件事都得说清楚：
 *   - **文本从哪来**：现读文本框（`currentDraft()`），不缓存 —— 作者一边打一边改，
 *     缓存必然过期，而过期的文本发给模型就是让它改一份不存在的稿子。
 *   - **结果去哪**：写回同一个文本框并 `input` 一下，让右边的实时预览跟着重画。
 *     落盘仍然是页面上那颗「保存」的事 —— 抽屉不替作者做「这次改动算数」的决定。
 *   - **模板分支**：套模板是服务端动手换块，客户端推演不出来，所以拉一次服务端版本重画。
 *
 * 积木模式**没有**这个抽屉：那儿没有一段完整文本可发，硬挂上去只会多一个不知道在改什么的框。
 */
function mountDocAiPanel(status) {
  const mount = $('[data-doc-ai]');
  if (!mount || !currentDraft()) return null;
  mdAiPanel = DocAi.mountDocAi({
    mount,
    documentId: docState.editor?.id ?? docState.viewing?.id ?? '',
    getText: () => currentDraft()?.text ?? '',
    setText: async (text, options = {}) => {
      if (options.reload) {
        // 服务端已经写盘了（套模板那条路），客户端只负责把新版本拿回来重画。
        await reloadSource();
        return;
      }
      const target = currentDraft();
      if (!target) {
        if (status) status.textContent = '这个视图没有可写的文本框 —— 切到源码模式再让 AI 改。';
        return;
      }
      target.el.value = text;
      if (typeof target.el.dispatchEvent === 'function') target.el.dispatchEvent(new Event('input'));
    },
  });
  return mdAiPanel;
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

/**
 * 「工具箱」整块去掉了（修订记录 / 导出 JSON / 导入 JSON / 删除这篇）。
 *
 * 这四件事在**阅读页**的 `docActionsHtml()` 里已经有一份（修订记录 / 导出 / 删除），
 * 编辑页再摆一遍只是多一块永远折叠在页面底部的卡片；导入那条路用得极少，
 * 却要在编辑页常驻一个空文本框。接口一律留着（`/api/docs/meta/import` 仍由
 * doc-smoke 那条「导出再导入」的用例盯着），要哪个入口再挂回来都是一行。
 */

function renderEditor() {
  const editor = docState.editor;
  const doc = editor.data.doc ?? {};
  const blocks = editor.data.blocks ?? [];
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
        <button class="btn btn-sm" type="button" data-doc-action="publish">🚀 发布</button>
        ${autoSaveStatusHtml()}
      </div>
      <div class="doc-tabs">
        <button class="doc-tab${editor.mode === 'source' ? ' doc-tab-on' : ''}" type="button" data-doc-tab="source">⚡ 源码（支持 Markdown/LaTeX）</button>
        <button class="doc-tab${editor.mode === 'blocks' ? ' doc-tab-on' : ''}" type="button" data-doc-tab="blocks">🧱 积木模式</button>
      </div>
    </div>
    ${
      editor.mode === 'source'
        ? sourceEditorHtml(editor.data.source ?? '')
        : `${blocksEditorHtml(blocks, editor.data?.doc?.kind)}${templatePanelHtml()}`
    }`;
  ensureDelegate();
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
 * 积木模式的正文：把 `collectDirtyBlocks()` 收出来的那几块写下去。
 *
 * 块仍然是一块一条 PUT（块的语义本来就独立，服务端也是这么存的），但那是实现细节：
 * 作者点「保存」时心里想的是「这一篇我改完了」，不是「b7 那个块我改完了」。
 *
 * 为什么「收」与「写」分成两步：表单值必须在**换 DOM 之前**一次读完（见 `saveAll()`
 * 里那句注释），而中间夹着好几个 `await`。分开了，读的那一步就是纯读、可以随时重来。
 */
async function putDirtyBlocks(queued) {
  const editor = docState.editor;
  let fresh = editor.data.blocks ?? [];
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
 *
 * `options.quiet` = 自动保存那一副面孔，与手动只差三处：
 *   · **不弹提示** —— 作者正打字，弹一条只会打断他；话写在那颗状态灯上；
 *   · **不重画** —— `renderEditor()` 会把编辑框连同光标和没提交的输入一起换掉；
 *   · **不替作者确认「块数暴跌」** —— 那个确认框是「这次改动算数」的决定，只有人能点，
 *     所以安静这条路上撞到 409 就原样报回去，请作者自己按「保存」。
 * 除了这三处，自动存下来的东西与手动存的**一模一样**（同一条路、同一批请求）。
 *
 * 回 `{ changed, skipped }`：`skipped` 非空 = 这一发什么都没存，且原因已经写成人话
 * （它就是拿来写进状态灯的那句话）。
 */
async function saveAll(options = {}) {
  const quiet = options.quiet === true;
  const editor = docState.editor;
  if (!editor) return { changed: false, skipped: '' };
  const doc = editor.data.doc ?? {};
  const title = ($('[data-doc-title]')?.value ?? '').trim();
  if (title === '') {
    if (!quiet) toast('标题不能为空', 'error');
    return { changed: false, skipped: '标题不能为空' };
  }
  const scope = $('[data-doc-scope]')?.value ?? doc.scope ?? 'public';
  const scriptWrite = Boolean($('[data-doc-script-write]')?.checked);
  const parsedTags = parseTags($('[data-doc-tags]')?.value ?? (doc.tags ?? []).join(', '));
  if (parsedTags.error) {
    if (!quiet) toast(parsedTags.error, 'error');
    return { changed: false, skipped: parsedTags.error };
  }
  const tags = parsedTags.tags;
  const tagsChanged = tags.join('\n') !== (doc.tags ?? []).join('\n');
  const metaChanged = title !== (doc.title ?? '') || scope !== (doc.scope ?? 'public') || tagsChanged;
  const settingsChanged = scriptWrite !== Boolean(editor.data.settings?.allowScriptWrite);
  const draft = currentDraft();
  // 表单值**一次读完**：自动保存可能正好发生在「这一页正在被换掉」的那一拍
  // （见 `leaveDocPage()`）—— 中间夹一个 await 再回来读 DOM，读到的就是下一页的 DOM 了。
  const dirty = editor.mode === 'blocks' ? collectDirtyBlocks() : { queued: [], problem: '' };
  if (dirty.problem) {
    // 有块填错了：**一块都不存**（宁可什么都不存，也不要「前三块存了、第四块没存」
    // 这种谁也说不清的状态）。自动保存连提示都不弹，原因交给状态灯。
    if (!quiet) {
      toast(dirty.problem, 'error');
      renderEditor();
    }
    return { changed: false, skipped: `有块没填完 —— ${dirty.problem}` };
  }
  // 需求 2「保存前先做判定」的前端半边：主页的块规则与服务端同源
  // （`public/core/profile-rules.js`），在这里先把不合法的形态挡掉 —— 用户不用
  // 等一个 400 才知道「名片块不能删 / 不能挪到后面」。服务端那次判定依然是**唯一权威**，
  // 这里只是把同一份规则提前算一遍。
  {
    const kind = String(doc.kind ?? '');
    const current = editor.data?.blocks ?? [];
    const next = Array.isArray(current)
      ? current.map((block) => {
          const change = dirty.queued.find((item) => item.blockId === block.blockId);
          return change ? { ...block, props: change.props } : block;
        })
      : [];
    const order = [...document.querySelectorAll('[data-doc-card]')].map((card) => card.dataset.docCard).filter(Boolean);
    const ordered = order.length
      ? order.map((blockId) => next.find((block) => block.blockId === blockId)).filter(Boolean)
      : next;
    const verdict = checkProfile({ blocks: ordered, hasDoc: kind === 'profile', title });
    if (!verdict.ok) {
      const message = profileBlockedMessage(verdict);
      if (!quiet) {
        toast(message, 'error');
        renderEditor();
      }
      return { changed: false, skipped: message };
    }
  }

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

  // 1.5) 这一页的正文要进草稿箱了：**第一次真写正文之前**登记一次。
  //      登记之后，下面的块 / Markdown 改动只落在工作副本（草稿）上，别人看到的还是上一次
  //      发布出去的那一份 ——「保存 / 自动保存只进草稿箱，点发布才生效」全靠这一句。
  //      新建时就是草稿的（`doc.draft`）不用再登记；只改标题 / 标签 / 可见范围也不必
  //      —— 那些元信息按约定是立刻生效的，不进草稿。
  const willWriteBody = dirty.queued.length > 0 || (draft && draft.text !== draft.baseline);
  if (!doc.draft && willWriteBody) {
    const entered = await api(`/api/docs/${editor.id}/draft`, { method: 'POST' });
    // 登记完就地**记住**这件事：`doc` 是打开编辑器那一刻的快照，而 `editor.data` 只在属性
    // 改动时才被服务端响应刷新，所以不记住的话每次自动保存都会再登记一遍（白发一条请求，
    // 而且「自动保存只发该发的那一条」是明确承诺过的）。
    if (editor.data?.doc) {
      editor.data.doc = { ...editor.data.doc, draft: true, published: Boolean(entered?.doc?.published ?? true) };
    }
  }

  // 2) 正文。
  let contentSaved = 0;
  if (editor.mode === 'blocks') {
    if (dirty.queued.length > 0) contentSaved = await putDirtyBlocks(dirty.queued);
  } else if (draft && draft.text !== draft.baseline) {
    if (quiet) {
      // 安静这条路不点确认框：撞上「块数暴跌」就把决定交回作者（不自作主张带 `?confirm=1` 重来）。
      try {
        await putDraft(draft.text, false);
      } catch (error) {
        if (Number(error?.status) === 409) {
          return { changed: false, skipped: '这次改动会让块数暴跌，得你点「保存」确认', conflict: true };
        }
        throw error;
      }
      contentSaved = 1;
    } else {
      const data = await withShrinkConfirm((force) => putDraft(draft.text, force));
      if (!data) {
        toast('正文没存：你在确认框里点了取消', 'error');
        renderEditor();
        return { changed: false, skipped: '你在确认框里点了取消' };
      }
      contentSaved = 1;
    }
  }

  const changed = metaChanged || settingsChanged || contentSaved > 0;
  if (quiet) return { changed, skipped: '', metaChanged, settingsChanged, contentSaved };

  // 3) 重画（本地推定「存完该长什么样」迟早对不上）。
  //    源码视图存完也一律重画：脏基线跟着服务端真存下来的那份对齐
  //   （解析是有损的：表格分隔行、嵌套列表会被改写）。
  renderEditor();

  if (!changed) {
    toast('没有改动要存');
    return { changed: false, skipped: '' };
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
  return { changed, skipped: '' };
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
  // 默认进**源码（支持 Markdown/LaTeX）**：这一轮的主编辑面是「先写字」，积木与脚本是后面才切过去的事。
  const wanted = query.get('mode') ?? 'source';
  docState.editor = {
    id,
    data,
    mode: wanted === 'blocks' ? 'blocks' : 'source',
  };
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
      draft: true,
    },
  });
  toast(`用「${item.name}」建好了一篇草稿（${html ? '小应用' : '脚本'}块），点「发布」别人才看得到`);
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
  // 打字 / 改下拉 / 勾选框：在编辑器里这些**就是**「排一次自动保存」的信号
  // （`input` 管文本框与勾选框，`change` 管下拉 —— 两个都挂上，别猜哪个控件派发哪个）。
  ui.app.addEventListener('input', onEditorInput);
  ui.app.addEventListener('change', onEditorInput);
  // 广场筛选栏里「改一下就该立刻见效」的那两颗（只勾自己 / 换标签）单独挂 —— 它们不在编辑器里。
  ui.app.addEventListener('change', onFilterChange);
  // Tab 缩进：挂在 ui.app 上而不是逐个 textarea 上 —— 积木模式的块随时插入、整页随时重画，
  // 一个个挂必然漏；委托还让源码 textarea 与每个块字段框自动共用同一套行为。
  indentTextarea(ui.app);
}

/**
 * 广场筛选栏：勾上「只看我的」、或在标签下拉里换一项，**当场**重新筛一遍，
 * 不必再点一次「筛选」。
 *
 * 搜索框不在此列：打字打到一半就跳页是骚扰，那个仍然按回车或点「筛选」。
 * 走 `requestSubmit()` 而不是自己拼参数 —— 筛选条件只该有一份实现（`onAppSubmit` 里那份）。
 */
function onFilterChange(event) {
  const target = event?.target;
  if (typeof target?.closest !== 'function') return;
  const node = target.closest('[data-doc-form="filter"] [data-doc-auto]');
  if (!node) return;
  const form = node.closest('[data-doc-form="filter"]');
  if (typeof form?.requestSubmit === 'function') form.requestSubmit();
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
  if (action === 'reply-delete') {
    if (!confirm('确定删除这条回复吗？')) return undefined;
    const replyId = Number(node.dataset.id);
    return withBusy(async () => {
      await api(`/api/replies/${replyId}`, { method: 'DELETE' });
      toast('回复已删除');
      // 重画讨论区而不是 `navigate` —— 删完要留在积木页（帖子页那边是 `Post.viewPost`）。
      await refreshDocReplies(currentId);
    });
  }
  if (action === 'repost-cancel') {
    const anchorId = Number(node.dataset.id);
    if (!confirm('撤销转发？你主页上的这条转发会消失。')) return undefined;
    // 走 core 那条 `DELETE /api/posts/:id/repost` —— 转发本来就记在影子行上，
    // 积木页不需要另开一套接口。重画而不是 `navigate`：撤销完要留在积木页。
    return withBusy(async () => {
      await api(`/api/posts/${anchorId}/repost`, { method: 'DELETE' });
      toast('已撤销转发', 'success');
      await refreshDocRepost(currentId);
    });
  }
  if (action === 'layout') {
    // 只记一个偏好，然后整页重画 —— 列表的排法不是文档的一部分。
    // 重画要用「当前这份筛选条件」，否则切一下排法就把搜的关键词丢了。
    const layout = node.dataset.layout;
    if (layout) Prefs.writePreference('forum:docsLayout', layout === 'list' ? 'list' : 'grid');
    return withBusy(() => viewDocs(docState.listQuery ?? new URLSearchParams()));
  }
  if (action === 'md') return applyMdTool(node.dataset.docMd);
  if (action === 'preview-toggle') {
    // 右边那块实时预览的开关（按钮在源码模式工具条的最右边）。
    // 状态记在 docState 上：源码模式每存一次都会整块重画，类名得能重新贴回去。
    docState.previewOff = !docState.previewOff;
    node.classList.toggle('is-off', docState.previewOff);
    node.setAttribute('aria-pressed', docState.previewOff ? 'false' : 'true');
    $('.doc-md-wrap')?.classList.toggle('is-preview-off', docState.previewOff);
    return undefined;
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
  if (action === 'save-all') {
    // 手动点「保存」：排着的那一发作废（让它跟着再存一遍只会多一条修订记录），
    // 存完把那颗灯拨到「已保存」—— 灯还停在「有改动」会让作者以为没存上。
    cancelAutoSave();
    return withBusy(async () => {
      const result = await saveAll();
      if (result?.skipped) return; // 取消 / 有块没填完：原因 `saveAll()` 已经说了，别把灯拨成「已保存」
      autoSave.last = Date.now();
      paintAutoSaveStatus(`已保存 · ${clockText(autoSave.last)}`, 'ok');
    });
  }
  if (action === 'publish') {
    // 先把手上的活儿**落到草稿**，再发布 —— 否则「打完字直接点发布」只会发出上一次的草稿，
    // 而作者以为刚写的也一起出去了。安静地存：提示留给这一发统一说，存不下就别说发布成功。
    cancelAutoSave();
    return withBusy(async () => {
      const saved = await saveAll({ quiet: true });
      if (saved.skipped) {
        toast(saved.skipped, 'error');
        return;
      }
      const published = await api(`/api/docs/${currentId}/publish`, { method: 'POST' });
      absorb(published);
      autoSave.last = Date.now();
      paintAutoSaveStatus(`已发布 · ${clockText(autoSave.last)}`, 'ok');
      toast('发布出去了，别人现在看到的就是这一版', 'success');
    });
  }
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
        // 标签可能是从卡片上点进来的（下拉里会补出当前这一项），也可能是下拉里选的：
        // 不清空它，否则「在某个标签里搜标题」一按筛选就变回全站了。
        if (values.tag) params.set('tag', values.tag);
        return navigate(`/docs${params.toString() ? `?${params}` : ''}`);
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
      if (form.dataset.docForm === 'reply') {
        const anchorId = Number(form.dataset.id);
        const content = String(values.content ?? '').trim();
        if (!content) return toast('回复不能是空的', 'error');
        // 发到 core 那条 `POST /api/posts/:id/replies` 上：回复存在**影子行**那条帖子上
        //（见 `src/modules/doc/routes.js` 里互动锚点的注释），所以积木页不需要另开一套
        // `/api/docs/:id/replies`。能不能发由后端判（它认锁定与登录状态），前端只管画。
        const result = await api(`/api/posts/${anchorId}/replies`, { method: 'POST', body: { content } });
        toast('回复成功');
        await refreshDocReplies(docState.editor ? docState.editor.id : docState.viewing);
        const node = document.getElementById(`reply-${result.reply.id}`);
        if (node) node.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return undefined;
      }
      if (form.dataset.docForm === 'repost') {
        const anchorId = Number(form.dataset.id);
        const comment = String(values.comment ?? '').trim();
        // 复用 core 的转发接口（转发记在影子行上），只是发完不跳页。
        // 转发语可以留空 —— 「直接转发」是一种正常用法，别在这里拦。
        const result = await api(`/api/posts/${anchorId}/repost`, { method: 'POST', body: { comment } });
        toast(result.updated ? '转发语已更新' : '转发成功：已经发到动态流，你主页的「🔁 转发」里也有一条', 'success');
        await refreshDocRepost(docState.editor ? docState.editor.id : docState.viewing);
        return undefined;
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
 * 编辑器里的两个视图页签。
 *
 * 切之前先 `flushDraft()`：这样「源码里写一半 → 切过去拼积木 → 再切回来」
 * 一路都不会丢东西，而且积木/源码视图看到的是**服务端解析出来**的那份。
 * 作者在「块数暴跌」的确认框上点了取消，就原地不动 —— 半途切走会让他以为改动没了。
 */
async function onTabClick(mode) {
  const editor = docState.editor;
  if (!editor || editor.mode === mode) return;
  try {
    if (!(await flushDraft())) return;
    // 排着的那一发也算「这一段写完了」：积木模式没有文本草稿这条线，脏块只有靠自动保存
    // 才存得下去 —— 而换掉 DOM 之后就读不到那些表单值了。先让它跑完，再切。
    if (autoSave.pending || autoSave.saving) await runAutoSave('tab');
    cancelAutoSave();
    editor.mode = mode;
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
