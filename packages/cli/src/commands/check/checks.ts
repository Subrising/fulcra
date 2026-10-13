import { parseGitRemoteLocation, parseGitHubRemoteIdentity } from "@getpaseo/protocol/git-remote";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";

export interface CheckResult {
  check: string;
  pass: boolean;
  reason: string;
}
export interface CommandReply {
  code: number;
  stdout: string;
  stderr: string;
}
export type CheckRunner = (command: string, args: string[], cwd: string) => Promise<CommandReply>;
const execute = promisify(execFile);
export const runCheckCommand: CheckRunner = async (command, args, cwd) => {
  try {
    const executed = await execute(command, args, {
      cwd,
      timeout: 15000,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    });
    return { code: 0, stdout: executed.stdout, stderr: executed.stderr };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const parsed = z
      .object({
        code: z.union([z.number(), z.string()]).optional(),
        stdout: z.string().optional(),
        stderr: z.string().optional(),
      })
      .parse(error);
    return {
      code: typeof parsed.code === "number" ? parsed.code : 1,
      stdout: parsed.stdout ?? "",
      stderr: parsed.stderr || error.message,
    };
  }
};
function result(check: string, pass: boolean, reason: string): CheckResult {
  return { check, pass, reason };
}
function failure(check: string, reply: CommandReply): CheckResult {
  return result(check, false, reply.stderr.trim() || `Command exited ${reply.code}`);
}
function validRef(ref: string): void {
  if (
    !ref ||
    ref.startsWith("-") ||
    /\s/.test(ref) ||
    Array.from(ref).some((character) => character.charCodeAt(0) < 32)
  )
    throw new Error("Use a nonempty Git reference without spaces or leading dashes");
}

export async function checkIdentity(
  cwd: string,
  range: string,
  run: CheckRunner = runCheckCommand,
  fullResult = false,
): Promise<CheckResult[]> {
  validRef(range);
  const reply = await run(
    "git",
    ["log", "--format=%H%x09%an%x09%ae%x09%cn%x09%ce", range, "--"],
    cwd,
  );
  if (reply.code) return [failure("identity", reply)];
  const commits = reply.stdout.trim().split("\n").filter(Boolean);
  if (!commits.length) return [result("identity", false, "The range contains no commits")];
  const invalid = commits.filter((line) => {
    const [sha, author, authorEmail, committer, committerEmail] = line.split("\t");
    return (
      !/^[a-f0-9]{40,64}$/.test(sha ?? "") ||
      author !== "Fulcra" ||
      committer !== "Fulcra" ||
      authorEmail !== "fulcra@users.noreply.github.com" ||
      committerEmail !== "fulcra@users.noreply.github.com"
    );
  });
  const shown = fullResult ? invalid : invalid.slice(0, 5);
  const omitted = invalid.length - shown.length;
  const omittedReason = omitted ? `; ${omitted} more omitted; use --full-result` : "";
  return [
    result(
      "identity",
      invalid.length === 0,
      invalid.length
        ? `${invalid.length} of ${commits.length} commits have an invalid author or committer: ${shown.map((line) => line.split("\t")[0]).join(", ")}${omittedReason}`
        : `${commits.length} commits use the Fulcra author and committer`,
    ),
  ];
}
const PullRequest = z.object({
  headRefOid: z.string(),
  url: z.string(),
  state: z.enum(["OPEN", "MERGED", "CLOSED"]),
  statusCheckRollup: z
    .array(
      z.object({
        name: z.string().optional(),
        context: z.string().optional(),
        status: z.string().optional(),
        conclusion: z.string().nullable().optional(),
        state: z.string().optional(),
      }),
    )
    .nullable(),
});
export async function checkBranch(
  cwd: string,
  run: CheckRunner = runCheckCommand,
  remoteName = "origin",
): Promise<CheckResult[]> {
  validRef(remoteName);
  const branch = await run("git", ["symbolic-ref", "--short", "HEAD"], cwd);
  if (branch.code) return [failure("branch", branch)];
  const name = branch.stdout.trim();
  validRef(name);
  const head = await run("git", ["rev-parse", "HEAD"], cwd);
  if (head.code) return [failure("head", head)];
  const sha = head.stdout.trim();
  const remote = await run(
    "git",
    ["ls-remote", "--exit-code", remoteName, `refs/heads/${name}`],
    cwd,
  );
  const checks = [
    remote.code
      ? failure("remote-head", remote)
      : result(
          "remote-head",
          remote.stdout.trim().split(/\s+/)[0] === sha,
          `Local ${sha}; remote ${remote.stdout.trim().split(/\s+/)[0] || "missing"}`,
        ),
  ];
  const remoteUrl = await run("git", ["remote", "get-url", remoteName], cwd);
  if (remoteUrl.code) return [...checks, failure("pr-ci", remoteUrl)];
  const location = parseGitRemoteLocation(remoteUrl.stdout.trim());
  const identity = location ? parseGitHubRemoteIdentity(location.path) : null;
  if (!location || !identity)
    return [...checks, result("pr-ci", false, "The remote does not identify a GitHub repository")];
  const repository = `${location.host}/${identity.repo}`;
  const pr = await run(
    "gh",
    ["pr", "view", name, "--repo", repository, "--json", "headRefOid,statusCheckRollup,url,state"],
    cwd,
  );
  if (pr.code) return [...checks, failure("pr-ci", pr)];
  let json: unknown;
  try {
    json = JSON.parse(pr.stdout);
  } catch {
    return [...checks, result("pr-ci", false, "The PR response is not JSON")];
  }
  const parsed = PullRequest.safeParse(json);
  if (!parsed.success)
    return [...checks, result("pr-ci", false, "The PR response has an invalid shape")];
  const data = parsed.data;
  checks.push(
    result(
      "pr-head",
      data.headRefOid === sha && data.state !== "CLOSED",
      `${data.url}: ${data.state}; head ${data.headRefOid}`,
    ),
  );
  const ci = data.statusCheckRollup ?? [];
  const bad = ci.filter((check) =>
    check.state
      ? check.state !== "SUCCESS"
      : check.status !== "COMPLETED" ||
        !["SUCCESS", "SKIPPED", "NEUTRAL"].includes(check.conclusion ?? ""),
  );
  let ciReason = `${ci.length} CI checks passed`;
  if (!ci.length) ciReason = "The PR has no CI results";
  else if (bad.length)
    ciReason = bad
      .map(
        (check) =>
          `${check.name ?? check.context ?? "check"}: ${check.conclusion || check.state || check.status || "unknown"}`,
      )
      .join("; ");
  checks.push(result("pr-ci", ci.length > 0 && bad.length === 0, ciReason));
  return checks;
}

export async function checkWorktree(
  cwd: string,
  base: string,
  run: CheckRunner = runCheckCommand,
  remoteName = "origin",
): Promise<CheckResult[]> {
  validRef(base);
  validRef(remoteName);
  const listing = await run("git", ["worktree", "list", "--porcelain"], cwd);
  if (listing.code) return [failure("worktree", listing)];
  const main = listing.stdout.split("\n")[0];
  const location = await run("git", ["rev-parse", "--show-toplevel"], cwd);
  if (location.code) return [failure("worktree", location)];
  const isMain = main === `worktree ${location.stdout.trim()}`;
  const checks = [
    result(
      "worktree",
      !isMain,
      isMain
        ? "The main checkout cannot be removed as a worktree"
        : "This checkout is a linked worktree",
    ),
  ];
  const status = await run(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"],
    cwd,
  );
  checks.push(
    status.code
      ? failure("worktree-clean", status)
      : result(
          "worktree-clean",
          !status.stdout.trim(),
          status.stdout.trim()
            ? `Unsaved or ignored files remain: ${status.stdout.trim()}`
            : "No changed, untracked, or ignored files",
        ),
  );
  const target = await run("git", ["rev-parse", "--verify", `${base}^{commit}`], cwd);
  if (target.code) return [...checks, failure("worktree-merged", target)];
  if (base.startsWith(`${remoteName}/`)) {
    const remote = await run(
      "git",
      ["ls-remote", "--exit-code", remoteName, `refs/heads/${base.slice(remoteName.length + 1)}`],
      cwd,
    );
    if (remote.code) return [...checks, failure("worktree-merged", remote)];
    if (remote.stdout.trim().split(/\s+/)[0] !== target.stdout.trim())
      return [
        ...checks,
        result(
          "worktree-merged",
          false,
          "The merge target differs from the remote. Fetch before checking again",
        ),
      ];
  }
  const merged = await run(
    "git",
    ["merge-base", "--is-ancestor", "HEAD", target.stdout.trim()],
    cwd,
  );
  checks.push(
    result(
      "worktree-merged",
      merged.code === 0,
      merged.code === 0
        ? `HEAD is merged into ${base}`
        : merged.stderr.trim() || `HEAD is not merged into ${base}`,
    ),
  );
  return checks;
}

export function checkSessionArchive(agent: AgentSnapshotPayload | null): CheckResult[] {
  if (!agent) return [result("session", false, "Session not found")];
  const safety = agent.archiveSafety;
  if (!safety) return [result("session", false, "Update the host to read session archive safety")];
  const stopped =
    !safety.inFlight &&
    !agent.activeTurn &&
    agent.pendingPermissions.length === 0 &&
    !agent.backgroundWork?.count;
  const stopReason = stopped
    ? "No active turns, permissions, or background work"
    : `In-flight ${safety.inFlight}; active turn ${Boolean(agent.activeTurn)}; permissions ${agent.pendingPermissions.length}; background work ${agent.backgroundWork?.count ?? 0}`;
  return [
    result(
      "session-idle",
      agent.status === "idle" && !agent.archivedAt,
      `Status ${agent.status}; archived ${Boolean(agent.archivedAt)}`,
    ),
    result("session-stopped", stopped, stopReason),
    result(
      "session-messages",
      safety.heldMessages === 0,
      safety.heldMessages === null
        ? "Held message state is unknown"
        : `${safety.heldMessages} held or uncertain messages`,
    ),
    result(
      "session-reports",
      safety.heldReports === 0,
      safety.heldReports === null
        ? "Held report state is unknown"
        : `${safety.heldReports} held reports`,
    ),
  ];
}
export function formatChecks(checks: CheckResult[]): string {
  return checks
    .map(
      (check) =>
        `${check.pass ? "PASS" : "FAIL"} ${check.check}: ${check.reason.replace(/[\r\n]+/g, " ")}`,
    )
    .join("\n");
}
