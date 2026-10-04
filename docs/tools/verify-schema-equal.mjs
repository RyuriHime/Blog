// 逐字节校验：src/core/tables.sql.js 里的 CORE_SCHEMA 是否等于
// docs/.baseline/db.js 里原来的 SCHEMA 常量值。
//
// 用法：node docs/tools/verify-schema-equal.mjs <baseline-db.js> <tables.sql.js>
import { readFileSync } from 'node:fs';

/** 从源码文本里切出 `名字 = ` 后面那个模板字符串的「值」（已解转义）。 */
function extractTemplateValue(source, marker) {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`找不到 ${marker}`);
  let index = start + marker.length;
  if (source[index] !== '`') throw new Error(`${marker} 后面不是反引号，而是 ${JSON.stringify(source[index])}`);
  index += 1;
  let value = '';
  while (index < source.length) {
    const character = source[index];
    if (character === '\\') {
      const next = source[index + 1];
      value += next === '`' ? '`' : next === '$' ? '$' : next === '\\' ? '\\' : `\\${next}`;
      index += 2;
      continue;
    }
    if (character === '`') return value;
    value += character;
    index += 1;
  }
  throw new Error(`${marker} 的模板字符串没有收尾`);
}

const [, , baselineFile, currentFile] = process.argv;
const baseline = extractTemplateValue(readFileSync(baselineFile, 'utf8'), 'const SCHEMA = ');
const current = extractTemplateValue(readFileSync(currentFile, 'utf8'), 'export const CORE_SCHEMA = ');

console.log(`原 SCHEMA     : ${baseline.length} 字符`);
console.log(`CORE_SCHEMA   : ${current.length} 字符`);

if (baseline === current) {
  console.log('✅ 两份完全一致（逐字节）');
  process.exit(0);
}

console.log('❌ 有差异');
const limit = Math.max(baseline.length, current.length);
let shown = 0;
for (let index = 0; index < limit && shown < 10; index += 1) {
  if (baseline[index] !== current[index]) {
    const around = (text) => JSON.stringify(text.slice(Math.max(0, index - 40), index + 40));
    console.log(`  第 ${index} 字符处：`);
    console.log(`    原  : ${around(baseline)}`);
    console.log(`    新  : ${around(current)}`);
    shown += 1;
  }
}
process.exit(1);
