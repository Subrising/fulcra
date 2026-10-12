import type { PermissionRequest } from "./report-notices.mjs";
export interface ReportTurnEnd {
  agentId: string;
  failed: boolean;
  fromNotice: boolean;
  fromNudge: boolean;
  startedAt?: number;
  failure: string;
  lastAssistant?: string | null;
}
export interface ReportObserverDeps {
  now: () => number;
  noticePrefix: string;
  isSystemInjectedEnvelope: (text: string) => boolean;
  onStarted: (id: string) => void;
  onClosed?: (id: string) => void;
  onEnded: (input: ReportTurnEnd) => void;
  onPermission: (id: string, request: PermissionRequest) => void;
}
export class ReportUpObserver {
  constructor(deps: ReportObserverDeps);
  isOpen(id: string): boolean;
  turnStarted(id: string): void;
  firstMessage(id: string, item: unknown): void;
  turnEnded(
    id: string,
    kind: "completed" | "failed" | "canceled",
    failure?: string,
    lastAssistant?: string | null,
  ): void;
  permissionRequested(id: string, request: PermissionRequest): void;
  permissionResolved(id: string, requestId: string): void;
  close(id: string): void;
  stop(): void;
  onStream(id: string, event: object): void;
}
