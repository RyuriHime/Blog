/**
 * 读取 ZIP 容器时抽块 / 收图共用的小工具。
 *
 * 三个 Office/PDF 抽取器都从这里拿 `createBlockSink()`：它负责 id 编号（b1…bn）、
 * 空段落丢弃、图片大小与格式过滤——这些规则只写一份，三个抽取器不会各自漂移。
 */
import { BLOCK_TYPES } from '../blocks.mjs';

/** 单张图片上限 2MB（与 spec 一致）。 */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** 扩展名 → MIME；不在表里的图片格式一律跳过。 */
export const IMAGE_MIME_BY_EXTENSION = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

const ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&nbsp;': ' ',
};

export function decodeXmlEntities(text) {
  return String(text ?? '').replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g, (match) => ENTITIES[match] ?? match);
}

/** 折叠空白、去控制字符、解实体：XML 里一个段落的可读文本。 */
export function normalizeText(text) {
  return decodeXmlEntities(String(text ?? ''))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 取出 XML 片段里某个标签的全部文本，按出现顺序拼接。 */
export function collectTagText(xml, tag) {
  const parts = [];
  const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'g');
  for (const match of String(xml ?? '').matchAll(pattern)) parts.push(match[1]);
  return parts.join('');
}

/**
 * 创建一个"块 + 图片"收集器。
 * @param {{ name?: string }} [options]
 */
export function createBlockSink({ name = 'material' } = {}) {
  const blocks = [];
  const images = [];
  const warnings = [];

  return {
    blocks,
    images,
    warnings,
    warning(code, message) {
      warnings.push({ code, message });
    },
    /**
     * @param {{ type: string, text: string, level?: number, meta?: object }} block
     * @returns {boolean} 是否真的收下了（空文本会被丢弃）
     */
    add(block) {
      const text = normalizeText(block.text);
      if (text.length === 0) return false;
      if (!BLOCK_TYPES.includes(block.type)) throw new Error(`未知块类型 ${block.type}`);
      const next = { id: `b${blocks.length + 1}`, type: block.type, text };
      if (block.level !== undefined) next.level = block.level;
      if (block.meta !== undefined) next.meta = block.meta;
      blocks.push(next);
      return true;
    },
    /**
     * 收一张图片（超 2MB 或格式不认识就记警告并跳过）。
     * @returns {boolean}
     */
    addImage({ name: imageName, data }) {
      const extension = (/\.[a-z0-9]+$/i.exec(String(imageName ?? '').toLowerCase()) ?? [''])[0];
      const mime = IMAGE_MIME_BY_EXTENSION[extension];
      if (!mime) {
        warnings.push({ code: 'image_skipped', message: `跳过不支持的图片格式：${imageName}` });
        return false;
      }
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data ?? []);
      if (buffer.length > MAX_IMAGE_BYTES) {
        warnings.push({ code: 'image_skipped', message: `跳过超过 2MB 的图片：${imageName}` });
        return false;
      }
      images.push({
        id: `img${images.length + 1}`,
        name: String(imageName ?? ''),
        mime,
        /**
         * 原始字节数（不是 base64 的长度）。
         *
         * 以前这里不写 `bytes`，于是 `routes.mjs` 的 `bytes: Number(image.bytes) || 0`
         * 在附件表里永远存 0 —— 面板与排查都看不出这张图有多大。
         */
        bytes: buffer.length,
        dataUrl: `data:${mime};base64,${buffer.toString('base64')}`,
      });
      return true;
    },
    /** 收尾。**不**在这里加 empty_material：不同格式对"没文字"有不同的解释（PDF 是没文本层）。 */
    finish() {
      return { blocks, images, warnings };
    },
  };
}
