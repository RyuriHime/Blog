// 搬运自 src/server.js 的固定行区间（预铺骨架，逐字未改），见 docs/tools/extract-server-modules.mjs。
class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function ensure(condition, status, code, message) {
  if (!condition) throw new HttpError(status, code, message);
}

function res_(ctx) {
  return ctx.res;
}

function sendJson(res, status, payload, headers = {}) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

const ok = (res, data, headers) => sendJson(res, 200, { ok: true, data }, headers);

/**
 * 读请求体。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [limit] 这条路由允许的最大字节数。
 *   缺省 512 KB，是**全站默认**；只有明确需要更大的路由才会传第 2 个参数
 *   （团队文件柜上传 → `TEAM_FILE_BODY_LIMIT`），见 `src/core/router.js` 与
 *   `src/core/handler.js` 里 `entry.options.bodyLimit` 的用法。
 */
async function readJsonBody(req, limit = 512 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    ensure(size <= limit, 413, 'payload_too_large', '提交的内容太长了');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    ensure(
      parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed),
      400,
      'invalid_body',
      '请求体格式不正确',
    );
    return parsed;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'invalid_json', '请求体不是合法的 JSON');
  }
}

function parseCookies(header) {
  const cookies = new Map();
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    cookies.set(part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim()));
  }
  return cookies;
}

/* ---------------- 轻量速率限制（内存桶） ---------------- */
const buckets = new Map();
function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  bucket.count += 1;
  ensure(bucket.count <= limit, 429, 'rate_limited', '操作有点频繁，请稍后再试');
}

/* ---------------- 输入校验 ---------------- */
function field(value, { name = '', min = 0, max = 100000, pattern, label }) {
  ensure(typeof value === 'string', 400, 'invalid_field', `${label}格式不正确`);
  const text = value.replace(/\r\n?/g, '\n').trim();
  ensure(text.length >= min, 400, 'invalid_field', `${label}至少需要 ${min} 个字符`);
  ensure(text.length <= max, 400, 'invalid_field', `${label}不能超过 ${max} 个字符`);
  if (pattern) ensure(pattern.test(text), 400, 'invalid_field', `${label}${name}`);
  return text;
}
export {
  HttpError,
  ensure,
  res_,
  sendJson,
  ok,
  readJsonBody,
  parseCookies,
  buckets,
  rateLimit,
  field,
};
