// Pure step shaping for the step-through (J6): one turn's timeline entries into plain-language steps with
// project-relative paths only. Shared so the server reads and the in-chat "What it did" footer say the same thing;
// nothing here touches the host or its configuration.
import type { Step } from "./session-steps";
import { parseRef } from "./cc/refs";
import { OUTSIDE_PROJECT, placePath as placeSharedPath, scrubFreeText } from "./privacy-scrub";

const isRef = (value: unknown, kind: string) => parseRef(value)?.kind === kind;

// Placement and free-text scrubbing: one shared scrubber (shared/privacy-scrub.ts, CONTRACTS v1.14 STEP-THROUGH)
// for every emitted text field -- asked, why, command, output and diff bodies.
/** A project-relative file path, or null for a file outside the project (or the project folder itself). */
export function placePath(filePath: string, cwd: string | null): string | null {
  return placeSharedPath(filePath, cwd) || null;
}
/** A diff with every path in its headers and body placed, and personal data removed, line by line. */
export function scrubDiff(diff: string, cwd: string | null): string {
  return diff
    .split("\n")
    .map((line) => scrubFreeText(line, cwd))
    .join("\n");
}

/** Relative, normalised and inside the project: exactly what placement without a cwd leaves unchanged. */
export const storable = (candidate: string) => placeSharedPath(candidate, null) === candidate;
export const clip = (text: string, max: number) =>
  text.length <= max ? text : text.slice(0, max - 1) + "…";
export const tail = (text: string, max: number) =>
  text.length <= max ? text : "…" + text.slice(text.length - max + 1);
export const count = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------------------------------------------------------
// Plain-language summaries.
const TEST_COMMAND =
  /\b(?:vitest|jest|pytest|mocha|ava|playwright test|go test|cargo test|rspec|phpunit)\b|--test\b|\b(?:npm|pnpm|yarn|bun) (?:run )?test\b|\btest(?:s)?\b(?=\s|$)/;

/** Pass/fail counts from common test runners' closing lines, or null when the output says nothing countable. */
export function testCounts(output: string): { passed: number; failed: number } | null {
  const last = (re: RegExp) => {
    let found: number | null = null;
    for (const m of output.matchAll(re)) found = Number(m[1]);
    return found;
  };
  const tapPass = last(/^# pass (\d+)/gm),
    tapFail = last(/^# fail (\d+)/gm);
  if (tapPass !== null || tapFail !== null) return { passed: tapPass ?? 0, failed: tapFail ?? 0 };
  const passed = last(/(\d+) passed/g),
    failed = last(/(\d+) failed/g);
  return passed === null && failed === null ? null : { passed: passed ?? 0, failed: failed ?? 0 };
}

export function commandSummary(
  command: string,
  output: string,
  exitCode: number | null,
  failed: boolean,
): string {
  if (TEST_COMMAND.test(command)) {
    const counts = testCounts(output);
    if (counts)
      return counts.failed
        ? `Ran tests: ${counts.failed} failed, ${counts.passed} passed`
        : `Ran tests: ${counts.passed} passed`;
    return failed || (exitCode !== null && exitCode !== 0) ? "Ran tests: they failed" : "Ran tests";
  }
  return failed || (exitCode !== null && exitCode !== 0)
    ? "Ran a command: it failed"
    : "Ran a command";
}

function filesSummary(files: Step["files"]): string {
  const inside = files.filter((f) => f.path !== null),
    outside = files.length - inside.length;
  const verb = files.every((f) => f.change === "read")
    ? "Read"
    : files.every((f) => f.change === "created")
      ? "Created"
      : files.every((f) => f.change === "written")
        ? "Wrote"
        : files.every((f) => f.change === "deleted")
          ? "Deleted"
          : files.every((f) => f.change === "edited")
            ? "Edited"
            : "Changed";
  if (!inside.length)
    return `${verb} ${outside === 1 ? OUTSIDE_PROJECT : `${outside} files outside the project`}`;
  return `${verb} ${count(inside.length, "file")}${outside ? ` and ${count(outside, "file")} outside the project` : ""}`;
}

/** One headline for a whole turn, from its steps. */
export function turnHeadline(steps: Step[]): string {
  if (!steps.length) return "Answered without using tools";
  const changed = new Set<string>(),
    outside = { n: 0 };
  for (const step of steps)
    for (const file of step.files)
      if (file.change !== "read") {
        if (file.path) changed.add(file.path);
        else outside.n += 1;
      }
  const tests = steps.filter((s) => s.summary.startsWith("Ran tests")).at(-1);
  const parts: string[] = [];
  if (changed.size || outside.n) parts.push(`Changed ${count(changed.size + outside.n, "file")}`);
  if (tests)
    parts.push(tests.summary.replace(/^Ran tests/, parts.length ? "ran tests" : "Ran tests"));
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
  const folder =
    cwd
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .at(-1) ?? "";
  const slug = folder
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
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
const changeOf = (kind: unknown): Step["files"][number]["change"] =>
  kind === "add" ? "created" : kind === "delete" ? "deleted" : "edited";
const addedDiff = (path: string, content: string) =>
  [`--- /dev/null`, `+++ ${path}`, ...content.split("\n").map((line) => `+${line}`)].join("\n");

function textOf(item: any): string | null {
  if (item?.type === "reasoning" || item?.type === "assistant_message")
    return typeof item.text === "string" && item.text.trim() ? item.text.trim() : null;
  return null;
}

export function shapeSteps(
  entries: any[],
  context: { sessionId: string; turnId: string; cwd: string | null; repoKey: string | null },
): { steps: Step[]; asked: string | null } {
  const { cwd, repoKey } = context,
    ref = turnRef(context.sessionId, context.turnId),
    steps: Step[] = [];
  let why: string | null = null,
    asked: string | null = null;
  const file = (raw: string, change: Step["files"][number]["change"], diff: string | null) => {
    const path = placePath(raw, cwd);
    return {
      path,
      change,
      diff: path && diff ? clip(scrubDiff(diff, cwd), 24000) : null,
      ref: fileRef(repoKey, path),
    };
  };
  for (const entry of entries) {
    const item = entry?.item;
    if (item?.type === "user_message") {
      asked ??=
        typeof item.text === "string" ? clip(scrubFreeText(item.text.trim(), cwd), 1500) : null;
      continue;
    }
    const said = textOf(item);
    if (said) {
      why = clip(scrubFreeText(said, cwd), 1500);
      continue;
    }
    if (item?.type !== "tool_call") continue;
    const detail = item.detail ?? {},
      failed = item.status === "failed";
    let kind: Step["kind"] = "other",
      summary = "Used a tool",
      files: Step["files"] = [];
    let command: string | null = null,
      exitCode: number | null = null,
      output: string | null = null;
    if (
      (detail.type === "edit" || detail.type === "unknown") &&
      Array.isArray(detail.files) &&
      detail.files.length
    ) {
      files = detail.files.map((f: any) =>
        file(
          String(f.path ?? ""),
          changeOf(f.kind),
          typeof f.unifiedDiff === "string" ? f.unifiedDiff : null,
        ),
      );
      kind = "edit";
    } else if (detail.type === "edit") {
      const diff =
        typeof detail.unifiedDiff === "string"
          ? detail.unifiedDiff
          : typeof detail.newString === "string"
            ? [
                `--- ${detail.filePath}`,
                `+++ ${detail.filePath}`,
                ...(detail.oldString ?? "")
                  .split("\n")
                  .filter(Boolean)
                  .map((l: string) => `-${l}`),
                ...detail.newString.split("\n").map((l: string) => `+${l}`),
              ].join("\n")
            : null;
      files = [file(String(detail.filePath ?? ""), "edited", diff)];
      kind = "edit";
    } else if (detail.type === "write") {
      files = [
        file(
          String(detail.filePath ?? ""),
          "written",
          typeof detail.content === "string"
            ? addedDiff(String(detail.filePath), detail.content)
            : null,
        ),
      ];
      kind = "create";
    } else if (detail.type === "read") {
      files = [file(String(detail.filePath ?? ""), "read", null)];
      kind = "read";
    } else if (detail.type === "shell") {
      kind = "command";
      command = clip(scrubFreeText(String(detail.command ?? ""), cwd), 2000);
      exitCode = Number.isInteger(detail.exitCode) ? detail.exitCode : null;
      output =
        typeof detail.output === "string" && detail.output
          ? tail(scrubFreeText(detail.output, cwd), 4000)
          : null;
      summary = commandSummary(command, detail.output ?? "", exitCode, failed);
    } else if (detail.type === "search") {
      kind = detail.toolName === "web_search" ? "web" : "search";
      summary = kind === "web" ? "Searched the web" : "Searched the project";
    } else if (detail.type === "fetch") {
      kind = "web";
      summary = "Read a web page";
    }
    if (files.length) summary = filesSummary(files);
    const outcome: Step["outcome"] =
      failed || (exitCode !== null && exitCode !== 0)
        ? "failed"
        : item.status === "running"
          ? "running"
          : "done";
    steps.push({
      n: steps.length,
      seq: Number(entry.seqStart ?? entry.seq ?? 0),
      at: String(entry.timestamp ?? ""),
      kind,
      summary,
      outcome,
      changesFiles: files.some((f) => f.change !== "read"),
      files,
      command,
      exitCode,
      output,
      why,
      ref,
    });
  }
  return { steps, asked };
}
