import { readFileSync } from 'node:fs';
function read(relative) {
  return readFileSync(relative, 'utf8');
}
const dbLines = read('src/db.js').split(/\r?\n/);
console.log(`src/db.js 共 ${dbLines.length} 个元素`);
for (const line of [8, 9, 10, 11, 12, 200, 201, 202, 203, 882, 883, 884, 888, 911, 912, 913]) {
  console.log(`  [${line}] = ${JSON.stringify((dbLines[line - 1] ?? '<无>').slice(0, 60))}`);
}
const middle = dbLines.slice(201, 882);
console.log(`middle 长度 ${middle.length}，首元素 ${JSON.stringify(middle[0])}`);
const after = dbLines.slice(911);
console.log(`after 长度 ${after.length}，首元素 ${JSON.stringify(after[0])}`);
