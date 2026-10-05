/**
 * 动态（P1）的端到端测试：起一个临时服务器（独立库 + 独立端口），
 * 用真实 HTTP 请求把 FR-FEED-01 ~ FR-FEED-11 逐条走一遍。
 *
 * 用法：node scripts/feed-smoke.mjs
 *
 * ⚠️ 这个文件专门覆盖一类 smoke.mjs 抓不到的东西：**可见范围与越权**。
 * v1 出过「SQL 参数顺序错位导致转发列表整个 500，而 242 项测试全绿」的事故，
 * 所以这里每一条「别人看不到」的断言都从**另一个账号**发请求去验，
 * 不是检查前端有没有藏按钮 —— 前端藏起来不叫权限（FR-FEED-08 的原话）。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const SERVER = join(ROOT, 'src', 'server.js');
const DB_FILE = join(ROOT, 'data', 'feed-smoke.db');
const AVATAR_DIR = join(ROOT, 'data', 'feed-smoke-avatars');
const NOTES_DIR = join(ROOT, 'data', 'feed-smoke-notes');
const IMAGE_DIR = join(ROOT, 'data', 'feed-images');
const LOG_FILE = join(ROOT, 'data', 'feed-smoke-server.log');
const PORT = Number(process.env.FEED_SMOKE_PORT || 3422);
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

/** 1×1 的透明 PNG（合法魔数，68 字节）。 */
const PNG_1X1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
/** 声明是 PNG，内容却不是（魔数校验必须拦下）。 */
const NOT_AN_IMAGE = `data:image/png;base64,${Buffer.from('这不是图片').toString('base64')}`;
/** 超过 256 KB 的「PNG」（只有头部 8 字节合法）。 */
const HUGE_PNG = (() => {
  const buffer = Buffer.alloc(300 * 1024, 0x41);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  return `data:image/png;base64,${buffer.toString('base64')}`;
})();

/** 从列表里按 id 找一条动态。 */
const findById = (items, id) => (items ?? []).find((item) => item.id === id);

mkdirSync(join(ROOT, 'data'), { recursive: true });
for (const suffix of ['', '-wal', '-shm']) rmSync(DB_FILE + suffix, { force: true });
rmSync(IMAGE_DIR, { recursive: true, force: true });

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
  rmSync(IMAGE_DIR, { recursive: true, force: true });
  console.log('');
  console.log('──────────────────────────────────────────────');
  console.log(`通过 ${passed} 项，失败 ${failures.length} 项`);
  for (const item of failures) console.log(`  ❌ ${item}`);
  process.exit(code);
};

try {
  if (!(await waitForServer())) {
    console.log('❌ 服务器没能在 20 秒内起来，看 data/feed-smoke-server.log');
    await finish(1);
  }

  const anon = createClient();
  const admin = createClient();
  const alice = createClient();

  await admin.call('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
  await alice.call('/api/auth/login', { method: 'POST', body: { username: 'alice', password: 'demo1234' } });

  const me = (await admin.call('/api/auth/me')).data.user;
  const aliceMe = (await alice.call('/api/auth/me')).data.user;
  check('两个种子账号登录成功', adminUser(me) && aliceUser(aliceMe), JSON.stringify([me?.username, aliceMe?.username]));

  /*
   * 可见范围与黑名单的测试**必须用新注册的账号**，不能用种子里的 alice/bob/carol。
   * 踩过的坑：种子数据里 `backfillDemoSocial` 已经让 bob 关注了 admin，
   * 于是「未关注时看不到」这条断言一开始就错 —— 它测的是种子数据，不是我的代码。
   * 更要命的是关注接口是**切换**（`store.toggleFollow`），
   * 在「已关注」的状态上再调一次会变成取关，整组断言跟着一起翻。
   * 结论：测试要自己制造前置状态，不要继承样本数据。
   */
  const feeda = createClient();
  const feedb = createClient();
  await feeda.call('/api/auth/register', { method: 'POST', body: { username: 'feeda', password: 'feedpass1' } });
  await feedb.call('/api/auth/register', { method: 'POST', body: { username: 'feedb', password: 'feedpass1' } });
  const authorA = (await feeda.call('/api/auth/me')).data.user;
  const viewerB = (await feedb.call('/api/auth/me')).data.user;
  check('新注册两个账号用于可见范围测试', authorA?.username === 'feeda' && viewerB?.username === 'feedb');
  const followUrl = `/api/users/${authorA.id}/follow`;

  /* ---------- 1. 匿名可读，未登录不可写 ---------- */
  {
    const list = await anon.call('/api/feed');
    check('FR-FEED-01 匿名能读时间线（空库返回空数组）', list.status === 200 && Array.isArray(list.data.items));
    check('FR-FEED-01 时间线带分页字段', list.data.page === 1 && list.data.total === 0 && list.data.totalPages === 1);

    const create = await anon.call('/api/feed', { method: 'POST', body: { content: '偷偷发一条' } });
    // 必须是 401（未登录）而不是 404（没有这个接口）—— v1 的既有约定，别破坏。
    check('FR-FEED-02 未登录发动态返回 401 而不是 404', create.status === 401 && create.error?.code === 'unauthenticated', JSON.stringify(create));
  }

  /* ---------- 2. 发布与时间线（含 Markdown / LaTeX） ---------- */
  const publicId = (await admin.call('/api/feed', {
    method: 'POST',
    body: { content: '**加粗**的第一条动态，公式 $E = mc^2$ 应该原样留给前端 KaTeX。', scope: 'public' },
  })).data.item.id;
  check('FR-FEED-02 发布成功并返回新动态', Number.isInteger(publicId));

  {
    const list = await anon.call('/api/feed');
    check('FR-FEED-02 发布后立刻出现在时间线', Boolean(findById(list.data.items, publicId)));
    const item = findById(list.data.items, publicId);
    check('FR-FEED-03 Markdown 渲染成 HTML', /<strong>加粗<\/strong>/.test(item?.contentHtml ?? ''), item?.contentHtml);
    check('FR-FEED-03 LaTeX 原文保留（交给前端 KaTeX）', (item?.contentHtml ?? '').includes('E = mc^2'), item?.contentHtml);
    check('FR-FEED-02 默认可见范围是公开', item?.scope === 'public' && item?.scopeLabel === '公开');
    check('FR-FEED-07 新动态计数为 0 且我未表态', item?.likeCount === 0 && item?.disliked === false);
  }

  {
    const empty = await admin.call('/api/feed', { method: 'POST', body: { content: '   ' } });
    check('内容为空被拒（400）', empty.status === 400, JSON.stringify(empty.error));
    const tooLong = await admin.call('/api/feed', { method: 'POST', body: { content: 'x'.repeat(4001) } });
    check('内容超长被拒（400）', tooLong.status === 400, JSON.stringify(tooLong.error));
    const badScope = await admin.call('/api/feed', { method: 'POST', body: { content: 'ok', scope: 'friends' } });
    check('非法可见范围被拒（400 bad_scope）', badScope.status === 400 && badScope.error?.code === 'bad_scope');
  }

  /* ---------- 3. 四档可见范围：服务端强制 ---------- */
  const privateId = (await admin.call('/api/feed', { method: 'POST', body: { content: '只有我自己能看', scope: 'private' } })).data.item.id;
  const teamId = (await admin.call('/api/feed', { method: 'POST', body: { content: '只给团队看', scope: 'team' } })).data.item.id;
  // 作者换成 feeda：它的关注关系是干净的，不会被种子数据搅进来
  const followerId = (await feeda.call('/api/feed', { method: 'POST', body: { content: '只给关注我的人看', scope: 'followers' } })).data.item.id;

  {
    const anonList = await anon.call('/api/feed');
    const aliceList = await alice.call('/api/feed');
    check('FR-FEED-08 private：匿名列表里没有', !findById(anonList.data.items, privateId));
    check('FR-FEED-08 private：别的登录用户列表里也没有', !findById(aliceList.data.items, privateId));
    check('FR-FEED-08 private：作者自己列表里有', Boolean(findById((await admin.call('/api/feed')).data.items, privateId)));

    const direct = await alice.call(`/api/feed/${privateId}`);
    check('FR-FEED-08 private：别人直接按 id 拿也是 404（不是 403）', direct.status === 404 && direct.error?.code === 'feed_not_found', JSON.stringify(direct));
    const ownerDirect = await admin.call(`/api/feed/${privateId}`);
    check('FR-FEED-08 private：作者直接按 id 拿得到', ownerDirect.status === 200 && ownerDirect.data.item.id === privateId);

    check('FR-FEED-08 followers：未关注时看不到', !findById((await feedb.call('/api/feed')).data.items, followerId));
    check('FR-FEED-08 followers：匿名看不到', !findById((await anon.call('/api/feed')).data.items, followerId));

    const followed = await feedb.call(followUrl, { method: 'POST' });
    check('关注接口返回 following=true', followed.data?.following === true, JSON.stringify(followed.body));
    check('FR-FEED-08 followers：关注之后就能看到了', Boolean(findById((await feedb.call('/api/feed')).data.items, followerId)));
    const directAfterFollow = await feedb.call(`/api/feed/${followerId}`);
    check('FR-FEED-08 followers：关注后按 id 也能拿到', directAfterFollow.status === 200, String(directAfterFollow.status));
    check('FR-FEED-08 followers：没关注的 alice 仍然看不到', !findById((await alice.call('/api/feed')).data.items, followerId));

    const unfollowed = await feedb.call(followUrl, { method: 'POST' });
    check('再调一次关注接口 = 取关（toggle 语义）', unfollowed.data?.following === false, JSON.stringify(unfollowed.body));
    check('FR-FEED-08 followers：取关后立刻又看不到了', !findById((await feedb.call('/api/feed')).data.items, followerId));

    // P4 还没建 team_members，team 这一档对谁都不可见（宁可少显示，不可漏）
    check('FR-FEED-08 team：P4 的表还不存在时，别人看不到', !findById((await alice.call('/api/feed')).data.items, teamId));
    check('FR-FEED-08 team：作者自己看得到', Boolean(findById((await admin.call('/api/feed')).data.items, teamId)));
  }

  /* ---------- 4. 黑名单 ---------- */
  {
    const publicOfA = (await feeda.call('/api/feed', { method: 'POST', body: { content: 'feeda 的公开动态', scope: 'public' } })).data.item.id;
    check('feeda 的公开动态对 feedb 可见（拉黑前的基准）', Boolean(findById((await feedb.call('/api/feed')).data.items, publicOfA)));

    // ⚠️ 黑名单不是 /api/me/blocks/:name —— 是 POST /api/users/:id/block {blocked:bool}
    const blocked = await feedb.call(`/api/users/${authorA.id}/block`, { method: 'POST', body: { blocked: true } });
    check('拉黑接口生效', blocked.status === 200 && blocked.data?.blocked === true, JSON.stringify(blocked.body));
    check('拉黑之后看不到对方的公开动态', !findById((await feedb.call('/api/feed')).data.items, publicOfA));
    check('拉黑之后按 id 也拿不到', (await feedb.call(`/api/feed/${publicOfA}`)).status === 404);
    check('被拉黑的人自己仍然看得到自己发的', Boolean(findById((await feeda.call('/api/feed')).data.items, publicOfA)));

    await feedb.call(`/api/users/${authorA.id}/block`, { method: 'POST', body: { blocked: false } });
    check('取消拉黑之后又看得到', Boolean(findById((await feedb.call('/api/feed')).data.items, publicOfA)));
  }

  /* ---------- 5. 点赞 / 踩：切换与互斥 ---------- */
  {
    const like = await alice.call(`/api/feed/${publicId}/reaction`, { method: 'POST', body: { kind: 'like' } });
    check('FR-FEED-07 点赞生效', like.data.liked === true && like.data.likeCount === 1 && like.data.disliked === false);
    const again = await alice.call(`/api/feed/${publicId}/reaction`, { method: 'POST', body: { kind: 'like' } });
    check('FR-FEED-07 再点一次同一个 = 取消', again.data.liked === false && again.data.likeCount === 0);
    await alice.call(`/api/feed/${publicId}/reaction`, { method: 'POST', body: { kind: 'like' } });
    const flip = await alice.call(`/api/feed/${publicId}/reaction`, { method: 'POST', body: { kind: 'dislike' } });
    check('FR-FEED-07 赞与踩互斥', flip.data.liked === false && flip.data.disliked === true && flip.data.likeCount === 0 && flip.data.dislikeCount === 1);
    const bad = await alice.call(`/api/feed/${publicId}/reaction`, { method: 'POST', body: { kind: 'love' } });
    check('FR-FEED-07 非法表态被拒', bad.status === 400 && bad.error?.code === 'bad_kind');
    await alice.call(`/api/feed/${publicId}/reaction`, { method: 'POST', body: { kind: 'dislike' } });
    const mine = findById((await alice.call('/api/feed')).data.items, publicId);
    check('FR-FEED-07 取消后计数归零', mine.dislikeCount === 0 && mine.disliked === false);
    const anonReact = await anon.call(`/api/feed/${publicId}/reaction`, { method: 'POST', body: { kind: 'like' } });
    check('FR-FEED-07 未登录不能点赞（401）', anonReact.status === 401);
  }

  /* ---------- 6. @人 通知 ---------- */
  {
    const before = (await alice.call('/api/notifications')).data.items.length;
    await admin.call('/api/feed', { method: 'POST', body: { content: '@alice 过来看看这条', scope: 'public' } });
    const after = (await alice.call('/api/notifications')).data.items;
    const mentioned = after.some((item) => item.type === 'mention' && item.actor?.username === 'admin');
    check('FR-FEED-06 被 @ 的人收到 mention 通知', mentioned && after.length > before, `before=${before} after=${after.length}`);
  }

  /* ---------- 7. 引用站内帖子 ---------- */
  {
    const posts = (await admin.call('/api/posts?perPage=1')).data.items;
    const refId = posts[0]?.id;
    check('能拿到一篇站内帖子用于引用', Number.isInteger(refId));

    const created = await admin.call('/api/feed', { method: 'POST', body: { content: '引用一下这篇', refPostId: refId } });
    const item = created.data.item;
    check('FR-FEED-05 引用帖子渲染出卡片', item.ref?.id === refId && typeof item.ref.title === 'string', JSON.stringify(item.ref));
    check('FR-FEED-05 卡片带作者与删除位', item.ref.author?.username === posts[0].author?.username && item.ref.deleted === false);

    const missing = await admin.call('/api/feed', { method: 'POST', body: { content: '引用不存在的', refPostId: 999999 } });
    check('FR-FEED-05 引用不存在的帖子被拒（404）', missing.status === 404 && missing.error?.code === 'ref_post_not_found');
    const badRef = await admin.call('/api/feed', { method: 'POST', body: { content: '引用垃圾值', refPostId: 'abc' } });
    check('FR-FEED-05 引用编号不合法被拒（400）', badRef.status === 400 && badRef.error?.code === 'bad_ref');
  }

  /* ---------- 8. 配图 ---------- */
  {
    const ok = await admin.call('/api/feed/images', { method: 'POST', body: { dataUrl: PNG_1X1 } });
    check('FR-FEED-04 合法 PNG 上传成功', ok.status === 200 && /^\/api\/feed\/image\/[\w.-]+\.png$/.test(ok.data?.url ?? ''), JSON.stringify(ok.body));
    // 期望字节数从 dataUrl 自己算，不写死 —— 写死了就是抄一遍常量，改图片时必然忘
    const expectedBytes = Buffer.from(PNG_1X1.split(',')[1], 'base64').length;
    check('FR-FEED-04 返回真实的字节数', ok.data?.bytes === expectedBytes, `期望 ${expectedBytes}，实际 ${ok.data?.bytes}`);
    check('FR-FEED-04 顺便不回显图片内容本身', ok.data?.dataUrl === undefined && ok.data?.url !== undefined);

    const fetched = await anon.call(ok.data.url, { raw: true });
    check('FR-FEED-04 上传的图片能被读回', fetched.status === 200 && fetched.headers.get('content-type') === 'image/png');
    const missing = await anon.call('/api/feed/image/nope-123456.png');
    check('FR-FEED-04 不存在的图片 404', missing.status === 404);
    const traversal = await anon.call('/api/feed/image/..%2F..%2Fforum.db');
    check('FR-FEED-04 路径穿越被拦', traversal.status === 404, String(traversal.status));

    const fake = await admin.call('/api/feed/images', { method: 'POST', body: { dataUrl: NOT_AN_IMAGE } });
    check('FR-FEED-04 不是图片被拒', fake.status === 400 && ['bad_image'].includes(fake.error?.code), JSON.stringify(fake.error));
    const huge = await admin.call('/api/feed/images', { method: 'POST', body: { dataUrl: HUGE_PNG } });
    check('FR-FEED-04 超过 256 KB 被拒', huge.status === 400 && huge.error?.code === 'image_too_large', JSON.stringify(huge.error));

    const withImage = await admin.call('/api/feed', {
      method: 'POST',
      body: { content: '带图动态', images: [{ url: ok.data.url }] },
    });
    check(
      'FR-FEED-04 动态能带上已上传的图片',
      withImage.status === 200 && withImage.data?.item?.images?.[0]?.url === ok.data.url,
      JSON.stringify(withImage.body).slice(0, 300),
    );

    const external = await admin.call('/api/feed', {
      method: 'POST',
      body: { content: '塞外链', images: [{ url: 'https://evil.example.com/a.png' }] },
    });
    check('FR-FEED-04 外站图片地址被拒（防追踪像素）', external.status === 400 && external.error?.code === 'bad_image_url');

    const tooMany = await admin.call('/api/feed', {
      method: 'POST',
      body: { content: '图太多', images: Array.from({ length: 10 }, () => ({ url: ok.data.url })) },
    });
    check('FR-FEED-04 超过 9 张被拒', tooMany.status === 400 && tooMany.error?.code === 'too_many_images');
  }

  /* ---------- 9. 编辑 / 删除 ---------- */
  {
    const updated = await admin.call(`/api/feed/${publicId}`, {
      method: 'PUT',
      body: { content: '改过的内容', scope: 'followers' },
    });
    check('FR-FEED-11 作者能编辑自己的动态', updated.status === 200 && updated.data.item.content === '改过的内容');
    check('FR-FEED-11 编辑后标记为已编辑', updated.data.item.edited === true);
    check('FR-FEED-11 编辑后可见范围随之改变', updated.data.item.scope === 'followers');

    /*
     * 编辑是**部分更新**：只改正文时，没出现在 body 里的字段必须原样保留。
     *
     * 这条是防「静默的数据泄漏 / 丢失」：编辑界面只有正文输入框，
     * 如果服务端把「没传 scope」当成「改回 public」，一条私密动态改个错别字就公开了。
     */
    const posts = (await admin.call('/api/posts?perPage=1')).data.items;
    const keep = await admin.call('/api/feed', {
      method: 'POST',
      body: { content: '私密 + 带引用', scope: 'private', refPostId: posts[0]?.id ?? null },
    });
    const keepId = keep.data.item.id;
    const partial = await admin.call(`/api/feed/${keepId}`, { method: 'PUT', body: { content: '只改了正文' } });
    check('FR-FEED-11 只传 content 时，scope 保持原样（不会被改回 public）', partial.data.item.scope === 'private', partial.data.item.scope);
    check('FR-FEED-11 只传 content 时，引用卡片还在', partial.data.item.ref?.id === posts[0]?.id);
    const stillPrivate = await alice.call(`/api/feed/${keepId}`);
    check('FR-FEED-11 部分更新之后，别人依然看不到这条私密动态', stillPrivate.status === 404, `HTTP ${stillPrivate.status}`);

    const cleared = await admin.call(`/api/feed/${keepId}`, { method: 'PUT', body: { refPostId: null } });
    check('FR-FEED-11 显式传 refPostId:null 才能清掉引用', cleared.data.item.ref === null);
    check('FR-FEED-11 顺手传的 refPostId:null 不该动到正文', cleared.data.item.content === '只改了正文');
    await admin.call(`/api/feed/${keepId}`, { method: 'DELETE' });

    const stolen = await alice.call(`/api/feed/${publicId}`, { method: 'PUT', body: { content: '我要改别人的' } });
    check('FR-FEED-11 改别人的动态被拒（403）', stolen.status === 403 && stolen.error?.code === 'forbidden');
    const stolenDelete = await alice.call(`/api/feed/${publicId}`, { method: 'DELETE' });
    check('FR-FEED-11 删别人的动态被拒（403）', stolenDelete.status === 403);

    const del = await admin.call(`/api/feed/${publicId}`, { method: 'DELETE' });
    check('FR-FEED-11 作者能删除自己的动态', del.status === 200 && del.data.deleted === true);
    check('FR-FEED-11 删除是软删除：访客列表里没有了', !findById((await anon.call('/api/feed')).data.items, publicId));
    check('FR-FEED-11 作者列表里也没有了', !findById((await admin.call('/api/feed')).data.items, publicId));
    const afterDelete = await admin.call(`/api/feed/${publicId}`);
    check('FR-FEED-11 删除后按 id 也拿不到（404）', afterDelete.status === 404);
    const reDelete = await admin.call(`/api/feed/${publicId}`, { method: 'DELETE' });
    check('FR-FEED-11 重复删除返回 404', reDelete.status === 404);
  }

  /* ---------- 10. 筛选与分页 ---------- */
  {
    const mine = await admin.call('/api/feed?filter=mine');
    check('filter=mine 只返回自己的', (mine.data.items ?? []).every((item) => item.author.username === 'admin'));
    const following = await alice.call('/api/feed?filter=following');
    check('filter=following 只返回关注的人 + 自己', (following.data.items ?? []).every((item) => ['admin', 'alice'].includes(item.author.username)), JSON.stringify(following.data.items.map((i) => i.author.username)));
    const badFilter = await admin.call('/api/feed?filter=zzz');
    check('非法 filter 被拒', badFilter.status === 400 && badFilter.error?.code === 'bad_filter');

    const search = await admin.call('/api/feed?q=团队');
    check('q 按内容搜索', search.data.items.length >= 1 && search.data.items.every((item) => item.content.includes('团队')));

    const paged = await admin.call('/api/feed?perPage=2&page=1');
    check('分页生效（每页 2 条）', paged.data.items.length === 2 && paged.data.perPage === 2, String(paged.data.items.length));
    const page2 = await admin.call('/api/feed?perPage=2&page=2');
    check('第二页与第一页不重复', (page2.data.items ?? []).every((item) => !paged.data.items.some((first) => first.id === item.id)));
    const clamped = await admin.call('/api/feed?perPage=9999');
    check('perPage 被收敛到上限 50', clamped.data.perPage === 50, String(clamped.data.perPage));
  }

  /* ---------- 11. 接口不该有的副作用 ---------- */
  {
    const missing = await admin.call('/api/feed/999999');
    check('不存在的动态返回 404', missing.status === 404 && missing.error?.code === 'feed_not_found');
    const badId = await admin.call('/api/feed/abc');
    check('非法 id 返回 404（不是 500）', badId.status === 404, String(badId.status));

    const site = await anon.call('/api/site');
    check('v1 的 /api/site 仍然正常（新模块没把老接口挤掉）', site.status === 200 && Array.isArray(site.data.boards));
    const posts = await anon.call('/api/posts');
    check('v1 的 /api/posts 仍然正常', posts.status === 200 && Array.isArray(posts.data.items));
  }

  /* ---------- 12. 公式渲染依赖的离线资源，匿名也必须拿得到 ---------- */
  //
  // 动态首页是**公开**页面，未登录访客也要看到 $…$ 渲染成公式。
  // 而 KaTeX 是从 `/notes/vendor/` 拿的，那个前缀整体被笔记的登录门罩着 ——
  // 这条断言就是钉住「vendor 放行、编辑器本体仍然要登录」这条边界，
  // 免得哪天有人把登录门加回去，公式在首页悄悄退化成源码字符串。
  {
    const js = await anon.call('/notes/vendor/katex/katex.min.js', { raw: true });
    check('匿名能取到离线 KaTeX（动态首页公式渲染的前提）', js.status === 200, `HTTP ${js.status}`);
    const css = await anon.call('/notes/vendor/katex/katex.min.css', { raw: true });
    check('匿名能取到 KaTeX 样式', css.status === 200, `HTTP ${css.status}`);
    const portal = await anon.call('/notes/', { raw: true });
    check('但笔记编辑器本体仍然要求登录（放行的只是第三方库）', portal.status === 403, `HTTP ${portal.status}`);
  }

  /* ---------- 13. 公式必须原样到达前端（markdown 不能把它吃掉） ---------- */
  //
  // 用户报过：`$\sum _{i = 0} ^n a_i$` 渲染不出来。
  // 根因不在 KaTeX，而在服务端的 markdown：`_{i = 0} ^n a_` 被当成 markdown 斜体
  // 替换成 `<em>…</em>`，于是开头的 `$` 和收尾的 `$` 落进两个不同的文本节点，
  // KaTeX 的 auto-render 再也配不上这对定界符，公式就显示成源码。
  // 这条断言钉住的是「强调语法不许碰公式内部」。
  {
    const FORMULA = '$\\sum _{i = 0} ^n a_i$';
    const made = await admin.call('/api/feed', {
      method: 'POST',
      body: {
        content: `公式：${FORMULA}\n\n$$\n\\frac{a_1}{b_2}\n= \\sum_{n=0}^{\\infty} x_n\n$$`,
        scope: 'public',
      },
    });
    check('FR-FEED-12 能发一条带公式的动态', made.status === 200, `HTTP ${made.status}`);

    const id = made.data?.item?.id;
    const html = made.data?.item?.contentHtml ?? '';

    check('FR-FEED-12 行内公式原样保留（没有被当成斜体）', html.includes(FORMULA), html);
    check('FR-FEED-12 公式内部没有被塞进 <em>', !html.includes('<em>'), html);
    check('FR-FEED-12 块间公式的 $$ 定界符留着', html.includes('$$'));
    // 段落是按行拼 <br> 的；块公式一旦掉进段落分支，定界符就会被 <br> 隔开，
    // auto-render 照样配不上，所以这里专门检查一次。
    check(
      'FR-FEED-12 块间公式没有被 <br> 拆开',
      !/<br>/.test(html.slice(html.indexOf('$$'), html.lastIndexOf('$$'))),
      html,
    );

    // 顺手确认 markdown 该干的还干着，别为了公式把强调语法整个关掉
    const emph = await admin.call('/api/markdown/preview', {
      method: 'POST',
      body: { content: '这是 *斜体* 和 **粗体**' },
    });
    check(
      'FR-FEED-12 强调语法仍然照常工作',
      emph.status === 200 && /<em>斜体<\/em>/.test(emph.data.html) && /<strong>粗体<\/strong>/.test(emph.data.html),
      emph.data?.html,
    );

    // 块公式紧跟在正文后面（中间不空行）也必须认出块公式。
    // 段落收集器原来会一路吃到那两行 `$$`，把它们用 <br> 拼成一段，
    // 于是「文字 + 紧接块公式」这种最常见的写法反而渲染不出来。
    const glued = await admin.call('/api/markdown/preview', {
      method: 'POST',
      body: { content: '上面一行\n$$\na + b\n$$\n下面一行' },
    });
    const gluedHtml = glued.data?.html ?? '';
    check(
      'FR-FEED-12 正文紧接块公式也认得出来（不被拼成一段）',
      glued.status === 200 && !/<br>/.test(gluedHtml.slice(gluedHtml.indexOf('$$'), gluedHtml.lastIndexOf('$$'))),
      gluedHtml,
    );

    // 只打了一个 `$$`、没有配对收尾。这一条以前会让 while 原地打转、i 永不增加，
    // 于是 node 一路跑到 OOM —— 一条打错字的动态就能把整站拖死。
    // 现在的要求只有两条：不吞掉后面的正文、立刻返回。
    const unclosed = await admin.call('/api/markdown/preview', {
      method: 'POST',
      body: { content: '正文第一行\n$$\n\\frac{1}{2}\n正文最后一行' },
    });
    const unclosedHtml = unclosed.data?.html ?? '';
    check(
      'FR-FEED-12 没收尾的 $$ 不会吞掉后面的正文',
      unclosed.status === 200 && unclosedHtml.includes('正文第一行') && unclosedHtml.includes('正文最后一行'),
      unclosedHtml,
    );

    if (id) await admin.call(`/api/feed/${id}`, { method: 'DELETE' });
  }

  await finish(failures.length ? 1 : 0);
} catch (error) {
  console.log(`❌ 测试自己崩了：${error.stack ?? error.message}`);
  await finish(1);
}

function adminUser(user) {
  return user?.username === 'admin';
}
function aliceUser(user) {
  return user?.username === 'alice';
}
