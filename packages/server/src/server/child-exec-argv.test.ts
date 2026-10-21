import { fork } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { daemonChildExecArgv } from "./child-exec-argv.js";
import { resolveWorkerExecArgv as pluginHostExecArgv } from "./plugins/runtime.js";
import { resolveWorkerExecArgv as speechWorkerExecArgv } from "./speech/providers/local/worker-client.js";
import { resolveWorkerExecArgv as terminalWorkerExecArgv } from "../terminal/worker-terminal-manager.js";

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

  it("terminal worker: resolveWorkerExecArgv gives a packaged child --disable-sigusr1", () => {
    expect(terminalWorkerExecArgv(packagedUrl)).toEqual(["--disable-sigusr1"]);
    expect(terminalWorkerExecArgv(sourceUrl)[0]).toBe("--disable-sigusr1");
  });

  it("speech worker: resolveWorkerExecArgv gives a packaged child --disable-sigusr1", () => {
    expect(speechWorkerExecArgv(packagedUrl)).toEqual(["--disable-sigusr1"]);
    expect(speechWorkerExecArgv(sourceUrl)[0]).toBe("--disable-sigusr1");
  });

  it.skipIf(process.platform === "win32")(
    "a forked child ignores SIGUSR1 and opens no inspector",
    async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "child-exec-argv-"));
      const script = path.join(dir, "child.mjs");
      writeFileSync(script, 'setInterval(() => {}, 1000); process.send("up");\n');
      const child = fork(script, [], {
        execArgv: terminalWorkerExecArgv(packagedUrl),
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      let stderr = "";
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      try {
        await new Promise((resolve, reject) => {
          child.once("message", resolve);
          child.once("error", reject);
          child.once("exit", () => reject(new Error("child exited before it was ready")));
        });
        child.kill("SIGUSR1");
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(child.exitCode).toBeNull();
        expect(child.signalCode).toBeNull();
        expect(stderr).not.toContain("Debugger listening");
      } finally {
        child.kill("SIGKILL");
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
