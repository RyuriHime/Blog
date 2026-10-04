/**
 * ai-bridge 单元测试：本模块**只消费**既有 forum-ai 的 chat() 接口。
 *
 * 关键不变量：
 *   1) 图片转写必须是「自由文本」，所以要显式关掉 chat() 默认的 json_object；
 *   2) 上游错误码原样透传，不重新包装（否则宿主的 503/504/429 映射会失效）；
 *   3) 没注入 chat（= 没配 AI）时，一切 AI 能力都抛 ai_not_configured，且不抛别的错。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  NoteAiError,
  buildImageMessages,
  parseImageResult,
  createAiBridge,
  loadForumChat,
} from '../src/ai-bridge.mjs';

/** 记录调用的假 chat，形状与 forum-ai 的 chat() 一致。 */
function fakeChat(reply = '```markdown\n# 标题\n```', { fail = null } = {}) {
  const calls = [];
  const chat = async (messages, options = {}) => {
    calls.push({ messages, options });
    if (fail) throw fail;
    return { text: reply, model: 'fake-vision', usage: { prompt: 12, completion: 34 } };
  };
  return { chat, calls };
}

/* ------------------------------------------------------------------ */
/* buildImageMessages                                                  */
/* ------------------------------------------------------------------ */

test('buildImageMessages：产出 OpenAI 兼容的多模态消息', () => {
  const messages = buildImageMessages({ dataUrl: 'data:image/png;base64,AAA', kind: 'both' });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[1].role, 'user');
  assert.ok(Array.isArray(messages[1].content));

  const text = messages[1].content.find((part) => part.type === 'text');
  const image = messages[1].content.find((part) => part.type === 'image_url');
  assert.ok(text && text.text.length > 0);
  assert.equal(image.image_url.url, 'data:image/png;base64,AAA');
});

test('buildImageMessages：kind 决定提示词，hint 会带进正文', () => {
  const latex = buildImageMessages({ dataUrl: 'data:image/png;base64,AAA', kind: 'latex' });
  assert.match(latex[0].content, /LaTeX/);
  assert.ok(!/markdown 代码块/.test(latex[0].content));

  const hinted = buildImageMessages({ dataUrl: 'data:image/png;base64,AAA', kind: 'markdown', hint: '只要正文' });
  const text = hinted[1].content.find((part) => part.type === 'text');
  assert.match(text.text, /只要正文/);
});

/* ------------------------------------------------------------------ */
/* parseImageResult                                                    */
/* ------------------------------------------------------------------ */

test('parseImageResult：抽取 markdown / latex 两个围栏', () => {
  const raw = [
    '识别完成：',
    '',
    '```markdown',
    '# 标题',
    '',
    '正文 $E=mc^2$',
    '```',
    '',
    '```latex',
    '\\section{标题}',
    '```',
  ].join('\n');
  const result = parseImageResult(raw, 'both');
  assert.equal(result.markdown, '# 标题\n\n正文 $E=mc^2$');
  assert.equal(result.latex, '\\section{标题}');
});

test('parseImageResult：没有围栏时按 kind 兜底', () => {
  assert.equal(parseImageResult('纯文本结果', 'markdown').markdown, '纯文本结果');
  assert.equal(parseImageResult('纯文本结果', 'markdown').latex, '');
  assert.equal(parseImageResult('纯文本结果', 'latex').latex, '纯文本结果');
  assert.equal(parseImageResult('纯文本结果', 'latex').markdown, '');
  // both 但模型没给围栏：全文当 markdown，latex 留空，不猜
  const both = parseImageResult('纯文本结果', 'both');
  assert.equal(both.markdown, '纯文本结果');
  assert.equal(both.latex, '');
});

/* ------------------------------------------------------------------ */
/* createAiBridge                                                      */
/* ------------------------------------------------------------------ */

test('createAiBridge：没注入 chat 时视为未配置', async () => {
  const bridge = createAiBridge({});
  assert.equal(bridge.configured, false);
  await assert.rejects(
    () => bridge.convertImage({ dataUrl: 'data:image/png;base64,AAA' }),
    (error) => error instanceof NoteAiError && error.code === 'ai_not_configured',
  );
});

test('createAiBridge：图片转写必须关掉 json_object，并回传模型与用量', async () => {
  const { chat, calls } = fakeChat('```markdown\n# 好\n```');
  const bridge = createAiBridge({ chat });
  const result = await bridge.convertImage({ dataUrl: 'data:image/png;base64,AAA', kind: 'markdown' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.json, false);
  assert.equal(result.markdown, '# 好');
  assert.equal(result.model, 'fake-vision');
  assert.deepEqual(result.usage, { prompt: 12, completion: 34 });
  assert.equal(result.kind, 'markdown');
});

test('createAiBridge：上游错误码原样透传，不重新包装', async () => {
  const upstream = Object.assign(new Error('超时了'), { code: 'ai_timeout' });
  const { chat } = fakeChat('', { fail: upstream });
  const bridge = createAiBridge({ chat });
  await assert.rejects(
    () => bridge.convertImage({ dataUrl: 'data:image/png;base64,AAA' }),
    (error) => error === upstream && error.code === 'ai_timeout',
  );
});

test('createAiBridge：organizeNote 走 JSON 模式并归一化字段', async () => {
  const reply = JSON.stringify({
    title: '线性代数笔记',
    summary: '讲矩阵与特征值',
    knowledgePoints: ['矩阵乘法', '特征值', '特征值', '对角化'],
    tags: ['线代', '矩阵'],
    outline: ['矩阵', '特征值'],
    extra: '不该出现',
  });
  const { chat, calls } = fakeChat(reply);
  const bridge = createAiBridge({ chat });
  const result = await bridge.organizeNote({ title: '草稿', content: '正文' });

  assert.equal(calls[0].options.json, true);
  assert.equal(result.title, '线性代数笔记');
  assert.equal(result.summary, '讲矩阵与特征值');
  assert.deepEqual(result.knowledgePoints, ['矩阵乘法', '特征值', '对角化']);
  assert.deepEqual(result.tags, ['线代', '矩阵']);
  assert.equal(result.extra, undefined);
});

test('createAiBridge：organizeNote 容忍模型输出非 JSON 时的失败', async () => {
  const { chat } = fakeChat('这不是 JSON');
  const bridge = createAiBridge({ chat });
  await assert.rejects(
    () => bridge.organizeNote({ title: 't', content: 'c' }),
    (error) => error instanceof NoteAiError && error.code === 'ai_bad_json',
  );
});

test('createAiBridge：可以注入 forum-ai 的 extractJson 做容错', async () => {
  const { chat } = fakeChat('说明文字\n```json\n{"title":"注入解析"}\n```\n结束');
  let used = 0;
  const extractJson = (text) => {
    used += 1;
    return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  };
  const bridge = createAiBridge({ chat, extractJson });
  const result = await bridge.organizeNote({ title: 't', content: 'c' });
  assert.equal(used, 1);
  assert.equal(result.title, '注入解析');
});

test('createAiBridge：reviewNote 返回审查结论', async () => {
  const reply = JSON.stringify({
    score: 82,
    strengths: ['结构清晰'],
    issues: [{ level: 'major', where: '第 2 段', problem: '缺少论据', suggestion: '补一个实验' }],
    suggestions: ['补参考文献'],
  });
  const { chat } = fakeChat(reply);
  const bridge = createAiBridge({ chat });
  const result = await bridge.reviewNote({ title: 't', content: 'c' });
  assert.equal(result.score, 82);
  assert.deepEqual(result.strengths, ['结构清晰']);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].suggestion, '补一个实验');
  assert.deepEqual(result.suggestions, ['补参考文献']);
});

test('createAiBridge：status 不回传密钥', () => {
  const bridge = createAiBridge({ env: { AI_API_KEY: 'sk-secret', AI_MODEL: 'vision-x' } });
  const status = bridge.status();
  assert.equal(status.configured, true);
  assert.equal(status.model, 'vision-x');
  assert.ok(!JSON.stringify(status).includes('sk-secret'));
});

/* ------------------------------------------------------------------ */
/* loadForumChat                                                       */
/* ------------------------------------------------------------------ */

test('loadForumChat：从指定路径加载既有 chat 接口', async () => {
  const seen = [];
  const fakeModule = { chat: async () => ({ text: 'x', model: 'm', usage: {} }) };
  const loaded = await loadForumChat({
    env: { FORUM_AI_PATH: 'file:///fake/forum-ai/src/index.mjs' },
    importModule: async (specifier) => {
      seen.push(specifier);
      return fakeModule;
    },
  });
  assert.equal(seen[0], 'file:///fake/forum-ai/src/index.mjs');
  assert.equal(loaded.chat, fakeModule.chat);
  assert.equal(loaded.source, 'file:///fake/forum-ai/src/index.mjs');
});

test('loadForumChat：找不到既有接口时抛 ai_not_configured，并说明怎么办', async () => {
  await assert.rejects(
    () => loadForumChat({ env: {}, importModule: async () => { throw new Error('ENOENT'); } }),
    (error) => error instanceof NoteAiError
      && error.code === 'ai_not_configured'
      && /forum-ai/.test(error.message),
  );
});
