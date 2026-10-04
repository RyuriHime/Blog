/**
 * 最小 ZIP 读取器（零依赖）。
 *
 * 只为读 Office OOXML 容器（.docx / .pptx 就是 ZIP）服务，所以只实现：
 *   - 从尾部找 EOCD（End of Central Directory，0x06054b50）
 *   - 解析 Central Directory（0x02014b50）拿到条目名、压缩方式、偏移
 *   - 读 Local File Header（0x04034b50）取数据
 *   - method 0 原样返回、method 8 走 zlib.inflateRawSync、其它抛错
 * 不支持：加密、ZIP64、多分卷、data descriptor 后置大小。
 *
 * 一切"这个容器不对劲"的情况都收敛成 ZipError，绝不把 zlib / Buffer 的内部
 * 错误漏给调用方（调用方要把它翻译成 notes_extract_failed）。
 */
import { inflateRawSync } from 'node:zlib';

export class ZipError extends Error {
  constructor(message, code = 'zip_bad_archive') {
    super(message);
    this.name = 'ZipError';
    this.code = code;
  }
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;
const CENTRAL_MIN_SIZE = 46;
const LOCAL_MIN_SIZE = 30;
/** ZIP 注释最长 65535 字节，EOCD 一定落在文件最后 (22 + 65535) 字节内。 */
const MAX_COMMENT = 0xffff;
/** method 0 = stored，method 8 = deflate，其余不支持。 */
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function toBuffer(input, what) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  throw new ZipError(`${what}必须是 Buffer`, 'zip_bad_archive');
}

/** 从尾部往前找 EOCD，返回它在 buffer 中的下标；找不到返回 -1。 */
function findEocd(buffer) {
  const floor = Math.max(0, buffer.length - EOCD_MIN_SIZE - MAX_COMMENT);
  for (let i = buffer.length - EOCD_MIN_SIZE; i >= floor; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  return -1;
}

/**
 * 读出全部条目（按 central directory 里的顺序，也就是写入顺序）。
 * @param {Buffer | Uint8Array} input
 * @returns {Array<{ name: string, method: number, crc32: number, compressedSize: number, size: number, offset: number }>}
 */
export function listZipEntries(input) {
  const buffer = toBuffer(input, 'ZIP 内容');
  if (buffer.length < EOCD_MIN_SIZE) throw new ZipError('不是有效的 ZIP：文件太短');

  const eocdAt = findEocd(buffer);
  if (eocdAt < 0) throw new ZipError('不是有效的 ZIP：找不到中央目录结尾记录（容器可能被截断）');

  const total = buffer.readUInt16LE(eocdAt + 10);
  const centralSize = buffer.readUInt32LE(eocdAt + 12);
  const centralOffset = buffer.readUInt32LE(eocdAt + 16);
  if (centralOffset + centralSize > buffer.length) {
    throw new ZipError('不是有效的 ZIP：中央目录超出文件范围');
  }

  const entries = [];
  let cursor = centralOffset;
  for (let index = 0; index < total; index += 1) {
    if (cursor + CENTRAL_MIN_SIZE > buffer.length) {
      throw new ZipError('不是有效的 ZIP：中央目录条目被截断');
    }
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new ZipError('不是有效的 ZIP：中央目录条目签名不正确');
    }
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const nameAt = cursor + CENTRAL_MIN_SIZE;
    const nameEnd = nameAt + nameLength;
    if (nameEnd > buffer.length) {
      throw new ZipError('不是有效的 ZIP：条目名被截断');
    }
    entries.push({
      name: buffer.toString('utf8', nameAt, nameEnd),
      method: buffer.readUInt16LE(cursor + 10),
      crc32: buffer.readUInt32LE(cursor + 16),
      compressedSize: buffer.readUInt32LE(cursor + 20),
      size: buffer.readUInt32LE(cursor + 24),
      offset: buffer.readUInt32LE(cursor + 42),
    });
    cursor = nameEnd + extraLength + commentLength;
  }

  if (entries.length !== total) {
    throw new ZipError('不是有效的 ZIP：条目数与中央目录记录不一致');
  }
  return entries;
}

/**
 * 解压炸弹闸门：**先按声明长度判，再解压**。
 *
 * 为什么必须有：`inflateRawSync` 默认不设上限，一个 4.7 MB 的 zip 可以解出 4.8 GB。
 * Buffer 在 V8 堆外，`--max-old-space-size` 拦不住它，爆的是进程 RSS —— 也就是
 * 整个论坛 HTTP 服务。DOCX/PPTX 是用户上传的文件，所以这是可达的远程 OOM。
 *
 * 声明长度（中央目录里的 `size`）本身不可信，但配合 `maxOutputLength` 就够了：
 * 声明可以撒谎，撒谎就解压失败（长度不符），一样进不来。
 */
export const ZIP_ENTRY_MAX_BYTES = 16 * 1024 * 1024;
export const ZIP_TOTAL_MAX_BYTES = 64 * 1024 * 1024;

/** 解出单个条目的内容。 @returns {Buffer} */
export function readZipEntry(input, entry) {
  const buffer = toBuffer(input, 'ZIP 内容');
  if (!entry || typeof entry !== 'object') throw new ZipError('条目信息缺失');
  if (entry.size > ZIP_ENTRY_MAX_BYTES) {
    throw new ZipError(`条目 ${entry.name} 解压后太大（声明 ${entry.size} 字节，上限 ${ZIP_ENTRY_MAX_BYTES}）`, 'zip_too_large');
  }

  const offset = entry.offset;
  if (offset + LOCAL_MIN_SIZE > buffer.length) {
    throw new ZipError(`条目 ${entry.name} 的数据位置超出文件范围`);
  }
  if (buffer.readUInt32LE(offset) !== LOCAL_SIGNATURE) {
    throw new ZipError(`条目 ${entry.name} 的本地文件头签名不正确`);
  }
  const flag = buffer.readUInt16LE(offset + 6);
  if (flag & 0x1) throw new ZipError(`条目 ${entry.name} 是加密的，无法读取`);
  if (flag & 0x8) throw new ZipError(`条目 ${entry.name} 的大小写在数据描述符里，不支持`);

  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const dataAt = offset + LOCAL_MIN_SIZE + nameLength + extraLength;
  const compressedSize = entry.compressedSize;
  if (dataAt + compressedSize > buffer.length) {
    throw new ZipError(`条目 ${entry.name} 的数据被截断`);
  }
  const raw = buffer.subarray(dataAt, dataAt + compressedSize);

  let data;
  if (entry.method === METHOD_STORED) {
    data = Buffer.from(raw);
  } else if (entry.method === METHOD_DEFLATE) {
    try {
      // maxOutputLength 是硬闸：声明长度撒谎（说 1 KB 实际 1 GB）时解压直接失败，
      // 不会先把内存吃掉再报错。
      data = inflateRawSync(raw, { maxOutputLength: Math.max(entry.size, 1) });
    } catch (error) {
      throw new ZipError(`条目 ${entry.name} 解压失败：${error.message}`, 'zip_inflate_failed');
    }
  } else {
    throw new ZipError(`条目 ${entry.name} 使用了不支持的压缩方式 ${entry.method}`, 'zip_unsupported_method');
  }

  if (data.length !== entry.size) {
    throw new ZipError(`条目 ${entry.name} 解压后长度不符（期望 ${entry.size}，实际 ${data.length}）`, 'zip_size_mismatch');
  }
  if (crc32(data) !== entry.crc32) {
    throw new ZipError(`条目 ${entry.name} 内容校验失败（CRC 不符）`);
  }
  return data;
}

/**
 * 一次性把整个容器读进内存：目录条目保持 name 与空 Buffer，普通条目带解压后的内容。
 * @param {Buffer | Uint8Array} input
 * @returns {{ entries: Array<{ name: string, buffer: Buffer }>, get: (name: string) => Buffer | null }}
 */
export function openZip(input) {
  const buffer = toBuffer(input, 'ZIP 内容');
  const listed = listZipEntries(buffer);
  // 解压**之前**先按声明长度算总量：这是第一道闸，`maxOutputLength` 是第二道。
  let declared = 0;
  for (const entry of listed) {
    if (entry.name.endsWith('/')) continue;
    declared += entry.size;
    if (declared > ZIP_TOTAL_MAX_BYTES) {
      throw new ZipError(`这个压缩包解压后太大（超过 ${ZIP_TOTAL_MAX_BYTES} 字节）`, 'zip_too_large');
    }
  }
  const entries = listed.map((entry) => ({
    name: entry.name,
    buffer: entry.name.endsWith('/') ? Buffer.alloc(0) : readZipEntry(buffer, entry),
  }));
  const byName = new Map(entries.map((entry) => [entry.name, entry.buffer]));
  return {
    entries,
    get: (name) => (byName.has(name) ? byName.get(name) : null),
  };
}
