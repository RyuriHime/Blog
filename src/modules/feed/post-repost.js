// 帖子 / 积木帖的转发 → 动态流里的一条动态。
//
// ── 为什么要做这件事 ──
// 用户的原话（转述同学的意见）：「你参考 b 站，转发视频也是发到动态，转发动态也是发到动态。」
// 也就是说**转发的落点只有一处：动态流**。动态转动态已经是这样了（`ref_feed_id`，见
// `routes.js` 的「转发」那一段），这里补上帖子那一半 —— 转发一篇帖子（含积木帖）
// 会在 `feed_items` 里留一条 `ref_post_id` 指着它的新动态。
//
// ── 为什么不改 `reposts` ──
// `reposts` 那张表管的是另外三件事，一行都不能动：个人主页的「🔁 转发」分类、
// 转发计数、转发者名单。它和这里靠 (user_id, post_id) 一一对应：一起建、一起删，
// 各管各的显示。合并成一张表反而要让主页分类和动态流互相迁就。
//
// ── 为什么是这个方向（core 发、feed 收）──
// `feed_items` 是 feed 的表，core 不碰业务模块的表，所以 core 只广播事件
//（`src/core/repost-events.js`），落不落卡片由这里决定。这和 doc 往 core 的
// `boards` 里写一行「积木」板块是同一类跨模块动作，只是方向反过来。
import { addRepostListener } from '../../core/repost-events.js';

/**
 * 把一次转发同步到动态流。**幂等**：同一个 (userId, postId) 翻来覆去调
 * 也只会有一条动态 —— 转发语改了就是改那一条的正文，不会多出一条。
 *
 * @returns {{ created?: boolean, updated?: boolean, removed?: boolean,
 *   itemId?: number, skipped?: string }} 只用于测试和日志，路由层不看。
 */
export function syncPostRepost({ queries, event }) {
  const action = event?.action;
  const postId = Number(event?.postId);
  const userId = Number(event?.userId);
  if (!Number.isInteger(postId) || postId <= 0) return { skipped: 'bad_post' };
  if (!Number.isInteger(userId) || userId <= 0) return { skipped: 'bad_user' };

  const existing = queries.repostOfPostByUser({ userId, postId });

  if (action === 'delete') {
    if (!existing) return { removed: false };
    queries.softDelete(existing.id);
    return { removed: true, itemId: existing.id };
  }

  /**
   * 非公开的帖子（`hidden = 1`：仅关注者 / 仅团队的积木）**不进公开动态流**。
   *
   * 卡片上印着帖子标题，而动态流是所有人可见的 —— 落一张卡片等于把标题漏出去，
   * 点进去还会 404。转发本身照常生效（个人主页那个分类是按访客过滤的，不会漏）。
   *
   * `existing` 那一支是给「先公开、后转私密」用的：曾经落过卡片就撤掉它，
   * 免得留一张指向打不开的帖子的卡片在流里。
   */
  if (!event?.publiclyVisible) {
    if (existing) queries.softDelete(existing.id);
    return { skipped: 'not_public' };
  }

  if (existing) {
    queries.updateRepostComment({ id: existing.id, content: event.comment ?? '' });
    return { updated: true, itemId: existing.id };
  }

  const itemId = queries.insert({
    userId,
    content: event.comment ?? '',
    // 转发出去的那条动态是公开的：它要出现在所有人的动态流里。
    // （与「动态转动态」同一条规矩 —— 那边也只允许 `scope = 'public'` 的原动态被转。）
    scope: 'public',
    teamId: null,
    images: [],
    refPostId: postId,
    refFeedId: null,
  });
  return { created: true, itemId };
}

/**
 * 订阅 core 的转发事件。在 `install(ctx)` 里调一次。
 * @param {object} queries `createFeedQueries` 的返回值
 */
export function installPostRepostSync(queries) {
  addRepostListener((event) => syncPostRepost({ queries, event }));
}
