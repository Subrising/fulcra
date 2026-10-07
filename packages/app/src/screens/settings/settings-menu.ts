import type { HostSectionSlug, SettingsSectionSlug } from "@/utils/host-routes";

// Settings is one menu: a few everyday entries, then a single collapsed "Advanced" area grouped
// by subject. The copy lives in `settings.menu` so every entry has a one-line plain description.

export type AdvancedGroupId = "chats" | "tools" | "team" | "computer" | "help";

export const ADVANCED_GROUP_ORDER: readonly AdvancedGroupId[] = [
  "chats",
  "tools",
  "team",
  "computer",
  "help",
];

/** The screen id a plugin uses for its accounts page; it is pinned to the everyday entries. */
export const ACCOUNTS_PLUGIN_SCREEN_ID = "accounts";

export const EVERYDAY_SECTIONS: readonly SettingsSectionSlug[] = ["general", "notifications"];

export const ADVANCED_SECTIONS: Readonly<Record<AdvancedGroupId, readonly SettingsSectionSlug[]>> =
  {
    chats: ["behaviour", "chat", "sidebar"],
    tools: ["terminal", "browser", "editor", "shortcuts", "integrations"],
    team: ["service"],
    computer: [],
    help: ["permissions", "diagnostics", "about"],
  };

/** Sections still reachable by URL that render as another entry. */
const SECTION_ALIASES: Partial<Record<SettingsSectionSlug, SettingsSectionSlug>> = {
  appearance: "general",
  licenses: "about",
};

export function menuSectionFor(section: SettingsSectionSlug): SettingsSectionSlug {
  return SECTION_ALIASES[section] ?? section;
}

export function isAdvancedSection(section: SettingsSectionSlug): boolean {
  const entry = menuSectionFor(section);
  return ADVANCED_GROUP_ORDER.some((group) => ADVANCED_SECTIONS[group].includes(entry));
}

export interface SettingsMenuLocation {
  kind: "root" | "section" | "host" | "project" | "plugin";
  section?: SettingsSectionSlug | HostSectionSlug;
  screenId?: string;
}

/** Advanced starts open when the current page lives inside it, so the selection is visible. */
export function shouldOpenAdvanced(location: SettingsMenuLocation): boolean {
  if (location.kind === "host" || location.kind === "project") return true;
  if (location.kind === "plugin") return location.screenId !== ACCOUNTS_PLUGIN_SCREEN_ID;
  if (location.kind === "section" && location.section) {
    return isAdvancedSection(location.section as SettingsSectionSlug);
  }
  return false;
}

/** One-line descriptions for the plugin pages Fulcra adds; other plugins show their title only. */
export const PLUGIN_SCREEN_DESCRIPTION_KEYS: Readonly<Record<string, string>> = {
  accounts: "settings.menu.descriptions.accounts",
  integrations: "settings.menu.descriptions.trackers",
  cleanup: "settings.menu.descriptions.cleanup",
  devices: "settings.menu.descriptions.devices",
  channels: "settings.menu.descriptions.channels",
};

export const SECTION_LABEL_KEYS: Readonly<Record<SettingsSectionSlug, string>> = {
  general: "settings.menu.labels.general",
  appearance: "settings.menu.labels.general",
  notifications: "settings.sections.notifications",
  behaviour: "settings.menu.labels.behaviour",
  service: "settings.menu.labels.service",
  chat: "settings.menu.labels.chat",
  sidebar: "settings.sections.sidebar",
  terminal: "settings.sections.terminal",
  browser: "settings.menu.labels.browser",
  editor: "settings.sections.editor",
  shortcuts: "settings.menu.labels.shortcuts",
  integrations: "settings.menu.labels.integrations",
  permissions: "settings.menu.labels.permissions",
  diagnostics: "settings.menu.labels.diagnostics",
  about: "settings.sections.about",
  licenses: "settings.sections.licenses",
};

export const SECTION_DESCRIPTION_KEYS: Readonly<Record<SettingsSectionSlug, string>> = {
  general: "settings.menu.descriptions.general",
  appearance: "settings.menu.descriptions.general",
  notifications: "settings.menu.descriptions.notifications",
  behaviour: "settings.menu.descriptions.behaviour",
  service: "settings.menu.descriptions.service",
  chat: "settings.menu.descriptions.chat",
  sidebar: "settings.menu.descriptions.sidebar",
  terminal: "settings.menu.descriptions.terminal",
  browser: "settings.menu.descriptions.browser",
  editor: "settings.menu.descriptions.editor",
  shortcuts: "settings.menu.descriptions.shortcuts",
  integrations: "settings.menu.descriptions.integrations",
  permissions: "settings.menu.descriptions.permissions",
  diagnostics: "settings.menu.descriptions.diagnostics",
  about: "settings.menu.descriptions.about",
  licenses: "settings.menu.descriptions.licenses",
};

export const HOST_SECTION_LABEL_KEYS: Readonly<Record<HostSectionSlug, string>> = {
  host: "settings.hostSections.host",
  projects: "settings.hostSections.projects",
  connections: "settings.hostSections.connections",
  "pair-device": "settings.menu.labels.pairDevice",
  agents: "settings.menu.labels.agents",
  metadata: "settings.menu.labels.metadata",
  workspaces: "settings.hostSections.workspaces",
  providers: "settings.menu.labels.providers",
  usage: "settings.hostSections.usage",
  terminals: "settings.menu.labels.terminals",
  plugins: "settings.hostSections.plugins",
};

export const HOST_SECTION_DESCRIPTION_KEYS: Readonly<Record<HostSectionSlug, string>> = {
  host: "settings.menu.descriptions.host",
  projects: "settings.menu.descriptions.projects",
  connections: "settings.menu.descriptions.connections",
  "pair-device": "settings.menu.descriptions.pairDevice",
  agents: "settings.menu.descriptions.agents",
  metadata: "settings.menu.descriptions.metadata",
  workspaces: "settings.menu.descriptions.workspaces",
  providers: "settings.menu.descriptions.providers",
  usage: "settings.menu.descriptions.usage",
  terminals: "settings.menu.descriptions.terminals",
  plugins: "settings.menu.descriptions.plugins",
};
