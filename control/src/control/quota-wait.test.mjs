import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { ControlStore } from './store.mjs';
import { Controller } from './controller.mjs';
import { FENCE_PROTOCOL } from './native-fence.mjs';
import { PROGRAMME, COMPANY } from './authority.mjs';
import { quotaDecision, quotaBinding, QuotaWait } from './quota-wait.mjs';

const now = Date.parse('2026-09-17T01:00:00Z');
const quota = (patch = {}) => ({ provider: 'codex', sessionId: 'native-thread', model: 'fixture-model', serviceTier: null, accountScope: 'codex:' + 'a'.repeat(64), observedAt: new Date(now).toISOString(), ordinaryUsageAllowed: false, limits: [], ...patch });
const source = { kind: 'direct' }, yes = () => true;
async function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orca-quota-wait-'))), file = path.join(dir, 'journal.sqlite');
  const store = new ControlStore(file), id = randomUUID(); let sends = 0;
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const native = { inspect: async () => ({ status: 'idle', pending: 0, lastPromptId: null, boot: 'test-boot', fenceProtocol: FENCE_PROTOCOL, saturated: false, humanAt: 0 }), send: async () => { sends++; } };
  const control = new Controller({ store, native, authority: async () => ({ id: PROGRAMME, companyId: COMPANY, parentId: PROGRAMME, assigneeUserId: 'local-board', assigneeAgentId: null, status: 'in_progress' }) });
  store.created(id, PROGRAMME, dir); const grant = await control.handback(id, 'Delegate bounded quota test');
  const row = store.get(id), context = { generation: row.generation, boot: row.boot, expected: row.expected, expectedAt: row.expectedAt, nativeId: 'native-thread', source };
  const a = { sessionId: id, messageId: randomUUID(), text: 'Produce the assigned artifact' };
  const wait = new QuotaWait(control, () => now);
  return { store, file, id, a, control, grant, context, wait, sends: () => sends, park: () => wait.park(a, context, quota(), yes) };
}
test('only fresh provider permission clears a wait; percentages and reset timestamps do not', () => {
  assert.equal(quotaDecision(quota(), null, now).state, 'waiting');
  for (const ordinaryUsageAllowed of [null, undefined, 'true']) assert.equal(quotaDecision(quota({ ordinaryUsageAllowed }), null, now).state, 'unknown');
  assert.equal(quotaDecision(quota({ ordinaryUsageAllowed: true }), null, now).state, 'ready');
  for (const delta of [-30001, 1]) assert.equal(quotaDecision(quota({ ordinaryUsageAllowed: true, observedAt: new Date(now + delta).toISOString() }), null, now).state, 'unknown');
  for (const patch of [{ accountScope: null }, { model: null }, { serviceTier: undefined }, { sessionId: '' }, { provider: 'claude' }]) assert.equal(quotaDecision(quota(patch), null, now).state, 'unknown');
  const limit = { model: 'fixture-model', spendControlReached: null, rateLimitReachedType: null, primary: { usedPercent: 100, resetsAt: (now - 10000) / 1000 } };
  assert.equal(quotaDecision(quota({ limits: [limit] }), null, now).state, 'waiting');
  assert.equal(quotaDecision(quota({ ordinaryUsageAllowed: true, limits: [limit] }), null, now).state, 'ready');
  for (const patch of [{ spendControlReached: true }, { rateLimitReachedType: 'rate_limit_reached' }]) {
    assert.equal(quotaDecision(quota({ ordinaryUsageAllowed: true, limits: [{ ...limit, ...patch }] }), null, now).state, 'waiting');
    assert.equal(quotaDecision(quota({ ordinaryUsageAllowed: true, limits: [{ ...limit, ...patch, model: null }] }), null, now).state, 'unknown');
    assert.equal(quotaDecision(quota({ ordinaryUsageAllowed: true, limits: [{ ...limit, ...patch, model: 'another-model' }] }), null, now).state, 'ready');
  }
  for (const limits of [null, [null], [{}], [{ ...limit, spendControlReached: 'false' }]]) assert.equal(quotaDecision(quota({ ordinaryUsageAllowed: true, limits }), null, now).state, 'unknown');
  assert.equal(quotaDecision(quota({ accountScope: 'codex:' + 'b'.repeat(64) }), quotaBinding(quota()), now).state, 'changed');
});
test('real journal reopen retains the exact queued instruction without sending or charging', async t => {
  const f = await fixture(t), first = f.park(); assert.equal(first.state, 'queued');
  assert.deepEqual(f.park(), first); assert.equal(f.sends(), 0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM task_instruction_charges').get().n, 0);
  const reopened = new ControlStore(f.file); t.after(() => reopened.close());
  assert.deepEqual(reopened.delivery(f.a.messageId), first);
  assert.equal((await f.control.send(f.a, f.grant.capability)).state, 'queued');
  await assert.rejects(f.control.send({ ...f.a, text: 'Changed instruction' }, f.grant.capability), /conflict/);
  assert.throws(() => f.wait.park({ ...f.a, text: 'Changed instruction' }, f.context, quota(), yes), /conflict/);
  assert.throws(() => f.wait.park({ ...f.a, messageId: randomUUID() }, f.context, quota(), yes), /Pending/);
  assert.throws(() => f.store.admit(f.a.messageId, f.id, 'send', f.a), /revalidation/);
  await assert.rejects(f.control.send({ ...f.a, messageId: randomUUID() }, f.grant.capability), /queued/);
  assert.throws(() => f.control.acknowledgeManagement(f.a.messageId), /confirmed/);
  assert.equal(f.control.history(PROGRAMME)[0].state, 'queued'); assert.equal(f.sends(), 0);
});
test('fresh revalidated admission charges once; a lost dispatch acknowledgment cannot be replayed', async t => {
  const f = await fixture(t); f.park(); let checked = 0;
  assert.equal(f.wait.admit(f.a.messageId, quota(), () => { checked++; return true; }).state, 'queued');
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM task_instruction_charges').get().n, 0);
  const delivered = f.wait.admit(f.a.messageId, quota({ ordinaryUsageAllowed: true }), () => { checked++; return true; });
  assert.equal(delivered.state, 'intent'); assert.equal(checked, 2);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM task_instruction_charges').get().n, 1);
  assert.equal(delivered.result.nativeDispatched, undefined);
  assert.throws(() => f.wait.admit(f.a.messageId, quota({ ordinaryUsageAllowed: true }), yes), /Only a queued/);
  f.store.finish(f.a.messageId, 'uncertain', delivered.result);
  assert.throws(() => f.park(), /conflict/);
  assert.equal((await f.control.send(f.a, f.grant.capability)).state, 'uncertain'); assert.equal(f.sends(), 0);
});
test('takeover cancels waiting atomically and cannot be undone by later quota or handback', async t => {
  const f = await fixture(t); f.park(); f.control.takeover(f.id, 'Human takes over now');
  const d = f.store.delivery(f.a.messageId); assert.equal(d.state, 'refused'); assert.equal(d.result.nativeDispatched, false); assert.equal(d.result.wait.state, 'cancelled');
  await f.control.handback(f.id, 'Delegate after human work');
  assert.throws(() => f.wait.admit(f.a.messageId, quota({ ordinaryUsageAllowed: true }), yes, yes), /Only a queued/);
  assert.equal(f.sends(), 0);
});
test('failed control transfer rolls back both delegation and queue cancellation', async t => {
  const f = await fixture(t); f.park();
  f.store.db.exec("CREATE TEMP TRIGGER fail_transfer BEFORE INSERT ON transfers BEGIN SELECT RAISE(ABORT,'transfer write fault'); END;");
  assert.throws(() => f.control.takeover(f.id, 'Human takes over now'), /write fault/);
  assert.equal(f.store.get(f.id).mode, 'delegated'); assert.equal(f.store.delivery(f.a.messageId).state, 'queued');
  f.store.db.exec('DROP TRIGGER fail_transfer'); f.control.takeover(f.id, 'Human takes over now');
  assert.equal(f.store.get(f.id).mode, 'human'); assert.equal(f.store.delivery(f.a.messageId).state, 'refused');
});
test('freshness and input identity are rechecked within admission and roll back charging', async t => {
  const f = await fixture(t); f.park(); const charge = f.control.allowance.charge.bind(f.control.allowance);
  f.control.allowance.charge = (...args) => { charge(...args); f.wait.now = () => now + 30001; };
  assert.throws(() => f.wait.admit(f.a.messageId, quota({ ordinaryUsageAllowed: true }), yes), /expired/);
  assert.equal(f.control.allowance.status(PROGRAMME).admittedInstructions, 0);
  f.wait.now = () => now; f.control.allowance.charge = charge;
  assert.throws(() => f.wait.admit(f.a.messageId, quota({ ordinaryUsageAllowed: true }), () => { f.store.db.prepare('UPDATE sessions SET expected=? WHERE id=?').run(randomUUID(), f.id); return true; }), /control changed/);
  assert.equal(f.store.get(f.id).expected, null); assert.equal(f.store.delivery(f.a.messageId).state, 'queued');
});
test('account, native session, model and tier changes permanently refuse the delayed instruction', async t => {
  for (const patch of [{ accountScope: 'codex:' + 'b'.repeat(64) }, { sessionId: 'replacement' }, { model: 'replacement' }, { serviceTier: 'priority' }]) {
    const f = await fixture(t); f.park();
    assert.equal(f.wait.admit(f.a.messageId, quota({ ordinaryUsageAllowed: true, ...patch }), yes, yes).state, 'refused');
    assert.throws(() => f.wait.admit(f.a.messageId, quota({ ordinaryUsageAllowed: true }), yes, yes), /Only a queued/);
    assert.equal(f.sends(), 0);
  }
});
test('revoked source, missing revalidation and failed allowance leave no admitted intent', async t => {
  const f = await fixture(t);
  for (const check of [undefined, () => false, async () => true]) assert.throws(() => f.wait.park(f.a, f.context, quota(), check), /revalidation/);
  assert.equal(f.store.delivery(f.a.messageId), null); f.park();
  for (const check of [undefined, () => false, async () => true, () => { throw Error('Source role revoked'); }]) assert.throws(() => f.wait.admit(f.a.messageId, quota({ ordinaryUsageAllowed: true }), check, yes));
  const charge = f.control.allowance.charge.bind(f.control.allowance);
  f.control.allowance.charge = (...args) => { charge(...args); throw Error('Admission fault'); };
  assert.throws(() => f.wait.admit(f.a.messageId, quota({ ordinaryUsageAllowed: true }), yes), /fault/);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM task_instruction_charges').get().n, 0);
  assert.equal(f.store.delivery(f.a.messageId).state, 'queued'); assert.equal(f.sends(), 0);
});
test('source descriptors retain exact durable identity and reject credentials or extensions', async t => {
  const sources = [source, { kind: 'ingress', originHash: 'a'.repeat(64), preparation: randomUUID() }, { kind: 'manager', supervisor: randomUUID(), generation: 2, epoch: randomUUID(), linkEpoch: randomUUID() }, { kind: 'notification', notificationId: randomUUID(), parentMessageId: randomUUID(), originHash: 'a'.repeat(64) }, { kind: 'event', eventId: randomUUID(), worker: randomUUID(), epoch: randomUUID() }, { kind: 'leadership', handoffId: randomUUID() }];
  for (const source of sources) {
    const f = await fixture(t), context = { ...f.context, source };
    for (const extra of [{ capability: 'private' }, { token: 'private' }, { kind: 'unknown' }]) assert.throws(() => f.wait.park(f.a, { ...context, source: { ...source, ...extra } }, quota(), yes), /authority/);
    const d = f.wait.park(f.a, context, quota(), yes); assert.deepEqual(d.result.wait.binding.source, source);
    assert.throws(() => f.wait.park(f.a, { ...context, source: source.kind === 'direct' ? sources[1] : sources[0] }, quota(), yes), /conflict/);
    const intent = f.wait.admit(f.a.messageId, quota({ ordinaryUsageAllowed: true }), binding => { assert.deepEqual(binding.source, source); return true; });
    if (source.kind === 'manager') { const { kind, ...supervision } = source; assert.deepEqual(intent.result.supervision, supervision); }
  }
});
test('instruction allowance exhaustion leaves the instruction waiting without a charge', async t => {
  const f = await fixture(t); f.park();
  await f.control.allowance.set({ taskId: PROGRAMME, expectedRevision: 0, maxInstructions: 0, reason: 'No more automated instructions' });
  assert.throws(() => f.wait.admit(f.a.messageId, quota({ ordinaryUsageAllowed: true }), yes), { code: 'ORCA_INSTRUCTION_ALLOWANCE_EXHAUSTED' });
  assert.equal(f.store.delivery(f.a.messageId).state, 'queued'); assert.equal(f.control.allowance.status(PROGRAMME).admittedInstructions, 0);
});
test('abrupt process death rolls back uncommitted admission; committed intent remains unreplayable', async t => {
  for (const crashInside of [true, false]) {
    const f = await fixture(t); f.park();
    const code = `import {ControlStore} from ${JSON.stringify(new URL('./store.mjs', import.meta.url).href)};
      import {TaskAllowance} from ${JSON.stringify(new URL('./allowance.mjs', import.meta.url).href)};
      import {QuotaWait} from ${JSON.stringify(new URL('./quota-wait.mjs', import.meta.url).href)};
      const store = new ControlStore(${JSON.stringify(f.file)}), control = {store}; control.allowance = new TaskAllowance(control);
      const charge = control.allowance.charge.bind(control.allowance);
      control.allowance.charge = (...args) => { charge(...args); if (${crashInside}) process.kill(process.pid, 'SIGKILL'); };
      new QuotaWait(control, () => ${now}).admit(${JSON.stringify(f.a.messageId)}, ${JSON.stringify(quota({ ordinaryUsageAllowed: true }))}, () => true);
      process.kill(process.pid, 'SIGKILL');`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 5000 });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    const reopened = new ControlStore(f.file); t.after(() => reopened.close());
    assert.equal(reopened.delivery(f.a.messageId).state, crashInside ? 'queued' : 'intent');
    assert.equal(reopened.db.prepare('SELECT count(*) n FROM task_instruction_charges').get().n, crashInside ? 0 : 1);
    if (!crashInside) assert.throws(() => f.wait.admit(f.a.messageId, quota({ ordinaryUsageAllowed: true }), yes), /Only a queued/);
    assert.equal(f.sends(), 0);
  }
});
