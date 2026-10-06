/**
 * 团队（P4）的端到端测试：起一个临时服务器（独立库 + 独立端口），
 * 用真实 HTTP 请求把 P4 开工说明第七节的七条验收标准逐条走一遍。
 *
 * 用法：node scripts/team-smoke.mjs
 *
 * ⚠️ 和 feed-smoke.mjs 一样，这个文件专门覆盖 check-golden / smoke 抓不到的东西：
 * **可见范围与越权**。「非成员看不到团队帖」这种断言一律从**另一个账号**发请求去验，
 * 不是检查前端有没有藏按钮 —— 前端藏起来不叫权限。
 *
 * ⚠️ 测试账号一律**自己注册**，不复用种子里的 admin / alice / bob / carol：
 * 种子数据里有现成的关注关系，会让「未关注时看不到」这条断言一开始就错 ——
 * 那测的是种子数据，不是我的代码。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const SERVER = join(ROOT, 'src', 'server.js');
const DB_FILE = join(ROOT, 'data', 'team-smoke.db');
const AVATAR_DIR = join(ROOT, 'data', 'team-smoke-avatars');
const NOTES_DIR = join(ROOT, 'data', 'team-smoke-notes');
const LOG_FILE = join(ROOT, 'data', 'team-smoke-server.log');
const PORT = Number(process.env.TEAM_SMOKE_PORT || 3444);
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

function createClient() {
  let cookie = '';
  return {
    async call(path, { method = 'GET', body } = {}) {
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
      const json = await response.json().catch(() => null);
      return { status: response.status, body: json, data: json?.data, error: json?.error };
    },
  };
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

/** 注册一个全新账号，返回 `{client, user}`。 */
async function signUp(username) {
  const client = createClient();
  const password = `${username}-pass1`;
  const result = await client.call('/api/auth/register', { method: 'POST', body: { username, password } });
  const me = await client.call('/api/auth/me');
  return { client, user: me.data?.user ?? null, registered: result.status === 200, password };
}

mkdirSync(join(ROOT, 'data'), { recursive: true });
for (const suffix of ['', '-wal', '-shm']) rmSync(DB_FILE + suffix, { force: true });

const logFd = openSync(LOG_FILE, 'w');
const child = spawn(process.execPath, [SERVER], {
  env: {
    ...process.env,
    PORT: String(PORT),
    DB_FILE,
    AVATAR_DIR,
    NOTES_DIR,
    QUIET: '1',
    AI_API_KEY: '',
  },
  stdio: ['ignore', logFd, logFd],
});

const finish = async (code) => {
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
      /* 忽略 */
    }
  }
  rmSync(AVATAR_DIR, { recursive: true, force: true });
  rmSync(NOTES_DIR, { recursive: true, force: true });
  console.log('');
  console.log('──────────────────────────────────────────────');
  console.log(`通过 ${passed} 项，失败 ${failures.length} 项`);
  for (const item of failures) console.log(`  ❌ ${item}`);
  process.exit(code);
};

try {
  if (!(await waitForServer())) {
    console.log('❌ 服务器没能在 20 秒内起来，看 data/team-smoke-server.log');
    await finish(1);
  }

  const anon = createClient();
  const owner = await signUp('teamowner');
  const mate = await signUp('teammate');
  const outsider = await signUp('teamoutsider');
  const fan = await signUp('teamfan');
  const stranger = await signUp('teamstranger');

  check(
    '五个测试账号都是新注册的',
    [owner, mate, outsider, fan, stranger].every((entry) => entry.registered && entry.user),
  );

  /* ── 验收①：两张表建起来了 ─────────────────────────────────────── */
  try {
    const inspect = new DatabaseSync(DB_FILE, { readOnly: true });
    const names = inspect
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('teams','team_members','team_posts')")
      .all()
      .map((row) => row.name)
      .sort();
    check('验收①：teams / team_members / team_posts 三张表都在库里', names.join(',') === 'team_members,team_posts,teams', names.join(','));
    const memberInfo = inspect.prepare('PRAGMA table_info(team_members)').all();
    const pk = memberInfo.filter((column) => Number(column.pk) > 0).map((column) => column.name).sort();
    check('team_members 的主键是 (team_id, user_id) —— 一个人在一个团队只可能有一行', pk.join(',') === 'team_id,user_id', pk.join(','));
    const postInfo = inspect.prepare('PRAGMA table_info(team_posts)').all().map((column) => column.name);
    check('team_posts 有 version 列（乐观并发的基础）', postInfo.includes('version'), postInfo.join(','));
    check('team_posts 有 scope 列', postInfo.includes('scope'));
    inspect.close();
  } catch (error) {
    check('验收①：能读到库里的表结构', false, error.message);
  }

  /* ── 建队 ───────────────────────────────────────────────────────── */
  const created = await owner.client.call('/api/teams', {
    method: 'POST',
    body: { name: '测试小队', intro: '端到端测试用的团队' },
  });
  check('创建团队返回 200', created.status === 200, JSON.stringify(created.error ?? created.body));
  const team = created.data?.team;
  check('中文队名能派生出一个合法的团队地址', typeof team?.slug === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(team.slug), String(team?.slug));
  check('创建者自动成为 owner', team?.myRole === 'owner' && team?.joined === true, String(team?.myRole));
  check('成员数从 1 开始（创建者自己）', team?.memberCount === 1, String(team?.memberCount));
  check('新团队的帖子数是 0', team?.postCount === 0, String(team?.postCount));

  const teamId = team?.id;
  const teamPath = `/api/teams/${teamId}`;
  check('团队 id 是个正整数', Number.isInteger(teamId) && teamId > 0, String(teamId));

  const detail = await owner.client.call(teamPath);
  check('团队详情返回 200', detail.status === 200);
  check('「加入方式」默认是「谁都能加入」', detail.data?.team?.joinPolicy === 'open', String(detail.data?.team?.joinPolicy));
  check(
    '详情里带回冻结的四档可见范围，一档不多一档不少',
    JSON.stringify(detail.data?.scopes?.map((item) => item.value)) === JSON.stringify(['public', 'followers', 'team', 'private']),
    JSON.stringify(detail.data?.scopes),
  );
  check('详情里带回成员名单（创建者一个）', detail.data?.members?.length === 1 && detail.data?.memberTotal === 1);

  const bySlug = await owner.client.call(`/api/teams/${team.slug}`);
  check('团队地址（slug）也能取到同一个团队', bySlug.data?.team?.id === teamId);

  const listed = await anon.call('/api/teams');
  check('未登录也能列团队（团队主页是公开的）', listed.status === 200);
  check('刚建的团队出现在列表里', (listed.data?.items ?? []).some((item) => item.id === teamId));

  const mine = await owner.client.call('/api/teams?mine=1');
  check('?mine=1 能列出我加入的团队', (mine.data?.items ?? []).some((item) => item.id === teamId));
  const anonMine = await anon.call('/api/teams?mine=1');
  check('未登录用 ?mine=1 返回 401 而不是空列表', anonMine.status === 401, String(anonMine.status));

  const dupSlug = await owner.client.call('/api/teams', {
    method: 'POST',
    body: { name: '另一个团队', slug: team.slug },
  });
  check('团队地址被占用时明确报错，不偷偷改成别的', dupSlug.status === 409, JSON.stringify(dupSlug.error ?? dupSlug.status));

  const badScope = await owner.client.call(`${teamPath}/posts`, {
    method: 'POST',
    body: { title: '第五档', content: '不存在这种可见范围。', scope: 'friends' },
  });
  check('第五档可见范围被拒（枚举是冻结的）', badScope.status === 400 && badScope.error?.code === 'bad_scope', JSON.stringify(badScope.error));

  /* ── 验收②：能发帖、能看帖 ─────────────────────────────────────── */
  const notMember = await outsider.client.call(`${teamPath}/posts`, {
    method: 'POST',
    body: { title: '我不是成员', content: '不该发得出去。' },
  });
  check('验收②：不是团队成员发帖被拒 403', notMember.status === 403, String(notMember.status));

  const first = await owner.client.call(`${teamPath}/posts`, {
    method: 'POST',
    body: { title: '第一次会议', content: '时间定在周五晚上。', scope: 'team' },
  });
  check('验收②：团队成员能发帖', first.status === 200, JSON.stringify(first.error ?? first.body));
  const postId = first.data?.post?.id;
  check('帖子从第 1 版开始', first.data?.post?.version === 1, String(first.data?.post?.version));
  check('默认可见范围是「仅团队」', first.data?.post?.scope === 'team', String(first.data?.post?.scope));
  check('帖子带回作者的账号名', first.data?.post?.author?.username === 'teamowner');

  const readBack = await owner.client.call(`${teamPath}/posts/${postId}`);
  check('验收②：作者能读回自己的帖子', readBack.status === 200 && readBack.data?.post?.title === '第一次会议');
  check('读回来的正文是原文', readBack.data?.post?.content === '时间定在周五晚上。');
  check('帖子带 contentHtml（服务端渲染，前端不自己拼 Markdown）', typeof readBack.data?.post?.contentHtml === 'string' && readBack.data.post.contentHtml.length > 0);

  const ownerList = await owner.client.call(`${teamPath}/posts`);
  check('团队成员在列表里能看到这条帖', (ownerList.data?.items ?? []).some((item) => item.id === postId));
  check('列表带回我在这支团队里的角色', ownerList.data?.myRole === 'owner', String(ownerList.data?.myRole));

  /* ── 验收③⑥：非成员 404、未登录 401 ───────────────────────────── */
  const outsiderRead = await outsider.client.call(`${teamPath}/posts/${postId}`);
  check('验收③：非团队成员读团队帖返回 404（不能被猜出来存在）', outsiderRead.status === 404, String(outsiderRead.status));
  check('验收③：404 的错误代号是 team_post_not_found', outsiderRead.error?.code === 'team_post_not_found', String(outsiderRead.error?.code));

  const anonRead = await anon.call(`${teamPath}/posts/${postId}`);
  check('验收⑥：未登录读「仅团队」的帖子返回 401 而不是 404', anonRead.status === 401, String(anonRead.status));
  check('验收⑥：401 的错误代号是 unauthenticated', anonRead.error?.code === 'unauthenticated', String(anonRead.error?.code));

  const outsiderList = await outsider.client.call(`${teamPath}/posts`);
  check('非成员的列表里看不到「仅团队」的帖子', !(outsiderList.data?.items ?? []).some((item) => item.id === postId));
  const anonList = await anon.call(`${teamPath}/posts`);
  check('未登录的列表里也看不到「仅团队」的帖子', anonList.status === 200 && (anonList.data?.items ?? []).length === 0, JSON.stringify(anonList.data?.total));

  const anonPost = await anon.call(`${teamPath}/posts`, { method: 'POST', body: { title: '未登录', content: '不该发得出去。' } });
  check('验收⑥：未登录发帖返回 401', anonPost.status === 401, String(anonPost.status));
  const outsiderTeam = await outsider.client.call(teamPath);
  check('非成员仍然能打开团队主页（主页本身是公开的）', outsiderTeam.status === 200);
  check('非成员的 myRole 是 null', outsiderTeam.data?.team?.myRole === null, String(outsiderTeam.data?.team?.myRole));

  /* ── 加入团队 ───────────────────────────────────────────────────── */
  const joined = await outsider.client.call(`${teamPath}/join`, { method: 'POST' });
  check('开放团队可以直接加入', joined.status === 200, JSON.stringify(joined.error ?? joined.body));
  check('加入之后 myRole 是 member', joined.data?.team?.myRole === 'member', String(joined.data?.team?.myRole));
  check('加入之后成员数变成 2', joined.data?.team?.memberCount === 2, String(joined.data?.team?.memberCount));

  const joinedAgain = await outsider.client.call(`${teamPath}/join`, { method: 'POST' });
  check('重复加入是幂等的（不会报错、也不会多一个人）', joinedAgain.status === 200 && joinedAgain.data?.team?.memberCount === 2);

  const nowReadable = await outsider.client.call(`${teamPath}/posts/${postId}`);
  check('加入之后就能读到同一条帖子了', nowReadable.status === 200, String(nowReadable.status));

  const matePost = await mate.client.call(`${teamPath}/posts`, {
    method: 'POST',
    body: { title: '还没加入', content: '不是成员发不出去。' },
  });
  check('没加入的人仍然发不了帖', matePost.status === 403, String(matePost.status));
  await mate.client.call(`${teamPath}/join`, { method: 'POST' });
  const mateOk = await mate.client.call(`${teamPath}/posts`, {
    method: 'POST',
    body: { title: '成员也能发', content: '加入之后就可以了。' },
  });
  check('加入之后成员就能发帖', mateOk.status === 200, JSON.stringify(mateOk.error ?? mateOk.body));

  /* ── 验收⑤：不互相覆盖（版本号 + 冲突提示） ───────────────────── */
  const stale = await owner.client.call(`${teamPath}/posts/${postId}`);
  const seenVersion = stale.data?.post?.version;
  const goodSave = await owner.client.call(`${teamPath}/posts/${postId}`, {
    method: 'PUT',
    body: { content: '时间改成周六晚上。', version: seenVersion },
  });
  check('验收⑤：带着正确版本号保存成功', goodSave.status === 200, JSON.stringify(goodSave.error ?? goodSave.body));
  check('保存之后版本号加一', goodSave.data?.post?.version === seenVersion + 1, `${seenVersion} → ${goodSave.data?.post?.version}`);

  const conflict = await outsider.client.call(`${teamPath}/posts/${postId}`, {
    method: 'PUT',
    body: { content: '我也改了，但我手上是旧版本。', version: seenVersion },
  });
  check('验收⑤：拿旧版本保存返回 409 冲突', conflict.status === 409, String(conflict.status));
  check('验收⑤：冲突的错误代号是 conflict', conflict.error?.code === 'conflict', String(conflict.error?.code));
  check(
    '验收⑤：冲突提示里说清了「你看的是第几版、现在是第几版」',
    typeof conflict.error?.message === 'string' &&
      conflict.error.message.includes(`第 ${seenVersion} 版`) &&
      conflict.error.message.includes(`第 ${seenVersion + 1} 版`),
    String(conflict.error?.message),
  );

  const stillOld = await outsider.client.call(`${teamPath}/posts/${postId}`);
  check('冲突被拒之后正文没有被改掉', stillOld.data?.post?.content === '时间改成周六晚上。', String(stillOld.data?.post?.content));

  const forced = await outsider.client.call(`${teamPath}/posts/${postId}`, {
    method: 'PUT',
    body: { content: '我坚持我的版本。', version: seenVersion, force: true },
  });
  check('验收⑤：用户明确选「仍然保存我的」之后能覆盖', forced.status === 200, JSON.stringify(forced.error ?? forced.body));
  check('强制保存之后版本号继续往上走', forced.data?.post?.version === seenVersion + 2, String(forced.data?.post?.version));
  check('强制保存之后正文换成了新的', forced.data?.post?.content === '我坚持我的版本。');

  const noVersion = await outsider.client.call(`${teamPath}/posts/${postId}`, {
    method: 'PUT',
    body: { content: '不带版本号的老客户端。' },
  });
  check('没带版本号时不比对版本（老客户端的兼容路径）', noVersion.status === 200, JSON.stringify(noVersion.error ?? noVersion.body));

  const beforeMate = (await owner.client.call(`${teamPath}/posts/${postId}`)).data?.post?.version;
  const mateEdit = await outsider.client.call(`${teamPath}/posts/${postId}`, {
    method: 'PUT',
    body: { content: '同队成员也能改这条帖子。' },
  });
  check('验收⑤：同队成员可以一起编辑同一条帖子', mateEdit.status === 200, JSON.stringify(mateEdit.error ?? mateEdit.body));
  check('一起编辑同样会把版本号往上推', mateEdit.data?.post?.version === beforeMate + 1, `${beforeMate} → ${mateEdit.data?.post?.version}`);

  const strangerEdit = await stranger.client.call(`${teamPath}/posts/${postId}`, {
    method: 'PUT',
    body: { content: '不是成员也想改。' },
  });
  check('不是团队成员改不了（404 —— 他连这篇帖都看不见）', strangerEdit.status === 404, String(strangerEdit.status));

  /* ── 四档可见范围 ───────────────────────────────────────────────── */
  const followPost = await owner.client.call(`${teamPath}/posts`, {
    method: 'POST',
    body: { title: '只给关注我的人看', content: '粉丝专属。', scope: 'followers' },
  });
  const followId = followPost.data?.post?.id;
  check('能发一条「仅关注我的人」的帖子', followPost.status === 200 && followPost.data?.post?.scope === 'followers');
  const strangerRead = await stranger.client.call(`${teamPath}/posts/${followId}`);
  check('没关注的人看不到「仅关注我的人」的帖子（404）', strangerRead.status === 404, String(strangerRead.status));
  await fan.client.call(`/api/users/${owner.user.id}/follow`, { method: 'POST' });
  const fanRead = await fan.client.call(`${teamPath}/posts/${followId}`);
  check('关注之后就能看到「仅关注我的人」的帖子', fanRead.status === 200, String(fanRead.status));

  const privatePost = await owner.client.call(`${teamPath}/posts`, {
    method: 'POST',
    body: { title: '只有我自己', content: '草稿。', scope: 'private' },
  });
  const privateId = privatePost.data?.post?.id;
  check('能发一条「仅自己」的帖子', privatePost.status === 200 && privatePost.data?.post?.scope === 'private');
  const memberReadPrivate = await outsider.client.call(`${teamPath}/posts/${privateId}`);
  check('「仅自己」对同队成员也不可见（404）', memberReadPrivate.status === 404, String(memberReadPrivate.status));
  const ownerReadPrivate = await owner.client.call(`${teamPath}/posts/${privateId}`);
  check('「仅自己」对作者本人可见', ownerReadPrivate.status === 200, String(ownerReadPrivate.status));
  const memberEditPrivate = await outsider.client.call(`${teamPath}/posts/${privateId}`, {
    method: 'PUT',
    body: { content: '同队成员想改别人标了「仅自己」的草稿。' },
  });
  check('同队成员也改不了自己看不见的帖子（404）', memberEditPrivate.status === 404, String(memberEditPrivate.status));

  const publicPost = await owner.client.call(`${teamPath}/posts`, {
    method: 'POST',
    body: { title: '公开的公告', content: '谁都能看。', scope: 'public' },
  });
  const publicId = publicPost.data?.post?.id;
  const anonReadPublic = await anon.call(`${teamPath}/posts/${publicId}`);
  check('「公开」的帖子未登录也能读', anonReadPublic.status === 200, String(anonReadPublic.status));
  const strangerReadPublic = await stranger.client.call(`${teamPath}/posts/${publicId}`);
  check('「公开」的帖子非成员也能读', strangerReadPublic.status === 200, String(strangerReadPublic.status));
  const anonListNow = await anon.call(`${teamPath}/posts`);
  check(
    '未登录的列表里只剩「公开」那一条',
    (anonListNow.data?.items ?? []).length === 1 && anonListNow.data.items[0].id === publicId,
    JSON.stringify((anonListNow.data?.items ?? []).map((item) => item.id)),
  );

  /* ── 需要邀请的团队 ─────────────────────────────────────────────── */
  const inviteTeam = await owner.client.call('/api/teams', {
    method: 'POST',
    body: { name: 'closed-squad', intro: '需要邀请', joinPolicy: 'invite' },
  });
  const inviteId = inviteTeam.data?.team?.id;
  check('能建一个「需要邀请」的团队', inviteTeam.status === 200 && inviteTeam.data?.team?.joinPolicy === 'invite');
  const invitePath = `/api/teams/${inviteId}`;

  const tryJoin = await stranger.client.call(`${invitePath}/join`, { method: 'POST' });
  check('需要邀请的团队不能自己加入（403）', tryJoin.status === 403, String(tryJoin.status));

  const invited = await owner.client.call(`${invitePath}/members`, {
    method: 'POST',
    body: { username: 'teamstranger' },
  });
  check('管理员能把人拉进团队', invited.status === 200, JSON.stringify(invited.error ?? invited.body));
  check('拉进来的默认角色是「成员」', invited.data?.member?.teamRole === 'member', String(invited.data?.member?.teamRole));
  const inviteList = await owner.client.call(`${invitePath}/posts`);
  check('拉进来之后成员数变成 2', inviteList.status === 200 && (await owner.client.call(`${invitePath}/members`)).data?.total === 2);

  const notManager = await stranger.client.call(`${invitePath}/members`, {
    method: 'POST',
    body: { username: 'teamfan' },
  });
  check('普通成员拉不了人（403）', notManager.status === 403, String(notManager.status));

  const noUser = await owner.client.call(`${invitePath}/members`, {
    method: 'POST',
    body: { username: '根本没有这个人' },
  });
  check('拉一个不存在的用户返回 404', noUser.status === 404 && noUser.error?.code === 'user_not_found', String(noUser.status));

  /* ── 角色与团队设置 ─────────────────────────────────────────────── */
  const promote = await owner.client.call(`${invitePath}/members/${stranger.user.id}`, {
    method: 'PUT',
    body: { role: 'admin' },
  });
  check('创建者能把成员提成管理员', promote.status === 200 && promote.data?.member?.teamRole === 'admin', JSON.stringify(promote.error ?? promote.body));

  const promotedInvite = await stranger.client.call(`${invitePath}/members`, {
    method: 'POST',
    body: { username: 'teamfan' },
  });
  check('提成管理员之后就能拉人了', promotedInvite.status === 200, JSON.stringify(promotedInvite.error ?? promotedInvite.body));

  const promoteToOwner = await owner.client.call(`${invitePath}/members/${stranger.user.id}`, {
    method: 'PUT',
    body: { role: 'owner' },
  });
  check('不允许把别人也设成创建者', promoteToOwner.status === 400, String(promoteToOwner.status));

  const demote = await owner.client.call(`${invitePath}/members/${stranger.user.id}`, {
    method: 'PUT',
    body: { role: 'member' },
  });
  check('创建者能把管理员降回成员', demote.status === 200 && demote.data?.member?.teamRole === 'member');

  const byStranger = await stranger.client.call(invitePath, {
    method: 'PUT',
    body: { name: '普通成员改的队名' },
  });
  check('普通成员改不了团队设置（403）', byStranger.status === 403, String(byStranger.status));

  const renamed = await owner.client.call(invitePath, { method: 'PUT', body: { name: '改过名的团队' } });
  check('创建者能改团队设置', renamed.status === 200 && renamed.data?.team?.name === '改过名的团队', JSON.stringify(renamed.error ?? renamed.body));

  const ownerLeave = await owner.client.call(`${invitePath}/leave`, { method: 'POST' });
  check('创建者不能退出自己的团队（400）', ownerLeave.status === 400, String(ownerLeave.status));

  const kicked = await owner.client.call(`${invitePath}/members/${stranger.user.id}`, { method: 'DELETE' });
  check('管理员能把成员移出团队', kicked.status === 200, JSON.stringify(kicked.error ?? kicked.body));
  const kickOwner = await owner.client.call(`${invitePath}/members/${owner.user.id}`, { method: 'DELETE' });
  check('不能把创建者移出团队（400）', kickOwner.status === 400, String(kickOwner.status));

  /* ── 退出与解散 ─────────────────────────────────────────────────── */
  const left = await outsider.client.call(`${teamPath}/leave`, { method: 'POST' });
  check('普通成员能自己退出团队', left.status === 200, JSON.stringify(left.error ?? left.body));
  const afterLeave = await outsider.client.call(`${teamPath}/posts/${postId}`);
  check('退出之后立刻又看不到了（404）', afterLeave.status === 404, String(afterLeave.status));

  const notOwnerDelete = await mate.client.call(teamPath, { method: 'DELETE' });
  check('不是创建者不能解散团队（403）', notOwnerDelete.status === 403, String(notOwnerDelete.status));

  const deleted = await owner.client.call(invitePath, { method: 'DELETE' });
  check('创建者能解散团队', deleted.status === 200, JSON.stringify(deleted.error ?? deleted.body));
  const gone = await owner.client.call(invitePath);
  check('解散之后团队详情返回 404', gone.status === 404, String(gone.status));
  const goneList = await anon.call('/api/teams');
  check('解散的团队不再出现在公开列表里', !(goneList.data?.items ?? []).some((item) => item.id === inviteId));

  const deletedPost = `DELETE /api/teams/${teamId}/posts/${postId}`;
  const removePost = await owner.client.call(`${teamPath}/posts/${postId}`, { method: 'DELETE' });
  check(`能删掉自己的帖子（${deletedPost}）`, removePost.status === 200, JSON.stringify(removePost.error ?? removePost.body));
  const readDeleted = await owner.client.call(`${teamPath}/posts/${postId}`);
  check('删掉的帖子返回 404', readDeleted.status === 404, String(readDeleted.status));
  const readDeletedAnon = await anon.call(`${teamPath}/posts/${postId}`);
  check('删掉的帖子对未登录也是 404（不会先报「请登录」）', readDeletedAnon.status === 404, String(readDeletedAnon.status));

  const missing = await owner.client.call('/api/teams/99999999');
  check('不存在的团队返回 404', missing.status === 404 && missing.error?.code === 'team_not_found', String(missing.status));

  await finish(failures.length === 0 ? 0 : 1);
} catch (error) {
  console.error('❌ 测试脚本自己崩了：', error);
  await finish(1);
}
