import type { ProviderUsage } from "../messages.js";
import type { AgentQuotaSnapshot } from "./agent-sdk-types.js";

/** The running Codex account's quota, never machine-account HTTP usage relabelled. */
export async function sessionQuotaUsage(
  label: string,
  readQuota: () => Promise<AgentQuotaSnapshot>,
  isCurrent: () => boolean,
): Promise<ProviderUsage> {
  const usage: ProviderUsage = {
    providerId: "codex",
    displayName: "Codex",
    sourceLabel: label,
    status: "unavailable",
    planLabel: null,
    windows: [],
    balances: [],
    details: [],
    error: null,
  };
  let quota: AgentQuotaSnapshot | null = null;
  try {
    quota = await readQuota();
  } catch {
    /* A failed account read must not fall back to the Mac's figures. */
  }
  if (!isCurrent()) throw new Error("Session changed during account usage read");
  if (!quota || quota.provider !== "codex") return usage;
  usage.status = "available";
  usage.fetchedAt = quota.observedAt;
  let admissionState: "allowed" | "blocked" | "unknown" = "unknown";
  if (quota.ordinaryUsageAllowed === true) admissionState = "allowed";
  else if (quota.ordinaryUsageAllowed === false) admissionState = "blocked";
  usage.admission = {
    state: admissionState,
    accountScope: quota.accountScope,
    observedAt: quota.observedAt,
    reason: "Running session quota",
  };
  usage.windows = quota.limits.flatMap((limit, i) =>
    (["primary", "secondary"] as const).flatMap((kind) => {
      const window = limit[kind];
      return window
        ? [
            {
              id: `${limit.id ?? i}-${kind}`,
              label: `${limit.model ? `${limit.model} · ` : ""}${kind === "primary" ? "Primary" : "Secondary"} window`,
              usedPct: window.usedPercent,
              remainingPct: Math.max(0, 100 - window.usedPercent),
              resetsAt:
                window.resetsAt === null ? null : new Date(window.resetsAt * 1000).toISOString(),
            },
          ]
        : [];
    }),
  );
  return usage;
}
