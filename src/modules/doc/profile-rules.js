// 个人主页（`kind = 'profile'`）的**块规则** —— 需求 1 / 需求 2。
//
// 个人主页翻新成「以积木帖子为底层」的页面：页面上的一切都是块，块可以自由
// 添加 / 删除 / 编辑 / 移动 —— 但**保存前要判定**，不合法的个人主页不许保存。
//
// ⚠️ 这份文件与 `public/core/profile-rules.js` **必须同源**（前端 import 不了服务端 ESM，
// 而「保存前先判定」这件事要在浏览器里就能算出来，不能等一次 400）。改这里就改那里。
//
// 三条规则，都是**纯函数 + 常量**，没有副作用、不碰数据库：
//   1. 至少一块 —— 主页不许被整页删空（`checkProfile` 的 `empty`）。
//   2. 块类型必须是内建的那几种（`allowed`）—— 主页是给人看的页面，不引未知类型。
//   3. 「主页名片」块（头像 + 昵称 + 签名 + 关注 / 私信 / 拉黑）**有且只有一个、且必须在第一位**
//      —— 这就是需求里那块"不允许删除、编辑、移动位置"的积木块（`locked`），
//      前端据此不画删除 / 上移按钮，服务端据此在删除 / 移动 / 整篇重排时挡下来。

/** 主页最多多少块（与 `schema.js` 的 `MAX_DOC_BLOCKS` 不是一回事：那是整篇文档的硬上限）。 */
export const MAX_PROFILE_BLOCKS = 60;
/** 主页标题长度上限。 */
export const MAX_PROFILE_TITLE = 120;
/** 主页正文里**所有块加起来的纯文字**上限。 */
export const MAX_PROFILE_TEXT = 20000;

/** 「主页名片」块的识别标记：`app` 块的 `props.app` 就叫这个名字。 */
export const PROFILE_CARD_APP = '个人主页名片';
/** 「数据统计」块（发过的文章 / 动态 / 关注者 / 关注中）。 */
export const PROFILE_STATS_APP = '数据统计';
/** 「我的标签」块。 */
export const PROFILE_TAGS_APP = '我的标签';
/** 「积木贴置顶推荐」块。 */
export const PROFILE_PINNED_APP = '积木贴置顶推荐';
/** 「发表过的积木贴」块。 */
export const PROFILE_POSTS_APP = '发表过的积木贴';
/** 「发表过的动态」块。 */
export const PROFILE_REPOSTS_APP = '发表过的动态';

/**
 * 主页块的内容**由宿主（页面）渲染**，用户改不了 —— 这就是「不允许编辑」。
 *
 * 为什么做成占位而不是让沙箱脚本自己画：头像 / 昵称 / 签名 / 关注 / 私信 / 拉黑
 * 这些按钮的动作早就由页面（`public/views/user.js` + 事件总线）实现了，沙箱里
 * 重写一遍等于把关注 / 拉黑逻辑抄第二遍，还拿不到「我关注他了吗 / 我拉黑他了吗」
 * 这些**看客相对**的状态。所以块里只留一个占位标记，主页渲染时把它换成真正的卡片。
 *
 * 其余五块同理：它们画的是**站点自己的 UI**（`.stat-grid` 统计格、`.card` 卡片、
 * `.post-compact` 列表 —— 与改造前 `public/views/user.js` / `public/core/widgets.js`
 * 用的是同一批类名），进沙箱 iframe 就拿不到站点样式，会变成一块白框 + 一堆蓝链。
 */
export const PROFILE_CARD_HTML = '<div class="profile-head-slot" data-profile-card></div>';
export const PROFILE_STATS_HTML = '<div class="profile-stats-slot" data-profile-stats></div>';
export const PROFILE_TAGS_HTML = '<div class="profile-tags-slot" data-profile-tags></div>';
export const PROFILE_PINNED_HTML = '<div class="profile-pinned-slot" data-profile-pinned></div>';
export const PROFILE_POSTS_HTML = '<div class="profile-posts-slot" data-profile-posts></div>';
export const PROFILE_REPOSTS_HTML = '<div class="profile-reposts-slot" data-profile-reposts></div>';

/** `props.app` → 它该被换成哪段占位（宿主渲染的六块）。 */
export const PROFILE_HOST_BLOCKS = [
  { app: PROFILE_CARD_APP, html: PROFILE_CARD_HTML },
  { app: PROFILE_STATS_APP, html: PROFILE_STATS_HTML },
  { app: PROFILE_TAGS_APP, html: PROFILE_TAGS_HTML },
  { app: PROFILE_PINNED_APP, html: PROFILE_PINNED_HTML },
  { app: PROFILE_POSTS_APP, html: PROFILE_POSTS_HTML },
  { app: PROFILE_REPOSTS_APP, html: PROFILE_REPOSTS_HTML },
];

/** 这六块的 `app` 名字（前端判断「主页是不是已经块化了」用）。 */
export const PROFILE_HOST_APPS = PROFILE_HOST_BLOCKS.map((item) => item.app);

/** 除名片之外的五块（有它们才说明主页是 seed 出来的，硬编码那一排统计该让位）。 */
export const PROFILE_DATA_APPS = PROFILE_HOST_APPS.filter((app) => app !== PROFILE_CARD_APP);

/** 这个 `app` 名字是不是「宿主渲染的主页块」。 */
export function isProfileHostApp(app) {
  return PROFILE_HOST_APPS.includes(String(app ?? ''));
}

/** `app` 名字 → 它对应的占位 HTML（不认识就回空串）。 */
export function profileHostHtml(app) {
  const found = PROFILE_HOST_BLOCKS.find((item) => item.app === String(app ?? ''));
  return found ? found.html : '';
}

/** 块里存的 `code` 是不是我们自己的占位（只有这样才替换，用户改过的内容一律不动）。 */
export function isProfileHostPlaceholder(code) {
  return PROFILE_HOST_BLOCKS.some((item) => item.html === String(code ?? '').trim());
}

/**
 * 主页的初始块（新建个人主页文档时 seed）。
 *
 * 六块，全部是 `app` 块，全部由宿主渲染 —— 画出来的东西和改造前的个人主页**一模一样**
 * （头像卡 / 统计格 / 标签 / 置顶推荐 / 积木贴列表 / 动态列表），差别只是它们现在是块：
 * 能删、能移、能再来一块，只有名片块锁着。
 *
 * 需求 2 要的「与个人信息相关的 API 提供给用户」也没有丢：`Sandbox.profile()` 仍然是
 * 这六块背后的那份数据（等价 `GET /api/docs/profile/<用户名>/stats`），用户完全可以把
 * 某一块改成自己的沙箱代码来调用它 —— 占位一旦被改写，宿主就不再接管那一块。
 */
export function profileSeedBlocks() {
  const host = (app, html) => ({ type: 'app', props: { app, config: {}, code: html } });
  return [
    host(PROFILE_CARD_APP, PROFILE_CARD_HTML),
    host(PROFILE_STATS_APP, PROFILE_STATS_HTML),
    host(PROFILE_TAGS_APP, PROFILE_TAGS_HTML),
    host(PROFILE_PINNED_APP, PROFILE_PINNED_HTML),
    host(PROFILE_POSTS_APP, PROFILE_POSTS_HTML),
    host(PROFILE_REPOSTS_APP, PROFILE_REPOSTS_HTML),
  ];
}

/** 这个块是不是「主页名片」块（锁着的那块）。 */
export function isProfileCard(block) {
  return Boolean(block) && String(block.type ?? '') === 'app' && String(block.props?.app ?? '') === PROFILE_CARD_APP;
}

/**
 * 保存前的判定。返回 `{ ok, problems }`：
 *   - `ok === false` 时 `problems` 是人话（直接能弹 toast / 写进编辑器状态灯）。
 *   - `blocks` 传 `null` / `undefined` 表示「这个人还没有积木主页」（`hasDoc === false`）——
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
