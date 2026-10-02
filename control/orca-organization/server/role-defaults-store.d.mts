export const DEFAULT_ROLES: readonly [
  "orchestration",
  "planning",
  "review",
  "implementation",
  "research",
];
export const LEAD_ROLES: readonly ["orchestration", "planning", "review"];
export interface Selection {
  model: string | null;
  thinkingOptionId: string | null;
}
export interface RoleEntry {
  provider: "claude" | "codex" | null;
  claude: Selection;
  codex: Selection;
}
export interface ProviderModes {
  claude: string;
  codex: string;
}
export interface RoleTable {
  roles: Record<(typeof DEFAULT_ROLES)[number], RoleEntry>;
  orchestrationGuard: boolean;
  modes: ProviderModes;
}
export const MODE_CHOICES: Readonly<{ claude: readonly string[]; codex: readonly string[] }>;
export const SEED_MODES: Readonly<ProviderModes>;
export function chosenModes(root: string): Partial<ProviderModes>;
export const SEED: Readonly<Record<string, RoleEntry>>;
export function readRoleDefaults(
  root: string,
  configRoles?: unknown,
  configModes?: unknown,
): RoleTable;
export function writeRoleDefaults(
  root: string,
  patch: {
    role?: string;
    defaults?: Partial<RoleEntry>;
    orchestrationGuard?: boolean;
    mode?: { provider: string; modeId: string };
  },
  configRoles?: unknown,
): Promise<RoleTable>;
export function hookRoles(
  table: RoleTable,
): Record<string, { claude: Selection; codex: Selection }>;
export function configuredRoleProvider(
  root: string,
  configRoles: unknown,
  role: string,
): "claude" | "codex" | null;
