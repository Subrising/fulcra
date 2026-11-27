import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { REPORTS_TO_LABEL } from "@getpaseo/protocol/agent-labels";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";

// FU-834: a worker whose first turn ends on the CLI's "monthly spend limit" line must reach its lead as a limit
// notice, never as a finished turn ("completed"). Scratch daemon with a fake provider; no real account is used.
const SPEND =
  "You've hit your monthly spend limit · raise it at claude.ai/settings/usage · your 5-hour limit resets 3pm (Australia/Brisbane)";

test("a first turn that ends on the monthly spend limit line is reported to the lead as a limit, not as finished", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "limit-spend-"));
  let daemon: TestPaseoDaemon | undefined;
  try {
    daemon = await createTestPaseoDaemon({
      paseoHomeRoot: root,
      cleanup: false,
      reportUpOnTurnEnd: true,
      agentClients: { claude: createTestAgentClient("claude") },
    });
    const manager = daemon.daemon.agentManager;
    const create = (title: string, labels: Record<string, string>) =>
      manager.createAgent({ provider: "claude", cwd: root, modeId: "default", title }, undefined, {
        labels,
      });
    const lead = await create("Spend lead", {});
    const worker = await create("Spend worker", { [REPORTS_TO_LABEL]: lead.id });

    const leadPrompts: string[] = [];
    const leadWoke = new Promise<void>((resolve) => {
      const off = manager.subscribe(
        (event) => {
          if (event.type === "agent_stream" && event.agentId === lead.id) {
            // The notice reaches the lead as a system-injected item whose call id starts with "paseo-system:".
            if (
              event.event.type === "timeline" &&
              event.event.item.type === "tool_call" &&
              event.event.item.callId.startsWith("paseo-system:")
            ) {
              leadPrompts.push(JSON.stringify(event.event.item));
              off();
              resolve();
            }
          }
        },
        { replayState: false },
      );
    });
    await manager.runAgent(worker.id, `respond with exactly: ${SPEND}`);
    await Promise.race([
      leadWoke,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error("lead got no notice")), 15_000),
      ),
    ]);
    expect(leadPrompts).toHaveLength(1);
    expect(leadPrompts[0]).toContain("monthly spend limit until");
    expect(leadPrompts[0]).not.toContain("finished a turn");
  } finally {
    await daemon?.close();
    if (daemon) await rm(daemon.staticDir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
