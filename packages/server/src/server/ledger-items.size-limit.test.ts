import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { readOpenLedgerRows } from "./ledger-items.js";

// FU-677: a ledger over 512 KiB blocked every archive. The cap is now 16 MiB.
const header = [
  "| id | item | kind | owner | status | evidence | source |",
  "|---|---|---|---|---|---|---|",
];
const doneRow = (n: number) => `| DN-${n} | item | FIX | lead | DONE | ${"x".repeat(80)} | t |`;

describe("readOpenLedgerRows size limit", () => {
  let dir: string | null = null;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  test("a 600 KiB ledger with one open row is read in strict mode", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "ledger-size-"));
    await mkdir(path.join(dir, "big"));
    const rows = Array.from({ length: 6000 }, (_, i) => doneRow(i));
    const text = [...header, ...rows, "| BG-1 | open | FIX | lead | OPEN | — | t |"].join("\n") + "\n";
    expect(Buffer.byteLength(text)).toBeGreaterThan(600 * 1024);
    await writeFile(path.join(dir, "big", "OPEN-ITEMS.md"), text);
    const got = await readOpenLedgerRows(dir, true);
    expect(got.map((r) => r.id)).toEqual(["BG-1"]);
  });

  test("a ledger over 16 MiB still gives size limit exceeded (strict) and is skipped (lenient)", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "ledger-size-"));
    await mkdir(path.join(dir, "huge"));
    const file = path.join(dir, "huge", "OPEN-ITEMS.md");
    await writeFile(file, header.join("\n") + "\n");
    await truncate(file, 16 * 1024 * 1024 + 1);
    await expect(readOpenLedgerRows(dir, true)).rejects.toThrow(
      'Cannot read ledger for project "huge": size limit exceeded',
    );
    expect(await readOpenLedgerRows(dir, false)).toEqual([]);
  });
});
