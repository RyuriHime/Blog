// core 路由：帖子列表 / 帖子详情 / 发帖 / 互动
// // 搬运自 src/server.js 的固定行区间（预铺骨架，逐字未改），见 docs/tools/extract-server-modules.mjs。
import { ensure, field, HttpError, ok, rateLimit, res_ } from '../../core/http.js';
import { assertPinAllowed, notifyMentions, resolveOwnCategory, shapeAuthor, shapeCategory, shapeConversation, shapeMessage, shapeNotification, shapePerson, shapePostDetail, shapePostListRow, shapeProfile, shapeReply, shapeReposter, shapeUser } from '../../core/shape.js';
import { assertPostVisible, isOwner, isStaff, requireOwner, requireStaff, requireUser } from '../../core/guards.js';
import { issueSession, removeAvatarFile, saveAvatarFile, sessionCookie } from '../../core/sessions.js';
import { store } from '../../core/store.js';
import { ANON, MAX_AVATAR_BYTES } from '../../core/paths.js';
import { renderMarkdown, markdownToPlainText } from '../../markdown.js';
import { hashPassword, verifyPassword } from '../../password.js';

/** 登记本文件负责的路由。 */
export function registerRoutesB(route) {
  /* ---------------- 帖子 ---------------- */

  function resolveListView(ctx) {
    const boardSlug = ctx.query.get('board');
    let boardId = null;
    if (boardSlug) {
      const board = store.boardBySlug(boardSlug);
      ensure(board, 404, 'board_not_found', '板块不存在');
      boardId = board.id;
    }
    let authorId = null;
    if (ctx.query.get('author')) {
      const author = store.userByUsername(ctx.query.get('author'));
      ensure(author, 404, 'user_not_found', '用户不存在');
      authorId = author.id;
    }
    const q = (ctx.query.get('q') || '').trim().slice(0, 60);
    const sort = ['latest', 'hot', 'active'].includes(ctx.query.get('sort')) ? ctx.query.get('sort') : 'latest';
    const page = Math.max(1, Number(ctx.query.get('page') || 1) || 1);
    const perPage = Math.min(30, Math.max(5, Number(ctx.query.get('perPage') || 10) || 10));
    const bookmarkedBy = ctx.query.get('bookmarked') === '1' ? requireUser(ctx).id : null;
    const followingBy = ctx.query.get('following') === '1' ? requireUser(ctx).id : null;
    return {
      boardId,
      authorId,
      q,
      sort,
      page,
      perPage,
      bookmarkedBy,
      followingBy,
      // 管理团队可以看到被隐藏的文章（列表里会打「已隐藏」标记）
      includeHidden: isStaff(ctx.user),
      // 拉黑过滤：我和对方任意一方拉黑了对方，列表里就互相看不到
      hideBlockedFor: ctx.user?.id ?? ANON,
      viewerId: ctx.user?.id ?? ANON,
    };
  }

  route('GET', '/api/posts', async (ctx) => {
    const view = resolveListView(ctx);
    const total = store.countPosts(view);
    const rows = store.listPosts(view);
    ok(res_(ctx), {
      items: rows.map(shapePostListRow),
      page: view.page,
      perPage: view.perPage,
      total,
      totalPages: Math.max(1, Math.ceil(total / view.perPage)),
      sort: view.sort,
    });
  });

  route('GET', '/api/posts/:id', async (ctx) => {
    const id = Number(ctx.params.id);
    ensure(Number.isInteger(id) && id > 0, 400, 'bad_id', '帖子编号不正确');
    const row = store.postById(id, ctx.user?.id ?? ANON);
    ensure(row, 404, 'post_not_found', '帖子不存在或已被删除');
    assertPostVisible(row, ctx);
    // 作者拉黑了我（或我拉黑了作者）→ 当作不存在，避免通过直链绕过
    ensure(
      !ctx.user || !store.blocksBetween(ctx.user.id, row.author_id),
      404,
      'post_not_found',
      '帖子不存在或已被删除',
    );
    const isAuthor = ctx.user?.id === row.author_id;
    if (!isAuthor && !row.hidden) store.bumpViews(id);

    ok(res_(ctx), {
      post: {
        ...shapePostDetail({ ...row, views: row.views + (isAuthor || row.hidden ? 0 : 1) }),
      },
      replies: store.listReplies(id, ctx.user?.id ?? ANON).map(shapeReply),
      reposters: store.listReposters(id).map(shapeReposter),
    });
  });

  route('POST', '/api/posts', async (ctx) => {
    const user = requireUser(ctx);
    rateLimit(`post:${user.id}`, 15, 10 * 60 * 1000);
    const boardId = Number(ctx.body.boardId);
    ensure(store.boardById(boardId), 400, 'bad_board', '请选择要发布到的板块');
    const title = field(ctx.body.title, { label: '标题', min: 2, max: 80 });
    const content = field(ctx.body.content, { label: '正文', min: 2, max: 20000 });
    const categoryId = resolveOwnCategory(user, ctx.body.categoryId);
    const wantPin = Boolean(ctx.body.profilePinned);
    if (wantPin) assertPinAllowed(user);

    const id = store.createPost({ boardId, userId: user.id, title, content });
    if (categoryId) store.setPostCategory(id, categoryId);
    if (wantPin) store.setProfilePin(id, true);

    // 通知关注我的人：我发新帖了（同一人对同一帖子只保留一条未读通知）
    for (const follower of store.listFollowers(user.id)) {
      store.createNotification({
        userId: follower.id,
        actorId: user.id,
        type: 'following_post',
        postId: id,
        excerpt: title,
      });
    }
    notifyMentions({ content, actorId: user.id, postId: id });

    ok(res_(ctx), { id });
  });

  route('PUT', '/api/posts/:id', async (ctx) => {
    const user = requireUser(ctx);
    const id = Number(ctx.params.id);
    const row = store.postById(id, user.id);
    ensure(row, 404, 'post_not_found', '帖子不存在');
    ensure(row.author_id === user.id || isStaff(user), 403, 'forbidden', '只能编辑自己的帖子');
    const boardId = ctx.body.boardId ? Number(ctx.body.boardId) : row.board_id;
    ensure(store.boardById(boardId), 400, 'bad_board', '板块不存在');
    const title = field(ctx.body.title, { label: '标题', min: 2, max: 80 });
    const content = field(ctx.body.content, { label: '正文', min: 2, max: 20000 });
    const pinProvided = ctx.body.profilePinned !== undefined;
    if (pinProvided && ctx.body.profilePinned) {
      assertPinAllowed(user, { alreadyPinned: Boolean(row.profile_pinned) });
    }

    store.updatePost({ id, boardId, title, content });
    if (ctx.body.categoryId !== undefined) store.setPostCategory(id, resolveOwnCategory(user, ctx.body.categoryId));
    if (pinProvided) store.setProfilePin(id, Boolean(ctx.body.profilePinned));
    ok(res_(ctx), { id });
  });

  route('DELETE', '/api/posts/:id', async (ctx) => {
    const user = requireUser(ctx);
    const id = Number(ctx.params.id);
    const row = store.postById(id, user.id);
    ensure(row, 404, 'post_not_found', '帖子不存在');
    ensure(row.author_id === user.id || isStaff(user), 403, 'forbidden', '没有权限删除这个帖子');
    store.softDeletePost(id);
    if (row.author_id !== user.id) {
      const label = isOwner(user) ? '站长' : '管理员';
      store.createNotification({
        userId: row.author_id,
        actorId: user.id,
        type: 'moderation',
        postId: id,
        excerpt: `${label}删除了你的文章：${row.title}`,
      });
      store.logModeration({
        actorId: user.id,
        action: 'delete_post',
        targetType: 'post',
        targetId: id,
        targetLabel: row.title,
      });
    }
    ok(res_(ctx), { deleted: true });
  });

  /* ---------------- 管理：隐藏 / 恢复文章（站长 + 管理员） ---------------- */

  route('POST', '/api/admin/posts/:id/hide', async (ctx) => {
    const user = requireStaff(ctx);
    const id = Number(ctx.params.id);
    const row = store.postRow(id);
    ensure(row && !row.deleted, 404, 'post_not_found', '帖子不存在');

    const hidden = Boolean(ctx.body.hidden);
    const reason =
      ctx.body.reason === undefined || ctx.body.reason === null
        ? ''
        : field(ctx.body.reason, { label: '隐藏原因', min: 0, max: 100 });

    store.setPostHidden(id, hidden, { byUserId: user.id, reason });

    const label = isOwner(user) ? '站长' : '管理员';
    if (row.user_id !== user.id) {
      store.createNotification({
        userId: row.user_id,
        actorId: user.id,
        type: 'moderation',
        postId: id,
        excerpt: hidden
          ? `${label}隐藏了你的文章：${row.title}${reason ? `（原因：${reason}）` : ''}`
          : `${label}恢复了你的文章显示：${row.title}`,
      });
    }
    store.logModeration({
      actorId: user.id,
      action: hidden ? 'hide_post' : 'unhide_post',
      targetType: 'post',
      targetId: id,
      targetLabel: row.title,
      reason,
    });

    const detail = store.postById(id, user.id);
    ok(res_(ctx), {
      postId: id,
      hidden,
      hiddenReason: reason,
      hiddenBy: user.id,
      post: detail ? shapePostListRow(detail) : null,
      hiddenCount: store.hiddenPostCount(),
    });
  });

  /* ---------------- 评价：赞 / 踩 ---------------- */

  route('POST', '/api/posts/:id/reaction', async (ctx) => {
    const user = requireUser(ctx);
    const id = Number(ctx.params.id);
    const post = store.postById(id, user.id);
    ensure(post, 404, 'post_not_found', '帖子不存在');
    assertPostVisible(post, ctx);
    ensure(!post.locked || isStaff(user), 403, 'locked', '该帖子已锁定，暂时不能评价');
    const kind = ctx.body.kind;
    ensure(kind === 'like' || kind === 'dislike', 400, 'bad_kind', '只支持「赞」或「踩」');

    const result = store.setReaction(user.id, id, kind);
    if (result.changed && (result.liked || result.disliked)) {
      store.createNotification({
        userId: post.author_id,
        actorId: user.id,
        type: result.liked ? 'post_like' : 'post_dislike',
        postId: id,
        excerpt: post.title,
      });
    }
    ok(res_(ctx), {
      liked: result.liked,
      disliked: result.disliked,
      likeCount: result.likeCount,
      dislikeCount: result.dislikeCount,
    });
  });

}
