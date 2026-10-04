// 诊断：schemas.addScript 到底切出了哪些语句、认出了几张表。
// 用法：node docs/tools/debug-addscript.mjs
import { CORE_SCHEMA } from '../../src/core/tables.sql.js';

const statements = [];
let depth = 0;
let current = '';
for (const character of CORE_SCHEMA) {
  current += character;
  if (character === '(') depth += 1;
  else if (character === ')') depth -= 1;
  else if (character === ';' && depth === 0) {
    if (current.trim()) statements.push(current.trim());
    current = '';
  }
}
if (current.trim()) statements.push(current.trim());

console.log(`切出 ${statements.length} 段语句\n`);
statements.forEach((statement, index) => {
  const table = /^\s*CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([A-Za-z_][\w]*)/i.exec(statement);
  const indexMatch = /^\s*CREATE\s+INDEX\b/i.test(statement);
  const head = statement.split('\n')[0].slice(0, 80);
  console.log(
    `${String(index).padStart(2)} ${table ? 'TABLE ' + table[1] : indexMatch ? 'INDEX' : '?????'}  ${head.replace(/\s+/g, ' ')}`,
  );
});
