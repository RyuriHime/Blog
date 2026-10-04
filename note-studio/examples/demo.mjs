/**
 * 应用样例：端到端跑通 note-studio 的三条主线。
 *
 *   1) 图片 → Markdown / LaTeX   （复用既有 forum-ai 的 chat()）
 *   2) AI 整理 + AI 审阅          （同上）
 *   3) 保存为一个 .md 与一个记录基础数据的 .json
 *
 * 为了不需要真实密钥，本样例自带一个**假 AI 服务**（OpenAI 兼容），
 * 通过 AI_BASE_URL 指过去即可；真实环境把 AI_BASE_URL / AI_API_KEY / AI_MODEL 换成自己的就行。
 *
 * 运行：node examples/demo.mjs
 */
import http from 'node:http';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createAiBridge } from '../src/ai-bridge.mjs';
import { createNoteStore } from '../src/store.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, 'output');

/* ------------------------------------------------------------------ */
/* 1. 假 AI 服务（OpenAI 兼容）                                        */
/* ------------------------------------------------------------------ */

const MARKDOWN_REPLY = [
  '识别完成：',
  '',
  '```markdown',
  '# 电磁感应实验记录',
  '',
  '线圈匝数 $N = 200$，磁通量变化率 $\\frac{d\\Phi}{dt}$ 与感应电动势的关系：',
  '',
  '$$',
  '\\varepsilon = -N\\frac{d\\Phi}{dt}',
  '$$',
  '',
  '- [x] 记录初始磁通量',
  '- [ ] 计算平均电动势',
  '```',
  '',
  '```latex',
  '\\varepsilon = -N\\frac{\\mathrm{d}\\Phi}{\\mathrm{d}t}',
  '```',
].join('\n');

const ORGANIZE_REPLY = JSON.stringify({
  title: '电磁感应实验记录（整理版）',
  summary: '记录法拉第电磁感应定律的验证过程，给出匝数、磁通量与感应电动势的关系式。',
  knowledgePoints: ['法拉第电磁感应定律', '磁通量', '感应电动势', '楞次定律'],
  tags: ['电磁学', '实验记录', '法拉第定律'],
  outline: ['实验目的', '实验装置与参数', '数据记录', '结论与误差分析'],
  suggestedMarkdown: [
    '# 电磁感应实验记录（整理版）',
    '',
    '## 实验目的',
    '验证法拉第电磁感应定律 $\\varepsilon = -N\\frac{d\\Phi}{dt}$。',
    '',
    '## 装置与参数',
    '线圈匝数 $N = 200$；磁铁快速插入与抽出。',
    '',
    '## 结论',
    '感应电动势与磁通量变化率成正比，方向由楞次定律决定。',
    '',
  ].join('\n'),
});

const REVIEW_REPLY = JSON.stringify({
  score: 84,
  strengths: ['公式与实验参数交代清楚', '结论与定律对应明确'],
  issues: [
    { level: 'major', where: '数据记录', problem: '缺少测量误差与不确定度', suggestion: '补充仪器精度与重复测量的标准差' },
    { level: 'minor', where: '结论', problem: '没有讨论楞次定律的方向验证', suggestion: '补一句电流方向与磁通变化方向的关系' },
  ],
  suggestions: ['补一张 $\\varepsilon$ 随时间变化的曲线', '标注实验日期与室温'],
});

function startFakeAi() {
  const server = http.createServer(async (req, res) => {
    if (!req.url.includes('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    const system = body.messages?.find((message) => message.role === 'system')?.content ?? '';
    const user = body.messages?.find((message) => message.role === 'user')?.content;
    const hasImage = Array.isArray(user) && user.some((part) => part.type === 'image_url');

    let content = REVIEW_REPLY;
    if (hasImage) content = MARKDOWN_REPLY;
    else if (system.includes('整理')) content = ORGANIZE_REPLY;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      model: hasImage ? 'demo-vision' : 'demo-chat',
      choices: [{ message: { role: 'assistant', content } }],
      usage: { prompt_tokens: 128, completion_tokens: 256 },
    }));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}/v1`, close: () => new Promise((done) => server.close(done)) });
    });
  });
}

/* ------------------------------------------------------------------ */
/* 2. 找出仓库里既有的 forum-ai（不允许自建 AI 接口，只能复用它）      */
/* ------------------------------------------------------------------ */

async function resolveForumAi(env) {
  const candidates = [
    env.FORUM_AI_PATH,
    join(HERE, '..', '..', 'forum-ai', 'src', 'index.mjs'),
    join(HERE, '..', '..', '.inspect', 'forum-ai', 'src', 'index.mjs'),
    join(HERE, '..', '..', '.inspect', 'forum-ai-full', 'forum', 'forum-ai', 'src', 'index.mjs'),
    join(HERE, '..', '..', '.merge-ai', 'forum', 'forum-ai', 'src', 'index.mjs'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const loaded = await import(new URL(`file://${candidate.replace(/\\/g, '/')}`).href);
      if (typeof loaded.chat === 'function') return { loaded, path: candidate };
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 3. 跑一遍                                                           */
/* ------------------------------------------------------------------ */

const line = (text = '') => console.log(text);
const rule = (title) => {
  line('');
  line(`── ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}`);
};

// 先确认既有 AI 接口在不在：本包按约定**不自带** AI 客户端，只复用仓库里的 forum-ai。
// 找不到时给出可操作的指引，而不是抛一个带堆栈的错。
const found = await resolveForumAi({ FORUM_AI_PATH: process.env.FORUM_AI_PATH });
if (!found) {
  console.error('');
  console.error('✘ 没有找到既有的 AI 接口 forum-ai。');
  console.error('  本包不自带 AI 客户端（按约定只复用仓库里既有的 forum-ai），因此这个端到端样例需要它。');
  console.error('  任选其一：');
  console.error('    1) 把 note-studio 与 forum-ai 放在同一仓（forum-ai 与它同级）；');
  console.error('    2) 指定路径：set FORUM_AI_PATH=D:\\path\\to\\forum-ai\\src\\index.mjs');
  console.error('  只想看编辑、渲染与导出的话，不需要 AI：直接双击 public/playground.html。');
  console.error('');
  process.exit(1);
}

const fake = await startFakeAi();
const env = {
  AI_API_KEY: 'demo-key-not-real',
  AI_BASE_URL: fake.baseUrl,
  AI_MODEL: 'demo-vision',
  AI_TIMEOUT_MS: '10000',
  AI_MAX_TOKENS: '2000',
};

const { loaded, path } = found;
const bridge = createAiBridge({ chat: loaded.chat, extractJson: loaded.extractJson, aiStatus: loaded.aiStatus, env });

rule('环境');
line(`既有 AI 接口：${path.replace(process.cwd(), '.')}`);
line(`配置：AI_BASE_URL=${env.AI_BASE_URL}  AI_MODEL=${env.AI_MODEL}  （密钥来自 AI_API_KEY，不落盘）`);
line(`AI 状态：${JSON.stringify(bridge.status())}`);

await mkdir(OUT_DIR, { recursive: true });

/* --- 3.1 图片 → Markdown / LaTeX --- */
rule('图片 → Markdown / LaTeX');
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const converted = await bridge.convertImage({ dataUrl: png, kind: 'both', source: '实验台照片.png' });
line(`模型：${converted.model}   用量：prompt=${converted.usage.prompt} completion=${converted.usage.completion}`);
line('');
line('识别出的 Markdown：');
line(converted.markdown.split('\n').map((text) => `  ${text}`).join('\n'));
line('');
line(`识别出的 LaTeX：${converted.latex}`);

/* --- 3.2 AI 整理 --- */
rule('AI 整理');
const organized = await bridge.organizeNote({ title: '实验记录草稿', content: converted.markdown });
line(`标题：${organized.title}`);
line(`摘要：${organized.summary}`);
line(`知识点：${organized.knowledgePoints.join(' / ')}`);
line(`标签：${organized.tags.join(' / ')}`);
line(`大纲：${organized.outline.join(' → ')}`);

/* --- 3.3 AI 审阅 --- */
rule('AI 审阅');
const review = await bridge.reviewNote({ title: organized.title, content: organized.suggestedMarkdown });
line(`评分：${review.score} / 100`);
line(`优点：${review.strengths.join('；')}`);
for (const issue of review.issues) line(`问题[${issue.level}] ${issue.where}：${issue.problem} → ${issue.suggestion}`);
line(`建议：${review.suggestions.join('；')}`);

/* --- 3.4 保存成一个 .md 与一个 .json --- */
rule('保存交付物');
await rm(join(OUT_DIR, 'demo-note.md'), { force: true });
await rm(join(OUT_DIR, 'demo-note.json'), { force: true });

const store = createNoteStore({ dir: OUT_DIR });
const saved = await store.save({
  name: 'demo-note',
  markdown: organized.suggestedMarkdown,
  ai: [{ kind: converted.kind, model: converted.model, at: converted.at, source: converted.source }],
});

const meta = JSON.parse(await readFile(saved.jsonPath, 'utf8'));
line(`${saved.mdPath}`);
line(`${saved.jsonPath}`);
line('');
line(`json 里的基础数据：`);
line(`  schema      ${meta.schema}`);
line(`  title       ${meta.title}`);
line(`  bytes/lines ${meta.file.bytes} / ${meta.file.lines}`);
line(`  sha256      ${meta.file.sha256.slice(0, 16)}…`);
line(`  统计        字符 ${meta.stats.characters} · 词 ${meta.stats.words} · 段落 ${meta.stats.paragraphs} · 阅读 ${meta.stats.readingMinutes} 分钟`);
line(`  结构        标题 ${meta.structure.headings.length} 个，最大层级 ${meta.structure.maxDepth}`);
line(`  公式        行内 ${meta.math.inline} · 块级 ${meta.math.display}`);
line(`  任务        ${meta.tasks.checked}/${meta.tasks.total}`);
line(`  AI 记录     ${meta.ai.conversions.length} 条（模型 ${meta.ai.conversions[0].model}）`);

await fake.close();
rule('完成');
line('样例产物在 examples/output/ 下：一个 .md，一个 .json。');
line('');
