/**
 * ai-bridge —— note-studio 里**唯一**接触 AI 的模块。
 *
 * 它不自建 AI 客户端：所有模型调用都通过既有 `forum-ai` 包的 `chat(messages, options)`
 * 完成（同一个 OpenAI 兼容网关、同一套 AI_API_KEY / AI_BASE_URL / AI_MODEL / AI_TIMEOUT_MS
 * 配置、同一套错误码）。本文件只负责三件事：
 *
 *   1) 把「图片 / 笔记」翻译成 chat() 认识的 messages；
 *   2) 把模型输出归一化成编辑器要用的结构；
 *   3) 把上游 AiError 原样透传，不重新包装，宿主的 HTTP 映射才能继续生效。
 *
 * 通过依赖注入拿到 chat()：`createAiBridge({ chat })`。独立运行时用 loadForumChat()
 * 从 FORUM_AI_PATH（默认 `../../forum-ai/src/index.mjs`）加载同一个接口。
 */

/** 本模块自己的错误类型：只用于「本层」的问题，上游错误不包装。 */
export class NoteAiError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'NoteAiError';
    this.code = code;
    this.details = details;
  }
}

export const ENV_KEYS = ['AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL', 'AI_TIMEOUT_MS', 'AI_MAX_TOKENS'];

const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';
const DEFAULT_MODEL = 'deepseek-chat';

/** kind → system 提示词。改提示词不需要动任何调用逻辑。 */
export const IMAGE_PROMPTS = {
  both: [
    '你是一个学术笔记助手，负责把图片（扫描件、板书、论文或教材截图）转写成 Markdown 与 LaTeX。',
    '规则：',
    '1. 数学公式一律写成 LaTeX：行内用 $...$，独立成行用 $$...$$；',
    '2. 保持原文的标题层级、列表、表格与代码结构；',
    '3. 不要翻译、不要补充原文没有的内容；看不清的地方用 ... 占位；',
    '4. 输出必须严格使用下面两个围栏，不要写任何额外说明：',
    '```markdown',
    '<Markdown 正文>',
    '```',
    '```latex',
    '<公式或 LaTeX 正文>',
    '```',
  ].join('\n'),
  markdown: [
    '你是一个学术笔记助手，负责把图片转写成 Markdown。',
    '数学公式写成 LaTeX 并放在 $...$ 或 $$...$$ 中；保持标题、列表、表格结构；不要翻译、不要编造内容。',
    '输出必须严格使用下面的围栏，不要写任何额外说明：',
    '```markdown',
    '<Markdown 正文>',
    '```',
  ].join('\n'),
  latex: [
    '你是一个学术笔记助手，负责把图片中的内容转写成 LaTeX 源码。',
    '使用标准的 LaTeX 命令（\\section、\\begin{equation}、\\frac 等），保持公式完整；不要翻译、不要编造内容。',
    '输出必须严格使用下面的围栏，不要写任何额外说明：',
    '```latex',
    '<LaTeX 正文>',
    '```',
  ].join('\n'),
};

export const ORGANIZE_SYSTEM = [
  '你是一个学术笔记整理助手。用户会给你一篇笔记的标题与正文（Markdown + LaTeX）。',
  '请只输出一个 JSON 对象，不要输出任何解释文字，字段如下：',
  '{',
  '  "title": "更准确的标题（保留原意，可润色，不超过 40 字）",',
  '  "summary": "一段话摘要（不超过 120 字）",',
  '  "knowledgePoints": ["知识点，4-12 条，每条不超过 20 字"],',
  '  "tags": ["标签，2-8 个，每个不超过 8 字"],',
  '  "outline": ["建议的章节大纲，3-10 条"],',
  '  "suggestedMarkdown": "整理后的完整 Markdown 正文（保留全部公式与信息，不得删减事实）"',
  '}',
].join('\n');

export const REVIEW_SYSTEM = [
  '你是一个学术编辑，负责审查笔记的内容与逻辑并给出可执行的修改建议。',
  '请只输出一个 JSON 对象，不要输出任何解释文字，字段如下：',
  '{',
  '  "score": 0-100 的整数，表示内容完整性与逻辑性,',
  '  "strengths": ["写得好的地方，最多 8 条"],',
  '  "issues": [{ "level": "major|minor|info", "where": "出现问题的小节或句子", "problem": "问题是什么", "suggestion": "怎么改" }],',
  '  "suggestions": ["整体建议，最多 10 条"]',
  '}',
].join('\n');

/* ------------------------------------------------------------------ */
/* 消息装配与结果解析                                                  */
/* ------------------------------------------------------------------ */

/**
 * 组装图片转写的多模态消息（OpenAI 兼容 content parts）。
 * @param {{ dataUrl: string, kind?: 'markdown'|'latex'|'both', hint?: string }} input
 */
export function buildImageMessages({ dataUrl, kind = 'both', hint = '' } = {}) {
  const preset = IMAGE_PROMPTS[kind] ?? IMAGE_PROMPTS.both;
  const instruction = kind === 'latex' ? '请转写这张图片。' : '请转写这张图片。';
  const text = hint ? `${instruction}\n补充要求：${hint}` : instruction;
  return [
    { role: 'system', content: preset },
    {
      role: 'user',
      content: [
        { type: 'text', text },
        { type: 'image_url', image_url: { url: String(dataUrl ?? '') } },
      ],
    },
  ];
}

const FENCE = /```([A-Za-z]*)\s*\n([\s\S]*?)```/g;

function readFences(text) {
  const blocks = { markdown: [], latex: [], other: [] };
  let match;
  FENCE.lastIndex = 0;
  while ((match = FENCE.exec(String(text ?? ''))) !== null) {
    const language = match[1].toLowerCase();
    const body = match[2].trim();
    if (!body) continue;
    if (language === 'markdown' || language === 'md') blocks.markdown.push(body);
    else if (language === 'latex' || language === 'tex') blocks.latex.push(body);
    else blocks.other.push(body);
  }
  return blocks;
}

const stripFences = (text) => String(text ?? '').replace(FENCE, '').trim();

/**
 * 解析模型输出。
 * 有围栏就用围栏；没围栏时按 kind 兜底（both 不猜，只当 markdown）。
 * @returns {{ markdown: string, latex: string }}
 */
export function parseImageResult(text, kind = 'both') {
  const blocks = readFences(text);
  const markdownFence = blocks.markdown.join('\n\n');
  const latexFence = blocks.latex.join('\n\n');
  const fallback = stripFences(text);

  if (kind === 'latex') {
    return { markdown: '', latex: latexFence || fallback };
  }
  if (kind === 'markdown') {
    return { markdown: markdownFence || fallback, latex: '' };
  }
  return { markdown: markdownFence || fallback, latex: latexFence };
}

/** 默认的 JSON 容错（宿主注入了 forum-ai 的 extractJson 时会优先用注入的）。 */
export function defaultExtractJson(text) {
  const raw = String(text ?? '');
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : raw).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    /* 继续尝试截取第一个平衡花括号块 */
  }
  const start = candidate.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < candidate.length; index += 1) {
    const char = candidate[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, index + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 归一化                                                             */
/* ------------------------------------------------------------------ */

const asText = (value, max = 4000) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

function asList(value, { max = 12, itemMax = 200 } = {}) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    const text = asText(item, itemMax);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

function normalizeOrganize(parsed, note) {
  const source = parsed && typeof parsed === 'object' ? parsed : {};
  return {
    title: asText(source.title, 120) || asText(note.title, 120) || '未命名笔记',
    summary: asText(source.summary, 600),
    knowledgePoints: asList(source.knowledgePoints, { max: 12, itemMax: 60 }),
    tags: asList(source.tags, { max: 8, itemMax: 24 }),
    outline: asList(source.outline, { max: 20, itemMax: 120 }),
    suggestedMarkdown: asText(source.suggestedMarkdown, 200000),
  };
}

function normalizeReview(parsed) {
  const source = parsed && typeof parsed === 'object' ? parsed : {};
  const score = Number(source.score);
  return {
    score: Number.isFinite(score) ? Math.min(100, Math.max(0, Math.round(score))) : null,
    strengths: asList(source.strengths, { max: 8, itemMax: 200 }),
    issues: (Array.isArray(source.issues) ? source.issues : [])
      .slice(0, 10)
      .map((issue) => ({
        level: ['major', 'minor', 'info'].includes(issue?.level) ? issue.level : 'info',
        where: asText(issue?.where, 160),
        problem: asText(issue?.problem, 400),
        suggestion: asText(issue?.suggestion, 400),
      }))
      .filter((issue) => issue.problem || issue.suggestion),
    suggestions: asList(source.suggestions, { max: 10, itemMax: 300 }),
  };
}

/* ------------------------------------------------------------------ */
/* 桥                                                              */
/* ------------------------------------------------------------------ */

/**
 * 造一个 AI 桥。
 *
 * @param {object} deps
 * @param {Function} [deps.chat]       既有 forum-ai 的 chat(messages, options)
 * @param {Function} [deps.extractJson]既有 forum-ai 的 JSON 容错（可选）
 * @param {Function} [deps.aiStatus]   既有 forum-ai 的状态函数（可选）
 * @param {object}   [deps.env]        AI 配置来源，默认 process.env
 * @param {Function} [deps.now]        时间源（测试可注入）
 */
export function createAiBridge({ chat, extractJson, aiStatus, env = process.env, now = () => new Date().toISOString() } = {}) {
  const configured = typeof chat === 'function';
  const parseJson = typeof extractJson === 'function' ? extractJson : defaultExtractJson;

  function requireChat() {
    if (!configured) {
      throw new NoteAiError(
        'ai_not_configured',
        'AI 未配置：请在宿主里把既有 forum-ai 的 chat() 注入进来，或设置 AI_API_KEY（以及视觉模型 AI_MODEL）。',
      );
    }
  }

  function requireImage(dataUrl) {
    const value = String(dataUrl ?? '');
    if (!/^data:image\/[a-z0-9.+-]+;base64,/i.test(value) && !/^https?:\/\//i.test(value)) {
      throw new NoteAiError('bad_request', '请提供 data URL 或 http(s) 图片地址');
    }
    return value;
  }

  return {
    configured,

    /** 上游配置状态（永远不含密钥）。优先用既有 forum-ai 的实现。 */
    status() {
      if (typeof aiStatus === 'function') return aiStatus(env);
      const apiKey = env.AI_API_KEY || '';
      return {
        configured: Boolean(apiKey),
        model: apiKey ? env.AI_MODEL || DEFAULT_MODEL : null,
        baseUrl: apiKey ? (env.AI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '') : null,
        envKeys: ENV_KEYS,
      };
    },

    /**
     * 图片 → Markdown / LaTeX。
     * 显式 `json: false`：这里是自由文本输出，不能被 chat() 默认的 json_object 破坏。
     */
    async convertImage({ dataUrl, kind = 'both', hint = '', source = null, model = null } = {}, { chatOptions = {} } = {}) {
      requireChat();
      const url = requireImage(dataUrl);
      const messages = buildImageMessages({ dataUrl: url, kind, hint });
      const { text, model: usedModel, usage } = await chat(messages, { ...chatOptions, json: false, env });
      const parsed = parseImageResult(text, kind);
      return {
        ...parsed,
        kind,
        source,
        model: usedModel || model,
        usage,
        at: now(),
      };
    },

    /** AI 整理：标题 / 摘要 / 知识点 / 标签 / 大纲 / 整理后的正文。 */
    async organizeNote({ title = '', content = '' } = {}, { chatOptions = {} } = {}) {
      requireChat();
      const { text, model, usage } = await chat(
        [
          { role: 'system', content: ORGANIZE_SYSTEM },
          { role: 'user', content: `标题：${title}\n\n正文：\n${content}` },
        ],
        { temperature: 0.2, ...chatOptions, json: true, env },
      );
      const parsed = parseJson(text);
      if (!parsed || typeof parsed !== 'object') {
        throw new NoteAiError('ai_bad_json', 'AI 返回的整理结果不是合法 JSON');
      }
      return { ...normalizeOrganize(parsed, { title }), model, usage };
    },

    /** AI 审阅：内容与逻辑检查 + 修改建议。 */
    async reviewNote({ title = '', content = '' } = {}, { chatOptions = {} } = {}) {
      requireChat();
      const { text, model, usage } = await chat(
        [
          { role: 'system', content: REVIEW_SYSTEM },
          { role: 'user', content: `标题：${title}\n\n正文：\n${content}` },
        ],
        { temperature: 0.2, ...chatOptions, json: true, env },
      );
      const parsed = parseJson(text);
      if (!parsed || typeof parsed !== 'object') {
        throw new NoteAiError('ai_bad_json', 'AI 返回的审阅结果不是合法 JSON');
      }
      return { ...normalizeReview(parsed), model, usage };
    },
  };
}

/**
 * 独立运行时：从既有的 forum-ai 包加载 chat()。
 *
 * 优先 `env.FORUM_AI_PATH`，默认相对本文件取 `../../forum-ai/src/index.mjs`。
 */
export async function loadForumChat({ env = process.env, importModule = (specifier) => import(specifier) } = {}) {
  const candidates = env.FORUM_AI_PATH
    ? [env.FORUM_AI_PATH]
    : [new URL('../../forum-ai/src/index.mjs', import.meta.url).href];

  for (const specifier of candidates) {
    try {
      const loaded = await importModule(specifier);
      if (typeof loaded?.chat === 'function') {
        return {
          chat: loaded.chat,
          extractJson: typeof loaded.extractJson === 'function' ? loaded.extractJson : undefined,
          aiStatus: typeof loaded.aiStatus === 'function' ? loaded.aiStatus : undefined,
          source: specifier,
        };
      }
    } catch {
      /* 换下一个候选路径 */
    }
  }

  throw new NoteAiError(
    'ai_not_configured',
    '没有找到既有的 AI 接口 forum-ai：请设置 FORUM_AI_PATH 指向 forum-ai/src/index.mjs，或让 note-studio 与 forum-ai 同仓。',
  );
}
