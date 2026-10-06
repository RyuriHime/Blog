// core 路由：分类与置顶 / 收藏 / 关注 / 黑名单 / 私信
// // 搬运自 src/server.js 的固定行区间（预铺骨架，逐字未改），见 docs/tools/extract-server-modules.mjs。
import { HttpError, ensure, field, ok, rateLimit, res_ } from '../../core/http.js';
import { assertPinAllowed, notifyMentions, resolveOwnCategory, shapeAuthor, shapeCategory, shapeConversation, shapeMessage, shapeNotification, shapePerson, shapePostDetail, shapePostListRow, shapeProfile, shapeReply, shapeReposter, shapeUser } from '../../core/shape.js';
import { assertPostVisible, isOwner, isStaff, requireOwner, requireStaff, requireUser } from '../../core/guards.js';
import { issueSession, removeAvatarFile, saveAvatarFile, sessionCookie } from '../../core/sessions.js';
import { store } from '../../core/store.js';
import { ANON, MAX_AVATAR_BYTES } from '../../core/paths.js';
import { renderMarkdown, markdownToPlainText } from '../../markdown.js';
import { hashPassword, verifyPassword } from '../../password.js';

/** 登记本文件负责的路由。 */
export function registerRoutesC(route) {
  /* ---------------- 个人主页：文章分类与置顶 ---------------- */

  route('POST', '/api/posts/:id/category', async (ctx) => {
    const user = requireUser(ctx);
    const id = Number(ctx.params.id);
    const post = store.postById(id, user.id);
    ensure(post, 404, 'post_not_found', '帖子不存在');
    ensure(post.author_id === user.id, 403, 'forbidden', '只能整理自己的文章');
    const categoryId = resolveOwnCategory(user, ctx.body.categoryId ?? null);
    store.setPostCategory(id, categoryId);
    ok(res_(ctx), {
      postId: id,
      category: categoryId ? shapeCategory(store.profileCategoryById(categoryId)) : null,
      uncategorizedCount: store.uncategorizedCount(user.id),
    });
  });

  route('POST', '/api/posts/:id/profile-pin', async (ctx) => {
    const user = requireUser(ctx);
    const id = Number(ctx.params.id);
    const post = store.postById(id, user.id);
    ensure(post, 404, 'post_not_found', '帖子不存在');
    ensure(post.author_id === user.id, 403, 'forbidden', '只能置顶自己的文章');
    const pinned = Boolean(ctx.body.pinned);
    if (pinned) assertPinAllowed(user, { alreadyPinned: Boolean(post.profile_pinned) });
    store.setProfilePin(id, pinned);
    ok(res_(ctx), {
      postId: id,
      profilePinned: pinned,
      pinnedCount: store.profilePinCount(user.id),
      pinLimit: store.profilePinLimit(),
    });
  });

  /* ---------------- 转发 ---------------- */

  route('POST', '/api/posts/:id/repost', async (ctx) => {
    const user = requireUser(ctx);
    const id = Number(ctx.params.id);
    const post = store.postById(id, user.id);
    ensure(post, 404, 'post_not_found', '帖子不存在');
    assertPostVisible(post, ctx);
    ensure(post.author_id !== user.id, 400, 'self_repost', '这是你自己的文章，不用转发啦');
    ensure(!post.locked || isStaff(user), 403, 'locked', '该帖子已锁定，暂时不能转发');

    const comment = ctx.body.comment === undefined || ctx.body.comment === null
      ? ''
      : field(ctx.body.comment, { label: '转发语', min: 0, max: 300 });
    const result = store.createRepost({ postId: id, userId: user.id, comment });

    // 只在「第一次转发」时通知作者，改转发语不重复打扰
    if (!result.updated) {
      store.createNotification({
        userId: post.author_id,
        actorId: user.id,
        type: 'post_repost',
        postId: id,
        excerpt: comment || post.title,
      });
    }
    ok(res_(ctx), result);
  });

  route('DELETE', '/api/posts/:id/repost', async (ctx) => {
    const user = requireUser(ctx);
    const id = Number(ctx.params.id);
    const result = store.deleteRepost(id, user.id);
    if (result.error === 'not_reposted') throw new HttpError(400, 'not_reposted', '你还没有转发过这篇');
    ok(res_(ctx), result);
  });

  /* ---------------- 收藏 ---------------- */
  route('POST', '/api/posts/:id/bookmark', async (ctx) => {
    const user = requireUser(ctx);
    const id = Number(ctx.params.id);
    const bookmarkedPost = store.postById(id, user.id);
    ensure(bookmarkedPost, 404, 'post_not_found', '帖子不存在');
    assertPostVisible(bookmarkedPost, ctx);
    ensure(!bookmarkedPost.locked || isStaff(user), 403, 'locked', '该帖子已锁定，暂时不能收藏');
    ok(res_(ctx), store.toggleBookmark(user.id, id));
  });

  /* ---------------- 回复 ---------------- */

  route('POST', '/api/posts/:id/replies', async (ctx) => {
    const user = requireUser(ctx);
    rateLimit(`reply:${user.id}`, 40, 10 * 60 * 1000);
    const id = Number(ctx.params.id);
    const post = store.postById(id, user.id);
    ensure(post, 404, 'post_not_found', '帖子不存在');
    assertPostVisible(post, ctx);
    ensure(!post.locked || isStaff(user), 403, 'locked', '该帖子已锁定，无法回复');
    const content = field(ctx.body.content, { label: '回复内容', min: 1, max: 5000 });
    const replyId = store.createReply({ postId: id, userId: user.id, content });
    const created = store.listReplies(id, user.id).find((reply) => reply.id === replyId);

    store.createNotification({
      userId: post.author_id,
      actorId: user.id,
      type: 'post_reply',
      postId: id,
      replyId,
      excerpt: markdownToPlainText(content, 60),
    });
    notifyMentions({ content, actorId: user.id, postId: id, replyId });

    ok(res_(ctx), { reply: shapeReply(created), replyCount: store.countReplies(id) });
  });

  route('DELETE', '/api/replies/:id', async (ctx) => {
    const user = requireUser(ctx);
    const id = Number(ctx.params.id);
    const reply = store.replyById(id);
    ensure(reply && !reply.deleted, 404, 'reply_not_found', '回复不存在');
    const post = store.postById(reply.post_id, user.id);
    const allowed = reply.user_id === user.id || post?.author_id === user.id || isStaff(user);
    ensure(allowed, 403, 'forbidden', '没有权限删除这条回复');
    store.softDeleteReply(id);
    ok(res_(ctx), { deleted: true });
  });

  /* ---------------- 关注 ---------------- */

  route('POST', '/api/users/:id/follow', async (ctx) => {
    const user = requireUser(ctx);
    const id = Number(ctx.params.id);
    ensure(store.userById(id), 404, 'user_not_found', '用户不存在');
    const result = store.toggleFollow(user.id, id);
    if (result.error === 'self_follow') throw new HttpError(400, 'self_follow', '不能关注自己');
    if (result.error === 'blocked_by_me') {
      throw new HttpError(403, 'blocked_by_me', '你已把对方拉黑，先解除黑名单才能关注');
    }
    if (result.error === 'blocked_me') {
      throw new HttpError(403, 'blocked_me', '对方已将你拉黑，无法关注 TA');
    }
    ensure(!result.error, 400, 'follow_failed', '关注失败');

    if (result.following) {
      store.createNotification({ userId: id, actorId: user.id, type: 'follow' });
    }
    ok(res_(ctx), { following: result.following, followerCount: result.followerCount });
  });

  /* ---------------- 黑名单 ---------------- */

  route('POST', '/api/users/:id/block', async (ctx) => {
    const user = requireUser(ctx);
    const id = Number(ctx.params.id);
    ensure(store.userById(id), 404, 'user_not_found', '用户不存在');
    const blocked = ctx.body.blocked === undefined ? true : Boolean(ctx.body.blocked);
    const result = blocked ? store.blockUser(user.id, id) : store.unblockUser(user.id, id);
    if (result.error === 'self_block') throw new HttpError(400, 'self_block', '不能拉黑自己');
    ok(res_(ctx), {
      blocked: result.blocked,
      changed: result.changed,
      blockCount: store.blockCount(user.id),
      following: false,
    });
  });

  route('GET', '/api/me/blocks', async (ctx) => {
    const user = requireUser(ctx);
    ok(res_(ctx), {
      items: store.listBlocks(user.id).map(shapePerson),
      total: store.blockCount(user.id),
    });
  });

  /* ---------------- 私信 ---------------- */

  route('GET', '/api/messages/summary', async (ctx) => {
    if (!ctx.user) return ok(res_(ctx), { unread: 0 });
    ok(res_(ctx), {
      unread: store.unreadMessageCount(ctx.user.id),
      conversations: store.listConversations(ctx.user.id).length,
    });
  });

  route('GET', '/api/messages', async (ctx) => {
    const user = requireUser(ctx);
    ok(res_(ctx), {
      items: store.listConversations(user.id).map((row) => shapeConversation(row, user.id)),
      unread: store.unreadMessageCount(user.id),
      rules: store.MESSAGE_RULES,
    });
  });

  /** 会话详情：打开即把对方发来的消息标记为已读 */
  route('GET', '/api/messages/:username', async (ctx) => {
    const user = requireUser(ctx);
    const peer = store.userByUsername(ctx.params.username);
    ensure(peer, 404, 'user_not_found', '用户不存在');
    ensure(peer.id !== user.id, 400, 'self_thread', '不能和自己私信');
    if (store.isBlocked(peer.id, user.id)) {
      throw new HttpError(403, 'blocked_me', '对方已将你拉黑，无法查看会话');
    }

    const messages = store.listThread(user.id, peer.id);
    const unreadBefore = store.unreadFromPeer(user.id, peer.id);
    if (unreadBefore > 0) store.markThreadRead(user.id, peer.id);

    ok(res_(ctx), {
      peer: shapePerson(peer),
      messages: messages.map(shapeMessage),
      total: store.countThread(user.id, peer.id),
      unreadBefore,
      availability: store.messageAvailability(user.id, peer),
      rules: store.MESSAGE_RULES,
    });
  });

  route('POST', '/api/messages/:username', async (ctx) => {
    const user = requireUser(ctx);
    rateLimit(`message:${user.id}`, 60, 10 * 60 * 1000);
    const peer = store.userByUsername(ctx.params.username);
    ensure(peer, 404, 'user_not_found', '用户不存在');

    const availability = store.messageAvailability(user.id, peer);
    if (!availability.canSend) {
      const status =
        availability.reason === 'daily_limit' ? 429 : availability.reason === 'self' ? 400 : 403;
      const code = availability.reason === 'self' ? 'self_message' : availability.reason;
      throw new HttpError(status, code, availability.message);
    }

    const content = field(ctx.body.content, { label: '私信内容', min: 1, max: store.MESSAGE_RULES.maxLength });
    const message = store.createMessage({ senderId: user.id, recipientId: peer.id, content });
    store.createNotification({
      userId: peer.id,
      actorId: user.id,
      type: 'message',
      excerpt: markdownToPlainText(content, 60),
    });

    ok(res_(ctx), {
      message: shapeMessage(message),
      availability: store.messageAvailability(user.id, peer),
      unread: store.unreadMessageCount(user.id),
    });
  });

  route('GET', '/api/users/:username', async (ctx) => {
    const row = store.userProfile(ctx.params.username);
    ensure(row, 404, 'user_not_found', '用户不存在');
    const viewerId = ctx.user?.id ?? ANON;
    const isMe = viewerId === row.id;

    // 拉黑关系：对方拉黑了我 → 我连 TA 的主页都打不开；我拉黑了对方 → 能打开但看不到文章
    const blockedByMe = !isMe && viewerId !== ANON && store.isBlocked(viewerId, row.id);
    if (!isMe && viewerId !== ANON && store.isBlocked(row.id, viewerId)) {
      throw new HttpError(404, 'user_not_found', '用户不存在或已被屏蔽');
    }
    const mutualFollow = viewerId !== ANON && !isMe ? store.areMutualFollowers(viewerId, row.id) : false;

    // 个人主页的文章筛选：?category=<id> | none | reposts
    const categoryParam = ctx.query.get('category');
    const filter = {};
    const showReposts = categoryParam === 'reposts';
    if (categoryParam === 'none') {
      filter.uncategorized = true;
    } else if (categoryParam && !showReposts) {
      const categoryId = Number(categoryParam);
      const category = store.profileCategoryById(categoryId);
      ensure(category && category.user_id === row.id, 404, 'category_not_found', '分类不存在');
      filter.categoryId = categoryId;
    }

    // 我拉黑了对方：主页能看到（方便解除），但内容一律不展示
    const posts = blockedByMe
      ? []
      : showReposts
      ? store.listRepostedPosts(row.id, viewerId).map((item) => ({
          ...shapePostListRow(item),
          repost: {
            id: item.repost.id,
            comment: item.repost.comment,
            createdAt: item.repost.createdAt,
          },
        }))
      : store
          .listPosts({
            authorId: row.id,
            perPage: 50,
            sort: 'profile',
            viewerId,
            // 被隐藏的文章只有作者本人和管理团队能看到
            includeHidden: isMe || isStaff(ctx.user),
            ...filter,
          })
          .map(shapePostListRow);

    ok(res_(ctx), {
      user: shapeProfile(row, {
        isMe,
        isFollowing: store.isFollowing(viewerId, row.id),
        followsMe: viewerId !== ANON && !isMe ? store.isFollowing(row.id, viewerId) : false,
        mutualFollow,
        blockedByMe,
      }),
      ...(isMe || viewerId === ANON
        ? {}
        : { messageAvailability: store.messageAvailability(viewerId, row) }),
      repostCount: store.repostCountByUser(row.id),
      categories: store.listProfileCategories(row.id).map(shapeCategory),
      uncategorizedCount: store.uncategorizedCount(row.id),
      pinnedCount: store.profilePinCount(row.id),
      pinLimit: store.profilePinLimit(),
      categoryLimit: store.profileCategoryLimit(),
      filter: categoryParam ?? 'all',
      followers: store.listFollowers(row.id, viewerId).map(shapePerson),
      following: store.listFollowing(row.id).map(shapePerson),
      posts,
    });
  });

  route('GET', '/api/me/following', async (ctx) => {
    const user = requireUser(ctx);
    ok(res_(ctx), {
      items: store.listFollowing(user.id).map(shapePerson),
      counts: store.followCounts(user.id),
    });
  });
}
