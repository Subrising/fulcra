import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { MAIN_ASSISTANT_REF, REPORTS_TO_LABEL, SEAT_LABEL } from "@getpaseo/protocol/agent-labels";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";

// FULCRA(orchestration): a lead's parent is the main assistant role, not a chat id. Moving the role to another chat
// changes no lead: the lead's next send to the role reaches the new holder.

test("a lead's send to the main assistant role reaches the chat that holds the role now", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "reporting-role-"));
  let daemon: TestPaseoDaemon | undefined;
  let client: DaemonClient | undefined;
  try {
    daemon = await createTestPaseoDaemon({
      paseoHomeRoot: root,
      cleanup: false,
      agentClients: { codex: createTestAgentClient("codex") },
    });
    const manager = daemon.daemon.agentManager;
    const create = (title: string, labels: Record<string, string>) =>
      manager.createAgent(
        { provider: "codex", cwd: root, modeId: "full-access", title },
        undefined,
        { labels },
      );
    // A create never carries the seat label (a fork or `paseo run --label` cannot claim the role).
    const oldMain = await create("Old main assistant", { [SEAT_LABEL]: "main-assistant" });
    expect(manager.getAgent(oldMain.id)?.labels[SEAT_LABEL]).toBeUndefined();
    // The controller sets it from the seat bindings (here: the daemon's own label write).
    await manager.setLabels(oldMain.id, { [SEAT_LABEL]: "main-assistant" });
    const newMain = await create("Main assistant", {});
    const lead = await create("Mac operations lead", { [REPORTS_TO_LABEL]: MAIN_ASSISTANT_REF });

    const turns: string[] = [];
    manager.subscribe(
      (event) => {
        if (event.type === "agent_stream" && event.event.type === "turn_started")
          turns.push(event.agentId);
      },
      { replayState: false },
    );
    const nextTurn = (id: string) =>
      new Promise<void>((resolve) => {
        const off = manager.subscribe(
          (event) => {
            if (
              event.type === "agent_stream" &&
              event.agentId === id &&
              event.event.type === "turn_started"
            ) {
              off();
              resolve();
            }
          },
          { replayState: false },
        );
      });

    client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    await client.connect();
    // A chat (or the app) cannot claim the role by writing the label: only the controller session writes it.
    await expect(
      client.updateAgent(lead.id, { labels: { [SEAT_LABEL]: "main-assistant" } }),
    ).rejects.toThrow("fulcra.seat follows the main assistant seat");
    expect(manager.getAgent(lead.id)?.labels[SEAT_LABEL]).toBeUndefined();
    const fromLead = { sender: { agentId: lead.id } };

    let reached = nextTurn(oldMain.id);
    await client.sendAgentMessage(MAIN_ASSISTANT_REF, "report one", fromLead);
    await reached;
    await manager.waitForAgentEvent(oldMain.id);

    // Move the role. The lead's labels do not change.
    await manager.setLabels(oldMain.id, { [SEAT_LABEL]: "" });
    await manager.setLabels(newMain.id, { [SEAT_LABEL]: "main-assistant" });
    expect(manager.getAgent(lead.id)?.labels[REPORTS_TO_LABEL]).toBe(MAIN_ASSISTANT_REF);

    reached = nextTurn(newMain.id);
    await client.sendAgentMessage(MAIN_ASSISTANT_REF, "report two", fromLead);
    await reached;
    expect(turns).toEqual([oldMain.id, newMain.id]);

    // The old holder is now outside the lead's line.
    await expect(client.sendAgentMessage(oldMain.id, "report three", fromLead)).rejects.toThrow(
      "Send this to the main assistant, Main assistant",
    );
  } finally {
    await client?.close();
    await daemon?.close();
    if (daemon) await rm(daemon.staticDir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
