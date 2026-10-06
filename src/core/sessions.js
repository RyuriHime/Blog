// 搬运自 src/server.js 的固定行区间（预铺骨架，逐字未改），见 docs/tools/extract-server-modules.mjs。
import { mkdirSync } from 'node:fs';
import { unlink, writeFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ensure, ok, parseCookies, res_ } from './http.js';
import { isOwner, isStaff } from './guards.js';
import { store } from './store.js';
import { AVATAR_DIR, AVATAR_URL_PREFIX, MAX_AVATAR_BYTES, SESSION_COOKIE, SESSION_TTL_MS } from './paths.js';
import { shapeUser } from './shape.js';
import { MIME } from './static.js';

/* ------------------------------------------------------------------ */
/* 请求处理                                                            */
/* ------------------------------------------------------------------ */

function issueSession(userId) {
  const token = randomBytes(24).toString('hex');
  store.createSession(token, userId, SESSION_TTL_MS);
  return token;
}

function sessionCookie(token, maxAgeSeconds = SESSION_TTL_MS / 1000) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

function resolveUser(req) {
  const token = parseCookies(req.headers.cookie).get(SESSION_COOKIE);
  if (!token) return { user: null, sessionToken: null };
  const session = store.sessionByToken(token);
  if (!session) return { user: null, sessionToken: null };
  if (Number(session.expires_at) < Date.now()) {
    store.deleteSession(token);
    return { user: null, sessionToken: null };
  }
  const user = store.userById(session.user_id);
  if (!user || user.banned) {
    store.deleteSession(token);
    return { user: null, sessionToken: null };
  }
  store.touchSession(token, Date.now() + SESSION_TTL_MS);
  return { user, sessionToken: token };
}

/* ------------------------------------------------------------------ */
/* 头像：预设 emoji 或上传图片                                          */
/* ------------------------------------------------------------------ */

const AVATAR_IMAGE_TYPES = {
  png: { ext: 'png', mime: 'image/png' },
  jpeg: { ext: 'jpg', mime: 'image/jpeg' },
  webp: { ext: 'webp', mime: 'image/webp' },
};

/** 用魔数判断图片类型，不信任客户端声明的 MIME（顺便挡掉 SVG / HTML 伪装） */
function sniffImageType(buffer) {
  if (buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'png';
  }
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.length > 12 && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') {
    return 'webp';
  }
  return null;
}

/** 把 dataURL 落盘到 data/avatars/，返回可访问的站内地址 */
async function saveAvatarFile(userId, dataUrl) {
  const match = String(dataUrl ?? '').match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/);
  ensure(match, 400, 'bad_image', '只支持 PNG / JPEG / WebP 图片');
  const declared = match[1];
  const buffer = Buffer.from(match[2], 'base64');
  ensure(buffer.length > 0, 400, 'bad_image', '图片内容为空');
  ensure(
    buffer.length <= MAX_AVATAR_BYTES,
    400,
    'image_too_large',
    `头像不能超过 ${Math.round(MAX_AVATAR_BYTES / 1024)} KB`,
  );
  const type = sniffImageType(buffer);
  ensure(type, 400, 'bad_image', '图片格式识别失败（不支持 SVG）');
  ensure(type === declared, 400, 'bad_image', '图片内容与声明的格式不一致');

  mkdirSync(AVATAR_DIR, { recursive: true });
  const filename = `u${userId}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}.${AVATAR_IMAGE_TYPES[type].ext}`;
  await writeFile(join(AVATAR_DIR, filename), buffer);
  return `${AVATAR_URL_PREFIX}${filename}`;
}

/** 换头像时删掉旧文件（只动我们自己目录里的，失败也不影响主流程） */
async function removeAvatarFile(avatar) {
  // 存库格式是 `file:/avatars/xxx.png`，去掉前缀后再校验文件名
  const url = String(avatar ?? '').replace(/^file:/, '');
  if (!url.startsWith(AVATAR_URL_PREFIX)) return;
  const name = url.slice(AVATAR_URL_PREFIX.length);
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.includes('..')) return;
  try {
    await unlink(join(AVATAR_DIR, name));
  } catch {
    /* 文件不存在就忽略 */
  }
}

export { issueSession, sessionCookie, resolveUser, sniffImageType, saveAvatarFile, removeAvatarFile };
