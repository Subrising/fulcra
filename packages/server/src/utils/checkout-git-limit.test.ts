import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

// FU-471: every status cycle ran `git rev-parse` again in each plain folder, about every 5 minutes per folder.
describe("non-Git folder discovery", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  function plainFolder(): string {
    const dir = mkdtempSync(join(tmpdir(), "checkout-plain-"));
    dirs.push(dir);
    return dir;
  }
  function probes(run: ReturnType<typeof vi.fn>): number {
    return run.mock.calls.filter(([args]) => (args as string[]).includes("--show-toplevel")).length;
  }

  it("probes a non-Git folder once until the folder changes", async () => {
    const dir = plainFolder();
    const runGitCommand = vi
      .fn()
      .mockRejectedValue(
        new Error("fatal: not a git repository (or any of the parent directories)"),
      );
    expect(await getCheckoutStatus(dir, { runGitCommand })).toEqual({ isGit: false });
    expect(await getCheckoutStatus(dir, { runGitCommand })).toEqual({ isGit: false });
    expect(probes(runGitCommand)).toBe(1);
    writeFileSync(join(dir, "notes.md"), "changed");
    await getCheckoutStatus(dir, { runGitCommand });
    expect(probes(runGitCommand)).toBe(2);
    mkdirSync(join(dir, ".git"));
    await getCheckoutStatus(dir, { runGitCommand });
    expect(probes(runGitCommand)).toBe(3);
  });

  it("retries another discovery failure each time and logs it once", async () => {
    const dir = plainFolder();
    const records: unknown[] = [];
    const logger = pino(
      { level: "warn" },
      { write: (line: string) => records.push(JSON.parse(line)) },
    );
    const runGitCommand = vi.fn().mockRejectedValue(new Error("git crashed"));
    for (let index = 0; index < 3; index++)
      expect(await getCheckoutStatus(dir, { logger, runGitCommand })).toEqual({ isGit: false });
    expect(probes(runGitCommand)).toBe(3);
    expect(records).toHaveLength(1);
  });
});
