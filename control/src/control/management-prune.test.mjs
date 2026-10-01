// L40: prepareManagement refused every request once management_requests held 128 (scoped) / 1000 rows, and rows left
// only on an explicit sender acknowledgement. At the cap the controller now prunes exactly what an acknowledgement would
// accept once it can no longer serve a retry; inside the retry window a same-request retry still resolves to its id.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Controller, MANAGEMENT_RETRY_WINDOW_MS } from './controller.mjs';
import { ControlStore } from './store.mjs';

const HOUR = 60 * 60 * 1000;
function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orca-prune-'))), store = new ControlStore(path.join(dir, 'journal.sqlite'));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const clock = { at: Date.parse('2026-09-29T12:00:00Z') };
  const control = new Controller({ store, native: {}, authority: async () => ({ id: 'task' }), now: () => clock.at });
  const session = randomUUID(); store.created(session, randomUUID(), dir);
  const generation = () => store.get(session).generation;
  const db = store.db, count = () => db.prepare('SELECT COUNT(*) n FROM management_requests').get().n;
  // A prepared send through the real path, optionally with its delivery at a state (as the send path records it).
  const prepare = (text, state, id = randomUUID()) => {
    const got = control.prepareManagement('send', { sessionId: session, expectedGeneration: generation(), text }, id, true);
    if (state) db.prepare('INSERT OR REPLACE INTO deliveries VALUES (?,?,?,?,?,?)').run(got, session, 'send', JSON.stringify({ sessionId: session, text }), state, '{}');
    return got;
  };
  const fill = (state, n = 128) => { for (let i = 0; i < n; i++) prepare(`fill ${state} ${i} ${randomUUID()}`, state); };
  return { store, control, clock, session, db, count, prepare, fill, generation };
}

test('full of finished requests from more than a day ago: a new send succeeds, and the finished ones are gone', async t => {
  const f = fixture(t);
  f.fill('delivered', 64); f.fill('refused', 32); f.fill('abandoned', 32);
  assert.equal(f.count(), 128);
  assert.throws(() => f.prepare('one more', null), /capacity reached/, 'inside the window nothing is pruned');
  f.clock.at += MANAGEMENT_RETRY_WINDOW_MS + 1;
  const id = f.prepare('one more', null);
  assert.equal(f.count(), 1, 'every finished request was pruned; only the new one remains');
  assert.equal(f.db.prepare('SELECT id FROM management_requests').get().id, id);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM management_request_times').get().n, 1, 'their times went with them');
});

test('inside the window a same-request retry is still deduplicated to its first id, even at the cap', async t => {
  const f = fixture(t);
  const first = f.prepare('the instruction', 'delivered');
  f.fill('delivered', 127);
  assert.equal(f.count(), 128);
  f.clock.at += 23 * HOUR;
  assert.equal(f.prepare('the instruction', null, randomUUID()), first, 'the retry resolves to the prior id, not a second request');
  assert.equal(f.count(), 128);
});

test('requests that have not finished are never pruned, however old', async t => {
  const f = fixture(t);
  f.fill(null, 64); f.fill('intent', 32); f.fill('uncertain', 32);
  f.clock.at += 30 * 24 * HOUR;
  assert.throws(() => f.prepare('one more', null), /capacity reached/);
  assert.equal(f.count(), 128);
});

test('a session that moved to a later generation frees its finished and its unadmitted sends at once', async t => {
  const f = fixture(t);
  f.fill('delivered', 64); f.fill(null, 64);
  f.db.prepare('UPDATE sessions SET generation=generation+1 WHERE id=?').run(f.session);   // as a handback / takeover does
  const id = f.prepare('for the new generation', null);
  assert.equal(f.count(), 1); assert.equal(f.db.prepare('SELECT id FROM management_requests').get().id, id);
});

test('requests prepared before this build (no recorded time) are pruned once finished; unfinished ones stay', async t => {
  const f = fixture(t);
  f.fill('delivered', 100); f.fill(null, 28);
  f.db.exec('DELETE FROM management_request_times');
  f.prepare('after the upgrade', null);
  assert.equal(f.count(), 29, '100 finished pre-upgrade requests pruned; 28 unfinished and the new one kept');
});

test('an explicit acknowledgement also forgets the recorded time', async t => {
  const f = fixture(t);
  const id = f.prepare('acknowledged', 'delivered');
  assert.deepEqual(f.control.acknowledgeManagement(id), { acknowledged: true });
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM management_request_times WHERE id=?').get(id).n, 0);
});
