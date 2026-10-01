// L37 (DESIGN-NEXT-BUILD B3): the Inbox showed only "Management unavailable" because any throw inside Decisions.inbox()
// after dispatch is reported to the app as code 'unavailable' with the message dropped. One unreadable row must not blank
// the whole inbox: each section and row is isolated, counted, logged (class + location only), and the result is partial.
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, level1 } from './decisions.fixture.mjs';
import { describeFailure } from './management-refusal.mjs';
import { requireUnpinnedAdmissionGuard } from './admission-guard-precondition.mjs';
requireUnpinnedAdmissionGuard();

const iso = () => new Date().toISOString();
const quiet = (t, d) => { const logged = []; d.logUnreadable = (section, e) => logged.push([section, describeFailure(e)]); return logged; };

test('a malformed decision row drops out; the rest of the inbox is served, marked partial', async t => {
  const f = await fixture(t), logged = quiet(t, f.control.decisions);
  await f.ask(level1());
  f.control.store.db.prepare("INSERT INTO cc_decisions(id,state,projectId,askedOf,level,createdAt,updatedAt,revision,askedBySession,askMessageId,json) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(randomUUID(), 'open', null, 'human', 1, iso(), iso(), 1, randomUUID(), randomUUID(), '{"SECRET-ROW-TEXT": ');
  const inbox = await f.op('decisions-inbox', null);
  assert.deepEqual(inbox.items.map(i => i.title), ['Where should practice copies of the website live?']);
  assert.equal(inbox.partial, true); assert.deepEqual(inbox.unreadable, { decisions: 1 });
  assert.equal(logged.length, 1); assert.equal(logged[0][0], 'decisions');
  assert.doesNotMatch(logged[0][1], /SECRET-ROW-TEXT/, 'the log line never quotes the row');
});

test('a digest missing its summary drops out instead of throwing; a failing section is isolated too', async t => {
  const f = await fixture(t); quiet(t, f.control.decisions);
  await f.ask(level1());
  f.control.store.db.prepare('INSERT INTO cc_digests(id,projectId,periodStart,periodEnd,json) VALUES (?,?,?,?,?)')
    .run(randomUUID(), null, iso(), iso(), JSON.stringify({ projectName: 'Delivery', composedAt: iso() }));
  f.control.decisions.attention = () => { throw TypeError('attention exploded'); };
  const inbox = await f.op('decisions-inbox', null);
  assert.equal(inbox.items.length, 1); assert.equal(inbox.items[0].source, 'decision');
  assert.equal(inbox.partial, true); assert.deepEqual(inbox.unreadable, { digests: 1, attention: 1 });
  assert.equal(inbox.counts.total, 1);
});

test('a clean inbox is exactly as before: not partial, no unreadable key', async t => {
  const f = await fixture(t); quiet(t, f.control.decisions);
  await f.ask(level1());
  const inbox = await f.op('decisions-inbox', null);
  assert.equal(inbox.partial, false); assert.equal(Object.hasOwn(inbox, 'unreadable'), false);
});

test('describeFailure gives the class and a source location, never the message', () => {
  let e; try { JSON.parse('{"private": "journal text'); } catch (x) { e = x; }
  const d = describeFailure(e);
  assert.match(d, /^SyntaxError at /); assert.doesNotMatch(d, /private|journal text/);
  assert.equal(describeFailure({ name: 'x y\nz', stack: 'nothing' }), 'Error at unknown location');
});
