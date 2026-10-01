import path from "node:path";
import { app, safeStorage } from "electron";
import type { DesktopCommandHandler } from "../settings/desktop-settings-commands.js";
import { createRelayIdentityStore, type RelayIdentityStore } from "./relay-identity.js";

let store: RelayIdentityStore | null = null;

function getElectronRelayIdentity(): RelayIdentityStore {
  store ??= createRelayIdentityStore({
    platform: process.platform,
    safeStorage,
    storePath: path.join(app.getPath("userData"), "relay-device-identity.json"),
  });
  return store;
}

// Relay device identity (FC-2): wrapped at rest in this process; the renderer migrates into it.
export function createRelayIdentityCommandHandlers(): Record<string, DesktopCommandHandler> {
  return {
    relay_identity_load: () => getElectronRelayIdentity().load(),
    relay_identity_store: (args) => getElectronRelayIdentity().store(args),
  };
}
