// AI 阅读助手页：站点总览、单帖分析、提问。
// 
// ⚠️ 这里只是**展示层**。所有 /api/ai/* 请求都由后端 forum-ai 挂载层处理，
// 前端不许在这里拼提示词、也不许自己算分析结果。

import { $, emptyHtml, esc, loadingHtml, ui } from '../core/dom.js';
import { api } from '../core/api.js';
import { navigate } from '../core/router.js';
import { state } from '../core/state.js';
import * as Fmt from '../core/format.js';

function aiConfigured() {
  return Boolean(state.site?.ai?.configured);
}
function aiNoticeHtml() {
  return `<div class="ai-notice">⚙️ AI 还没有配置。启动服务前设置环境变量 <code>AI_API_KEY</code>（可选 <code>AI_BASE_URL</code> / <code>AI_MODEL</code>）即可启用，例如：<code>AI_API_KEY=sk-xxx node src/server.js</code></div>`;
}
const aiChip = (text, kind = '') => `<span class="ai-chip ${kind}">${esc(text)}</span>`;

/** 同时兼容 postId（论坛）与 documentId（通用包）两种字段名。 */
const aiIdOf = (item) => item?.postId ?? item?.documentId ?? null;
const aiPostLink = (post) => `
  <a class="ai-post" href="#/post/${post.id}">
    <span class="ai-post-title">${esc(post.title)}</span>
    <span class="ai-post-meta">${esc(post.board || '')}${post.replyCount ? ` · ${post.replyCount} 条回复` : ''}${post.difficulty ? ` · ${esc(post.difficulty)}` : ''}</span>
  </a>`;
function aiAskFormHtml(context) {
  const isPost = Boolean(context.postId);
  return `
    <form class="ai-ask-form" data-action="ai-ask" data-id="${isPost ? context.postId : ''}" data-host="${esc(context.host)}">
      <div class="ai-ask-row">
        <input name="question" maxlength="500" placeholder="${isPost ? '就这篇帖子提问，例如：这个方案有什么坑？' : '问全站，例如：入门该从哪几篇开始读？'}" required />
        <button class="btn btn-primary" type="submit">问一问</button>
      </div>
      <div class="hint">AI 只依据${isPost ? '这篇帖子及其回复' : `已整理的全站语料（当前 ${Fmt.fmtNum(state.site?.stats?.posts ?? 0)} 篇帖子）`}回答，并给出引用出处。</div>
    </form>
    <div class="ai-answer-host" data-ai-answer hidden></div>`;
}
function aiAnswerHtml(data) {
  const citations = (data.citations ?? [])
    .map((item) => {
      const id = aiIdOf(item);
      return `
      <a class="ai-cite" ${id ? `href="#/post/${id}"` : ''}>
        <span class="ai-cite-id">${id ? `#${id}` : '外部'}</span>
        <span class="ai-cite-title">${esc(item.title)}</span>
        ${item.quote ? `<span class="ai-cite-quote">「${esc(item.quote)}」</span>` : ''}
      </a>`;
    })
    .join('');
  const notes = (data.notes ?? []).map((note) => `<li>${esc(note)}</li>`).join('');
  const confidenceLabel = { high: '依据充分', medium: '依据一般', low: '依据不足' }[data.confidence] ?? '依据一般';
  return `
    <div class="ai-answer">
      <div class="ai-answer-head">
        <span class="ai-badge">AI 回答</span>
        ${aiChip(confidenceLabel, `conf-${data.confidence || 'medium'}`)}
        ${data.model ? aiChip(data.model, 'soft') : ''}
        ${data.truncated ? aiChip('材料已截断', 'warn') : ''}
      </div>
      <div class="ai-answer-text">${esc(data.answer).replace(/\n/g, '<br />')}</div>
      ${
        citations
          ? `<div class="ai-cites"><div class="ai-sub">引用出处</div>${citations}</div>`
          : '<div class="hint">这条回答没有引用具体帖子。</div>'
      }
      ${notes ? `<div class="ai-sub">补充提醒</div><ul class="ai-notes">${notes}</ul>` : ''}
    </div>`;
}
function aiReviewCardHtml(review) {
  if (!review || review.status !== 'done') return '';
  const prereq = (review.prereq ?? [])
    .map(
      (item) =>
        `<li><strong>${esc(item.name)}</strong>${item.level ? ` <span class="ai-mini">${esc(item.level)}</span>` : ''}${item.why ? ` — ${esc(item.why)}` : ''}</li>`,
    )
    .join('');
  const recommend = (review.recommend ?? [])
    .map((item) => {
      // 站内 Wiki 词条走文档阅读页（#/doc/<编号>）；影子帖是隐藏的，不能拿帖子地址糊弄。
      const wikiId = Number(item?.wikiId) > 0 ? Number(item.wikiId) : null;
      const id = aiIdOf(item);
      const link = wikiId
        ? `<a href="#/doc/${wikiId}">${esc(item.title)}</a>${aiChip('站内 Wiki', 'soft')}`
        : id
          ? `<a href="#/post/${id}">${esc(item.title)}</a>`
          : `<span>${esc(item.title)}</span>`;
      return `
      <li>
        ${link}
        ${item.relation ? aiChip(item.relation, 'soft') : ''}
        ${item.reason ? `<div class="hint">${esc(item.reason)}</div>` : ''}
      </li>`;
    })
    .join('');
  return `
    <div class="ai-review">
      <div class="ai-badges">
        ${review.category ? aiChip(`📂 ${review.category}`, 'cat') : ''}
        ${review.difficulty ? aiChip(`🎯 ${review.difficulty}`, 'diff') : ''}
        ${(review.tags ?? []).map((tag) => aiChip(tag, 'soft')).join('')}
      </div>
      ${review.summary ? `<p class="ai-summary">${esc(review.summary)}</p>` : ''}
      ${
        prereq
          ? `<div class="ai-sub">🧱 前置知识</div><ul class="ai-list">${prereq}</ul>`
          : ''
      }
      ${
        recommend
          ? `<div class="ai-sub">📚 推荐阅读</div><ul class="ai-list">${recommend}</ul>`
          : ''
      }
      <div class="hint">${review.model ? `模型 ${esc(review.model)} · ` : ''}更新于 ${Fmt.timeAgo(review.updatedAt)}${
        review.tokens?.prompt ? ` · tokens ${review.tokens.prompt}+${review.tokens.completion}` : ''
      }</div>
    </div>`;
}

/** 帖子详情页里的 AI 区块：解读 / 前置知识 / 推荐阅读 / 就这篇提问。 */
function aiPostPanelHtml(post, aiInfo) {
  const review = aiInfo?.cached ?? null;
  const stale = Boolean(aiInfo?.stale);
  const done = review && review.status === 'done';
  const failed = review && review.status !== 'done';
  const host = `ai-post-${post.id}`;
  const needsRebuild = stale || failed;
  const buttonLabel = done && !needsRebuild ? '🔄 重新解读' : needsRebuild && done ? '🔄 内容已变，重新解读' : '✨ 解读这篇';

  return `
    <section class="ai-panel" data-ai-panel="${host}">
      <div class="ai-panel-head">
        <span class="ai-badge">🤖 AI 阅读助手</span>
        ${
          state.me
            ? `<button class="btn btn-sm btn-ghost" type="button" data-action="ai-analyze" data-id="${post.id}" data-host="${host}">${buttonLabel}</button>`
            : '<a class="btn btn-sm btn-ghost" href="#/login">登录后可使用</a>'
        }
      </div>
      ${!aiConfigured() ? aiNoticeHtml() : ''}
      ${
        done
          ? `${stale ? '<div class="ai-stale">内容有更新，建议重新解读一次。</div>' : ''}${aiReviewCardHtml(review)}`
          : failed
            ? `<div class="ai-error">上次解读失败：${esc(review.error || '未知原因')}</div>`
            : `<div class="hint">还没有解读过。点右上角「解读这篇」，AI 会给出分类、摘要、前置知识与推荐阅读。</div>`
      }
      <div class="ai-ask-block">
        <div class="ai-sub">💬 就这篇提问</div>
        ${aiAskFormHtml({ postId: post.id, host })}
      </div>
    </section>`;
}

/** 逐篇分类默认只渲染这么多行：554 篇文档一次全铺开是几十屏，其余点「显示全部」再展开。 */
const AI_LIST_LIMIT = 30;

/** 逐篇分类的一行。状态写进 `data-ai-status`，卡内的「已解读 / 未解读」筛选直接读它。 */
function aiDocRowHtml(doc) {
  return `
    <div class="ai-post-row" data-ai-status="${doc.category ? 'done' : 'pending'}" data-ai-title="${esc(String(doc.title ?? '').toLowerCase())}">
      <a class="ai-post" href="#/post/${doc.id}">
        <span class="ai-post-title">${esc(doc.title)}</span>
        <span class="ai-post-meta">${esc(doc.board)} · ${esc(doc.author)}${doc.replyCount ? ` · ${doc.replyCount} 条回复` : ''}</span>
        ${doc.summary ? `<span class="ai-post-summary">${esc(doc.summary)}</span>` : ''}
      </a>
      <div class="ai-post-chips">
        ${doc.category ? aiChip(doc.category, 'cat') : '<span class="hint">未解读</span>'}
        ${doc.difficulty ? aiChip(doc.difficulty, 'diff') : ''}
      </div>
    </div>`;
}

/** 一个主题分组：整块默认**收起**（6 组 × 16~30 篇铺开就是十几屏），点标题才展开。 */
function aiTopicHtml(topic) {
  const list = topic.posts ?? [];
  return `
    <details class="ai-topic">
      <summary class="ai-topic-head">
        <span class="ai-caret" aria-hidden="true">▶</span>
        <span class="ai-topic-name">${esc(topic.name)}</span>
        ${topic.difficulty ? aiChip(topic.difficulty, 'diff') : ''}
        ${(topic.prereq ?? []).map((item) => aiChip(`前置：${item}`, 'soft')).join('')}
        <span class="ai-topic-count">${Fmt.fmtNum(list.length)} 篇</span>
      </summary>
      ${topic.summary ? `<div class="hint">${esc(topic.summary)}</div>` : ''}
      <div class="ai-posts">${list.map(aiPostLink).join('')}</div>
    </details>`;
}

/**
 * 逐篇分类：整卡默认收起，展开后自带「全部 / 已解读 / 未解读」筛选与标题搜索，
 * 且默认只显示前 `AI_LIST_LIMIT` 行。筛选与搜索都只动 class / dataset，不重新请求接口。
 */
function aiAllDocsHtml(posts, pendingCount, isAdmin) {
  const doneCount = posts.filter((doc) => doc.category).length;
  const clipped = posts.length > AI_LIST_LIMIT;
  return `
    <section class="card">
      <details class="ai-all">
        <summary class="ai-all-head">
          <span class="ai-caret" aria-hidden="true">▶</span>
          <span class="card-title">📄 逐篇分类</span>
          <span class="hint">${Fmt.fmtNum(posts.length)} 篇${
            pendingCount
              ? ` · 全站还有 ${Fmt.fmtNum(pendingCount)} 篇没整理${isAdmin ? '（可在上面的「⚙ 管理」里批量处理）' : ''}`
              : ' · 都已整理'
          }</span>
        </summary>
        <div class="ai-all-controls">
          <button class="ai-scope is-on" type="button" data-action="ai-list-scope" data-scope="all">全部 ${Fmt.fmtNum(posts.length)}</button>
          <button class="ai-scope" type="button" data-action="ai-list-scope" data-scope="done">已解读 ${Fmt.fmtNum(doneCount)}</button>
          <button class="ai-scope" type="button" data-action="ai-list-scope" data-scope="pending">未解读 ${Fmt.fmtNum(posts.length - doneCount)}</button>
          <input class="ai-search" type="search" data-action="ai-list-search" placeholder="搜标题…" aria-label="按标题筛选" />
        </div>
        <div class="ai-posts wide" data-ai-list="1" data-scope="all"${clipped ? ' data-clip="1"' : ''}>${posts
          .map(aiDocRowHtml)
          .join('')}</div>
        ${clipped ? `<button class="btn btn-sm btn-ghost ai-more" type="button" data-action="ai-list-more">显示全部 ${Fmt.fmtNum(posts.length)} 篇</button>` : ''}
      </details>
    </section>`;
}

/** AI 主页：全站整理结果 + 逐篇分类清单 + 全站问答。 */
async function viewAI() {
  ui.app.innerHTML = loadingHtml();
  if (!state.me) {
    state.redirect = '/ai';
    navigate('/login');
    return;
  }

  const data = await api('/api/ai/site');
  const { report, topics = [], readingPath = [], posts = [], stats = {} } = data;
  const isAdmin = Fmt.isStaffUser(state.me);
  const corpus = stats.corpus ?? {};
  // 封面篇数取 `documentCount`：后端从来没有 `postCount` 这个字段，而 `Fmt.fmtNum(undefined)`
  // 走的是 `Number(value || 0)`，于是页面上一直写着「覆盖 0 篇」。两个字段都兜一层，后端改名也不会再静默变 0。
  const covered = report?.documentCount ?? report?.postCount ?? 0;

  const head = `
    <section class="card">
      <div class="card-head">
        <h1 style="font-size:21px">🤖 AI 阅读助手</h1>
        <div class="ai-head-actions">
          <a class="btn btn-sm btn-ghost" href="#/ai-edit" title="选文档 → 选块 → 让 AI 改这一块，改完真的落盘，随时可回滚">🎛 AI 编辑台</a>
        </div>
      </div>
      <div class="page-sub">把论坛里的 Markdown 帖子自动分类整理，给出推荐阅读顺序与前置知识；也可以基于单篇帖子或全站内容直接提问。</div>
      <div class="ai-stats">
        <span class="ai-stat"><strong>${Fmt.fmtNum(corpus.posts ?? 0)}</strong> 篇语料</span>
        <span class="ai-stat"><strong>${Fmt.fmtNum(stats.analyzed ?? 0)}</strong> 篇已解读</span>
        ${stats.pending ? `<span class="ai-stat warn"><strong>${Fmt.fmtNum(stats.pending)}</strong> 篇待整理</span>` : ''}
        <span class="ai-stat"><strong>${Fmt.fmtNum(topics.length)}</strong> 个主题</span>
        ${stats.failed ? `<span class="ai-stat warn"><strong>${Fmt.fmtNum(stats.failed)}</strong> 篇解读失败</span>` : ''}
      </div>
      ${!aiConfigured() ? aiNoticeHtml() : ''}
      ${data.stale && report ? '<div class="ai-stale">论坛内容有更新，这份整理可能已经过时，建议重新整理。</div>' : ''}
      ${
        isAdmin
          ? `<details class="ai-admin">
        <summary><span class="ai-caret" aria-hidden="true">▶</span>⚙ 管理 · 批量解读 / 重新整理全站</summary>
        <div class="ai-admin-menu">
          <button class="btn btn-sm" type="button" data-action="ai-analyze-pending">⚡ 解读未整理的帖子</button>
          <button class="btn btn-sm btn-primary" type="button" data-action="ai-site-analyze">🧭 重新整理全站</button>
        </div>
      </details>`
          : ''
      }
    </section>`;

  const qa = `
    <section class="card">
      <div class="card-head"><span class="card-title">💬 问全站</span></div>
      ${aiAskFormHtml({ host: 'ai-site' })}
    </section>`;

  const reportHtml = report
    ? `
    <section class="card">
      <div class="card-head">
        <span class="card-title">🧭 全站知识地图</span>
        <span class="hint">${Fmt.timeAgo(report.createdAt)}整理 · 覆盖 ${Fmt.fmtNum(covered)} 篇${report.model ? ` · ${esc(report.model)}` : ''}</span>
      </div>
      ${report.status !== 'done' ? `<div class="ai-error">上次整理失败：${esc(report.error || '未知原因')}</div>` : ''}
      ${report.summary ? `<p class="ai-summary">${esc(report.summary)}</p>` : ''}
      ${
        readingPath.length
          ? `<div class="ai-sub">🚀 推荐阅读路线</div>
             <ol class="ai-path">
               ${readingPath
                 .map(
                   (step) => `
                 <li>
                   <a href="#/post/${step.post.id}">${esc(step.post.title)}</a>
                   ${step.level ? aiChip(step.level, 'diff') : ''}
                   ${step.reason ? `<div class="hint">${esc(step.reason)}</div>` : ''}
                 </li>`,
                 )
                 .join('')}
             </ol>`
          : ''
      }
      ${
        topics.length
          ? `<div class="ai-sub">🗂 主题分组（点标题展开）</div>
             <div class="ai-topics">${topics.map(aiTopicHtml).join('')}</div>`
          : `<div class="hint">还没有整理过全站。${isAdmin ? '点上面的「重新整理全站」开始。' : '等管理员整理一次后这里就会显示主题分组。'}</div>`
      }
    </section>`
    : `
    <section class="card">
      <div class="card-head"><span class="card-title">🧭 全站知识地图</span></div>
      ${emptyHtml('🗺', '还没有整理过全站', isAdmin ? '点上方「重新整理全站」，AI 会聚类出主题与阅读路线' : '等管理员整理一次后这里就会显示主题分组')}
    </section>`;

  const listHtml = posts.length
    ? aiAllDocsHtml(posts, stats.pending ?? 0, isAdmin)
    : `
    <section class="card">
      <div class="card-head"><span class="card-title">📄 逐篇分类</span></div>
      ${emptyHtml('📭', '还没有帖子', '先去发一篇吧')}
    </section>`;

  ui.app.innerHTML = head + qa + reportHtml + listHtml;
}

/* ------------------------------------------------------------------ */
/* 视图：管理后台                                                      */

// ── 导出 ──────────────────────────────────────────────────────────────
export { aiConfigured };
export { aiNoticeHtml };
export { aiChip };
export { aiIdOf };
export { aiPostLink };
export { aiAskFormHtml };
export { aiAnswerHtml };
export { aiReviewCardHtml };
export { aiPostPanelHtml };
export { viewAI };

/* @hand-written */
