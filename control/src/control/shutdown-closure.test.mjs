// H7b: the host's own shutdown closure is not human input; every close, archive and cancel through the manager is.
//
// The H7 rehearsal (26 Sep) found that a clean host restart wrote one "human input" per loaded agent into the exiting
// boot's log (bootstrap stop() -> prepareForShutdown() -> closeAllAgents -> closeAgent, which staging fenced), so the
// seat sweep revoked every seat after every restart. The exemption is a host-owned CALL PATH (Codex review B1: keyed on
// host state, a client delete admitted before the shutdown and resumed after it lost its fence).
//
// Here the REAL compiled AgentManager (ORCA_MCP_TEST_NATIVE: a pristine dist) is patched by the REAL staging text
// (patchNativeManager), the REAL closeAllAgents is lifted out of the REAL staged bootstrap.js (patchNativeShutdown) into
// a small module, and both run as a short-lived "daemon boot" next to the REAL guard, deployed under a private
// controller home exactly as human-log.fixture.mjs does, so its durable human-input log is the evidence. The seat-sweep
// tests then read that log through the real Controller.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bindGuardHome } from './native-release-hooks.mjs';
import { patchNativeManager, patchNativeShutdown, checkShutdownCloseCallers, checkStagedShutdownClose, SHUTDOWN_CLOSE } from './stage-native-turn.mjs';
import { home, runBoot, humanDir, logLines } from './human-log.fixture.mjs';
import { ControlStore } from './store.mjs';
import { Controller } from './controller.mjs';
import { Bindings } from './bindings.mjs';
import { RoleSessions } from './role-sessions.mjs';
import { FENCE_PROTOCOL } from './native-fence.mjs';
import { sweepSeats, MODE_FILE } from './seat-sweep.mjs';

const source = process.env.ORCA_MCP_TEST_NATIVE;
assert(source && path.isAbsolute(source), 'Set ORCA_MCP_TEST_NATIVE to a PRISTINE compiled server dist (dist/server/server)');
const control = path.dirname(fileURLToPath(import.meta.url));
const pristine = fs.readFileSync(path.join(source, 'agent/agent-manager.js'), 'utf8');
const pristineBootstrap = fs.readFileSync(path.join(source, 'bootstrap.js'), 'utf8');

// A private copy of the compiled package (as claude-deny-boundaries.test.mjs), so the dist it came from is never written.
const pkg = path.resolve(source, '../../..'), root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orca-h7b-')));
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
fs.cpSync(path.join(pkg, 'dist'), path.join(root, 'pkg/dist'), { recursive: true });
fs.copyFileSync(path.join(pkg, 'package.json'), path.join(root, 'pkg/package.json'));
if (fs.existsSync(path.join(pkg, 'node_modules'))) fs.symlinkSync(path.join(pkg, 'node_modules'), path.join(root, 'pkg/node_modules'));
fs.symlinkSync(path.resolve(pkg, '../../node_modules'), path.join(root, 'node_modules'));
const server = path.join(root, 'pkg/dist/server/server');

// The staged patch (manager and bootstrap text), and its mutants:
//   no-exemption     -- the host-owned shutdown close fenced like any close (what the rehearsal saw);
//   flag-exemption   -- the exemption keyed on host STATE instead of the call path (22f5b5e2; Codex review B1);
//   widened          -- archive, cancel and archive-snapshot exempted during shutdown as well;
//   bootstrap-client -- closeAllAgents left on the client path (closeAgent).
const FENCE = 'orcaHumanFence({ id: agentId }, "", undefined, false);';
const SHUTDOWN_BODY = 'if (this.acceptingAgentRegistrations !== false) return this.closeAgent(agentId);\n        return this[ORCA_CLOSE_AGENT](agentId);';
const one = (text, a, b) => { assert.equal(text.split(a).length, 2, 'mutant anchor: ' + a.slice(0, 60)); return text.replace(a, b); };
const variants = {
  fixed: { manager: t => t, bootstrap: t => t },
  'no-exemption': { manager: t => one(t, SHUTDOWN_BODY, 'return this.closeAgent(agentId);'), bootstrap: t => t },
  'flag-exemption': { manager: t => one(t, `    closeAgent(agentId) {\n        ${FENCE}`, `    closeAgent(agentId) {\n        if (this.acceptingAgentRegistrations !== false) ${FENCE}`), bootstrap: t => t },
  widened: { manager: t => t.replace(/(async (?:archiveAgent|cancelAgentRun|archiveSnapshot)\(agentId(?:, archivedAt)?\) \{\n {8})orcaHumanFence/g, '$1if (this.acceptingAgentRegistrations !== false) orcaHumanFence'), bootstrap: t => t },
  'bootstrap-client': { manager: t => t, bootstrap: t => one(t, `await agentManager[${SHUTDOWN_CLOSE}](agent.id);`, 'await agentManager.closeAgent(agent.id);') },
};
// The REAL staged closeAllAgents (module-private in bootstrap.js), as a module importing the symbol from the manager.
function closeAllModule(bootstrapText, managerUrl) {
  const at = bootstrapText.indexOf('async function closeAllAgents(logger, agentManager) {'); assert(at >= 0, 'closeAllAgents');
  const body = bootstrapText.slice(at, bootstrapText.indexOf('\n}\n', at) + 2);
  return `import { ${SHUTDOWN_CLOSE} } from ${JSON.stringify(managerUrl)};\nexport ${body}`;
}

const CHILD = `
import { createRequire, syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
const cfg = JSON.parse(process.env.H7B_BOOT);
const crypto = createRequire(process.cwd() + '/')('node:crypto');
const original = crypto.randomUUID; let first = true;
crypto.randomUUID = (...a) => { if (first) { first = false; return cfg.boot; } return original(...a); };
syncBuiltinESMExports();
const g = await import(cfg.guard);                                  // the deployed guard: this boot's durable log
const managerModule = await import(cfg.manager);                    // the staged AgentManager, importing that same guard
const { closeAllAgents } = await import(cfg.closeAll);              // bootstrap's staged closeAllAgents
// The parts the close, archive and cancel methods reach, around the REAL methods (the fences are their first statements).
const m = Object.create(managerModule.AgentManager.prototype);
Object.assign(m, { acceptingAgentRegistrations: true, inFlightAgentCloses: new Map(), agents: new Map(cfg.agents.map(id => [id, { id }])),
  listAgents: () => [...m.agents.values()], runLifecycleMutation: async (_id, fn) => fn(), runForegroundMutation: async (_id, fn) => fn(),
  closeAgentRuntime: async id => { m.agents.delete(id); } });
const logger = { error() {} };
// Codex review B1: a client delete admitted BEFORE the shutdown, parked on its storage read (session.js
// handleDeleteAgentRequest awaits agentStorage.get, then closeAgentCommand -> closeAgent), resumed AFTER it.
let release = null, parked = null;
for (const [act, id] of cfg.actions) {
  if (act === 'shutdown') { m.prepareForShutdown(); continue; }
  if (act === 'closeAll') { await closeAllAgents(logger, m); continue; }
  if (act === 'admitDelete') { const read = new Promise(r => { release = r; }); parked = (async () => { await read; await m.closeAgent(id); })(); continue; }
  if (act === 'resumeDelete') { release(); await parked; continue; }
  const call = { close: () => m.closeAgent(id), archive: () => m.archiveAgent(id), cancel: () => m.cancelAgentRun(id),
    archiveSnapshot: () => m.archiveSnapshot(id, new Date().toISOString()), shutdownClose: () => m[managerModule.${SHUTDOWN_CLOSE}](id) }[act];
  try { await call(); } catch {}                      // past the fence the stand-in manager may throw; the fence has run
}
fs.writeFileSync(cfg.result, JSON.stringify({ boot: g.BOOT, humanAt: Object.fromEntries(cfg.agents.map(id => [id, g.observation(id).humanAt])) }));
`;

let staged = 0;
// One host boot of the staged manager under controller home h. Returns the boot's human-input records.
function hostBoot(h, { boot = randomUUID(), agents, actions, variant = 'fixed' }) {
  const dir = path.join(h, 'admission', `h7b-${process.pid}-${++staged}`), guards = path.join(dir, 'control');
  fs.mkdirSync(guards, { recursive: true, mode: 0o700 });
  const active = path.join(h, 'admission', 'active.json');
  if (!fs.existsSync(active)) fs.writeFileSync(active, JSON.stringify({ base: '', after: {} }), { mode: 0o600 });
  // The controller files staging deploys beside the guard (stageNativeTurn), and the config authority.mjs imports.
  fs.writeFileSync(path.join(guards, 'admission-guard.mjs'), bindGuardHome(fs.readFileSync(path.join(control, 'admission-guard.mjs'), 'utf8'), h), { mode: 0o600 });
  for (const name of ['native-turn.mjs', 'quota-wait.mjs', 'authority.mjs']) fs.copyFileSync(path.join(control, name), path.join(guards, name));
  fs.copyFileSync(path.join(control, '../portable-config.mjs'), path.join(dir, 'portable-config.mjs'));
  const manager = path.join(server, `agent/agent-manager.h7b-${staged}.js`), closeAll = path.join(server, `bootstrap-close-all.h7b-${staged}.js`);
  fs.writeFileSync(manager, variants[variant].manager(patchNativeManager(pristine, { journalFile: path.join(h, 'journal.sqlite'), guards })));
  fs.writeFileSync(closeAll, closeAllModule(variants[variant].bootstrap(patchNativeShutdown(pristineBootstrap)), pathToFileURL(manager).href));
  const result = path.join(dir, 'result.json');
  const cfg = { boot, agents, actions, result, guard: pathToFileURL(path.join(guards, 'admission-guard.mjs')).href, manager: pathToFileURL(manager).href, closeAll: pathToFileURL(closeAll).href };
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD], { env: { ...process.env, H7B_BOOT: JSON.stringify(cfg) }, encoding: 'utf8' });
  let out = null; try { out = JSON.parse(fs.readFileSync(result, 'utf8')); } catch {}
  if (!out || out.boot !== boot || run.status !== 0) throw Error(`Staged host boot did not run: status=${run.status} ${run.stderr}`);
  const lines = logLines(h, boot);
  assert.deepEqual(lines.at(-1), { end: 'exit', code: 0 }, 'the boot ended through the exit seal');
  return { boot, humanAt: out.humanAt, records: lines.filter(l => 'a' in l).map(l => l.a) };
}
const ids = n => Array.from({ length: n }, () => randomUUID());

test('H7b 1: a clean host shutdown (prepareForShutdown, then the staged closeAllAgents) writes no human-input record', t => {
  const h = home(t, 'orca-h7b-'), agents = ids(4);
  const r = hostBoot(h, { agents, actions: [['shutdown'], ['closeAll']] });
  assert.deepEqual(r.records, [], 'no human-input record from the host’s own closure');
  assert.deepEqual(Object.values(r.humanAt), [0, 0, 0, 0], 'and no in-memory human input either');
  // Outside a shutdown the host-owned path is exactly closeAgent: fenced.
  const [y] = ids(1);
  assert.deepEqual(hostBoot(h, { agents: [y], actions: [['shutdownClose', y]] }).records, [y]);
});

test('H7b 1b: the pristine product still shuts down in the order staging requires (static)', () => {
  const stop = pristineBootstrap.slice(pristineBootstrap.indexOf('const stop = async () => {'));
  const i = s => { const at = stop.indexOf(s); assert(at >= 0, 'bootstrap stop() lacks ' + s); return at; };
  assert(i('wsServer?.prepareForShutdown();') < i('agentManager.prepareForShutdown();'), 'client ingress is frozen first');
  assert(i('agentManager.prepareForShutdown();') < i('await closeAllAgents(logger, agentManager);'), 'the host is marked shutting down before the closure');
});

test('H7b 2: every close, archive and cancel through the manager is human input, before AND during shutdown', t => {
  const h = home(t, 'orca-h7b-'), [a, b, c, d, e, f, g, x] = ids(8);
  const r = hostBoot(h, { agents: [a, b, c, d, e, f, g, x], actions: [['close', a], ['archive', b], ['cancel', c], ['archiveSnapshot', d],
    ['shutdown'], ['archive', e], ['cancel', f], ['archiveSnapshot', g], ['close', x]] });
  assert.deepEqual(r.records, [a, b, c, d, e, f, g, x], 'all four before the shutdown and all four during it; only the host-owned path is exempt');
  assert.deepEqual([a, b, c, d, e, f, g, x].map(id => r.humanAt[id]), [1, 1, 1, 1, 1, 1, 1, 1]);
});

test('H7b 2b (Codex review B1): a client delete admitted before the shutdown and resumed after it is recorded exactly once', t => {
  const h = home(t, 'orca-h7b-'), [x, other] = ids(2);
  // Admitted and parked on its storage read; the host then flips its flag and closes everything; the read resumes.
  const r = hostBoot(h, { agents: [x, other], actions: [['admitDelete', x], ['shutdown'], ['closeAll'], ['resumeDelete']] });
  assert.deepEqual(r.records, [x], 'exactly one fence call: the client’s delete; none for the host’s closure');
  assert.equal(r.humanAt[x], 1); assert.equal(r.humanAt[other], 0);
});

// The seat-sweep fixture's shape (seat-sweep.test.mjs): the real Controller, Bindings and store; native reports what a
// quiescent, untouched session looks like at the current boot.
async function seatAndTeam(t) {
  const h = home(t, 'orca-h7b-sweep-'), store = new ControlStore(path.join(h, 'journal.sqlite'));
  t.after(() => store.close());
  const P = '22222222-2222-4222-8222-000000000001', T = '33333333-3333-4333-8333-000000000001', COMPANY = '11111111-1111-4111-8111-000000000001', PROGRAMME = '44444444-4444-4444-8444-000000000001';
  let boot = randomUUID();
  const native = { route: () => undefined, inspect: async () => ({ boot, fenceProtocol: FENCE_PROTOCOL, saturated: false, humanAt: 0, status: 'idle', pending: 0, lastPromptId: null, lastUserAt: null, archivedAt: null }) };
  const control = new Controller({ store, native, humanLogDir: humanDir(h),
    authority: async id => ({ id, companyId: COMPANY, parentId: id === PROGRAMME ? null : PROGRAMME, assigneeUserId: 'local-board', assigneeAgentId: null, status: 'in_progress' }) });
  control.bindings = new Bindings(control, async () => ({ observedAt: '2026-09-26T00:00:00.000Z', available: true, partial: false,
    projects: [{ id: P, name: 'P', description: null, status: 'in_progress' }], membership: [{ taskId: T, projectId: P }], note: 'test project source' }), path.join(h, 'grants', 'role'));
  control.roleSessions = new RoleSessions(control);
  const holder = randomUUID(), worker = randomUUID();
  store.created(holder, T, path.join(h, holder)); store.created(worker, T, path.join(h, worker));
  await control.bindings.assign({ role: 'project-orchestrator', seat: P, sessionId: holder, expectedSessionGeneration: store.get(holder).generation, expectedRevision: 0, note: 'Owns delivery of this project' });
  await control.handback(holder, 'Delegated before the host restart'); await control.handback(worker, 'The seat’s worker, delegated before the host restart');
  // The worker is one the seat started (session_ownership + its create delivery), so the sweep takes it as the seat's team.
  const request = randomUUID();
  store.db.prepare("INSERT INTO session_ownership VALUES (?,?,?,'project-orchestrator','project-orchestrator',?,1,?,?)").run(request, P, T, P, holder, new Date().toISOString());
  store.db.prepare("INSERT INTO deliveries VALUES (?,NULL,'create','{}','delivered',?)").run(request, JSON.stringify({ id: worker }));
  fs.writeFileSync(path.join(h, MODE_FILE), 'on', { mode: 0o600 });
  return { h, store, control, holder, worker, grantBoot: boot, restart: next => { boot = next; }, sweep: () => sweepSeats(control, { home: h, currentBoot: () => boot }) };
}
async function restartWithSweep(t, variant) {
  const f = await seatAndTeam(t);
  // Boot A: the grant boot. The host shuts down cleanly, closing both sessions (and one unrelated agent).
  const A = hostBoot(f.h, { boot: f.grantBoot, agents: [f.holder, f.worker, randomUUID()], actions: [['shutdown'], ['closeAll']], variant });
  const B = randomUUID(); runBoot(f.h, { boot: B }); f.restart(B);   // boot B anchors A
  const out = await f.sweep();
  const row = id => out.results.find(r => r.id === id) ?? null, mode = id => f.store.get(id).mode;
  return { f, A, out, holder: row(f.holder), worker: row(f.worker), modes: [mode(f.holder), mode(f.worker)] };
}

test('H7b 3: after a clean host restart with the sweep ON, the seat and its team are re-established, not revoked', async t => {
  const r = await restartWithSweep(t, 'fixed');
  assert.deepEqual(r.A.records, []);
  assert.equal(r.out.mode, 'on');
  assert.equal(r.holder?.reestablished, true, JSON.stringify(r.out.results));
  assert.equal(r.worker?.reestablished, true, JSON.stringify(r.out.results));
  assert.deepEqual(r.modes, ['delegated', 'delegated']);
});

test('H7b 3b: the same restart on the unexempted host is what the rehearsal saw: the seat is revoked, its team declined', async t => {
  const r = await restartWithSweep(t, 'no-exemption');
  assert.equal(r.A.records.length, 3);
  // A refused seat is reported as {id, error} and taken over; its team is no longer a delegated seat's, so it is declined.
  assert.match(r.holder?.error ?? '', /A human input reached this session during boot .* after the seat was granted/, JSON.stringify(r.out.results));
  assert.equal(r.modes[0], 'human');
  assert.equal(r.worker?.reestablished, undefined); assert.match(r.worker?.error ?? '', /belongs to no seat’s team|human input reached/, JSON.stringify(r.out.results));
});

test('H7b 4: mutations -- no exemption fails test 1; widening fails test 2; the state-keyed exemption fails the B1 race', t => {
  const h = home(t, 'orca-h7b-mut-');
  const shutdown = variant => hostBoot(h, { agents: ids(3), actions: [['shutdown'], ['closeAll']], variant }).records.length;
  assert.equal(shutdown('no-exemption'), 3, 'no-exemption would fail test 1');
  assert.equal(shutdown('bootstrap-client'), 3, 'closeAllAgents on the client path would fail test 1');
  const [a, e, f, g, x] = ids(5);
  const widened = hostBoot(h, { agents: [a, e, f, g, x], actions: [['close', a], ['shutdown'], ['archive', e], ['cancel', f], ['archiveSnapshot', g], ['close', x]], variant: 'widened' });
  assert.deepEqual(widened.records, [a, x], 'widened drops the shutdown-time archive, cancel and archive-snapshot: test 2 would fail');
  const [y, z] = ids(2);
  const race = hostBoot(h, { agents: [y, z], actions: [['admitDelete', y], ['shutdown'], ['closeAll'], ['resumeDelete']], variant: 'flag-exemption' });
  assert.deepEqual(race.records, [], 'the state-keyed exemption (22f5b5e2) loses the admitted client delete: test 2b would fail');
});

test('H7b: staging refuses a product whose shutdown shape moved, and any other caller of the host-owned close', () => {
  const at = { journalFile: '/private/j.sqlite', guards: '/private/g' };
  assert.throws(() => patchNativeManager(pristine.replace('this.acceptingAgentRegistrations = false;', 'this.acceptingAgentRegistrations = !1;'), at), /Native shutdown anchor changed/);
  assert.throws(() => patchNativeManager(pristine.replace('prepareForShutdown() {', 'prepareForShutdown() {\n        this.acceptingAgentRegistrations = false;\n    }\n    prepareForShutdownTwice() {'), at), /Native shutdown anchor changed/);
  const out = patchNativeManager(pristine, at);
  assert.equal(out.split(FENCE).length, 5, 'four unconditional fences: close, archive, cancel, archive-snapshot');
  assert.equal(out.includes('!== false) orcaHumanFence'), false, 'no fence is keyed on host state');
  // bootstrap: the stop() order, a single closeAllAgents call, and its body are all staging anchors.
  const swap = pristineBootstrap.replace('        agentManager.prepareForShutdown();\n        await closeAllAgents(logger, agentManager);\n', '        await closeAllAgents(logger, agentManager);\n        agentManager.prepareForShutdown();\n');
  assert.notEqual(swap, pristineBootstrap); assert.throws(() => patchNativeShutdown(swap), /stop\(\) order/);
  assert.throws(() => patchNativeShutdown(pristineBootstrap.replace('        await closeAllAgents(logger, agentManager);\n', '        await closeAllAgents(logger, agentManager);\n        await closeAllAgents(logger, agentManager);\n')), /called once/);
  assert.throws(() => patchNativeShutdown(pristineBootstrap.replace('            await agentManager.closeAgent(agent.id);\n', '            await agentManager.archiveAgent(agent.id);\n')), /closeAllAgents|closure call/);
  const staged = patchNativeShutdown(pristineBootstrap), files = { 'agent/agent-manager.js': out, 'bootstrap.js': staged, 'session.js': fs.readFileSync(path.join(source, 'session.js'), 'utf8') };
  checkShutdownCloseCallers(files);
  assert.throws(() => checkShutdownCloseCallers({ ...files, 'session.js': files['session.js'] + `\nagentManager[${SHUTDOWN_CLOSE}](id);` }), /named outside closeAllAgents: agent\/agent-manager.js, bootstrap.js, session.js/);
  assert.throws(() => checkShutdownCloseCallers({ ...files, 'bootstrap.js': staged + `\nawait agentManager[${SHUTDOWN_CLOSE}](x);` }), /exactly one definition and one call/);
  // The whole-dist scan stageNativeTurn runs: every .js file of the pristine dist, with the two staged files in place.
  const pair = { 'agent/agent-manager.js': out, 'bootstrap.js': staged };
  assert(checkStagedShutdownClose(source, pair) > 100, 'the scan reads the whole server dist');
  assert.throws(() => checkStagedShutdownClose(source, { ...pair, 'agent/agent-prompt.js': fs.readFileSync(path.join(source, 'agent/agent-prompt.js'), 'utf8') + `\n// ${SHUTDOWN_CLOSE}` }), /named outside closeAllAgents/);
  assert.throws(() => checkStagedShutdownClose(source, { 'agent/agent-manager.js': out }), /named outside closeAllAgents/, 'a staged manager without the staged bootstrap is refused');
});
