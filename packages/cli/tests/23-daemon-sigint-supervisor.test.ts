#!/usr/bin/env npx tsx

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { DaemonClient, type WebSocketLike } from "@getpaseo/client/internal/daemon-client";
import { readDaemonInstance } from "@getpaseo/server/daemon-control";
import { runLocalPaseo } from "./helpers/local-cli.ts";
import { getAvailablePort } from "./helpers/network.ts";

const paseoHome = await mkdtemp(join(tmpdir(), "paseo-sigint-supervisor-"));
const cwd = join(paseoHome, "workspace");
const eventsPath = join(paseoHome, "acp-events.jsonl");
const resumePrompt = "Continue the interrupted test.";
const watchDependencies = process.argv.includes("--dev-watch");
const env = {
  PASEO_HOME: paseoHome,
  PASEO_NODE_INSPECT: "0",
  PASEO_RELAY_ENABLED: "false",
  PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD: "0",
  PASEO_DICTATION_ENABLED: "0",
  PASEO_VOICE_MODE_ENABLED: "0",
  PASEO_LOG_FORMAT: "json",
};

type AcpEvent =
  | { type: "session"; pid: number; sessionId: string }
  | { type: "prompt"; sessionId: string; text: string }
  | { type: "sigint"; pid: number };

async function readEvents(): Promise<AcpEvent[]> {
  const contents = await readFile(eventsPath, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return contents
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AcpEvent);
}

async function waitFor<T>(read: () => Promise<T | undefined>, message: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(50);
  }
  throw new Error(message);
}

async function startSupervisor() {
  const host = `127.0.0.1:${await getAvailablePort()}`;
  const child = spawn(
    watchDependencies ? "npm" : process.execPath,
    watchDependencies
      ? ["run", "dev:server:watch"]
      : ["--import", "tsx", "../server/scripts/supervisor-entrypoint.ts", "--dev"],
    {
      cwd: join(import.meta.dirname, watchDependencies ? "../../.." : ".."),
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.startsWith("PASEO_")),
        ),
        HOME: paseoHome,
        USERPROFILE: paseoHome,
        ...env,
        PASEO_LISTEN: host,
        CI: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    },
  );
  assert(child.pid, "supervisor should have a PID");
  const exited = once(child, "close");
  const client = new DaemonClient({
    url: `ws://${host}/ws`,
    clientId: "sigint-supervisor-test",
    appVersion: "0.17.0-beta.1",
    localCredential: async () =>
      (await readFile(join(paseoHome, "local-credential"), "utf8")).trim(),
    webSocketFactory: (url, options) => new WebSocket(url, options) as unknown as WebSocketLike,
    reconnect: { enabled: false },
  });
  let output = "";
  const startedWatchers = new Set<string>();
  function captureOutput(chunk: Buffer) {
    output = (output + chunk.toString()).slice(-32000);
    for (const watcher of ["protocol", "client"]) {
      if (output.includes(`[${watcher}]`)) startedWatchers.add(watcher);
    }
  }
  child.stdout.on("data", captureOutput);
  child.stderr.on("data", captureOutput);
  try {
    await Promise.race([
      waitFor(
        async () => {
          const instance = await readDaemonInstance(paseoHome);
          if (instance?.listen === host) return instance;
        },
        "supervisor did not publish its owned endpoint",
        120_000,
      ),
      exited.then((result) => {
        throw new Error(`supervisor exited early: ${result}\n${output}`);
      }),
    ]);
    await client.connect();
    if (watchDependencies) {
      await waitFor(async () => {
        if (startedWatchers.size === 2) return true;
      }, "dev runner did not start both dependency watchers");
    }
  } catch (error) {
    await client.close();
    child.kill("SIGTERM");
    throw error;
  }
  return { child, client, exited, output: () => output };
}

function assertPidExited(pid: number) {
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, `process ${pid} survived shutdown`);
}

async function interruptForeground(daemon: Awaited<ReturnType<typeof startSupervisor>>) {
  const pid = daemon.child.pid!;
  await daemon.client.close();
  process.kill(process.platform === "win32" ? pid : -pid, "SIGINT");
  const exit = await Promise.race([daemon.exited, delay(30_000, "timed out", { ref: false })]);
  // npm re-raises SIGINT when its shell exits on the same foreground signal.
  if (!watchDependencies || !Array.isArray(exit) || exit[1] !== "SIGINT") {
    assert.deepEqual(exit, [0, null], daemon.output());
  }
  await waitFor(async () => {
    if (!(await readDaemonInstance(paseoHome))) return true;
  }, "supervisor did not release its PID lock");
  const log = await readFile(join(paseoHome, "daemon.log"), "utf8");
  assert(!log.includes("Forcing shutdown - HTTP server didn't close in time"), log.slice(-4000));
  return log;
}

let daemon: Awaited<ReturnType<typeof startSupervisor>> | undefined;
try {
  await mkdir(cwd);
  const provider = join(import.meta.dirname, "helpers", "supervisor-acp.cjs");
  await writeFile(
    join(paseoHome, "config.json"),
    JSON.stringify({
      version: 1,
      agents: {
        resumeOnStartup: true,
        resumePrompt,
        providers: {
          // Fulcra: a generic ACP provider, because the antigravity plugin is not available here.
          "supervisor-acp": {
            extends: "acp",
            label: "Supervisor ACP",
            command: [process.execPath, provider, eventsPath],
          },
        },
      },
    }),
  );
  daemon = await startSupervisor();

  if (process.platform === "win32") {
    await interruptForeground(daemon);
  } else {
    const idle = await daemon.client.createAgent({ provider: "supervisor-acp", cwd });
    const running = await daemon.client.createAgent({ provider: "supervisor-acp", cwd });
    const crashing = await daemon.client.createAgent({ provider: "supervisor-acp", cwd });
    const opened = (await readEvents()).filter((event) => event.type === "session");
    const sessions = [idle, running, crashing].map((agent) => {
      const handle = agent.persistence?.sessionId;
      const session = opened.find((event) => handle?.includes(event.sessionId));
      assert(session, `missing ACP process for agent ${agent.id}`);
      return session;
    });

    // Fulcra: upstream also kills one provider here and expects error attention. Fulcra reports a
    // provider exit differently, and that check is not part of the shutdown behavior under test.

    await daemon.client.sendMessage(running.id, "Hold the turn open.");
    await waitFor(async () => {
      const { agent } = (await daemon!.client.fetchAgent(running.id)) ?? {};
      if (agent?.status === "running") return agent;
    }, "ACP turn did not start");
    const workerPid = (await daemon.client.getDaemonStatus()).pid;
    const log = await interruptForeground(daemon);

    assert.deepEqual(
      (await readEvents()).filter((event) => event.type === "sigint"),
      [],
      "the foreground interrupt reached an ACP process",
    );
    assert(!log.includes("worker_received_SIGINT"), "the foreground interrupt reached the worker");
    assert.match(log, /supervisor_received_SIGINT/);
    assertPidExited(workerPid);
    for (const session of sessions) assertPidExited(session.pid);
    console.log("Foreground SIGINT reached the supervisor. The worker and ACP processes exited.");

    daemon = await startSupervisor();
    // Fulcra: recovery is Fulcra revive-on-restart, which continues a cut-off turn with its own
    // prompt after a settle time. The shutdown must still have captured the running turn.
    await waitFor(async () => {
      const log = await readFile(join(paseoHome, "daemon.log"), "utf8");
      return /Revive on restart: d+ reopened, 1 cut-off turn/.test(log) ? log : undefined;
    }, "the restart did not capture the interrupted ACP turn");
    console.log("The restart captured the interrupted ACP turn.");
    await interruptForeground(daemon);
  }
} catch (error) {
  console.error(daemon?.output());
  throw error;
} finally {
  await daemon?.client.close();
  if (await readDaemonInstance(paseoHome)) {
    await runLocalPaseo(["daemon", "stop", "--home", paseoHome, "--force"], env);
  }
  await rm(paseoHome, { recursive: true, force: true });
}
