import { portable } from "./portable";
// J6 step-through reads. They call the host's timeline turn index (J5a) through the plugin's PaseoApi, and turn
// what comes back into plain-language steps with project-relative paths only.
//
// Gate: the host client refuses a turn-index call with NEWER_HOST_NEEDED when the daemon does not advertise
// `features.agentTimelineTurnIndex`, and an older client has no `turns`/`fileHistory` on the timeline handle at
// all. Either way the read answers `status: "unsupported"` with those words, never a blank or an error.
import {
  NEWER_HOST_NEEDED, sessionFileHistoryRpc, sessionStepRpc, sessionTurnsRpc,
  type SessionFileHistory, type SessionStep, type SessionTurns, type Step, type Turn,
} from "../shared/session-steps";
import { parseRef } from "../shared/cc/refs";
import { OUTSIDE_PROJECT, placePath as placeSharedPath, scrubFreeText } from "../shared/privacy-scrub";
// C1 integration: J0's v1.9 isRef takes one argument; a ref of one kind is checked with parseRef.
const isRef = (value: unknown, kind: string) => parseRef(value)?.kind === kind;
import type { ContractOutput } from "../shared/rpc-contract";

export { OUTSIDE_PROJECT };
const TURN_PAGE = 50, STEP_PAGE = 400, FILE_CHECKS = 30, CLASSIFY_CONCURRENCY = 4;
// One budget covers a whole read, below the host's 30 s plugin RPC limit (the fleet reader's reasoning, fleet.ts).
// Each stage gets what is left (never more than 12 s); optional classification stops when under 1.5 s remains.
export const SESSION_STEPS_BUDGET_MS = 20000;
const STAGE_MAX_MS = 12000, CLASSIFY_MIN_MS = 1500;
// Any path the host places outside the project answers with the whole outside bucket, touch kinds included.
const OUTSIDE_BUCKET_QUERY = "~/";

type Call = (method: string, input?: unknown) => Promise<any>;
type Enrollment = (call: Call, ms?: number) => Promise<any[]>;
type Directory = () => Promise<{ membership: { taskId: string; projectId: string | null }[] }>;
type TimelineHandle = {
  refetch(options: Record<string, unknown>): Promise<any>;
  turns?: (options: { cursor?: number; limit?: number }) => Promise<any>;
  fileHistory?: (path: string) => Promise<any>;
};
type Paseo = { agents: { ref(id: string): { timeline: TimelineHandle } } };
export interface SessionStepsDeps {
  call: Call;
  enrollment: Enrollment;
  projects: Directory;
  /** Rejects when `work` takes longer than `ms`. */
  bounded: <T>(work: Promise<T>, ms: number) => Promise<T>;
  now?: () => number;
}

// Placement and free-text scrubbing: one shared scrubber (shared/privacy-scrub.ts, CONTRACTS v1.14 STEP-THROUGH)
// for every emitted text field -- asked, why, command, output and diff bodies.
/** A project-relative file path, or null for a file outside the project (or the project folder itself). */
export function placePath(filePath: string, cwd: string | null): string | null {
  return placeSharedPath(filePath, cwd) || null;
}
/** A diff with every path in its headers and body placed, and personal data removed, line by line. */
export function scrubDiff(diff: string, cwd: string | null): string {
  return diff.split("\n").map(line => scrubFreeText(line, cwd)).join("\n");
}

/** Relative, normalised and inside the project: exactly what placement without a cwd leaves unchanged. */
const storable = (candidate: string) => placeSharedPath(candidate, null) === candidate;
const clip = (text: string, max: number) => text.length <= max ? text : text.slice(0, max - 1) + "…";
const tail = (text: string, max: number) => text.length <= max ? text : "…" + text.slice(text.length - max + 1);
const count = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------------------------------------------------------
// Plain-language summaries.
const TEST_COMMAND = /\b(?:vitest|jest|pytest|mocha|ava|playwright test|go test|cargo test|rspec|phpunit)\b|--test\b|\b(?:npm|pnpm|yarn|bun) (?:run )?test\b|\btest(?:s)?\b(?=\s|$)/;

/** Pass/fail counts from common test runners' closing lines, or null when the output says nothing countable. */
export function testCounts(output: string): { passed: number; failed: number } | null {
  const last = (re: RegExp) => { let found: number | null = null; for (const m of output.matchAll(re)) found = Number(m[1]); return found; };
  const tapPass = last(/^# pass (\d+)/gm), tapFail = last(/^# fail (\d+)/gm);
  if (tapPass !== null || tapFail !== null) return { passed: tapPass ?? 0, failed: tapFail ?? 0 };
  const passed = last(/(\d+) passed/g), failed = last(/(\d+) failed/g);
  return passed === null && failed === null ? null : { passed: passed ?? 0, failed: failed ?? 0 };
}

export function commandSummary(command: string, output: string, exitCode: number | null, failed: boolean): string {
  if (TEST_COMMAND.test(command)) {
    const counts = testCounts(output);
    if (counts) return counts.failed ? `Ran tests: ${counts.failed} failed, ${counts.passed} passed` : `Ran tests: ${counts.passed} passed`;
    return failed || (exitCode !== null && exitCode !== 0) ? "Ran tests: they failed" : "Ran tests";
  }
  return failed || (exitCode !== null && exitCode !== 0) ? "Ran a command: it failed" : "Ran a command";
}

function filesSummary(files: Step["files"]): string {
  const inside = files.filter(f => f.path !== null), outside = files.length - inside.length;
  const verb = files.every(f => f.change === "read") ? "Read" : files.every(f => f.change === "created") ? "Created"
    : files.every(f => f.change === "written") ? "Wrote" : files.every(f => f.change === "deleted") ? "Deleted"
    : files.every(f => f.change === "edited") ? "Edited" : "Changed";
  if (!inside.length) return `${verb} ${outside === 1 ? OUTSIDE_PROJECT : `${outside} files outside the project`}`;
  return `${verb} ${count(inside.length, "file")}${outside ? ` and ${count(outside, "file")} outside the project` : ""}`;
}

/** One headline for a whole turn, from its steps. */
export function turnHeadline(steps: Step[]): string {
  if (!steps.length) return "Answered without using tools";
  const changed = new Set<string>(), outside = { n: 0 };
  for (const step of steps) for (const file of step.files) if (file.change !== "read") { if (file.path) changed.add(file.path); else outside.n += 1; }
  const tests = steps.filter(s => s.summary.startsWith("Ran tests")).at(-1);
  const parts: string[] = [];
  if (changed.size || outside.n) parts.push(`Changed ${count(changed.size + outside.n, "file")}`);
  if (tests) parts.push(tests.summary.replace(/^Ran tests/, parts.length ? "ran tests" : "Ran tests"));
  if (!parts.length) parts.push(count(steps.length, "step"));
  return parts.join(", ");
}

// ---------------------------------------------------------------------------------------------------------------
// Refs (CONTRACTS §2.1).
export function turnRef(sessionId: string, turnId: string): string | null {
  const value = `turn:${sessionId}/${turnId}`;
  return isRef(value, "turn") ? value : null;
}
/** `local:<project>/<slug>` from the session's project and folder name; J4 owns connector repo keys. */
export function localRepoKey(projectId: string | null, cwd: string | null): string | null {
  if (!projectId || !cwd) return null;
  const folder = cwd.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) ?? "";
  const slug = folder.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  const key = `local:${projectId}/${slug}`;
  return slug && isRef(`repo:${key}`, "repo") ? key : null;
}
export function fileRef(repoKey: string | null, path: string | null): string | null {
  if (!repoKey || !path) return null;
  const value = `file:${repoKey}:${path}`;
  return isRef(value, "file") ? value : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Steps from one turn's projected timeline entries.
const changeOf = (kind: unknown): Step["files"][number]["change"] => kind === "add" ? "created" : kind === "delete" ? "deleted" : "edited";
const addedDiff = (path: string, content: string) => [`--- /dev/null`, `+++ ${path}`, ...content.split("\n").map(line => `+${line}`)].join("\n");

function textOf(item: any): string | null {
  if (item?.type === "reasoning" || item?.type === "assistant_message") return typeof item.text === "string" && item.text.trim() ? item.text.trim() : null;
  return null;
}

export function shapeSteps(entries: any[], context: { sessionId: string; turnId: string; cwd: string | null; repoKey: string | null }): { steps: Step[]; asked: string | null } {
  const { cwd, repoKey } = context, ref = turnRef(context.sessionId, context.turnId), steps: Step[] = [];
  let why: string | null = null, asked: string | null = null;
  const file = (raw: string, change: Step["files"][number]["change"], diff: string | null) => {
    const path = placePath(raw, cwd);
    return { path, change, diff: path && diff ? clip(scrubDiff(diff, cwd), 24000) : null, ref: fileRef(repoKey, path) };
  };
  for (const entry of entries) {
    const item = entry?.item;
    if (item?.type === "user_message") { asked ??= typeof item.text === "string" ? clip(scrubFreeText(item.text.trim(), cwd), 1500) : null; continue; }
    const said = textOf(item);
    if (said) { why = clip(scrubFreeText(said, cwd), 1500); continue; }
    if (item?.type !== "tool_call") continue;
    const detail = item.detail ?? {}, failed = item.status === "failed";
    let kind: Step["kind"] = "other", summary = "Used a tool", files: Step["files"] = [];
    let command: string | null = null, exitCode: number | null = null, output: string | null = null;
    if ((detail.type === "edit" || detail.type === "unknown") && Array.isArray(detail.files) && detail.files.length) {
      files = detail.files.map((f: any) => file(String(f.path ?? ""), changeOf(f.kind), typeof f.unifiedDiff === "string" ? f.unifiedDiff : null));
      kind = "edit";
    } else if (detail.type === "edit") {
      const diff = typeof detail.unifiedDiff === "string" ? detail.unifiedDiff
        : typeof detail.newString === "string" ? [`--- ${detail.filePath}`, `+++ ${detail.filePath}`, ...(detail.oldString ?? "").split("\n").filter(Boolean).map((l: string) => `-${l}`), ...detail.newString.split("\n").map((l: string) => `+${l}`)].join("\n") : null;
      files = [file(String(detail.filePath ?? ""), "edited", diff)];
      kind = "edit";
    } else if (detail.type === "write") {
      files = [file(String(detail.filePath ?? ""), "written", typeof detail.content === "string" ? addedDiff(String(detail.filePath), detail.content) : null)];
      kind = "create";
    } else if (detail.type === "read") {
      files = [file(String(detail.filePath ?? ""), "read", null)];
      kind = "read";
    } else if (detail.type === "shell") {
      kind = "command";
      command = clip(scrubFreeText(String(detail.command ?? ""), cwd), 2000);
      exitCode = Number.isInteger(detail.exitCode) ? detail.exitCode : null;
      output = typeof detail.output === "string" && detail.output ? tail(scrubFreeText(detail.output, cwd), 4000) : null;
      summary = commandSummary(command, detail.output ?? "", exitCode, failed);
    } else if (detail.type === "search") {
      kind = detail.toolName === "web_search" ? "web" : "search";
      summary = kind === "web" ? "Searched the web" : "Searched the project";
    } else if (detail.type === "fetch") {
      kind = "web"; summary = "Read a web page";
    }
    if (files.length) summary = filesSummary(files);
    const outcome: Step["outcome"] = failed || (exitCode !== null && exitCode !== 0) ? "failed" : item.status === "running" ? "running" : "done";
    steps.push({
      n: steps.length, seq: Number(entry.seqStart ?? entry.seq ?? 0), at: String(entry.timestamp ?? ""), kind, summary, outcome,
      changesFiles: files.some(f => f.change !== "read"), files, command, exitCode, output, why, ref,
    });
  }
  return { steps, asked };
}

// ---------------------------------------------------------------------------------------------------------------
// The three reads.
type Resolved = { status: "ok"; agentId: string; cwd: string | null; repoKey: string | null } | { status: "unavailable"; message: string };
const unsupported = { status: "unsupported" as const, message: NEWER_HOST_NEEDED };
const unavailable = (message: string) => ({ status: "unavailable" as const, message });
const isNewerHostError = (error: unknown) => error instanceof Error && error.message.includes("newer Fulcra host");

type Budget = { remaining(): number; within<T>(work: Promise<T>): Promise<T> };

export function createSessionSteps(deps: SessionStepsDeps) {
  const now = deps.now ?? Date.now;
  function budget(): Budget {
    const deadline = now() + SESSION_STEPS_BUDGET_MS;
    const remaining = () => deadline - now();
    return {
      remaining,
      within: work => {
        const left = remaining();
        if (left <= 0) return Promise.reject(new Error("Session read ran out of time"));
        return deps.bounded(work, Math.min(STAGE_MAX_MS, left));
      },
    };
  }
  async function resolve(sessionId: string, time: Budget): Promise<Resolved> {
    const row = (await deps.enrollment(deps.call, Math.max(0, Math.min(STAGE_MAX_MS, time.remaining())))).find(r => r.id === sessionId);
    if (!row) return unavailable("This session is not part of your Fulcra work.");
    if (row.host && row.host !== portable.localHost.name) return unavailable("Step-through works for sessions on this Mac for now.");
    const cwd = typeof row.cwd === "string" && row.cwd ? row.cwd : null;
    let projectId: string | null = null;
    try { projectId = (await time.within(deps.projects())).membership.find(m => m.taskId === row.task)?.projectId ?? null; } catch { projectId = null; }
    return { status: "ok", agentId: row.id, cwd, repoKey: localRepoKey(projectId, cwd) };
  }
  async function guarded<T>(sessionId: string, run: (timeline: TimelineHandle, resolved: Extract<Resolved, { status: "ok" }>, time: Budget) => Promise<T>, paseo: Paseo) {
    const time = budget();
    try {
      const resolved = await resolve(sessionId, time);
      if (resolved.status !== "ok") return resolved;
      const timeline = paseo.agents.ref(resolved.agentId).timeline;
      if (typeof timeline.turns !== "function" || typeof timeline.fileHistory !== "function") return unsupported;
      return await run(timeline, resolved, time);
    } catch (error) {
      if (isNewerHostError(error)) return unsupported;
      return unavailable("This session's history could not be read right now. Try again in a moment.");
    }
  }

  /**
   * Which turns wrote a file, from the host's file index (it records the kind of every touch). Optional: it
   * stops when the budget runs low, and a turn it could not settle stays unresolved (null), never "no changes".
   */
  async function classify(timeline: TimelineHandle, raw: any[], time: Budget) {
    const files = [...new Set(raw.flatMap(t => (t.files as string[]).filter(storable)))];
    const needOutside = raw.some(t => (t.externalFileCount ?? 0) > 0);
    const changing = new Set<string>(), settled = new Set<string>();
    let outsideSettled = !needOutside;
    if (files.length > FILE_CHECKS) return { changing, settled, outsideSettled };
    const queue: (string | null)[] = [...(needOutside ? [null] : []), ...files];
    const next = async (): Promise<void> => {
      while (queue.length && time.remaining() >= CLASSIFY_MIN_MS) {
        const path = queue.shift()!;
        try {
          const history = await time.within(timeline.fileHistory!(path ?? OUTSIDE_BUCKET_QUERY));
          for (const touch of history.touches ?? []) if (touch.kind !== "read") changing.add(touch.turnId);
          if (path === null) outsideSettled = true; else settled.add(path);
        } catch { /* Unsettled: the turns it covers stay unresolved. */ }
      }
    };
    await Promise.all(Array.from({ length: CLASSIFY_CONCURRENCY }, next));
    return { changing, settled, outsideSettled };
  }

  async function turns(input: unknown, paseo: Paseo): Promise<ContractOutput<typeof sessionTurnsRpc>> {
    const { sessionId, cursor } = sessionTurnsRpc.input.parse(input);
    return guarded(sessionId, async (timeline, _resolved, time) => {
      const page = await time.within(timeline.turns!({ cursor: cursor ?? 0, limit: TURN_PAGE }));
      if (page.error) throw new Error(page.error);
      const raw: any[] = page.turns ?? [];
      const { changing, settled, outsideSettled } = await classify(timeline, raw, time);
      const shaped: Turn[] = raw.map((t, i) => {
        const inside = (t.files as string[]).filter(storable), outside = t.externalFileCount ?? 0;
        const touched = inside.length > 0 || outside > 0;
        // L38: a command's file changes are not recorded (only file tools are indexed), so a turn that ran commands and
        // touched no file through a file tool may still have changed files: unknown, never "no changes".
        const commands = Number.isInteger(t.commands) && t.commands > 0 ? t.commands as number : 0, commandsOnly = commands > 0 && !touched;
        const changes = changing.has(t.turnId) ? true
          : commandsOnly ? null
          : inside.every(path => settled.has(path)) && (outside === 0 || outsideSettled) ? false : null;
        const summary = t.toolCount === 0 ? "Answered without using tools"
          : `${changes ? "Changed files" : commandsOnly ? "Ran commands" : changes === null && touched ? "Worked with files" : touched ? "Looked at files" : "Used tools"} · ${count(t.toolCount, "step")}`;
        const note = commandsOnly ? `Ran ${count(commands, "command")}; changes made through commands are not listed.` : null;
        return { n: (cursor ?? 0) + i, turnId: t.turnId, ref: turnRef(sessionId, t.turnId), implicit: !!t.implicit, startedAt: t.startedAt, endedAt: t.endedAt,
          summary, toolCount: t.toolCount, commands, files: inside, outsideFiles: outside, changesFiles: changes, note };
      });
      return { status: "ok" as const, sessionId, retained: !!page.retained, turns: shaped, totalTurns: page.totalTurns ?? shaped.length, nextCursor: page.nextCursor ?? null };
    }, paseo) as Promise<SessionTurns>;
  }

  async function step(input: unknown, paseo: Paseo): Promise<ContractOutput<typeof sessionStepRpc>> {
    const { sessionId, turnId } = sessionStepRpc.input.parse(input);
    return guarded(sessionId, async (timeline, resolved, time) => {
      const page = await time.within(timeline.refetch({ turnId, direction: "after", limit: STEP_PAGE }));
      if (page.error) throw new Error(page.error);
      const cwd = resolved.cwd ?? (typeof page.agent?.cwd === "string" ? page.agent.cwd : null);
      const { steps, asked } = shapeSteps(page.entries ?? [], { sessionId, turnId, cwd, repoKey: resolved.repoKey });
      return { status: "ok" as const, sessionId, retained: page.retained === true, turnId, ref: turnRef(sessionId, turnId),
        provider: String(page.entries?.[0]?.provider ?? "unknown"), asked, summary: turnHeadline(steps), steps, truncated: page.hasNewer === true };
    }, paseo) as Promise<SessionStep>;
  }

  async function fileHistory(input: unknown, paseo: Paseo): Promise<ContractOutput<typeof sessionFileHistoryRpc>> {
    const { sessionId, path } = sessionFileHistoryRpc.input.parse(input);
    return guarded(sessionId, async (timeline, resolved, time) => {
      const page = await time.within(timeline.fileHistory!(path));
      if (page.error) throw new Error(page.error);
      const placed: string | null = typeof page.path === "string" && storable(page.path) ? page.path : null;
      const touches = (page.touches ?? []).slice(-500).map((t: any) => {
        const change = t.kind === "read" ? "read" : t.kind === "write" ? "written" : "edited";
        return { seq: t.seq, turnId: t.turnId, ref: turnRef(sessionId, t.turnId), at: t.timestamp, change,
          summary: change === "read" ? "Read it" : change === "written" ? "Wrote it" : t.kind === "patch" ? "Changed it with other files" : "Edited it" };
      });
      return { status: "ok" as const, sessionId, retained: !!page.retained, path: placed, label: placed ?? OUTSIDE_PROJECT, ref: fileRef(resolved.repoKey, placed), touches };
    }, paseo) as Promise<SessionFileHistory>;
  }

  return { turns, step, fileHistory };
}
