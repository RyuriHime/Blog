/**
 * 把 start.cmd 规范化成 cmd.exe 要求的样子：
 *   1) CRLF 换行（LF-only 的批处理会被 cmd 错误分词，尤其是 if / goto 结构）
 *   2) 不带 UTF-8 BOM（带 BOM 时第一行会变成 `ï»¿@echo off` 而报错）
 *   3) 纯 ASCII（批处理按 OEM 代码页解析，脚本里写中文会被拆成乱码命令）
 * 用法：node scripts/fix-cmd.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const TARGETS = ['start.cmd'];

let problems = 0;
for (const name of TARGETS) {
  const file = join(ROOT, name);
  const original = readFileSync(file, 'utf8');
  const withoutBom = original.replace(/^\uFEFF/, '');
  const withCrlf = withoutBom.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  const nonAscii = [...withCrlf].filter((char) => char.charCodeAt(0) > 126 && char !== '\r' && char !== '\n');

  if (withCrlf !== original) {
    writeFileSync(file, withCrlf, 'utf8');
    console.log(`已规范化换行: ${name}`);
  } else {
    console.log(`换行已是 CRLF: ${name}`);
  }
  if (original.startsWith('\uFEFF')) {
    problems += 1;
    console.log(`⚠️ ${name} 原本带 BOM，已移除`);
  }
  if (nonAscii.length) {
    problems += 1;
    console.log(`⚠️ ${name} 含 ${nonAscii.length} 个非 ASCII 字符：${[...new Set(nonAscii)].join('')}`);
  } else {
    console.log(`纯 ASCII: ${name}`);
  }
}

process.exit(problems ? 1 : 0);
