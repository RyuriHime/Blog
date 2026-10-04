/**
 * 操作样例的应用逻辑（手写文件，不经任何生成器）。
 *
 * 数据来自同目录的 playground-data.js（生成产物，只含样例笔记与样例照片的 data URL）。
 * 依赖：vendor/ 下的 marked / KaTeX / turndown，以及 render.js。
 */
(function () {
  'use strict';

  var R = window.NoteRender;
  var DATA = window.PLAYGROUND_DATA || { markdown: '', photo: '' };
  var $ = function (id) { return document.getElementById(id); };

  function readPref(key, fallback = true) {
    try {
      var raw = localStorage.getItem(key);
      return raw === null ? fallback : raw !== '0';
    } catch (error) {
      return fallback;
    }
  }

  var state = {
    mode: 'split',
    markdown: DATA.markdown,
    photo: null,
    converted: null,
    online: false,
    previewVisible: readPref('playground:preview'),
    sidebarVisible: readPref('playground:sidebar'),
    convertOpen: false
  };
  var setStatus = function (text) { $('status').textContent = text; };

  /* ---------------- 渲染 ---------------- */

  function render() {
    if (state.mode === 'wysiwyg') return;
    var result = R.renderInto($('preview'), state.markdown);
    $('renderHint').textContent = result.math ? '已渲染 ' + result.math + ' 个公式' : '无公式';
  }

  /* ---------------- 三种模式 ---------------- */

  var turndown = new TurndownService({
    headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-',
    emDelimiter: '*', strongDelimiter: '**'
  });
  if (window.turndownPluginGfm) turndown.use(window.turndownPluginGfm.gfm);
  var serialize = R.createSerializer(turndown);

  function setMode(mode) {
    if (state.mode === 'wysiwyg' && mode !== 'wysiwyg') {
      state.markdown = serialize($('wysiwyg'));
      $('source').value = state.markdown;
    }
    state.mode = mode;
    document.querySelectorAll('#modeSeg button').forEach(function (button) {
      button.classList.toggle('active', button.dataset.mode === mode);
    });
    var wysiwyg = mode === 'wysiwyg';
    $('wysiwyg').hidden = !wysiwyg;
    $('source').hidden = wysiwyg;
    if (wysiwyg) {
      R.renderInto($('wysiwyg'), state.markdown);
      $('editHint').textContent = '所见即所得：直接改，切回源码时回落成 Markdown';
    } else {
      render();
      $('editHint').textContent = '';
    }
    applyLayout();
  }

  /* ---------------- 布局：预览与侧栏各自可开可关 ---------------- */

  /**
   * 布局：预览与右侧栏各自可开可关；**收起就是 display:none，一点空间都不占**。
   * 开关都在左侧功能栏（#toolbar）；打开后在右侧竖排，窄屏下改为贴右侧的抽屉。
   */
  function applyLayout() {
    var main = document.querySelector('main');
    main.classList.toggle('no-preview', !state.previewVisible);
    main.classList.toggle('no-sidebar', !state.sidebarVisible);
    $('previewPane').classList.toggle('collapsed', !state.previewVisible);
    $('sidebar').classList.toggle('collapsed', !state.sidebarVisible);

    var onlyEditor = !state.previewVisible && !state.sidebarVisible;
    $('btnPreview').classList.toggle('active', state.previewVisible);
    $('btnSidebar').classList.toggle('active', state.sidebarVisible);
    $('btnFocus').classList.toggle('active', onlyEditor);

    try {
      localStorage.setItem('playground:preview', state.previewVisible ? '1' : '0');
      localStorage.setItem('playground:sidebar', state.sidebarVisible ? '1' : '0');
    } catch (error) {
      /* 忽略 */
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
    setStatus(state.sidebarVisible ? '已打开右侧栏（竖排）' : '已收起右侧栏：不占空间，点工具栏「🗂 文件数据」再打开');
  }

  function toggleFocus() {
    var onlyEditor = !state.previewVisible && !state.sidebarVisible;
    state.previewVisible = onlyEditor;
    state.sidebarVisible = onlyEditor;
    applyLayout();
    setStatus(onlyEditor ? '已恢复三栏' : '只留编辑栏：预览与右侧栏都收起了');
  }

  /* ---------------- 图片转写面板（在左侧工具栏里） ---------------- */

  function toggleConvert(open) {
    state.convertOpen = open == null ? !state.convertOpen : open;
    $('convertPanel').hidden = !state.convertOpen;
    $('btnConvertToggle').classList.toggle('active', state.convertOpen);
    if (state.convertOpen) setStatus('图片转写：先载入一张图片');
  }

  /* ---------------- 统计与 JSON ---------------- */

  function sha256(text) {
    if (!window.crypto || !window.crypto.subtle) return Promise.resolve(null);
    return window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
      .then(function (buffer) {
        return Array.prototype.map.call(new Uint8Array(buffer), function (byte) {
          return byte.toString(16).padStart(2, '0');
        }).join('');
      })
      .catch(function () { return null; });
  }

  function buildMeta() {
    var meta = R.previewMeta(state.markdown, 'playground-sample', { conversions: [] });
    return sha256(state.markdown).then(function (hash) {
      meta.file.sha256 = hash;
      meta.timestamps.savedAt = new Date().toISOString();
      return meta;
    });
  }

  function refreshData() {
    var meta = R.previewMeta(state.markdown, 'playground-sample', { conversions: [] });
    var rows = [
      ['字符数', meta.stats.characters],
      ['词数', meta.stats.words],
      ['中文字数', meta.stats.cjkCharacters],
      ['行数 / 非空行', meta.stats.lines + ' / ' + meta.stats.nonEmptyLines],
      ['段落', meta.stats.paragraphs],
      ['阅读时长', meta.stats.readingMinutes + ' 分钟'],
      ['标题', meta.structure.headings.length],
      ['公式（行内/块级）', meta.math.inline + ' / ' + meta.math.display],
      ['代码块', meta.code.fences],
      ['表格', meta.tables],
      ['任务', meta.tasks.checked + '/' + meta.tasks.total],
      ['图片 / 链接', meta.media.images + ' / ' + meta.media.links],
      ['字节数', meta.file.bytes]
    ];
    $('stats').innerHTML = rows.map(function (row) {
      return '<tr><td>' + row[0] + '</td><td>' + row[1] + '</td></tr>';
    }).join('');
    buildMeta().then(function (full) { $('jsonView').textContent = JSON.stringify(full, null, 2); });
  }

  /* ---------------- 编辑：插入片段 / 包裹选区 ---------------- */

  var SNIPPETS = {
    h2: '\n## 小标题\n',
    ul: '\n- 第一项\n- 第二项\n',
    ol: '\n1. 第一项\n2. 第二项\n',
    quote: '\n> 引用内容\n',
    code: '\n```js\nconsole.log(1);\n```\n',
    table: '\n| 列 A | 列 B |\n| --- | --- |\n| 1 | 2 |\n',
    math: '$E = mc^2$',
    mathblock: '\n$$\n\\int_0^1 x\\,dx = \\frac{1}{2}\n$$\n'
  };

  function insertAtCursor(text) {
    if (state.mode === 'wysiwyg') {
      $('wysiwyg').focus();
      try { document.execCommand('insertText', false, text); } catch (error) { /* 浏览器差异 */ }
      state.markdown = serialize($('wysiwyg'));
    } else {
      var area = $('source');
      var start = area.selectionStart == null ? area.value.length : area.selectionStart;
      var end = area.selectionEnd == null ? area.value.length : area.selectionEnd;
      area.value = area.value.slice(0, start) + text + area.value.slice(end);
      state.markdown = area.value;
      try { area.setSelectionRange(start + text.length, start + text.length); } catch (error) { /* 忽略 */ }
    }
    $('source').value = state.markdown;
    render();
    refreshData();
    setStatus('已插入');
  }

  function wrapSelection(kind) {
    var mark = kind === 'bold' ? '**' : '*';
    if (state.mode === 'wysiwyg') {
      try { document.execCommand(kind === 'bold' ? 'bold' : 'italic', false, null); } catch (error) { /* 浏览器差异 */ }
      state.markdown = serialize($('wysiwyg'));
      $('source').value = state.markdown;
    } else {
      var area = $('source');
      var start = area.selectionStart == null ? area.value.length : area.selectionStart;
      var end = area.selectionEnd == null ? start : area.selectionEnd;
      var picked = area.value.slice(start, end) || '文字';
      area.value = area.value.slice(0, start) + mark + picked + mark + area.value.slice(end);
      state.markdown = area.value;
      try { area.setSelectionRange(start + mark.length, start + mark.length + picked.length); } catch (error) { /* 忽略 */ }
    }
    render();
    refreshData();
    setStatus(kind === 'bold' ? '已加粗' : '已斜体');
  }

  /* ---------------- 导出 ---------------- */

  function download(name, text, mime) {
    try {
      var url = URL.createObjectURL(new Blob([text], { type: mime }));
      var anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = name;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      return true;
    } catch (error) {
      return false;
    }
  }

  function exportMarkdown() {
    return download('playground-sample.md', state.markdown, 'text/markdown; charset=utf-8');
  }

  function exportJson() {
    return buildMeta().then(function (meta) {
      return download('playground-sample.json', JSON.stringify(meta, null, 2) + '\n', 'application/json');
    });
  }

  /* ---------------- 图片转写 ---------------- */

  function setConvertNote(text, kind) {
    $('convertNote').className = 'note' + (kind ? ' ' + kind : '');
    $('convertNote').textContent = text;
  }

  function usePhoto(dataUrl, label) {
    state.photo = dataUrl;
    $('photo').src = dataUrl;
    $('photo').hidden = false;
    $('btnConvert').disabled = false;
    setStatus('已载入图片：' + label);
  }

  /** 固定应答：只演示「转写 → 插入 → 导出」这条链路，页面会明确标注它不是真实识别。 */
  function simulated(kind) {
    var markdown = [
      '# 电磁感应实验记录',
      '',
      '线圈匝数 $N = 200$，磁铁快速插入与抽出。',
      '',
      '$$',
      '\\varepsilon = -N \\frac{\\mathrm{d}\\Phi}{\\mathrm{d}t}',
      '$$',
      '',
      '- [x] 插入磁铁：$t = 0.20\\ \\mathrm{s}$，峰值 $1.84\\ \\mathrm{V}$',
      '- [x] 抽出磁铁：$t = 0.18\\ \\mathrm{s}$，峰值 $1.92\\ \\mathrm{V}$',
      '',
      '结论：感应电动势与磁通量变化率成正比，方向由楞次定律决定。'
    ].join('\n');
    var latex = '\\varepsilon = -N \\frac{\\mathrm{d}\\Phi}{\\mathrm{d}t}';
    return {
      markdown: kind === 'latex' ? '' : markdown,
      latex: kind === 'markdown' ? '' : latex,
      model: 'simulated',
      usage: { prompt: 0, completion: 0 }
    };
  }

  function showResult(data, note, warn) {
    state.converted = data;
    $('convertOut').textContent = data.markdown || data.latex;
    $('convertOut').hidden = false;
    $('insertRow').hidden = false;
    setConvertNote(note, warn ? 'warn' : 'ok');
    setStatus('转写完成');
  }

  function convert() {
    if (!state.photo) return;
    var kind = $('kind').value;
    $('btnConvert').disabled = true;
    setConvertNote('转写中…');

    if (!state.online) {
      setTimeout(function () {
        showResult(simulated(kind), '离线模式：这是**明确标注的固定应答**，只演示「转写 → 插入 → 导出」链路；真实识别请用本地服务打开本页', true);
        $('btnConvert').disabled = false;
      }, 300);
      return;
    }

    fetch('/api/notes/convert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataUrl: state.photo, kind: kind, source: 'playground' })
    }).then(function (response) {
      return response.json().then(function (payload) { return { status: response.status, payload: payload }; });
    }).then(function (result) {
      var payload = result.payload || {};
      if (payload.ok) {
        showResult(payload.data, '真实接口（既有 forum-ai）· 模型 ' + (payload.data.model || '未记录'), false);
        return;
      }
      var code = payload.error ? payload.error.code : 'http_' + result.status;
      if (code === 'unauthenticated') {
        setConvertNote('服务返回 401：需要先登录（请在论坛里登录后再打开本页）', 'warn');
      } else if (code === 'ai_not_configured') {
        showResult(simulated(kind), '真实接口返回 503 ai_not_configured（没配 AI_API_KEY）：下面是固定应答，只演示流程', true);
      } else {
        setConvertNote('接口返回 ' + code + '：' + (payload.error ? payload.error.message : ''), 'warn');
      }
    }).catch(function (error) {
      showResult(simulated(kind), '请求失败（' + error.message + '）：展示固定应答', true);
    }).then(function () {
      $('btnConvert').disabled = false;
    });
  }

  /* ---------------- 绑定 ---------------- */

  $('source').addEventListener('input', function () {
    state.markdown = $('source').value;
    render();
    refreshData();
  });

  $('wysiwyg').addEventListener('input', function () {
    state.markdown = serialize($('wysiwyg'));
    $('source').value = state.markdown;
    refreshData();
  });

  document.querySelectorAll('#modeSeg button').forEach(function (button) {
    button.onclick = function () { setMode(button.dataset.mode); };
  });

  document.querySelectorAll('#toolbar [data-snippet]').forEach(function (button) {
    button.onclick = function () { insertAtCursor(SNIPPETS[button.dataset.snippet] || ''); };
  });

  document.querySelectorAll('#toolbar [data-wrap]').forEach(function (button) {
    button.onclick = function () { wrapSelection(button.dataset.wrap); };
  });

  $('btnConvertToggle').onclick = function () { toggleConvert(); };
  $('btnCloseConvert').onclick = function () { toggleConvert(false); };

  $('btnPreview').onclick = function () { togglePreview(); };
  $('btnHidePreview').onclick = function () { togglePreview(false); };
  $('btnSidebar').onclick = function () { toggleSidebar(); };
  $('btnFocus').onclick = function () { toggleFocus(); };

  $('btnSample').onclick = function () {
    state.markdown = DATA.markdown;
    $('source').value = state.markdown;
    setMode(state.mode);
    refreshData();
    setStatus('已载入样例笔记');
  };
  $('btnClear').onclick = function () {
    state.markdown = '';
    $('source').value = '';
    setMode(state.mode);
    refreshData();
    setStatus('已清空');
  };

  $('btnMd').onclick = function () { setStatus(exportMarkdown() ? '已导出 .md' : '导出被浏览器拦截'); };
  $('btnJson').onclick = function () { exportJson().then(function (ok) { setStatus(ok ? '已导出 .json' : '导出被浏览器拦截'); }); };
  $('btnBoth').onclick = function () { exportMarkdown(); exportJson().then(function () { setStatus('已导出 .md 与 .json'); }); };

  $('btnLoadSamplePhoto').onclick = function () {
    // 从工具栏按钮进来时面板可能刚打开；这里再确保它是展开的
    if (!state.convertOpen) toggleConvert(true);
    usePhoto(DATA.photo, '样例照片（实验笔记）');
  };
  $('btnPickPhoto').onclick = function () { $('fileInput').click(); };
  $('fileInput').onchange = function (event) {
    var file = event.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () { usePhoto(reader.result, file.name); };
    reader.readAsDataURL(file);
  };
  $('btnConvert').onclick = convert;
  $('btnInsert').onclick = function () { if (state.converted) insertAtCursor('\n' + $('convertOut').textContent + '\n'); };
  $('btnReplace').onclick = function () {
    if (!state.converted) return;
    state.markdown = $('convertOut').textContent;
    $('source').value = state.markdown;
    setMode(state.mode);
    refreshData();
    setStatus('已替换全文');
  };
  $('btnCopyJson').onclick = function () {
    buildMeta().then(function (meta) {
      return navigator.clipboard.writeText(JSON.stringify(meta, null, 2));
    }).then(function () { setStatus('已复制 JSON'); }).catch(function () { setStatus('复制失败（浏览器限制）'); });
  };

  /* ---------------- 启动 ---------------- */

  $('source').value = state.markdown;
  setMode('split');
  refreshData();

  var badge = $('modeBadge');
  if (location.protocol === 'http:' || location.protocol === 'https:') {
    fetch('/api/notes/status').then(function (response) { return response.json(); }).then(function (payload) {
      state.online = true;
      var ai = payload && payload.data ? payload.data.ai : null;
      badge.className = 'badge online';
      badge.textContent = ai && ai.configured
        ? '服务端模式 · AI 已配置（' + ai.model + '）'
        : '服务端模式 · AI 未配置（转写会返回 503，将展示固定应答）';
      setStatus('已连接本地服务：图片转写走真实接口');
    }).catch(function () {
      badge.className = 'badge offline';
      badge.textContent = '离线模式 · 编辑/渲染/导出可用，转写为固定应答';
      setStatus('离线模式：建议用本地服务打开以走真实 AI 接口');
    });
  } else {
    badge.className = 'badge offline';
    badge.textContent = '离线模式 · 编辑/渲染/导出可用，转写为固定应答';
    setStatus('离线模式（file://）：编辑与导出可用；用本地服务打开即可走真实 AI 接口');
  }
})();
