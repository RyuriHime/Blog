// 路径与环境常量。
//
// 搬运自 src/server.js:20-35，并把 HERE 的基准从 `src/` 改成 `src/core/`（多退一层）。
// 单独成文件的原因：static.js 与 sessions.js 都要用 AVATAR_DIR / AVATAR_URL_PREFIX / MIME 相关常量，
// 它们不应该为了拿常量去 import 整个 bootstrap（那会成环）。
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** src/core/ 的绝对路径。 */
const HERE = fileURLToPath(new URL('.', import.meta.url));
/** 仓库根目录（src/core/ 往上两层）。 */
export const ROOT = resolve(HERE, '..', '..');
export const PUBLIC_DIR = join(ROOT, 'public');
export const DB_FILE = process.env.DB_FILE || join(ROOT, 'data', 'forum.db');
/** 上传头像的存放目录：默认跟数据库放一起（方便整体备份/迁移），测试可用 AVATAR_DIR 隔离 */
export const AVATAR_DIR =
  process.env.AVATAR_DIR ||
  (DB_FILE === ':memory:' ? join(ROOT, 'data', 'avatars') : join(dirname(DB_FILE), 'avatars'));
export const AVATAR_URL_PREFIX = '/avatars/';
export const MAX_AVATAR_BYTES = 256 * 1024;
export const PORT = Number(process.env.PORT || 3000);
export const HOST = process.env.HOST || '127.0.0.1';

export const SESSION_COOKIE = 'forum_sid';
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
export const ANON = -1;
