import type { Account } from "./accounts.mjs";
export function readBilling(root: string): {
  v: number;
  calls: Record<string, { accountId: string; costUsd: number; at: string }>;
  events: { type: string; accountId: string; at: string }[];
};
export function accountSpend(
  root: string,
  account: Account,
  billing?: ReturnType<typeof readBilling>,
): { limitUsd: number | null; startAt: string; usedUsd: number } | null;
export function recordAccountCost(
  root: string,
  value: {
    id: string;
    accountId: string;
    costUsd: number;
    at?: string;
    runtimeSessionId?: string | null;
    cumulativeUsd?: number | null;
  },
): Promise<boolean>;
export function recordBillingError(
  root: string,
  accountId: string,
  at?: string,
  type?: string,
): Promise<boolean>;
export function isBillingError(value: unknown): boolean;
