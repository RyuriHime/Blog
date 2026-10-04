/**
 * 集成自检（根目录版论坛，**没有 forum-ai**）：验证 AI 缺席时优雅降级。
 *
 * 期望：编辑器、保存 .md/.json、列表、删除全部正常；AI 接口返回 503 ai_not_configured
 * （而不是 500，也不会因为找不到 forum-ai 导致论坛启动失败）。
 *
 * 运行：
 *   node tests/browser/verify-root-forum.mjs
 *   FORUM_ENTRY=/path/to/forum/src/server.js node tests/browser/verify-root-forum.mjs
 */
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { runForumIntegrationChecks } from './integration-checks.mjs';

const WORK = fileURLToPath(new URL('../../../', import.meta.url));
const FORUM_ENTRY = process.env.FORUM_ENTRY || join(WORK, 'src', 'server.js');

const { checks } = await runForumIntegrationChecks({
  forumEntry: FORUM_ENTRY,
  noteStudioEntry: join(WORK, 'note-studio', 'src', 'index.mjs'),
  port: Number(process.env.PORT || 3013),
  expectForumAi: false,
});

for (const item of checks) console.log(`${item.ok ? '✔' : '✘'} ${item.name}${item.extra ? `  (${item.extra})` : ''}`);
const failed = checks.filter((item) => !item.ok).length;
console.log('');
console.log(failed ? `FAIL：${failed} 项未通过` : `PASS：${checks.length} 项集成检查全部通过`);
process.exit(failed ? 1 : 0);
