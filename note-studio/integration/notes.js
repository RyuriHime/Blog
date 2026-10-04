/**
 * 论坛侧的 note-studio 接线层。
 *
 * 和 src/ai.js 一样，这里**只做接线**，不含任何业务逻辑：
 *
 *   1) 复用既有 AI 接口：`../forum-ai/src/index.mjs` 的 chat / extractJson / aiStatus，
 *      交给 note-studio 的 ai-bridge（note-studio 自己不认识 forum-ai 在哪）；
 *   2) 身份适配：把论坛的 ctx.user 传给 note-studio（未登录传 null，模块内部会 401）；
 *   3) 挂载：把 note-studio 的路由表与静态分发交给 server.js 注册。
 *
 * note-studio 是独立包，可以整个拷走；本文件是唯一知道「它放在哪」的地方。
 */
import { join } from 'node:path';

/**
 * 既有的 AI 接口。**允许缺席**：本仓的根目录版本（src/ 与 note-studio/ 同级）没有随包 forum-ai，
 * 那里编辑器与 .md/.json 导出照常工作，只有 AI 能力返回 503 ai_not_configured。
 */
let forumAi = {};
try {
  forumAi = await import('../forum-ai/src/index.mjs');
} catch {
  forumAi = {};
}
const { chat, extractJson, aiStatus } = forumAi;

/** 依次尝试的模块位置：环境变量优先，然后兼容两种常见仓库布局。 */
const CANDIDATES = [
  process.env.NOTE_STUDIO_PATH,
  new URL('../../../../note-studio/src/index.mjs', import.meta.url).href, // <repo>/.inspect/forum-ai-full/forum/src/
  new URL('../note-studio/src/index.mjs', import.meta.url).href, // <repo>/src/ 与 <repo>/note-studio/
  new URL('../../note-studio/src/index.mjs', import.meta.url).href,
].filter(Boolean);

let noteStudio = null;
let resolvedFrom = null;
for (const candidate of CANDIDATES) {
  try {
    noteStudio = await import(candidate);
    resolvedFrom = candidate;
    break;
  } catch {
    /* 试下一个位置 */
  }
}

if (!noteStudio) {
  throw new Error(
    '没有找到 note-studio：请设置 NOTE_STUDIO_PATH 指向 note-studio/src/index.mjs，' +
      '或把 note-studio 放在仓库根目录（与论坛同级）。',
  );
}

const { createNoteStore, createNoteHandlers, createNoteRoutes, createStaticHandler, createAiBridge } = noteStudio;

/**
 * 组装论坛要用到的 note-studio 部件。
 *
 * @param {{ dataDir?: string, publicDir?: string, prefix?: string }} [options]
 */
export function createNotes({ dataDir, publicDir = noteStudio.PUBLIC_DIR, prefix = '/notes' } = {}) {
  if (!dataDir) throw new Error('createNotes 需要 dataDir（笔记与 json 的存放目录）');

  const store = createNoteStore({ dir: dataDir });
  const ai = createAiBridge({ chat, extractJson, aiStatus });
  const handlers = createNoteHandlers({
    store,
    ai,
    currentUser: (ctx) => ctx.user ?? null,
  });

  return {
    /**
     * 挂在 /api/notes 下的处理器表：{ method, pattern, handler }。
     *
     * 这里顺手做一次 params 解码：论坛自己的路由表把 `:name` 原样取出（含 %E4%B8%AD 这种
     * 百分号编码），而 note-studio 期望拿到**已解码**的名字，否则中文文件名会找不到文件。
     */
    routes: createNoteRoutes(handlers).map((entry) => ({
      ...entry,
      handler: async (ctx) => {
        const params = Object.fromEntries(
          Object.entries(ctx.params ?? {}).map(([key, value]) => {
            try {
              return [key, decodeURIComponent(value)];
            } catch {
              return [key, value];
            }
          }),
        );
        return entry.handler({ ...ctx, params });
      },
    })),
    /** 编辑器静态资源分发：调用方自行决定放在请求处理流程的哪一步 */
    serveStatic: createStaticHandler({ root: publicDir, prefix }),
    handlers,
    store,
    ai,
    /** 实际加载到的 note-studio 入口，便于排查 */
    modulePath: resolvedFrom,
  };
}

/** 默认数据目录：论坛 data/notes（和 data/forum.db 并列，便于整体备份）。 */
export const defaultNotesDir = (forumRoot) => join(forumRoot, 'data', 'notes');
