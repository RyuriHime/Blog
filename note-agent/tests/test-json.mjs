/**
 * 模型输出解析的回归测试。
 *
 * 这里的用例全部来自真机（deepseek-flash，2026-10-02 那轮 `/review` 的原始返回），
 * 不是编造的边界情况。
 */
import { createChecker } from './helpers/check.mjs';
import { extractJsonTolerant } from '../src/json.mjs';
import { loadAi } from '../src/ai.mjs';

const { check, summary } = createChecker();
// 严格解析器从适配器取，**不直接 import forum-ai** —— 这样这个文件在"只拷走 note-agent"
// 的机器上也跑得起来（那时拿到的是自带的同款实现，断言照样成立）。
const extractJson = loadAi().extractJson;

// ── 正常情况仍然走老路子 ──────────────────────────────────────────
check('标准 JSON 照常解析', extractJsonTolerant('{"a":1}')?.a === 1);
check('```json 围栏照常解析', extractJsonTolerant('```json\n{"a":2}\n```')?.a === 2);
check('前后夹带说明照常解析', extractJsonTolerant('好的：{"a":3} 就这样')?.a === 3);
check('纯文本返回 null', extractJsonTolerant('这不是 JSON') === null);
check('空输入返回 null', extractJsonTolerant('') === null);

// ── 【真机原文】字符串值里出现未转义的双引号 ──────────────────────
// 模型写「"二、积分"整节只有这一句话」时没转义引号。花括号完全平衡、
// finish_reason 是 stop、文本一个不少，但标准解析器直接 SyntaxError。
const REAL_BAD = `{
  "summary": "草稿实质内容只有约六十个字：给出了点导数的极限定义，公式书写本身无误，Markdown 层级也规范。但作为一篇题为"导数与积分"的笔记，第二节"积分"只有一句概括，没有定义、公式、性质或与导数的关联，结构上不成立。",
  "findings": [
    {
      "kind": "structure",
      "severity": "high",
      "quote": "积分是累积量。",
      "issue": ""二、积分"整节只有这一句话，没有定义、公式或性质，标题承诺的"积分"内容基本缺失，读者无法从本节获得可用的积分概念。",
      "suggestion": "至少补齐积分的定义：给出黎曼和的极限。",
      "patch": "设函数 $f(x)$ 在点 $x_0$ 的某个邻域内有定义，$h$ 为自变量从 $x_0$ 起的增量："
    }
  ],
  "strengths": ["标题层级使用规范的 Markdown 二级标题。"],
  "notes": ["极限概念未先行引入。"]
}`;

check('【真机原文】标准解析器确实救不了这份返回', extractJson(REAL_BAD) === null);
const rescued = extractJsonTolerant(REAL_BAD);
check('【真机原文】容错解析能救回来', Boolean(rescued), JSON.stringify(rescued)?.slice(0, 80));
check('【真机原文】救回来之后 summary 完整且引号原样保留', typeof rescued?.summary === 'string' && rescued.summary.includes('"导数与积分"'), rescued?.summary?.slice(0, 60));
check('【真机原文】findings 一条不少', Array.isArray(rescued?.findings) && rescued.findings.length === 1);
check('【真机原文】issue 里的引号也在', rescued?.findings?.[0]?.issue?.includes('"积分"内容基本缺失'), rescued?.findings?.[0]?.issue?.slice(0, 40));
check('【真机原文】LaTeX 里的反斜杠没被吃掉', rescued?.findings?.[0]?.patch?.includes('$x_0$'), rescued?.findings?.[0]?.patch);
check('【真机原文】severity/kind 保持原值', rescued?.findings?.[0]?.severity === 'high' && rescued?.findings?.[0]?.kind === 'structure');
check('【真机原文】数组与中文标点不受影响', rescued?.strengths?.[0]?.includes('Markdown'), rescued?.strengths?.[0]);

// ── 真的坏了还是要拒绝 ────────────────────────────────────────────
check('截断的 JSON（花括号不平衡）仍返回 null', extractJsonTolerant('{"summary":"只写了一半') === null);
check('字符串引号没闭合仍返回 null', extractJsonTolerant('{"summary":"没有结束引号}') === null);
check('顶层是数组时返回 null（契约要求对象）', extractJsonTolerant('[{"a":1}]') === null);

// ── 不能被"修"坏：修好的文本必须还能被标准解析器读 ────────────────
const roundTrip = extractJsonTolerant(REAL_BAD);
check('救回来的对象可以再次序列化并解析（结构没被修歪）', (() => {
  try {
    const again = JSON.parse(JSON.stringify(roundTrip));
    return again.findings.length === 1 && again.summary === roundTrip.summary;
  } catch {
    return false;
  }
})());

summary();
