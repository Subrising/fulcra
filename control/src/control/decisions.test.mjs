// Fulcra J3 (CONTRACTS.md §3.2–§3.4, §4.2): the decision store on a temporary journal. One test per §3.2
// invariant, then delivery, held messages and the digest. Delivery drives the PRODUCTION admit() at the
// native boundary, as seat-inbox.test.mjs does, so "delivered" means the real guard admitted it.
import { randomUUID, createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Decisions, STALE_REVISION, DIGEST_CHANGED, NO_UPDATE, DIGESTS_KEPT, chosenDeliveryId } from './decisions.mjs';
import { closeSeatingDefaults } from './role-defaults-fixture.mjs';
import { fixture, level1, option, P, T } from './decisions.fixture.mjs';
import { PROGRAMME } from './authority.mjs';
import { ROLE_TOOLS, grantLane } from './grant-file.mjs';
import { canonicalJson } from '../../orca-organization/shared/cc/decision-rules.mjs';
import { requireUnpinnedAdmissionGuard } from './admission-guard-precondition.mjs';
requireUnpinnedAdmissionGuard();

const sha = v => createHash('sha256').update(v).digest('hex');

test('§3.2 #1: option counts by kind and level', async t => {
  const f = await fixture(t);
  await assert.rejects(f.ask(level1({ options: [option('a')] })), /level-1 decision needs 2 or 3 options/);
  await assert.rejects(f.ask(level1({ recommendation: null })), /level-1 decision needs 2 or 3 options and a recommendation/);
  await assert.rejects(f.ask(level1({ level: 2, options: [], recommendation: null })), /decision needs 1 to 3 options/);
  await assert.rejects(f.ask(level1({ options: [option('a'), option('b'), option('c'), option('d')] })), /at most 3/);
  const q = await f.ask({ ...level1({ kind: 'question', level: 2, options: [], recommendation: null }) });
  assert.equal(q.decision.options.length, 0);
  // Approvals: exactly approve + reject (+ defer), and always bound to an action.
  f.control.decisions.binders.set('promotion', async () => ({ promotion: 'p', commit: 'c' }));
  const digest = sha(canonicalJson({ promotion: 'p', commit: 'c' })), action = { type: 'promotion', promotionId: randomUUID(), digest };
  const approval = x => level1({ kind: 'approval', level: 2, recommendation: null, action, ...x });
  await assert.rejects(f.ask(approval({ options: [option('approve'), option('maybe')] })), /exactly the options approve and reject/);
  await assert.rejects(f.ask(approval({ options: [option('approve'), option('reject')], action: { type: 'none' } })), /must be bound to an action/);
  assert.equal((await f.ask(approval({ options: [option('approve'), option('reject'), option('defer')] }))).decision.kind, 'approval');
});

test('§3.2 #2: the recommendation points at a real option, and option ids are unique', async t => {
  const f = await fixture(t);
  await assert.rejects(f.ask(level1({ recommendation: { optionId: 'z', why: 'It is simple.', confidence: 'low', wouldChangeIf: 'Never.' } })), /must point at one of the options/);
  await assert.rejects(f.ask(level1({ options: [option('a'), option('a')] })), /Option ids must be unique/);
});

test('§3.2 #3: a destructive option is refused without the second confirmation', async t => {
  const f = await fixture(t);
  const { decision } = await f.ask(level1({ options: [option('a'), option('b', { destructive: true })] }));
  await assert.rejects(f.choose(decision, 'b'), /confirm it a second time/);
  assert.equal(f.control.decisions.packet(decision.id).state, 'open');
  const done = await f.choose(decision, 'b', { confirmDestructive: true });
  assert.equal(done.decision.choice.optionId, 'b');
  // v1.5 (R-J3-5): an irreversible option is destructive whatever the asker set.
  const irreversible = option('b', { destructive: false, impacts: { ...option('b').impacts, reversibility: 'irreversible' } });
  const second = (await f.ask(level1({ title: 'Close the old shop for good?', options: [option('a'), irreversible] }))).decision;
  assert.equal(second.options[1].destructive, true);
  await assert.rejects(f.choose(second, 'b'), /confirm it a second time/);
});

test('§3.2 #4: the action digest is checked at ask and at choice; authority is id + revision + digest', async t => {
  const f = await fixture(t);
  let plan = { steps: ['deploy'], commit: 'a'.repeat(40) };
  f.control.decisions.binders.set('promotion', async () => plan);
  const promotionId = randomUUID(), digest = sha(canonicalJson(plan));
  const approval = { kind: 'approval', level: 1, projectId: P(1), taskId: null, askedOf: 'human', title: 'Put the new version in front of customers?', situation: 'The new version passed its checks. Customers would see it within the hour.',
    options: [option('approve'), option('reject')], recommendation: { optionId: 'approve', why: 'Everything it needs is ready.', confidence: 'high', wouldChangeIf: 'A check fails.' }, evidence: [], action: { type: 'promotion', promotionId, digest } };
  await assert.rejects(f.ask({ ...approval, action: { type: 'promotion', promotionId, digest: 'f'.repeat(64) } }), /This changed after you were asked/);
  f.control.decisions.binders.delete('refresh');
  await assert.rejects(f.ask({ ...approval, action: { type: 'refresh', refreshId: promotionId, digest } }), /Nothing can be bound to a refresh action yet/);
  const { decision } = await f.ask(approval);
  plan = { ...plan, steps: ['deploy', 'drop-table'] };
  const dev = await f.pairFirst();
  await assert.rejects(f.choose(decision, 'approve'), /Confirm this on your paired device/, 'v1.6: the operator cannot answer a bound approval');
  await assert.rejects(f.chooseProven(dev, decision, 'approve'), new RegExp(DIGEST_CHANGED));
  assert.equal(f.control.decisions.packet(decision.id).state, 'open', 'a refused choice changes nothing');
  plan = { ...plan, steps: ['deploy'] };
  const chosen = (await f.chooseProven(dev, decision, 'approve')).decision;
  assert.deepEqual([chosen.choice.by, chosen.choice.proven, chosen.choice.deviceId], ['human', true, dev.id]);
  // v1.5 (R-J3-4): the executor presents the exact packet: id, revision and action.
  const action = { type: 'promotion', promotionId, digest }, exact = { decisionId: decision.id, revision: chosen.revision, action };
  assert.deepEqual(await f.control.decisions.approvalFor(exact), { decisionId: decision.id, revision: chosen.revision, digest, optionId: 'approve' });
  await assert.rejects(f.control.decisions.approvalFor(action), /Present the exact packet/, 'the action alone is not authority');
  await assert.rejects(f.control.decisions.approvalFor({ ...exact, revision: chosen.revision - 1 }), /No matching approval/);
  await assert.rejects(f.control.decisions.approvalFor({ ...exact, action: { ...action, digest: 'e'.repeat(64) } }), /No matching approval/);
  // A declined approval never authorizes, and only approvals may carry an action at all.
  const declined = (await f.ask({ ...approval, title: 'Put the older version back?' })).decision;
  const no = (await f.chooseProven(dev, declined, 'reject')).decision;
  await assert.rejects(f.control.decisions.approvalFor({ decisionId: no.id, revision: no.revision, action }), /No matching approval/);
  await assert.rejects(f.ask({ ...level1(), action }), /Only an approval can be bound to an action/);
  plan = { ...plan, steps: ['deploy', 'drop-table'] };
  await assert.rejects(f.control.decisions.approvalFor(exact), new RegExp(DIGEST_CHANGED), 'a later change voids the approval');
});

test('§3.2 #5: only the asker withdraws or supersedes', async t => {
  const f = await fixture(t);
  const { decision } = await f.ask(level1());
  await assert.rejects(f.role('other', 'roles-decision-withdraw', { decisionId: decision.id, expectedRevision: 1, note: 'Not mine to withdraw' }), /Only the asker can withdraw/);
  await assert.rejects(f.ask(level1(), { supersedes: decision.id }, 'other'), /Only the asker can supersede/);
  await assert.rejects(f.role('other', 'roles-decision-status', { decisionId: decision.id }), /No decision you asked/);
  const newer = await f.ask(level1({ title: 'Where should practice copies of the shop live?' }), { supersedes: decision.id });
  const old = f.control.decisions.packet(decision.id);
  assert.equal(old.state, 'superseded'); assert.equal(old.supersededBy, newer.decision.id);
  await assert.rejects(f.role('project', 'roles-decision-withdraw', { decisionId: newer.decision.id, expectedRevision: 9, note: 'Plans changed today' }), new RegExp(STALE_REVISION));
  const w = await f.role('project', 'roles-decision-withdraw', { decisionId: newer.decision.id, expectedRevision: 1, note: 'Plans changed today' });
  assert.equal(w.decision.state, 'withdrawn');
  const history = f.store.db.prepare('SELECT action,actor FROM cc_decision_history WHERE entityId=? ORDER BY rowid').all(newer.decision.id).map(r => ({ ...r }));
  assert.deepEqual(history, [{ action: 'asked', actor: `seat:${P(1)}` }, { action: 'withdrawn', actor: `seat:${P(1)}` }]);
});

test('§3.2 #6 v1.6: an unproven app answer is the operator, never the owner; no agent lane can choose, and the actor is never input', async t => {
  const f = await fixture(t);
  const { decision } = await f.ask(level1());
  // The asker comes from the grant: a packet that names its own asker or state is refused outright.
  await assert.rejects(f.ask({ ...level1(), askedBy: { seat: 'delivery', sessionId: f.prime } }), /unknown field "askedBy"/);
  assert.equal(decision.askedBy.sessionId, f.project); assert.equal(decision.askedBy.seat, P(1));
  // A capability cannot reach the operator-gated choice, and there is no role-lane choice at all.
  await assert.rejects(f.request({ method: 'decisions-choose', capability: f.caps.project, input: { messageId: randomUUID(), id: decision.id, expectedRevision: 1, optionId: 'a', note: '', confirmDestructive: false } }), /Operator authorization required/);
  assert(!ROLE_TOOLS.some(n => /choose|answer/.test(n)));
  // The internal API refuses agent actors for a human packet, and nobody can name the owner: `human` only comes from a proof.
  for (const actor of [`seat:${P(1)}`, `session:${f.project}`, 'system:decisions']) await assert.rejects(f.control.decisions.choose({ messageId: randomUUID(), id: decision.id, expectedRevision: 1, optionId: 'a', note: '', confirmDestructive: false }, { actor }), /Only the owner can answer this/);
  await assert.rejects(f.control.decisions.choose({ messageId: randomUUID(), id: decision.id, expectedRevision: 1, optionId: 'a', note: '', confirmDestructive: false }, { actor: 'human' }), /proven by a paired device/);
  const seatPacket = (await f.ask(level1({ level: 2, askedOf: { seat: 'delivery' } }))).decision;
  await assert.rejects(f.choose(seatPacket, 'a'), /Only the seat it was asked of/);
  const done = await f.choose(decision, 'a');
  assert.deepEqual([done.decision.choice.by, done.decision.choice.proven, done.decision.choice.deviceId, done.decision.choice.via], ['operator', false, null, 'app-mac']);
});

test('§3.2 #7: chosen is terminal, a stale view is refused, and expiry never chooses', async t => {
  let clock = Date.now();
  const f = await fixture(t, { now: () => clock });
  const { decision } = await f.ask(level1());
  await assert.rejects(f.choose({ ...decision, revision: 0 }, 'a'), new RegExp(STALE_REVISION));
  const first = await f.choose(decision, 'a');
  await assert.rejects(f.choose(decision, 'b'), /Changed since you looked|Already answered/);
  await assert.rejects(f.choose(first.decision, 'b'), /^Error: Already answered by the operator at \d\d:\d\d, not confirmed on your device$/);
  await assert.rejects(f.role('project', 'roles-decision-withdraw', { decisionId: decision.id, expectedRevision: first.decision.revision, note: 'Too late now' }), /cannot be withdrawn/);
  assert.equal(f.control.decisions.packet(decision.id).choice.optionId, 'a');
  const expiring = (await f.ask(level1({ expiresAt: new Date(clock + 60000).toISOString() }))).decision;
  clock += 120000;
  await f.control.decisions.pump();
  const expired = f.control.decisions.packet(expiring.id);
  assert.equal(expired.state, 'expired'); assert.equal(expired.choice, null);
  await assert.rejects(f.choose(expired, 'a'), /expired without an answer/);
});

test('§3.2 #8: decision.chosen reaches the asker exactly once, is retried while busy, and survives a crash between send and record', async t => {
  const f = await fixture(t);
  const { decision } = await f.ask(level1());
  f.states.set(f.project, { ...f.states.get(f.project), status: 'running' });
  const messageId = randomUUID();
  const chosen = await f.op('decisions-choose', { messageId, id: decision.id, expectedRevision: 1, optionId: 'b', note: 'Go with the practice copy', confirmDestructive: false });
  await f.control.decisions.delivering;
  const deliveryId = chosenDeliveryId(decision.id, chosen.decision.revision);
  let row = f.store.db.prepare('SELECT * FROM cc_decision_deliveries WHERE id=?').get(deliveryId);
  assert.equal(row.state, 'pending'); assert.equal(row.attempts, 0, 'busy is waiting, not an attempt (v1.5)'); assert.match(row.lastError, /^Waiting: the asking session is busy/);
  assert.equal(f.sends.length, 0);
  assert.deepEqual((await f.role('project', 'roles-decision-status', { decisionId: decision.id })).decision.delivery, { state: 'pending', at: null, attempts: 0 });
  // A retried choice with the same identity returns the original and queues nothing new.
  const again = await f.op('decisions-choose', { messageId, id: decision.id, expectedRevision: 1, optionId: 'b', note: 'Go with the practice copy', confirmDestructive: false });
  assert.equal(again.resend, true); assert.equal(f.store.db.prepare('SELECT count(*) n FROM cc_decision_deliveries').get().n, 1);
  f.states.set(f.project, { ...f.states.get(f.project), status: 'idle' });
  await f.control.decisions.pump(); await f.control.decisions.pump();
  assert.equal(f.sends.length, 1, 'exactly one native send');
  assert.equal(f.sends[0].id, f.project); assert.equal(f.sends[0].messageId, deliveryId);
  assert.match(f.sends[0].text, new RegExp(`^Fulcra decision.chosen \\{"decisionId":"${decision.id}","revision":2,"optionId":"b","note":"Go with the practice copy","by":"operator","proven":false\\}`));
  row = f.store.db.prepare('SELECT * FROM cc_decision_deliveries WHERE id=?').get(deliveryId);
  assert.equal(row.state, 'delivered'); assert.equal(row.attempts, 1, 'the one real send');
  assert.equal(f.control.decisions.packet(decision.id).delivery.state, 'delivered');
  // Crash window: the native send happened but the record was lost. The controller's delivery journal
  // already holds the identity, so recovery records it delivered and sends nothing.
  f.store.db.prepare("UPDATE cc_decision_deliveries SET state='pending',deliveredAt=NULL WHERE id=?").run(deliveryId);
  await f.control.decisions.pump();
  assert.equal(f.sends.length, 1, 'no second send after a lost record');
  assert.equal(f.store.db.prepare('SELECT state FROM cc_decision_deliveries WHERE id=?').get(deliveryId).state, 'delivered');
});

test('§3.2 #9: level-1 packets refuse ids, paths, code and jargon, and need an example; levels 2–3 warn', async t => {
  const f = await fixture(t);
  await assert.rejects(f.ask(level1({ options: [option('a'), option('b', { example: null })] })), /needs an everyday example; missing for: Option B/);
  await assert.rejects(f.ask(level1({ title: `Merge ${T(1)} now?` })), /Not plain language: title contains .*an id/);
  await assert.rejects(f.ask(level1({ situation: 'The webhook failed. We need a decision.' })), /the technical term "webhook"/);
  await assert.rejects(f.ask(level1({ options: [option('a', { summary: 'Edit `src/app.ts` directly.' }), option('b')] })), /code formatting|a file path/);
  await assert.rejects(f.ask(level1({ recommendation: { optionId: 'a', why: 'Commit 3f2a9c1 already does it.', confidence: 'low', wouldChangeIf: 'Never.' } })), /recommendation.why contains a hash/);
  await assert.rejects(f.ask(level1({ situation: 'One. Two. Three. Four.' })), /more than 3 sentences/);
  await assert.rejects(f.ask(level1({ situation: 'Logs are under ~/app/logs.' })), /home or volume path/);
  const warned = await f.ask(level1({ level: 2, situation: 'The webhook failed. We need a decision.' }));
  assert.equal(warned.decision.state, 'open'); assert.match(warned.warnings.join(), /webhook/);
});

test('asks are idempotent by messageId, bounded, and refuse unknown or oversized input', async t => {
  const f = await fixture(t);
  const messageId = randomUUID();
  const a = await f.ask(level1(), { messageId }), b = await f.ask(level1(), { messageId });
  assert.equal(b.resend, true); assert.equal(b.decision.id, a.decision.id);
  await assert.rejects(f.ask(level1({ title: 'Something else entirely?' }), { messageId }), /Message identity already used/);
  await assert.rejects(f.ask(level1({ token: 'x' })), /unknown field "token"/);
  await assert.rejects(f.ask(level1({ title: 'x'.repeat(121) })), /title must be text of 1–120/);
  assert.deepEqual(grantLane('roles-decision-ask'), ['role', 'ORCA_ROLE_FILE']);
});

test('held messages: listed as metadata only, body on open, then read, reply and release through the existing seat paths', async t => {
  const f = await fixture(t);
  closeSeatingDefaults(f.control);
  const channel = await f.op('channels-open', { primeSeat: 'delivery', projectSeat: P(1), purpose: 'Weekly delivery check-in between the board seat and this project', maxMessages: 6,
    expiresAt: new Date(Date.now() + 86400000).toISOString(), expectedPrimeRevision: 1, expectedProjectRevision: 1 });
  f.control.takeover(f.prime, 'The human-facing lead holds this seat');
  await f.op('seat-hold', { role: 'prime', seat: 'delivery', expectedRevision: 1, expectedSessionGeneration: f.store.get(f.prime).generation, note: 'Held by the human-facing lead by design' });
  const messageId = randomUUID(), body = 'Project report: blocked on the release plan\nPrivate detail stays in the card';
  assert.equal((await f.role('project', 'channels-send', { channelId: channel.channelId, messageId, text: body })).state, 'held');
  let inbox = await f.op('decisions-inbox', null);
  const item = inbox.items.find(i => i.source === 'held');
  assert.equal(item.key, `held-${channel.channelId}-${messageId}`); assert.equal(item.title, 'Project report: blocked on the release plan'); assert.equal(item.ref, `project:${P(1)}`);
  assert.equal(item.unread, true); assert.equal(item.urgency, 'today');
  assert(!JSON.stringify(inbox).includes(body), 'the list never carries the body');
  const open = await f.op('decisions-held-message', { channelId: channel.channelId, messageId });
  assert.equal(open.untrustedText, body); assert.equal(open.canReply, true); assert.equal(open.canRelease, true);
  await f.op('seat-receipt', { channelId: channel.channelId, messageId, note: 'Read in Fulcra Inbox' });
  inbox = await f.op('decisions-inbox', null);
  assert.equal(inbox.items.find(i => i.source === 'held').unread, false);
  const reply = await f.op('seat-reply', { channelId: channel.channelId, messageId: randomUUID(), inReplyTo: messageId, text: 'Ship it behind the flag',
    expectedSeatRevision: open.pins.seatRevision, expectedHolderGeneration: open.pins.holderGeneration });
  assert.equal(reply.state, 'delivered');
  inbox = await f.op('decisions-inbox', null);
  assert.equal(inbox.items.filter(i => i.source === 'held').length, 0, 'an answered message leaves the list');
  await f.op('seat-unhold', { role: 'prime', seat: 'delivery', expectedRevision: open.pins.seatRevision, note: 'Released from the Fulcra inbox' });
  assert.equal((await f.op('decisions-held-message', { channelId: channel.channelId, messageId })).canRelease, false);
});

test('R-J3-9: a held message is answerable and releasable only under the hold it was held under (seat and holder session)', async t => {
  const f = await fixture(t);
  closeSeatingDefaults(f.control);
  const channel = await f.op('channels-open', { primeSeat: 'delivery', projectSeat: P(1), purpose: 'Weekly delivery check-in between the board seat and this project', maxMessages: 6,
    expiresAt: new Date(Date.now() + 86400000).toISOString(), expectedPrimeRevision: 1, expectedProjectRevision: 1 });
  f.control.takeover(f.prime, 'The human-facing lead holds this seat');
  await f.op('seat-hold', { role: 'prime', seat: 'delivery', expectedRevision: 1, expectedSessionGeneration: f.store.get(f.prime).generation, note: 'Held by the human-facing lead by design' });
  const messageId = randomUUID();
  await f.role('project', 'channels-send', { channelId: channel.channelId, messageId, text: 'Status for the first holder' });
  assert.equal((await f.op('decisions-held-message', { channelId: channel.channelId, messageId })).canRelease, true);
  // The seat moves to a new human-held session and is held again at the new revision.
  const next = f.enrol(PROGRAMME);
  await f.control.bindings.assign({ role: 'prime', seat: 'delivery', sessionId: next, expectedSessionGeneration: 1, expectedRevision: 1, note: 'A new lead takes the prime seat' });
  await f.op('seat-hold', { role: 'prime', seat: 'delivery', expectedRevision: 2, expectedSessionGeneration: f.store.get(next).generation, note: 'Held by the new human-facing lead' });
  const old = await f.op('decisions-held-message', { channelId: channel.channelId, messageId });
  assert.deepEqual([old.canRelease, old.canReply, old.pins], [false, false, null], 'the later hold is not this message\'s hold');
  assert.match(old.note, /another project lead/);
});

test('daily digest: composed at the local slot from decisions, held counts and briefs; says so when no brief exists', async t => {
  const at8 = new Date(); at8.setHours(8, 0, 0, 0);
  let clock = at8.getTime() - 60000;
  const f = await fixture(t, { now: () => clock });
  const { decision } = await f.ask(level1());
  const second = (await f.ask(level1({ title: 'Should the shop open on Sundays?' }))).decision;
  await f.choose(second, 'b');
  assert.deepEqual(await f.control.decisions.composeDue(), [], 'nothing before 08:00');
  clock = at8.getTime() + 60000;
  const made = await f.control.decisions.composeDue();
  assert.equal(made.length, 2, 'the Orca project and All work');
  assert.deepEqual(await f.control.decisions.composeDue(), [], 'once per slot');
  const project = f.store.db.prepare('SELECT * FROM cc_digests WHERE projectId=?').get(P(1));
  const d = JSON.parse(project.json);
  assert.equal(d.noUpdate, NO_UPDATE); assert.equal(d.brief, null);
  assert.deepEqual([d.decisions.openCount, d.decisions.chosenCount], [1, 1]);
  assert.equal(d.decisions.open[0].id, decision.id); assert.equal(d.decisions.chosen[0].optionTitle, 'Option B');
  assert.equal(d.summary, 'No project update was written today. 1 decision waiting for you, 1 question answered by the operator, not confirmed on your device.');
  assert.equal(project.periodEnd, at8.toISOString());
  const inbox = await f.op('decisions-inbox', null);
  const item = inbox.items.find(i => i.key === `digest-${project.id}`);
  assert.equal(item.title, 'Daily digest · Orca'); assert.equal(item.urgency, 'fyi');
  assert.equal((await f.op('decisions-digest', { id: project.id })).digest.projectName, 'Orca');
  // A brief written in the period becomes the headline (J-ORG's table; created here as that job will).
  f.store.db.exec('CREATE TABLE cc_project_briefs(projectId TEXT NOT NULL,revision INTEGER NOT NULL,json TEXT NOT NULL,writtenAt TEXT NOT NULL,author TEXT NOT NULL,PRIMARY KEY(projectId,revision))');
  const written = new Date(at8.getTime() + 3600000).toISOString();
  f.store.db.prepare('INSERT INTO cc_project_briefs VALUES (?,?,?,?,?)').run(P(1), 1, JSON.stringify({ headline: 'The practice copy is live', health: 'on-track', shipped: [{ text: 'Practice copy', ref: null }] }), written, 'seat:x');
  const tomorrow = await f.control.decisions.composeDigest({ projectId: P(1), projectName: 'Orca', periodStart: at8.toISOString(), periodEnd: new Date(at8.getTime() + 86400000).toISOString(), composedAt: written, directoryAvailable: true });
  assert.equal(tomorrow.brief.headline, 'The practice copy is live'); assert.equal(tomorrow.noUpdate, null); assert.deepEqual(tomorrow.shipped, [{ text: 'Practice copy', ref: null }]);
});

test('inbox urgency and counts follow §3.4', async t => {
  const f = await fixture(t);
  await f.ask(level1());
  await f.ask(level1({ level: 2, title: 'Pick a colour for the new sign?' }));
  const inbox = await f.op('decisions-inbox', null);
  assert.deepEqual(inbox.items.map(i => [i.title, i.urgency]), [['Where should practice copies of the website live?', 'now'], ['Pick a colour for the new sign?', 'today']]);
  assert.deepEqual(inbox.counts, { now: 1, today: 1, fyi: 0, decisions: 2, approvals: 0, held: 0, digests: 0, total: 2 });
  assert.equal(inbox.version, 1); assert.equal(inbox.partial, false);
});

test('v1.2: decision-choose records the app platform it is given, app-mac when missing, and refuses a channel or unknown value', async t => {
  const f = await fixture(t);
  const ask = async title => (await f.ask(level1({ title }))).decision;
  const [a, b, c] = [await ask('Open the shop on Sundays?'), await ask('Hire a second designer?'), await ask('Move the launch a week?')];
  assert.equal((await f.choose(a, 'a', { via: 'app-ios' })).decision.choice.via, 'app-ios');
  assert.equal((await f.choose(b, 'a')).decision.choice.via, 'app-mac');
  for (const via of ['discord-openclaw', 'session', 'cli', 'app-fridge']) await assert.rejects(f.choose(c, 'a', { via }), /Invalid choice platform/);
  assert.equal(f.control.decisions.packet(c.id).state, 'open');
  await assert.rejects(f.choose(a, 'b', { via: 'app-web' }), /^Error: Already answered by the operator at \d\d:\d\d, not confirmed on your device$/);
});

test('v1.2: an environment-change approval is bound through its own binder and digest-checked at ask and choice', async t => {
  const f = await fixture(t);
  const environmentId = randomUUID();
  let definition = { steps: { deploy: { script: 'deploy.sh' } }, requirements: [] };
  const approval = digest => ({ kind: 'approval', level: 2, projectId: P(1), taskId: null, askedOf: 'human', title: 'Change how the test copy is set up?', situation: 'The setup steps for the test copy changed. Nothing runs until you approve.',
    options: [option('approve'), option('reject')], recommendation: null, evidence: [], action: { type: 'environment-change', environmentId, digest } });
  const digest = () => sha(canonicalJson(definition));
  await assert.rejects(f.ask(approval(digest())), /Nothing can be bound to a environment-change action yet/);
  f.control.decisions.binders.set('environment-change', async id => id === environmentId ? definition : null);
  await assert.rejects(f.ask(approval('0'.repeat(64))), /This changed after you were asked/);
  const { decision } = await f.ask(approval(digest()));
  const before = digest();
  definition = { ...definition, steps: { deploy: { script: 'deploy-v2.sh' } } };
  const dev = await f.pairFirst();
  await assert.rejects(f.chooseProven(dev, decision, 'approve'), new RegExp(DIGEST_CHANGED));
  definition = { steps: { deploy: { script: 'deploy.sh' } }, requirements: [] };
  assert.equal(digest(), before);
  await f.chooseProven(dev, decision, 'approve');
  const done = (await f.control.decisions.packet(decision.id));
  assert.equal((await f.control.decisions.approvalFor({ decisionId: decision.id, revision: done.revision, action: { type: 'environment-change', environmentId, digest: before } })).decisionId, decision.id);
});

test('R-J3-1 (§3.2 #8 v1.5): waiting is not failing — takeover, choose, 60 pumps, handback, pump: exactly one send', async t => {
  const f = await fixture(t);
  const { decision } = await f.ask(level1());
  f.control.takeover(f.project, 'The operator talks to this session directly');
  const chosen = await f.choose(decision, 'a'); await f.control.decisions.delivering;
  for (let i = 0; i < 60; i++) await f.control.decisions.pump();
  const id = chosenDeliveryId(decision.id, chosen.decision.revision);
  let row = f.store.db.prepare('SELECT * FROM cc_decision_deliveries WHERE id=?').get(id);
  assert.deepEqual([row.state, row.attempts], ['pending', 0], 'waiting is not an attempt and never fails');
  assert.match(row.lastError, /^Waiting: the asking session is under human control/);
  assert.equal(f.sends.length, 0);
  await f.control.handback(f.project, 'Handing the session back to its seat');
  await f.control.decisions.pump(); await f.control.decisions.pump();
  assert.equal(f.sends.length, 1, 'exactly one send after handback');
  assert.equal(f.sends[0].id, f.project); assert.equal(f.sends[0].messageId, id);
  row = f.store.db.prepare('SELECT * FROM cc_decision_deliveries WHERE id=?').get(id);
  assert.deepEqual([row.state, row.attempts], ['delivered', 1]);
  assert.deepEqual(f.control.decisions.packet(decision.id).delivery.state, 'delivered');
});

test('R-J3-8 (§3.2 #8 v1.5): after a seat refresh the answer goes to the seat\'s current holder, once', async t => {
  const f = await fixture(t);
  const { decision } = await f.ask(level1());
  const fresh = f.enrol(T(1));
  await f.control.bindings.assign({ role: 'project-orchestrator', seat: P(1), sessionId: fresh, expectedSessionGeneration: 1, expectedRevision: 1, note: 'A refreshed orchestrator takes the seat' });
  await f.control.handback(fresh, 'Delegated for the refreshed seat');
  const chosen = await f.choose(decision, 'b'); await f.control.decisions.delivering;
  await f.control.decisions.pump();
  assert.deepEqual(f.sends.map(s => s.id), [fresh], 'delivered to the new holder only');
  const row = f.store.db.prepare('SELECT session,state FROM cc_decision_deliveries WHERE id=?').get(chosenDeliveryId(decision.id, chosen.decision.revision));
  assert.deepEqual({ ...row }, { session: fresh, state: 'delivered' });
});

test('R-J3-2 (§3.2 #8 v1.5): the pump is throttled and single-flight, reads the directory only when a slot is due, and remembers quiet projects', async t => {
  const at8 = new Date(); at8.setHours(8, 0, 0, 0);
  let clock = at8.getTime() - 30000;
  const f = await fixture(t, { now: () => clock });
  // The production defaults, on the same journal: at most one pass per 5 s and one compose per minute.
  let reads = 0;
  const d = new Decisions(f.control, { now: () => clock, readProjects: async () => { reads++; return f.directory; } });
  await d.pump(); await d.pump();
  assert.equal(reads, 0, 'before 08:00 nothing is due, so no directory read at all');
  clock = at8.getTime() + 10000;
  await d.pump();
  assert.equal(reads, 0, 'throttled: the minute since the last compose has not passed');
  clock = at8.getTime() + 31000;
  const [a, b] = [d.pump(), d.pump()];
  assert.equal(a, b, 'single-flight'); await a;
  assert.equal(reads, 1);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM cc_digests WHERE projectId IS NULL').get().n, 1, 'All work is written');
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM cc_digests WHERE projectId IS NOT NULL').get().n, 0, 'the quiet project is not');
  for (let i = 0; i < 5; i++) { clock += 61000; await d.pump(); }
  assert.equal(reads, 1, 'settled: the quiet project and All work are not recomposed, and no directory is read');
  // The controller starts the pump and never awaits it inside the event-refresh chain.
  const server = fs.readFileSync(new URL('./server.mjs', import.meta.url), 'utf8');
  assert.match(server, /void control\.decisions\.pump\(\)/); assert.doesNotMatch(server, /await control\.decisions\.pump\(\)/);
});

test('R-J3-7 (§1 Capacity v1.5): digests rotate to the newest DIGESTS_KEPT per target and never refuse', async t => {
  const at8 = new Date(); at8.setHours(8, 0, 0, 0);
  const f = await fixture(t, { now: () => at8.getTime() + 60000 });
  const insert = f.store.db.prepare('INSERT INTO cc_digests VALUES (?,?,?,?,?)');
  for (let i = 1; i <= DIGESTS_KEPT + 10; i++) insert.run(randomUUID(), null, new Date(at8.getTime() - (i + 1) * 86400000).toISOString(), new Date(at8.getTime() - i * 86400000).toISOString(), '{}');
  const [made] = await f.control.decisions.composeDue();
  const kept = f.store.db.prepare('SELECT id,periodEnd FROM cc_digests WHERE projectId IS NULL ORDER BY periodEnd DESC').all();
  assert.equal(kept.length, DIGESTS_KEPT); assert.equal(kept[0].id, made);
  assert.equal(kept.at(-1).periodEnd, new Date(at8.getTime() - (DIGESTS_KEPT - 1) * 86400000).toISOString(), 'the oldest rows went, in the same write');
});

test('R2-2 (v1.8): waiting deliveries never starve a deliverable one — 33 waiting + 1 deliverable → 1 send', async t => {
  const f = await fixture(t);
  const waiting = [];
  for (let i = 0; i < 33; i++) waiting.push((await f.ask(level1({ title: `Pick a colour for sign ${String.fromCharCode(65 + (i % 26))}${i}?` }))).decision);
  const deliverable = (await f.ask(level1({ title: 'Open the shop on Sundays?' }), {}, 'other')).decision;
  f.control.takeover(f.project, 'The owner talks to this session directly');
  for (const d of waiting) { await f.choose(d, 'a'); await f.control.decisions.delivering; }
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM cc_decision_deliveries WHERE state='pending'").get().n, 33);
  await f.choose(deliverable, 'a'); await f.control.decisions.delivering;
  await f.control.decisions.pump();
  assert.deepEqual(f.sends.map(s => s.id), [f.other], 'exactly the deliverable answer was sent');
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM cc_decision_deliveries WHERE state='pending' AND attempts=0").get().n, 33, 'the waiting rows spent no attempt');
});

test('R2-2 (v1.8): an archived asker is a definite outcome, not a wait', async t => {
  const f = await fixture(t);
  const d = (await f.ask(level1())).decision;
  f.control.takeover(f.project, 'The owner talks to this session directly');
  f.states.set(f.project, { ...f.states.get(f.project), archivedAt: new Date().toISOString() });
  const chosen = await f.choose(d, 'a'); await f.control.decisions.delivering;
  const row = f.store.db.prepare('SELECT state,lastError FROM cc_decision_deliveries WHERE id=?').get(chosenDeliveryId(d.id, chosen.decision.revision));
  assert.equal(row.state, 'failed'); assert.match(row.lastError, /archived/);
});

test('v1.15 §3.3 askSystem: a component asks with no asking session; no session can withdraw, supersede or read it, and its choice is consumed, not delivered', async t => {
  const f = await fixture(t);
  const d = f.control.decisions;
  const messageId = randomUUID(), packet = level1({ title: 'Refresh the delivery lead now?' });
  const asked = (await d.askSystem({ component: 'refresh', messageId, packet }, { seat: 'delivery' })).decision;
  assert.deepEqual(asked.askedBy, { seat: 'delivery', sessionId: null, system: 'refresh' });
  // The same message replays; another packet under it is refused.
  assert.equal((await d.askSystem({ component: 'refresh', messageId, packet }, { seat: 'delivery' })).resend, true);
  await assert.rejects(d.askSystem({ component: 'refresh', messageId, packet: level1({ title: 'Something else entirely?' }) }, { seat: 'delivery' }), /Message identity already used/);
  await assert.rejects(d.askSystem({ component: 'promotion', messageId, packet }), /Message identity already used/);
  for (const bad of [{ component: 'Refresh', messageId: randomUUID(), packet }, { component: 'refresh', messageId: 'x', packet }, { component: 'refresh', messageId: randomUUID(), packet, sessionId: f.prime }]) await assert.rejects(d.askSystem(bad), /Invalid system ask/);
  // The session holding the seat it names is still not its asker: it cannot withdraw it, supersede it or read its status.
  await assert.rejects(f.role('prime', 'roles-decision-withdraw', { decisionId: asked.id, expectedRevision: 1, note: 'I would rather not be refreshed' }), /Only the asker can withdraw/);
  await assert.rejects(f.ask(level1({ title: 'Do not refresh me?' }), { supersedes: asked.id }, 'prime'), /Only the asker can supersede/);
  await assert.rejects(f.role('prime', 'roles-decision-status', { decisionId: asked.id }), /No decision you asked has that id/);
  // No request can ask as a component.
  await assert.rejects(f.op('decisions-ask-system', { component: 'refresh', messageId: randomUUID(), packet }), /./);
  // Answered: no delivery row, nothing sent to any session; the component reads the choice.
  const sendsBefore = f.sends.length;
  const chosen = (await f.choose(asked, 'a')).decision;
  assert.equal(chosen.delivery, null);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM cc_decision_deliveries WHERE decisionId=?').get(asked.id).n, 0);
  await d.pump(); await d.delivering;
  assert.equal(f.sends.length, sendsBefore, 'no session is told');
  assert.equal(d.systemChoice({ component: 'refresh', decisionId: asked.id }).decision.choice.optionId, 'a');
  assert.throws(() => d.systemChoice({ component: 'promotion', decisionId: asked.id }), /No decision this component asked/);
});
