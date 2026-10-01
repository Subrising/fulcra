import type { DesktopSettingsStore } from "./desktop-settings.js";

export type DesktopCommandHandler = (args?: Record<string, unknown>) => unknown;

export function createDesktopSettingsCommandHandlers({
  settingsStore,
  onDaemonSettingsChanged,
}: {
  settingsStore: DesktopSettingsStore;
  onDaemonSettingsChanged?: () => Promise<void>;
}): Record<string, DesktopCommandHandler> {
  let changes: Promise<unknown> = Promise.resolve();
  return {
    get_desktop_settings: () => settingsStore.get(),
    patch_desktop_settings: (args) => {
      const change = changes
        .catch(() => {})
        .then(async () => {
          const before = await settingsStore.get();
          const after = await settingsStore.patch(args);
          if (
            Boolean(before.daemon.commandCentreEnabled) !==
            Boolean(after.daemon.commandCentreEnabled)
          ) {
            try {
              await onDaemonSettingsChanged?.();
            } catch (error) {
              await settingsStore.patch({
                daemon: { commandCentreEnabled: Boolean(before.daemon.commandCentreEnabled) },
              });
              throw error;
            }
          }
          return after;
        });
      changes = change;
      return change;
    },
    migrate_legacy_desktop_settings: (args) => settingsStore.migrateLegacyRendererSettings(args),
  };
}
