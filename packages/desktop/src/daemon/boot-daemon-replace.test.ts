import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BOOT_DAEMON_IDLE_WAIT,
  BOOT_DAEMON_PROBE_TIMEOUT,
  countBusySessions,
  countDueSoon,
  countLiveTerminals,
  planBootDaemon,
  replaceBootDaemonWhenIdle,
  stopBootDaemon,
  type BootDaemonBusy,
  type BootDaemonDeps,
  type NoCredentialProbe,
} from "./boot-daemon-replace.js";

const boot = { status: "running", desktopManaged: false, listen: "127.0.0.1:6767", pid: 42 };
const idle: BootDaemonBusy = { turns: 0, terminals: 0, dueSoon: 0 };
const answered = (busy: Partial<BootDaemonBusy> = {}): NoCredentialProbe => ({
  answered: true,
  busy: { ...idle, ...busy },
});

function deps(overrides: Partial<BootDaemonDeps> = {}): BootDaemonDeps {
  return {
    commandCentreEnabled: true,
    homeHasCommandCentreAuth: () => false,
    probeWithoutCredential: async () => answered(),
    stillSameInstance: async () => true,
    preflight: async () => null,
    stop: async () => true,
    waitForExit: async () => false,
    log: vi.fn(),
    logError: vi.fn(),
    pause: async () => {},
    ...overrides,
  };
}

/** Probe answers in order; the last one repeats. */
function probes(...results: NoCredentialProbe[]) {
  return vi.fn(async () => (results.length > 1 ? results.shift()! : results[0]!));
}

const savedWait = { ...BOOT_DAEMON_IDLE_WAIT };
const savedTimeout = BOOT_DAEMON_PROBE_TIMEOUT.ms;
afterEach(() => {
  Object.assign(BOOT_DAEMON_IDLE_WAIT, savedWait);
  BOOT_DAEMON_PROBE_TIMEOUT.ms = savedTimeout;
});

describe("busy counts", () => {
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
  it("counts every listed terminal, workspace script terminals included", () => {
    expect(countLiveTerminals([{ id: "t1" }, { id: "script" }])).toBe(2);
    expect(countLiveTerminals([])).toBe(0);
  });
  it("counts active schedules and heartbeats due or overdue within 2 minutes", () => {
    const now = Date.parse("2026-11-12T10:00:00Z");
    expect(
      countDueSoon(
        [
          { status: "active", nextRunAt: "2026-11-12T10:01:59Z" },
          { status: "active", nextRunAt: "2026-11-12T09:59:00Z" },
          { status: "active", nextRunAt: "2026-11-12T10:02:01Z" },
          { status: "paused", nextRunAt: "2026-11-12T10:00:30Z" },
          { status: "active", nextRunAt: null },
        ],
        now,
      ),
    ).toBe(2);
  });
  it("refuses a payload that is not a list", () => {
    expect(() => countBusySessions({ localDaemon: "running" })).toThrow();
    expect(() => countLiveTerminals(undefined)).toThrow();
    expect(() => countDueSoon({}, 0)).toThrow();
  });
});

describe("planBootDaemon", () => {
  it("replaces an idle boot daemon that answers with no credential", async () => {
    expect(await planBootDaemon(boot, deps())).toEqual({ kind: "replace" });
  });
  it.each([
    ["a turn runs", { turns: 1 }],
    ["a terminal or workspace script runs", { terminals: 1 }],
    ["a schedule or heartbeat is due soon", { dueSoon: 1 }],
  ])("waits when %s", async (_name, busy) => {
    const plan = await planBootDaemon(
      boot,
      deps({ probeWithoutCredential: probes(answered(busy)) }),
    );
    expect(plan.kind).toBe("wait");
  });
  it.each([
    ["command centre is off", boot, { commandCentreEnabled: false }],
    ["the app started the daemon", { ...boot, desktopManaged: true }, {}],
    ["the daemon is not ready", { ...boot, status: "starting", listen: null }, {}],
    ["the home stores command centre auth", boot, { homeHasCommandCentreAuth: () => true }],
    [
      "the daemon needs a credential",
      boot,
      { probeWithoutCredential: probes({ answered: false, reason: "Password required" }) },
    ],
    [
      "the probe throws",
      boot,
      { probeWithoutCredential: async () => Promise.reject(new Error("spawn failed")) },
    ],
  ] as const)("adopts unchanged when %s", async (_name, current, overrides) => {
    expect((await planBootDaemon(current, deps(overrides))).kind).toBe("adopt");
  });
  it("adopts when the probe does not answer within the overall timeout", async () => {
    BOOT_DAEMON_PROBE_TIMEOUT.ms = 20;
    const plan = await planBootDaemon(
      boot,
      deps({ probeWithoutCredential: () => new Promise<NoCredentialProbe>(() => {}) }),
    );
    expect(plan).toEqual({ kind: "adopt", reason: expect.stringContaining("timed out") });
  });
});

describe("stopBootDaemon", () => {
  it("stops the same idle instance", async () => {
    const stop = vi.fn(async () => true);
    expect(await stopBootDaemon(boot, deps({ stop }))).toBe("stopped");
    expect(stop).toHaveBeenCalledTimes(1);
  });
  it("probes again just before the stop and does not stop busy work", async () => {
    const stop = vi.fn(async () => true);
    const d = deps({ stop, probeWithoutCredential: probes(answered({ dueSoon: 1 })) });
    expect(await stopBootDaemon(boot, d)).toBe("busy");
    expect(stop).not.toHaveBeenCalled();
  });
  it.each([
    ["the daemon changed", { stillSameInstance: async () => false }],
    ["the preflight refuses", { preflight: async () => "command centre is off" }],
    ["the preflight throws", { preflight: async () => Promise.reject(new Error("keychain")) }],
  ])("does not stop when %s", async (_name, overrides) => {
    const stop = vi.fn(async () => true);
    expect(await stopBootDaemon(boot, deps({ stop, ...overrides }))).toBe("kept");
    expect(stop).not.toHaveBeenCalled();
  });
  it("waits for a stop that timed out and continues when the daemon exits", async () => {
    const d = deps({
      stop: async () => Promise.reject(new Error("stop timed out")),
      waitForExit: async () => true,
    });
    expect(await stopBootDaemon(boot, d)).toBe("stopped");
    expect(d.log).toHaveBeenCalledWith(
      "boot daemon stop did not finish; it may still be stopping, waiting for it to exit",
      expect.objectContaining({ error: "stop timed out" }),
    );
    expect(d.logError).not.toHaveBeenCalled();
  });
  it.each([
    ["the stop throws", async () => Promise.reject(new Error("stop timed out"))],
    ["the daemon is still recorded", async () => false],
  ])(
    "writes one error line and keeps the old daemon when %s and it never exits",
    async (_name, stop) => {
      const d = deps({ stop });
      expect(await stopBootDaemon(boot, d)).toBe("kept");
      expect(d.logError).toHaveBeenCalledTimes(1);
    },
  );
});

describe("replaceBootDaemonWhenIdle", () => {
  it("stops when the busy work ends", async () => {
    BOOT_DAEMON_IDLE_WAIT.stepMs = 1;
    const probe = probes(answered({ turns: 1 }), answered({ terminals: 1 }), answered());
    const stop = vi.fn(async () => true);
    expect(
      await replaceBootDaemonWhenIdle(boot, deps({ probeWithoutCredential: probe, stop })),
    ).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
  });
  it("keeps waiting when the last probe before the stop finds busy work", async () => {
    BOOT_DAEMON_IDLE_WAIT.stepMs = 1;
    const probe = probes(answered(), answered({ turns: 1 }), answered(), answered());
    const stop = vi.fn(async () => true);
    expect(
      await replaceBootDaemonWhenIdle(boot, deps({ probeWithoutCredential: probe, stop })),
    ).toBe(true);
    expect(probe).toHaveBeenCalledTimes(4);
    expect(stop).toHaveBeenCalledTimes(1);
  });
  it("does not stop when the settings turn off during the wait", async () => {
    BOOT_DAEMON_IDLE_WAIT.stepMs = 1;
    let enabled = true;
    const probe = vi.fn(async () => {
      if (probe.mock.calls.length === 1) return answered({ turns: 1 });
      enabled = false;
      return answered();
    });
    const stop = vi.fn(async () => true);
    const d = deps({
      probeWithoutCredential: probe,
      stop,
      preflight: async () => (enabled ? null : "command centre is off"),
    });
    expect(await replaceBootDaemonWhenIdle(boot, d)).toBe(false);
    expect(stop).not.toHaveBeenCalled();
  });
  it("gives up at the deadline and leaves the daemon", async () => {
    let clock = 0;
    const stop = vi.fn(async () => true);
    const d = deps({
      now: () => clock,
      pause: async (ms) => {
        clock += ms;
      },
      probeWithoutCredential: async () => answered({ turns: 1 }),
      stop,
    });
    expect(await replaceBootDaemonWhenIdle(boot, d)).toBe(false);
    expect(stop).not.toHaveBeenCalled();
    expect(d.log).toHaveBeenLastCalledWith(
      "boot daemon wait ran out; leaving it running",
      expect.anything(),
    );
  });
  it("stops waiting when the daemon changes", async () => {
    BOOT_DAEMON_IDLE_WAIT.stepMs = 1;
    expect(
      await replaceBootDaemonWhenIdle(boot, deps({ stillSameInstance: async () => false })),
    ).toBe(false);
  });
});
