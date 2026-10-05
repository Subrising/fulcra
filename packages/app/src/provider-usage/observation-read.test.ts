import { describe, expect, it, vi } from "vitest";
import type { ProviderUsageListPayload } from "./types";
import { readUsageObservation } from "./observation-read";

type Client = Parameters<typeof readUsageObservation>[0];
function fixture(
  features: { pooledAccountUsageObservation?: boolean } = { pooledAccountUsageObservation: true },
) {
  let connection: ReturnType<Client["getConnectionState"]> = { status: "connected" };
  let info: ReturnType<Client["getLastServerInfoMessage"]> = {
    status: "server_info",
    serverId: "host",
    hostname: "Book",
    version: "test",
    permissions: ["daemon.read"],
    features,
  };
  const listeners = new Set<Parameters<Client["subscribeConnectionStatus"]>[0]>();
  const result: ProviderUsageListPayload = {
    requestId: "read",
    fetchedAt: "2026-10-04T00:00:00.000Z",
    providers: [],
    accounts: [],
    observationOnly: true,
    sessionAccount: null,
  };
  const read = vi.fn<Client["listProviderUsage"]>().mockResolvedValue(result);
  const client: Client = {
    getConnectionState: () => connection,
    getLastServerInfoMessage: () => info,
    subscribeConnectionStatus(listener) {
      listeners.add(listener);
      listener(connection);
      return () => {
        listeners.delete(listener);
      };
    },
    subscribe() {
      return () => {};
    },
    listProviderUsage: read,
  };
  return {
    client,
    read,
    result,
    listeners,
    connect(next: typeof connection) {
      connection = next;
      for (const listener of listeners) listener(next);
    },
    info(next: typeof info) {
      info = next;
    },
  };
}
describe("observation-only account reads", () => {
  it.each([undefined, false])(
    "never dispatches for an unsupported runtime (%s)",
    async (supported) => {
      const host = fixture({ pooledAccountUsageObservation: supported });
      await expect(readUsageObservation(host.client, "chat", () => true)).rejects.toThrow(
        "not supported",
      );
      expect(host.read).not.toHaveBeenCalled();
      expect(host.listeners.size).toBe(0);
    },
  );
  it("uses the existing chat identity, requires the echo, and never requests a generating refresh", async () => {
    const host = fixture();
    expect(await readUsageObservation(host.client, "chat", () => true)).toEqual(host.result);
    expect(host.read).toHaveBeenCalledExactlyOnceWith({
      agentId: "chat",
      accounts: true,
      observationOnly: true,
    });
    expect(host.listeners.size).toBe(0);
  });
  it("rejects a legacy reply instead of retrying a cold read", async () => {
    const host = fixture();
    host.read.mockResolvedValue({
      requestId: "read",
      fetchedAt: host.result.fetchedAt,
      providers: [],
    });
    await expect(readUsageObservation(host.client, "chat", () => true)).rejects.toThrow(
      "no longer current",
    );
    expect(host.read).toHaveBeenCalledTimes(1);
  });
  it("a disconnect/reconnect cannot revive a pending reply", async () => {
    const host = fixture();
    let finish!: (reply: ProviderUsageListPayload) => void;
    host.read.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = readUsageObservation(host.client, "chat", () => true);
    host.connect({ status: "disconnected" });
    host.connect({ status: "connected" });
    finish(host.result);
    await expect(pending).rejects.toThrow("no longer current");
    expect(host.listeners.size).toBe(0);
  });
  it("rejects a reply after the actual host or chat runtime changes", async () => {
    const host = fixture();
    let current = true;
    host.read.mockImplementation(async () => {
      current = false;
      return host.result;
    });
    await expect(readUsageObservation(host.client, "chat", () => current)).rejects.toThrow(
      "no longer current",
    );
  });
  it("rejects admission changes before dispatch without generating fallback calls", async () => {
    const host = fixture();
    host.info({
      status: "server_info",
      serverId: "host",
      hostname: "Book",
      version: "test",
      permissions: [],
      features: { pooledAccountUsageObservation: true },
    });
    await expect(readUsageObservation(host.client, "chat", () => true)).rejects.toThrow(
      "not supported",
    );
    expect(host.read).not.toHaveBeenCalled();
  });
});
