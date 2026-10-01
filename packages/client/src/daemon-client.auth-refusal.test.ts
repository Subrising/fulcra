import { expect, test, vi } from "vitest";
import { DaemonClient } from "./daemon-client.js";
test("IR-2 4401 is visible and stops automatic retries until explicit Retry", async () => {
  vi.useFakeTimers();
  let onClose: (event: unknown) => void = () => {};
  const transportFactory = vi.fn(() => ({
    send() {},
    close() {},
    onMessage: () => () => {},
    onOpen: () => () => {},
    onError: () => () => {},
    onClose(fn: typeof onClose) {
      onClose = fn;
      return () => {};
    },
  }));
  const client = new DaemonClient({
    url: "ws://fixture.invalid/ws",
    clientId: "fixture",
    transportFactory,
  });
  try {
    const pending = client.connect().catch((e) => e);
    onClose({ code: 4401, reason: "Password required" });
    expect(await pending).toBeInstanceOf(Error);
    expect(client.lastError).toContain("Password required");
    await vi.advanceTimersByTimeAsync(60000);
    expect(transportFactory).toHaveBeenCalledTimes(1);
    client.ensureConnected();
    expect(transportFactory).toHaveBeenCalledTimes(2);
  } finally {
    await client.close();
    vi.useRealTimers();
  }
});
