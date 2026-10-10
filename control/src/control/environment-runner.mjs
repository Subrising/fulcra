// Fulcra J8: the only code that executes anything for Environments (CONTRACTS §6.2 #1).
// - Clean checkouts in a Fulcra-owned folder, removed afterwards: one of the environment's `definitionCommit` (the
//   version its approved definition pinned), whose scripts run, and one of the candidate commit, which is only data
//   (v1.15, J8-4). The candidate's path is given to the scripts as FULCRA_CANDIDATE_DIR; nothing in it is executed.
// - Scripts are repository files at the definition commit, run directly with an argv array: never a shell string.
// - The environment is an allowlist; nothing from the controller's own environment leaks in.
// - Every run has a timeout, after which the script's whole process group is killed.
// Nothing here knows about hosts: what a script deploys to is the script's business, and the tests use fake scripts.
import fs from "node:fs";
import path from "node:path";
import { spawn, execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  relpath,
  LIMITS,
  EnvironmentRefused,
} from "../../orca-organization/shared/cc/environment-rules.mjs";
import { noPersonal } from "../../orca-organization/shared/cc/refs.mjs";

const MAX_LINES_PER_RUN = 60;
const GIT_ENV = {
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  LANG: "C",
};
const git = (args, cwd, timeout = 120000) =>
  new Promise((resolve, reject) =>
    execFile(
      "git",
      args,
      {
        cwd,
        env: { ...GIT_ENV, HOME: cwd ?? "/nonexistent" },
        timeout,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout) => (error ? reject(new Error(`git ${args[0]} failed`)) : resolve(stdout)),
    ),
  );

/** A clean, detached checkout of `sha` from the local repository `source`, under the Fulcra-owned `root`. */
export async function cleanCheckout({ source, sha, root }) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new EnvironmentRefused("A full commit id is required");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = path.join(fs.realpathSync(root), randomUUID());
  try {
    await git(["clone", "--quiet", "--no-checkout", "--no-hardlinks", "--", source, dir], root);
    await git(["-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", sha], dir);
    const head = (await git(["rev-parse", "HEAD"], dir)).trim();
    if (head !== sha) throw new Error("The checkout is not the promoted commit");
    return dir;
  } catch (error) {
    removeCheckout(dir, root);
    throw new EnvironmentRefused(`That commit could not be checked out cleanly (${error.message})`);
  }
}
export function removeCheckout(dir, root) {
  const base = fs.existsSync(root) ? fs.realpathSync(root) : root;
  if (typeof dir === "string" && dir.startsWith(base + path.sep))
    fs.rmSync(dir, { recursive: true, force: true });
}
/** The files that differ between two commits, for "what changes". Read-only. */
export async function changedFiles({ source, from, to }) {
  const out = await git(["diff", "--name-only", `${from}..${to}`], source);
  return out.split("\n").filter(Boolean);
}
/** The commit the local copy is at now: what a proposed definition pins as its `definitionCommit`. */
export async function headCommit({ source }) {
  const sha = (
    await git(["rev-parse", "--verify", "HEAD^{commit}"], source).catch(() => "")
  ).trim();
  if (!/^[0-9a-f]{40}$/.test(sha))
    throw new EnvironmentRefused("The local copy of this repository has no current version");
  return sha;
}
export async function commitExists({ source, sha }) {
  try {
    return (await git(["cat-file", "-t", sha], source)).trim() === "commit";
  } catch {
    return false;
  }
}

/** §6.2 #1 against the real files: the script must be a regular, executable file inside the checkout. */
export function resolveScript(checkout, script) {
  relpath(script);
  const base = fs.realpathSync(checkout),
    full = path.join(base, script);
  let real;
  try {
    real = fs.realpathSync(full);
  } catch {
    throw new EnvironmentRefused(`${script} does not exist at this commit`);
  }
  if (!real.startsWith(base + path.sep))
    throw new EnvironmentRefused(`${script} points outside the repository`);
  const st = fs.statSync(real);
  if (!st.isFile()) throw new EnvironmentRefused(`${script} is not a file`);
  if (!(st.mode & 0o100)) throw new EnvironmentRefused(`${script} is not executable`);
  return real;
}
/**
 * The allowlisted environment a script sees. HOME is the scripts' checkout, so no personal configuration is read.
 * FULCRA_CANDIDATE_DIR is the candidate commit's checkout, to read (empty when there is none).
 */
export function scriptEnv(checkout, context) {
  return {
    PATH: `/usr/bin:/bin:/usr/sbin:/sbin:${path.dirname(process.execPath)}`,
    LANG: "C",
    HOME: checkout,
    TMPDIR: path.join(checkout, ".fulcra-tmp"),
    FULCRA_ENVIRONMENT: context.environment,
    FULCRA_COMMIT: context.commit,
    FULCRA_PROMOTION: context.promotion ?? "",
    FULCRA_STEP: context.step,
    FULCRA_CANDIDATE_DIR: context.candidate ?? "",
  };
}
/** A log line as it may be stored: no checkout path, no personal data, bounded. */
export function scrubLine(line, checkout, candidate = null) {
  const clean = (candidate ? line.split(candidate).join("$FULCRA_CANDIDATE_DIR") : line)
    .split(checkout)
    .join(".")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .trim();
  if (!noPersonal(clean)) return "(line withheld: it contained a personal path, host or secret)";
  return clean.length > LIMITS.logLine ? `${clean.slice(0, LIMITS.logLine - 1)}…` : clean;
}
// v1.15 §6.2 (J8-2): every script is the leader of its own process group, and the group is what gets stopped. A
// script's exit ends its step: anything it left running in its group is stopped too, and output a leftover still
// holds open is not waited for past a short grace. (A process that leaves the group on purpose, with setsid, is out
// of reach; that is outside what a step may do.)
const GRACE_MS = 500;
/** SIGKILL a whole process group: 'killed', 'gone' (nothing left) or 'denied' (not ours to signal). */
export function killGroup(pgid) {
  if (!Number.isSafeInteger(pgid) || pgid <= 1) return "gone";
  try {
    process.kill(-pgid, "SIGKILL");
    return "killed";
  } catch (error) {
    return error.code === "EPERM" ? "denied" : "gone";
  }
}
export function groupAlive(pgid) {
  if (!Number.isSafeInteger(pgid) || pgid <= 1) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
/** Snapshot an owned group leader; unavailable identity never authorizes later recovery. */
export function captureGroupOwner(pid, platform = process.platform) {
  // Windows has no process groups or ps: an unverifiable identity never authorizes recovery.
  if (platform === "win32") return null;
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  try {
    const output = execFileSync("/bin/ps", ["-p", String(pid), "-o", "pid=,pgid=,uid=,lstart="], {
      encoding: "utf8",
      timeout: 1000,
      maxBuffer: 1024,
    }).trim();
    const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(output);
    if (
      !match ||
      Number(match[1]) !== pid ||
      Number(match[2]) !== pid ||
      Number(match[3]) !== process.getuid() ||
      !match[4].trim()
    )
      return null;
    return Object.freeze({ pid, pgid: pid, uid: Number(match[3]), startedAt: match[4].trim() });
  } catch {
    return null;
  }
}
/** A durable pgid alone is not ownership. Recheck the exact leader lifetime before signalling. */
export function recoverOwnedGroup(
  pgid,
  owner,
  { inspect = captureGroupOwner, kill = killGroup } = {},
) {
  if (
    !owner ||
    !Number.isSafeInteger(pgid) ||
    pgid <= 1 ||
    owner.pid !== pgid ||
    owner.pgid !== pgid ||
    !Number.isSafeInteger(owner.uid) ||
    typeof owner.startedAt !== "string" ||
    !owner.startedAt
  )
    return "unverified";
  const current = inspect(pgid);
  if (
    !current ||
    current.pid !== owner.pid ||
    current.pgid !== owner.pgid ||
    current.uid !== owner.uid ||
    current.startedAt !== owner.startedAt
  )
    return "unverified";
  return kill(pgid);
}
/**
 * Runs one script: `{ ok, code, timedOut, cancelled, lines }`. Refusals (bad path, not executable) throw
 * EnvironmentRefused before anything starts. `onGroup(pgid, owner)` is told the process group once it exists, and
 * `onGroup(null)` once it is gone; `signal` cancels (the group is killed).
 */
export function runScript({
  checkout,
  script,
  args,
  timeoutS,
  context,
  signal = null,
  onGroup = () => {},
  platform = process.platform,
}) {
  if (platform === "win32")
    throw new EnvironmentRefused(
      "Environment scripts need POSIX process groups and are not available on Windows",
    );
  const file = resolveScript(checkout, script);
  fs.mkdirSync(path.join(checkout, ".fulcra-tmp"), { recursive: true });
  return new Promise((resolve) => {
    const lines = [];
    let buffer = "",
      stopped = null,
      settled = false,
      grace = null;
    const child = spawn(file, args, {
      cwd: checkout,
      env: scriptEnv(checkout, context),
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      detached: true,
    });
    const pgid = child.pid ?? null;
    if (pgid) onGroup(pgid, captureGroupOwner(pgid));
    const take = (chunk) => {
      buffer += chunk.toString("utf8");
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const p of parts)
        if (p.trim() && lines.length < MAX_LINES_PER_RUN)
          lines.push(scrubLine(p, checkout, context.candidate));
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const stop = (why) => {
      if (settled || stopped) return;
      stopped = why;
      killGroup(pgid);
    };
    const timer = setTimeout(() => stop("timeout"), timeoutS * 1000);
    const cancel = () => stop("cancelled");
    signal?.addEventListener("abort", cancel, { once: true });
    const finish = (code, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      signal?.removeEventListener("abort", cancel);
      killGroup(pgid);
      child.stdout.destroy();
      child.stderr.destroy();
      onGroup(null);
      if (buffer.trim() && lines.length < MAX_LINES_PER_RUN)
        lines.push(scrubLine(buffer, checkout, context.candidate));
      if (error) lines.push(`The script could not start (${error.code ?? "error"})`);
      if (stopped === "timeout") lines.push(`Stopped after ${timeoutS} s: the time limit`);
      if (stopped === "cancelled") lines.push("Stopped: cancelled");
      resolve({
        ok: !error && !stopped && code === 0,
        code: code ?? null,
        timedOut: stopped === "timeout",
        cancelled: stopped === "cancelled",
        lines,
      });
    };
    child.on("error", (error) => finish(null, error));
    // The script has exited: stop what it left in its group now, and read what is already written, briefly.
    child.on("exit", (code) => {
      killGroup(pgid);
      grace = setTimeout(() => finish(code, null), GRACE_MS);
    });
    child.on("close", (code) => finish(code, null));
    if (signal?.aborted) cancel();
  });
}
