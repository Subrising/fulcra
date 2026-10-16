import { mkdtemp, mkdir, writeFile, rename, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { LedgerDirectoryWatch } from "./watch.js";

test("directory observation survives repeated atomic claim and close replacements", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ledger-directory-watch-"));
  await mkdir(path.join(root, "sample"));
  const file = path.join(root, "sample", "OPEN-ITEMS.md");
  await writeFile(file, "READY");
  const waits = new Map<string, () => void>();
  const failures: unknown[] = [];
  const watcher = new LedgerDirectoryWatch(
    root,
    () => {
      void readFile(file, "utf8")
        .then((text) => waits.get(text)?.())
        .catch((error: unknown) => failures.push(error));
    },
    (error) => failures.push(error),
  );
  const observed = (text: string) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Missing atomic ledger event: ${text}`)),
        5000,
      );
      waits.set(text, () => {
        clearTimeout(timer);
        resolve();
      });
    });
  try {
    await watcher.ready;
    expect(watcher.covers("sample")).toBe(true);
    for (const text of ["CLAIMED", "DONE", "READY next", "CLAIMED next", "DONE next"]) {
      const event = observed(text);
      const temp = path.join(root, "sample", `temporary-${text.replaceAll(" ", "-")}`);
      await writeFile(temp, text);
      await rename(temp, file);
      await event;
    }
    expect(failures).toEqual([]);
  } finally {
    watcher.close();
    await rm(root, { recursive: true, force: true });
  }
});
