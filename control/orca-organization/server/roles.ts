import { managerDisplayName } from "../shared/manager-display";
import { localCall } from "./management";
import {
  CONTROLLER_METHOD,
  appOwnershipRecord,
  ownershipStateOf,
  placesSession,
  roleAdoptRpc,
  roleAllowanceSetRpc,
  roleAllowancesRpc,
  seatAllowance,
  type AdoptResult,
  type AllowanceSetResult,
  projectRequestSessionRpc,
  projectSession,
  roleAssignRpc,
  roleDirectoryRpc,
  roleNeed,
  roleProjectRpc,
  seatSchema,
  sessionOwnershipRpc,
  sessionRequest,
  sessionRequestsRpc,
  type AppOwnershipRecord,
  type ProjectSession,
  type RequestSessionResult,
  type RoleAssignResult,
  type Seat,
} from "../shared/roles";

/**
 * Reads and writes explicit controller role bindings on the operator lane.
 *
 * Only `bindings-status`, `bindings-project`, `bindings-assign` and `bindings-unassign` are used.
 * The controller's `bindings-self` and `channels-*` methods take a *role capability* issued to a
 * seated model, not the operator capability, and are deliberately never called from here: the
 * operator surface and a model's scoped lane are different authorities and must not be conflated.
 *
 * The operator secret is read inside `localCall`, in this server process, and framed straight onto
 * the control socket. Nothing on this path returns it, and every payload below is rebuilt field by
 * field rather than spread, so a future controller field cannot reach the renderer by accident.
 * The bound session's `cwd` is dropped here for that reason.
 *
 * A failed read is reported as `available: false` with the controller's own refusal. It is never
 * flattened into "no seats": an unreadable binding table cannot establish that a seat is empty.
 */

type Call = (method: string, input?: unknown) => Promise<any>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const asUuid = (value: unknown): string | null =>
  typeof value === "string" && UUID.test(value) ? value : null;
const asText = (value: unknown, limit: number): string | null =>
  typeof value === "string" && value ? value.slice(0, limit) : null;
const reason = (error: unknown) =>
  (error instanceof Error ? error.message : "Role bindings unavailable").slice(0, 2000);

/** Explicit allowlist. Adding a field here is a deliberate act, which is the point. */
export function seatOf(raw: any): Seat {
  const session = raw?.session;
  return seatSchema.parse({
    role: raw?.role,
    seat: String(raw?.seat ?? ""),
    projectId: asUuid(raw?.projectId),
    state: raw?.state === "assigned" ? "assigned" : "vacant",
    revision: Number.isSafeInteger(raw?.revision) && raw.revision >= 0 ? raw.revision : 0,
    task: asUuid(raw?.task),
    sessionId: asUuid(raw?.sessionId),
    // No cwd. No capability. Only what routes a conversation and fences a write.
    session:
      session && asUuid(session.id) && asUuid(session.task)
        ? {
            id: session.id,
            task: session.task,
            mode: String(session.mode ?? "unknown").slice(0, 32),
            generation: Number(session.generation),
          }
        : null,
    note: asText(raw?.note, 2000),
    at: asText(raw?.at, 64),
    membershipAt: asText(raw?.membershipAt, 64),
    sessionPresent: Boolean(raw?.sessionPresent),
    sessionGenerationChanged: Boolean(raw?.sessionGenerationChanged),
    sessionTaskMatches: Boolean(raw?.sessionTaskMatches),
    dispatch: raw?.dispatch
      ? {
          host: String(raw.dispatch.host ?? "unknown").slice(0, 32),
          supported: Boolean(raw.dispatch.supported),
          reason: asText(raw.dispatch.reason, 2000),
        }
      : null,
  });
}

/** The controller's need/blocker variants carry different keys; flatten without inventing any. */
export const needOf = (raw: any) =>
  roleNeed.parse({
    kind: String(raw?.kind ?? "unknown").slice(0, 64),
    detail: String(raw?.detail ?? "").slice(0, 2000),
    taskId: asUuid(raw?.taskId) ?? asUuid(raw?.task),
    sessionId: asUuid(raw?.sessionId),
    at: asText(raw?.at, 64),
  });

const bounded = (rows: unknown, limit: number): any[] =>
  Array.isArray(rows) ? rows.slice(0, limit) : [];

/** Membership rows from the project projection. Ownership is a separate read and never guessed. */
function sessionsOf(raw: any): ProjectSession[] {
  const out: ProjectSession[] = [];
  for (const task of bounded(raw?.tasks, 64)) {
    const taskId = asUuid(task?.taskId);
    if (!taskId) continue;
    for (const s of bounded(task?.sessions, 64)) {
      const sessionId = asUuid(s?.id);
      if (!sessionId || out.length >= 128) continue;
      out.push(
        projectSession.parse({
          sessionId,
          taskId,
          mode: String(s?.mode ?? "unknown").slice(0, 32),
          generation: Number.isSafeInteger(s?.generation) && s.generation >= 1 ? s.generation : 1,
        }),
      );
    }
  }
  return out;
}

export function createRoleDirectoryReader(
  call: Call = guardedLocalCall,
  now = () => new Date().toISOString(),
) {
  return async () => {
    const observedAt = now();
    try {
      const d = await call(CONTROLLER_METHOD.directory);
      const bindings = bounded(d?.bindings, 512).map(seatOf);
      return roleDirectoryRpc.output.parse({
        observedAt,
        available: true,
        unavailable: null,
        primes: bindings.filter((b) => b.role === "prime").slice(0, 64),
        projectSeats: bindings.filter((b) => b.role === "project-orchestrator").slice(0, 128),
        programme: asUuid(d?.programme),
        note:
          asText(d?.note, 2000) ??
          "A role binding records accountability only. It grants no task authority and sends no prompt.",
      });
    } catch (error) {
      // Not "no seats". The records could not be read, so no seat is named and none is ruled out.
      return roleDirectoryRpc.output.parse({
        observedAt,
        available: false,
        unavailable: reason(error),
        primes: [],
        projectSeats: [],
        programme: null,
        note: "Recorded leadership roles could not be read, so no orchestrator can be named or ruled out here.",
      });
    }
  };
}

export function createRoleProjectReader(
  call: Call = guardedLocalCall,
  now = () => new Date().toISOString(),
) {
  return async (input: { projectId: string }) => {
    const observedAt = now(),
      projectId = roleProjectRpc.input.parse(input).projectId;
    try {
      // The controller takes the bare project ID for this read, not an object.
      const d = await call(CONTROLLER_METHOD.project, projectId);
      const summary = d?.project?.summary;
      const m = d?.project?.membership,
        p = d?.progress;
      return roleProjectRpc.output.parse({
        observedAt,
        available: true,
        unavailable: null,
        projectId,
        summary:
          summary && asUuid(summary.id)
            ? {
                id: summary.id,
                name: String(summary.name ?? "").slice(0, 160),
                description: asText(summary.description, 2000),
                status: String(summary.status ?? "").slice(0, 64),
              }
            : null,
        membership: m
          ? {
              known: Boolean(m.known),
              available: Boolean(m.available),
              partial: Boolean(m.partial),
              observedAt: asText(m.observedAt, 64),
              memberTaskCount: Number.isSafeInteger(m.memberTaskCount) ? m.memberTaskCount : 0,
              truncated: Boolean(m.truncated),
              note: String(m.note ?? "").slice(0, 2000),
            }
          : null,
        leader: d?.leader ? seatOf(d.leader) : null,
        primes: bounded(d?.primes, 64).map(seatOf),
        progress: p
          ? {
              memberTasks: Number(p.memberTasks) || 0,
              recorded: Number(p.recorded) || 0,
              unresolved: Number(p.unresolved) || 0,
              sessions: Number(p.sessions) || 0,
              truncated: Boolean(p.truncated),
              basis: String(p.basis ?? "").slice(0, 2000),
            }
          : null,
        needed: bounded(d?.needed, 64).map(needOf),
        blockers: bounded(d?.blockers, 64).map(needOf),
        sessions: sessionsOf(d),
        note: asText(d?.note, 2000) ?? "A role binding records accountability only.",
      });
    } catch (error) {
      return roleProjectRpc.output.parse({
        observedAt,
        available: false,
        unavailable: reason(error),
        projectId,
        summary: null,
        membership: null,
        leader: null,
        primes: [],
        progress: null,
        needed: [],
        blockers: [],
        sessions: [],
        note: "Recorded leadership roles could not be read for this project, so its orchestrator is unknown rather than absent.",
      });
    }
  };
}

/** A controller that does not implement a method says so; that is unavailability, not refusal. */
const UNIMPLEMENTED =
  /unknown method|unsupported method|no such method|not implemented|unknown rpc/i;

/** Two different facts. "Not built yet" and "built, and said no" need different reactions. */
export type ControllerFailure = "unavailable" | "refused";
export const classifyControllerFailure = (text: string): ControllerFailure =>
  UNIMPLEMENTED.test(text) ? "unavailable" : "refused";

/**
 * A non-UI signal, once per method per failure kind per plugin process (one process per host).
 *
 * The UI deliberately renders a refusal as "unknown", which is right for a reader and useless for
 * an operator during activation: an unactivated controller and a dead call look identical. This
 * writes the distinction to the plugin's stderr instead, where it reaches the daemon log without
 * touching the surface.
 *
 * It can only see calls this plugin MAKES. A caller invoking a method this plugin does not
 * register never reaches this code at all - see the startup line in index.server.ts for that half.
 */
const announced = new Set<string>();
export function announceControllerFailure(
  method: string,
  text: string,
  write: (line: string) => void = (line) => console.warn(line),
) {
  const kind = classifyControllerFailure(text);
  const key = `${method}:${kind}`;
  if (announced.has(key)) return kind;
  announced.add(key);
  write(
    kind === "unavailable"
      ? `[orca-organization] controller method ${method} is NOT IMPLEMENTED by this controller - the surface will read unknown. Expected before activation; after activation this means the wrong controller is running. Reported: ${text}`
      : `[orca-organization] controller method ${method} REFUSED - the controller implements it and declined. Reported: ${text}`,
  );
  return kind;
}

/** Wraps a call so every controller failure announces itself once, without changing behaviour. */
const announcing =
  (call: Call): Call =>
  async (method, input) => {
    try {
      return await call(method, input);
    } catch (error) {
      announceControllerFailure(method, error instanceof Error ? error.message : String(error));
      throw error;
    }
  };
const guardedLocalCall: Call = announcing(localCall);

/**
 * Ask a seat for a session.
 *
 * `roles-request-session` accepts a closed key set — expectedRevision, note, provider, seat,
 * taskId, title — so exactly those six are sent and nothing else. It publishes a *request* row;
 * it does not return a session, and this never claims one was created.
 *
 * Two independent refusals are expected and are surfaced rather than retried: the seat revision
 * fence ("the seat changed"), and the seat's own operator allowance being exhausted or pinned to a
 * different revision. A current seat can still correctly refuse — the allowance exists so a seat
 * is not woken for work it could not do. Per-seat open-request and history bounds refuse likewise.
 */
export function createSessionRequest(
  call: Call = guardedLocalCall,
  now = () => new Date().toISOString(),
) {
  return async (value: unknown): Promise<RequestSessionResult> => {
    const input = projectRequestSessionRpc.input.parse(value),
      observedAt = now();
    const base = { observedAt, requestId: null, state: null, grantsAuthority: false as const };
    try {
      // Exactly the validator's accepted keys. No projectId, no role, no identity, no claim.
      const d = await call(CONTROLLER_METHOD.requestSession, {
        expectedRevision: input.expectedRevision,
        note: input.reason,
        provider: input.provider,
        seat: input.seat,
        taskId: input.taskId,
        title: input.title,
      });
      const state = asText(d?.state, 32),
        requestId = asUuid(d?.requestId) ?? asUuid(d?.id);
      if (!requestId) {
        return {
          ...base,
          status: "refused",
          message:
            "The controller did not return a request record, so nothing was asked of the seat.",
        };
      }
      return {
        ...base,
        status: "requested",
        requestId,
        state,
        message: `Requested from this project's orchestrator${state ? ` · ${state}` : ""}. The seat has been asked; no session exists yet and none is shown until the controller reports one.`,
      };
    } catch (error) {
      const text = reason(error);
      if (UNIMPLEMENTED.test(text)) {
        return {
          ...base,
          status: "unavailable",
          message: `This controller does not expose seat session requests yet, so work cannot be routed through a project orchestrator here. Nothing was requested. Controller reported: ${text}`,
        };
      }
      return { ...base, status: "refused", message: `${text} Nothing was requested.` };
    }
  };
}

/** Outstanding requests, so an asked-for session is visible before any session exists. */
export function createSessionRequestsReader(
  call: Call = guardedLocalCall,
  now = () => new Date().toISOString(),
) {
  return async () => {
    const observedAt = now();
    try {
      const d = await call(CONTROLLER_METHOD.sessionRequests);
      const rows = bounded(d?.requests ?? d, 128).flatMap((r) => {
        const requestId = asUuid(r?.requestId) ?? asUuid(r?.id);
        if (!requestId) return [];
        return [
          sessionRequest.parse({
            requestId,
            seat: String(r?.seat ?? "").slice(0, 64),
            seatRole: asText(r?.seatRole ?? r?.role, 32),
            taskId: asUuid(r?.taskId),
            provider: asText(r?.provider, 32),
            title: asText(r?.title, 160),
            state: asText(r?.state, 32) ?? "unknown",
            sessionId: asUuid(r?.sessionId),
            at: asText(r?.at, 64),
            detail: asText(r?.detail, 2000),
          }),
        ];
      });
      return sessionRequestsRpc.output.parse({
        observedAt,
        available: true,
        unavailable: null,
        requests: rows,
      });
    } catch (error) {
      return sessionRequestsRpc.output.parse({
        observedAt,
        available: false,
        unavailable: reason(error),
        requests: [],
      });
    }
  };
}

/**
 * The seam the app reads. Resolves ids to names, which the controller does not do.
 *
 * `roles-ownership` takes a bare session UUID, so agent ids are first mapped to controller session
 * ids through the fleet observation. Leader identity comes from the owning seat's bound session,
 * resolved back to its agent id the same way.
 *
 * All three controller states are carried. `unknown` is a **record** with null project fields, not
 * `null`: on this wire `null` means only "not a resolvable controller session". Collapsing the two
 * would make a session the controller cannot place render like one positively known to be unowned.
 */
export function createSessionOwnershipReader(
  call: Call = guardedLocalCall,
  readFleet: () => Promise<{
    nodes: Array<{ id: string; agentId: string | null; task: string; title: string }>;
    tasks: Array<{ id: string; title: string }>;
  }>,
  readProjects: () => Promise<{
    available: boolean;
    projects: Array<{ id: string; name: string }>;
  }>,
) {
  return async (value: unknown) => {
    const { agentIds } = sessionOwnershipRpc.input.parse(value);
    const ownership: Record<string, AppOwnershipRecord | null> = {};
    for (const agentId of agentIds) ownership[agentId] = null;
    if (!agentIds.length) return sessionOwnershipRpc.output.parse({ ownership });

    let fleet, directory;
    try {
      [fleet, directory] = await Promise.all([readFleet(), readProjects()]);
    } catch {
      return sessionOwnershipRpc.output.parse({ ownership });
    }

    const byAgent = new Map<string, { id: string; task: string }>();
    const agentOf = new Map<string, string>();
    for (const n of fleet.nodes) {
      if (n.agentId) {
        byAgent.set(n.agentId, { id: n.id, task: n.task });
        agentOf.set(n.id, n.agentId);
      }
    }
    // Nothing on screen is a controller session: no ownership read, and no seat read either.
    const wanted = [...new Set(agentIds)].slice(0, 128).filter((a) => byAgent.has(a));
    if (!wanted.length) return sessionOwnershipRpc.output.parse({ ownership });

    const titleOf = new Map(fleet.nodes.map((n) => [n.id, n.title]));
    const taskTitle = new Map(fleet.tasks.map((t) => [t.id, t.title]));
    const projectName = new Map(
      directory.available ? directory.projects.map((p) => [p.id, p.name]) : [],
    );
    // Seat -> bound session, so an owning seat can be resolved to a nameable leader.
    const seatSession = new Map<string, string>();
    try {
      for (const b of bounded((await call(CONTROLLER_METHOD.directory))?.bindings, 512)) {
        const sid = asUuid(b?.sessionId);
        if (sid && b?.seat) seatSession.set(`${String(b.role)}|${String(b.seat)}`, sid);
      }
    } catch {
      /* No directory: the leader stays unnamed rather than guessed. */
    }

    for (const agentId of wanted) {
      const node = byAgent.get(agentId)!;
      try {
        const raw = await call(CONTROLLER_METHOD.ownership, node.id);
        // Normalised once: an unrecognised wire value is `unknown`, never a concrete state.
        const state = ownershipStateOf(asText(raw?.ownership, 32));
        const projectId = asUuid(raw?.projectId);
        const detail = asText(raw?.detail, 2000);
        if (state === "managed") {
          const leaderSession = asUuid(raw?.parentSession);
          const leader =
            leaderSession &&
            fleet.nodes.find(
              (n) => n.id === leaderSession && n.task === node.task && n.id !== node.id,
            );
          if (
            raw?.sessionId === node.id &&
            leaderSession &&
            leaderSession !== node.id &&
            (!fleet.nodes.some((n) => n.id === leaderSession) || leader)
          ) {
            ownership[agentId] = appOwnershipRecord.parse({
              state: "managed",
              projectId: null,
              projectName: null,
              taskId: node.task,
              taskTitle: taskTitle.get(node.task) ?? null,
              leaderAgentId: leader ? leader.agentId : null,
              leaderTitle: managerDisplayName(leader ? leader.title : null),
              detail: `Managed by ${managerDisplayName(leader ? leader.title : null)}; role-session: n/a. Inspect and instruct through the manager route.`,
            });
            continue;
          }
        }
        if (!placesSession(state) || !projectId) {
          // Carried, not dropped: the controller answered and could not place this session.
          ownership[agentId] = appOwnershipRecord.parse({
            projectId: null,
            projectName: null,
            taskId: node.task,
            taskTitle: taskTitle.get(node.task) ?? null,
            leaderAgentId: null,
            leaderTitle: null,
            state: "unknown",
            detail,
          });
          continue;
        }
        // `declared` is owned by the project but led by nobody, so a leader is only resolved when
        // the controller actually names a seat and that seat has a bound session.
        const seatKey = raw?.seat
          ? `${String(raw?.seatRole ?? "project-orchestrator")}|${String(raw.seat)}`
          : null;
        const leaderSession = seatKey ? (seatSession.get(seatKey) ?? null) : null;
        ownership[agentId] = appOwnershipRecord.parse({
          projectId,
          projectName: projectName.get(projectId) ?? null,
          taskId: node.task,
          taskTitle: taskTitle.get(node.task) ?? null,
          leaderAgentId: leaderSession ? (agentOf.get(leaderSession) ?? null) : null,
          leaderTitle: leaderSession ? (titleOf.get(leaderSession) ?? null) : null,
          // Carried verbatim. No ternary chain, so a new placing state cannot be relabelled.
          state,
          detail,
        });
      } catch {
        /* Leave null: an unreadable ownership row establishes nothing at all. */
      }
    }
    return sessionOwnershipRpc.output.parse({ ownership });
  };
}

/**
 * Adopt a declared session into a seat. Operator-only, and it spends the seat's allowance — an
 * allowance bounding only what a seat *started* would bound nothing, since a seat at its limit
 * could keep growing by having sessions declared and then adopted.
 */
export function createRoleAdopt(
  call: Call = guardedLocalCall,
  now = () => new Date().toISOString(),
) {
  return async (value: unknown): Promise<AdoptResult> => {
    const input = roleAdoptRpc.input.parse(value),
      observedAt = now();
    const base = {
      observedAt,
      sessionId: null,
      seat: input.seat,
      remaining: null,
      grantsAuthority: false as const,
    };
    try {
      // Exactly the validator's keys. `request` is the creation record, not the session id.
      const d = await call(CONTROLLER_METHOD.adopt, {
        expectedRevision: input.expectedRevision,
        note: input.reason,
        request: input.request,
        seat: input.seat,
      });
      const remaining = Number.isSafeInteger(d?.remaining) ? d.remaining : null;
      return {
        ...base,
        status: "adopted",
        sessionId: asUuid(d?.sessionId),
        remaining,
        message: `Adopted into this seat. The session is now led by it${remaining === null ? "" : `; ${remaining} of the seat's session allowance ${remaining === 1 ? "remains" : "remain"}`}. Adoption spends allowance, and grants the seat no authority over the session's task.`,
      };
    } catch (error) {
      const text = reason(error);
      if (UNIMPLEMENTED.test(text)) {
        return {
          ...base,
          status: "unavailable",
          message: `This controller does not expose adoption yet, so a declared session cannot be placed under a seat here. Nothing was changed. Controller reported: ${text}`,
        };
      }
      return { ...base, status: "refused", message: `${text} Nothing was adopted.` };
    }
  };
}

/** Seat allowances, so the surface can say why a seat will refuse before a reason is written. */
export function createAllowancesReader(
  call: Call = guardedLocalCall,
  now = () => new Date().toISOString(),
) {
  return async () => {
    const observedAt = now();
    try {
      const d = await call(CONTROLLER_METHOD.allowances);
      const rows = bounded(d?.allowances ?? d, 128).flatMap((a) => {
        if (!a?.seat) return [];
        const limit = Number.isSafeInteger(a?.limit)
          ? a.limit
          : Number.isSafeInteger(a?.max)
            ? a.max
            : null;
        const used = Number.isSafeInteger(a?.used) ? a.used : null;
        const remaining = Number.isSafeInteger(a?.remaining)
          ? a.remaining
          : limit !== null && used !== null
            ? Math.max(0, limit - used)
            : null;
        return [
          seatAllowance.parse({
            seat: String(a.seat).slice(0, 64),
            role: asText(a?.role, 32),
            revision: Number.isSafeInteger(a?.revision) ? a.revision : null,
            limit,
            used,
            remaining,
            current: a?.current !== false,
            detail: asText(a?.detail, 2000),
          }),
        ];
      });
      return roleAllowancesRpc.output.parse({
        observedAt,
        available: true,
        unavailable: null,
        allowances: rows,
      });
    } catch (error) {
      return roleAllowancesRpc.output.parse({
        observedAt,
        available: false,
        unavailable: reason(error),
        allowances: [],
      });
    }
  };
}

/** Grant or change a seat's allowance, fenced on the observed seat revision. */
export function createAllowanceSet(
  call: Call = guardedLocalCall,
  now = () => new Date().toISOString(),
) {
  return async (value: unknown): Promise<AllowanceSetResult> => {
    const input = roleAllowanceSetRpc.input.parse(value),
      observedAt = now();
    const base = {
      observedAt,
      seat: input.seat,
      maxSessions: null,
      remaining: null,
      grantsAuthority: false as const,
    };
    try {
      // Exactly the validator's keys: role is required, and the bound is maxSessions not limit.
      const d = await call(CONTROLLER_METHOD.allowanceSet, {
        expectedRevision: input.expectedRevision,
        maxSessions: input.maxSessions,
        note: input.reason,
        role: input.role,
        seat: input.seat,
      });
      const maxSessions = Number.isSafeInteger(d?.maxSessions)
        ? d.maxSessions
        : Number.isSafeInteger(d?.limit)
          ? d.limit
          : input.maxSessions;
      const remaining = Number.isSafeInteger(d?.remaining) ? d.remaining : null;
      return {
        ...base,
        status: "granted",
        maxSessions,
        remaining,
        message: `This seat may now be asked for ${maxSessions} ${maxSessions === 1 ? "session" : "sessions"} at its current revision. The allowance is pinned to that revision: replacing the leader resets it and the successor needs a fresh grant. It grants no authority.`,
      };
    } catch (error) {
      const text = reason(error);
      if (UNIMPLEMENTED.test(text)) {
        return {
          ...base,
          status: "unavailable",
          message: `This controller does not expose allowance grants yet. Nothing was changed. Controller reported: ${text}`,
        };
      }
      return { ...base, status: "refused", message: `${text} The allowance was not changed.` };
    }
  };
}

const ACTION: Record<string, RoleAssignResult["status"]> = {
  assign: "assigned",
  replace: "replaced",
  reaffirm: "reaffirmed",
  unassign: "vacated",
};

/**
 * Assign, replace or vacate. The revision and generation fences come from what the caller actually
 * observed; the controller refuses a stale writer, and that refusal is surfaced verbatim rather
 * than retried. Nothing here starts a session, sends a prompt or grants authority.
 */
export function createRoleAssign(
  call: Call = guardedLocalCall,
  now = () => new Date().toISOString(),
) {
  return async (value: unknown): Promise<RoleAssignResult> => {
    const input = roleAssignRpc.input.parse(value),
      observedAt = now();
    const fail = (message: string): RoleAssignResult => ({
      status: "error",
      message: message.slice(0, 2000),
      observedAt,
      role: input.role,
      seat: input.seat,
      revision: null,
      sessionId: null,
      previousSessionId: null,
      grantsAuthority: false,
    });
    try {
      const d =
        input.action === "assign"
          ? await call(CONTROLLER_METHOD.assign, {
              role: input.role,
              seat: input.seat,
              sessionId: input.sessionId,
              expectedRevision: input.expectedRevision,
              expectedSessionGeneration: input.expectedSessionGeneration,
              note: input.reason,
            })
          : await call(CONTROLLER_METHOD.unassign, {
              role: input.role,
              seat: input.seat,
              expectedRevision: input.expectedRevision,
              note: input.reason,
            });
      const status = ACTION[String(d?.action)] ?? "error";
      if (status === "error")
        return fail("The controller did not report a recognised role action.");
      return {
        status,
        observedAt,
        role: input.role,
        seat: input.seat,
        revision: Number.isSafeInteger(d?.revision) ? d.revision : null,
        sessionId: asUuid(d?.sessionId),
        previousSessionId: asUuid(d?.previousSessionId),
        grantsAuthority: false,
        message:
          status === "vacated"
            ? "Seat vacated. The session keeps its own task and control; only the accountability record changed."
            : status === "replaced"
              ? "Seat reassigned to the named session. The previous holder keeps its own task and control; no work moved and nothing was sent."
              : status === "reaffirmed"
                ? "The same session is recorded again for this seat. Nothing else changed."
                : "Seat assigned. This records accountability only: no task authority, no delegation, no prompt.",
      };
    } catch (error) {
      return fail(reason(error));
    }
  };
}
