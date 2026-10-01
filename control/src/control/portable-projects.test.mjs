import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlStore } from './store.mjs';
import { Controller } from './controller.mjs';
import { Bindings } from './bindings.mjs';
import { localProjectDirectory, readProjectDirectory } from './projects.mjs';
import { localTasks, localProjects } from '../portable-config.mjs';
import { COMPANY, PROGRAMME } from './authority.mjs';
import { rpc } from './rpc.mjs';

const P = n => `22222222-2222-4222-8222-${String(n).padStart(12, '0')}`;
const T = n => `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`;
const issue = id => ({ id, companyId: COMPANY, parentId: id === PROGRAMME ? null : PROGRAMME, assigneeUserId: 'local-board', assigneeAgentId: null, status: 'in_progress' });
const task = (id, projectId) => ({ id, companyId: COMPANY, title: 'Real task', status: 'todo', ...(projectId === undefined ? {} : { projectId }) });
const project = (id, extra = {}) => ({ id, companyId: COMPANY, name: 'Orca delivery', description: null, status: 'in_progress', ...extra });

// A real private catalog file read through the real portable readers, not a stubbed directory.
function catalog(t, body) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orca-portable-')));
  fs.chmodSync(home, 0o700);
  const file = path.join(home, 'tasks.json');
  fs.writeFileSync(file, JSON.stringify(body), { mode: 0o600 });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, file, config: { tasks: file } };
}

test('a portable catalog with projects yields real membership; an old task-only catalog is unchanged', async t => {
  const withProjects = catalog(t, { version: 1, projects: [project(P(1)), project(P(2), { name: 'Second' })],
    issues: [task(T(1), P(1)), task(T(2), P(1)), task(T(3), P(2)), task(T(4), null), task(T(5))] });
  assert.deepEqual(localProjects(withProjects.config).map(p => p.id), [P(1), P(2)]);
  const d = localProjectDirectory(() => localTasks(withProjects.config), () => localProjects(withProjects.config));
  assert.equal(d.available, true); assert.equal(d.partial, false);
  assert.deepEqual(d.projects, [{ id: P(1), name: 'Orca delivery', description: null, status: 'in_progress' },
    { id: P(2), name: 'Second', description: null, status: 'in_progress' }]);
  // Membership comes only from each task's own explicit projectId. Nothing is guessed from a task.
  assert.deepEqual(d.membership, [{ taskId: T(1), projectId: P(1) }, { taskId: T(2), projectId: P(1) },
    { taskId: T(3), projectId: P(2) }, { taskId: T(4), projectId: null }, { taskId: T(5), projectId: null }]);
  assert.match(d.note, /Local catalog projects and explicit task membership/);

  // Backward compatibility: a catalog written before projects existed behaves exactly as it did.
  const old = catalog(t, { version: 1, issues: [task(T(1)), task(T(2))] });
  assert.deepEqual(localProjects(old.config), []);
  const legacy = localProjectDirectory(() => localTasks(old.config), () => localProjects(old.config));
  assert.equal(legacy.available, true); assert.equal(legacy.partial, false);
  assert.deepEqual(legacy.projects, []);
  assert.deepEqual(legacy.membership, [{ taskId: T(1), projectId: null }, { taskId: T(2), projectId: null }]);
  assert.match(legacy.note, /project grouping is not supported/);

  // The legacy board path is untouched by the new local reader argument.
  const board = await readProjectDirectory(async resource => (resource === 'projects' ? [project(P(1))] : [{ id: T(1), companyId: COMPANY, projectId: P(1) }]), null);
  assert.deepEqual(board.membership, [{ taskId: T(1), projectId: P(1) }]);
});

test('unconfirmable links, malformed records and an invalid catalog are refused rather than assumed', async t => {
  // A link to a project this catalog does not confirm stays unknown and marks the read partial.
  const dangling = catalog(t, { version: 1, projects: [project(P(1))], issues: [task(T(1), P(1)), task(T(2), P(9))] });
  const d = localProjectDirectory(() => localTasks(dangling.config), () => localProjects(dangling.config));
  assert.equal(d.partial, true);
  assert.deepEqual(d.membership, [{ taskId: T(1), projectId: P(1) }, { taskId: T(2), projectId: null }]);

  // A malformed project row is dropped, not repaired.
  const malformed = catalog(t, { version: 1, projects: [project(P(1)), { ...project(P(2)), name: null }, { ...project(P(3)), companyId: T(9) }], issues: [task(T(1), P(2))] });
  const m = localProjectDirectory(() => localTasks(malformed.config), () => localProjects(malformed.config));
  assert.equal(m.partial, true); assert.deepEqual(m.projects.map(p => p.id), [P(1)]);
  assert.deepEqual(m.membership, [{ taskId: T(1), projectId: null }]);

  // Structural invalidity refuses the whole catalog instead of publishing half of it.
  const duplicate = catalog(t, { version: 1, projects: [project(P(1)), project(P(1))], issues: [task(T(1))] });
  assert.throws(() => localProjects(duplicate.config), /Invalid local project catalog/);
  const refused = localProjectDirectory(() => localTasks(duplicate.config), () => localProjects(duplicate.config));
  assert.equal(refused.available, false); assert.equal(refused.partial, true);
  assert.deepEqual(refused.projects, []); assert.deepEqual(refused.membership, []);
  const oversize = catalog(t, { version: 1, projects: Array.from({ length: 65 }, (_, n) => project(`22222222-2222-4222-8222-${String(n).padStart(12, '0')}`)), issues: [] });
  assert.throws(() => localProjects(oversize.config), /Invalid local project catalog/);
});

test('a portable project seat binds for real once the catalog confirms membership', async t => {
  const local = catalog(t, { version: 1, projects: [project(P(1))], issues: [task(T(1), P(1)), task(T(2), P(1))] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-portable-bind-'));
  const store = new ControlStore(path.join(dir, 'journal.sqlite'));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const control = new Controller({ store, native: { route: () => undefined }, authority: async id => issue(id) });
  control.bindings = new Bindings(control, async () => localProjectDirectory(() => localTasks(local.config), () => localProjects(local.config)), path.join(dir, 'grants', 'role'));
  const request = rpc(control, 'test-operator');
  const leader = randomUUID(); store.created(leader, T(1), path.join(dir, leader));
  const bound = await request({ method: 'bindings-assign', operator: 'test-operator',
    input: { role: 'project-orchestrator', seat: P(1), sessionId: leader, expectedSessionGeneration: 1, expectedRevision: 0, note: 'Owns delivery of this project' } });
  assert.equal(bound.projectId, P(1)); assert.equal(bound.task, T(1)); assert.notEqual(bound.projectId, bound.task);
  const view = await request({ method: 'bindings-project', input: P(1), operator: 'test-operator' });
  assert.equal(view.project.membership.known, true);
  assert.deepEqual(view.project.membership.memberTasks, [T(1), T(2)]);
  assert.equal(view.leader.sessionId, leader);
  assert.notEqual(view.progress, null);
  // A task outside the catalog's recorded membership is still refused on a portable installation.
  const stranger = randomUUID(); store.created(stranger, T(9), path.join(dir, stranger));
  await assert.rejects(request({ method: 'bindings-assign', operator: 'test-operator',
    input: { role: 'project-orchestrator', seat: P(1), sessionId: stranger, expectedSessionGeneration: 1, expectedRevision: 1, note: 'Not a recorded member' } }), /not an explicitly recorded member/);
});
