import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, openSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = "Subrising/fulcra";
const workflows = new Set([".github/workflows/ci.yml", ".github/workflows/merge-pr.yml"]);

function readRun(runId) {
  const result = spawnSync("gh", ["api", `repos/${repository}/actions/runs/${runId}`], {
    encoding: "utf8",
    timeout: 60000,
  });
  if (result.status !== 0) throw new Error("Cannot read the retained workflow run");
  return JSON.parse(result.stdout);
}

function save(path, operation) {
  writeFileSync(`${path}.tmp`, `${JSON.stringify(operation, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

function matchesOperation(run, operation) {
  return !(
    run.repository.full_name !== repository ||
    run.id !== operation.runId ||
    run.run_attempt !== operation.attempt ||
    run.head_sha !== operation.headSha ||
    run.path !== operation.workflow
  );
}

async function completedRun(operation, { wait, read }) {
  // gh can exit on an annotation API timeout while CI still runs. Resume only
  // the same native wait. Never retry a delivered or uncertain notice.
  for (let attempt = 0; attempt < 3; attempt++) {
    let run;
    try {
      await wait(operation.runId);
      run = await read(operation.runId);
    } catch {
      continue;
    }
    if (!matchesOperation(run, operation)) {
      throw new Error("The completion does not match the registered run");
    }
    if (run.status === "completed" && /^[a-z_]{1,40}$/.test(run.conclusion ?? "")) return run;
  }
  throw new Error("Native workflow wait could not verify completion after three attempts");
}

export async function watchOperation(operation, { wait, read, deliver, persist }) {
  if (operation.notice !== "none")
    throw new Error("Reconcile the retained notice before another attempt");
  let summary;
  try {
    const run = await completedRun(operation, { wait, read });
    const label = operation.workflow === ".github/workflows/ci.yml" ? "CI" : "Merge PR";
    summary = `${run.conclusion === "success" ? "PASS" : "FAIL"}: ${label} (${run.conclusion}).`;
  } catch {
    summary =
      "BLOCKED: The CI watcher could not verify completion. Inspect the retained run before any retry.";
  }
  const message = `${summary}\n${operation.url}\nRun ${operation.runId}, attempt ${operation.attempt}, head ${operation.headSha}.`;
  operation.notice = "attempted";
  await persist(operation); // An uncertain send must never trigger an automatic resend.
  await deliver(operation.owner, message);
  operation.notice = "accepted";
  await persist(operation);
}

function waitForRun(runId) {
  return new Promise((done, reject) => {
    const child = spawn(
      "gh",
      [
        "run",
        "watch",
        String(runId),
        "-R",
        repository,
        "--exit-status",
        "--compact",
        "--interval",
        "10",
      ],
      {
        stdio: "inherit",
      },
    );
    child.once("error", reject);
    // A failing CI run also exits nonzero. Read its terminal conclusion before reporting it.
    child.once("exit", () => done());
  });
}

function sendNativeNotice(owner, message, statePath) {
  const promptPath = `${statePath}.notice.txt`;
  writeFileSync(promptPath, message, { mode: 0o600 });
  const result = spawnSync(
    process.env.FULCRA_CI_WATCH_CLI ?? "fulcra",
    ["send", owner, "--no-wait", "--json", "--prompt-file", promptPath],
    { encoding: "utf8", timeout: 60000 },
  );
  writeFileSync(
    `${statePath}.receipt.json`,
    JSON.stringify({
      exitCode: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    }),
    { mode: 0o600 },
  );
  if (result.status !== 0)
    throw new Error("Native notice failed or is uncertain; inspect its retained receipt");
}

async function main() {
  if (process.argv[2] === "--listen") {
    const path = process.argv[3];
    const operation = JSON.parse(readFileSync(path, "utf8"));
    await watchOperation(operation, {
      wait: waitForRun,
      read: readRun,
      deliver: (owner, message) => sendNativeNotice(owner, message, path),
      persist: (value) => save(path, value),
    });
    return;
  }
  const [runId, owner] = process.argv.slice(2);
  if (
    !/^[1-9][0-9]*$/.test(runId ?? "") ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(owner ?? "")
  ) {
    throw new Error("Usage: node watch-ci.mjs <run-id> <owner-session-UUID>");
  }
  const run = readRun(runId);
  if (
    run.repository.full_name !== repository ||
    !workflows.has(run.path) ||
    !/^[a-f0-9]{40}$/.test(run.head_sha ?? "") ||
    !Number.isInteger(run.run_attempt)
  ) {
    throw new Error("Only this repository's CI and merge runs can be watched");
  }
  const directory = resolve(
    process.env.FULCRA_CI_WATCH_DIR ?? join(homedir(), ".local/state/fulcra/ci-watch"),
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${runId}-${run.run_attempt}-${owner}.json`);
  const operation = {
    runId: Number(runId),
    attempt: run.run_attempt,
    headSha: run.head_sha,
    workflow: run.path,
    owner,
    url: `https://github.com/${repository}/actions/runs/${runId}`,
    notice: "none",
  };
  // Exclusive creation prevents duplicate registrations, including after a crash.
  writeFileSync(path, `${JSON.stringify(operation, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  const log = openSync(`${path}.log`, "a", 0o600);
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--listen", path], {
    detached: true,
    stdio: ["ignore", log, log],
    env: process.env,
  });
  child.once("error", (error) =>
    console.error(`Watcher launch failed. Retain ${path}: ${error.message}`),
  );
  child.unref();
  console.log(`watch_registered=${path}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
