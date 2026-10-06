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
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
// 第 19 节要用**运行时**那份白名单：真正决定 `blockPatchProblem` 放行谁的是它，
// 而不是源文件里的数组字面量（两者之间隔着一个 `.map(...)`）。
import { AI_BLOCK_TYPE_NAMES as AI_RUNTIME_TYPE_NAMES } from '../src/modules/ai/schema.js';

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

const ALL_CAPABILITIES = ['read_post', 'read_site', 'network', 'edit_content', 'site_tools', 'publish'];

/** 整个测试反复用的两块：P2 的块形状就是 `{ type, props }`。 */
const BLOCK_BEFORE = { type: 'paragraph', props: { text: '旧文案' } };
const BLOCK_AFTER = { type: 'poll', props: { question: '选哪个？', options: ['A', 'B'] } };

/* ---------- 第 18/19 节共用：直接从源文件里抓块类型清单 ---------- */
//
// 第 19 节是静态哨兵（AI 抄的那份清单 vs P2 的真相），第 18 节要用同一份清单
// 核对提示词教给模型的形状，所以在这里一次性读出来。
const P2_TYPES_SRC = readFileSync(join(ROOT, 'src', 'modules', 'doc', 'blocks', 'types.js'), 'utf8');
const AI_SCHEMA_SRC = readFileSync(join(ROOT, 'src', 'modules', 'ai', 'schema.js'), 'utf8');

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

const P2_BLOCK_TYPE_NAMES = grabP2BlockTypeNames(P2_TYPES_SRC);
const AI_BLOCK_TYPE_NAMES = grabAiBlockTypeNames(AI_SCHEMA_SRC);

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

  /* ---------- 3. 六项能力默认全部关闭 ---------- */
  const caps = await admin.call('/api/ai-edit/capabilities');
  check('能力目录返回 200', caps.status === 200, `实际 ${caps.status}`);
  check('能力目录里正好是六项', caps.data?.capabilities?.length === 6, String(caps.data?.capabilities?.length));
  check(
    '六项能力与规格书一致',
    ALL_CAPABILITIES.every((key) => caps.data.capabilities.some((item) => item.key === key)),
    JSON.stringify(caps.data?.capabilities?.map((item) => item.key)),
  );
  check(
    '六项能力默认全部关闭',
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

  const highRiskNoConfirm = await admin.call('/api/ai-edit/grants', {
    method: 'POST',
    body: { capability: 'edit_content' },
  });
  check('高风险能力不带 confirm 返回 400', highRiskNoConfirm.status === 400, `实际 ${highRiskNoConfirm.status}`);

  const badQuota = await admin.call('/api/ai-edit/grants', {
    method: 'POST',
    body: { capability: 'read_post', dailyQuota: 1.5 },
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
  check('其余五项仍然关闭', capsAfter.data.capabilities.filter((item) => item.granted).length === 1);

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
  //    （原来是客户端说自己是啥就是啥：只授权了 read_post 这种低风险·读能力的人，
  //     把 capability 填成 read_post 就能落盘一次内容改写。所以这里必须用一个
  //     「有 read_post、没有 edit_content」的用户来打，否则旧代码也能过、钉不住。）
  await alice.call('/api/ai-edit/grants', { method: 'POST', body: { capability: 'read_post' } });
  const forgedCap = await alice.call('/api/ai-edit/ops', {
    method: 'POST',
    body: {
      capability: 'read_post',
      documentId: 'doc-r1',
      blockId: 'regress-1',
      before: BLOCK_BEFORE,
      after: BLOCK_AFTER,
      confirm: true,
    },
  });
  check(
    '只授权了 read_post 的用户，伪造 capability=read_post 也改不动（403）',
    forgedCap.status === 403,
    `实际 ${forgedCap.status}`,
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
  check('after 的 type 不在 12 个里 → 400', badAfterType.status === 400, `实际 ${badAfterType.status}`);

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
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (modelMode === 'hang') return; // 故意不回，用来触发 504
      if (modelMode === 'unauthorized') return send(401, { error: { message: 'bad key' } });
      if (modelMode === 'ratelimited') return send(429, { error: { message: 'slow down' } });
      if (modelMode === 'upstream') return send(500, { error: { message: 'boom' } });
      if (modelMode === 'badjson') return send(200, { choices: [{ message: { content: '这不是 JSON' } }] });
      // 合法的 JSON，但块类型是模型自造的 `vote`（12 个合法 type 里没有它）。
      if (modelMode === 'unknownType') {
        return send(200, { choices: [{ message: { content: '{"type":"vote","props":{}}' } }] });
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

  /* ---------- 19. 块类型清单不许漂移（静态哨兵 + 行为级对拍） ---------- */
  //
  // `AI_BLOCK_TYPES` 是从 P2 的 `src/modules/doc/blocks/types.js` **抄的一份**
  // （骨架规范禁止 import 隔壁模块的文件，所以只能复制）。抄来的东西会漂：
  // P2 以后加/改块类型，我的提示词就会教模型输出错的东西，而错是静默的 ——
  // 模型照着新名字吐，落盘时才炸。这一节让漂移在测试里立刻红，而不是等线上。
  check('从 P2 的 types.js 抓到 12 个内置块类型名', P2_BLOCK_TYPE_NAMES.length === 12, JSON.stringify(P2_BLOCK_TYPE_NAMES));
  check('从 AI 的 schema.js 抓到 12 个类型名', AI_BLOCK_TYPE_NAMES.length === 12, JSON.stringify(AI_BLOCK_TYPE_NAMES));
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
    '运行时导出的 AI_BLOCK_TYPE_NAMES 与 P2 的清单一致（白名单真的只放行这 12 个）',
    JSON.stringify(AI_RUNTIME_TYPE_NAMES) === JSON.stringify(P2_BLOCK_TYPE_NAMES),
    `运行时=${JSON.stringify(AI_RUNTIME_TYPE_NAMES)} P2=${JSON.stringify(P2_BLOCK_TYPE_NAMES)}`,
  );

  // 行为级对拍：清单的真实出口是 P2 的 `GET /api/docs/meta/block-types`。
  // 它给的是「内置 ∪ 库里注册的」，所以只比 `builtin: true` 的那 12 个 ——
  // 静默漂移的另一半是「接口加了类型、AI 的清单没跟上」。
  const metaTypes = await admin.call('/api/docs/meta/block-types');
  check('GET /api/docs/meta/block-types 返回 200', metaTypes.status === 200, `实际 ${metaTypes.status}`);
  const metaBuiltinNames = (metaTypes.data?.types ?? []).filter((item) => item.builtin).map((item) => item.name);
  check(
    '接口给的内置类型清单和 AI 的清单逐项一致',
    JSON.stringify(metaBuiltinNames) === JSON.stringify(AI_BLOCK_TYPE_NAMES),
    `接口=${JSON.stringify(metaBuiltinNames)} AI=${JSON.stringify(AI_BLOCK_TYPE_NAMES)}`,
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
    budgetUsage.data?.budget?.limit === BUDGET_LIMIT,
    String(budgetUsage.data?.budget?.limit),
  );
  check(
    'budget.used 等于已经计费的落盘次数',
    budgetUsage.data?.budget?.used === BUDGET_LIMIT,
    String(budgetUsage.data?.budget?.used),
  );
  check('budget.remaining 归零', budgetUsage.data?.budget?.remaining === 0, String(budgetUsage.data?.budget?.remaining));
  check('配了上限时 unlimited 是 false', budgetUsage.data?.budget?.unlimited === false, String(budgetUsage.data?.budget?.unlimited));
  check(
    '预览没有被算进 today.billed',
    budgetUsage.data?.today?.billed === BUDGET_LIMIT,
    String(budgetUsage.data?.today?.billed),
  );

  /* ---------- 21. /api/ai-edit/usage 的权限与形状 ---------- */
  //
  // 全站用量只有管理团队能看：这是「谁在用这把 key」的账单视角。
  // 口径要与用户额度、全站预算逐字一致（billed 只数 AI_QUOTA_ACTIONS 里没失败的行）。
  const anonUsage = await createClient().call('/api/ai-edit/usage');
  check('未登录看全站用量返回 401', anonUsage.status === 401, `实际 ${anonUsage.status}`);
  check('未登录的错误代号是 unauthenticated', anonUsage.error?.code === 'unauthenticated', String(anonUsage.error?.code));

  const aliceUsage = await alice.call('/api/ai-edit/usage');
  check('普通用户 alice 看全站用量返回 403', aliceUsage.status === 403, `实际 ${aliceUsage.status}`);
  check('普通用户的错误代号是 forbidden', aliceUsage.error?.code === 'forbidden', String(aliceUsage.error?.code));

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
  check('管理员看全站用量返回 200', usage.status === 200, `实际 ${usage.status} ${JSON.stringify(usage.error ?? null)}`);
  check('scope 是 site（全站口径，不是「我自己的」）', usage.data?.scope === 'site', String(usage.data?.scope));
  check(
    'budget.envKey 是 AI_DAILY_TOTAL_LIMIT',
    usage.data?.budget?.envKey === 'AI_DAILY_TOTAL_LIMIT',
    String(usage.data?.budget?.envKey),
  );
  check(
    '没配全站上限时 unlimited=true 且 remaining=null',
    usage.data?.budget?.unlimited === true && usage.data?.budget?.remaining === null,
    JSON.stringify(usage.data?.budget ?? null),
  );
  const usageToday = usage.data?.today ?? {};
  check(
    'today 的计数字段是数字、列表字段是数组',
    typeof usageToday.total === 'number' &&
      typeof usageToday.billed === 'number' &&
      typeof usageToday.blocked === 'number' &&
      typeof usageToday.users === 'number' &&
      Array.isArray(usageToday.byAction) &&
      Array.isArray(usageToday.topUsers),
    JSON.stringify(usageToday),
  );
  check('today.billed 大于 0（刚制造的落盘算进去了）', usageToday.billed > 0, String(usageToday.billed));
  check(
    'today.total 不小于 today.billed（total 是当天全部日志行）',
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
    'note 说清了「只有次数、没有金额」',
    typeof usage.data?.note === 'string' && usage.data.note.includes('token'),
    String(usage.data?.note),
  );

  /* ---------- 22. 落盘契约：writeTo 与审计里的干净块 ---------- */
  //
  // `/ops` 自己**不改文档**（documents / document_blocks 归 P2），它只写审计，
  // 并把「该往哪写」告诉前端。所以 `writeTo` 是这条接口和后端文档模块之间
  // 唯一的接口约定，必须钉住它的真实形状（不是猜的）。
  const contractBefore = { type: 'paragraph', props: { text: '旧文案' } };
  const contractAfter = { type: 'poll', props: { question: '选哪个？', options: ['A', 'B'] } };
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
  check('审计里的 after 就是 {type, props} 本身', sameJson(contractRow?.after, contractAfter), JSON.stringify(contractRow?.after));
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
    sameJson(dirtyRow?.after, contractAfter) && sameJson(dirtyRow?.before, contractBefore),
    `after=${JSON.stringify(dirtyRow?.after)} before=${JSON.stringify(dirtyRow?.before)}`,
  );

  await finish(failures.length ? 1 : 0);
} catch (error) {
  console.log(`❌ 测试自己崩了：${error.stack ?? error.message}`);
  await finish(1);
}
