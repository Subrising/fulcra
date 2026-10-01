// H7 item 4 (G18): the seat sweep re-establishes a seat's TEAM with it, under the seat's own gate.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { FENCE_PROTOCOL } from './native-fence.mjs';
import { ControlStore } from './store.mjs';
import { reestablishable, REESTABLISH, DECLINE, REVOKE, OPERATOR, SWEEP } from './boot-reestablishment.mjs';
import { sweepCandidates, ownedBySeat } from './seat-sweep.mjs';
import { Bindings } from './bindings.mjs';
import { Events } from './events.mjs';
import { Manager } from './manager.mjs';
import { RoleSessions } from './role-sessions.mjs';
import { Controller } from './controller.mjs';

const T = n => `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`;

test('R7 admits a seat’s team member (owned) exactly as a seat; every other clause is unchanged', () => {
  const row = { mode: 'delegated', boot: 'b1', expected: 'm-42', expectedAt: '2026-09-23T10:00:00.000Z', authority: 'key', generation: 7 };
  const good = { boot: 'b2', fenceProtocol: FENCE_PROTOCOL, saturated: false, humanAt: 0, status: 'idle', pending: 0, lastPromptId: 'm-42', lastUserAt: '2026-09-23T10:00:00.000Z', archivedAt: null };
  const team = { seated: false, owned: true, authorityKey: 'key', dispatchSupported: true, trigger: SWEEP, humanLog: { state: 'clean' } };
  assert.deepEqual(reestablishable(row, good, team), { allow: true, disposition: REESTABLISH, reason: null, grantedAt: 1 });
  assert.equal(reestablishable(row, good, { ...team, owned: false }).disposition, DECLINE);
  assert.match(reestablishable(row, good, { ...team, owned: false }).reason, /belongs to no seat’s team/);
  // The sweep still needs a complete clean human-input log, and still revokes on a human prompt or a dirty log.
  assert.equal(reestablishable(row, good, { ...team, humanLog: { state: 'unavailable', reason: 'x' } }).disposition, DECLINE);
  assert.equal(reestablishable(row, good, { ...team, humanLog: { state: 'dirty', reason: 'typed' } }).disposition, REVOKE);
  assert.equal(reestablishable(row, { ...good, lastPromptId: 'other' }, team).disposition, REVOKE);
  assert.equal(reestablishable(row, { ...good, humanAt: 1 }, team).disposition, REVOKE);
  assert.equal(reestablishable(row, good, { ...team, trigger: OPERATOR, humanLog: undefined }).disposition, REESTABLISH, 'the operator path as for a seat');
});

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orca-sweep-team-')));
  const store = new ControlStore(path.join(dir, 'journal.sqlite'));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const control = new Controller({ store, native: { route: () => undefined }, authority: async () => ({}) });
  control.events = new Events(control, path.join(dir, 'grants/inbox')); control.manager = new Manager(control, path.join(dir, 'grants/manager'));
  control.bindings = new Bindings(control, async () => ({ available: false, projects: [], membership: [] }), path.join(dir, 'grants/role'));
  control.roleSessions = new RoleSessions(control);
  const db = store.db;
  // A session delegated at generation 2 under boot b1, as the journal holds it before a restart.
  const session = () => { const id = randomUUID(); store.created(id, T(1), path.join(dir, id)); db.prepare("UPDATE sessions SET mode='delegated',generation=2,boot='b1',grantedAt=1 WHERE id=?").run(id); return id; };
  const seat = (holder, n) => db.prepare("INSERT INTO role_bindings VALUES ('project-orchestrator',?,?,?,?,2,1,'assigned','Seated for the sweep verification',NULL,?)").run(T(n), T(n), T(1), holder, new Date().toISOString());
  const worker = (supervisor, w) => { db.prepare('INSERT INTO event_links VALUES (?,?,?,2,2,?,?)').run(w, supervisor, randomUUID(), '{}', 'Manager owns the worker');
    db.prepare("INSERT INTO manager_workers VALUES (?,?,?,'{}',?,2,'attached',?)").run(randomUUID(), supervisor, randomUUID(), w, randomUUID()); };
  const started = (holder, n, id) => { const r = randomUUID();
    db.prepare("INSERT INTO session_ownership VALUES (?,?,?,'project-orchestrator','project-orchestrator',?,1,?,?)").run(r, T(n), T(1), T(n), holder, new Date().toISOString());
    db.prepare("INSERT INTO deliveries VALUES (?,NULL,'create','{}','delivered',?)").run(r, JSON.stringify({ id })); };
  return { store, db, session, seat, worker, started };
}
test('sweep candidates: seats first, then their manager workers and the sessions they started -- nobody else', t => {
  const f = fixture(t);
  const holder = f.session(), w = f.session(), r = f.session(), stranger = f.session(), orphanWorker = f.session(), unseatedManager = f.session();
  f.seat(holder, 8); f.worker(holder, w); f.started(holder, 8, r);
  f.worker(unseatedManager, orphanWorker);   // its supervisor holds no seat
  const c = sweepCandidates(f.db, 'b2');
  assert.equal(c[0], holder, 'the seat first');
  assert.deepEqual(new Set(c), new Set([holder, w, r]));
  for (const id of [stranger, orphanWorker, unseatedManager]) assert.equal(c.includes(id), false);
  // A worker whose link no longer matches its generation (it was taken over since) is not the team's.
  f.db.prepare('UPDATE sessions SET generation=4 WHERE id=?').run(w); assert.equal(ownedBySeat(f.db, w), false);
  // A seat held by a human: its team is the human's, not the sweep's.
  f.db.prepare("UPDATE sessions SET mode='human' WHERE id=?").run(holder); assert.equal(ownedBySeat(f.db, r), false);
  f.db.prepare("UPDATE sessions SET mode='delegated' WHERE id=?").run(holder); assert.equal(ownedBySeat(f.db, r), true);
  // A started session whose seat has a different holder now is not the new holder's.
  f.db.prepare('UPDATE role_bindings SET session=? WHERE seat=?').run(randomUUID(), T(8)); assert.equal(ownedBySeat(f.db, r), false);
});
test('repinSeat passes owned to the gate (static)', () => {
  const src = fs.readFileSync(new URL('./controller.mjs', import.meta.url), 'utf8');
  assert.match(src, /const facts = \{ seated: Boolean\(this\.bindings\?\.seatedRow\(id\)\), owned: ownedBySeat\(this\.store\.db, id\),/);
});
