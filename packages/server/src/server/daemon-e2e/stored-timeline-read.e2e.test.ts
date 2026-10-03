import { mkdtemp, mkdir, rm, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { resolveDaemonVersion } from "../daemon-version.js";
import { DaemonClient } from "../test-utils/daemon-client.js";

test.each([false, true])(
  "unloaded archived=%s journal reads preserve pages without restoring providers",
  async (archived) => {
    const root = await mkdtemp(path.join(tmpdir(), "stored-timeline-"));
    let daemon: TestPaseoDaemon | undefined;
    let client: DaemonClient | undefined;
    try {
      const provider = createTestAgentClient("codex");
      daemon = await createTestPaseoDaemon({
        paseoHomeRoot: root,
        cleanup: false,
        agentClients: { codex: provider },
      });
      const manager = daemon.daemon.agentManager;
      const agent = await manager.createAgent(
        {
          provider: "codex",
          cwd: root,
          modeId: "full-access",
          model: "gpt-6.1-sol",
          thinkingOptionId: "high",
        },
        undefined,
        {},
      );
      await manager.runAgent(agent.id, "Respond with exactly: stored reply");
      for (let i = 0; i < 8; i++) {
        await manager.appendTimelineItem(agent.id, { type: "user_message", text: `question ${i}` });
        await manager.appendTimelineItem(agent.id, {
          type: "assistant_message",
          text: `extra ${i}`,
        });
      }
      if (archived) await manager.archiveAgent(agent.id);
      client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
      await client.connect();
      const before = await client.fetchAgentTimeline(agent.id, { direction: "tail", limit: 3 });
      const full = await client.fetchAgentTimeline(agent.id, { direction: "tail", limit: 0 });
      const turnId = full.entries.find((entry) => entry.turnId)?.turnId;
      expect(turnId).toBeTruthy();
      const turn = await client.fetchAgentTimeline(agent.id, { turnId, limit: 0 });
      await client.close();
      await daemon.close();
      const nextProvider = createTestAgentClient("codex");
      const resume = vi.spyOn(nextProvider, "resumeSession");
      const create = vi.spyOn(nextProvider, "createSession");
      daemon = await createTestPaseoDaemon({
        paseoHomeRoot: root,
        cleanup: false,
        agentClients: { codex: nextProvider },
      });
      const nextManager = daemon.daemon.agentManager;
      expect(nextManager.getAgent(agent.id)).toBeNull();
      client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
      await client.connect();
      const after = await client.fetchAgentTimeline(agent.id, { direction: "tail", limit: 3 });
      expect(after.entries).toEqual(before.entries);
      expect(after.epoch).toBe(before.epoch);
      expect(after.startCursor).toEqual(before.startCursor);
      const older = await client.fetchAgentTimeline(agent.id, {
        direction: "before",
        cursor: after.startCursor!,
        limit: 3,
      });
      expect(older.entries.length).toBeGreaterThan(0);
      expect(older.endCursor!.seq).toBeLessThan(after.startCursor!.seq);
      expect((await client.fetchAgentTimeline(agent.id, { turnId, limit: 0 })).entries).toEqual(
        turn.entries,
      );
      // The actual plugin RPC bridge uses the same journal-only path.
      const pluginDir = path.join(root, "history-reader");
      await mkdir(pluginDir);
      await writeFile(
        path.join(pluginDir, "paseo-plugin.json"),
        JSON.stringify({
          id: "history-reader",
          requirements: { paseo: `>=${resolveDaemonVersion(import.meta.url)}` },
        }),
      );
      await writeFile(
        path.join(pluginDir, "index.server.ts"),
        `
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
const read = defineRpc({ name: "read", input: z.object({ id: z.string() }), output: z.object({ texts: z.array(z.string()) }) });
export default function contribute(server) {
  server.handle(read, async ({ id }, { paseo }) => {
    const page = await paseo.agents.ref(id).timeline.refetch({ direction: "tail", limit: 3 });
    return { texts: page.entries.map((entry) => entry.item.text).filter((text) => typeof text === "string") };
  });
  return () => {};
}`,
      );
      await client.patchDaemonConfig({ pluginsEnabled: true });
      await client.installDirectoryPlugin(pluginDir);
      expect(await client.invokePluginRpc("history-reader", "read", { id: agent.id })).toEqual({
        texts: after.entries
          .map((entry) => ("text" in entry.item ? entry.item.text : undefined))
          .filter((text) => typeof text === "string"),
      });
      expect(nextManager.getAgent(agent.id)).toBeNull();
      expect(resume).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      const stored = await daemon.daemon.agentStorage.get(agent.id);
      expect(after.agent?.createdAt).toBe(stored?.createdAt);
      expect(after.agent?.updatedAt).toBe(stored?.updatedAt);
    } finally {
      await client?.close();
      await daemon?.close();
      if (daemon) await rm(daemon.staticDir, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);

test.each(["legacy", "corrupt"])(
  "stored history %s preserves fallback and error fidelity",
  async (mode) => {
    const root = await mkdtemp(path.join(tmpdir(), "stored-fallback-"));
    let daemon: TestPaseoDaemon | undefined;
    let client: DaemonClient | undefined;
    try {
      daemon = await createTestPaseoDaemon({
        paseoHomeRoot: root,
        cleanup: false,
        agentClients: { codex: createTestAgentClient("codex") },
      });
      const manager = daemon.daemon.agentManager;
      const agent = await manager.createAgent(
        {
          provider: "codex",
          cwd: root,
          modeId: "full-access",
          model: "gpt-6.1-sol",
          thinkingOptionId: "high",
        },
        undefined,
        {},
      );
      await manager.runAgent(agent.id, "Respond with exactly: legacy reply");
      await daemon.close();
      const directory = path.join(daemon.paseoHome, "native-timeline-journal");
      if (mode === "legacy") await rm(directory, { recursive: true, force: true });
      else {
        const segment = (await readdir(directory)).find((name) => name.endsWith(".jsonl"))!;
        await writeFile(path.join(directory, segment), "corrupt journal\n");
      }
      const provider = createTestAgentClient("codex");
      const resume = vi.spyOn(provider, "resumeSession");
      daemon = await createTestPaseoDaemon({
        paseoHomeRoot: root,
        cleanup: false,
        agentClients: { codex: provider },
      });
      client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
      await client.connect();
      if (mode === "legacy") {
        const page = await client.fetchAgentTimeline(agent.id, { limit: 0 });
        expect(
          page.entries.some(
            (entry) =>
              entry.item.type === "assistant_message" && entry.item.text === "legacy reply",
          ),
        ).toBe(true);
        expect(resume).toHaveBeenCalledTimes(1);
      } else {
        await expect(client.fetchAgentTimeline(agent.id, { limit: 0 })).rejects.toThrow();
        expect(resume).not.toHaveBeenCalled();
        expect(daemon.daemon.agentManager.getAgent(agent.id)).toBeNull();
      }
    } finally {
      await client?.close();
      await daemon?.close();
      if (daemon) await rm(daemon.staticDir, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
