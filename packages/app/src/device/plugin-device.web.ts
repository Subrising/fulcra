import type { PluginDevice } from "@getpaseo/plugin/client";

// A plain browser has no protected key store, so the web app offers no ctx.device.
export function getPluginDevice(): PluginDevice | undefined {
  return undefined;
}
