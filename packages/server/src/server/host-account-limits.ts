import path from "node:path";
import { z } from "zod";
import {
  HostAccountLimitSchema,
  RemoteAccountLimitsSchema,
  type HostAccountLimit,
} from "./host-link-contracts.js";
import { writePrivateFileAtomicSync } from "./private-files.js";

const accountSchema = z.object({
  id: z.string().uuid(),
  createdAt: z.string().optional(),
  limitedUntil: z.string().nullable().optional(),
  limitKind: z.string().nullable().optional(),
  limitObservedAt: z.string().nullable().optional(),
});
const accountsSchema = z.object({ accounts: z.array(accountSchema).max(32) });
const windowSchema = z.object({ usedPct: z.number().finite(), resetsAt: z.string().nullable() });
const reportsSchema = z.object({
  v: z.literal(1),
  reports: z
    .array(
      z.object({
        accountId: z.string().uuid(),
        observedAt: z.string().nullable(),
        fiveHour: windowSchema.nullable(),
        weekly: windowSchema.nullable(),
      }),
    )
    .max(32),
});

/** Only bounded account IDs and limit observations enter the host link. */
export class HostAccountLimits {
  private readonly directory: string;
  constructor(
    home: string,
    private readonly read: (file: string) => unknown | null,
    private readonly now: () => number,
  ) {
    this.directory = path.join(home, "command-centre", "accounts");
  }

  local(): HostAccountLimit[] {
    const file = path.join(this.directory, "accounts.json");
    const parsed = accountsSchema.safeParse(this.read(file));
    if (!parsed.success) return [];
    const observations: HostAccountLimit[] = [];
    for (const account of parsed.data.accounts) {
      // Creation time keeps legacy limits older than any later local observation.
      const observedAt = account.limitObservedAt ?? account.createdAt;
      const result = HostAccountLimitSchema.safeParse({
        accountId: account.id,
        limitKind: account.limitKind,
        resetAt: account.limitedUntil,
        observedAt,
      });
      if (result.success && Date.parse(result.data.resetAt) > this.now())
        observations.push(result.data);
    }
    const reports = reportsSchema.safeParse(
      this.read(path.join(this.directory, "usage-reports.json")),
    );
    if (!reports.success) return observations;
    for (const report of reports.data.reports) {
      const account = parsed.data.accounts.find((item) => item.id === report.accountId);
      if (!account || !report.observedAt) continue;
      if (Date.parse(account.limitObservedAt ?? "") >= Date.parse(report.observedAt)) continue;
      for (const [limitKind, window] of [
        ["session", report.fiveHour],
        ["weekly", report.weekly],
      ] as const) {
        if (!window || window.usedPct < 100 || !window.resetsAt) continue;
        const result = HostAccountLimitSchema.safeParse({
          accountId: account.id,
          limitKind,
          resetAt: window.resetsAt,
          observedAt: report.observedAt,
        });
        if (result.success && Date.parse(result.data.resetAt) > this.now())
          observations.push(result.data);
      }
    }
    return observations;
  }

  receive(source: string, observation: HostAccountLimit): boolean {
    const now = this.now();
    const reset = Date.parse(observation.resetAt);
    const observed = Date.parse(observation.observedAt);
    // Bound clock skew and retention. A weekly window cannot hold a pool indefinitely.
    if (reset <= now || reset > now + 8 * 86400000 || observed > now + 60000 || observed >= reset)
      return false;
    const parsed = accountsSchema.safeParse(this.read(path.join(this.directory, "accounts.json")));
    if (
      !parsed.success ||
      !parsed.data.accounts.some((account) => account.id === observation.accountId)
    )
      return false;
    const file = path.join(this.directory, "remote-limits.json");
    const raw = this.read(file);
    const saved = RemoteAccountLimitsSchema.parse(raw ?? { v: 1, observations: [] });
    const known = new Set(parsed.data.accounts.map((account) => account.id));
    const observations = saved.observations.filter(
      (item) => known.has(item.accountId) && Date.parse(item.resetAt) > now,
    );
    const retained = observations.find(
      (item) =>
        item.source === source &&
        item.accountId === observation.accountId &&
        item.limitKind === observation.limitKind,
    );
    if (retained && Date.parse(retained.observedAt) >= observed) {
      // A previous rename can succeed before the directory flush fails.
      writePrivateFileAtomicSync(file, JSON.stringify({ v: 1, observations }), { durable: true });
      return true;
    }
    const remaining = observations.filter((item) => item !== retained);
    remaining.push({ ...observation, source });
    const next = RemoteAccountLimitsSchema.parse({ v: 1, observations: remaining });
    writePrivateFileAtomicSync(file, JSON.stringify(next), { durable: true });
    return true;
  }
}
