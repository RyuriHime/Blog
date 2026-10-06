// 团队（P4）的对外形状。
//
// 只做一件事：把数据库行变成前端认识的 JSON。
// 单独成文件是因为列表、详情、发布、编辑几个接口都得用同一份形状 ——
// 形状有第二份实现，就会有「列表有某个字段、详情没有」这类时好时坏的 bug。
import { renderMarkdown } from '../../markdown.js';
import { formatBytes } from './storage.js';
import { TEAM_JOIN_REQUEST_STATUSES, TEAM_SCOPES, TEAM_ROLES } from './schema.js';

/** 可见范围的中文名。与 P1（动态）、P2（积木）用同一套说法。 */
const SCOPE_LABELS = {
  public: '公开',
  followers: '仅关注我的人',
  team: '仅团队',
  private: '仅自己',
};

/** 成员角色的中文名。 */
const ROLE_LABELS = {
  owner: '创建者',
  admin: '管理员',
  member: '成员',
};

/** 可见范围选择器（前端直接拿去画下拉框，不在页面上写死第二份）。 */
const SCOPE_OPTIONS = TEAM_SCOPES.map((value) => ({ value, label: SCOPE_LABELS[value] }));

/** `joined` 在 SQL 里是 NULL / 0 / 1，统一成 boolean。 */
const flag = (value) => Boolean(Number(value ?? 0));

/**
 * 一个团队的对外形状。
 *
 * `myRole` 是**当前浏览者**在这个团队里的角色（没加入就是 null），
 * 前端靠它决定画不画「发帖」「管理」这些按钮。**它只是界面提示** ——
 * 每一次写操作服务端都会重新查一遍成员表，绝不相信前端传来的角色。
 */
export function shapeTeam(row, { viewer = null } = {}) {
  if (!row) return null;
  const myRole = TEAM_ROLES.includes(row.my_role) ? row.my_role : null;
  const joined = flag(row.joined);
  const canManage = Boolean(myRole) && myRole !== 'member';
  const announcement = String(row.announcement ?? '');
  const joinPolicy = row.join_policy === 'apply' ? 'apply' : 'open';
  // 我的最近一条申请（没有就是 null）。待审时前端画「等待审核」而不是「申请加入」。
  const myRequest =
    row.my_request_id == null
      ? null
      : {
          id: Number(row.my_request_id),
          status: row.my_request_status === 'approved' ? 'approved' : row.my_request_status === 'rejected' ? 'rejected' : 'pending',
          createdAt: row.my_request_at ?? null,
        };
  const requestPending = myRequest?.status === 'pending';
  return {
    id: row.id,
    slug: row.slug,
    name: String(row.name ?? ''),
    intro: String(row.intro ?? ''),
    joinPolicy,
    joinPolicyLabel: joinPolicy === 'apply' ? '需要申请' : '谁都能加入',
    /**
     * 团队号：**只给团队成员看**，非成员一律 null。
     *
     * 理由不是「藏起来好看」，是它**本身就是邀请**（见 routes.js 的 join-by-code：
     * 那条路不看 join_policy，号对得上就直接进）—— 给非成员看到，
     * 等于把「需要申请」这个设置当场作废。前端据此决定画不画那一行。
     */
    joinCode: joined || canManage ? String(row.join_code ?? '') || null : null,
    /**
     * 团队公告。`text` 为空串时整体给 null，前端只需判一次「有没有公告」，
     * 而不用同时看 text 和 author 两个字段有没有值。
     *
     * **只有团队成员看得到**（跟 joinCode 同一道门）：公告是写给自己人看的，
     * 里面可能有「周五开会」这类内部安排，不该挂在公开的团队主页上。
     * 通知也只发给成员（见 routes.js 的 PUT announcement）。
     */
    announcement:
      !(joined || canManage) || announcement === ''
        ? null
        : {
            text: announcement,
            editedAt: row.announcement_at ?? null,
            author: row.announcement_by
              ? {
                  id: row.announcement_by,
                  username: row.announcer_username ?? null,
                  displayName: row.announcer_display || row.announcer_username || '（已注销）',
                }
              : null,
          },
    owner: {
      id: row.owner_id,
      username: row.owner_username ?? null,
      displayName: row.owner_display || row.owner_username || '（已注销）',
      avatar: row.owner_avatar ?? null,
    },
    memberCount: Number(row.member_count) || 0,
    postCount: Number(row.post_count) || 0,
    myRole,
    myRoleLabel: myRole ? ROLE_LABELS[myRole] : null,
    canManage,
    joined,
    /**
     * 广场上要不要列这个团队（只有创建者能改，见 routes.js 的 PUT）。
     * 前端据它画那个下拉框 —— **藏起来不等于进不去**，主页与团队号照旧能用。
     */
    listed: flag(row.listed ?? 1),
    /**
     * 「谁都能加入」的团队：登录了、还没在里面 → 一个按钮直接进。
     * 需要申请的团队不许走这条（`canJoin` 为 false，改看 `canApply`）——
     * 两条路必须互斥，否则「需要申请」就是个摆设。
     *
     * ⚠️ 这两个字段都只是界面提示。真正的判定在 routes.js 的 `POST /api/teams/:id/join`：
     * 它每次都会重新读一遍 `join_policy`，前端改一个字节也绕不过去。
     * P4 里没有任何 staff 后门：能管理团队的只有团队成员表里的 owner / admin。
     */
    canJoin: Boolean(viewer) && !joined && joinPolicy === 'open',
    /**
     * 需要申请的团队：登录了、还没在里面、且**没有挂着一条待审申请** → 画「申请加入」。
     * 被拒之后仍然为 true（可以再申请一次）：历史只是记录，不该变成永久封禁。
     */
    canApply: Boolean(viewer) && !joined && joinPolicy === 'apply' && !requestPending,
    /** 我最近一条申请（没有就是 null）。前端靠它区分「没申请过 / 等待审核 / 被拒绝」。 */
    myRequest,
    /**
     * 待审申请数：**只给管理员**，广场卡片上的小红点用它。
     * 对其他人给 0 而不是真数字：不是隐私上的顾虑，而是别人拿这个数字没用，
     * 给出去只会让前端出现「路人看到 3 条待审」这种莫名其妙的界面。
     */
    pendingRequestCount: canManage ? Number(row.pending_request_count) || 0 : 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 一条加入申请的对外形状。
 *
 * `canDecide` 与团队里别的 `canXxx` 一样只是界面提示（服务端每次重判）：
 * 只有 `pending` 的申请能批，批过的再点一次只会拿到 400。
 */
export function shapeJoinRequest(row, { viewer = null } = {}) {
  if (!row) return null;
  const status = TEAM_JOIN_REQUEST_STATUSES.includes(row.status) ? row.status : 'pending';
  const mine = Boolean(viewer) && Number(row.user_id) === Number(viewer.id);
  return {
    id: row.id,
    teamId: row.team_id,
    status,
    statusLabel: status === 'approved' ? '已批准' : status === 'rejected' ? '已拒绝' : '等待审核',
    message: String(row.message ?? ''),
    user: {
      id: row.user_id,
      username: row.username ?? null,
      displayName: row.display_name || row.username || '（已注销）',
      avatar: row.avatar ?? null,
    },
    decidedAt: row.decided_at ?? null,
    decidedBy: row.decided_by
      ? {
          id: row.decided_by,
          username: row.decider_username ?? null,
          displayName: row.decider_display || row.decider_username || '（已注销）',
        }
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    mine,
    canDecide: status === 'pending',
  };
}

/** 一个成员的对外形状。 */
export function shapeMember(row) {
  if (!row) return null;
  return {
    user: {
      id: row.user_id,
      username: row.username,
      displayName: row.display_name || row.username,
      avatar: row.avatar ?? null,
      role: row.role_in_site ?? 'member',
    },
    teamRole: TEAM_ROLES.includes(row.team_role) ? row.team_role : 'member',
    teamRoleLabel: ROLE_LABELS[row.team_role] ?? ROLE_LABELS.member,
    joinedAt: row.joined_at,
  };
}

/**
 * 一条团队帖的对外形状。
 *
 * `version` 必须原样给前端：编辑页拿它当「我看到的版本」，
 * 保存时带回来做乐观并发比对。少了这个字段，「不互相覆盖」就无从谈起。
 *
 * `canEdit` 同样是界面提示，服务端每次都会重判。
 */
export function shapeTeamPost(row, { viewer = null, team = null } = {}) {
  if (!row) return null;
  const content = String(row.content ?? '');
  const isAuthor = Boolean(viewer) && viewer.id === row.user_id;
  const myRole = TEAM_ROLES.includes(row.my_role) ? row.my_role : null;
  const canManageTeam = myRole === 'owner' || myRole === 'admin';

  return {
    id: row.id,
    teamId: row.team_id,
    team: team
      ? { id: team.id, slug: team.slug, name: team.name }
      : row.team_slug
        ? { id: row.team_id, slug: row.team_slug, name: row.team_name ?? '' }
        : null,
    title: String(row.title ?? ''),
    content,
    contentHtml: renderMarkdown(content),
    scope: TEAM_SCOPES.includes(row.scope) ? row.scope : 'team',
    scopeLabel: SCOPE_LABELS[row.scope] ?? SCOPE_LABELS.team,
    scopeIcon: { public: '🌍', followers: '👥', team: '🎽', private: '🔒' }[row.scope] ?? '🎽',
    version: Number(row.version) || 1,
    // 列表里显示「N 条回复」用；详情页的回复本身另走 /replies。
    replyCount: Number(row.reply_count) || 0,
    author: {
      id: row.user_id,
      username: row.username,
      displayName: row.display_name || row.username,
      avatar: row.avatar ?? null,
      role: row.role ?? 'member',
    },
    editor: row.editor_username
      ? {
          id: row.updated_by,
          username: row.editor_username,
          displayName: row.editor_display || row.editor_username,
        }
      : null,
    // 编辑权只给作者本人：改别人的话既不打招呼也不留痕，想补充就回帖。
    // （早先这里是「看得见就能改」，后来收紧了 —— 团队帖能一起看、一起回，
    //  但「改稿」这件事得由写它的人自己决定。）
    // 删除仍然是「作者或团队管理员」—— 删掉了管理员还能找回，改稿没有这一层。
    canEdit: isAuthor,
    canDelete: isAuthor || canManageTeam,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    edited: Number(row.version) > 1,
  };
}

export function shapeTeamPosts(rows, options = {}) {
  return (rows ?? []).map((row) => shapeTeamPost(row, options));
}

/**
 * 一条回复的对外形状。
 *
 * 比帖子少了 `scope` / `version` / `editor`：回复不单独设可见范围（跟着帖子走），
 * 也不做协同编辑与版本比对 —— 它是一句话，不是一篇文档。
 * `canDelete` 与帖子同一条口径：作者本人，或这个团队的管理员（服务端重判）。
 */
export function shapeTeamReply(row, { viewer = null } = {}) {
  if (!row) return null;
  const content = String(row.content ?? '');
  const isAuthor = Boolean(viewer) && viewer.id === row.user_id;
  const myRole = TEAM_ROLES.includes(row.my_role) ? row.my_role : null;

  return {
    id: row.id,
    postId: row.post_id,
    teamId: row.team_id,
    content,
    contentHtml: renderMarkdown(content),
    author: {
      id: row.user_id,
      username: row.username,
      displayName: row.display_name || row.username,
      avatar: row.avatar ?? null,
      role: row.role ?? 'member',
    },
    canDelete: isAuthor || myRole === 'owner' || myRole === 'admin',
    createdAt: row.created_at,
  };
}

export function shapeTeamReplies(rows, options = {}) {
  return (rows ?? []).map((row) => shapeTeamReply(row, options));
}

/**
 * 一个文件的对外形状（文件柜）。
 *
 * `downloadUrl` 由服务端给出，而不是让前端自己拼 `/api/team-files/<id>`：
 * 下载地址属于接口契约，写在前端就有第二份实现（换个前缀前端就全坏）。
 * 链接带上 `?name=` 也没必要 —— 下载时的那句 `Content-Disposition`
 * 用的是库里的原名，浏览器拿到的文件名就是对的。
 */
export function shapeFile(row, { viewer = null, team = null } = {}) {
  if (!row) return null;
  const myRole = TEAM_ROLES.includes(row.my_role) ? row.my_role : null;
  const canManageTeam = myRole === 'owner' || myRole === 'admin';
  const isUploader = Boolean(viewer) && viewer.id === row.user_id;

  return {
    id: row.id,
    teamId: row.team_id,
    team: team ? { id: team.id, slug: team.slug, name: team.name } : null,
    name: String(row.name ?? ''),
    size: Number(row.size) || 0,
    sizeLabel: formatBytes(row.size),
    mime: String(row.mime ?? ''),
    uploader: {
      id: row.user_id,
      username: row.username ?? null,
      displayName: row.display_name || row.username || '（已注销）',
      avatar: row.avatar ?? null,
    },
    downloadUrl: `/api/team-files/${row.id}`,
    // 与团队帖同一条规矩：删不可逆，所以只给上传者本人和团队管理员。
    canDelete: isUploader || canManageTeam,
    createdAt: row.created_at,
  };
}

export function shapeFiles(rows, options = {}) {
  return (rows ?? []).map((row) => shapeFile(row, options));
}

/**
 * 一条群聊消息的对外形状。
 *
 * 只给纯文本：前端用 `esc()` 转义后按预格式化显示，**不做 Markdown 渲染**。
 * 聊天内容里出现 `<img onerror=…>` 时，这一条就是防线。
 */
export function shapeMessage(row, { viewer = null } = {}) {
  if (!row) return null;
  const myRole = TEAM_ROLES.includes(row.my_role) ? row.my_role : null;
  const canManageTeam = myRole === 'owner' || myRole === 'admin';
  const isAuthor = Boolean(viewer) && viewer.id === row.user_id;

  return {
    id: row.id,
    teamId: row.team_id,
    content: String(row.content ?? ''),
    author: {
      id: row.user_id,
      username: row.username ?? null,
      displayName: row.display_name || row.username || '（已注销）',
      avatar: row.avatar ?? null,
    },
    canDelete: isAuthor || canManageTeam,
    createdAt: row.created_at,
  };
}

export function shapeMessages(rows, options = {}) {
  return (rows ?? []).map((row) => shapeMessage(row, options));
}

export { SCOPE_LABELS, SCOPE_OPTIONS, ROLE_LABELS };
