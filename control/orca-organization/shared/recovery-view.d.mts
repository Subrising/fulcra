export type RecoveryState =
  | "interrupted-turn"
  | "busy-stale"
  | "needs-reconcile"
  | "idle-at-restart"
  | "control-changed"
  | "not-resumable";
export interface RepoState {
  path: string;
  branch?: string | null;
  head?: string | null;
  upstream?: string | null;
  ahead?: number | null;
  behind?: number | null;
  modified?: number;
  unmerged?: number;
  untracked?: number;
  clean?: boolean;
  error?: string;
}
export interface RecoveryItem {
  interruptionId: string;
  sessionId: string;
  task: string | null;
  mode: string | null;
  generation: number | null;
  cause: string;
  state: RecoveryState;
  turn: "interrupted" | "ended" | "unknown";
  since: string;
  previousBoot: string | null;
  observedBoot: string | null;
  doing: {
    brief: string | null;
    messageId: string | null;
    deliveryState: string | null;
    untrusted: boolean;
  };
  grants: {
    role?: boolean;
    seated?: boolean;
    permission?: { rootSession: string; root: boolean } | null;
    manager?: boolean;
    team?: boolean;
  };
  owner: unknown;
  repo: { repos: RepoState[]; note?: string };
  observeError: string | null;
  currentStatus: string | null;
  resumable: boolean;
  reason: string | null;
  disposition: string;
}
export interface UnsettledDelivery {
  id: string;
  session: string | null;
  kind: string;
  state: string;
  attempts: number | null;
  firstCheckedAt: string | null;
  lastCheckedAt: string | null;
  outcome: string | null;
  needsHuman: boolean;
}
export interface RecoveryStatus {
  items: RecoveryItem[];
  unsettled: UnsettledDelivery[];
  error: unknown;
  note: string;
}
export interface Action {
  enabled: boolean;
  reason: string | null;
}
export interface RecoveryCard {
  key: string;
  title: string;
  chip: string;
  state: RecoveryState;
  leader: boolean;
  headline: string;
  nextStep: string;
  details: string[];
  cause: string;
  turn: string;
  doing: { text: string | null; label: string; messageId: string | null };
  work: string[];
  workNote: string;
  why: string;
  actions: { resume: Action; reconcile: Action; dismiss: Action };
}
export const CHIPS: Readonly<Record<RecoveryState, string>>;
export const MAX_ITEMS: number;
export function validateRecovery(value: unknown): RecoveryStatus;
export function repoLine(r: RepoState): string;
export function recoveryCard(
  x: RecoveryItem,
  options?: { fresh?: boolean; busy?: boolean; titles?: Record<string, string>; now?: number },
): RecoveryCard;
export function resumePreview(x: RecoveryItem, note?: string): string[];
export function orderItems(items: RecoveryItem[]): RecoveryItem[];
export function latestRestart(
  items: RecoveryItem[],
): { items: RecoveryItem[]; newest: string; since: string } | null;
export const EARLIER: string;
export const RESTART_WINDOW_MS: number;
export function recoverySections(
  items: RecoveryItem[],
): { key: "latest" | "earlier" | "all"; title: string | null; items: RecoveryItem[] }[];
export function bannerSummary(
  status: RecoveryStatus | undefined | null,
): { text: string; severity: "attention" | "info" } | null;
export function teamItems(
  items: RecoveryItem[],
): { sessionId: string; interruptionId: string; expectedGeneration: number | null }[];
export function when(iso: string): string;
export function ago(iso: string, now?: number): string;
export function nextStep(x: RecoveryItem): string;
