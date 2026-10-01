// DESIGN-E option H, approved: a prime seat declared human-held. Every test here drives the PRODUCTION
// admit() at the dispatch boundary, as role-channel-admission.test.mjs does, so "delivered" means the real
// pinned guard admitted it and "never dispatched" means the guard was never even asked. The mutation each
// test exists to kill is named beside it (DESIGN-E §4, E1..E23).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlStore } from './store.mjs';
import { Controller } from './controller.mjs';
import { Bindings } from './bindings.mjs';
import { RoleChannels, OPERATOR_ORIGIN, DELEGATED_ORIGIN } from './role-channels.mjs';
import { COMPANY, PROGRAMME } from './authority.mjs';
import { admit, guard, observation } from '../../tools/legacy-host-admission.fixture.mjs';
import { closeSeatingDefaults } from './role-defaults-fixture.mjs';
import { rpc } from './rpc.mjs';
import { macHeldNotifier, heldNoticeText } from './held-notifier.mjs';
import { requireUnpinnedAdmissionGuard } from './admission-guard-precondition.mjs';
requireUnpinnedAdmissionGuard();

const P = n => `22222222-2222-4222-8222-${String(n).padStart(12, '0')}`;
const T = n => `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`;
const OP = 'test-operator';
// src/control/admission-guard.mjs at bbc624cf9, the commit option H was designed and approved against.
// release/h2-controller: the guard changes in this host release, but only by C2 (8991a310, review GO). E21's point
// is unchanged -- option H adds nothing to the pinned guard -- so the pin is exactly the C2-reviewed bytes.
// P1 host release (prime S-2, CONTRACTS §3.6 rule 3): the guard gains the controller-home deny, so this
// tripwire moves from 95ded800… to exactly the P1 guard (c3f23a52…, R-F-A1: deny at the Claude launch choke
// point, replacing 66109873…). H7 item 5 then adds exactly one branch, admitQuestionAnswer (a seat's journaled answer to a
// pending question), so it moves again, from c3f23a52… to c06c0b45…. Any other edit still fails.
const GUARD_AT_BBC624CF9 = 'c06c0b45bc22d87cc94a3b48fdb2ba0ed4c56f31fa9523fbd5f2c3c0573e2f35';

async function seated(t) {
  const rotated = new Set(); let onAuthority = null;
  const issue = id => ({ id, companyId: COMPANY, parentId: id === PROGRAMME ? null : PROGRAMME, assigneeUserId: rotated.has(id) ? 'reassigned-board' : 'local-board', assigneeAgentId: null, status: 'in_progress' });
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orca-seat-inbox-')));
  const store = new ControlStore(path.join(dir, 'journal.sqlite'));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const states = new Map(); let admitted = 0, beforeAdmit = null;
  const nativeSends = new Map();
  const native = {
    route: () => undefined,
    inspect: async id => ({ status: 'idle', pending: 0, lastPromptId: null, lastUserAt: null, ...(states.get(id) ?? {}), ...observation(id) }),
    send: async (id, text, messageId) => {
      nativeSends.set(id, (nativeSends.get(id) ?? 0) + 1);
      await beforeAdmit?.(messageId);
      admit(store.db, { id, pendingPermissions: [], lastUserMessageAt: null }, text, messageId, false);
      admitted++; states.set(id, { ...(states.get(id) ?? {}), lastPromptId: messageId });
    },
    receipt: async () => null,
  };
  const source = { value: { observedAt: new Date().toISOString(), available: true, partial: false,
    projects: [{ id: P(1), name: 'Orca', description: null, status: 'in_progress' }],
    membership: [{ taskId: T(1), projectId: P(1) }], note: 'test project source' } };
  const control = new Controller({ store, native, authority: async id => { await onAuthority?.(id); return issue(id); } });
  control.bindings = new Bindings(control, async () => source.value, path.join(dir, 'grants', 'role'));
  control.channels = new RoleChannels(control, () => Date.now());
  const enrol = task => { const id = randomUUID(); store.created(id, task, path.join(dir, id)); states.set(id, { lastPromptId: null }); return id; };
  const prime = enrol(PROGRAMME), project = enrol(T(1));
  await control.bindings.assign({ role: 'prime', seat: 'delivery', sessionId: prime, expectedSessionGeneration: 1, expectedRevision: 0, note: 'Accountable prime seat for delivery' });
  await control.bindings.assign({ role: 'project-orchestrator', seat: P(1), sessionId: project, expectedSessionGeneration: 1, expectedRevision: 0, note: 'Owns delivery of this project' });
  await control.handback(prime, 'Delegated for the seat inbox verification');
  await control.handback(project, 'Delegated for the seat inbox verification');
  const role = async id => JSON.parse(fs.readFileSync((await control.bindings.grantRole({ sessionId: id, expectedGeneration: store.get(id).generation })).grantFile, 'utf8')).capability;
  const request = rpc(control, OP);
  closeSeatingDefaults(control);
  const openChannel = async (primeRevision = 1) => request({ method: 'channels-open', operator: OP,
    input: { primeSeat: 'delivery', projectSeat: P(1), purpose: 'Weekly delivery check-in between the board seat and this project',
      maxMessages: 6, expiresAt: new Date(Date.now() + 86400000).toISOString(), expectedPrimeRevision: primeRevision, expectedProjectRevision: 1 } });
  const channel = await openChannel();
  const primeCapability = await role(prime), projectCapability = await role(project);
  const report = (extra = {}) => { const messageId = randomUUID();
    return request({ method: 'channels-send', capability: projectCapability, input: { sessionId: project, channelId: channel.channelId, messageId, text: 'Project report: blocked on the release decision', ...extra } }).then(result => ({ messageId, result })); };
  // The prime becomes the human-facing lead: an operator takeover, exactly as a human reclaiming it.
  const humanPrime = () => control.takeover(prime, 'The human-facing lead holds this seat');
  const hold = (extra = {}) => request({ method: 'seat-hold', operator: OP, input: { role: 'prime', seat: 'delivery', expectedRevision: 1, expectedSessionGeneration: store.get(prime).generation, note: 'Held by the human-facing lead by design', ...extra } });
  const reply = (inReplyTo, extra = {}) => request({ method: 'seat-reply', operator: OP, input: { channelId: channel.channelId, messageId: randomUUID(), inReplyTo,
    text: 'Decision: ship behind the flag', expectedSeatRevision: 1, expectedHolderGeneration: store.get(prime).generation, ...extra } });
  const used = () => store.db.prepare('SELECT used FROM role_channels WHERE id=?').get(channel.channelId).used;
  const thread = () => request({ method: 'channels-thread', capability: projectCapability, input: { sessionId: project, channelId: channel.channelId } });
  return { dir, store, control, request, prime, project, channel, openChannel, enrol, states, report, humanPrime, hold, reply, used, thread,
    primeCapability, projectCapability, rotate: id => rotated.add(id), onAuthority: fn => { onAuthority = fn; },
    admitted: () => admitted, nativeSends: id => nativeSends.get(id) ?? 0, during: fn => { beforeAdmit = fn; } };
}
const row = (f, id) => f.store.db.prepare('SELECT * FROM role_channel_messages WHERE messageId=?').get(id);
const act = (f, id) => f.store.db.prepare('SELECT * FROM seat_operator_acts WHERE id=?').get(id);

test('E21: the pinned admission guard is byte-identical to bbc624cf9 -- option H is not a host release', () => {
  const now = createHash('sha256').update(fs.readFileSync(new URL('./admission-guard.mjs', import.meta.url))).digest('hex');
  assert.equal(now, GUARD_AT_BBC624CF9, 'admission-guard.mjs changed: that is a host release and is outside option H');
});

test('E1 E19 E13 E14: a hold is prime-only, human-only, journaled, and never moves the seat revision', async t => {
  const f = await seated(t);
  // E1: an orchestrator seat is never declared human-held.
  await assert.rejects(f.request({ method: 'seat-hold', operator: OP, input: { role: 'project-orchestrator', seat: P(1), expectedRevision: 1, expectedSessionGeneration: f.store.get(f.project).generation, note: 'An orchestrator must never be held' } }), /Only a prime seat/);
  // E19: a delegated holder speaks as itself.
  await assert.rejects(f.hold(), /only while its holder is under human control/);
  f.humanPrime();
  await assert.rejects(f.hold({ expectedRevision: 2 }), /revision changed/);
  await assert.rejects(f.hold({ expectedSessionGeneration: 1 }), /Session control changed/);
  const held = await f.hold();
  assert.equal(held.held, true); assert.equal(held.grantsAuthority, false); assert.equal(held.revision, 1);
  await assert.rejects(f.hold(), /already declared human-held/);
  // E13: the act is in the seat history that every operator surface already shows.
  const history = (await f.request({ method: 'bindings-status', operator: OP })).history;
  assert.equal(history[0].action, 'hold'); assert.equal(history[0].session, f.prime); assert.equal(history[0].revision, 1);
  // E14: the seat revision did not move, so the channel pinned to it is still usable.
  assert.equal(f.control.bindings.row('prime', 'delivery').revision, 1);
  assert.equal(f.control.channels.publish(f.control.channels.row(f.channel.channelId)).sendable, true);
  const route = await f.request({ method: 'bindings-route', operator: OP, input: { role: 'prime', seat: 'delivery' } });
  assert.equal(route.routing.held, true); assert.match(route.routing.blocked, /declared human-held/);
  // Release is journaled too, and stops the hold taking effect.
  await f.request({ method: 'seat-unhold', operator: OP, input: { role: 'prime', seat: 'delivery', expectedRevision: 1, note: 'The lead handed the seat on' } });
  assert.equal((await f.request({ method: 'bindings-status', operator: OP })).history[0].action, 'unhold');
  assert.equal(f.control.bindings.heldBy('prime', 'delivery'), null);
});

test('E11: every seat-* method is operator-gated and unreachable with a role capability', async t => {
  const f = await seated(t);
  f.humanPrime();
  for (const method of ['seat-hold', 'seat-unhold', 'seat-inbox', 'seat-receipt', 'seat-reply']) {
    await assert.rejects(f.request({ method, input: { role: 'prime', seat: 'delivery' } }), /Operator authorization required/, method);
    await assert.rejects(f.request({ method, input: { role: 'prime', seat: 'delivery' }, capability: f.projectCapability }), /Operator authorization required/, method);
    await assert.rejects(f.request({ method, input: { role: 'prime', seat: 'delivery' }, operator: 'wrong-operator' }), /Operator authorization required/, method);
  }
});

test('E15: a human prime WITHOUT a hold keeps D\'s hard refusal -- nothing is written and nothing spent', async t => {
  const f = await seated(t);
  f.humanPrime();
  const before = f.used();
  await assert.rejects(f.report(), /under human control; a delegated send would be refused/);
  assert.equal(f.used(), before);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM role_channel_messages').get().n, 0);
});

test('E4 E9: a held message spends allowance, is never dispatched, is refused by the pinned guard itself, and survives a handback undelivered', async t => {
  const f = await seated(t);
  f.humanPrime(); await f.hold();
  const before = f.used(), sends = f.nativeSends(f.prime);
  const { messageId, result } = await f.report();
  assert.equal(result.state, 'held'); assert.equal(result.accepted, false);
  assert.equal(f.used(), before + 1, 'E9: a held message spends one allowance, like any send');
  assert.equal(row(f, messageId).state, 'held');
  assert.equal(f.store.delivery(messageId), null, 'no delivery journal row: nothing was put on the wire');
  assert.equal(f.nativeSends(f.prime), sends);
  // P2, independently of the controller: had anything dispatched it, the unchanged guard refuses a held row.
  f.store.db.prepare("INSERT INTO deliveries(id,session,kind,body,state,result) VALUES (?,?,'send',?,'intent',?)").run(messageId, f.prime,
    JSON.stringify({ sessionId: f.prime, messageId, text: row(f, messageId).text }),
    JSON.stringify({ generation: f.store.get(f.prime).generation, channel: { channelId: f.channel.channelId, fromSeat: P(1), toSeat: 'delivery', fromSession: f.project, inReplyTo: null } }));
  assert.throws(() => admit(f.store.db, { id: f.prime, pendingPermissions: [], lastUserMessageAt: null }, row(f, messageId).text, messageId, false), /changed role channel approval/);
  f.store.db.prepare('DELETE FROM deliveries WHERE id=?').run(messageId);
  // E4: the human hands the seat back. The held message is NOT delivered -- not by handback, not by the pump.
  await f.control.handback(f.prime, 'The lead delegates the seat again');
  await f.control.channels.pump();
  assert.equal(row(f, messageId).state, 'held');
  assert.equal(f.store.delivery(messageId), null);
  assert.equal(f.nativeSends(f.prime), sends);
  // Buckets name it, so it never falls into `other`.
  const listed = (await f.request({ method: 'channels-list', capability: f.projectCapability, input: { sessionId: f.project } })).channels[0];
  assert.equal(listed.outbound.held, 1); assert.equal(listed.outbound.other, 0);
});

test('E18: the held path still runs every sender check before it writes or spends', async t => {
  const f = await seated(t);
  f.humanPrime(); await f.hold();
  const before = f.used();
  f.rotate(T(1));
  await assert.rejects(f.report(), /task authority changed/);
  assert.equal(f.used(), before);
  await assert.rejects(f.request({ method: 'channels-send', capability: 'forged', input: { sessionId: f.project, channelId: f.channel.channelId, messageId: randomUUID(), text: 'x' } }), /Role capability revoked or invalid/);
  await f.request({ method: 'channels-close', operator: OP, input: { channelId: f.channel.channelId, note: 'Closing to prove the held path checks it' } });
  await assert.rejects(f.report(), /Channel is closed/);
});

test('E2: a hold does nothing while its holder is delegated -- messages deliver natively and seat-reply is refused', async t => {
  const f = await seated(t);
  f.humanPrime(); await f.hold();
  const { messageId } = await f.report();
  await f.control.handback(f.prime, 'The lead delegates the seat again');
  assert.equal(f.control.bindings.heldBy('prime', 'delivery'), null);
  const second = await f.report();
  assert.equal(second.result.state, 'delivered', 'a delegated holder receives through the ordinary path, admitted by the real guard');
  assert.equal(f.store.delivery(second.messageId).state, 'delivered');
  await assert.rejects(f.reply(messageId), /not declared human-held|no longer under human control/);
});

test('E3: a hold is pinned to the seat revision and holder, so re-seating the prime ends it with no cleanup', async t => {
  const f = await seated(t);
  f.humanPrime(); await f.hold();
  const other = f.enrol(PROGRAMME); // human by creation, exactly like the old holder
  await f.control.bindings.assign({ role: 'prime', seat: 'delivery', sessionId: other, expectedSessionGeneration: 1, expectedRevision: 1, note: 'A different lead takes the prime seat' });
  assert.equal(f.control.bindings.heldBy('prime', 'delivery'), null);
  // A channel approved to the new (human, local) holder: the old hold does not follow the seat to it.
  await f.request({ method: 'channels-close', operator: OP, input: { channelId: f.channel.channelId, note: 'Invalidated by the re-seating; closing' } });
  const fresh = await f.openChannel(2);
  await assert.rejects(f.request({ method: 'channels-send', capability: f.projectCapability, input: { sessionId: f.project, channelId: fresh.channelId, messageId: randomUUID(), text: 'Report to the new holder' } }), /under human control/);
  assert.equal(f.control.channels.heldFor('delivery', other), null);
  // Re-seat the ORIGINAL holder at a new revision. Only the revision pin tells this apart from the seating
  // the hold was declared at: same session, still human.
  await f.request({ method: 'channels-close', operator: OP, input: { channelId: fresh.channelId, note: 'Closing before the seat moves back' } });
  await f.control.bindings.assign({ role: 'prime', seat: 'delivery', sessionId: f.prime, expectedSessionGeneration: f.store.get(f.prime).generation, expectedRevision: 2, note: 'The original lead takes the seat back' });
  assert.equal(f.control.bindings.row('prime', 'delivery').revision, 3);
  assert.equal(f.control.bindings.heldBy('prime', 'delivery'), null, 'a hold declared at revision 1 does not apply at revision 3');
  const back = await f.openChannel(3);
  await assert.rejects(f.request({ method: 'channels-send', capability: f.projectCapability, input: { sessionId: f.project, channelId: back.channelId, messageId: randomUUID(), text: 'Report after re-seating' } }), /under human control/);
  const holds = (await f.request({ method: 'bindings-status', operator: OP })).holds;
  assert.deepEqual(holds.map(h => [h.revision, h.effective]), [[1, false]]);
  // The session pin, which no API sequence can separate from the revision pin (every re-seat bumps the
  // revision): a hold row at the CURRENT revision naming some other session -- a hand-edited or stale
  // journal -- must never make the current holder held.
  f.store.db.prepare('INSERT INTO seat_human_holds VALUES (?,?,?,?,?,?)').run('prime', 'delivery', 3, other, 'A row naming the wrong session', new Date().toISOString());
  assert.equal(f.control.bindings.heldBy('prime', 'delivery'), null, 'a hold names the session it was declared for, not whoever holds the seat now');
});

test('E5 E12: an operator reply is admitted by the real guard, written to its own table, and labelled in the thread', async t => {
  const f = await seated(t);
  f.humanPrime(); await f.hold();
  const { messageId } = await f.report();
  const inbox = await f.request({ method: 'seat-inbox', operator: OP, input: { role: 'prime', seat: 'delivery' } });
  assert.equal(inbox.messages[0].messageId, messageId); assert.equal(inbox.messages[0].untrustedText, 'Project report: blocked on the release decision');
  assert.equal(inbox.messages[0].replyable, true); assert.equal(inbox.hold.session, f.prime);
  const before = f.used(), admitted = f.admitted();
  const sent = await f.reply(messageId);
  assert.equal(sent.state, 'delivered'); assert.equal(sent.origin, OPERATOR_ORIGIN); assert.equal(sent.inReplyTo, messageId);
  assert.equal(f.admitted(), admitted + 1, 'admitted by the unchanged production guard');
  assert.equal(f.used(), before + 1, 'E9: a reply spends the channel allowance');
  // It went through the ordinary operator path into the delivery journal, labelled by the controller.
  const d = f.store.delivery(sent.messageId);
  assert.equal(d.kind, 'send'); assert.equal(d.session, f.project); assert.equal(d.state, 'delivered');
  assert.match(JSON.parse(d.body).text, /^\[Orca controller: operator reply on behalf of prime seat "delivery"/);
  assert.equal(d.result.channel, undefined, 'no channel declaration: the guard never sees this as a seat message');
  // E5: never a role_channel_messages row, so never readable as a delegated seat message.
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM role_channel_messages WHERE fromSession=?').get(f.prime).n, 0);
  assert.equal(row(f, sent.messageId), undefined);
  assert.equal(act(f, sent.messageId).kind, 'reply');
  // E12: the recipient sees which path spoke for the seat.
  const th = await f.thread();
  const mine = th.messages.find(m => m.messageId === messageId), theirs = th.messages.find(m => m.messageId === sent.messageId);
  assert.equal(mine.origin, DELEGATED_ORIGIN); assert.equal(mine.state, 'held');
  assert.equal(theirs.origin, OPERATOR_ORIGIN); assert.equal(theirs.fromSeat, 'delivery'); assert.equal(theirs.holderSession, f.prime);
  assert.equal(theirs.inReplyTo, messageId); assert.equal(theirs.text, 'Decision: ship behind the flag');
  assert.match(th.authority, /Only role_thread establishes who sent a message/);
  // The orchestrator can take a receipt on it and answer it; that answer is held in turn.
  const read = await f.request({ method: 'channels-read', capability: f.projectCapability, input: { sessionId: f.project, channelId: f.channel.channelId, messageId: sent.messageId, note: 'Read the decision' } });
  assert.equal(read.origin, OPERATOR_ORIGIN);
  const answer = await f.report({ inReplyTo: sent.messageId, text: 'Acknowledged; shipping behind the flag' });
  assert.equal(answer.result.state, 'held');
});

test('E6 E7 E8 E10: a reply answers exactly one message delivered or held for the seat, once, at pinned revisions', async t => {
  const f = await seated(t);
  // A message the PRIME sent while delegated: the operator may never "answer" the seat's own words.
  const own = randomUUID();
  await f.request({ method: 'channels-send', capability: f.primeCapability, input: { sessionId: f.prime, channelId: f.channel.channelId, messageId: own, text: 'Prime asks for a status report' } });
  f.humanPrime(); await f.hold();
  const { messageId } = await f.report();
  // E6: no parent, no reply.
  await assert.rejects(f.request({ method: 'seat-reply', operator: OP, input: { channelId: f.channel.channelId, messageId: randomUUID(), text: 'Unprompted', expectedSeatRevision: 1, expectedHolderGeneration: f.store.get(f.prime).generation } }), /must answer one specific message/);
  // E8: not a message to the seat.
  await assert.rejects(f.reply(own), /A reply answers one message delivered or held for this prime seat/);
  await assert.rejects(f.reply(randomUUID()), /A reply answers one message/);
  // E10: stale pins.
  await assert.rejects(f.reply(messageId, { expectedSeatRevision: 2 }), /prime seat changed/);
  await assert.rejects(f.reply(messageId, { expectedHolderGeneration: 1 }), /holder session control changed/);
  const before = f.used();
  const first = await f.reply(messageId);
  assert.equal(first.state, 'delivered');
  // E7: one reply per parent.
  await assert.rejects(f.reply(messageId, { text: 'A second answer to the same report' }), /already has an operator reply/);
  // Identity: the identical resend is a status read; the same identity with other content is refused.
  const again = await f.request({ method: 'seat-reply', operator: OP, input: { channelId: f.channel.channelId, messageId: first.messageId, inReplyTo: messageId, text: 'Decision: ship behind the flag', expectedSeatRevision: 1, expectedHolderGeneration: f.store.get(f.prime).generation } });
  assert.equal(again.resend, true); assert.equal(again.state, 'delivered');
  await assert.rejects(f.request({ method: 'seat-reply', operator: OP, input: { channelId: f.channel.channelId, messageId: first.messageId, inReplyTo: messageId, text: 'Different words', expectedSeatRevision: 1, expectedHolderGeneration: f.store.get(f.prime).generation } }), /identity already used/);
  // An identity already used anywhere else is refused as well.
  await assert.rejects(f.reply(messageId, { messageId }), /identity already used|already has an operator reply/);
  assert.equal(f.used(), before + 1);
});

test('E17 T5: human input on the recipient before or during the reply is a refusal and a takeover, never a delivery', async t => {
  const f = await seated(t);
  f.humanPrime(); await f.hold();
  const a1 = await f.report(), a2 = await f.report();
  // Before the observation: the controller sees humanAt move and takes the orchestrator over.
  guard({ id: f.project }, 'a human types into the orchestrator', undefined, false);
  await assert.rejects(f.reply(a1.messageId), /Human activity or changed identity revoked delegation/);
  assert.equal(f.store.get(f.project).mode, 'human');
  // Refused before intent: nothing admitted, so the act is voided and does not burn its parent (F4).
  const failed = f.store.db.prepare('SELECT * FROM seat_operator_acts WHERE parent=?').get(a1.messageId);
  assert.equal(failed.state, 'failed'); assert.equal(failed.kind, 'void-reply');
  assert.equal(f.store.delivery(failed.id), null);
  // Re-delegate, then land a human input in the window between durable intent and native admission: the
  // pinned guard refuses it at its own grantedAt fence and the controller takes the session over again.
  await f.control.handback(f.project, 'The orchestrator is delegated again');
  f.during(() => { guard({ id: f.project }, 'a human types during dispatch', undefined, false); });
  const late = await f.reply(a2.messageId);
  f.during(null);
  assert.equal(late.state, 'refused');
  assert.equal(f.store.get(f.project).mode, 'human');
  // Refused AT the native boundary: a delivery row exists, so this one stays the parent's reply for good.
  assert.equal(act(f, late.messageId).kind, 'reply');
  await f.control.handback(f.project, 'The orchestrator is delegated once more');
  await assert.rejects(f.reply(a2.messageId), /already has an operator reply/);
  // ...while the voided one's parent can still be answered.
  assert.equal((await f.reply(a1.messageId)).state, 'delivered');
});

test('E17: a busy recipient admits nothing; only the identical resend retries it, at no further allowance', async t => {
  const f = await seated(t);
  f.humanPrime(); await f.hold();
  const { messageId } = await f.report();
  f.states.set(f.project, { ...f.states.get(f.project), status: 'running' });
  const id = randomUUID(), input = { channelId: f.channel.channelId, messageId: id, inReplyTo: messageId, text: 'Decision: hold the release', expectedSeatRevision: 1, expectedHolderGeneration: f.store.get(f.prime).generation };
  const before = f.used();
  const busy = await f.request({ method: 'seat-reply', operator: OP, input });
  assert.equal(busy.state, 'busy'); assert.equal(f.store.delivery(id), null);
  f.states.set(f.project, { ...f.states.get(f.project), status: 'idle' });
  const done = await f.request({ method: 'seat-reply', operator: OP, input });
  assert.equal(done.state, 'delivered');
  assert.equal(f.used(), before + 1);
});

test('E20: a holder handed back between the pre-check and the reservation leaves nothing held and spends nothing', async t => {
  const f = await seated(t);
  f.humanPrime(); await f.hold();
  const before = f.used();
  // assertSenderAuthority is the one await between the pre-check and the reservation transaction.
  f.onAuthority(id => { if (id === T(1)) { f.store.transfer(f.prime, 'delegated', 'Handed back mid-send'); f.onAuthority(null); } });
  await assert.rejects(f.report(), /changed control during reservation/);
  assert.equal(f.used(), before);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM role_channel_messages WHERE state='held'").get().n, 0);
});

test('E16: a pending message comes to rest held only for a held prime, and only if its sender still stands', async t => {
  const f = await seated(t);
  // Prime busy: the report is deferred pending.
  f.states.set(f.prime, { ...f.states.get(f.prime), status: 'running' });
  const kept = await f.report();
  assert.equal(kept.result.state, 'pending');
  await f.control.channels.pump(); // the pass send() started finishes with the prime still busy
  assert.equal(row(f, kept.messageId).state, 'pending');
  f.humanPrime(); await f.hold();
  await f.control.channels.pump();
  assert.equal(row(f, kept.messageId).state, 'held', 'readable by the human instead of lost: ' + row(f, kept.messageId).failure);
  assert.equal(f.store.delivery(kept.messageId), null);

  // The same, when the prime is taken back DURING a pump pass: after the pump read it as delegated, inside
  // control.send (its recipient-authority lookup), before anything is admitted.
  const r2 = await seated(t);
  r2.states.set(r2.prime, { ...r2.states.get(r2.prime), status: 'running' });
  const mid = await r2.report();
  await r2.control.channels.pump();
  r2.states.set(r2.prime, { ...r2.states.get(r2.prime), status: 'idle' });
  r2.onAuthority(id => { if (id === PROGRAMME) { r2.onAuthority(null); r2.control.takeover(r2.prime, 'The lead reclaims the seat mid-pass');
    r2.control.bindings.hold({ role: 'prime', seat: 'delivery', expectedRevision: 1, expectedSessionGeneration: r2.store.get(r2.prime).generation, note: 'Held by the human-facing lead by design' }); } });
  await r2.control.channels.pump();
  assert.equal(r2.store.get(r2.prime).mode, 'human');
  assert.equal(row(r2, mid.messageId).state, 'held', 'taken back mid-pass: ' + row(r2, mid.messageId).failure);
  assert.equal(r2.store.delivery(mid.messageId), null);
  // Without a hold the identical race still fails, as before this change.
  const r3 = await seated(t);
  r3.states.set(r3.prime, { ...r3.states.get(r3.prime), status: 'running' });
  const lost3 = await r3.report();
  await r3.control.channels.pump();
  r3.states.set(r3.prime, { ...r3.states.get(r3.prime), status: 'idle' });
  r3.onAuthority(id => { if (id === PROGRAMME) { r3.control.takeover(r3.prime, 'The lead reclaims the seat mid-pass'); r3.onAuthority(null); } });
  await r3.control.channels.pump();
  assert.equal(row(r3, lost3.messageId).state, 'failed');

  // A prime taken back between passes with NO hold: still failed, as before this change.
  const r4 = await seated(t);
  r4.states.set(r4.prime, { ...r4.states.get(r4.prime), status: 'running' });
  const lost4 = await r4.report();
  await r4.control.channels.pump();
  r4.humanPrime();
  await r4.control.channels.pump();
  assert.equal(row(r4, lost4.messageId).state, 'failed');

  // A pending message to a taken-over ORCHESTRATOR still fails, hold on the prime or not.
  const g = await seated(t);
  g.states.set(g.project, { ...g.states.get(g.project), status: 'running' });
  const down = randomUUID();
  const r = await g.request({ method: 'channels-send', capability: g.primeCapability, input: { sessionId: g.prime, channelId: g.channel.channelId, messageId: down, text: 'Prime to project, deferred' } });
  assert.equal(r.state, 'pending');
  g.control.takeover(g.project, 'A human reclaims the orchestrator');
  await g.control.channels.pump();
  assert.equal(row(g, down).state, 'failed');

  // A pending message whose SENDER lost its authority fails rather than being held.
  const h = await seated(t);
  h.states.set(h.prime, { ...h.states.get(h.prime), status: 'running' });
  const lost = await h.report();
  await h.control.channels.pump(); // settle the pass send() started, so the next pass is the one under test
  h.humanPrime(); await h.hold();
  h.control.takeover(h.project, 'The sender is taken over before delivery');
  await h.control.channels.pump();
  assert.equal(row(h, lost.messageId).state, 'failed');
});

test('seat-receipt records operator consumption of a held message, separately from a seat receipt', async t => {
  const f = await seated(t);
  f.humanPrime(); await f.hold();
  const { messageId } = await f.report();
  const r = await f.request({ method: 'seat-receipt', operator: OP, input: { channelId: f.channel.channelId, messageId, note: 'Read by the lead' } });
  assert.equal(r.origin, OPERATOR_ORIGIN); assert.equal(r.accepted, false);
  await f.request({ method: 'seat-receipt', operator: OP, input: { channelId: f.channel.channelId, messageId, note: 'Read by the lead' } });
  await assert.rejects(f.request({ method: 'seat-receipt', operator: OP, input: { channelId: f.channel.channelId, messageId, note: 'A different note' } }), /identity conflict/);
  const m = (await f.thread()).messages.find(x => x.messageId === messageId);
  assert.equal(m.receipt, null, 'not a receipt by the holder\'s own delegated session');
  assert.equal(m.operatorReceipt.note, 'Read by the lead'); assert.equal(m.operatorReceipt.origin, OPERATOR_ORIGIN);
});

test('E22: no H operation writes session control, fence columns or role credentials', async t => {
  const f = await seated(t);
  f.humanPrime();
  const snap = () => JSON.stringify({ sessions: f.store.db.prepare('SELECT id,mode,generation,grantedAt,boot,expected,expectedAt,token FROM sessions ORDER BY id').all(),
    credentials: f.store.db.prepare('SELECT * FROM role_credentials ORDER BY session').all(), transfers: f.store.db.prepare('SELECT count(*) n FROM transfers').get().n });
  const holder = () => JSON.stringify(f.store.db.prepare('SELECT mode,generation,grantedAt,boot,expected,expectedAt,token FROM sessions WHERE id=?').get(f.prime));
  const base = snap();
  await f.hold(); assert.equal(snap(), base, 'seat-hold');
  const { messageId } = await f.report(); assert.equal(snap(), base, 'held inbound');
  await f.request({ method: 'seat-inbox', operator: OP, input: { role: 'prime', seat: 'delivery' } }); assert.equal(snap(), base, 'seat-inbox');
  await f.request({ method: 'seat-receipt', operator: OP, input: { channelId: f.channel.channelId, messageId, note: 'Read by the lead' } }); assert.equal(snap(), base, 'seat-receipt');
  const h = holder(), creds = JSON.stringify(f.store.db.prepare('SELECT * FROM role_credentials ORDER BY session').all());
  await f.reply(messageId);
  // A delivered reply legitimately advances the RECIPIENT's expected prompt, as any operator-send does; the
  // holder and every credential are untouched.
  assert.equal(holder(), h, 'seat-reply: holder session'); assert.equal(JSON.stringify(f.store.db.prepare('SELECT * FROM role_credentials ORDER BY session').all()), creds, 'seat-reply: credentials');
  const mid = snap();
  await f.request({ method: 'seat-unhold', operator: OP, input: { role: 'prime', seat: 'delivery', expectedRevision: 1, note: 'The lead handed the seat on' } });
  assert.equal(snap(), mid, 'seat-unhold');
});

// ===== Independent review (E-REVIEW.md §7.1), lifted from reviewer-artifacts/reviewer-attacks.test.mjs and made
// assertive. Each kills a hand variant of the attacker-class mutations that the tests above let survive.
const replyInput = (f, extra) => ({ method: 'seat-reply', operator: OP, input: { channelId: f.channel.channelId, messageId: randomUUID(), text: 'Operator answer',
  expectedSeatRevision: 1, expectedHolderGeneration: f.store.get(f.prime).generation, ...extra } });
const refusal = p => p.then(() => 'ACCEPTED', e => e.message);

test('Q1 (H-E6b): seat-reply never opens a conversation -- no parent, fabricated, own outbound, an operator act, another channel', async t => {
  const f = await seated(t);
  const own = randomUUID();
  await f.request({ method: 'channels-send', capability: f.primeCapability, input: { sessionId: f.prime, channelId: f.channel.channelId, messageId: own, text: 'Prime outbound' } });
  f.humanPrime(); await f.hold();
  const { messageId } = await f.report();
  const first = await f.request(replyInput(f, { inReplyTo: messageId }));
  assert.equal(first.state, 'delivered');
  for (const [name, input] of [['no inReplyTo', { inReplyTo: undefined }], ['null inReplyTo', { inReplyTo: null }], ['fabricated', { inReplyTo: randomUUID() }],
    ['own outbound', { inReplyTo: own }], ['operator act as parent', { inReplyTo: first.messageId }]]) {
    assert.notEqual(await refusal(f.request(replyInput(f, input))), 'ACCEPTED', name);
  }
  await f.request({ method: 'channels-close', operator: OP, input: { channelId: f.channel.channelId, note: 'Closing to test cross-channel parents' } });
  const ch2 = await f.openChannel(1);
  assert.notEqual(await refusal(f.request(replyInput(f, { channelId: ch2.channelId, inReplyTo: messageId }))), 'ACCEPTED', 'parent from another channel');
  assert.match(await refusal(f.request(replyInput(f, { inReplyTo: messageId }))), /Channel is closed/);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM seat_operator_acts WHERE kind='reply'").get().n, 1);
});

test('Q5 (H-E4b, X-held-via-resend): held is never dispatched -- handback, sender resend, restart, operator-send, unhold, re-seat', async t => {
  const f = await seated(t);
  f.humanPrime(); await f.hold();
  const held = [await f.report(), await f.report()].map(x => x.messageId);
  const stillHeld = label => { for (const id of held) { assert.equal(row(f, id).state, 'held', label); assert.notEqual(f.store.delivery(id)?.state, 'delivered', label); } };
  await f.control.handback(f.prime, 'handback'); await f.control.channels.pump(); stillHeld('handback + pump');
  // The sender's own idempotent resend of a held id (D F3) is a status read, never a re-dispatch.
  const sends = f.nativeSends(f.prime);
  const again = await f.request({ method: 'channels-send', capability: f.projectCapability, input: { sessionId: f.project, channelId: f.channel.channelId, messageId: held[0], text: 'Project report: blocked on the release decision' } });
  assert.equal(again.state, 'held'); assert.equal(again.resend, true);
  assert.equal(f.nativeSends(f.prime), sends, 'no native send for a resend of a held id');
  await f.control.channels.pump(); stillHeld('sender resend + pump');
  await assert.rejects(f.request({ method: 'channels-send', capability: f.projectCapability, input: { sessionId: f.project, channelId: f.channel.channelId, messageId: held[0], text: 'Different' } }), /identity already used/);
  f.control.channels = new RoleChannels(f.control, () => Date.now()); // a daemon restart over the same journal
  await f.control.channels.pump(); stillHeld('restart + pump');
  // Pre-existing path: operator-send with a held id. The unchanged guard refuses it; the row stays held.
  await f.request({ method: 'operator-send', operator: OP, input: { sessionId: f.prime, messageId: held[1], text: 'Project report: blocked on the release decision', expectedGeneration: f.store.get(f.prime).generation } }).catch(() => null);
  stillHeld('operator-send of a held id');
  if (f.store.get(f.prime).mode === 'delegated') f.humanPrime();
  await f.request({ method: 'seat-unhold', operator: OP, input: { role: 'prime', seat: 'delivery', expectedRevision: 1, note: 'Released for the test' } });
  await f.control.handback(f.prime, 'handback after unhold'); await f.control.channels.pump(); stillHeld('unhold + handback + pump');
  const other = f.enrol(PROGRAMME);
  await f.control.bindings.assign({ role: 'prime', seat: 'delivery', sessionId: other, expectedSessionGeneration: 1, expectedRevision: 1, note: 'A different delegated prime' });
  await f.control.handback(other, 'new delegated prime'); await f.control.channels.pump(); stillHeld('re-seat + pump');
});

test('Q5b (H-E4a): held rows stay held when a PENDING row to the same re-delegated prime is pumped and delivered', async t => {
  const f = await seated(t);
  f.humanPrime(); await f.hold();
  const held = [await f.report(), await f.report()].map(x => x.messageId);
  await f.control.handback(f.prime, 'handback');
  f.states.set(f.prime, { ...f.states.get(f.prime), status: 'running' });
  const p = await f.report(); assert.equal(p.result.state, 'pending');
  await f.control.channels.pump();
  f.states.set(f.prime, { ...f.states.get(f.prime), status: 'idle' });
  await f.control.channels.pump(); await f.control.channels.pump();
  assert.equal(row(f, p.messageId).state, 'delivered', 'the pending one is delivered normally');
  for (const id of held) { assert.equal(row(f, id).state, 'held'); assert.equal(f.store.delivery(id), null); }
});

test('Q6 (H-E17b): a hold lifted between reservation and dispatch refuses the reply at control.send\'s check', async t => {
  const f = await seated(t);
  f.humanPrime(); await f.hold();
  const { messageId } = await f.report();
  const admitted = f.admitted();
  // control.send's recipient-authority lookup is the await between reservation and dispatch.
  f.onAuthority(id => { if (id === T(1)) { f.onAuthority(null); f.control.bindings.unhold({ role: 'prime', seat: 'delivery', expectedRevision: 1, note: 'Lifted mid-dispatch by the reviewer' }); } });
  await assert.rejects(f.request(replyInput(f, { inReplyTo: messageId })), /not declared human-held/);
  assert.equal(f.admitted(), admitted);
  assert.equal(f.nativeSends(f.project), 0);
});

test('Q7 (H-E17c): a busy reply retried after the recipient was taken over and handed back is refused -- the generation is pinned', async t => {
  const f = await seated(t);
  f.humanPrime(); await f.hold();
  const { messageId } = await f.report();
  f.states.set(f.project, { ...f.states.get(f.project), status: 'running' });
  const input = { channelId: f.channel.channelId, messageId: randomUUID(), inReplyTo: messageId, text: 'busy then retried', expectedSeatRevision: 1, expectedHolderGeneration: f.store.get(f.prime).generation };
  assert.equal((await f.request({ method: 'seat-reply', operator: OP, input })).state, 'busy');
  f.control.takeover(f.project, 'human reclaims orchestrator');
  f.states.set(f.project, { ...f.states.get(f.project), status: 'idle' });
  await f.control.handback(f.project, 'redelegated');
  await assert.rejects(f.request({ method: 'seat-reply', operator: OP, input }), /Control changed/);
  assert.equal(f.nativeSends(f.project), 0);
});

test('Q8 (H-E11b): static -- every H operator method is dispatched only after the operator-secret gate in rpc.mjs', () => {
  const src = fs.readFileSync(new URL('./rpc.mjs', import.meta.url), 'utf8');
  const gate = src.indexOf("throw new Error('Operator authorization required')");
  assert.ok(gate > 0);
  for (const call of ['bindings.hold(', 'bindings.unhold(', 'channels.inbox(', 'channels.seatReceipt(', 'channels.seatReply(', 'channels.reconcileReply(']) {
    let i = -1, seen = 0; while ((i = src.indexOf(call, i + 1)) >= 0) { seen++; assert.ok(i > gate, `${call} reachable before the operator gate`); }
    assert.ok(seen >= 1, `${call} is wired`);
  }
});

test('A6 (X-reply-after-unhold): no reply after seat-unhold while the holder is still human -- fresh or busy resend', async t => {
  const f = await seated(t);
  f.humanPrime(); await f.hold();
  const a = await f.report(), b = await f.report();
  f.states.set(f.project, { ...f.states.get(f.project), status: 'running' });
  const busyIn = { channelId: f.channel.channelId, messageId: randomUUID(), inReplyTo: a.messageId, text: 'busy reply', expectedSeatRevision: 1, expectedHolderGeneration: f.store.get(f.prime).generation };
  assert.equal((await f.request({ method: 'seat-reply', operator: OP, input: busyIn })).state, 'busy');
  f.states.set(f.project, { ...f.states.get(f.project), status: 'idle' });
  await f.request({ method: 'seat-unhold', operator: OP, input: { role: 'prime', seat: 'delivery', expectedRevision: 1, note: 'Lifted before the resend' } });
  assert.equal(f.store.get(f.prime).mode, 'human');
  await assert.rejects(f.request({ method: 'seat-reply', operator: OP, input: busyIn }), /not declared human-held/);
  await assert.rejects(f.request(replyInput(f, { inReplyTo: b.messageId })), /not declared human-held/);
  assert.equal(f.nativeSends(f.project), 0);
});

// ===== Prime decisions on the review =====
test('F1: an operator reply to a parent the holder already answered natively is refused; an unanswered pre-hold parent is not', async t => {
  const f = await seated(t);
  const answered = await f.report(), open = await f.report();
  assert.equal(answered.result.state, 'delivered');
  await f.request({ method: 'channels-send', capability: f.primeCapability, input: { sessionId: f.prime, channelId: f.channel.channelId, messageId: randomUUID(), inReplyTo: answered.messageId, text: 'Prime answered this itself while delegated' } });
  f.humanPrime(); await f.hold();
  await assert.rejects(f.request(replyInput(f, { inReplyTo: answered.messageId })), /already answered this message itself/);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM seat_operator_acts').get().n, 0, 'nothing reserved, nothing spent');
  assert.equal((await f.request(replyInput(f, { inReplyTo: open.messageId }))).state, 'delivered');
});

function quotaFixture(f, allowed) {
  f.states.set(f.project, { ...f.states.get(f.project), nativeId: 'native-' + f.project, model: 'gpt-5', serviceTier: null });
  f.control.native.quota = async id => { const c = await f.control.native.inspect(id);
    return { provider: 'codex', sessionId: c.nativeId, model: c.model, serviceTier: c.serviceTier, accountScope: 'codex:' + 'a'.repeat(64), observedAt: new Date().toISOString(), ordinaryUsageAllowed: allowed(), limits: [] }; };
}
test('F2: a seat reply NEVER parks on quota -- it comes back busy, nothing is queued, native.send is never called', async t => {
  const f = await seated(t);
  f.humanPrime(); await f.hold();
  const { messageId } = await f.report();
  let allowed = false; quotaFixture(f, () => allowed);
  const input = replyInput(f, { inReplyTo: messageId, text: 'Operator reply while quota waits' }).input;
  const r = await f.request({ method: 'seat-reply', operator: OP, input });
  assert.equal(r.state, 'busy'); assert.match(r.failure, /never parked on quota/);
  assert.equal(f.store.delivery(input.messageId), null, 'no delivery row: nothing is queued for a replay without check()');
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM deliveries WHERE state='queued'").get().n, 0);
  allowed = true;
  await f.control.quota.pump();
  assert.equal(f.nativeSends(f.project), 0, 'the quota pump has nothing to replay');
  // The operator retries; with quota back and the hold intact it is delivered through the full path.
  assert.equal((await f.request({ method: 'seat-reply', operator: OP, input })).state, 'delivered');
  assert.equal(f.nativeSends(f.project), 1);
});

test('F2: the review\'s A10 scenario -- quota wait, then unhold and re-seat -- leaves native.send uncalled', async t => {
  const f = await seated(t);
  f.humanPrime(); await f.hold();
  const { messageId } = await f.report();
  let allowed = false; quotaFixture(f, () => allowed);
  const input = replyInput(f, { inReplyTo: messageId, text: 'Parked operator reply' }).input;
  assert.equal((await f.request({ method: 'seat-reply', operator: OP, input })).state, 'busy');
  await f.request({ method: 'seat-unhold', operator: OP, input: { role: 'prime', seat: 'delivery', expectedRevision: 1, note: 'Hold lifted before replay' } });
  const other = f.enrol(PROGRAMME);
  await f.control.bindings.assign({ role: 'prime', seat: 'delivery', sessionId: other, expectedSessionGeneration: 1, expectedRevision: 1, note: 'Seat moved before the replay' });
  allowed = true;
  await f.control.quota.pump();
  await assert.rejects(f.request({ method: 'seat-reply', operator: OP, input }));
  assert.equal(f.nativeSends(f.project), 0);
  assert.equal(f.store.delivery(input.messageId), null);
});

test('F3: operator replies and receipts appear in channels-status, and an unread operator reply counts in channels-list', async t => {
  const f = await seated(t);
  f.humanPrime(); await f.hold();
  const a = await f.report(), b = await f.report();
  await f.request({ method: 'seat-receipt', operator: OP, input: { channelId: f.channel.channelId, messageId: b.messageId, note: 'Read by the lead' } });
  const sent = await f.request(replyInput(f, { inReplyTo: a.messageId }));
  const status = await f.request({ method: 'channels-status', operator: OP });
  const reply = status.operatorActs.find(x => x.id === sent.messageId), receipt = status.operatorActs.find(x => x.kind === 'receipt');
  assert.equal(reply.kind, 'reply'); assert.equal(reply.origin, OPERATOR_ORIGIN); assert.equal(reply.state, 'delivered'); assert.equal(reply.parent, a.messageId);
  assert.equal(receipt.parent, b.messageId); assert.equal(receipt.origin, OPERATOR_ORIGIN);
  assert.equal(status.capacity.operatorActs, 2);
  const list = () => f.request({ method: 'channels-list', capability: f.projectCapability, input: { sessionId: f.project } }).then(r => r.channels[0]);
  let c = await list();
  assert.equal(c.unread, 1); assert.equal(c.operatorUnread, 1);
  await f.request({ method: 'channels-read', capability: f.projectCapability, input: { sessionId: f.project, channelId: f.channel.channelId, messageId: sent.messageId, note: 'Read the decision' } });
  c = await list();
  assert.equal(c.unread, 0); assert.equal(c.operatorUnread, 0);
});

test('F4: a failure that admitted nothing does not burn the parent; a concurrent identical resend never overwrites the live reply', async t => {
  const f = await seated(t);
  f.humanPrime(); await f.hold();
  const { messageId } = await f.report(), other = await f.report();
  // The recipient-authority lookup fails once: refused before intent, so nothing was admitted.
  f.onAuthority(id => { if (id === T(1)) { f.onAuthority(null); throw Error('authority source briefly unreachable'); } });
  const first = replyInput(f, { inReplyTo: messageId });
  await assert.rejects(f.request(first), /briefly unreachable/);
  const voided = act(f, first.input.messageId);
  assert.equal(voided.kind, 'void-reply'); assert.equal(voided.state, 'failed');
  await assert.rejects(f.request(first), /identity already used/, 'the voided identity is not reused');
  // A second unadmitted failure on the same parent: the partial unique index lets voids repeat.
  f.onAuthority(id => { if (id === T(1)) { f.onAuthority(null); throw Error('authority source briefly unreachable'); } });
  await assert.rejects(f.request(replyInput(f, { inReplyTo: messageId })), /briefly unreachable/);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM seat_operator_acts WHERE kind='void-reply' AND parent=?").get(messageId).n, 2);
  const second = await f.request(replyInput(f, { inReplyTo: messageId }));
  assert.equal(second.state, 'delivered', 'the parent was not burnt');
  assert.equal((await f.thread()).messages.filter(m => m.inReplyTo === messageId).length, 1, 'the recipient sees only the reply it received');
  // Busy, then two concurrent identical resends: one dispatch, and the live act ends delivered, not failed.
  f.states.set(f.project, { ...f.states.get(f.project), status: 'running' });
  const input = replyInput(f, { inReplyTo: other.messageId, text: 'busy one' }).input;
  assert.equal((await f.request({ method: 'seat-reply', operator: OP, input })).state, 'busy');
  f.states.set(f.project, { ...f.states.get(f.project), status: 'idle' });
  const before = f.admitted(), used = f.used(), busyFailure = act(f, input.messageId).failure;
  // An identical resend issued WHILE the first is inside native dispatch is reported, and never writes over the
  // live act -- not even transiently.
  let during = null;
  f.during(async () => { f.during(null); during = await f.request({ method: 'seat-reply', operator: OP, input }); during.failureMidFlight = act(f, input.messageId).failure; });
  await f.request({ method: 'seat-reply', operator: OP, input });
  assert.equal(during.resend, true); assert.equal(during.failureMidFlight, busyFailure);
  await Promise.allSettled([f.request({ method: 'seat-reply', operator: OP, input }), f.request({ method: 'seat-reply', operator: OP, input })]);
  assert.equal(f.admitted() - before, 1); assert.equal(f.used(), used);
  assert.equal(act(f, input.messageId).state, 'delivered'); assert.equal(act(f, input.messageId).kind, 'reply');
  // Unit: a failure recorded WITH a delivery row may have reached the native boundary, so it keeps the parent.
  // control.send has no post-intent throw today; this pins settleFailure for the day it does.
  const reached = replyInput(f, { inReplyTo: randomUUID() }).input.messageId;
  f.store.db.prepare("INSERT INTO seat_operator_acts VALUES (?,'reply',?,'delivery',1,?,1,?,?,1,'x','reserved',NULL,NULL,NULL,?)").run(reached, f.channel.channelId, f.prime, randomUUID(), f.project, new Date().toISOString());
  f.store.db.prepare("INSERT INTO deliveries(id,session,kind,body,state,result) VALUES (?,?,'send','{}','intent','{}')").run(reached, f.project);
  f.control.channels.settleFailure(act(f, reached), 'post-intent failure');
  assert.equal(act(f, reached).kind, 'reply'); assert.equal(act(f, reached).state, 'failed');
});

test('F5: a reply stuck reserved is reconciled by the operator -- voided when never dispatched, mirrored when it was', async t => {
  const f = await seated(t);
  f.humanPrime(); await f.hold();
  const a = await f.report(), b = await f.report();
  // A crash between reservation and dispatch: simulated as a busy act left 'reserved' with no delivery row.
  f.states.set(f.project, { ...f.states.get(f.project), status: 'running' });
  const stuck = replyInput(f, { inReplyTo: a.messageId }).input;
  await f.request({ method: 'seat-reply', operator: OP, input: stuck });
  f.states.set(f.project, { ...f.states.get(f.project), status: 'idle' });
  f.store.db.prepare("UPDATE seat_operator_acts SET state='reserved' WHERE id=?").run(stuck.messageId);
  const resend = await f.request({ method: 'seat-reply', operator: OP, input: stuck });
  assert.equal(resend.state, 'reserved'); assert.equal(resend.resend, true);
  assert.equal(f.nativeSends(f.project), 0, 'an identical resend never dispatches a reserved act');
  await assert.rejects(f.request({ method: 'seat-reply-reconcile', input: { messageId: stuck.messageId, reason: 'Controller stopped mid-reply' } }), /Operator authorization required/);
  const fixed = await f.request({ method: 'seat-reply-reconcile', operator: OP, input: { messageId: stuck.messageId, reason: 'Controller stopped mid-reply' } });
  assert.equal(fixed.voided, true); assert.equal(fixed.state, 'failed');
  await assert.rejects(f.request({ method: 'seat-reply-reconcile', operator: OP, input: { messageId: stuck.messageId, reason: 'Controller stopped mid-reply' } }), /Only a reply stuck reserved/);
  assert.equal((await f.request(replyInput(f, { inReplyTo: a.messageId }))).state, 'delivered', 'the parent is free again');
  // A reserved act whose delivery DID happen takes the journal's state and keeps the parent.
  const done = await f.request(replyInput(f, { inReplyTo: b.messageId }));
  f.store.db.prepare("UPDATE seat_operator_acts SET state='reserved' WHERE id=?").run(done.messageId);
  const mirrored = await f.request({ method: 'seat-reply-reconcile', operator: OP, input: { messageId: done.messageId, reason: 'Controller stopped after the send' } });
  assert.equal(mirrored.voided, false); assert.equal(mirrored.state, 'delivered');
  await assert.rejects(f.request(replyInput(f, { inReplyTo: b.messageId })), /already has an operator reply/);
});

// G6 (G-FIXES-REPORT.md): the Tally orchestrator's two messages to the human-held prime sat 'held' and nobody was told.
test('G6: a held message notifies the human lead once, with seat names only, and still never reaches the holder session', async t => {
  const f = await seated(t), notices = [];
  f.control.humanNotifier = async n => { notices.push(n); };
  f.humanPrime(); await f.hold();
  const sends = f.nativeSends(f.prime), { messageId, result } = await f.report();
  assert.equal(result.state, 'held'); assert.match(result.note, /human lead is notified/);
  // REVIEW-G G-6: the reply does not wait for the notifier; the notice is already recorded as being sent.
  assert.equal(result.notice.outcome, 'sending'); await f.control.channels.noticing;
  assert.equal(notices.length, 1); assert.deepEqual(notices[0].messageIds, [messageId]); assert.equal(notices[0].seat, 'delivery'); assert.deepEqual(notices[0].fromSeats, [P(1)]);
  assert.ok(!JSON.stringify(notices).includes('blocked on the release decision'), 'the untrusted text is never in a notice');
  await f.control.channels.pump(); await f.control.channels.pump();
  assert.equal(notices.length, 1, 'one notice per message, however often the pump runs');
  assert.equal(f.nativeSends(f.prime), sends, 'nothing was dispatched into the human-held session');
  const inbox = await f.request({ method: 'seat-inbox', operator: OP, input: { role: 'prime', seat: 'delivery' } });
  assert.equal(inbox.messages.find(m => m.messageId === messageId).humanNotice.outcome, 'notified');
});
test('G6: a failing notifier is recorded, never blocks the held message, and is not retried into a flood', async t => {
  const f = await seated(t); let calls = 0;
  f.control.humanNotifier = async () => { calls++; throw Error('Notifications are off'); };
  f.humanPrime(); await f.hold();
  const { messageId, result } = await f.report();
  assert.equal(result.state, 'held'); await f.control.channels.noticing;
  const inbox = await f.request({ method: 'seat-inbox', operator: OP, input: { role: 'prime', seat: 'delivery' } });
  assert.match(inbox.messages.find(m => m.messageId === messageId).humanNotice.outcome, /^failed: Notifications are off/);
  await f.control.channels.pump(); assert.equal(calls, 1);
});
test('REVIEW-G G-6: a slow notifier does not hold up the sender, and its outcome still lands', async t => {
  const f = await seated(t); let release;
  f.control.humanNotifier = () => new Promise(r => { release = r; });
  f.humanPrime(); await f.hold();
  const reported = f.report(), first = await Promise.race([reported, new Promise(r => setTimeout(() => r(null), 2000))]);
  if (!first) { release?.(); await reported; assert.fail('the sender waited for the notifier'); }
  const { messageId, result } = first;
  assert.equal(result.state, 'held'); assert.equal(result.notice.outcome, 'sending', 'the reply came back while the notifier was still running');
  release(); await f.control.channels.noticing;
  const inbox = await f.request({ method: 'seat-inbox', operator: OP, input: { role: 'prime', seat: 'delivery' } });
  assert.equal(inbox.messages.find(m => m.messageId === messageId).humanNotice.outcome, 'notified');
});
test('G6: the macOS notifier posts metadata only and refuses anything that is not a seat identity', async () => {
  const runs = [], notify = macHeldNotifier(async (file, args) => { runs.push([file, args]); });
  await notify({ seat: 'delivery', count: 2, waiting: 3, fromSeats: [P(1)], messageIds: [randomUUID(), randomUUID()] });
  assert.equal(runs[0][0], '/usr/bin/osascript'); assert.match(runs[0][1][1], /^display notification "2 new messages from project seat 22222222-2222-4222-8222-000000000001; 3 waiting in all\./);
  assert.throws(() => heldNoticeText({ seat: 'delivery\" & do shell script "x', count: 1, waiting: 1, fromSeats: [P(1)] }), /Unexpected held-notice shape/);
});
// H6 item 2: a reaffirmation of the human-held prime (the SAME session re-seated) keeps the hold and the channel, so
// a report still comes to rest held rather than being hard-refused; a replacement still ends the hold (E3).
test('H6-2: reaffirming a held prime carries the hold and the channel; the report is still held, never dispatched', async t => {
  const f = await seated(t); f.humanPrime(); await f.hold();
  const again = await f.control.bindings.assign({ role: 'prime', seat: 'delivery', sessionId: f.prime, expectedSessionGeneration: f.store.get(f.prime).generation, expectedRevision: 1, note: 'Reaffirming the same human lead' });
  assert.equal(again.action, 'reaffirm'); assert.equal(again.carried.humanHold, 1); assert.equal(again.carried.channels, 1);
  assert.ok(f.control.bindings.heldBy('prime', 'delivery'), 'still held at revision 2');
  const sends = f.nativeSends(f.prime), { result } = await f.report();
  assert.equal(result.state, 'held'); assert.equal(f.nativeSends(f.prime), sends);
});
