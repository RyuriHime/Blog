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
import { markdownToPlainText } from '../../markdown.js';
import {
  MAX_TEAM_ANNOUNCEMENT,
  MAX_TEAM_FILE_BYTES,
  MAX_TEAM_INTRO,
  MAX_TEAM_JOIN_MESSAGE,
  MAX_TEAM_MESSAGE,
  MAX_TEAM_NAME,
  MAX_TEAM_POST_CONTENT,
  MAX_TEAM_POST_TITLE,
  MAX_TEAM_REPLY_CONTENT,
  MAX_TEAM_SLUG,
  TEAM_FILE_BODY_LIMIT,
  TEAM_FILE_PAGE_MAX,
  TEAM_JOIN_POLICIES,
  TEAM_JOIN_REQUEST_PAGE_MAX,
  TEAM_JOIN_REQUEST_STATUSES,
  TEAM_MESSAGE_PAGE_MAX,
  TEAM_PAGE_MAX,
  TEAM_ROLES,
  TEAM_SCOPES,
} from './schema.js';
import { pickJoinCode, readJoinCode } from './join-code.js';
import {
  SCOPE_OPTIONS,
  shapeFile,
  shapeJoinRequest,
  shapeMember,
  shapeMessage,
  shapeTeam,
  shapeTeamPost,
  shapeTeamReply,
} from './shape.js';
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
  ensure(TEAM_JOIN_POLICIES.includes(policy), 400, 'bad_join_policy', '加入方式只能是：谁都能加入 / 需要申请');
  return policy;
}

/**
 * 「要不要出现在广场上」这类开关。只认真真假假的几种写法（表单送来的都是字符串），
 * 别的一律 400 —— 悄悄把 `'maybe'` 当 false 会让设置页显示的和库里的不是一回事。
 */
function readFlag(value, label = '这个选项') {
  const text = String(value ?? '').trim().toLowerCase();
  ensure(['1', '0', 'true', 'false', ''].includes(text), 400, 'bad_flag', `${label}只能是「是」或「否」`);
  return text === '1' || text === 'true';
}

/** 申请列表的状态筛选（默认只看待审）。 */
function readRequestStatus(query) {
  const raw = String(query.get('status') ?? 'pending');
  const status = raw === '' ? 'pending' : raw;
  ensure(
    status === 'all' || TEAM_JOIN_REQUEST_STATUSES.includes(status),
    400,
    'bad_status',
    '申请状态只能是：待审 / 已批准 / 已拒绝 / 全部',
  );
  return status;
}

/** 申请列表分页（与帖子、文件分开：这一页只在管理面板里出现，条目轻）。 */
function readRequestPage(query) {
  const page = Math.max(1, Number(query.get('page')) || 1);
  const perPage = Math.min(TEAM_JOIN_REQUEST_PAGE_MAX, Math.max(1, Number(query.get('perPage')) || 20));
  return { page, perPage, offset: (page - 1) * perPage };
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
   * ⚠️ 这条路**不看 `join_policy`**，这是故意的：团队号**本身就是邀请**。
   * 管理员（或任何成员）把号发给谁，就是把邀请发给了谁。
   * 换句话说，`apply` 挡的是「在广场上逛到就能进」，不是「拿到号也不能进」——
   * 否则「复制团队号」这个功能就没有意义了。
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

  /**
   * 改团队设置。
   *
   * 两条权限线，别把它们合成一条：
   *   - 团队名 / 简介 / 加入方式 → 团长**与管理员**（`requireTeamManager`）。
   *     「要不要申请才能进」是日常运营，管理员该能改。
   *   - 要不要出现在团队广场 → **只有创建者**（`owner_id`）。
   *     这是把团队从公众视野里拿掉的决定，不是日常运营 —— 与「解散团队」
   *     同一条线（解散也只有创建者能做）。
   */
  add('PUT', '/api/teams/:id', async (reqCtx) => {
    const teamRow = loadTeam(reqCtx, queries);
    const user = requireTeamManager(reqCtx, queries, teamRow);
    const body = reqCtx.body ?? {};
    const touchesListed = body.listed != null && body.listed !== '';
    ensure(
      !touchesListed || Number(teamRow.owner_id) === user.id,
      403,
      'forbidden',
      '只有团队创建者可以决定团队要不要出现在团队广场上',
    );
    const name = field(body.name ?? teamRow.name, { label: '团队名', min: 2, max: MAX_TEAM_NAME });
    const intro = field(body.intro ?? teamRow.intro, { label: '团队简介', min: 0, max: MAX_TEAM_INTRO });
    const joinPolicy = readJoinPolicy(body.joinPolicy, teamRow.join_policy);
    queries.updateTeam({ id: teamRow.id, name, intro, joinPolicy });
    if (touchesListed) {
      queries.setTeamListed({ id: teamRow.id, listed: readFlag(body.listed, '「出现在团队广场」') });
    }
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
          // 摘要先过一遍纯文本：直接截原始 Markdown 的话，
          // 通知列表里会出现「12 345678+9」这种半截表格、以及一堆 `**` 和 `[]()`。
          excerpt: markdownToPlainText(announcement, 120),
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

  /**
   * 加入团队。走哪条路由 `join_policy` 决定：
   *
   *   open  → 直接进（幂等：已经在里面就照成功返回）
   *   apply → 递一条申请，等团长 / 管理员批准；**重复递是幂等的** ——
   *           已经挂着一条待审申请就把那条原样还回去，既不报错、也不堆出两条
   *
   * ⚠️ 真正的判定在这里，不在前端：`shapeTeam` 的 `canJoin` / `canApply` 只是画按钮用的。
   * 凭团队号加入是**另一条路**（`POST /api/teams/join-by-code`，不看 `join_policy`）：
   * 号本身就是邀请，见那条路由上面的注释。
   */
  add('POST', '/api/teams/:id/join', async (reqCtx) => {
    const teamRow = loadTeam(reqCtx, queries);
    const user = requireUser(reqCtx);
    rateLimit(`team:join:${user.id}`, 30, 10 * 60 * 1000);
    const fresh = () => shapeTeam(queries.teamById(teamRow.id, user.id), { viewer: user });

    const existing = queries.memberOf(teamRow.id, user.id);
    if (existing) {
      ok(reqCtx.res, { team: fresh(), joined: true, requested: false });
      return;
    }

    if (teamRow.join_policy !== 'apply') {
      queries.addMember({ teamId: teamRow.id, userId: user.id, role: 'member' });
      ok(reqCtx.res, { team: fresh(), joined: true, requested: false });
      return;
    }

    const mine = queries.myJoinRequest({ teamId: teamRow.id, userId: user.id });
    if (mine && mine.status === 'pending') {
      ok(reqCtx.res, {
        team: fresh(),
        joined: false,
        requested: true,
        request: shapeJoinRequest(mine, { viewer: user }),
      });
      return;
    }

    const message = field((reqCtx.body ?? {}).message ?? '', {
      label: '申请理由',
      min: 0,
      max: MAX_TEAM_JOIN_MESSAGE,
    });
    const requestId = queries.createJoinRequest({ teamId: teamRow.id, userId: user.id, message });

    // 通知全体管理员（owner + admin）。走 core 默认的去重：同一个人反复递申请，
    // 每位管理员那里只留一条未读 —— 这跟公告要 `dedupe: false` 正好相反，
    // 公告是有新内容，申请只是同一个人又点了一次。
    let notified = 0;
    for (const member of queries.listMembers(teamRow.id)) {
      if (member.team_role === 'member') continue;
      const created = store.createNotification({
        userId: member.user_id,
        actorId: user.id,
        type: 'team_join_request',
        teamId: teamRow.id,
        excerpt: message,
      });
      if (created) notified += 1;
    }

    ok(reqCtx.res, {
      team: fresh(),
      joined: false,
      requested: true,
      request: shapeJoinRequest(queries.joinRequestById({ id: requestId, teamId: teamRow.id }), { viewer: user }),
      notified,
    });
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

  /* ── 加入申请（审核） ───────────────────────────────────────────── */

  /**
   * 待审的加入申请（**只有团长与管理员能看**）。
   *
   * `?status=pending|approved|rejected|all`，默认只看待审 —— 管理面板要的就是
   * 「现在有几个人在门口等着」。批过的那些留在库里当记录，想看再点「全部」。
   */
  add('GET', '/api/teams/:id/join-requests', async (reqCtx) => {
    const teamRow = loadTeam(reqCtx, queries);
    requireTeamManager(reqCtx, queries, teamRow);
    const status = readRequestStatus(reqCtx.query);
    const { page, perPage, offset } = readRequestPage(reqCtx.query);
    const total = queries.countJoinRequests({ teamId: teamRow.id, status });
    const rows = queries.listJoinRequests({ teamId: teamRow.id, status, limit: perPage, offset });
    ok(reqCtx.res, {
      items: rows.map((row) => shapeJoinRequest(row, { viewer: reqCtx.user })),
      page,
      perPage,
      total,
      totalPages: Math.max(1, Math.ceil(total / perPage)),
      status,
      pendingTotal: queries.countJoinRequests({ teamId: teamRow.id, status: 'pending' }),
    });
  });

  /**
   * 批准 / 拒绝一条申请（团长与管理员）。
   *
   * 批准 = 写进 `team_members` + 把申请标成 approved + 通知申请人。
   * 两件事必须都做：只改状态不加人，申请人会一直卡在「等待审核」；
   * 只加人不改状态，他下次来还看到一条待审的申请。
   *
   * `decideJoinRequest` 里带了 `AND status = 'pending'`：两个管理员同时点「批准」，
   * 只有一个人能改到这一行，另一个拿到 400「这条申请已经处理过了」——
   * 不会重复发通知、也不会重复加入。
   */
  add('PUT', '/api/teams/:id/join-requests/:requestId', async (reqCtx) => {
    const teamRow = loadTeam(reqCtx, queries);
    const user = requireTeamManager(reqCtx, queries, teamRow);
    const requestId = readId(reqCtx.params.requestId, '申请');
    const request = queries.joinRequestById({ id: requestId, teamId: teamRow.id });
    ensure(request, 404, 'join_request_not_found', '这条申请不存在');

    const action = String((reqCtx.body ?? {}).action ?? '');
    ensure(action === 'approve' || action === 'reject', 400, 'bad_action', '只能「批准」或「拒绝」');
    const nextStatus = action === 'approve' ? 'approved' : 'rejected';
    const changed = queries.decideJoinRequest({ id: requestId, status: nextStatus, decidedBy: user.id });
    ensure(changed, 400, 'join_request_decided', '这条申请已经处理过了');

    let member = null;
    if (nextStatus === 'approved') {
      queries.addMember({ teamId: teamRow.id, userId: request.user_id, role: 'member' });
      const fresh = queries.listMembers(teamRow.id).find((row) => Number(row.user_id) === Number(request.user_id));
      member = shapeMember(fresh);
    }

    // 通知申请人。`actorId` 是审批的人，通知卡片上就是「某某 通过了你的加入申请」。
    store.createNotification({
      userId: request.user_id,
      actorId: user.id,
      type: nextStatus === 'approved' ? 'team_join_approved' : 'team_join_rejected',
      teamId: teamRow.id,
      excerpt: `「${teamRow.name}」`,
    });

    ok(reqCtx.res, {
      request: shapeJoinRequest(queries.joinRequestById({ id: requestId, teamId: teamRow.id }), { viewer: user }),
      member,
      team: shapeTeam(queries.teamById(teamRow.id, viewerIdOf(reqCtx.user)), { viewer: reqCtx.user }),
    });
  });

  /**
   * 撤回 / 清掉一条申请。
   *
   * 两种人能用：**申请人自己**（改主意了，撤回 = 没申请过，直接删行）与
   * **团长 / 管理员**（把一条明显的垃圾申请清掉）。两边的判定都在下面：
   * 申请人只能删自己那条，管理员能删本团队任意一条 —— 别把这条写成
   * 「只要是管理员就能删任何团队的申请」，所以查询里带上了 `teamId`。
   */
  add('DELETE', '/api/teams/:id/join-requests/:requestId', async (reqCtx) => {
    const teamRow = loadTeam(reqCtx, queries);
    const user = requireUser(reqCtx);
    const requestId = readId(reqCtx.params.requestId, '申请');
    const request = queries.joinRequestById({ id: requestId, teamId: teamRow.id });
    ensure(request, 404, 'join_request_not_found', '这条申请不存在');
    const isMine = Number(request.user_id) === user.id;
    ensure(
      isMine || isTeamManager(queries, teamRow.id, user.id),
      403,
      'forbidden',
      '只有申请人本人或团队管理员能撤销这条申请',
    );
    queries.deleteJoinRequest(requestId);
    ok(reqCtx.res, {
      removed: true,
      id: requestId,
      team: shapeTeam(queries.teamById(teamRow.id, viewerIdOf(reqCtx.user)), { viewer: reqCtx.user }),
    });
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
    // 只有作者本人能改自己这篇。早先这里是「一起编辑」——「看得见就能改」，
    // 后来收紧了：替别人改稿既不打招呼也不留痕，谁在什么时候改了什么说不清。
    // 想补充内容就回一条，别动别人的字。
    // （别人标了「仅自己」的草稿连这一行都走不到 —— loadPost 早就 404 了。）
    const isAuthor = row.user_id === user.id;
    ensure(isAuthor, 403, 'forbidden', '只有作者本人可以编辑这篇帖子');

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

  /* ── 帖子下面的回复 ─────────────────────────────────────────────── */

  /**
   * 回复的可见性**完全跟着帖子**：`loadPost` 已经判过「这篇帖子你看不看得见」，
   * 这里不再判第二遍。所以「路人看得见公开帖，也就读得到它下面的回复」是设计，
   * 不是漏洞 —— 作者把帖子标成公开，要的就是这个效果。
   */
  add('GET', '/api/teams/:id/posts/:postId/replies', async (reqCtx) => {
    const teamRow = loadTeam(reqCtx, queries);
    const post = loadPost(reqCtx, queries, teamRow);
    const viewerId = viewerIdOf(reqCtx.user);
    const { page, perPage, offset } = readPage(reqCtx.query);
    const total = queries.countReplies(post.id);
    const rows = queries.listReplies({ postId: post.id, viewerId, limit: perPage, offset });
    ok(reqCtx.res, {
      items: rows.map((row) => shapeTeamReply(row, { viewer: reqCtx.user })),
      page,
      perPage,
      total,
      totalPages: Math.max(1, Math.ceil(total / perPage)),
    });
  });

  add('POST', '/api/teams/:id/posts/:postId/replies', async (reqCtx) => {
    const teamRow = loadTeam(reqCtx, queries);
    // 顺序要紧：先判「这篇帖子你看不看得见」，再判「你是不是成员」。
    // 反过来的话，一条只给团队看的帖子会对陌生访客回 403「你不是成员」——
    // 那等于隔着一堵墙告诉他「这篇帖子确实存在」。
    const post = loadPost(reqCtx, queries, teamRow);
    const user = requireUser(reqCtx);
    ensure(
      Boolean(queries.memberOf(teamRow.id, user.id)),
      403,
      'forbidden',
      '加入这个团队之后才能回复',
    );
    rateLimit(`team:reply:${user.id}`, 60, 10 * 60 * 1000);
    const content = field((reqCtx.body ?? {}).content ?? '', {
      label: '回复',
      min: 1,
      max: MAX_TEAM_REPLY_CONTENT,
    });
    const id = queries.createReply({ postId: post.id, teamId: teamRow.id, userId: user.id, content });
    const row = queries.replyById({ id, viewerId: user.id });
    ok(reqCtx.res, { reply: shapeTeamReply(row, { viewer: user }) });
  });

  /**
   * 删一条回复。路径里带上 `:postId` 是故意的：一条回复属于哪篇帖子写在 URL 里，
   * 就不用靠「回复 id 恰好对得上」这种巧合来判断，`loadPost` 那套可见性判定也直接复用。
   *
   * 重复删同一条回复返回成功（0 行改动也是「它现在没了」），不做 404 ——
   * 前端重试一次不该看到报错。
   */
  add('DELETE', '/api/teams/:id/posts/:postId/replies/:replyId', async (reqCtx) => {
    const teamRow = loadTeam(reqCtx, queries);
    const post = loadPost(reqCtx, queries, teamRow);
    const user = requireUser(reqCtx);
    const row = queries.replyById({ id: readId(reqCtx.params.replyId, '回复'), viewerId: user.id });
    // 「不属于这篇帖子」和「压根没有这一行」都给 404：对调用方来说都是「没了」。
    ensure(
      row && Number(row.post_id) === Number(post.id) && Number(row.team_id) === Number(teamRow.id),
      404,
      'team_reply_not_found',
      '这条回复不存在',
    );
    const canDelete = row.user_id === user.id || isTeamManager(queries, teamRow.id, user.id);
    ensure(canDelete, 403, 'forbidden', '只有作者或团队管理员可以删这条回复');
    queries.softDeleteReply(row.id);
    // 顺手把最新的条数带回去：详情页删完不用再发一次请求问「现在几条了」。
    ok(reqCtx.res, { deleted: true, id: row.id, replyCount: queries.countReplies(post.id) });
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
