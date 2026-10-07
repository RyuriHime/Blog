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
import { copyFileSync, existsSync, mkdirSync, openSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const SERVER = join(ROOT, 'src', 'server.js');
const DB_FILE = join(ROOT, 'data', 'team-smoke.db');
const AVATAR_DIR = join(ROOT, 'data', 'team-smoke-avatars');
const NOTES_DIR = join(ROOT, 'data', 'team-smoke-notes');
/** 文件柜落盘目录。必须单独指到测试用目录，否则测试上传的文件会掉进真实 data/team-files/。 */
const TEAM_FILE_DIR = join(ROOT, 'data', 'team-smoke-files');
const LOG_FILE = join(ROOT, 'data', 'team-smoke-server.log');
const PORT = Number(process.env.TEAM_SMOKE_PORT || 3444);
const BASE = `http://127.0.0.1:${PORT}`;

/**
 * 「老库升级 / 坏库自愈」那一段用的三份临时库：
 * 底板（项目自己建的当前形状）、上一版形状、已经坏掉的形状。
 */
const SCAFFOLD_DB = join(ROOT, 'data', 'team-smoke-scaffold.db');
const LEGACY_DB = join(ROOT, 'data', 'team-smoke-legacy.db');
const BROKEN_DB = join(ROOT, 'data', 'team-smoke-broken.db');

/** 除了主服务器之外临时起的那些（那一段起三台，收尾时要一起杀掉）。 */
const extraChildren = [];

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

function createClient(base = BASE) {
  let cookie = '';
  return {
    async call(path, { method = 'GET', body, raw = false } = {}) {
      const response = await fetch(base + path, {
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
      // 文件柜的下载接口返回的是二进制，不是 { ok, data } 信封 —— 要字节就传 raw: true。
      if (raw) {
        return {
          status: response.status,
          headers: response.headers,
          buffer: Buffer.from(await response.arrayBuffer()),
        };
      }
      const json = await response.json().catch(() => null);
      return { status: response.status, body: json, data: json?.data, error: json?.error };
    },
  };
}

async function waitForServer(base = BASE, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/site`);
      if (response.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(180);
  }
  return false;
}

/**
 * 另外起一台临时服务器（自己的库 + 自己的端口）。
 *
 * 「老库升级 / 坏库自愈」那一段要拿**项目自己建的库**当底板，所以先用它起一次；
 * 也用它验「上一版形状的库」和「已经坏掉的库」启动之后是什么状态。
 */
function bootServer({ port, dbFile, logFile }) {
  const fd = openSync(logFile, 'w');
  const proc = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(port),
      DB_FILE: dbFile,
      AVATAR_DIR,
      NOTES_DIR,
      TEAM_FILE_DIR,
      QUIET: '1',
      AI_API_KEY: '',
    },
    stdio: ['ignore', fd, fd],
  });
  extraChildren.push(proc);
  return {
    base: `http://127.0.0.1:${port}`,
    ready: () => waitForServer(`http://127.0.0.1:${port}`),
    async stop() {
      try {
        proc.kill();
      } catch {
        /* 忽略 */
      }
      await sleep(400);
    },
  };
}

/** 注册一个全新账号，返回 `{client, user}`。`base` 用来指向临时起的那些服务器。 */
async function signUp(username, base = BASE) {
  const client = createClient(base);
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
    TEAM_FILE_DIR,
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
  for (const proc of extraChildren) {
    try {
      proc.kill();
    } catch {
      /* 忽略 */
    }
  }
  await sleep(400);
  for (const file of [DB_FILE, SCAFFOLD_DB, LEGACY_DB, BROKEN_DB]) {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        rmSync(file + suffix, { force: true });
      } catch {
        /* 忽略 */
      }
    }
  }
  rmSync(AVATAR_DIR, { recursive: true, force: true });
  rmSync(NOTES_DIR, { recursive: true, force: true });
  rmSync(TEAM_FILE_DIR, { recursive: true, force: true });
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
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('teams','team_members','team_posts','team_files','team_messages')",
      )
      .all()
      .map((row) => row.name)
      .sort();
    check(
      '验收①：teams / team_members / team_posts / team_files / team_messages 五张表都在库里（加入申请那轮又多了 team_replies 与 team_join_requests）',
      names.join(',') === 'team_files,team_members,team_messages,team_posts,teams',
      names.join(','),
    );
    const memberInfo = inspect.prepare('PRAGMA table_info(team_members)').all();
    const pk = memberInfo.filter((column) => Number(column.pk) > 0).map((column) => column.name).sort();
    check('team_members 的主键是 (team_id, user_id) —— 一个人在一个团队只可能有一行', pk.join(',') === 'team_id,user_id', pk.join(','));
    const postInfo = inspect.prepare('PRAGMA table_info(team_posts)').all().map((column) => column.name);
    check('team_posts 有 version 列（乐观并发的基础）', postInfo.includes('version'), postInfo.join(','));
    check('team_posts 有 scope 列', postInfo.includes('scope'));
    const fileInfo = inspect.prepare('PRAGMA table_info(team_files)').all().map((column) => column.name);
    check('team_files 有 stored_name 列（磁盘上的名字由服务端合成，跟用户给的名字分开）', fileInfo.includes('stored_name'), fileInfo.join(','));
    check('team_files 有 deleted 列（删文件是软删库 + 删盘，不是 DELETE 语句）', fileInfo.includes('deleted'));
    const messageInfo = inspect.prepare('PRAGMA table_info(team_messages)').all().map((column) => column.name);
    check('team_messages 有 content / team_id / user_id', ['content', 'team_id', 'user_id'].every((name) => messageInfo.includes(name)), messageInfo.join(','));
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

  /* 正文走的是站点共用那份 `src/markdown.js`。它只做 Markdown，**从不排公式** ——
   * `$…$` / `$$…$$` 原样留在 HTML 里，排版权归客户端的 `ntRenderMath`（离线 KaTeX）。
   * 所以这一条同时钉两件事：服务端要**渲染** Markdown，也要**别碰**公式源码
   * （一旦被转义或拆开，前端那个 auto-render 就再也配不上这对定界符，公式永远出不来）。
   * 漏掉这件事时的表现是「帖子里 $E=mc^2$ 就是一段等宽源码」，而渲染断言照样绿。 */
  const mdPost = await owner.client.call(`${teamPath}/posts`, {
    method: 'POST',
    body: {
      title: 'Markdown 与公式',
      content: '**重点**：质能方程 $E=mc^2$。\n\n$$\n\\int_0^1 x^2 dx = \\frac{1}{3}\n$$',
      scope: 'team',
    },
  });
  const mdHtml = String(mdPost.data?.post?.contentHtml ?? '');
  check('团队帖的 Markdown 真被渲染成 HTML（**重点** → <strong>重点</strong>）', mdHtml.includes('<strong>重点</strong>'), mdHtml);
  check('行内公式原样留着 $E=mc^2$（服务端排不了，交给客户端 KaTeX）', mdHtml.includes('$E=mc^2$'), mdHtml);
  check(
    '块级公式也原样留着 $$…$$，没有被拆进别的标签里',
    mdHtml.includes('$$\\int_0^1 x^2 dx = \\frac{1}{3}$$'),
    mdHtml,
  );

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

  /* ── 验收⑤：改自己的帖也不静默覆盖（版本号 + 冲突提示；换人改是 403，不是 409） ── */
  const stale = await owner.client.call(`${teamPath}/posts/${postId}`);
  const seenVersion = stale.data?.post?.version;
  const goodSave = await owner.client.call(`${teamPath}/posts/${postId}`, {
    method: 'PUT',
    body: { content: '时间改成周六晚上。', version: seenVersion },
  });
  check('验收⑤：带着正确版本号保存成功', goodSave.status === 200, JSON.stringify(goodSave.error ?? goodSave.body));
  check('保存之后版本号加一', goodSave.data?.post?.version === seenVersion + 1, `${seenVersion} → ${goodSave.data?.post?.version}`);

  // 冲突这一路得由**作者本人**制造了：现在只有作者能改自己的帖，
  // 拿一个旧版本号再存一次，等价于「同一个人的两个标签页」。
  const conflict = await owner.client.call(`${teamPath}/posts/${postId}`, {
    method: 'PUT',
    body: { content: '我在另一个标签页里也改了，但我手上是旧版本。', version: seenVersion },
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

  const stillOld = await owner.client.call(`${teamPath}/posts/${postId}`);
  check('冲突被拒之后正文没有被改掉', stillOld.data?.post?.content === '时间改成周六晚上。', String(stillOld.data?.post?.content));

  const forced = await owner.client.call(`${teamPath}/posts/${postId}`, {
    method: 'PUT',
    body: { content: '我坚持我的版本。', version: seenVersion, force: true },
  });
  check('验收⑤：用户明确选「仍然保存我的」之后能覆盖', forced.status === 200, JSON.stringify(forced.error ?? forced.body));
  check('强制保存之后版本号继续往上走', forced.data?.post?.version === seenVersion + 2, String(forced.data?.post?.version));
  check('强制保存之后正文换成了新的', forced.data?.post?.content === '我坚持我的版本。');

  const noVersion = await owner.client.call(`${teamPath}/posts/${postId}`, {
    method: 'PUT',
    body: { content: '不带版本号的老客户端。' },
  });
  check('没带版本号时不比对版本（老客户端的兼容路径）', noVersion.status === 200, JSON.stringify(noVersion.error ?? noVersion.body));

  // 编辑权只给作者本人：同队成员（哪怕是管理员）也不行 —— 想补充就回帖。
  const beforeMate = (await owner.client.call(`${teamPath}/posts/${postId}`)).data?.post?.version;
  const mateEdit = await outsider.client.call(`${teamPath}/posts/${postId}`, {
    method: 'PUT',
    body: { content: '同队成员也想改别人发的帖子。' },
  });
  check('验收⑤：同队成员改不了别人发的帖子（403）', mateEdit.status === 403, String(mateEdit.status));
  check('验收⑤：拒绝时的代号是 forbidden', mateEdit.error?.code === 'forbidden', String(mateEdit.error?.code));
  check(
    '验收⑤：拒绝时的文案说清了「只有作者本人可以编辑」',
    mateEdit.error?.message === '只有作者本人可以编辑这篇帖子',
    String(mateEdit.error?.message),
  );
  const afterMate = (await owner.client.call(`${teamPath}/posts/${postId}`)).data?.post;
  check('被拒之后版本号没动', afterMate?.version === beforeMate, `${beforeMate} → ${afterMate?.version}`);
  check('被拒之后正文也没动', afterMate?.content === '不带版本号的老客户端。', String(afterMate?.content));

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

  /* ── 需要申请的团队：递申请 → 审核 → 进 / 不进 ─────────────────── */
  const applyTeam = await owner.client.call('/api/teams', {
    method: 'POST',
    body: { name: 'closed-squad', intro: '需要申请', joinPolicy: 'apply' },
  });
  const applyId = applyTeam.data?.team?.id;
  check('能建一个「需要申请」的团队', applyTeam.status === 200 && applyTeam.data?.team?.joinPolicy === 'apply', String(applyTeam.data?.team?.joinPolicy));
  check('「需要申请」的团队，加入方式标签就是「需要申请」', applyTeam.data?.team?.joinPolicyLabel === '需要申请', String(applyTeam.data?.team?.joinPolicyLabel));
  const applyPath = `/api/teams/${applyId}`;

  const outsiderView = await stranger.client.call(applyPath);
  check(
    '「需要申请」的团队，路人看到的是「可以申请」而不是「能直接加入」',
    outsiderView.data?.team?.canApply === true && outsiderView.data?.team?.canJoin === false,
    JSON.stringify({ canApply: outsiderView.data?.team?.canApply, canJoin: outsiderView.data?.team?.canJoin }),
  );

  const applyJoin = await stranger.client.call(`${applyPath}/join`, { method: 'POST', body: { message: '想进来一起做前端。' } });
  check(
    '「需要申请」的团队点「加入」只会递上一条申请（不是直接进）',
    applyJoin.status === 200 && applyJoin.data?.requested === true && applyJoin.data?.joined === false,
    JSON.stringify(applyJoin.error ?? applyJoin.body),
  );
  check(
    '申请里带着自己写的理由，状态是「等待审核」',
    applyJoin.data?.request?.status === 'pending' && applyJoin.data?.request?.message === '想进来一起做前端。',
    JSON.stringify(applyJoin.data?.request ?? null),
  );
  const applyMembers = await owner.client.call(`${applyPath}/members`);
  check('递了申请也还没进团队（成员数不变）', applyMembers.data?.total === 1, String(applyMembers.data?.total));

  const myPendingView = await stranger.client.call(applyPath);
  check(
    '申请人自己看得到「审核中」，而且不能再点一次申请',
    myPendingView.data?.team?.myRequest?.status === 'pending' && myPendingView.data?.team?.canApply === false && myPendingView.data?.team?.canJoin === false,
    JSON.stringify(myPendingView.data?.team?.myRequest ?? null),
  );

  const applyAgain = await stranger.client.call(`${applyPath}/join`, { method: 'POST', body: { message: '再点一次' } });
  check(
    '重复点「申请加入」不会堆出第二条（还回来的就是那条待审）',
    applyAgain.status === 200 && applyAgain.data?.request?.id === applyJoin.data?.request?.id,
    JSON.stringify(applyAgain.error ?? applyAgain.body),
  );

  const applyPendingList = await owner.client.call(`${applyPath}/join-requests`);
  check('待审列表里就一条', applyPendingList.status === 200 && applyPendingList.data?.total === 1, JSON.stringify(applyPendingList.error ?? applyPendingList.body));
  check('待审那条带着申请人的用户名和理由', applyPendingList.data?.items?.[0]?.user?.username === 'teamstranger' && applyPendingList.data?.items?.[0]?.message === '想进来一起做前端。', JSON.stringify(applyPendingList.data?.items?.[0] ?? null));
  check('待审那条写着「等待审核」并且可以处理', applyPendingList.data?.items?.[0]?.statusLabel === '等待审核' && applyPendingList.data?.items?.[0]?.canDecide === true, JSON.stringify(applyPendingList.data?.items?.[0] ?? null));
  check('管理员视角里这条不是「我的申请」', applyPendingList.data?.items?.[0]?.mine === false, String(applyPendingList.data?.items?.[0]?.mine));
  check('团队详情里带着「待审几条」给管理按钮画角标', applyPendingList.data?.pendingTotal === 1, String(applyPendingList.data?.pendingTotal));

  const applyStrangerList = await stranger.client.call(`${applyPath}/join-requests`);
  check('不是管理员的人看不了审批列表（403）', applyStrangerList.status === 403, String(applyStrangerList.status));
  const applyAnonList = await anon.call(`${applyPath}/join-requests`);
  check('未登录看审批列表：401', applyAnonList.status === 401, String(applyAnonList.status));

  const applyLegacyPull = await owner.client.call(`${applyPath}/members`, { method: 'POST', body: { username: 'teamfan' } });
  check(
    '「拉进团队」那条接口已经删掉了（这个地址现在只认 GET，POST 直接 405）',
    applyLegacyPull.status === 405 || applyLegacyPull.status === 404,
    String(applyLegacyPull.status),
  );
  const afterLegacyPull = await owner.client.call(`${applyPath}/members`);
  check('拉人那条路删掉之后，管理员也不能凭空把人塞进来（成员数没变）', afterLegacyPull.data?.total === 1, String(afterLegacyPull.data?.total));

  const applyBadAction = await owner.client.call(`${applyPath}/join-requests/${applyJoin.data?.request?.id}`, { method: 'PUT', body: { action: '也许吧' } });
  check('审核只能「批准」或「拒绝」（400）', applyBadAction.status === 400 && applyBadAction.error?.code === 'bad_action', String(applyBadAction.status));

  const applyRejected = await owner.client.call(`${applyPath}/join-requests/${applyJoin.data?.request?.id}`, { method: 'PUT', body: { action: 'reject' } });
  check('管理员能拒绝申请', applyRejected.status === 200 && applyRejected.data?.request?.status === 'rejected', JSON.stringify(applyRejected.error ?? applyRejected.body));
  const applyMembersAfterReject = await owner.client.call(`${applyPath}/members`);
  check('拒绝之后人当然没进来（成员数还是 1）', applyMembersAfterReject.data?.total === 1, String(applyMembersAfterReject.data?.total));
  const applyRejectedAgain = await owner.client.call(`${applyPath}/join-requests/${applyJoin.data?.request?.id}`, { method: 'PUT', body: { action: 'reject' } });
  check('处理过的申请不能再处理一次（400）', applyRejectedAgain.status === 400 && applyRejectedAgain.error?.code === 'join_request_decided', String(applyRejectedAgain.status));

  const myRejectedView = await stranger.client.call(applyPath);
  check(
    '被拒之后申请人看到「已拒绝」，而且可以再申请一次',
    myRejectedView.data?.team?.myRequest?.status === 'rejected' && myRejectedView.data?.team?.canApply === true,
    JSON.stringify(myRejectedView.data?.team?.myRequest ?? null),
  );

  const applySecond = await stranger.client.call(`${applyPath}/join`, { method: 'POST', body: { message: '再试一次。' } });
  check(
    '被拒之后能再递一条新的申请',
    applySecond.status === 200 && applySecond.data?.request?.id !== applyJoin.data?.request?.id && applySecond.data?.request?.status === 'pending',
    JSON.stringify(applySecond.error ?? applySecond.body),
  );
  const applyAllList = await owner.client.call(`${applyPath}/join-requests?status=all`);
  check('「全部」那一档里两条都在（被拒的历史留着当记录）', applyAllList.data?.total === 2 && applyAllList.data?.pendingTotal === 1, `${applyAllList.data?.total}/${applyAllList.data?.pendingTotal}`);

  const applyWithdraw = await stranger.client.call(`${applyPath}/join-requests/${applySecond.data?.request?.id}`, { method: 'DELETE' });
  check('申请人能自己撤回申请', applyWithdraw.status === 200 && applyWithdraw.data?.removed === true, JSON.stringify(applyWithdraw.error ?? applyWithdraw.body));
  const applyPendingAfterWithdraw = await owner.client.call(`${applyPath}/join-requests`);
  check('撤回之后待审列表空了', applyPendingAfterWithdraw.data?.total === 0, String(applyPendingAfterWithdraw.data?.total));
  const applyWithdrawOther = await outsider.client.call(`${applyPath}/join-requests/${applyJoin.data?.request?.id}`, { method: 'DELETE' });
  check('既不是申请人也不是管理员的人撤不了别人的申请（403）', applyWithdrawOther.status === 403, String(applyWithdrawOther.status));

  const applyThird = await stranger.client.call(`${applyPath}/join`, { method: 'POST', body: { message: '这次一定。' } });
  const applyApproved = await owner.client.call(`${applyPath}/join-requests/${applyThird.data?.request?.id}`, { method: 'PUT', body: { action: 'approve' } });
  check(
    '管理员批准之后申请人真的成了成员',
    applyApproved.status === 200 && applyApproved.data?.request?.status === 'approved' && applyApproved.data?.member?.teamRole === 'member',
    JSON.stringify(applyApproved.error ?? applyApproved.body),
  );
  const applyMembersAfterApprove = await owner.client.call(`${applyPath}/members`);
  check('批准之后成员数变成 2', applyMembersAfterApprove.data?.total === 2, String(applyMembersAfterApprove.data?.total));
  const joinedView = await stranger.client.call(applyPath);
  check(
    '批准之后申请人视角 joined=true、不再有「可以申请」',
    joinedView.data?.team?.joined === true && joinedView.data?.team?.canApply === false,
    JSON.stringify({ joined: joinedView.data?.team?.joined, canApply: joinedView.data?.team?.canApply }),
  );

  /* ── 申请与审核都要发通知（不然另一边永远不知道） ───────────────── */
  const ownerApplyInbox = await owner.client.call('/api/notifications?filter=unread&perPage=50');
  const requestNotices = (ownerApplyInbox.data?.items ?? []).filter((item) => item.type === 'team_join_request');
  check('有人递申请，团长那边立刻有通知', requestNotices.length === 1 && requestNotices[0]?.actor?.username === 'teamstranger', `收到 ${requestNotices.length} 条：${JSON.stringify(requestNotices.map((item) => item.actor?.username))}`);
  check(
    '申请通知里带回团队，点一下能跳回团队页',
    requestNotices.every((item) => item.team?.slug === applyTeam.data?.team?.slug),
    JSON.stringify(requestNotices.map((item) => item.team ?? null)),
  );
  check(
    '同一个人反复递申请只留一条未读（申请走去重，和公告相反）',
    requestNotices.filter((item) => item.actor?.username === 'teamstranger').length === 1,
    JSON.stringify(requestNotices.map((item) => item.actor?.username)),
  );

  const strangerApplyInbox = await stranger.client.call('/api/notifications?filter=unread&perPage=50');
  const myApplyNotices = (strangerApplyInbox.data?.items ?? []).filter(
    (item) => item.type === 'team_join_approved' || item.type === 'team_join_rejected',
  );
  check(
    '申请人「被拒绝」和「被批准」两条通知都收到了',
    myApplyNotices.some((item) => item.type === 'team_join_rejected') && myApplyNotices.some((item) => item.type === 'team_join_approved'),
    JSON.stringify(myApplyNotices.map((item) => item.type)),
  );
  check(
    '审批通知里的 actor 是审批的人（创建者）',
    myApplyNotices.every((item) => item.actor?.username === 'teamowner'),
    JSON.stringify(myApplyNotices.map((item) => item.actor?.username)),
  );


  /* ── 角色与团队设置 ─────────────────────────────────────────────── */
  const promote = await owner.client.call(`${applyPath}/members/${stranger.user.id}`, {
    method: 'PUT',
    body: { role: 'admin' },
  });
  check('创建者能把成员提成管理员', promote.status === 200 && promote.data?.member?.teamRole === 'admin', JSON.stringify(promote.error ?? promote.body));

  // 管理员的权力现在是「审申请」：让 mate 递一条，由刚提上来的 stranger 批。
  const mateApply = await mate.client.call(`${applyPath}/join`, { method: 'POST', body: { message: '管理员帮忙看看我这条。' } });
  const adminDecides = await stranger.client.call(`${applyPath}/join-requests/${mateApply.data?.request?.id}`, {
    method: 'PUT',
    body: { action: 'approve' },
  });
  check(
    '提成管理员之后也能批申请（批准别人进来）',
    adminDecides.status === 200 && adminDecides.data?.request?.status === 'approved',
    JSON.stringify(adminDecides.error ?? adminDecides.body),
  );

  const adminApplyInbox = await stranger.client.call('/api/notifications?filter=unread&perPage=50');
  check(
    '申请通知是发给全体管理者的（管理员也收到，不只团长）',
    (adminApplyInbox.data?.items ?? []).some((item) => item.type === 'team_join_request' && item.actor?.username === 'teammate'),
    JSON.stringify((adminApplyInbox.data?.items ?? []).filter((item) => item.type === 'team_join_request').map((item) => item.actor?.username)),
  );
  const ownerApplyInboxTwo = await owner.client.call('/api/notifications?filter=unread&perPage=50');
  check(
    '第二个人递申请，团长那边又多一条（去重按人算，不同的人各留一条）',
    (ownerApplyInboxTwo.data?.items ?? []).filter((item) => item.type === 'team_join_request').length === 2,
    JSON.stringify((ownerApplyInboxTwo.data?.items ?? []).filter((item) => item.type === 'team_join_request').map((item) => item.actor?.username)),
  );

  const adminHides = await stranger.client.call(applyPath, { method: 'PUT', body: { listed: '0' } });
  check(
    '管理员也藏不了团队 —— 要不要出现在广场只有创建者能决定（403）',
    adminHides.status === 403 && adminHides.error?.code === 'forbidden',
    `${adminHides.status} ${JSON.stringify(adminHides.error ?? '')}`,
  );

  const promoteToOwner = await owner.client.call(`${applyPath}/members/${stranger.user.id}`, {
    method: 'PUT',
    body: { role: 'owner' },
  });
  check('不允许把别人也设成创建者', promoteToOwner.status === 400, String(promoteToOwner.status));

  const demote = await owner.client.call(`${applyPath}/members/${stranger.user.id}`, {
    method: 'PUT',
    body: { role: 'member' },
  });
  check('创建者能把管理员降回成员', demote.status === 200 && demote.data?.member?.teamRole === 'member');

  const byStranger = await stranger.client.call(applyPath, {
    method: 'PUT',
    body: { name: '普通成员改的队名' },
  });
  check('普通成员改不了团队设置（403）', byStranger.status === 403, String(byStranger.status));

  const renamed = await owner.client.call(applyPath, { method: 'PUT', body: { name: '改过名的团队' } });
  check('创建者能改团队设置', renamed.status === 200 && renamed.data?.team?.name === '改过名的团队', JSON.stringify(renamed.error ?? renamed.body));

  /* ── 要不要出现在团队广场（listed） ─────────────────────────────── */
  check('新团队默认出现在广场上', renamed.data?.team?.listed === true, String(renamed.data?.team?.listed));
  const badFlag = await owner.client.call(applyPath, { method: 'PUT', body: { listed: '也许' } });
  check('「出现在广场」只能是是或否（400）', badFlag.status === 400 && badFlag.error?.code === 'bad_flag', String(badFlag.status));

  const hidden = await owner.client.call(applyPath, { method: 'PUT', body: { listed: '0' } });
  check('创建者能把团队从广场藏起来', hidden.status === 200 && hidden.data?.team?.listed === false, JSON.stringify(hidden.error ?? hidden.body));
  const hiddenSquareAnon = await anon.call('/api/teams');
  check(
    '藏起来之后未登录的人在广场上找不到它',
    !(hiddenSquareAnon.data?.items ?? []).some((item) => item.id === applyId),
    JSON.stringify((hiddenSquareAnon.data?.items ?? []).map((item) => item.id)),
  );
  const hiddenSquareMember = await stranger.client.call('/api/teams');
  check(
    '但已加入的成员在广场上仍然看得到自己这个藏起来的团队',
    (hiddenSquareMember.data?.items ?? []).some((item) => item.id === applyId),
    JSON.stringify((hiddenSquareMember.data?.items ?? []).map((item) => item.id)),
  );
  const hiddenDetail = await anon.call(applyPath);
  check(
    '藏起来只是不在广场露面，团队主页本身照旧打得开',
    hiddenDetail.status === 200 && hiddenDetail.data?.team?.listed === false,
    String(hiddenDetail.status),
  );
  const listedBack = await owner.client.call(applyPath, { method: 'PUT', body: { listed: '1' } });
  check('也能再把它放回广场', listedBack.status === 200 && listedBack.data?.team?.listed === true, JSON.stringify(listedBack.error ?? listedBack.body));

  const ownerLeave = await owner.client.call(`${applyPath}/leave`, { method: 'POST' });
  check('创建者不能退出自己的团队（400）', ownerLeave.status === 400, String(ownerLeave.status));

  const kicked = await owner.client.call(`${applyPath}/members/${stranger.user.id}`, { method: 'DELETE' });
  check('管理员能把成员移出团队', kicked.status === 200, JSON.stringify(kicked.error ?? kicked.body));
  const kickOwner = await owner.client.call(`${applyPath}/members/${owner.user.id}`, { method: 'DELETE' });
  check('不能把创建者移出团队（400）', kickOwner.status === 400, String(kickOwner.status));

  /* ── 纯数字地址：曾经会被当成 id，查不到就报「也许它已经解散了」 ── */
  const digitTeam = await mate.client.call('/api/teams', { method: 'POST', body: { name: '2026' } });
  const digitSlug = digitTeam.data?.team?.slug;
  check('纯数字队名也能建（地址就用它本身）', digitSlug === '2026', String(digitSlug));
  const byDigitSlug = await mate.client.call('/api/teams/2026');
  check(
    '纯数字地址的团队打得开（先按 slug 查，再退化到 id —— 修复前的真 bug）',
    byDigitSlug.status === 200 && byDigitSlug.data?.team?.slug === '2026',
    `${byDigitSlug.status} ${JSON.stringify(byDigitSlug.error ?? '')}`,
  );
  const byNumericId = await owner.client.call(teamPath);
  check('按数字 id 取详情这条路依然通', byNumericId.status === 200 && byNumericId.data?.team?.id === teamId, String(byNumericId.status));

  /* ── 文件柜：只有团队成员能看 / 传 / 下 ─────────────────────────── */
  const guest = await signUp('teamguest');
  check('文件柜：新注册的路人账号当「已登录但不是成员」的对照组', guest.registered === true);

  const emptyFiles = await owner.client.call(`${teamPath}/files`);
  check('文件柜：成员能打开列表', emptyFiles.status === 200, JSON.stringify(emptyFiles.error ?? emptyFiles.body));
  check('文件柜：列表字段齐全 items / total / maxBytes', Array.isArray(emptyFiles.data?.items) && Number(emptyFiles.data?.maxBytes) > 0, JSON.stringify(emptyFiles.data ?? {}));
  const anonFiles = await anon.call(`${teamPath}/files`);
  check('文件柜：未登录 401', anonFiles.status === 401, String(anonFiles.status));
  const guestFiles = await guest.client.call(`${teamPath}/files`);
  check('文件柜：登录了但不是成员 403 not_team_member', guestFiles.status === 403 && guestFiles.error?.code === 'not_team_member', String(guestFiles.status));

  const fileBytes = Buffer.from('文件柜端到端测试\n第二行\n', 'utf8');
  const uploaded = await owner.client.call(`${teamPath}/files`, {
    method: 'POST',
    body: { name: '测试文档.txt', dataUrl: `data:text/plain;base64,${fileBytes.toString('base64')}` },
  });
  check('上传文件返回 200', uploaded.status === 200, JSON.stringify(uploaded.error ?? uploaded.body));
  const file = uploaded.data?.file;
  check('上传后拿到下载地址 /api/team-files/<id>', file?.downloadUrl === `/api/team-files/${file?.id}`, String(file?.downloadUrl));
  check('文件名原样保留（做展示用）', file?.name === '测试文档.txt', String(file?.name));
  check('文件带人话大小 sizeLabel', typeof file?.sizeLabel === 'string' && file.sizeLabel.length > 0, String(file?.sizeLabel));
  check('上传者是本人、本人有删除权', file?.canDelete === true && file?.uploader?.id === owner.user.id);
  check('接口不下发磁盘文件名 stored_name（那是内部细节）', file?.storedName === undefined && file?.stored_name === undefined);

  const memberFiles = await outsider.client.call(`${teamPath}/files`);
  const visible = (memberFiles.data?.items ?? []).find((item) => item.id === file?.id);
  check('同队成员能看到刚上传的文件', Boolean(visible));
  check('同队非上传者拿不到 canDelete（前端据此不画删除键）', visible?.canDelete === false);

  const guestUpload = await guest.client.call(`${teamPath}/files`, {
    method: 'POST',
    body: { name: '路人.txt', dataUrl: `data:text/plain;base64,${Buffer.from('x').toString('base64')}` },
  });
  check('非成员传不了文件（403）', guestUpload.status === 403, String(guestUpload.status));

  const download = await outsider.client.call(file.downloadUrl, { raw: true });
  check('成员下载回来的字节和上传的一模一样', download.status === 200 && download.buffer.equals(fileBytes), String(download.status));
  check('下载头是附件：Content-Disposition 以 attachment; 开头', String(download.headers.get('content-disposition') ?? '').startsWith('attachment;'));
  check(
    '下载一律 octet-stream + nosniff（传 .html/.svg 也不会在本站源里被渲染）',
    download.headers.get('content-type') === 'application/octet-stream' && download.headers.get('x-content-type-options') === 'nosniff',
    `${download.headers.get('content-type')} / ${download.headers.get('x-content-type-options')}`,
  );
  const guestDownload = await guest.client.call(file.downloadUrl, { raw: true });
  check(
    '非成员下载 403（跟列表/上传/删除一个口径：守的是团队里的东西，不是「这个文件存不存在」）',
    guestDownload.status === 403,
    String(guestDownload.status),
  );

  const huge = Buffer.alloc(4 * 1024 * 1024 + 1, 0x41);
  const tooBig = await owner.client.call(`${teamPath}/files`, {
    method: 'POST',
    body: { name: '太大了.bin', dataUrl: `data:application/octet-stream;base64,${huge.toString('base64')}` },
  });
  check('超过 4 MB 被拒：400 file_too_large', tooBig.status === 400 && tooBig.error?.code === 'file_too_large', `${tooBig.status} ${tooBig.error?.code}`);

  const evilName = await owner.client.call(`${teamPath}/files`, {
    method: 'POST',
    body: { name: '../../etc/passwd', dataUrl: `data:text/plain;base64,${Buffer.from('nope').toString('base64')}` },
  });
  check('文件名里的路径被削平，只留最后一段', evilName.data?.file?.name === 'passwd', String(evilName.data?.file?.name));

  const guestDelete = await guest.client.call(`${teamPath}/files/${file.id}`, { method: 'DELETE' });
  check('非成员删不了文件（403）', guestDelete.status === 403, String(guestDelete.status));
  const memberDelete = await outsider.client.call(`${teamPath}/files/${file.id}`, { method: 'DELETE' });
  check('同队普通成员删不了别人传的文件（403）', memberDelete.status === 403, String(memberDelete.status));
  const diskBefore = readdirSync(TEAM_FILE_DIR).length;
  const ownerDelete = await owner.client.call(`${teamPath}/files/${file.id}`, { method: 'DELETE' });
  check('创建者能删任意文件', ownerDelete.status === 200, JSON.stringify(ownerDelete.error ?? ownerDelete.body));
  check('删文件之后磁盘上也真的清了（不是只软删库）', readdirSync(TEAM_FILE_DIR).length === diskBefore - 1, `${diskBefore} → ${readdirSync(TEAM_FILE_DIR).length}`);
  const afterDelete = await owner.client.call(file.downloadUrl, { raw: true });
  check('删掉之后下载 404', afterDelete.status === 404, String(afterDelete.status));
  const repeatDelete = await owner.client.call(`${teamPath}/files/${file.id}`, { method: 'DELETE' });
  check('重复删同一个文件 404', repeatDelete.status === 404, String(repeatDelete.status));

  /* ── 团队群聊 ─────────────────────────────────────────────────── */
  const anonChat = await anon.call(`${teamPath}/messages`);
  check('群聊：未登录 401', anonChat.status === 401, String(anonChat.status));
  const guestChat = await guest.client.call(`${teamPath}/messages`);
  check('群聊：登录了但不是成员 403', guestChat.status === 403, String(guestChat.status));

  const firstMessage = await owner.client.call(`${teamPath}/messages`, { method: 'POST', body: { content: '大家好，这是第一条。' } });
  check('成员能发消息', firstMessage.status === 200 && firstMessage.data?.message?.content === '大家好，这是第一条。', JSON.stringify(firstMessage.error ?? firstMessage.body));
  check('消息带作者与 canDelete（自己发的）', firstMessage.data?.message?.author?.id === owner.user.id && firstMessage.data?.message?.canDelete === true);
  const secondMessage = await outsider.client.call(`${teamPath}/messages`, { method: 'POST', body: { content: '收到。' } });
  check('另一个成员也能发', secondMessage.status === 200, String(secondMessage.status));

  const chatList = await owner.client.call(`${teamPath}/messages`);
  const messages = chatList.data?.items ?? [];
  check('列表按时间正序回来（聊天记录得从旧到新读）', messages.length === 2 && messages[0].content === '大家好，这是第一条。' && messages[1].content === '收到。', JSON.stringify(messages.map((item) => item.content)));
  check('列表给出 latestId（前端轮询的游标）', chatList.data?.latestId === messages[1]?.id, `${chatList.data?.latestId} vs ${messages[1]?.id}`);
  const pollAfterFirst = await owner.client.call(`${teamPath}/messages?after=${messages[0]?.id}`);
  check('after=<第一条> 只返回它后面的那条（增量轮询）', (pollAfterFirst.data?.items ?? []).length === 1 && pollAfterFirst.data.items[0].id === messages[1]?.id);
  const pollAfterLast = await owner.client.call(`${teamPath}/messages?after=${chatList.data?.latestId}`);
  check('after=<最新> 返回空（没有新消息）', (pollAfterLast.data?.items ?? []).length === 0);

  const longMessage = await owner.client.call(`${teamPath}/messages`, { method: 'POST', body: { content: '啊'.repeat(1001) } });
  check('超过 1000 字的消息被拒（400）', longMessage.status === 400, String(longMessage.status));
  const blankMessage = await owner.client.call(`${teamPath}/messages`, { method: 'POST', body: { content: '   ' } });
  check('空白消息被拒（400）', blankMessage.status === 400, String(blankMessage.status));

  const deleteOthers = await outsider.client.call(`${teamPath}/messages/${firstMessage.data?.message?.id}`, { method: 'DELETE' });
  check('普通成员删不了别人发的消息（403）', deleteOthers.status === 403, String(deleteOthers.status));
  const deleteOwn = await outsider.client.call(`${teamPath}/messages/${secondMessage.data?.message?.id}`, { method: 'DELETE' });
  check('本人能删自己发的消息', deleteOwn.status === 200, JSON.stringify(deleteOwn.error ?? deleteOwn.body));
  const deleteByOwner = await owner.client.call(`${teamPath}/messages/${firstMessage.data?.message?.id}`, { method: 'DELETE' });
  check('创建者能删别人发的消息（团队空间的清理权）', deleteByOwner.status === 200, String(deleteByOwner.status));
  const chatAfter = await owner.client.call(`${teamPath}/messages`);
  check('删完之后列表里就不剩了', (chatAfter.data?.items ?? []).length === 0 && chatAfter.data?.total === 0, JSON.stringify(chatAfter.data ?? {}));
  const missingMessage = await owner.client.call(`${teamPath}/messages/99999999`, { method: 'DELETE' });
  check('删一条不存在的消息 404 team_message_not_found', missingMessage.status === 404 && missingMessage.error?.code === 'team_message_not_found', String(missingMessage.status));

  /* ── 团队号：凭号加入（老库补列 + 回填也要在真库路径上验一遍） ──── */
  try {
    const inspect = new DatabaseSync(DB_FILE, { readOnly: true });
    const teamCols = inspect.prepare('PRAGMA table_info(teams)').all().map((column) => column.name);
    check(
      'teams 表添了 join_code / announcement / announcement_by / announcement_at 四列',
      ['join_code', 'announcement', 'announcement_by', 'announcement_at'].every((name) => teamCols.includes(name)),
      teamCols.join(','),
    );
    const indexes = inspect
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'teams'")
      .all()
      .map((row) => row.name);
    check('团队号建了唯一索引（部分索引：空串不参与，老行才能先补列后补号）', indexes.includes('idx_teams_join_code'), indexes.join(','));
    const notifCols = inspect.prepare('PRAGMA table_info(notifications)').all().map((column) => column.name);
    check('notifications 表添了 team_id —— 通知能指回是哪个团队发的公告', notifCols.includes('team_id'), notifCols.join(','));
    const codes = inspect
      .prepare('SELECT join_code FROM teams WHERE deleted = 0')
      .all()
      .map((row) => row.join_code);
    check(
      '每个没解散的团队都有 6 位团队号，而且互不重复',
      codes.length > 0 && codes.every((code) => /^[0-9A-Z]{6}$/.test(code)) && new Set(codes).size === codes.length,
      codes.join(','),
    );
    inspect.close();
  } catch (error) {
    check('能读到团队号相关的表结构', false, error.message);
  }

  const ownerDetail = await owner.client.call(teamPath);
  const joinCode = ownerDetail.data?.team?.joinCode;
  check('团队成员能拿到团队号（6 位，字母加数字）', typeof joinCode === 'string' && /^[0-9A-Z]{6}$/.test(joinCode), String(joinCode));
  check('团队号里没有 I / L / O / U —— 念错听错抄错都从这几个字符来', /^[0-9A-HJKMNP-TV-Z]{6}$/.test(String(joinCode)), String(joinCode));
  check('团队号只给成员看：登录了但不是成员拿到 null', (await stranger.client.call(teamPath)).data?.team?.joinCode === null);
  check('团队号只给成员看：未登录拿到的也是 null', (await anon.call(teamPath)).data?.team?.joinCode === null);

  const shortCode = await guest.client.call('/api/teams/join-by-code', { method: 'POST', body: { code: 'abc' } });
  check('团队号位数不对：400 bad_join_code', shortCode.status === 400 && shortCode.error?.code === 'bad_join_code', `${shortCode.status} ${shortCode.error?.code}`);
  const emptyCode = await guest.client.call('/api/teams/join-by-code', { method: 'POST', body: {} });
  check('不带团队号：400（不是 500）', emptyCode.status === 400, String(emptyCode.status));
  const unknownCode = await guest.client.call('/api/teams/join-by-code', { method: 'POST', body: { code: 'ZZZZZZ' } });
  check('抄错团队号：404 team_not_found', unknownCode.status === 404 && unknownCode.error?.code === 'team_not_found', `${unknownCode.status} ${unknownCode.error?.code}`);
  const anonByCode = await anon.call('/api/teams/join-by-code', { method: 'POST', body: { code: joinCode } });
  check('未登录凭号加入：401', anonByCode.status === 401, String(anonByCode.status));

  // 抄号的人不讲究大小写、还可能顺手加个短横线：这些都该能进（服务端统一折叠）。
  const messyCode = ` ${joinCode.slice(0, 3).toLowerCase()}-${joinCode.slice(3).toLowerCase()} `;
  const byCode = await guest.client.call('/api/teams/join-by-code', { method: 'POST', body: { code: messyCode } });
  check('凭团队号加入：大小写和短横线都不讲究', byCode.status === 200 && byCode.data?.team?.id === teamId, `${byCode.status} ${JSON.stringify(byCode.error ?? '')}`);
  check('凭号加入之后角色是「成员」', byCode.data?.team?.myRole === 'member', String(byCode.data?.team?.myRole));
  check('凭号加入之后就能看到团队号了', byCode.data?.team?.joinCode === joinCode, String(byCode.data?.team?.joinCode));
  const byCodeAgain = await guest.client.call('/api/teams/join-by-code', { method: 'POST', body: { code: joinCode } });
  check(
    '重复凭号加入是幂等的（不报错也不多一个人）',
    byCodeAgain.status === 200 && byCodeAgain.data?.team?.memberCount === byCode.data?.team?.memberCount,
    `${byCodeAgain.data?.team?.memberCount}`,
  );

  // 团队号是「需要申请」那个团队的另一条入口：数字对得上就直接进，完全不看 join_policy。
  const closedDetail = await owner.client.call(applyPath);
  const closedCode = closedDetail.data?.team?.joinCode;
  check('「需要申请」的团队一样有团队号', typeof closedCode === 'string' && closedCode.length === 6, String(closedCode));
  const directJoinClosed = await guest.client.call(`${applyPath}/join`, { method: 'POST', body: { message: '路过想进。' } });
  check(
    '需要申请的团队，点「加入」只是递申请（200 requested，人没进去）',
    directJoinClosed.status === 200 && directJoinClosed.data?.requested === true && directJoinClosed.data?.joined === false,
    JSON.stringify(directJoinClosed.error ?? directJoinClosed.body),
  );
  const guestByCode = await guest.client.call('/api/teams/join-by-code', { method: 'POST', body: { code: closedCode } });
  check(
    '但拿团队号就直接进了 —— 号本身就是那个「邀请」，不看申请那一档',
    guestByCode.status === 200 && guestByCode.data?.team?.joined === true,
    `${guestByCode.status} ${JSON.stringify(guestByCode.error ?? '')}`,
  );

  /* ── 团队公告：谁能看、谁能写、谁能收到通知 ─────────────────────── */
  const beforeNotice = await owner.client.call(teamPath);
  check('还没写过公告时 announcement 是 null', beforeNotice.data?.team?.announcement === null, JSON.stringify(beforeNotice.data?.team?.announcement ?? null));
  check('公告只给成员看：登录了但不是成员拿到 null', (await stranger.client.call(teamPath)).data?.team?.announcement === null);
  check('公告只给成员看：未登录也拿不到', (await anon.call(teamPath)).data?.team?.announcement === null);

  const memberWrites = await mate.client.call(`${teamPath}/announcement`, { method: 'PUT', body: { announcement: '普通成员写的公告' } });
  check('普通成员写公告被拒 403', memberWrites.status === 403, String(memberWrites.status));
  const strangerWrites = await stranger.client.call(`${teamPath}/announcement`, { method: 'PUT', body: { announcement: '路人写的公告' } });
  check('非成员写公告被拒 403', strangerWrites.status === 403, String(strangerWrites.status));
  const anonWrites = await anon.call(`${teamPath}/announcement`, { method: 'PUT', body: { announcement: '未登录写的公告' } });
  check('未登录写公告：401', anonWrites.status === 401, String(anonWrites.status));
  const tooLongNotice = await owner.client.call(`${teamPath}/announcement`, { method: 'PUT', body: { announcement: '啊'.repeat(2001) } });
  check('公告超过 2000 字被拒 400', tooLongNotice.status === 400, String(tooLongNotice.status));

  const memberTotalNow = beforeNotice.data?.memberTotal ?? 0;
  const noticeText = '本周五 20:00 例会，主题是「团队号与公告」。';
  const written = await owner.client.call(`${teamPath}/announcement`, { method: 'PUT', body: { announcement: noticeText } });
  check('创建者能写公告，正文原样回来', written.status === 200 && written.data?.team?.announcement?.text === noticeText, JSON.stringify(written.error ?? written.body));
  check(
    '公告带作者与时间（前端要显示「谁写的、什么时候改的」）',
    written.data?.team?.announcement?.author?.username === 'teamowner' && Number(written.data?.team?.announcement?.editedAt) > 0,
    JSON.stringify(written.data?.team?.announcement ?? null),
  );
  check('写公告的人自己不算收件人（notified = 成员数 − 1）', written.data?.notified === memberTotalNow - 1, `${written.data?.notified} vs ${memberTotalNow - 1}`);

  const inbox = await mate.client.call('/api/notifications?filter=unread&perPage=50');
  const notices = (inbox.data?.items ?? []).filter((item) => item.type === 'team_announcement');
  check('成员收到了团队公告通知', notices.length === 1, `收到 ${notices.length} 条`);
  check('通知里带回团队（点一下能跳回团队页）', notices[0]?.team?.slug === team.slug && notices[0]?.team?.name === '测试小队', JSON.stringify(notices[0]?.team ?? null));
  check('通知摘要里有公告正文的开头', String(notices[0]?.excerpt ?? '').includes('本周五 20:00 例会'), String(notices[0]?.excerpt));
  check('通知里的 actor 是写公告的那个人', notices[0]?.actor?.username === 'teamowner', String(notices[0]?.actor?.username));
  const writerInbox = await owner.client.call('/api/notifications?filter=unread&perPage=50');
  check('写公告的人自己不会收到这条通知', !(writerInbox.data?.items ?? []).some((item) => item.type === 'team_announcement'));

  const rewritten = await owner.client.call(`${teamPath}/announcement`, { method: 'PUT', body: { announcement: '改期到周六晚上了。' } });
  check('公告可以改第二次', rewritten.status === 200 && rewritten.data?.team?.announcement?.text === '改期到周六晚上了。', JSON.stringify(rewritten.error ?? rewritten.body));
  const inboxAgain = await mate.client.call('/api/notifications?filter=unread&perPage=50');
  check(
    '两条公告 = 两条未读（公告不做未读合并，改一次就要响一次）',
    (inboxAgain.data?.items ?? []).filter((item) => item.type === 'team_announcement').length === 2,
    JSON.stringify((inboxAgain.data?.items ?? []).filter((item) => item.type === 'team_announcement').length),
  );

  const cleared = await owner.client.call(`${teamPath}/announcement`, { method: 'PUT', body: { announcement: '' } });
  check('清空公告：announcement 回到 null', cleared.status === 200 && cleared.data?.team?.announcement === null, JSON.stringify(cleared.data?.team?.announcement ?? null));
  check('清空公告不发通知（没有正文可看）', cleared.data?.notified === 0, String(cleared.data?.notified));
  const inboxCleared = await mate.client.call('/api/notifications?filter=unread&perPage=50');
  check(
    '清空之后也没有多出来的通知',
    (inboxCleared.data?.items ?? []).filter((item) => item.type === 'team_announcement').length === 2,
    String((inboxCleared.data?.items ?? []).filter((item) => item.type === 'team_announcement').length),
  );

  // 管理员和创建者一个权力口径：都能写公告（改角色只有创建者能做）。
  const promoteMate = await owner.client.call(`${teamPath}/members/${mate.user.id}`, { method: 'PUT', body: { role: 'admin' } });
  check('创建者把成员提成管理员', promoteMate.status === 200 && promoteMate.data?.member?.teamRole === 'admin', JSON.stringify(promoteMate.error ?? promoteMate.body));
  const adminWrites = await mate.client.call(`${teamPath}/announcement`, { method: 'PUT', body: { announcement: '管理员也能发公告。' } });
  check(
    '管理员也能写公告（作者记成管理员自己）',
    adminWrites.status === 200 && adminWrites.data?.team?.announcement?.author?.username === 'teammate',
    JSON.stringify(adminWrites.error ?? adminWrites.body),
  );
  const ownerInbox = await owner.client.call('/api/notifications?filter=unread&perPage=50');
  check(
    '管理员写公告，创建者同样收到通知',
    (ownerInbox.data?.items ?? []).some((item) => item.type === 'team_announcement' && item.actor?.username === 'teammate'),
    JSON.stringify((ownerInbox.data?.items ?? []).map((item) => item.type)),
  );

  // 但「改别人的帖子」不在管理员那条口径里：编辑权只归作者本人，
  // 管理员想补充也得回帖（这也是它跟「删除」的分界线 —— 删帖仍然是作者或管理员）。
  const adminEditSomeonePost = await mate.client.call(`${teamPath}/posts/${postId}`, {
    method: 'PUT',
    body: { content: '管理员也想改创建者发的那篇帖。' },
  });
  check('管理员也改不了别人发的帖子（403）', adminEditSomeonePost.status === 403, String(adminEditSomeonePost.status));
  check(
    '管理员被拒时的文案同样是「只有作者本人可以编辑」',
    adminEditSomeonePost.error?.message === '只有作者本人可以编辑这篇帖子',
    String(adminEditSomeonePost.error?.message),
  );

  /* ── 帖子下面的回复：发得出、看得见、删得掉，以及谁都别越权 ─────── */
  // 这里的 `post` 是 teamowner 发的那篇「仅团队」的帖子（scope='team'），
  // 所以它正好能同时验两件事：成员读得到，路人与未登录读不到。
  const repliesPath = `${teamPath}/posts/${postId}/replies`;

  const emptyReplies = await owner.client.call(repliesPath);
  check('还没人回复时列表是空的', emptyReplies.status === 200 && (emptyReplies.data?.items ?? []).length === 0, JSON.stringify(emptyReplies.error ?? emptyReplies.data));
  check(
    '空列表也把分页壳给全（page/perPage/total/totalPages）',
    emptyReplies.data?.page === 1 && emptyReplies.data?.total === 0 && emptyReplies.data?.totalPages === 1,
    JSON.stringify(emptyReplies.data),
  );
  const postsBeforeReply = await owner.client.call(`${teamPath}/posts`);
  check('帖子列表里的 replyCount 一开始是 0', (postsBeforeReply.data?.items ?? []).find((item) => item.id === postId)?.replyCount === 0, JSON.stringify((postsBeforeReply.data?.items ?? []).find((item) => item.id === postId)?.replyCount));

  const firstReply = await owner.client.call(repliesPath, { method: 'POST', body: { content: '周五我可能迟到十分钟。' } });
  check('团队成员能回复', firstReply.status === 200, JSON.stringify(firstReply.error ?? firstReply.body));
  const firstReplyId = firstReply.data?.reply?.id;
  check('回复正文原样回来', firstReply.data?.reply?.content === '周五我可能迟到十分钟。', String(firstReply.data?.reply?.content));
  check('回复带 contentHtml（Markdown 由服务端渲染，前端不再加工）', /^<p>/.test(String(firstReply.data?.reply?.contentHtml ?? '')), String(firstReply.data?.reply?.contentHtml));
  check('回复带回作者与时间', firstReply.data?.reply?.author?.username === 'teamowner' && Number(firstReply.data?.reply?.createdAt) > 0);
  check('自己发的回复自己能删（canDelete）', firstReply.data?.reply?.canDelete === true, String(firstReply.data?.reply?.canDelete));

  const mateReply = await mate.client.call(repliesPath, { method: 'POST', body: { content: '我把材料带过去。' } });
  check('管理员也是团队成员，能回复', mateReply.status === 200, JSON.stringify(mateReply.error ?? mateReply.body));

  const outsiderReply = await outsider.client.call(repliesPath, { method: 'POST', body: { content: '收到。' } });
  check('普通成员能回复', outsiderReply.status === 200, JSON.stringify(outsiderReply.error ?? outsiderReply.body));
  const outsiderReplyId = outsiderReply.data?.reply?.id;

  const replyList = await owner.client.call(repliesPath);
  const replyListIds = (replyList.data?.items ?? []).map((item) => item.id);
  check('回复按时间正序（先发的排在前面，倒序就是倒放录音）', replyListIds[0] === firstReplyId && replyListIds.length === 3, JSON.stringify(replyListIds));
  check('回复列表带 total', replyList.data?.total === 3, String(replyList.data?.total));
  check('分页壳里的 perPage 是正的', Number(replyList.data?.perPage) > 0, String(replyList.data?.perPage));

  const asOutsider = await outsider.client.call(repliesPath);
  const ownerReplySeenByOutsider = (asOutsider.data?.items ?? []).find((item) => item.id === firstReplyId);
  check('普通成员看别人的回复：canDelete 是 false', ownerReplySeenByOutsider?.canDelete === false, JSON.stringify(ownerReplySeenByOutsider?.canDelete));
  check('普通成员看自己的回复：canDelete 是 true', (asOutsider.data?.items ?? []).find((item) => item.id === outsiderReplyId)?.canDelete === true);
  const asMate = await mate.client.call(repliesPath);
  check('管理员看别人的回复：canDelete 是 true（管理员能管）', (asMate.data?.items ?? []).find((item) => item.id === firstReplyId)?.canDelete === true);

  const postsAfterReply = await owner.client.call(`${teamPath}/posts`);
  check('帖子列表里的 replyCount 跟着涨到 3', (postsAfterReply.data?.items ?? []).find((item) => item.id === postId)?.replyCount === 3, String((postsAfterReply.data?.items ?? []).find((item) => item.id === postId)?.replyCount));
  const detailAfterReply = await owner.client.call(`${teamPath}/posts/${postId}`);
  check('帖子详情也带 replyCount（详情页靠它显示条数）', detailAfterReply.data?.post?.replyCount === 3, String(detailAfterReply.data?.post?.replyCount));

  // 可见性完全跟着帖子：成员读得到，路人与未登录读不到。
  const strangerReplies = await stranger.client.call(repliesPath);
  check('非成员读「仅团队」帖子的回复：404（不能隔墙猜出帖子存在）', strangerReplies.status === 404, String(strangerReplies.status));
  check('这个 404 的代号还是 team_post_not_found', strangerReplies.error?.code === 'team_post_not_found', String(strangerReplies.error?.code));
  const anonReplies = await anon.call(repliesPath);
  check('未登录读「仅团队」帖子的回复：401 而不是 404', anonReplies.status === 401, String(anonReplies.status));

  // 写权限：非成员 403（且是「先判帖子、再判成员」的顺序），未登录 401。
  // 注意 403 那句提示只在「路人看得见的帖子」上才出得来 ——
  // 「仅团队」的帖子上，loadPost 先一步回 404，压根走不到成员判定。
  const strangerWritesHidden = await stranger.client.call(repliesPath, { method: 'POST', body: { content: '隔着墙问一句。' } });
  check('非成员回复「仅团队」的帖子：404（不能回，也不告诉你帖子存在）', strangerWritesHidden.status === 404, String(strangerWritesHidden.status));

  const openPost = await owner.client.call(`${teamPath}/posts`, {
    method: 'POST',
    body: { title: '公开协商帖', content: '这篇是公开的，路人也能看。', scope: 'public' },
  });
  check('（前置）建一篇公开帖，用来试「看得见但不能回」', openPost.status === 200 && openPost.data?.post?.scope === 'public', JSON.stringify(openPost.error ?? openPost.body));
  const openRepliesPath = `${teamPath}/posts/${openPost.data?.post?.id}/replies`;
  const openReply = await owner.client.call(openRepliesPath, { method: 'POST', body: { content: '公开帖下面也能回。' } });
  check('公开帖下面成员能回', openReply.status === 200, JSON.stringify(openReply.error ?? openReply.body));
  const strangerReadsOpen = await stranger.client.call(openRepliesPath);
  check('非成员读公开帖的回复：200（回复的可见性就是帖子的可见性，这是设计不是漏）', strangerReadsOpen.status === 200 && (strangerReadsOpen.data?.items ?? []).length === 1, `${strangerReadsOpen.status} ${JSON.stringify((strangerReadsOpen.data?.items ?? []).length)}`);
  check('公开帖的回复里 canDelete 对路人一律 false', (strangerReadsOpen.data?.items ?? []).every((item) => item.canDelete === false), JSON.stringify((strangerReadsOpen.data?.items ?? []).map((item) => item.canDelete)));

  const strangerWritesReply = await stranger.client.call(openRepliesPath, { method: 'POST', body: { content: '我也说两句。' } });
  check('非成员回复看得见的帖子：403', strangerWritesReply.status === 403, String(strangerWritesReply.status));
  check('403 的提示是「加入这个团队之后才能回复」', strangerWritesReply.error?.message === '加入这个团队之后才能回复', String(strangerWritesReply.error?.message));
  const anonWritesReply = await anon.call(repliesPath, { method: 'POST', body: { content: '路人甲。' } });
  check('未登录回复是 401（先问登录，再问成员）', anonWritesReply.status === 401, String(anonWritesReply.status));

  const emptyReply = await owner.client.call(repliesPath, { method: 'POST', body: { content: '   ' } });
  check('空回复被拒 400', emptyReply.status === 400, String(emptyReply.status));
  const longReply = await owner.client.call(repliesPath, { method: 'POST', body: { content: '啊'.repeat(5001) } });
  check('超过 5000 字的回复被拒 400', longReply.status === 400, String(longReply.status));

  // 删除：作者或管理员，别人不行；重复删是幂等的。
  const outsiderDeletes = await outsider.client.call(`${repliesPath}/${firstReplyId}`, { method: 'DELETE' });
  check('普通成员删别人的回复被拒 403', outsiderDeletes.status === 403, String(outsiderDeletes.status));
  check('403 的提示是「只有作者或团队管理员可以删这条回复」', outsiderDeletes.error?.message === '只有作者或团队管理员可以删这条回复', String(outsiderDeletes.error?.message));

  const missingReply = await owner.client.call(`${repliesPath}/99999999`, { method: 'DELETE' });
  check('删一条不存在的回复：404 team_reply_not_found', missingReply.status === 404 && missingReply.error?.code === 'team_reply_not_found', `${missingReply.status} ${missingReply.error?.code}`);

  // 跨帖：把别条帖子下的回复 id 拼到这条帖子路径上 —— 路径里的帖子说了算。
  const secondPost = await owner.client.call(`${teamPath}/posts`, { method: 'POST', body: { title: '另一篇帖子', content: '专门用来试跨帖的路径。', scope: 'team' } });
  check('（前置）另建一篇帖子用来试跨帖', secondPost.status === 200, JSON.stringify(secondPost.error ?? secondPost.body));
  const crossPost = await owner.client.call(`${teamPath}/posts/${secondPost.data?.post?.id}/replies/${firstReplyId}`, { method: 'DELETE' });
  check('拿别条帖子下的回复 id 来删：404', crossPost.status === 404, String(crossPost.status));
  const stillThere = await owner.client.call(repliesPath);
  check('跨帖删失败之后那条回复还在（没被顺手删掉）', (stillThere.data?.items ?? []).some((item) => item.id === firstReplyId));

  const deletedReply = await owner.client.call(`${repliesPath}/${firstReplyId}`, { method: 'DELETE' });
  check('作者能删自己的回复', deletedReply.status === 200 && deletedReply.data?.deleted === true, JSON.stringify(deletedReply.error ?? deletedReply.body));
  check('删除响应里带回最新的条数（少了一条）', deletedReply.data?.replyCount === 2, String(deletedReply.data?.replyCount));
  const deletedAgain = await owner.client.call(`${repliesPath}/${firstReplyId}`, { method: 'DELETE' });
  check('重复删同一条：仍然 200 且条数不变（幂等，前端重试不该看到报错）', deletedAgain.status === 200 && deletedAgain.data?.replyCount === 2, `${deletedAgain.status} ${deletedAgain.data?.replyCount}`);
  const repliesAfterDelete = await owner.client.call(repliesPath);
  check('删掉的回复不再出现在列表里', !(repliesAfterDelete.data?.items ?? []).some((item) => item.id === firstReplyId), JSON.stringify((repliesAfterDelete.data?.items ?? []).map((item) => item.id)));
  check('删掉之后 total 也少一个', repliesAfterDelete.data?.total === 2, String(repliesAfterDelete.data?.total));

  /* ── 退出与解散 ─────────────────────────────────────────────────── */
  const left = await outsider.client.call(`${teamPath}/leave`, { method: 'POST' });
  check('普通成员能自己退出团队', left.status === 200, JSON.stringify(left.error ?? left.body));
  const afterLeave = await outsider.client.call(`${teamPath}/posts/${postId}`);
  check('退出之后立刻又看不到了（404）', afterLeave.status === 404, String(afterLeave.status));
  const afterLeaveReplies = await outsider.client.call(repliesPath);
  check('退出之后回复也跟着看不见（回复的可见性就是帖子的可见性）', afterLeaveReplies.status === 404, String(afterLeaveReplies.status));

  const notOwnerDelete = await mate.client.call(teamPath, { method: 'DELETE' });
  check('不是创建者不能解散团队（403）', notOwnerDelete.status === 403, String(notOwnerDelete.status));

  const deleted = await owner.client.call(applyPath, { method: 'DELETE' });
  check('创建者能解散团队', deleted.status === 200, JSON.stringify(deleted.error ?? deleted.body));
  const gone = await owner.client.call(applyPath);
  check('解散之后团队详情返回 404', gone.status === 404, String(gone.status));
  const goneList = await anon.call('/api/teams');
  check('解散的团队不再出现在公开列表里', !(goneList.data?.items ?? []).some((item) => item.id === applyId));

  const deletedPost = `DELETE /api/teams/${teamId}/posts/${postId}`;
  const removePost = await owner.client.call(`${teamPath}/posts/${postId}`, { method: 'DELETE' });
  check(`能删掉自己的帖子（${deletedPost}）`, removePost.status === 200, JSON.stringify(removePost.error ?? removePost.body));
  const readDeleted = await owner.client.call(`${teamPath}/posts/${postId}`);
  check('删掉的帖子返回 404', readDeleted.status === 404, String(readDeleted.status));
  const readDeletedAnon = await anon.call(`${teamPath}/posts/${postId}`);
  check('删掉的帖子对未登录也是 404（不会先报「请登录」）', readDeletedAnon.status === 404, String(readDeletedAnon.status));

  /* ────────────────────────────────────────────────────────────────────────────
   * 验收⑧：老库升级 / 已经坏掉的库自愈
   *
   * 起因（一次线上故障）：`ensureTeamJoinPolicy` 早先用「先把 teams 改名成 teams_old → 建新表 →
   * 搬数据 → DROP teams_old」来重建 teams。SQLite ≥ 3.25 在默认设置下会把**别的表** DDL 里的
   * `REFERENCES teams(id)` 顺手改写成 `REFERENCES "teams_old"(id)` —— 这个改写只看
   * `PRAGMA legacy_alter_table`（默认 OFF），**与 `foreign_keys` 无关**，所以「关掉外键」挡不住它。
   * 旧表一 DROP，六张子表就指向一个不存在的表：之后任何写入都报
   * `no such table: main.teams_old`，用户看到的是「服务器异常」—— 凭团队号加入、团队发帖、
   * 退出团队、群聊、文件柜、回复全挂。
   *
   * 这一段用**两套库**把它钉死：
   *   场景 A：上一版形状的库（CHECK 还是 'invite'、没有 listed）—— 升级之后不能留下 teams_old，
   *           老团队照旧能用（凭号加入 / 发帖 / 退队都是 200）；
   *   场景 B：照老写法亲手弄坏的库 —— 一启动就要自愈回来，而且还能接着写。
   * 两套库的底板都由**项目自己的代码**生成（先起一次临时服务器，它建出来的就是当前形状），
   * 免得测试里再抄一份 DDL、抄歪了却照样跑绿。
   * ──────────────────────────────────────────────────────────────────────────── */

  // 上一版的 teams：没有 listed，CHECK 还写着 'invite'。
  const LEGACY_TEAMS_DDL = `CREATE TABLE teams (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    slug            TEXT    NOT NULL UNIQUE,
    name            TEXT    NOT NULL,
    intro           TEXT    NOT NULL DEFAULT '',
    owner_id        INTEGER NOT NULL REFERENCES users(id),
    join_policy     TEXT    NOT NULL DEFAULT 'open' CHECK (join_policy IN ('open','invite')),
    join_code       TEXT    NOT NULL DEFAULT '',
    announcement    TEXT    NOT NULL DEFAULT '',
    announcement_by INTEGER,
    announcement_at INTEGER,
    deleted         INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
  )`;
  const LEGACY_TEAMS_INDEXES = [
    'CREATE INDEX IF NOT EXISTS idx_teams_time ON teams (created_at DESC, id DESC)',
    'CREATE INDEX IF NOT EXISTS idx_teams_owner ON teams (owner_id)',
  ];

  /** 查这个库里还有哪些表的 DDL 提到 teams_old（这就是那次故障的指纹）。 */
  const danglingTables = (db) =>
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE '%teams_old%' ORDER BY name")
      .all()
      .map((item) => String(item.name));

  for (const file of [SCAFFOLD_DB, LEGACY_DB, BROKEN_DB]) {
    for (const suffix of ['', '-wal', '-shm']) rmSync(file + suffix, { force: true });
  }

  // 底板：让项目自己的代码建一次库，拿到「当前形状」。
  const scaffold = bootServer({
    port: PORT + 1,
    dbFile: SCAFFOLD_DB,
    logFile: join(ROOT, 'data', 'team-smoke-scaffold.log'),
  });
  const scaffoldReady = await scaffold.ready();
  check('（底板）临时服务器起来了，拿到了当前形状的库', scaffoldReady);
  await scaffold.stop();
  let modernTeamsDdl = '';
  let modernTeamsIndexes = [];
  if (scaffoldReady) {
    const db = new DatabaseSync(SCAFFOLD_DB);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    modernTeamsDdl = String(
      db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'teams'").get()?.sql ?? '',
    );
    modernTeamsIndexes = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'teams' AND sql IS NOT NULL")
      .all()
      .map((item) => String(item.sql));
    db.close();
  }

  // ── 场景 A：上一版形状的库 ────────────────────────────────────────────────
  copyFileSync(SCAFFOLD_DB, LEGACY_DB);
  {
    const db = new DatabaseSync(LEGACY_DB);
    const now = Date.now();
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('DROP TABLE teams');
    db.exec(LEGACY_TEAMS_DDL);
    for (const sql of LEGACY_TEAMS_INDEXES) db.exec(sql);
    db.prepare(
      `INSERT INTO teams (slug, name, intro, owner_id, join_policy, join_code, created_at, updated_at)
       VALUES ('legacy-team', '上一版留下来的团队', '', 1, 'invite', '', ?, ?)`,
    ).run(now, now);
    const ddl = String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'teams'").get()?.sql ?? '');
    check(
      '场景 A（前置）：底板改成了上一版的样子（CHECK 是 invite、没有 listed）',
      ddl.includes("'invite'") && !ddl.includes('listed'),
    );
    db.close();
  }

  const legacyServer = bootServer({
    port: PORT + 2,
    dbFile: LEGACY_DB,
    logFile: join(ROOT, 'data', 'team-smoke-legacy.log'),
  });
  check('场景 A：上一版的库能直接启动（升级没抛错）', await legacyServer.ready());

  {
    const db = new DatabaseSync(LEGACY_DB, { readOnly: true });
    const dangling = danglingTables(db);
    check('场景 A：升级之后没有任何表还引用 teams_old', dangling.length === 0, dangling.join(', '));
    const fk = db.prepare('PRAGMA foreign_key_check').all();
    check('场景 A：升级之后 foreign_key_check 零违规', fk.length === 0, JSON.stringify(fk.slice(0, 3)));
    const ddl = String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'teams'").get()?.sql ?? '');
    check("场景 A：teams 的 CHECK 换成了 'apply'", ddl.includes("'apply'") && !ddl.includes("'invite'"));
    const row = db.prepare("SELECT id, slug, join_policy, listed, join_code FROM teams WHERE slug = 'legacy-team'").get();
    check('场景 A：老库里的 invite 团队被翻译成 apply（设置没丢）', row?.join_policy === 'apply', String(row?.join_policy));
    check('场景 A：老团队在新库里默认出现在广场上（listed 拿默认值 1）', Number(row?.listed) === 1, String(row?.listed));
    check(
      '场景 A：老团队的团队号被回填成 6 位',
      /^[0-9A-HJKMNP-TV-Z]{6}$/.test(String(row?.join_code)),
      String(row?.join_code),
    );
    const indexNames = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'teams'")
      .all()
      .map((item) => String(item.name));
    check(
      '场景 A：teams 的三个索引都回来了（idx_teams_join_code / idx_teams_time / idx_teams_owner）',
      ['idx_teams_join_code', 'idx_teams_time', 'idx_teams_owner'].every((name) => indexNames.includes(name)),
      indexNames.join(', '),
    );
    db.close();
  }

  // 老团队照旧好用：凭团队号加入 → 发帖 → 退队，正是当初报 500 的那三件事。
  const legacyCode = (() => {
    const db = new DatabaseSync(LEGACY_DB, { readOnly: true });
    const row = db.prepare("SELECT join_code FROM teams WHERE slug = 'legacy-team'").get();
    db.close();
    return String(row?.join_code ?? '');
  })();
  const legacyGuest = await signUp('legacyguest', legacyServer.base);
  const legacyJoin = await legacyGuest.client.call('/api/teams/join-by-code', {
    method: 'POST',
    body: { code: legacyCode },
  });
  check(
    '场景 A：凭团队号加入团队不再 500（200）',
    legacyJoin.status === 200,
    `${legacyJoin.status} ${JSON.stringify(legacyJoin.error ?? '')}`,
  );
  const legacyPost = await legacyGuest.client.call('/api/teams/legacy-team/posts', {
    method: 'POST',
    body: { title: '升级之后发的帖', content: '正文', scope: 'public' },
  });
  check(
    '场景 A：升级之后还能往团队里发帖（200）',
    legacyPost.status === 200,
    `${legacyPost.status} ${JSON.stringify(legacyPost.error ?? '')}`,
  );
  const legacyLeave = await legacyGuest.client.call('/api/teams/legacy-team/leave', { method: 'POST' });
  check(
    '场景 A：退出团队不再 500（200）',
    legacyLeave.status === 200,
    `${legacyLeave.status} ${JSON.stringify(legacyLeave.error ?? '')}`,
  );
  {
    const db = new DatabaseSync(LEGACY_DB, { readOnly: true });
    const member = db
      .prepare("SELECT COUNT(*) AS n FROM team_members WHERE user_id = ? AND team_id = (SELECT id FROM teams WHERE slug = 'legacy-team')")
      .get(legacyGuest.user?.id);
    check('场景 A：退出之后成员表里真的没有这一行了', Number(member?.n) === 0, String(member?.n));
    db.close();
  }

  // 幂等：迁移每次启动都会跑，第二遍不能把库改坏。
  await legacyServer.stop();
  const legacyAgain = bootServer({
    port: PORT + 2,
    dbFile: LEGACY_DB,
    logFile: join(ROOT, 'data', 'team-smoke-legacy.log'),
  });
  check('场景 A：同一个库再启动一次也没问题（迁移幂等）', await legacyAgain.ready());
  {
    const db = new DatabaseSync(LEGACY_DB, { readOnly: true });
    const dangling = danglingTables(db);
    check('场景 A：第二遍启动之后依然没有表引用 teams_old', dangling.length === 0, dangling.join(', '));
    const teamsCount = Number(db.prepare("SELECT COUNT(*) AS n FROM teams WHERE slug = 'legacy-team'").get()?.n);
    check('场景 A：第二遍启动不会把老团队弄丢或弄成两份', teamsCount === 1, String(teamsCount));
    db.close();
  }
  await legacyAgain.stop();

  // ── 场景 B：已经坏掉的库（照老写法重演一次那个 bug） ──────────────────────
  copyFileSync(SCAFFOLD_DB, BROKEN_DB);
  let brokenRepro = '';
  {
    const db = new DatabaseSync(BROKEN_DB);
    const now = Date.now();
    db.prepare(
      `INSERT INTO teams (slug, name, intro, owner_id, join_policy, join_code, listed, created_at, updated_at)
       VALUES ('broken-team', '坏库里的团队', '', 1, 'open', 'ABCDEF', 1, ?, ?)`,
    ).run(now, now);
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('PRAGMA legacy_alter_table = OFF');
    db.exec('BEGIN');
    db.exec('ALTER TABLE teams RENAME TO teams_old');
    db.exec(modernTeamsDdl);
    db.exec('INSERT INTO teams SELECT * FROM teams_old');
    db.exec('DROP TABLE teams_old');
    for (const sql of modernTeamsIndexes) db.exec(sql);
    db.exec('COMMIT');
    // 复现完把外键重新打开：**只有开着外键**才会去解析父表名字，
    // 当年生产上就是这么报的 `no such table: main.teams_old`（关着外键的话照样写得进去）。
    db.exec('PRAGMA foreign_keys = ON');
    const dangling = danglingTables(db);
    check(
      '场景 B（前置）：照老写法重演一遍，确实有表被改写成指向 teams_old',
      dangling.length >= 6,
      dangling.join(', '),
    );
    try {
      db.prepare('INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (1, 1, ?, ?)').run(
        'member',
        now,
      );
      brokenRepro = '（居然插进去了，说明这次没重演成功）';
    } catch (error) {
      brokenRepro = String(error?.message ?? error);
    }
    check(
      '场景 B（前置）：坏库里往 team_members 写会报 no such table: main.teams_old（就是当初那个 500）',
      brokenRepro.includes('teams_old'),
      brokenRepro,
    );
    db.close();
  }

  const brokenServer = bootServer({
    port: PORT + 3,
    dbFile: BROKEN_DB,
    logFile: join(ROOT, 'data', 'team-smoke-broken.log'),
  });
  check('场景 B：已经坏掉的库一启动就自愈，服务器照常起来', await brokenServer.ready());
  {
    const db = new DatabaseSync(BROKEN_DB, { readOnly: true });
    const dangling = danglingTables(db);
    check('场景 B：自愈之后没有任何表还引用 teams_old', dangling.length === 0, dangling.join(', '));
    const fk = db.prepare('PRAGMA foreign_key_check').all();
    check('场景 B：自愈之后 foreign_key_check 零违规', fk.length === 0, JSON.stringify(fk.slice(0, 3)));
    const row = db.prepare("SELECT slug, join_code FROM teams WHERE slug = 'broken-team'").get();
    check(
      '场景 B：坏库里的团队和它的团队号都还在（数据没丢）',
      row?.slug === 'broken-team' && row?.join_code === 'ABCDEF',
      JSON.stringify(row ?? null),
    );
    db.close();
  }

  const brokenOwner = await signUp('brokenowner', brokenServer.base);
  const brokenTeam = await brokenOwner.client.call('/api/teams', {
    method: 'POST',
    body: { name: '自愈之后建的队', intro: '' },
  });
  check(
    '场景 B：自愈之后能建队（POST /api/teams 不再 500）',
    brokenTeam.status === 200,
    `${brokenTeam.status} ${JSON.stringify(brokenTeam.error ?? '')}`,
  );
  const brokenSlug = String(brokenTeam.data?.team?.slug ?? '');
  const brokenPost = await brokenOwner.client.call(`/api/teams/${brokenSlug}/posts`, {
    method: 'POST',
    body: { title: '自愈之后发的帖', content: '正文', scope: 'public' },
  });
  check(
    '场景 B：自愈之后能往团队里发帖（200）',
    brokenPost.status === 200,
    `${brokenPost.status} ${JSON.stringify(brokenPost.error ?? '')}`,
  );
  await brokenServer.stop();

  const missing = await owner.client.call('/api/teams/99999999');
  check('不存在的团队返回 404', missing.status === 404 && missing.error?.code === 'team_not_found', String(missing.status));

  // 奇怪的页码不能把团队列表打成 500：`?page=1e30` 超出安全整数范围，绑进 OFFSET
  // 会让 `node:sqlite` 抛 `datatype mismatch`，再被兜成 500。统一走 `pageParam`。
  for (const bad of ['1e999', '1e30', '2.5', 'abc', '-3']) {
    const r = await owner.client.call(`/api/teams?page=${encodeURIComponent(bad)}`);
    check(`奇怪的页码 ?page=${bad} 不该 500`, r.status === 200, `status=${r.status}`);
  }

  await finish(failures.length === 0 ? 0 : 1);
} catch (error) {
  console.error('❌ 测试脚本自己崩了：', error);
  await finish(1);
}
