/**
 * 假模型：note-agent 的测试不许真的联网。
 *
 * 用注入的 chatImpl 而不是 mock fetch —— orchestrator 只依赖 forum-ai 的 `chat` 签名，
 * 在那一层替换就能覆盖全部编排逻辑，也避免测试去猜 HTTP 请求的形状。
 *
 * 两个约定（都为了让"重试"类测试能写准）：
 *   - 每条 reply 可以带 `finishReason`（默认 'stop'）。传 'length' 表示这次被 max_tokens
 *     截断（推理模型的思维链也算预算，真机验收踩过）；`raw.choices[0].finish_reason`
 *     里也放一份，与 forum-ai `chat()` 的真实返回形状一致。
 *   - 用完之后：默认重复最后一条（方便"同一段对话问两次"的用例）；传
 *     `{ repeatLast: false }` 则**抛出 `ai_empty_response`** —— 与 forum-ai `chat()` 在
 *     正文为空时的真实行为一致（真机上思维链吃满 max_tokens 就是这个结果）。
 */
const EMPTY_ERROR_MESSAGE = 'ai_empty_response';
/**
 * 把一条 reply 归一成假模型要返回的文本。
 *
 * 字符串原样使用（所以 `'不是 JSON'`、`'__THROW__'`、`'{"truncated":'` 这类
 * "不完整/非法输出"的用例才能写得出来）；对象才 JSON.stringify。
 */
function toText(reply) {
  if (typeof reply === 'string') return reply;
  return JSON.stringify(reply);
}

export function createFakeChat(replies, { repeatLast = true } = {}) {
  const list = (Array.isArray(replies) ? replies : [replies]).map((r) => {
    if (r && typeof r === 'object' && typeof r.text === 'string') return { text: r.text, finishReason: r.finishReason };
    return { text: toText(r), finishReason: undefined };
  });
  const calls = [];
  let i = 0;
  return {
    calls,
    chatImpl: async (messages, options) => {
      calls.push({ messages, options });
      const entry = repeatLast ? list[Math.min(i, list.length - 1)] : list[i];
      i += 1;
      const text = entry ? entry.text : '';
      if (text === '__THROW__') {
        const error = new Error('ai_timeout');
        error.code = 'ai_timeout';
        throw error;
      }
      if (!entry) {
        // 真实世界对应的是「思维链把 max_tokens 吃光、正文一个字都没有」。
        const error = new Error(EMPTY_ERROR_MESSAGE);
        error.code = 'ai_empty_response';
        throw error;
      }
      const finishReason = entry?.finishReason ?? 'stop';
      return {
        text,
        model: 'fake-model',
        usage: { prompt: 100, completion: 50 },
        raw: { choices: [{ message: { content: text }, finish_reason: finishReason }] },
        finishReason,
      };
    },
  };
}
