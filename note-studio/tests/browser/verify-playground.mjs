/**
 * 操作样例自检（命令行）：用 jsdom 打开 public/playground.html 并真的点按钮。
 * 检查逻辑在 playground-checks.mjs（验收脚本复用同一份）。
 *
 * 运行：
 *   NODE_PATH=<装有 jsdom 的 node_modules> node tests/browser/verify-playground.mjs
 */
import { runPlaygroundChecks } from './playground-checks.mjs';

const result = await runPlaygroundChecks();

if (result.skipped) {
  console.error(`跳过操作样例自检：${result.reason}`);
  process.exitCode = 2;
} else {
  for (const item of result.checks) console.log(`${item.ok ? '✔' : '✘'} ${item.name}${item.extra ? `  (${item.extra})` : ''}`);
  const failed = result.checks.filter((item) => !item.ok);
  console.log('');
  console.log(failed.length ? `FAIL：${failed.map((item) => item.name).join(' / ')}` : `PASS：${result.checks.length} 项操作检查全部通过`);
  process.exitCode = failed.length ? 1 : 0;
}
