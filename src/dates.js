/**
 * 日期工具：全部按「服务器本地时区」的 YYYY-MM-DD 字符串处理，
 * 自然周以周一为一周起点，避免用时间戳做日历运算带来的时区坑。
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
