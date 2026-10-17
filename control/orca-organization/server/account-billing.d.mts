import type { Account } from "./accounts.mjs";
export function readBilling(root: string): {
  v: number;
  calls: Record<string, { accountId: string; costUsd: number; at: string }>;
  cursors?: Record<string, { cumulativeUsd: number; at: string }>;
  checkpoints?: Record<string, Record<string, number>>;
  checkpointRevisions?: Record<string, number>;
  observations?: Record<string, string>;
  lastSuccessOrder?: Record<string, string>;
  lastSuccess?: Record<string, string>;
  events: {
    id?: string;
    type: string;
    accountId: string;
    at: string;
    clearedAt?: string;
    clearedOrder?: string;
    notified?: boolean;
    sessionId?: string;
    notices?: { main?: string; owner?: string };
  }[];
};
export function accountSpend(
  root: string,
  account: Account,
  billing?: ReturnType<typeof readBilling>,
): { startAt: string; usedUsd: number } | null;
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
    costRevision?: number | null;
  },
): Promise<boolean>;
export function recordBillingError(
  root: string,
  accountId: string,
  at?: string,
  type?: string,
  sessionId?: string | null,
  sourceId?: string | null,
  sourceOrder?: string | null,
): Promise<boolean>;
export function isBillingError(value: unknown): boolean;

export function recordBillingSuccess(
  root: string,
  accountId: string,
  at?: string,
  sourceId?: string | null,
  sourceOrder?: string | null,
): Promise<boolean>;
export function markBillingWarningSent(
  root: string,
  eventId: string,
  notices: { main?: string; owner?: string },
): Promise<void>;
export function pendingBillingWarnings(root: string): ReturnType<typeof readBilling>["events"];

export function readSessionBilling<
  T extends {
    provider: string;
    agentId: string;
    runtimeSessionId: string | null;
    records?: {
      cursors: Record<string, number>;
      revision?: number;
      billingWarning?: string;
      turns: Record<string, { accountId: string | null; amountUsd: number; at: string }>;
    };
  },
>(root: string, request: T): T | undefined;

export function recordAccountTurnEnd(
  root: string,
  event: {
    observedAt?: string;
    observationId?: string;
    observedOrder?: string;
    turnId?: string | null;
    agent: { id: string; provider: string; accountId?: string };
    outcome: { kind: string; error?: { message: string } };
  },
  at?: string,
): Promise<boolean>;

export function observeAccountCall(
  root: string,
  observation: {
    id: string;
    accountId: string;
    at: string;
    sessionId: string | null;
    failed: boolean | null;
    costUsd: number | null;
  },
): Promise<boolean>;
export function recoverAccountObservations(root: string): Promise<void>;
