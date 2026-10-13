import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { leadEventsFor, leadEventsPath, readLeadEvents, withLeadEvent } from "../lead-events.js";

test("real daemon counts accepted WebSocket and daemon turns; local CLI reads the durable digest", async () => {
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await client.connect();
    const agent = await client.createAgent({
      provider: "claude",
      cwd: daemon.paseoHome,
      modeId: "bypassPermissions",
    });
    await client.sendMessage(agent.id, "Synthetic event counter check");
    await client.waitForFinish(agent.id, 10_000);
    const manager = daemon.daemon.agentManager;
    await withLeadEvent("permission", () =>
      manager.trustedPlugins.daemon(() =>
        manager.runAgent(agent.id, "Synthetic permission notice"),
      ),
    );
    const counts = readLeadEvents(daemon.paseoHome).sessions[agent.id]?.turns;
    expect(counts?.user).toBe(1);
    expect(counts?.permission).toBe(1);
    expect(Object.values(counts ?? {}).reduce((a, b) => a + b, 0)).toBe(2);
    expect(readFileSync(leadEventsPath(daemon.paseoHome), "utf8")).not.toContain("Synthetic");
    expect(
      leadEventsFor(manager)?.suppress(agent.id, {
        eventId: "archive-1",
        sourceId: "worker-1",
        kind: "archive_done",
      }),
    ).toBe(true);
    const result = spawnSync(
      process.execPath,
      [
        "--conditions=source",
        "--import",
        "tsx",
        "packages/cli/src/index.ts",
        "usage",
        "events",
        "--home",
        daemon.paseoHome,
        "--agent",
        agent.id,
        "--json",
      ],
      { cwd: process.cwd(), encoding: "utf8", timeout: 15_000 },
    );
    expect(result.status, result.stderr).toBe(0);
    const rows = JSON.parse(result.stdout);
    expect(rows).toHaveLength(1);
    expect(rows[0].turns).toEqual(counts);
    expect(rows[0].digest[0].reason).toBe("archive_done");
    // A read does not consume the digest or create another model turn.
    expect(readLeadEvents(daemon.paseoHome).sessions[agent.id]?.turns).toEqual(counts);
  } finally {
    await client.close();
    await daemon.close();
  }
}, 30_000);
