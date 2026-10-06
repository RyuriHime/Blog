/**
 * 论坛侧的 note-studio 接线层（学术笔记子系统）。
 *
 * note-studio 本体（`note-studio/src/*`）**一个字节都没改**，所有「论坛自己的规矩」都在这一层。
 * 作者给的 `note-studio/integration/notes.js` 是「一个平铺目录 + 只查登录」，
 * 那样任何登录用户都能列出、打开、甚至删掉所有人的笔记；这一份改成：
 *
 *   1) 按人分目录     `data/notes/<用户id>/`         —— 各写各的；「删不到别人的」由文件系统物理保证
 *   2) 默认私密       `<名字>.share.json` 存在才算公开 —— 没有这个标记 = 只有自己看得到
 *   3) 公开广场       扫描所有目录下的 `*.share.json`  —— 登录后能读别人**公开**的，但只能读
 *
 * 作者的编辑器（挂在 `/notes/`）走的还是官方接口 `/api/notes*`；
 * 因为这里的按人分目录，它自带的「我的笔记」列表天然只会列出自己的笔记。
 *
 * 为什么不用索引文件记「谁公开了什么」：容易和真实文件不一致。
 * 这里一律**现场扫描**，笔记删了/标记丢了都不会留下幽灵条目。
 */
import { dirname, join } from 'node:path';
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { markdownToPlainText, renderMarkdown } from './markdown.js';

/* ------------------------------------------------------------------ */
/* 1. 加载 note-studio（候选路径；找不到就抛错，方便定位）             */
/* ------------------------------------------------------------------ */

const CANDIDATES = [
  process.env.NOTE_STUDIO_PATH,
  // <论坛>/note-studio/src/index.mjs  —— 我们的布局（笔记包和论坛放一起）
  new URL('../note-studio/src/index.mjs', import.meta.url).href,
  // 与论坛仓库同级
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
    '没有找到 note-studio：请把它放在 <论坛>/note-studio/ 下，或用 NOTE_STUDIO_PATH 指向 note-studio/src/index.mjs',
  );
}

const { createNoteStore, createNoteHandlers, createNoteRoutes, createStaticHandler, createAiBridge } = noteStudio;

/* ------------------------------------------------------------------ */
/* 2. 加载 forum-ai（允许缺席：缺席时 AI 能力返回 503，编辑/导出照常） */
/* ------------------------------------------------------------------ */

let forumAi = {};
try {
  forumAi = await import('../forum-ai/src/index.mjs');
} catch {
  forumAi = {};
}
const { chat, extractJson, aiStatus } = forumAi;

/* ------------------------------------------------------------------ */
/* 3. 常量与小工具                                                     */
/* ------------------------------------------------------------------ */

/** 公开标记的后缀。`store.mjs:115` 的 list() 只挑 `*.md`，所以这个文件不会被当成笔记。 */
const SHARE_SUFFIX = '.share.json';
const SHARE_SCHEMA = 'dsh-forum/note-share@1';
/** 未登录时用的占位目录名，不会真的落盘（未登录过不了 requireUser） */
const ANON_DIR = '_anonymous';
/** 用户 id 直接当目录名，只允许这几类字符；不合规的退化成十六进制 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const EXCERPT_LIMIT = 160;

function safeDirName(id) {
  const raw = String(id ?? '');
  if (SAFE_ID.test(raw)) return raw;
  return `u_${Buffer.from(raw, 'utf8').toString('hex').slice(0, 32) || 'unknown'}`;
}

async function readTextOrNull(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function readJsonFile(path) {
  const text = await readTextOrNull(path);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function writeJsonFile(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** 论坛的路由表把 `:name` 原样取出来（含 %E4%B8%AD 这种百分号编码），这里统一解码 */
function decodeParams(params) {
  return Object.fromEntries(
    Object.entries(params ?? {}).map(([key, value]) => {
      try {
        return [key, decodeURIComponent(value)];
      } catch {
        return [key, value];
      }
    }),
  );
}

const okBody = (data, headers) => ({ status: 200, body: { ok: true, data }, headers });
const failBody = (status, code, message) => ({ status, body: { ok: false, error: { code, message } } });

/** 展示用昵称：users 表的列名各版本可能不同，逐个兜底 */
function displayNameOf(user, fallback) {
  if (!user) return fallback;
  return user.display_name || user.nickname || user.name || user.username || fallback;
}

/* ------------------------------------------------------------------ */
/* 4. 主体                                                             */
/* ------------------------------------------------------------------ */

/**
 * 组装论坛要用的 note-studio 部件。
 *
 * @param {{
 *   dataDir: string,                        // 笔记根目录（各用户的子目录在这里面）
 *   publicDir?: string,                     // 编辑器静态资源目录
 *   prefix?: string,                        // 编辑器挂载前缀，默认 '/notes'
 *   userById?: (id: string) => object|null, // 广场显示作者昵称用
 *   resolveUser?: (req: object) => object,  // 判断静态页要不要登录
 * }} [options]
 */
export function createNotes({
  dataDir,
  publicDir = noteStudio.PUBLIC_DIR,
  prefix = '/notes',
  userById = () => null,
  resolveUser = null,
} = {}) {
  if (!dataDir) throw new Error('createNotes 需要 dataDir（笔记与 json 的存放根目录）');

  // AI 桥接：和作者那版一致，全部注入；forum-ai 缺席时 chat 为 undefined，
  // note-studio 的 status() 会如实报 configured:false，AI 路由返回 503。
  const ai = createAiBridge({ chat, extractJson, aiStatus });

  /**
   * 按「当前请求的登录用户」现场组装一套 store + handlers。
   *
   * 为什么要每次新建：作者的 handlers 在创建时就把 store 闭包进去了，
   * 想让每个人读写到自己的目录，就只能按用户各建一套。这两个工厂都只是拼对象，
   * 开销可以忽略（真正 IO 的是 save/list/read）。
   */
  function sessionFor(ctx) {
    const user = ctx.user ?? null;
    const userDir = user ? join(dataDir, safeDirName(user.id)) : join(dataDir, ANON_DIR);
    const store = createNoteStore({ dir: userDir });
    const handlers = createNoteHandlers({ store, ai, currentUser: (c) => c.user ?? null });
    return { user, userDir, store, handlers };
  }

  /** 一篇笔记的公开标记文件（和 .md 同目录、同 slug，只是后缀不同） */
  function shareFileFor(store, name) {
    return store.paths(name).mdPath.replace(/\.md$/i, SHARE_SUFFIX);
  }

  /* ---------------- 我加的接口（pattern 都避开了作者的 `/api/notes/:name`） ---------------- */

  /** GET /api/notes-mine —— 我的笔记，带公开标记 */
  async function listMine(ctx) {
    if (!ctx.user) return failBody(401, 'unauthenticated', '请先登录');
    const { store } = sessionFor(ctx);
    const notes = await store.list();

    const items = [];
    for (const note of notes) {
      const share = await readJsonFile(shareFileFor(store, note.name));
      items.push({
        name: note.name,
        title: note.title || note.name,
        bytes: note.bytes,
        updatedAt: note.updatedAt,
        public: Boolean(share),
        sharedAt: share?.sharedAt ?? null,
      });
    }

    return okBody({
      notes: items,
      count: items.length,
      publicCount: items.filter((item) => item.public).length,
    });
  }

  /** POST /api/notes/:name/publish —— 把自己的某篇设为公开 */
  async function publishNote(ctx) {
    if (!ctx.user) return failBody(401, 'unauthenticated', '请先登录');
    const { store } = sessionFor(ctx);
    const note = await store.read(decodeParams(ctx.params).name);
    if (!note) return failBody(404, 'not_found', '笔记不存在');

    await writeJsonFile(shareFileFor(store, note.name), {
      schema: SHARE_SCHEMA,
      public: true,
      sharedAt: new Date().toISOString(),
      sharedBy: ctx.user.id,
    });
    return okBody({ name: note.name, public: true });
  }

  /** POST /api/notes/:name/unpublish —— 取消公开（= 隐藏，只有自己还能看到） */
  async function unpublishNote(ctx) {
    if (!ctx.user) return failBody(401, 'unauthenticated', '请先登录');
    const { store } = sessionFor(ctx);
    const note = await store.read(decodeParams(ctx.params).name);
    if (!note) return failBody(404, 'not_found', '笔记不存在');

    await unlink(shareFileFor(store, note.name)).catch(() => {});
    return okBody({ name: note.name, public: false });
  }

  /**
   * 扫描出所有「公开且正文还在」的笔记。
   * 目录即作者：`data/notes/<用户id>/<名字>.md` + `<名字>.share.json`。
   */
  async function collectPublicNotes() {
    let dirs = [];
    try {
      dirs = await readdir(dataDir, { withFileTypes: true });
    } catch {
      return []; // 还没有人用过笔记
    }

    const items = [];
    for (const dir of dirs) {
      if (!dir.isDirectory() || dir.name.startsWith('_')) continue;
      const ownerId = dir.name;
      const ownerDir = join(dataDir, ownerId);

      let files = [];
      try {
        files = await readdir(ownerDir);
      } catch {
        continue;
      }

      for (const file of files) {
        if (!file.endsWith(SHARE_SUFFIX)) continue;
        const name = file.slice(0, -SHARE_SUFFIX.length);
        const mdPath = join(ownerDir, `${name}.md`);

        let info;
        try {
          info = await stat(mdPath);
        } catch {
          continue; // 孤儿标记（正文已删）：跳过，不显示幽灵条目
        }

        const share = await readJsonFile(join(ownerDir, file));
        if (!share || share.public !== true) continue;

        const meta = await readJsonFile(join(ownerDir, `${name}.json`));
        const owner = userById(ownerId);
        items.push({
          ownerId,
          ownerName: displayNameOf(owner, ownerId),
          name,
          title: meta?.title || name,
          excerpt: markdownToPlainText((await readTextOrNull(mdPath)) ?? '', EXCERPT_LIMIT),
          bytes: info.size,
          characters: meta?.stats?.characters ?? null,
          readingMinutes: meta?.stats?.readingMinutes ?? null,
          updatedAt: meta?.timestamps?.savedAt ?? info.mtime.toISOString(),
          sharedAt: share.sharedAt ?? null,
        });
      }
    }

    return items.sort((a, b) => String(b.sharedAt ?? '').localeCompare(String(a.sharedAt ?? '')));
  }

  /** GET /api/notes-square —— 公开广场列表 */
  async function listSquare(ctx) {
    if (!ctx.user) return failBody(401, 'unauthenticated', '请先登录后才能看别人的笔记');
    const items = await collectPublicNotes();
    return okBody({ notes: items, count: items.length });
  }

  /** GET /api/notes-square/:ownerId/:name —— 读别人公开的某篇（只读，不写、不删） */
  async function readSquareNote(ctx) {
    if (!ctx.user) return failBody(401, 'unauthenticated', '请先登录后才能看别人的笔记');
    const params = decodeParams(ctx.params);
    const ownerId = safeDirName(params.ownerId);
    const store = createNoteStore({ dir: join(dataDir, ownerId) });

    const share = await readJsonFile(shareFileFor(store, params.name));
    // 私密的、不存在的，一律按「不存在」处理，不泄露它到底存不存在
    if (!share || share.public !== true) return failBody(404, 'not_found', '这篇笔记不存在，或作者没有公开');

    const note = await store.read(params.name);
    if (!note) return failBody(404, 'not_found', '这篇笔记不存在，或作者没有公开');

    const owner = userById(ownerId);
    return okBody({
      owner: { id: ownerId, name: displayNameOf(owner, ownerId) },
      name: note.name,
      title: note.meta?.title || note.name,
      markdown: note.markdown,
      // 服务端渲染：markdown.js 是「先转义全部 HTML，再只注入白名单标签」，不存在 XSS
      html: renderMarkdown(note.markdown),
      meta: note.meta ?? null,
      updatedAt: note.meta?.timestamps?.savedAt ?? null,
    });
  }

  /* -------------------- 路由表 -------------------- */

  const myRoutes = [
    { method: 'GET', pattern: '/api/notes-mine', handler: listMine },
    { method: 'GET', pattern: '/api/notes-square', handler: listSquare },
    { method: 'GET', pattern: '/api/notes-square/:ownerId/:name', handler: readSquareNote },
    { method: 'POST', pattern: '/api/notes/:name/publish', handler: publishNote },
    { method: 'POST', pattern: '/api/notes/:name/unpublish', handler: unpublishNote },
  ];

  /**
   * 作者自己的 8 条路由，逐条包一层「按当前用户换 store」。
   * 未登录时不特殊处理：sessionFor 会给一个占位目录，作者的 requireUser 会返回 401。
   */
  const templateHandlers = createNoteHandlers({
    store: createNoteStore({ dir: join(dataDir, ANON_DIR) }),
    ai,
    currentUser: (c) => c.user ?? null,
  });

  const officialRoutes = createNoteRoutes(templateHandlers).map((entry) => ({
    method: entry.method,
    pattern: entry.pattern,
    handler: async (ctx) => {
      const { handlers } = sessionFor(ctx);
      const fresh = createNoteRoutes(handlers).find(
        (item) => item.method === entry.method && item.pattern === entry.pattern,
      );
      return (fresh ?? entry).handler({ ...ctx, params: decodeParams(ctx.params) });
    },
  }));

  /* -------------------- 编辑器静态资源 -------------------- */

  const rawStatic = createStaticHandler({ root: publicDir, prefix });

  /**
   * 论坛的静态分发对没有扩展名的路径会兜底成 SPA 的 index.html，
   * 所以 `/notes/` 必须在 server.js 里**先**经过这里。
   * 未登录时给一张提示页，免得陌生人看到一个用不了的编辑器。
   */
  async function serveStatic(req, res, pathname) {
    const asset = await rawStatic(pathname);
    if (!asset) return false;

    /*
     * `vendor/` 下全是第三方库（KaTeX / marked / turndown），是公开的库代码，
     * 里面没有任何用户内容 —— 给它套登录门保护不了任何东西。
     * 而动态首页是**公开**页面：未登录访客也要看到公式渲染，
     * 所以这里放行 `/notes/vendor/**`，只对编辑器本体的资源维持登录门。
     */
    const isVendorAsset = pathname === `${prefix}/vendor` || pathname.startsWith(`${prefix}/vendor/`);

    if (!isVendorAsset && typeof resolveUser === 'function') {
      let user = null;
      try {
        ({ user } = resolveUser(req));
      } catch {
        user = null;
      }
      if (!user) {
        const body = Buffer.from(
          '<!doctype html><meta charset="utf-8"><title>请先登录</title>' +
            '<style>body{font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif;background:#12141a;' +
            'color:#e6e8ee;display:grid;place-items:center;height:100vh;margin:0}a{color:#6f8cff}' +
            'div{text-align:center;line-height:1.9}</style>' +
            '<div><h1>📓 笔记</h1><p>笔记是成员功能，请先回到论坛登录。</p>' +
            '<p><a href="/">← 回到论坛</a></p></div>',
          'utf8',
        );
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length });
        return req.method === 'HEAD' ? res.end() : res.end(body);
      }
    }

    res.writeHead(asset.status, asset.headers);
    return req.method === 'HEAD' ? res.end() : res.end(asset.body);
  }

  return { routes: [...myRoutes, ...officialRoutes], serveStatic, rawStatic, dataDir, modulePath: resolvedFrom };
}

/** 默认数据目录：论坛 data/notes（和 data/forum.db 并列，方便整体备份） */
export const defaultNotesDir = (forumRoot) => join(forumRoot, 'data', 'notes');
