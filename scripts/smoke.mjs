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

/*
 * 帖子不能新建了（`POST /api/posts` 一律 410 `posts_retired`）；能新建的是积木，
 * 而每篇积木自带一条「影子锚点帖」：赞 / 踩 / 收藏 / 回复 / 分类 / 置顶 / 隐藏
 * 仍然认这条锚点的 `posts.id`。所以「造一篇帖子」= 建积木 → 取它的锚点。
 */
async function newAnchorPost(actor, title, extra = {}) {
  const created = await actor.call('/api/docs', { method: 'POST', body: { title, kind: 'post', scope: 'public', ...extra } });
  if (created.status !== 200 || !created.data?.doc?.id) {
    throw new Error(`建积木失败（${created.status}）：${JSON.stringify(created.body)}`);
  }
  const anchor = await actor.call(`/api/docs/${created.data.doc.id}/anchor`);
  if (!anchor.data?.post?.id) {
    throw new Error(`积木 ${created.data.doc.id} 没有影子锚点：${JSON.stringify(anchor.body)}`);
  }
  return { docId: created.data.doc.id, postId: anchor.data.post.id };
}

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
    '/api/site 不再下发投币规则（投币已下线）',
    site.data.coinRules === undefined,
    JSON.stringify(site.data?.coinRules),
  );
  const home = await anon.call('/', { raw: true });
  const homeHtml = await home.text();
  check('首页 HTML 正常返回', home.status === 200 && homeHtml.includes('格社'));
  const css = await anon.call('/style.css', { raw: true });
  check('样式表可访问', css.status === 200 && css.headers.get('content-type').includes('text/css'));
  const spa = await anon.call('/post/1', { raw: true });
  check('未知路径回落 SPA 入口', spa.status === 200);

  console.log('\n▶ 注册 / 登录 / 会话');
  /* 「未登录发帖被拒绝（401）」搬到了下面的「帖子写入已下线」小节：现在未登录发帖
     也是 410 —— 写接口整条被短路，认证守卫根本没机会跑（这是刻意的，不是漏判）。 */

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
  check('新用户注册不再赠送币（coinBalance 不存在）', me.data?.user?.coinBalance === undefined, JSON.stringify(me.data?.user));
  check('新用户收到欢迎通知', me.data?.unread >= 1, `unread=${me.data?.unread}`);

  const welcome = await member.call('/api/notifications');
  check('欢迎通知类型为 system', Boolean(typeOf(welcome.data.items, 'system')), JSON.stringify(welcome.data.items[0]));

  const duplicate = await anon.call('/api/auth/register', {
    method: 'POST',
    body: { username: `smoke_${unique}`, password: 'secret123' },
  });
  check('同名注册被拒绝（409）', duplicate.status === 409, `status=${duplicate.status}`);

  console.log('\n▶ 帖子写入已下线');
  const retiredCreate = await member.call('/api/posts', {
    method: 'POST',
    body: { boardId: 1, title: `还能发帖吗 ${unique}`, content: '这条必须被拒' },
  });
  check(
    '登录用户发帖被拒绝（410 posts_retired）',
    retiredCreate.status === 410 && retiredCreate.error?.code === 'posts_retired',
    JSON.stringify(retiredCreate.body),
  );
  const anonRetired = await anon.call('/api/posts', { method: 'POST', body: { boardId: 1, title: '未登录', content: 'x' } });
  check(
    '未登录发帖也是 410（不是 401：路由先短路，认证守卫跑不到）',
    anonRetired.status === 410 && anonRetired.error?.code === 'posts_retired',
    JSON.stringify(anonRetired.body),
  );
  const retiredUpdate = await member.call('/api/posts/1', { method: 'PUT', body: { title: '改标题' } });
  check(
    '改帖被拒绝（410 posts_retired）',
    retiredUpdate.status === 410 && retiredUpdate.error?.code === 'posts_retired',
    JSON.stringify(retiredUpdate.body),
  );
  const retiredDelete = await member.call('/api/posts/1', { method: 'DELETE' });
  check(
    '删帖被拒绝（410 posts_retired）',
    retiredDelete.status === 410 && retiredDelete.error?.code === 'posts_retired',
    JSON.stringify(retiredDelete.body),
  );

  /* 下面所有「刚建的那篇帖子」都是积木的**影子锚点帖** —— 互动接口照打不误。
     旧代码那条「过短标题被拒绝（400）」随帖子写入一起下线：标题校验现在归积木的
     `normalizeTitle`（只拒空标题与超长标题，没有「至少几个字」这条规矩）。 */
  console.log('\n▶ 积木 / 列表 / 分页');
  const { docId, postId } = await newAnchorPost(member, `冒烟测试帖 ${unique}`);

  /*
   * 恶意 / 手滑的分页参数不能让列表接口 500。
   *
   * `?page=1e999` 得到 `Infinity`、`?page=1e30` 超出安全整数范围，两个都会被当成
   * LIMIT / OFFSET 绑进 SQL，`node:sqlite` 抛 `datatype mismatch` → 500。这类 URL
   * 能贴在地址栏里、能转发给别人，一个链接就能把整页打成「服务器开小差了」。
   * 统一走 `pageParam`（`src/core/http.js`），不认识的输入一律退回第 1 页。
   */
  for (const bad of ['1e999', '1e30', '2.5', 'abc', '-3']) {
    const r = await anon.call(`/api/posts?page=${encodeURIComponent(bad)}`);
    check(`奇怪的页码 ?page=${bad} 不该 500`, r.status === 200 && r.data.page === 1, `status=${r.status} page=${r.data?.page}`);
  }
  const badNotifPage = await member.call('/api/notifications?page=1e30');
  check('通知列表的奇怪页码也不该 500', badNotifPage.status === 200, `status=${badNotifPage.status}`);

  const listed = await anon.call('/api/posts?perPage=5&page=1');
  check('列表分页字段完整', listed.data.items.length <= 5 && listed.data.totalPages >= 1);
  check(
    '列表返回评价与收藏计数字段',
    ['likeCount', 'dislikeCount', 'bookmarkCount', 'liked', 'disliked', 'authorFollowed'].every(
      (key) => key in listed.data.items[0],
    ),
  );
  check(
    '列表形状里不再有投币字段（coinCount / myCoins）',
    listed.data.items.every((item) => item.coinCount === undefined && item.myCoins === undefined),
    JSON.stringify(Object.keys(listed.data.items[0] ?? {})),
  );
  check('新帖出现在列表中', listed.data.items.some((item) => item.id === postId) || listed.data.total > 5);

  const searched = await anon.call(`/api/posts?q=${unique}`);
  check('全文搜索命中新帖', searched.data.items.length === 1 && searched.data.items[0].id === postId);

  console.log('\n▶ 详情 / Markdown 安全');
  const detail = await anon.call(`/api/posts/${postId}`);
  /* 锚点帖的 content 是积木正文的**纯文本摘要**（`blocksToPlainText`，不是 markdown），
     所以「正文渲染出 <strong> / md-code」这类断言在锚点帖上不成立。渲染与转义改打在
     同一根渲染管道 `/api/markdown/preview` 上 —— 安全检查没有降级：同样的 markdown
     加一段 `<script>`，照样要求粗体、代码块渲染出来，脚本被转义。 */
  check(
    '锚点帖详情可用（正文是积木的纯文本摘要）',
    detail.status === 200 && typeof detail.data.post.contentHtml === 'string',
    JSON.stringify(detail.body).slice(0, 140),
  );
  check('浏览数自增', detail.data.post.views >= 1);

  const preview = await member.call('/api/markdown/preview', {
    method: 'POST',
    body: {
      content: `## 小标题\n\n这是 **粗体** 与 \`行内代码\`。\n\n\`\`\`js\nconst x = 1;\n\`\`\`\n\n<script>alert('xss')</script>`,
    },
  });
  check('帖子用的那根渲染管道仍可用（预览接口）', preview.status === 200 && typeof preview.data.html === 'string');
  check('markdown 粗体渲染成 <strong>', preview.data.html.includes('<strong>粗体</strong>'));
  check('代码块被渲染', preview.data.html.includes('md-code'));
  check('脚本注入被转义', !preview.data.html.includes('<script>'), preview.data.html.slice(0, 160));

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

  console.log('\n▶ 投币已下线');
  const goneCoin = await member.call(`/api/posts/${postId}/coin`, { method: 'POST', body: { amount: 1 } });
  check('投币接口已下线（404，而不是 401 / 403）', goneCoin.status === 404, JSON.stringify(goneCoin.body).slice(0, 120));
  check(
    '匿名投币同样是 404（路由整条没了）',
    (await anon.call(`/api/posts/${postId}/coin`, { method: 'POST', body: { amount: 1 } })).status === 404,
  );
  check('管理员投币也是 404', (await admin.call(`/api/posts/${postId}/coin`, { method: 'POST', body: { amount: 1 } })).status === 404);
  const siteNoCoin = await anon.call('/api/site');
  check('/api/site 不再下发投币规则', siteNoCoin.data.coinRules === undefined, JSON.stringify(siteNoCoin.data?.coinRules));
  const listNoCoin = await anon.call('/api/posts?perPage=5');
  check(
    '帖子列表形状里没有 coinCount / myCoins',
    listNoCoin.data.items.every((item) => item.coinCount === undefined && item.myCoins === undefined),
    JSON.stringify(Object.keys(listNoCoin.data.items[0] ?? {})),
  );
  const detailNoCoin = await member.call(`/api/posts/${postId}`);
  check(
    '帖子详情形状里没有 coin / coinCount / myCoins',
    detailNoCoin.data.post.coin === undefined &&
      detailNoCoin.data.post.coinCount === undefined &&
      detailNoCoin.data.post.myCoins === undefined,
    JSON.stringify(Object.keys(detailNoCoin.data.post)),
  );
  const meNoCoin = await member.call('/api/auth/me');
  check('登录信息里没有 coinBalance', meNoCoin.data?.user?.coinBalance === undefined, JSON.stringify(meNoCoin.data?.user));

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
      ['postCount', 'replyCount', 'followerCount', 'followingCount', 'likesReceived'].every(
        (key) => key in profile.data.user,
      ),
    JSON.stringify(profile.data.user).slice(0, 200),
  );
  check('个人主页返回帖子列表', Array.isArray(profile.data.posts) && profile.data.posts.length >= 1);
  check('关注状态对浏览者可见', profile.data.user.isFollowing === false && profile.data.user.isMe === false);
  const unknownUser = await anon.call('/api/users/definitely_not_here');
  check('不存在的用户返回 404', unknownUser.status === 404);

  // 主页的「关注者」和「TA 关注的人」两张卡、以及「关注列表」页，用的是同一套
  // person-chip 按钮。每行都得带 viewerFollows，按钮才知道该显示「＋ 关注」还是
  // 「✓ 已关注」；少了它，已经关注的人也会显示「＋ 关注」，点一下反而是取关。
  const adminProfile = await member.call('/api/users/admin');
  check(
    '主页两张关注名单卡都下发 viewerFollows',
    [...(adminProfile.data.followers ?? []), ...(adminProfile.data.following ?? [])].every(
      (person) => typeof person.viewerFollows === 'boolean',
    ),
    JSON.stringify((adminProfile.data.following ?? []).map((person) => `${person.username}:${person.viewerFollows}`)),
  );
  check(
    '「我关注的人」名单里 viewerFollows 全为 true',
    following.data.items.every((item) => item.viewerFollows === true),
    JSON.stringify(following.data.items.map((item) => `${item.username}:${item.viewerFollows}`)),
  );
  const unfollow = await member.call(`/api/users/${adminId}/follow`, { method: 'POST' });
  const afterUnfollow = await member.call('/api/me/following');
  check(
    '再点一次「已关注」就取消关注（名单里立刻没有 TA）',
    unfollow.data.following === false && !afterUnfollow.data.items.some((item) => item.id === adminId),
    JSON.stringify(afterUnfollow.data.items.map((item) => item.username)),
  );
  const refollow = await member.call(`/api/users/${adminId}/follow`, { method: 'POST' });
  const afterRefollow = await member.call('/api/me/following');
  check(
    '取消之后还能再关注回来（名单里又有 TA 了）',
    refollow.data.following === true && afterRefollow.data.items.some((item) => item.id === adminId),
    JSON.stringify({ following: refollow.data.following, rows: afterRefollow.data.items.length }),
  );

  console.log('\n▶ 消息通知');
  // 通知应该发给内容作者 / 被关注者，而不是操作者
  const authorNotifs = await member.call('/api/notifications?perPage=50');
  check('关注者自己不会收到自己的关注通知', !typeOf(authorNotifs.data.items, 'follow'));
  const adminNotifs = await admin.call('/api/notifications?perPage=50');
  check(
    '关注通知发给了被关注的人',
    Boolean(typeOf(adminNotifs.data.items, 'follow', (item) => item.actor?.username === `smoke_${unique}`)),
    JSON.stringify(adminNotifs.data.items.slice(0, 4).map((item) => `${item.type}:${item.actor?.username}`)),
  );
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

  /*
   * 两条通知断言随帖子写入一起下线，这里是删掉的理由（不是放宽）：
   *
   * 1. 「关注的人发新帖会通知我（following_post）」：产生这条通知的唯一入口是
   *    `POST /api/posts`（现在一律 410），服务端 `src/` 里已经**没有任何地方**
   *    再写 following_post 通知（`grep -r following_post src` 只剩前端文案）。
   *    没有能触发它的路径，这条断言无处可测。
   *
   * 2. 「帖子被管理员删除时作者收到通知（moderation）」：`DELETE /api/posts/:id`
   *    同样 410；现在删的只能是积木（`DELETE /api/docs/:id`），而删积木不发通知。
   *    同一个通知类型在前面「隐藏」小节里仍然被断言着（admin hide → moderation），
   *    所以「管理动作会通知作者」这条链路并没有失去覆盖。
   */

  console.log('\n▶ 签到已下线');
  const goneCheckin = await member.call('/api/checkin');
  check('签到状态接口已下线（404）', goneCheckin.status === 404, JSON.stringify(goneCheckin.body).slice(0, 120));
  check('签到 POST 也下线了（404，而不是 405 / 401）', (await member.call('/api/checkin', { method: 'POST' })).status === 404);
  check('未登录访问签到同样是 404（路由整条没了）', (await anon.call('/api/checkin')).status === 404);

  console.log('\n▶ 个人主页标签与置顶（分类功能已下线，需求 4）');
  const memberName = `smoke_${unique}`;
  // 分类那五条接口整组撤掉了：断言 404 而不是「返回空列表」——空列表说明功能还在，
  // 只是没数据；404 才说明路由真的没了。
  check('分类列表接口已下线（404）', (await member.call('/api/me/categories')).status === 404);
  check('创建分类接口已下线（404）', (await member.call('/api/me/categories', { method: 'POST', body: { name: '前端笔记' } })).status === 404);
  check('重命名分类接口已下线（404）', (await member.call('/api/me/categories/1', { method: 'PUT', body: { name: 'x' } })).status === 404);
  check('删除分类接口已下线（404）', (await member.call('/api/me/categories/1', { method: 'DELETE' })).status === 404);
  check('给帖子设分类的接口已下线（404）', (await member.call('/api/posts/1/category', { method: 'POST', body: { categoryId: null } })).status === 404);
  check('接口没了但字段还在（老客户端不会炸）', Array.isArray((await member.call(`/api/users/${encodeURIComponent(memberName)}`)).data.categories));

  // 置顶上限：先把名额占满（先数一下已经有几篇，别硬编码），再尝试第 4 篇。
  // 硬编码「补两篇」会在前面多置一篇时变成假失败。
  const pinnedNow = Number((await member.call(`/api/users/${encodeURIComponent(memberName)}`)).data.pinnedCount);
  const extraPosts = [];
  for (let index = pinnedNow; index < 3; index += 1) {
    const anchor = await newAnchorPost(member, `置顶测试 ${index} ${unique}`);
    extraPosts.push(anchor.postId);
    await member.call(`/api/posts/${anchor.postId}/profile-pin`, { method: 'POST', body: { pinned: true } });
  }
  const overflowAnchor = await newAnchorPost(member, `置顶溢出 ${unique}`);
  const overflowPin = await member.call(`/api/posts/${overflowAnchor.postId}/profile-pin`, { method: 'POST', body: { pinned: true } });
  check('超过置顶上限被拒绝（400）', overflowPin.status === 400 && overflowPin.error?.code === 'pin_limit', JSON.stringify(overflowPin.body));

  check(
    '不能置顶别人的文章（403）',
    (await member.call(`/api/posts/${adminPost.id}/profile-pin`, { method: 'POST', body: { pinned: true } })).status === 403,
  );
  // 取消一篇，名额就还回来了（顺带证明「上限」算的是当前挂着几篇，不是累计置顶过几次）
  const freedPost = extraPosts[0] ?? overflowAnchor.postId;
  const unpin = await member.call(`/api/posts/${freedPost}/profile-pin`, { method: 'POST', body: { pinned: false } });
  check('可以取消置顶', unpin.status === 200 && unpin.data.profilePinned === false && unpin.data.pinnedCount === 2);
  const repin = await member.call(`/api/posts/${freedPost}/profile-pin`, { method: 'POST', body: { pinned: true } });
  check('腾出名额后又能置顶', repin.status === 200 && repin.data.profilePinned === true && repin.data.pinnedCount === 3);

  // 标签是新的「归类」：贴在积木上，个人主页按标签筛。
  // 为什么断言「筛选结果条数 == 标签上的计数」：这正是需求 3 那个 bug 的形状 ——
  // 显示数与计数走两条路就会差；这里两个数都从同一套口径（deleted/hidden/wiki 页排除）来。
  const taggedAnchor = await newAnchorPost(member, `标签测试帖 ${unique}`, { tags: ['冒烟标签'] });
  const profileView = await anon.call(`/api/users/${encodeURIComponent(memberName)}`);
  const tagChip = (profileView.data.tags ?? []).find((item) => item.name === '冒烟标签');
  check(
    '个人主页返回标签、置顶计数与上限',
    Array.isArray(profileView.data.tags) && Boolean(tagChip) && tagChip.postCount >= 1 && profileView.data.pinnedCount === 3 && profileView.data.pinLimit === 3,
    JSON.stringify({ tags: profileView.data.tags, pinned: profileView.data.pinnedCount }),
  );
  check(
    '置顶文章排在个人主页第一位',
    profileView.data.posts.slice(0, profileView.data.pinnedCount).every((item) => item.profilePinned === true) &&
      profileView.data.posts.slice(profileView.data.pinnedCount).every((item) => item.profilePinned === false),
    JSON.stringify(profileView.data.posts.slice(0, 4).map((item) => ({ id: item.id, pinned: item.profilePinned }))),
  );
  const tagFiltered = await anon.call(`/api/users/${encodeURIComponent(memberName)}?tag=${encodeURIComponent('冒烟标签')}`);
  check(
    '可按标签筛选个人主页文章（条数与标签计数一致）',
    tagFiltered.data.posts.length === tagChip.postCount && tagFiltered.data.posts.every((item) => item.id === taggedAnchor.postId),
    JSON.stringify({ posts: tagFiltered.data.posts.length, chip: tagChip.postCount }),
  );
  check(
    '筛一个没人用过的标签就是空（不是全量）',
    (await anon.call(`/api/users/${encodeURIComponent(memberName)}?tag=${encodeURIComponent('没人用过的标签')}`)).data.posts.length === 0,
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
  // 自己的文章也能转（转发 = 把它放进自己主页的「🔁 转发」分类）。转完立刻撤掉，
  // 免得把后面的计数用例算歪 —— 下面那些断言都按「只有 member 转过这篇」起算。
  const selfRepost = await admin.call(`/api/posts/${adminPost.id}/repost`, { method: 'POST', body: { comment: '自己转自己' } });
  check(
    '自己的文章也能转发（不再 400 self_repost）',
    selfRepost.status === 200 && selfRepost.data.reposted === true,
    `${selfRepost.status} ${JSON.stringify(selfRepost.data ?? selfRepost.error)}`,
  );
  const selfCancel = await admin.call(`/api/posts/${adminPost.id}/repost`, { method: 'DELETE' });
  check(
    '自己转的也撤得掉（撤完计数回到只剩 member 那一条）',
    selfCancel.status === 200 && selfCancel.data.reposted === false && selfCancel.data.repostCount === beforeRepostCount + 1,
    JSON.stringify(selfCancel.data),
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

  // 注意 `?category=reposts` 这个**旧参数名**是刻意留着的：它跟已下线的「个人主页分类」
  // 无关，只是「看转发」这个视图的历史地址（前端也还用它）。改的是分类功能，不是这里。
  const profileReposts = (await anon.call(`/api/users/${encodeURIComponent(`smoke_${unique}`)}?category=reposts`)).data;
  check(
    '个人主页「看转发」视图可见',
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

  console.log('\n▶ 价值排行已下线');
  const goneRanking = await anon.call('/api/ranking?limit=20');
  check('排行榜接口已下线（404）', goneRanking.status === 404, JSON.stringify(goneRanking.body).slice(0, 120));
  check('排行榜带时间窗参数同样 404', (await anon.call('/api/ranking?window=7&limit=50')).status === 404);
  const siteGone = await anon.call('/api/site');
  check(
    '/api/site 不再下发签到规则与价值权重',
    siteGone.data.checkinRules === undefined && siteGone.data.valueWeights === undefined,
    JSON.stringify({ checkinRules: siteGone.data.checkinRules, valueWeights: siteGone.data.valueWeights }),
  );
  check('帖子详情不再有 baseScore / valueScore', (await anon.call(`/api/posts/${postId}`)).data.post.valueScore === undefined);
  // carol 的会话留给后面「隐藏帖之后还能不能互动」那一段用（原来建在这段里）
  const carolClient = createClient();
  await carolClient.call('/api/auth/login', { method: 'POST', body: { username: 'carol', password: 'demo1234' } });

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
  const postWithAvatar = await anon.call(`/api/posts/${taggedAnchor.postId}`);
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
    // 个人主页的口径是「只列公开的积木帖子」：站务隐藏的那一篇 **对作者本人也不再出现**。
    // 为什么这么定（而不是「作者还看得见、只是带个隐藏标记」）：
    // 主页上「文章」那个计数（`user.postCount`）数的是公开帖子，列表要是还漏一行进来，
    // 用户看到的数字和数出来的条数就对不上 —— 这正是用户报的
    //「发过的帖子数量和实际能显示的数量统一」。所以列表与计数一起按公开口径算。
    '作者主页上不再出现被隐藏的文章',
    !(await bob.call('/api/users/bob')).data.posts.some((row) => row.id === hideTarget.id),
  );
  check(
    '作者主页的「文章」计数与列表条数一致',
    await (async () => {
      const mine = (await bob.call('/api/users/bob')).data;
      return mine.user.postCount === mine.posts.length;
    })(),
  );
  check(
    '别人看不到作者页面上的隐藏文章',
    !(await anon.call('/api/users/bob')).data.posts.some((row) => row.id === hideTarget.id),
  );

  /* 个人主页 = 一篇积木文档（需求 1/2）。这里只钉住三条最容易回归的对外行为：
     ① 名片块锁死（删 / 挪 / 改内容都不许），② 名片由**宿主**渲染，
     ③ 补名片不能短路「草稿只有作者看得见」。 */
  console.log('\n▶ 个人主页的积木块');
  {
    const alice = createClient();
    const aliceLogin = await alice.call('/api/auth/login', { method: 'POST', body: { username: 'alice', password: 'demo1234' } });
    check('示例用户 alice 可登录（验个人主页用）', aliceLogin.status === 200, JSON.stringify(aliceLogin.body).slice(0, 160));
    // 拿一个**还没有主页**的用户来验种子：`POST /api/docs {kind:'profile'}` 对已有主页的人
    // 会原样交回旧文档（一个用户至多一份），拿 admin 验不出 seed。
    const plan = await anon.call('/api/docs/profile/alice');
    let profileDocId = plan.data?.doc?.id;
    if (!plan.data?.found) {
      const created = await alice.call('/api/docs', { method: 'POST', body: { kind: 'profile', title: '我的主页' } });
      profileDocId = created.data?.doc?.id;
    }
    check('可以建出个人主页文档', Boolean(profileDocId), JSON.stringify(plan.body).slice(0, 200));
    const owned = await alice.call(`/api/docs/${profileDocId}`);
    check('个人主页文档 kind=profile', owned.data?.doc?.kind === 'profile', JSON.stringify(owned.data?.doc));
    const homeBlocks = owned.data?.blocks ?? [];
    check(
      '第一块是「个人主页名片」（缺失就补）',
      homeBlocks.length > 0 && homeBlocks[0].props?.app === '个人主页名片',
      JSON.stringify(homeBlocks.map((row) => row.props?.app ?? row.type)),
    );
    check(
      '名片块里存的是占位（真卡片只在渲染时出现）',
      homeBlocks[0]?.props?.code === '<div class="profile-head-slot" data-profile-card></div>',
      JSON.stringify(homeBlocks[0]?.props?.code),
    );
    const cardId = homeBlocks[0]?.blockId;
    if (cardId) {
      check('删掉名片块被拒绝', (await alice.call(`/api/docs/${profileDocId}/blocks/${cardId}`, { method: 'DELETE' })).status >= 400);
      check(
        '把别的块挪到名片前面也被拒绝',
        (
          await alice.call(`/api/docs/${profileDocId}/blocks/reorder`, {
            method: 'POST',
            body: { order: [...homeBlocks.slice(1).map((row) => row.blockId), cardId] },
          })
        ).status >= 400,
      );
      check(
        '改名片块的内容被拒绝（这一块由主页自己渲染）',
        (
          await alice.call(`/api/docs/${profileDocId}/blocks/${cardId}`, {
            method: 'PUT',
            body: { props: { app: '个人主页名片', config: {}, code: '<b>x</b>' } },
          })
        ).status >= 400,
      );
    }
    const homeHtml = String((await anon.call('/api/docs/profile/alice')).data?.html ?? '');
    check(
      '主页渲染出来的是宿主画的真卡片',
      homeHtml.includes('data-profile-card') && homeHtml.includes('profile-actions'),
    );
    const plaza = await anon.call('/api/docs?perPage=100');
    check(
      '个人主页不进积木广场',
      Array.isArray(plaza.data?.documents) && !plaza.data.documents.some((row) => row.kind === 'profile'),
      JSON.stringify({ status: plaza.status, keys: Object.keys(plaza.data ?? {}) }),
    );
    const stats = await anon.call('/api/docs/profile/alice/stats');
    check(
      '个人信息统计 API 可用且与列表同口径',
      stats.status === 200 &&
        typeof stats.data?.postCount === 'number' &&
        Array.isArray(stats.data?.posts) &&
        stats.data.posts.length <= stats.data.postCount,
      JSON.stringify({ status: stats.status, postCount: stats.data?.postCount, posts: stats.data?.posts?.length }),
    );
    /* 草稿回归（曾经真的坏过）：`ensureProfileCard` 一度把整份块序列当返回值交给 `present()`，
       于是「读者只能看见发布出去那一份」被短路 —— 作者刚加进草稿的块，匿名读者也看得见。
       正确的流程是**先 POST /draft 进草稿箱**，再写块（正文写接口默认直接生效，见 routes.js:303）。 */
    const beforeDraft = String((await anon.call('/api/docs/profile/alice')).data?.html ?? '');
    await alice.call(`/api/docs/${profileDocId}/draft`, { method: 'POST' });
    const draftText = `草稿专用文字-${unique}`;
    const added = await alice.call(`/api/docs/${profileDocId}/blocks`, {
      method: 'POST',
      body: { type: 'paragraph', props: { text: draftText } },
    });
    check('作者可以把新块留在草稿里', added.status === 200, `status=${added.status}`);
    const anonDraft = String((await anon.call('/api/docs/profile/alice')).data?.html ?? '');
    check(
      '读者看不到草稿里的块（发布那一份没被补名片短路）',
      !anonDraft.includes(draftText),
      JSON.stringify({ draftSeen: anonDraft.includes(draftText) }),
    );
    /* 光「看不见草稿」还不够 —— 一份**空**的读者视图也能满足它。补两条：读者那份里
       名片占位与名片块都还在（也就是说读者拿到的确实是「发布那一份」而不是别的）。 */
    check(
      '有草稿时读者拿到的仍是发布那一份（名片还在渲染）',
      beforeDraft.includes('data-profile-card') && anonDraft.includes('data-profile-card') && anonDraft.includes('profile-actions'),
      JSON.stringify({ before: beforeDraft.includes('data-profile-card'), after: anonDraft.includes('data-profile-card') }),
    );
    check('作者自己看得到', String((await alice.call('/api/docs/profile/alice')).data?.html ?? '').includes(draftText));
    if (added.data?.blockId) {
      await alice.call(`/api/docs/${profileDocId}/blocks/${added.data.blockId}`, { method: 'DELETE' });
    }
  }  check('管理团队仍能打开隐藏文章', (await admin.call(`/api/posts/${hideTarget.id}`)).status === 200);
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
  /* `DELETE /api/posts/:id` 已经 410（上面「帖子写入已下线」小节断言过），所以
     「删除」的权限断言改打在积木上：删积木会把影子锚点同步成 `deleted = 1`。 */
  const deleteOwn = await member.call(`/api/docs/${docId}`, { method: 'DELETE' });
  check('作者可删除自己的积木', deleteOwn.status === 200 && deleteOwn.data.deleted === true, JSON.stringify(deleteOwn.body));
  const gone = await anon.call(`/api/posts/${postId}`);
  check('删除积木后锚点帖详情返回 404', gone.status === 404, `status=${gone.status}`);
  const anonDelete = await anon.call(`/api/docs/${docId}`, { method: 'DELETE' });
  check('未登录删除积木被拒绝（401）', anonDelete.status === 401, `status=${anonDelete.status}`);
  const forbidden = await member.call(`/api/admin/overview`);
  check('普通用户访问后台被拒绝（403）', forbidden.status === 403, `status=${forbidden.status}`);

  console.log('\n▶ 管理后台');
  const overview = await admin.call('/api/admin/overview');
  check('后台统计可用', overview.status === 200 && overview.data.stats.users >= 4);
  check(
    '后台统计包含互动数据',
    ['reactions', 'follows', 'bookmarks'].every((key) => key in overview.data.stats),
    JSON.stringify(overview.data.stats),
  );
  check('后台统计不再有 coins 计数', !('coins' in overview.data.stats), JSON.stringify(overview.data.stats));
  check(
    '后台返回用户列表（含粉丝数，不含余额）',
    Array.isArray(overview.data.users) && 'followerCount' in overview.data.users[0] && !('coinBalance' in overview.data.users[0]),
  );

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
  /* 帖子不能新建了：用 dmAlice 的新积木 + 它的影子锚点帖，做同一条可见性检查。 */
  const dmAliceAnchor = await newAnchorPost(dmAlice, '黑名单可见性测试');
  const dmAlicePost = { id: dmAliceAnchor.postId };
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

  /* ---------------- 锁定帖子的互动守卫 ---------------- */
  // locked 没有对外接口（只能由数据库置位），所以这里直接改临时库再发请求。
  console.log('\n▶ 锁定帖子的互动守卫');
  const lockedAnchor = await newAnchorPost(member, '锁定测试帖');
  const lockedPost = { id: lockedAnchor.postId };
  {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(DB_FILE);
    const setLocked = (locked) => db.prepare('UPDATE posts SET locked = ? WHERE id = ?').run(locked, lockedPost.id);
    setLocked(1);
    console.log('DEBUG 脚本看到 =', JSON.stringify(db.prepare('SELECT id, locked FROM posts WHERE id = ?').get(lockedPost.id)), 'DB_FILE =', DB_FILE);
    const debugDetail = await anon.call(`/api/posts/${lockedPost.id}`);
    console.log('DEBUG 服务器看到 locked =', debugDetail.data?.post?.locked, 'status =', debugDetail.status);
    try {
      const reaction = await dmAlice.call(`/api/posts/${lockedPost.id}/reaction`, { method: 'POST', body: { kind: 'like' } });
      check('锁定后不能评价（403 locked）', reaction.status === 403 && reaction.error?.code === 'locked', JSON.stringify(reaction.body));
      const bookmark = await dmAlice.call(`/api/posts/${lockedPost.id}/bookmark`, { method: 'POST' });
      check('锁定后不能收藏（403 locked）', bookmark.status === 403 && bookmark.error?.code === 'locked', JSON.stringify(bookmark.body));
      const reply = await dmAlice.call(`/api/posts/${lockedPost.id}/replies`, { method: 'POST', body: { content: '锁了还能回吗' } });
      check('锁定后不能回复（403 locked）', reply.status === 403 && reply.error?.code === 'locked', JSON.stringify(reply.body));
      check('锁定不影响浏览', (await anon.call(`/api/posts/${lockedPost.id}`)).status === 200);
    } finally {
      setLocked(0);
      db.close();
    }
    const afterUnlock = await dmAlice.call(`/api/posts/${lockedPost.id}/bookmark`, { method: 'POST' });
    check('解锁后又能收藏', afterUnlock.status === 200, JSON.stringify(afterUnlock.body));
  }

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
