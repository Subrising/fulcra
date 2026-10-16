import { execFileSync } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile, chmod, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import pino from "pino";
import { WorkspaceGitServiceImpl } from "../server/workspace-git-service.js";
import { runGitCommand } from "./run-git-command.js";

let root: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});

test.each([undefined, "", "/missing-app-bin"])(
  "runs workspace Git after a GUI relaunch with PATH=%s",
  async (path) => {
    root = await mkdtemp(join(tmpdir(), "git-gui-path-"));
    execFileSync("git", ["init", "--initial-branch=main", root]);
    vi.stubEnv("PATH", path);
    const result = await runGitCommand(["rev-parse", "--show-toplevel"], { cwd: root });
    expect(result.stdout.trim()).toBe(await realpath(root));
    expect(result.exitCode).toBe(0);
    await expect(runGitCommand(["status"], { cwd: join(root, "missing") })).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

test("keeps a configured Git executable ahead of fallback directories", async () => {
  root = await mkdtemp(join(tmpdir(), "git-path-priority-"));
  const bin = join(root, "bin");
  await mkdir(bin);
  const git = join(bin, "git");
  await writeFile(git, "#!/bin/sh\nprintf 'selected-git\\n'\n");
  await chmod(git, 0o700);
  const envOverlay = { PATH: bin };
  const result = await runGitCommand(["--version"], { cwd: root, envOverlay });
  expect(result.stdout).toBe("selected-git\n");
  expect(envOverlay).toEqual({ PATH: bin });
});

test("loads workspace Git status with an app-only PATH", async () => {
  root = await mkdtemp(join(tmpdir(), "workspace-git-gui-"));
  execFileSync("git", ["init", "--initial-branch=main", root]);
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "Initial test commit",
    ],
    { cwd: root },
  );
  vi.stubEnv("PATH", "/missing-app-bin");
  const service = new WorkspaceGitServiceImpl({
    paseoHome: root,
    logger: pino({ level: "silent" }),
  });
  try {
    const checkout = await service.getCheckout(root);
    expect(checkout).toMatchObject({ isGit: true, currentBranch: "main" });
  } finally {
    await service.dispose();
  }
});
