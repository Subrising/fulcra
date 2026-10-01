import test from 'node:test';
import assert from 'node:assert/strict';
import { WORK_MAP_READS, mapSession, workMapOverview, workMapProject } from '../shared/work-map';
import { linkedIssue } from '../shared/linked-issues';
import { allowlisted, boardIssueProvider, createIssueResolver, createWorkMapProjectReader, createWorkMapReader, WorkMapReadRefused } from './work-map';
import type { Fleet } from '../shared/fleet';
import type { ProjectDirectory } from '../shared/projects';

const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const PRIME_S = uuid(1), LEAD_S = uuid(2), CHILD_S = uuid(3), GRAND_S = uuid(4), ADOPT_S = uuid(5), LOOSE_S = uuid(6), STRAY_S = uuid(7);
const TASK_A = uuid(10), TASK_B = uuid(11), TASK_X = uuid(12), PROGRAMME = uuid(13);
const PROJ_1 = uuid(20), PROJ_2 = uuid(21), PROJ_SEAT_ONLY = uuid(22);
const now = () => '2026-09-23T12:00:00.000Z';
const SECRET_CWD = '/Volumes/test-volume/secret-job-directory';
const SECRET_CAP = 'cap_SECRET_delegation_token';
const SECRET_TEXT = 'SECRET channel message body';

const seat = (role: string, seatId: string, sessionId: string | null, extra: Record<string, unknown> = {}) => ({
  role, seat: seatId, projectId: role === 'prime' ? null : seatId, state: sessionId ? 'assigned' : 'vacant', revision: 3,
  task: sessionId ? TASK_A : null, sessionId,
  session: sessionId ? { id: sessionId, task: TASK_A, cwd: SECRET_CWD, mode: role === 'prime' ? 'human' : 'delegated', generation: 2, capability: SECRET_CAP } : null,
  note: 'x'.repeat(900), at: now(), membershipAt: now(), sessionPresent: Boolean(sessionId), sessionGenerationChanged: false, sessionTaskMatches: true,
  dispatch: sessionId ? { host: 'mini', supported: true, phase: null, reason: null, capability: { supported: true, reason: null } } : null,
  grantFile: '/Volumes/test-volume/grants/secret.json', ...extra,
});

const status = (extra: Record<string, unknown> = {}) => ({
  bindings: [seat('prime', 'delivery', PRIME_S), seat('project-orchestrator', PROJ_1, LEAD_S), seat('project-orchestrator', PROJ_SEAT_ONLY, LEAD_S)],
  holds: [{ role: 'prime', seat: 'delivery', revision: 3, session: PRIME_S, note: 'human lead', at: now(), effective: true }],
  history: [], capacity: {}, programme: PROGRAMME, note: 'n', error: null, ...extra,
});

const channels = () => ({
  channels: [{ channelId: uuid(90), primeSeat: 'delivery', projectSeat: PROJ_1, state: 'open', used: 1, maxMessages: 8, grantFile: '/x' }],
  messages: [{ messageId: uuid(91), text: SECRET_TEXT, readNote: SECRET_TEXT, failure: SECRET_TEXT }],
  operatorActs: [],
});

const node = (id: string, task: string, extra: Partial<Fleet['nodes'][number]> = {}): Fleet['nodes'][number] => ({
  id, task, host: 'mini', agentId: id, title: `Session ${id.slice(0, 8)}`, provider: 'claude', model: 'opus', mode: 'delegated',
  status: 'running', pending: 0, observedAt: now(), updatedAt: now(), error: null, ...extra,
});
const fleet = (nodes = [node(LEAD_S, TASK_A), node(CHILD_S, TASK_A, { status: 'idle' }), node(STRAY_S, TASK_X, { pending: 2 })]): Fleet =>
  ({ observedAt: now(), total: nodes.length, partial: false, note: 'n', nodes, tasks: [], edges: [] });

const directory = (available = true): ProjectDirectory => available
  ? { observedAt: now(), available: true, partial: false, note: 'dir',
      projects: [{ id: PROJ_1, name: 'Orca platform', description: null, status: 'in_progress' }, { id: PROJ_2, name: 'LinkedIn and content', description: null, status: 'planned' }],
      membership: [{ taskId: TASK_A, projectId: PROJ_1 }, { taskId: TASK_B, projectId: PROJ_1 }, { taskId: TASK_X, projectId: null }] }
  : { observedAt: now(), available: false, partial: true, note: 'Project directory unavailable', projects: [], membership: [] };

type Calls = string[];
function controller(responses: Record<string, unknown | ((input: unknown) => unknown)>, calls: Calls = []) {
  return async (method: string, input?: unknown) => {
    calls.push(method);
    if (!(method in responses)) throw new Error(`Unknown method ${method}`);
    const r = responses[method];
    if (r instanceof Error) throw r;
    return typeof r === 'function' ? (r as (i: unknown) => unknown)(input) : r;
  };
}

const owner = (ownership: string, extra: Record<string, unknown> = {}) => ({ sessionId: 'x', ownership, creationRequestId: uuid(99), projectId: PROJ_1, declaredBy: 'operator', seat: PROJ_1, seatRole: 'project-orchestrator', parentSession: null, at: now(), leaderChanged: false, currentLeader: LEAD_S, ...extra });
const projection = () => ({
  project: { id: PROJ_1, summary: { id: PROJ_1, name: 'Orca platform', description: 'd', status: 'in_progress' }, membership: { known: true, available: true, partial: false, observedAt: now(), memberTasks: [TASK_A, TASK_B], memberTaskCount: 2, truncated: false, note: 'm' } },
  leader: seat('project-orchestrator', PROJ_1, LEAD_S), primes: [seat('prime', 'delivery', PRIME_S)],
  tasks: [
    { taskId: TASK_A, recorded: 7, unresolved: [{ id: uuid(80) }], byState: {}, truncated: false, sessions: [
      { id: LEAD_S, task: TASK_A, cwd: SECRET_CWD, mode: 'delegated', generation: 2, owner: owner('recorded', { parentSession: PRIME_S }) },
      { id: CHILD_S, task: TASK_A, cwd: SECRET_CWD, mode: 'delegated', generation: 1, owner: owner('recorded', { parentSession: LEAD_S }) },
      { id: GRAND_S, task: TASK_A, cwd: SECRET_CWD, mode: 'human', generation: 3, owner: owner('recorded', { parentSession: CHILD_S, leaderChanged: true }) },
      { id: ADOPT_S, task: TASK_A, cwd: SECRET_CWD, mode: 'delegated', generation: 1, owner: owner('adopted', { parentSession: PRIME_S, adoption: { seat: PROJ_1, leaderSession: LEAD_S, seatRevision: 3, note: 'n', at: now() } }) },
      { id: LOOSE_S, task: TASK_A, cwd: SECRET_CWD, mode: 'delegated', generation: 1, owner: owner('something-new', { parentSession: LEAD_S }) },
    ] },
    { taskId: TASK_B, recorded: 0, unresolved: [], byState: {}, truncated: true, sessions: [] },
  ],
  progress: null,
  needed: [{ kind: 'unowned-session', taskId: TASK_A, sessionId: LOOSE_S, detail: 'This session records no owning project.' }],
  blockers: [{ kind: 'worker-fault', taskId: TASK_A, sessionId: CHILD_S, detail: 'F'.repeat(600), at: now() }],
  decisions: [{ kind: 'role-binding', note: SECRET_TEXT }], coverage: {}, note: 'NO_AUTHORITY',
});
const noIssues = async () => ({ observedAt: now(), providers: [], issues: [], truncated: false });

// ---------- T2: allowlist ----------

test('T2 the allowlist is exactly the three pure reads', () => {
  assert.deepEqual([...WORK_MAP_READS].sort(), ['bindings-project', 'bindings-status', 'channels-status']);
});

test('T2 a method outside the allowlist is refused before anything is sent', async () => {
  const calls: Calls = [];
  const call = allowlisted(controller({ 'bindings-assign': {}, 'channels-thread': {}, 'operator-send': {}, 'seat-hold': {}, 'roles-adopt': {}, 'seat-inbox': {} }, calls));
  for (const method of ['bindings-assign', 'channels-thread', 'operator-send', 'seat-hold', 'roles-adopt', 'seat-inbox', 'observe', 'inspect']) {
    await assert.rejects(call(method), WorkMapReadRefused);
  }
  assert.deepEqual(calls, []);
});

test('T2 one overview poll calls exactly bindings-status and channels-status', async () => {
  const calls: Calls = [];
  const read = createWorkMapReader({ call: controller({ 'bindings-status': status(), 'channels-status': channels() }, calls), fleet: async () => fleet(), projects: async () => directory(), now });
  await read();
  assert.deepEqual([...calls].sort(), ['bindings-status', 'channels-status']);
});

test('T2 one project read calls exactly bindings-project and bindings-status', async () => {
  const calls: Calls = [];
  const read = createWorkMapProjectReader({ call: controller({ 'bindings-project': projection(), 'bindings-status': status() }, calls), fleet: async () => fleet(), issues: noIssues, now });
  await read({ projectId: PROJ_1 });
  assert.deepEqual([...calls].sort(), ['bindings-project', 'bindings-status']);
});

// ---------- T1: nothing sensitive leaves ----------

test('T1 no cwd, capability, grant path or message text reaches either output', async () => {
  const call = controller({ 'bindings-status': status(), 'channels-status': channels(), 'bindings-project': projection() });
  const overview = await createWorkMapReader({ call, fleet: async () => fleet(), projects: async () => directory(), now })();
  const project = await createWorkMapProjectReader({ call, fleet: async () => fleet(), issues: noIssues, now })({ projectId: PROJ_1 });
  for (const out of [overview, project]) {
    const json = JSON.stringify(out);
    for (const secret of [SECRET_CWD, SECRET_CAP, SECRET_TEXT, 'grantFile', '/Volumes/test-volume/grants', '"cwd"', '"capability"', '"text"']) assert.ok(!json.includes(secret), `leaked ${secret}`);
  }
});

test('T1 every output schema is strict: an extra field fails the parse', async () => {
  const call = controller({ 'bindings-status': status(), 'channels-status': channels(), 'bindings-project': projection() });
  const overview = await createWorkMapReader({ call, fleet: async () => fleet(), projects: async () => directory(), now })();
  const project = await createWorkMapProjectReader({ call, fleet: async () => fleet(), issues: noIssues, now })({ projectId: PROJ_1 });
  assert.equal(workMapOverview.safeParse({ ...overview, cwd: SECRET_CWD }).success, false);
  assert.equal(workMapOverview.safeParse({ ...overview, primes: [{ ...overview.primes[0], capability: SECRET_CAP }] }).success, false);
  assert.equal(workMapProject.safeParse({ ...project, text: SECRET_TEXT }).success, false);
  assert.equal(mapSession.safeParse({ ...project.workstreams[0].sessions[0], cwd: SECRET_CWD }).success, false);
  assert.equal(linkedIssue.safeParse({ source: 'board', key: 'A-1', title: 't', state: 'open', rawState: null, assignee: null, url: null, updatedAt: null, linkedTo: { scope: 'workstream', scopeId: TASK_A }, relation: 'is', token: 'x' }).success, false);
});

test('T1 the operator note is shortened for display and worker-fault detail to 200 characters', async () => {
  const call = controller({ 'bindings-status': status(), 'channels-status': channels(), 'bindings-project': projection() });
  const overview = await createWorkMapReader({ call, fleet: async () => fleet(), projects: async () => directory(), now })();
  assert.equal(overview.primes[0].note?.length, 280);
  const project = await createWorkMapProjectReader({ call, fleet: async () => fleet(), issues: noIssues, now })({ projectId: PROJ_1 });
  assert.equal(project.blockers.find(b => b.kind === 'worker-fault')?.detail.length, 200);
  assert.equal(project.needed[0].detail, 'This session records no owning project.');
});

// ---------- T4 (server half): seats, holds, parent links ----------

test('T4 an effective hold marks the prime; a hold row on another revision is only declared', async () => {
  const holds = [{ role: 'prime', seat: 'delivery', revision: 3, session: PRIME_S, effective: true }, { role: 'project-orchestrator', seat: PROJ_1, revision: 1, session: LEAD_S, effective: false }];
  const read = createWorkMapReader({ call: controller({ 'bindings-status': status({ holds }), 'channels-status': channels() }), fleet: async () => fleet(), projects: async () => directory(), now });
  const d = await read();
  assert.equal(d.primes[0].hold, 'effective');
  assert.equal(d.primes[0].session?.mode, 'human');
  assert.equal(d.projects.find(p => p.projectId === PROJ_1)?.seat?.hold, 'declared');
  assert.equal(d.projects.find(p => p.projectId === PROJ_SEAT_ONLY)?.seat?.hold, null);
});

test('T4 an effective hold for an older revision does not mark the current seat held', async () => {
  const holds = [{ role: 'prime', seat: 'delivery', revision: 2, session: PRIME_S, effective: true }];
  const d = await createWorkMapReader({ call: controller({ 'bindings-status': status({ holds }), 'channels-status': channels() }), fleet: async () => fleet(), projects: async () => directory(), now })();
  assert.equal(d.primes[0].hold, 'declared');
});

test('T4 parent links come only from recorded ownership; adoption is its own link; unknown states fail closed', async () => {
  const d = await createWorkMapProjectReader({ call: controller({ 'bindings-project': projection(), 'bindings-status': status() }), fleet: async () => fleet(), issues: noIssues, now })({ projectId: PROJ_1 });
  const s = Object.fromEntries(d.workstreams[0].sessions.map(x => [x.sessionId, x]));
  assert.equal(s[CHILD_S].parentSession, LEAD_S);
  assert.equal(s[GRAND_S].parentSession, CHILD_S);
  assert.equal(s[GRAND_S].leaderChanged, true);
  assert.equal(s[ADOPT_S].ownership, 'adopted');
  assert.equal(s[ADOPT_S].parentSession, null, 'an adopted session has no recorded parent even if the wire carries one');
  assert.equal(s[ADOPT_S].adoptedUnder, LEAD_S);
  assert.equal(s[LOOSE_S].ownership, 'unknown');
  assert.equal(s[LOOSE_S].parentSession, null);
  assert.equal(d.workstreams[0].unresolved, 1);
  assert.equal(d.workstreams[1].truncated, true);
  assert.equal(s[LEAD_S].runtime?.status, 'running');
  assert.equal(s[GRAND_S].runtime, null, 'a session the fleet did not observe has no runtime, not an invented one');
});

// ---------- overview composition and unavailability ----------

test('overview: vacant and seat-less projects need an orchestrator; seat-only projects appear unnamed', async () => {
  const d = await createWorkMapReader({ call: controller({ 'bindings-status': status(), 'channels-status': channels() }), fleet: async () => fleet(), projects: async () => directory(), now })();
  const byId = Object.fromEntries(d.projects.map(p => [p.projectId, p]));
  assert.equal(byId[PROJ_2].seat, null);
  assert.ok(d.attention.some(a => a.kind === 'no-project-orchestrator' && a.projectId === PROJ_2));
  assert.equal(byId[PROJ_SEAT_ONLY].name, null);
  assert.equal(byId[PROJ_SEAT_ONLY].workstreams, null, 'membership of a project the directory does not know is unknown, not zero');
  assert.equal(byId[PROJ_1].workstreams, 2);
  assert.equal(byId[PROJ_1].sessions, 2);
  assert.equal(byId[PROJ_1].running, 1);
  assert.deepEqual(byId[PROJ_1].channels, [{ primeSeat: 'delivery', state: 'open', open: true }]);
  assert.equal(d.projects[0].projectId, PROJ_2, 'projects needing attention sort first');
  assert.deepEqual(d.unplaced.map(u => u.sessionId), [STRAY_S]);
  assert.ok(d.attention.some(a => a.kind === 'pending-permission' && a.sessionId === STRAY_S));
});

test('overview: unreadable seats are unknown, and never reported as projects needing an orchestrator', async () => {
  const d = await createWorkMapReader({ call: controller({ 'bindings-status': new Error('Operator authorization required'), 'channels-status': channels() }), fleet: async () => fleet(), projects: async () => directory(), now })();
  assert.equal(d.available, false);
  assert.equal(d.unavailable, 'Operator authorization required');
  assert.deepEqual(d.primes, []);
  assert.ok(d.attention.some(a => a.kind === 'seats-unavailable'));
  assert.ok(!d.attention.some(a => a.kind === 'no-project-orchestrator' || a.kind === 'no-prime'));
});

test('overview: an unavailable project directory leaves membership unknown and every session unplaced', async () => {
  const d = await createWorkMapReader({ call: controller({ 'bindings-status': status(), 'channels-status': channels() }), fleet: async () => fleet(), projects: async () => directory(false), now })();
  assert.equal(d.sources.projects.available, false);
  assert.ok(d.projects.every(p => p.workstreams === null));
  assert.equal(d.unplaced.length, 3);
});

test('overview: a failed fleet read keeps seats and marks runtime unavailable', async () => {
  const d = await createWorkMapReader({ call: controller({ 'bindings-status': status(), 'channels-status': new Error('down') }), fleet: async () => { throw new Error('fleet down'); }, projects: async () => directory(), now })();
  assert.equal(d.available, true);
  assert.equal(d.sources.fleet.available, false);
  assert.equal(d.sources.channels, false);
  assert.equal(d.primes.length, 1);
});

test('project: an unreadable projection is unknown rather than absent', async () => {
  const d = await createWorkMapProjectReader({ call: controller({ 'bindings-project': new Error('Control timed out') }), fleet: async () => fleet(), issues: noIssues, now })({ projectId: PROJ_1 });
  assert.equal(d.available, false);
  assert.equal(d.unavailable, 'Control timed out');
  assert.equal(d.leader, null);
  assert.match(d.note, /unknown rather than absent/);
});

// ---------- T7: the J3 contract ----------

const issueRow = (scopeId: string, extra: Record<string, unknown> = {}) => ({ source: 'github', key: 'org/repo#1', title: 'Title', state: 'open', rawState: 'OPEN', assignee: 'octo', url: 'https://github.com/org/repo/issues/1', updatedAt: now(), linkedTo: { scope: 'workstream', scopeId }, relation: 'links', ...extra });
const refs = [{ scope: 'workstream' as const, scopeId: TASK_A }];

test('T7 an unavailable provider says so; it is not reported as having no issues', async () => {
  const resolve = createIssueResolver([{ source: 'github', resolve: async () => ({ available: false, note: 'Token missing', issues: [] }) }]);
  const r = await resolve(refs);
  assert.deepEqual(r.providers, [{ source: 'github', available: false, note: 'Token missing' }]);
});

test('T7 non-https links, email assignees and rows for unasked scopes are dropped', async () => {
  const resolve = createIssueResolver([{ source: 'github', resolve: async () => ({ available: true, note: '', issues: [
    issueRow(TASK_A), issueRow(TASK_A, { url: 'http://insecure.example/1' }), issueRow(TASK_A, { url: 'javascript:alert(1)' }),
    issueRow(TASK_A, { assignee: 'someone@example.com' }), issueRow(TASK_B), { garbage: true },
  ] }) }]);
  const r = await resolve(refs);
  assert.equal(r.issues.length, 1);
  assert.equal(r.issues[0].url, 'https://github.com/org/repo/issues/1');
});

test('T7 a slow provider is aborted at the deadline and does not hold back the others', async () => {
  let aborted = false;
  const slow = { source: 'jira', resolve: (_: unknown, signal: AbortSignal) => new Promise<never>(() => { signal.addEventListener('abort', () => { aborted = true; }); }) };
  const fast = { source: 'board', resolve: async () => ({ available: true, note: 'ok', issues: [issueRow(TASK_A, { source: 'board', relation: 'is', url: null })] }) };
  const started = Date.now();
  const r = await createIssueResolver([slow, fast], { timeoutMs: 50 })(refs);
  assert.ok(Date.now() - started < 1000);
  assert.equal(aborted, true);
  assert.deepEqual(r.providers.map(p => [p.source, p.available]), [['jira', false], ['board', true]]);
  assert.equal(r.issues.length, 1);
});

test('T7 a throwing provider becomes unavailable with its message', async () => {
  const r = await createIssueResolver([{ source: 'github', resolve: async () => { throw new Error('rate limited'); } }])(refs);
  assert.deepEqual(r.providers[0], { source: 'github', available: false, note: 'rate limited' });
});

test('T7 results are cached per ref set for the TTL', async () => {
  let calls = 0, clock = 0;
  const resolve = createIssueResolver([{ source: 'board', resolve: async () => { calls++; return { available: true, note: '', issues: [] }; } }], { ttlMs: 60000, now: () => clock });
  await resolve(refs); await resolve(refs);
  assert.equal(calls, 1);
  clock = 60001; await resolve(refs);
  assert.equal(calls, 2);
});

test('T7 the board provider maps each workstream to its own issue and normalises state', async () => {
  const provider = boardIssueProvider(async () => [
    { id: TASK_A, identifier: 'AIN-107', title: 'Work view', status: 'in_progress', assigneeUserId: 'local-board', updatedAt: now() },
    { id: TASK_B, identifier: 'AIN-93', title: 'Seat restore', status: 'weird_new_state', assigneeUserId: 'a@b.c' },
  ]);
  const r = await createIssueResolver([provider])([{ scope: 'workstream', scopeId: TASK_A }, { scope: 'workstream', scopeId: TASK_B }, { scope: 'project', scopeId: PROJ_1 }]);
  assert.deepEqual(r.issues.map(i => [i.key, i.state, i.relation, i.assignee]), [['AIN-107', 'in_progress', 'is', 'local-board'], ['AIN-93', 'unknown', 'is', null]]);
  const down = await createIssueResolver([boardIssueProvider(async () => { throw new Error('ECONNREFUSED'); })])(refs);
  assert.equal(down.providers[0].available, false);
  assert.match(down.providers[0].note, /unavailable/);
});


test('validated manager is projected as display association, never as creator or adopted seat', async () => {
  const source = projection();
  source.tasks[0].sessions.find(s => s.id === LOOSE_S)!.owner = owner('managed', { sessionId: LOOSE_S, parentSession: LEAD_S });
  const d = await createWorkMapProjectReader({ call: controller({ 'bindings-project': source, 'bindings-status': status() }), fleet: async () => fleet(), issues: noIssues, now })({ projectId: PROJ_1 });
  const worker = d.workstreams[0].sessions.find(s => s.sessionId === LOOSE_S)!;
  assert.equal(worker.ownership, 'managed'); assert.equal(worker.managedBy, LEAD_S);
  assert.equal(worker.parentSession, null); assert.equal(worker.adoptedUnder, null);
});


test('malformed manager display stays unknown', async () => {
  const source = projection();
  source.tasks[0].sessions.find(s => s.id === LOOSE_S)!.owner = owner('managed', { sessionId: LOOSE_S, parentSession: LOOSE_S });
  const d = await createWorkMapProjectReader({ call: controller({ 'bindings-project': source, 'bindings-status': status() }), fleet: async () => fleet(), issues: noIssues, now })({ projectId: PROJ_1 });
  const worker = d.workstreams[0].sessions.find(s => s.sessionId === LOOSE_S)!;
  assert.equal(worker.ownership, 'unknown'); assert.equal(worker.managedBy, null);
});
