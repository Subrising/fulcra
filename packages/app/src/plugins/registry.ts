// FULCRA(trusted-bundle): configured routing preserves verified bundle/principal/lifetime admission.
import {
  controllerPluginIdFromTrustedReports,
  LEGACY_CONTROLLER_PLUGIN_ID,
  reportedControllerPluginId,
} from "@getpaseo/protocol/bundled-controller";
import { isPluginBundleTrusted, PLUGIN_TRUST_EXPLANATION } from "./bundle-trust";
import type { AudioEngine } from "@/audio";
import { useMemo, useSyncExternalStore } from "react";
import { QueryClient } from "@tanstack/react-query";
import { createPaseoApi } from "@getpaseo/client";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { assertPluginCompatibility } from "@getpaseo/protocol/plugin-requirements";
import { resolveAppVersion } from "@/utils/app-version";
import { createPluginClientRuntime } from "./client-runtime";
import { runPluginClientBundle } from "./evaluate";
import type { InstalledPlugin, UntrustedPlugin } from "./types";
import { PluginReconnectState } from "./reconnect-state";
import { IntercomSettingsSection } from "@/screens/settings/intercom-section";
import {
  activeConnectionOfClient,
  CommandCentreNeedsDirectConnectionError,
  needsDirectConnection,
} from "./command-centre-connection";

type TrustedCatalogPlugins = Awaited<
  ReturnType<DaemonClient["getPluginCatalog"]>
>["trustedPlugins"];
export type HostInputPolicy = "unknown" | "owner-controls-required" | "standalone";
function catalogInputPolicy(trustedPlugins: TrustedCatalogPlugins): HostInputPolicy {
  if (trustedPlugins === undefined) return "unknown";
  return trustedPlugins.some((plugin) => plugin.hooks.includes("input"))
    ? "owner-controls-required"
    : "standalone";
}

type CatalogPlugin = Awaited<ReturnType<DaemonClient["getPluginCatalog"]>>["plugins"][number];

export class PluginRegistry {
  private readonly reconnectState = new PluginReconnectState();
  private readonly byHost = new Map<string, InstalledPlugin[]>();
  private readonly listeners = new Set<() => void>();
  private snapshot: InstalledPlugin[] = [];
  private readonly untrusted = new Map<string, UntrustedPlugin>();
  private untrustedSnapshot: UntrustedPlugin[] = [];
  private readonly disposed = new WeakSet<InstalledPlugin>();
  private readonly evaluationErrors = new Map<string, string>();
  // Hosts whose catalog question has been answered, however it was answered: loaded, declared
  // unsupported, or asked and failed. Routing needs "we do not know yet" to be distinct from
  // "there is nothing", and it must not stay unknown forever on a host that will never reply.
  private readonly catalogSettled = new Set<string>();
  // Metadata is about a particular live catalog, not an evaluated UI bundle or a host label.
  private readonly hostInputPolicies = new Map<
    string,
    { client: DaemonClient; trustedPlugins: TrustedCatalogPlugins }
  >();

  constructor(
    private readonly dependencies: {
      version: string | null;
      createRuntime: typeof createPluginClientRuntime;
    },
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): InstalledPlugin[] => this.snapshot;
  getUntrustedSnapshot = (): UntrustedPlugin[] => this.untrustedSnapshot;

  isCatalogSettled(serverId: string): boolean {
    return this.catalogSettled.has(serverId);
  }

  markCatalogSettled(serverId: string): void {
    if (this.catalogSettled.has(serverId)) return;
    this.catalogSettled.add(serverId);
    this.publish();
  }

  getHostInputPolicy(serverId: string, client: DaemonClient | null): HostInputPolicy {
    const current = this.hostInputPolicies.get(serverId);
    return client && current?.client === client
      ? catalogInputPolicy(current.trustedPlugins)
      : "unknown";
  }

  clearHostInputPolicy(serverId: string, client: DaemonClient): void {
    if (this.hostInputPolicies.get(serverId)?.client !== client) return;
    this.hostInputPolicies.delete(serverId);
    this.publish();
  }

  /** The bundled controller this host is configured with (legacy ID until its catalog arrives). */
  controllerPluginId(serverId: string): string {
    return controllerPluginIdFromTrustedReports(
      this.hostInputPolicies.get(serverId)?.trustedPlugins,
    );
  }

  /** The controller this host's catalog actually reports; null before its catalog or without one. */
  reportedControllerPluginId(serverId: string): string | null {
    return reportedControllerPluginId(this.hostInputPolicies.get(serverId)?.trustedPlugins);
  }

  /** Whether any connected host is configured with this controller ID (presentation only). */
  isControllerPluginId(pluginId: string): boolean {
    if (pluginId === LEGACY_CONTROLLER_PLUGIN_ID) return true;
    for (const serverId of this.hostInputPolicies.keys())
      if (this.controllerPluginId(serverId) === pluginId) return true;
    return false;
  }

  getEvaluationError(serverId: string, pluginId: string): string | undefined {
    return this.evaluationErrors.get(`${serverId}/${pluginId}`);
  }

  // oxlint-disable-next-line complexity -- FULCRA: upstream body plus the named core patch seams; split on the next upstream merge.
  installCatalog(
    serverId: string,
    catalog: CatalogPlugin[],
    options: {
      replacePluginId?: string;
      client: DaemonClient;
      trustedPlugins?: TrustedCatalogPlugins;
      // FULCRA(plugin-host): optional so a catalog can install where no audio engine is mounted.
      audio?: Pick<AudioEngine, "play">;
    },
  ): boolean {
    this.hostInputPolicies.set(serverId, {
      client: options.client,
      trustedPlugins: options.trustedPlugins,
    });
    const previous = this.byHost.get(serverId) ?? [];
    const previousUntrusted = new Map(this.untrusted);
    for (const [key, item] of this.untrusted)
      if (item.serverId === serverId) this.untrusted.delete(key);
    for (const entry of catalog) {
      if (!entry.clientBundle || isPluginBundleTrusted(entry)) continue;
      const key = `${serverId}/${entry.id}`;
      // FULCRA(plugin-host): a refused bundle is never evaluated; say so, or the plugin just seems missing.
      console.warn(`[Plugins] Bundle not trusted, not evaluated: ${key}`);
      const prior = previous.find((plugin) => plugin.id === entry.id) ?? previousUntrusted.get(key);
      // Keep only safe presentation fields from previously verified contributions. Never inspect/eval refused code.
      const priorItems =
        prior && "untrusted" in prior ? prior.sidebarItems : prior?.legacySidebarItems;
      const sidebarItems = priorItems?.map(({ id, title, icon, surface }) => ({
        id,
        title,
        icon,
        surface,
      }));
      this.untrusted.set(key, {
        id: entry.id,
        serverId,
        untrusted: true,
        sidebarItems: sidebarItems?.length
          ? sidebarItems
          : [
              {
                id: entry.id === this.controllerPluginId(serverId) ? "organization" : "untrusted",
                title: entry.id === this.controllerPluginId(serverId) ? "Command Centre" : entry.id,
                icon: "ShieldAlert",
                surface: "untrusted",
              },
            ],
      });
    }

    const previousTimelineBundles = previous
      .filter((plugin) => plugin.timelineTransformers.length > 0)
      .map((plugin) => `${plugin.id}\0${plugin.clientBundle}`);
    const preserved = catalog.flatMap((entry) => {
      if (!isPluginBundleTrusted(entry)) return [];
      const existing = previous.find(
        (plugin) =>
          plugin.id !== options.replacePluginId &&
          plugin.id === entry.id &&
          plugin.clientBundle === entry.clientBundle &&
          plugin.requirements?.paseo === entry.requirements?.paseo,
      );
      return existing ? [existing] : [];
    });
    const removed = previous.filter((plugin) => !preserved.includes(plugin));
    if (removed.length > 0) {
      this.byHost.set(serverId, preserved);
      this.publish();
      for (const plugin of removed) this.dispose(plugin);
    }
    const installed = catalog.flatMap((entry) => {
      const key = `${serverId}/${entry.id}`;
      let installation: InstalledPlugin | undefined;
      try {
        if (!entry.clientBundle) return [];
        if (!isPluginBundleTrusted(entry)) throw Error(PLUGIN_TRUST_EXPLANATION);
        assertPluginCompatibility({ ...entry, version: this.dependencies.version, runtime: "app" });
        const existing = preserved.find(
          (plugin) => plugin.id === entry.id && plugin.clientBundle === entry.clientBundle,
        );
        if (existing) {
          this.evaluationErrors.delete(key);
          return [existing];
        }
        const client = options.client;
        installation = {
          lifetime: new AbortController(),
          paseo: createPaseoApi(client),
          invoke: (method, input) =>
            // L46: never send a Command Centre read the relay cannot authenticate; say why instead.
            needsDirectConnection(entry.id, activeConnectionOfClient(client), client)
              ? Promise.reject(new CommandCentreNeedsDirectConnectionError())
              : client.invokePluginRpc(entry.id, method, input),
          id: entry.id,
          serverId,
          clientBundle: entry.clientBundle,
          requirements: entry.requirements,
          queryClient: new QueryClient(),
          cleanup: () => undefined,
          surfaces: [],
          settingsScreens: [],
          sidebarItems: { header: [], footer: [] },
          legacySidebarItems: [],
          workspacePanels: [],
          commandCenterItems: [],
          clientSlashCommands: [],
          attachmentSources: [],
          themes: [],
          timelineTransformers: [],
          timelineRenderers: [],
        };
        if (entry.id !== options.replacePluginId) {
          this.reconnectState.restore(
            serverId,
            entry.id,
            entry.clientBundle,
            entry.requirements?.paseo,
            installation.queryClient,
          );
        }
        const runtime = this.dependencies.createRuntime(
          installation,
          options.audio ?? SILENT_AUDIO,
        );
        const evaluated = runPluginClientBundle(entry.id, entry.clientBundle, runtime, () =>
          this.publish(),
        );
        Object.assign(installation, evaluated);
        // App-owned screen uses this already verified host/plugin RPC boundary; it grants no owner rights.
        if (
          entry.id === this.controllerPluginId(serverId) &&
          !installation.settingsScreens.some((screen) => screen.id === "intercom")
        ) {
          installation.settingsScreens = [
            ...installation.settingsScreens,
            {
              id: "intercom",
              title: "Intercom",
              icon: "MessagesSquare",
              Component: IntercomSettingsSection,
            },
          ];
        }
        const paseo = installation.paseo;
        installation.cleanup = async () => {
          const results = await Promise.allSettled([paseo.dispose(), evaluated.cleanup()]);
          const failures = results.filter((result) => result.status === "rejected");
          if (failures.length)
            throw new AggregateError(
              failures.map((result) => result.reason),
              "Plugin cleanup failed",
            );
        };
        this.evaluationErrors.delete(key);
        return [installation];
      } catch (error) {
        installation?.lifetime.abort();
        void installation?.paseo
          .dispose()
          .catch((failure) => console.warn(`[Plugins] API cleanup failed for ${key}`, failure));
        this.evaluationErrors.set(key, error instanceof Error ? error.message : String(error));
        console.warn(`[Plugins] Failed to evaluate ${serverId}/${entry.id}`, error);
        return [];
      }
    });
    const configuredIds = new Set(catalog.map((entry) => entry.id));
    for (const key of this.evaluationErrors.keys()) {
      if (key.startsWith(`${serverId}/`) && !configuredIds.has(key.slice(serverId.length + 1))) {
        this.evaluationErrors.delete(key);
      }
    }
    this.reconnectState.removeHost(serverId);
    this.byHost.set(serverId, installed);
    this.catalogSettled.add(serverId);
    this.publish();
    const installedTimelineBundles = installed
      .filter((plugin) => plugin.timelineTransformers.length > 0)
      .map((plugin) => `${plugin.id}\0${plugin.clientBundle}`);
    return (
      previousTimelineBundles.length !== installedTimelineBundles.length ||
      previousTimelineBundles.some((bundle, index) => bundle !== installedTimelineBundles[index])
    );
  }

  suspendHost(serverId: string): void {
    // Disconnected: whatever we knew is torn down and nothing will arrive until reconnect.
    this.catalogSettled.delete(serverId);
    for (const plugin of this.byHost.get(serverId) ?? []) {
      this.reconnectState.save(
        serverId,
        plugin.id,
        plugin.clientBundle,
        plugin.requirements?.paseo,
        plugin.queryClient,
      );
    }
    this.teardownHost(serverId);
  }

  removeHost(serverId: string): void {
    this.reconnectState.removeHost(serverId);
    // Plugins are unsupported here. That is an answer, not a pending one.
    this.catalogSettled.add(serverId);
    this.teardownHost(serverId);
  }

  private teardownHost(serverId: string): void {
    const removedPolicy = this.hostInputPolicies.delete(serverId);
    let removedUntrusted = false;
    for (const [key, item] of this.untrusted)
      if (item.serverId === serverId) {
        this.untrusted.delete(key);
        this.evaluationErrors.delete(key);
        removedUntrusted = true;
      }
    const installed = this.byHost.get(serverId);
    if (!installed) {
      if (removedUntrusted || removedPolicy) this.publish();
      return;
    }
    for (const plugin of installed) this.dispose(plugin);
    for (const key of this.evaluationErrors.keys()) {
      if (key.startsWith(`${serverId}/`)) this.evaluationErrors.delete(key);
    }
    this.byHost.delete(serverId);
    this.publish();
  }

  private dispose(plugin: InstalledPlugin): void {
    if (this.disposed.has(plugin)) return;
    this.disposed.add(plugin);
    plugin.lifetime.abort();
    plugin.queryClient.clear();
    try {
      void Promise.resolve(plugin.cleanup()).catch((error) => {
        console.warn(`[Plugins] Cleanup failed for ${plugin.serverId}/${plugin.id}`, error);
      });
    } catch (error) {
      console.warn(`[Plugins] Cleanup failed for ${plugin.serverId}/${plugin.id}`, error);
    }
  }

  private publish(): void {
    this.untrustedSnapshot = [...this.untrusted.values()];
    this.snapshot = [...this.byHost.values()]
      .flat()
      .sort((left, right) =>
        `${left.serverId}/${left.id}`.localeCompare(`${right.serverId}/${right.id}`),
      );
    for (const listener of this.listeners) listener();
  }
}

const SILENT_AUDIO: Pick<AudioEngine, "play"> = { play: async () => 0 };

export const pluginRegistry = new PluginRegistry({
  version: resolveAppVersion(),
  createRuntime: createPluginClientRuntime,
});

export function useInstalledPlugins(): InstalledPlugin[] {
  return useSyncExternalStore(
    pluginRegistry.subscribe,
    pluginRegistry.getSnapshot,
    pluginRegistry.getSnapshot,
  );
}

export function useHostCatalogSettled(serverId: string): boolean {
  return useSyncExternalStore(
    pluginRegistry.subscribe,
    () => pluginRegistry.isCatalogSettled(serverId),
    () => pluginRegistry.isCatalogSettled(serverId),
  );
}

// Evaluation failures can change without installing a plugin. Subscribe to that
// value explicitly so the compiled surface cannot memoize an imperative lookup.
export function usePluginEvaluationError(serverId: string, pluginId: string): string | undefined {
  return useSyncExternalStore(
    pluginRegistry.subscribe,
    () => pluginRegistry.getEvaluationError(serverId, pluginId),
    () => pluginRegistry.getEvaluationError(serverId, pluginId),
  );
}

export function useInstalledPlugin(serverId: string, pluginId: string): InstalledPlugin | null {
  return (
    useInstalledPlugins().find(
      (plugin) => plugin.serverId === serverId && plugin.id === pluginId,
    ) ?? null
  );
}

/** The installed bundled controller on one host, by that host's configured ID. */
export function useControllerPlugin(serverId: string): InstalledPlugin | null {
  return (
    useInstalledPlugins().find(
      (plugin) =>
        plugin.serverId === serverId && plugin.id === pluginRegistry.controllerPluginId(serverId),
    ) ?? null
  );
}

/** Every host's installed bundled controller, each by its own configured ID. */
export function useControllerInstallations(): InstalledPlugin[] {
  const installed = useInstalledPlugins();
  return useMemo(
    () =>
      installed.filter(
        (plugin) => plugin.id === pluginRegistry.controllerPluginId(plugin.serverId),
      ),
    [installed],
  );
}

export function usePluginInstallations(pluginId: string): InstalledPlugin[] {
  const installed = useInstalledPlugins();
  return useMemo(() => installed.filter((plugin) => plugin.id === pluginId), [installed, pluginId]);
}

export function useUntrustedPlugins(): UntrustedPlugin[] {
  return useSyncExternalStore(
    pluginRegistry.subscribe,
    pluginRegistry.getUntrustedSnapshot,
    pluginRegistry.getUntrustedSnapshot,
  );
}

export function useHostInputPolicy(serverId: string, client: DaemonClient | null): HostInputPolicy {
  return useSyncExternalStore(
    pluginRegistry.subscribe,
    () => pluginRegistry.getHostInputPolicy(serverId, client),
    () => pluginRegistry.getHostInputPolicy(serverId, client),
  );
}
