import { beforeEach, describe, expect, it, vi } from "vitest";

const invokePluginRpc = vi.fn();
// L46: the host "relay" reaches its Mac only through the relay.
const connectionOf = (serverId: string) =>
  serverId === "relay" ? { type: "relay" } : { type: "directTcp" };
const installedPlugins: { serverId: string; id: string }[] = [];

vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({
    getClient: (serverId: string) => (serverId === "offline" ? null : { invokePluginRpc }),
    getSnapshot: (serverId: string) => ({ activeConnection: connectionOf(serverId) }),
  }),
}));
let catalogSettled = true;
vi.mock("@/plugins/registry", () => ({
  pluginRegistry: {
    getSnapshot: () => installedPlugins,
    isCatalogSettled: () => catalogSettled,
  },
}));

const { readSessionOwnership, requestSessionOwnership, resetSessionOwnershipStore } =
  await import("./session-ownership-store");

const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

function record(overrides: Record<string, unknown> = {}) {
  return {
    state: "recorded",
    projectId: "1f0b9f2e-6d3a-4a1b-9c8e-2f5d7b1a3c9e",
    projectName: "Portable delivery",
    taskId: null,
    taskTitle: null,
    leaderAgentId: "agent-leader",
    leaderTitle: "Coordinator",
    detail: null,
    ...overrides,
  };
}

beforeEach(() => {
  catalogSettled = true;
  invokePluginRpc.mockReset();
  installedPlugins.length = 0;
  installedPlugins.push({ serverId: "host", id: "orca-organization" });
  resetSessionOwnershipStore();
});

describe("session ownership store", () => {
  it("L46: a relay-only host is not asked (Command Centre cannot answer there)", async () => {
    installedPlugins.push({ serverId: "relay", id: "orca-organization-next" });
    invokePluginRpc.mockResolvedValue({ ownership: { "agent-1": record() } });
    requestSessionOwnership("relay", "agent-1");
    await settle();
    expect(invokePluginRpc).not.toHaveBeenCalled();
    expect(readSessionOwnership("relay", "agent-1").kind).toBe("unassigned");
  });

  it("reads unassigned until an answer arrives, then the recorded owner", async () => {
    invokePluginRpc.mockResolvedValue({ ownership: { "agent-1": record() } });
    expect(readSessionOwnership("host", "agent-1").kind).toBe("unassigned");
    requestSessionOwnership("host", "agent-1");
    await settle();
    expect(readSessionOwnership("host", "agent-1")).toMatchObject({
      kind: "owned",
      state: "recorded",
      projectName: "Portable delivery",
    });
  });

  it("calls the exact method name the plugin can register", async () => {
    invokePluginRpc.mockResolvedValue({ ownership: {} });
    requestSessionOwnership("host", "agent-1");
    await settle();
    // Written out rather than imported from the constant on purpose: the two trees cannot
    // import from each other, so a rename has to change an asserted string on each side
    // instead of silently agreeing with itself. The plugin library validates method names
    // against /^[a-z][a-z0-9._-]*$/, so a camelCase spelling cannot be registered at all —
    // and the resulting unknown-method rejection is indistinguishable from a refusal.
    expect(invokePluginRpc.mock.calls[0][0]).toBe("orca-organization");
    expect(invokePluginRpc.mock.calls[0][1]).toBe("organization.session-ownership");
    expect(invokePluginRpc.mock.calls[0][1]).toMatch(/^[a-z][a-z0-9._-]*$/);
  });

  it("batches the rows on screen into one call and asks once per session", async () => {
    invokePluginRpc.mockResolvedValue({ ownership: {} });
    for (const id of ["a", "b", "c", "a"]) requestSessionOwnership("host", id);
    await settle();
    expect(invokePluginRpc).toHaveBeenCalledTimes(1);
    expect(invokePluginRpc.mock.calls[0][2]).toEqual({ agentIds: ["a", "b", "c"] });
    // An explicit "no record" is an answer: the row keeps the derived placement.
    expect(readSessionOwnership("host", "a").kind).toBe("unassigned");
  });

  it("logs once per host, and says whether it was a wiring fault or a refusal", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      invokePluginRpc.mockRejectedValue(
        new Error(
          "Plugin orca-organization does not contribute RPC organization.session-ownership",
        ),
      );
      requestSessionOwnership("host", "agent-1");
      await settle();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("wiring fault");
      // The row is still unassigned: the signal goes to the log, not the interface.
      expect(readSessionOwnership("host", "agent-1").kind).toBe("unassigned");
      // Never repeats, even once the quiet period would have lapsed.
      resetSessionOwnershipStore();
      warn.mockClear();
      invokePluginRpc.mockRejectedValue(new Error("No explicit supervisor grant"));
      requestSessionOwnership("host", "agent-2");
      await settle();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("refused");
      expect(warn.mock.calls[0][0]).not.toContain("wiring fault");
      requestSessionOwnership("host", "agent-3");
      await settle();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("goes quiet after a refusal instead of retrying", async () => {
    invokePluginRpc.mockRejectedValue(new Error("No explicit supervisor grant"));
    requestSessionOwnership("host", "agent-1");
    await settle();
    expect(invokePluginRpc).toHaveBeenCalledTimes(1);
    expect(readSessionOwnership("host", "agent-1").kind).toBe("unassigned");
    // Re-rendering the same rows, and new rows arriving, must not start a retry loop.
    for (const id of ["agent-1", "agent-2", "agent-3"]) requestSessionOwnership("host", id);
    await settle();
    expect(invokePluginRpc).toHaveBeenCalledTimes(1);
    expect(readSessionOwnership("host", "agent-2").kind).toBe("unassigned");
  });

  it("diagnoses a payload mismatch as a mismatch rather than a refusal", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // The shape the two trees agreed on, with the response key renamed on one side.
      invokePluginRpc.mockResolvedValue({ records: { "agent-1": record() } });
      requestSessionOwnership("host", "agent-1");
      await settle();
      expect(readSessionOwnership("host", "agent-1").kind).toBe("unassigned");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("diverged on the payload");
      // Sending someone to the controller for a seam fault is the failure being prevented.
      expect(warn.mock.calls[0][0]).not.toContain("refused");
      expect(warn.mock.calls[0][0]).not.toContain("wiring fault");
    } finally {
      warn.mockRestore();
    }
  });

  it("says why it asked nothing, so silence has one meaning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      // No organization plugin: benign, expected, and said once.
      installedPlugins.length = 0;
      requestSessionOwnership("host", "agent-1");
      requestSessionOwnership("host", "agent-2");
      await settle();
      expect(invokePluginRpc).not.toHaveBeenCalled();
      expect(info).toHaveBeenCalledTimes(1);
      expect(info.mock.calls[0][0]).toContain("no organization plugin is installed");

      // Plugins arrive asynchronously after a host connects; announcing "not installed"
      // during that window would be a false diagnosis.
      resetSessionOwnershipStore();
      info.mockClear();
      catalogSettled = false;
      requestSessionOwnership("host", "agent-3");
      await settle();
      expect(info).not.toHaveBeenCalled();

      // Ambiguous family: a configuration that silently disables ownership, so it warns.
      resetSessionOwnershipStore();
      catalogSettled = true;
      installedPlugins.push(
        { serverId: "host", id: "orca-organization-next" },
        { serverId: "host", id: "orca-organization-trial" },
      );
      requestSessionOwnership("host", "agent-4");
      requestSessionOwnership("host", "agent-5");
      await settle();
      expect(invokePluginRpc).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("Refusing to choose");
      expect(warn.mock.calls[0][0]).toContain("orca-organization-next");
    } finally {
      warn.mockRestore();
      info.mockRestore();
    }
  });

  it("never renders owned from a broken answer", async () => {
    invokePluginRpc.mockResolvedValue({ ownership: { "agent-1": "not-a-record" } });
    requestSessionOwnership("host", "agent-1");
    await settle();
    expect(readSessionOwnership("host", "agent-1").kind).toBe("unassigned");
    resetSessionOwnershipStore();
    // A record the controller cannot resolve is a real answer and reads unknown.
    invokePluginRpc.mockResolvedValue({ ownership: { "agent-2": record({ state: "unknown" }) } });
    requestSessionOwnership("host", "agent-2");
    await settle();
    expect(readSessionOwnership("host", "agent-2").kind).toBe("unknown");
    resetSessionOwnershipStore();
    // An unrecognised future state reads unknown rather than owned.
    invokePluginRpc.mockResolvedValue({
      ownership: { "agent-3": record({ state: "supervised" }) },
    });
    requestSessionOwnership("host", "agent-3");
    await settle();
    expect(readSessionOwnership("host", "agent-3").kind).toBe("unknown");
  });

  it("stops showing an answer once it is too old, and re-asks on the next render", async () => {
    invokePluginRpc.mockResolvedValue({ ownership: { "agent-1": record() } });
    requestSessionOwnership("host", "agent-1");
    await settle();
    expect(readSessionOwnership("host", "agent-1").kind).toBe("owned");
    expect(invokePluginRpc).toHaveBeenCalledTimes(1);

    // Only Date is faked, so the store's batching timers keep running for real.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 119_000);
      // Still inside its validity: shown, and not re-asked.
      expect(readSessionOwnership("host", "agent-1").kind).toBe("owned");
      requestSessionOwnership("host", "agent-1");
      await settle();
      expect(invokePluginRpc).toHaveBeenCalledTimes(1);

      vi.setSystemTime(Date.now() + 2_000);
      // Past it: the claim is dropped rather than aged, so the row falls back to the
      // derived placement instead of asserting something stale.
      expect(readSessionOwnership("host", "agent-1").kind).toBe("unassigned");
      // Nothing has polled in the meantime; the re-ask happens on the next render.
      expect(invokePluginRpc).toHaveBeenCalledTimes(1);

      invokePluginRpc.mockResolvedValue({
        ownership: { "agent-1": record({ state: "adopted", leaderTitle: "New leader" }) },
      });
      requestSessionOwnership("host", "agent-1");
      await settle();
      expect(invokePluginRpc).toHaveBeenCalledTimes(2);
      expect(readSessionOwnership("host", "agent-1")).toMatchObject({
        kind: "owned",
        leaderTitle: "New leader",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("issues no request at all when the host has no organization plugin", async () => {
    installedPlugins.length = 0;
    requestSessionOwnership("host", "agent-1");
    await settle();
    expect(invokePluginRpc).not.toHaveBeenCalled();
    expect(readSessionOwnership("host", "agent-1").kind).toBe("unassigned");
  });

  it("asks the plugin that is actually installed, whatever id it was given", async () => {
    invokePluginRpc.mockResolvedValue({ ownership: {} });
    // A directory plugin's id is chosen at install time, and staging registers a second
    // build alongside the live one, so a fixed id is an assumption rather than a fact.
    installedPlugins.length = 0;
    installedPlugins.push({ serverId: "host", id: "orca-organization-next" });
    requestSessionOwnership("host", "agent-1");
    await settle();
    expect(invokePluginRpc.mock.calls[0][0]).toBe("orca-organization-next");

    // With both present the exact id wins, so normal operation is unaffected by a staged
    // build sitting beside it.
    resetSessionOwnershipStore();
    invokePluginRpc.mockClear();
    installedPlugins.push({ serverId: "host", id: "orca-organization" });
    requestSessionOwnership("host", "agent-2");
    await settle();
    expect(invokePluginRpc.mock.calls[0][0]).toBe("orca-organization");

    // Two staged builds and no exact id is ambiguous: guessing would silently choose whose
    // records a person is reading, so nothing is asked.
    resetSessionOwnershipStore();
    invokePluginRpc.mockClear();
    installedPlugins.length = 0;
    installedPlugins.push(
      { serverId: "host", id: "orca-organization-next" },
      { serverId: "host", id: "orca-organization-trial" },
    );
    requestSessionOwnership("host", "agent-3");
    await settle();
    expect(invokePluginRpc).not.toHaveBeenCalled();
  });

  it("does not record an answer for a disconnected host", async () => {
    installedPlugins.push({ serverId: "offline", id: "orca-organization" });
    requestSessionOwnership("offline", "agent-1");
    await settle();
    expect(invokePluginRpc).not.toHaveBeenCalled();
    expect(readSessionOwnership("offline", "agent-1").kind).toBe("unassigned");
  });
});
