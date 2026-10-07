import { portable } from "./portable";
// J6 step-through reads. They call the host's timeline turn index (J5a) through the plugin's PaseoApi, and turn
// what comes back into plain-language steps with project-relative paths only.
//
// Gate: the host client refuses a turn-index call with NEWER_HOST_NEEDED when the daemon does not advertise
// `features.agentTimelineTurnIndex`, and an older client has no `turns`/`fileHistory` on the timeline handle at
// all. Either way the read answers `status: "unsupported"` with those words, never a blank or an error.
import {
  NEWER_HOST_NEEDED,
  sessionFileHistoryRpc,
  sessionStepRpc,
  sessionTurnsRpc,
  type SessionFileHistory,
  type SessionStep,
  type SessionTurns,
  type Turn,
} from "../shared/session-steps";
import { OUTSIDE_PROJECT } from "../shared/privacy-scrub";
import type { ContractOutput } from "../shared/rpc-contract";

export { OUTSIDE_PROJECT };
import {
  placePath,
  scrubDiff,
  storable,
  count,
  testCounts,
  commandSummary,
  turnHeadline,
  turnRef,
  localRepoKey,
  fileRef,
  shapeSteps,
} from "../shared/step-shaping";
export {
  placePath,
  scrubDiff,
  testCounts,
  commandSummary,
  turnHeadline,
  turnRef,
  localRepoKey,
  fileRef,
  shapeSteps,
} from "../shared/step-shaping";
const TURN_PAGE = 50,
  STEP_PAGE = 400,
  FILE_CHECKS = 30,
  CLASSIFY_CONCURRENCY = 4;
// One budget covers a whole read, below the host's 30 s plugin RPC limit (the fleet reader's reasoning, fleet.ts).
// Each stage gets what is left (never more than 12 s); optional classification stops when under 1.5 s remains.
export const SESSION_STEPS_BUDGET_MS = 20000;
const STAGE_MAX_MS = 12000,
  CLASSIFY_MIN_MS = 1500;
// Any path the host places outside the project answers with the whole outside bucket, touch kinds included.
const OUTSIDE_BUCKET_QUERY = "~/";

type Call = (method: string, input?: unknown) => Promise<any>;
type Enrollment = (call: Call, ms?: number) => Promise<any[]>;
type Directory = () => Promise<{ membership: { taskId: string; projectId: string | null }[] }>;
interface TimelineHandle {
  refetch(options: Record<string, unknown>): Promise<any>;
  turns?: (options: { cursor?: number; limit?: number }) => Promise<any>;
  fileHistory?: (path: string) => Promise<any>;
}
interface Paseo {
  agents: { ref(id: string): { timeline: TimelineHandle } };
}
export interface SessionStepsDeps {
  call: Call;
  enrollment: Enrollment;
  projects: Directory;
  /** Rejects when `work` takes longer than `ms`. */
  bounded: <T>(work: Promise<T>, ms: number) => Promise<T>;
  now?: () => number;
}

// ---------------------------------------------------------------------------------------------------------------
// The three reads.
type Resolved =
  | { status: "ok"; agentId: string; cwd: string | null; repoKey: string | null }
  | { status: "unavailable"; message: string };
const unsupported = { status: "unsupported" as const, message: NEWER_HOST_NEEDED };
const unavailable = (message: string) => ({ status: "unavailable" as const, message });
const isNewerHostError = (error: unknown) =>
  error instanceof Error && error.message.includes("newer Fulcra host");

interface Budget {
  remaining(): number;
  within<T>(work: Promise<T>): Promise<T>;
}

export function createSessionSteps(deps: SessionStepsDeps) {
  const now = deps.now ?? Date.now;
  function budget(): Budget {
    const deadline = now() + SESSION_STEPS_BUDGET_MS;
    const remaining = () => deadline - now();
    return {
      remaining,
      within: (work) => {
        const left = remaining();
        if (left <= 0) return Promise.reject(new Error("Session read ran out of time"));
        return deps.bounded(work, Math.min(STAGE_MAX_MS, left));
      },
    };
  }
  async function resolve(sessionId: string, time: Budget): Promise<Resolved> {
    const row = (
      await deps.enrollment(deps.call, Math.max(0, Math.min(STAGE_MAX_MS, time.remaining())))
    ).find((r) => r.id === sessionId);
    if (!row) return unavailable("This session is not part of your Fulcra work.");
    if (row.host && row.host !== portable.localHost.name)
      return unavailable("Step-through works for sessions on this Mac for now.");
    const cwd = typeof row.cwd === "string" && row.cwd ? row.cwd : null;
    let projectId: string | null = null;
    try {
      projectId =
        (await time.within(deps.projects())).membership.find((m) => m.taskId === row.task)
          ?.projectId ?? null;
    } catch {
      projectId = null;
    }
    return { status: "ok", agentId: row.id, cwd, repoKey: localRepoKey(projectId, cwd) };
  }
  async function guarded<T>(
    sessionId: string,
    run: (
      timeline: TimelineHandle,
      resolved: Extract<Resolved, { status: "ok" }>,
      time: Budget,
    ) => Promise<T>,
    paseo: Paseo,
  ) {
    const time = budget();
    try {
      const resolved = await resolve(sessionId, time);
      if (resolved.status !== "ok") return resolved;
      const timeline = paseo.agents.ref(resolved.agentId).timeline;
      if (typeof timeline.turns !== "function" || typeof timeline.fileHistory !== "function")
        return unsupported;
      return await run(timeline, resolved, time);
    } catch (error) {
      if (isNewerHostError(error)) return unsupported;
      return unavailable(
        "This session's history could not be read right now. Try again in a moment.",
      );
    }
  }

  /**
   * Which turns wrote a file, from the host's file index (it records the kind of every touch). Optional: it
   * stops when the budget runs low, and a turn it could not settle stays unresolved (null), never "no changes".
   */
  async function classify(timeline: TimelineHandle, raw: any[], time: Budget) {
    const files = [...new Set(raw.flatMap((t) => (t.files as string[]).filter(storable)))];
    const needOutside = raw.some((t) => (t.externalFileCount ?? 0) > 0);
    const changing = new Set<string>(),
      settled = new Set<string>();
    let outsideSettled = !needOutside;
    if (files.length > FILE_CHECKS) return { changing, settled, outsideSettled };
    const queue: (string | null)[] = [...(needOutside ? [null] : []), ...files];
    const next = async (): Promise<void> => {
      while (queue.length && time.remaining() >= CLASSIFY_MIN_MS) {
        const path = queue.shift()!;
        try {
          const history = await time.within(timeline.fileHistory!(path ?? OUTSIDE_BUCKET_QUERY));
          for (const touch of history.touches ?? [])
            if (touch.kind !== "read") changing.add(touch.turnId);
          if (path === null) outsideSettled = true;
          else settled.add(path);
        } catch {
          /* Unsettled: the turns it covers stay unresolved. */
        }
      }
    };
    await Promise.all(Array.from({ length: CLASSIFY_CONCURRENCY }, next));
    return { changing, settled, outsideSettled };
  }

  async function turns(
    input: unknown,
    paseo: Paseo,
  ): Promise<ContractOutput<typeof sessionTurnsRpc>> {
    const { sessionId, cursor } = sessionTurnsRpc.input.parse(input);
    return guarded(
      sessionId,
      async (timeline, _resolved, time) => {
        const page = await time.within(timeline.turns!({ cursor: cursor ?? 0, limit: TURN_PAGE }));
        if (page.error) throw new Error(page.error);
        const raw: any[] = page.turns ?? [];
        const { changing, settled, outsideSettled } = await classify(timeline, raw, time);
        const shaped: Turn[] = raw.map((t, i) => {
          const inside = (t.files as string[]).filter(storable),
            outside = t.externalFileCount ?? 0;
          const touched = inside.length > 0 || outside > 0;
          // L38: a command's file changes are not recorded (only file tools are indexed), so a turn that ran commands and
          // touched no file through a file tool may still have changed files: unknown, never "no changes".
          const commands =
              Number.isInteger(t.commands) && t.commands > 0 ? (t.commands as number) : 0,
            commandsOnly = commands > 0 && !touched;
          const changes = changing.has(t.turnId)
            ? true
            : commandsOnly
              ? null
              : inside.every((path) => settled.has(path)) && (outside === 0 || outsideSettled)
                ? false
                : null;
          const summary =
            t.toolCount === 0
              ? "Answered without using tools"
              : `${changes ? "Changed files" : commandsOnly ? "Ran commands" : changes === null && touched ? "Worked with files" : touched ? "Looked at files" : "Used tools"} · ${count(t.toolCount, "step")}`;
          const note = commandsOnly
            ? `Ran ${count(commands, "command")}; changes made through commands are not listed.`
            : null;
          return {
            n: (cursor ?? 0) + i,
            turnId: t.turnId,
            ref: turnRef(sessionId, t.turnId),
            implicit: !!t.implicit,
            startedAt: t.startedAt,
            endedAt: t.endedAt,
            summary,
            toolCount: t.toolCount,
            commands,
            files: inside,
            outsideFiles: outside,
            changesFiles: changes,
            note,
          };
        });
        return {
          status: "ok" as const,
          sessionId,
          retained: !!page.retained,
          turns: shaped,
          totalTurns: page.totalTurns ?? shaped.length,
          nextCursor: page.nextCursor ?? null,
        };
      },
      paseo,
    ) as Promise<SessionTurns>;
  }

  async function step(
    input: unknown,
    paseo: Paseo,
  ): Promise<ContractOutput<typeof sessionStepRpc>> {
    const { sessionId, turnId } = sessionStepRpc.input.parse(input);
    return guarded(
      sessionId,
      async (timeline, resolved, time) => {
        const page = await time.within(
          timeline.refetch({ turnId, direction: "after", limit: STEP_PAGE }),
        );
        if (page.error) throw new Error(page.error);
        const cwd = resolved.cwd ?? (typeof page.agent?.cwd === "string" ? page.agent.cwd : null);
        const { steps, asked } = shapeSteps(page.entries ?? [], {
          sessionId,
          turnId,
          cwd,
          repoKey: resolved.repoKey,
        });
        return {
          status: "ok" as const,
          sessionId,
          retained: page.retained === true,
          turnId,
          ref: turnRef(sessionId, turnId),
          provider: String(page.entries?.[0]?.provider ?? "unknown"),
          asked,
          summary: turnHeadline(steps),
          steps,
          truncated: page.hasNewer === true,
        };
      },
      paseo,
    ) as Promise<SessionStep>;
  }

  async function fileHistory(
    input: unknown,
    paseo: Paseo,
  ): Promise<ContractOutput<typeof sessionFileHistoryRpc>> {
    const { sessionId, path } = sessionFileHistoryRpc.input.parse(input);
    return guarded(
      sessionId,
      async (timeline, resolved, time) => {
        const page = await time.within(timeline.fileHistory!(path));
        if (page.error) throw new Error(page.error);
        const placed: string | null =
          typeof page.path === "string" && storable(page.path) ? page.path : null;
        const touches = (page.touches ?? []).slice(-500).map((t: any) => {
          const change = t.kind === "read" ? "read" : t.kind === "write" ? "written" : "edited";
          return {
            seq: t.seq,
            turnId: t.turnId,
            ref: turnRef(sessionId, t.turnId),
            at: t.timestamp,
            change,
            summary:
              change === "read"
                ? "Read it"
                : change === "written"
                  ? "Wrote it"
                  : t.kind === "patch"
                    ? "Changed it with other files"
                    : "Edited it",
          };
        });
        return {
          status: "ok" as const,
          sessionId,
          retained: !!page.retained,
          path: placed,
          label: placed ?? OUTSIDE_PROJECT,
          ref: fileRef(resolved.repoKey, placed),
          touches,
        };
      },
      paseo,
    ) as Promise<SessionFileHistory>;
  }

  return { turns, step, fileHistory };
}
