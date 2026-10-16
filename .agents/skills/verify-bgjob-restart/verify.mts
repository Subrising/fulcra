import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { watch } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createPaseoClient, type PaseoClient } from "../../../packages/client/src/index.js";

// This check creates its own home and uses only retained scratch process handles.
const repo = fileURLToPath(new URL("../../..", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "fulcra-bgjob-restart-"));
const proofPath = resolve(process.argv[2] ?? join(root, "proof.json"));
await writeFile(proofPath, JSON.stringify({ result: "RUNNING", root }) + "\n");
const home = join(root, "home");
const project = join(root, "project");
await mkdir(home);
await mkdir(project);
execFileSync("git", ["init", "--initial-branch=main", project]);
await writeFile(
  join(home, "config.json"),
  JSON.stringify({
    daemon: { relay: { enabled: false } },
    pluginsEnabled: false,
  }),
);
const bgjob =
  process.env.BGJOB_COMMAND ??
  execFileSync("/bin/sh", ["-c", "command -v bgjob"], { encoding: "utf8" }).trim();
const session = `scratch-${Date.now()}`;
const jobs = join("/tmp/bgjob", session);
await mkdir(jobs, { recursive: true });
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^(PASEO_|FULCRA_|ORCA_)/.test(key)) delete env[key];
}
Object.assign(env, {
  PASEO_HOME: home,
  PASEO_LISTEN: "127.0.0.1:0",
  PASEO_RELAY_ENABLED: "false",
  NODE_OPTIONS: "--max-old-space-size=512",
  PASEO_LOG_LEVEL: "warn",
});
const events: object[] = [];
function record(event: string, fields: object = {}) {
  events.push({ at: new Date().toISOString(), event, ...fields });
}
async function waitForFile<T>(
  directory: string,
  check: () => Promise<T | null>,
  timeoutMs: number,
): Promise<T> {
  return new Promise((accept, reject) => {
    let checking = false;
    const watcher = watch(directory, () => {
      void checkNow();
    });
    const timer = setTimeout(
      () => finish(new Error(`File event timed out in ${directory}`)),
      timeoutMs,
    );
    function finish(error: Error | null, value?: T) {
      watcher.close();
      clearTimeout(timer);
      if (error) reject(error);
      else accept(value!);
    }
    async function checkNow() {
      if (checking) return;
      checking = true;
      try {
        const value = await check();
        if (value !== null) finish(null, value);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      } finally {
        checking = false;
      }
    }
    void checkNow();
  });
}
async function readOptional(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}
let supervisor: ChildProcess | null = null;
let client: PaseoClient | null = null;
let boot = 0;
async function start() {
  boot++;
  const child = spawn(process.execPath, ["packages/server/dist/scripts/supervisor-entrypoint.js"], {
    cwd: repo,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  supervisor = child;
  let output = "";
  child.stdout!.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr!.on("data", (chunk) => {
    output += chunk;
  });
  child.on("exit", () => {
    void writeFile(join(root, `boot-${boot}.log`), output);
    void writeFile(join(home, `boot-${boot}.exit`), String(child.exitCode));
  });
  const lock = await waitForFile(
    home,
    async () => {
      if (child.exitCode !== null) throw new Error(`Scratch startup failed: ${output}`);
      const text = await readOptional(join(home, "paseo.pid"));
      if (!text) return null;
      const value = JSON.parse(text);
      if (value.pid !== child.pid || !value.listen) return null;
      return value;
    },
    60_000,
  );
  assert.match(lock.listen, /^127\.0\.0\.1:\d+$/);
  assert.notEqual(lock.listen, "127.0.0.1:6767");
  client = createPaseoClient({ url: `ws://${lock.listen}/ws` });
  await client.connect();
  record("scratch-started", { pid: child.pid, listen: lock.listen, home });
  return client;
}
async function stop(force: boolean) {
  const child = supervisor!;
  const exit = once(child, "exit");
  await client?.close();
  client = null;
  if (force) {
    const table = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,comm="], { encoding: "utf8" });
    const workers = table
      .split("\n")
      .map((line) => /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line))
      .filter(
        (row) => row && Number(row[2]) === child.pid && /Fulcra Daemon|daemon-worker/.test(row[3]!),
      )
      .map((row) => Number(row![1]));
    assert.equal(workers.length, 1);
    process.kill(workers[0]!, "SIGSTOP");
    record("scratch-worker-paused", { pid: workers[0] });
  }
  record("scratch-stop-requested", { pid: child.pid, force });
  child.kill("SIGTERM");
  let timer: NodeJS.Timeout;
  let result: unknown;
  try {
    result = await Promise.race([
      exit,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Scratch supervisor did not stop")), 45_000);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
  record("scratch-stopped", { result });
  supervisor = null;
}
try {
  const first = await start();
  const workspace = await first.workspaces.create({
    source: { kind: "directory", path: project },
    title: "Restart proof",
  });
  // Keep the original parent alive. This exposes PPID tree cleanup across setsid.
  const holder = join(root, "holder.cjs");
  await writeFile(
    holder,
    `
    const {spawn,spawnSync}=require('node:child_process');
    const fs=require('node:fs');
    for (const [label,seconds,code] of [['long',60,0],['offline',5,7]]) {
      const child=spawn('/bin/bash', [${JSON.stringify(bgjob)}, '__run', label, '--', '/bin/sh', '-c',
        'echo START-'+label+'; sleep '+seconds+'; echo END-'+label+'; exit '+code], {
        detached:true, stdio:'ignore', env:{...process.env,PASEO_AGENT_ID:${JSON.stringify(session)}}
      });
      fs.writeFileSync(${JSON.stringify(jobs)}+'/'+label+'.pgid',String(child.pid));
      child.unref();
    }
    const publicJob=spawnSync('/bin/bash', [${JSON.stringify(bgjob)}, 'public', '--', '/bin/sh', '-c',
      'echo START-public; sleep 5; echo END-public; exit 9'], {
      env:{...process.env,PASEO_AGENT_ID:${JSON.stringify(session)},BGJOB_CLI:'/usr/bin/false'}, encoding:'utf8'
    });
    if (publicJob.status!==0) throw new Error(publicJob.stderr);
    fs.writeFileSync(${JSON.stringify(join(root, "jobs-ready"))}, String(process.pid));
    setInterval(()=>{},1000);
  `,
  );
  await first.terminals.create({
    workspaceId: workspace.id,
    command: process.execPath,
    args: [holder],
  });
  await waitForFile(root, async () => await readOptional(join(root, "jobs-ready")), 15_000);
  const jobPid = Number(await readFile(join(jobs, "long.pgid"), "utf8"));
  const holderPid = Number(await readFile(join(root, "jobs-ready"), "utf8"));
  record("bgjobs-started", { jobPid, seconds: 60, jobs });
  const before = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,pgid=,comm="], { encoding: "utf8" });
  await writeFile(join(root, "processes-before.txt"), before);
  await stop(true);
  process.kill(jobPid, 0);
  assert.throws(() => process.kill(holderPid, 0), { code: "ESRCH" });
  assert.equal(await readFile(join(jobs, "offline.exit"), "utf8"), "7\n");
  assert.equal(await readFile(join(jobs, "public.exit"), "utf8"), "9\n");
  record("public-bgjob-completed-offline", {
    exit: 9,
    output: await readFile(join(jobs, "public.log"), "utf8"),
    completionNotificationTested: false,
  });
  record("survived-stop", {
    jobPid,
    offlineExit: 7,
    offlineOutput: await readFile(join(jobs, "offline.log"), "utf8"),
  });
  const second = await start();
  await waitForFile(jobs, async () => await readOptional(join(jobs, "long.exit")), 75_000);
  assert.equal(await readFile(join(jobs, "long.exit"), "utf8"), "0\n");
  const terminal = await second.terminals.create({ workspaceId: workspace.id, command: "/bin/sh" });
  terminal.write(
    `printf 'LONG OUTPUT\\n'; cat '${jobs}/long.log'; printf 'LONG EXIT='; cat '${jobs}/long.exit'; printf 'OFFLINE OUTPUT\\n'; cat '${jobs}/offline.log'; printf 'OFFLINE EXIT='; cat '${jobs}/offline.exit'; printf 'PUBLIC OUTPUT\\n'; cat '${jobs}/public.log'; printf 'PUBLIC EXIT='; cat '${jobs}/public.exit'; printf 'REATTACHED\\n'\n`,
  );
  await delay(1500);
  const capture = await terminal.capture({ stripAnsi: true });
  const text = capture.lines.join("\n");
  assert.match(text, /START-long[\s\S]*END-long[\s\S]*LONG EXIT=0/);
  assert.match(text, /START-offline[\s\S]*END-offline[\s\S]*OFFLINE EXIT=7/);
  assert.match(text, /START-public[\s\S]*END-public[\s\S]*PUBLIC EXIT=9/);
  assert.match(text, /REATTACHED/);
  await writeFile(join(root, "reattached-terminal.txt"), text);
  record("output-and-status-reattached", {
    longExit: 0,
    offlineExit: 7,
    terminalId: terminal.id,
    text,
  });
  await stop(false);
  const daemonLog = await readFile(join(home, "daemon.log"), "utf8");
  assert.match(daemonLog, /forcing process tree kill/);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  const proof = { result: "PASS", head, root, events };
  await writeFile(proofPath, JSON.stringify(proof, null, 2) + "\n");
  process.stdout.write(`PASS ${proofPath}\n`);
} catch (error) {
  await writeFile(
    proofPath,
    JSON.stringify({ result: "FAIL", root, events, error: String(error) }, null, 2) + "\n",
  );
  throw error;
} finally {
  await client?.close();
  if (supervisor && supervisor.exitCode === null) {
    supervisor.kill("SIGTERM");
    await once(supervisor, "exit");
  }
  // Keep the scratch files as evidence. Never stop a process found by a name or port.
}
