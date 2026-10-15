import { preparePluginCatalog } from "./bundle-trust";
import { useVoiceAudioEngineOptional } from "@/contexts/voice-context";
import { pluginSettingsKey } from "./settings/use-settings";
import { useEffect } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useHostFeatureAvailability } from "@/runtime/host-features";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { pluginRegistry } from "./registry";
import { sha256Hex } from "./catalog-hash";

// FULCRA(plugin-host): one failed catalog read (a slow or dropped network on the phone, a host that is still starting)
// used to leave the host with no plugins until the app restarted: no /account, no home computer. The read is
// tried again by itself, 2 s, 4 s, 8 s ... up to 30 s apart, 6 times in all.
export const CATALOG_READ_RETRIES = 6;
export const catalogRetryDelay = (attempt: number) => Math.min(2000 * 2 ** attempt, 30_000);

export function PluginCatalogSync({
  serverId,
  client,
}: {
  serverId: string;
  client: DaemonClient;
}) {
  const audio = useVoiceAudioEngineOptional();
  const connected = useHostRuntimeIsConnected(serverId);
  const supported = useHostFeatureAvailability(serverId, "plugins");
  const paging = useHostFeatureAvailability(serverId, "pluginCatalogPaging");

  useEffect(() => {
    let cancelled = false;
    let refreshQueue = Promise.resolve();
    let generation = 0;
    let connectionAvailable = connected;
    let reading: AbortController | undefined;
    let failures = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    if (!connected) {
      pluginRegistry.suspendHost(serverId);
      return;
    }
    if (supported === null) {
      // Connected, but the host has not sent its features yet. Removing here would settle the
      // catalog as "this host has no plugins" before the host ever said so.
      pluginRegistry.suspendHost(serverId);
      return;
    }
    // FULCRA(plugin-host): plugins install without an audio engine; playback falls back to silence.
    if (!supported) {
      pluginRegistry.removeHost(serverId);
      return;
    }
    const refresh = (replacePluginId?: string) => {
      clearTimeout(retryTimer);
      const epoch = ++generation;
      pluginRegistry.clearHostInputPolicy(serverId, client);
      reading?.abort();
      refreshQueue = refreshQueue.then(async () => {
        if (cancelled || !connectionAvailable || epoch !== generation) return;
        const abort = new AbortController();
        reading = abort;
        try {
          const catalog =
            paging === true
              ? await client.getPagedPluginCatalog({
                  signal: abort.signal,
                  sha256: async (bytes) => {
                    const { digest, CryptoDigestAlgorithm } = await import("expo-crypto");
                    return sha256Hex(bytes, digest, CryptoDigestAlgorithm.SHA256);
                  },
                })
              : await client.getPluginCatalog();
          if (cancelled || abort.signal.aborted || epoch !== generation) return;
          const plugins = await preparePluginCatalog(catalog.plugins);
          if (!cancelled && !abort.signal.aborted && epoch === generation) {
            pluginRegistry.installCatalog(serverId, plugins, {
              replacePluginId,
              client,
              trustedPlugins: catalog.trustedPlugins,
              audio: audio ?? undefined,
            });
            failures = 0;
          }
        } catch (error) {
          // FULCRA(plugin-host): the failure was silent. Without this line no log shows why a host has no plugins.
          console.warn(
            `[Plugins] Catalog read failed for ${serverId} (attempt ${failures + 1}, ${paging === true ? "paged" : "legacy"})`,
            error,
          );
          if (!cancelled && epoch === generation) {
            // A paging refusal never retries through the legacy catalog or preserves old action surfaces.
            pluginRegistry.suspendHost(serverId);
            pluginRegistry.markCatalogSettled(serverId);
            if (failures < CATALOG_READ_RETRIES) {
              retryTimer = setTimeout(
                () => void refresh(replacePluginId),
                catalogRetryDelay(failures),
              );
              failures++;
            }
          }
        }
        return undefined;
      });
      return refreshQueue;
    };
    const releaseConnection = client.subscribeConnectionStatus((state) => {
      const next = state.status === "connected";
      if (next === connectionAvailable) return;
      connectionAvailable = next;
      if (!next) {
        // React can batch a drop and reconnect into one render. Fence reads immediately.
        generation++;
        clearTimeout(retryTimer);
        reading?.abort();
        pluginRegistry.clearHostInputPolicy(serverId, client);
        pluginRegistry.suspendHost(serverId);
      } else {
        failures = 0;
        void refresh();
      }
    });
    const observation = client.observeEvents([
      "status.plugin_catalog_changed",
      "status.plugin_settings_changed",
    ]);
    observation.subscribe({
      snapshot: () => {
        if (generation === 0) void refresh();
      },
      update: (message) => {
        if (message.type !== "status") return;
        if (message.payload.status === "plugin_settings_changed") {
          const { pluginId, settingsId } = message.payload;
          if (typeof settingsId === "string") {
            const plugin = pluginRegistry
              .getSnapshot()
              .find((item) => item.serverId === serverId && item.id === pluginId);
            void plugin?.queryClient.invalidateQueries({ queryKey: pluginSettingsKey(settingsId) });
          }
        }
        if (message.payload.status === "plugin_catalog_changed") {
          const pluginId = message.payload.pluginId;
          if (typeof pluginId === "string") void refresh(pluginId);
        }
      },
    });
    // An unchanged observation snapshot need not be emitted again after a host restart.
    if (generation === 0) void refresh();
    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
      generation++;
      pluginRegistry.clearHostInputPolicy(serverId, client);
      releaseConnection();
      reading?.abort();
      void observation
        .release()
        .catch((error) => console.warn("[Plugins] Failed to release catalog", error));
    };
  }, [audio, client, connected, serverId, supported, paging]);

  useEffect(() => () => pluginRegistry.removeHost(serverId), [serverId]);
  return null;
}
