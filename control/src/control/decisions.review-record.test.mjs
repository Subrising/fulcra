// G4 (PILLAR 7, the prime's one approved controller change): the owner's decision on a pull request in the review screen is
// recorded as a record-only Inbox item through the operator lane. Exactly one item per (workspace, PR, head, choice,
// note); a retry makes none; strict validation; shown in the Inbox and the digest; no authority, no delivery.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, OP } from './decisions.fixture.mjs';
import { requireUnpinnedAdmissionGuard } from './admission-guard-precondition.mjs';
requireUnpinnedAdmissionGuard();

const HEAD = 'a'.repeat(40);
const review = (extra = {}) => ({ workspace: '/work/checkout-app', repo: 'acme/checkout', number: 42, headSha: HEAD, choice: 'request_changes', note: 'Please add a test for the retry.', ...extra });
const count = (f, table) => Number(f.control.store.db.prepare(`SELECT count(*) n FROM ${table}`).get().n);

test('records exactly one answered, record-only item, and a retry records none', async t => {
  const f = await fixture(t);
  const before = count(f, 'cc_decisions'), deliveries = count(f, 'cc_decision_deliveries');
  const r = await f.op('decisions-record-review', review());
  assert.equal(count(f, 'cc_decisions'), before + 1);
  assert.equal(r.resend, false);
  const d = r.decision;
  assert.deepEqual([d.kind, d.askedOf, d.state, d.action.type, d.askedBy.system, d.choice.optionId, d.choice.by, d.choice.proven, d.delivery], ['question', 'human', 'chosen', 'none', 'review', 'request-changes', 'operator', false, null]);
  assert.equal(d.title, 'You reviewed PR #42: Request changes — Please add a test for the retry.');
  assert.match(d.situation, /Pull request #42 in acme\/checkout, at commit aaaaaaa\. Recorded from the review screen; nothing was sent anywhere\./);
  assert.doesNotMatch(JSON.stringify(d), /\/work\/checkout-app/, 'the workspace is only hashed into the identity');
  const again = await f.op('decisions-record-review', review());
  assert.equal(again.resend, true); assert.equal(again.decision.id, d.id); assert.equal(count(f, 'cc_decisions'), before + 1, 'a retry makes no second item');
  await f.op('decisions-record-review', review({ note: 'Looks fine now.', choice: 'approve' }));
  assert.equal(count(f, 'cc_decisions'), before + 2, 'a different decision is a new item');
  await f.op('decisions-record-review', review({ headSha: 'b'.repeat(40) }));
  assert.equal(count(f, 'cc_decisions'), before + 3, 'the same decision on a new head commit is a new item');
  assert.equal(count(f, 'cc_decision_deliveries'), deliveries, 'nothing is delivered to any session');
});

test('the Inbox and the digest show it as "You reviewed PR #N: <choice> — <note>"', async t => {
  const f = await fixture(t);
  const { decision } = await f.op('decisions-record-review', review({ choice: 'comment', note: '' }));
  const inbox = await f.op('decisions-inbox', null);
  const row = inbox.items.find(i => i.ref === `decision:${decision.id}`);
  assert.equal(row.title, 'You reviewed PR #42: Comment'); assert.equal(row.urgency, 'fyi'); assert.equal(row.unread, false);
  const digest = f.control.decisions.composeDigest({ projectId: null, projectName: 'All work', periodStart: new Date(Date.now() - 3600000).toISOString(), periodEnd: new Date(Date.now() + 1000).toISOString(), composedAt: new Date().toISOString(), directoryAvailable: true });
  assert.deepEqual(digest.decisions.chosen.map(c => [c.title, c.optionTitle, c.by]), [['You reviewed PR #42: Comment', 'Comment', 'operator']]);
  assert.match(digest.summary, /1 question answered by the operator/);
});

test('strict validation: unknown choices, oversized notes, bad refs and extra fields are refused; nothing is recorded', async t => {
  const f = await fixture(t);
  const before = count(f, 'cc_decisions');
  for (const [bad, message] of [
    [review({ choice: 'merge' }), /Invalid controller command input|Invalid review choice/],
    [review({ note: 'x'.repeat(501) }), /Invalid controller command input|Invalid review note/],
    [review({ repo: 'not a repo' }), /Invalid review repository/],
    [review({ repo: '../etc' }), /Invalid review repository/],
    [review({ number: 0 }), /Invalid controller command input|Invalid pull request number/],
    [review({ headSha: 'abc123' }), /Invalid controller command input|Invalid head commit/],
    [review({ postToGithub: true }), /Invalid controller command input|Invalid review record/],
    [review({ via: 'discord-openclaw' }), /Invalid controller command input|Invalid review platform/],
    [review({ projectId: 'not-an-id' }), /Invalid controller command input|Invalid review project/],
    [{ ...review(), workspace: '' }, /Invalid controller command input|Invalid review workspace/],
  ]) await assert.rejects(f.op('decisions-record-review', bad), message, JSON.stringify(bad).slice(0, 80));
  assert.equal(count(f, 'cc_decisions'), before);
  // The controller method itself refuses the same, whatever reaches it.
  assert.throws(() => f.control.decisions.recordReview(review({ choice: 'merge' })), /Invalid review choice/);
  assert.throws(() => f.control.decisions.recordReview(review({ note: 'x'.repeat(501) })), /Invalid review note/);
});

test('operator lane only: no operator credential, a wrong one, or a session capability cannot record', async t => {
  const f = await fixture(t);
  const { rpc } = await import('./rpc.mjs');
  const request = rpc(f.control, OP);
  await assert.rejects(request({ method: 'decisions-record-review', input: review() }));
  await assert.rejects(request({ method: 'decisions-record-review', operator: 'someone-else', input: review() }));
  await assert.rejects(request({ method: 'decisions-record-review', capability: 'not-a-capability', input: review() }));
  assert.equal(Number(f.control.store.db.prepare("SELECT count(*) n FROM cc_decisions WHERE askedBySession='system:review'").get().n), 0);
});
