import { FENCE_PROTOCOL } from './native-fence.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ControlStore } from './store.mjs';
import { Controller } from './controller.mjs';
import { rpc } from './rpc.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
async function fixture(t, fixedDir) {
  const dir = fixedDir ?? fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orca-allowance-'))), file = path.join(dir, 'journal.sqlite'), taskId = randomUUID(), calls = [], states = new Map();
  const native = { inspect: async id => ({ boot: 'fixture', fenceProtocol: FENCE_PROTOCOL, saturated: false, humanAt: 0, ...states.get(id) }), send: async (id, text, messageId) => { calls.push({ id, text, messageId }); if (native.fail) throw Error('Lost native response'); states.get(id).lastPromptId = messageId; } };
  const c = new Controller({ store: new ControlStore(file), native, authority: async () => ({ id: taskId, assigneeUserId: 'local-board' }) });
  const add = async (task = taskId) => { const id = randomUUID(); states.set(id, { status: 'idle', pending: 0, lastPromptId: null }); c.store.created(id, task, dir); const grant = await c.handback(id, 'Delegate allowance fixture'); return { id, capability: grant.capability }; };
  const one = await add(), two = await add(), status = () => c.allowance.status(taskId);
  const policy = (maxInstructions, expectedRevision = status().revision) => ({ taskId, expectedRevision, maxInstructions, reason: 'Explicit test instruction allowance' });
  const send = (s = one, messageId = randomUUID()) => c.send({ sessionId: s.id, messageId, text: 'Bounded fixture instruction' }, s.capability);
  t.after(() => { c.store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { c, calls, taskId, one, two, add, send, status, policy, file, native, states };
}
if (process.argv[2] === '--crash-allowance') {
  const f = await fixture({ after: () => {} }, process.argv[3]); await f.c.allowance.set(f.policy(1));
  f.native.send = async () => { process.kill(process.pid, 'SIGKILL'); }; await f.send(); process.exit(3);
}
test('actual process death after admission retains charge and never replays the uncertain instruction', t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orca-allowance-crash-')));
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--crash-allowance', dir], { timeout: 10000 }); assert.equal(child.signal, 'SIGKILL');
  const store = new ControlStore(path.join(dir, 'journal.sqlite')); t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const delivery = store.db.prepare("SELECT * FROM deliveries WHERE kind='send'").get(); let sends = 0;
  const c = new Controller({ store, native: { send: async () => sends++ }, authority: async () => ({ id: store.get(delivery.session).task, assigneeUserId: 'local-board' }) });
  assert.equal(c.allowance.status(store.get(delivery.session).task).remaining, 0);
  return c.send(JSON.parse(delivery.body), undefined, store.get(delivery.session).generation).then(r => { assert.equal(r.state, 'intent'); assert.equal(sends, 0); });
});
test('two sessions race for one shared slot; duplicate receipt and another task do not spend it', async t => {
  const f = await fixture(t); await f.c.allowance.set(f.policy(1));
  const id = randomUUID(), results = await Promise.allSettled([f.send(f.one, id), f.send(f.two)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.match(results.find(r => r.status === 'rejected').reason.message, /allowance exhausted/);
  assert.equal(f.calls.length, 1); assert.equal(f.status().admittedInstructions, 1);
  const sent = f.calls[0], session = sent.id === f.one.id ? f.one : f.two;
  assert.equal((await f.send(session, sent.messageId)).state, 'delivered'); assert.equal(f.calls.length, 1);
  await f.send(await f.add(randomUUID())); assert.equal(f.calls.length, 2); assert.equal(f.status().admittedInstructions, 1);
});
test('absolute policy retry is idempotent; stale writers and session capabilities cannot change it', async t => {
  const f = await fixture(t), request = f.policy(0), dispatch = rpc(f.c, 'operator-only');
  await assert.rejects(dispatch({ method: 'task-allowance-set', input: request, capability: f.one.capability }), /Operator/);
  const a = await dispatch({ method: 'task-allowance-set', input: request, operator: 'operator-only' });
  assert.deepEqual(await f.c.allowance.set(request), a);
  await assert.rejects(f.c.allowance.set({ ...request, maxInstructions: 3 }), /changed/);
  for (const maximum of [-1, 1.5, 1001, '5', NaN]) await assert.rejects(f.c.allowance.set(f.policy(maximum)), /Invalid/);
  await assert.rejects(f.send(), /allowance exhausted/); assert.equal(f.calls.length, 0);
  f.c.authority = async () => { throw Error('Task no longer authorized'); };
  await assert.rejects(f.c.allowance.set(f.policy(null)), /authorized/); assert.equal(f.status().maxInstructions, 0);
});
test('uncertain dispatch remains charged across reopening and takeover/handback; same receipt never retries', async t => {
  const f = await fixture(t); await f.c.allowance.set(f.policy(1)); f.native.fail = true;
  const id = randomUUID(); assert.equal((await f.send(f.one, id)).state, 'uncertain');
  f.c.store.close(); f.c.store = new ControlStore(f.file);
  assert.equal(f.status().remaining, 0); assert.equal((await f.send(f.one, id)).state, 'uncertain'); assert.equal(f.calls.length, 1);
  f.c.disposition(id, 'Uncertain receipt retained without replay'); f.c.takeover(f.one.id, 'Human takes control');
  f.one.capability = (await f.c.handback(f.one.id, 'Resume same saved fixture')).capability;
  await assert.rejects(f.send(), /allowance exhausted/); assert.equal(f.calls.length, 1);
});
test('admission insertion failure rolls charge back; busy and revoked recipients spend nothing', async t => {
  const f = await fixture(t); await f.c.allowance.set(f.policy(1));
  f.states.get(f.one.id).status = 'running'; await assert.rejects(f.send(), /busy/); f.states.get(f.one.id).status = 'idle';
  f.c.store.db.exec("CREATE TRIGGER fail_admission BEFORE INSERT ON deliveries BEGIN SELECT RAISE(ABORT,'injected storage failure'); END;");
  await assert.rejects(f.send(), /storage failure/); assert.equal(f.status().admittedInstructions, 0); assert.equal(f.calls.length, 0);
  f.c.store.db.exec('DROP TRIGGER fail_admission'); f.c.takeover(f.one.id, 'Human takeover before dispatch');
  await assert.rejects(f.send(), /revoked/); assert.equal(f.status().admittedInstructions, 0);
  await f.send(f.two); assert.equal(f.status().admittedInstructions, 1);
});
test('old journal sends remain intact and uncounted; explicit removal never erases new charges', async t => {
  const f = await fixture(t), id = randomUUID(); f.c.store.admit(id, f.one.id, 'send', { legacy: true }); f.c.store.finish(id, 'delivered', { legacy: true });
  assert.equal(f.status().maxInstructions, null); assert.equal(f.status().admittedInstructions, 0);
  await f.send(); await f.c.allowance.set(f.policy(1)); await assert.rejects(f.send(), /allowance exhausted/);
  await f.c.allowance.set(f.policy(null)); await f.send();
  assert.equal(f.status().admittedInstructions, 2); assert.equal(f.c.store.delivery(id).result.legacy, true);
});
