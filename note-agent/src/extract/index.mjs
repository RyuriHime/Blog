/**
 * 抽取编排：一个文件 → 一组块；一组文件 → 一个会话的材料。
 *
 * 一条硬规则：**单源失败绝不中断整批**。用户一次传 5 个文件、
 * 其中一个是坏容器时，他要的是剩下 4 个能整理 + 一条明确的人话警告，
 * 而不是整批 500。只有"一个都没成"才抛错。
 */
import { assignBlockIds } from '../blocks.mjs';
import { UPLOAD_RULES, UploadError, classifyUpload } from '../multipart.mjs';
import { extractText } from './text.mjs';
import { extractDocx } from './docx.mjs';
import { extractPptx } from './pptx.mjs';
import { extractPdf } from './pdf.mjs';

const EXTRACTORS = {
  text: extractText,
  docx: extractDocx,
  pptx: extractPptx,
  pdf: extractPdf,
};

/**
 * 抽取单个上传文件。
 * @param {{ filename?: string, mime?: string, data?: Buffer | Uint8Array }} file
 * @param {{ maxFileBytes?: number }} [options]
 * @returns {Promise<{ kind: string, name: string, bytes: number, blocks: Array<object>, images: Array<object>, warnings: Array<object> }>}
 */
export async function extractMaterial(file = {}, options = {}) {
  const maxFileBytes = options.maxFileBytes ?? UPLOAD_RULES.maxFileBytes;
  const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data ?? []);
  const name = String(file.filename ?? '').trim() || '未命名';
  const bytes = data.length;

  if (bytes === 0) throw new UploadError(`「${name}」是空文件`, 'notes_bad_request');
  if (bytes > maxFileBytes) throw new UploadError(`「${name}」超过单文件上限`, 'notes_too_large');

  const kind = classifyUpload({ filename: name, mime: file.mime, data });
  const extractor = EXTRACTORS[kind];
  if (!extractor) throw new UploadError(`「${name}」的类型无法抽取`, 'notes_unsupported_type');

  const result = await extractor(data, { name });
  const blocks = assignBlockIds(result?.blocks);
  return { kind, name, bytes, blocks, images: result?.images ?? [], warnings: result?.warnings ?? [] };
}

/**
 * 抽取一组上传文件，拼成一份会话材料。
 * @param {Array<{ filename?: string, mime?: string, data?: Buffer | Uint8Array }>} files
 * @param {{ maxFileBytes?: number, maxSessionBytes?: number, maxFiles?: number }} [options]
 * @returns {Promise<{ sources: Array<object>, blocks: Array<object>, images: Array<object>, warnings: Array<object> }>}
 */
export async function extractSession(files, options = {}) {
  const maxFileBytes = options.maxFileBytes ?? UPLOAD_RULES.maxFileBytes;
  const maxSessionBytes = options.maxSessionBytes ?? UPLOAD_RULES.maxSessionBytes;
  const maxFiles = options.maxFiles ?? UPLOAD_RULES.maxFiles;

  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) throw new UploadError('至少要上传一个文件', 'notes_bad_request');
  if (list.length > maxFiles) throw new UploadError(`一次最多上传 ${maxFiles} 个文件`, 'notes_bad_request');

  // 总量先校验：省得白抽一遍才发现超限
  const totalBytes = list.reduce((sum, file) => {
    const data = Buffer.isBuffer(file?.data) ? file.data : Buffer.from(file?.data ?? []);
    return sum + data.length;
  }, 0);
  if (totalBytes > maxSessionBytes) throw new UploadError('这一批文件总量超过单会话上限', 'notes_too_large');

  const sources = [];
  const blocks = [];
  const images = [];
  const warnings = [];
  let lastError = null;

  for (const file of list) {
    const data = Buffer.isBuffer(file?.data) ? file.data : Buffer.from(file?.data ?? []);
    const name = String(file?.filename ?? '').trim() || '未命名';
    try {
      const material = await extractMaterial({ filename: name, mime: file?.mime, data }, { maxFileBytes });
      sources.push({ kind: material.kind, name: material.name, bytes: material.bytes });
      blocks.push(...material.blocks);
      images.push(...material.images);
      warnings.push(...material.warnings);
    } catch (error) {
      if (error instanceof UploadError) lastError = error;
      else lastError = new UploadError(`「${name}」抽取失败：${error?.message ?? error}`, 'notes_extract_failed');
      sources.push({
        kind: 'failed',
        name,
        bytes: data.length,
        error: { code: lastError.code, message: lastError.message },
      });
      warnings.push({ code: lastError.code, message: `「${name}」：${lastError.message}` });
    }
  }

  if (blocks.length === 0 && lastError) throw lastError;

  return {
    sources,
    blocks: assignBlockIds(blocks),
    images: renumberImages(images),
    warnings: dedupeWarnings(warnings),
  };
}

/**
 * 把每份文件各自从 1 开始的图片编号改成全局唯一。
 *
 * 抽取器的 `addImage` 用 `img${images.length + 1}` 编号，而每个抽取器都从空数组开始 ⇒
 * 两份材料各带一张图时都叫 `img1`，材料正文里两张图同名，模型的「图 N 对应 imgK」
 * 也指不出是哪张。这里统一重编成上传顺序下的 `img1…imgN`。
 *
 * 只在"这一批"里保证唯一：同一批反复抽取（编辑区每次改动都会重抽）编号是稳定的。
 */
function renumberImages(images) {
  return images.map((image, index) => ({ ...image, id: `img${index + 1}` }));
}

function dedupeWarnings(warnings) {
  const seen = new Set();
  const out = [];
  for (const warning of warnings) {
    const code = String(warning?.code ?? '');
    const key = `${code}\u0000${warning?.message ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ code, message: String(warning?.message ?? '') });
  }
  return out;
}
