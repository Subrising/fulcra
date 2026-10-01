// H6 item 5 (G5): a seat's Orca tool surface is brought up to this release's -- on an operator's request, on a
// reaffirmation and on a handback -- through the daemon's fenced MCP refresh. Nothing is granted by it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { FENCE_PROTOCOL } from './native-fence.mjs';
import { ControlStore } from './store.mjs';
import { Controller } from './controller.mjs';
import { Bindings } from './bindings.mjs';
import { RoleChannels } from './role-channels.mjs';
import { RoleSessions } from './role-sessions.mjs';
import { COMPANY, PROGRAMME } from './authority.mjs';
import { rpc } from './rpc.mjs';
import { ROLE_TOOLS } from './grant-file.mjs';
import { CONTROLLER_HOME } from './installation-settings.mjs';
import { ToolSurfaces } from './tool-refresh.mjs';
import { HostNative } from './host-native.mjs';
import { supervisorServer, toolPolicy, TOOL_SURFACE, INBOX, refreshToolsFor, ToolRefreshUnsupported } from './tool-surface.mjs';

const P = n => `22222222-2222-4222-8222-${String(n).padStart(12, '0')}`;
const T = n => `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`;
const issue = id => ({ id, companyId: COMPANY, parentId: id === PROGRAMME ? null : PROGRAMME, assigneeUserId: 'local-board', assigneeAgentId: null, status: 'in_progress' });
const noVerify = () => {};

// ---------------------------------------------------------------- the surface itself
test('the creation surface is exactly the pre-H6 one, and it carries the G7/G8 tools', () => {
  const m = randomUUID(), s = supervisorServer(m);
  assert.deepEqual(s.args, [INBOX]); assert.equal(path.basename(INBOX), 'inbox.mjs'); assert.equal(s.type, 'stdio');
  assert.deepEqual(Object.keys(s.env).filter(k => k !== 'ORCA_HOME'), ['ORCA_INBOX_FILE', 'ORCA_MANAGER_FILE', 'ORCA_ROLE_FILE']);
  for (const [k, lane] of [['ORCA_INBOX_FILE', 'inbox'], ['ORCA_MANAGER_FILE', 'manager'], ['ORCA_ROLE_FILE', 'role']]) assert.equal(s.env[k], `${CONTROLLER_HOME}/grants/${lane}/${m}.json`);
  const names = toolPolicy().preapproved.map(p => `${p.server}/${p.tool}`);
  // The order native.create used before this refactor: manager 4, inbox 2, every role tool, memory 2.
  assert.deepEqual(names, [...['manager_workers', 'manager_create_worker', 'manager_inspect_worker', 'manager_assign_worker', 'supervisor_inbox', 'supervisor_acknowledge'].map(t => 'orca-supervisor/' + t),
    ...ROLE_TOOLS.map(t => 'orca-supervisor/' + t), 'orca-canonical/shared_memory_search', 'orca-canonical/shared_memory_read']);
  assert.ok(names.includes('orca-supervisor/role_inspect_session') && names.includes('orca-supervisor/role_send_session'));
  assert.equal(toolPolicy({ memory: false }).preapproved.some(p => p.server === 'orca-canonical'), false);
  assert.match(TOOL_SURFACE, /^[0-9a-f]{16}$/);
  const native = fs.readFileSync(new URL('./native.mjs', import.meta.url), 'utf8');
  assert.match(native, /\[SUPERVISOR_SERVER\]: supervisorServer\(a\.messageId\)/, 'native.create uses the one definition');
  assert.match(native, /toolPolicy: toolPolicy\(\) \}/); assert.match(native, /toolSurface: TOOL_SURFACE/);
});
function fakeAgent({ state = { provider: 'claude', sessionId: 'prov-1', configRevision: 'rev-7', lifecycle: 'idle', supported: true, mcpServerNames: ['orca-supervisor', 'orca-canonical'] }, result = { outcome: 'refreshed', reason: null } } = {}) {
  const calls = [];
  return { calls, getMcpRefreshState: async () => state, refreshMcp: async input => { calls.push(input); return { ...result, state }; } };
}
test('refreshToolsFor sends one fenced refresh: the daemon’s own expectation, the supervisor entry only, and the full policy', async () => {
  const m = randomUUID(), agent = fakeAgent(); let verified = 0;
  const out = await refreshToolsFor(agent, m, () => verified++);
  assert.deepEqual(out, { outcome: 'refreshed', surface: TOOL_SURFACE }); assert.equal(verified, 2, 'activation verified before and after');
  const [input] = agent.calls;
  assert.deepEqual(input.expected, { provider: 'claude', sessionId: 'prov-1', configRevision: 'rev-7' });
  assert.deepEqual(Object.keys(input.changes), ['orca-supervisor'], 'every other server is preserved (omitted)');
  assert.deepEqual(input.changes['orca-supervisor'], supervisorServer(m)); assert.deepEqual(input.toolPolicy, toolPolicy());
  const noMemory = fakeAgent({ state: { provider: 'codex', sessionId: 'p', configRevision: 'r', lifecycle: 'idle', supported: true, mcpServerNames: ['orca-supervisor'] } });
  await refreshToolsFor(noMemory, m, noVerify);
  assert.deepEqual(noMemory.calls[0].toolPolicy, toolPolicy({ memory: false }), 'no preapproval for a server the session does not have');
});
test('refreshToolsFor refuses clearly: a pinned SDK without the API, an unsupported session, a daemon refusal', async () => {
  await assert.rejects(refreshToolsFor({ current: () => null }, randomUUID(), noVerify), e => e instanceof ToolRefreshUnsupported && /pinned controller client SDK predates agent MCP refresh/.test(e.message));
  await assert.rejects(refreshToolsFor(fakeAgent({ state: { provider: 'claude', sessionId: null, configRevision: 'r', lifecycle: 'closed', supported: false, mcpServerNames: [] } }), randomUUID(), noVerify), /cannot refresh its MCP servers in place \(lifecycle closed\)/);
  await assert.rejects(refreshToolsFor(fakeAgent({ result: { outcome: 'refused', reason: 'busy' } }), randomUUID(), noVerify), /refused the tool refresh \(busy\)/);
  await assert.rejects(refreshToolsFor({ getMcpRefreshState: async () => null, refreshMcp: async () => ({}) }, randomUUID(), noVerify), /does not hold this session/);
  const sdk = await import('./client-sdk.mjs');
  assert.equal(typeof sdk.createPaseoApi, 'function');
  assert.equal(typeof sdk.DaemonClient, 'function');
  assert.match(fs.readFileSync(new URL('./client-sdk.mjs', import.meta.url), 'utf8'), /@getpaseo\/client/);
});

// ---------------------------------------------------------------- the controller
function fixture(t, { refresh } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orca-tool-surface-')));
  const store = new ControlStore(path.join(dir, 'journal.sqlite'));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const refreshed = [], states = new Map();
  const native = { route: () => undefined,
    create: async a => ({ id: randomUUID(), cwd: path.join(dir, a.messageId), managerToolsVersion: '1', roleToolsVersion: '1', toolSurface: TOOL_SURFACE }),
    inspect: async id => ({ boot: 'fixture', fenceProtocol: FENCE_PROTOCOL, saturated: false, humanAt: 0, status: 'idle', pending: 0, lastPromptId: null, ...(states.get(id) ?? {}) }),
    send: async () => {},
    refreshTools: refresh ?? (async (id, messageId) => { refreshed.push({ id, messageId }); return { outcome: 'refreshed', surface: TOOL_SURFACE }; }) };
  const control = new Controller({ store, native, authority: async id => issue(id) });
  const source = { value: { observedAt: '2026-09-19T00:00:00.000Z', available: true, partial: false, projects: [{ id: P(1), name: 'One', description: null, status: 'in_progress' }],
    membership: [{ taskId: T(1), projectId: P(1) }], note: 'test project source' } };
  control.bindings = new Bindings(control, async () => source.value, path.join(dir, 'grants', 'role'));
  control.channels = new RoleChannels(control, () => Date.now()); control.roleSessions = new RoleSessions(control); control.tools = new ToolSurfaces(control);
  // Enrolled the way a pre-H6 session was: its creation recorded no tool surface. cwd basename = its creation messageId.
  const enrol = task => { const id = randomUUID(), m = randomUUID(); store.created(id, task, path.join(dir, m)); return { id, messageId: m }; };
  const seat = (id, revision = 0) => control.bindings.assign({ role: 'project-orchestrator', seat: P(1), sessionId: id, expectedSessionGeneration: store.get(id).generation, expectedRevision: revision, note: 'Seating for the tool surface verification' });
  return { dir, store, control, refreshed, states, enrol, seat, request: rpc(control, 'test-operator'), delegate: id => control.handback(id, 'Delegated for the tool surface verification') };
}
test('an operator refreshes a pre-H6 seat’s tools; it is recorded current and the status stops asking for it', async t => {
  const f = fixture(t), lead = f.enrol(T(1));
  await f.seat(lead.id); await f.delegate(lead.id); await f.control.tools.pending; f.refreshed.length = 0;
  f.store.db.exec('DELETE FROM session_tool_surfaces');   // back to a pre-H6 seat for the operator route
  assert.equal((await f.request({ method: 'sessions-tool-surface', operator: 'test-operator', input: { sessionId: lead.id } })).state, 'unrecorded');
  const before = (await f.request({ method: 'bindings-activation', operator: 'test-operator' })).sessions.find(s => s.sessionId === lead.id);
  assert.ok(before.needs.includes('tool-surface-refresh')); assert.equal(before.toolSurface.state, 'unrecorded');
  const out = await f.request({ method: 'sessions-refresh-tools', operator: 'test-operator', input: { sessionId: lead.id, expectedGeneration: f.store.get(lead.id).generation } });
  assert.deepEqual([out.outcome, out.surface, out.previousState, out.cause, out.grantsAuthority], ['refreshed', TOOL_SURFACE, 'unrecorded', 'operator', false]);
  assert.deepEqual(f.refreshed, [{ id: lead.id, messageId: lead.messageId }], 'the session’s own creation identity names its grant paths');
  const after = (await f.request({ method: 'bindings-activation', operator: 'test-operator' })).sessions.find(s => s.sessionId === lead.id);
  assert.equal(after.toolSurface.state, 'current'); assert.equal(after.needs.includes('tool-surface-refresh'), false);
});
test('the operator route refuses a human-held session, a stale generation, and records a failure without claiming the surface', async t => {
  const failing = fixture(t, { refresh: async () => { throw Error('The daemon refused the tool refresh (busy)'); } }), lead = failing.enrol(T(1));
  await failing.seat(lead.id);
  await assert.rejects(failing.request({ method: 'sessions-refresh-tools', operator: 'test-operator', input: { sessionId: lead.id, expectedGeneration: failing.store.get(lead.id).generation } }), /needs the session under delegated control/);
  await failing.delegate(lead.id); await failing.control.tools.pending;
  await assert.rejects(failing.request({ method: 'sessions-refresh-tools', operator: 'test-operator', input: { sessionId: lead.id, expectedGeneration: 1 } }), /Control changed/);
  await assert.rejects(failing.request({ method: 'sessions-refresh-tools', operator: 'test-operator', input: { sessionId: lead.id, expectedGeneration: failing.store.get(lead.id).generation } }), /busy/);
  const d = failing.control.tools.describe(lead.id);
  assert.equal(d.state, 'unrecorded', 'a failed refresh claims nothing'); assert.equal(d.lastAttempt.outcome, 'failed'); assert.match(d.lastAttempt.reason, /^operator: .*busy/);
  await assert.rejects(failing.request({ method: 'sessions-refresh-tools', capability: 'x', input: { sessionId: lead.id, expectedGeneration: 2 } }), /Operator authorization required|Unknown|capability/i, 'operator-only');
});
test('a handback of a seat holder brings its tools up to date automatically; a non-seat session is left alone', async t => {
  const f = fixture(t), lead = f.enrol(T(1)), plain = f.enrol(T(1));
  await f.seat(lead.id);
  await f.delegate(lead.id); await f.control.tools.pending;
  assert.deepEqual(f.refreshed.map(r => r.id), [lead.id]); assert.equal(f.control.tools.describe(lead.id).state, 'current');
  assert.match(f.control.tools.describe(lead.id).lastAttempt.reason, /^handback$/);
  await f.delegate(plain.id); await f.control.tools.pending;
  assert.deepEqual(f.refreshed.map(r => r.id), [lead.id], 'an ordinary session is not refreshed');
  // Already current: a later handback does nothing.
  f.control.takeover(lead.id, 'Take over and hand back again'); await f.delegate(lead.id); await f.control.tools.pending;
  assert.equal(f.refreshed.length, 1);
});
test('a failing automatic refresh never fails the handback, and is reported', async t => {
  const f = fixture(t, { refresh: async () => { throw Error('The pinned controller client SDK predates agent MCP refresh'); } }), lead = f.enrol(T(1));
  await f.seat(lead.id);
  const grant = await f.delegate(lead.id); await f.control.tools.pending;
  assert.equal(f.store.get(lead.id).mode, 'delegated'); assert.ok(grant.capability);
  const d = f.control.tools.describe(lead.id); assert.equal(d.state, 'unrecorded'); assert.match(d.lastAttempt.reason, /^handback: .*predates/);
});
test('a reaffirmation of a delegated seat refreshes its tools and reports it; a current or human-held seat is not touched', async t => {
  const f = fixture(t), lead = f.enrol(T(1));
  await f.seat(lead.id); await f.delegate(lead.id); await f.control.tools.pending;
  f.store.db.exec('DELETE FROM session_tool_surfaces'); f.refreshed.length = 0;
  const again = await f.seat(lead.id, 1);
  assert.equal(again.action, 'reaffirm'); assert.equal(again.toolSurface.outcome, 'refreshed'); assert.equal(again.toolSurface.cause, 'reaffirm');
  const current = await f.seat(lead.id, 2); assert.equal(current.toolSurface.outcome, 'not-needed'); assert.equal(current.toolSurface.state, 'current');
  f.control.takeover(lead.id, 'The human takes the seat holder over'); f.store.db.exec('DELETE FROM session_tool_surfaces');
  const human = await f.seat(lead.id, 3); assert.equal(human.toolSurface.outcome, 'not-needed'); assert.equal(human.toolSurface.state, 'unrecorded');
  assert.equal(f.refreshed.length, 1, 'refreshed once: a human-held seat is refreshed at its next handback instead');
});
test('a reaffirmation whose refresh fails still reaffirms, and says why the tools were not refreshed', async t => {
  const f = fixture(t, { refresh: async () => { throw Error('The daemon refused the tool refresh (busy)'); } }), lead = f.enrol(T(1));
  await f.seat(lead.id); await f.delegate(lead.id); await f.control.tools.pending;
  const again = await f.seat(lead.id, 1);
  assert.equal(again.action, 'reaffirm'); assert.equal(again.revision, 2); assert.equal(again.toolSurface.outcome, 'failed'); assert.match(again.toolSurface.reason, /busy/);
});
test('a session created by this release records its surface and needs no refresh', async t => {
  const f = fixture(t), messageId = randomUUID();
  const created = await f.control.create({ messageId, taskId: T(1), provider: 'claude', title: 'Born on the current surface' });
  const result = f.store.delivery(messageId).result; assert.equal((typeof result === 'string' ? JSON.parse(result) : result).toolSurface, TOOL_SURFACE);
  assert.equal(f.control.tools.describe(created.result.id).state, 'current');
});
test('only a local session\u2019s tools are refreshed here; a Book (remote) session is refused before anything is sent', async t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orca-tool-surface-host-'))), store = new ControlStore(path.join(dir, 'journal.sqlite'));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const calls = [], native = new HostNative({ store, book: async () => assert.fail('nothing reaches the Book host'), local: { refreshTools: async (id, m) => { calls.push([id, m]); return { outcome: 'refreshed', surface: TOOL_SURFACE }; } } });
  const local = randomUUID(), remote = randomUUID();
  native.db.prepare("INSERT INTO host_routes(id,request,host,creation,agent,cwd,phase,generation,binding) VALUES (?,?,'macbook','{}',?,'/book/owned','active',1,NULL)").run(remote, randomUUID(), randomUUID());
  assert.equal((await native.refreshTools(local, 'm')).outcome, 'refreshed');
  await assert.rejects(native.refreshTools(remote, 'm'), /remote \(Book\) session are refreshed on its own host/);
  assert.deepEqual(calls, [[local, 'm']]);
});
test('REVIEW-H6 F3 (AT6): a refreshed seat born without the role environment reports it present, and needs no adoption', async t => {
  const f = fixture(t), lead = f.enrol(T(1));
  // A creation receipt from before the role environment (no roleToolsVersion), exactly as a pre-H5 seat has.
  const creation = randomUUID(); f.store.admit(creation, null, 'create', { taskId: T(1) });
  f.store.finish(creation, 'delivered', { id: lead.id, cwd: path.join(f.dir, lead.messageId), mode: 'human', managerToolsVersion: '1' });
  await f.seat(lead.id); f.store.db.exec('DELETE FROM session_tool_surfaces');
  const before = (await f.request({ method: 'bindings-activation', operator: 'test-operator' })).sessions.find(s => s.sessionId === lead.id);
  assert.equal(before.toolEnvironment, 'absent'); assert.ok(before.needs.includes('tool-environment-adoption'));
  await f.delegate(lead.id); await f.control.tools.pending;   // the handback refreshes the seat's surface
  const after = (await f.request({ method: 'bindings-activation', operator: 'test-operator' })).sessions.find(s => s.sessionId === lead.id);
  assert.equal(after.toolSurface.state, 'current'); assert.equal(after.toolEnvironment, 'present'); assert.equal(after.toolEnvironmentAtCreation, 'absent', 'the history is kept');
  assert.equal(after.needs.includes('tool-environment-adoption'), false); assert.equal(after.needs.includes('tool-surface-refresh'), false);
});
