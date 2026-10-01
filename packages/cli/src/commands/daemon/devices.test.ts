import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ revoke: vi.fn(), connect: vi.fn() }));
vi.mock("@getpaseo/server/pairing", () => ({
  revokeOfflineDevice: mocks.revoke,
  rotateOfflineRelayIdentity: vi.fn(),
}));
vi.mock("@getpaseo/server/daemon-control", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@getpaseo/server/daemon-control")>()),
  readDaemonInstance: vi.fn(),
}));
vi.mock("../../utils/client.js", () => ({ connectToDaemon: mocks.connect }));
import { devicesCommand } from "./devices.js";
it("routes explicit offline revoke to the local registry without opening a socket", async () => {
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    const command = devicesCommand().exitOverride();
    await command.parseAsync(
      ["revoke", "dev_AAAAAAAAAAAAAAAA", "--offline", "--home", "/tmp/fulcra-test-home"],
      { from: "user" },
    );
    expect(mocks.revoke).toHaveBeenCalledWith("/tmp/fulcra-test-home", "dev_AAAAAAAAAAAAAAAA");
    expect(mocks.connect).not.toHaveBeenCalled();
  } finally {
    stdout.mockRestore();
  }
});
