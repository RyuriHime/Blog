// 诊断 2：扫描 CORE_SCHEMA，逐字符跟踪括号深度，找出深度异常的位置。
// 深度为负、或「一段语句结束时深度不为 0」都说明切分逻辑有问题。
// 用法：node docs/tools/debug-depth.mjs
import { CORE_SCHEMA } from '../../src/core/tables.sql.js';

const lines = CORE_SCHEMA.split('\n');
let depth = 0;
let statementIndex = 0;
let statementStartLine = 1;

for (let index = 0; index < lines.length; index += 1) {
  const line = lines[index];
  let inLineComment = false;
  for (let column = 0; column < line.length; column += 1) {
    const character = line[column];
    if (inLineComment) break;
    if (character === '-' && line[column + 1] === '-') {
      inLineComment = true;
      break;
    }
    if (character === '(') depth += 1;
    else if (character === ')') {
      depth -= 1;
      if (depth < 0) {
        console.log(`❌ 第 ${index + 1} 行第 ${column + 1} 列之后深度变成 ${depth}：${JSON.stringify(line)}`);
        console.log(`   这一段语句从第 ${statementStartLine} 行开始。`);
        depth = 0;
      }
    } else if (character === ';' && depth === 0) {
      statementIndex += 1;
      statementStartLine = index + 2;
    }
  }
}

console.log(`\n扫完：深度 = ${depth}（应为 0），语句数 = ${statementIndex + 1}`);

// 再把每段语句的首行打出来，方便和上一步的 35 段对照。
const statements = [];
let current = '';
let level = 0;
for (const character of CORE_SCHEMA) {
  current += character;
  if (character === '(') level += 1;
  else if (character === ')') level -= 1;
  else if (character === ';' && level === 0) {
    if (current.trim()) statements.push(current.trim());
    current = '';
  }
}
if (current.trim()) statements.push(current.trim());
console.log('\n每段语句的起始行（1 基）：');
let line = 1;
for (const statement of statements) {
  const head = statement.split('\n')[0].slice(0, 60);
  const kind = /CREATE\s+TABLE/i.test(statement)
    ? 'TBL'
    : /CREATE\s+INDEX/i.test(statement)
      ? 'IDX'
      : /^\s*--/.test(statement)
        ? 'CMT'
        : '???';
  console.log(`  行 ${String(line).padStart(4)} ${kind} ${head}`);
  line += statement.split('\n').length;
}
