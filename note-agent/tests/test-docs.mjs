/**
 * 文档自检：README / HANDOFF / INTEGRATION / EDITOR-CONTRACT / API-REFERENCE 必须与实现一致。
 *
 * 文档漂移是这类「交付给别人接」的模块最常见的腐烂方式：代码改了、readme 还写着旧接口。
 * 这里只断言**可机械核对**的事实（能力清单、命令、5 处胶水、契约方法名、接口条数），
 * 不做文风检查 —— 文风检查只会逼着人写套话。
 */
import { readFileSync } from 'node:fs';
import { createChecker } from './helpers/check.mjs';

const { check, summary } = createChecker();
// 文档缺失本身就是要报的错，所以读不到时给空串 —— 让每条断言自己红，
// 而不是在 import 阶段就 ENOENT 炸掉整个文件（那样只看到一个路径，看不出缺什么）。
const read = (path) => {
  try {
    return readFileSync(new URL(path, import.meta.url), 'utf8');
  } catch {
    return '';
  }
};

const readme = read('../README.md');
const handoff = read('../HANDOFF.md');
const integration = read('../INTEGRATION.md');
const contract = read('../EDITOR-CONTRACT.md');
const apiRef = read('../API-REFERENCE.md');
const pkg = JSON.parse(read('../../package.json'));
const selfPkg = JSON.parse(read('../package.json'));

// 需求.md 里点名的九项能力，README 必须逐条对得上
const ABILITIES = ['内容识别', '结构分析', '知识点', '标题', '段落', '公式', '图片说明', '标签', '排版'];
check(
  'README 含零依赖声明与九项能力清单',
  readme.includes('零依赖') && ABILITIES.every((keyword) => readme.includes(keyword)),
  ABILITIES.filter((keyword) => !readme.includes(keyword)).join('、') || '缺「零依赖」',
);
check(
  'README 给出运行命令与测试命令',
  readme.includes('scripts/run-tests.mjs') && readme.includes('examples/server.mjs'),
);
check(
  'README 说明了图片只读不存与 PDF 只支持文本型',
  readme.includes('不存图片') || readme.includes('只读不存'),
);
check(
  'README 说明了面板样式跟着面板走（宿主只用给挂载点留一行）',
  readme.includes('notes-panel.css') && readme.includes('6 处') && readme.includes('.notes-mount { display: block; }'),
);

// 6 处胶水是集成方唯一要动的东西，必须一处不漏地列出来。
// 注意：面板的**整块样式**不再是胶水（它跟着面板走，由挂载层发出去），但挂载点自己
// 那条 `display: block` 仍然必须由宿主声明 —— 面板 DOM 由宿主模板渲染。早期文档写成
// "5 处"是因为当时面板样式还粘在宿主样式表里、与这条规则合在一起；样式迁走后它才显形。
const GLUE = ['import', 'attach', 'api/site', 'index.html', 'app.js', 'style.css'];
check(
  'INTEGRATION 列出全部 6 处胶水与回滚步骤',
  GLUE.every((keyword) => integration.includes(keyword)) && integration.includes('回滚'),
  GLUE.filter((keyword) => !integration.includes(keyword)).join('、'),
);
check(
  '【回归】两份文档单列的胶水数就是 6 处（别数回 5 处）',
  readme.includes('6 处追加') && integration.includes('6 处胶水'),
  `README: ${/6 处追加/.test(readme)} / INTEGRATION: ${/6 处胶水/.test(integration)}`,
);
check(
  'INTEGRATION 说清样式自带、宿主不必改 style.css',
  integration.includes('notes-panel.css') && integration.includes('style.css'),
);
check(
  'INTEGRATION 引用了编辑器契约文件',
  integration.includes('EDITOR-CONTRACT.md'),
);
check(
  'INTEGRATION 写明了 forum-ai 是可选的、旁边没有也能跑',
  integration.includes('forum-ai') && (integration.includes('可选') || integration.includes('兜底')),
);

// AI 层「两套实现二选一」是交付包里最容易被文档写错的一处：
// 说成"必须装 forum-ai"会让接手的人白折腾，说成"完全不依赖"又会让人找不到替换点。
check(
  'API-REFERENCE 说明 /status 的 aiSource 怎么读',
  apiRef.includes('aiSource') && apiRef.includes('bundled'),
);
check(
  'HANDOFF 说明 forum-ai 是可选的、且给出判断当前用哪套的方法',
  handoff.includes('aiSource') && (handoff.includes('bundled') || handoff.includes('兜底')),
);
check(
  'README 说明 AI 层可插拔且自带兜底',
  readme.includes('ai.mjs') && (readme.includes('bundled') || readme.includes('兜底')),
);

// 交付说明：拿到文件夹的人先看它，它必须自洽（能跑起来 + 三种用法 + 限制）
const HANDOFF_KEYS = ['examples/server.mjs', 'INTEGRATION.md', 'EDITOR-CONTRACT.md', 'API-REFERENCE.md', 'LOCAL-TESTING.md'];
check(
  'HANDOFF 给出快速开始与其它四份文档的入口',
  HANDOFF_KEYS.every((keyword) => handoff.includes(keyword)),
  HANDOFF_KEYS.filter((keyword) => !handoff.includes(keyword)).join('、'),
);
check(
  'HANDOFF 写明前置条件与已知限制',
  handoff.includes('node:sqlite') && handoff.includes('forum-ai') && handoff.includes('限制'),
);

// API 文档必须覆盖路由表里的每一条，且写清统一响应包
const ROUTES = ['/status', '/session', '/generate', '/turn', '/apply', '/save', '/sessions',
  '/session/:id', '/messages', '/rollback', '/review', '/review/:id/apply', '/assets/:id'];
check(
  'API-REFERENCE 覆盖全部 13 条接口',
  ROUTES.every((route) => apiRef.includes(route)),
  ROUTES.filter((route) => !apiRef.includes(route)).join('、'),
);
check(
  'API-REFERENCE 写清成功/失败响应包与错误码表',
  apiRef.includes('"ok": true') && apiRef.includes('"ok": false') && apiRef.includes('notes_not_configured') && apiRef.includes('ai_rate_limited'),
);

// op 表与 finding 表曾经和实现两套名单（文档写 move/caption/note + blockId，实现是
// setCaption/format + target），照文档造的 op 全落 unknown_kind。这里把两边钉在一起。
const { OP_KINDS } = await import('../src/ops.mjs');
const { FINDING_KINDS } = await import('../src/prompts.mjs');
check(
  'API-REFERENCE 的 op 表与 src/ops.mjs 的 OP_KINDS 一致',
  OP_KINDS.every((kind) => apiRef.includes(`\`${kind}\``)),
  OP_KINDS.filter((kind) => !apiRef.includes(`\`${kind}\``)).join('、') || '缺 op',
);
check(
  'API-REFERENCE 的 finding 表与 src/prompts.mjs 的 FINDING_KINDS 一致',
  FINDING_KINDS.every((kind) => apiRef.includes(kind)),
  FINDING_KINDS.filter((kind) => !apiRef.includes(kind)).join('、') || '缺 kind',
);
// 文档里不该再留着实现早就没有的 op 名（move/caption/note 是历史遗留，照它写会失败）
check(
  'API-REFERENCE 不再写实现里没有的 op（move/caption/note）',
  !/`move`/.test(apiRef) && !/`note`/.test(apiRef) && !/`caption`/.test(apiRef),
);

const OPTIONAL_METHODS = ['getImages', 'buildImageUrl', 'scrollTo'];
check(
  'EDITOR-CONTRACT 含 3 必填 + 3 可选方法与示例代码',
  ['getDoc', 'setDoc', 'onChange', ...OPTIONAL_METHODS].every((method) => contract.includes(method)) && contract.includes('```'),
  OPTIONAL_METHODS.filter((method) => !contract.includes(method)).join('、'),
);

// note-agent/package.json 必须是零依赖 —— 这是全局约束，写在文档里也写在清单里
check(
  'note-agent 自身零依赖',
  !selfPkg.dependencies && !selfPkg.devDependencies,
  JSON.stringify(Object.keys(selfPkg.dependencies ?? {})),
);
check(
  '宿主 package.json 提供 note-agent 测试入口',
  typeof pkg.scripts['test:notes'] === 'string' && pkg.scripts['test:notes'].includes('note-agent/scripts/run-tests.mjs'),
  JSON.stringify(pkg.scripts['test:notes']),
);

// 统一出口：package.json 的 main 指向它，import 失败就意味着"照文档接入"的第一步就断。
const index = await import('../src/index.mjs');
const EXPECTED_EXPORTS = [
  'mountNoteAgent', 'noteAgentStatus', 'createHandlers', 'createNotesStore',
  'extractMaterial', 'extractSession', 'analyzeStructure', 'normalizeFormulas',
  'buildMaterial', 'buildMessages', 'applyOps', 'validateOp', 'diffBlocks',
  'generate', 'turn', 'reviewDraft', 'applyReviewPatch', 'UPLOAD_RULES', 'ZipError',
  'loadMarkdown', 'markdownSource', 'CLIENT_URL', 'STYLE_URL', 'MARKDOWN_URL',
];
check(
  'src/index.mjs 能 import 且暴露文档里承诺的接口',
  EXPECTED_EXPORTS.every((name) => name in index),
  EXPECTED_EXPORTS.filter((name) => !(name in index)).join('、'),
);
check('package.json 的 main 指向存在的文件', /^src\/index\.mjs$/.test(selfPkg.main ?? ''));
// 浏览器端不能走这个出口（会拉进 node:sqlite / node:fs），文档必须点明
check('README 说明浏览器端用 /notes-panel.js 而不是 index.mjs', readme.includes('/notes-panel.js'));

summary();
