// 8 套主题：定义、色块预览、选择器渲染、应用与持久化。
// 
// ⚠️ 8 套主题是线上版就有的功能，v2 的 UI 翻新**只允许增删样式，不允许减少主题数**。
// themeSwatchHtml 里的色值必须与 public/css/*.css 里的真实取值一致，
// scripts/check-ui-contract.mjs 会逐套比对（预览和实际不一样会报错）。

import { $, toast } from './dom.js';
import { state } from './state.js';
import * as Prefs from './preferences.js';

const THEMES = [
  { key: 'auto', label: '跟随系统', hint: '随系统深浅色切换', auto: true },
  { key: 'dark', label: '暗夜', hint: '默认深蓝夜色', swatch: { bg: '#0b0f16', panel: '#141b29', accent: '#5b8cff' } },
  { key: 'midnight', label: '极夜', hint: '纯黑 OLED，最省电', swatch: { bg: '#000000', panel: '#0b0e13', accent: '#5b8cff' } },
  { key: 'light', label: '明亮', hint: '浅色日间主题', swatch: { bg: '#f5f7fb', panel: '#ffffff', accent: '#2f66f0' } },
  { key: 'amber', label: '暖阳', hint: '琥珀黄深色', swatch: { bg: '#16110a', panel: '#221a0f', accent: '#f0b429' } },
  { key: 'sand', label: '奶黄', hint: '米黄纸感浅色', swatch: { bg: '#fdf6e3', panel: '#fffdf7', accent: '#c98a00' } },
  { key: 'forest', label: '森林', hint: '墨绿护眼', swatch: { bg: '#07130d', panel: '#0e1c15', accent: '#35c07f' } },
  { key: 'violet', label: '暮紫', hint: '紫罗兰夜色', swatch: { bg: '#0d0a18', panel: '#171228', accent: '#a06bff' } },
];
const systemPrefersLight = () =>
  typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: light)').matches;

/** auto → 按系统解析；其余直接用主题名（对应 html[data-theme="..."]） */
const resolveTheme = (key) => (key === 'auto' ? (systemPrefersLight() ? 'light' : 'dark') : key);
const themeMeta = (key) => THEMES.find((item) => item.key === key) ?? THEMES[1];
function themeSwatchHtml(theme) {
  if (theme.auto) return '<span class="theme-swatch is-auto"></span>';
  const { bg, panel, accent } = theme.swatch;
  return `<span class="theme-swatch" style="--swatch-bg:${bg};--swatch-panel:${panel};--swatch-accent:${accent}"></span>`;
}
function themeOptionsHtml() {
  return THEMES.map(
    (theme) => `
    <button class="theme-option ${state.theme === theme.key ? 'is-active' : ''}" type="button"
            data-action="set-theme" data-theme="${theme.key}">
      ${themeSwatchHtml(theme)}
      <span class="theme-name">${theme.label}<span class="theme-hint">${theme.hint}</span></span>
      ${state.theme === theme.key ? '<span class="menu-check">✓</span>' : ''}
    </button>`,
  ).join('');
}
function renderThemeArea() {
  const area = $('#theme-area');
  if (!area) return;
  area.innerHTML = `
    <button class="btn btn-sm btn-ghost theme-btn" type="button" data-action="toggle-theme-menu"
            title="切换背景主题（当前：${themeMeta(state.theme).label}）" aria-label="切换背景主题">🎨</button>
    <div class="menu theme-menu" id="theme-menu" hidden>
      ${THEMES.map(
        (theme) => `
        <button class="menu-item theme-item" type="button" data-action="set-theme" data-theme="${theme.key}">
          ${themeSwatchHtml(theme)}
          <span>${theme.label}</span>
          ${state.theme === theme.key ? '<span class="menu-check">✓</span>' : ''}
        </button>`,
      ).join('')}
    </div>`;
}
function applyTheme(key, { silent = false, persist = true } = {}) {
  const chosen = THEMES.some((item) => item.key === key) ? key : 'dark';
  const resolved = resolveTheme(chosen);
  document.documentElement.dataset.theme = resolved;
  state.theme = chosen;
  if (persist) Prefs.writePreference(Prefs.THEME_STORAGE_KEY, chosen);

  renderThemeArea();
  const grid = document.querySelector('[data-theme-grid]');
  if (grid) grid.innerHTML = themeOptionsHtml();

  if (!silent) {
    toast(
      chosen === 'auto'
        ? `已切换：跟随系统（当前是${resolved === 'light' ? '明亮' : '暗夜'}）`
        : `已切换到「${themeMeta(chosen).label}」主题`,
      'success',
    );
  }
}

/* ------------------------------------------------------------------ */
/* 通用工具                                                            */

// ── 导出 ──────────────────────────────────────────────────────────────
export { THEMES };
export { themeMeta };
export { resolveTheme };
export { systemPrefersLight };
export { themeSwatchHtml };
export { themeOptionsHtml };
export { renderThemeArea };
export { applyTheme };

/* @hand-written */
