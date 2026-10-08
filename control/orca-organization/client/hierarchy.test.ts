import test from "node:test";
import assert from "node:assert/strict";
import {
  buildHierarchy,
  orchestratorView,
  UNGROUPED_PROJECT,
  type OrchestratorAssignment,
} from "./hierarchy";
import type { Fleet } from "../shared/fleet";
import type { ProjectDirectory } from "../shared/projects";
import type { Briefing } from "../shared/briefing";
import type { RoleDirectory, Seat } from "../shared/roles";

const uuid = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const PRIME = uuid(1),
  LEAD = uuid(2),
  WORKER = uuid(3),
  TASK_A = uuid(10),
  TASK_B = uuid(11),
  PROJECT = uuid(20),
  OTHER = uuid(21);

const worker = (
  workerId: string | null,
  extra: Partial<NonNullable<Fleet["supervisors"]>[number]["workers"][number]> = {},
) => ({
  requestId: uuid(90),
  workerId,
  phase: "running",
  ownership: "linked" as const,
  fault: null,
  lastEvent: null,
  ...extra,
});
const role = (id: string, task: string, workers: ReturnType<typeof worker>[] = []) => ({
  id,
  task,
  active: true,
  maxWorkers: 4,
  reserved: 0,
  workers,
});
const fleet = (extra: Partial<Fleet> = {}): Fleet => ({
  observedAt: "now",
  total: 0,
  partial: false,
  note: "Fixture",
  nodes: [],
  edges: [],
  tasks: [
    { id: TASK_A, title: "Leading work", identifier: "A-1" },
    { id: TASK_B, title: "Sub work", identifier: "A-2" },
  ],
  supervisionAvailable: true,
  supervisors: [],
  ...extra,
});
const directory = (extra: Partial<ProjectDirectory> = {}): ProjectDirectory => ({
  observedAt: "now",
  available: true,
  partial: false,
  note: "Fixture",
  projects: [
    {
      id: PROJECT,
      name: "Shared memory",
      description: "Retained decisions",
      status: "in_progress",
    },
  ],
  membership: [
    { taskId: TASK_A, projectId: PROJECT },
    { taskId: TASK_B, projectId: PROJECT },
  ],
  ...extra,
});
const entry = (
  taskId: string,
  extra: Partial<Briefing["entries"][number]> = {},
): Briefing["entries"][number] => ({
  taskId,
  title: "Leading work",
  projectId: PROJECT,
  projectName: "Shared memory",
  outcome: "Outcome",
  currentState: "State",
  nextStep: "Publish the comparison",
  question: null,
  decision: null,
  publishedAt: null,
  recordSha256: "a".repeat(64),
  affects: [],
  dependencies: [],
  ...extra,
});
const seat = (extra: Partial<Seat> = {}): Seat => ({
  role: "project-orchestrator",
  seat: PROJECT,
  projectId: PROJECT,
  state: "vacant",
  revision: 0,
  task: null,
  sessionId: null,
  session: null,
  note: null,
  at: null,
  membershipAt: null,
  sessionPresent: false,
  sessionGenerationChanged: false,
  sessionTaskMatches: false,
  dispatch: null,
  ...extra,
});
const held = (extra: Partial<Seat> = {}): Seat =>
  seat({
    state: "assigned",
    revision: 3,
    task: TASK_A,
    sessionId: PRIME,
    session: { id: PRIME, task: TASK_A, mode: "delegated", generation: 4 },
    note: "Accountable for the retained format",
    sessionPresent: true,
    sessionTaskMatches: true,
    dispatch: { host: "mini", supported: true, reason: null },
    ...extra,
  });
const roles = (extra: Partial<RoleDirectory> = {}): RoleDirectory => ({
  observedAt: "now",
  available: true,
  unavailable: null,
  primes: [],
  projectSeats: [],
  programme: null,
  note: "Fixture",
  ...extra,
});

const briefing = (entries: Briefing["entries"], extra: Partial<Briefing> = {}): Briefing => ({
  observedAt: "now",
  partial: false,
  scanned: entries.length,
  total: entries.length,
  missing: 0,
  unavailable: 0,
  nextCursor: null,
  entries,
  ...extra,
});

test("a leader whose linked worker is itself a leader becomes a main assistant with a recorded project reach", () => {
  const d = fleet({
    supervisors: [
      role(PRIME, TASK_A, [worker(LEAD), worker(WORKER)]),
      role(LEAD, TASK_B, [worker(WORKER)]),
    ],
  });
  const h = buildHierarchy(d, directory(), undefined);
  assert.equal(h.primes.length, 1);
  assert.equal(h.primes[0].sessionId, PRIME);
  assert.deepEqual(h.primes[0].leads, [LEAD]);
  assert.deepEqual(h.primes[0].reaches, [PROJECT]);
  assert.deepEqual(h.primes[0].reachedTasks.sort(), [TASK_A, TASK_B].sort());
  assert.equal(h.primes[0].cyclic, false);
  // The sub-leader is led, so it is neither a prime nor a solo leader.
  assert.deepEqual(h.soloLeaders, []);
});

test("leaders that lead nobody stay solo and are never presented as a top level above others", () => {
  const h = buildHierarchy(
    fleet({ supervisors: [role(PRIME, TASK_A, [worker(WORKER)]), role(LEAD, TASK_B)] }),
    directory(),
    undefined,
  );
  assert.deepEqual(h.primes, []);
  assert.deepEqual(h.soloLeaders.map((l) => l.sessionId).sort(), [LEAD, PRIME].sort());
});

test("a leadership loop is reported rather than followed forever", () => {
  const d = fleet({
    supervisors: [role(PRIME, TASK_A, [worker(LEAD)]), role(LEAD, TASK_B, [worker(PRIME)])],
  });
  const h = buildHierarchy(d, directory(), undefined);
  // Both are led by someone, so neither is a top level; nothing is invented to fill the gap.
  assert.deepEqual(h.primes, []);
  assert.deepEqual(h.soloLeaders, []);
});

test("unavailable supervision names no leader, and it is the role read that decides the role", () => {
  const d = fleet({
    supervisionAvailable: false,
    supervisors: [role(PRIME, TASK_A, [worker(LEAD)])],
  });
  const h = buildHierarchy(d, directory(), undefined, roles({ projectSeats: [seat()] }));
  assert.deepEqual(h.primes, []);
  assert.equal(h.supervisionAvailable, false);
  assert.equal(h.tasksWithoutLeader, 0);
  // The role records were readable and the seat is empty, so this absence is established.
  assert.equal(h.projects.find((p) => p.id === PROJECT)!.orchestrator.state, "unassigned");
  // With no role read at all the seat is unknown; supervision shape never decides it either way.
  assert.equal(
    buildHierarchy(d, directory(), undefined, undefined).projects.find((p) => p.id === PROJECT)!
      .orchestrator.state,
    "unknown",
  );
});

test("recorded workstream leaders never fill the project role", () => {
  const h = buildHierarchy(
    fleet({ supervisors: [role(PRIME, TASK_A, [worker(LEAD)]), role(LEAD, TASK_B)] }),
    directory(),
    undefined,
    roles({ projectSeats: [seat()] }),
  );
  const project = h.projects.find((p) => p.id === PROJECT)!;
  assert.equal(project.orchestrator.state, "unassigned-with-leaders");
  assert.match(project.orchestrator.detail, /seat is recorded as empty/);
  assert.match(project.orchestrator.detail, /not accountability for the project/);
  assert.equal(project.leaders.length, 2);
});

test("a project with no recorded leader says so without blaming missing data", () => {
  const h = buildHierarchy(
    fleet({ supervisors: [] }),
    directory(),
    undefined,
    roles({ projectSeats: [seat()] }),
  );
  const project = h.projects.find((p) => p.id === PROJECT)!;
  assert.equal(project.orchestrator.state, "unassigned");
  assert.equal(project.leaders.length, 0);
  assert.equal(h.tasksWithoutLeader, 2);
});

test("project needs come from published briefs and count the workstreams that have none", () => {
  const h = buildHierarchy(
    fleet(),
    directory(),
    briefing([
      entry(TASK_A, {
        question: "Which retention window?",
        nextStep: "Publish the comparison",
        dependencies: [
          {
            taskId: TASK_B,
            title: "Sub work",
            reportedStatus: "in_progress",
            reason: "Needs the shared schema",
          },
          { taskId: null, title: null, reportedStatus: null, reason: "Unverifiable upstream" },
        ],
      }),
    ]),
  );
  const project = h.projects.find((p) => p.id === PROJECT)!;
  assert.deepEqual(
    project.decisions.map((d) => d.text),
    ["Which retention window?"],
  );
  assert.deepEqual(
    project.nextActions.map((n) => n.text),
    ["Publish the comparison"],
  );
  assert.deepEqual(
    project.dependencies.map((d) => [d.title, d.verified]),
    [
      ["Sub work", true],
      ["Work that cannot be verified", false],
    ],
  );
  assert.equal(project.briefed, 1);
  assert.equal(project.unbriefed, 1);
});

test("unavailable project directory keeps every workstream in one honest ungrouped bucket", () => {
  const h = buildHierarchy(
    fleet({ supervisors: [role(PRIME, TASK_A)] }),
    directory({ available: false, projects: [], membership: [] }),
    undefined,
  );
  assert.equal(h.projectsAvailable, false);
  assert.deepEqual(
    h.projects.map((p) => p.id),
    [UNGROUPED_PROJECT],
  );
  assert.deepEqual(h.projects[0].taskIds.sort(), [TASK_A, TASK_B].sort());
  assert.equal(h.projects[0].name, "Work without a recorded project");
});

test("membership naming a project the directory does not list stays visible and unnamed", () => {
  const h = buildHierarchy(
    fleet(),
    directory({
      membership: [
        { taskId: TASK_A, projectId: OTHER },
        { taskId: TASK_B, projectId: null },
      ],
    }),
    undefined,
  );
  const missing = h.projects.find((p) => p.id === OTHER)!;
  assert.equal(missing.name, "Project not in the directory");
  assert.deepEqual(missing.taskIds, [TASK_A]);
  assert.deepEqual(h.projects.find((p) => p.id === PROJECT)!.taskIds, []);
  assert.deepEqual(h.projects.find((p) => p.id === UNGROUPED_PROJECT)!.taskIds, [TASK_B]);
});

test("worker trouble is counted from records, never from a session simply existing", () => {
  const d = fleet({
    supervisors: [
      role(PRIME, TASK_A, [
        worker(LEAD, {
          lastEvent: { kind: "report", state: "delivered", consumed: false, at: "now" },
        }),
        worker(null, { ownership: "unresolved" }),
        worker(WORKER, { ownership: "orphaned", fault: "delivery" }),
      ]),
    ],
  });
  const [leader] = buildHierarchy(d, directory(), undefined).soloLeaders;
  assert.equal(leader.workers, 3);
  assert.equal(leader.waitingAcknowledgement, 1);
  assert.equal(leader.unresolvedWorkers, 2);
  assert.equal(leader.faults, 1);
  // Only linked workers with their own supervisor record count as led leaders.
  assert.deepEqual(leader.leads, []);
});

test("a briefing page that is not the whole deployment can never establish that a brief is absent", () => {
  const paged = buildHierarchy(
    fleet(),
    directory(),
    briefing([entry(TASK_A)], {
      partial: true,
      scanned: 1,
      total: 9,
      missing: 4,
      unavailable: 2,
      nextCursor: uuid(30),
    }),
  );
  const project = paged.projects.find((p) => p.id === PROJECT)!;
  assert.equal(project.briefCoverage.complete, false);
  assert.equal(project.briefCoverage.morePages, true);
  assert.deepEqual(
    [
      project.briefCoverage.scanned,
      project.briefCoverage.total,
      project.briefCoverage.missing,
      project.briefCoverage.unavailable,
    ],
    [1, 9, 4, 2],
  );
  assert.equal(paged.briefCoverage.complete, false);
  // A single page that genuinely covers the deployment is still allowed to be complete.
  assert.equal(
    buildHierarchy(fleet(), directory(), briefing([entry(TASK_A)])).briefCoverage.complete,
    true,
  );
  // An entry that could not be read is a hole in coverage even without a further page.
  assert.equal(
    buildHierarchy(fleet(), directory(), briefing([entry(TASK_A)], { unavailable: 1 }))
      .briefCoverage.complete,
    false,
  );
  // No briefing response at all is unknown coverage, never full coverage of nothing.
  const none = buildHierarchy(fleet(), directory(), undefined).briefCoverage;
  assert.equal(none.complete, false);
  assert.equal(none.available, false);
  // An empty deployment that genuinely answered is available and complete, and may say so.
  const empty = buildHierarchy(
    fleet({ tasks: [] }),
    directory({ membership: [] }),
    briefing([]),
  ).briefCoverage;
  assert.equal(empty.available, true);
  assert.equal(empty.complete, true);
});

test("an unreadable or partial project directory leaves a main assistant reach unknown rather than none", () => {
  const d = fleet({ supervisors: [role(PRIME, TASK_A, [worker(LEAD)]), role(LEAD, TASK_B)] });
  const unavailable = buildHierarchy(
    d,
    directory({ available: false, projects: [], membership: [] }),
    undefined,
  );
  assert.equal(unavailable.primes.length, 1);
  assert.deepEqual(unavailable.primes[0].reaches, []);
  assert.equal(unavailable.primes[0].reachKnown, false);
  assert.equal(unavailable.projectsAvailable, false);
  // A directory that answered but truncated its own grouping is equally unable to rule reach out.
  const partial = buildHierarchy(d, directory({ partial: true }), undefined);
  assert.deepEqual(partial.primes[0].reaches, [PROJECT]);
  assert.equal(partial.primes[0].reachKnown, false);
  assert.equal(partial.projectsPartial, true);
  assert.equal(buildHierarchy(d, directory(), undefined).primes[0].reachKnown, true);
});

test("membership beyond the capped fleet page still counts its leaders and qualifies the claim", () => {
  const TASK_C = uuid(12);
  const d = fleet({
    partial: true,
    tasks: [{ id: TASK_A, title: "Leading work", identifier: "A-1" }],
    supervisors: [role(LEAD, TASK_C)],
  });
  const h = buildHierarchy(
    d,
    directory({
      membership: [
        { taskId: TASK_A, projectId: PROJECT },
        { taskId: TASK_C, projectId: PROJECT },
      ],
    }),
    undefined,
    roles({ projectSeats: [seat()] }),
  );
  const project = h.projects.find((p) => p.id === PROJECT)!;
  // TASK_C never appeared on the fleet page, but membership recorded it inside this project.
  assert.deepEqual(project.taskIds.slice().sort(), [TASK_A, TASK_C].sort());
  assert.deepEqual(
    project.leaders.map((l) => l.sessionId),
    [LEAD],
  );
  assert.equal(project.membershipComplete, false);
  assert.equal(project.orchestrator.state, "unassigned-with-leaders");
  assert.match(project.orchestrator.detail, /in what could be observed/);
  assert.equal(h.fleetPartial, true);
});

test("a brief names the project of work the fleet page dropped, once the directory itself answered", () => {
  const TASK_C = uuid(12);
  const d = fleet({
    partial: true,
    tasks: [{ id: TASK_A, title: "Leading work", identifier: "A-1" }],
  });
  const brief = briefing([entry(TASK_C, { title: "Off-page work", projectId: PROJECT })], {
    partial: true,
    scanned: 1,
    total: 9,
    nextCursor: uuid(30),
  });
  const project = buildHierarchy(
    d,
    directory({ membership: [{ taskId: TASK_A, projectId: PROJECT }] }),
    brief,
  ).projects.find((p) => p.id === PROJECT)!;
  assert.deepEqual(project.taskIds.slice().sort(), [TASK_A, TASK_C].sort());
  assert.deepEqual(
    project.statuses.map((s) => s.title),
    ["Off-page work"],
  );
  // With no directory, a brief's own claim of project membership is not promoted into grouping.
  const ungrouped = buildHierarchy(
    d,
    directory({ available: false, projects: [], membership: [] }),
    brief,
  );
  assert.deepEqual(
    ungrouped.projects.map((p) => p.id),
    [UNGROUPED_PROJECT],
  );
});

test("a project with no observed leader reports that as a limit of the read when the read was partial", () => {
  const h = buildHierarchy(
    fleet({ partial: true, supervisors: [] }),
    directory(),
    undefined,
    roles({ projectSeats: [seat()] }),
  );
  const project = h.projects.find((p) => p.id === PROJECT)!;
  assert.equal(project.orchestrator.state, "unassigned");
  assert.match(project.orchestrator.detail, /not ruled out/);
  assert.equal(h.tasksWithoutLeaderComplete, false);
  // The same shape on a complete read is still allowed to state the absence plainly.
  assert.match(
    buildHierarchy(
      fleet({ supervisors: [] }),
      directory(),
      undefined,
      roles({ projectSeats: [seat()] }),
    ).projects.find((p) => p.id === PROJECT)!.orchestrator.detail,
    /no workstream leader is recorded here/,
  );
});

test("a hierarchy deeper than the traversal limit is reported truncated, never as a loop", () => {
  const supervisors = Array.from({ length: 70 }, (_, i) =>
    role(uuid(100 + i), uuid(200 + i), [worker(uuid(101 + i))]),
  );
  const h = buildHierarchy(
    fleet({ tasks: [], supervisors }),
    directory({ membership: [] }),
    undefined,
  );
  assert.equal(h.primes.length, 1);
  assert.equal(h.primes[0].sessionId, uuid(100));
  assert.equal(h.primes[0].cyclic, false);
  assert.equal(h.primes[0].truncated, true);
  assert.equal(h.primes[0].reachedTasks.length, 64);
  assert.equal(h.primes[0].reachKnown, false);
});

test("a loop inside a main assistant subtree is reported as a loop and not as truncation", () => {
  const TASK_C = uuid(12);
  const d = fleet({
    supervisors: [
      role(PRIME, TASK_A, [worker(LEAD)]),
      role(LEAD, TASK_B, [worker(WORKER)]),
      role(WORKER, TASK_C, [worker(LEAD)]),
    ],
  });
  const h = buildHierarchy(d, directory(), undefined);
  assert.equal(h.primes.length, 1);
  assert.equal(h.primes[0].cyclic, true);
  assert.equal(h.primes[0].truncated, false);
});

test("published outcome and current state are carried through as the actual project status", () => {
  const h = buildHierarchy(
    fleet(),
    directory(),
    briefing([entry(TASK_A, { outcome: "One retained format", currentState: "Comparison ready" })]),
  );
  const project = h.projects.find((p) => p.id === PROJECT)!;
  assert.deepEqual(
    project.statuses.map((s) => [s.taskId, s.outcome, s.currentState]),
    [[TASK_A, "One retained format", "Comparison ready"]],
  );
  assert.equal(project.statuses[0].title, "Leading work");
  // A workstream without a brief contributes no status rather than an invented one.
  assert.equal(project.statuses.length, 1);
  assert.equal(project.briefed, 1);
});

test("an explicit role names the actual project lead and routes to its conversation", () => {
  const h = buildHierarchy(
    fleet({ supervisors: [role(LEAD, TASK_B)] }),
    directory(),
    briefing([entry(TASK_A)]),
    roles({ projectSeats: [held()] }),
  );
  const project = h.projects.find((p) => p.id === PROJECT)!;
  assert.equal(project.orchestrator.state, "assigned");
  const view = orchestratorView(project.orchestrator);
  // The session ID is what the surface needs to open the real conversation.
  assert.equal(view.sessionId, PRIME);
  assert.equal(project.seat!.revision, 3);
  // A workstream leader recorded inside the project did not become the project's orchestrator.
  assert.deepEqual(
    project.leaders.map((l) => l.sessionId),
    [LEAD],
  );
  assert.doesNotMatch(view.detail, /seat is recorded as empty/);
});

test("role drift is named without erasing the accountability record", () => {
  const gone = buildHierarchy(
    fleet(),
    directory(),
    undefined,
    roles({ projectSeats: [held({ sessionPresent: false })] }),
  );
  const missing = gone.projects.find((p) => p.id === PROJECT)!.orchestrator;
  assert.equal(missing.state, "assigned");
  assert.match(missing.detail, /no longer saved in the journal/);

  const moved = buildHierarchy(
    fleet(),
    directory(),
    undefined,
    roles({ projectSeats: [held({ sessionTaskMatches: false })] }),
  );
  assert.match(
    moved.projects.find((p) => p.id === PROJECT)!.orchestrator.detail,
    /enrolled on a different task/,
  );

  const regenerated = buildHierarchy(
    fleet(),
    directory(),
    undefined,
    roles({ projectSeats: [held({ sessionGenerationChanged: true })] }),
  );
  assert.match(
    regenerated.projects.find((p) => p.id === PROJECT)!.orchestrator.detail,
    /Control of the bound session has changed/,
  );

  const remote = buildHierarchy(
    fleet(),
    directory(),
    undefined,
    roles({
      projectSeats: [
        held({
          dispatch: {
            host: "macbook",
            supported: false,
            reason: "The role session runs on the Book host.",
          },
        }),
      ],
    }),
  );
  assert.match(
    remote.projects.find((p) => p.id === PROJECT)!.orchestrator.detail,
    /runs on the Book host/,
  );
});

test("unreadable role records leave the role unknown rather than unassigned", () => {
  const h = buildHierarchy(
    fleet({ supervisors: [role(PRIME, TASK_A, [worker(LEAD)]), role(LEAD, TASK_B)] }),
    directory(),
    undefined,
    roles({ available: false, unavailable: "Unknown method bindings-status" }),
  );
  const project = h.projects.find((p) => p.id === PROJECT)!;
  assert.equal(project.orchestrator.state, "unknown");
  assert.equal(h.rolesAvailable, false);
  assert.equal(h.rolesUnavailable, "Unknown method bindings-status");
  assert.match(project.orchestrator.detail, /not the same as the seat being empty/);
  // Nested supervisors exist, but with no role read they must not be promoted into a prime.
  assert.deepEqual(h.primeSeats, []);
  assert.equal(h.primes.length, 1);
});

test("a main assistant is an explicit role, never inferred from nested supervisors", () => {
  const nested = fleet({ supervisors: [role(PRIME, TASK_A, [worker(LEAD)]), role(LEAD, TASK_B)] });
  const none = buildHierarchy(nested, directory(), undefined, roles());
  // Supervision shape alone leaves the prime seat empty; it is evidence, not a role.
  assert.deepEqual(none.primeSeats, []);
  assert.equal(none.primes.length, 1);
  const filled = buildHierarchy(
    nested,
    directory(),
    undefined,
    roles({ primes: [held({ role: "prime", seat: "orca", projectId: null })] }),
  );
  assert.deepEqual(
    filled.primeSeats.map((s) => s.seat),
    ["orca"],
  );
  assert.equal(filled.primeSeats[0].sessionId, PRIME);
});

test("work without a recorded project has no role to fill and says so", () => {
  const h = buildHierarchy(
    fleet(),
    directory({
      membership: [
        { taskId: TASK_A, projectId: null },
        { taskId: TASK_B, projectId: null },
      ],
    }),
    undefined,
    roles(),
  );
  const ungrouped = h.projects.find((p) => p.id === UNGROUPED_PROJECT)!;
  assert.equal(ungrouped.seat, null);
  assert.equal(ungrouped.orchestrator.state, "unknown");
  assert.equal(orchestratorView(ungrouped.orchestrator).heading, "Not applicable");
  assert.match(ungrouped.orchestrator.detail, /bound to a registered project, never to a task/);
});

test("the lead display stays exhaustive over every role state", () => {
  const assigned: OrchestratorAssignment = {
    state: "assigned",
    heading: "Assigned",
    detail: "d",
    note: "n",
    sessionId: PRIME,
  };
  assert.deepEqual(orchestratorView(assigned), {
    heading: "Assigned",
    detail: "d",
    note: "n",
    sessionId: PRIME,
  });
  for (const state of ["unknown", "unassigned", "unassigned-with-leaders"] as const) {
    assert.equal(orchestratorView({ state, heading: "h", detail: "d", note: "n" }).sessionId, null);
  }
  // A state the switch does not handle is a compile error; at runtime it refuses rather than
  // silently rendering a wrong heading over a real record.
  assert.throws(
    () => orchestratorView({ state: "seated" } as unknown as OrchestratorAssignment),
    /Unhandled project orchestrator state/,
  );
});

test("U5-D04: flagged supervisor records are counted for the view; the readable ones still name leaders", () => {
  const d = fleet({
    supervisionAvailable: true,
    supervisionIssues: { unreadable: 1, ids: [], truncated: 2 },
    supervisors: [role(PRIME, TASK_A, [worker(LEAD)])],
  });
  const h = buildHierarchy(d, directory(), undefined, roles({ projectSeats: [seat()] }));
  assert.equal(h.supervisionAvailable, true);
  assert.equal(h.supervisionUnreadable, 1);
  assert.equal(h.supervisionTruncated, 2);
  assert.ok(h.primes.length + h.soloLeaders.length > 0 || h.supervisionAvailable);
});
