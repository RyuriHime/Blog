/**
 * 「📄 文档 / PDF → Markdown」与「🖼 图片 → Markdown（视觉）」两条转换的**宿主实现**。
 *
 * ── 为什么这两条从 note-agent 搬到这里 ────────────────────────────────────
 *
 * 它们原先的接口在 `note-agent/src/routes.mjs`（`POST /api/note-agent/extract`、
 * `/api/note-agent/extract-image`），但**部署脚本只替换 `src/` `public/` `scripts/` 三个目录**
 * （见 `团队协作规范.md` 与 `docs/skeleton.md`）—— `note-agent/` 整个包不在部署范围内。
 * 于是界面（`public/views/doc-ai.js`）能上线，接口在线上是 404，实测就是
 * `POST /api/note-agent/extract` → 404 `notes_not_found`（而 `/api/note-agent/status` 是 200，
 * 因为它命中了 forum-ai 挂载层的兜底）。界面点一下「抽取」就报错。
 *
 * 搬进 `src/modules/ai/` 就够了：论坛自己的 AI 模块在部署范围内，而且线上已经配好 AI
 * （`/api/note-agent/status` 报 `configured:true · aiSource=forum-ai`）。
 *
 * ── 为什么是「搬」而不是「抄一份抽取器」 ──────────────────────────────────
 *
 * 抽取本体（PDF / DOCX / PPTX / 文本 → 块 → Markdown）不在这里重写：
 * `note-agent/src/extract/index.mjs` 的 `extractMaterial` 在 `181654f`（导入完整站点那次）
 * 就已经在仓库里、服务器上也有。**直接 import 复用**，只补上「这一层缺的那一段」——
 * 把 HTTP 来的 JSON + data URL 变成抽取器要的 `Buffer`，再把块推过公式归一化与
 * `blocksToMarkdown`。抄一份等于日后两份抽取器各自漂移（页脚的坑、公式定界符的坑都要踩两遍）。
 *
 * ── 路由形状：JSON + data URL，不走 multipart ─────────────────────────────
 *
 * 宿主路由层不支持 multipart，站内「头像上传 / 团队文件柜」就是 JSON + data URL 约定
 * （`src/modules/team/routes.js` 的 `/api/teams/:id/files`）。所以文档那条也从
 * `FormData` 改成 `{ files: [{ name, dataUrl }] }`，前端 `readAsDataUrl` 帮助函数现成。
 * 代价是 base64 的 33% 膨胀，靠**逐路由**的 `bodyLimit` 兜住（见 `src/core/router.js`）。
 */
import { ensure } from '../../core/http.js';
import { extractMaterial } from '../../../note-agent/src/extract/index.mjs';
import { UPLOAD_RULES } from '../../../note-agent/src/uploads-meta.mjs';
import { normalizeBlocks } from '../../../note-agent/src/formulas.mjs';
import { blocksToMarkdown } from '../../../note-agent/src/blocks.mjs';
import { MAX_IMAGE_BYTES, MAX_IMAGES } from '../../../note-agent/src/material.mjs';
import { AI_CAPABILITIES } from './schema.js';

/** 单次最多几个文档。与 note-agent 的单会话上限同源（`UPLOAD_RULES.maxFiles`）。 */
const MAX_FILES = UPLOAD_RULES.maxFiles;

/** 这一批文档的字节总量上限（`UPLOAD_RULES.maxSessionBytes`）。 */
const MAX_FILES_BYTES = UPLOAD_RULES.maxSessionBytes;

/** 单个文档的字节上限（`UPLOAD_RULES.maxFileBytes`）。 */
const MAX_FILE_BYTES = UPLOAD_RULES.maxFileBytes;

/**
 * 这两条路由的请求体上限。
 *
 * data URL 是 base64（约 4/3），所以上限 ≈ 原字节 × 1.4 + 每项一点 JSON 开销：
 *   · `/extract`：一批文档最多 `MAX_FILES_BYTES`（12MB）→ 16.8MB，取 20MB；
 *   · `/extract-image`：最多 `MAX_IMAGES`（6）张 × `MAX_IMAGE_BYTES`（2MB）→ 16.8MB，取 20MB。
 *
 * **只有这两条**抬到 20MB（见 `src/core/router.js` 第 4 个形参的注释：抬全站上限等于让
 * 每一个接口都更容易被一条巨大的请求体打死）。
 */
export const AI_EXTRACT_BODY_LIMIT = 20 * 1024 * 1024;

/** 允许的图片 MIME（与 note-agent 的 `MAX_IMAGES` 那条路一致）。 */
const IMAGE_MIME = /^data:image\/(png|jpe?g|webp|gif);base64,/i;

/** 图片识别用的系统提示词（与 note-agent `routes.mjs` 的 `/extract-image` 逐字同源）。 */
const IMAGE_SYSTEM_PROMPT =
  '你是公式录入助手。看图，把里面的数学公式转成 Markdown 源码：行内公式用 $…$，行间公式用 $$…$$，' +
  'LaTeX 命令原样保留；公式之外的必要文字也用 Markdown（标题用 #，列表用 -）。' +
  '只输出转换结果本身，不要解释、不要寒暄、不要用 ``` 围栏包整篇。看不清的地方写 % 待确认。';

/** 图片那条的默认要求（前端可以另给一句，见 `requirement`）。 */
const IMAGE_DEFAULT_REQUIREMENT = '把图里的公式转成 Markdown 源码。';

/**
 * 能力目录里的人话标签。
 *
 * 403 的人话必须与目录**同源**：写死「没有『修改内容』授权」这种句子，加一项能力
 * 就变成骗人的提示。取不到 key 时退回 key 本身（宁可难看，也不假）。
 */
function capabilityLabel(key) {
  return AI_CAPABILITIES.find((item) => item.key === key)?.label ?? key;
}

/**
 * 解析一个 `data:<mime>;base64,<内容>`。
 *
 * 返回 `{ mime, data }`（`data` 是 `Buffer`），形状不对就抛 400。
 */
function parseDataUrl(raw, { field = 'files[].dataUrl' } = {}) {
  const url = String(raw ?? '');
  const comma = url.indexOf(',');
  ensure(url.startsWith('data:') && comma > 5, 400, 'bad_request', `${field} 必须是 data:<mime>;base64,… 形式`);
  const head = url.slice(5, comma);
  ensure(/;base64$/i.test(head), 400, 'bad_request', `${field} 只接受 base64 编码的 data URL`);
  const mime = head.slice(0, -';base64'.length).toLowerCase();
  // base64 里可能有换行（某些客户端会折行），Buffer 认；空的或解不出东西的一律当空文件。
  const data = Buffer.from(url.slice(comma + 1), 'base64');
  return { mime, data };
}

/** 人话格式化字节数（错误提示里要让用户看得懂「超了多少」）。 */
function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

/**
 * `POST /api/ai-edit/extract` —— 文档 / PDF → Markdown 源码。
 *
 * **不调模型、不花钱**，所以：
 *   · 不吃 `guardSiteBudget`（那是给「真会发出去一次模型调用」的接口用的）；
 *   · 仍然要过能力门与限流（它读用户上传的文件、占 CPU，不该是一条无门槛的公共算力）。
 */
export function registerExtractRoutes(
  ctx,
  { routes, db, viewer, callModel, guardCapability, guardSiteBudget, rateLimit, logOp },
) {
  /* ── 1. 文档 / PDF → Markdown（不调模型）────────────────────────────── */
  routes.add(
    'POST',
    '/api/ai-edit/extract',
    async (reqCtx) => {
      const user = viewer(reqCtx);
      const capability = 'extract';
      guardCapability(db, user.id, capability, extractForbiddenMessage(capability));

      const body = reqCtx.body ?? {};
      const list = Array.isArray(body.files) ? body.files : [];
      // 校验一律排在限流之前：一个填错的请求该拿到 400 告诉它哪里错了，
      // 而不是被记一次限流、还以为「额度用完了」（与 `/draft-range` 同一条纪律）。
      ensure(list.length > 0, 400, 'bad_request', '没有收到文件（files 必须是非空数组）');
      ensure(list.length <= MAX_FILES, 400, 'bad_request', `一次最多 ${MAX_FILES} 个文件`);

      const parsed = list.map((item, index) => {
        const { mime, data } = parseDataUrl(item?.dataUrl, { field: `files[${index}].dataUrl` });
        const name = String(item?.name ?? '').trim() || `未命名${index + 1}`;
        ensure(data.length > 0, 400, 'bad_request', `「${name}」是空文件`);
        ensure(
          data.length <= MAX_FILE_BYTES,
          400,
          'bad_request',
          `「${name}」是 ${formatBytes(data.length)}，超过单文件上限 ${formatBytes(MAX_FILE_BYTES)}`,
        );
        return { name, mime, data };
      });

      const totalBytes = parsed.reduce((sum, file) => sum + file.data.length, 0);
      ensure(
        totalBytes <= MAX_FILES_BYTES,
        400,
        'bad_request',
        `这一批文件共 ${formatBytes(totalBytes)}，超过单次上限 ${formatBytes(MAX_FILES_BYTES)}`,
      );

      rateLimit(`ai-edit:extract:${user.id}`, 10, 60 * 1000);

      // 单个文件抽失败**不中断整批**（与 note-agent 同一条硬规则）：用户一次传 5 个、
      // 其中一个是坏容器时，他要的是剩下 4 个能用 + 一条明确的人话，而不是整批 500。
      const items = [];
      for (const file of parsed) {
        try {
          const material = await extractMaterial({ filename: file.name, mime: file.mime, data: file.data });
          // 归一化在这里做一遍：材料进模型前本来也会过这道，抽取结果同样需要
          // （`\[…\]` / `\begin{equation}` 这类定界符统一成 `$$…$$`）。
          // `normalizeBlocks()` 的返回**不是数组**（实测是个对象 `{blocks, changed}`），
          // 直接喂给 `blocksToMarkdown` 会得到空串 —— 三种形状都兜住。
          const blocks = material.blocks ?? [];
          const normalized = normalizeBlocks(blocks);
          const normalizedList = Array.isArray(normalized)
            ? normalized
            : Array.isArray(normalized?.blocks)
              ? normalized.blocks
              : blocks;
          items.push({
            name: material.name ?? file.name,
            kind: material.kind,
            bytes: material.bytes,
            markdown: blocksToMarkdown(normalizedList),
            warnings: (material.warnings ?? []).length,
          });
        } catch (error) {
          items.push({ name: file.name, error: error instanceof Error ? error.message : '这个文件抽不出来' });
        }
      }

      return ctx.http.ok(reqCtx.res, {
        items,
        // 与 note-agent 的返回逐字同形：前端把每段的 Markdown 用一条分隔线拼起来。
        markdown: items
          .filter((item) => item.markdown)
          .map((item) => String(item.markdown).trim())
          .join('\n\n---\n\n'),
      });
    },
    { bodyLimit: AI_EXTRACT_BODY_LIMIT },
  );

  /* ── 2. 图片 → Markdown（视觉模型，花钱）────────────────────────────── */
  //
  // 与上一条是两条完全不同的路：图片没有「文字层」可抽，只能让模型看。
  // 所以这一条**必须**过能力门、全站闸门、限流，最后由 `callModel` 兜住
  // 「没配 key → 503 `ai_not_configured`（且不留任何日志行）」。
  routes.add(
    'POST',
    '/api/ai-edit/extract-image',
    async (reqCtx) => {
      const user = viewer(reqCtx);
      const capability = 'extract_image';
      // 真会发出去一次模型调用 —— 过全站闸门。
      guardCapability(db, user.id, capability, extractForbiddenMessage(capability));
      guardSiteBudget(db);

      const body = reqCtx.body ?? {};
      const list = Array.isArray(body.images) ? body.images : [];
      ensure(list.length > 0, 400, 'bad_request', '没有收到图片（images 必须是非空数组）');
      ensure(list.length <= MAX_IMAGES, 400, 'bad_request', `一次最多 ${MAX_IMAGES} 张图片`);

      const parts = [];
      for (const [index, item] of list.entries()) {
        const url = String(item?.dataUrl ?? '');
        ensure(IMAGE_MIME.test(url), 400, 'bad_request', `images[${index}].dataUrl 只收 png / jpg / webp / gif 图片`);
        // data URL 是 base64，长度约为原字节的 4/3。别在这里解码一遍只为量一下大小：
        // 6 张 2MB 的图解码一次就是 12MB 的临时内存，而长度已经够判了。
        ensure(
          url.length <= MAX_IMAGE_BYTES * 1.4 + 1024,
          400,
          'bad_request',
          `images[${index}] 超过单张上限 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB`,
        );
        parts.push({ type: 'image_url', image_url: { url } });
      }

      const requirement = String(body.requirement ?? '').trim().slice(0, 500);
      parts.push({ type: 'text', text: requirement || IMAGE_DEFAULT_REQUIREMENT });

      const { content, model } = await callModel(db, {
        userId: user.id,
        capability,
        // 动作名用 `extract`（不是 `draft`）：这两条接口**不产生任何可落盘的改动**
        // —— 它只是把文件读成文本交给用户，落盘仍要作者自己按「插入 / 替换」。
        // `extract` 同时进了 `AI_QUOTA_ACTIONS`：花了钱的图片识别要计每日额度与全站预算；
        // 而 `/extract` 那条不调模型的接口**连 op 日志都不写**，两条天然分开计费。
        action: 'extract',
        targetId: `${list.length} 张图片`,
        targetType: 'ai_extract',
        system: IMAGE_SYSTEM_PROMPT,
        // userText 只作为「上游没认 content 数组」时的兜底文字；真正发出去的是 userContent。
        userText: requirement || IMAGE_DEFAULT_REQUIREMENT,
        userContent: parts,
      });

      // **成功也要留一行审计**（`status='applied'`，没有 before/after —— 这次调用不改任何东西）。
      // 这一行是配额与全站预算的账：`usedToday` / `siteUsedToday` / 成本面板的 `billed`
      // 都只数 `status <> 'blocked'` 的行。不写它，用户可以在配额之外无限刷图片识别
      // —— 一个花了钱却不算账、也查不到的洞（真机上第一版就是这样：token 记了，账没记）。
      const opId = logOp(db, {
        userId: user.id,
        capability,
        action: 'extract',
        targetType: 'ai_extract',
        targetId: `${list.length} 张图片`,
        status: 'applied',
        reason: (requirement || IMAGE_DEFAULT_REQUIREMENT).slice(0, 200),
      });

      const markdown = String(content ?? '')
        .trim()
        .replace(/^```[a-z]*\n?/i, '')
        .replace(/\n?```$/, '');
      return ctx.http.ok(reqCtx.res, { markdown, model, opId });
    },
    { bodyLimit: AI_EXTRACT_BODY_LIMIT },
  );
}

/**
 * 403 的人话：能力目录里加一项，这句提示必须跟着该项的能力名走。
 *
 * 前端（`public/views/doc-ai.js`）在 403 上就地把服务端这句话显示出来，所以
 * 「没有『修改内容』授权」这种写死的句子一旦对不上真实被拒的能力，就是在骗用户。
 */
export function extractForbiddenMessage(capability) {
  return `没有「${capabilityLabel(capability)}」（${capability}）这项能力授权：去「AI 编辑台」打开对应开关，再回来重试。`;
}

/** 当前拒绝的是哪项能力（给 403 分支拼 `detail` 用，路由层不必再抄一份目录）。 */
export { capabilityLabel as extractCapabilityLabel };
