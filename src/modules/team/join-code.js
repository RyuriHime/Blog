// 团队号：一串 6 位的「暗号」，念给朋友听、抄在纸上都不会错太多。
//
// 为什么要它：slug 是 URL 里那个东西（`#/team/frontend-group`），分享给别人时得复制一长串；
// 而「需要邀请」的团队本来就没有自助入口 —— 团队号就是那个入口：
// 管理员把 6 位号发出去，谁拿到谁就能进来，不用先加好友、不用找管理员点按钮。
//
// ── 为什么字母表里没有 I / L / O / U ──
// 生成用的字母表照抄 Crockford Base32（`schema.js` 的 `TEAM_JOIN_CODE_ALPHABET`）：
// 去掉 I / L / O 是因为念出来会听错、抄下来会看错（1 和 l、0 和 O），
// 去掉 U 是为了不拼出脏话。
//
// ── 为什么「用户输入」还要折一次 ──
// 生成时不会出现 I / L / O，但**别人抄的时候会写**：把 `1` 抄成 `I`、`0` 抄成 `O`
// 是最常见的手误。所以查号之前先把 I / L 折成 1、O 折成 0，再要求
// 「6 位、且每一位都在字母表里」—— 抄错大小写、多打了空格或短横线，都还能救回来。
import { randomInt } from 'node:crypto';
import { ensure } from '../../core/http.js';
import { TEAM_JOIN_CODE_ALPHABET, TEAM_JOIN_CODE_LENGTH } from './schema.js';

const ALPHABET_SET = new Set(TEAM_JOIN_CODE_ALPHABET.split(''));

/** 随机生成一个 6 位团队号（用 `randomInt` 而不是 `Math.random`：它不该是可预测的）。 */
export function randomJoinCode() {
  let code = '';
  for (let i = 0; i < TEAM_JOIN_CODE_LENGTH; i += 1) {
    code += TEAM_JOIN_CODE_ALPHABET[randomInt(TEAM_JOIN_CODE_ALPHABET.length)];
  }
  return code;
}

/**
 * 把用户输入的团队号折成标准形状。
 *
 * 返回 `null` 表示「这不像一个团队号」（长度不对或有非法字符），
 * 由调用方决定怎么说这句话 —— 迁移里回填和接口里报错要的文案不一样。
 */
export function normalizeJoinCode(raw) {
  const folded = String(raw ?? '')
    .toUpperCase()
    // 空格、短横线是分享时最容易被带进来的东西（「ABCD-EF」），一律先扔掉再数长度。
    .replace(/[^0-9A-Z]/g, '')
    .replace(/I/g, '1')
    .replace(/L/g, '1')
    .replace(/O/g, '0');
  if (folded.length !== TEAM_JOIN_CODE_LENGTH) return null;
  for (const char of folded) {
    if (!ALPHABET_SET.has(char)) return null;
  }
  return folded;
}

/** 输入不像团队号就 400。文案把「6 位」写出来，省得人对着输入框猜。 */
export function readJoinCode(raw) {
  const code = normalizeJoinCode(raw);
  ensure(
    code,
    400,
    'bad_join_code',
    `团队号是 ${TEAM_JOIN_CODE_LENGTH} 位字母加数字，检查一下有没有抄错`,
  );
  return code;
}

/**
 * 取一个**还没人用过**的团队号。
 *
 * 用「先随机、再查重、撞了就重来」而不是维护计数器：团队号不该是连号的
 * （连号等于把「站上有多少个团队、谁先建的」写在脸上）。
 * 32^6 ≈ 10.7 亿，40 次都撞上说明在生成层面就出了问题，宁可抛错也不要发一个重复的号。
 */
export function pickJoinCode(queries) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const code = randomJoinCode();
    if (!queries.joinCodeTaken(code)) return code;
  }
  throw new Error('[team] 连续 40 次都生成到已被占用的团队号，请检查随机数来源');
}
