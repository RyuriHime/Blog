/**
 * 极简断言器：与宿主 scripts/smoke.mjs 的 check() 风格保持一致。
 *
 * 每个测试文件自己 createChecker()，结束时调用 summary()。
 * 失败时只设置 process.exitCode（不直接 exit），方便同进程内继续跑完剩余断言。
 *
 * `skip(name, why)` 给「这条断言要看宿主，而包被单独拷走了」的情况用：
 * 单独拷出去的包不该因为"没有宿主可看"而变红，但也不该假装自己验过了 ——
 * 所以它照常打印一行，标成跳过，并且**不**计入通过与失败。
 *
 * `toLocalPath(url)` 是给"起子进程"的测试用的：URL 的 `.pathname` 会把中文/空格
 * 留成 %XX（交付包目录就叫「note-agent-交付包」），交给 node 就是 MODULE_NOT_FOUND。
 */
import { fileURLToPath } from 'node:url';

/** 把 file:// URL 变成能交给 spawn 的本地路径。 */
export function toLocalPath(url) {
  return fileURLToPath(url instanceof URL ? url : new URL(url));
}

export function createChecker() {
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  function check(name, condition, detail = '') {
    if (condition) {
      passed += 1;
      console.log(`  ✅ ${name}`);
      return true;
    }
    failed += 1;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
    return false;
  }

  function skip(name, why = '') {
    skipped += 1;
    console.log(`  ⏭️  ${name}${why ? ` — ${why}` : ''}`);
    return false;
  }

  function summary() {
    const tail = skipped > 0 ? `，跳过 ${skipped} 项` : '';
    console.log(`  通过 ${passed} 项，失败 ${failed} 项${tail}`);
    // 给汇总脚本读的机器行：只靠子进程退出码数文件是不够的 —— 断言失败只设了
    // `process.exitCode`，若这个文件里还有别的代码把退出码覆盖掉（或在 promise 里
    // 抛了没人接的错），外面看到的就是"退出码 0、全绿"。这一行让汇总方拿到真实断言数。
    console.log(`#RESULT ${JSON.stringify({ passed, failed, skipped })}`);
    if (failed > 0) process.exitCode = 1;
    return { passed, failed, skipped };
  }

  return { check, skip, summary };
}
