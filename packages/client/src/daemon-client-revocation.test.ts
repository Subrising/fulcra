import { expect, it, vi } from "vitest";
import { DaemonClient, type DaemonTransport } from "./daemon-client.js";

function expectedPairingRequired(trusted: boolean, code: number, wasConnected: boolean) {
  if (!trusted) return null;
  return code === 4403 && wasConnected ? "device-removed" : "pairing-upgraded";
}

// Test client state independently; channel/transport tests prove this marker's provenance.
vi.mock("./daemon-client-relay-e2ee-transport.js", () => ({
  createRelayE2eeTransportFactory: (args: { baseFactory: unknown }) => args.baseFactory,
}));

for (const wasConnected of [false, true]) {
  for (const code of [4403, 4426]) {
    it.each([false, true])(
      `close ${code}, connected=${wasConnected}, trusted=%s follows the re-pair contract`,
      async (trusted) => {
        vi.useFakeTimers();
        let closed: ((event?: unknown) => void) | undefined;
        let opened: (() => void) | undefined;
        let message: ((data: unknown, isBinary: boolean) => void) | undefined;
        const transport: DaemonTransport = {
          send: () => {},
          close: () => {},
          onError: () => () => {},
          onOpen: (handler) => {
            opened = handler;
            return () => {};
          },
          onMessage: (handler) => {
            message = handler;
            return () => {};
          },
          onClose: (handler) => {
            closed = handler;
            return () => {};
          },
        };
        const factory = vi.fn(() => transport);
        const client = new DaemonClient({
          url: "ws://test",
          clientId: "terminal-status-test",
          e2ee: { enabled: true, daemonPublicKeyB64: "A".repeat(43) + "=" },
          transportFactory: factory,
          reconnect: { enabled: true, baseDelayMs: 10, maxDelayMs: 10 },
        });
        const reconnect = vi.spyOn(client, "setReconnectEnabled");
        const connecting = client.connect().catch(() => {});
        try {
          expect(closed).toBeDefined();
          if (wasConnected) {
            opened!();
            message!(
              JSON.stringify({
                type: "session",
                message: {
                  type: "status",
                  payload: {
                    status: "server_info",
                    serverId: "srv_fixture",
                    hostname: "Fixture Mac",
                    version: null,
                    features: { ownedSubscriptions: true },
                  },
                },
              }),
              false,
            );
            await connecting;
            expect(client.isConnected).toBe(true);
          } else {
            expect(client.getConnectionState().status).toBe("connecting");
          }
          closed!({
            code,
            reason: code === 4426 ? "Update Fulcra to pair" : "Device unpaired",
            trusted,
          });
          const expected = expectedPairingRequired(trusted, code, wasConnected);
          expect(client.pairingRequired).toBe(expected);
          if (trusted) {
            expect(reconnect).toHaveBeenCalledWith(false);
            expect(client.lastError).toBe(
              expected === "device-removed"
                ? "This device was removed. Pair it again from this Mac."
                : "Fulcra's pairing changed. Pair this device with this Mac again.",
            );
            expect(client.lastError).not.toContain("Update Fulcra");
          } else {
            expect(reconnect).not.toHaveBeenCalledWith(false);
          }
          await vi.advanceTimersByTimeAsync(100);
          if (trusted) expect(factory).toHaveBeenCalledTimes(1);
          else expect(factory.mock.calls.length).toBeGreaterThan(1);
        } finally {
          await client.close();
          vi.useRealTimers();
        }
      },
    );
  }
}
