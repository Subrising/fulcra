import type { FileHandle } from "node:fs/promises";
import { getHeapStatistics } from "node:v8";
import type { Logger } from "pino";

const HISTORY_LOAD_BYTES = 128 * 1024 * 1024;
const JOURNAL_CACHE_BYTES = 128 * 1024 * 1024;
const ROW_CACHE_BYTES = 64 * 1024 * 1024;

interface LoadWaiter {
  bytes: number;
  resolve: (release: () => void) => void;
  cancel: () => void;
}

/** Large inputs run alone. Small inputs can share the same byte allowance. */
export class HistoryLoadBudget {
  private activeBytes = 0;
  private readonly waiting: LoadWaiter[] = [];
  constructor(private readonly maximum = HISTORY_LOAD_BYTES) {}

  acquire(bytes: number, signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const waiter: LoadWaiter = {
        bytes: Math.min(this.maximum, Math.max(1, bytes)),
        resolve,
        cancel: () => signal?.removeEventListener("abort", abort),
      };
      const abort = () => {
        const index = this.waiting.indexOf(waiter);
        if (index < 0) return;
        this.waiting.splice(index, 1);
        waiter.cancel();
        reject(signal?.reason);
        this.drain();
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.waiting.push(waiter);
      this.drain();
    });
  }

  private drain(): void {
    while (this.waiting.length) {
      const waiter = this.waiting[0]!;
      if (this.activeBytes + waiter.bytes > this.maximum) return;
      this.waiting.shift();
      waiter.cancel();
      this.activeBytes += waiter.bytes;
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.activeBytes -= waiter.bytes;
        this.drain();
      });
    }
  }
}

export const historyLoadBudget = new HistoryLoadBudget();
export const interactiveHistoryBudget = new HistoryLoadBudget(16 * 1024 * 1024);

interface CacheEntry {
  bytes: number;
  busy: () => boolean;
  evict: () => void;
}

/** One allowance bounds unused journal metadata across live and retained stores. */
export class JournalHistoryCache {
  private readonly entries = new Map<object, CacheEntry>();
  bytes = 0;
  constructor(private readonly maximum = JOURNAL_CACHE_BYTES) {}

  set(key: object, entry: CacheEntry): void {
    this.delete(key);
    this.entries.set(key, entry);
    this.bytes += entry.bytes;
    this.trim();
  }

  delete(key: object): void {
    const previous = this.entries.get(key);
    if (!previous) return;
    this.bytes -= previous.bytes;
    this.entries.delete(key);
  }

  touch(key: object): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  trim(): void {
    let unusedBytes = 0;
    for (const entry of this.entries.values()) if (!entry.busy()) unusedBytes += entry.bytes;
    for (const [key, entry] of this.entries) {
      if (unusedBytes <= this.maximum) return;
      if (entry.busy()) continue;
      this.delete(key);
      unusedBytes -= entry.bytes;
      entry.evict();
    }
  }
}

export const journalHistoryCache = new JournalHistoryCache();

/**
 * Full rows already read from a journal, keyed by their metadata entry, so repeated fetches of one
 * agent skip the disk. An update or reload makes a new entry, so a stale row is never found again.
 */
export class TimelineRowCache {
  private readonly entries = new Map<object, { row: unknown; bytes: number }>();
  bytes = 0;
  constructor(private readonly maximum = ROW_CACHE_BYTES) {}

  get(key: object): unknown {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.row;
  }

  set(key: object, row: unknown, bytes: number): void {
    this.delete(key);
    if (bytes > this.maximum) return;
    this.entries.set(key, { row, bytes });
    this.bytes += bytes;
    for (const oldest of this.entries.keys()) {
      if (this.bytes <= this.maximum) return;
      this.delete(oldest);
    }
  }

  delete(key: object): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.bytes -= entry.bytes;
    this.entries.delete(key);
  }
}

export const timelineRowCache = new TimelineRowCache();
let pluginCacheBytes = 0;
export function changePluginCacheBytes(delta: number): void {
  pluginCacheBytes += delta;
}

export function logHistoryLoad(
  logger: Logger,
  boundary: "start" | "end" | "error",
  source: "claude" | "claude_resume" | "claude_catalog" | "journal",
  replayBytes: number,
  level: "info" | "debug" = "info",
): void {
  if (!logger.isLevelEnabled(level)) return;
  logger[level](
    {
      boundary,
      source,
      replayBytes,
      heapUsed: process.memoryUsage().heapUsed,
      heapLimit: getHeapStatistics().heap_size_limit,
      journalCacheBytes: journalHistoryCache.bytes,
      pluginCacheBytes,
    },
    "history.load",
  );
}

export interface HistoryLine {
  text: string;
  offset: number;
  bytes: number;
}

/** Keeps one record, rather than the whole file. Offsets count UTF-8 bytes, including LF. */
/** `endOffset` stops at that byte offset, so a reader sees the file as it was when it was measured. */
export async function* readHistoryLines(
  file: FileHandle,
  allowPartialLastLine = false,
  signal?: AbortSignal,
  endOffset?: number,
): AsyncGenerator<HistoryLine> {
  if (endOffset === 0) return;
  const stream = file.createReadStream({
    autoClose: false,
    highWaterMark: 64 * 1024,
    signal,
    ...(endOffset === undefined ? {} : { end: endOffset - 1 }),
  });
  let pieces: Buffer[] = [];
  let bytes = 0;
  let offset = 0;
  try {
    for await (const chunk of stream) {
      const buffer: Buffer = chunk;
      let start = 0;
      let end: number;
      while ((end = buffer.indexOf(10, start)) !== -1) {
        const part = buffer.subarray(start, end);
        pieces.push(part);
        bytes += part.length;
        yield { text: Buffer.concat(pieces, bytes).toString("utf8"), offset, bytes: bytes + 1 };
        offset += bytes + 1;
        pieces = [];
        bytes = 0;
        start = end + 1;
      }
      if (start < buffer.length) {
        const part = buffer.subarray(start);
        pieces.push(part);
        bytes += part.length;
      }
    }
    if (bytes) {
      if (!allowPartialLastLine)
        throw new SyntaxError("Incomplete timeline journal; retain for recovery");
      yield { text: Buffer.concat(pieces, bytes).toString("utf8"), offset, bytes };
    }
  } finally {
    stream.destroy();
  }
}

interface ReadyHistory<T> {
  value: T;
  release: () => void;
}
interface SharedHistory<T> {
  promise: Promise<T>;
  readers: number;
  controller: AbortController;
  ready: ReadyHistory<T> | null;
}
export interface HistoryLease<T> {
  value: T;
  release: () => void;
}

/** Shares parsed data until every consumer finishes. Each consumer owns its mutable session. */
export class CoalescedHistoryLoads<T> {
  private readonly loads = new Map<string, SharedHistory<T>>();

  async acquire(
    key: string,
    signal: AbortSignal,
    start: (signal: AbortSignal) => Promise<ReadyHistory<T>>,
  ): Promise<HistoryLease<T>> {
    signal.throwIfAborted();
    const entry = this.loads.get(key) ?? this.create(key, start);
    entry.readers++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      signal.removeEventListener("abort", abort);
      entry.readers--;
      if (entry.readers !== 0) return;
      if (this.loads.get(key) === entry) this.loads.delete(key);
      entry.controller.abort();
      entry.ready?.release();
      entry.ready = null;
    };
    let abort!: () => void;
    const canceled = new Promise<never>((_resolve, reject) => {
      abort = () => {
        release();
        reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
    });
    try {
      const value = await Promise.race([entry.promise, canceled]);
      signal.throwIfAborted();
      return { value, release };
    } catch (error) {
      release();
      throw error;
    }
  }

  private create(
    key: string,
    start: (signal: AbortSignal) => Promise<ReadyHistory<T>>,
  ): SharedHistory<T> {
    const controller = new AbortController();
    const entry: SharedHistory<T> = {
      readers: 0,
      controller,
      ready: null,
      promise: Promise.resolve()
        .then(() => start(controller.signal))
        .then((ready) => {
          if (entry.readers === 0) ready.release();
          else entry.ready = ready;
          return ready.value;
        }),
    };
    this.loads.set(key, entry);
    return entry;
  }
}
