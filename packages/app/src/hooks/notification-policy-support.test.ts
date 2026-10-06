import { describe, expect, it } from "vitest";
import type { ServerInfoStatusPayload } from "@getpaseo/protocol/messages";
import {
  createNotificationPolicyObserver,
  isCurrentNotificationPolicy,
  applyNotificationPolicyChange,
  supportsNotificationPolicy,
  type NotificationPolicyClient,
} from "./notification-policy-support";
function info(flags: Record<string, unknown>): ServerInfoStatusPayload {
  return {
    status: "server_info",
    serverId: "srv_fixture",
    hostname: "Fixture host",
    version: "0.10.3",
    features: Object.assign({ autoResumeOnLimit: false }, flags),
  };
}
class PolicyClient implements NotificationPolicyClient {
  connection: ReturnType<NotificationPolicyClient["getConnectionState"]> = { status: "connected" };
  metadata: ServerInfoStatusPayload | null = info({ notificationPolicy: true });
  readonly listeners = new Set<
    Parameters<NotificationPolicyClient["subscribeConnectionStatus"]>[0]
  >();
  getConnectionState() {
    return this.connection;
  }
  getLastServerInfoMessage() {
    return this.metadata;
  }
  subscribeConnectionStatus(
    listener: Parameters<NotificationPolicyClient["subscribeConnectionStatus"]>[0],
  ) {
    this.listeners.add(listener);
    listener(this.connection);
    return () => {
      this.listeners.delete(listener);
    };
  }
  change(status: "connected" | "disconnected") {
    this.connection = { status };
    for (const listener of this.listeners) listener(this.connection);
  }
}
describe("notification policy current-connection fence", () => {
  it("requires the one explicit flag independently of configured defaults or legacy label acceptance", () => {
    expect(supportsNotificationPolicy(undefined)).toBe(false);
    expect(supportsNotificationPolicy({})).toBe(false);
    expect(supportsNotificationPolicy({ notificationPolicy: false })).toBe(false);
    expect(supportsNotificationPolicy({ notificationMode: "primes" })).toBe(false);
    expect(supportsNotificationPolicy({ notificationPolicy: true })).toBe(true);
    const client = new PolicyClient(),
      observer = createNotificationPolicyObserver(client);
    const release = observer.subscribe(() => {});
    try {
      client.metadata = info({});
      expect(observer.capture()).toBeNull();
      client.metadata = null;
      expect(observer.capture()).toBeNull();
      client.metadata = info({ notificationPolicy: true });
      const receipt = observer.capture();
      expect(isCurrentNotificationPolicy(receipt, { client, connectionStatus: "online" })).toBe(
        true,
      );
    } finally {
      release();
    }
  });
  it("refuses captured host-wide and label callbacks after client swap, drop, and same-client reconnect before fresh metadata", async () => {
    const client = new PolicyClient(),
      observer = createNotificationPolicyObserver(client);
    const release = observer.subscribe(() => {});
    try {
      const receipt = observer.capture();
      const writes: string[] = [];
      const dispatch = (kind: string, current: PolicyClient) =>
        applyNotificationPolicyChange({
          receipt,
          getHost: () => ({ client: current, connectionStatus: "online" }),
          apply: async () => {
            writes.push(kind);
          },
        });
      await expect(dispatch("patch", new PolicyClient())).rejects.toThrow("not current");
      await expect(dispatch("label", new PolicyClient())).rejects.toThrow("not current");
      expect(writes).toEqual([]);
      client.change("disconnected");
      await expect(dispatch("label", client)).rejects.toThrow("not current");
      expect(writes).toEqual([]);
      client.change("connected"); // Deliberately retain the cached support object: it is not new handshake evidence.
      expect(observer.capture()).toBeNull();
      await expect(dispatch("patch", client)).rejects.toThrow("not current");
      expect(writes).toEqual([]);
      client.metadata = info({});
      expect(observer.capture()).toBeNull();
      await expect(dispatch("label", client)).rejects.toThrow("not current");
      expect(writes).toEqual([]);
      client.metadata = info({ notificationPolicy: true });
      const fresh = observer.capture();
      expect(isCurrentNotificationPolicy(fresh, { client, connectionStatus: "online" })).toBe(true);
      await applyNotificationPolicyChange({
        receipt: fresh,
        getHost: () => ({ client, connectionStatus: "online" }),
        apply: async () => {
          writes.push("fresh-policy");
        },
      });
      expect(writes).toEqual(["fresh-policy"]);
      expect(isCurrentNotificationPolicy(receipt, { client, connectionStatus: "online" })).toBe(
        false,
      );
    } finally {
      release();
    }
  });
  it("cannot use a callback after its owning subscription released", () => {
    const client = new PolicyClient(),
      observer = createNotificationPolicyObserver(client);
    const release = observer.subscribe(() => {});
    const receipt = observer.capture();
    release();
    expect(isCurrentNotificationPolicy(receipt, { client, connectionStatus: "online" })).toBe(
      false,
    );
  });
});
