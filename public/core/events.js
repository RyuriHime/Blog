// 全局事件委托：整个前端只有这一处 click / submit / change 监听。
// 
// 为什么这样设计：19 个视图都是把 HTML 字符串赋给 ui.app.innerHTML，元素随时被
// 整体替换，逐元素 addEventListener 会随替换一起丢。所以统一在 document 上委托，
// 靠 data-action="xxx" 属性分发。新增动作 = 在下面的 switch 里加一个 case。

import { $, copyText, esc, toast, ui } from './dom.js';
import { api, withButtonBusy } from './api.js';
import { apiErrorText, toastError } from './errors.js';
import { state } from './state.js';
import * as Admin from '../views/admin.js';
import * as Ai from '../views/ai.js';
import * as Compose from '../views/compose.js';
import * as Fmt from './format.js';
import * as Message from '../views/messages.js';
import * as Notif from '../views/notifications.js';
// 公式排版复用站点原本那一套（离线 KaTeX，见 views/notes.js）。
// 下面 `case 'preview'` 会把预览 HTML 塞进 DOM，而那个接口**从不排公式**，
// 只把 `$…$` 原样吐出来 —— 少了这一句，「预览」里的公式就是一段源码。
import { ntRenderMath } from '../views/notes.js';
import * as Post from '../views/post.js';
import * as Prefs from './preferences.js';
import * as Router from './router.js';
import * as Session from './session.js';
import * as Settings from '../views/settings.js';
import * as Theme from './theme.js';
import * as User from '../views/user.js';

function closeMenus() {
  for (const menu of document.querySelectorAll('.menu')) menu.hidden = true;
}
const closeMenu = closeMenus;
document.addEventListener('click', async (event) => {
  const actionNode = event.target.closest('[data-action]');

  if (!actionNode) {
    closeMenus();
    return;
  }
  const action = actionNode.dataset.action;

  // 点菜单内部不关闭，点其它任何地方都收起
  if (!['toggle-menu', 'toggle-theme-menu'].includes(action) && actionNode.closest('.menu') === null) {
    closeMenus();
  }

  try {
    switch (action) {
      case 'toggle-menu': {
        event.preventDefault();
        const userMenu = $('#user-menu');
        if (userMenu) {
          const willOpen = userMenu.hidden;
          closeMenus();
          userMenu.hidden = !willOpen;
        }
        break;
      }
      case 'toggle-theme-menu': {
        event.preventDefault();
        const themeMenu = $('#theme-menu');
        if (themeMenu) {
          const willOpen = themeMenu.hidden;
          closeMenus();
          themeMenu.hidden = !willOpen;
        }
        break;
      }
      case 'set-theme': {
        event.preventDefault();
        Theme.applyTheme(actionNode.dataset.theme);
        closeMenus();
        break;
      }
      case 'set-avatar-emoji': {
        if (!Session.requireLogin('登录后才能设置头像')) break;
        const result = await withButtonBusy(actionNode, () =>
          api('/api/me/avatar', {
            method: 'POST',
            body: { type: 'emoji', emoji: actionNode.dataset.emoji, hue: Number(actionNode.dataset.hue) },
          }),
        );
        Compose.applyAvatarResult(result);
        toast('头像已更新（预设表情）', 'success');
        break;
      }
      case 'reset-avatar': {
        if (!Session.requireLogin('登录后才能设置头像')) break;
        const result = await withButtonBusy(actionNode, () => api('/api/me/avatar', { method: 'POST', body: { type: 'reset' } }));
        Compose.applyAvatarResult(result);
        toast('已恢复默认头像（昵称首字母）', 'success');
        break;
      }
      case 'logout': {
        await api('/api/auth/logout', { method: 'POST' });
        state.me = null;
        state.unread = 0;
        Session.renderUserArea();
        Session.renderSidebar();
        toast('已退出登录', 'success');
        Router.navigate('/');
        break;
      }
      case 'reaction': {
        if (!Session.requireLogin('登录后才能评价')) break;
        const postId = Number(actionNode.dataset.id);
        const kind = actionNode.dataset.kind;
        const result = await withButtonBusy(actionNode, () =>
          api(`/api/posts/${postId}/reaction`, { method: 'POST', body: { kind } }),
        );
        const bar = actionNode.closest('.action-bar');
        const likeButton = bar?.querySelector('[data-action="reaction"][data-kind="like"]');
        const dislikeButton = bar?.querySelector('[data-action="reaction"][data-kind="dislike"]');
        if (likeButton) {
          likeButton.classList.toggle('is-on', result.liked);
          const label = likeButton.querySelector('[data-like-label]');
          if (label) label.textContent = result.liked ? '已赞' : '赞';
          const count = likeButton.querySelector('[data-like-count]');
          if (count) count.textContent = result.likeCount;
        }
        if (dislikeButton) {
          dislikeButton.classList.toggle('is-on-danger', result.disliked);
          const label = dislikeButton.querySelector('[data-dislike-label]');
          if (label) label.textContent = result.disliked ? '已踩' : '踩';
          const count = dislikeButton.querySelector('[data-dislike-count]');
          if (count) count.textContent = result.dislikeCount;
        }
        break;
      }
      case 'toggle-category-form': {
        event.preventDefault();
        const categoryForm = document.querySelector('form[data-action="create-category"]');
        if (categoryForm) {
          categoryForm.hidden = !categoryForm.hidden;
          if (!categoryForm.hidden) categoryForm.querySelector('input')?.focus();
        }
        break;
      }
      case 'rename-category': {
        const currentName = actionNode.dataset.name;
        const nextName = prompt('重命名分类', currentName);
        if (!nextName || nextName === currentName) break;
        await api(`/api/me/categories/${actionNode.dataset.id}`, { method: 'PUT', body: { name: nextName } });
        toast('分类已重命名', 'success');
        await refreshProfile();
        break;
      }
      case 'delete-category': {
        if (!confirm(`删除分类「${actionNode.dataset.name}」？文章不会被删除，只是回到「未分类」。`)) break;
        await withButtonBusy(actionNode, () => api(`/api/me/categories/${actionNode.dataset.id}`, { method: 'DELETE' }));
        toast('分类已删除，文章回到「未分类」', 'success');
        await refreshProfile();
        break;
      }
      case 'repost-toggle': {
        if (!Session.requireLogin('登录后才能转发')) break;
        const box = document.querySelector('#repost-section textarea[name="comment"]');
        if (!box) {
          toast('这篇文章暂时不能转发', 'error');
          break;
        }
        box.scrollIntoView({ behavior: 'smooth', block: 'center' });
        box.focus();
        break;
      }
      case 'repost-cancel': {
        const repostPostId = Number(actionNode.dataset.id);
        if (!confirm('撤销转发？你主页上的这条转发会消失。')) break;
        await withButtonBusy(actionNode, () => api(`/api/posts/${repostPostId}/repost`, { method: 'DELETE' }));
        toast('已撤销转发', 'success');
        await Post.viewPost(repostPostId);
        break;
      }
      case 'copy-link': {
        const linkPostId = Number(actionNode.dataset.id);
        const shareUrl = `${location.origin}${location.pathname}#/post/${linkPostId}`;
        // 走 copyText 而不是直接 navigator.clipboard：线上是明文 http，
        // 那个对象只在安全上下文里存在，直接调会一路掉进 catch 弹 prompt（见 core/dom.js）。
        if (await copyText(shareUrl)) toast('链接已复制，发给朋友吧 🔗', 'success');
        else window.prompt('复制这个链接：', shareUrl);
        break;
      }
      case 'profile-pin': {
        const postId = Number(actionNode.dataset.id);
        const wantPinned = actionNode.dataset.pinned !== '1';
        const result = await withButtonBusy(actionNode, () =>
          api(`/api/posts/${postId}/profile-pin`, { method: 'POST', body: { pinned: wantPinned } }),
        );
        toast(wantPinned ? `已置顶推荐（${result.pinnedCount}/${result.pinLimit}）` : '已取消置顶', 'success');
        await refreshProfile();
        break;
      }
      case 'profile-layout': {
        event.preventDefault();
        Prefs.writePreference('forum:Prefs.profileLayout', actionNode.dataset.layout);
        await refreshProfile();
        break;
      }
      case 'coin': {        const postId = Number(actionNode.dataset.id);
        // 服务端已经算好能不能投，这里只负责把原因说清楚，绝不留一个「点了没反应」的按钮
        if (actionNode.dataset.coinLocked === '1') {
          if (actionNode.dataset.coinReason === 'anonymous') {
            Session.requireLogin('登录后才能投币');
            break;
          }
          toast(actionNode.dataset.coinHint || '暂时不能投币', 'error');
          break;
        }
        const result = await withButtonBusy(actionNode, () =>
          api(`/api/posts/${postId}/coin`, { method: 'POST', body: { amount: 1 } }),
        );
        if (state.me) state.me.coinBalance = result.balance;

        const count = actionNode.querySelector('[data-coin-count]');
        if (count) count.textContent = result.coinCount;
        const mine = actionNode.querySelector('[data-my-coins]');
        if (mine) mine.innerHTML = ` <span class="tag tag-soft">我投了 ${result.myCoins}</span>`;
        actionNode.classList.add('is-on-coin');

        const bar = actionNode.closest('.action-bar');
        const budget = bar?.querySelector('[data-coin-budget]');
        if (budget) budget.textContent = `可用 ${result.balance} 币`;

        // 达到单帖上限或余额用尽时，把按钮切换成「锁定但可解释」的状态
        const limit = Number(actionNode.dataset.limit ?? result.perPostLimit);
        const hint = bar?.querySelector('.coin-locked-hint');
        if (result.myCoins >= limit) {
          Compose.lockCoinButton(actionNode, `这篇帖子你已经投满 ${limit} 币了`, hint);
        } else if (result.balance <= 0) {
          Compose.lockCoinButton(actionNode, '币不够了：等别人给你的文章投币，攒够了再来', hint);
        }

        Session.renderSidebar();
        toast(`投币成功，感谢支持作者！剩余 ${result.balance} 币 🪙`, 'success');
        break;
      }
      case 'bookmark': {
        if (!Session.requireLogin('登录后才能收藏')) break;
        const postId = Number(actionNode.dataset.id);
        const result = await withButtonBusy(actionNode, () =>
          api(`/api/posts/${postId}/bookmark`, { method: 'POST' }),
        );
        actionNode.classList.toggle('is-on', result.bookmarked);
        actionNode.innerHTML = `${result.bookmarked ? '★ 已收藏' : '☆ 收藏'} <span data-bookmark-count>${result.bookmarkCount}</span>`;
        toast(result.bookmarked ? '已加入收藏' : '已取消收藏', 'success');
        break;
      }
      case 'block-user': {
        if (!Session.requireLogin('登录后可以拉黑用户')) break;
        const userId = Number(actionNode.dataset.id);
        const name = actionNode.dataset.name ?? '该用户';
        const willBlock = actionNode.dataset.blocked !== '1';
        if (
          willBlock &&
          !confirm(`拉黑「${name}」？\n\nTA 将无法：关注你、给你发私信、查看你发的文章。\n同时会解除你们之间的关注关系。`)
        ) {
          break;
        }
        const result = await withButtonBusy(actionNode, () =>
          api(`/api/users/${userId}/block`, { method: 'POST', body: { blocked: willBlock } }),
        );
        toast(willBlock ? `已拉黑 ${name}` : `已解除对 ${name} 的拉黑`, 'success');
        void result;
        const { path: currentPath } = Router.parseHash();
        if (currentPath.startsWith('/settings')) await Settings.viewSettings();
        else await User.viewUser(currentUsername(), new URLSearchParams());
        break;
      }
      case 'follow': {
        if (!Session.requireLogin('登录后才能关注作者')) break;
        const userId = Number(actionNode.dataset.user);
        const result = await withButtonBusy(actionNode, () =>
          api(`/api/users/${userId}/follow`, { method: 'POST' }),
        );
        toast(result.following ? `已关注 ${actionNode.dataset.name ?? 'TA'}` : '已取消关注', 'success');
        if (actionNode.classList.contains('btn-primary')) {
          actionNode.classList.toggle('btn-primary', !result.following);
        }
        actionNode.classList.toggle('is-on', result.following);
        actionNode.textContent = result.following ? '✓ 已关注' : '＋ 关注';
        if (document.querySelector('.profile-head')) await User.viewUser(currentUsername(), new URLSearchParams());
        break;
      }
      case 'open-notification': {
        const id = Number(actionNode.dataset.id);
        if (actionNode.classList.contains('is-unread')) {
          api(`/api/notifications/${id}/read`, { method: 'POST' })
            .then((result) => {
              state.unread = result.unread;
              Session.renderUserArea();
            })
            .catch(() => {});
        }
        break;
      }
      case 'read-notification': {
        const id = Number(actionNode.dataset.id);
        const result = await api(`/api/notifications/${id}/read`, { method: 'POST' });
        state.unread = result.unread;
        actionNode.classList.remove('is-unread');
        actionNode.querySelector('.notif-dot')?.remove();
        Session.renderUserArea();
        break;
      }
      case 'read-all': {
        const result = await api('/api/notifications/read-all', { method: 'POST' });
        state.unread = result.unread ?? 0;
        toast('已全部标为已读', 'success');
        await Notif.viewNotifications(Router.parseHash().query);
        break;
      }
      case 'delete-post': {
        if (!confirm('确定删除这个帖子吗？此操作不可撤销。')) break;
        const postId = Number(actionNode.dataset.id);
        await withButtonBusy(actionNode, () => api(`/api/posts/${postId}`, { method: 'DELETE' }));
        toast('帖子已删除', 'success');
        if (actionNode.dataset.back === 'admin') Router.route();
        else Router.navigate('/');
        break;
      }
      case 'delete-reply': {
        if (!confirm('确定删除这条回复吗？')) break;
        await withButtonBusy(actionNode, () => api(`/api/replies/${actionNode.dataset.id}`, { method: 'DELETE' }));
        toast('回复已删除', 'success');
        await Post.viewPost(Number(actionNode.dataset.post));
        break;
      }
      case 'hide-post': {
        if (!state.me || !Fmt.isStaffUser(state.me)) {
          toast('只有管理团队可以隐藏文章', 'error');
          break;
        }
        const postId = Number(actionNode.dataset.id);
        const willHide = actionNode.dataset.hidden !== '1';
        let reason = '';
        if (willHide) {
          const answer = prompt('隐藏这篇？可以填一个原因（会通知作者，可留空）：', '');
          if (answer === null) break; // 用户取消
          reason = answer.slice(0, 100);
        } else if (!confirm('恢复显示这篇？访客将重新看到它。')) {
          break;
        }
        const result = await withButtonBusy(actionNode, () =>
          api(`/api/admin/posts/${postId}/hide`, { method: 'POST', body: { hidden: willHide, reason } }),
        );
        toast(
          willHide ? `已隐藏，作者会收到通知（当前共隐藏 ${result.hiddenCount} 篇）` : '已恢复显示',
          'success',
        );
        if (actionNode.dataset.back === 'admin') await Admin.viewAdmin();
        else await Post.viewPost(postId);
        break;
      }
      case 'set-role': {
        const targetRole = actionNode.dataset.role;
        const targetName = actionNode.dataset.name ?? '该用户';
        const confirmText =
          targetRole === 'admin'
            ? `把「${targetName}」设为管理员？TA 将可以隐藏或删除任何文章。`
            : `收回「${targetName}」的管理员权限？`;
        if (!confirm(confirmText)) break;
        const result = await withButtonBusy(actionNode, () =>
          api(`/api/admin/users/${actionNode.dataset.id}/role`, { method: 'POST', body: { role: targetRole } }),
        );
        toast(
          targetRole === 'admin'
            ? `${targetName} 现在是${Fmt.roleLabel('admin')}了 🛡️`
            : `已收回 ${targetName} 的管理员权限`,
          'success',
        );
        void result;
        await Admin.viewAdmin();
        break;
      }
      case 'ban-user':
      case 'unban-user': {
        const banned = action === 'ban-user';
        const userId = Number(actionNode.dataset.id);
        if (banned && !confirm('封禁该用户？其登录会话会立即失效。')) break;
        await withButtonBusy(actionNode, () =>
          api(`/api/admin/users/${userId}/ban`, { method: 'POST', body: { banned } }),
        );
        toast(banned ? '已封禁该用户' : '已解封', 'success');
        await Admin.viewAdmin();
        break;
      }
      case 'ai-analyze': {
        if (!Session.requireLogin('登录后可以让 AI 解读这篇帖子')) break;
        const postId = Number(actionNode.dataset.id);
        const host = actionNode.dataset.host;
        const before = actionNode.textContent;
        actionNode.textContent = '⏳ AI 解读中…';
        try {
          const result = await api(`/api/ai/posts/${postId}/analyze`, { method: 'POST' });
          const hostNode = document.querySelector(`[data-ai-panel="${host}"]`);
          if (hostNode) {
            const stale = hostNode.querySelector('.ai-stale');
            if (stale) stale.remove();
            const old = hostNode.querySelector('.ai-review');
            if (old) old.remove();
            const oldError = hostNode.querySelector('.ai-error');
            if (oldError) oldError.remove();
            const askBlock = hostNode.querySelector('.ai-ask-block');
            askBlock?.insertAdjacentHTML('beforebegin', Ai.aiReviewCardHtml(result.review));
            actionNode.textContent = '🔄 重新解读';
          }
          toast('解读完成', 'success');
        } catch (error) {
          actionNode.textContent = before;
          toastError(error);
          throw error;
        }
        break;
      }
      case 'ai-analyze-pending': {
        if (!Session.requireLogin('请先登录')) break;
        const before = actionNode.textContent;
        let totalDone = 0;
        let totalFailed = 0;
        try {
          for (let round = 0; round < 40; round += 1) {
            actionNode.textContent = `⏳ 解读中…已 ${totalDone} 篇`;
            const batch = await api('/api/ai/posts/analyze-pending', { method: 'POST', body: { limit: 10 } });
            totalDone += batch.processed;
            totalFailed += batch.failed;
            if (batch.processed === 0 && batch.failed === 0) break;
            if (batch.remaining <= 0) break;
          }
          await Ai.viewAI();
          toast(
            totalFailed
              ? `已解读 ${totalDone} 篇，${totalFailed} 篇失败（详情见各帖页面）`
              : `已解读 ${totalDone} 篇`,
            totalFailed ? 'error' : 'success',
          );
        } catch (error) {
          actionNode.textContent = before;
          toastError(error);
          throw error;
        }
        break;
      }
      case 'ai-site-analyze': {
        if (!Session.requireLogin('请先登录')) break;
        if (!confirm('重新整理全站？会调用 AI 逐个帖子分析，可能需要十几秒并消耗 token。')) break;
        await withButtonBusy(actionNode, async () => {
          const result = await api('/api/ai/site/analyze', { method: 'POST' });
          toast(`整理完成：${result.topics} 个主题 · ${result.readingPath} 步阅读路线`, 'success');
          await Ai.viewAI();
        });
        break;
      }
      case 'preview': {
        event.preventDefault();
        const form = actionNode.closest('form');
        const textarea = form.querySelector('textarea[name="content"]');
        const box = form.querySelector('[data-preview]');
        if (!box || !textarea) break;
        if (!box.hidden) {
          box.hidden = true;
          actionNode.textContent = '预览';
          break;
        }
        const { html } = await api('/api/markdown/preview', { method: 'POST', body: { content: textarea.value } });
        box.innerHTML = `<div class="md">${html || '<span class="hint">（空内容）</span>'}</div>`;
        // 公式必须在 innerHTML 之后才排得出来 —— renderMathInElement 只认
        // **已经在 DOM 里**的节点（跟 views/timeline.js、views/doc.js 同一个做法）。
        ntRenderMath(box);
        box.hidden = false;
        actionNode.textContent = '收起预览';
        break;
      }
      case 'md': {
        event.preventDefault();
        const form = actionNode.closest('form');
        const textarea = form.querySelector('textarea[name="content"]');
        Compose.applyMarkdown(actionNode.dataset.md, textarea);
        break;
      }
      default:
        break;
    }
  } catch (error) {
    toastError(error);
  }
});
function currentUsername() {
  const { path } = Router.parseHash();
  const parts = path.split('/').filter(Boolean);
  return parts[0] === 'u' ? parts[1] : state.me?.username ?? '';
}

/** 重新渲染当前正在浏览的个人主页（保持分类筛选与排版）。 */
async function refreshProfile() {
  const { path, query } = Router.parseHash();
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'u' && parts[1]) await User.viewUser(parts[1], query);
}

/** 把投币按钮切成「不可用但可点击」的状态：点了会弹出原因，而不是毫无反应。 */
document.addEventListener('change', async (event) => {
  const avatarInput = event.target.closest('[data-avatar-input]');
  if (avatarInput) {
    const file = avatarInput.files?.[0];
    avatarInput.value = '';
    if (!file) return;
    if (!state.me) {
      Session.requireLogin('登录后才能上传头像');
      return;
    }
    try {
      toast('正在压缩图片…', 'info');
      const { dataUrl, size } = await Compose.compressImageFile(file);
      if (size > 256 * 1024) {
        toast('压缩后仍然超过 256 KB，换张小一点的图片吧', 'error');
        return;
      }
      const result = await api('/api/me/avatar', { method: 'POST', body: { type: 'upload', dataUrl } });
      Compose.applyAvatarResult(result);
      toast('头像上传成功 🎉', 'success');
    } catch (error) {
      toastError(error);
    }
    return;
  }

  const select = event.target.closest('[data-action="set-category"]');
  if (!select) return;
  try {
    const postId = Number(select.dataset.id);
    const value = select.value;
    const result = await api(`/api/posts/${postId}/category`, {
      method: 'POST',
      body: { categoryId: value === '' ? null : Number(value) },
    });
    toast(result.category ? `已归入「${result.category.name}」` : '已移出分类', 'success');
    await refreshProfile();
  } catch (error) {
    toastError(error);
  }
});
document.addEventListener('submit', async (event) => {
  const form = event.target.closest('form[data-action]');
  if (!form) return;
  event.preventDefault();
  const action = form.dataset.action;
  const data = Object.fromEntries(new FormData(form).entries());
  const errorBox = form.querySelector('[data-error]');
  const submitButton = form.querySelector('button[type="submit"]');
  if (errorBox) errorBox.hidden = true;

  const fail = (message) => {
    if (errorBox) {
      errorBox.textContent = message;
      errorBox.hidden = false;
    }
    toast(message, 'error');
  };

  try {
    if (action === 'send-message') {
      const username = form.dataset.username;
      const textarea = form.querySelector('textarea[name="content"]');
      const content = (data.content ?? '').trim();
      if (!content) {
        textarea?.focus();
        return;
      }
      await withButtonBusy(submitButton, () =>
        api(`/api/messages/${encodeURIComponent(username)}`, { method: 'POST', body: { content } }),
      );
      if (textarea) textarea.value = '';
      await Message.viewThread(username);
      await Session.refreshMessageUnread();
      return;
    }

    if (action === 'login' || action === 'register') {
      const payload =
        action === 'login'
          ? { username: data.username, password: data.password }
          : { username: data.username, password: data.password, displayName: data.displayName };
      const result = await withButtonBusy(submitButton, () =>
        api(`/api/auth/${action}`, { method: 'POST', body: payload }),
      );
      await Session.loadSession();
      toast(action === 'login' ? `欢迎回来，${result.user.displayName}` : '注册成功，欢迎加入 🎉', 'success');
      Router.navigate(state.redirect && state.redirect !== '/login' ? state.redirect : '/');
      state.redirect = '/';
      return;
    }

    if (action === 'ai-ask') {
      if (!Session.requireLogin('登录后可以向 AI 提问')) return;
      const question = String(data.question ?? '').trim();
      if (question.length < 2) {
        fail('问题太短了，多写几个字吧');
        return;
      }
      const postId = form.dataset.id ? Number(form.dataset.id) : null;
      const host = form.dataset.host;
      const answerHost = document.querySelector(`[data-ai-panel="${host}"] [data-ai-answer]`) ??
        document.querySelector('[data-ai-answer]');
      if (answerHost) {
        answerHost.hidden = false;
        answerHost.innerHTML = '<div class="ai-loading">🤔 AI 正在读材料并组织回答…</div>';
      }
      try {
        const result = await withButtonBusy(submitButton, () =>
          api('/api/ai/ask', { method: 'POST', body: postId ? { question, postId } : { question } }),
        );
        if (answerHost) answerHost.innerHTML = Ai.aiAnswerHtml(result);
      } catch (error) {
        const text = error?.aborted ? '' : apiErrorText(error);
        if (!text) return; // 已经处理过（例如已跳登录页）
        if (answerHost) answerHost.innerHTML = `<div class="ai-error">${esc(text)}</div>`;
        else fail(text);
      }
      return;
    }

    if (action === 'reply') {
      const postId = Number(form.dataset.id);
      const textarea = form.querySelector('textarea[name="content"]');
      const result = await withButtonBusy(submitButton, () =>
        api(`/api/posts/${postId}/replies`, { method: 'POST', body: { content: textarea.value } }),
      );
      toast('回复成功', 'success');
      await Post.viewPost(postId);
      const node = document.getElementById(`reply-${result.reply.id}`);
      if (node) node.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    if (action === 'compose') {
      const postId = form.dataset.id ? Number(form.dataset.id) : null;
      const body = {
        boardId: Number(data.boardId),
        title: data.title,
        content: data.content,
        categoryId: data.categoryId ? Number(data.categoryId) : null,
        profilePinned: Boolean(data.profilePinned),
      };
      const result = postId
        ? await withButtonBusy(submitButton, () => api(`/api/posts/${postId}`, { method: 'PUT', body }))
        : await withButtonBusy(submitButton, () => api('/api/posts', { method: 'POST', body }));
      await Session.loadSite();
      toast(postId ? '修改已保存' : '发布成功 🎉', 'success');
      Router.navigate(`/post/${result.id}`);
      return;
    }

    if (action === 'repost') {
      const repostPostId = Number(form.dataset.id);
      const result = await withButtonBusy(submitButton, () =>
        api(`/api/posts/${repostPostId}/repost`, { method: 'POST', body: { comment: data.comment ?? '' } }),
      );
      toast(result.updated ? '转发语已更新' : '转发成功，已出现在你的主页 🔁', 'success');
      await Post.viewPost(repostPostId);
      return;
    }

    if (action === 'create-category') {
      const result = await withButtonBusy(submitButton, () =>
        api('/api/me/categories', { method: 'POST', body: { name: data.name } }),
      );
      toast(`分类「${result.category.name}」已创建`, 'success');
      await refreshProfile();
      return;
    }

    if (action === 'save-profile') {
      const result = await withButtonBusy(submitButton, () =>
        api('/api/me/profile', { method: 'POST', body: { displayName: data.displayName, bio: data.bio } }),
      );
      state.me = { ...state.me, displayName: result.user.displayName, bio: result.user.bio };
      Session.renderUserArea();
      toast('个人资料已保存', 'success');
      return;
    }

    if (action === 'change-password') {
      if (data.newPassword !== data.confirmPassword) {
        fail('两次输入的新密码不一致');
        return;
      }
      const result = await withButtonBusy(submitButton, () =>
        api('/api/auth/password', {
          method: 'POST',
          body: { currentPassword: data.currentPassword, newPassword: data.newPassword },
        }),
      );
      form.reset();
      toast(`密码已更新，已下线 ${result.revokedSessions} 个其它会话`, 'success');
      return;
    }
  } catch (error) {
    const text = error?.aborted ? '' : apiErrorText(error);
    if (text) fail(text);
  }
});
ui.searchForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const keyword = ui.searchInput.value.trim();
  Router.navigate(keyword ? `/search?q=${encodeURIComponent(keyword)}` : '/');
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeMenus();
});

/* ------------------------------------------------------------------ */
/* 学术笔记（note-studio）                                             */
/* ------------------------------------------------------------------ */

// 这一页的所有控件都用 id / data-nt-* 就地绑定，不接中央的 data-action 分发，
// 免得动到 check-ui-contract.mjs 盯着的那个 switch（跟 public/views/timeline.js 一个做法）。

// ── 导出 ──────────────────────────────────────────────────────────────
export { closeMenus };
export { closeMenu };
export { currentUsername };
export { refreshProfile };

/* @hand-written */
