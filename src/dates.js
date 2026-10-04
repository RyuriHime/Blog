/**
 * 日期工具：全部按「服务器本地时区」的 YYYY-MM-DD 字符串处理，
 * 签到按自然周（周一为一周起点）统计，避免用时间戳做日历运算带来的时区坑。
 */

const pad = (value) => String(value).padStart(2, '0');

/** 时间戳（或当前时间）→ YYYY-MM-DD */
export function dayString(timestamp = Date.now()) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export const todayString = () => dayString();

/** YYYY-MM-DD → 当天 00:00 的本地 Date */
export function parseDay(day) {
  const [year, month, date] = String(day).split('-').map(Number);
  return new Date(year, month - 1, date);
}

export function addDays(day, amount) {
  const date = parseDay(day);
  date.setDate(date.getDate() + amount);
  return dayString(date.getTime());
}

/** 0 = 周一 … 6 = 周日 */
export function weekdayIndex(day) {
  return (parseDay(day).getDay() + 6) % 7;
}

/** 该日期所在自然周的周一 */
export function weekStartOf(day) {
  return addDays(day, -weekdayIndex(day));
}

/** 从周一到周日的 7 个日期 */
export function weekDays(weekStart) {
  return Array.from({ length: 7 }, (_item, index) => addDays(weekStart, index));
}

/** 两个日期相差多少天（b - a） */
export function diffDays(from, to) {
  return Math.round((parseDay(to).getTime() - parseDay(from).getTime()) / 86400000);
}

export const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'];

export function weekdayLabel(day) {
  return WEEKDAY_LABELS[weekdayIndex(day)];
}

/** 最近 count 天的日期数组（含今天，升序） */
export function recentDays(count, endDay = todayString()) {
  return Array.from({ length: count }, (_item, index) => addDays(endDay, -(count - 1 - index)));
}

/** 日期是否晚于今天（用于日历里把未来日期置灰） */
export const isFutureDay = (day, today = todayString()) => day > today;
