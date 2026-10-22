import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { REVIVE_FILE } from "../revive-on-restart.js";

test("FU-460: a stop during revive keeps the reopened sessions and the pending background wake in the stop record", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "revive-keeps-open-"));
  const prompts: unknown[] = [];
  let daemon: TestPaseoDaemon | undefined;
  const boot = () =>
    createTestPaseoDaemon({
      paseoHomeRoot: root,
      cleanup: false,
      agentClients: {
        codex: createTestAgentClient("codex", { onStartTurn: (prompt) => prompts.push(prompt) }),
      },
    });
  try {
    daemon = await boot();
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const agent = await daemon.daemon.agentManager.createAgent(
        { provider: "codex", cwd: root, modeId: "full-access", model: "gpt-6.1-sol" },
        undefined,
        {},
      );
      ids.push(agent.id);
    }
    await daemon.close();
    // The stop above listed the sessions as open. Mark one as waiting for background work, as a stop would.
    const recordFile = path.join(daemon.paseoHome, REVIVE_FILE);
    const first = JSON.parse(await readFile(recordFile, "utf8"));
    await writeFile(
      recordFile,
      JSON.stringify({ ...first, stoppedAt: new Date().toISOString(), backgroundIds: [ids[0]] }),
    );

    // Boot: the sessions reopen idle and unloaded; the wake waits out the settle time. Stop before it is sent.
    daemon = await boot();
    await vi.waitFor(async () => {
      const stored = await Promise.all(ids.map((id) => daemon!.daemon.agentStorage.get(id)));
      expect(stored.map((record) => record?.lastStatus)).toEqual(["idle", "idle", "idle"]);
    });
    for (const id of ids) expect(daemon.daemon.agentManager.getAgent(id)).toBeNull();
    await daemon.close();

    const record = JSON.parse(await readFile(recordFile, "utf8"));
    expect([...record.openIds].sort()).toEqual([...ids].sort());
    expect(record.backgroundIds).toEqual([ids[0]]);
    expect(prompts).toEqual([]);
  } finally {
    await daemon?.close();
    if (daemon) await rm(daemon.staticDir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
