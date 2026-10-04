// 一次性修复脚本：恢复被 PowerShell 按 GBK 重新解码过的 UTF-8 源文件。
//
// 事故经过：对 docs/tools/extract-server-modules.mjs 用过一次
//   $t = Get-Content -LiteralPath $f -Raw      ← 默认按系统 ANSI(GBK) 解码 UTF-8 字节
//   [IO.File]::WriteAllText($f, $t, UTF8)      ← 再用 UTF-8 编码写回 → 双重编码
// 同样地，WriteAllText 写出的 table.js 也带着同样的双重编码。
//
// 修复原理（可逆）：原 UTF-8 字节 --按GBK解码--> S1 --按UTF-8编码--> 现有文件。
// 所以：现有文件 --按UTF-8解码--> S1 --按GBK编码--> 原 UTF-8 字节。
//
// Node 的 Buffer 没有 gbk 编码，所以这里用 TextDecoder('gbk') 反查一张 GBK 编码表：
// 把 0x00-0xFF 的所有双字节组合解出来，谁解成某个字符，就记下这个字符对应的字节。
import { readFileSync, writeFileSync } from 'node:fs';

const decoder = new TextDecoder('gbk', { fatal: false });
/** 字符 → GBK 字节（只有能唯一解出的才收录）。 */
const encodeTable = new Map();

// 单字节区（ASCII 由下面直接处理，这里补 0x80-0xFF 的单字节映射）
for (let byte = 0x80; byte <= 0xff; byte += 1) {
  const text = decoder.decode(Uint8Array.from([byte]));
  if (text.length === 1 && text !== '\uFFFD' && !encodeTable.has(text)) {
    encodeTable.set(text, [byte]);
  }
}
// 双字节区：GBK 的首字节 0x81-0xFE，次字节 0x40-0xFE（去掉 0x7F）
for (let lead = 0x81; lead <= 0xfe; lead += 1) {
  for (let trail = 0x40; trail <= 0xfe; trail += 1) {
    if (trail === 0x7f) continue;
    const text = decoder.decode(Uint8Array.from([lead, trail]));
    if (text.length === 1 && text !== '\uFFFD' && !encodeTable.has(text)) {
      encodeTable.set(text, [lead, trail]);
    }
  }
}

/** 把字符串按 GBK 编码成字节。ASCII 原样；表里没有的字符直接报错，避免悄悄写坏。 */
function encodeGbk(text) {
  const out = [];
  for (const character of text) {
    const code = character.codePointAt(0);
    if (code < 0x80) {
      out.push(code);
      continue;
    }
    const bytes = encodeTable.get(character);
    if (!bytes) {
      throw new Error(`这个字符不在 GBK 里，无法还原：${character}（U+${code.toString(16).toUpperCase()}）`);
    }
    out.push(...bytes);
  }
  return Buffer.from(out);
}

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error('用法：node docs/tools/repair-gbk-double-encoding.mjs <文件> [文件...]');
  process.exit(1);
}

let failed = false;
for (const file of targets) {
  try {
    const original = readFileSync(file);
    const mangled = original.toString('utf8');

    // 防呆：如果文本里「双重编码指纹」占比过高，说明这个文件本来就正常，
    // 再跑一次反而会把它弄坏。指纹 = 常见于「UTF-8 被当成 GBK 解」的汉字区间。
    const nonAscii = [...mangled].filter((c) => c.codePointAt(0) > 0x7f);
    const suspicious = nonAscii.filter((c) => {
      const code = c.codePointAt(0);
      return (code >= 0x9000 && code <= 0x9fff) || (code >= 0xe000 && code <= 0xf8ff);
    });
    if (nonAscii.length > 0 && suspicious.length / nonAscii.length > 0.5) {
      console.log(`跳过（看起来本来就是正常 UTF-8）：${file}`);
      continue;
    }

    const restored = encodeGbk(mangled);
    writeFileSync(file, restored);
    console.log(
      `已修复：${file}（${original.length} → ${restored.length} 字节，` +
        `头部：${JSON.stringify(restored.toString('utf8', 0, 24))}）`,
    );
  } catch (error) {
    failed = true;
    console.error(`修复失败：${file} —— ${error.message}`);
  }
}
process.exit(failed ? 1 : 0);
