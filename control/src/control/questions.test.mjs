// H7 item 5 (questions.mjs + admission-guard.mjs admitQuestionAnswer): a worker's pending question is answered with its
// owning seat's text, through a journaled intent the native guard admits for exactly that request and response.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import assert from 'node:assert/strict';
import { FENCE_PROTOCOL } from './native-fence.mjs';
import { ControlStore } from './store.mjs';
import { Controller } from './controller.mjs';
import { Permissions } from './permissions.mjs';
import { COMPANY, PROGRAMME } from './authority.mjs';
import { admitPermission, permissionProjection, BOOT } from './admission-guard.mjs';
import { canonical, digest } from './permission-policy.mjs';
import { requireUnpinnedAdmissionGuard } from './admission-guard-precondition.mjs';
import { Questions, answerResponse, MAX_ANSWERS_PER_QUESTION } from './questions.mjs';
requireUnpinnedAdmissionGuard();

const T = n => `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`;
const issue = id => ({ id, companyId: COMPANY, parentId: id === PROGRAMME ? null : PROGRAMME, assigneeUserId: 'local-board', assigneeAgentId: null, status: 'in_progress' });
// The two real shapes: Codex request_user_input (codex-app-server-agent.ts) and Claude AskUserQuestion.
const CODEX_Q = { id: 'permission-item-42', provider: 'codex', name: 'request_user_input', kind: 'question', title: 'Question',
  input: { questions: [{ id: '0', header: 'Question 1', question: 'What is my session id? ./SESSION-ID is missing.', options: [], isOther: true }] }, metadata: { itemId: 'item-42' } };
const CLAUDE_Q = { id: 'toolu_q1', provider: 'claude', name: 'AskUserQuestion', kind: 'question', title: 'Question',
  input: { questions: [{ header: 'Branch', question: 'Which branch should I push to?', options: [{ label: 'main' }, { label: 'cc/j6' }], multiSelect: false }] } };

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orca-questions-')));
  const file = path.join(dir, 'journal.sqlite'), store = new ControlStore(file);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const states = new Map(), pending = new Map(), used = new Set(), answers = [];
  const native = { route: () => undefined,
    inspect: async id => ({ boot: BOOT, nativeId: 'native-' + id, fenceProtocol: FENCE_PROTOCOL, saturated: false, humanAt: 0, status: 'idle', pending: 0, lastPromptId: null, lastUserAt: null, ...(states.get(id) ?? {}) }),
    send: async (id, text, messageId) => { states.set(id, { ...(states.get(id) ?? {}), lastPromptId: messageId }); },
    snapshot: async id => ({ id, status: 'running', pendingPermissions: pending.get(id) ?? [] }),
    // The daemon's respondToPermission, with the REAL guard in front of it, as the staged host has it.
    answer: async (id, intentId, response) => {
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        const agent = { id, lastUserMessageAt: null, pendingPermissions: new Map((pending.get(id) ?? []).map(p => [p.id, p])) };
        let rid; try { rid = admitPermission(db, agent, intentId, response, used); } catch (e) { throw Error('Orca native permission refused: ' + e.message, { cause: e }); }
        answers.push({ id, requestId: rid, response }); pending.set(id, (pending.get(id) ?? []).filter(p => p.id !== rid));
        return { agentId: id, requestId: 'orca-permission:' + intentId, resolution: response };
      } finally { db.close(); }
    } };
  const control = new Controller({ store, native, authority: async id => issue(id) });
  control.permissions = new Permissions(control);
  control.questions = new Questions(control);
  const enrol = () => { const id = randomUUID(); store.created(id, T(1), path.join(dir, 'tasks', id)); return id; };
  // A delegated worker whose current turn is a controller instruction, now waiting on a question.
  const worker = async question => {
    const id = enrol(); await control.handback(id, 'Delegated for the question verification');
    await control.send({ sessionId: id, messageId: randomUUID(), text: 'Build J6 and report.' }, undefined, store.get(id).generation, { automated: 'test' });
    pending.set(id, [question]); return id;
  };
  return { dir, file, store, db: store.db, control, states, pending, used, answers, enrol, worker, q: control.questions };
}

test('a Codex request_user_input is answered with the seat’s text through the real guard, and only once', async t => {
  const f = fixture(t), id = await f.worker(CODEX_Q), m = randomUUID();
  const r = await f.q.answer({ sessionId: id, messageId: m, text: 'Your session id is in ./SESSION-ID now; carry on with J6.', generation: f.store.get(id).generation });
  assert.deepEqual([r.state, r.requestId], ['answered', CODEX_Q.id]);
  assert.deepEqual(f.answers[0].response, { behavior: 'allow', updatedInput: { answers: { 'Question 1': 'Your session id is in ./SESSION-ID now; carry on with J6.' } } });
  const row = f.db.prepare('SELECT * FROM permission_intents WHERE id=?').get(m);
  assert.deepEqual([row.state, row.pool, JSON.parse(row.body).kind], ['answered', 'question:' + id, 'question-answer']);
  // W1 F6: the intent carries the inspected worker's native session, which the owned daemon's guard requires
  // (trusted-contribution.test.mjs drives this body through the real agent.permission_respond guard).
  assert.equal(JSON.parse(row.body).nativeId, 'native-' + id);
  // A retry with the same id reports the recorded outcome and reaches the daemon no second time.
  assert.equal((await f.q.answer({ sessionId: id, messageId: m, text: 'again', generation: f.store.get(id).generation })).state, 'answered');
  assert.equal(f.answers.length, 1);
  // Nothing is pending any more: a new answer is refused before anything is journaled.
  await assert.rejects(f.q.answer({ sessionId: id, messageId: randomUUID(), text: 'x', generation: f.store.get(id).generation }), /no pending question/);
});
test('W1 F6: an unresolved or conflicting native identity refuses the answer before anything is journaled', async t => {
  const f = fixture(t);
  for (const state of [{ nativeId: null }, { nativeIdentity: { conflict: true } }]) {
    const id = await f.worker(CODEX_Q); f.states.set(id, { ...(f.states.get(id) ?? {}), ...state });
    await assert.rejects(f.q.answer({ sessionId: id, messageId: randomUUID(), text: 'carry on', generation: f.store.get(id).generation }), /resolved consistent native identity/);
    assert.equal(f.db.prepare('SELECT count(*) n FROM permission_intents WHERE pool=?').get('question:' + id).n, 0);
  }
  assert.equal(f.answers.length, 0);
});
test('a Claude AskUserQuestion is answered by its header; the text goes to every question of the request', async t => {
  assert.deepEqual(answerResponse(CLAUDE_Q, 'cc/j6'), { behavior: 'allow', updatedInput: { answers: { Branch: 'cc/j6' } } });
  assert.deepEqual(answerResponse({ kind: 'question', input: { questions: [{ question: 'a' }, { header: 'B', question: 'b' }] } }, 'x').updatedInput.answers, { 'Question 1': 'x', B: 'x' });
  const f = fixture(t), id = await f.worker(CLAUDE_Q);
  assert.equal((await f.q.answer({ sessionId: id, messageId: randomUUID(), text: 'cc/j6', generation: f.store.get(id).generation })).state, 'answered');
});
test('the controller refuses: a human turn, a changed generation, human input (which revokes), a remote session', async t => {
  const f = fixture(t), id = await f.worker(CODEX_Q), g = f.store.get(id).generation;
  // The question belongs to a turn a human started (the session's expected prompt is not a controller send).
  f.db.prepare('UPDATE sessions SET expected=? WHERE id=?').run(randomUUID(), id);
  f.states.set(id, { lastPromptId: f.store.get(id).expected });
  await assert.rejects(f.q.answer({ sessionId: id, messageId: randomUUID(), text: 'x', generation: g }), /turn the controller did not start/);
  assert.equal(f.answers.length, 0);
  const h = fixture(t), id2 = await h.worker(CODEX_Q);
  await assert.rejects(h.q.answer({ sessionId: id2, messageId: randomUUID(), text: 'x', generation: h.store.get(id2).generation - 1 }), /Control changed/);
  h.states.set(id2, { ...h.states.get(id2), humanAt: 1 });
  await assert.rejects(h.q.answer({ sessionId: id2, messageId: randomUUID(), text: 'x', generation: h.store.get(id2).generation }), /revoked delegation/);
  assert.equal(h.store.get(id2).mode, 'human', 'human input revokes, exactly as before a send');
  const b = fixture(t); const { HostNative } = await import('./host-native.mjs');
  const hn = new HostNative({ store: b.store, book: async () => assert.fail('never'), local: { answer: async () => assert.fail('never local') } }); hn.route = () => ({ creation: '{}' });
  assert.throws(() => hn.answer(randomUUID(), randomUUID(), {}), /answered on its own host/);
});
test('the guard admits exactly the journaled answer to exactly that question, and nothing else', async t => {
  const f = fixture(t), id = await f.worker(CODEX_Q), s = f.store.get(id), used = new Set();
  const intent = (over = {}, pool = 'question:' + id) => {
    const iid = randomUUID(), response = answerResponse(CODEX_Q, 'yes');
    const body = { kind: 'question-answer', generation: s.generation, boot: s.boot, origin: s.expected, authority: s.authority, requestId: CODEX_Q.id,
      requestDigest: digest(canonical(permissionProjection(CODEX_Q))), response: canonical(response), expectedLastUserAt: null, ...over };
    f.db.prepare("INSERT INTO permission_intents VALUES (?,?,?,?,'intent',?,NULL,?)").run(iid, randomUUID(), id, pool, canonical(body), Date.now());
    return iid;
  };
  const admit = (iid, response = answerResponse(CODEX_Q, 'yes'), request = CODEX_Q) => {
    const db = new DatabaseSync(f.file, { readOnly: true });
    try { return admitPermission(db, { id, lastUserMessageAt: null, pendingPermissions: new Map([[request.id, request]]) }, iid, response, used); } finally { db.close(); }
  };
  assert.throws(() => admit(intent(), answerResponse(CODEX_Q, 'something else')), /out-of-policy question answer/, 'a different response than the journaled one');
  assert.throws(() => admit(intent(), { behavior: 'deny', message: 'no' }), /out-of-policy question answer/, 'only an allow');
  const tool = { ...CODEX_Q, kind: 'tool', name: 'Bash', title: 'Run command' };
  assert.throws(() => admit(intent(), answerResponse(CODEX_Q, 'yes'), tool), /out-of-policy question answer/, 'never a tool permission, even with a question-answer intent');
  // ...not even with an intent journaled for exactly that tool request (its digest pinned): the kind alone refuses it.
  const forged = { ...CODEX_Q, id: 'permission-tool-9', kind: 'tool', name: 'Bash', title: 'Run command', input: { command: 'rm -rf ~' } };
  assert.throws(() => admit(intent({ requestId: forged.id, requestDigest: digest(canonical(permissionProjection(forged))) }), answerResponse(CODEX_Q, 'yes'), forged), /out-of-policy question answer/, 'the kind check itself');
  assert.throws(() => admit(intent({ generation: s.generation + 1 })), /Changed question authority/);
  assert.throws(() => admit(intent({}, 'root-epoch-of-some-grant')), /Changed question authority/, 'only the question pool of this session');
  assert.throws(() => admit(intent({ origin: randomUUID() })), /Changed question authority/, 'only on the controller’s own current turn');
  const ok = intent(); assert.equal(admit(ok), CODEX_Q.id);
  assert.throws(() => admit(intent()), /out-of-policy question answer/, 'never twice for the same request');
});
test('a question intent is never read by the routine-permission paths, before or after a restart', async t => {
  const f = fixture(t), id = await f.worker(CODEX_Q);
  f.db.prepare("INSERT INTO permission_intents VALUES (?,?,?,?,'intent','{}',NULL,?)").run(randomUUID(), randomUUID(), id, 'question:' + id, Date.now());
  f.db.prepare("INSERT INTO permission_intents VALUES (?,?,?,?,'intent','{}',NULL,?)").run(randomUUID(), randomUUID(), id, 'some-root-epoch', Date.now());
  new Permissions(f.control);   // a controller restart
  assert.deepEqual(f.db.prepare('SELECT pool,state FROM permission_intents ORDER BY pool').all().map(r => [r.pool.startsWith('question:') ? 'question' : 'routine', r.state]),
    [['question', 'answer-uncertain'], ['routine', 'uncertain']]);
  const src = fs.readFileSync(new URL('./permissions.mjs', import.meta.url), 'utf8');
  assert.match(src, /SELECT \* FROM permission_intents WHERE state IN \('acknowledged','uncertain'\) AND pool NOT LIKE 'question:%'/);
});
test('role_send_session and manager_assign_worker answer a pending question instead of sending; server wires it (static)', () => {
  const rs = fs.readFileSync(new URL('./role-sessions.mjs', import.meta.url), 'utf8'), sendOwned = rs.slice(rs.indexOf('  async sendOwned('));
  assert.ok(sendOwned.indexOf('this.control.questions.answers(a.targetSessionId, a.messageId)') > 0 && sendOwned.indexOf('this.control.questions.answers(a.targetSessionId, a.messageId)') < sendOwned.indexOf('await this.control.send('));
  assert.match(sendOwned, /check: \(\) => \{ this\.control\.bindings\.checkRole\(row\.id, capability\); this\.ownedByCaller\(row\.id, a\.targetSessionId\); \}/);
  const mg = fs.readFileSync(new URL('./manager.mjs', import.meta.url), 'utf8'), assign = mg.slice(mg.indexOf('  async assign('));
  assert.ok(assign.indexOf('this.control.questions.answers(a.workerId, a.messageId)') > 0 && assign.indexOf('this.control.questions.answers(a.workerId, a.messageId)') < assign.indexOf('return this.control.send('));
  assert.match(fs.readFileSync(new URL('./server.mjs', import.meta.url), 'utf8'), /control\.questions = new Questions\(control\);/);
});
test('review H7 B1: a retried message id takes the route its first attempt took, whatever is pending now', async t => {
  const f = fixture(t), id = await f.worker(CODEX_Q), m = randomUUID();
  assert.equal(await f.q.answers(id, m), true, 'fresh, with a question pending: an answer');
  await f.q.answer({ sessionId: id, messageId: m, text: 'answer', generation: f.store.get(id).generation });
  assert.equal(await f.q.answers(id, m), true, 'the question is gone, but this id IS an answer: its retry must not become a send');
  const sent = randomUUID(); await f.control.send({ sessionId: id, messageId: sent, text: 'next job' }, undefined, f.store.get(id).generation, { automated: 'test' });
  f.pending.set(id, [{ ...CODEX_Q, id: 'permission-item-43' }]);
  assert.equal(await f.q.answers(id, sent), false, 'a question is pending, but this id IS a send: its retry must not answer it');
  await assert.rejects(f.q.answers(randomUUID() === id ? id : randomUUID(), m), /Answer identity conflict/, 'an answer id reused for another session');
  assert.equal(await f.q.answers(id, randomUUID()), true); f.pending.set(id, []); assert.equal(await f.q.answers(id, randomUUID()), false);
});
test('review H7 M2: answers are bounded before anything is written, charged to the task, and never use the routine journal', async t => {
  const f = fixture(t), id = await f.worker(CODEX_Q), g = () => f.store.get(id).generation;
  // The guard refuses: a second try is allowed, a third is refused before anything is written.
  f.control.native.answer = async () => { throw Error('Orca native permission refused: Changed question authority'); };
  const first = await f.q.answer({ sessionId: id, messageId: randomUUID(), text: 'a', generation: g() }); assert.equal(first.state, 'refused');
  for (let i = 1; i < MAX_ANSWERS_PER_QUESTION; i++) await f.q.answer({ sessionId: id, messageId: randomUUID(), text: 'a', generation: g() });
  const rows = f.db.prepare("SELECT count(*) n FROM permission_intents WHERE pool=?").get('question:' + id).n;
  await assert.rejects(f.q.answer({ sessionId: id, messageId: randomUUID(), text: 'a', generation: g() }), /already been answered or refused/);
  assert.equal(f.db.prepare("SELECT count(*) n FROM permission_intents WHERE pool=?").get('question:' + id).n, rows, 'nothing written');
  assert.equal(f.db.prepare('SELECT count(*) n FROM task_instruction_charges').get().n >= MAX_ANSWERS_PER_QUESTION + 1, true, 'each answer is charged like an instruction');
  // Question rows never count toward the routine-permission capacity.
  const src = fs.readFileSync(new URL('./permissions.mjs', import.meta.url), 'utf8');
  assert.equal((src.match(/SELECT count\(\*\) n FROM permission_intents WHERE pool NOT LIKE \\'question:%\\'/g) ?? []).length, 2);
});
