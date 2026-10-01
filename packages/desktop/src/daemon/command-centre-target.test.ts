import { expect, test, vi } from "vitest";
import { commandCentreBearer } from "./command-centre-target.js";
test("Keychain lookup is limited to the enabled, current desktop-owned local endpoint", async () => {
  const read = vi.fn(async () => "fixture-secret");
  const status = {
    desktopManaged: true,
    status: "running",
    serverId: "fixture",
    listen: "127.0.0.1:16767",
  };
  const target = { serverId: "fixture", url: "ws://127.0.0.1:16767/ws" };
  expect(await commandCentreBearer({ enabled: true, status, target, read })).toBe("fixture-secret");
  read.mockClear();
  for (const bad of [
    { enabled: false, status, target },
    { enabled: true, status, target: { ...target, serverId: "other" } },
    {
      enabled: true,
      status,
      target: { ...target, url: "ws://example.invalid/ws" },
    },
    {
      enabled: true,
      status,
      target: { ...target, url: target.url + "?redirect=1" },
    },
    { enabled: true, status: { ...status, desktopManaged: false }, target },
    { enabled: true, status: { ...status, status: "stopped" }, target },
  ])
    expect(await commandCentreBearer({ ...bad, read })).toBeNull();
  expect(read).not.toHaveBeenCalled();
});

test("DNS localhost is never a credential destination", async () => {
  const read = vi.fn(async () => "secret");
  expect(
    await commandCentreBearer({
      enabled: true,
      status: {
        desktopManaged: true,
        status: "running",
        serverId: "s",
        listen: "localhost:1234",
      },
      target: { serverId: "s", url: "ws://localhost:1234/ws" },
      read,
    }),
  ).toBeNull();
  expect(read).not.toHaveBeenCalled();
});
