import { expect, test, vi } from "vitest";
import type { WebContents, OnBeforeSendHeadersListenerDetails, BeforeSendResponse } from "electron";
import { ownedDaemonHeaders } from "./command-centre-headers.js";
import { commandCentreBearer } from "./command-centre-target.js";
function fixture() {
  const frame = { url: "paseo://app/index.html" };
  const sender = {
    id: 1,
    mainFrame: frame,
    isDestroyed: () => false,
  } as unknown as WebContents;
  const read = vi.fn(async () => "fake-only-secret");
  const resolve = vi.fn(
    async (url: string) =>
      (await commandCentreBearer({
        enabled: true,
        status: {
          desktopManaged: true,
          status: "running",
          serverId: "fixture",
          listen: "127.0.0.1:1234",
        },
        target: { url, serverId: "fixture" },
        read,
      })) ?? undefined,
  );
  const handler = ownedDaemonHeaders(new Set([sender]), resolve);
  const details = {
    url: "ws://127.0.0.1:1234/ws",
    webContents: sender,
    webContentsId: 1,
    frame,
    resourceType: "webSocket",
    requestHeaders: {},
  } as unknown as OnBeforeSendHeadersListenerDetails;
  const run = (patch: Partial<OnBeforeSendHeadersListenerDetails> = {}) =>
    new Promise<BeforeSendResponse>((done) => handler({ ...details, ...patch }, done));
  return { frame, sender, read, resolve, details, run };
}
test("only an owned top-level numeric-loopback handshake gets an unreflected main-only header", async () => {
  const f = fixture();
  expect(await f.run()).toEqual({
    requestHeaders: { Authorization: "Bearer fake-only-secret" },
  });
  expect(f.details.requestHeaders).toEqual({});
  for (const url of [
    "ws://localhost:1234/ws",
    "ws://127.0.0.1:1235/ws",
    "ws://evil.invalid/ws",
    "ws://127.0.0.1:1234/ws?redirect=1",
    "http://127.0.0.1:1234/ws",
  ]) {
    f.read.mockClear();
    expect(await f.run({ url })).toEqual({ requestHeaders: {} });
    expect(f.read).not.toHaveBeenCalled();
  }
});
test("subframes, foreign windows, non-app origins, non-websockets and explicit auth never receive the generated secret", async () => {
  const f = fixture();
  for (const patch of [
    { frame: null },
    { frame: { url: f.frame.url } },
    { webContentsId: 2 },
    { webContents: { ...f.sender, id: 2 } },
    { resourceType: "xhr" },
    { requestHeaders: { authorization: "Bearer provided" } },
    { requestHeaders: { "Sec-WebSocket-Protocol": "paseo.bearer.provided" } },
  ]) {
    await f.run(patch as Partial<OnBeforeSendHeadersListenerDetails>);
    expect(f.resolve).not.toHaveBeenCalled();
  }
  f.frame.url = "https://untrusted.invalid";
  await f.run();
  expect(f.resolve).not.toHaveBeenCalled();
});
test("navigation during credential lookup does not receive a late header", async () => {
  const f = fixture();
  const waiting = f.run();
  f.frame.url = "https://untrusted.invalid";
  expect(await waiting).toEqual({ requestHeaders: {} });
});
test("IR-2 null means owned auth unavailable and cancels before any anonymous probe", async () => {
  const f = fixture();
  const handler = ownedDaemonHeaders(new Set([f.sender]), async () => null);
  const result = await new Promise<BeforeSendResponse>((done) => handler(f.details, done));
  expect(result).toEqual({ cancel: true });
});
