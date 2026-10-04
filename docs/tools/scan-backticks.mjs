// 扫描一个 JS 文件，逐字符走一遍，报告每个反引号的「角色」判断：
// 用极简状态机区分 代码态 / 单引号串 / 双引号串 / 模板串 / 行注释 / 块注释。
// 用法：node scan-backticks.mjs <file> [fromLine] [toLine]
import { readFileSync } from 'node:fs';

const [, , file, fromArg, toArg] = process.argv;
const from = Number(fromArg || 1);
const to = Number(toArg || Number.MAX_SAFE_INTEGER);
const source = readFileSync(file, 'utf8');
const lines = source.split(/\r?\n/);

let state = 'code'; // code | single | double | template | line-comment | block-comment
let line = 1;
let reported = 0;

for (let index = 0; index < source.length; index += 1) {
  const character = source[index];
  const next = source[index + 1];
  if (character === '\n') {
    if (state === 'line-comment') state = 'code';
    line += 1;
    continue;
  }
  const here = line >= from && line <= to;
  const describe = (role) => {
    if (!here) return;
    reported += 1;
    console.log(`第 ${line} 行 第 ${index - source.lastIndexOf('\n', index - 1)} 列  反引号 -> ${role}（此前状态 ${state}）`);
    console.log(`    ${JSON.stringify(lines[line - 1])}`);
  };

  if (state === 'line-comment') continue;
  if (state === 'block-comment') {
    if (character === '*' && next === '/') { state = 'code'; index += 1; }
    continue;
  }
  if (state === 'single' || state === 'double') {
    if (character === '\\') { index += 1; continue; }
    if ((state === 'single' && character === "'") || (state === 'double' && character === '"')) state = 'code';
    if (character === '`') describe('字符串里的普通反引号（不切换状态）');
    continue;
  }
  if (state === 'template') {
    if (character === '\\') { describe('模板串里的转义反引号 \\`'); index += 1; continue; }
    if (character === '`') { describe('关闭模板串'); state = 'code'; continue; }
    continue;
  }
  // code 态
  if (character === '/' && next === '/') { state = 'line-comment'; index += 1; continue; }
  if (character === '/' && next === '*') { state = 'block-comment'; index += 1; continue; }
  if (character === "'") { state = 'single'; continue; }
  if (character === '"') { state = 'double'; continue; }
  if (character === '`') { describe('**打开模板串**'); state = 'template'; continue; }
}

console.log(`\n结束状态：${state}（code 才是正常收尾）；本次报告 ${reported} 处。`);
if (state !== 'code') process.exit(1);
