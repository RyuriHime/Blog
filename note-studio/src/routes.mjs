/**
 * routes —— 框架无关的 HTTP 处理器。
 *
 * 每个处理器收到一个 context，返回 `{ status, body }`，**不碰 req/res**，
 * 因此既能直接挂到论坛的原生 node:http 路由表，也能被 Express/Koa 包一层。
 *
 * 约定与论坛、forum-ai 完全一致：
 *   成功 `{ ok: true, data }`；失败 `{ ok: false, error: { code, message } }`。
 *
 * 依赖全部注入（store / ai / currentUser），所以本层不知道任何具体实现。
 */
import { GENERATOR } from './meta.mjs';

export const VERSION = GENERATOR.version;

/** 错误码 → HTTP 状态码；AI 部分与 forum-ai 的 AI_ERROR_STATUS 对齐。 */
export const NOTE_ERROR_STATUS = {
  ai_not_configured: 503,
  ai_timeout: 504,
  ai_rate_limited: 429,
  ai_unauthorized: 502,
  ai_unreachable: 502,
  ai_upstream_error: 502,
  ai_bad_response: 502,
  ai_empty_response: 502,
  ai_bad_json: 502,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  bad_request: 400,
  too_large: 413,
  rate_limited: 429,
  conflict: 409,
  internal_error: 500,
};

export const DEFAULT_LIMITS = {
  /** 单篇笔记正文字符上限。 */
  maxCharacters: 400_000,
  /** 单张图片（data URL 文本）字节上限。 */
  maxImageBytes: 8 * 1024 * 1024,
  /** 笔记名长度上限。 */
  maxNameLength: 120,
};

export const ok = (data, headers) => ({ status: 200, body: { ok: true, data }, headers });
export const fail = (status, code, message) => ({ status, body: { ok: false, error: { code, message } } });

const errorText = (error) => String(error?.message ?? error).slice(0, 300);

/** 把任意异常收敛成统一响应。未知错误不外泄内部信息。 */
export function toResponse(error) {
  const code = typeof error?.code === 'string' ? error.code : null;
  const mapped = code && NOTE_ERROR_STATUS[code] !== undefined ? NOTE_ERROR_STATUS[code] : null;
  const status = mapped ?? (typeof error?.status === 'number' ? error.status : 500);

  if (status === 500 && mapped === null && typeof error?.status !== 'number') {
    return fail(500, 'internal_error', '服务器内部错误，请稍后再试');
  }
  return fail(status, code ?? 'internal_error', errorText(error) || '请求失败');
}

const isDataUrl = (value) => /^data:image\/[a-z0-9.+-]+;base64,/i.test(String(value ?? ''));
const isHttpUrl = (value) => /^https?:\/\//i.test(String(value ?? ''));

/**
 * 生成全部笔记路由处理器。
 *
 * @param {object} deps
 * @param {object} deps.store        createNoteStore() 的返回值
 * @param {object} [deps.ai]         createAiBridge() 的返回值（可为 null：纯离线使用）
 * @param {(ctx:object) => object|null} deps.currentUser  当前用户，未登录返回 null
 * @param {(ctx:object) => (void|Promise<void>)} [deps.beforeWrite] 写操作前钩子（限流/审计）
 * @param {object} [deps.limits]     覆盖 DEFAULT_LIMITS
 */
export function createNoteHandlers(deps = {}) {
  const { store, ai = null, currentUser, beforeWrite = async () => {}, limits = {} } = deps;

  if (!store) throw new Error('createNoteHandlers 需要 store（createNoteStore() 的返回值）');
  if (typeof currentUser !== 'function') throw new Error('createNoteHandlers 需要 currentUser(ctx)');

  const config = { ...DEFAULT_LIMITS, ...limits };
  const aiStatus = () => {
    if (!ai) return { configured: false, model: null, baseUrl: null, envKeys: [] };
    try {
      return ai.status();
    } catch {
      return { configured: Boolean(ai.configured), model: null, baseUrl: null, envKeys: [] };
    }
  };

  function requireUser(ctx) {
    const user = currentUser(ctx);
    if (!user) {
      const error = new Error('请先登录');
      error.status = 401;
      error.code = 'unauthenticated';
      throw error;
    }
    return user;
  }

  function requireText(value, message) {
    if (typeof value !== 'string' || value.trim() === '') {
      const error = new Error(message);
      error.status = 400;
      error.code = 'bad_request';
      throw error;
    }
    return value;
  }

  function assertSize(value, max, message) {
    if (value.length > max) {
      const error = new Error(message);
      error.status = 413;
      error.code = 'too_large';
      throw error;
    }
  }

  function requireAi() {
    if (!ai || typeof ai.convertImage !== 'function') {
      const error = new Error('AI 未配置：请设置 AI_API_KEY 后再使用图片转写');
      error.code = 'ai_not_configured';
      throw error;
    }
    return ai;
  }

  return {
    /** GET /api/notes/status —— 公开；编辑器据此决定是否显示 AI 面板。 */
    async status() {
      return ok({
        version: VERSION,
        ai: aiStatus(),
        limits: { maxCharacters: config.maxCharacters, maxImageBytes: config.maxImageBytes },
      });
    },

    /** GET /api/notes —— 笔记列表。 */
    async list(ctx) {
      try {
        requireUser(ctx);
        const notes = await store.list();
        return ok({ notes, count: notes.length });
      } catch (error) {
        return toResponse(error);
      }
    },

    /** POST /api/notes —— 保存：写 `<name>.md` 与 `<name>.json`。 */
    async save(ctx) {
      try {
        requireUser(ctx);
        await beforeWrite(ctx);

        const body = ctx.body ?? {};
        const markdown = typeof body.markdown === 'string' ? body.markdown : null;
        if (markdown === null) {
          const error = new Error('缺少 markdown 字段（应为字符串）');
          error.status = 400;
          error.code = 'bad_request';
          throw error;
        }
        assertSize(markdown, config.maxCharacters, `正文过长（上限 ${config.maxCharacters} 字符）`);

        const name = typeof body.name === 'string' ? body.name : 'note';
        assertSize(name, config.maxNameLength, `文件名过长（上限 ${config.maxNameLength} 字符）`);

        const saved = await store.save({
          name,
          markdown,
          createdAt: body.createdAt ?? null,
          updatedAt: body.updatedAt ?? null,
          ai: Array.isArray(body.ai) ? body.ai : [],
        });

        return ok({
          name: saved.name,
          mdPath: saved.mdPath,
          jsonPath: saved.jsonPath,
          meta: saved.meta,
          files: { markdown: `${saved.name}.md`, meta: `${saved.name}.json` },
        });
      } catch (error) {
        return toResponse(error);
      }
    },

    /** GET /api/notes/:name —— 读取单篇。 */
    async getNote(ctx) {
      try {
        requireUser(ctx);
        const note = await store.read(ctx.params?.name);
        if (!note) {
          const error = new Error('笔记不存在');
          error.status = 404;
          error.code = 'not_found';
          throw error;
        }
        return ok({
          name: note.name,
          markdown: note.markdown,
          meta: note.meta,
          metaRecovered: Boolean(note.metaRecovered),
        });
      } catch (error) {
        return toResponse(error);
      }
    },

    /** DELETE /api/notes/:name —— 删除一对文件。 */
    async removeNote(ctx) {
      try {
        requireUser(ctx);
        await beforeWrite(ctx);
        const removed = await store.remove(ctx.params?.name);
        if (!removed) {
          const error = new Error('笔记不存在');
          error.status = 404;
          error.code = 'not_found';
          throw error;
        }
        return ok({ name: ctx.params?.name, removed: true });
      } catch (error) {
        return toResponse(error);
      }
    },

    /** POST /api/notes/convert —— 图片 → Markdown / LaTeX（走既有 AI 接口）。 */
    async convert(ctx) {
      try {
        requireUser(ctx);
        await beforeWrite(ctx);

        const body = ctx.body ?? {};
        const { dataUrl, kind = 'both', hint = '', source = null } = body;
        if (typeof dataUrl !== 'string' || (!isDataUrl(dataUrl) && !isHttpUrl(dataUrl))) {
          const error = new Error('请提供 data URL（data:image/...;base64,...）或 http(s) 图片地址');
          error.status = 400;
          error.code = 'bad_request';
          throw error;
        }
        assertSize(dataUrl, config.maxImageBytes, `图片过大（上限 ${config.maxImageBytes} 字节）`);

        const bridge = requireAi();
        const result = await bridge.convertImage({ dataUrl, kind, hint, source });
        return ok(result);
      } catch (error) {
        return toResponse(error);
      }
    },

    /** POST /api/notes/ai/organize —— AI 整理笔记。 */
    async organize(ctx) {
      try {
        requireUser(ctx);
        await beforeWrite(ctx);

        const body = ctx.body ?? {};
        const content = requireText(body.content, '缺少 content（要整理的正文）');
        assertSize(content, config.maxCharacters, `正文过长（上限 ${config.maxCharacters} 字符）`);

        const result = await requireAi().organizeNote({ title: String(body.title ?? ''), content });
        return ok(result);
      } catch (error) {
        return toResponse(error);
      }
    },

    /** POST /api/notes/ai/review —— AI 审阅笔记。 */
    async review(ctx) {
      try {
        requireUser(ctx);
        await beforeWrite(ctx);

        const body = ctx.body ?? {};
        const content = requireText(body.content, '缺少 content（要审阅的正文）');
        assertSize(content, config.maxCharacters, `正文过长（上限 ${config.maxCharacters} 字符）`);

        const result = await requireAi().reviewNote({ title: String(body.title ?? ''), content });
        return ok(result);
      } catch (error) {
        return toResponse(error);
      }
    },
  };
}

/**
 * 路由表：既给自带的路由器用，也给宿主用自己的 route() 逐条注册。
 *
 * 表内**顺序即优先级**：静态路径必须排在 `:name` 之前。
 * `pattern` 保留 `:name` 占位符，方便宿主直接喂给自己的路由注册函数。
 *
 * @returns {Array<{method:string, pattern:string, regex:RegExp, keys:string[], handler:Function, needsParams:boolean}>}
 */
export function createNoteRoutes(handlers, { prefix = '/api/notes' } = {}) {
  const table = [
    { method: 'GET', pattern: `${prefix}/status`, handler: handlers.status, needsParams: false },
    { method: 'GET', pattern: prefix, handler: handlers.list, needsParams: false },
    { method: 'POST', pattern: prefix, handler: handlers.save, needsParams: false },
    { method: 'POST', pattern: `${prefix}/convert`, handler: handlers.convert, needsParams: false },
    { method: 'POST', pattern: `${prefix}/ai/organize`, handler: handlers.organize, needsParams: false },
    { method: 'POST', pattern: `${prefix}/ai/review`, handler: handlers.review, needsParams: false },
    { method: 'GET', pattern: `${prefix}/:name`, handler: handlers.getNote, needsParams: true },
    { method: 'DELETE', pattern: `${prefix}/:name`, handler: handlers.removeNote, needsParams: true },
  ];

  return table.map((entry) => {
    const keys = [];
    const source = entry.pattern.replace(/:([A-Za-z_]+)/g, (_match, key) => {
      keys.push(key);
      return '([^/]+)';
    });
    return { ...entry, keys, regex: new RegExp(`^${source}$`) };
  });
}

/**
 * 把处理器接到路径上（原生 node:http 或任何框架）。
 *
 * 返回 `null` 表示本路由器不认这个请求，交给宿主自己的 404/405 处理。
 *
 * @returns {(ctx: { method: string, pathname: string }) => Promise<object|null>}
 */
export function createNoteRouter(handlers, { prefix = '/api/notes' } = {}) {
  const table = createNoteRoutes(handlers, { prefix });

  return async function route(ctx) {
    for (const entry of table) {
      if (entry.method !== ctx.method || !entry.regex.test(ctx.pathname)) continue;
      const match = entry.regex.exec(ctx.pathname);
      const params = entry.needsParams
        ? Object.fromEntries(entry.keys.map((key, index) => [key, decodeURIComponent(match[index + 1])]))
        : {};
      try {
        return await entry.handler({ ...ctx, params });
      } catch (error) {
        // 处理器内部已经收敛错误，这里是第二道保险
        return toResponse(error);
      }
    }
    return null;
  };
}
