// 团队文件柜的磁盘那一半。
//
// 为什么单独一个文件：`routes.js` 只管「谁能传、谁能删」这些**规则**，
// 真正碰文件系统的动作（起名、落盘、读回、删掉）集中在这里。
// 这样「用户输入有没有可能变成路径」这个问题可以在一屏里看完 —— 答案是不能：
// 用户给的文件名只进数据库的展示列（`team_files.name`），
// 磁盘上的名字由本文件用 `t<团队>-<时间>-<随机>.<扩展名>` 自己合成，
// 读回来之前还要再用白名单正则过一遍。
//
// 与头像（`src/core/sessions.js` 的 saveAvatarFile）同一套思路，
// 区别只在于团队文件不认扩展名白名单：任何文件都能存，但**一律以附件下载**，
// 不在本站的源里当页面渲染（见 attachmentHeaders 的 octet-stream + nosniff）。
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

import { HttpError } from '../../core/http.js';
import { DB_FILE, ROOT } from '../../core/paths.js';
import { MAX_TEAM_FILE_BYTES, MAX_TEAM_FILE_NAME } from './schema.js';

/**
 * 文件落盘目录。
 *
 * 默认放在**数据库旁边**（与 `data/avatars` 同一条规矩）：跟着 `DB_FILE` 走，
 * 所以测试把 `DB_FILE` 指到临时目录时，文件也一起进临时目录，
 * 不会往真实的 `data/` 里灌垃圾（这条是头像那轮踩出来的）。
 */
export const TEAM_FILE_DIR = process.env.TEAM_FILE_DIR
  || (DB_FILE === ':memory:' ? join(ROOT, 'data', 'team-files') : join(dirname(DB_FILE), 'team-files'));

/** 磁盘文件名的白名单：字母数字开头，只含 `[A-Za-z0-9._-]`。 */
const STORED_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** `data:<mime>;base64,<内容>`。mime 允许缺省（浏览器偶尔给不出）。 */
const DATA_URL_RE = /^data:([^;,]{0,120})?;base64,([A-Za-z0-9+/=]*)$/;

/** 128 KB 一挡，只用于给人看的文案。 */
export function formatBytes(bytes) {
  const size = Number(bytes) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * 把用户给的文件名收拾成一个安全的**展示名**。
 *
 * 只留下最后一段（`..\..\a.png` → `a.png`）、去掉控制字符与开头的点
 * （`.env` 会变成 `env`：展示名不需要隐藏属性，也不该以点开头）、
 * 截断到 MAX_TEAM_FILE_NAME；空的一律叫「未命名文件」。
 */
export function sanitizeFileName(raw) {
  const base = String(raw ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/^\.+/, '')
    .trim();
  return base.slice(0, MAX_TEAM_FILE_NAME).trim() || '未命名文件';
}

/** 扩展名（只用于磁盘文件名，最多 8 位字母数字；认不出用 `bin`）。 */
export function extensionOf(name) {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(String(name));
  return match ? match[1].toLowerCase() : 'bin';
}

/**
 * 校验并解码一次上传。
 *
 * @returns {{name: string, mime: string, size: number, buffer: Buffer}}
 * @throws {HttpError} 400 bad_file / empty_file / file_too_large
 */
export function parseUpload({ rawName, dataUrl }) {
  const name = sanitizeFileName(rawName);
  const match = DATA_URL_RE.exec(String(dataUrl ?? ''));
  if (!match) throw new HttpError(400, 'bad_file', '文件内容读不出来，换一个文件再试');
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length === 0) throw new HttpError(400, 'empty_file', '这个文件是空的');
  if (buffer.length > MAX_TEAM_FILE_BYTES) {
    throw new HttpError(400, 'file_too_large', `单个文件不能超过 ${formatBytes(MAX_TEAM_FILE_BYTES)}`);
  }
  return { name, mime: match[1] || 'application/octet-stream', size: buffer.length, buffer };
}

/** 落盘，返回写进库的 `stored_name`。 */
export function saveTeamFile(teamId, buffer, ext) {
  mkdirSync(TEAM_FILE_DIR, { recursive: true });
  const storedName = `t${teamId}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}.${ext}`;
  writeFileSync(join(TEAM_FILE_DIR, storedName), buffer);
  return storedName;
}

/** `stored_name` 是不是我们自己起的名字（读盘前的最后一道闸）。 */
export function isStoredName(name) {
  const value = String(name ?? '');
  return STORED_NAME_RE.test(value) && !value.includes('..');
}

/** 读回来。名字不合法或文件不在了都返回 null（调用方回 404）。 */
export function readTeamFile(storedName) {
  if (!isStoredName(storedName)) return null;
  try {
    return readFileSync(join(TEAM_FILE_DIR, storedName));
  } catch {
    return null;
  }
}

/** 删盘上的文件。删不掉就静默 —— 库里那行已经软删了，磁盘残渣不该让接口失败。 */
export function removeTeamFile(storedName) {
  if (!isStoredName(storedName)) return false;
  try {
    rmSync(join(TEAM_FILE_DIR, storedName), { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 下载响应头。
 *
 * `application/octet-stream` + `Content-Disposition: attachment` + `nosniff` 三件套：
 * 哪怕有人传上来一个 `.html` 或 `.svg`，浏览器也只会存成文件，
 * 不会在我们的源里把它当页面渲染（那样就成了存储型 XSS）。
 * 中文文件名走 RFC 5987 的 `filename*`，同时给一个 ASCII 兜底名。
 */
export function attachmentHeaders({ name, size }) {
  const ascii = String(name).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': String(size),
    'Cache-Control': 'private, no-store',
  };
}
