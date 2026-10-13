export interface ReportAgent {
  id: string;
  title?: string | null;
  config?: unknown;
}
export interface PendingFinish {
  workerId: string;
  worker: ReportAgent;
  lastMessage: string | null;
}
export interface LedgerItem {
  id: string;
}
export declare const REPORT_UP_SNIPPET_CHARS = 600;
export declare const PERMISSION_COMMAND_CHARS = 200;
export declare const COALESCE_WINDOW_MS: number;
export declare const COMBINED_LIST_LIMIT = 20;
export declare const COMBINED_SNIPPET_CHARS = 300;
export declare const NUDGE_LIST_LIMIT = 8;
export interface LimitedChat {
  kind: string;
  /** Epoch ms of the reset; our own estimate when the text named none. */
  until: number;
  /** Its lead was told. */
  notified: boolean;
}
export declare const UNKNOWN_RESET_MS: number;
export declare const MAX_HELD_REPORTS = 20;
export declare function formatLimitNotice(title: string, limit: LimitedChat): string;
export interface PermissionRequest {
  id: string;
  name?: string;
  title?: string;
  input?: Record<string, unknown>;
  detail?: {
    type?: string;
    command?: unknown;
    filePath?: unknown;
  } | null;
}
export declare function permissionCommandOf(request: PermissionRequest): string;
export declare function formatNudge(
  workers: readonly ReportAgent[],
  items: readonly LedgerItem[],
): string;
export declare function formatPermissionNotice(input: {
  worker: ReportAgent;
  request: PermissionRequest;
  cwd: string | null;
}): string;
export declare function formatCombinedNotice(items: readonly PendingFinish[]): string;
export declare function titleOf(agent: ReportAgent): string;
export declare function formatReportUpNotice(input: {
  worker: ReportAgent;
  failed: boolean;
  lastMessage: string | null;
}): string;
export declare function reportUpSwitches(
  setting: boolean | undefined,
  idleLeadNudge?: boolean,
): {
  finishedTurns: boolean;
  otherNotices: boolean;
  idleNudges: boolean;
};
export declare function quietReportReason(input: {
  failed: boolean;
  leadToMain: boolean;
  sentAt: number | null;
  startedAt?: number;
}): string | null;
