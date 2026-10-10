// Fulcra: the "prepare" step. It installs the lefthook git hooks, unless git already has core.hooksPath set.
// On our Macs core.hooksPath is global and points at the guard hooks, which run `lefthook run <hook>` themselves.
// `lefthook install --force` replaced those guard hooks on each install (10 Oct), so it must not run there.
// It never fails outside a git checkout (CI cache, tarball, no git installed).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const defaultRun = (command, args, cwd) =>
  spawnSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

/** Returns the exit code: 0 when it skipped or installed, else the code of `lefthook install`. */
export function installGitHooks({ cwd = process.cwd(), run = defaultRun, log = console.log } = {}) {
  const inside = run("git", ["rev-parse", "--git-dir"], cwd);
  if (inside.error || inside.status !== 0) {
    log("git hooks: not a git checkout, skipped");
    return 0;
  }
  const hooksPath = run("git", ["config", "core.hooksPath"], cwd);
  if (!hooksPath.error && hooksPath.status === 0 && hooksPath.stdout?.trim()) {
    log("git hooks: core.hooksPath is set, lefthook install skipped");
    return 0;
  }
  const result = run("lefthook", ["install"], cwd);
  if (result.error) {
    log("git hooks: lefthook not found, skipped");
    return 0;
  }
  return result.status ?? 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = installGitHooks();
