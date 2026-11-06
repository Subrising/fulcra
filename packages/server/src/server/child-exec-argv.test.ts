import { fork } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { daemonChildExecArgv } from "./child-exec-argv.js";
import { resolveWorkerExecArgv as pluginHostExecArgv } from "./plugins/runtime.js";
import { resolveWorkerExecArgv as speechWorkerExecArgv } from "./speech/providers/local/worker-client.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildSelfNodeCommand } from "./paseo-env.js";

const packagedUrl = "file:///app/dist/server/server/module.js";
const sourceUrl = "file:///repo/packages/server/src/server/module.ts";

describe("daemon child execArgv (FU-466)", () => {
  afterEach(() => {
    vi.doUnmock("./inspector-flavour.js");
    vi.resetModules();
  });

  it("daemonChildExecArgv: a packaged child starts with --disable-sigusr1", () => {
    expect(daemonChildExecArgv(packagedUrl, new URL("file:///app/loader.mjs"))).toEqual([
      "--disable-sigusr1",
    ]);
  });

  it("daemonChildExecArgv: a source child keeps the loader flags after the inspector flags", () => {
    const argv = daemonChildExecArgv(sourceUrl, new URL("file:///repo/loader.mjs"));
    expect(argv[0]).toBe("--disable-sigusr1");
    expect(argv.slice(1, 3)).toEqual(["--experimental-strip-types", "--import"]);
  });

  it("daemonChildExecArgv: drops empty flags and keeps no stray empty string", async () => {
    vi.resetModules();
    vi.doMock("./inspector-flavour.js", () => ({ packagedInspectorFlags: () => ["", "--x"] }));
    const mocked = await import("./child-exec-argv.js");
    expect(mocked.daemonChildExecArgv(packagedUrl, new URL("file:///l.mjs"))).toEqual(["--x"]);
  });

  it("daemonChildExecArgv: the gate flavour (no flags) gives an empty list for a packaged child", async () => {
    vi.resetModules();
    vi.doMock("./inspector-flavour.js", () => ({ packagedInspectorFlags: () => [] }));
    const mocked = await import("./child-exec-argv.js");
    const argv = mocked.daemonChildExecArgv(packagedUrl, new URL("file:///l.mjs"));
    expect(argv).toEqual([]);
    expect(argv).not.toContain("");
  });

  it("plugin host: resolveWorkerExecArgv gives a packaged child --disable-sigusr1", () => {
    expect(pluginHostExecArgv(packagedUrl)).toEqual(["--disable-sigusr1"]);
    expect(pluginHostExecArgv(sourceUrl)[0]).toBe("--disable-sigusr1");
  });

  // FULCRA(FU-657): upstream v0.15 starts the terminal worker through a detached launcher
  // (terminal-worker-launch.ts -> buildSelfNodeCommand), and the launcher spawns the worker with its
  // own process.execArgv. resolveWorkerExecArgv is gone, so check both links of that chain.
  it("terminal worker: the launcher command starts with --disable-sigusr1 and the worker inherits it", () => {
    expect(buildSelfNodeCommand(["worker.mjs", "--launch"]).args).toEqual([
      "--disable-sigusr1",
      "worker.mjs",
      "--launch",
    ]);
    const launcher = readFileSync(
      fileURLToPath(new URL("../terminal/terminal-worker-process.ts", import.meta.url)),
      "utf8",
    );
    expect(launcher).toMatch(/spawn\(\s*process\.execPath,\s*\[\s*\.\.\.process\.execArgv,/);
  });

  it("speech worker: resolveWorkerExecArgv gives a packaged child --disable-sigusr1", () => {
    expect(speechWorkerExecArgv(packagedUrl)).toEqual(["--disable-sigusr1"]);
    expect(speechWorkerExecArgv(sourceUrl)[0]).toBe("--disable-sigusr1");
  });

  // The child reports node:inspector.url() after SIGUSR1. --inspect-port=0 picks a free port, so the result
  // does not depend on port 9229 being free.
  async function inspectorUrlAfterSigusr1(execArgv: string[]): Promise<string | undefined> {
    const dir = mkdtempSync(path.join(tmpdir(), "child-exec-argv-"));
    const script = path.join(dir, "child.mjs");
    writeFileSync(
      script,
      [
        'import inspector from "node:inspector";',
        'process.on("message", () => {',
        "  setTimeout(() => {",
        "    const url = inspector.url();",
        "    if (url) inspector.close();",
        "    process.send({ url });",
        "  }, 300);",
        "});",
        "setInterval(() => {}, 1000);",
        'process.send("up");',
        "",
      ].join("\n"),
    );
    const child = fork(script, [], {
      execArgv: [...execArgv, "--inspect-port=0"],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    try {
      await new Promise((resolve, reject) => {
        child.once("message", resolve);
        child.once("error", reject);
        child.once("exit", () => reject(new Error("child exited before it was ready")));
      });
      const report = new Promise<{ url?: string }>((resolve, reject) => {
        child.on("message", (message) => resolve(message as { url?: string }));
        child.once("exit", () => reject(new Error("child exited after SIGUSR1")));
      });
      child.kill("SIGUSR1");
      setTimeout(() => child.send("report"), 100);
      return (await report).url;
    } finally {
      child.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it.skipIf(process.platform === "win32")(
    "a forked child ignores SIGUSR1 and opens no inspector",
    async () => {
      // FULCRA(FU-657): the terminal worker gets its flags from buildSelfNodeCommand now.
      const flags = buildSelfNodeCommand([]).args;
      expect(await inspectorUrlAfterSigusr1(flags)).toBeUndefined();
    },
  );

  it.skipIf(process.platform === "win32")(
    "control: the same child without the flag opens an inspector on SIGUSR1",
    async () => {
      expect(await inspectorUrlAfterSigusr1([])).toMatch(/^ws:\/\//);
    },
  );
});
