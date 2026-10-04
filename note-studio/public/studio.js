/**
 * studio.js —— note-studio 编辑器前端（UI 装配层）。
 *
 * 渲染与统计在 render.js（window.NoteRender），本文件只负责：模式切换、输入规则、
 * 工具栏、侧栏四个面板、保存与导出。纯原生脚本，无构建步骤。
 */
(function () {
  'use strict';

  const API = '/api/notes';
  const DRAFT_KEY = 'note-studio:draft';
  const R = window.NoteRender;

  const $ = (id) => document.getElementById(id);

  /* ================================================================
   * 对外接口（给 AI 笔记工作台 note-agent 用）
   * ================================================================
   * studio.js 本来是个闭合的 IIFE，外面什么都拿不到。右侧那块 AI 工作台需要按
   * 「编辑器适配器」契约（getDoc / setDoc / onChange）读写这里的正文，所以下面
   * 把最小的一圈出口挂在 window.NoteStudio 上，并在正文变化时派发一个事件。
   * 面板只用这个事件刷新按钮状态、不同步草稿，所以多派发几次没有额外开销。
   */

  /** 通知外部「正文变了」。派发失败不影响编辑器自己。 */
  function announce() {
    try {
      window.dispatchEvent(new Event('note-studio:doc-changed'));
    } catch {
      /* 派发不了就算了：面板自己的状态不依赖宿主收到事件 */
    }
  }

  const WELCOME = [
    '# 欢迎使用 note-studio',
    '',
    '这是一个 **Markdown + LaTeX** 学术笔记编辑器：左边写，右边实时渲染。',
    '',
    '行内公式：$E = mc^2$；块级公式：',
    '',
    '$$',
    '\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}',
    '$$',
    '',
    '- [x] 支持源码 / 分栏 / 可视化三种模式',
    '- [ ] 试试「图片转写」把拍下来的笔记变成 Markdown',
    '',
    '| 能力 | 说明 |',
    '| --- | --- |',
    '| 导出 | 保存为 `.md` 与记录基础数据的 `.json` |',
    '| AI | 复用既有 `forum-ai` 接口 |',
    '',
  ].join('\n');

  const state = {
    name: '我的笔记',
    markdown: '',
    mode: 'split',
    online: false,
    ai: { configured: false, model: null },
    createdAt: null,
    updatedAt: null,
    meta: null,
    conversions: [],
    converted: null,
    previewVisible: readPref('note-studio:preview'),
    sidebarVisible: readPref('note-studio:sidebar'),
    // 默认页签本来是 'ai'。作者自带的「AI 助手」页签已下线（见 notes-host.css 顶部），
    // 整理 / 审阅改由右侧的 note-agent 工作台抽屉负责，所以默认落到「文件数据」。
    tab: 'info',
    convertOpen: false,
  };

  function readPref(key, fallback = true) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : raw !== '0';
    } catch {
      return fallback;
    }
  }

  const setStatus = (text) => { $('statusText').textContent = text; };

  function notify(message, kind) {
    const box = $('alert');
    if (!message) { box.hidden = true; return; }
    box.hidden = false;
    box.textContent = message;
    box.style.background = kind === 'error' ? 'rgba(255,123,114,.15)' : '';
  }

  const escapeHtml = (text) =>
    String(text ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

  /* ================================================================
   * 渲染入口
   * ================================================================ */

  function refreshPreview() {
    if (state.mode === 'wysiwyg') return;
    const { math } = R.renderInto($('preview'), state.markdown);
    $('renderStatus').textContent = math ? `已渲染 ${math} 个公式` : '无公式';
  }

  /* ================================================================
   * 可视化模式
   * ================================================================ */

  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
    strongDelimiter: '**',
  });
  if (window.turndownPluginGfm) turndown.use(turndownPluginGfm.gfm);

  const serializeEditable = R.createSerializer(turndown);

  /** contenteditable → Markdown（公式用占位符绕过 turndown 的反斜杠转义）。 */
  const serializeWysiwyg = () => serializeEditable($('wysiwyg'));

  function enterWysiwyg() {
    R.renderInto($('wysiwyg'), state.markdown);
    $('wysiwyg').hidden = false;
    $('source').hidden = true;
  }

  function leaveWysiwyg() {
    if (!$('wysiwyg').hidden) {
      state.markdown = serializeWysiwyg();
      $('source').value = state.markdown;
    }
    $('wysiwyg').hidden = true;
    $('source').hidden = false;
  }

  function caretBlock() {
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount) return null;
    let node = selection.getRangeAt(0).startContainer;
    const host = $('wysiwyg');
    while (node && node !== host && node.parentNode !== host) node = node.parentNode;
    return node === host ? null : node;
  }

  function placeCaret(element, atEnd = true) {
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(!atEnd);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  /** Typora-lite 输入规则：行首的 `# `、`- `、`> `、`1. `、``` 即时成形。 */
  function applyInputRule() {
    const block = caretBlock();
    if (!block || block.tagName === 'LI' || block.tagName === 'PRE') return;

    const text = block.textContent ?? '';
    const heading = text.match(/^(#{1,6})\s/);
    if (heading) return void replaceBlock(block, `h${heading[1].length}`, text.slice(heading[0].length));

    if (/^[-*+]\s/.test(text)) return void wrapInList(block, 'ul', text.slice(2));
    const ordered = text.match(/^(\d+)\.\s/);
    if (ordered) return void wrapInList(block, 'ol', text.slice(ordered[0].length));

    if (/^>\s/.test(text)) return void replaceBlock(block, 'blockquote', text.slice(2));

    const fence = text.match(/^```(\w*)$/);
    if (fence) {
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = '';
      pre.appendChild(code);
      block.replaceWith(pre);
      placeCaret(code);
    }
  }

  function replaceBlock(block, tagName, text) {
    const element = document.createElement(tagName);
    element.textContent = text;
    block.replaceWith(element);
    placeCaret(element);
  }

  function wrapInList(block, tagName, text) {
    const list = document.createElement(tagName);
    const item = document.createElement('li');
    item.textContent = text;
    list.appendChild(item);
    block.replaceWith(list);
    placeCaret(item);
  }

  /* ================================================================
   * 插入
   * ================================================================ */

  /** 在可视化编辑区插入文本；execCommand 在部分环境（含 jsdom）不可用，包一层保险。 */
  function insertAtCaret(text) {
    $('wysiwyg').focus();
    try {
      document.execCommand('insertText', false, text);
    } catch {
      /* 环境不支持 execCommand：忽略，正文仍以代码块/源码模式为准 */
    }
    state.markdown = serializeWysiwyg();
    $('source').value = state.markdown;
  }

  function insertText(text) {
    if (state.mode === 'wysiwyg') {
      insertAtCaret(text);
    } else {
      const area = $('source');
      const start = area.selectionStart ?? area.value.length;
      const end = area.selectionEnd ?? area.value.length;
      area.value = area.value.slice(0, start) + text + area.value.slice(end);
      area.focus();
      area.setSelectionRange(start + text.length, start + text.length);
      state.markdown = area.value;
    }
    scheduleUpdate();
    announce();
  }

  function surround(before, after = before) {
    const area = $('source');
    const start = area.selectionStart ?? 0;
    const end = area.selectionEnd ?? 0;
    const selected = area.value.slice(start, end) || '文字';
    area.value = area.value.slice(0, start) + before + selected + after + area.value.slice(end);
    area.focus();
    area.setSelectionRange(start + before.length, start + before.length + selected.length);
    state.markdown = area.value;
    scheduleUpdate();
  }

  const SNIPPETS = {
    h1: '\n# 一级标题\n',
    h2: '\n## 二级标题\n',
    h3: '\n### 三级标题\n',
    ul: '\n- 第一项\n- 第二项\n',
    ol: '\n1. 第一项\n2. 第二项\n',
    quote: '\n> 引用内容\n',
    code: '\n```js\nconsole.log("hello");\n```\n',
    table: '\n| 列 A | 列 B |\n| --- | --- |\n| 1 | 2 |\n',
  };

  function replaceAll(text) {
    state.markdown = text;
    $('source').value = text;
    if (state.mode === 'wysiwyg') enterWysiwyg();
    else refreshPreview();
    refreshInfo();
    persistDraft();
    announce();
  }

  /* ================================================================
   * API
   * ================================================================ */

  async function api(path, options = {}) {
    const response = await fetch(API + path, {
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      ...options,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || payload.ok !== true) {
      const error = new Error(payload?.error?.message || `请求失败（HTTP ${response.status}）`);
      error.code = payload?.error?.code || 'http_error';
      error.status = response.status;
      throw error;
    }
    return payload.data;
  }

  function describeError(error) {
    const map = {
      ai_not_configured: 'AI 未配置：请设置 AI_API_KEY，并把 AI_MODEL 指向支持图片的视觉模型。',
      ai_timeout: 'AI 接口超时，可以调大 AI_TIMEOUT_MS 后重试。',
      ai_rate_limited: 'AI 接口限流或额度不足，稍后再试。',
      ai_unauthorized: 'AI 接口鉴权失败，请检查 AI_API_KEY。',
      ai_unreachable: '连不上 AI 接口，请检查 AI_BASE_URL 与网络。',
      ai_bad_json: '模型没有按要求返回 JSON，可以重试一次。',
      unauthenticated: '请先登录。',
      forbidden: '没有权限执行该操作。',
      too_large: '内容太大，超过了服务端限制。',
      not_found: '对象不存在。',
    };
    return map[error.code] || error.message;
  }

  /* ================================================================
   * 文件数据面板
   * ================================================================ */

  function refreshInfo() {
    const meta = R.previewMeta(state.markdown, state.name, {
      conversions: state.conversions,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
    });
    state.previewMeta = meta;

    const rows = [
      ['字符数', meta.stats.characters],
      ['不含空白', meta.stats.charactersNoSpaces],
      ['词数', meta.stats.words],
      ['中文字数', meta.stats.cjkCharacters],
      ['行数 / 非空行', `${meta.stats.lines} / ${meta.stats.nonEmptyLines}`],
      ['段落', meta.stats.paragraphs],
      ['阅读时长', `${meta.stats.readingMinutes} 分钟`],
      ['标题', meta.structure.headings.length],
      ['公式（行内/块级）', `${meta.math.inline} / ${meta.math.display}`],
      ['代码块', meta.code.fences],
      ['表格', meta.tables],
      ['任务', `${meta.tasks.checked}/${meta.tasks.total}`],
      ['图片 / 链接', `${meta.media.images} / ${meta.media.links}`],
      ['字节数', meta.file.bytes],
    ];
    $('statsTable').innerHTML = rows.map(([label, value]) => `<tr><td>${label}</td><td>${value}</td></tr>`).join('');

    $('outline').innerHTML = meta.structure.headings.length
      ? meta.structure.headings
          .map((heading) => `<li class="lvl-${Math.min(heading.level, 3)}">${escapeHtml(heading.text)}</li>`)
          .join('')
      : '<li class="empty">暂无标题</li>';

    $('statusStats').textContent = `${meta.stats.characters} 字 · ${meta.structure.headings.length} 标题 · ${meta.math.total} 公式`;
  }

  /* ================================================================
   * 模式 / 输入
   * ================================================================ */

  function setMode(mode) {
    if (state.mode === 'wysiwyg' && mode !== 'wysiwyg') leaveWysiwyg();
    state.mode = mode;

    document.querySelectorAll('.mode').forEach((button) => button.classList.toggle('active', button.dataset.mode === mode));
    $('editorTitle').textContent = `编辑 · ${{ source: '源码', split: '分栏', wysiwyg: '可视化' }[mode]}`;
    $('statusMode').textContent = { source: '源码模式', split: '分栏模式', wysiwyg: '可视化模式' }[mode];

    if (mode === 'wysiwyg') enterWysiwyg();
    else refreshPreview();
    applyLayout();
    // 换模式可能改了正文的序列化形式（可视化 ↔ 源码），所以也当一次变化报出去
    announce();
  }

  /**
   * 布局：预览与侧栏各自可开可关；**收起就是 display:none，一点空间都不占**。
   *
   * 所有开关按钮都在左侧功能栏（#toolbar）：👁 预览 / 🤖 AI 助手 / 🗂 文件数据 / ⛶ 只留编辑。
   * 打开后它们在右侧竖排；窄屏（<1000px）下改为贴右侧的抽屉，也不会横在下方。
   */
  function applyLayout() {
    const main = document.querySelector('main');
    main.classList.toggle('no-preview', !state.previewVisible);
    main.classList.toggle('no-sidebar', !state.sidebarVisible);
    $('previewPane').classList.toggle('collapsed', !state.previewVisible);
    $('sidebar').classList.toggle('collapsed', !state.sidebarVisible);

    const onlyEditor = !state.previewVisible && !state.sidebarVisible;
    $('btnPreview').classList.toggle('active', state.previewVisible);
    // 这里原本还有一行 $('btnAi')，随「AI 助手」页签一起下线了。
    // 按钮都从 HTML 里删了还去取 .classList 会直接抛错，整个编辑器白屏 —— 别再写回来。
    $('btnData').classList.toggle('active', state.sidebarVisible && state.tab === 'info');
    $('btnFocus').classList.toggle('active', onlyEditor);

    try {
      localStorage.setItem('note-studio:preview', state.previewVisible ? '1' : '0');
      localStorage.setItem('note-studio:sidebar', state.sidebarVisible ? '1' : '0');
    } catch {
      /* 隐私模式忽略 */
    }
  }

  function togglePreview(visible) {
    state.previewVisible = visible == null ? !state.previewVisible : visible;
    applyLayout();
    setStatus(state.previewVisible ? '已打开实时预览（右侧竖排）' : '已收起预览：不占空间，点工具栏「👁 预览」再打开');
  }

  function toggleSidebar(visible) {
    state.sidebarVisible = visible == null ? !state.sidebarVisible : visible;
    applyLayout();
    setStatus(state.sidebarVisible ? '已打开侧栏（右侧竖排）' : '已收起侧栏：不占空间，点工具栏「🤖 AI 助手」或「🗂 文件数据」再打开');
  }

  /** 切换侧栏页签。 */
  function selectTab(name) {
    state.tab = name;
    document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === name));
    document.querySelectorAll('.tab-body').forEach((body) => body.classList.toggle('active', body.dataset.body === name));
    applyLayout();
  }

  /** 工具栏上的「AI 助手 / 文件数据」：打开侧栏并切到该页签；已是该页签则收起。 */
  function toggleSidebarTab(name) {
    if (state.sidebarVisible && state.tab === name) {
      toggleSidebar(false);
      return;
    }
    selectTab(name);
    if (state.sidebarVisible) applyLayout();
    else toggleSidebar(true);
  }

  function toggleFocus() {
    const onlyEditor = !state.previewVisible && !state.sidebarVisible;
    state.previewVisible = onlyEditor;
    state.sidebarVisible = onlyEditor;
    applyLayout();
    setStatus(onlyEditor ? '已恢复「编辑 + 预览 + 侧栏」' : '只留编辑栏：预览与侧栏都收起了');
  }

  /** 图片转写面板挂在编辑工具栏下，可折叠，不再单独占一栏。 */
  function toggleConvert(open) {
    state.convertOpen = open == null ? !state.convertOpen : open;
    $('convertPanel').hidden = !state.convertOpen;
    $('btnConvertToggle').classList.toggle('active', state.convertOpen);
    if (state.convertOpen) setStatus('图片转写：先选择一张图片');
  }

  let timer = null;
  function scheduleUpdate() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (state.mode !== 'wysiwyg') refreshPreview();
      refreshInfo();
      persistDraft();
    }, 200);
  }

  function onSourceInput() {
    state.markdown = $('source').value;
    scheduleUpdate();
    announce();
  }

  function persistDraft() {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({
        name: state.name,
        markdown: state.markdown,
        createdAt: state.createdAt,
        updatedAt: new Date().toISOString(),
        conversions: state.conversions,
      }));
    } catch {
      /* 隐私模式下忽略 */
    }
  }

  function restoreDraft() {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) return false;
      const draft = JSON.parse(raw);
      if (typeof draft.markdown !== 'string') return false;
      state.markdown = draft.markdown;
      state.name = draft.name || state.name;
      state.createdAt = draft.createdAt || null;
      state.conversions = Array.isArray(draft.conversions) ? draft.conversions : [];
      return true;
    } catch {
      return false;
    }
  }

  /* ================================================================
   * 图片转写
   * ================================================================ */

  let pendingImage = null;

  function setImage(file) {
    if (!file || !String(file.type).startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => {
      pendingImage = { name: file.name || '剪贴板图片', size: file.size, dataUrl: reader.result };
      $('imageInfo').textContent = `${pendingImage.name} · ${(file.size / 1024).toFixed(1)} KB`;
      $('btnConvert').disabled = false;
      $('dropZone').classList.add('ready');
    };
    reader.readAsDataURL(file);
  }

  function progress(value, text) {
    $('progress').hidden = value === null;
    $('progressFill').style.width = `${Math.round((value ?? 0) * 100)}%`;
    $('progressText').textContent = text ?? '';
  }

  function showResult(key, value) {
    $('resultBox').value = value ?? '';
    document.querySelectorAll('.subtab').forEach((tab) => tab.classList.toggle('active', tab.dataset.result === key));
  }

  async function convertImage() {
    if (!pendingImage) return;
    try {
      $('btnConvert').disabled = true;
      progress(0.35, '正在把图片交给 AI 识别…');
      setStatus('图片转写中…');

      const data = await api('/convert', {
        method: 'POST',
        body: JSON.stringify({
          dataUrl: pendingImage.dataUrl,
          kind: $('convertKind').value,
          hint: $('convertHint').value.trim(),
          source: pendingImage.name,
        }),
      });

      state.converted = data;
      showResult($('convertKind').value === 'latex' ? 'latex' : 'markdown', data.markdown || data.latex);
      progress(1, '完成');
      setStatus(`图片转写完成（模型：${data.model || '未知'}）`);

      state.conversions.push({
        kind: data.kind,
        model: data.model ?? null,
        at: data.at ?? new Date().toISOString(),
        source: pendingImage.name,
      });
      renderConvertLog();
      refreshInfo();
      persistDraft();
    } catch (error) {
      progress(null);
      notify(describeError(error), 'error');
      setStatus('图片转写失败');
    } finally {
      $('btnConvert').disabled = false;
      setTimeout(() => progress(null), 900);
    }
  }

  function renderConvertLog() {
    $('convertLog').innerHTML = state.conversions.length
      ? state.conversions
          .map((item) => `<li>${escapeHtml(item.source || '图片')} → ${{ both: 'Markdown + LaTeX', markdown: 'Markdown', latex: 'LaTeX' }[item.kind] || item.kind} · ${escapeHtml(item.model || '未记录模型')}</li>`)
          .join('')
      : '<li class="empty">还没有转换记录</li>';
  }

  /* ================================================================
   * AI 助手
   * ================================================================ */

  async function runOrganize() {
    const box = $('aiResult');
    try {
      box.innerHTML = '<p class="empty">AI 正在整理…</p>';
      setStatus('AI 整理中…');
      const data = await api('/ai/organize', {
        method: 'POST',
        body: JSON.stringify({ title: state.name, content: state.markdown }),
      });

      box.innerHTML = `
        <div class="ai-card">
          <h4>建议标题</h4>
          <p>${escapeHtml(data.title)}</p>
          <h4>摘要</h4>
          <p>${escapeHtml(data.summary) || '<span class="hint">（无）</span>'}</p>
          <h4>知识点</h4>
          <div class="tagline">${data.knowledgePoints.map((item) => `<span class="tag">${escapeHtml(item)}</span>`).join('') || '<span class="hint">（无）</span>'}</div>
          <h4>标签</h4>
          <div class="tagline">${data.tags.map((item) => `<span class="tag">${escapeHtml(item)}</span>`).join('') || '<span class="hint">（无）</span>'}</div>
          <h4>建议大纲</h4>
          <ol>${data.outline.map((item) => `<li>${escapeHtml(item)}</li>`).join('') || '<li class="hint">（无）</li>'}</ol>
          <div class="row">
            <button type="button" class="btn small" id="btnApplyTitle">只用标题</button>
            <button type="button" class="btn small primary" id="btnApplyMarkdown" ${data.suggestedMarkdown ? '' : 'disabled'}>应用整理后的正文</button>
          </div>
        </div>`;

      $('btnApplyTitle').onclick = () => {
        state.name = data.title;
        $('fileName').value = data.title;
        setStatus('已应用建议标题');
      };
      $('btnApplyMarkdown').onclick = () => {
        replaceAll(data.suggestedMarkdown);
        setStatus('已应用整理后的正文');
      };
      setStatus(`AI 整理完成（模型：${data.model || '未知'}）`);
    } catch (error) {
      box.innerHTML = `<p class="empty">${escapeHtml(describeError(error))}</p>`;
      setStatus('AI 整理失败');
    }
  }

  async function runReview() {
    const box = $('aiResult');
    try {
      box.innerHTML = '<p class="empty">AI 正在审阅…</p>';
      setStatus('AI 审阅中…');
      const data = await api('/ai/review', {
        method: 'POST',
        body: JSON.stringify({ title: state.name, content: state.markdown }),
      });

      const levelText = { major: '重要', minor: '次要', info: '提示' };
      box.innerHTML = `
        <div class="ai-card">
          <h4>评分</h4>
          <div class="score">${data.score ?? '—'}<span class="hint"> / 100</span></div>
          <h4>写得好的地方</h4>
          <ul>${data.strengths.map((item) => `<li>${escapeHtml(item)}</li>`).join('') || '<li class="hint">（无）</li>'}</ul>
          <h4>问题与建议</h4>
          ${data.issues
            .map(
              (issue) => `<div class="issue ${issue.level}">
                <div><b>${escapeHtml(issue.where || '整体')}</b> · ${escapeHtml(levelText[issue.level] || '提示')}</div>
                <div>${escapeHtml(issue.problem)}</div>
                <div class="hint">建议：${escapeHtml(issue.suggestion)}</div>
              </div>`,
            )
            .join('') || '<p class="hint">（没有发现问题）</p>'}
          <h4>整体建议</h4>
          <ul>${data.suggestions.map((item) => `<li>${escapeHtml(item)}</li>`).join('') || '<li class="hint">（无）</li>'}</ul>
        </div>`;
      setStatus(`AI 审阅完成（模型：${data.model || '未知'}）`);
    } catch (error) {
      box.innerHTML = `<p class="empty">${escapeHtml(describeError(error))}</p>`;
      setStatus('AI 审阅失败');
    }
  }

  /* ================================================================
   * 保存 / 导出
   * ================================================================ */

  async function saveToServer() {
    try {
      setStatus('保存中…');
      const data = await api('', {
        method: 'POST',
        body: JSON.stringify({
          name: state.name,
          markdown: state.markdown,
          createdAt: state.createdAt,
          updatedAt: state.updatedAt,
          ai: state.conversions,
        }),
      });

      state.name = data.name;
      state.meta = data.meta;
      state.createdAt = data.meta.timestamps.createdAt;
      state.updatedAt = data.meta.timestamps.updatedAt;
      $('fileName').value = data.name;
      $('jsonView').textContent = JSON.stringify(data.meta, null, 2);

      notify(`已保存两个文件：${data.files.markdown} 与 ${data.files.meta}`);
      setStatus('已保存到服务器');
      persistDraft();
      refreshNotes();
    } catch (error) {
      notify(describeError(error), 'error');
      setStatus('保存失败');
    }
  }

  async function sha256(text) {
    try {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    } catch {
      return null;
    }
  }

  async function clientMeta() {
    const meta = R.previewMeta(state.markdown, state.name, {
      conversions: state.conversions,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
    });
    meta.file.sha256 = await sha256(state.markdown);
    meta.timestamps.savedAt = new Date().toISOString();
    return meta;
  }

  /** 触发浏览器下载。有些环境没有 object URL（例如被策略禁用），失败要能说清楚而不是抛错。 */
  function download(filename, text, mime) {
    try {
      const url = URL.createObjectURL(new Blob([text], { type: mime }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return true;
    } catch (error) {
      return false;
    }
  }

  const exportFailed = '当前浏览器不允许直接下载：可改用「保存到服务器」，或换 Chrome/Edge 打开';

  const downloadMarkdown = () => {
    const ok = download(`${R.slugify(state.name)}.md`, state.markdown, 'text/markdown; charset=utf-8');
    if (!ok) setStatus(exportFailed);
    return ok;
  };

  async function downloadJson() {
    const meta = state.meta && !state.meta.preview ? state.meta : await clientMeta();
    const ok = download(`${R.slugify(state.name)}.json`, `${JSON.stringify(meta, null, 2)}\n`, 'application/json');
    setStatus(ok ? '已导出 .json' : exportFailed);
    return ok;
  }

  async function downloadBoth() {
    const ok = downloadMarkdown();
    setTimeout(downloadJson, 250);
    if (ok) setStatus('已导出 .md 与 .json');
  }

  /* ================================================================
   * 笔记列表
   * ================================================================ */

  async function refreshNotes() {
    if (!state.online) {
      $('notesList').innerHTML = '<li class="empty">离线草稿模式：连上本地服务后才能列出</li>';
      return;
    }
    try {
      const data = await api('');
      $('notesList').innerHTML = data.notes.length
        ? data.notes
            .map((note) => `<li><span class="title" data-open="${escapeHtml(note.name)}">${escapeHtml(note.title || note.name)}</span><span class="meta">${note.bytes} B</span></li>`)
            .join('')
        : '<li class="empty">列表为空</li>';

      $('notesList').querySelectorAll('[data-open]').forEach((node) => {
        node.onclick = () => openNote(node.dataset.open);
      });
    } catch (error) {
      $('notesList').innerHTML = `<li class="empty">${escapeHtml(describeError(error))}</li>`;
    }
  }

  async function openNote(name) {
    try {
      const data = await api(`/${encodeURIComponent(name)}`);
      state.name = data.name;
      state.markdown = data.markdown;
      state.meta = data.meta;
      state.createdAt = data.meta.timestamps?.createdAt ?? null;
      state.updatedAt = data.meta.timestamps?.updatedAt ?? null;
      $('fileName').value = data.name;
      $('source').value = data.markdown;
      $('jsonView').textContent = JSON.stringify(data.meta, null, 2);
      if (state.mode === 'wysiwyg') enterWysiwyg();
      else refreshPreview();
      refreshInfo();
      persistDraft();
      setStatus(`已打开 ${data.name}`);
      announce();
    } catch (error) {
      notify(describeError(error), 'error');
    }
  }

  async function deleteCurrent() {
    if (!state.online) return;
    if (!window.confirm(`删除「${state.name}」的 .md 与 .json？`)) return;
    try {
      await api(`/${encodeURIComponent(R.slugify(state.name))}`, { method: 'DELETE' });
      setStatus('已删除');
      refreshNotes();
    } catch (error) {
      notify(describeError(error), 'error');
    }
  }

  /* ================================================================
   * 绑定与启动
   * ================================================================ */

  function bind() {
    document.querySelectorAll('.mode').forEach((button) => { button.onclick = () => setMode(button.dataset.mode); });

    document.querySelectorAll('.tab').forEach((tab) => { tab.onclick = () => selectTab(tab.dataset.tab); });

    document.querySelectorAll('.subtab').forEach((tab) => {
      tab.onclick = () => {
        if (!state.converted) return;
        showResult(tab.dataset.result, state.converted[tab.dataset.result] ?? '');
      };
    });

    $('source').addEventListener('input', onSourceInput);

    $('wysiwyg').addEventListener('input', () => {
      applyInputRule();
      state.markdown = serializeWysiwyg();
      $('source').value = state.markdown;
      scheduleUpdate();
      announce();
    });

    $('wysiwyg').addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey) return;
      const block = caretBlock();
      if (block && block.tagName === 'LI' && (block.textContent ?? '').trim() === '') {
        event.preventDefault();
        const paragraph = document.createElement('div');
        paragraph.innerHTML = '<br>';
        block.closest('ul, ol').after(paragraph);
        placeCaret(paragraph, false);
      }
    });

    $('wysiwyg').addEventListener('paste', (event) => {
      event.preventDefault();
      const text = (event.clipboardData || window.clipboardData).getData('text/plain');
      insertAtCaret(text);
    });

    document.querySelectorAll('[data-cmd]').forEach((button) => {
      button.onclick = () => {
        const command = button.dataset.cmd;
        if (state.mode === 'wysiwyg') {
          try {
            if (command === 'code') document.execCommand('insertHTML', false, '<code>代码</code>');
            else document.execCommand(command, false, null);
          } catch {
            /* 环境不支持 execCommand：忽略 */
          }
          state.markdown = serializeWysiwyg();
          $('source').value = state.markdown;
          scheduleUpdate();
          return;
        }
        if (command === 'bold') surround('**');
        else if (command === 'italic') surround('*');
        else if (command === 'strikeThrough') surround('~~');
        else surround('`');
      };
    });

    document.querySelectorAll('[data-block]').forEach((button) => {
      button.onclick = () => insertText(SNIPPETS[button.dataset.block] ?? '');
    });

    document.querySelectorAll('[data-insert]').forEach((button) => {
      button.onclick = () => {
        const kind = button.dataset.insert;
        if (kind === 'link') insertText('[链接文字](https://example.com)');
        else if (kind === 'inline-math') insertText('$E = mc^2$');
        else insertText('\n$$\n\\int_0^1 x\\,dx = \\frac{1}{2}\n$$\n');
      };
    });

    $('fileName').addEventListener('input', () => { state.name = $('fileName').value; scheduleUpdate(); });

    $('btnNew').onclick = () => {
      state.markdown = '';
      state.name = '新笔记';
      state.createdAt = new Date().toISOString();
      state.conversions = [];
      state.meta = null;
      $('fileName').value = state.name;
      $('source').value = '';
      $('jsonView').textContent = '（保存一次后显示）';
      renderConvertLog();
      if (state.mode === 'wysiwyg') enterWysiwyg();
      else refreshPreview();
      refreshInfo();
      persistDraft();
    };

    $('btnSave').onclick = saveToServer;
    $('btnDownloadMd').onclick = downloadMarkdown;
    $('btnDownloadJson').onclick = downloadJson;
    $('btnDownloadBoth').onclick = downloadBoth;

    $('btnConvertToggle').onclick = () => toggleConvert();
    $('btnCloseConvert').onclick = () => toggleConvert(false);
    $('btnPreview').onclick = () => togglePreview();
    $('btnHidePreview').onclick = () => togglePreview(false);
    // $('btnAi') 已随「AI 助手」页签下线（HTML 里也删了），在这里再绑会抛错。
    $('btnData').onclick = () => toggleSidebarTab('info');
    $('btnFocus').onclick = () => toggleFocus();

    $('dropZone').onclick = () => $('imageInput').click();
    $('dropZone').addEventListener('keydown', (event) => { if (event.key === 'Enter') $('imageInput').click(); });
    $('imageInput').addEventListener('change', (event) => setImage(event.target.files[0]));
    $('btnConvert').onclick = convertImage;
    $('btnInsertResult').onclick = () => insertText(`\n${$('resultBox').value}\n`);
    $('btnReplaceAll').onclick = () => replaceAll($('resultBox').value);
    $('btnCopyResult').onclick = async () => {
      await navigator.clipboard.writeText($('resultBox').value);
      setStatus('已复制到剪贴板');
    };

    ['dragenter', 'dragover'].forEach((type) => {
      $('dropZone').addEventListener(type, (event) => { event.preventDefault(); $('dropZone').classList.add('drag'); });
    });
    ['dragleave', 'drop'].forEach((type) => {
      $('dropZone').addEventListener(type, (event) => { event.preventDefault(); $('dropZone').classList.remove('drag'); });
    });
    $('dropZone').addEventListener('drop', (event) => setImage(event.dataTransfer.files[0]));
    document.addEventListener('paste', (event) => {
      const item = [...(event.clipboardData?.items ?? [])].find((entry) => entry.type.startsWith('image/'));
      if (item) {
        setImage(item.getAsFile());
        setStatus('已从剪贴板读入图片');
      }
    });

    // $('btnOrganize') / $('btnReview') 已随「AI 助手」页签下线。
    // runOrganize / runReview 两个函数还留在文件里（改动越小越好），但已无人调用。
    // 想彻底清干净可以把上面「AI 助手」那一整节删掉，并顺手去掉 note-studio 接线层里的
    // /api/notes/ai/organize 与 /api/notes/ai/review 两条路由。

    $('btnCopyJson').onclick = async () => {
      await navigator.clipboard.writeText(JSON.stringify(state.meta ?? (await clientMeta()), null, 2));
      setStatus('已复制 JSON');
    };
    $('btnRefreshNotes').onclick = refreshNotes;
    $('btnDeleteNote').onclick = deleteCurrent;
  }

  /* ================================================================
   * 给 AI 笔记工作台（note-agent）的出口
   * ================================================================
   * 注意 getMarkdown() 必须返回**源文本**（$…$ 与 ![]() 原样保留），不能返回渲染后的
   * HTML —— 面板与审校都按源文本工作，返回 HTML 会把公式整个弄丢。
   */

  window.NoteStudio = {
    version: '1',

    /** 当前正文的源文本。可视化模式下先从 contenteditable 序列化回来。 */
    getMarkdown() {
      return state.mode === 'wysiwyg' ? serializeWysiwyg() : $('source').value;
    },

    getTitle() {
      return state.name ?? '';
    },

    setTitle(title) {
      state.name = title;
      $('fileName').value = title;
      announce();
    },

    /** 写回正文。mode='append' 时追加，默认替换。 */
    setMarkdown(markdown, mode = 'replace') {
      const text = String(markdown ?? '');
      const next = mode === 'append' ? `${window.NoteStudio.getMarkdown()}${text}` : text;
      // 可视化模式下 $('source') 是隐藏的，replaceAll 里的 enterWysiwyg() 会拿它重渲染；
      // 但 state.markdown 得先跟界面同步，否则切回源码模式会看到旧内容。
      if (state.mode === 'wysiwyg') leaveWysiwyg();
      replaceAll(next);
      scheduleUpdate();
    },

    /** 订阅正文变化。返回的取消函数幂等、可重复调用。 */
    subscribe(callback) {
      const handler = () => callback({ title: window.NoteStudio.getTitle(), markdown: window.NoteStudio.getMarkdown() });
      window.addEventListener('note-studio:doc-changed', handler);
      return () => window.removeEventListener('note-studio:doc-changed', handler);
    },
  };

  async function boot() {
    bind();

    if (typeof marked === 'undefined' || typeof katex === 'undefined' || !R) {
      notify('离线渲染库没有加载成功：请确认 vendor/ 与 render.js 完整。', 'error');
      return;
    }

    if (restoreDraft()) {
      setStatus('已恢复上次的草稿');
    } else {
      state.markdown = WELCOME;
      state.createdAt = new Date().toISOString();
    }
    $('fileName').value = state.name;
    $('source').value = state.markdown;

    renderConvertLog();
    setMode('split');
    refreshInfo();
    persistDraft();

    try {
      const status = await api('/status');
      state.online = true;
      state.ai = status.ai;
      notify(status.ai.configured ? '' : '编辑器可用；设置 AI_API_KEY（并把 AI_MODEL 指向视觉模型）后，图片转写与 AI 助手才会生效。');
      refreshNotes();
      setStatus(`就绪 · AI：${status.ai.configured ? status.ai.model : '未配置'}`);
    } catch {
      state.online = false;
      notify('离线草稿模式：可以直接编辑并导出 .md / .json；保存到服务器与 AI 功能需要本地服务。');
      setStatus('离线草稿模式');
      refreshNotes();
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
