// 临时诊断：打印 src/server.js 某些行区间的首尾，用来核对切片边界。
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const lines = readFileSync(file, 'utf8').split(/\r?\n/);
const pairs = process.argv.slice(3);
for (const pair of pairs) {
  const [from, to] = pair.split('-').map(Number);
  console.log(`=== ${from}-${to} ===`);
  for (let index = from; index <= Math.min(to, from + 2); index += 1) {
    console.log(`  ${index}| ${lines[index - 1]}`);
  }
  if (to - from > 5) console.log('  ...');
  for (let index = Math.max(from + 3, to - 2); index <= to; index += 1) {
    console.log(`  ${index}| ${lines[index - 1]}`);
  }
}
