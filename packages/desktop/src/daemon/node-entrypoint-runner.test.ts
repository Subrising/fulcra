import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { backgroundExecArgv, main, resolveBackgroundExecPath } from "./node-entrypoint-runner";

declare global {
  // eslint-disable-next-line no-var
  var __PASEO_NODE_ENTRYPOINT_RUNNER_FIXTURE__:
    | {
        argv: string[];
        electronRunAsNode: string | undefined;
        electronNoAttachConsole: string | undefined;
      }
    | undefined;
}

describe("node-entrypoint-runner", () => {
  it("keeps Node flags such as --disable-warning when it execs into the Helper", () => {
    expect(
      backgroundExecArgv(
        "/A.app/Contents/Frameworks/A Helper.app/Contents/MacOS/A Helper",
        ["--disable-warning=DEP0040"],
        [
          "/A.app/Contents/MacOS/A",
          "/A.app/Contents/Resources/runner.js",
          "node-script",
          "/entry.js",
        ],
      ),
    ).toEqual([
      "/A.app/Contents/Frameworks/A Helper.app/Contents/MacOS/A Helper",
      "--disable-warning=DEP0040",
      "/A.app/Contents/Resources/runner.js",
      "node-script",
      "/entry.js",
    ]);
  });

  it("preserves Electron node-mode env before loading the target entrypoint", async () => {
    const originalArgv = process.argv;
    const originalRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
    const originalNoAttachConsole = process.env.ELECTRON_NO_ATTACH_CONSOLE;
    const originalFixture = globalThis.__PASEO_NODE_ENTRYPOINT_RUNNER_FIXTURE__;
    const fixtureDir = mkdtempSync(path.join(tmpdir(), "paseo-node-entrypoint-runner-"));
    const fixturePath = path.join(fixtureDir, "fixture.mjs");
    writeFileSync(
      fixturePath,
      `
globalThis.__PASEO_NODE_ENTRYPOINT_RUNNER_FIXTURE__ = {
  argv: process.argv,
  electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE,
  electronNoAttachConsole: process.env.ELECTRON_NO_ATTACH_CONSOLE,
};
`,
    );

    process.argv = ["Paseo", "runner", "node-script", fixturePath, "daemon", "start"];
    process.env.ELECTRON_RUN_AS_NODE = "1";
    process.env.ELECTRON_NO_ATTACH_CONSOLE = "1";
    delete globalThis.__PASEO_NODE_ENTRYPOINT_RUNNER_FIXTURE__;

    try {
      await main();

      expect(globalThis.__PASEO_NODE_ENTRYPOINT_RUNNER_FIXTURE__).toEqual({
        argv: ["Paseo", fixturePath, "daemon", "start"],
        electronRunAsNode: "1",
        electronNoAttachConsole: "1",
      });
    } finally {
      process.argv = originalArgv;
      if (originalRunAsNode === undefined) {
        delete process.env.ELECTRON_RUN_AS_NODE;
      } else {
        process.env.ELECTRON_RUN_AS_NODE = originalRunAsNode;
      }
      if (originalNoAttachConsole === undefined) {
        delete process.env.ELECTRON_NO_ATTACH_CONSOLE;
      } else {
        process.env.ELECTRON_NO_ATTACH_CONSOLE = originalNoAttachConsole;
      }
      globalThis.__PASEO_NODE_ENTRYPOINT_RUNNER_FIXTURE__ = originalFixture;
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  describe("background exec path (no Dock icon on macOS)", () => {
    const mainExecutable = "/Applications/Fulcra.app/Contents/MacOS/Fulcra";
    const helper =
      "/Applications/Fulcra.app/Contents/Frameworks/Fulcra Helper.app/Contents/MacOS/Fulcra Helper";

    it("runs the bundle's main executable through its Helper", () => {
      expect(
        resolveBackgroundExecPath({
          execPath: mainExecutable,
          platform: "darwin",
          exists: (p) => p === helper,
        }),
      ).toBe(helper);
    });

    it("keeps the Helper, plain Node, other platforms and bundles without a Helper", () => {
      const exists = () => true;
      expect(
        resolveBackgroundExecPath({ execPath: helper, platform: "darwin", exists }),
      ).toBeNull();
      expect(
        resolveBackgroundExecPath({
          execPath: "/opt/homebrew/bin/node",
          platform: "darwin",
          exists,
        }),
      ).toBeNull();
      expect(
        resolveBackgroundExecPath({ execPath: mainExecutable, platform: "linux", exists }),
      ).toBeNull();
      expect(
        resolveBackgroundExecPath({
          execPath: mainExecutable,
          platform: "darwin",
          exists: () => false,
        }),
      ).toBeNull();
    });
  });
});
