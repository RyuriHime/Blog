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
     *
     * `repost` 区分这张卡片是「🔁 转发」还是「🔗 引用」：两者都是
     * `ref_post_id` 指着一篇帖子、渲染出来一模一样，只有当事人知道自己是
     * 点的哪颗按钮（转发的还多一条 `reposts` 记录，见 `ITEM_COLUMNS` 的
     * `ref_repost`）。转发的撤销由 core 广播事件来同步，这里只负责显示。
     */
    ref: row.ref_post_id
      ? {
          id: Number(row.ref_post_id),
          title: row.ref_title ?? '（帖子已删除）',
          deleted: Boolean(row.ref_deleted),
          repost: Boolean(row.ref_repost),
          author: row.ref_username
            ? {
                username: row.ref_username,
                displayName: row.ref_display || row.ref_username,
                avatar: row.ref_avatar ?? null,
              }
            : null,
        }
      : null,
    /**
     * 被转发的原动态（转发 = 一条 `ref_feed_id` 指着它的普通动态）。
     *
     * 和 `ref` 同一个态度：原动态删了**不把这条转发也藏起来**，只把正文换成
     * 一句「原动态已删除」—— 转发语是转发的人当时说的话，不该跟着消失。
     * 这里只带渲染卡片够用的字段（正文 + 作者），不带回复/互动计数：
     * 那是原动态自己的事，点进去看就行，否则一页 20 条转发要再拉 20 套。
     */
    refFeed: row.ref_feed_id
      ? {
          id: Number(row.ref_feed_id),
          content: String(row.ref_feed_content ?? ''),
          contentHtml: renderMarkdown(String(row.ref_feed_content ?? '')),
          deleted: Boolean(row.ref_feed_deleted),
          createdAt: row.ref_feed_created,
          author: row.ref_feed_username
            ? {
                id: Number(row.ref_feed_user_id),
                username: row.ref_feed_username,
                displayName: row.ref_feed_display || row.ref_feed_username,
                avatar: row.ref_feed_avatar ?? null,
                role: row.ref_feed_role ?? 'member',
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
    /**
     * 回复条数。列表页只显示一个数字，回复正文要展开或进详情才拉 ——
     * 时间线一页 20 条，每条都把回复带上会让首屏多 20 次查询。
     */
    replyCount: Number(row.reply_count) || 0,
    /** 被转发了多少次（别人转的，不含我自己那条）。 */
    repostCount: Number(row.repost_count) || 0,
    /** 我转过这条没有 —— 决定那颗「🔁 转发」按钮显示「转发」还是「已转发」。 */
    reposted: Boolean(row.reposted),
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

/**
 * 一条动态回复的对外形状。
 *
 * 与 `shapeFeedItem` 共用同一个 `renderMarkdown`（服务端渲染），
 * 所以回复里写 Markdown 和 LaTeX 的体验跟发动态一模一样。
 * `itemId` 一定要带上：前端发完回复要靠它知道往哪条动态下面插。
 */
export function shapeFeedReply(row) {
  if (!row) return null;
  const content = String(row.content ?? '');

  return {
    id: row.id,
    itemId: Number(row.feed_item_id),
    content,
    contentHtml: renderMarkdown(content),
    author: {
      id: row.user_id,
      username: row.username,
      displayName: row.display_name || row.username,
      avatar: row.avatar ?? null,
      role: row.role ?? 'member',
    },
    createdAt: row.created_at,
  };
}

export function shapeFeedReplies(rows) {
  return (rows ?? []).map(shapeFeedReply);
}

export { SCOPE_LABELS };
