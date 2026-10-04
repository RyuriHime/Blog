// 修一个顺序问题：src/db.js 里必须先 import core/tables.sql.js，
// 再 import core/open-db.js。
//
// 原因：tables.sql.js 在模块顶层调用 schemas.addScript(CORE_SCHEMA,'core')（副作用导入），
// 而 open-db.js 默认的 tables 参数就是同一个 schemas 对象。如果 open-db.js 先被求值，
// schemas 还是空的，db.exec(schemas.toSql()) 就是一句空 SQL —— 一张表都不会建，
// 紧接着 migrate() 会报 "no such table: users"。
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'docs/tools/extract-server-modules.mjs';
const source = readFileSync(FILE, 'utf8');

const from = `    // 依赖方向：db.js → core/open-db.js → core/open-db-support.js，全程单向，没有循环 import。
    // 下面这行只是把 openDatabase 重新导出，给 scripts/reset-db.mjs 这类老调用方继续用。
    "import { openDatabase } from './core/open-db.js';",`;

const to = `    // ⚠️ 这三行的顺序不能动：
    //   1) tables.sql.js 是**副作用导入** —— 它在模块顶层执行 schemas.addScript(CORE_SCHEMA, 'core')，
    //      把 18 张 core 表登记进 schemas 登记处；
    //   2) open-db.js 默认的 tables 参数就是那个 schemas 对象。
    // 如果 2 排在 1 前面，schemas 还是空的，db.exec(schemas.toSql()) 等于一句空 SQL，
    // 一张表都不会建，紧接着 migrate() 就会报 "no such table: users"。
    // 3) 依赖方向：db.js → core/open-db.js → core/open-db-support.js，全程单向，没有循环 import。
    //    最后这行只是把 openDatabase 重新导出，给 scripts/reset-db.mjs 这类老调用方继续用。
    "import './core/tables.sql.js'; // 副作用导入：把 18 张 core 表登记进 schemas（必须在下一行之前）",
    "import { openDatabase } from './core/open-db.js';",`;

if (!source.includes(from)) throw new Error('找不到要替换的片段');
writeFileSync(FILE, source.replace(from, to), 'utf8');
console.log('已给 db.js 的生成结果加上 tables.sql.js 副作用导入');
