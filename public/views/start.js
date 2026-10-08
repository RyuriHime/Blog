// 起始页：左半边是站务公告，右半边是三块入口 —— 动态 / 积木广场 / 团队。
//
// 地址就是 `#/`（首页）：**无论登录与否**，进站第一眼看到的是这一页。
//   m05506：以前不是这样 —— 那时 `#/` 是动态流，起始页单开 `#/start`，而且只对
//   「未登录的第一次访问」生效（登录用户根本看不到它）。用户要求「进站优先进起始页」，
//   于是把两个地址对调：`#/` 归起始页，动态流搬去 `#/feed`。
//   老地址 `#/start` 保留成别名（侧栏与用户菜单都还挂着它），进的是同一页。
//
// 因此破例一次「页面地址是对外契约、只能加不能改」：代价由别名兜住 —— 老链接 `#/start`
//   照样能开，只是动态流的地址从 `#/` 换成了 `#/feed`（`#/?filter=mine` 同理搬过去）。
//
// **站务公告已经不是帖子了**（帖子功能整体下线）：一条公告 = 一篇模板是
//   `announce` 的积木（见 `src/modules/doc/templates.js`）。它只有站长和管理员
//   建得动、改得动，也**不会出现在积木广场里**（`queries.js` 的 listDocuments
//   对非 staff 直接排除）—— 但首页和 `#/announcements` 照旧人人可见。
//
// 数据全部来自**现成接口**：
//   · 公告   `/api/docs?template=announce`（旧数据是 `meta` 板块的帖子，启动时
//             由 `store.migrateLegacyPosts()` 一次性迁成了公告积木）
//   · 动态   `/api/posts?perPage=5`（影子帖，点进去会被重定向到积木页）
//   · 积木   `/api/docs`
//   · 团队   `/api/teams`

import { emptyHtml, esc, loadingHtml, toast, ui } from '../core/dom.js';
import { api } from '../core/api.js';
import { state } from '../core/state.js';
import { paginationHtml } from '../core/widgets.js';
import { navigate } from '../core/router.js';
import * as Fmt from '../core/format.js';

/**
 * 「站务公告」原来那个板块的 slug。
 *
 * 公告搬进积木之后，数据层面已经用不上它了，但**地址层面还用**：`#/board/meta`
 * 这种老链接可能还躺在谁的收藏夹里，`core/router.js` 靠这个常量把它认出来、
 * 送到 `#/announcements`（那个特判里 `second === Start.ANNOUNCE_BOARD`）。
 */
const ANNOUNCE_BOARD = 'meta';
/** 「这一篇是站务公告」的模板标记（与后端 `templates.js` 的 ANNOUNCE_TEMPLATE 对齐）。 */
const ANNOUNCE_TEMPLATE = 'announce';
/** 公告最多显示几条。 */
const ANNOUNCE_COUNT = 5;
/** 每块入口预览几条。接口 perPage 的下限是 5，所以取回来自己截。 */
const PREVIEW_COUNT = 3;
/** 接口 perPage 的下限就是 5，写死免得以为能要 3 条。 */
const FETCH_PER_PAGE = 5;
/** 公告**列表页**每页几条。接口那边 limit 的上限是 50，20 条一页翻起来正好。 */
const ANNOUNCE_PER_PAGE = 20;
/** 调顺序时要一次拿全，用接口允许的上限。 */
const ANNOUNCE_MAX = 50;

/**
 * 读页码。口径跟服务端 `pageParam`（`src/core/http.js`）一致：
 * 不是安全的正整数就退回第 1 页 —— `?page=1e999` / `2.5` / `abc` / `-3` 都会
 * 让那边的 LIMIT 绑不上，与其把 500 摆给用户看，不如当他没翻页。
 */
function readPage(value) {
  const num = Number(value);
  return Number.isSafeInteger(num) && num > 0 ? num : 1;
}

/** 单个接口失败不该把整页拖垮：拿不到就给个空壳，页面照常渲染。 */
async function safeApi(path, fallback) {
  try {
    return await api(path);
  } catch (error) {
    if (error?.aborted) throw error; // 换页了：交给外层直接收工
    return fallback;
  }
}

/** 能写公告的人：站长 + 管理员（口径同后端 `visibility.js` 的 canEdit）。 */
function canWriteAnnounce() {
  return Boolean(state.me && Fmt.isStaffUser(state.me));
}

/**
 * 公告列表接口。一条公告 = 一篇 `template=announce` 的积木。
 *
 * `sort=order` 是**站长排过的手动顺序**（见后端 `queries.listDocuments` 的 `sort === 'order'`）：
 * 排过的在前、大的更靠前，没排过的一律是 0、退回创建时间倒序。所以「一次都没调过顺序」时
 * 看到的就是从新到旧的老行为，动过一次之后整份顺序才变成显式的。
 *
 * 首页那块与 `#/announcements` 用的是同一个顺序 —— 首页只取前 5 条，
 * 于是「在公告页把某篇挪进前 5」就等于「让它上首页」。
 */
function announceApi(limit, page) {
  return `/api/docs?template=${ANNOUNCE_TEMPLATE}&sort=order&limit=${limit}&page=${page}`;
}

/**
 * 「＋ 写公告」：建一篇公告积木，建完直接落进编辑器。
 *
 * 建而不写：标题和正文都在编辑器里改（和积木广场的「＋ 新建一篇」同一个套路）。
 * 服务端只放行 staff —— 这颗按钮普通用户根本看不到，但真正的门在那边。
 */
async function newAnnounceAndEdit() {
  const created = await api('/api/docs', {
    method: 'POST',
    body: { title: '站务公告', kind: 'post', scope: 'public', template: ANNOUNCE_TEMPLATE },
  });
  toast('公告建好了，写完点保存');
  return navigate(`/doc/${created.doc.id}/edit`);
}

/** 首页左栏的一条公告。 */
function announceItemHtml(doc) {
  return `<a class="start-announce-item" href="#/doc/${encodeURIComponent(doc.id)}">
    <span class="start-announce-title">${esc(doc.title)}</span>
    <span class="start-announce-meta">${esc(doc.author?.displayName ?? doc.author?.username ?? '')} · ${esc(Fmt.timeAgo(doc.createdAt))}</span>
  </a>`;
}

/**
 * 列表页的一行。比首页那版多一行「可见范围」—— 公告本该都是公开的，
 * 万一有人把它设成了别的范围（改范围是站长的自由），这里要看得见，
 * 否则「为什么别人看不到我这条公告」会变成一个查不出来问题。
 *
 * `reorder` 为真时（= staff 且整份都在一页里）右边多两颗箭头 ——
 * **首页那 5 条就是这份顺序的前 5 条**，所以往上挪就是在争首页的位置。
 */
function announceRowHtml(doc, index, total, reorder) {
  const author = doc.author?.displayName ?? doc.author?.username ?? '';
  const meta = [author, Fmt.timeAgo(doc.createdAt), doc.scopeLabel ?? ''].filter(Boolean).join(' · ');
  const tools = reorder
    ? `<span class="announce-tools">
        <button class="announce-move" type="button" data-announce-move="up" data-announce-id="${doc.id}"
          title="往上挪一格" aria-label="往上挪一格"${index === 0 ? ' disabled' : ''}>↑</button>
        <button class="announce-move" type="button" data-announce-move="down" data-announce-id="${doc.id}"
          title="往下挪一格" aria-label="往下挪一格"${index === total - 1 ? ' disabled' : ''}>↓</button>
      </span>`
    : '';
  return `<li class="announce-row">
    <a class="announce-link" href="#/doc/${encodeURIComponent(doc.id)}">
      <span class="announce-row-head">
        <span class="announce-row-title">${esc(doc.title)}</span>
      </span>
      <span class="announce-row-meta">${esc(meta)}</span>
    </a>
    ${tools}
  </li>`;
}

/** 公告页头那颗只有 staff 看得见的按钮外壳（首页那块卡头也用同一个）。 */
function newAnnounceButtonHtml() {
  return canWriteAnnounce() ? '<button class="btn btn-sm btn-primary" type="button" data-new-announce>＋ 写公告</button>' : '';
}

/** 渲染完之后把「＋ 写公告」接上（不用事件委托：这一页只有这一颗）。 */
function mountAnnounceButton() {
  const button = ui.app.querySelector('[data-new-announce]');
  if (!button) return;
  button.addEventListener('click', () => {
    newAnnounceAndEdit().catch((error) => toast(error?.message ?? '建公告失败', 'error'));
  });
}

/**
 * 能不能调顺序。
 *
 * 两个条件：是 staff，而且**整份公告都装得下这一页**。后者不是偷懒 ——
 * `sort_order` 是全局一列，翻到第 2 页再点箭头，「把这几篇提到最前」的意思就错了。
 * 公告本来就只有个位数，分页那天的正确做法是给每行加个序号输入框，
 * 而不是让箭头在跨页时悄悄做错事。
 */
function canReorderAnnounce(total, limit) {
  return canWriteAnnounce() && total > 1 && total <= limit;
}

/** 挪动期间锁一下：连点两下不该发两份「整份顺序」。 */
let announceMoving = false;

/**
 * 把一条公告往上（`delta = -1`）或往下（`delta = 1`）挪一格。
 *
 * **整份顺序重新取一遍**，不用屏幕上这一页的：`sort_order` 是全局一列，
 * 只把当前页那几个编号写进去等于把它们一律提到最前面 —— 翻到第 2 页点一下就会出事。
 * 宁可多一次 GET，也要拿到完整的一份再换位。
 */
async function moveAnnounce(id, delta) {
  if (announceMoving) return;
  announceMoving = true;
  try {
    const data = await api(`/api/docs?template=${ANNOUNCE_TEMPLATE}&sort=order&limit=${ANNOUNCE_MAX}&page=1`);
    const ids = (data.documents ?? []).map((doc) => Number(doc.id));
    const from = ids.indexOf(Number(id));
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) return; // 到头了（按钮本该是灰的）
    [ids[from], ids[to]] = [ids[to], ids[from]];
    await api('/api/docs/meta/announce-order', { method: 'PUT', body: { ids } });
    // 顺序变了，重画当前页 —— 否则用户对着旧列表发呆，会以为没生效。
    await viewAnnouncements(new URLSearchParams(String(location.hash).split('?')[1] ?? ''));
  } finally {
    announceMoving = false;
  }
}

/** 接上那两颗箭头。用委托：行是整批渲染的，而且整页随时会被重画。 */
function mountAnnounceControls() {
  const list = ui.app.querySelector('.announce-list');
  if (!list) return;
  list.addEventListener('click', (event) => {
    const button = event.target?.closest?.('[data-announce-move]');
    if (!button || button.disabled) return;
    event.preventDefault();
    const delta = button.dataset.announceMove === 'up' ? -1 : 1;
    moveAnnounce(Number(button.dataset.announceId), delta).catch((error) =>
      toast(error?.message ?? '调顺序失败', 'error'),
    );
  });
}

/**
 * `#/announcements` —— 站务公告的全部列表。
 *
 * 首页那块只放最近 5 条（`ANNOUNCE_COUNT`），这一页放全部、分页翻。
 * 数据是 `/api/docs?template=announce`，没有为新页面加任何后端接口。
 */
async function viewAnnouncements(query) {
  ui.app.innerHTML = loadingHtml();
  const page = readPage(query?.get('page'));

  let data;
  try {
    data = await api(announceApi(ANNOUNCE_PER_PAGE, page));
  } catch (error) {
    if (error?.aborted) return; // 页面已经被换走了
    throw error;
  }

  const items = data.documents ?? [];
  const total = Number(data.total) || 0;
  const limit = Math.max(1, Number(data.limit) || ANNOUNCE_PER_PAGE);
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const reorder = canReorderAnnounce(total, limit);
  const listHtml = items.length
    ? `<ul class="announce-list">${items.map((doc, index) => announceRowHtml(doc, index, items.length, reorder)).join('')}</ul>`
    : emptyHtml(
        '📢',
        page > 1
          ? '这一页没有公告了 —— 翻回第一页看看。'
          : '还没有公告。站长点右上角那颗「写公告」建一篇，这里就会显示出来。',
      );
  // 页码用不着 `routeQuery`：这一页只有 `page` 一个参数，第 1 页就干净地不带查询串。
  const pagerHtml = paginationHtml(page, totalPages, (target) =>
    target === 1 ? '#/announcements' : `#/announcements?page=${target}`,
  );
  // 「从新到旧」只在没排过顺序时成立，所以这句话得跟着 `sort_order` 的状态走 ——
  // 而「排没排过」前端看不出来（全是 0 与排过之后再看都是同一份列表），
  // 所以干脆两句话分开说：默认这句描述的是**没动过**时的样子。
  const hint = reorder
    ? `用右边的 ↑ ↓ 调先后 —— <strong>前 5 条就是首页显示的那 5 条</strong>。共 ${Fmt.fmtNum(total)} 条。`
    : `站长发的公告都在这儿，从新到旧。共 ${Fmt.fmtNum(total)} 条${
        totalPages > 1 ? `，第 ${page} / ${totalPages} 页` : ''
      }。`;

  ui.app.innerHTML = `
    <div class="start-page">
      <div class="page-head">
        <div class="card-head">
          <h1 class="announce-head">📢 站务公告</h1>
          <span class="spacer"></span>
          ${newAnnounceButtonHtml()}
        </div>
        <p class="hint">${hint}</p>
      </div>
      <section class="card announce-page">
        ${listHtml}
        ${pagerHtml ? `<div class="announce-pager">${pagerHtml}</div>` : ''}
      </section>
    </div>`;
  mountAnnounceButton();
  mountAnnounceControls();
}

/**
 * 一块入口。整块可点：标题是个正常链接（键盘/读屏可达），
 * 样式里用 `.start-entry-title::after` 把它撑满整张卡（见 25-start.css）。
 */
function entryHtml({ href, icon, title, desc, items, empty }) {
  const list = items.length
    ? `<ul class="start-entry-list">${items
        .map(
          (item) => `<li>
        <span class="start-entry-item">${esc(item.text)}</span>
        <span class="start-entry-time">${esc(item.time)}</span>
      </li>`,
        )
        .join('')}</ul>`
    : `<div class="hint">${esc(empty)}</div>`;

  return `<article class="card start-entry">
    <div class="start-entry-head">
      <span class="start-entry-icon" aria-hidden="true">${icon}</span>
      <a class="start-entry-title" href="${href}">${title}</a>
    </div>
    <p class="start-entry-desc">${desc}</p>
    ${list}
    <span class="start-entry-go" aria-hidden="true">进入 →</span>
  </article>`;
}

async function viewStart() {
  ui.app.innerHTML = loadingHtml();

  let announcements;
  let feed;
  let docs;
  let teams;
  try {
    [announcements, feed, docs, teams] = await Promise.all([
      safeApi(announceApi(FETCH_PER_PAGE, 1), { documents: [], total: 0 }),
      safeApi(`/api/posts?perPage=${FETCH_PER_PAGE}`, { items: [] }),
      safeApi('/api/docs', { documents: [] }),
      safeApi('/api/teams?page=1', { items: [] }),
    ]);
  } catch (error) {
    if (error?.aborted) return; // 页面已经被换走了
    throw error;
  }

  const announceList = (announcements.documents ?? []).slice(0, ANNOUNCE_COUNT);
  const announceHtml = announceList.length
    ? announceList.map(announceItemHtml).join('')
    : emptyHtml(
        '📢',
        canWriteAnnounce()
          ? '还没有公告。点右上角那颗「写公告」建一篇，这里就会显示出来。'
          : '还没有公告。',
      );
  // 这块只放最近 5 条，其余的都在 `#/announcements`。有多的时候把条数也写出来，
  // 免得用户以为「就这五条」。
  const announceTotal = Number(announcements.total) || announceList.length;
  const announceMoreHtml = `<a class="announce-more" href="#/announcements">查看全部${
    announceTotal > announceList.length ? ` ${Fmt.fmtNum(announceTotal)} 条` : ''
  } →</a>`;

  const feedItems = (feed.items ?? []).slice(0, PREVIEW_COUNT).map((post) => ({
    text: post.title,
    time: Fmt.timeAgo(post.createdAt),
  }));
  const docItems = (docs.documents ?? []).slice(0, PREVIEW_COUNT).map((doc) => ({
    text: doc.title || '（无标题）',
    time: Fmt.timeAgo(doc.updatedAt),
  }));
  const teamItems = (teams.items ?? []).slice(0, PREVIEW_COUNT).map((team) => ({
    text: team.name,
    time: `${Fmt.fmtNum(team.memberCount ?? 0)} 名成员`,
  }));

  ui.app.innerHTML = `
    <div class="start-page">
      <div class="page-head">
        <h1 class="start-title"><svg class="start-mark" viewBox="0 0 120 120" role="img" aria-label="格社" focusable="false"><mask id="start-brand-g"><rect width="120" height="120" fill="#fff" /><g fill="#000"><rect x="36" y="18" width="12" height="12" /><rect x="48" y="18" width="12" height="12" /><rect x="60" y="18" width="12" height="12" /><rect x="72" y="18" width="12" height="12" /><rect x="84" y="18" width="12" height="12" /><rect x="24" y="30" width="12" height="12" /><rect x="24" y="42" width="12" height="12" /><rect x="24" y="54" width="12" height="12" /><rect x="60" y="54" width="12" height="12" /><rect x="72" y="54" width="12" height="12" /><rect x="84" y="54" width="12" height="12" /><rect x="24" y="66" width="12" height="12" /><rect x="84" y="66" width="12" height="12" /><rect x="24" y="78" width="12" height="12" /><rect x="84" y="78" width="12" height="12" /><rect x="36" y="90" width="12" height="12" /><rect x="48" y="90" width="12" height="12" /><rect x="60" y="90" width="12" height="12" /><rect x="72" y="90" width="12" height="12" /><rect x="84" y="90" width="12" height="12" /></g></mask><rect x="6" y="6" width="108" height="108" rx="26" fill="currentColor" mask="url(#start-brand-g)" /></svg>格社</h1>
        <p class="hint">左边是站务公告，右边三块分别是动态、积木广场和团队 —— 点哪块进哪块。</p>
      </div>
      <div class="start-columns">
        <section class="card start-announce">
          <div class="card-head"><span class="card-title">📢 站务公告</span>${newAnnounceButtonHtml()}${announceMoreHtml}</div>
          <div class="start-announce-list">${announceHtml}</div>
        </section>
        <div class="start-entries">
          ${entryHtml({
            href: '#/feed',
            icon: '🌊',
            title: '动态',
            desc: '全站最新动态：发帖、评价、点赞、@ 提醒都在这里。',
            items: feedItems,
            empty: '还没有动态，成为第一个发帖的人吧。',
          })}
          ${entryHtml({
            href: '#/docs',
            icon: '🧩',
            title: '积木广场',
            desc: '可编程帖子：填一份 schema 就能长出新块类型，别人也能拿来拼。',
            items: docItems,
            empty: '还没有公开的积木。',
          })}
          ${entryHtml({
            href: '#/teams',
            icon: '👥',
            title: '团队',
            desc: '一群人一块地方：团队主页上能发帖，帖子能设成只有本团队看得见。',
            items: teamItems,
            empty: '还没有团队，可以建一个。',
          })}
        </div>
      </div>
    </div>`;
  mountAnnounceButton();
}

// ── 导出 ──────────────────────────────────────────────────────────────
export { viewStart, viewAnnouncements, ANNOUNCE_BOARD };

/* @hand-written */
