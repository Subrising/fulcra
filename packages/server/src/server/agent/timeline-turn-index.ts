import path from "node:path";
import type { ToolCallDetail } from "./agent-sdk-types.js";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";

export type TimelineFileTouchKind = "read" | "write" | "edit" | "patch";

export interface TimelineTurnSummary {
  /** Provider turn id, or `seq-<n>` for rows recorded without one (history replay, out-of-band prompts). */
  turnId: string;
  implicit: boolean;
  seqStart: number;
  seqEnd: number;
  startedAt: string;
  endedAt: string;
  toolCount: number;
  /** Paths relative to the agent's working directory, in first-touch order. */
  files: string[];
  /** Touches outside the working directory. Their paths are never stored. */
  externalFileCount: number;
}

export interface TimelineTurnRecord extends TimelineTurnSummary {
  /** Inclusive seq ranges owned by this turn. Turns interleave when late rows arrive. */
  ranges: Array<[number, number]>;
}

export interface TimelineFileTouch {
  seq: number;
  turnId: string;
  kind: TimelineFileTouchKind;
  timestamp: string;
}

/** Relative paths only; the cwd they were placed against is host-local and kept outside. */
export interface TimelineIndexData {
  version: 1;
  turns: TimelineTurnRecord[];
  files: Array<[string, TimelineFileTouch[]]>;
  external: TimelineFileTouch[];
}

export type TimelinePathLocation = { kind: "relative"; path: string } | { kind: "external" };

const IMPLICIT_TURN_PREFIX = "seq-";

const WINDOWS_ROOTED = /^(?:[A-Za-z]:[\\/]|[\\/]{2}|\\)/;
const WINDOWS_DRIVE_RELATIVE = /^[A-Za-z]:(?![\\/])/;

function isWindowsPlacement(cwd: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|[\\/]{2})/.test(cwd);
}

/** The only shape the index stores: forward slashes, no root, no drive, no `.` or `..` segment. */
function isStoredRelativePath(candidate: string): boolean {
  if (!candidate || candidate.startsWith("/") || /^[A-Za-z]:/.test(candidate)) return false;
  return candidate
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * Maps a provider path onto the agent's working directory. Codex already strips the cwd; Claude
 * reports absolute paths. Rooted paths are read in the flavour of the cwd (POSIX, or Windows for a
 * drive or UNC cwd), so a Windows path seen on a POSIX host is still recognised as rooted. Anything
 * that escapes the directory, or cannot be placed without a cwd, is external, and the result is
 * checked again after normalisation so no rooted or escaping path is ever stored.
 */
/** `\\?\C:\x` is `C:\x` and `\\?\UNC\server\share\x` is `\\server\share\x`: Windows extended-length forms. */
function withoutExtendedLengthPrefix(value: string): string {
  if (/^\\\\\?\\UNC\\/i.test(value)) return "\\\\" + value.slice(8);
  if (/^\\\\\?\\[A-Za-z]:[\\/]/.test(value)) return value.slice(4);
  return value;
}

export function locateTimelinePath(filePath: string, cwd: string | null): TimelinePathLocation {
  const trimmed = withoutExtendedLengthPrefix(filePath.trim());
  const base = cwd === null ? null : withoutExtendedLengthPrefix(cwd);
  if (!trimmed || trimmed.startsWith("~") || WINDOWS_DRIVE_RELATIVE.test(trimmed)) {
    return { kind: "external" };
  }
  const windowsRooted = WINDOWS_ROOTED.test(trimmed);
  const posixRooted = trimmed.startsWith("/") && !windowsRooted;
  let relative: string;
  if (windowsRooted || posixRooted) {
    if (!base) return { kind: "external" };
    const windowsCwd = isWindowsPlacement(base);
    // A POSIX-rooted path cannot sit under a Windows cwd, and the reverse.
    if (windowsRooted !== windowsCwd) return { kind: "external" };
    relative = windowsCwd
      ? path.win32.relative(base, trimmed).replace(/\\/g, "/")
      : path.posix.relative(base, trimmed);
  } else {
    relative = trimmed.replace(/\\/g, "/");
  }
  const normalized = path.posix.normalize(relative).replace(/^(\.\/)+/, "");
  return isStoredRelativePath(normalized)
    ? { kind: "relative", path: normalized }
    : { kind: "external" };
}

/** One changed file is an edit, like a single-file Claude edit; several are a patch. */
function fileChangeTouches(
  files: ReadonlyArray<{ path: string }>,
): Array<{ path: string; kind: TimelineFileTouchKind }> {
  const kind: TimelineFileTouchKind = files.length > 1 ? "patch" : "edit";
  return files.map((file) => ({ path: file.path, kind }));
}

export function toolCallFileTouches(
  detail: ToolCallDetail,
): Array<{ path: string; kind: TimelineFileTouchKind }> {
  switch (detail.type) {
    case "read":
      return [{ path: detail.filePath, kind: "read" }];
    case "write":
      return [{ path: detail.filePath, kind: "write" }];
    case "edit":
      return detail.files?.length
        ? fileChangeTouches(detail.files)
        : [{ path: detail.filePath, kind: "edit" }];
    case "unknown":
      return detail.files?.length ? fileChangeTouches(detail.files) : [];
    default:
      return [];
  }
}

interface TurnState {
  record: TimelineTurnRecord;
  callIds: Set<string>;
  files: Set<string>;
}

/** Incremental turn and file index over one agent's journal rows, fed in seq order. */
export class TimelineIndexBuilder {
  private readonly turns = new Map<string, TurnState>();
  private readonly files = new Map<string, TimelineFileTouch[]>();
  private external: TimelineFileTouch[] = [];
  private readonly seenTouches = new Set<string>();
  private currentTurnId: string | null = null;

  constructor(readonly cwd: string | null) {}

  static fromRows(rows: Iterable<AgentTimelineRow>, cwd: string | null): TimelineIndexBuilder {
    const builder = new TimelineIndexBuilder(cwd);
    for (const row of rows) builder.add(row);
    return builder;
  }

  add(row: AgentTimelineRow): void {
    const turn = this.turnFor(row);
    const record = turn.record;
    if (row.seq > record.seqEnd) record.seqEnd = row.seq;
    if (row.timestamp > record.endedAt) record.endedAt = row.timestamp;
    const lastRange = record.ranges[record.ranges.length - 1];
    if (lastRange && row.seq === lastRange[1] + 1) lastRange[1] = row.seq;
    else if (!lastRange || row.seq > lastRange[1]) record.ranges.push([row.seq, row.seq]);

    const item = row.item;
    if (item.type !== "tool_call") return;
    if (!turn.callIds.has(item.callId)) {
      turn.callIds.add(item.callId);
      record.toolCount = turn.callIds.size;
    }
    for (const touch of toolCallFileTouches(item.detail)) {
      const location = locateTimelinePath(touch.path, this.cwd);
      const key = location.kind === "relative" ? location.path : "";
      const dedupe = `${item.callId}\0${location.kind}\0${key}`;
      if (this.seenTouches.has(dedupe)) continue;
      this.seenTouches.add(dedupe);
      const entry: TimelineFileTouch = {
        seq: row.seq,
        turnId: record.turnId,
        kind: touch.kind,
        timestamp: row.timestamp,
      };
      if (location.kind === "external") {
        this.external.push(entry);
        record.externalFileCount += 1;
        continue;
      }
      const history = this.files.get(location.path);
      if (history) history.push(entry);
      else this.files.set(location.path, [entry]);
      if (!turn.files.has(location.path)) {
        turn.files.add(location.path);
        record.files.push(location.path);
      }
    }
  }

  /**
   * A row with a turn id belongs to that turn. An unlabelled user message opens an implicit turn,
   * and any other unlabelled row (a failure notice, replayed history) joins the turn before it.
   */
  private turnFor(row: AgentTimelineRow): TurnState {
    let turnId: string;
    if (row.turnId) turnId = row.turnId;
    else if (row.item.type === "user_message" || this.currentTurnId === null)
      turnId = `${IMPLICIT_TURN_PREFIX}${row.seq}`;
    else turnId = this.currentTurnId;
    this.currentTurnId = turnId;
    const existing = this.turns.get(turnId);
    if (existing) return existing;
    const created: TurnState = {
      record: {
        turnId,
        implicit: !row.turnId,
        seqStart: row.seq,
        seqEnd: row.seq,
        startedAt: row.timestamp,
        endedAt: row.timestamp,
        toolCount: 0,
        files: [],
        externalFileCount: 0,
        ranges: [],
      },
      callIds: new Set(),
      files: new Set(),
    };
    this.turns.set(turnId, created);
    return created;
  }

  toData(): TimelineIndexData {
    return structuredClone({
      version: 1 as const,
      turns: [...this.turns.values()].map((turn) => turn.record),
      files: [...this.files.entries()],
      external: this.external,
    });
  }
}

export function listTimelineTurns(data: TimelineIndexData): TimelineTurnSummary[] {
  return data.turns.map(({ ranges: _ranges, ...summary }) => summary);
}

export function findTimelineTurn(
  data: TimelineIndexData,
  turnId: string,
): TimelineTurnRecord | null {
  return data.turns.find((turn) => turn.turnId === turnId) ?? null;
}

/** Accepts a relative path or an absolute path inside the cwd; anything else asks for the external bucket. */
export function getTimelineFileHistory(
  data: TimelineIndexData,
  requestedPath: string,
  cwd: string | null = null,
): { location: TimelinePathLocation; touches: TimelineFileTouch[] } {
  const location = locateTimelinePath(requestedPath, cwd);
  if (location.kind === "external") return { location, touches: [...data.external] };
  const entry = data.files.find(([filePath]) => filePath === location.path);
  return { location, touches: entry ? [...entry[1]] : [] };
}

export function isSeqInTurn(turn: Pick<TimelineTurnRecord, "ranges">, seq: number): boolean {
  return turn.ranges.some(([start, end]) => seq >= start && seq <= end);
}
