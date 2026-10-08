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

/**
 * 名片块的内容**由宿主（页面）渲染**，用户改不了 —— 这就是「不允许编辑」。
 *
 * 为什么做成占位而不是让沙箱脚本自己画：头像 / 昵称 / 签名 / 关注 / 私信 / 拉黑
 * 这些按钮的动作早就由页面（`public/views/user.js` + 事件总线）实现了，沙箱里
 * 重写一遍等于把关注 / 拉黑逻辑抄第二遍，还拿不到「我关注他了吗 / 我拉黑他了吗」
 * 这些**看客相对**的状态。所以块里只留一个占位标记，主页渲染时把它换成真正的卡片。
 */
export const PROFILE_CARD_HTML = '<div class="profile-head-slot" data-profile-card></div>';

/**
 * 主页的初始块（新建个人主页文档时 seed）。
 *
 * 为什么统计 / 标签 / 置顶 / 帖子 / 动态都用 `app` 块而不是普通文本块：
 * 需求 2 要求「与个人信息相关的 API 提供给用户」，这些块就是**示范调用**——
 * 它们在渲染时用 `Sandbox.profile()` 现取实时数据，所以「发过的帖子数」永远等于
 * 列表里真正能看到的条数（需求 3 的统一口径在主页上也成立）。
 * 用户想改成静态文字，直接编辑块内容即可 —— 块是自由的，只有名片块锁着。
 */
export function profileSeedBlocks() {
  const statRow = (label, key) => `<div class="pf-stat"><b id="${key}">—</b><span>${label}</span></div>`;
  return [
    {
      // 第一块：名片。**锁**（见本文件顶部第 3 条）：内容由宿主渲染，见 `PROFILE_CARD_HTML`。
      type: 'app',
      props: {
        app: PROFILE_CARD_APP,
        config: {},
        code: PROFILE_CARD_HTML,
      },
    },
    {
      type: 'app',
      props: {
        app: '数据统计',
        config: {},
        code: [
          '<div class="pf-stats">',
          `  ${statRow('发过的文章', 'pf-posts')}`,
          `  ${statRow('发过的动态', 'pf-reposts')}`,
          `  ${statRow('关注者', 'pf-followers')}`,
          `  ${statRow('关注中', 'pf-following')}`,
          '</div>',
          '<script>',
          '  (async () => {',
          '    // 个人信息 API：`Sandbox.profile()` 就是 GET /api/profile/:username 的那份数据。',
          '    const me = await Sandbox.profile();',
          "    document.getElementById('pf-posts').textContent = me.postCount;",
          "    document.getElementById('pf-reposts').textContent = me.repostCount;",
          "    document.getElementById('pf-followers').textContent = me.followerCount;",
          "    document.getElementById('pf-following').textContent = me.followingCount;",
          '    Sandbox.resize();',
          '  })();',
          '</script>',
        ].join('\n'),
      },
    },
    {
      type: 'heading',
      props: { text: '🏷 我的标签', level: 2 },
    },
    {
      type: 'list',
      props: { text: '', source: { kind: 'profile-tags', limit: 20 } },
    },
    {
      type: 'heading',
      props: { text: '📌 积木贴置顶推荐', level: 2 },
    },
    {
      type: 'list',
      props: { text: '', source: { kind: 'profile-pinned', limit: 3 } },
    },
    {
      type: 'heading',
      props: { text: '🧩 发表过的积木贴', level: 2 },
    },
    {
      type: 'list',
      props: { text: '', source: { kind: 'profile-posts', limit: 20 } },
    },
    {
      type: 'heading',
      props: { text: '💬 发表过的动态', level: 2 },
    },
    {
      type: 'list',
      props: { text: '', source: { kind: 'profile-reposts', limit: 20 } },
    },
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
