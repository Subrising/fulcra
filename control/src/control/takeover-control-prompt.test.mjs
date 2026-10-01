import { FENCE_PROTOCOL } from './native-fence.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ControlStore } from './store.mjs';
import { Controller } from './controller.mjs';
import { CONTROL_PREFIX, projectPromptId } from './native.mjs';
import { PROGRAMME, COMPANY } from './authority.mjs';
import { requireUnpinnedAdmissionGuard } from './admission-guard-precondition.mjs';
requireUnpinnedAdmissionGuard(); // Fails loudly when the working guard is pinned; see that module.

// The fence exists to notice a HUMAN typing into a delegated session, and it must keep doing that. What
// it must not do is treat the control plane's own dispatched turn as human activity.
//
// Provenance is a CREDENTIAL, not a label. The `orca-control:` prefix is a namespace convention that any
// daemon client can set, so a prompt only counts as ours when the controller's own deliveries row exists
// for that messageId, this session and this generation -- the same fact admission checks.
const issue = id => ({ id, companyId: COMPANY, parentId: PROGRAMME, assigneeUserId: 'local-board', assigneeAgentId: null, status: 'in_progress' });

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orca-takeover-'))), file = path.join(dir, 'journal.sqlite'), store = new ControlStore(file);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const id = randomUUID(), current = { status: 'idle', pending: 0, lastPromptId: null, promptClaimsControl: false };
  const native = {
    landThenFail: false,
    receiptCompleted: false,
    create: async () => ({ id, cwd: dir }),
    inspect: async () => ({ boot: 'fixture', fenceProtocol: FENCE_PROTOCOL, saturated: false, humanAt: 0, ...current }),
    // Mirrors the real adapter: it stamps the prefix, and the projection below is the real one.
    // `landThenFail` reproduces the send that ARRIVES and then loses its acknowledgement, which is how
    // a row goes 'uncertain' while the prompt really is the session's last one.
    send: async (_id, _text, messageId) => {
      Object.assign(current, projectPromptId(CONTROL_PREFIX + messageId));
      if (native.landThenFail) throw new Error('transport closed after the prompt landed');
    },
    receipt: async () => (native.receiptCompleted ? { state: 'completed' } : { state: 'pending' }),
  };
  const controller = new Controller({ store, native, authority: async () => issue(PROGRAMME) });
  store.created(id, PROGRAMME, dir);
  return { store, id, current, controller, native };
}

// A prompt arriving on the timeline, projected exactly as native.inspect projects it. Whether it is
// honest is decided by whether a deliveries row exists, not by what it says.
const arrives = (f, rawClientMessageId) => Object.assign(f.current, projectPromptId(rawClientMessageId));

// Writes the deliveries row the controller writes before dispatching, so a prompt has a real credential.
function dispatchedRow(f, messageId, state = 'delivered') {
  const row = f.store.get(f.id);
  f.store.admit(messageId, f.id, 'send', { sessionId: f.id, messageId, text: 'a dispatched turn' });
  f.store.finish(messageId, state, { generation: row.generation });
  return messageId;
}

test('the real projection reads the prefix as a claim and strips it', () => {
  const id = randomUUID();
  // This is native.mjs:104's logic, executed. Previously nothing ran it: the tests hand-built the shape.
  assert.deepEqual(projectPromptId(CONTROL_PREFIX + id), { promptClaimsControl: true, lastPromptId: id });
  assert.deepEqual(projectPromptId(id), { promptClaimsControl: false, lastPromptId: id });
  assert.deepEqual(projectPromptId(null), { promptClaimsControl: false, lastPromptId: null });
  // The slice used to be the literal 13 with nothing pinning it.
  assert.equal(CONTROL_PREFIX.length, 13);
  assert.equal(projectPromptId(CONTROL_PREFIX + id).lastPromptId.length, id.length);
  // A forged prefix projects identically to an honest one -- which is the whole reason the prefix
  // cannot be the thing the fence trusts.
  assert.equal(projectPromptId(CONTROL_PREFIX + 'forged-by-anyone').promptClaimsControl, true);
});

test('a forged orca-control: prefix with no deliveries row is still a takeover', async t => {
  const f = fixture(t), grant = await f.controller.handback(f.id, 'Delegate a task');
  await f.controller.send({ sessionId: f.id, messageId: randomUUID(), text: 'First task' }, grant.capability);
  assert.equal(f.store.get(f.id).mode, 'delegated');

  // Anything that can talk to the daemon can set this. Nothing wrote a deliveries row for it.
  arrives(f, CONTROL_PREFIX + 'forged-by-anyone');
  await f.controller.inspect(f.id);

  assert.equal(f.store.get(f.id).mode, 'human', 'a forged prefix must not suppress the takeover');
  assert.notEqual(f.store.get(f.id).expected, 'forged-by-anyone', 'and must never be adopted as expected');
});

test('a forged prefix reusing a real id from another session or generation is still a takeover', async t => {
  const f = fixture(t), grant = await f.controller.handback(f.id, 'Delegate a task');
  await f.controller.send({ sessionId: f.id, messageId: randomUUID(), text: 'First task' }, grant.capability);

  // A row that exists, but for a different session: the credential is scoped, not merely present.
  const foreign = randomUUID();
  f.store.admit(foreign, randomUUID(), 'send', { sessionId: randomUUID(), messageId: foreign, text: 'someone else' });
  f.store.finish(foreign, 'delivered', { generation: f.store.get(f.id).generation });
  arrives(f, CONTROL_PREFIX + foreign);
  await f.controller.inspect(f.id);
  assert.equal(f.store.get(f.id).mode, 'human', 'a row for another session is not this session’s credential');
});

test('a credential from an earlier generation is stale and does not excuse the prompt', async t => {
  const f = fixture(t), grant = await f.controller.handback(f.id, 'Delegate a task');
  const older = randomUUID(), newer = randomUUID();
  await f.controller.send({ sessionId: f.id, messageId: older, text: 'First task' }, grant.capability);
  await f.controller.send({ sessionId: f.id, messageId: newer, text: 'Second task' }, grant.capability);
  const firstGeneration = f.store.get(f.id).generation;
  assert.equal(f.store.delivery(older).result.generation, firstGeneration, 'a real send records its generation');

  // Taken over and re-delegated, which is the ordinary recovery path. handback pins `expected` to the
  // last prompt seen, so the OLDER id is the one that can still differ from it.
  f.controller.takeover(f.id, 'Human takes control');
  await f.controller.handback(f.id, 'Delegate again');
  assert.notEqual(f.store.get(f.id).generation, firstGeneration, 'a re-delegation must bump the generation');
  assert.equal(f.store.get(f.id).expected, newer);

  // The old row is still in the journal and still honest about what happened -- at the old generation.
  arrives(f, CONTROL_PREFIX + older);
  await f.controller.inspect(f.id);
  assert.equal(f.store.get(f.id).mode, 'human', 'a row from a previous generation is not a credential now');
});

test('a refused delivery is not a credential, because it never ran', async t => {
  const f = fixture(t), grant = await f.controller.handback(f.id, 'Delegate a task');
  await f.controller.send({ sessionId: f.id, messageId: randomUUID(), text: 'First task' }, grant.capability);

  const refused = dispatchedRow(f, randomUUID(), 'refused');
  arrives(f, CONTROL_PREFIX + refused);
  await f.controller.inspect(f.id);
  assert.equal(f.store.get(f.id).mode, 'human', 'a refused send never reached the session');
});

// The legitimate case the whole fix exists for, in the only shape that actually reaches the credential:
// a send that LANDED and then lost its acknowledgement. `expected` was never advanced, so the session's
// real last prompt is a dispatch that `expected` does not name.
//
// Note on the 'delivered' variant: a successful send advances `expected` to that same id in the same
// call, so a delivered row and a lagging `expected` cannot both be true. It is not constructed here
// because the system cannot produce it -- the rule this suite adopted last round.
test('a landed-but-unacknowledged dispatch is not a takeover, and becomes the expected one', async t => {
  const f = fixture(t), grant = await f.controller.handback(f.id, 'Delegate a task');
  const first = randomUUID(), landed = randomUUID();
  await f.controller.send({ sessionId: f.id, messageId: first, text: 'First task' }, grant.capability);
  assert.equal(f.store.get(f.id).expected, first);

  f.native.landThenFail = true;
  await f.controller.send({ sessionId: f.id, messageId: landed, text: 'Second task' }, grant.capability);
  f.native.landThenFail = false;
  assert.equal(f.store.delivery(landed).state, 'uncertain', 'the prompt arrived; the acknowledgement did not');
  assert.equal(f.store.delivery(landed).result.generation, f.store.get(f.id).generation);
  assert.equal(f.store.get(f.id).expected, first, 'expected still names the previous turn');
  assert.equal(f.current.lastPromptId, landed, 'but the session\u2019s last prompt is the one that landed');

  await f.controller.inspect(f.id);
  assert.equal(f.store.get(f.id).mode, 'delegated', 'a dispatch we really made must not revoke the delegation');
  assert.equal(f.store.get(f.id).expected, landed, 'and expected advances to it');
});

// Q2, demonstrated by the reviewer: the ids are not secret -- the controller reads them off the ordinary
// timeline API -- so anything with timeline read can replay one.
test('replaying a genuine, already-delivered id is a takeover', async t => {
  const f = fixture(t), grant = await f.controller.handback(f.id, 'Delegate a task');
  const first = randomUUID(), second = randomUUID();
  await f.controller.send({ sessionId: f.id, messageId: first, text: 'First task' }, grant.capability);
  await f.controller.send({ sessionId: f.id, messageId: second, text: 'Second task' }, grant.capability);
  assert.equal(f.store.get(f.id).expected, second);
  assert.equal(f.store.delivery(first).state, 'delivered', 'the replayed id is a real, completed dispatch');

  arrives(f, CONTROL_PREFIX + first);
  await f.controller.inspect(f.id);
  assert.equal(f.store.get(f.id).mode, 'human', 'a replayed credential must not suppress the takeover');
});

test('a replay never moves expected backwards', async t => {
  const f = fixture(t), grant = await f.controller.handback(f.id, 'Delegate a task');
  const first = randomUUID(), second = randomUUID();
  await f.controller.send({ sessionId: f.id, messageId: first, text: 'First task' }, grant.capability);
  await f.controller.send({ sessionId: f.id, messageId: second, text: 'Second task' }, grant.capability);

  arrives(f, CONTROL_PREFIX + first);
  await f.controller.inspect(f.id);
  // The takeover clears `expected` rather than leaving it, so the property is that it never becomes the
  // replayed id -- not that it keeps the newer one.
  assert.notEqual(f.store.get(f.id).expected, first, 'expected must never roll back to the older dispatch');
  assert.equal(f.store.get(f.id).mode, 'human');

  // Replaying the id that IS `expected` is deliberately not asserted here: it is indistinguishable
  // from nothing having changed, and nothing moves in that case.
});

// Q5, demonstrated by the reviewer: recovering an uncertain send is the normal operator action, and it
// used to overwrite the row without the generation, destroying the credential of a healthy session.
test('recover() on an uncertain send keeps the credential, so no spurious takeover', async t => {
  const f = fixture(t), grant = await f.controller.handback(f.id, 'Delegate a task');
  const first = randomUUID(), landed = randomUUID();
  await f.controller.send({ sessionId: f.id, messageId: first, text: 'First task' }, grant.capability);
  f.native.landThenFail = true;
  await f.controller.send({ sessionId: f.id, messageId: landed, text: 'Second task' }, grant.capability);
  f.native.landThenFail = false;
  assert.equal(f.store.delivery(landed).state, 'uncertain');

  // The operator reconciles the unresolved delivery before the next observation. The receipt does not
  // establish completion, so the row is rewritten as uncertain -- and must stay a credential.
  await f.controller.recover(landed);
  assert.equal(f.store.delivery(landed).state, 'uncertain');
  assert.equal(f.store.delivery(landed).result.generation, f.store.get(f.id).generation,
    'recovery must not strip the generation the credential needs');

  await f.controller.inspect(f.id);
  assert.equal(f.store.get(f.id).mode, 'delegated', 'recovering a healthy session must not revoke it');
});

test('an unprefixed prompt still revokes, on inspect and on send', async t => {
  const f = fixture(t), grant = await f.controller.handback(f.id, 'Delegate a task');
  await f.controller.send({ sessionId: f.id, messageId: randomUUID(), text: 'First task' }, grant.capability);

  arrives(f, 'typed-by-a-human');
  await f.controller.inspect(f.id);
  assert.equal(f.store.get(f.id).mode, 'human', 'a human prompt must still take the session over');

  const g = fixture(t), grantB = await g.controller.handback(g.id, 'Delegate a task');
  await g.controller.send({ sessionId: g.id, messageId: randomUUID(), text: 'First task' }, grantB.capability);
  arrives(g, 'typed-by-a-human');
  await assert.rejects(
    g.controller.send({ sessionId: g.id, messageId: randomUUID(), text: 'Next task' }, grantB.capability),
    /revoked delegation/,
    'the send path must still refuse after human activity',
  );
  assert.equal(g.store.get(g.id).mode, 'human');
});

// a9900b3f asserted "humanAt crossing the grant still revokes, whatever the prompt provenance claims"
// by setting promptFromControl AND an advanced humanAt at once. The reviewer showed the system cannot
// produce that pair, so the test proved the `||` wiring and not its own title. This reaches humanAt the
// only way the system does -- through the real guard -- and records what it actually shows.
test('humanAt is NOT independent of the prefix: one signal, read twice', async () => {
  const { guard, observation } = await import('./admission-guard.mjs');
  const human = randomUUID(), prefixed = randomUUID();
  assert.equal(observation(human).humanAt, 0);

  // No prefix: the guard's human branch advances humanInput, with no journal or filesystem dependency.
  guard({ id: human }, 'typed by a person', { clientMessageId: randomUUID() }, false);
  assert.equal(observation(human).humanAt, 1, 'an unprefixed prompt advances humanAt');

  // With the prefix the guard takes the controlled branch and never touches humanInput. It refuses
  // here (no matching deliveries row), which is the real backstop -- but the point is what did NOT
  // happen to humanAt. The controlled branch opens the journal read-only; nothing is written.
  try { guard({ id: prefixed }, 'claims to be ours', { clientMessageId: CONTROL_PREFIX + 'forged-by-anyone' }, false); }
  catch { /* refused at admission, which is expected and is the backstop */ }
  assert.equal(observation(prefixed).humanAt, 0,
    'a prefixed prompt leaves humanAt untouched -- so humanAt cannot be the backstop for a bad prefix');
});

// ADMISSION IN THE LOOP. Every other test here drives Controller with a stub native, so the refusal
// that actually stops a forged or replayed prompt EXECUTING is never exercised beside the fence that
// decides whether it counts as ours. They have only ever been reasoned about together.
//
// The real guard's admit() takes the journal as an argument, so it can run against this test's own temp
// journal: no live journal is opened and admission-guard.mjs is not modified. The fixture calls it from
// inside native.send, which is where the daemon calls it.
test('admission and the fence agree: a replayed id is refused AND is a takeover', async t => {
  const { admit, BOOT } = await import('./admission-guard.mjs');
  const { DatabaseSync } = await import('node:sqlite');

  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orca-admit-'))), file = path.join(dir, 'journal.sqlite');
  const store = new ControlStore(file);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const id = randomUUID(), current = { status: 'idle', pending: 0, lastPromptId: null, promptClaimsControl: false };
  const db = new DatabaseSync(file, { readOnly: true });
  t.after(() => db.close());
  const admitted = [];
  const native = {
    // boot must be the guard's own BOOT, because that is the fence it checks against.
    inspect: async () => ({ boot: BOOT, fenceProtocol: FENCE_PROTOCOL, saturated: false, humanAt: 0, ...current }),
    send: async (agentId, text, messageId) => {
      // Exactly what the daemon does: the real guard adjudicates before the prompt is allowed to run.
      admitted.push(admit(db, { id: agentId }, text, messageId, false));
      Object.assign(current, projectPromptId(CONTROL_PREFIX + messageId));
    },
  };
  const controller = new Controller({ store, native, authority: async () => issue(PROGRAMME) });
  store.created(id, PROGRAMME, dir);
  const grant = await controller.handback(id, 'Delegate a task');

  const genuine = randomUUID();
  await controller.send({ sessionId: id, messageId: genuine, text: 'A real task' }, grant.capability);
  assert.deepEqual(admitted, [true], 'the real guard admitted the genuine in-flight dispatch');
  assert.equal(store.delivery(genuine).state, 'delivered');

  // Now the replay, as an attacker performs it: the same id, sent again, after the row settled.
  assert.throws(() => admit(db, { id }, 'A real task', genuine, false), /refused/,
    'the real guard refuses a replayed id, because its row is no longer intent');

  // And the fence, independently, refuses to treat it as ours.
  const second = randomUUID();
  await controller.send({ sessionId: id, messageId: second, text: 'Another task' }, grant.capability);
  Object.assign(current, projectPromptId(CONTROL_PREFIX + genuine)); // replay lands on the timeline
  await controller.inspect(id);
  assert.equal(store.get(id).mode, 'human', 'the fence takes over on a replay, independently of admission');
});

// The regression the whole series started from (a9900b3f). It has only ever been covered implicitly --
// the replay tests perform two successive sends, which could not happen if the first had revoked -- and
// the explicitly named test was deleted last round because its shape was the replay. This names it.
test('regression: a dispatched turn that completes does not revoke, and the next task still delivers', async t => {
  const f = fixture(t), grant = await f.controller.handback(f.id, 'Delegate a task');
  const dispatched = randomUUID();
  await f.controller.send({ sessionId: f.id, messageId: dispatched, text: 'First task' }, grant.capability);
  assert.equal(f.store.delivery(dispatched).state, 'delivered');
  assert.equal(f.store.get(f.id).expected, dispatched);
  assert.equal(f.current.lastPromptId, dispatched, 'the worker finished the turn we sent it');

  await f.controller.inspect(f.id);
  assert.equal(f.store.get(f.id).mode, 'delegated', 'observing a completed turn must not revoke the delegation');

  const next = await f.controller.send({ sessionId: f.id, messageId: randomUUID(), text: 'Next task' }, grant.capability);
  assert.equal(next.state, 'delivered', 'and the controller can still deliver the next task');
  assert.equal(f.store.get(f.id).mode, 'delegated');
});

// Reviewer's Finding 1, demonstrated: a newer send row written WITHOUT a generation used to make
// latestDispatched fall through to an OLDER id, handing an attacker a replayable credential. The scan
// now stops at the newest row and fails closed, so the older id is never vouched for.
test('a newer credential-less send row does not make an older dispatch replayable', async t => {
  const f = fixture(t), grant = await f.controller.handback(f.id, 'Delegate a task');
  const older = randomUUID();
  await f.controller.send({ sessionId: f.id, messageId: older, text: 'First task' }, grant.capability);
  assert.equal(f.controller.latestDispatched(f.store.get(f.id)), older);

  // A leadership wake, exactly as leadership.mjs wrote it before the correction: a newer `send` row
  // with no generation, and `expected` advanced to the wake id in the same transaction. That second
  // half is what makes the hole reachable -- without it the replayed id would equal `expected` and the
  // fence would short-circuit before consulting any credential.
  const wake = randomUUID();
  f.store.admit(wake, f.id, 'send', { sessionId: f.id, messageId: wake, text: 'a wake' });
  f.store.finish(wake, 'delivered', { recovered: true, note: 'no generation recorded' });
  f.store.db.prepare('UPDATE sessions SET expected=? WHERE id=?').run(wake, f.id);

  assert.equal(f.controller.latestDispatched(f.store.get(f.id)), null,
    'an unvouchable newest row must fail closed, not fall through to an older one');
  assert.equal(f.controller.controlDispatched(older, f.store.get(f.id)), false,
    'the older dispatch must not be usable as the current credential');

  arrives(f, CONTROL_PREFIX + older);
  await f.controller.inspect(f.id);
  assert.equal(f.store.get(f.id).mode, 'human', 'replaying the older id must be a takeover');
});

// The other half of the same field, and the reason leadership must keep writing it. Once the scan stops
// at the newest row, omitting the generation no longer hands out an older credential -- it fails closed
// -- so the cost moves from a replay hole to a spurious takeover of a healthy session. A wake row that
// carries its generation stays vouchable; one that does not makes the session unvouchable.
test('a wake row that carries its generation is still the vouchable newest dispatch', async t => {
  const f = fixture(t), grant = await f.controller.handback(f.id, 'Delegate a task');
  await f.controller.send({ sessionId: f.id, messageId: randomUUID(), text: 'First task' }, grant.capability);
  const generation = f.store.get(f.id).generation;

  const wake = randomUUID();
  f.store.admit(wake, f.id, 'send', { sessionId: f.id, messageId: wake, text: 'a wake' });
  // Exactly what leadership.mjs writes now: the wake's own generation on the terminal row.
  f.store.finish(wake, 'delivered', { receipt: { state: 'completed' }, generation, recovered: true });

  assert.equal(f.controller.latestDispatched(f.store.get(f.id)), wake,
    'a wake row carrying its generation must remain the vouchable newest dispatch');
  assert.equal(f.controller.controlDispatched(wake, f.store.get(f.id)), true);
});
