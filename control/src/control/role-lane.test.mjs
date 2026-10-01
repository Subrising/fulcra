// Five checks for the three lane gaps: capability lifetime across a re-delegation, wake delivery to a busy
// seat, and the agent-initiated channel request. Each drives the real admission path; none reconstructs a
// delivered row, because store.finish(...,'delivered',...) drops the supervision binding and a rebuilt row
// can make a guard look exercised when it was skipped.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { FENCE_PROTOCOL } from './native-fence.mjs';
import { ControlStore } from './store.mjs';
import { Controller } from './controller.mjs';
import { Bindings } from './bindings.mjs';
import { RoleChannels } from './role-channels.mjs';
import { COMPANY, PROGRAMME } from './authority.mjs';
import { closeSeatingDefaults } from './role-defaults-fixture.mjs';
import { rpc } from './rpc.mjs';

const P = n => `22222222-2222-4222-8222-${String(n).padStart(12, '0')}`;
const T = n => `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`;
const issue = id => ({ id, companyId: COMPANY, parentId: id === PROGRAMME ? null : PROGRAMME, assigneeUserId: 'local-board', assigneeAgentId: null, status: 'in_progress' });
const NOW = Date.parse('2026-09-19T00:00:00.000Z');
const EXPIRES = new Date(NOW + 86400000).toISOString();

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orca-role-lane-')));
  const store = new ControlStore(path.join(dir, 'journal.sqlite'));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const states = new Map(), sent = [];
  const native = { route: () => undefined,
    inspect: async id => ({ boot: 'fixture', fenceProtocol: FENCE_PROTOCOL, saturated: false, humanAt: 0, status: 'idle', pending: 0, lastPromptId: null, ...(states.get(id) ?? {}) }),
    send: async (id, text, messageId) => { sent.push({ id, text, messageId }); states.set(id, { ...(states.get(id) ?? {}), lastPromptId: messageId }); } };
  const control = new Controller({ store, native, authority: async id => issue(id) });
  control.bindings = new Bindings(control, async () => ({ observedAt: '2026-09-19T00:00:00.000Z', available: true, partial: false,
    projects: [{ id: P(1), name: 'Orca', description: null, status: 'in_progress' }],
    membership: [{ taskId: T(1), projectId: P(1) }], note: 'test project source' }), path.join(dir, 'grants', 'role'));
  control.channels = new RoleChannels(control, () => NOW);
  const enrol = task => { const id = randomUUID(); store.created(id, task, path.join(dir, id)); states.set(id, { lastPromptId: null }); return id; };
  const tokenAt = id => JSON.parse(fs.readFileSync(path.join(dir, 'grants', 'role', path.basename(store.get(id).cwd) + '.json'), 'utf8')).capability;
  return { dir, store, control, states, sent, enrol, tokenAt, request: rpc(control, 'test-operator'),
    busy: (id, value) => states.set(id, { ...(states.get(id) ?? {}), status: value ? 'running' : 'idle' }),
    delegate: id => control.handback(id, 'Delegated for the role lane verification') };
}
const assign = (f, role, seat, sessionId, revision, note) =>
  f.control.bindings.assign({ role, seat, sessionId, expectedSessionGeneration: f.store.get(sessionId).generation, expectedRevision: revision, note });

async function seated(t) {
  const f = fixture(t), prime = f.enrol(PROGRAMME), project = f.enrol(T(1));
  await assign(f, 'prime', 'delivery', prime, 0, 'Accountable prime seat for delivery');
  await assign(f, 'project-orchestrator', P(1), project, 0, 'Owns delivery of this project');
  await f.delegate(prime); await f.delegate(project);
  for (const id of [prime, project]) await f.request({ method: 'bindings-grant', input: { sessionId: id, expectedGeneration: f.store.get(id).generation }, operator: 'test-operator' });
  // Seating conferred a default channel between these seats; close it so the operator-approved channel
  // below is the one this suite exercises. See role-defaults-fixture.mjs.
  closeSeatingDefaults(f.control);
  const channel = await f.request({ method: 'channels-open', operator: 'test-operator',
    input: { primeSeat: 'delivery', projectSeat: P(1), purpose: 'Lane verification between the board seat and this project', maxMessages: 8, expiresAt: EXPIRES, expectedPrimeRevision: 1, expectedProjectRevision: 1 } });
  return { ...f, prime, project, channel: channel.channelId };
}

test('a role capability survives a re-delegation at the same path, and dies with takeover or a vacated seat', async t => {
  const f = await seated(t);
  const first = f.tokenAt(f.project);
  assert.deepEqual((await f.request({ method: 'bindings-self', capability: first, input: { sessionId: f.project } })).roles.map(r => r.seat), [P(1)]);

  // A takeover makes it inert immediately; the file still holds a token, and that token is dead.
  f.control.takeover(f.project, 'Human takes the project seat back');
  await assert.rejects(f.request({ method: 'bindings-self', capability: first, input: { sessionId: f.project } }), /Role capability revoked or invalid/);
  assert.equal(f.tokenAt(f.project), first);

  // Re-delegation reissues at the same deterministic path, so the session picks it up on its next call.
  await f.delegate(f.project);
  const second = f.tokenAt(f.project);
  assert.notEqual(second, first);
  await assert.rejects(f.request({ method: 'bindings-self', capability: first, input: { sessionId: f.project } }), /Role capability revoked or invalid/);
  const self = await f.request({ method: 'bindings-self', capability: second, input: { sessionId: f.project } });
  assert.equal(self.sessionId, f.project);
  assert.equal(f.store.db.prepare('SELECT generation FROM role_credentials WHERE session=?').get(f.project).generation, f.store.get(f.project).generation);

  // A vacated seat is not reissued: a handback must not hand a role back.
  f.control.bindings.unassign({ role: 'project-orchestrator', seat: P(1), expectedRevision: 1, note: 'Project seat released by the operator' });
  f.control.takeover(f.project, 'Human takes it again');
  await f.delegate(f.project);
  // Since N1 the vacated seat destroys the credential outright, so there is nothing left to reissue.
  assert.equal(fs.existsSync(path.join(f.dir, 'grants', 'role', path.basename(f.store.get(f.project).cwd) + '.json')), false);
  await assert.rejects(f.request({ method: 'bindings-self', capability: second, input: { sessionId: f.project } }), /Role capability revoked or invalid/);
  // A session that was never seated does not acquire a capability by being handed back.
  const unseated = f.enrol(T(1));
  await f.delegate(unseated);
  assert.equal(fs.existsSync(path.join(f.dir, 'grants', 'role', path.basename(f.store.get(unseated).cwd) + '.json')), false);
  // G1 (G-FIXES-REPORT.md): a session seated while under human control gets its seat's credential -- a fresh token --
  // at its first delegation, pinned to the seat and revision it was seated at. The vacated holder above got nothing.
  const stranger = f.enrol(T(1));
  const seating = await assign(f, 'project-orchestrator', P(1), stranger, 2, 'Seated while still under human control');
  assert.equal(seating.defaults.roleGrant.issued, false); assert.match(seating.defaults.roleGrant.pending, /next delegation/);
  await f.delegate(stranger);
  const strangerToken = f.tokenAt(stranger);
  assert.notEqual(strangerToken, first); assert.notEqual(strangerToken, second);
  assert.deepEqual((await f.request({ method: 'bindings-self', capability: strangerToken, input: { sessionId: stranger } })).roles.map(r => r.seat), [P(1)]);
  await assert.rejects(f.request({ method: 'bindings-self', capability: second, input: { sessionId: f.project } }), /Role capability revoked or invalid/);
});

test('a message to a busy seat is held and actually delivered when it goes idle', async t => {
  const f = await seated(t);
  f.busy(f.project, true);
  const messageId = randomUUID();
  const held = await f.request({ method: 'channels-send', capability: f.tokenAt(f.prime),
    input: { sessionId: f.prime, channelId: f.channel, messageId, text: 'Blocked on the release decision' } });
  assert.equal(held.state, 'pending'); assert.equal(held.remaining, 7);
  assert.equal(f.sent.length, 0);
  // It is legible to both seats while it waits, and the allowance was spent exactly once.
  const waiting = await f.request({ method: 'channels-thread', capability: f.tokenAt(f.project), input: { sessionId: f.project, channelId: f.channel } });
  assert.deepEqual(waiting.messages.map(m => [m.state, m.text]), [['pending', 'Blocked on the release decision']]);
  assert.equal(f.store.db.prepare('SELECT used FROM role_channels WHERE id=?').get(f.channel).used, 1);
  // Pumping while still busy changes nothing but the attempt count.
  await f.control.channels.pump();
  assert.equal(f.sent.length, 0);
  assert.equal(f.store.db.prepare('SELECT state,attempts FROM role_channel_messages WHERE messageId=?').get(messageId).state, 'pending');
  // Idle: the retry goes through the ordinary send path with the same identity, and no extra allowance.
  assert.equal(f.control.channels.interested(f.project), true);
  f.busy(f.project, false);
  await f.control.channels.pump();
  assert.deepEqual(f.sent.map(x => [x.id, x.messageId]), [[f.project, messageId]]);
  assert.equal(f.store.delivery(messageId).session, f.project);
  assert.equal(f.store.db.prepare('SELECT state FROM role_channel_messages WHERE messageId=?').get(messageId).state, 'delivered');
  assert.equal(f.store.db.prepare('SELECT used FROM role_channels WHERE id=?').get(f.channel).used, 1);
  assert.equal(f.control.channels.interested(f.project), false);
});

test('a held message is abandoned when the originator is taken over, and the reason is visible', async t => {
  const f = await seated(t);
  f.busy(f.project, true);
  const messageId = randomUUID();
  await f.request({ method: 'channels-send', capability: f.tokenAt(f.prime), input: { sessionId: f.prime, channelId: f.channel, messageId, text: 'Waiting while my own seat is taken over' } });
  // The originator, not the receiver, loses control. assertUsable cannot see this: the seats are unchanged.
  f.control.takeover(f.prime, 'Human takes the board seat back mid-flight');
  assert.equal(f.control.bindings.describe('prime', 'delivery').revision, 1, 'the seat itself is untouched');
  f.busy(f.project, false);
  await f.control.channels.pump();
  assert.equal(f.sent.length, 0, 'a pending message must not deliver on the originator being taken over');
  const row = f.store.db.prepare('SELECT state,failure,readNote FROM role_channel_messages WHERE messageId=?').get(messageId);
  assert.equal(row.state, 'failed');
  // The reason has its own column and is not written into the receipt note.
  assert.match(row.failure, /Originating seat is no longer under delegated control/);
  assert.equal(row.readNote, null);
  // Both seats can see why it never arrived.
  const thread = await f.request({ method: 'channels-thread', capability: f.tokenAt(f.project), input: { sessionId: f.project, channelId: f.channel } });
  assert.deepEqual(thread.messages.map(m => [m.state, m.failure, m.receipt]), [['failed', row.failure, null]]);
});

test('a held message is abandoned rather than delivered once its channel or receiver changes', async t => {
  const f = await seated(t);
  f.busy(f.project, true);
  const first = randomUUID();
  await f.request({ method: 'channels-send', capability: f.tokenAt(f.prime), input: { sessionId: f.prime, channelId: f.channel, messageId: first, text: 'Waiting on a closed channel' } });
  await f.request({ method: 'channels-close', operator: 'test-operator', input: { channelId: f.channel, note: 'Operator closed it while a message waited' } });
  f.busy(f.project, false);
  await f.control.channels.pump();
  assert.equal(f.sent.length, 0);
  assert.equal(f.store.db.prepare('SELECT state FROM role_channel_messages WHERE messageId=?').get(first).state, 'failed');

  // A receiver takeover between reservation and retry also stops it, with nothing dispatched.
  const g = await seated(t);
  g.busy(g.project, true);
  const second = randomUUID();
  await g.request({ method: 'channels-send', capability: g.tokenAt(g.prime), input: { sessionId: g.prime, channelId: g.channel, messageId: second, text: 'Waiting on a taken-over seat' } });
  g.control.takeover(g.project, 'Human takes the project seat back mid-flight');
  g.busy(g.project, false);
  await g.control.channels.pump();
  assert.equal(g.sent.length, 0);
  assert.equal(g.store.db.prepare('SELECT state FROM role_channel_messages WHERE messageId=?').get(second).state, 'failed');
  assert.equal(g.store.delivery(second), null);
});

test('a seated model can request a channel but can never approve or widen one', async t => {
  const f = await seated(t);
  // The pair already has an open channel, so a request for it is pointless and refused.
  await assert.rejects(f.request({ method: 'channels-request', capability: f.tokenAt(f.project),
    input: { sessionId: f.project, fromSeat: P(1), toSeat: 'delivery', purpose: 'Please open a line to the board' } }), /already joins these seats/);
  await f.request({ method: 'channels-close', operator: 'test-operator', input: { channelId: f.channel, note: 'Closed so a request can be made' } });

  const made = await f.request({ method: 'channels-request', capability: f.tokenAt(f.project),
    input: { sessionId: f.project, fromSeat: P(1), toSeat: 'delivery', purpose: 'Need a board decision on the release flag' } });
  assert.equal(made.state, 'pending'); assert.equal(made.approved, false);
  // Requesting creates no channel and no capability of any kind.
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM role_channels WHERE state='open'").get().n, 0);
  assert.deepEqual((await f.request({ method: 'channels-list', capability: f.tokenAt(f.project), input: { sessionId: f.project } })).channels, []);
  // A model cannot reach the operator verbs at all.
  for (const method of ['channels-requests', 'channels-request-decline', 'channels-open'])
    await assert.rejects(f.request({ method, capability: f.tokenAt(f.project), input: { requestId: made.requestId, note: 'Approving my own request' } }), /Operator authorization required/);
  // It cannot speak for a seat it does not hold, pair two seats of the same kind, or flood the queue.
  await assert.rejects(f.request({ method: 'channels-request', capability: f.tokenAt(f.project),
    input: { sessionId: f.project, fromSeat: 'delivery', toSeat: P(1), purpose: 'Speaking for the board seat instead' } }), /seat this session currently holds/);
  await assert.rejects(f.request({ method: 'channels-request', capability: f.tokenAt(f.project),
    input: { sessionId: f.project, fromSeat: P(1), toSeat: P(1), purpose: 'Pairing a seat with itself' } }), /one prime seat and one project orchestrator seat/);
  await assert.rejects(f.request({ method: 'channels-request', capability: f.tokenAt(f.project),
    input: { sessionId: f.project, fromSeat: P(1), toSeat: 'delivery', purpose: 'Asking a second time for the same seat' } }), /pending request for that seat already exists/);
  // The operator sees it, and declining records why without creating anything.
  const listed = await f.request({ method: 'channels-requests', operator: 'test-operator' });
  assert.deepEqual(listed.requests.map(r => [r.requestId, r.fromSeat, r.toSeat, r.state]), [[made.requestId, P(1), 'delivery', 'pending']]);
  const declined = await f.request({ method: 'channels-request-decline', operator: 'test-operator', input: { requestId: made.requestId, note: 'Raise it in the weekly review instead' } });
  assert.equal(declined.state, 'declined'); assert.equal(declined.note, 'Raise it in the weekly review instead');
  await assert.rejects(f.request({ method: 'channels-request-decline', operator: 'test-operator', input: { requestId: made.requestId, note: 'Declining it twice over' } }), /not pending/);
});

test('an operator approval fulfils a request, and the delivered result is a real prime to project message', async t => {
  const f = await seated(t);
  await f.request({ method: 'channels-close', operator: 'test-operator', input: { channelId: f.channel, note: 'Closed so the request path can be shown end to end' } });
  const made = await f.request({ method: 'channels-request', capability: f.tokenAt(f.project),
    input: { sessionId: f.project, fromSeat: P(1), toSeat: 'delivery', purpose: 'Need a board decision on the release flag' } });
  // The operator chooses the bounds; nothing the model asked for widened them.
  const approved = await f.request({ method: 'channels-open', operator: 'test-operator',
    input: { primeSeat: 'delivery', projectSeat: P(1), purpose: 'Board decision on the release flag', maxMessages: 2, expiresAt: EXPIRES, expectedPrimeRevision: 1, expectedProjectRevision: 1 } });
  assert.equal(approved.maxMessages, 2);
  // Fulfilment is derived from the actual open channel, not from a stored approval.
  const listed = await f.request({ method: 'channels-requests', operator: 'test-operator' });
  assert.deepEqual(listed.requests.map(r => [r.requestId, r.state, r.channelId]), [[made.requestId, 'fulfilled', approved.channelId]]);

  const messageId = randomUUID();
  const sent = await f.request({ method: 'channels-send', capability: f.tokenAt(f.prime),
    input: { sessionId: f.prime, channelId: approved.channelId, messageId, text: 'Ship behind the flag; I own the decision' } });
  assert.equal(sent.state, 'delivered'); assert.equal(sent.accepted, false); assert.equal(sent.remaining, 1);
  assert.deepEqual(f.sent.map(x => [x.id, x.text]), [[f.project, 'Ship behind the flag; I own the decision']]);
  const thread = await f.request({ method: 'channels-thread', capability: f.tokenAt(f.project), input: { sessionId: f.project, channelId: approved.channelId } });
  assert.deepEqual(thread.messages.map(m => [m.fromSeat, m.toSeat, m.state, m.mine]), [['delivery', P(1), 'delivered', false]]);
});
