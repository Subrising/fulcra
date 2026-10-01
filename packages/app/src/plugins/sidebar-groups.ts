import type { InstalledPlugin, PluginSidebarContribution, UntrustedPlugin } from "./types";

export interface PluginSidebarTarget {
  plugin: Pick<InstalledPlugin, "id" | "serverId">;
  untrusted?: boolean;
  item: PluginSidebarContribution;
}

export interface PluginSidebarGroup {
  key: string;
  pluginId: string;
  contributionId: string;
  title: string;
  icon: string;
  targets: PluginSidebarTarget[];
}

export function groupPluginSidebarContributions(
  plugins: InstalledPlugin[],
  untrusted: UntrustedPlugin[] = [],
): PluginSidebarGroup[] {
  const groups = new Map<string, PluginSidebarGroup>();
  for (const plugin of [...plugins, ...untrusted]) {
    for (const item of plugin.sidebarItems) {
      const key = `${plugin.id}/sidebar/${item.id}`;
      const existing = groups.get(key);
      if (existing) {
        existing.targets.push({
          plugin,
          item,
          untrusted: "untrusted" in plugin && plugin.untrusted === true,
        });
      } else {
        groups.set(key, {
          key,
          pluginId: plugin.id,
          contributionId: item.id,
          title: item.title,
          icon: item.icon,
          targets: [
            { plugin, item, untrusted: "untrusted" in plugin && plugin.untrusted === true },
          ],
        });
      }
    }
  }
  return [...groups.values()];
}
