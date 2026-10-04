/**
 * note-agent 的测试入口：把 tests/ 下所有 test-*.mjs 各起一个子进程跑一遍。
 *
 * 用子进程而不是同进程 import，理由有三个：
 *   1) test-store.mjs / test-mount.mjs 会开 database 与 http server，同进程会互相干扰；
 *   2) 某个测试忘了关句柄时，不会把整套测试拖住不退出；
 *   3) 每个测试文件的退出码天然就是它的结论，汇总逻辑简单可靠。
 *
 * 这个包可以脱离论坛单独存在（`examples/server.mjs` 就是证据），但有两类依赖是**可选**的：
 *   - 宿主仓库：`test-docs.mjs` 与 `test-integration.mjs` 是从外面看宿主的，没有就跳过；
 *   - 兄弟目录 `forum-ai`：有就用它的真实 AI 实现，没有就用包自带的兜底（见 src/ai.mjs）。
 *     这两条都在下面的输出里报出来 —— 拷走的机器上"到底在用哪套"必须一眼看得见。
 *
 * 零依赖：只用 node:child_process / node:fs / node:path（外加本包的 src/ai.mjs）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { aiSource } from '../src/ai.mjs';

const testsDir = fileURLToPath(new URL('../tests/', import.meta.url));
const packageRoot = resolve(testsDir, '..');
const repoRoot = resolve(packageRoot, '..');

/** 需要宿主在场的测试文件。改这里就等于改"单独拷给别人时跳过什么"。 */
export const requiresHost = ['test-docs.mjs', 'test-integration.mjs'];

/**
 * 宿主在不在：仓库根目录得同时有 `src/server.js`、`public/app.js` 和 `package.json`。
 *
 * 只判断目录名不够 —— 单独拷出去的包也可能被放在一个叫 `forum` 的目录里。
 */
export function hasHost(root = repoRoot) {
  return ['package.json', join('src', 'server.js'), join('public', 'app.js')].every((rel) => existsSync(join(root, rel)));
}

/** 列出这次要跑的测试文件（按名字排序）。没有宿主时剔掉 requiresHost 里的。 */
export function listTestFiles({ host = hasHost() } = {}) {
  const all = readdirSync(testsDir)
    .filter((name) => name.startsWith('test-') && name.endsWith('.mjs'))
    .sort();
  return host ? all : all.filter((name) => !requiresHost.includes(name));
}

/**
 * 从测试文件的 stdout 里读它自己报的断言数（`tests/helpers/check.mjs` 的 `summary()` 打的）。
 *
 * @returns {{passed:number, failed:number, skipped:number}|null}
 */
export function parseResult(output) {
  const lines = String(output ?? '').split('\n').filter((line) => line.startsWith('#RESULT '));
  const last = lines.at(-1);
  if (!last) return null;
  try {
    const parsed = JSON.parse(last.slice('#RESULT '.length));
    if (!Number.isFinite(parsed?.passed) || !Number.isFinite(parsed?.failed)) return null;
    return { passed: parsed.passed, failed: parsed.failed, skipped: parsed.skipped ?? 0 };
  } catch {
    return null;
  }
}

// 被 import 时不执行（测试会 import 上面两个函数）；直接跑时才跑。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = hasHost();
  const files = listTestFiles({ host });
  const skipped = readdirSync(testsDir)
    .filter((name) => name.startsWith('test-') && name.endsWith('.mjs') && !files.includes(name))
    .sort();

  if (files.length === 0) {
    console.error('note-agent: tests/ 下没有 test-*.mjs');
    process.exit(1);
  }

  if (!host) {
    console.log(`note-agent: 没找到宿主（${dirname(packageRoot)} 下没有 src/server.js），跳过 ${skipped.join('、')}`);
  }
  // AI 实现的探测是动态 import，只在微任务后落地 —— 先让出一次再报，否则会误报成 bundled。
  await new Promise((r) => { setTimeout(r, 50); });
  console.log(`note-agent: AI 实现 = ${aiSource()}${aiSource() === 'bundled' ? '（旁边没有 forum-ai，用包自带的兜底实现）' : '（用的就是兄弟目录 forum-ai）'}`);

  let passedFiles = 0;
  const failures = [];
  // 断言总数也汇总：只看退出码的话，一个"退出码 0 但其实有失败断言"的文件会被当全绿
  // （`check()` 只设 `process.exitCode`，任何后续覆写它、或 promise 里的漏网错误都会抹掉这个信号）。
  let totalChecks = 0;

  for (const name of files) {
    console.log(`\n▶ ${name}`);
    // stdout 收进管道（要读 #RESULT 那行），stderr 直通终端（报错要立刻看见）。
    const result = spawnSync(process.execPath, [join(testsDir, name)], { stdio: ['inherit', 'pipe', 'inherit'] });
    const output = result.stdout?.toString?.() ?? '';
    if (output.length > 0) process.stdout.write(output);
    const reported = parseResult(output);
    if (reported) totalChecks += reported.passed + reported.failed;
    if (result.status === 0 && !result.error) {
      if (reported && reported.failed > 0) {
        // 有牙的护栏：退出码说通过、断言说没通过时，以断言为准。
        failures.push({ name, status: `断言失败 ${reported.failed} 项`, error: `退出码本应是 1` });
      } else if (!reported) {
        failures.push({ name, status: '没有输出 #RESULT 汇总行', error: '测试文件要么没跑 summary()，要么中途退出了' });
      } else {
        passedFiles += 1;
      }
    } else {
      failures.push({ name, status: result.status, error: result.error?.message ?? '' });
    }
  }

  console.log('\n────────────────────────────────────────');
  console.log(`note-agent 测试文件：通过 ${passedFiles} / ${files.length}${skipped.length > 0 ? `（跳过 ${skipped.length} 个需要宿主的）` : ''}`);
  console.log(`note-agent 断言合计：${totalChecks} 项`);
  if (failures.length > 0) {
    for (const item of failures) {
      console.log(`  ❌ ${item.name}（退出码 ${item.status}）${item.error ? ` — ${item.error}` : ''}`);
    }
    process.exit(1);
  }
  console.log('note-agent 全部测试通过');
}
