// 账号设置页（资料 / 头像 / 密码 / 主题 / 外观）。

import { $, esc, loadingHtml, ui } from '../core/dom.js';
import { api } from '../core/api.js';
import { AVATAR_EMOJIS, state } from '../core/state.js';
import { navigate } from '../core/router.js';
import * as Avatar from '../core/avatar.js';
import * as Fmt from '../core/format.js';
import * as Theme from '../core/theme.js';

async function viewSettings() {
  ui.app.innerHTML = loadingHtml();
  if (!state.me) {
    state.redirect = '/settings';
    navigate('/login');
    return;
  }

  const me = state.me;
  const status = state.checkin ?? (await api('/api/checkin'));
  state.checkin = status;
  const blocks = await api('/api/me/blocks').catch(() => ({ items: [], total: 0 }));

  ui.app.innerHTML = `
    <section class="page-head">
      <h1>⚙️ 账号设置</h1>
      <div class="page-sub">修改头像、昵称与个性签名、更换密码、管理黑名单，都在这里完成。</div>
    </section>

    <section class="card">
      <div class="card-head">
        <span class="card-title">🖼️ 头像</span>
        <span class="hint">预设表情或上传图片（会自动压缩成 256×256）</span>
      </div>
      <div class="avatar-editor">
        <div class="avatar-preview">
          ${Avatar.avatarHtml(me, 'avatar-lg')}
          <span class="hint">当前头像</span>
        </div>
        <div class="avatar-controls">
          <div class="avatar-emojis">
            ${AVATAR_EMOJIS.map(
              ([emoji, hue]) => `
              <button class="avatar-option" type="button" data-action="set-avatar-emoji"
                      data-emoji="${emoji}" data-hue="${hue}" title="用 ${emoji} 作为头像"
                      style="--hue:${hue}">${emoji}</button>`,
            ).join('')}
          </div>
          <div class="form-actions" style="margin-top:12px;flex-wrap:wrap">
            <label class="btn btn-sm" for="avatar-file">📁 上传图片</label>
            <input id="avatar-file" type="file" accept="image/png,image/jpeg,image/webp" hidden data-avatar-input />
            <button class="btn btn-sm btn-ghost" type="button" data-action="reset-avatar">恢复默认</button>
            <span class="hint">支持 PNG / JPEG / WebP，≤ 256 KB，只保存到本机 data/avatars/</span>
          </div>
        </div>
      </div>
    </section>

    <section class="card">
      <div class="card-head">
        <span class="card-title">👤 个人资料</span>
        <a class="tag" href="#/u/${encodeURIComponent(me.username)}">查看我的主页</a>
      </div>
      <form class="form" data-action="save-profile">
        <div class="field">
          <label for="displayName">昵称</label>
          <input id="displayName" name="displayName" type="text" maxlength="20" required value="${esc(me.displayName)}" />
          <span class="hint">1-20 个字符，会显示在帖子、回复和通知里。</span>
        </div>
        <div class="field">
          <label for="bio">个性签名</label>
          <textarea id="bio" name="bio" maxlength="100" rows="3" class="bio-input"
                    placeholder="用一句话介绍自己，会显示在个人主页">${esc(me.bio ?? '')}</textarea>
          <span class="hint">最多 100 个字符，支持纯文本。</span>
        </div>
        <div class="form-error" data-error hidden></div>
        <div class="form-actions">
          <button class="btn btn-primary" type="submit">保存资料</button>
          <span class="hint">用户名 @${esc(me.username)} 不可修改</span>
        </div>
      </form>
    </section>

    <section class="card">
      <div class="card-head">
        <span class="card-title">🎨 外观</span>
        <span class="hint">主题只保存在当前浏览器（localStorage）</span>
      </div>
      <div class="theme-grid" data-theme-grid>${Theme.themeOptionsHtml()}</div>
      <div class="hint" style="margin-top:10px">点顶部导航栏的 🎨 也可以随时快速切换。</div>
    </section>

    <section class="card">
      <div class="card-head"><span class="card-title">🔒 修改密码</span></div>
      <form class="form" data-action="change-password">
        <div class="field">
          <label for="currentPassword">当前密码</label>
          <input id="currentPassword" name="currentPassword" type="password" required autocomplete="current-password" />
        </div>
        <div class="field">
          <label for="newPassword">新密码</label>
          <input id="newPassword" name="newPassword" type="password" required minlength="6" maxlength="72"
                 autocomplete="new-password" placeholder="至少 6 位" />
        </div>
        <div class="field">
          <label for="confirmPassword">确认新密码</label>
          <input id="confirmPassword" name="confirmPassword" type="password" required minlength="6" maxlength="72"
                 autocomplete="new-password" />
        </div>
        <div class="form-error" data-error hidden></div>
        <div class="form-actions">
          <button class="btn btn-primary" type="submit">更新密码</button>
          <span class="hint">修改成功后，其它设备上的登录状态会被强制下线。</span>
        </div>
      </form>
    </section>

    <section class="card">
      <div class="card-head">
        <span class="card-title">📅 签到与资产</span>
        <a class="tag" href="#/checkin">去签到</a>
      </div>
      <div class="stat-grid stat-grid-wide">
        <div class="stat"><div class="stat-value">${status.streak}</div><div class="stat-label">连续签到</div></div>
        <div class="stat"><div class="stat-value">${status.total}</div><div class="stat-label">累计签到</div></div>
        <div class="stat"><div class="stat-value">${status.weekAttended}/${status.fullWeekDays}</div><div class="stat-label">本周进度</div></div>
        <div class="stat"><div class="stat-value">🪙 ${Fmt.fmtNum(me.coinBalance ?? status.coinBalance)}</div><div class="stat-label">可用币</div></div>
      </div>
      ${
        status.checkedInToday
          ? '<div class="hint" style="margin-top:12px">✅ 今天已经签到过了</div>'
          : '<div class="form-actions" style="margin-top:12px"><button class="btn btn-sm btn-primary" data-action="checkin">立即签到，领 ' +
            Fmt.checkinRules().dailyReward +
            ' 币</button></div>'
      }
    </section>

    <section class="card">
      <div class="card-head">
        <span class="card-title">🚫 黑名单（${blocks.items.length}）</span>
        <span class="hint">被拉黑的人无法关注你、给你发私信，也看不到你发的文章</span>
      </div>
      <div class="chip-list">
        ${
          blocks.items.length
            ? blocks.items
                .map(
                  (person) => `
          <span class="chip">
            <a class="chip-label" href="#/u/${encodeURIComponent(person.username)}">
              ${Avatar.avatarHtml(person, 'avatar-sm')} ${esc(person.displayName)}
            </a>
            <button class="chip-x" data-action="block-user" data-id="${person.id}" data-blocked="1" data-name="${esc(person.displayName)}"
                    title="解除拉黑">✕</button>
          </span>`,
                )
                .join('')
            : '<div class="hint">黑名单是空的。在别人的主页点「🚫 拉黑」就能加进来。</div>'
        }
      </div>
    </section>

    <section class="card">
      <div class="card-head"><span class="card-title">🧾 账号信息</span></div>
      <div class="table-wrap">
        <table class="data">
          <tbody>
            <tr><th>用户名</th><td>@${esc(me.username)}</td></tr>
            <tr><th>身份</th><td>${Fmt.roleTag(me.role) || '普通成员'}</td></tr>
            <tr><th>注册时间</th><td>${Fmt.fullTime(me.createdAt)}</td></tr>
            <tr><th>状态</th><td>${me.banned ? '<span class="tag tag-banned">已封禁</span>' : '<span class="tag">正常</span>'}</td></tr>
          </tbody>
        </table>
      </div>
    </section>`;
}

/* ------------------------------------------------------------------ */
/* 视图：排行榜                                                        */

// ── 导出 ──────────────────────────────────────────────────────────────
export { viewSettings };

/* @hand-written */
