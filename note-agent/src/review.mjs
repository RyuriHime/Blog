/**
 * 学术编辑 Agent：审查草稿的内容与逻辑，给出**有证据**的修改建议。
 *
 * 与整理循环同源的防幻觉策略（沿用 forum-ai 的做法）：
 *   - 模型只能通过 `quote` 指认问题，`quote` 必须能在草稿里原样找到，否则整条发现丢弃；
 *   - 只有 `severity === 'high'` 且给了 `patch` 的建议才允许"一键应用"；
 *   - `patch` 用 `replace(quote, () => patch)` 落字 —— 传函数而不是字符串，
 *     否则 patch 里的 `$&`、`$1` 会被当成替换模式（计划里点名必须这么做）。
 */
import { chat } from './ai.mjs';
import { extractJsonTolerant as extractJson } from './json.mjs';
import { FINDING_KINDS, REVIEW_SYSTEM } from './prompts.mjs';
import { MAX_OP_TEXT, validateOp } from './ops.mjs';
import {
  COMPACT_SUFFIX, MODEL_MAX_TOKENS, MODEL_TIMEOUT_MS, RETRYABLE_CODES, RETRY_MAX_TOKENS,
  TRUNCATED_MESSAGE, usable, wasTruncated,
} from './limits.mjs';

/** 首轮审查的预算。真机实测：思维链能吃掉 10000 token，正文才 2500 字符。 */
export const REVIEW_MAX_TOKENS = MODEL_MAX_TOKENS;
/** 被截断/空正文时的重试预算（只重试一次，所以只在第一次真失败时才多花这份钱）。 */
export const REVIEW_RETRY_MAX_TOKENS = RETRY_MAX_TOKENS;
export const REVIEW_TEMPERATURE = 0.2;
export const MAX_FINDINGS = 12;
export const MIN_QUOTE = 6;
export const MAX_ISSUE = 120;
export const MAX_SUGGESTION = 200;
export const MAX_SUMMARY = 200;

const SEVERITIES = ['high', 'medium', 'low'];
const SEVERITY_RANK = { high: 0, medium: 1, low: 2 };
const DEFAULT_SEVERITY = 'medium';

function asString(value, limit = Infinity) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > limit ? text.slice(0, limit) : text;
}

function asStringArray(value, limit = 5) {
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

function normalizeSeverity(value) {
  const text = asString(value).toLowerCase();
  return SEVERITIES.includes(text) ? text : DEFAULT_SEVERITY;
}

/**
 * 审查草稿。
 *
 * @param {{draft?:string, blocks?:Array<object>|null, title?:string, scope?:string, chatImpl?:Function,
 *   env?:object, fetchImpl?:Function, timeoutMs?:number}} input
 * @returns {Promise<{ok:true, summary:string, findings:Array<object>, strengths:string[], dropped:Array<object>,
 *   model:string|null, usage:object|null} | {ok:false, error:{code:string, message:string}}>}
 */
export async function reviewDraft({
  draft = '',
  blocks = null,
  title = '',
  scope = 'content',
  chatImpl = chat,
  env = process.env,
  fetchImpl = fetch,
  timeoutMs,
} = {}) {
  const source = typeof draft === 'string' ? draft : '';
  if (source.trim().length === 0) {
    return { ok: false, error: { code: 'notes_bad_request', message: '草稿还是空的，没有可审查的内容' } };
  }

  const parts = [];
  if (typeof title === 'string' && title.trim().length > 0) parts.push(`标题：${title.trim()}`);
  parts.push('草稿正文：', source);
  if (scope === 'logic') parts.push('本轮请侧重推理与逻辑链条，而不是文字润色。');

  async function ask(system, maxTokens) {
    const response = await chatImpl(
      [
        { role: 'system', content: system },
        { role: 'user', content: parts.join('\n\n') },
      ],
      {
        temperature: REVIEW_TEMPERATURE,
        maxTokens,
        json: false,
        env,
        fetchImpl,
        timeoutMs: timeoutMs ?? MODEL_TIMEOUT_MS,
      },
    );
    if (env.NOTES_DEBUG) {
      const finish = response?.finishReason ?? response?.raw?.choices?.[0]?.finish_reason ?? response?.raw?.finishReason;
      const raw = String(response?.text ?? '');
      console.log(`[notes-debug] review maxTokens=${maxTokens} finish=${finish} usage=${JSON.stringify(response?.usage)} textLen=${raw.length}`);
    }
    return { response, parsed: extractJson(response.text) };
  }

  /**
   * 问一次；拿不到可用 JSON 就收紧提示、加预算再试一次。
   *
   * 这里**同时**兜住两种"没结果"：解析不出来（半个 JSON），以及 `chat()` 直接抛
   * `ai_empty_response`（思维链把预算吃光、正文一个字都没有 —— 真机上 4000 token 时就是这样）。
   */
  async function askWithRetry() {
    let failure = null;
    for (const [system, maxTokens] of [
      [REVIEW_SYSTEM, REVIEW_MAX_TOKENS],
      [REVIEW_SYSTEM + COMPACT_SUFFIX, RETRY_MAX_TOKENS],
    ]) {
      try {
        const attempt = await ask(system, maxTokens);
        if (usable(attempt.parsed)) return attempt;
        failure = { response: attempt.response };
      } catch (error) {
        if (!RETRYABLE_CODES.includes(error?.code)) throw error;
        failure = { error };
      }
    }
    return failure ?? { response: null, parsed: null };
  }

  /** forum-ai 的 chat() 把上游原始响应留在 `raw` 里，是否被截断要看 finish_reason。 */
  try {
    const attempt = await askWithRetry();
    let response = attempt.response;
    const parsed = attempt.parsed;
    if (!usable(parsed)) {
      const usedUp = wasTruncated(response) || attempt.error?.code === 'ai_empty_response';
      return {
        ok: false,
        error: {
          code: 'ai_bad_json',
          message: usedUp ? TRUNCATED_MESSAGE : '模型没有返回可解析的 JSON，请重试',
        },
      };
    }

    const dropped = [];
    const kept = [];
    for (const raw of Array.isArray(parsed.findings) ? parsed.findings : []) {
      const quote = typeof raw?.quote === 'string' ? raw.quote : '';
      const kind = asString(raw?.kind);
      if (!FINDING_KINDS.includes(kind)) {
        dropped.push({ reason: 'bad_kind', kind, quote });
        continue;
      }
      if (quote.length < MIN_QUOTE || !source.includes(quote)) {
        dropped.push({ reason: 'quote_not_found', kind, quote });
        continue;
      }
      kept.push({
        kind,
        severity: normalizeSeverity(raw?.severity),
        quote,
        issue: asString(raw?.issue, MAX_ISSUE),
        suggestion: asString(raw?.suggestion, MAX_SUGGESTION),
        patch: typeof raw?.patch === 'string' ? raw.patch : '',
      });
    }

    // 稳定排序：severity 相同时保持模型给的顺序
    const findings = kept
      .map((finding, index) => ({ finding, index }))
      .sort((a, b) => (SEVERITY_RANK[a.finding.severity] - SEVERITY_RANK[b.finding.severity]) || (a.index - b.index))
      .slice(0, MAX_FINDINGS)
      .map(({ finding }, index) => ({ id: `f${index + 1}`, ...finding }));

    return {
      ok: true,
      summary: asString(parsed.summary, MAX_SUMMARY),
      findings,
      strengths: asStringArray(parsed.strengths, 3),
      dropped,
      model: response.model ?? null,
      usage: response.usage ?? null,
    };
  } catch (error) {
    return {
      ok: false,
      error: { code: error?.code ?? 'notes_bad_request', message: String(error?.message ?? error) },
    };
  }
}

/**
 * 把 findings 里可精确替换的 patch 应用到草稿。只动 `severity === 'high'` 且给了 patch 的条目。
 *
 * 每一步都必须成功才继续（草稿的偏移会随替换变化，失败还硬套会写坏内容）。
 *
 * @returns {{draft:string, applied:Array<object>, skipped:Array<{id:string, reason:string}>}}
 */
export function applyReviewPatch(draft, findings) {
  const source = typeof draft === 'string' ? draft : '';
  const list = Array.isArray(findings) ? findings : [];
  const applied = [];
  const skipped = [];
  let current = source;
  let fatal = false;

  for (const finding of list) {
    const id = typeof finding?.id === 'string' ? finding.id : '';
    const quote = typeof finding?.quote === 'string' ? finding.quote : '';
    const patch = typeof finding?.patch === 'string' ? finding.patch : '';
    if (fatal) {
      skipped.push({ id, reason: 'quote_not_found' });
      continue;
    }
    if (normalizeSeverity(finding?.severity) !== 'high') {
      skipped.push({ id, reason: 'not_high' });
      continue;
    }
    if (patch.length === 0) {
      skipped.push({ id, reason: 'no_patch' });
      continue;
    }
    if (quote.length === 0 || !current.includes(quote)) {
      // 前面某条已改了这段文字，或模型引用的原文根本不在草稿里 —— 一律不写坏草稿
      skipped.push({ id, reason: 'quote_not_found' });
      fatal = true;
      continue;
    }
    // 传函数而不是字符串：patch 里的 $& / $1 必须原样落字
    current = current.replace(quote, () => patch);
    applied.push({ id, kind: finding.kind, severity: 'high' });
  }

  return { draft: current, applied, skipped };
}

/**
 * 把"一键应用"的结果转成 op，交给上传通道走同一套 `applyOps`。
 * 一次审查最多产出一条 `format`（整篇替换语义），多处的 patch 已累积到 markdown 里。
 *
 * @returns {Array<{kind:'format', markdown:string}>}
 */
export function buildReviewOps(findings, draft) {
  const outcome = applyReviewPatch(draft, findings);
  if (outcome.applied.length === 0) return [];
  const markdown = outcome.draft;
  if (markdown.length === 0 || markdown.length > MAX_OP_TEXT) return [];
  const op = { kind: 'format', markdown };
  return validateOp(op).ok ? [op] : [];
}
