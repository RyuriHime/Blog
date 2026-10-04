import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const KEY_LENGTH = 64;

/** 生成 `scrypt$salt$hash` 格式的密码摘要（每个用户独立随机盐）。 */
export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(password), salt, KEY_LENGTH);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/** 恒定时间比对，避免时序侧信道。 */
export function verifyPassword(password, stored) {
  try {
    const [scheme, saltHex, hashHex] = String(stored ?? '').split('$');
    if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
    const expected = Buffer.from(hashHex, 'hex');
    if (expected.length === 0) return false;
    const actual = scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}
