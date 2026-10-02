import type { Fleet } from "../shared/fleet";
import type { ProjectDirectory } from "../shared/projects";
import type { Briefing } from "../shared/briefing";
import type { RoleDirectory, Seat } from "../shared/roles";

/**
 * Leadership structure derived only from recorded controller relationships.
 *
 * Two levels exist in the actual data. A supervisor record binds one session to one task, and a
 * supervisor's linked worker may itself be a supervisor, which is a recorded leader-of-leaders.
 * Nothing binds a session to a *project* yet, so a project orchestrator is never derived here: the
 * project view reports which leaders were recorded inside it and states that the role is
 * unassigned. See README "Leadership hierarchy" for the backend binding this still needs.
 *
 * Saved sessions are never treated as activity. Counts below describe recorded relationships and
 * published briefs; runtime state stays with the fleet node and its own freshness rules.
 *
 * Every read behind this module is a *bounded observation*: `fleet.tasks` and `briefing.entries`
 * are capped at 64 for the whole deployment, `directory.membership` at 1000, and each response
 * carries its own coverage flags. Those flags are carried through to the view instead of being
 * dropped, because an absence inside one page is not an absence in the deployment. Anything this
 * module reports as *none* is paired with a `complete` flag saying whether "none" was observable.
 */

export const UNGROUPED_PROJECT = "ungrouped";
const TRAVERSAL_LIMIT = 64;
const ROLE_BINDING_NOTE =
  "Naming a project orchestrator records who is accountable for the project. It does not start, stop or message any session.";

type Supervisor = NonNullable<Fleet["supervisors"]>[number];

/** How much of a bounded read actually backed a count. `complete` false ⇒ never claim "none". */
export interface Coverage {
  /** False when the read returned nothing at all, which is not the same as returning nothing. */
  available: boolean;
  complete: boolean;
  scanned: number;
  total: number;
  missing: number;
  unavailable: number;
  morePages: boolean;
}

export interface LeaderView {
  sessionId: string;
  taskId: string;
  active: boolean;
  workers: number;
  /** Linked workers that hold a supervisor record of their own. */
  leads: string[];
  unresolvedWorkers: number;
  waitingAcknowledgement: number;
  faults: number;
}

export interface PrimeView extends LeaderView {
  /** Project ids reached through this leader's own task and its sub-leaders' tasks. */
  reaches: string[];
  /** False when project grouping was unavailable or partial, so reach cannot be ruled out. */
  reachKnown: boolean;
  reachedTasks: string[];
  /** A sub-leader relationship that loops back; shown rather than silently trimmed. */
  cyclic: boolean;
  /** The traversal limit was hit, so `reachedTasks` and `reaches` are lower bounds. Not a loop. */
  truncated: boolean;
}

/**
 * `assigned` is now constructed from a real controller role binding — an explicit
 * `projectId → sessionId` seat read through `organization.role-directory`. It is never derived
 * from supervision shape: a leader recorded inside a project is not accountable for the project,
 * which is the distinction this whole surface exists to keep.
 *
 * `unknown` and `unassigned` are kept apart deliberately. An unreadable binding table cannot name
 * a leader *or* rule one out, so it reports unknown; only a successful read of a vacant seat is
 * allowed to say no orchestrator is assigned.
 */
export type OrchestratorAssignment =
  | { state: "unknown"; heading: string; detail: string; note: string }
  | { state: "unassigned"; heading: string; detail: string; note: string }
  | { state: "unassigned-with-leaders"; heading: string; detail: string; note: string }
  | { state: "assigned"; heading: string; detail: string; note: string; sessionId: string };

/**
 * The one place the orchestrator role is turned into display. Exhaustive over every state, so
 * adding a variant — the durable project role binding included — is a compile error here rather
 * than a silent fall-through to "Unassigned" over a genuinely assigned orchestrator.
 */
export function orchestratorView(orchestrator: OrchestratorAssignment): {
  heading: string;
  detail: string;
  note: string;
  sessionId: string | null;
} {
  switch (orchestrator.state) {
    case "unknown":
    case "unassigned":
    case "unassigned-with-leaders":
      return {
        heading: orchestrator.heading,
        detail: orchestrator.detail,
        note: orchestrator.note,
        sessionId: null,
      };
    case "assigned":
      return {
        heading: orchestrator.heading,
        detail: orchestrator.detail,
        note: orchestrator.note,
        sessionId: orchestrator.sessionId,
      };
    default: {
      const unhandled: never = orchestrator;
      throw new Error(`Unhandled project orchestrator state: ${JSON.stringify(unhandled)}`);
    }
  }
}

export interface ProjectNeed {
  taskId: string;
  title: string;
  text: string;
  verified: boolean;
}

/** Published status for one workstream: what it reports it is doing and where it has got to. */
export interface ProjectStatus {
  taskId: string;
  title: string;
  outcome: string;
  currentState: string;
}

export interface ProjectLeadership {
  id: string;
  name: string;
  status: string | null;
  description: string | null;
  taskIds: string[];
  leaders: LeaderView[];
  orchestrator: OrchestratorAssignment;
  /** The explicit seat behind `orchestrator`, carrying the revision an operator write must fence on. */
  seat: Seat | null;
  statuses: ProjectStatus[];
  decisions: ProjectNeed[];
  nextActions: ProjectNeed[];
  dependencies: ProjectNeed[];
  briefed: number;
  /** Workstreams of this project that were checked and carry no brief on what was read. */
  unbriefed: number;
  /** Coverage behind `briefed`/`unbriefed`; `complete` false ⇒ "none" is not established. */
  briefCoverage: Coverage;
  /** False when the task list or its grouping was itself partial, so leaders may be missing. */
  membershipComplete: boolean;
}

export interface Hierarchy {
  supervisionAvailable: boolean;
  /** U5-D04: supervisor records the fleet could not read (flagged; the rest are shown), and any beyond the display bound. */
  supervisionUnreadable: number;
  supervisionTruncated: number;
  /** Explicit prime seats. These, not supervision shape, are what a prime orchestrator *is*. */
  primeSeats: Seat[];
  rolesAvailable: boolean;
  /** The controller's own refusal when the binding table could not be read. */
  rolesUnavailable: string | null;
  /** Recorded leader-of-leaders relationships. Supporting evidence, never a role by itself. */
  primes: PrimeView[];
  /** Recorded leaders with no leader above them and no leader below them. */
  soloLeaders: LeaderView[];
  projects: ProjectLeadership[];
  projectsAvailable: boolean;
  /** The directory answered but could not return all of its grouping. */
  projectsPartial: boolean;
  /** The fleet read could not return all work or team members. */
  fleetPartial: boolean;
  briefCoverage: Coverage;
  tasksWithoutLeader: number;
  /** False when `tasksWithoutLeader` was counted from a partial task list. */
  tasksWithoutLeaderComplete: boolean;
}

function leaderView(role: Supervisor, leaderIds: Set<string>): LeaderView {
  const linked = role.workers.filter((w) => w.ownership === "linked" && w.workerId);
  return {
    sessionId: role.id,
    taskId: role.task,
    active: role.active,
    workers: role.workers.length,
    leads: linked.filter((w) => leaderIds.has(w.workerId!)).map((w) => w.workerId!),
    unresolvedWorkers: role.workers.filter((w) => w.ownership !== "linked").length,
    waitingAcknowledgement: role.workers.filter((w) => w.lastEvent && !w.lastEvent.consumed).length,
    faults: role.workers.filter((w) => w.fault).length,
  };
}

/**
 * Bounded walk down recorded sub-leader links. A link that returns to an already visited session
 * is a loop and is reported as one. Exhausting `TRAVERSAL_LIMIT` with work still queued is
 * truncation, which is a different fact: the hierarchy is deeper than we followed, not circular.
 */
function span(start: LeaderView, byId: Map<string, LeaderView>) {
  const tasks = new Set([start.taskId]),
    seen = new Set([start.sessionId]);
  let queue = [...start.leads],
    cyclic = false;
  while (queue.length && seen.size < TRAVERSAL_LIMIT) {
    const next = queue.shift()!;
    if (seen.has(next)) {
      cyclic = true;
      continue;
    }
    seen.add(next);
    const sub = byId.get(next);
    if (!sub) continue;
    tasks.add(sub.taskId);
    queue = queue.concat(sub.leads);
  }
  return { tasks: [...tasks], cyclic, truncated: queue.length > 0 };
}

/**
 * Turns one explicit seat into the sentence the project header shows. A seat whose bound session
 * has drifted — gone from the journal, re-enrolled on another task, or its control regenerated —
 * is still *assigned*; saying otherwise would erase a real accountability record. The drift is
 * named instead, because it is what the operator has to act on.
 */
function assignedFrom(seat: Seat): OrchestratorAssignment {
  const drift = !seat.sessionPresent
    ? " The bound session is no longer saved in the journal, so this record names an accountable session that cannot currently be opened."
    : !seat.sessionTaskMatches
      ? " The bound session is now enrolled on a different task than the one whose project membership was verified."
      : seat.sessionGenerationChanged
        ? " Control of the bound session has changed since the seat was recorded; re-confirm before relying on it."
        : "";
  const remote =
    seat.dispatch && !seat.dispatch.supported
      ? ` ${seat.dispatch.reason ?? "This seat's session cannot be reached from here."}`
      : "";
  return {
    state: "assigned",
    heading: "Assigned",
    detail: `A recorded controller role binding names this session as the project orchestrator.${drift}${remote}`,
    note: ROLE_BINDING_NOTE,
    sessionId: seat.sessionId!,
  };
}

const ROLES_UNREADABLE =
  "Recorded leadership roles could not be read, so no project orchestrator can be named or ruled out. This is not the same as the seat being empty.";

export function buildHierarchy(
  fleet?: Fleet,
  directory?: ProjectDirectory,
  briefing?: Briefing,
  roles?: RoleDirectory,
): Hierarchy {
  const supervisionAvailable = fleet?.supervisionAvailable === true;
  const supervisorRows = supervisionAvailable ? (fleet?.supervisors ?? []) : [];
  const leaderIds = new Set(supervisorRows.map((r) => r.id));
  const leaders = supervisorRows.map((row) => leaderView(row, leaderIds));
  const byId = new Map(leaders.map((l) => [l.sessionId, l]));
  const ledBy = new Set(leaders.flatMap((l) => l.leads));

  const projectsAvailable = directory?.available === true;
  const projectsPartial = projectsAvailable && directory!.partial === true;
  const fleetPartial = fleet?.partial === true;
  const groupingComplete = projectsAvailable && !projectsPartial && !fleetPartial;

  const briefCoverage: Coverage = briefing
    ? {
        available: true,
        complete:
          !briefing.partial &&
          briefing.nextCursor === null &&
          briefing.unavailable === 0 &&
          !fleetPartial,
        scanned: briefing.scanned,
        total: briefing.total,
        missing: briefing.missing,
        unavailable: briefing.unavailable,
        morePages: briefing.nextCursor !== null,
      }
    : {
        available: false,
        complete: false,
        scanned: 0,
        total: 0,
        missing: 0,
        unavailable: 0,
        morePages: false,
      };

  const primes: PrimeView[] = [],
    soloLeaders: LeaderView[] = [];
  const membership = new Map(
    projectsAvailable ? directory!.membership.map((m) => [m.taskId, m.projectId]) : [],
  );
  for (const leader of leaders) {
    if (ledBy.has(leader.sessionId)) continue;
    if (!leader.leads.length) {
      soloLeaders.push(leader);
      continue;
    }
    const reach = span(leader, byId);
    const reaches = [
      ...new Set(
        reach.tasks
          .map((id) => membership.get(id) ?? null)
          .filter((id): id is string => id !== null),
      ),
    ];
    primes.push({
      ...leader,
      reachedTasks: reach.tasks,
      reaches,
      reachKnown: groupingComplete && !reach.truncated,
      cyclic: reach.cyclic,
      truncated: reach.truncated,
    });
  }

  const entries = new Map((briefing?.entries ?? []).map((e) => [e.taskId, e]));
  const tasks = new Map((fleet?.tasks ?? []).map((t) => [t.id, t]));

  // Every task any read mentioned, not just the ones that fit on the capped fleet page. A task
  // named only by membership or only by a brief is still a task this project contains.
  const allTaskIds = new Set<string>([
    ...(fleet?.tasks ?? []).map((t) => t.id),
    ...membership.keys(),
    ...entries.keys(),
  ]);
  const buckets = new Map<string, string[]>();
  for (const taskId of allTaskIds) {
    // Directory membership is authoritative; a brief's own `projectId` fills a gap only when the
    // directory answered, so an unavailable directory still reads as ungrouped rather than guessed.
    const projectId =
      membership.get(taskId) ??
      (projectsAvailable ? (entries.get(taskId)?.projectId ?? null) : null);
    const key = projectId ?? UNGROUPED_PROJECT;
    buckets.set(key, [...(buckets.get(key) ?? []), taskId]);
  }

  const listed = projectsAvailable
    ? directory!.projects.map((p) => ({
        id: p.id,
        name: p.name,
        status: p.status,
        description: p.description,
      }))
    : [];
  const known = new Set(listed.map((p) => p.id));
  const extra = [...buckets.keys()].filter((key) => key !== UNGROUPED_PROJECT && !known.has(key));
  const shells = [
    ...listed,
    ...extra.map((id) => ({
      id,
      name: "Project not in the directory",
      status: null,
      description: null,
    })),
    ...(buckets.has(UNGROUPED_PROJECT) || !projectsAvailable
      ? [
          {
            id: UNGROUPED_PROJECT,
            name: "Work without a recorded project",
            status: null,
            description: null,
          },
        ]
      : []),
  ];

  const rolesAvailable = roles?.available === true;
  const seats = new Map(
    (roles?.projectSeats ?? []).filter((s) => s.projectId).map((s) => [s.projectId!, s]),
  );

  const observed = groupingComplete ? "" : " in what could be observed";
  const projects = shells.map<ProjectLeadership>((shell) => {
    const taskIds = buckets.get(shell.id) ?? [];
    const memberLeaders = leaders.filter((l) => taskIds.includes(l.taskId));
    const need = (text: string | null, taskId: string, verified = true): ProjectNeed[] =>
      text
        ? [
            {
              taskId,
              title:
                tasks.get(taskId)?.title ??
                entries.get(taskId)?.title ??
                "Workstream name unavailable",
              text,
              verified,
            },
          ]
        : [];
    const statuses: ProjectStatus[] = [],
      decisions: ProjectNeed[] = [],
      nextActions: ProjectNeed[] = [],
      dependencies: ProjectNeed[] = [];
    let briefed = 0;
    for (const taskId of taskIds) {
      const entry = entries.get(taskId);
      if (!entry) continue;
      briefed++;
      statuses.push({
        taskId,
        title: tasks.get(taskId)?.title ?? entry.title,
        outcome: entry.outcome,
        currentState: entry.currentState,
      });
      decisions.push(...need(entry.question, taskId));
      nextActions.push(...need(entry.nextStep, taskId));
      for (const dep of entry.dependencies)
        dependencies.push({
          taskId,
          title: dep.title ?? "Work that cannot be verified",
          text: dep.reason,
          verified: dep.taskId !== null,
        });
    }
    const leadersComplete = groupingComplete;
    const seat = shell.id === UNGROUPED_PROJECT ? null : (seats.get(shell.id) ?? null);
    const assigned = seat && seat.state === "assigned" && seat.sessionId ? seat : null;
    return {
      ...shell,
      taskIds,
      leaders: memberLeaders,
      seat,
      // Order matters. An explicit seat is the answer whenever one was actually read; only when
      // the role records are unreadable does this fall back to "unknown", and only a successful
      // read of an empty seat is permitted to say "unassigned".
      orchestrator: assigned
        ? assignedFrom(assigned)
        : !rolesAvailable
          ? {
              state: "unknown",
              heading: "Unknown",
              detail: ROLES_UNREADABLE,
              note: roles?.unavailable
                ? `Controller reported: ${roles.unavailable}`
                : ROLE_BINDING_NOTE,
            }
          : shell.id === UNGROUPED_PROJECT
            ? {
                state: "unknown",
                heading: "Not applicable",
                detail:
                  "Work without a recorded project has no project seat to fill. A project orchestrator is bound to a registered project, never to a task.",
                note: ROLE_BINDING_NOTE,
              }
            : memberLeaders.length
              ? {
                  state: "unassigned-with-leaders",
                  heading: "Unassigned",
                  detail: `This project's orchestrator seat is recorded as empty. ${memberLeaders.length} recorded ${memberLeaders.length === 1 ? "leader leads a workstream" : "leaders lead workstreams"} inside it${observed}; leading a workstream is not accountability for the project.`,
                  note: ROLE_BINDING_NOTE,
                }
              : leadersComplete
                ? {
                    state: "unassigned",
                    heading: "Unassigned",
                    detail:
                      "This project's orchestrator seat is recorded as empty, and no workstream leader is recorded here.",
                    note: ROLE_BINDING_NOTE,
                  }
                : {
                    state: "unassigned",
                    heading: "Unassigned",
                    detail:
                      "This project's orchestrator seat is recorded as empty. No workstream leader is recorded in what could be observed either, and work or grouping was missing from this read, so a leader here is not ruled out.",
                    note: ROLE_BINDING_NOTE,
                  },
      statuses,
      decisions,
      nextActions,
      dependencies,
      briefed,
      unbriefed: taskIds.length - briefed,
      briefCoverage,
      membershipComplete: leadersComplete,
    };
  });

  return {
    supervisionAvailable,
    supervisionUnreadable: fleet?.supervisionIssues?.unreadable ?? 0,
    supervisionTruncated: fleet?.supervisionIssues?.truncated ?? 0,
    primes,
    soloLeaders,
    projects,
    projectsAvailable,
    projectsPartial,
    fleetPartial,
    briefCoverage,
    rolesAvailable,
    rolesUnavailable: roles && !roles.available ? roles.unavailable : null,
    primeSeats: rolesAvailable ? roles!.primes.filter((s) => s.state === "assigned") : [],
    tasksWithoutLeader: supervisionAvailable
      ? (fleet?.tasks ?? []).filter((t) => !leaders.some((l) => l.taskId === t.id)).length
      : 0,
    tasksWithoutLeaderComplete: supervisionAvailable && !fleetPartial,
  };
}
