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
  MAX_TEAM_INTRO,
  MAX_TEAM_NAME,
  MAX_TEAM_POST_CONTENT,
  MAX_TEAM_POST_TITLE,
  MAX_TEAM_SLUG,
  TEAM_JOIN_POLICIES,
  TEAM_PAGE_MAX,
  TEAM_ROLES,
  TEAM_SCOPES,
} from './schema.js';
import { SCOPE_OPTIONS, shapeMember, shapeTeam, shapeTeamPost } from './shape.js';

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

/** 按 id 或 slug 取团队，取不到就是 404。 */
function loadTeam(reqCtx, queries) {
  const key = String(reqCtx.params.id ?? '');
  const viewerId = viewerIdOf(reqCtx.user);
  const row = /^\d+$/.test(key) ? queries.teamById(Number(key), viewerId) : queries.teamBySlug(key, viewerId);
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

  add('POST', '/api/teams', async (reqCtx) => {
    const user = requireUser(reqCtx);
    rateLimit(`team:create:${user.id}`, 5, 60 * 60 * 1000);
    const body = reqCtx.body ?? {};
    const name = field(body.name ?? '', { label: '团队名', min: 2, max: MAX_TEAM_NAME });
    const intro = field(body.intro ?? '', { label: '团队简介', min: 0, max: MAX_TEAM_INTRO });
    const joinPolicy = readJoinPolicy(body.joinPolicy);
    const slug = pickSlug(queries, body.slug, name);
    const id = queries.createTeam({ slug, name, intro, ownerId: user.id, joinPolicy });
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
}
