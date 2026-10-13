import { execFile } from "node:child_process";
import type { Branch } from "../../shared/progress-board";
export interface CommandResult {
  code: number;
  output: string;
}
export type Run = (file: string, args: string[], cwd: string) => Promise<CommandResult>;
export const run: Run = (file, args, cwd) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { cwd, timeout: 5000, maxBuffer: 256 * 1024, windowsHide: true },
      (error, stdout) => {
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : -1) : 0,
          output: stdout.trim(),
        });
      },
    );
  });
export async function readBranch(directory: string, execute: Run = run): Promise<Branch> {
  const checkedAt = new Date().toISOString();
  const [head, name] = await Promise.all([
    execute("git", ["rev-parse", "HEAD"], directory),
    execute("git", ["symbolic-ref", "--short", "HEAD"], directory),
  ]);
  const result: Branch = {
    directory,
    head: head.code === 0 ? head.output : "",
    branch: name.code === 0 ? name.output : "Detached HEAD",
    state: "Unavailable",
    ci: "Unavailable",
    checkedAt,
  };
  if (head.code !== 0) return result;
  const base = await execute("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], directory);
  const merged = await execute(
    "git",
    ["merge-base", "--is-ancestor", head.output, base.code === 0 ? base.output : "origin/main"],
    directory,
  );
  result.state =
    merged.code === 0
      ? "Merged locally"
      : merged.code === 1
        ? "Unmerged locally"
        : "Merge state unavailable";
  if (name.code !== 0) return result;
  const prs = await execute(
    "gh",
    [
      "pr",
      "list",
      "--state",
      "all",
      "--head",
      name.output,
      "--limit",
      "20",
      "--json",
      "state,headRefOid,statusCheckRollup",
    ],
    directory,
  );
  if (prs.code !== 0) return result;
  try {
    const rows: unknown = JSON.parse(prs.output);
    if (!Array.isArray(rows)) return result;
    const pr = rows.find((row) => row.headRefOid === head.output);
    if (!pr) {
      result.ci = "No PR for this head";
      return result;
    }
    result.state =
      pr.state === "MERGED" ? "Merged PR" : pr.state === "OPEN" ? "Open PR" : "Closed PR";
    const checks = pr.statusCheckRollup;
    if (!Array.isArray(checks) || checks.length === 0) result.ci = "No checks";
    else if (
      checks.some((check) =>
        [
          "FAILURE",
          "ERROR",
          "CANCELLED",
          "TIMED_OUT",
          "ACTION_REQUIRED",
          "STARTUP_FAILURE",
        ].includes(check.conclusion || check.state),
      )
    )
      result.ci = "Failed";
    else if (
      checks.every((check) =>
        ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(check.conclusion || check.state),
      )
    )
      result.ci = "Passed";
    else result.ci = "Pending";
  } catch {
    result.ci = "Invalid CI response";
  }
  return result;
}
