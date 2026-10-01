import { expect, test, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@/desktop/electron/invoke", () => ({ invokeDesktopCommand: invoke }));
vi.mock("@/desktop/host", () => ({ getDesktopHost: () => null, isElectronRuntime: () => true }));
vi.mock("@/i18n/i18next", () => ({ i18n: { t: (x: string) => x } }));
vi.mock("@/utils/confirm-dialog", () => ({ confirmDialog: vi.fn() }));
import { getDesktopDaemonStatus, startDesktopDaemon } from "./desktop-daemon";

test("status and startup retain the generated-credential mode without exposing a password", async () => {
  invoke.mockResolvedValue({
    serverId: "fixture",
    status: "running",
    listen: "127.0.0.1:1234",
    usesGeneratedCredential: true,
    password: "must-not-escape",
  });
  for (const read of [getDesktopDaemonStatus, startDesktopDaemon]) {
    const status = await read();
    expect(status.usesGeneratedCredential).toBe(true);
    expect(status).not.toHaveProperty("password");
  }
});
test("only boolean true selects generated credentials; explicit and old hosts stay false", async () => {
  for (const value of [false, undefined, "true", 1]) {
    invoke.mockResolvedValue({ status: "running", usesGeneratedCredential: value });
    expect((await getDesktopDaemonStatus()).usesGeneratedCredential).toBe(false);
  }
});
