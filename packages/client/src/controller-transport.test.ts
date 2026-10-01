import { expect, test, vi } from "vitest";
import { createControllerTransport } from "./controller-transport.js";
test("IR-8 a closed SDK transport revokes the owning child once", () => {
  const onClose = vi.fn();
  const adapter = createControllerTransport({
    epoch: "fixture",
    request: async () => null,
    ready() {},
    onClose,
  });
  adapter.transport.close();
  adapter.transport.close();
  expect(onClose).toHaveBeenCalledTimes(1);
});
