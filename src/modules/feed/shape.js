// 动态（P1）的对外形状。
//
// 只做一件事：把数据库行变成前端认识的 JSON。
// 单独成文件是因为列表、详情、发布、编辑四个接口都得用同一份形状 ——
// 形状有第二份实现，就会有「列表有某个字段、详情没有」这类时好时坏的 bug。
import { renderMarkdown } from '../../markdown.js';
import { FEED_SCOPES } from './schema.js';

/** 可见范围的中文名。前端提示、AI 摘要都要用同一套说法。 */
const SCOPE_LABELS = {
  public: '公开',
  followers: '仅关注我的人',
  team: '仅团队',
  private: '仅自己',
};

/** `[{url,type,bytes}]` 存的是 JSON 文本，坏数据不能让整个列表 500。 */
function parseImages(raw) {
  try {
    const parsed = JSON.parse(raw ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item.url === 'string')
      .map((item) => ({
        url: item.url,
        type: String(item.type ?? ''),
        bytes: Number(item.bytes) || 0,
      }));
  } catch {
    return [];
  }
}

/**
 * 一条动态的对外形状。
 *
 * `contentHtml` 由服务端渲染（与帖子同一条管线 `src/markdown.js`），
 * 这样前端不需要重复实现一遍 Markdown；**LaTeX 不在这里渲染** ——
 * KaTeX 是浏览器端的，前端拿到 html 后再对 `$...$` 做一次 auto-render
 * （与帖子详情页完全一致，见 `public/views/notes.js` 的 `ntRenderMath`）。
 */
export function shapeFeedItem(row) {
  if (!row) return null;
  const content = String(row.content ?? '');

  return {
    id: row.id,
    content,
    contentHtml: renderMarkdown(content),
    scope: FEED_SCOPES.includes(row.scope) ? row.scope : 'public',
    scopeLabel: SCOPE_LABELS[row.scope] ?? SCOPE_LABELS.public,
    teamId: row.team_id == null ? null : Number(row.team_id),
    images: parseImages(row.images_json),
    /**
     * 引用的站内帖子卡片（FR-FEED-05）。
     * 引用的帖子被删了**不隐藏这张卡片** —— 动态是当时说的话，
     * 事后悄悄改掉它比留一张「帖子已删除」的卡片更糟。
     */
    ref: row.ref_post_id
      ? {
          id: Number(row.ref_post_id),
          title: row.ref_title ?? '（帖子已删除）',
          deleted: Boolean(row.ref_deleted),
          author: row.ref_username
            ? {
                username: row.ref_username,
                displayName: row.ref_display || row.ref_username,
                avatar: row.ref_avatar ?? null,
              }
            : null,
        }
      : null,
    author: {
      id: row.user_id,
      username: row.username,
      displayName: row.display_name || row.username,
      avatar: row.avatar ?? null,
      role: row.role ?? 'member',
    },
    likeCount: Number(row.like_count) || 0,
    dislikeCount: Number(row.dislike_count) || 0,
    liked: Boolean(row.liked),
    disliked: Boolean(row.disliked),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    edited: Number(row.updated_at) > Number(row.created_at),
  };
}

export function shapeFeedItems(rows) {
  return (rows ?? []).map(shapeFeedItem);
}

export { SCOPE_LABELS };
