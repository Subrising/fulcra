import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { packagedWorkerSpawnArgs } from "./packaged-worker-spawn.js";

// FU-413: a packaged release worker starts through the entry point runner, not through fork(). It opened a Node
// inspector on SIGUSR1 because that path did not pass the FU-79 flags.
describe("packaged worker spawn arguments (FU-79, FU-413)", () => {
  it("puts the inspector flags before the runner script", () => {
    const args = packagedWorkerSpawnArgs("/app/runner.js", "/app/daemon-worker.js", ["--x"]);
    expect(args).toEqual([
      "--disable-sigusr1",
      "/app/runner.js",
      "node-script",
      "/app/daemon-worker.js",
      "--x",
    ]);
  });

  it("the started runner process has --disable-sigusr1 in its execArgv", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-worker-spawn-"));
    try {
      const runner = path.join(root, "runner.cjs");
      await writeFile(runner, "process.stdout.write(JSON.stringify(process.execArgv));");
      const result = spawnSync(
        process.execPath,
        packagedWorkerSpawnArgs(runner, "/unused.js", []),
        {
          encoding: "utf8",
          env: { ...process.env, NODE_OPTIONS: "" },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toContain("--disable-sigusr1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
