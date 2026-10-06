// 纯格式化：转义、时间、数字、中文日期、角色标签、规则回退值。
// 这一块不含任何 DOM 操作，也没有副作用 —— 可以直接在 node 里 import 来测。

import { $ } from './dom.js';
import { state } from './state.js';

function timeAgo(timestamp) {
  const diff = Date.now() - Number(timestamp || 0);
  if (diff < 45 * 1000) return '刚刚';
  if (diff < 3600 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 24 * 3600 * 1000) return `${Math.floor(diff / 3600000)} 小时前`;
  if (diff < 30 * 24 * 3600 * 1000) return `${Math.floor(diff / 86400000)} 天前`;
  const date = new Date(Number(timestamp));
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function fullTime(timestamp) {
  return new Date(Number(timestamp)).toLocaleString('zh-CN', { hour12: false });
}
function fmtNum(value) {
  const num = Number(value || 0);
  if (num < 1000) return String(num);
  if (num < 10000) return `${(num / 1000).toFixed(1)}k`;
  return `${(num / 10000).toFixed(1)}w`;
}
const isStaffRole = (role) => role === 'owner' || role === 'admin';
const isStaffUser = (user) => Boolean(user && isStaffRole(user.role));
const roleLabel = (role) => (role === 'owner' ? '站长' : role === 'admin' ? '管理员' : '成员');
const roleTag = (role) => {
  if (role === 'owner') return '<span class="tag tag-owner">👑 站长</span>';
  if (role === 'admin') return '<span class="tag tag-admin">🛡️ 管理员</span>';
  return '';
};
const coinRules = () => state.site.coinRules ?? { signupGrant: 10, perPostLimit: 2 };
const profileRules = () => state.site.profileRules ?? { pinLimit: 3, categoryLimit: 8 };

// ── 导出 ──────────────────────────────────────────────────────────────
export { timeAgo };
export { fullTime };
export { fmtNum };
export { isStaffRole };
export { isStaffUser };
export { roleLabel };
export { roleTag };
export { coinRules };
export { profileRules };

/* @hand-written */
