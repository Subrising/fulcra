import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";

// The process table read is replaced so a test can make it fail.
const table = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../../utils/tree-kill.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/tree-kill.js")>()),
  readOwnedProcessTable: table.read,
}));

import { createTestLogger } from "../../test-utils/test-logger.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { AgentManager } from "./agent-manager.js";

const logger = createTestLogger();

function newManager() {
  return new AgentManager({ clients: createTestAgentClients(), logger });
}

async function newAgent(
  manager: AgentManager,
  options: { internal?: boolean; work?: (read?: () => Promise<unknown[]>) => Promise<boolean> },
) {
  const cwd = mkdtempSync(join(tmpdir(), "revive-background-"));
  const agent = await manager.createAgent(
    { provider: "claude", cwd, internal: options.internal },
    undefined,
    { workspaceId: undefined },
  );
  const live = manager.getAgent(agent.id)!;
  if (options.work) {
    (live.session as unknown as { hasBackgroundWork: unknown }).hasBackgroundWork = options.work;
  }
  return live;
}

describe("restart record: background work of the loaded sessions (FU-362)", () => {
  beforeEach(() => {
    table.read.mockReset();
    table.read.mockResolvedValue([]);
  });

  test("only an idle, non-internal session with background work is listed", async () => {
    const manager = newManager();
    const tracked = await newAgent(manager, { work: async () => true });
    const plain = await newAgent(manager, { work: async () => false });
    const running = await newAgent(manager, { work: async () => true });
    // The manager keeps its own managed record; the test marks a turn as running on it.
    (manager as unknown as { agents: Map<string, { lifecycle: string }> }).agents.get(
      running.id,
    )!.lifecycle = "running";
    const internal = await newAgent(manager, { internal: true, work: async () => true });
    // A sleeping session has no process: its own check says no.
    const sleeping = await newAgent(manager, { work: async () => false });

    const listed = await manager.listAgentsForRevive();
    const flagged = (id: string) => listed.find((entry) => entry.id === id)?.hasBackgroundWork;
    expect(flagged(tracked.id)).toBe(true);
    expect(flagged(plain.id)).toBe(false);
    expect(flagged(running.id)).toBe(false);
    // The manager does not list internal helpers at all.
    expect(flagged(internal.id) ?? false).toBe(false);
    await expect(manager.hasLiveBackgroundWork(internal.id)).resolves.toBe(false);
    expect(flagged(sleeping.id)).toBe(false);
    await expect(manager.hasLiveBackgroundWork(tracked.id)).resolves.toBe(true);
    await expect(manager.hasLiveBackgroundWork("missing")).resolves.toBe(false);
  });

  test("one process table read serves all sessions", async () => {
    const manager = newManager();
    for (let index = 0; index < 3; index++)
      await newAgent(manager, {
        work: async (read) => {
          await read?.();
          return false;
        },
      });
    await manager.listAgentsForRevive();
    expect(table.read).toHaveBeenCalledTimes(1);
  });

  test("a failed table read keeps the previous tree signal and adds none", async () => {
    const manager = newManager();
    const treeWork = async (read?: () => Promise<unknown[]>) => {
      await read?.();
      return true;
    };
    const watching = await newAgent(manager, { work: treeWork });
    const tracked = await newAgent(manager, { work: async () => true });
    const quiet = await newAgent(manager, { work: async () => false });
    const listed = await manager.listAgentsForRevive();
    expect(listed.filter((entry) => entry.hasBackgroundWork).map((entry) => entry.id)).toEqual([
      watching.id,
      tracked.id,
    ]);

    // The read now fails: the watching session keeps its flag; the quiet one gets none from the tree.
    table.read.mockRejectedValue(new Error("spawn ps EAGAIN"));
    const late = await newAgent(manager, { work: treeWork });
    const after = await manager.listAgentsForRevive();
    const flagged = (id: string) => after.find((entry) => entry.id === id)?.hasBackgroundWork;
    expect(flagged(watching.id)).toBe(true);
    expect(flagged(tracked.id)).toBe(true);
    expect(flagged(quiet.id)).toBe(false);
    expect(flagged(late.id)).toBe(false);
  });
});
