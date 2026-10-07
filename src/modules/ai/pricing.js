// AI 编辑台「全站用量」面板里的**钱**从哪来：token 用量 × 单价。
//
// 在这之前那张面板只有次数 —— `ai_op_logs` 只记了「谁、什么时候、调了什么」，
// 上游返回的 token 用量当场就被丢掉了（`callModel` 只取 `choices[0].message.content`），
// 于是面板上写着「这张表没存 token 用量，所以没有金额」。次数不是成本：
// 一次整篇改写和一次单块草拟都算「1 次」，账单上差着几十倍。
//
// ── 单价出处 ──
// DeepSeek 官方《模型 & 价格》页（见 `AI_PRICE_SOURCE`），2026-10 抄的一份，
// 单位是「元 / 百万 tokens」：
//
//   模型            输入(缓存命中)    输入(缓存未命中)   输出
//   deepseek-flash  0.04 元           2 元              8 元
//   deepseek-v4-pro 0.30 元           9 元              27 元
//
// 上表是**高峰时段**价；空闲时段一律减半（flash: 0.02 / 1 / 4，pro: 0.15 / 4.5 / 13.5）。
// 高峰 = 北京时间周一至周五 9:00–12:00 与 14:00–18:00；其余时段（含周末整天）为空闲。
//
// 抄一份单价进源码是没办法的事：这个项目零依赖、也不该在渲染用量面板时去打
// 官方文档。**单价会变**（官方保留调价的权利），所以：
//   · 面板上要如实写出「用的是哪份表、哪个时段」；
//   · 没登记价格的模型不猜，金额按 0 算并在面板上说出来，可用三个环境变量登记
//     （`AI_PRICE_INPUT_PER_M` / `AI_PRICE_CACHE_HIT_PER_M` / `AI_PRICE_OUTPUT_PER_M`）。
//
// ── 为什么用「调用时刻」判高峰，而不是看面板的时刻 ──
// 计费看的是调用发生的那一刻，所以 `peak` 在记账时就随行落库
// （`ai_token_usage.peak`），面板只按存下来的档位乘价 —— 半夜打开面板看白天的账单，
// 不该跟着面板打开的时间变价。
//
// ── 已知的不精确（面板的 note 里如实说） ──
// 1. 法定节假日没有日历可查，落在高峰判据里的节假日会按高峰价算（偏高）；
// 2. 缓存命中/未命中以 DeepSeek 返回的 `prompt_cache_hit_tokens` 为准，
//    上游不返这个字段时整段按未命中价算（偏高）；
// 3. 上游没返回 usage 的调用金额按 0 算，面板会单独报「有几次调用没拿到用量」。

/** 单价的计量单位：下面是「元 / 百万 tokens」，所以算钱时要除以它。 */
export const AI_TOKENS_PER_PRICE_UNIT = 1_000_000;

/** 官方价格页 —— 面板上要能点回出处，别让数字来路不明。 */
export const AI_PRICE_SOURCE = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/';

/** 面板上显示的计价口径。 */
export const AI_PRICE_UNIT = '元/百万 tokens';
export const AI_PRICE_CURRENCY = 'CNY';

/** 没登记价格的模型用这三个环境变量登记单价（语义同官方表：高峰价，空闲减半）。 */
export const AI_PRICE_ENV_KEYS = Object.freeze({
  inputMiss: 'AI_PRICE_INPUT_PER_M',
  inputHit: 'AI_PRICE_CACHE_HIT_PER_M',
  output: 'AI_PRICE_OUTPUT_PER_M',
});

/** 空闲时段 = 高峰价 × 这个系数（官方原话「空闲时段价格为高峰时段价格的一半」）。 */
export const AI_OFF_PEAK_FACTOR = 0.5;

/**
 * 官方高峰价表。`inputMiss` = 缓存未命中的输入，`inputHit` = 缓存命中的输入，`output` = 输出。
 *
 * `label` 只用来在面板上写清楚「按哪个模型算的」，不是模型名本身。
 */
export const AI_PRICE_TABLE = Object.freeze({
  'deepseek-flash': Object.freeze({ label: 'DeepSeek-V4.1-Flash', inputMiss: 2, inputHit: 0.04, output: 8 }),
  'deepseek-v4-pro': Object.freeze({ label: 'DeepSeek-V4-Pro-0813', inputMiss: 9, inputHit: 0.3, output: 27 }),
});

/**
 * 官方脚注：旧模型名 `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` 仍可调用，
 * 但由 Flash 提供服务并按 Flash 价计费 —— 所以别名指向同一行价目表。
 */
export const AI_PRICE_ALIASES = Object.freeze({
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
  'deepseek-v4-flash-vision': 'deepseek-flash',
});

/** 单价只能是有限的正数；配歪了按 0 算（宁可少报钱，也不要报一个 NaN）。 */
function readPriceEnv(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : 0;
}

/**
 * 一个模型的价目（高峰价）+ 这张价的来路。
 *
 * 返回 `known: false` 表示这个模型没登记，`source` 会说明「要用环境变量登记」。
 */
export function priceFor(model, env = process.env) {
  const name = String(model ?? '').trim();
  const key = AI_PRICE_ALIASES[name] ?? name;
  const row = AI_PRICE_TABLE[key];
  if (row) {
    return {
      model: name,
      known: true,
      label: row.label,
      inputMiss: row.inputMiss,
      inputHit: row.inputHit,
      output: row.output,
      source: AI_PRICE_SOURCE,
    };
  }
  return {
    model: name,
    known: false,
    label: '',
    inputMiss: readPriceEnv(env?.[AI_PRICE_ENV_KEYS.inputMiss]),
    inputHit: readPriceEnv(env?.[AI_PRICE_ENV_KEYS.inputHit]),
    output: readPriceEnv(env?.[AI_PRICE_ENV_KEYS.output]),
    source: `${AI_PRICE_ENV_KEYS.inputMiss} / ${AI_PRICE_ENV_KEYS.inputHit} / ${AI_PRICE_ENV_KEYS.output}`,
  };
}

/**
 * 这一刻是不是高峰时段（北京时间周一至周五 9:00–12:00、14:00–18:00）。
 *
 * 用固定的 UTC+8 换算，**不依赖运行环境的本地时区** —— 服务器可能跑在 UTC 上，
 * 那样「9 点」就会变成 UTC 的 9 点，整张账单错一档。法定节假日不算（见文件头）。
 */
export function isPeakHour(at = Date.now()) {
  const beijing = new Date(Number(at) + 8 * 3600 * 1000);
  const day = beijing.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = beijing.getUTCHours();
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
}

/**
 * 上游返回的 `usage` → 本模块认的三个数。
 *
 * `promptTokens` 是**输入总数**（命中 + 未命中），`cachedTokens` 是其中命中的那部分；
 * 未命中 = 两者之差。字段缺失、是负数、是字符串、是 `null` 一律按 0 算 ——
 * 这里绝不抛错：记账失败不该让一次已经成功的模型调用变成 500。
 */
export function shapeTokenUsage(raw) {
  const num = (value) => {
    const parsed = Math.round(Number(value));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  };
  const promptTokens = num(raw?.prompt_tokens);
  const cachedRaw = raw?.prompt_cache_hit_tokens ?? raw?.prompt_tokens_details?.cached_tokens;
  const completionTokens = num(raw?.completion_tokens);
  // 命中数不该超过输入总数（上游字段偶尔会自相矛盾），超了就按整段命中算，
  // 免得算出「负的未命中」把钱算成负数。
  return { promptTokens, cachedTokens: Math.min(num(cachedRaw), promptTokens), completionTokens };
}

/** 金额保留 6 位小数（元）：单次调用常常只有几厘钱，位数不够会全变成 0。 */
function roundYuan(yuan) {
  return Math.round(yuan * 1e6) / 1e6;
}

/**
 * 一份用量要花多少钱（元）。
 *
 * `peak` 显式给出时用它（面板按落库的档位重算历史），否则按 `at` 判 —— 记账时传
 * 当前时刻即可。返回里带上 `missTokens` / `cachedTokens` 与用到的价目，
 * 好让调用方把「怎么算出来的」原样透出去。
 */
export function costOfUsage(
  { promptTokens = 0, cachedTokens = 0, completionTokens = 0 } = {},
  { model, at = Date.now(), peak, env = process.env } = {},
) {
  const price = priceFor(model, env);
  const isPeak = peak === undefined ? isPeakHour(at) : Boolean(peak);
  const prompt = Math.max(0, Math.round(Number(promptTokens) || 0));
  const cached = Math.min(Math.max(0, Math.round(Number(cachedTokens) || 0)), prompt);
  const missTokens = prompt - cached;
  const completion = Math.max(0, Math.round(Number(completionTokens) || 0));
  const factor = isPeak ? 1 : AI_OFF_PEAK_FACTOR;
  const yuan =
    ((missTokens * price.inputMiss + cached * price.inputHit + completion * price.output) /
      AI_TOKENS_PER_PRICE_UNIT) *
    factor;
  return {
    yuan: roundYuan(yuan),
    peak: isPeak,
    promptTokens: prompt,
    cachedTokens: cached,
    missTokens,
    completionTokens: completion,
    totalTokens: prompt + completion,
    price,
  };
}

/**
 * 把 `ai_token_usage` 的分组行汇总成面板要的数字。
 *
 * 入参 `groups` 是 SQL 的 `GROUP BY peak, model` 结果（每行还带 `calls` / `missing`）。
 * 钱按每组自己的 `peak` 档位算，所以「今天上午高峰期花的」和「半夜跑的」不会串价。
 */
export function summarizeCost(groups = [], { env = process.env, model } = {}) {
  const sum = { promptTokens: 0, cachedTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0, missing: 0, yuan: 0 };
  let peakYuan = 0;
  let offPeakYuan = 0;
  for (const group of groups) {
    const cost = costOfUsage(group, { model: group?.model || model, peak: Boolean(group?.peak), env });
    sum.promptTokens += cost.promptTokens;
    sum.cachedTokens += cost.cachedTokens;
    sum.completionTokens += cost.completionTokens;
    sum.totalTokens += cost.totalTokens;
    sum.calls += Math.max(0, Math.round(Number(group?.calls) || 0));
    sum.missing += Math.max(0, Math.round(Number(group?.missing) || 0));
    sum.yuan += cost.yuan;
    if (cost.peak) peakYuan += cost.yuan;
    else offPeakYuan += cost.yuan;
  }
  sum.yuan = roundYuan(sum.yuan);
  return { ...sum, peakYuan: roundYuan(peakYuan), offPeakYuan: roundYuan(offPeakYuan) };
}

/** 面板上那句「这张账按什么算」的话 —— 后端给文案，前端只管显示。 */
export function priceNote(price, { peak } = {}) {
  const when = peak ? '此刻是高峰时段' : '此刻是空闲时段';
  if (!price?.known) {
    return `模型 ${price?.model || '（没配 AI_MODEL）'} 没有登记的单价，金额按 0 算；要算钱请用 ${AI_PRICE_ENV_KEYS.inputMiss} / ${AI_PRICE_ENV_KEYS.inputHit} / ${AI_PRICE_ENV_KEYS.output} 登记单价。`;
  }
  return `按官方价目表算（${price.label}）：缓存未命中输入 ${price.inputMiss}、缓存命中输入 ${price.inputHit}、输出 ${price.output} ${AI_PRICE_UNIT}（高峰价，空闲时段减半）；${when}。`;
}
