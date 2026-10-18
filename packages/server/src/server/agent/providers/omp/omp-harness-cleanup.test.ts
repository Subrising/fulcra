import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { OmpHarness } from "./test-utils/omp-harness.js";

test("registered teardown closes a native MCP fixture after an interrupted test", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-teardown-"));
  const pidFile = join(directory, "pid");
  const callbacks: Array<() => Promise<void>> = [];
  const omp = new OmpHarness({ onFinished: (cleanup) => callbacks.push(cleanup) });
  await mkdir("/tmp/paseo-omp-agent-test", { recursive: true });
  try {
    await omp.start({ mcpServers: { echo: {
      type: "stdio", command: process.execPath,
      args: [fileURLToPath(new URL("./test-utils/echo-mcp-server.mjs", import.meta.url))],
      env: { OMP_MCP_PID_FILE: pidFile },
    } } });
    const pid = Number(await readFile(pidFile, "utf8"));
    expect(callbacks).toHaveLength(1);
    // Run the registered hook without calling the test body's normal close path.
    await callbacks[0]!();
    expect(omp.isClosed()).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    await omp.close();
    await rm(directory, { recursive: true, force: true });
  }
});
