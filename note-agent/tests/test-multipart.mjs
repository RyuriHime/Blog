import { createChecker } from './helpers/check.mjs';
import { parseMultipart, decodeFilename, classifyUpload, readRawBody, UPLOAD_RULES } from '../src/multipart.mjs';

const { check, summary } = createChecker();
const B = '----X9';
const body = Buffer.from(
  `--${B}\r\nContent-Disposition: form-data; name="sessionId"\r\n\r\n42\r\n` +
  `--${B}\r\nContent-Disposition: form-data; name="files"; filename="笔记 第一章·导数.md"\r\nContent-Type: text/markdown\r\n\r\n# 导数\r\n内容\r\n` +
  `--${B}--\r\n`,
  'utf8',
);
const parsed = parseMultipart(body, `multipart/form-data; boundary=${B}`);
check('普通字段解析为字符串', parsed.fields.sessionId === '42');
check('【RF-3】UTF-8 中文文件名完整保留', parsed.files[0].filename === '笔记 第一章·导数.md');
check('文件字节与 mime 正确', parsed.files[0].data.toString('utf8') === '# 导数\r\n内容' && parsed.files[0].mime === 'text/markdown');

check('【RF-3】filename* 百分号解码', decodeFilename("UTF-8''%E7%AC%94%E8%AE%B0.pdf") === '笔记.pdf');
check('【RF-3】Windows 全路径只取文件名', decodeFilename('C:\\Users\\x\\笔记.md') === '笔记.md');
check('【RF-3】换行与控制字符被清洗', decodeFilename('a\nb\u0000c.md') === 'abc.md');
check('空文件名回退为未命名', decodeFilename('   ') === '未命名');

check('单文件上限 4MB / 单会话 12MB / 最多 10 个源', UPLOAD_RULES.maxFileBytes === 4 * 1024 * 1024 && UPLOAD_RULES.maxSessionBytes === 12 * 1024 * 1024 && UPLOAD_RULES.maxFiles === 10);

check('扩展名优先判定', classifyUpload({ filename: 'a.md', mime: 'application/octet-stream', data: Buffer.from('# x') }) === 'text');
check('【RF-1】扩展名骗人时按 magic 纠正', classifyUpload({ filename: 'a.txt', mime: 'text/plain', data: Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('word/document.xml')]) }) === 'docx');
let code = '';
try { classifyUpload({ filename: 'a.bin', mime: 'application/octet-stream', data: Buffer.from([0x00, 0x01, 0x02, 0xff]) }); } catch (e) { code = e.code; }
check('【RF-1】完全不认识的类型抛 notes_unsupported_type', code === 'notes_unsupported_type');
check('扩展名是 .docx 但内容不是 ZIP 时也拒绝', (() => {
  try {
    classifyUpload({ filename: 'fake.docx', mime: 'application/vnd.openxmlformats', data: Buffer.from('这不是 docx') });
    return false;
  } catch (error) {
    return error.code === 'notes_unsupported_type';
  }
})());

const noBoundary = parseMultipart(body, 'multipart/form-data');
check('缺 boundary 时返回空结构而不是崩', Object.keys(noBoundary.fields).length === 0 && noBoundary.files.length === 0);

const overLimit = await readRawBody(Buffer.alloc(64), { limit: 32 }).then(() => '', (error) => error.code);
check('超过上限抛 notes_too_large', overLimit === 'notes_too_large');

const withinLimit = await readRawBody(Buffer.from('abc'), { limit: 32 });
check('未超限时返回原始字节', withinLimit.toString('utf8') === 'abc');

summary();
