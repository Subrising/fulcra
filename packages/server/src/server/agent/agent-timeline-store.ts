import { randomUUID } from "node:crypto";
import { TimelineProjection, type ProjectedTimelineRow } from "./timeline-projection.js";
import { limitAgentTimelineItemContent } from "./agent-timeline-content.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import { isSeqInTurn } from "./timeline-turn-index.js";
import type {
  AgentTimelineFetchOptions,
  AgentTimelineFetchResult,
  AgentTimelineRow,
} from "./agent-timeline-store-types.js";

export interface SeedAgentTimelineOptions {
  items?: readonly AgentTimelineItem[];
  rows?: readonly AgentTimelineRow[];
  epoch?: string;
  nextSeq?: number;
  timestamp?: string;
}

interface AgentTimelineState {
  epoch: string;
  projection: TimelineProjection;
  minSeq: number;
  nextSeq: number;
}
const DEFAULT_TIMELINE_FETCH_LIMIT = 200;
function cloneRow<T extends AgentTimelineRow>(row: T): T {
  return { ...row };
}

export class InMemoryAgentTimelineStore {
  private readonly states = new Map<string, AgentTimelineState>();

  has(agentId: string): boolean {
    return this.states.has(agentId);
  }

  initialize(agentId: string, options?: SeedAgentTimelineOptions): void {
    const timestamp = options?.timestamp ?? new Date().toISOString();
    const rows = options?.rows?.length
      ? options.rows.map(cloneRow)
      : this.buildRowsFromItems(options?.items ?? [], options?.nextSeq ?? 1, timestamp);
    const nextSeq = rows.reduce((next, row) => Math.max(next, row.seq + 1), options?.nextSeq ?? 1);
    const projection = new TimelineProjection(rows);
    this.states.set(agentId, {
      epoch: options?.epoch ?? randomUUID(),
      projection,
      minSeq: projection.getRows()[0]?.seqStart ?? 0,
      nextSeq,
    });
  }

  delete(agentId: string): void {
    this.states.delete(agentId);
  }

  getItems(agentId: string): AgentTimelineItem[] {
    return this.requireState(agentId)
      .projection.getRows()
      .map((row) => row.item);
  }

  getRows(agentId: string): ProjectedTimelineRow[] {
    return this.requireState(agentId).projection.getRows().map(cloneRow);
  }

  getSubmittedUserMessage(agentId: string, clientMessageId: string): AgentTimelineRow | null {
    const row = this.requireState(agentId)
      .projection.getRows()
      .find(
        (candidate) =>
          (candidate.item.type === "user_message" &&
            candidate.item.clientMessageId === clientMessageId) ||
          isAgentMessageCall(candidate.item, clientMessageId),
      );
    return row ? cloneRow(row) : null;
  }

  enrichSubmittedUserMessage(
    agentId: string,
    clientMessageId: string,
    providerMessageId: string,
  ): AgentTimelineRow | null {
    return this.requireState(agentId).projection.enrichSubmittedUserMessage(
      clientMessageId,
      providerMessageId,
    );
  }

  getEpoch(agentId: string): string {
    return this.requireState(agentId).epoch;
  }

  getNextSeq(agentId: string): number {
    return this.requireState(agentId).nextSeq;
  }

  fetch(agentId: string, options?: AgentTimelineFetchOptions): AgentTimelineFetchResult {
    const state = this.requireState(agentId);
    const direction = options?.direction ?? "tail";
    const cursor = options?.cursor;
    const hasRows = state.minSeq !== 0;
    // Fulcra: a turn fetch pages inside one turn's projected rows only.
    const turn = options?.turn;
    const projection = turn
      ? new TimelineProjection(
          state.projection.getRows().filter((row) => isSeqInTurn(turn, row.seqStart)),
        )
      : state.projection;
    const window = { minSeq: state.minSeq, maxSeq: state.nextSeq - 1, nextSeq: state.nextSeq };
    const staleCursor = cursor !== undefined && cursor.epoch !== state.epoch;
    const gap =
      !staleCursor &&
      direction === "after" &&
      cursor !== undefined &&
      hasRows &&
      cursor.seq < state.minSeq - 1;
    const reset = staleCursor || gap;
    const page = projection.selectPage({
      bounds: turn ? { minSeq: turn.seqStart, maxSeq: turn.seqEnd } : window,
      direction: reset ? "tail" : direction,
      cursorSeq: cursor?.seq,
      limit: options?.limit ?? DEFAULT_TIMELINE_FETCH_LIMIT,
      wholeTurns: options?.wholeTurns,
    });
    return {
      epoch: state.epoch,
      direction,
      reset,
      staleCursor,
      gap,
      window,
      hasOlder: page.hasOlder,
      hasNewer: page.hasNewer,
      startSeq: page.startSeq,
      endSeq: page.endSeq,
      // Stored rows are already within budget; this bounds assistant and reasoning merges.
      rows: page.entries.map((entry) =>
        Object.assign({ seq: entry.seqEnd }, entry, {
          item: limitAgentTimelineItemContent(entry.item),
        }),
      ),
    };
  }

  append(
    agentId: string,
    item: AgentTimelineItem,
    options?: { timestamp?: string; providerMessageId?: string; turnId?: string },
  ): AgentTimelineRow {
    const state = this.requireState(agentId);
    const row: AgentTimelineRow = {
      seq: state.nextSeq,
      timestamp: options?.timestamp ?? new Date().toISOString(),
      item,
      ...(options?.turnId ? { turnId: options.turnId } : {}),
      ...(options?.providerMessageId ? { providerMessageId: options.providerMessageId } : {}),
    };
    state.nextSeq += 1;
    if (state.minSeq === 0) state.minSeq = row.seq;
    state.projection.append(row);
    return cloneRow(row);
  }

  getLastItem(agentId: string): AgentTimelineItem | null {
    const state = this.requireState(agentId);
    return state.projection.getLastItem(state.nextSeq - 1);
  }

  getLastAssistantMessage(agentId: string): string | null {
    return this.requireState(agentId).projection.getLastAssistantMessage();
  }

  private requireState(agentId: string): AgentTimelineState {
    const state = this.states.get(agentId);
    if (!state) {
      throw new Error(`Unknown agent '${agentId}'`);
    }
    return state;
  }

  private buildRowsFromItems(
    items: readonly AgentTimelineItem[],
    startSeq: number,
    timestamp: string,
  ): AgentTimelineRow[] {
    let nextSeq = startSeq;
    return items.map((item) => {
      const row: AgentTimelineRow = {
        seq: nextSeq,
        timestamp,
        item,
      };
      nextSeq += 1;
      return row;
    });
  }
}

// FULCRA(FU-657): since upstream v0.15 a prompt from another agent (a send or a report) is in the
// timeline as an "agent_message" tool call with the message id in its call id, and a system envelope
// (a finish notice) is a "heartbeat" tool call with the id in its metadata. Fulcra's submitted-message
// checks must still find them, or a notice can repeat.
const AGENT_MESSAGE_CALL_PREFIX = "paseo-agent-message:";
export function submittedToolMessageId(item: AgentTimelineItem): string | null {
  if (item.type !== "tool_call") return null;
  if (item.name === "agent_message" && item.callId.startsWith(AGENT_MESSAGE_CALL_PREFIX))
    return item.callId.slice(AGENT_MESSAGE_CALL_PREFIX.length);
  const submitted = item.metadata?.submittedMessageId;
  return item.name === "heartbeat" && typeof submitted === "string" ? submitted : null;
}
function isAgentMessageCall(item: AgentTimelineItem, messageId: string): boolean {
  return submittedToolMessageId(item) === messageId;
}
