// 比对两个文本文件，打印前若干处差异所在行。
// 用法：node diff-lines.mjs <a> <b> [maxReport]
import { readFileSync } from 'node:fs';

const [, , fileA, fileB, maxArg] = process.argv;
const max = Number(maxArg || 20);
const a = readFileSync(fileA, 'utf8').split(/\r?\n/);
const b = readFileSync(fileB, 'utf8').split(/\r?\n/);

console.log(`${fileA}: ${a.length} 行`);
console.log(`${fileB}: ${b.length} 行`);

const limit = Math.max(a.length, b.length);
let reported = 0;
let firstDiff = null;
let lastDiff = null;
for (let index = 0; index < limit; index += 1) {
  if (a[index] === b[index]) continue;
  if (firstDiff === null) firstDiff = index + 1;
  lastDiff = index + 1;
  if (reported < max) {
    console.log('');
    console.log(`第 ${index + 1} 行不同：`);
    console.log(`  ${fileA}: ${JSON.stringify((a[index] ?? '<无此行>').slice(0, 120))}`);
    console.log(`  ${fileB}: ${JSON.stringify((b[index] ?? '<无此行>').slice(0, 120))}`);
  }
  reported += 1;
}
if (reported === 0) {
  console.log('两份完全一致');
} else {
  console.log(`\n共 ${reported} 行不同，第一处在第 ${firstDiff} 行，最后一处在第 ${lastDiff} 行（只打印了前 ${Math.min(reported, max)} 处）。`);
}
