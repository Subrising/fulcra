import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { packagedWorkerSpawnSpec } from "./packaged-worker-spawn.js";

// FU-413: a packaged release worker starts through the entry point runner, not through fork(). It opened a Node
// inspector on SIGUSR1 because that path did not pass the FU-79 flags.
describe("packaged worker spawn spec (FU-79, FU-413)", () => {
  it("starts the runner with the inspector flag first", () => {
    const spec = packagedWorkerSpawnSpec("/app/runner.js", "/app/daemon-worker.js", ["--x"], {
      A: "1",
    });
    expect(spec.command).toBe(process.execPath);
    expect(spec.args[0]).toBe("--disable-sigusr1");
    expect(spec.args[1]).toBe("/app/runner.js");
    expect(spec.args).toEqual([
      "--disable-sigusr1",
      "/app/runner.js",
      "node-script",
      "/app/daemon-worker.js",
      "--x",
    ]);
    expect(spec.env).toEqual({ A: "1", ELECTRON_RUN_AS_NODE: "1" });
  });

  it("the started runner process has --disable-sigusr1 in its execArgv", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-worker-spawn-"));
    try {
      const runner = path.join(root, "runner.cjs");
      await writeFile(runner, "process.stdout.write(JSON.stringify(process.execArgv));");
      const spec = packagedWorkerSpawnSpec(runner, "/unused.js", [], {
        ...process.env,
        NODE_OPTIONS: "",
      });
      const result = spawnSync(spec.command, spec.args, { encoding: "utf8", env: spec.env });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toContain("--disable-sigusr1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
