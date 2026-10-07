// "What it did": one turn of a session as a short numbered list in plain words, built only from the steps the host
// already records (server/session-steps.ts). No model call. Consecutive reads and searches fold into one line, file
// changes carry their size, and the test result is lifted into a badge.
import type { PluginTurnToolCall } from "@getpaseo/plugin/client";
import type { Step, Turn } from "../shared/session-steps";
import { shapeSteps } from "../shared/step-shaping";

export interface WhatItDid {
  /** "7 steps · 19 s" */
  size: string;
  /** "Tests passed" / "Tests failed", or null when the turn ran no tests. */
  tests: "passed" | "failed" | null;
  lines: { text: string; failed: boolean }[];
  /** Raw commands, in order, for "Show raw commands". */
  commands: string[];
  /** The host's own caveat, e.g. that changes made through commands are not listed. */
  note: string | null;
}

const OUTSIDE = "a file outside the project";
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function listNames(names: string[]): string {
  const shown = names.slice(0, 3);
  const rest = names.length - shown.length;
  const head = shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}` : shown[0];
  return rest > 0 ? `${shown.join(", ")} and ${plural(rest, "more file")}` : (head ?? "");
}

/** Lines added and removed in a unified diff, headers excluded. */
export function diffSize(diff: string | null): { added: number; removed: number } | null {
  if (!diff) return null;
  let added = 0,
    removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

function changeLine(step: Step): string {
  const verbs = { created: "Created", deleted: "Deleted", written: "Wrote", edited: "Changed" };
  const parts = step.files
    .filter((file) => file.change !== "read")
    .map((file) => {
      const size = diffSize(file.diff);
      const name = file.path ?? OUTSIDE;
      const verb = verbs[file.change as keyof typeof verbs] ?? "Changed";
      return size ? `${verb} ${name} (+${size.added} −${size.removed})` : `${verb} ${name}`;
    });
  return parts.length ? parts.join("; ") : step.summary;
}

function seconds(from: string, to: string): number | null {
  const start = Date.parse(from),
    end = Date.parse(to);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  return Math.round((end - start) / 1000);
}

export function duration(total: number): string {
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export function whatItDid(
  turn: Pick<Turn, "startedAt" | "endedAt" | "note">,
  steps: Step[],
): WhatItDid {
  return whatItDidFromSteps(steps, seconds(turn.startedAt, turn.endedAt), turn.note);
}

/** The chat's own tool calls for one turn, shaped by the same rules as the step-through reads. */
export function stepsFromToolCalls(
  toolCalls: readonly PluginTurnToolCall[],
  cwd: string | null,
): Step[] {
  return shapeSteps(
    toolCalls.map((call) => ({ item: { type: "tool_call", ...call } })),
    { sessionId: "", turnId: "", cwd, repoKey: null },
  ).steps;
}

export function whatItDidFromSteps(
  steps: Step[],
  took: number | null,
  note: string | null,
): WhatItDid {
  const lines: WhatItDid["lines"] = [];
  let reads: string[] = [],
    searches = 0;
  const flush = () => {
    if (reads.length) lines.push({ text: `Read ${listNames(reads)}`, failed: false });
    if (searches)
      lines.push({
        text: searches === 1 ? "Searched the project" : `Searched the project ${searches} times`,
        failed: false,
      });
    reads = [];
    searches = 0;
  };
  let tests: WhatItDid["tests"] = null;
  for (const step of steps) {
    if (step.kind === "read") {
      for (const file of step.files) {
        const name = file.path ?? OUTSIDE;
        if (!reads.includes(name)) reads.push(name);
      }
      continue;
    }
    if (step.kind === "search") {
      searches += 1;
      continue;
    }
    flush();
    const failed = step.outcome === "failed";
    if (step.summary.startsWith("Ran tests")) tests = failed ? "failed" : "passed";
    lines.push({
      text: step.changesFiles ? changeLine(step) : step.summary,
      failed,
    });
  }
  flush();
  return {
    size: [plural(steps.length, "step"), took === null ? null : duration(took)]
      .filter(Boolean)
      .join(" · "),
    tests,
    lines,
    commands: steps.flatMap((step) => (step.command ? [step.command] : [])),
    note,
  };
}
