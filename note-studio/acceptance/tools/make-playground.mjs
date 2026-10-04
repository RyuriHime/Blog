/**
 * 生成操作样例的数据文件 public/playground-data.js。
 *
 * 只生成**数据**，不生成任何代码：页面外壳（playground.html）与应用逻辑（playground.js）
 * 都是手写文件，各自只有一层转义，不会出现「模板字符串里再嵌 JS 字符串」那类转义坑。
 *
 * 什么时候要重跑：换了 acceptance/sample/ 下的样例笔记或样例照片之后。
 *   node acceptance/tools/make-playground.mjs
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(HERE, '..', '..');
const SAMPLE_MD = join(ROOT, 'acceptance', 'sample', 'sample-note.md');
const SAMPLE_PNG = join(ROOT, 'acceptance', 'sample', 'sample-note-photo.png');
const OUT = join(ROOT, 'public', 'playground-data.js');

const markdown = await readFile(SAMPLE_MD, 'utf8');
const png = await readFile(SAMPLE_PNG);

const payload = {
  markdown,
  photo: `data:image/png;base64,${png.toString('base64')}`,
  source: {
    markdown: 'acceptance/sample/sample-note.md',
    photo: 'acceptance/sample/sample-note-photo.png',
  },
};

const body = [
  '/* 由 acceptance/tools/make-playground.mjs 生成，不要手改。',
  ' * 样例笔记与样例照片内嵌在这里，所以操作台在离线（file://）下也能直接用。',
  ' */',
  `window.PLAYGROUND_DATA = ${JSON.stringify(payload, null, 2)};`,
  '',
].join('\n');

await writeFile(OUT, body, 'utf8');
console.log(`已生成 ${OUT} (${(body.length / 1024).toFixed(1)} KB，含内嵌照片 ${(png.length / 1024).toFixed(1)} KB)`);
