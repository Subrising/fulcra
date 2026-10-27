import { timelineItemIdentity } from "@getpaseo/protocol/timeline-identity";
import { TimelineProjection, selectProjectedTimelinePage } from "./timeline-projection.js";
import type { AgentTimelineFetchResult, AgentTimelineRow } from "./agent-timeline-store-types.js";

export type JournalTailRecord =
  | { op: "append"; rows: AgentTimelineRow[] }
  | { op: "update"; row: AgentTimelineRow };

interface SeqRange {
  startSeq: number;
  endSeq: number;
}

/**
 * Lines of one journal segment, last first. `header` marks the line at offset 0. Offsets count
 * UTF-8 bytes, and only complete lines are decoded, so a chunk edge never splits a character.
 */
export async function* readLinesBackward(
  read: (offset: number, bytes: number) => Promise<Buffer>,
  size: number,
  chunkBytes: number,
): AsyncGenerator<{ text: string; header: boolean }> {
  let start = size;
  let pending: Buffer = Buffer.alloc(0);
  while (start > 0) {
    const from = Math.max(0, start - chunkBytes);
    pending = Buffer.concat([await read(from, start - from), pending]);
    // A torn last record is for the full load to report.
    if (start === size && pending.at(-1) !== 10)
      throw new SyntaxError("Incomplete timeline journal");
    start = from;
    const { texts, rest } = takeCompleteLines(pending, start === 0);
    pending = rest;
    for (const [index, text] of texts.entries())
      yield { text, header: start === 0 && index === texts.length - 1 };
  }
}

/** Complete lines at the end of `buffer`, last first: those after a newline, or all at the file start. */
function takeCompleteLines(buffer: Buffer, atStart: boolean): { texts: string[]; rest: Buffer } {
  const texts: string[] = [];
  let end = buffer.length;
  while (end > 0) {
    const newline = end >= 2 ? buffer.lastIndexOf(10, end - 2) : -1;
    if (newline === -1 && !atStart) break;
    texts.push(buffer.toString("utf8", newline + 1, end - 1));
    end = newline + 1;
  }
  return { texts, rest: buffer.subarray(0, end) };
}

export function mergeSeqRanges(ranges: readonly SeqRange[]): SeqRange[] {
  const merged: SeqRange[] = [];
  for (const range of [...ranges].sort((a, b) => a.startSeq - b.startSeq)) {
    const last = merged.at(-1);
    if (last && range.startSeq <= last.endSeq + 1)
      last.endSeq = Math.max(last.endSeq, range.endSeq);
    else merged.push({ ...range });
  }
  return merged;
}

export function containsJournalSeq(ranges: readonly SeqRange[], seq: number): boolean {
  let low = 0,
    high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const range = ranges[middle]!;
    if (seq < range.startSeq) high = middle - 1;
    else if (seq > range.endSeq) low = middle + 1;
    else return true;
  }
  return false;
}

/**
 * A tool call or plugin row merges with earlier rows of the same identity, however far back. A page
 * row is safe only when the window holds the start of its identity: a running tool call, or a row of
 * another turn before it (tool calls merge only within one turn, and a session runs one turn at a time).
 */
function identitiesStartInWindow(
  window: readonly AgentTimelineRow[],
  entries: ReadonlyArray<Pick<AgentTimelineRow, "item">>,
): boolean {
  const earliest = new Map<string, number>();
  window.forEach((row, index) => {
    const identity = timelineItemIdentity(row.item);
    if (identity !== null && !earliest.has(identity)) earliest.set(identity, index);
  });
  return entries.every((entry) => {
    const identity = timelineItemIdentity(entry.item);
    if (identity === null) return true;
    const index = earliest.get(identity)!;
    const first = window[index]!;
    if (first.item.type !== "tool_call") return false;
    if (first.item.status === "running") return true;
    return (
      first.turnId !== undefined &&
      window.slice(0, index).some((row) => row.turnId !== first.turnId)
    );
  });
}

/**
 * Journal records read from the end, newest first, and the tail page (or the page before
 * `beforeSeq`) they prove. The page equals the page a full replay gives once the first projected
 * row (which the window edge can cut short) stays out of it and every identity in it starts inside
 * the window. Every row after the cursor is read too, so later updates merge as in a full replay.
 */
export interface JournalTailWindowOptions {
  epoch: string;
  minSeq: number;
  limit: number;
  direction: "tail" | "before";
  /** A "before" page ends below this seq; without it, the page ends at the latest row. */
  beforeSeq?: number;
}

export class JournalTailWindow {
  // Latest version of each row; rows below `lowest` are updates of rows outside the window.
  private readonly rows = new Map<number, AgentTimelineRow>();
  private lowest = Number.POSITIVE_INFINITY;
  private nextSeq = 0;
  private checkedAt = 0;

  constructor(private readonly options: JournalTailWindowOptions) {}

  /** False when appends do not fall while reading backwards; the full load reports that fault. */
  add(record: JournalTailRecord): boolean {
    if (record.op === "update") {
      if (!this.rows.has(record.row.seq)) this.rows.set(record.row.seq, record.row);
      return true;
    }
    for (const row of record.rows) {
      if (row.seq >= this.lowest) return false;
      this.nextSeq = Math.max(this.nextSeq, row.seq + 1);
      if (!this.rows.has(row.seq)) this.rows.set(row.seq, row);
    }
    this.lowest = Math.min(this.lowest, ...record.rows.map((row) => row.seq));
    return true;
  }

  /** The page once the rows read prove it. Checks double in size, so the work stays linear. */
  provenPage(): AgentTimelineFetchResult | null {
    if (this.rows.size <= this.options.limit || this.rows.size < 2 * this.checkedAt) return null;
    this.checkedAt = this.rows.size;
    return this.page(false);
  }

  /** `complete` means every record was read, so the page needs no proof. */
  page(complete: boolean): AgentTimelineFetchResult | null {
    const { epoch, minSeq, limit, direction, beforeSeq } = this.options;
    const window = [...this.rows.values()]
      .filter((row) => row.seq >= this.lowest)
      .sort((left, right) => left.seq - right.seq);
    const projection = new TimelineProjection();
    for (const row of window) projection.append(row);
    const page = selectProjectedTimelinePage({
      rows: projection.getRows(),
      bounds: { minSeq, maxSeq: this.nextSeq - 1 },
      direction,
      cursorSeq: beforeSeq,
      limit,
    });
    if (!complete && !(page.hasOlder && identitiesStartInWindow(window, page.entries))) return null;
    // As in a full fetch, the page's source rows are projected again on their own.
    const ranges = mergeSeqRanges(page.entries.flatMap((entry) => entry.sourceSeqRanges));
    const selected = new TimelineProjection();
    for (const row of window) if (containsJournalSeq(ranges, row.seq)) selected.append(row);
    return {
      epoch,
      direction,
      reset: false,
      staleCursor: false,
      gap: false,
      window: { minSeq, maxSeq: this.nextSeq - 1, nextSeq: this.nextSeq },
      hasOlder: page.hasOlder,
      hasNewer: page.hasNewer,
      startSeq: page.startSeq,
      endSeq: page.endSeq,
      rows: selected.getRows(),
    };
  }
}
