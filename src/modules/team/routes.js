// 团队（P4）的接口。
//
// 前缀 `/api/teams/*` 归 P4（见 docs/skeleton.md §1.4）。
//
// ⚠️ 本文件开头照抄 P1 踩过的坑：`ensure` / `field` 必须**直接 import**，
// 不能只从 `ctx.http` 解构。模块外的辅助函数（本文件里的 `readScope`、`loadTeam` …）
// 看不见解构出来的名字，症状是接口报 500 `internal_error` 而不是 400 ——
// 抛的其实是 ReferenceError，跟「参数不对」看起来毫无关系。
import { HttpError, ensure, field, rateLimit } from '../../core/http.js';
import { requireUser } from '../../core/guards.js';
import { ANON } from '../../core/paths.js';
import {
  MAX_TEAM_ANNOUNCEMENT,
  MAX_TEAM_FILE_BYTES,
  MAX_TEAM_INTRO,
  MAX_TEAM_MESSAGE,
  MAX_TEAM_NAME,
  MAX_TEAM_POST_CONTENT,
  MAX_TEAM_POST_TITLE,
  MAX_TEAM_SLUG,
  TEAM_FILE_BODY_LIMIT,
  TEAM_FILE_PAGE_MAX,
  TEAM_JOIN_POLICIES,
  TEAM_MESSAGE_PAGE_MAX,
  TEAM_PAGE_MAX,
  TEAM_ROLES,
  TEAM_SCOPES,
} from './schema.js';
import { pickJoinCode, readJoinCode } from './join-code.js';
import { SCOPE_OPTIONS, shapeFile, shapeMember, shapeMessage, shapeTeam, shapeTeamPost } from './shape.js';
import {
  attachmentHeaders,
  extensionOf,
  parseUpload,
  readTeamFile,
  removeTeamFile,
  saveTeamFile,
} from './storage.js';

const SCOPE_HINT = '可见范围只能是：公开 / 仅关注我的人 / 仅团队 / 仅自己';
const NOT_FOUND_MESSAGE = '这篇帖子不存在';

/** 浏览者视角（`my_role` / `joined` 这两个列要它）。未登录用 -1，谁也对不上。 */
const viewerIdOf = (user) => user?.id ?? ANON;

/** 可见范围四档（冻结枚举），传错就是 400。 */
function readScope(value, fallback = 'team') {
  if (value == null || value === '') return fallback;
  const scope = String(value);
  ensure(TEAM_SCOPES.includes(scope), 400, 'bad_scope', SCOPE_HINT);
  return scope;
}

function readJoinPolicy(value, fallback = 'open') {
  if (value == null || value === '') return fallback;
  const policy = String(value);
  ensure(TEAM_JOIN_POLICIES.includes(policy), 400, 'bad_join_policy', '加入方式只能是：谁都能加入 / 需要邀请');
  return policy;
}

function readPage(query) {
  const page = Math.max(1, Number(query.get('page')) || 1);
  const perPage = Math.min(TEAM_PAGE_MAX, Math.max(1, Number(query.get('perPage')) || 20));
  return { page, perPage, offset: (page - 1) * perPage };
}

function readId(raw, label) {
  const text = String(raw ?? '');
  ensure(/^\d+$/.test(text), 404, 'not_found', `${label}不存在`);
  return Number(text);
}

/**
 * 团队地址（slug）：只说小写字母、数字、短横线。
 *
 * 中文队名派生不出 slug，所以**派生失败时自动生成一个**（`team-xxxx`），
 * 不强行要求用户想一个英文名 —— 那是把系统的约束转嫁给用户。
 * 用户明确指定了 slug 却被占用则直接 409：这时静默改成 `-2` 会让人以为自己填对了。
 */
function pickSlug(queries, raw, name) {
  const explicit = String(raw ?? '').trim().toLowerCase();
  let base = explicit;
  if (!base) {
    base = String(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }
  if (base.length < 2) base = `team-${Date.now().toString(36)}`;
  base = base.slice(0, MAX_TEAM_SLUG).replace(/-+$/g, '');
  if (base.length < 2) base = `team-${Date.now().toString(36)}`;
  ensure(/^[a-z0-9][a-z0-9-]*$/.test(base), 400, 'bad_slug', '团队地址只能用英文小写字母、数字和短横线');
  ensure(!explicit || !queries.slugTaken(base), 409, 'conflict', '这个团队地址已经有人用了，换一个吧');

  if (!queries.slugTaken(base)) return base;
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${base.slice(0, MAX_TEAM_SLUG - 4)}-${n}`;
    if (!queries.slugTaken(candidate)) return candidate;
  }
  return `team-${Date.now().toString(36)}`;
}

/**
 * 按 id 或 slug 取团队，取不到就是 404。
 *
 * ⚠️ **先按 slug 查，查不到再按数字 id 兜底**（顺序不能反）。
 * 这里踩过一个真 bug：原来写成「长得像数字就当 id」，而 `pickSlug` 允许纯数字 slug
 * （队名叫「2026」时 slug 就是 `2026`），于是 `/api/teams/2026` 被当成 id 去查，
 * 查不到就 404 —— 前端画的是「也许它已经解散了」，
 * 建队的人自己点进去都进不去。slug 是 URL 里那个东西，它优先。
 */
function loadTeam(reqCtx, queries) {
  const key = String(reqCtx.params.id ?? '');
  const viewerId = viewerIdOf(reqCtx.user);
  const bySlug = queries.teamBySlug(key, viewerId);
  const row = bySlug ?? (/^\d+$/.test(key) ? queries.teamById(Number(key), viewerId) : null);
  ensure(row, 404, 'team_not_found', '团队不存在');
  return row;
}

/** 我是不是这个团队的管理者（owner / admin）。**仅看团队成员表，没有站长的后门。** */
function isTeamManager(queries, teamId, userId) {
  if (!userId) return false;
  const member = queries.memberOf(teamId, userId);
  return Boolean(member) && member.role !== 'member';
}

function requireTeamManager(reqCtx, queries, teamRow) {
  const user = requireUser(reqCtx);
  ensure(
    isTeamManager(queries, teamRow.id, user.id),
    403,
    'forbidden',
    '只有团队的管理员可以执行这个操作',
  );
  return user;
}

/**
 * 要求「是这个团队的人」才能继续（文件柜与群聊用）。
 *
 * 未登录 → **401**（登录之后他可能就是成员，先让他登录）；
 * 已登录但不是成员 → **403**。这里**故意**不用 404：团队本身是公开可见的
 * （`GET /api/teams/:id` 谁都能看），假装「这个团队不存在」骗不了任何人，
 * 真正要守住的是团队**里面**的东西。
 */
function requireTeamMember(reqCtx, queries, teamRow) {
  const user = requireUser(reqCtx);
  const member = queries.memberOf(teamRow.id, user.id);
  ensure(member, 403, 'not_team_member', '只有团队成员能看这里的内容，先加入团队吧');
  return user;
}

/** 文件柜分页（上限与帖子分开，文件条目更重）。 */
function readFilePage(query) {
  const page = Math.max(1, Number(query.get('page')) || 1);
  const perPage = Math.min(TEAM_FILE_PAGE_MAX, Math.max(1, Number(query.get('perPage')) || 20));
  return { page, perPage, offset: (page - 1) * perPage };
}

/** 群聊一次拉多少条 + 从哪条之后拉（`after=0` 表示「给我最近的一批」）。 */
function readMessageWindow(query) {
  const limit = Math.min(TEAM_MESSAGE_PAGE_MAX, Math.max(1, Number(query.get('limit')) || 30));
  const after = Math.max(0, Number(query.get('after')) || 0);
  return { limit, after };
}

/**
 * 取一条**我看得见**的团队帖，顺便把两种「看不到」分开：
 *
 *   未登录 + 不是公开内容  → **401**（他登录之后可能就是这个团队的人，先让他登录）
 *   已登录 + 无权看        → **404**（不能被猜出来「这篇帖子存在」）
 *
 * 别把 401 那条改成 404，也别把 404 那条改成 403 ——
 * 404 与 403 的差别本身就是一个探测信道，能用来枚举出「哪些帖子存在」。
 */
function loadPost(reqCtx, queries, teamRow) {
  const postId = readId(reqCtx.params.postId, '帖子');
  const raw = queries.postRaw(postId);
  ensure(raw && !Number(raw.deleted), 404, 'team_post_not_found', NOT_FOUND_MESSAGE);
  ensure(Number(raw.team_id) === Number(teamRow.id), 404, 'team_post_not_found', NOT_FOUND_MESSAGE);
  if (!reqCtx.user) {
    ensure(raw.scope === 'public', 401, 'unauthenticated', '请先登录');
  }
  const row = queries.postById(postId, viewerIdOf(reqCtx.user));
  ensure(row, 404, 'team_post_not_found', NOT_FOUND_MESSAGE);
  return row;
}

/**
 * 注册 `/api/teams/*`。
 *
 * 路由顺序有讲究：**具体路径排在带参数的通配路径前面**，
 * 否则 `/api/teams/mine` 会被 `/api/teams/:id` 先吃掉。
 */
export function registerTeamRoutes(ctx, { queries }) {
  const add = ctx.routes.add;
  const { ok } = ctx.http;
  const store = ctx.store;

  /* ── 团队本体 ───────────────────────────────────────────────────── */

  add('GET', '/api/teams', async (reqCtx) => {
    const viewerId = viewerIdOf(reqCtx.user);
    const mine = reqCtx.query.get('mine') === '1';
    ensure(!mine || Boolean(reqCtx.user), 401, 'unauthenticated', '请先登录');
    const { page, perPage, offset } = readPage(reqCtx.query);
    const total = queries.countTeams({ viewerId, mine });
    const rows = queries.listTeams({ viewerId, mine, limit: perPage, offset });
    ok(reqCtx.res, {
      items: rows.map((row) => shapeTeam(row, { viewer: reqCtx.user })),
      page,
      perPage,
      total,
      totalPages: Math.max(1, Math.ceil(total / perPage)),
      filter: mine ? 'mine' : 'all',
    });
  });

  /**
   * 凭团队号加入。
   *
   * ⚠️ 这条路**不看 `join_policy`**，这是故意的：「需要邀请」的团队本来就没有自助入口，
   * 团队号就是那个入口 —— 管理员把号发给谁，就是把邀请发给了谁。
   * 换句话说，`invite` 挡的是「随便逛到就能进」，不是「拿到暗号也不能进」。
   *
   * 限流是唯一的防线（32^6 ≈ 10.7 亿种，20 次 / 10 分钟 / 人，枚举不动），
   * 所以号对不上就老实说 404 —— 说得越准，抄错号的人越容易自己发现。
   */
  add('POST', '/api/teams/join-by-code', async (reqCtx) => {
    const user = requireUser(reqCtx);
    rateLimit(`team:joincode:${user.id}`, 20, 10 * 60 * 1000);
    const code = readJoinCode((reqCtx.body ?? {}).code);
    const teamRow = queries.teamByJoinCode(code, user.id);
    ensure(teamRow, 404, 'team_not_found', '没有这个团队号，检查一下有没有抄错');
    // 已经在队里就当作成功：重复点「加入」不该报错，也不该把管理员降成成员
    // （`addMember` 是 ON CONFLICT DO NOTHING，本来也不会改角色）。
    if (!queries.memberOf(teamRow.id, user.id)) {
      queries.addMember({ teamId: teamRow.id, userId: user.id, role: 'member' });
    }
    ok(reqCtx.res, {
      team: shapeTeam(queries.teamById(teamRow.id, user.id), { viewer: user }),
      joined: true,
    });
  });

  add('POST', '/api/teams', async (reqCtx) => {
    const user = requireUser(reqCtx);
    rateLimit(`team:create:${user.id}`, 5, 60 * 60 * 1000);
    const body = reqCtx.body ?? {};
    const name = field(body.name ?? '', { label: '团队名', min: 2, max: MAX_TEAM_NAME });
    const intro = field(body.intro ?? '', { label: '团队简介', min: 0, max: MAX_TEAM_INTRO });
    const joinPolicy = readJoinPolicy(body.joinPolicy);
    const slug = pickSlug(queries, body.slug, name);
    // 团队号在建队时就定下来，之后不变（没有「换号」这个操作：号一旦发出去，
    // 换掉就等于把已经拿到号的成员挡在门外）。
    const joinCode = pickJoinCode(queries);
    const id = queries.createTeam({ slug, name, intro, ownerId: user.id, joinPolicy, joinCode });
    queries.addMember({ teamId: id, userId: user.id, role: 'owner' });
    const row = queries.teamById(id, user.id);
    ok(reqCtx.res, { team: shapeTeam(row, { viewer: user }) });
  });

  add('GET', '/api/teams/:id', async (reqCtx) => {
    const teamRow = loadTeam(reqCtx, queries);
    const members = queries.listMembers(teamRow.id).map(shapeMember);
    ok(reqCtx.res, {
      team: shapeTeam(teamRow, { viewer: reqCtx.user }),
      members: members.slice(0, 12),
      memberTotal: members.length,
      scopes: SCOPE_OPTIONS,
    });
  });

  add('PUT', '/api/teams/:id', async (reqCtx) => {
    const teamRow = loadTeam(reqCtx, queries);
    requireTeamManager(reqCtx, queries, teamRow);
    const body = reqCtx.body ?? {};
    const name = field(body.name ?? teamRow.name, { label: '团队名', min: 2, max: MAX_TEAM_NAME });
    const intro = field(body.intro ?? teamRow.intro, { label: '团队简介', min: 0, max: MAX_TEAM_INTRO });
    const joinPolicy = readJoinPolicy(body.joinPolicy, teamRow.join_policy);
    queries.updateTeam({ id: teamRow.id, name, intro, joinPolicy });
    ok(reqCtx.res, { team: shapeTeam(queries.teamById(teamRow.id, viewerIdOf(reqCtx.user)), { viewer: reqCtx.user }) });
  });

  add('DELETE', '/api/teams/:id', async (reqCtx) => {
    const teamRow = loadTeam(reqCtx, queries);
    const user = requireUser(reqCtx);
    ensure(
      Number(teamRow.owner_id) === user.id,
      403,
      'forbidden',
      '只有团队的创建者可以解散团队',
    );
    queries.softDeleteTeam(teamRow.id);
    ok(reqCtx.res, { deleted: true, id: teamRow.id });
  });

  /**
   * 写团队公告（团长与管理员都能改）。
   *
   * 公告是**写给全队的**，所以保存成功之后给每个成员发一条通知 —— 这就是
   * 「公告要特别用消息通知团队成员」的落点。四个决定记在这里：
   *   1) 通知传 `dedupe: false`。core 的默认行为是「同一个人对同一个对象的同类未读只留一条」，
   *      那是为了防点赞刷屏；公告恰恰相反 —— 改两次就该响两次，
   *      否则第二次改的内容对没点开过通知的人来说等于没改。
   *   2) 不发给自己：`createNotification` 本来就会跳过 `actorId === userId`，
   *      写公告的管理员不需要被自己提醒。
   *   3) 公告**清空**时不发通知：没有正文可看，发出去只会让人点进来看一片空白。
   *      清空本身是合法操作（写错了想撤下来），照旧写库。
   *   4) 走限流：每保存一次就是全队一人一条通知，放开手点能把成员的通知列表刷满。
   */
  add('PUT', '/api/teams/:id/announcement', async (reqCtx) => {
    const teamRow = loadTeam(reqCtx, queries);
    const user = requireTeamManager(reqCtx, queries, teamRow);
    rateLimit(`team:notice:${teamRow.id}`, 10, 10 * 60 * 1000);
    const body = reqCtx.body ?? {};
    const announcement = field(body.announcement ?? '', {
      label: '团队公告',
      min: 0,
      max: MAX_TEAM_ANNOUNCEMENT,
    });
    queries.setAnnouncement({ id: teamRow.id, announcement, by: user.id });

    let notified = 0;
    if (announcement !== '') {
      for (const memberId of queries.listMemberIds(teamRow.id)) {
        const created = store.createNotification({
          userId: memberId,
          actorId: user.id,
          type: 'team_announcement',
          teamId: teamRow.id,
          excerpt: announcement.slice(0, 120),
          dedupe: false,
        });
        if (created) notified += 1;
      }
    }
    ok(reqCtx.res, {
      team: shapeTeam(queries.teamById(teamRow.id, viewerIdOf(reqCtx.user)), { viewer: reqCtx.user }),
      notified,
    });
  });

  /* ── 成员 ───────────────────────────────────────────────────────── */

  add('GET', '/api/teams/:id/members', async (reqCtx) => {
    const teamRow = loadTeam(reqCtx, queries);
    const members = queries.listMembers(teamRow.id).map(shapeMember);
    ok(reqCtx.res, { items: members, total: members.length });
  });

  add('POST', '/api/teams/:id/join', async (reqCtx) => {
    const teamRow = loadTeam(reqCtx, queries);
    const user = requireUser(reqCtx);
    rateLimit(`team:join:${user.id}`, 30, 10 * 60 * 1000);
    const existing = queries.memberOf(teamRow.id, user.id);
    if (!existing) {
      ensure(
        teamRow.join_policy !== 'invite',
        403,
        'forbidden',
        '这个团队需要邀请才能加入，找管理员拉你进去',
      );
      queries.addMember({ teamId: teamRow.id, userId: user.id, role: 'member' });
    }
    ok(reqCtx.res, { team: shapeTeam(queries.teamById(teamRow.id, user.id), { viewer: user }) });
  });

  add('POST', '/api/teams/:id/leave', async (reqCtx) => {
    const teamRow = loadTeam(reqCtx, queries);
    const user = requireUser(reqCtx);
    const member = queries.memberOf(teamRow.id, user.id);
    ensure(member, 404, 'team_not_found', '你不在这个团队里');
    ensure(
      member.role !== 'owner',
      400,
      'bad_request',
      '创建者不能退出自己的团队：可以先解散它，或者把创建者转给别人',
    );
    queries.removeMember(teamRow.id, user.id);
    ok(reqCtx.res, { left: true, teamId: teamRow.id });
  });

  add('POST', '/api/teams/:id/members', async (reqCtx) => {
    const teamRow = loadTeam(reqCtx, queries);
    requireTeamManager(reqCtx, queries, teamRow);
    rateLimit(`team:invite:${teamRow.id}`, 60, 10 * 60 * 1000);
    const body = reqCtx.body ?? {};
    const username = field(body.username ?? '', { label: '用户名', min: 1, max: 40 });
    const target = store.userByUsername(username);
    ensure(target, 404, 'user_not_found', '没有这个用户');
    const role = body.role == null || body.role === '' ? 'member' : String(body.role);
    ensure(role === 'member' || role === 'admin', 400, 'bad_role', '只能设为「管理员」或「成员」');
    queries.addMember({ teamId: teamRow.id, userId: target.id, role });
    const fresh = queries.listMembers(teamRow.id).find((row) => row.user_id === target.id);
    ok(reqCtx.res, { member: shapeMember(fresh), team: shapeTeam(queries.teamById(teamRow.id, viewerIdOf(reqCtx.user)), { viewer: reqCtx.user }) });
  });

  add('PUT', '/api/teams/:id/members/:userId', async (reqCtx) => {
    const teamRow = loadTeam(reqCtx, queries);
    const user = requireUser(reqCtx);
    ensure(Number(teamRow.owner_id) === user.id, 403, 'forbidden', '只有创建者可以调整成员角色');
    const targetId = readId(reqCtx.params.userId, '成员');
    const target = queries.memberOf(teamRow.id, targetId);
    ensure(target, 404, 'team_member_not_found', '这个人不在团队里');
    const role = String((reqCtx.body ?? {}).role ?? '');
    ensure(TEAM_ROLES.includes(role) && role !== 'owner', 400, 'bad_role', '只能设为「管理员」或「成员」');
    queries.setMemberRole({ teamId: teamRow.id, userId: targetId, role });
    const fresh = queries.listMembers(teamRow.id).find((row) => row.user_id === targetId);
    ok(reqCtx.res, { member: shapeMember(fresh) });
  });

  add('DELETE', '/api/teams/:id/members/:userId', async (reqCtx) => {
    const teamRow = loadTeam(reqCtx, queries);
    const user = requireUser(reqCtx);
    const targetId = readId(reqCtx.params.userId, '成员');
    const isSelf = targetId === user.id;
    if (!isSelf) {
      requireTeamManager(reqCtx, queries, teamRow);
    }
    const target = queries.memberOf(teamRow.id, targetId);
    ensure(target, 404, 'team_member_not_found', '这个人不在团队里');
    ensure(target.role !== 'owner', 400, 'bad_request', '不能把创建者移出团队');
    queries.removeMember(teamRow.id, targetId);
    ok(reqCtx.res, { removed: true, userId: targetId });
  });

  /* ── 团队帖子 ───────────────────────────────────────────────────── */

  add('GET', '/api/teams/:id/posts', async (reqCtx) => {
    const teamRow = loadTeam(reqCtx, queries);
    const viewerId = viewerIdOf(reqCtx.user);
    const { page, perPage, offset } = readPage(reqCtx.query);
    const total = queries.countPosts({ teamId: teamRow.id, viewerId });
    const rows = queries.listPosts({ teamId: teamRow.id, viewerId, limit: perPage, offset });
    ok(reqCtx.res, {
      items: rows.map((row) => shapeTeamPost(row, { viewer: reqCtx.user, team: teamRow })),
      page,
      perPage,
      total,
      totalPages: Math.max(1, Math.ceil(total / perPage)),
      scopes: SCOPE_OPTIONS,
      myRole: TEAM_ROLES.includes(teamRow.my_role) ? teamRow.my_role : null,
    });
  });

  add('POST', '/api/teams/:id/posts', async (reqCtx) => {
    const teamRow = loadTeam(reqCtx, queries);
    const user = requireUser(reqCtx);
    ensure(
      Boolean(queries.memberOf(teamRow.id, user.id)),
      403,
      'forbidden',
      '加入这个团队之后才能发帖',
    );
    rateLimit(`team:post:${user.id}`, 30, 10 * 60 * 1000);
    const body = reqCtx.body ?? {};
    const title = field(body.title ?? '', { label: '标题', min: 1, max: MAX_TEAM_POST_TITLE });
    const content = field(body.content ?? '', { label: '正文', min: 1, max: MAX_TEAM_POST_CONTENT });
    const scope = readScope(body.scope, 'team');
    const id = queries.createPost({ teamId: teamRow.id, userId: user.id, title, content, scope });
    const row = queries.postById(id, user.id);
    ok(reqCtx.res, { post: shapeTeamPost(row, { viewer: user, team: teamRow }) });
  });

  add('GET', '/api/teams/:id/posts/:postId', async (reqCtx) => {
    const teamRow = loadTeam(reqCtx, queries);
    const row = loadPost(reqCtx, queries, teamRow);
    ok(reqCtx.res, { post: shapeTeamPost(row, { viewer: reqCtx.user, team: teamRow }) });
  });

  add('PUT', '/api/teams/:id/posts/:postId', async (reqCtx) => {
    const teamRow = loadTeam(reqCtx, queries);
    const user = requireUser(reqCtx);
    const row = loadPost(reqCtx, queries, teamRow);
    // 一起编辑是 P4 的核心需求：团队帖是**大家的东西**，不是作者一个人的私有物。
    // 所以「能看见」就「能改」—— 而「能不能看见」已经在 loadPost 里按四档可见范围判过了，
    // 别人标了「仅自己」的草稿根本走不到这一行（那一条会先在 loadPost 里返回 404）。
    // 删除是另一回事：不可逆的破坏性操作只留给作者和团队管理员（见下面的 DELETE）。
    const isAuthor = row.user_id === user.id;
    const isMember = Boolean(queries.memberOf(teamRow.id, user.id));
    ensure(isAuthor || isMember, 403, 'forbidden', '只有团队成员可以改这篇帖子');

    const body = reqCtx.body ?? {};
    const title = field(body.title ?? row.title, { label: '标题', min: 1, max: MAX_TEAM_POST_TITLE });
    const content = field(body.content ?? row.content, { label: '正文', min: 1, max: MAX_TEAM_POST_CONTENT });
    const scope = readScope(body.scope, row.scope);
    const expectedVersion = body.version == null ? null : Number(body.version);
    const force = body.force === true;

    const result = queries.savePost({
      id: row.id,
      title,
      content,
      scope,
      editorId: user.id,
      expectedVersion,
      force,
    });
    // 只有「帖子没了」才是 404；「版本对不上」要往下走成 409。
    ensure(result.ok || result.reason === 'conflict', 404, 'team_post_not_found', NOT_FOUND_MESSAGE);
    if (!result.ok) {
      // 409 而不是 403：这不是「你没权限」，是「你手上的版本旧了」。
      // 响应信封被冻结成 {ok:false,error:{code,message}}，所以这里**不塞额外字段** ——
      // 前端拿到 409 先重新 GET 一次，就同时有了最新的正文和版本号可以给用户对比。
      throw new HttpError(
        409,
        'conflict',
        `有人在你之前改过了：你看的是第 ${expectedVersion} 版，现在已经到第 ${result.current} 版。` +
          '刷新可以看到别人改成了什么样；确定要覆盖的话，再点一次「仍然保存我的」。',
      );
    }

    const fresh = queries.postById(row.id, user.id);
    ok(reqCtx.res, { post: shapeTeamPost(fresh, { viewer: user, team: teamRow }), saved: true });
  });

  add('DELETE', '/api/teams/:id/posts/:postId', async (reqCtx) => {
    const teamRow = loadTeam(reqCtx, queries);
    const user = requireUser(reqCtx);
    const row = loadPost(reqCtx, queries, teamRow);
    const canDelete = row.user_id === user.id || isTeamManager(queries, teamRow.id, user.id);
    ensure(canDelete, 403, 'forbidden', '只有作者或团队管理员可以删这篇帖子');
    queries.softDeletePost(row.id);
    ok(reqCtx.res, { deleted: true, id: row.id });
  });

  /* ── 文件柜 ─────────────────────────────────────────────────────── */

  add('GET', '/api/teams/:id/files', async (reqCtx) => {
    const teamRow = loadTeam(reqCtx, queries);
    requireTeamMember(reqCtx, queries, teamRow);
    const viewerId = viewerIdOf(reqCtx.user);
    const { page, perPage, offset } = readFilePage(reqCtx.query);
    const total = queries.countFiles(teamRow.id);
    const rows = queries.listFiles({ teamId: teamRow.id, viewerId, limit: perPage, offset });
    ok(reqCtx.res, {
      items: rows.map((row) => shapeFile(row, { viewer: reqCtx.user, team: teamRow })),
      page,
      perPage,
      total,
      totalPages: Math.max(1, Math.ceil(total / perPage)),
      maxBytes: MAX_TEAM_FILE_BYTES,
    });
  });

  /**
   * 上传一个文件。
   *
   * 请求体是 `{ name, dataUrl }`，`dataUrl` 就是浏览器 `FileReader` 读出来的
   * `data:<mime>;base64,<内容>`。用 JSON + base64 而不是 multipart：
   * 仓库是零依赖的，手写 multipart 解析器要多 100 行边界处理（分片、boundary 引号、
   * 多个文件、CRLF…），而它换来的只是省掉 33% 的编码膨胀 —— 不值。
   * 代价是请求体上限要按 4 MB 的文件放宽到 6 MB，所以这条路由显式带了
   * `{ bodyLimit }`（见 src/core/router.js），别的接口仍然是 512 KB。
   */
  add(
    'POST',
    '/api/teams/:id/files',
    async (reqCtx) => {
      const teamRow = loadTeam(reqCtx, queries);
      const user = requireTeamMember(reqCtx, queries, teamRow);
      rateLimit(`team:file:${user.id}`, 30, 10 * 60 * 1000);
      const body = reqCtx.body ?? {};
      const upload = parseUpload({ rawName: body.name, dataUrl: body.dataUrl });
      const storedName = saveTeamFile(teamRow.id, upload.buffer, extensionOf(upload.name));
      const id = queries.createFile({
        teamId: teamRow.id,
        userId: user.id,
        name: upload.name,
        mime: upload.mime,
        size: upload.size,
        storedName,
      });
      const row = queries.fileById({ id, viewerId: user.id });
      ok(reqCtx.res, { file: shapeFile(row, { viewer: user, team: teamRow }) });
    },
    { bodyLimit: TEAM_FILE_BODY_LIMIT },
  );

  add('DELETE', '/api/teams/:id/files/:fileId', async (reqCtx) => {
    const teamRow = loadTeam(reqCtx, queries);
    const user = requireTeamMember(reqCtx, queries, teamRow);
    const fileId = readId(reqCtx.params.fileId, '文件');
    const row = queries.fileById({ id: fileId, viewerId: user.id });
    ensure(row && Number(row.team_id) === Number(teamRow.id), 404, 'team_file_not_found', '这个文件不存在');
    const canDelete = Number(row.user_id) === user.id || isTeamManager(queries, teamRow.id, user.id);
    ensure(canDelete, 403, 'forbidden', '只有上传的人或团队管理员可以删这个文件');
    queries.softDeleteFile(row.id);
    // 先删库再删盘：库里那行没了，即使盘上残留也再没有任何接口能读到它
    // （文件名是随机的，猜不出来）。反过来先删盘的话，中途失败就会留下一条
    // 「点下载 404」的记录，那更难看。
    removeTeamFile(row.stored_name);
    ok(reqCtx.res, { deleted: true, id: row.id });
  });

  /**
   * 下载。
   *
   * ⚠️ 这条路由**不在 `/api/teams/:id/...` 底下**，因为下载链接要能直接用
   * `<a href>` 打开（浏览器不会带自定义头，但会带 cookie，所以成员判定照旧有效）。
   * 权限靠「文件 → 团队 → 我是不是成员」三级反查，与文件柜列表同一条规矩。
   * 响应不走 `ok()`：这里要发的是原始字节，不是 JSON 信封。
   */
  add('GET', '/api/team-files/:fileId', async (reqCtx) => {
    const viewerId = viewerIdOf(reqCtx.user);
    const fileId = readId(reqCtx.params.fileId, '文件');
    const row = queries.fileById({ id: fileId, viewerId });
    ensure(row, 404, 'team_file_not_found', '这个文件不存在');
    const teamRow = queries.teamById(Number(row.team_id), viewerId);
    ensure(teamRow, 404, 'team_file_not_found', '这个文件不存在');
    requireTeamMember(reqCtx, queries, teamRow);

    const buffer = readTeamFile(row.stored_name);
    ensure(buffer, 404, 'team_file_not_found', '这个文件已经不在服务器上了');

    reqCtx.res.writeHead(200, attachmentHeaders({ name: row.name, size: Number(row.size) || buffer.length }));
    reqCtx.res.end(buffer);
  });

  /* ── 群聊 ───────────────────────────────────────────────────────── */

  add('GET', '/api/teams/:id/messages', async (reqCtx) => {
    const teamRow = loadTeam(reqCtx, queries);
    requireTeamMember(reqCtx, queries, teamRow);
    const viewerId = viewerIdOf(reqCtx.user);
    const { limit, after } = readMessageWindow(reqCtx.query);
    const rows = queries.listMessages({ teamId: teamRow.id, viewerId, after, limit });
    // `after=0`（刚进页面）拿到的是「最近 limit 条，倒序」，翻回正序再给前端；
    // 轮询那次本身就是升序，不用翻。
    const ordered = after > 0 ? rows : rows.slice().reverse();
    ok(reqCtx.res, {
      items: ordered.map((row) => shapeMessage(row, { viewer: reqCtx.user })),
      latestId: ordered.length ? Number(ordered[ordered.length - 1].id) : queries.latestMessageId(teamRow.id),
      total: queries.countMessages(teamRow.id),
    });
  });

  add('POST', '/api/teams/:id/messages', async (reqCtx) => {
    const teamRow = loadTeam(reqCtx, queries);
    const user = requireTeamMember(reqCtx, queries, teamRow);
    // 一分钟 60 条：正常聊天够用，刷屏脚本会被挡住。
    rateLimit(`team:chat:${user.id}`, 60, 60 * 1000);
    const content = field((reqCtx.body ?? {}).content ?? '', {
      label: '消息',
      min: 1,
      max: MAX_TEAM_MESSAGE,
    });
    const id = queries.createMessage({ teamId: teamRow.id, userId: user.id, content });
    const row = queries.messageById({ id, viewerId: user.id });
    ok(reqCtx.res, { message: shapeMessage(row, { viewer: user }) });
  });

  add('DELETE', '/api/teams/:id/messages/:messageId', async (reqCtx) => {
    const teamRow = loadTeam(reqCtx, queries);
    const user = requireTeamMember(reqCtx, queries, teamRow);
    const messageId = readId(reqCtx.params.messageId, '消息');
    const row = queries.messageById({ id: messageId, viewerId: user.id });
    ensure(row && Number(row.team_id) === Number(teamRow.id), 404, 'team_message_not_found', '这条消息不存在');
    const canDelete = Number(row.user_id) === user.id || isTeamManager(queries, teamRow.id, user.id);
    ensure(canDelete, 403, 'forbidden', '只能删自己发的消息');
    queries.softDeleteMessage(row.id);
    ok(reqCtx.res, { deleted: true, id: row.id });
  });
}
