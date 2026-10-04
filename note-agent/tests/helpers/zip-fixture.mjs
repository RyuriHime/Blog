/**
 * 造测试用 ZIP 容器。写入逻辑在 `src/zip-write.mjs`（脚本与测试共用同一份实现），
 * 这里只放"故意弄坏"的几个变体。
 */
import { buildZip } from '../../src/zip-write.mjs';

export { buildZip };

/** 把 EOCD 砍掉一部分，用来测"损坏的容器"。 */
export function buildTruncatedZip(files) {
  const zip = buildZip(files);
  return zip.subarray(0, Math.max(0, zip.length - 8));
}

/**
 * 只损坏第一个条目的**数据字节**（不动中央目录里的 CRC 与长度），
 * 用来测读取器会不会识破"容器完整但内容变了"。
 * 只对 stored 条目有效（deflate 会被 zip 自己拒绝）。
 */
export function buildCorruptedZip(files) {
  const zip = buildZip(files);
  const local = Buffer.from(zip);
  const first = files[0];
  const nameLength = Buffer.byteLength(first.name, 'utf8');
  local[30 + nameLength] ^= 0xff;
  return local;
}

/** buildZip 一定是 [local, name, data, …]，所以数据从 `30 + name 长度` 开始。 */
function firstEntryDataEnd(zip, name) {
  return 30 + Buffer.byteLength(name, 'utf8') + zip.readUInt32LE(18);
}

/**
 * 把**本地文件头与中央目录里声明的解压后长度同时改掉**，数据一个字节不动。
 *
 * 这是"谎报长度"的炸弹：说好的 1 GB 其实只压了几十字节。读取器若照声明长度
 * 分配/解压就是远程 OOM。
 */
export function buildZipWithDeclaredSize({ name, data, declaredSize, stored = false }) {
  const zip = buildZip([{ name, data, stored }]);
  zip.writeUInt32LE(declaredSize, 22); // local header: uncompressed size
  const dataEnd = firstEntryDataEnd(zip, name);
  zip.writeUInt32LE(declaredSize, dataEnd + 24); // central directory: uncompressed size
  return zip;
}

/**
 * 把声明长度改成比真实内容**小**：`maxOutputLength` 若没设对，解压会先吃满内存
 * 再在后面的长度校验里报错 —— 那已经晚了。
 */
export function buildZipWithShrunkDeclaredSize({ name, data, declaredSize }) {
  const zip = buildZip([{ name, data }]);
  zip.writeUInt32LE(declaredSize, 22);
  const dataEnd = firstEntryDataEnd(zip, name);
  zip.writeUInt32LE(declaredSize, dataEnd + 24);
  return zip;
}
