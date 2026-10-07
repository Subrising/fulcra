// The Command Centre tabs, in order, from one registry. A tab that is not ready is hidden, never shown as a
// placeholder. Test ids are `organization-tab-<key>`; a tab that replaced an older one also keeps the older id
// (`legacyKey`), so automation written against the old strip still finds it.
export type PillarKey =
  | "today"
  | "organisation"
  | "team"
  | "inbox"
  | "changes"
  | "environments"
  | "sessions"
  | "trackers"
  | "settings";
export interface Pillar {
  key: PillarKey;
  label: string;
  ready: boolean;
  legacyKey: string | null;
}
export const PILLARS: readonly Pillar[] = Object.freeze([
  // The front door: what finished, what needs you, what is running and each project's story. Opens first.
  { key: "today", label: "Home", ready: true, legacyKey: null },
  { key: "organisation", label: "Projects", ready: true, legacyKey: null },
  { key: "team", label: "Team", ready: true, legacyKey: null },
  // J0-8: J3's Inbox (InboxSurface). Its keys match J3's tab, so J3's test ids keep working.
  { key: "inbox", label: "Inbox", ready: true, legacyKey: null },
  { key: "changes", label: "Changes & impact", ready: true, legacyKey: null },
  // Changes lists project pull requests and opens the app-owned Architecture map comparison.
  { key: "environments", label: "Environments", ready: true, legacyKey: null },
  { key: "sessions", label: "Sessions", ready: true, legacyKey: "fleet" },
  { key: "trackers", label: "Trackers", ready: true, legacyKey: null },
  // Not a Command Centre pillar: set-up that is not everyday work (paired devices, chat channels) lives here.
  { key: "settings", label: "Settings", ready: true, legacyKey: null },
]);
// Organisation brings together what were three tabs. Their ids are unchanged. Manage task is a detail sheet
// inside Organisation, opened from any of them; its button keeps the old tab id.
export type OrganisationView = "workmap" | "leadership" | "portfolio";
export const ORGANISATION_VIEWS: readonly { key: OrganisationView; label: string }[] =
  Object.freeze([
    // C1 (orchestrator decision): this view opens J1's organisation, so it says "Organisation"; the id stays "workmap"
    // so saved routes and links keep working. The work map itself is one tap away inside it, on wide screens.
    { key: "workmap", label: "Projects" },
    { key: "leadership", label: "Leadership" },
    { key: "portfolio", label: "Workstreams" },
  ]);
export const MANAGE_TASK_KEY = "task";
// J0-8: Settings holds J3's Devices and Channels views, under their J3 tab ids.
export type SettingsView = "devices" | "channels" | "cleanup" | "accounts";
export const SETTINGS_VIEWS: readonly { key: SettingsView; label: string }[] = Object.freeze([
  { key: "accounts", label: "Accounts & models" },
  { key: "cleanup", label: "Clean-up" }, // update-7 (Clean-up still leads: WL)
  { key: "devices", label: "Devices" },
  { key: "channels", label: "Channels" },
]);
export const readyPillars = (pillars: readonly Pillar[] = PILLARS) =>
  pillars.filter((p) => p.ready);
export const tabTestId = (key: string) => `organization-tab-${key}`;

export const PRIMARY_PILLAR_KEYS: readonly PillarKey[] = [
  "today",
  "organisation",
  "team",
  "changes",
  "settings",
];
// True when the app shows Fulcra's settings pages in its own Settings screen; the tab bar then drops its copy.
let settingsInApp = false;
export const setSettingsInApp = (value: boolean) => {
  settingsInApp = value;
};
const shown = (pillar: Pillar) => !(settingsInApp && pillar.key === "settings");
export const primaryPillars = () =>
  readyPillars().filter((pillar) => shown(pillar) && PRIMARY_PILLAR_KEYS.includes(pillar.key));
export const extraPillars = () =>
  readyPillars().filter((pillar) => shown(pillar) && !PRIMARY_PILLAR_KEYS.includes(pillar.key));
