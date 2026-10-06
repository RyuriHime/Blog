/**
 * 端到端冒烟测试：启动一个临时服务器（独立数据库 + 独立端口），
 * 跑完真实 HTTP 请求后关闭。用法：node scripts/smoke.mjs
 */
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';

import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const SERVER = join(ROOT, 'src', 'server.js');
const DB_FILE = join(ROOT, 'data', 'smoke.db');
const AVATAR_DIR = join(ROOT, 'data', 'smoke-avatars');
const LOG_FILE = join(ROOT, 'data', 'smoke-server.log');
const PORT = Number(process.env.SMOKE_PORT || 3411);
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** 带 cookie 罐的极简 HTTP 客户端 */
function createClient() {
  let cookie = '';
  return {
    get cookie() {
      return cookie;
    },
    async call(path, { method = 'GET', body, raw = false } = {}) {
      const response = await fetch(BASE + path, {
        method,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'manual',
      });
      for (const value of response.headers.getSetCookie()) {
        const pair = value.split(';')[0];
        if (pair.startsWith('forum_sid=')) cookie = pair;
      }
      if (raw) return response;
      const json = await response.json().catch(() => null);
      return { status: response.status, body: json, data: json?.data, error: json?.error };
    },
  };
}

const typeOf = (items, type, predicate = () => true) =>
  items.find((item) => item.type === type && predicate(item));

async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/api/site`);
      if (response.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(180);
  }
  return false;
}

mkdirSync(join(ROOT, 'data'), { recursive: true });
for (const suffix of ['', '-wal', '-shm']) rmSync(DB_FILE + suffix, { force: true });
rmSync(AVATAR_DIR, { recursive: true, force: true });

const logFd = openSync(LOG_FILE, 'w');
const child = spawn(process.execPath, [SERVER], {
  env: { ...process.env, PORT: String(PORT), DB_FILE, AVATAR_DIR, QUIET: '1' },
  stdio: ['ignore', logFd, logFd],
});

const finish = async (code) => {
  try {
    child.kill();
  } catch {
    /* 忽略 */
  }
  // Windows 上子进程刚被杀掉时文件还锁着，等一下再清，失败也不影响退出码
  await sleep(400);
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(DB_FILE + suffix, { force: true });
    } catch {
      /* 忽略 */
    }
  }
  try {
    rmSync(AVATAR_DIR, { recursive: true, force: true });
    rmSync(LOG_FILE, { force: true });
  } catch {
    /* 忽略 */
  }
  process.exit(code);
};

try {
  const ready = await waitForServer();
  if (!ready) {
    console.error('服务器启动失败，日志如下：\n');
    console.error(readFileSync(LOG_FILE, 'utf8').slice(-4000));
    await finish(1);
  }

  const anon = createClient();
  const admin = createClient();
  const member = createClient();
  const bob = createClient();
  const unique = Date.now().toString(36);

  console.log('\n▶ 站点与静态资源');
  const site = await anon.call('/api/site');
  check('GET /api/site 返回板块列表', site.status === 200 && site.data.boards.length >= 5, `status=${site.status}`);
  check('站点统计包含帖子数', site.data.stats.posts > 0, JSON.stringify(site.data?.stats));
  check(
    '下发投币规则（注册赠送 + 单帖上限，没有每日补足）',
    site.data.coinRules?.signupGrant === 10 &&
      site.data.coinRules?.perPostLimit === 2 &&
      site.data.coinRules?.dailyAllowance === undefined,
    JSON.stringify(site.data?.coinRules),
  );
  const home = await anon.call('/', { raw: true });
  const homeHtml = await home.text();
  check('首页 HTML 正常返回', home.status === 200 && homeHtml.includes('围炉论坛'));
  const css = await anon.call('/style.css', { raw: true });
  check('样式表可访问', css.status === 200 && css.headers.get('content-type').includes('text/css'));
  const spa = await anon.call('/post/1', { raw: true });
  check('未知路径回落 SPA 入口', spa.status === 200);

  console.log('\n▶ 注册 / 登录 / 会话');
  const anonWrite = await anon.call('/api/posts', { method: 'POST', body: { boardId: 1, title: '未登录', content: 'x' } });
  check('未登录发帖被拒绝（401）', anonWrite.status === 401, `status=${anonWrite.status}`);

  const adminLogin = await admin.call('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
  check('站长可登录', adminLogin.status === 200 && adminLogin.data.user.role === 'owner', JSON.stringify(adminLogin.data?.user));
  check('登录后下发会话 Cookie', admin.cookie.startsWith('forum_sid='), admin.cookie);

  const badLogin = await anon.call('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'wrong-password' } });
  check('错误密码返回 401', badLogin.status === 401, `status=${badLogin.status}`);

  const register = await member.call('/api/auth/register', {
    method: 'POST',
    body: { username: `smoke_${unique}`, password: 'secret123', displayName: '冒烟测试员' },
  });
  check('新用户注册成功', register.status === 200 && register.data.user.username === `smoke_${unique}`);
  const me = await member.call('/api/auth/me');
  check('会话保持有效', me.data?.user?.displayName === '冒烟测试员');
  check('新用户注册赠送 10 币', me.data?.user?.coinBalance === 10, String(me.data?.user?.coinBalance));
  check('新用户收到欢迎通知', me.data?.unread >= 1, `unread=${me.data?.unread}`);

  const welcome = await member.call('/api/notifications');
  check('欢迎通知类型为 system', Boolean(typeOf(welcome.data.items, 'system')), JSON.stringify(welcome.data.items[0]));

  const duplicate = await anon.call('/api/auth/register', {
    method: 'POST',
    body: { username: `smoke_${unique}`, password: 'secret123' },
  });
  check('同名注册被拒绝（409）', duplicate.status === 409, `status=${duplicate.status}`);

  console.log('\n▶ 发帖 / 列表 / 分页');
  const created = await member.call('/api/posts', {
    method: 'POST',
    body: {
      boardId: site.data.boards.find((board) => board.slug === 'tech').id,
      title: `冒烟测试帖 ${unique}`,
      content: `## 小标题\n\n这是 **粗体** 与 \`行内代码\`。\n\n\`\`\`js\nconst x = 1;\n\`\`\`\n\n<script>alert('xss')</script>`,
    },
  });
  check('发帖成功返回 id', created.status === 200 && Number.isInteger(created.data.id), JSON.stringify(created.body));
  const postId = created.data.id;

  const shortTitle = await member.call('/api/posts', { method: 'POST', body: { boardId: 1, title: 'x', content: 'yy' } });
  check('过短标题被拒绝（400）', shortTitle.status === 400, `status=${shortTitle.status}`);

  const listed = await anon.call('/api/posts?perPage=5&page=1');
  check('列表分页字段完整', listed.data.items.length <= 5 && listed.data.totalPages >= 1);
  check(
    '列表返回评价与收藏计数字段',
    ['likeCount', 'dislikeCount', 'coinCount', 'bookmarkCount', 'myCoins', 'liked', 'disliked', 'authorFollowed'].every(
      (key) => key in listed.data.items[0],
    ),
  );
  check('新帖出现在列表中', listed.data.items.some((item) => item.id === postId) || listed.data.total > 5);

  const searched = await anon.call(`/api/posts?q=${unique}`);
  check('全文搜索命中新帖', searched.data.items.length === 1 && searched.data.items[0].id === postId);

  console.log('\n▶ 详情 / Markdown 安全');
  const detail = await anon.call(`/api/posts/${postId}`);
  check('详情返回渲染后的 HTML', detail.data.post.contentHtml.includes('<strong>粗体</strong>'));
  check('代码块被渲染', detail.data.post.contentHtml.includes('md-code'));
  check('脚本注入被转义', !detail.data.post.contentHtml.includes('<script>'), detail.data.post.contentHtml.slice(0, 120));
  check('浏览数自增', detail.data.post.views >= 1);

  const preview = await member.call('/api/markdown/preview', { method: 'POST', body: { content: '**预览**' } });
  check('预览接口可用', preview.data.html.includes('<strong>预览</strong>'));

  console.log('\n▶ 评价：赞 / 踩');
  const like1 = await member.call(`/api/posts/${postId}/reaction`, { method: 'POST', body: { kind: 'like' } });
  check('点赞生效', like1.data.liked === true && like1.data.likeCount === 1, JSON.stringify(like1.data));
  const like2 = await member.call(`/api/posts/${postId}/reaction`, { method: 'POST', body: { kind: 'like' } });
  check('再次点赞取消', like2.data.liked === false && like2.data.likeCount === 0, JSON.stringify(like2.data));
  const dislike = await member.call(`/api/posts/${postId}/reaction`, { method: 'POST', body: { kind: 'dislike' } });
  check('踩生效', dislike.data.disliked === true && dislike.data.dislikeCount === 1, JSON.stringify(dislike.data));
  const switchBack = await member.call(`/api/posts/${postId}/reaction`, { method: 'POST', body: { kind: 'like' } });
  check(
    '赞与踩互斥（改赞后踩清空）',
    switchBack.data.liked === true && switchBack.data.disliked === false && switchBack.data.dislikeCount === 0,
    JSON.stringify(switchBack.data),
  );
  const badKind = await member.call(`/api/posts/${postId}/reaction`, { method: 'POST', body: { kind: 'love' } });
  check('非法评价类型被拒绝（400）', badKind.status === 400, `status=${badKind.status}`);
  const anonReaction = await anon.call(`/api/posts/${postId}/reaction`, { method: 'POST', body: { kind: 'like' } });
  check('未登录不能评价（401）', anonReaction.status === 401, `status=${anonReaction.status}`);

  console.log('\n▶ 投币');
  const balanceBefore = (await admin.call('/api/auth/me')).data.user.coinBalance;
  const adminCoin = await admin.call(`/api/posts/${postId}/coin`, { method: 'POST', body: { amount: 1 } });
  check('投币成功并返回余额', adminCoin.status === 200 && adminCoin.data.given === 1 && adminCoin.data.myCoins === 1, JSON.stringify(adminCoin.data));
  check(
    '投币后帖子币数 +1、余额 -1',
    adminCoin.data.coinCount === 1 && adminCoin.data.balance === balanceBefore - 1,
    JSON.stringify({ ...adminCoin.data, balanceBefore }),
  );
  const adminCoin2 = await admin.call(`/api/posts/${postId}/coin`, { method: 'POST', body: { amount: 1 } });
  check('同一用户可给同一帖子投第 2 币', adminCoin2.data.myCoins === 2 && adminCoin2.data.coinCount === 2);
  const adminCoin3 = await admin.call(`/api/posts/${postId}/coin`, { method: 'POST', body: { amount: 1 } });
  check('超过单帖上限被拒绝（400）', adminCoin3.status === 400 && adminCoin3.error?.code === 'per_post_limit', JSON.stringify(adminCoin3.body));
  const selfCoin = await member.call(`/api/posts/${postId}/coin`, { method: 'POST', body: { amount: 1 } });
  check('不能给自己的帖子投币（400）', selfCoin.status === 400 && selfCoin.error?.code === 'self_coin', JSON.stringify(selfCoin.body));
  const anonCoin = await anon.call(`/api/posts/${postId}/coin`, { method: 'POST', body: { amount: 1 } });
  check('未登录不能投币（401）', anonCoin.status === 401);

  // 详情接口会下发「当前浏览者能否投币」，前端据此展示原因（避免点了没反应的死按钮）
  const detailAsAnon = await anon.call(`/api/posts/${postId}`);
  check(
    '未登录时详情告知需要登录才能投币',
    detailAsAnon.data.post.coin.available === false && detailAsAnon.data.post.coin.reason === 'anonymous',
    JSON.stringify(detailAsAnon.data.post.coin),
  );
  const detailAsAuthor = await member.call(`/api/posts/${postId}`);
  check(
    '作者看自己的帖子得到 self 原因',
    detailAsAuthor.data.post.coin.available === false &&
      detailAsAuthor.data.post.coin.reason === 'self' &&
      detailAsAuthor.data.post.coin.message.length > 0,
    JSON.stringify(detailAsAuthor.data.post.coin),
  );
  const detailAfterLimit = await admin.call(`/api/posts/${postId}`);
  check(
    '投满 2 币后详情告知已达单帖上限',
    detailAfterLimit.data.post.coin.available === false && detailAfterLimit.data.post.coin.reason === 'per_post_limit',
    JSON.stringify(detailAfterLimit.data.post.coin),
  );
  const bobEarlyLogin = await bob.call('/api/auth/login', { method: 'POST', body: { username: 'bob', password: 'demo1234' } });
  check('Bob 可登录（用于投币可用性检查）', bobEarlyLogin.status === 200);
  const detailAsOther = await bob.call(`/api/posts/${postId}`);
  check(
    '可投币时详情返回 available=true 与余额',
    detailAsOther.data.post.coin.available === true &&
      detailAsOther.data.post.coin.reason === 'ok' &&
      detailAsOther.data.post.coin.balance > 0,
    JSON.stringify(detailAsOther.data.post.coin),
  );

  // 注册赠送的 10 币花光后就不能再投了
  const spender = createClient();
  await spender.call('/api/auth/register', { method: 'POST', body: { username: `coin_${unique}`, password: 'secret123' } });
  const targets = (await anon.call('/api/posts?perPage=10')).data.items.filter((item) => item.author.username !== `coin_${unique}`);
  let spent = 0;
  for (const target of targets.slice(0, 5)) {
    for (let i = 0; i < 2; i += 1) {
      const result = await spender.call(`/api/posts/${target.id}/coin`, { method: 'POST', body: { amount: 1 } });
      if (result.status === 200) spent += 1;
    }
  }
  check('注册赠送的 10 币可以花完', spent === 10, `spent=${spent}`);
  const broke = await spender.call(`/api/posts/${targets[5].id}/coin`, { method: 'POST', body: { amount: 1 } });
  check('币花完后拒绝投币（400）', broke.status === 400 && broke.error?.code === 'insufficient_coins', JSON.stringify(broke.body));
  check('拒绝原因文案指向签到而不是每日刷新', /签到/.test(broke.error?.message ?? ''), broke.error?.message);

  // 关键回归：把「上次刷新时间」改成一万小时前，再登录也不应该补币（已取消每日补足）
  {
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(DB_FILE);
    raw
      .prepare('UPDATE users SET coin_balance = 0, coin_refresh_at = ? WHERE username = ?')
      .run(Date.now() - 10000 * 3600 * 1000, `coin_${unique}`);
    raw.close();
  }
  const afterTimeTravel = await spender.call('/api/auth/me');
  check(
    '取消每日补足：隔了很久登录余额仍是 0',
    afterTimeTravel.data?.user?.coinBalance === 0,
    String(afterTimeTravel.data?.user?.coinBalance),
  );
  const stillBroke = await spender.call(`/api/posts/${targets[5].id}/coin`, { method: 'POST', body: { amount: 1 } });
  check('取消每日补足：仍然投不了币（400）', stillBroke.status === 400 && stillBroke.error?.code === 'insufficient_coins');
  const detailForBroke = await spender.call(`/api/posts/${targets[5].id}`);
  check(
    '详情里的投币提示也是「币不够」而不是「额度用完」',
    detailForBroke.data.post.coin.available === false &&
      detailForBroke.data.post.coin.reason === 'insufficient_coins' &&
      detailForBroke.data.post.coin.dailyAllowance === undefined,
    JSON.stringify(detailForBroke.data.post.coin),
  );

  console.log('\n▶ 收藏');
  const bookmark = await member.call(`/api/posts/${postId}/bookmark`, { method: 'POST' });
  check('收藏生效', bookmark.data.bookmarked === true && bookmark.data.bookmarkCount === 1, JSON.stringify(bookmark.data));
  const bookmarks = await member.call('/api/posts?bookmarked=1');
  check('收藏列表包含该帖', bookmarks.data.items.some((item) => item.id === postId));

  console.log('\n▶ 关注');
  const adminId = adminLogin.data.user.id;
  const follow1 = await member.call(`/api/users/${adminId}/follow`, { method: 'POST' });
  check('关注成功', follow1.data.following === true && follow1.data.followerCount >= 1, JSON.stringify(follow1.data));
  const following = await member.call('/api/me/following');
  check('我的关注列表包含该用户', following.data.items.some((item) => item.id === adminId));
  const adminPost = listed.data.items.find((item) => item.author.username === 'admin');
  const feed = await member.call('/api/posts?following=1&perPage=20');
  check(
    '关注流只包含关注的人的帖子',
    feed.data.items.length > 0 && feed.data.items.every((item) => item.author.id === adminId),
    JSON.stringify(feed.data.items.map((item) => item.author.username)),
  );
  const selfFollow = await member.call(`/api/users/${me.data.user.id}/follow`, { method: 'POST' });
  check('不能关注自己（400）', selfFollow.status === 400 && selfFollow.error?.code === 'self_follow', JSON.stringify(selfFollow.body));
  const profile = await anon.call(`/api/users/${encodeURIComponent(`smoke_${unique}`)}`);
  check(
    '个人主页返回统计信息',
    profile.status === 200 &&
      ['postCount', 'replyCount', 'followerCount', 'followingCount', 'likesReceived', 'coinsReceived'].every(
        (key) => key in profile.data.user,
      ),
    JSON.stringify(profile.data.user).slice(0, 200),
  );
  check('个人主页返回帖子列表', Array.isArray(profile.data.posts) && profile.data.posts.length >= 1);
  check('关注状态对浏览者可见', profile.data.user.isFollowing === false && profile.data.user.isMe === false);
  const unknownUser = await anon.call('/api/users/definitely_not_here');
  check('不存在的用户返回 404', unknownUser.status === 404);

  console.log('\n▶ 消息通知');
  // 通知应该发给内容作者 / 被关注者，而不是操作者
  const authorNotifs = await member.call('/api/notifications?perPage=50');
  check('投币通知发给帖子作者', Boolean(typeOf(authorNotifs.data.items, 'post_coin', (item) => item.post?.id === postId)));
  check('关注者自己不会收到自己的关注通知', !typeOf(authorNotifs.data.items, 'follow'));
  const adminNotifs = await admin.call('/api/notifications?perPage=50');
  check(
    '关注通知发给了被关注的人',
    Boolean(typeOf(adminNotifs.data.items, 'follow', (item) => item.actor?.username === `smoke_${unique}`)),
    JSON.stringify(adminNotifs.data.items.slice(0, 4).map((item) => `${item.type}:${item.actor?.username}`)),
  );
  check('操作者自己不会收到投币通知', !typeOf(adminNotifs.data.items, 'post_coin', (item) => item.post?.id === postId));
  const unreadBefore = adminNotifs.data.unreadCount;

  const memberLikeAdmin = await member.call(`/api/posts/${adminPost.id}/reaction`, { method: 'POST', body: { kind: 'like' } });
  check('（准备）给管理员的帖子点赞', memberLikeAdmin.data.liked === true, JSON.stringify(memberLikeAdmin.data));
  const memberReply = await member.call(`/api/posts/${adminPost.id}/replies`, {
    method: 'POST',
    body: { content: '感谢分享，@bob 你也来看看这个思路' },
  });
  check('发表回复成功', memberReply.status === 200 && memberReply.data.replyCount >= 1, JSON.stringify(memberReply.body));

  const afterActions = await admin.call('/api/notifications?perPage=50');
  check('回复产生通知', Boolean(typeOf(afterActions.data.items, 'post_reply', (item) => item.post?.id === adminPost.id)));
  check(
    '点赞产生通知',
    Boolean(typeOf(afterActions.data.items, 'post_like', (item) => item.post?.id === adminPost.id && item.actor?.username === `smoke_${unique}`)),
    JSON.stringify(afterActions.data.items.slice(0, 4).map((item) => item.type)),
  );
  check('未读数增加', afterActions.data.unreadCount > unreadBefore, `${unreadBefore} → ${afterActions.data.unreadCount}`);
  check('@提及不会发给没被提及的人', !typeOf(afterActions.data.items, 'mention'));

  const bobLogin = await bob.call('/api/auth/login', { method: 'POST', body: { username: 'bob', password: 'demo1234' } });
  check('Bob 可登录', bobLogin.status === 200);
  const bobNotifs = await bob.call('/api/notifications?perPage=50');
  check(
    '@提及通知发给了被提及的人',
    Boolean(typeOf(bobNotifs.data.items, 'mention', (item) => item.actor?.username === `smoke_${unique}`)),
    JSON.stringify(bobNotifs.data.items.slice(0, 3).map((item) => item.type)),
  );

  const unreadFilter = await admin.call('/api/notifications?filter=unread&perPage=50');
  check('只筛选未读时全部为未读', unreadFilter.data.items.every((item) => item.read === false));
  const summary = await admin.call('/api/notifications/summary');
  check('未读数摘要接口可用', summary.data.unread === afterActions.data.unreadCount, `${summary.data.unread}`);
  const firstUnread = unreadFilter.data.items[0];
  const markOne = await admin.call(`/api/notifications/${firstUnread.id}/read`, { method: 'POST' });
  check('单条已读生效', markOne.data.unread === summary.data.unread - 1, JSON.stringify(markOne.data));
  const markAll = await admin.call('/api/notifications/read-all', { method: 'POST' });
  check('全部已读后未读数归零', markAll.data.unread === 0);
  const anonNotifs = await anon.call('/api/notifications');
  check('未登录访问通知被拒绝（401）', anonNotifs.status === 401);

  // 关注的人发新帖 → 关注者收到通知
  const adminPost2 = await admin.call('/api/posts', {
    method: 'POST',
    body: { boardId: site.data.boards[0].id, title: `关注流测试 ${unique}`, content: '关注我的人应该收到通知' },
  });
  const followerNotifs = await member.call('/api/notifications?perPage=50');
  check(
    '关注的人发新帖会通知我',
    Boolean(typeOf(followerNotifs.data.items, 'following_post', (item) => item.post?.id === adminPost2.data.id)),
    JSON.stringify(followerNotifs.data.items.slice(0, 3).map((item) => item.type)),
  );

  // 管理员删掉别人的帖子 → 作者收到管理通知
  const victimPost = await member.call('/api/posts', {
    method: 'POST',
    body: { boardId: site.data.boards[0].id, title: `待删除的帖子 ${unique}`, content: '这篇会被管理员删掉' },
  });
  await admin.call(`/api/posts/${victimPost.data.id}`, { method: 'DELETE' });
  const moderationNotifs = await member.call('/api/notifications?perPage=50');
  check(
    '帖子被管理员删除时作者收到通知',
    Boolean(typeOf(moderationNotifs.data.items, 'moderation', (item) => item.post?.id === victimPost.data.id)),
    JSON.stringify(moderationNotifs.data.items.slice(0, 3).map((item) => item.type)),
  );
  const selfDeleteNoNotif = await admin.call('/api/notifications?perPage=50');
  check('管理员删自己的帖子不会通知自己', !typeOf(selfDeleteNoNotif.data.items, 'moderation'));

  console.log('\n▶ 每日签到');
  const alice = createClient();
  await alice.call('/api/auth/login', { method: 'POST', body: { username: 'alice', password: 'demo1234' } });
  const beforeCheckin = await alice.call('/api/auth/me');
  const checkinStatus = await alice.call('/api/checkin');
  check(
    '签到状态接口可用',
    checkinStatus.status === 200 && typeof checkinStatus.data.checkedInToday === 'boolean' && Array.isArray(checkinStatus.data.week),
    JSON.stringify(checkinStatus.data).slice(0, 140),
  );
  check(
    '下发签到规则（每天 1 币、满 7 天 +3 币）',
    checkinStatus.data.dailyReward === 1 && checkinStatus.data.weeklyBonus === 3 && checkinStatus.data.fullWeekDays === 7,
  );
  check(
    '示例数据自带历史签到（上周全勤）',
    checkinStatus.data.checkedInToday === false && checkinStatus.data.total >= 7 && checkinStatus.data.pendingBonus === 3,
    JSON.stringify({ total: checkinStatus.data.total, pending: checkinStatus.data.pendingBonus }),
  );

  const firstCheckin = await alice.call('/api/checkin', { method: 'POST' });
  check('签到成功 +1 币', firstCheckin.status === 200 && firstCheckin.data.reward === 1, JSON.stringify(firstCheckin.data).slice(0, 160));
  check(
    '上周全勤补发 +3 币',
    firstCheckin.data.bonus === 3 && firstCheckin.data.bonusWeeks.length === 1,
    JSON.stringify({ bonus: firstCheckin.data.bonus, weeks: firstCheckin.data.bonusWeeks }),
  );
  check(
    '签到后余额增加 4 币',
    firstCheckin.data.coinBalance === beforeCheckin.data.user.coinBalance + 4,
    `${beforeCheckin.data.user.coinBalance} → ${firstCheckin.data.coinBalance}`,
  );
  check('签到后状态为已签到且连续天数 ≥ 1', firstCheckin.data.checkedInToday === true && firstCheckin.data.streak >= 1);

  const repeatCheckin = await alice.call('/api/checkin', { method: 'POST' });
  check('同一天重复签到被拒绝（409）', repeatCheckin.status === 409 && repeatCheckin.error?.code === 'already_checked_in');
  const afterRepeat = await alice.call('/api/checkin');
  check('重复签到不会重复加币', afterRepeat.data.coinBalance === firstCheckin.data.coinBalance);
  check('签到日历返回 35 天', Array.isArray(afterRepeat.data.calendar) && afterRepeat.data.calendar.length === 35);
  check('未登录不能签到（401）', (await anon.call('/api/checkin')).status === 401);
  check('未登录不能查看签到状态（401）', (await anon.call('/api/checkin')).status === 401);

  console.log('\n▶ 个人主页分类与置顶');
  const memberName = `smoke_${unique}`;
  const categoryList = await member.call('/api/me/categories');
  check(
    '分类列表接口可用（新用户从零开始）',
    categoryList.status === 200 && Array.isArray(categoryList.data.items) && categoryList.data.items.length === 0 && categoryList.data.limit >= 3,
    JSON.stringify(categoryList.data).slice(0, 140),
  );

  const newCategory = await member.call('/api/me/categories', { method: 'POST', body: { name: '前端笔记' } });
  check(
    '创建分类成功',
    newCategory.status === 200 && newCategory.data.category.name === '前端笔记' && newCategory.data.category.postCount === 0,
    JSON.stringify(newCategory.data),
  );
  const categoryId = newCategory.data.category.id;
  check('同名分类被拒绝（409）', (await member.call('/api/me/categories', { method: 'POST', body: { name: '前端笔记' } })).status === 409);
  const renamedCategory = await member.call(`/api/me/categories/${categoryId}`, { method: 'PUT', body: { name: '前端手记' } });
  check('重命名分类成功', renamedCategory.status === 200 && renamedCategory.data.category.name === '前端手记');

  let categoryLimitHit = false;
  for (let index = 0; index < 12; index += 1) {
    const result = await member.call('/api/me/categories', { method: 'POST', body: { name: `分类${index}` } });
    if (result.status === 400 && result.error?.code === 'category_limit') {
      categoryLimitHit = true;
      break;
    }
  }
  check('分类数量达到上限后拒绝创建', categoryLimitHit);

  const adminCategory = await admin.call('/api/me/categories', { method: 'POST', body: { name: '站长专栏' } });
  check('（准备）管理员也有自己的分类', adminCategory.status === 200);

  const boardId = site.data.boards[0].id;
  const categorized = await member.call('/api/posts', {
    method: 'POST',
    body: { boardId, title: `分类测试帖 ${unique}`, content: '把这篇文章放进我的分类', categoryId, profilePinned: true },
  });
  check('发帖时可同时选分类并置顶', categorized.status === 200, JSON.stringify(categorized.body));
  const categorizedId = categorized.data.id;

  const categorizedDetail = await member.call(`/api/posts/${categorizedId}`);
  check(
    '帖子详情带分类与置顶标记',
    categorizedDetail.data.post.category?.id === categoryId &&
      categorizedDetail.data.post.category.name === '前端手记' &&
      categorizedDetail.data.post.profilePinned === true,
    JSON.stringify(categorizedDetail.data.post.category),
  );

  const stealCategory = await member.call(`/api/posts/${categorizedId}/category`, {
    method: 'POST',
    body: { categoryId: adminCategory.data.category.id },
  });
  check('不能把文章放进别人的分类（400）', stealCategory.status === 400 && stealCategory.error?.code === 'bad_category');

  const clearCategory = await member.call(`/api/posts/${categorizedId}/category`, { method: 'POST', body: { categoryId: null } });
  check(
    '可以取消分类（文章回到未分类）',
    clearCategory.status === 200 && clearCategory.data.category === null && clearCategory.data.uncategorizedCount >= 1,
    JSON.stringify(clearCategory.data),
  );
  const restoreCategory = await member.call(`/api/posts/${categorizedId}/category`, { method: 'POST', body: { categoryId } });
  check('可以重新设置分类', restoreCategory.status === 200 && restoreCategory.data.category.id === categoryId);

  const profileView = await anon.call(`/api/users/${encodeURIComponent(memberName)}`);
  check(
    '个人主页返回分类、置顶计数与上限',
    Array.isArray(profileView.data.categories) &&
      profileView.data.categories.some((item) => item.id === categoryId && item.postCount >= 1) &&
      profileView.data.pinnedCount >= 1 &&
      profileView.data.pinLimit === 3,
    JSON.stringify({ categories: profileView.data.categories, pinned: profileView.data.pinnedCount }),
  );
  check(
    '置顶文章排在个人主页第一位',
    profileView.data.posts[0].id === categorizedId && profileView.data.posts[0].profilePinned === true,
    JSON.stringify(profileView.data.posts.slice(0, 3).map((item) => ({ id: item.id, pinned: item.profilePinned }))),
  );
  check(
    '可按分类筛选个人主页文章',
    (await anon.call(`/api/users/${encodeURIComponent(memberName)}?category=${categoryId}`)).data.posts.every(
      (item) => item.category?.id === categoryId,
    ),
  );
  check(
    '可筛选「未分类」文章',
    (await anon.call(`/api/users/${encodeURIComponent(memberName)}?category=none`)).data.posts.every((item) => item.category === null),
  );

  // 置顶上限：再补两篇置顶后，第四篇应当被拒绝
  const extraPosts = [];
  for (let index = 0; index < 3; index += 1) {
    const created = await member.call('/api/posts', {
      method: 'POST',
      body: { boardId, title: `置顶测试 ${index} ${unique}`, content: '用于测试置顶上限' },
    });
    extraPosts.push(created.data.id);
  }
  await member.call(`/api/posts/${extraPosts[0]}/profile-pin`, { method: 'POST', body: { pinned: true } });
  await member.call(`/api/posts/${extraPosts[1]}/profile-pin`, { method: 'POST', body: { pinned: true } });
  const overflowPin = await member.call(`/api/posts/${extraPosts[2]}/profile-pin`, { method: 'POST', body: { pinned: true } });
  check('超过置顶上限被拒绝（400）', overflowPin.status === 400 && overflowPin.error?.code === 'pin_limit', JSON.stringify(overflowPin.body));

  const unpin = await member.call(`/api/posts/${extraPosts[0]}/profile-pin`, { method: 'POST', body: { pinned: false } });
  check('可以取消置顶', unpin.status === 200 && unpin.data.profilePinned === false && unpin.data.pinnedCount === 2);
  check(
    '不能置顶别人的文章（403）',
    (await member.call(`/api/posts/${adminPost.id}/profile-pin`, { method: 'POST', body: { pinned: true } })).status === 403,
  );

  const deletedCategory = await member.call(`/api/me/categories/${categoryId}`, { method: 'DELETE' });
  check(
    '删除分类后文章回到未分类',
    deletedCategory.status === 200 && deletedCategory.data.uncategorizedCount >= 1,
    JSON.stringify(deletedCategory.data),
  );
  check(
    '删除后分类不再出现在主页',
    !(await anon.call(`/api/users/${encodeURIComponent(memberName)}`)).data.categories.some((item) => item.id === categoryId),
  );

  console.log('\n▶ 账号设置');
  const updatedProfile = await member.call('/api/me/profile', {
    method: 'POST',
    body: { displayName: '冒烟测试员2', bio: '这是一句个性签名' },
  });
  check(
    '修改昵称与个性签名成功',
    updatedProfile.status === 200 &&
      updatedProfile.data.user.displayName === '冒烟测试员2' &&
      updatedProfile.data.user.bio === '这是一句个性签名',
    JSON.stringify(updatedProfile.data).slice(0, 160),
  );
  check('超长个性签名被拒绝（400）', (await member.call('/api/me/profile', { method: 'POST', body: { bio: 'x'.repeat(101) } })).status === 400);
  check('空昵称被拒绝（400）', (await member.call('/api/me/profile', { method: 'POST', body: { displayName: '' } })).status === 400);
  const profileAfterEdit = await anon.call(`/api/users/${encodeURIComponent(memberName)}`);
  check(
    '主页展示新的昵称与签名',
    profileAfterEdit.data.user.displayName === '冒烟测试员2' && profileAfterEdit.data.user.bio === '这是一句个性签名',
  );

  const secondSession = createClient();
  await secondSession.call('/api/auth/login', { method: 'POST', body: { username: memberName, password: 'secret123' } });
  check('（准备）第二个会话可访问', (await secondSession.call('/api/auth/me')).data.user !== null);
  const wrongCurrent = await member.call('/api/auth/password', {
    method: 'POST',
    body: { currentPassword: 'wrong-password', newPassword: 'newsecret123' },
  });
  check('当前密码错误被拒绝（400）', wrongCurrent.status === 400 && wrongCurrent.error?.code === 'bad_password');
  const samePassword = await member.call('/api/auth/password', {
    method: 'POST',
    body: { currentPassword: 'secret123', newPassword: 'secret123' },
  });
  check('新旧密码相同被拒绝（400）', samePassword.status === 400 && samePassword.error?.code === 'same_password');
  const changedPassword = await member.call('/api/auth/password', {
    method: 'POST',
    body: { currentPassword: 'secret123', newPassword: 'newsecret123' },
  });
  check(
    '修改密码成功并踢掉其它会话',
    changedPassword.status === 200 && changedPassword.data.changed === true && changedPassword.data.revokedSessions >= 1,
    JSON.stringify(changedPassword.data),
  );
  check('改密后当前会话仍然有效', (await member.call('/api/auth/me')).data.user !== null);
  check('改密后其它会话已失效', (await secondSession.call('/api/auth/me')).data.user === null);
  const oldPasswordProbe = createClient();
  check(
    '旧密码无法再登录（401）',
    (await oldPasswordProbe.call('/api/auth/login', { method: 'POST', body: { username: memberName, password: 'secret123' } }))
      .status === 401,
  );
  const newPasswordProbe = createClient();
  check(
    '新密码可以登录',
    (await newPasswordProbe.call('/api/auth/login', { method: 'POST', body: { username: memberName, password: 'newsecret123' } }))
      .status === 200,
  );

  console.log('\n▶ 转发');
  const beforeRepostCount = (await anon.call(`/api/posts/${adminPost.id}`)).data.post.repostCount;
  const repost = await member.call(`/api/posts/${adminPost.id}/repost`, {
    method: 'POST',
    body: { comment: '这篇值得收藏，转一下' },
  });
  check(
    '转发成功并返回计数',
    repost.status === 200 && repost.data.reposted === true && repost.data.repostCount === beforeRepostCount + 1,
    JSON.stringify(repost.data),
  );
  check('未登录不能转发（401）', (await anon.call(`/api/posts/${adminPost.id}/repost`, { method: 'POST', body: {} })).status === 401);
  check(
    '不能转发自己的文章（400）',
    (await admin.call(`/api/posts/${adminPost.id}/repost`, { method: 'POST', body: {} })).status === 400,
  );

  const detailAfterRepost = (await anon.call(`/api/posts/${adminPost.id}`)).data;
  check(
    '详情带转发计数与转发者列表',
    detailAfterRepost.post.repostCount === beforeRepostCount + 1 && detailAfterRepost.reposters.length >= 1,
  );
  check(
    '转发者列表包含转发语',
    detailAfterRepost.reposters.some((item) => item.user.username === `smoke_${unique}` && item.comment.includes('值得收藏')),
    JSON.stringify(detailAfterRepost.reposters.slice(0, 2)),
  );

  const repostAgain = await member.call(`/api/posts/${adminPost.id}/repost`, { method: 'POST', body: { comment: '改一版转发语' } });
  check(
    '重复转发只更新转发语、不增加计数',
    repostAgain.data.updated === true && repostAgain.data.repostCount === beforeRepostCount + 1,
    JSON.stringify(repostAgain.data),
  );

  const profileReposts = (await anon.call(`/api/users/${encodeURIComponent(`smoke_${unique}`)}?category=reposts`)).data;
  check(
    '个人主页「转发」分类可见',
    profileReposts.filter === 'reposts' &&
      profileReposts.posts.some((item) => item.id === adminPost.id && item.repost?.comment === '改一版转发语'),
    JSON.stringify(profileReposts.posts.map((item) => item.id)),
  );
  check('个人主页返回转发数', profileReposts.repostCount >= 1);

  const repostNotifications = await admin.call('/api/notifications?perPage=50');
  check(
    '转发会通知原作者',
    Boolean(typeOf(repostNotifications.data.items, 'post_repost', (item) => item.actor?.username === `smoke_${unique}`)),
    JSON.stringify(repostNotifications.data.items.slice(0, 4).map((item) => item.type)),
  );

  const cancelRepost = await member.call(`/api/posts/${adminPost.id}/repost`, { method: 'DELETE' });
  check(
    '撤销转发成功',
    cancelRepost.status === 200 && cancelRepost.data.reposted === false && cancelRepost.data.repostCount === beforeRepostCount,
  );
  check('重复撤销返回 400', (await member.call(`/api/posts/${adminPost.id}/repost`, { method: 'DELETE' })).status === 400);

  console.log('\n▶ 价值排行榜');
  const ranking = await anon.call('/api/ranking?limit=20');
  check('排行榜接口可用', ranking.status === 200 && Array.isArray(ranking.data.posts) && Array.isArray(ranking.data.authors));
  check(
    '排行榜下发权重常量',
    ranking.data.weights.like === 1 &&
      ranking.data.weights.coin === 5 &&
      ranking.data.weights.bookmark === 3 &&
      ranking.data.weights.halfSaturation === 50,
    JSON.stringify(ranking.data.weights),
  );

  // 构造一篇帖子逐项验证公式：3 赞 + 1 币 + 1 收藏 + 1 踩
  const formulaPost = await admin.call('/api/posts', {
    method: 'POST',
    body: { boardId, title: `价值公式验证 ${unique}`, content: '用于验证权重公式' },
  });
  const formulaId = formulaPost.data.id;
  check('（准备）新帖初始价值为 0', (await anon.call(`/api/posts/${formulaId}`)).data.post.valueScore === 0);

  await admin.call(`/api/posts/${formulaId}/reaction`, { method: 'POST', body: { kind: 'like' } });
  await bob.call(`/api/posts/${formulaId}/reaction`, { method: 'POST', body: { kind: 'like' } });
  await member.call(`/api/posts/${formulaId}/reaction`, { method: 'POST', body: { kind: 'like' } });
  await admin.call(`/api/posts/${formulaId}/bookmark`, { method: 'POST' });
  await bob.call(`/api/posts/${formulaId}/coin`, { method: 'POST', body: { amount: 1 } });
  const carolClient = createClient();
  await carolClient.call('/api/auth/login', { method: 'POST', body: { username: 'carol', password: 'demo1234' } });
  await carolClient.call(`/api/posts/${formulaId}/reaction`, { method: 'POST', body: { kind: 'dislike' } });

  const scored = (await anon.call(`/api/posts/${formulaId}`)).data.post;
  // D' = 3/(1+3) = 0.75 → S = 3 + 5 + 3 − 2.25 = 8.75 → V = 100·8.75/(8.75+50) ≈ 14.89
  const expectedBase = 3 * 1 + 1 * 5 + 1 * 3 - 3 * (3 / 4);
  const expectedValue = (100 * expectedBase) / (Math.abs(expectedBase) + 50);
  check(
    '公式计算与接口一致（3赞 + 1币 + 1藏 + 1踩）',
    Math.abs(scored.baseScore - expectedBase) < 0.01 && Math.abs(scored.valueScore - expectedValue) < 0.01,
    `base=${scored.baseScore}(期望 ${expectedBase}) value=${scored.valueScore}(期望 ${expectedValue.toFixed(2)})`,
  );

  const rankedPost = (await anon.call('/api/ranking?limit=50')).data.posts.find((item) => item.id === formulaId);
  check('该帖进入文章价值榜且分数一致', Boolean(rankedPost) && Math.abs(rankedPost.valueScore - scored.valueScore) < 0.01);

  const authorRow = (await anon.call('/api/ranking?limit=50')).data.authors.find((item) => item.user.username === 'admin');
  const adminProfile = (await anon.call('/api/users/admin')).data;
  const expectedTotal = adminProfile.posts.reduce((sum, item) => sum + item.valueScore, 0);
  check(
    '作者权重 = 其所有未删除文章价值之和',
    Boolean(authorRow) && Math.abs(authorRow.totalValue - expectedTotal) < 0.05,
    `W=${authorRow?.totalValue} 期望≈${expectedTotal.toFixed(2)}`,
  );
  check('个人主页返回个人权重与榜单排名', adminProfile.value.totalValue === authorRow.totalValue && adminProfile.value.rank >= 1);
  check(
    '榜单按价值降序',
    (await anon.call('/api/ranking?limit=50')).data.posts.every(
      (item, index, list) => index === 0 || list[index - 1].valueScore >= item.valueScore,
    ),
  );
  const windowed = await anon.call('/api/ranking?window=7&limit=50');
  check(
    '时间窗筛选生效（近 7 天不含 9 天前的版规帖）',
    windowed.data.window === '7' && windowed.data.posts.every((item) => item.id !== 1),
    JSON.stringify(windowed.data.posts.map((item) => item.id)),
  );
  check('未知时间窗回退为全部', (await anon.call('/api/ranking?window=999')).data.window === 'all');

  console.log('\n▶ 头像');
  const memberName2 = `smoke_${unique}`;
  const onePixelPng =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  const emojiAvatar = await member.call('/api/me/avatar', { method: 'POST', body: { type: 'emoji', emoji: '🦊', hue: 24 } });
  check(
    '设置预设 emoji 头像成功',
    emojiAvatar.status === 200 && emojiAvatar.data.user.avatar === 'emoji:🦊:24',
    JSON.stringify(emojiAvatar.data).slice(0, 140),
  );
  check('会话接口返回新头像', (await member.call('/api/auth/me')).data.user.avatar === 'emoji:🦊:24');
  const postWithAvatar = await anon.call(`/api/posts/${categorizedId}`);
  check(
    '帖子作者信息带头像（别人也看得到）',
    postWithAvatar.data.post.author.avatar === 'emoji:🦊:24',
    JSON.stringify(postWithAvatar.data.post.author),
  );
  const replyWithAvatar = (await anon.call(`/api/posts/${adminPost.id}`)).data.replies.find(
    (item) => item.author.username === memberName2,
  );
  check('回复作者信息也带头像', replyWithAvatar?.author?.avatar === 'emoji:🦊:24', JSON.stringify(replyWithAvatar?.author));

  const uploaded = await member.call('/api/me/avatar', { method: 'POST', body: { type: 'upload', dataUrl: onePixelPng } });
  check(
    '上传 PNG 头像成功',
    uploaded.status === 200 &&
      uploaded.data.user.avatar.startsWith('file:/avatars/') &&
      uploaded.data.user.avatar.endsWith('.png'),
    JSON.stringify(uploaded.data).slice(0, 140),
  );
  const avatarUrl = uploaded.data.avatarUrl;
  const avatarFile = await anon.call(avatarUrl, { raw: true });
  check(
    '头像文件可访问且 Content-Type 正确',
    avatarFile.status === 200 && avatarFile.headers.get('content-type') === 'image/png',
  );
  check('头像文件带长缓存头', (avatarFile.headers.get('cache-control') ?? '').includes('immutable'));
  check('头像目录不可被路径穿越', (await anon.call('/avatars/..%2Fforum.db', { raw: true })).status === 400);

  const fakePng = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>').toString('base64');
  const svgAsPng = await member.call('/api/me/avatar', {
    method: 'POST',
    body: { type: 'upload', dataUrl: `data:image/png;base64,${fakePng}` },
  });
  check('伪装成 PNG 的 SVG 被拒绝（400）', svgAsPng.status === 400, JSON.stringify(svgAsPng.body));
  const gifUpload = await member.call('/api/me/avatar', {
    method: 'POST',
    body: { type: 'upload', dataUrl: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' },
  });
  check('不支持的格式被拒绝（400）', gifUpload.status === 400);
  const badType = await member.call('/api/me/avatar', { method: 'POST', body: { type: 'nope' } });
  check('非法头像类型被拒绝（400）', badType.status === 400);
  const hugePng = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(300 * 1024),
  ]).toString('base64');
  const tooLarge = await member.call('/api/me/avatar', {
    method: 'POST',
    body: { type: 'upload', dataUrl: `data:image/png;base64,${hugePng}` },
  });
  check(
    '超过 256 KB 的图片被拒绝（400）',
    tooLarge.status === 400 && tooLarge.error?.code === 'image_too_large',
    JSON.stringify(tooLarge.body),
  );

  const oldFileName = avatarUrl.split('/').pop();
  await member.call('/api/me/avatar', { method: 'POST', body: { type: 'emoji', emoji: '🐳', hue: 198 } });
  check('换头像后旧文件已删除', (await anon.call(`/avatars/${oldFileName}`, { raw: true })).status === 404);

  const resetAvatar = await member.call('/api/me/avatar', { method: 'POST', body: { type: 'reset' } });
  check('恢复默认头像（空字符串）', resetAvatar.status === 200 && resetAvatar.data.user.avatar === '');
  check('未登录不能设置头像（401）', (await anon.call('/api/me/avatar', { method: 'POST', body: { type: 'reset' } })).status === 401);

  console.log('\n▶ 角色与管理员分配');
  const ownerId = adminLogin.data.user.id;
  const memberId = me.data.user.id;

  check('示例站长角色为 owner', adminLogin.data.user.role === 'owner');
  check('普通成员角色为 member', me.data.user.role === 'member');

  const grantByMember = await member.call(`/api/admin/users/${memberId}/role`, { method: 'POST', body: { role: 'admin' } });
  check('普通成员不能分配管理员（403）', grantByMember.status === 403, JSON.stringify(grantByMember.body));
  check(
    '管理员也不能分配管理员（403，只有站长可以）',
    (await bob.call(`/api/admin/users/${memberId}/role`, { method: 'POST', body: { role: 'admin' } })).status ===
      403,
  );

  const grant = await admin.call(`/api/admin/users/${memberId}/role`, { method: 'POST', body: { role: 'admin' } });
  check(
    '站长可以把成员设为管理员',
    grant.status === 200 && grant.data.user.role === 'admin' && grant.data.changed === true,
    JSON.stringify(grant.data).slice(0, 140),
  );
  check('提升后出现管理团队列表', grant.data.staff.length >= 2 && grant.data.staff.some((row) => row.id === ownerId));
  const grantNotification = await member.call('/api/notifications?perPage=5');
  check(
    '被提升者会收到通知',
    Boolean(typeOf(grantNotification.data.items, 'moderation', (item) => item.actor?.username === 'admin')),
    JSON.stringify(grantNotification.data.items.slice(0, 3).map((item) => item.excerpt)),
  );
  check(
    '新管理员可以访问后台',
    (await member.call('/api/admin/overview')).status === 200,
  );

  const selfRole = await admin.call(`/api/admin/users/${ownerId}/role`, { method: 'POST', body: { role: 'member' } });
  check('站长不能修改自己的角色（400）', selfRole.status === 400 && selfRole.error?.code === 'self_role');
  const badRole = await admin.call(`/api/admin/users/${memberId}/role`, { method: 'POST', body: { role: 'owner' } });
  check('不能把别人设成站长（400）', badRole.status === 400);
  const ownerDemote = await member.call(`/api/admin/users/${ownerId}/role`, { method: 'POST', body: { role: 'member' } });
  check('管理员不能动站长的角色（403）', ownerDemote.status === 403, JSON.stringify(ownerDemote.body));

  console.log('\n▶ 隐藏 / 恢复文章');
  const hideTarget = (await anon.call('/api/posts?perPage=20')).data.items.find(
    (row) => row.author.username === 'bob',
  );
  const hideAsMember = await bob.call(`/api/admin/posts/${hideTarget.id}/hide`, {
    method: 'POST',
    body: { hidden: true, reason: '测试' },
  });
  check('普通成员不能隐藏文章（403）', hideAsMember.status === 403);

  const hide = await member.call(`/api/admin/posts/${hideTarget.id}/hide`, {
    method: 'POST',
    body: { hidden: true, reason: '内容重复，先隐藏' },
  });
  check(
    '管理员可以隐藏文章',
    hide.status === 200 && hide.data.hidden === true && hide.data.post.hidden === true,
    JSON.stringify(hide.data).slice(0, 160),
  );
  check('隐藏原因被保存', hide.data.hiddenReason === '内容重复，先隐藏' && hide.data.post.hiddenReason.includes('内容重复'));

  check('隐藏后访客看到 404', (await anon.call(`/api/posts/${hideTarget.id}`)).status === 404);
  check(
    '隐藏后不出现在公开列表里',
    !(await anon.call('/api/posts?perPage=30')).data.items.some((row) => row.id === hideTarget.id),
  );
  check(
    '隐藏后不出现在搜索结果里',
    !(await anon.call(`/api/posts?q=${encodeURIComponent(hideTarget.title.slice(0, 8))}`)).data.items.some(
      (row) => row.id === hideTarget.id,
    ),
  );
  check(
    '作者本人仍能看到（带 hidden 标记）',
    (await bob.call(`/api/posts/${hideTarget.id}`)).data.post.hidden === true,
  );
  check(
    '作者主页上也标记为已隐藏',
    (await bob.call('/api/users/bob')).data.posts.some((row) => row.id === hideTarget.id && row.hidden),
  );
  check(
    '别人看不到作者页面上的隐藏文章',
    !(await anon.call('/api/users/bob')).data.posts.some((row) => row.id === hideTarget.id),
  );
  check('管理团队仍能打开隐藏文章', (await admin.call(`/api/posts/${hideTarget.id}`)).status === 200);
  check(
    '管理团队列表里能看到并标记',
    (await admin.call('/api/posts?perPage=30')).data.items.some((row) => row.id === hideTarget.id && row.hidden),
  );

  /* 回归：/api/site 是匿名接口，它的首页侧栏热门列表曾漏掉 hidden 过滤（store.hotPosts）。
     直接拿「当前热门第一名」来验，避免造一篇挤不进前 5 名的帖子导致断言空转。 */
  const hotBeforeHide = (await anon.call('/api/site')).data.hotPosts;
  check('匿名首页侧栏热门列表非空', hotBeforeHide.length > 0);
  /* 挑一篇「不是上面那个 hideTarget」的热门：hideTarget 在这段开头就被隐藏了，
     拿它来验的话，最后那次「恢复显示」会把它一起放出来，后面几条断言全乱。 */
  const topHot = hotBeforeHide.find((row) => row.id !== hideTarget.id);
  if (topHot) {
    const hideTop = await admin.call(`/api/admin/posts/${topHot.id}/hide`, {
      method: 'POST',
      body: { hidden: true, reason: '回归测试' },
    });
    check('把热门第一名隐藏成功', hideTop.status === 200 && hideTop.data.hidden === true);
    check(
      '被隐藏的文章不再出现在匿名热门列表里',
      !(await anon.call('/api/site')).data.hotPosts.some((row) => row.id === topHot.id),
    );
    check(
      '被隐藏的热门文章对访客返回 404',
      (await anon.call(`/api/posts/${topHot.id}`)).status === 404,
    );
    const unhideTop = await admin.call(`/api/admin/posts/${topHot.id}/hide`, {
      method: 'POST',
      body: { hidden: false, reason: '回归测试结束' },
    });
    check('恢复显示成功', unhideTop.status === 200 && unhideTop.data.hidden === false);
  }
  check(
    '访客不能对隐藏文章点赞（404）',
    (await carolClient.call(`/api/posts/${hideTarget.id}/reaction`, { method: 'POST', body: { kind: 'like' } }))
      .status === 404,
  );
  check(
    '访客不能回复隐藏文章（404）',
    (await carolClient.call(`/api/posts/${hideTarget.id}/replies`, { method: 'POST', body: { content: '还能回吗' } }))
      .status === 404,
  );
  const hideNotification = await bob.call('/api/notifications?perPage=5');
  check(
    '作者会收到隐藏通知（含原因）',
    Boolean(typeOf(hideNotification.data.items, 'moderation', (item) => (item.excerpt ?? '').includes('隐藏'))),
    JSON.stringify(hideNotification.data.items.slice(0, 3).map((item) => item.excerpt)),
  );

  const unhide = await member.call(`/api/admin/posts/${hideTarget.id}/hide`, { method: 'POST', body: { hidden: false } });
  check(
    '可以恢复显示',
    unhide.status === 200 && unhide.data.hidden === false && unhide.data.post.hidden === false,
  );
  check('恢复后访客又能打开了', (await anon.call(`/api/posts/${hideTarget.id}`)).status === 200);
  const publicTotal = (await anon.call('/api/posts?perPage=5')).data.total;
  const staffTotal = (await admin.call('/api/posts?perPage=5')).data.total;
  check('公开统计不会多算隐藏文章', staffTotal >= publicTotal, `staff=${staffTotal} public=${publicTotal}`);

  const adminOverviewForRoles = await admin.call('/api/admin/overview');
  check(
    '后台返回 viewer 角色（前端据此显示站长专属按钮）',
    adminOverviewForRoles.data.viewer.role === 'owner' && adminOverviewForRoles.data.viewer.isOwner === true,
    JSON.stringify(adminOverviewForRoles.data.viewer),
  );
  check(
    '后台返回隐藏文章列表与审计日志',
    Array.isArray(adminOverviewForRoles.data.hiddenPosts) &&
      Array.isArray(adminOverviewForRoles.data.moderationLogs) &&
      adminOverviewForRoles.data.moderationLogs.length >= 3,
    JSON.stringify(adminOverviewForRoles.data.moderationLogs.slice(0, 4).map((item) => item.action)),
  );
  check(
    '审计日志记录了隐藏与角色变更',
    adminOverviewForRoles.data.moderationLogs.some((item) => item.action === 'hide_post') &&
      adminOverviewForRoles.data.moderationLogs.some((item) => item.action === 'unhide_post') &&
      adminOverviewForRoles.data.moderationLogs.some((item) => item.action === 'grant_admin'),
  );
  check(
    '管理员不能封禁站长（400/403）',
    [400, 403].includes(
      (await member.call(`/api/admin/users/${ownerId}/ban`, { method: 'POST', body: { banned: true } })).status,
    ),
  );
  check(
    '管理员不能封禁其它管理员（403）',
    (await member.call(`/api/admin/users/${ownerId}/ban`, { method: 'POST', body: { banned: true } })).status === 400 ||
      (await member.call(`/api/admin/users/${ownerId}/ban`, { method: 'POST', body: { banned: true } })).status === 403,
  );

  const revoke = await admin.call(`/api/admin/users/${memberId}/role`, { method: 'POST', body: { role: 'member' } });
  check('站长可以收回管理员权限', revoke.status === 200 && revoke.data.user.role === 'member' && revoke.data.changed === true);
  check('收回后不能再进后台', (await member.call('/api/admin/overview')).status === 403);
  check(
    '收回后不能再隐藏文章（403）',
    (await member.call(`/api/admin/posts/${hideTarget.id}/hide`, { method: 'POST', body: { hidden: true } })).status === 403,
  );

  console.log('\n▶ 权限');
  const deleteOwn = await member.call(`/api/posts/${postId}`, { method: 'DELETE' });
  check('作者可删除自己的帖子', deleteOwn.status === 200);
  const gone = await anon.call(`/api/posts/${postId}`);
  check('删除后详情返回 404', gone.status === 404, `status=${gone.status}`);

  const seedPost = (await anon.call('/api/posts?perPage=1')).data.items[0];
  const anonDelete = await anon.call(`/api/posts/${seedPost.id}`, { method: 'DELETE' });
  check('未登录删除被拒绝（401）', anonDelete.status === 401, `status=${anonDelete.status}`);
  const forbidden = await member.call(`/api/admin/overview`);
  check('普通用户访问后台被拒绝（403）', forbidden.status === 403, `status=${forbidden.status}`);

  console.log('\n▶ 管理后台');
  const overview = await admin.call('/api/admin/overview');
  check('后台统计可用', overview.status === 200 && overview.data.stats.users >= 4);
  check(
    '后台统计包含互动数据',
    ['reactions', 'coins', 'follows', 'bookmarks'].every((key) => key in overview.data.stats),
    JSON.stringify(overview.data.stats),
  );
  check('后台返回用户列表（含粉丝数与余额）', Array.isArray(overview.data.users) && 'followerCount' in overview.data.users[0] && 'coinBalance' in overview.data.users[0]);

  const freshUser = `ban_${unique}`;
  const victim = createClient();
  await victim.call('/api/auth/register', { method: 'POST', body: { username: freshUser, password: 'secret123' } });
  const victimId = (await admin.call('/api/admin/overview')).data.users.find((user) => user.username === freshUser).id;
  const ban = await admin.call(`/api/admin/users/${victimId}/ban`, { method: 'POST', body: { banned: true } });
  check('封禁接口返回已封禁状态', ban.data.user.banned === true);
  const victimMe = await victim.call('/api/auth/me');
  check('被封禁用户会话立即失效', victimMe.data?.user === null, JSON.stringify(victimMe.data));
  const victimLogin = await victim.call('/api/auth/login', { method: 'POST', body: { username: freshUser, password: 'secret123' } });
  check('被封禁用户无法再登录（403）', victimLogin.status === 403, `status=${victimLogin.status}`);
  const selfBan = await admin.call(`/api/admin/users/${adminLogin.data.user.id}/ban`, { method: 'POST', body: { banned: true } });
  check('管理员不能封禁自己（400）', selfBan.status === 400, `status=${selfBan.status}`);
  const unban = await admin.call(`/api/admin/users/${victimId}/ban`, { method: 'POST', body: { banned: false } });
  check('可以解封用户', unban.data.user.banned === false);

  console.log('\n▶ 私信');
  // 用两个一次性账号做私信实验，避免影响前面用例里的关注关系
  const dmAlice = createClient();
  const dmBob = createClient();
  const dmAliceName = `dma_${unique}`;
  const dmBobName = `dmb_${unique}`;
  const dmAliceReg = await dmAlice.call('/api/auth/register', {
    method: 'POST',
    body: { username: dmAliceName, password: 'secret123' },
  });
  const dmBobReg = await dmBob.call('/api/auth/register', {
    method: 'POST',
    body: { username: dmBobName, password: 'secret123' },
  });
  const dmAliceId = dmAliceReg.data.user.id;
  const dmBobId = dmBobReg.data.user.id;

  // 单向关注：bob 关注 alice，alice 没回关 → 每天 1 条
  await dmBob.call(`/api/users/${dmAliceId}/follow`, { method: 'POST' });
  const oneWay = await dmBob.call(`/api/messages/${dmAliceName}`, { method: 'POST', body: { content: '第一条私信' } });
  check(
    '单方面关注可以发第一条私信',
    oneWay.status === 200 && oneWay.data.message.content === '第一条私信',
    JSON.stringify(oneWay.body).slice(0, 140),
  );
  check(
    '单方面关注：显示额度用尽',
    oneWay.data.availability.mutual === false && oneWay.data.availability.remainingToday === 0,
    JSON.stringify(oneWay.data.availability),
  );
  const second = await dmBob.call(`/api/messages/${dmAliceName}`, { method: 'POST', body: { content: '第二条私信' } });
  check(
    '单方面关注每天只能发一条（429）',
    second.status === 429 && second.error?.code === 'daily_limit',
    JSON.stringify(second.body),
  );
  check('额度在明天重置', oneWay.data.availability.resetsAt > Date.now());

  const inbox = await dmAlice.call('/api/messages');
  check(
    '收件人能看到会话与未读数',
    inbox.data.items.some((item) => item.peer.username === dmBobName && item.unread >= 1),
    JSON.stringify(inbox.data.items.map((item) => `${item.peer.username}:${item.unread}`)),
  );
  const thread = await dmAlice.call(`/api/messages/${dmBobName}`);
  check(
    '会话详情返回消息、未读快照与可用性',
    thread.data.messages.length >= 1 && thread.data.unreadBefore >= 1 && 'availability' in thread.data,
    JSON.stringify(thread.data.unreadBefore),
  );
  check('打开会话后未读数清零', (await dmAlice.call('/api/messages/summary')).data.unread === 0);
  check(
    '打开会话后消息标记为已读',
    (await dmAlice.call(`/api/messages/${dmBobName}`)).data.messages.every((item) => item.senderId === dmAliceId || item.read),
  );

  // alice 回关 → 互相关注 → 不限量
  await dmAlice.call(`/api/users/${dmBobId}/follow`, { method: 'POST' });
  const mutualSend = await dmBob.call(`/api/messages/${dmAliceName}`, { method: 'POST', body: { content: '互关之后第一条' } });
  check(
    '互相关注后解除每天一条限制',
    mutualSend.status === 200 && mutualSend.data.availability.mutual === true && mutualSend.data.availability.remainingToday === null,
    JSON.stringify(mutualSend.data.availability),
  );
  for (let index = 0; index < 3; index += 1) {
    await dmBob.call(`/api/messages/${dmAliceName}`, { method: 'POST', body: { content: `连发 ${index}` } });
  }
  check('互相关注可以连续发（不限量）', (await dmBob.call(`/api/messages/${dmAliceName}`)).data.messages.length >= 5);

  const stranger = createClient();
  const strangerName = `dm_${unique}`;
  await stranger.call('/api/auth/register', { method: 'POST', body: { username: strangerName, password: 'secret123' } });
  const strangerToAlice = await stranger.call(`/api/messages/${dmAliceName}`, { method: 'POST', body: { content: '我们还不认识' } });
  check(
    '没有任何关注关系不能私信（403）',
    strangerToAlice.status === 403 && strangerToAlice.error?.code === 'no_relation',
    JSON.stringify(strangerToAlice.body),
  );
  check(
    '不能给自己发私信（400）',
    (await stranger.call(`/api/messages/${strangerName}`, { method: 'POST', body: { content: '你好' } })).status === 400,
  );
  check('空内容被拒绝（400）', (await dmBob.call(`/api/messages/${dmAliceName}`, { method: 'POST', body: { content: '   ' } })).status === 400);
  check('未登录无法访问私信（401）', (await anon.call('/api/messages')).status === 401);
  check(
    '收件人会收到私信通知',
    (await dmAlice.call('/api/notifications?perPage=5')).data.items.some((item) => item.type === 'message'),
  );

  console.log('\n▶ 黑名单');
  const block = await dmAlice.call(`/api/users/${dmBobId}/block`, { method: 'POST', body: { blocked: true } });
  check('拉黑成功', block.status === 200 && block.data.blocked === true && block.data.blockCount >= 1);
  check('拉黑后对方主页变 404', (await dmBob.call(`/api/users/${dmAliceName}`)).status === 404);
  check(
    '拉黑会解除双向关注',
    (await dmAlice.call(`/api/users/${dmBobName}`)).data.user.isFollowing === false,
  );
  const followAfterBlock = await dmBob.call(`/api/users/${dmAliceId}/follow`, { method: 'POST' });
  check(
    '被拉黑者无法再关注（403）',
    followAfterBlock.status === 403 && followAfterBlock.error?.code === 'blocked_me',
    JSON.stringify(followAfterBlock.body),
  );
  const dmAfterBlock = await dmBob.call(`/api/messages/${dmAliceName}`, { method: 'POST', body: { content: '还能发吗' } });
  check('被拉黑者无法私信（403）', dmAfterBlock.status === 403 && dmAfterBlock.error?.code === 'blocked_me');
  check('被拉黑者打不开对方的会话（403）', (await dmBob.call(`/api/messages/${dmAliceName}`)).status === 403);
  check(
    '被拉黑者看不到对方的文章（列表）',
    !(await dmBob.call('/api/posts?perPage=30')).data.items.some((row) => row.author.username === dmAliceName),
  );
  const dmAlicePost = (await dmAlice.call('/api/posts', { method: 'POST', body: { boardId: 1, title: '黑名单可见性测试', content: '只有没被拉黑的人能看到' } })).data;
  check('被拉黑者通过直链也打不开文章（404）', (await dmBob.call(`/api/posts/${dmAlicePost.id}`)).status === 404);
  // 被拉黑者在第三方帖子下的回复，也对拉黑者不可见
  await dmBob.call(`/api/posts/${adminPost.id}/replies`, { method: 'POST', body: { content: '被拉黑之后的评论' } });
  const threadSeenByAlice = await dmAlice.call(`/api/posts/${adminPost.id}`);
  check(
    '被拉黑者的回复对拉黑者不可见',
    !threadSeenByAlice.data.replies.some((reply) => reply.author.username === dmBobName),
    JSON.stringify(threadSeenByAlice.data.replies.map((reply) => reply.author.username)),
  );
  check(
    '拉黑者自己也看不到对方内容',
    !(await dmAlice.call('/api/posts?perPage=30')).data.items.some((row) => row.author.username === dmBobName),
  );
  check('拉黑者主页显示拉黑状态', (await dmAlice.call(`/api/users/${dmBobName}`)).data.user.blockedByMe === true);
  check(
    '黑名单列表可用',
    (await dmAlice.call('/api/me/blocks')).data.items.some((person) => person.username === dmBobName),
  );

  const unblock = await dmAlice.call(`/api/users/${dmBobId}/block`, { method: 'POST', body: { blocked: false } });
  check('解除拉黑成功', unblock.status === 200 && unblock.data.blocked === false);
  check(
    '解除后对方又能看到文章',
    (await dmBob.call('/api/posts?perPage=30')).data.items.some((row) => row.author.username === dmAliceName),
  );
  check('解除后可以重新关注', (await dmBob.call(`/api/users/${dmAliceId}/follow`, { method: 'POST' })).status === 200);
  check(
    '不能拉黑自己（400）',
    (await dmAlice.call(`/api/users/${dmAliceId}/block`, { method: 'POST', body: { blocked: true } })).status === 400,
  );
  check('未登录不能拉黑（401）', (await anon.call(`/api/users/${dmAliceId}/block`, { method: 'POST' })).status === 401);

  console.log('\n▶ 退出登录');
  const logout = await member.call('/api/auth/logout', { method: 'POST' });
  check('退出登录成功', logout.data.loggedOut === true);
  const afterLogout = await member.call('/api/auth/me');
  check('退出后会话失效', afterLogout.data.user === null);

  console.log(`\n${'─'.repeat(46)}`);
  console.log(`通过 ${passed} 项，失败 ${failures.length} 项`);
  if (failures.length) {
    console.log('\n失败明细：');
    for (const item of failures) console.log(`  · ${item}`);
  }
  await finish(failures.length ? 1 : 0);
} catch (error) {
  console.error('\n冒烟测试异常终止：', error);
  console.error('\n服务器日志尾部：\n', readFileSync(LOG_FILE, 'utf8').slice(-3000));
  await finish(1);
}
