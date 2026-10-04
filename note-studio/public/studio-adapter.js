/**
 * studio-adapter.js —— 把 note-studio 的 `window.NoteStudio` 翻译成 note-agent 的
 * 「编辑器适配器」契约（v1，见 note-agent/EDITOR-CONTRACT.md）。
 *
 * 面板（/notes-panel.js）不认识任何具体编辑器，它只调 getDoc / setDoc / onChange
 * 这三个方法 —— 所以这里一行都不用碰面板的代码。
 *
 * studio.js 是个闭合的 IIFE，出口在 window.NoteStudio 上（见 studio.js 末尾那一节）。
 * 这个文件由 index.html 末尾的 `<script type="module">` 引入。
 */

// 面板自己就带了一个「从 Markdown 里扫图片」的工具，图片那块直接复用它。
import { imagesFromMarkdown } from '/notes-panel.js';

export function noteStudioAdapter(studio = globalThis.NoteStudio) {
  if (!studio || typeof studio.getMarkdown !== 'function') {
    throw new Error('studio-adapter：window.NoteStudio 还没挂出来（studio.js 没加载完？）');
  }

  // 面板与审校都按**源文本**工作，所以这里读到的 $…$ 与 ![]() 都必须是没渲染过的原样文本。
  const read = () => ({
    title: studio.getTitle(),
    markdown: studio.getMarkdown(),
  });

  return {
    getDoc: read,

    // 契约要求「只改传进来的字段」：没给 title 就别动标题。
    setDoc({ title, markdown, mode = 'replace' } = {}) {
      if (typeof title === 'string' && title.length > 0) studio.setTitle(title);
      if (typeof markdown === 'string') studio.setMarkdown(markdown, mode);
    },

    // studio.subscribe() 返回的取消函数已经是幂等的，直接转交。
    onChange(callback) {
      return studio.subscribe(() => callback(read()));
    },

    // 可选方法。笔记里的图片就是普通 Markdown 语法，src 本来就能直接取，
    // 所以 buildImageUrl 原样返回。
    getImages() {
      return imagesFromMarkdown(read().markdown);
    },
    buildImageUrl(src) {
      return src;
    },
  };
}

export default noteStudioAdapter;
