// 动态（P1）的 HTTP 接口。
//
// handler 收到的 ctx 形状（与 install 收到的那个 ctx 同名但不是一回事）：
//   { req, res, params, query, user, sessionToken, ip, body }
// 其中 `body` 只在 POST / PUT / PATCH 时被解析过。
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { HttpError, ensure, field } from '../../core/http.js';
import { MAX_FEED_CONTENT, MAX_FEED_IMAGE_BYTES, MAX_FEED_IMAGES } from './schema.js';
import { shapeFeedItem, shapeFeedItems } from './shape.js';

/** 图片只认这三种，和头像同一口径（换成 `data:image/svg+xml` 就等于允许注入脚本）。 */
const IMAGE_EXT = { png: 'png', jpeg: 'jpg', webp: 'webp' };
const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

/** 本站图片地址的**严格**形状。存进库前必须过这一关，否则别人可以塞一个外站 URL 进来当追踪像素。 */
const IMAGE_URL = /^\/api\/feed\/image\/([A-Za-z0-9._-]{1,80})\.(png|jpg|webp)$/;
const IMAGE_NAME = /^[A-Za-z0-9._-]{1,80}\.(png|jpg|webp)$/;

const PAGE_MAX = 50;

/** 用魔数判断图片类型，不信任客户端声明的 MIME（与 `src/core/sessions.js` 同一套）。 */
function sniffImageType(buffer) {
  if (buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'png';
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.length > 12 && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') {
    return 'webp';
  }
  return null;
}

/**
 * 校验并归一化前端传来的图片列表。
 *
 * 前端只发 `[{url}]`（图片字节已经单独走 `POST /api/feed/images` 传过了），
 * 服务端**逐个重新推导** url 是否合法，而不是信任它 —— 这是防「塞外链」的那道门。
 */
function normalizeImages(value) {
  if (value == null) return [];
  ensure(Array.isArray(value), 400, 'bad_images', '图片列表格式不正确');
  ensure(value.length <= MAX_FEED_IMAGES, 400, 'too_many_images', `一条动态最多 ${MAX_FEED_IMAGES} 张图`);

  return value.map((item) => {
    const url = typeof item === 'string' ? item : item?.url;
    ensure(typeof url === 'string' && IMAGE_URL.test(url), 400, 'bad_image_url', '图片地址不合法，请重新上传');
    const name = url.slice('/api/feed/image/'.length);
    return { url, name, type: name.split('.').pop(), bytes: 0 };
  });
}

/**
 * 读回已存着的配图数组（编辑时「body 里没传 images」靠它保命）。
 *
 * 这里**故意不走 `normalizeImages`**：那个函数会重新推导 `name`/`type` 并把 `bytes` 清零，
 * 而此刻我们要的是「原封不动地留住」，不是「重新校验一遍」。
 * 坏 JSON 兜底成空数组 —— 一条坏记录不该让编辑接口 500。
 */
function currentImagesOf(row) {
  try {
    const parsed = JSON.parse(row?.images_json ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function feedImageDir(dbFile) {
  return dbFile === ':memory:' ? join(process.cwd(), 'data', 'feed-images') : join(dirname(dbFile), 'feed-images');
}

/**
 * 注册动态的全部路由。
 *
 * @param {object} ctx   模块 ctx（有 http / guards / shape / options / store）
 * @param {object} deps  { queries }
 */
export function registerFeedRoutes(ctx, { queries }) {
  const add = ctx.routes.add;
  // ⚠️ `ensure` / `field` 必须**直接 import**，不能在这里从 ctx.http 解构：
  // 本文件顶部的 normalizeImages / readScope 这些辅助函数在 registerFeedRoutes 之外，
  // 解构出来的名字它们看不见 —— 症状是「带图动态」报 500 internal_error，
  // 而不是 400，因为抛的是 ReferenceError 而不是 HttpError（踩过一次）。
  const { ok, rateLimit } = ctx.http;
  const { requireUser, assertPostVisible } = ctx.guards;
  // `@人` 通知复用 core 的现成实现（`src/core/shape.js`），不另写一份用户名解析。
  const { collectMentions, notifyMentions } = ctx.shape;
  const imageDir = feedImageDir(ctx.options.dbFile);

  /** 可见范围只认冻结枚举。 */
  function readScope(value, fallback = 'public') {
    const scope = value == null || value === '' ? fallback : String(value);
    ensure(queries.scopes.includes(scope), 400, 'bad_scope', '可见范围只能是：公开 / 仅关注我的人 / 仅团队 / 仅自己');
    return scope;
  }

  /**
   * 引用帖子的校验（FR-FEED-05）。
   *
   * 引用的帖子必须**引用者自己看得见**，否则就成了「拿动态当搜索器探私密帖子存不存在」的洞。
   * 看不见一律报 404（与 v1 隐藏帖的口径一致：不存在，而不是没权限）。
   */
  function readRefPostId(value, user) {
    if (value == null || value === '' || value === 0) return null;
    const id = Number(value);
    ensure(Number.isInteger(id) && id > 0, 400, 'bad_ref', '引用的帖子编号不正确');
    const post = ctx.store.postById(id, user.id);
    ensure(post, 404, 'ref_post_not_found', '要引用的帖子不存在');
    assertPostVisible(post, { user });
    return id;
  }

  function readPage(query) {
    const page = Math.max(1, Number(query.get('page')) || 1);
    const perPage = Math.min(PAGE_MAX, Math.max(1, Number(query.get('perPage')) || 20));
    return { page, perPage };
  }

  /* ---------------- 读：时间线 ---------------- */

  add('GET', '/api/feed', async (reqCtx) => {
    const { page, perPage } = readPage(reqCtx.query);
    const filter = reqCtx.query.get('filter') || 'all';
    ensure(['all', 'following', 'mine'].includes(filter), 400, 'bad_filter', '筛选方式不正确');
    const q = String(reqCtx.query.get('q') ?? '').trim().slice(0, 80);
    const viewerId = reqCtx.user?.id ?? -1;

    const { rows, total } = queries.list({ viewerId, filter, q, page, perPage });
    ok(reqCtx.res, {
      items: shapeFeedItems(rows),
      page,
      perPage,
      total,
      totalPages: Math.max(1, Math.ceil(total / perPage)),
      filter,
      scopes: queries.scopes.map((scope) => ({ value: scope, label: shapeFeedItemLabel(scope) })),
    });
  });

  add('GET', '/api/feed/:id', async (reqCtx) => {
    const id = Number(reqCtx.params.id);
    ensure(Number.isInteger(id) && id > 0, 404, 'feed_not_found', '这条动态不存在');
    const viewerId = reqCtx.user?.id ?? -1;
    const row = queries.byId({ id, viewerId });
    // 看不到就是「不存在」—— 不区分「没有这条」和「你没权限看」，
    // 否则 404/403 的差别本身就成了可见范围的探测信道。
    ensure(row, 404, 'feed_not_found', '这条动态不存在');
    ok(reqCtx.res, { item: shapeFeedItem(row) });
  });

  /* ---------------- 写：发布 / 编辑 / 删除 ---------------- */

  add('POST', '/api/feed', async (reqCtx) => {
    const user = requireUser(reqCtx);
    rateLimit(`feed:create:${user.id}`, 30, 10 * 60 * 1000);

    const content = field(reqCtx.body.content, {
      name: 'content',
      min: 1,
      max: MAX_FEED_CONTENT,
      label: '动态内容',
    });
    const scope = readScope(reqCtx.body.scope);
    const images = normalizeImages(reqCtx.body.images);
    const refPostId = readRefPostId(reqCtx.body.refPostId, user);

    const id = queries.insert({ userId: user.id, content, scope, teamId: null, images, refPostId });

    // @人 通知（FR-FEED-06）。复用 core 的 collectMentions/notifyMentions：
    // 通知类型是 `mention`，`postId` 传 null（动态不是帖子），前端会退回「跳到 @ 的人主页」。
    if (notifyMentions && collectMentions) {
      const names = collectMentions(content);
      if (names.length) notifyMentions({ content, actorId: user.id, postId: null, replyId: null });
    }

    const row = queries.byId({ id, viewerId: user.id, ignoreVisibility: true });
    ok(reqCtx.res, { item: shapeFeedItem(row) });
  });

  /*
   * 编辑是**部分更新**：body 里没出现的字段保持原样，而不是被重置。
   *
   * 为什么不做成「整条替换」：编辑界面只给一个正文输入框，前端如果忘了把
   * `scope` / `images` / `refPostId` 一起回传，一条「仅自己可见」的动态就会被
   * 悄悄改成公开、配图也会凭空消失 —— 这是**静默的数据泄漏 / 丢失**。
   * 把「没传 = 不改」定成默认，这类事故就不可能发生；
   * 要清空配图就显式传 `images: []`，要取消引用就显式传 `refPostId: null`。
   */
  add('PUT', '/api/feed/:id', async (reqCtx) => {
    const user = requireUser(reqCtx);
    const id = Number(reqCtx.params.id);
    const owner = queries.owner(id);
    ensure(owner && !owner.deleted, 404, 'feed_not_found', '这条动态不存在');
    ensure(owner.userId === user.id, 403, 'forbidden', '只能编辑自己的动态');

    const body = reqCtx.body ?? {};
    const current = queries.byId({ id, viewerId: user.id, ignoreVisibility: true });

    const content =
      body.content === undefined
        ? String(current.content)
        : field(body.content, { name: 'content', min: 1, max: MAX_FEED_CONTENT, label: '动态内容' });
    const scope = body.scope === undefined ? current.scope : readScope(body.scope);
    const images = body.images === undefined ? currentImagesOf(current) : normalizeImages(body.images);
    const refPostId = body.refPostId === undefined ? current.ref_post_id : readRefPostId(body.refPostId, user);

    queries.update({ id, content, scope, teamId: null, images, refPostId });
    const row = queries.byId({ id, viewerId: user.id, ignoreVisibility: true });
    ok(reqCtx.res, { item: shapeFeedItem(row) });
  });

  add('DELETE', '/api/feed/:id', async (reqCtx) => {
    const user = requireUser(reqCtx);
    const id = Number(reqCtx.params.id);
    const owner = queries.owner(id);
    ensure(owner && !owner.deleted, 404, 'feed_not_found', '这条动态不存在');
    // 删自己的；管理员也可以删（内容管理的兜底，但**不能看私密动态** ——
    // 能删不能读是刻意的：处理举报不需要先读遍全站私密内容）。
    ensure(owner.userId === user.id || ctx.guards.isStaff(user), 403, 'forbidden', '只能删除自己的动态');

    queries.softDelete(id);
    ok(reqCtx.res, { deleted: true, id });
  });

  /* ---------------- 互动 ---------------- */

  add('POST', '/api/feed/:id/reaction', async (reqCtx) => {
    const user = requireUser(reqCtx);
    const id = Number(reqCtx.params.id);
    const kind = reqCtx.body.kind;
    ensure(kind === 'like' || kind === 'dislike', 400, 'bad_kind', '只支持「赞」或「踩」');

    const viewerId = user.id;
    const row = queries.byId({ id, viewerId });
    ensure(row, 404, 'feed_not_found', '这条动态不存在');

    const result = queries.setReaction({ userId: viewerId, itemId: id, kind });
    if (result.changed && (result.liked || result.disliked) && row.user_id !== viewerId) {
      ctx.store.createNotification({
        userId: row.user_id,
        actorId: viewerId,
        type: result.liked ? 'post_like' : 'post_dislike',
        postId: null,
        excerpt: String(row.content ?? '').slice(0, 60),
      });
    }
    ok(reqCtx.res, {
      liked: result.liked,
      disliked: result.disliked,
      likeCount: result.likeCount,
      dislikeCount: result.dislikeCount,
    });
  });

  /* ---------------- 配图 ---------------- */

  add('POST', '/api/feed/images', async (reqCtx) => {
    const user = requireUser(reqCtx);
    rateLimit(`feed:image:${user.id}`, 60, 10 * 60 * 1000);

    const match = String(reqCtx.body.dataUrl ?? '').match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/);
    ensure(match, 400, 'bad_image', '只支持 PNG / JPEG / WebP 图片');
    const buffer = Buffer.from(match[2], 'base64');
    ensure(buffer.length > 0, 400, 'bad_image', '图片内容为空');
    ensure(
      buffer.length <= MAX_FEED_IMAGE_BYTES,
      400,
      'image_too_large',
      `图片不能超过 ${Math.round(MAX_FEED_IMAGE_BYTES / 1024)} KB`,
    );
    const type = sniffImageType(buffer);
    ensure(type, 400, 'bad_image', '图片格式识别失败（不支持 SVG）');
    ensure(type === match[1], 400, 'bad_image', '图片内容与声明的格式不一致');

    mkdirSync(imageDir, { recursive: true });
    // 文件名随机且不可猜：图片地址就是能力凭证（v1 的笔记附件也是这个思路）。
    const name = `f${user.id}-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}.${IMAGE_EXT[type]}`;
    await writeFile(join(imageDir, name), buffer);

    const url = `/api/feed/image/${name}`;
    ok(reqCtx.res, { url, type: MIME[IMAGE_EXT[type]], bytes: buffer.length, maxImages: MAX_FEED_IMAGES });
  });

  add('GET', '/api/feed/image/:name', async (reqCtx) => {
    const name = String(reqCtx.params.name ?? '');
    // 双重校验：形状不对直接 404，且**绝不拼接未经校验的路径**。
    ensure(IMAGE_NAME.test(name) && !name.includes('..'), 404, 'image_not_found', '图片不存在');
    const ext = name.split('.').pop();
    try {
      const buffer = await readFile(join(imageDir, name));
      reqCtx.res.writeHead(200, {
        'content-type': MIME[ext] ?? 'application/octet-stream',
        'content-length': buffer.length,
        'cache-control': 'public, max-age=31536000, immutable',
      });
      reqCtx.res.end(buffer);
    } catch {
      throw new HttpError(404, 'image_not_found', '图片不存在');
    }
  });
}

/** 只给列表接口返回的可见范围选项用；真正的文案在 shape.js，这里避免两处写两份。 */
function shapeFeedItemLabel(scope) {
  return { public: '公开', followers: '仅关注我的人', team: '仅团队', private: '仅自己' }[scope] ?? scope;
}
