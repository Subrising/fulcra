export type SessionRole = 'planning' | 'orchestration' | 'implementation';
export type RoleSelection = { model?: string; thinkingOptionId?: string; modeId?: string };
export type RoleDefaults = { provider?: 'claude' | 'codex'; claude?: RoleSelection; codex?: RoleSelection };
export const SESSION_ROLES: readonly SessionRole[];
export const KNOWN_SETTINGS: readonly string[];
export const KNOWN_DEFAULTS: readonly string[];
export function unknownSettings(c: unknown): string[];
export type Host = { name: string; serverId: string | null; sshTarget?: string };
export type Config = {
  version: 2;
  daemon: { url: string | null };
  authority: { companyId: string; programmeId: string; issueApi: string | null };
  providers: { claude: string; codex: string };
  localHost: Host; hosts: Host[];
  defaults: { thinkingOptionId?: string; modes?: Record<string, string>; ask?: Record<string, string[]>; models?: Record<string, string>; roles?: Partial<Record<SessionRole, RoleDefaults>> };
  artifacts: Record<string, string[]>;
  worktreeLifecycle?: { retentionDays: number | 'never' };
  outcomesRoot?: string;
  memoryRoot?: string;
};
export type LoadedConfig = Config & { home: string; controller: string; daemonHome: string; memoryRoot: string; outcomesRoot: string; tasks: string; url: string | null };
export class NotConfigured extends Error {}
export function stateRoot(env?: Record<string, string | undefined>): string;
export function firstRun(env?: Record<string, string | undefined>): LoadedConfig;
export function loadConfig(env?: Record<string, string | undefined>): LoadedConfig;
export function validateConfig(c: unknown): Config;
export function privateJson(file: string, limit?: number): any;
export function requiredSetting<T>(value: T | null | undefined, setting: string): T;

export function worktreeLifecycleSettings(env?: Record<string, string | undefined>): { get(): Promise<number | 'never'>; set(value: number | 'never'): Promise<number | 'never'> };
