import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { assertCodexRolloutSize, CODEX_ROLLOUT_RESUME_LIMIT } from "./rollout-size.js";

test("assertCodexRolloutSize accepts small histories and refuses oversized active and archived histories without changing them", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "rollout-size-"));
  try {
    await expect(assertCodexRolloutSize(home, "missing")).resolves.toBeUndefined();
    for (const directory of ["sessions/2026/10/24", "archived_sessions"]) {
      const root = path.join(home, directory);
      await fs.mkdir(root, { recursive: true });
      const file = path.join(root, "rollout-2026-10-24-test-id.jsonl");
      await fs.writeFile(file, "{}");
      await fs.truncate(file, CODEX_ROLLOUT_RESUME_LIMIT);
      await expect(assertCodexRolloutSize(home, "test-id")).resolves.toBeUndefined();
      await fs.truncate(file, 2_480_000_000);
      await expect(assertCodexRolloutSize(home, "test-id")).rejects.toThrow("start a new session");
      await expect(assertCodexRolloutSize(home, "another-id")).resolves.toBeUndefined();
      expect((await fs.stat(file)).size).toBe(2_480_000_000);
      await fs.unlink(file);
    }
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
