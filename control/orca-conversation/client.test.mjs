import { FENCE_PROTOCOL } from '../src/control/native-fence.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createConversation, installedConversation, home } from './client.mjs';
import { ControlStore } from '../src/control/store.mjs';
import { Controller } from '../src/control/controller.mjs';
import { Events } from '../src/control/events.mjs';
import { Manager } from '../src/control/manager.mjs';
import { Leadership } from '../src/control/leadership.mjs';
import { rpc } from '../src/control/rpc.mjs';
import { execFileSync } from 'node:child_process';
import { watchReceipt, wakeTarget } from './watch.mjs';
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orca-chat-')));
  const store = new ControlStore(path.join(root, 'journal.sqlite')), task = randomUUID(), id = randomUUID();
  const config = { bindingsDir: path.join(root, 'bindings'), accountId: 'default', conversationId: '123', senderId: '456', sessionId: randomUUID() };
  let sends = 0, creates = 0; const createdInputs = [];
  const state = { fenceProtocol: FENCE_PROTOCOL, saturated: false, humanAt: 0, status: 'idle', pending: 0, lastPromptId: null, boot: 'fixture', nativeId: id, timelineCursor: { epoch: 'fixture', seq: 0 } };
  const native = { inspect: async () => ({ ...state }), create: async a => { creates++; createdInputs.push({ ...a }); return { id: randomUUID(), cwd: path.join(root, randomUUID()), managerToolsVersion: '1' }; }, send: async (_id, _text, messageId) => { sends++; state.lastPromptId = messageId; }, completion: async () => ({ ended: true, outputObserved: true, outputPreview: 'actual fixture output', outputEvidenceHash: 'a'.repeat(64) }) };
  const control = new Controller({ store, native, authority: async () => ({ id: task, assigneeUserId: 'local-board' }) });
  control.events = new Events(control, path.join(root, 'inbox')); control.manager = new Manager(control, path.join(root, 'grants/manager')); control.leadership = new Leadership(control);
  store.created(id, task, root);
  const secret = 'a'.repeat(43); fs.writeFileSync(path.join(root, 'operator.secret'), secret, { mode: 0o600 });
  const dispatch = rpc(control, secret), calls = [];
  const send = async e => { calls.push(e.method); const result = await dispatch(e); await f.after?.(e); return result; };
  const make = () => createConversation({ config, send, runtimeHome: root, provider: s => f.providerOverrides?.[s.id] ?? f.nativeProvider });
  const f = { nativeProvider: 'codex', root, id, task, config, control, state, store, calls, createdInputs, make, sends: () => sends, creates: () => creates };
  f.run = make();
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return f;
}
test('real SQLite/RPC: discovery, create dedup, delegation, send dedup, result, restart and takeover', async t => {
  const f = fixture(t);
  assert.equal((await f.run({ action: 'list' })).sessions[0].mode, 'human');
  const a = { action: 'create', taskId: f.task, title: 'Saved work' };
  assert.equal((await f.run(a)).sessionId, (await f.run(a)).sessionId); assert.equal(f.creates(), 1);
  await f.run({ action: 'delegate', sessionId: f.id, generation: 1 });
  const input = { action: 'send', sessionId: f.id, generation: 2, text: 'Keep `quotes` and $(literal) text intact' };
  const first = await f.run(input), second = await f.make()(input);
  assert.equal(first.messageId, second.messageId); assert.equal(f.sends(), 1);
  const receipt = { sessionId: f.id, generation: 2, messageId: first.messageId };
  const waited = await f.run({ action: 'wait', ...receipt });
  assert.equal(waited.outputPreview, 'actual fixture output');
  // L40: a finished receipt whose result was read is acknowledged, so its prepared request does not linger.
  assert.equal(waited.acknowledged, true);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM management_requests WHERE id=?').get(first.messageId).n, 0);
  assert.equal((await f.run({ action: 'result', ...receipt })).acknowledged, true, 'reading the result again is harmless');
  await f.run({ action: 'ack', ...receipt });
  f.control.takeover(f.id, 'Human takes over');
  await assert.rejects(f.run(input), /revoked/); assert.equal(f.sends(), 1);
});
test('malformed input, stale generation and unsafe credentials never dispatch native work', async t => {
  const f = fixture(t);
  for (const a of [null, [], {}, { action: 'list', extra: 1 }, { action: 'create', taskId: f.task, title: 'test', provider: 'unknown' }, { action: 'send', sessionId: f.id, generation: 2, text: '\ud800' }]) await assert.rejects(f.run(a));
  assert.deepEqual(f.calls, []);
  await assert.rejects(f.run({ action: 'delegate', sessionId: f.id, generation: 5 }), /changed/);
  fs.chmodSync(path.join(f.root, 'operator.secret'), 0o644);
  await assert.rejects(f.run({ action: 'list' }), /credential/); assert.equal(f.sends(), 0);
});
test('provider choice preserves default dedup and separates real controller creation fingerprints', async t => {
  const f = fixture(t), a = { action: 'create', taskId: f.task, title: 'Same named work' };
  const codex = await f.run(a);
  assert.equal((await f.make()({ ...a, provider: 'codex' })).sessionId, codex.sessionId);
  const claude = await f.run({ ...a, provider: 'claude' });
  assert.notEqual(claude.sessionId, codex.sessionId);
  assert.equal((await f.make()({ ...a, provider: 'claude' })).sessionId, claude.sessionId);
  assert.deepEqual(f.createdInputs.map(a => a.provider), ['codex', 'claude']);
  assert.equal(f.sends(), 0);
  assert.equal(f.store.get(claude.sessionId).mode, 'human');
  await assert.rejects(f.run({ action: 'recover', messageId: claude.messageId }), /unresolved/);
});
test('invalid provider and model override fail before any preparation', async t => {
  const f = fixture(t), a = { action: 'create', taskId: f.task, title: 'No side effects' };
  for (const provider of [null, '', false, [], {}, 'CLAUDE', 'claude/other-model']) await assert.rejects(f.run({ ...a, provider }), /provider/);
  await assert.rejects(f.run({ ...a, provider: 'claude', model: 'other' }), /fields/);
  assert.deepEqual(f.calls, []); assert.equal(f.creates(), 0);
  await f.run({ ...a, provider: 'claude', host: 'mini' });
  assert.equal(f.createdInputs[0].provider, 'claude'); assert.equal(f.createdInputs[0].host, 'mini');
});
test('lost send response retains receipt and a retry does not duplicate native input', async t => {
  const f = fixture(t); await f.run({ action: 'delegate', sessionId: f.id, generation: 1 });
  f.after = e => { if (e.method === 'ingress-send') throw Error('connection lost'); };
  const a = { action: 'send', sessionId: f.id, generation: 2, text: 'One instruction' };
  const first = await f.run(a); assert.equal(first.state, 'unconfirmed');
  f.after = undefined; assert.equal((await f.run(a)).messageId, first.messageId); assert.equal(f.sends(), 1);
});
test('wait reports permission attention, and generation change during delegation cannot acquire control', async t => {
  const f = fixture(t); await f.run({ action: 'delegate', sessionId: f.id, generation: 1 });
  const d = await f.run({ action: 'send', sessionId: f.id, generation: 2, text: 'Request a permission' });
  f.state.pending = 1;
  assert.equal((await f.run({ action: 'wait', sessionId: f.id, generation: 2, messageId: d.messageId })).needsAttention, true);
  f.state.pending = 0; f.control.takeover(f.id, 'Human control');
  f.after = e => { if (e.method === 'handback') f.control.takeover(f.id, 'Human wins the race'); };
  await assert.rejects(f.run({ action: 'delegate', sessionId: f.id, generation: 3 }), /revoked/);
  assert.equal(f.store.get(f.id).mode, 'human'); assert.equal(f.sends(), 1);
});
test('symlinked CLI actually executes and rejects malformed input before reading credentials', t => {
  const f = fixture(t), link = path.join(f.root, 'client.mjs');
  fs.symlinkSync(new URL('./client.mjs', import.meta.url).pathname, link);
  assert.throws(() => execFileSync(process.execPath, [link], { input: '!', stdio: ['pipe', 'pipe', 'pipe'] }), e => e.status === 1 && e.stderr.toString().includes('JSON'));
});
test('completion wakes exact conversation once; uncertain event delivery cannot be replayed', async t => {
  const f = fixture(t), input = { sessionId: f.id, generation: 2, messageId: randomUUID(), sessionKey: 'agent:main:orca-test' };
  const directory = path.join(f.root, 'watch'), notifications = [];
  const args = { input, directory, run: async () => ({ ended: true, outputObserved: true }), notify: async (key, text) => { notifications.push({ key, text }); return { acknowledged: true }; } };
  const first = await watchReceipt(args); assert.equal(first.state, 'wake-submitted');
  assert.equal((await watchReceipt(args)).state, 'existing-watch'); assert.equal(notifications.length, 1);
  assert.equal(notifications[0].key, input.sessionKey); assert.ok(notifications[0].text.includes(input.messageId));
  assert.equal(wakeTarget(input.sessionKey), input.sessionKey + ':heartbeat');
  assert.equal(wakeTarget(wakeTarget(input.sessionKey)), input.sessionKey + ':heartbeat');
  const other = { ...input, messageId: randomUUID() }; let attempts = 0;
  await assert.rejects(watchReceipt({ ...args, input: other, notify: async () => { attempts++; throw Error('response lost'); } }), /reconciliation/);
  assert.equal((await watchReceipt({ ...args, input: other })).state, 'existing-watch'); assert.equal(attempts, 1);
});
test('revoked delegation wakes an attention report without retrying input', async t => {
  const f = fixture(t); let text;
  await watchReceipt({ input: { sessionId: f.id, generation: 2, messageId: randomUUID(), sessionKey: 'agent:main:orca-test' }, directory: path.join(f.root, 'watch'), run: async () => { throw Error('Delegation revoked'); }, notify: async (_key, value) => { text = value; return {}; } });
  assert.ok(text.includes('wait-error')); assert.equal(f.sends(), 0);
});
test('conversation watch commits once and returns without a controller or model call', async t => {
  const f = fixture(t), input = { action: 'watch', sessionId: f.id, generation: 2, messageId: randomUUID(), sessionKey: 'agent:main:queued-test' };
  const first = await f.run(input), second = await f.make()(input);
  assert.equal(first.key, second.key); assert.equal(second.state, 'queued');
  const state = await f.run({ action: 'watches' });
  assert.equal(state.watches.length, 1); assert.equal(state.service.recentlySeen, false);
  assert.deepEqual(f.calls, []); assert.equal(f.sends(), 0);
});

async function supervisorCandidate(f, provider = 'codex') {
  const result = await f.run({ action: 'create', taskId: f.task, title: 'Persistent coordination', provider });
  return { action: 'supervise', sessionId: result.sessionId, generation: 1, maxWorkers: 2, reason: 'Coordinate two scoped persistent Codex workers' };
}
test('supervisor grant retains normal conversation binding and does not send work or expose tokens', async t => {
  const f = fixture(t), a = await supervisorCandidate(f), result = await f.run(a);
  assert.equal(result.state, 'supervisor-ready'); assert.equal(result.generation, 2);
  assert.equal(f.sends(), 0); assert.equal(JSON.stringify(result).includes('capability'), false);
  const groups = (await f.run({ action: 'supervisors' })).groups;
  assert.equal(groups[0].id, a.sessionId); assert.equal(groups[0].active, true); assert.equal(groups[0].maxWorkers, 2); assert.equal(groups[0].generation, 2); assert.equal(groups[0].mode, 'delegated');
  assert.equal((await f.run({ action: 'send', sessionId: a.sessionId, generation: 2, text: 'Inspect your saved group' })).state, 'delivered');
});
test('a capable Mini Claude supervisor promotes without a model instruction and takeover still wins', async t => {
  const f = fixture(t), a = await supervisorCandidate(f, 'claude'); f.nativeProvider = 'claude';
  const r = await f.run(a); assert.equal(r.state, 'supervisor-ready'); assert.equal(r.generation, 2);
  assert.equal(f.createdInputs[0].provider, 'claude'); assert.equal(f.sends(), 0); assert(!JSON.stringify(r).includes('capability'));
  f.control.takeover(a.sessionId, 'Human takes the Claude supervisor'); await assert.rejects(f.run(a));
  assert.equal(f.store.get(a.sessionId).mode, 'human'); assert.equal(f.sends(), 0);
});
test('non-Mini hosts and unknown providers cannot acquire supervisor authority', async t => {
  for (const host of ['macbook', 'future-host', null]) {
    const f = fixture(t), a = await supervisorCandidate(f, 'claude'); f.nativeProvider = 'claude'; f.control.native.project = s => ({ ...s, host });
    await assert.rejects(f.run(a), /Mini Claude or Codex/); assert.equal(f.store.get(a.sessionId).mode, 'human'); assert(!f.calls.includes('handback'));
  }
  for (const provider of [null, '', 'unknown']) {
    const f = fixture(t), a = await supervisorCandidate(f); f.nativeProvider = provider;
    await assert.rejects(f.run(a), /Mini Claude or Codex/); assert(!f.calls.includes('handback'));
  }
});
test('concurrent supervisor requests cannot rotate a role or consume more than one handback', async t => {
  const f = fixture(t), a = await supervisorCandidate(f);
  const results = await Promise.allSettled([f.run(a), f.make()(a)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(f.store.get(a.sessionId).generation, 2);
  const epoch = f.store.db.prepare('SELECT epoch FROM manager_grants WHERE supervisor=?').get(a.sessionId).epoch;
  await assert.rejects(f.run({ ...a, generation: 2 }));
  assert.equal(f.store.db.prepare('SELECT epoch FROM manager_grants WHERE supervisor=?').get(a.sessionId).epoch, epoch);
});
test('unsupported capability or provider, invalid limits and stale generations cannot promote', async t => {
  const f = fixture(t), a = await supervisorCandidate(f);
  for (const bad of [{ ...a, maxWorkers: 7 }, { ...a, generation: 5 }, { ...a, reason: 'short' }]) await assert.rejects(f.run(bad));
  f.nativeProvider = 'unknown'; await assert.rejects(f.run(a), /Mini Claude or Codex/); f.nativeProvider = 'codex';
  await assert.rejects(f.run({ ...a, sessionId: f.id }), /capability/);
  assert.equal(f.store.get(a.sessionId).mode, 'human'); assert.equal(f.sends(), 0);
});
test('lost grant response retains one inspectable role and cannot silently regrant after takeover', async t => {
  const f = fixture(t), a = await supervisorCandidate(f);
  f.after = e => { if (e.method === 'manager-grant') throw Error('Lost role response'); };
  await assert.rejects(f.run(a), /Lost role response/); f.after = undefined;
  assert.equal((await f.run({ action: 'supervisors' })).groups[0].active, true);
  await assert.rejects(f.run(a));
  f.control.takeover(a.sessionId, 'Human stops this organization');
  assert.equal((await f.run({ action: 'supervisors' })).groups[0].active, false);
  await assert.rejects(f.run({ ...a, generation: 3 }), /roles/);
  assert.equal(f.store.get(a.sessionId).mode, 'human'); assert.equal(f.sends(), 0);
});

test('latest supervisor output follows a retained event turn while old assignment result stays protected', async t => {
  const f = fixture(t), a = await supervisorCandidate(f); await f.run(a);
  const query = { action: 'supervisor-result', sessionId: a.sessionId, generation: 2 };
  const empty = await f.run(query); assert.equal(empty.available, false); assert.equal(empty.accepted, false);
  const first = await f.run({ action: 'send', sessionId: a.sessionId, generation: 2, text: 'Coordinate scoped work' });
  const eventId = randomUUID();
  await f.control.send({ sessionId: a.sessionId, messageId: eventId, text: 'Fixture owned worker event continuation' }, undefined, 2);
  await assert.rejects(f.run({ action: 'result', sessionId: a.sessionId, generation: 2, messageId: first.messageId }), /identity/);
  const latest = await f.run(query); assert.equal(latest.messageId, eventId); assert.equal(latest.outputPreview, 'actual fixture output'); assert.equal(latest.accepted, false);
  f.control.takeover(a.sessionId, 'Human interrupts current supervisor'); await assert.rejects(f.run(query), /active supervisor/);
});


test('installed profiles constrain supervisor provider and safely handle missing or foreign metadata', async t => {
  const f = fixture(t), id = randomUUID(), cwd = home + '/tasks/' + randomUUID();
  const row = { id, cwd, mode: 'human', generation: 1, task: f.task };
  const profilePath = `/Volumes/test-volume/openclaw/projects/orca-paseo-20260911/home/agents/${cwd.slice(1).replaceAll('/', '-')}/${id}.json`;
  const originalRead = fs.readFileSync; let profile = { title: 'Retained native title', provider: 'claude' };
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (file === '/Users/test-user/.openclaw/openclaw.json') return JSON.stringify({ plugins: { entries: { 'orca-command': { config: f.config } } } });
    if (file === profilePath) { if (!profile) throw Error('Missing profile'); return JSON.stringify(profile); }
    return originalRead(file, ...args);
  });
  const calls = [], rows = [row, { ...row, id: 'invalid' }, { ...row, cwd: '/unrelated/task' }];
  const run = installedConversation({ runtimeHome: f.root, send: async e => { calls.push(e.method); if (e.method === 'list') return rows; if (e.method === 'observe') return row; throw Error('Unexpected mutation'); } });
  const list = await run({ action: 'list' });
  assert.deepEqual(list.sessions.map(s => s.title), ['Retained native title', null, null]);
  profile.provider = 'unknown';
  await assert.rejects(run({ action: 'supervise', sessionId: id, generation: 1, maxWorkers: 2, reason: 'Bounded supervisor delegation' }), /Mini Claude or Codex session/);
  profile = null; assert.equal((await run({ action: 'list' })).sessions[0].title, null);
  assert.deepEqual(calls, ['list', 'observe', 'list']);
});

test('generated malformed supervision envelopes never reach credentials or dispatch', async () => {
  let sends = 0;
  const run = createConversation({ config: { accountId: 'default', conversationId: '123', senderId: '456', sessionId: '00000000-0000-1234-1234-000000002007', bindingsDir: '/unused' }, runtimeHome: '/nonexistent-orca-fuzz', send: async () => { sends++; throw Error('Unexpected dispatch'); } });
  const valid = { action: 'supervise', sessionId: '00000000-0000-1234-1234-000000002007', generation: 1, maxWorkers: 2, reason: 'Bounded generated delegation' };
  let seed = 0xA190;
  for (let i = 0; i < 2048; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const mutations = [
      { generation: -(seed + 1) }, { maxWorkers: 7 + seed },
      { sessionId: String(seed) + '/../../x' }, { reason: String.fromCharCode(0xD800 + seed % 1024) },
      { unexpected: seed }, { action: 'unknown-' + seed },
    ];
    await assert.rejects(run({ ...valid, ...mutations[i % mutations.length] }), /Invalid|allowance|reason/);
  }
  assert.equal(sends, 0);
});


test('supervision accepts documented limits and rejects malformed bounded values before any RPC', async t => {
  for (const [maxWorkers, length] of [[1, 12], [6, 2000]]) {
    const f = fixture(t), a = await supervisorCandidate(f);
    const start = f.calls.length;
    for (const bad of [{ maxWorkers: 1.5 }, { maxWorkers: 0 }, { maxWorkers: 7 }, { reason: 'a'.repeat(11) + '\uD800' }, { reason: 'a'.repeat(2001) }, { reason: 'a'.repeat(11) }]) {
      await assert.rejects(f.run({ ...a, ...bad }), /allowance|bounded delegation reason/);
      assert.equal(f.calls.length, start, 'invalid envelope must fail at the client boundary');
    }
    const result = await f.run({ ...a, maxWorkers, reason: 'a'.repeat(length) });
    assert.equal(result.state, 'supervisor-ready'); assert.equal(result.maxWorkers, maxWorkers);
  }
});
test('group assignment uses a stable explicit outcome identity and queues a separate durable group watch', async t => {
  const f = fixture(t), a = await supervisorCandidate(f); await f.run(a);
  const input = { action: 'send-group', sessionId: a.sessionId, generation: 2, text: 'Prepare a reviewed outcome', outcomeId: randomUUID() };
  const first = await f.run(input), duplicate = await f.make()(input);
  assert.equal(first.messageId, duplicate.messageId); assert.equal(first.outcomeId, input.outcomeId); assert.equal(f.sends(), 1);
  const d = f.store.delivery(first.messageId); assert.ok(JSON.parse(d.body).text.includes('ORCA_OUTCOME_READY:' + input.outcomeId));
  const watch = await f.run({ action: 'watch-group', sessionId: a.sessionId, generation: 2, messageId: first.messageId, outcomeId: input.outcomeId, sessionKey: 'agent:main:group-test' });
  assert.equal(watch.scope, 'group'); assert.equal(watch.outcomeId, input.outcomeId);
  f.control.takeover(a.sessionId, 'Human stops group work'); await assert.rejects(f.run(input));
});
test('group-ack uses current native evidence and durable watch instead of internal-event ingress provenance', async t => {
  const f=fixture(t), a=await supervisorCandidate(f);await f.run(a);
  const outcomeId=randomUUID(), sent=await f.run({action:'send-group',sessionId:a.sessionId,generation:2,text:'Review a bounded outcome',outcomeId});
  f.control.native.completion=async()=>({ended:true,outputObserved:true,outputPreview:'ORCA_OUTCOME_READY:'+outcomeId,outputEvidenceHash:'a'.repeat(64)});
  const {WatchQueue,processOne}=await import('./queue.mjs'),queue=new WatchQueue(path.join(f.root,'conversation-queue'));t.after(()=>queue.close());
  const input={sessionId:a.sessionId,generation:2,messageId:sent.messageId,outcomeId};const watch=await f.run({action:'watch-group',...input,sessionKey:'agent:main:group-ack'});
  await processOne(queue,f.run,async()=>({ok:true}));
  await assert.rejects(f.run({action:'group-ack',...input,watchKey:watch.key,outputEvidenceHash:'b'.repeat(64)}),/evidence/);
  assert.equal((await f.run({action:'group-ack',...input,watchKey:watch.key,outputEvidenceHash:'a'.repeat(64)})).handled,true);
  f.control.takeover(a.sessionId,'Human takes this group');await assert.rejects(f.run({action:'group-ack',...input,watchKey:watch.key,outputEvidenceHash:'a'.repeat(64)}));
});

async function savedTeam(f, supervisorProvider = 'codex', workerProvider = 'codex') {
  const a = await supervisorCandidate(f, supervisorProvider); f.providerOverrides = { [a.sessionId]: supervisorProvider }; await f.run(a);
  f.control.native.inspect = async id => ({ ...f.state, nativeId: id, humanAt: 0 });
  f.control.native.verifyNew = async (id, _messageId, taskId) => assert.equal(f.store.get(id).task, taskId);
  f.control.native.snapshot = async id => ({ id, cwd: f.store.get(id).cwd, labels: { owner: 'orca-control', task: f.task }, status: 'idle', pendingPermissions: [], lastPromptId: f.state.lastPromptId, lastUserAt: null });
  const grant = JSON.parse(fs.readFileSync(path.join(f.root, 'grants/manager', path.basename(f.store.get(a.sessionId).cwd) + '.json')));
  const worker = await f.control.manager.create({ sessionId: a.sessionId, messageId: randomUUID(), provider: workerProvider, title: 'Saved author' }, grant.capability);
  f.providerOverrides[worker.sessionId] = workerProvider;
  for (const id of [a.sessionId, worker.sessionId]) f.control.takeover(id, 'Owner takes control of the team');
  return { action: 'resume-group', sessionId: a.sessionId, generation: 3, messageId: randomUUID(), reason: 'Owner asks to continue with the same saved team', workers: [{ sessionId: worker.sessionId, generation: 3 }] };
}
test('normal chat resumes exact saved group and recovers lost response without prompt, new session or token disclosure', async t => {
  const f = fixture(t), a = await savedTeam(f), count = f.creates();
  f.after = e => { if (e.method === 'manager-resume') throw Error('Lost handback response'); };
  await assert.rejects(f.run(a), /Lost handback/); f.after = undefined;
  assert.equal(f.store.get(a.sessionId).generation, 4); assert.equal(f.sends(), 0);
  const resumed = await f.make()(a); assert.equal(resumed.state, 'group-resumed'); assert.equal(resumed.generation, 4);
  assert.equal(JSON.stringify(resumed).includes('capability'), false);
  assert.deepEqual(await f.run(a), resumed); assert.equal(f.creates(), count); assert.equal(f.sends(), 0);
  const sent = await f.run({ action: 'send-group', sessionId: a.sessionId, generation: 4, outcomeId: randomUUID(), text: 'One explicitly new scoped revision' });
  assert.equal(sent.state, 'delivered'); assert.equal(f.sends(), 1);
  f.control.takeover(a.sessionId, 'Owner interrupts the resumed team');
  await assert.rejects(f.run(a), /revoked/); assert.equal(f.sends(), 1);
});
test('mixed and Claude-only saved Mini teams resume exact receipts without replacing sessions', async t => {
  for (const providers of [['claude', 'codex'], ['codex', 'claude'], ['claude', 'claude']]) {
    const f = fixture(t), a = await savedTeam(f, ...providers), count = f.creates();
    const r = await f.run(a); assert.equal(r.state, 'group-resumed'); assert.equal(r.generation, 4);
    assert.deepEqual(await f.make()(a), r); assert.equal(f.creates(), count); assert.equal(f.sends(), 0);
    assert.deepEqual(f.createdInputs.map(x => x.provider), providers);
    assert(!JSON.stringify(r).includes('capability'));
  }
});
test('an unsupported worker host refuses whole-team resumption before handback', async t => {
  const f = fixture(t), a = await savedTeam(f, 'claude', 'codex');
  f.control.native.project = s => s.id === a.workers[0].sessionId ? { ...s, host: 'unknown-host' } : s;
  await assert.rejects(f.run(a), /known Mini/); assert(!f.calls.includes('manager-resume')); assert.equal(f.store.get(a.sessionId).generation, 3);
});
test('incomplete, stale, foreign-provider and unsafe team handbacks never acquire a binding', async t => {
  const f = fixture(t), a = await savedTeam(f);
  for (const workers of [[], [a.workers[0], a.workers[0]], [{...a.workers[0],generation:0}], [{...a.workers[0],extra:true}]]) await assert.rejects(f.run({...a,workers}));
  f.providerOverrides[a.sessionId]='unknown'; await assert.rejects(f.run(a), /known Mini/); f.providerOverrides[a.sessionId]='codex';
  await assert.rejects(f.run({...a,generation:2}), /unchanged/); assert.equal(f.store.get(a.sessionId).generation,3);
  f.after=e=>{if(e.method==='manager-resume')f.control.takeover(a.sessionId,'Owner intervenes before binding')};
  await assert.rejects(f.run(a), /revoked/); assert.equal(f.sends(),0);
});

test('normal conversation can inspect and set a durable task allowance without sending a prompt', async t => {
  const f = fixture(t), initial = await f.run({ action: 'allowance', taskId: f.task }); assert.equal(initial.revision, 0);
  const request = { action: 'set-allowance', taskId: f.task, expectedRevision: 0, maxInstructions: 0, reason: 'Pause new instructions for this task' };
  assert.equal((await f.run(request)).remaining, 0); assert.equal((await f.make()(request)).revision, 1); assert.equal(f.sends(), 0);
  assert.equal((await f.run({ action: 'observe', sessionId: f.id })).allowance.exhausted, true);
  await f.run({ action: 'delegate', sessionId: f.id, generation: 1 });
  const input = { action: 'send', sessionId: f.id, generation: 2, text: 'One explicitly bounded instruction' }, paused = await f.run(input);
  assert.equal(paused.state, 'paused'); assert.equal(f.sends(), 0); assert.equal(f.store.delivery(paused.messageId), null);
  assert.equal((await f.make()(input)).messageId, paused.messageId);
  await assert.rejects(f.run({ ...request, maxInstructions: 1 }), /changed/);
  await f.run({ ...request, expectedRevision: 1, maxInstructions: 1 });
  assert.equal((await f.run(input)).messageId, paused.messageId); assert.equal(f.sends(), 1);
});

test('normal conversation recovers an exact unresolved creation and refuses a second recovery without sending work', async t => {
  const f=fixture(t), id=randomUUID(), cwd=path.join(f.root,'retained'), bodies=[];let attempts=0;
  f.control.native.create=async a=>{bodies.push(a);attempts++;if(attempts===1)throw Error('Lost creation response');return{id,cwd};};
  const first=await f.run({action:'create',taskId:f.task,title:'Retained Claude creation',provider:'claude'});assert.equal(first.state,'uncertain');
  const recovered=await f.run({action:'recover',messageId:first.messageId});assert.equal(recovered.sessionId,id);assert.equal(recovered.state,'delivered');assert.equal(recovered.result.recovered,true);
  assert.equal(bodies[0].provider,'claude');assert.deepEqual(bodies[1],bodies[0]);
  await assert.rejects(f.run({action:'recover',messageId:first.messageId}),/unresolved/);assert.equal(attempts,2);assert.equal(f.sends(),0);
});
test('explicit worker provider preserves legacy bytes and exact uncertain retry identities',async t=>{
 for(const workerProvider of [undefined,'claude','codex','mixed']){
  const f=fixture(t),a=await supervisorCandidate(f);await f.run(a);
  const input={action:'send-group',sessionId:a.sessionId,generation:2,text:'Review this work',outcomeId:randomUUID(),...(workerProvider?{workerProvider}:{})};
  f.after=e=>{if(e.method==='ingress-send')throw Error('response lost');};
  const first=await f.run(input);assert.equal(first.state,'unconfirmed');f.after=undefined;
  const second=await f.make()(input);assert.equal(second.messageId,first.messageId);assert.equal(f.sends(),1);
  const text=JSON.parse(f.store.delivery(first.messageId).body).text;
  const workers=workerProvider==='mixed'?'persistent Claude or Codex workers as requested':workerProvider?'persistent '+(workerProvider==='claude'?'Claude':'Codex')+' workers as requested':'persistent Codex workers as needed';
  assert.equal(text,input.text+'\n\nGroup outcome '+input.outcomeId+': use '+workers+', inspect and revise their actual work, consume your worker events, then end your final response with the exact line ORCA_OUTCOME_READY:'+input.outcomeId+' only when this assigned outcome is ready for owner review. Do not emit it while merely waiting for workers. The marker is not independent acceptance.');
  assert.equal(second.workerProvider,workerProvider);
 }
 const f=fixture(t);for(const workerProvider of [null,'other',{},[]])await assert.rejects(f.run({action:'send-group',sessionId:f.id,generation:2,text:'Work',outcomeId:randomUUID(),workerProvider}),/provider/);
 assert.equal(f.sends(),0);assert.equal(f.calls.length,0);
});
test('provider-aware group status resolves actual installed-style metadata before declaring ready',async t=>{
 const f=fixture(t),a=await savedTeam(f,'claude','claude');await f.run(a);
 const outcomeId=randomUUID(),sent=await f.run({action:'send-group',sessionId:a.sessionId,generation:4,text:'Review existing team',outcomeId,workerProvider:'claude'});
 f.control.native.completion=async()=>({ended:true,outputObserved:true,outputPreview:'ORCA_OUTCOME_READY:'+outcomeId,outputEvidenceHash:'a'.repeat(64)});
 f.control.native.inspect=async id=>({...f.state,nativeId:id,lastPromptId:id===a.sessionId?sent.messageId:null,humanAt:0});
 const input={action:'group-status',sessionId:a.sessionId,generation:4,messageId:sent.messageId,outcomeId,workerProvider:'claude'};
 assert.equal((await f.run(input)).state,'group-ready');
 f.providerOverrides[a.workers[0].sessionId]='codex';assert.equal((await f.run(input)).reason,'worker-provider-mismatch');
});
