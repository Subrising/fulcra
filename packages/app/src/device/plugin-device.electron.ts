import type { PluginDevice } from "@getpaseo/plugin/client";
import { getDesktopHost } from "@/desktop/host";
import { createDesktopDeviceKey } from "./device-key-adapters";

// Desktop: the key lives in the Electron main process; the renderer only relays requests.
export function getPluginDevice(): PluginDevice | undefined {
  const invoke = getDesktopHost()?.invoke;
  if (typeof invoke !== "function") return undefined;
  return createDesktopDeviceKey((command, args) => invoke(command, args));
}
