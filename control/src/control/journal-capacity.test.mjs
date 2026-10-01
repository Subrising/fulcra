import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ControlStore } from './store.mjs';
import { JOURNAL_CAPACITY, MANUAL_RESERVE, AUTOMATION_LIMIT } from './journal-capacity.mjs';
import { QUOTA_JOURNAL_CAPACITY } from './quota-wait.mjs';
function journal(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orca-journal-'))), store = new ControlStore(path.join(dir, 'journal.sqlite'));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const fill = n => { store.db.exec('BEGIN'); while (store.db.prepare('SELECT count(*) n FROM deliveries').get().n < n) store.db.prepare("INSERT INTO deliveries VALUES (?,NULL,'fixture','{}','delivered',NULL)").run(randomUUID()); store.db.exec('COMMIT'); };
  return { store, fill };
}
test('the journal admits deliveries past the old 1000-row cap (G2/G3)', t => {
  const { store, fill } = journal(t); fill(1000);
  store.admit(randomUUID(), null, 'send', { text: 'past the old cap' });
  assert.equal(store.db.prepare('SELECT count(*) n FROM deliveries').get().n, 1001);
});
test('the journal still refuses at its capacity, and automation always leaves the manual reserve', t => {
  const { store, fill } = journal(t); fill(JOURNAL_CAPACITY);
  assert.throws(() => store.admit(randomUUID(), null, 'send', { text: 'over capacity' }), /Journal capacity reached/);
  assert.ok(MANUAL_RESERVE >= 1000 && AUTOMATION_LIMIT === JOURNAL_CAPACITY - MANUAL_RESERVE && AUTOMATION_LIMIT > 582);
});
test('the staged quota-wait copy of the journal capacity equals the controller\u2019s', () => {
  assert.equal(QUOTA_JOURNAL_CAPACITY, JOURNAL_CAPACITY);
});
