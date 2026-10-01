import { expect, test, vi } from "vitest";
import { checkedTransport } from "./checked-transport";
test("IR-2/13a starting or missing auth never opens an identity-less anonymous socket", async () => {
  const base = vi.fn(),
    close = vi.fn();
  const transport = checkedTransport(base, async () => {
    throw Error("Authentication unavailable; Retry");
  })({ url: "ws://127.0.0.1:1234/ws" });
  transport.onClose(close);
  await vi.waitFor(() =>
    expect(close).toHaveBeenCalledWith({ code: 4401, reason: "Authentication unavailable; Retry" }),
  );
  expect(base).not.toHaveBeenCalled();
});
