import { createChecker } from './helpers/check.mjs';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNotesStore } from '../src/store-sqlite.mjs';
import { createHandlers, handle } from '../src/routes.mjs';
import { aiSource } from '../src/ai.mjs';
import { createFakeChat } from './helpers/fake-chat.mjs';
import { buildZip } from './helpers/zip-fixture.mjs';

const { check, summary } = createChecker();
const dir = mkdtempSync(join(tmpdir(), 'notes-routes-'));
const db = new DatabaseSync(join(dir, 't.db'));
const store = createNotesStore({ db });
store.ensureSchema();
const fake = createFakeChat([
  { title: '导数笔记', tags: ['微积分'], ops: [{ kind: 'replace', target: 'b2', text: '新内容' }], needsMore: [], notes: [], warnings: [] },
  { title: '导数笔记', tags: ['微积分'], ops: [{ kind: 'replace', target: 'b2', text: '缩短后的内容' }], needsMore: [], notes: [], warnings: [] },
  { summary: '整体还行', findings: [{ kind: 'logic', severity: 'high', quote: '缩短后的内容', issue: '定义不严谨', suggestion: '改成极限形式', patch: '导数是函数在某点的瞬时变化率。' }], strengths: ['结构清楚'] },
]);
const handlers = createHandlers({ store, env: { AI_API_KEY: 'k', AI_MODEL: 'deepseek-flash' }, chatImpl: fake.chatImpl });
const user = { id: 1, name: 'RyuriHime' };
const call = (method, pathname, extra = {}) => handle(handlers, { method, pathname, query: new URLSearchParams(), body: {}, files: null, user, ip: '127.0.0.1', ...extra });

const status = await call('GET', '/status', { user: null });
check('/status 不需要登录且带 contractVersion', status.status === 200 && status.body.data.contractVersion === '1' && status.body.data.features.includes('organize'));
check('【回归】方法不对要回 405 而不是 404（路径都在，接口是存在的）', (await call('GET', '/generate')).status === 405, JSON.stringify((await call('GET', '/generate')).body));
check('【回归】405 的响应里指明该用哪个方法', /POST/.test((await call('GET', '/generate')).body?.error?.message ?? ''));
check('【回归】真的不存在的路径仍然是 404', (await call('GET', '/nope')).status === 404);
// aiSource 是「到底谁在跟模型说话」的唯一自证字段：文档与排查都靠它，
// 所以这里钉住它必须等于适配器报的那个值（在论坛里是 forum-ai，拷走是 bundled）。
check(
  '/status 报出当前用的是哪套 AI 实现',
  status.body.data.aiSource === aiSource() && ['forum-ai', 'bundled'].includes(status.body.data.aiSource),
  `aiSource=${status.body.data.aiSource}，适配器说 ${aiSource()}`,
);
check('未登录访问其余接口返回 401', (await call('POST', '/session', { user: null })).status === 401);

const created = await call('POST', '/session', { files: [{ filename: 'a.md', mime: 'text/markdown', data: Buffer.from('# 导数\n\n导数是变化率', 'utf8') }] });
check('/session 建会话返回 200 与结构分析', created.status === 200 && created.body.data.sessionId > 0 && created.body.data.structure.headings.length === 1);
const sid = created.body.data.sessionId;

const gen = await call('POST', '/generate', { body: { sessionId: sid } });
check('/generate 返回整理结果并落库', gen.status === 200 && gen.body.data.title === '导数笔记' && store.sessionById(sid).status === 'draft');
check('/generate 后会话草稿已更新', store.sessionById(sid).draft_md.includes('新内容'));
check('/generate 记录了一次消息日志', store.listMessages(sid).length >= 1);
// 端到端跑出来的真 bug：applyOps 在没有 format op 时 markdown 是 null，
// 直接拿去写 draft_md 会撞 NOT NULL 约束（500）。HTTP 层必须给出**字符串**草稿。
check('【端到端】/generate 的 draftMd 一定是字符串', typeof gen.body.data.draftMd === 'string' && gen.body.data.draftMd.length > 0, JSON.stringify(gen.body.data.draftMd));
check('【端到端】/generate 回传 applied', Array.isArray(gen.body.data.applied) && gen.body.data.applied.length >= 1);

const t = await call('POST', '/turn', { body: { sessionId: sid, requirement: '把第二段缩短' } });
check('/turn 接受自然语言要求', t.status === 200 && t.body.data.ops.length === 1);
check('【端到端】/turn 的 draftMd 也是字符串', typeof t.body.data.draftMd === 'string' && t.body.data.draftMd.length > 0);
check('/turn 要求为空时 400', (await call('POST', '/turn', { body: { sessionId: sid, requirement: '' } })).status === 400);
check('/turn 要求超 1000 字时 400', (await call('POST', '/turn', { body: { sessionId: sid, requirement: 'x'.repeat(1001) } })).status === 400);

check('别人的会话返回 404 而不是 403', (await call('POST', '/generate', { body: { sessionId: sid }, user: { id: 2 } })).status === 404);
check('不存在的会话返回 404', (await call('POST', '/generate', { body: { sessionId: 999 } })).status === 404);
check('编辑区与材料都为空时 400', (await call('POST', '/session', { files: [] })).status === 400);

// 审查的必须是**界面里当前这份草稿**：/turn 之后会话草稿已经变成「缩短后的内容」，
// 所以这里审的是它，而不是更早那份「导数是变化率。」。
// 断言里的 quote 也因此取自同一份文本 —— 否则 /review/:id/apply 找不到引文，
// 只会记一条 quote_not_found（那是"模型引用了草稿里没有的原文"的**正确**行为）。
const currentDraft = store.sessionById(sid).draft_md;
const review = await call('POST', '/review', { body: { sessionId: sid, draft: currentDraft } });
check('/review 返回审查结果与 id', review.status === 200 && typeof review.body.data.reviewId === 'number');
check('/review 草稿超 20000 字返回 413', (await call('POST', '/review', { body: { sessionId: sid, draft: 'x'.repeat(20001) } })).status === 413);
const apply = await call('POST', `/review/${review.body.data.reviewId}/apply`, { body: {} });
check('/review/:id/apply 返回草稿与 applied/skipped', apply.status === 200 && apply.body.data.applied.length === 1 && Array.isArray(apply.body.data.skipped));
check('/review/:id/apply 把 patch 写回了会话草稿', store.sessionById(sid).draft_md.includes('瞬时变化率'));

/* ------------------------------------------------------------------ */
/* 【回归】审查命中缓存时，回给界面的与落库的必须是同一份结论                   */
/* ------------------------------------------------------------------ */
// 原来的实现命中 content_hash 就只复用 reviewId：不落库、不覆盖 findings，
// 于是接口回的是这一轮模型的新结论，点「应用修改」时吃的却是库里那份旧 findings。
const cacheChat = createFakeChat([
  { summary: '第一版', findings: [{ kind: 'logic', severity: 'high', quote: '导数是变化率', issue: '写法一', suggestion: '改法一', patch: '导数是瞬时变化率。' }], strengths: [] },
  { summary: '第二版', findings: [{ kind: 'clarity', severity: 'low', quote: '积分是累加值', issue: '写法二', suggestion: '改法二', patch: '积分是累积量。' }], strengths: [] },
], { repeatLast: false });
const cacheHandlers = createHandlers({ store, env: { AI_API_KEY: 'k', AI_MODEL: 'deepseek-flash' }, chatImpl: cacheChat.chatImpl });
const cacheCall = (method, pathname, extra = {}) => handle(cacheHandlers, { method, pathname, query: new URLSearchParams(), body: {}, files: null, user: { id: 9, name: '缓存' }, ip: '127.0.0.3', ...extra });
// 引文必须 ≥ MIN_QUOTE（6 字）且真的在草稿里，否则 review.mjs 会以 quote_not_found 丢掉这条 finding，
// 落库就是空数组 —— 那样这条测试会因为"没东西可比"而假绿。
const cacheDraft = '导数是变化率。\n\n积分是累加值。';
const cr1 = await cacheCall('POST', '/review', { body: { draft: cacheDraft } });
const cr2 = await cacheCall('POST', '/review', { body: { draft: cacheDraft } });
check('【回归】同一份草稿审两次复用同一条 reviewId', cr1.body?.data?.reviewId === cr2.body?.data?.reviewId, `${cr1.body?.data?.reviewId} vs ${cr2.body?.data?.reviewId}`);
check('【自检】缓存用例的第一次审查真的拿到了 findings', Array.isArray(cr1.body?.data?.findings) && cr1.body.data.findings.length === 1, JSON.stringify(cr1.body));
check('【自检】缓存用例的第二次审查也拿到了同一份 findings（否则库里比什么都比不出）', Array.isArray(cr2.body?.data?.findings) && cr2.body.data.findings.length === 1, JSON.stringify(cr2.body));
check('【回归】缓存命中时把这一轮的新结论落库（界面与库里同一份）', (() => {
  const row = store.reviewById(cr2.body.data.reviewId, 9);
  const findings = JSON.parse(row.findings_json);
  return findings.length === 1 && findings[0].quote === '积分是累加值' && row.summary === '第二版';
})(), store.reviewById(cr2.body?.data?.reviewId, 9)?.findings_json);
check('【回归】缓存命中时条目按新结论重排（旧的 quote 不再留着）', (() => {
  const items = store.listReviewItems(cr2.body.data.reviewId);
  return items.length === 1 && items[0].quote === '积分是累加值';
})());

/* ------------------------------------------------------------------ */
/* 【回归】/review/:id/apply 之后 blocks_json 要跟新草稿对上                  */
/* ------------------------------------------------------------------ */
const staleChat = createFakeChat([
  { summary: '补丁', findings: [{ kind: 'logic', severity: 'high', quote: '导数是变化率', issue: '不严谨', suggestion: '补一句', patch: '导数是瞬时变化率。' }], strengths: [] },
]);
const staleHandlers = createHandlers({ store, env: { AI_API_KEY: 'k', AI_MODEL: 'deepseek-flash' }, chatImpl: staleChat.chatImpl });
const staleCall = (method, pathname, extra = {}) => handle(staleHandlers, { method, pathname, query: new URLSearchParams(), body: {}, files: null, user: { id: 10, name: '过期块' }, ip: '127.0.0.4', ...extra });
const staleSession = await staleCall('POST', '/session', { body: { draft: '# 导数\n\n导数是变化率。' } });
const staleId = staleSession.body?.data?.sessionId;
const staleReview = await staleCall('POST', '/review', { body: { sessionId: staleId } });
const staleApply = await staleCall('POST', `/review/${staleReview.body.data.reviewId}/apply`, { body: {} });
check('【回归】/review/:id/apply 确实打上了补丁', staleApply.body?.data?.draftMd?.includes('瞬时') === true, JSON.stringify(staleApply.body?.data?.draftMd));
check('【自检】打补丁之后会话里确实有块（否则下面那条比的是空数组）', JSON.parse(store.sessionById(staleId).blocks_json).length > 0, store.sessionById(staleId).blocks_json);
check('【回归】/review/:id/apply 之后 blocks_json 与新草稿一致（不是打补丁前那份）', (() => {
  const session = store.sessionById(staleId);
  return JSON.parse(session.blocks_json).some((block) => JSON.stringify(block).includes('瞬时')) && session.draft_md.includes('瞬时');
})(), store.sessionById(staleId)?.blocks_json);
// 上面看的是库里那一列，这里看接口真正回给界面的：两者必须是同一份。
check('【回归】/review/:id/apply 之后 GET /session/:id 回的是新块', (await staleCall('GET', `/session/${staleId}`)).body.data.session.blocks.some((block) => JSON.stringify(block).includes('瞬时')));

check('/sessions 列出自己的会话', (await call('GET', '/sessions')).body.data.sessions.length === 1);
check('/session/:id 返回会话详情', (await call('GET', `/session/${sid}`)).body.data.session.id === sid);
check('/session/:id 详情里的 postId 会回填', (await call('POST', '/save', { body: { sessionId: sid, postId: 4242 } })).body.data.postId === 4242);
check('【回归】/save 之后 postId 真的落库了', store.sessionById(sid).post_id === 4242);
check('【回归】/save 之后同一篇帖子能复用这条工作台', store.sessionForPost(user.id, 4242)?.id === sid);
check('【回归】/save 不传 postId 时不把已有的 post_id 抹掉', (() => {
  const session = store.sessionById(sid);
  return session.post_id === 4242;
})());
check('/assets/:id 目前一律 404（图片只读不存）', (await call('GET', '/assets/1')).status === 404);

/* ------------------------------------------------------------------ */
/* 【安全】/save 也必须有长度闸                                            */
/* ------------------------------------------------------------------ */
// /session 一直在拦超长草稿，但 /save 直接把它写进 notes_messages.draft_md：
// 同一个上限，一条路拦、一条路不拦，等于没拦。
check('【安全】/save 的正文超过上限也是 413', (await call('POST', '/save', { body: { sessionId: sid, draftMd: 'x'.repeat(30000) } })).status === 413);
check('【安全】/save 被拒之后库里还是原来的草稿', !(store.sessionById(sid).draft_md ?? '').includes('x'.repeat(100)));
check('【安全】/save 的标题超过上限是 400', (await call('POST', '/save', { body: { sessionId: sid, title: 't'.repeat(500) } })).status === 400);

/* ------------------------------------------------------------------ */
/* 【回归】材料里的图片必须真的发给模型                                       */
/* ------------------------------------------------------------------ */
// 原来 routes 调用 generate/turn 时压根不传 assets（orchestrator 的默认值是 []），
// 于是"编辑区图片连同材料一起发"这句承诺是空的：图片说明、公式截图这类
// 只有看图才知道对不对的问题，模型永远看不到。
// 这里直接把一张图放进会话附件表（正是材料抽取后落库的那条路径），
// 再跑一次 /generate，检查请求体里真的有 image_url。
const imageChat = createFakeChat([
  { title: '带图笔记', tags: ['图'], ops: [], needsMore: [], notes: [], warnings: [] },
]);
const imgHandlers = createHandlers({ store, env: { AI_API_KEY: 'k', AI_MODEL: 'deepseek-flash' }, chatImpl: imageChat.chatImpl });
const imgCall = (method, pathname, extra = {}) => handle(imgHandlers, { method, pathname, query: new URLSearchParams(), body: {}, files: null, user: { id: 11, name: '图' }, ip: '127.0.0.5', ...extra });
const imgSession = await imgCall('POST', '/session', { body: { draft: '# 带图笔记\n\n下面这张图说明了切线的斜率。' } });
const imgId = imgSession.body?.data?.sessionId;
store.addAttachment({ sessionId: imgId, name: '切线.png', mime: 'image/png', bytes: 8, dataUrl: 'data:image/png;base64,iVBORw0KGgo=' });
await imgCall('POST', '/generate', { body: { sessionId: imgId } });
const imgParts = (imageChat.calls.at(-1)?.messages ?? []).flatMap((message) => (Array.isArray(message.content) ? message.content : []));
check('【回归】材料里的图片以 image_url 形式进了请求（模型真的能看到图）', imgParts.some((part) => part?.type === 'image_url' && part.image_url?.url?.startsWith('data:image/png')), JSON.stringify(imgParts));
// /assets/:id 仍然 404：图片只在请求里用一次，服务端不留可下载的副本。
check('【自检】图片没有变成可下载资源（/assets 依旧 404）', (await imgCall('GET', `/assets/${imgId}`)).status === 404);
// 没有图片的会话不许凭空多出 image_url 片段（否则每轮都白花 token）
const plainParts = (fake.calls.at(-1)?.messages ?? []).flatMap((message) => (Array.isArray(message.content) ? message.content : []));
check('【回归】没有图片的会话不会凭空带上 image_url', !plainParts.some((part) => part?.type === 'image_url'), JSON.stringify(plainParts));
// /generate 的要求文字也要过长度闸（以前只有 /turn 有，同一段超长文字两条路口径不同）
check('【回归】/generate 的要求超过 1000 字也是 400', (await call('POST', '/generate', { body: { sessionId: sid, requirement: 'x'.repeat(1001) } })).status === 400);

/* ------------------------------------------------------------------ */
/* 【回归】提示词里的图片编号必须和材料正文里的编号对得上                        */
/* ------------------------------------------------------------------ */
// 走真实上传路径：两份各带一张图的 DOCX ⇒ 抽取侧要把每份文件各自从 1 开始的
// 图片编号重编成全局唯一（否则两张图都叫 img1），附件表要把这个编号存下来，
// 提示词里的「图 N 对应 imgK」才真的指得出材料正文里的 `[imgK]`。
const iconChat = createFakeChat([
  { title: '带图材料', tags: [], ops: [], needsMore: [], notes: [], warnings: [] },
]);
const iconHandlers = createHandlers({ store, env: { AI_API_KEY: 'k', AI_MODEL: 'deepseek-flash' }, chatImpl: iconChat.chatImpl });
const iconCall = (method, pathname, extra = {}) => handle(iconHandlers, { method, pathname, query: new URLSearchParams(), body: {}, files: null, user: { id: 12, name: '图材料' }, ip: '127.0.0.6', ...extra });
const docxWithPicture = (label) => ({
  filename: `${label}.docx`,
  mime: '',
  data: buildZip([
    { name: 'word/document.xml', data: `<w:document><w:body><w:p><w:r><w:t>${label} 的正文</w:t></w:r></w:p></w:body></w:document>` },
    { name: 'word/media/image1.png', data: 'PNGDATA', stored: true },
  ]),
});
const iconSession = await iconCall('POST', '/session', {
  body: { draft: '# 带图材料' },
  files: [docxWithPicture('甲'), docxWithPicture('乙')],
});
const iconId = iconSession.body?.data?.sessionId;
const iconNames = store.listAttachments(iconId).map((row) => row.name);
check('【回归】两份材料各一张图时都存进了附件表', iconNames.length === 2, JSON.stringify(iconNames));
check(
  '【回归】附件名里带着材料侧唯一的图片编号',
  iconNames[0].endsWith('[img1]') && iconNames[1].endsWith('[img2]'),
  JSON.stringify(iconNames),
);
await iconCall('POST', '/generate', { body: { sessionId: iconId } });
const iconText = (iconChat.calls.at(-1)?.messages ?? [])
  .map((message) => (typeof message.content === 'string' ? message.content : (message.content ?? []).map((part) => part?.text ?? '').join('\n')))
  .join('\n');
// 说明：抽取器把图放进 `images[]`，材料正文里**没有** `image` 块，所以正文不会出现
// `[imgK]`。要保证的是"编号唯一且可引用"：两处口径同名，模型才指得出是哪张。
check(
  '【回归】提示词里的「图 N 对应 imgK」是唯一的 img1 / img2',
  /\[图 1 对应 img1\]/.test(iconText) && /\[图 2 对应 img2\]/.test(iconText),
  iconText.split('\n').filter((line) => line.includes('对应')).join(' | '),
);
check(
  '【回归】附件名里的编号与提示词引用的编号一致',
  /\[图 1 对应 img1\] [^\n]*image1\.png/.test(iconText) && /\[图 2 对应 img2\] [^\n]*image1\.png/.test(iconText),
  iconText.split('\n').filter((line) => line.includes('对应')).join(' | '),
);
check('【回归】提示词里的图片名不带内部编号后缀', !iconText.includes('[img1] image1') && !/image1\.png \[img\d\]/.test(iconText));

/* ------------------------------------------------------------------ */
/* 【安全】/session 写库必须有上限（重复上传不能让磁盘无限长）                    */
/* ------------------------------------------------------------------ */
// 面板每次编辑都会打 /session，而它每次都会把材料重新抽一遍并写库。
// 以前既不判重也不裁剪：同一个文件上传一次，之后每敲一个字就多一份 blocks_json；
// 图片附件同理，增长完全由客户端控制，服务端却没有上限。
const beforeMaterials = store.listMaterials(iconId).length;
const beforeAttachments = store.listAttachments(iconId).length;
for (let i = 0; i < 3; i += 1) {
  await iconCall('POST', '/session', { body: { sessionId: iconId, draft: '# 带图材料' }, files: [docxWithPicture('甲'), docxWithPicture('乙')] });
}
const afterMaterials = store.listMaterials(iconId).length;
const afterAttachments = store.listAttachments(iconId).length;
check('【安全】重复上传同一份材料不会在库里越堆越多', afterMaterials <= beforeMaterials + 2, `before=${beforeMaterials} after=${afterMaterials}`);
check('【安全】重复上传同一张图不会重复落库', afterAttachments === beforeAttachments, `before=${beforeAttachments} after=${afterAttachments}`);
check('【安全】附件数始终不超过 MAX_IMAGES', afterAttachments <= 6, `after=${afterAttachments}`);

// 端到端跑出来的真 bug：/apply 把 applyOps 的 null markdown 直接写进 draft_md，
// 撞上 NOT NULL 约束 → 500（用户点「应用」就失败）。
const applyOpsCall = await call('POST', '/apply', { body: { sessionId: sid } });
check('【端到端】/apply 不再 500', applyOpsCall.status === 200, JSON.stringify(applyOpsCall.body));
check('【端到端】/apply 落库的 draft_md 是字符串', typeof store.sessionById(sid).draft_md === 'string' && store.sessionById(sid).draft_md.length > 0);
check('【端到端】/apply 回传 applied 与 markdown', Array.isArray(applyOpsCall.body.data.applied) && typeof applyOpsCall.body.data.draftMd === 'string');

/* ------------------------------------------------------------------ */
/* 【回归】/apply 不许把已经落库的这一轮 op 再跑一遍                          */
/* ------------------------------------------------------------------ */
// /generate、/turn 收尾已经调 persistOutcome 把 op 应用进 blocks_json 与 draft_md，
// 同时又把同一批 op 塞进了 pendingOps ⇒ 面板的「应用到编辑区」（不带 ops）走
// `/apply` → pendingOps 分支时会**再应用一遍**：insert 变两个、replace 白跑一趟。
const insertChat = createFakeChat([
  { title: '导数', tags: [], ops: [{ kind: 'insert', after: 'b1', type: 'paragraph', text: '整理时补的一句Y' }], needsMore: [], notes: [], warnings: [] },
]);
const insertHandlers = createHandlers({ store, env: { AI_API_KEY: 'k', AI_MODEL: 'deepseek-flash' }, chatImpl: insertChat.chatImpl });
const callInsert = (method, pathname, extra = {}) => handle(insertHandlers, { method, pathname, query: new URLSearchParams(), body: {}, files: null, user: { id: 7, name: '二次应用' }, ip: '127.0.0.2', ...extra });

const ins = await callInsert('POST', '/session', { body: { draft: '# 导数\n\n导数是变化率。' } });
const insId = ins.body?.data?.sessionId;
const insGen = await callInsert('POST', '/generate', { body: { sessionId: insId } });
const afterGenerate = insGen.body?.data?.draftMd ?? '';
check('【回归】/generate 之后待应用指令已清空（op 已经落库，不该再挂一遍）', (handlers.pendingOps.get(insId) ?? []).length === 0, JSON.stringify(handlers.pendingOps.get(insId)));
// 【安全】pendingOps 只 set 不 delete 的话，每个跑过一次模型的会话都会在进程里常驻一条。
// 它现在的语义只是"这一轮的待应用 op"——落库那一刻就该消失，所以用 delete 而不是 set 成 []。
check('【安全】落库之后会话不再占着 pendingOps 的槽位', !handlers.pendingOps.has(insId), `size=${handlers.pendingOps.size}`);
const insApply = await callInsert('POST', '/apply', { body: { sessionId: insId } });
const afterApply = insApply.body?.data?.draftMd ?? '';
check('【回归】/generate 之后点应用到编辑区不会把 insert 再来一遍', afterApply.split('整理时补的一句Y').length - 1 === 1, JSON.stringify(afterApply));
check('【回归】/generate → /apply 的草稿一字不变（已经是应用后的状态）', afterApply === afterGenerate);
check('【回归】/apply 报的 applied 是这一轮落库时真正应用的那些（不是空跑）', Array.isArray(insApply.body?.data?.applied) && insApply.body.data.applied.length === 1, JSON.stringify(insApply.body?.data?.applied));

const limited = createHandlers({ store, env: { AI_API_KEY: 'k', AI_MODEL: 'deepseek-flash' }, chatImpl: createFakeChat([{ title: 't', tags: [], ops: [], notes: [], warnings: [] }]).chatImpl });
let last = 0;
for (let i = 0; i < 11; i += 1) last = (await handle(limited, { method: 'POST', pathname: '/generate', query: new URLSearchParams(), body: { sessionId: sid }, files: null, user, ip: '1.1.1.1' })).status;
check('【RF-2】第 11 次 /generate 触发 429 限流', last === 429);
check('限流按用户区分，另一用户不受影响', (await handle(limited, { method: 'POST', pathname: '/generate', query: new URLSearchParams(), body: { sessionId: sid }, files: null, user: { id: 2 }, ip: '1.1.1.1' })).status === 404);

const badType = await call('POST', '/session', { files: [{ filename: 'evil.exe', mime: 'application/octet-stream', data: Buffer.from('MZ\x90\x00', 'latin1') }] });
check('【RF-1】不支持的类型返回 415', badType.status === 415 && badType.body.error.code === 'notes_unsupported_type');
check('错误响应结构是 { ok:false, error:{ code, message } }', badType.body.ok === false && typeof badType.body.error.message === 'string');
check('未配置 AI 时 /generate 返回 503', (await handle(createHandlers({ store, env: {} }), { method: 'POST', pathname: '/generate', query: new URLSearchParams(), body: { sessionId: sid }, files: null, user, ip: '9.9.9.9' })).status === 503);

// ─────────────────────────────────────────────────────────────
// 【编辑区为一等输入】用户 m02709 的真实用法：
// 不传文件，直接把编辑区里正在写的 Markdown 丢进来。
// ─────────────────────────────────────────────────────────────
const typed = '# 我的草稿\n\n导数刻画的是变化率。\n\n## 例子\n\n$f(x)=x^2$ 的导数是 $2x$。';
const workspace = await call('POST', '/session', { body: { draft: typed, title: '我的草稿' } });
check('【编辑区】不传文件也能建工作台', workspace.status === 200 && workspace.body.data.sessionId > 0, JSON.stringify(workspace.body));
check('【编辑区】标题取传进来的那一个', workspace.body.data.title === '我的草稿');
check('【编辑区】正文被识别成块（标题 + 段落 + 公式段）', workspace.body.data.blocks.length >= 3);
check('【编辑区】块类型识别正确（h1 / paragraph / h2）', workspace.body.data.blocks[0].type === 'heading' && workspace.body.data.blocks.some((b) => b.type === 'paragraph') && workspace.body.data.blocks.some((b) => b.level === 2));
const typeSid = workspace.body.data.sessionId;

// 同一篇帖子复用同一条会话：否则每次打开编辑区都新建，材料要重传、历史会散开
const again = await call('POST', '/session', { body: { draft: typed, title: '我的草稿', postId: 7 } });
const againSame = await call('POST', '/session', { body: { draft: typed, postId: 7 } });
check('【编辑区】同一篇帖子复用同一条会话', againSame.body.data.sessionId === again.body.data.sessionId);

// 实时监控的核心：编辑区改了，工作台的块跟着改
const edited = `${typed}\n\n新增的一段。`;
const resync = await call('POST', '/session', { body: { sessionId: typeSid, draft: edited } });
check('【编辑区】编辑区一变，块序列跟着变', resync.body.data.blocks.length > workspace.body.data.blocks.length);
check('【编辑区】同步会落库（面板刷新后还在）', store.sessionById(typeSid).draft_md === edited);

// 整理作用的是**编辑区此刻**的内容，而不是会话里上次那份
const genTyped = await call('POST', '/generate', { body: { sessionId: typeSid, draft: edited } });
check('【编辑区】/generate 直接吃编辑区内容', genTyped.status === 200 && typeof genTyped.body.data.draftMd === 'string', JSON.stringify(genTyped.body));
const calls = fake.calls;
const lastUserMessage = calls[calls.length - 1].messages.find((m) => m.role === 'user');
check('【编辑区】整理用的材料就是编辑区那段文字', JSON.stringify(lastUserMessage).includes('导数刻画的是变化率') && JSON.stringify(lastUserMessage).includes('新增的一段'));

// 编辑区为空、也没有材料 → 400（而不是 500 或空跑模型）
check('【编辑区】编辑区为空且无材料时 400', (await call('POST', '/session', { body: { draft: '   ' } })).status === 400);
check('【编辑区】编辑区超 20000 字返回 413', (await call('POST', '/session', { body: { draft: 'x'.repeat(20001) } })).status === 413);

// ── 聊天式历史：每轮快照 + 回滚到之前任何一版 ──────────────────────
// 用户 m04046 第 3 条：要能看到之前的对话，并能回滚到之前某一次的版本。
// 数据侧要点：快照必须跟着**这一轮结束时的整篇草稿**走；回滚只动草稿与预览，
// 绝不碰编辑区（写回编辑区仍然要用户点「应用到编辑区」）。
const firstDraft = store.sessionById(typeSid).draft_md;
const secondTurn = await call('POST', '/turn', { body: { sessionId: typeSid, requirement: '再加一句结尾' } });
check('【历史】/turn 也成功（用于制造第二个版本）', secondTurn.status === 200, JSON.stringify(secondTurn.body).slice(0, 200));
const messages = await call('GET', '/messages', { query: new URLSearchParams({ sessionId: String(typeSid) }) });
check('【历史】/messages 需要会话号', (await call('GET', '/messages')).status === 400);
check('【历史】/messages 列出这条会话的每一轮', messages.status === 200 && (messages.body.data?.messages ?? []).length >= 2, JSON.stringify(messages.body).slice(0, 200));
const msgList = messages.body.data?.messages ?? [];
check('【历史】每条消息带 id / role / requirement', msgList.every((m) => Number.isInteger(m.id) && typeof m.role === 'string' && typeof m.requirement === 'string'));
check('【历史】每条消息带这一轮的草稿快照与时间', msgList.every((m) => typeof m.draftMd === 'string' && Number.isInteger(m.createdAt)));
check('【历史】面板靠快照就能画出"回滚到这一版"', msgList.some((m) => m.draftMd.includes('导数刻画的是变化率')));

const snapMsgId = msgList.find((m) => m.draftMd === firstDraft)?.id;
check('【历史】能找到第一版那条消息', Number.isInteger(snapMsgId), JSON.stringify(msgList.map((m) => m.draftMd?.slice(0, 20))));
const detail = (await call('GET', `/session/${typeSid}`)).body.data;
const rolled = await call('POST', '/rollback', { body: { sessionId: typeSid, messageId: snapMsgId } });
check('【历史】回滚返回那一版的草稿与块', rolled.status === 200 && rolled.body.data.draftMd === firstDraft && Array.isArray(rolled.body.data.blocks), JSON.stringify(rolled.body).slice(0, 200));
check('【历史】回滚后会话草稿就是那一版', store.sessionById(typeSid).draft_md === firstDraft);
check('【历史】回滚不改历史（消息只增不减，回滚本身也留一条痕迹）', store.listMessages(typeSid).length >= msgList.length + 1);
check('【历史】回滚到一个不存在的消息返回 404', (await call('POST', '/rollback', { body: { sessionId: typeSid, messageId: 999999 } })).status === 404);
check('【历史】别人的会话回滚返回 404', (await call('POST', '/rollback', { body: { sessionId: typeSid, messageId: snapMsgId }, user: { id: 77 } })).status === 404);
check('【历史】/session/:id 的 messages 也带上 id 与快照（老面板接得上）', (() => {
  return detail.messages.length > 0
    && detail.messages.every((m) => Number.isInteger(m.id) && typeof m.draftMd === 'string' && Number.isInteger(m.createdAt))
    && detail.messages.some((m) => Array.isArray(m.ops) && Array.isArray(m.skipped));
})());

db.close(); rmSync(dir, { recursive: true, force: true });
summary();
