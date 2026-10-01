// H6 item 3: controller instrumentation (metrics.mjs). Per-RPC lines, SQLite attribution, bounded rotation, the
// event-loop sampler, and what a line must never carry.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlStore } from './store.mjs';
import { MetricsLog, instrumentDb, timedDispatch, startLoopSampler, methodName } from './metrics.mjs';
import { rpc, RPC_METHODS } from './rpc.mjs';

const scratch = t => { const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orca-metrics-'))); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const sink = () => { const lines = []; return { lines, stream: { write: s => lines.push(JSON.parse(s)) } }; };
const busy = ms => { const end = Date.now() + ms; while (Date.now() < end); };

test('each RPC logs one timestamped line with its method, queue wait, handler time and its OWN SQLite time', async t => {
  const dir = scratch(t), store = instrumentDb(new ControlStore(path.join(dir, 'journal.sqlite'))); t.after(() => store.close());
  const { lines, stream } = sink(), log = new MetricsLog({ file: path.join(dir, 'nope.log'), stream }), counter = { rpcs: 0 };
  // Two requests interleave at an await; only the first does SQLite work. Attribution must not bleed across.
  const dispatch = timedDispatch(async r => {
    if (r.method === 'heavy') { for (let i = 0; i < 200; i++) store.db.prepare('SELECT count(*) n FROM deliveries').get(); await new Promise(res => setTimeout(res, 5)); store.db.exec('SELECT 1'); return 'heavy'; }
    await new Promise(res => setTimeout(res, 2)); return 'light';
  }, log, counter, new Set(['heavy', 'light']));
  const [a, b] = await Promise.all([dispatch({ method: 'heavy' }, { acceptedAt: 10, receivedAt: 13.5 }), dispatch({ method: 'light' })]);
  assert.deepEqual([a, b], ['heavy', 'light']);
  const heavy = lines.find(l => l.rpc === 'heavy'), light = lines.find(l => l.rpc === 'light');
  assert.ok(Date.parse(heavy.t) > 0, 'timestamped');
  assert.equal(heavy.ok, true); assert.equal(heavy.queueMs, 3.5); assert.ok(heavy.handlerMs >= 5);
  assert.equal(heavy.sqliteCalls, 401, '200 prepares + 200 gets + 1 exec');
  assert.ok(heavy.sqliteMs > 0);
  assert.equal(light.sqliteCalls, 0, 'the interleaved request is not charged for the other one’s SQLite work'); assert.equal(light.sqliteMs, 0); assert.equal(light.queueMs, null);
  assert.equal(counter.rpcs, 2);
});
test('the store works unchanged through the instrumented connection: statements, transactions, rollback', async t => {
  const dir = scratch(t), store = instrumentDb(new ControlStore(path.join(dir, 'journal.sqlite'))); t.after(() => store.close());
  assert.equal(instrumentDb(store), store, 'instrumenting twice is a no-op');
  const id = randomUUID(); store.created(id, randomUUID(), path.join(dir, id));
  assert.equal(store.get(id).mode, 'human');
  assert.throws(() => store.atomic(() => { store.db.prepare("INSERT INTO deliveries VALUES (?,NULL,'x','{}','delivered',NULL)").run(randomUUID()); throw Error('boom'); }), /boom/);
  assert.equal(store.db.prepare('SELECT count(*) n FROM deliveries').get().n, 0, 'the rollback still rolls back');
  assert.deepEqual([...store.db.prepare('SELECT 1 AS one').iterate()].map(r => ({ ...r })), [{ one: 1 }]);
});
test('a line never carries input, a capability, the operator secret or error text -- only a class', async t => {
  const { lines, stream } = sink(), log = new MetricsLog({ file: '/nonexistent/x.log', stream });
  const secret = 'S3cr3t-operator-value-that-must-not-leak-xxxxxxxxxxxx';
  const dispatch = timedDispatch(async r => { throw new TypeError(`Refused for ${r.input.text} with ${r.capability}`); }, log, undefined, RPC_METHODS);
  await assert.rejects(dispatch({ method: 'channels-send', input: { text: secret }, capability: secret, operator: secret }), TypeError);
  await assert.rejects(dispatch({ method: 'NOT A METHOD; ' + secret, input: { text: 'x' } }));
  // REVIEW-H6 AT2: a token-shaped value in `method` passes any character pattern; only the closed set stops it.
  const tokenShaped = 'a'.repeat(43), realRpc = rpc({ store: null }, 'op');
  await assert.rejects(timedDispatch(realRpc, log, undefined, RPC_METHODS)({ method: tokenShaped }), /Operator authorization required|Unknown controller method/);
  const text = JSON.stringify(lines);
  assert.ok(!text.includes(secret)); assert.ok(!text.includes('Refused for')); assert.ok(!text.includes(tokenShaped), 'a caller-chosen method string never reaches the log');
  assert.deepEqual(lines.map(l => [l.rpc, l.ok, l.error]), [['channels-send', false, 'TypeError'], ['unknown', false, 'TypeError'], ['unknown', false, 'Error']]);
  assert.equal(methodName(null, RPC_METHODS), 'unknown'); assert.equal(methodName({ method: 'roles-sessions' }), 'unknown', 'no set, no method');
  assert.equal(methodName({ method: 'roles-sessions' }, RPC_METHODS), 'roles-sessions'); assert.equal(methodName({ method: tokenShaped }, RPC_METHODS), 'unknown');
});
test('the log rotates at its bound and keeps a fixed number of old files, when stdout is verified to be the file', t => {
  const dir = scratch(t), file = path.join(dir, 'controller.log');
  fs.writeFileSync(file, 'launchd opened this\n');
  const fd = fs.openSync(file, 'a'); t.after(() => fs.closeSync(fd));
  const log = new MetricsLog({ file, maxBytes: 2000, keep: 2, stdoutFd: fd, stream: { write: () => assert.fail('must not fall back') } });
  assert.equal(log.rotating, true);
  for (let i = 0; i < 200; i++) log.line({ rpc: 'roles-sessions', ok: true, n: i, pad: 'x'.repeat(40) });
  log.close();
  const names = fs.readdirSync(dir).sort();
  assert.deepEqual(names, ['controller.log', 'controller.log.1', 'controller.log.2'], 'exactly keep=2 old files');
  for (const n of names) assert.ok(fs.statSync(path.join(dir, n)).size <= 2000, `${n} is within its bound`);
  const last = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse).at(-1); assert.equal(last.n, 199, 'the newest line is in the current file');
});
test('an unverifiable stdout (not the configured file) falls back to the stream, unrotated', t => {
  const dir = scratch(t), file = path.join(dir, 'controller.log'); fs.writeFileSync(file, '');
  const other = fs.openSync(path.join(dir, 'other.log'), 'a'); t.after(() => fs.closeSync(other));
  const { lines, stream } = sink(), log = new MetricsLog({ file, stdoutFd: other, stream });
  assert.equal(log.rotating, false); log.line({ ready: true });
  assert.equal(lines.length, 1); assert.equal(fs.readFileSync(file, 'utf8'), '', 'nothing written to a file it could not verify');
});
test('the event-loop sampler reports delay percentiles and the RPC count, and resets each window', async t => {
  const { lines, stream } = sink(), log = new MetricsLog({ file: '/nonexistent/x.log', stream }), counter = { rpcs: 7 };
  const stop = startLoopSampler(log, counter, 150); t.after(stop);
  await new Promise(r => setTimeout(r, 20)); busy(120);   // block the loop
  await new Promise(r => setTimeout(r, 400));
  const first = lines.find(l => l.loop);
  assert.ok(first, 'a sample was logged'); assert.equal(first.windowMs, 150);
  assert.ok(lines.some(l => l.loop && l.loop.max >= 80), 'the blocked loop shows in max');
  assert.ok(['p50', 'p99', 'max', 'mean'].every(k => typeof first.loop[k] === 'number'));
  assert.equal(first.rpcs, 7); assert.equal(counter.rpcs, 0, 'reset after each window');
});
test('server.mjs is wired: instrumented store, timed dispatch with socket times, sampler, and no raw stdout lines (static)', () => {
  const src = fs.readFileSync(new URL('./server.mjs', import.meta.url), 'utf8');
  assert.match(src, /store = instrumentDb\(new ControlStore\(/);
  // Merge: V3b's read-only operator lane on this socket (2a2270b4) AND the live lineage's operator-connection.mjs protocol
  // (Track 1: its request timeout no longer cuts off a running handler).
  assert.match(src, /const dispatch = timedDispatch\(rpc\(control, operator, \{ allowOperatorWrites: false \}\), log, counter, RPC_METHODS\)/);
  assert.match(src, /net\.createServer\(operatorConnection\(\{ dispatch, operations,/, 'the timed dispatcher serves the socket');
  const conn = fs.readFileSync(new URL('./operator-connection.mjs', import.meta.url), 'utf8');
  assert.ok(conn.includes("await dispatch(JSON.parse(bytes.subarray(0, end).toString('utf8')), { acceptedAt, receivedAt })"), 'the socket\u2019s accept and receive times reach the dispatcher');
  assert.match(src, /startLoopSampler\(log, counter\)/);
  assert.doesNotMatch(src, /process\.stdout\.write/, 'every controller line goes through the bounded log');
});
