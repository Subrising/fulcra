import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitChildLimitError } from "@getpaseo/plugin/server/git";
import { getCheckoutStatus } from "./checkout-git.js";

describe("git child limit in checkout discovery", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("does not report the folder as non-Git and logs no warning", async () => {
    const dir = mkdtempSync(join(tmpdir(), "checkout-limit-"));
    dirs.push(dir);
    const records: unknown[] = [];
    const logger = pino(
      { level: "warn" },
      { write: (line: string) => records.push(JSON.parse(line)) },
    );
    const runGitCommand = vi.fn().mockRejectedValue(new GitChildLimitError());
    await expect(getCheckoutStatus(dir, { logger, runGitCommand })).rejects.toThrow("child limit");
    expect(records).toEqual([]);
  });
});
