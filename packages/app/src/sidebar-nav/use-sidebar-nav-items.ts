import { useCallback, useMemo } from "react";
import { useAppSettings } from "@/hooks/use-settings";
import type { AppSettings } from "@/hooks/use-settings/storage";
import { useInstalledPlugins, useUntrustedPlugins } from "@/plugins/registry";
import { groupPluginSidebarContributions, groupPluginSidebarItems } from "@/plugins/sidebar-groups";
import {
  moveSidebarNavItem,
  resolveSidebarNavItems,
  setSidebarNavItemVisible,
  type SidebarNavItem,
  type SidebarSection,
} from "./model";

const PREFERENCE_FIELDS = {
  header: "sidebarNavItems",
  footer: "sidebarFooterItems",
} as const satisfies Record<SidebarSection, keyof AppSettings>;

export interface UseSidebarNavItemsReturn<Section extends SidebarSection> {
  /** Every item in the section in display order, hidden ones included. */
  items: SidebarNavItem<Section>[];
  setVisible: (key: string, visible: boolean) => void;
  move: (key: string, direction: "up" | "down") => void;
}

export function useSidebarNavItems<Section extends SidebarSection>(
  section: Section,
): UseSidebarNavItemsReturn<Section> {
  const plugins = useInstalledPlugins();
  const untrusted = useUntrustedPlugins();
  const { settings, updateSettings } = useAppSettings();
  const field = PREFERENCE_FIELDS[section];
  const preferences = settings[field];
  // FULCRA(plugin-host): header rows include a visible entry for each untrusted host plugin.
  const pluginGroups = useMemo(
    () =>
      section === "header"
        ? [
            ...groupPluginSidebarItems(plugins, section).filter((group) => group.kind !== "legacy"),
            ...groupPluginSidebarContributions(plugins, untrusted),
          ]
        : groupPluginSidebarItems(plugins, section),
    [plugins, section, untrusted],
  );

  const items = useMemo(
    () => resolveSidebarNavItems({ section, pluginGroups, preferences }),
    [pluginGroups, preferences, section],
  );

  const setVisible = useCallback(
    (key: string, visible: boolean) => {
      void updateSettings((current) => {
        const previous = current[field];
        const currentItems = resolveSidebarNavItems({
          section,
          pluginGroups,
          preferences: previous,
        });
        return {
          [field]: setSidebarNavItemVisible({ items: currentItems, key, visible, previous }),
        };
      });
    },
    [field, pluginGroups, section, updateSettings],
  );

  const move = useCallback(
    (key: string, direction: "up" | "down") => {
      void updateSettings((current) => {
        const previous = current[field];
        const currentItems = resolveSidebarNavItems({
          section,
          pluginGroups,
          preferences: previous,
        });
        return {
          [field]: moveSidebarNavItem({ items: currentItems, key, direction, previous }),
        };
      });
    },
    [field, pluginGroups, section, updateSettings],
  );

  return { items, setVisible, move };
}
