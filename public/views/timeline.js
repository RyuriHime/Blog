// 动态时间线（P1）。
//
// 地址是 `#/feed`（m05506 起）：`#/` 让给了起始页，这里从首页搬到了后缀地址。
//   这一页本身没变 —— 还是一行行按时间倒序的动态流，不再显示「板块 + 帖子列表」。
//   老链接 `#/?filter=mine` 之类跟着变成 `#/feed?filter=…`。
//
// 三条设计约束来自需求文档（01-需求规格说明书.md §5.2）：
//   FR-FEED-09 没有专用编辑界面 —— 发布入口就是页面顶部的**内联纯编辑框**，不跳页
//   FR-FEED-10 编辑框仍要 Markdown + LaTeX 实时预览，可以展开全屏，但**还是同一个框**
//   FR-FEED-08 可见范围由服务端强制过滤，前端只负责把选项画出来
//
// 事件绑定方式：**不进 `public/core/events.js` 那个中央 switch**，
// 改成对 `ui.app` 做一次性委托 + `data-feed-*` 属性。
// 这是跟 `public/views/notes.js` 学的做法：
// 中央 switch 被 `scripts/check-ui-contract.mjs` 盯着，动态的控件又天天变，
// 分开放两边就不用每次改控件都去动那个文件。
import { $, esc, emptyHtml, loadingHtml, toast, ui } from '../core/dom.js';
import { api, withButtonBusy } from '../core/api.js';
import { toastError, apiErrorText } from '../core/errors.js';
import { state } from '../core/state.js';
import { navigate, routeQuery } from '../core/router.js';
import * as Avatar from '../core/avatar.js';
import * as Fmt from '../core/format.js';
import { paginationHtml } from '../core/widgets.js';
import { ntRenderMath } from './notes.js';

/*
 * 关于配图压缩：**没有**复用 `./compose.js` 的 `compressImageFile`。
 * 那个函数是给头像写的 —— 它先算 `side = Math.min(width, height)` 再居中裁剪，
 * 出来的永远是正方形。动态配图是内容，横图会被拦腰砍掉两边。
 * 所以本文件自己实现 `prepareFeedImage`：保持长宽比、逐步降质、必要时缩尺寸。
 */

const MAX_IMAGE_BYTES = 256 * 1024;
const MAX_IMAGE_SIDE = 1280;
const MAX_IMAGES = 9;
/**
 * 回复正文上限，**必须与服务端 `MAX_FEED_REPLY_CONTENT` 一致**
 * （`src/modules/feed/schema.js`）。前端这个 `maxlength` 只是提前拦住，
 * 真判还是服务端说了算。
 */
const MAX_REPLY = 2000;

/**
 * 转发语上限，同样**必须与服务端一致**（`MAX_FEED_REPOST_COMMENT`）。
 * 这个 300 跟帖子那条转发接口是同一个数 —— 同一件事不该有两个规矩。
 */
const MAX_REPOST_COMMENT = 300;

/** 兜底的范围选项：正常应该用服务端 `GET /api/feed` 返回的 `scopes`。 */
const FALLBACK_SCOPES = [
  { value: 'public', label: '公开' },
  { value: 'followers', label: '仅关注我的人' },
  { value: 'team', label: '仅团队' },
  { value: 'private', label: '仅自己' },
];

const SCOPE_ICON = { public: '🌍', followers: '👥', team: '🎽', private: '🔒' };

/**
 * 编辑框与列表的**模块级**状态。
 *
 * 放在模块级而不是每次渲染重建，是因为「展开全屏」「预览开了一半」这类中间状态
 * 必须扛得住重新渲染 —— 否则每次点赞刷新一下，用户正在写的字就没了。
 */
const composerState = {
  images: [],
  ref: null,
  fullscreen: false,
  preview: false,
  scopes: FALLBACK_SCOPES,
  /**
   * 草稿正文与选中的可见范围。
   *
   * 必须是模块级状态：`renderShell()` 会把整个 composer 重新 innerHTML 一遍，
   * 而**点赞不会重画、但「取消编辑」「保存」「删除」都会重画外壳** ——
   * 用户如果正在框里写字，重画一次字就没了。这条以前踩过。
   */
  draft: '',
  scope: 'public',
  /** 「引用帖子」那行输入框里没提交的编号/链接（同上：重画不能丢）。 */
  refInput: '',
};
/** 当前列表里每条动态的**原始**数据，编辑时要用回原文（渲染后的是 HTML，改不了）。 */
const itemCache = new Map();
let feedFilter = 'all';
let feedQuery = '';

// ── 图片处理 ────────────────────────────────────────────────────────────

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onerror = () => reject(new Error('这个文件不是有效的图片'));
    image.onload = () => resolve(image);
    image.src = dataUrl;
  });
}

function byteLengthOfDataUrl(dataUrl) {
  const comma = dataUrl.indexOf(',');
  return Math.round((dataUrl.length - comma - 1) * 0.75);
}

/**
 * 把用户选的图片压到 256 KB 以内，**保持长宽比**。
 *
 * 与头像那套的区别就在「保持长宽比」：头像是圆的，裁成正方形没损失；
 * 动态配图是内容，裁掉就是丢信息。
 */
async function prepareFeedImage(file) {
  if (!file.type.startsWith('image/')) throw new Error('只能选图片文件');
  // 本来就够小、格式也合适（png / webp 能保住透明通道）就不动它
  if (file.size <= MAX_IMAGE_BYTES && /^image\/(png|webp|jpeg)$/.test(file.type)) {
    return await readAsDataUrl(file);
  }

  const source = await loadImage(await readAsDataUrl(file));
  let scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(source.width, source.height));

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(source.width * scale));
    canvas.height = Math.max(1, Math.round(source.height * scale));
    canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);

    for (let quality = 0.85; quality >= 0.45; quality -= 0.1) {
      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      if (byteLengthOfDataUrl(dataUrl) <= MAX_IMAGE_BYTES) return dataUrl;
    }
    scale *= 0.7; // 画质压到底还是太大，就整体缩小再来一轮
  }
  throw new Error('这张图压不到 256 KB 以内，换一张小一点的吧');
}

/** 上传一张图，返回服务端给的 `{ url, bytes, type }`。 */
async function uploadFeedImage(dataUrl) {
  const result = await api('/api/feed/images', { method: 'POST', body: { dataUrl } });
  return result;
}

// ── 片段渲染 ────────────────────────────────────────────────────────────

function scopeOptionsHtml(selected) {
  return composerState.scopes
    .map(
      (scope) =>
        `<option value="${esc(scope.value)}" ${scope.value === selected ? 'selected' : ''}>${SCOPE_ICON[scope.value] ?? ''} ${esc(scope.label)}</option>`,
    )
    .join('');
}

function refChipHtml() {
  if (!composerState.ref) return '';
  const { id, title } = composerState.ref;
  return `<span class="feed-ref-chip">🔗 引用 #${id}：${esc(title)}
    <button class="icon-btn" type="button" data-feed-action="clear-ref" title="取消引用">✕</button></span>`;
}

function composerImagesHtml() {
  if (!composerState.images.length) return '';
  return composerState.images
    .map(
      (image, index) => `
      <figure class="feed-thumb">
        <img src="${esc(image.url)}" alt="配图 ${index + 1}" />
        <button class="icon-btn" type="button" data-feed-action="remove-image" data-index="${index}" title="移除">✕</button>
      </figure>`,
    )
    .join('');
}

/**
 * 内联编辑框。
 *
 * 未登录时不画输入框，改成一句「登录后可以发动态」—— 需求里「任何登录用户可随时发布」
 * 的补集是「没登录的人不能发」，那就别装出一个点了会 401 的按钮。
 */
function composerHtml() {
  if (!state.me) {
    return `<div class="card feed-composer feed-composer-guest">
      <div class="hint">登录后就能在这里发动态了。</div>
      <div class="form-actions">
        <a class="btn btn-sm btn-primary" href="#/login">登录</a>
        <a class="btn btn-sm" href="#/register">注册</a>
      </div>
    </div>`;
  }
  const full = composerState.fullscreen ? ' is-fullscreen' : '';
  return `<div class="card feed-composer${full}" data-feed-composer>
    <div class="composer-row">
      <span class="composer-avatar">${Avatar.avatarHtml(state.me, 'avatar-sm')}</span>
      <textarea class="composer-input" data-feed-input rows="3"
        placeholder="说点什么……支持 Markdown 和 $LaTeX$，@ 用户名可以提醒 TA">${esc(composerState.draft)}</textarea>
    </div>
    <div class="composer-ref-row" data-feed-ref-row ${composerState.ref ? '' : 'hidden'}>
      <input class="input" data-feed-ref-input value="${esc(composerState.refInput)}" placeholder="粘贴帖子链接或编号，回车确认" />
      <span data-feed-ref-chip>${refChipHtml()}</span>
    </div>
    <div class="composer-images" data-feed-images>${composerImagesHtml()}</div>
    <div class="composer-preview md" data-feed-preview hidden></div>
    <div class="composer-tools">
      <label class="btn btn-sm composer-file">🖼 图片
        <input type="file" accept="image/*" multiple hidden data-feed-file />
      </label>
      <button class="btn btn-sm" type="button" data-feed-action="mention" title="插入 @，被提到的人会收到通知">@ 提醒</button>
      <button class="btn btn-sm" type="button" data-feed-action="ref">🔗 引用帖子</button>
      <button class="btn btn-sm" type="button" data-feed-action="preview">👁 预览</button>
      <button class="btn btn-sm" type="button" data-feed-action="fullscreen">⛶ 全屏</button>
      <span class="composer-spacer"></span>
      <select class="input composer-scope" data-feed-scope title="谁可以看到这条动态">
        ${scopeOptionsHtml(composerState.scope)}
      </select>
      <button class="btn btn-sm btn-primary" type="button" data-feed-action="publish">发布</button>
    </div>
  </div>`;
}

function feedItemHtml(item) {
  const mine = state.me && state.me.id === item.author.id;
  const images = item.images?.length
    ? `<div class="feed-images">${item.images
        .map(
          (image, index) =>
            `<img src="${esc(image.url)}" alt="配图 ${index + 1}" loading="lazy"
               class="feed-image" data-feed-action="zoom" data-src="${esc(image.url)}" data-index="${index}" />`,
        )
        .join('')}</div>`
    : '';

  /*
   * 站内帖子卡片（`item.ref`）。两种来源长得一样，只有当事人知道自己点的是哪颗按钮：
   * 「🔁 转发」和「🔗 引用」都是往动态里放一张指向该帖子的卡（都是 `ref_post_id`），
   * 区别是转发还在 `reposts` 里留了一条（个人主页的「🔁 转发」分类认那条）。
   * 服务端用 `ref.repost` 把这件事告诉前端，见 `src/modules/feed/shape.js`。
   */
  const ref = item.ref
    ? `<a class="feed-ref" href="#/post/${item.ref.id}">
         <span class="feed-ref-label">${item.ref.repost ? '🔁 转发了帖子' : '🔗 引用了帖子'}</span>
         <span class="feed-ref-title">${esc(item.ref.title)}</span>
         <span class="feed-ref-author">${esc(item.ref.author.displayName || item.ref.author.username)}</span>
       </a>`
    : '';

  /*
   * 被转发的原动态。和 `ref`（引用了帖子）长得像，但**不是链接** ——
   * 动态没有自己的详情页，点进去无处可去。原动态被删了就只留一句话：
   * 转发语是转发的人当时说的话，不该跟着原动态一起消失。
   */
  const refFeed = item.refFeed
    ? `<div class="feed-ref feed-ref-feed">
         <span class="feed-ref-label">🔁 转发了动态</span>
         ${
           item.refFeed.deleted
             ? '<span class="feed-ref-title">原动态已删除</span>'
             : `<span class="feed-ref-author">${esc(
                 item.refFeed.author?.displayName || item.refFeed.author?.username || '（作者已注销）',
               )}</span>
                <div class="feed-ref-body md">${item.refFeed.contentHtml}</div>`
         }
       </div>`
    : '';

  /*
   * 只有「公开的」动态能转发（服务端会回 403 repost_scope）。
   * 自己的动态**也**能转 —— 转出去就是一条引用自己的新动态，等于自己给自己带一句评语。
   * 不能转的时候画成一个静态计数，**不画一颗点了会报错的按钮** ——
   * 「点了没反应 / 点了弹错误」正是前面几轮一直在修的那类毛病。
   */
  const canRepost = item.scope === 'public';
  const repostBlock = canRepost
    ? `<button class="react-btn ${item.reposted ? 'is-on' : ''}" type="button"
        data-feed-action="repost" data-id="${item.id}"
        title="${item.reposted ? '撤销我的转发' : '转发到我的动态流'}">
        🔁 <span data-feed-reposts="${item.id}">${Fmt.fmtNum(item.repostCount)}</span>
      </button>`
    : `<span class="react-btn is-static" title="只有公开的动态能转发">
        🔁 <span data-feed-reposts="${item.id}">${Fmt.fmtNum(item.repostCount)}</span>
      </span>`;

  const tools = mine
    ? `<span class="feed-own">
         <button class="icon-btn" type="button" data-feed-action="edit" data-id="${item.id}" title="编辑">✏️</button>
         <button class="icon-btn" type="button" data-feed-action="delete" data-id="${item.id}" title="删除">🗑</button>
       </span>`
    : '';

  return `<article class="card feed-item" data-feed-item="${item.id}">
    <header class="feed-head">
      <a class="feed-author" href="#/u/${esc(item.author.username)}">
        ${Avatar.avatarHtml(item.author, 'avatar-sm')}
        <span class="feed-author-name">${esc(item.author.displayName || item.author.username)}</span>
      </a>
      <span class="feed-meta">
        <span class="feed-scope" title="${esc(item.scopeLabel)}">${SCOPE_ICON[item.scope] ?? ''}</span>
        <span title="${esc(new Date(item.createdAt).toLocaleString())}">${Fmt.timeAgo(item.createdAt)}</span>
        ${item.edited ? '<span class="hint">已编辑</span>' : ''}
        ${tools}
      </span>
    </header>
    <div class="feed-body md" data-feed-body>${item.contentHtml}</div>
    ${images}
    ${ref}
    ${refFeed}
    <footer class="feed-foot">
      <button class="react-btn ${item.liked ? 'is-on' : ''}" type="button"
        data-feed-action="react" data-id="${item.id}" data-kind="like">
        👍 <span data-feed-like="${item.id}">${Fmt.fmtNum(item.likeCount)}</span>
      </button>
      <button class="react-btn ${item.disliked ? 'is-on' : ''}" type="button"
        data-feed-action="react" data-id="${item.id}" data-kind="dislike">
        👎 <span data-feed-dislike="${item.id}">${Fmt.fmtNum(item.dislikeCount)}</span>
      </button>
      <button class="react-btn" type="button"
        data-feed-action="replies" data-id="${item.id}" title="展开回复">
        💬 <span data-feed-replies="${item.id}">${Fmt.fmtNum(item.replyCount)}</span>
      </button>
      ${repostBlock}
    </footer>
    <div class="feed-repost" data-feed-repost-box="${item.id}" hidden></div>
    <div class="feed-replies" data-feed-replies-box="${item.id}" hidden></div>
  </article>`;
}

/**
 * 一条动态回复。
 *
 * 删除权限与帖子回复同一套口径：回复本人、动态作者、管理员都能删
 * （服务端 `DELETE /api/feed/:id/replies/:replyId` 也是这么判的，
 * 这里只是别把按不动的按钮画出来）。
 */
function feedReplyHtml(reply, item) {
  const mine =
    state.me && (state.me.id === reply.author.id || state.me.id === item.author.id || Fmt.isStaffUser(state.me));
  return `<div class="feed-reply" id="feed-reply-${reply.id}">
    ${Avatar.avatarHtml(reply.author)}
    <div class="feed-reply-body">
      <div class="feed-reply-head">
        <a class="feed-reply-author" href="#/u/${encodeURIComponent(reply.author.username)}">${esc(reply.author.displayName || reply.author.username)}</a>
        <span class="feed-reply-time" title="${esc(new Date(reply.createdAt).toLocaleString())}">${Fmt.timeAgo(reply.createdAt)}</span>
        ${
          mine
            ? `<button class="link-btn" type="button" data-feed-action="reply-delete" data-id="${item.id}" data-reply="${reply.id}">删除</button>`
            : ''
        }
      </div>
      <div class="md">${reply.contentHtml}</div>
    </div>
  </div>`;
}

function feedRepliesHtml(item, data) {
  const replies = data?.replies ?? [];
  const list = replies.length
    ? replies.map((reply) => feedReplyHtml(reply, item)).join('')
    : emptyHtml('💭', '还没有人回复', '说点什么吧');
  const form = state.me
    ? `<form class="feed-reply-form" data-feed-reply-form data-id="${item.id}">
         <textarea class="input" name="content" rows="2" maxlength="${MAX_REPLY}" required
           placeholder="写下你的回复…（支持 Markdown 与 LaTeX）"></textarea>
         <div class="feed-reply-actions">
           <button class="btn btn-sm btn-primary" type="submit">回复</button>
         </div>
       </form>`
    : '<div class="hint">登录后就能回复。</div>';
  return `<div class="feed-replies-head">💬 回复（${Fmt.fmtNum(data?.replyCount ?? replies.length)}）</div>${list}${form}`;
}

function feedListEmptyHtml() {
  if (feedQuery) return `<div class="card">${emptyHtml('🔍', `没有找到含「${esc(feedQuery)}」的动态`, '换个词试试')}</div>`;
  if (feedFilter === 'following') return `<div class="card">${emptyHtml('👥', '关注的人还没发过动态', '去首页看看大家在聊什么')}</div>`;
  if (feedFilter === 'mine') return `<div class="card">${emptyHtml('📝', '你还没发过动态', '上面的框里写一句就有了')}</div>`;
  return `<div class="card">${emptyHtml('🌱', '这里还很安静', '成为第一个发动态的人吧')}</div>`;
}

function filterTabsHtml() {
  const tabs = [
    ['all', '全部'],
    ['following', '我关注的'],
    ['mine', '我的'],
  ];
  return `<div class="feed-tabs">${tabs
    .map(
      ([value, label]) =>
        `<a class="feed-tab ${feedFilter === value ? 'is-active' : ''}" href="${esc(routeQuery('/', new Map(), { filter: value === 'all' ? null : value }))}">${label}</a>`,
    )
    .join('')}</div>`;
}

// ── 主视图 ──────────────────────────────────────────────────────────────

/**
 * 动态流页（`#/feed`，也是 `#/search` 的去处）：一条按时间倒序的动态流。
 *
 * 先画骨架再取数，是为了让「刷新」不闪白屏；同时把 composer 的状态保住。
 */
async function viewTimeline(query = new Map()) {
  feedFilter = query.get('filter') || 'all';
  feedQuery = (query.get('q') || '').trim();
  const page = Math.max(1, Number(query.get('page') || 1));

  renderShell();
  const params = new URLSearchParams({ filter: feedFilter, page: String(page) });
  if (feedQuery) params.set('q', feedQuery);

  let data;
  try {
    data = await api(`/api/feed?${params.toString()}`);
  } catch (error) {
    if (error?.aborted) return; // 页面已经切走了，别往新页面上画错误卡
    const text = apiErrorText(error);
    if (!text) return; // 已经处理过（例如已跳登录页）
    const host = $('[data-feed-list]');
    if (host) host.innerHTML = `<div class="card">${emptyHtml('😵', text)}</div>`;
    return;
  }

  if (Array.isArray(data.scopes) && data.scopes.length) composerState.scopes = data.scopes;
  itemCache.clear();
  for (const item of data.items) itemCache.set(item.id, item);

  const list = $('[data-feed-list]');
  if (!list) return; // 期间用户又点了别处，别往一个已经不存在的节点里写
  list.innerHTML = data.items.length ? data.items.map(feedItemHtml).join('') : feedListEmptyHtml();

  const pager = $('[data-feed-pager]');
  if (pager) {
    pager.innerHTML = paginationHtml(data.page, data.totalPages, (target) =>
      routeQuery('/', query, { page: target === 1 ? null : String(target) }),
    );
  }

  // 公式渲染必须在 innerHTML 之后 —— renderMathInElement 只处理**已经在 DOM 里**的节点
  ntRenderMath(list);
}

/** 只重画「外壳」（composer + 标签 + 列表容器），列表内容由调用方填。 */
function renderShell() {
  ui.app.innerHTML = `
    ${composerHtml()}
    ${feedQuery ? `<div class="card card-tight feed-searchbar">搜索「${esc(feedQuery)}」<a class="tag" href="#/feed">清空</a></div>` : ''}
    ${filterTabsHtml()}
    <div class="feed-stream" data-feed-list>${loadingCardsHtml()}</div>
    <div data-feed-pager></div>`;
  restoreComposer();
  bindTimelineOnce();
}

function loadingCardsHtml() {
  return '<div class="card"><div class="hint">正在加载动态……</div></div>';
}

/**
 * 把模块级状态写回 DOM。
 *
 * 每次重画外壳都要调一次，否则 composerState 里的图 / 引用 / 全屏标记
 * 会跟 DOM 脱节（用户发了一张图，一点点赞刷新就看不见那张图了）。
 */
function restoreComposer() {
  const composer = $('[data-feed-composer]');
  if (!composer) return;

  /*
   * 正文与可见范围**已经由 composerHtml() 写进新画出来的 HTML 里了**
   * （`<textarea>${esc(draft)}</textarea>`、`scopeOptionsHtml(composerState.scope)`），
   * 所以正常情况下这里不用再补一刀。仍然写回一次是为了兜住
   * 「HTML 属性转义后与原值不完全相等」这类边角，代价只有一次比较。
   */
  const input = $('[data-feed-input]');
  if (input && input.value !== composerState.draft) input.value = composerState.draft;

  const scope = $('[data-feed-scope]');
  if (scope) scope.value = composerState.scope;

  const refInput = $('[data-feed-ref-input]');
  if (refInput && refInput.value !== composerState.refInput) refInput.value = composerState.refInput;

  if (composerState.images.length) {
    const box = $('[data-feed-images]');
    if (box) box.innerHTML = composerImagesHtml();
  }
  // chip 无论有没有引用都要重画：refChipHtml() 在 ref 为空时返回空串，
  // 正好把上一次引用留下的标题一起清掉。以前只在有引用时才写，于是点了
  // 「取消引用」之后那个标题还挂在那里，看起来像没清掉。
  const chip = $('[data-feed-ref-chip]');
  if (chip) chip.innerHTML = refChipHtml();
  if (composerState.ref) {
    const row = $('[data-feed-ref-row]');
    if (row) row.hidden = false;
  }
  // 预览开着就得重新渲染：新 DOM 里的预览框永远是 hidden 且空的
  if (composerState.preview) void syncPreview();
}

// ── 交互 ────────────────────────────────────────────────────────────────

let bound = false;

/**
 * 事件委托只绑一次。
 *
 * 绑在 `ui.app`（#app）上而不是每条动态上：这个节点是 `public/index.html` 里的静态节点，
 * 内容被反复重画也不会消失，所以监听器不用跟着重建。
 */
function bindTimelineOnce() {
  if (bound) return;
  bound = true;

  ui.app.addEventListener('click', (event) => {
    const node = event.target.closest('[data-feed-action]');
    if (!node) return;
    const action = node.dataset.feedAction;
    // 全屏框里的按钮有些是 <label> 包着 file input，点 label 不要拦
    if (action === 'zoom') {
      event.preventDefault();
      openLightbox(node.dataset.src);
      return;
    }
    event.preventDefault();
    handleAction(action, node).catch((error) => toastError(error));
  });

  ui.app.addEventListener('submit', (event) => {
    if (event.target.matches('[data-feed-ref-row]')) {
      event.preventDefault();
      return;
    }
    const replyForm = event.target.closest('[data-feed-reply-form]');
    if (replyForm) {
      event.preventDefault();
      submitReply(replyForm).catch((error) => toastError(error));
      return;
    }
    const repostForm = event.target.closest('[data-feed-repost-form]');
    if (!repostForm) return;
    event.preventDefault();
    submitRepost(repostForm).catch((error) => toastError(error));
  });

  // 引用帖子：回车确认
  ui.app.addEventListener('keydown', (event) => {
    if (!event.target.matches('[data-feed-ref-input]')) return;
    if (event.key !== 'Enter') return;
    event.preventDefault();
    resolveRefInput(event.target).catch((error) => toastError(error));
  });

  // 草稿正文 / 引用编号 / 可见范围：同步进模块级状态，否则外壳一重画就丢
  ui.app.addEventListener('input', (event) => {
    if (event.target.matches('[data-feed-input]')) composerState.draft = event.target.value;
    if (event.target.matches('[data-feed-ref-input]')) composerState.refInput = event.target.value;
  });

  // 图片选择
  ui.app.addEventListener('change', (event) => {
    if (event.target.matches('[data-feed-scope]')) {
      composerState.scope = event.target.value;
      return;
    }
    if (!event.target.matches('[data-feed-file]')) return;
    pickImages(event.target).catch((error) => toastError(error));
  });
}

async function handleAction(action, node) {
  switch (action) {
    case 'publish':
      return await publish(node);
    case 'mention':
      return insertAtCursor('@');
    case 'ref':
      return toggleRefRow();
    case 'clear-ref':
      composerState.ref = null;
      return restoreComposer();
    case 'preview':
      return await togglePreview();
    case 'fullscreen':
      return toggleFullscreen();
    case 'remove-image':
      composerState.images.splice(Number(node.dataset.index), 1);
      return restoreComposer();
    case 'react':
      return await react(node);
    case 'replies':
      return await toggleReplies(node);
    case 'reply-delete':
      return await removeReply(node);
    case 'repost':
      return await toggleRepost(node);
    case 'repost-cancel':
      return await removeRepost(node);
    case 'edit':
      return startEdit(Number(node.dataset.id));
    case 'cancel-edit':
      return cancelEdit(node);
    case 'save-edit':
      return await saveEdit(node);
    case 'delete':
      return await removeItem(Number(node.dataset.id));
    default:
      return undefined;
  }
}

function currentQuery() {
  const params = new URLSearchParams();
  if (feedQuery) params.set('q', feedQuery);
  if (feedFilter !== 'all') params.set('filter', feedFilter);
  return params;
}

function composerInput() {
  return $('[data-feed-input]');
}

function insertAtCursor(text) {
  const input = composerInput();
  if (!input) return;
  const start = input.selectionStart ?? input.value.length;
  input.value = `${input.value.slice(0, start)}${text}${input.value.slice(input.selectionEnd ?? start)}`;
  const caret = start + text.length;
  input.focus();
  input.setSelectionRange(caret, caret);
  // 直接改 value 不会触发 input 事件，草稿状态得自己同步
  composerState.draft = input.value;
}

function toggleRefRow() {
  const row = $('[data-feed-ref-row]');
  if (!row) return;
  row.hidden = !row.hidden;
  if (!row.hidden) $('[data-feed-ref-input]')?.focus();
}

/** 从「帖子链接 / #/post/12 / 12」里抠出编号 —— 让人可以直接粘贴地址栏。 */
function parsePostId(value) {
  const text = String(value || '').trim();
  const fromHash = text.match(/#\/post\/(\d+)/);
  if (fromHash) return Number(fromHash[1]);
  const fromUrl = text.match(/\/api\/posts\/(\d+)/);
  if (fromUrl) return Number(fromUrl[1]);
  if (/^\d+$/.test(text)) return Number(text);
  return null;
}

async function resolveRefInput(input) {
  const id = parsePostId(input.value);
  if (!id) throw new Error('看不懂这个地址，粘贴帖子链接或直接填编号');
  const post = await api(`/api/posts/${id}`);
  composerState.ref = { id: post.post.id, title: post.post.title };
  // 用掉的编号必须连**状态**一起清掉：只清 DOM 的话，下一次重画
  // restoreComposer() 又会把这个编号写回输入框，用户以为自己没提交成功。
  composerState.refInput = '';
  input.value = '';
  input.closest('[data-feed-ref-row]').hidden = true;
  restoreComposer();
  toast(`已引用《${composerState.ref.title}》`, 'success');
}

async function pickImages(input) {
  const files = [...(input.files ?? [])];
  input.value = ''; // 允许连续选同一个文件
  if (!files.length) return;
  const room = MAX_IMAGES - composerState.images.length;
  if (room <= 0) throw new Error(`一条动态最多 ${MAX_IMAGES} 张图`);

  for (const file of files.slice(0, room)) {
    const dataUrl = await prepareFeedImage(file);
    const uploaded = await uploadFeedImage(dataUrl);
    composerState.images.push({ url: uploaded.url });
    restoreComposer();
  }
  if (files.length > room) toast(`只加了前 ${room} 张，一条动态最多 ${MAX_IMAGES} 张`, 'error');
}

/**
 * 把当前草稿渲染进预览框。
 *
 * 单独抽出来是因为它有两个入口：点「👁 预览」时，以及**外壳被重画之后**
 * （重画会换掉预览框这个 DOM 节点，不重新渲染就等于预览凭空关掉了）。
 */
async function syncPreview() {
  const box = $('[data-feed-preview]');
  if (!box) return;
  box.hidden = !composerState.preview;
  if (!composerState.preview) return;

  const text = (composerInput()?.value ?? '').trim();
  if (!text) {
    box.innerHTML = '<div class="hint">还没写内容</div>';
    return;
  }
  box.innerHTML = '<div class="hint">正在渲染……</div>';
  const result = await api('/api/markdown/preview', { method: 'POST', body: { content: text } });
  box.innerHTML = result.html;
  ntRenderMath(box);
}

async function togglePreview() {
  composerState.preview = !composerState.preview;
  await syncPreview();
}

/** 展开全屏：只加一个 class，**同一个 textarea 还在原处**，不跳页、不重建元素。 */
function toggleFullscreen() {
  composerState.fullscreen = !composerState.fullscreen;
  const composer = $('[data-feed-composer]');
  if (!composer) return;
  composer.classList.toggle('is-fullscreen', composerState.fullscreen);
  document.body.classList.toggle('feed-fullscreen', composerState.fullscreen);
  if (composerState.fullscreen) composerInput()?.focus();
}

async function publish(button) {
  const input = composerInput();
  if (!input) return;
  const content = input.value;
  await withButtonBusy(button, async () => {
    const result = await api('/api/feed', {
      method: 'POST',
      body: {
        content,
        scope: composerState.scope,
        images: composerState.images,
        refPostId: composerState.ref?.id ?? null,
      },
    });
    // 发完清空**全部**草稿状态，否则下一条会莫名其妙带着上一条的字、图和引用
    composerState.draft = '';
    composerState.images = [];
    composerState.ref = null;
    composerState.refInput = '';
    composerState.preview = false;
    composerState.fullscreen = false;
    composerState.scope = 'public';
    document.body.classList.remove('feed-fullscreen');
    toast('发布成功', 'success');
    await viewTimeline(currentQuery());
    void result;
  });
}

async function react(node) {
  const id = Number(node.dataset.id);
  const kind = node.dataset.kind;
  const item = itemCache.get(id);
  // ⚠️ 别在这儿自己判断「已经赞过了就发个 null 去取消」。
  //
  // 服务端 `queries.setReaction()` 的语义本来就是「再点一次同一个 = 取消，换一个 = 改判」，
  // 但它**只认 `'like'` / `'dislike'` 两个字面量**（`src/modules/feed/routes.js` 的 bad_kind
  // 校验）。这里递个 null 过去只会换回 400 和一句「只支持「赞」或「踩」」——
  // 用户看到的现象是「手滑点错了取消不掉」。照原样把 kind 发过去，取不取消由服务端说了算。
  const result = await api(`/api/feed/${id}/reaction`, { method: 'POST', body: { kind } });

  const likeNode = $(`[data-feed-like="${id}"]`);
  const dislikeNode = $(`[data-feed-dislike="${id}"]`);
  if (likeNode) likeNode.textContent = Fmt.fmtNum(result.likeCount);
  if (dislikeNode) dislikeNode.textContent = Fmt.fmtNum(result.dislikeCount);
  node.closest('.feed-item')?.querySelectorAll('[data-feed-action="react"]').forEach((other) => {
    const otherKind = other.dataset.kind;
    other.classList.toggle('is-on', otherKind === 'like' ? result.liked : result.disliked);
  });
  if (item) Object.assign(item, result);
}

/**
 * 「转发」那一小块的内容。
 *
 * 已经转过就只给一个「撤销转发」——再点一次是改转发语，而改转发语的入口应该是
 * 「打开就看见原来的话」，不是让用户对着空框重打一遍。
 * （服务端 `POST /api/feed/:id/repost` 遇到已转过的情况就是更新，不新增第二条。）
 */
function feedRepostHtml(item) {
  if (item.reposted) {
    return `<div class="feed-repost-inner">
      <div class="hint">你已经转发了这条。</div>
      <div class="feed-repost-actions">
        <button class="btn btn-sm" type="button" data-feed-action="repost-cancel" data-id="${item.id}">撤销转发</button>
      </div>
    </div>`;
  }
  return `<form class="feed-repost-form" data-feed-repost-form data-id="${item.id}">
    <textarea class="input" name="comment" rows="2" maxlength="${MAX_REPOST_COMMENT}"
      placeholder="说点什么…（可以留空，直接转发）"></textarea>
    <div class="hint">转发出去就是一条新动态，会出现在你的动态流（「全部」/「我的」）里；原动态底下会多一个转发数。</div>
    <div class="feed-repost-actions">
      <button class="btn btn-sm btn-primary" type="submit">转发</button>
    </div>
  </form>`;
}

/**
 * 展开 / 收起转发那一块。
 *
 * 不预先把输入框塞进每张卡片：一页 20 条动态就是 20 个 textarea，
 * 既拖慢首屏，也会让页面上出现 20 个同名输入框。
 */
function toggleRepost(node) {
  const id = Number(node.dataset.id);
  const item = itemCache.get(id);
  const box = $(`[data-feed-repost-box="${id}"]`);
  if (!item || !box) return;
  if (!box.hidden) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.innerHTML = feedRepostHtml(item);
}

/**
 * 只重画「🔁 计数 + 那颗按钮 + 转发盒子」这三处，**不动整张卡片** ——
 * 卡片里可能正开着回复框、正列着别人的回复，整卡重画会把它们收掉。
 */
function paintRepostState(item) {
  const count = $(`[data-feed-reposts="${item.id}"]`);
  if (count) count.textContent = Fmt.fmtNum(item.repostCount);
  const button = $(`[data-feed-action="repost"][data-id="${item.id}"]`);
  if (button) {
    button.classList.toggle('is-on', Boolean(item.reposted));
    button.title = item.reposted ? '撤销我的转发' : '转发到我的动态流';
  }
  const box = $(`[data-feed-repost-box="${item.id}"]`);
  if (box && !box.hidden) box.innerHTML = feedRepostHtml(item);
}

/**
 * 把刚转发出去的那条插到列表最前面。
 *
 * 不插的话，用户会看到一句「转发成功」然后**页面上什么都没变** ——
 * 得自己想到「大概要去我的动态里看」。这类「说了成功却看不见」正是前面几轮
 * 一直在修的那种体验。
 * 只在「全部 / 我的」两个筛选下插：转发出去的是公开动态，这两个列表里一定有它；
 * 「我关注的」按服务端规则不一定收（我不关注我自己），硬插会和下次刷新对不上。
 */
function prependRepost(newItem) {
  if (!newItem || (feedFilter !== 'all' && feedFilter !== 'mine')) return;
  const list = $('[data-feed-list]');
  if (!list) return;
  itemCache.set(newItem.id, newItem);
  list.innerHTML = feedItemHtml(newItem) + list.innerHTML;
  ntRenderMath(list);
}

async function submitRepost(form) {
  const id = Number(form.dataset.id);
  const item = itemCache.get(id);
  if (!item) return;
  const textarea = form.querySelector('textarea[name="comment"]');
  const comment = String(textarea?.value ?? '').trim();
  await withButtonBusy(form.querySelector('button[type="submit"]'), async () => {
    const result = await api(`/api/feed/${id}/repost`, { method: 'POST', body: { comment } });
    // 「我关注的」那一栏按服务端规则不收自己转发的（我不关注我自己），`prependRepost`
    // 在那里故意不插卡片 —— 那就得把「去哪儿看」说清楚，否则用户看到一句
    // 「转发成功」而页面上什么都没变，只会以为转发失败了。
    const inserted = feedFilter === 'all' || feedFilter === 'mine';
    toast(
      result.updated
        ? '转发语已更新'
        : inserted
          ? '转发成功：它就是动态流里最上面那条 🔁'
          : '转发成功：切到「全部」就能看到它 🔁',
      'success',
    );
    item.reposted = true;
    item.repostCount = result.repostCount;
    paintRepostState(item);
    prependRepost(result.item);
  });
}

async function removeRepost(node) {
  const id = Number(node.dataset.id);
  const item = itemCache.get(id);
  if (!item) return;
  if (!confirm('撤销转发？你动态流里那条会消失。')) return;
  await withButtonBusy(node, async () => {
    const result = await api(`/api/feed/${id}/repost`, { method: 'DELETE' });
    toast('已撤销转发', 'success');
    item.reposted = false;
    item.repostCount = result.repostCount;
    paintRepostState(item);
  });
}

/**
 * 展开 / 收起一条动态的回复区。
 *
 * 回复**按需拉**（列表接口只给 `replyCount` 数字）：一页 20 条动态，
 * 谁也没展开的时候不该多打 20 次 requests。收回时只是 `hidden`，
 * 下次展开会重新拉一遍 —— 保证看到的是最新的。
 */
async function toggleReplies(node) {
  const id = Number(node.dataset.id);
  const item = itemCache.get(id);
  const box = $(`[data-feed-replies-box="${id}"]`);
  if (!item || !box) return;
  if (!box.hidden) {
    box.hidden = true;
    node.classList.remove('is-on');
    return;
  }
  box.hidden = false;
  node.classList.add('is-on');
  box.innerHTML = loadingHtml();
  await paintReplies(item, box);
}

/** 重新拉一遍某条动态的回复并重画那一块（发完 / 删完 / 展开时都走它）。 */
async function paintReplies(item, box) {
  const data = await api(`/api/feed/${item.id}/replies`);
  box.innerHTML = feedRepliesHtml(item, data);
  ntRenderMath(box);
  const countNode = $(`[data-feed-replies="${item.id}"]`);
  if (countNode) countNode.textContent = Fmt.fmtNum(data.replyCount);
  item.replyCount = data.replyCount;
  return data;
}

async function submitReply(form) {
  const id = Number(form.dataset.id);
  const item = itemCache.get(id);
  const box = $(`[data-feed-replies-box="${id}"]`);
  const textarea = form.querySelector('textarea[name="content"]');
  const content = String(textarea?.value ?? '').trim();
  if (!content) {
    toast('回复不能是空的', 'error');
    return;
  }
  if (!item || !box) return;
  await withButtonBusy(form.querySelector('button[type="submit"]'), async () => {
    const result = await api(`/api/feed/${id}/replies`, { method: 'POST', body: { content } });
    toast('回复成功', 'success');
    // 先清空再重画：`paintReplies` 会把整个盒子 innerHTML 换掉，textarea 跟着没了，
    // 而用户如果这时又敲了字，重画会把新敲的吃掉 —— 这是能接受的最小代价
    // （重画是必须的，不然回复列表和服务端的计数就对不上了）。
    textarea.value = '';
    await paintReplies(item, box);
    document.getElementById(`feed-reply-${result.reply.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
}

async function removeReply(node) {
  const id = Number(node.dataset.id);
  const replyId = Number(node.dataset.reply);
  const item = itemCache.get(id);
  const box = $(`[data-feed-replies-box="${id}"]`);
  if (!item || !box) return;
  if (!confirm('确定删除这条回复吗？')) return;
  await withButtonBusy(node, async () => {
    await api(`/api/feed/${id}/replies/${replyId}`, { method: 'DELETE' });
    toast('已删除', 'success');
    await paintReplies(item, box);
  });
}

/** 就地编辑：把正文那段换成 textarea，**不跳页**。 */
function startEdit(id) {
  const item = itemCache.get(id);
  const article = $(`[data-feed-item="${id}"]`);
  if (!item || !article) return;
  const body = article.querySelector('[data-feed-body]');
  if (!body) return;
  body.innerHTML = `
    <textarea class="input feed-edit-input" data-feed-edit-input rows="4">${esc(item.content)}</textarea>
    <div class="form-actions">
      <button class="btn btn-sm btn-primary" type="button" data-feed-action="save-edit" data-id="${id}">保存</button>
      <button class="btn btn-sm" type="button" data-feed-action="cancel-edit" data-id="${id}">取消</button>
    </div>`;
  article.querySelector('[data-feed-edit-input]')?.focus();
}

/**
 * 取消编辑：**只把那一段正文换回去**，不重画整页。
 *
 * 以前这里是 `viewTimeline(...)`（整页重新取数），后果是用户在编辑框里写的草稿
 * 会被 `renderShell()` 一起重画掉 —— 取消一条动态的编辑，顺手把自己的草稿删了。
 */
function cancelEdit(node) {
  const id = Number(node.dataset.id);
  const item = itemCache.get(id);
  const body = $(`[data-feed-item="${id}"]`)?.querySelector('[data-feed-body]');
  if (!item || !body) return;
  body.innerHTML = item.contentHtml;
  // 复原的是原始 HTML，公式还是 `$…$` 源码，得再渲染一遍
  ntRenderMath(body);
}

async function saveEdit(node) {
  const id = Number(node.dataset.id);
  const article = $(`[data-feed-item="${id}"]`);
  const input = article?.querySelector('[data-feed-edit-input]');
  if (!input) return;
  await withButtonBusy(node, async () => {
    // 只传正文 —— 服务端把「没传的字段」当「不改」（见 src/modules/feed/routes.js 的 PUT 注释）。
    // 所以这里不需要把 scope / images / refPostId 一起回传，少一条「忘了带某个字段」的坑。
    const result = await api(`/api/feed/${id}`, { method: 'PUT', body: { content: input.value } });
    toast('已保存', 'success');
    const item = itemCache.get(id);
    if (item && result?.item) Object.assign(item, result.item);
    // 就地更新那一段，**不重画整页** —— 否则顶部草稿框里正在写的字会被一起重画掉
    const body = article.querySelector('[data-feed-body]');
    if (body && item) {
      body.innerHTML = item.contentHtml;
      ntRenderMath(body);
    }
  });
}

async function removeItem(id) {
  // eslint-disable-next-line no-alert -- 站内其它删除入口（帖子 / 回复）也是同一个做法
  if (!window.confirm('确定删除这条动态吗？删除后别人就看不到了。')) return;
  await api(`/api/feed/${id}`, { method: 'DELETE' });
  toast('已删除', 'success');
  itemCache.delete(id);
  $(`[data-feed-item="${id}"]`)?.remove();
  // 删光了就换成空状态，否则页面上会剩一块什么都不显示的空白
  const list = $('[data-feed-list]');
  if (list && !list.querySelector('[data-feed-item]')) list.innerHTML = feedListEmptyHtml();
}

/** 点图放大。 */
function openLightbox(src) {
  if (!src) return;
  const box = document.createElement('div');
  box.className = 'feed-lightbox';
  box.innerHTML = `<img src="${esc(src)}" alt="配图" />`;
  box.addEventListener('click', () => box.remove());
  document.body.appendChild(box);
}

export { viewTimeline };
export { parsePostId };
