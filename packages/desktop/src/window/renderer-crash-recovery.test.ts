import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import {
  logChildProcessGone,
  setupRendererCrashRecovery,
  shouldReloadRenderer,
} from "./renderer-crash-recovery";

function fakeWindow() {
  const webContents = Object.assign(new EventEmitter(), { reload: vi.fn() });
  return { webContents, isDestroyed: () => false } as never as Parameters<
    typeof setupRendererCrashRecovery
  >[0] & { webContents: EventEmitter & { reload: ReturnType<typeof vi.fn> } };
}

const logger = () => ({ error: vi.fn(), warn: vi.fn() });

describe("renderer-crash-recovery", () => {
  it("does not reload for a clean exit", () => {
    expect(shouldReloadRenderer({ reason: "clean-exit", recentReloads: 0 })).toBe(false);
    expect(shouldReloadRenderer({ reason: "crashed", recentReloads: 0 })).toBe(true);
    expect(shouldReloadRenderer({ reason: "oom", recentReloads: 3 })).toBe(false);
  });

  it("logs the reason and reloads the window after a crash", () => {
    const win = fakeWindow();
    const log = logger();
    setupRendererCrashRecovery(win, { logger: log });
    win.webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 5 });
    expect(log.error).toHaveBeenCalledWith("[renderer] process gone", {
      reason: "crashed",
      exitCode: 5,
      willReload: true,
    });
    expect(win.webContents.reload).toHaveBeenCalledTimes(1);
  });

  it("stops reloading after three crashes in one minute and resumes later", () => {
    const win = fakeWindow();
    let time = 0;
    setupRendererCrashRecovery(win, { logger: logger(), now: () => time });
    for (let index = 0; index < 5; index += 1) {
      win.webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
    }
    expect(win.webContents.reload).toHaveBeenCalledTimes(3);
    time = 61_000;
    win.webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
    expect(win.webContents.reload).toHaveBeenCalledTimes(4);
  });

  it("logs a failed child process but not a clean exit", () => {
    const log = logger();
    logChildProcessGone(log, { type: "GPU", reason: "clean-exit", exitCode: 0 });
    expect(log.error).not.toHaveBeenCalled();
    logChildProcessGone(log, { type: "GPU", reason: "crashed", exitCode: 9 });
    expect(log.error).toHaveBeenCalledWith("[child-process] gone", {
      type: "GPU",
      name: null,
      reason: "crashed",
      exitCode: 9,
    });
  });
});
