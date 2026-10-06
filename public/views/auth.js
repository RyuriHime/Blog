// 登录 / 注册页。

import { $, ui } from '../core/dom.js';

async function viewAuth(mode) {
  const isLogin = mode === 'login';
  ui.app.innerHTML = `
    <section class="card" style="max-width:460px;width:100%;margin:0 auto">
      <div class="card-head">
        <h1 style="font-size:20px">${isLogin ? '👋 欢迎回来' : '🎉 创建新账号'}</h1>
      </div>
      <form class="form" data-action="${isLogin ? 'login' : 'register'}">
        <div class="field">
          <label for="username">用户名</label>
          <input id="username" name="username" type="text" required autocomplete="username"
                 placeholder="字母、数字或下划线，3-20 位" />
        </div>
        ${
          isLogin
            ? ''
            : `<div class="field">
                 <label for="displayName">昵称（可选）</label>
                 <input id="displayName" name="displayName" type="text" maxlength="20" placeholder="展示给其他用户的名字" />
               </div>`
        }
        <div class="field">
          <label for="password">密码</label>
          <input id="password" name="password" type="password" required autocomplete="${isLogin ? 'current-password' : 'new-password'}"
                 placeholder="${isLogin ? '输入密码' : '至少 6 位'}" />
        </div>
        <div class="form-error" data-error hidden></div>
        <div class="form-actions">
          <button class="btn btn-primary" type="submit">${isLogin ? '登录' : '注册并登录'}</button>
          <a class="btn btn-ghost" href="#/${isLogin ? 'register' : 'login'}">${isLogin ? '没有账号？注册' : '已有账号？登录'}</a>
        </div>
      </form>
      <div class="hint" style="margin-top:16px;line-height:1.9">
        演示账号：<code>admin / admin123</code>（管理员）<br />
        普通账号：<code>alice / demo1234</code>、<code>bob / demo1234</code>
      </div>
    </section>`;

  $('#username').focus();
}

/* ------------------------------------------------------------------ */
/* 视图：AI 阅读助手                                                   */

// ── 导出 ──────────────────────────────────────────────────────────────
export { viewAuth };

/* @hand-written */
