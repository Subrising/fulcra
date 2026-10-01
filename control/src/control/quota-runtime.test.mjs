import { AUTOMATION_LIMIT } from './journal-capacity.mjs';
import { rpc } from './rpc.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Controller } from './controller.mjs';
import { ControlStore } from './store.mjs';
import { Events } from './events.mjs';
import { Manager } from './manager.mjs';
import { Leadership } from './leadership.mjs';
import { Bindings } from './bindings.mjs';
import { RoleChannels } from './role-channels.mjs';
import { admit, observation, guard } from '../../tools/legacy-host-admission.fixture.mjs';
import { PROGRAMME, COMPANY, SourceChanged } from './authority.mjs';
import { readNativeQuota, permissionChannel } from './native.mjs';
import { agentWatch } from './agent-watch.mjs';
import { nativeTurnOptions, quotaFailure } from '../../tools/legacy-host-admission.fixture.mjs';
import { requireUnpinnedAdmissionGuard } from './admission-guard-precondition.mjs';
import { closeSeatingDefaults } from './role-defaults-fixture.mjs';
requireUnpinnedAdmissionGuard(); // Fails loudly when the working guard is pinned; see that module.
const PROJECT_ID = '22222222-2222-4222-8222-000000000001';
// The channel's sender sits on a member task while its recipient sits on the programme root, which is the
// cross-task shape a real prime/project channel has and the reason the sender needs its own authority check.
const MEMBER_TASK = '33333333-3333-4333-8333-000000000001';
async function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orca-quota-runtime-'))), file = path.join(dir, 'journal.sqlite');
  let c, now = Date.now(), allowed = false; const states = new Map(), sends = [], reads = [];
  const rotated = new Set(), assignee = id => rotated.has(id) ? 'reassigned-board' : 'local-board';
  const native = {
    create: async () => { const id = randomUUID(), cwd = path.join(dir, id); fs.mkdirSync(cwd); states.set(id, { id, cwd, provider: 'codex', labels: { owner: 'orca-control', task: PROGRAMME }, model: 'fixture-model', serviceTier: null, runtimeInfo: { provider: 'codex', sessionId: id }, status: 'idle', pendingPermissions: [], lastPromptId: null, lastUserAt: null }); return { id, cwd, managerToolsVersion: '1' }; },
    verifyNew: async () => {}, route: () => undefined, snapshot: async id => ({ ...states.get(id), lastUserMessageAt: states.get(id).lastUserAt }),
    inspect: async id => ({ ...states.get(id), ...observation(id), nativeId: id, pending: 0, timelineCursor: { epoch: 'test', seq: sends.length } }),
    quota: async id => { reads.push(id); await native.duringQuota?.(id); return { provider: 'codex', sessionId: id, model: states.get(id).model, serviceTier: states.get(id).serviceTier, accountScope: 'codex:' + 'a'.repeat(64), observedAt: new Date(now).toISOString(), ordinaryUsageAllowed: allowed, limits: [] }; },
    send: async (id, text, messageId) => { native.beforeAdmit?.(id, messageId); const state = states.get(id); admit(c.store.db, { id, provider: state.provider, config: { model: state.model }, persistence: { sessionId: state.runtimeInfo.sessionId }, features: state.serviceTier === 'fast' ? [{ type: 'toggle', id: 'fast_mode', value: true }] : [], pendingPermissions: [], lastUserMessageAt: states.get(id).lastUserAt ? new Date(states.get(id).lastUserAt) : null }, text, messageId, false); sends.push({ id, text, messageId }); Object.assign(states.get(id), { lastPromptId: messageId, lastUserAt: new Date(now).toISOString() }); if (native.loseReply) throw Error('Lost native acknowledgment'); },
    receipt: async () => ({ state: 'completed' }), completion: async (_id, _message, progress) => ({ ended: false, progress }),
  };
  const init = () => { c = new Controller({ store: new ControlStore(file), native, authority: async id => id === PROGRAMME
      ? ({ id: PROGRAMME, companyId: COMPANY, assigneeUserId: assignee(PROGRAMME), assigneeAgentId: null, status: 'in_progress' })
      : ({ id, companyId: COMPANY, parentId: PROGRAMME, assigneeUserId: assignee(id), assigneeAgentId: null, status: 'in_progress' }) }); c.events = new Events(c, path.join(dir, 'inbox')); c.manager = new Manager(c, path.join(dir, 'manager')); c.leadership = new Leadership(c); c.bindings = new Bindings(c, async () => ({ observedAt: new Date().toISOString(), available: true, partial: false, projects: [{ id: PROJECT_ID, name: 'Orca', description: null, status: 'in_progress' }], membership: [{ taskId: MEMBER_TASK, projectId: PROJECT_ID }], note: 'quota runtime project source' }), path.join(dir, 'grants', 'role')); c.channels = new RoleChannels(c, () => now); c.quota.now = () => now; c.result = async () => ({ available: true, ended: true, outputEvidenceHash: 'b'.repeat(64) }); };
  init(); t.after(async () => { c.closing = true; await Promise.allSettled([c.quota.pumping, c.events.pumping, c.leadership.pumping]); c.store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const create = async (taskId = PROGRAMME) => (await c.create({ messageId: randomUUID(), taskId, provider: 'codex', title: 'Owned quota runtime test' })).result.id;
  const delegated = async () => { const id = await create(); return { id, ...(await c.handback(id, 'Delegate quota runtime test')) }; };
  const manager = async () => { const id = await create(); await c.manager.promote({ sessionId: id, expectedGeneration: 1, maxWorkers: 2, reason: 'Delegate owned quota supervisor' }); const token = JSON.parse(fs.readFileSync(path.join(dir, 'manager', id + '.json'))).capability; const worker = (await c.manager.create({ sessionId: id, messageId: randomUUID(), provider: 'codex', title: 'Owned worker' }, token)).sessionId; return { id, worker, token }; };
  return { get c() { return c; }, native, states, sends, reads, create, delegated, manager, rotate: id => rotated.add(id), allow: value => { allowed = value; }, tick: () => { now += 30001; }, reopen: () => { c.store.close(); init(); } };
}
async function queuedSource(f, kind) {
  const a = { messageId: randomUUID(), text: 'Continue the owned task' }, originHash = 'a'.repeat(64);
  let id, revoke, sender;
  if (kind === 'direct' || kind === 'ingress' || kind === 'notification') {
    const grant = await f.delegated(); id = grant.id; a.sessionId = id;
    if (kind === 'direct') await f.c.send(a, grant.capability);
    else {
      const input = { ...a, originHash }; f.c.ingress.prepare(input, grant.capability);
      if (kind === 'ingress') { await f.c.ingress.send(input, grant.capability); revoke = () => f.c.store.db.prepare('DELETE FROM management_requests WHERE id=?').run(a.messageId); }
      else {
        f.allow(true); await f.c.ingress.send(input, grant.capability);
        const n = await f.c.notifications.prepare({ sessionId: id, messageId: a.messageId, originHash }, grant.capability), request = { sessionId: id, originHash, notificationId: n.notificationId };
        await f.c.notifications.read(request, grant.capability); f.allow(false);
        const next = await f.c.notifications.assign({ ...request, text: 'Revise the same artifact' }, grant.capability), parent = a.messageId; a.messageId = next.messageId; a.text = 'Revise the same artifact';
        await assert.rejects(f.c.notifications.acknowledge({ ...request, outputEvidenceHash: 'b'.repeat(64) }, grant.capability), /Unresolved follow-up/);
        revoke = () => f.c.store.db.prepare("UPDATE deliveries SET result=json_set(result,'$.notification.consumedAt',1) WHERE id=?").run(parent);
      }
    }
  } else if (kind === 'manager') {
    const m = await f.manager(); id = m.worker; a.sessionId = id;
    await f.c.manager.assign({ sessionId: m.id, workerId: id, messageId: a.messageId, text: a.text }, m.token);
    revoke = () => f.c.store.db.prepare('UPDATE manager_grants SET epoch=? WHERE supervisor=?').run(randomUUID(), m.id);
  } else if (kind === 'event') {
    const p = await f.delegated(), w = await f.delegated(); id = p.id; a.sessionId = id;
    const link = await f.c.events.attach({ workerId: w.id, supervisorId: id, capability: p.capability, reason: 'Observe owned completion test' });
    f.c.events.add(link, 'turn-ended', randomUUID(), { result: 'fixture' }); await f.c.events.pump();
    const e = f.c.store.db.prepare('SELECT * FROM event_inbox').get(); a.messageId = e.id; a.text = JSON.parse(f.c.store.delivery(e.id).body).text;
    assert.equal(e.state, 'queued'); revoke = () => f.c.store.db.prepare("UPDATE event_inbox SET consumed='Read elsewhere' WHERE id=?").run(e.id);
  } else if (kind === 'role-channel') {
    // Seats are assigned before delegation, as the operator flow does: assign pins the binding to the
    // session generation it saw, and handback is what advances it.
    const primeId = await f.create(), projectId = await f.create(MEMBER_TASK);
    await f.c.bindings.assign({ role: 'prime', seat: 'delivery', sessionId: primeId, expectedSessionGeneration: 1, expectedRevision: 0, note: 'Accountable prime seat for delivery' });
    await f.c.bindings.assign({ role: 'project-orchestrator', seat: PROJECT_ID, sessionId: projectId, expectedSessionGeneration: 1, expectedRevision: 0, note: 'Owns delivery of this project' });
    await f.c.handback(primeId, 'Delegate the prime seat for the channel test');
    await f.c.handback(projectId, 'Delegate the project seat for the channel test');
    const capability = JSON.parse(fs.readFileSync((await f.c.bindings.grantRole({ sessionId: projectId, expectedGeneration: f.c.store.get(projectId).generation })).grantFile, 'utf8')).capability;
    // Seating conferred a default channel between these seats; close it so the operator approval below is
    // the channel whose quota behaviour this suite measures. See role-defaults-fixture.mjs.
    closeSeatingDefaults(f.c);
    const channel = await f.c.channels.open({ primeSeat: 'delivery', projectSeat: PROJECT_ID, purpose: 'Weekly delivery check-in between the board seat and this project',
      maxMessages: 4, expiresAt: new Date(f.c.quota.now() + 86400000).toISOString(), expectedPrimeRevision: 1, expectedProjectRevision: 1 });
    id = primeId; a.sessionId = id;
    await f.c.channels.send({ sessionId: projectId, channelId: channel.channelId, messageId: a.messageId, text: a.text }, capability);
    revoke = () => f.c.store.db.prepare("UPDATE role_channels SET state='closed' WHERE id=?").run(channel.channelId);
    sender = projectId;
  } else {
    const m = await f.manager(), destination = await f.create(), input = { messageId: randomUUID(), sessionId: m.id, expectedGeneration: f.c.store.get(m.id).generation, destinationId: destination, destinationGeneration: 1, maxWorkers: 2, context: 'Continue the existing artifact with its saved worker.', workers: [{ sessionId: m.worker, expectedGeneration: f.c.store.get(m.worker).generation }] };
    const moved = await f.c.leadership.transfer(input); assert.equal(moved.state, 'delivered', JSON.stringify(moved.result)); await f.c.leadership.pump(); const h = f.c.leadership.row(input.messageId); id = destination; a.sessionId = id; a.messageId = h.wakeId; a.text = JSON.parse(f.c.store.delivery(h.wakeId).body).text;
    revoke = () => f.c.store.db.prepare("UPDATE leadership_handoffs SET state='consumed',consumed='Read elsewhere' WHERE id=?").run(h.id);
  }
  assert.equal(f.c.store.delivery(a.messageId)?.state, 'queued', JSON.stringify(f.c.leadership?.lastError));
  return { a, id, sender, revoke: revoke ?? (() => f.c.takeover(id, 'Human cancels queued work')) };
}
for (const kind of ['direct', 'ingress', 'manager', 'notification', 'event', 'leadership', 'role-channel']) {
  test(kind + ' resumes one exact instruction after restart without a caller retry', async t => {
    const f = await fixture(t), { a } = await queuedSource(f, kind), before = f.sends.length, charged = f.c.allowance.status(PROGRAMME).admittedInstructions;
    f.reopen(); await f.c.quota.pump(); assert.equal(f.sends.length, before); f.tick(); await f.c.quota.pump(); assert.equal(f.sends.length, before);
    f.allow(true); f.tick(); await Promise.all([f.c.quota.pump(), f.c.quota.pump()]);
    assert.equal(f.c.store.delivery(a.messageId).state, 'delivered'); assert.equal(f.sends.length, before + 1); assert.equal(f.sends.at(-1).messageId, a.messageId);
    assert.equal(f.c.allowance.status(PROGRAMME).admittedInstructions, charged + 1); assert(f.c.store.delivery(a.messageId).result.outputContext.cursor);
    f.tick(); await f.c.quota.pump(); assert.equal(f.sends.length, before + 1);
  });
  test(kind + ' revocation while waiting prevents automatic input', async t => {
    const f = await fixture(t), q = await queuedSource(f, kind), before = f.sends.length; q.revoke(); f.allow(true); f.tick(); await f.c.quota.pump();
    assert.equal(f.sends.length, before); assert.equal(f.c.store.delivery(q.a.messageId).state, 'refused');
  });
}
test('a role-channel sender task authority change while parked refuses on resume', async t => {
  const f = await fixture(t), q = await queuedSource(f, 'role-channel'), before = f.sends.length;
  // Only the SENDER's task. The recipient sits on the programme root, so control.send's own authority
  // re-derivation still passes and nothing but the replay loop can catch this.
  f.rotate(MEMBER_TASK);
  f.allow(true); f.tick(); await f.c.quota.pump();
  assert.equal(f.sends.length, before);
  const d = f.c.store.delivery(q.a.messageId);
  assert.equal(d.state, 'refused');
  assert.match(d.result.wait.reason, /task authority changed/);
});
// Not a refusal: a recipient authority change raises an ordinary error rather than SourceChanged, so the
// instruction stays queued and keeps retrying. Recorded as the actual behaviour, not the hoped-for one.
// Measured, not assumed: a deleted sender is refused by sourceCheck's assertOriginator, which runs before
// the related loop. The null guard in that loop is defence against a cross-process deletion of the row
// between inspect and get, and is deliberately not reachable from here.
test('a role-channel whose sender session is deleted refuses cleanly rather than obscurely', async t => {
  const f = await fixture(t), q = await queuedSource(f, 'role-channel'), before = f.sends.length;
  f.c.store.db.prepare('DELETE FROM sessions WHERE id=?').run(q.sender);
  f.allow(true); f.tick(); await f.c.quota.pump();
  assert.equal(f.sends.length, before);
  const d = f.c.store.delivery(q.a.messageId);
  assert.equal(d.state, 'refused');
  // The specific reason, not the generic one: the catch-and-collapse that used to wrap these checks
  // replaced every message with 'Queued source authority changed', so an operator was told that something
  // changed but never what.
  assert.match(d.result.wait.reason, /Originating seat is no longer under delegated control/);
  assert.doesNotMatch(d.result.wait.reason, /Queued source authority changed/);
  assert.doesNotMatch(d.result.wait.reason, /Cannot read|undefined/);
});
test('a role-channel recipient task authority change while parked stops delivery and stays queued', async t => {
  const f = await fixture(t), q = await queuedSource(f, 'role-channel'), before = f.sends.length;
  f.rotate(PROGRAMME);
  f.allow(true); f.tick(); await f.c.quota.pump();
  assert.equal(f.sends.length, before);
  assert.equal(f.c.store.delivery(q.a.messageId).state, 'queued');
});
// The inverse of the pump fix: sourceCheck wrapped the channel's own checks in catch { require(false) },
// which made SourceChanged out of everything -- so a read that merely failed cancelled a parked message
// permanently instead of leaving it queued.
test('a role-channel source check that fails for an unknown reason stays queued, not cancelled', async t => {
  const f = await fixture(t), q = await queuedSource(f, 'role-channel'), before = f.sends.length;
  const real = f.c.channels.row.bind(f.c.channels);
  f.c.channels.row = () => { throw Error('database is locked'); };
  f.allow(true); f.tick(); await f.c.quota.pump();
  assert.equal(f.sends.length, before);
  assert.equal(f.c.store.delivery(q.a.messageId).state, 'queued', 'an unknown failure must not cancel');
  // And it delivers once the read works again -- no operator re-approval.
  f.c.channels.row = real;
  f.tick(); await f.c.quota.pump();
  assert.equal(f.c.store.delivery(q.a.messageId).state, 'delivered');
  assert.equal(f.sends.length, before + 1);
});
// The definite direction still cancels: closing the channel is a recorded change, not an unknown error.
test('a role-channel whose channel was closed while parked is still cancelled', async t => {
  const f = await fixture(t), q = await queuedSource(f, 'role-channel');
  q.revoke();
  f.allow(true); f.tick(); await f.c.quota.pump();
  const d = f.c.store.delivery(q.a.messageId);
  assert.equal(d.state, 'refused');
  assert.match(d.result.wait.reason, /Channel is closed/);
});
// The same unknown->definite inversion that was removed from role-channel, at the two sites that kept it.
// An unreachable read must not cancel an instruction an operator issued.
for (const [kind, owner, method] of [['ingress', f => f.c.ingress, 'scope'], ['manager', f => f.c.manager, 'owned']]) {
  test(`${kind}: a source check that fails for an unknown reason stays queued`, async t => {
    const f = await fixture(t), q = await queuedSource(f, kind), before = f.sends.length;
    const host = owner(f), real = host[method].bind(host);
    host[method] = () => { throw Error('database is locked'); };
    f.allow(true); f.tick(); await f.c.quota.pump();
    assert.equal(f.sends.length, before);
    assert.equal(f.c.store.delivery(q.a.messageId).state, 'queued', 'an unknown failure must not cancel');
    host[method] = real;
    f.tick(); await f.c.quota.pump();
    assert.equal(f.c.store.delivery(q.a.messageId).state, 'delivered');
  });
}

// End to end for manager: a definite ownership change still cancels, and reports ITS OWN reason rather
// than the generic 'Queued source authority changed' the collapsed catch used to substitute.
test('manager: a definite ownership change cancels and says which one', async t => {
  const f = await fixture(t), q = await queuedSource(f, 'manager');
  f.c.store.db.prepare("UPDATE manager_workers SET phase='detached' WHERE worker=?").run(q.a.sessionId);
  f.allow(true); f.tick(); await f.c.quota.pump();
  const d = f.c.store.delivery(q.a.messageId);
  assert.equal(d.state, 'refused');
  assert.match(d.result.wait.reason, /Worker is not currently delegated to this manager/);
  assert.doesNotMatch(d.result.wait.reason, /Queued source authority changed/);
});

// For ingress the equivalent trigger is caught by an earlier plain-Error check, so the typing is asserted
// where it lives instead of through the quota path. The branch handling it is the same mechanism the
// manager test proves end to end -- neither site wraps the call any more.
test('ingress: a revoked delegation is refused as a definite change, not an unknown error', async t => {
  const f = await fixture(t), q = await queuedSource(f, 'ingress');
  f.c.store.db.prepare("UPDATE sessions SET mode='human' WHERE id=?").run(q.a.sessionId);
  assert.throws(() => f.c.ingress.scope(q.a.sessionId, 'a'.repeat(64)),
    e => e instanceof SourceChanged && /Ingress delegation revoked/.test(e.message));
});

// A quota wait is meant to retry indefinitely, so there is no attempt bound to stop it -- which made a
// plain Error from quota-wait's current() a permanent 30-second loop for a delivery whose control had
// definitely changed. Measured before the fix: each of these reported state 'queued'.
//
// Mode and generation are NOT in this list: the takeover path cancels those first, with its own reason
// ('Control transferred before admission'), so they never reached current().
for (const [what, sql] of [
  ['the daemon rebooted', "UPDATE sessions SET boot='a-different-boot' WHERE id=?"],
  ['the task authority changed', `UPDATE sessions SET authority='["changed"]' WHERE id=?`],
  ['the session took other input', "UPDATE sessions SET expected='11111111-1111-4111-8111-111111111111' WHERE id=?"],
]) {
  test(`a parked delivery cancels rather than retrying forever when ${what}`, async t => {
    const f = await fixture(t), q = await queuedSource(f, 'direct'), before = f.sends.length;
    f.c.store.db.prepare(sql).run(q.a.sessionId);
    f.allow(true); f.tick(); await f.c.quota.pump();
    const d = f.c.store.delivery(q.a.messageId);
    assert.equal(d.state, 'refused', 'a definite control change must cancel, not requeue');
    assert.match(d.result.wait.reason, /Queued instruction control changed/);
    assert.equal(f.sends.length, before);
    // And it stays cancelled rather than being picked up again on the next tick.
    f.tick(); await f.c.quota.pump();
    assert.equal(f.c.store.delivery(q.a.messageId).state, 'refused');
  });
}

test('takeover during quota await, changed model, offline measurement and uncertain send never replay', async t => {
  for (const scenario of ['takeover', 'model', 'offline', 'uncertain']) {
    const f = await fixture(t), { a, id } = await queuedSource(f, 'direct'); f.allow(true); f.tick();
    if (scenario === 'takeover') f.native.duringQuota = () => f.c.takeover(id, 'Human interrupts quota reading');
    if (scenario === 'model') f.states.get(id).model = 'different-model';
    if (scenario === 'offline') f.native.duringQuota = () => { throw Error('Quota connection offline'); };
    if (scenario === 'uncertain') f.native.loseReply = true;
    await f.c.quota.pump(); assert.equal(f.c.store.delivery(a.messageId).state, scenario === 'offline' ? 'queued' : scenario === 'uncertain' ? 'uncertain' : 'refused');
    const before = f.sends.length; f.native.duringQuota = null; f.tick(); await f.c.quota.pump();
    assert.equal(f.sends.length, scenario === 'offline' ? before + 1 : before);
  }
});
test('unsupported quota stays explicitly unmeasured and never clears an existing wait', async t => {
  const f = await fixture(t), { a } = await queuedSource(f, 'direct'); f.native.quota = async () => null; f.tick(); await f.c.quota.pump(); assert.equal(f.c.store.delivery(a.messageId).state, 'queued'); assert.equal(f.sends.length, 0);
  f.c.takeover(a.sessionId, 'Human cancels unknown quota wait'); const other = await f.delegated();
  const d = await f.c.send({ sessionId: other.id, messageId: randomUUID(), text: 'Existing unsupported-provider path' }, other.capability); assert.equal(d.state, 'delivered'); assert.equal(d.result.outputContext.quota.state, 'unavailable');
});
test('native human input during waiting cancels before prompt admission', async t => {
  const f = await fixture(t), { id, a } = await queuedSource(f, 'direct'); guard({ id }, 'Human input', {}, false); f.allow(true); f.tick(); await f.c.quota.pump(); assert.equal(f.c.store.delivery(a.messageId).state, 'refused'); assert.equal(f.sends.length, 0);
});
test('bounded polling does not starve later sessions behind busy recipients', async t => {
  const f = await fixture(t), queued = [];
  for (let i = 0; i < 6; i++) queued.push(await queuedSource(f, 'direct'));
  for (const q of queued.slice(0, 4)) f.c.busy.add(q.id);
  f.allow(true); f.tick(); const before = f.reads.length; await f.c.quota.pump(); assert.equal(f.reads.length, before);
  await f.c.quota.pump(); assert.equal(f.sends.length, 2);
  f.c.busy.clear(); f.tick(); await f.c.quota.pump(); assert.equal(f.sends.length, 6); assert.equal(f.reads.length - before, 6);
});
test('adapter refuses wrong correlation and does not call quota for old hosts or unsupported providers', async () => {
  let provider = 'codex', feature = false, reads = 0;
  const client = { agents: { ref: () => ({ refresh: async () => {}, current: () => ({ provider }) }) } }, daemon = { getLastServerInfoMessage: () => ({ features: { agentQuotaRead: feature } }), readAgentQuota: async id => { reads++; return { agentId: id, quota: { observed: true } }; } };
  assert.equal(await readNativeQuota(client, daemon, 'one'), null); assert.equal(reads, 0); feature = true; provider = 'claude'; assert.equal(await readNativeQuota(client, daemon, 'one'), null); assert.equal(reads, 0);
  provider = 'codex'; assert.deepEqual(await readNativeQuota(client, daemon, 'one'), { observed: true }); daemon.readAgentQuota = async () => ({ agentId: 'wrong' }); await assert.rejects(readNativeQuota(client, daemon, 'one'), /target/);
});
test('owned permission observation requires a fresh acknowledged snapshot after reconnect', async () => {
  let observer, connection, releases = 0; const daemon = { isConnected: false, subscribeConnectionStatus: fn => { connection = fn; return () => {}; }, getLastServerInfoMessage: () => ({ features: { explicitEventSubscriptions: true } }), observeEvents: events => { assert.deepEqual(events, ['agent_permission_resolved']); return { subscribe: fn => { observer = fn; return () => {}; }, release: async () => { releases++; } }; } };
  const channel = permissionChannel(daemon, 5); await assert.rejects(channel.ready(), /not acknowledged/);
  daemon.isConnected = true; connection({ status: 'connected' }); observer.snapshot(); await channel.ready();
  daemon.isConnected = false; connection({ status: 'disconnected' }); daemon.isConnected = true; connection({ status: 'connected' }); await assert.rejects(channel.ready(), /not acknowledged/);
  observer.snapshot(); await channel.ready(); await channel.close(); assert.equal(releases, 1); await assert.rejects(channel.ready(), /closed/);
});
test('watchdog reads reuse one owned agent subscription and release it on close', async () => {
  let subscribed = 0, reads = 0, released = 0, observer; const client = { agents: { list: async options => { assert.equal(options.page.limit, 100); if (!options.subscribe) { reads++; return {}; } subscribed++; assert.deepEqual(options.subscribe, {}); return { subscription: { subscribe: fn => { observer = fn; return () => {}; }, release: async () => { released++; } } }; } } };
  const watch = agentWatch(client); await Promise.all([watch.watch(), watch.watch()]); await watch.watch(); assert.equal(subscribed, 1); assert.equal(reads, 1);
  observer.error(); await watch.watch(); assert.equal(subscribed, 2); await watch.close(); assert.equal(released, 1); await assert.rejects(watch.watch(), /closed/);
});

for (const kind of ['direct', 'ingress', 'manager', 'notification', 'event', 'leadership', 'role-channel']) {
  test(kind + ' source revocation in transport is refused by the native boundary', async t => {
    const f = await fixture(t), q = await queuedSource(f, kind), before = f.sends.length;
    f.native.beforeAdmit = () => q.revoke(); f.allow(true); f.tick(); await f.c.quota.pump();
    assert.equal(f.c.store.delivery(q.a.messageId).state, 'refused'); assert.equal(f.sends.length, before);
  });
}
test('native configuration changes in transport refuse a quota resume', async t => {
  for (const change of [s => { s.model = 'new-model'; }, s => { s.serviceTier = 'fast'; }, s => { s.runtimeInfo.sessionId = randomUUID(); }, s => { s.provider = 'claude'; }]) {
    const f = await fixture(t), q = await queuedSource(f, 'direct');
    f.native.beforeAdmit = id => change(f.states.get(id)); f.allow(true); f.tick(); await f.c.quota.pump();
    assert.equal(f.c.store.delivery(q.a.messageId).state, 'refused'); assert.equal(f.sends.length, 0);
  }
});
test('native boundary refuses changed related authority, origins and handoff identity', async t => {
  const changes = [
    ['direct', (f, q) => f.c.store.db.prepare("UPDATE sessions SET authority='changed' WHERE id=?").run(q.id)],
    ['direct', (f, q) => f.c.store.db.prepare("UPDATE deliveries SET result=json_set(result,'$.wait.binding.source.kind','unknown') WHERE id=?").run(q.a.messageId)],
    ['ingress', (f, q) => f.c.store.db.prepare("UPDATE management_requests SET body=json_set(body,'$.originHash',?) WHERE id=?").run('c'.repeat(64), q.a.messageId)],
    ['ingress', (f, q) => f.c.store.db.prepare('INSERT INTO event_links VALUES (?,?,?,?,?,?,?)').run(q.id, randomUUID(), randomUUID(), 2, 2, '{}', 'Changed owner')],
    ['notification', (f, q) => { const b = f.c.store.delivery(q.a.messageId).result.wait.binding.source; f.c.store.db.prepare("UPDATE deliveries SET result=json_set(result,'$.outputContext.boot','changed') WHERE id=?").run(b.parentMessageId); }],
    ['event', (f, q) => { const b = f.c.store.delivery(q.a.messageId).result.wait.binding.source; guard({ id: b.worker }, 'Human takes over related session', {}, false); }],
    ['event', (f, q) => { const b = f.c.store.delivery(q.a.messageId).result.wait.binding.source; f.c.store.db.prepare('INSERT INTO event_faults VALUES (?,?,?)').run(b.worker, 'Fault', 'now'); }],
    ['manager', (f, q) => { const b = f.c.store.delivery(q.a.messageId).result.wait.binding.source; f.c.store.db.prepare("UPDATE sessions SET authority='changed' WHERE id=?").run(b.supervisor); }],
    ['manager', (f, q) => { const b = f.c.store.delivery(q.a.messageId).result.wait.binding.source; f.c.store.db.prepare("UPDATE deliveries SET result=json_remove(result,'$.supervision') WHERE id=?").run(q.a.messageId); guard({ id: b.supervisor }, 'Human takes over manager', {}, false); }],
    ['leadership', (f, q) => { const b = f.c.store.delivery(q.a.messageId).result.wait.binding.source; f.c.store.db.prepare('UPDATE leadership_handoffs SET wakeId=? WHERE id=?').run(randomUUID(), b.handoffId); }],
  ];
  for (const [kind, mutate] of changes) {
    const f = await fixture(t), q = await queuedSource(f, kind), before = f.sends.length;
    f.native.beforeAdmit = () => mutate(f, q); f.allow(true); f.tick(); await f.c.quota.pump();
    assert.equal(f.c.store.delivery(q.a.messageId).state, 'refused', kind); assert.equal(f.sends.length, before, kind);
  }
});


test('final native quota loss waits under the same identity and charges only once on resumption', async t => {
  const f = await fixture(t), q = await queuedSource(f, 'direct'), send = f.native.send;
  f.native.send = async (id, text, messageId) => {
    const state = f.states.get(id), agent = { id, session: {}, provider: 'codex', config: { model: state.model }, persistence: { sessionId: id }, pendingPermissions: [], lastUserMessageAt: null }, symbol = Symbol('native');
    const options = nativeTurnOptions({ journalFile: f.c.store.db.location(), agent, getAgent: () => agent, prompt: text, options: { clientMessageId: 'orca-control:' + messageId }, busy: () => false, symbol, now: f.c.quota.now });
    const error = quotaFailure({ code: 'read_failed' }, options);
    assert.throws(() => options[symbol]({}), /attempt already refused/);
    throw error;
  };
  f.allow(true); f.tick(); await f.c.quota.pump();
  assert.equal(f.c.store.delivery(q.a.messageId).state, 'queued'); assert.equal(f.c.store.get(q.id).mode, 'delegated'); assert.equal(f.c.allowance.status(PROGRAMME).admittedInstructions, 1);
  f.native.send = send; f.tick(); await f.c.quota.pump();
  assert.equal(f.c.store.delivery(q.a.messageId).state, 'delivered'); assert.equal(f.c.allowance.status(PROGRAMME).admittedInstructions, 1); assert.equal(f.sends.length, 1);
});

test('daemon factory enforces fresh queued account, quota, source and current agent', async t => {
  for (const scenario of ['ready', 'copy', 'denied', 'stale', 'account', 'takeover', 'replaced', 'busy']) {
    const f = await fixture(t), q = await queuedSource(f, 'direct'), symbol = Symbol('native-only'); f.allow(true); f.tick();
    const original = f.native.send;
    f.native.send = async (id, text, messageId) => {
      const state = f.states.get(id), agent = { id, session: {}, provider: 'codex', config: { model: state.model }, persistence: { sessionId: id }, pendingPermissions: [], lastUserMessageAt: null };
      let current = agent, busy = false;
      const options = nativeTurnOptions({ journalFile: f.c.store.db.location(), agent, getAgent: () => current, prompt: text, options: { clientMessageId: 'orca-control:' + messageId }, busy: () => busy, symbol, now: f.c.quota.now });
      const quota = await f.native.quota(id);
      if (scenario === 'denied') quota.ordinaryUsageAllowed = false;
      if (scenario === 'stale') quota.observedAt = '2000-01-01T00:00:00.000Z';
      if (scenario === 'account') quota.accountScope = 'codex:' + 'b'.repeat(64);
      if (scenario === 'takeover') f.c.takeover(id, 'Human cancels final native input');
      if (scenario === 'replaced') current = { ...agent, session: {} };
      if (scenario === 'copy') current = { ...agent };
      if (scenario === 'busy') busy = true;
      assert.equal(typeof options[symbol], 'function'); options[symbol](quota);
      await original(id, text, messageId);
    };
    await f.c.quota.pump();
    assert.equal(f.c.store.delivery(q.a.messageId).state, ['ready', 'copy'].includes(scenario) ? 'delivered' : ['denied', 'stale'].includes(scenario) ? 'queued' : 'refused', scenario);
    assert.equal(f.sends.length, ['ready', 'copy'].includes(scenario) ? 1 : 0, scenario);
  }
});

test('only classified pre-submit quota failures become waits', () => {
  for (const code of ['unavailable', 'read_failed', 'invalid_reply']) assert.match(quotaFailure({ code }, {}).message, /native admission refused/);
  for (const code of ['session_changed', 'admission_refused']) assert.match(quotaFailure({ code }).message, /native admission refused/);
});


test('provider-controlled error wording never permits retry after an actual send', async t => {
  const f = await fixture(t), q = await queuedSource(f, 'direct'), send = f.native.send;
  f.native.send = async (...args) => { await send(...args); throw Error('Orca native quota waiting: spoofed provider message'); };
  f.allow(true); f.tick(); await f.c.quota.pump(); assert.equal(f.c.store.delivery(q.a.messageId).state, 'uncertain');
  f.native.send = send; f.tick(); await f.c.quota.pump(); assert.equal(f.sends.length, 1);
});

test('operator quota status projects the real wait journal without reads, sends, charges or secrets', async t => {
  const f = await fixture(t), { id, capability } = await f.delegated(), messageId = randomUUID();
  await f.c.send({ sessionId: id, messageId, text: 'PRIVATE instruction' }, capability);
  const call = rpc(f.c, 'operator'), request = { method: 'quota-status', operator: 'operator' };
  await assert.rejects(call({ method: 'quota-status', capability }), /Operator/);
  await assert.rejects(call({ ...request, input: {} }), /no input/);
  const before = f.c.store.delivery(messageId), reads = f.reads.length;
  const status = await call(request), item = status.entries[0];
  assert.equal(item.state, 'waiting'); assert.equal(item.reason, 'provider-limit'); assert.equal(item.sessionId, id);
  assert.equal(status.version, 1); assert.equal(status.partial, false); assert.equal(item.messageId, messageId);
  for (const hidden of ['PRIVATE', 'accountScope', 'originHash', 'authority', 'capability', 'binding']) assert(!JSON.stringify(status).includes(hidden));
  assert.equal(f.reads.length, reads); assert.equal(f.sends.length, 0); assert.equal(f.c.allowance.status(PROGRAMME).admittedInstructions, 0); assert.deepEqual(f.c.store.delivery(messageId), before);
  f.reopen(); assert.equal((await rpc(f.c, 'operator')(request)).entries[0].messageId, messageId);
  f.allow(true); f.tick(); await f.c.quota.pump(); assert.deepEqual((await rpc(f.c, 'operator')(request)).entries, []); assert.equal(f.sends.length, 1);
});
test('quota status bounds malformed and revoked journal observations without exposing error text', async t => {
  const f = await fixture(t), { id, capability } = await f.delegated(), messageId = randomUUID();
  await f.c.send({ sessionId: id, messageId, text: 'PRIVATE' }, capability);
  const call = () => rpc(f.c, 'operator')({ method: 'quota-status', operator: 'operator' });
  f.c.store.db.prepare("UPDATE deliveries SET result=json_set(result,'$.wait.state','unknown','$.wait.reason','PRIVATE error','$.wait.nextCheckAt',-1) WHERE id=?").run(messageId);
  let item = (await call()).entries[0]; assert.equal(item.state, 'checking'); assert.equal(item.reason, 'verification'); assert.equal(item.nextCheckAt, null);
  f.c.store.db.prepare("UPDATE sessions SET generation=generation+1 WHERE id=?").run(id);
  item = (await call()).entries[0]; assert.equal(item.state, 'attention'); assert.equal(item.nextCheckAt, null);
  f.c.store.db.prepare("UPDATE deliveries SET result='broken PRIVATE' WHERE id=?").run(messageId);
  item = (await call()).entries[0]; assert.equal(item.state, 'attention'); assert.equal(item.since, null); assert(!JSON.stringify(item).includes('PRIVATE'));
  for (let i = 0; i < 65; i++) f.c.store.db.prepare("INSERT INTO deliveries VALUES (?,?,'send','{}','queued','{}')").run(randomUUID(), id);
  const status = await call(); assert.equal(status.entries.length, 64); assert.equal(status.partial, true);
});
// REVIEW-H6 F1: an automated send that would PARK on quota is held to the automation limit inside park()'s own
// transaction. Another writer fills the last row while the send awaits its quota read -- after every earlier check.
test('REVIEW-H6 F1: a manager assignment that parks on quota is refused at insertion when the limit is reached meanwhile', async t => {
  const f = await fixture(t), m = await f.manager(), fill = n => { f.c.store.db.exec('BEGIN'); while (f.c.store.db.prepare('SELECT count(*) n FROM deliveries').get().n < n) f.c.store.db.prepare("INSERT INTO deliveries VALUES (?,NULL,'fixture','{}','delivered',NULL)").run(randomUUID()); f.c.store.db.exec('COMMIT'); };
  fill(AUTOMATION_LIMIT - 1);
  f.native.duringQuota = () => { fill(AUTOMATION_LIMIT); f.native.duringQuota = null; };
  const messageId = randomUUID();
  await assert.rejects(f.c.manager.assign({ sessionId: m.id, workerId: m.worker, messageId, text: 'Assigned as the journal fills' }, m.token), /Journal automation budget reached/);
  assert.equal(f.c.store.delivery(messageId), null, 'nothing was parked'); assert.equal(f.c.store.db.prepare('SELECT count(*) n FROM deliveries').get().n, AUTOMATION_LIMIT);
});
