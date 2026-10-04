// 建表登记处。
//
// 每个模块通过 schemas.add(表名, 'CREATE TABLE IF NOT EXISTS ...') 登记自己的表，
// src/core/database.js 会把它们一次执行。
//
// 顺序很重要：boards 是 posts.board_id 的外键目标，所以 core 的表必须先登记。
// 登记顺序 = 建表顺序 = 各模块在 src/modules/index.js 里的排列顺序。

/** @type {{ name: string, sql: string, owner: string }[]} */
const entries = [];
/** 表名 → 归属模块，用来抓「两个模块抢同一张表」。 */
const ownerOf = new Map();

/**
 * 登记一张表。
 * @param {string} name 表名（必须与 SQL 里的表名一致，用于查重）
 * @param {string} sql 完整的 CREATE TABLE IF NOT EXISTS 语句（以分号结尾）
 * @param {string} owner 归属模块名（core / feed / doc / ai / team / ui）
 */
function add(name, sql, owner = 'core') {
  if (ownerOf.has(name)) {
    throw new Error(`表 ${name} 被重复登记：${ownerOf.get(name)} 和 ${owner}`);
  }
  ownerOf.set(name, owner);
  entries.push({ name, sql: sql.trim().replace(/;$/, ''), owner });
}

/**
 * 登记一段含多张表的 SQL（例如 core 的整块 CORE_SCHEMA）。
 *
 * 按「括号深度为 0 时的分号」切分，而不是简单 split(';')：
 * 建表语句里有默认值字符串和注释，简单切分会切坏。
 *
 * ⚠️ 只有 `CREATE TABLE` 会被算作「表」并登记归属；
 * `CREATE INDEX` 之类照旧执行，但不进表名册 ——
 * 否则索引名会被当成表名，`tablesWithoutOwner()` 会误报。
 */
function addScript(sql, owner = 'core') {
  const statements = [];
  let depth = 0;
  let current = '';
  for (const character of sql) {
    current += character;
    if (character === '(') depth += 1;
    else if (character === ')') depth -= 1;
    else if (character === ';' && depth === 0) {
      if (current.trim()) statements.push(current.trim());
      current = '';
    }
  }
  if (current.trim()) statements.push(current.trim());

  for (const statement of statements) {
    const match = /^\s*CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([A-Za-z_][\w]*)/i.exec(statement);
    if (match) {
      add(match[1], statement, owner);
      continue;
    }
    if (/^\s*CREATE\s+TABLE\b/i.test(statement)) {
      throw new Error(`addScript 收到一段不像建表语句的 SQL：${statement.slice(0, 60)}…`);
    }
    // 索引、触发器之类的附带语句：照旧执行，但不登记归属。
    entries.push({ name: null, sql: statement.trim().replace(/;$/, ''), owner });
  }
}

/** 按登记顺序拼出完整的建表 SQL。 */
function toSql() {
  return entries.map((item) => `${item.sql};`).join('\n\n');
}

/** 已登记的表名（按登记顺序，不含索引之类的附带语句）。 */
function names() {
  return entries.filter((item) => item.name).map((item) => item.name);
}

/** 表名 → 归属模块。 */
function owners() {
  return new Map(ownerOf);
}

export const schemas = { add, addScript, toSql, names, owners };
