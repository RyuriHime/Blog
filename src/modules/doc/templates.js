// 8 个内置模板（设计文档 §7）。
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

/** 「这一篇是 wiki 站」的标记模板（一个帖子一个 wiki：站本身是一篇普通帖子）。 */
export const STATION_TEMPLATE = 'station';

/**
 * 「这一篇是站务公告」的标记模板。
 *
 * 帖子功能下线后，站务公告从「meta 板块的帖子」搬进积木 —— 一条公告 = 一篇
 * 带这个模板的文档。它有三个和普通积木不同的地方，都在别处实现：
 *   1. **只有站长和管理员能建、能改**（`visibility.js` 的 `canEdit`、
 *      `store.js` 的 `createDocument`）；
 *   2. **不进积木广场**（`queries.js` 的 `listDocuments` 对非 staff 直接排除）；
 *   3. **首页起始页要读它**（`GET /api/docs?template=announce&sort=created`）。
 * 它刻意**不出现在模板清单**里（`staffOnly`），普通用户没有地方能挑到它。
 */
export const ANNOUNCE_TEMPLATE = 'announce';

export const TEMPLATES = [
  {
    key: 'blank',
    title: '空白文档',
    description: '一个正文块，从零开始写。',
    blocks: () => [{ type: 'paragraph', props: { text: '写点什么…' } }],
  },
  {
    // **一个帖子一个 wiki（第二轮）**：站本身是一篇普通文档（kind=post），照旧有影子帖、
    // 照旧出现在「积木」板块里 —— 这就是「一个帖子一个 wiki」的字面意思。
    // 站里的每一页仍是**独立文档**（template='page'），但不生成影子帖，
    // 只通过一个 `subpage` 块挂进这个站的正文里（见 store.js 的 stationPages）。
    // 模板里刻意**不放** subpage 块：站刚建出来时一页都没有，
    // 放一块空的 subpage 只会渲染成一张坏卡片；页是「新建页面」时服务端追加的。
    key: 'station',
    title: 'Wiki 站',
    description: '一个站一篇帖子：说明 + 目录，每一页以积木块挂进来。',
    blocks: () => [
      { type: 'heading', props: { text: '站名', level: 1 } },
      { type: 'paragraph', props: { text: '这个 wiki 站是干什么的、怎么读。' } },
      { type: 'heading', props: { text: '目录', level: 2 } },
    ],
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
    // 站务公告（见上面 ANNOUNCE_TEMPLATE 的注释）。`staffOnly` 让它不出现在
    // 模板清单里 —— 建它的唯一入口是首页/公告页上那颗只有 staff 看得见的「写公告」。
    key: ANNOUNCE_TEMPLATE,
    title: '站务公告',
    description: '只有站长和管理员能写；首页会显示最近几条。',
    staffOnly: true,
    blocks: () => [
      { type: 'heading', props: { text: '公告', level: 1 } },
      { type: 'paragraph', props: { text: '正文。' } },
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

/** 清单（对外只暴露元信息，不暴露生成函数）。staffOnly 的模板不上清单。 */
export function templateList() {
  return TEMPLATES.filter((item) => !item.staffOnly)
    .map((item) => ({ key: item.key, title: item.title, description: item.description }));
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
