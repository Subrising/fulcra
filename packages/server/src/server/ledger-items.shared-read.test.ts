import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { LEDGER_SNAPSHOT_TTL_MS, readOpenLedgerRowsShared } from "./ledger-items.js";

// FU-423: session snapshots share one recent ledger read instead of reading every ledger per snapshot.
const ledger = (rows: string[]) =>
  [
    "| id | item | kind | owner | status | evidence | source |",
    "|---|---|---|---|---|---|---|",
    ...rows.map((id) => `| ${id} | item | FIX | lead | OPEN | — | test |`),
  ].join("\n") + "\n";

describe("readOpenLedgerRowsShared", () => {
  let dir: string | null = null;
  afterEach(async () => {
    if (dir) {
      await chmod(dir, 0o700).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
    dir = null;
  });

  test("reuses one read inside the window and reads fresh after it", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "ledger-shared-"));
    await mkdir(path.join(dir, "alpha"));
    await writeFile(path.join(dir, "alpha", "OPEN-ITEMS.md"), ledger(["AL-1"]));
    const t0 = 1_000_000;
    const first = await readOpenLedgerRowsShared(dir, true, t0);
    expect(first.map((r) => r.id)).toEqual(["AL-1"]);

    await writeFile(path.join(dir, "alpha", "OPEN-ITEMS.md"), ledger(["AL-1", "AL-2"]));
    const inside = await readOpenLedgerRowsShared(dir, true, t0 + LEDGER_SNAPSHOT_TTL_MS - 1);
    expect(inside.map((r) => r.id)).toEqual(["AL-1"]);
    const after = await readOpenLedgerRowsShared(dir, true, t0 + LEDGER_SNAPSHOT_TTL_MS);
    expect(after.map((r) => r.id)).toEqual(["AL-1", "AL-2"]);
  });

  test("strict and lenient reads are separate, and a clock that went back reads fresh", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "ledger-shared-"));
    await mkdir(path.join(dir, "beta"));
    await writeFile(path.join(dir, "beta", "OPEN-ITEMS.md"), ledger(["BE-1"]));
    const t0 = 2_000_000;
    await readOpenLedgerRowsShared(dir, true, t0);
    await writeFile(path.join(dir, "beta", "OPEN-ITEMS.md"), ledger(["BE-1", "BE-2"]));
    expect((await readOpenLedgerRowsShared(dir, false, t0)).map((r) => r.id)).toEqual([
      "BE-1",
      "BE-2",
    ]);
    expect((await readOpenLedgerRowsShared(dir, true, t0 - 1)).map((r) => r.id)).toEqual([
      "BE-1",
      "BE-2",
    ]);
  });

  test("a failed strict read is not shared: the next snapshot reads again", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "ledger-shared-"));
    await mkdir(path.join(dir, "gamma"));
    const file = path.join(dir, "gamma", "OPEN-ITEMS.md");
    await writeFile(file, "x".repeat(512 * 1024 + 1));
    const t0 = 3_000_000;
    await expect(readOpenLedgerRowsShared(dir, true, t0)).rejects.toThrow(/size limit/);
    await writeFile(file, ledger(["GA-1"]));
    expect((await readOpenLedgerRowsShared(dir, true, t0 + 1)).map((r) => r.id)).toEqual(["GA-1"]);
  });
});
