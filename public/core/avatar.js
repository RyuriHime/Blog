// 头像渲染：emoji 头像是「emoji:hue」拼出来的，上传头像是文件地址。
// 两种形态都要能渲成 <img>/<span>，且大小档位固定（见 avatarHtml 的 size 参数）。

import { $, esc } from './dom.js';

function hueOf(text) {
  let hash = 0;
  for (const char of String(text || '?')) hash = (hash * 31 + char.codePointAt(0)) % 360;
  return hash;
}
function avatarParts(person) {
  const raw = String((typeof person === 'object' && person ? person.avatar : '') ?? '').trim();
  if (raw.startsWith('emoji:')) {
    const [, emoji, hue] = raw.split(':');
    if (emoji) return { kind: 'emoji', emoji, hue: Number(hue) || 210 };
  }
  if (raw.startsWith('file:')) {
    const url = raw.slice(5);
    if (/^\/avatars\/[A-Za-z0-9._-]+$/.test(url)) return { kind: 'file', url };
  }
  return null;
}

/** 支持传「用户对象」或「昵称字符串」：优先用用户设置的头像，否则用昵称首字母色块 */
function avatarHtml(person, size = '') {
  const name =
    typeof person === 'string' ? person : person?.displayName ?? person?.username ?? person?.name ?? '?';
  const custom = avatarParts(person);

  if (custom?.kind === 'file') {
    return `<span class="avatar avatar-img ${size}" aria-hidden="true"><img src="${esc(custom.url)}" alt="" loading="lazy" /></span>`;
  }
  if (custom?.kind === 'emoji') {
    return `<span class="avatar avatar-emoji ${size}" style="--hue:${custom.hue}" aria-hidden="true">${esc(custom.emoji)}</span>`;
  }

  const label = String(name || '?').trim().slice(0, 1).toUpperCase();
  return `<span class="avatar ${size}" style="--hue:${hueOf(name)}" aria-hidden="true">${esc(label)}</span>`;
}

/** 站长 / 管理员 / 成员；staff（管理团队）可以隐藏或删除违规文章 */

// ── 导出 ──────────────────────────────────────────────────────────────
export { hueOf };
export { avatarParts };
export { avatarHtml };

/* @hand-written */
