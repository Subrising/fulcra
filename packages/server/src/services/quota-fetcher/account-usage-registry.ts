import {
  sanitizeAccountMetadata as sanitizeMetadata,
  sanitizeAccountReading,
} from "./account-usage-sanitize.js";
import { createHash } from "node:crypto";
import type { Logger } from "pino";
import type {
  AccountProvider,
  AccountRoster,
  AccountUsageReader,
  AccountUsageReading,
  AccountUsageRow,
  AccountUsageStatus,
  LiveAccountSession,
  PooledAccount,
} from "./account-usage-types.js";

// update-7c: the per-account usage cache and scheduler.
//
// Cost control (the owner's requirement 4):
//   - a periodic pass probes an account at most once per PERIODIC_MIN_INTERVAL_MS (10 min);
//   - an on-demand refresh (the refresh button) probes an account at most once per ON_DEMAND_MIN_INTERVAL_MS (60 s);
//   - a live session's own reading (its rate-limit events) refreshes the cache for free and counts as fresh for the
//     periodic pass, so an account in active use is never probed;
//   - every probe ATTEMPT counts, success or not, so a broken account is not hammered;
//   - concurrent refreshes of one account share one probe.
// The cache is keyed by a digest of immutable account ID and credential, in memory only. The digest, the credential and any path stay in
// this class: rows carry the pool's account id (not a secret), the name, figures, resets and status.

export const PERIODIC_MIN_INTERVAL_MS = 10 * 60_000;
export const ON_DEMAND_MIN_INTERVAL_MS = 60_000;
/** How often the timer wakes to look for accounts due a periodic probe. Probes still respect the 10 minute minimum. */
const PERIODIC_TICK_MS = 60_000;

export interface AccountUsageRegistryOptions {
  logger: Logger;
  readers: AccountUsageReader[];
  roster?: AccountRoster;
  /** Running sessions on pooled accounts and the last reading each one's own traffic produced. */
  sessions?: () => LiveAccountSession[];
  now?: () => number;
  /** FULCRA: after each periodic pass, the cached rows (no probe). The account pool reads weekly use from them. */
  onPass?: (rows: AccountUsageRow[]) => void;
}

interface Entry {
  account: Omit<PooledAccount, "credential">;
  reading: AccountUsageReading | null;
  lastAttemptAtMs: number | null;
  inFlight: Promise<void> | null;
  inUse: boolean;
  sessionCount?: number;
  sessionGeneration: number;
  sessionObservedAtMs: number | null;
  sessionReadingKey: string | null;
}

function absorbObservation(entry: Entry, seen: AccountUsageReading): void {
  if (seen.observedAtMs < (entry.sessionObservedAtMs ?? -Infinity)) return;
  const observationKey = JSON.stringify(seen);
  if (observationKey !== entry.sessionReadingKey) {
    entry.sessionGeneration++;
    entry.sessionReadingKey = observationKey;
    entry.sessionObservedAtMs = seen.observedAtMs;
  }
  if (!entry.reading || seen.observedAtMs >= entry.reading.observedAtMs) entry.reading = seen;
}

function countQualifiedSession(
  counts: Map<string, Set<string>>,
  session: LiveAccountSession,
  account: Entry["account"],
) {
  if (
    !account.id ||
    session.account.id !== account.id ||
    !session.agentId ||
    !session.runtimeInstanceId
  )
    return;
  const identity = `${account.provider}:${account.id}`;
  const agents = counts.get(identity) ?? new Set<string>();
  agents.add(session.agentId);
  counts.set(identity, agents);
}

function snapshotCount(
  counts: Map<string, Set<string>>,
  identity: string | null,
  complete: boolean,
): number | undefined {
  if (!complete) return undefined;
  if (!identity) return 0;
  return counts.get(identity)?.size ?? 0;
}

/** Credential rotation/unavailability may leave several observations for one roster ID, but one public row. */
function accountRows(
  entries: Entry[],
  rowFor: (entry: Entry) => AccountUsageRow,
): AccountUsageRow[] {
  const rows = new Map<string, AccountUsageRow>();
  const unidentified: AccountUsageRow[] = [];
  for (const entry of entries) {
    const row = rowFor(entry);
    if (!row.accountId) {
      unidentified.push(row);
      continue;
    }
    const identity = `${row.provider}:${row.accountId}`;
    const first = rows.get(identity);
    if (!first) {
      rows.set(identity, row);
      continue;
    }
    const newer =
      row.observedAt !== null && (first.observedAt === null || row.observedAt > first.observedAt);
    const selected = newer ? row : first;
    // Roster entries are first: retain their name and pool hold while showing the freshest actual reading.
    rows.set(identity, {
      ...selected,
      name: first.name,
      inUse: first.inUse || row.inUse,
      status: first.status === "limited" ? "limited" : selected.status,
    });
  }
  return [...rows.values(), ...unidentified];
}

export function accountCacheKey(account: PooledAccount): string {
  let secret = `unavailable:${account.id}`;
  if (account.credential.kind === "token") secret = account.credential.token;
  else if (account.credential.kind === "codexHome") secret = account.credential.home;
  // Different roster IDs remain distinct even if their provider credential or display name matches.
  return `${account.provider}:${createHash("sha256")
    .update(JSON.stringify([account.id, secret]))
    .digest("hex")}`;
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

export class AccountUsageRegistry {
  private readonly logger: Logger;
  private readonly readers = new Map<AccountProvider, AccountUsageReader>();
  private readonly roster: AccountRoster | undefined;
  private readonly sessions: (() => LiveAccountSession[]) | undefined;
  private readonly now: () => number;
  private readonly onPass: ((rows: AccountUsageRow[]) => void) | undefined;
  private readonly entries = new Map<string, Entry>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: AccountUsageRegistryOptions) {
    this.logger = options.logger.child({ module: "account-usage" });
    for (const reader of options.readers) this.readers.set(reader.provider, reader);
    this.roster = options.roster;
    this.sessions = options.sessions;
    this.now = options.now ?? Date.now;
    this.onPass = options.onPass;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.periodicPass().catch(() => this.logger.warn("Account usage refresh failed"));
    }, PERIODIC_TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Every pooled account (the roster's, plus any a running session is on). `refresh` is the on-demand path: it probes
   * accounts not probed in the last minute. Without it, only an account never read yet is probed.
   */
  async list(options: { refresh: boolean }): Promise<AccountUsageRow[]> {
    const entries = await this.sync();
    await Promise.all(
      entries.map(({ entry, account }) => {
        const cold = entry.reading === null && entry.lastAttemptAtMs === null;
        return options.refresh || cold ? this.refreshEntry(entry, account, "on-demand") : undefined;
      }),
    );
    this.absorbSessions();
    const current = new Set(this.entries.values());
    // Keep roster metadata first, then append accounts attached while probes were awaited.
    const ordered = new Set(
      entries.map(({ entry }) => entry).filter((entry) => current.has(entry)),
    );
    for (const entry of current) ordered.add(entry);
    return accountRows([...ordered], (entry) => this.row(entry));
  }

  /** One account's row (the chat panel), probing only when its cache is cold or `refresh` allows. */
  async rowFor(account: PooledAccount, options: { refresh: boolean }): Promise<AccountUsageRow> {
    const entry = this.upsert(account);
    this.absorbSessions();
    const cold = entry.reading === null && entry.lastAttemptAtMs === null;
    if (options.refresh || cold) await this.refreshEntry(entry, account, "on-demand");
    this.absorbSessions();
    return this.row(entry);
  }

  /** Cached/resident observations only; no roster enumeration, probe, timer, or in-flight wait. */
  observe(): AccountUsageRow[] {
    this.absorbSessions();
    return accountRows([...this.entries.values()], (entry) => this.row(entry));
  }

  observeRowFor(account: PooledAccount): AccountUsageRow {
    const entry = this.upsert(account);
    this.absorbSessions();
    return this.row(entry);
  }

  /** The timer's work: probe each account whose last reading or attempt is older than the periodic minimum. */
  async periodicPass(): Promise<void> {
    const entries = await this.sync();
    await Promise.all(
      entries.map(({ entry, account }) => this.refreshEntry(entry, account, "periodic")),
    );
    this.onPass?.(this.observe());
  }

  private async sync(): Promise<{ entry: Entry; account: PooledAccount }[]> {
    const known = new Map<string, PooledAccount>();
    try {
      for (const account of (await this.roster?.list()) ?? [])
        known.set(accountCacheKey(account), account);
    } catch {
      this.logger.warn("Account roster could not be read");
    }
    const live = this.absorbSessions();
    for (const [key, account] of live) if (!known.has(key)) known.set(key, account);
    for (const key of this.entries.keys()) {
      if (!known.has(key)) this.entries.delete(key);
    }
    return [...known.entries()].map(([, account]) => {
      const entry = this.upsert(account);
      entry.inUse = live.has(accountCacheKey(account));
      return { entry, account };
    });
  }

  /** Running sessions: their accounts, and any newer reading their traffic produced (free). */
  private absorbSessions(): Map<string, PooledAccount> {
    const live = new Map<string, PooledAccount>();
    let sessions: LiveAccountSession[] = [];
    let complete = this.sessions !== undefined;
    try {
      sessions = this.sessions?.() ?? [];
    } catch {
      complete = false;
    }
    const counts = new Map<string, Set<string>>();
    for (const entry of this.entries.values()) entry.inUse = false;
    for (const session of sessions) {
      const key = accountCacheKey(session.account);
      // An observation must not replace the roster's name or hold metadata with a session's older snapshot.
      const entry = this.entries.get(key) ?? this.upsert(session.account);
      live.set(key, session.account);
      entry.inUse = true;
      countQualifiedSession(counts, session, entry.account);
      const seen = session.observation ? sanitizeAccountReading(session.observation) : null;
      if (seen) {
        // Credential rotation is still the same captured account: fence every cached probe of that identity.
        const targets = session.account.id
          ? [...this.entries.values()].filter(
              (candidate) =>
                candidate.account.id === session.account.id &&
                candidate.account.provider === session.account.provider,
            )
          : [entry];
        for (const target of targets) absorbObservation(target, seen);
      }
    }
    for (const entry of this.entries.values()) {
      const identity = entry.account.id ? `${entry.account.provider}:${entry.account.id}` : null;
      entry.sessionCount = snapshotCount(counts, identity, complete);
    }
    return live;
  }

  private upsert(account: PooledAccount): Entry {
    const key = accountCacheKey(account);
    const existing = this.entries.get(key);
    if (existing) {
      // The pool may rename an account or change its hold; the credential (hence the key) is the same.
      const { credential: _credential, ...metadata } = account;
      existing.account = sanitizeMetadata(metadata);
      return existing;
    }
    const { credential: _credential, ...metadata } = account;
    const entry: Entry = {
      account: sanitizeMetadata(metadata),
      reading: null,
      lastAttemptAtMs: null,
      inFlight: null,
      inUse: false,
      sessionGeneration: 0,
      sessionObservedAtMs: null,
      sessionReadingKey: null,
    };
    this.entries.set(key, entry);
    return entry;
  }

  private refreshEntry(
    entry: Entry,
    account: PooledAccount,
    mode: "periodic" | "on-demand",
  ): Promise<void> {
    if (entry.inFlight) return entry.inFlight;
    const nowMs = this.now();
    const minGap = mode === "periodic" ? PERIODIC_MIN_INTERVAL_MS : ON_DEMAND_MIN_INTERVAL_MS;
    const freshestMs = Math.max(
      entry.lastAttemptAtMs ?? -Infinity,
      entry.reading?.observedAtMs ?? -Infinity,
    );
    if (nowMs - freshestMs < minGap) return Promise.resolve();
    const reader = this.readers.get(entry.account.provider);
    if (!reader || account.credential.kind === "unavailable") return Promise.resolve();
    entry.lastAttemptAtMs = nowMs;
    const sessionGenerationAtStart = entry.sessionGeneration;
    const request = Promise.resolve()
      .then(async () => {
        try {
          const observed = await reader.probe(account);
          const result = observed ? sanitizeAccountReading(observed) : null;
          // Readers stamp response completion. A later session event wins over a request already in flight,
          // even when the clock has not advanced; repeated reads of the same sanitized event do not advance it.
          this.absorbSessions();
          if (
            result &&
            entry.sessionGeneration === sessionGenerationAtStart &&
            (entry.sessionObservedAtMs ?? -Infinity) <= nowMs &&
            (!entry.reading || result.observedAtMs >= entry.reading.observedAtMs)
          ) {
            entry.reading = result;
          }
        } catch {
          // Reader errors can contain credentials or paths.
          this.logger.warn({ provider: entry.account.provider }, "Account usage probe failed");
        }
        return undefined;
      })
      .finally(() => {
        if (entry.inFlight === request) entry.inFlight = null;
      });
    entry.inFlight = request;
    return request;
  }

  private row(entry: Entry): AccountUsageRow {
    const nowMs = this.now();
    const { account, reading } = entry;
    const window = (id: "five_hour" | "weekly") => {
      const found = reading?.windows.find((w) => w.id === id);
      // A window past its reset has started over: the old figure is stale, so it is not shown.
      if (!found || (found.resetsAtMs !== null && found.resetsAtMs <= nowMs)) return null;
      return { usedPct: found.usedPct, resetsAt: iso(found.resetsAtMs) };
    };
    const fiveHour = window("five_hour");
    const weekly = window("weekly");
    const heldByPool = (account.poolLimitedUntilMs ?? 0) > nowMs;
    // The provider said "rejected": that stands until the window it names resets (a past-reset window is dropped above).
    const rejectedNow = reading?.state === "limited" && (fiveHour !== null || weekly !== null);
    let status: AccountUsageStatus = "unavailable";
    if (heldByPool || rejectedNow) status = "limited";
    else if (fiveHour !== null || weekly !== null) status = "ok";
    return {
      accountId: account.id,
      name: account.name,
      provider: account.provider,
      status,
      observedAt: iso(reading?.observedAtMs ?? null),
      source: reading?.source ?? null,
      fiveHour,
      weekly,
      inUse: entry.inUse,
      ...(entry.sessionCount !== undefined ? { sessionCount: entry.sessionCount } : {}),
    };
  }
}
