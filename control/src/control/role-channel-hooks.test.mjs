// One-for-one role-channel cases, through V1.1 TrustedPlugins and the real manager.
// The live defect these cover: role-channels.test.mjs drives the controller with a native double whose
// send() never calls admission, so every channel test passed while no channel message could be admitted.
// Here send enters the real host and manager with a capability; only the provider transport is faked.
// Each refusal changes the journal between the controller intent and the host admission boundary.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlStore } from './store.mjs';
import { Controller } from './controller.mjs';
import { Bindings } from './bindings.mjs';
import { RoleChannels } from './role-channels.mjs';
import { COMPANY, PROGRAMME, RecipientBusy } from './authority.mjs';
import { TrustedPlugins, AgentManager, AgentStorage, createTestAgentClient, createTestLogger } from '@fulcra/test-host';
import { createTrustedContribution, OWN_ID } from './trusted-contribution.mjs';
import { controllerTestConnection } from '../../tools/host-test-connection.mjs';
import { closeSeatingDefaults } from './role-defaults-fixture.mjs';
import { rpc } from './rpc.mjs';

const P = n => `22222222-2222-4222-8222-${String(n).padStart(12, '0')}`;
const T = n => `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`;
const rotated = new Set();
const issue = id => ({ id, companyId: COMPANY, parentId: id === PROGRAMME ? null : PROGRAMME, assigneeUserId: rotated.has(id) ? 'reassigned-board' : 'local-board', assigneeAgentId: null, status: 'in_progress' });

async function seated(t) {
  rotated.clear();
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orca-chan-admit-')));
  const store = new ControlStore(path.join(dir, 'journal.sqlite'));
  const logger=createTestLogger(), storage=new AgentStorage(path.join(dir,'agents'),logger);await storage.initialize();
  const host=new TrustedPlugins();host.initializeKnownAgents([]);let api;
  host.registerV11(OWN_ID,true,server=>{api=server;createTrustedContribution({home:dir})(server);});
  const manager=new AgentManager({registry:storage,logger,trustedPlugins:host,clients:{claude:createTestAgentClient('claude')}});
  const connection=await controllerTestConnection({host,manager,storage,logger,home:dir,api});
  const observation=id=>({...api.inputObservations.require(id),fenceProtocol:'orca-input-sequence-v1',saturated:false});
  t.after(async()=>{await connection.close();for(const id of states.keys())await host.daemon(()=>manager.closeAgent(id));await manager.flush();host.close();store.close();fs.rmSync(dir,{recursive:true,force:true});});
  // Real wall clock. The guard checks expiry with Date.now(), so a frozen fixture clock would make this
  // suite's result depend on the day it is run.
  const now = () => Date.now();
  const states = new Map();
  let admitted = 0, beforeAdmit = null, intentAt = null;
  const inspects = new Map();
  const native = {
    route: () => undefined,
    inspect: async id => { inspects.set(id, (inspects.get(id) ?? 0) + 1);
      return { status: 'idle', pending: 0, lastPromptId: null, lastUserAt: manager.getAgent(id)?.lastUserMessageAt?.toISOString() ?? null, ...(states.get(id) ?? {}), ...observation(id) }; },
    send: async (id, text, messageId) => {
      // Captured at DISPATCH time: store.finish overwrites result on 'delivered', so anything read after
      // the send is the delivered record and says nothing about what the guard was handed.
      intentAt = JSON.parse(JSON.stringify(store.delivery(messageId).result));
      await beforeAdmit?.(messageId);
      await connection.inputs.send(id,text,messageId,intentAt.nativeAttemptId);
      for(let n=0;n<200 && manager.getAgent(id)?.activeForegroundTurnId;n++)await new Promise(resolve=>setTimeout(resolve,5));
      admitted++; states.set(id, { ...(states.get(id) ?? {}), lastPromptId: messageId });
    },
    receipt: async () => null,
  };
  const source = { value: { observedAt: new Date().toISOString(), available: true, partial: false,
    projects: [{ id: P(1), name: 'Orca', description: null, status: 'in_progress' }],
    membership: [{ taskId: T(1), projectId: P(1) }], note: 'test project source' } };
  let authorityFails = false;
  // Counted PER TASK: control.authority is an off-box lookup in production, so how OFTEN it is asked is a
  // property worth pinning. Per task because two different questions go through this one function -- the
  // pump asking about the SENDER's task, and control.send asking about the RECIPIENT's -- and only the
  // first is the pump's to batch.
  const authorityReads = new Map();
  const control = new Controller({ store, native, authority: async id => { authorityReads.set(id, (authorityReads.get(id) ?? 0) + 1); if (authorityFails) throw Error('Paperclip unreachable'); return issue(id); } });
  control.bindings = new Bindings(control, async () => source.value, path.join(dir, 'grants', 'role'));
  control.channels = new RoleChannels(control, now);
  const enrol = async task => { const id = randomUUID(), cwd = path.join(dir, randomUUID()); fs.mkdirSync(cwd); await manager.createAgent({provider:'claude',model:'fixture-model',cwd},id,{workspaceId:undefined}); store.created(id, task, cwd); states.set(id, { lastPromptId: null }); return id; };
  const prime = await enrol(PROGRAMME), project = await enrol(T(1));
  await control.bindings.assign({ role: 'prime', seat: 'delivery', sessionId: prime, expectedSessionGeneration: 1, expectedRevision: 0, note: 'Accountable prime seat for delivery' });
  await control.bindings.assign({ role: 'project-orchestrator', seat: P(1), sessionId: project, expectedSessionGeneration: 1, expectedRevision: 0, note: 'Owns delivery of this project' });
  await control.handback(prime, 'Delegated for the channel verification');
  await control.handback(project, 'Delegated for the channel verification');
  const role = async id => JSON.parse(fs.readFileSync((await control.bindings.grantRole({ sessionId: id, expectedGeneration: store.get(id).generation })).grantFile, 'utf8')).capability;
  const request = rpc(control, 'test-operator');
  // Seating conferred a default channel between these seats; close it so the operator approval below is the
  // channel every admission assertion in this suite is about. See role-defaults-fixture.mjs.
  closeSeatingDefaults(control);
  const channel = await request({ method: 'channels-open', operator: 'test-operator',
    input: { primeSeat: 'delivery', projectSeat: P(1), purpose: 'Weekly delivery check-in between the board seat and this project',
      maxMessages: 4, expiresAt: new Date(Date.now() + 86400000).toISOString(), expectedPrimeRevision: 1, expectedProjectRevision: 1 } });
  const send = async (from, capability, extra = {}) => {
    const messageId = randomUUID();
    const result = await request({ method: 'channels-send', capability,
      input: { sessionId: from, channelId: channel.channelId, messageId, text: 'Report the current blocker on this project', ...extra } });
    return { messageId, result, delivery: store.delivery(messageId) };
  };
  return { dir, store, control, request, prime, project, channel, send, rotate: id => rotated.add(id), states,
    intentAt: () => intentAt, inspects: id => inspects.get(id) ?? 0,
    breakAuthority: v => { authorityFails = v; }, authorityReads: task => authorityReads.get(task) ?? 0,
    primeCapability: await role(prime), projectCapability: await role(project),
    admitted: () => admitted, during: fn => { beforeAdmit = fn; } };
}
const refusal = d => JSON.parse(JSON.stringify(d.result)).error ?? null;

test('an approved channel message is admitted by the real guard and delivered', async t => {
  const f = await seated(t);
  const { result, delivery } = await f.send(f.prime, f.primeCapability);
  assert.equal(refusal(delivery), null);
  assert.equal(delivery.state, 'delivered');
  assert.equal(result.state, 'delivered');
  assert.equal(f.admitted(), 1);
  // The declared field is the channel's own, never the manager supervision field the guard reads as
  // supervisor authority. Asserted on the record captured AT DISPATCH: reading it afterwards inspects the
  // delivered row, which finish() has already replaced, and would have passed whatever intent carried.
  // host-native.mjs reads this same key, and went unmaintained through the 935772bf rename because the
  // only test covering it hand-built the record instead of observing this one.
  const intent = f.intentAt();
  assert.equal(intent.supervision, undefined);
  assert.deepEqual(intent.channel, { channelId: f.channel.channelId, fromSeat: 'delivery', toSeat: P(1), fromSession: f.prime, inReplyTo: null });
  assert.equal(f.store.db.prepare("SELECT state FROM role_channel_messages WHERE messageId=?").get(delivery.id).state, 'delivered');
});

test('the reply direction is admitted too, and each orientation is checked against the approved pair', async t => {
  const f = await seated(t);
  const first = await f.send(f.prime, f.primeCapability);
  assert.equal(first.delivery.state, 'delivered');
  const back = await f.send(f.project, f.projectCapability, { inReplyTo: first.messageId });
  assert.equal(refusal(back.delivery), null);
  assert.equal(back.delivery.state, 'delivered');
  assert.equal(f.admitted(), 2);
});

// Each case changes one journal fact in the window between the controller writing its intent and the
// native calling admit(). The approval is already recorded and the allowance already spent, so nothing
// here is caught by the controller's own pre-dispatch checks.
for (const [name, mutate, expected] of [
  ['the channel is closed', (f) => f.store.db.prepare("UPDATE role_channels SET state='closed'").run(), /changed role channel approval/],
  ['the channel has expired', (f) => f.store.db.prepare('UPDATE role_channels SET expiresAt=?').run(new Date(Date.now() - 1000).toISOString()), /changed role channel approval/],
  ['the allowance is exceeded', (f) => f.store.db.prepare('UPDATE role_channels SET used=maxMessages+1').run(), /changed role channel approval/],
  ['the recipient seat was re-seated', (f) => f.store.db.prepare("UPDATE role_bindings SET revision=revision+1 WHERE role='project-orchestrator'").run(), /changed role channel approval/],
  ['the sender seat was released', (f) => f.store.db.prepare("DELETE FROM role_bindings WHERE role='prime'").run(), /changed role channel approval/],
  ['the sender capability was revoked', (f, id) => f.store.db.prepare('DELETE FROM role_credentials WHERE session=?').run(f.prime), /changed role channel approval/],
  ['the sender was taken back under human control', (f) => f.store.db.prepare("UPDATE sessions SET mode='human' WHERE id=?").run(f.prime), /changed role channel approval/],
  ['the message row is gone', (f, id) => f.store.db.prepare('DELETE FROM role_channel_messages WHERE messageId=?').run(id), /mismatched role channel declaration/],
  ['the message row is not reserved', (f, id) => f.store.db.prepare("UPDATE role_channel_messages SET state='delivered' WHERE messageId=?").run(id), /changed role channel approval/],
  ['the message no longer runs along the approved pair', (f, id) => f.store.db.prepare("UPDATE role_channel_messages SET toSeat='someone-else' WHERE messageId=?").run(id), /changed role channel approval/],
  ['the recorded recipient is a different session', (f, id) => f.store.db.prepare('UPDATE role_channel_messages SET toSession=? WHERE messageId=?').run(f.prime, id), /changed role channel approval/],
  ['the recorded text no longer matches what is being sent', (f, id) => f.store.db.prepare("UPDATE role_channel_messages SET text='Something else entirely' WHERE messageId=?").run(id), /changed role channel approval/],
]) {
  test(`admission refuses when ${name}`, async t => {
    const f = await seated(t);
    f.during(id => mutate(f, id));
    const { delivery } = await f.send(f.prime, f.primeCapability);
    assert.equal(delivery.state, 'refused');
    assert.match(refusal(delivery), expected);
    assert.equal(f.admitted(), 0);
  });
}

// A channel is cross-task by construction: the prime seat sits on the programme root and the project
// orchestrator on a member task. control.send re-derives the RECIPIENT's task authority and nothing
// re-derived the sender's, so this window was open on the first send too, not only on a parked replay.
test('a sender whose task authority changed cannot send, and spends no allowance', async t => {
  const f = await seated(t);
  assert.equal(f.store.db.prepare('SELECT used FROM role_channels').get().used, 0);
  f.rotate(PROGRAMME); // the prime seat's own task; the recipient sits on T(1) and is unaffected
  await assert.rejects(f.send(f.prime, f.primeCapability), /originating seat task authority changed/i);
  assert.equal(f.store.db.prepare('SELECT used FROM role_channels').get().used, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM role_channel_messages').get().n, 0);
  assert.equal(f.admitted(), 0);
});

// The pump is the third dispatch point. A message re-offered after the recipient was busy goes back
// through control.send, so the sender's authority has to be re-derived there too.
test('a pending message is failed rather than delivered when the sender task authority changed', async t => {
  const f = await seated(t);
  f.states.set(f.project, { ...f.states.get(f.project), status: 'running' });
  const { messageId, result } = await f.send(f.prime, f.primeCapability);
  assert.equal(result.state, 'pending');
  assert.equal(f.store.db.prepare('SELECT state FROM role_channel_messages WHERE messageId=?').get(messageId).state, 'pending');
  f.states.set(f.project, { ...f.states.get(f.project), status: 'idle' });
  f.rotate(PROGRAMME);
  await f.control.channels.deliverPending();
  const row = f.store.db.prepare('SELECT state,failure FROM role_channel_messages WHERE messageId=?').get(messageId);
  assert.equal(row.state, 'failed');
  assert.match(row.failure, /task authority changed/i);
  assert.equal(f.admitted(), 0);
});

// quota-runtime distinguishes a definite change (cancel) from an unknown error (retry). This caller did
// not: both became 'failed', so one unreachable authority lookup permanently killed a message the operator
// had approved and already paid allowance for.
const pending = async f => {
  f.states.set(f.project, { ...f.states.get(f.project), status: 'running' });
  const { messageId, result } = await f.send(f.prime, f.primeCapability);
  assert.equal(result.state, 'pending');
  // channels.send schedules its own pump on a busy recipient; let it settle so the counter below is ours.
  await f.control.channels.pumping;
  f.states.set(f.project, { ...f.states.get(f.project), status: 'idle' });
  return messageId;
};
const row = (f, id) => f.store.db.prepare('SELECT state,attempts,failure FROM role_channel_messages WHERE messageId=?').get(id);

test('an unreachable authority source retries the pending message instead of killing it', async t => {
  const f = await seated(t);
  const id = await pending(f);
  const before = row(f, id).attempts;
  f.breakAuthority(true);
  await f.control.channels.deliverPending();
  const held = row(f, id);
  assert.equal(held.state, 'pending', 'an unknown error must not kill an approved message');
  // Was `failure === null` -- which asserted the defect that bump() discarded the reason. The row is still
  // pending; the column now says what is in the way.
  assert.match(held.failure, /authority could not be read/);
  assert.equal(held.attempts, before + 1, 'still bounded: the attempt is counted');
  assert.equal(f.admitted(), 0);
  // And it delivers once the source is reachable again -- no re-approval, no re-send.
  f.breakAuthority(false);
  await f.control.channels.deliverPending();
  assert.equal(row(f, id).state, 'delivered');
  assert.equal(f.admitted(), 1);
});

// bump() discarded every attempt's error, so the terminal message was boilerplate naming the RECEIVING
// seat for a failure that was entirely sender-side. The first obstacle is the one that explains how the
// message got stuck, so it is the one kept.
test('a bounded-out message reports the cause, not boilerplate about the receiving seat', async t => {
  const f = await seated(t);
  const id = await pending(f);
  f.breakAuthority(true);
  await f.control.channels.deliverPending();
  const held = f.store.db.prepare('SELECT state,failure FROM role_channel_messages WHERE messageId=?').get(id);
  assert.equal(held.state, 'pending', 'still retrying');
  assert.match(held.failure, /authority could not be read/, 'the cause is recorded while pending');
  f.store.db.prepare('UPDATE role_channel_messages SET attempts=20 WHERE messageId=?').run(id);
  await f.control.channels.deliverPending();
  const done = f.store.db.prepare('SELECT state,failure FROM role_channel_messages WHERE messageId=?').get(id);
  assert.equal(done.state, 'failed');
  assert.match(done.failure, /Bounded delivery attempts exhausted; first obstacle: .*authority could not be read/);
  assert.doesNotMatch(done.failure, /^Bounded delivery attempts exhausted without reaching the receiving seat$/);
});

test('unknown failures are bounded, so retrying is not forever', async t => {
  const f = await seated(t);
  const id = await pending(f);
  f.store.db.prepare('UPDATE role_channel_messages SET attempts=20 WHERE messageId=?').run(id);
  f.breakAuthority(true);
  await f.control.channels.deliverPending();
  const after = row(f, id);
  assert.equal(after.state, 'failed');
  assert.match(after.failure, /Bounded delivery attempts exhausted/);
});

// The half of finding 2 that was real: assertOriginator reads a journal row, a native takeover does not
// write one, and nothing inspects a seat that only sends. The comment on that function claimed the
// property anyway, which is why a reviewer could find it named for the job, documented for it, and stop.
test('a native takeover of the sender is caught by the pump itself', async t => {
  const f = await seated(t);
  const id = await pending(f);
  // Native input on the SENDER, unjournaled -- exactly the state nothing else would notice.
  f.states.set(f.prime, { ...f.states.get(f.prime), lastPromptId: randomUUID() });
  assert.equal(f.store.get(f.prime).mode, 'delegated', 'the journal must still be stale or this proves nothing');
  await f.control.channels.deliverPending();
  assert.equal(f.store.get(f.prime).mode, 'human', 'the pump must have inspected the sender');
  const row = f.store.db.prepare('SELECT state,failure FROM role_channel_messages WHERE messageId=?').get(id);
  assert.equal(row.state, 'failed');
  assert.match(row.failure, /no longer under delegated control/);
  assert.equal(f.admitted(), 0);
});

// Bounded, as asked: the pass already caps at 32 pending rows, and each originator costs one call.
test('the pump inspects each originator once per pass, not once per message', async t => {
  const f = await seated(t);
  f.states.set(f.project, { ...f.states.get(f.project), status: 'running' });
  // Each send schedules its own pump; let it settle or the next send collides on the session lock.
  for (let i = 0; i < 3; i++) { await f.send(f.prime, f.primeCapability); await f.control.channels.pumping; }
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM role_channel_messages WHERE state='pending'").get().n, 3);
  f.states.set(f.project, { ...f.states.get(f.project), status: 'idle' });
  const before = f.inspects(f.prime);
  await f.control.channels.deliverPending();
  assert.equal(f.inspects(f.prime) - before, 1, 'three pending messages from one seat must cost one inspect');
});

test('a channel message sent through any other path is refused as undeclared', async t => {
  const f = await seated(t);
  const grant = await f.control.handback(f.project, 'Ordinary operator send for the undeclared case');
  const messageId = randomUUID();
  // An ordinary send carries no channel declaration. Planting the row makes it one without the guard's
  // re-derivation ever running -- which is exactly what the declaration check exists to refuse.
  f.during(() => f.store.db.prepare("INSERT INTO role_channel_messages VALUES (?,?,?,?,?,?,?,?,?,'reserved',0,NULL,NULL,NULL,?,NULL,0)")
    .run(messageId, f.channel.channelId, 'delivery', P(1), f.prime, f.project, f.store.get(f.project).generation, null, 'Smuggled text', new Date().toISOString()));
  const delivery = await f.control.send({ sessionId: f.project, messageId, text: 'Smuggled text' }, grant.capability);
  assert.equal(delivery.state, 'refused');
  assert.match(refusal(delivery), /mismatched role channel declaration/);
  assert.equal(f.admitted(), 0);
});

test('an ordinary send with no channel row is unaffected by the new branch', async t => {
  const f = await seated(t);
  const grant = await f.control.handback(f.project, 'Ordinary operator send with no channel involved');
  const delivery = await f.control.send({ sessionId: f.project, messageId: randomUUID(), text: 'Ordinary bounded instruction' }, grant.capability);
  assert.equal(delivery.state, 'delivered');
  assert.equal(f.admitted(), 1);
});

// ---------------------------------------------------------------------------------------------------
// F1-F4. A busy prime must still receive its project's reports, and the queue that holds them must be
// bounded, legible to both seats, and answerable when a sender asks what became of a message.
// ---------------------------------------------------------------------------------------------------

const full = (f, id) => f.store.db.prepare('SELECT * FROM role_channel_messages WHERE messageId=?').get(id);
const used = f => f.store.db.prepare('SELECT used FROM role_channels').get().used;

// F1. The decision to defer used to be a regex over the refusal TEXT, in two separate pumps. Rewording
// controller.send's refusal would have turned every deferral into a permanent failure, silently.
test('a busy recipient refuses with a type, not a sentence', async t => {
  const f = await seated(t);
  f.states.set(f.project, { ...f.states.get(f.project), status: 'running' });
  await assert.rejects(
    f.control.send({ sessionId: f.project, messageId: randomUUID(), text: 'Direct' }, undefined, f.store.get(f.project).generation),
    e => e instanceof RecipientBusy);
});

test('an impostor carrying the busy wording is failed, because the pump asks the type', async t => {
  const f = await seated(t);
  const id = await pending(f);
  const real = f.control.send.bind(f.control);
  // Same words, wrong type. Before F1 this deferred forever; the message is approved and paid for, so
  // "forever" meant it was never delivered and never reported failed either.
  f.control.send = async () => { throw Error('Recipient is busy or waiting for permission'); };
  await f.control.channels.deliverPending();
  f.control.send = real;
  assert.equal(row(f, id).state, 'failed', 'only a real RecipientBusy may defer');
});

// F2. MAX_ATTEMPTS never bounded the busy case: the busy skip costs no attempt, by design, so before the
// deadline the only thing that stopped a message waiting on a permanently busy seat was the channel
// expiring -- up to 30 days.
test('a message deferred past its deadline expires, and expiry is not failure', async t => {
  const f = await seated(t);
  const id = await pending(f);
  const spent = used(f);
  f.states.set(f.project, { ...f.states.get(f.project), status: 'running' });
  f.control.channels.now = () => Date.now() + 7 * 3600000;
  await f.control.channels.deliverPending();
  const held = full(f, id);
  assert.equal(held.state, 'expired', 'a distinct terminal state: the approval did not change, the seat never freed');
  assert.match(held.failure, /did not become free within the deferral deadline/);
  assert.equal(f.admitted(), 0, 'nothing stale is delivered');
  assert.equal(used(f), spent, 'allowance is not refunded, or a sender could loop against a busy prime for free');
});

test('a deferred message inside its deadline is still waiting, not expired', async t => {
  const f = await seated(t);
  const id = await pending(f);
  f.states.set(f.project, { ...f.states.get(f.project), status: 'running' });
  f.control.channels.now = () => Date.now() + 3600000;
  await f.control.channels.deliverPending();
  assert.equal(row(f, id).state, 'pending');
});

test('a busy skip is counted as a deferral and still costs no delivery attempt', async t => {
  const f = await seated(t);
  const id = await pending(f);
  const before = full(f, id);
  f.states.set(f.project, { ...f.states.get(f.project), status: 'running' });
  await f.control.channels.deliverPending();
  await f.control.channels.deliverPending();
  const after = full(f, id);
  assert.equal(after.attempts, before.attempts, 'MAX_ATTEMPTS bounds obstacles we cannot explain; a busy seat is not one');
  assert.equal(after.deferrals, before.deferrals + 2, 'but the waiting is visible');
  assert.ok(after.deferredAt, 'and dated from the first deferral');
  assert.equal(after.deferredAt, before.deferredAt, 'the deadline is not pushed forward by each pass that finds the seat busy');
});

// The rule, now that the unreachable clamp is gone: an expired approval is a CHANGED approval. 'expired'
// says the recipient never became free; 'failed' says something about the approval or the sender's
// authority changed. A channel that runs out while a message waits is the second kind, and assertUsable
// classifying it as SourceChanged is the right answer -- so this asserts 'failed' deliberately, and is
// what stops anyone "fixing" it back into a clamp. Documented in docs/project-roles.md.
test('a message still waiting when its channel expires is failed, not expired', async t => {
  const f = await seated(t);
  const id = await pending(f);
  f.states.set(f.project, { ...f.states.get(f.project), status: 'running' });
  const expiresAt = new Date(Date.now() + 60000).toISOString();
  f.store.db.prepare('UPDATE role_channels SET expiresAt=? WHERE id=?').run(expiresAt, f.channel.channelId);
  // Past the channel, nowhere near the six-hour deferral deadline.
  f.control.channels.now = () => Date.now() + 120000;
  await f.control.channels.deliverPending();
  const held = full(f, id);
  assert.equal(held.state, 'failed', 'an expired approval is a changed approval, not a slow recipient');
  assert.match(held.failure, /Channel became unusable/);
  assert.equal(f.admitted(), 0);
});

test('the deferral deadline is the TTL alone, and no message outlives its approval anyway', async t => {
  const f = await seated(t);
  const id = await pending(f);
  const m = full(f, id);
  assert.equal(f.control.channels.deadline(m), Date.parse(m.deferredAt) + 6 * 3600000);
  assert.equal(f.control.channels.deadline.length, 1, 'no channel record: the clamp is gone, not merely unused');
});

// F3. controller.send has always answered "what became of this identity"; the channel refused to, so a
// sender whose RPC response was lost could neither learn the outcome nor re-send.
test('a sender may ask what became of a deferred message by re-sending it', async t => {
  const f = await seated(t);
  f.states.set(f.project, { ...f.states.get(f.project), status: 'running' });
  const messageId = randomUUID();
  const input = { sessionId: f.prime, channelId: f.channel.channelId, messageId, text: 'Report the current blocker on this project' };
  const first = await f.request({ method: 'channels-send', capability: f.primeCapability, input });
  assert.equal(first.state, 'pending');
  const spent = used(f);
  const again = await f.request({ method: 'channels-send', capability: f.primeCapability, input });
  assert.equal(again.state, 'pending', 'the current state, not a refusal');
  assert.equal(again.resend, true);
  assert.equal(used(f), spent, 'and it spends no allowance');
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM role_channel_messages').get().n, 1, 'and writes no second row');
});

test('the same identity carrying different text is still a replay and still refused', async t => {
  const f = await seated(t);
  const messageId = randomUUID();
  const base = { sessionId: f.prime, channelId: f.channel.channelId, messageId };
  await f.request({ method: 'channels-send', capability: f.primeCapability, input: { ...base, text: 'The agreed report' } });
  await assert.rejects(f.request({ method: 'channels-send', capability: f.primeCapability, input: { ...base, text: 'Something else entirely' } }),
    /Message identity already used/);
});

// F4. unread counted only DELIVERED, so a deferred report was invisible in the one cheap summary either
// seat reads: the prime could not tell something was waiting, the sender could not tell if it landed.
test('both seats can see a deferred message without pulling a thread', async t => {
  const f = await seated(t);
  const id = await pending(f);
  const mine = c => c.channels[0];
  const recipient = mine(await f.request({ method: 'channels-list', capability: f.projectCapability, input: { sessionId: f.project } }));
  assert.equal(recipient.awaiting, 1, 'the receiving seat can see that a report is waiting for it');
  assert.equal(recipient.outbound.pending, 0, 'and does not mistake it for one of its own');
  const sender = mine(await f.request({ method: 'channels-list', capability: f.primeCapability, input: { sessionId: f.prime } }));
  assert.equal(sender.outbound.pending, 1, 'the sending seat can see its report is queued, not lost');
  assert.equal(sender.awaiting, 0);
  await f.control.channels.deliverPending();
  const after = mine(await f.request({ method: 'channels-list', capability: f.primeCapability, input: { sessionId: f.prime } }));
  assert.equal(after.outbound.pending, 0);
  assert.equal(after.outbound.delivered, 1);
  assert.equal(full(f, id).state, 'delivered');
});

test('a deferred message carries how long it waited, so held-back text is not read as current', async t => {
  const f = await seated(t);
  const id = await pending(f);
  const thread = await f.request({ method: 'channels-thread', capability: f.primeCapability, input: { sessionId: f.prime, channelId: f.channel.channelId } });
  const m = thread.messages.find(x => x.messageId === id);
  assert.ok(m.deferredAt, 'the reader can see this was written while they were busy');
  assert.equal(m.state, 'pending');
});

// The property the whole item is about, and the one nothing pinned: a report survives the daemon dying.
test('a deferred report survives a restart and is delivered by the new process', async t => {
  const f = await seated(t);
  const id = await pending(f);
  assert.equal(row(f, id).state, 'pending');
  // What server.mjs does at startup: a fresh RoleChannels over the same journal, then pump.
  const restarted = new RoleChannels(f.control, () => Date.now());
  f.control.channels = restarted;
  assert.ok(restarted.interested(f.project), 'the restored seat is still interesting to the event loop');
  await restarted.deliverPending();
  assert.equal(row(f, id).state, 'delivered', 'the report is not lost with the process that accepted it');
  assert.equal(f.admitted(), 1);
});

test('an unknown message schema is refused rather than started, and the known one is migrated', async t => {
  const f = await seated(t);
  const columns = () => f.store.db.prepare('PRAGMA table_info(role_channel_messages)').all().map(r => r.name).join(',');
  const before = columns();
  assert.ok(before.endsWith(',deferredAt,deferrals'), 'added columns are appended, which is the order every positional INSERT assumes');
  // The pre-F2 shape, as a controller carrying real channel history would have it.
  f.store.db.exec(`DROP TABLE role_channel_messages; CREATE TABLE role_channel_messages(${before.replace(',deferredAt,deferrals', '')
    .split(',').map(c => `${c} TEXT`).join(',')})`);
  const migrated = new RoleChannels(f.control, () => Date.now());
  assert.equal(columns(), before, 'an existing journal is migrated in place, not refused');
  assert.ok(migrated);
  f.store.db.exec('ALTER TABLE role_channel_messages ADD COLUMN somethingNobodyPlanned TEXT');
  assert.throws(() => new RoleChannels(f.control, () => Date.now()), /Unsupported role_channel_messages schema/,
    'and a shape nobody planned for is still refused at startup');
});

// control.busy is the in-flight OPERATION lock, not "mid-turn", so a prime that is simply working is
// discovered inside control.send instead -- after this loop already spent an attempt on it. Twenty passes
// of a working prime (~10 minutes at the watchdog interval) therefore used to exhaust MAX_ATTEMPTS and
// record the report 'failed', blaming the receiving seat for what was only the sender arriving early.
test('a prime that is merely working does not exhaust the attempt budget', async t => {
  const f = await seated(t);
  const id = await pending(f);
  f.states.set(f.project, { ...f.states.get(f.project), status: 'running' });
  const before = full(f, id).deferrals;
  for (let n = 0; n < 25; n++) await f.control.channels.deliverPending();
  const held = full(f, id);
  assert.equal(held.state, 'pending', 'still waiting for the prime, not failed for waiting');
  assert.equal(held.attempts, 0, 'a refusal that admitted nothing is not an attempt');
  assert.equal(held.deferrals, before + 25, 'comfortably past MAX_ATTEMPTS, which no longer bounds this');
  // And it lands the moment the prime is free, with no re-approval and no re-send by anyone.
  f.states.set(f.project, { ...f.states.get(f.project), status: 'idle' });
  await f.control.channels.deliverPending();
  assert.equal(row(f, id).state, 'delivered');
  assert.equal(f.admitted(), 1);
});

// Found by mutation: dropping the sender check from the resend match left no test failing. Both seats can
// already read every message on their channel, so nothing leaks -- but the COUNTERPART would have had its
// own message silently swallowed and been handed the other seat's state as if it were its own outcome.
test('the counterpart seat cannot resend the other seat\'s identity', async t => {
  const f = await seated(t);
  const messageId = randomUUID();
  const text = 'Report the current blocker on this project';
  await f.request({ method: 'channels-send', capability: f.primeCapability, input: { sessionId: f.prime, channelId: f.channel.channelId, messageId, text } });
  await assert.rejects(
    f.request({ method: 'channels-send', capability: f.projectCapability, input: { sessionId: f.project, channelId: f.channel.channelId, messageId, text } }),
    /Message identity already used/, 'the other seat is sending, not asking after its own message');
});

// ---------------------------------------------------------------------------------------------------
// Review conditions C1, C2, C4.
// ---------------------------------------------------------------------------------------------------

const listing = async (f, session, capability) =>
  (await f.request({ method: 'channels-list', capability, input: { sessionId: session } })).channels[0];

// C1. The first version seeded four buckets and filled them with `if (state in outbound)`, so a row in
// any other state was counted in NOTHING: allowance spent, row present, every counter reading zero, and
// deliverPending selecting 'pending' only so the pump would never retry it either. That is the exact
// invisibility F4 was approved to remove.
for (const state of ['uncertain', 'refused', 'queued', 'reserved']) {
  test(`a message left in '${state}' is counted, not dropped`, async t => {
    const f = await seated(t);
    const { messageId } = await f.send(f.prime, f.primeCapability);
    f.store.db.prepare('UPDATE role_channel_messages SET state=? WHERE messageId=?').run(state, messageId);
    const sender = await listing(f, f.prime, f.primeCapability);
    assert.equal(sender.outbound[state], 1, 'the sender can see the state its message is actually in');
    assert.equal(sender.outbound.total, 1, 'and the total agrees with the rows');
    assert.equal(sender.outbound.other, 0, 'without falling into the catch-all');
    const recipient = await listing(f, f.project, f.projectCapability);
    assert.equal(recipient.inbound[state], 1, 'and so can the seat it was sent to');
    assert.equal(recipient.inbound.total, 1);
  });
}

test('a state nobody named still shows up in the total and in other', async t => {
  const f = await seated(t);
  const { messageId } = await f.send(f.prime, f.primeCapability);
  f.store.db.prepare("UPDATE role_channel_messages SET state='inventedLater' WHERE messageId=?").run(messageId);
  const sender = await listing(f, f.prime, f.primeCapability);
  assert.equal(sender.outbound.other, 1, 'an unnamed state is surfaced, never silently dropped');
  assert.equal(sender.outbound.total, 1);
  assert.equal(Object.entries(sender.outbound).filter(([k]) => !['other', 'total'].includes(k)).reduce((n, [, v]) => n + v, 0), 0);
});

test('awaiting still means pending to me, and the two directions do not mix', async t => {
  const f = await seated(t);
  await pending(f);
  const recipient = await listing(f, f.project, f.projectCapability), sender = await listing(f, f.prime, f.primeCapability);
  assert.equal(recipient.awaiting, 1);
  assert.equal(recipient.inbound.pending, 1);
  assert.equal(recipient.outbound.total, 0, 'a message TO this seat is not one OF its own');
  assert.equal(sender.awaiting, 0);
  assert.equal(sender.outbound.pending, 1);
});

// C2. assertSenderAuthority is an off-box lookup and was awaited per message, so one seat's 32 rows made
// 32 identical calls for one answer. Harmless while a stuck message died after 20 attempts; with the
// attempt refund it waits out the deadline instead, multiplying the redundancy by every pass in six hours.
test('the pump asks each originator\'s authority once per pass, not once per message', async t => {
  const f = await seated(t);
  f.states.set(f.project, { ...f.states.get(f.project), status: 'running' });
  // Each send schedules its own pump; let it settle or the next send collides on the session lock.
  for (let n = 0; n < 3; n++) { await f.send(f.prime, f.primeCapability); await f.control.channels.pumping; }
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM role_channel_messages WHERE state='pending'").get().n, 3);
  // PROGRAMME is the sending prime's task: these reads are the pump's own assertSenderAuthority, the ones
  // C2 asked to batch. The recipient's task is looked up separately inside control.send, once per message
  // that actually reaches it, which is not this pump's call to make.
  const before = f.authorityReads(PROGRAMME);
  await f.control.channels.deliverPending();
  assert.equal(f.authorityReads(PROGRAMME) - before, 1, 'three pending messages from one seat cost one sender-authority read');
});

test('a batched authority verdict still fails the whole originator, and still distinguishes unknown from changed', async t => {
  const f = await seated(t);
  f.states.set(f.project, { ...f.states.get(f.project), status: 'running' });
  for (let n = 0; n < 2; n++) { await f.send(f.prime, f.primeCapability); await f.control.channels.pumping; }
  f.states.set(f.project, { ...f.states.get(f.project), status: 'idle' });
  // Unknown: retried, both rows, bounded by attempts as before.
  f.breakAuthority(true);
  await f.control.channels.deliverPending();
  for (const r of f.store.db.prepare("SELECT state,failure FROM role_channel_messages").all()) {
    assert.equal(r.state, 'pending');
    assert.match(r.failure, /authority could not be read/);
  }
  // Definite change: cancelled, both rows, from the one batched verdict.
  f.breakAuthority(false);
  f.rotate(PROGRAMME);
  await f.control.channels.deliverPending();
  for (const r of f.store.db.prepare('SELECT state,failure FROM role_channel_messages').all()) {
    assert.equal(r.state, 'failed');
    assert.match(r.failure, /authority could not be read|task authority changed/i);
  }
  assert.equal(f.admitted(), 0);
});

// C4. Two auto-committing ALTERs left a window in which the table could come to rest at COLUMNS + one
// added column -- matching neither the migration guard nor assertColumns, so the controller refused to
// start on that restart and every restart after it, until an operator hand-wrote the remaining DDL.
test('a half-applied migration cannot be left behind', async t => {
  const f = await seated(t);
  const columns = () => f.store.db.prepare('PRAGMA table_info(role_channel_messages)').all().map(r => r.name).join(',');
  const before = columns();
  // The real migration's first statement, then one that must fail. Non-transactionally this leaves the
  // unrecoverable shape; in one transaction it leaves nothing.
  assert.throws(() => f.control.channels.applyMigration([
    'ALTER TABLE role_channel_messages ADD COLUMN probeOne TEXT',
    'ALTER TABLE role_channel_messages ADD COLUMN probeOne TEXT']));
  assert.equal(columns(), before, 'the failed statement took the successful one with it');
  // And the journal is still startable, which is the property that actually matters.
  assert.ok(new RoleChannels(f.control, () => Date.now()));
});

test('the real migration is all or nothing on a pre-F2 journal', async t => {
  const f = await seated(t);
  const columns = () => f.store.db.prepare('PRAGMA table_info(role_channel_messages)').all().map(r => r.name).join(',');
  const target = columns(), old = target.replace(',deferredAt,deferrals', '');
  f.store.db.exec(`DROP TABLE role_channel_messages; CREATE TABLE role_channel_messages(${old.split(',').map(c => `${c} TEXT`).join(',')})`);
  assert.equal(columns(), old);
  new RoleChannels(f.control, () => Date.now());
  assert.equal(columns(), target, 'both columns, or the constructor would have thrown before reaching here');
});

// The risk a cache introduces is being keyed too broadly: one seat's authority answering for another's.
// Both directions are pending here, so a pass must ask about BOTH tasks -- a single shared key would
// silently let the first originator vouch for the second.
test('each originator is asked about separately; one seat never vouches for the other', async t => {
  const f = await seated(t);
  f.states.set(f.project, { ...f.states.get(f.project), status: 'running' });
  f.states.set(f.prime, { ...f.states.get(f.prime), status: 'running' });
  await f.send(f.prime, f.primeCapability); await f.control.channels.pumping;
  await f.send(f.project, f.projectCapability); await f.control.channels.pumping;
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM role_channel_messages WHERE state='pending'").get().n, 2);
  // Counted on the pump's own call, not on control.authority: both seats are sender AND recipient here,
  // and control.send looks up the RECIPIENT's task too, which is not this pump's to batch.
  const asked = [], real = f.control.channels.assertSenderAuthority.bind(f.control.channels);
  f.control.channels.assertSenderAuthority = async id => { asked.push(id); return real(id); };
  await f.control.channels.deliverPending();
  assert.deepEqual(asked.sort(), [f.prime, f.project].sort(), 'each originator asked about exactly once, and neither skipped');
});
