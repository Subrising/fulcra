import { requiresBundledPluginPin } from "./bundle-trust-policy";
import { getDesktopHost } from "@/desktop/host";

export const PLUGIN_NOT_TRUSTED = "Plugin not trusted on this Mac";
export const PLUGIN_TRUST_EXPLANATION =
  PLUGIN_NOT_TRUSTED +
  ". This host’s plugin differs from this Mac’s bundled version, or its pin could not be verified. Update Fulcra on the host Mac and this Mac to the same build. Locally installed plugins must also match a bundled plugin.";
// Tickets belong to immutable catalog snapshots, never host-supplied flags or identities.
const verified = new WeakSet<object>();
export function isPluginBundleTrusted(entry: object): boolean {
  return !requiresBundledPluginPin || verified.has(entry);
}

export async function preparePluginCatalog<T extends { id: string; clientBundle?: string | null }>(
  catalog: T[],
): Promise<T[]> {
  if (!requiresBundledPluginPin) return catalog;
  const desktop = getDesktopHost();
  const entries = catalog.map((entry) => Object.freeze({ ...entry }));
  if (!desktop) return entries;
  try {
    const pins = await desktop.invoke?.("desktop_bundled_plugin_pins");
    if (!pins || typeof pins !== "object" || Array.isArray(pins)) return entries;
    const { digestStringAsync, CryptoDigestAlgorithm } = await import("expo-crypto");
    for (const entry of entries) {
      const pin = Object.hasOwn(pins, entry.id)
        ? (pins as Record<string, unknown>)[entry.id]
        : null;
      if (!entry.clientBundle || typeof pin !== "string" || !/^[a-f0-9]{64}$/.test(pin)) continue;
      const actual = await digestStringAsync(CryptoDigestAlgorithm.SHA256, entry.clientBundle);
      if (actual === pin) verified.add(entry);
    }
  } catch {
    // Missing resources, crypto or IPC must fail closed and leave a visible per-plugin error.
  }
  return entries;
}
