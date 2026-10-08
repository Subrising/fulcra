import { localCall } from "./management";
import { readIssues } from "./tasks";
import { needOf, seatOf } from "./roles";
import { ownershipStateOf } from "../shared/roles";
import type { Fleet } from "../shared/fleet";
import type { ProjectDirectory } from "../shared/projects";
import {
  WORK_MAP_READS,
  mapAttention,
  mapRuntime,
  mapSeat,
  workMapOverview,
  workMapProject,
  type MapAttention,
  type MapRuntime,
  type MapSeat,
  type WorkMapOverview,
  type WorkMapProject,
} from "../shared/work-map";
import {
  linkedIssue,
  linkedIssuesResult,
  normalizeIssueState,
  type IssueRef,
  type LinkedIssue,
  type LinkedIssueProvider,
  type LinkedIssuesResult,
} from "../shared/linked-issues";

/**
 * The Fulcra work map reader. Read-only by construction:
 *
 * - Every controller call goes through `allowlisted`, which refuses any method outside
 *   `WORK_MAP_READS` before a byte reaches the socket.
 * - Every object is rebuilt field by field (`seatOf`, `runtimeOf`, `sessionOf`), never spread, so a
 *   new controller field — a `cwd`, a capability, a grant path — cannot reach the renderer. The
 *   output schemas are strict and would refuse it anyway.
 * - It never calls a method that returns message text (`channels-thread`, `seat-inbox`,
 *   `events-inbox`, `inspect`, `observe`), and from `channels-status` it keeps only seat pairs and state.
 *
 * A failed read is reported as unavailable, never as absence: an unreadable seat table cannot
 * establish that a project has no orchestrator.
 */

type Call = (method: string, input?: unknown) => Promise<any>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const asUuid = (value: unknown): string | null =>
  typeof value === "string" && UUID.test(value) ? value : null;
const clip = (value: unknown, limit: number): string | null =>
  typeof value === "string" && value ? value.slice(0, limit) : null;
const bounded = (rows: unknown, limit: number): any[] =>
  Array.isArray(rows) ? rows.slice(0, limit) : [];
const reason = (error: unknown) =>
  (error instanceof Error ? error.message : "Unavailable").slice(0, 2000);
const nonNegative = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : 0;

export class WorkMapReadRefused extends Error {}

/** The only path to the controller. A method outside the allowlist throws without being sent. */
export function allowlisted(call: Call): Call {
  const allowed = new Set<string>(WORK_MAP_READS);
  return (method, input) => {
    if (!allowed.has(method))
      return Promise.reject(new WorkMapReadRefused(`Work map may not call ${method}`));
    return call(method, input);
  };
}

interface Hold {
  role: string;
  seat: string;
  revision: number;
  effective: boolean;
}
function holdsOf(raw: any): Hold[] {
  return bounded(raw?.holds, 512).map((h) => ({
    role: String(h?.role ?? ""),
    seat: String(h?.seat ?? ""),
    revision: nonNegative(h?.revision),
    effective: h?.effective === true,
  }));
}

/** The staged plugin's field-by-field seat, plus the hold, with the operator note shortened for display. */
export function mapSeatOf(raw: any, holds: Hold[]): MapSeat {
  const seat = seatOf(raw);
  const mine = holds.filter((h) => h.role === seat.role && h.seat === seat.seat);
  const hold = mine.some((h) => h.effective && h.revision === seat.revision)
    ? ("effective" as const)
    : mine.length
      ? ("declared" as const)
      : null;
  return mapSeat.parse({ ...seat, note: seat.note ? seat.note.slice(0, 280) : null, hold });
}

export function runtimeOf(node: Fleet["nodes"][number] | undefined): MapRuntime | null {
  if (!node) return null;
  return mapRuntime.parse({
    title: node.title.slice(0, 160),
    provider: node.provider.slice(0, 64),
    model: node.model ? node.model.slice(0, 64) : null,
    host: node.host,
    status: node.status.slice(0, 32),
    pending: node.pending ?? null,
    error: node.error ? node.error.slice(0, 200) : null,
    updatedAt: node.updatedAt ? node.updatedAt.slice(0, 64) : null,
  });
}

const attention = (
  kind: string,
  detail: string,
  extra: Partial<Pick<MapAttention, "projectId" | "taskId" | "sessionId">> = {},
): MapAttention =>
  mapAttention.parse({
    kind: kind.slice(0, 64),
    detail: detail.slice(0, 500),
    projectId: extra.projectId ?? null,
    taskId: extra.taskId ?? null,
    sessionId: extra.sessionId ?? null,
  });

export interface OverviewDeps {
  call?: Call;
  fleet: () => Promise<Fleet>;
  projects: () => Promise<ProjectDirectory>;
  now?: () => string;
}

export function createWorkMapReader({
  call = localCall,
  fleet,
  projects,
  now = () => new Date().toISOString(),
}: OverviewDeps) {
  const read = allowlisted(call);
  return async (): Promise<WorkMapOverview> => {
    const observedAt = now();
    const [seatRead, channelRead, directoryRead, fleetRead] = await Promise.allSettled([
      read("bindings-status"),
      read("channels-status"),
      projects(),
      fleet(),
    ]);
    const seats = seatRead.status === "fulfilled" ? seatRead.value : null;
    const holds = holdsOf(seats);
    const bindings = seats ? bounded(seats.bindings, 512).map((b) => mapSeatOf(b, holds)) : [];
    const primes = bindings.filter((b) => b.role === "prime").slice(0, 64);
    const projectSeats = new Map(
      bindings.filter((b) => b.role === "project-orchestrator").map((b) => [b.seat, b]),
    );
    const directory = directoryRead.status === "fulfilled" ? directoryRead.value : null;
    const f = fleetRead.status === "fulfilled" ? fleetRead.value : null;
    const nodes = f ? f.nodes : [];

    const channels =
      channelRead.status === "fulfilled" ? bounded(channelRead.value?.channels, 64) : [];
    const channelsFor = (projectId: string) =>
      channels
        .filter((c) => c?.projectSeat === projectId)
        .slice(0, 16)
        .map((c) => ({
          primeSeat: String(c?.primeSeat ?? "").slice(0, 64),
          state: String(c?.state ?? "unknown").slice(0, 32),
          open: c?.state === "open",
        }));

    const memberOf = new Map<string, string>();
    if (directory?.available)
      for (const m of directory.membership) if (m.projectId) memberOf.set(m.taskId, m.projectId);
    const ids = [
      ...new Set(
        [
          ...(directory?.available ? directory.projects.map((p) => p.id) : []),
          ...projectSeats.keys(),
        ].filter((id) => asUuid(id)),
      ),
    ];
    const projectsOut = ids.map((projectId) => {
      const summary = directory?.projects.find((p) => p.id === projectId) ?? null;
      const onProject = nodes.filter((n) => memberOf.get(n.task) === projectId);
      return {
        projectId,
        name: summary?.name ?? null,
        status: summary?.status ?? null,
        seat: projectSeats.get(projectId) ?? null,
        channels: channelsFor(projectId),
        workstreams:
          directory?.available && summary
            ? directory.membership.filter((m) => m.projectId === projectId).length
            : null,
        sessions: onProject.length,
        running: onProject.filter((n) => n.status === "running").length,
      };
    });

    const notes: MapAttention[] = [];
    if (!seats)
      notes.push(
        attention(
          "seats-unavailable",
          `Fulcra could not read who has each role: ${reason((seatRead as PromiseRejectedResult).reason)}`,
        ),
      );
    else if (!primes.some((p) => p.state === "assigned"))
      notes.push(
        attention(
          "no-prime",
          "No main assistant is assigned yet, so no project has anyone to escalate to.",
        ),
      );
    for (const p of projectsOut) {
      if (seats && p.seat?.state !== "assigned")
        notes.push(
          attention(
            "no-project-orchestrator",
            `${p.name ?? "This project"} needs a lead.`,
            { projectId: p.projectId },
          ),
        );
      else if (p.seat && !p.seat.sessionPresent)
        notes.push(
          attention(
            "leader-session-missing",
            `${p.name ?? "This project"}: its lead session is gone.`,
            { projectId: p.projectId, sessionId: p.seat.sessionId ?? undefined },
          ),
        );
      else if (p.seat?.sessionGenerationChanged)
        notes.push(
          attention(
            "generation-changed",
            `${p.name ?? "This project"}: this lead was restarted since it was assigned.`,
            { projectId: p.projectId, sessionId: p.seat.sessionId ?? undefined },
          ),
        );
    }
    for (const prime of primes)
      if (prime.state === "assigned" && prime.sessionGenerationChanged)
        notes.push(
          attention(
            "generation-changed",
            `Main assistant ${prime.seat}: this lead was restarted since it was assigned.`,
            { sessionId: prime.sessionId ?? undefined },
          ),
        );
    for (const n of nodes) {
      if ((n.pending ?? 0) > 0)
        notes.push(
          attention(
            "pending-permission",
            `${n.title.slice(0, 80)} is waiting for a permission decision.`,
            { projectId: memberOf.get(n.task), taskId: n.task, sessionId: n.id },
          ),
        );
      else if (n.error)
        notes.push(
          attention(
            "session-error",
            `${n.title.slice(0, 80)}: Fulcra could not read this session.`,
            { projectId: memberOf.get(n.task), taskId: n.task, sessionId: n.id },
          ),
        );
    }
    const attentionFirst = new Set(notes.map((a) => a.projectId).filter(Boolean));
    projectsOut.sort(
      (a, b) =>
        Number(attentionFirst.has(b.projectId)) - Number(attentionFirst.has(a.projectId)) ||
        (a.name ?? "￿").localeCompare(b.name ?? "￿") ||
        a.projectId.localeCompare(b.projectId),
    );

    const unplaced = nodes
      .filter((n) => !memberOf.has(n.task))
      .slice(0, 64)
      .map((n) => ({
        sessionId: n.id,
        taskId: n.task,
        mode: n.mode.slice(0, 32),
        runtime: runtimeOf(n),
      }));
    return workMapOverview.parse({
      observedAt,
      available: Boolean(seats),
      unavailable: seats ? null : reason((seatRead as PromiseRejectedResult).reason),
      primes,
      projects: projectsOut.slice(0, 128),
      unplaced,
      attention: notes.slice(0, 64),
      sources: {
        seats: Boolean(seats),
        channels: channelRead.status === "fulfilled",
        projects: directory
          ? {
              available: directory.available,
              partial: directory.partial,
              note: directory.note.slice(0, 512),
            }
          : { available: false, partial: true, note: "Project directory unavailable." },
        fleet: f
          ? { available: true, partial: f.partial, observedAt: f.observedAt.slice(0, 64) }
          : { available: false, partial: true, observedAt: null },
      },
      note: "Read-only. A role records accountability; idle is not done, and nothing on this map grants, sends or takes over.",
    });
  };
}

export interface ProjectDeps {
  call?: Call;
  fleet: () => Promise<Fleet>;
  issues: (refs: IssueRef[]) => Promise<LinkedIssuesResult>;
  now?: () => string;
}

/** Worker-fault text is free text from a session; keep it short and never interpretable. */
const needDetail = (need: ReturnType<typeof needOf>) => ({
  ...need,
  detail: need.detail.slice(0, need.kind === "worker-fault" ? 200 : 500),
});

export function createWorkMapProjectReader({
  call = localCall,
  fleet,
  issues,
  now = () => new Date().toISOString(),
}: ProjectDeps) {
  const read = allowlisted(call);
  return async (input: { projectId: string }): Promise<WorkMapProject> => {
    const observedAt = now(),
      projectId = input.projectId;
    const empty = {
      observedAt,
      projectId,
      name: null,
      status: null,
      membership: null,
      leader: null,
      workstreams: [],
      needed: [],
      blockers: [],
    };
    let d: any;
    try {
      d = await read("bindings-project", projectId);
    } catch (error) {
      return workMapProject.parse({
        ...empty,
        available: false,
        unavailable: reason(error),
        issues: linkedIssuesResult.parse({
          observedAt,
          providers: [],
          issues: [],
          truncated: false,
        }),
        note: "This project could not be read, so its lead and workstreams are unknown rather than absent.",
      });
    }
    // Holds are cheap and optional: without them no seat is shown as held.
    const holds = holdsOf(await read("bindings-status").catch(() => null));
    const f = await fleet().catch(() => null);
    const byId = new Map((f?.nodes ?? []).map((n) => [n.id, n]));
    const summary = d?.project?.summary,
      m = d?.project?.membership;
    const workstreams = bounded(d?.tasks, 64).flatMap((t) => {
      const taskId = asUuid(t?.taskId);
      if (!taskId) return [];
      const sessions = bounded(t?.sessions, 64).flatMap((s) => {
        const sessionId = asUuid(s?.id);
        if (!sessionId) return [];
        const owner = s?.owner,
          state = ownershipStateOf(owner?.ownership);
        const managedBy =
          state === "managed" && owner?.sessionId === sessionId
            ? asUuid(owner?.parentSession)
            : null;
        const ownership =
          state === "managed" && (!managedBy || managedBy === sessionId) ? "unknown" : state;
        return [
          {
            sessionId,
            taskId,
            mode: String(s?.mode ?? "unknown").slice(0, 32),
            generation: Number.isSafeInteger(s?.generation) && s.generation >= 1 ? s.generation : 1,
            ownership,
            seat: clip(owner?.seat, 64),
            seatRole: clip(owner?.seatRole, 32),
            parentSession: ownership === "recorded" ? asUuid(owner?.parentSession) : null,
            managedBy: ownership === "managed" ? managedBy : null,
            adoptedUnder: ownership === "adopted" ? asUuid(owner?.adoption?.leaderSession) : null,
            leaderChanged: owner?.leaderChanged === true,
            runtime: runtimeOf(byId.get(sessionId)),
          },
        ];
      });
      return [
        {
          taskId,
          recorded: nonNegative(t?.recorded),
          unresolved: Array.isArray(t?.unresolved)
            ? t.unresolved.length
            : nonNegative(t?.unresolved),
          truncated: t?.truncated === true,
          sessions,
        },
      ];
    });
    const refs: IssueRef[] = [
      { scope: "project", scopeId: projectId },
      ...workstreams.map((w) => ({ scope: "workstream" as const, scopeId: w.taskId })),
    ];
    return workMapProject.parse({
      observedAt,
      available: true,
      unavailable: null,
      projectId,
      name: summary && asUuid(summary.id) ? clip(summary.name, 160) : null,
      status: summary && asUuid(summary.id) ? clip(summary.status, 64) : null,
      membership: m
        ? {
            known: m.known === true,
            partial: m.partial === true,
            truncated: m.truncated === true,
            memberTaskCount: nonNegative(m.memberTaskCount),
            note: String(m.note ?? "").slice(0, 2000),
          }
        : null,
      leader: d?.leader ? mapSeatOf(d.leader, holds) : null,
      workstreams,
      needed: bounded(d?.needed, 64).map(needOf).map(needDetail),
      blockers: bounded(d?.blockers, 64).map(needOf).map(needDetail),
      issues: await issues(refs),
      note: "Read-only. Workstreams are this project's member tasks; counts are recorded journal activity, not accepted work.",
    });
  };
}

/**
 * Run the J3 providers. Each gets the same deadline; a slow or throwing provider becomes
 * `available: false` and never delays the others past the deadline. Rows that fail the contract,
 * or that link to something that was not asked about, are dropped.
 */
export function createIssueResolver(
  providers: LinkedIssueProvider[],
  { timeoutMs = 2000, ttlMs = 60000, now = Date.now } = {},
) {
  const cache = new Map<string, { at: number; value: LinkedIssuesResult }>();
  return async (refs: IssueRef[]): Promise<LinkedIssuesResult> => {
    const key = JSON.stringify(refs.map((r) => `${r.scope}:${r.scopeId}`).sort());
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    const asked = new Set(refs.map((r) => `${r.scope}:${r.scopeId}`));
    const results = await Promise.all(
      providers.slice(0, 8).map(async (provider) => {
        const abort = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            abort.abort();
            reject(new Error("Provider timed out"));
          }, timeoutMs);
        });
        try {
          const r = await Promise.race([provider.resolve(refs, abort.signal), deadline]);
          const rows: LinkedIssue[] = [];
          for (const raw of bounded(r?.issues, 256)) {
            const parsed = linkedIssue.safeParse(raw);
            if (
              parsed.success &&
              asked.has(`${parsed.data.linkedTo.scope}:${parsed.data.linkedTo.scopeId}`)
            )
              rows.push(parsed.data);
          }
          return {
            status: {
              source: provider.source.slice(0, 32),
              available: r?.available === true,
              note: String(r?.note ?? "").slice(0, 512),
            },
            rows,
          };
        } catch (error) {
          return {
            status: {
              source: provider.source.slice(0, 32),
              available: false,
              note: reason(error).slice(0, 512),
            },
            rows: [],
          };
        } finally {
          clearTimeout(timer);
        }
      }),
    );
    const all = results.flatMap((r) => r.rows);
    const value = linkedIssuesResult.parse({
      observedAt: new Date(now()).toISOString(),
      providers: results.map((r) => r.status),
      issues: all.slice(0, 256),
      truncated: all.length > 256,
    });
    if (cache.size >= 128) cache.delete(cache.keys().next().value!);
    cache.set(key, { at: now(), value });
    return value;
  };
}

/** The default provider: each workstream *is* its board issue. Reads the local board; no credential. */
export function boardIssueProvider(
  read: () => Promise<unknown[]> = () => readIssues(),
): LinkedIssueProvider {
  return {
    source: "board",
    async resolve(refs) {
      try {
        const rows = await read();
        const byId = new Map<string, any>();
        for (const row of bounded(rows, 1000)) {
          const rid = asUuid((row as any)?.id);
          if (rid) byId.set(rid, row);
        }
        const issues = refs
          .filter((r) => r.scope === "workstream")
          .flatMap((ref) => {
            const row = byId.get(ref.scopeId);
            if (!row || typeof row.title !== "string") return [];
            const handle =
              typeof row.assigneeUserId === "string" && /^[\w.-]{1,64}$/.test(row.assigneeUserId)
                ? row.assigneeUserId
                : null;
            return [
              {
                source: "board",
                key:
                  typeof row.identifier === "string" && row.identifier
                    ? row.identifier.slice(0, 64)
                    : ref.scopeId.slice(0, 8),
                title: row.title.slice(0, 160),
                state: normalizeIssueState(row.status),
                rawState: clip(row.status, 64),
                assignee: handle,
                url: null,
                updatedAt:
                  typeof row.updatedAt === "string" && !Number.isNaN(Date.parse(row.updatedAt))
                    ? new Date(row.updatedAt).toISOString()
                    : null,
                linkedTo: ref,
                relation: "is",
              },
            ];
          });
        return { available: true, note: "Local task board.", issues };
      } catch (error) {
        return {
          available: false,
          note: `Local task board unavailable: ${reason(error).slice(0, 400)}`,
          issues: [],
        };
      }
    },
  };
}
