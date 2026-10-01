import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { createDesktopSettingsStore } from "./desktop-settings.js";
import { shouldStopDesktopManagedDaemonOnQuit } from "../daemon/quit-lifecycle.js";

test.each([false, true])(
  "opt-in forces headless and restores prior preference %s",
  async (prior) => {
    const directory = await mkdtemp(path.join(tmpdir(), "cc-settings-"));
    try {
      const store = createDesktopSettingsStore({ userDataPath: directory });
      expect((await store.get()).daemon.commandCentreEnabled).toBe(false);
      await store.patch({ daemon: { keepRunningAfterQuit: prior } });
      const enabled = await store.patch({ daemon: { commandCentreEnabled: true } });
      expect(enabled.daemon.keepRunningAfterQuit).toBe(true);
      expect(enabled.daemon.manageBuiltInDaemon).toBe(true);
      expect(shouldStopDesktopManagedDaemonOnQuit(enabled)).toBe(false);
      await store.patch({ daemon: { keepRunningAfterQuit: !prior } });
      const reloaded = createDesktopSettingsStore({ userDataPath: directory });
      expect((await reloaded.get()).daemon.keepRunningAfterQuit).toBe(true);
      expect(
        (await reloaded.patch({ daemon: { commandCentreEnabled: false } })).daemon
          .keepRunningAfterQuit,
      ).toBe(prior);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("toggle restarts once per change, and a failed restart rolls the setting back", async () => {
  const { createDesktopSettingsCommandHandlers } = await import("./desktop-settings-commands.js");
  const directory = await mkdtemp(path.join(tmpdir(), "cc-settings-command-"));
  try {
    const store = createDesktopSettingsStore({ userDataPath: directory });
    let restarts = 0,
      fail = false;
    const handlers = createDesktopSettingsCommandHandlers({
      settingsStore: store,
      onDaemonSettingsChanged: async () => {
        restarts++;
        if (fail) throw Error("unowned service");
      },
    });
    await handlers.patch_desktop_settings({ daemon: { commandCentreEnabled: true } });
    await handlers.patch_desktop_settings({ daemon: { commandCentreEnabled: true } });
    expect(restarts).toBe(1);
    await handlers.patch_desktop_settings({ daemon: { commandCentreEnabled: false } });
    expect(restarts).toBe(2);
    fail = true;
    await expect(
      handlers.patch_desktop_settings({ daemon: { commandCentreEnabled: true } }),
    ).rejects.toThrow("unowned service");
    expect((await store.get()).daemon).toMatchObject({
      commandCentreEnabled: false,
      keepRunningAfterQuit: false,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
