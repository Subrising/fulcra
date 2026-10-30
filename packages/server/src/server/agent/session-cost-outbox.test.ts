import { mkdtemp, rm, mkdir, stat } from "node:fs/promises";
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
    await rm(file, { force: true });
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

const row = (turnId: string) => ({
  agentId: "one",
  provider: "claude",
  accountId: "account",
  turnId,
  costUsd: 1,
  at: "2026-10-30T00:00:00Z",
  cursors: {},
  revision: 1,
});

test("a read-only pending() call leaves the file unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "cost-outbox-read-"));
  try {
    const file = join(root, "pending.json");
    await new SessionCostOutbox(file).put(row("turn"));
    const before = await stat(file);
    const box = new SessionCostOutbox(file);
    expect(await box.pending()).toEqual([row("turn")]);
    expect(await box.pending()).toEqual([row("turn")]);
    expect(await box.has(row("turn"))).toBe(true);
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
    // An empty outbox stays a missing file.
    const empty = join(root, "empty.json");
    expect(await new SessionCostOutbox(empty).pending()).toEqual([]);
    await expect(stat(empty)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("putMany and removeMany write each batch once and keep rows outside the batch", async () => {
  const root = await mkdtemp(join(tmpdir(), "cost-outbox-batch-"));
  try {
    const file = join(root, "pending.json");
    const box = new SessionCostOutbox(file);
    const rows = Array.from({ length: 200 }, (_, index) => row(`turn-${index}`));
    await box.putMany(rows);
    expect(await new SessionCostOutbox(file).pending()).toHaveLength(200);
    await box.removeMany(rows.slice(0, 150));
    expect(await new SessionCostOutbox(file).pending()).toEqual(rows.slice(150));
    expect(await box.has(rows[0])).toBe(false);
    // A failed batch write keeps every row of the batch.
    await rm(file);
    await mkdir(file);
    await expect(box.removeMany(rows.slice(150))).rejects.toThrow();
    expect(await box.has(rows[150])).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
