import path from "node:path";
import { NotificationDigest, type DesktopNotificationPayload } from "./notification-digest.js";
import { existsSync } from "node:fs";
import { BrowserWindow, Notification, ipcMain, nativeImage } from "electron";
import { getDesktopSettingsStore } from "../settings/desktop-settings-electron.js";
import { APP_DISPLAY_NAME } from "../app-display-name.js";

interface NotificationInput {
  title?: unknown;
  body?: unknown;
  data?: unknown;
}

interface NotificationClickPayload {
  data?: Record<string, unknown>;
}

const activeNotifications = new Set<Notification>();

function toTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function getNotificationIcon(): Electron.NativeImage | null {
  const candidates = [
    path.resolve(__dirname, "../assets/icon.png"),
    path.resolve(__dirname, "../assets/64x64.png"),
    path.resolve(__dirname, "../assets/128x128.png"),
  ];

  for (const iconPath of candidates) {
    if (!existsSync(iconPath)) {
      continue;
    }
    const icon = nativeImage.createFromPath(iconPath);
    if (!icon.isEmpty()) {
      return icon;
    }
  }

  return null;
}

function focusSenderWindow(sender: Electron.WebContents): BrowserWindow | null {
  const win = BrowserWindow.fromWebContents(sender) ?? BrowserWindow.getAllWindows()[0] ?? null;
  if (!win || win.isDestroyed()) {
    return null;
  }
  win.show();
  if (win.isMinimized()) {
    win.restore();
  }
  win.focus();
  return win;
}

/**
 * macOS requires a notification to have been shown at least once before
 * the app appears in System Preferences > Notifications. We fire a
 * silent no-op notification during startup to ensure registration.
 */
export function ensureNotificationCenterRegistration(): void {
  if (process.platform !== "darwin" || !Notification.isSupported()) {
    return;
  }

  const probe = new Notification({ title: APP_DISPLAY_NAME, silent: true });
  probe.on("show", () => probe.close());
  setTimeout(() => probe.close(), 2_000);
  probe.show();
}

function showNotification(
  payload: DesktopNotificationPayload,
  { sender, playSound }: { sender: Electron.WebContents; playSound: boolean },
): void {
  if (sender.isDestroyed()) return;
  const icon = getNotificationIcon();
  const notification = new Notification({
    title: payload.title,
    ...(payload.body ? { body: payload.body } : {}),
    ...(icon ? { icon } : {}),
    silent: !playSound,
  });

  activeNotifications.add(notification);

  notification.on("click", () => {
    const win = focusSenderWindow(sender);
    if (win && payload.data && Object.keys(payload.data).length > 0) {
      const clickPayload: NotificationClickPayload = { data: payload.data };
      win.webContents.send("paseo:event:notification-click", clickPayload);
    }
    activeNotifications.delete(notification);
  });

  notification.on("close", () => {
    activeNotifications.delete(notification);
  });

  notification.show();
}

const digest = new NotificationDigest(showNotification);

export function registerNotificationHandlers(): void {
  ipcMain.handle("paseo:notification:isSupported", () => {
    return Notification.isSupported();
  });

  ipcMain.handle("paseo:notification:send", async (event, rawInput?: NotificationInput) => {
    if (!Notification.isSupported()) {
      return false;
    }

    const title = toTrimmedString(rawInput?.title);
    if (!title) {
      return false;
    }

    const body = toTrimmedString(rawInput?.body) ?? undefined;
    const data = toRecord(rawInput?.data);
    const settings = await getDesktopSettingsStore().get();
    digest.send(
      { title, body, data },
      { sender: event.sender, playSound: settings.notifications.playSound },
      settings.notifications.delivery,
      settings.notifications.digestMinutes * 60_000,
    );
    return true;
  });
}
