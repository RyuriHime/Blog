import { createChecker } from './helpers/check.mjs';
import { createFakeChat } from './helpers/fake-chat.mjs';
import { reviewDraft, applyReviewPatch, buildReviewOps } from '../src/review.mjs';
import { validateOp } from '../src/ops.mjs';

const { check, summary } = createChecker();
const draft = '# 导数\n\n导数是变化率，它等于切线的斜率。\n\n因此导数的定义就是积分。';
const findings = [
  { kind: 'logic', severity: 'high', quote: '因此导数的定义就是积分。', issue: '因果倒置', suggestion: '导数由极限定义，积分是逆运算。', patch: '导数的定义是极限，积分是它的逆运算。' },
  { kind: 'nonsense', severity: 'high', quote: '导数是变化率', issue: 'x', suggestion: 'y', patch: 'z' },
  { kind: 'fact', severity: 'medium', quote: '这句话草稿里根本没有出现过', issue: 'x', suggestion: 'y', patch: 'z' },
  { kind: 'clarity', severity: 'very-high', quote: '它等于切线的斜率', issue: '指代不明', suggestion: '明确"它"指什么', patch: '' },
];
const fake = createFakeChat([{ summary: '整体清楚', findings, strengths: ['结构清楚'] }]);
const r = await reviewDraft({ draft, chatImpl: fake.chatImpl, env: { AI_API_KEY: 'x' } });

// 真机实测：思维链能吃掉 10000 token，正文才 2500 字符 —— 预算必须按最坏情况给。
check('review 要求的 maxTokens 足够大且 json=false', fake.calls[0].options.maxTokens >= 16000 && fake.calls[0].options.json === false);
check('review 自己给足超时（16000 token 的一次调用实测要 33~44 秒）', fake.calls[0].options.timeoutMs >= 120000);
check('review 用 REVIEW_SYSTEM 作 system 提示', fake.calls[0].messages[0].content.startsWith('你是一个学术编辑'));
check('合法 finding 保留并重新编号', r.findings[0].id === 'f1' && r.findings[0].kind === 'logic');
check('【RF-5】kind 非法的 finding 被丢弃', r.findings.every((f) => f.kind !== 'nonsense') && r.dropped.some((d) => d.reason === 'bad_kind'));
check('【RF-5】quote 不在草稿里的 finding 被丢弃', r.dropped.some((d) => d.reason === 'quote_not_found') && r.findings.every((f) => draft.includes(f.quote)));
check('severity 非法时降级为 medium', r.findings.find((f) => f.kind === 'clarity').severity === 'medium');
check('summary 与 strengths 保留', r.summary === '整体清楚' && r.strengths[0] === '结构清楚');
check('quote 长度不足 6 字的 finding 被丢弃', await (async () => {
  const short = createFakeChat([{ summary: 's', findings: [{ kind: 'logic', severity: 'high', quote: '导数', issue: 'i', suggestion: 's', patch: 'p' }], strengths: [] }]);
  const out = await reviewDraft({ draft, chatImpl: short.chatImpl });
  return out.findings.length === 0 && out.dropped.some((d) => d.reason === 'quote_not_found');
})());
check('issue/suggestion 各自截断到 120/200 字', await (async () => {
  const longOne = createFakeChat([{ summary: 's', findings: [{ kind: 'logic', severity: 'high', quote: '导数是变化率', issue: 'i'.repeat(300), suggestion: 's'.repeat(300), patch: '' }], strengths: [] }]);
  const out = await reviewDraft({ draft, chatImpl: longOne.chatImpl });
  return out.findings[0].issue.length === 120 && out.findings[0].suggestion.length === 200;
})());
check('findings 最多 12 条', await (async () => {
  const many = createFakeChat([{
    summary: 's',
    findings: Array.from({ length: 20 }, (_, i) => ({ kind: 'logic', severity: 'low', quote: '导数是变化率', issue: `i${i}`, suggestion: 's', patch: '' })),
    strengths: [],
  }]);
  const out = await reviewDraft({ draft, chatImpl: many.chatImpl });
  return out.findings.length === 12;
})());
check('按 severity 稳定排序 high 在前', await (async () => {
  const mixed = createFakeChat([{
    summary: 's',
    findings: [
      { kind: 'logic', severity: 'low', quote: '导数是变化率', issue: 'low', suggestion: 's', patch: '' },
      { kind: 'fact', severity: 'high', quote: '它等于切线的斜率', issue: 'high', suggestion: 's', patch: '' },
      { kind: 'clarity', severity: 'medium', quote: '因此导数的定义就是积分。', issue: 'medium', suggestion: 's', patch: '' },
    ],
    strengths: [],
  }]);
  const out = await reviewDraft({ draft, chatImpl: mixed.chatImpl });
  return out.findings.map((f) => f.severity).join(',') === 'high,medium,low';
})());
check('findings 重新编号为 f1…fn', await (async () => {
  const two = createFakeChat([{
    summary: 's',
    findings: [
      { kind: 'logic', severity: 'high', quote: '导数是变化率', issue: 'a', suggestion: 's', patch: '' },
      { kind: 'fact', severity: 'low', quote: '它等于切线的斜率', issue: 'b', suggestion: 's', patch: '' },
    ],
    strengths: [],
  }]);
  const out = await reviewDraft({ draft, chatImpl: two.chatImpl });
  return out.findings.map((f) => f.id).join(',') === 'f1,f2';
})());
check('【RF-5】quote 里的正则元字符不会炸', await (async () => {
  const trickyDraft = '价格是 $5，公式是 a*b+c。';
  const tricky = createFakeChat([{ summary: 's', findings: [{ kind: 'clarity', severity: 'high', quote: '$5，公式是 a*b+c', issue: 'i', suggestion: 's', patch: '十块钱，公式是 a×b+c' }], strengths: [] }]);
  const out = await reviewDraft({ draft: trickyDraft, chatImpl: tricky.chatImpl });
  return out.findings.length === 1;
})());
check('找不到草稿时 reviewDraft 报错而不是瞎猜', await (async () => {
  const out = await reviewDraft({ draft: '', chatImpl: createFakeChat([{ summary: 's', findings: [], strengths: [] }]).chatImpl });
  return out.ok === false && out.error.code === 'notes_bad_request';
})());

const patchResult = applyReviewPatch(draft, r.findings);
check('一键应用只改 high 且有 patch 的那处', patchResult.draft.includes('导数的定义是极限，积分是它的逆运算。') && patchResult.draft.includes('它等于切线的斜率'));
check('应用结果记录 applied/skipped 与原因', patchResult.applied.length === 1
  && patchResult.applied[0].id === 'f1'
  && patchResult.skipped.every((s) => ['quote_not_found', 'no_patch', 'not_high'].includes(s.reason))
  && patchResult.skipped.some((s) => s.id === 'f2' && s.reason === 'not_high'));
check('patch 为空的 high 建议只记 no_patch，草稿不动', (() => {
  const bare = applyReviewPatch(draft, [{ id: 'f7', kind: 'logic', severity: 'high', quote: '导数是变化率', patch: '' }]);
  return bare.draft === draft && bare.skipped[0].reason === 'no_patch';
})());

const stale = applyReviewPatch(draft, [{ id: 'f9', kind: 'logic', severity: 'high', quote: '不存在的句子', patch: 'x' }]);
check('【RF-5】quote 找不到时草稿一字不改', stale.draft === draft && stale.skipped[0].reason === 'quote_not_found');

check('patch 里的 $& 不被当成替换模式', (() => {
  const target = 'A = 1';
  const out = applyReviewPatch(`前 ${target} 后`, [{ id: 'f1', kind: 'formula', severity: 'high', quote: target, patch: '$&$$x$$' }]);
  return out.draft.includes('$&$$x$$');
})());
check('只替换第一次出现，不做全局替换', (() => {
  const repeated = '斜率 斜率 斜率';
  const out = applyReviewPatch(repeated, [{ id: 'f1', kind: 'clarity', severity: 'high', quote: '斜率', patch: '导数' }]);
  return out.draft === '导数 斜率 斜率';
})());

const ops = buildReviewOps(r.findings, draft);
check('buildReviewOps 一次审查最多一条 format op', ops.filter((o) => o.kind === 'format').length === 1);
check('buildReviewOps 产出的 op 能通过 validateOp', ops.every((op) => validateOp(op).ok === true));
check('buildReviewOps 无 high 可改时返回空数组', buildReviewOps([{ id: 'f1', kind: 'logic', severity: 'low', quote: '导数是变化率', patch: 'x' }], draft).length === 0);
check('多处 high 的 patch 会累积进同一条 format', (() => {
  const multi = buildReviewOps([
    { id: 'f1', kind: 'logic', severity: 'high', quote: '导数是变化率', patch: '导数是瞬时变化率' },
    { id: 'f2', kind: 'fact', severity: 'high', quote: '它等于切线的斜率', patch: '它等于该点切线的斜率' },
  ], draft);
  return multi.length === 1 && multi[0].markdown.includes('导数是瞬时变化率') && multi[0].markdown.includes('它等于该点切线的斜率');
})());
check('buildReviewOps 的 markdown 仍包含未被修改的原文', (() => {
  const one = buildReviewOps([{ id: 'f1', kind: 'logic', severity: 'high', quote: '导数是变化率', patch: '导数是瞬时变化率' }], draft);
  return one[0].markdown.includes('# 导数') && one[0].markdown.includes('因此导数的定义就是积分。');
})());

const fail = await reviewDraft({ draft, chatImpl: createFakeChat(['__THROW__']).chatImpl });
check('review 失败不冒泡', fail.ok === false && fail.error.code === 'ai_timeout');
const badJson = await reviewDraft({ draft, chatImpl: createFakeChat(['不是 JSON']).chatImpl });
check('review 拿到非 JSON 时返回 ok:false', badJson.ok === false && typeof badJson.error.message === 'string');

// 【真机验收 bug】推理模型的思维链也算 max_tokens：真机那次 4000 被思维链吃光、
// finish_reason 是 'length'、正文里只有一个没写完的 JSON，于是整个审查 502。
// 修法：发现被截断就收紧提示、加大预算重试一次；仍不行才报明确错误。
const truncated = createFakeChat([
  { text: '{"summary":"被截断的回答","findings":[{"kind":"logic"', finishReason: 'length' },
  {
    summary: '重试成功',
    findings: [{ kind: 'logic', severity: 'high', quote: '导数是变化率', issue: 'i', suggestion: 's', patch: '导数是瞬时变化率' }],
    strengths: [],
  },
]);
const retried = await reviewDraft({ draft, chatImpl: truncated.chatImpl });
const retryCall = truncated.calls[1];
check('【真机验收】截断后自动重试并成功', retried.ok === true && retried.summary === '重试成功');
check('【真机验收】重试用了更大的 maxTokens', Boolean(retryCall) && retryCall.options.maxTokens > truncated.calls[0].options.maxTokens);
check('【真机验收】重试时明确要求只输出 JSON', Boolean(retryCall) && retryCall.messages[0].content.includes('只输出 JSON'));

const stillTruncated = createFakeChat([{ text: '{"summary":"还是没写完"', finishReason: 'length' }], { repeatLast: false });
const gaveUp = await reviewDraft({ draft, chatImpl: stillTruncated.chatImpl });
check('【真机验收】重试仍截断时报明确错误而不是 502', gaveUp.ok === false && gaveUp.error.code === 'ai_bad_json' && gaveUp.error.message.includes('太长'));

// 真机最常见的那一种：预算全被思维链吃光，forum-ai 的 chat() 直接抛 ai_empty_response。
// 这必须跟"半个 JSON"一样触发重试，否则用户看到的就是 502「AI 接口没有返回内容」。
// 这里用 `repeatLast: false`：第一次返回一个只有空字符的"正文"，之后 chat() 抛空正文错误。
const emptyFirst = createFakeChat([{ text: '\u0000', finishReason: 'length' }], { repeatLast: false });
const emptyRetried = await reviewDraft({ draft, chatImpl: emptyFirst.chatImpl });
check('【真机验收】空正文（思维链吃满预算）也会重试一次', emptyFirst.calls.length === 2 && emptyRetried.ok === false && emptyRetried.error.message.includes('太长'));

summary();
