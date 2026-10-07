// 动态（P1）自己的 SQL。
//
// 为什么单独一个文件：`src/store.js` 是 core 的地盘（它只认 posts / replies / users 那几张表），
// 动态两张表归 P1，SQL 就该在 P1 的目录里 —— 五个人并行时才不会天天改同一个文件。
//
// ⚠️ 这里有本仓库踩过的**真实事故**留下的规矩，改动前先读：
//   v1 的 `store.listPostsByIds` 里，SQL 的 `?` 顺序是「6 个浏览者状态 → 帖子 id → 黑名单 2 个」，
//   传参却写成「6 个 → 黑名单 2 个 → id」，转发列表因此整个 500。
//   更要命的是修完之后 `smoke.mjs` 242 项、`check-ui-contract.mjs` 175 项**全绿** ——
//   两套测试都覆盖不到参数顺序错误，它是靠人记忆维持的隐性契约。
//
//   所以本文件所有查询都过一道 `bind()`：**占位符个数与实参个数不一致就当场抛错**。
//   它抓不住「个数一样但顺序换了」，所以还有第二条规矩：
//   **一条 SQL 的参数只能由 `conditions` 数组里成对声明的 `{ sql, params }` 拼出来，
//   不准在调用点手写参数列表。** 把「成对」变成结构上的事实，而不是记性上的要求。
import { FEED_SCOPES } from './schema.js';

/**
 * 拉黑关系（双向）过滤。语义与 `src/store.js` 的 `BLOCKED_AUTHOR_SQL` 一致：
 * 我拉黑的人、拉黑我的人，互相都看不见对方的动态。
 */
const BLOCKED_AUTHOR_SQL = `f.user_id NOT IN (
      SELECT blocked_id FROM blocks WHERE blocker_id = ?
      UNION
      SELECT blocker_id FROM blocks WHERE blocked_id = ?
    )`;

/**
 * 列表/详情共用的列。
 *
 * ⚠️ 前两个 `?` 在 SELECT 列表里（liked / disliked），**排在整个语句最前面**，
 * 拼参数时务必先放这两个，再放 WHERE 的。
 * 这一处就是上面说的「顺序陷阱」的高发地，所以 `list()` / `byId()` 把
 * 「选择列参数」与「WHERE 参数」拆成两个常量再拼接，不靠人肉排列。
 */
const ITEM_COLUMNS = `
      f.id, f.user_id, f.content, f.scope, f.team_id, f.images_json, f.ref_post_id,
      f.created_at, f.updated_at,
      u.username, u.display_name, u.avatar, u.role,
      (SELECT COUNT(*) FROM feed_reactions fr WHERE fr.feed_item_id = f.id AND fr.kind = 'like')    AS like_count,
      (SELECT COUNT(*) FROM feed_reactions fr WHERE fr.feed_item_id = f.id AND fr.kind = 'dislike') AS dislike_count,
      (SELECT COUNT(*) FROM feed_replies frp WHERE frp.feed_item_id = f.id AND frp.deleted = 0)      AS reply_count,
      EXISTS (SELECT 1 FROM feed_reactions fr WHERE fr.feed_item_id = f.id AND fr.kind = 'like'    AND fr.user_id = ?) AS liked,
      EXISTS (SELECT 1 FROM feed_reactions fr WHERE fr.feed_item_id = f.id AND fr.kind = 'dislike' AND fr.user_id = ?) AS disliked,
      p.title AS ref_title, p.deleted AS ref_deleted,
      pu.username AS ref_username, pu.display_name AS ref_display, pu.avatar AS ref_avatar`;

/** `ITEM_COLUMNS` 里那两个 `?` 的实参（总是同一个浏览者 id，放两次）。 */
const columnParams = (viewerId) => [viewerId, viewerId];

const ITEM_FROM = `
    FROM feed_items f
    JOIN users u ON u.id = f.user_id
    LEFT JOIN posts p ON p.id = f.ref_post_id
    LEFT JOIN users pu ON pu.id = p.user_id`;

/**
 * 回复的列与来源。与 `ITEM_COLUMNS` 同一个道理：列名一律写全（`u.` / `r.` 前缀不省），
 * 免得以后有人往 `feed_replies` 上加一列 `content` 就把这里变成歧义列。
 */
const REPLY_COLUMNS = `
      r.id, r.feed_item_id, r.user_id, r.content, r.created_at,
      u.username, u.display_name, u.avatar, u.role`;

const REPLY_FROM = `
    FROM feed_replies r
    JOIN users u ON u.id = r.user_id`;

/**
 * @param {object} db           node:sqlite 的 DatabaseSync
 * @param {object} options
 * @param {boolean} options.hasTeams  `team_members` 表此刻是否已存在（P4 建好之前为 false）
 */
export function createFeedQueries(db, { hasTeams = false } = {}) {
  /**
   * 唯一的语句编译口。占位符个数对不上就抛 —— 宁可当场炸，
   * 也不要让一条参数错位的 SQL 静默返回别人的数据（那可能是越权）。
   */
  function bind(sql, params) {
    const holes = (sql.match(/\?/g) ?? []).length;
    if (holes !== params.length) {
      throw new Error(
        `[feed] SQL 占位符 ${holes} 个，实参 ${params.length} 个 —— 数量对不上，绝不允许执行。\n` +
          `（v1「转发列表 500」就是这个根因；顺序错误比数量错误更隐蔽，所以参数一律由 conditions 成对生成。）\n${sql}`,
      );
    }
    const statement = db.prepare(sql);
    return {
      all: () => statement.all(...params),
      get: () => statement.get(...params),
      run: () => statement.run(...params),
    };
  }

  /**
   * 可见范围的 WHERE 片段（FR-FEED-08：**服务端强制**，不是前端藏起来）。
   *
   * 四档语义：
   *   public    谁都能看（含未登录）
   *   followers 只有关注了我的人（以及我自己）能看
   *   team      只有该团队成员能看（P4 的表还没建时，这一支谁也不给看 —— 宁可看不到，不可看漏）
   *   private   只有我自己
   *
   * 另外**不做 staff 越权**：v1 的帖子有「管理员能看隐藏帖」的规矩，
   * 但动态是私人内容（默认可见范围里就有「仅自己」），管理员能翻别人私密动态是隐私事故。
   * 需要内容管理时应该是另一条明确的接口，不是悄悄放宽这里。
   */
  function visibilityConditions(viewerId) {
    const visible = [`f.scope = 'public'`, `f.user_id = ?`];
    const params = [viewerId];

    visible.push(
      `(f.scope = 'followers' AND EXISTS (
        SELECT 1 FROM follows fo WHERE fo.follower_id = ? AND fo.followee_id = f.user_id
      ))`,
    );
    params.push(viewerId);

    if (hasTeams) {
      visible.push(
        `(f.scope = 'team' AND EXISTS (
          SELECT 1 FROM team_members tm WHERE tm.team_id = f.team_id AND tm.user_id = ?
        ))`,
      );
      params.push(viewerId);
    }

    return [
      { sql: `(${visible.join('\n        OR ')})`, params },
      { sql: BLOCKED_AUTHOR_SQL, params: [viewerId, viewerId] },
    ];
  }

  /** 把 `{ sql, params }` 数组拼成 WHERE，参数按顺序摊平 —— 顺序由数组顺序**结构性**决定。 */
  function buildWhere(conditions) {
    return {
      sql: conditions.map((part) => part.sql).join('\n      AND '),
      params: conditions.flatMap((part) => part.params),
    };
  }

  function listConditions({ viewerId, filter, q }) {
    const conditions = [{ sql: 'f.deleted = 0', params: [] }, ...visibilityConditions(viewerId)];

    if (filter === 'mine') {
      conditions.push({ sql: 'f.user_id = ?', params: [viewerId] });
    }
    if (filter === 'following') {
      conditions.push({
        sql: `(f.user_id = ? OR EXISTS (
          SELECT 1 FROM follows fo WHERE fo.follower_id = ? AND fo.followee_id = f.user_id
        ))`,
        params: [viewerId, viewerId],
      });
    }
    if (q) {
      conditions.push({ sql: 'f.content LIKE ?', params: [`%${q}%`] });
    }
    return conditions;
  }

  return {
    /**
     * 时间线（FR-FEED-01：按时间倒序）。
     * @returns {{ rows: object[], total: number }}
     */
    list({ viewerId, filter = 'all', q = '', page = 1, perPage = 20 }) {
      const where = buildWhere(listConditions({ viewerId, filter, q }));

      // 计数语句没有「选择列参数」，只吃 WHERE 的参数 —— 两处参数集**故意分开算**，
      // 不要在 list/计数之间复用同一个数组（那就又回到手写顺序了）。
      const counted = bind(
        `SELECT COUNT(*) AS count FROM feed_items f JOIN users u ON u.id = f.user_id WHERE ${where.sql}`,
        where.params,
      ).get();
      const total = Number(counted?.count) || 0;

      const rows = bind(
        `SELECT ${ITEM_COLUMNS}${ITEM_FROM}
      WHERE ${where.sql}
      ORDER BY f.created_at DESC, f.id DESC
      LIMIT ? OFFSET ?`,
        [...columnParams(viewerId), ...where.params, perPage, (page - 1) * perPage],
      ).all();

      return { rows, total };
    },

    /** 单条（默认带可见范围过滤，看不到返回 undefined）。 */
    byId({ id, viewerId, ignoreVisibility = false }) {
      const conditions = [{ sql: 'f.id = ?', params: [id] }];
      if (!ignoreVisibility) {
        conditions.push({ sql: 'f.deleted = 0', params: [] });
        conditions.push(...visibilityConditions(viewerId));
      }
      const where = buildWhere(conditions);
      return bind(
        `SELECT ${ITEM_COLUMNS}${ITEM_FROM} WHERE ${where.sql}`,
        [...columnParams(viewerId), ...where.params],
      ).get();
    },

    /** 只取归属和删除位：判断「能不能改」时用，不受可见范围影响。 */
    owner(id) {
      const row = bind('SELECT id, user_id, deleted FROM feed_items WHERE id = ?', [id]).get();
      return row ? { id: row.id, userId: row.user_id, deleted: Boolean(row.deleted) } : null;
    },

    insert({ userId, content, scope, teamId, images, refPostId }) {
      const now = Date.now();
      const result = bind(
        `INSERT INTO feed_items (user_id, content, scope, team_id, images_json, ref_post_id, deleted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        [userId, content, scope, teamId, JSON.stringify(images), refPostId, now, now],
      ).run();
      return Number(result.lastInsertRowid);
    },

    update({ id, content, scope, teamId, images, refPostId }) {
      bind(
        `UPDATE feed_items
       SET content = ?, scope = ?, team_id = ?, images_json = ?, ref_post_id = ?, updated_at = ?
       WHERE id = ?`,
        [content, scope, teamId, JSON.stringify(images), refPostId, Date.now(), id],
      ).run();
    },

    /** 软删除（FR-FEED-11，沿用 v1 的 `deleted = 1` 约定）。 */
    softDelete(id) {
      bind('UPDATE feed_items SET deleted = 1, updated_at = ? WHERE id = ?', [Date.now(), id]).run();
    },

    /** 互动计数（与 core 的 `reactionCounts` 同形状）。 */
    reactionState({ userId, itemId }) {
      const row = bind(
        `SELECT
         (SELECT COUNT(*) FROM feed_reactions fr WHERE fr.feed_item_id = ? AND fr.kind = 'like')    AS like_count,
         (SELECT COUNT(*) FROM feed_reactions fr WHERE fr.feed_item_id = ? AND fr.kind = 'dislike') AS dislike_count,
         (SELECT kind FROM feed_reactions fr WHERE fr.feed_item_id = ? AND fr.user_id = ?)          AS mine`,
        [itemId, itemId, itemId, userId],
      ).get();
      return {
        liked: row?.mine === 'like',
        disliked: row?.mine === 'dislike',
        likeCount: Number(row?.like_count) || 0,
        dislikeCount: Number(row?.dislike_count) || 0,
      };
    },

    /**
     * 点赞/踩。语义**照抄 core 的 `setReaction`**：再点一次同一个 = 取消，换一个 = 改判。
     * @returns {{ changed: boolean, liked: boolean, disliked: boolean, likeCount: number, dislikeCount: number }}
     */
    setReaction({ userId, itemId, kind }) {
      const current = bind(
        'SELECT kind FROM feed_reactions WHERE user_id = ? AND feed_item_id = ?',
        [userId, itemId],
      ).get()?.kind ?? null;

      if (current === kind) {
        bind('DELETE FROM feed_reactions WHERE user_id = ? AND feed_item_id = ?', [userId, itemId]).run();
      } else {
        bind(
          `INSERT INTO feed_reactions (user_id, feed_item_id, kind, created_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (user_id, feed_item_id) DO UPDATE SET kind = excluded.kind, created_at = excluded.created_at`,
          [userId, itemId, kind, Date.now()],
        ).run();
      }

      const next = current === kind ? null : kind;
      return { changed: current !== next, ...this.reactionState({ userId, itemId }) };
    },

    /** 作者/管理员删动态时连带清理互动，避免留孤儿行。 */
    deleteReactionsOf(itemId) {
      bind('DELETE FROM feed_reactions WHERE feed_item_id = ?', [itemId]).run();
    },

    /**
     * 一条动态的回复，按时间**正序**（跟帖子回复一个读法：讨论从上往下）。
     *
     * 拉黑过滤与动态本身的 `BLOCKED_AUTHOR_SQL` 同一套语义 —— 我拉黑的人、
     * 拉黑我的人，互相看不到对方在这条动态下说的话。**匿名的 viewerId 是
     * `ANON`（-1）**，不是 0：0 会被当成一个真实用户去查 blocks 表。
     */
    listReplies({ itemId, viewerId }) {
      const where = buildWhere([
        { sql: 'r.feed_item_id = ?', params: [itemId] },
        { sql: 'r.deleted = 0', params: [] },
        {
          sql: `r.user_id NOT IN (
        SELECT blocked_id FROM blocks WHERE blocker_id = ?
        UNION
        SELECT blocker_id FROM blocks WHERE blocked_id = ?
      )`,
          params: [viewerId, viewerId],
        },
      ]);
      return bind(
        `SELECT ${REPLY_COLUMNS}${REPLY_FROM}
      WHERE ${where.sql}
      ORDER BY r.created_at ASC, r.id ASC`,
        where.params,
      ).all();
    },

    countReplies(itemId) {
      const row = bind(
        'SELECT COUNT(*) AS count FROM feed_replies WHERE feed_item_id = ? AND deleted = 0',
        [itemId],
      ).get();
      return Number(row?.count) || 0;
    },

    /**
     * 单条回复的归属信息（**不受可见范围影响**，删之前要用它判「这条是不是我的」）。
     * 与 `owner()` 同一个理由：越权判断不能建立在「看得见」上面。
     */
    replyOwner(id) {
      const row = bind('SELECT id, feed_item_id, user_id, deleted FROM feed_replies WHERE id = ?', [id]).get();
      return row
        ? {
            id: row.id,
            itemId: row.feed_item_id,
            userId: row.user_id,
            deleted: Boolean(row.deleted),
          }
        : null;
    },

    insertReply({ itemId, userId, content }) {
      const result = bind(
        `INSERT INTO feed_replies (feed_item_id, user_id, content, deleted, created_at)
       VALUES (?, ?, ?, 0, ?)`,
        [itemId, userId, content, Date.now()],
      ).run();
      return Number(result.lastInsertRowid);
    },

    /** 软删（与 `softDelete()` 同一个约定）。返回真正改动的行数。 */
    softDeleteReply(id) {
      return Number(bind('UPDATE feed_replies SET deleted = 1 WHERE id = ? AND deleted = 0', [id]).run().changes) || 0;
    },

    /** 作者/管理员删动态时连带清理回复（与 `deleteReactionsOf` 成对）。 */
    deleteRepliesOf(itemId) {
      bind('DELETE FROM feed_replies WHERE feed_item_id = ?', [itemId]).run();
    },

    /** 备份脚本 / 迁移用：全表计数。 */
    count() {
      const row = bind('SELECT COUNT(*) AS count FROM feed_items WHERE deleted = 0', []).get();
      return Number(row?.count) || 0;
    },

    scopes: FEED_SCOPES,
  };
}
