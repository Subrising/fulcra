import test from 'node:test';
import assert from 'node:assert/strict';
import { OWNERSHIP_STATE, ownershipStateOf, placesSession } from '../shared/roles';
import { announceControllerFailure, classifyControllerFailure, createAllowanceSet, createAllowancesReader, createRoleAdopt, createRoleAssign, createRoleDirectoryReader, createRoleProjectReader, createSessionOwnershipReader, createSessionRequest, createSessionRequestsReader } from './roles';

const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const SESSION = uuid(1), TASK = uuid(10), PROJECT = uuid(20), PROGRAMME = uuid(30);
const now = () => '2026-09-19T09:00:00.000Z';

// Exactly the shape the controller's describe() returns, including the fields that must not escape.
const seatRow = (extra: Record<string, unknown> = {}) => ({
  role: 'project-orchestrator', seat: PROJECT, projectId: PROJECT, state: 'assigned', revision: 3,
  task: TASK, sessionId: SESSION,
  session: { id: SESSION, task: TASK, cwd: '/Volumes/test-volume/secret-working-directory', mode: 'delegated', generation: 4 },
  note: 'Accountable for the shared memory format', at: now(), membershipAt: now(),
  sessionPresent: true, sessionGenerationChanged: false, sessionTaskMatches: true,
  dispatch: { host: 'mini', supported: true, phase: null, reason: null }, ...extra,
});

test('an unreadable binding table reports itself unreadable rather than as an empty seat', async () => {
  const read = createRoleDirectoryReader(async () => { throw new Error('Unknown method bindings-status'); }, now);
  const d = await read();
  assert.equal(d.available, false);
  assert.equal(d.unavailable, 'Unknown method bindings-status');
  assert.deepEqual(d.primes, []);
  assert.deepEqual(d.projectSeats, []);
  // The wording must not let a failed read read as an established absence.
  assert.match(d.note, /could not be read/);
  assert.doesNotMatch(d.note, /no orchestrator is assigned/i);
});

test('a project read failure leaves the orchestrator unknown, not unassigned', async () => {
  const read = createRoleProjectReader(async () => { throw new Error('Control timed out'); }, now);
  const d = await read({ projectId: PROJECT });
  assert.equal(d.available, false);
  assert.equal(d.unavailable, 'Control timed out');
  assert.equal(d.leader, null);
  assert.match(d.note, /unknown rather than absent/);
});

test('seat reads never carry the bound session working directory or any unlisted field', async () => {
  const read = createRoleDirectoryReader(async () => ({
    bindings: [seatRow(), { ...seatRow(), role: 'prime', seat: 'orca', projectId: null }],
    programme: PROGRAMME, note: 'A role binding records accountability only.',
  }), now);
  const d = await read();
  assert.equal(d.available, true);
  assert.equal(d.projectSeats.length, 1);
  assert.equal(d.primes.length, 1);
  const serialized = JSON.stringify(d);
  assert.doesNotMatch(serialized, /secret-working-directory/);
  assert.doesNotMatch(serialized, /cwd/);
  assert.deepEqual(Object.keys(d.projectSeats[0].session!).sort(), ['generation', 'id', 'mode', 'task']);
  assert.equal(d.projectSeats[0].revision, 3);
});

test('an unexpected extra controller field cannot reach the renderer through a seat', async () => {
  const read = createRoleDirectoryReader(async () => ({
    bindings: [{ ...seatRow(), capability: 'role-token-abc', operator: 'operator-secret-xyz' }], programme: PROGRAMME, note: 'n',
  }), now);
  const serialized = JSON.stringify(await read());
  assert.doesNotMatch(serialized, /role-token-abc/);
  assert.doesNotMatch(serialized, /operator-secret-xyz/);
});

test('a project view carries the real leader, needs and blockers without inventing membership', async () => {
  const read = createRoleProjectReader(async (method, input) => {
    assert.equal(method, 'bindings-project');
    // The controller takes the bare project ID for this read, not an object.
    assert.equal(input, PROJECT);
    return {
      project: { id: PROJECT, summary: { id: PROJECT, name: 'Shared memory', description: null, status: 'in_progress' },
        membership: { known: true, available: true, partial: false, observedAt: now(), memberTasks: [TASK], memberTaskCount: 1, truncated: false, note: 'Fixture' } },
      leader: seatRow(), primes: [{ ...seatRow(), role: 'prime', seat: 'orca', projectId: null }],
      progress: { memberTasks: 1, recorded: 4, byState: { delivered: 4 }, unresolved: 0, sessions: 2, truncated: false, basis: 'Journal activity, not work accepted.' },
      needed: [{ kind: 'no-prime', detail: 'No prime seat is filled' }],
      blockers: [{ kind: 'unresolved-delivery', taskId: TASK, deliveryId: uuid(40), sessionId: SESSION, state: 'intent', detail: 'Recorded work has no confirmed outcome' }],
      note: 'A role binding records accountability only.',
    };
  }, now);
  const d = await read({ projectId: PROJECT });
  assert.equal(d.available, true);
  assert.equal(d.leader!.sessionId, SESSION);
  assert.equal(d.leader!.state, 'assigned');
  assert.equal(d.summary!.name, 'Shared memory');
  assert.equal(d.progress!.recorded, 4);
  assert.deepEqual(d.needed.map(n => n.kind), ['no-prime']);
  assert.deepEqual(d.blockers.map(b => [b.kind, b.taskId, b.sessionId]), [['unresolved-delivery', TASK, SESSION]]);
});

test('assign sends the observed fences and reports replacement as replacement', async () => {
  const sent: any[] = [];
  const act = createRoleAssign(async (method, input) => {
    sent.push([method, input]);
    return { role: 'project-orchestrator', seat: PROJECT, projectId: PROJECT, task: TASK, sessionId: SESSION,
      previousSessionId: uuid(2), revision: 4, action: 'replace', at: now(), grantsAuthority: false, note: 'accountability only' };
  }, now);
  const d = await act({ action: 'assign', role: 'project-orchestrator', seat: PROJECT, sessionId: SESSION,
    expectedRevision: 3, expectedSessionGeneration: 4, reason: 'Named accountable for the retained format' });
  assert.equal(d.status, 'replaced');
  assert.equal(d.grantsAuthority, false);
  assert.equal(d.previousSessionId, uuid(2));
  assert.equal(sent[0][0], 'bindings-assign');
  // The fences are the observed values, never defaults; a stale writer is the controller's to refuse.
  assert.equal(sent[0][1].expectedRevision, 3);
  assert.equal(sent[0][1].expectedSessionGeneration, 4);
  assert.equal(sent[0][1].note, 'Named accountable for the retained format');
  assert.match(d.message, /no work moved and nothing was sent/);
});

test('a refused stale write is surfaced verbatim and never retried', async () => {
  const calls: string[] = [];
  const act = createRoleAssign(async method => { calls.push(method); throw new Error('Role binding revision changed; refresh before assigning'); }, now);
  const d = await act({ action: 'vacate', role: 'project-orchestrator', seat: PROJECT, expectedRevision: 3, reason: 'Stepping down for the quarter' });
  assert.equal(d.status, 'error');
  assert.equal(d.message, 'Role binding revision changed; refresh before assigning');
  assert.deepEqual(calls, ['bindings-unassign']);
});

test('vacate uses the release fence only and never names a session', async () => {
  const sent: any[] = [];
  const act = createRoleAssign(async (method, input) => {
    sent.push([method, input]);
    return { role: 'project-orchestrator', seat: PROJECT, projectId: PROJECT, task: null, sessionId: null,
      previousSessionId: SESSION, revision: 4, action: 'unassign', at: now(), grantsAuthority: false, note: 'accountability only' };
  }, now);
  const d = await act({ action: 'vacate', role: 'project-orchestrator', seat: PROJECT, expectedRevision: 3, reason: 'Handing the seat back' });
  assert.equal(d.status, 'vacated');
  assert.equal(d.sessionId, null);
  assert.equal(d.previousSessionId, SESSION);
  assert.deepEqual(Object.keys(sent[0][1]).sort(), ['expectedRevision', 'note', 'role', 'seat']);
  assert.match(d.message, /keeps its own task and control/);
});

test('a reason shorter than the controller minimum is refused before any call', async () => {
  const calls: string[] = [];
  const act = createRoleAssign(async method => { calls.push(method); return {}; }, now);
  await assert.rejects(() => act({ action: 'vacate', role: 'project-orchestrator', seat: PROJECT, expectedRevision: 3, reason: 'too short' }));
  assert.deepEqual(calls, []);
});

test('only operator binding methods are used; the model role capability lane is never touched', async () => {
  const methods: string[] = [];
  const call = async (method: string) => { methods.push(method); return { bindings: [], programme: PROGRAMME, note: 'n' }; };
  await createRoleDirectoryReader(call, now)();
  await createRoleProjectReader(async (m) => { methods.push(m); return { project: { id: PROJECT, summary: null, membership: null }, leader: null, primes: [], progress: null, needed: [], blockers: [], note: 'n' }; }, now)({ projectId: PROJECT });
  assert.deepEqual(methods, ['bindings-status', 'bindings-project']);
  // bindings-self and channels-* take a seated model's role capability, not the operator lane.
  assert.equal(methods.some(m => m === 'bindings-self' || m.startsWith('channels-')), false);
});

const requestInput = {
  seat: PROJECT, expectedRevision: 3, taskId: TASK,
  provider: 'claude' as const, title: 'Compare retention windows', reason: 'Owned by the shared memory project',
};

test('a seat request sends exactly the validator\'s accepted key set and nothing else', async () => {
  const sent: any[] = [];
  const ask = createSessionRequest(async (method: string, input: any) => {
    sent.push([method, input]);
    return { requestId: uuid(50), state: 'pending' };
  }, now);
  const d = await ask(requestInput);
  assert.equal(d.status, 'requested');
  assert.equal(d.requestId, uuid(50));
  assert.equal(d.state, 'pending');
  assert.equal(d.grantsAuthority, false);
  const [method, body] = sent[0];
  assert.equal(method, 'roles-request-session');
  // Closed set: exactly these six keys, so a stray projectId or role cannot be rejected wholesale.
  assert.deepEqual(Object.keys(body).sort(), ['expectedRevision', 'note', 'provider', 'seat', 'taskId', 'title']);
  assert.equal(body.expectedRevision, 3);
  assert.equal(body.note, 'Owned by the shared memory project');
  assert.equal('projectId' in body, false);
  assert.equal('role' in body, false);
  assert.equal('sessionId' in body, false);
  assert.equal('ownership' in body, false);
});

test('a request is reported as a request, never as a created session', async () => {
  const ask = createSessionRequest(async () => ({ requestId: uuid(50), state: 'pending' }), now);
  const d = await ask(requestInput);
  assert.match(d.message, /no session exists yet/);
  assert.doesNotMatch(d.message, /created/i);
  // There is no session field to accidentally render.
  assert.equal('sessionId' in d, false);
});

test('both independent seat refusals are surfaced verbatim and never retried', async () => {
  const calls: string[] = [];
  for (const refusal of ['The seat changed; refresh before requesting a session from it',
                         'That seat has no remaining operator session allowance']) {
    const ask = createSessionRequest(async (m: string) => { calls.push(m); throw new Error(refusal); }, now);
    const d = await ask(requestInput);
    assert.equal(d.status, 'refused');
    assert.match(d.message, new RegExp(refusal.slice(0, 24).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(d.message, /Nothing was requested/);
  }
  // A current seat can still correctly refuse on allowance; neither is retried.
  assert.deepEqual(calls, ['roles-request-session', 'roles-request-session']);
});

test('a controller without seat requests reports unavailable rather than refusal', async () => {
  const ask = createSessionRequest(async () => { throw new Error('Unknown method roles-request-session'); }, now);
  const d = await ask(requestInput);
  assert.equal(d.status, 'unavailable');
  assert.match(d.message, /does not expose seat session requests yet/);
  assert.match(d.message, /Nothing was requested/);
});

test('outstanding requests are read, and an unreadable list is unavailable not empty', async () => {
  const read = createSessionRequestsReader(async () => ({ requests: [
    { requestId: uuid(50), seat: PROJECT, seatRole: 'project-orchestrator', taskId: TASK, provider: 'claude', title: 'Compare windows', state: 'notified', sessionId: null, at: now(), detail: 'The seat has been woken' },
  ] }), now);
  const d = await read();
  assert.equal(d.available, true);
  assert.deepEqual(d.requests.map(r => [r.requestId, r.state, r.sessionId]), [[uuid(50), 'notified', null]]);
  const broken = await createSessionRequestsReader(async () => { throw new Error('Unknown method roles-session-requests'); }, now)();
  assert.equal(broken.available, false);
  assert.deepEqual(broken.requests, []);
  assert.match(broken.unavailable!, /Unknown method/);
});

const fleetDouble = async () => ({
  nodes: [
    { id: uuid(60), agentId: 'agent-owned', task: TASK, title: 'Retention comparison' },
    { id: SESSION, agentId: 'agent-leader', task: TASK, title: 'Memory lead' },
    { id: uuid(62), agentId: 'agent-unknown', task: TASK, title: 'Loose session' },
  ],
  tasks: [{ id: TASK, title: 'Shared memory format' }],
});
const projectsDouble = async () => ({ available: true, projects: [{ id: PROJECT, name: 'Shared memory' }] });

test('the app ownership seam resolves names the controller does not return', async () => {
  const read = createSessionOwnershipReader(async (method: string, input: any) => {
    if (method === 'bindings-status') return { bindings: [seatRow()] };
    assert.equal(method, 'roles-ownership');
    // The controller takes a bare session UUID as its whole argument.
    if (input === uuid(60)) return { sessionId: uuid(60), ownership: 'adopted', projectId: PROJECT, seat: PROJECT, seatRole: 'project-orchestrator', detail: 'An operator adopted this session into the seat.' };
    return { sessionId: input, ownership: 'unknown', projectId: null, detail: 'No ownership was recorded at creation.' };
  }, fleetDouble, projectsDouble);
  const d = await read({ agentIds: ['agent-owned', 'agent-unknown', 'agent-missing'] });
  const owned = d.ownership['agent-owned']!;
  assert.equal(owned.state, 'adopted');
  assert.equal(owned.projectId, PROJECT);
  // Names are this plugin's join; the controller returns ids only.
  assert.equal(owned.projectName, 'Shared memory');
  assert.equal(owned.taskTitle, 'Shared memory format');
  assert.equal(owned.leaderAgentId, 'agent-leader');
  assert.equal(owned.leaderTitle, 'Memory lead');
  assert.equal(owned.detail, 'An operator adopted this session into the seat.');
  // Unknown is a RECORD with null project fields, never null: null means "not a controller
  // session I could resolve", which is a different fact the app must not conflate with unknown.
  const unknown = d.ownership['agent-unknown']!;
  assert.notEqual(unknown, null);
  assert.equal(unknown.state, 'unknown');
  assert.equal(unknown.projectId, null);
  assert.equal(unknown.projectName, null);
  assert.equal(unknown.detail, 'No ownership was recorded at creation.');
  // An agent that is not a controller session at all stays null.
  assert.equal(d.ownership['agent-missing'], null);
});

test('a declared session is owned by the project but led by nobody', async () => {
  const read = createSessionOwnershipReader(async (method: string, input: any) => {
    if (method === 'bindings-status') return { bindings: [] };
    return { sessionId: input, ownership: 'declared', projectId: PROJECT, seat: null, seatRole: null,
      detail: 'An operator declared the project at creation, so it is owned by the project but led by no recorded leader.' };
  }, fleetDouble, projectsDouble);
  const owned = (await read({ agentIds: ['agent-owned'] })).ownership['agent-owned']!;
  assert.equal(owned.state, 'declared');
  assert.equal(owned.leaderAgentId, null);
  assert.equal(owned.leaderTitle, null);
  assert.match(owned.detail!, /led by no recorded leader/);
});

test('adoption is operator-only, fenced, and reports the allowance it spent', async () => {
  const sent: any[] = [];
  const act = createRoleAdopt(async (method: string, input: any) => {
    sent.push([method, input]);
    return { sessionId: uuid(60), remaining: 2 };
  }, now);
  const d = await act({ seat: PROJECT, expectedRevision: 3, request: uuid(70), reason: 'Placing it under the memory seat' });
  assert.equal(d.status, 'adopted');
  assert.equal(d.remaining, 2);
  assert.equal(d.grantsAuthority, false);
  assert.match(d.message, /Adoption spends allowance/);
  assert.match(d.message, /grants the seat no authority/);
  const [method, body] = sent[0];
  assert.equal(method, 'roles-adopt');
  // The controller keys adoption by the CREATION RECORD, not the session id.
  assert.deepEqual(Object.keys(body).sort(), ['expectedRevision', 'note', 'request', 'seat']);
  assert.equal(body.request, uuid(70));
  assert.equal('sessionId' in body, false);
  assert.equal(body.expectedRevision, 3);
});

test('adoption refusals and an absent method stay distinct and are never retried', async () => {
  const calls: string[] = [];
  const refused = await createRoleAdopt(async (m: string) => { calls.push(m); throw new Error('That seat has no remaining operator session allowance'); }, now)(
    { seat: PROJECT, expectedRevision: 3, request: uuid(70), reason: 'Placing it under the memory seat' });
  assert.equal(refused.status, 'refused');
  assert.match(refused.message, /no remaining operator session allowance/);
  assert.match(refused.message, /Nothing was adopted/);
  const missing = await createRoleAdopt(async (m: string) => { calls.push(m); throw new Error('Unknown method roles-adopt'); }, now)(
    { seat: PROJECT, expectedRevision: 3, request: uuid(70), reason: 'Placing it under the memory seat' });
  assert.equal(missing.status, 'unavailable');
  assert.match(missing.message, /does not expose adoption yet/);
  assert.deepEqual(calls, ['roles-adopt', 'roles-adopt']);
});

test('allowances are read with remaining derived only when the controller omits it', async () => {
  const read = createAllowancesReader(async () => ({ allowances: [
    { seat: PROJECT, role: 'project-orchestrator', revision: 3, limit: 4, used: 1, current: true, detail: 'Granted by operator' },
    { seat: 'orca', role: 'prime', revision: 1, limit: 2, used: 2, current: false },
  ] }), now);
  const d = await read();
  assert.equal(d.available, true);
  assert.deepEqual(d.allowances.map(a => [a.seat, a.remaining, a.current]), [[PROJECT, 3, true], ['orca', 0, false]]);
  // An unreadable allowance list is unavailable, never "no allowance".
  const broken = await createAllowancesReader(async () => { throw new Error('Unknown method roles-allowances'); }, now)();
  assert.equal(broken.available, false);
  assert.deepEqual(broken.allowances, []);
});

test('granting an allowance states the revision pin that will strand a successor', async () => {
  const sent: any[] = [];
  const set = createAllowanceSet(async (method: string, input: any) => { sent.push([method, input]); return { maxSessions: 4, remaining: 4 }; }, now);
  const d = await set({ seat: PROJECT, role: 'project-orchestrator', expectedRevision: 3, maxSessions: 4, reason: 'Allowing four sessions this quarter' });
  assert.equal(d.status, 'granted');
  assert.equal(d.maxSessions, 4);
  assert.match(d.message, /pinned to that revision/);
  assert.match(d.message, /successor needs a fresh grant/);
  // role is required and the bound is maxSessions; omitting either refused wholesale.
  assert.deepEqual(Object.keys(sent[0][1]).sort(), ['expectedRevision', 'maxSessions', 'note', 'role', 'seat']);
  assert.equal(sent[0][1].role, 'project-orchestrator');
});

test('nothing on screen being a controller session costs no controller reads', async () => {
  const calls: string[] = [];
  const read = createSessionOwnershipReader(async (m: string) => { calls.push(m); return {}; }, fleetDouble, projectsDouble);
  const d = await read({ agentIds: ['not-a-session', 'also-not'] });
  assert.deepEqual(d.ownership, { 'not-a-session': null, 'also-not': null });
  // No seat read and no ownership read when nothing resolves: this runs against the real app.
  assert.deepEqual(calls, []);
});

test('every controller ownership state is carried, derived from the shared list', async () => {
  // N1-seam: the states are DERIVED from OWNERSHIP_STATE, not restated here. A hardcoded list is
  // what let B1 through: the set was wrong and the test agreed with it. Adding a state to the
  // shared definition now extends this test automatically and fails the `placesSession` guard
  // until someone classifies it.
  assert.ok(OWNERSHIP_STATE.length >= 4, 'the shared state list must be the source of truth');
  for (const state of OWNERSHIP_STATE) {
    const placed = placesSession(state);
    const read = createSessionOwnershipReader(async (method: string, input: any) => {
      if (method === 'bindings-status') return { bindings: [seatRow()] };
      return { sessionId: input, ownership: state, projectId: placed ? PROJECT : null,
        seat: placed && state !== 'declared' ? PROJECT : null,
        seatRole: placed && state !== 'declared' ? 'project-orchestrator' : null,
        parentSession: state === 'managed' ? SESSION : null,
        detail: `controller says ${state}` };
    }, fleetDouble, projectsDouble);
    const record = (await read({ agentIds: ['agent-owned'] })).ownership['agent-owned'];
    assert.notEqual(record, null, `${state} must produce a record, never null`);
    // Carried verbatim: no state may be relabelled as another.
    assert.equal(record!.state, state, `${state} must be carried, not narrowed`);
    if (state === 'managed') assert.match(record!.detail!, /Managed by Memory lead; role-session: n\/a/);
    else assert.equal(record!.detail, `controller says ${state}`);
    assert.equal(record!.projectId, placed ? PROJECT : null, `${state} project field must match its placement`);
  }
});

test('a state the plugin does not recognise reads unknown, never a concrete state', async () => {
  // The controller-sends-something-new direction. `revoked` is not in OWNERSHIP_STATE, so it must
  // normalise to unknown rather than fall through to declared, which is what the old ternary did.
  for (const wire of ['revoked', 'RECORDED', '', 'declared ', 42, null]) {
    const read = createSessionOwnershipReader(async (method: string, input: any) => {
      if (method === 'bindings-status') return { bindings: [seatRow()] };
      return { sessionId: input, ownership: wire, projectId: PROJECT, seat: PROJECT, seatRole: 'project-orchestrator', detail: 'unrecognised' };
    }, fleetDouble, projectsDouble);
    const record = (await read({ agentIds: ['agent-owned'] })).ownership['agent-owned']!;
    assert.equal(record.state, 'unknown', `wire value ${JSON.stringify(wire)} must read unknown`);
    assert.equal(record.projectId, null, 'an unknown state places nothing, so it carries no project');
  }
});

test('placement is exhaustive and fails closed', () => {
  // Every known state is classified, and nothing outside the list is treated as placed.
  for (const state of OWNERSHIP_STATE) assert.equal(typeof placesSession(state), 'boolean');
  assert.equal(placesSession('unknown'), false);
  assert.equal(placesSession(ownershipStateOf('revoked')), false, 'an unrecognised state must not place a session');
  assert.deepEqual(OWNERSHIP_STATE.filter(s => !placesSession(s)), ['unknown', 'managed']);
});

test('a recorded session resolves its seat leader exactly as an adopted one does', async () => {
  // `recorded` already carries `seat`, so leader resolution needs no special case.
  for (const state of ['recorded', 'adopted']) {
    const read = createSessionOwnershipReader(async (method: string, input: any) => {
      if (method === 'bindings-status') return { bindings: [seatRow()] };
      return { sessionId: input, ownership: state, projectId: PROJECT, seat: PROJECT, seatRole: 'project-orchestrator', detail: `controller says ${state}` };
    }, fleetDouble, projectsDouble);
    const record = (await read({ agentIds: ['agent-owned'] })).ownership['agent-owned']!;
    assert.equal(record.state, state);
    assert.equal(record.leaderAgentId, 'agent-leader', `${state} must resolve its leader`);
    assert.equal(record.leaderTitle, 'Memory lead');
    assert.equal(record.projectName, 'Shared memory');
  }
});

test('an unknown controller method is announced differently from a refusal, once each', () => {
  const lines: string[] = [];
  const write = (l: string) => lines.push(l);
  // Not implemented: expected before activation, alarming after it.
  assert.equal(announceControllerFailure('roles-ownership', 'Unknown method roles-ownership', write), 'unavailable');
  // Implemented and declined: a real answer from a real controller.
  assert.equal(announceControllerFailure('roles-adopt', 'That seat has no remaining operator session allowance', write), 'refused');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /NOT IMPLEMENTED by this controller/);
  assert.match(lines[0], /after activation this means the wrong controller is running/);
  assert.match(lines[1], /REFUSED - the controller implements it and declined/);
  // Once per method per kind: an operator gets a signal, not a flood.
  announceControllerFailure('roles-ownership', 'Unknown method roles-ownership', write);
  announceControllerFailure('roles-adopt', 'That seat has no remaining operator session allowance', write);
  assert.equal(lines.length, 2, 'repeat failures must not re-announce');
});

test('failure classification separates not-built-yet from built-and-said-no', () => {
  for (const text of ['Unknown method roles-adopt', 'unsupported method x', 'No such method y', 'not implemented', 'Unknown RPC z']) {
    assert.equal(classifyControllerFailure(text), 'unavailable', text);
  }
  for (const text of ['The seat changed; refresh before requesting a session from it',
                      'That seat has no remaining operator session allowance',
                      'Control timed out; inspect delivery before retrying']) {
    assert.equal(classifyControllerFailure(text), 'refused', text);
  }
});

test('validated manager display resolves the leader without claiming role-session ownership',async()=>{
 const read=createSessionOwnershipReader(async(method:string,input:any)=> method==='bindings-status'?{bindings:[]}:
  input===uuid(60)?{sessionId:input,ownership:'managed',parentSession:SESSION,projectId:null}:
  {sessionId:input,ownership:'unknown',projectId:null,detail:'No association recorded'},fleetDouble,projectsDouble);
 const {ownership}=await read({agentIds:['agent-owned','agent-unknown']});
 assert.equal(ownership['agent-owned']!.state,'managed');
 assert.equal(ownership['agent-owned']!.leaderAgentId,'agent-leader');
 assert.equal(ownership['agent-owned']!.projectId,null);
 assert.match(ownership['agent-owned']!.detail!,/Managed by Memory lead; role-session: n\/a/);
 assert.equal(ownership['agent-unknown']!.state,'unknown');
});
test('invalid manager association stays unknown',async()=>{
 const read=createSessionOwnershipReader(async(method:string,input:any)=> method==='bindings-status'?{bindings:[]}:
  {sessionId:input,ownership:'managed',parentSession:'invalid',projectId:null},fleetDouble,projectsDouble);
 assert.equal((await read({agentIds:['agent-owned']})).ownership['agent-owned']!.state,'unknown');
});


test('FR-2 validated manager names use a title or a readable fallback, never a raw identity', async () => {
  for (const title of [null, '', SESSION, 'Resolved leader']) {
    const read = createSessionOwnershipReader(async (method: string, input: any) => method === 'bindings-status' ? {bindings:[]} :
      {sessionId:input, ownership:'managed', parentSession:SESSION, projectId:null},
      async () => { const fleet = await fleetDouble(); return {...fleet, nodes:fleet.nodes.filter(n => n.id !== SESSION || title !== null).map(n => n.id === SESSION ? {...n,title:title!} : n)}; }, projectsDouble);
    const own = (await read({agentIds:['agent-owned']})).ownership['agent-owned']!;
    assert.equal(own.state,'managed');
    assert.equal(own.leaderTitle,title === 'Resolved leader' ? title : 'Current manager (name unavailable)');
    assert.doesNotMatch(own.detail!,new RegExp(SESSION));
  }
});
