import type { Account } from "./accounts.mjs";
export function readBilling(root: string): {
  v: number;
  calls: Record<string, { accountId: string; costUsd: number; at: string }>;
  cursors?: Record<string, { cumulativeUsd: number; at: string }>;
  checkpoints?: Record<string, Record<string, number>>;
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
    sessionId?: string | null;
    cursorCheckpoint?: Record<string, number> | null;
  },
): Promise<boolean>;
export function recordBillingError(
  root: string,
  accountId: string,
  at?: string,
  type?: string,
): Promise<boolean>;
export function isBillingError(value: unknown): boolean;

export function dailySpend(
  root: string,
  account: Account,
  billing?: ReturnType<typeof readBilling>,
  now?: number,
): { startAt: string; limitUsd: number; usedUsd: number } | null;
export function assertApiSpendAllowed(
  root: string,
  input: {
    provider: string;
    accountId: string | null;
    labels?: Record<string, string>;
    sessionCost?: { totalUsd: number };
  },
  now?: number,
): void;

export function readSessionBilling<
  T extends {
    provider: string;
    agentId: string;
    runtimeSessionId: string | null;
    records?: {
      cursors: Record<string, number>;
      turns: Record<string, { accountId: string | null; amountUsd: number; at: string }>;
    };
  },
>(root: string, request: T): T | undefined;
