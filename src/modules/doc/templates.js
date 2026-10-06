// 6 个内置模板（设计文档 §7）。
//
// 模板 = 一段块序列。**刻意不做成"另一套格式"** ——
// 套模板就是一次普通的块序列替换，于是它自动拥有导入/导出、
// markdown 投影、修订快照、回滚这些能力，一样都不用重写。
//
// `props` 里的字段必须都在 `blocks/types.js` 的 schema 里声明过：
// 块是声明式的，没声明的字段在 `coerceProps` 那一步就被丢掉了。
// 唯一一处"活"的数据是 `list.props.source = { kind: 'revisions' }` ——
// 它不存正文，渲染前由 store.js 拿 `document_revisions` 现填（FR-TPL-02）。
//
// **必填字段一律给占位正文，不给空串**：`validateProps` 对「必填字段为空」是按
// `bad_props` 处理的，空串会让一份刚建出来的空白文档满屏「降级」占位卡 ——
// 那是给「坏数据」用的牌子，不该出现在模板上。占位文案与前端
// `public/views/doc-blocks.js` 的 `STARTER_TEXT` 保持同一套口径。

/** 缺省标题，套模板时若不填就用它。 */
export function defaultTitle(templateKey) {
  return TEMPLATES.find((item) => item.key === templateKey)?.title ?? '';
}

/** 「这一篇是 wiki 页」的标记模板（多页面 wiki 与 `/api/docs/wiki/:name` 都靠它）。 */
export const WIKI_TEMPLATE = 'page';

export const TEMPLATES = [
  {
    key: 'blank',
    title: '空白文档',
    description: '一个正文块，从零开始写。',
    blocks: () => [{ type: 'paragraph', props: { text: '写点什么…' } }],
  },
  {
    // Wiki 的**单页**。多页面 wiki = 一堆这个模板建出来的文档，
    // 靠 `wiki` 块（`[[目标]]`）互链；`template: 'page'` 也是「这一篇是 wiki 页」
    // 的标记，`/api/docs/wiki/:name` 就是按它找页的（见 store.js 的 getWikiPage）。
    key: 'page',
    title: 'Wiki 页面',
    description: '一页起头：标题 + 正文 + 相关页面。多页面 wiki 就建多篇。',
    blocks: () => [
      { type: 'heading', props: { text: '开始写这一页', level: 1 } },
      { type: 'paragraph', props: { text: '写点什么…' } },
      { type: 'heading', props: { text: '相关页面', level: 2 } },
      { type: 'wiki', props: { target: '另一页', label: '', note: '' } },
    ],
  },
  {
    key: 'academic',
    title: '学术笔记',
    description: '摘要 → 章节 → 公式 → 代码 → 参考文献。',
    blocks: () => [
      { type: 'heading', props: { text: '标题', level: 1 } },
      { type: 'quote', props: { text: '摘要：一句话说清这篇笔记解决了什么问题。', source: '' } },
      { type: 'heading', props: { text: '一、问题', level: 2 } },
      { type: 'paragraph', props: { text: '背景与要解决的问题。' } },
      { type: 'heading', props: { text: '二、方法', level: 2 } },
      { type: 'formula', props: { text: 'E = mc^2' } },
      { type: 'code', props: { text: '// 在这里写代码', lang: '' } },
      { type: 'heading', props: { text: '三、结论', level: 2 } },
      { type: 'paragraph', props: { text: '结论写在这里。' } },
      { type: 'heading', props: { text: '参考文献', level: 3 } },
      { type: 'list', props: { text: '- ', source: {} } },
    ],
  },
  {
    key: 'wiki',
    title: 'Wiki 词条',
    description: '定义、章节、词条互链，以及自动填充的修订记录。',
    blocks: () => [
      { type: 'heading', props: { text: '词条名', level: 1 } },
      { type: 'quote', props: { text: '一句话定义。', source: '' } },
      { type: 'heading', props: { text: '背景', level: 2 } },
      { type: 'paragraph', props: { text: '这个词条的来龙去脉。' } },
      { type: 'heading', props: { text: '要点', level: 2 } },
      { type: 'list', props: { text: '- \n- ', source: {} } },
      { type: 'heading', props: { text: '相关词条', level: 2 } },
      { type: 'wiki', props: { target: '相关词条', label: '', note: '' } },
      // FR-TPL-02：这张列表不存正文，渲染时从 document_revisions 现取最近 10 条。
      { type: 'heading', props: { text: '修订记录', level: 2 } },
      { type: 'list', props: { text: '', source: { kind: 'revisions', limit: 10 } } },
    ],
  },
  {
    key: 'poll',
    title: '投票问卷',
    description: '说明 → 若干投票 → 结果说明。',
    blocks: () => [
      { type: 'paragraph', props: { text: '说明：这次投票想弄清什么。' } },
      {
        type: 'poll',
        props: {
          question: '问题一',
          options: [
            { id: 'o1', text: '选项 A' },
            { id: 'o2', text: '选项 B' },
          ],
          multiple: false,
        },
      },
      { type: 'heading', props: { text: '结果说明', level: 2 } },
      { type: 'paragraph', props: { text: '结果写在这里。' } },
    ],
  },
  {
    key: 'datatable',
    title: '数据表',
    description: '标题 + 一张表 + 口径说明。',
    blocks: () => [
      { type: 'heading', props: { text: '数据表', level: 1 } },
      { type: 'table', props: { text: '', rows: [['列 1', '列 2'], ['', ''], ['', '']] } },
      { type: 'paragraph', props: { text: '口径：数据从哪里来、什么时候取的。' } },
    ],
  },
  {
    key: 'lab',
    title: '实验记录',
    description: '目的 / 材料 / 步骤 / 观察 / 结论。',
    blocks: () => [
      { type: 'heading', props: { text: '实验记录', level: 1 } },
      { type: 'heading', props: { text: '目的', level: 2 } },
      { type: 'paragraph', props: { text: '要验证什么。' } },
      { type: 'heading', props: { text: '材料', level: 2 } },
      { type: 'list', props: { text: '- ', source: {} } },
      { type: 'heading', props: { text: '步骤', level: 2 } },
      { type: 'list', props: { text: '1. ', source: {} } },
      { type: 'heading', props: { text: '观察', level: 2 } },
      { type: 'table', props: { text: '', rows: [['时间', '现象'], ['', ''], ['', '']] } },
      { type: 'heading', props: { text: '结论', level: 2 } },
      { type: 'paragraph', props: { text: '结论写在这里。' } },
    ],
  },
];

/** 清单（对外只暴露元信息，不暴露生成函数）。 */
export function templateList() {
  return TEMPLATES.map((item) => ({ key: item.key, title: item.title, description: item.description }));
}

/**
 * 取一个模板的块序列（**每次调用都是新对象** —— 模板是共享的，
 * 直接返回函数里那份字面量会让两个文档共用同一批 props）。
 */
export function templateBlocks(key) {
  const template = TEMPLATES.find((item) => item.key === key);
  return template ? structuredClone(template.blocks()) : [];
}

export function hasTemplate(key) {
  return TEMPLATES.some((item) => item.key === key);
}
