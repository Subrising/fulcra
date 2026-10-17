export const PROVIDERS: readonly ["claude", "codex"];
export const POLICIES: readonly ["priority", "spread"];
export interface Account {
  dailyLimitUsd?: number | null;
  keyEpoch?: string;
  localRevoked?: boolean;
  credentialKind?: "api-key" | "subscription";
  budget?: { limitUsd: number | null; startAt: string };
  id: string;
  provider: "claude" | "codex";
  name: string;
  enabled: boolean;
  priority: number;
  auth: "ok" | "expired" | "signing-in";
  revoked?: { at: string; reason: string };
  limitedUntil: string | null;
  limitKind?: string | null;
  limitObservedAt?: string | null;
  remoteLimits?: {
    accountId: string;
    limitKind: "session" | "weekly";
    resetAt: string;
    observedAt: string;
    source: string;
  }[];
  usageObservedAt?: string | null;
  limitNote: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}
export interface AccountState {
  v: 1;
  policy: "priority" | "spread";
  rotateOnLimit: boolean;
  accounts: Account[];
  assignments: Record<string, { accountId: string; provider: string; at: string; ended: boolean }>;
  rotations: any[];
  defaults: Record<"claude" | "codex", string | null>;
}
export function accountsDir(root: string): string;
export function readAccounts(root: string): AccountState;
export function readAccountsAsync(root: string): Promise<AccountState>;
export function update<T>(root: string, fn: (s: AccountState) => T | Promise<T>): Promise<T>;
export function withStoreLock<T>(root: string, fn: () => T | Promise<T>): Promise<T>;
export function accountLimit(
  a: Account,
  now?: number,
): { until: string; kind: string | null; source: string } | null;
export type AccountStatus =
  | { state: "ok" }
  | { state: "disabled" }
  | { state: "auth-expired" }
  | { state: "signing-in" }
  | { state: "revoked"; reason: string }
  | { state: "limited"; until: string; source?: string };
export function accountStatus(a: Account, now?: number): AccountStatus;
export const WEEKLY_LAUNCH_CAP_PCT: number;
export function readUsage(root: string, now?: number): Record<string, number>;
export function readUsageAsync(root: string, now?: number): Promise<Record<string, number>>;
export function choose(
  s: AccountState,
  provider: string,
  now?: number,
  except?: string[],
  usage?: Record<string, number>,
): Account | null;
export function earliestReset(s: AccountState, provider: string, now?: number): string | null;
export function addAccount(
  root: string,
  a: { provider: string; name: string; priority?: number },
  now?: number,
): Promise<Account>;
export function setAccount(
  root: string,
  id: string,
  patch: Record<string, unknown>,
  expectedEpoch?: string | null,
): Promise<Account>;
export function moveAccount(root: string, id: string, direction: "up" | "down"): Promise<Account>;
export function removeAccount(root: string, id: string): Promise<Account>;
export function setPolicy(root: string, policy: string): Promise<string>;
export function setRotateOnLimit(root: string, value: boolean): Promise<boolean>;
export function assign(
  root: string,
  sessionId: string,
  provider: string,
  now?: number,
): Promise<any>;
export function sessionEnded(root: string, sessionId: string): Promise<null>;
export function rotate(
  root: string,
  sessionId: string,
  provider: string,
  o?: {
    resetAt?: string | null;
    note?: string | null;
    stopId?: string | null;
    accountId?: string | null;
    stoppedAt?: string | null;
    confirmLimit?: (input: {
      root: string;
      accountId: string;
      now: () => number;
    }) => Promise<{ accountId: string; resetAt: string | null; kind: string } | null>;
    reassign?: boolean;
    kind?: string | null;
  },
  now?: number,
): Promise<any>;
export function markAccountRevoked(
  root: string,
  accountId: string,
  opts?: { note?: string | null },
  now?: number,
): Promise<{ id: string; name: string; fresh: boolean } | null>;
export function markAccountLimited(
  root: string,
  accountId: string,
  o?: { resetAt?: string | null; kind?: string | null; note?: string | null },
  now?: number,
): Promise<{
  id: string;
  name: string;
  limitedUntil: string | null;
  limitKind: string | null;
} | null>;
export function rotationFor(root: string, stopId: string): any;
export function publicView(s: AccountState, now?: number): any;
export function accountOf(
  s: AccountState,
  sessionId: string,
): { id: string; name: string; provider: string } | null;
export function createWindowsKeychain(o?: {
  dir?: string;
  powershell?: string;
  runner?: (bin: string, args: string[], input?: string) => Promise<string>;
}): {
  put(id: string, secret: string): Promise<void>;
  get(id: string): Promise<string | null>;
  remove(id: string): Promise<void>;
};
export function windowsKeychainDir(env?: NodeJS.ProcessEnv): string;
export function createKeychain(o?: {
  keychain?: string | null;
  security?: string;
  platform?: string;
}): {
  put(id: string, secret: string): Promise<void>;
  get(id: string): Promise<string | null>;
  remove(id: string): Promise<void>;
};
export function codexBase(env?: NodeJS.ProcessEnv): string;
export function codexHome(root: string, id: string): string;
export function prepareCodexHome(root: string, id: string, base?: string): string;
export function codexLogin(
  root: string,
  id: string,
  o?: { codex?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<string>;
export function codexSignedIn(root: string, id: string): boolean;
export function sessionOpenHook(o: {
  root: () => string;
  keychain?: any;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  onAllLimited?: (x: any) => void;
}): (input: { request: any }) => Promise<any>;
export function setDefaultAccount(
  root: string,
  provider: string,
  id: string | null,
): Promise<string | null>;
export interface SessionAccounts {
  provider: "claude" | "codex" | null;
  current: string | null;
  accounts: {
    id: string;
    name: string;
    status: AccountStatus;
    isDefault: boolean;
  }[];
}
export function sessionAccounts(
  s: AccountState,
  sessionId: string,
  provider: string,
  now?: number,
): SessionAccounts;
export type TakeOver = (
  sessionId: string,
  account: { id: string; name: string; provider: string },
  o?: { reason: "manual" },
) => Promise<{ ok: boolean; message?: string | null } | null | undefined>;
export function controllerTakeOver(
  call: (method: string, input?: unknown) => Promise<any>,
): TakeOver;
export function switchSession(
  root: string,
  input: { sessionId: string; provider: string; account: string },
  o?: { takeOver?: TakeOver | null },
  now?: number,
): Promise<{ ok: boolean; message: string | null; moved?: "takeover" | "switch" }>;

export function isApiAccount(a: Account): boolean;
export function credentialKind(token: string): "api-key" | "subscription";
export function accountBudget(a: Account): { limitUsd: number | null; startAt: string } | null;
export function confirmAccountLimit(input: {
  root: string;
  accountId: string;
  now?: () => number;
  keychain?: { get(id: string): Promise<string | null> };
  spawnClaude?: (options: any) => Promise<any>;
}): Promise<
  | { accountId: string; limited: false }
  | { accountId: string; resetAt: string | null; kind: string }
  | null
>;

export function publicAccountText(value: unknown, fallback: string): string;
export function launchEnv(
  provider: string,
  account: { id: string; keyEpoch?: string },
  options: { token: string; root: string; session?: string | null; env?: NodeJS.ProcessEnv },
): Record<string, string>;

export function withCredentialLock<T>(
  root: string,
  id: string,
  fn: () => Promise<T>,
  options?: { recoverStale?: boolean },
): Promise<T>;
export function revokeLocalAccount(root: string, id: string, now?: number): Promise<Account>;
export function waitForApiRuntimes(
  root: string,
  accountId: string,
  timeoutMs?: number,
): Promise<void>;
