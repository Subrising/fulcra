import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { spawnGitProcess } from "@getpaseo/plugin/server/git";
import { runGitCommand } from "./run-git-command.js";

const GIT_CHILD_LIMIT = 8;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("a command waits in line when every git child slot is busy, then runs", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "run-git-limit-"));
  dirs.push(cwd);
  const holders = Array.from({ length: GIT_CHILD_LIMIT }, () =>
    spawnGitProcess(["hash-object", "--stdin"], { cwd, stdio: "pipe", timeout: 10_000 }),
  );
  let settled = false;
  const pending = runGitCommand(["--version"], { cwd }).finally(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(settled).toBe(false);
  await Promise.all(
    holders.map(
      (child) =>
        new Promise<void>((resolve) => {
          child.once("close", () => resolve());
          child.stdin!.end();
        }),
    ),
  );
  const result = await pending;
  expect(result.stdout).toContain("git version");
});
