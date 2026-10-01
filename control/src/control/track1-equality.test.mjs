// Track 1 (CONTROLLER-STALLS-PLAN / BRIEF-TRACK1) equality proof, on generated multi-task journals (track1.fixture.mjs):
//   - permissions-status: statusMany() (the request-invariant parts computed once) is byte-identical, as canonical JSON, to
//     the per-row path it replaces (rows().map(status)), including the over-capacity journal;
//   - {taskId} on permissions-status / manager-summary / leadership-status equals the unscoped read filtered exactly as the
//     Fulcra app filters it (orca-organization/server/management.ts), for every task and for an unknown one;
//   - history(task): the index-friendly query returns the old query's rows in the old order, and the planner uses the new
//     indexes instead of scanning every delivery;
//   - the cache pragmas are set, and statusMany does a fraction of the SQLite work.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generate, canonical, OLD_HISTORY_SQL, oldStatus, randomUUID } from './track1.fixture.mjs';
import { rpc } from './rpc.mjs';

const SEEDS = [[7, 700], [11, 1400], [23, 300], [42, 900]];   // [seed, routine intents]; 1400 exceeds the 1000 capacity
function journal(t, seed, intents) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orca-track1-')));
  const g = generate(dir, { seed, intents });
  t.after(() => { g.store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { ...g, request: rpc(g.control, 'track1-operator') };
}
const op = (g, method, input) => g.request({ method, operator: 'track1-operator', ...(input === undefined ? {} : { input }) });
const inTask = (g, task) => id => g.store.get(id)?.task === task;

for (const [seed, intents] of SEEDS) test(`permissions-status: statusMany equals the per-row path, and {taskId} equals the app's filter (seed ${seed})`, async t => {
  const g = journal(t, seed, intents), p = g.control.permissions;
  const perRow = p.rows().map(r => oldStatus(p, r.session));   // the old code, verbatim
  assert.equal(canonical(p.statusMany()), canonical(perRow));
  assert.equal(canonical(p.rows().map(r => p.status(r.session))), canonical(perRow), 'status(id) itself is unchanged');
  assert.equal(canonical((await op(g, 'permissions-status')).grants), canonical(perRow), 'the unscoped RPC is unchanged');
  for (const task of [...g.tasks, randomUUID()]) {
    const scoped = await op(g, 'permissions-status', { taskId: task });
    assert.equal(canonical(scoped.grants), canonical(perRow.filter(s => inTask(g, task)(s.sessionId))), 'scoped = the app filter on the unscoped read');
  }
  if (intents > 1000) assert(perRow.every(s => !s.active), 'the over-capacity journal suspends every grant, in both paths');
});

for (const [seed, intents] of SEEDS) test(`manager-summary and leadership-status: {taskId} equals the app's filter (seed ${seed})`, async t => {
  const g = journal(t, seed, intents);
  const summary = await op(g, 'manager-summary'), leadership = await op(g, 'leadership-status');
  assert.equal(canonical(summary), canonical(g.control.manager.summary()), 'unscoped unchanged');
  for (const task of [...g.tasks, randomUUID()]) {
    assert.equal(canonical(await op(g, 'manager-summary', { taskId: task })), canonical(summary.filter(r => r.task === task)));
    const scoped = await op(g, 'leadership-status', { taskId: task }), member = inTask(g, task);
    assert.equal(canonical(scoped), canonical({ ...leadership, handoffs: leadership.handoffs.filter(h => member(h.source) && member(h.destination) && h.workers.every(member)), candidates: leadership.candidates.filter(member) }));
  }
});

test('management reads refuse any input other than none or exactly {taskId: uuid}', async t => {
  const g = journal(t, 7, 700);
  for (const method of ['permissions-status', 'manager-summary', 'leadership-status'])
    for (const bad of [{}, { taskId: 'nope' }, { taskId: g.tasks[0], extra: 1 }, 'x', [g.tasks[0]]]) await assert.rejects(op(g, method, bad), /takes no input or \{taskId\}/, `${method} ${JSON.stringify(bad)}`);
});

for (const [seed, intents] of SEEDS) test(`history: the index-friendly query returns the old rows in the old order (seed ${seed})`, t => {
  const g = journal(t, seed, intents), old = g.store.db.prepare(OLD_HISTORY_SQL);
  for (const task of [...g.tasks, randomUUID()]) assert.deepEqual(g.control.history(task), old.all(task, task, task));
});

test('history: the planner uses the new indexes instead of scanning deliveries', t => {
  const g = journal(t, 42, 900);
  const src = fs.readFileSync(new URL('./controller.mjs', import.meta.url), 'utf8'), at = src.indexOf('return this.store.db.prepare(`SELECT id,session,kind,state FROM (');
  const sql = src.slice(src.indexOf('`', at) + 1, src.indexOf('`)', at));
  const plan = g.store.db.prepare('EXPLAIN QUERY PLAN ' + sql).all(g.tasks[0], g.tasks[0], g.tasks[0]).map(r => r.detail).join('\n');
  assert.match(plan, /deliveries_session/); assert.match(plan, /deliveries_create_task/);
  assert.doesNotMatch(plan, /SCAN d\b/, plan);
  const oldPlan = g.store.db.prepare('EXPLAIN QUERY PLAN ' + OLD_HISTORY_SQL).all(g.tasks[0], g.tasks[0], g.tasks[0]).map(r => r.detail).join('\n');
  assert.match(oldPlan, /SCAN d\b/, 'the old query scanned every delivery (the reason for 1c)');
});

test('the cache pragmas are set on the controller’s connection, and statusMany does a fraction of the SQLite work', t => {
  const g = journal(t, 42, 900), db = g.store.db, p = g.control.permissions;
  assert.equal(db.prepare('PRAGMA cache_size').get().cache_size, -131072);
  assert.equal(db.prepare('PRAGMA mmap_size').get().mmap_size, 268435456);
  // Count executed statements (get/all/run) through a wrapper on prepare, as metrics.mjs's instrumentDb counts them.
  let calls = 0; const prepare = db.prepare.bind(db);
  db.prepare = sql => { const s = prepare(sql); return new Proxy(s, { get: (o, k) => typeof o[k] === 'function' && ['get', 'all', 'run'].includes(k) ? (...a) => { calls++; return o[k](...a); } : typeof o[k] === 'function' ? o[k].bind(o) : o[k] }); };
  try {
    calls = 0; p.rows().map(r => oldStatus(p, r.session)); const perRow = calls;
    calls = 0; p.statusMany(); const many = calls;
    t.diagnostic(`SQLite calls per permissions-status: per-row ${perRow}, statusMany ${many} (${p.rows().length} grants)`);
    assert(many * 5 <= perRow, `statusMany ${many} vs per-row ${perRow}`);
  } finally { db.prepare = prepare; }
});
