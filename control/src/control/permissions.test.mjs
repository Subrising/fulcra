import { FENCE_PROTOCOL } from './native-fence.mjs';
import { nativeIdentity } from './native-identity.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ControlStore } from './store.mjs';
import { Controller } from './controller.mjs';
import { Events } from './events.mjs';
import { Manager } from './manager.mjs';
import { Permissions } from './permissions.mjs';
import { evaluatePermission, verifyPermissionOutput } from './permission-policy.mjs';
import { admitPermission, permissionGuard, permissionProjection, BOOT } from '../../tools/legacy-host-admission.fixture.mjs';
import { permissionResultFor } from './permission-result.mjs';
import { PROGRAMME, COMPANY } from './authority.mjs';
import { requireUnpinnedAdmissionGuard } from './admission-guard-precondition.mjs';
requireUnpinnedAdmissionGuard(); // Fails loudly when the working guard is pinned; see that module.
function request(root, name = 'Write', input = { content: 'first draft' }) { return { id: randomUUID(), provider: 'claude', kind: 'tool', name, input: { file_path: root + '/notes.md', ...input }, metadata: { toolUseId: randomUUID() } }; }
async function fixture(t, linked = false) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orca-permissions-'))), file = base + '/journal.sqlite', store = new ControlStore(file), snapshots = new Map(), calls = [], used = new Set(); let clock = Date.now();
  const s = randomUUID(), w = randomUUID();
  for (const id of [s, w]) { fs.mkdirSync(base + '/' + id); store.created(id, PROGRAMME, base + '/' + id); snapshots.set(id, { id, provider: 'claude', cwd: base + '/' + id, status: 'idle', pendingPermissions: [], runtimeInfo: { sessionId: randomUUID() }, lastPromptId: null, lastUserMessageAt: null }); }
  const native = {
    inspect: async id => { const a = snapshots.get(id); return { fenceProtocol: FENCE_PROTOCOL, saturated: false, boot: BOOT, status: a.status, pending: a.pendingPermissions.length, nativeId: nativeIdentity(a).nativeId, nativeIdentity: nativeIdentity(a), lastPromptId: a.lastPromptId, lastUserAt: a.lastUserMessageAt, humanAt: 0, timelineCursor: { epoch: 'timeline', seq: 0 } }; },
    snapshot: async id => snapshots.get(id),
    send: async (id, _text, messageId) => Object.assign(snapshots.get(id), { status: 'running', lastPromptId: messageId, lastUserMessageAt: new Date().toISOString() }),
    permissionResult: async () => ({ state: 'completed', callId: 'test', sequence: 2 }),
    permission: async (id, intentId) => { const a = snapshots.get(id), db = new DatabaseSync(file, { readOnly: true }); try { const rid = admitPermission(db, { ...a, lastUserMessageAt: new Date(a.lastUserMessageAt), pendingPermissions: new Map(a.pendingPermissions.map(p => [p.id, p])) }, intentId, { behavior: 'allow' }, used); calls.push(rid); return { agentId: id, requestId: 'orca-permission:' + intentId, resolution: { behavior: 'allow' } }; } finally { db.close(); } },
  };
  const control = new Controller({ store, native, authority: async () => ({ id: PROGRAMME, companyId: COMPANY, assigneeUserId: 'local-board', status: 'in_progress' }) });
  control.events = new Events(control, base + '/inbox'); control.manager = new Manager(control, base + '/manager'); control.permissions = new Permissions(control, base, () => clock);
  t.after(() => { store.close(); fs.rmSync(base, { recursive: true, force: true }); });
  const sg = await control.handback(s, 'Delegate supervised permission fixture'), wg = await control.handback(w, 'Delegate worker permission fixture');
  if (linked) {
    await control.manager.grant({ sessionId: s, expectedGeneration: sg.generation, capability: sg.capability, maxWorkers: 2, reason: 'Supervise a bounded shared permission pool' });
    const epoch = store.db.prepare('SELECT epoch FROM manager_grants').get().epoch;
    store.db.prepare('INSERT INTO manager_workers VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(), s, epoch, '{}', w, wg.generation, 'attached', randomUUID());
    await control.events.attach({ workerId: w, supervisorId: s, capability: sg.capability, reason: 'Own the worker and independent review workflow' });
  }
  const grant = id => control.permissions.grant({ sessionId: id, expectedGeneration: store.get(id).generation, reason: 'Allow bounded routine edits for this owned task' });
  if (linked) { await grant(s); await control.permissions.inherit(w, s); } else await grant(w);
  const assign = async id => { const token = id === s ? sg.capability : wg.capability; await control.send({ sessionId: id, messageId: randomUUID(), text: 'Produce an owned file and verify its content' }, token); };
  await assign(w);
  const prompt = (id = w, name, input) => { const p = request(store.get(id).cwd, name, input); snapshots.get(id).pendingPermissions = [p]; return p; };
  const intent = () => store.db.prepare('SELECT * FROM permission_intents ORDER BY rowid DESC LIMIT 1').get();
  return { base, file, store, control, native, s, w, snapshots, calls, used, grant, assign, prompt, intent, advance: ms => { clock += ms; } };
}
test('policy supports arbitrary owned filenames and exact edits while refusing unsafe filesystem and input shapes', async t => {
  const f = await fixture(t), root = f.store.get(f.w).cwd;
  const p = request(root, 'Write', { file_path: root + '/product-options.txt', content: 'A$&B' });
  let proof = evaluatePermission(p, root, f.base); fs.writeFileSync(p.input.file_path, p.input.content); assert.equal(verifyPermissionOutput(proof).bytes, 4);
  const edit = request(root, 'Edit', { file_path: p.input.file_path, old_string: '$&', new_string: '$`$&' }); proof = evaluatePermission(edit, root, f.base); fs.writeFileSync(p.input.file_path, 'A$`$&B'); assert.equal(verifyPermissionOutput(proof).bytes, 6);
  for (const input of [{ file_path: root + '/.env' }, { file_path: root + '/../outside.txt' }, { extra: true }, { content: 'x'.repeat(262145) }]) assert.throws(() => evaluatePermission({ ...p, input: { ...p.input, ...input } }, root, f.base));
  assert.throws(() => evaluatePermission({ ...edit, input: { ...edit.input, replace_all: true } }, root, f.base));
  fs.symlinkSync(p.input.file_path, root + '/link'); assert.throws(() => evaluatePermission({ ...p, input: { ...p.input, file_path: root + '/link' } }, root, f.base));
  fs.linkSync(p.input.file_path, root + '/hard'); assert.throws(() => evaluatePermission(p, root, f.base));
});
test('two distinct native requests resume independently; duplicate snapshots never resend', async t => {
  const f = await fixture(t), one = f.prompt(); await f.control.permissions.reconcile(f.w); await f.control.permissions.reconcile(f.w); assert.deepEqual(f.calls, [one.id]);
  fs.writeFileSync(one.input.file_path, one.input.content); await f.control.permissions.verifyPending(); assert.equal(f.intent().state, 'verified'); assert.equal(JSON.parse(f.intent().result).response.receipt.requestId, 'orca-permission:' + f.intent().id);
  const two = f.prompt(f.w, 'Edit', { old_string: 'first', new_string: 'reviewed' }); await f.control.permissions.reconcile(f.w); assert.deepEqual(f.calls, [one.id, two.id]);
  fs.writeFileSync(one.input.file_path, 'reviewed draft'); await f.control.permissions.verifyPending(); assert.equal(f.control.permissions.status(f.w).remaining, 98);
});
test('unsupported tool and changed request body remain distinct escalations without native responses', async t => {
  const f = await fixture(t), p = f.prompt(f.w, 'Bash', { command: 'outside action' }); await f.control.permissions.reconcile(f.w); p.input.command = 'different action'; await f.control.permissions.reconcile(f.w); await f.control.permissions.reconcile(f.w);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM permission_intents').get().n, 2); assert.equal(f.calls.length, 0); assert.equal(f.control.permissions.status(f.w).remaining, 100);
});
test('native one-shot guard stays read-only while the controller holds the WAL write lock', async t => {
  const f = await fixture(t); f.prompt(); const original = f.native.permission;
  f.native.permission = async (...args) => { f.store.db.exec('BEGIN IMMEDIATE'); try { const receipt = await original(...args); await assert.rejects(original(...args), /duplicate/); return receipt; } finally { f.store.db.exec('ROLLBACK'); } };
  await f.control.permissions.reconcile(f.w); assert.equal(f.calls.length, 1); assert.equal(f.intent().state, 'acknowledged');
});
test('human permission action before admission revokes the native generation with no journal dependency', async t => {
  const f = await fixture(t), p = f.prompt(), original = f.native.permission;
  f.native.permission = async (...args) => { permissionGuard({ id: f.w }, p.id, { behavior: 'deny' }); return original(...args); };
  await f.control.permissions.reconcile(f.w); assert.equal(f.calls.length, 0); assert.match(JSON.parse(f.intent().result).note, /authority/);
});
test('changed actual request and daemon boot refuse before the provider', async t => {
  for (const mutation of ['request', 'boot', 'generation']) {
    const f = await fixture(t), p = f.prompt(), original = f.native.permission;
    f.native.permission = async (...args) => { if (mutation === 'request') p.input.content = 'changed after policy'; else f.store.db.prepare('UPDATE sessions SET ' + (mutation === 'boot' ? "boot='different'" : 'generation=generation+1') + ' WHERE id=?').run(f.w); return original(...args); };
    await f.control.permissions.reconcile(f.w); assert.equal(f.calls.length, 0);
  }
});
test('lost native reply survives controller restart and never repeats the response', async t => {
  const f = await fixture(t); f.prompt(); const original = f.native.permission;
  f.native.permission = async (...args) => { await original(...args); throw Error('Lost native reply'); }; await f.control.permissions.reconcile(f.w);
  assert.equal(f.intent().state, 'uncertain'); f.control.permissions = new Permissions(f.control, f.base); await f.control.permissions.reconcile(f.w); assert.equal(f.calls.length, 1);
});
test('inherited workers share the root quota and root revocation defeats an in-flight intent', async t => {
  const f = await fixture(t, true); const p = f.prompt(); await f.control.permissions.reconcile(f.w); assert.equal(f.calls.length, 1); assert.equal(f.control.permissions.status(f.s).remaining, 99);
  fs.writeFileSync(p.input.file_path, p.input.content); await f.control.permissions.verifyPending(); f.prompt(); const original = f.native.permission;
  f.native.permission = async (...args) => { f.control.permissions.revoke({ sessionId: f.s, expectedGeneration: f.store.get(f.s).generation, reason: 'Operator revokes the entire shared routine pool' }); return original(...args); };
  await f.control.permissions.reconcile(f.w); assert.equal(f.calls.length, 1); assert.equal(f.control.permissions.status(f.w).active, false);
});
test('delayed tool blocks the shared pool until the bounded deadline and produces an incident', async t => {
  const f = await fixture(t, true); f.prompt(); await f.control.permissions.reconcile(f.w); await f.assign(f.s); f.prompt(f.s); f.native.permissionResult = async () => ({ state: 'pending' });
  await f.control.permissions.verifyPending(); await f.control.permissions.reconcile(f.s); assert.equal(f.calls.length, 1); assert.equal(f.control.permissions.status(f.s).pending.length, 1);
  f.advance(120001); await f.control.permissions.verifyPending(); assert.equal(f.intent().state, 'incident'); assert.equal(f.control.permissions.status(f.s).active, false); assert.equal(f.store.db.prepare("SELECT count(*) n FROM event_inbox WHERE kind='permission-incident'").get().n, 1);
});
test('post-approval symlink swap is detected and revokes the shared grant', async t => {
  const f = await fixture(t, true), p = f.prompt(); await f.control.permissions.reconcile(f.w); const outside = f.base + '/outside.txt'; fs.writeFileSync(outside, 'untouched'); fs.symlinkSync(outside, p.input.file_path);
  await f.control.permissions.verifyPending(); assert.equal(f.intent().state, 'incident'); assert.equal(f.control.permissions.status(f.s).active, false); assert.equal(fs.readFileSync(outside, 'utf8'), 'untouched');
});
test('cancelled tool and missing terminal evidence produce visible bounded failures', async t => {
  const f = await fixture(t); f.prompt(); await f.control.permissions.reconcile(f.w); f.native.permissionResult = async () => ({ state: 'canceled' }); await f.control.permissions.verifyPending(); assert.equal(f.intent().state, 'incident'); assert.equal(f.control.permissions.status(f.w).active, false);
});
test('tool result reader requires exact call identity and timeline continuity', async () => {
  const cursor = { epoch: 'a', seq: 1 }, agent = { timeline: { refetch: async () => ({ epoch: 'a', entries: [{ seqEnd: 2, item: { type: 'tool_call', callId: 'other', status: 'completed' } }, { seqEnd: 3, item: { type: 'tool_call', callId: 'ours', status: 'completed' } }], hasNewer: false }) } };
  assert.equal((await permissionResultFor(agent, 'ours', cursor)).sequence, 3);
  agent.timeline.refetch = async () => ({ epoch: 'changed' }); await assert.rejects(permissionResultFor(agent, 'ours', cursor), /continuity/);
});
test('ordinary delegated credentials cannot grant or revoke routine authority', async t => {
  const f = await fixture(t), { rpc } = await import('./rpc.mjs'), dispatch = rpc(f.control, 'operator');
  for (const method of ['permissions-grant', 'permissions-revoke', 'permissions-status']) await assert.rejects(dispatch({ method, capability: 'worker' }), /Operator/);
  const g = f.control.permissions.grantRow(f.w); await f.grant(f.w); assert.equal(f.control.permissions.grantRow(f.w).epoch, g.epoch);
});
test('shared pool exhaustion, verification waits and parent takeover never silently dispatch more tools', async t => {
  const f = await fixture(t, true), p = f.prompt(); await f.control.permissions.reconcile(f.w);
  assert.equal(f.control.permissions.routineWaiting(f.w, p), true);
  fs.writeFileSync(p.input.file_path, p.input.content); await f.control.permissions.verifyPending();
  const pool = f.control.permissions.grantRow(f.s).epoch;
  for (let n = 0; n < 99; n++) f.store.db.prepare("INSERT INTO permission_intents VALUES (?,?,?,?,'refused','{}','{}',0)").run(randomUUID(), randomUUID(), f.s, pool);
  f.prompt(); await f.control.permissions.reconcile(f.w); assert.equal(f.calls.length, 1); assert.equal(f.control.permissions.status(f.w).remaining, 0); assert.equal(f.control.permissions.routineWaiting(f.w, p), false);
  f.control.takeover(f.s, 'Human takes the supervisor back'); assert.equal(f.control.permissions.status(f.w).active, false);
});
test('an uncommitted native-response intent becomes uncertain when the controller reopens', async t => {
  const f = await fixture(t); f.prompt(); f.native.permission = async () => { throw Error('Process dies before response'); }; await f.control.permissions.reconcile(f.w);
  f.store.db.prepare("UPDATE permission_intents SET state='intent'").run(); f.control.permissions = new Permissions(f.control, f.base); assert.equal(f.intent().state, 'uncertain'); await f.control.permissions.reconcile(f.w); assert.equal(f.calls.length, 0);
});
test('lost reply is resolved by actual tool evidence, allowing a different prompt without replay', async t => {
  const f = await fixture(t, true), first = f.prompt(), original = f.native.permission;
  f.native.permission = async (...args) => { await original(...args); throw Error('reply lost'); }; await f.control.permissions.reconcile(f.w); assert.equal(f.intent().state, 'uncertain');
  fs.writeFileSync(first.input.file_path, first.input.content); await f.control.permissions.verifyPending(); assert.equal(f.intent().state, 'verified'); assert.match(JSON.parse(f.intent().result).response.note, /reply lost/);
  f.native.permission = original; const second = f.prompt(f.w, 'Edit', { old_string: 'first', new_string: 'second' }); await f.control.permissions.reconcile(f.w); assert.deepEqual(f.calls, [first.id, second.id]);
});
test('reopened uncertainty has a bounded incident deadline and wakes its supervisor', async t => {
  const f = await fixture(t, true); f.prompt(); f.native.permission = async () => undefined; await f.control.permissions.reconcile(f.w); assert.equal(f.intent().state, 'uncertain');
  f.native.permissionResult = async () => ({ state: 'pending', caughtUp: true }); f.advance(120001); await f.control.permissions.verifyPending();
  assert.equal(f.intent().state, 'incident'); assert.equal(f.control.permissions.status(f.s).active, false); assert.equal(f.store.db.prepare("SELECT count(*) n FROM event_inbox WHERE kind='permission-incident'").get().n, 1);
});
test('inheritance failure leaves a worker usable without routine authority; journal capacity is explicit', async t => {
  const f = await fixture(t, true); f.store.db.prepare('DELETE FROM permission_grants WHERE session=?').run(f.w);
  // Retained REVOKED history must not occupy the bound. This fixture used to assert the opposite, which is
  // the defect: on the live journal 21 live + 11 revoked rows reached 32 and no session could ever be
  // granted again, because revoke only sets revoked=1 and capacity counted every row ever written.
  for (let n = 0; n < 31; n++) f.store.db.prepare('INSERT INTO permission_grants VALUES (?,1,?,?,?,1,?)').run(randomUUID(), randomUUID(), randomUUID(), randomUUID(), 'retained revoked fixture');
  const reclaimed = await f.control.permissions.inherit(f.w, f.s);
  assert.equal(reclaimed.active, true, 'revoked history does not consume live capacity');
  assert.equal(reclaimed.capacity.total, 33, 'and the history is still all there');
  f.store.db.prepare('DELETE FROM permission_grants WHERE session=?').run(f.w);

  // LIVE grants do occupy it. Each row points at a session that is actually delegated at that generation,
  // which is the only state in which a grant can authorize anything.
  for (let n = 0; n < 31; n++) {
    const id = randomUUID(); fs.mkdirSync(f.base + '/' + id);
    f.store.db.prepare("INSERT INTO sessions VALUES (?,?,?,'delegated',1,NULL,NULL,NULL,NULL,NULL,NULL)").run(id, PROGRAMME, f.base + '/' + id);
    f.store.db.prepare('INSERT INTO permission_grants VALUES (?,1,?,?,?,0,?)').run(id, randomUUID(), id, randomUUID(), 'live grant fixture');
  }
  const result = await f.control.permissions.inherit(f.w, f.s); assert.equal(result.active, false); assert.match(result.reason, /capacity/); assert.equal(f.control.permissions.grantRow(f.w), undefined); assert.equal(f.store.get(f.w).mode, 'delegated');
  for (let n = 0; n < 1000; n++) f.store.db.prepare("INSERT INTO permission_intents VALUES (?,?,?,?,'escalated','{}','{}',0)").run(randomUUID(), randomUUID(), f.s, randomUUID());
  assert.equal(f.control.permissions.status(f.s).active, false); assert.match(f.control.permissions.status(f.s).reason, /capacity/);
});
test('native and wire permission projections match the source-built host projection', async t => {
  const f = await fixture(t), raw = f.prompt(); raw.suggestions = [{}, { type: 'addRules', unused: {}, rules: [] }]; raw.metadata.extra = {}; raw.metadata.at = new Date('2026-09-12T00:00:00Z');
  const { toAgentPayload } = await import('@fulcra/test-host');
  const a = { ...f.snapshots.get(f.w), config: {}, capabilities: {}, availableModes: [], createdAt: new Date(), updatedAt: new Date(), lastUserMessageAt: null, pendingPermissions: new Map([[raw.id, raw]]), attention: { requiresAttention: false } };
  const wire = JSON.parse(JSON.stringify(toAgentPayload(a))).pendingPermissions[0];
  assert.deepEqual(JSON.parse(JSON.stringify(permissionProjection(raw))), wire);
  f.native.snapshot = async id => ({ ...f.snapshots.get(id), pendingPermissions: [wire] }); await f.control.permissions.reconcile(f.w); assert.equal(f.intent().state, 'acknowledged');
});
test('real SDK event subscription gates responses, survives reconnect, and preserves correlated receipts', async () => {
  const { DaemonClient } = await import('./client-sdk.mjs');
  const { permissionChannel } = await import('./native.mjs');
  for (const refused of [false, true]) {
    const daemon = new DaemonClient({ clientId: randomUUID(), clientType: 'cli', url: 'ws://127.0.0.1:1' }), agentId = randomUUID(), requestId = 'orca-permission:' + randomUUID(), sent = []; let subscription;
    daemon.connectionState = { status: 'connected' }; daemon.lastServerInfoMessage = { features: { explicitEventSubscriptions: true } };
    daemon.transport = { close() {}, send(frame) { const m = JSON.parse(frame).message; sent.push(m); if (m.type === 'session.events.set_subscription.request') subscription = m; else if (m.type === 'agent_permission_response') {
      assert.ok(subscription.events.includes('agent_permission_resolved'));
      daemon.deliverSessionMessage({ type: 'agent_permission_resolved', payload: { agentId, requestId: randomUUID(), resolution: { behavior: 'allow' } } });
      daemon.deliverSessionMessage(refused ? { type: 'rpc_error', payload: { requestId, code: 'handler_error', error: 'Request failed: Orca native permission refused: changed authority' } } : { type: 'agent_permission_resolved', payload: { agentId, requestId, resolution: { behavior: 'allow' } } });
    } } };
    daemon.owned.restore(daemon.lastServerInfoMessage); // Simulate the source SDK handshake on the fake transport.
    const channel = permissionChannel(daemon, 20); await assert.rejects(channel.ready(), /not acknowledged/); assert.equal(sent.length, 1); assert.ok(subscription.events.includes('agent_permission_resolved'));
    daemon.deliverSessionMessage({ type: 'session.events.set_subscription.response', payload: { requestId: subscription.requestId } }); await channel.ready();
    const reply = daemon.respondToPermissionAndWait(agentId, requestId, { behavior: 'allow' }); if (refused) await assert.rejects(reply, /Orca native permission refused/); else assert.equal((await reply).requestId, requestId);
    daemon.owned.disconnected(); daemon.updateConnectionState({ status: 'disconnected' }); await assert.rejects(channel.ready(), /not acknowledged/); daemon.connectionState = { status: 'connected' }; daemon.owned.restore(daemon.lastServerInfoMessage);
    daemon.deliverSessionMessage({ type: 'session.events.set_subscription.response', payload: { requestId: subscription.requestId } }); await channel.ready(); await daemon.close(); await channel.close();
  }
});
test('first-turn persistence identity survives runtime metadata population across two verified permissions', async t => {
  const f = await fixture(t), a = f.snapshots.get(f.w), id = a.runtimeInfo.sessionId;
  a.runtimeInfo.sessionId = null; a.persistence = { provider: a.provider, sessionId: id, metadata: { cwd: a.cwd } };
  const one = f.prompt(); await f.control.permissions.reconcile(f.w);
  const body = JSON.parse(f.intent().body); assert.equal(body.nativeId, id); assert.equal(body.nativeIdentity.source, 'persistence'); assert.equal(body.nativeIdentity.runtimeId, null);
  a.runtimeInfo.sessionId = id; fs.writeFileSync(one.input.file_path, one.input.content); await f.control.permissions.verifyPending(); assert.equal(f.intent().state, 'verified');
  const two = f.prompt(f.w, 'Edit', { old_string: 'first', new_string: 'reviewed' }); await f.control.permissions.reconcile(f.w); assert.equal(JSON.parse(f.intent().body).nativeIdentity.source, 'both');
  fs.writeFileSync(one.input.file_path, 'reviewed draft'); await f.control.permissions.verifyPending(); assert.equal(f.intent().state, 'verified'); assert.deepEqual(f.calls, [one.id, two.id]); assert.equal(f.control.permissions.status(f.w).remaining, 98);
});
test('unknown or conflicting native identities cannot approve while inspection and human takeover remain usable', async t => {
  for (const conflict of [false, true]) {
    const f = await fixture(t), a = f.snapshots.get(f.w);
    if (conflict) a.persistence = { provider: a.provider, sessionId: randomUUID(), metadata: { cwd: a.cwd } }; else a.runtimeInfo.sessionId = null;
    f.prompt(); await f.control.permissions.reconcile(f.w); assert.equal(f.calls.length, 0); assert.equal(f.intent(), undefined);
    assert.equal((await f.control.inspect(f.w)).id, f.w); f.control.takeover(f.w, 'Take control despite unresolved native metadata'); assert.equal(f.store.get(f.w).mode, 'human');
  }
});
test('actual resolved native identity changes still revoke verification and event conflicts never accept completion', async t => {
  const f = await fixture(t, true), a = f.snapshots.get(f.w), one = f.prompt(); await f.control.permissions.reconcile(f.w);
  fs.writeFileSync(one.input.file_path, one.input.content); a.persistence = { provider: a.provider, sessionId: randomUUID(), metadata: { cwd: a.cwd } };
  await f.control.permissions.verifyPending(); assert.equal(f.intent().state, 'incident'); assert.equal(f.control.permissions.status(f.w).active, false);
  await f.control.events.reconcile(f.w); assert.match(f.store.db.prepare('SELECT reason FROM event_faults WHERE worker=?').get(f.w).reason, /identities conflict/);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM event_inbox WHERE worker=? AND kind='turn-ended'").get(f.w).n, 0);
});
test('only a bounded root artifact declaration is routine, with unchanged filesystem fences', async t => {
  const f = await fixture(t), root = f.store.get(f.w).cwd, item = { path: 'note.md', sha256: 'a'.repeat(64) };
  const manifest = files => JSON.stringify({ version: 1, files });
  const p = request(root, 'Write', { file_path: root + '/.orca-artifacts.json', content: manifest([item]) });
  const check = content => evaluatePermission({ ...p, input: { ...p.input, content } }, root, f.base);
  const proof = check(p.input.content); fs.writeFileSync(p.input.file_path, p.input.content); assert.equal(verifyPermissionOutput(proof).sha256, proof.expectedHash);
  for (const content of ['null', '{}', '{', manifest([]), manifest(Array(9).fill(item)), JSON.stringify({ version: true, files: [item] }), JSON.stringify({ version: 1, files: [item], extra: true }), manifest([{ ...item, extra: true }]), manifest([item, { ...item, path: 'NOTE.md' }]), ...['../note.md', '.env', 'a/b', '/outside', 'note.md\n', 'x'.repeat(121)].map(path => manifest([{ ...item, path }])), ...['A'.repeat(64), 'a'.repeat(63), 'a'.repeat(64)+'\n', null].map(sha256 => manifest([{ ...item, sha256 }])), p.input.content + ' '.repeat(4097)]) assert.throws(() => check(content));
  assert.doesNotThrow(() => check(p.input.content.padEnd(4096, ' ')));
  assert.doesNotThrow(() => check(manifest(Array.from({ length: 8 }, (_, i) => ({ ...item, path: String(i) + 'x'.repeat(119) })))));
  for (const file_path of [root + '/.env', root + '/nested/.orca-artifacts.json', root + '/.hidden/note.md', f.store.get(f.s).cwd + '/.orca-artifacts.json']) assert.throws(() => evaluatePermission({ ...p, input: { ...p.input, file_path } }, root, f.base));
  assert.throws(() => evaluatePermission(request(root, 'Edit', { file_path: p.input.file_path, old_string: 'note.md', new_string: 'other.md' }), root, f.base));
  fs.linkSync(p.input.file_path, root + '/hard'); assert.throws(() => check(p.input.content)); fs.unlinkSync(root + '/hard'); fs.unlinkSync(p.input.file_path);
  fs.symlinkSync(root + '/note.md', p.input.file_path); assert.throws(() => check(p.input.content));
});
test('declared artifact Write uses correlated one-shot native admission and verifies output', async t => {
  const f = await fixture(t, true), root = f.store.get(f.w).cwd;
  const p = f.prompt(f.w, 'Write', { file_path: root + '/.orca-artifacts.json', content: JSON.stringify({ version: 1, files: [{ path: 'note.md', sha256: 'a'.repeat(64) }] }) });
  await f.control.permissions.reconcile(f.w); await f.control.permissions.reconcile(f.w); assert.deepEqual(f.calls, [p.id]);
  fs.writeFileSync(p.input.file_path, p.input.content); await f.control.permissions.verifyPending(); assert.equal(f.intent().state, 'verified');
  assert.equal(f.control.permissions.status(f.s).remaining, 99); assert.equal(f.store.get(f.w).mode, 'delegated');
});
test('retained escalation is skipped until an explicit scoped grant rotation, without changing team ownership', async t => {
  const f = await fixture(t, true), root = f.store.get(f.w).cwd;
  const p = f.prompt(f.w, 'Write', { file_path: root + '/.orca-artifacts.json', content: JSON.stringify({ version: 1, files: [{ path: 'note.md', sha256: 'a'.repeat(64) }] }) });
  const { canonical, digest } = await import('./permission-policy.mjs'), b = f.control.permissions.binding(f.w), origin = f.store.delivery(b.s.expected), oldId = randomUUID();
  f.store.db.prepare("INSERT INTO permission_intents VALUES (?,?,?,?,'escalated','{}',?,?)").run(oldId, digest(canonical([f.w, b.g.epoch, origin.id, p.id, p])), f.w, b.root.epoch, canonical({ requestId: p.id, note: 'Old policy refused hidden path' }), Date.now());
  await f.control.permissions.reconcile(f.w); assert.equal(f.calls.length, 0);
  f.control.permissions.revoke({ sessionId: f.w, expectedGeneration: b.s.generation, reason: 'Explicitly rotate routine authority after reviewed policy update' });
  await f.grant(f.w); await f.control.permissions.reconcile(f.w); await f.control.permissions.reconcile(f.w); assert.deepEqual(f.calls, [p.id]);
  fs.writeFileSync(p.input.file_path, p.input.content); await f.control.permissions.verifyPending(); assert.equal(f.intent().state, 'verified');
  assert.equal(f.store.db.prepare('SELECT state FROM permission_intents WHERE id=?').get(oldId).state, 'escalated');
  assert.equal(f.control.permissions.status(f.w).pool, f.w); assert.equal(f.control.permissions.status(f.s).active, true); assert.equal(f.store.get(f.w).generation, b.s.generation);
});
test('admission and reader agree on declaration schema including integer tokens and filename boundaries', async t => {
  const f = await fixture(t), root = f.store.get(f.w).cwd, { digest } = await import('./permission-policy.mjs'), { workerArtifacts } = await import('./worker-artifacts.mjs');
  const names = ['Blue-5_z .md', 'q.md', 'B.md', '5.md', 'x'.repeat(120)];
  for (const name of names) fs.writeFileSync(root + '/' + name, 'synthetic artifact');
  const files = names.map(path => ({ path, sha256: digest('synthetic artifact') })), valid = JSON.stringify({ version: 1, files });
  const bodies = [valid, valid.padEnd(4096, ' '), valid + ' '.repeat(4097), valid.replace('"version":1', '"version":1.0'), valid.replace('"version":1', '"version":1e0'), valid.replace('"version":1', '"version":true'), '{', 'null', '[]', JSON.stringify({ version: 1, files: [] }), JSON.stringify({ version: 1, files: Array(9).fill(files[0]) }), JSON.stringify({ version: 1, files: [files[0], { ...files[0], path: files[0].path.toUpperCase() }] }), JSON.stringify({ version: 1, files: [{ ...files[0], path: '../note.md' }] }), JSON.stringify({ version: 1, files: [{ ...files[0], extra: true }] })];
  for (const content of bodies) {
    fs.writeFileSync(root + '/.orca-artifacts.json', content);
    let admitted = true; try { evaluatePermission(request(root, 'Write', { file_path: root + '/.orca-artifacts.json', content }), root, f.base); } catch { admitted = false; }
    assert.equal(admitted, workerArtifacts(root).state === 'available', content.slice(0, 100));
  }
  assert.throws(() => evaluatePermission(request(root, 'Write', { file_path: root + '/.Orca-Artifacts.json', content: valid }), root, f.base), /routine owned-file scope/);
});
test('direct worker permission pool still loses authority when its supervisor manager epoch changes', async t => {
  const f = await fixture(t, true), b = f.control.permissions.binding(f.w);
  f.control.permissions.revoke({ sessionId: f.w, expectedGeneration: b.s.generation, reason: 'Explicitly rotate worker grant for scoped recovery proof' }); await f.grant(f.w);
  assert.equal(f.control.permissions.binding(f.w).g.rootSession, f.w);
  f.store.db.prepare('UPDATE manager_grants SET epoch=? WHERE supervisor=?').run(randomUUID(), f.s);
  assert.throws(() => f.control.permissions.binding(f.w), /parent authority/);
  f.prompt(); await f.control.permissions.reconcile(f.w); assert.equal(f.calls.length, 0);
});
test('invalid path strings are refused before inspecting any target or parent outside the owned root',async t=>{
 const f=await fixture(t),root=f.store.get(f.w).cwd,previous=process.cwd(),realpath=fs.realpathSync,seen=[];fs.mkdirSync(root+'/sub');
 try{
  process.chdir(root);fs.realpathSync=file=>{seen.push(file);if(file!==root)throw Error('Unexpected filesystem path inspection');return realpath(file);};
  for(const file_path of ['notes.md',root,root+'/sub/../notes.md',f.base+'/outside.md']){
   seen.length=0;assert.throws(()=>evaluatePermission(request(root,'Write',{file_path,content:'bounded text'}),root,f.base),/Path outside routine owned-file scope/);assert.deepEqual(seen,[root]);
  }
 }finally{fs.realpathSync=realpath;process.chdir(previous);}
});

// ---------------------------------------------------------------------------------------------------
// F: routine grant capacity must count LIVE grants, and reclaim as grants die.
// E: a second quick edit to the same file is ordinary work, not tampering.
// ---------------------------------------------------------------------------------------------------

test('revoking a grant reclaims its capacity immediately, and dead sessions stop occupying the bound', async t => {
  const f = await fixture(t);
  const before = f.control.permissions.capacity();
  assert.equal(before.live, 1); assert.equal(before.liveLimit, 32);

  // Fill the live bound exactly, then confirm the bound is real.
  const filler = [];
  for (let n = 0; n < 31; n++) {
    const id = randomUUID(); fs.mkdirSync(f.base + '/' + id); filler.push(id);
    f.store.db.prepare("INSERT INTO sessions VALUES (?,?,?,'delegated',1,NULL,NULL,NULL,NULL,NULL,NULL)").run(id, PROGRAMME, f.base + '/' + id);
    f.store.db.prepare('INSERT INTO permission_grants VALUES (?,1,?,?,?,0,?)').run(id, randomUUID(), id, randomUUID(), 'live grant fixture');
  }
  assert.equal(f.control.permissions.capacity().live, 32);
  await assert.rejects(f.grant(f.s), /Routine grant capacity reached/);

  // Revoking ONE reclaims exactly one slot -- the behaviour whose absence made the live installation
  // permanently ungrantable -- and the revoked row is retained as history.
  f.control.permissions.revoke({ sessionId: filler[0], expectedGeneration: 1, reason: 'Operator withdraws one routine grant' });
  const after = f.control.permissions.capacity();
  assert.equal(after.live, 31, 'capacity is reclaimed on revocation');
  assert.equal(after.total, 32, 'and nothing was deleted');
  assert.equal((await f.grant(f.s)).active, true, 'the reclaimed slot is usable');

  // A grant whose session moved on is dead too, even though it was never revoked.
  f.store.db.prepare('UPDATE sessions SET generation=2 WHERE id=?').run(filler[1]);
  assert.equal(f.control.permissions.capacity().live, 31);
  f.store.db.prepare("UPDATE sessions SET mode='human' WHERE id=?").run(filler[2]);
  assert.equal(f.control.permissions.capacity().live, 30);
});

test('the history bound is separate from the live bound and names retention rather than business', async t => {
  const f = await fixture(t);
  // Far more retained rows than the live bound, all revoked: live capacity is untouched.
  for (let n = 0; n < 400; n++) f.store.db.prepare('INSERT INTO permission_grants VALUES (?,1,?,?,?,1,?)').run(randomUUID(), randomUUID(), randomUUID(), randomUUID(), 'retained revoked fixture');
  const c = f.control.permissions.capacity();
  assert.equal(c.live, 1); assert.equal(c.total, 401);
  assert.equal((await f.grant(f.s)).active, true, 'retained history never blocks a grant while slots are live');

  // But the table cannot grow without limit: at the history bound a NEW session is refused, with a message
  // that says retention rather than pretending the installation is busy.
  // Take the supervisor's row back out so it reads as a NEW session again, and fill history to the bound.
  f.store.db.prepare('DELETE FROM permission_grants WHERE session=?').run(f.s);
  for (let n = 0; n < 111; n++) f.store.db.prepare('INSERT INTO permission_grants VALUES (?,1,?,?,?,1,?)').run(randomUUID(), randomUUID(), randomUUID(), randomUUID(), 'retained revoked fixture');
  assert.equal(f.control.permissions.capacity().total, 512);
  assert.equal(f.control.permissions.capacity().live, 1, 'still only one live grant; the bound reached is history, not business');
  await assert.rejects(f.grant(f.s), /history capacity reached; retention is required/);
});

test('REGRESSION E: two quick edits to one file keep the grant; only the second is unverified', async t => {
  const f = await fixture(t);
  const one = f.prompt(f.w, 'Write', { content: 'draft one' });
  await f.control.permissions.reconcile(f.w);
  assert.equal(f.intent().state, 'acknowledged');
  fs.writeFileSync(one.input.file_path, 'draft one');            // the approved tool call runs

  // The agent immediately edits the same file again. reconcile declines to approve a second response while
  // one is unverified, so this write is never approved -- but the write still happens, which is exactly
  // what was measured live on workers A, B and C.
  f.prompt(f.w, 'Edit', { old_string: 'one', new_string: 'two' });
  await f.control.permissions.reconcile(f.w);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM permission_intents').get().n, 1, 'the second edit was not approved');
  fs.writeFileSync(one.input.file_path, 'draft two');            // the second edit lands before verification

  await f.control.permissions.verifyPending();

  // BEFORE THE FIX this was an incident that revoked the whole pool. The approved bytes genuinely could not
  // be observed, so it is NOT reported as verified -- but ordinary work does not destroy the grant.
  const row = f.intent();
  assert.equal(row.state, 'superseded');
  assert.match(JSON.parse(row.result).note, /changed after the approved tool call completed/);
  assert.equal(JSON.parse(row.result).verification, 'superseded');
  assert.equal(JSON.parse(row.result).observed.sha256, createHash('sha256').update('draft two').digest('hex'), 'what is actually on disk is recorded');
  const status = f.control.permissions.status(f.w);
  assert.equal(status.active, true, 'THE FIX: the routine grant survives ordinary work');
  assert.equal(f.store.db.prepare('SELECT revoked FROM permission_grants WHERE session=?').get(f.w).revoked, 0);
});

test('real tamper signals remain incidents that revoke the pool', async t => {
  for (const [name, corrupt] of [
    ['a replaced parent directory', (f, p) => { const parent = path.dirname(p.input.file_path); fs.writeFileSync(p.input.file_path, 'draft one'); fs.renameSync(parent, parent + '-moved'); fs.mkdirSync(parent); fs.writeFileSync(p.input.file_path, 'draft one'); }],
    ['a hard link', (f, p) => { fs.writeFileSync(p.input.file_path, 'draft one'); fs.linkSync(p.input.file_path, p.input.file_path + '.hard'); }],
    ['a symlink swap', (f, p) => { const real = p.input.file_path + '.real'; fs.writeFileSync(real, 'draft one'); fs.symlinkSync(real, p.input.file_path); }],
  ]) {
    await test(name + ' is still an incident', async t2 => {
      const f = await fixture(t2);
      const p = f.prompt(f.w, 'Write', { content: 'draft one' });
      await f.control.permissions.reconcile(f.w);
      corrupt(f, p);
      await f.control.permissions.verifyPending();
      assert.equal(f.intent().state, 'incident', name + ' must remain an incident');
      assert.equal(f.control.permissions.status(f.w).active, false, name + ' must still revoke');
    });
  }
});

// ---------------------------------------------------------------------------------------------------
// Review follow-ups (GRANTS-REVIEW.md): B1 the live bound was exceedable, B2 pools leaked child slots,
// R2 a superseded mismatch surfaced nowhere.
// ---------------------------------------------------------------------------------------------------

test('B1: re-granting a session that holds a revoked row must hold at the live bound, not step past it', async t => {
  const f = await fixture(t);
  const filler = [];
  for (let n = 0; n < 31; n++) {
    const id = randomUUID(); fs.mkdirSync(f.base + '/' + id); filler.push(id);
    f.store.db.prepare("INSERT INTO sessions VALUES (?,?,?,'delegated',1,NULL,NULL,NULL,NULL,NULL,NULL)").run(id, PROGRAMME, f.base + '/' + id);
    f.store.db.prepare('INSERT INTO permission_grants VALUES (?,1,?,?,?,0,?)').run(id, randomUUID(), id, randomUUID(), 'live grant fixture');
  }
  assert.equal(f.control.permissions.capacity().live, 32, 'exactly at the bound');

  // Revoke one, then spend the reclaimed slot on a different session. The bound is full again.
  f.control.permissions.revoke({ sessionId: filler[0], expectedGeneration: 1, reason: 'Operator withdraws one routine grant' });
  assert.equal(f.control.permissions.capacity().live, 31);
  const replacement = randomUUID(); fs.mkdirSync(f.base + '/' + replacement);
  f.store.db.prepare("INSERT INTO sessions VALUES (?,?,?,'delegated',1,NULL,NULL,NULL,NULL,NULL,NULL)").run(replacement, PROGRAMME, f.base + '/' + replacement);
  f.store.db.prepare('INSERT INTO permission_grants VALUES (?,1,?,?,?,0,?)').run(replacement, randomUUID(), replacement, randomUUID(), 'the reclaimed slot');
  assert.equal(f.control.permissions.capacity().live, 32);

  // THE DEFECT: the revoked session asks again. Its row exists, so `!old` was false and NEITHER bound was
  // consulted -- it went straight through INSERT OR REPLACE to live=33. It must be refused instead.
  f.snapshots.set(filler[0], { id: filler[0], provider: 'claude', cwd: f.base + '/' + filler[0], status: 'idle', pendingPermissions: [], runtimeInfo: { sessionId: randomUUID() }, lastPromptId: null, lastUserMessageAt: null });
  f.store.db.prepare('UPDATE sessions SET authority=?,boot=?,grantedAt=? WHERE id=?')
    .run(f.store.get(f.w).authority, f.store.get(f.w).boot, f.store.get(f.w).grantedAt, filler[0]);
  await assert.rejects(f.control.permissions.grant({ sessionId: filler[0], expectedGeneration: 1, reason: 'Re-granting a session that holds a revoked row' }),
    /Routine grant capacity reached/);
  const after = f.control.permissions.capacity();
  assert.equal(after.live, 32, 'the bound holds; it is not 33');
  assert.ok(after.live <= after.liveLimit, `live ${after.live} must never exceed liveLimit ${after.liveLimit}`);
});

test('B2: revoking a pool stops its inherited children occupying live slots, by operator and by incident', async t => {
  // Operator revocation of the root.
  const f = await fixture(t, true);
  assert.equal(f.control.permissions.capacity().live, 2, 'supervisor plus inherited worker');
  f.control.permissions.revoke({ sessionId: f.s, expectedGeneration: f.store.get(f.s).generation, reason: 'Operator withdraws the whole pool' });
  const rows = f.store.db.prepare('SELECT session,revoked FROM permission_grants ORDER BY rowid').all();
  assert.deepEqual(rows.map(r => r.revoked), [1, 1], 'the child is revoked with its root, not left behind');
  assert.equal(f.control.permissions.capacity().live, 0, 'no slot is leaked by a revoked pool');
  assert.throws(() => f.control.permissions.binding(f.w), /revoked or ownership changed/, 'and the child could not authorise anyway');

  // Revoking a CHILD must not revoke its root.
  const g = await fixture(t, true);
  g.control.permissions.revoke({ sessionId: g.w, expectedGeneration: g.store.get(g.w).generation, reason: 'Operator withdraws only the worker' });
  assert.equal(g.control.permissions.grantRow(g.s).revoked, 0, 'the root survives its child being revoked');
  assert.equal(g.control.permissions.capacity().live, 1);

  // Incident revocation of the pool, which reaches children through rootEpoch rather than epoch.
  const h = await fixture(t, true);
  const p = h.prompt(h.w, 'Write', { content: 'draft one' });
  await h.control.permissions.reconcile(h.w);
  fs.writeFileSync(p.input.file_path, 'draft one');
  fs.linkSync(p.input.file_path, p.input.file_path + '.hard');   // a real tamper signal
  await h.control.permissions.verifyPending();
  assert.equal(h.intent().state, 'incident');
  assert.deepEqual(h.store.db.prepare('SELECT revoked FROM permission_grants ORDER BY rowid').all().map(r => r.revoked), [1, 1]);
  assert.equal(h.control.permissions.capacity().live, 0, 'an incident leaks no slot either');
});

test('R2: a superseded mismatch wakes the supervisor and is countable without reading the journal', async t => {
  const f = await fixture(t, true);
  const one = f.prompt(f.w, 'Write', { content: 'draft one' });
  await f.control.permissions.reconcile(f.w);
  fs.writeFileSync(one.input.file_path, 'draft one');
  fs.writeFileSync(one.input.file_path, 'draft two');            // the second quick edit
  const before = f.store.db.prepare('SELECT count(*) n FROM event_inbox').get().n;
  await f.control.permissions.verifyPending();

  assert.equal(f.intent().state, 'superseded');
  assert.equal(f.control.permissions.status(f.w).active, true, 'still not an incident');
  // It is no longer silent: the supervisor is woken, exactly as an incident wakes it.
  const raised = f.store.db.prepare('SELECT kind,state,worker,supervisor FROM event_inbox ORDER BY rowid DESC LIMIT 1').get();
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM event_inbox').get().n, before + 1);
  assert.equal(raised.kind, 'permission-superseded');
  assert.equal(raised.worker, f.w); assert.equal(raised.supervisor, f.s);
  // 'queued' is what wake=true produces (events.mjs:79); 'observed' is the silent variant. Asserting the
  // STATE, not merely that a row exists -- a row is written either way, so the row alone proves nothing
  // about whether anyone is woken, which is the whole point of R2.
  assert.equal(raised.state, 'queued', 'the supervisor is woken, not merely journalled');
  // And repetition on one pool is readable at a glance.
  assert.equal(f.control.permissions.status(f.w).superseded, 1);
  assert.equal(f.control.permissions.status(f.s).superseded, 1, 'the whole pool sees it');
  // Scoped to THIS pool. A count that leaked across pools would tell an operator another team's story.
  f.store.db.prepare("INSERT INTO permission_intents VALUES (?,?,?,?,'superseded','{}','{}',0)").run(randomUUID(), randomUUID(), f.w, randomUUID());
  assert.equal(f.control.permissions.status(f.w).superseded, 1, 'another pool’s superseded intents are not counted here');
});

// U7: automatic provider modes must not add Fulcra approval prompts for routine tools.
for (const [provider, modeId] of [['claude', 'auto'], ['codex', 'full-access']]) test(`U7 ${provider}: scripted MCP call and file write request zero human approvals`, async t => {
  const f = await fixture(t), a = f.snapshots.get(f.w);
  a.provider = provider; a.currentModeId = modeId;
  for (const [name, input] of [['mcp__workspace__list_files', { directory: a.cwd }], ['Write', { file_path: a.cwd + '/scripted.txt', content: 'done' }]]) {
    const p = f.prompt(f.w, name, input); p.provider = provider;
    assert.equal(f.control.permissions.routineWaiting(f.w,p,a),true,'ordinary request does not trigger an input wake before reconciliation');
    await f.control.permissions.reconcile(f.w);
    assert.equal(f.intent().state, 'acknowledged');
    if (name === 'Write') fs.writeFileSync(input.file_path, input.content);
    a.pendingPermissions = []; await f.control.permissions.verifyPending();
    assert.equal(f.intent().state, 'verified');
  }
  assert.equal(f.calls.length, 2);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM permission_intents WHERE state='escalated'").get().n, 0);
});
for (const [name, input] of [
  ['Bash', { command: 'security find-generic-password -s fixture -w' }],
  ['mcp__vault__get_secret', { name: 'fixture' }],
  ['Read', { file_path: '/Users/fixture/.ssh/id_ed25519' }],
  ['Bash', { command: 'git push --force origin main' }],
  ['Bash', { command: 'git push origin :release' }],
  ['Bash', { command: 'npm publish' }],
  ['mcp__github__create_release', { repository: 'fixture' }],
]) test(`U7 protected ${name} ${Object.keys(input)[0]} escalates`, async t => {
  const f = await fixture(t); f.snapshots.get(f.w).currentModeId = 'auto';
  f.prompt(f.w, name, input); await f.control.permissions.reconcile(f.w);
  assert.equal(f.intent().state, 'escalated'); assert.equal(f.calls.length, 0);
});
test('U7 automatic mode changing before native admission refuses', async t => {
  const f = await fixture(t); f.snapshots.get(f.w).currentModeId = 'auto';
  f.prompt(f.w, 'mcp__workspace__list_files', { directory: f.base });
  const permission = f.native.permission;
  f.native.permission = (...args) => { f.snapshots.get(f.w).currentModeId = 'default'; return permission(...args); };
  await f.control.permissions.reconcile(f.w);
  assert.equal(f.calls.length, 0); assert.equal(f.intent().state, 'refused');
});
test('U7 ordinary tool failure does not revoke automatic authority or ask for approval', async t => {
  const f=await fixture(t); f.snapshots.get(f.w).currentModeId='auto';
  f.prompt(f.w,'mcp__workspace__run_tests',{suite:'fixture'}); await f.control.permissions.reconcile(f.w);
  f.native.permissionResult=async()=>({state:'failed',callId:'fixture'});
  await f.control.permissions.verifyPending();
  assert.equal(f.intent().state,'tool-failed'); assert.equal(f.control.permissions.status(f.w).active,true);
  assert.equal(f.control.permissions.status(f.w).pending.length,0);
});
for (const [provider,modeId] of [['claude','auto'],['codex','full-access']]) test(`U7 production journal guard binds ${provider} mode, request and protected classification`, async t => {
  const f=await fixture(t), a=f.snapshots.get(f.w);
  a.provider=provider;a.currentModeId=modeId;
  const {journalPolicy}=await import('./hook-journal-policy.mjs');
  const policy=journalPolicy({boot:BOOT,require:()=>({boot:BOOT,humanAt:0})});
  f.native.permission=async(id,intentId)=>{
    const requestId=policy.admitPermission(f.store.db,{...a,runtime:{lastUserMessageAt:a.lastUserMessageAt,modeId:a.currentModeId},pendingPermissions:new Map(a.pendingPermissions.map(p=>[p.id,p]))},intentId,{behavior:'allow'},f.used);
    f.calls.push(requestId);
    return {agentId:id,requestId:'orca-permission:'+intentId,resolution:{behavior:'allow'}};
  };
  const p=f.prompt(f.w,'mcp__workspace__list_files',{directory:a.cwd});p.provider=provider;
  await f.control.permissions.reconcile(f.w);
  assert.equal(f.intent().state,'acknowledged');assert.equal(f.calls.length,1);
  a.pendingPermissions=[];await f.control.permissions.verifyPending();assert.equal(f.intent().state,'verified');
  const next=f.prompt(f.w,'mcp__keychain__get_item',{name:'fixture'});next.provider=provider;
  await f.control.permissions.reconcile(f.w);assert.equal(f.intent().state,'escalated');assert.equal(f.calls.length,1);
});
