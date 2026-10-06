// 块的 props 校验（声明式）。
//
// 为什么要有这一层：块的内容全部来自用户与导入的 markdown，
// 而渲染代码会直接把这些值拼进 HTML。与其在每个渲染函数里各写一遍防御，
// 不如在**进**渲染之前统一校验一次：能用就用（补默认值、裁掉越界），
// 不能用就整块降级成占位 —— 绝不抛异常、绝不白屏（FR-BLOCK-05）。
//
// 两个入口：
//   coerceProps  —— 尽力而为，永远返回可用的 props（markdown 导出用）
//   validateProps —— 严格，返回 ok 标记（渲染用，ok=false 就降级）
import { MAX_BLOCK_PROPS_BYTES } from '../schema.js';
import { singleLine } from './text.js';

/** 一个字段的「零值」。 */
function zeroOf(spec) {
  switch (spec?.type) {
    case 'number': return 0;
    case 'boolean': return false;
    case 'rows':
    case 'options': return [];
    case 'object': return {};
    default: return '';
  }
}

function defaultOf(spec) {
  if (spec?.default !== undefined) {
    return typeof spec.default === 'object' && spec.default !== null ? structuredClone(spec.default) : spec.default;
  }
  return zeroOf(spec);
}

/** 把任意值变成数字；变不出来就返回 null。 */
function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

/**
 * 校验一个字段。返回 `{ value, problem }` —— problem 非空表示这个字段没救。
 * 能救的都救（补默认、裁长度、夹范围），**只有「必填却没有」才算没救**。
 */
function coerceField(key, raw, spec, warnings) {
  const label = spec.label ?? key;

  if (raw === undefined || raw === null) {
    if (spec.required) return { value: defaultOf(spec), problem: `缺少必填字段「${label}」` };
    return { value: defaultOf(spec), problem: null };
  }

  switch (spec.type) {
    case 'number': {
      const number = toNumber(raw);
      if (number === null) {
        if (spec.required) return { value: defaultOf(spec), problem: `字段「${label}」必须是数字` };
        warnings.push(`字段「${label}」不是数字，已改用默认值`);
        return { value: defaultOf(spec), problem: null };
      }
      const min = spec.min ?? -Infinity;
      const max = spec.max ?? Infinity;
      // 夹范围不算错：9 级的标题就是 6 级，不必整块降级。
      return { value: Math.min(Math.max(number, min), max), problem: null };
    }
    case 'boolean':
      return { value: raw === true || raw === 'true' || raw === 1 || raw === '1', problem: null };
    case 'string': {
      let value = typeof raw === 'string' ? raw : typeof raw === 'object' ? '' : String(raw);
      if (typeof raw === 'object') {
        warnings.push(`字段「${label}」不是文本，已清空`);
      }
      if (spec.singleLine) value = singleLine(value);
      if (spec.maxLength && value.length > spec.maxLength) {
        warnings.push(`字段「${label}」超过 ${spec.maxLength} 字，已截断`);
        value = value.slice(0, spec.maxLength);
      }
      if (spec.required && value.trim() === '' && spec.nonEmpty !== false) {
        return { value, problem: `必填字段「${label}」不能为空` };
      }
      return { value, problem: null };
    }
    case 'rows': {
      if (!Array.isArray(raw)) {
        if (spec.required) return { value: [], problem: `字段「${label}」必须是一张表` };
        warnings.push(`字段「${label}」不是表格，已清空`);
        return { value: [], problem: null };
      }
      const maxRows = spec.maxRows ?? 50;
      const maxCols = spec.maxCols ?? 12;
      const rows = raw.slice(0, maxRows).map((row) => {
        const cells = Array.isArray(row) ? row : [row];
        return cells.slice(0, maxCols).map((cell) => String(cell ?? ''));
      });
      if (rows.length !== raw.length) warnings.push(`字段「${label}」超过 ${maxRows} 行，已截断`);
      return { value: rows, problem: null };
    }
    case 'options': {
      if (!Array.isArray(raw)) return { value: [], problem: `字段「${label}」必须是选项数组` };
      const max = spec.maxItems ?? 10;
      const options = [];
      for (const [index, item] of raw.slice(0, max).entries()) {
        const source = item && typeof item === 'object' ? item : { text: item };
        const text = String(source.text ?? '').trim();
        if (!text) continue;
        const id = /^[A-Za-z0-9_-]{1,24}$/.test(String(source.id ?? '')) ? String(source.id) : `o${index + 1}`;
        options.push({ id, text: text.slice(0, spec.maxItemLength ?? 80) });
      }
      if (options.length < (spec.minItems ?? 2)) {
        return { value: options, problem: `字段「${label}」至少要有 ${spec.minItems ?? 2} 个选项` };
      }
      return { value: options, problem: null };
    }
    case 'object': {
      if (typeof raw !== 'object' || Array.isArray(raw)) {
        warnings.push(`字段「${label}」不是对象，已清空`);
        return { value: {}, problem: null };
      }
      try {
        JSON.stringify(raw);
      } catch {
        warnings.push(`字段「${label}」无法序列化，已清空`);
        return { value: {}, problem: null };
      }
      return { value: raw, problem: null };
    }
    default:
      return { value: String(raw), problem: null };
  }
}

/** 保留字：每个块都能带，但不写在任何块的 schema 里。 */
const RESERVED_KEYS = ['bind'];

/**
 * 归一 `props.bind`（`{from:'b3', field:'result'}`）。写不对就丢掉 + 一条警告 ——
 * 联动写坏不该让整块降级：块自己还有自己的默认值可渲染（见 `bind.js`）。
 */
function coerceBind(raw, warnings) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push('联动的写法不对（应该是一个对象），已忽略');
    return null;
  }
  const from = typeof raw.from === 'string' && /^b\d+$/.test(raw.from) ? raw.from : '';
  const field = singleLine(String(raw.field ?? '')).slice(0, 64);
  if (!from || !field) {
    warnings.push('联动的写法不对（要写清楚从哪一块的哪个字段来），已忽略');
    return null;
  }
  return { from, field };
}

function run(typeDef, input, strict) {
  const warnings = [];
  let problem = null;
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  if (input !== undefined && input !== null && (typeof input !== 'object' || Array.isArray(input))) {
    problem = `props 必须是一个对象，收到 ${Array.isArray(input) ? 'array' : typeof input}`;
  }

  const value = {};
  for (const [key, spec] of Object.entries(typeDef?.schema ?? {})) {
    const result = coerceField(key, source[key], spec, warnings);
    value[key] = result.value;
    if (result.problem) {
      warnings.push(result.problem);
      if (strict) problem = problem ?? result.problem;
    }
  }
  // 联动是**跨块**的约定（§3.3③），不属于任何单个块的 schema，所以单独认下来。
  // 必须让它活过这一层：丢掉它等于这个功能根本没有入口 —— 用户存了联动、
  // 刷新之后发现联动没了，还会以为是自己写错了。
  for (const key of RESERVED_KEYS) {
    if (!(key in source)) continue;
    const kept = coerceBind(source[key], warnings);
    if (kept) value[key] = kept;
  }
  // schema 里没声明的键一律丢掉：块是声明式的，不接受「顺手多塞一个字段」。
  for (const key of Object.keys(source)) {
    if (!(key in value)) warnings.push(`忽略未声明的字段「${key}」`);
  }

  try {
    if (JSON.stringify(value).length > MAX_BLOCK_PROPS_BYTES) {
      problem = problem ?? '这一块的属性太大';
      warnings.push('这一块的属性太大');
    }
  } catch {
    problem = problem ?? '这一块的属性无法序列化';
  }

  return { ok: problem === null, problem, value, warnings };
}

/** 严格校验：渲染前用。ok=false 时调用方应该把这块降级成占位。 */
export function validateProps(typeDef, input) {
  return run(typeDef, input, true);
}

/** 尽力而为：永远返回可用的 props（markdown 导出、存库前规范化用）。 */
export function coerceProps(typeDef, input) {
  return run(typeDef, input, false).value;
}
