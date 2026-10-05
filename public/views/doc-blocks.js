// 积木编辑器的「零件层」：把块的 props schema 翻译成表单，再把表单读回 props。
//
// 一条分工纪律：**阅读态的 HTML 由后端出**（`src/modules/doc/blocks/html.js` 的 `toHtml`），
// 前端绝不实现第二份渲染。两边各写一遍同一个块，迟早会漂移，而漂移出来的是
// 「编辑器里看着对、发出去不一样」这种最难查的错误 ——
// 所以这里只做三件事：schema → 表单、表单 → props、以及几个展示用的小零件。
//
// 表单的形状照抄块的 schema（`/api/docs/meta/block-types` 会给一份），
// 新增一种块类型**不需要改这个文件** —— 只要它的 schema 用的是下面这几种字段类型。

import { esc } from '../core/dom.js';

/** 字段类型 → 控件。schema 里出现没见过的 type 时退化成单行输入框（不炸）。 */
function controlHtml(key, spec, value, idPrefix, opts = {}) {
  const id = esc(`${idPrefix}-${key}`);
  const head = `id="${id}" data-prop="${esc(key)}"`;
  if (spec.type === 'number') {
    const min = spec.min === undefined ? '' : ` min="${esc(spec.min)}"`;
    const max = spec.max === undefined ? '' : ` max="${esc(spec.max)}"`;
    return `<input type="number" class="doc-input" ${head}${min}${max} value="${esc(value ?? spec.default ?? '')}">`;
  }
  if (spec.type === 'boolean') return `<input type="checkbox" class="doc-check" ${head}${value ? ' checked' : ''}>`;
  if (spec.type === 'rows') {
    const count = Array.isArray(value) ? value.length : 3;
    return `<textarea class="doc-input doc-textarea" ${head} rows="${Math.min(12, Math.max(3, count + 1))}" spellcheck="false">${esc(rowsToText(value))}</textarea>`;
  }
  if (spec.type === 'options') {
    const ids = (Array.isArray(value) ? value : []).map((option, index) => option?.id ?? `o${index + 1}`);
    return `<textarea class="doc-input doc-textarea" ${head} data-ids="${esc(ids.join(' '))}" rows="${Math.min(12, Math.max(3, ids.length + 1))}">${esc(optionsToText(value))}</textarea>`;
  }
  if (spec.type === 'object') {
    return `<textarea class="doc-input doc-textarea" ${head} rows="5" spellcheck="false">${esc(safeJson(value ?? spec.default ?? {}))}</textarea>`;
  }
  if (spec.singleLine) {
    return `<input type="text" class="doc-input" ${head} maxlength="${esc(spec.maxLength ?? 200)}" value="${esc(value ?? '')}">`;
  }
  // 长文本给高一点：一个 20000 字上限的字段用 6 行框写，等于逼人用外部编辑器。
  // `opts.code` 的（app 块的 code、自定义沙箱类型的 code）再多给几行、换等宽字 —— 那是代码，不是文章。
  const rows = opts.code ? 14 : (spec.maxLength ?? 0) >= 4000 ? 10 : 6;
  const cls = opts.code ? 'doc-input doc-textarea doc-code-box' : 'doc-input doc-textarea';
  return `<textarea class="${cls}" ${head} rows="${rows}" maxlength="${esc(spec.maxLength ?? 20000)}" spellcheck="false">${esc(value ?? '')}</textarea>`;
}

const HINT_BY_TYPE = {
  rows: '每行一条记录，单元格之间用 | 分隔',
  object: '一段 JSON（留空即为 {}）',
};

/** 一种块类型的完整表单。schema 是唯一真相 —— 这里不认识任何具体的块名字。 */
function formHtml(typeDef, props, idPrefix) {
  const schema = typeDef?.schema ?? {};
  const entries = Object.entries(schema);
  const fields = entries
    .map(([key, spec]) => {
      const label = spec.label ?? key;
      const required = spec.required ? '<span class="doc-req">*</span>' : '';
      let hint = HINT_BY_TYPE[spec.type] ?? '';
      if (spec.type === 'options') {
        hint = `每行一个选项（至少 ${spec.minItems ?? 2} 个，最多 ${spec.maxItems ?? 10} 个）`;
      }
      // 「是不是代码」不猜内容，看两处明示：块类型声明的 editor，或字段名字就叫 code。
      const code = typeDef?.editor === 'code' || key === 'code';
      if (code) hint = '这段 HTML / JS 只在访客浏览器的沙箱 iframe 里跑，服务端从不执行它。';
      const attribute = spec.type === 'boolean' ? '' : ` for="${esc(`${idPrefix}-${key}`)}"`;
      return `<label class="doc-field"${attribute}>
        <span class="doc-field-label">${esc(label)}${required}</span>
        ${controlHtml(key, spec, props?.[key], idPrefix, { code })}
        ${hint ? `<span class="doc-hint">${esc(hint)}</span>` : ''}
      </label>`;
    })
    .join('');
  // 联动是跨块约定，不写在任何块的 schema 里，所以每种块的表单都得带上它 ——
  // 否则「块间联动」这个能力在产品里就只有一个后端函数，用户永远碰不到。
  // 但它是**进阶**功能：摊在每一块的表单底下会把「填字段 → 保存本块」这条主线淹掉，
  // 所以默认收起（已经写了联动的块例外 —— 那说明用户在用，别把它的内容藏起来）。
  const bind = props?.bind ?? {};
  const bindRow = `<details class="doc-bind"${props?.bind ? ' open' : ''}>
    <summary class="doc-src-head">块间联动（进阶，可选）</summary>
    <div class="doc-bind-row">
      <input class="doc-input" data-bind-from placeholder="来源块号，例如 b3" value="${esc(bind.from ?? '')}">
      <input class="doc-input" data-bind-field placeholder="字段名，例如 text" value="${esc(bind.field ?? '')}">
    </div>
    <span class="doc-hint">填了就让本块的同名字段每次渲染都从来源块取值；成环或来源不存在会被检测出来并降级，绝不死循环。</span>
  </details>`;
  if (entries.length === 0) {
    return `<div class="doc-hint">这种块没有可填的字段，它的内容来自它引用的东西。</div>${bindRow}`;
  }
  return `${fields}${bindRow}`;
}

/**
 * 把一张表单读回 props。
 *
 * 只做「读」和「明显说不通就报错」，**不做校验** —— 后端有权威的
 * `validateProps`/`coerceProps`，前端再抄一份长度、范围、必填的规则，
 * 就会出现「前端说不行、后端说行」这种两边对不上的情况。
 * 读不出来（比如 JSON 打错了）就报一条人话，让用户自己改，不要静默丢掉他的输入。
 *
 * @returns {{props: object, problems: string[]}}
 */
function readForm(root, typeDef) {
  const schema = typeDef?.schema ?? {};
  const props = {};
  const problems = [];
  for (const [key, spec] of Object.entries(schema)) {
    const node = root.querySelector(`[data-prop="${key}"]`);
    if (!node) continue;
    const label = spec.label ?? key;
    if (spec.type === 'boolean') {
      props[key] = node.checked;
      continue;
    }
    const raw = String(node.value ?? '');
    if (spec.type === 'number') {
      if (raw.trim() === '') continue; // 空 = 用 schema 的默认值
      const number = Number(raw);
      if (!Number.isFinite(number)) problems.push(`「${label}」得是数字`);
      else props[key] = number;
      continue;
    }
    if (spec.type === 'rows') {
      props[key] = raw
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => line.split('|').map((cell) => cell.trim()));
      continue;
    }
    if (spec.type === 'options') {
      const ids = String(node.dataset.ids ?? '').split(/\s+/).filter(Boolean);
      props[key] = raw
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((text, index) => ({ id: ids[index] ?? `o${index + 1}`, text }));
      continue;
    }
    if (spec.type === 'object') {
      if (raw.trim() === '') {
        props[key] = {};
        continue;
      }
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) props[key] = parsed;
        else problems.push(`「${label}」得是一个 JSON 对象`);
      } catch {
        problems.push(`「${label}」的 JSON 没写对`);
      }
      continue;
    }
    props[key] = raw;
  }
  // 联动的两个输入框不属于 schema，单独读 —— 两个都空就是没有联动。
  const from = String(root.querySelector('[data-bind-from]')?.value ?? '').trim();
  const field = String(root.querySelector('[data-bind-field]')?.value ?? '').trim();
  if (from !== '' || field !== '') {
    if (!/^b\d+$/.test(from)) problems.push('联动要填来源块号（形如 b3）');
    else if (field === '') problems.push('联动要填字段名');
    else props.bind = { from, field };
  }
  return { props, problems };
}

/**
 * 块级「源码」编辑（设计 §5.2 的进阶入口）。
 *
 * 表单只能表达 schema 里声明过的字段，而**块的形状比表单宽**：
 * `bind`（跨块联动）是保留字段，自定义块类型的 `config` 是自由对象。
 * 所以每一块都摊开一条 props JSON 让用户直接写 —— 这是「自己编一个块」时
 * 唯一能碰到全部字段的入口，也是排版出问题时唯一能看清真相的地方。
 * 它**不是第二份校验**：读不出来就报人话，其余交给后端的 coerceProps/validateProps。
 */
function sourceHtml(block) {
  const id = esc(block?.blockId ?? '');
  return `<details class="doc-src">
    <summary class="doc-src-head">源码（props JSON）</summary>
    <textarea class="doc-input doc-textarea doc-src-box" data-doc-source="${id}" rows="6" spellcheck="false">${esc(safeJson(block?.props))}</textarea>
    <div class="doc-actions">
      <button class="btn btn-sm" type="button" data-doc-action="source-save" data-block-id="${id}">保存源码</button>
      <span class="doc-hint">改完点这里；也可以改完再点上面的「保存本块」（表单优先，会覆盖源码）。</span>
    </div>
    <span class="doc-hint">schema 里没声明的字段会被丢掉，但 <code class="doc-code">bind</code> 是保留字段。要写引擎还没给表单的字段（自定义块类型的 config、多出来的选项）就从这里写。</span>
  </details>`;
}

/** 把源码框读回 props；空框或坏 JSON 都返回 null（调用方保持原样，不静默清空）。 */
function readSource(root) {
  const node = root?.querySelector?.('[data-doc-source]');
  if (!node) return null;
  const raw = String(node.value ?? '').trim();
  if (raw === '') return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return null;
  } catch {
    return null;
  }
}

/** 新建一块时的初始 props：填上 schema 默认值，必填的给一句能直接改的占位。 */const STARTER_TEXT = {
  heading: '新的标题',
  paragraph: '写点什么…',
  code: '// 在这里写代码',
  formula: 'E = mc^2',
  quote: '一句值得引用的话',
  table: '',
  list: '',
};

// 「空代码的块」在页面上只有一句「这个积木还没写代码」，新建时等于给用户一张白纸 ——
// 所以给「小应用」塞一段**能立刻跑起来的最小示例**当初值（只是初值，用户随时可以全删）。
const STARTER_CODE = {
  app: `<h3>小应用</h3>
<p>点了 <b id="n">0</b> 次</p>
<button id="go">点我</button>
<script>
  let n = 0;
  document.getElementById('go').onclick = () => {
    n += 1;
    document.getElementById('n').textContent = String(n);
    Sandbox.resize();
  };
</script>`,
};

function starterProps(typeDef) {
  const props = {};
  for (const [key, spec] of Object.entries(typeDef?.schema ?? {})) {
    if (spec.type === 'boolean') props[key] = Boolean(spec.default);
    else if (spec.type === 'number') props[key] = spec.default ?? spec.min ?? 0;
    else if (spec.type === 'rows') props[key] = [['列一', '列二'], ['', '']];
    else if (spec.type === 'options') {
      props[key] = [
        { id: 'o1', text: '选项一' },
        { id: 'o2', text: '选项二' },
      ];
    } else if (spec.type === 'object') props[key] = {};
    else if (spec.required) props[key] = STARTER_TEXT[typeDef.name] ?? '（待填写）';
    else props[key] = spec.default ?? '';
  }
  const starter = STARTER_CODE[typeDef?.name];
  if (starter && !props.code) props.code = starter;
  return props;
}

/* ---------------- 展示用的小零件 ---------------- */

function rowsToText(rows) {
  if (!Array.isArray(rows)) return '';
  return rows.map((row) => (Array.isArray(row) ? row.join(' | ') : String(row ?? ''))).join('\n');
}

function optionsToText(options) {
  if (!Array.isArray(options)) return '';
  return options.map((option) => String(option?.text ?? option?.label ?? '')).join('\n');
}

function safeJson(value) {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return '{}';
  }
}

/** 块卡片上的一行摘要 —— 拿第一个有内容的字符串字段当标题。 */
function summarize(block, typeDef) {
  const props = block?.props ?? {};
  const candidates = [props.text, props.question, props.label, props.target, props.title, props.alt, props.src, props.url, props.app];
  const text = candidates.find((value) => typeof value === 'string' && value.trim().length > 0) ?? '';
  const flat = text.replace(/\s+/g, ' ').trim();
  const label = typeDef?.label ?? block?.type ?? '未知';
  return flat ? `${label} · ${flat.slice(0, 40)}` : label;
}

/** 一种块类型的 schema 速查（`#/blocks` 页用）—— 纯展示，不做推断。 */
function schemaHtml(typeDef) {
  const entries = Object.entries(typeDef?.schema ?? {});
  if (entries.length === 0) return '<div class="doc-hint">没有字段。</div>';
  return `<ul class="doc-schema">${entries
    .map(([key, spec]) => {
      const bits = [spec.type];
      if (spec.required) bits.push('必填');
      if (spec.maxLength) bits.push(`≤${spec.maxLength} 字`);
      if (spec.min !== undefined || spec.max !== undefined) bits.push(`${spec.min ?? '-∞'}~${spec.max ?? '+∞'}`);
      if (spec.type === 'options') bits.push(`${spec.minItems ?? 2}~${spec.maxItems ?? 10} 项`);
      if (spec.type === 'rows') bits.push(`≤${spec.maxRows ?? 50}行×${spec.maxCols ?? 12}列`);
      return `<li><code class="doc-code">${esc(key)}</code> ${esc(spec.label ?? '')} <span class="doc-hint">${esc(bits.join(' · '))}</span></li>`;
    })
    .join('')}</ul>`;
}

// ── 导出 ──────────────────────────────────────────────────────────────
export { formHtml };
export { readForm };
export { sourceHtml };
export { readSource };
export { starterProps };
export { summarize };
export { schemaHtml };

/* @hand-written */
