import { createChecker } from './helpers/check.mjs';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNotesStore } from '../src/store-sqlite.mjs';
import { assignBlockIds, makeBlock } from '../src/blocks.mjs';

const { check, summary } = createChecker();
const dir = mkdtempSync(join(tmpdir(), 'notes-store-'));
const db = new DatabaseSync(join(dir, 't.db'));
const store = createNotesStore({ db });
store.ensureSchema();

const blocks = assignBlockIds([makeBlock('heading', '导数', { level: 1 }), makeBlock('paragraph', '内容')]);
const id = store.createSession({ userId: 7, blocks, images: [], sources: [{ name: 'a.md', kind: 'text', bytes: 12 }], materialChars: 12 });
check('createSession 返回数字 id', Number.isInteger(id) && id > 0);
check('sessionById 取回会话', store.sessionById(id).user_id === 7);
check('sessionForUser 用户不匹配时返回 null（路由层转 404）', store.sessionForUser(id, 8) === null && store.sessionForUser(id, 7).id === id);
check('会话按 user 隔离出现在列表里', store.listSessions(7).some((s) => s.id === id) && store.listSessions(8).length === 0);

store.updateDraft(id, { blocks, title: '导数笔记', tags: ['微积分'], draftMd: '# 导数' });
check('updateDraft 写入标题/标签/草稿', store.sessionById(id).title === '导数笔记' && JSON.parse(store.sessionById(id).tags_json)[0] === '微积分');
check('updateDraft 同步刷新 updated_at', store.sessionById(id).updated_at >= store.sessionById(id).created_at);
// 【回归】/save 一直把 postId 只做回显：updateDraft 的 UPDATE 里根本没有 post_id 列，
// 于是"同一篇帖子复用同一条工作台"（sessionForPost）永远查不到东西，材料与历史散成一条条。
check('updateDraft 能把 postId 落库', (() => {
  store.updateDraft(id, { blocks, title: '导数笔记', tags: ['微积分'], draftMd: '# 导数', postId: 4242 });
  return store.sessionById(id).post_id === 4242;
})());
check('【回归】落库 postId 之后 sessionForPost 能查到这条工作台', store.sessionForPost(7, 4242)?.id === id, JSON.stringify(store.sessionForPost(7, 4242)));
check('updateDraft 不传 postId 时不改动已有的 post_id', (() => {
  store.updateDraft(id, { blocks, title: '导数笔记', tags: ['微积分'], draftMd: '# 导数（改）' });
  return store.sessionById(id).post_id === 4242;
})());
store.addMessage({ sessionId: id, role: 'user', requirement: '把段落合并', ops: [{ kind: 'replace', target: 'b2', text: 'x' }], skipped: [], warnings: [], usage: { prompt: 10, completion: 5 } });
check('addMessage 记录需求与 ops', store.listMessages(id)[0].requirement === '把段落合并');
const rid = store.saveReview({ sessionId: id, userId: 7, contentHash: 'abc', summary: '还行', findings: [{ id: 'f1', kind: 'logic' }], model: 'fake' });
check('saveReview 与读回', store.reviewById(rid, 7).summary === '还行' && store.listReviews({ userId: 7 }).length === 1);
check('stats 汇总会话与审查数', store.stats(7).sessions === 1 && store.stats(7).reviews === 1);
check('重复 ensureSchema 幂等且版本为 1', (() => { store.ensureSchema(); return db.prepare("SELECT value FROM notes_schema_meta WHERE key='version'").get().value === '1'; })());
check('宿主表结构未被触碰（无 posts/users 建表语句）', db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('posts','users')").get().n === 0);

check('建表数恰好 11 张 notes_ 表', db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name LIKE 'notes\\_%' ESCAPE '\\'").get().n === 11);
check('addMaterials 落库并回读 kind/name', (() => {
  store.addMaterials(id, [{ kind: 'docx', name: '课件.docx', bytes: 100, blocks, images: [], warnings: [{ code: 'empty_material' }] }]);
  const docx = store.listMaterials(id).filter((m) => m.kind === 'docx');
  return docx.length === 1 && docx[0].name === '课件.docx' && JSON.parse(docx[0].warnings_json)[0].code === 'empty_material';
})());
check('createSession 会把材料一起落库', store.listMaterials(id).some((m) => m.kind === 'text' && m.name === 'a.md'));
check('addAttachment 存下 dataUrl 供多模态复用', (() => {
  const aid = store.addAttachment({ sessionId: id, name: '图1.png', mime: 'image/png', bytes: 4, dataUrl: 'data:image/png;base64,AAAA' });
  const found = store.attachmentById(aid);
  return Number.isInteger(aid) && found.data_url === 'data:image/png;base64,AAAA' && found.path === null;
})());
check('setPref / getPref 往返', (() => {
  store.setPref(7, 'autoReview', 'true');
  store.setPref(7, 'autoReview', 'false');
  return store.getPref(7, 'autoReview') === 'false' && store.getPref(7, 'missing') === null;
})());
check('addUsage 累加 token 用量', (() => {
  store.addUsage({ userId: 7, sessionId: id, model: 'fake', prompt: 10, completion: 5 });
  store.addUsage({ userId: 7, sessionId: id, model: 'fake', prompt: 3, completion: 2 });
  const usage = store.usageSummary(7);
  return usage.prompt === 13 && usage.completion === 7 && usage.calls === 2;
})());
check('addTurnLog 记录一轮微调', (() => {
  store.addTurnLog({ sessionId: id, requirement: '合并段落', applied: 2, skipped: 1, needsMore: 0 });
  return store.listTurnLogs(id)[0].requirement === '合并段落';
})());
check('addReviewItem 落审查明细', (() => {
  store.addReviewItem({ reviewId: rid, findingId: 'f1', kind: 'logic', severity: 'high', quote: '原文', applied: 0 });
  return store.listReviewItems(rid)[0].finding_id === 'f1';
})());
check('listReviews 按用户隔离', store.listReviews({ userId: 99 }).length === 0);

// ── 每轮留一份草稿快照：聊天式历史要能回滚到之前任何一版 ──────────────
// 没有快照就只能"从头重放 ops"，一旦某轮被跳过或模型输出有细微差别，
// 回滚出来的稿子就与当时看到的不一致。存整篇快照是最省事也最准的做法。
const snapSession = store.createSession({ userId: 11, title: '快照', blocks: [], images: [], sources: [] });
const m1 = store.addMessage({ sessionId: snapSession, role: 'assistant', ops: [], draftMd: '# 第一版' });
const m2 = store.addMessage({ sessionId: snapSession, role: 'user', requirement: '加一段', ops: [], draftMd: '# 第一版\n\n第二版新增' });
store.updateDraft(snapSession, { blocks: [], title: '快照', tags: [], draftMd: '# 第一版\n\n第二版新增\n\n第三版又加' });
const rows = store.listMessages(snapSession);
check('addMessage 存下这一轮的草稿快照', rows[1].draft_md === '# 第一版\n\n第二版新增' && m1 !== m2);
check('listMessages 按 id 升序且带 id / created_at', rows[0].id === m1 && rows[1].id === m2 && Number.isInteger(rows[1].created_at));
check('addMessage 不传快照时留空串（不是 null，面板不用判两种空值）', rows[0].draft_md === '# 第一版');

// 【安全】消息表是这个插件里长得最快的一张表（一轮一条，每条带整篇草稿快照）。
// 取历史必须带 LIMIT，否则聊得久的会话能把 /session/:id 与 /messages 撑成几 MB。
for (let i = 0; i < 12; i += 1) store.addMessage({ sessionId: snapSession, role: 'assistant', ops: [], draftMd: `# 第 ${i + 3} 版` });
const capped = store.listMessages(snapSession, { limit: 5 });
check('【安全】listMessages 受 limit 约束（不会一次把全部历史读出来）', capped.length === 5, String(capped.length));
check('【安全】listMessages 截取的是最近的几条、并翻回时间正序', capped[4].id === store.listMessages(snapSession)[13].id && capped[0].id < capped[4].id, JSON.stringify(capped.map((row) => row.id)));

db.close();
rmSync(dir, { recursive: true, force: true });
summary();
