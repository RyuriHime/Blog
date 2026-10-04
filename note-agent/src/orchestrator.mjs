/**
 * 整理循环：唯一允许调用 forum-ai `chat()` 的地方（另一个是 review.mjs）。
 *
 * 这一层的职责就三件：
 *   1. 把块数组 + 图片装配成消息（材料装配、提示词都在别的模块里）；
 *   2. 调模型、抽出 JSON、把每一段都当成**不可信输入**做归一化；
 *   3. 把模型给的 op 一次性交给 `applyOps` —— op 是"目标"语义，分两次应用会互相错位。
 *
 * 绝不让模型的错误冒泡给路由层：一律转成 `{ ok: false, error }`。
 */
import { chat } from './ai.mjs';
import { extractJsonTolerant as extractJson } from './json.mjs';
import { buildMaterial, buildMessages, DEFAULT_CHAR_BUDGET } from './material.mjs';
import { applyOps, validateOp, rawKindOf, MAX_TAGS, MAX_TAG_LENGTH } from './ops.mjs';
import { ORGANIZE_SYSTEM, TURN_SYSTEM } from './prompts.mjs';
import {
  COMPACT_SUFFIX, MODEL_MAX_TOKENS, MODEL_TIMEOUT_MS, RETRYABLE_CODES, RETRY_MAX_TOKENS,
  TRUNCATED_MESSAGE, TURN_MAX_TOKENS as TURN_MODEL_MAX_TOKENS, usable, wasTruncated,
} from './limits.mjs';

export const GENERATE_MAX_TOKENS = MODEL_MAX_TOKENS;
export const TURN_MAX_TOKENS = TURN_MODEL_MAX_TOKENS;
export const TEMPERATURE = 0.2;
export const MAX_NEEDS_MORE = 3;

/**
 * 被截断时的重试预算。
 *
 * 真机验收踩到的坑（比"截断"更狠）：`AI_MODEL` 是推理模型（deepseek-flash），
 * **思维链也花 max_tokens**，而且往往比正文多得多 —— 实测同一段 900 字草稿，
 * reasoning 从 2481 到 10163 token 浮动，4000 预算时 `completion_tokens: 4000`
 * 里 4000 全是 reasoning、正文一个字都没有（`forum-ai` 对空正文直接抛
 * `ai_empty_response`，到了接口层就是 502）。
 *
 * 所以：预算按最坏情况给足（见 limits.mjs），并且把「空正文」与「半个 JSON」
 * 当成同一类可重试失败，收紧提示 + 加预算再试一次。只在第一次真失败时才多花这份钱。
 */
export const RETRY_EXTRA_TOKENS = RETRY_MAX_TOKENS - MODEL_MAX_TOKENS;
export { COMPACT_SUFFIX };

const SKIP_REASONS = {
  unknown_kind: '指令类型无法识别',
  bad_target: '目标块 id 格式不对',
  unknown_type: '块类型无法识别',
  unknown_target: '材料里没有这个块',
  empty_text: '内容为空',
  text_too_long: '内容超过长度上限',
  bad_tags: '标签不合法',
  overridden_by_format: '已被"整篇重写"覆盖，无需再改',
  too_many_inserts: '插入块数超过单轮上限',
};

function asString(value, limit = Infinity) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > limit ? text.slice(0, limit) : text;
}

function asStringArray(value, limit = 20) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const text = asString(item);
    if (text.length === 0) continue;
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function cleanTags(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    const tag = asString(item);
    if (tag.length === 0 || tag.length > MAX_TAG_LENGTH) continue;
    if (seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/**
 * 逐条校验模型给的 op，非法/缺字段的换成 `{ __invalid: reason }` 占位，保持下标不错位。
 *
 * 注意这里必须用 `validateOp` 回传的**归一化** op（`verdict.op`），不能用原始输入：
 * 模型经常把指令名写成 `op`、把新内容写成 `after`，`applyOps` 只认正式的 `kind`/`text`。
 * 曾经直接用 `op` 导致真机上"用户提了要求、面板说已处理、草稿一字未改"。
 */
function cleanOps(value) {
  if (!Array.isArray(value)) return [];
  return value.map((op) => {
    const verdict = validateOp(op);
    return verdict.ok
      ? verdict.op
      : { kind: rawKindOf(op), __invalid: verdict.reason, target: op?.target ?? op?.after };
  });
}

function skipMessage(entry) {
  const reason = SKIP_REASONS[entry.reason] ?? entry.reason ?? '原因未知';
  const where = entry.target ? `（${entry.target}）` : '';
  return `第 ${Number(entry.index ?? 0) + 1} 条指令未生效：${reason}${where}`;
}

/**
 * 首轮整理。
 *
 * @param {{blocks:Array<object>, assets?:Array<object>, structure?:object|null, title?:string, tags?:string[],
 *   requirement?:string, charBudget?:number, env?:object, fetchImpl?:Function, chatImpl?:Function, timeoutMs?:number}} input
 */
export async function generate({
  blocks = [],
  assets = [],
  structure = null,
  title = '',
  tags = [],
  requirement = '',
  charBudget = DEFAULT_CHAR_BUDGET,
  env = process.env,
  fetchImpl = fetch,
  chatImpl = chat,
  timeoutMs,
} = {}) {
  const source = Array.isArray(blocks) ? blocks : [];
  const material = buildMaterial(source, assets, { charBudget, structure });
  const warnStarted = material.droppedBlocks.length > 0
    ? [`材料超出 ${charBudget} 字符预算，有 ${material.droppedBlocks.length} 个块未发送给模型`]
    : [];

  const run = (system, {
    draft = '', requirementText = '', images = [], maxTokens = GENERATE_MAX_TOKENS, extra = '',
  } = {}) => chatImpl(
    buildMessages({
      system: extra.length > 0 ? `${system}\n\n${extra}` : system,
      material: material.text,
      draft,
      requirement: requirementText,
      images,
    }),
    { temperature: TEMPERATURE, maxTokens, json: false, env, fetchImpl, timeoutMs: timeoutMs ?? MODEL_TIMEOUT_MS },
  );

  /**
   * 调一次模型；拿不到可解析的 JSON 就收紧提示 + 加预算再试一次。
   *
   * 两种失败都算：「半个 JSON」（`extractJson` 返回 null），以及 `chat()` 直接抛
   * `ai_empty_response`（思维链把预算吃光、正文一个字都没有 —— 真机上 4000 预算时就是这样）。
   * 返回 `{ response, parsed, error }`；`parsed` 仍可能是 null，由调用方决定怎么报错。
   */
  const runJson = async (system, options = {}) => {
    let failure = null;
    for (const attemptOptions of [
      options,
      {
        ...options,
        maxTokens: (options.maxTokens ?? GENERATE_MAX_TOKENS) + RETRY_EXTRA_TOKENS,
        extra: [options.extra ?? '', COMPACT_SUFFIX].filter((part) => part.length > 0).join('\n'),
      },
    ]) {
      try {
        const response = await run(system, attemptOptions);
        const parsed = extractJson(response.text);
        if (usable(parsed)) return { response, parsed, error: null };
        failure = { response, parsed: null, error: null };
      } catch (error) {
        // 鉴权 / 限流 / 超时不重试：重试也是白等一轮。
        if (!RETRYABLE_CODES.includes(error?.code)) throw error;
        failure = { response: null, parsed: null, error };
      }
    }
    return failure;
  };

  try {
    const { response, parsed, error } = await runJson(ORGANIZE_SYSTEM, { requirementText: requirement, images: material.images });
    if (!usable(parsed)) {
      const usedUp = wasTruncated(response) || error?.code === 'ai_empty_response';
      return {
        ok: false,
        error: { code: 'ai_bad_json', message: usedUp ? TRUNCATED_MESSAGE : '模型没有返回可解析的 JSON，请重试' },
      };
    }
    const notes = asStringArray(parsed.notes);
    const warnings = [...warnStarted, ...asStringArray(parsed.warnings)];
    const needsMore = asStringArray(parsed.needsMore, MAX_NEEDS_MORE);
    const ops = cleanOps(parsed.ops);

    // 先把首轮 op 应用一遍：既得到"当前草稿"喂给追问，也把首轮的标题/标签接住
    const firstPass = applyOps(source, ops.filter((op) => !op.__invalid), {
      title: parsed.title ?? '',
      tags: parsed.tags ?? [],
    });

    let stageTwo = { response: null, parsed: null, notes: [], warnings: [], needsMore: [], title: null, tags: null };
    if (needsMore.length > 0) {
      const { response: stageTwoResponse, parsed: secondParsed } = await runJson(TURN_SYSTEM, {
        draft: firstPass.blocks.filter((block) => block.type !== 'heading').map((block) => block.text ?? '').join('\n\n'),
        requirementText: [
          '模型在首轮提出需要补充以下信息：',
          ...needsMore.map((question, index) => `${index + 1}. ${question}`),
          '请在给出 ops 的同时，把你准备如何假设这些缺失信息写进 notes；确实无法继续就把问题留在 needsMore。',
        ].join('\n'),
        maxTokens: TURN_MAX_TOKENS,
        extra: '这是一次自动追问（用户还没回答）。不要重复首轮已经完成的改动。',
      });
      if (usable(secondParsed)) {
        stageTwo = {
          response: stageTwoResponse,
          parsed: secondParsed,
          notes: asStringArray(secondParsed.notes),
          warnings: asStringArray(secondParsed.warnings),
          needsMore: asStringArray(secondParsed.needsMore, MAX_NEEDS_MORE),
          title: typeof secondParsed.title === 'string' && secondParsed.title.trim().length > 0 ? secondParsed.title : null,
          tags: Array.isArray(secondParsed.tags) ? secondParsed.tags : null,
        };
      }
    }

    const allOps = [...ops, ...cleanOps(stageTwo.parsed?.ops)];
    // 两轮 op 必须**一次性**应用：op 是"目标"语义，分两次应用会让下标与目标错位
    const outcome = applyOps(source, allOps.filter((op) => !op.__invalid), {
      title: stageTwo.title ?? parsed.title ?? '',
      tags: stageTwo.tags ?? parsed.tags ?? [],
      maxInserts: 40,
    });

    const skipped = [
      ...outcome.skipped,
      // 校验阶段就被拒的 op 也要出现在 skipped 里，否则用户看不到模型错在哪
      ...allOps
        .map((op, index) => (op.__invalid ? { index, kind: op.kind, reason: op.__invalid, target: op.target ?? op.after } : null))
        .filter(Boolean),
    ];
    skipped.sort((a, b) => a.index - b.index);

    return {
      ok: true,
      title: outcome.title,
      tags: outcome.tags,
      ops: allOps.filter((op) => !op.__invalid),
      blocks: outcome.blocks,
      markdown: outcome.markdown,
      applied: outcome.applied,
      skipped,
      warnings: [
        ...warnings,
        ...stageTwo.warnings,
        ...skipped.filter((entry) => entry.reason !== 'overridden_by_format').map(skipMessage),
      ],
      notes: [...notes, ...stageTwo.notes],
      needsMore: stageTwo.response ? stageTwo.needsMore : needsMore,
      model: response.model,
      usage: response.usage,
      material: { chars: material.chars, images: material.images.length, dropped: material.droppedBlocks },
    };
  } catch (error) {
    return {
      ok: false,
      error: { code: error?.code ?? 'notes_bad_request', message: String(error?.message ?? error) },
    };
  }
}

/**
 * 单轮微调：用户用自然语言提一条要求，模型只回受影响的块。
 *
 * @param {{blocks?:Array<object>, assets?:Array<object>, structure?:object|null, title?:string, tags?:string[],
 *   draft?:string, requirement:string, history?:Array<object>, charBudget?:number, env?:object,
 *   fetchImpl?:Function, chatImpl?:Function, timeoutMs?:number}} input
 */
export async function turn({
  blocks = [],
  assets = [],
  structure = null,
  title = '',
  tags = [],
  draft = '',
  requirement,
  history = [],
  charBudget = DEFAULT_CHAR_BUDGET,
  env = process.env,
  fetchImpl = fetch,
  chatImpl = chat,
  timeoutMs,
} = {}) {
  const source = Array.isArray(blocks) ? blocks : [];
  const material = buildMaterial(source, assets, { charBudget, structure });
  const historyLines = (Array.isArray(history) ? history : [])
    .filter((item) => item && (item.requirement || (item.notes ?? []).length > 0))
    .map((item, index) => `${index + 1}. 用户要求：${asString(item.requirement)}｜处理：${asStringArray(item.notes).join('；')}`);
  const extra = historyLines.length > 0 ? ['此前的轮次（保持前后一致，不要重复已完成的事）：', ...historyLines].join('\n') : '';

  const askTurn = (system, maxTokens) => chatImpl(
    buildMessages({
      system,
      material: material.text,
      draft,
      requirement,
      images: material.images,
    }),
    { temperature: TEMPERATURE, maxTokens, json: false, env, fetchImpl, timeoutMs: timeoutMs ?? MODEL_TIMEOUT_MS },
  );

  try {
    const system = extra.length > 0 ? `${TURN_SYSTEM}\n\n${extra}` : TURN_SYSTEM;
    // 与 generate 同因：推理模型的思维链会吃满 max_tokens，于是正文要么是空的（chat() 抛
    // ai_empty_response）、要么只剩半个 JSON。两种都收紧提示加预算再试一次。
    let response = null;
    let parsed = null;
    let failureReason = null;
    for (const attempt of [
      { system, maxTokens: TURN_MAX_TOKENS },
      { system: `${system}${COMPACT_SUFFIX}`, maxTokens: TURN_MAX_TOKENS + RETRY_EXTRA_TOKENS },
    ]) {
      try {
        response = await askTurn(attempt.system, attempt.maxTokens);
      } catch (error) {
        if (!RETRYABLE_CODES.includes(error?.code)) throw error;
        response = null;
        failureReason = error.code;
        continue;
      }
      parsed = extractJson(response.text);
      if (usable(parsed)) break;
      failureReason = 'ai_bad_json';
    }
    if (!usable(parsed)) {
      const usedUp = failureReason === 'ai_empty_response' || wasTruncated(response);
      return {
        ok: false,
        error: { code: 'ai_bad_json', message: usedUp ? TRUNCATED_MESSAGE : '模型没有返回可解析的 JSON，请重试' },
      };
    }
    const ops = cleanOps(parsed.ops);
    const outcome = applyOps(source, ops.filter((op) => !op.__invalid), {
      title: typeof parsed.title === 'string' && parsed.title.trim().length > 0 ? parsed.title : title,
      tags,
    });
    const skipped = [
      ...outcome.skipped,
      ...ops
        .map((op, index) => (op.__invalid ? { index, kind: op.kind, reason: op.__invalid, target: op.target ?? op.after } : null))
        .filter(Boolean),
    ].sort((a, b) => a.index - b.index);

    return {
      ok: true,
      title: outcome.title,
      tags: outcome.tags,
      ops: ops.filter((op) => !op.__invalid),
      blocks: outcome.blocks,
      markdown: outcome.markdown,
      applied: outcome.applied,
      skipped,
      warnings: [...asStringArray(parsed.warnings), ...skipped.map(skipMessage)],
      notes: asStringArray(parsed.notes),
      needsMore: asStringArray(parsed.needsMore, MAX_NEEDS_MORE),
      model: response.model,
      usage: response.usage,
      material: { chars: material.chars, images: material.images.length, dropped: material.droppedBlocks },
    };
  } catch (error) {
    return {
      ok: false,
      error: { code: error?.code ?? 'notes_bad_request', message: String(error?.message ?? error) },
    };
  }
}
