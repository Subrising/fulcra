import { AgentStorage } from "../agent/agent-storage.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";
import type { PersistenceHandle } from "@getpaseo/protocol/messages";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-restart-resume-"));
}

describe("daemon restart resume", () => {
  let ctx: DaemonTestContext;

  beforeEach(async () => {
    ctx = await createDaemonTestContext();
  });

  afterEach(async () => {
    await ctx.cleanup();
  }, 60_000);

  test("Codex agent survives daemon restart with persistence handle", async () => {
    const cwd = tmpCwd();
    const marker = `DAEMON_RESTART_MARKER_${Date.now()}`;
    try {
      const agent = await ctx.client.createAgent({
        provider: "codex",
        cwd,
        title: "Daemon Restart Test Agent",
        modeId: "full-access",
      });

      await ctx.client.sendMessage(
        agent.id,
        `Remember this marker string for a test: "${marker}".`,
      );

      const afterRemember = await ctx.client.waitForFinish(agent.id, 5_000);
      expect(afterRemember.status).toBe("idle");
      expect(afterRemember.final?.persistence).toBeTruthy();
      expect(afterRemember.final!.persistence!.metadata).toMatchObject({ marker });

      const handle = afterRemember.final!.persistence as PersistenceHandle;

      await ctx.cleanup();
      ctx = await createDaemonTestContext();

      const resumed = await ctx.client.resumeAgent(handle);
      await ctx.client.sendMessage(
        resumed.id,
        "What was the marker string I asked you to remember earlier?",
      );

      const afterRecall = await ctx.client.waitForFinish(resumed.id, 5_000);
      expect(afterRecall.status).toBe("idle");
      expect(afterRecall.final?.persistence).toBeTruthy();
      expect(afterRecall.final!.persistence!.metadata).toMatchObject({ marker });

      await ctx.client.deleteAgent(resumed.id);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30_000);
});

// These run in separate OS processes so SIGKILL cannot invoke daemon shutdown hooks.
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { DaemonClient } from "../test-utils/daemon-client.js";

async function restartFixture(
  root: string,
  settings: { resumeOnStartup?: boolean; resumePrompt?: string; reviveOnRestart?: boolean } = {},
  fixture: { holdResume?: boolean } = {},
) {
  const child = fork(
    fileURLToPath(new URL("../test-utils/finish-subscription-daemon.ts", import.meta.url)),
    [root, JSON.stringify(settings), JSON.stringify(fixture)],
    {
      execArgv: ["--conditions=source", "--import", "tsx"],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let output = "";
  child.stdout?.on("data", (data) => {
    output += data;
  });
  child.stderr?.on("data", (data) => {
    output += data;
  });
  const ready = await Promise.race([
    once(child, "message").then(
      ([message]) => message as { port: number; paseoHome: string; cwd: string },
    ),
    once(child, "exit").then(([code]) => {
      throw new Error(`Fixture exited ${code}: ${output}`);
    }),
  ]);
  return { child, ...ready };
}
async function stopFixture(child: ChildProcess, abrupt: boolean) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  if (abrupt) child.kill("SIGKILL");
  else child.send("stop");
  await exited;
}

// FU-657 row 9: the upstream durable finish subscription tests were removed. Fulcra keeps its own
// finish notice path. Row 4: the upstream host restart recovery settings tests were removed.
// The upstream pass runs only with agents.resumeOnStartup and daemon.reviveOnRestart off (FU-657 row 4).
test("a provider that is slow to reopen does not hold daemon startup", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "resume-background-process-"));
  const processes: ChildProcess[] = [];
  let client: DaemonClient | undefined;
  try {
    const first = await restartFixture(root, { resumeOnStartup: true, reviveOnRestart: false });
    processes.push(first.child);
    client = new DaemonClient({ url: `ws://127.0.0.1:${first.port}/ws`, appVersion: "0.13.0" });
    await client.connect();
    const working = await client.createAgent({
      provider: "claude",
      cwd: first.cwd,
      modeId: "full-access",
    });
    await client.sendMessage(working.id, "HOLD_CHILD");
    await expect
      .poll(
        async () =>
          (
            await new AgentStorage(path.join(first.paseoHome, "agents"), createTestLogger()).get(
              working.id,
            )
          )?.lastStatus,
      )
      .toBe("running");
    await client.close();
    client = undefined;
    await stopFixture(first.child, false);

    const second = await restartFixture(
      root,
      { resumeOnStartup: true, reviveOnRestart: false },
      { holdResume: true },
    );
    processes.push(second.child);
    client = new DaemonClient({ url: `ws://127.0.0.1:${second.port}/ws`, appVersion: "0.13.0" });
    await client.connect();
    expect((await client.fetchAgent(working.id))?.agent.id).toBe(working.id);
    second.child.send("release-resume");
    await expect
      .poll(async () =>
        (await readFile(path.join(root, "all-prompts.jsonl"), "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line).prompt)
          .filter((prompt) => prompt === "Resume working."),
      )
      .toHaveLength(1);
  } finally {
    await client?.close();
    for (const child of processes.toReversed()) await stopFixture(child, true);
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
