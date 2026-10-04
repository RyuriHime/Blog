/**
 * meta 单元测试：文档基础数据（.json）的计算。
 *
 * 先写测试（红），再实现（绿）——TDD。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  GENERATOR,
  SCHEMA,
  slugifyFilename,
  countWords,
  hashText,
  analyzeDocument,
} from '../src/meta.mjs';

/* ------------------------------------------------------------------ */
/* slugifyFilename                                                     */
/* ------------------------------------------------------------------ */

test('slugifyFilename：保留中文，空格变连字符，去掉扩展名', () => {
  assert.equal(slugifyFilename('我的 笔记.md'), '我的-笔记');
  assert.equal(slugifyFilename('Linear Algebra Notes'), 'Linear-Algebra-Notes');
});

test('slugifyFilename：切断路径，杜绝路径穿越', () => {
  assert.equal(slugifyFilename('../../etc/passwd'), 'passwd');
  assert.equal(slugifyFilename('a/b\\c.md'), 'c');
  assert.equal(slugifyFilename('..'), 'note');
  assert.equal(slugifyFilename('   '), 'note');
  assert.equal(slugifyFilename(''), 'note');
  assert.equal(slugifyFilename(null), 'note');
});

test('slugifyFilename：清洗 Windows 保留字符与保留名', () => {
  assert.equal(slugifyFilename('a<b>c:d"e|f?g*h.md'), 'a-b-c-d-e-f-g-h');
  assert.equal(slugifyFilename('CON.md'), '_CON');
  assert.equal(slugifyFilename('nul'), '_nul');
});

test('slugifyFilename：长度有上限', () => {
  const long = 'x'.repeat(300);
  assert.ok(slugifyFilename(long).length <= 80);
});

/* ------------------------------------------------------------------ */
/* countWords                                                          */
/* ------------------------------------------------------------------ */

test('countWords：中英文分别计数', () => {
  const result = countWords('Hello world, 你好世界');
  assert.equal(result.latinWords, 2);
  assert.equal(result.cjkCharacters, 4);
  assert.equal(result.words, 6);
});

test('countWords：空文本与纯标点', () => {
  assert.deepEqual(countWords(''), { words: 0, latinWords: 0, cjkCharacters: 0 });
  assert.equal(countWords('！？。，').words, 0);
});

test('countWords：带数字的拉丁词算一个词', () => {
  assert.equal(countWords('node22 sqlite3').latinWords, 2);
});

/* ------------------------------------------------------------------ */
/* hashText                                                            */
/* ------------------------------------------------------------------ */

test('hashText：稳定且区分内容', () => {
  const a = hashText('abc');
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, hashText('abc'));
  assert.notEqual(a, hashText('abd'));
  assert.equal(hashText(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

/* ------------------------------------------------------------------ */
/* analyzeDocument                                                     */
/* ------------------------------------------------------------------ */

const SAMPLE = `# 标题一

这是第一段，包含行内公式 $E = mc^2$ 与 **粗体**。

$$
\\int_0^1 x\\,dx = \\frac{1}{2}
$$

## 二级标题

- [ ] 待办一
- [x] 待办二

\`\`\`js
const a = 1;
const b = 2;
\`\`\`

| A | B |
| --- | --- |
| 1 | 2 |

![图](img.png)

[链接](https://example.com)
`;

test('analyzeDocument：标题与大纲', () => {
  const meta = analyzeDocument(SAMPLE);
  assert.equal(meta.title, '标题一');
  assert.equal(meta.structure.headings.length, 2);
  assert.deepEqual(
    meta.structure.headings.map((heading) => [heading.level, heading.text]),
    [[1, '标题一'], [2, '二级标题']],
  );
  assert.equal(meta.structure.headings[0].line, 1);
  assert.equal(meta.structure.maxDepth, 2);
  // 大纲：一个一级节点，其下挂一个二级节点
  assert.equal(meta.structure.outline.length, 1);
  assert.equal(meta.structure.outline[0].children.length, 1);
  assert.equal(meta.structure.outline[0].children[0].text, '二级标题');
});

test('analyzeDocument：行内与块级公式分别计数，不重复计', () => {
  const meta = analyzeDocument(SAMPLE);
  assert.equal(meta.math.inline, 1);
  assert.equal(meta.math.display, 1);
  assert.equal(meta.math.total, 2);
  assert.deepEqual(meta.math.expressions.map((item) => item.type), ['inline', 'display']);
  assert.equal(meta.math.expressions[0].tex, 'E = mc^2');
  assert.match(meta.math.expressions[1].tex, /\\int_0\^1/);
});

test('analyzeDocument：图片与链接分开统计，图片不算链接', () => {
  const meta = analyzeDocument(SAMPLE);
  assert.equal(meta.media.images.length, 1);
  assert.equal(meta.media.images[0].url, 'img.png');
  assert.equal(meta.media.images[0].alt, '图');
  assert.equal(meta.media.links.length, 1);
  assert.equal(meta.media.links[0].url, 'https://example.com');
});

test('analyzeDocument：代码块、表格、任务清单', () => {
  const meta = analyzeDocument(SAMPLE);
  assert.equal(meta.code.fences, 1);
  assert.equal(meta.code.blocks[0].language, 'js');
  assert.equal(meta.code.blocks[0].lines, 2);
  assert.equal(meta.tables, 1);
  assert.deepEqual(meta.tasks, { total: 2, checked: 1, unchecked: 2 - 1 });
});

test('analyzeDocument：代码块里的 # 不算标题，$ 不算公式', () => {
  const markdown = ['```sh', '# 这不是标题', 'echo $HOME', '```'].join('\n');
  const meta = analyzeDocument(markdown);
  assert.equal(meta.structure.headings.length, 0);
  assert.equal(meta.title, '');
  assert.equal(meta.math.total, 0);
  assert.equal(meta.code.fences, 1);
});

test('analyzeDocument：文件基础数据与时间戳', () => {
  const meta = analyzeDocument(SAMPLE, {
    filename: '我的 笔记.md',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
    savedAt: '2026-10-02T01:00:00.000Z',
  });
  assert.equal(meta.schema, SCHEMA);
  assert.deepEqual(meta.generator, GENERATOR);
  assert.equal(meta.file.name, '我的-笔记.md');
  assert.equal(meta.file.baseName, '我的-笔记');
  assert.equal(meta.file.extension, '.md');
  assert.equal(meta.file.bytes, Buffer.byteLength(SAMPLE, 'utf8'));
  assert.equal(meta.file.sha256, hashText(SAMPLE));
  assert.equal(meta.file.mimeType, 'text/markdown; charset=utf-8');
  assert.equal(meta.timestamps.createdAt, '2026-10-01T00:00:00.000Z');
  assert.equal(meta.timestamps.savedAt, '2026-10-02T01:00:00.000Z');
});

test('analyzeDocument：统计口径与阅读时长下限', () => {
  const meta = analyzeDocument('a b c\n\n第二段', { filename: 'n' });
  assert.equal(meta.stats.paragraphs, 2);
  assert.equal(meta.stats.nonEmptyLines, 2);
  assert.ok(meta.stats.readingMinutes >= 1);
  assert.equal(meta.stats.latinWords, 3);
  assert.equal(meta.stats.cjkCharacters, 3);
});

test('analyzeDocument：残留的 AI 转写记录会带进 json', () => {
  const meta = analyzeDocument('# t', {
    filename: 'n',
    ai: [{ kind: 'both', model: 'vision-x', at: '2026-10-02T00:00:00.000Z', source: 'photo.jpg' }],
  });
  assert.equal(meta.ai.conversions.length, 1);
  assert.equal(meta.ai.conversions[0].model, 'vision-x');
});

test('analyzeDocument：空文档也不报错', () => {
  const meta = analyzeDocument('', { filename: 'empty' });
  assert.equal(meta.title, '');
  assert.equal(meta.stats.characters, 0);
  assert.equal(meta.file.bytes, 0);
  assert.equal(meta.math.total, 0);
  assert.deepEqual(meta.structure.outline, []);
});
