import { beforeEach, expect, test, vi } from "vitest";
const f = vi.hoisted(() => ({ invoke: vi.fn(), base: vi.fn(), desktop: true }));
vi.mock("@/desktop/host", () => ({
  getDesktopHost: () => (f.desktop ? { invoke: f.invoke } : null),
}));
vi.mock("@/desktop/electron/invoke", () => ({
  invokeDesktopCommand: f.invoke,
}));
vi.mock("@getpaseo/client/internal/daemon-client-websocket-transport", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@getpaseo/client/internal/daemon-client-websocket-transport")
  >()),
  createWebSocketTransportFactory: () => f.base,
}));
import { buildClientConfig } from "./test-daemon-connection";
const deps = {
  getClientId: async () => "fixture",
  resolveAppVersion: () => null,
  createDesktopTransportFactory: () => null,
  buildDesktopTransportUrl: () => "unused",
};
const connection = {
  id: "local",
  type: "directTcp" as const,
  endpoint: "127.0.0.1:65508",
};
beforeEach(() => {
  f.desktop = true;
  f.invoke.mockReset().mockResolvedValue(true);
  f.base.mockReset().mockReturnValue({
    send: vi.fn(),
    close: vi.fn(),
    onMessage: () => () => {},
    onOpen: () => () => {},
    onClose: () => () => {},
    onError: () => () => {},
  });
});
test.each([undefined, "fixture-server", "other-server"])(
  "identity %s uses a secret-free preflight before opening the probe socket",
  async (serverId) => {
    let allow!: (value: boolean) => void;
    f.invoke.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          allow = resolve;
        }),
    );
    const config = await buildClientConfig(connection, serverId, undefined, deps);
    expect(config.transportFactory).toBeTypeOf("function");
    expect(config.password).toBeUndefined();
    const options = { url: config.url };
    const transport = config.transportFactory!(options);
    try {
      expect(f.invoke).toHaveBeenCalledExactlyOnceWith("desktop_daemon_connection_check", options);
      expect(f.base).not.toHaveBeenCalled();
      allow(true);
      await vi.waitFor(() => expect(f.base).toHaveBeenCalledExactlyOnceWith(options));
      // Neither a credential getter nor password/header/subprotocol material crosses this boundary.
      expect(f.invoke.mock.calls.map(([command]) => command)).toEqual([
        "desktop_daemon_connection_check",
      ]);
      expect(Object.keys(f.base.mock.calls[0][0])).toEqual(["url"]);
      expect(config.password).toBeUndefined();
    } finally {
      transport.close();
    }
  },
);
test("explicit password and non-desktop probes do not use the generated-credential preflight", async () => {
  const explicit = await buildClientConfig(
    connection,
    "fixture-server",
    { password: "provided" },
    deps,
  );
  f.desktop = false;
  const web = await buildClientConfig(connection, undefined, undefined, deps);
  expect(explicit.transportFactory).toBeUndefined();
  expect(explicit.password).toBe("provided");
  expect(web.transportFactory).toBeUndefined();
  expect(web.password).toBeUndefined();
  expect(f.invoke).not.toHaveBeenCalled();
  expect(f.base).not.toHaveBeenCalled();
});
test.each([null, "fake-secret"])(
  "an identity-less probe refuses a non-boolean preflight response: %s",
  async (response) => {
    f.invoke.mockResolvedValue(response);
    const config = await buildClientConfig(connection, undefined, undefined, deps);
    const transport = config.transportFactory!({ url: config.url });
    const closed = vi.fn();
    transport.onClose(closed);
    try {
      await vi.waitFor(() =>
        expect(closed).toHaveBeenCalledWith({
          code: 4401,
          reason: expect.stringContaining("authentication unavailable"),
        }),
      );
      expect(f.invoke).toHaveBeenCalledExactlyOnceWith("desktop_daemon_connection_check", {
        url: config.url,
      });
      expect(f.base).not.toHaveBeenCalled();
      expect(config.password).toBeUndefined();
      expect(JSON.stringify(closed.mock.calls)).not.toContain("fake-secret");
    } finally {
      transport.close();
    }
  },
);
