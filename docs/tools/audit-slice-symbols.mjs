// 临时审计脚本（用完即删）：确认搬运切片里到底用到了哪些辅助函数，
// 免得给生成的文件加一堆用不到的 import。
import { readFileSync } from 'node:fs';

const lines = readFileSync('src/server.js', 'utf8').split(/\r?\n/);
const seg = (a, b) => lines.slice(a - 1, b).join('\n');

function count(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (text.match(new RegExp(`\\b${escaped}\\b`, 'g')) || []).length;
}

const shape = seg(140, 425);
console.log('shape.js 140-425：');
for (const n of ['ok', 'ensure', 'HttpError', 'field', 'rateLimit', 'res_', 'sendJson', 'store']) {
  console.log(`  ${n.padEnd(12)}${count(shape, n)}`);
}

const routes = seg(475, 1523);
console.log('\nroutes 475-1523：');
const names = [
  'ok', 'ensure', 'field', 'rateLimit', 'res_', 'sendJson', 'HttpError', 'readJsonBody', 'parseCookies',
  'hashPassword', 'verifyPassword', 'renderMarkdown', 'markdownToPlainText',
  'issueSession', 'sessionCookie', 'saveAvatarFile', 'removeAvatarFile', 'readJsonFile',
  'GRAPH_FILE', 'GRAPH_STATUS_FILE', 'AVATAR_URL_PREFIX', 'MAX_AVATAR_BYTES',
  'assertPinAllowed', 'coinAvailability', 'notifyMentions', 'resolveOwnCategory',
  'isOwner', 'isStaff', 'requireUser', 'requireStaff', 'requireOwner', 'assertPostVisible',
];
for (const n of names) {
  const c = count(routes, n);
  console.log(`  ${c === 0 ? 'UNUSED' : '      '} ${n.padEnd(20)}${c}`);
}
