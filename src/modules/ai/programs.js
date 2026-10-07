/**
 * 「程序块」的形状纠正器 —— 小应用（app）、脚本（script）、投票（poll）这些
 * **在源码里本来就是一个围栏块**的类型（完整清单见下面的 `FENCED_TYPES`）。
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
 * 第二次事故（线上文档 548 的「让他写投票」）：模型把源码里**本来写得好好的**
 * ```` ```doc:poll {#b2} ```` 抄成了裸的一行 `doc:poll {#b2}` + JSON —— 上下两行
 * 反引号丢了，只留下信息串和 JSON。`{#b2}` 是 P2 的块 id（自己凭空写根本写不出这种
 * 后缀），它恰好证明「模型是在照抄源码、抄漏了围栏」。这次连纠正层都没救回来，两条
 * 原因：① `PROGRAM_TYPES` 里没有 `poll`；② 所有正则都不认识 `{#id}` 后缀。都已修。
 *
 * 这里做三件事，原则都是「模型可以写歪，落地不能歪」：
 *   1. `normalizeProgramProps` —— 把 `{title,html,css,js}` 这类自造形状拼成合法的
 *      `{app,config,code}`；模型漏给 `code` 时用**原块的代码**补上（只想改个应用名，
 *      不该把几千行代码清空），代码超过 20000 字符照样交给校验去报错。
 *   2. `repairMarkdown` / `repairBlock` —— 整篇改写时把裸的 `doc:<类型>` + JSON
 *      补成 P2 认识的围栏（`{#id}` 原样带回去）；单块 / 整节改写时，把「正文里写着
 *      `doc:app` 的那一段」整段换成一块真正的小应用。
 *   3. `normalizePollProps` —— 投票的选项，模型爱写成 `["选项一","选项二"]`，这里
 *      归一成 P2 要的 `[{id, text}]`（2~10 项、每项 ≤80 字）。
 *
 * **这里只修形状，不放松任何一条校验**：`routes.js` 里的 `*Problem` 照旧在跑，
 * 修完还是非法（缺 blockId、超过长度上限、块类型不认识）一样 400 / 502。
 */

/** 认得出形状的两种程序块，与 `src/modules/ai/schema.js` 的 `AI_BLOCK_TYPES` 一致。 */
export const PROGRAM_TYPES = Object.freeze(['app', 'script']);

/**
 * P2 里「在源码中就是一个 ```` ```doc:<类型> ```` 围栏块」的类型 —— 手抄
 * `src/modules/doc/blocks/types.js` 各个 `toMarkdown` 的用法：`poll`(投票)、
 * `embed`、`app`、`subpage`、`fold`、`script`（`sourceBody: 'raw'`，围栏体是原始 JS）。
 * 不在名单里的类型本来就用普通 Markdown 表达、没有围栏（heading / paragraph / code /
 * table / formula / image / quote），`list` 只在 `props.source` 非空时才结构化。
 * **只有这些类型的裸写才值得补围栏** —— 别的 `doc:xxx` 更可能是正文里的一句说明，
 * 补错了就是把人家好好的一段话改成块。
 */
export const FENCED_TYPES = Object.freeze(['poll', 'fold', 'embed', 'app', 'subpage', 'script']);

/**
 * 我们认得出字段形状、可以就地摆正 props 的类型。其余围栏类型只保证「把围栏补回来」，
 * 不动它的字段 —— 不知道 P2 要什么，乱改不如不改。
 */
export const FIXABLE_TYPES = Object.freeze(['app', 'script', 'poll']);

/** 给用户看的人话里的块名。 */
const TYPE_LABELS = Object.freeze({
  app: '小应用',
  script: '脚本',
  poll: '投票',
  fold: '折叠块',
  embed: '嵌入块',
  subpage: '子页面',
});

function labelOf(type) {
  return TYPE_LABELS[type] ?? `doc:${type}`;
}

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
  // 只在 `FIXABLE_TYPES` 里换块：整段正文换成一块 **验证得了形状** 的块才安全。
  // 别的围栏类型（fold / embed / subpage）我们不知道它要什么字段，硬换过去可能换来
  // 一块谁也渲染不出的东西 —— 那一类交给 `repairMarkdown` 只把围栏补回来就好。
  return blob && FIXABLE_TYPES.includes(blob.type) ? blob : null;
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

/**
 * 围栏信息串：`doc:poll` / `doc:poll {#b2}`。
 *
 * `{#b2}` 是 P2 的块 id —— P2 自己认的形态见 `src/modules/doc/blocks/markdown.js` 的
 * `DOC_FENCE_INFO`，而 `blocksToSource` 在把块导成源码时**就会带上它**。模型是从源码
 * 抄的，所以它写出来的信息串天生带 `{#id}`；反引号可以丢，**这一段必须原样带回去**：
 * 票数、评论这些是挂在块 id 上的，id 变了内容就跟丢了。
 */
const FENCE_INFO = /^doc:([A-Za-z0-9_-]+)(?:[ \t]*\{#([A-Za-z0-9_-]+)\})?$/;

function infoOf(type, id) {
  return id ? `doc:${type} {#${id}}` : `doc:${type}`;
}

/** 把一行信息串拆成 `{ type, id }`；不是 `doc:<类型>` 就回 null。 */
function splitInfo(raw) {
  const info = FENCE_INFO.exec(String(raw ?? '').trim());
  return info ? { type: info[1], id: info[2] ?? '' } : null;
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

  if (type === 'poll') return normalizePollProps(props, original);

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
 * 投票（`poll`）的 props 摆正。P2 只认
 * `{ question: string(≤200), options: [{ id, text }] (2~10 项、每项 ≤80 字), multiple: boolean }`。
 * 模型的常见写法是 `"options": ["选项一", "选项二"]`、或者 `{ label }` / 少给 id ——
 * 这里一并归一成 `{id, text}`（id 缺了就发 `o1`、`o2`…，重复的补下划线）。
 * 认不出选项就把原样交回去，让 P2 的校验去报错 —— 好过这里替它编一张假票。
 */
export function normalizePollProps(props, original = null) {
  const notes = [];
  if (!isPlainObject(props)) return { props, notes };

  const raw = Array.isArray(props.options)
    ? props.options
    : Array.isArray(props.choices)
      ? props.choices
      : Array.isArray(props.items)
        ? props.items
        : null;
  if (raw === null) return { props, notes };

  let question = firstString(props, ['question', 'title', '问题']).trim().slice(0, 200);
  if (question === '' && isPlainObject(original)) {
    question = firstString(original, ['question', 'title', '问题']).trim().slice(0, 200);
    if (question !== '') notes.push('投票：模型没给问题，沿用了原来的问题');
  }

  const seen = new Set();
  const options = [];
  let reshaped = false;
  for (const item of raw) {
    if (options.length >= 10) break;
    let text = '';
    let id = '';
    if (typeof item === 'string') {
      text = item;
      reshaped = true;
    } else if (isPlainObject(item)) {
      text = firstString(item, ['text', 'label', 'name', 'value', '内容', '选项']);
      id = firstString(item, ['id', 'key', 'value']);
      if (id === '') reshaped = true;
    } else {
      continue;
    }
    text = String(text ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
    if (text === '') continue;
    let clean = id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
    if (clean === '') clean = `o${options.length + 1}`;
    while (seen.has(clean)) clean = `${clean}_`;
    seen.add(clean);
    options.push({ id: clean, text });
  }

  if (reshaped && options.length > 0) notes.push('投票：选项摆成了本站要的 { id, text } 形状');
  if (options.length !== raw.length) {
    notes.push(`投票：选项从 ${raw.length} 个收敛到 ${options.length} 个（本站上限 10 个、每项 80 字）`);
  }
  if (options.length < 2) notes.push('投票：有效选项不足 2 个，P2 会拒收，得让模型重写一次');

  const multiple = props.multiple === true || props.multiple === 'true';
  const dropped = extraKeys(props, ['question', 'options', 'multiple', 'title', 'choices', 'items']);
  if (dropped.length > 0) notes.push(`投票：丢掉了本站没有的字段 ${dropped.join(' / ')}`);

  return { props: { question, options, multiple }, notes };
}

/**
 * ```` ```doc:app ```` 围栏体 / 裸的 `doc:app` 加 JSON，解析成块；认不出返回 null。
 * `script` 的围栏体是**原始代码**（P2 的 `sourceBody: 'raw'`），不是 JSON。
 */
export function parseProgramBlob(text) {
  const body = String(text ?? '').trim();
  const fenced = /^(`{3,})([^\r\n]+)\r?\n([\s\S]*?)\r?\n\1[ \t]*$/.exec(body);
  if (fenced) {
    const info = splitInfo(fenced[2]);
    if (info) return blobFrom(info.type, fenced[3], info.id);
  }
  const lines = body.split(/\r?\n/);
  const head = splitInfo(lines[0]);
  if (head) return blobFrom(head.type, lines.slice(1).join('\n'), head.id);
  return null;
}

function blobFrom(type, body, id = '') {
  const blobId = typeof id === 'string' ? id : '';
  if (type === 'script') {
    const code = String(body).trim();
    return code === '' ? null : { type: 'script', props: { code }, id: blobId };
  }
  const props = parseJsonObject(body);
  return props ? { type, props, id: blobId } : null;
}

/**
 * 单块纠正：`{ type, props }` 进、`{ value, notes }` 出。
 * 两种情形：① 本来就是程序块，只是字段名自造；② 正文里写着 `doc:app` + JSON。
 */
export function repairBlock(value, original = null) {
  const notes = [];
  if (!isPlainObject(value)) return { value, notes };

  if (FIXABLE_TYPES.includes(value.type)) {
    const { props, notes: inner } = normalizeProgramProps(value.type, value.props, original);
    return { value: { ...value, props }, notes: inner };
  }

  const blob = blobInTextBlock(value);
  if (!blob) return { value, notes };

  const { props, notes: inner } = normalizeProgramProps(blob.type, blob.props, original);
  return {
    // blockId 留着：一节里必须**整节收齐、id 一一对应**，只换类型不换 id。
    value: { ...(typeof value.blockId === 'string' ? { blockId: value.blockId } : {}), type: blob.type, props },
    notes: [...inner, `正文里写着 doc:${blob.type}${blob.id ? ` {#${blob.id}}` : ''}，整段换成了${labelOf(blob.type)}块`],
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
 *   ① 围栏块 ```` ```doc:poll {#b2} ```` 里字段是自造的 → 就地改成合法 props（`{#id}` 留着）；
 *   ② 裸的 `doc:<类型>`（可以带 `{#id}`）+ JSON（模型最常漏的那一步）→ 补成围栏块。
 * 本来就没问题的文本一个字不动（`notes` 为空时返回原文）。
 */
export function repairMarkdown(markdown, { maxBareLines = 200 } = {}) {
  const notes = [];
  let text = typeof markdown === 'string' ? markdown : '';
  if (text === '' || !text.includes('doc:')) return { value: text, notes };

  text = text.replace(/(`{3,})([^\r\n]+)\r?\n([\s\S]*?)\r?\n\1[ \t]*/g, (whole, fence, rawInfo, body) => {
    const info = splitInfo(rawInfo);
    if (!info || !FIXABLE_TYPES.includes(info.type)) return whole;
    const parsed = parseJsonObject(body);
    if (!parsed) return whole;
    const { props, notes: inner } = normalizeProgramProps(info.type, parsed);
    if (inner.length === 0) return whole;
    notes.push(...inner);
    const json = JSON.stringify(props, null, 2);
    const ticks = fenceFor(json);
    return `${ticks}${infoOf(info.type, info.id)}\n${json}\n${ticks}`;
  });

  text = wrapBareBlobs(text, notes, maxBareLines);
  return { value: text, notes };
}

/**
 * 裸的 `doc:<类型>`（可带 `{#id}`）+ JSON → 围栏块。识别不出 JSON 就原样放过
 * （宁可不改，也不改坏）。
 *
 * **围栏里的 `doc:` 行一个字不动**：整篇文档本身可能就是一篇「怎么写围栏块」的教程，
 * 里面的示例正长这样。不设这道守卫，模型抄过来的教程会被我们改得面目全非。
 */
function wrapBareBlobs(text, notes, maxBareLines) {
  const lines = text.split('\n');
  const out = [];
  let openFence = '';
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fence = /^[ \t]*(`{3,})[ \t]*(.*)$/.exec(line.replace(/\r$/, ''));
    if (fence) {
      const marks = fence[1];
      if (openFence === '') openFence = marks;
      else if (fence[2].trim() === '' && marks.length >= openFence.length) openFence = '';
      out.push(line);
      continue;
    }
    if (openFence !== '') {
      out.push(line);
      continue;
    }
    const head = splitInfo(line);
    if (!head || !FENCED_TYPES.includes(head.type)) {
      out.push(line);
      continue;
    }
    const { type, id } = head;
    let body = '';
    let end = -1;
    for (let j = i + 1; j < lines.length && j <= i + maxBareLines; j += 1) {
      const next = lines[j].replace(/\r$/, '');
      if (body === '' && next.trim() === '') break;
      body += (body === '' ? '' : '\n') + next;
      if (parseJsonObject(body)) {
        end = j;
        break;
      }
    }
    const parsed = end === -1 ? null : parseJsonObject(body);
    if (!parsed) {
      // 头认出来了、后面却不是 JSON：说清楚「这块没救回来」，让作者重来一次 ——
      // 默默放过就会变成 548 那样：一整段 JSON 被当成正文打印出来。
      if (/^\s*[{[]/.test(lines[i + 1] ?? '')) {
        notes.push(
          `${infoOf(type, id)} 那一段没能补上围栏（紧跟着的内容不是合法 JSON），这块${labelOf(type)}得让模型重写一次`,
        );
      }
      out.push(line);
      continue;
    }
    const { props, notes: inner } = normalizeProgramProps(type, parsed);
    const json = JSON.stringify(props, null, 2);
    const ticks = fenceFor(json);
    out.push(`${ticks}${infoOf(type, id)}`, json, ticks);
    notes.push(`裸写的 ${infoOf(type, id)} 补上了围栏（不补的话 P2 只会把它当成普通正文）`);
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
