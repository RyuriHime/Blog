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
//   2. **先写进编辑区、再等作者点头**。模型一交稿就立刻写进右边的编辑区 ——
//      效果预览就是编辑器自己那一栏（同一套渲染、同一套沙箱，看得见也点得动），
//      抽屉里不再另开一栏小预览。紧接着抽屉摆出「接受 / 拒绝」：**没点之前编辑区是锁着的**，
//      想接着改必须先表态。接受 = 这一稿留下；拒绝 = 退回 AI 动手之前的正文；
//      跑不起来还会多一颗「拒绝并按报错再改一次」。落盘仍然是页面上那颗「保存」的事 ——
//      抽屉不替作者下「这次改动算数」的决定。跑没跑得起来全靠既有机制
//      （`public/core/sandbox.js` 的看门狗 + `doc-app-failed` 占位）。
//   3. **抽屉自己绝不把编辑器带下水**：没授权 / 没配 key / 模型超时，一律变成日志里的
//      一句人话，右边的编辑照常能用。
//
// 后端是 `/api/ai-edit/*`（`src/modules/ai/routes.js`）：
//   POST /draft-range  scope=document  { documentId, markdown, instruction } → 整篇草稿
//   POST /review       { documentId, markdown }                             → 只出意见
// 落盘不由这里做（`ai-edit` 页面才管落盘与回滚），这里只把文本写回编辑区。

import { esc } from '../core/dom.js';
import { api } from '../core/api.js';
import { apiErrorText } from '../core/errors.js';

/** 快捷指令：把最常用的三件事变成按钮（照既有 AI 抽屉那颗「学术审查」的口径）。 */
const QUICK = [
  ['📐 格式整理', '把这一篇的格式整理一遍：标题层级、列表、表格口径统一，事实一个字都不要动'],
  ['🧱 加个积木', '在文末加一个能用的积木块（投票 / 小应用 / 脚本里挑最合适的一种），块体写完整'],
  ['✂️ 精简一半', '把这一篇压缩到一半长度，保留结论与全部数字，删掉重复和空话'],
];

const SEVERITY = { high: '高', medium: '中', low: '低' };

/**
 * 行级对照里**最多逐行比对**的行数（两侧各自）。
 *
 * 求的是最长公共子序列，表是 O(n×m) 的：一篇四万字的正文真按逐行比对会算上几十秒，
 * 而这里只是给作者看一眼「改了哪儿」。超了就直接摆成「整段删 + 整段加」——
 * 大改本来就长这样，不值得为它把界面卡住。
 */
const DIFF_MAX_LINES = 600;

/**
 * 把「AI 改前 / 改后」两段正文折成一份行级对照。
 *
 * 返回 `[['same'|'del'|'add', 行文本], …]`。先掐掉两端一模一样的行（改写通常只动中间
 * 一段，掐完要算的部分小得多），中间那段再跑 LCS，最后把掐掉的头尾原样接回去。
 */
function diffRows(before, after) {
  const a = String(before ?? '').split('\n');
  const b = String(after ?? '').split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) {
    tail += 1;
  }
  const am = a.slice(head, a.length - tail);
  const bm = b.slice(head, b.length - tail);
  const rows = a.slice(0, head).map((line) => ['same', line]);
  if (am.length > DIFF_MAX_LINES || bm.length > DIFF_MAX_LINES) {
    for (const line of am) rows.push(['del', line]);
    for (const line of bm) rows.push(['add', line]);
  } else {
    const table = [];
    for (let i = 0; i <= am.length; i += 1) table.push(new Array(bm.length + 1).fill(0));
    for (let i = am.length - 1; i >= 0; i -= 1) {
      for (let j = bm.length - 1; j >= 0; j -= 1) {
        table[i][j] =
          am[i] === bm[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < am.length && j < bm.length) {
      if (am[i] === bm[j]) {
        rows.push(['same', am[i]]);
        i += 1;
        j += 1;
      } else if (table[i + 1][j] >= table[i][j + 1]) {
        rows.push(['del', am[i]]);
        i += 1;
      } else {
        rows.push(['add', bm[j]]);
        j += 1;
      }
    }
    while (i < am.length) {
      rows.push(['del', am[i]]);
      i += 1;
    }
    while (j < bm.length) {
      rows.push(['add', bm[j]]);
      j += 1;
    }
  }
  for (const line of a.slice(a.length - tail)) rows.push(['same', line]);
  return rows;
}

/**
 * 每一行是「加了 / 删了 / 没动」，各配一个**整段**类名。
 *
 * 为什么不写成 `is-${row[0]}`：`scripts/check-ui-contract.mjs` 会把 class 属性里的
 * `${…}` 换成空格再按空白切 token，`is-${row[0]}` 会切出一个没人定义的 `is-`，
 * 静态检查直接红。整段插值就不会留下半个类名。
 */
const DIFF_CLASS = { add: 'doc-ai-diff-add', del: 'doc-ai-diff-del', same: 'doc-ai-diff-same' };

/** 上面那份对照的 HTML：一个默认折起来的 `<details>`，摘要上直接写「+几行 −几行」。 */
function diffHtml(before, after) {
  const rows = diffRows(before, after);
  let added = 0;
  let removed = 0;
  const body = rows
    .map((row) => {
      if (row[0] === 'add') added += 1;
      if (row[0] === 'del') removed += 1;
      const mark = row[0] === 'add' ? '+' : row[0] === 'del' ? '-' : ' ';
      return `<div class="doc-ai-diff-line ${DIFF_CLASS[row[0]]}">${esc(mark + row[1])}</div>`;
    })
    .join('');
  return (
    `<details class="doc-ai-diff-wrap"><summary>看看改前改后（+${added} 行 / −${removed} 行）</summary>` +
    `<div class="doc-ai-diff">${body}</div></details>`
  );
}

/** 一次草稿（还没写进编辑区）：`{ kind:'draft'|'template', ... }`，按按钮时用。 */
let pending = [];

/** 当前挂着的那个抽屉；切页面时由 `destroyDocAi()` 收掉。 */
let live = null;

/** 最后一次发出的请求（`{ kind:'draft'|'review', instruction }`）：授权成功后拿它重跑一遍。 */
let lastAsk = null;

/**
 * 已经写进编辑区、还等作者「接受 / 拒绝」的那一稿在 `pending` 里的下标（没有就是 `null`）。
 *
 * 它在的时候编辑区是**只读**的 —— 作者必须先表态才能接着改（这是这条流水线的规矩：
 * AI 的改动和作者的手改不混在一起）。
 */
let awaiting = null;

/** 左侧抽屉的骨架。`documentId` 只是为了在标题栏写清楚「改的是哪一篇」。 */
export function docAiHtml(documentId) {
  return `<aside class="card doc-ai" data-doc-ai>
    <div class="card-head doc-ai-head">
      <span class="card-title">🤖 AI 助手</span>
      <span class="doc-ai-docid">#${esc(String(documentId ?? ''))}</span>
      <div class="doc-ai-switch" data-doc-ai-switch role="tablist" aria-label="左栏内容">
        <button class="doc-ai-switch-btn is-on" type="button" role="tab" aria-selected="true" data-doc-ai-pane="ai">AI 助手</button>
        <button class="doc-ai-switch-btn" type="button" role="tab" aria-selected="false" data-doc-ai-pane="convert">📄 转换</button>
        <button class="doc-ai-switch-btn doc-ai-switch-collapse" type="button" data-doc-ai-action="collapse" title="收起这一栏">收起</button>
      </div>
    </div>
    <div class="doc-ai-body" data-doc-ai-pane-body="ai">
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
    <section class="doc-ai-convert" data-doc-ai-convert data-doc-ai-pane-body="convert" hidden>
      <div class="card-head doc-ai-convert-head">
        <span class="card-title">📄 PDF / 文档 → Markdown</span>
      </div>
      <div class="doc-hint">把 PDF / Word / PPT / 文本里的内容抽成 Markdown 源码，公式会被归一成 <code class="doc-code">$…$</code> / <code class="doc-code">$$…$$</code>。这条路<strong>不花 AI、不需要密钥</strong>；图片识别要等 AI 通道。</div>
      <div class="doc-ai-convert-row">
        <label class="btn btn-sm doc-ai-convert-pick">📄 文档
          <input type="file" accept=".pdf,.docx,.pptx,.md,.markdown,.txt,application/pdf" multiple hidden data-doc-ai-file>
        </label>
        <label class="btn btn-sm doc-ai-convert-pick">🖼 图片
          <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden data-doc-ai-image>
        </label>
        <button class="btn btn-sm btn-ghost" type="button" data-doc-ai-convert="insert" disabled>插到光标处</button>
        <button class="btn btn-sm btn-ghost" type="button" data-doc-ai-convert="append" disabled>追加到末尾</button>
        <button class="btn btn-sm btn-ghost" type="button" data-doc-ai-convert="replace" disabled>替换选中</button>
      </div>
      <div class="doc-hint" data-doc-ai-convert-status></div>
      <pre class="doc-ai-convert-preview" data-doc-ai-convert-preview hidden></pre>
    </section>
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
  // 编辑区那个文本框、以及它右边那栏实时预览：它们和抽屉在**同一个** `.doc-md-wrap` 里
  // （见 `doc.js` 的 `sourceEditorHtml`），所以从抽屉这一棵往上找，找的只会是自己这一份。
  const wrap = root.closest?.('.doc-md-wrap') ?? null;
  const sourceBox = wrap?.querySelector?.('[data-doc-source]') ?? null;

  /* ------------------------------------------------------------------ */
  /* 📄 PDF / 文档 → Markdown：就在这个抽屉里，跟着它一起收起、一起缩放    */
  /* ------------------------------------------------------------------ */

  const convertBox = root.querySelector('[data-doc-ai-convert]');
  const fileInput = root.querySelector('[data-doc-ai-file]');
  const imageInput = root.querySelector('[data-doc-ai-image]');
  const convertStatus = root.querySelector('[data-doc-ai-convert-status]');
  const convertPreview = root.querySelector('[data-doc-ai-convert-preview]');
  const convertButtons = [...root.querySelectorAll('[data-doc-ai-convert]')];
  let convertedMarkdown = '';

  /* ------------------------------------------------------------------ */
  /* 左栏三态开关：AI 助手 / 📄 转换 / 收起                                */
  /*   「收起」沿用既有的 is-collapsed（按钮上的 data-doc-ai-action 没变，   */
  /*   所以老的那套 onClick 照常管用）；前两态只切下面这两个面板。           */
  /*   状态留在内存里：重开编辑器回到默认的「AI 助手」。                    */
  /* ------------------------------------------------------------------ */
  const switchBox = root.querySelector('[data-doc-ai-switch]');
  const panes = [...root.querySelectorAll('[data-doc-ai-pane-body]')];
  let activePane = 'ai';

  const paintPane = () => {
    for (const pane of panes) pane.hidden = pane.dataset.docAiPaneBody !== activePane;
    const buttons = switchBox ? switchBox.querySelectorAll('[data-doc-ai-pane]') : [];
    for (const button of buttons) {
      const on = button.dataset.docAiPane === activePane;
      button.classList.toggle('is-on', on);
      button.setAttribute('aria-selected', on ? 'true' : 'false');
    }
  };

  switchBox?.addEventListener('click', (event) => {
    const button = event.target?.closest?.('[data-doc-ai-pane]');
    if (!button) return;
    activePane = button.dataset.docAiPane === 'convert' ? 'convert' : 'ai';
    paintPane();
  });
  paintPane();

  const convertHint = (text) => {
    if (convertStatus) convertStatus.textContent = text;
  };

  function insertIntoSource(text, mode) {
    // 用队友这次重构留下的 `sourceBox`（它拿的就是这个抽屉所属编辑区的那个框），
    // 兜底再按老办法找一次。
    const area = sourceBox ?? document.querySelector('[data-doc-source]');
    if (!area || !text) return false;
    // 编辑区被 AI 的稿子锁住时（正等作者接受 / 拒绝）先不要插：
    // 插进去会和那份稿子搅在一起，拒绝时也说不清该退到哪。
    if (area.readOnly) {
      convertHint('编辑区正等你对 AI 的稿子表态（接受 / 拒绝）—— 先表态，再插入。');
      return false;
    }
    const value = area.value ?? '';
    const start = area.selectionStart ?? value.length;
    const end = area.selectionEnd ?? value.length;
    let next;
    let caret;
    if (mode === 'append') {
      const gap = value === '' || value.endsWith('\n') ? '' : '\n\n';
      next = `${value}${gap}${text}`;
      caret = next.length;
    } else {
      next = `${value.slice(0, start)}${text}${value.slice(end)}`;
      caret = start + text.length;
    }
    area.value = next;
    area.focus();
    area.setSelectionRange(caret, caret);
    // 派发 input：自动保存与右侧实时预览都监听它，这里不另接一条线。
    area.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  /** 抽/认完了：预览 + 放开三个落点按钮。两条路（文档抽取、图片识别）共用。 */
  function showConverted(markdown, note) {
    convertedMarkdown = String(markdown ?? '');
    if (convertPreview) {
      convertPreview.hidden = convertedMarkdown === '';
      convertPreview.textContent = convertedMarkdown.slice(0, 4000);
    }
    for (const button of convertButtons) button.disabled = convertedMarkdown === '';
    convertHint(convertedMarkdown ? `${note} · ${convertedMarkdown.length} 字符 —— 选一个落点` : `${note}（没拿到内容）`);
  }

  async function convertFiles(files) {
    const list = [...(files ?? [])];
    if (!list.length) return;
    const form = new FormData();
    for (const file of list) form.append('files', file, file.name);
    convertHint(`正在抽取 ${list.length} 个文件…（不发模型）`);
    try {
      // 这里直接 fetch：`api()` 会把 body 一律 JSON.stringify，FormData 走不了那条路。
      const response = await fetch('/api/note-agent/extract', { method: 'POST', body: form, credentials: 'same-origin' });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || `抽取失败（HTTP ${response.status}）`);
      const data = payload.data ?? {};
      const names = (data.items ?? []).map((item) => (item.error ? `${item.name}（${item.error}）` : item.name)).join('、');
      showConverted(data.markdown, `抽好了：${names}`);
    } catch (error) {
      showConverted('', `抽取失败：${error?.message ?? '未知错误'}`);
    }
  }

  const readAsDataUrl = (file) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('图片读取失败'));
      reader.onload = () => resolve({ name: file.name, dataUrl: String(reader.result ?? '') });
      reader.readAsDataURL(file);
    });

  /** 图片 → Markdown：走视觉模型（`/api/note-agent/extract-image`），需要站点配好 AI。 */
  async function convertImages(files) {
    const list = [...(files ?? [])];
    if (!list.length) return;
    convertHint(`正在看图（${list.length} 张）…（这一步会花模型）`);
    try {
      const images = await Promise.all(list.map(readAsDataUrl));
      const response = await fetch('/api/note-agent/extract-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ images }),
        credentials: 'same-origin',
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || `识别失败（HTTP ${response.status}）`);
      showConverted(payload.data?.markdown, `识别完成（${payload.data?.model ?? '模型'}）`);
    } catch (error) {
      showConverted('', `识别失败：${error?.message ?? '未知错误'}`);
    }
  }

  fileInput?.addEventListener('change', () => {
    void convertFiles(fileInput.files);
    fileInput.value = '';
  });
  imageInput?.addEventListener('change', () => {
    void convertImages(imageInput.files);
    imageInput.value = '';
  });
  convertBox?.addEventListener('click', (event) => {
    const button = event.target?.closest?.('[data-doc-ai-convert]');
    if (!button || !convertedMarkdown) return;
    const mode = button.dataset.docAiConvert;
    if (insertIntoSource(convertedMarkdown, mode)) convertHint(`已${mode === 'append' ? '追加到末尾' : mode === 'replace' ? '替换选中' : '插入到光标处'} —— 自动保存会跟上`);
  });

  /**
   * 锁 / 解锁编辑区。
   *
   * AI 的稿子摆进去之后（等作者「接受 / 拒绝」的那段时间）编辑区是**只读**的：
   * 想接着改就先表态 —— 否则作者手改的内容会和 AI 的稿子搅在一起，拒绝时回退也不知道该退到哪。
   * 只动 `readOnly`：程序化写入（`setText`）不受影响，`reject()` 照样能把它退回去。
   */
  const setLocked = (on) => {
    if (!sourceBox) return;
    sourceBox.readOnly = on;
    sourceBox.classList.toggle('is-ai-locked', on);
  };

  // 返回这一条气泡的 DOM：效果预览要等渲染完才能填进卡片里，得有个抓手。
  const say = (html) => {
    if (!log) return null;
    const turn = document.createElement('div');
    turn.className = 'doc-ai-turn';
    turn.innerHTML = html;
    log.appendChild(turn);
    log.scrollTop = log.scrollHeight;
    return turn;
  };

  const hint = (text) => {
    if (status) status.textContent = text;
  };

  /**
   * 思考态：一条**真的会动**的「正在做什么」（用户第 3 条）。
   *
   * 为什么不做成进度条：服务端是一次阻塞的 `fetch`（`src/modules/ai/routes.js` 的
   * `callModel` 没有流式），中间过程客户端一个都看不到。编一个「已读取文件 / 已完成 60%」
   * 只会让用户更不信 —— 所以这里只报两类**真事**：
   *   ① 本地此刻确实发生了的事（收到什么要求、正文多少字、请求发出去了没有）；
   *   ② 已经流逝的秒数（等模型那一步每秒重写一次，所以卡住也看得出它在等）。
   * 模型回来之后，再把服务端报回来的真实事实（模型名、摆正了什么形状、影子试跑的结果）
   * 接着往同一条清单里写。
   */
  function think(title) {
    const box = document.createElement('div');
    box.className = 'doc-ai-steps';
    box.innerHTML =
      `<div class="doc-ai-steps-head">${esc(title)}</div>` +
      `<ol class="doc-ai-steps-list" data-doc-ai-steps></ol>`;
    const list = box.querySelector('[data-doc-ai-steps]');
    if (log) {
      log.appendChild(box);
      log.scrollTop = log.scrollHeight;
    }
    const started = Date.now();
    const elapsed = () => Math.max(1, Math.round((Date.now() - started) / 1000));
    let timer = 0;
    let waitingRow = null;
    let waitingText = '';
    const row = (text) => {
      if (!list) return null;
      const item = document.createElement('li');
      item.className = 'doc-ai-step';
      item.textContent = text;
      list.appendChild(item);
      if (log) log.scrollTop = log.scrollHeight;
      return item;
    };
    return {
      // 一步已经做完的事。
      step: (text) => row(text),
      // 「等模型」这一步：唯一会停很久的一步，单独每秒刷它的秒数。
      wait: (text) => {
        waitingText = text;
        waitingRow = row(`${text}…`);
        if (waitingRow) waitingRow.classList.add('is-running');
        timer = setInterval(() => {
          if (waitingRow) waitingRow.textContent = `${waitingText}…（已等 ${elapsed()} 秒）`;
          if (log) log.scrollTop = log.scrollHeight;
        }, 1000);
      },
      // 停表，并把「等模型」那一步改写成最终事实（返回已经过去的秒数）。
      settle: (text) => {
        if (timer) clearInterval(timer);
        timer = 0;
        const seconds = elapsed();
        if (waitingRow) {
          waitingRow.classList.remove('is-running');
          waitingRow.textContent = text;
        }
        if (log) log.scrollTop = log.scrollHeight;
        return seconds;
      },
      // 出错 / 提前收场时停表，别让定时器拖着。
      stop: () => {
        if (timer) clearInterval(timer);
        timer = 0;
        if (waitingRow) waitingRow.classList.remove('is-running');
      },
      elapsed,
    };
  }

  /**
   * 读一眼**编辑区自己那栏预览**：等它把稿子渲染出来、沙箱握完手，再数有几个没起来。
   *
   * 抽屉不再自己渲染一份（用户要的「直接在编辑区预览到」）：效果预览就是编辑器右边那一栏，
   * 这里只是**读**它。`mountSourceTools()` 的实时预览有 400ms 防抖，所以先轮询等
   * `iframe.doc-app-frame` 出现，再等过 2 秒看门狗，最后数被换成 `.doc-app-failed` 的 ——
   * 判定完全靠既有机制，`core/sandbox.js` 一行都不用改。
   */
  async function probeEditorTrial() {
    const box = wrap?.querySelector?.('[data-doc-preview]') ?? null;
    if (!box) return { total: 0, failed: 0, messages: [] };
    let frames = [];
    // 最多等 3 秒：实时预览有 400ms 防抖，本地渲染也就一两拍的事 —— 再等下去只是让
    // 「试跑的结论」迟迟不来。等不到就当这一稿没有会跑的小程序（下面返回全零）。
    for (let waited = 0; waited < 3000 && frames.length === 0; waited += 250) {
      await new Promise((resolve) => {
        setTimeout(resolve, 250);
      });
      frames = Array.from(box.querySelectorAll('iframe.doc-app-frame'));
    }
    if (frames.length === 0) return { total: 0, failed: 0, messages: [] };
    await new Promise((resolve) => {
      setTimeout(resolve, 2500);
    });
    const failed = Array.from(box.querySelectorAll('.doc-app-failed p'));
    return {
      total: frames.length,
      failed: failed.length,
      messages: failed.map((item) => String(item.textContent ?? '').trim()).filter(Boolean),
    };
  }

  /**
   * 发一次「整篇改写」：先摆对话气泡，拿到稿子就**立刻写进编辑区**，再看它跑不跑得起来，
   * 最后摆出「接受 / 拒绝」等作者点头（那之前编辑区是锁着的）。
   *
   * `instruction` 是作者那句话（或某条审查建议）。编辑区**可以是空的** ——
   * 空正文这一趟就是「从零写一篇」。服务端（`src/modules/ai/routes.js` 的整篇分支）
   * 也一并放行了空正文，两边都不再拦空编辑区。
   */
  async function draft(instruction) {
    const text = String(getText() ?? '');
    const fromScratch = text.trim() === '';
    say(`<div class="doc-ai-said">${esc(instruction)}</div>`);
    lastAsk = { kind: 'draft', instruction };
    const track = think('AI 正在处理');
    track.step(fromScratch ? '编辑区是空的 —— 按「从零写一篇」处理' : `读到编辑区正文 ${text.length} 字`);
    const busy = (on) => {
      if (sendBtn) sendBtn.disabled = on;
      if (reviewBtn) reviewBtn.disabled = on;
      if (!on) hint('');
    };
    busy(true);
    try {
      track.step('整理上下文，准备发给模型…');
      track.wait('等模型返回');
      const data = await api('/api/ai-edit/draft-range', {
        method: 'POST',
        body: { documentId, scope: 'document', markdown: text, instruction },
      });
      const model = String(data?.model ?? '') || '未署名';
      track.settle(`模型返回了（${model}），这一趟等了 ${track.elapsed()} 秒`);

      const patch = data?.patch ?? {};
      // 模型对作者说的那句话走**对话气泡**：它和改稿是两条通道（服务端提示词里写明了），
      // 所以这里既有「聊」也有「改」。
      const reply = typeof patch.reply === 'string' ? patch.reply.trim() : '';
      if (reply) say(`<div class="doc-ai-bubble">${esc(reply)}</div>`);
      // 形状纠正层替模型收拾过什么，明说 —— 静悄悄改形状是最难查的一类怪事。
      if (typeof data?.repairs === 'string' && data.repairs !== '') {
        track.step(`服务端把写歪的形状就地摆正了：${data.repairs}`);
      }

      if (patch.template) {
        track.stop();
        pending.push({ kind: 'template', key: String(patch.template), title: String(patch.title ?? '') });
        say(
          `<div class="doc-ai-card"><div class="doc-ai-card-head">模型选了站内模板「${esc(patch.template)}」</div>` +
            `<div class="doc-hint">套用会把整篇现有的块换成这个模板的块。</div>` +
            `<div class="doc-actions"><button class="btn btn-sm" type="button" data-doc-ai-apply="${pending.length - 1}">套用这个模板</button></div></div>`,
        );
        return;
      }

      const markdown = String(patch.markdown ?? '');
      if (markdown.trim() === '') {
        // 只答话、不改稿：服务端契约允许（给了 reply 就可以不带 markdown），
        // 这时候编辑区一个字都不动。
        track.stop();
        track.step('这一趟只回答问题，没有改动正文');
        return;
      }
      // 已经在等表态的那一稿：这一稿是**在它上面**接着改的（说给 AI 的话永远以编辑区
      // 此刻的内容为底），所以把链条的起点继承下来 —— 按「拒绝」退的是 AI 这一串改动
      // **之前**的正文，而不是退回上一句之前。旧卡片那两颗按钮随即作废，就地写明，
      // 免得作者点了早已作废的那一条。
      const previous = awaiting === null ? null : pending[awaiting];
      if (previous?.actions) {
        previous.actions.innerHTML = '<div class="doc-hint">这一稿已经被后面那句顶掉了。</div>';
      }
      const chainBefore = typeof previous?.before === 'string' ? previous.before : text;
      pending.push({ kind: 'draft', markdown, before: chainBefore });
      const writeIndex = pending.length - 1;

      // 立刻摆进编辑区：效果预览就是编辑器右边那一栏（同一套渲染、同一套沙箱，
      // 看得见也点得动）。抽屉里那点宽度看不出什么，不再另开一栏小预览。
      setText(markdown);
      awaiting = writeIndex;
      setLocked(true);
      track.step('已经写进编辑区 —— 右边那一栏就是它的效果预览');

      const buttons = [
        `<button class="btn btn-sm btn-primary" type="button" data-doc-ai-accept="${writeIndex}">接受</button>`,
        `<button class="btn btn-sm btn-ghost" type="button" data-doc-ai-reject="${writeIndex}">拒绝（退回改动前）</button>`,
      ];
      // 卡片**先摆出来**：编辑区里已经是这一稿了，两颗按钮立刻就能按 —— 试跑的结论晚一两秒
      // 再往同一张卡里填。不能让作者对着「等预览」干等：只改正文的稿子本来就没有小程序可跑。
      const turn = say(
        `<div class="doc-ai-card" data-doc-ai-pending>` +
          `<div class="doc-ai-card-head">AI 已经把这一稿写进编辑区了（模型 ${esc(model)}）</div>` +
          `<div class="doc-hint" data-doc-ai-trial>正在看这一稿在预览里跑不跑得起来…</div>` +
          diffHtml(text, markdown) +
          `<div class="doc-actions" data-doc-ai-actions>${buttons.join('')}</div>` +
          `<div class="doc-hint">先在上面按「接受」或「拒绝」—— 在那之前编辑区是锁着的，接着跟 AI 说话倒是可以（那是在这一稿上继续改）。落盘还是页面上那颗「保存」的事。</div>` +
          `</div>`,
      );
      const item = pending[writeIndex];
      const actions = turn?.querySelector?.('[data-doc-ai-actions]') ?? null;
      const trialLine = turn?.querySelector?.('[data-doc-ai-trial]') ?? null;
      if (item) item.actions = actions;

      // 顺手读一眼编辑器自己那栏预览：这一稿里的小程序到底跑没跑起来。
      track.wait('看这一稿在预览里跑不跑得起来');
      let trial = { total: 0, failed: 0, messages: [] };
      try {
        trial = await probeEditorTrial();
      } catch (error) {
        console.warn('[doc-ai] 没能读到编辑区预览的试跑结果：', error);
      }

      let trialText = '没读到预览的结果 —— 自己去右边那一栏点点看。';
      let reason = '';
      if (trial.failed > 0) {
        reason = trial.messages.join('；') || '小程序没有在 2 秒内握手，多半是脚本一开始就抛错了';
        track.settle(`试跑没过：${trial.total} 个小程序里有 ${trial.failed} 个没起来`);
        trialText = `预览里 ${trial.failed} 个小程序（共 ${trial.total} 个）没起来 —— ${reason}`;
      } else if (trial.total === 0) {
        track.settle('这一稿里没有会跑的小程序，跳过试跑');
        trialText = '这一稿里没有会跑的小程序。';
      } else {
        track.settle(`试跑通过：${trial.total} 个小程序全部起来了`);
        trialText = `试跑通过：${trial.total} 个小程序在右边预览里都跑起来了，可以直接点它试试。`;
      }
      if (trialLine) {
        trialLine.textContent = trialText;
        if (trial.failed > 0) trialLine.classList.add('doc-ai-trial-bad');
      }

      // 试跑没过：多给一条「让 AI 照着报错再改一版」的路（同样以编辑区此刻的内容为底）。
      // 只在作者还没表态时才补 —— 他要是刚才已经按了接受 / 拒绝，这张卡就不该再动了。
      if (trial.failed > 0 && awaiting === writeIndex) {
        const retryInstruction =
          `${instruction}\n\n（上一版在浏览器里试跑没通过：${reason}。` +
          '请改到能直接跑起来：不要依赖外部资源，事件要绑好，取到的元素先判空。）';
        pending.push({ kind: 'draft', markdown: '', suggestion: retryInstruction });
        const card = turn?.querySelector?.('[data-doc-ai-pending]') ?? null;
        if (card) card.classList.add('doc-ai-error');
        if (actions) {
          actions.innerHTML =
            buttons.join('') +
            `<button class="btn btn-sm btn-ghost" type="button" data-doc-ai-retry="${pending.length - 1}">按报错再改一次</button>`;
        }
      }
      hint('AI 已经写进编辑区了 —— 按「接受」或「拒绝」之后再手改。');
    } catch (error) {
      track.stop();
      say(errorCard(error));
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
    // 写完立刻给一颗回滚按钮：AI 的稿子进了编辑区之后，作者得能一键退回原来那份。
    say(
      `<div class="doc-ai-card"><div class="doc-ai-card-head">已写进编辑区</div>` +
        `<div class="doc-actions"><button class="btn btn-sm btn-ghost" type="button" data-doc-ai-rollback="${index}">回滚到修改前</button></div></div>`,
    );
  }

  /**
   * 回滚：把编辑区退回这一稿动手**之前**的正文（同样只改编辑器，不落盘）。
   *
   * 退回之后必须留一条**回去**的路（用户报的「回滚之后没法回滚回去」）：同一张卡里换出
   * 一颗「重做」，把 AI 这一稿原样放回来。两颗按钮互相切换，来回点多少次都行。
   */
  function rollback(index) {
    const item = pending[index];
    if (!item || typeof item.before !== 'string') {
      hint('这一稿没有留下可回退的底稿。');
      return;
    }
    setText(item.before);
    hint('已经退回 AI 动手之前的样子 —— 想反悔就按「重做」。同样没落盘，点「保存」才会写进去。');
    // 一般走 `item.actions`（新流水线里每张卡都留了抓手）；老卡片没挂抓手时，
    // 就地按那颗按钮往上找它所在的按钮区，同样换出「重做」。
    const box =
      item.actions ??
      root.querySelector?.(`[data-doc-ai-rollback="${index}"]`)?.closest?.('.doc-actions') ??
      null;
    if (box) {
      box.innerHTML = '<span class="doc-hint">已退回 AI 动手之前。</span>' + redoButtonHtml(index);
    }
  }

  /** 「重做」：把刚被退回的那一稿原样放回编辑区（`rollback()` 的反面）。 */
  function redo(index) {
    const item = pending[index];
    if (!item || typeof item.markdown !== 'string' || item.markdown === '') {
      hint('这一稿没有可以放回来的正文。');
      return;
    }
    setText(item.markdown);
    hint('已经把你退回的那一稿放回来了 —— 不想留就再按「回滚」。');
    const box =
      item.actions ??
      root.querySelector?.(`[data-doc-ai-redo="${index}"]`)?.closest?.('.doc-actions') ??
      null;
    if (box) {
      box.innerHTML = '<span class="doc-hint">已把 AI 这一稿放回来了。</span>' + rollbackButtonHtml(index);
    }
  }

  /** 「回滚到 AI 动手之前」那颗按钮（`accept()` / `redo()` 之后都摆它）。 */
  const rollbackButtonHtml = (index) =>
    `<button class="btn btn-sm btn-ghost" type="button" data-doc-ai-rollback="${index}">回滚到 AI 动手之前</button>`;

  /** 「重做」那颗按钮（`rollback()` / `reject()` 之后都摆它）。 */
  const redoButtonHtml = (index) =>
    `<button class="btn btn-sm btn-ghost" type="button" data-doc-ai-redo="${index}">重做（回到 AI 这一稿）</button>`;

  /** 只有**最新**那一稿的「接受 / 拒绝」算数（被后面那句顶掉的旧卡片按了不作数）。 */
  function isLive(index) {
    if (awaiting === null || index !== awaiting) {
      hint('这一稿已经被后面那句顶掉了 —— 看下面最新那一条。');
      return false;
    }
    return true;
  }

  /** 「接受」：这一稿留下（编辑区里已经是它了），解锁编辑区，让作者接着手改。 */
  function accept(index) {
    if (!isLive(index)) return;
    const item = pending[index];
    awaiting = null;
    setLocked(false);
    if (item?.actions) {
      item.actions.innerHTML = '<span class="doc-hint">已接受。</span>' + rollbackButtonHtml(index);
    }
    hint('已接受 —— 编辑区解锁了，接着改。落盘点页面上那颗「保存」。');
  }

  /** 「拒绝」：编辑区退回 AI 这一串改动**之前**的正文（不落盘），解锁编辑区。 */
  function reject(index) {
    if (!isLive(index)) return;
    const item = pending[index];
    awaiting = null;
    setLocked(false);
    if (item && typeof item.before === 'string') {
      // 退的是**最早**那份底稿：这一串里 AI 改过几轮都一样，作者要的是「AI 动手之前」。
      setText(item.before);
    }
    if (item?.actions) {
      // 拒绝同样是一次「退回去」，所以同样摆一颗「重做」：退错了还能放回来。
      item.actions.innerHTML = '<span class="doc-hint">已拒绝，编辑区退回 AI 动手之前的样子。</span>' + redoButtonHtml(index);
    }
    hint('已拒绝 —— 编辑区退回 AI 动手之前的样子（没落盘，点「保存」才会写进去）。');
  }

  /**
   * 「按报错再改一次」：拿着报错，在**当前编辑区**（也就是刚那一稿）上让 AI 再改一版。
   *
   * 不先退回：要修的是它自己刚写出来的东西，退回就等于把报错现场擦了。
   * 链条起点照旧继承，所以这一版仍能一键退到最初。
   */
  async function retry(index) {
    const item = pending[index];
    if (!item || typeof item.suggestion !== 'string') return;
    await draft(item.suggestion);
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
    const rollbackBtn = event.target?.closest?.('[data-doc-ai-rollback]');
    if (rollbackBtn && root.contains(rollbackBtn)) {
      rollback(Number(rollbackBtn.getAttribute('data-doc-ai-rollback')));
      return;
    }
    const redoBtn = event.target?.closest?.('[data-doc-ai-redo]');
    if (redoBtn && root.contains(redoBtn)) {
      redo(Number(redoBtn.getAttribute('data-doc-ai-redo')));
      return;
    }
    const acceptBtn = event.target?.closest?.('[data-doc-ai-accept]');
    if (acceptBtn && root.contains(acceptBtn)) {
      accept(Number(acceptBtn.getAttribute('data-doc-ai-accept')));
      return;
    }
    const rejectBtn = event.target?.closest?.('[data-doc-ai-reject]');
    if (rejectBtn && root.contains(rejectBtn)) {
      reject(Number(rejectBtn.getAttribute('data-doc-ai-reject')));
      return;
    }
    const retryBtn = event.target?.closest?.('[data-doc-ai-retry]');
    if (retryBtn && root.contains(retryBtn)) {
      void retry(Number(retryBtn.getAttribute('data-doc-ai-retry')));
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
      // 抽屉走了就把编辑区解锁：留着只读框会让人以为编辑器卡住了。
      setLocked(false);
      awaiting = null;
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
  awaiting = null;
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
 * 失败卡片。授权那条要给一颗**能点的按钮** —— 403 是作者最先撞上的墙（能力默认全关，
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
