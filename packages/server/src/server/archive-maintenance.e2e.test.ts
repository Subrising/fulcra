import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";
import { DaemonClient } from "./test-utils/daemon-client.js";

// Real WebSocket requests, isolated daemon homes, and synthetic providers only.
test.each(["0.1.104", "0.2.22"])(
  "reload keeps archive state for client %s, including a loaded history runtime",
  async (appVersion) => {
    const root = mkdtempSync(path.join(tmpdir(), "archive-maintenance-"));
    const cwd = path.join(root, "workspace");
    mkdirSync(cwd);
    const daemon = await createTestPaseoDaemon({ pluginsEnabled: false });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion });
    try {
      await client.connect();
      const agent = await client.createAgent({ provider: "claude", cwd });
      const handle = (await client.fetchAgent({ agentId: agent.id }))!.agent.persistence!;
      const archive = await client.archiveAgent(agent.id);
      const before = await daemon.daemon.agentStorage.get(agent.id);
      for (const historyLoaded of [false, true]) {
        if (historyLoaded)
          await client.searchAgentTimeline({ agentId: agent.id, query: "archive fixture" });
        await expect(client.refreshAgent(agent.id)).rejects.toThrow(/archived/i);
        await expect(client.refreshAgent(agent.id, undefined, { confirmed: true })).rejects.toThrow(
          /archived/i,
        );
        const state = await client.getAgentMcpRefreshState(agent.id);
        expect(state).toBeTruthy();
        expect(
          await client.refreshAgentMcp({
            agentId: agent.id,
            expected: {
              provider: state!.provider,
              sessionId: state!.sessionId,
              configRevision: state!.configRevision,
            },
            changes: {},
            reconnect: true,
          }),
        ).toMatchObject({ outcome: "refused", reason: "not_resident" });
        if (historyLoaded) {
          expect(daemon.daemon.agentManager.getAgent(agent.id)).toBeTruthy();
          await expect(daemon.daemon.agentManager.reloadAgentSession(agent.id)).rejects.toThrow(
            /archived/i,
          );
        }
        const after = await daemon.daemon.agentStorage.get(agent.id);
        expect(after?.archivedAt).toBe(archive.archivedAt);
        expect(after?.updatedAt).toBe(before?.updatedAt);
        expect(after?.persistence).toEqual(before?.persistence);
        expect((await client.fetchAgents()).entries.map((e) => e.agent.id)).not.toContain(agent.id);
      }
      // Explicit owner restore remains a separate operation.
      await client.refreshAgent(agent.id, undefined, { restore: true });
      expect((await client.fetchAgent({ agentId: agent.id }))?.agent.archivedAt).toBeNull();
      await client.refreshAgent(agent.id);
      expect((await client.fetchAgent({ agentId: agent.id }))?.agent.persistence?.sessionId).toBe(
        handle.sessionId,
      );
    } finally {
      await client.close();
      await daemon.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("workspace recovery restores only the selected workspace and preserves archived sessions", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "workspace-recovery-archive-"));
  const daemon = await createTestPaseoDaemon({ pluginsEnabled: false });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.2.22",
  });
  try {
    await client.connect();
    const workspace = (await client.createWorkspace({ source: { kind: "directory", path: root } }))
      .workspace!;
    const agent = await client.createAgent({
      provider: "claude",
      cwd: root,
      workspaceId: workspace.id,
    });
    await client.archiveAgent(agent.id);
    const before = await daemon.daemon.agentStorage.get(agent.id);
    await client.archiveWorkspace(workspace.id);
    const archived = await daemon.daemon.agentStorage.get(agent.id);
    await client.restoreWorkspace(workspace.id);
    expect((await client.fetchWorkspaces()).entries.map((entry) => entry.id)).toContain(
      workspace.id,
    );
    const after = await daemon.daemon.agentStorage.get(agent.id);
    expect(after?.archivedAt).toBe(before?.archivedAt);
    expect(after?.updatedAt).toBe(archived?.updatedAt);
    expect((await client.fetchAgents()).entries.map((e) => e.agent.id)).not.toContain(agent.id);
  } finally {
    await client.close();
    await daemon.close();
    rmSync(root, { recursive: true, force: true });
  }
});
