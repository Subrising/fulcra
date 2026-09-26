import type { ProjectedTimelineRow } from "./timeline-projection.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import type { TimelineIndexData, TimelineTurnRecord } from "./timeline-turn-index.js";

export interface AgentTimelineRow {
  seq: number;
  timestamp: string;
  item: AgentTimelineItem;
  readonly turnId?: string;
  readonly providerMessageId?: string;
}

export interface AgentTimelineCursor {
  epoch: string;
  seq: number;
}

export type AgentTimelineFetchDirection = "tail" | "before" | "after";

export interface AgentTimelineFetchOptions {
  direction?: AgentTimelineFetchDirection;
  cursor?: AgentTimelineCursor;
  /**
   * Number of projected items to return.
   * - undefined: store default
   * - 0: all rows in the selected window
   */
  limit?: number;
  /** Restricts the page to one turn's rows; cursors and limits then page within the turn. */
  turn?: Pick<TimelineTurnRecord, "seqStart" | "seqEnd" | "ranges">;
}

export interface AgentTimelineIndexSnapshot {
  epoch: string;
  /** Host-local placement the relative paths in `index` were derived against. */
  cwd: string | null;
  index: TimelineIndexData;
}

/** Where an agent ran. Kept with retained history so its index can be rebuilt after delete. */
export interface AgentTimelinePlacement {
  cwd?: string;
  provider?: string;
}

export interface AgentTimelineWindow {
  minSeq: number;
  maxSeq: number;
  nextSeq: number;
}

export interface AgentTimelineFetchResult {
  epoch: string;
  direction: AgentTimelineFetchDirection;
  reset: boolean;
  staleCursor: boolean;
  gap: boolean;
  window: AgentTimelineWindow;
  hasOlder: boolean;
  hasNewer: boolean;
  startSeq: number | null;
  endSeq: number | null;
  rows: ProjectedTimelineRow[];
}

export interface AgentTimelineStore {
  appendCommitted(
    agentId: string,
    item: AgentTimelineItem,
    options?: { timestamp?: string; turnId?: string },
  ): Promise<AgentTimelineRow>;
  fetchCommitted(
    agentId: string,
    options?: AgentTimelineFetchOptions,
  ): Promise<AgentTimelineFetchResult>;
  getLatestCommittedSeq(agentId: string): Promise<number>;
  getCommittedRows(agentId: string): Promise<AgentTimelineRow[]>;
  getLastItem(agentId: string): Promise<AgentTimelineItem | null>;
  getLastAssistantMessage(agentId: string): Promise<string | null>;
  deleteAgent(agentId: string): Promise<void>;
  bulkInsert(agentId: string, rows: readonly AgentTimelineRow[]): Promise<void>;
  updateCommittedRow(agentId: string, row: AgentTimelineRow): Promise<void>;
  /** Moves history aside when an agent is deleted, instead of removing it. */
  retainAgent?(agentId: string, placement?: AgentTimelinePlacement): Promise<void>;
  getRetainedPlacement?(agentId: string): Promise<AgentTimelinePlacement | null>;
  recoverInterruptedRetention?(): Promise<string[]>;
  /** Finishes a delete whose history was retained; until then reads resolve to the retained copy. */
  commitRetention?(agentId: string): Promise<{ committed: boolean }>;
  listPendingDeletes?(): Promise<string[]>;
  /** Removes live and retained history. */
  purgeAgent?(agentId: string): Promise<{ purged: boolean }>;
  setIndexCwd?(agentId: string, cwd: string): Promise<void>;
  getTimelineIndex?(
    agentId: string,
    options?: { retained?: boolean },
  ): Promise<AgentTimelineIndexSnapshot | null>;
  fetchRetained?(
    agentId: string,
    options?: AgentTimelineFetchOptions,
  ): Promise<AgentTimelineFetchResult | null>;
}
