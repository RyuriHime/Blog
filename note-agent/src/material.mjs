/**
 * 材料装配：把抽取出来的块数组压成能塞进模型上下文的文本，并组装多模态消息。
 *
 * 两条硬要求：
 *   1. **按块整块丢弃** —— 绝不允许把一块代码/表格截断成半个。模型看到半截代码
 *      会编出下半截，比看不到更糟。所以超预算时按优先级整块丢，并从最后往前丢。
 *   2. **结构段与标题优先保留** —— 大纲是模型理解全文骨架的唯一线索，丢了它
 *      整理出来的标题和层级就会散架。
 */
import { countBlocks } from './blocks.mjs';
import { unwrapFormula } from './formulas.mjs';

export const DEFAULT_CHAR_BUDGET = 24000;

/** 图片上限：超过这个字节数就不发给模型（多模态按 base64 计费，太大也超时）。 */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** 每次请求最多带几张图。 */
export const MAX_IMAGES = 6;

/**
 * 丢弃优先级：越靠前越先被丢。heading 放最后 —— 丢了标题，大纲与 section 也就没意义了。
 */
const DROP_PRIORITY = ['paragraph', 'table', 'code', 'list', 'image', 'formula', 'heading'];

export function estimateChars(text) {
  return String(text ?? '').length;
}

/** 把 heading 层级画成缩进大纲。 */
function outlineLines(structure) {
  const headings = structure?.headings ?? [];
  if (headings.length === 0) return [];
  const lines = ['## 材料结构'];
  for (const heading of headings) {
    const level = Number.isFinite(heading.level) ? Math.max(1, heading.level) : 1;
    lines.push(`${'  '.repeat(level - 1)}- ${heading.text}`);
  }
  return lines;
}

/** heading 的层级可能落在顶层 `level` 或 `meta.level` 上（抽取器与模型的两种写法都见过）。 */
function headingLevel(block) {
  const raw = Number.isFinite(block.level) ? block.level : block.meta?.level;
  return Number.isFinite(raw) ? raw : 1;
}

/** 单个块渲染成一行/一段正文，末尾不带换行。 */
function renderBlock(block) {
  const id = `[${block.id}]`;
  switch (block.type) {
    case 'heading': {
      const hashes = '#'.repeat(Math.min(6, Math.max(1, headingLevel(block))));
      return `${id} ${hashes} ${block.text}`;
    }
    case 'code': {
      const lang = block.meta?.lang ?? '';
      return `${id} \`\`\`${lang}\n${block.text}\n\`\`\``;
    }
    case 'table':
      return `${id}\n${block.text}`;
    case 'formula':
      // 先剥掉模型可能带上的定界符，再包一层：否则材料里会出现 `$$\n$$\n…`，
      // 模型会照抄，最终草稿的显示公式全废（真机验收踩到过）。
      return `${id} $$\n${unwrapFormula(block.text)}\n$$`;
    case 'image': {
      const alt = block.text || '图片';
      const src = block.meta?.src ?? '';
      return `${id} ![${alt}](${src})`;
    }
    case 'list':
    case 'paragraph':
    default:
      return `${id} ${block.text}`;
  }
}

/**
 * 组装材料文本。超预算时整块丢弃。
 *
 * @param {Array<object>} blocks
 * @param {Array<{blockId:string,name:string,dataUrl:string,mime?:string,bytes?:number}>} assets
 * @param {{charBudget?:number, structure?:object|null}} options
 * @returns {{text:string, usedBlocks:Array<object>, droppedBlocks:string[], chars:number, images:Array<object>}}
 */
export function buildMaterial(blocks, assets = [], { charBudget = DEFAULT_CHAR_BUDGET, structure = null } = {}) {
  const list = Array.isArray(blocks) ? blocks : [];
  const budget = Number.isFinite(charBudget) && charBudget > 0 ? charBudget : DEFAULT_CHAR_BUDGET;

  // 图片：按 blockId 数字升序，跳过超大图，最多 MAX_IMAGES 张
  const sorted = (Array.isArray(assets) ? assets : [])
    .filter((asset) => asset && typeof asset.dataUrl === 'string' && asset.dataUrl.length > 0)
    .slice()
    .sort((a, b) => blockOrder(a.blockId) - blockOrder(b.blockId));
  const images = [];
  const imageNotes = [];
  for (const asset of sorted) {
    const bytes = Number.isFinite(asset.bytes) ? asset.bytes : 0;
    if (bytes > MAX_IMAGE_BYTES) {
      imageNotes.push(`[图片 ${asset.name ?? asset.blockId} 超过 2MB 未发送]`);
      continue;
    }
    if (images.length >= MAX_IMAGES) continue;
    images.push({ blockId: asset.blockId, name: asset.name, dataUrl: asset.dataUrl, mime: asset.mime ?? 'image/png', bytes });
  }

  const outline = outlineLines(structure);
  const used = new Set(list.map((block) => block.id));
  const droppedBlocks = [];
  let text = assemble(list, used, outline, imageNotes);

  if (estimateChars(text) > budget) {
    // 逐优先级丢：同一优先级里从最后往前丢
    for (const type of DROP_PRIORITY) {
      const candidates = list.filter((block) => block.type === type && used.has(block.id));
      for (let index = candidates.length - 1; index >= 0; index -= 1) {
        if (estimateChars(text) <= budget) break;
        used.delete(candidates[index].id);
        droppedBlocks.push(candidates[index].id);
        text = assemble(list, used, outline, imageNotes);
      }
      if (estimateChars(text) <= budget) break;
    }
    // 优先级全丢完还超（结构段本身太长）：保持现状，交给上层提示词说明
  }

  const usedBlocks = list.filter((block) => used.has(block.id));
  return { text, usedBlocks, droppedBlocks, chars: estimateChars(text), images };
}

function assemble(list, used, outline, imageNotes) {
  const body = list.filter((block) => used.has(block.id)).map(renderBlock);
  const sections = [];
  if (outline.length > 0) sections.push(outline.join('\n'));
  sections.push(['## 材料正文', ...body].join('\n\n'));
  const text = sections.join('\n\n');
  return imageNotes.length === 0 ? text : `${text}\n\n${imageNotes.join('\n')}`;
}

/**
 * 块 id 的排序号。
 *
 * 正文块是 `b1`/`b2`，图片是 `img1`/`img2`（两种编号各自从 1 开始，别在同一段里
 * 直接比大小）。这里只取"字母前缀后面的那串数字"当作序，所以图片之间、块之间
 * 都按数字升序；跨种类比较没有意义，但排序稳定。
 */
function blockOrder(blockId) {
  const match = /[a-z]+(\d+)/i.exec(String(blockId ?? ''));
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

/**
 * 组装给模型的两条消息。
 *
 * 无图片时 user.content 是**纯字符串**（与 forum-ai 既有调用形状一致，
 * 不做多模态时不要平白引入数组形状）；有图片才切成多模态数组。
 *
 * @param {{system:string, material:string, draft?:string, requirement?:string, images?:Array<object>}} input
 * @returns {Array<{role:string, content:string|Array<object>}>}
 */
export function buildMessages({ system, material, draft = '', requirement = '', images = [] } = {}) {
  const imageList = Array.isArray(images) ? images : [];
  const parts = ['## 参考材料', String(material ?? '')];

  if (String(draft ?? '').length > 0) {
    parts.push('## 当前草稿', String(draft));
  }
  if (String(requirement ?? '').length > 0) {
    parts.push('## 用户最新要求', String(requirement));
  }
  if (imageList.length > 0) {
    const lines = ['## 材料中的图片'];
    imageList.forEach((image, index) => {
      lines.push(`[图 ${index + 1} 对应 ${image.blockId}] ${image.name ?? ''}`.trim());
    });
    parts.push(lines.join('\n'));
  }

  const text = parts.join('\n\n');
  const userContent = imageList.length === 0
    ? text
    : [
      { type: 'text', text },
      ...imageList.map((image) => ({ type: 'image_url', image_url: { url: image.dataUrl } })),
    ];

  return [
    { role: 'system', content: String(system ?? '') },
    { role: 'user', content: userContent },
  ];
}
