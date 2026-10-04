/**
 * `examples/server.mjs` 这个"最小独立服务"必须真的能起、能用。
 *
 * 它是交付包的门面：同事拿到文件夹后第一条命令就是它。这里盯三件事：
 *   1. 起得来（挂载层插在宿主的 request 监听链前面）；
 *   2. `/api/markdown/preview` 有（面板的「效果」预览靠它，缺了演示页就只剩原文）；
 *   3. 面板需要的三份静态资源都能取到（脚本 / 样式 / 渲染兜底）。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createChecker, toLocalPath } from './helpers/check.mjs';

const { check, skip, summary } = createChecker();

const SERVER = new URL('../examples/server.mjs', import.meta.url);
if (!existsSync(SERVER)) {
  skip('examples/server.mjs 存在', '这份包不完整');
  summary();
} else {
  const port = 3491;
  const base = `http://127.0.0.1:${port}`;
  // toLocalPath 而不是 `.pathname`：中文/空格目录名会被留成 %XX，node 收到就 MODULE_NOT_FOUND。
  const proc = spawn(process.execPath, [toLocalPath(SERVER)], {
    env: { ...process.env, NOTES_DEMO_PORT: String(port), NOTES_DEMO_HOST: '127.0.0.1', AI_API_KEY: 'sk-not-used', NOTES_DEMO_DB: ':memory:' },
    stdio: 'ignore',
  });
  let log = '';
  proc.stdout?.on('data', (chunk) => { log += chunk; });

  /** 等端口可用（最多 10 秒）。 */
  async function waitUp() {
    for (let i = 0; i < 50; i += 1) {
      try {
        const res = await fetch(`${base}/api/notes/status`);
        if (res.ok) return true;
      } catch {
        // 还没起来
      }
      await new Promise((r) => { setTimeout(r, 200); });
    }
    return false;
  }

  const up = await waitUp();
  check('样例服务起得来', up, log.trim().slice(0, 200));

  if (up) {
    const status = await (await fetch(`${base}/api/notes/status`)).json();
    check('样例服务的 /api/notes/status 正常', status.ok === true && typeof status.data.model === 'string');

    const preview = await fetch(`${base}/api/markdown/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '# 标题\n\n正文一段。\n\n- 甲\n- 乙' }),
    });
    const previewBody = await preview.json();
    check('样例服务带 /api/markdown/preview（面板的效果预览靠它）', preview.status === 200 && previewBody.ok === true, `status=${preview.status}`);
    check('渲染结果真的是 HTML（不是原文）', String(previewBody.data?.html ?? '').includes('<h1>标题</h1>') && String(previewBody.data?.html ?? '').includes('<li>甲</li>'), String(previewBody.data?.html ?? '').slice(0, 120));

    const badPreview = await fetch(`${base}/api/markdown/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'not json' });
    check('渲染接口对非法 JSON 返回 400 而不是崩', badPreview.status === 400);

    const cases = [
      ['/notes-panel.js', 'javascript', '面板脚本'],
      ['/notes-panel.css', 'text/css', '面板样式'],
      ['/notes-markdown.js', 'javascript', '渲染兜底模块'],
      ['/', 'text/html', '演示页'],
    ];
    for (const [path, type, what] of cases) {
      const res = await fetch(base + path);
      const text = await res.text();
      check(`样例服务能取到${what}（${path}）`, res.status === 200 && String(res.headers.get('content-type')).includes(type) && text.length > 200, `status=${res.status} len=${text.length}`);
    }

    const renderer = await (await fetch(`${base}/notes-markdown.js`)).text();
    check('发给浏览器的渲染模块零 Node 依赖', !renderer.includes("from 'node:") && !renderer.includes('require('));
  }

  proc.kill();
  summary();
}
