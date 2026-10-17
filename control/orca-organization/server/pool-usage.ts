import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { accountSpend, dailySpend } from "./account-billing.mjs";
import { accountLimit, readAccounts } from "./accounts.mjs";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  toneFromUsedPct,
  windowFromUsedPct,
  type UsageScope,
  type UsageReport,
} from "@getpaseo/plugin/server/usage";

const id = z.string().uuid();
const provider = z.enum(["claude", "codex"]);
const inputSchema = z.object({ accountId: id, provider }).strict();
const accountSchema = z.object({
  id,
  provider,
  name: z.string(),
  enabled: z.boolean(),
  limitedUntil: z.string().nullable().optional(),
});
const windowSchema = z
  .object({ usedPct: z.number().finite().min(0).max(100), resetsAt: z.string().nullable() })
  .nullable();
const rowSchema = z.object({
  accountId: id,
  provider,
  status: z.enum(["ok", "limited", "unavailable"]),
  observedAt: z.string().nullable(),
  fiveHour: windowSchema,
  weekly: windowSchema,
});

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function accounts(root: string) {
  const parsed = z
    .object({ accounts: z.array(accountSchema) })
    .safeParse(readJson(join(root, "accounts", "accounts.json")));
  return parsed.success ? parsed.data.accounts : [];
}

function label(name: string): string {
  // Match the pool's metadata boundary. Do not expose old secret-shaped account names.
  if (
    /sk-ant-|\bsk-[A-Za-z0-9_-]{16,}|\bgh[opsu]_|github_pat_|\bxox[abp]-|\beyJ[A-Za-z0-9_-]{8,}\.|auth\.json|access_token|refresh_token|[A-Za-z0-9+/_-]{40,}/i.test(
      name,
    )
  )
    return "Pooled account";
  return (
    name
      .replace(/[\x00-\x1f\x7f]/g, "")
      .trim()
      .slice(0, 60) || "Pooled account"
  );
}

export function createPoolUsage(root: () => string, now = Date.now) {
  return {
    async discover(scope: UsageScope) {
      const list = accounts(root());
      return list
        .filter(
          (account) =>
            scope.kind === "global" ||
            (scope.provider === account.provider && scope.env.FULCRA_ACCOUNT_ID === account.id),
        )
        .map((account) => ({
          key: `${account.provider}.${account.id}`,
          label: label(account.name),
          harness: account.provider === "claude" ? "Claude" : "Codex",
          input: { accountId: account.id, provider: account.provider },
        }));
    },
    async fetch(value: unknown): Promise<UsageReport> {
      const input = inputSchema.parse(value);
      const account = accounts(root()).find(
        (a) => a.id === input.accountId && a.provider === input.provider,
      );
      const unavailable = (detail: string): UsageReport => ({
        status: "unavailable",
        problem: { kind: "no_quota", detail },
      });
      if (!account) return unavailable("This pooled account is no longer available.");
      if (!account.enabled) return unavailable("This pooled account is disabled.");
      const stored = readAccounts(root()).accounts.find((a) => a.id === account.id);
      const spend = stored && accountSpend(root(), stored);
      if (spend) {
        const daily = dailySpend(root(), stored!, undefined, now())!;
        return {
          status: "available",
          windows: [],
          balances: [
            {
              id: "api-daily-budget",
              label: "Daily API cap (UTC)",
              unit: "usd",
              used: daily.usedUsd,
              limit: daily.limitUsd,
              remaining: Math.max(0, daily.limitUsd - daily.usedUsd),
              tone: toneFromUsedPct((daily.usedUsd / daily.limitUsd) * 100),
            },
            {
              id: "api-budget",
              label: "API budget",
              unit: "usd",
              used: spend.usedUsd,
              limit: spend.limitUsd,
              remaining:
                spend.limitUsd === null ? null : Math.max(0, spend.limitUsd - spend.usedUsd),
              tone:
                spend.limitUsd === null
                  ? "default"
                  : toneFromUsedPct((spend.usedUsd / spend.limitUsd) * 100),
            },
          ],
          details: [
            { id: "budget-start", label: "Costs since", value: spend.startAt },
            {
              id: "cost-source",
              label: "Cost source",
              value: "Recorded Claude API costs on this host",
            },
          ],
        };
      }
      const parsed = z
        .object({ v: z.literal(1), reports: z.array(rowSchema) })
        .safeParse(readJson(join(root(), "accounts", "usage-reports.json")));
      const row = parsed.success
        ? parsed.data.reports.find(
            (r) => r.accountId === account.id && r.provider === account.provider,
          )
        : undefined;
      let limit: ReturnType<typeof accountLimit>;
      try {
        const stored = readAccounts(root()).accounts.find((a) => a.id === account.id);
        limit = stored ? accountLimit(stored, now()) : null;
      } catch {
        return unavailable("Pool limit data is unavailable.");
      }
      const held = limit !== null;
      const source = limit?.source === "local" ? "local" : `remote host ${limit?.source}`;
      if (
        !row ||
        row.status === "unavailable" ||
        (!row.fiveHour && !row.weekly) ||
        !row.observedAt ||
        !Number.isFinite(Date.parse(row.observedAt))
      )
        return unavailable(
          held
            ? `This account is held until ${limit!.until}. Source: ${source}. Usage is unavailable.`
            : "Usage is unavailable for this pooled account.",
        );
      const windows = (
        [
          ["five_hour", "5-hour", "5h", row.fiveHour],
          ["weekly", "Weekly", "wk", row.weekly],
        ] as const
      ).flatMap(([id, label, shortLabel, window]) =>
        window
          ? [
              windowFromUsedPct({
                id,
                label,
                shortLabel,
                summary: true,
                utilizationPct: window.usedPct,
                resetsAt: window.resetsAt,
                tone: toneFromUsedPct(window.usedPct),
              }),
            ]
          : [],
      );
      return {
        status: "available",
        windows,
        details: [
          { id: "observed-at", label: "Last observed", value: row.observedAt },
          ...(held
            ? [
                {
                  id: "pool-hold",
                  label: "Pool hold",
                  value: limit!.until,
                  tone: "danger" as const,
                },
                { id: "limit-source", label: "Limit source", value: source },
              ]
            : []),
        ],
      };
    },
  };
}

export function registerPoolUsage(server: PluginServerContext, root: () => string) {
  const source = createPoolUsage(root);
  server.registerUsageSource({
    id: "fulcra-pool",
    label: "Pooled accounts",
    input: inputSchema,
    ...source,
  });
}
