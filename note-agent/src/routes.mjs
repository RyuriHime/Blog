/**
 * note-agent 的 HTTP 处理器：**框架无关**。
 *
 * 这一层刻意不碰 `req` / `res`：
 *   - `mount.mjs` 负责读流、解析 multipart、拿到 `ctx.user`；
 *   - 这里只接受 `{ method, pathname, query, body, files, user, ip }`，返回 `{ status, body }`。
 * 好处是本文件可以纯函数式测试（见 `tests/test-routes.mjs`），不必起服务器。
 *
 * 响应协议与宿主保持一致：`{ ok: true, data }` / `{ ok: false, error: { code, message } }`。
 */
import { aiConfig, aiSource, chat } from './ai.mjs';
import { blocksToMarkdown, assignBlockIds } from './blocks.mjs';
import { analyzeStructure } from './structure.mjs';
import { extractSession, extractMaterial } from './extract/index.mjs';
import { extractText } from './extract/text.mjs';
import { generate as defaultGenerate, turn as defaultTurn } from './orchestrator.mjs';
import { reviewDraft as defaultReview, applyReviewPatch } from './review.mjs';
import { buildMaterial, DEFAULT_CHAR_BUDGET, MAX_IMAGES, MAX_IMAGE_BYTES } from './material.mjs';
import { normalizeBlocks } from './formulas.mjs';
import { applyOps } from './ops.mjs';
import { UPLOAD_RULES } from './uploads-meta.mjs';

export const CONTRACT_VERSION = '1';
export const FEATURES = ['organize', 'turn', 'review', 'images', 'editor', 'source-text'];
export const MAX_REQUIREMENT = 1000;
export const MAX_REVIEW_DRAFT = 20000;
/** 编辑区内容的上限：与审查上限同口径（都是"一篇笔记"的规模）。 */
export const MAX_DRAFT = MAX_REVIEW_DRAFT;
/** 标题上限：标题是"标题"，不是正文，超过这个长度一定是误传或攻击。 */
export const MAX_TITLE = 300;
/** 一条会话最多留几份材料行（每行都存着它自己的 blocks_json）。 */
export const MAX_MATERIALS = 20;
export const RATE_LIMIT_PER_MINUTE = 10;
export const RATE_WINDOW_MS = 60000;

const ERROR_STATUS = {
  notes_bad_request: 400,
  notes_not_found: 404,
  notes_too_large: 413,
  notes_unsupported_type: 415,
  notes_extract_failed: 422,
  notes_not_configured: 503,
  unauthorized: 401,
  ai_timeout: 504,
  ai_rate_limited: 429,
  ai_not_configured: 503,
  ai_unreachable: 502,
  ai_unauthorized: 502,
  ai_upstream_error: 502,
  ai_bad_response: 502,
  ai_empty_response: 502,
  ai_bad_json: 502,
};

class NotesError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.name = 'NotesError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function ok(res, data) {
  return { status: res ?? 200, body: { ok: true, data } };
}

function fail(status, code, message) {
  return { status, body: { ok: false, error: { code, message } } };
}

function toResponse(error) {
  if (error instanceof NotesError) {
    const body = { ok: false, error: { code: error.code, message: error.message } };
    if (error.details) body.error.details = error.details;
    return { status: error.status, body };
  }
  const status = ERROR_STATUS[error?.code] ?? 500;
  const message = status === 500 ? '整理服务出错了，请稍后重试' : String(error?.message ?? '请求失败');
  return { status, body: { ok: false, error: { code: error?.code ?? 'notes_internal_error', message } } };
}

function badRequest(message) {
  return new NotesError(400, 'notes_bad_request', message);
}

function notFound(message = '找不到这个整理会话') {
  return new NotesError(404, 'notes_not_found', message);
}

/** 模块内的滑动窗口限流：键是 `${userId}:${route}`。 */
function createRateLimiter({ windowMs = RATE_WINDOW_MS, limit = RATE_LIMIT_PER_MINUTE } = {}) {
  const buckets = new Map();
  /** 抽样清理的节流：每 500 次判定扫一遍过期桶，别在热路径上遍历整个 Map。 */
  let callsSinceSweep = 0;
  function sweep(now) {
    for (const [key, hits] of buckets) {
      if (hits.length === 0 || now - hits[hits.length - 1] >= windowMs) buckets.delete(key);
    }
  }
  return function rateLimit(key, cost = 1) {
    const now = Date.now();
    callsSinceSweep += 1;
    if (callsSinceSweep >= 500) {
      callsSinceSweep = 0;
      sweep(now);
    }
    const hits = (buckets.get(key) ?? []).filter((at) => now - at < windowMs);
    if (hits.length + cost > limit) {
      buckets.set(key, hits);
      return false;
    }
    for (let i = 0; i < cost; i += 1) hits.push(now);
    buckets.set(key, hits);
    return true;
  };
}
function asInt(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

/**
 * @param {{ store: object, extract?: Function, orchestrator?: object, reviewer?: object, env?: object,
 *   chatImpl?: Function|null, fetchImpl?: Function, rateLimit?: Function, defaultRateLimit?: Function }} deps
 */
export function createHandlers({
  store,
  env = process.env,
  chatImpl = null,
  fetchImpl = fetch,
  rateLimit = null,
} = {}) {
  if (!store) throw new TypeError('createHandlers 需要 store');

  const config = aiConfig(env);
  const check = rateLimit ?? createRateLimiter();
  /** 未落库的待应用 op（会话级"待确认"状态由前端持有，这里只做服务端回放用）。 */
  const pendingOps = new Map();

  const generateImpl = (options) => defaultGenerate({ ...options, env, chatImpl: chatImpl ?? undefined, fetchImpl });
  const turnImpl = (options) => defaultTurn({ ...options, env, chatImpl: chatImpl ?? undefined, fetchImpl });
  const reviewImpl = (options) => defaultReview({ ...options, env, chatImpl: chatImpl ?? undefined, fetchImpl });

  function requireUser(ctx) {
    if (!ctx?.user || !ctx.user.id) {
      throw new NotesError(401, 'unauthorized', '请先登录');
    }
    return ctx.user;
  }

  function requireSession(ctx, sessionId) {
    const user = requireUser(ctx);
    const session = store.sessionForUser(sessionId, user.id);
    if (!session) throw notFound();
    return session;
  }

  /**
   * 把**编辑区里的内容**变成块序列。
   *
   * 这是整条链路的起点：用户整理的是自己正在写的东西，而不是某个上传的文件。
   * 复用 `extractText`，所以编辑区里的 Markdown（标题、表格、```代码块```、$$公式$$、
   * `![图](src)`）与上传一个 .md 文件走的是同一套识别规则。
   */
  function editorBlocks(markdown, name = '编辑区') {
    const source = String(markdown ?? '');
    if (source.trim().length === 0) return [];
    const result = extractText(source, { name });
    return assignBlockIds(result.blocks ?? []);
  }

  /** 编辑区内容为空时，退回上一次已知的块（避免把工作台清空）。 */
  function resolveBlocks(session, draft) {
    const generated = editorBlocks(draft);
    if (generated.length > 0) return generated;
    return parseList(session.blocks_json);
  }

  /**
   * 抽取上传的一组文件，作为**补充材料**。
   *
   * 复用 `extractSession` 的编排，这样 HTTP 路径与纯函数路径
   * （`tests/test-extract-index.mjs`）行为完全一致：单源失败不中断整批。
   *
   * 注意 `extractSession` 是 async —— 漏掉 `await` 会让下游拿到 Promise
   * （症状是 `out.blocks` 为 undefined、接口报 notes_extract_failed）。
   */
  async function extractSources(files) {
    const list = Array.isArray(files) ? files.filter(Boolean) : [];
    if (list.length === 0) return { sources: [], blocks: [], images: [], warnings: [] };
    if (list.length > UPLOAD_RULES.maxFiles) {
      throw new NotesError(400, 'notes_bad_request', `一次最多上传 ${UPLOAD_RULES.maxFiles} 份材料`);
    }
    try {
      const out = await extractSession(list, {
        maxFileBytes: UPLOAD_RULES.maxFileBytes,
        maxSessionBytes: UPLOAD_RULES.maxSessionBytes,
        maxFiles: UPLOAD_RULES.maxFiles,
      });
      const failed = out.sources.filter((source) => source.kind === 'failed');
      if (failed.length > 0 && out.blocks.length === 0) {
        const first = failed[0];
        throw new NotesError(422, first.error?.code ?? 'notes_extract_failed', first.error?.message ?? '解析失败');
      }
      return { sources: out.sources, blocks: out.blocks, images: out.images, warnings: out.warnings };
    } catch (error) {
      if (error instanceof NotesError) throw error;
      const code = error?.code ?? 'notes_extract_failed';
      const status = code === 'notes_too_large' ? 413
        : code === 'notes_unsupported_type' ? 415
          : code === 'notes_bad_request' ? 400 : 422;
      throw new NotesError(status, code, error?.message ?? '解析失败');
    }
  }

  /**
   * 把编辑区内容（可选叠加刚上传的材料）装配成这次要用的工作集。
   *
   * @returns {{session:object, blocks:Array, images:Array, sources:Array, warnings:Array, structure:object}}
   */
  async function materialize({ user, sessionId, draft, title: givenTitle = '', postId, files = [], append = false }) {
    const text = String(draft ?? '');
    if (text.length > MAX_DRAFT) throw new NotesError(413, 'notes_too_large', `正文最多 ${MAX_DRAFT} 字`);
    const extracted = await extractSources(files);
    const hasFiles = extracted.blocks.length > 0;

    let session = sessionId ? store.sessionForUser(sessionId, user.id) : null;
    if (sessionId && !session) throw notFound();

    const blocks = editorBlocks(text);
    let allBlocks;
    if (hasFiles && append && blocks.length > 0) {
      // 材料是补充：接在编辑区内容之后，编辑区永远是主体
      allBlocks = assignBlockIds([...blocks, ...extracted.blocks]);
    } else if (hasFiles && blocks.length === 0) {
      allBlocks = assignBlockIds(extracted.blocks);
    } else if (blocks.length > 0) {
      allBlocks = blocks;
    } else {
      allBlocks = session ? parseList(session.blocks_json) : [];
    }

    if (allBlocks.length === 0) throw badRequest('编辑区还是空的：先写点内容，或上传一份材料');

    const structure = analyzeStructure(allBlocks);
    const title = String(givenTitle ?? '').trim() || (structure.titleCandidates[0]?.text ?? '');
    const materialChars = allBlocks.reduce((sum, block) => sum + String(block.text ?? '').length, 0);
    const warnings = extracted.warnings;

    if (!session) {
      const id = store.createSession({
        userId: user.id,
        postId: postId ?? null,
        title,
        blocks: allBlocks,
        images: extracted.images,
        sources: extracted.sources,
        materialChars,
      });
      session = store.sessionById(id);
    } else if (hasFiles) {
      // 材料行也去重：面板每次编辑都会打 /session，而每次都会把材料重新抽一遍。
      // 不判重的话，同一次上传会随每次按键在库里多留一份 blocks_json。
      const existing = store.listMaterials(session.id);
      const fresh = extracted.sources.filter((source) => {
        const fingerprint = materialFingerprint(source);
        return !existing.some((row) => materialFingerprint({ kind: row.kind, name: row.name, bytes: row.bytes, blocks: parseList(row.blocks_json) }) === fingerprint);
      });
      if (fresh.length > 0) store.addMaterials(session.id, fresh);
      try {
        store.trimMaterials(session.id, MAX_MATERIALS);
      } catch {
        /* 裁剪失败不影响本次整理 */
      }
    }
    // 材料里的图片在这里落库：不存下来，下一轮 /generate 就再也"看不到"这些图了
    // （附件表就是为了多模态复用才建的，之前只有测试用过它）。
    rememberImages(session.id, extracted.images);
    store.updateDraft(session.id, {
      blocks: allBlocks,
      title,
      tags: parseList(session.tags_json),
      draftMd: text.length > 0 ? text : blocksToMarkdown(allBlocks),
      status: session.status,
    });

    return { session: store.sessionById(session.id), blocks: allBlocks, images: extracted.images, sources: extracted.sources, warnings, structure };
  }

  /**
   * 这次要让模型"看"的图片。
   *
   * 材料里抽出来的图片（DOCX/PDF/Markdown 里的图）在会话里存成附件，每轮整理/追问时
   * 取出最多 `MAX_IMAGES` 张一起发过去。以前这里是恒定的 `[]` —— 图片说明、公式截图
   * 这类只在图上能看出来的问题，模型永远看不到，而 README 却承诺"图片连同材料一起发"。
   */
  function sessionAssets(sessionId) {
    if (!Number.isInteger(sessionId) || sessionId <= 0) return [];
    let rows = [];
    try {
      rows = store.listAttachments(sessionId);
    } catch {
      return [];
    }
    return (Array.isArray(rows) ? rows : [])
      .filter((row) => row && typeof row.data_url === 'string' && row.data_url.length > 0)
      .slice(0, MAX_IMAGES)
      .map((row) => ({
        // 附件表没有 block_id 列，所以存的时候把 id 编进了名字（见 rememberImages）。
        // 拿不到就退回 `img${row.id}`：至少同一会话里唯一，不会张冠李戴。
        blockId: attachmentBlockId(row) ?? `img${row.id ?? ''}`,
        name: attachmentDisplayName(row),
        mime: String(row.mime ?? 'image/png'),
        bytes: Number(row.bytes) || 0,
        dataUrl: row.data_url,
      }));
  }

  /** 附件名里的 `[imgK]` 后缀（`rememberImages` 写的），没有就 null。 */
  function attachmentBlockId(row) {
    const match = /\[(img\d+)\]\s*$/.exec(String(row?.name ?? ''));
    return match ? match[1] : null;
  }

  /** 给模型看的纯名字：去掉 `[imgK]` 后缀。 */
  function attachmentDisplayName(row) {
    return String(row?.name ?? '').replace(/\s*\[img\d+\]\s*$/, '');
  }

  /**
   * 把刚解析出来的图片存进会话（只存能进模型的那些）。
   *
   * 图片在材料里是有块 id 的（`img1`/`img2`，见 extract/index.mjs 的编号），
   * 而附件表没有 block_id 列 ⇒ 把 id 追加到名字里（`切线.png [img1]`），
   * `sessionAssets` 再拆回来。这样提示词里的「图 1 对应 img1」与材料正文
   * 里的 `[img1]` 指的是同一张图。
   *
   * 三条约束（都是为了"客户端控制不了磁盘增长"）：
   *   1. 同一个会话里**同名 + 同内容**的图只存一次（抽取器现在也会带上 `id`，
   *      它和名字一起进 `name` 列，所以同一个块位置重复上传不会被反复插入）；
   *   2. 存完把附件裁到 `MAX_IMAGES` 条 —— 反正 `sessionAssets` 也只取前几张；
   *   3. `bytes` 优先用抽取器量出来的**原始字节数**（`image.bytes`），
   *      拿不到才按 base64 长度折算（以前恒 0，附件表里那一列等于没有）。
   *
   * @returns {number} 存下的张数
   */
  function rememberImages(sessionId, images) {
    const list = (Array.isArray(images) ? images : []).filter((image) => image && typeof image.dataUrl === 'string' && image.dataUrl.length > 0);
    let saved = 0;
    for (const [index, image] of list.slice(0, MAX_IMAGES).entries()) {
      try {
        const name = String(image.name ?? '');
        const blockId = String(image.id ?? `img${index + 1}`);
        const dataUrl = image.dataUrl;
        const stored = store.listAttachments(sessionId);
        // 同一张图 + 同一个块 id 已经存过就不再插：面板每次编辑都会打 /session，
        // 材料里同一张图会一遍又一遍地送过来。
        if (stored.some((row) => row.name === `${name} [${blockId}]` && row.data_url === dataUrl)) continue;
        const rawBytes = Number(image.bytes);
        store.addAttachment({
          sessionId,
          name: `${name} [${blockId}]`,
          mime: String(image.mime ?? 'image/png'),
          bytes: Number.isFinite(rawBytes) && rawBytes >= 0 ? rawBytes : dataUrlBytes(dataUrl),
          dataUrl,
        });
        saved += 1;
      } catch {
        /* 存不下就算了：图丢了不该让整次整理失败 */
      }
    }
    try {
      store.trimAttachments(sessionId, MAX_IMAGES);
    } catch {
      /* 裁剪失败不影响本次整理 */
    }
    return saved;
  }

  /** base64 data URL 的真实字节数：`data:image/png;base64,` 之后按 4 字符 3 字节算。 */
  function dataUrlBytes(dataUrl) {
    const comma = dataUrl.indexOf(',');
    const payload = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
    return Math.floor((payload.length * 3) / 4);
  }

  /**
   * 在跑模型之前，把编辑区里的最新内容同步进会话。
   *
   * 面板每个动作都会带上 `draft: editor.getDoc().markdown`。若它与会话里存的完全一致
   * （用户在整理后没再动过字），就直接沿用它已解析的块，省掉一次解析；否则重新装配。
   */
  async function syncDraft(ctx, user) {
    const sessionId = ctx.body?.sessionId == null ? null : asInt(ctx.body.sessionId);
    const incoming = typeof ctx.body?.draft === 'string' ? ctx.body.draft : null;
    if (sessionId && incoming === null) {
      const session = requireSession(ctx, sessionId);
      return { session, blocks: resolveBlocks(session, session.draft_md ?? '') };
    }
    if (sessionId && incoming !== null) {
      const session = store.sessionForUser(sessionId, user.id);
      if (!session) throw notFound();
      if (incoming === (session.draft_md ?? '')) {
        return { session, blocks: resolveBlocks(session, incoming) };
      }
    }
    const out = await materialize({
      user,
      sessionId,
      draft: incoming ?? '',
      title: ctx.body?.title,
      postId: ctx.body?.postId == null ? null : asInt(ctx.body.postId),
      files: ctx.files,
      append: true,
    });
    return { session: out.session, blocks: out.blocks, warnings: out.warnings };
  }

  /**
   * `/status` 的唯一真相。
   *
   * 挂载层的 `noteAgentStatus()`（宿主 `/api/site` 用）和 HTTP 的 `GET /status` 都从这里取，
   * 两边各写一份的结果是"宿主看到已配置、面板看到未配置"这类互相矛盾的现场 —— 真出过一次
   * （HTTP 的 `materialChars` 写死 24000，`limits` 少 `requirement`/`reviewDraft`）。
   */
  function statusSnapshot() {
    return {
      configured: config.configured,
      model: config.model,
      // 用的是哪套 AI 实现：旁边有 forum-ai 就是 'forum-ai'，否则是自带兜底 'bundled'。
      aiSource: aiSource(),
      features: FEATURES,
      contractVersion: CONTRACT_VERSION,
      // 报实际生效的预算（store 建的时候定下来的那个），不是写死的常量：
      // 宿主传了 materialChars、或 .env 里设了 NOTES_MATERIAL_CHARS，这里都得对得上。
      materialChars: Number.isFinite(store?.materialChars) && store.materialChars > 0 ? store.materialChars : DEFAULT_CHAR_BUDGET,
      limits: {
        maxFileBytes: UPLOAD_RULES.maxFileBytes,
        maxSessionBytes: UPLOAD_RULES.maxSessionBytes,
        maxFiles: UPLOAD_RULES.maxFiles,
        requirement: MAX_REQUIREMENT,
        reviewDraft: MAX_REVIEW_DRAFT,
      },
      extensions: UPLOAD_RULES.extensions,
    };
  }

  const routes = [
    ['GET', ['status'], async () => ok(200, statusSnapshot())],

    /**
     * 打开/刷新这篇帖子在编辑区的整理工作台。
     *
     * 面板在挂载时与用户每次编辑（防抖后）都会打这个接口：它把**编辑区当前内容**
     * 解析成块并落库，于是面板随时知道"编辑区现在是什么"——这就是"实时监控"的全部含义，
     * 它不调用模型，所以不花钱。上传的材料在这里作为补充并入（`append`）。
     */
    ['POST', ['session'], async (ctx) => {
      const user = requireUser(ctx);
      // 注意 multipart 来的表单字段**全是字符串**：`postId` 必须以数字存进 post_id，
      // 否则 `sessionForPost` 的 `post_id = ?` 永远配不上，同一篇帖子会重复建工作台。
      const rawPost = ctx.body?.postId ?? null;
      const postId = rawPost == null || rawPost === '' ? null : asInt(rawPost);
      let sessionId = ctx.body?.sessionId == null ? null : asInt(ctx.body.sessionId);
      // 同一篇帖子复用同一条会话：否则每次打开都会新建，材料要重传、历史会散开
      if (!sessionId && postId) sessionId = store.sessionForPost(user.id, postId)?.id ?? null;
      const { session, blocks, sources, warnings, structure } = await materialize({
        user,
        sessionId,
        draft: ctx.body?.draft,
        title: ctx.body?.title,
        postId,
        files: ctx.files,
        append: ctx.body?.append !== false,
      });
      return ok(200, {
        sessionId: session.id,
        title: session.title,
        blocks,
        // 结构分析整份回传（stats / headings / sections / tree / titleCandidates）：
        // sections 是面板画大纲与"第几节"定位用的，stats 是顶部的计数胶囊。
        stats: structure.stats,
        structure,
        sources: sources.map((source) => ({ kind: source.kind, name: source.name, bytes: source.bytes })),
        warnings,
      });
    }],

    /**
     * 只抽取、不调模型：把上传的文件抽成 Markdown 源码（公式归一化过）。
     *
     * 给积木编辑器左栏那段「📄 PDF / 文档 → Markdown」用 —— **这条不花钱、不需要 AI 配置**。
     * 图片不在这里：图片要视觉模型，只能走 `/session` + `/generate` 那条花钱的路。
     */
    ['POST', ['extract'], async (ctx) => {
      requireUser(ctx);
      const files = Array.isArray(ctx.files) ? ctx.files : [];
      const items = [];
      for (const file of files) {
        try {
          const material = await extractMaterial(file);
          // 归一化在这里做一遍：材料进模型前本来也会过这道，抽取结果同样需要
          // （`\[…\]` / `\begin{equation}` 这类定界符统一成 `$$…$$`）。
          // `normalizeBlocks` 的返回**不是数组**（实测是个对象），所以三种形状都兜：
          // 返回数组就用它、返回 `{blocks:[…]}` 就用里面那份、别的就当它原地改过。
          const blocks = material.blocks ?? [];
          const normalized = normalizeBlocks(blocks);
          const list = Array.isArray(normalized)
            ? normalized
            : Array.isArray(normalized?.blocks)
              ? normalized.blocks
              : blocks;
          items.push({
            name: material.name ?? file?.filename ?? '',
            kind: material.kind,
            bytes: material.bytes,
            markdown: blocksToMarkdown(list),
            warnings: (material.warnings ?? []).length,
          });
        } catch (error) {
          items.push({
            name: file?.filename ?? '',
            error: error instanceof Error ? error.message : '这个文件抽不出来',
          });
        }
      }
      return ok(200, {
        items,
        markdown: items
          .filter((item) => item.markdown)
          .map((item) => String(item.markdown).trim())
          .join('\n\n---\n\n'),
      });
    }],

    /**
     * 图片 → Markdown 源码：图片交给**视觉模型**，只回 Markdown。
     *
     * 跟 `/extract` 是两条路：那条抽文字层、不花钱也不需要 AI；这条**必须有配好的 AI**
     * ——图片里没有「文字层」可抽，只能让模型看。图片按 data URL 走 JSON（不走 multipart，
     * 于是不必动上传扩展名白名单）。返回的正文已经要求模型只写 Markdown、公式用
     * `$…$` / `$$…$$`。
     */
    ['POST', ['extract-image'], async (ctx) => {
      const user = requireUser(ctx);
      if (!config.configured) {
        throw new NotesError(503, 'notes_not_configured', '这个站点还没有配置 AI 接口，请联系管理员（图片识别必须走模型）');
      }
      if (!check(`${user.id}:extract-image`)) throw new NotesError(429, 'ai_rate_limited', '操作太频繁，请等一分钟再试');
      const list = Array.isArray(ctx.body?.images) ? ctx.body.images : [];
      if (!list.length) throw new NotesError(400, 'no_images', '没有收到图片');
      if (list.length > MAX_IMAGES) throw new NotesError(400, 'too_many_images', `一次最多 ${MAX_IMAGES} 张图片`);

      const parts = [];
      for (const item of list.slice(0, MAX_IMAGES)) {
        const url = String(item?.dataUrl ?? '');
        if (!/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(url)) {
          throw new NotesError(400, 'bad_image', '只收 png / jpg / webp / gif 图片');
        }
        // data URL 是 base64，长度约为原字节的 4/3
        if (url.length > MAX_IMAGE_BYTES * 1.4 + 1024) {
          throw new NotesError(400, 'image_too_large', `单张图片不能超过 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB`);
        }
        parts.push({ type: 'image_url', image_url: { url } });
      }
      const requirement = String(ctx.body?.requirement ?? '').trim().slice(0, 500);
      parts.push({ type: 'text', text: requirement || '把图里的公式转成 Markdown 源码。' });

      const answer = await chat([
        {
          role: 'system',
          content:
            '你是公式录入助手。看图，把里面的数学公式转成 Markdown 源码：行内公式用 $…$，行间公式用 $$…$$，' +
            'LaTeX 命令原样保留；公式之外的必要文字也用 Markdown（标题用 #，列表用 -）。' +
            '只输出转换结果本身，不要解释、不要寒暄、不要用 ``` 围栏包整篇。看不清的地方写 % 待确认。',
        },
        { role: 'user', content: parts },
      ]);
      const text = String(answer?.text ?? '').trim().replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '');
      return ok(200, { markdown: text, model: answer?.model ?? null, usage: answer?.usage ?? null });
    }],

    ['POST', ['generate'], async (ctx) => {
      const user = requireUser(ctx);
      if (!config.configured) throw new NotesError(503, 'notes_not_configured', '这个站点还没有配置 AI 接口，请联系管理员');
      if (!check(`${user.id}:generate`)) throw new NotesError(429, 'ai_rate_limited', '操作太频繁，请等一分钟再试');
      // 先同步编辑区的最新内容，再动手整理：用户点「整理」时作用的一定是眼前那段文字
      const { session, blocks } = await syncDraft(ctx, user);
      // 可选的要求文字也要过一遍长度：/turn 有这道闸、/generate 以前没有，
      // 于是同一段超长文字在「提需求」里被拦、在「整理」里却能直接送进模型。
      const requirement = typeof ctx.body?.requirement === 'string' ? ctx.body.requirement.trim() : '';
      if (requirement.length > MAX_REQUIREMENT) throw badRequest(`要求最多 ${MAX_REQUIREMENT} 字`);
      const result = await generateImpl({
        blocks,
        // 编辑区里那段文字是主体；材料里抽出来的图连同它一起发过去，模型才能给图片写说明
        assets: sessionAssets(session.id),
        title: session.title,
        requirement,
      });
      if (!result.ok) throw new NotesError(ERROR_STATUS[result.error.code] ?? 500, result.error.code, result.error.message);

      const draftMd = persistOutcome(session, result);
      // 落库时 op 已经应用过了（persistOutcome 内部就是 applyOps），所以这里**不能**
      // 再挂进 pendingOps：面板的「应用到编辑区」不带 ops，走的正是 pendingOps 分支，
      // 挂在里面会让 insert 变两个、replace 白跑一趟（真机上表现为"每次应用都多一段"）。
      pendingOps.delete(session.id);
      store.addMessage({
        sessionId: session.id, role: 'assistant', requirement: '', draftMd,
        ops: result.ops, skipped: result.skipped, warnings: result.warnings, usage: result.usage,
      });
      store.addUsage({
        userId: user.id, sessionId: session.id, model: result.model, prompt: result.usage?.prompt ?? 0, completion: result.usage?.completion ?? 0,
      });
      return ok(200, {
        sessionId: session.id,
        title: result.title,
        tags: result.tags,
        blocks: result.blocks,
        ops: result.ops,
        applied: result.applied,
        draftMd,
        skipped: result.skipped,
        notes: result.notes,
        needsMore: result.needsMore,
        warnings: result.warnings,
        model: result.model,
        usage: result.usage,
        material: { chars: result.material?.chars ?? 0, images: result.material?.images ?? 0 },
      });
    }],

    ['POST', ['turn'], async (ctx) => {
      const user = requireUser(ctx);
      if (!check(`${user.id}:turn`)) throw new NotesError(429, 'ai_rate_limited', '操作太频繁，请等一分钟再试');
      const requirement = typeof ctx.body?.requirement === 'string' ? ctx.body.requirement.trim() : '';
      if (requirement.length === 0) throw badRequest('请写下你的要求');
      if (requirement.length > MAX_REQUIREMENT) throw badRequest(`要求最多 ${MAX_REQUIREMENT} 字`);
      if (!config.configured) throw new NotesError(503, 'notes_not_configured', '这个站点还没有配置 AI 接口，请联系管理员');

      const { session, blocks } = await syncDraft(ctx, user);
      const result = await turnImpl({
        blocks,
        assets: sessionAssets(session.id),
        title: session.title,
        draft: session.draft_md ?? '',
        requirement,
        history: store.listMessages(session.id).map((row) => ({ requirement: row.requirement, notes: parseList(row.warnings_json) })),
      });
      if (!result.ok) throw new NotesError(ERROR_STATUS[result.error.code] ?? 500, result.error.code, result.error.message);

      const draftMd = persistOutcome(session, result);
      // 同 /generate：这一轮的 op 已经落库，不能再排进 pendingOps（否则 /apply 会重跑一遍）
      pendingOps.delete(session.id);
      store.addMessage({ sessionId: session.id, role: 'user', requirement, draftMd, ops: result.ops, skipped: result.skipped, warnings: result.warnings, usage: result.usage });
      store.addTurnLog({ sessionId: session.id, requirement, applied: (result.applied ?? []).length, skipped: (result.skipped ?? []).length, needsMore: (result.needsMore ?? []).length });
      store.addUsage({ userId: user.id, sessionId: session.id, model: result.model, prompt: result.usage?.prompt ?? 0, completion: result.usage?.completion ?? 0 });
      return ok(200, {
        sessionId: session.id,
        title: result.title,
        tags: result.tags,
        blocks: result.blocks,
        ops: result.ops,
        applied: result.applied,
        draftMd,
        skipped: result.skipped,
        notes: result.notes,
        needsMore: result.needsMore,
        warnings: result.warnings,
        model: result.model,
        usage: result.usage,
      });
    }],

    ['POST', ['apply'], async (ctx) => {
      const session = requireSession(ctx, asInt(ctx.body?.sessionId));
      const blocks = parseList(session.blocks_json);
      // 没有客户端 ops 时**不再重跑服务端那批 op**：它们已经在 /generate、/turn 的
      // persistOutcome 里应用进 blocks_json / draft_md 了（pendingOps 现在只留给
      // 「待应用」的语义，落库那一刻就清空）。这里只是把当前会话状态回给面板，
      // 顺手报出这一轮真正应用了哪几条，避免"点一次多一段"。
      const pending = pendingOps.get(session.id) ?? [];
      const ops = Array.isArray(ctx.body?.ops) ? ctx.body.ops : pending;
      const lastAssistant = ops.length === 0
        ? [...store.listMessages(session.id)].reverse().find((row) => row.role === 'assistant')
        : null;
      if (ops.length === 0) {
        const draftMd = session.draft_md ?? markdownOf({ blocks, title: session.title, tags: [] }, blocks);
        return ok(200, {
          blocks,
          title: session.title,
          tags: parseList(session.tags_json),
          draftMd,
          applied: JSON.parse(lastAssistant?.ops_json || '[]') ?? [],
          skipped: JSON.parse(lastAssistant?.skipped_json || '[]') ?? [],
        });
      }
      const outcome = applyOps(blocks, ops, { title: session.title, tags: parseList(session.tags_json) });
      // 没有 format op 时 applyOps 的 markdown 是 null（它只负责"整篇替换"这一种情况），
      // 这里补出唯一正确的落地文本：按块序列化。否则会直接撞上 draft_md 的 NOT NULL 约束。
      const draftMd = markdownOf(outcome, outcome.blocks);
      store.updateDraft(session.id, {
        blocks: outcome.blocks, title: outcome.title, tags: outcome.tags, draftMd, status: session.status,
      });
      pendingOps.delete(session.id);
      return ok(200, { blocks: outcome.blocks, title: outcome.title, tags: outcome.tags, draftMd, applied: outcome.applied, skipped: outcome.skipped });
    }],

    ['POST', ['save'], async (ctx) => {
      const user = requireUser(ctx);
      const sessionId = asInt(ctx.body?.sessionId);
      const session = requireSession(ctx, sessionId);
      // 长度闸与 /session 同一口径：以前这里直接把任意长度的字符串写进
      // notes_messages.draft_md，是"同一个上限、一条路拦一条路不拦"，等于没拦。
      const incomingDraft = typeof ctx.body?.draftMd === 'string' ? ctx.body.draftMd : session.draft_md;
      if (incomingDraft.length > MAX_DRAFT) throw new NotesError(413, 'notes_too_large', `正文最多 ${MAX_DRAFT} 字`);
      const incomingTitle = typeof ctx.body?.title === 'string' && ctx.body.title.length > 0 ? ctx.body.title : session.title;
      if (incomingTitle.length > MAX_TITLE) throw badRequest(`标题最多 ${MAX_TITLE} 字`);
      const postId = ctx.body?.postId == null ? null : asInt(ctx.body.postId);
      store.updateDraft(session.id, {
        blocks: parseList(session.blocks_json),
        title: incomingTitle,
        tags: parseList(session.tags_json),
        draftMd: incomingDraft,
        status: 'saved',
        // 落库，不只是回显：面板下次带着同一个 postId 回来时要用 sessionForPost
        // 找到这条工作台（否则材料与历史会散成一条条）
        postId,
      });
      store.setPref(user.id, `session:${session.id}:saved`, String(Date.now()));
      return ok(200, { sessionId: session.id, postId, saved: true });
    }],

    ['GET', ['sessions'], async (ctx) => {
      const user = requireUser(ctx);
      const limit = asInt(ctx.query?.get?.('limit')) ?? 20;
      return ok(200, {
        sessions: store.listSessions(user.id, { limit }).map((row) => ({
          id: row.id, title: row.title, status: row.status, postId: row.post_id,
          sourceCount: row.source_count, materialChars: row.material_chars, tags: JSON.parse(row.tags_json || '[]'),
          createdAt: row.created_at, updatedAt: row.updated_at,
        })),
      });
    }],

    ['GET', ['session', ':id'], async (ctx) => {
      const user = requireUser(ctx);
      const session = requireSession(ctx, asInt(ctx.params?.id));
      return ok(200, {
        session: {
          id: session.id, title: session.title, status: session.status, postId: session.post_id,
          draftMd: session.draft_md, blocks: parseList(session.blocks_json),
          tags: parseList(session.tags_json), createdAt: session.created_at, updatedAt: session.updated_at,
        },
        materials: store.listMaterials(session.id).map((row) => ({
          kind: row.kind, name: row.name, bytes: row.bytes, warnings: parseList(row.warnings_json),
        })),
        messages: store.listMessages(session.id).map((row) => serializeMessage(row)),
        reviews: store.listReviewsBySession(session.id).map((row) => ({ id: row.id, summary: row.summary, createdAt: row.created_at })),
        usage: store.usageSummary(user.id, session.id),
      });
    }],

    /**
     * 聊天式历史：这条工作台每一轮的记录（含当轮草稿快照）。
     *
     * 单独开一个 GET 而不是塞进 `/session/:id`：`/session/:id` 每次挂载都会打，
     * 而 `draftMd` 快照是整篇草稿（几 KB × 轮数），没必要在每次刷新时都拖着走。
     */
    ['GET', ['messages'], async (ctx) => {
      const user = requireUser(ctx);
      const sessionId = asInt(ctx.query?.get?.('sessionId'));
      if (!sessionId) throw badRequest('请提供 sessionId');
      const session = requireSession(ctx, sessionId);
      return ok(200, {
        sessionId: session.id,
        draftMd: session.draft_md ?? '',
        messages: store.listMessages(session.id).map((row) => serializeMessage(row)),
      });
    }],

    /**
     * 回滚草稿到某一轮结束时的样子。
     *
     * 语义边界（很重要）：只改**草稿与预览**，绝不碰编辑区 —— 写回编辑区仍然要
     * 用户点「应用到编辑区」。历史只增不减：回滚本身也留一条 assistant 消息，
     * 这样"什么时候回滚过"在对话里看得见，也不会把后来的轮次真的删掉。
     */
    ['POST', ['rollback'], async (ctx) => {
      const user = requireUser(ctx);
      const sessionId = asInt(ctx.body?.sessionId);
      const messageId = asInt(ctx.body?.messageId);
      if (!sessionId || !messageId) throw badRequest('请提供 sessionId 与 messageId');
      const session = requireSession(ctx, sessionId);
      const message = store.messageById(session.id, messageId);
      if (!message) throw notFound('找不到要回滚到的那一轮');
      const draftMd = String(message.draft_md ?? '');
      if (draftMd.trim().length === 0) throw badRequest('那一轮没有留下草稿快照，没法回滚');
      const restored = restoreSnapshot(session, draftMd);
      pendingOps.delete(session.id);
      store.addMessage({
        sessionId: session.id,
        role: 'assistant',
        requirement: `回滚到第 ${message.id} 轮`,
        draftMd,
        ops: [],
        skipped: [],
        warnings: [],
        usage: {},
      });
      return ok(200, {
        sessionId: session.id,
        messageId: message.id,
        title: restored.session.title,
        draftMd,
        blocks: restored.blocks,
        structure: restored.structure,
      });
    }],

    ['POST', ['review'], async (ctx) => {
      const user = requireUser(ctx);
      if (!check(`${user.id}:review`)) throw new NotesError(429, 'ai_rate_limited', '操作太频繁，请等一分钟再试');
      if (!config.configured) throw new NotesError(503, 'notes_not_configured', '这个站点还没有配置 AI 接口，请联系管理员');
      // 与整理同口径：审查的是编辑区里此刻的内容
      let session = null;
      let draft = typeof ctx.body?.draft === 'string' ? ctx.body.draft : '';
      const sessionId = ctx.body?.sessionId == null ? null : asInt(ctx.body.sessionId);
      if (sessionId || draft.trim().length > 0) {
        const synced = await syncDraft(ctx, user);
        session = synced.session;
        draft = session.draft_md ?? draft;
      }
      if (draft.trim().length === 0) throw badRequest('编辑区还是空的，没有可审查的内容');
      if (draft.length > MAX_REVIEW_DRAFT) throw new NotesError(413, 'notes_too_large', `草稿最多 ${MAX_REVIEW_DRAFT} 字`);

      const result = await reviewImpl({ draft, title: session?.title ?? '', scope: typeof ctx.body?.scope === 'string' ? ctx.body.scope : 'content' });
      if (!result.ok) throw new NotesError(ERROR_STATUS[result.error.code] ?? 500, result.error.code, result.error.message);

      const contentHash = hashText(draft);
      let reviewId = store.reviewByHash(user.id, contentHash)?.id ?? null;
      if (reviewId) {
        // 命中缓存只说明"这段草稿审过"，但**这次模型的结论可能不一样**（换了模型、
        // 提示词改了、模型本来就非确定性）。所以覆盖落库，再按新 findings 重排条目；
        // 只复用 id 不落库的话，界面看到的是新结论、点应用时吃的是旧 findings。
        store.updateReview(reviewId, { summary: result.summary, findings: result.findings, model: result.model ?? '' });
        store.replaceReviewItems(reviewId, result.findings);
      } else {
        reviewId = store.saveReview({
          sessionId: session?.id ?? null, postId: session?.post_id ?? null, userId: user.id,
          contentHash, summary: result.summary, findings: result.findings, model: result.model ?? '',
        });
        for (const finding of result.findings) {
          store.addReviewItem({ reviewId, findingId: finding.id, kind: finding.kind, severity: finding.severity, quote: finding.quote });
        }
      }
      return ok(200, {
        reviewId, sessionId: session?.id ?? null, summary: result.summary, findings: result.findings,
        strengths: result.strengths, dropped: result.dropped, model: result.model,
      });
    }],

    ['POST', ['review', ':id', 'apply'], async (ctx) => {
      const user = requireUser(ctx);
      const reviewId = asInt(ctx.params?.id);
      const review = reviewId ? store.reviewById(reviewId, user.id) : null;
      if (!review) throw notFound('找不到这次审查结果');
      const draft = typeof ctx.body?.draft === 'string' ? ctx.body.draft : (review.session_id ? store.sessionById(review.session_id)?.draft_md ?? '' : '');
      const findings = JSON.parse(review.findings_json || '[]');
      const outcome = applyReviewPatch(draft, findings);
      for (const item of outcome.applied) store.markReviewItemApplied(reviewId, item.id);
      if (review.session_id) {
        const session = store.sessionById(review.session_id);
        if (session) {
          // 重新从落地后的草稿里解析块：原来的实现是拿会话里**打补丁之前**的
          // blocks_json 配上补丁之后的新草稿，于是 GET /session/:id、GET /messages
          // 返回的 blocks 与 diff 是过期文本（与 restoreSnapshot 同一口径才对）。
          store.updateDraft(session.id, {
            blocks: editorBlocks(outcome.draft, '审查'), title: session.title, tags: parseList(session.tags_json),
            draftMd: outcome.draft, status: session.status,
          });
        }
      }
      return ok(200, { reviewId, draftMd: outcome.draft, applied: outcome.applied, skipped: outcome.skipped });
    }],

    ['GET', ['assets', ':id'], async () => {
      throw notFound('图片只读不存：材料里的图片只在本轮请求内传给模型，服务端不留副本');
    }],
  ];

  function markdownOf(result, blocks) {
    return typeof result.markdown === 'string' && result.markdown.length > 0 ? result.markdown : blocksToMarkdown(blocks);
  }

  function persistOutcome(session, result) {
    const blocks = Array.isArray(result.blocks) && result.blocks.length > 0 ? result.blocks : parseList(session.blocks_json);
    const markdown = markdownOf(result, blocks);
    store.updateDraft(session.id, {
      blocks, title: result.title ?? session.title, tags: result.tags ?? parseList(session.tags_json),
      draftMd: markdown, status: session.status,
    });
    return markdown;
  }

  /**
   * 一条消息 → 面板能直接画进聊天线程的形状。
   *
   * `draftMd` 是这一轮结束时那篇草稿的快照（见 store.addMessage）：
   * 面板拿它就能把"回滚到这一版"变成一次点击，不必重放 ops。
   */
  function serializeMessage(row, { withDraft = true } = {}) {
    return {
      id: row.id,
      role: row.role,
      requirement: row.requirement ?? '',
      createdAt: row.created_at,
      ops: parseList(row.ops_json),
      skipped: parseList(row.skipped_json),
      warnings: parseList(row.warnings_json),
      usage: parseObject(row.usage_json),
      draftMd: withDraft ? String(row.draft_md ?? '') : '',
    };
  }

  /** 把会话草稿恢复成快照那一版。只动草稿/块/标题，**不碰编辑区**。 */
  function restoreSnapshot(session, draftMd) {
    const next = editorBlocks(draftMd, '回滚');
    const structure = analyzeStructure(next);
    const title = session.title || (structure.titleCandidates[0]?.text ?? '');
    store.updateDraft(session.id, {
      blocks: next, title, tags: parseList(session.tags_json), draftMd, status: session.status,
    });
    return { session: store.sessionById(session.id), blocks: next, structure };
  }

  return { config, routes, requireUser, requireSession, rateLimit: check, pendingOps, statusSnapshot };
}

/**
 * 历史行里的 JSON 列一律走这两个解析器。
 *
 * 为什么不用 `JSON.parse(row.x || '[]')`：老库、手工插入的行、以及将来加字段时
 * 都可能拿到残缺的 JSON，一个坏列不该让整条 `/messages` 挂掉（面板那边只会看到
 * "历史为空"）。宁可少一条明细，也要把对话线程画出来。
 */
function parseList(json) {
  try {
    const value = JSON.parse(json || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function parseObject(json) {
  try {
    const value = JSON.parse(json || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function hashText(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return `h${(hash >>> 0).toString(16)}-${text.length}`;
}

/**
 * 材料行的去重指纹：同名、同字节数、同块内容才算同一份。
 *
 * 用途：面板每次编辑都会打 `/session`，而每次都会把已上传的材料**重新抽取一遍**。
 * 只按名字去重不够（同名文件可以被改内容），只按内容去重又太贵，所以三个一起比。
 */
function materialFingerprint(source) {
  const blocks = Array.isArray(source?.blocks) ? source.blocks : [];
  return `${String(source?.kind ?? '')}\u0000${String(source?.name ?? '')}\u0000${Number(source?.bytes) || 0}\u0000${hashText(blocks.map((block) => String(block?.text ?? '')).join('\u0001'))}`;
}

function matchPath(pattern, pathname) {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length !== pattern.length) return null;
  const params = {};
  for (let i = 0; i < pattern.length; i += 1) {
    if (pattern[i].startsWith(':')) {
      if (parts[i].length === 0) return null;
      params[pattern[i].slice(1)] = parts[i];
    } else if (pattern[i] !== parts[i]) {
      return null;
    }
  }
  return params;
}

function matchRoute(entry, method, pathname) {
  const [wantMethod, pattern] = entry;
  if (wantMethod !== method) return null;
  return matchPath(pattern, pathname);
}

/** 路径存在但方法不对（用来把 405 和 404 分开报）。 */
function matchAnyMethod(handlers, pathname) {
  for (const entry of handlers.routes) {
    if (matchPath(entry[1], pathname)) return entry[0];
  }
  return null;
}

/**
 * 入口：`pathname` 是**已经去掉 basePath** 的路径（例如 `/session/3`）。
 *
 * @returns {Promise<{status:number, body:object}>}
 */
export async function handle(handlers, ctx = {}) {
  try {
    const method = String(ctx.method ?? 'GET').toUpperCase();
    const pathname = ctx.pathname ?? '/';
    for (const entry of handlers.routes) {
      const params = matchRoute(entry, method, pathname);
      if (!params) continue;
      return await entry[2]({ ...ctx, params });
    }
    // 路径对、方法不对 → 405（原来的写法把方法不匹配也算成"没这条路由"，
    // 于是 405 那条分支永远不会被执行，`GET /generate` 会回 404 让人以为接口不存在）。
    const allowed = matchAnyMethod(handlers, pathname);
    if (allowed) return fail(405, 'method_not_allowed', `这个接口要用 ${allowed}`);
    return fail(404, 'notes_not_found', '这个整理接口不存在');
  } catch (error) {
    return toResponse(error);
  }
}

export { createRateLimiter, NotesError, ERROR_STATUS, hashText };
