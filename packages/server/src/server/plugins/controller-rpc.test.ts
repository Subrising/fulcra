import { expect, test, vi } from "vitest";
import { createControllerRpcProxy } from "./controller-rpc.js";

test("P8 RPC proxy binds a service session, validates messages and correlates responses", async () => {
  let plugin = "";
  let handshake = false;
  const proxy = await createControllerRpcProxy({
    async attachPluginSocket(pluginId, socket) {
      plugin = pluginId;
      socket.on("message", (data) => {
        const frame = JSON.parse(String(data));
        if (frame.type === "hello") {
          handshake = frame.clientType === "mcp";
          return;
        }
        socket.send(
          JSON.stringify({
            type: "session",
            message: {
              type: "plugin.catalog.get.response",
              payload: { requestId: frame.message.requestId, plugins: [] },
            },
          }),
        );
      });
      return { closed: new Promise<void>(() => {}) };
    },
  });
  expect(plugin).toBe("orca-organization-next");
  expect(handshake).toBe(true);
  const response = await proxy.rpc({
    type: "plugin.catalog.get.request",
    requestId: "request",
  });
  expect(response).toMatchObject({
    type: "plugin.catalog.get.response",
    payload: { plugins: [] },
  });
  expect(() =>
    proxy.rpc({
      type: "plugin.catalog.get.request",
      requestId: "request",
      principal: "owner",
    }),
  ).toThrow();
  await expect(
    proxy.rpc({ type: "close_items_request", requestId: "defaults" }),
  ).resolves.toMatchObject({ payload: { requestId: "defaults" } });
  proxy.close();
  await expect(
    proxy.rpc({ type: "plugin.catalog.get.request", requestId: "request" }),
  ).rejects.toThrow();
});

test.each(["oversized", "deep"])(
  "P8 %s outbound reply settles callback once and rejects pending work",
  async (kind) => {
    const callback = vi.fn();
    const proxy = await createControllerRpcProxy({
      async attachPluginSocket(_id, socket) {
        socket.on("message", (data) => {
          const frame = JSON.parse(String(data));
          if (frame.type !== "session") return;
          let result: unknown = "x".repeat(1024 * 1024);
          if (kind === "deep") {
            result = null;
            for (let i = 0; i < 33; i++) result = { nested: result };
          }
          socket.send(
            JSON.stringify({
              type: "session",
              message: {
                type: "plugin.catalog.get.response",
                payload: { requestId: frame.message.requestId, result },
              },
            }),
            callback,
          );
        });
        return { closed: new Promise<void>(() => {}) };
      },
    });
    await expect(proxy.rpc({ type: "plugin.catalog.get.request", requestId: "r" })).rejects.toThrow(
      "closed",
    );
    expect(callback).toHaveBeenCalledOnce();
    expect(callback.mock.calls[0][0]).toBeInstanceOf(Error);
    proxy.close();
  },
);
