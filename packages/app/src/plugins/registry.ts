// FULCRA(trusted-bundle): configured routing preserves verified bundle/principal/lifetime admission.
import { LEGACY_CONTROLLER_PLUGIN_ID } from "@getpaseo/protocol/bundled-controller";
import { isPluginBundleTrusted, PLUGIN_TRUST_EXPLANATION } from "./bundle-trust";
import { useMemo, useSyncExternalStore } from "react";
import { QueryClient } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { assertPluginCompatibility } from "@getpaseo/protocol/plugin-requirements";
import { resolveAppVersion } from "@/utils/app-version";
import { createPluginClientRuntime } from "./client-runtime";
import { runPluginClientBundle, type PluginClientRuntime } from "./evaluate";
import type { InstalledPlugin, UntrustedPlugin } from "./types";
import { PluginReconnectState } from "./reconnect-state";
import { IntercomSettingsSection } from "@/screens/settings/intercom-section";

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

  getEvaluationError(serverId: string, pluginId: string): string | undefined {
    return this.evaluationErrors.get(`${serverId}/${pluginId}`);
  }

  installCatalog(
    serverId: string,
    catalog: CatalogPlugin[],
    options: {
      replacePluginId?: string;
      client: DaemonClient;
      trustedPlugins?: TrustedCatalogPlugins;
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
      const prior = previous.find((plugin) => plugin.id === entry.id) ?? previousUntrusted.get(key);
      // Keep only safe presentation fields from previously verified contributions. Never inspect/eval refused code.
      const sidebarItems = prior?.sidebarItems.map(({ id, title, icon, surface }) => ({
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
                id: entry.id === LEGACY_CONTROLLER_PLUGIN_ID ? "organization" : "untrusted",
                title: entry.id === LEGACY_CONTROLLER_PLUGIN_ID ? "Command Centre" : entry.id,
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
      let runtime: PluginClientRuntime | undefined;
      let lifetime: AbortController | undefined;
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
        lifetime = new AbortController();
        const installation: InstalledPlugin = {
          lifetime,
          id: entry.id,
          serverId,
          clientBundle: entry.clientBundle,
          requirements: entry.requirements,
          queryClient: new QueryClient(),
          cleanup: () => undefined,
          surfaces: [],
          settingsScreens: [],
          sidebarItems: [],
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
        runtime = this.dependencies.createRuntime(installation, options.client);
        const evaluated = runPluginClientBundle(entry.id, entry.clientBundle, runtime, () =>
          this.publish(),
        );
        Object.assign(installation, evaluated);
        // App-owned screen uses this already verified host/plugin RPC boundary; it grants no owner rights.
        if (
          entry.id === LEGACY_CONTROLLER_PLUGIN_ID &&
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
        const paseo = runtime.paseo;
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
        lifetime?.abort();
        void runtime?.paseo
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
