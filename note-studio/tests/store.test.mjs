/**
 * store 单元测试：笔记的落盘与读回。
 *
 * 交付承诺是「保存为一个 .md 文件和一个记录基础数据的 .json」，
 * 所以这里重点验证**双写**、两者一致、以及文件名安全。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createNoteStore } from '../src/store.mjs';

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'note-studio-'));
  try {
    await fn(createNoteStore({ dir }), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('save：同时写出 .md 与 .json，并返回两个路径', async () => {
  await withStore(async (store, dir) => {
    const saved = await store.save({ name: '我的 笔记', markdown: '# 标题\n\n正文 $a^2$' });

    assert.equal(saved.name, '我的-笔记');
    assert.equal(saved.mdPath, join(dir, '我的-笔记.md'));
    assert.equal(saved.jsonPath, join(dir, '我的-笔记.json'));

    const md = await readFile(saved.mdPath, 'utf8');
    assert.equal(md, '# 标题\n\n正文 $a^2$');

    const meta = JSON.parse(await readFile(saved.jsonPath, 'utf8'));
    assert.equal(meta.schema, 'note-studio/document@1');
    assert.equal(meta.file.name, '我的-笔记.md');
    assert.equal(meta.title, '标题');
    assert.equal(meta.file.bytes, Buffer.byteLength(md, 'utf8'));
    assert.equal(meta.file.sha256, saved.meta.file.sha256);
  });
});

test('save：json 里的 sha256 与磁盘上的 md 内容一致', async () => {
  await withStore(async (store) => {
    const saved = await store.save({ name: 'n', markdown: '内容 A' });
    const md = await readFile(saved.mdPath, 'utf8');
    const meta = JSON.parse(await readFile(saved.jsonPath, 'utf8'));
    const { hashText } = await import('../src/meta.mjs');
    assert.equal(meta.file.sha256, hashText(md));
  });
});

test('read：读回正文与元数据', async () => {
  await withStore(async (store) => {
    await store.save({ name: 'note', markdown: '# T\n\nbody' });
    const loaded = await store.read('note');
    assert.equal(loaded.name, 'note');
    assert.equal(loaded.markdown, '# T\n\nbody');
    assert.equal(loaded.meta.title, 'T');
  });
});

test('read：不存在的笔记返回 null（不抛错）', async () => {
  await withStore(async (store) => {
    assert.equal(await store.read('不存在'), null);
  });
});

test('read：md 在但 json 缺失时，仍然能读回正文并现场补出元数据', async () => {
  await withStore(async (store, dir) => {
    await writeFile(join(dir, 'bare.md'), '只有正文', 'utf8');
    const loaded = await store.read('bare');
    assert.equal(loaded.markdown, '只有正文');
    assert.equal(loaded.meta.file.baseName, 'bare');
    assert.equal(loaded.metaRecovered, true);
  });
});

test('save：重复保存是覆盖写，不会留下临时文件', async () => {
  await withStore(async (store, dir) => {
    await store.save({ name: 'n', markdown: 'v1' });
    await store.save({ name: 'n', markdown: 'v2' });
    const md = await readFile(join(dir, 'n.md'), 'utf8');
    assert.equal(md, 'v2');

    const { readdir } = await import('node:fs/promises');
    const files = (await readdir(dir)).sort();
    assert.deepEqual(files, ['n.json', 'n.md']);
  });
});

test('list：按更新时间倒序列出笔记', async () => {
  await withStore(async (store) => {
    await store.save({ name: 'a', markdown: '# A' });
    await new Promise((resolve) => setTimeout(resolve, 12));
    await store.save({ name: 'b', markdown: '# B' });
    const list = await store.list();
    assert.deepEqual(list.map((item) => item.name), ['b', 'a']);
    assert.equal(list[0].title, 'B');
    assert.ok(list[0].updatedAt);
  });
});

test('remove：删除成对文件，删不存在的返回 false', async () => {
  await withStore(async (store) => {
    await store.save({ name: 'n', markdown: 'x' });
    assert.equal(await store.remove('n'), true);
    assert.equal(await store.read('n'), null);
    assert.equal(await store.remove('n'), false);
  });
});

test('安全：名字里的路径穿越被切断，写不出目录外', async () => {
  await withStore(async (store, dir) => {
    const saved = await store.save({ name: '../../evil', markdown: 'x' });
    assert.equal(saved.name, 'evil');
    assert.ok(saved.mdPath.startsWith(dir));
  });
});

test('安全：把目录当笔记读时返回 null 而不是抛错', async () => {
  await withStore(async (store, dir) => {
    await mkdir(join(dir, 'sub'), { recursive: true });
    assert.equal(await store.read('sub'), null);
  });
});

test('list：目录不存在时返回空数组', async () => {
  const dir = join(tmpdir(), `note-studio-missing-${Date.now()}`);
  const store = createNoteStore({ dir });
  assert.deepEqual(await store.list(), []);
});

test('save：自定义时间戳与 AI 记录会写进 json', async () => {
  await withStore(async (store) => {
    const saved = await store.save({
      name: 'n',
      markdown: '# T',
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-02T00:00:00.000Z',
      ai: [{ kind: 'both', model: 'vision-x', at: '2026-10-02T00:00:00.000Z' }],
    });
    assert.equal(saved.meta.timestamps.createdAt, '2026-10-01T00:00:00.000Z');
    assert.equal(saved.meta.timestamps.savedAt, '2026-10-02T00:00:00.000Z');
    assert.equal(saved.meta.ai.conversions.length, 1);
  });
});
