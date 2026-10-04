# 编辑器适配器契约（v1）

AI 笔记整理面板（`client/notes-panel.mjs`）不直接认识任何编辑器。
它只通过下面这张表跟编辑区打交道 —— 这就是"换编辑器时不用改面板"的原因。

契约版本：`contractVersion = '1'`。
面板与文档里所有 `v1` 的说法都指这一版。

---

## 1. 方法表

### 必填（3 个）

| 方法 | 签名 | 说明 |
| --- | --- | --- |
| `getDoc()` | `→ { title?: string, markdown: string }` | 读取当前编辑区的标题与正文。`markdown` 必须是面板能原样写回的文本（含公式、图片语法的源文本）。 |
| `setDoc({ title?, markdown?, mode? })` | `mode: 'replace' \| 'append'`，默认 `'replace'`；`→ void` | 把整理结果写回编辑区。**只改传进来的字段**：没传 `title` 就不要动标题。 |
| `onChange(cb)` | `cb(doc) → unsubscribe: () => void` | 注册变更监听。返回的取消函数必须幂等、可重复调用。 |

### 可选（3 个）

| 方法 | 签名 | 说明 |
| --- | --- | --- |
| `getImages()` | `→ Array<{ src: string, alt?: string, mime?: string, dataUrl?: string, blockHint?: string }>` | 编辑区里**已有**的图片。面板会把它们连同材料一起递给模型，用于生成图片说明、判断图文是否一致。不实现就等于"这个编辑器没有图片"。 |
| `buildImageUrl(src, mime?)` | `→ string` | 把 `getImages()` 里的 `src` 变成模型能取的 URL。若编辑器存的是相对路径/附件 id，在这里解析成绝对或站内路径；返回 `data:image/...;base64,...` 也可以。默认实现是原样返回。 |
| `scrollTo(blockId)` / `insertText(text)` | `→ void` | 让面板能把用户送到某一块、或在光标处插入文本。不实现时面板会静默跳过这两个动作。 |

**关于 `src` 的约定**：`getImages()` 返回的 `src` 是什么形式由编辑器决定，面板不做假设；
唯一的要求是 `buildImageUrl(src)` 能把同一个 `src` 变成一个模型可访问的 URL。
两者必须成对：只实现 `getImages()` 而不实现 `buildImageUrl()` 时，面板按"`src` 已经可用"处理。

**关于 `onChange` 的调用时机**：面板只用它来刷新按钮可用状态，**不用它同步草稿内容**。
因此即便编辑器在每次按键都触发 `onChange`，也不会有额外请求。

---

## 2. `attach()` 参数

```js
window.NotesAgent.attach({
  mount,                              // 必填：面板的宿主容器（通常在编辑表单内部）
  editor,                             // 必填：符合上表的适配器
  apiBase: '/api/notes',              // 可选：后端前缀
  api: window.NotesAgent.defaultApi,  // 可选：自定义请求函数（测试用）
  postId: null,                       // 可选：当前帖子 id，用来复用同一篇的工作台
  debounceMs: 400,                    // 可选：编辑区防抖，决定面板多久知道你在写什么
  hostBase: '/api',                   // 可选：宿主接口前缀（预览渲染复用宿主 /markdown/preview）
  stylesheet: '/notes-panel.css',     // 可选：面板样式表地址（挂载层默认就发这个）
});
// → { ready, settle(), flush(), refresh(), setOpen(open), getState(), destroy() }
```

面板的**所有** DOM 都建在 `mount` 内部，绝不查询或改写 `mount` 之外的节点
（唯一的例外是往 `document.head` 认领那一条样式表 `<link>`）。
`destroy()` 会移除自己的节点与监听，宿主可以在切换视图时放心调用。

面板往 `mount` 里放**两个**节点：抽屉本体（`.notes-panel.notes-drawer`）与收起时留在屏幕
右边缘的竖标签（`.notes-drawer-tab`）。后者必须是抽屉的**兄弟**节点 —— 抽屉收起是整块
`transform` 平移出屏，而它带 `overflow:hidden`，绝对定位的子元素会被一起裁掉。

**关于挂载点的 `notes-mount` 类**：面板样式全部收在 `.notes-mount` 下
（`.notes-mount > .notes-drawer-tab` 之类），这样宿主任何泛化选择器 ——
比如 `input[type="text"], textarea { … }`，它的优先级比单类选择器高 —— 都改不动面板，
面板在哪个站点都长一样。`attach()` 会在挂载点没有这个类时**自己补上**、
`destroy()` 时再摘掉（宿主本来就有就不动），所以你写不写都不会退化成裸块；
写上更好，因为样式生效早一步。

**关于实例上的其它类名**：面板只认自己那两个根类（`.notes-panel.notes-drawer` /
`.notes-drawer-tab`）与 `.notes-mount`，其余 `.notes-*` 都是它内部节点。
宿主给挂载点或抽屉外加类名不会影响面板，但**不要**用后代选择器去改 `.notes-mount` 里的
`.notes-*` —— 面板的规则是收过作用域的，你的规则会跟它打架。

## 2.1 换一个编辑器要动哪几处（三类改动，都在宿主侧）

1. **一个容器**：在写作页表单里加 `<div id="notesMount" class="notes-mount"></div>`
   （`class="notes-mount"` 可省，`attach()` 会自己补；样式全部收在这个类下面）。
2. **一个脚本标签**：`<script type="module" src="/notes-panel.js"></script>`
   （这就是 `client/notes-panel.mjs`，由挂载层发出来；**不要**让浏览器去 import `src/index.mjs`，
   那会拉进 `node:sqlite`）。
3. **一个适配器 + 一次 attach**：

```js
import { attach } from '/notes-panel.js';
const handle = attach({ mount, editor: myAdapter(editorRoot), postId: post?.id ?? null });
// 切换视图/卸载时：handle.destroy()
```

适配器按第 1 节的表实现即可；面板本身一行都不用改。若新编辑器自带虚拟 DOM，
**不要**把 `mount` 放进会被整体重建的子树里。

**手机端也不用适配**：面板自带 ≤1080px 默认收起、≤480px 铺满整屏的断点，
并在窄屏补了三条逃生通道（右上角 `›`、Esc、点抽屉外面）与 ≥44px 的触控尺寸、`env(safe-area-inset-*)`。
宿主唯一要知道的是：面板展开时会往 `document.body` 上挂一个 `notes-drawer-open` 类
（渲染抽屉的宿主可以用它给正文留宽度；不用也没关系），`destroy()` 时会摘掉。

---

## 3. 完整适配器示例（≤20 行）

现有编辑区就是 `#title` + `#content` 两个表单元素，所以自带适配器只有这么长
（`client/notes-panel.mjs` 里的 `createTextareaAdapter` 是它的完整版）：

```js
function myAdapter(root) {
  const titleEl = root.querySelector('#title');
  const contentEl = root.querySelector('#content');
  return {
    getDoc: () => ({ title: titleEl.value, markdown: contentEl.value }),
    setDoc({ title, markdown, mode = 'replace' } = {}) {
      if (typeof title === 'string') titleEl.value = title;
      if (typeof markdown === 'string') {
        contentEl.value = mode === 'append' ? contentEl.value + markdown : markdown;
      }
      contentEl.dispatchEvent(new Event('input', { bubbles: true }));
    },
    onChange(cb) {
      const bound = () => cb(this.getDoc());
      contentEl.addEventListener('input', bound);
      return () => contentEl.removeEventListener('input', bound);
    },
  };
}
```

未来的 Markdown/LaTeX 所见即所得编辑器接进来时，把它自己的 `getValue()/setValue()/on('change')`
映射成上面这三个方法即可 —— 面板一行都不用改。

---

## 4. 接入检查清单

新编辑器接入时逐条确认：

1. `getDoc()` 返回的 `markdown` 里，**公式与图片都保持源文本**（`$…$`、`![alt](src)`），
   不要返回渲染后的 HTML —— 面板与审校都按源文本工作。
2. `setDoc()` 后编辑器内部模型与 DOM **都已更新**，并且派发了一次变更事件
   （否则宿主自己的预览/自动保存不会跟着走）。
3. `onChange()` 返回的取消函数可重复调用，`destroy()` 之后不再触发回调。
4. 若编辑器支持图片：`getImages()` 与 `buildImageUrl()` 成对实现，且 `dataUrl` 里
   **单张图不超过 2MB**（超过的会被服务端跳过并在结果里给一条警告）。
5. 面板只往 `mount` 里写 DOM；若你的编辑器用虚拟 DOM 重渲染整个区域，
   请**不要**把 `mount` 放进会被重建的子树，否则面板会被连带清掉。
6. 手机上不用做额外的事：窄屏（≤1080px）面板默认收起、≤480px 铺满整屏，
   逃生通道（Esc / 点抽屉外面 / 竖标签）与 ≥44px 触控尺寸都在面板自己的样式表里。
   只需要保证页面有 `<meta name="viewport" content="width=device-width, initial-scale=1">`
   —— **没有它浏览器的布局视口会是 980px**，抽屉会被算成"够宽"而默认展开、
   还跑到视口外面去（交付包的演示页就这么翻过一辆车）。
