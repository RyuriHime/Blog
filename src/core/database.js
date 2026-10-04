// 建库门面。
//
// 真正实现在 src/db.js（那边还有播种、迁移、六个回填函数，占了 900 多行）。
// 这里把「打开数据库」这件事提到 src/core/ 门面上，为的是两件事：
//
// 1) 建表语句的来源从「一个写死的 SCHEMA 常量」变成「schemas 登记处」——
//    各业务模块用自己的表去登记，core 这边一次执行。顺序由 src/modules/index.js 决定。
// 2) 模块只 import 这个文件，不会去碰 src/db.js 里的播种细节。
//
// 注意：建表顺序不能变。boards 是 posts.board_id 的外键目标，
// 而 PRAGMA foreign_keys = ON，所以 core 的表永远排在业务模块的表前面。
import { openDatabase as openDatabaseWithSchema } from '../db.js';

export { DEFAULT_BOARDS, COIN_RULES, CHECKIN_RULES, PROFILE_RULES, POST_VALUE_WEIGHTS, MESSAGE_RULES, ROLES, STAFF_ROLES } from '../db.js';

/**
 * 打开（必要时创建）数据库。
 *
 * 相比搬运之前，只有一处改了：`db.exec(SCHEMA)` 变成 `db.exec(schemas.toSql())`。
 * 其余（WAL、外键、busy_timeout、migrate、播种判据、六个 backfill）逐字未动。
 *
 * @param {string} file 数据库文件路径（`:memory:` 表示内存库）
 * @param {{ toSql: () => string }} schemas 建表登记处
 */
export function openDatabase(file, schemas) {
  return openDatabaseWithSchema(file, schemas);
}
