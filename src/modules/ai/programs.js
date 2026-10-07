/**
 * 「程序块」的形状纠正器 —— 小应用（app）与脚本（script）。
 *
 * 为什么要有这个文件（真实事故）：
 * 线上那篇文档里，「小恐龙游戏」最后变成了正文里的一大段 JSON 文字。模型知道
 * 本站有 ```` ```doc:<类型> ```` 这种围栏，于是学着写了 `doc:app`，但围栏没写、
 * 字段名全按它自己的习惯来：
 *
 *     doc:app
 *     {"title":"小恐龙","html":"…","css":"…","js":"…"}
 *
 * 而本站的小应用块（P2 `src/modules/doc/blocks/types.js:349` 的 `app`）只有
 * `{ app, config, code }` 三个字段，代码全部在 `code` 里，**没有** `title` /
 * `html` / `css` / `js`；并且只有写成围栏块才会被解析成块 —— 裸文本会被
 * `src/modules/doc/blocks/markdown.js` 当成普通正文（现在默认并成 `prose` 块）。
 * 两处一起错，结果就是一段谁也跑不起来的文字。
 *
 * 这里做两件事，原则都是「模型可以写歪，落地不能歪」：
 *   1. `normalizeProgramProps` —— 把 `{title,html,css,js}` 这类自造形状拼成合法的
 *      `{app,config,code}`；模型漏给 `code` 时用**原块的代码**补上（只想改个应用名，
 *      不该把几千行代码清空），代码超过 20000 字符照样交给校验去报错。
 *   2. `repairMarkdown` / `repairBlock` —— 整篇改写时把裸的 `doc:<类型>` + JSON
 *      补成 P2 认识的围栏；单块 / 整节改写时，把「正文里写着 `doc:app` 的那一段」
 *      整段换成一块真正的小应用。
 *
 * **这里只修形状，不放松任何一条校验**：`routes.js` 里的 `*Problem` 照旧在跑，
 * 修完还是非法（缺 blockId、超过长度上限、块类型不认识）一样 400 / 502。
 */

/** 认得出形状的两种程序块，与 `src/modules/ai/schema.js` 的 `AI_BLOCK_TYPES` 一致。 */
export const PROGRAM_TYPES = Object.freeze(['app', 'script']);

/** 与 P2 的 `MAX_APP_CODE` / `MAX_SCRIPT_CODE` 同值，只用来写提示与注释。 */
export const PROGRAM_MAX_CODE = 20000;

/** 模型爱用的「应用名」字段。本站只有 `app`，其余都是它自己发明的。 */
const NAME_FIELDS = Object.freeze(['app', 'name', 'title', '应用名', '应用名称']);
/** 模型爱把代码拆成三份。本站只有 `code`。 */
const STYLE_FIELDS = Object.freeze(['css', 'style', 'styles', 'stylesheet', 'CSS']);
const MARKUP_FIELDS = Object.freeze(['html', 'markup', 'body', 'HTML']);
const SCRIPT_FIELDS = Object.freeze(['js', 'javascript', 'script', 'JavaScript', 'JS']);
const CODE_FIELDS = Object.freeze(['code', 'source', 'content']);

/**
 * 正文里写着 `doc:app` 的块 —— **不按类型白名单判断**，只看 props 里有没有那段文本。
 * 理由是线上真事的教训：那次出问题的块是「正文」类，而正文类的名字本身一直在动
 * （`paragraph` → 现在默认并成 `prose`「小节正文」，站点还可以在数据库里注册自定义
 * 正文类型）。按类型名写死白名单，正好会把要做的那一种漏掉；按「props.text 是不是
 * 一段 `doc:<类型>` + JSON」判断，内置的 paragraph / code / prose 和任何自定义正文
 * 类型都覆盖得到，而且只有真的认出来是程序块才会动手，认不出就原样放过。
 */
function blobInTextBlock(value) {
  const text = isPlainObject(value.props) ? value.props.text : '';
  if (typeof text !== 'string' || !text.includes('doc:')) return null;
  const blob = parseProgramBlob(text);
  return blob && PROGRAM_TYPES.includes(blob.type) ? blob : null;
}

/**
 * 围栏长度：与 P2 的 `src/modules/doc/blocks/text.js:72` `fenceFor` 逐字同样的算法
 * —— 取「正文里没出现过的最短围栏」，至少三个反引号。
 * 不能 import：`scripts/check-skeleton.mjs:189` 明令业务模块之间不许互相 import。
 * `scripts/ai-smoke.mjs` 有一条哨兵把两个实现对着跑，漂移就红。
 */
export function fenceFor(text) {
  const body = String(text ?? '');
  let ticks = 3;
  while (body.includes('`'.repeat(ticks))) ticks += 1;
  return '`'.repeat(ticks);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function firstString(source, fields) {
  if (!isPlainObject(source)) return '';
  for (const field of fields) {
    const value = source[field];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return '';
}

function extraKeys(source, keep) {
  if (!isPlainObject(source)) return [];
  return Object.keys(source).filter((key) => !keep.includes(key));
}

function parseJsonObject(text) {
  try {
    const value = JSON.parse(String(text).trim());
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

/** 把模型拆开的 css / html / js 拼成本站唯一认识的那一大块 `code`。 */
function assembleCode(props) {
  const parts = [];
  const style = firstString(props, STYLE_FIELDS);
  if (style !== '') parts.push(/<style[\s>]/i.test(style) ? style : `<style>\n${style}\n</style>`);
  const markup = firstString(props, MARKUP_FIELDS);
  if (markup !== '') parts.push(markup);
  const script = firstString(props, SCRIPT_FIELDS);
  if (script !== '') parts.push(/<script[\s>]/i.test(script) ? script : `<script>\n${script}\n</script>`);
  return parts.join('\n\n');
}

/**
 * 把程序块的 props 纠正成本站的形状。返回 `{ props, notes }`，`notes` 是给用户看的人话。
 * `original` 是改动前的同一块（可选）：模型漏给代码时用它兜底，避免「改个名字清空代码」。
 */
export function normalizeProgramProps(type, props, original = null) {
  const notes = [];
  if (!isPlainObject(props)) return { props, notes };

  if (type === 'script') {
    let code = firstString(props, [...CODE_FIELDS, ...SCRIPT_FIELDS]);
    if (code === '' && isPlainObject(original)) {
      const kept = firstString(original, [...CODE_FIELDS, ...SCRIPT_FIELDS]);
      if (kept !== '') {
        code = kept;
        notes.push('脚本：模型没给 code，沿用了原来的代码');
      }
    }
    const dropped = extraKeys(props, ['code']);
    if (dropped.length > 0) notes.push(`脚本：丢掉了本站没有的字段 ${dropped.join(' / ')}`);
    return { props: { code }, notes };
  }

  if (type !== 'app') return { props, notes };

  let app = firstString(props, NAME_FIELDS).slice(0, 40);
  if (app === '' && isPlainObject(original)) app = firstString(original, NAME_FIELDS).slice(0, 40);

  let code = typeof props.code === 'string' ? props.code : '';
  if (code.trim() === '') {
    const assembled = assembleCode(props);
    if (assembled.trim() !== '') {
      code = assembled;
      notes.push('小应用：把模型拆开的 html / css / js 拼成了 code');
    }
  }
  if (code.trim() === '' && isPlainObject(original)) {
    const kept =
      typeof original.code === 'string' && original.code.trim() !== '' ? original.code : assembleCode(original);
    if (kept.trim() !== '') {
      code = kept;
      notes.push('小应用：模型没给代码，沿用了原来的 code');
    }
  }

  const config = isPlainObject(props.config) ? props.config : {};
  const dropped = extraKeys(props, ['app', 'config', 'code']);
  if (dropped.length > 0) notes.push(`小应用：丢掉了本站没有的字段 ${dropped.join(' / ')}`);
  if (code.trim() === '' && notes.length === 0) notes.push('小应用：模型没有给出任何代码，这块小应用是空的');

  return { props: { app, config, code }, notes };
}

/**
 * ```` ```doc:app ```` 围栏体 / 裸的 `doc:app` 加 JSON，解析成块；认不出返回 null。
 * `script` 的围栏体是**原始代码**（P2 的 `sourceBody: 'raw'`），不是 JSON。
 */
export function parseProgramBlob(text) {
  const body = String(text ?? '').trim();
  const fenced = /^(`{3,})doc:([a-z0-9_-]+)[ \t]*\r?\n([\s\S]*?)\r?\n\1[ \t]*$/.exec(body);
  if (fenced) return blobFrom(fenced[2], fenced[3]);
  const bare = /^doc:([a-z0-9_-]+)[ \t]*\r?\n([\s\S]+)$/.exec(body);
  if (bare) return blobFrom(bare[1], bare[2]);
  return null;
}

function blobFrom(type, body) {
  if (type === 'script') {
    const code = String(body).trim();
    return code === '' ? null : { type: 'script', props: { code } };
  }
  const props = parseJsonObject(body);
  return props ? { type, props } : null;
}

/**
 * 单块纠正：`{ type, props }` 进、`{ value, notes }` 出。
 * 两种情形：① 本来就是程序块，只是字段名自造；② 正文里写着 `doc:app` + JSON。
 */
export function repairBlock(value, original = null) {
  const notes = [];
  if (!isPlainObject(value)) return { value, notes };

  if (PROGRAM_TYPES.includes(value.type)) {
    const { props, notes: inner } = normalizeProgramProps(value.type, value.props, original);
    return { value: { ...value, props }, notes: inner };
  }

  const blob = blobInTextBlock(value);
  if (!blob) return { value, notes };

  const { props, notes: inner } = normalizeProgramProps(blob.type, blob.props, original);
  const label = blob.type === 'app' ? '小应用' : '脚本';
  return {
    // blockId 留着：一节里必须**整节收齐、id 一一对应**，只换类型不换 id。
    value: { ...(typeof value.blockId === 'string' ? { blockId: value.blockId } : {}), type: blob.type, props },
    notes: [...inner, `正文里写着 doc:${blob.type}，整段换成了${label}块`],
  };
}

/**
 * 整节纠正。`originalList` 是**改动前**的那一节，用来给「模型漏给代码」兜底。
 */
export function repairBlockList(list, originalList = []) {
  const notes = [];
  if (!Array.isArray(list)) return { value: list, notes };
  const originals = new Map();
  for (const item of Array.isArray(originalList) ? originalList : []) {
    if (isPlainObject(item) && typeof item.blockId === 'string') originals.set(item.blockId, item);
  }
  const value = list.map((item) => {
    const original = isPlainObject(item) && typeof item.blockId === 'string' ? originals.get(item.blockId) ?? null : null;
    const { value: fixed, notes: inner } = repairBlock(item, original);
    for (const note of inner) notes.push(note);
    return fixed;
  });
  return { value, notes };
}

/**
 * 整篇 Markdown 纠正：
 *   ① 围栏块 ```` ```doc:app ```` 里字段是自造的 → 就地改成合法 props；
 *   ② 裸的 `doc:<类型>` + JSON（模型最常漏的那一步）→ 补成围栏块。
 * 本来就没问题的文本一个字不动（`notes` 为空时返回原文）。
 */
export function repairMarkdown(markdown, { maxBareLines = 200 } = {}) {
  const notes = [];
  let text = typeof markdown === 'string' ? markdown : '';
  if (text === '' || !text.includes('doc:')) return { value: text, notes };

  text = text.replace(/(`{3,})doc:([a-z0-9_-]+)[ \t]*\r?\n([\s\S]*?)\r?\n\1[ \t]*/g, (whole, fence, type, body) => {
    if (!PROGRAM_TYPES.includes(type)) return whole;
    const parsed = parseJsonObject(body);
    if (!parsed) return whole;
    const { props, notes: inner } = normalizeProgramProps(type, parsed);
    if (inner.length === 0) return whole;
    notes.push(...inner);
    const json = JSON.stringify(props, null, 2);
    const ticks = fenceFor(json);
    return `${ticks}doc:${type}\n${json}\n${ticks}`;
  });

  text = wrapBareBlobs(text, notes, maxBareLines);
  return { value: text, notes };
}

/** 裸的 `doc:<类型>` + JSON → 围栏块。识别不出 JSON 就原样放过（宁可不改，也不改坏）。 */
function wrapBareBlobs(text, notes, maxBareLines) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const head = /^[ \t]*doc:([a-z0-9_-]+)[ \t]*\r?$/.exec(lines[i]);
    if (!head) {
      out.push(lines[i]);
      continue;
    }
    const type = head[1];
    let body = '';
    let end = -1;
    for (let j = i + 1; j < lines.length && j <= i + maxBareLines; j += 1) {
      const line = lines[j].replace(/\r$/, '');
      if (body === '' && line.trim() === '') break;
      body += (body === '' ? '' : '\n') + line;
      if (parseJsonObject(body)) {
        end = j;
        break;
      }
    }
    const parsed = end === -1 ? null : parseJsonObject(body);
    if (!parsed) {
      out.push(lines[i]);
      continue;
    }
    const { props, notes: inner } = normalizeProgramProps(type, parsed);
    const json = JSON.stringify(props, null, 2);
    const ticks = fenceFor(json);
    out.push(`${ticks}doc:${type}`, json, ticks);
    notes.push(`裸写的 doc:${type} 补上了围栏（不补的话 P2 只会把它当成普通正文）`);
    notes.push(...inner);
    i = end;
  }
  return out.join('\n');
}

/** 把 `notes` 拼成一句给用户看的人话；没有改动返回空串。 */
export function describeRepairs(notes) {
  const unique = [...new Set((Array.isArray(notes) ? notes : []).filter((item) => typeof item === 'string' && item !== ''))];
  return unique.join('；');
}
