// 逐字符打印一个行区间里所有反引号的列号与前后 1 个字符的码点。
// 用法：node dump-backticks.mjs <file> <line>
import { readFileSync } from 'node:fs';

const [, , file, lineArg] = process.argv;
const line = Number(lineArg);
const text = readFileSync(file, 'utf8').split(/\r?\n/)[line - 1];
console.log(`第 ${line} 行，共 ${[...text].length} 个码点：`);
console.log(JSON.stringify(text));
console.log('');
for (let index = 0; index < text.length; index += 1) {
  if (text[index] === '`') {
    const before = text.slice(Math.max(0, index - 3), index);
    const after = text.slice(index + 1, index + 4);
    console.log(`  第 ${index} 列：…${JSON.stringify(before)}[反引号]${JSON.stringify(after)}…`);
  }
}
console.log(`\n本行反引号个数：${(text.match(/`/g) || []).length}`);
console.log(`本行反斜杠个数：${(text.match(/\\/g) || []).length}`);
