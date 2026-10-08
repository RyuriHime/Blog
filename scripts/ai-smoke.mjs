/**
 * AI 能力层（P3）的端到端测试：起一个临时服务器（独立库 + 独立端口），
 * 用真实 HTTP 请求把「授权 → 审计 → 回滚」这条链逐条走一遍。
 *
 * 用法：node scripts/ai-smoke.mjs
 *
 * ⚠️ 这里每一条「不授权就用不了」的断言都是从**服务端**发的请求，
 * 不是检查前端有没有藏按钮 —— 前端藏起来不叫权限（和 feed-smoke 同一条原则）。
 *
 * ⚠️ 前缀是 `/api/ai-edit/*` 而不是文档里的 `/api/ai/*`：
 * forum-ai 的挂载层把 `/api/ai/` 整段短路了（命中它的 14 条就自己答，
 * 没命中就直接 404 「 AI 接口不存在」，永远不交回宿主路由表）。
 * 最后两条用例专门把这个事实钉住，免得以后有人「顺手修回去」。
 *
 * ⚠️ 块的形状是 P2 定的 `{ type, props }`（12 种合法 type，见
 * `src/modules/doc/blocks/types.js`）：**没有** `blockType` / `content` 那套旧形状，
 * 也**没有** `vote` 这个类型（投票块的真名是 `poll`）。第 19 节拿两边的源文件
 * 加 `GET /api/docs/meta/block-types` 把这份清单钉死，漂移就红。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
// 第 21 节末尾那条「跨日界哨兵」要直接往审计表里塞一条**只被一个日窗口圈住**的合成账：
// 光拿审计表自己数一遍抓不到「今日计数改回北京日窗口」的回归 —— 测试环境里所有账都是
// 刚刚造的，UTC 日窗口与北京日窗口都圈得住它们，断言照样绿（见那一段的注释）。
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
// 第 19 节要用**运行时**那份白名单：真正决定 `blockPatchProblem` 放行谁的是它，
// 而不是源文件里的数组字面量（两者之间隔着一个 `.map(...)`）。
// `AI_MAX_SECTION_BLOCKS` 同理（第 22 节末尾的漂移哨兵）：源文本只证明「抄的那一行
// 写着 50」，运行时值才证明「派生 / 重新赋值那一步没被改坏」。
import {
  AI_BLOCK_TYPE_NAMES as AI_RUNTIME_TYPE_NAMES,
  AI_MAX_SECTION_BLOCKS as AI_RUNTIME_MAX_SECTION_BLOCKS,
  AI_MAX_SECTION_INPUT as AI_RUNTIME_MAX_SECTION_INPUT,
  AI_MAX_RANGE_CHARS as AI_RUNTIME_MAX_RANGE_CHARS,
  AI_RANGE_TARGET_TYPES as AI_RUNTIME_RANGE_TARGET_TYPES,
  AI_SCOPES as AI_RUNTIME_SCOPES,
} from '../src/modules/ai/schema.js';
// 第 29 节（doc 548 投票帖事故的回归）要用纠正层的纯函数，以及 **P2 自己的**
// 解析器与围栏工具：「修好了没有」的唯一硬判据是 `parseSourceBlocks` 的输出，
// 不是字符串长得像不像；而两份 `fenceFor` 必须在任何时刻都逐字同算法。
import {
  FENCED_TYPES as AI_FENCED_TYPES,
  FIXABLE_TYPES as AI_FIXABLE_TYPES,
  describeRepairs,
  fenceFor as aiFenceFor,
  normalizePollProps,
  repairBlock,
  repairMarkdown,
} from '../src/modules/ai/programs.js';
import { parseSourceBlocks } from '../src/modules/doc/blocks/markdown.js';
import { fenceFor as p2FenceFor } from '../src/modules/doc/blocks/text.js';
// 第 21 节（金额）：计价器是纯函数，直接 import 来钉 —— 官方价目表、高峰/空闲换算、
// 上游 usage 的畸形值都只能在这一层精确断言（HTTP 那侧只看得到「汇总后的一个数」）。
import {
  AI_PRICE_TABLE,
  AI_PRICE_ALIASES,
  AI_OFF_PEAK_FACTOR,
  AI_TOKENS_PER_PRICE_UNIT,
  isPeakHour,
  shapeTokenUsage,
  costOfUsage,
  summarizeCost,
  priceFor,
  priceNote,
} from '../src/modules/ai/pricing.js';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const SERVER = join(ROOT, 'src', 'server.js');
const DB_FILE = join(ROOT, 'data', 'ai-smoke.db');
const AVATAR_DIR = join(ROOT, 'data', 'ai-smoke-avatars');
const NOTES_DIR = join(ROOT, 'data', 'ai-smoke-notes');
const LOG_FILE = join(ROOT, 'data', 'ai-smoke-server.log');
const PORT = Number(process.env.AI_SMOKE_PORT || 3423);
const BASE = `http://127.0.0.1:${PORT}`;

// 第 18 节用：一台「配了 key」的应用服务器 + 一个本地假模型。
const MODEL_PORT = Number(process.env.AI_SMOKE_MODEL_PORT || 3433);
const MODEL_BASE = `http://127.0.0.1:${MODEL_PORT}/v1`;
const KEYED_PORT = Number(process.env.AI_SMOKE_KEYED_PORT || 3434);
const KEYED_BASE = `http://127.0.0.1:${KEYED_PORT}`;
const KEYED_DB_FILE = join(ROOT, 'data', 'ai-smoke-keyed.db');
const KEYED_LOG_FILE = join(ROOT, 'data', 'ai-smoke-keyed-server.log');

// 第 20 节用：一台配了全站每日预算的应用服务器（独立库 + 独立端口，别和上面两台撞）。
const BUDGET_PORT = Number(process.env.AI_SMOKE_BUDGET_PORT || 3541);
const BUDGET_BASE = `http://127.0.0.1:${BUDGET_PORT}`;
const BUDGET_DB_FILE = join(ROOT, 'data', 'ai-smoke-budget.db');
const BUDGET_LOG_FILE = join(ROOT, 'data', 'ai-smoke-budget-server.log');
const BUDGET_LIMIT = 2;

/**
 * **真的接上了线的**能力清单（`src/modules/ai/schema.js` 的目录必须与它一一对应）。
 *
 * 为什么单独抄一份：目录里每多列一项，就必须在 `src/modules/ai/routes.js` 里有对应的
 * `requireCapability` / `guardCapability` 调用点。2026-10 收尾时发现目录里原来那六项里
 * 有五项（read_post / read_site / network / site_tools / publish）**从来没有调用点** ——
 * 授权、配额、收回全都点得动，却什么也拦不住。所以这里当哨兵：谁要是手滑往目录里加一项
 * 而又没接线，第 3 节就红。
 */
const WIRED_CAPABILITIES = ['edit_content'];

/** 整个测试反复用的两块：P2 的块形状就是 `{ type, props }`。 */
const BLOCK_BEFORE = { type: 'paragraph', props: { text: '旧文案' } };
const BLOCK_AFTER = { type: 'poll', props: { question: '选哪个？', options: ['A', 'B'] } };

/* ---------- 第 18/19 节共用：直接从源文件里抓块类型清单 ---------- */
//
// 第 19 节是静态哨兵（AI 抄的那份清单 vs P2 的真相），第 18 节要用同一份清单
// 核对提示词教给模型的形状，所以在这里一次性读出来。
const P2_TYPES_SRC = readFileSync(join(ROOT, 'src', 'modules', 'doc', 'blocks', 'types.js'), 'utf8');
const AI_SCHEMA_SRC = readFileSync(join(ROOT, 'src', 'modules', 'ai', 'schema.js'), 'utf8');
// 第 22 节末尾的漂移哨兵：`AI_MAX_SECTION_BLOCKS` 抄的是 P2 的 `MAX_OPS`，
// 两边必须是同一个数 —— 一小节的落盘就是一批 `POST /api/docs/:id/ops`。
const P2_OPS_SRC = readFileSync(join(ROOT, 'src', 'modules', 'doc', 'blocks', 'ops.js'), 'utf8');
// 第 19 节的第二组漂移哨兵：AI 的「模板菜单」抄的是 P2 的 `TEMPLATES`
//（修复 3b：整篇改写可以直接回 `{"template":"<key>"}`，key 必须是站里真有的那 8 个）。
const AI_SYNTAX_SRC = readFileSync(join(ROOT, 'src', 'modules', 'ai', 'syntax.js'), 'utf8');
const P2_TEMPLATES_SRC = readFileSync(join(ROOT, 'src', 'modules', 'doc', 'templates.js'), 'utf8');

/** `export const BUILTIN_TYPES = [ … ];` 里每个块的 `name`。 */
function grabP2BlockTypeNames(src) {
  const array = src.match(/export const BUILTIN_TYPES = \[([\s\S]*?)\n\];/);
  return [...String(array?.[1] ?? '').matchAll(/\bname: '([a-z][a-z0-9_]*)'/g)].map((item) => item[1]);
}

/** `export const AI_BLOCK_TYPES = Object.freeze([ … ]);` 里每个块的 `name`。 */
function grabAiBlockTypeNames(src) {
  const array = src.match(/export const AI_BLOCK_TYPES = Object\.freeze\(\[([\s\S]*?)\n\]\);/);
  return [...String(array?.[1] ?? '').matchAll(/\bname: '([a-z][a-z0-9_]*)'/g)].map((item) => item[1]);
}

/** `export const TEMPLATES = [ … ];` 里每个模板的 `key`。 */
function grabTemplateKeys(src) {
  const array = src.match(/export const TEMPLATES = \[([\s\S]*?)\n\];/);
  return [...String(array?.[1] ?? '').matchAll(/\bkey: '([a-z][a-z0-9_]*)'/g)].map((item) => item[1]);
}

/** `export const AI_TEMPLATE_KEYS = Object.freeze([ … ]);` 里每个模板的 `key`。 */
function grabAiTemplateKeys(src) {
  const array = src.match(/export const AI_TEMPLATE_KEYS = Object\.freeze\(\[([\s\S]*?)\n\]\);/);
  return [...String(array?.[1] ?? '').matchAll(/\bkey: '([a-z][a-z0-9_]*)'/g)].map((item) => item[1]);
}

const P2_BLOCK_TYPE_NAMES = grabP2BlockTypeNames(P2_TYPES_SRC);
const AI_BLOCK_TYPE_NAMES = grabAiBlockTypeNames(AI_SCHEMA_SRC);
const P2_TEMPLATE_KEYS = grabTemplateKeys(P2_TEMPLATES_SRC);
const AI_TEMPLATE_KEYS_STATIC = grabAiTemplateKeys(AI_SYNTAX_SRC);

/** 键序无关的深比较：审计里存的是 JSON，键序不该影响判定，多余键必须影响。 */
function sameJson(left, right) {
  const norm = (value) => {
    if (Array.isArray(value)) return value.map(norm);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, norm(value[key])]));
    }
    return value === undefined ? null : value;
  };
  return JSON.stringify(norm(left)) === JSON.stringify(norm(right));
}

let passed = 0;
const failures = [];

/** 第 18 节起的子进程（假模型 / 配了 key 的服务器 / 配了预算的服务器），由 finish 统一收掉。 */
const extraChildren = [];
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function createClient(base = BASE) {
  let cookie = '';
  return {
    async call(path, { method = 'GET', body } = {}) {
      const response = await fetch(base + path, {
        method,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'manual',
      });
      for (const value of response.headers.getSetCookie()) {
        const pair = value.split(';')[0];
        if (pair.startsWith('forum_sid=')) cookie = pair;
      }
      const json = await response.json().catch(() => null);
      return { status: response.status, body: json, data: json?.data, error: json?.error };
    },
  };
}

/** 读回某个用户今天已经用掉的 edit_content 次数（-1 表示没读到，用来把断言钉死）。 */
async function editContentUsed(client) {
  const caps = await client.call('/api/ai-edit/capabilities');
  const item = (caps.data?.capabilities ?? []).find((row) => row.key === 'edit_content');
  return item?.usedToday ?? -1;
}

async function waitForServer(timeoutMs = 20000, base = BASE) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/site`);
      if (response.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(180);
  }
  return false;
}

mkdirSync(join(ROOT, 'data'), { recursive: true });
for (const suffix of ['', '-wal', '-shm']) rmSync(DB_FILE + suffix, { force: true });

const logFd = openSync(LOG_FILE, 'w');
const child = spawn(process.execPath, [SERVER], {
  env: {
    ...process.env,
    PORT: String(PORT),
    DB_FILE,
    AVATAR_DIR,
    NOTES_DIR,
    QUIET: '1',
    // 故意不配 key：503 ai_not_configured 本身就是一条验收项。
    AI_API_KEY: '',
  },
  stdio: ['ignore', logFd, logFd],
});

const finish = async (code) => {
  try {
    child.kill();
  } catch {
    /* 忽略 */
  }
  // 第 18 / 20 节起的假模型和另外两台服务器也要收干净，否则下次跑会撞端口。
  for (const extra of extraChildren) {
    try {
      extra.kill();
    } catch {
      /* 忽略 */
    }
  }
  await sleep(400);
  for (const file of [DB_FILE, KEYED_DB_FILE, BUDGET_DB_FILE]) {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        rmSync(file + suffix, { force: true });
      } catch {
        /* 忽略 */
      }
    }
  }
  console.log('');
  console.log('──────────────────────────────────────────────');
  console.log(`通过 ${passed} 项，失败 ${failures.length} 项`);
  if (failures.length) {
    for (const item of failures) console.log(`  - ${item}`);
  }
  process.exit(code);
};

const admin = createClient();
const alice = createClient();

try {
  if (!(await waitForServer())) {
    console.log('❌ 服务器没起来，看看 data/ai-smoke-server.log');
    await finish(1);
  }

  /* ---------- 1. 未登录 → 401，而不是 404 ---------- */
  const anonCaps = await createClient().call('/api/ai-edit/capabilities');
  check('未登录访问能力目录返回 401', anonCaps.status === 401, `实际 ${anonCaps.status}`);
  check('未登录的错误代号是 unauthenticated', anonCaps.error?.code === 'unauthenticated', String(anonCaps.error?.code));
  const anonGrants = await createClient().call('/api/ai-edit/grants');
  check('未登录访问授权列表返回 401', anonGrants.status === 401, `实际 ${anonGrants.status}`);
  const anonOps = await createClient().call('/api/ai-edit/ops', { method: 'POST', body: { after: {} } });
  check('未登录提交 AI 操作返回 401', anonOps.status === 401, `实际 ${anonOps.status}`);

  /* ---------- 2. 登录 ---------- */
  const login = await admin.call('/api/auth/login', {
    method: 'POST',
    body: { username: 'admin', password: 'admin123' },
  });
  check('管理员登录成功', login.status === 200, JSON.stringify(login.error ?? null));

  const aliceLogin = await alice.call('/api/auth/login', {
    method: 'POST',
    body: { username: 'alice', password: 'demo1234' },
  });
  check('普通用户 alice 登录成功', aliceLogin.status === 200, JSON.stringify(aliceLogin.error ?? null));

  /* ---------- 3. 目录只列接上了线的能力，且默认全部关闭 ---------- */
  const caps = await admin.call('/api/ai-edit/capabilities');
  check('能力目录返回 200', caps.status === 200, `实际 ${caps.status}`);
  check(
    '目录里只有接上了线的能力，一项不多一项不少',
    caps.data?.capabilities?.length === WIRED_CAPABILITIES.length &&
      WIRED_CAPABILITIES.every((key) => caps.data.capabilities.some((item) => item.key === key)),
    JSON.stringify(caps.data?.capabilities?.map((item) => item.key)),
  );
  check(
    '能力默认全部关闭',
    caps.data.capabilities.every((item) => item.granted === false),
    JSON.stringify(caps.data.capabilities.filter((item) => item.granted).map((item) => item.key)),
  );

  /* ---------- 4. 没授权就用不了（服务端拦） ---------- */
  //
  // 这一节的 body 全部给**合法块形状**：403 必须来自能力门，而不是形状校验。
  const denied = await admin.call('/api/ai-edit/ops', {
    method: 'POST',
    body: { documentId: 'doc-1', blockId: 'block-1', before: BLOCK_BEFORE, after: BLOCK_AFTER, confirm: true },
  });
  check('未授权时提交操作被拒 403', denied.status === 403, `实际 ${denied.status}`);
  check('拒绝代号是 forbidden', denied.error?.code === 'forbidden', String(denied.error?.code));

  const deniedDraft = await admin.call('/api/ai-edit/draft', {
    method: 'POST',
    body: { blockId: 'block-1', block: { type: 'paragraph', props: { text: '原文' } }, instruction: '把这块改成投票' },
  });
  check('未授权时 AI 草拟也被拒 403（能力门先于配置门）', deniedDraft.status === 403, `实际 ${deniedDraft.status}`);

  /* ---------- 5. 授权的入参校验 ---------- */
  const badCap = await admin.call('/api/ai-edit/grants', {
    method: 'POST',
    body: { capability: 'launch_missiles' },
  });
  check('授权未知能力返回 400', badCap.status === 400, `实际 ${badCap.status}`);

  // 2026-10 收尾删掉的那五项空开关，现在连授权都授权不了（它们已经不在目录里）。
  const removedCap = await admin.call('/api/ai-edit/grants', {
    method: 'POST',
    body: { capability: 'read_site', confirm: true },
  });
  check('已删除的空开关 read_site 授权不了（400）', removedCap.status === 400, `实际 ${removedCap.status}`);
  const removedRevoke = await admin.call('/api/ai-edit/grants/read_site', { method: 'DELETE' });
  check('已删除的空开关 read_site 也收不回（400）', removedRevoke.status === 400, `实际 ${removedRevoke.status}`);

  const highRiskNoConfirm = await admin.call('/api/ai-edit/grants', {
    method: 'POST',
    body: { capability: 'edit_content' },
  });
  check('高风险能力不带 confirm 返回 400', highRiskNoConfirm.status === 400, `实际 ${highRiskNoConfirm.status}`);

  const badQuota = await admin.call('/api/ai-edit/grants', {
    method: 'POST',
    body: { capability: 'edit_content', confirm: true, dailyQuota: 1.5 },
  });
  check('非整数 dailyQuota 返回 400', badQuota.status === 400, `实际 ${badQuota.status}`);

  /* ---------- 6. 授权 ---------- */
  const grantEdit = await admin.call('/api/ai-edit/grants', {
    method: 'POST',
    body: { capability: 'edit_content', confirm: true },
  });
  check('带 confirm 授权 edit_content 成功', grantEdit.status === 200 && grantEdit.data?.granted === true, `实际 ${grantEdit.status}`);

  const capsAfter = await admin.call('/api/ai-edit/capabilities');
  const editCap = capsAfter.data.capabilities.find((item) => item.key === 'edit_content');
  check('授权状态在能力目录里可见（FR-CAP-09）', editCap?.granted === true, JSON.stringify(editCap));
  check('目录里只有这一项能力，没有别的开关可授权', capsAfter.data.capabilities.length === 1);

  /* ---------- 7. 预览与落盘（FR-CAP-06：没确认不落盘） ---------- */
  const previewBody = {
    documentId: 'doc-7',
    blockId: 'block-7',
    before: BLOCK_BEFORE,
    after: BLOCK_AFTER,
  };
  const preview = await admin.call('/api/ai-edit/ops', { method: 'POST', body: previewBody });
  check('不带 confirm 时返回的是预览', preview.status === 200 && preview.data?.applied === false, JSON.stringify(preview.data));
  check('预览回带了改动前后', preview.data?.preview?.before?.props?.text === '旧文案', JSON.stringify(preview.data?.preview));
  check('预览没有落盘（状态是 preview）', typeof preview.data?.opId === 'number', String(preview.data?.opId));

  const applied = await admin.call('/api/ai-edit/ops', { method: 'POST', body: { ...previewBody, confirm: true } });
  check('带 confirm 时落盘', applied.status === 200 && applied.data?.applied === true, JSON.stringify(applied.data));
  const opId = applied.data?.opId;
  check('落盘返回了操作 id', Number.isInteger(opId), String(opId));

  const badAfter = await admin.call('/api/ai-edit/ops', {
    method: 'POST',
    body: { documentId: 'doc-7', blockId: 'block-7', after: ['整篇重写'], confirm: true },
  });
  check('after 不是对象时返回 400（只接受块级改动）', badAfter.status === 400, `实际 ${badAfter.status}`);

  /* ---------- 8. 审计日志 ---------- */
  const ops = await admin.call('/api/ai-edit/ops?limit=100');
  check('操作日志返回 200', ops.status === 200, `实际 ${ops.status}`);
  const logged = (ops.data?.ops ?? []).find((row) => row.id === opId);
  check('落盘的操作能在日志里查到', Boolean(logged), JSON.stringify(ops.data?.ops?.map((row) => row.id)));
  check('日志里记着改动前的旧值', logged?.before?.props?.text === '旧文案', JSON.stringify(logged?.before));
  check('日志里记着改动后的新值', logged?.after?.type === 'poll', JSON.stringify(logged?.after));
  check('日志里记着目标块', logged?.targetId === 'doc-7:block-7', String(logged?.targetId));
  check('被授权前的那条预览也在日志里', (ops.data.ops ?? []).some((row) => row.status === 'preview'));

  /* ---------- 9. 回滚 ---------- */
  const missing = await admin.call('/api/ai-edit/ops/999999/rollback', { method: 'POST' });
  check('回滚不存在的操作返回 404', missing.status === 404, `实际 ${missing.status}`);

  const rollback = await admin.call(`/api/ai-edit/ops/${opId}/rollback`, { method: 'POST' });
  check('回滚成功', rollback.status === 200 && rollback.data?.rolledBack === true, JSON.stringify(rollback.data));
  check('回滚交回了改动前的旧值', rollback.data?.restore?.props?.text === '旧文案', JSON.stringify(rollback.data?.restore));
  check('回滚交回了目标块', rollback.data?.targetId === 'doc-7:block-7', String(rollback.data?.targetId));

  const again = await admin.call(`/api/ai-edit/ops/${opId}/rollback`, { method: 'POST' });
  check('重复回滚返回 409', again.status === 409, `实际 ${again.status}`);

  const opsAfter = await admin.call('/api/ai-edit/ops?limit=100');
  const rolled = (opsAfter.data?.ops ?? []).find((row) => row.id === opId);
  check('回滚后状态变成 rolled_back', rolled?.status === 'rolled_back', String(rolled?.status));
  check('回滚后不再可回滚', rolled?.canRollback === false, String(rolled?.canRollback));

  /* ---------- 10. 每日配额 ---------- */
  //
  // `/ops` 用哪项能力现在由服务端固定成 edit_content（不接受客户端传值，见第 17 节），
  // 所以配额只能设在 edit_content 上；而 admin 今天已经有过若干次 edit_content 调用，
  // 用量要算进历史记录，于是按「当前用量 + 1」设配额，再验证第 2 次就超限。
  const usedEdit = await editContentUsed(admin);

  const grantQuota = await admin.call('/api/ai-edit/grants', {
    method: 'POST',
    body: { capability: 'edit_content', confirm: true, dailyQuota: usedEdit + 1 },
  });
  check('可以给能力设每日配额（FR-CAP-04）', grantQuota.status === 200, JSON.stringify(grantQuota.error ?? null));

  const quotaBody = {
    documentId: 'doc-quota',
    blockId: 'quota-1',
    before: BLOCK_BEFORE,
    after: BLOCK_AFTER,
    confirm: true,
  };
  const firstUse = await admin.call('/api/ai-edit/ops', { method: 'POST', body: quotaBody });
  check('配额内第一次调用成功', firstUse.status === 200, `实际 ${firstUse.status}`);

  const secondUse = await admin.call('/api/ai-edit/ops', { method: 'POST', body: quotaBody });
  check('超配额返回 429', secondUse.status === 429, `实际 ${secondUse.status}`);
  check('超配额的错误代号是 ai_rate_limited', secondUse.error?.code === 'ai_rate_limited', String(secondUse.error?.code));

  // 恢复成不限次数，否则后面每一节都会被 429 挡住。
  await admin.call('/api/ai-edit/grants', {
    method: 'POST',
    body: { capability: 'edit_content', confirm: true, dailyQuota: 0 },
  });

  /* ---------- 11. 未配置模型 → 503 ai_not_configured ---------- */
  const draft = await admin.call('/api/ai-edit/draft', {
    method: 'POST',
    body: { blockId: 'block-7', block: { type: 'paragraph', props: { text: '原文' } }, instruction: '把这块改成投票' },
  });
  check('没配 AI_API_KEY 时返回 503（不是 500）', draft.status === 503, `实际 ${draft.status}`);
  check('错误代号是 ai_not_configured', draft.error?.code === 'ai_not_configured', String(draft.error?.code));

  /* ---------- 12. 收回授权（立即失效，FR-CAP-03） ---------- */
  const revoke = await admin.call('/api/ai-edit/grants/edit_content', { method: 'DELETE' });
  check('收回授权成功', revoke.status === 200 && revoke.data?.revoked === true, JSON.stringify(revoke.error ?? null));

  const afterRevoke = await admin.call('/api/ai-edit/ops', {
    method: 'POST',
    body: { documentId: 'doc-1', blockId: 'block-7', after: BLOCK_AFTER, confirm: true },
  });
  check('收回后立刻用不了（403）', afterRevoke.status === 403, `实际 ${afterRevoke.status}`);

  const revokeAgain = await admin.call('/api/ai-edit/grants/edit_content', { method: 'DELETE' });
  check('重复收回返回 404', revokeAgain.status === 404, `实际 ${revokeAgain.status}`);

  /* ---------- 13. 用户之间互相隔离 ---------- */
  const aliceCaps = await alice.call('/api/ai-edit/capabilities');
  check(
    'alice 的能力默认也全是关的（授权不跨用户）',
    aliceCaps.data.capabilities.every((item) => item.granted === false),
    JSON.stringify(aliceCaps.data.capabilities.filter((item) => item.granted).map((item) => item.key)),
  );

  const aliceDenied = await alice.call('/api/ai-edit/ops', {
    method: 'POST',
    body: { documentId: 'doc-1', blockId: 'block-7', after: BLOCK_AFTER, confirm: true },
  });
  check('alice 没授权就改不了东西', aliceDenied.status === 403, `实际 ${aliceDenied.status}`);

  const aliceOps = await alice.call('/api/ai-edit/ops');
  check('alice 看不到 admin 的操作日志', (aliceOps.data?.ops ?? []).length === 0, JSON.stringify(aliceOps.data?.ops));
  const aliceRollback = await alice.call(`/api/ai-edit/ops/${opId}/rollback`, { method: 'POST' });
  check('alice 回滚不了 admin 的操作', aliceRollback.status === 404, `实际 ${aliceRollback.status}`);

  /* ---------- 14. 钉住前缀这件事 ---------- */
  const renamedWhy = await createClient().call('/api/ai-edit/capabilities');
  check(
    '新前缀确实走的是宿主路由表（不是 forum-ai 的兜底 404）',
    renamedWhy.error?.code === 'unauthenticated',
    `实际 code=${renamedWhy.error?.code} message=${renamedWhy.error?.message}`,
  );

  const oldPrefix = await admin.call('/api/ai/grants');
  check(
    '旧前缀 /api/ai/ 仍然被 forum-ai 短路（这条是记录事实，不是要求它变）',
    oldPrefix.status === 404 && String(oldPrefix.error?.message ?? '').includes('AI 接口不存在'),
    `实际 ${oldPrefix.status} ${JSON.stringify(oldPrefix.error ?? null)}`,
  );

  const untouched = await admin.call('/api/ai/status');
  check('forum-ai 自己的 /api/ai/status 没被动过', untouched.status === 200, `实际 ${untouched.status}`);

  /* ---------- 15. 前端编辑台真的能被服务器发出来 ---------- */
  //
  // check-frontend.mjs 是从磁盘 import 视图的，绕过了 HTTP；这几条补的是
  // 「服务器发不发得出来」+「三处注册有没有真的接上」。少了任何一处，
  // 页面在浏览器里就是 #/ai-edit 打不开或者裸样式。
  const pageJs = await fetch(`${BASE}/views/ai-edit.js`);
  const pageJsText = await pageJs.text();
  check(
    '前端视图 /views/ai-edit.js 发得出来且导出了 viewAiEdit',
    pageJs.status === 200 && pageJsText.includes('viewAiEdit'),
    `实际 ${pageJs.status}`,
  );

  const pageCss = await fetch(`${BASE}/css/94-ai-edit.css`);
  const pageCssText = await pageCss.text();
  check(
    '样式分片 /css/94-ai-edit.css 发得出来',
    pageCss.status === 200 && pageCssText.includes('.ae-cap'),
    `实际 ${pageCss.status}`,
  );

  const styleEntry = await fetch(`${BASE}/style.css`);
  const styleEntryText = await styleEntry.text();
  check(
    'style.css 里接上了 94-ai-edit.css',
    styleEntry.status === 200 && styleEntryText.includes('94-ai-edit.css'),
    `实际 ${styleEntry.status}`,
  );

  const appEntry = await fetch(`${BASE}/app.js`);
  const appEntryText = await appEntry.text();
  check(
    'app.js 里注册了 ai-edit 视图',
    appEntry.status === 200 && appEntryText.includes('views/ai-edit.js'),
    `实际 ${appEntry.status}`,
  );

  const routerEntry = await fetch(`${BASE}/core/router.js`);
  const routerEntryText = await routerEntry.text();
  check(
    'router.js 里有 #/ai-edit 路由',
    routerEntry.status === 200 && routerEntryText.includes("'ai-edit'"),
    `实际 ${routerEntry.status}`,
  );

  // 静态哨兵：aeRender() 是整体重建 DOM，只能拿草稿回填。草拟失败时 draft 是 null，
  // 没有这两个备份字段，用户刚敲的块 JSON 和改写要求就会被抹成默认值 —— 这条钉住备份机制本身。
  check(
    '视图里留着输入备份（草拟失败时不抹掉用户敲的内容）',
    pageJsText.includes('instructionInput') && pageJsText.includes('blockInput'),
    'aeState 的 instructionInput / blockInput 不见了',
  );

  /* ---------- 16. 和 forum-ai 必须是同一套模型默认值 ---------- */
  //
  // 同一个项目里 `AI_BASE_URL` / `AI_MODEL` 只能有一个默认值。两边不一致时，
  // 只配 `AI_API_KEY`（forum-ai/README.md 里的最小配法）就会把 key 发到另一个
  // 服务商：既肯定调不通，也等于把密钥递给了第三方。
  // 这里直接读两个源文件静态比对，谁只改一边都会红。
  const forumAiSrc = readFileSync(join(ROOT, 'forum-ai', 'src', 'ai.mjs'), 'utf8');
  const aiRoutesSrc = readFileSync(join(ROOT, 'src', 'modules', 'ai', 'routes.js'), 'utf8');
  const grabConst = (src, name) => (src.match(new RegExp(`\\b${name}\\s*=\\s*'([^']+)'`)) || [])[1];
  const grabFallback = (src, name) => (src.match(new RegExp(`${name}\\s*\\|\\|\\s*'([^']+)'`)) || [])[1];

  const forumBaseUrl = grabConst(forumAiSrc, 'DEFAULT_BASE_URL');
  const forumModel = grabConst(forumAiSrc, 'DEFAULT_MODEL');
  const myBaseUrl = grabFallback(aiRoutesSrc, 'AI_BASE_URL');
  const myModel = grabFallback(aiRoutesSrc, 'AI_MODEL');

  check('读到了 forum-ai 的 DEFAULT_BASE_URL', Boolean(forumBaseUrl), String(forumBaseUrl));
  check(
    '我的 AI_BASE_URL 默认值和 forum-ai 一致（不一致会把 key 发错服务商）',
    myBaseUrl === forumBaseUrl,
    `我=${myBaseUrl} forum-ai=${forumBaseUrl}`,
  );
  check(
    '我的 AI_MODEL 默认值和 forum-ai 一致',
    myModel === forumModel,
    `我=${myModel} forum-ai=${forumModel}`,
  );

  /* ---------- 17. 对抗性调试的回归用例 ---------- */
  //
  // 这一节钉的是用探针实测出来的越权与审计缺陷。每一条都对应一个「改之前确实是错的」
  // 的具体行为，改回去就会红。改动本身都记在 src/modules/ai/routes.js 的注释里。

  // —— 用哪项能力由服务端决定，不接受客户端传值
  //    （原来是客户端说自己是啥就是啥：没有 edit_content 的人，把 capability 填成
  //     edit_content 就能落盘一次内容改写。现在目录里只剩这一项，所以拆成两枪打：
  //     ① 没授权的人自己填 edit_content —— 必须还是 403（自报家门不算授权）；
  //     ② alice 拿到 edit_content 之后，请求里故意填一个早在目录里删掉的 key ——
  //        服务端照样按 edit_content 记日志、照样成功（证明它根本不看请求体里的 capability）。）
  const selfNamed = await alice.call('/api/ai-edit/ops', {
    method: 'POST',
    body: {
      capability: 'edit_content',
      documentId: 'doc-r1',
      blockId: 'regress-1',
      before: BLOCK_BEFORE,
      after: BLOCK_AFTER,
      confirm: true,
    },
  });
  check('没授权的人自己填 capability=edit_content 也改不动（403）', selfNamed.status === 403, `实际 ${selfNamed.status}`);

  await alice.call('/api/ai-edit/grants', {
    method: 'POST',
    body: { capability: 'edit_content', confirm: true },
  });
  const forgedCap = await alice.call('/api/ai-edit/ops', {
    method: 'POST',
    body: {
      capability: 'read_post',
      documentId: 'doc-r2',
      blockId: 'regress-2',
      before: BLOCK_BEFORE,
      after: BLOCK_AFTER,
      confirm: true,
    },
  });
  check('请求里伪造已经删掉的 capability=read_post 也不影响成功', forgedCap.status === 200, `实际 ${forgedCap.status}`);
  const forgedCapRow = (await alice.call('/api/ai-edit/ops?limit=100')).data?.ops?.find(
    (row) => row.id === forgedCap.data?.opId,
  );
  check(
    '审计里记的是 edit_content（服务端说了算，不看请求体）',
    forgedCapRow?.capability === 'edit_content',
    String(forgedCapRow?.capability),
  );

  await admin.call('/api/ai-edit/grants', {
    method: 'POST',
    body: { capability: 'edit_content', confirm: true, dailyQuota: 0 },
  });

  // —— 审计里的 action 由服务端按「有没有 confirm」判定，不接受客户端传值
  //    （原来带 action:'grant' 提交一次内容改写，日志就记成 grant）
  const forgedAction = await admin.call('/api/ai-edit/ops', {
    method: 'POST',
    body: {
      action: 'grant',
      documentId: 'doc-r2',
      blockId: 'regress-2',
      before: BLOCK_BEFORE,
      after: BLOCK_AFTER,
      confirm: true,
    },
  });
  check('伪造的 action 字段不影响请求成功', forgedAction.status === 200, `实际 ${forgedAction.status}`);
  const forgedRow = (await admin.call('/api/ai-edit/ops?limit=100')).data?.ops?.find((row) => row.id === forgedAction.data?.opId);
  check('审计里的 action 被写成 apply（不是客户端给的 grant）', forgedRow?.action === 'apply', String(forgedRow?.action));

  // —— 回滚的判据要和列表里的 canRollback 一致（原来列表说不可回滚、接口却回滚成功）
  const previewOnly = await admin.call('/api/ai-edit/ops', {
    method: 'POST',
    body: { documentId: 'doc-r3', blockId: 'regress-3', before: BLOCK_BEFORE, after: BLOCK_AFTER },
  });
  check('不带 confirm 只产生预览', previewOnly.status === 200 && previewOnly.data?.applied === false, `实际 ${previewOnly.status}`);
  const previewRow = (await admin.call('/api/ai-edit/ops?limit=100')).data?.ops?.find((row) => row.id === previewOnly.data?.opId);
  check('预览在列表里标记为不可回滚', previewRow?.canRollback === false, String(previewRow?.canRollback));
  const rollbackPreview = await admin.call(`/api/ai-edit/ops/${previewOnly.data?.opId}/rollback`, { method: 'POST' });
  check('列表说不可回滚的操作，接口同样回滚不了（409）', rollbackPreview.status === 409, `实际 ${rollbackPreview.status}`);

  // —— 回滚交出去的 restore 是要写回 document_blocks 的旧值，它本身就是一条写路径，
  //    收回授权后必须做不了（原来回滚端点完全没有能力门）
  const appliedRegress = await admin.call('/api/ai-edit/ops', {
    method: 'POST',
    body: { documentId: 'doc-r4', blockId: 'regress-4', before: BLOCK_BEFORE, after: BLOCK_AFTER, confirm: true },
  });
  const appliedId = appliedRegress.data?.opId;
  await admin.call('/api/ai-edit/grants/edit_content', { method: 'DELETE' });
  const rollbackRevoked = await admin.call(`/api/ai-edit/ops/${appliedId}/rollback`, { method: 'POST' });
  check('收回 edit_content 之后连回滚都做不了（403）', rollbackRevoked.status === 403, `实际 ${rollbackRevoked.status}`);

  // —— 收回授权那条审计必须记「收回前」的状态
  //    （原来是在 UPDATE 之后才读 before，存下来的是 revoked_at 已经非空的收回后状态；
  //     注意 readGrant 返回的是**原始行**，字段是 snake_case 的 revoked_at）
  const revokeRow = (await admin.call('/api/ai-edit/ops?limit=100')).data?.ops?.find(
    (row) => row.action === 'revoke' && row.capability === 'edit_content',
  );
  check(
    '收回授权的审计里确实存了「收回前」那一行',
    revokeRow?.before != null,
    JSON.stringify(revokeRow?.before ?? null),
  );
  check(
    '收回前那一行的 revoked_at 是空的（不是收回后的状态）',
    revokeRow?.before != null && revokeRow.before.revoked_at == null,
    JSON.stringify(revokeRow?.before ?? null),
  );

  // —— 预览不该吃配额（原来两次预览就能把当日额度耗光，真正落盘那次被 429 挡住）
  await admin.call('/api/ai-edit/grants', {
    method: 'POST',
    body: { capability: 'edit_content', confirm: true, dailyQuota: 0 },
  });
  const usedBeforePreview = await editContentUsed(admin);
  await admin.call('/api/ai-edit/ops', {
    method: 'POST',
    body: { documentId: 'doc-r5', blockId: 'regress-5', before: BLOCK_BEFORE, after: BLOCK_AFTER },
  });
  const usedAfterPreview = await editContentUsed(admin);
  check(
    '预览不计入每日用量',
    usedAfterPreview === usedBeforePreview,
    `${usedBeforePreview} → ${usedAfterPreview}`,
  );

  // —— 没发出去的调用不扣额度，但必须留痕
  //    （原来 503 也写一条 draft 日志而 draft 计配额；同时上游 401/403/429/500 与坏 JSON
  //     那几条路径干脆什么都不记 —— 同一次调用，网络失败有痕、被服务商拒绝没痕）
  const usedBeforeBlocked = await editContentUsed(admin);
  for (let i = 0; i < 3; i += 1) {
    await admin.call('/api/ai-edit/draft', {
      method: 'POST',
      body: { blockId: 'regress', block: { type: 'paragraph', props: { text: '原文' } }, instruction: '改一下' },
    });
  }
  const usedAfterBlocked = await editContentUsed(admin);
  check(
    '没配模型时的 503 不扣每日用量',
    usedAfterBlocked === usedBeforeBlocked,
    `${usedBeforeBlocked} → ${usedAfterBlocked}`,
  );
  const blockedRow = (await admin.call('/api/ai-edit/ops?limit=100')).data?.ops?.find(
    (row) => row.action === 'draft' && row.reason === 'ai_not_configured',
  );
  check('没配模型时仍然留下一条 blocked 审计', blockedRow?.status === 'blocked', JSON.stringify(blockedRow ?? null));

  // —— 提示词体积有上限（原来 instruction 限了 2000 字，block 一个字都没限，
  //    12 万字的块能撑出 352KB 的请求体）
  const tooBig = await admin.call('/api/ai-edit/draft', {
    method: 'POST',
    body: { block: { type: 'paragraph', props: { text: 'x'.repeat(40000) } }, instruction: '改一下' },
  });
  check('过大的 block 直接 400，不会发给模型', tooBig.status === 400, `实际 ${tooBig.status}`);

  // —— 目标不再由客户端给：`targetType` 服务端写死、`targetId` 服务端拼成
  //    `<documentId>:<blockId>`。以前 targetType 能填 `not a real type!`、
  //    targetId 能塞 5000 个字符，日志被任意字符串灌满。
  const forgedTarget = await admin.call('/api/ai-edit/ops', {
    method: 'POST',
    body: {
      targetType: 'not a real type!',
      targetId: 'z'.repeat(500),
      documentId: 'doc-t',
      blockId: 'blk-t',
      before: BLOCK_BEFORE,
      after: BLOCK_AFTER,
      confirm: true,
    },
  });
  check('客户端伪造的 targetType / targetId 不影响落盘（200）', forgedTarget.status === 200, `实际 ${forgedTarget.status}`);
  check(
    '落盘返回里的 targetType 恒为 document_block',
    forgedTarget.data?.targetType === 'document_block',
    String(forgedTarget.data?.targetType),
  );
  check(
    '落盘返回里的 targetId 恒为 "<documentId>:<blockId>"',
    forgedTarget.data?.targetId === 'doc-t:blk-t',
    String(forgedTarget.data?.targetId),
  );
  const forgedTargetRow = (await admin.call('/api/ai-edit/ops?limit=100')).data?.ops?.find(
    (row) => row.id === forgedTarget.data?.opId,
  );
  check('审计里记的 targetId 也是服务端拼出来的那个', forgedTargetRow?.targetId === 'doc-t:blk-t', String(forgedTargetRow?.targetId));

  // —— after / before 必须是合法块（`{type, props}`），documentId / blockId 都要给、
  //    不能太长、不能自带冒号（targetId 是按 `:` 拼、回滚时按 `:` 拆的）。
  //    这一组替代了原来「伪造 targetType / targetId」的两条：那两个字段现在客户端
  //    根本传不了，可伪造的空间换成了「形状」和「目标 id」。
  const badAfterType = await admin.call('/api/ai-edit/ops', {
    method: 'POST',
    body: { documentId: 'doc-v', blockId: 'blk-v', after: { type: 'vote', props: {} }, confirm: true },
  });
  check('after 的 type 不在白名单里 → 400', badAfterType.status === 400, `实际 ${badAfterType.status}`);

  // `{type:'poll'}` 有 type 没 props：poll 的 schema 里 question 是必填项，这种块
  // 交给 P2 的 `PUT /api/docs/:id/blocks/:blockId` 是写不进去的，而这里已经会记下
  // 一条 applied 审计（指着一块写不进去的改动）。所以「缺 props」不算合法块。
  const badAfterProps = await admin.call('/api/ai-edit/ops', {
    method: 'POST',
    body: { documentId: 'doc-v', blockId: 'blk-v', after: { type: 'poll' }, confirm: true },
  });
  check('after 缺 props → 400', badAfterProps.status === 400, `实际 ${badAfterProps.status}`);

  const badBefore = await admin.call('/api/ai-edit/ops', {
    method: 'POST',
    body: { documentId: 'doc-v', blockId: 'blk-v', before: { type: 'nope', props: {} }, after: BLOCK_AFTER, confirm: true },
  });
  check('before 形状不对 → 400', badBefore.status === 400, `实际 ${badBefore.status}`);

  const missingBlockId = await admin.call('/api/ai-edit/ops', {
    method: 'POST',
    body: { documentId: 'doc-v', after: BLOCK_AFTER, confirm: true },
  });
  check('缺 blockId → 400', missingBlockId.status === 400, `实际 ${missingBlockId.status}`);

  const emptyBlockId = await admin.call('/api/ai-edit/ops', {
    method: 'POST',
    body: { documentId: 'doc-v', blockId: '', after: BLOCK_AFTER, confirm: true },
  });
  check('blockId 是空串 → 400', emptyBlockId.status === 400, `实际 ${emptyBlockId.status}`);

  const longBlockId = await admin.call('/api/ai-edit/ops', {
    method: 'POST',
    body: { documentId: 'doc-v', blockId: 'y'.repeat(5000), after: BLOCK_AFTER, confirm: true },
  });
  check('超长的 blockId → 400（拼出来的 targetId 超过长度上限）', longBlockId.status === 400, `实际 ${longBlockId.status}`);

  // `documentId` 是必填的：审计记的是「哪一篇的哪一块」，缺了它目标栏会变成 `:blk`，
  // 一条「已落盘」的记录却指不回任何文档，回滚也写不回去。
  const missingDocumentId = await admin.call('/api/ai-edit/ops', {
    method: 'POST',
    body: { blockId: 'blk-v', after: BLOCK_AFTER, confirm: true },
  });
  check('缺 documentId → 400（否则审计指不回任何文档）', missingDocumentId.status === 400, `实际 ${missingDocumentId.status}`);

  const emptyDocumentId = await admin.call('/api/ai-edit/ops', {
    method: 'POST',
    body: { documentId: '', blockId: 'blk-v', after: BLOCK_AFTER, confirm: true },
  });
  check('documentId 是空串 → 400', emptyDocumentId.status === 400, `实际 ${emptyDocumentId.status}`);

  const blankDocumentId = await admin.call('/api/ai-edit/ops', {
    method: 'POST',
    body: { documentId: '   ', blockId: 'blk-v', after: BLOCK_AFTER, confirm: true },
  });
  check('documentId 只有空白 → 400', blankDocumentId.status === 400, `实际 ${blankDocumentId.status}`);

  const zeroDocumentId = await admin.call('/api/ai-edit/ops', {
    method: 'POST',
    body: { documentId: 0, blockId: 'blk-v', after: BLOCK_AFTER, confirm: true },
  });
  check('documentId 是 0（既不是正整数也不是非空字符串）→ 400', zeroDocumentId.status === 400, `实际 ${zeroDocumentId.status}`);

  const colonDocumentId = await admin.call('/api/ai-edit/ops', {
    method: 'POST',
    body: { documentId: 'doc:1', blockId: 'blk-v', after: BLOCK_AFTER, confirm: true },
  });
  check('documentId 含冒号 → 400（targetId 是按冒号拼、回滚时按冒号拆的）', colonDocumentId.status === 400, `实际 ${colonDocumentId.status}`);

  const colonBlockId = await admin.call('/api/ai-edit/ops', {
    method: 'POST',
    body: { documentId: 'doc-v', blockId: 'blk:1', after: BLOCK_AFTER, confirm: true },
  });
  check('blockId 含冒号 → 400', colonBlockId.status === 400, `实际 ${colonBlockId.status}`);

  const blankBlockId = await admin.call('/api/ai-edit/ops', {
    method: 'POST',
    body: { documentId: 'doc-v', blockId: '   ', after: BLOCK_AFTER, confirm: true },
  });
  check('blockId 只有空白 → 400（先 trim 再判空）', blankBlockId.status === 400, `实际 ${blankBlockId.status}`);

  // 正整数形式的 documentId 也要能用：前端手上常常直接是文档主键。
  const numericDocumentId = await admin.call('/api/ai-edit/ops', {
    method: 'POST',
    body: { documentId: 3, blockId: 'b7', after: BLOCK_AFTER, confirm: true },
  });
  check('documentId 是正整数时也能落盘', numericDocumentId.status === 200, `实际 ${numericDocumentId.status}`);
  check(
    '正整数 documentId 被规范化成字符串，targetId = <documentId>:<blockId>',
    numericDocumentId.data?.documentId === '3' && numericDocumentId.data?.targetId === '3:b7',
    JSON.stringify({ documentId: numericDocumentId.data?.documentId, targetId: numericDocumentId.data?.targetId }),
  );
  check(
    '正整数 documentId 的 writeTo 形状',
    numericDocumentId.data?.writeTo === '/api/docs/3/blocks/b7',
    String(numericDocumentId.data?.writeTo),
  );

  /* ---------- 18. 真打一次模型：成功路径 + 每一条失败路径 ---------- */
  //
  // 前面 17 节都跑在「故意不配 key」的服务器上，模型分支（成功解析、超时、上游拒绝、
  // 坏 JSON）**一次都没被执行过**。这一节补上：起一个本地假模型（可切七种应答），
  // 再起一台配了 AI_API_KEY 的应用服务器指向它，用真实 HTTP 走完整条链。
  //
  // 除了状态码和错误代号，这里还钉住「失败也要留痕」：以前上游 401/403/429/500
  // 与坏 JSON 全都不写审计 —— 同一次调用，网络失败有痕、被服务商拒绝没痕。
  // 新增的一条是这次改造的核心价值：**合法的 JSON ≠ 合法的块**。模型完全可以吐回
  // `{"type":"vote","props":{}}` 这种自造类型，落盘时才会炸，所以必须在这里挡住。
  let modelMode = 'ok';
  let lastRequestBody = null;
  let lastAuth = '';

  /**
   * 从「这一节的块（JSON 数组，按顺序）：[…]」里把那个数组抠出来。
   *
   * 第 23 节要验「模型照抄我给过去的 blockId」这条契约，所以假模型必须**真的读一遍**
   * 客户端发来的块，而不是写死一个 id —— 写死的话，把 `blockId` 从提示词里删掉、
   * 或者在半路改名，测试都不会红（那正是这条契约要挡住的事）。
   */
  function blocksFromPrompt(text) {
    const raw = String(text ?? '');
    const start = raw.indexOf('：[');
    if (start < 0) return [];
    let depth = 0;
    for (let i = start + 1; i < raw.length; i += 1) {
      const char = raw[i];
      if (char === '[') depth += 1;
      if (char === ']') {
        depth -= 1;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(raw.slice(start + 1, i + 1));
            return Array.isArray(parsed) ? parsed : [];
          } catch {
            return [];
          }
        }
      }
    }
    return [];
  }

  /**
   * 照抄 blockId、**只改第一块的正文**，其余块原样吐回 —— 故意套一层 ```json 围栏。
   *
   * 只改第一块是有意的：`changedCount` 的语义是「这一节里**真的改了**几块」（按
   * type/props 逐块比对），所以模型改 1 块、原样带回 2 块时，`changedCount` 必须是 1
   * 而 `patch.blocks.length` 是 2。全都改的话这两个数字永远相等，那条契约就形同虚设。
   */
  function echoedSection() {
    const blocks = blocksFromPrompt(lastRequestBody?.messages?.[1]?.content).map((item, index) => ({
      blockId: item.blockId,
      type: item.type,
      props: index === 0 ? { ...item.props, text: `已改：${String(item.props?.text ?? '')}` } : { ...item.props },
    }));
    // 新契约：patch 里除了 `blocks`（落盘用）还要有 `markdown`（只用于预览渲染）。
    return `\`\`\`json\n${JSON.stringify({ blocks, markdown: '## 改过的小节\n\n改过的正文。' })}\n\`\`\``;
  }

  const stub = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      lastAuth = String(req.headers.authorization ?? '');
      try {
        lastRequestBody = JSON.parse(raw);
      } catch {
        lastRequestBody = null;
      }
      const send = (status, payload) => {
        // 所有 200 都补一份上游 usage：真实 DeepSeek 的应答一定带 `usage`，而
        // 「token 用量 → 金额」这条链全靠它。假模型不补的话，第 21 节的金额断言
        // 会在「上游没报用量」那条路上空转（汇总出来是 0，写错了也看不出来）。
        // `usage: null` 是留给「上游真的没报用量」那条用例的显式口子（`in` 判断，
        // 不能用 `??`，否则 null 会被默认值顶掉）。
        const body =
          status === 200 && payload && typeof payload === 'object'
            ? {
                ...payload,
                usage:
                  'usage' in payload
                    ? payload.usage
                    : { prompt_tokens: 1000, completion_tokens: 200, prompt_cache_hit_tokens: 400, prompt_cache_miss_tokens: 600, total_tokens: 1200 },
              }
            : payload;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (modelMode === 'hang') return; // 故意不回，用来触发 504
      if (modelMode === 'unauthorized') return send(401, { error: { message: 'bad key' } });
      if (modelMode === 'ratelimited') return send(429, { error: { message: 'slow down' } });
      if (modelMode === 'upstream') return send(500, { error: { message: 'boom' } });
      if (modelMode === 'badjson') return send(200, { choices: [{ message: { content: '这不是 JSON' } }] });
      // 合法的 JSON，但块类型是模型自造的 `vote`（合法 type 里没有它）。
      if (modelMode === 'unknownType') {
        return send(200, { choices: [{ message: { content: '{"type":"vote","props":{}}' } }] });
      }
      // ── 下面是第 23 节（`/draft-range`）用的分支 ──────────────────────────
      // 按小节：原样照抄发过去的 blockId，只动 props.text（合法路径）。
      if (modelMode === 'section-echo') {
        return send(200, { choices: [{ message: { content: echoedSection() } }] });
      }
      // 按小节：**编造**一个不属于这一节的 blockId —— 模型跑偏的典型表现，
      // 后端必须用 502 ai_bad_json 挡住（否则会往文档里写一块不属于这一节的东西）。
      if (modelMode === 'section-badid') {
        return send(200, {
          choices: [
            {
              message: {
                content:
                  '{"blocks":[{"blockId":"model-invented-1","type":"paragraph","props":{"text":"凭空造的块"}}]}',
              },
            },
          ],
        });
      }
      // 按小节：**整节原样照抄 + 额外多一块凭空多出来的 `b99`**，markdown 正常。
      //
      // 和上面 `section-badid` 的区别很关键：那条的应答里**压根没给 markdown**，所以它是被
      // 「markdown 不能为空」挡下的，并**没有**真的走到「blockId 必须属于我发过去的这一节」
      // 那道判断上（这也是它明明在、却没能拦住「把归属校验改成恒假」那次破坏的原因）。
      // 这一条只错一处：`b99` 不属于这一节 —— 归属校验一旦失效，它就会一路走到落盘，
      // 而 `/api/docs/:id/ops` 的 replace 不看块属于哪一节，文档里就会多出一块不存在的东西。
      if (modelMode === 'section-extraid') {
        const echoed = blocksFromPrompt(lastRequestBody?.messages?.[1]?.content).map((item) => ({
          blockId: item.blockId,
          type: item.type,
          props: { ...item.props },
        }));
        echoed.push({ blockId: 'b99', type: 'paragraph', props: { text: '凭空多出来的' } });
        return send(200, {
          choices: [
            {
              message: {
                content: `\`\`\`json\n${JSON.stringify({ blocks: echoed, markdown: '## 改过的小节\n\n改过的正文。' })}\n\`\`\``,
              },
            },
          ],
        });
      }
      // 按小节：块缺 `type` —— 形状不对。
      if (modelMode === 'section-badshape') {
        return send(200, {
          choices: [{ message: { content: '{"blocks":[{"blockId":"x","props":{"text":"没有 type"}}],"markdown":"x"}' } }],
        });
      }
      // 按小节：只给 blocks、**不给 markdown**（新契约里 markdown 是必填的，缺失 → 502）。
      if (modelMode === 'section-no-markdown') {
        return send(200, {
          choices: [
            {
              message: {
                content: '{"blocks":[{"blockId":"sec-9","type":"paragraph","props":{"text":"改了"}}]}',
              },
            },
          ],
        });
      }
      // 按小节：markdown 是空串（空白也算空）。
      if (modelMode === 'section-empty-markdown') {
        return send(200, {
          choices: [
            {
              message: {
                content: '{"blocks":[{"blockId":"sec-9","type":"paragraph","props":{"text":"改了"}}],"markdown":"   "}',
              },
            },
          ],
        });
      }
      // 按小节：markdown 不是字符串。
      if (modelMode === 'section-nonstring-markdown') {
        return send(200, {
          choices: [
            {
              message: {
                content: '{"blocks":[{"blockId":"sec-9","type":"paragraph","props":{"text":"改了"}}],"markdown":123}',
              },
            },
          ],
        });
      }
      // 按小节：markdown 超过 40000 字符。
      if (modelMode === 'section-huge-markdown') {
        return send(200, {
          choices: [
            {
              message: {
                content: `{"blocks":[{"blockId":"sec-9","type":"paragraph","props":{"text":"改了"}}],"markdown":"${'x'.repeat(40001)}"}`,
              },
            },
          ],
        });
      }
      // 按小节：**少吐一块** —— 这一节发过去两块，模型只回一块。落盘那步要求
      // before/after 的块 id 一一对应，所以这里必须 502（否则「草拟成了、落盘 400」）。
      if (modelMode === 'section-missing-block') {
        const first = blocksFromPrompt(lastRequestBody?.messages?.[1]?.content)[0];
        const only = first
          ? { blockId: first.blockId, type: first.type, props: { ...first.props, text: '只改了第一块' } }
          : { blockId: 'sec-1', type: 'paragraph', props: { text: '只改了第一块' } };
        return send(200, {
          choices: [{ message: { content: JSON.stringify({ blocks: [only], markdown: '## 只回了一块' }) } }],
        });
      }
      // 整篇：合法形状（带 ```json 围栏）。
      if (modelMode === 'document-ok') {
        return send(200, {
          choices: [
            {
              message: {
                content: '```json\n{"markdown":"# 改完的整篇\\n\\n正文。","title":"改完的标题"}\n```',
              },
            },
          ],
        });
      }
      // 整篇：模型吐回 `{blocks:[…]}` —— 形状不对（整篇要的是 `{markdown}`）。
      if (modelMode === 'document-badshape') {
        return send(200, {
          choices: [{ message: { content: '{"blocks":[{"blockId":"b1","type":"paragraph","props":{}}]}' } }],
        });
      }
      // ── 第 18.5 节（审查）用的分支 ──────────────────────────────────────
      //
      // 合法形状，但故意混进一条「引用在原文里根本找不到」的意见（模型编引用是审查
      // 这一类功能最常见的坏法）。服务端必须把它丢掉、并把条数当 `dropped` 报回来
      // —— 不然界面上会显示一份「比模型实际说的少」的意见而没人知道为什么。
      if (modelMode === 'review-ok') {
        const payload = {
          summary: '总体还行，但有一处事实要核对。',
          findings: [
            { blockId: 'r1', kind: 'clarity', severity: 'low', quote: '这是一段要审查的正文', issue: '指代不明', suggestion: '把「它」换成具体名字' },
            { blockId: 'r1', kind: 'fact', severity: 'high', quote: '这一句根本不在原文里', issue: '数据对不上', suggestion: '核对来源' },
            { blockId: 'r1', kind: 'logic', severity: 'medium', quote: '要审查的正文', issue: '推理跳跃', suggestion: '补上中间一步', patch: '补上一步之后' },
            { blockId: 'r1', kind: 'structure', severity: 'low', quote: '里面有几个问题', issue: '段落切得乱', suggestion: '拆成两段' },
          ],
          strengths: ['结构清楚'],
        };
        return send(200, { choices: [{ message: { content: `\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`` } }] });
      }
      // 形状不对：`findings` 不是数组（合法 JSON，但不是合法的审查结果）。
      if (modelMode === 'review-badshape') {
        return send(200, { choices: [{ message: { content: '{"findings":"nope"}' } }] });
      }
      // ── 整篇的第二种合法形状：直接点名「套站里现成的模板」（修复 3b） ──────
      //
      // 站里 8 个模板是维护好的成品；用户说「改成投票问卷的样子」时，让模型现编
      // Markdown 既容易编歪、也容易撑爆 AI_MAX_RANGE_CHARS。所以让它能只回一个 key。
      if (modelMode === 'document-template') {
        return send(200, { choices: [{ message: { content: '{"template":"poll"}' } }] });
      }
      // 编造的模板 key：合法 JSON，但不是站里的模板 —— 必须被挡住，不能当成「新模板」用。
      if (modelMode === 'document-template-bogus') {
        return send(200, { choices: [{ message: { content: '{"template":"量子投票"}' } }] });
      }
      // 形状不对：同时给了 template 与 markdown（两者只能二选一）。
      if (modelMode === 'document-template-both') {
        return send(200, { choices: [{ message: { content: '{"template":"poll","markdown":"# 两套解释"}' } }] });
      }
      // 故意套一层 ```json 围栏：模型经常这么干，代码里必须剥掉才能解析。
      return send(200, {
        choices: [
          { message: { content: '```json\n{"type":"poll","props":{"question":"选哪个？","options":["A","B"]}}\n```' } },
        ],
      });
    });
  });
  await new Promise((done) => stub.listen(MODEL_PORT, '127.0.0.1', done));

  for (const suffix of ['', '-wal', '-shm']) rmSync(KEYED_DB_FILE + suffix, { force: true });
  const keyedLogFd = openSync(KEYED_LOG_FILE, 'w');
  const keyed = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(KEYED_PORT),
      DB_FILE: KEYED_DB_FILE,
      AVATAR_DIR,
      NOTES_DIR,
      QUIET: '1',
      AI_API_KEY: 'stub-key',
      AI_BASE_URL: MODEL_BASE,
      AI_MODEL: 'stub-model',
      AI_TIMEOUT_MS: '1500', // 「hang」那条不用干等 180 秒
      // 第 21 节（金额）：`stub-model` 不在官方价目表里，所以**必须**用这三个环境变量
      // 登记单价 —— 正好把「没登记价格的模型怎么算钱」这条备用法也真的走一遍。
      // 数就是 Flash 的高峰价，好让期望值一眼能算：0.002816 元 / 次调用。
      AI_PRICE_INPUT_PER_M: '2',
      AI_PRICE_CACHE_HIT_PER_M: '0.04',
      AI_PRICE_OUTPUT_PER_M: '8',
    },
    stdio: ['ignore', keyedLogFd, keyedLogFd],
  });
  extraChildren.push(keyed, { kill: () => stub.close() });

  check('配了 key 的第二台服务器起来了', await waitForServer(20000, KEYED_BASE), '看看 data/ai-smoke-keyed-server.log');

  const keyedAdmin = createClient(KEYED_BASE);
  const keyedLogin = await keyedAdmin.call('/api/auth/login', {
    method: 'POST',
    body: { username: 'admin', password: 'admin123' },
  });
  check('第二台服务器上管理员也能登录（同一份种子数据）', keyedLogin.status === 200, JSON.stringify(keyedLogin.error ?? null));
  await keyedAdmin.call('/api/ai-edit/grants', {
    method: 'POST',
    body: { capability: 'edit_content', confirm: true, dailyQuota: 0 },
  });

  const okDraft = await keyedAdmin.call('/api/ai-edit/draft', {
    method: 'POST',
    body: { blockId: 'block-1', block: { type: 'paragraph', props: { text: '原文' } }, instruction: '改成投票' },
  });
  check(
    '上游正常时草拟成功，且仍然只是预览（不自动落盘）',
    okDraft.status === 200 && okDraft.data?.applied === false,
    `${okDraft.status} ${JSON.stringify(okDraft.error ?? null)}`,
  );
  check('拿回来的是模型给的块改动', okDraft.data?.patch?.type === 'poll', JSON.stringify(okDraft.data?.patch ?? null));
  check(
    '带 ```json 围栏的应答也能解析',
    okDraft.data?.patch?.props?.question === '选哪个？',
    JSON.stringify(okDraft.data?.patch ?? null),
  );
  check('模型名如实回填', okDraft.data?.model === 'stub-model', String(okDraft.data?.model));

  check('请求体带上了配置的 model', lastRequestBody?.model === 'stub-model', String(lastRequestBody?.model));
  check(
    'system 提示词要求只输出一个 JSON 对象',
    String(lastRequestBody?.messages?.[0]?.content ?? '').includes('JSON'),
    String(lastRequestBody?.messages?.[0]?.content ?? ''),
  );
  check(
    'system 提示词教的是 {type, props} 形状',
    String(lastRequestBody?.messages?.[0]?.content ?? '').includes('"type"') &&
      String(lastRequestBody?.messages?.[0]?.content ?? '').includes('"props"'),
    String(lastRequestBody?.messages?.[0]?.content ?? ''),
  );
  check(
    'user 消息里带着当前块',
    String(lastRequestBody?.messages?.[1]?.content ?? '').includes('"type"'),
    String(lastRequestBody?.messages?.[1]?.content ?? ''),
  );
  check(
    'user 消息里带着改写要求',
    String(lastRequestBody?.messages?.[1]?.content ?? '').includes('改成投票'),
    String(lastRequestBody?.messages?.[1]?.content ?? ''),
  );
  check('带上了 Authorization: Bearer <key>', lastAuth === 'Bearer stub-key', lastAuth);

  // ——— 修复 3a 的验收：块级提示词要**教会模型怎么造功能**，而不是只列几个类型 ———
  //
  // 老提示词只写了七种块、poll 的 options 还写成字符串数组，`app`（小应用）压根没出现
  // —— 所以用户说「帮我做个投票 / 写个小工具」时，模型只会把这些字写进正文。
  // 这些断言盯的是「说明书还在不在」，不是措辞：改几个字不会红，删掉一整段才会。
  const draftSystem = String(lastRequestBody?.messages?.[0]?.content ?? '');
  for (const [needle, label] of [
    ['{"app":"计数器"', '小应用 app 的 props 示例'],
    ['{"id":"o1","text":"甲"}', 'poll 的 options 元素是 {id,text} 而不是字符串数组'],
    ['Sandbox.request', '沙箱里怎么申请能力'],
    ['超时 5 秒', '能力申请会超时'],
    ['blocks.derived', '画派生块的能力'],
    ['没有网络', '沙箱里没有网络'],
    ['{"code":"', 'script 块的 props'],
    ['{"doc":"页面标题"', 'subpage 块的 props'],
  ]) {
    check(`块提示词里写了${label}`, draftSystem.includes(needle), `缺 ${needle}`);
  }

  const draftBody = { blockId: 'block-1', block: { type: 'paragraph', props: { text: '原文' } }, instruction: '改' };

  modelMode = 'unauthorized';
  const unauthorized = await keyedAdmin.call('/api/ai-edit/draft', { method: 'POST', body: draftBody });
  check(
    '上游 401 → 502 ai_unauthorized',
    unauthorized.status === 502 && unauthorized.error?.code === 'ai_unauthorized',
    `${unauthorized.status} ${unauthorized.error?.code}`,
  );

  modelMode = 'ratelimited';
  const ratelimited = await keyedAdmin.call('/api/ai-edit/draft', { method: 'POST', body: draftBody });
  check(
    '上游 429 → 429 ai_rate_limited',
    ratelimited.status === 429 && ratelimited.error?.code === 'ai_rate_limited',
    `${ratelimited.status} ${ratelimited.error?.code}`,
  );

  modelMode = 'upstream';
  const upstream = await keyedAdmin.call('/api/ai-edit/draft', { method: 'POST', body: draftBody });
  check(
    '上游 500 → 502 ai_upstream_error',
    upstream.status === 502 && upstream.error?.code === 'ai_upstream_error',
    `${upstream.status} ${upstream.error?.code}`,
  );

  modelMode = 'badjson';
  const badjson = await keyedAdmin.call('/api/ai-edit/draft', { method: 'POST', body: draftBody });
  check(
    '模型返回非 JSON → 502 ai_bad_json',
    badjson.status === 502 && badjson.error?.code === 'ai_bad_json',
    `${badjson.status} ${badjson.error?.code}`,
  );

  // —— 这次改造的核心：合法 JSON 但块类型是编的（`vote`）也要挡住，
  //    而不是等落盘的时候才炸，而且必须留痕。
  modelMode = 'unknownType';
  const unknownType = await keyedAdmin.call('/api/ai-edit/draft', { method: 'POST', body: draftBody });
  check(
    '模型返回不存在的块类型（vote）→ 502 ai_bad_json',
    unknownType.status === 502 && unknownType.error?.code === 'ai_bad_json',
    `${unknownType.status} ${unknownType.error?.code}`,
  );

  modelMode = 'hang';
  const timedOut = await keyedAdmin.call('/api/ai-edit/draft', { method: 'POST', body: draftBody });
  check(
    '上游不回应 → 504 ai_timeout',
    timedOut.status === 504 && timedOut.error?.code === 'ai_timeout',
    `${timedOut.status} ${timedOut.error?.code}`,
  );
  modelMode = 'ok';

  const keyedOps = (await keyedAdmin.call('/api/ai-edit/ops?limit=100')).data?.ops ?? [];
  for (const [reason, label] of [
    ['ai_unauthorized', '上游拒绝 key'],
    ['ai_rate_limited', '上游限流'],
    ['ai_upstream_error', '上游 5xx'],
    ['ai_bad_json', '模型返回非 JSON'],
    ['ai_timeout', '上游超时'],
  ]) {
    const row = keyedOps.find((item) => item.action === 'draft' && String(item.reason ?? '').includes(reason));
    check(
      `失败路径「${label}」留下了 blocked 审计（不计配额）`,
      row?.status === 'blocked',
      JSON.stringify(row ?? null),
    );
  }

  const shapeRow = keyedOps.find((item) => item.action === 'draft' && String(item.reason ?? '').includes('块形状不对'));
  check(
    '模型编出不存在的块类型也留下了 blocked 审计，理由是「块形状不对」',
    shapeRow?.status === 'blocked',
    JSON.stringify(shapeRow ?? null),
  );

  /* ---------- 18.5 审查（原「AI 学术审查」的接班人） ---------- */
  //
  // 审查**不改稿**：它只回一堆「带原文引用的意见」，落盘仍然要走
  // `/draft` → `/ops`（预览、确认、审计一步都不少）。这一节验四件事：
  //   · 权限与参数的门（未登录 401 / 没开能力 403 / 缺 documentId 400 / 没内容 400）；
  //   · 引用能不能对上原文（对不上、或短于 6 个字的必须丢掉，并把丢掉的条数报回来）；
  //   · 意见按 severity 从高到低排、留一条 preview 审计；
  //   · 坏形状 502 ai_bad_json（与块/整篇同一条代号）。
  //
  // 用一个**新注册的账号**跑：限流是按用户算的（`ai-edit:review:<userId>`，5 次/分钟），
  // 借上面 admin 的桶会把第 23 节那些用例挤成 429（上一版就是这么被坑过一次的）。
  const keyedReviewer = createClient(KEYED_BASE);
  const reviewerReg = await keyedReviewer.call('/api/auth/register', {
    method: 'POST',
    body: { username: 'ai_reviewer', password: 'reviewer1234' },
  });
  check(
    'keyed 服务器上注册一个专跑审查的账号',
    reviewerReg.status === 200 || reviewerReg.status === 201,
    JSON.stringify(reviewerReg.error ?? null),
  );

  const reviewSource = '这是一段要审查的正文，里面有几个问题。';
  const reviewBody = {
    documentId: 'doc-review',
    blocks: [{ blockId: 'r1', type: 'paragraph', props: { text: reviewSource } }],
  };
  const anonReview = await createClient(KEYED_BASE).call('/api/ai-edit/review', {
    method: 'POST',
    body: reviewBody,
  });
  check('未登录不能审查 → 401', anonReview.status === 401, `实际 ${anonReview.status}`);

  const noGrantReview = await keyedReviewer.call('/api/ai-edit/review', { method: 'POST', body: reviewBody });
  check(
    '没开 edit_content 能力就审查 → 403（不是 500，也不是「审了但不告诉你」）',
    noGrantReview.status === 403,
    `${noGrantReview.status} ${JSON.stringify(noGrantReview.error ?? null)}`,
  );
  await keyedReviewer.call('/api/ai-edit/grants', {
    method: 'POST',
    body: { capability: 'edit_content', confirm: true, dailyQuota: 0 },
  });

  const noDocReview = await keyedReviewer.call('/api/ai-edit/review', {
    method: 'POST',
    body: { ...reviewBody, documentId: '' },
  });
  check('审查缺 documentId → 400（审计要指得回文档）', noDocReview.status === 400, `实际 ${noDocReview.status}`);

  const emptyReview = await keyedReviewer.call('/api/ai-edit/review', {
    method: 'POST',
    body: { documentId: 'doc-review' },
  });
  check(
    '既不给 blocks 也不给 markdown → 400（没东西可审要当场说清）',
    emptyReview.status === 400,
    `${emptyReview.status} ${JSON.stringify(emptyReview.error ?? null)}`,
  );

  modelMode = 'review-ok';
  const okReview = await keyedReviewer.call('/api/ai-edit/review', { method: 'POST', body: reviewBody });
  check(
    '上游正常时审查成功，而且**不落盘**（applied 恒 false）',
    okReview.status === 200 && okReview.data?.applied === false,
    `${okReview.status} ${JSON.stringify(okReview.error ?? null)}`,
  );
  const reviewData = okReview.data ?? {};
  check(
    '审查结果里有 summary / findings / strengths 三样',
    typeof reviewData.summary === 'string' &&
      Array.isArray(reviewData.findings) &&
      Array.isArray(reviewData.strengths),
    JSON.stringify(reviewData).slice(0, 200),
  );
  check(
    '引用在原文里找不到的意见被丢掉，并报出 dropped=1',
    reviewData.dropped === 1 && reviewData.findings.length === 3,
    `dropped=${reviewData.dropped} 留下=${reviewData.findings.length}`,
  );
  check(
    '留下的意见按 severity 从高到低排（medium 在最前）',
    reviewData.findings.map((item) => item.severity).join(',') === 'medium,low,low',
    JSON.stringify(reviewData.findings.map((item) => item.severity)),
  );
  check(
    '每条留下的意见 quote 都能在原文里逐字找到',
    reviewData.findings.every((item) => reviewSource.includes(item.quote)),
    JSON.stringify(reviewData.findings.map((item) => item.quote)),
  );
  check(
    '审查只给意见：回的是 opId + 「要落盘得走 /draft」的提示',
    Number.isInteger(reviewData.opId) && String(reviewData.hint ?? '').includes('/api/ai-edit/draft'),
    String(reviewData.hint ?? ''),
  );
  check(
    '审查的 system 提示词说明了 findings 的形状（否则模型只会回一段散文）',
    String(lastRequestBody?.messages?.[0]?.content ?? '').includes('findings'),
    '',
  );

  const reviewOps = (await keyedReviewer.call('/api/ai-edit/ops?limit=50')).data?.ops ?? [];
  check(
    '审查留了一条 preview 审计（reason 以「审查」开头）',
    reviewOps.some((row) => String(row.reason ?? '').startsWith('审查') && row.status === 'preview'),
    JSON.stringify(reviewOps.slice(0, 3)),
  );

  modelMode = 'review-badshape';
  const badShapeReview = await keyedReviewer.call('/api/ai-edit/review', { method: 'POST', body: reviewBody });
  check(
    'findings 不是数组 → 502 ai_bad_json（与块 / 整篇同一条代号）',
    badShapeReview.status === 502 && badShapeReview.error?.code === 'ai_bad_json',
    `${badShapeReview.status} ${badShapeReview.error?.code}`,
  );
  const reviewBlocked = ((await keyedReviewer.call('/api/ai-edit/ops?limit=50')).data?.ops ?? []).find(
    (row) => row.status === 'blocked' && String(row.reason ?? '').includes('审查形状不对'),
  );
  check('坏形状也留下了 blocked 审计', reviewBlocked?.status === 'blocked', JSON.stringify(reviewBlocked ?? null));
  modelMode = 'ok';

  /* ---------- 19. 块类型清单不许漂移（静态哨兵 + 行为级对拍） ---------- */
  //
  // `AI_BLOCK_TYPES` 是从 P2 的 `src/modules/doc/blocks/types.js` **抄的一份**
  // （骨架规范禁止 import 隔壁模块的文件，所以只能复制）。抄来的东西会漂：
  // P2 以后加/改块类型，我的提示词就会教模型输出错的东西，而错是静默的 ——
  // 模型照着新名字吐，落盘时才炸。这一节让漂移在测试里立刻红，而不是等线上。
  check('从 P2 的 types.js 抓到 16 个内置块类型名', P2_BLOCK_TYPE_NAMES.length === 16, JSON.stringify(P2_BLOCK_TYPE_NAMES));
  check('从 AI 的 schema.js 抓到 16 个类型名', AI_BLOCK_TYPE_NAMES.length === 16, JSON.stringify(AI_BLOCK_TYPE_NAMES));
  check(
    '两边的块类型清单完全一致（名字与顺序都对齐）',
    JSON.stringify(P2_BLOCK_TYPE_NAMES) === JSON.stringify(AI_BLOCK_TYPE_NAMES),
    `P2=${JSON.stringify(P2_BLOCK_TYPE_NAMES)} AI=${JSON.stringify(AI_BLOCK_TYPE_NAMES)}`,
  );
  check(
    '清单里没有 vote 这种编造的块类型（投票块的真名是 poll）',
    !P2_BLOCK_TYPE_NAMES.includes('vote') && P2_BLOCK_TYPE_NAMES.includes('poll') && !AI_BLOCK_TYPE_NAMES.includes('vote'),
    JSON.stringify(P2_BLOCK_TYPE_NAMES),
  );

  // 上面两条比的是**源文件里的数组字面量**。但 `blockPatchProblem` 放行的是从它派生出来的
  // `AI_BLOCK_TYPE_NAMES`，中间隔着 `.map(item => item.name)`。派生那一步被改坏（多一个
  // concat、少一个 filter）时字面量照样对得上，运行时的白名单却已经和 P2 不一致了 ——
  // 只比字面量会漏掉这一整类漂移，所以再比一次**运行时导出的值**。
  check(
    '运行时导出的 AI_BLOCK_TYPE_NAMES 与源文件字面量一致（派生那一步没被改坏）',
    JSON.stringify(AI_RUNTIME_TYPE_NAMES) === JSON.stringify(AI_BLOCK_TYPE_NAMES),
    `运行时=${JSON.stringify(AI_RUNTIME_TYPE_NAMES)} 字面量=${JSON.stringify(AI_BLOCK_TYPE_NAMES)}`,
  );
  check(
    '运行时导出的 AI_BLOCK_TYPE_NAMES 与 P2 的清单一致（白名单真的只放行这 16 个）',
    JSON.stringify(AI_RUNTIME_TYPE_NAMES) === JSON.stringify(P2_BLOCK_TYPE_NAMES),
    `运行时=${JSON.stringify(AI_RUNTIME_TYPE_NAMES)} P2=${JSON.stringify(P2_BLOCK_TYPE_NAMES)}`,
  );

  // 行为级对拍：清单的真实出口是 P2 的 `GET /api/docs/meta/block-types`。
  // 它给的是「内置 ∪ 库里注册的」，所以只比 `builtin: true` 的那 16 个 ——
  // 静默漂移的另一半是「接口加了类型、AI 的清单没跟上」。
  const metaTypes = await admin.call('/api/docs/meta/block-types');
  check('GET /api/docs/meta/block-types 返回 200', metaTypes.status === 200, `实际 ${metaTypes.status}`);
  const metaBuiltinNames = (metaTypes.data?.types ?? []).filter((item) => item.builtin).map((item) => item.name);
  check(
    '接口给的内置类型清单和 AI 的清单逐项一致',
    JSON.stringify(metaBuiltinNames) === JSON.stringify(AI_BLOCK_TYPE_NAMES),
    `接口=${JSON.stringify(metaBuiltinNames)} AI=${JSON.stringify(AI_BLOCK_TYPE_NAMES)}`,
  );

  // —— 模板 key 的漂移哨兵（修复 3b）——
  //
  // 整篇改写现在可以被模型一句 `{"template":"poll"}` 带过，落盘走 P2 的
  // `POST /api/docs/:id/apply-template`。`AI_TEMPLATE_KEYS` 是手抄的 `TEMPLATES`：
  // P2 以后加/删/改名模板时，提示词里的菜单就会和站里对不上 —— 模型会点名一个
  // 不存在的模板（用户拿到 400「不认识的模板」），或者压根不知道新模板能用。
  check('从 P2 的 templates.js 抓到 8 个模板 key', P2_TEMPLATE_KEYS.length === 8, JSON.stringify(P2_TEMPLATE_KEYS));
  check(
    '从 AI 的 syntax.js 抓到同样的 8 个 key（名字与顺序都对齐）',
    JSON.stringify(AI_TEMPLATE_KEYS_STATIC) === JSON.stringify(P2_TEMPLATE_KEYS),
    `P2=${JSON.stringify(P2_TEMPLATE_KEYS)} AI=${JSON.stringify(AI_TEMPLATE_KEYS_STATIC)}`,
  );
  const metaTemplates = await admin.call('/api/docs/meta/templates');
  check('GET /api/docs/meta/templates 返回 200', metaTemplates.status === 200, `实际 ${metaTemplates.status}`);
  check(
    '接口给的模板清单和 AI 的菜单逐项一致（AI 不会点名一个站里没有的模板）',
    JSON.stringify((metaTemplates.data?.templates ?? []).map((item) => item.key)) ===
      JSON.stringify(AI_TEMPLATE_KEYS_STATIC),
    `接口=${JSON.stringify((metaTemplates.data?.templates ?? []).map((item) => item.key))}`,
  );

  /* ---------- 20. 全站每日预算闸门（AI_DAILY_TOTAL_LIMIT） ---------- */

  //
  // 单用户配额管不住**总额**：钱是按 key 算的，配额是按用户算的。这一节起一台
  // 独立库 + 独立端口的服务器，把全站上限设成 2，验证：
  //   · 落盘（confirm:true）累计到上限就被 429 挡住，代号还是 ai_rate_limited；
  //   · **预览不受影响**（预览既不调模型也不写盘，没有理由被预算挡住）；
  //   · `/api/ai-edit/usage` 的 budget.used / limit / remaining 对得上。
  for (const suffix of ['', '-wal', '-shm']) rmSync(BUDGET_DB_FILE + suffix, { force: true });
  const budgetLogFd = openSync(BUDGET_LOG_FILE, 'w');
  const budgetServer = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(BUDGET_PORT),
      DB_FILE: BUDGET_DB_FILE,
      AVATAR_DIR,
      NOTES_DIR,
      QUIET: '1',
      AI_API_KEY: '',
      AI_DAILY_TOTAL_LIMIT: String(BUDGET_LIMIT),
    },
    stdio: ['ignore', budgetLogFd, budgetLogFd],
  });
  extraChildren.push(budgetServer);

  check(
    '配了全站预算的第三台服务器起来了',
    await waitForServer(20000, BUDGET_BASE),
    '看看 data/ai-smoke-budget-server.log',
  );

  const budgetAdmin = createClient(BUDGET_BASE);
  const budgetLogin = await budgetAdmin.call('/api/auth/login', {
    method: 'POST',
    body: { username: 'admin', password: 'admin123' },
  });
  check('第三台服务器上管理员能登录（同一份种子数据）', budgetLogin.status === 200, JSON.stringify(budgetLogin.error ?? null));

  const budgetGrant = await budgetAdmin.call('/api/ai-edit/grants', {
    method: 'POST',
    body: { capability: 'edit_content', confirm: true, dailyQuota: 0 },
  });
  check('第三台服务器上授权 edit_content 成功', budgetGrant.status === 200, JSON.stringify(budgetGrant.error ?? null));

  const budgetBody = {
    documentId: 'doc-budget',
    blockId: 'block-budget',
    before: BLOCK_BEFORE,
    after: BLOCK_AFTER,
    confirm: true,
  };
  const budgetFirst = await budgetAdmin.call('/api/ai-edit/ops', { method: 'POST', body: budgetBody });
  check(
    `预算内第 1 次落盘成功（1/${BUDGET_LIMIT}）`,
    budgetFirst.status === 200 && budgetFirst.data?.applied === true,
    `实际 ${budgetFirst.status}`,
  );
  const budgetSecond = await budgetAdmin.call('/api/ai-edit/ops', { method: 'POST', body: budgetBody });
  check(
    `预算内第 2 次落盘成功（${BUDGET_LIMIT}/${BUDGET_LIMIT}）`,
    budgetSecond.status === 200 && budgetSecond.data?.applied === true,
    `实际 ${budgetSecond.status}`,
  );
  const budgetThird = await budgetAdmin.call('/api/ai-edit/ops', { method: 'POST', body: budgetBody });
  check('用满全站预算后继续落盘返回 429', budgetThird.status === 429, `实际 ${budgetThird.status}`);
  check('超预算的错误代号是 ai_rate_limited', budgetThird.error?.code === 'ai_rate_limited', String(budgetThird.error?.code));

  // 预览不花钱：预算用光之后预览仍然必须能出。
  const budgetPreview = await budgetAdmin.call('/api/ai-edit/ops', {
    method: 'POST',
    body: {
      documentId: 'doc-budget',
      blockId: 'block-budget',
      before: BLOCK_BEFORE,
      after: BLOCK_AFTER,
    },
  });
  check(
    '预算用光之后预览仍然 200（预览不花钱，不该被预算挡住）',
    budgetPreview.status === 200 && budgetPreview.data?.applied === false,
    `实际 ${budgetPreview.status} ${JSON.stringify(budgetPreview.error ?? null)}`,
  );

  const budgetUsage = await budgetAdmin.call('/api/ai-edit/usage');
  check('预算服务器上的用量面板返回 200', budgetUsage.status === 200, `实际 ${budgetUsage.status}`);
  check(
    'budget.limit 就是 AI_DAILY_TOTAL_LIMIT',
    budgetUsage.data?.site?.budget?.limit === BUDGET_LIMIT,
    String(budgetUsage.data?.site?.budget?.limit),
  );
  check(
    'budget.used 等于已经计费的落盘次数',
    budgetUsage.data?.site?.budget?.used === BUDGET_LIMIT,
    String(budgetUsage.data?.site?.budget?.used),
  );
  check(
    'budget.remaining 归零',
    budgetUsage.data?.site?.budget?.remaining === 0,
    String(budgetUsage.data?.site?.budget?.remaining),
  );
  check(
    '配了上限时 unlimited 是 false',
    budgetUsage.data?.site?.budget?.unlimited === false,
    String(budgetUsage.data?.site?.budget?.unlimited),
  );
  check(
    '预览没有被算进 site.today.billed',
    budgetUsage.data?.site?.today?.billed === BUDGET_LIMIT,
    String(budgetUsage.data?.site?.today?.billed),
  );

  /* ---------- 21. /api/ai-edit/usage：自己的账 vs 全站账 ---------- */
  //
  // 这一版面板分两层：**每个登录用户**都能看自己的用量与金额；全站口径
  // （今天谁在用、这个月每天花了多少）只有管理团队拿得到 —— 而且不是前端藏起来：
  // 普通用户的响应里**根本没有** `site` 这一块。
  const anonUsage = await createClient().call('/api/ai-edit/usage');
  check('未登录看用量返回 401', anonUsage.status === 401, `实际 ${anonUsage.status}`);
  check('未登录的错误代号是 unauthenticated', anonUsage.error?.code === 'unauthenticated', String(anonUsage.error?.code));

  const aliceUsage = await alice.call('/api/ai-edit/usage');
  check(
    '普通用户看用量返回 200（不再是 403 —— 自己的账自己看）',
    aliceUsage.status === 200,
    `实际 ${aliceUsage.status} ${JSON.stringify(aliceUsage.error ?? null)}`,
  );
  check('普通用户的 scope 是 me', aliceUsage.data?.scope === 'me', String(aliceUsage.data?.scope));
  check(
    '普通用户的响应里没有全站那一块（连字段都不给，不是前端藏起来）',
    aliceUsage.data?.site === undefined && aliceUsage.data?.budget === undefined,
    JSON.stringify(Object.keys(aliceUsage.data ?? {})),
  );
  check(
    '普通用户自己那份有今日/本周/本月三个窗口，且都是数字形状',
    ['today', 'week', 'month'].every(
      (key) =>
        typeof aliceUsage.data?.me?.[key]?.billed === 'number' &&
        typeof aliceUsage.data?.me?.[key]?.tokens?.total === 'number' &&
        typeof aliceUsage.data?.me?.[key]?.cost?.yuan === 'number',
    ),
    JSON.stringify(aliceUsage.data?.me ?? null),
  );
  check(
    '窗口起点给出来了：金额按 Asia/Shanghai，次数口径仍是 UTC',
    String(aliceUsage.data?.windows?.timezone ?? '').includes('Asia/Shanghai') &&
      aliceUsage.data?.windows?.countsTimezone === 'UTC' &&
      aliceUsage.data?.windows?.today <= Date.now() &&
      aliceUsage.data?.windows?.week <= aliceUsage.data?.windows?.today,
    JSON.stringify(aliceUsage.data?.windows ?? null),
  );
  check(
    '普通用户自己的账记着刚才那次落盘（本月的计费次数大于 0）',
    Number(aliceUsage.data?.me?.month?.billed) > 0,
    JSON.stringify(aliceUsage.data?.me?.month ?? null),
  );

  // 先制造几次计费调用，再断言面板把它们算进去了。
  await admin.call('/api/ai-edit/grants', {
    method: 'POST',
    body: { capability: 'edit_content', confirm: true, dailyQuota: 0 },
  });
  const usageOpsBody = {
    documentId: 'doc-usage',
    blockId: 'block-usage',
    before: BLOCK_BEFORE,
    after: BLOCK_AFTER,
    confirm: true,
  };
  const usageAppliedOne = await admin.call('/api/ai-edit/ops', { method: 'POST', body: usageOpsBody });
  const usageAppliedTwo = await admin.call('/api/ai-edit/ops', { method: 'POST', body: usageOpsBody });
  check(
    '制造计费调用：两次落盘都成功',
    usageAppliedOne.status === 200 && usageAppliedTwo.status === 200,
    `${usageAppliedOne.status} / ${usageAppliedTwo.status}`,
  );

  const usage = await admin.call('/api/ai-edit/usage');
  check('管理员看用量返回 200', usage.status === 200, `实际 ${usage.status} ${JSON.stringify(usage.error ?? null)}`);
  check('管理员的 scope 是 site（还带了全站口径）', usage.data?.scope === 'site', String(usage.data?.scope));
  const usageSite = usage.data?.site ?? {};
  check(
    'budget.envKey 是 AI_DAILY_TOTAL_LIMIT',
    usageSite.budget?.envKey === 'AI_DAILY_TOTAL_LIMIT',
    JSON.stringify(usageSite.budget ?? null),
  );
  check(
    '没配全站上限时 unlimited=true 且 remaining=null',
    usageSite.budget?.unlimited === true && usageSite.budget?.remaining === null,
    JSON.stringify(usageSite.budget ?? null),
  );
  const usageToday = usageSite.today ?? {};
  check(
    'site.today 的计数字段是数字、列表字段是数组',
    typeof usageToday.total === 'number' &&
      typeof usageToday.billed === 'number' &&
      typeof usageToday.blocked === 'number' &&
      typeof usageToday.users === 'number' &&
      Array.isArray(usageToday.byAction) &&
      Array.isArray(usageToday.topUsers),
    JSON.stringify(usageToday),
  );
  check('site.today.billed 大于 0（刚制造的落盘算进去了）', usageToday.billed > 0, String(usageToday.billed));
  check(
    'site.today.total 不小于 site.today.billed（total 是当天全部日志行）',
    usageToday.total >= usageToday.billed,
    `${usageToday.total} / ${usageToday.billed}`,
  );
  check(
    'byAction 是 {action, count} 形状',
    usageToday.byAction.every((item) => typeof item.action === 'string' && typeof item.count === 'number'),
    JSON.stringify(usageToday.byAction),
  );
  check(
    'topUsers 里有 admin，且次数大于 0',
    usageToday.topUsers.some((item) => item.username === 'admin' && item.count > 0),
    JSON.stringify(usageToday.topUsers),
  );
  check(
    'note 说清了「金额 = token × 单价」，而不是只有次数',
    typeof usage.data?.note === 'string' && usage.data.note.includes('token') && usage.data.note.includes('金额'),
    String(usage.data?.note),
  );

  /* ---------- 21a. 全站「本月每天」与周/月汇总 ---------- */
  //
  // 用户要的是「这个月每天的用量与金额」。所以：1 号到今天每一天都要有一行
  // （没调用的日子也不能缺 —— 缺行会让人以为看漏了一天），而且它得和今日那块对得上。
  const usageDays = usageSite.days ?? [];
  const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
  check(
    'site.days 是 1 号到今天，每天一行',
    Array.isArray(usageDays) && usageDays.length >= 1 && usageDays.every((day) => dayPattern.test(String(day.date))),
    `共 ${usageDays.length} 行：${JSON.stringify(usageDays.slice(0, 2))}`,
  );
  check(
    'site.days 从早到晚递增，最后一行是今天',
    usageDays.every((day, index) => index === 0 || day.date > usageDays[index - 1].date) &&
      usageDays[usageDays.length - 1]?.date === usageToday.date,
    `${usageDays[usageDays.length - 1]?.date} vs ${usageToday.date}`,
  );
  check(
    '本月 1 号的日期与 windows.month 对得上',
    usageDays[0]?.date === new Date(Number(usage.data?.windows?.month ?? 0) + 8 * 3600 * 1000).toISOString().slice(0, 10),
    `${usageDays[0]?.date} vs windows.month=${usage.data?.windows?.month}`,
  );
  check(
    '每一行都有次数、token 与金额（形状齐全）',
    usageDays.every(
      (day) =>
        typeof day.billed === 'number' &&
        typeof day.tokens?.total === 'number' &&
        typeof day.tokens?.calls === 'number' &&
        typeof day.cost?.yuan === 'number',
    ),
    JSON.stringify(usageDays[usageDays.length - 1] ?? null),
  );
  check(
    '今天的每日行与 site.today 的 token / 金额逐字一致（同一个北京时间日）',
    Math.abs(Number(usageDays[usageDays.length - 1]?.cost?.yuan ?? -1) - Number(usageToday.cost?.yuan ?? -2)) < 1e-9 &&
      Number(usageDays[usageDays.length - 1]?.tokens?.total ?? -1) === Number(usageToday.tokens?.total ?? -2),
    `${JSON.stringify(usageDays[usageDays.length - 1] ?? null)} vs ${JSON.stringify(usageToday.tokens ?? null)}`,
  );
  check(
    '本月汇总不少于今天、不少于本周（窗口是包含关系）',
    Number(usageSite.month?.tokens?.total ?? 0) >= Number(usageToday.tokens?.total ?? 0) &&
      Number(usageSite.month?.cost?.yuan ?? 0) >= Number(usageToday.cost?.yuan ?? 0) &&
      Number(usageSite.month?.tokens?.total ?? 0) >= Number(usageSite.week?.tokens?.total ?? 0),
    JSON.stringify({ month: usageSite.month?.tokens ?? null, week: usageSite.week?.tokens ?? null }),
  );
  check(
    '周/月汇总都带着窗口起点（前端要写出「从哪天算起」）',
    typeof usageSite.week?.from === 'number' && typeof usageSite.month?.from === 'number' && usageSite.month.from <= usageSite.week.from,
    JSON.stringify({ week: usageSite.week?.from, month: usageSite.month?.from }),
  );
  check(
    '每天的金额合计 = 本月汇总的金额（两处算法一致，不是各算各的）',
    Math.abs(
      usageDays.reduce((sum, day) => sum + Number(day.cost?.yuan ?? 0), 0) - Number(usageSite.month?.cost?.yuan ?? 0),
    ) < 1e-6,
    `${usageDays.reduce((sum, day) => sum + Number(day.cost?.yuan ?? 0), 0)} vs ${usageSite.month?.cost?.yuan}`,
  );


  /* ---------- 21b. 金额：真的记下了 token 与钱（在跑过真模型的 keyed 服务器上） ---------- */
  //
  // 为什么挂 keyed 那台：只有它配了 key，前面的第 18 / 23 节在它上面真的调过模型，
  // `ai_token_usage` 里才有行。假模型每个 200 都报同一份 usage（输入 1000，其中
  // 缓存命中 400，输出 200），登记的单价又是 Flash 高峰价，所以每次调用该是
  //   (600×2 + 400×0.04 + 200×8) / 1000000 = 0.002816 元
  // —— 期望值能一眼算出来，这条断言才算真的钉住了算术。
  // ── 跨日界哨兵 ─────────────────────────────────────────────────────────────
  // 「今日的计数」是配额闸门的口径（UTC 自然日），跟钱用的北京日不是一回事。
  // 光把面板数字和审计表比一遍**抓不到**「有人把它改回北京日窗口」这条回归：测试里所有
  // 账都是刚刚造的，两个窗口都圈得住它们，断言照样绿。所以这里往 keyed 那台的库里塞一条
  // 合成账，让它只被其中一个窗口圈住 —— 两个日界相差 8 小时，取较早的那个 +1 小时，
  // 必然落在那段 8 小时的带子里（在北京日窗口里就不在 UTC 日窗口里，反之亦然）。
  // 读一次面板（before）→ 插标记 → 再读（keyedUsage）→ 断言 → 立刻删掉标记，
  // 免得后面小节数到的账里混进这一条。
  const beforeUsage = await keyedAdmin.call('/api/ai-edit/usage');
  const beforeMe = beforeUsage.data?.me ?? {};
  const beforeBilled = Number(beforeMe.today?.billed ?? -1);
  check(
    '金额：用量面板会告诉请求者「你是谁」（me.userId / me.username）',
    Number.isInteger(beforeMe.userId) &&
      beforeMe.userId > 0 &&
      typeof beforeMe.username === 'string' &&
      beforeMe.username !== '',
    JSON.stringify({ userId: beforeMe.userId, username: beforeMe.username }),
  );
  const dayMs = 86400000;
  const beijingOffsetMs = 8 * 3600000;
  const utcDayStart = Date.now() - (Date.now() % dayMs);
  const beijingDayStart = Math.floor((Date.now() + beijingOffsetMs) / dayMs) * dayMs - beijingOffsetMs;
  const markerAt = Math.min(beijingDayStart, utcDayStart) + 3600000;
  const markerInUtcDay = markerAt >= utcDayStart;
  const expectedBilled = markerInUtcDay ? beforeBilled + 1 : beforeBilled;
  const markerDb = new DatabaseSync(KEYED_DB_FILE);
  const marker = markerDb
    .prepare(
      `INSERT INTO ai_op_logs (user_id, capability, action, target_type, target_id, status, reason, created_at)
       VALUES (?, 'edit_content', 'draft', '', '', 'applied', 'ai-smoke 跨日界哨兵', ?)`,
    )
    .run(beforeMe.userId, markerAt);
  const keyedUsage = await keyedAdmin.call('/api/ai-edit/usage');
  const kSite = keyedUsage.data?.site?.today ?? {};
  const kTokens = kSite.tokens ?? {};
  const kCost = kSite.cost ?? {};
  const kAll = keyedUsage.data?.site?.allTime ?? {};
  const kPricing = keyedUsage.data?.pricing ?? {};
  const kMe = keyedUsage.data?.me?.today ?? {};
  check('金额：keyed 服务器上记下了 token 用量', kTokens.total > 0 && kTokens.calls > 0, JSON.stringify(kTokens));
  check(
    '金额：「我自己」那一份也能看到金额（不只是管理员的全站账）',
    Number(kMe.tokens?.calls) > 0 && Number(kMe.cost?.yuan) > 0,
    JSON.stringify(kMe),
  );
  check(
    '金额：我自己的那份不会比全站那份还多（自己的账是全站账的子集）',
    Number(kMe.tokens?.total) <= Number(kTokens.total) && Number(kMe.billed ?? 0) <= Number(kSite.billed ?? 0),
    JSON.stringify({ me: kMe.tokens?.total, site: kTokens.total, meBilled: kMe.billed, siteBilled: kSite.billed }),
  );
  // 「今日的计数」拿审计表自己数一遍：面板上的 `me.today.billed` 应当等于自己今天的账。
  const kOps = await keyedAdmin.call('/api/ai-edit/ops?limit=100');
  const quotaActions = ['read', 'draft', 'apply', 'publish', 'tool'];
  const myBilledToday = (kOps.data?.ops ?? []).filter(
    (op) => Number(op.createdAt ?? 0) >= utcDayStart && quotaActions.includes(op.action) && op.status !== 'blocked',
  ).length;
  check(
    '金额：「我的今日计费」按配额口径（UTC 自然日）数，与审计表里自己今天的账逐条对上',
    myBilledToday === Number(kMe.billed ?? -1),
    JSON.stringify({ ops: myBilledToday, panel: kMe.billed, utcDayStart }),
  );
  // 这一条才是回归哨兵：合成账只被一个窗口圈住，所以只要窗口选错（北京日 / UTC 日 反了），
  // 面板上的数字就会跟 expectedBilled 差 1 —— 不管跑测试的时候是几点。
  check(
    '金额：「我的今日计费」用的窗口是 UTC 日，不是北京日（跨日界的那条合成账只为一边 +1）',
    Number(kMe.billed ?? -1) === expectedBilled,
    JSON.stringify({
      panel: kMe.billed,
      expected: expectedBilled,
      before: beforeBilled,
      markerInUtcDay,
      markerAt,
      utcDayStart,
      beijingDayStart,
    }),
  );
  // 哨兵读完就把合成账删掉，后面小节看到的审计表跟插之前一模一样。
  markerDb.prepare('DELETE FROM ai_op_logs WHERE id = ?').run(Number(marker.lastInsertRowid));
  markerDb.close();
  check('金额：每次调用的用量都记全了（missing 为 0）', kTokens.missing === 0, JSON.stringify(kTokens));
  check(
    '金额：输入 = 命中 + 未命中，且每次调用一行（1000 / 400 / 200 × 次数）',
    kTokens.prompt === 1000 * kTokens.calls &&
      kTokens.cached === 400 * kTokens.calls &&
      kTokens.completion === 200 * kTokens.calls,
    JSON.stringify(kTokens),
  );
  check('金额：算出了钱（不是 0）', kCost.yuan > 0, JSON.stringify(kCost));
  check(
    '金额：高峰档的钱 + 空闲档的钱 = 总额（两档分开算，没有混着乘一个价）',
    Math.abs(kCost.peakYuan + kCost.offPeakYuan - kCost.yuan) < 1e-9,
    JSON.stringify(kCost),
  );
  const perPeakCall = (600 * 2 + 400 * 0.04 + 200 * 8) / AI_TOKENS_PER_PRICE_UNIT;
  const perOffPeakCall = perPeakCall * AI_OFF_PEAK_FACTOR;
  if (kCost.offPeakYuan === 0) {
    check(
      '金额：整段都在高峰档时，钱精确等于「每次单价 × 次数」',
      Math.abs(kCost.yuan - perPeakCall * kTokens.calls) < 1e-9,
      `${kCost.yuan} vs ${perPeakCall * kTokens.calls}`,
    );
  } else if (kCost.peakYuan === 0) {
    check(
      '金额：整段都在空闲档时，钱精确等于「半价 × 次数」',
      Math.abs(kCost.yuan - perOffPeakCall * kTokens.calls) < 1e-9,
      `${kCost.yuan} vs ${perOffPeakCall * kTokens.calls}`,
    );
  } else {
    // 测试窗口正好跨过档位切换点（北京时间 9 / 12 / 14 / 18 点）才会走到这里。
    check(
      '金额：跨了档位（窗口跨过切换点），钱落在两档之间',
      kCost.yuan > perOffPeakCall * kTokens.calls - 1e-9 && kCost.yuan < perPeakCall * kTokens.calls + 1e-9,
      JSON.stringify(kCost),
    );
  }
  check(
    '金额：历史累计不少于今日（今日是它的子集）',
    (kAll.tokens?.total ?? 0) >= kTokens.total && (kAll.cost?.yuan ?? 0) >= kCost.yuan,
    JSON.stringify(kAll),
  );
  check(
    '金额：没登记价格的模型如实说「没登记」，并给出登记用的环境变量名',
    kPricing.known === false &&
      kPricing.envKeys?.inputMiss === 'AI_PRICE_INPUT_PER_M' &&
      String(kPricing.note ?? '').includes('AI_PRICE_INPUT_PER_M'),
    JSON.stringify(kPricing),
  );
  check(
    '金额：计价口径（单位 / 币种 / 出处 URL / 此刻档位）都在响应里',
    kPricing.unit === '元/百万 tokens' &&
      kPricing.currency === 'CNY' &&
      /^https:\/\//.test(String(kPricing.source)) &&
      typeof kPricing.peakNow === 'boolean',
    JSON.stringify(kPricing),
  );
  check(
    '金额：没配 key 的那台服务器（没调过模型）显示 0，且不谎报 missing',
    (usage.data?.site?.today?.tokens?.total ?? -1) === 0 &&
      (usage.data?.site?.today?.cost?.yuan ?? -1) === 0 &&
      (usage.data?.site?.today?.tokens?.missing ?? -1) === 0 &&
      (usage.data?.me?.today?.tokens?.total ?? -1) === 0 &&
      (usage.data?.me?.today?.cost?.yuan ?? -1) === 0,
    JSON.stringify({ site: usage.data?.site?.today?.tokens ?? null, me: usage.data?.me?.today?.tokens ?? null }),
  );

  /* ---------- 21c. 计价器（src/modules/ai/pricing.js）的纯函数 ---------- */
  //
  // 上面那节只证明「汇总后的数对得上」；价目表数值、别名、高峰时段的边界
  // （含时区换算）、上游 usage 的畸形值都只有在这一层才看得到。
  const flash = priceFor('deepseek-flash');
  check(
    '计价器：官方表里 deepseek-flash 是 2 / 0.04 / 8（未命中 / 命中 / 输出）',
    flash.known === true && flash.inputMiss === 2 && flash.inputHit === 0.04 && flash.output === 8,
    JSON.stringify(flash),
  );
  check(
    '计价器：官方表里 deepseek-v4-pro 是 9 / 0.3 / 27',
    AI_PRICE_TABLE['deepseek-v4-pro']?.inputMiss === 9 &&
      AI_PRICE_TABLE['deepseek-v4-pro']?.inputHit === 0.3 &&
      AI_PRICE_TABLE['deepseek-v4-pro']?.output === 27,
    JSON.stringify(AI_PRICE_TABLE['deepseek-v4-pro']),
  );
  check(
    '计价器：旧模型名（deepseek-v4-flash / -vision-exp）按 Flash 价算（官方脚注）',
    priceFor('deepseek-v4-flash').known === true &&
      priceFor('deepseek-v4-flash').inputMiss === 2 &&
      priceFor('deepseek-v4-flash-vision-exp').inputHit === 0.04 &&
      Object.values(AI_PRICE_ALIASES).every((target) => Boolean(AI_PRICE_TABLE[target])),
    JSON.stringify({ aliases: AI_PRICE_ALIASES, flash: priceFor('deepseek-v4-flash') }),
  );
  const unknownPrice = priceFor('some-other-model', {});
  check(
    '计价器：没登记的模型不猜价（三个价都是 0 且 known=false）',
    unknownPrice.known === false && unknownPrice.inputMiss === 0 && unknownPrice.inputHit === 0 && unknownPrice.output === 0,
    JSON.stringify(unknownPrice),
  );
  // 高峰 = 北京时间工作日 9:00–12:00、14:00–18:00；下面这些时刻的期望值是**手算**的：
  // 2026-10-05 是周一、10-09 是周五、10-10 是周六；UTC = 北京时间 − 8 小时。
  const PEAK_CASES = [
    ['2026-10-05T01:30:00Z', true, '周一 09:30（高峰）'],
    ['2026-10-05T00:59:00Z', false, '周一 08:59（还没到）'],
    ['2026-10-05T04:00:00Z', false, '周一 12:00（午休，不算高峰）'],
    ['2026-10-05T05:00:00Z', false, '周一 13:00（午休）'],
    ['2026-10-05T06:00:00Z', true, '周一 14:00（下午高峰起点）'],
    ['2026-10-05T09:59:00Z', true, '周一 17:59（高峰末尾）'],
    ['2026-10-05T10:00:00Z', false, '周一 18:00（已下班）'],
    ['2026-10-09T02:00:00Z', true, '周五 10:00（工作日高峰）'],
    ['2026-10-10T02:00:00Z', false, '周六 10:00（周末全天空闲）'],
  ];
  const peakWrong = PEAK_CASES.filter(([iso, want]) => isPeakHour(Date.parse(iso)) !== want);
  check(
    '计价器：高峰时段按北京时间算（工作日两段，周末不算），换算不看本机时区',
    peakWrong.length === 0,
    peakWrong.map(([iso, want, label]) => `${label} 期望 ${want} 实际 ${isPeakHour(Date.parse(iso))}`).join('；'),
  );
  check(
    '计价器：高峰价与空闲价正好差一半',
    AI_OFF_PEAK_FACTOR === 0.5 &&
      costOfUsage({ promptTokens: 1_000_000 }, { model: 'deepseek-flash', peak: true }).yuan === 2 &&
      costOfUsage({ promptTokens: 1_000_000 }, { model: 'deepseek-flash', peak: false }).yuan === 1,
    JSON.stringify([
      costOfUsage({ promptTokens: 1_000_000 }, { model: 'deepseek-flash', peak: true }),
      costOfUsage({ promptTokens: 1_000_000 }, { model: 'deepseek-flash', peak: false }),
    ]),
  );
  check(
    '计价器：命中与未命中分开计费（100 万全命中 = 0.04，全未命中 = 2）',
    costOfUsage({ promptTokens: 1_000_000, cachedTokens: 1_000_000 }, { model: 'deepseek-flash', peak: true }).yuan ===
      0.04 &&
      costOfUsage({ promptTokens: 1_000_000, cachedTokens: 0 }, { model: 'deepseek-flash', peak: true }).yuan === 2,
    JSON.stringify(costOfUsage({ promptTokens: 1_000_000, cachedTokens: 1_000_000 }, { model: 'deepseek-flash', peak: true })),
  );
  check(
    '计价器：输出按输出价（100 万 = 8 元），一次调用的完整算式 = 0.002816',
    costOfUsage({ completionTokens: 1_000_000 }, { model: 'deepseek-flash', peak: true }).yuan === 8 &&
      costOfUsage({ promptTokens: 1000, cachedTokens: 400, completionTokens: 200 }, { model: 'deepseek-flash', peak: true })
        .yuan === 0.002816,
    JSON.stringify(costOfUsage({ promptTokens: 1000, cachedTokens: 400, completionTokens: 200 }, { model: 'deepseek-flash', peak: true })),
  );
  check(
    '计价器：畸形 usage（负数 / 字符串 / 缺失）按 0 算，且绝不出现负钱',
    costOfUsage({ promptTokens: -100, cachedTokens: -1, completionTokens: 'abc' }, { model: 'deepseek-flash' }).yuan === 0 &&
      costOfUsage({}, { model: 'deepseek-flash' }).yuan === 0 &&
      costOfUsage({ promptTokens: 1000, cachedTokens: 999999 }, { model: 'deepseek-flash', peak: true }).yuan === 0.00004,
    JSON.stringify([
      costOfUsage({ promptTokens: -100, cachedTokens: -1, completionTokens: 'abc' }, { model: 'deepseek-flash' }),
      costOfUsage({ promptTokens: 1000, cachedTokens: 999999 }, { model: 'deepseek-flash', peak: true }),
    ]),
  );
  const shaped = shapeTokenUsage({ prompt_tokens: 1000, prompt_cache_hit_tokens: 400, completion_tokens: 200 });
  check(
    '计价器：上游 usage → 三个数（命中数超不过输入总数）',
    shaped.promptTokens === 1000 &&
      shaped.cachedTokens === 400 &&
      shaped.completionTokens === 200 &&
      shapeTokenUsage({ prompt_tokens: 100, prompt_cache_hit_tokens: 500 }).cachedTokens === 100 &&
      shapeTokenUsage({ prompt_tokens_details: { cached_tokens: 250 }, prompt_tokens: 1000 }).cachedTokens === 250 &&
      shapeTokenUsage(null).promptTokens === 0,
    JSON.stringify([shaped, shapeTokenUsage({ prompt_tokens: 100, prompt_cache_hit_tokens: 500 }), shapeTokenUsage(null)]),
  );
  const mixedSum = summarizeCost(
    [
      { peak: true, model: 'deepseek-flash', promptTokens: 1_000_000, cachedTokens: 0, completionTokens: 0, calls: 1, missing: 0 },
      { peak: false, model: 'deepseek-flash', promptTokens: 1_000_000, cachedTokens: 0, completionTokens: 0, calls: 1, missing: 1 },
      { peak: true, model: 'deepseek-v4-pro', promptTokens: 1_000_000, cachedTokens: 0, completionTokens: 0, calls: 1, missing: 0 },
    ],
    {},
  );
  check(
    '计价器：汇总按每行自己的模型与档位算（同表混模型也不会串价）',
    mixedSum.yuan === 12 && mixedSum.peakYuan === 11 && mixedSum.offPeakYuan === 1 && mixedSum.calls === 3 && mixedSum.missing === 1,
    JSON.stringify(mixedSum),
  );
  check(
    '计价器：面板上那句话在「有价 / 没价」两种情况下都说得清',
    priceNote(priceFor('deepseek-flash'), { peak: true }).includes('官方') &&
      priceNote(priceFor('deepseek-flash'), { peak: true }).includes('高峰') &&
      priceNote(priceFor('some-other-model', {}), { peak: false }).includes('AI_PRICE_OUTPUT_PER_M'),
    [
      priceNote(priceFor('deepseek-flash'), { peak: true }),
      priceNote(priceFor('some-other-model', {}), { peak: false }),
    ].join(' | '),
  );

  /* ---------- 22. 落盘契约：writeTo 与审计里的干净块 ---------- */
  //
  // `/ops` 自己**不改文档**（documents / document_blocks 归 P2），它只写审计，
  // 并把「该往哪写」告诉前端。所以 `writeTo` 是这条接口和后端文档模块之间
  // 唯一的接口约定，必须钉住它的真实形状（不是猜的）。
  const contractBefore = { type: 'paragraph', props: { text: '旧文案' } };
  const contractAfter = { type: 'poll', props: { question: '选哪个？', options: ['A', 'B'] } };
  // 从 doc 548 那次事故起，`/ops` 在写审计**之前**先过一遍形状纠正层（见第 29 节）：
  // 投票的字符串选项会被摆成 `{ id, text }`，并补上 `multiple`。审计里存的必须是
  // **真正会写进文档的那一份**（回滚交回的也是它），所以这里的期望值得是纠正后的形状；
  // 拿用户发来的原样去比，只会在纠正层生效时红 —— 而红的那两条恰恰是「它真的生效了」。
  const contractAfterStored = {
    type: 'poll',
    props: {
      question: '选哪个？',
      options: [
        { id: 'o1', text: 'A' },
        { id: 'o2', text: 'B' },
      ],
      multiple: false,
    },
  };
  const contract = await admin.call('/api/ai-edit/ops', {
    method: 'POST',
    body: { documentId: 'doc-9', blockId: 'block-9', before: contractBefore, after: contractAfter, reason: '落盘契约', confirm: true },
  });
  check('带 documentId / blockId 落盘成功', contract.status === 200 && contract.data?.applied === true, JSON.stringify(contract.data));
  check(
    'writeTo 明确指向 P2 的块写接口',
    contract.data?.writeTo === '/api/docs/doc-9/blocks/block-9',
    String(contract.data?.writeTo),
  );
  check(
    '返回里带上 documentId 与 blockId',
    contract.data?.documentId === 'doc-9' && contract.data?.blockId === 'block-9',
    JSON.stringify({ documentId: contract.data?.documentId, blockId: contract.data?.blockId }),
  );
  check('返回里的 targetType 是服务端写死的 document_block', contract.data?.targetType === 'document_block', String(contract.data?.targetType));
  check('返回里的 targetId 是 <documentId>:<blockId>', contract.data?.targetId === 'doc-9:block-9', String(contract.data?.targetId));

  // `writeTo` 里的 id 是 encodeURIComponent 过的（前端拿去 fetch 的是一整条路径），
  // 而返回里的 `documentId` / `blockId` 是**原样**的 —— 前端应该直接读这两个字段，
  // 不要去拆 targetId。空格 / 斜杠 / 非 ASCII 都要能编码。
  const encodedWrite = await admin.call('/api/ai-edit/ops', {
    method: 'POST',
    body: { documentId: 'doc 9/甲', blockId: 'b 7', after: contractAfter, confirm: true },
  });
  check(
    'writeTo 里的 id 经过 encodeURIComponent',
    encodedWrite.data?.writeTo === '/api/docs/doc%209%2F%E7%94%B2/blocks/b%207',
    String(encodedWrite.data?.writeTo),
  );
  check(
    '返回的 documentId / blockId 是原样的，没有被编码',
    encodedWrite.data?.documentId === 'doc 9/甲' && encodedWrite.data?.blockId === 'b 7',
    JSON.stringify({ documentId: encodedWrite.data?.documentId, blockId: encodedWrite.data?.blockId }),
  );
  check(
    'targetId 用的是原样的 id（按冒号拆得回来）',
    encodedWrite.data?.targetId === 'doc 9/甲:b 7',
    String(encodedWrite.data?.targetId),
  );

  const trimmedWrite = await admin.call('/api/ai-edit/ops', {
    method: 'POST',
    body: { documentId: '  doc-9  ', blockId: '  block-9  ', after: contractAfter, confirm: true },
  });
  check(
    'documentId / blockId 两端的空白会被 trim 掉',
    trimmedWrite.data?.documentId === 'doc-9' &&
      trimmedWrite.data?.blockId === 'block-9' &&
      trimmedWrite.data?.writeTo === '/api/docs/doc-9/blocks/block-9',
    JSON.stringify({
      documentId: trimmedWrite.data?.documentId,
      blockId: trimmedWrite.data?.blockId,
      writeTo: trimmedWrite.data?.writeTo,
    }),
  );

  const contractRow = (await admin.call('/api/ai-edit/ops?limit=100')).data?.ops?.find((row) => row.id === contract.data?.opId);
  check('审计里存着这条操作', Boolean(contractRow), JSON.stringify(contract.data?.opId));
  check(
    '审计里的 after 是纠正层摆正之后的 {type, props}（不再是发过去的原样）',
    sameJson(contractRow?.after, contractAfterStored),
    JSON.stringify(contractRow?.after),
  );
  check('审计里的 before 同理', sameJson(contractRow?.before, contractBefore), JSON.stringify(contractRow?.before));

  // 审计里的 before 会被 rollback 原样交回给 P2 写盘（restore），所以它必须是
  // **干净的** {type, props}：混进 blockType / content 这类旧形状的键，回滚时就等于
  // 往 P2 塞它不认识的东西。`/draft` 那条路径是清洗过再入库的，这里对齐它。
  const dirty = await admin.call('/api/ai-edit/ops', {
    method: 'POST',
    body: {
      documentId: 'doc-9',
      blockId: 'block-10',
      before: { type: 'paragraph', props: { text: '旧文案' }, blockType: 'text', content: { text: '旧文案' } },
      after: { type: 'poll', props: { question: '选哪个？', options: ['A', 'B'] }, blockType: 'vote', content: { options: ['A', 'B'] } },
      confirm: true,
    },
  });
  check('带旧形状多余键的补丁仍然能落盘（形状校验只看 type / props）', dirty.status === 200, `实际 ${dirty.status}`);
  const dirtyRow = (await admin.call('/api/ai-edit/ops?limit=100')).data?.ops?.find((row) => row.id === dirty.data?.opId);
  check(
    '审计里的 before / after 是剥掉多余键的干净 {type, props}',
    sameJson(dirtyRow?.after, contractAfterStored) && sameJson(dirtyRow?.before, contractBefore),
    `after=${JSON.stringify(dirtyRow?.after)} before=${JSON.stringify(dirtyRow?.before)}`,
  );

  // ── 新增粒度（2026-10）的哨兵 #1：`AI_MAX_SECTION_BLOCKS` 必须等于 P2 的 `MAX_OPS` ──
  //
  // 一小节的落盘走的是 P2 的 `POST /api/docs/:id/ops`，一批最多 `MAX_OPS` 条。AI 这边
  // `AI_MAX_SECTION_BLOCKS` 是从 ops.js 的 `MAX_OPS` **抄的一份**（骨架规范禁止 import
  // 隔壁模块的文件），抄来的会漂：P2 以后把一批上限改成 100，AI 这边还按 50 判
  // `tooLarge` / 400，用户就会看到「界面说这一节太大了」，而 P2 明明吃得下 —— 或者反过来，
  // 界面上是好的、落盘时被 P2 拒掉一半。
  //
  // 这里**既比源文本、又比运行时值**（照第 19 节那条 `AI_BLOCK_TYPE_NAMES` 哨兵的思路）：
  // 只比源文本的话，「字面量写着 50、导出时被 `Math.min(…, 10)` 改掉」这种派生漂移照样漏。
  const grabNumberLiteral = (src, name) => {
    const matched = src.match(new RegExp(`\\b${name}\\s*=\\s*(\\d+)`));
    return matched ? Number(matched[1]) : NaN;
  };
  const schemaSentinelMax = grabNumberLiteral(AI_SCHEMA_SRC, 'AI_MAX_SECTION_BLOCKS');
  const p2SentinelMaxOps = grabNumberLiteral(P2_OPS_SRC, 'MAX_OPS');

  check(
    '从 P2 的 blocks/ops.js 源文本抓到 MAX_OPS = 50',
    p2SentinelMaxOps === 50,
    String(p2SentinelMaxOps),
  );
  check(
    '从 AI 的 schema.js 源文本抓到 AI_MAX_SECTION_BLOCKS = 50',
    schemaSentinelMax === 50,
    String(schemaSentinelMax),
  );
  check(
    'AI_MAX_SECTION_BLOCKS 与 P2 的 MAX_OPS 是同一个数（一小节 = 一批 ops）',
    schemaSentinelMax === p2SentinelMaxOps,
    `AI=${schemaSentinelMax} P2=${p2SentinelMaxOps}`,
  );
  check(
    '运行时导出的 AI_MAX_SECTION_BLOCKS 也等于 50（派生 / 重新赋值那一步没被改坏）',
    AI_RUNTIME_MAX_SECTION_BLOCKS === 50,
    String(AI_RUNTIME_MAX_SECTION_BLOCKS),
  );
  check(
    '运行时导出的 AI_MAX_SECTION_BLOCKS 与 P2 的 MAX_OPS 源文本一致',
    AI_RUNTIME_MAX_SECTION_BLOCKS === p2SentinelMaxOps,
    `运行时=${AI_RUNTIME_MAX_SECTION_BLOCKS} P2=${p2SentinelMaxOps}`,
  );

  // ── 新增粒度哨兵 #2：切分函数必须**只有服务端那一份** ────────────────────
  //
  // `POST /api/ai-edit/sections` 的切分算法在 `src/modules/ai/sections.js`。前端拿这份
  // 清单渲染下拉、`draft-range` 拿同一份校验「你发来的块确实是这一节」—— 两边各切一份
  // 必然漂移，漂移的表现是「下拉里选的是第 3 节，实际改到别的块」。所以钉住 routes.js
  // 真的从 `./sections.js` import 了切分函数（有人把逻辑复制到前端 / 复制进 routes.js 就红）。
  const sectionsModuleSrc = readFileSync(join(ROOT, 'src', 'modules', 'ai', 'sections.js'), 'utf8');
  check(
    'src/modules/ai/sections.js 导出了 splitSections',
    /export function splitSections\s*\(/.test(sectionsModuleSrc),
    '切分函数不见了',
  );
  check(
    'AI routes.js 里从 ./sections.js import 了切分函数（切分逻辑只有服务端这一份）',
    /from\s+'\.\/sections\.js'/.test(aiRoutesSrc) && /\bsplitSections\b/.test(aiRoutesSrc),
    aiRoutesSrc.includes('./sections.js') ? 'import 在，但没用到 splitSections' : '没有 from \'./sections.js\' 这一行',
  );

  /* ---------- 23. 小节清单 POST /api/ai-edit/sections（纯切分，不调模型） ---------- */
  //
  // 前端的「改哪一节」下拉就用这份清单，所以这里钉的是**界面契约**：节的边界、每节的名字
  // （标题文字还是「开头」）、`level`、`tooLarge`。切分错一位，用户选中的就是别的块。
  const anonSections = await createClient().call('/api/ai-edit/sections', {
    method: 'POST',
    body: { blocks: [] },
  });
  check('未登录调小节清单返回 401（不是 404）', anonSections.status === 401, `实际 ${anonSections.status}`);
  check(
    '未登录的错误代号是 unauthenticated',
    anonSections.error?.code === 'unauthenticated',
    String(anonSections.error?.code),
  );

  const sectionPara = (id, text) => ({ blockId: id, type: 'paragraph', props: { text } });
  const sectionHeading = (id, text, level = 2) => ({ blockId: id, type: 'heading', props: { text, level } });

  // 无 heading：**整篇算一节**，这一节就是「开头」。
  const noHeading = await admin.call('/api/ai-edit/sections', {
    method: 'POST',
    body: { blocks: [sectionPara('p1', '一'), sectionPara('p2', '二')] },
  });
  check('没有小标题时清单返回 200', noHeading.status === 200, `实际 ${noHeading.status}`);
  check('没有小标题时整篇只有 1 节', noHeading.data?.count === 1, String(noHeading.data?.count));
  check('这 1 节的标题是「开头」那一节', noHeading.data?.sections?.[0]?.heading === noHeading.data?.opening, JSON.stringify(noHeading.data?.sections?.[0]));
  check('「开头」这一节的 blockId 是空串', noHeading.data?.sections?.[0]?.blockId === '', String(noHeading.data?.sections?.[0]?.blockId));
  check('「开头」这一节的 level 是 0', noHeading.data?.sections?.[0]?.level === 0, String(noHeading.data?.sections?.[0]?.level));
  check('opening 的字面量与文档一致', noHeading.data?.opening === '开头（第一个小标题之前）', String(noHeading.data?.opening));
  check('maxSectionBlocks 是 50', noHeading.data?.maxSectionBlocks === 50, String(noHeading.data?.maxSectionBlocks));
  check('total 是发过去的块数', noHeading.data?.total === 2, String(noHeading.data?.total));

  // 一个 heading 夹在中间：前面成「开头」，后面成它自己那一节，blockIds 顺序与文档一致。
  const middleHeading = await admin.call('/api/ai-edit/sections', {
    method: 'POST',
    body: { blocks: [sectionPara('m1', '甲'), sectionHeading('h1', '小标题'), sectionPara('m2', '乙')] },
  });
  check('一个标题夹在中间 → 2 节', middleHeading.data?.count === 2, String(middleHeading.data?.count));
  check(
    '第一块的 id 落在「开头」那一节里（不是标题节）',
    sameJson(middleHeading.data?.sections?.[0]?.blockIds, ['m1']),
    JSON.stringify(middleHeading.data?.sections?.[0]?.blockIds),
  );
  check(
    '标题节从标题块开始，到下一个标题之前结束',
    middleHeading.data?.sections?.[1]?.blockId === 'h1' &&
      sameJson(middleHeading.data?.sections?.[1]?.blockIds, ['h1', 'm2']),
    JSON.stringify(middleHeading.data?.sections?.[1]),
  );
  check('标题节的 heading 就是标题文字', middleHeading.data?.sections?.[1]?.heading === '小标题', String(middleHeading.data?.sections?.[1]?.heading));
  check('标题节的 level 取自 props.level', middleHeading.data?.sections?.[1]?.level === 2, String(middleHeading.data?.sections?.[1]?.level));
  check('blockCount 与 blockIds 的长度一致', middleHeading.data?.sections?.[1]?.blockCount === 2, String(middleHeading.data?.sections?.[1]?.blockCount));

  // 连续两个 heading：**空节不会出现** —— 切分的判据是「遇到 heading 就起新节」，
  // 所以前一个标题的节里只剩标题自己（blockCount 1），中间那个「第二块也是标题」
  // 的边界根本不会产生 0 块的节。这条顺手把「第一个块就是标题时没有『开头』节」也钉住。
  const emptySection = await admin.call('/api/ai-edit/sections', {
    method: 'POST',
    body: { blocks: [sectionHeading('e1', '第一节'), sectionHeading('e2', '第二节'), sectionPara('e3', '正文')] },
  });
  check('连续两个标题（第一块就是标题）→ 2 节', emptySection.data?.count === 2, String(emptySection.data?.count));
  check(
    '第一块就是标题时，没有「开头」这一节（blockId 空串的那节不存在）',
    !(emptySection.data?.sections ?? []).some((item) => item.blockId === ''),
    JSON.stringify(emptySection.data?.sections),
  );
  check(
    '前一个标题的节里只剩标题自己（blocks 为空时不产生 0 块节）',
    emptySection.data?.sections?.[0]?.blockId === 'e1' &&
      sameJson(emptySection.data?.sections?.[0]?.blockIds, ['e1']) &&
      emptySection.data?.sections?.[0]?.blockCount === 1,
    JSON.stringify(emptySection.data?.sections?.[0]),
  );
  check(
    '下一节从第二个标题开始，一直到结尾',
    emptySection.data?.sections?.[1]?.blockId === 'e2' &&
      sameJson(emptySection.data?.sections?.[1]?.blockIds, ['e2', 'e3']),
    JSON.stringify(emptySection.data?.sections?.[1]),
  );
  check(
    '没有 0 块的节（blockCount 最小是 1）',
    (emptySection.data?.sections ?? []).every((item) => item.blockCount >= 1),
    JSON.stringify((emptySection.data?.sections ?? []).map((item) => item.blockCount)),
  );
  check(
    '空节不会被标成 tooLarge',
    emptySection.data?.sections?.every((item) => item.tooLarge === false) === true,
    JSON.stringify(emptySection.data?.sections?.map((item) => item.tooLarge)),
  );
  check(
    'index 是从 0 开始的连续序号',
    sameJson((emptySection.data?.sections ?? []).map((item) => item.index), [0, 1]),
    JSON.stringify((emptySection.data?.sections ?? []).map((item) => item.index)),
  );

  // 标题文字超长：`SECTION_MAX_HEADING_CHARS = 80` 截断，免得下拉被一整段正文撑爆。
  const longHeadingText = '标'.repeat(100);
  const longHeading = await admin.call('/api/ai-edit/sections', {
    method: 'POST',
    body: { blocks: [sectionHeading('L1', longHeadingText)] },
  });
  const headingOut = String(longHeading.data?.sections?.[0]?.heading ?? '');
  check(
    '超长标题被截断到 80 字 + 省略号',
    headingOut.length === 81 && headingOut.endsWith('…') && headingOut.startsWith('标'.repeat(80)),
    `长度=${headingOut.length} 尾=${headingOut.slice(-3)}`,
  );
  check(
    '源码里的 SECTION_MAX_HEADING_CHARS 也是 80（截断长度不是别处来的）',
    Number((sectionsModuleSrc.match(/SECTION_MAX_HEADING_CHARS\s*=\s*(\d+)/) || [])[1]) === 80,
    String((sectionsModuleSrc.match(/SECTION_MAX_HEADING_CHARS\s*=\s*(\d+)/) || [])[1]),
  );

  // 51 块一节 → tooLarge:true（一节超过一批 ops 的上限，界面要禁用这个选项）。
  const bigSection = await admin.call('/api/ai-edit/sections', {
    method: 'POST',
    body: {
      blocks: [
        sectionHeading('big-h', '大节'),
        ...Array.from({ length: 50 }, (_, i) => sectionPara(`big-${i}`, 'x')),
      ],
    },
  });
  const bigOut = bigSection.data?.sections?.[0] ?? {};
  check('51 块一节：blockCount 是 51', bigOut.blockCount === 51, String(bigOut.blockCount));
  check('51 块一节被标成 tooLarge:true', bigOut.tooLarge === true, String(bigOut.tooLarge));
  check('but tooLarge 的判据是 blockCount > 50，不是 ≥', bigOut.blockCount - 1 === 50, String(bigOut.blockCount));

  // 50 块一节正好踩在线上：**不算** tooLarge。
  const exactSection = await admin.call('/api/ai-edit/sections', {
    method: 'POST',
    body: {
      blocks: [
        sectionHeading('exact-h', '刚好 50 块'),
        ...Array.from({ length: 49 }, (_, i) => sectionPara(`exact-${i}`, 'x')),
      ],
    },
  });
  check(
    '50 块一节不标 tooLarge（判的是「超过 50」）',
    exactSection.data?.sections?.[0]?.blockCount === 50 &&
      exactSection.data?.sections?.[0]?.tooLarge === false,
    JSON.stringify(exactSection.data?.sections?.[0]),
  );
  check(
    'chars 是这一节块 JSON 的字符数（大于 0）',
    Number(exactSection.data?.sections?.[0]?.chars) > 0,
    String(exactSection.data?.sections?.[0]?.chars),
  );

  // 入参上限：200 块可以（纯切分，不调模型，所以比一节宽），201 块 400。
  const twoHundred = await admin.call('/api/ai-edit/sections', {
    method: 'POST',
    body: { blocks: Array.from({ length: 200 }, (_, i) => sectionPara(`t-${i}`, 'x')) },
  });
  check('200 块可以（切分输入上限）', twoHundred.status === 200, `实际 ${twoHundred.status}`);
  check('200 块仍然只有「开头」一节', twoHundred.data?.count === 1, String(twoHundred.data?.count));
  const twoOhOne = await admin.call('/api/ai-edit/sections', {
    method: 'POST',
    body: { blocks: Array.from({ length: 201 }, (_, i) => sectionPara(`t-${i}`, 'x')) },
  });
  check('201 块 → 400', twoOhOne.status === 400, `实际 ${twoOhOne.status}`);
  check('201 块的错误代号是 bad_request', twoOhOne.error?.code === 'bad_request', String(twoOhOne.error?.code));
  check('运行时导出的 AI_MAX_SECTION_INPUT 就是 200', AI_RUNTIME_MAX_SECTION_INPUT === 200, String(AI_RUNTIME_MAX_SECTION_INPUT));

  const notArray = await admin.call('/api/ai-edit/sections', { method: 'POST', body: { blocks: '不是数组' } });
  check('blocks 不是数组 → 400', notArray.status === 400, `实际 ${notArray.status}`);
  check('非数组的错误代号是 bad_request', notArray.error?.code === 'bad_request', String(notArray.error?.code));
  const noBlocks = await admin.call('/api/ai-edit/sections', { method: 'POST', body: {} });
  check('缺 blocks → 400（不是 500）', noBlocks.status === 400, `实际 ${noBlocks.status}`);
  const nullBody = await admin.call('/api/ai-edit/sections', { method: 'POST', body: null });
  check('根本没带请求体 → 400（不是 500）', nullBody.status === 400, `实际 ${nullBody.status}`);
  check('空数组本身是合法的（下游自己判「没有块」）', (await admin.call('/api/ai-edit/sections', { method: 'POST', body: { blocks: [] } })).status === 200);

  // 权限边界：`/sections` 只是**切分**，不花模型的钱，所以守卫是 `viewer`（登录即可），
  // 不是 `guardCapability`；而真正改稿的 `draft-range` 必须拿到 `edit_content`。
  // 这两条钉住这个不对称 —— 哪天有人给切分也套上能力门，或把改稿的能力门摘掉，都会红。
  // carol 在这台服务器上没有任何 AI 授权。
  const carolPlain = createClient();
  const carolPlainLogin = await carolPlain.call('/api/auth/login', { method: 'POST', body: { username: 'carol', password: 'demo1234' } });
  check('carol 登录成功（用她来验这两条权限边界）', carolPlainLogin.status === 200, JSON.stringify(carolPlainLogin.error ?? null));
  const carolSections = await carolPlain.call('/api/ai-edit/sections', {
    method: 'POST',
    body: { blocks: [{ blockId: 'c1', type: 'heading', props: { text: '标题' } }] },
  });
  check(
    '没有 edit_content 的用户也能调 /sections（只切分、不花模型的钱）',
    carolSections.status === 200,
    `实际 ${carolSections.status} ${carolSections.error?.code ?? ''}`,
  );
  const carolDraftRange = await carolPlain.call('/api/ai-edit/draft-range', {
    method: 'POST',
    body: {
      scope: 'section',
      documentId: 'doc-range',
      blocks: [{ blockId: 'c1', type: 'paragraph', props: { text: 'x' } }],
      instruction: '改一下',
    },
  });
  check('没有 edit_content 的用户调 draft-range 是 403（不是 400 / 503）', carolDraftRange.status === 403, `实际 ${carolDraftRange.status} ${carolDraftRange.error?.code ?? ''}`);
  check('权限拒绝的代号是 forbidden', carolDraftRange.error?.code === 'forbidden', String(carolDraftRange.error?.code));
  const carolOps = await carolPlain.call('/api/ai-edit/ops', { method: 'POST', body: { documentId: 'doc-range', after: BLOCK_AFTER, confirm: true } });
  check('没有 edit_content 的用户落盘 /ops 也是 403', carolOps.status === 403, `实际 ${carolOps.status} ${carolOps.error?.code ?? ''}`);

  /* ---------- 24. POST /api/ai-edit/draft-range 的参数矩阵（没配模型的那台服务器） ---------- */
  //
  // 这一节跑在**故意不配 key** 的主服务器上：凡是参数合法的请求都该撞上 503
  // `ai_not_configured`（+ 一条 blocked 审计），凡是参数不对的都该在调模型**之前** 400。
  // 两条分界线正是这节要钉的：校验排在配置门 / 限流之前。
  //
  // 为了不把第 11 节那批 blocked 审计和新加的混起来，这里用**操作 id 差集**取新行
  // （同一张表里 `reason='ai_not_configured'`、action='draft' 的行已经有好几条了）。
  const listOps = async (client) => (await client.call('/api/ai-edit/ops?limit=100')).data?.ops ?? [];
  const beforeList = await listOps(admin);
  const beforeIds = new Set(beforeList.map((row) => row.id));

  const rangeSectionBody = (extra = {}) => ({
    scope: 'section',
    documentId: 'doc-range',
    heading: '演示小节',
    blocks: [sectionPara('rs1', '甲'), sectionPara('rs2', '乙')],
    instruction: '把这两块改得短一点',
    ...extra,
  });

  const rangeAnon = await createClient().call('/api/ai-edit/draft-range', {
    method: 'POST',
    body: { scope: 'section', documentId: 'doc-range', blocks: [sectionPara('a1', 'x')], instruction: '改一下' },
  });
  check('未登录调 draft-range 返回 401（不是 404）', rangeAnon.status === 401, `实际 ${rangeAnon.status}`);
  check('未登录的错误代号是 unauthenticated', rangeAnon.error?.code === 'unauthenticated', String(rangeAnon.error?.code));

  const rangeNoModel = await admin.call('/api/ai-edit/draft-range', { method: 'POST', body: rangeSectionBody() });
  check('没配模型时 draft-range（section）返回 503', rangeNoModel.status === 503, `实际 ${rangeNoModel.status}`);
  check('错误代号是 ai_not_configured', rangeNoModel.error?.code === 'ai_not_configured', String(rangeNoModel.error?.code));
  const rangeNoModelDoc = await admin.call('/api/ai-edit/draft-range', {
    method: 'POST',
    body: { scope: 'document', documentId: 'doc-range', markdown: '# 标题', instruction: '改一下' },
  });
  check('没配模型时 draft-range（document）也是 503', rangeNoModelDoc.status === 503, `实际 ${rangeNoModelDoc.status}`);

  const rangeUsedBefore = await editContentUsed(admin);
  for (let i = 0; i < 3; i += 1) {
    await admin.call('/api/ai-edit/draft-range', { method: 'POST', body: rangeSectionBody() });
  }
  const rangeUsedAfter = await editContentUsed(admin);
  check(
    'draft-range 的 503 不扣每日用量',
    rangeUsedAfter === rangeUsedBefore,
    `${rangeUsedBefore} → ${rangeUsedAfter}`,
  );
  // 503 是「配置门」，它排在参数校验**之后**：形状不对的请求还是该拿到 400，
  // 而不是被配置门拦成 503 让人以为「服务器没配好 key」。
  const rangeSectionNoBlocks = await admin.call('/api/ai-edit/draft-range', {
    method: 'POST',
    body: { scope: 'section', documentId: 'doc-range', instruction: '改一下' },
  });
  check('没配模型时，参数错的 draft-range 仍然先拿到 400（不是 503）', rangeSectionNoBlocks.status === 400, `实际 ${rangeSectionNoBlocks.status}`);
  const rangeDocEmpty = await admin.call('/api/ai-edit/draft-range', {
    method: 'POST',
    body: { scope: 'document', documentId: 'doc-range', markdown: '  ', instruction: '改一下' },
  });
  check('整篇 markdown 为空时也是 400（不是 503）', rangeDocEmpty.status === 400, `实际 ${rangeDocEmpty.status}`);

  const afterList = await listOps(admin);
  // 这一段总共新增 5 条：section 类 4 条（提交那次 + 循环 3 次）+ document 类 1 条。
  // 先按 id 差集取全部新行，再把 section 那 4 条挑出来（document 那条单独核）。
  const rangeBlockedNew = afterList.filter((row) => !beforeIds.has(row.id));
  const rangeBlocked = rangeBlockedNew.filter((row) => row.targetId === 'doc-range:rs1~rs2');
  check('四次 draft-range（section）都留下了 blocked 审计', rangeBlocked.length === 4, `section 新行=${rangeBlocked.length}，全部新行=${rangeBlockedNew.length}`);
  check(
    'section 类的 blocked 审计 targetType 记成 doc_section',
    rangeBlocked.length === 4 && rangeBlocked.every((row) => row.targetType === 'doc_section'),
    JSON.stringify(rangeBlocked.map((row) => row.targetType)),
  );
  check(
    'section 类的 blocked 审计 targetId 是 <documentId>:<首块>~<末块>',
    rangeBlocked.length === 4 && rangeBlocked.every((row) => row.targetId === 'doc-range:rs1~rs2'),
    JSON.stringify(rangeBlocked.map((row) => row.targetId)),
  );
  check(
    'blocked 审计的 reason 是 ai_not_configured',
    rangeBlocked.length === 4 && rangeBlocked.every((row) => row.reason === 'ai_not_configured'),
    JSON.stringify(rangeBlocked.map((row) => row.reason)),
  );
  check(
    '这一段新增的审计只有 5 条（没有多记也没有漏记）',
    rangeBlockedNew.length === 5,
    JSON.stringify(rangeBlockedNew.map((row) => [row.targetType, row.targetId, row.reason])),
  );
  const rangeBlockedDoc = rangeBlockedNew.find((row) => row.targetId === 'doc-range:*');
  check('document 类的 blocked 审计 targetType 记成 document', rangeBlockedDoc?.targetType === 'document', JSON.stringify(rangeBlockedDoc?.targetType));
  check(
    'document 类的 blocked 审计 targetId 是 <documentId>:*',
    rangeBlockedDoc?.targetId === 'doc-range:*',
    String(rangeBlockedDoc?.targetId),
  );
  check(
    'document 类的 blocked 审计也是 ai_not_configured',
    rangeBlockedDoc?.reason === 'ai_not_configured' && rangeBlockedDoc?.status === 'blocked',
    JSON.stringify({ reason: rangeBlockedDoc?.reason, status: rangeBlockedDoc?.status }),
  );

  // 参数矩阵：全部 400 `bad_request`。这批请求**一次模型都不会发出去**。
  const rangeBadBodies = [
    ['scope 不是 section/document', rangeSectionBody({ scope: 'paragraph' })],
    ['缺 scope', { documentId: 'doc-range', blocks: [sectionPara('x1', 'x')], instruction: '改一下' }],
    ['scope 是空串', rangeSectionBody({ scope: '' })],
    ['缺 documentId', { scope: 'section', blocks: [sectionPara('x1', 'x')], instruction: '改一下' }],
    ['documentId 是空串', rangeSectionBody({ documentId: '' })],
    ['documentId 含冒号', rangeSectionBody({ documentId: 'doc:1' })],
    ['documentId 只有空白', rangeSectionBody({ documentId: '   ' })],
    ['缺 instruction', rangeSectionBody({ instruction: undefined })],
    ['instruction 是空串', rangeSectionBody({ instruction: '' })],
    ['instruction 只有空白', rangeSectionBody({ instruction: '   ' })],
    ['instruction 超过 2000 字', rangeSectionBody({ instruction: '改'.repeat(2001) })],
    ['section 缺 blocks', rangeSectionBody({ blocks: undefined })],
    ['section 的 blocks 是空数组', rangeSectionBody({ blocks: [] })],
    ['section 的 blocks 有 51 块', rangeSectionBody({ blocks: Array.from({ length: 51 }, (_, i) => sectionPara(`x-${i}`, 'x')) })],
    ['section 的块缺 blockId', rangeSectionBody({ blocks: [{ type: 'paragraph', props: { text: 'x' } }] })],
    ['section 的块 blockId 是空串', rangeSectionBody({ blocks: [sectionPara('', 'x')] })],
    ['section 的块 blockId 含冒号', rangeSectionBody({ blocks: [sectionPara('a:1', 'x')] })],
    ['section 的块 blockId 超过 64 字符', rangeSectionBody({ blocks: [sectionPara('z'.repeat(65), 'x')] })],
    ['section 的块 blockId 重复', rangeSectionBody({ blocks: [sectionPara('dup', '甲'), sectionPara('dup', '乙')] })],
    ['section 的块缺 type', rangeSectionBody({ blocks: [{ blockId: 'a1', props: { text: 'x' } }] })],
    ['section 的块 type 不在白名单', rangeSectionBody({ blocks: [{ blockId: 'a1', type: 'vote', props: {} }] })],
    ['section 的块缺 props', rangeSectionBody({ blocks: [{ blockId: 'a1', type: 'paragraph' }] })],
    ['section 整体超过 40000 字符', rangeSectionBody({ blocks: [sectionPara('big', 'x'.repeat(60000))] })],
    ['document 的 markdown 为空', { scope: 'document', documentId: 'doc-range', markdown: '', instruction: '改一下' }],
    ['document 缺 markdown', { scope: 'document', documentId: 'doc-range', instruction: '改一下' }],
    ['document 的 markdown 超过 40000 字', { scope: 'document', documentId: 'doc-range', markdown: 'x'.repeat(40001), instruction: '改一下' }],
  ];
  const rangeBadResults = [];
  for (const [label, body] of rangeBadBodies) {
    const result = await admin.call('/api/ai-edit/draft-range', { method: 'POST', body });
    rangeBadResults.push({ label, status: result.status, code: result.error?.code });
  }
  const not400 = rangeBadResults.filter((item) => item.status !== 400);
  check(
    `参数矩阵里 ${rangeBadBodies.length} 种坏请求全部 400`,
    not400.length === 0,
    JSON.stringify(not400),
  );
  check(
    '参数矩阵里每一条的错误代号都是 bad_request',
    rangeBadResults.every((item) => item.code === 'bad_request'),
    JSON.stringify(rangeBadResults.filter((item) => item.code !== 'bad_request')),
  );

  // 限流排在校验之后：上面已经连发了 27 次坏请求，全都该是 400 而不是 429
  // （限流桶是 5 次/分钟；要是它在校验之前，第一批之后就会开始吐 429）。
  check(
    '连发坏请求不会被记进限流额度（没有一条 429）',
    !rangeBadResults.some((item) => item.status === 429),
    JSON.stringify(rangeBadResults.filter((item) => item.status === 429 || item.status === 503)),
  );
  check('运行时导出的 AI_MAX_RANGE_CHARS 就是 40000', AI_RUNTIME_MAX_RANGE_CHARS === 40000, String(AI_RUNTIME_MAX_RANGE_CHARS));
  check('运行时导出的 AI_SCOPES 就是 section/document', sameJson(AI_RUNTIME_SCOPES, ['section', 'document']), JSON.stringify(AI_RUNTIME_SCOPES));
  check(
    '运行时导出的 AI_RANGE_TARGET_TYPES 两个目标名',
    AI_RUNTIME_RANGE_TARGET_TYPES?.section === 'doc_section' && AI_RUNTIME_RANGE_TARGET_TYPES?.document === 'document',
    JSON.stringify(AI_RUNTIME_RANGE_TARGET_TYPES),
  );

  /* ---------- 25. 真打模型：section / document 成功路径 + 每一条失败路径 ---------- */
  //
  // 跑在第 18 节那台**配了 key** 的服务器（`stub-key` + 本地假模型）上。
  // 限流是 5 次/分钟且只按用户算，所以这一节要数着来：**每一条打得到 callModel 的**
  // 请求都占一格额度（`okDraft` 已经用掉 1 格）。坏 JSON / 上游 4xx / 超时那几条
  // 在 `callModel` 里就返回了，不占（它们是「发得出去但没成功」的调用）。
  const keyedBody = async (ops, id) => (await ops).find((row) => row.id === id) ?? null;

  modelMode = 'section-echo';
  const keyedSection = [{ blockId: 'sec-1', type: 'heading', props: { text: '演示小节', level: 2 } }, { blockId: 'sec-2', type: 'paragraph', props: { text: '甲' } }];
  const sectionDraft = await keyedAdmin.call('/api/ai-edit/draft-range', {
    method: 'POST',
    body: { scope: 'section', documentId: 'doc-range', heading: '演示小节', blocks: keyedSection, instruction: '把这一节改得短一点' },
  });
  check(
    '按小节草拟成功（200，且只是预览）',
    sectionDraft.status === 200 && sectionDraft.data?.applied === false,
    `${sectionDraft.status} ${JSON.stringify(sectionDraft.error ?? null)}`,
  );
  check('按小节返回的 scope 是 section', sectionDraft.data?.scope === 'section', String(sectionDraft.data?.scope));
  check('按小节返回的 targetType 是 doc_section', sectionDraft.data?.targetType === 'doc_section', String(sectionDraft.data?.targetType));
  check(
    'patch.blocks 是数组，且每个 blockId 都属于我发过去的这一节',
    Array.isArray(sectionDraft.data?.patch?.blocks) &&
      sectionDraft.data.patch.blocks.length > 0 &&
      sectionDraft.data.patch.blocks.every((item) => ['sec-1', 'sec-2'].includes(item.blockId)),
    JSON.stringify(sectionDraft.data?.patch),
  );
  check(
    'patch.blocks 整节收了回来（2 块），不是只回改动的那一块',
    sectionDraft.data?.patch?.blocks?.length === 2,
    JSON.stringify(sectionDraft.data?.patch?.blocks),
  );
  check(
    'changedCount 数的是「真的改了的块」而不是模型返回的块数（改 1 块、回 2 块 → 1）',
    sectionDraft.data?.changedCount === 1,
    `${sectionDraft.data?.changedCount} / patch.blocks=${sectionDraft.data?.patch?.blocks?.length}`,
  );
  check(
    'before 是原整节块数组（原样回带）',
    sameJson(sectionDraft.data?.before, keyedSection),
    JSON.stringify(sectionDraft.data?.before),
  );
  check(
    'section 的 writeTo 指向 P2 的 ops 接口',
    sectionDraft.data?.writeTo === '/api/docs/doc-range/ops',
    String(sectionDraft.data?.writeTo),
  );
  check('section 的 targetId 是 <documentId>:<首块>~<末块>', sectionDraft.data?.targetId === 'doc-range:sec-1~sec-2', String(sectionDraft.data?.targetId));
  check('draft-range 的 opId 是整数', Number.isInteger(sectionDraft.data?.opId), String(sectionDraft.data?.opId));
  check('draft-range 回填了 model', sectionDraft.data?.model === 'stub-model', String(sectionDraft.data?.model));
  check(
    '带 ```json 围栏的一节应答也能解析（改过的第一块带上了「已改：」）',
    String(sectionDraft.data?.patch?.blocks?.[0]?.props?.text ?? '').includes('已改：'),
    JSON.stringify(sectionDraft.data?.patch?.blocks?.[0]),
  );
  check(
    '一字未动的第二块原样带回（改的是 props，不是块的身份）',
    sectionDraft.data?.patch?.blocks?.[1]?.blockId === 'sec-2' &&
      sectionDraft.data?.patch?.blocks?.[1]?.props?.text === '甲',
    JSON.stringify(sectionDraft.data?.patch?.blocks?.[1]),
  );

  // ——— 提示词 / 请求体契约（这一节顺手把「模型到底收到了什么」也钉住）
  check('请求体带上了配置的 model', lastRequestBody?.model === 'stub-model', String(lastRequestBody?.model));
  check('带上了 Authorization: Bearer <key>', lastAuth === 'Bearer stub-key', lastAuth);
  check(
    'section 的 system 提示词要求只输出一个 JSON 对象',
    String(lastRequestBody?.messages?.[0]?.content ?? '').includes('JSON'),
    String(lastRequestBody?.messages?.[0]?.content ?? '').slice(0, 120),
  );
  check(
    'section 的 system 提示词教的是 {blocks:[{blockId,…}]} 形状',
    String(lastRequestBody?.messages?.[0]?.content ?? '').includes('"blocks"') &&
      String(lastRequestBody?.messages?.[0]?.content ?? '').includes('blockId'),
    String(lastRequestBody?.messages?.[0]?.content ?? '').slice(0, 200),
  );
  check(
    'section 的 user 消息里带着这一节的块（含 blockId）',
    String(lastRequestBody?.messages?.[1]?.content ?? '').includes('sec-2') &&
      String(lastRequestBody?.messages?.[1]?.content ?? '').includes('"blockId"'),
    String(lastRequestBody?.messages?.[1]?.content ?? '').slice(0, 200),
  );
  check(
    'section 的 user 消息里带着小标题与改写要求',
    String(lastRequestBody?.messages?.[1]?.content ?? '').includes('演示小节') &&
      String(lastRequestBody?.messages?.[1]?.content ?? '').includes('把这一节改得短一点'),
    String(lastRequestBody?.messages?.[1]?.content ?? '').slice(0, 200),
  );

  const sectionDraftRow = await keyedBody(keyedAdmin.call('/api/ai-edit/ops?limit=100').then((r) => r.data?.ops ?? []), sectionDraft.data?.opId);
  check('成功草拟后能在审计里查到这一条', Boolean(sectionDraftRow), String(sectionDraft.data?.opId));
  check('审计里的 action 是 draft', sectionDraftRow?.action === 'draft', String(sectionDraftRow?.action));
  check('审计里的 status 是 preview（草拟不落盘）', sectionDraftRow?.status === 'preview', String(sectionDraftRow?.status));
  check(
    '审计里的 before 是块数组（一节）',
    Array.isArray(sectionDraftRow?.before),
    JSON.stringify(sectionDraftRow?.before),
  );
  check(
    '审计里的 targetType 是 doc_section',
    sectionDraftRow?.targetType === 'doc_section',
    String(sectionDraftRow?.targetType),
  );
  // 新契约：`patch.markdown` 是给界面渲染预览用的（界面不渲染块 JSON）。
  // 缺了它前端就只能退回「把块 JSON 铺在 <pre> 里」，那正是这次要改掉的东西。
  check(
    'patch.markdown 是非空字符串（给预览渲染用，不只是 blocks）',
    typeof sectionDraft.data?.patch?.markdown === 'string' && sectionDraft.data.patch.markdown.trim() !== '',
    typeof sectionDraft.data?.patch?.markdown === 'string'
      ? `长度=${sectionDraft.data.patch.markdown.length}`
      : JSON.stringify(sectionDraft.data?.patch ?? null),
  );

  // ——— 整篇：成功路径
  modelMode = 'document-ok';
  const documentDraft = await keyedAdmin.call('/api/ai-edit/draft-range', {
    method: 'POST',
    body: { scope: 'document', documentId: 'doc-range', markdown: '# 原稿\n\n正文。', title: '原稿', instruction: '把整篇改一下' },
  });
  check(
    '整篇草拟成功（200，且只是预览）',
    documentDraft.status === 200 && documentDraft.data?.applied === false,
    `${documentDraft.status} ${JSON.stringify(documentDraft.error ?? null)}`,
  );
  check('整篇返回的 scope 是 document', documentDraft.data?.scope === 'document', String(documentDraft.data?.scope));
  check('整篇返回的 targetType 是 document', documentDraft.data?.targetType === 'document', String(documentDraft.data?.targetType));
  check(
    '整篇的 patch.markdown 是字符串',
    typeof documentDraft.data?.patch?.markdown === 'string' && documentDraft.data.patch.markdown.length > 0,
    JSON.stringify(documentDraft.data?.patch),
  );
  check(
    '整篇的 before 是 { markdown, title }',
    documentDraft.data?.before?.markdown === '# 原稿\n\n正文。' && documentDraft.data?.before?.title === '原稿',
    JSON.stringify(documentDraft.data?.before),
  );
  check(
    '整篇的 writeTo 指向 P2 的 markdown 接口',
    documentDraft.data?.writeTo === '/api/docs/doc-range/markdown',
    String(documentDraft.data?.writeTo),
  );
  check('整篇的 targetId 是 <documentId>:*', documentDraft.data?.targetId === 'doc-range:*', String(documentDraft.data?.targetId));
  check(
    '整篇的 system 提示词要的是 {"markdown":…}',
    String(lastRequestBody?.messages?.[0]?.content ?? '').includes('"markdown"'),
    String(lastRequestBody?.messages?.[0]?.content ?? '').slice(0, 160),
  );
  check(
    '整篇的 user 消息里带着当前 Markdown 与改写要求',
    String(lastRequestBody?.messages?.[1]?.content ?? '').includes('# 原稿') &&
      String(lastRequestBody?.messages?.[1]?.content ?? '').includes('把整篇改一下'),
    String(lastRequestBody?.messages?.[1]?.content ?? '').slice(0, 160),
  );
  const documentDraftRow = await keyedBody(
    keyedAdmin.call('/api/ai-edit/ops?limit=100').then((r) => r.data?.ops ?? []),
    documentDraft.data?.opId,
  );
  check(
    '整篇成功草拟也留一条 preview 审计，before 是 {markdown}',
    documentDraftRow?.status === 'preview' &&
      documentDraftRow?.targetType === 'document' &&
      typeof documentDraftRow?.before?.markdown === 'string',
    JSON.stringify(documentDraftRow),
  );

  // ——— 整篇的第二种合法形状：模型直接「点一个站内模板」（修复 3b）
  //
  // 借 reviewer 的桶：`ai-edit:draft-range:<userId>` 是 5 格/分钟，admin 那 5 格已经被
  // 上面 section/document 的用例占满，再来一次只会拿到 429 —— 那种红看起来像服务端坏了。
  modelMode = 'document-template';
  const templateDraft = await keyedReviewer.call('/api/ai-edit/draft-range', {
    method: 'POST',
    body: { scope: 'document', documentId: 'doc-range', markdown: '# 原稿', instruction: '改成投票问卷的样子' },
  });
  check(
    '整篇可以只回一个 template（200，而且依然只是预览）',
    templateDraft.status === 200 && templateDraft.data?.applied === false,
    `${templateDraft.status} ${JSON.stringify(templateDraft.error ?? null)}`,
  );
  check(
    'template 被原样透传（poll）',
    templateDraft.data?.patch?.template === 'poll',
    JSON.stringify(templateDraft.data?.patch ?? null),
  );
  check(
    'template 形态不带 markdown（二选一，别给界面两套互相打架的解释）',
    templateDraft.data?.patch?.markdown === undefined,
    JSON.stringify(templateDraft.data?.patch ?? null),
  );
  check(
    'writeTo 指向 P2 的 apply-template（不是 markdown）',
    templateDraft.data?.writeTo === '/api/docs/doc-range/apply-template',
    String(templateDraft.data?.writeTo),
  );
  check(
    'hint 说清了落盘走 apply-template',
    String(templateDraft.data?.hint ?? '').includes('apply-template'),
    String(templateDraft.data?.hint ?? ''),
  );
  check(
    '整篇的 system 提示词交出了模板菜单（8 个 key 都在）',
    ['blank', 'station', 'page', 'academic', 'wiki', 'poll', 'datatable', 'lab'].every((key) =>
      String(lastRequestBody?.messages?.[0]?.content ?? '').includes(key),
    ),
    String(lastRequestBody?.messages?.[0]?.content ?? '').slice(0, 200),
  );
  check(
    '整篇的 system 提示词明说 template 与 markdown 只能二选一',
    String(lastRequestBody?.messages?.[0]?.content ?? '').includes('二选一'),
    '',
  );

  modelMode = 'document-template-bogus';
  const bogusTemplate = await keyedReviewer.call('/api/ai-edit/draft-range', {
    method: 'POST',
    body: { scope: 'document', documentId: 'doc-range', markdown: '# 原稿', instruction: '随便套一个模板' },
  });
  check(
    '模型编出站里没有的模板 key → 502 ai_bad_json（不许当成「新模板」用）',
    bogusTemplate.status === 502 && bogusTemplate.error?.code === 'ai_bad_json',
    `${bogusTemplate.status} ${bogusTemplate.error?.code}`,
  );

  modelMode = 'ok';

  // ——— 模型跑偏的几条：blockId 不属于这一节 / 缺 type / markdown 形状不对 / 整篇吐成 {blocks}
  //
  // **限流是按用户算的**（`ai-edit:draft-range:<userId>`，5 次 / 60 秒），而「打到了
  // callModel」的调用哪怕最后 502 也照样占一格（实测：连发 5 次都过、第 6 次 429）。
  // 这一节要验的路径比 5 条多，所以按用户拆成三个桶：admin / alice / bob 各 5 格。
  // 不拆的话，后面的路径会被限流器挡成 429 —— 那报错看起来像「服务端坏了」，其实只是
  // 测试自己把额度用光了（上一版就是这么红的）。
  const keyedRangeBody = (extra = {}) => ({
    scope: 'section',
    documentId: 'doc-range',
    blocks: [{ blockId: 'sec-9', type: 'paragraph', props: { text: '原文' } }],
    instruction: '改一下',
    ...extra,
  });

  const keyedAlice = createClient(KEYED_BASE);
  const keyedBob = createClient(KEYED_BASE);
  for (const [label, client, username] of [
    ['alice', keyedAlice, 'alice'],
    ['bob', keyedBob, 'bob'],
  ]) {
    const login = await client.call('/api/auth/login', {
      method: 'POST',
      body: { username, password: 'demo1234' },
    });
    check(`第三台（keyed）服务器上 ${label} 也能登录`, login.status === 200, JSON.stringify(login.error ?? null));
    await client.call('/api/ai-edit/grants', {
      method: 'POST',
      body: { capability: 'edit_content', confirm: true, dailyQuota: 0 },
    });
  }

  // admin 桶：section-echo（1）+ document-ok（1）+ document-badshape（1）+ 下面两条形状错误（2）= 5 格，正好用满。
  modelMode = 'document-badshape';
  const badShapeDoc = await keyedAdmin.call('/api/ai-edit/draft-range', {
    method: 'POST',
    body: { scope: 'document', documentId: 'doc-range', markdown: '# 原稿', instruction: '改一下' },
  });
  check(
    '整篇模式里模型吐回 {blocks:[…]} → 502 ai_bad_json',
    badShapeDoc.status === 502 && badShapeDoc.error?.code === 'ai_bad_json',
    `${badShapeDoc.status} ${badShapeDoc.error?.code}`,
  );

  modelMode = 'section-badid';
  const badIdRange = await keyedAdmin.call('/api/ai-edit/draft-range', { method: 'POST', body: keyedRangeBody() });
  check(
    '模型返回的 blockId 不在这一节里 → 502 ai_bad_json（不许放行模型编的 id）',
    badIdRange.status === 502 && badIdRange.error?.code === 'ai_bad_json',
    `${badIdRange.status} ${badIdRange.error?.code}`,
  );

  modelMode = 'section-badshape';
  const badShapeRange = await keyedAdmin.call('/api/ai-edit/draft-range', { method: 'POST', body: keyedRangeBody() });
  check(
    '模型返回的块缺 type → 502 ai_bad_json',
    badShapeRange.status === 502 && badShapeRange.error?.code === 'ai_bad_json',
    `${badShapeRange.status} ${badShapeRange.error?.code}`,
  );

  // 新契约：patch 里除了 blocks 还要有 `markdown`（只用来渲染预览）。
  // 缺失 / 空串 / 不是字符串 / 超长，与「blocks 形状不对」同一类 → 502 ai_bad_json + blocked 审计。
  // alice 桶：这四条占 4 格。
  const badMarkdownCases = [
    ['section-no-markdown', '缺 markdown'],
    ['section-empty-markdown', 'markdown 是空串'],
    ['section-nonstring-markdown', 'markdown 不是字符串'],
    ['section-huge-markdown', 'markdown 超过 40000 字'],
  ];
  for (const [mode, label] of badMarkdownCases) {
    modelMode = mode;
    const result = await keyedAlice.call('/api/ai-edit/draft-range', { method: 'POST', body: keyedRangeBody() });
    check(
      `模型返回的 ${label} → 502 ai_bad_json`,
      result.status === 502 && result.error?.code === 'ai_bad_json',
      `${result.status} ${result.error?.code}`,
    );
  }

  // ——— 「一节必须整节收齐」：模型少吐一块 → 502。
  //
  // 落盘走 `POST /api/docs/:id/ops`，那一步要求 before/after 的块 id **一一对应**；
  // 这里放过就成了「草拟能成、点落盘 400」，用户拿到的是个半成品。所以必须在草拟这步挡住。
  // 归 alice 桶（她前面用了 4 格，这是第 5 格）。
  modelMode = 'section-missing-block';
  const missingBlockRange = await keyedAlice.call('/api/ai-edit/draft-range', {
    method: 'POST',
    body: { scope: 'section', documentId: 'doc-range', heading: '演示小节', blocks: keyedSection, instruction: '把这一节改得短一点' },
  });
  check(
    '模型少吐一块（这一节有两块只回一块）→ 502 ai_bad_json',
    missingBlockRange.status === 502 && missingBlockRange.error?.code === 'ai_bad_json',
    `${missingBlockRange.status} ${missingBlockRange.error?.code} ${missingBlockRange.error?.message ?? ''}`,
  );
  check(
    '少吐一块的报错点名了缺的那个 blockId 并说明「一节要整节收齐」',
    String(missingBlockRange.error?.message ?? '').includes('sec-2') &&
      String(missingBlockRange.error?.message ?? '').includes('一节要整节收齐'),
    String(missingBlockRange.error?.message ?? ''),
  );

  // ——— 上游失败的五条：交给 bob 发（admin 桶 5 格已满、alice 5 格已满）。
  //
  // 这几条**不会**返回 `data.opId`（它们抛的是 HttpError，没有成功路径那种返回体），
  // 所以审计要按 `reason` 去列表里找，不能按 opId 找。两个坑：
  //   ① 列表要在**这些调用之后**再拉（第一次写把顺序搞反了，拿到的是调用前的快照，五条全找不到）；
  //   ② 审计里的 `reason` 只有**代号**（`ai_bad_json` / `ai_timeout` / `ai_upstream_error 500`），
  //      不带给人看的那句中文（「模型返回的不是 JSON」只在 HTTP 错误体里）。按中文找永远找不到。
  //   ③ `/api/ai-edit/ops` 只列**调用者自己**的行，所以要按发起者去查（bob 发的就查 bob）。
  const rangeFailureCases = [
    ['badjson', 502, 'ai_bad_json', 'ai_bad_json'],
    ['unauthorized', 502, 'ai_unauthorized', 'ai_unauthorized'],
    ['upstream', 502, 'ai_upstream_error', 'ai_upstream_error 500'],
    ['ratelimited', 429, 'ai_rate_limited', 'ai_rate_limited'],
    ['hang', 504, 'ai_timeout', 'ai_timeout'],
  ];
  const rangeFailureResults = [];
  for (const [mode, status, code, auditReason] of rangeFailureCases) {
    modelMode = mode;
    const result = await keyedBob.call('/api/ai-edit/draft-range', { method: 'POST', body: keyedRangeBody() });
    rangeFailureResults.push({
      mode,
      status: result.status,
      code: result.error?.code,
      expectedStatus: status,
      expectedCode: code,
      auditReason,
    });
  }
  // 五种模式各发一次，逐条核对「模式 → 状态码 + 代号」；上面 push 时已经带上期望值。
  const statusWrong = rangeFailureResults.filter((item) => item.status !== item.expectedStatus || item.code !== item.expectedCode);
  check(
    '上游失败的五条路径状态码 / 代号全部正确',
    statusWrong.length === 0,
    JSON.stringify(statusWrong.map((item) => [item.mode, item.status, item.expectedStatus, item.code, item.expectedCode])),
  );
  for (const item of rangeFailureResults) {
    check(
      `上游失败「${item.mode}」→ ${item.expectedStatus} ${item.expectedCode}`,
      item.status === item.expectedStatus && item.code === item.expectedCode,
      `实际 ${item.status} ${item.code}`,
    );
  }
  modelMode = 'ok';

  // 每一条失败都要留痕，而且 targetType 跟着 scope 走（section → doc_section）。
  // 审计列表只列调用者自己的行，这五条是 bob 发的 → 用 bob 的客户端查。
  const keyedRangeOpsNow = (await keyedAdmin.call('/api/ai-edit/ops?limit=100')).data?.ops ?? [];
  const bobOpsNow = (await keyedBob.call('/api/ai-edit/ops?limit=100')).data?.ops ?? [];
  for (const item of rangeFailureResults) {
    const row = bobOpsNow.find(
      (entry) => entry.action === 'draft' && entry.targetType === 'doc_section' && String(entry.reason ?? '') === item.auditReason,
    );
    check(
      `上游失败「${item.mode}」留下了 status=blocked 的审计（targetType=doc_section）`,
      row?.status === 'blocked',
      JSON.stringify(row ?? null),
    );
  }
  const sectionShapeRow = keyedRangeOpsNow.find(
    (row) => row.action === 'draft' && row.targetType === 'doc_section' && String(row.reason ?? '').includes('一节形状不对'),
  );
  check(
    '模型编造 blockId 也留了 blocked 审计，理由是「一节形状不对」',
    sectionShapeRow?.status === 'blocked',
    JSON.stringify(sectionShapeRow ?? null),
  );
  const documentShapeRow = keyedRangeOpsNow.find(
    (row) => row.action === 'draft' && row.targetType === 'document' && String(row.reason ?? '').includes('整篇形状不对'),
  );
  check(
    '整篇形状不对留的 blocked 审计 targetType 是 document（跟着 scope 走）',
    documentShapeRow?.status === 'blocked',
    JSON.stringify(documentShapeRow ?? null),
  );
  // alice 自己那条「markdown 形状不对」的审计要出现在**她自己**的列表里（发起的用户查得到）。
  const aliceBlockedRows = ((await keyedAlice.call('/api/ai-edit/ops?limit=100')).data?.ops ?? []).filter(
    (row) => row.action === 'draft' && row.status === 'blocked' && row.targetType === 'doc_section',
  );
  check(
    'badMarkdown 的四条 blocked 审计都记在发起者（alice）名下（查得到 4 条 doc_section）',
    aliceBlockedRows.length >= 4,
    JSON.stringify(aliceBlockedRows.map((row) => row.reason)),
  );
  const missingBlockRow = aliceBlockedRows.find((row) => String(row.reason ?? '').includes('整节收齐'));
  check(
    '「少吐一块」也留了 status=blocked 的审计（targetType=doc_section）',
    missingBlockRow?.status === 'blocked',
    JSON.stringify(missingBlockRow ?? null),
  );

  // ── 「模型吐回的每个 blockId 都必须属于我发过去的这一节」─────────────────────
  // 上面那条 `section-badid` **没有真的验到这道判断**：它的应答里连 `markdown` 都没给，
  // 所以是被「markdown 不能为空」提前挡下的（谁把归属校验删了它照样绿）。这里补一条
  // **只错这一点**的：整节原样照抄（id 齐全）+ markdown 正常 + 额外多一块 `b99`。
  // 归属校验失效时它会 200，然后那块会被写进文档；所以这条用例就是那道防线的哨兵。
  const extrasUser = createClient(KEYED_BASE);
  const extrasRegister = await extrasUser.call('/api/auth/register', {
    method: 'POST',
    body: { username: 'airrange', password: 'airpass123' },
  });
  check(
    '注册一个干净用户来验这条（draft-range 桶从 0 开始，不受前面 admin/alice/bob/carol 影响）',
    extrasRegister.status === 200,
    `${extrasRegister.status} ${JSON.stringify(extrasRegister.error ?? null)}`,
  );
  const extrasGrant = await extrasUser.call('/api/ai-edit/grants', {
    method: 'POST',
    body: { capability: 'edit_content', confirm: true, dailyQuota: 0 },
  });
  check('这个新用户自助拿到 edit_content', extrasGrant.status === 200, `${extrasGrant.status} ${JSON.stringify(extrasGrant.error ?? null)}`);

  modelMode = 'section-extraid';
  const extraIdRange = await extrasUser.call('/api/ai-edit/draft-range', { method: 'POST', body: keyedRangeBody() });
  check(
    '模型多吐一块不属于这一节的块（整节齐全、markdown 正常）→ 502 ai_bad_json',
    extraIdRange.status === 502 && extraIdRange.error?.code === 'ai_bad_json',
    `${extraIdRange.status} ${extraIdRange.error?.code} ${extraIdRange.error?.message ?? ''}`,
  );
  check(
    '错误信息点名了那个多出来的 id、并说明它不属于这一节',
    String(extraIdRange.error?.message ?? '').includes('b99') &&
      String(extraIdRange.error?.message ?? '').includes('不在我发过去的这一节里'),
    String(extraIdRange.error?.message ?? ''),
  );
  const extrasOps = (await extrasUser.call('/api/ai-edit/ops?limit=100')).data?.ops ?? [];
  const extraIdRow = extrasOps.find((row) => String(row.reason ?? '').includes('ai_bad_json'));
  check(
    '多出来那一块也留了 status=blocked 的审计（reason 含 ai_bad_json）',
    extraIdRow?.status === 'blocked' && extraIdRow?.targetType === 'doc_section',
    JSON.stringify(extraIdRow ?? null),
  );
  // 临时模式用完就复位（跟本节别处的习惯一致）：后面的用例各自会设自己需要的模式，
  // 但别把「假模型现在吐什么」这种状态留在身后。
  modelMode = 'ok';

  // ——— 限流：桶是「5 次/分钟」，满了以后才该 429。
  //     注意代号是 `rate_limited`（core/http.js 的限流器），不是上游那个 `ai_rate_limited`
  //     —— 两者都是 429，混起来用户就分不清「我发太快了」还是「服务商限流了」。
  //
  //     用一个**从零开始**的用户（carol）来验，这样「第几次被挡」是确定的：桶是
  //     `ai-edit:draft-range:<userId>`，这一节前面的调用全记在 admin / alice / bob 名下，
  //     所以 carol 这里是干净的 0 格。前 5 次该过、第 6 次该 429（实测过这个边界）。
  const keyedCarol = createClient(KEYED_BASE);
  const carolLogin = await keyedCarol.call('/api/auth/login', { method: 'POST', body: { username: 'carol', password: 'demo1234' } });
  check('第三台（keyed）服务器上 carol 也能登录', carolLogin.status === 200, JSON.stringify(carolLogin.error ?? null));
  await keyedCarol.call('/api/ai-edit/grants', {
    method: 'POST',
    body: { capability: 'edit_content', confirm: true, dailyQuota: 0 },
  });

  modelMode = 'section-echo';
  const throttleAttempts = [];
  let throttleData;
  for (let i = 0; i < 10; i += 1) {
    const attempt = await keyedCarol.call('/api/ai-edit/draft-range', { method: 'POST', body: keyedRangeBody() });
    throttleAttempts.push(attempt.status);
    if (attempt.status === 429) {
      throttleAttempts.push(attempt.error?.code ?? '');
      throttleData = attempt.data;
      break;
    }
  }
  check(
    '连续打 draft-range 最终会被本机限流挡住（429）',
    throttleAttempts[throttleAttempts.length - 2] === 429,
    JSON.stringify(throttleAttempts),
  );
  check(
    '本机限流的代号是 rate_limited（区别于上游的 ai_rate_limited）',
    throttleAttempts[throttleAttempts.length - 1] === 'rate_limited',
    JSON.stringify(throttleAttempts),
  );
  check(
    '被本机限流时不返回 data（它根本没走到模型那一步）',
    throttleData === undefined || throttleData === null,
    JSON.stringify(throttleData ?? null),
  );
  check(
    '限流桶是「5 次/分钟」：干净的用户前 5 次放行、第 6 次才被挡',
    sameJson(throttleAttempts.slice(0, 6).filter((item) => typeof item === 'number'), [200, 200, 200, 200, 200, 429]),
    JSON.stringify(throttleAttempts),
  );

  // 静态哨兵：section 分支的返回值里必须有 `markdown`（新契约：块给落盘、markdown 给预览）。
  // 只查 `"blocks"` 不够 —— `markdown` 被顺手删掉时，前端预览会退回「什么都不显示」。
  // 注意别把**整篇**分支的 markdown 误当成它：整篇分支在更后面（用下面的切片把
  // section 分支切出来，窗口只覆盖到 `const markdown = typeof body.markdown` 之前）。
  const markdownGuardAt = aiRoutesSrc.indexOf('const markdown = typeof body.markdown');
  const sectionBranchSrc =
    markdownGuardAt > 0
      ? aiRoutesSrc.slice(aiRoutesSrc.indexOf('AI_RANGE_TARGET_TYPES.section'), markdownGuardAt)
      : '';
  check(
    'draft-range 的 section 分支源码里确实把 markdown 塞进了 patch',
    sectionBranchSrc.includes('patch: { blocks:') && sectionBranchSrc.includes('markdown: previewMarkdown'),
    sectionBranchSrc ? sectionBranchSrc.slice(0, 200) : '没抓到这个分支',
  );
  // 变量名会变（形状纠正先跑一遍，`patch` 现在落到 `fixedPatch` 上），所以这里**捕获**
  // 变量名而不是写死；要求校验与清洗吃同一个值、且校验排在前。
  const docCheckCall = aiRoutesSrc.match(/=\s*documentPatchProblem\(([A-Za-z_$][\w$]*),/);
  const docCleanCall = aiRoutesSrc.match(/=\s*cleanDocumentPatch\(([A-Za-z_$][\w$]*)\)/);
  check(
    '整篇分支的 markdown 校验 / 清洗还在（没被 section 的新字段串味）',
    !!docCheckCall &&
      !!docCleanCall &&
      docCheckCall[1] === docCleanCall[1] &&
      docCheckCall.index < docCleanCall.index,
    docCheckCall && docCleanCall
      ? `整篇校验用 \`${docCheckCall[1]}\`、清洗用 \`${docCleanCall[1]}\`（要同一个值，且校验在前）`
      : '整篇的形状校验 / 清洗不见了',
  );

  // 静态哨兵（父代理点名）：预览必须走 P2 的渲染接口，而不是把块 JSON 铺在 <pre> 里。
  //
  // 现状：P2 的 `POST /api/docs/:id/preview` 已经在了，`public/views/ai-edit.js` **还没接**
  // （它现在仍用 `shortJson(draft.patch.blocks)` 铺 <pre>）。所以这条写成两段：
  //   ① 无条件钉住 P2 那侧的路由存在（前端接上去以后不会撞 404）；
  //   ② 前端一旦接上（文件里出现 `…/preview`），就要求它打的是这个接口、并且
  //      **不再**把块 JSON 当正文铺 <pre>。
  // 只写 ① 是诚实的：前端当前状态做不到「必须出现 /preview」，硬写会立刻红。
  const aiEditUiSrc = readFileSync(join(ROOT, 'public', 'views', 'ai-edit.js'), 'utf8');
  const docRoutesSrc = readFileSync(join(ROOT, 'src', 'modules', 'doc', 'routes.js'), 'utf8');
  check(
    'P2 的 POST /api/docs/:id/preview 渲染接口存在（前端预览要落在这上面）',
    docRoutesSrc.includes("'/api/docs/:id/preview'"),
    'P2 的预览接口不见了',
  );
  const uiWiredPreview = aiEditUiSrc.includes('/preview');
  check(
    uiWiredPreview
      ? '前端 ai-edit.js 走 P2 的 …/preview 渲染接口，且不再把块 JSON 铺进 <pre> 当正文'
      : '前端 ai-edit.js 尚未接 …/preview（当前仍铺块 JSON）—— 这条记录现状，接口侧由上一行钉住',
    uiWiredPreview
      ? /api\/docs\/\$\{[^}]*\}\/preview/.test(aiEditUiSrc) &&
          !/shortJson\(draft\.patch\?\.blocks/.test(aiEditUiSrc)
      : !aiEditUiSrc.includes('/preview'),
    uiWiredPreview ? '接了 /preview，但仍在 <pre> 里铺 draft.patch.blocks' : '未接 /preview（预期内的现状）',
  );

  /* ---------- 26. POST /api/ai-edit/ops 的两种新 scope ---------- */
  //
  // 老的单块行为（不带 scope）由第 7~22 节钉着；这一节补新加的两档。
  // `/ops` 本身不调模型、不限流（限流只在草拟那两条上），所以随便打。
  const anonOpsSection = await createClient().call('/api/ai-edit/ops', {
    method: 'POST',
    body: { scope: 'section', documentId: 'doc-scope', after: { markdown: 'x' } },
  });
  check('未登录提交带 scope 的操作仍然 401（不是 404）', anonOpsSection.status === 401, `实际 ${anonOpsSection.status}`);

  const scopeUnknown = await admin.call('/api/ai-edit/ops', {
    method: 'POST',
    body: { scope: 'chapter', documentId: 'doc-scope', after: BLOCK_AFTER, confirm: true },
  });
  check('scope 是别的值 → 400', scopeUnknown.status === 400, `实际 ${scopeUnknown.status}`);
  check('未知 scope 的错误代号是 bad_request', scopeUnknown.error?.code === 'bad_request', String(scopeUnknown.error?.code));

  const scopeSectionBefore = [
    { blockId: 'sb-1', type: 'heading', props: { text: '小节', level: 2 } },
    { blockId: 'sb-2', type: 'paragraph', props: { text: '旧文案' } },
  ];
  const scopeSectionAfter = [
    { blockId: 'sb-1', type: 'heading', props: { text: '小节', level: 2 } },
    { blockId: 'sb-2', type: 'paragraph', props: { text: '新文案' } },
  ];
  const scopeSectionBody = {
    scope: 'section',
    documentId: 'doc-scope',
    before: scopeSectionBefore,
    after: scopeSectionAfter,
  };

  const scopeSectionPreview = await admin.call('/api/ai-edit/ops', { method: 'POST', body: scopeSectionBody });
  check(
    'section 预览（不带 confirm）返回 applied:false',
    scopeSectionPreview.status === 200 && scopeSectionPreview.data?.applied === false,
    JSON.stringify(scopeSectionPreview.data),
  );
  check(
    'section 预览里带 targetType / targetId',
    scopeSectionPreview.data?.preview?.targetType === 'doc_section' &&
      scopeSectionPreview.data?.preview?.targetId === 'doc-scope:sb-1~sb-2',
    JSON.stringify(scopeSectionPreview.data?.preview),
  );
  check(
    'section 预览里 before / after 都是块数组',
    Array.isArray(scopeSectionPreview.data?.preview?.before) && Array.isArray(scopeSectionPreview.data?.preview?.after),
    JSON.stringify(scopeSectionPreview.data?.preview),
  );
  check('section 预览回带的 scope 是 section', scopeSectionPreview.data?.scope === 'section', String(scopeSectionPreview.data?.scope));

  const scopeSectionApplied = await admin.call('/api/ai-edit/ops', {
    method: 'POST',
    body: { ...scopeSectionBody, confirm: true },
  });
  check(
    'section 带 confirm 落盘成功（applied:true）',
    scopeSectionApplied.status === 200 && scopeSectionApplied.data?.applied === true,
    JSON.stringify(scopeSectionApplied.data),
  );
  check('section 落盘的 targetType 是 doc_section', scopeSectionApplied.data?.targetType === 'doc_section', String(scopeSectionApplied.data?.targetType));
  check('section 落盘的 targetId 是 <documentId>:<首块>~<末块>', scopeSectionApplied.data?.targetId === 'doc-scope:sb-1~sb-2', String(scopeSectionApplied.data?.targetId));
  check(
    'section 的 writeTo 指向 P2 的 ops 接口',
    scopeSectionApplied.data?.writeTo === '/api/docs/doc-scope/ops',
    String(scopeSectionApplied.data?.writeTo),
  );
  check(
    'section 落盘的 before / after 是块数组（不是 {type,props}）',
    Array.isArray(scopeSectionApplied.data?.before) && Array.isArray(scopeSectionApplied.data?.after),
    JSON.stringify({ before: scopeSectionApplied.data?.before, after: scopeSectionApplied.data?.after }),
  );
  check(
    'section 落盘时 before / after 的块 id 一一对应',
    JSON.stringify(scopeSectionApplied.data?.before?.map((item) => item.blockId)) ===
      JSON.stringify(scopeSectionApplied.data?.after?.map((item) => item.blockId)),
    JSON.stringify(scopeSectionApplied.data),
  );
  check(
    'section 落盘不带 blockId（那是单块模式才有的字段）',
    scopeSectionApplied.data?.blockId === undefined,
    String(scopeSectionApplied.data?.blockId),
  );

  // id 集合对不上 → 400（回滚写回的是 before 那些块，集合对不上会出现「回滚漏改一半」/「凭空多一块」）。
  const idMismatch = await admin.call('/api/ai-edit/ops', {
    method: 'POST',
    body: {
      scope: 'section',
      documentId: 'doc-scope',
      before: scopeSectionBefore,
      after: [scopeSectionAfter[0], { blockId: 'sb-other', type: 'paragraph', props: { text: 'x' } }],
      confirm: true,
    },
  });
  check('before / after 的 blockId 集合对不上 → 400', idMismatch.status === 400, `实际 ${idMismatch.status}`);
  check('id 对不上的错误代号是 bad_request', idMismatch.error?.code === 'bad_request', String(idMismatch.error?.code));
  const countMismatch = await admin.call('/api/ai-edit/ops', {
    method: 'POST',
    body: { scope: 'section', documentId: 'doc-scope', before: scopeSectionBefore, after: [scopeSectionAfter[0]], confirm: true },
  });
  check('before / after 的块数对不上 → 400', countMismatch.status === 400, `实际 ${countMismatch.status}`);
  const missingSectionBefore = await admin.call('/api/ai-edit/ops', {
    method: 'POST',
    body: { scope: 'section', documentId: 'doc-scope', after: scopeSectionAfter, confirm: true },
  });
  check('section 缺 before → 400', missingSectionBefore.status === 400, `实际 ${missingSectionBefore.status}`);
  const badSectionAfter = await admin.call('/api/ai-edit/ops', {
    method: 'POST',
    body: { scope: 'section', documentId: 'doc-scope', before: scopeSectionBefore, after: BLOCK_AFTER, confirm: true },
  });
  check('section 的 after 是单块（不是数组）→ 400', badSectionAfter.status === 400, `实际 ${badSectionAfter.status}`);
  const duplicateSectionId = await admin.call('/api/ai-edit/ops', {
    method: 'POST',
    body: {
      scope: 'section',
      documentId: 'doc-scope',
      before: [{ blockId: 'dup-b', type: 'paragraph', props: { text: '甲' } }],
      after: [{ blockId: 'dup-b', type: 'paragraph', props: { text: '甲' } }],
      confirm: true,
    },
  });
  check('section 只有一块也能落盘（单块一节是合法的）', duplicateSectionId.status === 200, `实际 ${duplicateSectionId.status}`);
  check(
    '单块一节的 targetId 就是 <documentId>:<blockId>（不加波浪号）',
    duplicateSectionId.data?.targetId === 'doc-scope:dup-b',
    String(duplicateSectionId.data?.targetId),
  );

  // 整篇（document）
  const scopeDocAfter = { markdown: '# 改完的整篇\n\n正文。', title: '改完的标题' };
  const scopeDocBody = { scope: 'document', documentId: 'doc-scope', after: scopeDocAfter };
  const scopeDocPreview = await admin.call('/api/ai-edit/ops', { method: 'POST', body: scopeDocBody });
  check(
    'document 预览（不带 confirm）返回 applied:false',
    scopeDocPreview.status === 200 && scopeDocPreview.data?.applied === false,
    JSON.stringify(scopeDocPreview.data),
  );
  check(
    'document 预览的 targetType / targetId',
    scopeDocPreview.data?.preview?.targetType === 'document' &&
      scopeDocPreview.data?.preview?.targetId === 'doc-scope:*',
    JSON.stringify(scopeDocPreview.data?.preview),
  );
  const scopeDocApplied = await admin.call('/api/ai-edit/ops', {
    method: 'POST',
    body: { ...scopeDocBody, confirm: true },
  });
  check(
    'document 带 confirm 落盘成功',
    scopeDocApplied.status === 200 && scopeDocApplied.data?.applied === true,
    JSON.stringify(scopeDocApplied.data),
  );
  check('document 的 targetType 是 document', scopeDocApplied.data?.targetType === 'document', String(scopeDocApplied.data?.targetType));
  check('document 的 targetId 是 <documentId>:*', scopeDocApplied.data?.targetId === 'doc-scope:*', String(scopeDocApplied.data?.targetId));
  check(
    'document 的 writeTo 是 /api/docs/<id>/markdown',
    scopeDocApplied.data?.writeTo === '/api/docs/doc-scope/markdown',
    String(scopeDocApplied.data?.writeTo),
  );
  check(
    'document 的 after 是服务端清洗过的 {markdown, title}',
    scopeDocApplied.data?.after?.markdown === scopeDocAfter.markdown && scopeDocApplied.data?.after?.title === scopeDocAfter.title,
    JSON.stringify(scopeDocApplied.data?.after),
  );
  // 回滚要能取到「改前的样子」，所以再落一条**带 before** 的整篇操作。
  // 上面那条故意不带 before，用来钉「整篇的 before 可以缺省」；而缺 before 的操作
  // 回滚只能 409（没有恢复内容可交）—— 这两条语义是配套的，别把上面的改成带 before。
  const scopeDocBefore = { markdown: '# 旧整篇\n\n旧正文。', title: '旧标题' };
  const scopeDocWithBefore = await admin.call('/api/ai-edit/ops', {
    method: 'POST',
    body: { scope: 'document', documentId: 'doc-scope', before: scopeDocBefore, after: scopeDocAfter, confirm: true },
  });
  check(
    '带 before 的整篇操作也能落盘',
    scopeDocWithBefore.status === 200 && scopeDocWithBefore.data?.applied === true,
    JSON.stringify(scopeDocWithBefore.data),
  );

  const docEmptyMarkdown = await admin.call('/api/ai-edit/ops', {
    method: 'POST',
    body: { scope: 'document', documentId: 'doc-scope', after: { markdown: '   ' }, confirm: true },
  });
  check('document 的 markdown 是空串 → 400', docEmptyMarkdown.status === 400, `实际 ${docEmptyMarkdown.status}`);
  const docNoMarkdown = await admin.call('/api/ai-edit/ops', {
    method: 'POST',
    body: { scope: 'document', documentId: 'doc-scope', after: { title: '只有标题' }, confirm: true },
  });
  check('document 缺 markdown → 400', docNoMarkdown.status === 400, `实际 ${docNoMarkdown.status}`);
  const docBadType = await admin.call('/api/ai-edit/ops', {
    method: 'POST',
    body: { scope: 'document', documentId: 'doc-scope', after: { markdown: 42 }, confirm: true },
  });
  check('document 的 markdown 不是字符串 → 400', docBadType.status === 400, `实际 ${docBadType.status}`);

  // 落盘的 section / document 都能在**老的那条** GET 审计里查到，targetType / targetId 对得上。
  const scopeOps = (await admin.call('/api/ai-edit/ops?limit=100')).data?.ops ?? [];
  const sectionRow = scopeOps.find((row) => row.id === scopeSectionApplied.data?.opId);
  const documentRow = scopeOps.find((row) => row.id === scopeDocApplied.data?.opId);
  check('section 落盘记录在审计里', sectionRow?.targetType === 'doc_section' && sectionRow?.targetId === 'doc-scope:sb-1~sb-2', JSON.stringify(sectionRow));
  check('document 落盘记录在审计里', documentRow?.targetType === 'document' && documentRow?.targetId === 'doc-scope:*', JSON.stringify(documentRow));
  check(
    'section 审计里的 before / after 是块数组（回滚要原样交回）',
    Array.isArray(sectionRow?.before) && Array.isArray(sectionRow?.after),
    JSON.stringify({ before: sectionRow?.before, after: sectionRow?.after }),
  );
  check(
    'document 审计里的 before / after 是 {markdown}（before 可以缺省）',
    documentRow?.after?.markdown === scopeDocAfter.markdown && documentRow?.before === null,
    JSON.stringify({ before: documentRow?.before, after: documentRow?.after }),
  );

  /* ---------- 27. 回滚的三种 restore 形状 ---------- */
  //
  // `/ops/:id/rollback` 本身一行没改，但 `restore` 现在有**三种**形状：
  // 老的块级 → `{type,props}`；小节 → 块数组；整篇 → `{markdown,…}`。
  // 前端拿 restore 去写盘，形状认错就是「回滚把一节写成一块」。
  const blockRollbackAgain = await admin.call(`/api/ai-edit/ops/${opId}/rollback`, { method: 'POST' });
  check('第 9 节那条块级审计已经回滚过，重复回滚仍然 409（老用例没被影响）', blockRollbackAgain.status === 409, `实际 ${blockRollbackAgain.status}`);
  const blockRestoreRow = (await admin.call('/api/ai-edit/ops?limit=100')).data?.ops?.find((row) => row.id === opId);
  check(
    '老的单块审计 restore 的形状仍然是 {type, props}',
    blockRestoreRow?.before?.type === 'paragraph' && blockRestoreRow?.before?.props?.text === '旧文案',
    JSON.stringify(blockRestoreRow?.before),
  );

  const sectionRollback = await admin.call(`/api/ai-edit/ops/${scopeSectionApplied.data?.opId}/rollback`, { method: 'POST' });
  check(
    '回滚一条 section 操作成功',
    sectionRollback.status === 200 && sectionRollback.data?.rolledBack === true,
    JSON.stringify(sectionRollback.data),
  );
  check(
    'section 的 restore 是**块数组**（不是 {type,props}）',
    Array.isArray(sectionRollback.data?.restore),
    JSON.stringify(sectionRollback.data?.restore),
  );
  check(
    'section 的 restore 就是原整节（改前的文案）',
    sameJson(sectionRollback.data?.restore, scopeSectionBefore),
    JSON.stringify(sectionRollback.data?.restore),
  );
  check(
    'section 回滚也回带 targetType / targetId',
    sectionRollback.data?.targetType === 'doc_section' && sectionRollback.data?.targetId === 'doc-scope:sb-1~sb-2',
    JSON.stringify({ targetType: sectionRollback.data?.targetType, targetId: sectionRollback.data?.targetId }),
  );
  check('section 回滚带上了 rolledBackAt', Number.isInteger(sectionRollback.data?.rolledBackAt), String(sectionRollback.data?.rolledBackAt));

  // 缺 before 的整篇操作：回滚取不到恢复内容，只能 409（不能假装回滚成功）。
  const docNoBeforeRollback = await admin.call(`/api/ai-edit/ops/${scopeDocApplied.data?.opId}/rollback`, { method: 'POST' });
  check('整篇操作缺 before 时回滚 409（没有恢复内容可交）', docNoBeforeRollback.status === 409, `实际 ${docNoBeforeRollback.status}`);

  const documentRollback = await admin.call(`/api/ai-edit/ops/${scopeDocWithBefore.data?.opId}/rollback`, { method: 'POST' });
  check(
    '回滚一条 document 操作成功',
    documentRollback.status === 200 && documentRollback.data?.rolledBack === true,
    JSON.stringify(documentRollback.data),
  );
  check(
    'document 的 restore 是 { markdown, … }',
    documentRollback.data?.restore != null &&
      typeof documentRollback.data.restore === 'object' &&
      !Array.isArray(documentRollback.data.restore) &&
      typeof documentRollback.data.restore.markdown === 'string',
    JSON.stringify(documentRollback.data?.restore),
  );
  check(
    'document 的 restore 就是改前的整篇（markdown / title 原样交回）',
    sameJson(documentRollback.data?.restore, scopeDocBefore),
    JSON.stringify(documentRollback.data?.restore),
  );
  check(
    'document 的 restore.targetType 是 document、targetId 是 <documentId>:*',
    documentRollback.data?.targetType === 'document' && documentRollback.data?.targetId === 'doc-scope:*',
    JSON.stringify({ targetType: documentRollback.data?.targetType, targetId: documentRollback.data?.targetId }),
  );

  // 回滚后 canRollback / rolledBackAt 的行为与老用例一致（列表里立刻不可回滚、再回滚 409）。
  const rollbackOps = (await admin.call('/api/ai-edit/ops?limit=100')).data?.ops ?? [];
  const sectionRolled = rollbackOps.find((row) => row.id === scopeSectionApplied.data?.opId);
  const documentRolled = rollbackOps.find((row) => row.id === scopeDocWithBefore.data?.opId);
  check('section 回滚后状态变成 rolled_back', sectionRolled?.status === 'rolled_back', String(sectionRolled?.status));
  check('section 回滚后 canRollback=false', sectionRolled?.canRollback === false, String(sectionRolled?.canRollback));
  check('section 回滚后 rolledBackAt 有值', Number.isInteger(sectionRolled?.rolledBackAt), String(sectionRolled?.rolledBackAt));
  check('document 回滚后状态变成 rolled_back', documentRolled?.status === 'rolled_back', String(documentRolled?.status));
  check('document 回滚后 canRollback=false', documentRolled?.canRollback === false, String(documentRolled?.canRollback));
  check('document 回滚后 rolledBackAt 有值', Number.isInteger(documentRolled?.rolledBackAt), String(documentRolled?.rolledBackAt));
  const sectionRollbackAgain = await admin.call(`/api/ai-edit/ops/${scopeSectionApplied.data?.opId}/rollback`, { method: 'POST' });
  check('section 重复回滚返回 409', sectionRollbackAgain.status === 409, `实际 ${sectionRollbackAgain.status}`);
  const documentRollbackAgain = await admin.call(`/api/ai-edit/ops/${scopeDocWithBefore.data?.opId}/rollback`, { method: 'POST' });
  check('document 重复回滚返回 409', documentRollbackAgain.status === 409, `实际 ${documentRollbackAgain.status}`);

  /* ---------- 28. 没配 key 的 503 不该吃限流额度（requireModelConfigured 排在 rateLimit 之前） ---------- */
  //
  // 回归的是这么一件事：以前在**没配 key** 的服务器上连打 `draft-range`，每一次都是 503
  // （一次模型都没用上、一分钱没花），却照样把「每分钟 5 次」的桶打满，第 6 次变成 429
  // —— 用户看到的是「你操作太频繁」，可他其实什么都没干成。现在配置门排在限流之前：
  // `src/modules/ai/routes.js:1108` / `:1197` 的 `requireModelConfigured(...)` 在
  // `:1115` / `:1204` 的 `rateLimit(...)` 之前，`:973` 的 `/draft` 也在 `:975` 之前。
  // 每日配额（`usedToday`）与全站闸门（`siteUsedToday`）本来就排除 `blocked` 行，
  // 这三条用例钉的就是「限流跟它们同一个口径」——**一次 429 都不该出现**。
  //
  // 用 carol：她在**这台没配 key 的服务器**上还没有任何 AI 授权（第 23 节拿她验过权限边界），
  // 所以两个限流桶（`ai-edit:draft-range:carol` / `ai-edit:draft:carol`）都是从 0 开始，
  // 「第 6 次 / 第 11 次」这种边界才有确定性 —— 桶被别人提前用掉的话这条用例就废了。
  const carolGrant = await carolPlain.call('/api/ai-edit/grants', {
    method: 'POST',
    body: { capability: 'edit_content', confirm: true, dailyQuota: 0 },
  });
  check(
    'carol 拿到 edit_content（下面三条回归要用，桶从 0 开始）',
    carolGrant.status === 200,
    `实际 ${carolGrant.status} ${JSON.stringify(carolGrant.error ?? null)}`,
  );

  // ① `draft-range`：桶是 5 次/分钟，连打 6 次合法请求。改之前第 6 次必是 429。
  const noKeyRangeAttempts = [];
  for (let i = 0; i < 6; i += 1) {
    noKeyRangeAttempts.push(await carolPlain.call('/api/ai-edit/draft-range', { method: 'POST', body: rangeSectionBody() }));
  }
  const noKeyRangeStatuses = noKeyRangeAttempts.map((item) => item.status);
  check(
    '没配 key 时 draft-range 连打 6 次全是 503（配置门不占限流额度）',
    noKeyRangeStatuses.every((status) => status === 503),
    JSON.stringify(noKeyRangeStatuses),
  );
  check(
    'draft-range 没有一条被本机限流挡成 429（改之前第 6 次就是 429）',
    noKeyRangeStatuses.every((status) => status !== 429),
    JSON.stringify(noKeyRangeStatuses),
  );
  check(
    '这 6 次的错误代号都是 ai_not_configured',
    noKeyRangeAttempts.every((item) => item.error?.code === 'ai_not_configured'),
    JSON.stringify(noKeyRangeAttempts.map((item) => item.error?.code ?? null)),
  );
  // 503 是「配置门」，不是「静默失败」：每一次都要留一条 blocked 审计（targetType 跟 scope 走）。
  const carolOwnOps = await listOps(carolPlain);
  const carolNoKeyRows = carolOwnOps.filter(
    (row) =>
      String(row.reason ?? '') === 'ai_not_configured' &&
      row.status === 'blocked' &&
      row.targetType === 'doc_section' &&
      row.targetId === 'doc-range:rs1~rs2',
  );
  check(
    '6 次 503 各留了一条 blocked 审计（targetType=doc_section，记在发起者名下）',
    carolNoKeyRows.length >= 6,
    String(carolNoKeyRows.length),
  );

  // ② `/draft`：桶是 10 次/分钟（FR-AI-14），连打 12 次也该全是 503、一条 429 都没有。
  const noKeyDraftBody = { blockId: 'block-1', block: { type: 'paragraph', props: { text: '原文' } }, instruction: '改成投票' };
  const noKeyDraftAttempts = [];
  for (let i = 0; i < 12; i += 1) {
    noKeyDraftAttempts.push(await carolPlain.call('/api/ai-edit/draft', { method: 'POST', body: noKeyDraftBody }));
  }
  const noKeyDraftStatuses = noKeyDraftAttempts.map((item) => item.status);
  check(
    '没配 key 时 /draft 连打 12 次全是 503（10 次/分钟的桶也没被吃）',
    noKeyDraftStatuses.every((status) => status === 503),
    JSON.stringify(noKeyDraftStatuses),
  );
  check(
    '/draft 也没有一条 429',
    noKeyDraftStatuses.every((status) => status !== 429),
    JSON.stringify(noKeyDraftStatuses),
  );
  const carolDraftRows = (await listOps(carolPlain)).filter(
    (row) => String(row.reason ?? '') === 'ai_not_configured' && row.status === 'blocked' && row.targetType === 'document_block',
  );
  check(
    '/draft 的 12 次 503 也都留了 blocked 审计（targetType=document_block）',
    carolDraftRows.length >= 12,
    String(carolDraftRows.length),
  );

  // ③ `/draft` 的参数校验仍排在限流之前：11 次「instruction 为空」全该是 400（不吃额度），
  //    紧接着的第 12 次合法请求仍然该是 503（配置门），而不是被限流挡成 429。
  const noKeyDraftBad = [];
  for (let i = 0; i < 11; i += 1) {
    noKeyDraftBad.push(
      await carolPlain.call('/api/ai-edit/draft', {
        method: 'POST',
        body: { blockId: 'block-1', block: { type: 'paragraph', props: { text: '原文' } }, instruction: '   ' },
      }),
    );
  }
  check(
    '11 次「instruction 为空」全是 400（校验排在限流之前）',
    noKeyDraftBad.every((item) => item.status === 400),
    JSON.stringify(noKeyDraftBad.map((item) => item.status)),
  );
  check(
    '这 11 次的错误代号都是 bad_request',
    noKeyDraftBad.every((item) => item.error?.code === 'bad_request'),
    JSON.stringify(noKeyDraftBad.map((item) => item.error?.code ?? null)),
  );
  const noKeyDraftAfterBad = await carolPlain.call('/api/ai-edit/draft', { method: 'POST', body: noKeyDraftBody });
  check(
    '校验不过的请求不吃额度：紧随其后的合法请求仍然是 503（不是 429）',
    noKeyDraftAfterBad.status === 503 && noKeyDraftAfterBad.error?.code === 'ai_not_configured',
    `实际 ${noKeyDraftAfterBad.status} ${noKeyDraftAfterBad.error?.code ?? ''}`,
  );

  /* ---------- 29. 裸写的围栏块：doc 548 投票帖事故的回归 ---------- */
  //
  // 事故：模型把一个投票块写成了「裸写的 `doc:poll {#b2}` + 一段 JSON」，没有围栏。
  // P2 的解析器遇到看不懂的东西一律退化成正文（**从不抛异常**），于是线上那篇文档里
  // 没有投票块，整段 JSON 变成了正文 —— 用户看到的就是「投票帖打开是一大片 JSON」。
  //
  // 这一节钉四件事：
  //   ① 两份 `fenceFor` 逐字同算法（`programs.js` 的注释自称「ai-smoke 有一条哨兵把
  //      两个实现对着跑」，这里把它补成真的）；
  //   ② 纠正层补上围栏之后，**用 P2 自己的解析器**再解析一遍，第二步必须是一块投票，
  //      而且原来的块号 `b2` 还在；
  //   ③ 教程里用四反引号包着的示例一个字都不许动（那是「教人怎么写」，不是坏块）；
  //   ④ `/ops` 的预览必须**已经**是修好的版本 —— 用户点确认之前就该看见真实形状，
  //      而不是「先存坏的、以后再修」。
  const barePollProps = {
    question: '谁最帅？',
    options: [
      { id: 'o1', text: '用户一' },
      { id: 'o2', text: '用户二' },
      { id: 'o3', text: '用户三' },
      { id: 'o4', text: '用户四' },
    ],
    multiple: false,
  };
  const barePollJson = JSON.stringify(barePollProps, null, 2);
  const barePollDoc = `说明：这次投票想弄清站里谁最帅。\n\ndoc:poll {#b2}\n${barePollJson}\n\n## 结果说明\n\n结果写在这里。`;

  // ① 两份 `fenceFor` 必须同算法：任一时刻改了其中一份，围栏就可能不够长，
  //    内容里带反引号的块会把文档截成两半。
  const fencePairs = ['abc', 'a```b', '```', 'a````b'];
  check(
    'AI 的 fenceFor 与 P2 text.js 的 fenceFor 逐字同算法（四组输入结果一致）',
    fencePairs.every((text) => aiFenceFor(text) === p2FenceFor(text)),
    fencePairs.map((text) => `${JSON.stringify(text)}:${aiFenceFor(text)}/${p2FenceFor(text)}`).join(' '),
  );

  // ② 先复现事故现场：坏文档在 P2 眼里**没有**投票块，JSON 是正文。
  const bareParsedBefore = parseSourceBlocks(barePollDoc);
  check(
    '坏文档按原样解析：没有 poll 块、JSON 成了正文（这就是线上 548 的样子）',
    bareParsedBefore.warnings.length === 0 &&
      bareParsedBefore.blocks.length === 3 &&
      bareParsedBefore.blocks.every((block) => block.type !== 'poll'),
    JSON.stringify(bareParsedBefore.blocks.map((block) => block.type)),
  );

  const bareFixed = repairMarkdown(barePollDoc);
  check(
    '纠正层给裸写的投票补上围栏，并留一句人话说明改了什么',
    /^`{3,}doc:poll \{#b2\}$/m.test(bareFixed.value) && bareFixed.notes.length === 1,
    JSON.stringify(bareFixed.notes),
  );

  // ③ 最硬的判据：修完再让 P2 解析一次。
  const bareParsedAfter = parseSourceBlocks(bareFixed.value);
  const repairedPollBlock = bareParsedAfter.blocks.find((block) => block.type === 'poll');
  check(
    '修完再解析：第二步是一块真投票，块号 b2 保住了，选项也还在',
    bareParsedAfter.warnings.length === 0 &&
      bareParsedAfter.blocks[1]?.type === 'poll' &&
      bareParsedAfter.blocks[1]?.block_id === 'b2' &&
      repairedPollBlock?.props?.question === '谁最帅？' &&
      repairedPollBlock?.props?.options?.length === 4,
    JSON.stringify(bareParsedAfter.blocks.map((block) => [block.block_id, block.type])),
  );
  check(
    '修完只动了那一处：说明与后半篇的文字原样还在',
    bareFixed.value.includes('这次投票想弄清站里谁最帅。') && bareFixed.value.includes('结果写在这里。'),
    bareFixed.value.slice(0, 40),
  );

  // ④ 教程守卫：四反引号围栏里包着的示例是「教人怎么写」，不是坏块。
  const tutorialDoc = ['````text', 'doc:poll {#b7}', '{"question":"示例","options":[]}', '````', '', '正文'].join('\n');
  const tutorialFixed = repairMarkdown(tutorialDoc);
  check(
    '教程里用四反引号包着的示例，纠正层一个字都不动、也不留说明',
    tutorialFixed.value === tutorialDoc && tutorialFixed.notes.length === 0,
    JSON.stringify(tutorialFixed.notes),
  );

  // ⑤ 单块路径（`/draft` 的纠正）走的是同一个 `repairBlock`。
  const bareBlockFixed = repairBlock({ blockId: 'b2', type: 'prose', props: { text: `doc:poll {#b2}\n${barePollJson}` } });
  check(
    '单块纠正：正文里裸写着 doc:poll → 整块换成投票块，块号不变',
    bareBlockFixed.value.type === 'poll' &&
      bareBlockFixed.value.blockId === 'b2' &&
      bareBlockFixed.value.props?.options?.length === 4 &&
      bareBlockFixed.notes.length === 1,
    JSON.stringify(bareBlockFixed.value).slice(0, 100),
  );

  // ⑥ 选项归一：模型给的选项形状五花八门，落库前必须摆成 `{ id, text }` 并收敛到上限。
  const stringOptions = normalizePollProps({ question: '选哪个', options: ['甲', '乙'] });
  check(
    '选项是字符串数组时，摆成本站要的 { id, text } 形状',
    stringOptions.props.options.length === 2 &&
      stringOptions.props.options.every(
        (option) => typeof option.id === 'string' && option.id !== '' && typeof option.text === 'string' && option.text !== '',
      ) &&
      stringOptions.notes.length === 1,
    JSON.stringify(stringOptions.props.options),
  );
  const manyOptions = normalizePollProps({
    question: '选哪个',
    options: Array.from({ length: 12 }, (_value, index) => ({ label: `选${index}` })),
  });
  check(
    '12 个选项收敛到本站上限 10 个，并留一句人话',
    manyOptions.props.options.length === 10 && manyOptions.notes.every((note) => typeof note === 'string'),
    String(manyOptions.props.options.length),
  );
  check(
    '运行时清单：可围栏的 6 种、可自动纠正的 3 种（纠正层只碰这三种）',
    AI_FENCED_TYPES.join(',') === 'poll,fold,embed,app,subpage,script' && AI_FIXABLE_TYPES.join(',') === 'app,script,poll',
    `${AI_FENCED_TYPES.join(',')} / ${AI_FIXABLE_TYPES.join(',')}`,
  );

  // ⑦ 端到端：`/ops` 的整篇预览必须已经是修好的版本。
  const bareDocOps = await admin.call('/api/ai-edit/ops', {
    method: 'POST',
    body: { scope: 'document', documentId: 'doc-548', after: { markdown: barePollDoc, title: '谁最帅' } },
  });
  check(
    '整篇预览里裸写的投票已经被补上围栏（服务端不原样回吐）',
    bareDocOps.status === 200 &&
      bareDocOps.data?.applied === false &&
      /^`{3,}doc:poll \{#b2\}$/m.test(String(bareDocOps.data?.preview?.after?.markdown ?? '')),
    `实际 ${bareDocOps.status}`,
  );
  check(
    '整篇预览带一句人话的 repairs（告诉用户服务端替他改了什么）',
    typeof bareDocOps.data?.repairs === 'string' && bareDocOps.data.repairs.includes('围栏'),
    String(bareDocOps.data?.repairs ?? ''),
  );
  check(
    '整篇预览的 repairs 与纠正层自己的说明一致（不是另编一句）',
    bareDocOps.data?.repairs === describeRepairs(bareFixed.notes),
    String(bareDocOps.data?.repairs ?? ''),
  );

  const bareSectionOps = await admin.call('/api/ai-edit/ops', {
    method: 'POST',
    body: {
      scope: 'section',
      documentId: 'doc-548',
      before: [{ blockId: 'b2', type: 'paragraph', props: { text: '旧文案' } }],
      after: [{ blockId: 'b2', type: 'prose', props: { text: `doc:poll {#b2}\n${barePollJson}` } }],
    },
  });
  check(
    '按小节预览里，整块裸写的投票被换成了真投票块（块号还是 b2）',
    bareSectionOps.status === 200 &&
      bareSectionOps.data?.preview?.after?.[0]?.type === 'poll' &&
      bareSectionOps.data?.preview?.after?.[0]?.blockId === 'b2',
    JSON.stringify(bareSectionOps.data?.preview?.after?.map((block) => [block.blockId, block.type]) ?? null),
  );

  await finish(failures.length ? 1 : 0);
} catch (error) {
  console.log(`❌ 测试自己崩了：${error.stack ?? error.message}`);
  await finish(1);
}
