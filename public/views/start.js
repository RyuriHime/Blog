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
// 数据全部来自**现成接口**，没有为新页面加任何后端：
//   · 公告   `/api/posts?board=meta`（数据库里那条「📢 站务公告」板块）
//   · 动态   `/api/posts?perPage=5`
//   · 积木   `/api/docs`
//   · 团队   `/api/teams`

import { emptyHtml, esc, loadingHtml, ui } from '../core/dom.js';
import { api } from '../core/api.js';
import * as Fmt from '../core/format.js';

/** 公告板块的 slug：种子数据里那条「📢 站务公告」。 */
const ANNOUNCE_BOARD = 'meta';
/** 公告最多显示几条。 */
const ANNOUNCE_COUNT = 5;
/** 每块入口预览几条。接口 perPage 的下限是 5，所以取回来自己截。 */
const PREVIEW_COUNT = 3;
/** 接口 perPage 的下限就是 5，写死免得以为能要 3 条。 */
const FETCH_PER_PAGE = 5;

/** 单个接口失败不该把整页拖垮：拿不到就给个空壳，页面照常渲染。 */
async function safeApi(path, fallback) {
  try {
    return await api(path);
  } catch (error) {
    if (error?.aborted) throw error; // 换页了：交给外层直接收工
    return fallback;
  }
}

function announceItemHtml(post) {
  return `<a class="start-announce-item" href="#/post/${encodeURIComponent(post.id)}">
    <span class="start-announce-title">${esc(post.title)}</span>
    <span class="start-announce-meta">${esc(post.author?.displayName ?? post.author?.username ?? '')} · ${esc(Fmt.timeAgo(post.createdAt))}</span>
  </a>`;
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
      safeApi(`/api/posts?board=${ANNOUNCE_BOARD}&perPage=${FETCH_PER_PAGE}`, { items: [] }),
      safeApi(`/api/posts?perPage=${FETCH_PER_PAGE}`, { items: [] }),
      safeApi('/api/docs', { documents: [] }),
      safeApi('/api/teams?page=1', { items: [] }),
    ]);
  } catch (error) {
    if (error?.aborted) return; // 页面已经被换走了
    throw error;
  }

  const announceList = (announcements.items ?? []).slice(0, ANNOUNCE_COUNT);
  const announceHtml = announceList.length
    ? announceList.map(announceItemHtml).join('')
    : emptyHtml('📢', '还没有公告。站长在「站务公告」板块发一篇，这里就会显示出来。');

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
          <div class="card-head"><span class="card-title">📢 站务公告</span></div>
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
}

// ── 导出 ──────────────────────────────────────────────────────────────
export { viewStart };

/* @hand-written */
