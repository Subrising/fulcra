import { describe, expect, it, vi } from "vitest";
import {
  countBusySessions,
  planBootDaemon,
  stopBootDaemon,
  waitForIdleBootDaemon,
  type BootDaemonDeps,
  type NoCredentialProbe,
} from "./boot-daemon-replace.js";

const boot = { status: "running", desktopManaged: false, listen: "127.0.0.1:6767", pid: 42 };

function deps(overrides: Partial<BootDaemonDeps> = {}): BootDaemonDeps {
  return {
    commandCentreEnabled: true,
    homeHasCommandCentreAuth: () => false,
    probeWithoutCredential: async () => ({ answered: true, busy: 0 }),
    stillSameInstance: async () => true,
    stop: async () => true,
    log: vi.fn(),
    logError: vi.fn(),
    pause: async () => {},
    wait: { totalMs: 100, stepMs: 10 },
    ...overrides,
  };
}

describe("countBusySessions", () => {
  it("counts only loaded running or initializing sessions", () => {
    expect(
      countBusySessions([
        { status: "running", note: "" },
        { status: "initializing", note: "" },
        { status: "running", note: "not loaded" },
        { status: "idle", note: "" },
        { status: "closed", note: "" },
        { status: "error", note: "" },
        null,
      ]),
    ).toBe(2);
    expect(countBusySessions([])).toBe(0);
  });
  it("refuses a payload that is not an agent list", () => {
    expect(() => countBusySessions({ localDaemon: "running" })).toThrow();
  });
});

describe("planBootDaemon", () => {
  it("replaces an idle boot daemon that answers with no credential", async () => {
    expect(await planBootDaemon(boot, deps())).toEqual({ kind: "replace" });
  });
  it("waits while a turn runs", async () => {
    const probe = async (): Promise<NoCredentialProbe> => ({ answered: true, busy: 2 });
    expect(await planBootDaemon(boot, deps({ probeWithoutCredential: probe }))).toEqual({
      kind: "wait",
      busy: 2,
    });
  });
  it.each([
    ["command centre is off", boot, { commandCentreEnabled: false }],
    ["the app started the daemon", { ...boot, desktopManaged: true }, {}],
    ["the daemon is not ready", { ...boot, status: "starting", listen: null }, {}],
    ["the home stores command centre auth", boot, { homeHasCommandCentreAuth: () => true }],
    [
      "the daemon needs a credential",
      boot,
      {
        probeWithoutCredential: async (): Promise<NoCredentialProbe> => ({
          answered: false,
          reason: "The daemon requires a password.",
        }),
      },
    ],
  ] as const)("adopts unchanged when %s", async (_name, current, overrides) => {
    const probe = vi.fn(async (): Promise<NoCredentialProbe> => ({ answered: true, busy: 0 }));
    const plan = await planBootDaemon(
      current,
      deps({ probeWithoutCredential: probe, ...overrides }),
    );
    expect(plan.kind).toBe("adopt");
  });
});

describe("waitForIdleBootDaemon", () => {
  it("returns true when the running turns end", async () => {
    const busy = [1, 1, 0];
    const probe = vi.fn(
      async (): Promise<NoCredentialProbe> => ({
        answered: true,
        busy: busy.shift() ?? 0,
      }),
    );
    expect(await waitForIdleBootDaemon(boot, deps({ probeWithoutCredential: probe }))).toBe(true);
    expect(probe).toHaveBeenCalledTimes(3);
  });
  it("gives up at the deadline and leaves the daemon", async () => {
    let clock = 0;
    const stop = vi.fn(async () => true);
    const d = deps({
      now: () => clock,
      pause: async (ms) => {
        clock += ms;
      },
      probeWithoutCredential: async () => ({ answered: true, busy: 1 }),
      stop,
    });
    expect(await waitForIdleBootDaemon(boot, d)).toBe(false);
    expect(stop).not.toHaveBeenCalled();
    expect(d.log).toHaveBeenLastCalledWith(
      "boot daemon wait ran out; leaving it running",
      expect.anything(),
    );
  });
  it("stops waiting when the daemon changes", async () => {
    expect(await waitForIdleBootDaemon(boot, deps({ stillSameInstance: async () => false }))).toBe(
      false,
    );
  });
});

describe("stopBootDaemon", () => {
  it("stops the same idle instance", async () => {
    const stop = vi.fn(async () => true);
    expect(await stopBootDaemon(boot, deps({ stop }))).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["the stop throws", async () => Promise.reject(new Error("stop timed out"))],
    ["the daemon is still recorded", async () => false],
  ])("writes one error line and keeps the old daemon when %s", async (_name, stop) => {
    const d = deps({ stop });
    expect(await stopBootDaemon(boot, d)).toBe(false);
    expect(d.logError).toHaveBeenCalledTimes(1);
  });
  it("does not stop a daemon that changed", async () => {
    const stop = vi.fn(async () => true);
    expect(await stopBootDaemon(boot, deps({ stop, stillSameInstance: async () => false }))).toBe(
      false,
    );
    expect(stop).not.toHaveBeenCalled();
  });
});
