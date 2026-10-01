import { expect, it, vi } from "vitest";
import { createDaemonChannel, generateKeyPair, type Transport } from "./relay-v3/index.js";

it("never includes pairing credentials in malformed-handshake errors or logs", async () => {
  const secret = "PAIRING_SECRET_SENTINEL_DO_NOT_LOG";
  const messages: unknown[] = [];
  const spies = ["log", "warn", "error", "debug"].map((method) =>
    vi.spyOn(console, method as "log").mockImplementation((...args) => {
      messages.push(args);
    }),
  );
  try {
    const transport: Transport = {
      send: () => {},
      close: () => {},
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    const result = createDaemonChannel(transport, generateKeyPair()).catch((error: Error) => error);
    transport.onmessage!({ data: `{"secret":"${secret}"`, isBinary: false });
    const error = await result;
    expect(error).toBeInstanceOf(Error);
    messages.push(String(error));
    expect(JSON.stringify(messages)).not.toContain(secret);
  } finally {
    spies.forEach((spy) => spy.mockRestore());
  }
});
