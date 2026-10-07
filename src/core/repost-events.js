// 帖子转发的「伴生动作」登记口。
//
// ── 为什么要有这个口子 ──
// 转发的落点在 B 站那套语义里只有一处：**动态**。转发一篇帖子（含积木帖）除了在
// `reposts` 里记一条（个人主页的「🔁 转发」分类、转发计数、转发者名单认它），
// 还要在动态流里出现一条带引用卡的新动态 —— 否则「录了转发」和「看得到转发」
// 就是两件事，用户转完只能在自己的主页里找。
//
// 而 `feed_items` 是 feed 模块的表。骨架规矩（`src/core/context.js` 文件头）不许
// core import 业务模块，所以让 feed 自己**登记**一个回调，core 在转发 / 改转发语 /
// 撤销时调它。这与 `src/core/guards.js` 的 `addPostVisibility` 是同一个套路，
// 只是方向反过来：guard 那个是 core 读、模块登记；这个是 core 发、模块收。
//
// 不这么做的另一条路是 core 直接往 `feed_items` 里写 —— 那等于 core 要知道
// feed 的表结构，以后 feed 改一列就得回来改 core，正是骨架要避免的事。
//
// ── 广播失败怎么办 ──
// 吞掉异常、只打日志。转发本身已经写进 `reposts` 了，抛出去会让用户以为没转成功、
// 再点一次；而最坏的后果不过是动态流里少一张卡片。宁可少一张卡，不能骗用户。
const repostListeners = [];

/**
 * 登记一条转发伴生动作。
 *
 * @param {(event: { action: 'save' | 'delete', postId: number, userId: number,
 *   comment: string, publiclyVisible: boolean }) => void} fn
 *   `action = 'save'` 覆盖「第一次转发」与「再转一次只改转发语」两种情况 ——
 *   登记方按 (userId, postId) 做 upsert 就对了，不用自己分辨。
 *   `publiclyVisible` 是「这篇帖子此刻谁都能看吗」（`hidden = 0`）：
 *   非公开的帖子（仅关注者 / 仅团队的积木）**不该**在公开动态流里留卡片，
 *   否则卡片上的标题就漏给了所有人，点进去还会 404。
 */
function addRepostListener(fn) {
  if (typeof fn === 'function') repostListeners.push(fn);
}

/** 广播一次转发动作。没有登记方时是个空循环，不报错。 */
function emitRepost(event) {
  for (const fn of repostListeners) {
    try {
      fn(event);
    } catch (error) {
      console.error('[repost] 转发伴生动作失败：', error);
    }
  }
}

export { addRepostListener, emitRepost };
