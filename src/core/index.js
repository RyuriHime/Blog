// src/core 的门面：所有其他文件都从这里 import，不直接深入具体文件。
// 好处是以后要挪文件、换实现，改动只落在这个文件里。
export { HttpError, ensure, ok, res_, sendJson, readJsonBody, parseCookies, rateLimit, field, buckets } from './http.js';
export { route, routes } from './router.js';
export { isOwner, isStaff, requireUser, requireStaff, requireOwner, assertPostVisible, addPostVisibility } from './guards.js';
export * from './shape.js';
export { issueSession, sessionCookie, resolveUser, sniffImageType, saveAvatarFile, removeAvatarFile } from './sessions.js';
export { serveAvatar, serveStatic, MIME } from './static.js';
export { bindStore, hasStore, store } from './store.js';
export { schemas, tablesWithoutOwner, ownedButNotRegistered } from './schema.js';
export { openDatabase } from './open-db.js';
export { forumAiStatus, mountStatusReady, noteAgentStatus, registerMountStatus } from './mount-status.js';
export { createContext } from './context.js';
export { buildServer } from './handler.js';
export {
  ROOT,
  PUBLIC_DIR,
  DB_FILE,
  AVATAR_DIR,
  AVATAR_URL_PREFIX,
  MAX_AVATAR_BYTES,
  PORT,
  HOST,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  ANON,
} from './paths.js';
