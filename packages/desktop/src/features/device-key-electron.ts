import path from "node:path";
import { app, BrowserWindow, dialog, safeStorage, systemPreferences } from "electron";
import { createDesktopDeviceKey, type DesktopDeviceKey } from "./device-key.js";

let deviceKey: DesktopDeviceKey | null = null;

// The Electron bindings for the desktop device key. Touch ID is macOS only; the dialog is modal to
// the focused window so the question appears in front of the user, not behind another app.
export function getElectronDeviceKey(): DesktopDeviceKey {
  deviceKey ??= createDesktopDeviceKey({
    platform: process.platform,
    safeStorage,
    touchId: {
      canPrompt: () => process.platform === "darwin" && systemPreferences.canPromptTouchID(),
      prompt: (reason) => systemPreferences.promptTouchID(reason),
    },
    async confirm(message, detail) {
      const options = {
        type: "question" as const,
        buttons: ["Cancel", "Continue"],
        defaultId: 0,
        cancelId: 0,
        message,
        detail,
      };
      const window = BrowserWindow.getFocusedWindow();
      const result = window
        ? await dialog.showMessageBox(window, options)
        : await dialog.showMessageBox(options);
      return result.response === 1;
    },
    storePath: path.join(app.getPath("userData"), "device-key.json"),
  });
  return deviceKey;
}
