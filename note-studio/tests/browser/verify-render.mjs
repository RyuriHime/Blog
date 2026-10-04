/**
 * 渲染自检（命令行）：在 jsdom 里执行 note-studio 的前端资源，验证公式真的被渲染、
 * 以及「可视化模式 → Markdown」的往返不会破坏公式。
 *
 * 检查逻辑在 render-checks.mjs（验收脚本复用同一份）。
 *
 * 为什么用 jsdom 而不是无头浏览器：受限沙箱下 Chrome/Edge 拿不到命名管道
 * （mojo platform_channel 拒绝访问），起不来。
 *
 * 运行（jsdom 只用于验证，不是本包依赖）：
 *   mkdir verify && cd verify && npm i jsdom
 *   NODE_PATH=<verify>/node_modules node tests/browser/verify-render.mjs
 */
import { runRenderChecks } from './render-checks.mjs';

const result = await runRenderChecks();

if (result.skipped) {
  console.error(`跳过渲染自检：${result.reason}`);
  process.exitCode = 2;
} else {
  for (const check of result.checks) console.log(`${check.ok ? '✔' : '✘'} ${check.name}`);
  const failed = result.checks.filter((check) => !check.ok);
  console.log('');
  console.log(`公式渲染数量：${result.math}`);
  console.log(failed.length ? `FAIL：${failed.map((check) => check.name).join(' / ')}` : `PASS：${result.checks.length} 项检查全部通过`);
  process.exitCode = failed.length ? 1 : 0;
}
