import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { SessionCostOutbox } from "./session-cost-outbox.js";

test("pending cost survives restart and acknowledgement removes only its own row", async () => {
  const root = await mkdtemp(join(tmpdir(), "cost-outbox-"));
  try {
    const file = join(root, "pending.json");
    const entry = {
      agentId: "one",
      provider: "claude",
      accountId: "account",
      turnId: "run:turn",
      costUsd: 4,
      at: "2026-10-17T00:00:00Z",
      cursors: { native: 4 },
      revision: 1,
    };
    const box = new SessionCostOutbox(file);
    await box.put(entry);
    await box.put(entry);
    const restored = new SessionCostOutbox(file);
    expect(await restored.pending()).toEqual([entry]);
    const next = { ...entry, turnId: "run:next", revision: 2 };
    await restored.put(next);
    await restored.remove(entry);
    expect(await new SessionCostOutbox(file).pending()).toEqual([next]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed outbox write remains recoverable in memory and admission tests storage again", async () => {
  const root = await mkdtemp(join(tmpdir(), "cost-outbox-fail-"));
  try {
    const file = join(root, "pending.json");
    await mkdir(file);
    const box = new SessionCostOutbox(file);
    // First load must succeed before simulating a later storage fault.
    await rm(file, { recursive: true });
    await box.pending();
    await rm(file);
    await mkdir(file);
    const entry = {
      agentId: "one",
      provider: "claude",
      accountId: "account",
      turnId: "turn",
      costUsd: 4,
      at: "2026-10-17T00:00:00Z",
      cursors: {},
      revision: 1,
    };
    await expect(box.put(entry)).rejects.toThrow();
    await expect(box.pending()).rejects.toThrow();
    await rm(file, { recursive: true });
    expect(await box.pending()).toEqual([entry]);
    expect(await new SessionCostOutbox(file).pending()).toEqual([entry]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
