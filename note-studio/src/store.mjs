/**
 * store —— 笔记的落盘层。
 *
 * 交付承诺：一篇笔记 = **一个 `.md` 文件 + 一个记录基础数据的 `.json` 文件**。
 * 因此这里只有文件读写，没有数据库、没有 AI、没有 HTTP。
 *
 * 设计要点：
 *   - 双写且原子：先写临时文件再 rename，避免半个文件；
 *   - 文件名一律经 slugifyFilename 消毒，写不出目标目录之外；
 *   - `.json` 丢了也能降级：现场从 `.md` 重新算出元数据（metaRecovered 标记）。
 */
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { analyzeDocument, slugifyFilename } from './meta.mjs';

/**
 * @param {{ dir: string, now?: () => string }} options
 */
export function createNoteStore({ dir, now = () => new Date().toISOString() } = {}) {
  if (!dir) throw new Error('createNoteStore 需要 dir（笔记目录）');

  const paths = (name) => {
    const base = slugifyFilename(name);
    return { name: base, mdPath: join(dir, `${base}.md`), jsonPath: join(dir, `${base}.json`) };
  };

  async function readTextFile(path) {
    try {
      return await readFile(path, 'utf8');
    } catch {
      return null;
    }
  }

  /** 原子写：临时文件 → rename。 */
  async function writeAtomic(path, content) {
    const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    await writeFile(tmp, content, 'utf8');
    try {
      await rename(tmp, path);
    } catch (error) {
      await unlink(tmp).catch(() => {});
      throw error;
    }
  }

  return {
    dir,
    paths,

    /**
     * 保存一篇笔记：写 `.md` 与 `.json`。
     * @param {{ name?: string, markdown?: string, createdAt?: string|null,
     *           updatedAt?: string|null, savedAt?: string|null, ai?: Array<object> }} input
     */
    async save({ name = 'note', markdown = '', createdAt = null, updatedAt = null, savedAt = null, ai = [] } = {}) {
      const target = paths(name);
      const text = String(markdown ?? '');
      const stamp = now();
      const meta = analyzeDocument(text, {
        filename: target.name,
        createdAt: createdAt ?? stamp,
        updatedAt: updatedAt ?? stamp,
        savedAt: savedAt ?? updatedAt ?? stamp,
        ai,
      });

      await mkdir(dir, { recursive: true });
      // 先写 .md 再写 .json：即使 .json 写失败，正文也不会丢
      await writeAtomic(target.mdPath, text);
      await writeAtomic(target.jsonPath, `${JSON.stringify(meta, null, 2)}\n`);

      return { name: target.name, mdPath: target.mdPath, jsonPath: target.jsonPath, meta };
    },

    /**
     * 读取一篇笔记；不存在（或不是文件）返回 null。
     * @returns {Promise<{ name: string, markdown: string, meta: object,
     *                     mdPath: string, jsonPath: string, metaRecovered: boolean }|null>}
     */
    async read(name) {
      const target = paths(name);
      const markdown = await readTextFile(target.mdPath);
      if (markdown === null) return null;

      const rawJson = await readTextFile(target.jsonPath);
      let meta = null;
      if (rawJson) {
        try {
          meta = JSON.parse(rawJson);
        } catch {
          meta = null;
        }
      }
      const metaRecovered = meta === null;
      if (metaRecovered) {
        meta = analyzeDocument(markdown, { filename: target.name, savedAt: null });
      }

      return { name: target.name, markdown, meta, mdPath: target.mdPath, jsonPath: target.jsonPath, metaRecovered };
    },

    /** 列出全部笔记，按文件更新时间倒序。目录不存在时返回空数组。 */
    async list() {
      let entries = [];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return [];
      }

      const notes = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
        const name = entry.name.replace(/\.md$/i, '');
        const mdPath = join(dir, entry.name);
        const jsonPath = join(dir, `${name}.json`);
        let info;
        try {
          info = await stat(mdPath);
        } catch {
          continue;
        }

        let meta = null;
        const rawJson = await readTextFile(jsonPath);
        if (rawJson) {
          try {
            meta = JSON.parse(rawJson);
          } catch {
            meta = null;
          }
        }

        notes.push({
          name,
          title: meta?.title || '',
          updatedAt: (meta?.timestamps?.savedAt || null) ?? info.mtime.toISOString(),
          mtimeMs: info.mtimeMs,
          bytes: info.size,
          mdPath,
          jsonPath,
        });
      }

      return notes
        .sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name))
        .map(({ mtimeMs, ...rest }) => rest);
    },

    /** 删除一对文件；正文不存在时返回 false。 */
    async remove(name) {
      const target = paths(name);
      try {
        await unlink(target.mdPath);
      } catch {
        return false;
      }
      await unlink(target.jsonPath).catch(() => {});
      return true;
    },
  };
}
