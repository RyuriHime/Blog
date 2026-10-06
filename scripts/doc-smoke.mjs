/**
 * 积木帖子（P2）的端到端测试：起一个临时服务器（独立库 + 独立端口），
 * 用真实 HTTP 请求 + 直接查库，把 P2 开工说明里的验收标准逐条走一遍。
 *
 * 用法：node scripts/doc-smoke.mjs
 *
 * ⚠️ 与 feed-smoke.mjs 同一条纪律：每一条「别人看不到」的断言都从**另一个账号**
 * 发请求去验，不是检查前端有没有藏按钮 —— 前端藏起来不叫权限。
 *
 * ⚠️ 还有一条这个文件独有的纪律：**新库上不许出现系统板块**。
 * 影子行（互动锚点）要往 `posts` 里写行，而所有帖子列表都以 `deleted = 0` 为第一条件
 * （src/store.js:423 的 buildFilter），所以锚点一定会被旧列表看见。为了让它尽量少打扰，
 * 锚点依赖的系统板块必须是**惰性创建**的：只有真的建了文档才出现。
 * 如果启动时就建，check-golden 里 /api/site 的板块表会当场多一项。
 */
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const SERVER = join(ROOT, 'src', 'server.js');
const DB_FILE = join(ROOT, 'data', 'doc-smoke.db');
const AVATAR_DIR = join(ROOT, 'data', 'doc-smoke-avatars');
const NOTES_DIR = join(ROOT, 'data', 'doc-smoke-notes');
const LOG_FILE = join(ROOT, 'data', 'doc-smoke-server.log');
const PORT = Number(process.env.DOC_SMOKE_PORT || 3433);
const BASE = `http://127.0.0.1:${PORT}`;

/** 系统板块的 slug（影子行都挂在这个板块下）。 */
const DOC_BOARD_SLUG = 'documents';

let passed = 0;
const failures = [];
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function createClient() {
  let cookie = '';
  return {
    async call(path, { method = 'GET', body, raw = false } = {}) {
      const response = await fetch(BASE + path, {
        method,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'manual',
      });
      for (const value of response.headers.getSetCookie()) {
        const pair = value.split(';')[0];
        if (pair.startsWith('forum_sid=')) cookie = pair;
      }
      if (raw) return response;
      const json = await response.json().catch(() => null);
      return { status: response.status, body: json, data: json?.data, error: json?.error };
    },
  };
}

async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/api/site`);
      if (response.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(180);
  }
  return false;
}

/* ---------------- 直接查库（只读） ---------------- */

/** 每次调用新开一个只读连接，避免和服务器持有的句柄打架。 */
function withDb(fn) {
  const db = new DatabaseSync(DB_FILE, { readOnly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function tableSql(name) {
  return withDb((db) => {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
    return row?.sql ?? null;
  });
}

function tableColumns(name) {
  return withDb((db) => db.prepare(`PRAGMA table_info(${name})`).all());
}

function scalar(sql, ...params) {
  return withDb((db) => db.prepare(sql).get(...params));
}

mkdirSync(join(ROOT, 'data'), { recursive: true });
for (const suffix of ['', '-wal', '-shm']) rmSync(DB_FILE + suffix, { force: true });
rmSync(AVATAR_DIR, { recursive: true, force: true });
rmSync(NOTES_DIR, { recursive: true, force: true });

const logFd = openSync(LOG_FILE, 'w');
const child = spawn(process.execPath, [SERVER], {
  env: {
    ...process.env,
    PORT: String(PORT),
    DB_FILE,
    AVATAR_DIR,
    NOTES_DIR,
    QUIET: '1',
    AI_API_KEY: '',
  },
  stdio: ['ignore', logFd, logFd],
});

const finish = async (code) => {
  try {
    child.kill();
  } catch {
    /* 忽略 */
  }
  await sleep(400);
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(DB_FILE + suffix, { force: true });
    } catch {
      /* 忽略 */
    }
  }
  rmSync(AVATAR_DIR, { recursive: true, force: true });
  rmSync(NOTES_DIR, { recursive: true, force: true });
  console.log('');
  console.log('──────────────────────────────────────────────');
  console.log(`通过 ${passed} 项，失败 ${failures.length} 项`);
  for (const item of failures) console.log(`  ❌ ${item}`);
  process.exit(code);
};

try {
  if (!(await waitForServer())) {
    console.log('❌ 服务器没能在 20 秒内起来，看 data/doc-smoke-server.log');
    await finish(1);
  }

  /* ================= S1 数据层 ================= */

  console.log('\n【S1】数据层：四张表');

  {
    const doc = (await import('../src/modules/doc/index.js')).default;
    const OWNED = ['documents', 'document_blocks', 'document_revisions', 'doc_block_types'];
    check('doc 模块导出了 name / apiPrefix', doc.name === 'doc' && doc.apiPrefix === '/api/docs');
    check(
      'owns 声明了四张表（表归属不登记的话 ownedButNotRegistered 会在启动时报错）',
      OWNED.every((name) => (doc.owns ?? []).includes(name)),
      `owns = ${JSON.stringify(doc.owns)}`,
    );
  }

  for (const name of ['documents', 'document_blocks', 'document_revisions', 'doc_block_types']) {
    check(`表 ${name} 存在`, tableSql(name) !== null);
  }

  {
    // position 必须是 REAL —— 验收标准 ②：插到 1 和 2 之间写 1.5，不必重排后续块。
    const col = tableColumns('document_blocks').find((c) => c.name === 'position');
    check('document_blocks.position 是 REAL（验收 ②）', col?.type === 'REAL', `type = ${col?.type}`);

    // type 单独一列（需求坑 #4）
    const typeCol = tableColumns('document_blocks').find((c) => c.name === 'type');
    check('document_blocks.type 是单独一列且 NOT NULL（坑 #4）', typeCol?.type === 'TEXT' && typeCol?.notnull === 1);

    // 块 id 在文档内唯一
    const unique = tableSql('document_blocks') ?? '';
    check('document_blocks 有 UNIQUE(document_id, block_id)', /UNIQUE\s*\(\s*document_id\s*,\s*block_id\s*\)/i.test(unique), unique.replace(/\s+/g, ' ').slice(0, 160));

    // type_version（FR-BLOCK-06）
    check('document_blocks 有 type_version 列（FR-BLOCK-06）', tableColumns('document_blocks').some((c) => c.name === 'type_version'));
    // props_json
    check('document_blocks 有 props_json 列', tableColumns('document_blocks').some((c) => c.name === 'props_json'));
  }

  {
    const cols = tableColumns('documents').map((c) => c.name);
    for (const name of ['user_id', 'kind', 'title', 'scope', 'template', 'anchor_post_id', 'sandbox_disabled', 'deleted', 'created_at', 'updated_at']) {
      check(`documents 有列 ${name}`, cols.includes(name));
    }
    const col = tableColumns('documents').find((c) => c.name === 'scope');
    check('documents.scope 默认 public', col?.dflt_value === "'public'", `默认值 = ${col?.dflt_value}`);
    const kind = tableColumns('documents').find((c) => c.name === 'kind');
    check('documents.kind 默认 post', kind?.dflt_value === "'post'", `默认值 = ${kind?.dflt_value}`);
  }

  {
    const sql = tableSql('document_revisions') ?? '';
    check('document_revisions 有 UNIQUE(document_id, revision)', /UNIQUE\s*\(\s*document_id\s*,\s*revision\s*\)/i.test(sql), sql.replace(/\s+/g, ' ').slice(0, 160));
    const cols = tableColumns('document_revisions').map((c) => c.name);
    check('document_revisions 有 blocks_json / reason / author_id', ['blocks_json', 'reason', 'author_id'].every((n) => cols.includes(n)));
  }

  {
    const cols = tableColumns('doc_block_types').map((c) => c.name);
    check(
      'doc_block_types 有 name / version / props_schema_json / renderer_kind / renderer_json',
      ['name', 'version', 'props_schema_json', 'renderer_kind', 'renderer_json'].every((n) => cols.includes(n)),
    );
    const pk = tableColumns('doc_block_types').find((c) => c.name === 'name');
    check('doc_block_types.name 是主键（FR-BLOCK-04 的注册表键）', pk?.pk === 1);
  }

  {
    // 惰性创建：新库上不该有系统板块（否则 check-golden 的 /api/site 立刻变红）
    const board = scalar("SELECT id, name FROM boards WHERE slug = ?", DOC_BOARD_SLUG);
    check('新库上还没有系统板块（证明它是惰性创建的，不在启动时建）', !board, JSON.stringify(board));
    const boards = scalar('SELECT COUNT(*) AS n FROM boards');
    check('boards 数量仍是种子数据的 5 个', boards.n === 5, `n = ${boards.n}`);
  }

  /* ================= S2 块引擎（纯函数层） ================= */

  console.log('\n【S2】块引擎');

  const engine = await import('../src/modules/doc/blocks/index.js');
  const agent = await import('../note-agent/src/blocks.mjs');
  const { isDeepStrictEqual } = await import('node:util');

  /* ---------- 2.1 类型清单与契约对拍 ---------- */

  const typeNames = engine.listBlockTypes().map((type) => type.name);
  check('内置 13 种块类型', typeNames.length === 13, typeNames.join(','));
  check(
    '前 7 种与 note-agent 的 BLOCK_TYPES 逐字同序（契约对拍，两边块序列可互换）',
    JSON.stringify(typeNames.slice(0, 7)) === JSON.stringify(agent.BLOCK_TYPES),
    `${JSON.stringify(typeNames.slice(0, 7))} vs ${JSON.stringify(agent.BLOCK_TYPES)}`,
  );
  check(
    '新增 6 种是 quote / poll / wiki / embed / app / script',
    JSON.stringify(typeNames.slice(7)) === JSON.stringify(['quote', 'poll', 'wiki', 'embed', 'app', 'script']),
    JSON.stringify(typeNames.slice(7)),
  );
  check('每种类型都有 name / version / label / icon / schema / editor', engine.listBlockTypes().every(
    (type) => type.name && type.version === 1 && type.label && type.icon && type.schema && type.editor,
  ));

  /* ---------- 2.2 降级不崩（FR-BLOCK-05） ---------- */

  const unknown = engine.renderBlocks([{ block_id: 'b1', type: '不存在的类型', version: 1, props: {} }], {});
  check(
    '未注册类型 → 占位 doc-block-unknown，不抛异常',
    unknown.html.includes('doc-block-unknown') && unknown.warnings.length === 1,
    JSON.stringify(unknown.warnings),
  );
  check('降级占位里带上了原块 id（前端能指出来是哪个块坏了）', unknown.html.includes('b1'));

  const badProps = engine.renderBlocks([{ block_id: 'b1', type: 'heading', version: 1, props: { level: 9 } }], {});
  check(
    '非法 props（缺必填 text）→ 降级成占位并给警告，绝不抛异常',
    badProps.warnings.length === 1 && badProps.html.includes('doc-block-unknown'),
    JSON.stringify(badProps.warnings),
  );

  const badJson = engine.parseBlocksJson('[{"block_id":"b1","type":"paragraph","props":');
  check('坏 JSON → 返回空块表 + 警告，不抛异常', badJson.blocks.length === 0 && badJson.warnings.length === 1, JSON.stringify(badJson.warnings));

  const xss = engine.renderBlocks(
    [{ block_id: 'b1', type: 'paragraph', version: 1, props: { text: '<img src=x onerror=alert(1)>' } }],
    {},
  );
  check('props 里的 HTML 被转义（不产生可执行标签）', xss.html.includes('&lt;img') && !xss.html.includes('<img'), xss.html);

  // 「有没有 inline 事件属性」只能在**标签内部、且引号之外**判：
  // 被转义过的正文里出现 onerror= 是一段无害的文字，而属性值里的 onerror= 也出不来。
  const bareTags = (html) =>
    (html.match(/<[a-z][^>]*>/gi) ?? []).map((tag) => tag.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''"));
  check(
    '渲染结果里没有任何 inline 事件属性（转义后的正文不算）',
    bareTags(xss.html).every((tag) => !/\son[a-z]+\s*=/i.test(tag)),
    xss.html,
  );

  const attrXss = engine.renderBlocks(
    [{ block_id: 'b1', type: 'image', version: 1, props: { text: '', alt: '" onerror=alert(1) x="', src: 'x" onerror=alert(1)' } }],
    {},
  );
  check(
    '属性上下文里的引号被转义（挤不出新的属性）',
    bareTags(attrXss.html).every((tag) => !/\son[a-z]+\s*=/i.test(tag)) && attrXss.html.includes('&quot;'),
    attrXss.html,
  );

  /* ---------- 2.3 markdown 输出与 note-agent 逐字节对拍 ---------- */

  const AGENT_SAMPLES = [
    { name: '标题', blocks: [{ id: 'b1', type: 'heading', text: '第一章', level: 3 }] },
    { name: '段落', blocks: [{ id: 'b1', type: 'paragraph', text: '正文一段。' }] },
    { name: '无序列表', blocks: [{ id: 'b1', type: 'list', text: '- 甲\n- 乙' }] },
    { name: '有序列表', blocks: [{ id: 'b1', type: 'list', text: '1. 甲\n2. 乙' }] },
    { name: '带语言的代码', blocks: [{ id: 'b1', type: 'code', text: 'const a = 1;', meta: { lang: 'js' } }] },
    { name: '无语言代码', blocks: [{ id: 'b1', type: 'code', text: 'plain text' }] },
    { name: '表格', blocks: [{ id: 'b1', type: 'table', text: '', meta: { rows: [['甲', '乙'], ['1', '2']] } }] },
    {
      name: '表格（行里还留着源文件的分隔行）',
      blocks: [{ id: 'b1', type: 'table', meta: { rows: [['甲', '乙'], ['---', '---'], ['1', '2']] } }],
    },
    { name: '公式', blocks: [{ id: 'b1', type: 'formula', text: 'E = mc^2' }] },
    { name: '带定界符的公式', blocks: [{ id: 'b1', type: 'formula', text: '$$\nE = mc^2\n$$' }] },
    { name: '图片', blocks: [{ id: 'b1', type: 'image', meta: { alt: '示意图', src: '/a.png' } }] },
    { name: '一条完整的小文档', blocks: [
      { id: 'b1', type: 'heading', text: '绪论', level: 2 },
      { id: 'b2', type: 'paragraph', text: '这是一段正文。' },
      { id: 'b3', type: 'formula', text: 'a^2 + b^2 = c^2' },
    ] },
  ];

  for (const sample of AGENT_SAMPLES) {
    const mine = engine.blocksToMarkdown(engine.fromNoteAgentBlocks(sample.blocks));
    const theirs = agent.blocksToMarkdown(sample.blocks);
    check(`markdown 输出与 note-agent 逐字节相同：${sample.name}`, mine === theirs, JSON.stringify({ mine, theirs }));
  }

  /* ---------- 2.3b 公式块必须吐出客户端 KaTeX 认得的定界符 ---------- */
  // 服务端从不排公式（renderMarkdown 也一样），排版是 public/views/notes.js 的 ntRenderMath
  // 在 innerHTML 之后干的，而它只认带 `$…$` / `$$…$$` 定界符的文本节点。
  // 只吐裸 LaTeX 的话，读者看到的是一行公式源码 —— 那就等于这个块没渲染。
  {
    const plain = engine.renderBlocks([{ block_id: 'b1', type: 'formula', version: 1, props: { text: 'E = mc^2' } }], {});
    check('公式块带 $$ 定界符（否则客户端 KaTeX 看不见它）', plain.html.includes('$$E = mc^2$$'), plain.html);
    check('公式块同时留着可折叠的源码', plain.html.includes('doc-formula-src') && plain.html.includes('doc-formula-render'), plain.html);
    const wrapped = engine.renderBlocks([{ block_id: 'b1', type: 'formula', version: 1, props: { text: '$$\nE = mc^2\n$$' } }], {});
    check(
      '公式块自己写的定界符不会叠成 $$$$',
      wrapped.html.includes('$$E = mc^2$$') && !wrapped.html.includes('$$$$'),
      wrapped.html,
    );
    const hostile = engine.renderBlocks([{ block_id: 'b1', type: 'formula', version: 1, props: { text: '<img src=x onerror=alert(1)>' } }], {});
    check('公式块里的标签照样转义', !/<img/i.test(hostile.html), hostile.html);
  }

  /* ---------- 2.4 markdown 往返（含 5 种新类型） ---------- */

  const ROUND_TRIP = [
    { block_id: 'b1', type: 'heading', version: 1, props: { text: '绪论', level: 2 } },
    { block_id: 'b2', type: 'paragraph', version: 1, props: { text: '这是\n跨两行的正文。' } },
    { block_id: 'b3', type: 'list', version: 1, props: { text: '- 甲\n- 乙', source: {} } },
    { block_id: 'b4', type: 'code', version: 1, props: { text: 'const a = 1;', lang: 'js' } },
    { block_id: 'b5', type: 'table', version: 1, props: { text: '', rows: [['甲', '乙'], ['1', '2']] } },
    { block_id: 'b6', type: 'formula', version: 1, props: { text: 'E = mc^2' } },
    { block_id: 'b7', type: 'image', version: 1, props: { text: '', alt: '示意图', src: '/a.png' } },
    { block_id: 'b8', type: 'quote', version: 1, props: { text: '凡是过往，皆为序章。', source: '莎士比亚' } },
    { block_id: 'b9', type: 'poll', version: 1, props: { question: '今晚吃什么？', options: [{ id: 'o1', text: '面' }, { id: 'o2', text: '饭' }], multiple: false } },
    { block_id: 'b10', type: 'wiki', version: 1, props: { target: '傅里叶变换', label: 'FT', note: '' } },
    { block_id: 'b11', type: 'embed', version: 1, props: { url: 'https://example.com/a', title: '参考', height: 320 } },
    { block_id: 'b12', type: 'app', version: 1, props: { app: 'todo', config: { showDone: true }, code: '' } },
  ];

  const roundTripMd = engine.blocksToMarkdown(ROUND_TRIP);
  const roundTripBack = engine.markdownToBlocks(roundTripMd);
  check(
    'markdown 往返：12 种类型一次走完，序列完全一致',
    isDeepStrictEqual(roundTripBack, ROUND_TRIP),
    JSON.stringify([roundTripBack.filter((b, i) => !isDeepStrictEqual(b, ROUND_TRIP[i])), roundTripMd]),
  );

  check('markdown 输出里没有非法的裸块标记', !roundTripMd.includes('undefined'), roundTripMd.slice(0, 200));

  /* ---------- 2.5 属性测试：100 篇随机文档往返无损 ---------- */

  {
    let seed = 20261005;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const pick = (list) => list[Math.floor(rnd() * list.length)];
    const WORDS = ['矩阵', '特征值', '收敛', '证明', '设', '则', '当且仅当', 'f(x)', 'ε', '引理'];
    const sentence = (min = 2, max = 8) => {
      const n = min + Math.floor(rnd() * (max - min + 1));
      const parts = [];
      for (let i = 0; i < n; i += 1) parts.push(pick(WORDS));
      return parts.join('');
    };
    const makeProps = (type) => {
      switch (type) {
        case 'heading': return { text: sentence(1, 3), level: 1 + Math.floor(rnd() * 6) };
        case 'paragraph': return { text: sentence() };
        case 'list': return { text: `${pick(['- ', '1. ', '* '])}${sentence(1, 3)}\n${pick(['- ', '2. ', '* '])}${sentence(1, 3)}`, source: {} };
        case 'code': return { text: `const a = ${Math.floor(rnd() * 100)};`, lang: pick(['', 'js', 'py']) };
        case 'table': return { text: '', rows: [[sentence(1, 2), sentence(1, 2)], [sentence(1, 2), sentence(1, 2)]] };
        case 'formula': return { text: `${sentence(1, 2)} = ${sentence(1, 2)}` };
        case 'image': return { text: '', alt: sentence(1, 2), src: `/img/${Math.floor(rnd() * 50)}.png` };
        case 'quote': return { text: sentence(), source: rnd() < 0.5 ? sentence(1, 2) : '' };
        case 'poll': return {
          question: sentence(2, 4),
          options: [
            { id: 'o1', text: sentence(1, 2) },
            { id: 'o2', text: sentence(1, 2) },
          ],
          multiple: rnd() < 0.5,
        };
        case 'wiki': return { target: sentence(1, 2), label: rnd() < 0.5 ? sentence(1, 2) : '', note: '' };
        case 'embed': return { url: `https://example.com/${Math.floor(rnd() * 20)}`, title: sentence(1, 2), height: 200 + Math.floor(rnd() * 4) * 40 };
        case 'app': return { app: pick(['todo', 'calc']), config: { n: Math.floor(rnd() * 10) }, code: pick(['', '<b>hi</b>', 'Sandbox.value(1)']) };
        case 'script': return { code: pick(['', 'Sandbox.value(1);', 'const a = 1;\nSandbox.render.put("s1", "paragraph", { text: "hi" });']) };
        default: return {};
      }
    };
    let broken = null;
    for (let doc = 0; doc < 100 && !broken; doc += 1) {
      const count = 1 + Math.floor(rnd() * 8);
      const document = [];
      for (let i = 0; i < count; i += 1) {
        const type = pick(typeNames);
        document.push({ block_id: `b${i + 1}`, type, version: 1, props: makeProps(type) });
      }
      const markdown = engine.blocksToMarkdown(document);
      const back = engine.markdownToBlocks(markdown);
      if (!isDeepStrictEqual(back, document)) broken = { doc, document, markdown, back };
    }
    check('属性测试：100 篇随机文档 markdown 往返全部无损', broken === null, JSON.stringify(broken).slice(0, 700));
  }

  /* ---------- 2.6 块间联动与环检测 ---------- */

  {
    const linked = engine.resolveBinds([
      { block_id: 'b1', type: 'formula', version: 1, props: { text: 'a + b = 3' } },
      { block_id: 'b2', type: 'paragraph', version: 1, props: { text: '结果', bind: { from: 'b1', field: 'text' } } },
    ]);
    check(
      '块间联动：bind 取到上游块的字段（渲染前拓扑解析）',
      linked.warnings.length === 0 && linked.blocks[1].props.text === 'a + b = 3',
      JSON.stringify(linked.blocks[1].props),
    );

    const chained = engine.resolveBinds([
      { block_id: 'b1', type: 'paragraph', version: 1, props: { text: '源头' } },
      { block_id: 'b2', type: 'paragraph', version: 1, props: { text: '', bind: { from: 'b1', field: 'text' } } },
      { block_id: 'b3', type: 'paragraph', version: 1, props: { text: '', bind: { from: 'b2', field: 'text' } } },
    ]);
    check('块间联动：链式传递（b3 ← b2 ← b1）', chained.blocks[2].props.text === '源头', JSON.stringify(chained.blocks[2].props));

    const cyclic = engine.resolveBinds([
      { block_id: 'b1', type: 'paragraph', version: 1, props: { text: '甲', bind: { from: 'b2', field: 'text' } } },
      { block_id: 'b2', type: 'paragraph', version: 1, props: { text: '乙', bind: { from: 'b1', field: 'text' } } },
    ]);
    check(
      '检测到环 → 把环上的块降级为占位并警告，绝不死循环',
      cyclic.warnings.length >= 1 && cyclic.blocks.every((block) => !block.props.bind),
      JSON.stringify({ warnings: cyclic.warnings, props: cyclic.blocks.map((b) => b.props) }),
    );

    const missing = engine.resolveBinds([
      { block_id: 'b1', type: 'paragraph', version: 1, props: { text: '', bind: { from: 'b9', field: 'text' } } },
    ]);
    check('bind 指向不存在的块 → 警告并降级，不抛异常', missing.warnings.length === 1 && !missing.blocks[0].props.bind, JSON.stringify(missing.warnings));
  }

  /* ---------- 2.6b 联动必须活过 props 校验 ----------
     联动是跨块约定，不在任何块的 schema 里，而 `coerceProps` 会把未声明的键一律丢掉。
     不专门认下来的话，用户存了联动、再读回来就没了 —— 引擎测试全绿而产品根本没有入口。 */

  {
    const kept = engine.coerceProps(
      engine.getBlockType('paragraph'),
      { text: '本块正文', bind: { from: 'b3', field: 'text' } },
    );
    check('coerceProps 保留合法的 bind（否则联动存不进库）', kept.bind?.from === 'b3' && kept.bind?.field === 'text', JSON.stringify(kept));

    const stripped = engine.coerceProps(engine.getBlockType('paragraph'), { text: 'x', bind: { from: 'nope', field: 'text' } });
    check('coerceProps 丢掉写坏的 bind（来源不是块号）', stripped.bind === undefined, JSON.stringify(stripped));

    const stripped2 = engine.coerceProps(engine.getBlockType('paragraph'), { text: 'x', bind: { from: 'b1', field: '' } });
    check('coerceProps 丢掉缺字段名的 bind', stripped2.bind === undefined, JSON.stringify(stripped2));

    const stillWarns = engine.coerceProps(engine.getBlockType('paragraph'), { text: 'x', nonsense: 1 });
    check('未声明的字段照旧被丢掉（bind 是唯一的保留字）', stillWarns.nonsense === undefined, JSON.stringify(stillWarns));
  }

  /* ---------- 2.7 纯文本摘要（影子行的 content） ---------- */

  {
    const plain = engine.blocksToPlainText(ROUND_TRIP, 400);
    check('blocksToPlainText 能生成影子行摘要且不超长', typeof plain === 'string' && plain.length > 0 && plain.length <= 400, `len=${plain.length}`);
    const counts = engine.countBlocks(ROUND_TRIP);
    check('countBlocks 统计总数与分型', counts.total === 12 && counts.byType.paragraph === 1, JSON.stringify(counts));
  }

  /* ================= S3 接口与权限 ================= */

  console.log('\n【S3】接口与权限');

  const PASSWORD = 'docpass1234';
  const anon = createClient();
  const author = createClient();
  const mate = createClient(); // 关注了作者的人
  const other = createClient(); // 陌生人
  const staff = createClient();

  for (const [client, username] of [
    [author, 'doc_author'],
    [mate, 'doc_mate'],
    [other, 'doc_other'],
  ]) {
    const res = await client.call('/api/auth/register', { method: 'POST', body: { username, password: PASSWORD } });
    check(`注册测试账号 ${username}`, res.status === 200, `${res.status} ${JSON.stringify(res.error)}`);
  }
  {
    const login = await staff.call('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
    check('站长账号能登录（staff 越权用例要用）', login.status === 200, `${login.status} ${JSON.stringify(login.error)}`);
  }

  const authorId = (await author.call('/api/auth/me')).data?.user?.id;
  const mateId = (await mate.call('/api/auth/me')).data?.user?.id;
  check('三个测试账号都拿到了自己的 id', Number.isInteger(authorId) && Number.isInteger(mateId), `author=${authorId} mate=${mateId}`);
  {
    // 用真实关注关系，而不是借用种子里已有的关注（那些关系会让断言整组翻转）。
    const follow = await mate.call(`/api/users/${authorId}/follow`, { method: 'POST' });
    check('mate 关注了 author（followers 档要用真实关注）', follow.data?.following === true, JSON.stringify(follow.error ?? follow.data));
  }

  /* ---------- 3.1 清单接口 ---------- */

  {
    const templates = await anon.call('/api/docs/meta/templates');
    check(
      'GET /api/docs/meta/templates 匿名可读且给出 8 个模板',
      templates.status === 200 && templates.data?.templates?.length === 8,
      `${templates.status} ${JSON.stringify(templates.data).slice(0, 160)}`,
    );

    const types = await anon.call('/api/docs/meta/block-types');
    check('GET /api/docs/meta/block-types 给出 13 个内置类型', types.status === 200 && types.data?.types?.length === 13, `len=${types.data?.types?.length}`);
    check(
      '内置类型都标了 builtin:true 且带声明式 schema',
      types.data?.types?.every((type) => type.builtin === true && type.schema && typeof type.schema === 'object'),
      JSON.stringify(types.data?.types?.[0]),
    );

    // 编辑器的两个下拉框必须有唯一真相（store.listKinds / listScopes），
    // 前端自己抄一份「公开 / 仅关注我的人 / …」的话，加一档就会漏掉一处。
    check(
      'meta/templates 一并给出 kinds(3) 与 scopes(4)',
      templates.data?.kinds?.length === 3 && templates.data?.scopes?.length === 4,
      `kinds=${JSON.stringify(templates.data?.kinds)} scopes=${JSON.stringify(templates.data?.scopes)}`,
    );
    check(
      'scope 的中文名与 feed 逐字相同',
      templates.data?.scopes?.map((item) => `${item.value}:${item.label}`).join('|') ===
        'public:公开|followers:仅关注我的人|team:仅团队|private:仅自己',
      JSON.stringify(templates.data?.scopes),
    );
  }

  /* ---------- 3.2 建文档：行 + 块 + 影子行 + revision 1 ---------- */

  const publicDocId = 0;
  const publicAnchorId = 0;
  let docId = 0;
  let anchorId = 0;
  {
    const res = await author.call('/api/docs', {
      method: 'POST',
      body: { title: '第一篇积木', kind: 'post', scope: 'public', template: 'blank' },
    });
    check('POST /api/docs 建文档（作者）', res.status === 200 && Number.isInteger(res.data?.doc?.id), `${res.status} ${JSON.stringify(res.error ?? res.body).slice(0, 240)}`);
    docId = res.data.doc.id;
    anchorId = res.data.doc.anchorPostId;
    check('模板 blank 给了 1 块且块号是 b1', res.data.blocks?.length === 1 && res.data.blocks[0].blockId === 'b1', JSON.stringify(res.data.blocks));
    check('响应带 abilities.canEdit=true（作者）', res.data.abilities?.canEdit === true, JSON.stringify(res.data.abilities));
    check('响应带 doc.anchorPostId（影子行 id）', Number.isInteger(anchorId) && anchorId > 0, `anchor=${anchorId}`);

    const row = scalar('SELECT id, title, kind, scope, anchor_post_id, deleted FROM documents WHERE id = ?', docId);
    check('库里 documents 有这一行，锚点 id 已写回', row?.id === docId && Number(row.anchor_post_id) === anchorId, JSON.stringify(row));

    const anchor = scalar('SELECT id, board_id, user_id, title, deleted, hidden FROM posts WHERE id = ?', anchorId);
    check('影子行写进了 posts 且 deleted=0（互动接口只认 deleted=0）', anchor?.deleted === 0 && anchor?.user_id === authorId, JSON.stringify(anchor));
    check('public 文档的影子行 hidden=0（旧列表能看见它）', anchor?.hidden === 0, JSON.stringify(anchor));
    check('public 文档的影子行同步了标题', anchor?.title === '第一篇积木', String(anchor?.title));

    const board = scalar('SELECT id, slug, name FROM boards WHERE slug = ?', DOC_BOARD_SLUG);
    check('系统板块「积木」被惰性创建出来', board?.slug === DOC_BOARD_SLUG, JSON.stringify(board));
    check('影子行挂在系统板块下（posts.board_id 是 NOT NULL 外键）', Number(anchor?.board_id) === Number(board?.id), `${anchor?.board_id} vs ${board?.id}`);

    const revision = scalar('SELECT revision, reason, author_id FROM document_revisions WHERE document_id = ? ORDER BY revision', docId);
    check('建完写了 revision 1（reason=create）', revision?.revision === 1 && revision?.reason === 'create', JSON.stringify(revision));

    const boards = await anon.call('/api/site');
    check(
      '系统板块也出现在 /api/site 的板块表里（旧前端不用改就能看见它）',
      JSON.stringify(boards.data ?? {}).includes(DOC_BOARD_SLUG),
      JSON.stringify(boards.data ?? {}).slice(0, 200),
    );
  }

  /* ---------- 3.3 详情与渲染降级 ---------- */

  {
    const res = await anon.call(`/api/docs/${docId}`);
    check('匿名能读 public 文档', res.status === 200 && res.data?.doc?.id === docId, `${res.status} ${JSON.stringify(res.error)}`);
    check('详情返回渲染好的 html（含 doc-block）', typeof res.data?.html === 'string' && res.data.html.includes('doc-block'), String(res.data?.html).slice(0, 160));
    check('详情返回 blocks 与 warnings 数组', Array.isArray(res.data?.blocks) && Array.isArray(res.data?.warnings), JSON.stringify(Object.keys(res.data ?? {})));
    check('匿名读到的 abilities.canEdit=false', res.data?.abilities?.canEdit === false, JSON.stringify(res.data?.abilities));

    const missing = await anon.call('/api/docs/999999');
    check('不存在的文档 → 404 not_found', missing.status === 404 && missing.error?.code === 'not_found', `${missing.status} ${JSON.stringify(missing.error)}`);
  }

  /* ---------- 3.4 块：增 / 改 / 移 / 重排 / 删 ---------- */

  let headingId = '';
  {
    const add = await author.call(`/api/docs/${docId}/blocks`, {
      method: 'POST',
      body: { type: 'heading', props: { text: '新的头', level: 2 }, after: 'start' },
    });
    check('POST 插块（插到最前面）', add.status === 200 && add.data?.block?.type === 'heading', `${add.status} ${JSON.stringify(add.error ?? add.data).slice(0, 200)}`);
    headingId = add.data.block.blockId;
    check('新块拿到新块号（块号只增不减）', headingId === 'b2', headingId);

    const rows = withDb((db) => db.prepare('SELECT block_id, position FROM document_blocks WHERE document_id = ? ORDER BY position').all(docId));
    check('插到最前面是靠更小的 position，而不是重排后续块', Number(rows[0].position) < Number(rows[1].position), JSON.stringify(rows));

    const mid = await author.call(`/api/docs/${docId}/blocks`, {
      method: 'POST',
      body: { type: 'paragraph', props: { text: '夹在中间' }, after: headingId },
    });
    check('POST 插在中间', mid.status === 200, `${mid.status} ${JSON.stringify(mid.error)}`);
    const midRows = withDb((db) => db.prepare('SELECT block_id, position FROM document_blocks WHERE document_id = ? ORDER BY position').all(docId));
    const midPos = Number(midRows.find((row) => row.block_id === mid.data.block.blockId)?.position);
    check(
      '中点写成一个严格介于两侧的数（验收 ②：不必重排后续块）',
      midRows.some((row) => Number(row.position) < midPos) && midRows.some((row) => Number(row.position) > midPos),
      `${midPos} in ${JSON.stringify(midRows)}`,
    );

    const updated = await author.call(`/api/docs/${docId}/blocks/${headingId}`, {
      method: 'PUT',
      body: { props: { text: '改过的头', level: 3 } },
    });
    check(
      'PUT 改块的 props',
      updated.status === 200 && updated.data?.block?.props?.text === '改过的头' && updated.data.block.props.level === 3,
      `${updated.status} ${JSON.stringify(updated.error ?? updated.data)}`,
    );

    const moved = await author.call(`/api/docs/${docId}/blocks/${headingId}/move`, { method: 'POST', body: { after: 'b1' } });
    check('POST 换位（挪到 b1 后面）', moved.status === 200 && moved.data?.blocks?.at(-1)?.blockId === headingId, `${moved.status} ${JSON.stringify(moved.error ?? moved.data?.blocks)}`);

    const order = moved.data.blocks.map((block) => block.blockId).reverse();
    const reordered = await author.call(`/api/docs/${docId}/reorder`, { method: 'POST', body: { order } });
    check(
      'POST reorder 一次落下完整顺序（拖拽用的就是这个）',
      reordered.status === 200 && JSON.stringify(reordered.data?.blocks?.map((block) => block.blockId)) === JSON.stringify(order),
      `${reordered.status} ${JSON.stringify(reordered.error ?? reordered.data?.blocks)}`,
    );

    const bad = await author.call(`/api/docs/${docId}/blocks`, { method: 'POST', body: { type: 'not_a_type', props: {} } });
    check('未注册的块类型 → 400（不是 500）', bad.status === 400, `${bad.status} ${JSON.stringify(bad.error)}`);

    const missing = await author.call(`/api/docs/${docId}/blocks/b999`, { method: 'DELETE' });
    check('删不存在的块 → 404（不是 500）', missing.status === 404, `${missing.status} ${JSON.stringify(missing.error)}`);

    const removed = await author.call(`/api/docs/${docId}/blocks/${headingId}`, { method: 'DELETE' });
    check('DELETE 删块', removed.status === 200 && removed.data?.deleted === true, `${removed.status} ${JSON.stringify(removed.error)}`);
  }

  /* ---------- 3.4b 块间联动必须真的能存能渲染（端到端） ----------
     S2 直接调 `resolveBinds` 是绿的，但那条路径绕过了保存层。这里从 HTTP 走一遍，
     确保「存了联动 → 库里有 → 渲染时生效」整条链是真的通的。 */

  {
    const created = await author.call('/api/docs', { method: 'POST', body: { title: '联动试验', kind: 'post', scope: 'public' } });
    const linkDoc = created.data?.doc?.id;
    check('联动试验文档建得出来', Number.isInteger(linkDoc), `${created.status} ${JSON.stringify(created.error)}`);

    await author.call(`/api/docs/${linkDoc}/markdown?confirm=1`, { method: 'PUT', body: { markdown: '甲段的正文' } });
    const seedBlocks = (await author.call(`/api/docs/${linkDoc}`)).data?.blocks ?? [];
    const sourceId = seedBlocks[0]?.blockId;
    check('联动试验有了源块', Boolean(sourceId), JSON.stringify(seedBlocks));

    const target = await author.call(`/api/docs/${linkDoc}/blocks`, {
      method: 'POST',
      body: { type: 'paragraph', props: { text: '本块会被覆盖', bind: { from: sourceId, field: 'text' } } },
    });
    check('存带 bind 的块 → 200', target.status === 200, `${target.status} ${JSON.stringify(target.error)}`);
    const targetId = target.data?.blocks?.find((block) => block.type === 'paragraph' && block.props?.bind)?.blockId;
    check('bind 活过了保存层（读回来还在）', Boolean(targetId), JSON.stringify(target.data?.blocks));

    const rendered = await author.call(`/api/docs/${linkDoc}`);
    check(
      '渲染时联动生效：目标块显示的是源块的正文',
      String(rendered.data?.html ?? '').includes('甲段的正文'),
      String(rendered.data?.html ?? '').slice(0, 300),
    );

    const broken = await author.call(`/api/docs/${linkDoc}/blocks/${targetId}`, {
      method: 'PUT',
      body: { props: { text: '自己写的正文', bind: { from: 'b999', field: 'text' } } },
    });
    check('把 bind 改指不存在的块照样存得下（渲染时才降级）', broken.status === 200, `${broken.status} ${JSON.stringify(broken.error)}`);
    const afterBroken = await author.call(`/api/docs/${linkDoc}`);
    check(
      '指空的联动 → 警告 + 退回自己的正文，不崩',
      (afterBroken.data?.warnings ?? []).length >= 1 && String(afterBroken.data?.html ?? '').includes('自己写的正文'),
      JSON.stringify(afterBroken.data?.warnings),
    );

    await author.call(`/api/docs/${linkDoc}`, { method: 'DELETE' });
  }

  /* ---------- 3.5 两种编辑模式：Markdown 双向 ---------- */

  const MARKDOWN = '# 一级标题\n\n一段正文\n\n- 甲';
  {
    const before = await author.call(`/api/docs/${docId}/markdown`);
    check('GET markdown 给出当前块序列的投影', before.status === 200 && typeof before.data?.markdown === 'string' && before.data.title === '第一篇积木', `${before.status} ${JSON.stringify(before.error)}`);

    const put = await author.call(`/api/docs/${docId}/markdown`, { method: 'PUT', body: { markdown: MARKDOWN } });
    check('PUT markdown 整篇覆盖 → 块序列被重建', put.status === 200 && put.data?.blocks?.length === 3, `${put.status} ${JSON.stringify(put.error ?? put.data?.blocks)}`);
    check(
      '覆盖后的块类型与 markdown 对得上',
      put.data?.blocks?.map((block) => block.type).join(',') === 'heading,paragraph,list',
      put.data?.blocks?.map((block) => block.type).join(','),
    );

    const round = await author.call(`/api/docs/${docId}/markdown`);
    check('再读回来与写进去的 markdown 一致（FR-DOC-02 的双向同步）', round.data?.markdown?.trim() === MARKDOWN.trim(), JSON.stringify(round.data?.markdown));
  }

  /* ---------- 3.6 批量 op：一条坏的不能拖垮整批 ---------- */

  {
    const res = await author.call(`/api/docs/${docId}/ops`, {
      method: 'POST',
      body: {
        ops: [
          { kind: 'insert', after: 'start', type: 'quote', props: { text: '开头引用', source: '' } },
          { kind: 'replace', target: 'b1', props: { text: '替换后的标题', level: 1 } },
          { kind: 'nope', target: 'b1' },
          { kind: 'delete', target: 'b999' },
        ],
      },
    });
    check(
      'POST ops：两条好的生效、两条坏的只跳过自己',
      res.status === 200 && res.data?.applied?.length === 2 && res.data?.rejected?.length === 2,
      `${res.status} ${JSON.stringify(res.error ?? { applied: res.data?.applied, rejected: res.data?.rejected })}`,
    );
    check(
      '被拒的 op 带 reason 与给人看的中文 message',
      res.data?.rejected?.some((item) => item.reason === 'unknown_kind' && item.message) && res.data.rejected.some((item) => item.reason === 'bad_target'),
      JSON.stringify(res.data?.rejected),
    );
    check('生效的 insert 排在开头（同一批里后面的 op 也能引用新块）', res.data?.document?.blocks?.[0]?.type === 'quote', JSON.stringify(res.data?.document?.blocks?.map((block) => block.type)));
    check('生效的 replace 改掉了 b1 的正文', res.data?.document?.blocks?.[1]?.props?.text === '替换后的标题', JSON.stringify(res.data?.document?.blocks?.[1]?.props));
  }

  /* ---------- 3.7 修订与回滚 ---------- */

  {
    const revs = await author.call(`/api/docs/${docId}/revisions`);
    check('GET revisions 列出多条修订', revs.status === 200 && (revs.data?.revisions?.length ?? 0) >= 4, `len=${revs.data?.revisions?.length}`);
    check(
      '修订带 reasonLabel 与作者（Wiki 模板的「修订记录」直接显示它）',
      revs.data?.revisions?.every((item) => item.reasonLabel && item.author),
      JSON.stringify(revs.data?.revisions?.[0]),
    );

    const target = revs.data.revisions.find((item) => item.reason === 'create');
    const rollback = await author.call(`/api/docs/${docId}/rollback`, { method: 'POST', body: { revision: target.revision } });
    check(
      'POST rollback 回到那条修订的块序列',
      rollback.status === 200 && rollback.data?.blocks?.length === 1 && rollback.data.blocks[0].blockId === 'b1',
      `${rollback.status} ${JSON.stringify(rollback.error ?? rollback.data?.blocks)}`,
    );

    const after = await author.call(`/api/docs/${docId}/revisions`);
    check('回滚本身也记一条 reason=rollback 的修订（历史不会被改写）', after.data?.revisions?.[0]?.reason === 'rollback', JSON.stringify(after.data?.revisions?.[0]));

    const nope = await author.call(`/api/docs/${docId}/rollback`, { method: 'POST', body: { revision: 9999 } });
    check('回滚到不存在的修订 → 404', nope.status === 404, `${nope.status} ${JSON.stringify(nope.error)}`);
  }

  /* ---------- 3.8 导出 / 导入 ---------- */

  let importedDocId = 0;
  {
    const exported = await author.call(`/api/docs/${docId}/export`);
    check('GET export 给出 forum-doc/1', exported.status === 200 && exported.data?.format === 'forum-doc/1' && Array.isArray(exported.data.blocks), `${exported.status} ${JSON.stringify(exported.error)}`);

    const imported = await author.call('/api/docs/meta/import', { method: 'POST', body: { payload: exported.data, scope: 'private' } });
    check('POST meta/import 建出一篇新文档', imported.status === 200 && imported.data?.doc?.id !== docId, `${imported.status} ${JSON.stringify(imported.error ?? imported.data?.doc)}`);
    importedDocId = imported.data.doc.id;
    check(
      '导入后块序列一致，但 blockId 重新分配',
      JSON.stringify(imported.data.blocks.map((block) => [block.blockId, block.type])) ===
        JSON.stringify(exported.data.blocks.map((block, index) => [`b${index + 1}`, block.type])),
      JSON.stringify(imported.data?.blocks),
    );

    const badFormat = await author.call('/api/docs/meta/import', { method: 'POST', body: { payload: { format: 'nope', blocks: [] } } });
    check('导入不认识的格式 → 400', badFormat.status === 400, `${badFormat.status} ${JSON.stringify(badFormat.error)}`);
  }

  /* ---------- 3.9 权限矩阵（每一条都换账号发请求，不看前端藏没藏） ---------- */

  let privateDocId = 0;
  let followersDocId = 0;
  {
    const priv = await author.call('/api/docs', { method: 'POST', body: { title: '私密草稿', kind: 'note', scope: 'private' } });
    const foll = await author.call('/api/docs', { method: 'POST', body: { title: '只给关注者', kind: 'post', scope: 'followers' } });
    check('能建 private / followers 文档', priv.status === 200 && foll.status === 200, `${priv.status} / ${foll.status} ${JSON.stringify(priv.error ?? foll.error)}`);
    privateDocId = priv.data.doc.id;
    followersDocId = foll.data.doc.id;

    const anonRead = await anon.call(`/api/docs/${privateDocId}`);
    check('匿名读 private → 401 unauthenticated（不是 404，也不是 200）', anonRead.status === 401 && anonRead.error?.code === 'unauthenticated', `${anonRead.status} ${JSON.stringify(anonRead.error)}`);

    const otherRead = await other.call(`/api/docs/${privateDocId}`);
    check('陌生人读 private → 404（不是 403 —— 403 会顺带泄露"这篇存在"）', otherRead.status === 404, `${otherRead.status} ${JSON.stringify(otherRead.error)}`);

    const staffRead = await staff.call(`/api/docs/${privateDocId}`);
    check('staff 能读 private（设计文档 §2.6 有意与 feed 不同，别按 feed 改回来）', staffRead.status === 200, `${staffRead.status} ${JSON.stringify(staffRead.error)}`);

    const mateRead = await mate.call(`/api/docs/${followersDocId}`);
    check('关注者能读 followers 文档', mateRead.status === 200, `${mateRead.status} ${JSON.stringify(mateRead.error)}`);

    const otherReadF = await other.call(`/api/docs/${followersDocId}`);
    check('没关注的人读 followers → 404', otherReadF.status === 404, `${otherReadF.status}`);

    const otherEdit = await other.call(`/api/docs/${docId}`, { method: 'PUT', body: { title: '我要改别人的' } });
    check('改别人的 public 文档 → 403（看得见但不是自己的）', otherEdit.status === 403, `${otherEdit.status} ${JSON.stringify(otherEdit.error)}`);

    const anonWrite = await anon.call('/api/docs', { method: 'POST', body: { title: '匿名发一篇' } });
    check('匿名建文档 → 401', anonWrite.status === 401, `${anonWrite.status} ${JSON.stringify(anonWrite.error)}`);

    const otherDelete = await other.call(`/api/docs/${docId}`, { method: 'DELETE' });
    check('删别人的文档 → 403', otherDelete.status === 403, `${otherDelete.status}`);

    const privAnchor = scalar('SELECT id, hidden, title, content FROM posts WHERE id = (SELECT anchor_post_id FROM documents WHERE id = ?)', privateDocId);
    check('private 文档的影子行 hidden=1（核心互动接口只认 hidden）', privAnchor?.hidden === 1, JSON.stringify(privAnchor));
    check('非 public 的影子行不写标题与摘要（少泄露一点是一点）', privAnchor?.title === '' && privAnchor?.content === '', JSON.stringify(privAnchor));

    await author.call(`/api/docs/${docId}`, { method: 'PUT', body: { scope: 'followers' } });
    check('改 scope 之后影子行 hidden 跟着变（否则旧列表还在展示它）', scalar('SELECT hidden FROM posts WHERE id = ?', anchorId)?.hidden === 1);
    await author.call(`/api/docs/${docId}`, { method: 'PUT', body: { scope: 'public' } });
    check('改回 public 之后影子行恢复可见', scalar('SELECT hidden FROM posts WHERE id = ?', anchorId)?.hidden === 0);

    const mateView = await mate.call(`/api/docs/${followersDocId}`);
    check(
      'followers 文档对关注者的 abilities.canReact=false（诚实暴露已知短板，免得前端给一个点了就 404 的按钮）',
      mateView.data?.abilities?.canReact === false,
      JSON.stringify(mateView.data?.abilities),
    );
    const authorView = await author.call(`/api/docs/${followersDocId}`);
    check('作者自己的 followers 文档 canReact=true（core 的 assertPostVisible 放行作者）', authorView.data?.abilities?.canReact === true, JSON.stringify(authorView.data?.abilities));
  }

  /* ---------- 3.10 既有互动链路零改动复用（FR-KEEP 的正面证据） ---------- */

  {
    const like = await other.call(`/api/posts/${anchorId}/reaction`, { method: 'POST', body: { kind: 'like' } });
    check('陌生人能给文档的影子行点赞（core 的赞接口一行没改）', like.status === 200 && like.data?.liked === true, `${like.status} ${JSON.stringify(like.error)}`);

    const bookmark = await other.call(`/api/posts/${anchorId}/bookmark`, { method: 'POST' });
    check('收藏走的也是同一个影子行', bookmark.status === 200, `${bookmark.status} ${JSON.stringify(bookmark.error)}`);

    const coin = await other.call(`/api/posts/${anchorId}/coin`, { method: 'POST', body: { amount: 1 } });
    check('投币也能投给文档的影子行', coin.status === 200, `${coin.status} ${JSON.stringify(coin.error)}`);

    const post = await other.call(`/api/posts/${anchorId}`);
    check('旧帖子详情接口能打开影子行，标题就是文档标题', post.status === 200 && JSON.stringify(post.data ?? {}).includes('第一篇积木'), `${post.status} ${JSON.stringify(post.error ?? post.data).slice(0, 160)}`);
  }

  /* ---------- 3.11 列表与可见范围 ---------- */

  {
    const anonList = await anon.call('/api/docs');
    check('GET /api/docs 匿名可读，且只看到 public 文档', anonList.status === 200 && anonList.data?.documents?.every((item) => item.scope === 'public'), JSON.stringify(anonList.data?.documents?.map((item) => [item.id, item.scope])));
    check('匿名列表里没有 private / followers 文档', !anonList.data?.documents?.some((item) => item.id === privateDocId || item.id === followersDocId));

    const mine = await author.call('/api/docs?mine=1');
    check('?mine=1 只返回自己的文档', mine.status === 200 && mine.data?.documents?.every((item) => item.author.id === authorId), JSON.stringify(mine.data?.documents?.map((item) => item.author?.username)));

    const anonMine = await anon.call('/api/docs?mine=1');
    check('匿名 ?mine=1 返回空列表（列表接口匿名可读，不是 401）', anonMine.status === 200 && anonMine.data?.documents?.length === 0, `${anonMine.status} ${JSON.stringify(anonMine.data)}`);

    const byKind = await author.call('/api/docs?kind=note&mine=1');
    check('?kind=note 过滤生效', byKind.status === 200 && byKind.data?.documents?.every((item) => item.kind === 'note'), JSON.stringify(byKind.data?.documents?.map((item) => item.kind)));

    const typed = await author.call('/api/docs?kind=nonsense&mine=1');
    check('不认识的 kind 被忽略而不是 500', typed.status === 200, `${typed.status} ${JSON.stringify(typed.error)}`);
  }

  /* ---------- 3.12 自定义块类型（FR-BLOCK-04 的唯一诚实实现） ---------- */

  {
    const bad = await author.call('/api/docs/meta/block-types', { method: 'POST', body: { name: 'Heading' } });
    check('注册名不合法 → 400', bad.status === 400, `${bad.status} ${JSON.stringify(bad.error)}`);

    const builtin = await author.call('/api/docs/meta/block-types', { method: 'POST', body: { name: 'heading' } });
    check('用内置名注册 → 409 conflict（内置是冻结契约）', builtin.status === 409, `${builtin.status} ${JSON.stringify(builtin.error)}`);

    const created = await author.call('/api/docs/meta/block-types', {
      method: 'POST',
      body: { name: 'timeline', label: '时间线', icon: '🕒', propsSchema: { text: { type: 'string', default: '' } } },
    });
    check('登录用户能注册新块类型（不需要改核心代码）', created.status === 200 && created.data?.type?.name === 'timeline', `${created.status} ${JSON.stringify(created.error)}`);

    const again = await author.call('/api/docs/meta/block-types', { method: 'POST', body: { name: 'timeline' } });
    check('重名再注册 → 409', again.status === 409, `${again.status} ${JSON.stringify(again.error)}`);

    const types = await anon.call('/api/docs/meta/block-types');
    const timeline = types.data?.types?.find((type) => type.name === 'timeline');
    check(
      '注册表变成 14 种，新类型 builtin=false 且带自己的 schema',
      types.data?.types?.length === 14 && timeline?.builtin === false && timeline?.schema?.text,
      JSON.stringify(timeline),
    );

    const added = await author.call(`/api/docs/${followersDocId}/blocks`, { method: 'POST', body: { type: 'timeline', props: { text: '2026-10-05 开工' } } });
    check('能用刚注册的类型建块', added.status === 200, `${added.status} ${JSON.stringify(added.error)}`);

    const view = await author.call(`/api/docs/${followersDocId}`);
    check('自定义类型渲染成 doc-block-timeline', String(view.data?.html).includes('doc-block-timeline'), String(view.data?.html).slice(0, 160));
    check('用自定义类型渲染没有降级警告', view.data?.warnings?.length === 0, JSON.stringify(view.data?.warnings));
  }

  /* ---------- 3.13 删除：文档与影子行一起走 ---------- */

  {
    const del = await author.call(`/api/docs/${importedDocId}`, { method: 'DELETE' });
    check('DELETE 软删文档', del.status === 200 && del.data?.deleted === true, `${del.status} ${JSON.stringify(del.error)}`);

    const gone = await author.call(`/api/docs/${importedDocId}`);
    check('删掉的文档读不到（404）', gone.status === 404, `${gone.status}`);

    const anchor = scalar('SELECT deleted FROM posts WHERE id = (SELECT anchor_post_id FROM documents WHERE id = ?)', importedDocId);
    check('影子行跟着 deleted=1（否则旧列表还留着它）', anchor?.deleted === 1, JSON.stringify(anchor));

    const twice = await author.call(`/api/docs/${importedDocId}`, { method: 'DELETE' });
    check('重复删除 → 404（不是 500）', twice.status === 404, `${twice.status} ${JSON.stringify(twice.error)}`);
  }

  /* ---------- S4 前端接线 ---------- */

  console.log('\n【S4】前端接线');

  {
    const readText = (relative) => {
      const full = join(ROOT, ...relative.split('/'));
      return existsSync(full) ? readFileSync(full, 'utf8') : '';
    };

    for (const file of ['public/views/doc.js', 'public/views/doc-blocks.js', 'public/css/41-doc.css']) {
      const text = readText(file);
      // 只看「文件在不在、有没有内容」，具体渲染由 check-frontend / check-ui-contract 管。
      check(`${file} 存在且不是空壳`, text.length > 500, `${text.length} 字符`);
    }

    const style = readText('public/style.css');
    check('style.css 里拉了 41-doc.css', style.includes('./css/41-doc.css'), style.slice(0, 80));

    const router = readText('public/core/router.js');
    check('router.js 引了 views/doc.js', router.includes("from '../views/doc.js'"), '');
    for (const [name, needle] of [
      ['#/docs', "first === 'docs'"],
      ['#/doc/:id', "first === 'doc' && second"],
      ['#/doc/:id/edit', "parts[2] === 'edit'"],
      ['#/doc/:id/blocks', "parts[2] === 'blocks'"],
      ['#/blocks', "first === 'blocks'"],
    ]) {
      check(`router.js 认得 ${name}`, router.includes(needle), needle);
    }
    // 编辑页必须排在阅读页之前，否则 `/doc/3/edit` 会被当成 id 是 3 的阅读页（丢掉第三段）。
    check(
      'router.js 里 /doc/:id/edit 排在 /doc/:id 之前',
      router.indexOf('Doc.viewDocEdit') >= 0 && router.indexOf('Doc.viewDocEdit') < router.indexOf('Doc.viewDoc('),
      '顺序反了的话编辑页永远打不开',
    );

    const session = readText('public/core/session.js');
    check('侧栏挂了积木广场的入口', session.includes('href="#/docs"'), '');

    const frontend = readText('scripts/check-frontend.mjs');
    check(
      'check-frontend 的 CASES 里加了积木的页面',
      ['积木广场', '积木阅读页', '积木编辑器', '积木 Markdown 模式', '块类型表'].every((label) => frontend.includes(label)),
      '',
    );

    // §5.1 的两件外挂：实时 LaTeX 预览（复用 /api/markdown/preview）与 AI 抽屉（复用 NotesAgent）。
    // 它们都是「嵌得进去」就够，所以只钉接线本身，不钉面板内部。
    const editorJs = readText('public/views/doc.js');
    check('编辑器接了实时预览', editorJs.includes("'/api/markdown/preview'"), '');
    check('预览是防抖自动跑的（不是按钮）', editorJs.includes('mdPreviewTimer') && editorJs.includes('setTimeout'), '');
    check('编辑器挂了 AI 抽屉', editorJs.includes('window.NotesAgent') && editorJs.includes('createTextareaAdapter'), '');
    check(
      'Markdown 编辑区带 name="content"（NotesAgent 靠它找编辑区）',
      editorJs.includes('name="content"'),
      '改了它就挂不上 AI 抽屉',
    );
    check('离开页面时收掉预览定时器与 AI 抽屉', editorJs.includes('mdNotesPanel.destroy()'), '');

    const docCss = readText('public/css/41-doc.css');
    for (const cls of ['.doc-md-grid', '.doc-md-edit', '.doc-md-side', '.doc-md-preview']) {
      check(`41-doc.css 定义了 ${cls}`, docCss.includes(cls), '');
    }

    // 阅读态的 HTML 由后端出，前端不许自己再实现一遍渲染 —— 实现两遍就一定会漂移。
    const docView = readText('public/views/doc.js');
    check('前端用后端给的 html，没有自己实现块渲染', docView.includes('data.html') && !/function\s+renderBlock\b/.test(docView), '正文 HTML 必须来自后端');
  }

  /* ---------- S5 沙箱 ---------- */

  console.log('\n【S5】沙箱');

  {
    const engine = await import('../src/modules/doc/blocks/index.js');
    const schema = await import('../src/modules/doc/schema.js');

    // 5.1 服务端只拼文档，从不执行用户代码
    const sandboxDoc = engine.buildSandboxDocument('<h1>hi</h1>');
    check(
      '沙箱文档自带 doctype 与 CSP',
      sandboxDoc.startsWith('<!doctype html>') && sandboxDoc.includes("default-src 'none'"),
      sandboxDoc.slice(0, 60),
    );
    check('用户代码原样放进 body（它想写 HTML 就写 HTML）', sandboxDoc.includes('<h1>hi</h1>'), '');
    check('沙箱文档定义了 window.Sandbox 握手对象', sandboxDoc.includes('window.Sandbox'), '');
    check(
      'CSP 里没有任何一条外部资源许可',
      !/img-src|connect-src|frame-src|font-src|media-src/.test(sandboxDoc),
      '多一条就多一条外联通道',
    );

    // 5.2 玻璃房的隔离属性
    const inner = engine.sandboxInner({ app: '小抄', code: '<h1>hi</h1>' }, { block_id: 'b1' }, {});
    check('app 块渲染出 iframe', inner.includes('<iframe') && inner.includes('class="doc-app-frame"'), inner.slice(0, 70));
    check('玻璃房给了 allow-scripts', inner.includes('sandbox="allow-scripts"'), '');
    check(
      '玻璃房**没有** allow-same-origin（否则等于没沙箱）',
      !inner.includes('allow-same-origin'),
      '给了它就能摸到父页面的 localStorage 与 cookie',
    );
    check(
      '整份文档被转义进 srcdoc 属性（代码逃不出这个属性）',
      inner.includes('srcdoc="') && inner.includes('&lt;h1&gt;hi&lt;/h1&gt;') && !inner.includes('<h1>hi</h1>'),
      '',
    );

    // 5.3 两条降级链
    const noCode = engine.sandboxInner({ app: '空的', code: '' }, { block_id: 'b2' }, {});
    check('没写代码 → 占位，不建 iframe', noCode.includes('doc-app-empty') && !noCode.includes('<iframe'), '');
    const turnedOff = engine.sandboxInner({ app: 'x', code: 'Sandbox.value(1)' }, { block_id: 'b3' }, { sandboxDisabled: true });
    check('沙箱被禁用 → 占位，连 iframe 都不建', turnedOff.includes('doc-app-disabled') && !turnedOff.includes('<iframe'), '');

    // 5.4 代码长度在**保存时**卡住（不能靠 coerceProps 静默截断 —— 半截程序更危险）
    const tooLong = await author.call(`/api/docs/${docId}/blocks`, {
      method: 'POST',
      body: { type: 'app', props: { app: '太大', code: 'x'.repeat(schema.MAX_APP_CODE + 1) } },
    });
    check('代码超长在保存时就 400', tooLong.status === 400, `${tooLong.status} ${JSON.stringify(tooLong.error)}`);

    const addedApp = await author.call(`/api/docs/${docId}/blocks`, {
      method: 'POST',
      body: { type: 'app', props: { app: '测试小应用', code: '<button id="go">点我</button>' } },
    });
    check('没超长的代码存得下', addedApp.status === 200, `${addedApp.status} ${JSON.stringify(addedApp.error)}`);
    const appBlockId = addedApp.data?.block?.blockId ?? '';
    check('存下来的 app 块带着 code', typeof addedApp.data?.block?.props?.code === 'string', JSON.stringify(addedApp.data?.block?.props));

    const withFrame = await anon.call(`/api/docs/${docId}`);
    check(
      '详情页 HTML 里真的有沙箱 iframe',
      String(withFrame.data?.html ?? '').includes('doc-app-frame'),
      '',
    );
    check(
      '那一条不是降级产物',
      !(withFrame.data?.warnings ?? []).some((warn) => warn.block_id === appBlockId),
      JSON.stringify(withFrame.data?.warnings ?? []),
    );

    // 5.5 能力白名单 + 审计（被拒的也要留痕）
    const allowed = await mate.call(`/api/docs/${docId}/capabilities`, {
      method: 'POST',
      body: { blockId: appBlockId, capability: 'doc-meta' },
    });
    check('白名单里的能力申请得到放行', allowed.status === 200 && allowed.data?.value?.title, `${allowed.status} ${JSON.stringify(allowed.error)}`);
    check('放行值只有文档的公开元信息', !JSON.stringify(allowed.data?.value ?? {}).includes('scope'), JSON.stringify(allowed.data?.value));

    const denied = await mate.call(`/api/docs/${docId}/capabilities`, {
      method: 'POST',
      body: { blockId: appBlockId, capability: 'user-token' },
    });
    check('白名单之外的能力被拒（403）', denied.status === 403, `${denied.status}`);

    const logCount = scalar('SELECT COUNT(*) AS n FROM doc_capability_logs WHERE document_id = ?', docId)?.n;
    check('两次申请都进了审计表', logCount === 2, `${logCount}`);
    const deniedLogged = scalar(
      'SELECT COUNT(*) AS n FROM doc_capability_logs WHERE document_id = ? AND allowed = 0',
      docId,
    )?.n;
    check('被拒绝的那次也留了痕', deniedLogged === 1, `${deniedLogged}`);
    const loggedBlock = scalar(
      'SELECT block_id FROM doc_capability_logs WHERE document_id = ? ORDER BY id DESC LIMIT 1',
      docId,
    )?.block_id;
    check('审计记下了是哪个块申请的', loggedBlock === appBlockId, `${loggedBlock} vs ${appBlockId}`);

    // 5.6 审计清单只给 staff
    const logsForOther = await other.call(`/api/docs/${docId}/capabilities`);
    check('普通用户看不了审计清单（403）', logsForOther.status === 403, `${logsForOther.status}`);
    const logsForStaff = await staff.call(`/api/docs/${docId}/capabilities`);
    check('staff 能看审计清单', logsForStaff.status === 200 && (logsForStaff.data?.logs ?? []).length === 2, `${logsForStaff.status} ${JSON.stringify(logsForStaff.data)}`);

    // 5.7 逃生开关：只有 staff 能关，关掉之后所有 app 块退化成占位
    const offByOther = await other.call(`/api/docs/${docId}/sandbox`, { method: 'POST', body: { disabled: true } });
    check('普通用户关不了沙箱（403）', offByOther.status === 403, `${offByOther.status}`);
    const offByStaff = await staff.call(`/api/docs/${docId}/sandbox`, { method: 'POST', body: { disabled: true } });
    check('staff 关得掉沙箱', offByStaff.status === 200 && offByStaff.data?.sandboxDisabled === true, `${offByStaff.status}`);
    const offView = await anon.call(`/api/docs/${docId}`);
    check(
      '关掉之后 HTML 里不再有 iframe，只剩「已禁用」占位',
      String(offView.data?.html ?? '').includes('doc-app-disabled') && !String(offView.data?.html ?? '').includes('doc-app-frame'),
      '',
    );
    const backOn = await staff.call(`/api/docs/${docId}/sandbox`, { method: 'POST', body: { disabled: false } });
    check('能再打开，iframe 回来', backOn.status === 200 && backOn.data?.sandboxDisabled === false, `${backOn.status}`);
    const onView = await anon.call(`/api/docs/${docId}`);
    check('打开后 iframe 又回来了', String(onView.data?.html ?? '').includes('doc-app-frame'), '');

    // 5.8 前端宿主（白名单 / 看门狗 / 频率上限都不许少）
    const readText = (relative) => {
      const full = join(ROOT, ...relative.split('/'));
      return existsSync(full) ? readFileSync(full, 'utf8') : '';
    };
    const host = readText('public/core/sandbox.js');
    check('前端宿主 public/core/sandbox.js 存在且不是空壳', host.length > 500, `${host.length} 字符`);
    check('宿主只认四种消息', ['ready', 'resize', 'value', 'request'].every((type) => host.includes(`'${type}'`)), '');
    check('宿主有 2 秒握手看门狗', /READY_MS\s*=\s*2000/.test(host), '');
    check('宿主有每秒 200 条的上限', /PER_SECOND\s*=\s*200/.test(host), '');
    check('能力申请转发到服务端接口，不在前端放行', host.includes('/capabilities'), '');
    check('宿主侧也没有 allow-same-origin', !host.includes('allow-same-origin'), '');

    const docView = readText('public/views/doc.js');
    check('阅读页渲染后会把沙箱挂上宿主', docView.includes('attachSandbox') && docView.includes('mountSandboxes'), '');
    check('换页时会把沙箱拆干净（否则看门狗会去动已经不在的节点）', docView.includes('unmountSandboxes'), '');

    const css = readText('public/css/41-doc.css');
    check(
      '沙箱的四种形态都有样式',
      ['.doc-app-frame', '.doc-app-disabled', '.doc-app-empty', '.doc-app-failed'].every((sel) => css.includes(sel)),
      '',
    );

    // 5.9 数据层：第五张表真的建出来了
    check(
      'doc_capability_logs 表在库里',
      (tableColumns('doc_capability_logs') ?? []).some((col) => col.name === 'capability'),
      JSON.stringify(tableColumns('doc_capability_logs')),
    );
    check(
      '审计表的索引也在',
      scalar("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_doc_capability_logs_doc'")?.name ===
        'idx_doc_capability_logs_doc',
      '',
    );
  }

  console.log('\n【S6】笔记与个人主页的接线');

  /* ---------- 6.1 数据层：第六张表 ---------- */

  {
    const cols = (tableColumns('note_documents') ?? []).map((col) => col.name);
    check(
      'note_documents 表在库里且有 user_id / note_name / document_id',
      ['user_id', 'note_name', 'document_id'].every((name) => cols.includes(name)),
      JSON.stringify(cols),
    );
    const ddl = scalar("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'note_documents'")?.sql ?? '';
    check('note_documents 的 (user_id, note_name) 是唯一的', ddl.includes('UNIQUE'), ddl.slice(0, 200));
    check(
      'note_documents 的反查索引也在（按文档找笔记）',
      Boolean(scalar("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_note_documents_doc'")),
      '',
    );
  }

  /* ---------- 6.2 导入：笔记 → 文档 ---------- */

  const NOTE_NAME = '热力学笔记';
  const NOTE_MD = '# 热力学笔记\n\n第一段正文。\n\n- 要点甲\n- 要点乙';
  const NOTE_MD2 = '# 热力学笔记\n\n改了正文。';
  let noteDocId = 0;
  {
    const anonTry = await anon.call('/api/docs/notes/import', { method: 'POST', body: { name: NOTE_NAME, markdown: NOTE_MD } });
    check('匿名导入笔记 → 401', anonTry.status === 401, `${anonTry.status} ${JSON.stringify(anonTry.error)}`);

    const res = await author.call('/api/docs/notes/import', {
      method: 'POST',
      body: { name: NOTE_NAME, title: '热力学笔记', markdown: NOTE_MD, scope: 'private' },
    });
    check(
      'POST /api/docs/notes/import 把笔记长成一份 kind=note 的文档',
      res.status === 200 && res.data?.doc?.kind === 'note' && Number.isInteger(res.data.doc.id),
      `${res.status} ${JSON.stringify(res.error ?? res.body).slice(0, 240)}`,
    );
    noteDocId = res.data?.doc?.id ?? 0;
    check('导入的块数与 Markdown 对得上（3 块）', res.data?.blocks?.length === 3, JSON.stringify(res.data?.blocks));
    check('导入的块号是 b1..bn', res.data?.blocks?.every((block, index) => block.blockId === `b${index + 1}`), JSON.stringify(res.data?.blocks?.map((b) => b.blockId)));
    check('导入出来的文档归属作者本人', res.data?.doc?.author?.id === authorId, JSON.stringify(res.data?.doc?.author));
    check('private 笔记的文档影子行 hidden=1（不该出现在帖子列表里）', (() => {
      const anchor = scalar('SELECT hidden, deleted FROM posts WHERE id = ?', res.data?.doc?.anchorPostId);
      return anchor?.hidden === 1 && anchor?.deleted === 0;
    })(), JSON.stringify(scalar('SELECT hidden, deleted FROM posts WHERE id = ?', res.data?.doc?.anchorPostId)));

    const link = scalar('SELECT user_id, note_name, document_id FROM note_documents WHERE note_name = ?', NOTE_NAME);
    check(
      'note_documents 记住了「谁的哪篇笔记 = 哪份文档」',
      link?.note_name === NOTE_NAME && Number(link?.document_id) === noteDocId && Number(link?.user_id) === authorId,
      JSON.stringify(link),
    );
    check(
      '导完写了 revision 1（reason=import）',
      scalar('SELECT revision, reason FROM document_revisions WHERE document_id = ? ORDER BY revision', noteDocId)?.reason === 'import',
      JSON.stringify(scalar('SELECT revision, reason FROM document_revisions WHERE document_id = ? ORDER BY revision', noteDocId)),
    );
  }

  /* ---------- 6.3 幂等：重复导入不该冲掉修订记录 ---------- */

  {
    const revBefore = scalar('SELECT COUNT(*) AS n FROM document_revisions WHERE document_id = ?', noteDocId)?.n;
    const again = await author.call('/api/docs/notes/import', {
      method: 'POST',
      body: { name: NOTE_NAME, title: '热力学笔记', markdown: NOTE_MD, scope: 'private' },
    });
    check('同样内容再导一次 → 同一份文档（不会长出第二篇）', again.data?.doc?.id === noteDocId, `${again.data?.doc?.id} vs ${noteDocId}`);
    check(
      '内容没变就不写修订（编辑器每次打开都调一次，否则 50 条上限当天被冲光）',
      scalar('SELECT COUNT(*) AS n FROM document_revisions WHERE document_id = ?', noteDocId)?.n === revBefore,
      `${scalar('SELECT COUNT(*) AS n FROM document_revisions WHERE document_id = ?', noteDocId)?.n} vs ${revBefore}`,
    );

    const edited = await author.call('/api/docs/notes/import', {
      method: 'POST',
      body: { name: NOTE_NAME, title: '热力学笔记', markdown: NOTE_MD2, scope: 'private' },
    });
    check('改了内容再导 → 还是同一份文档', edited.data?.doc?.id === noteDocId, `${edited.data?.doc?.id} vs ${noteDocId}`);
    check('改了内容 → 块跟着变（2 块）', edited.data?.blocks?.length === 2, JSON.stringify(edited.data?.blocks));
    check(
      '改了内容 → 写了新修订（reason=import）',
      Number(scalar("SELECT COUNT(*) AS n FROM document_revisions WHERE document_id = ? AND reason = 'import'", noteDocId)?.n) >= 2,
      String(scalar("SELECT COUNT(*) AS n FROM document_revisions WHERE document_id = ? AND reason = 'import'", noteDocId)?.n),
    );
  }

  /* ---------- 6.4 查询：笔记名 → 文档 ---------- */

  {
    const own = await author.call(`/api/docs/notes/lookup?ownerId=${authorId}&name=${encodeURIComponent(NOTE_NAME)}`);
    check('作者查自己的笔记 → found:true 且能直接渲染', own.status === 200 && own.data?.found === true && typeof own.data?.html === 'string' && own.data.html.includes('doc-block'), `${own.status} ${JSON.stringify(own.data).slice(0, 200)}`);

    const stranger = await mate.call(`/api/docs/notes/lookup?ownerId=${authorId}&name=${encodeURIComponent(NOTE_NAME)}`);
    check('别人查一篇 private 笔记 → found:false（不是 404，前端拿它当分支）', stranger.status === 200 && stranger.data?.found === false, `${stranger.status} ${JSON.stringify(stranger.data)}`);

    const nobody = await anon.call(`/api/docs/notes/lookup?ownerId=${authorId}&name=${encodeURIComponent(NOTE_NAME)}`);
    check('匿名查 private 笔记 → found:false', nobody.status === 200 && nobody.data?.found === false, JSON.stringify(nobody.data));

    const missing = await author.call(`/api/docs/notes/lookup?ownerId=${authorId}&name=${encodeURIComponent('不存在的笔记')}`);
    check('查一篇没接线的笔记 → found:false（前端退回文件路径）', missing.status === 200 && missing.data?.found === false, JSON.stringify(missing.data));

    const badOwner = await author.call(`/api/docs/notes/lookup?name=${encodeURIComponent(NOTE_NAME)}`);
    check('不给 ownerId → found:false（不 500）', badOwner.status === 200 && badOwner.data?.found === false, `${badOwner.status} ${JSON.stringify(badOwner.data)}`);

    // 公开之后，关注者也能读到积木版
    await author.call(`/api/docs/${noteDocId}`, { method: 'PUT', body: { scope: 'followers' } });
    const follower = await mate.call(`/api/docs/notes/lookup?ownerId=${authorId}&name=${encodeURIComponent(NOTE_NAME)}`);
    check('改成 followers 后，关注者能读到积木版', follower.data?.found === true && typeof follower.data?.html === 'string', JSON.stringify(follower.data).slice(0, 160));

    const anchor = scalar('SELECT hidden FROM posts WHERE id = ?', scalar('SELECT anchor_post_id AS a FROM documents WHERE id = ?', noteDocId)?.a);
    check('换成 followers 后影子行 hidden 同步成 1', anchor?.hidden === 1, JSON.stringify(anchor));
  }

  /* ---------- 6.5 个人主页：一个用户一份 profile 文档 ---------- */

  {
    const first = await other.call('/api/docs', {
      method: 'POST',
      body: { title: '我的积木主页', kind: 'profile', scope: 'public', template: 'blank' },
    });
    check('POST /api/docs kind=profile 建得出来', first.status === 200 && first.data?.doc?.kind === 'profile', `${first.status} ${JSON.stringify(first.error ?? first.body).slice(0, 200)}`);
    const profileDocId = first.data?.doc?.id ?? 0;

    const second = await other.call('/api/docs', {
      method: 'POST',
      body: { title: '第二次建主页', kind: 'profile', scope: 'public', template: 'blank' },
    });
    check('再建一份 profile → 还是原来那份（一个用户至多一份主页）', second.data?.doc?.id === profileDocId, `${second.data?.doc?.id} vs ${profileDocId}`);
    check(
      '库里确实只有一份 profile 行',
      scalar("SELECT COUNT(*) AS n FROM documents WHERE user_id = ? AND kind = 'profile' AND deleted = 0", (await other.call('/api/auth/me')).data?.user?.id)?.n === 1,
      '',
    );

    const mine = await other.call('/api/docs/profile/doc_other');
    check('GET /api/docs/profile/:username → found:true 且带渲染好的 html', mine.status === 200 && mine.data?.found === true && typeof mine.data?.html === 'string' && mine.data.html.includes('doc-block'), `${mine.status} ${JSON.stringify(mine.data).slice(0, 200)}`);

    const anonRead = await anon.call('/api/docs/profile/doc_other');
    check('匿名也能读 public 主页文档', anonRead.data?.found === true, JSON.stringify(anonRead.data));

    const ghost = await anon.call('/api/docs/profile/nobody_here');
    check('查一个没有主页文档的人 → found:false（前端退回帖子列表）', ghost.status === 200 && ghost.data?.found === false, `${ghost.status} ${JSON.stringify(ghost.data ?? ghost.error)}`);

    const weird = await anon.call('/api/docs/profile/%20%20');
    check('只有空白的用户名 → 404 或 found:false（不 500）', weird.status === 404 || weird.data?.found === false, `${weird.status} ${JSON.stringify(weird.data ?? weird.error)}`);

    const empty = await anon.call('/api/docs/profile/');
    check('空用户名 → 404 或 found:false（总之不 500）', empty.status === 404 || empty.data?.found === false, `${empty.status} ${JSON.stringify(empty.data ?? empty.error)}`);

    await other.call(`/api/docs/${profileDocId}`, { method: 'PUT', body: { scope: 'private' } });
    const hidden = await anon.call('/api/docs/profile/doc_other');
    check('主页文档改成 private 后，匿名读不到', hidden.data?.found === false, JSON.stringify(hidden.data));
    const hiddenMate = await mate.call('/api/docs/profile/doc_other');
    check('别人也读不到 private 主页文档', hiddenMate.data?.found === false, JSON.stringify(hiddenMate.data));
    const staffRead = await staff.call('/api/docs/profile/doc_other');
    check('staff 读得到 private 主页文档', staffRead.data?.found === true, JSON.stringify(staffRead.data).slice(0, 160));
    const ownerRead = await other.call('/api/docs/profile/doc_other');
    check('主人自己读得到 private 主页文档', ownerRead.data?.found === true, JSON.stringify(ownerRead.data).slice(0, 160));
  }

  /* ---------- 6.6 前端确实接上了（而且是「优先」不是「替代」） ---------- */

  {
    const readText = (relative) => {
      const full = join(ROOT, relative);
      return existsSync(full) ? readFileSync(full, 'utf8') : '';
    };
    const notesView = readText('public/views/notes.js');
    check('notes.js 会去问「这篇笔记有没有积木版」', notesView.includes('/api/docs/notes/lookup'), '');
    check('notes.js 会把笔记导成文档', notesView.includes('/api/docs/notes/import'), '');
    check('notes.js 保留了老的文件路径（接线是优先不是替代）', notesView.includes('/api/notes-square/'), '');
    check(
      'notes.js 的积木分支有兜底（退回老路径，不白屏）',
      notesView.includes('ntDocFor') && notesView.includes('async function ntDocFor(ownerId, name)'),
      '',
    );

    const userView = readText('public/views/user.js');
    check('user.js 会去问「这个人有没有积木主页」', userView.includes('/api/docs/profile/'), '');
    check('user.js 保留了老的帖子列表渲染', userView.includes('profile-posts') && userView.includes('Widgets.profilePostsHtml'), '');
    check('user.js 的积木分支有 hasProfileDoc 开关', userView.includes('hasProfileDoc'), '');

    const css = readText('public/css/41-doc.css');
    check('主页文档复用的 doc-panel / doc-body 有样式', css.includes('.doc-panel') && css.includes('.doc-body'), '');
  }

  /* ---------- 【S7】模板自检与文档一致性 ---------- */

  console.log('\n【S7】模板自检与文档');

  {
    /* 7.1 每一个内置模板，建出来都不该带降级警告。
       曾经的坑：模板里的必填字段给了空串，于是「刚建好的空白文档」满屏
       「降级」占位卡 —— 那块牌子是给坏数据用的，不该出现在模板上。 */
    const created = [];
    for (const key of ['blank', 'page', 'academic', 'wiki', 'poll', 'datatable', 'lab']) {
      const made = await staff.call('/api/docs', {
        method: 'POST',
        body: { title: `模板自检 ${key}`, kind: 'post', scope: 'private', template: key },
      });
      if (made.status !== 200) {
        check(`模板 ${key} 建得出来`, false, `${made.status} ${JSON.stringify(made.error)}`);
        continue;
      }
      created.push(made.data.doc.id);
      check(
        `模板 ${key} 渲染出来没有降级警告`,
        made.data.warnings.length === 0,
        JSON.stringify(made.data.warnings.map((item) => `${item.block_id}:${item.message}`)),
      );
    }
    for (const id of created) await staff.call(`/api/docs/${id}`, { method: 'DELETE' });

    const list = await anon.call('/api/docs/meta/templates');
    check('模板清单是 8 个', list.data?.templates?.length === 8, JSON.stringify(list.data?.templates?.length));

    const readText = (relative) => {
      const full = join(ROOT, relative);
      return existsSync(full) ? readFileSync(full, 'utf8') : '';
    };
    const templates = readText('src/modules/doc/templates.js');
    check(
      '模板源码里不再有「必填字段给空串」的写法',
      !/text: ''\s*}/.test(templates),
      '模板里的 text 空串会让新文档直接降级',
    );

    /* 7.2 README 的接口清单、路由表、数据模型都得跟上，否则文档就是过期的谎言。 */
    const readme = readText('README.md');
    check('README 路由表收录了积木五页', ['#/docs', '#/doc/:id', '#/doc/:id/edit', '#/doc/:id/blocks', '#/blocks'].every((item) => readme.includes(item)), '');
    check('README 接口表收录了 /api/docs', readme.includes('| GET | `/api/docs` |'), '');
    check('README 数据模型收录了六张表的前四张', ['documents(', 'document_blocks(', 'document_revisions(', 'doc_block_types('].every((item) => readme.includes(item)), '');
    check('README 数据模型收录了沙箱审计表', readme.includes('doc_capability_logs('), '');
    check('README 数据模型收录了笔记接线表', readme.includes('note_documents('), '');
    check('README 写了影子行的已知短板', readme.includes('别人点不了赞'), '');

    /* 7.3 设计文档的 S1–S7 状态表全部收口。 */
    const design = readText('docs/superpowers/specs/2026-10-05-programmable-posts-design.md');
    const rows = design.match(/^\| \*\*S[1-7]\*\* \|.*$/gm) ?? [];
    check('设计文档有 S1–S7 七行', rows.length === 7, String(rows.length));
    check('S1–S7 全部标成 ✅', rows.length === 7 && rows.every((row) => row.trimEnd().endsWith('| ✅ |')), rows.map((row) => row.slice(-8)).join(' '));
    check('设计文档记了 §8.3 落地说明', design.includes('### 8.3 落地说明'), '');
  }

  /* ---------- 【S8】交付验收：用户点名的五件事 ---------- */

  console.log('\n【S8】交付验收');

  {
    const readText = (relative) => {
      const full = join(ROOT, relative);
      return existsSync(full) ? readFileSync(full, 'utf8') : '';
    };

    /* ---------- 8.1 「怎么自己编一个块」——注册一个类型要真的能渲染 ---------- */
    // 曾经的问题：`doc_block_types` 里存得下 renderer_json，但没有任何代码读它，
    // 于是「注册一个块类型」在产品里等于「注册一个永远渲染成字段表的空壳」。
    {
      const declared = await staff.call('/api/docs/meta/block-types', {
        method: 'POST',
        body: {
          name: 's8badge',
          label: '徽章',
          icon: '🏷',
          rendererKind: 'declarative',
          propsSchema: { text: { type: 'string', required: true, label: '内容' }, tone: { type: 'string', default: '', label: '色调' } },
          renderer: { html: '<h3 class="doc-tpl-title">{{text}}</h3><p>{{tone}}</p>' },
        },
      });
      check('8.1 声明式块类型注册得出来', declared.status === 200 && declared.data?.type?.name === 's8badge', `${declared.status} ${JSON.stringify(declared.error)}`);

      const made = await staff.call('/api/docs', { method: 'POST', body: { title: 'S8 编程验收', kind: 'post', scope: 'private' } });
      const docId = made.data?.doc?.id;
      const added = await staff.call(`/api/docs/${docId}/blocks`, {
        method: 'POST',
        body: { type: 's8badge', props: { text: '自编块', tone: 'info' } },
      });
      check('8.1 自编块能加进文档', added.status === 200, `${added.status} ${JSON.stringify(added.error)}`);
      const viewed = await staff.call(`/api/docs/${docId}`);
      check(
        '8.1 自编块按注册时的渲染模板出 HTML（不是字段名对值的表）',
        viewed.data?.html?.includes('doc-tpl-title') && viewed.data?.html?.includes('自编块') && !viewed.data?.html?.includes('doc-block-fields'),
        String(viewed.data?.html ?? '').slice(0, 240),
      );
      check('8.1 自编块 0 降级警告', viewed.data?.warnings?.length === 0, JSON.stringify(viewed.data?.warnings));

      // 模板是登录用户写的，会出现在每个访客的页面上 —— 危险构造必须被剥掉。
      const evil = await staff.call('/api/docs/meta/block-types', {
        method: 'POST',
        body: {
          name: 's8evil',
          label: '危险模板',
          rendererKind: 'declarative',
          propsSchema: { text: { type: 'string', default: 'x', label: '内容' } },
          renderer: { html: '<b onclick="steal()">点</b><script>steal()<\/script><a href="javascript:steal()">x</a>{{text}}' },
        },
      });
      check('8.1 危险模板也注册得出来（剥在渲染那一步）', evil.status === 200, `${evil.status}`);
      const evilDoc = await staff.call('/api/docs', { method: 'POST', body: { title: 'S8 危险模板', kind: 'post', scope: 'private' } });
      await staff.call(`/api/docs/${evilDoc.data?.doc?.id}/blocks`, { method: 'POST', body: { type: 's8evil', props: { text: 'x' } } });
      const evilView = await staff.call(`/api/docs/${evilDoc.data?.doc?.id}`);
      const evilHtml = String(evilView.data?.html ?? '');
      check(
        '8.1 渲染模板里的 script / on* / javascript: 全被剥掉',
        !/<script/i.test(evilHtml) && !/\son[a-z]+\s*=/i.test(evilHtml) && !/javascript:/i.test(evilHtml),
        evilHtml.slice(0, 240),
      );

      // 沙箱型自定义块必须真的拿到 iframe —— 否则「注册沙箱块」是空话。
      const sandboxed = await staff.call('/api/docs/meta/block-types', {
        method: 'POST',
        body: {
          name: 's8clock',
          label: '自编沙箱块',
          icon: '⏱',
          rendererKind: 'sandbox',
          propsSchema: { title: { type: 'string', default: '', label: '标题' }, code: { type: 'string', default: '', label: '代码' } },
        },
      });
      check('8.1 沙箱型块类型注册得出来', sandboxed.status === 200, `${sandboxed.status} ${JSON.stringify(sandboxed.error)}`);
      const clockDoc = await staff.call('/api/docs', { method: 'POST', body: { title: 'S8 沙箱块', kind: 'post', scope: 'private' } });
      const clockId = clockDoc.data?.doc?.id;
      await staff.call(`/api/docs/${clockId}/blocks`, {
        method: 'POST',
        body: { type: 's8clock', props: { title: '自编沙箱', code: '<b>hi</b><script>Sandbox.resize();<\/script>' } },
      });
      const clockView = await staff.call(`/api/docs/${clockId}`);
      const clockHtml = String(clockView.data?.html ?? '');
      check(
        '8.1 自编沙箱块的代码进了 iframe（allow-scripts，无 allow-same-origin）',
        clockHtml.includes('doc-app-frame') && clockHtml.includes('allow-scripts') && !clockHtml.includes('allow-same-origin'),
        clockHtml.slice(0, 240),
      );
      check(
        '8.1 没写代码的自编沙箱块给的是「还没写代码」占位，不是空 div',
        (await (async () => {
          const empty = await staff.call('/api/docs', { method: 'POST', body: { title: 'S8 空沙箱', kind: 'post', scope: 'private' } });
          await staff.call(`/api/docs/${empty.data?.doc?.id}/blocks`, { method: 'POST', body: { type: 's8clock', props: { code: '' } } });
          const view = await staff.call(`/api/docs/${empty.data?.doc?.id}`);
          await staff.call(`/api/docs/${empty.data?.doc?.id}`, { method: 'DELETE' });
          return String(view.data?.html ?? '').includes('doc-app-empty');
        })()),
        '',
      );

      for (const id of [docId, evilDoc.data?.doc?.id, clockId]) await staff.call(`/api/docs/${id}`, { method: 'DELETE' });
    }

    /* ---------- 8.2 从模板拉一个投票块出来，并且改它的源码 ---------- */
    {
      const made = await staff.call('/api/docs', {
        method: 'POST',
        body: { title: 'S8 投票验收', kind: 'post', scope: 'private', template: 'poll' },
      });
      const docId = made.data?.doc?.id;
      const pollBlock = (made.data?.blocks ?? []).find((block) => block.type === 'poll');
      check('8.2 poll 模板里有一个投票块', Boolean(pollBlock), JSON.stringify((made.data?.blocks ?? []).map((b) => b.type)));
      check('8.2 投票块渲染出可点的选项', String(made.data?.html ?? '').includes('doc-poll'), String(made.data?.html ?? '').slice(0, 200));

      // 「编辑源码」= 直接改 props JSON 再存回去（前端 doc-blocks.js 的 sourceHtml 走的就是这条接口）。
      const blockId = pollBlock?.blockId;
      const put = await staff.call(`/api/docs/${docId}/blocks/${blockId}`, {
        method: 'PUT',
        body: {
          props: {
            question: '源码改过的问题',
            options: [
              { id: 'o1', text: '甲' },
              { id: 'o2', text: '乙' },
              { id: 'o3', text: '丙' },
            ],
            multiple: false,
          },
        },
      });
      check('8.2 投票块源码改得动（PUT props）', put.status === 200 && put.data?.block?.props?.question === '源码改过的问题', `${put.status} ${JSON.stringify(put.error)}`);
      const viewed = await staff.call(`/api/docs/${docId}`);
      check(
        '8.2 改完的源码渲染出来了，且 0 警告',
        String(viewed.data?.html ?? '').includes('源码改过的问题') && String(viewed.data?.html ?? '').includes('丙') && viewed.data?.warnings?.length === 0,
        JSON.stringify(viewed.data?.warnings),
      );
      // 坏选项（少于 2 项）必须降级而不是炸 —— 源码入口最容易写出这种。
      const bad = await staff.call(`/api/docs/${docId}/blocks/${blockId}`, {
        method: 'PUT',
        body: { props: { question: '只剩一项', options: [{ id: 'o1', text: '甲' }] } },
      });
      const badView = await staff.call(`/api/docs/${docId}`);
      check(
        '8.2 源码写坏只降级（有警告），接口不 500、文档不白屏',
        bad.status === 200 && (badView.data?.warnings?.length ?? 0) > 0 && String(badView.data?.html ?? '').includes('doc-block'),
        `${bad.status} ${JSON.stringify(badView.data?.warnings)}`,
      );

      // 无模板也从零加一块：这就是「不用模板直接开始」。
      const blank = await staff.call('/api/docs', { method: 'POST', body: { title: 'S8 从零验收', kind: 'post', scope: 'private', template: 'blank' } });
      const blankId = blank.data?.doc?.id;
      await staff.call(`/api/docs/${blankId}/markdown`, { method: 'PUT', body: { markdown: '# 从零开始\n\n第一段。' } });
      await staff.call(`/api/docs/${blankId}/blocks`, {
        method: 'POST',
        body: { type: 'poll', props: { question: '从零加的投票', options: [{ id: 'o1', text: '是' }, { id: 'o2', text: '否' }] } },
      });
      const blankView = await staff.call(`/api/docs/${blankId}`);
      check(
        '8.2 不用模板也能从零加一个投票块（markdown 起的头 + 后加的块都在）',
        String(blankView.data?.html ?? '').includes('从零加的投票') && String(blankView.data?.html ?? '').includes('从零开始'),
        String(blankView.data?.html ?? '').slice(0, 160),
      );

      for (const id of [docId, blankId]) await staff.call(`/api/docs/${id}`, { method: 'DELETE' });
    }

    /* ---------- 8.3 Wiki 多页面：`[[双链]]` 是个能点的路，不是装饰 ---------- */
    {
      const first = await staff.call(`/api/docs/wiki/${encodeURIComponent('S8 总览页')}`, { method: 'POST', body: { scope: 'public' } });
      check('8.3 POST /api/docs/wiki/:name 建得出一页', first.status === 200 && first.data?.created === true && first.data?.doc?.title === 'S8 总览页', `${first.status} ${JSON.stringify(first.error)}`);
      check('8.3 新建的 wiki 页带 page 模板', first.data?.doc?.template === 'page', String(first.data?.doc?.template));

      const again = await staff.call(`/api/docs/wiki/${encodeURIComponent('S8 总览页')}`, { method: 'POST', body: { scope: 'public' } });
      check('8.3 同名再 POST 是打开而不是又建一页', again.status === 200 && again.data?.created === false && again.data?.doc?.id === first.data?.doc?.id, `${again.status}`);

      const second = await staff.call(`/api/docs/wiki/${encodeURIComponent('S8 子页面')}`, { method: 'POST', body: { scope: 'public' } });
      check('8.3 第二页也建得出来（多页面）', second.status === 200 && second.data?.doc?.id !== first.data?.doc?.id, `${second.status}`);

      const found = await anon.call(`/api/docs/wiki/${encodeURIComponent('S8 总览页')}`);
      check('8.3 匿名 GET 找得到公开页', found.status === 200 && found.data?.found === true, `${found.status} ${JSON.stringify(found.error)}`);
      const missing = await anon.call(`/api/docs/wiki/${encodeURIComponent('S8 还没写的页')}`);
      check('8.3 没建过的页回 200 + found:false（不是 404，前端据此给「建这一页」）', missing.status === 200 && missing.data?.found === false, `${missing.status}`);

      // 双链渲染成可点的 href
      await staff.call(`/api/docs/${first.data?.doc?.id}`, {
        method: 'PUT',
        body: { title: 'S8 总览页', scope: 'public', template: 'page' },
      });
      const wikiBlock = await staff.call(`/api/docs/${first.data?.doc?.id}/blocks`, {
        method: 'POST',
        body: { type: 'wiki', props: { target: 'S8 子页面', label: '', note: '' } },
      });
      check('8.3 能往 wiki 页里加一条双链', wikiBlock.status === 200, `${wikiBlock.status}`);
      const overview = await anon.call(`/api/docs/${first.data?.doc?.id}`);
      check(
        '8.3 双链渲染成带 href 的链接（指向 #/wiki/<标题>）',
        String(overview.data?.html ?? '').includes(`href="#/wiki/${encodeURIComponent('S8 子页面')}"`),
        String(overview.data?.html ?? '').slice(0, 240),
      );

      // 行内双链：`markdownToBlocks` 只把**独占一行**的 `[[x]]` 变 wiki 块，
      // 夹在句子里的那条不能就原样显示成 `[[x]]`（用户会以为双链坏了）。
      const inline = await staff.call(`/api/docs/${first.data?.doc?.id}/markdown?confirm=1`, {
        method: 'PUT',
        body: { markdown: '下一站：[[S8 子页面]]。' },
      });
      check('8.3 段落里的行内双链也渲染成链接', inline.status === 200, `${inline.status}`);
      const inlineDoc = await anon.call(`/api/docs/${first.data?.doc?.id}`);
      const inlineHtml = String(inlineDoc.data?.html ?? '');
      check(
        '8.3 行内双链指向 #/wiki/<标题>，且正文的其余部分照常转义',
        inlineHtml.includes(`href="#/wiki/${encodeURIComponent('S8 子页面')}"`) && inlineHtml.includes('下一站：'),
        inlineHtml.slice(0, 240),
      );
      check('8.3 行内双链不再以 `[[…]]` 的原文露出来', !inlineHtml.includes('[['), inlineHtml.slice(0, 240));

      // 私有 wiki 页对外不存在（连「有这一页」都不该说）
      const secret = await staff.call(`/api/docs/wiki/${encodeURIComponent('S8 私有页')}`, { method: 'POST', body: { scope: 'private' } });
      check('8.3 私有 wiki 页建得出来', secret.status === 200, `${secret.status}`);
      const stranger = await other.call(`/api/docs/wiki/${encodeURIComponent('S8 私有页')}`);
      check('8.3 别人 GET 私有页回 found:false（不泄漏存在性）', stranger.status === 200 && stranger.data?.found === false, `${stranger.status} ${JSON.stringify(stranger.data)}`);
      const anonCreate = await anon.call(`/api/docs/wiki/${encodeURIComponent('S8 匿名建的页')}`, { method: 'POST', body: {} });
      check('8.3 匿名 POST 建页是 401', anonCreate.status === 401, String(anonCreate.status));

      for (const doc of [first, second, secret]) await staff.call(`/api/docs/${doc.data?.doc?.id}`, { method: 'DELETE' });
    }

    /* ---------- 8.4 回得去：Markdown + LaTeX 的简单编辑 ---------- */
    {
      const made = await staff.call('/api/docs', { method: 'POST', body: { title: 'S8 Markdown 验收', kind: 'post', scope: 'private', template: 'blank' } });
      const docId = made.data?.doc?.id;
      const md = '# 简单编辑\n\n行内公式 $E = mc^2$，行间：\n\n$$\n\\int_0^1 x^2 dx = \\frac{1}{3}\n$$\n\n- 要点甲\n- 要点乙\n';
      const put = await staff.call(`/api/docs/${docId}/markdown`, { method: 'PUT', body: { markdown: md } });
      check('8.4 PUT /api/docs/:id/markdown 收得下 Markdown', put.status === 200, `${put.status} ${JSON.stringify(put.error)}`);
      const html = String(put.data?.html ?? '');
      // 服务端**故意不排**数学（与论坛一致）：它只把 `$$…$$` 的定界符交给客户端，
      // 由 public/views/notes.js 的 ntRenderMath 在 innerHTML 之后排版。
      // 所以这里要验的是"行间公式变成了 formula 块、定界符活着"，不是"html 里没有 $$"。
      check(
        '8.4 行间公式变成 formula 块，$$ 定界符交给客户端 KaTeX',
        html.includes('doc-block-formula') && html.includes('$$') && html.includes('简单编辑'),
        html.slice(0, 240),
      );
      check(
        '8.4 行内公式原样留给客户端（服务端 renderMarkdown 从不排数学）',
        html.includes('$E = mc^2$'),
        html.slice(0, 240),
      );

      const round = await staff.call(`/api/docs/${docId}/markdown`);
      check(
        '8.4 GET markdown 能原样拿回来（Markdown 是一等公民，不是降级通道）',
        round.status === 200 && String(round.data?.markdown ?? '').includes('E = mc^2'),
        String(round.data?.markdown ?? '').slice(0, 160),
      );
      const preview = await staff.call('/api/markdown/preview', { method: 'POST', body: { content: '$a^2+b^2=c^2$' } });
      check('8.4 前端实时预览用的 /api/markdown/preview 可用', preview.status === 200 && typeof preview.data?.html === 'string', `${preview.status}`);
      await staff.call(`/api/docs/${docId}`, { method: 'DELETE' });
    }

    /* ---------- 8.5 前端的五个入口都接上了 ---------- */
    {
      const editorJs = readText('public/views/doc.js');
      const partsJs = readText('public/views/doc-blocks.js');
      const routerJs = readText('public/core/router.js');
      const css = readText('public/css/41-doc.css');
      check('8.5 前端有「怎么自己编一个块」的指南', editorJs.includes('function guideHtml()') && editorJs.includes('怎么自己编一个块'), '');
      check('8.5 注册表单能填渲染模板', editorJs.includes('name="renderer"') && editorJs.includes('propsSchema'), '');
      check('8.5 每块都有「源码（props JSON）」入口', partsJs.includes('function sourceHtml(block)') && partsJs.includes('data-doc-source'), '');
      check('8.5 源码保存走的是同一条块接口', partsJs.includes('data-doc-action="source-save"') && editorJs.includes('async function saveBlockSource(blockId)') && editorJs.includes("action === 'source-save'"), '');
      check('8.5 路由认识 #/wiki/<标题>', routerJs.includes("first === 'wiki' && second") && routerJs.includes('Doc.viewWiki'), '');
      check('8.5 没建的 wiki 页给的是「建这一页」而不是死链', editorJs.includes('data-doc-action="wiki-open"') && editorJs.includes('async function openWikiPage(name)'), '');
      check('8.5 新样式都在 41-doc.css 里', ['.doc-src', '.doc-src-box', '.doc-guide', '.doc-guide-list'].every((item) => css.includes(item)), '');
      // LaTeX：站里原本那一套是离线 KaTeX（`views/notes.js` 的 `ntRenderMath`），
      // 服务端只吐 `$…$` 原文，所以要确认积木的两个视图都调了这一步。
      check('8.5 阅读视图把公式交给站点原本的 KaTeX', editorJs.includes("from './notes.js'") && editorJs.includes('ntRenderMath($('), '');
      check('8.5 Markdown 实时预览也渲染公式', /ntRenderMath\(box\)/.test(editorJs), '');
      check('8.5 文案里写清了「双链」怎么用', editorJs.includes('双链') || partsJs.includes('双链'), '');
    }

    /* ---------- 8.6 投票块能真的投（用户报的 bug ①） ---------- */
    // 曾经的问题：`poll.toHtml` 把票数**写死成 0**，没有接口、没有点击处理 ——
    // 页面上是一排看不出能点的选项，点了没反应。现在票落在 `doc_poll_votes` 里。
    {
      const made = await staff.call('/api/docs', {
        method: 'POST',
        body: { title: 'S8 投票可投', kind: 'post', scope: 'public', template: 'poll' },
      });
      const docId = made.data?.doc?.id;
      const blockId = (made.data?.blocks ?? []).find((block) => block.type === 'poll')?.blockId;
      await staff.call(`/api/docs/${docId}/blocks/${blockId}`, {
        method: 'PUT',
        body: {
          props: {
            question: '能投吗',
            options: [
              { id: 'o1', text: '能' },
              { id: 'o2', text: '不能' },
            ],
            multiple: false,
          },
        },
      });

      const before = await anon.call(`/api/docs/${docId}/polls`);
      check(
        '8.6 读票数不用登录，且每个 poll 块都有桶（0 票也算有）',
        before.status === 200 && before.data?.polls?.[blockId]?.total === 0 && Array.isArray(before.data?.polls?.[blockId]?.mine),
        `${before.status} ${JSON.stringify(before.data)}`,
      );
      check('8.6 桶里带着 multiple，前端据此决定「换票」还是「加票」', before.data?.polls?.[blockId]?.multiple === false, JSON.stringify(before.data?.polls?.[blockId]));

      const voted = await staff.call(`/api/docs/${docId}/blocks/${blockId}/vote`, { method: 'POST', body: { options: ['o1'] } });
      check('8.6 投一票成功，票数回到 1', voted.status === 200 && voted.data?.counts?.o1 === 1, `${voted.status} ${JSON.stringify(voted.data)}`);
      check('8.6 「我投了什么」跟着回来', JSON.stringify(voted.data?.mine ?? []) === '["o1"]', JSON.stringify(voted.data?.mine));

      const second = await other.call(`/api/docs/${docId}/polls`);
      check('8.6 另一个人看到同一票数、但不是自己投的', second.data?.polls?.[blockId]?.counts?.o1 === 1 && (second.data?.polls?.[blockId]?.mine ?? []).length === 0, JSON.stringify(second.data?.polls?.[blockId]));

      const changed = await staff.call(`/api/docs/${docId}/blocks/${blockId}/vote`, { method: 'POST', body: { options: ['o2'] } });
      check(
        '8.6 再投一次是**改票**而不是累加（o1 归零、o2 得 1）',
        changed.status === 200 && changed.data?.counts?.o2 === 1 && !changed.data?.counts?.o1,
        JSON.stringify(changed.data),
      );

      // 单选投两个必须被打回来 —— 否则前端算错「换票」就会静默多投一票。
      const both = await staff.call(`/api/docs/${docId}/blocks/${blockId}/vote`, { method: 'POST', body: { options: ['o1', 'o2'] } });
      check('8.6 单选投票一次投两个是 400', both.status === 400, `${both.status} ${JSON.stringify(both.error)}`);

      // 作者删掉的选项不能被投（票会永远清不掉）。
      const ghost = await staff.call(`/api/docs/${docId}/blocks/${blockId}/vote`, { method: 'POST', body: { options: ['o9'] } });
      check('8.6 投一个不存在的选项是 400（不会留下孤儿票）', ghost.status === 400, `${ghost.status}`);

      // 单选投票的「再点一次就撤销」：空数组 = 清掉我的票。
      // 前端 toggle 出来就是空集合，服务端要是拒了，用户点自己那项只会看到报错。
      const undo = await staff.call(`/api/docs/${docId}/blocks/${blockId}/vote`, { method: 'POST', body: { options: [] } });
      check('8.6 提交空选择 = 撤销我的票（不是 400）', undo.status === 200 && undo.data?.total === 0 && (undo.data?.mine ?? []).length === 0, `${undo.status} ${JSON.stringify(undo.data ?? undo.error)}`);

      const guest = await anon.call(`/api/docs/${docId}/blocks/${blockId}/vote`, { method: 'POST', body: { options: ['o1'] } });
      check('8.6 匿名投票是 401（票要挂在人身上）', guest.status === 401, String(guest.status));

      // 票是运行期数据：写进 props 等于「作者改选项=改所有人的票」。
      const view = await staff.call(`/api/docs/${docId}`);
      check('8.6 票数不进 props（没有产生修订级的副作用）', JSON.stringify(view.data?.blocks?.[0]?.props ?? {}).indexOf('votes') < 0, JSON.stringify(view.data?.blocks?.[0]?.props ?? {}).slice(0, 120));
      check(
        '8.6 渲染出来的选项是可点的按钮，不再是写死的 0',
        String(view.data?.html ?? '').includes('data-doc-action="poll-vote"') && String(view.data?.html ?? '').includes('doc-poll-choice'),
        String(view.data?.html ?? '').slice(0, 200),
      );

      // 删块之后票必须跟着走，否则改 Markdown / 套模板会留一堆孤儿票。
      await staff.call(`/api/docs/${docId}/blocks/${blockId}`, { method: 'DELETE' });
      const afterDelete = await anon.call(`/api/docs/${docId}/polls`);
      check('8.6 块删了，票也清干净了', (afterDelete.data?.polls?.[blockId]?.total ?? 0) === 0, JSON.stringify(afterDelete.data?.polls));

      await staff.call(`/api/docs/${docId}`, { method: 'DELETE' });
    }

    /* ---------- 8.7 wiki 有边栏、有分类（用户报的 bug ③） ---------- */
    // 曾经的问题：`/api/docs/wiki/:name` 只回一页正文，没有页面清单也没有分类 ——
    // 「wiki」退化成了「一篇带链接的普通帖子」。
    {
      const cat = 'S8 分类甲';
      const one = await staff.call(`/api/docs/wiki/${encodeURIComponent('S8 边栏甲')}`, { method: 'POST', body: { scope: 'public' } });
      const two = await staff.call(`/api/docs/wiki/${encodeURIComponent('S8 边栏乙')}`, { method: 'POST', body: { scope: 'public' } });
      check('8.7 建两页拿来试边栏', one.status === 200 && two.status === 200, `${one.status}/${two.status}`);

      const meta = await staff.call(`/api/docs/${one.data?.doc?.id}/wiki`, { method: 'PUT', body: { category: cat, sortOrder: 1 } });
      check('8.7 PUT /api/docs/:id/wiki 存得下分类', meta.status === 200 && meta.data?.category === cat, `${meta.status} ${JSON.stringify(meta.error)}`);
      check('8.7 改完分类当场回新的边栏', Array.isArray(meta.data?.nav?.categories) && meta.data.nav.categories.some((item) => item.name === cat), JSON.stringify(meta.data?.nav?.categories));

      const page = await anon.call(`/api/docs/wiki/${encodeURIComponent('S8 边栏甲')}`);
      const nav = page.data?.nav;
      check('8.7 打开一页 wiki 就带回了页面清单与当前页', Array.isArray(nav?.pages) && nav.pages.some((item) => item.title === 'S8 边栏甲'), JSON.stringify(nav?.pages));
      check('8.7 分类带页数，未分类排在最后', nav?.categories?.length > 0 && nav.categories[nav.categories.length - 1].name === '', JSON.stringify(nav?.categories));
      check('8.7 边栏里的页带 category（前端按它分组）', nav.pages.find((item) => item.title === 'S8 边栏甲')?.category === cat, JSON.stringify(nav.pages.find((item) => item.title === 'S8 边栏甲')));

      // 从 `#/doc/:id` 进来也得有边栏 —— 有没有边栏不该取决于点的哪个链接。
      const byId = await anon.call(`/api/docs/${one.data?.doc?.id}`);
      check('8.7 同一页从 /api/docs/:id 进来也有边栏', Array.isArray(byId.data?.nav?.pages), JSON.stringify(byId.data?.nav)?.slice(0, 120));
      const notWiki = await staff.call('/api/docs', { method: 'POST', body: { title: 'S8 不是 wiki', kind: 'post', scope: 'public', template: 'blank' } });
      const plain = await staff.call(`/api/docs/${notWiki.data?.doc?.id}`);
      check('8.7 普通帖子不硬塞边栏', plain.data?.nav === undefined, JSON.stringify(plain.data?.nav)?.slice(0, 80));

      const cats = await anon.call('/api/docs/wiki');
      check('8.7 GET /api/docs/wiki 是个能直接拉目录的接口', cats.status === 200 && Array.isArray(cats.data?.pages), `${cats.status}`);

      // 私有页不能因为「名字出现在边栏里」而泄露存在性。
      const secret = await staff.call('/api/docs/wiki/%E3%80%8AS8%20%E8%BE%B9%E6%A0%8F%E4%B8%99', { method: 'POST', body: { scope: 'private' } });
      const strangerNav = await other.call('/api/docs/wiki');
      check(
        '8.7 别人的私有页不出现在我的边栏里（不泄露存在性）',
        secret.status === 200 && !(strangerNav.data?.pages ?? []).some((item) => item.title === 'S8 边栏丙'),
        JSON.stringify((strangerNav.data?.pages ?? []).map((item) => item.title)),
      );

      // 前端接线
      const editorJs = readText('public/views/doc.js');
      const css = readText('public/css/41-doc.css');
      check('8.7 前端有边栏的渲染与筛选', editorJs.includes('function wikiNavHtml(nav, doc)') && editorJs.includes('function mountWikiNav()'), '');
      check('8.7 边栏布局类都在 41-doc.css 里', ['.doc-wiki-layout', '.doc-wiki-nav', '.doc-wiki-nav-link'].every((item) => css.includes(item)), '');
      check('8.7 改分类的入口接上了接口', editorJs.includes('data-doc-action="wiki-cat"') && editorJs.includes("`/api/docs/${id}/wiki`"), '');
      // grid/flex 会压过 hidden 属性的默认 display:none，所以这条必须显式写。
      check('8.7 边栏的过滤靠 [hidden]，所以 CSS 里补了显示规则', css.includes('.doc-wiki-nav-link[hidden]'), '');

      for (const doc of [one, two, notWiki, secret]) await staff.call(`/api/docs/${doc.data?.doc?.id}`, { method: 'DELETE' });
    }

    /* ---------- 8.8 沙箱是个能写功能的语言，不是一堆 JSON（用户报的 bug ④） ---------- */
    // 用户的定性：「你的编程的主语言 json 本质只是数据整理用的语言，而不是真正能写功能的语言」。
    // 所以这里验的不是「模板能取到字段」，而是「一段程序能读文档、读访客、**把状态存到服务端**」。
    {
      const made = await staff.call('/api/docs', { method: 'POST', body: { title: 'S8 沙箱能力', kind: 'post', scope: 'public' } });
      const docId = made.data?.doc?.id;
      const added = await staff.call(`/api/docs/${docId}/blocks`, {
        method: 'POST',
        body: { type: 'app', props: { app: '待办', code: '<b>x</b>', config: {} } },
      });
      const blockId = added.data?.blocks?.[0]?.blockId ?? 'b1';

      const cap = (who, body) => who.call(`/api/docs/${docId}/capabilities`, { method: 'POST', body });
      const meta = await cap(staff, { blockId, capability: 'doc-meta' });
      check('8.8 doc-meta 仍给得出标题', meta.status === 200 && meta.data?.value?.title === 'S8 沙箱能力', `${meta.status} ${JSON.stringify(meta.error)}`);

      const blocks = await cap(staff, { blockId, capability: 'doc-blocks' });
      check(
        '8.8 doc-blocks 把正文里每一块给出来（代码能按别的块算东西）',
        blocks.status === 200 && Array.isArray(blocks.data?.value?.blocks) && blocks.data.value.blocks.some((item) => item.type === 'app'),
        JSON.stringify(blocks.data?.value)?.slice(0, 200),
      );

      const viewerCap = await cap(staff, { blockId, capability: 'viewer' });
      check('8.8 viewer 说得出「谁在看」', viewerCap.status === 200 && viewerCap.data?.value?.loggedIn === true, JSON.stringify(viewerCap.data?.value));

      const emptyState = await cap(staff, { blockId, capability: 'state', payload: { op: 'get' } });
      check('8.8 从没存过的状态读回 null（不是报错）', emptyState.status === 200 && emptyState.data?.value?.value === null, `${emptyState.status} ${JSON.stringify(emptyState.data?.value)}`);

      const saved = await cap(staff, { blockId, capability: 'state', payload: { op: 'set', value: ['2026-10-05'] } });
      check('8.8 状态写得进服务端', saved.status === 200 && JSON.stringify(saved.data?.value?.value) === '["2026-10-05"]', `${saved.status} ${JSON.stringify(saved.error)}`);
      const readBack = await cap(staff, { blockId, capability: 'state', payload: { op: 'get' } });
      check('8.8 再读回来是刚存的那份（刷新还在）', JSON.stringify(readBack.data?.value?.value) === '["2026-10-05"]', JSON.stringify(readBack.data?.value));

      const otherRead = await cap(other, { blockId, capability: 'state', payload: { op: 'get' } });
      check('8.8 默认作用域是「各人一份」（别人读不到我的）', otherRead.data?.value?.value === null, JSON.stringify(otherRead.data?.value));

      const anonWrite = await cap(anon, { blockId, capability: 'state', payload: { op: 'set', value: 1 } });
      check('8.8 匿名写状态是 401', anonWrite.status === 401, String(anonWrite.status));

      const shared = await cap(staff, { blockId, capability: 'state', payload: { op: 'set', scope: 'shared', value: { n: 1 } } });
      const sharedOther = await cap(other, { blockId, capability: 'state', payload: { op: 'get', scope: 'shared' } });
      check('8.8 shared 作用域是「全站一份」', shared.status === 200 && JSON.stringify(sharedOther.data?.value?.value) === '{"n":1}', JSON.stringify(sharedOther.data?.value));

      const badScope = await cap(staff, { blockId, capability: 'state', payload: { op: 'set', scope: 'galaxy', value: 1 } });
      check('8.8 不认识的作用域回落到 user，不报错也不越权', badScope.status === 200 && badScope.data?.value?.scope === 'user', JSON.stringify(badScope.data?.value));
      const tooBig = await cap(staff, { blockId, capability: 'state', payload: { op: 'set', value: 'x'.repeat(40000) } });
      check('8.8 状态超上限是 400（不悄悄截断）', tooBig.status === 400, `${tooBig.status} ${JSON.stringify(tooBig.error)}`);

      const outside = await cap(staff, { blockId: 'b999', capability: 'doc-meta' });
      check('8.8 拿一个不属于这篇文档的块号申请能力会被拒', outside.status === 400, `${outside.status} ${JSON.stringify(outside.error)}`);

      const nope = await cap(staff, { blockId, capability: 'drop-tables' });
      check('8.8 白名单外的能力一律 403', nope.status === 403, String(nope.status));
      const logs = await staff.call(`/api/docs/${docId}/capabilities`);
      check(
        '8.8 被拒的那次也留在审计里（allowed=0）',
        (logs.data?.logs ?? []).some((item) => item.capability === 'drop-tables' && item.allowed === false),
        JSON.stringify((logs.data?.logs ?? []).slice(0, 3)),
      );

      // 沙箱里的启动脚本必须给出上面这几样 —— 否则「能写功能」只是服务端一厢情愿。
      const sandboxJs = readText('src/modules/doc/sandbox.js');
      const hostJs = readText('public/core/sandbox.js');
      check(
        '8.8 启动脚本给了 doc() / blocks() / viewer() / state',
        ['api.doc = function', 'api.blocks = function', 'api.viewer = function', 'api.state = {'].every((item) => sandboxJs.includes(item)),
        '',
      );
      check('8.8 request 会带上 payload（state 靠它传 op/scope/value）', sandboxJs.includes('request: function (capability, payload)') && hostJs.includes('payload:'), '');
      check('8.8 指南里的示例用的是真 API，不是 {ok,value} 包装', editorJsOk(), '');

      function editorJsOk() {
        const editorJs = readText('public/views/doc.js');
        return editorJs.includes('Sandbox.state.set') && !editorJs.includes('if (r.ok)');
      }

      // 删文档时状态跟着走（不留孤儿行）。
      const before = scalar('SELECT COUNT(*) AS n FROM doc_app_state WHERE document_id = ?', docId);
      await staff.call(`/api/docs/${docId}`, { method: 'DELETE' });
      const after = scalar('SELECT COUNT(*) AS n FROM doc_app_state WHERE document_id = ?', docId);
      check('8.8 删文档把状态一并清掉（不留孤儿）', (before?.n ?? 0) > 0 && (after?.n ?? 0) === 0, `${before?.n} → ${after?.n}`);
    }

    /* ---------- 8.9 新建积木帖子：向导 + 说明（用户报的 bug ⑤） ---------- */
    {
      const editorJs = readText('public/views/doc.js');
      const partsJs = readText('public/views/doc-blocks.js');
      const css = readText('public/css/41-doc.css');
      check('8.9 新建面板是三步向导', editorJs.includes('doc-steps') && editorJs.includes('function newDocPanelHtml()'), '');
      check('8.9 模板摊成卡片并带上说明（不是只有名字的下拉框）', editorJs.includes('data-doc-action="pick-template"') && editorJs.includes('item.description'), '');
      check('8.9 选中的模板写进隐藏框，提交路径没变', editorJs.includes('data-doc-action="pick-template"') && editorJs.includes('<input type="hidden" name="template"'), '');
      check('8.9 编辑器开头有「四步」说明卡', editorJs.includes('doc-howto') && editorJs.includes('保存本块'), '');
      check('8.9 每块底部也有一个「保存本块」（表单一长就滚不到顶上那个）', editorJs.includes('doc-block-foot'), '');
      check('8.9 联动默认收起（进阶功能不抢主线）', partsJs.includes('块间联动（进阶，可选）') && partsJs.includes('<details class="doc-bind"'), '');
      check('8.9 代码字段给的是高代码框，不是 6 行小框', partsJs.includes('doc-code-box') && partsJs.includes('opts.code ? 14'), '');
      check('8.9 新建小应用时给了能跑起来的最小示例', partsJs.includes('STARTER_CODE') && partsJs.includes('Sandbox.resize()'), '');
      check('8.9 注册表单会跟着 declarative / sandbox 换默认值', editorJs.includes('function mountTypeForm()') && editorJs.includes('SANDBOX_SCHEMA_SAMPLE'), '');
      check('8.9 新样式都在 41-doc.css 里', ['.doc-wizard', '.doc-tpl-pick', '.doc-steps', '.doc-howto', '.doc-block-foot', '.doc-code-box'].every((item) => css.includes(item)), '');
      // display:grid 会盖掉 hidden 属性（这个坑踩过两次），新建面板默认是收着的。
      check('8.9 hidden 的新建面板不会被 display:grid 顶出来', css.includes('.doc-wizard[hidden]'), '');
    }

    /* ---------- 【S9】脚本运行时：直接往帖子上写代码，块是数据 ---------- */
    // 用户点名的第 1 件事：「底层逻辑不再是只能改 JSON，而是能直接往帖子上写代码」。
    // 这一节从 HTTP 走完整条链：源码里的 `doc:script` → 解析成代码 → 能力申请（默认被拒）
    // → 作者开开关 → 脚本写派生块 → 渲染 → 采纳为真块 → 审计留痕。
    {
      const created = await author.call('/api/docs', { method: 'POST', body: { title: 'S9 脚本帖', kind: 'post', scope: 'public' } });
      const docId = created.data?.doc?.id;
      check('9.1 建得出一篇脚本帖', Number.isInteger(docId), `${created.status} ${JSON.stringify(created.error)}`);

      const src = [
        '```doc:script {#b1}',
        'const me = await Sandbox.viewer();',
        'await Sandbox.render.put("s1", "paragraph", { text: "脚本产出的一段话" });',
        '```',
        '',
        '## 正文标题',
        '',
        '这一段是作者写的。',
      ].join('\n');
      const saved = await author.call(`/api/docs/${docId}/markdown?confirm=1`, { method: 'PUT', body: { markdown: src } });
      check('9.1 源码里能直接写 JS（doc:script 的块体不是 JSON）', saved.status === 200, `${saved.status} ${JSON.stringify(saved.error)}`);
      const savedTypes = (saved.data?.blocks ?? []).map((block) => block.type);
      check('9.1 解析成 script + heading + paragraph', JSON.stringify(savedTypes) === JSON.stringify(['script', 'heading', 'paragraph']), JSON.stringify(savedTypes));
      check('9.1 源码逐字节原样回来了（编辑器往返靠它）', saved.data?.source === src, JSON.stringify(saved.data?.source));
      check('9.1 script 块的 code 就是那段原文', String((saved.data?.blocks ?? [])[0]?.props?.code ?? '').includes('Sandbox.render.put'), JSON.stringify((saved.data?.blocks ?? [])[0]?.props));
      check('9.1 沙箱代码按 20000 字卡（不是 app 的那条路）', typeof (saved.data?.blocks ?? [])[0]?.props?.code === 'string', '');

      const denied = await author.call(`/api/docs/${docId}/capabilities`, {
        method: 'POST',
        body: { blockId: 'b1', capability: 'blocks.derived', payload: { op: 'put', blockId: 's1', type: 'paragraph', props: { text: 'hi' }, scope: 'shared' } },
      });
      check('9.2 开关默认关着 → 脚本写块被拒（403）', denied.status === 403, `${denied.status} ${JSON.stringify(denied.error)}`);
      // 白名单之外的能力连「尝试」都要留痕（allowed:false 的那条就是它）。
      const rejected = await author.call(`/api/docs/${docId}/capabilities`, {
        method: 'POST',
        body: { blockId: 'b1', capability: 'blocks.secret', payload: { op: 'put' } },
      });
      check('9.2 白名单外的能力 → 403，而且照样记一条审计', rejected.status === 403, `${rejected.status}`);

      const settings = await author.call(`/api/docs/${docId}/settings`, { method: 'PUT', body: { allowScriptWrite: true } });
      check('9.2 作者能打开「脚本可以改块」', settings.status === 200 && settings.data?.settings?.allowScriptWrite === true, `${settings.status} ${JSON.stringify(settings.data?.settings)}`);
      const badMode = await author.call(`/api/docs/${docId}/settings`, { method: 'PUT', body: { appMode: 'nope' } });
      check('9.2 乱给 appMode → 400（枚举真的在校验）', badMode.status === 400, `${badMode.status}`);

      const put = await author.call(`/api/docs/${docId}/capabilities`, {
        method: 'POST',
        body: { blockId: 'b1', capability: 'blocks.derived', payload: { op: 'put', blockId: 's1', type: 'paragraph', props: { text: '脚本产出的一段话' }, scope: 'shared' } },
      });
      check('9.3 开了开关之后脚本能写派生块', put.status === 200 && put.data?.value?.blockId === 's1', `${put.status} ${JSON.stringify(put.data)}`);

      const shown = await author.call(`/api/docs/${docId}`);
      const derivedBlock = (shown.data?.blocks ?? []).find((block) => block.derived === true);
      check('9.3 派生块进 blocks 且打了 derived 标记', derivedBlock?.blockId === 's1' && derivedBlock?.scope === 'shared', JSON.stringify((shown.data?.blocks ?? []).map((block) => block.blockId)));
      const shownHtml = String(shown.data?.html ?? '');
      check('9.3 派生块接在真块之后，照样走渲染管线', shownHtml.includes('脚本产出的一段话') && shownHtml.includes('doc-derived'), shownHtml.slice(-320));
      check('9.3 派生块一个字节都没写进正文（真块还是 3 个）', (shown.data?.blocks ?? []).filter((block) => !block.derived).length === 3, '');

      const bogus = await author.call(`/api/docs/${docId}/capabilities`, {
        method: 'POST',
        body: { blockId: 'b1', capability: 'blocks.derived', payload: { op: 'put', blockId: 's2', type: 'not_a_type', props: {} } },
      });
      check('9.3 脚本不能凭空造类型（400，不是渲染出裸 HTML）', bogus.status === 400, `${bogus.status} ${JSON.stringify(bogus.error)}`);

      const adopted = await author.call(`/api/docs/${docId}/adopt`, { method: 'POST', body: { blockId: 's1', scope: 'shared' } });
      check('9.4 采纳为真块：发新 id 并接进正文', adopted.status === 200 && /^b\d+$/.test(String(adopted.data?.adopted?.blockId ?? '')), `${adopted.status} ${JSON.stringify(adopted.data?.adopted)}`);
      const after = await author.call(`/api/docs/${docId}`);
      check('9.4 采纳之后它不再是派生块', !(after.data?.blocks ?? []).some((block) => block.blockId === 's1'), JSON.stringify((after.data?.blocks ?? []).map((block) => block.blockId)));
      check('9.4 采纳之后源码里看得见这个新块', String(after.data?.source ?? '').includes('脚本产出的一段话'), String(after.data?.source ?? ''));
      const revisions = await author.call(`/api/docs/${docId}/revisions`);
      check('9.4 采纳写了一条 adopt 修订（不是偷偷改正文）', (revisions.data?.revisions ?? []).some((revision) => revision.reasonLabel === '采纳脚本产出'), JSON.stringify((revisions.data?.revisions ?? []).map((revision) => revision.reasonLabel)));

      const deniedLogs = await author.call(`/api/docs/${docId}/capabilities`);
      check('9.5 审计只有管理员看得到（作者也不行）', deniedLogs.status === 403, `${deniedLogs.status}`);
      const logs = await staff.call(`/api/docs/${docId}/capabilities`);
      const entries = logs.data?.logs ?? [];
      check('9.5 能力申请（含被拒的那次）全进了审计', entries.some((log) => log.allowed === false) && entries.some((log) => log.allowed === true), JSON.stringify(entries.slice(0, 2)));

      // 【S9.6】源码预览：编辑器右边那块。纯读 —— 不落库、不动 source_text、不建修订。
      const beforePreview = await author.call(`/api/docs/${docId}`);
      const preview = await author.call(`/api/docs/${docId}/preview`, {
        method: 'POST',
        body: { markdown: '# 预览标题\n\n预览里的一段话\n' },
      });
      check('9.6 预览回渲染好的 HTML 与块清单', preview.status === 200 && String(preview.data?.html ?? '').includes('预览标题') && (preview.data?.blocks ?? []).length === 2, `${preview.status} ${JSON.stringify(preview.data?.blocks)}`);
      const afterPreview = await author.call(`/api/docs/${docId}`);
      check(
        '9.6 预览不改正文、不改源码、不建修订',
        (afterPreview.data?.blocks ?? []).length === (beforePreview.data?.blocks ?? []).length
          && afterPreview.data?.source === beforePreview.data?.source,
        `${(beforePreview.data?.blocks ?? []).length} → ${(afterPreview.data?.blocks ?? []).length}`,
      );

      await author.call(`/api/docs/${docId}`, { method: 'DELETE' });
    }
  }

  await finish(failures.length ? 1 : 0);
} catch (error) {
  console.log('❌ 测试脚本自己抛了异常：');
  console.log(error?.stack ?? String(error));
  await finish(1);
}
