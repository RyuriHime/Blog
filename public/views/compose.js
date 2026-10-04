// 发帖/编辑页，以及右侧的 AI 笔记抽屉（note-studio panel）。

import { $, emptyHtml, esc, loadingHtml, ui } from '../core/dom.js';
import { api } from '../core/api.js';
import { navigate } from '../core/router.js';
import { state } from '../core/state.js';
import * as Avatar from '../core/avatar.js';
import * as Fmt from '../core/format.js';
import * as Session from '../core/session.js';
import * as Widgets from '../core/widgets.js';

async function viewCompose(postId) {
  ui.app.innerHTML = loadingHtml();
  if (!state.me) {
    state.redirect = postId ? `/edit/${postId}` : '/new';
    navigate('/login');
    return;
  }
  let post = null;
  if (postId) {
    const data = await api(`/api/posts/${postId}`);
    post = data.post;
    if (post.author.id !== state.me.id && state.me.role !== 'admin') {
      ui.app.innerHTML = `<div class="card">${emptyHtml('🚫', '没有权限编辑这个帖子')}</div>`;
      return;
    }
  }

  let categories = [];
  try {
    categories = (await api('/api/me/categories')).items;
  } catch {
    categories = [];
  }

  ui.app.innerHTML = `
    <section class="card">
      <div class="card-head">
        <h1 style="font-size:20px">${post ? '✏️ 编辑帖子' : '✏️ 发布新帖'}</h1>
        <a class="tag" href="${post ? `#/post/${post.id}` : '#/'}">取消</a>
      </div>
      <form class="form" id="composeForm" data-action="compose" data-id="${post?.id ?? ''}">
        <div class="field">
          <label for="boardId">选择板块</label>
          <select id="boardId" name="boardId" required>${Widgets.boardOptions(post?.board.id)}</select>
        </div>
        <div class="field">
          <label for="categoryId">个人主页分类（可选）</label>
          <select id="categoryId" name="categoryId">
            <option value="">未分类</option>
            ${categories
              .map(
                (category) =>
                  `<option value="${category.id}" ${post?.category?.id === category.id ? 'selected' : ''}>🗂 ${esc(category.name)}</option>`,
              )
              .join('')}
          </select>
          <span class="hint">分类只影响你个人主页的归类，去 <a href="#/u/${encodeURIComponent(state.me.username)}">我的主页</a> 可以新建或整理分类。</span>
        </div>
        <label class="checkbox-row">
          <input type="checkbox" name="profilePinned" value="1" ${post?.profilePinned ? 'checked' : ''} />
          <span>📌 在我的个人主页置顶推荐（每篇最多 ${Fmt.profileRules().pinLimit} 篇置顶）</span>
        </label>
        <div class="field">
          <label for="title">标题</label>
          <input id="title" name="title" type="text" required minlength="2" maxlength="80"
                 placeholder="一句话说清楚你要讨论什么" value="${esc(post?.title ?? '')}" />
        </div>
        <div class="field">
          <label for="content">正文</label>
          <div class="md-toolbar">
            <button class="btn btn-sm btn-ghost" type="button" data-action="md" data-md="bold"><b>B</b></button>
            <button class="btn btn-sm btn-ghost" type="button" data-action="md" data-md="italic"><i>I</i></button>
            <button class="btn btn-sm btn-ghost" type="button" data-action="md" data-md="code">代码</button>
            <button class="btn btn-sm btn-ghost" type="button" data-action="md" data-md="block">代码块</button>
            <button class="btn btn-sm btn-ghost" type="button" data-action="md" data-md="quote">引用</button>
            <button class="btn btn-sm btn-ghost" type="button" data-action="md" data-md="list">列表</button>
            <button class="btn btn-sm btn-ghost" type="button" data-action="md" data-md="link">链接</button>
            <button class="btn btn-sm btn-ghost" type="button" data-action="md" data-md="mention">@提及</button>
          </div>
          <textarea id="content" name="content" required maxlength="20000"
                    placeholder="详细描述你的问题或想法…">${esc(post?.content ?? '')}</textarea>
        </div>
        <div class="preview-box" data-preview hidden></div>
        <div class="form-actions">
          <button class="btn btn-primary" type="submit">${post ? '保存修改' : '发布帖子'}</button>
          <button class="btn btn-ghost" type="button" data-action="preview" data-target="compose">预览</button>
          <span class="hint">发布后会自动通知你的关注者</span>
        </div>
      </form>
      <!-- AI 笔记工作台（note-agent）的挂载点。
           刻意放在 </form> **外面**：面板里有一个 <input type="text"> 的「要求」输入框，
           放进表单里按回车会被浏览器当成提交，直接把帖子发出去。
           抽屉本体是 position: fixed，放哪儿都不占布局。 -->
      <div id="notesMount" class="notes-mount"></div>
    </section>`;

  mountComposeNotesPanel(post?.id ?? null);
}

/* ------------------------------------------------------------------ */
/* AI 笔记工作台（note-agent）：写作页的挂载与销毁                      */
let composeNotesPanel = null;
function destroyComposeNotesPanel() {
  if (!composeNotesPanel) return;
  try {
    composeNotesPanel.destroy();
  } catch (error) {
    console.warn('[notes-agent] 工作台销毁失败：', error);
  }
  composeNotesPanel = null;
}
function mountComposeNotesPanel(postId) {
  const mount = document.getElementById('notesMount');
  const root = document.getElementById('composeForm');
  if (!mount || !root) return;
  if (window.NotesAgent) {
    try {
      composeNotesPanel = window.NotesAgent.attach({
        mount,
        editor: window.NotesAgent.createTextareaAdapter(root),
        postId: postId ?? null,
      });
    } catch (error) {
      console.warn('[notes-agent] 工作台挂载失败：', error);
      composeNotesPanel = null;
    }
  }
}

/* ------------------------------------------------------------------ */
/* 视图：登录 / 注册                                                   */
function lockCoinButton(button, message, hintNode) {
  button.dataset.coinLocked = '1';
  button.dataset.coinHint = message;
  button.setAttribute('aria-disabled', 'true');
  button.title = message;
  if (!button.classList.contains('is-locked')) button.classList.add('is-locked');
  if (hintNode) {
    hintNode.textContent = message;
  } else {
    button.insertAdjacentHTML('afterend', `<span class="coin-locked-hint">${esc(message)}</span>`);
  }
}
function applyMarkdown(kind, textarea) {
  if (!textarea) return;
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const value = textarea.value;
  const selected = value.slice(start, end);
  const wrap = (prefix, suffix, placeholder) => {
    const inner = selected || placeholder;
    textarea.value = `${value.slice(0, start)}${prefix}${inner}${suffix}${value.slice(end)}`;
    textarea.focus();
    textarea.setSelectionRange(start + prefix.length, start + prefix.length + inner.length);
  };
  const prefixLines = (template) => {
    const inner = selected || '内容';
    const block = inner
      .split('\n')
      .map((line) => template.replace('$1', line))
      .join('\n');
    textarea.value = `${value.slice(0, start)}${block}${value.slice(end)}`;
    textarea.focus();
    textarea.setSelectionRange(start, start + block.length);
  };

  if (kind === 'bold') wrap('**', '**', '粗体');
  else if (kind === 'italic') wrap('*', '*', '斜体');
  else if (kind === 'code') wrap('`', '`', 'code');
  else if (kind === 'block') wrap('\n```js\n', '\n```\n', '// 在这里写代码');
  else if (kind === 'quote') prefixLines('> $1');
  else if (kind === 'list') prefixLines('- $1');
  else if (kind === 'link') wrap('[', '](https://example.com)', '链接文字');
  else if (kind === 'mention') wrap('@', ' ', 'username');
}

/** 用浏览器把图片等比压缩到 256×256 再转 dataURL，避免上传大图 */
function compressImageFile(file, maxSize = 256) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error('这个文件不是有效的图片'));
      image.onload = () => {
        try {
          const side = Math.min(image.width, image.height);
          const sx = Math.max(0, Math.floor((image.width - side) / 2));
          const sy = Math.max(0, Math.floor((image.height - side) / 2));
          const target = Math.min(maxSize, side);
          const canvas = document.createElement('canvas');
          canvas.width = target;
          canvas.height = target;
          const context = canvas.getContext('2d');
          context.drawImage(image, sx, sy, side, side, 0, 0, target, target);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
          resolve({ dataUrl, size: Math.round((dataUrl.length - 'data:image/jpeg;base64,'.length) * 0.75) });
        } catch (error) {
          reject(error);
        }
      };
      image.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

/** 头像更新后：刷新全局用户状态、顶栏、侧栏与设置页预览 */
function applyAvatarResult(result) {
  if (state.me && result?.user) {
    state.me = { ...state.me, avatar: result.user.avatar, displayName: result.user.displayName };
  }
  Session.renderUserArea();
  Session.renderSidebar();
  const preview = document.querySelector('.avatar-preview');
  if (preview && state.me) {
    preview.innerHTML = `${Avatar.avatarHtml(state.me, 'avatar-lg')}<span class="hint">当前头像</span>`;
  }
}

// ── 导出 ──────────────────────────────────────────────────────────────
export { composeNotesPanel };
export { destroyComposeNotesPanel };
export { mountComposeNotesPanel };
export { viewCompose };
export { applyMarkdown };
export { applyAvatarResult };
export { compressImageFile };
export { lockCoinButton };

/* @hand-written */
