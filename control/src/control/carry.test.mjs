// H7 item 4 (G18): a re-delegation of the SAME session carries the team authority it held at its last delegated
// generation -- manager grant, inbox credential, supervision links, its own worker link, routine grant -- and nothing else.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { FENCE_PROTOCOL } from './native-fence.mjs';
import { ControlStore, hash } from './store.mjs';
import { Controller } from './controller.mjs';
import { Events } from './events.mjs';
import { Manager } from './manager.mjs';
import { Permissions } from './permissions.mjs';
import { Bindings } from './bindings.mjs';
import { COMPANY, PROGRAMME } from './authority.mjs';
import { carryAuthority } from './carry.mjs';

const T = n => `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`;
const issue = id => ({ id, companyId: COMPANY, parentId: id === PROGRAMME ? null : PROGRAMME, assigneeUserId: 'local-board', assigneeAgentId: null, status: 'in_progress' });

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orca-carry-')));
  const store = new ControlStore(path.join(dir, 'journal.sqlite'));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const states = new Map();
  const native = { route: () => undefined,
    inspect: async id => ({ boot: 'boot-1', fenceProtocol: FENCE_PROTOCOL, saturated: false, humanAt: 0, status: 'idle', pending: 0, lastPromptId: null, ...(states.get(id) ?? {}) }) };
  const control = new Controller({ store, native, authority: async id => issue(id) });
  control.events = new Events(control, path.join(dir, 'grants/inbox'));
  control.manager = new Manager(control, path.join(dir, 'grants/manager'));
  control.permissions = new Permissions(control);
  control.bindings = new Bindings(control, async () => ({ available: false, projects: [], membership: [] }), path.join(dir, 'grants/role'));
  const db = store.db;
  const enrol = (task = T(1)) => { const id = randomUUID(); store.created(id, task, path.join(dir, 'tasks', id)); return id; };
  const delegate = id => control.handback(id, 'Delegated for the carry verification');
  // A team as the live journal held it before a restart: the manager (seat holder) with a grant and one attached
  // worker, a supervision link, both with routine grants rooted at the manager.
  const team = async () => {
    const manager = enrol(), worker = enrol();
    await delegate(manager); await delegate(worker);
    const m = store.get(manager), w = store.get(worker), epoch = randomUUID(), token = 'manager-token-' + epoch;
    db.prepare('INSERT INTO manager_grants VALUES (?,?,?,?,?,?)').run(manager, m.generation, epoch, hash(token), 4, 'Seat-conferred manager authority for the team');
    db.prepare("INSERT INTO manager_workers VALUES (?,?,?,?,?,?,'attached',?)").run(randomUUID(), manager, epoch, '{}', worker, w.generation, randomUUID());
    const link = randomUUID();
    db.prepare('INSERT INTO event_links VALUES (?,?,?,?,?,?,?)').run(worker, manager, link, w.generation, m.generation, '{}', 'Manager owns the worker and its review loop');
    db.prepare('INSERT INTO event_credentials VALUES (?,?,?)').run(manager, m.generation, hash('inbox-token'));
    const rootEpoch = randomUUID();
    db.prepare('INSERT INTO permission_grants VALUES (?,?,?,?,?,0,?)').run(manager, m.generation, rootEpoch, manager, rootEpoch, 'Routine grant for the team');
    db.prepare('INSERT INTO permission_grants VALUES (?,?,?,?,?,0,?)').run(worker, w.generation, randomUUID(), manager, rootEpoch, 'Inherited routine grant');
    return { manager, worker, epoch, token, link };
  };
  // What each consumer of that authority actually checks.
  const works = f => {
    const out = {};
    try { f.control.manager.local(f.team.manager, f.team.token, f.team.epoch); out.manager = true; } catch { out.manager = false; }
    try { f.control.manager.owned(f.control.manager.local(f.team.manager, f.team.token, f.team.epoch), f.team.worker); out.owned = true; } catch { out.owned = false; }
    const link = db.prepare('SELECT * FROM event_links WHERE worker=?').get(f.team.worker);
    out.link = Boolean(link && f.control.events.valid(link));
    try { f.control.events.checkInbox(f.team.manager, 'inbox-token'); out.inbox = true; } catch { out.inbox = false; }
    try { f.control.permissions.binding(f.team.worker); out.routine = true; } catch { out.routine = false; }
    return out;
  };
  return { dir, store, db, control, states, enrol, delegate, team, works };
}
const ALL = { manager: true, owned: true, link: true, inbox: true, routine: true };

test('G18: after a restart takes the whole team over, handing back the SAME sessions restores the team as it was', async t => {
  const f = fixture(t); f.team = await f.team();
  assert.deepEqual(f.works(f), ALL, 'the team works before');
  // The restart: both sessions are taken over (each at a new generation), as the first dispatch after a boot does.
  f.control.takeover(f.team.manager, 'Native input identity changed after the restart');
  f.control.takeover(f.team.worker, 'Native input identity changed after the restart');
  assert.deepEqual(f.works(f), { manager: false, owned: false, link: false, inbox: false, routine: false }, 'everything is dead, as on the live journal');
  // The operator re-delegates the manager first, then the worker (G18b's order).
  const m = await f.delegate(f.team.manager);
  assert.deepEqual([m.carried.managerGrant, m.carried.inbox, m.carried.supervisorLinks, m.carried.routineGrant], [1, 1, 1, 1]);
  assert.equal(m.carried.from, 2); assert.equal(m.carried.to, 4);
  const mid = f.works(f); assert.equal(mid.manager, true); assert.equal(mid.inbox, true); assert.equal(mid.owned, false, 'the worker is still taken over');
  const w = await f.delegate(f.team.worker);
  assert.deepEqual([w.carried.workerLink, w.carried.routineGrant], [1, 1]);
  assert.deepEqual(f.works(f), ALL, 'manager_workers lists it attached, assign/inspect reach it, the inbox reads, routine writes pass');
  // The same grant, not a new one: epoch, token (the grant file) and cap unchanged.
  const g = f.db.prepare('SELECT * FROM manager_grants WHERE supervisor=?').get(f.team.manager);
  assert.deepEqual([g.epoch, g.token, g.maxWorkers, g.generation], [f.team.epoch, hash(f.team.token), 4, f.control.store.get(f.team.manager).generation]);
  // The worker handed back before its manager is carried too (either order works).
  const g2 = fixture(t); g2.team = await g2.team();
  g2.control.takeover(g2.team.manager, 'Host restart takeover'); g2.control.takeover(g2.team.worker, 'Host restart takeover');
  await g2.delegate(g2.team.worker); await g2.delegate(g2.team.manager);
  assert.deepEqual(g2.works(g2), ALL);
});
test('only the generation it was last delegated at: an older generation, a revoked grant or a released seat are not revived', async t => {
  const f = fixture(t); f.team = await f.team();
  // Two takeovers with a handback between them whose carry is undone (simulating an older journal): the grant is two
  // delegations old and must stay dead.
  f.control.takeover(f.team.manager, 'First human takeover of the manager');
  await f.delegate(f.team.manager);
  f.db.prepare('UPDATE manager_grants SET generation=2 WHERE supervisor=?').run(f.team.manager);
  f.db.prepare('UPDATE permission_grants SET generation=2 WHERE session=?').run(f.team.manager);
  f.control.takeover(f.team.manager, 'Second human takeover of the manager');
  const m = await f.delegate(f.team.manager);
  assert.deepEqual([m.carried.managerGrant, m.carried.routineGrant], [0, 0]);
  assert.equal(f.works(f).manager, false);
  // A revoked routine grant stays revoked.
  const r = fixture(t); r.team = await r.team();
  r.db.prepare("UPDATE permission_grants SET revoked=1,reason='Operator revoked the routine grant' WHERE session=?").run(r.team.worker);
  r.control.takeover(r.team.worker, 'Human took the worker'); const w = await r.delegate(r.team.worker);
  assert.equal(w.carried.routineGrant, 0); assert.equal(r.works(r).routine, false);
  // A seat-conferred grant whose seat this session no longer holds at that revision is not carried, nor are its links.
  const s = fixture(t); s.team = await s.team();
  s.db.prepare('INSERT INTO seat_manager_grants VALUES (?,?,?,?,?,?)').run(s.team.manager, 'project-orchestrator', T(7), 1, s.team.epoch, new Date().toISOString());
  s.db.prepare("INSERT INTO role_bindings VALUES ('project-orchestrator',?,?,?,?,?,2,'assigned','Reseated with another holder',NULL,?)").run(T(7), T(7), T(1), randomUUID(), 1, new Date().toISOString());
  s.control.takeover(s.team.manager, 'Human took the manager'); const sm = await s.delegate(s.team.manager);
  assert.deepEqual([sm.carried.managerGrant, sm.carried.supervisorLinks, sm.carried.inbox], [0, 0, 0]);
  // ...but the SAME holder at the same revision is carried.
  const h = fixture(t); h.team = await h.team();
  h.db.prepare('INSERT INTO seat_manager_grants VALUES (?,?,?,?,?,?)').run(h.team.manager, 'project-orchestrator', T(7), 3, h.team.epoch, new Date().toISOString());
  h.db.prepare("INSERT INTO role_bindings VALUES ('project-orchestrator',?,?,?,?,?,3,'assigned','Seated',NULL,?)").run(T(7), T(7), T(1), h.team.manager, 1, new Date().toISOString());
  h.control.takeover(h.team.manager, 'Host restart takeover'); h.control.takeover(h.team.worker, 'Host restart takeover');
  assert.equal((await h.delegate(h.team.manager)).carried.managerGrant, 1); await h.delegate(h.team.worker);
  assert.deepEqual(h.works(h), ALL);
});
test('a worker whose manager started a new epoch, or on another task, stays orphaned; a human-held session carries nothing', async t => {
  const f = fixture(t); f.team = await f.team();
  f.db.prepare('UPDATE manager_grants SET epoch=? WHERE supervisor=?').run(randomUUID(), f.team.manager);   // an operator re-issued it
  f.control.takeover(f.team.worker, 'Host restart takeover'); const w = await f.delegate(f.team.worker);
  assert.equal(w.carried.workerLink, 0); assert.equal(f.works(f).owned, false);
  const g = fixture(t); g.team = await g.team();
  g.db.prepare('UPDATE sessions SET task=? WHERE id=?').run(T(9), g.team.manager);
  g.control.takeover(g.team.worker, 'Host restart takeover'); assert.equal((await g.delegate(g.team.worker)).carried.workerLink, 0);
  // carryAuthority itself refuses a session that is not delegated, and one that was never delegated before.
  const h = fixture(t); h.team = await h.team();
  h.control.takeover(h.team.manager, 'Human took it');
  assert.deepEqual(carryAuthority(h.db, h.team.manager), { from: null, to: h.store.get(h.team.manager).generation, managerGrant: 0, inbox: 0, supervisorLinks: 0, workerLink: 0, routineGrant: 0 });
  const fresh = h.enrol(); const first = await h.delegate(fresh);
  assert.equal(first.carried.from, null, 'a first delegation has nothing to carry');
});
test('handback carries inside its own flow, after the role credential, and a carry failure never fails the handback (static)', () => {
  const src = fs.readFileSync(new URL('./controller.mjs', import.meta.url), 'utf8'), h = src.slice(src.indexOf('  async handback('), src.indexOf('  async reestablish('));
  assert.ok(h.indexOf('carryAuthority(this.store.db, id)') > h.indexOf('this.bindings?.reissueRole(id)'));
  assert.match(h, /try \{ grant\.carried = this\.store\.atomic\(\(\) => carryAuthority\(this\.store\.db, id\)\); \}\s*catch \(e\) \{ grant\.carried = \{ error: e\.message \}; \}/);
});
test('review H7 M3: a routine grant is carried only while the live bound has room', async t => {
  const { LIVE_GRANT_LIMIT } = await import('./permissions.mjs');
  const f = fixture(t); f.team = await f.team();
  f.control.takeover(f.team.worker, 'Human took the worker over');
  // While it was taken over, others filled the live bound.
  const live = () => f.db.prepare("SELECT count(*) n FROM permission_grants g JOIN sessions x ON x.id=g.session AND x.mode='delegated' AND x.generation=g.generation WHERE g.revoked=0").get().n;
  while (live() < LIVE_GRANT_LIMIT) { const s = f.enrol(); await f.delegate(s); const e = randomUUID(); f.db.prepare('INSERT INTO permission_grants VALUES (?,?,?,?,?,0,?)').run(s, f.store.get(s).generation, e, s, e, 'Another routine grant'); }
  const w = await f.delegate(f.team.worker);
  assert.equal(w.carried.routineGrant, 0); assert.equal(w.carried.workerLink, 1, 'the rest of the team authority still carries');
  assert.equal(live(), LIVE_GRANT_LIMIT, 'never 33 of 32');
});
