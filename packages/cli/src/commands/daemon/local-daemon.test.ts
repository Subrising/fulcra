import { describe, expect, it, vi } from "vitest";
import { daemonRunnerArgs } from "./local-daemon.js";

describe("daemonRunnerArgs (FU-466)", () => {
  it("a packaged supervisor starts with --disable-sigusr1 before the entry", () => {
    expect(daemonRunnerArgs("/app/dist/supervisor-entrypoint.js")).toEqual([
      "--disable-sigusr1",
      "/app/dist/supervisor-entrypoint.js",
    ]);
  });

  it("a source supervisor keeps the tsx loader", () => {
    expect(daemonRunnerArgs("/repo/scripts/supervisor-entrypoint.ts")).toEqual([
      "--import",
      "tsx",
      "/repo/scripts/supervisor-entrypoint.ts",
    ]);
  });

  it("an empty gate flag list adds no stray entry", async () => {
    vi.resetModules();
    vi.doMock("@getpaseo/server/inspector-flavour", () => ({ packagedInspectorFlags: () => [] }));
    const gate = await import("./local-daemon.js");
    expect(gate.daemonRunnerArgs("/app/entry.js")).toEqual(["/app/entry.js"]);
    vi.doUnmock("@getpaseo/server/inspector-flavour");
    vi.resetModules();
  });
});
