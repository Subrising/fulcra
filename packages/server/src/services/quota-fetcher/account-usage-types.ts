// update-7c: per-account usage. The shared interface between the registry (cache + scheduler) and the per-provider
// readers (Claude: rate-limit events, then a header probe; Codex: its rate-limit events / account endpoint per
// CODEX_HOME). Everything here is daemon-internal EXCEPT `AccountUsageRow`, the only shape a client ever receives:
// name, figures, resets and status. No token, digest or path appears in a row, an error or a log line.

export type AccountProvider = "claude" | "codex";

/** How a reading was obtained. Events are free (a running session's own traffic); a probe costs one tiny request. */
export type AccountUsageSource = "session" | "probe" | "api";

/** The two windows the rundown shows. A reader leaves a window out when it has no figure for it. */
export type AccountUsageWindowId = "five_hour" | "weekly";

export interface AccountUsageWindow {
  id: AccountUsageWindowId;
  /** Percent used, 0..100. */
  usedPct: number;
  /** Epoch ms of the window's reset, when the provider said. */
  resetsAtMs: number | null;
}

/** allowed: under the limit; warning: past the provider's warning threshold; limited: rejected until a reset. */
export type AccountUsageState = "allowed" | "warning" | "limited";

/** One observation of an account's usage, from any source. */
export interface AccountUsageReading {
  windows: AccountUsageWindow[];
  state: AccountUsageState;
  observedAtMs: number;
  source: AccountUsageSource;
}

/**
 * The credential to read one account with. Daemon-side only: it is hashed for the cache key and handed to a reader,
 * never serialised. `token`: a Claude setup-token / OAuth token. `codexHome`: a pooled CODEX_HOME directory.
 */
export type AccountCredential =
  | { kind: "token"; token: string }
  | { kind: "codexHome"; home: string }
  | { kind: "unavailable" };

/** A pooled account as the daemon knows it. `id` is Fulcra's account id (not a secret) when the roster knows it. */
export interface PooledAccount {
  id: string | null;
  provider: AccountProvider;
  /** The pool's display name ("Work"). */
  name: string;
  credential: AccountCredential;
  /** The pool's own view (limited until ...) when the roster has it; the registry never invents one. */
  poolLimitedUntilMs?: number | null;
}

/**
 * A provider's reader. `probe` makes the cheapest authenticated request that returns the figures; it is called only
 * by the registry, which enforces the intervals (see account-usage-registry.ts), so a reader never rate-limits itself.
 * Return null when the account cannot be read (auth refused, no headers): the registry keeps the last reading and
 * marks the account unavailable rather than falling back to another account's figures.
 */
export interface AccountUsageReader {
  readonly provider: AccountProvider;
  probe(account: PooledAccount, signal?: AbortSignal): Promise<AccountUsageReading | null>;
}

/** The pool's accounts, from Fulcra's own store. Absent or unreadable: an empty list (live sessions still count). */
export interface AccountRoster {
  list(): Promise<PooledAccount[]>;
}

/** A running session on a pooled account, with the last reading its own traffic produced (free). */
export interface LiveAccountSession {
  /** Qualified attached resident runtime identity; daemon-only, never sent to readers or clients. */
  agentId?: string;
  runtimeInstanceId?: string;
  account: PooledAccount;
  observation: AccountUsageReading | null;
}

/** Per-account state. `unavailable`: the last read failed and nothing usable is cached; never another account's data. */
export type AccountUsageStatus = "ok" | "limited" | "unavailable";

/** What a client receives for one account. */
export interface AccountUsageRow {
  accountId: string | null;
  name: string;
  provider: AccountProvider;
  status: AccountUsageStatus;
  /** ISO time; null when nothing has ever been read. */
  observedAt: string | null;
  source: AccountUsageSource | null;
  fiveHour: { usedPct: number; resetsAt: string | null } | null;
  weekly: { usedPct: number; resetsAt: string | null } | null;
  /** A session in this chat's daemon is running on this account right now. */
  inUse: boolean;
  /** Attributable idle/running resident sessions in this local manager snapshot; missing means unavailable. */
  sessionCount?: number;
}
