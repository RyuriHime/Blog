// @generated 由 docs/tools/extract-server-modules.mjs 生成，请勿手改。
// 搬运自 src/db.js:202-882（预铺骨架，逐字未改，只在一批顶层声明前补了 export）。
//
// 这里放的是「原来和 SCHEMA、openDatabase 挤在同一个文件里」的东西：
//   SEED_BOARDS / SEED_USERS / 示例帖与回复数据 / migrate / seed / 六个 backfill*
//   以及一堆规则常量（个人主页、私信）。
// 单独拆出来的理由是让依赖方向保持单向：
//   db.js → core/open-db.js → core/open-db-support.js
// 如果把这些函数和常量留在 db.js、再让 open-db.js 回头 import，就形成 db.js ↔ open-db.js 的循环 import。
//
// 这些常量在本文件被 export 之后，由 src/db.js 尾部再 re-export 一次
// （DEFAULT_BOARDS / PROFILE_RULES /
//   MESSAGE_RULES / ROLES / STAFF_ROLES），所以 src/store.js 等老调用方一行都不用改。
import { DatabaseSync } from 'node:sqlite';
import { hashPassword } from '../password.js';
import { markdownToPlainText } from '../markdown.js';


export const SEED_BOARDS = [
  { slug: 'general', name: '综合讨论', icon: '💬', description: '天南海北，随便聊聊', sort: 1 },
  { slug: 'tech', name: '技术交流', icon: '🧑‍💻', description: '编程、架构与踩坑经验', sort: 2 },
  { slug: 'qa', name: '问答求助', icon: '❓', description: '遇到问题？发出来一起解决', sort: 3 },
  { slug: 'share', name: '分享创造', icon: '🚀', description: '作品、资源与有趣发现', sort: 4 },
  { slug: 'meta', name: '站务公告', icon: '📢', description: '规则、反馈与公告', sort: 5 },
];

export const SEED_USERS = [
  { username: 'admin', password: 'admin123', display: '站长', role: 'owner', bio: '论坛站长（拥有者），有事找我。' },
  { username: 'alice', password: 'demo1234', display: 'Alice', role: 'member', bio: '前端工程师，喜欢折腾 UI。' },
  { username: 'bob', password: 'demo1234', display: 'Bob', role: 'member', bio: '后端开发，Node / Go / 数据库。' },
  { username: 'carol', password: 'demo1234', display: 'Carol', role: 'member', bio: '产品经理，偶尔写点东西。' },
];

export const PROFILE_PIN_LIMIT = 3;
export const PROFILE_CATEGORY_LIMIT = 8;

/**
 * 私信规则：
 *   互相关注 → 不限量
 *   单方面关注（任一方关注另一方）→ 每天 1 条
 *   完全没有关注关系 / 任一方拉黑 → 不允许发送
 *   自己给自己发 → 不允许
 */
export const MESSAGE_ONE_WAY_DAILY_LIMIT = 1;
export const MESSAGE_MAX_LENGTH = 1000;

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

function buildSeedPosts(now) {
  return [
    {
      board: 'meta',
      author: 'admin',
      title: '【必读】论坛版规与发帖指南',
      pinned: 1,
      age: 9 * DAY,
      content: `欢迎来到本论坛 👋

## 发帖前请先看这里

1. **选对板块**：技术问题去「问答求助」，作品去「分享创造」。
2. **标题写清楚**：`+"`求助：node:sqlite 如何做分页`"+` 比 `+"`救命！！`"+` 有效得多。
3. **支持 Markdown**，代码请用围栏代码块：

\`\`\`js
const db = new DatabaseSync('data/forum.db');
const rows = db.prepare('SELECT * FROM posts WHERE deleted = 0').all();
\`\`\`

> 请勿发布广告、人身攻击或违法内容，违者封禁。

看到好内容记得**点赞、收藏**，喜欢作者可以直接**关注** TA 🔔

祝大家玩得开心 🎉`,
      replies: [
        { author: 'bob', age: 8 * DAY, content: '收到，已认真阅读 ✅' },
        { author: 'carol', age: 7 * DAY, content: '补充一点：**提问时贴出报错堆栈**真的能省下很多来回。' },
      ],
    },
    {
      board: 'tech',
      author: 'bob',
      title: 'Node.js 24 内置 SQLite 上手实测：零依赖做全栈',
      pinned: 1,
      age: 6 * DAY,
      content: `Node 22.5 之后官方提供了 \`node:sqlite\`，做小项目终于不用折腾原生编译了。

## 为什么值得用

- 零依赖，\`npm install\` 都省了
- 同步 API，写起来像写脚本
- 支持 WAL，读多写少完全够用

## 一个小坑

\`run()\` 返回的 \`lastInsertRowid\` 可能是 BigInt，记得转一下：

\`\`\`js
const info = stmt.run(title, content);
const id = Number(info.lastInsertRowid);
\`\`\`

另外布尔值不能直接绑定，要用 \`0 / 1\`。

*大家还有什么踩坑经验？*`,
      replies: [
        { author: 'alice', age: 5 * DAY, content: '正好在找一个不用装 better-sqlite3 的方案，感谢分享 🙏' },
        { author: 'bob', age: 5 * DAY - HOUR, content: '@alice 对，CI 里少一步编译，快很多。' },
        { author: 'admin', age: 4 * DAY, content: '已加精，记得后续更新 Node 版本变化。' },
      ],
    },
    {
      board: 'qa',
      author: 'alice',
      title: '求助：前端 SPA 用 hash 路由会不会影响 SEO？',
      age: 45 * HOUR,
      content: `最近用原生 JS 写了个单页应用，路由是 \`#/post/12\` 这种形式。

搜索引擎好像抓不到内容，有什么低成本改善方案吗？

- 要不要换成 History API？
- 还是说加个 sitemap 就够了？

谢谢各位 🙇`,
      replies: [
        { author: 'bob', age: 44 * HOUR, content: '如果内容型站点，建议关键页面做 SSR 或者预渲染，hash 路由天生对爬虫不友好。' },
        { author: 'alice', age: 43 * HOUR, content: '明白了，先把帖子详情页做服务端渲染试试。' },
      ],
    },
    {
      board: 'share',
      author: 'carol',
      title: '分享：我整理的 12 个 Markdown 写作小技巧',
      age: 30 * HOUR,
      content: `写文档这几年攒下来的习惯，挑几个最实用的：

1. 用 \`##\` 分段，别用粗体当标题
2. 代码块一定标注语言，高亮和复制体验都更好
3. 引用块 \`>\` 适合放结论
4. 列表嵌套不要超过两层

> 文档是写给人看的，不是写给编译器看的。

**最喜欢的一条**：写完先自己读一遍，读不顺就说明没写清楚。`,
      replies: [
        { author: 'alice', age: 29 * HOUR, content: '第 4 条深有体会，嵌套两层以上就晕了。' },
      ],
    },
    {
      board: 'tech',
      author: 'alice',
      title: 'CSS 变量做主题切换的正确姿势',
      age: 20 * HOUR,
      content: `把颜色统一收进 \`:root\`，切换主题只需要改一个属性：

\`\`\`css
:root { --bg: #0f1115; --fg: #e8ecf1; }
[data-theme='light'] { --bg: #ffffff; --fg: #1b1f24; }
body { background: var(--bg); color: var(--fg); }
\`\`\`

配合 \`localStorage\` 记住用户选择，几行代码搞定 🌗`,
      replies: [
        { author: 'bob', age: 18 * HOUR, content: '顺手再加个 \`prefers-color-scheme\` 跟随系统就更完整了。' },
      ],
    },
    {
      board: 'general',
      author: 'carol',
      title: '大家平时用什么工具记笔记？',
      age: 12 * HOUR,
      content: `试过不少工具，最后又回到纯文本 + Git。

你们呢？聊聊各自的用法和理由 👀`,
      replies: [
        { author: 'bob', age: 11 * HOUR, content: 'Obsidian，双链和本地文件是刚需。' },
        { author: 'alice', age: 10 * HOUR, content: 'VS Code + 一个 notes 仓库，够用了 😄' },
      ],
    },
    {
      board: 'qa',
      author: 'bob',
      title: 'SQLite 分页查询在大数据量下变慢，怎么优化？',
      age: 6 * HOUR,
      content: `\`LIMIT ? OFFSET ?\` 翻到后面几页明显变慢。

除了游标分页还有别的思路吗？表大概 200 万行。`,
      replies: [
        { author: 'admin', age: 5 * HOUR, content: '优先用「上一页最后一条的 id」做游标，OFFSET 越大扫描越多。' },
      ],
    },
    {
      board: 'share',
      author: 'admin',
      title: '论坛 v1.1 上线：消息通知、评价与关注',
      age: 2 * HOUR,
      content: `本次更新把社区互动补齐了：

- 🔔 **消息通知**：有人回复、点赞、踩、关注你，或 @ 提到你，都会推送
- 👍👎 **评价**：点赞 / 踩二选一，可以随时改主意
- ⭐ **收藏**：在「我的收藏」里集中查看
- 👥 **关注**：关注作者后，首页「我关注的」里只看 TA 们的帖子

有任何建议直接回帖，或者 @站长 叫我 📮`,
      replies: [
        { author: 'alice', age: 1 * HOUR, content: '速度很快，UI 也清爽 👍' },
        { author: 'carol', age: 40 * 60 * 1000, content: '希望以后能加上消息通知 🔔' },
        { author: 'bob', age: 25 * 60 * 1000, content: '试了下通知真的能收到，@站长 这个 @ 提醒也能用 👍' },
      ],
    },
  ];
}

/* ------------------------------------------------------------------ */
/* 建表之后的迁移                                                     */
/* ------------------------------------------------------------------ */

/**
 * 给已存在的表补一列（表里已经有这列就什么都不做）。
 *
 * 导出给模块自己的迁移用（`src/modules/team/migrate.js`）：模块的表归模块管，
 * 但「查一下有没有、没有就 ALTER」这件事每个模块都写一遍没意义。
 */
export function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

/** 兼容旧版本数据库：补齐新列，把老的 likes 表迁进 reactions 后删除。 */
export function migrate(db) {
  ensureColumn(db, 'users', 'avatar', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'posts', 'category_id', 'INTEGER');
  ensureColumn(db, 'posts', 'profile_pinned', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'posts', 'profile_pinned_at', 'INTEGER');
  ensureColumn(db, 'posts', 'hidden', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'posts', 'hidden_at', 'INTEGER');
  ensureColumn(db, 'posts', 'hidden_by', 'INTEGER');
  ensureColumn(db, 'posts', 'hidden_reason', "TEXT NOT NULL DEFAULT ''");
  // 团队公告的通知要能指回团队（前端据此跳到 #/team/<slug>）。
  ensureColumn(db, 'notifications', 'team_id', 'INTEGER');
  // 「有人回复了你的动态」的通知要能指回那条动态。故意不写外键 ——
  // feed_items 归动态模块，core 不认识它（与上面 team_id 同一个道理）。
  ensureColumn(db, 'notifications', 'feed_item_id', 'INTEGER');

  const legacy = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'likes'").get();
  if (legacy) {
    db.exec(
      `INSERT OR IGNORE INTO reactions (user_id, post_id, kind, created_at)
       SELECT user_id, post_id, 'like', created_at FROM likes`,
    );
    db.exec('DROP TABLE likes');
  }

  // 角色升级：老库里的 'admin' 拆成「站长 / 管理员」，
  // 最早的（也是建站的那个）管理员自动成为站长，其余的仍是管理员。
  const hasOwner = db.prepare("SELECT id FROM users WHERE role = 'owner' LIMIT 1").get();
  if (!hasOwner) {
    const firstAdmin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1").get();
    if (firstAdmin) {
      db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(firstAdmin.id);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 示例数据                                                            */
/* ------------------------------------------------------------------ */

export function seed(db) {
  const now = Date.now();
  const insertBoard = db.prepare(
    'INSERT INTO boards (slug, name, description, icon, sort_order) VALUES (?, ?, ?, ?, ?)',
  );
  for (const board of SEED_BOARDS) {
    insertBoard.run(board.slug, board.name, board.description, board.icon, board.sort);
  }

  const insertUser = db.prepare(
    `INSERT INTO users (username, display_name, password_hash, role, bio, banned, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?)`,
  );
  const userIds = new Map();
  SEED_USERS.forEach((user, index) => {
    const info = insertUser.run(
      user.username,
      user.display,
      hashPassword(user.password),
      user.role,
      user.bio,
      now - (30 - index) * DAY,
    );
    userIds.set(user.username, Number(info.lastInsertRowid));
  });

  const boardIds = new Map();
  for (const row of db.prepare('SELECT id, slug FROM boards').all()) {
    boardIds.set(row.slug, Number(row.id));
  }

  const insertPost = db.prepare(
    `INSERT INTO posts (board_id, user_id, title, content, views, pinned, locked, deleted, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
  );
  const insertReply = db.prepare(
    'INSERT INTO replies (post_id, user_id, content, deleted, created_at) VALUES (?, ?, ?, 0, ?)',
  );
  const insertReaction = db.prepare(
    'INSERT OR IGNORE INTO reactions (user_id, post_id, kind, created_at) VALUES (?, ?, ?, ?)',
  );

  for (const post of buildSeedPosts(now)) {
    const createdAt = now - post.age;
    const info = insertPost.run(
      boardIds.get(post.board),
      userIds.get(post.author),
      post.title,
      post.content,
      12 + Math.floor(Math.random() * 300),
      post.pinned ? 1 : 0,
      createdAt,
      createdAt,
    );
    const postId = Number(info.lastInsertRowid);

    for (const reply of post.replies) {
      insertReply.run(postId, userIds.get(reply.author), reply.content, now - reply.age);
    }

    for (const [username, userId] of userIds) {
      if (username === post.author) continue;
      const roll = Math.random();
      if (roll < 0.6) insertReaction.run(userId, postId, 'like', createdAt + 60000);
      else if (roll < 0.72) insertReaction.run(userId, postId, 'dislike', createdAt + 60000);
    }
  }

  // 关注关系
  const insertFollow = db.prepare(
    'INSERT OR IGNORE INTO follows (follower_id, followee_id, created_at) VALUES (?, ?, ?)',
  );
  const followPairs = [
    ['alice', 'bob', 5 * DAY],
    ['alice', 'admin', 4 * DAY],
    ['bob', 'admin', 3 * DAY],
    ['carol', 'alice', 2 * DAY],
    ['admin', 'carol', 1 * DAY],
    ['bob', 'carol', 20 * HOUR],
    // 这两对做成互相关注，方便演示「互关可无限私信」
    ['bob', 'alice', 5 * DAY],
    ['carol', 'admin', 1 * DAY],
  ];
  for (const [follower, followee, age] of followPairs) {
    insertFollow.run(userIds.get(follower), userIds.get(followee), now - age);
  }
}

/* ------------------------------------------------------------------ */
/* 个人主页分类 / 置顶 的示例数据                                     */
/* ------------------------------------------------------------------ */

const SEED_CATEGORIES = {
  admin: ['站务公告', '教程整理'],
  alice: ['前端笔记', '随笔'],
  bob: ['数据库', 'Node.js'],
  carol: ['写作', '产品思考'],
};

/** 示例账号的预设 emoji 头像（格式 emoji:字符:色相），只给演示账号，真实用户保持默认 */
const SEED_AVATARS = {
  admin: 'emoji:🧭:212',
  alice: 'emoji:🦊:24',
  bob: 'emoji:🐳:198',
  carol: 'emoji:🌻:45',
};

/**
 * 示例账号的预设 emoji 头像：只在「全站还没有任何人设置过头像」时补一次，
 * 所以真实用户自己的头像永远不会被覆盖。
 */
export function backfillDemoAvatars(db) {
  const customised = Number(db.prepare("SELECT COUNT(*) AS count FROM users WHERE avatar <> ''").get().count);
  if (customised > 0) return 0;

  const update = db.prepare("UPDATE users SET avatar = ? WHERE username = ? AND avatar = ''");
  let created = 0;
  for (const [username, avatar] of Object.entries(SEED_AVATARS)) {
    created += Number(update.run(avatar, username).changes ?? 0);
  }
  return created;
}

/**
 * 给示例用户补上分类与主页置顶，只在分类表为空时执行一次，
 * 所以从旧版本升级上来的库也会自动获得这些演示数据。
 */
export function backfillProfileExtras(db) {
  if (Number(db.prepare('SELECT COUNT(*) AS count FROM profile_categories').get().count) > 0) return null;

  const now = Date.now();
  const insertCategory = db.prepare(
    'INSERT OR IGNORE INTO profile_categories (user_id, name, sort_order, created_at) VALUES (?, ?, ?, ?)',
  );
  const assignCategory = db.prepare('UPDATE posts SET category_id = ? WHERE id = ?');
  const pinPost = db.prepare('UPDATE posts SET profile_pinned = 1, profile_pinned_at = ? WHERE id = ?');

  let categories = 0;
  let pinned = 0;

  for (const user of db.prepare('SELECT id, username FROM users ORDER BY id ASC').all()) {
    const names = SEED_CATEGORIES[user.username];
    if (!names) continue; // 只给示例账号造演示数据，真实用户从零开始

    // 顺手给示例账号一个预设 emoji 头像（用户自己设置过就不覆盖）
    const seedAvatar = SEED_AVATARS[user.username];
    if (seedAvatar) {
      db.prepare("UPDATE users SET avatar = ? WHERE id = ? AND avatar = ''").run(seedAvatar, user.id);
    }

    names.forEach((name, index) => {
      const info = insertCategory.run(user.id, name, index, now);
      categories += Number(info.changes ?? 0);
    });

    const categoryIds = db
      .prepare('SELECT id FROM profile_categories WHERE user_id = ? ORDER BY sort_order ASC, id ASC')
      .all(user.id)
      .map((row) => row.id);
    const posts = db
      .prepare('SELECT id FROM posts WHERE user_id = ? AND deleted = 0 ORDER BY pinned DESC, created_at ASC')
      .all(user.id);

    posts.forEach((post, index) => {
      if (categoryIds.length) assignCategory.run(categoryIds[index % categoryIds.length], post.id);
    });
    if (posts.length) {
      // 把作者最有代表性的一篇（置顶/最早）放到个人主页置顶位
      pinPost.run(now - 3600 * 1000, posts[0].id);
      pinned += 1;
    }
  }

  return { categories, pinned };
}

/** 给系统里每个用户发一条欢迎通知。 */
function welcomeNotifications(db) {  const insert = db.prepare(
    `INSERT INTO notifications (user_id, actor_id, type, post_id, reply_id, excerpt, read_at, created_at)
     VALUES (?, NULL, 'system', NULL, NULL, ?, NULL, ?)`,
  );
  let created = 0;
  for (const user of db.prepare('SELECT id FROM users').all()) {
    insert.run(user.id, '欢迎来到格社！先看看《论坛版规与发帖指南》，然后去发你的第一个帖子吧 🎉', Date.now());
    created += 1;
  }
  return created;
}

/**
 * 通知回填：把已有的回复 / 评价 / 关注转换成通知，
 * 这样从旧版本升级上来时消息中心也不会是空的。只在通知表为空时执行。
 */
export function backfillNotifications(db) {
  if (Number(db.prepare('SELECT COUNT(*) AS count FROM notifications').get().count) > 0) return 0;

  const insert = db.prepare(
    `INSERT INTO notifications (user_id, actor_id, type, post_id, reply_id, excerpt, read_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
  );
  const exists = db.prepare(
    `SELECT 1 AS hit FROM notifications
     WHERE user_id = ? AND actor_id IS ? AND type = ? AND post_id IS ? LIMIT 1`,
  );
  let created = 0;
  const add = (userId, actorId, type, postId, replyId, excerpt, createdAt) => {
    if (!userId || userId === actorId) return;
    if (exists.get(userId, actorId, type, postId)) return;
    insert.run(userId, actorId, type, postId, replyId, excerpt, createdAt);
    created += 1;
  };

  const replies = db
    .prepare(
      `SELECT r.id, r.post_id, r.user_id AS actor, r.content, r.created_at, p.user_id AS owner
       FROM replies r JOIN posts p ON p.id = r.post_id WHERE r.deleted = 0`,
    )
    .all();
  for (const row of replies) {
    add(row.owner, row.actor, 'post_reply', row.post_id, row.id, markdownToPlainText(row.content, 60), row.created_at);
  }

  const reactions = db
    .prepare(
      `SELECT rx.user_id AS actor, rx.post_id, rx.kind, rx.created_at, p.user_id AS owner
       FROM reactions rx JOIN posts p ON p.id = rx.post_id`,
    )
    .all();
  for (const row of reactions) {
    add(row.owner, row.actor, row.kind === 'like' ? 'post_like' : 'post_dislike', row.post_id, null, '', row.created_at);
  }

  const follows = db.prepare('SELECT follower_id, followee_id, created_at FROM follows').all();
  for (const row of follows) {
    add(row.followee_id, row.follower_id, 'follow', null, null, '', row.created_at);
  }

  created += welcomeNotifications(db);
  return created;
}

/** 旧库补齐演示数据：如果一条关注关系都没有，就给示例用户之间连上。 */
export function backfillDemoSocial(db) {
  if (Number(db.prepare('SELECT COUNT(*) AS count FROM follows').get().count) > 0) return 0;
  const users = db.prepare('SELECT id, username FROM users ORDER BY id ASC LIMIT 4').all();
  if (users.length < 2) return 0;
  const insert = db.prepare(
    'INSERT OR IGNORE INTO follows (follower_id, followee_id, created_at) VALUES (?, ?, ?)',
  );
  const now = Date.now();
  const pairs = [
    [0, 1],
    [0, 2],
    [1, 0],
    [2, 0],
    [3, 1],
    [1, 3],
  ];
  let created = 0;
  for (const [a, b] of pairs) {
    if (!users[a] || !users[b]) continue;
    insert.run(users[a].id, users[b].id, now - (pairs.length - created) * HOUR);
    created += 1;
  }
  return created;
}

/** 演示转发：只在转发表为空时给示例账号造几条，真实用户从零开始。 */
export function backfillReposts(db) {
  if (Number(db.prepare('SELECT COUNT(*) AS count FROM reposts').get().count) > 0) return 0;

  const now = Date.now();
  const users = new Map(
    db
      .prepare('SELECT id, username FROM users ORDER BY id ASC')
      .all()
      .map((row) => [row.username, row.id]),
  );
  const posts = db
    .prepare('SELECT id, user_id, title FROM posts WHERE deleted = 0 ORDER BY id ASC LIMIT 8')
    .all();
  if (!posts.length) return 0;

  const insert = db.prepare(
    'INSERT OR IGNORE INTO reposts (post_id, user_id, comment, created_at) VALUES (?, ?, ?, ?)',
  );
  const plan = [
    ['alice', 1, '写得很清楚，转发留存一下 📌'],
    ['carol', 0, '新来的同学先看这篇，版规和发帖姿势都在里面。'],
    ['bob', 7, '这次更新把互动补齐了，推荐。'],
    ['alice', 3, 'Markdown 小技巧很实用，转给同事看。'],
  ];

  let created = 0;
  let index = 0;
  for (const [username, postIndex, comment] of plan) {
    const userId = users.get(username);
    const post = posts[postIndex] ?? posts[index % posts.length];
    index += 1;
    if (!userId || !post || post.user_id === userId) continue;
    const info = insert.run(post.id, userId, comment, now - (plan.length - index) * HOUR);
    created += Number(info.changes ?? 0);
  }
  return created;
}

/**
 * 演示用私信 + 补一对互相关注。
 * 只在「全站还没有任何私信」时执行一次，且只动示例账号，真实用户数据不受影响。
 */
export function backfillDemoMessages(db) {
  if (Number(db.prepare('SELECT COUNT(*) AS count FROM messages').get().count) > 0) return 0;

  const users = new Map(
    db
      .prepare('SELECT id, username FROM users')
      .all()
      .map((row) => [row.username, row.id]),
  );
  const alice = users.get('alice');
  const bob = users.get('bob');
  const carol = users.get('carol');
  if (!alice || !bob) return 0;

  const now = Date.now();
  // alice 和 bob 互相有内容可看，先把「互相关注」补上（否则演示时只能一天发一条）
  const insertFollow = db.prepare(
    'INSERT OR IGNORE INTO follows (follower_id, followee_id, created_at) VALUES (?, ?, ?)',
  );
  insertFollow.run(bob, alice, now - 6 * 3600 * 1000);

  const insert = db.prepare(
    'INSERT INTO messages (sender_id, recipient_id, content, read_at, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  const thread = [
    [alice, bob, '你上次那篇 node:sqlite 的文章很有用，我照着做了一版分页 👍', now - 5 * 3600 * 1000],
    [bob, alice, '太好了！分页那块我用的是游标，OFFSET 大了确实会慢。', now - 4.5 * 3600 * 1000],
    [alice, bob, '收到，我改成 keyset 分页试试。回头把结果贴上来。', now - 4 * 3600 * 1000],
  ];
  let created = 0;
  for (const [sender, recipient, content, at] of thread) {
    insert.run(sender, recipient, content, at < now - 4.2 * 3600 * 1000 ? at + 60000 : null, at);
    created += 1;
  }
  if (carol) {
    // 单向关注（carol → alice 有关注，alice 没回关）→ 每天只能发一条，正好演示这个限制
    insert.run(carol, alice, '你好，想请教一下你主页那个分类是怎么整理的？', null, now - 2 * 3600 * 1000);
    created += 1;
  }
  return created;
}
