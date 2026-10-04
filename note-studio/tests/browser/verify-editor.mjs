/**
 * 正式编辑器（public/index.html）的操作自检。
 * 检查逻辑在 editor-checks.mjs（验收脚本复用同一份）。
 *
 * 运行：
 *   NODE_PATH=<装有 jsdom 的 node_modules> node tests/browser/verify-editor.mjs
 */
import { runEditorChecks } from './editor-checks.mjs';

const result = await runEditorChecks();

if (result.skipped) {
  console.error(`跳过编辑器自检：${result.reason}`);
  process.exitCode = 2;
} else {
  for (const item of result.checks) console.log(`${item.ok ? '✔' : '✘'} ${item.name}${item.extra ? `  (${item.extra})` : ''}`);
  const failed = result.checks.filter((item) => !item.ok);
  console.log('');
  console.log(failed.length ? `FAIL：${failed.map((item) => item.name).join(' / ')}` : `PASS：${result.checks.length} 项检查全部通过`);
  process.exitCode = failed.length ? 1 : 0;
}
