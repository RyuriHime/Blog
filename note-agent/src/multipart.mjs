/**
 * 上传通道：读原始 body、解析 multipart/form-data、判定文件类型。
 *
 * 刻意不依赖任何 npm 包（宿主仓库零依赖），也不需要流式落盘：
 * 单文件上限 4MB、单会话 12MB，整段读进内存最简单也最不容易出错。
 */
import { UPLOAD_RULES as RULES } from './uploads-meta.mjs';

export class UploadError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'UploadError';
    this.code = code;
  }
}

export const UPLOAD_RULES = RULES;

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const PDF_MAGIC = Buffer.from('%PDF-', 'utf8');
const WORD_MARKER = Buffer.from('word/', 'utf8');
const PPT_MARKER = Buffer.from('ppt/', 'utf8');

const TEXT_EXTENSIONS = ['.md', '.markdown', '.txt'];
const OFFICE_EXTENSIONS = {
  '.docx': 'docx',
  '.pptx': 'pptx',
  '.pdf': 'pdf',
};

/**
 * 读出请求的原始字节。超过上限时抛 UploadError（调用方映射成 413）。
 * @param {import('node:http').IncomingMessage | Buffer | Uint8Array} req
 * @param {{ limit?: number }} [options]
 * @returns {Promise<Buffer>}
 */
export async function readRawBody(req, { limit = RULES.maxSessionBytes } = {}) {
  if (Buffer.isBuffer(req)) {
    if (req.length > limit) throw new UploadError('上传内容过大', 'notes_too_large');
    return req;
  }
  if (req instanceof Uint8Array) return readRawBody(Buffer.from(req), { limit });
  if (!req || typeof req[Symbol.asyncIterator] !== 'function') {
    throw new UploadError('请求体不可读', 'notes_bad_request');
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > limit) {
      req.destroy?.();
      throw new UploadError('上传内容过大', 'notes_too_large');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** 取 Content-Type 的 boundary 参数；没有则返回 ''。 */
export function readBoundary(contentType) {
  const header = String(contentType || '');
  if (!/multipart\/form-data/i.test(header)) return '';
  const match = /;\s*boundary=("([^"]*)"|[^;\s]+)/i.exec(header);
  if (!match) return '';
  return (match[2] ?? match[1] ?? '').trim();
}

/** 把 `filename*=UTF-8''%E7%AC%94%E8%AE%B0.pdf` 或 `C:\a\b.md` 归一成安全的裸文件名。 */
export function decodeFilename(raw) {
  let value = String(raw ?? '');

  // RFC 5987: charset'lang'percent-encoded
  const extended = /^([\w-]+)'([\w-]*)'(.*)$/s.exec(value);
  if (extended) value = percentDecode(extended[3]);

  // 任何路径分隔符都只取最后一段（同时堵死 ../ 与 Windows 盘符）
  const segments = value.split(/[\\/]/);
  value = segments[segments.length - 1] ?? '';

  // 控制字符（含 \n \r \t \u0000）与首尾空白
  value = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return value.length > 0 ? value : '未命名';
}

function percentDecode(value) {
  const out = [];
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char === '%' && /^[0-9a-fA-F]{2}$/.test(value.slice(i + 1, i + 3))) {
      out.push(Number.parseInt(value.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      const bytes = Buffer.from(char, 'utf8');
      for (const byte of bytes) out.push(byte);
    }
  }
  return Buffer.from(out).toString('utf8');
}

function parseDisposition(header) {
  const result = { name: '', filename: '', hasFilename: false };
  if (!header) return result;
  const star = /;\s*filename\*\s*=\s*("[^"]*"|[^;\r\n]*)/i.exec(header);
  const plain = /;\s*filename\s*=\s*("[^"]*"|[^;\r\n]*)/i.exec(header);
  const nameMatch = /;\s*name\s*=\s*("[^"]*"|[^;\r\n]*)/i.exec(header);

  if (nameMatch) result.name = unquote(nameMatch[1]);
  if (star) {
    result.filename = decodeFilename(unquote(star[1]));
    result.hasFilename = true;
  } else if (plain) {
    result.filename = decodeFilename(unquote(plain[1]));
    result.hasFilename = true;
  }
  return result;
}

function unquote(value) {
  const text = String(value ?? '').trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1);
  return text;
}

/**
 * 解析 multipart/form-data。
 * @param {Buffer} buffer
 * @param {string} contentType
 * @returns {{ fields: Record<string, string>, files: Array<{ field: string, filename: string, mime: string, data: Buffer }> }}
 */
export function parseMultipart(buffer, contentType) {
  const boundary = readBoundary(contentType);
  if (!boundary) return { fields: {}, files: [] };

  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  const marker = Buffer.from(`--${boundary}`, 'utf8');
  const fields = {};
  const files = [];

  let cursor = data.indexOf(marker);
  if (cursor < 0) return { fields, files };

  while (cursor >= 0) {
    let head = cursor + marker.length;
    if (data.slice(head, head + 2).toString('latin1') === '--') break; // 收尾边界
    if (data.slice(head, head + 2).toString('latin1') === '\r\n') head += 2;
    else if (data.slice(head, head + 1).toString('latin1') === '\n') head += 1;

    const next = data.indexOf(marker, head);
    if (next < 0) {
      parsePart(data.subarray(head), parseDisposition(''));
      break;
    }
    let end = next;
    if (data.slice(end - 2, end).toString('latin1') === '\r\n') end -= 2;
    else if (data.slice(end - 1, end).toString('latin1') === '\n') end -= 1;

    parsePart(data.subarray(head, end));
    cursor = next;
  }

  return { fields, files };

  function parsePart(chunk) {
    if (chunk.length === 0) return;
    const separator = indexOfHeaderEnd(chunk);
    if (separator < 0) return;
    const [headerEnd, separatorLength] = separator;
    const headerText = chunk.subarray(0, headerEnd).toString('utf8');
    const body = chunk.subarray(headerEnd + separatorLength);

    const disposition = /content-disposition:\s*([^\r\n]*)/i.exec(headerText);
    const mimeMatch = /content-type:\s*([^\r\n;]*)/i.exec(headerText);
    const { name, filename, hasFilename } = parseDisposition(disposition ? disposition[1] : '');

    if (hasFilename) {
      files.push({ field: name, filename, mime: mimeMatch ? mimeMatch[1].trim() : 'application/octet-stream', data: Buffer.from(body) });
    } else if (name) {
      fields[name] = body.toString('utf8');
    }
  }
}

function indexOfHeaderEnd(chunk) {
  const crlf = chunk.indexOf('\r\n\r\n');
  if (crlf >= 0) return [crlf, 4];
  const lf = chunk.indexOf('\n\n');
  if (lf >= 0) return [lf, 2];
  return -1;
}

function looksLikeText(data) {
  if (data.includes(0x00)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(data);
    return true;
  } catch {
    return false;
  }
}

/**
 * 判定上传内容属于哪种抽取器。扩展名优先，但内容与扩展名冲突时以内容为准。
 * @param {{ filename?: string, mime?: string, data?: Buffer | Uint8Array }} input
 * @returns {'text' | 'docx' | 'pptx' | 'pdf'}
 */
export function classifyUpload({ filename = '', mime = '', data } = {}) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data ?? []);
  const extension = /\.[a-z0-9]+$/i.exec(String(filename).toLowerCase());
  const ext = extension ? extension[0] : '';

  // 1. 内容能明确判断的一律以内容为准（防止把 docx 改名成 .txt 混进来）
  if (bytes.subarray(0, 4).equals(ZIP_MAGIC)) {
    if (bytes.includes(WORD_MARKER)) return 'docx';
    if (bytes.includes(PPT_MARKER)) return 'pptx';
    throw new UploadError('这个 ZIP 里既没有 word/ 也没有 ppt/，无法识别', 'notes_unsupported_type');
  }
  if (bytes.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) return 'pdf';

  // 2. 扩展名是已知的 Office 类型时，也必须是合法容器
  if (OFFICE_EXTENSIONS[ext]) {
    throw new UploadError(`这个文件的扩展名是 ${ext}，但内容不是合法的 ${ext} 容器`, 'notes_unsupported_type');
  }

  // 3. 纯文本扩展名 + 真的能当文本读
  if (TEXT_EXTENSIONS.includes(ext) && looksLikeText(bytes)) return 'text';

  // 4. 扩展名不认识，但内容就是 UTF-8 文本
  if (!ext && (looksLikeText(bytes) || bytes.length === 0)) return 'text';
  if (looksLikeText(bytes) && String(mime).startsWith('text/')) return 'text';

  throw new UploadError('不支持的文件类型（只支持 .md / .markdown / .txt / .docx / .pptx / .pdf）', 'notes_unsupported_type');
}
