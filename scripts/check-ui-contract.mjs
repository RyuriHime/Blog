/**
 * 前端契约检查：
 *  1) 前端用到的 CSS 类是否都在 CSS 里定义了；
 *  2) 前端读取的 API 字段是否都真实存在（启动临时服务器实测）。
 * 用法：node scripts/check-ui-contract.mjs
 *
 * ── 为什么不再写死三个文件路径 ───────────────────────────────────────────
 * v2 骨架会把 public/app.js（4000+ 行）拆成 public/core/* + public/views/*，
 * 把 public/style.css 拆成 public/css/*。本检查原本只 readFileSync 三个固定
 * 路径，文件一搬家「用到的类名」集合就会变小 —— missing 恒为空数组，
 * 断言永远通过，**测试静默失效却依然报绿**。
 *
 * 所以改成两个集合都由「递归扫描 public/ 下的全部 .js/.html/.css」算出，
 * 并加三条哨兵（文件数下限、断言数下限、被扫描文件必须真的产出类名），
 * 任何一条不满足就直接失败。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';

import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const DB_FILE = join(ROOT, 'data', 'contract.db');
const AVATAR_DIR = join(ROOT, 'data', 'contract-avatars');
const LOG_FILE = join(ROOT, 'data', 'contract-server.log');
const PORT = Number(process.env.CONTRACT_PORT || 3412);
const BASE = `http://127.0.0.1:${PORT}`;

/** 不下降哨兵：接手的模块只允许加，不允许把这些数字改小。 */
const MIN_CHECKS = Number(process.env.MIN_UI_CHECKS || 200);

/**
 * 前端源码入口清单。搬家前这三份文件在 public/ 根目录；骨架会把它们拆进
 * public/core/ 与 public/views/。清单里任何一份（按 basename 匹配）都不许消失，
 * 否则「类名都有定义」就会因为扫不到模板而假绿。
 */
const REQUIRED_SOURCES = ['app.js', 'index.html', 'style.css'];

const problems = [];
const notes = [];
const check = (name, condition, detail = '') => {
  if (condition) notes.push(`  ✅ ${name}`);
  else problems.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

/* ---------- 0. 递归收集前端源码 ---------- */

const SKIP_DIRS = new Set(['.git', 'node_modules']);

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const publicDir = join(ROOT, 'public');
const publicFiles = walk(publicDir);
const jsFiles = publicFiles.filter((file) => file.endsWith('.js'));
const htmlFiles = publicFiles.filter((file) => file.endsWith('.html'));
const cssFiles = publicFiles.filter((file) => file.endsWith('.css'));

const readAll = (files) => files.map((file) => readFileSync(file, 'utf8')).join('\n');
const appJs = readAll(jsFiles); // 前端全部 JS（骨架前是 app.js 一个文件）
const indexHtml = readAll(htmlFiles);
const styleCss = readAll(cssFiles);

/* ---------- 1. 前端静态资源自检 ---------- */

const publicBasenames = new Set(publicFiles.map((file) => file.slice(Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')) + 1)));
const missingSources = REQUIRED_SOURCES.filter((name) => !publicBasenames.has(name));
check(
  `前端源码入口都在（js ${jsFiles.length} / html ${htmlFiles.length} / css ${cssFiles.length}）`,
  jsFiles.length >= 1 && htmlFiles.length >= 1 && cssFiles.length >= 1 && missingSources.length === 0,
  `js=${jsFiles.length} html=${htmlFiles.length} css=${cssFiles.length} 缺=${missingSources.join(',') || '无'}`,
);

const defined = new Set([...styleCss.matchAll(/\.(-?[A-Za-z][\w-]*)/g)].map((match) => match[1]));
const used = new Set();
for (const source of [appJs, indexHtml]) {
  for (const match of source.matchAll(/class="([^"]*)"/g)) {
    const value = match[1].replace(/\$\{[^}]*\}/g, ' ');
    for (const name of value.split(/\s+/)) if (name) used.add(name);
  }
}
check(
  '模板里确实扫到了类名（否则「类名都有定义」是假绿）',
  used.size >= 50,
  `used=${used.size}`,
);
const missing = [...used].filter((name) => !defined.has(name));
check('所有模板类名都在 style.css 中有定义', missing.length === 0, missing.join(', '));

// 前端有两种写法：原生 querySelector('#x') 与内部简写 $('#x')（= app.js 顶部的 $ 助手）。
// 只认一种会让 idSelectors 直接变 0 —— 那样的「断言 0 条」也是假绿。
const selectors = [
  ...[...appJs.matchAll(/querySelector(?:All)?\('([^']+)'\)/g)].map((match) => match[1]),
  ...[...appJs.matchAll(/\$\('#([A-Za-z][\w-]*)'\)/g)].map((match) => `#${match[1]}`),
];
// 排除运行时才创建的元素（它们不在 index.html 里，由 JS 自己 insertAdjacentHTML 出来）。
const DYNAMIC_IDS = new Set(['user-menu', 'theme-menu', 'username']);
const idSelectors = selectors.filter(
  (item) => item.startsWith('#') && !item.includes(' ') && !DYNAMIC_IDS.has(item.slice(1)),
);
check('确实扫到了 index.html 里的挂载点查询', idSelectors.length >= 5, `count=${idSelectors.length}`);
for (const selector of idSelectors) {
  const id = selector.slice(1);
  check(`index.html 中存在 id="${id}"`, indexHtml.includes(`id="${id}"`));
}

/* ---------- 1b. 背景主题契约 ---------- */

/** 取出某个主题在 style.css 里的变量块（dark 用 :root 作为默认值） */
function themeBlock(key) {
  const pattern =
    key === 'dark'
      ? /:root\s*\{([\s\S]*?)\}/
      : new RegExp(`html\\[data-theme='${key}'\\]\\s*\\{([\\s\\S]*?)\\}`);
  const match = styleCss.match(pattern);
  return match ? match[1] : null;
}

const themeListSource = appJs.match(/const THEMES = \[([\s\S]*?)\n\];/);
const themeKeys = themeListSource
  ? [...themeListSource[1].matchAll(/key: '([a-z]+)'/g)].map((match) => match[1])
  : [];
check(
  '前端主题列表可解析',
  themeKeys.length >= 4 && themeKeys.includes('auto') && themeKeys.includes('dark'),
  themeKeys.join(','),
);

// 每个主题都要有对应的 CSS 变量块，并且覆盖关键变量（否则会出现半成品主题）。
// auto 没有自己的块：它由前端解析成 light / dark，所以跳过。
for (const key of themeKeys.filter((item) => item !== 'auto')) {
  const block = themeBlock(key);
  check(`主题「${key}」在 style.css 中有变量块`, Boolean(block));
  if (!block) continue;
  const required = ['--bg', '--panel', '--text', '--topbar-bg', '--code-block-bg'];
  const missingVars = required.filter((name) => !block.includes(`${name}:`));
  check(`主题「${key}」定义了关键变量`, missingVars.length === 0, missingVars.join(', '));
  check(`主题「${key}」声明了 color-scheme`, /color-scheme:/.test(block));
}

const swatchSource = themeListSource ? themeListSource[1] : '';
// 前端配色小方块必须和 CSS 里的真实取值一致，避免「预览和实际不一样」。
// 主题块里没写的变量按 CSS 继承规则回退到 :root。
const rootBlock = themeBlock('dark') ?? '';
for (const match of swatchSource.matchAll(
  /key: '([a-z]+)',[^}]*?swatch: \{ bg: '([^']+)', panel: '([^']+)', accent: '([^']+)' \}/g,
)) {
  const [, key, bg, panel, accent] = match;
  const block = themeBlock(key) ?? '';
  const cssValue = (name) =>
    ((block.match(new RegExp(`${name}:\\s*([^;]+);`)) ?? rootBlock.match(new RegExp(`${name}:\\s*([^;]+);`)) ?? [])[1] ?? '').trim();
  check(
    `主题「${key}」的预览色与 CSS 一致`,
    cssValue('--bg') === bg && cssValue('--panel') === panel && cssValue('--accent') === accent,
    `预览 ${bg}/${panel}/${accent} vs CSS ${cssValue('--bg')}/${cssValue('--panel')}/${cssValue('--accent')}`,
  );
}

/* ---------- 1c. 浅色主题的可读性 ---------- */
//
// 用户报过「文字不适配亮色主题」：写死的浅色（#cfe0ff / #ffd479 / #dbe4f0 …）在
// 暗色底上很好看，切到浅色底就和背景糊在一起。这种问题只有手动切主题才看得见，
// 所以这里直接把它算出来 —— 对比度低于 4.5 就不算通过。

/** '#rrggbb' → [r,g,b]；认不出来返回 null。 */
function parseHex(value) {
  const match = /^#([0-9a-fA-F]{6})$/.exec(String(value).trim());
  if (!match) return null;
  const n = Number.parseInt(match[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** 把可能带 alpha 的颜色摊在底色上，得到实际看到的颜色。 */
function flatten(value, base) {
  const text = String(value).trim();
  const hex = parseHex(text);
  if (hex) return hex;
  const rgba = /^rgba?\(([^)]+)\)$/.exec(text);
  if (!rgba) return null;
  const parts = rgba[1].split(',').map((item) => Number(item.trim()));
  if (parts.length < 3 || parts.slice(0, 3).some((item) => Number.isNaN(item))) return null;
  const alpha = parts.length > 3 ? parts[3] : 1;
  return [0, 1, 2].map((i) => Math.round(parts[i] * alpha + base[i] * (1 - alpha)));
}

function luminance(rgb) {
  const channel = (value) => {
    const s = value / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

/** WCAG 对比度，1~21；算不出来返回 null。 */
function contrast(fgValue, bgValue) {
  const base = parseHex(bgValue) ?? flatten(bgValue, [255, 255, 255]);
  if (!base) return null;
  const fg = flatten(fgValue, base);
  const bg = flatten(bgValue, base);
  if (!fg || !bg) return null;
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** 取某个主题里的变量值，没写就按 CSS 规则回退到 :root。 */
function themeValue(key, name) {
  const block = themeBlock(key) ?? '';
  const pattern = new RegExp(`${name}:\\s*([^;]+);`);
  const own = block.match(pattern);
  if (own) return own[1].trim();
  const root = rootBlock.match(pattern);
  return root ? root[1].trim() : '';
}

// 只有浅底主题需要把「标签文字色」压深；暗底主题里这些值本来就是亮的，天然达标。
for (const key of ['light', 'sand']) {
  const bg = themeValue(key, '--bg');
  for (const name of ['--text', '--text-dim', '--accent-fg', '--success-fg', '--warn-fg', '--danger-fg', '--violet-fg']) {
    const ratio = contrast(themeValue(key, name), bg);
    check(
      `浅色主题「${key}」的 ${name} 在底色上看得清`,
      ratio !== null && ratio >= 4.5,
      `${name}=${themeValue(key, name)} on ${bg} → 对比度 ${ratio === null ? '算不出' : ratio.toFixed(2)}`,
    );
  }
}

// 写死的浅色文字只在暗底上成立。这类色值必须走变量，否则下次换主题又会糊。
const BANNED_HARDCODED = [
  '#cfe0ff', '#dbe4f0', '#b8f0d8', '#8ff0c4',
  '#ffd479', '#ffe6b3', '#ffb4b4', '#ffc9c9', '#ffd9d9', '#c8b8ff',
];
const hardcodedOffenders = [...styleCss.matchAll(/^\s*color:\s*(#[0-9a-fA-F]{3,8})\s*;/gm)]
  .filter((match) => BANNED_HARDCODED.includes(match[1].toLowerCase()))
  .map((match) => match[0].trim());
check(
  '浅色小标签的文字色都走主题变量，没有写死的浅色',
  hardcodedOffenders.length === 0,
  hardcodedOffenders.slice(0, 5).join(' | '),
);

// 首屏内联脚本必须存在，并且用同一个 localStorage key（否则刷新会闪一下）
const themeKeyInApp = (appJs.match(/const THEME_STORAGE_KEY = '([^']+)'/) ?? [])[1];
check('app.js 定义了主题存储 key', Boolean(themeKeyInApp), String(themeKeyInApp));
check(
  'index.html 首屏脚本用同一个 key 预置主题',
  Boolean(themeKeyInApp) && indexHtml.includes(`localStorage.getItem('${themeKeyInApp}')`) && indexHtml.includes('dataset.theme'),
  `key=${themeKeyInApp}`,
);
check('index.html 预留了主题按钮容器', indexHtml.includes('id="theme-area"'));

/* ---------- 2. API 字段契约 ---------- */

mkdirSync(join(ROOT, 'data'), { recursive: true });
for (const suffix of ['', '-wal', '-shm']) rmSync(DB_FILE + suffix, { force: true });
rmSync(AVATAR_DIR, { recursive: true, force: true });
const logFd = openSync(LOG_FILE, 'w');
const child = spawn(process.execPath, [join(ROOT, 'src', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), DB_FILE, AVATAR_DIR, QUIET: '1' },
  stdio: ['ignore', logFd, logFd],
});

function client() {
  let cookie = '';
  return async (path, { method = 'GET', body } = {}) => {
    const response = await fetch(BASE + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    for (const value of response.headers.getSetCookie()) {
      const pair = value.split(';')[0];
      if (pair.startsWith('forum_sid=')) cookie = pair;
    }
    return { status: response.status, json: await response.json().catch(() => null) };
  };
}

const has = (object, path) =>
  path
    .split('.')
    .reduce((current, key) => (current === null || current === undefined ? undefined : current[key]), object) !==
  undefined;

const hasAll = (object, keys) => keys.every((key) => key in object);

try {
  const deadline = Date.now() + 20000;
  let ready = false;
  while (Date.now() < deadline && !ready) {
    try {
      ready = (await fetch(`${BASE}/api/site`)).ok;
    } catch {
      await sleep(180);
    }
  }
  if (!ready) throw new Error('临时服务器未能启动');

  const admin = client();
  await admin('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });

  const site = (await admin('/api/site')).json.data;
  check('site.boards[].slug/name/icon/postCount/replyCount/description', has(site, 'boards.0.slug') && has(site, 'boards.0.name') && has(site, 'boards.0.icon') && has(site, 'boards.0.postCount') && has(site, 'boards.0.replyCount') && has(site, 'boards.0.description'));
  check('site.stats.posts/replies/users', has(site, 'stats.posts') && has(site, 'stats.replies') && has(site, 'stats.users'));
  check(
    'site.coinRules 投币规则（注册赠送 + 单帖上限，无每日补足）',
    has(site, 'coinRules.signupGrant') && has(site, 'coinRules.perPostLimit') && !has(site, 'coinRules.dailyAllowance'),
    JSON.stringify(site.coinRules),
  );
  check('site.hotPosts[].id/title', has(site, 'hotPosts.0.id') && has(site, 'hotPosts.0.title'));

  const list = (await admin('/api/posts?perPage=10&page=1')).json.data;
  const item = list.items[0];
  for (const path of [
    'items.0.id',
    'items.0.title',
    'items.0.excerpt',
    'items.0.board.slug',
    'items.0.board.name',
    'items.0.board.icon',
    'items.0.author.username',
    'items.0.author.displayName',
    'items.0.author.role',
    'items.0.views',
    'items.0.replyCount',
    'items.0.likeCount',
    'items.0.dislikeCount',
    'items.0.coinCount',
    'items.0.bookmarkCount',
    'items.0.myCoins',
    'items.0.liked',
    'items.0.disliked',
    'items.0.bookmarked',
    'items.0.authorFollowed',
    'items.0.author.avatar',
    'items.0.pinned',
    'items.0.locked',
    'items.0.createdAt',
    'items.0.updatedAt',
    'items.0.lastActiveAt',
    'page',
    'perPage',
    'total',
    'totalPages',
    'sort',
  ]) {
    check(`列表接口字段 ${path}`, has(list, path));
  }

  const detail = (await admin(`/api/posts/${item.id}`)).json.data;
  check('详情字段 post.contentHtml / post.myCoins / post.authorFollowed', has(detail, 'post.contentHtml') && has(detail, 'post.myCoins') && has(detail, 'post.authorFollowed'));

  /* ---------- v1.5：头像 ---------- */

  const adminPostRow = list.items.find((row) => row.author.username === 'admin') ?? item;
  const meAvatar = (await admin('/api/auth/me')).json.data;
  check('me.user.avatar 字段存在（前端顶栏头像依赖）', typeof meAvatar.user.avatar === 'string');
  check('回复作者带头像', has(detail, 'replies.0.author.avatar') || detail.replies.length === 0, JSON.stringify(detail.replies[0]?.author));

  const emojiSet = await admin('/api/me/avatar', { method: 'POST', body: { type: 'emoji', emoji: '🌻', hue: 45 } });
  check(
    '设置 emoji 头像返回新的 user.avatar',
    emojiSet.status === 200 && emojiSet.json.data.user.avatar === 'emoji:🌻:45',
    JSON.stringify(emojiSet.json).slice(0, 140),
  );
  check(
    '头像变更即时反映在帖子作者信息里',
    (await admin(`/api/posts/${adminPostRow.id}`)).json.data.post.author.avatar === 'emoji:🌻:45',
  );

  const onePixelPng =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const uploadAvatar = await admin('/api/me/avatar', { method: 'POST', body: { type: 'upload', dataUrl: onePixelPng } });
  check(
    '上传头像返回 file: 地址与 avatarUrl',
    uploadAvatar.status === 200 &&
      uploadAvatar.json.data.user.avatar.startsWith('file:/avatars/') &&
      uploadAvatar.json.data.avatarUrl.startsWith('/avatars/'),
    JSON.stringify(uploadAvatar.json).slice(0, 160),
  );
  const avatarResponse = await fetch(`${BASE}${uploadAvatar.json.data.avatarUrl}`);
  check(
    '头像地址可直接访问（前端 <img src> 用）',
    avatarResponse.status === 200 && avatarResponse.headers.get('content-type') === 'image/png',
    `status=${avatarResponse.status} type=${avatarResponse.headers.get('content-type')}`,
  );
  check(
    '个人主页 user.avatar / 关注列表成员头像字段存在',
    typeof (await admin(`/api/users/${adminPostRow.author.username}`)).json.data.user.avatar === 'string',
  );
  const rankForAvatar = (await admin('/api/ranking?limit=5')).json.data;
  check(
    '排行榜作者带头像字段',
    typeof rankForAvatar.posts[0].author.avatar === 'string' && typeof rankForAvatar.authors[0].user.avatar === 'string',
  );
  const notifForAvatar = (await admin('/api/notifications?perPage=20')).json.data;
  check(
    '通知里的 actor 带头像字段',
    notifForAvatar.items.some((row) => row.actor && typeof row.actor.avatar === 'string') || notifForAvatar.items.length === 0,
  );
  const avatarRepostTarget = list.items.find((row) => row.author.username !== 'admin');
  await admin(`/api/posts/${avatarRepostTarget.id}/repost`, { method: 'POST', body: { comment: '头像契约检查' } });
  const withReposter = (await admin(`/api/posts/${avatarRepostTarget.id}`)).json.data;
  check(
    '转发者列表带头像字段',
    withReposter.reposters.length > 0 && typeof withReposter.reposters[0].user.avatar === 'string',
    JSON.stringify(withReposter.reposters[0]).slice(0, 160),
  );
  await admin(`/api/posts/${avatarRepostTarget.id}/repost`, { method: 'DELETE' });
  const resetAvatar = await admin('/api/me/avatar', { method: 'POST', body: { type: 'reset' } });
  check('重置头像返回空字符串', resetAvatar.json.data.user.avatar === '');
  check('非法头像类型被拒绝', (await admin('/api/me/avatar', { method: 'POST', body: { type: 'x' } })).status === 400);

  check(
    '详情下发投币可用性 post.coin（前端按钮状态依据）',
    hasAll(detail.post.coin ?? {}, ['available', 'reason', 'message', 'myCoins', 'balance', 'perPostLimit', 'signupGrant']) &&
      !has(detail.post.coin ?? {}, 'dailyAllowance'),
    JSON.stringify(detail.post.coin),
  );
  const ownPost = list.items.find((row) => row.author.username === 'admin') ?? item;
  const ownDetail = (await admin(`/api/posts/${ownPost.id}`)).json.data;
  check(
    '作者看自己的帖子时 coin.reason = self（按钮说明「不能给自己投币」）',
    ownDetail.post.coin.reason === 'self' && ownDetail.post.coin.available === false,
    JSON.stringify(ownDetail.post.coin),
  );
  check('回复字段 replies[].contentHtml / author.displayName', has(detail, 'replies.0.contentHtml') && has(detail, 'replies.0.author.displayName'));

  const me = (await admin('/api/auth/me')).json.data;
  check('me.user.id/username/displayName/role', has(me, 'user.id') && has(me, 'user.username') && has(me, 'user.displayName') && has(me, 'user.role'));
  check('me.user.coinBalance（侧栏余额卡片依赖）', has(me, 'user.coinBalance'));
  check('me.unread（消息铃铛依赖）', has(me, 'unread'));

  const created = (
    await admin('/api/posts', { method: 'POST', body: { boardId: site.boards[0].id, title: '契约检查帖', content: '内容' } })
  ).json.data;
  check('发帖返回 id（前端用于跳转）', Number.isInteger(created.id));

  const reply = (await admin(`/api/posts/${created.id}/replies`, { method: 'POST', body: { content: '回复' } })).json.data;
  check('回帖返回 reply.id / replyCount', Number.isInteger(reply.reply.id) && Number.isInteger(reply.replyCount));

  const reaction = (await admin(`/api/posts/${created.id}/reaction`, { method: 'POST', body: { kind: 'like' } })).json.data;
  check(
    '评价返回 liked/disliked/likeCount/dislikeCount',
    hasAll(reaction, ['liked', 'disliked', 'likeCount', 'dislikeCount']) && typeof reaction.liked === 'boolean',
    JSON.stringify(reaction),
  );
  const dislike = (await admin(`/api/posts/${created.id}/reaction`, { method: 'POST', body: { kind: 'dislike' } })).json.data;
  check('踩会清掉赞', dislike.disliked === true && dislike.liked === false && dislike.likeCount === 0);

  const otherPost = list.items.find((row) => row.author.username !== 'admin');
  const coin = (await admin(`/api/posts/${otherPost.id}/coin`, { method: 'POST', body: { amount: 1 } })).json.data;
  check(
    '投币返回 given/myCoins/coinCount/balance/perPostLimit/signupGrant',
    hasAll(coin, ['given', 'myCoins', 'coinCount', 'balance', 'perPostLimit', 'signupGrant']),
    JSON.stringify(coin),
  );

  const bookmark = (await admin(`/api/posts/${created.id}/bookmark`, { method: 'POST' })).json.data;
  check('收藏返回 bookmarked / bookmarkCount', hasAll(bookmark, ['bookmarked', 'bookmarkCount']));

  /* ---------- v1.3：转发 ---------- */

  const otherPostRow = list.items.find((row) => row.author.username !== 'admin');
  check('列表字段 repostCount / reposted / valueScore', has(list, 'items.0.repostCount') && has(list, 'items.0.reposted') && has(list, 'items.0.valueScore'));
  const reposted = (await admin(`/api/posts/${otherPostRow.id}/repost`, { method: 'POST', body: { comment: '契约检查转发' } })).json.data;
  check(
    '转发返回 reposted/updated/repostCount/comment',
    hasAll(reposted, ['reposted', 'updated', 'repostCount', 'comment']) && reposted.reposted === true,
    JSON.stringify(reposted),
  );
  const detailWithReposts = (await admin(`/api/posts/${otherPostRow.id}`)).json.data;
  check(
    '详情返回 reposters（含转发语与用户信息）',
    Array.isArray(detailWithReposts.reposters) &&
      hasAll(detailWithReposts.reposters[0] ?? {}, ['repostId', 'comment', 'createdAt', 'user']) &&
      hasAll(detailWithReposts.reposters[0]?.user ?? {}, ['id', 'username', 'displayName', 'role']),
    JSON.stringify(detailWithReposts.reposters[0]),
  );
  const unreposted = (await admin(`/api/posts/${otherPostRow.id}/repost`, { method: 'DELETE' })).json.data;
  check('撤销转发返回 reposted=false 与新计数', unreposted.reposted === false && typeof unreposted.repostCount === 'number');

  /* ---------- v1.3：排行榜 ---------- */

  check('site.valueWeights 下发权重', hasAll(site.valueWeights ?? {}, ['like', 'coin', 'bookmark', 'dislike', 'dislikeSoftCap', 'halfSaturation']), JSON.stringify(site.valueWeights));
  const ranking = (await admin('/api/ranking?limit=10')).json.data;
  check(
    '排行榜返回 window/weights/posts/authors',
    hasAll(ranking, ['window', 'days', 'weights', 'posts', 'authors']) && ranking.posts.length > 0 && ranking.authors.length > 0,
    JSON.stringify({ window: ranking.window, posts: ranking.posts.length, authors: ranking.authors.length }),
  );
  check(
    '文章榜字段（含 baseScore/valueScore）',
    hasAll(ranking.posts[0], [
      'id',
      'title',
      'excerpt',
      'board',
      'author',
      'createdAt',
      'likeCount',
      'dislikeCount',
      'coinCount',
      'bookmarkCount',
      'repostCount',
      'baseScore',
      'valueScore',
      'liked',
      'bookmarked',
    ]),
    JSON.stringify(ranking.posts[0]).slice(0, 220),
  );
  check(
    '作者榜字段（含 totalValue/avgValue/rank）',
    hasAll(ranking.authors[0], [
      'rank',
      'user',
      'postCount',
      'totalValue',
      'avgValue',
      'bestValue',
      'likesReceived',
      'dislikesReceived',
      'coinsReceived',
      'bookmarksReceived',
      'repliesReceived',
    ]),
    JSON.stringify(ranking.authors[0]).slice(0, 220),
  );
  const prof = (await admin(`/api/users/${otherPostRow.author.username}`)).json.data;
  check(
    '个人主页返回个人权重 value{totalValue,avgValue,rank}',
    hasAll(prof.value ?? {}, ['totalValue', 'avgValue', 'bestValue', 'postCount', 'rank', 'weights']) &&
      has(prof, 'repostCount'),
    JSON.stringify(prof.value),
  );

  const target = list.items.find((row) => row.author.username !== 'admin');
  const follow = (await admin(`/api/users/${target.author.id}/follow`, { method: 'POST' })).json.data;
  check('关注返回 following / followerCount', hasAll(follow, ['following', 'followerCount']) && typeof follow.following === 'boolean', JSON.stringify(follow));

  const profile = (await admin(`/api/users/${target.author.username}`)).json.data;
  check(
    '个人主页 user 字段齐全',
    hasAll(profile.user, [
      'id',
      'username',
      'displayName',
      'role',
      'bio',
      'createdAt',
      'postCount',
      'replyCount',
      'followerCount',
      'followingCount',
      'likesReceived',
      'dislikesReceived',
      'coinsReceived',
      'isMe',
      'isFollowing',
    ]),
    JSON.stringify(profile.user).slice(0, 240),
  );
  check('个人主页返回 followers/following/posts', Array.isArray(profile.followers) && Array.isArray(profile.following) && Array.isArray(profile.posts));
  check(
    '关注列表成员字段（前端 chip 依赖）',
    hasAll(profile.followers[0] ?? profile.following[0] ?? {}, ['id', 'username', 'displayName', 'role', 'viewerFollows']),
  );

  const following = (await admin('/api/me/following')).json.data;
  check('我的关注返回 items/counts/coinBalance', Array.isArray(following.items) && has(following, 'counts.followerCount') && has(following, 'counts.followingCount') && has(following, 'coinBalance'), JSON.stringify(following.counts));

  const notifications = (await admin('/api/notifications?perPage=20')).json.data;
  check(
    '通知列表返回 items/total/totalPages/unreadCount',
    Array.isArray(notifications.items) && ['total', 'totalPages', 'unreadCount', 'page', 'perPage'].every((key) => key in notifications),
  );
  const withActor = notifications.items.find((row) => row.actor);
  check(
    '通知条目字段（渲染依赖）',
    hasAll(notifications.items[0], ['id', 'type', 'excerpt', 'read', 'createdAt', 'actor', 'post']) &&
      hasAll(withActor?.actor ?? {}, ['id', 'username', 'displayName', 'role']),
    `first=${JSON.stringify(notifications.items[0])} actor=${JSON.stringify(withActor?.actor)}`,
  );
  check('系统通知的 actor 为 null（渲染时显示「系统」）', notifications.items.some((row) => row.actor === null));
  check('通知的 post 摘要含 id/title/deleted', hasAll(notifications.items.find((row) => row.post)?.post ?? {}, ['id', 'title', 'deleted']));

  const summary = (await admin('/api/notifications/summary')).json.data;
  check('未读数摘要返回 unread', typeof summary.unread === 'number');
  const readOne = (await admin(`/api/notifications/${notifications.items.find((row) => !row.read)?.id ?? notifications.items[0].id}/read`, { method: 'POST' })).json.data;
  check('单条已读返回剩余未读数', typeof readOne.unread === 'number');
  const readAll = (await admin('/api/notifications/read-all', { method: 'POST' })).json.data;
  check('全部已读返回 unread=0', readAll.unread === 0);

  const preview = (await admin('/api/markdown/preview', { method: 'POST', body: { content: '**x**' } })).json.data;
  check('预览返回 html', typeof preview.html === 'string');

  /* ---------- v1.2：签到 / 主页分类与置顶 / 账号设置 ---------- */

  check('site.checkinRules 下发签到规则', has(site, 'checkinRules.dailyReward') && has(site, 'checkinRules.weeklyBonus') && has(site, 'checkinRules.fullWeekDays'));
  check('site.profileRules 下发主页规则', has(site, 'profileRules.pinLimit') && has(site, 'profileRules.categoryLimit'));

  const checkin = (await admin('/api/checkin')).json.data;
  check(
    '签到状态字段齐全',
    hasAll(checkin, [
      'today',
      'checkedInToday',
      'streak',
      'total',
      'weekStart',
      'week',
      'weekAttended',
      'dailyReward',
      'weeklyBonus',
      'fullWeekDays',
      'pendingBonus',
      'bonusHistory',
      'calendar',
      'coinBalance',
    ]),
    JSON.stringify(checkin).slice(0, 200),
  );
  check('签到日历 35 天且结构完整', checkin.calendar.length === 35 && hasAll(checkin.calendar[0], ['day', 'attended', 'isToday', 'future']));
  check('本周为 7 天且结构完整', checkin.week.length === 7 && hasAll(checkin.week[0], ['day', 'attended', 'isToday', 'future']));

  const checkinResult = await admin('/api/checkin', { method: 'POST' });
  check(
    '签到接口返回奖励/全勤奖/余额',
    checkinResult.status === 200
      ? hasAll(checkinResult.json.data, ['reward', 'bonus', 'bonusWeeks', 'gain', 'streak', 'coinBalance'])
      : checkinResult.json?.error?.code === 'already_checked_in',
    JSON.stringify(checkinResult.json).slice(0, 180),
  );

  const categoryList = (await admin('/api/me/categories')).json.data;
  check('分类列表返回 items/limit/uncategorizedCount', Array.isArray(categoryList.items) && has(categoryList, 'limit') && has(categoryList, 'uncategorizedCount'));
  const categoryCreated = (await admin('/api/me/categories', { method: 'POST', body: { name: '契约分类' } })).json.data;
  check(
    '创建分类返回 id/name/postCount',
    hasAll(categoryCreated.category ?? {}, ['id', 'name', 'postCount']),
    JSON.stringify(categoryCreated),
  );
  const categoryId = categoryCreated.category.id;
  check('重命名分类返回新名称', (await admin(`/api/me/categories/${categoryId}`, { method: 'PUT', body: { name: '契约分类2' } })).json.data.category.name === '契约分类2');

  const categorized = (await admin(`/api/posts/${created.id}/category`, { method: 'POST', body: { categoryId } })).json.data;
  check('设置文章分类返回 category 与未分类计数', hasAll(categorized, ['postId', 'category', 'uncategorizedCount']) && categorized.category.id === categoryId);

  const pinned = (await admin(`/api/posts/${created.id}/profile-pin`, { method: 'POST', body: { pinned: true } })).json.data;
  check(
    '主页置顶返回 profilePinned/pinnedCount/pinLimit',
    hasAll(pinned, ['postId', 'profilePinned', 'pinnedCount', 'pinLimit']) && pinned.profilePinned === true,
    JSON.stringify(pinned),
  );

  const profileV12 = (await admin(`/api/users/${target.author.username}`)).json.data;
  check(
    '个人主页返回分类/置顶/筛选字段',
    Array.isArray(profileV12.categories) &&
      hasAll(profileV12, ['uncategorizedCount', 'pinnedCount', 'pinLimit', 'categoryLimit', 'filter']) &&
      hasAll(profileV12.categories[0] ?? {}, ['id', 'name', 'postCount']),
    JSON.stringify({ categories: profileV12.categories, pinned: profileV12.pinnedCount }).slice(0, 200),
  );
  const profileFiltered = (await admin(`/api/users/${target.author.username}?category=none`)).json.data;
  check('个人主页支持按分类筛选', profileFiltered.filter === 'none' && profileFiltered.posts.every((row) => row.category === null));
  check('个人主页文章带分类与置顶字段', hasAll((await admin(`/api/users/${target.author.username}`)).json.data.posts[0] ?? {}, ['category', 'profilePinned']));

  const profileSaved = (await admin('/api/me/profile', { method: 'POST', body: { displayName: '站长', bio: '契约检查签名' } })).json.data;
  check('保存资料返回新的 user', profileSaved.user.bio === '契约检查签名' && profileSaved.user.displayName === '站长');

  const passwordResult = await admin('/api/auth/password', {
    method: 'POST',
    body: { currentPassword: 'admin123', newPassword: 'admin12345' },
  });
  check(
    '修改密码返回 changed/revokedSessions',
    passwordResult.status === 200 && hasAll(passwordResult.json.data, ['changed', 'revokedSessions']),
    JSON.stringify(passwordResult.json).slice(0, 160),
  );
  check('改密后新密码可登录', (await client()('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin12345' } })).status === 200);
  check('改密后旧密码被拒绝', (await client()('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } })).status === 401);

  const overview = (await admin('/api/admin/overview')).json.data;
  check(
    '后台 stats 字段齐全',
    ['users', 'posts', 'replies', 'reactions', 'coins', 'follows', 'bookmarks', 'postsToday', 'repliesToday', 'banned'].every(
      (key) => key in overview.stats,
    ),
    JSON.stringify(overview.stats),
  );
  check(
    '后台 users[].postCount/replyCount/followerCount/coinBalance/banned/createdAt',
    ['postCount', 'replyCount', 'followerCount', 'coinBalance', 'banned', 'createdAt'].every((key) => key in overview.users[0]),
  );
  check('后台 recentPosts[].author/board/views', ['author', 'board', 'views', 'createdAt'].every((key) => key in overview.recentPosts[0]));

  /* ---------- v1.6：角色与内容管理 ---------- */

  check(
    '后台返回 viewer 角色（前端据此显示站长专属按钮）',
    hasAll(overview.viewer ?? {}, ['id', 'role', 'isOwner']) &&
      overview.viewer.role === 'owner' &&
      overview.viewer.isOwner === true,
    JSON.stringify(overview.viewer),
  );
  check(
    '后台 stats 含已隐藏数与管理团队数',
    'hiddenPosts' in overview.stats && 'staff' in overview.stats,
    JSON.stringify(overview.stats),
  );
  check(
    '后台返回隐藏文章列表（含原因/操作人）',
    Array.isArray(overview.hiddenPosts),
    JSON.stringify(overview.hiddenPosts?.slice(0, 1)),
  );
  check(
    '后台返回审计日志（含 actor 与 action）',
    Array.isArray(overview.moderationLogs) &&
      (overview.moderationLogs.length === 0 ||
        hasAll(overview.moderationLogs[0], ['id', 'action', 'targetType', 'targetId', 'targetLabel', 'reason', 'createdAt', 'actor'])),
    JSON.stringify(overview.moderationLogs?.[0]),
  );
  check('最近发布带 hidden 标记', 'hidden' in (overview.recentPosts[0] ?? {}));
  check('列表接口带 hidden / hiddenReason 字段', 'hidden' in (list.items[0] ?? {}) && 'hiddenReason' in (list.items[0] ?? {}));

  const hideTargetPost = (
    await admin('/api/posts', { method: 'POST', body: { boardId: site.boards[0].id, title: '契约隐藏目标', content: '用来验证隐藏/恢复' } })
  ).json.data;
  const memberClient = client();
  const memberName = `cm_${Date.now().toString(36)}`;
  const memberReg = await memberClient('/api/auth/register', { method: 'POST', body: { username: memberName, password: 'secret123' } });
  const memberId = memberReg.json.data.user.id;
  check('新注册用户默认是 member', memberReg.json.data.user.role === 'member', JSON.stringify(memberReg.json.data.user));

  const grant = await admin(`/api/admin/users/${memberId}/role`, { method: 'POST', body: { role: 'admin' } });
  check(
    '站长可以任命管理员（返回 user/changed/staff）',
    grant.status === 200 && grant.json.data.user.role === 'admin' && hasAll(grant.json.data, ['user', 'changed', 'staff']),
    JSON.stringify(grant.json).slice(0, 180),
  );
  check(
    '普通成员不能任命管理员（403）',
    (await memberClient(`/api/admin/users/${overview.viewer.id}/role`, { method: 'POST', body: { role: 'member' } })).status === 403,
  );
  check(
    '站长不能修改自己的角色（400）',
    (await admin(`/api/admin/users/${overview.viewer.id}/role`, { method: 'POST', body: { role: 'member' } })).status === 400,
  );
  check(
    '不能把别人设成站长（400）',
    (await admin(`/api/admin/users/${memberId}/role`, { method: 'POST', body: { role: 'owner' } })).status === 400,
  );

  const hiddenResult = (
    await memberClient(`/api/admin/posts/${hideTargetPost.id}/hide`, { method: 'POST', body: { hidden: true, reason: '契约检查' } })
  ).json.data;
  check(
    '管理员可以隐藏文章（返回 hidden/hiddenReason/hiddenCount/post）',
    hasAll(hiddenResult, ['postId', 'hidden', 'hiddenReason', 'hiddenCount', 'post']) && hiddenResult.post.hidden === true,
    JSON.stringify(hiddenResult).slice(0, 180),
  );
  check('隐藏后访客看到 404', (await client()(`/api/posts/${hideTargetPost.id}`)).status === 404);
  check(
    '管理团队列表里带 hidden=true',
    (await memberClient('/api/posts?perPage=30')).json.data.items.some((row) => row.id === hideTargetPost.id && row.hidden === true),
  );
  const restored = (
    await memberClient(`/api/admin/posts/${hideTargetPost.id}/hide`, { method: 'POST', body: { hidden: false } })
  ).json.data;
  check('可以恢复显示', restored.hidden === false && restored.post.hidden === false);
  check('恢复后访客可以打开', (await client()(`/api/posts/${hideTargetPost.id}`)).status === 200);

  const revoke = await admin(`/api/admin/users/${memberId}/role`, { method: 'POST', body: { role: 'member' } });
  check('站长可以收回管理员权限', revoke.json.data.user.role === 'member' && revoke.json.data.changed === true);
  check('收回后访问后台变 403', (await memberClient('/api/admin/overview')).status === 403);
  const logsAfter = (await admin('/api/admin/overview')).json.data.moderationLogs;
  check(
    '审计日志记录了任命/隐藏/恢复/收回',
    ['grant_admin', 'hide_post', 'unhide_post', 'revoke_admin'].every((action) => logsAfter.some((row) => row.action === action)),
    JSON.stringify(logsAfter.map((row) => row.action)),
  );

  const selfBan = (await admin(`/api/admin/users/${me.user.id}/ban`, { method: 'POST', body: { banned: true } })).json;
  check('封禁自己的请求被拒绝（前端会先隐藏按钮）', selfBan.ok === false);

  /* ---------- v1.7：私信与黑名单 ---------- */

  check('site 下发 messageRules', hasAll(site.messageRules ?? {}, ['oneWayDailyLimit', 'maxLength']), JSON.stringify(site.messageRules));

  const dmA = client();
  const dmB = client();
  const dmAName = `ca_${Date.now().toString(36)}`;
  const dmBName = `cb_${Date.now().toString(36)}`;
  const regA = await dmA('/api/auth/register', { method: 'POST', body: { username: dmAName, password: 'secret123' } });
  const regB = await dmB('/api/auth/register', { method: 'POST', body: { username: dmBName, password: 'secret123' } });
  check('私信用例账号注册成功', regA.status === 200 && regB.status === 200);
  const idA = regA.json.data.user.id;
  const idB = regB.json.data.user.id;

  await dmB(`/api/users/${idA}/follow`, { method: 'POST' });
  const firstDm = await dmB(`/api/messages/${dmAName}`, { method: 'POST', body: { content: '单向关注的第一条' } });
  check(
    '发私信返回 message + availability',
    firstDm.status === 200 &&
      hasAll(firstDm.json.data, ['message', 'availability', 'unread']) &&
      hasAll(firstDm.json.data.message, ['id', 'content', 'createdAt', 'read', 'senderId', 'recipientId']),
    JSON.stringify(firstDm.json).slice(0, 180),
  );
  check(
    'availability 字段齐全（前端按钮状态依据）',
    hasAll(firstDm.json.data.availability, [
      'canSend',
      'reason',
      'message',
      'mutual',
      'followed',
      'blockedByMe',
      'blockedMe',
      'sentToday',
      'dailyLimit',
      'remainingToday',
      'resetsAt',
    ]),
    JSON.stringify(firstDm.json.data.availability),
  );
  check('单方面关注只剩 0 条', firstDm.json.data.availability.remainingToday === 0);
  check(
    '超额发送返回 429 + daily_limit',
    (await dmB(`/api/messages/${dmAName}`, { method: 'POST', body: { content: '第二条' } })).status === 429,
  );

  const conversations = await dmA('/api/messages');
  check(
    '会话列表字段齐全',
    hasAll(conversations.json.data, ['items', 'unread', 'rules']) &&
      hasAll(conversations.json.data.items[0] ?? {}, ['peer', 'lastMessage', 'unread']) &&
      hasAll(conversations.json.data.items[0]?.peer ?? {}, ['id', 'username', 'displayName', 'role', 'avatar']) &&
      hasAll(conversations.json.data.items[0]?.lastMessage ?? {}, ['content', 'createdAt', 'mine', 'read']),
    JSON.stringify(conversations.json.data.items[0]),
  );
  const threadData = (await dmA(`/api/messages/${dmBName}`)).json.data;
  check(
    '会话详情字段齐全',
    hasAll(threadData, ['peer', 'messages', 'total', 'unreadBefore', 'availability', 'rules']) &&
      hasAll(threadData.messages[0] ?? {}, ['id', 'content', 'createdAt', 'read', 'senderId', 'recipientId']),
    JSON.stringify(threadData).slice(0, 200),
  );
  check('私信摘要接口可用（顶栏角标）', typeof (await dmA('/api/messages/summary')).json.data.unread === 'number');

  await dmA(`/api/users/${idB}/follow`, { method: 'POST' });
  const mutualDm = await dmB(`/api/messages/${dmAName}`, { method: 'POST', body: { content: '互关后的第二条' } });
  check(
    '互相关注后 availability.mutual = true 且不限量',
    mutualDm.status === 200 && mutualDm.json.data.availability.mutual === true && mutualDm.json.data.availability.remainingToday === null,
  );

  const block = await dmA(`/api/users/${idB}/block`, { method: 'POST', body: { blocked: true } });
  check(
    '拉黑返回 blocked/changed/blockCount',
    block.status === 200 && hasAll(block.json.data, ['blocked', 'changed', 'blockCount']) && block.json.data.blocked === true,
  );
  check('被拉黑者关注返回 403', (await dmB(`/api/users/${idA}/follow`, { method: 'POST' })).status === 403);
  const blockedDm = await dmB(`/api/messages/${dmAName}`, { method: 'POST', body: { content: '还能发吗' } });
  check(
    '被拉黑者私信返回 403 blocked_me',
    blockedDm.status === 403 && blockedDm.json.error?.code === 'blocked_me',
    JSON.stringify(blockedDm.json),
  );
  check('被拉黑者主页 404', (await dmB(`/api/users/${dmAName}`)).status === 404);
  const blockList = await dmA('/api/me/blocks');
  check(
    '黑名单接口字段齐全',
    hasAll(blockList.json.data, ['items', 'total']) &&
      hasAll(blockList.json.data.items[0] ?? {}, ['id', 'username', 'displayName', 'avatar', 'blockedAt']),
    JSON.stringify(blockList.json.data),
  );
  const profileBlocked = (await dmA(`/api/users/${dmBName}`)).json.data;
  check(
    '主页返回 blockedByMe / mutualFollow / followsMe',
    ['blockedByMe', 'mutualFollow', 'followsMe'].every((key) => key in profileBlocked.user) && profileBlocked.user.blockedByMe === true,
    JSON.stringify(profileBlocked.user),
  );
  check(
    '主页返回 messageAvailability（私信按钮依据）',
    hasAll(profileBlocked.messageAvailability ?? {}, ['canSend', 'reason', 'message', 'mutual', 'remainingToday']),
    JSON.stringify(profileBlocked.messageAvailability),
  );
  check(
    '拉黑后帖子列表互相不可见',
    !(await dmB('/api/posts?perPage=30')).json.data.items.some((row) => row.author.username === dmAName),
  );
  check('解除拉黑', (await dmA(`/api/users/${idB}/block`, { method: 'POST', body: { blocked: false } })).json.data.blocked === false);
} catch (error) {
  problems.push(`契约检查异常：${error.message}`);
} finally {
  try {
    child.kill();
  } catch {
    /* 忽略 */
  }
  await sleep(400);
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(DB_FILE + suffix, { force: true });
    } catch {
      /* 文件仍被占用时忽略，脚本已跑完检查 */
    }
  }
  try {
    rmSync(AVATAR_DIR, { recursive: true, force: true });
    rmSync(LOG_FILE, { force: true });
  } catch {
    /* 忽略 */
  }
}

for (const line of notes) console.log(line);

/* ---------- 3. 不下降哨兵 ---------- */
// 断言数掉下去 = 有断言没被执行（文件被搬走、正则不再命中、提前 return）。
// 这是 R-08「重构让静态检查静默失效」的最后一道防线。
if (notes.length < MIN_CHECKS) {
  problems.push(`通过项数从 ${MIN_CHECKS} 掉到 ${notes.length}：有断言没被执行（前端文件被搬走却没同步本检查？）`);
}

console.log(`\n${'─'.repeat(46)}`);
console.log(`通过 ${notes.length} 项（下限 ${MIN_CHECKS}），问题 ${problems.length} 项`);
for (const problem of problems) console.log(`  ❌ ${problem}`);
if (problems.length) {
  console.log('\n服务器日志尾部（供排查）：');
  // ⚠️ 必须 existsSync 兜一层：起服务器那步如果自己就失败了（端口被占、被沙箱拦），
  // 日志文件根本不会生成，这里 readFileSync 会抛 ENOENT —— 那样「3 个问题」就变成
  // 一个看不懂的堆栈，真正的失败原因反而被盖掉（踩过一次）。
  console.log(existsSync(LOG_FILE) ? readFileSync(LOG_FILE, 'utf8').slice(-1500) : `（没有 ${LOG_FILE}）`);
}
process.exit(problems.length ? 1 : 0);
