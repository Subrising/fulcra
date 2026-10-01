import { test, expect, vi } from "vitest";
const f = vi.hoisted(() => ({ invoke: vi.fn(), base: vi.fn() }));
vi.mock("@/desktop/host", () => ({
  getDesktopHost: () => ({ invoke: f.invoke }),
}));
vi.mock("@/runtime/websocket-factory", () => ({
  createAppWebSocketFactory: () => null,
}));
vi.mock("@getpaseo/client/internal/daemon-client-websocket-transport", () => ({
  createWebSocketTransportFactory: () => f.base,
}));
import { createDesktopCredentialTransport } from "./command-centre-transport";
test("plugin-visible transport only asks main for a secret-free connection check", async () => {
  f.invoke.mockResolvedValue(true);
  f.base.mockReturnValue({ onMessage() {}, onOpen() {}, onClose() {}, onError() {} });
  const options = { url: "ws://127.0.0.1:1234/ws" };
  createDesktopCredentialTransport("fixture")!(options);
  await vi.waitFor(() => expect(f.base).toHaveBeenCalledWith(options));
  expect(f.invoke).toHaveBeenCalledWith("desktop_daemon_connection_check", { url: options.url });
});

test("IR-13a identity-less probes use the same secret-free preflight", async () => {
  f.base.mockClear();
  f.invoke.mockResolvedValue(true);
  const options = { url: "ws://127.0.0.1:1234/ws" };
  createDesktopCredentialTransport(undefined)!(options);
  await vi.waitFor(() => expect(f.base).toHaveBeenCalledWith(options));
  expect(f.invoke).toHaveBeenLastCalledWith("desktop_daemon_connection_check", {
    url: options.url,
  });
});

test("FC-1 remote and DNS targets never enter owned-daemon preflight", async () => {
  f.invoke.mockReset().mockRejectedValue(Error("Owned desktop daemon changed"));
  f.base.mockReturnValue({ onMessage() {}, onOpen() {}, onClose() {}, onError() {} });
  for (const url of [
    "ws://192.0.2.8:6767/ws",
    "ws://100.90.1.2:6767/ws",
    "wss://host.example/ws",
    "ws://localhost:1234/ws",
  ]) {
    f.base.mockClear();
    const options = { url };
    createDesktopCredentialTransport(undefined)!(options);
    await vi.waitFor(() => expect(f.base).toHaveBeenCalledWith(options));
  }
  expect(f.invoke).not.toHaveBeenCalled();
});
test("FC-1 starting preflight retries without creating an anonymous socket", async () => {
  f.base.mockClear();
  f.invoke.mockResolvedValue({ retry: true });
  const close = vi.fn();
  createDesktopCredentialTransport(undefined)!({ url: "ws://127.0.0.1:1234/ws" }).onClose(close);
  await vi.waitFor(() =>
    expect(close).toHaveBeenCalledWith(expect.objectContaining({ code: 1013 })),
  );
  expect(f.base).not.toHaveBeenCalled();
});
