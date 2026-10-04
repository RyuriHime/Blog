/**
 * AI 适配器（`src/ai.mjs` + 兜底 `src/ai-local.mjs` / `src/json-local.mjs`）的测试。
 *
 * 这块代码的存在理由只有一个：**这个文件夹要能整个拷给同事**。
 * 拷走的机器上没有 `forum-ai` 兄弟目录，如果 AI 层硬 import 它，那么
 * `/generate`、`/turn`、`/review` 全都会在 import 阶段就炸 —— 面板变成一个只能看的东西。
 *
 * 所以这里要钉死两件事：
 *   1. 有 forum-ai 时**必须**用它（不能因为有了兜底就悄悄换掉真实实现）；
 *   2. 没有 forum-ai 时，兜底实现的**请求形状与错误码与 forum-ai 完全一致** —— 一致到
 *      上层 orchestrator / review 不需要知道自己跟谁说话。
 *
 * 第 2 条的对照不靠"读源码比对"（那种断言一改注释就红），而是把真实实现与兜底实现
 * 跑在**同一批固定样本**上比输出。
 */
import { existsSync } from 'node:fs';
import { createChecker } from './helpers/check.mjs';
import { aiConfig, aiStatus, loadAi, aiSource } from '../src/ai.mjs';
import * as bundled from '../src/ai-local.mjs';
import { extractJson as bundledExtractJson } from '../src/json-local.mjs';
import { createNotesStore } from '../src/store-sqlite.mjs';
import { createHandlers, handle } from '../src/routes.mjs';
import { DatabaseSync } from 'node:sqlite';

const { check, summary } = createChecker();

// ── 1. 选路：与"forum-ai 在不在旁边"这个文件系统事实一致 ──────────────
// 适配器的探测是动态 import，在一次微任务后落地 —— 先让出一次再断言。
await new Promise((resolve) => { setTimeout(resolve, 50); });

const forumAiHere = existsSync(new URL('../../forum-ai/src/ai.mjs', import.meta.url));
check(
  '选中的实现与 forum-ai 是否在场一致（有真实现就不许用兜底）',
  aiSource() === (forumAiHere ? 'forum-ai' : 'bundled'),
  `aiSource()=${aiSource()}，forum-ai ${forumAiHere ? '在' : '不在'}`,
);
check('适配器暴露的两套字段齐全', (() => {
  const impl = loadAi();
  return ['chat', 'aiConfig', 'aiStatus', 'AiError', 'extractJson'].every((key) => typeof impl[key] === 'function')
    && typeof impl.NOT_CONFIGURED_MESSAGE === 'string';
})(), JSON.stringify(Object.keys(loadAi())));

// ── 2. 兜底实现的形状：与 forum-ai 同款字段、同款错误码 ───────────────
const config = bundled.aiConfig({ AI_API_KEY: 'sk-test', AI_BASE_URL: 'https://example.com/v1/' });
check(
  '兜底 aiConfig 的字段与 forum-ai 一致（key/baseUrl/model/timeoutMs/maxTokens/configured）',
  config.apiKey === 'sk-test'
    && config.baseUrl === 'https://example.com/v1'
    && config.model === 'deepseek-chat'
    && config.timeoutMs === 60000
    && config.maxTokens === 2000
    && config.configured === true,
  JSON.stringify(config),
);
check(
  '兜底 aiStatus 不回传密钥',
  (() => {
    const status = bundled.aiStatus({ AI_API_KEY: 'sk-test', AI_MODEL: 'deepseek-flash' });
    return status.configured === true && status.model === 'deepseek-flash' && !('apiKey' in status);
  })(),
);
// 适配器对外暴露的 aiConfig / aiStatus 必须与选中的实现同源
check('适配器的 aiConfig 与 aiStatus 走的是选中实现', aiConfig({ AI_API_KEY: 'sk-a' }).apiKey === 'sk-a' && aiStatus({ AI_API_KEY: 'sk-a' }).configured === true);

const noKey = { AI_API_KEY: '' };
let notConfigured = null;
try {
  await bundled.chat([{ role: 'user', content: 'hi' }], { env: noKey, fetchImpl: () => { throw new Error('不该发请求'); } });
} catch (error) {
  notConfigured = error;
}
check(
  '没配密钥时抛 ai_not_configured（发请求之前就抛）',
  notConfigured instanceof bundled.AiError && notConfigured.code === 'ai_not_configured',
  notConfigured?.code,
);

// ── 3. 请求形状：URL / 头 / body 与 forum-ai 逐字段一致 ───────────────
const okPayload = {
  model: 'deepseek-flash',
  choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 123, completion_tokens: 456 },
};
const seen = [];
const fakeOk = async (url, init) => {
  seen.push({ url, init });
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(okPayload),
  };
};
const reply = await bundled.chat([{ role: 'user', content: '整理一下' }], {
  env: { AI_API_KEY: 'sk-x', AI_BASE_URL: 'https://api.deepseek.com', AI_MODEL: 'deepseek-flash' },
  fetchImpl: fakeOk,
  maxTokens: 16000,
});
check('请求打在 {baseUrl}/chat/completions', seen[0].url === 'https://api.deepseek.com/chat/completions', seen[0].url);
check(
  '请求头带 Bearer 与 JSON 类型',
  seen[0].init.headers.Authorization === 'Bearer sk-x' && seen[0].init.headers['Content-Type'] === 'application/json',
  JSON.stringify(seen[0].init.headers),
);
check(
  '请求体默认按 JSON 模式（response_format=json_object），模型与预算来自配置',
  (() => {
    const body = JSON.parse(seen[0].init.body);
    return body.model === 'deepseek-flash'
      && body.max_tokens === 16000
      && body.temperature === 0.2
      && body.response_format?.type === 'json_object'
      && body.messages[0].content === '整理一下';
  })(),
  seen[0].init.body.slice(0, 120),
);
check(
  '返回形状与 forum-ai 一致：text / model / usage{prompt,completion} / raw',
  reply.text === '{"ok":true}' && reply.model === 'deepseek-flash'
    && reply.usage.prompt === 123 && reply.usage.completion === 456
    && reply.raw?.choices?.[0]?.finish_reason === 'stop',
  JSON.stringify({ text: reply.text, model: reply.model, usage: reply.usage }),
);
let sawJsonFalse = null;
await bundled.chat([{ role: 'user', content: 'x' }], {
  env: { AI_API_KEY: 'sk-x' },
  json: false,
  fetchImpl: async (url, init) => {
    sawJsonFalse = JSON.parse(init.body);
    return { ok: true, status: 200, text: async () => JSON.stringify(okPayload) };
  },
});
check('json:false 时不带 response_format', sawJsonFalse && !('response_format' in sawJsonFalse), JSON.stringify(sawJsonFalse));

// ── 4. 错误映射：状态码 → 错误码，与 ERROR_STATUS 表对得上 ─────────────
const errorCases = [
  [401, 'ai_unauthorized'],
  [403, 'ai_unauthorized'],
  [429, 'ai_rate_limited'],
  [500, 'ai_upstream_error'],
];
for (const [status, code] of errorCases) {
  let caught = null;
  try {
    await bundled.chat([{ role: 'user', content: 'x' }], {
      env: { AI_API_KEY: 'sk-x' },
      fetchImpl: async () => ({ ok: false, status, text: async () => '{"error":"boom"}' }),
    });
  } catch (error) {
    caught = error;
  }
  check(`HTTP ${status} 映射成 ${code}`, caught?.code === code, caught?.code);
}

async function expectCode(run) {
  try {
    await run();
    return '(没有抛错)';
  } catch (error) {
    return error?.code ?? `(无 code: ${error?.message})`;
  }
}

check('上游不是 JSON → ai_bad_response', await expectCode(() => bundled.chat([{ role: 'user', content: 'x' }], {
  env: { AI_API_KEY: 'sk-x' },
  fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<html>502 Bad Gateway</html>' }),
})) === 'ai_bad_response');

check('正文为空 → ai_empty_response（推理模型思维链吃光预算就是这种）', await expectCode(() => bundled.chat([{ role: 'user', content: 'x' }], {
  env: { AI_API_KEY: 'sk-x' },
  fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '   ' } }] }) }),
})) === 'ai_empty_response');

check('网络层抛错 → ai_unreachable', await expectCode(() => bundled.chat([{ role: 'user', content: 'x' }], {
  env: { AI_API_KEY: 'sk-x' },
  fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND'); },
})) === 'ai_unreachable');

check('超时（AbortError）→ ai_timeout', await expectCode(() => bundled.chat([{ role: 'user', content: 'x' }], {
  env: { AI_API_KEY: 'sk-x' },
  fetchImpl: async () => { const error = new Error('aborted'); error.name = 'AbortError'; throw error; },
})) === 'ai_timeout');

check('AiError 是 Error 子类且带 code（路由层靠它映射状态码）', (() => {
  const error = new bundled.AiError('ai_rate_limited', '太快了');
  return error instanceof Error && error.name === 'AiError' && error.code === 'ai_rate_limited' && error.message === '太快了';
})());

// ── 5. 严格 JSON 抠取：兜底实现与 forum-ai 行为一致 ───────────────────
// 这一层被 `src/json.mjs` 用作"第一道"解析，两套实现输出不一致就会变成
// "在论坛里能跑、拷走就报 502"这种最难查的 bug。样本覆盖真实的四种形态。
const SAMPLES = [
  '{"a":1}',
  '```json\n{"a":2}\n```',
  '好的：{"a":3} 就这样',
  '这不是 JSON',
  '',
  '{"summary":"只写了一半',
  '{"summary":"没有结束引号}',
  '[{"a":1}]',
  '前言 {"depth":{"nested":[1,2]}} 后记',
  '{"text":"带 } 花括号和 { 反括号的字符串"}',
  '{"escaped":"a\\"b"}',
  '```\n{"fence":"no lang"}\n```',
];
const realExtract = loadAi().extractJson;
const mismatched = SAMPLES.filter((sample) => {
  const mine = bundledExtractJson(sample);
  const theirs = realExtract(sample);
  return JSON.stringify(mine) !== JSON.stringify(theirs);
});
check(
  '兜底 extractJson 与 forum-ai 在同一批样本上输出完全一致',
  mismatched.length === 0,
  mismatched.map((sample) => JSON.stringify(sample.slice(0, 30))).join('、'),
);
check('兜底 extractJson 对真机原文（未转义引号）也是 null —— 抢救交给 json.mjs', bundledExtractJson('{"quote":"他说"你好""}') === null);

// ── 6. 端到端：不注入 chatImpl，让 /generate 真的走适配器挑出来的实现 ──
// 前面的断言都是零件级的（aiConfig / chat / extractJson）。这一条是总装：
// routes → orchestrator 的默认参数 `chatImpl = chat` → src/ai.mjs → 选中的实现。
// 用假 fetch 顶掉网络，于是"兜底实现能不能把一次真实调用跑完"是可核对的：
// 请求体按 OpenAI 形状、正文是 JSON、回来变成 draftMd。论坛里跑的是同一段代码，
// 只是那时 fetch 指向真的 API。
const store = createNotesStore({ db: new DatabaseSync(':memory:') });
store.ensureSchema();
const user = { id: 1, name: 'RyuriHime' };
const modelReply = {
  title: '导数与积分',
  tags: ['微积分'],
  ops: [{ kind: 'replace', blockId: 'b2', text: '导数是变化率。' }],
  notes: [],
  warnings: [],
};
let sawDial = null;
const handlers = createHandlers({
  store,
  env: { AI_API_KEY: 'sk-fake', AI_MODEL: 'deepseek-flash' },
  fetchImpl: async (url, init) => {
    sawDial = { url, body: JSON.parse(init.body) };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        model: 'deepseek-flash',
        choices: [{ message: { content: JSON.stringify(modelReply) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      }),
    };
  },
});
const call = (method, pathname, extra = {}) => handle(handlers, {
  method, pathname, query: new URLSearchParams(), body: {}, files: null, user, ip: '127.0.0.1', ...extra,
});
const session = await call('POST', '/session', { body: { draft: '# 导数\n\n导数是变化率' } });
const generated = await call('POST', '/generate', { body: { sessionId: session.body.data.sessionId } });
check(
  '端到端：不注入 chatImpl 时 /generate 仍能走通（适配器 → 选中的实现 → fetch）',
  generated.status === 200 && typeof generated.body.data.draftMd === 'string' && generated.body.data.usage.prompt === 10,
  JSON.stringify(generated.body).slice(0, 160),
);
check(
  '端到端：请求确实打在 {baseUrl}/chat/completions，模型与消息都来自这一轮',
  /\/chat\/completions$/.test(sawDial?.url ?? '')
    && sawDial?.body?.model === 'deepseek-flash'
    && Array.isArray(sawDial?.body?.messages)
    && sawDial.body.messages.length >= 2,
  JSON.stringify({ url: sawDial?.url, model: sawDial?.body?.model, messages: sawDial?.body?.messages?.length }),
);

// ── 7. 请求形状对照：同一组 options 喂给两套实现，必须发出同一个 HTTP 请求 ──
// 这是"换实现不换行为"的最硬等价物。特别值钱的一条：真实实现**默认按 JSON 模式**请求
// （body 里带 response_format），兜底实现必须一模一样 —— 否则在论坛里能跑、拷走就变另一个行为。
const bothOptions = {
  env: { AI_API_KEY: 'sk-x', AI_MODEL: 'm' },
  temperature: 0.3,
  maxTokens: 1234,
  timeoutMs: 5000,
};
const capture = async (impl, options) => {
  let body = null;
  await impl([{ role: 'user', content: '同一条消息' }], {
    ...options,
    fetchImpl: async (url, init) => {
      body = JSON.parse(init.body);
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '{"a":1}' } }], usage: {} }) };
    },
  });
  return body;
};
const bodyOfBundled = await capture(bundled.chat, { ...bothOptions, json: true });
check(
  '兜底实现：json:true 时带 response_format（与 forum-ai 的默认行为一致）',
  bodyOfBundled.response_format?.type === 'json_object',
  JSON.stringify(bodyOfBundled.response_format),
);
check(
  '兜底实现：json:false 时不带 response_format',
  !('response_format' in (await capture(bundled.chat, { ...bothOptions, json: false }))),
);
// 只有在 forum-ai 在场时才能做这条对照（单独拷走的机器上它不在，跳过而不是假红）
if (forumAiHere) {
  const bodyOfReal = await capture(loadAi().chat, { ...bothOptions, json: true });
  check(
    '同一组 options 下，两套实现发出的请求体逐字段相同',
    JSON.stringify(bodyOfReal) === JSON.stringify(bodyOfBundled),
    JSON.stringify(bodyOfReal),
  );
}

summary();
