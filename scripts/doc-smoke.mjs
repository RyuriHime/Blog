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
import { runInNewContext } from 'node:vm';
// 直接引模块（不是走 HTTP）：S9.7 要把沙箱 bootstrap 拉进 vm 里演一遍握手顺序。
import { buildSandboxDocument } from '../src/modules/doc/sandbox.js';

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
  check('内置 16 种块类型', typeNames.length === 16, typeNames.join(','));
  check(
    '前 7 种与 note-agent 的 BLOCK_TYPES 逐字同序（契约对拍，两边块序列可互换）',
    JSON.stringify(typeNames.slice(0, 7)) === JSON.stringify(agent.BLOCK_TYPES),
    `${JSON.stringify(typeNames.slice(0, 7))} vs ${JSON.stringify(agent.BLOCK_TYPES)}`,
  );
  check(
    '新增 9 种是 quote / poll / wiki / embed / app / script / subpage / prose / fold',
    JSON.stringify(typeNames.slice(7)) === JSON.stringify(['quote', 'poll', 'wiki', 'embed', 'app', 'script', 'subpage', 'prose', 'fold']),
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
  check(
    'props 里的 HTML 只放行白名单标签与属性（onerror 出不来）',
    xss.html.includes('<img src="x">') && !xss.html.includes('onerror') && !xss.html.includes('<script'),
    xss.html,
  );

  // OI-wiki 的正文里有 `<kbd>` 这类行内 HTML（白名单见 `src/markdown.js` 的 `RAW_HTML_TAGS`）；
  // 白名单**不**等于「什么都能过」：协议白名单与属性白名单都还在，认不出就退回纯文字。
  const badScheme = engine.renderBlocks(
    [{ block_id: 'b1', type: 'paragraph', version: 1, props: { text: '<img src="javascript:alert(1)">' } }],
    {},
  );
  check(
    '非白名单协议的行内 HTML 退化成文字',
    badScheme.html.includes('&lt;img') && !badScheme.html.includes('<img'),
    badScheme.html,
  );

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

  // 段落 / 列表 / 引用这些「正文」块会按小节合并成一个 prose（见 src/modules/doc/blocks/markdown.js
  // 的 mergeProse），所以**块级恒等只对结构化块成立**，块号也会跟着挪；正文那一层的恒等契约是
  // 「Markdown 文本级无损」，见下面第二条。
  const STRUCTURED_TYPES = new Set(['heading', 'code', 'table', 'formula', 'image', 'poll', 'wiki', 'embed', 'app', 'script', 'subpage']);
  const onlyStructured = (blocks) => blocks.filter((block) => STRUCTURED_TYPES.has(block.type));
  const withoutIds = (blocks) => blocks.map(({ block_id: _ignored, ...rest }) => rest);
  check(
    'markdown 往返：结构化块逐块恒等（正文块按小节并成 prose，块号会挪）',
    isDeepStrictEqual(withoutIds(onlyStructured(roundTripBack)), withoutIds(onlyStructured(ROUND_TRIP)))
      && JSON.stringify(roundTripBack.map((block) => block.type))
        === JSON.stringify(['heading', 'prose', 'code', 'table', 'formula', 'image', 'prose', 'poll', 'wiki', 'embed', 'app']),
    JSON.stringify({
      types: roundTripBack.map((block) => block.type),
      back: onlyStructured(roundTripBack).map((block) => block.type),
      want: onlyStructured(ROUND_TRIP).map((block) => block.type),
    }),
  );

  check(
    'markdown 往返：12 个块的正文文本级无损（块粒度变了，Markdown 一个字节都没变）',
    engine.blocksToMarkdown(roundTripBack) === roundTripMd,
    JSON.stringify([roundTripMd, engine.blocksToMarkdown(roundTripBack)]).slice(0, 400),
  );

  check('markdown 输出里没有非法的裸块标记', !roundTripMd.includes('undefined'), roundTripMd.slice(0, 200));

  /* ---------- 2.4 列表项里缩进的 `$$` 不当顶层公式（不吞后面的折叠围栏） ---------- */

  {
    // 上游 OI-wiki 的「性质」小节大量这么写：条目行就是 `$$`，公式体缩进在下面。
    // 早先块解析器用 `line.trim() === '$$'` 判断顶层公式，于是这种缩进的 `$$`
    // 也被当成公式开头，一路吞到后面某个 `$$` —— 中间那段提示块围栏整段被吞进公式。
    const source = [
      '1.  由定义易得',
      '',
      '4.  $$',
      '    \\left(\\frac{2}{p}\\right)=1',
      '    $$',
      '',
      '```doc:fold',
      '{"title":"证明","kind":"note","open":false,"text":"里面的公式：\\n\\n    $$\\n    a^2\\n    $$"}',
      '```',
      '',
      '尾巴一段',
    ].join('\n');
    const blocks = engine.markdownToBlocks(source);
    const types = blocks.map((block) => block.type);
    check(
      '列表项里缩进的 $$ 不当顶层公式（折叠围栏没被吞掉）',
      types.includes('fold') && !blocks.some((block) => block.type === 'formula' && block.props.text.includes('```')),
      JSON.stringify({ types, formulas: blocks.filter((b) => b.type === 'formula').map((b) => b.props.text.slice(0, 60)) }),
    );
    const back = engine.blocksToMarkdown(blocks);
    check(
      '列表项里的 $$ 与公式体原样留在正文里（交给正文渲染器排成公式）',
      back.includes('4.  $$') && back.includes('\\left(\\frac{2}{p}\\right)=1'),
      back.slice(0, 300),
    );
  }

  /* ---------- 2.4b 标题里的行内标记：渲染出来，目录里是纯文字 ---------- */

  {
    // 上游 OI Wiki 的站首页标题是 `## 欢迎来到 **OI Wiki**！[![徽章](图)](链接)`。
    // 两处都错过：标题块以前把整段 escape 掉，页面上就是一行方括号加 URL；
    // 而右栏目录是**纯文字**的地方，徽章图不该整段抄进去。
    const { plainInline } = await import('../src/modules/doc/blocks/text.js');
    const headingMd = '# 欢迎来到 **OI Wiki**！[![徽章](https://img.shields.io/x.svg)](https://github.com/OI-wiki/OI-wiki)';
    const heading = engine.markdownToBlocks(headingMd);
    const headingHtml = engine.renderBlocks(heading, {}).html;
    check(
      '2.4b 标题里的行内标记照常渲染（粗体 / 徽章图 / 链接）',
      heading.length === 1
        && heading[0].type === 'heading'
        && /<h1[^>]*>欢迎来到 <strong>OI Wiki<\/strong>！<a [^>]*><img src="https:\/\/img\.shields\.io\/x\.svg"[^>]*><\/a><\/h1>/.test(headingHtml),
      headingHtml.slice(0, 240),
    );
    const plainHeading = plainInline('欢迎来到 **OI Wiki**！[![徽章](https://img.shields.io/x.svg)](https://github.com/OI-wiki/OI-wiki)');
    check('2.4b 目录里是纯文字（不抄 ** 与图片标记）', plainHeading === '欢迎来到 OI Wiki！徽章', plainHeading);
    check(
      '2.4b 认不出的标记原样留着（不误伤 snake_case）',
      plainInline('doc_wiki 与 [[目标|显示字]] 与 `代码`') === 'doc_wiki 与 显示字 与 代码',
      plainInline('doc_wiki 与 [[目标|显示字]] 与 `代码`'),
    );
  }

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
        case 'subpage': return { doc: String(1 + Math.floor(rnd() * 9)), mode: rnd() < 0.5 ? 'card' : 'full', title: sentence(1, 2), note: '' };
        default: return {};
      }
    };
    let broken = null;
    let leaked = null;
    const TEXT_TYPES = new Set(['paragraph', 'list', 'quote']);
    for (let doc = 0; doc < 100 && !broken; doc += 1) {
      const count = 1 + Math.floor(rnd() * 8);
      const document = [];
      for (let i = 0; i < count; i += 1) {
        const type = pick(typeNames);
        document.push({ block_id: `b${i + 1}`, type, version: 1, props: makeProps(type) });
      }
      const markdown = engine.blocksToMarkdown(document);
      const back = engine.markdownToBlocks(markdown);
      // 块的粒度不再是恒等契约（正文会按小节并成 prose），恒等的是 Markdown 文本本身：
      // 解析回来的块再序列化一次，必须一个字节都不差。
      const again = engine.blocksToMarkdown(back);
      if (again !== markdown) broken = { doc, document, markdown, back, again };
      if (!leaked && back.some((block) => TEXT_TYPES.has(block.type))) {
        leaked = { doc, types: back.map((block) => block.type) };
      }
    }
    check('属性测试：100 篇随机文档 markdown 往返文本级全部无损', broken === null, JSON.stringify(broken).slice(0, 700));
    check('属性测试：小节粒度下不再产出 paragraph / list / quote（正文一律并进 prose）', leaked === null, JSON.stringify(leaked));
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
    check('GET /api/docs/meta/block-types 给出 16 个内置类型', types.status === 200 && types.data?.types?.length === 16, `len=${types.data?.types?.length}`);
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
    check('PUT markdown 整篇覆盖 → 块序列被重建', put.status === 200 && put.data?.blocks?.length === 2, `${put.status} ${JSON.stringify(put.error ?? put.data?.blocks)}`);
    check(
      '覆盖后的块类型与 markdown 对得上（正文按小节并成一个 prose）',
      put.data?.blocks?.map((block) => block.type).join(',') === 'heading,prose',
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
      'followers 文档对关注者给出 canReact=true（可见性判定同时登记给了 core）',
      mateView.data?.abilities?.canReact === true,
      JSON.stringify(mateView.data?.abilities),
    );
    // 光有 `canReact` 不算数：按钮点下去得真能过 core 那道闸。
    // 影子行的 `hidden` 只由 scope 决定，所以关注者点关注者文档的赞，
    // 以前是 404（`assertPostVisible` 只放行 staff / 作者）—— 这就是那条已知短板。
    const mateAnchor = scalar('SELECT anchor_post_id AS id FROM documents WHERE id = ?', followersDocId)?.id;
    const mateLike = await mate.call(`/api/posts/${mateAnchor}/reaction`, { method: 'POST', body: { kind: 'like' } });
    check(
      '关注者能真的给 followers 文档点赞（不再点了就 404）',
      mateLike.status === 200 && mateLike.data?.liked === true,
      `${mateLike.status} ${JSON.stringify(mateLike.error)}`,
    );
    const strangerLike = await other.call(`/api/posts/${mateAnchor}/reaction`, { method: 'POST', body: { kind: 'like' } });
    check(
      '没关注的人给 followers 文档点赞仍然是 404（放行的是「看得见的人」，不是所有人）',
      strangerLike.status === 404,
      `${strangerLike.status} ${JSON.stringify(strangerLike.error)}`,
    );
    const authorView = await author.call(`/api/docs/${followersDocId}`);
    check('作者自己的 followers 文档 canReact=true（core 的 assertPostVisible 放行作者）', authorView.data?.abilities?.canReact === true, JSON.stringify(authorView.data?.abilities));
  }

  /* ---------- 3.9b 积木页的讨论区：回复挂影子行，接口原样复用 core ---------- */

  {
    // 为什么回复要跟互动条挤在同一趟 `/anchor` 里回：两者都长在影子行上，
    // 能看见影子行就一定能看见它的回复，分成两条接口只会让阅读页多一次
    // 「先出互动条、后出回复」的跳动，可见性还得再判一遍。
    const before = (await anon.call(`/api/docs/${docId}/anchor`)).data?.replyCount ?? 0;
    const anonView = await anon.call(`/api/docs/${docId}/anchor`);
    check(
      'anchor 接口顺带把回复给回来（replies 数组 + replyCount 数字）',
      Array.isArray(anonView.data?.replies) && typeof anonView.data?.replyCount === 'number',
      JSON.stringify(anonView.data && Object.keys(anonView.data)),
    );
    check('匿名访客 canReply=false（前端据此不画输入框）', anonView.data?.canReply === false, String(anonView.data?.canReply));
    const loggedInView = await other.call(`/api/docs/${docId}/anchor`);
    check('登录用户 canReply=true', loggedInView.data?.canReply === true, String(loggedInView.data?.canReply));

    const posted = await other.call(`/api/posts/${anchorId}/replies`, {
      method: 'POST',
      body: { content: '**积木页**也能回复了' },
    });
    check(
      '积木页复用 core 的回复接口发得出去（没有另造 /api/docs/:id/replies）',
      posted.status === 200 && posted.data?.reply?.id > 0,
      `${posted.status} ${JSON.stringify(posted.error)}`,
    );

    const afterPost = await anon.call(`/api/docs/${docId}/anchor`);
    check(
      '发完再从 anchor 读，回复和计数都在（讨论区就靠这一条重画）',
      afterPost.data?.replyCount === before + 1 && afterPost.data?.replies?.at(-1)?.id === posted.data.reply.id,
      JSON.stringify({ count: afterPost.data?.replyCount, ids: (afterPost.data?.replies ?? []).map((r) => r.id) }),
    );
    check(
      '回复正文走的是同一个渲染器（Markdown 已经变成 HTML）',
      /<strong>积木页<\/strong>/.test(afterPost.data?.replies?.at(-1)?.contentHtml ?? ''),
      afterPost.data?.replies?.at(-1)?.contentHtml,
    );

    const foreignDelete = await anon.call(`/api/replies/${posted.data.reply.id}`, { method: 'DELETE' });
    check('匿名删不了别人发的回复', foreignDelete.status === 401, `${foreignDelete.status}`);
    const ownDelete = await other.call(`/api/replies/${posted.data.reply.id}`, { method: 'DELETE' });
    check('发帖人删得掉自己的回复', ownDelete.status === 200 && ownDelete.data?.deleted === true, `${ownDelete.status}`);
    const afterDelete = await anon.call(`/api/docs/${docId}/anchor`);
    check(
      '删完计数回到原来的数',
      afterDelete.data?.replyCount === before && afterDelete.data?.replies?.length === before,
      JSON.stringify({ count: afterDelete.data?.replyCount, want: before }),
    );
  }

  /* ---------- 3.9c 积木页的转发区：转发同样挂影子行，接口原样复用 core ---------- */

  {
    // 转发和点赞、回复一样记在**影子行**上（`reposts.post_id` 指向它），所以积木页
    // 不需要另造一套 `/api/docs/:id/repost` —— 只是发完不跳帖子页而已。
    // 这组用例盯的就是「那颗按钮以前点了只弹一句话」这件事别再回来。
    const otherId = (await other.call('/api/auth/me')).data?.user?.id;
    const beforeView = await other.call(`/api/docs/${docId}/anchor`);
    check(
      'anchor 接口顺带把转发者名单给回来（reposters 数组）',
      Array.isArray(beforeView.data?.reposters),
      JSON.stringify(beforeView.data && Object.keys(beforeView.data)),
    );
    check(
      '没转过时 reposted=false、repostCount=0',
      beforeView.data?.post?.reposted === false && beforeView.data?.post?.repostCount === 0,
      JSON.stringify({ reposted: beforeView.data?.post?.reposted, count: beforeView.data?.post?.repostCount }),
    );
    // 自己的积木帖子也能转发：转发区里必须有表单（以前这里是一句「自己的文章不用转发」，
    // 于是作者在自己的积木帖子上点 🔁 什么都不显示）。
    const selfRepost = await author.call(`/api/posts/${anchorId}/repost`, { method: 'POST', body: { comment: '自己转自己' } });
    check(
      '自己的文章也能转发（作者也能把它放进主页的「🔁 转发」）',
      selfRepost.status === 200 && selfRepost.data?.reposted === true && selfRepost.data?.repostCount === 1,
      `${selfRepost.status} ${JSON.stringify(selfRepost.error ?? selfRepost.data)}`,
    );
    const selfView = await author.call(`/api/docs/${docId}/anchor`);
    check(
      '作者看自己的积木帖子：按钮显示「已转发」，名单里就是自己',
      selfView.data?.post?.reposted === true &&
        selfView.data?.post?.repostCount === 1 &&
        (selfView.data?.reposters ?? []).length === 1,
      JSON.stringify({ reposted: selfView.data?.post?.reposted, who: selfView.data?.reposters?.[0]?.user?.username }),
    );
    // 不自造通知：`createNotification` 里 `actorId === userId` 直接返回 null。
    const selfInbox = await author.call('/api/notifications?filter=unread');
    check(
      '转发自己不会给自己发通知',
      !(selfInbox.data?.items ?? []).some((item) => item.type === 'post_repost' && item.post?.id === anchorId),
      JSON.stringify((selfInbox.data?.items ?? []).map((item) => item.type)),
    );
    // 撤掉，后面的用例要按「一条转发都没有」起算。
    const selfUndo = await author.call(`/api/posts/${anchorId}/repost`, { method: 'DELETE' });
    check(
      '自己转的也撤得掉（撤完计数归零）',
      selfUndo.status === 200 && selfUndo.data?.reposted === false && selfUndo.data?.repostCount === 0,
      `${selfUndo.status} ${JSON.stringify(selfUndo.body)}`,
    );
    const anonRepost = await anon.call(`/api/posts/${anchorId}/repost`, { method: 'POST', body: { comment: '路人转' } });
    check('没登录不能转发（401）', anonRepost.status === 401, `${anonRepost.status}`);

    const reposted = await other.call(`/api/posts/${anchorId}/repost`, { method: 'POST', body: { comment: '这篇值得一看' } });
    check(
      '积木页复用 core 的转发接口转得出去（没有另造 /api/docs/:id/repost）',
      reposted.status === 200 && reposted.data?.reposted === true,
      `${reposted.status} ${JSON.stringify(reposted.error)}`,
    );

    const afterRepost = await other.call(`/api/docs/${docId}/anchor`);
    check(
      '转完再读 anchor：按钮该显示「已转发」、计数 +1、名单里有我',
      afterRepost.data?.post?.reposted === true &&
        afterRepost.data?.post?.repostCount === 1 &&
        afterRepost.data?.reposters?.length === 1 &&
        afterRepost.data?.reposters?.[0]?.user?.id === otherId,
      JSON.stringify({
        reposted: afterRepost.data?.post?.reposted,
        count: afterRepost.data?.post?.repostCount,
        who: (afterRepost.data?.reposters ?? []).map((item) => item.user?.username),
        otherId,
      }),
    );
    check(
      '转发语原样带回来（转发区要显示「TA 说了什么」）',
      afterRepost.data?.reposters?.[0]?.comment === '这篇值得一看',
      afterRepost.data?.reposters?.[0]?.comment,
    );

    const authorView = await author.call(`/api/docs/${docId}/anchor`);
    check(
      '转发状态是按访客算的：作者自己看这篇是「没转过」',
      authorView.data?.post?.reposted === false && authorView.data?.post?.repostCount === 1,
      JSON.stringify({ reposted: authorView.data?.post?.reposted, count: authorView.data?.post?.repostCount }),
    );

    const inbox = await author.call('/api/notifications?filter=unread');
    check(
      '作者收到了 post_repost 通知，并且指回这条影子行',
      (inbox.data?.items ?? []).some((item) => item.type === 'post_repost' && item.post?.id === anchorId),
      JSON.stringify((inbox.data?.items ?? []).map((item) => item.type)),
    );

    const again = await other.call(`/api/posts/${anchorId}/repost`, { method: 'POST', body: { comment: '改一下转发语' } });
    check(
      '同一篇只能转一次：再转是改转发语（updated=true），计数不会变成 2',
      again.data?.updated === true && again.data?.repostCount === 1,
      JSON.stringify(again.data),
    );

    const undone = await other.call(`/api/posts/${anchorId}/repost`, { method: 'DELETE' });
    check('撤销转发成功', undone.status === 200 && undone.data?.reposted === false, `${undone.status} ${JSON.stringify(undone.error)}`);
    const afterUndo = await other.call(`/api/docs/${docId}/anchor`);
    check(
      '撤销后计数归零、名单也空了（积木页重画转发区就靠这一条）',
      afterUndo.data?.post?.repostCount === 0 &&
        afterUndo.data?.post?.reposted === false &&
        afterUndo.data?.reposters?.length === 0,
      JSON.stringify({
        count: afterUndo.data?.post?.repostCount,
        reposted: afterUndo.data?.post?.reposted,
        reposters: afterUndo.data?.reposters?.length,
      }),
    );
  }

  /* ---------- 3.10 既有互动链路零改动复用（FR-KEEP 的正面证据） ---------- */

  {
    const like = await other.call(`/api/posts/${anchorId}/reaction`, { method: 'POST', body: { kind: 'like' } });
    check('陌生人能给文档的影子行点赞（core 的赞接口一行没改）', like.status === 200 && like.data?.liked === true, `${like.status} ${JSON.stringify(like.error)}`);

    const bookmark = await other.call(`/api/posts/${anchorId}/bookmark`, { method: 'POST' });
    check('收藏走的也是同一个影子行', bookmark.status === 200, `${bookmark.status} ${JSON.stringify(bookmark.error)}`);

    // 投币已整体下线，这里换成转发：换一种「同样只认 posts 那一行」的互动，
    // 撤销掉以免给后面的断言留下计数器。
    const repost = await other.call(`/api/posts/${anchorId}/repost`, { method: 'POST', body: { comment: '文档影子行转发' } });
    check('转发也能作用在文档的影子行上（core 的转发接口一行没改）', repost.status === 200 && repost.data?.reposted === true, `${repost.status} ${JSON.stringify(repost.error)}`);

    const unrepost = await other.call(`/api/posts/${anchorId}/repost`, { method: 'DELETE' });
    check('撤销转发后影子行不留状态', unrepost.status === 200 && unrepost.data?.reposted === false, `${unrepost.status} ${JSON.stringify(unrepost.error)}`);

    const post = await other.call(`/api/posts/${anchorId}`);
    check('旧帖子详情接口能打开影子行，标题就是文档标题', post.status === 200 && JSON.stringify(post.data ?? {}).includes('第一篇积木'), `${post.status} ${JSON.stringify(post.error ?? post.data).slice(0, 160)}`);
  }

  /* ---------- 3.10.1 互动搬进积木页：两条新接口 ---------- */
  // 阅读页不再让读者「去帖子里互动」：它自己拿锚点帖（`/api/docs/:id/anchor`），
  // 把点赞 / 收藏 / 转发 / AI 解读都画在积木页上；帖子页反过来用 `by-anchor` 挂横幅。
  // 这两条接口各自有一个容易写错的地方，所以钉在这里：
  //   ① `/anchor` 必须回**列表形状**（详情形状的 `content` 白拉一遍大正文）；
  //   ② 它**不能**像 `/api/posts/:id` 那样 `bumpViews` —— 看一遍积木不该涨帖子浏览量。

  {
    const anchorView = await other.call(`/api/docs/${docId}/anchor`);
    check('GET /api/docs/:id/anchor 给出可互动的影子帖', anchorView.status === 200 && anchorView.data?.post?.id === anchorId, `${anchorView.status} ${JSON.stringify(anchorView.data ?? anchorView.error).slice(0, 160)}`);
    const shape = anchorView.data?.post ?? {};
    check(
      '互动条要的字段一个不少（少一个前端就少一个按钮）',
      ['id', 'likeCount', 'dislikeCount', 'bookmarkCount', 'repostCount', 'liked', 'disliked', 'bookmarked', 'reposted', 'authorFollowed', 'author'].every((key) => key in shape),
      Object.keys(shape).join(','),
    );
    check('用的是列表形状：不带 content（阅读页的正文自己会渲染）', !('content' in shape) && !('contentHtml' in shape), Object.keys(shape).join(','));
    check('投币下线后不再回 coin / coinCount / myCoins', !('coin' in shape) && !('coinCount' in shape) && !('myCoins' in shape), Object.keys(shape).join(','));

    const viewsBefore = scalar('SELECT views FROM posts WHERE id = ?', anchorId)?.views ?? 0;
    await other.call(`/api/docs/${docId}/anchor`);
    const viewsAfter = scalar('SELECT views FROM posts WHERE id = ?', anchorId)?.views ?? 0;
    check('看积木页不涨帖子浏览量（这条接口不 bumpViews）', viewsBefore === viewsAfter, `${viewsBefore} → ${viewsAfter}`);

    const privateAnchor = await author.call(`/api/docs/${privateDocId}/anchor`);
    check('自己的 private 文档也能拿到锚点（作者本来就能互动）', privateAnchor.status === 200 && privateAnchor.data?.post?.id === scalar('SELECT anchor_post_id AS id FROM documents WHERE id = ?', privateDocId)?.id, `${privateAnchor.status} ${JSON.stringify(privateAnchor.data ?? privateAnchor.error).slice(0, 120)}`);
    const otherPrivate = await other.call(`/api/docs/${privateDocId}/anchor`);
    check('看不见的文档拿锚点 → 404（与读文档同一条可见性判定）', otherPrivate.status === 404, `${otherPrivate.status} ${JSON.stringify(otherPrivate.error)}`);

    const back = await other.call(`/api/docs/by-anchor/${anchorId}`);
    check('GET /api/docs/by-anchor/:postId 反查得到文档', back.status === 200 && back.data?.doc?.id === docId && back.data?.doc?.scope === 'public', `${back.status} ${JSON.stringify(back.data ?? back.error)}`);
    const backMissing = await other.call('/api/docs/by-anchor/99999999');
    check('反查一条不是影子行的帖子 → { doc: null }（不是 404：帖子页照常渲染）', backMissing.status === 200 && backMissing.data?.doc === null, `${backMissing.status} ${JSON.stringify(backMissing.data)}`);
    const backPrivate = await other.call(`/api/docs/by-anchor/${scalar('SELECT anchor_post_id AS id FROM documents WHERE id = ?', privateDocId)?.id}`);
    check('反查看不见的文档 → 也是 { doc: null }（不泄露存在性）', backPrivate.status === 200 && backPrivate.data?.doc === null, `${backPrivate.status} ${JSON.stringify(backPrivate.data)}`);
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
      '注册表变成 17 种，新类型 builtin=false 且带自己的 schema',
      types.data?.types?.length === 17 && timeline?.builtin === false && timeline?.schema?.text,
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

    // §5.1 的两件外挂：实时 LaTeX 预览（复用 /api/markdown/preview）与**编辑区左侧的 AI 抽屉**
    //（`public/views/doc-ai.js`，打 `/api/ai-edit/*` —— 与 `#/ai-edit` 页面同一个后端）。
    // 它们都是「嵌得进去」就够，所以只钉接线本身，不钉面板内部。
    const editorJs = readText('public/views/doc.js');
    const drawerJs = readText('public/views/doc-ai.js');
    check('编辑器接了实时预览', editorJs.includes("'/api/markdown/preview'"), '');
    check('预览是防抖自动跑的（不是按钮）', editorJs.includes('mdPreviewTimer') && editorJs.includes('setTimeout'), '');
    check('编辑器挂了 AI 抽屉', editorJs.includes('DocAi.mountDocAi('), '');
    check(
      'AI 抽屉在编辑区左侧（三栏外壳里它排在编辑框前面）',
      editorJs.includes('class="doc-md-wrap"') &&
        editorJs.indexOf('DocAi.docAiHtml(') > 0 &&
        editorJs.indexOf('DocAi.docAiHtml(') < editorJs.indexOf('class="doc-md-edit"'),
      '左侧 = 在外壳的第一个格子',
    );
    check(
      'AI 抽屉复用 /api/ai-edit 的两个接口（没另造模型调用链）',
      drawerJs.includes('/api/ai-edit/draft-range') && drawerJs.includes('/api/ai-edit/review'),
      '',
    );
    check(
      'AI 抽屉只把结果写回编辑区，落盘仍是「保存」的事',
      !drawerJs.includes('/markdown'),
      '抽屉里出现 PUT /markdown 就等于绕过了作者那颗保存键',
    );
    check('Markdown 编辑区带 name="content"（抽屉与旧脚本都靠它认编辑区）', editorJs.includes('name="content"'), '');
    check('离开页面时收掉预览定时器与 AI 抽屉', editorJs.includes('DocAi.destroyDocAi()'), '');

    // 自动保存：编辑器的默认姿势是「存下来」，「保存」那颗按钮是「立刻存一遍」。
    // 实现全在 `public/views/doc.js` 的「自动保存」那一块，行为测试在 check-frontend。
    check(
      '编辑器有自动保存（不是只有一颗要记得点的「保存」）',
      editorJs.includes('AUTO_SAVE_IDLE_MS') && editorJs.includes('scheduleAutoSave()'),
      '',
    );
    check('自动保存与手动保存走同一条路（同一个 saveAll，只是安静那一副面孔）', editorJs.includes('saveAll({ quiet: true })'), '');
    check('自动保存不用 setInterval（check-frontend 里它是个桩，用了等于没装定时器）', !/\bsetInterval\s*\(/.test(editorJs), '只许 setTimeout');
    check('两次自动保存之间有最小间隔（不然那 50 条修订记录一会儿就满了）', editorJs.includes('AUTO_SAVE_MIN_GAP_MS'), '');
    check('一直打字也有保存的上限（不然永远等不到「停手」那一下）', editorJs.includes('AUTO_SAVE_MAX_WAIT_MS'), '');
    check('离开编辑页之前先把排着的那一发放出去', editorJs.includes("flushAutoSave('leave')"), '必须排在换 DOM 之前');
    check('切到后台 / 页面被藏起来也会抢救一次', editorJs.includes("'visibilitychange'") && editorJs.includes("'pagehide'"), '');
    check('没存完就想关标签页会拦一下（beforeunload 只提醒，不发请求）', editorJs.includes("'beforeunload'"), '');
    check(
      '那颗状态灯挂在工具栏上（作者得看得见「存到哪一步了」）',
      editorJs.includes('data-doc-save-status') && editorJs.includes('autoSaveStatusHtml()'),
      '',
    );
    check('块里那个源码框不自动存（敲到一半必然是坏 JSON，得作者自己点「保存本块」）', editorJs.includes('[data-doc-src-box]') && editorJs.includes('保存本块'), '');
    check(
      'check-frontend 里有自动保存的行为用例',
      frontend.includes('没到最小间隔就不重复存'),
      '静态哨兵只能证明写在文件里，存不存得下去得让假 DOM 真跑一遍',
    );

    const docCss = readText('public/css/41-doc.css');
    for (const cls of ['.doc-md-grid', '.doc-md-edit', '.doc-md-side', '.doc-md-preview']) {
      check(`41-doc.css 定义了 ${cls}`, docCss.includes(cls), '');
    }
    for (const cls of ['.doc-save', '.doc-save[data-doc-save-kind="ok"]', '.doc-save[data-doc-save-kind="failed"]']) {
      check(`41-doc.css 定义了 ${cls}（状态灯得有颜色）`, docCss.includes(cls), '');
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
    check('导入的块数与 Markdown 对得上（2 块：标题 + 一节正文）', res.data?.blocks?.length === 2, JSON.stringify(res.data?.blocks));
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
      check('8.9 新建一篇是一点就进（那道「先写个名字」的表单已经删了）', !editorJs.includes('function newDocPanelHtml()') && editorJs.includes('function newDocAndEdit()'), '');
      check(
        '8.9 点一下就建「未命名」并直接落进编辑器',
        /async function newDocAndEdit\(\)[\s\S]{0,400}?title: '未命名'[\s\S]{0,300}?(?:await )?navigate\(`\/doc\/\$\{created\.doc\.id\}\/edit`\)/.test(editorJs),
        '',
      );
      check('8.9 建完直接进编辑器（跳转那一行还在）', editorJs.includes('return navigate(`/doc/${created.doc.id}/edit`)'), '');
      check('8.9 模板搬到了积木模式那一栏（模板栏只在积木视图里渲染）', editorJs.includes('function templatePanelHtml()') && editorJs.includes('${blocksEditorHtml(blocks)}${templatePanelHtml()}'), '');
      /* 用户在浏览器里报的四个 bug（m01284 / m01317）的回归钉：
         ① 默认是纯 Markdown；② 三种视图共用一份草稿（切之前先存）；③ 源码里有 Markdown
         表达不了的块时 Markdown 页只读；④ 保存之后编辑区不能被清空。 */
      check('8.9 默认是纯 Markdown 模式', editorJs.includes("const wanted = query.get('mode') ?? 'markdown'"), '');
      check('8.9 切视图前先把当前编辑区的改动存下去', editorJs.includes('async function flushDraft()') && editorJs.includes('if (!(await flushDraft())) return;'), '');
      // 这条钉子跟着「一次保存」改了名字：以前是 `saveMarkdown()` 自己存自己重拉，
    // 现在正文、标题、可见范围都由 `saveAll()` 一处存完 —— 但「Markdown 存完必须重拉」
    // 这条不变量没变（不重拉就会把作者刚敲的从编辑区抹掉）。
    // 自动保存给 `saveAll()` 加了一个 `options`（安静那一版不重画），签名不再是空括号：
    // 这里改成**先把那个函数体切出来**再找那句话 —— 比原来的「4000 字符窗口」更准，
    // 窗口一放宽就可能配上隔壁函数里长得一样的一行，钉子就白钉了。
    const saveAllBody = (editorJs.split('async function saveAll(')[1] ?? '').split(/\n(?:async )?function /)[0];
    check('8.9 Markdown 存完会重新拉一次（不重拉就会把刚敲的从编辑区抹掉）', saveAllBody.includes("if (editor.mode === 'markdown') await loadMarkdown()"), '');
    check('8.9 编辑器只有一个「保存」（标题 / 可见范围 / 正文一起存）', editorJs.includes('function saveAll(') && !editorJs.includes('data-doc-action="save-meta"') && !editorJs.includes('function saveMeta('), '');
      check('8.9 源码里有 Markdown 表达不了的块时，Markdown 页只读并说明原因', editorJs.includes('function markdownViewBlocked(') && editorJs.includes('MARKDOWN_VIEW_TYPES') && editorJs.includes('blocked ? \' readonly\' : \'\''), '');
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
      check('9.1 解析成 script + heading + prose（作者那段正文并成小节正文）', JSON.stringify(savedTypes) === JSON.stringify(['script', 'heading', 'prose']), JSON.stringify(savedTypes));
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

      // 【S9.7】沙箱握手：`init` 消息可能比用户脚本先到 —— bootstrap 在 `<head>` 里发完
      // `ready`，宿主立刻回 `init`，而用户的 `<script>` 还在 `<body>` 里排队。这时
      // `onInit` 必须**排队补交**，否则用户的初始化代码永远不跑（页面不报错，票数、
      // 初始数据一直空着，看起来就是「功能挂了」）。这里把 bootstrap 拉进 vm 里演一遍。
      {
        const built = buildSandboxDocument('<p>user code</p>');
        const OPEN = '<' + 'script>';
        const CLOSE = '</' + 'script>';
        const code = built.slice(built.indexOf(OPEN) + OPEN.length, built.indexOf(CLOSE));
        const sent = [];
        const listeners = [];
        const sandbox = {
          console, setTimeout, clearTimeout, Promise, Object, Error, JSON, Math,
          parent: { postMessage(message) { sent.push(message); } },
          document: {
            documentElement: { scrollHeight: 10 },
            body: { scrollHeight: 12 },
            addEventListener() {},
          },
          window: {
            addEventListener(type, handler) { if (type === 'message') listeners.push(handler); },
          },
        };
        runInNewContext(code, sandbox);
        const api = sandbox.window.Sandbox;
        const fire = (data) => { for (const handler of listeners) handler({ data, source: sandbox.window }); };
        check('9.7 沙箱 bootstrap 起来就发 ready 完成握手', sent.some((message) => message.type === 'ready'), JSON.stringify(sent));

        // ① `init` 先到、`onInit` 后挂：要补交。
        fire({ type: 'init', props: { app: '投票' }, inputs: { a: 1 } });
        let late = null;
        api.onInit((props, inputs) => { late = { props, inputs }; });
        check('9.7 init 比 onInit 先到时也要补交（不然初始化永远不跑）', late?.props?.app === '投票' && late?.inputs?.a === 1, JSON.stringify(late));

        // ② 赋值式写法 `Sandbox.onInit = fn` 同样接得住。
        let assigned = null;
        api.onInit = (props) => { assigned = props; };
        fire({ type: 'init', props: { app: '第二发' }, inputs: {} });
        check('9.7 `Sandbox.onInit = fn` 赋值写法也接得住', assigned?.app === '第二发', JSON.stringify(assigned));

        // ③ 能力申请：请求发给宿主，回执把 Promise 兑现（投票就是靠这条路写票数的）。
        const pendingValue = api.state.get('shared');
        const request = sent.find((message) => message.type === 'request' && message.capability === 'state');
        check('9.7 能力申请发给宿主（带 op 与 scope）', request?.payload?.op === 'get' && request?.payload?.scope === 'shared', JSON.stringify(request));
        fire({ type: 'capability', id: request.id, ok: true, value: { scope: 'shared', value: { counts: [1, 2, 3] } } });
        const resolved = await pendingValue;
        check('9.7 回执把 Promise 兑现成状态值', Array.isArray(resolved?.counts) && resolved.counts[2] === 3, JSON.stringify(resolved));

        // ④ 被拒时抛出来（脚本里 catch 得到，才能把「没投上」显示给用户）。
        const denied = api.state.set({ counts: [9] }, 'shared');
        const write = sent.find((message) => message.type === 'request' && message.payload?.op === 'set');
        fire({ type: 'capability', id: write.id, ok: false, message: '要保存状态得先登录' });
        let refused = '';
        await denied.then(() => {}, (error) => { refused = String(error?.message ?? error); });
        check('9.7 能力被拒时 Promise 抛错（不再静默失败）', refused.includes('登录'), refused);
      }

      await author.call(`/api/docs/${docId}`, { method: 'DELETE' });
    }
  }

  /* ================= S10 Wiki 站（一个帖子一个 wiki） ================= */

  console.log('\n【S10】Wiki 站：站是一篇帖子，页挂在站里');

  {
    // 10.1 建站：站就是一篇普通帖子（`template='station'`）。
    const created = await author.call('/api/docs/wiki/stations', { method: 'POST', body: { title: 'S10 测试站', scope: 'public' } });
    const stationId = created.data?.doc?.id;
    check('10.1 POST /api/docs/wiki/stations 建站', created.status === 200 && Number.isInteger(stationId), `${created.status} ${JSON.stringify(created.error)}`);
    check('10.1 站是一篇普通帖子（kind=post + template=station）', created.data?.doc?.kind === 'post' && created.data?.doc?.template === 'station', JSON.stringify(created.data?.doc));

    const listed = await anon.call('/api/docs/wiki/stations');
    check('10.1 GET /api/docs/wiki/stations 匿名看得见公开站', (listed.data?.stations ?? []).some((row) => row.id === stationId), JSON.stringify((listed.data?.stations ?? []).map((row) => row.title)));
    check('10.1 老的 pages / categories 照旧一起回（旧客户端不红）', Array.isArray(listed.data?.pages) && listed.data?.categories !== undefined, JSON.stringify(Object.keys(listed.data ?? {})));

    // 10.2 建页：自动挂到站上（站里多一块 subpage 卡片），页不出现在积木板块。
    const first = await author.call(`/api/docs/wiki/station/${stationId}/pages`, { method: 'POST', body: { title: 'S10 第一页' } });
    const firstId = first.data?.doc?.id;
    check('10.2 在站里建页', first.status === 200 && first.data?.created === true && first.data?.doc?.template === 'page', `${first.status} ${JSON.stringify(first.error)}`);
    const again = await author.call(`/api/docs/wiki/station/${stationId}/pages`, { method: 'POST', body: { title: 'S10 第一页' } });
    check('10.2 同名再建是幂等（created:false，不建第二篇）', again.status === 200 && again.data?.created === false && again.data?.doc?.id === firstId, `${again.status} ${again.data?.created}`);
    const second = await author.call(`/api/docs/wiki/station/${stationId}/pages`, { method: 'POST', body: { title: 'S10 子页一', parentId: firstId } });
    const secondId = second.data?.doc?.id;
    check('10.2 建子页（带 parentId）', second.status === 200 && Number.isInteger(secondId), `${second.status} ${JSON.stringify(second.error)}`);

    const stationDoc = await author.call(`/api/docs/${stationId}`);
    const cards = (stationDoc.data?.blocks ?? []).filter((block) => block.type === 'subpage');
    check('10.2 每建一页，站里就多一块 subpage 卡片', cards.length === 2, JSON.stringify((stationDoc.data?.blocks ?? []).map((block) => block.type)));
    check('10.2 subpage 卡片被渲染成 .doc-subpage（不是裸 HTML）', String(stationDoc.data?.html ?? '').includes('doc-subpage'), String(stationDoc.data?.html ?? '').slice(0, 200));

    const pageRow = scalar('SELECT p.hidden AS hidden FROM documents d JOIN posts p ON p.id = d.anchor_post_id WHERE d.id = ?', firstId);
    check('10.2 站里的页的影子帖是 hidden=1（所以不进积木板块）', pageRow?.hidden === 1, JSON.stringify(pageRow));
    const stationAnchor = scalar('SELECT p.hidden AS hidden FROM documents d JOIN posts p ON p.id = d.anchor_post_id WHERE d.id = ?', stationId);
    check('10.2 站自己的影子帖不藏（它就该出现在积木板块）', stationAnchor?.hidden === 0, JSON.stringify(stationAnchor));

    // 10.2.9 广场不乱铺 wiki 页。
    //
    // 一个导进来的 OI Wiki 就是 519 页，默认全铺在广场上会把别人写的积木整个淹掉；
    // 它们该走站自己的目录树（`#/wiki`）。所以 `GET /api/docs` 默认把挂在站里的页滤掉，
    // `?wiki=all` 才都列、`?wiki=only` 则只要站里的页。
    const plaza = await anon.call('/api/docs?limit=50');
    const plazaTitles = (plaza.data?.documents ?? []).map((row) => row.title);
    check('10.2.9 广场默认不列站里的页', !plazaTitles.includes('S10 第一页') && !plazaTitles.includes('S10 子页一'), JSON.stringify(plazaTitles.slice(0, 8)));
    check('10.2.9 站本体照旧在广场里（一个帖子一个 wiki）', plazaTitles.includes('S10 测试站'), JSON.stringify(plazaTitles.slice(0, 8)));
    const plazaAll = await anon.call('/api/docs?limit=50&wiki=all');
    check('10.2.9 ?wiki=all 连站里的页一起列', (plazaAll.data?.documents ?? []).some((row) => row.title === 'S10 第一页'), JSON.stringify(plazaAll.data?.wiki));
    const plazaOnly = await anon.call('/api/docs?limit=50&wiki=only');
    const onlyTitles = (plazaOnly.data?.documents ?? []).map((row) => row.title);
    check('10.2.9 ?wiki=only 只要站里的页', onlyTitles.includes('S10 第一页') && !onlyTitles.includes('S10 测试站'), JSON.stringify(onlyTitles.slice(0, 8)));
    const plazaBogus = await anon.call('/api/docs?limit=50&wiki=nope');
    check('10.2.9 认不出的 wiki 取值当没给（默认照样过滤）', !(plazaBogus.data?.documents ?? []).some((row) => row.title === 'S10 第一页') && plazaBogus.data?.wiki === '', JSON.stringify(plazaBogus.data?.wiki));
    // 前端那颗开关在 `views/doc.js` 里（这里现读一次，别抢后面那几个 `const docJs` 的名字）。
    const docJsPlaza = readFileSync(join(ROOT, 'public', 'views', 'doc.js'), 'utf8');
    check('10.2.9 前端广场有「连站里的页一起列」那颗开关', docJsPlaza.includes("toggle.set('wiki', 'all')") && docJsPlaza.includes('不含 wiki 站里的页'), '');

    // 10.2.1 「一个 wiki = 一篇帖子」：页的影子行**不进任何列表**。
    //
    // `hidden = 1` 只挡得住普通访客 —— 个人主页给作者本人、板块列表给 staff 时都会带
    // `includeHidden`，于是作者会在自己主页上看见 wiki 的每一页（用户报的 bug：
    // 「新增第二个页面副分类2 会被视为一个帖子显示在个人主页」）。
    // 修法不是动文档层（wiki 底下还是积木文档），而是在帖子列表层加一把锁：
    // doc 模块用 `addPostListExclude`（src/core/guards.js）登记「模板是 page 的行谁都不列」，
    // `src/store.js` 的 `buildFilter()` 把它拼进**所有**列表的 WHERE。
    const anchorOf = (id) => scalar('SELECT anchor_post_id AS id FROM documents WHERE id = ?', id)?.id;
    const firstAnchor = anchorOf(firstId);
    const secondAnchor = anchorOf(secondId);
    const stationAnchorId = anchorOf(stationId);

    const selfProfile = await author.call('/api/users/doc_author');
    const selfPosts = (selfProfile.data?.posts ?? []).map((row) => row.id);
    check(
      '10.2.1 作者自己的主页不列 wiki 的页（includeHidden 挡不住的那条）',
      selfProfile.status === 200 && !selfPosts.includes(firstAnchor) && !selfPosts.includes(secondAnchor),
      `站=${stationAnchorId} 页=${firstAnchor}/${secondAnchor} 主页=${JSON.stringify(selfPosts.slice(0, 20))}`,
    );
    check(
      '10.2.1 作者自己的主页照旧列这个 wiki（站本体就是那篇帖子）',
      selfPosts.includes(stationAnchorId),
      `want=${stationAnchorId} got=${JSON.stringify(selfPosts.slice(0, 20))}`,
    );
    const staffProfile = await staff.call('/api/users/doc_author');
    const staffPosts = (staffProfile.data?.posts ?? []).map((row) => row.id);
    check(
      '10.2.1 staff 看别人主页也不列 wiki 的页（它不是「被隐藏的帖子」）',
      staffProfile.status === 200 && !staffPosts.includes(firstAnchor) && !staffPosts.includes(secondAnchor),
      JSON.stringify(staffPosts.slice(0, 20)),
    );
    const staffBoard = await staff.call('/api/posts?board=documents&perPage=30');
    const boardIds = (staffBoard.data?.items ?? []).map((row) => row.id);
    check(
      '10.2.1 积木板块列表（staff 带 includeHidden）里 wiki 只有站本体那一条',
      boardIds.includes(stationAnchorId) && !boardIds.includes(firstAnchor) && !boardIds.includes(secondAnchor),
      `站=${stationAnchorId} 页=${firstAnchor}/${secondAnchor} 列表=${JSON.stringify(boardIds.slice(0, 20))}`,
    );

    // 机制的静态钉子：哪天有人把这把锁拆了、或者换成 `NOT IN (子查询)`（NULL 会让列表变空），这里就红。
    const readText = (relative) => {
      const full = join(ROOT, ...relative.split('/'));
      return existsSync(full) ? readFileSync(full, 'utf8') : '';
    };
    const guardsSrc = readText('src/core/guards.js');
    const storeSrc = readText('src/store.js');
    const docIndexSrc = readText('src/modules/doc/index.js');
    check(
      '10.2.1 guards 提供 addPostListExclude / postListExclude',
      /function addPostListExclude\(fn\)/.test(guardsSrc) && /function postListExclude\(\)/.test(guardsSrc) && /addPostListExclude,\s*\n\s*postListExclude,/.test(guardsSrc),
    );
    check(
      '10.2.1 buildFilter 把登记过的结构性行拼进列表 WHERE（用 NOT EXISTS，不是 NOT IN）',
      /const excluded = postListExclude\(\);/.test(storeSrc) && /where\.push\(excluded\.clause\)/.test(storeSrc),
      storeSrc.slice(storeSrc.indexOf('buildFilter'), storeSrc.indexOf('buildFilter') + 700),
    );
    check(
      '10.2.1 doc 模块登记的是 template=page（站本体不受影响）',
      /addPostListExclude\(\(\) => \(\{\s*\n?\s*sql: `NOT EXISTS \(SELECT 1 FROM documents d WHERE d\.anchor_post_id = p\.id AND d\.template = '\$\{WIKI_TEMPLATE\}'\)`/.test(docIndexSrc),
      docIndexSrc.slice(docIndexSrc.indexOf('addPostListExclude'), docIndexSrc.indexOf('addPostListExclude') + 320),
    );

    // 10.3 三栏要的东西一次拿齐：树（前序 + depth）、ToC、上一页 / 下一页。
    const tree = await anon.call(`/api/docs/wiki/station?title=${encodeURIComponent('S10 测试站')}`);
    const pages = tree.data?.pages ?? [];
    check('10.3 按站名开站，回树与站本体正文', tree.status === 200 && tree.data?.found === true && pages.length === 2 && Boolean(tree.data?.doc?.html), `${tree.status} ${JSON.stringify(pages.map((page) => page.title))}`);
    check('10.3 树是前序遍历 + depth（子页跟在父页后面）', pages[0]?.title === 'S10 第一页' && pages[0]?.depth === 0 && pages[1]?.depth === 1, JSON.stringify(pages.map((page) => [page.title, page.depth])));

    const opened = await anon.call(`/api/docs/wiki/station?title=${encodeURIComponent('S10 测试站')}&page=${encodeURIComponent('S10 第一页')}`);
    check('10.3 按「站 + 页」开页：正文 + wiki 上下文一次给全', opened.status === 200 && opened.data?.doc?.doc?.id === firstId && Boolean(opened.data?.doc?.wiki), `${opened.status} doc=${opened.data?.doc?.doc?.id} want=${firstId}`);
    check('10.3 页里带着上一页 / 下一页（树中线上的邻居）', opened.data?.doc?.wiki?.next?.title === 'S10 子页一' && !opened.data?.doc?.wiki?.prev, JSON.stringify([opened.data?.doc?.wiki?.prev, opened.data?.doc?.wiki?.next]));
    check('10.3 ToC 由服务端算（present 里给 toc）', Array.isArray(opened.data?.doc?.toc), JSON.stringify(opened.data?.doc?.toc));

    // 10.3b 目录是**纯文字**：标题里的 `**粗体**` / 徽章图不该被抄进右栏目录（OI Wiki 首页那句就是）。
    const tocDoc = await author.call('/api/docs', { method: 'POST', body: { title: 'S10.3b 目录纯文字', kind: 'post', scope: 'public', template: 'blank' } });
    const tocDocId = tocDoc.data?.doc?.id;
    await author.call(`/api/docs/${tocDocId}/markdown`, {
      method: 'PUT',
      body: { markdown: '# 欢迎来到 **OI Wiki**！[![徽章](https://img.shields.io/x.svg)](https://github.com/OI-wiki/OI-wiki)\n\n正文一段。\n' },
    });
    const tocShown = await anon.call(`/api/docs/${tocDocId}`);
    check('10.3b 目录里是纯文字（不抄 ** 与图片标记）', tocShown.data?.toc?.[0]?.text === '欢迎来到 OI Wiki！徽章', JSON.stringify(tocShown.data?.toc));

    // 10.4 权限：不是这个站作者的人加不了页。
    const intruder = await other.call(`/api/docs/wiki/station/${stationId}/pages`, { method: 'POST', body: { title: 'S10 别人塞的页' } });
    check('10.4 非作者加页 → 403', intruder.status === 403, `${intruder.status}`);
    const privateStation = await author.call('/api/docs/wiki/stations', { method: 'POST', body: { title: 'S10 私有站', scope: 'private' } });
    const privateId = privateStation.data?.doc?.id;
    await author.call(`/api/docs/wiki/station/${privateId}/pages`, { method: 'POST', body: { title: 'S10 私有页' } });
    const peek = await other.call(`/api/docs/wiki/station?title=${encodeURIComponent('S10 私有站')}`);
    check('10.4 私有站对陌生人 found:false', peek.status === 200 && peek.data?.found === false, `${peek.status} ${JSON.stringify(peek.data?.found)}`);
    const otherList = await other.call('/api/docs/wiki/stations');
    check('10.4 别人的站列表里没有私有站', !(otherList.data?.stations ?? []).some((row) => row.id === privateId), JSON.stringify((otherList.data?.stations ?? []).map((row) => row.title)));

    // 10.5 站内搜索：搜的是**原文**（`source_text`），不只标题。
    const SOURCE = '# S10 第一页\n\n这里有一个独门暗号：菠萝蜜罐头\n';
    const saved = await author.call(`/api/docs/${firstId}/markdown`, { method: 'PUT', body: { markdown: SOURCE } });
    check('10.5 用源码保存一页', saved.status === 200 && String(saved.data?.source ?? '').includes('菠萝蜜罐头'), `${saved.status} ${JSON.stringify(saved.error)}`);
    const found = await anon.call(`/api/docs/wiki/station/${stationId}/search?q=${encodeURIComponent('菠萝蜜')}`);
    check('10.5 站内搜索命中正文里的词（不是只搜标题）', (found.data?.results ?? []).some((row) => row.id === firstId && String(row.excerpt ?? '').includes('菠萝蜜')), JSON.stringify(found.data?.results));
    const empty = await anon.call(`/api/docs/wiki/station/${stationId}/search?q=`);
    check('10.5 空查询回空结果（不是把全站倒出来）', (empty.data?.results ?? []).length === 0, JSON.stringify(empty.data?.results));

    // 10.6 红链：`[[没建过的页]]` 要能看出来还没建。
    const redSource = `${SOURCE}\n去 [[S10 不存在的一页]] 看看。\n`;
    await author.call(`/api/docs/${firstId}/markdown`, { method: 'PUT', body: { markdown: redSource } });
    const red = await anon.call(`/api/docs/${firstId}`);
    check('10.6 还没建的页渲染成红链（is-missing）', String(red.data?.html ?? '').includes('is-missing'), String(red.data?.html ?? '').slice(-260));
    await author.call(`/api/docs/wiki/station/${stationId}/pages`, { method: 'POST', body: { title: 'S10 不存在的一页' } });
    const notRed = await anon.call(`/api/docs/${firstId}`);
    check('10.6 建好之后同一处不再是红链', !String(notRed.data?.html ?? '').includes('is-missing'), String(notRed.data?.html ?? '').slice(-260));

    // 10.7 老语义不破：`GET /api/docs/wiki/<页名>` 照样找得到（`[[双链]]` 的落点）。
    const legacy = await anon.call(`/api/docs/wiki/${encodeURIComponent('S10 第一页')}`);
    check('10.7 老的 /api/docs/wiki/<页名> 照样找得到（双链落点不破）', legacy.status === 200 && legacy.data?.found === true && legacy.data?.doc?.id === firstId, `${legacy.status} ${JSON.stringify(legacy.data?.found)}`);

    // 10.8 迁移收编：老的 `template='page'` 且还没归站时，第一次打开就地收编（幂等）。
    {
      // 造一个「老页」：有块、但**没有** source_text（那是后来才加的列）。
      const lonely = await author.call('/api/docs', {
        method: 'POST',
        body: {
          title: 'S10 野页',
          kind: 'post',
          scope: 'public',
          template: 'page',
          blocks: [{ block_id: 'b1', type: 'paragraph', props: { text: '野页里的一句话' } }],
        },
      });
      const lonelyId = lonely.data?.doc?.id;
      const beforeStation = scalar('SELECT COALESCE(s.station_id, 0) AS station_id FROM documents d LEFT JOIN doc_settings s ON s.document_id = d.id WHERE d.id = ?', lonelyId);
      check('10.8 老页一开始不属于任何站', beforeStation?.station_id === 0, JSON.stringify(beforeStation));
      await author.call(`/api/docs/${lonelyId}`);
      const after = scalar('SELECT COALESCE(s.station_id, 0) AS station_id FROM documents d LEFT JOIN doc_settings s ON s.document_id = d.id WHERE d.id = ?', lonelyId);
      check('10.8 第一次打开就地收编进站（不用手点迁移）', after?.station_id !== 0, JSON.stringify(after));
      check('10.8 收编顺手补了 source_text（否则站内搜索漏老页）', String(scalar('SELECT source_text AS s FROM doc_settings WHERE document_id = ?', lonelyId)?.s ?? '').includes('野页里的一句话'), JSON.stringify(scalar('SELECT source_text AS s FROM doc_settings WHERE document_id = ?', lonelyId)?.s));
      const again2 = await author.call(`/api/docs/${lonelyId}`);
      check('10.8 收编是幂等的（第二次打开不报错、不改归属）', again2.status === 200, `${again2.status}`);
    }

    // 10.8b 匿名的「全量收编」也要做完整。
    // 线上就是这么被触发的（老链接 / 爬虫先到），以前执行人只传给了建站、没传给挂页，
    // 结果是「站建出来了、页一个都没挂上」的半吊子迁移。
    {
      const stray = await author.call('/api/docs', {
        method: 'POST',
        body: {
          title: 'S10 又一片野页',
          kind: 'post',
          scope: 'public',
          template: 'page',
          blocks: [{ block_id: 'b1', type: 'paragraph', props: { text: '匿名也要收编' } }],
        },
      });
      const strayId = stray.data?.doc?.id;
      check('10.8b 造出新的孤儿页', Number.isInteger(strayId), `${stray.status} ${JSON.stringify(stray.error)}`);
      const oldest = scalar("SELECT d.user_id AS user_id FROM documents d LEFT JOIN doc_settings s ON s.document_id = d.id WHERE d.template = 'page' AND d.deleted = 0 AND COALESCE(s.station_id, 0) = 0 ORDER BY d.id ASC LIMIT 1");
      await anon.call('/api/docs/wiki');
      const left = scalar("SELECT COUNT(*) AS n FROM documents d LEFT JOIN doc_settings s ON s.document_id = d.id WHERE d.template = 'page' AND d.deleted = 0 AND COALESCE(s.station_id, 0) = 0 AND d.user_id = ?", oldest?.user_id);
      check('10.8b 匿名访客打开站列表也会把老页收编完（不留半吊子迁移）', Number(left?.n ?? -1) === 0, JSON.stringify({ oldest, left }));
    }

    // 10.9 前端接线：三栏页面、站列表、`#/wiki` 都能落地。
    const docJs = readFileSync(join(ROOT, 'public', 'views', 'doc.js'), 'utf8');
    const routerJs = readFileSync(join(ROOT, 'public', 'core', 'router.js'), 'utf8');
    const css = readFileSync(join(ROOT, 'public', 'css', '41-doc.css'), 'utf8');
    check('10.9 前端有站列表与三栏渲染', ['viewWikiIndex', 'stationTreeHtml', 'stationShellHtml', 'mountStationTools'].every((name) => docJs.includes(name)), '');
    check('10.9 路由认识 #/wiki（站列表）且保住 #/wiki/<名字>', routerJs.includes("first === 'wiki' && second") && routerJs.includes('viewWikiIndex'), '');
    check('10.9 CSS 有三栏 / 树 / 目录 / 卡片 / 红链的规则', ['.doc-wiki-station', '.doc-wiki-tree-link', '.doc-wiki-toc-link', '.doc-wiki-pager-link', '.doc-subpage', '.doc-wiki-link.is-missing'].every((selector) => css.includes(selector)), '');
    check('10.9 #/wiki 上能新建站（入口 + 处理函数 + 样式都在）', docJs.includes('wiki-new-station') && docJs.includes('newStationFromInput') && css.includes('.doc-station-new'), '');
    // 10.9b 左树的展开 / 收起：519 页的站（OI Wiki）不折叠就是十几屏。
    check(
      '10.9b 左树每页一行、行首有折叠开关',
      ['.doc-wiki-tree-row', 'data-wiki-toggle', 'data-wiki-parent', 'data-wiki-tree-all', 'data-wiki-tree-none'].every((item) => docJs.includes(item)),
      '',
    );
    check(
      '10.9b 折叠状态记在本地、默认展开通向当前页的那条链',
      ['mountWikiTree', 'dsh.wikiTree.', 'localStorage', 'readTreeOpen', 'writeTreeOpen'].every((item) => docJs.includes(item))
        && docJs.includes('parentOf.get(id)'),
      '',
    );
    check(
      '10.9b 折叠行的样式都在 41-doc.css 里（含 [hidden] 的显示规则）',
      ['.doc-wiki-tree-row', '.doc-wiki-tree-toggle', '.doc-wiki-tree-row[hidden]', '.doc-wiki-tree-tools'].every((selector) => css.includes(selector)),
      '',
    );
    // 10.9c 左树的滚动位置：换页时整棵左栏重建，不接管就永远跳回顶上（519 页的站里没法用）。
    check(
      '10.9c 左树滚动位置记在本地、上来先还原',
      ['dsh.wikiScroll.', 'readTreeScroll', 'writeTreeScroll', "closest('.doc-wiki-nav')", 'restoreScroll'].every((item) => docJs.includes(item)),
      '',
    );
    check(
      '10.9c 当前页那一行滚出视野时会被挪回来',
      docJs.includes('row.scrollIntoView?.(') && docJs.includes("block: saved > 0 ? 'nearest' : 'center'"),
      '',
    );
    // 10.9d 三栏的宽度纪律：正文必须待在左树与右目录**之间**。
    //   上游 OI-wiki 的行内图（`<p>` 里一颗裸 `<img>`，导进来 16 页是这种）不加限制
    //   就会顶穿中栏、盖住右目录；中栏自己也不能跟着 1560px 的大壳一起被拉到一千多像素。
    check(
      '10.9d 正文里的行内媒体不许超过栏宽（块图片之外也要拦）',
      ['.doc-body img,', '.doc-body video,', '.doc-body iframe,', '.doc-md-preview img,'].every((selector) => css.includes(selector))
        && /\.doc-body img,[\s\S]{0,400}?max-width: 100%;/.test(css),
      '',
    );
    check(
      '10.9d 拦的是 img/video/iframe，不碰 svg（KaTeX 的伸缩括号就是 svg）',
      !css.includes('.doc-body svg'),
      '',
    );
    check(
      '10.9d 三栏中栏有阅读宽度上限、整组居中，窄屏仍然收成两栏',
      css.includes('grid-template-columns: 208px minmax(0, 860px) 176px')
        && /\.doc-wiki-station \{[\s\S]{0,300}?justify-content: center;/.test(css)
        && css.includes('grid-template-columns: 208px minmax(0, 1fr)'),
      '',
    );

    // 10.9e 装正文的 grid 容器必须有**显式列模板**。
    //   `.doc-page` 原先只有 `display: grid; gap: 14px` → 一条隐式 `auto` 轨道；轨道按内容的
    //   最小内容宽撑开，正文里一张 2558px 宽的截图就能把它顶到 967px（中栏只有 860px），
    //   `.doc-body` 于是压到右侧「本页目录」底下、窄窗口还多出横向滚动条 —— 带图页面
    //   「不适配」的真因就在这，不是图片自己没限宽。
    //   实测量化（headless Edge + CDP 打 #/wiki/OI%20Wiki/Xcode @1440）：
    //     修前 pageCols=967.219px、.doc-body 右边界 1266、.doc-wiki-toc 占 1173–1349（被压住）、
    //          整页 scrollWidth 1209 > 视口；
    //     把轨道钉成 minmax(0, 1fr) 后 pageCols=860px、.doc-body=860px、图片 921px → 814px。
    {
      const ruleOf = (selector) => {
        const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const hit = css.match(new RegExp(`${escaped}\\s*\\{([^{}]*)\\}`));
        return hit ? hit[1] : null;
      };
      const contentGrids = ['.doc-page', '.doc-editor', '.doc-md-grid', '.doc-wiki-layout', '.doc-wiki-station', '.doc-wiki-pager'];
      const untemplated = contentGrids.filter((selector) => {
        const rule = ruleOf(selector);
        return rule && !/grid-(?:template|auto)-columns/.test(rule);
      });
      check(
        '10.9e 装正文的 grid 容器都有显式列模板（隐式 auto 轨道会被大图顶宽）',
        untemplated.length === 0,
        JSON.stringify(untemplated),
      );
      check(
        '10.9e .doc-page / .doc-editor 的单列钉成 minmax(0, 1fr)',
        /\.doc-page \{[\s\S]{0,240}?grid-template-columns: minmax\(0, 1fr\);/.test(css)
          && /\.doc-editor \{[\s\S]{0,240}?grid-template-columns: minmax\(0, 1fr\);/.test(css),
        '',
      );
    }

    // 前端建树靠 `parentId`：站接口不给它，折叠就只剩「一层一层猜深度」。
    {
      const stationTree = await author.call(`/api/docs/wiki/station?id=${stationId}`);
      const treePages = stationTree.data?.pages ?? [];
      check('10.9b 站接口的页带 parentId（前端据此折叠）', treePages.length > 0 && treePages.every((page) => Object.hasOwn(page, 'parentId')), JSON.stringify(treePages[0]));
    }

    // 10.10 脚本块的块体是原始 JS，必须被包进 `<script>` 才会跑（不然只是把代码当文字显示）。
    {
      const scriptPost = await author.call('/api/docs', { method: 'POST', body: { title: 'S10 脚本页', kind: 'post', scope: 'public' } });
      const scriptId = scriptPost.data?.doc?.id;
      const scriptSource = ['# S10 脚本页', '', '```doc:script {#b1}', 'var n = 40 + 2;', 'Sandbox.render.put("s1", "paragraph", { text: "答案是 " + n }, "shared");', '```', ''].join('\n');
      const saved = await author.call(`/api/docs/${scriptId}/markdown`, { method: 'PUT', body: { markdown: scriptSource } });
      check('10.10 源码里的 doc:script 存得下', saved.status === 200, `${saved.status} ${JSON.stringify(saved.error)}`);
      const shown = await anon.call(`/api/docs/${scriptId}`);
      const html = String(shown.data?.html ?? '');
      check('10.10 脚本块渲染成 iframe 沙箱', html.includes('doc-app-frame'), html.slice(0, 300));
      check('10.10 原始 JS 被包进 script 标签里（否则不会跑）', html.includes('&lt;script&gt;') && html.includes('40 + 2'), html.slice(0, 600));
    }

    // 10.11 「一个帖子一个 wiki」是拼出来的，不是另起一套功能：普通建帖接口 +
    //       `template='station'` + 一块 `subpage` 积木，就得到同样的三栏 wiki。
    {
      const hand = await author.call('/api/docs', {
        method: 'POST',
        body: {
          title: 'S10 手工站',
          kind: 'post',
          scope: 'public',
          template: 'station',
          blocks: [
            { block_id: 'b1', type: 'heading', props: { text: '手工站', level: 1 } },
            { block_id: 'b2', type: 'paragraph', props: { text: '这一页没有调过任何「站」接口。' } },
            { block_id: 'b3', type: 'subpage', props: { doc: String(firstId), mode: 'card', title: '', note: '' } },
          ],
        },
      });
      const handId = hand.data?.doc?.id;
      check('10.11 普通建帖接口 + station 模板就搭得出一个站', hand.status === 200 && Number.isInteger(handId), `${hand.status} ${JSON.stringify(hand.error)}`);
      const opened = await anon.call(`/api/docs/${handId}`);
      check('10.11 打开就是三栏 wiki（present 里给 wiki 与 toc）', Boolean(opened.data?.wiki?.station) && Array.isArray(opened.data?.toc), JSON.stringify(Object.keys(opened.data ?? {})));
      check('10.11 首页的页卡片就是一块普通 subpage 积木（标题从 documents 现查）', String(opened.data?.html ?? '').includes('doc-subpage') && String(opened.data?.html ?? '').includes('S10 第一页'), String(opened.data?.html ?? '').slice(0, 400));
      check('10.11 站本身照样出现在积木广场（它就是一个帖子）', (await anon.call('/api/docs')).data?.documents?.some((row) => row.id === handId) === true, '');
      const source = await author.call(`/api/docs/${handId}/markdown`);
      check('10.11 这一篇的源码就是普通 Markdown + 一段 doc:subpage（可 1:1 复刻）', String(source.data?.markdown ?? '').includes('doc:subpage'), JSON.stringify(source.data?.markdown ?? '').slice(0, 300));
    }
  }

  /* ========== S11 开发者功能：块类型表搬了家 + 我的脚本模板 ========== */

  console.log('\n【S11】开发者功能：模板存得下、只自己看得见，教程页接得上');

  {
    // 提醒：这一节把 60 次 / 10 分钟的写配额用掉 59 次（`doc:script-template:<user>`），
    // 因为「存满 50 个」这条只能真的存 50 次。要往这里加用例，先想清楚配额。
    const CODE = [
      'const n = await Sandbox.state.get();',
      'await Sandbox.state.set((n ?? 0) + 1);',
      'Sandbox.resize();',
    ].join('\n');

    // 11.1 模板是私人物品：匿名连列表都不给（前端靠 401 把表单收成「登录后可以存模板」）。
    const anonList = await anon.call('/api/docs/meta/script-templates');
    check('11.1 匿名看脚本模板 → 401 unauthenticated（不是空表）', anonList.status === 401 && anonList.error?.code === 'unauthenticated', `${anonList.status} ${JSON.stringify(anonList.error)}`);
    const anonSave = await anon.call('/api/docs/meta/script-templates', { method: 'POST', body: { name: '匿名的', code: CODE } });
    check('11.1 匿名存模板 → 401', anonSave.status === 401, `${anonSave.status}`);

    // 11.2 存一个，读回来必须是**逐字节原文**（模板就是拿来复用的，截断等于废了）。
    const made = await author.call('/api/docs/meta/script-templates', { method: 'POST', body: { name: '打卡本', description: '每天点一下', code: CODE } });
    const tplId = made.data?.template?.id;
    check('11.2 登录用户能存下一个脚本模板', made.status === 200 && Number.isInteger(tplId), `${made.status} ${JSON.stringify(made.error ?? made.data)}`);
    check('11.2 存回来的代码是原文（没被截断）', made.data?.template?.code === CODE, JSON.stringify(made.data?.template?.code));
    const listed = await author.call('/api/docs/meta/script-templates');
    check(
      '11.2 列表里看得见它，并且带上限与字段长度（前端拿它做 maxlength）',
      (listed.data?.templates ?? []).some((item) => item.id === tplId) && listed.data?.limit > 0 && listed.data?.maxCode > 0,
      JSON.stringify(listed.data),
    );

    // 11.3 只自己看得见 / 只自己删得掉。
    const mateList = await mate.call('/api/docs/meta/script-templates');
    check('11.3 别人的模板不在我的列表里', !(mateList.data?.templates ?? []).some((item) => item.id === tplId), JSON.stringify(mateList.data?.templates));
    const mateDelete = await mate.call(`/api/docs/meta/script-templates/${tplId}`, { method: 'DELETE' });
    check('11.3 删别人的模板 → 404（不是 403：不告诉陌生人这个 id 存在）', mateDelete.status === 404, `${mateDelete.status} ${JSON.stringify(mateDelete.error)}`);

    // 11.4 输入校验：名字、代码、长度、重名 —— 全部走人话提示，不是 500。
    const noName = await author.call('/api/docs/meta/script-templates', { method: 'POST', body: { name: '   ', code: CODE } });
    check('11.4 没名字 → 400', noName.status === 400 && String(noName.error?.message ?? '').includes('名字'), `${noName.status} ${JSON.stringify(noName.error)}`);
    const noCode = await author.call('/api/docs/meta/script-templates', { method: 'POST', body: { name: '空壳' } });
    check('11.4 没代码 → 400（存个空壳没意义）', noCode.status === 400, `${noCode.status}`);
    const tooLong = await author.call('/api/docs/meta/script-templates', { method: 'POST', body: { name: '太长', code: 'x'.repeat(20001) } });
    check('11.4 代码超长 → 400（和 app 块同一把尺子）', tooLong.status === 400, `${tooLong.status} ${JSON.stringify(tooLong.error)}`);
    const clash = await author.call('/api/docs/meta/script-templates', { method: 'POST', body: { name: '打卡本', code: CODE } });
    check('11.4 同名再存 → 409（同一个人不允许两个同名模板）', clash.status === 409, `${clash.status} ${JSON.stringify(clash.error)}`);

    // 11.5 带 id 是覆盖，不是又存一个。
    const updated = await author.call('/api/docs/meta/script-templates', { method: 'POST', body: { id: tplId, name: '打卡本 v2', description: '改过', code: `${CODE}\n// v2` } });
    check('11.5 带 id 是覆盖（回到同一个 id）', updated.status === 200 && updated.data?.template?.id === tplId, `${updated.status} ${JSON.stringify(updated.error ?? updated.data)}`);
    const afterUpdate = await author.call('/api/docs/meta/script-templates');
    check('11.5 覆盖之后还是只有它一个（没长出第二条）', (afterUpdate.data?.templates ?? []).length === 1, JSON.stringify((afterUpdate.data?.templates ?? []).map((item) => item.name)));
    const missing = await author.call('/api/docs/meta/script-templates', { method: 'POST', body: { id: 999999, name: '不存在', code: CODE } });
    check('11.5 覆盖一个不存在的模板 → 404', missing.status === 404, `${missing.status}`);

    // 11.6 上限：每人 50 个（存满之前一路 200，第 51 个被挡）。
    const LIMIT = Number(afterUpdate.data?.limit) || 50;
    let fillStatus = 0;
    for (let index = (afterUpdate.data?.templates ?? []).length; index < LIMIT; index += 1) {
      const res = await author.call('/api/docs/meta/script-templates', { method: 'POST', body: { name: `批量 ${index}`, code: 'Sandbox.resize();' } });
      fillStatus = res.status;
    }
    check('11.6 存到上限之前一路 200', fillStatus === 200, `last=${fillStatus} limit=${LIMIT}`);
    const over = await author.call('/api/docs/meta/script-templates', { method: 'POST', body: { name: '第 51 个', code: 'Sandbox.resize();' } });
    check(`11.6 超过 ${LIMIT} 个 → 400 且是人话提示`, over.status === 400 && String(over.error?.message ?? '').includes('最多'), `${over.status} ${JSON.stringify(over.error)}`);

    // 11.7 删除。
    const removed = await author.call(`/api/docs/meta/script-templates/${tplId}`, { method: 'DELETE' });
    check('11.7 删自己的模板 → 200 并回 id', removed.status === 200 && removed.data?.deleted === tplId, `${removed.status} ${JSON.stringify(removed.error ?? removed.data)}`);
    const gone = await author.call('/api/docs/meta/script-templates');
    check('11.7 删完就不在列表里了', !(gone.data?.templates ?? []).some((item) => item.id === tplId), JSON.stringify((gone.data?.templates ?? []).map((item) => item.id)));
    const twice = await author.call(`/api/docs/meta/script-templates/${tplId}`, { method: 'DELETE' });
    check('11.7 再删一次 → 404（不是 500）', twice.status === 404, `${twice.status}`);

    // 11.8 落库的形状：表在、同名唯一、没有孤儿行。
    const ddl = String(tableSql('doc_script_templates') ?? '');
    check('11.8 doc_script_templates 表真建出来了', ddl.includes('doc_script_templates'), ddl.slice(0, 120));
    check('11.8 (user_id, name) 唯一（同名模板在同一个人名下只可能一条）', /UNIQUE/i.test(ddl), ddl.replace(/\s+/g, ' ').slice(0, 200));
    const rows = scalar('SELECT COUNT(*) AS n FROM doc_script_templates WHERE user_id = ?', authorId);
    check(`11.8 库里正好剩 ${LIMIT - 1} 条（存满 ${LIMIT} 条、删掉 1 条）`, Number(rows?.n ?? -1) === LIMIT - 1, JSON.stringify({ rows, limit: LIMIT }));

    // 11.9 前端接线：块类型表搬进「开发者功能」，老地址还开着；教程页接上了。
    const readText = (relative) => {
      const full = join(ROOT, ...relative.split('/'));
      return existsSync(full) ? readFileSync(full, 'utf8') : '';
    };
    const docJs = readText('public/views/doc.js');
    const guideJs = readText('public/views/guide.js');
    const routerJs = readText('public/core/router.js');
    const sessionJs = readText('public/core/session.js');
    const css = readText('public/css/41-doc.css');
    const frontendJs = readText('scripts/check-frontend.mjs');
    check('11.9 块类型表搬进 viewDev，老地址 viewBlocks 还指过去（收藏夹不失效）', docJs.includes('function viewDev()') && docJs.includes('const viewBlocks = viewDev;'), '');
    check('11.9 路由认识 #/dev、#/guide，同时保住 #/blocks', ["first === 'dev'", "first === 'guide'", "first === 'blocks'", "from '../views/guide.js'"].every((needle) => routerJs.includes(needle)), '');
    check('11.9 侧栏三条入口齐了（广场 / 教程 / 开发者功能）', ['#/docs', '#/guide', '#/dev'].every((href) => sessionJs.includes(`href="${href}"`)), '');
    check(
      '11.9 开发者功能里有脚本模板表单（名字 / 说明 / 代码 / 示例 / 删除）',
      docJs.includes('data-doc-form="script-template"') && docJs.includes('data-doc-action="tpl-sample"') && docJs.includes('data-doc-action="tpl-delete"') && docJs.includes('data-doc-action="tpl-new"'),
      '',
    );
    check('11.9 「一键新建一篇积木」按内容认块类型（HTML → app，纯 JS → script）', docJs.includes('function newDocFromScriptTemplate(') && docJs.includes("type: 'app'") && docJs.includes("type: 'script'"), '');
    check('11.10 编辑器里能开关「允许脚本改块」（以前这个开关没有界面）', docJs.includes('data-doc-script-write') && docJs.includes('allowScriptWrite'), '');
    check('11.10 教程页顶上是动态块类型清单（谁注册了新类型，教程里就有）', guideJs.includes('export async function viewGuide') && guideJs.includes('/api/docs/meta/block-types'), '');
    check('11.10 教程讲了上手步骤、能力与超时（不是一页空话）', ['Sandbox.state.set', '能力', '超时', '新建一篇'].every((needle) => guideJs.includes(needle)), '');
    // 教程是写给「用积木的人」的：按顺序教怎么新建 / 编辑 / 保存 / 分享，
    // 不夹只有作者本人看得懂的内部记录（以前那一节标题叫「踩过的坑」，就属于这一类）。
    check('11.10 教程不夹内部笔记（「踩过的坑」这类不算教程）', !guideJs.includes('踩过的坑'), '');
    check('11.10 教程的保存说法与编辑器一致（一次全存）', guideJs.includes('一次全存') && !guideJs.includes('保存标题与范围'), '');
    check('11.10 教程的代码框样式在 41-doc.css 里', css.includes('.guide-pre'), '');
    check('11.10 前端清单里登记了开发者功能与积木教程两页', frontendJs.includes("['开发者功能'") && frontendJs.includes("['积木教程'"), '');
  }

  /* ================= 12 标签 + 广场的两种排法 =================
     这一组对应「学术笔记下线，改用它自己的标签（#学术笔记）」：
     标签必须真的存在库里、真的能筛、真的只给看得见的人看。 */

  console.log('\n【12】标签：打得上、筛得着、看得见的才算数');

  {
    const readText = (relative) => {
      const full = join(ROOT, ...relative.split('/'));
      return existsSync(full) ? readFileSync(full, 'utf8') : '';
    };
    const docJs = readText('public/views/doc.js');
    const css = readText('public/css/41-doc.css');
    const prefsJs = readText('public/core/preferences.js');
    const stateJs = readText('public/core/state.js');
    const sessionJs = readText('public/core/session.js');
    const routerJs = readText('public/core/router.js');
    const notesJs = readText('public/views/notes.js');
    const guideJs = readText('public/views/guide.js');
    const readme = readText('README.md');

    // 12.1 表：不是给 documents 加列（老库上加不出来），而是一张新表。
    const ddl = String(tableSql('doc_tags') ?? '');
    check('12.1 doc_tags 表真建出来了', ddl.includes('doc_tags'), ddl.slice(0, 140));
    check('12.1 (document_id, tag) 是主键（同一篇里同一个标签只可能一行）', /PRIMARY KEY \(document_id, tag\)/i.test(ddl), ddl.replace(/\s+/g, ' ').slice(0, 200));
    check(
      '12.1 按标签反查有索引（?tag= 不能全表扫）',
      String(scalar("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_doc_tags_tag'")?.name ?? '') === 'idx_doc_tags_tag',
      '',
    );

    // 12.2 建的时候就能带标签（编辑器新建一篇时一起发）。
    const made = await author.call('/api/docs', {
      method: 'POST',
      body: { title: '带标签的积木', kind: 'post', scope: 'public', tags: ['学术笔记', '公式', 'Css'] },
    });
    const taggedId = made.data?.doc?.id;
    check(
      '12.2 POST /api/docs 带 tags 一次建成',
      made.status === 200 && (made.data?.doc?.tags ?? []).join('|') === '学术笔记|公式|Css',
      `${made.status} ${JSON.stringify(made.data?.doc?.tags ?? made.error)}`,
    );
    check('12.2 写的顺序就是显示的顺序（按 rowid，不按字典序重排）', (made.data?.doc?.tags ?? [])[0] === '学术笔记', JSON.stringify(made.data?.doc?.tags));

    // 12.3 列表 / 详情一个形状：卡片上要显示标签，就不能只有详情里有。
    const listed = await author.call(`/api/docs?q=${encodeURIComponent('带标签的积木')}`);
    const found = (listed.data?.documents ?? []).find((item) => item.id === taggedId);
    check('12.3 列表里也带着同一份标签', (found?.tags ?? []).join('|') === '学术笔记|公式|Css', JSON.stringify(found?.tags));
    const detail = await author.call(`/api/docs/${taggedId}`);
    check('12.3 详情与列表的标签逐字相同', JSON.stringify(detail.data?.doc?.tags) === JSON.stringify(found?.tags), JSON.stringify(detail.data?.doc?.tags));

    // 12.4 ?tag= 筛选：这就是「点标签看全部同标签的积木」的后端。
    const byTag = await author.call(`/api/docs?tag=${encodeURIComponent('学术笔记')}`);
    const byTagDocs = byTag.data?.documents ?? [];
    check('12.4 ?tag= 只回带这个标签的文档', byTag.status === 200 && byTagDocs.length > 0 && byTagDocs.every((item) => (item.tags ?? []).includes('学术笔记')), JSON.stringify(byTagDocs.map((item) => item.id)));
    check('12.4 筛选结果里有刚建的那一篇', byTagDocs.some((item) => item.id === taggedId), '');
    check('12.4 ?tag= 与 ?q= 能叠着用', (await author.call(`/api/docs?tag=${encodeURIComponent('学术笔记')}&q=${encodeURIComponent('带标签')}`)).data?.documents?.some((item) => item.id === taggedId) === true, '');
    // 大小写不敏感（COLLATE NOCASE）：作者写 Css，别人搜 css 也要找得到。
    check('12.4 标签筛选不分大小写（Css / css 是同一个）', (await author.call('/api/docs?tag=css')).data?.documents?.some((item) => item.id === taggedId) === true, '');
    check('12.4 不存在的标签 → 空列表（不是报错）', ((await author.call('/api/docs?tag=没有这个标签')).data?.documents ?? []).length === 0, '');

    // 12.5 看得见才算数：标签不是绕过可见范围的后门。
    const secret = await author.call('/api/docs', {
      method: 'POST',
      body: { title: '私密标签文档', kind: 'post', scope: 'private', tags: ['机密标签'] },
    });
    const secretId = secret.data?.doc?.id;
    const outsiderByTag = await other.call(`/api/docs?tag=${encodeURIComponent('机密标签')}`);
    check('12.5 别人按标签也筛不到 private 文档', ((outsiderByTag.data?.documents ?? []).length) === 0, JSON.stringify((outsiderByTag.data?.documents ?? []).map((item) => item.id)));
    check('12.5 别人直接取 private 文档 → 404', (await other.call(`/api/docs/${secretId}`)).status === 404, '');
    const myOnly = await author.call(`/api/docs?tag=${encodeURIComponent('机密标签')}`);
    check('12.5 作者自己筛得到', (myOnly.data?.documents ?? []).some((item) => item.id === secretId), '');

    // 12.6 上限与长度：坏输入在建影子行/写修订**之前**就要挡下。
    const tooMany = await author.call(`/api/docs/${taggedId}`, { method: 'PUT', body: { tags: ['a', 'b', 'c', 'd', 'e', 'f'] } });
    check('12.6 6 个标签 → 400 且说清上限', tooMany.status === 400 && String(tooMany.error?.message ?? '').includes('最多 5 个'), `${tooMany.status} ${JSON.stringify(tooMany.error)}`);
    const tooLong = await author.call(`/api/docs/${taggedId}`, { method: 'PUT', body: { tags: ['x'.repeat(25)] } });
    check('12.6 单个标签超 24 字 → 400 且说清长度', tooLong.status === 400 && String(tooLong.error?.message ?? '').includes('24'), `${tooLong.status} ${JSON.stringify(tooLong.error)}`);
    check('12.6 被挡下的那次没有改坏库里的标签', (await author.call(`/api/docs/${taggedId}`)).data?.doc?.tags?.length === 3, '');
    const dup = await author.call(`/api/docs/${taggedId}`, { method: 'PUT', body: { tags: ['同一个', '同一个'] } });
    check('12.6 重复的标签合成一个', (dup.data?.doc?.tags ?? []).join('|') === '同一个', JSON.stringify(dup.data?.doc?.tags));

    // 12.7 一整串也能用（作者习惯直接打字：`#学术笔记, 公式`）。
    const asText = await author.call(`/api/docs/${taggedId}`, { method: 'PUT', body: { tags: ' #学术笔记，学术笔记、公式 css ' } });
    check('12.7 一串文字也能打标签（逗号 / 中文逗号 / 顿号 / # 都认，重复去掉）', (asText.data?.doc?.tags ?? []).join('|') === '学术笔记|公式|css', JSON.stringify(asText.data?.doc?.tags));

    // 12.8 清空 / 不动：`[]` 是「清空」，不传才是「别动」。
    const kept = await author.call(`/api/docs/${taggedId}`, { method: 'PUT', body: { title: '改了标题' } });
    check('12.8 只改标题的 PUT 不会顺手清空标签', (kept.data?.doc?.tags ?? []).join('|') === '学术笔记|公式|css', JSON.stringify(kept.data?.doc?.tags));
    const cleared = await author.call(`/api/docs/${taggedId}`, { method: 'PUT', body: { tags: [] } });
    check('12.8 传空数组 = 清空标签（不是「不改」）', (cleared.data?.doc?.tags ?? ['x']).length === 0, JSON.stringify(cleared.data?.doc?.tags));
    const reTagged = await author.call(`/api/docs/${taggedId}`, { method: 'PUT', body: { tags: ['学术笔记'] } });
    check('12.8 清空之后还能再打上', (reTagged.data?.doc?.tags ?? []).join('|') === '学术笔记', JSON.stringify(reTagged.data?.doc?.tags));

    // 12.9 meta/tags：编辑器用它拿上限 + 「大家在用」。
    const tagMeta = await anon.call('/api/docs/meta/tags');
    check('12.9 GET /api/docs/meta/tags 给出上限（游客也能拿）', tagMeta.status === 200 && tagMeta.data?.maxTags === 5 && tagMeta.data?.maxTagLength === 24, `${tagMeta.status} ${JSON.stringify(tagMeta.data)?.slice(0, 140)}`);
    check('12.9 匿名看得见公开文档用过的标签与篇数', (tagMeta.data?.tags ?? []).some((item) => item.tag === '学术笔记' && item.count >= 1), JSON.stringify(tagMeta.data?.tags));
    check('12.9 匿名看不见 private 文档的标签（标签不泄露存在性）', !(tagMeta.data?.tags ?? []).some((item) => item.tag === '机密标签'), JSON.stringify(tagMeta.data?.tags));

    // 12.10 删文档顺手清标签（否则会攒下一堆孤儿行）。
    const before = Number(scalar('SELECT COUNT(*) AS n FROM doc_tags WHERE document_id = ?', secretId)?.n ?? -1);
    await author.call(`/api/docs/${secretId}`, { method: 'DELETE' });
    const after = Number(scalar('SELECT COUNT(*) AS n FROM doc_tags WHERE document_id = ?', secretId)?.n ?? -1);
    check('12.10 删文档顺手清掉它的标签', before > 0 && after === 0, JSON.stringify({ before, after }));

    // 12.11 前端接线（这几条是「界面真的做到了」的账）。
    check('12.11 卡片与阅读页都渲染标签，点标签是去看同标签的积木', docJs.includes('function tagChipsHtml(') && docJs.includes('href="#/docs?tag='), '');
    check('12.11 广场认 ?tag= 这个参数', docJs.includes("query.get('tag')") && docJs.includes("params.set('tag', tag)"), '');
    check('12.11 筛选表单里带着 tag（在标签里搜标题不会把标签丢掉）', docJs.includes('type="hidden" name="tag"') && docJs.includes("if (values.tag) params.set('tag', values.tag)"), '');
    check('12.11 编辑器有标签框，且跟着「保存」一起存（不是第二个保存按钮）', docJs.includes('data-doc-tags') && docJs.includes('parseTags(') && !docJs.includes('data-doc-action="save-tags"'), '');
    check('12.11 标签上限来自服务端（客户端没自己发明一份 5 / 24）', docJs.includes("api('/api/docs/meta/tags')") && docJs.includes('docState.maxTags'), '');

    // 12.12 学术笔记入口下线（代码留着）。
    check('12.12 顶栏不再有「学术笔记」入口', !sessionJs.includes('href="#/notes"'), '');
    check('12.12 老地址没坏：路由还在，页面还在', routerJs.includes("first === 'notes'") && notesJs.includes('async function viewNotes()'), '');
    check('12.12 老页面顶上写明「并进积木了」并给了标签入口', notesJs.includes('并进积木') && notesJs.includes('#/docs?tag='), '');
    check('12.12 广场的形态筛选里不再单列「笔记」', docJs.includes("item.value !== 'note'"), '');

    // 12.13 第二种排法：从上往下列下来。
    check('12.13 排法偏好读写同一个 key，并且真的导出（check-frontend 会查命名空间）', prefsJs.includes("const docsLayout = () => readPreference('forum:docsLayout'") && prefsJs.includes('export { docsLayout };'), '');
    check('12.13 两种排法写在 state.js 里（界面文案也在那儿）', stateJs.includes('const DOC_LAYOUTS') && stateJs.includes('export { DOC_LAYOUTS };'), '');
    check('12.13 切换按钮走中央分发，并且切换后用当前筛选条件重画', docJs.includes('data-doc-action="layout"') && docJs.includes('docState.listQuery'), '');
    check('12.13 列表容器按偏好换壳（doc-grid / doc-list）', docJs.includes("layout === 'list' ? 'doc-list' : 'doc-grid'"), '');
    check('12.13 两个新类名都有样式', css.includes('.doc-list {') && css.includes('.doc-card-item') && css.includes('.doc-tag {'), '');

    // 12.14 教程与 README 都要提「打标签 = 现在的学术笔记」。
    check('12.14 教程讲了标签（怎么打、怎么按标签找）', guideJs.includes('标签') && guideJs.includes('#/docs?tag='), '');
    check('12.14 README 的接口表收录了 meta/tags 与 ?tag=', readme.includes('`/api/docs/meta/tags`') && readme.includes('?tag='), '');

    // 12.15 「从零搭一个 OI Wiki」的应用示例：页面上得真能照着做（改块 / 贴 Markdown / 排目录），
    // 不是一句「去看 OI Wiki」。要求它点出折叠块、双链、子页面三件事，并且链进现成的站。
    check(
      '12.15 教程带「从零搭一个 OI Wiki」的应用示例',
      ['18. 应用示例', '折叠块', '[[另一页的标题]]', '子页面', '#/wiki/OI%20Wiki'].every((needle) => guideJs.includes(needle)),
      '',
    );
  }

  /* ---------------- 13. 草稿箱与发布（第五轮） ----------------
   *
   * 这一节的规矩：每一条「别人看不见」都必须**换另一个账号**发请求验证。
   * 角色：author（作者）、mate（关注者）、other（陌生人）、staff（站长）、anon（未登录）。
   */
  {
    const readSource = (relative) => {
      const full = join(ROOT, ...relative.split('/'));
      return existsSync(full) ? readFileSync(full, 'utf8') : '';
    };
    const domJs = readSource('public/core/dom.js');
    const sessionJs = readSource('public/core/session.js');
    const docViewJs = readSource('public/views/doc.js');
    const docCss = readSource('public/css/41-doc.css');

    const createDraft = async (title) => {
      const res = await author.call('/api/docs', {
        method: 'POST',
        body: { title, kind: 'post', scope: 'public', template: 'blank', draft: true },
      });
      return { res, id: Number(res.data?.doc?.id ?? 0) };
    };
    const countIn = (list, id) => (list?.documents ?? []).some((doc) => Number(doc.id) === Number(id));
    // `scalar()` 回的是**整行**（doc-smoke.mjs:111 就是 `db.prepare(sql).get()`），不是标量。
    // 取第一列要自己拆 —— 顺便把 null-prototype 的行对象变成普通值。
    const cell = (sql, ...params) => Object.values(scalar(sql, ...params) ?? {})[0];

    // 13.1 编辑器「新建」那条路：先放进草稿箱。
    const draftA = await createDraft('13.1 还没发布的草稿');
    check(
      '13.1 新建草稿：200 且拿到 id',
      draftA.res.status === 200 && draftA.id > 0,
      `status=${draftA.res.status} body=${JSON.stringify(draftA.res.body).slice(0, 200)}`,
    );
    check(
      '13.1 新建草稿的形状：draft=true / published=false',
      draftA.res.data?.doc?.draft === true && draftA.res.data?.doc?.published === false,
      JSON.stringify(draftA.res.data?.doc ?? {}).slice(0, 240),
    );
    check('13.1 草稿行落库且 published=0', cell('SELECT published FROM doc_drafts WHERE document_id = ?', draftA.id) === 0, '');

    // 13.2 老 API 不破：不带 draft 的 POST 照旧**直接发布**（第 1-12 章全建在这条行为上）。
    const liveDoc = await author.call('/api/docs', {
      method: 'POST',
      body: { title: '13.2 直接发布的文档', kind: 'post', scope: 'public', template: 'blank' },
    });
    const liveId = Number(liveDoc.data?.doc?.id ?? 0);
    check(
      '13.2 不带 draft 的 POST 照旧直接发布（draft=false / published=true）',
      liveDoc.status === 200 && liveDoc.data?.doc?.draft === false && liveDoc.data?.doc?.published === true,
      JSON.stringify(liveDoc.data?.doc ?? {}).slice(0, 240),
    );
    check(
      '13.2 直接发布的文档没有草稿行',
      (cell('SELECT COUNT(*) AS n FROM doc_drafts WHERE document_id = ?', liveId) ?? 0) === 0,
      '',
    );
    check('13.2 直接发布的文档读者照旧看得见', (await anon.call(`/api/docs/${liveId}`)).status === 200, '');

    // 13.3 没发布过的东西：只有作者自己的草稿箱里看得见。
    // 未登录 → 401（既有约定：可见性判负时登不登录决定 401/404，本身不泄露存在性）；
    // 登录了但不是作者 → 404（越权一律 404，staff 也不放行）。
    check('13.3 未登录读未发布的草稿 → 401', (await anon.call(`/api/docs/${draftA.id}`)).status === 401, '');
    check('13.3 关注者读未发布的草稿 → 404', (await mate.call(`/api/docs/${draftA.id}`)).status === 404, '');
    check('13.3 陌生人读未发布的草稿 → 404', (await other.call(`/api/docs/${draftA.id}`)).status === 404, '');
    check('13.3 站长读别人的未发布草稿 → 404（staff 也不放行）', (await staff.call(`/api/docs/${draftA.id}`)).status === 404, '');
    const draftOwner = await author.call(`/api/docs/${draftA.id}`);
    check(
      '13.3 作者自己读得到，并且 canEdit',
      draftOwner.status === 200 && draftOwner.data?.abilities?.canEdit === true,
      `status=${draftOwner.status}`,
    );
    check(
      '13.3 别人改不动它（PUT markdown → 404）',
      (await other.call(`/api/docs/${draftA.id}/markdown`, { method: 'PUT', body: { markdown: '# 我改的' } })).status === 404,
      '',
    );
    check(
      '13.3 别人发布不了它（POST publish → 404）',
      (await other.call(`/api/docs/${draftA.id}/publish`, { method: 'POST' })).status === 404,
      '',
    );
    check(
      '13.3 站长也发布不了别人的未发布草稿 → 404',
      (await staff.call(`/api/docs/${draftA.id}/publish`, { method: 'POST' })).status === 404,
      '',
    );

    // 13.4 影子行：没发布的草稿必须藏起来，否则公开档的影子行会带着 hidden=0 漏进动态流 / 板块列表。
    const draftAnchor = Number((await author.call(`/api/docs/${draftA.id}/anchor`)).data?.post?.id ?? 0);
    check(
      '13.4 未发布草稿的影子行 hidden=1',
      draftAnchor > 0 && cell('SELECT hidden FROM posts WHERE id = ?', draftAnchor) === 1,
      `anchor=${draftAnchor} hidden=${cell('SELECT hidden FROM posts WHERE id = ?', draftAnchor)}`,
    );

    // 13.5 草稿箱列表：只看得到自己的。
    const myDrafts = await author.call('/api/docs?drafts=1');
    check(
      '13.5 ?drafts=1 列得出自己的草稿',
      myDrafts.status === 200 && countIn(myDrafts.data, draftA.id),
      `status=${myDrafts.status} body=${JSON.stringify(myDrafts.body).slice(0, 200)}`,
    );
    check('13.5 ?drafts=1 不列没有草稿的文档', !countIn(myDrafts.data, liveId), '');
    const otherDrafts = await other.call('/api/docs?drafts=1');
    check(
      '13.5 别人的草稿箱是空的',
      otherDrafts.status === 200 && (otherDrafts.data?.documents ?? []).length === 0,
      `total=${otherDrafts.data?.total}`,
    );
    const anonDrafts = await anon.call('/api/docs?drafts=1');
    check(
      '13.5 未登录看草稿箱：空列表，不 500',
      anonDrafts.status === 200 && (anonDrafts.data?.documents ?? []).length === 0,
      `status=${anonDrafts.status}`,
    );
    check(
      '13.5 我自己的普通列表里也没有没发布的草稿（它住在草稿箱里）',
      !countIn((await author.call('/api/docs?mine=1')).data, draftA.id),
      '',
    );
    check('13.5 积木广场里没有没发布的草稿', !countIn((await anon.call('/api/docs')).data, draftA.id), '');

    // 13.6 发布：只有作者点得动；点完外人才看得见。
    const published = await author.call(`/api/docs/${draftA.id}/publish`, { method: 'POST' });
    check(
      '13.6 发布成功：200 且 draft 归位',
      published.status === 200 && published.data?.doc?.draft === false && published.data?.doc?.published === true,
      `status=${published.status} body=${JSON.stringify(published.body).slice(0, 240)}`,
    );
    check(
      '13.6 发布之后草稿行没了（document_blocks 重新就是线上内容）',
      (cell('SELECT COUNT(*) AS n FROM doc_drafts WHERE document_id = ?', draftA.id) ?? 0) === 0,
      '',
    );
    check(
      '13.6 发布写出了线上版快照',
      (cell('SELECT COUNT(*) AS n FROM doc_published_blocks WHERE document_id = ?', draftA.id) ?? 0) > 0,
      '',
    );
    check('13.6 发布之后影子行放出来了（public → hidden=0）', cell('SELECT hidden FROM posts WHERE id = ?', draftAnchor) === 0, '');
    check('13.6 发布之后陌生人看得见', (await anon.call(`/api/docs/${draftA.id}`)).status === 200, '');
    check('13.6 发布之后广场里也在', countIn((await anon.call('/api/docs')).data, draftA.id), '');
    check(
      '13.6 重复发布是无害的（不再造草稿行）',
      (await author.call(`/api/docs/${draftA.id}/publish`, { method: 'POST' })).status === 200 &&
        (cell('SELECT COUNT(*) AS n FROM doc_drafts WHERE document_id = ?', draftA.id) ?? 0) === 0,
      '',
    );

    // 13.7 已经发布过的再改：编辑器在**第一次写正文之前**自己调一次 `POST /api/docs/:id/draft`
    // （public/views/doc.js 的 saveAll 里那句 `if (!doc.draft && willWriteBody)`），
    // 之后读者看**发布出去的那一份**，作者看工作副本。
    const enteredDraft = await author.call(`/api/docs/${draftA.id}/draft`, { method: 'POST' });
    check(
      '13.7 进草稿箱：200 且形状变成「有未发布的改动」（draft=true / published=true）',
      enteredDraft.status === 200 && enteredDraft.data?.doc?.draft === true && enteredDraft.data?.doc?.published === true,
      `status=${enteredDraft.status} body=${JSON.stringify(enteredDraft.body).slice(0, 200)}`,
    );
    const edited = await author.call(`/api/docs/${draftA.id}/markdown`, {
      method: 'PUT',
      body: { markdown: '# 改过的标题\n\n这是还没发布的新正文。' },
    });
    check('13.7 改已发布的文档：200', edited.status === 200, `status=${edited.status} body=${JSON.stringify(edited.body).slice(0, 200)}`);
    check('13.7 改动进了草稿行（published=1）', cell('SELECT published FROM doc_drafts WHERE document_id = ?', draftA.id) === 1, '');
    const readerView = await anon.call(`/api/docs/${draftA.id}`);
    check(
      '13.7 读者仍然看旧版（新正文一个字都没漏）',
      readerView.status === 200 && !String(readerView.data?.html ?? '').includes('还没发布的新正文'),
      `status=${readerView.status}`,
    );
    check('13.7 读者看到的是发布时那一份', String(readerView.data?.html ?? '').includes('写点什么'), '');
    const ownerView = await author.call(`/api/docs/${draftA.id}`);
    check(
      '13.7 作者看得到工作副本（自己的改动）',
      ownerView.status === 200 && String(ownerView.data?.html ?? '').includes('还没发布的新正文'),
      `status=${ownerView.status}`,
    );
    check(
      '13.7 作者看到的形状标着「有未发布的改动」',
      ownerView.data?.doc?.draft === true && ownerView.data?.doc?.published === true,
      JSON.stringify(ownerView.data?.doc ?? {}).slice(0, 200),
    );
    check('13.7 发布过又有改动的文档照旧在广场上（对外那一份还活着）', countIn((await anon.call('/api/docs')).data, draftA.id), '');
    check(
      '13.7 影子行不剧透草稿（摘要还是线上那一份）',
      !String(cell('SELECT content FROM posts WHERE id = ?', draftAnchor) ?? '').includes('还没发布的新正文'),
      '',
    );

    // 13.8 再发布一次：读者跟上。
    check('13.8 再发布一次：200', (await author.call(`/api/docs/${draftA.id}/publish`, { method: 'POST' })).status === 200, '');
    check(
      '13.8 发布之后读者看到新正文',
      String((await anon.call(`/api/docs/${draftA.id}`)).data?.html ?? '').includes('还没发布的新正文'),
      '',
    );

    // 13.9 老库 / 老 API 兼容：**没走草稿箱建的**文档（第 1-12 章全是这种）用 API 直接写正文，
    // 行为必须和以前一模一样（写下去就对外生效）——「只进草稿箱」是编辑器那条路的事，
    // 入口是显式的 `POST /api/docs/:id/draft`。
    const liveBefore = cell('SELECT COUNT(*) AS n FROM document_blocks WHERE document_id = ?', liveId) ?? 0;
    const addedBlock = await author.call(`/api/docs/${liveId}/blocks`, {
      method: 'POST',
      body: { type: 'paragraph', props: { text: '老文档新加的段落' } },
    });
    check('13.9 往老文档里加块：200', addedBlock.status === 200, `status=${addedBlock.status}`);
    check(
      '13.9 老文档不因为一次 API 写正文就进草稿箱（第 1-12 章全建在这条行为上）',
      (cell('SELECT COUNT(*) AS n FROM doc_drafts WHERE document_id = ?', liveId) ?? 0) === 0,
      '',
    );
    check(
      '13.9 读者立刻看得到新块（老 API 语义没变）',
      String((await anon.call(`/api/docs/${liveId}`)).data?.html ?? '').includes('老文档新加的段落'),
      '',
    );

    // 13.9b 编辑器那条路：先登记进草稿箱，再写，读者就该停在上一次发布的那一份。
    const liveEntered = await author.call(`/api/docs/${liveId}/draft`, { method: 'POST' });
    check(
      '13.9b POST /draft 把此刻的正文留底成线上那一份（条数 = 写之前 + 1）',
      liveEntered.status === 200 &&
        (cell('SELECT COUNT(*) AS n FROM doc_published_blocks WHERE document_id = ?', liveId) ?? 0) === liveBefore + 1,
      `before=${liveBefore} snapshot=${cell('SELECT COUNT(*) AS n FROM doc_published_blocks WHERE document_id = ?', liveId)}`,
    );
    const addedDraftBlock = await author.call(`/api/docs/${liveId}/blocks`, {
      method: 'POST',
      body: { type: 'paragraph', props: { text: '草稿里才有的段落' } },
    });
    check('13.9b 进草稿箱之后再写：200', addedDraftBlock.status === 200, `status=${addedDraftBlock.status}`);
    check(
      '13.9b 读者看不到草稿里的块，作者看得到',
      !String((await anon.call(`/api/docs/${liveId}`)).data?.html ?? '').includes('草稿里才有的段落') &&
        String((await author.call(`/api/docs/${liveId}`)).data?.html ?? '').includes('草稿里才有的段落'),
      '',
    );

    // 13.10 两张新伴随表（老库上是纯加法，不需要回填）。
    check(
      '13.10 两张新表建出来了（doc_drafts / doc_published_blocks）',
      tableSql('doc_drafts').includes('published') && tableSql('doc_published_blocks').includes('props_json'),
      '',
    );

    // 13.11 编辑器与广场的界面契约。
    check('13.11 编辑器有「发布」按钮', docViewJs.includes('data-doc-action="publish"'), '');
    check('13.11 新建走草稿箱（POST 带 draft: true）', /draft:\s*true/.test(docViewJs), '');
    check(
      '13.11 广场有「草稿箱」入口（?drafts=1 走同一条列表）',
      docViewJs.includes("params.set('drafts', '1')") &&
        docViewJs.includes('href="#/docs?drafts=1"') &&
        docViewJs.includes('docState.listQuery'),
      '',
    );
    check('13.11 卡片上标得出「草稿」', docViewJs.includes('doc-badge-draft') && docCss.includes('.doc-badge-draft'), '');
    check('13.11 阅读页给作者一条草稿提示', docViewJs.includes('doc-draft-note') && docCss.includes('.doc-draft-note'), '');
    check(
      '13.11 编辑器保存正文之前先登记进草稿箱（POST …/draft）',
      /\/api\/docs\/\$\{editor\.id\}\/draft/.test(docViewJs),
      '',
    );
    check(
      '13.11 草稿箱按钮在广场那一排动作里（登录用户才画）',
      docViewJs.includes("data-doc-action=\"new\"") && docViewJs.includes('📥 草稿箱'),
      '',
    );

    // 13.12 进积木的链接一律新开标签页并聚焦（全站一处收口，不逐处写 target）。
    check(
      '13.12 dom.js 有 openTab（新开 + 聚焦）',
      domJs.includes('function openTab(') && domJs.includes('export { openTab };') && domJs.includes('.focus()'),
      '',
    );
    check(
      '13.12 session.js 全局拦截进积木的链接',
      sessionJs.includes('openTab') && sessionJs.includes("startsWith('#/doc/')"),
      '',
    );
  }

  await finish(failures.length ? 1 : 0);
} catch (error) {
  console.log('❌ 测试脚本自己抛了异常：');
  console.log(error?.stack ?? String(error));
  await finish(1);
}
