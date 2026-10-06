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
 */
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const SERVER = join(ROOT, 'src', 'server.js');
const DB_FILE = join(ROOT, 'data', 'ai-smoke.db');
const AVATAR_DIR = join(ROOT, 'data', 'ai-smoke-avatars');
const NOTES_DIR = join(ROOT, 'data', 'ai-smoke-notes');
const LOG_FILE = join(ROOT, 'data', 'ai-smoke-server.log');
const PORT = Number(process.env.AI_SMOKE_PORT || 3423);
const BASE = `http://127.0.0.1:${PORT}`;

const ALL_CAPABILITIES = ['read_post', 'read_site', 'network', 'edit_content', 'site_tools', 'publish'];

let passed = 0;
const failures = [];
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function createClient() {
  let cookie = '';
  return {
    async call(path, { method = 'GET', body } = {}) {
      const response = await fetch(BASE + path, {
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

async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/api/site`);
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
  await sleep(400);
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(DB_FILE + suffix, { force: true });
    } catch {
      /* 忽略 */
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
  const denied = await admin.call('/api/ai-edit/ops', {
    method: 'POST',
    body: { capability: 'edit_content', after: { text: '改一下' }, confirm: true },
  });
  check('未授权时提交操作被拒 403', denied.status === 403, `实际 ${denied.status}`);
  check('拒绝代号是 forbidden', denied.error?.code === 'forbidden', String(denied.error?.code));

  const deniedDraft = await admin.call('/api/ai-edit/draft', {
    method: 'POST',
    body: { instruction: '把这块改成投票' },
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
  const preview = await admin.call('/api/ai-edit/ops', {
    method: 'POST',
    body: {
      capability: 'edit_content',
      targetType: 'document_block',
      targetId: 'block-7',
      before: { blockType: 'text', content: { text: '旧文案' } },
      after: { blockType: 'vote', content: { options: ['A', 'B'] } },
    },
  });
  check('不带 confirm 时返回的是预览', preview.status === 200 && preview.data?.applied === false, JSON.stringify(preview.data));
  check('预览回带了改动前后', preview.data?.preview?.before?.content?.text === '旧文案', JSON.stringify(preview.data?.preview));
  check('预览没有落盘（状态是 preview）', typeof preview.data?.opId === 'number', String(preview.data?.opId));

  const applied = await admin.call('/api/ai-edit/ops', {
    method: 'POST',
    body: {
      capability: 'edit_content',
      targetType: 'document_block',
      targetId: 'block-7',
      before: { blockType: 'text', content: { text: '旧文案' } },
      after: { blockType: 'vote', content: { options: ['A', 'B'] } },
      confirm: true,
    },
  });
  check('带 confirm 时落盘', applied.status === 200 && applied.data?.applied === true, JSON.stringify(applied.data));
  const opId = applied.data?.opId;
  check('落盘返回了操作 id', Number.isInteger(opId), String(opId));

  const badAfter = await admin.call('/api/ai-edit/ops', {
    method: 'POST',
    body: { capability: 'edit_content', after: ['整篇重写'], confirm: true },
  });
  check('after 不是对象时返回 400（只接受块级改动）', badAfter.status === 400, `实际 ${badAfter.status}`);

  /* ---------- 8. 审计日志 ---------- */
  const ops = await admin.call('/api/ai-edit/ops');
  check('操作日志返回 200', ops.status === 200, `实际 ${ops.status}`);
  const logged = (ops.data?.ops ?? []).find((row) => row.id === opId);
  check('落盘的操作能在日志里查到', Boolean(logged), JSON.stringify(ops.data?.ops?.map((row) => row.id)));
  check('日志里记着改动前的旧值', logged?.before?.content?.text === '旧文案', JSON.stringify(logged?.before));
  check('日志里记着改动后的新值', logged?.after?.blockType === 'vote', JSON.stringify(logged?.after));
  check('日志里记着目标块', logged?.targetId === 'block-7', String(logged?.targetId));
  check('被授权前的那条预览也在日志里', (ops.data.ops ?? []).some((row) => row.status === 'preview'));

  /* ---------- 9. 回滚 ---------- */
  const missing = await admin.call('/api/ai-edit/ops/999999/rollback', { method: 'POST' });
  check('回滚不存在的操作返回 404', missing.status === 404, `实际 ${missing.status}`);

  const rollback = await admin.call(`/api/ai-edit/ops/${opId}/rollback`, { method: 'POST' });
  check('回滚成功', rollback.status === 200 && rollback.data?.rolledBack === true, JSON.stringify(rollback.data));
  check('回滚交回了改动前的旧值', rollback.data?.restore?.content?.text === '旧文案', JSON.stringify(rollback.data?.restore));
  check('回滚交回了目标块', rollback.data?.targetId === 'block-7', String(rollback.data?.targetId));

  const again = await admin.call(`/api/ai-edit/ops/${opId}/rollback`, { method: 'POST' });
  check('重复回滚返回 409', again.status === 409, `实际 ${again.status}`);

  const opsAfter = await admin.call('/api/ai-edit/ops');
  const rolled = (opsAfter.data?.ops ?? []).find((row) => row.id === opId);
  check('回滚后状态变成 rolled_back', rolled?.status === 'rolled_back', String(rolled?.status));
  check('回滚后不再可回滚', rolled?.canRollback === false, String(rolled?.canRollback));

  /* ---------- 10. 每日配额 ---------- */
  const grantQuota = await admin.call('/api/ai-edit/grants', {
    method: 'POST',
    body: { capability: 'read_post', dailyQuota: 1 },
  });
  check('可以给能力设每日配额（FR-CAP-04）', grantQuota.status === 200, JSON.stringify(grantQuota.error ?? null));

  const firstUse = await admin.call('/api/ai-edit/ops', {
    method: 'POST',
    body: { capability: 'read_post', targetType: 'post', targetId: '1', after: { read: true }, confirm: true },
  });
  check('配额内第一次调用成功', firstUse.status === 200, `实际 ${firstUse.status}`);

  const secondUse = await admin.call('/api/ai-edit/ops', {
    method: 'POST',
    body: { capability: 'read_post', targetType: 'post', targetId: '1', after: { read: true }, confirm: true },
  });
  check('超配额返回 429', secondUse.status === 429, `实际 ${secondUse.status}`);
  check('超配额的错误代号是 ai_rate_limited', secondUse.error?.code === 'ai_rate_limited', String(secondUse.error?.code));

  /* ---------- 11. 未配置模型 → 503 ai_not_configured ---------- */
  const draft = await admin.call('/api/ai-edit/draft', {
    method: 'POST',
    body: { blockId: 'block-7', instruction: '把这块改成投票' },
  });
  check('没配 AI_API_KEY 时返回 503（不是 500）', draft.status === 503, `实际 ${draft.status}`);
  check('错误代号是 ai_not_configured', draft.error?.code === 'ai_not_configured', String(draft.error?.code));

  /* ---------- 12. 收回授权（立即失效，FR-CAP-03） ---------- */
  const revoke = await admin.call('/api/ai-edit/grants/edit_content', { method: 'DELETE' });
  check('收回授权成功', revoke.status === 200 && revoke.data?.revoked === true, JSON.stringify(revoke.error ?? null));

  const afterRevoke = await admin.call('/api/ai-edit/ops', {
    method: 'POST',
    body: { capability: 'edit_content', after: { text: '还想改' }, confirm: true },
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
    body: { capability: 'edit_content', after: { text: '越权' }, confirm: true },
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

  await finish(failures.length ? 1 : 0);
} catch (error) {
  console.log(`❌ 测试自己崩了：${error.stack ?? error.message}`);
  await finish(1);
}
