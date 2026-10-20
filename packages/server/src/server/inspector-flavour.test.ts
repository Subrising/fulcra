import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GATE_FLAVOUR, packagedInspectorFlags } from "./inspector-flavour.js";

const repoRoot = join(__dirname, "..", "..", "..", "..");
const read = (file: string): string => readFileSync(join(repoRoot, file), "utf8");

describe("packaged inspector (FU-79)", () => {
  it("the release build starts every packaged daemon process with --disable-sigusr1", () => {
    expect(GATE_FLAVOUR).toBe(false);
    expect(packagedInspectorFlags()).toEqual(["--disable-sigusr1"]);
  });

  it("the release build has no code path that omits the flag", () => {
    const source = read("packages/server/src/server/inspector-flavour.ts");
    // One constant decides. It is a literal: no environment variable, file or argument can change it.
    expect(source).toMatch(/^export const GATE_FLAVOUR = false;$/m);
    const code = source.replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/process\.(env|argv)|readFile|existsSync|import\.meta/);
    expect(code.match(/GATE_FLAVOUR/g)).toHaveLength(2);
  });

  it("the supervisor and the desktop launcher both take the flags from that one function", () => {
    expect(read("packages/server/scripts/supervisor-entrypoint.ts")).toContain(
      "...packagedInspectorFlags()",
    );
    // FU-413: the packaged worker starts through the entry point runner; that path needs the flags too.
    expect(read("packages/server/scripts/supervisor-entrypoint.ts")).toContain(
      "args: packagedWorkerSpawnArgs(",
    );
    expect(read("packages/desktop/src/daemon/node-entrypoint-launcher.ts")).toContain(
      "...packagedInspectorFlags()",
    );
  });

  it("the Electron fuse for inspector arguments is off and Node mode stays on", () => {
    const config = read("packages/desktop/electron-builder.yml");
    expect(config).toMatch(/enableNodeCliInspectArguments: false/);
    expect(config).toMatch(/runAsNode: true/);
  });

  it("no release workflow or package script runs the gate build", () => {
    const files = [
      ...readdirSync(join(repoRoot, ".github/workflows")).map((f) => `.github/workflows/${f}`),
      "package.json",
      "packages/desktop/package.json",
      "packages/server/package.json",
    ];
    const users = files.filter((f) => read(f).includes("build-gate-flavour"));
    expect(users).toEqual([]);
    expect(read("scripts/build-gate-flavour.mjs")).toContain("GATE_FLAVOUR = true");
  });
});
