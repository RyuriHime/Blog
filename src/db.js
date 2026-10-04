import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { hashPassword } from './password.js';
import { markdownToPlainText } from './markdown.js';
import { addDays, dayString, todayString, weekDays, weekStartOf } from './dates.js';


import './core/tables.sql.js'; // 副作用导入：把 18 张 core 表登记进 schemas（必须在下一行之前）
import { openDatabase } from './core/open-db.js';
import * as support from './core/open-db-support.js';
export { openDatabase };


export const DEFAULT_BOARDS = support.SEED_BOARDS;
export const COIN_RULES = { signupGrant: support.COIN_SIGNUP_GRANT, perPostLimit: support.COIN_PER_POST_LIMIT };
export const CHECKIN_RULES = {
  dailyReward: support.CHECKIN_DAILY_REWARD,
  weeklyBonus: support.CHECKIN_WEEKLY_BONUS,
  fullWeekDays: support.CHECKIN_FULL_WEEK_DAYS,
};
export const PROFILE_RULES = {
  pinLimit: support.PROFILE_PIN_LIMIT,
  categoryLimit: support.PROFILE_CATEGORY_LIMIT,
};
export const POST_VALUE_WEIGHTS = support.VALUE_WEIGHTS;
export const MESSAGE_RULES = {
  oneWayDailyLimit: support.MESSAGE_ONE_WAY_DAILY_LIMIT,
  maxLength: support.MESSAGE_MAX_LENGTH,
};

/**
 * 角色说明（users.role）：
 *   owner  站长：建站者，唯一；可以发放/收回管理员，也能隐藏、删除文章、封禁用户
 *   admin  管理员：由站长任命；可以隐藏、删除文章，封禁普通成员
 *   member 成员：只能管理自己的内容
 */
export const ROLES = { owner: 'owner', admin: 'admin', member: 'member' };
export const STAFF_ROLES = [ROLES.owner, ROLES.admin];

