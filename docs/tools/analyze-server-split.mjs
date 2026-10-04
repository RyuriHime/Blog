/**
 * 一次性的分析工具：把 src/server.js 按行区间切开，并列出每个区间里
 * 顶层声明了哪些名字、引用了其它区间里的哪些名字。
 * 目的是拿到「准确的搬运清单」，避免手写导出表时漏项。
 *
 * 用法：node docs/tools/analyze-server-split.mjs
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const SERVER = resolve(ROOT, 'src', 'server.js');

const source = readFileSync(SERVER, 'utf8');
const lines = source.split(/\r?\n/);

/** 行区间用「左闭右闭」表示。 */
const UNITS = [
  ['http', 41, 126, 'HttpError / ensure / res_ / sendJson / ok / readJsonBody / parseCookies / rateLimit / field'],
  ['boot', 128, 138, 'openDatabase + store + purgeExpiredSessions 定时器'],
  ['shape', 140, 425, '全部 shapeXxx / collectMentions / notifyMentions / coinAvailability'],
  ['routes', 427, 436, 'route() 注册器 + routes 数组'],
  ['guards', 438, 473, 'isOwner / isStaff / requireUser / requireStaff / requireOwner / assertPostVisible'],
  ['routes-a', 475, 700, '第一阶段路由'],
  ['routes-b', 701, 1000, '第二阶段路由'],
  ['routes-c', 1001, 1300, '第三阶段路由'],
  ['routes-d', 1301, 1522, '第四阶段路由'],
  ['sessions', 1524, 1650, 'issueSession / sessionCookie / resolveUser / sniffImageType / saveAvatarFile / removeAvatarFile'],
  ['static', 1652, 1712, '静态资源与头像分发'],
  ['handler', 1714, 1837, 'createServer + 分发 + 挂载子包 + listen'],
];

const DECL = /^(?:export\s+)?(?:async\s+)?(const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/;

const unitInfo = [];
for (const [name, from, to, note] of UNITS) {
  const body = lines.slice(from - 1, to);
  const declared = [];
  for (const line of body) {
    const match = DECL.exec(line);
    if (match) declared.push(match[2]);
  }
  unitInfo.push({ name, from, to, note, body, declared });
}

// 每个区间引用了哪些「别的区间声明过的名字」
const ownerOf = new Map();
for (const unit of unitInfo) {
  for (const symbol of unit.declared) {
    if (!ownerOf.has(symbol)) ownerOf.set(symbol, unit.name);
  }
}

console.log('# 区间清单\n');
console.log('| 区间 | 行 | 字节 | 顶层声明 |');
console.log('|---|---|---|---|');
for (const unit of unitInfo) {
  const bytes = Buffer.byteLength(unit.body.join('\n'), 'utf8');
  console.log(
    `| ${unit.name} | ${unit.from}-${unit.to} | ${bytes} | ${unit.declared.join(', ') || '（无）'} |`,
  );
}

console.log('\n# 每个区间的跨区间引用（决定谁 import 谁）\n');
for (const unit of unitInfo) {
  const text = unit.body.join('\n');
  const needed = new Map();
  for (const [symbol, owner] of ownerOf) {
    if (owner === unit.name) continue;
    // 粗略判定：出现了这个名字（作为独立标识符）
    const re = new RegExp(`(?<![\\w$.])${symbol.replace(/\$/g, '\\$')}(?![\\w$])`);
    if (re.test(text)) {
      if (!needed.has(owner)) needed.set(owner, new Set());
      needed.get(owner).add(symbol);
    }
  }
  console.log(`## ${unit.name}`);
  if (needed.size === 0) console.log('  （无）');
  for (const [owner, set] of needed) console.log(`  from ./${owner}: ${[...set].sort().join(', ')}`);
  console.log('');
}

console.log('\n# 文件总览');
console.log(`总行数 ${lines.length}`);
for (const unit of unitInfo) console.log(`${unit.name}: ${unit.from}-${unit.to} (${unit.to - unit.from + 1} 行)`);
