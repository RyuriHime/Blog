/**
 * 测试入口自己的测试（任务：交付包要能脱离论坛单独跑）。
 *
 * 背景：`test-docs.mjs` 与 `test-integration.mjs` 是**从外面看宿主**的 —— 它们读宿主源码、
 * 起宿主服务、读宿主 package.json。这个包要能整个拷给同事，那边没有论坛，
 * 这两个文件必然红。红的不是包，是它们没东西可看，所以入口必须能识别并跳过。
 *
 * 一条重要纪律：这里的断言**不能**写死"当前仓库一定有宿主"。
 * 交付包就是 note-agent 单独一个目录，那时 hasHost() 必须老老实实回 false。
 * 所以"该是什么"以**文件系统事实**为准（note-agent 的上级目录有没有 package.json），
 * 再断言 hasHost() 与这个事实一致 —— 这样它既不是同义反复，也不会在拷贝件上假红。
 *
 * 断言不碰真文件系统：`listTestFiles({host})` 的第二个开关就是为这里留的。
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createChecker, toLocalPath } from './helpers/check.mjs';
import { listTestFiles, requiresHost, hasHost, parseResult } from '../scripts/run-tests.mjs';

const { check, summary } = createChecker();

check('测试入口在测试目录里能被找到', typeof hasHost === 'function' && typeof listTestFiles === 'function');

// 事实来源：note-agent 的上一级目录里有没有 package.json（= 有没有宿主仓库）
const hostPkg = new URL('../../package.json', import.meta.url);
const hostReallyHere = existsSync(hostPkg);
check(
  'hasHost() 与文件系统事实一致（有宿主仓库就 true，单独拷走就 false）',
  hasHost() === hostReallyHere,
  `hasHost()=${hasHost()} 而 package.json ${hostReallyHere ? '在' : '不在'}`,
);
check(
  'requiresHost 只有那两类外部视角的测试（文档自检 + 宿主端到端）',
  requiresHost.includes('test-docs.mjs') && requiresHost.includes('test-integration.mjs') && requiresHost.length === 2,
  requiresHost.join('、'),
);

const withHost = listTestFiles({ host: true });
const withoutHost = listTestFiles({ host: false });

check('有宿主时全部测试都跑', withHost.length > 20 && withHost.every((name) => name.endsWith('.mjs')), `文件数 ${withHost.length}`);
check('文件清单按名字排序（失败时的输出才好读）', withHost.join(',') === [...withHost].sort().join(','));
check(
  '没有宿主时跳过"要看宿主"的那几个',
  requiresHost.every((name) => withHost.includes(name) && !withoutHost.includes(name)),
  requiresHost.filter((name) => withoutHost.includes(name)).join('、'),
);
check('没有宿主时其余测试一个都不少', withoutHost.length === withHost.length - requiresHost.length, `${withoutHost.length} vs ${withHost.length - requiresHost.length}`);

// 拷走的机器上多半也没有 forum-ai。依赖它的测试必须走**适配器**（src/ai.mjs），
// 而不是直接 import 兄弟目录 —— 直接 import 会在 import 阶段就 ERR_MODULE_NOT_FOUND，
// 连一条断言都跑不到。这里扫源码，把"直接 import forum-ai"钉死为零。
const testsDir = new URL('../tests/', import.meta.url);
const offenders = [];
for (const name of withHost) {
  const source = readFileSync(new URL(name, testsDir), 'utf8');
  const lines = source.split('\n').filter((line) => /^\s*import[\s\S]*?from\s+['"][^'"]*forum-ai/.test(line));
  if (lines.length) offenders.push(`${name}: ${lines[0].trim()}`);
}
check(
  '测试里没有直接 import forum-ai 的（否则拷走就整文件炸掉）',
  offenders.length === 0,
  offenders.join(' | '),
);

// 第二个"拷走就炸"的同款陷阱：`new URL(...).pathname` 会把中文/空格目录名留成 %XX。
// 交付包的目录叫「note-agent-交付包」，于是 `spawn(process.execPath, [url.pathname])`
// 传下去的是 ...%E4%BA%A4%E4%BB%98%E5%8C%85... —— node 直接 MODULE_NOT_FOUND。
// 本仓库里所有"起子进程"的地方都必须走 fileURLToPath()。
const pathnameOffenders = [];
for (const name of withHost) {
  if (name === 'test-run-tests.mjs') continue; // 本文件就是要写出 ".pathname" 这个词来检查别人
  const source = readFileSync(new URL(name, testsDir), 'utf8');
  source.split('\n').forEach((line, i) => {
    const code = line.split('//')[0]; // 注释里提到 .pathname 不算（说明为什么要用 fileURLToPath 的注释）
    if (code.includes('.pathname')) pathnameOffenders.push(`${name}:${i + 1} ${line.trim()}`);
  });
}
check(
  '起子进程的测试用 fileURLToPath 而不是 .pathname（中文目录名会被转义成 %XX）',
  pathnameOffenders.length === 0,
  pathnameOffenders.join(' | '),
);

// 上面那条只是"没人写错"的清点。这里直接验 toLocalPath 本身修好了什么：
// 中文文件名走 .pathname 会变成 %E4%B8%AD...，走 toLocalPath 必须原样解回来。
const probe = new URL('./fixtures/中文样例.md', import.meta.url);
check(
  'toLocalPath 把中文路径解回原文，不留 %XX',
  toLocalPath(probe) === fileURLToPath(probe)
    && !toLocalPath(probe).includes('%')
    && toLocalPath(probe).endsWith('中文样例.md'),
  toLocalPath(probe),
);
check(
  'toLocalPath 与 .pathname 在中文路径上确实不同（这条断言有意义）',
  probe.pathname !== toLocalPath(probe) && probe.pathname.includes('%'),
  probe.pathname,
);

/* ------------------------------------------------------------------ */
/* 汇总口径：退出码与 #RESULT 断言数要对得上                                 */
/* ------------------------------------------------------------------ */
// 真实踩过的坑：`check()` 只设 `process.exitCode`，任何后续覆写（或 promise 里的漏网错误）
// 都会让一个"有失败断言"的文件以退出码 0 收场，而汇总只看退出码 ⇒ 整套报 31/31 全绿。
// 现在 `summary()` 打一行 `#RESULT {...}`，汇总以断言数为准。
check('parseResult 能读懂测试文件报的断言数', (() => {
  const parsed = parseResult('  ✅ a\n  通过 3 项，失败 1 项\n#RESULT {"passed":3,"failed":1,"skipped":0}\n');
  return parsed?.passed === 3 && parsed.failed === 1;
})());
check('parseResult 对没有汇总行的输出返回 null（不能假装全绿）', parseResult('  ✅ a\n') === null);
check('parseResult 对坏 JSON 返回 null', parseResult('#RESULT {oops') === null);
check('run-tests 以断言失败数为准（不是只看退出码）', /reported\.failed > 0/.test(readFileSync(new URL('../scripts/run-tests.mjs', import.meta.url), 'utf8')));

// summary() 真的会打出那行、失败真的会改退出码 —— 起个子进程当场跑一遍，别只信源码里的模板字符串。
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const checkerProbe = spawnSync(process.execPath, ['--input-type=module', '-e',
  "import { createChecker } from './note-agent/tests/helpers/check.mjs';"
  + " const { check, summary } = createChecker(); check('故意失败', false); summary();"],
{ cwd: repoRoot, encoding: 'utf8' });
check('有失败断言时测试文件退出码是 1', checkerProbe.status === 1, `status=${checkerProbe.status}`);
check('失败时也会打出 #RESULT 行', /#RESULT \{"passed":0,"failed":1/.test(checkerProbe.stdout ?? ''), (checkerProbe.stdout ?? '').slice(-160));

summary();
