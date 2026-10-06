// 团队（P4）的对外形状。
//
// 只做一件事：把数据库行变成前端认识的 JSON。
// 单独成文件是因为列表、详情、发布、编辑几个接口都得用同一份形状 ——
// 形状有第二份实现，就会有「列表有某个字段、详情没有」这类时好时坏的 bug。
import { renderMarkdown } from '../../markdown.js';
import { TEAM_SCOPES, TEAM_ROLES } from './schema.js';

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
  return {
    id: row.id,
    slug: row.slug,
    name: String(row.name ?? ''),
    intro: String(row.intro ?? ''),
    joinPolicy: row.join_policy === 'invite' ? 'invite' : 'open',
    joinPolicyLabel: row.join_policy === 'invite' ? '需要邀请' : '谁都能加入',
    owner: {
      id: row.owner_id,
      username: row.owner_username ?? null,
      displayName: row.owner_display || row.owner_username || '（已注销）',
      avatar: row.owner_avatar ?? null,
    },
    memberCount: Number(row.member_count) || 0,
    postCount: Number(row.post_count) || 0,
    myRole: TEAM_ROLES.includes(row.my_role) ? row.my_role : null,
    myRoleLabel: TEAM_ROLES.includes(row.my_role) ? ROLE_LABELS[row.my_role] : null,
    canManage: TEAM_ROLES.includes(row.my_role) && row.my_role !== 'member',
    joined: flag(row.joined),
    // 「需要邀请」的团队对谁都显示「不能自己加入」—— 包括站长。
    // P4 里没有任何 staff 后门：能管理团队的只有团队成员表里的 owner / admin。
    canJoin: Boolean(viewer) && !flag(row.joined) && row.join_policy !== 'invite',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
    // 能看见就能改：团队帖是大家的东西，一起编辑是这一版的核心需求。
    // 删除则收紧到「作者或团队管理员」—— 不可逆的操作不该人人都有。
    canEdit: isAuthor || myRole !== null,
    canDelete: isAuthor || canManageTeam,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    edited: Number(row.version) > 1,
  };
}

export function shapeTeamPosts(rows, options = {}) {
  return (rows ?? []).map((row) => shapeTeamPost(row, options));
}

export { SCOPE_LABELS, SCOPE_OPTIONS, ROLE_LABELS };
