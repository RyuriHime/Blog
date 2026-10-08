// 个人主页（`kind = 'profile'`）的块规则 —— 前端这一份是 `src/modules/doc/profile-rules.js`
// 的**同源副本**（需求 1 / 需求 2）。
//
// 为什么要抄一份：浏览器 import 不了服务端的 ESM，而「保存前先判定」这件事必须在**本地**
// 就算出结果 —— 用户不该点了保存才吃一个 400。两份必须**同源**：改这里就改那里，
// 差异由 `scripts/check-ui-contract.mjs` 的「前端规则与服务端一致」断言兜住。
//
// 三条规则（纯函数 + 常量，没有副作用、不碰网络）：
//   1. 至少一块 —— 主页不许被整页删空。
//   2. 块数 / 标题长度不超上限。
//   3. 「主页名片」块（头像 + 昵称 + 签名 + 关注 / 私信 / 拉黑）**有且只有一个、且必须在第一位**
//      —— 这就是需求里那块「不允许删除、编辑、移动位置」的积木块。

/** 主页最多多少块。 */
export const MAX_PROFILE_BLOCKS = 60;
/** 主页标题长度上限。 */
export const MAX_PROFILE_TITLE = 120;
/** 主页正文里所有块加起来的纯文字上限。 */
export const MAX_PROFILE_TEXT = 20000;

/** 「主页名片」块的识别标记：`app` 块的 `props.app` 就叫这个名字。 */
export const PROFILE_CARD_APP = '个人主页名片';

/**
 * 名片块的内容**由宿主（页面）渲染**，用户改不了 —— 这就是「不允许编辑」。
 *
 * 为什么做成占位而不是让沙箱脚本自己画：头像 / 昵称 / 签名 / 关注 / 私信 / 拉黑
 * 这些按钮的动作早就由页面（`public/views/user.js` + 事件总线）实现了，沙箱里
 * 重写一遍等于把关注 / 拉黑逻辑抄第二遍，还拿不到「我关注他了吗 / 我拉黑他了吗」
 * 这些**看客相对**的状态。所以块里只留一个占位标记，主页渲染时把它换成真正的卡片。
 *
 * 注：初始块（`profileSeedBlocks`）只在服务端 seed，前端不需要，所以只有这一份常量的复制。
 */
export const PROFILE_CARD_HTML = '<div class="profile-head-slot" data-profile-card></div>';

/** 这个块是不是「主页名片」块（锁着的那块）。 */
export function isProfileCard(block) {
  return Boolean(block) && String(block.type ?? '') === 'app' && String(block.props?.app ?? '') === PROFILE_CARD_APP;
}

/**
 * 保存前的判定。返回 `{ ok, problems }`：
 *   - `ok === false` 时 `problems` 是人话（直接能弹 toast / 写进编辑器状态灯）。
 *   - `blocks` 传 `null` / `undefined` 且 `hasDoc === false` 表示「这个人还没有积木主页」——
 *     那是**合法**的：老用户的主页照旧用旧布局渲染，不强迫任何人迁移。
 */
export function checkProfile({ blocks = null, hasDoc = null, title = '' } = {}) {
  const problems = [];
  const hasDocument = hasDoc === null || hasDoc === undefined ? Array.isArray(blocks) : hasDoc === true;
  if (!hasDocument) return { ok: true, problems };

  const list = Array.isArray(blocks) ? blocks : [];
  if (list.length === 0) {
    problems.push('个人主页至少要留一个块 —— 整页删空就什么都不剩了');
  }
  if (list.length > MAX_PROFILE_BLOCKS) {
    problems.push(`个人主页最多 ${MAX_PROFILE_BLOCKS} 块（现在 ${list.length} 块）`);
  }
  if (String(title ?? '').length > MAX_PROFILE_TITLE) {
    problems.push(`个人主页标题最多 ${MAX_PROFILE_TITLE} 个字`);
  }

  const cards = list.filter(isProfileCard);
  if (cards.length === 0) {
    problems.push(`个人主页必须有「${PROFILE_CARD_APP}」块（头像 / 昵称 / 签名 / 关注都在它里面，这块不许删）`);
  } else if (cards.length > 1) {
    problems.push(`「${PROFILE_CARD_APP}」块只能有一个（现在 ${cards.length} 个）`);
  } else if (!isProfileCard(list[0])) {
    problems.push(`「${PROFILE_CARD_APP}」块必须在第一位（它可以编辑，但位置不许动）`);
  }
  return { ok: problems.length === 0, problems };
}

/** 一句人话：保存被拦下来时给用户看的原因。 */
export function profileBlockedMessage(result) {
  const problems = Array.isArray(result?.problems) ? result.problems : [];
  return problems.length ? `个人主页还不合法：${problems.join('；')}` : '';
}

/* @hand-written */
