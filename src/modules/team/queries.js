// 团队（P4）自己的 SQL。
//
// 为什么单独一个文件：`src/store.js` 是 core 的地盘（它只认 posts / replies / users 那几张表），
// 团队三张表归 P4，SQL 就该在 P4 的目录里 —— 五个人并行时才不会天天改同一个文件。
//
// ⚠️ 本文件照抄 P1（`src/modules/feed/queries.js`）用血换来的两条规矩：
//   1) 所有语句都过 `bind()`：**占位符个数与实参个数不一致就当场抛错**。
//      v1 的「转发列表 500」就是参数顺序错位，而 smoke 242 项 + check-ui-contract 175 项全绿。
//   2) **一条 SQL 的参数只能由 `conditions` 数组里成对声明的 `{ sql, params }` 拼出来**，
//      不准在调用点手写参数列表。把「成对」变成结构上的事实，而不是记性上的要求。
import { ANON } from '../../core/paths.js';
import { TEAM_SCOPES } from './schema.js';

/**
 * 拉黑关系（双向）过滤。语义与 `src/store.js` 的 `BLOCKED_AUTHOR_SQL` 一致：
 * 我拉黑的人、拉黑我的人，互相都看不见对方发的东西。
 */
const BLOCKED_AUTHOR_SQL = `p.user_id NOT IN (
      SELECT blocked_id FROM blocks WHERE blocker_id = ?
      UNION
      SELECT blocker_id FROM blocks WHERE blocked_id = ?
    )`;

/**
 * 团队的列表/详情共用列。
 *
 * ⚠️ 前五个 `?` 都在 SELECT 列表里（my_role / joined / 我的申请 id / 状态 / 提交时间，
 * 全是「当前浏览者」视角），**排在整个语句最前面**，拼参数时务必先放这几个，再放 WHERE 的。
 * 所以 `list()` / `byId()` 把「选择列参数」与「WHERE 参数」拆成两个常量再拼接，
 * 不靠人肉排列。
 */
const TEAM_COLUMNS = `
      t.id, t.slug, t.name, t.intro, t.owner_id, t.join_policy, t.listed, t.created_at, t.updated_at,
      t.join_code, t.announcement, t.announcement_by, t.announcement_at,
      ou.username AS owner_username, ou.display_name AS owner_display, ou.avatar AS owner_avatar,
      au.username AS announcer_username, au.display_name AS announcer_display,
      (SELECT COUNT(*) FROM team_members m WHERE m.team_id = t.id) AS member_count,
      (SELECT COUNT(*) FROM team_posts tp WHERE tp.team_id = t.id AND tp.deleted = 0) AS post_count,
      (SELECT m.role FROM team_members m WHERE m.team_id = t.id AND m.user_id = ?) AS my_role,
      EXISTS (SELECT 1 FROM team_members m WHERE m.team_id = t.id AND m.user_id = ?) AS joined,
      (SELECT jr.id FROM team_join_requests jr
        WHERE jr.team_id = t.id AND jr.user_id = ? ORDER BY jr.id DESC LIMIT 1) AS my_request_id,
      (SELECT jr.status FROM team_join_requests jr
        WHERE jr.team_id = t.id AND jr.user_id = ? ORDER BY jr.id DESC LIMIT 1) AS my_request_status,
      (SELECT jr.created_at FROM team_join_requests jr
        WHERE jr.team_id = t.id AND jr.user_id = ? ORDER BY jr.id DESC LIMIT 1) AS my_request_at,
      (SELECT COUNT(*) FROM team_join_requests jr
        WHERE jr.team_id = t.id AND jr.status = 'pending') AS pending_request_count`;

/** `TEAM_COLUMNS` 里那几个 `?` 的实参（总是同一个浏览者 id，放五次）。 */
const teamColumnParams = (viewerId) => [viewerId, viewerId, viewerId, viewerId, viewerId];

const TEAM_FROM = `
    FROM teams t
    JOIN users ou ON ou.id = t.owner_id
    LEFT JOIN users au ON au.id = t.announcement_by`;

/**
 * 团队帖的列表/详情共用列。
 *
 * `my_role` 也要按**帖所属团队**取一遍：一条帖能不能改，取决于我在**这个团队**里
 * 是 owner / admin 还是普通成员，跟我在别的团队里的身份无关。
 *
 * `reply_count` 顺手带出来：列表里每条帖子都要显示「N 条回复」，
 * 不为这个数字再发一轮请求 —— 它只是个 COUNT，跟着列表一起走最省事。
 */
const POST_COLUMNS = `
      p.id, p.team_id, p.user_id, p.title, p.content, p.scope, p.version, p.updated_by,
      p.created_at, p.updated_at,
      u.username, u.display_name, u.avatar, u.role,
      eu.username AS editor_username, eu.display_name AS editor_display,
      (SELECT COUNT(*) FROM team_replies tr WHERE tr.post_id = p.id AND tr.deleted = 0) AS reply_count,
      (SELECT m.role FROM team_members m WHERE m.team_id = p.team_id AND m.user_id = ?) AS my_role`;

const postColumnParams = (viewerId) => [viewerId];

const POST_FROM = `
    FROM team_posts p
    JOIN users u ON u.id = p.user_id
    LEFT JOIN users eu ON eu.id = p.updated_by`;

/**
 * 回复的列表/详情共用列。
 *
 * 同样带一份「我在这个团队里是什么角色」，给界面上的删除按钮用（服务端每次都会重判）。
 * 回复没有自己的 scope：它跟着帖子走，帖子看得见就看得见（见 schema.js 里那段注释）。
 */
const REPLY_COLUMNS = `
      r.id, r.post_id, r.team_id, r.user_id, r.content, r.created_at,
      u.username, u.display_name, u.avatar, u.role,
      (SELECT m.role FROM team_members m WHERE m.team_id = r.team_id AND m.user_id = ?) AS my_role`;

const replyColumnParams = (viewerId) => [viewerId];

const REPLY_FROM = `
    FROM team_replies r
    JOIN users u ON u.id = r.user_id`;

/**
 * 文件柜的列表/详情共用列。
 *
 * 上传者信息与帖子一样 `JOIN users` 取；`stored_name` 也一并带出来 ——
 * 下载接口要拿它去读盘。**能不能删**不在这里算：那取决于我在这个团队里的角色，
 * 交给 `shape.js`（它拿到了 `my_role`）。
 */
const FILE_COLUMNS = `
      f.id, f.team_id, f.user_id, f.name, f.mime, f.size, f.stored_name, f.created_at,
      u.username, u.display_name, u.avatar,
      (SELECT m.role FROM team_members m WHERE m.team_id = f.team_id AND m.user_id = ?) AS my_role`;

const fileColumnParams = (viewerId) => [viewerId];

const FILE_FROM = `
    FROM team_files f
    JOIN users u ON u.id = f.user_id`;

/**
 * 群聊消息的共用列（同样带一份「我在这个团队里的角色」）。
 *
 * ⚠️ 群聊与文件柜**不做双向拉黑过滤**（与帖子/动态不同）：团队是成员制空间，
 * 谁能进来由管理员把关；而拉黑是广场层面的关系，套到团队内部只会让聊天记录
 * 出现空洞、文件柜莫名其妙少东西 —— 那是更难用的东西，不是更安全的东西。
 * 这条选择写在注释里，是为了下一个人知道它是**想过之后决定的**，不是忘了。
 */
const MESSAGE_COLUMNS = `
      m.id, m.team_id, m.user_id, m.content, m.created_at,
      u.username, u.display_name, u.avatar,
      (SELECT tm.role FROM team_members tm WHERE tm.team_id = m.team_id AND tm.user_id = ?) AS my_role`;

const messageColumnParams = (viewerId) => [viewerId];

const MESSAGE_FROM = `
    FROM team_messages m
    JOIN users u ON u.id = m.user_id`;

/**
 * 加入申请的共用列。
 *
 * 这里**没有** `?`：申请人、审批人的昵称头像都靠 JOIN 出来，与「谁在看」无关
 * （能看这份列表的只有本团队的管理员，判定在 routes.js，不在 SQL 里）。
 * `decider_*` 是 LEFT JOIN —— 还没批的申请没有审批人，那两列就是空。
 */
const JOIN_REQUEST_COLUMNS = `
      jr.id, jr.team_id, jr.user_id, jr.message, jr.status, jr.decided_by, jr.decided_at,
      jr.created_at, jr.updated_at,
      u.username, u.display_name, u.avatar,
      du.username AS decider_username, du.display_name AS decider_display`;

const JOIN_REQUEST_FROM = `
    FROM team_join_requests jr
    JOIN users u ON u.id = jr.user_id
    LEFT JOIN users du ON du.id = jr.decided_by`;

/**
 * @param {object} db  node:sqlite 的 DatabaseSync
 */
export function createTeamQueries(db) {
  /** 唯一的语句编译口。占位符个数对不上就抛 —— 宁可当场炸，也不要静默查错数据。 */
  function bind(sql, params) {
    const holes = (sql.match(/\?/g) ?? []).length;
    if (holes !== params.length) {
      throw new Error(
        `[team] SQL 占位符 ${holes} 个，实参 ${params.length} 个 —— 数量对不上，绝不允许执行。\n` +
          `（参数一律由 conditions 成对生成；顺序错误比数量错误更隐蔽。）\n${sql}`,
      );
    }
    const statement = db.prepare(sql);
    return {
      all: () => statement.all(...params),
      get: () => statement.get(...params),
      run: () => statement.run(...params),
    };
  }

  /** 把成对的 `{ sql, params }` 拼成 WHERE 片段。参数只从这里出来。 */
  function buildWhere(conditions) {
    return {
      sql: conditions.map((part) => part.sql).join('\n      AND '),
      params: conditions.flatMap((part) => part.params),
    };
  }

  /**
   * 团队帖的可见范围 WHERE 片段（**服务端强制**，不是前端藏起来）。
   *
   * 四档语义与 P1 的动态、P2 的积木完全一致：
   *   public    谁都能看（含未登录）
   *   followers 只有关注了作者的人（以及作者自己）能看
   *   team      只有该团队成员（以及作者自己）能看
   *   private   只有作者自己
   *
   * **不做 staff 越权。** P2 的积木给了管理员后门，P1 的动态没给，这里是团队 ——
   * 更接近 P1 的私人性质，而且「宁可看不到，不可看漏」：少给一个后门最多是管理员看不到，
   * 多给一个后门就是一次不可逆的泄露（这条内容还会被搜索、被 AI 索引）。
   * 需要内容管理时应该是另一条明确的接口，不是悄悄放宽这里。
   */
  function postVisibilityConditions(viewerId) {
    return [
      {
        sql: `(p.scope = 'public'
        OR p.user_id = ?
        OR (p.scope = 'followers' AND EXISTS (
          SELECT 1 FROM follows fo WHERE fo.follower_id = ? AND fo.followee_id = p.user_id
        ))
        OR (p.scope = 'team' AND EXISTS (
          SELECT 1 FROM team_members tm WHERE tm.team_id = p.team_id AND tm.user_id = ?
        )))`,
        params: [viewerId, viewerId, viewerId],
      },
      { sql: BLOCKED_AUTHOR_SQL, params: [viewerId, viewerId] },
    ];
  }

  /** 团队列表自己的筛选条件（`mine=1` = 我加入的）。 */
  function teamFilterConditions({ viewerId, mine = false }) {
    const parts = [{ sql: 't.deleted = 0', params: [] }];
    if (mine) {
      parts.push({
        sql: `EXISTS (SELECT 1 FROM team_members m WHERE m.team_id = t.id AND m.user_id = ?)`,
        params: [viewerId],
      });
    } else {
      // 团队广场只列「愿意被列出来」的团队。团长把团队设成不出现（`listed = 0`）之后，
      // 它就不在广场上，但团队主页、团队号、帖子链接照旧能用 —— 藏的是**被发现**，
      // 不是入口。自己已经加入的团队仍然列给自己看：否则团长一点「隐藏」，
      // 自己下次来广场也会以为团队没了。
      parts.push({
        sql: `(t.listed = 1 OR EXISTS (SELECT 1 FROM team_members m WHERE m.team_id = t.id AND m.user_id = ?))`,
        params: [viewerId],
      });
    }
    return parts;
  }

  return {
    scopes: TEAM_SCOPES,

    /* ── 团队 ───────────────────────────────────────────────────────── */

    /** 团队列表。`mine=1` 只看我加入的。 */
    listTeams({ viewerId = ANON, mine = false, limit = 20, offset = 0 } = {}) {
      const where = buildWhere(teamFilterConditions({ viewerId, mine }));
      return bind(
        `SELECT ${TEAM_COLUMNS}
    ${TEAM_FROM}
    WHERE ${where.sql}
    ORDER BY t.created_at DESC, t.id DESC
    LIMIT ? OFFSET ?`,
        [...teamColumnParams(viewerId), ...where.params, limit, offset],
      ).all();
    },

    countTeams({ viewerId = ANON, mine = false } = {}) {
      const where = buildWhere(teamFilterConditions({ viewerId, mine }));
      const row = bind(
        `SELECT COUNT(*) AS n
    FROM teams t
    WHERE ${where.sql}`,
        [...where.params],
      ).get();
      return Number(row?.n) || 0;
    },

    /** 按 id 取一个团队（含浏览者视角的 my_role / joined）。软删掉的不算。 */
    teamById(id, viewerId = ANON) {
      return bind(
        `SELECT ${TEAM_COLUMNS}
    ${TEAM_FROM}
    WHERE t.id = ? AND t.deleted = 0`,
        [...teamColumnParams(viewerId), id],
      ).get();
    },

    /**
     * 按 slug 取，给 `#/team/<slug>` 这种可读地址用。
     */
    teamBySlug(slug, viewerId = ANON) {
      return bind(
        `SELECT ${TEAM_COLUMNS}
    ${TEAM_FROM}
    WHERE t.slug = ? AND t.deleted = 0`,
        [...teamColumnParams(viewerId), slug],
      ).get();
    },

    /**
     * 按**团队号**取（凭号加入那条路）。
     *
     * 与 slug 不同：这里大小写与「抄错的 I / L / O」都由 `join-code.js` 在调用前折好，
     * SQL 只认标准形状 —— 数据库里存的就永远是标准形状，比较是等值比较，走得上唯一索引。
     */
    teamByJoinCode(code, viewerId = ANON) {
      return bind(
        `SELECT ${TEAM_COLUMNS}
    ${TEAM_FROM}
    WHERE t.join_code = ? AND t.deleted = 0`,
        [...teamColumnParams(viewerId), code],
      ).get();
    },

    /** slug 是否已被占用（软删掉的也算占用，否则 URL 会指向两个团队）。 */
    slugTaken(slug) {
      return Boolean(bind('SELECT 1 AS hit FROM teams WHERE slug = ?', [slug]).get());
    },

    /** 团队号是否已被占用（软删掉的也算 —— 号不该被回收给别人）。 */
    joinCodeTaken(code) {
      return Boolean(bind('SELECT 1 AS hit FROM teams WHERE join_code = ?', [code]).get());
    },

    createTeam({ slug, name, intro = '', ownerId, joinPolicy = 'open', joinCode = '', now = Date.now() }) {
      const result = bind(
        `INSERT INTO teams (slug, name, intro, owner_id, join_policy, join_code, deleted, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        [slug, name, intro, ownerId, joinPolicy, joinCode, now, now],
      ).run();
      return Number(result.lastInsertRowid);
    },

    /**
     * 改团队设置。`listed` 单独走 `setTeamListed`：它只有创建者能改，
     * 与「团队名 / 简介 / 加入方式」（团长与管理员都能改）不是同一条权限线。
     */
    updateTeam({ id, name, intro, joinPolicy, now = Date.now() }) {
      const result = bind(
        `UPDATE teams SET name = ?, intro = ?, join_policy = ?, updated_at = ?
     WHERE id = ? AND deleted = 0`,
        [name, intro, joinPolicy, now, id],
      ).run();
      return Number(result.changes) > 0;
    },

    /** 团队要不要出现在广场上（只有创建者能改，判定在 routes.js）。 */
    setTeamListed({ id, listed, now = Date.now() }) {
      const result = bind('UPDATE teams SET listed = ?, updated_at = ? WHERE id = ? AND deleted = 0', [
        listed ? 1 : 0,
        now,
        id,
      ]).run();
      return Number(result.changes) > 0;
    },

    softDeleteTeam(id, now = Date.now()) {
      const result = bind('UPDATE teams SET deleted = 1, updated_at = ? WHERE id = ? AND deleted = 0', [
        now,
        id,
      ]).run();
      return Number(result.changes) > 0;
    },

    /**
     * 写团队公告（只有 owner / admin 能走到这里，判定在 `routes.js`）。
     *
     * `announcement` 传空串表示**撤下公告**：`announcement_by` / `announcement_at` 一起置空，
     * 页面因此显示「还没有公告」而不是「某某某写的（空）」。这条由本函数保证，
     * 不指望每个调用点都记得传 null。
     */
    setAnnouncement({ id, announcement, by = null, now = Date.now() }) {
      const text = String(announcement ?? '');
      const author = text === '' ? null : by;
      const at = text === '' ? null : now;
      const result = bind(
        `UPDATE teams SET announcement = ?, announcement_by = ?, announcement_at = ?, updated_at = ?
     WHERE id = ? AND deleted = 0`,
        [text, author, at, now, id],
      ).run();
      return Number(result.changes) > 0;
    },

    /* ── 成员 ───────────────────────────────────────────────────────── */

    memberOf(teamId, userId) {
      return bind('SELECT team_id, user_id, role, joined_at FROM team_members WHERE team_id = ? AND user_id = ?', [
        teamId,
        userId,
      ]).get();
    },

    listMembers(teamId) {
      return bind(
        `SELECT m.team_id, m.user_id, m.role AS team_role, m.joined_at,
            u.username, u.display_name, u.avatar, u.role AS role_in_site
     FROM team_members m
     JOIN users u ON u.id = m.user_id
     WHERE m.team_id = ?
     ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, m.joined_at ASC`,
        [teamId],
      ).all();
    },

    countMembers(teamId) {
      const row = bind('SELECT COUNT(*) AS n FROM team_members WHERE team_id = ?', [teamId]).get();
      return Number(row?.n) || 0;
    },

    /**
     * 全队成员的 user_id（公告通知要发给他们）。
     *
     * 只回 id：公告通知的内容对谁都一样，没必要把每个人的昵称头像也查出来。
     */
    listMemberIds(teamId) {
      return bind('SELECT user_id FROM team_members WHERE team_id = ?', [teamId])
        .all()
        .map((row) => Number(row.user_id));
    },

    /** 加入。已经有行就不动 —— 重复加入不该把角色从 admin 悄悄降成 member。 */
    addMember({ teamId, userId, role = 'member', now = Date.now() }) {
      const result = bind(
        `INSERT INTO team_members (team_id, user_id, role, joined_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (team_id, user_id) DO NOTHING`,
        [teamId, userId, role, now],
      ).run();
      return Number(result.changes) > 0;
    },

    setMemberRole({ teamId, userId, role }) {
      const result = bind('UPDATE team_members SET role = ? WHERE team_id = ? AND user_id = ?', [
        role,
        teamId,
        userId,
      ]).run();
      return Number(result.changes) > 0;
    },

    removeMember(teamId, userId) {
      const result = bind('DELETE FROM team_members WHERE team_id = ? AND user_id = ?', [teamId, userId]).run();
      return Number(result.changes) > 0;
    },

    /* ── 加入申请 ───────────────────────────────────────────────────── */

    /**
     * 我的申请。`user_id = ?` 是「我递的」—— 团队主页靠它决定按钮画哪一个：
     * 没申请过画「申请加入」，待审画「等待审核」（还能撤回），被拒画「再申请一次」。
     */
    myJoinRequest({ teamId, userId }) {
      return bind(
        `SELECT ${JOIN_REQUEST_COLUMNS}
    ${JOIN_REQUEST_FROM}
    WHERE jr.team_id = ? AND jr.user_id = ?
    ORDER BY jr.id DESC
    LIMIT 1`,
        [teamId, userId],
      ).get();
    },

    /** 按 id 取一条申请，**同时限定团队**（跨团队的 id 一律当作不存在）。 */
    joinRequestById({ id, teamId }) {
      return bind(
        `SELECT ${JOIN_REQUEST_COLUMNS}
    ${JOIN_REQUEST_FROM}
    WHERE jr.id = ? AND jr.team_id = ?`,
        [id, teamId],
      ).get();
    },

    /**
     * 递一条申请。
     *
     * 幂等交给**唯一的部分索引**（`team_id, user_id WHERE status='pending'`）：
     * 同一个人对同一个团队连着点两次「申请加入」，第二次会撞索引抛错 ——
     * 调用方（routes.js）先查 `myJoinRequest` 再决定，撞上也只是重复，
     * 但真撞上了说明有人绕过检查，让它当场炸比静默堆两条好。
     */
    createJoinRequest({ teamId, userId, message = '', now = Date.now() }) {
      const result = bind(
        `INSERT INTO team_join_requests (team_id, user_id, message, status, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', ?, ?)`,
        [teamId, userId, message, now, now],
      ).run();
      return Number(result.lastInsertRowid);
    },

    /** 管理面板的申请列表。`status='all'` 表示「批过的也要看」。 */
    listJoinRequests({ teamId, status = 'pending', limit = 20, offset = 0 }) {
      const where = buildWhere([
        { sql: 'jr.team_id = ?', params: [teamId] },
        ...(status === 'all' ? [] : [{ sql: 'jr.status = ?', params: [status] }]),
      ]);
      return bind(
        `SELECT ${JOIN_REQUEST_COLUMNS}
    ${JOIN_REQUEST_FROM}
    WHERE ${where.sql}
    ORDER BY jr.created_at DESC, jr.id DESC
    LIMIT ? OFFSET ?`,
        [...where.params, limit, offset],
      ).all();
    },

    countJoinRequests({ teamId, status = 'pending' }) {
      const where = buildWhere([
        { sql: 'jr.team_id = ?', params: [teamId] },
        ...(status === 'all' ? [] : [{ sql: 'jr.status = ?', params: [status] }]),
      ]);
      const row = bind(
        `SELECT COUNT(*) AS n
    FROM team_join_requests jr
    WHERE ${where.sql}`,
        [...where.params],
      ).get();
      return Number(row?.n) || 0;
    },

    /**
     * 批准 / 拒绝。
     *
     * `AND status = 'pending'` 是**并发保护**：两个管理员同时点「批准」，
     * 只有一个人能改到这一行，另一个人拿到 0 条变更 → 路由回 400，
     * 而不是「静默地又批一次」（那会重复发通知、重复加入）。
     */
    decideJoinRequest({ id, status, decidedBy, now = Date.now() }) {
      const result = bind(
        `UPDATE team_join_requests SET status = ?, decided_by = ?, decided_at = ?, updated_at = ?
     WHERE id = ? AND status = 'pending'`,
        [status, decidedBy, now, now, id],
      ).run();
      return Number(result.changes) > 0;
    },

    /**
     * 删掉一条申请：申请人自己「撤回」、或者管理员清掉一条。
     *
     * 直接删行而不是标记成第四种状态：撤回等于没申请过，留一行 `withdrawn`
     * 只会让管理面板多一个永远不用看的分类。
     */
    deleteJoinRequest(id) {
      const result = bind('DELETE FROM team_join_requests WHERE id = ?', [id]).run();
      return Number(result.changes) > 0;
    },

    /* ── 团队帖子 ───────────────────────────────────────────────────── */

    listPosts({ teamId, viewerId = ANON, limit = 20, offset = 0 } = {}) {
      const where = buildWhere([
        { sql: 'p.deleted = 0', params: [] },
        { sql: 'p.team_id = ?', params: [teamId] },
        ...postVisibilityConditions(viewerId),
      ]);
      return bind(
        `SELECT ${POST_COLUMNS}
    ${POST_FROM}
    WHERE ${where.sql}
    ORDER BY p.created_at DESC, p.id DESC
    LIMIT ? OFFSET ?`,
        [...postColumnParams(viewerId), ...where.params, limit, offset],
      ).all();
    },

    countPosts({ teamId, viewerId = ANON } = {}) {
      const where = buildWhere([
        { sql: 'p.deleted = 0', params: [] },
        { sql: 'p.team_id = ?', params: [teamId] },
        ...postVisibilityConditions(viewerId),
      ]);
      const row = bind(
        `SELECT COUNT(*) AS n
    FROM team_posts p
    WHERE ${where.sql}`,
        [...where.params],
      ).get();
      return Number(row?.n) || 0;
    },

    /** 按 id 取一条**看得见**的帖子；看不见返回 undefined（调用方回 404）。 */
    postById(id, viewerId = ANON) {
      const where = buildWhere([
        { sql: 'p.deleted = 0', params: [] },
        { sql: 'p.id = ?', params: [id] },
        ...postVisibilityConditions(viewerId),
      ]);
      return bind(
        `SELECT ${POST_COLUMNS}
    ${POST_FROM}
    WHERE ${where.sql}`,
        [...postColumnParams(viewerId), ...where.params],
      ).get();
    },

    /**
     * 不看可见性、直接取原始行。**只给权限判定用**：
     * 「这条帖存在吗、是谁的、属于哪个团队、现在第几版」这几个问题必须在过滤之前回答，
     * 否则会出现「因为看不见，所以告诉你它不存在」这种把 404 和 403 混在一起的结果。
     */
    postRaw(id) {
      return bind(
        `SELECT id, team_id, user_id, title, content, scope, version, updated_by, deleted, created_at, updated_at
     FROM team_posts WHERE id = ?`,
        [id],
      ).get();
    },

    createPost({ teamId, userId, title = '', content = '', scope = 'team', now = Date.now() }) {
      const result = bind(
        `INSERT INTO team_posts (team_id, user_id, title, content, scope, version, updated_by, deleted, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, 0, ?, ?)`,
        [teamId, userId, title, content, scope, userId, now, now],
      ).run();
      return Number(result.lastInsertRowid);
    },

    /**
     * 保存（乐观并发）。
     *
     * 版本比对**写在 UPDATE 的 WHERE 里**，不是先 SELECT 再 UPDATE ——
     * 后者在两件事之间留了一个窗口，node:sqlite 是同步的所以今天撞不上，
     * 但这个写法把「不会覆盖别人」变成数据库层面的事实，而不是运行时的运气。
     *
     * @returns {{ok: true, version: number} | {ok: false, reason: 'missing' | 'conflict', current?: number}}
     */
    savePost({ id, title, content, scope, editorId, expectedVersion = null, force = false, now = Date.now() }) {
      // `force = true`（用户在冲突提示里选了「仍然保存我的」）才放开版本比对。
      // `expectedVersion` 没传也不比对 —— 那是「新客户端还没实现带版本」的兼容路径，
      // 但只要前端传了就必须对上，不能靠不传绕过。
      const checkVersion = force !== true && expectedVersion != null;
      const params = [title, content, scope, editorId, now, id];
      let sql = `UPDATE team_posts
     SET title = ?, content = ?, scope = ?, version = version + 1, updated_by = ?, updated_at = ?
     WHERE id = ? AND deleted = 0`;
      if (checkVersion) {
        sql += ' AND version = ?';
        params.push(Number(expectedVersion));
      }

      const result = bind(sql, params).run();

      if (Number(result.changes) > 0) {
        const row = bind('SELECT version FROM team_posts WHERE id = ?', [id]).get();
        return { ok: true, version: Number(row?.version) || 1 };
      }

      // 没改成：要么帖子没了，要么版本对不上。两种要给前端不同的话。
      const row = bind('SELECT version, deleted FROM team_posts WHERE id = ?', [id]).get();
      if (!row || Number(row.deleted) === 1) return { ok: false, reason: 'missing' };
      return { ok: false, reason: 'conflict', current: Number(row.version) || 1 };
    },

    softDeletePost(id, now = Date.now()) {
      const result = bind('UPDATE team_posts SET deleted = 1, updated_at = ? WHERE id = ? AND deleted = 0', [
        now,
        id,
      ]).run();
      return Number(result.changes) > 0;
    },

    /* ── 帖子下面的回复 ─────────────────────────────────────────────── */

    /**
     * 一条帖子的回复，**时间正序**（最早的在上）：
     * 回复是一段对话，倒着排读起来是倒放的录音；帖子列表倒序是因为那是「新鲜事」。
     */
    listReplies({ postId, viewerId, limit, offset }) {
      return bind(
        `SELECT${REPLY_COLUMNS}${REPLY_FROM}
     WHERE r.deleted = 0 AND r.post_id = ?
     ORDER BY r.created_at ASC, r.id ASC
     LIMIT ? OFFSET ?`,
        [...replyColumnParams(viewerId), postId, limit, offset],
      ).all();
    },

    countReplies(postId) {
      const row = bind('SELECT COUNT(*) AS total FROM team_replies WHERE post_id = ? AND deleted = 0', [postId]).get();
      return Number(row?.total) || 0;
    },

    /**
     * 单条回复（要带上「我」的视角，才能判删除）。
     * 软删过的行也返回 —— 路由要用它区分「不存在」和「已经删过了」。
     */
    replyById({ id, viewerId }) {
      return bind(`SELECT${REPLY_COLUMNS}${REPLY_FROM}\n     WHERE r.id = ?`, [...replyColumnParams(viewerId), id]).get() ?? null;
    },

    createReply({ postId, teamId, userId, content, now = Date.now() }) {
      const result = bind(
        `INSERT INTO team_replies (post_id, team_id, user_id, content, deleted, created_at)
     VALUES (?, ?, ?, ?, 0, ?)`,
        [postId, teamId, userId, content, now],
      ).run();
      return Number(result.lastInsertRowid) || 0;
    },

    softDeleteReply(id) {
      const result = bind('UPDATE team_replies SET deleted = 1 WHERE id = ? AND deleted = 0', [id]).run();
      return Number(result.changes) > 0;
    },

    /* ── 文件柜 ─────────────────────────────────────────────────────── */

    listFiles({ teamId, viewerId, limit, offset }) {
      return bind(
        `SELECT${FILE_COLUMNS}${FILE_FROM}
     WHERE f.team_id = ? AND f.deleted = 0
     ORDER BY f.created_at DESC, f.id DESC
     LIMIT ? OFFSET ?`,
        [...fileColumnParams(viewerId), teamId, limit, offset],
      ).all();
    },

    countFiles(teamId) {
      const row = bind('SELECT COUNT(*) AS total FROM team_files WHERE team_id = ? AND deleted = 0', [teamId]).get();
      return Number(row?.total) || 0;
    },

    /** 下载接口用：带 `stored_name`，只认没被软删的行。 */
    fileById({ id, viewerId }) {
      return bind(`SELECT${FILE_COLUMNS}${FILE_FROM}\n     WHERE f.id = ? AND f.deleted = 0`, [
        ...fileColumnParams(viewerId),
        id,
      ]).get() ?? null;
    },

    createFile({ teamId, userId, name, mime = '', size = 0, storedName, now = Date.now() }) {
      const result = bind(
        `INSERT INTO team_files (team_id, user_id, name, mime, size, stored_name, deleted, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
        [teamId, userId, name, mime, size, storedName, now],
      ).run();
      return Number(result.lastInsertRowid);
    },

    softDeleteFile(id) {
      const result = bind('UPDATE team_files SET deleted = 1 WHERE id = ? AND deleted = 0', [id]).run();
      return Number(result.changes) > 0;
    },

    /* ── 群聊 ───────────────────────────────────────────────────────── */

    /**
     * 取消息。
     *
     * `after > 0`（轮询「有没有新消息」）→ 按 id 升序取比它新的那几条；
     * `after` 缺省（刚进页面）→ 按 id 倒序取最近 limit 条，调用方自己反转回来。
     * 两个方向都走 `idx_team_messages_team (team_id, id DESC)`：升序那条会顺着索引反向扫，
     * 不会退化成全表扫。
     */
    listMessages({ teamId, viewerId, after = 0, limit = 30 }) {
      const order = after > 0 ? 'ASC' : 'DESC';
      return bind(
        `SELECT${MESSAGE_COLUMNS}${MESSAGE_FROM}
     WHERE m.team_id = ? AND m.deleted = 0 AND m.id > ?
     ORDER BY m.id ${order}
     LIMIT ?`,
        [...messageColumnParams(viewerId), teamId, after, limit],
      ).all();
    },

    countMessages(teamId) {
      const row = bind('SELECT COUNT(*) AS total FROM team_messages WHERE team_id = ? AND deleted = 0', [teamId]).get();
      return Number(row?.total) || 0;
    },

    /** 团队里最新一条消息的 id（前端轮询的游标起点；没有消息就是 0）。 */
    latestMessageId(teamId) {
      const row = bind('SELECT MAX(id) AS latest FROM team_messages WHERE team_id = ? AND deleted = 0', [teamId]).get();
      return Number(row?.latest) || 0;
    },

    messageById({ id, viewerId }) {
      return bind(`SELECT${MESSAGE_COLUMNS}${MESSAGE_FROM}\n     WHERE m.id = ? AND m.deleted = 0`, [
        ...messageColumnParams(viewerId),
        id,
      ]).get() ?? null;
    },

    createMessage({ teamId, userId, content, now = Date.now() }) {
      const result = bind(
        `INSERT INTO team_messages (team_id, user_id, content, deleted, created_at)
     VALUES (?, ?, ?, 0, ?)`,
        [teamId, userId, content, now],
      ).run();
      return Number(result.lastInsertRowid);
    },

    softDeleteMessage(id, now = Date.now()) {
      const result = bind('UPDATE team_messages SET deleted = 1 WHERE id = ? AND deleted = 0', [id]).run();
      return Number(result.changes) > 0;
    },
  };
}
