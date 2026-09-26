import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { AgentTimelineItemPayloadSchema } from "@getpaseo/protocol/messages";
import { InMemoryAgentTimelineStore } from "./agent-timeline-store.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import type {
  AgentTimelineStore,
  AgentTimelineRow,
  AgentTimelineFetchOptions,
  AgentTimelineFetchResult,
  AgentTimelineIndexSnapshot,
  AgentTimelinePlacement,
} from "./agent-timeline-store-types.js";
import { TimelineIndexBuilder, type TimelineIndexData } from "./timeline-turn-index.js";

// Version 2 marks a journal that has rolled over to more segments. Daemons that predate segments
// parse the header strictly as version 1, so they refuse a rolled journal instead of appending
// reused sequence numbers to its first segment.
const Header = z
  .object({ version: z.union([z.literal(1), z.literal(2)]), agentId: z.string(), epoch: z.uuid() })
  .strict();
const ROLLED_HEADER_VERSION = 2;
const Row = z
  .object({
    seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    timestamp: z.string(),
    item: AgentTimelineItemPayloadSchema,
    turnId: z.string().optional(),
    providerMessageId: z.string().optional(),
  })
  .passthrough();
const Record = z.discriminatedUnion("op", [
  z.object({ op: z.literal("append"), rows: z.array(Row).min(1) }).strict(),
  z.object({ op: z.literal("update"), row: Row }).strict(),
]);
// The sidecar is a cache: anything that does not match the journal on disk is rebuilt from it.
const IndexSidecar = z.object({
  version: z.literal(2),
  agentId: z.string(),
  epoch: z.string(),
  cwd: z.string().nullable(),
  segments: z.array(z.object({ size: z.number(), inode: z.number() })),
  index: z.custom<TimelineIndexData>(
    (value) =>
      typeof value === "object" &&
      value !== null &&
      Array.isArray((value as TimelineIndexData).turns) &&
      Array.isArray((value as TimelineIndexData).files) &&
      Array.isArray((value as TimelineIndexData).external),
  ),
});
const Placement = z.object({ cwd: z.string().optional(), provider: z.string().optional() });
// Durable record of a retention in progress. Every listed segment is either still in the live
// directory or already in the staging directory, so recovery can always finish the move.
const RetentionIntent = z.object({
  version: z.literal(1),
  agentId: z.string(),
  transaction: z.string(),
  segments: z.array(z.number().int().nonnegative()),
  placement: Placement,
  retainedAt: z.string(),
});
// A retention that is published but whose delete has not finished (the registry record may still exist).
// While it is present the agent's history is the retained copy: reads resolve to it, and nothing may create
// a new live journal for the agent until the delete finishes (`commitRetention`) or is purged.
const PendingDelete = z.object({
  version: z.literal(1),
  agentId: z.string(),
  transaction: z.string(),
});
export const PENDING_DELETE_MESSAGE =
  "This agent is part way through being deleted. Delete it again to finish, and its history is kept.";
const RetainedMetadata = z.object({
  version: z.literal(1),
  agentId: z.string(),
  transaction: z.string(),
  retainedAt: z.string(),
  placement: Placement,
});
interface Segment {
  number: number;
  size: number;
  inode: number;
}
interface Journal {
  epoch: string;
  rows: Map<number, AgentTimelineRow>;
  memory: InMemoryAgentTimelineStore;
  /** In order; appends go to the last one. */
  segments: Segment[];
  index: TimelineIndexBuilder;
}
const DEFAULT_SEGMENT_MAX_BYTES = 256 * 1024 * 1024;
const INDEX_DIRECTORY = "index";
const RETAINED_DIRECTORY = "retained";
const RETAINED_METADATA = "retained.json";
const INDEX_WRITE_DELAY_MS = 500;

/**
 * Named points in the rollover and retention sequences. Tests stop a store at each one to model a
 * crash there; production passes no hook.
 */
export type FileAgentTimelineStep =
  | "segment-temp-created"
  | "segment-header-written"
  | "segment-synced"
  | "segment-published"
  | "journal-marked-rolled"
  | "retention-intent-written"
  | `retention-segment-staged-${number}`
  | "retention-index-staged"
  | "retention-metadata-written"
  | "retention-previous-superseded"
  | "retention-published"
  | "retention-pending-recorded";

export interface FileAgentTimelineStoreOptions {
  /** A segment that would grow past this rolls over to `<hash>.<n>.jsonl`. */
  segmentMaxBytes?: number;
  /** Retained history is read, never created. */
  createIfMissing?: boolean;
  /** Test seam: called after each step; throwing models a crash at that point. */
  onStep?: (step: FileAgentTimelineStep) => void | Promise<void>;
}

function errorCode(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error ? error.code : undefined;
}

/** Absent, or unreachable because a parent is not a directory: nothing can be stored there. */
function isMissing(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

async function exists(file: string): Promise<boolean> {
  try {
    await fsp.lstat(file);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

/** Makes renames and creations in a directory durable. Windows cannot open a directory for this. */
async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await fsp.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Temp file, fsync, rename, directory fsync: readers see the old file or the whole new one. */
async function writeFileDurably(file: string, content: string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fsp.open(temporary, "w", 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(temporary, file);
  await syncDirectory(path.dirname(file));
}

/** One daemon owns a home. Writes commit before the manager publishes a timeline row. */
export class FileAgentTimelineStore implements AgentTimelineStore {
  private readonly journals = new Map<string, Journal>();
  private readonly faults = new Map<string, unknown>();
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly cwds = new Map<string, string>();
  private readonly indexTimers = new Map<string, NodeJS.Timeout>();
  private readonly retainedStores = new Map<string, FileAgentTimelineStore>();
  /** Agents whose retention state has been checked since the last retention attempt. */
  private readonly reconciled = new Set<string>();
  private readonly segmentMaxBytes: number;
  private readonly createIfMissing: boolean;
  private readonly onStep?: FileAgentTimelineStoreOptions["onStep"];
  constructor(
    private readonly directory: string,
    options?: FileAgentTimelineStoreOptions,
  ) {
    this.segmentMaxBytes = options?.segmentMaxBytes ?? DEFAULT_SEGMENT_MAX_BYTES;
    this.createIfMissing = options?.createIfMissing ?? true;
    this.onStep = options?.onStep;
  }
  private async step(name: FileAgentTimelineStep): Promise<void> {
    await this.onStep?.(name);
  }
  private hash(id: string): string {
    return createHash("sha256").update(id).digest("hex");
  }
  private segmentName(id: string, number: number): string {
    return number === 0 ? `${this.hash(id)}.jsonl` : `${this.hash(id)}.${number}.jsonl`;
  }
  private file(id: string, number = 0): string {
    return path.join(this.directory, this.segmentName(id, number));
  }
  private indexFile(id: string): string {
    return path.join(this.directory, INDEX_DIRECTORY, `${this.hash(id)}.json`);
  }
  private retainedRoot(): string {
    return path.join(this.directory, RETAINED_DIRECTORY);
  }
  private retainedDirectory(id: string): string {
    return path.join(this.retainedRoot(), this.hash(id));
  }
  private stagingDirectory(id: string): string {
    return `${this.retainedDirectory(id)}.staging`;
  }
  private pendingFile(id: string): string {
    return `${this.retainedDirectory(id)}.pending.json`;
  }
  private async pendingDelete(id: string): Promise<boolean> {
    return (await exists(this.pendingFile(id))) || (await exists(this.intentFile(id)));
  }
  private async recordPending(id: string, transaction: string): Promise<void> {
    const marker: z.infer<typeof PendingDelete> = { version: 1, agentId: id, transaction };
    await writeFileDurably(this.pendingFile(id), JSON.stringify(marker) + "\n");
    await this.step("retention-pending-recorded");
  }
  /** The journal reads use: the live one, or the retained copy while a delete is pending. */
  private async readable(id: string): Promise<Journal> {
    await this.reconcileRetention(id);
    if (!(await this.pendingDelete(id))) return this.load(id);
    const store = await this.openRetainedStore(id);
    if (!store) throw new Error("Timeline retention lost its retained copy");
    return store.load(id);
  }
  private intentFile(id: string): string {
    return `${this.retainedDirectory(id)}.intent.json`;
  }
  private async listDirectory(directory: string): Promise<string[]> {
    try {
      return await fsp.readdir(directory);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }
  private async segmentNumbers(id: string): Promise<number[]> {
    const pattern = new RegExp(`^${this.hash(id)}(?:\\.([1-9]\\d*))?\\.jsonl$`);
    return (await this.listDirectory(this.directory))
      .flatMap((name) => {
        const match = pattern.exec(name);
        return match ? [match[1] === undefined ? 0 : Number(match[1])] : [];
      })
      .sort((a, b) => a - b);
  }
  /** Segment files whose publication never finished. They were never visible, so they go. */
  private async removeUnpublishedSegments(id: string): Promise<void> {
    const pattern = new RegExp(`^${this.hash(id)}(?:\\.[1-9]\\d*)?\\.jsonl\\.[0-9a-f-]+\\.tmp$`);
    for (const name of await this.listDirectory(this.directory))
      if (pattern.test(name)) await fsp.rm(path.join(this.directory, name), { force: true });
  }
  private serialize<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const task = (this.pending.get(id) ?? Promise.resolve()).then(operation);
    // Rejections are retained by faults; this barrier also orders explicit deletion.
    const settled = task.then(
      () => undefined,
      () => undefined,
    );
    this.pending.set(id, settled);
    void settled.then(() => {
      if (this.pending.get(id) === settled) this.pending.delete(id);
      return undefined;
    });
    return task;
  }
  /**
   * A segment is written and synced under a temporary name and published by rename, so a crash
   * leaves either no segment or a complete header, never an empty or torn one.
   */
  private async createSegment(
    id: string,
    number: number,
    epoch: string,
    version: number,
  ): Promise<fs.Stats | null> {
    const final = this.file(id, number);
    if (await exists(final)) return null;
    const temporary = `${final}.${randomUUID()}.tmp`;
    const handle = await fsp.open(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
    try {
      await this.step("segment-temp-created");
      await handle.writeFile(JSON.stringify({ version, agentId: id, epoch }) + "\n");
      await this.step("segment-header-written");
      await handle.sync();
      await this.step("segment-synced");
    } finally {
      await handle.close();
    }
    if (await exists(final)) {
      await fsp.rm(temporary, { force: true });
      return null;
    }
    await fsp.rename(temporary, final);
    await this.step("segment-published");
    await syncDirectory(this.directory);
    return fsp.lstat(final);
  }
  private async readSegment(id: string, number: number): Promise<{ text: string; stat: fs.Stats }> {
    const fileHandle = await fsp.open(
      this.file(id, number),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    try {
      const stat = await fileHandle.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.size > Math.max(this.segmentMaxBytes, DEFAULT_SEGMENT_MAX_BYTES)
      )
        throw new Error("Invalid timeline journal");
      return { text: await fileHandle.readFile("utf8"), stat };
    } finally {
      await fileHandle.close();
    }
  }
  private async load(id: string): Promise<Journal> {
    if (this.faults.has(id)) throw this.faults.get(id);
    const cached = this.journals.get(id);
    if (cached) return cached;
    // Never mint a new epoch over a pending delete: that is how an empty journal replaced the history.
    await this.reconcileRetention(id);
    if (await this.pendingDelete(id)) throw new Error(PENDING_DELETE_MESSAGE);
    try {
      await this.removeUnpublishedSegments(id);
      if (this.createIfMissing) {
        await fsp.mkdir(this.directory, { recursive: true, mode: 0o700 });
        await this.createSegment(id, 0, randomUUID(), 1);
      }
      const numbers = await this.segmentNumbers(id);
      // Before the contiguity check: a set-aside interrupted part way leaves a gap (0, 2, …) that only this
      // restart can finish. It still requires a version-1 segment 0, so a rolled journal's gap stays an error.
      if (numbers[0] === 0 && numbers.length > 1 && (await this.setAsideReseededTail(id, numbers)))
        numbers.splice(1);
      numbers.forEach((number, position) => {
        if (number !== position) throw new Error("Timeline journal segment missing");
      });
      let journal: Journal | undefined;
      for (const number of numbers) {
        const { text, stat } = await this.readSegment(id, number);
        if (!text.endsWith("\n"))
          throw new Error("Incomplete timeline journal; retain for recovery");
        const lines = text.trimEnd().split("\n"),
          header = Header.parse(JSON.parse(lines.shift()!));
        if (header.agentId !== id || (journal && header.epoch !== journal.epoch))
          throw new Error("Timeline journal identity changed");
        if (!journal) {
          journal = {
            epoch: header.epoch,
            rows: new Map(),
            memory: new InMemoryAgentTimelineStore(),
            segments: [],
            index: new TimelineIndexBuilder(this.cwds.get(id) ?? null),
          };
          journal.memory.initialize(id, { epoch: header.epoch });
        }
        journal.segments.push({ number, size: stat.size, inode: stat.ino });
        for (const line of lines) this.apply(id, journal, Record.parse(JSON.parse(line)));
      }
      if (!journal) throw new Error("Timeline journal segment missing");
      this.journals.set(id, journal);
      return journal;
    } catch (error) {
      this.faults.set(id, error);
      throw error;
    }
  }
  /**
   * A daemon from before segments that reseeds an agent deletes only `<hash>.jsonl` and writes a fresh version-1
   * segment 0, leaving this store's later segments behind. This store marks segment 0 as version 2 before it ever
   * creates segment 1, so a version-1 segment 0 beside later segments can only mean that reseed. The later
   * segments belong to the replaced history: they are renamed aside (`…orphaned-<time>`, never deleted) so the
   * agent reads the journal the older daemon wrote instead of faulting.
   */
  private async setAsideReseededTail(id: string, numbers: number[]): Promise<boolean> {
    const handle = await fsp.open(
      this.file(id, 0),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    let firstLine: string;
    try {
      const buffer = Buffer.alloc(4096);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      firstLine = buffer.subarray(0, bytesRead).toString("utf8").split("\n")[0] ?? "";
    } finally {
      await handle.close();
    }
    const header = Header.safeParse(
      (() => {
        try {
          return JSON.parse(firstLine);
        } catch {
          return null;
        }
      })(),
    );
    if (!header.success || header.data.version !== 1 || header.data.agentId !== id) return false;
    const stamp = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    for (const number of numbers.slice(1))
      await fsp.rename(this.file(id, number), `${this.file(id, number)}.orphaned-${stamp}`);
    await syncDirectory(this.directory);
    return true;
  }
  private apply(id: string, journal: Journal, record: z.infer<typeof Record>): void {
    this.validate(id, journal, record);
    if (record.op === "append") {
      for (const row of record.rows) {
        journal.rows.set(row.seq, row);
        if (!("seqStart" in row) && row.seq === journal.memory.getNextSeq(id))
          journal.memory.append(id, row.item, row);
        else
          journal.memory.initialize(id, { epoch: journal.epoch, rows: [...journal.rows.values()] });
        journal.index.add(row);
      }
    } else {
      const previous = journal.rows.get(record.row.seq);
      journal.rows.set(record.row.seq, record.row);
      journal.memory.initialize(id, { epoch: journal.epoch, rows: [...journal.rows.values()] });
      // Prompt enrichment is the common update and leaves the index alone.
      if (
        previous?.turnId !== record.row.turnId ||
        previous?.timestamp !== record.row.timestamp ||
        previous?.item.type !== record.row.item.type ||
        record.row.item.type === "tool_call"
      )
        journal.index = TimelineIndexBuilder.fromRows(journal.rows.values(), journal.index.cwd);
    }
  }
  private validate(id: string, journal: Journal, record: z.infer<typeof Record>): void {
    const maximum = journal.memory.getNextSeq(id) - 1;
    if (record.op === "append") {
      const seen = new Set<number>();
      for (const row of record.rows) {
        if (row.seq <= maximum || seen.has(row.seq))
          throw new Error("Timeline sequence must advance");
        seen.add(row.seq);
      }
    } else if (!journal.rows.has(record.row.seq))
      throw new Error("Timeline update has no original row");
  }
  /**
   * Flips the first segment's header from version 1 to 2 in place (same length, one byte) before
   * any later segment exists, so an older daemon refuses the journal rather than extending it.
   */
  private async markRolled(id: string, segment: Segment): Promise<void> {
    const handle = await fsp.open(this.file(id, 0), fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (stat.ino !== segment.inode || stat.size !== segment.size)
        throw new Error("Timeline journal changed");
      const prefix = Buffer.alloc(12);
      await handle.read(prefix, 0, prefix.length, 0);
      if (prefix.toString("utf8") === `{"version":${ROLLED_HEADER_VERSION}`) return;
      if (prefix.toString("utf8") !== '{"version":1')
        throw new Error("Unexpected timeline journal header");
      await handle.write(Buffer.from(String(ROLLED_HEADER_VERSION)), 0, 1, 11);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.step("journal-marked-rolled");
  }
  private async rotate(id: string, journal: Journal, previous: Segment): Promise<Segment> {
    if (previous.number === 0) await this.markRolled(id, previous);
    const number = previous.number + 1;
    const stat = await this.createSegment(id, number, journal.epoch, ROLLED_HEADER_VERSION);
    if (!stat) throw new Error("Timeline journal changed");
    const segment = { number, size: stat.size, inode: stat.ino };
    journal.segments.push(segment);
    return segment;
  }
  private async commit(id: string, value: unknown): Promise<void> {
    const journal = await this.load(id),
      record = Record.parse(value);
    this.validate(id, journal, record);
    const bytes = Buffer.from(JSON.stringify(record) + "\n");
    let segment = journal.segments[journal.segments.length - 1]!;
    const headerBytes = Buffer.byteLength(
      JSON.stringify({ version: ROLLED_HEADER_VERSION, agentId: id, epoch: journal.epoch }) + "\n",
    );
    // Refused before any write, so the journal stays usable.
    if (headerBytes + bytes.length > this.segmentMaxBytes)
      throw new Error("Timeline record exceeds the segment size limit");
    try {
      if (segment.size + bytes.length > this.segmentMaxBytes)
        segment = await this.rotate(id, journal, segment);
      const fd = await fsp.open(
        this.file(id, segment.number),
        fs.constants.O_WRONLY |
          fs.constants.O_APPEND |
          fs.constants.O_NOFOLLOW |
          fs.constants.O_NONBLOCK,
      );
      try {
        const stat = await fd.stat();
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          stat.ino !== segment.inode ||
          stat.size !== segment.size
        )
          throw new Error("Timeline journal changed");
        await fd.writeFile(bytes);
        await fd.sync();
      } finally {
        await fd.close();
      }
      segment.size += bytes.length;
      this.apply(id, journal, record);
      this.scheduleIndexWrite(id);
    } catch (error) {
      this.faults.set(id, error);
      throw error;
    }
  }
  private scheduleIndexWrite(id: string): void {
    if (this.indexTimers.has(id)) return;
    const timer = setTimeout(() => {
      this.indexTimers.delete(id);
      void this.flushIndex(id).catch(() => undefined);
    }, INDEX_WRITE_DELAY_MS);
    timer.unref?.();
    this.indexTimers.set(id, timer);
  }
  private clearIndexTimer(id: string): void {
    const timer = this.indexTimers.get(id);
    if (timer) clearTimeout(timer);
    this.indexTimers.delete(id);
  }
  private async writeIndex(id: string): Promise<void> {
    const journal = this.journals.get(id);
    if (!journal) return;
    const sidecar: z.infer<typeof IndexSidecar> = {
      version: 2,
      agentId: id,
      epoch: journal.epoch,
      cwd: journal.index.cwd,
      segments: journal.segments.map(({ size, inode }) => ({ size, inode })),
      index: journal.index.toData(),
    };
    const file = this.indexFile(id),
      temporary = `${file}.${randomUUID()}.tmp`;
    // Not recursive: a store whose directory was removed must not recreate it.
    await fsp.mkdir(path.dirname(file), { mode: 0o700 }).catch((error: unknown) => {
      if (errorCode(error) !== "EEXIST") throw error;
    });
    await fsp.writeFile(temporary, JSON.stringify(sidecar), { mode: 0o600 });
    await fsp.rename(temporary, file);
  }
  private async readIndexSidecar(id: string): Promise<z.infer<typeof IndexSidecar> | null> {
    try {
      const parsed = IndexSidecar.safeParse(
        JSON.parse(await fsp.readFile(this.indexFile(id), "utf8")),
      );
      return parsed.success && parsed.data.agentId === id ? parsed.data : null;
    } catch {
      return null;
    }
  }
  /**
   * The sidecar answers only while every segment still has the size and inode it recorded and it
   * was built for the cwd this store now places paths with.
   */
  private async readCurrentSidecar(id: string): Promise<AgentTimelineIndexSnapshot | null> {
    const sidecar = await this.readIndexSidecar(id);
    if (!sidecar || sidecar.cwd !== (this.cwds.get(id) ?? null)) return null;
    const numbers = await this.segmentNumbers(id);
    if (numbers.length !== sidecar.segments.length) return null;
    for (const number of numbers) {
      const stat = await fsp.lstat(this.file(id, number)).catch(() => null);
      const recorded = sidecar.segments[number];
      if (!stat || !recorded || stat.size !== recorded.size || stat.ino !== recorded.inode)
        return null;
    }
    return { epoch: sidecar.epoch, cwd: sidecar.cwd, index: sidecar.index };
  }
  private async hasJournal(id: string): Promise<boolean> {
    return (await this.segmentNumbers(id)).length > 0;
  }
  /**
   * Finishes a retention that an earlier process or attempt started. Runs before any read or
   * write of the agent, so a split between the live and retained directories is never observed.
   */
  private async reconcileRetention(id: string): Promise<void> {
    if (this.reconciled.has(id)) return;
    let text: string;
    try {
      text = await fsp.readFile(this.intentFile(id), "utf8");
    } catch (error) {
      if (!isMissing(error)) throw error;
      this.reconciled.add(id);
      return;
    }
    const intent = RetentionIntent.parse(JSON.parse(text));
    if (intent.agentId !== id) throw new Error("Timeline retention intent identity changed");
    await this.completeRetention(id, intent);
    this.reconciled.add(id);
  }
  /** Every step is idempotent, so this can resume after a crash at any point. */
  private async completeRetention(
    id: string,
    intent: z.infer<typeof RetentionIntent>,
  ): Promise<void> {
    const staging = this.stagingDirectory(id),
      target = this.retainedDirectory(id);
    // Published already, and only the intent was left behind.
    if (
      !(await exists(staging)) &&
      (await this.readRetainedMetadata(id))?.transaction === intent.transaction
    ) {
      if (!(await exists(this.pendingFile(id)))) await this.recordPending(id, intent.transaction);
      await fsp.rm(this.intentFile(id), { force: true });
      await syncDirectory(this.retainedRoot());
      return;
    }
    await fsp.mkdir(path.join(staging, INDEX_DIRECTORY), { recursive: true, mode: 0o700 });
    for (const number of intent.segments) {
      const staged = path.join(staging, this.segmentName(id, number));
      if (await exists(staged)) continue;
      const live = this.file(id, number);
      if (!(await exists(live))) throw new Error("Timeline retention lost a journal segment");
      await fsp.rename(live, staged);
      await this.step(`retention-segment-staged-${number}`);
    }
    await syncDirectory(this.directory);
    await fsp
      .rename(this.indexFile(id), path.join(staging, INDEX_DIRECTORY, `${this.hash(id)}.json`))
      .catch((error: unknown) => {
        if (!isMissing(error)) throw error;
      });
    await this.step("retention-index-staged");
    const metadata: z.infer<typeof RetainedMetadata> = {
      version: 1,
      agentId: id,
      transaction: intent.transaction,
      retainedAt: intent.retainedAt,
      placement: intent.placement,
    };
    await writeFileDurably(path.join(staging, RETAINED_METADATA), JSON.stringify(metadata) + "\n");
    await syncDirectory(staging);
    await this.step("retention-metadata-written");
    // An agent id deleted twice keeps both histories; readers use the newest. The previous copy
    // is renamed, never removed, and the new one is published by one directory rename.
    if (await exists(target)) {
      await fsp.rename(target, `${target}.superseded-${Date.now()}-${randomUUID().slice(0, 8)}`);
      await syncDirectory(this.retainedRoot());
      await this.step("retention-previous-superseded");
    }
    await fsp.rename(staging, target);
    await syncDirectory(this.retainedRoot());
    await this.step("retention-published");
    await this.recordPending(id, intent.transaction);
    await fsp.rm(this.intentFile(id), { force: true });
    await syncDirectory(this.retainedRoot());
  }
  private async readRetainedMetadata(id: string): Promise<z.infer<typeof RetainedMetadata> | null> {
    try {
      const text = await fsp.readFile(
        path.join(this.retainedDirectory(id), RETAINED_METADATA),
        "utf8",
      );
      const parsed = RetainedMetadata.safeParse(JSON.parse(text));
      return parsed.success && parsed.data.agentId === id ? parsed.data : null;
    } catch (error) {
      if (isMissing(error) || error instanceof SyntaxError) return null;
      throw error;
    }
  }
  private async retainedStore(id: string): Promise<FileAgentTimelineStore | null> {
    await this.serialize(id, () => this.reconcileRetention(id));
    return this.openRetainedStore(id);
  }
  /** Opens the retained copy without taking this agent's queue; callers have reconciled already. */
  private async openRetainedStore(id: string): Promise<FileAgentTimelineStore | null> {
    const cached = this.retainedStores.get(id);
    if (cached) return cached;
    const store = new FileAgentTimelineStore(this.retainedDirectory(id), {
      segmentMaxBytes: this.segmentMaxBytes,
      createIfMissing: false,
    });
    if (!(await store.hasJournal(id))) return null;
    // Placement comes from durable metadata; the index sidecar is only a cache of it.
    const cwd = (await this.readRetainedMetadata(id))?.placement.cwd;
    if (cwd) await store.setIndexCwd(id, cwd);
    this.retainedStores.set(id, store);
    return store;
  }
  appendCommitted(
    id: string,
    item: AgentTimelineItem,
    options?: { timestamp?: string; turnId?: string },
  ): Promise<AgentTimelineRow> {
    const input = structuredClone({ item, options });
    return this.serialize(id, async () => {
      const row = {
        seq: (await this.load(id)).memory.getNextSeq(id),
        timestamp: input.options?.timestamp ?? new Date().toISOString(),
        item: input.item,
        ...(input.options?.turnId ? { turnId: input.options.turnId } : {}),
      };
      await this.commit(id, { op: "append", rows: [row] });
      return structuredClone(row);
    });
  }
  fetchCommitted(id: string, options?: AgentTimelineFetchOptions) {
    return this.serialize(id, async () => (await this.readable(id)).memory.fetch(id, options));
  }
  getLatestCommittedSeq(id: string) {
    return this.serialize(id, async () => (await this.readable(id)).memory.getNextSeq(id) - 1);
  }
  getCommittedRows(id: string) {
    return this.serialize(id, async () =>
      structuredClone([...(await this.readable(id)).rows.values()]),
    );
  }
  getLastItem(id: string) {
    return this.serialize(id, async () => (await this.readable(id)).memory.getLastItem(id));
  }
  getLastAssistantMessage(id: string) {
    return this.serialize(id, async () =>
      (await this.readable(id)).memory.getLastAssistantMessage(id),
    );
  }
  /** Removes the live journal and its index. Retained history is untouched; see `purgeAgent`. */
  deleteAgent(id: string): Promise<void> {
    return this.serialize(id, async () => {
      this.clearIndexTimer(id);
      await this.reconcileRetention(id);
      // Highest segment first, so an interrupted delete leaves a readable prefix.
      for (const number of (await this.segmentNumbers(id)).toReversed())
        await fsp.rm(this.file(id, number), { force: true });
      await fsp.rm(this.indexFile(id), { force: true });
      this.journals.delete(id);
      this.faults.delete(id);
    });
  }
  /**
   * Moves the live journal, its index and its placement to `retained/<hash>/` as one recoverable
   * transaction: a durable intent, a staging directory, then a single directory rename. It
   * resolves only once the retained copy is published; a crash part way is finished on the next
   * access or by `recoverInterruptedRetention`.
   */
  retainAgent(id: string, placement?: AgentTimelinePlacement): Promise<void> {
    return this.serialize(id, async () => {
      this.clearIndexTimer(id);
      this.reconciled.delete(id);
      await this.reconcileRetention(id);
      this.reconciled.delete(id);
      if (this.journals.has(id)) await this.writeIndex(id);
      const numbers = await this.segmentNumbers(id);
      // A retry after a delete that retained but did not finish: the retention is already complete.
      if (numbers.length === 0 && (await this.pendingDelete(id))) {
        this.reconciled.add(id);
        return;
      }
      this.journals.delete(id);
      this.faults.delete(id);
      this.retainedStores.delete(id);
      if (numbers.length > 0) {
        await fsp.mkdir(this.retainedRoot(), { recursive: true, mode: 0o700 });
        await syncDirectory(this.directory);
        const intent: z.infer<typeof RetentionIntent> = {
          version: 1,
          agentId: id,
          transaction: randomUUID(),
          segments: numbers,
          placement: {
            ...(placement?.cwd ? { cwd: placement.cwd } : {}),
            ...(placement?.provider ? { provider: placement.provider } : {}),
          },
          retainedAt: new Date().toISOString(),
        };
        await writeFileDurably(this.intentFile(id), JSON.stringify(intent) + "\n");
        await this.step("retention-intent-written");
        await this.completeRetention(id, intent);
      }
      this.reconciled.add(id);
    });
  }
  /** Marks a retained agent's delete as finished; live history may be created for the id again. */
  commitRetention(id: string): Promise<{ committed: boolean }> {
    return this.serialize(id, async () => {
      await this.reconcileRetention(id);
      const committed = await exists(this.pendingFile(id));
      await fsp.rm(this.pendingFile(id), { force: true });
      if (committed) await syncDirectory(this.retainedRoot());
      return { committed };
    });
  }
  /** Agents with a retention whose delete has not finished, after finishing any interrupted move. */
  async listPendingDeletes(): Promise<string[]> {
    await this.recoverInterruptedRetention();
    const pending: string[] = [];
    for (const name of await this.listDirectory(this.retainedRoot())) {
      if (!name.endsWith(".pending.json")) continue;
      const parsed = PendingDelete.safeParse(
        JSON.parse(await fsp.readFile(path.join(this.retainedRoot(), name), "utf8")),
      );
      if (parsed.success) pending.push(parsed.data.agentId);
    }
    return pending;
  }
  /** Finishes every retention a previous process left part way. Run once at startup. */
  async recoverInterruptedRetention(): Promise<string[]> {
    const recovered: string[] = [];
    for (const name of await this.listDirectory(this.retainedRoot())) {
      if (!name.endsWith(".intent.json")) continue;
      const intent = RetentionIntent.parse(
        JSON.parse(await fsp.readFile(path.join(this.retainedRoot(), name), "utf8")),
      );
      await this.serialize(intent.agentId, () => this.reconcileRetention(intent.agentId));
      recovered.push(intent.agentId);
    }
    return recovered;
  }
  /** Removes live and retained history for an agent. Reports whether anything was there. */
  purgeAgent(id: string): Promise<{ purged: boolean }> {
    return this.serialize(id, async () => {
      this.clearIndexTimer(id);
      await this.reconcileRetention(id);
      const numbers = await this.segmentNumbers(id);
      for (const number of numbers.toReversed())
        await fsp.rm(this.file(id, number), { force: true });
      await fsp.rm(this.indexFile(id), { force: true });
      this.journals.delete(id);
      this.faults.delete(id);
      this.retainedStores.delete(id);
      await fsp.rm(this.pendingFile(id), { force: true });
      const hash = this.hash(id);
      const retained = (await this.listDirectory(this.retainedRoot())).filter(
        (name) => name === hash || name.startsWith(`${hash}.superseded-`),
      );
      for (const name of retained)
        await fsp.rm(path.join(this.retainedRoot(), name), { recursive: true, force: true });
      return { purged: numbers.length > 0 || retained.length > 0 };
    });
  }
  /** Paths in the index are stored relative to this directory; a change rebuilds the index. */
  setIndexCwd(id: string, cwd: string): Promise<void> {
    return this.serialize(id, async () => {
      if (this.cwds.get(id) === cwd) return;
      this.cwds.set(id, cwd);
      const journal = this.journals.get(id);
      if (journal && journal.index.cwd !== cwd) {
        journal.index = TimelineIndexBuilder.fromRows(journal.rows.values(), cwd);
        this.scheduleIndexWrite(id);
      }
    });
  }
  /**
   * Serves a loaded journal from memory, an unloaded one from a current sidecar, and otherwise
   * loads it. Returns null when the agent has no journal, without creating one.
   */
  getTimelineIndex(
    id: string,
    options?: { retained?: boolean },
  ): Promise<AgentTimelineIndexSnapshot | null> {
    if (options?.retained)
      return this.retainedStore(id).then((store) => store?.getTimelineIndex(id) ?? null);
    return this.serialize(id, async () => {
      if (this.faults.has(id)) throw this.faults.get(id);
      await this.reconcileRetention(id);
      if (await this.pendingDelete(id)) {
        const store = await this.openRetainedStore(id);
        return store ? store.getTimelineIndex(id) : null;
      }
      const loaded = this.journals.get(id);
      if (loaded)
        return { epoch: loaded.epoch, cwd: loaded.index.cwd, index: loaded.index.toData() };
      const sidecar = await this.readCurrentSidecar(id);
      if (sidecar) return sidecar;
      if (!(await this.hasJournal(id))) return null;
      const journal = await this.load(id);
      return { epoch: journal.epoch, cwd: journal.index.cwd, index: journal.index.toData() };
    });
  }
  /** Reads retained history for a deleted agent. Null when nothing was retained. */
  async fetchRetained(
    id: string,
    options?: AgentTimelineFetchOptions,
  ): Promise<AgentTimelineFetchResult | null> {
    const store = await this.retainedStore(id);
    return store ? store.fetchCommitted(id, options) : null;
  }
  /** Where a deleted agent ran, as recorded when it was retained. */
  async getRetainedPlacement(id: string): Promise<AgentTimelinePlacement | null> {
    await this.serialize(id, () => this.reconcileRetention(id));
    return (await this.readRetainedMetadata(id))?.placement ?? null;
  }
  /** Writes any pending index sidecar now. Sidecars otherwise follow writes after a short delay. */
  flushIndex(id: string): Promise<void> {
    this.clearIndexTimer(id);
    return this.serialize(id, () => this.writeIndex(id));
  }
  bulkInsert(id: string, rows: readonly AgentTimelineRow[]): Promise<void> {
    const input = structuredClone(rows);
    return this.serialize(id, async () => {
      if (input.length) await this.commit(id, { op: "append", rows: input });
    });
  }
  updateCommittedRow(id: string, row: AgentTimelineRow): Promise<void> {
    const input = structuredClone(row);
    return this.serialize(id, () => this.commit(id, { op: "update", row: input }));
  }
}
