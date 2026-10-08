// 沙箱的**宿主一侧**（§6.2 / §6.3）。跑在普通页面里，管理若干个 iframe。
//
// 这是整条链路上唯一「会执行、也可能被撑爆」的位置，所以纪律都写在这里：
//
//   1. **白名单**：iframe 发来的消息只认 `ready` / `resize` / `value` / `request`，
//      其余一律丢弃。消息按 `event.source` 认领，不看 `event.data` 里自称的 id ——
//      两个 iframe 互相冒充就是这么发生的。
//   2. **看门狗**：`ready` 2 秒内没到 → 降级成「运行失败」占位。用户代码死循环时，
//      浏览器不会回你，只有定时器会。
//   3. **频率上限**：单个 iframe 每秒 200 条，超了立刻停止响应并降级。
//      一个 `requestAnimationFrame` 里 postMessage 就能把主线程淹掉。
//   4. **能力不自己办**：`request` 一律转发到 `POST /api/docs/:id/capabilities`。
//      白名单与审计在服务端（`src/modules/doc/store.js`），这里不做第二份判断 ——
//      但这里也**不做任何本地放行**，前端放行等于没放行。
import { api } from './api.js';

/** 与 `src/modules/doc/schema.js` 的 `SANDBOX_MESSAGES` 是同一份清单。 */
const ACCEPTED = ['ready', 'resize', 'value', 'request'];
/** 与 `SANDBOX_READY_MS` 一致：握手宽限期。 */
const READY_MS = 2000;
/** 与 `SANDBOX_MESSAGES_PER_SECOND` 一致。 */
const PER_SECOND = 200;
const MAX_HEIGHT = 20000;

/** iframe.contentWindow → 条目。用 source 认领，不用 data 里的自述。 */
const registry = new Map();
let listening = false;

function ensureListener() {
  if (listening) return;
  listening = true;
  window.addEventListener('message', onMessage);
}

function degrade(entry, message) {
  if (entry.dead) return;
  entry.dead = true;
  clearTimeout(entry.timer);
  registry.delete(entry.windowRef);
  const slot = document.createElement('div');
  slot.className = 'doc-app-slot doc-app-failed';
  const text = document.createElement('p');
  text.textContent = message;
  slot.appendChild(text);
  entry.frame.replaceWith(slot);
}

/** 超过 200 条/秒就不再服务 —— 这个 iframe 已经不受控了。 */
function overBudget(entry) {
  const now = Date.now();
  if (now - entry.windowStart >= 1000) {
    entry.windowStart = now;
    entry.windowCount = 0;
  }
  entry.windowCount += 1;
  return entry.windowCount > PER_SECOND;
}

function reply(entry, payload) {
  try {
    entry.windowRef.postMessage(payload, '*');
  } catch (error) {
    // 不透明源里 postMessage 也可能抛；抛了就当这个沙箱已经走了。
    degrade(entry, '这个小应用运行失败了。');
  }
}

async function handleRequest(entry, data) {
  const id = data.id ?? null;
  try {
    const result = await api(`/api/docs/${entry.documentId}/capabilities`, {
      method: 'POST',
      // `payload` 是能力自己的参数（`state` 用它传 {op, scope, value}）。
      // 这里只**转发**，判不判断是服务端的事 —— 前端放行等于没放行。
      body: {
        blockId: entry.blockId,
        capability: String(data.capability ?? ''),
        payload: data.payload && typeof data.payload === 'object' ? data.payload : null,
      },
    });
    reply(entry, { type: 'capability', id, ok: true, value: result?.value });
    // 脚本往派生层写了东西（或删了）：正文明天要跟着变，通知宿主重画。
    // 只有**写**才通知；`list` 每帧都在问，通知它等于自激。
    const op = String(data.payload?.op ?? 'list');
    if (String(data.capability ?? '') === 'blocks.derived' && op !== 'list' && typeof entry.onDerivedChange === 'function') {
      entry.onDerivedChange();
    }
  } catch (error) {
    // 被拒也要回话，否则沙箱里的 Promise 会一直悬着（它自己 5 秒超时，但那太晚）。
    reply(entry, { type: 'capability', id, ok: false, message: error?.message || '能力被拒绝' });
  }
}

function onMessage(event) {
  const entry = registry.get(event.source);
  if (!entry) return;
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if (!ACCEPTED.includes(data.type)) return;
  if (overBudget(entry)) {
    degrade(entry, '这个小应用发消息太频繁，已经停止运行。');
    return;
  }
  if (data.type === 'ready') {
    entry.ready = true;
    clearTimeout(entry.timer);
    entry.timer = null;
    reply(entry, { type: 'init', props: entry.props, inputs: entry.inputs });
    return;
  }
  if (data.type === 'resize') {
    const height = Number(data.height);
    if (!Number.isFinite(height)) return;
    entry.frame.style.height = `${Math.max(0, Math.min(MAX_HEIGHT, Math.round(height)))}px`;
    return;
  }
  if (data.type === 'value') {
    entry.value = data.value;
    if (typeof entry.onValue === 'function') entry.onValue(entry.blockId, data.value);
    return;
  }
  if (data.type === 'request') void handleRequest(entry, data);
}

/**
 * 把一个已经渲染好的 iframe 挂上宿主。
 *
 * @param {Element} frame  `<iframe class="doc-app-frame">`
 * @param {object} block   服务端给的块形状 `{blockId, type, props}`
 * @param {object} context `{documentId, inputs, onValue}`
 */
export function attachSandbox(frame, block, context = {}) {
  const windowRef = frame.contentWindow;
  if (!windowRef) return false;
  ensureListener();
  const entry = {
    frame,
    windowRef,
    blockId: block?.block_id ?? frame.dataset.docBlock ?? '',
    props: block?.props ?? {},
    inputs: sanitizeInputs(context.inputs),
    documentId: context.documentId,
    onValue: context.onValue,
    onDerivedChange: context.onDerivedChange,
    ready: false,
    dead: false,
    value: undefined,
    windowStart: Date.now(),
    windowCount: 0,
    // 看门狗：用户代码死在同步循环里时，只有定时器还能说话。
    timer: setTimeout(() => degrade(entry, '这个小应用运行失败了。'), READY_MS),
  };
  registry.set(windowRef, entry);
  return true;
}

/** 宿主只往下传**可 JSON 序列化的纯数据**，并且丢掉函数与原型（结构化克隆的边界）。 */
function sanitizeInputs(inputs) {
  if (!inputs || typeof inputs !== 'object') return {};
  try {
    return JSON.parse(JSON.stringify(inputs));
  } catch {
    return {};
  }
}

/**
 * 换页 / 重画之前必须调一次：清掉所有定时器与登记。
 * 不调的话，上一页的 iframe 已经被 DOM 丢掉，看门狗仍会在 2 秒后
 * 去 `replaceWith` 一个已经不在文档里的节点（抛异常，且日志里看不出是谁）。
 *
 * `root` 是可选参数（2026-02 加）：只收掉**这棵子树里**的沙箱。
 * 不传 = 全清，与原来一字不差，老调用点（doc.js 的整块重画、ai-edit.js 换文档）不受影响；
 * 传了则给「屏幕外的试跑容器」用 —— AI 抽屉在影子编辑区里挂过一次沙箱之后得单独收回，
 * 不能顺手把右边真实预览里正在跑的那几个一起带走。
 */
export function unmountSandboxes(root) {
  for (const entry of Array.from(registry.values())) {
    if (root && !root.contains(entry.frame)) continue;
    entry.dead = true;
    if (entry.timer) clearTimeout(entry.timer);
    registry.delete(entry.windowRef);
  }
  if (!root) registry.clear();
}

/** 宿主保存下来的沙箱输出（块间联动在客户端侧读取用）。 */
export function sandboxValue(blockId) {
  for (const entry of registry.values()) {
    if (entry.blockId === blockId) return entry.value;
  }
  return undefined;
}

/** 供测试断言用：当前挂着几个沙箱。 */
export function sandboxCount() {
  return registry.size;
}
