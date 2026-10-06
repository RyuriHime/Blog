// doc 模块的 HTTP 层。只做三件事：解析参数、调 store、给状态码。
//
// ⚠️ **登记顺序有讲究**：`/api/docs/meta/*` 必须排在 `/api/docs/:id` 之前。
// 路由匹配是 `routes.filter(...)` 之后取第一个方法相同的条目（见 src/core/handler.js:65-68），
// 而 `/api/docs/:id` 里的 `[^/]+` 会把 `meta` 也吃进去 ——
// 顺序反了的话 `/api/docs/meta/templates` 会变成"id=meta 的文档"。
//
// 另一条纪律来自设计文档 §4：`/api/docs/:id` 本身就是两段式，
// 所以**任何两段式的固定路径（/api/docs/import、/api/docs/block-types）都会跟它撞**。
// 辅助接口一律走三段式 `/api/docs/meta/*`，这条不能破。
//
// 错误一律抛 `HttpError`：`src/core/handler.js:100-114` 会把它转成
// `{ok:false,error:{code,message}}` 的信封，非 HttpError 才会打日志 + 500。
import { ensure, field } from '../../core/http.js';

/** `:id` 只接受正整数；不合法就当"不存在"（不要泄露它其实是个字符串）。 */
function readId(reqCtx) {
  const id = Number(reqCtx.params.id);
  // 错误码只从设计文档 §4.5 那张表里取（`not_found` 是通用的那条，
  // 不另造 `doc_not_found` —— 造一个新码就是给自己留一份要同步维护的清单）。
  ensure(Number.isInteger(id) && id > 0, 404, 'not_found', '这篇文档不存在');
  return id;
}

function readBlockId(reqCtx) {
  const blockId = String(reqCtx.params.blockId ?? '');
  ensure(/^b\d+$/.test(blockId), 404, 'not_found', '这一块不存在');
  return blockId;
}

/**
 * 路径里的 wiki 标题。
 *
 * `:name` 拿到的是**百分号编码**的原文 —— core 的 `handler.js:71` 是直接
 * `entry.regex.exec(url.pathname)`，而 `URL.pathname` 不解码。中文标题因此必须解一次，
 * 不然库里会存下 `S8%20%E6%80%BB%E8%A7%88%E9%A1%B5` 这种标题，
 * 而前端按 `encodeURIComponent(title)` 去查又是同一个编码串 —— 两边"自洽"地错着，
 * 只有人眼看列表时才发现标题是乱码。解坏了就原样用，交给后面的长度/空值校验去拒。
 */
function readWikiName(reqCtx) {
  const raw = String(reqCtx.params.name ?? '');
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function intOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * @param {{routes:{add:Function}, guards:object, http:object}} ctx
 * @param {{store:object}} deps
 */
export function registerDocRoutes(ctx, { store }) {
  const add = ctx.routes.add;
  const { ok, rateLimit } = ctx.http;
  const { requireUser } = ctx.guards;

  const write = (reqCtx, action) => {
    const user = requireUser(reqCtx);
    rateLimit(`doc:${action}:${user.id}`, 60, 10 * 60 * 1000);
    return user;
  };

  /* ---------------- 辅助接口（必须最先登记，见文件头） ---------------- */

  add('GET', '/api/docs/meta/templates', async (reqCtx) => {
    // kinds / scopes 一起给：编辑器的两个下拉框必须有唯一真相（见 store.listKinds 的注释）。
    ok(reqCtx.res, { templates: store.listTemplates(), kinds: store.listKinds(), scopes: store.listScopes() });
  });

  add('GET', '/api/docs/meta/block-types', async (reqCtx) => {
    ok(reqCtx.res, { types: store.listBlockTypes() });
  });

  add('POST', '/api/docs/meta/block-types', async (reqCtx) => {
    const user = write(reqCtx, 'type');
    const result = store.registerCustomBlockType({
      viewer: user,
      name: field(reqCtx.body.name, { name: '类型名', min: 1, max: 32 }),
      version: intOrNull(reqCtx.body.version),
      label: reqCtx.body.label,
      icon: reqCtx.body.icon,
      rendererKind: reqCtx.body.rendererKind,
      propsSchema: reqCtx.body.propsSchema,
      renderer: reqCtx.body.renderer,
    });
    ok(reqCtx.res, result);
  });

  add('POST', '/api/docs/meta/import', async (reqCtx) => {
    const user = write(reqCtx, 'import');
    ok(reqCtx.res, store.importDocument({ viewer: user, payload: reqCtx.body.payload ?? reqCtx.body, scope: reqCtx.body.scope }));
  });

  /* ---------------- 脚本模板（开发者功能：把自己写的脚本存成模板） ---------------- */

  // 一律走三段式 `/api/docs/meta/*`：两段式的固定路径会被下面的 `/api/docs/:id` 抢走。

  add('GET', '/api/docs/meta/script-templates', async (reqCtx) => {
    ok(reqCtx.res, store.listScriptTemplates({ viewer: reqCtx.user }));
  });

  // 不带 id = 新建，带 id = 覆盖自己那个（同一个人不允许两个同名模板，重名回 409）。
  add('POST', '/api/docs/meta/script-templates', async (reqCtx) => {
    const user = write(reqCtx, 'script-template');
    ok(reqCtx.res, store.saveScriptTemplate({ viewer: user, id: intOrNull(reqCtx.body.id), payload: reqCtx.body }));
  });

  add('DELETE', '/api/docs/meta/script-templates/:id', async (reqCtx) => {
    const user = write(reqCtx, 'script-template');
    const id = Number(reqCtx.params.id);
    ensure(Number.isInteger(id) && id > 0, 404, 'not_found', '没有这个模板');
    ok(reqCtx.res, store.deleteScriptTemplate({ viewer: user, id }));
  });

  // 帖子 → 积木：影子行对普通访客是隐藏的（点开只见到 404），所以帖子详情页
  // 靠这个反查「这条帖子其实是哪篇积木的影子」，把读者送到真正的积木页。
  // 看不见的文档回 `{ doc: null }`，不是错误（列表里仍显示那张卡片）。
  add('GET', '/api/docs/by-anchor/:postId', async (reqCtx) => {
    const postId = Number(reqCtx.params.postId);
    ensure(Number.isInteger(postId) && postId > 0, 404, 'not_found', '这条帖子不存在');
    ok(reqCtx.res, { doc: store.documentByAnchorFor({ postId, viewer: reqCtx.user }) });
  });

  /* ---------------- Wiki 站（§6：一个帖子一个 wiki） ---------------- */

  // 注意登记顺序：这几个的第三段是**字面量**（`stations` / `station`），
  // 必须排在下面那条两段式 `/api/docs/wiki/:name` 之前，
  // 否则 `/api/docs/wiki/station` 会被当成「一个叫 station 的 wiki 页」。

  // `#/wiki`：所有看得见的站。老的 `pages` / `categories` 照旧一起回 ——
  // 「站」是叠加在旧模型之上的，不是替换（旧客户端与旧测试都还读它们）。
  add('GET', '/api/docs/wiki/stations', async (reqCtx) => {
    const data = store.listStations({ viewer: reqCtx.user });
    // `nav` 里的 `pages` / `categories` 也摊到顶层：旧的 `GET /api/docs/wiki` 就是这么给的，
    // 前端与老测试读的都是顶层那两个键。
    ok(reqCtx.res, { found: true, ...data, ...(data?.nav ?? {}) });
  });

  // 新建一个站（`#/wiki` 上的「＋ 新建站」）。站本身就是一个普通帖子（`template='station'`）。
  add('POST', '/api/docs/wiki/stations', async (reqCtx) => {
    const user = write(reqCtx, 'wiki-station');
    ok(reqCtx.res, store.createStation({
      viewer: user,
      title: reqCtx.body?.title ?? '',
      scope: reqCtx.body?.scope ?? 'public',
    }));
  });

  // 站本体（按 id 或按站名）＋ 可选的某一页。三栏页面的左树 / 右 ToC / 前后页一次拿齐。
  add('GET', '/api/docs/wiki/station', async (reqCtx) => {
    const id = intOrNull(reqCtx.query.get('id')) ?? 0;
    ok(reqCtx.res, store.getStation({
      id,
      title: reqCtx.query.get('title') ?? '',
      pageTitle: reqCtx.query.get('page') ?? '',
      viewer: reqCtx.user,
    }));
  });

  // 站内搜索：标题 + 作者敲的原文两个 LIKE，只搜本站、只搜看得见的页。
  add('GET', '/api/docs/wiki/station/:id/search', async (reqCtx) => {
    ok(reqCtx.res, store.searchStation({
      stationId: Number(reqCtx.params.id) || 0,
      q: reqCtx.query.get('q') ?? '',
      viewer: reqCtx.user,
    }));
  });

  // 在站里新建一页（顺便挂到站的目录上）。`parentId` 给了就挂成子页。
  add('POST', '/api/docs/wiki/station/:id/pages', async (reqCtx) => {
    const user = write(reqCtx, 'wiki-page');
    ok(reqCtx.res, store.createStationPage({
      stationId: Number(reqCtx.params.id) || 0,
      viewer: user,
      title: reqCtx.body?.title ?? '',
      parentId: intOrNull(reqCtx.body?.parentId) ?? 0,
      icon: reqCtx.body?.icon ?? '',
    }));
  });

  // 改一页在站里的位置（父页 / 排序 / 图标）。
  add('PUT', '/api/docs/wiki/station/:id/pages/:pageId', async (reqCtx) => {
    const user = write(reqCtx, 'wiki-page');
    ok(reqCtx.res, store.moveStationPage({
      stationId: Number(reqCtx.params.id) || 0,
      id: Number(reqCtx.params.pageId) || 0,
      viewer: user,
      parentId: reqCtx.body?.parentId === undefined ? undefined : (intOrNull(reqCtx.body?.parentId) ?? 0),
      sortOrder: reqCtx.body?.sortOrder === undefined ? undefined : Number(reqCtx.body.sortOrder),
      icon: reqCtx.body?.icon,
    }));
  });

  /* ---------------- Wiki 多页面（`[[目标]]` 的落点） ---------------- */

  // 第三段是字面量 `wiki`，不与 `/api/docs/:id/{blocks,markdown,ops,...}` 撞车。
  // 边栏目录：分类 + 每一页。**必须排在 `/api/docs/:id` 前面**，
  // 否则 `wiki` 会被当成 id 吃掉（`/api/docs/:id` 的 `[^/]+` 什么都吃，见文件头）。
  add('GET', '/api/docs/wiki', async (reqCtx) => {
    // 顺手全量收编（幂等）：升级后第一次打开 wiki，老页就都进了站（§6.7 触发点①）。
    store.ensurePagesAttached({ viewer: reqCtx.user });
    ok(reqCtx.res, { found: true, ...store.wikiNav({ viewer: reqCtx.user }), ...store.listStations({ viewer: reqCtx.user }) });
  });

  // GET 越权一律回 200 + `found:false`（不告诉陌生人「有这一页、只是你看不见」）；
  // 标题按 NOCASE 比，`[[围炉]]` 与 `[[围炉 ]]` 是同一页。
  add('GET', '/api/docs/wiki/:name', async (reqCtx) => {
    const viewer = reqCtx.user;
    const page = store.getWikiPage({ name: readWikiName(reqCtx), viewer });
    // 边栏跟正文一起回来：一次请求就能画出「分类 + 页面列表 + 当前页」。
    ok(reqCtx.res, page ? { found: true, ...page, nav: store.wikiNav({ viewer }) } : { found: false, nav: store.wikiNav({ viewer }) });
  });

  // 没有就**当场建**：`[[还没写过的页]]` 是 wiki 的正常用法，不是错误。
  add('POST', '/api/docs/wiki/:name', async (reqCtx) => {
    const user = write(reqCtx, 'wiki');
    const page = store.openWikiPage({ viewer: user, name: readWikiName(reqCtx), scope: reqCtx.body?.scope ?? 'public' });
    ok(reqCtx.res, { found: true, ...page });
  });

  /* ---------------- 文档 ---------------- */

  add('GET', '/api/docs', async (reqCtx) => {
    const result = store.listDocuments({
      viewer: reqCtx.user,
      kind: reqCtx.query.get('kind') ?? '',
      scope: reqCtx.query.get('scope') ?? '',
      mine: reqCtx.query.get('mine') === '1',
      q: reqCtx.query.get('q') ?? '',
      page: intOrNull(reqCtx.query.get('page')) ?? 1,
      limit: intOrNull(reqCtx.query.get('limit')) ?? 20,
      sort: reqCtx.query.get('sort') ?? 'updated',
    });
    ok(reqCtx.res, result);
  });

  add('POST', '/api/docs', async (reqCtx) => {
    const user = write(reqCtx, 'create');
    ok(reqCtx.res, store.createDocument({
      viewer: user,
      title: reqCtx.body.title,
      kind: reqCtx.body.kind,
      scope: reqCtx.body.scope,
      template: reqCtx.body.template,
      blocks: reqCtx.body.blocks,
    }));
  });

  add('GET', '/api/docs/:id', async (reqCtx) => {
    const viewer = reqCtx.user;
    const doc = store.getDocument(readId(reqCtx), viewer);
    // wiki 页不管从 `#/wiki/<标题>` 还是 `#/doc/:id` 进来，边栏都得在 ——
    // 「有没有边栏」不该取决于用户从哪个链接点进来。
    ok(reqCtx.res, doc.doc?.template === 'page' ? { ...doc, nav: store.wikiNav({ viewer }) } : doc);
  });

  add('PUT', '/api/docs/:id', async (reqCtx) => {
    const user = write(reqCtx, 'edit');
    ok(reqCtx.res, store.updateDocument({
      id: readId(reqCtx),
      viewer: user,
      title: reqCtx.body.title,
      scope: reqCtx.body.scope,
      template: reqCtx.body.template,
    }));
  });

  /**
   * 这篇积木的互动现状（赞 / 踩 / 投币 / 收藏 / 转发 / 关注 —— 阅读页那条互动条要的）。
   *
   * 为什么不塞进 `GET /api/docs/:id`：
   *   1. 这些字段长在**影子行**上，形状由 core 的 shape 说了算。借它的形状，
   *      比在 doc 里抄一份字段表、日后 core 加一个字段就漏一个强。
   *   2. 它要按访客算（我赞过没有、我的币够不够），和文档本体（谁都能看的那部分）
   *      不是同一件事 —— 分开之后 `GET /api/docs/:id` 仍然可以随便缓存/预取。
   * 只读，**不 bumpViews**：翻积木不该涨影子行的浏览量。
   */
  add('GET', '/api/docs/:id/anchor', async (reqCtx) => {
    const viewer = reqCtx.user;
    const anchorId = store.anchorPostIdOf({ id: readId(reqCtx), viewer });
    const row = anchorId ? ctx.store.postById(anchorId, viewer?.id ?? 0) : null;
    // 没有锚点（还没同步）或影子行被删了：给空条子，别把阅读页搞成报错页。
    if (!row) {
      ok(reqCtx.res, { post: null });
      return;
    }
    // 用列表形状而不是详情形状：互动条只读得到这些字段，不带 content 省一半流量。
    ok(reqCtx.res, { post: { ...ctx.shape.shapePostListRow(row), coin: ctx.shape.coinAvailability(row, viewer) } });
  });

  add('DELETE', '/api/docs/:id', async (reqCtx) => {
    const user = write(reqCtx, 'delete');
    ok(reqCtx.res, store.deleteDocument({ id: readId(reqCtx), viewer: user }));
  });

  /* ---------------- 块 ---------------- */

  // 给一页 wiki 定分类与排序（边栏就是按这两样排的）。
  add('PUT', '/api/docs/:id/wiki', async (reqCtx) => {
    const user = write(reqCtx, 'wiki');
    ok(reqCtx.res, store.setWikiMeta({
      id: readId(reqCtx),
      viewer: user,
      category: reqCtx.body?.category ?? '',
      sortOrder: intOrNull(reqCtx.body?.sortOrder) ?? 0,
    }));
  });

  add('POST', '/api/docs/:id/blocks', async (reqCtx) => {
    const user = write(reqCtx, 'block');
    ok(reqCtx.res, store.addBlock({
      id: readId(reqCtx),
      viewer: user,
      type: field(reqCtx.body.type, { name: '块类型', min: 1, max: 32 }),
      props: reqCtx.body.props,
      after: reqCtx.body.after ?? null,
      before: reqCtx.body.before ?? null,
      position: intOrNull(reqCtx.body.position),
    }));
  });

  add('PUT', '/api/docs/:id/blocks/:blockId', async (reqCtx) => {
    const user = write(reqCtx, 'block');
    ok(reqCtx.res, store.updateBlock({
      id: readId(reqCtx),
      viewer: user,
      blockId: readBlockId(reqCtx),
      type: reqCtx.body.type,
      props: reqCtx.body.props,
    }));
  });

  add('DELETE', '/api/docs/:id/blocks/:blockId', async (reqCtx) => {
    const user = write(reqCtx, 'block');
    ok(reqCtx.res, store.deleteBlock({ id: readId(reqCtx), viewer: user, blockId: readBlockId(reqCtx) }));
  });

  add('POST', '/api/docs/:id/blocks/:blockId/move', async (reqCtx) => {
    const user = write(reqCtx, 'block');
    ok(reqCtx.res, store.moveBlock({
      id: readId(reqCtx),
      viewer: user,
      blockId: readBlockId(reqCtx),
      after: reqCtx.body.after ?? null,
      before: reqCtx.body.before ?? null,
      position: intOrNull(reqCtx.body.position),
    }));
  });

  /* ---------------- 投票（§5.2） ---------------- */

  // 未登录也能读票数（票数本来就是公开的），`mine` 为空数组而已。
  add('GET', '/api/docs/:id/polls', async (reqCtx) => {
    ok(reqCtx.res, store.getPollState({ id: readId(reqCtx), viewer: reqCtx.user }));
  });

  // 投票是**写**操作，所以走 write()：既要求登录，也吃那条 60 次 / 10 分钟 的限流。
  add('POST', '/api/docs/:id/blocks/:blockId/vote', async (reqCtx) => {
    const user = write(reqCtx, 'vote');
    ok(reqCtx.res, store.votePoll({
      id: readId(reqCtx),
      viewer: user,
      blockId: readBlockId(reqCtx),
      options: reqCtx.body?.options ?? [],
    }));
  });

  add('POST', '/api/docs/:id/reorder', async (reqCtx) => {
    const user = write(reqCtx, 'block');
    ok(reqCtx.res, store.reorderBlocks({ id: readId(reqCtx), viewer: user, order: reqCtx.body.order }));
  });

  add('POST', '/api/docs/:id/ops', async (reqCtx) => {
    const user = write(reqCtx, 'ops');
    ok(reqCtx.res, store.runOps({ id: readId(reqCtx), viewer: user, ops: reqCtx.body.ops }));
  });

  /* ---------------- 两种编辑模式 ---------------- */

  add('GET', '/api/docs/:id/markdown', async (reqCtx) => {
    ok(reqCtx.res, store.getMarkdown({ id: readId(reqCtx), viewer: reqCtx.user }));
  });

  add('PUT', '/api/docs/:id/markdown', async (reqCtx) => {
    const user = write(reqCtx, 'edit');
    ok(reqCtx.res, store.putMarkdown({
      id: readId(reqCtx),
      viewer: user,
      markdown: reqCtx.body.markdown,
      title: reqCtx.body.title,
      // 块数暴跌时会先回 409，作者确认后带 `?confirm=1` 再发一次。
      confirm: reqCtx.query.get('confirm') === '1',
    }));
  });

  // 源码预览：编辑器右边那块，纯读（不落库、不建修订）。
  add('POST', '/api/docs/:id/preview', async (reqCtx) => {
    const user = write(reqCtx, 'edit');
    ok(reqCtx.res, store.previewMarkdown({
      id: readId(reqCtx),
      viewer: user,
      markdown: reqCtx.body.markdown,
    }));
  });

  add('PUT', '/api/docs/:id/settings', async (reqCtx) => {    const user = write(reqCtx, 'edit');
    ok(reqCtx.res, store.putSettings({
      id: readId(reqCtx),
      viewer: user,
      allowScriptWrite: reqCtx.body.allowScriptWrite,
      appMode: reqCtx.body.appMode,
      icon: reqCtx.body.icon,
    }));
  });

  /* ---------------- 模板 / 导入导出 / 修订 ---------------- */

  add('POST', '/api/docs/:id/apply-template', async (reqCtx) => {
    const user = write(reqCtx, 'template');
    ok(reqCtx.res, store.applyTemplate({
      id: readId(reqCtx),
      viewer: user,
      key: field(reqCtx.body.key, { name: '模板', min: 1, max: 32 }),
      mode: reqCtx.body.mode,
    }));
  });

  add('GET', '/api/docs/:id/export', async (reqCtx) => {
    ok(reqCtx.res, store.exportDocument({ id: readId(reqCtx), viewer: reqCtx.user }));
  });

  add('GET', '/api/docs/:id/revisions', async (reqCtx) => {
    ok(reqCtx.res, store.listRevisions({ id: readId(reqCtx), viewer: reqCtx.user }));
  });

  add('POST', '/api/docs/:id/rollback', async (reqCtx) => {
    const user = write(reqCtx, 'rollback');
    const revision = Number(reqCtx.body.revision);
    ensure(Number.isInteger(revision) && revision > 0, 400, 'bad_request', 'revision 必须是正整数');
    ok(reqCtx.res, store.rollback({ id: readId(reqCtx), viewer: user, revision }));
  });

  /* ---------------- 沙箱（§6） ---------------- */

  // 沙箱里的代码申请一个能力。
  // 注意问的人**是访问者、不是作者** —— 沙箱跑在访问者的浏览器里，
  // 所以这里只要求 `requireUser`（谁看这篇文档谁就能申请），不要求作者身份。
  // `payload` 是能力自己的参数（`state` 用 `{op, scope, value}`）：只当数据看，不做求值。
  add('POST', '/api/docs/:id/capabilities', async (reqCtx) => {
    const user = write(reqCtx, 'capability');
    ok(reqCtx.res, store.requestCapability({
      id: readId(reqCtx),
      viewer: user,
      blockId: reqCtx.body.blockId,
      capability: field(reqCtx.body.capability, { name: '能力名', min: 1, max: 64 }),
      payload: reqCtx.body.payload && typeof reqCtx.body.payload === 'object' ? reqCtx.body.payload : null,
    }));
  });

  // 审计清单（排障 / 管理后台用）。**只看得到，不能改** —— 审计是追加型的。
  add('GET', '/api/docs/:id/capabilities', async (reqCtx) => {
    ok(reqCtx.res, store.listCapabilityLogs({
      id: readId(reqCtx),
      viewer: reqCtx.user,
      limit: intOrNull(reqCtx.query.get('limit')) ?? 50,
    }));
  });

  // 「采纳为真块」（§4.5）：作者把一条脚本产出**固化进正文**。
  // 这是一次普通的文档写：发新块 id、写一条 `adopt` 修订、产出行删掉。
  add('POST', '/api/docs/:id/adopt', async (reqCtx) => {
    const user = write(reqCtx, 'adopt');
    ok(reqCtx.res, store.adoptDerived({
      id: readId(reqCtx),
      viewer: user,
      blockId: field(reqCtx.body.blockId, { name: '产出块 id', min: 1, max: 32 }),
      scope: reqCtx.body.scope,
    }));
  });

  // 逃生开关（FR-SANDBOX-08）：关掉这篇文档的沙箱，所有 app 块退化成占位（连 iframe 都不建）。
  // 仅 staff —— 这是「某个小应用把浏览器卡死了」时不必删帖的最后一手。
  add('POST', '/api/docs/:id/sandbox', async (reqCtx) => {
    const user = write(reqCtx, 'sandbox');
    ok(reqCtx.res, store.setSandboxDisabled({
      id: readId(reqCtx),
      viewer: user,
      disabled: Boolean(reqCtx.body.disabled),
    }));
  });

  /* ---------------- 笔记与个人主页的接线（§8） ---------------- */
  //
  // 三段式，第三段是字面量（notes / profile），不会跟 `/api/docs/meta/*` 或
  // `/api/docs/:id/<字面量>` 撞车 —— 那几个的第三段分别是 blocks / markdown / ops / …。

  // 文件的惰性导入（§8.1）：只允许导入**自己的**笔记。
  // 笔记广场里读别人的笔记时用下面的 lookup，不替别人建文档（影子行的作者会错位）。
  add('POST', '/api/docs/notes/import', async (reqCtx) => {
    const user = write(reqCtx, 'note-import');
    ok(reqCtx.res, store.importNote({
      viewer: user,
      noteName: field(reqCtx.body.name, { name: '笔记名', min: 1, max: 200 }),
      title: reqCtx.body.title,
      markdown: reqCtx.body.markdown,
      scope: reqCtx.body.scope,
    }));
  });

  // 「这篇笔记进过库没有」。看得见就返回文档，看不见 / 没导入过一律 `{found:false}` ——
  // 用 200 而不是 404：调用方（笔记页）拿它当分支条件，不是当错误处理。
  add('GET', '/api/docs/notes/lookup', async (reqCtx) => {
    const payload = store.getNoteDocument({
      ownerId: intOrNull(reqCtx.query.get('ownerId')),
      noteName: reqCtx.query.get('name'),
      viewer: reqCtx.user,
    });
    ok(reqCtx.res, payload ? { found: true, ...payload } : { found: false });
  });

  // 个人主页（§8.2）：`#/u/:username` 优先渲染这一篇；没有就退回 bio + 帖子列表。
  add('GET', '/api/docs/profile/:username', async (reqCtx) => {
    const username = String(reqCtx.params.username ?? '').trim();
    ensure(username.length > 0 && username.length <= 32, 404, 'not_found', '这个人不存在');
    const payload = store.getProfileDocument({ username, viewer: reqCtx.user });
    ok(reqCtx.res, payload ? { found: true, ...payload } : { found: false });
  });
}
