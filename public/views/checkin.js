// 签到日历页。

import { $, loadingHtml, ui } from '../core/dom.js';
import { api } from '../core/api.js';
import { navigate } from '../core/router.js';
import { state } from '../core/state.js';
import * as Fmt from '../core/format.js';

async function viewCheckin() {
  ui.app.innerHTML = loadingHtml();
  if (!state.me) {
    state.redirect = '/checkin';
    navigate('/login');
    return;
  }

  const status = await api('/api/checkin');
  state.checkin = status;
  const rules = Fmt.checkinRules();

  const weekDots = status.week
    .map(
      (item) => `
      <div class="week-cell ${item.attended ? 'is-on' : ''} ${item.isToday ? 'is-today' : ''} ${item.future ? 'is-future' : ''}">
        <span class="week-label">周${Fmt.weekdayCn(item.day)}</span>
        <span class="week-day">${Fmt.monthDayCn(item.day)}</span>
        <span class="week-mark">${item.attended ? '✅' : item.future ? '·' : '—'}</span>
      </div>`,
    )
    .join('');

  const calendar = status.calendar
    .map(
      (item) =>
        `<span class="cal-cell ${item.attended ? 'is-on' : ''} ${item.isToday ? 'is-today' : ''} ${item.future ? 'is-future' : ''}"
               title="${item.day}${item.attended ? ' 已签到' : ''}">${Fmt.monthDayCn(item.day)}</span>`,
    )
    .join('');

  const bonuses = status.bonusHistory.length
    ? status.bonusHistory
        .map((item) => `<div class="bonus-row"><span>🏅 ${item.weekStart} 那周全勤</span><span class="bonus-amount">+${item.amount} 币</span></div>`)
        .join('')
    : '<div class="hint">还没有拿过全勤奖，连续 7 天（周一至周日）都来签到试试。</div>';

  ui.app.innerHTML = `
    <section class="card checkin-hero">
      <div class="checkin-hero-main">
        <h1 style="font-size:21px">📅 每日签到</h1>
        <div class="page-sub">每天签到领 ${rules.dailyReward} 币；一个自然周（周一至周日）全勤，下周一签到再额外领 ${rules.weeklyBonus} 币。</div>
        <div class="checkin-status">
          ${
            status.checkedInToday
              ? `<span class="checkin-done big">✅ 今天已签到</span>
                 <span class="hint">明天再来，连续签到 ${status.streak} 天</span>`
              : `<button class="btn btn-primary" data-action="checkin">立即签到，领 ${rules.dailyReward} 币</button>
                 ${status.streak > 0 ? `<span class="hint">已经连续 ${status.streak} 天，别断了</span>` : '<span class="hint">开始你的第一天签到吧</span>'}`
          }
        </div>
        ${
          status.pendingBonus > 0
            ? `<div class="checkin-pending">🎁 上周全勤，签到即领 ${status.pendingBonus} 币全勤奖</div>`
            : ''
        }
      </div>
      <div class="checkin-stats">
        <div class="stat"><div class="stat-value">${status.streak}</div><div class="stat-label">连续签到</div></div>
        <div class="stat"><div class="stat-value">${status.total}</div><div class="stat-label">累计签到</div></div>
        <div class="stat"><div class="stat-value">${status.weekAttended}/${rules.fullWeekDays}</div><div class="stat-label">本周进度</div></div>
        <div class="stat"><div class="stat-value">🪙 ${Fmt.fmtNum(status.coinBalance)}</div><div class="stat-label">可用币</div></div>
      </div>
    </section>

    <section class="card">
      <div class="card-head"><span class="card-title">本周（${status.weekStart} 起）</span></div>
      <div class="week-grid">${weekDots}</div>
      <div class="hint" style="margin-top:10px">
        ${status.weekAttended >= rules.fullWeekDays ? '本周已全勤 ✅ 下周一签到就能拿到全勤奖' : `本周还差 ${rules.fullWeekDays - status.weekAttended} 天全勤，全勤额外 +${rules.weeklyBonus} 币`}
      </div>
    </section>

    <section class="card">
      <div class="card-head"><span class="card-title">最近 35 天</span></div>
      <div class="cal-grid">${calendar}</div>
    </section>

    <section class="card">
      <div class="card-head"><span class="card-title">🏅 全勤记录</span></div>
      ${bonuses}
    </section>`;
}

/* ------------------------------------------------------------------ */
/* 视图：账号设置                                                      */

// ── 导出 ──────────────────────────────────────────────────────────────
export { viewCheckin };

/* @hand-written */
