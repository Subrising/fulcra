import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlStore } from './store.mjs';
import { Controller } from './controller.mjs';
import { Bindings } from './bindings.mjs';
import { localProjectDirectory } from './projects.mjs';
import { Events } from './events.mjs';
import { Permissions } from './permissions.mjs';
import { Leadership } from './leadership.mjs';
import { COMPANY, PROGRAMME } from './authority.mjs';
import { rpc } from './rpc.mjs';

const NOTE = 'Owns delivery of this project';
// A registered project ID is its own identity. None of these are task IDs.
const P = n => `22222222-2222-4222-8222-${String(n).padStart(12, '0')}`;
const T = n => `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`;
function directory({ projects = [P(1), P(2)], membership = [], available = true, partial = false } = {}) {
  return { observedAt: '2026-09-19T00:00:00.000Z', available, partial,
    projects: projects.map((id, n) => ({ id, name: `Project ${n}`, description: null, status: 'in_progress' })),
    membership, note: 'test project source' };
}
function open(file, source, grants = '/nonexistent/grants/role') {
  const store = new ControlStore(file);
  const routing = { route: () => undefined };
  const control = new Controller({ store, native: new Proxy(routing, { get: (t, k) => (k in t ? t[k] : () => { throw Error('A role binding must not invoke the native runtime'); }) }), authority: async () => ({ id: 'task', delegationAuthority: [] }) });
  control.bindings = new Bindings(control, async () => source.value, grants);
  return { store, control, source, request: rpc(control, 'test-operator') };
}
function setup(t, source = { value: directory() }) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orca-bindings-'))), file = path.join(dir, 'journal.sqlite'), opened = open(file, source, path.join(dir, 'grants', 'role'));
  t.after(() => { try { opened.store.close(); } catch { /* a reopen case closed it */ } fs.rmSync(dir, { recursive: true, force: true }); });
  return { ...opened, file, dir };
}
const enrol = (store, task, base = '/owned') => { const id = randomUUID(); store.created(id, task, path.join(base, id)); return id; };
const member = (taskId, projectId) => ({ taskId, projectId });
const assign = (control, seat, sessionId, extra = {}) => control.bindings.assign({ role: 'project-orchestrator', seat, sessionId, expectedSessionGeneration: 1, expectedRevision: 0, note: NOTE, ...extra });

test('a project binding keys the registered project ID, records the member task separately and survives reopening', async t => {
  const source = { value: directory({ membership: [member(T(1), P(1))] }) };
  const { store, file, dir, control } = setup(t, source), leader = enrol(store, T(1));
  const result = await assign(control, P(1), leader);
  assert.equal(result.projectId, P(1)); assert.equal(result.task, T(1));
  assert.notEqual(result.projectId, result.task); assert.equal(result.membershipAt, '2026-09-19T00:00:00.000Z');
  assert.equal(result.revision, 1); assert.equal(result.grantsAuthority, false);
  store.close();
  const reopened = open(file, source);
  t.after(() => { try { reopened.store.close(); } catch { /* closed above */ } fs.rmSync(dir, { recursive: true, force: true }); });
  const described = reopened.control.bindings.describe('project-orchestrator', P(1));
  assert.equal(described.state, 'assigned'); assert.equal(described.sessionId, leader);
  assert.equal(described.projectId, P(1)); assert.equal(described.task, T(1));
  assert.equal(described.sessionTaskMatches, true); assert.equal(described.session.token, undefined);
  // The stale revision a caller read before the first assignment stays refused after a reopen.
  await assert.rejects(assign(reopened.control, P(1), leader), /revision changed/);
});

test('membership must be explicitly recorded: a task ID, a foreign project, a null link and ancestry are all refused', async t => {
  const source = { value: directory({ membership: [member(T(1), P(1)), member(T(2), P(2)), member(T(3), null)] }) };
  const { store, control } = setup(t, source);
  const inProject = enrol(store, T(1)), otherProject = enrol(store, T(2)), unlinked = enrol(store, T(3)), unknownTask = enrol(store, T(9));
  await assert.rejects(assign(control, P(1), randomUUID()), /saved session identity/);
  // A task ID is not a project ID, even when that task is a real member of a real project.
  await assert.rejects(assign(control, T(1), inProject), /Unknown project/);
  await assert.rejects(assign(control, P(3), inProject), /Unknown project/);
  await assert.rejects(assign(control, P(1), otherProject), /not an explicitly recorded member/);
  await assert.rejects(assign(control, P(1), unlinked), /not an explicitly recorded member/);
  await assert.rejects(assign(control, P(1), unknownTask), /not an explicitly recorded member/);
  await assert.rejects(assign(control, P(1), inProject, { expectedSessionGeneration: 2 }), /Session control changed/);
  await assert.rejects(assign(control, P(1), inProject, { expectedRevision: 1 }), /revision changed/);
  await assert.rejects(assign(control, P(1), inProject, { seat: 'not-a-uuid' }), /registered project ID/);
  // A prime seat is board level over the programme root and carries no project identity.
  await assert.rejects(control.bindings.assign({ role: 'prime', seat: 'delivery', sessionId: inProject, expectedSessionGeneration: 1, expectedRevision: 0, note: NOTE }), /enrolled on the programme root/);
  // An unavailable project source blocks the write instead of recording unverified membership.
  source.value = directory({ available: false, projects: [], membership: [] });
  await assert.rejects(assign(control, P(1), inProject), /Project directory unavailable/);
  // Task authority stays a separate check from project membership.
  source.value = directory({ membership: [member(T(1), P(1))] });
  control.authority = async () => { throw Error('Task is outside delegated authority'); };
  await assert.rejects(assign(control, P(1), inProject), /outside delegated authority/);
  assert.equal(control.bindings.describe('project-orchestrator', P(1)).state, 'vacant');
  assert.equal(store.db.prepare('SELECT count(*) n FROM role_binding_history').get().n, 0);
});

test('a portable installation records no project directory, so a project role is refused and the view stays unknown', async t => {
  let contacted = 0;
  const board = () => { contacted++; throw Error('legacy board contacted'); };
  const local = (id, extra = {}) => ({ id, companyId: COMPANY, title: 'Real task', status: 'todo', ...extra });
  const source = { value: localProjectDirectory(() => [local(T(1)), local(T(2))]) };
  const { store, control } = setup(t, source), leader = enrol(store, T(1));
  assert.equal(contacted, 0); assert.equal(source.value.available, true); assert.deepEqual(source.value.projects, []);
  assert.deepEqual(source.value.membership, [member(T(1), null), member(T(2), null)]);
  await assert.rejects(assign(control, P(1), leader), /records no project directory/);
  const view = await control.bindings.projection(P(1));
  assert.equal(view.project.membership.known, false); assert.equal(view.project.membership.available, true);
  assert.equal(view.progress, null); assert.deepEqual(view.tasks, []);
  assert.deepEqual(view.blockers.map(b => b.kind), ['unknown-project']);
  assert.match(view.blockers[0].detail, /project membership is unsupported here/);
  // A local record claiming a project is unknown, never membership.
  const claimed = localProjectDirectory(() => [local(T(1), { projectId: P(1) })]);
  assert.equal(claimed.partial, true); assert.deepEqual(claimed.membership, [member(T(1), null)]);
  assert.equal(contacted, 0);
});

test('the projection aggregates only source-confirmed member tasks and preserves unknown or partial membership', async t => {
  const source = { value: directory({ membership: [member(T(1), P(1)), member(T(2), P(1)), member(T(3), P(2)), member(T(4), null)] }) };
  const { store, control } = setup(t, source);
  const leader = enrol(store, T(1)), second = enrol(store, T(2)), foreign = enrol(store, T(3));
  const prime = enrol(store, PROGRAMME);
  await control.bindings.assign({ role: 'prime', seat: 'delivery', sessionId: prime, expectedSessionGeneration: 1, expectedRevision: 0, note: 'Accountable prime seat for delivery' });
  await assign(control, P(1), leader);
  const done = randomUUID(), stuck = randomUUID(), elsewhere = randomUUID();
  store.admit(done, leader, 'send', { text: 'a' }); store.finish(done, 'delivered', { note: 'ok' });
  store.admit(stuck, second, 'send', { text: 'b' });
  store.admit(elsewhere, foreign, 'send', { text: 'c' });
  const view = await control.bindings.projection(P(1));
  assert.equal(view.project.id, P(1)); assert.equal(view.project.summary.name, 'Project 0');
  assert.deepEqual(view.project.membership.memberTasks, [T(1), T(2)]); assert.equal(view.project.membership.known, true);
  assert.equal(view.leader.sessionId, leader); assert.equal(view.leader.task, T(1));
  assert.deepEqual(view.primes.map(p => [p.seat, p.sessionId]), [['delivery', prime]]);
  // One project, two member tasks, aggregated. The third project's work is not borrowed.
  assert.deepEqual(view.tasks.map(x => [x.taskId, x.recorded]), [[T(1), 1], [T(2), 1]]);
  assert.equal(view.progress.memberTasks, 2); assert.equal(view.progress.recorded, 2);
  assert.deepEqual(view.progress.byState, { delivered: 1, intent: 1 });
  assert.deepEqual(view.blockers.map(b => [b.kind, b.taskId]), [['unresolved-delivery', T(2)]]);
  assert.deepEqual(view.needed, []);
  assert.deepEqual(view.decisions.map(d => [d.kind, d.action, d.session]), [['role-binding', 'assign', leader]]);
  assert.deepEqual(view.coverage, { supervision: false, permissions: false, leadership: false });
  // Partial coverage from the source is preserved rather than presented as complete.
  source.value = { ...source.value, partial: true };
  assert.equal((await control.bindings.projection(P(1))).project.membership.partial, true);
  // An unavailable source keeps the recorded leader visible but refuses to aggregate anything.
  source.value = directory({ available: false, projects: [], membership: [] });
  const dark = await control.bindings.projection(P(1));
  assert.equal(dark.progress, null); assert.deepEqual(dark.tasks, []);
  assert.equal(dark.leader.sessionId, leader);
  assert.deepEqual(dark.blockers.map(b => b.kind), ['project-source-unavailable']);
  assert.deepEqual(dark.needed.map(n => n.kind), ['leader-membership-unverified']);
  // A leader whose task stops being a member is reported, not silently dropped.
  source.value = directory({ membership: [member(T(2), P(1))] });
  const moved = await control.bindings.projection(P(1));
  assert.deepEqual(moved.project.membership.memberTasks, [T(2)]);
  assert.deepEqual(moved.blockers.map(b => b.kind), ['leader-membership-changed', 'unresolved-delivery']);
});

test('replacement and release preserve every prior session identity, member task and decision', async t => {
  const source = { value: directory({ membership: [member(T(1), P(1)), member(T(2), P(1))] }) };
  const { store, control } = setup(t, source);
  const first = enrol(store, T(1)), second = enrol(store, T(2));
  await assign(control, P(1), first, { note: 'Initial project leader' });
  const replaced = await assign(control, P(1), second, { expectedRevision: 1, note: 'Handing the project to the second session' });
  assert.equal(replaced.action, 'replace'); assert.equal(replaced.previousSessionId, first); assert.equal(replaced.task, T(2)); assert.equal(replaced.revision, 2);
  const released = control.bindings.unassign({ role: 'project-orchestrator', seat: P(1), expectedRevision: 2, note: 'Project paused pending a decision' });
  assert.equal(released.action, 'unassign'); assert.equal(released.previousSessionId, second);
  assert.equal(control.bindings.describe('project-orchestrator', P(1)).state, 'vacant');
  assert.throws(() => control.bindings.unassign({ role: 'project-orchestrator', seat: P(1), expectedRevision: 3, note: 'Already vacant seat' }), /holds no current role binding/);
  // A vacated seat keeps its counter, so a writer holding revision 2 is still refused after reassignment.
  await assert.rejects(assign(control, P(1), first, { expectedRevision: 2, note: 'Stale writer returns' }), /revision changed/);
  await assign(control, P(1), first, { expectedRevision: 3, note: 'Reinstating the original leader' });
  const history = store.db.prepare('SELECT action,projectId,task,previousSession,session,revision,note FROM role_binding_history ORDER BY rowid').all();
  assert.deepEqual(history.map(h => h.action), ['assign', 'replace', 'unassign', 'assign']);
  assert.deepEqual(history.map(h => [h.previousSession, h.session]), [[null, first], [first, second], [second, null], [null, first]]);
  assert.deepEqual(history.map(h => h.task), [T(1), T(2), T(2), T(1)]);
  assert.deepEqual(history.map(h => h.revision), [1, 2, 3, 4]);
  assert.equal(new Set(history.map(h => h.projectId)).size, 1);
  assert.equal(history[1].note, 'Handing the project to the second session');
  assert.deepEqual(store.list().map(s => s.id).sort(), [first, second].sort());
});

test('a role binding grants no authority: it never transfers control, creates work or sends a prompt', async t => {
  const source = { value: directory({ membership: [member(T(1), P(1))] }) };
  const { store, control } = setup(t, source), leader = enrol(store, T(1));
  const columns = 'id,task,cwd,mode,generation,token,expected,authority,expectedAt,boot,grantedAt';
  const before = store.db.prepare(`SELECT ${columns} FROM sessions`).all();
  await assign(control, P(1), leader);
  control.bindings.unassign({ role: 'project-orchestrator', seat: P(1), expectedRevision: 1, note: 'Releasing the seat again' });
  assert.deepEqual(store.db.prepare(`SELECT ${columns} FROM sessions`).all(), before);
  for (const table of ['deliveries', 'transfers', 'management_requests']) assert.equal(store.db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0);
  assert.equal(store.get(leader).mode, 'human');
  const route = control.bindings.route({ role: 'project-orchestrator', seat: P(1) });
  assert.equal(route.routing.deliverable, false);
  assert.match(route.routing.crossTask, /confers no control, creation, permission or artifact access/);
});

test('the projection surfaces real supervision faults, unread events, pending permissions and handoffs per member task', async t => {
  const source = { value: directory({ membership: [member(T(1), P(1))] }) };
  const { store, control } = setup(t, source), leader = enrol(store, T(1)), worker = enrol(store, T(1)), elsewhere = enrol(store, T(3));
  control.events = new Events(control); control.permissions = new Permissions(control); control.leadership = new Leadership(control);
  control.bindings = new Bindings(control, async () => source.value);
  await assign(control, P(1), leader);
  const at = new Date().toISOString(), pool = randomUUID(), handoff = randomUUID(), event = randomUUID();
  store.db.prepare('INSERT INTO event_faults VALUES (?,?,?)').run(worker, 'Worker output could not be reconciled', at);
  store.db.prepare('INSERT INTO event_faults VALUES (?,?,?)').run(elsewhere, 'Unrelated project fault', at);
  store.db.prepare("INSERT INTO event_inbox VALUES (?,?,?,?,?,'completion','{}','delivered',NULL,?)").run(event, randomUUID(), worker, leader, randomUUID(), at);
  store.db.prepare("INSERT INTO event_inbox VALUES (?,?,?,?,?,'completion','{}','delivered','read',?)").run(randomUUID(), randomUUID(), worker, leader, randomUUID(), at);
  store.db.prepare('INSERT INTO permission_grants VALUES (?,1,?,?,?,0,?)').run(leader, randomUUID(), leader, pool, 'Routine file grant for this verification');
  store.db.prepare("INSERT INTO permission_intents VALUES (?,?,?,?,'intent','{}',NULL,1)").run(randomUUID(), randomUUID(), leader, pool);
  store.db.prepare("INSERT INTO leadership_handoffs VALUES (?,?,?,1,'boot',1,?,'context','[]','[]','pending',NULL,NULL,?)").run(handoff, elsewhere, leader, randomUUID(), at);
  const view = await control.bindings.projection(P(1));
  assert.deepEqual(view.coverage, { supervision: true, permissions: true, leadership: true });
  // Only this project's member tasks appear; the fault on a task outside the project is not borrowed.
  assert.deepEqual(view.blockers.map(b => [b.kind, b.sessionId]), [['worker-fault', worker]]);
  assert.deepEqual(view.needed.map(n => n.kind).sort(), ['no-prime', 'pending-permission', 'unconsumed-leadership-handoff', 'unread-supervisor-event']);
  assert.equal(view.needed.find(n => n.kind === 'unread-supervisor-event').eventId, event);
  assert.equal(view.needed.find(n => n.kind === 'unconsumed-leadership-handoff').handoffId, handoff);
  // Same-millisecond timestamps make the relative order of these two unstable; both must be present.
  assert.deepEqual(view.decisions.map(d => d.kind).sort(), ['leadership-handoff', 'role-binding']);
});

test('role operations are operator-only and the scoped self read needs the session capability', async t => {
  const source = { value: directory({ membership: [member(T(1), P(1))] }) };
  const { store, control, request, dir } = setup(t, source), leader = enrol(store, T(1), dir), prime = enrol(store, PROGRAMME, dir);
  const input = { role: 'project-orchestrator', seat: P(1), sessionId: leader, expectedSessionGeneration: 1, expectedRevision: 0, note: NOTE };
  await assert.rejects(request({ method: 'bindings-assign', input, capability: 'worker' }), /Operator authorization/);
  await assert.rejects(request({ method: 'bindings-status', operator: 'test-operator', input: {} }), /no input/);
  await assert.rejects(request({ method: 'bindings-project', input: 'not-a-project', operator: 'test-operator' }), /Invalid project/);
  assert.equal(store.db.prepare('SELECT count(*) n FROM role_bindings').get().n, 0);
  await request({ method: 'bindings-assign', input, operator: 'test-operator' });
  await request({ method: 'bindings-assign', input: { role: 'prime', seat: 'delivery', sessionId: prime, expectedSessionGeneration: 1, expectedRevision: 0, note: 'Accountable prime seat for delivery' }, operator: 'test-operator' });
  const seats = await request({ method: 'bindings-status', operator: 'test-operator' });
  assert.deepEqual(seats.bindings.map(b => [b.role, b.seat, b.projectId, b.task, b.sessionId]), [['prime', 'delivery', null, PROGRAMME, prime], ['project-orchestrator', P(1), P(1), T(1), leader]]);
  await assert.rejects(request({ method: 'bindings-self', input: { sessionId: leader }, capability: 'guess' }), /Role capability revoked or invalid/);
  store.transfer(leader, 'delegated', 'Delegated for this verification');
  const granted = await request({ method: 'bindings-grant', input: { sessionId: leader, expectedGeneration: store.get(leader).generation }, operator: 'test-operator' });
  const capability = JSON.parse(fs.readFileSync(granted.grantFile, 'utf8')).capability;
  const self = await request({ method: 'bindings-self', input: { sessionId: leader }, capability });
  assert.deepEqual(self.roles.map(r => [r.role, r.seat, r.projectId, r.task]), [['project-orchestrator', P(1), P(1), T(1)]]);
  assert.deepEqual(self.primes.map(p => [p.seat, p.sessionId]), [['delivery', prime]]);
  assert.equal(self.send.available, false);
  // A control transfer changes the session generation; the binding survives and says so.
  const described = control.bindings.describe('project-orchestrator', P(1));
  assert.equal(described.sessionGenerationChanged, true); assert.equal(described.sessionId, leader);
});
