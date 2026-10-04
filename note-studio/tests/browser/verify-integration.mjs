/**
 * 集成自检（AI 版论坛）：真实 HTTP、真实落盘、真实登录态。
 * 检查逻辑在 integration-checks.mjs（验收脚本复用同一份）。
 *
 * 运行：
 *   node tests/browser/verify-integration.mjs
 *   FORUM_ENTRY=/path/to/forum/src/server.js node tests/browser/verify-integration.mjs
 */
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { runForumIntegrationChecks } from './integration-checks.mjs';

const WORK = fileURLToPath(new URL('../../../', import.meta.url));
const FORUM_ENTRY = process.env.FORUM_ENTRY || join(WORK, '.inspect', 'forum-ai-full', 'forum', 'src', 'server.js');

const { checks } = await runForumIntegrationChecks({
  forumEntry: FORUM_ENTRY,
  noteStudioEntry: join(WORK, 'note-studio', 'src', 'index.mjs'),
  port: Number(process.env.PORT || 3012),
  expectForumAi: true,
});

for (const item of checks) console.log(`${item.ok ? '✔' : '✘'} ${item.name}${item.extra ? `  (${item.extra})` : ''}`);
const failed = checks.filter((item) => !item.ok).length;
console.log('');
console.log(failed ? `FAIL：${failed} 项未通过` : `PASS：${checks.length} 项集成检查全部通过`);
process.exit(failed ? 1 : 0);
