#!/usr/bin/env node
// Track 1 cross-version proof and measurement (BRIEF-TRACK1). READ-ONLY on the source journal: it is opened read-only and
// copied twice with SQLite's backup API into a private temporary directory; nothing ever writes the source.
//
//   node tools/track1-proof.mjs --old <tree> --new <tree> --journal <journal file> [--tmp <dir>] [--runs 3]
//
// <tree> is a controller source checkout (its src/control is imported). The OLD tree's modules run on one copy, the NEW
// tree's on the other (each module constructor does its usual startup writes on its OWN copy only). It then compares, as
// canonical JSON, the unscoped permissions-status / manager-summary / leadership-status and history(task) for every task,
// and (new tree) each {taskId}-scoped read against the old unscoped read filtered as the Fulcra app filters it. It prints
// the median ms and the SQLite statements executed per request, old vs new, and exits 1 on any difference.
// The operator runs it on the live journal (the controller's deny rules keep Claude sessions off that file).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const arg = name => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : undefined; };
const OLD = path.resolve(arg('old') ?? ''), NEW = path.resolve(arg('new') ?? ''), SOURCE = arg('journal'), RUNS = Number(arg('runs') ?? 3);
if (!SOURCE || !fs.existsSync(`${OLD}/src/control/rpc.mjs`) || !fs.existsSync(`${NEW}/src/control/rpc.mjs`)) { console.error('usage: --old <tree> --new <tree> --journal <file>'); process.exit(2); }
const TMP = fs.mkdtempSync(path.join(arg('tmp') ?? os.tmpdir(), 'orca-track1-proof-')); fs.chmodSync(TMP, 0o700);
const canonical = x => JSON.stringify(x, (_k, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);

async function copyOf(name) {
  const dir = path.join(TMP, name); fs.mkdirSync(dir, { mode: 0o700 });
  const src = new DatabaseSync(SOURCE, { readOnly: true });
  try { await backup(src, path.join(dir, 'journal.sqlite')); } finally { src.close(); }
  return dir;
}
async function load(tree, dir) {
  const m = async f => import(pathToFileURL(`${tree}/src/control/${f}`).href);
  const [{ ControlStore }, { Controller }, { Events }, { Manager }, { Leadership }, { Permissions }, { rpc }] = await Promise.all(
    ['store.mjs', 'controller.mjs', 'events.mjs', 'manager.mjs', 'leadership.mjs', 'permissions.mjs', 'rpc.mjs'].map(m));
  const store = new ControlStore(path.join(dir, 'journal.sqlite'));
  const control = new Controller({ store, native: { route: () => undefined }, authority: async () => ({}) });
  control.events = new Events(control, path.join(dir, 'grants/inbox')); control.manager = new Manager(control, path.join(dir, 'grants/manager'));
  control.leadership = new Leadership(control); control.permissions = new Permissions(control);
  // Count executed statements the way metrics.mjs's instrumentDb does (get/all/run on prepared statements).
  let calls = 0; const prepare = store.db.prepare.bind(store.db);
  store.db.prepare = sql => { const s = prepare(sql); return new Proxy(s, { get: (o, k) => typeof o[k] === 'function' && ['get', 'all', 'run'].includes(k) ? (...a) => { calls++; return o[k](...a); } : typeof o[k] === 'function' ? o[k].bind(o) : o[k] }); };
  const request = rpc(control, 'track1-proof');
  const call = async (method, input) => { calls = 0; const t0 = performance.now(); const r = await request({ method, operator: 'track1-proof', ...(input === undefined ? {} : { input }) }); return { r, ms: performance.now() - t0, calls }; };
  const history = task => { calls = 0; const t0 = performance.now(); const r = control.history(task); return { r, ms: performance.now() - t0, calls }; };
  return { store, control, call, history };
}
const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const oldSide = await load(OLD, await copyOf('old')), newSide = await load(NEW, await copyOf('new'));
const tasks = oldSide.store.db.prepare('SELECT DISTINCT task FROM sessions ORDER BY task').all().map(r => r.task);
const failures = [], report = { journalTasks: tasks.length, reads: {} };
const measure = async (label, side, fn) => { const out = []; for (let i = 0; i < RUNS; i++) out.push(await fn(side)); return { r: out[0].r, ms: median(out.map(o => o.ms)), calls: out[0].calls }; };
for (const method of ['permissions-status', 'manager-summary', 'leadership-status']) {
  const o = await measure(method, oldSide, s => s.call(method)), n = await measure(method, newSide, s => s.call(method));
  if (canonical(o.r) !== canonical(n.r)) failures.push(`${method}: unscoped output differs`);
  report.reads[method] = { oldMs: +o.ms.toFixed(1), newMs: +n.ms.toFixed(1), oldCalls: o.calls, newCalls: n.calls };
  const member = task => id => oldSide.store.get(id)?.task === task;
  let scopedMs = [], scopedCalls = [];
  for (const task of tasks) {
    const s = await newSide.call(method, { taskId: task }); scopedMs.push(s.ms); scopedCalls.push(s.calls);
    const expect = method === 'permissions-status' ? { ...o.r, grants: o.r.grants.filter(g => member(task)(g.sessionId)) }
      : method === 'manager-summary' ? o.r.filter(r => r.task === task)
      : { ...o.r, handoffs: o.r.handoffs.filter(h => member(task)(h.source) && member(task)(h.destination) && h.workers.every(member(task))), candidates: o.r.candidates.filter(member(task)) };
    if (canonical(s.r) !== canonical(expect)) failures.push(`${method} {taskId ${task}}: differs from the old read filtered`);
  }
  report.reads[method].scopedMedianMs = +median(scopedMs).toFixed(1); report.reads[method].scopedMedianCalls = median(scopedCalls);
}
let hOld = [], hNew = [];
for (const task of tasks) {
  const o = oldSide.history(task), n = newSide.history(task); hOld.push(o.ms); hNew.push(n.ms);
  if (canonical(o.r) !== canonical(n.r)) failures.push(`history ${task}: differs`);
}
report.reads.history = { tasks: tasks.length, oldMedianMs: +median(hOld).toFixed(1), newMedianMs: +median(hNew).toFixed(1) };
report.pragmas = { old: { cache_size: oldSide.store.db.prepare('PRAGMA cache_size').get().cache_size, mmap_size: oldSide.store.db.prepare('PRAGMA mmap_size').get().mmap_size },
  new: { cache_size: newSide.store.db.prepare('PRAGMA cache_size').get().cache_size, mmap_size: newSide.store.db.prepare('PRAGMA mmap_size').get().mmap_size } };
report.equal = failures.length === 0; report.failures = failures.slice(0, 20);
oldSide.store.close(); newSide.store.close(); fs.rmSync(TMP, { recursive: true, force: true });
console.log(JSON.stringify(report, null, 1));
process.exit(failures.length ? 1 : 0);
