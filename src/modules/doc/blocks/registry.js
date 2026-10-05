// 块类型注册表：内置 12 种 ∪ 运行时注册 ∪ `doc_block_types` 表里的行。
//
// FR-BLOCK-04 要的是「不改核心代码就能注册新块类型」，所以这里有一张可写的注册表；
// 但内置类型是**冻结契约**，表里的同名行不许把它顶掉（反过来才允许：
// 数据库里的类型版本落后于内置，以内置为准）。
import { BLOCK_TYPE_PATTERN } from '../schema.js';
import { BUILTIN_TYPES } from './types.js';
import { escapeHtml } from './text.js';
import { sandboxInner } from '../sandbox.js';

const REGISTRY = new Map();
const FROM_DATABASE = new Set();

for (const type of BUILTIN_TYPES) REGISTRY.set(type.name, type);

/**
 * 注册块类型**登录用户就能做**，而模板 HTML 会出现在每个访客的页面上 ——
 * 这里必须自己关上门。剥掉的是「会执行、会加载、会外联」的构造：
 * 脚本、内联事件、`javascript:` 地址、会自己发请求或改文档元信息的标签。
 * 剩下的标签原样保留（模板作者要正当地排版）。
 */
export function sanitizeTemplate(html) {
  return String(html)
    .replace(/<\s*script\b[\s\S]*?<\s*\/\s*script\s*>/gi, '')
    .replace(/<\s*\/?\s*(script|iframe|object|embed|link|meta|base|form|frame|frameset)\b[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript\s*:/gi, '');
}

/** 取自定义类型的渲染模板（`renderer_json` 的 `html` 字段）；没有就是空串。 */
export function customTemplate(type) {
  if (typeof type?.renderer_json !== 'string' || type.renderer_json.trim() === '') return '';
  try {
    const parsed = JSON.parse(type.renderer_json);
    return typeof parsed?.html === 'string' ? parsed.html : '';
  } catch {
    return '';
  }
}

/**
 * 把 `{{字段}}` 换成 props 里的值。**一律转义** ——
 * 模板本身是用户写的，值也是用户写的，两个都不许变成脚本。
 */
export function renderTemplate(template, props) {
  return sanitizeTemplate(template).replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_match, key) => {
    const value = props?.[key];
    if (value === null || value === undefined) return '';
    return escapeHtml(typeof value === 'object' ? JSON.stringify(value) : String(value));
  });
}

/**
 * 声明式类型没有渲染函数，就用这个通用的渲染：
 * 注册时给了模板就用模板，没给就退回「字段名 → 值」的表。
 * `renderer_kind === 'sandbox'` 的类型和内置的 `app` 走同一条玻璃房。
 */
function genericHtml(type, props, block, options) {
  const id = escapeHtml(block?.block_id ?? '');
  const name = escapeHtml(type.name);
  if (type.renderer_kind === 'sandbox') {
    const inner = sandboxInner(props ?? {}, block ?? {}, { ...(options ?? {}), label: type.label ?? name });
    return `<div class="doc-block doc-block-${name}" data-block-id="${id}" data-block-type="${name}">${inner}</div>`;
  }
  const template = customTemplate(type);
  const inner = template
    ? `<div class="doc-block-tpl">${renderTemplate(template, props ?? {})}</div>`
    : `<dl class="doc-block-fields">${Object.entries(props ?? {})
        .map(([key, value]) => {
          const text = value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
          return `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(text)}</dd>`;
        })
        .join('')}</dl>`;
  return `<div class="doc-block doc-block-${name}" data-block-id="${id}" data-block-type="${name}">${inner}</div>`;
}

function genericMarkdown(type, props) {
  const json = JSON.stringify(props, null, 2);
  let ticks = 3;
  while (json.includes('`'.repeat(ticks))) ticks += 1;
  const fence = '`'.repeat(ticks);
  return `${fence}doc:${type.name}\n${json}\n${fence}`;
}

function genericPlain(type, props) {
  return Object.values(props)
    .filter((value) => typeof value === 'string' && value.trim() !== '')
    .join('\n');
}

/** 把一个（可能来自数据库的）定义规范成注册表里的形状；不合法就抛。 */
function normalize(def, origin) {
  if (!def || typeof def !== 'object') throw new TypeError('块类型定义必须是一个对象');
  const name = String(def.name ?? '');
  if (!BLOCK_TYPE_PATTERN.test(name)) {
    throw new TypeError(`块类型名不合法（要求小写字母开头，只含小写字母 / 数字 / 下划线，最长 32）：${name}`);
  }
  const version = Number(def.version);
  const type = {
    name,
    version: Number.isFinite(version) && version > 0 ? Math.floor(version) : 1,
    label: String(def.label ?? name),
    icon: String(def.icon ?? '▢'),
    editor: String(def.editor ?? 'text'),
    schema: def.schema && typeof def.schema === 'object' && !Array.isArray(def.schema) ? def.schema : {},
    renderer_kind: def.renderer_kind === 'sandbox' ? 'sandbox' : 'declarative',
    renderer_json: typeof def.renderer_json === 'string' ? def.renderer_json : '',
    origin,
  };
  type.toMarkdown = typeof def.toMarkdown === 'function' ? def.toMarkdown : (props) => genericMarkdown(type, props);
  type.toPlain = typeof def.toPlain === 'function' ? def.toPlain : (props) => genericPlain(type, props);
  type.toHtml = typeof def.toHtml === 'function' ? def.toHtml : (props, block, options) => genericHtml(type, props, block, options);
  return type;
}

/** 全部块类型，按「内置在前、注册在后」的插入顺序。 */
export function listBlockTypes() {
  return [...REGISTRY.values()];
}

/** 按名字取一个块类型；没注册过返回 null（调用方负责降级，不是抛异常）。 */
export function getBlockType(name) {
  return REGISTRY.get(String(name ?? '')) ?? null;
}

/**
 * 注册一个块类型。
 *
 * 内置类型不许被覆盖（它们是与 note-agent 对拍的冻结契约），
 * 数据库来的类型也不许顶掉内置 —— 但同名重注册是**幂等**的，方便 `loadBlockTypes` 反复跑。
 */
export function registerBlockType(def, { origin = 'runtime', allowBuiltin = false } = {}) {
  const type = normalize(def, origin);
  if (REGISTRY.has(type.name) && !FROM_DATABASE.has(type.name) && !allowBuiltin) {
    throw new TypeError(`块类型「${type.name}」已经存在，内置类型不可覆盖`);
  }
  REGISTRY.set(type.name, type);
  return type;
}

/** 从 `doc_block_types` 表把用户注册的类型装进来。返回装载数量。 */
export function loadBlockTypes(db) {
  if (!db || typeof db.prepare !== 'function') return 0;
  let rows = [];
  try {
    rows = db
      .prepare('SELECT name, version, label, icon, props_schema_json, renderer_kind, renderer_json FROM doc_block_types')
      .all();
  } catch {
    // 表还没建（或者数据库是只读的旧库）——注册表退回内置 12 种，不是错误。
    return 0;
  }
  let loaded = 0;
  for (const row of rows ?? []) {
    const name = String(row?.name ?? '');
    if (!BLOCK_TYPE_PATTERN.test(name)) continue;
    // 内置类型优先：表里的行永远不覆盖内置。
    if (REGISTRY.has(name) && !FROM_DATABASE.has(name)) continue;
    let schema = {};
    try {
      const parsed = JSON.parse(String(row?.props_schema_json ?? '{}'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) schema = parsed;
    } catch {
      schema = {};
    }
    REGISTRY.set(
      name,
      normalize(
        {
          name,
          version: row?.version,
          label: row?.label,
          icon: row?.icon,
          schema,
          renderer_kind: row?.renderer_kind,
          renderer_json: row?.renderer_json,
        },
        'database',
      ),
    );
    FROM_DATABASE.add(name);
    loaded += 1;
  }
  return loaded;
}

/** 测试与「热卸载」用：把数据库来的类型全部撤掉，回到内置 12 种。 */
export function resetDatabaseTypes() {
  for (const name of FROM_DATABASE) REGISTRY.delete(name);
  FROM_DATABASE.clear();
}

export { BUILTIN_TYPES };
