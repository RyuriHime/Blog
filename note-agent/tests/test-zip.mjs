import { createChecker } from './helpers/check.mjs';
import {
  buildZip,
  buildTruncatedZip,
  buildCorruptedZip,
  buildZipWithDeclaredSize,
  buildZipWithShrunkDeclaredSize,
} from './helpers/zip-fixture.mjs';
import { openZip, listZipEntries, ZipError } from '../src/zip.mjs';

const { check, summary } = createChecker();

const zip = buildZip([
  { name: 'word/document.xml', data: '<w:document>你好</w:document>' },
  { name: 'word/media/image1.png', data: 'PNG-BYTES', stored: true },
  { name: '[Content_Types].xml', data: '<Types/>' },
]);

const names = listZipEntries(zip).map((entry) => entry.name);
check('列出全部条目且顺序为写入顺序', names.join('|') === 'word/document.xml|word/media/image1.png|[Content_Types].xml');

const archive = openZip(zip);
check('deflate 条目解出原文（含中文）', archive.get('word/document.xml').toString('utf8') === '<w:document>你好</w:document>');
check('stored 条目原样解出', archive.get('word/media/image1.png').toString('utf8') === 'PNG-BYTES');
check('缺失条目 get() 返回 null 而不是抛错', archive.get('nope.xml') === null);
check('openZip 返回的 entries 与 listZipEntries 数量一致', archive.entries.length === 3);

const truncated = buildTruncatedZip([{ name: 'a.txt', data: 'hello' }]);
let code = '';
try {
  listZipEntries(truncated);
} catch (error) {
  code = error.code;
}
check('【RF-1】截断的 ZIP 抛 zip_bad_archive 而不是内部错误', code === 'zip_bad_archive');
check('ZipError 是 Error 子类且带 code', new ZipError('x', 'zip_bad_archive') instanceof Error && new ZipError('x', 'zip_bad_archive').code === 'zip_bad_archive');

const notZip = Buffer.from('这根本不是 ZIP 文件');
let code2 = '';
try {
  listZipEntries(notZip);
} catch (error) {
  code2 = error.code;
}
check('【RF-1】完全不是 ZIP 时也是 zip_bad_archive', code2 === 'zip_bad_archive');

const corrupted = buildCorruptedZip([{ name: 'a.txt', data: 'hello world', stored: true }]);
let code3 = '';
try {
  openZip(corrupted);
} catch (error) {
  code3 = error.code;
}
check('【RF-1】数据与中央目录 CRC 不符时抛 zip_bad_archive', code3 === 'zip_bad_archive');

const withDir = openZip(buildZip([{ name: 'dir/', data: '' }, { name: 'dir/x.txt', data: 'hi' }]));
check('目录条目保留在 entries 里且 buffer 为空', withDir.entries.length === 2 && withDir.get('dir/').length === 0);

// 解压炸弹闸门。这不是理论风险：一个 4.7 MB 的 zip 曾实测解出 4.8 GB，Buffer 在 V8 堆外
// 所以 --max-old-space-size 拦不住，爆的是整个宿主进程的 RSS。
const entryBomb = buildZipWithDeclaredSize({ name: 'bomb.bin', data: Buffer.alloc(1024), declaredSize: 1024 * 1024 * 1024 });
let entryCode = '';
try {
  openZip(entryBomb);
} catch (error) {
  entryCode = error.code;
}
check('【安全】单条目声明长度超过上限时拒绝解压', entryCode === 'zip_too_large', `code=${entryCode}`);

const lyingBomb = buildZipWithShrunkDeclaredSize({ name: 'liar.bin', data: Buffer.alloc(32 * 1024 * 1024), declaredSize: 1024 });
let liarCode = '';
try {
  openZip(lyingBomb);
} catch (error) {
  liarCode = error.code;
}
check('【安全】声明长度撒谎时解压先被 maxOutputLength 拦下（不会先吃满内存）', liarCode === 'zip_inflate_failed', `code=${liarCode}`);

// 五个 stored 条目、每个真实 512 KB，却都声明解压后 32 MB：合计 160 MB 超过 64 MB 上限。
const totalBomb = buildZip(
  [0, 1, 2, 3, 4].map((index) => ({
    name: `part${index}.bin`,
    data: Buffer.alloc(512 * 1024),
    stored: true,
  })),
);
{
  const centralAt = totalBomb.readUInt32LE(totalBomb.length - 22 + 16);
  let cursor = centralAt;
  for (const entry of listZipEntries(totalBomb)) {
    totalBomb.writeUInt32LE(32 * 1024 * 1024, entry.offset + 22); // local header
    totalBomb.writeUInt32LE(32 * 1024 * 1024, cursor + 24); // central directory
    cursor += 46 + entry.name.length;
  }
}
let totalCode = '';
try {
  openZip(totalBomb);
} catch (error) {
  totalCode = error.code;
}
check('【安全】多条目声明长度合计超限时在解压前就被拒', totalCode === 'zip_too_large', `code=${totalCode}`);

const normal = openZip(buildZip([{ name: 'ok.txt', data: 'x'.repeat(4096) }]));
check('【回归】正常的 deflate 条目依旧解得出', normal.get('ok.txt').toString('utf8').length === 4096);

// 反证：闸门确实在"解压前"生效，而不是"解压爆内存之后再报错"。
// 32 MB 的真实内容声明成 1 KB —— 没有 maxOutputLength 的话这一步会先分配 32 MB。
const before = process.memoryUsage().external;
try {
  openZip(lyingBomb);
} catch {
  // 预期路径
}
const growth = process.memoryUsage().external - before;
check('【安全】被拦下的解压没有真的分配出去（外部内存增长很小）', growth < 8 * 1024 * 1024, `growth=${growth}`);

summary();
