import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import {
  readBilling,
  recordAccountCost,
} from "../../../../../control/orca-organization/server/account-billing.mjs";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { AgentManager, type AgentManagerOptions } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import type { SessionCostRecords } from "./session-cost.js";
import {
  pendingCostKey,
  SessionCostOutbox,
  type PendingSessionCost,
} from "./session-cost-outbox.js";

interface CostRecovery {
  recoverCostAccounting(agent: unknown): Promise<void>;
  flushTasks(options: { includeAgentRegistrations: boolean }): Promise<void>;
  agents: Map<
    string,
    {
      session: { usageCredential?: () => { accountId: string } };
      costRecords?: SessionCostRecords;
    }
  >;
  costOutbox: SessionCostOutbox;
  costRecoveryDrains: Map<string, Promise<void>>;
  costResultsInFlight: Map<string, number>;
  persistSnapshot(agent: unknown): Promise<void>;
}

function row(agentId: string, accountId: string, index: number): PendingSessionCost {
  return {
    agentId,
    provider: "claude",
    accountId,
    turnId: `turn-${index}`,
    costUsd: 1,
    at: "2026-10-30T00:00:00.000Z",
    cursors: { native: index },
    revision: index,
  };
}

/** A daemon home with the real account billing store behind agent.cost_commit. */
async function fixture(root?: string, account?: string) {
  const home = root ?? (await mkdtemp(path.join(tmpdir(), "cost-recovery-")));
  const accountId = account ?? randomUUID();
  const outboxFile = path.join(home, "pending-costs.json");
  const commits: string[] = [];
  let hold: ((entry: PendingSessionCost) => Promise<void>) | undefined;
  const storage = new AgentStorage(path.join(home, "agents"), createTestLogger());
  const manager = new AgentManager({
    clients: createTestAgentClients(),
    registry: storage,
    logger: createTestLogger(),
    costOutboxFile: outboxFile,
    pluginLifecycle: {
      emit: () => {},
      before: async (hook: string, request: PendingSessionCost) => {
        if (hook !== "agent.cost_commit") return request;
        await hold?.(request);
        commits.push(pendingCostKey(request));
        await recordAccountCost(home, {
          id: `turn:${request.agentId}:${request.turnId}`,
          accountId: request.accountId,
          sessionId: request.agentId,
          costUsd: request.costUsd,
          at: request.at,
        });
        return { ...request, costCommitted: true };
      },
    } as unknown as AgentManagerOptions["pluginLifecycle"],
  });
  const internal = manager as unknown as CostRecovery;
  return {
    home,
    accountId,
    outboxFile,
    commits,
    manager,
    storage,
    internal,
    hold(action: typeof hold) {
      hold = action;
    },
    async seed(entries: PendingSessionCost[]) {
      const state = Object.fromEntries(entries.map((entry) => [pendingCostKey(entry), entry]));
      await writeFile(outboxFile, JSON.stringify(state));
    },
    async session() {
      const agent = await manager.createAgent({ provider: "claude", cwd: home }, undefined, {
        workspaceId: undefined,
      });
      const live = internal.agents.get(agent.id)!;
      live.session.usageCredential = () => ({ accountId });
      return { id: agent.id, live };
    },
    async pending() {
      return Object.values(JSON.parse(await readFile(outboxFile, "utf8")) as object);
    },
    calls() {
      return Object.keys(readBilling(home).calls);
    },
    async close() {
      await internal.flushTasks({ includeAgentRegistrations: true });
      await Promise.all(manager.listAgents().map((agent) => manager.closeAgent(agent.id)));
      await manager.flush();
      await storage.flush();
    },
  };
}

test("a turn start recovers its own rows and leaves 200 rows of another session to the background", async () => {
  const f = await fixture();
  try {
    const main = await f.session();
    const gate = Promise.withResolvers<void>();
    f.hold((entry) => (entry.agentId === "creator" ? gate.promise : Promise.resolve()));
    const creator = Array.from({ length: 200 }, (_, index) => row("creator", f.accountId, index));
    await f.seed([...creator, row(main.id, f.accountId, 1)]);

    // The other session's rows are held open; the start must not wait for any of them.
    await f.internal.recoverCostAccounting(main.live);
    expect(f.calls()).toEqual([`turn:${main.id}:turn-1`]);
    expect(f.manager.getAgent(main.id)?.costRecords?.turns["turn-1"]).toMatchObject({
      amountUsd: 1,
    });

    gate.resolve();
    await f.internal.flushTasks({ includeAgentRegistrations: false });
    expect(f.calls()).toHaveLength(201);
    expect(await f.pending()).toEqual([]);
  } finally {
    await f.close();
    await rm(f.home, { recursive: true, force: true });
  }
});

test("two concurrent starts on one account share one drain and commit each row once", async () => {
  const f = await fixture();
  try {
    const one = await f.session();
    const two = await f.session();
    const gate = Promise.withResolvers<void>();
    f.hold(() => gate.promise);
    const entries = [
      ...Array.from({ length: 30 }, (_, index) => row("other", f.accountId, index)),
      row(one.id, f.accountId, 1),
      row(two.id, f.accountId, 1),
    ];
    await f.seed(entries);

    const starts = [
      f.internal.recoverCostAccounting(one.live),
      f.internal.recoverCostAccounting(two.live),
      f.internal.recoverCostAccounting(one.live),
    ];
    await vi.waitFor(() => expect(f.internal.costRecoveryDrains.size).toBe(1));
    gate.resolve();
    await Promise.all(starts);
    await f.internal.flushTasks({ includeAgentRegistrations: false });

    expect(f.commits.toSorted()).toEqual(entries.map(pendingCostKey).toSorted());
    expect(f.calls()).toHaveLength(entries.length);
    expect(await f.pending()).toEqual([]);
    expect(f.manager.getAgent(one.id)?.costRecords?.billingWarning).toBeUndefined();
  } finally {
    await f.close();
    await rm(f.home, { recursive: true, force: true });
  }
});

test("a crash after commits but before the outbox checkpoint replays without a second charge", async () => {
  const f = await fixture();
  try {
    const main = await f.session();
    const entries = Array.from({ length: 30 }, (_, index) => row(main.id, f.accountId, index + 1));
    await f.seed(entries);
    // The process stops at the batch checkpoint: costs are committed, the outbox still has them.
    const removal = vi
      .spyOn(f.internal.costOutbox, "removeMany")
      .mockRejectedValue(new Error("test crash at checkpoint"));
    await f.internal.recoverCostAccounting(main.live);
    expect(f.manager.getAgent(main.id)?.costRecords?.billingWarning).toContain(
      "Recovery will retry",
    );
    expect(f.calls()).toHaveLength(25);
    expect(await f.pending()).toHaveLength(30);
    removal.mockRestore();
    await f.close();

    // Restart on the same home. Another session's start drains the stored session's rows.
    const restarted = await fixture(f.home, f.accountId);
    const other = await restarted.session();
    await restarted.internal.recoverCostAccounting(other.live);
    await restarted.internal.flushTasks({ includeAgentRegistrations: false });
    expect(restarted.commits).toHaveLength(30);
    expect(f.calls().toSorted()).toEqual(
      entries.map((entry) => `turn:${main.id}:${entry.turnId}`).toSorted(),
    );
    expect(Object.keys((await restarted.storage.get(main.id))?.costRecords?.turns ?? {})).toEqual(
      entries.map((entry) => entry.turnId),
    );
    expect(await restarted.pending()).toEqual([]);
    await restarted.close();
  } finally {
    await rm(f.home, { recursive: true, force: true });
  }
});

test("a failed commit keeps that row and later rows, and removes earlier rows in one write", async () => {
  const f = await fixture();
  try {
    const main = await f.session();
    const entries = Array.from({ length: 5 }, (_, index) => row(main.id, f.accountId, index + 1));
    await f.seed(entries);
    f.hold(async (entry) => {
      if (entry.turnId === "turn-3") throw new Error("test billing failure");
    });
    const removal = vi.spyOn(f.internal.costOutbox, "removeMany");
    await f.internal.recoverCostAccounting(main.live);
    expect(removal).toHaveBeenCalledTimes(1);
    expect(removal.mock.calls[0][0].map((entry) => entry.turnId)).toEqual(["turn-1", "turn-2"]);
    expect(((await f.pending()) as PendingSessionCost[]).map((entry) => entry.turnId)).toEqual([
      "turn-3",
      "turn-4",
      "turn-5",
    ]);
    expect(f.manager.getAgent(main.id)?.costRecords?.billingWarning).toContain(
      "Recovery will retry",
    );
  } finally {
    await f.close();
    await rm(f.home, { recursive: true, force: true });
  }
});

test("a background run that already holds a session's row with a hung commit does not hold its turn start", async () => {
  const f = await fixture();
  try {
    const main = await f.session();
    const other = await f.session();
    const gate = Promise.withResolvers<void>();
    const hung = Promise.withResolvers<void>();
    f.hold(async (entry) => {
      if (entry.agentId !== "creator") return;
      hung.resolve();
      await gate.promise;
    });
    const creator = Array.from({ length: 24 }, (_, index) => row("creator", f.accountId, index));
    // The main row comes first, so the background run commits it and then hangs in the same batch.
    await f.seed([row(main.id, f.accountId, 1), ...creator]);
    await f.internal.recoverCostAccounting(other.live);
    await hung.promise;
    expect(f.commits).toEqual([pendingCostKey(row(main.id, f.accountId, 1))]);

    await f.internal.recoverCostAccounting(main.live);
    expect(f.calls()).toEqual([`turn:${main.id}:turn-1`]);
    expect(f.manager.getAgent(main.id)?.costRecords?.turns["turn-1"]).toBeDefined();
    expect(((await f.pending()) as PendingSessionCost[]).map((entry) => entry.agentId)).toEqual(
      creator.map(() => "creator"),
    );

    gate.resolve();
    await f.internal.flushTasks({ includeAgentRegistrations: false });
    expect(f.calls()).toHaveLength(25);
    expect(await f.pending()).toEqual([]);
  } finally {
    await f.close();
    await rm(f.home, { recursive: true, force: true });
  }
});

test("a row that always fails does not stop the rows of other sessions", async () => {
  const f = await fixture();
  try {
    const trigger = await f.session();
    f.hold(async (entry) => {
      if (entry.agentId === "broken") throw new Error("test billing failure");
    });
    const broken = [row("broken", f.accountId, 1), row("broken", f.accountId, 2)];
    const healthy = Array.from({ length: 30 }, (_, index) => row("healthy", f.accountId, index));
    await f.seed([...broken, ...healthy]);
    await f.internal.recoverCostAccounting(trigger.live);
    await f.internal.flushTasks({ includeAgentRegistrations: false });
    expect(f.calls()).toHaveLength(30);
    // The failed row stops only the later row of its own session.
    expect(f.commits.filter((key) => key.includes("broken"))).toEqual([]);
    expect(await f.pending()).toEqual(broken);
  } finally {
    await f.close();
    await rm(f.home, { recursive: true, force: true });
  }
});

test("the billing warning stays while a row or a cost result of that session is unrecovered", async () => {
  const f = await fixture();
  try {
    const warning = "Billing write failed. Cost is saved; Accounting recovery is pending.";
    const withRow = await f.session();
    const inFlight = await f.session();
    for (const session of [withRow, inFlight])
      session.live.costRecords = { cursors: {}, turns: {}, billingWarning: warning };
    await f.seed([
      row(withRow.id, f.accountId, 1),
      // A row on another account is not recovered by this start.
      row(withRow.id, randomUUID(), 2),
      row(inFlight.id, f.accountId, 1),
    ]);
    f.internal.costResultsInFlight.set(inFlight.id, 1);
    await f.internal.recoverCostAccounting(withRow.live);
    await f.internal.recoverCostAccounting(inFlight.live);
    expect(f.manager.getAgent(withRow.id)?.costRecords?.billingWarning).toBe(warning);
    expect(f.manager.getAgent(inFlight.id)?.costRecords?.billingWarning).toBe(warning);

    f.internal.costResultsInFlight.delete(inFlight.id);
    await f.seed([row(withRow.id, randomUUID(), 2), row(inFlight.id, f.accountId, 2)]);
    f.internal.costOutbox = new SessionCostOutbox(f.outboxFile);
    await f.internal.recoverCostAccounting(inFlight.live);
    expect(f.manager.getAgent(inFlight.id)?.costRecords?.billingWarning).toBeUndefined();
  } finally {
    await f.close();
    await rm(f.home, { recursive: true, force: true });
  }
});

test("a crash after the commit but before the snapshot write replays without a second charge", async () => {
  const f = await fixture();
  try {
    const main = await f.session();
    const entries = Array.from({ length: 3 }, (_, index) => row(main.id, f.accountId, index + 1));
    await f.seed(entries);
    const snapshot = vi
      .spyOn(f.internal, "persistSnapshot")
      .mockRejectedValue(new Error("test crash before snapshot"));
    await f.internal.recoverCostAccounting(main.live);
    snapshot.mockRestore();
    expect(f.calls()).toHaveLength(3);
    expect(await f.pending()).toHaveLength(3);
    await f.close();

    const restarted = await fixture(f.home, f.accountId);
    const other = await restarted.session();
    await restarted.internal.recoverCostAccounting(other.live);
    await restarted.internal.flushTasks({ includeAgentRegistrations: false });
    expect(restarted.commits).toHaveLength(3);
    expect(f.calls().toSorted()).toEqual(
      entries.map((entry) => `turn:${main.id}:${entry.turnId}`).toSorted(),
    );
    expect(Object.keys((await restarted.storage.get(main.id))?.costRecords?.turns ?? {})).toEqual(
      entries.map((entry) => entry.turnId),
    );
    expect(await restarted.pending()).toEqual([]);
    await restarted.close();
  } finally {
    await rm(f.home, { recursive: true, force: true });
  }
});
