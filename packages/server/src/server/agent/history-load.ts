import type { FileHandle } from "node:fs/promises";
import { getHeapStatistics } from "node:v8";
import type { Logger } from "pino";

const HISTORY_LOAD_BYTES = 128 * 1024 * 1024;
const JOURNAL_CACHE_BYTES = 64 * 1024 * 1024;

interface LoadWaiter {
  bytes: number;
  resolve: (release: () => void) => void;
}

/** Large inputs run alone. Small inputs can share the same byte allowance. */
export class HistoryLoadBudget {
  private activeBytes = 0;
  private readonly waiting: LoadWaiter[] = [];
  constructor(private readonly maximum = HISTORY_LOAD_BYTES) {}

  acquire(bytes: number): Promise<() => void> {
    return new Promise((resolve) => {
      this.waiting.push({ bytes: Math.min(this.maximum, Math.max(1, bytes)), resolve });
      this.drain();
    });
  }

  private drain(): void {
    while (this.waiting.length) {
      const waiter = this.waiting[0]!;
      if (this.activeBytes + waiter.bytes > this.maximum) return;
      this.waiting.shift();
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

interface CacheEntry {
  bytes: number;
  busy: () => boolean;
  evict: () => void;
}

/** One allowance includes live, unloaded, and retained journal metadata across all stores. */
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
    for (const [key, entry] of this.entries) {
      if (this.bytes <= this.maximum) return;
      if (entry.busy()) continue;
      this.delete(key);
      entry.evict();
    }
  }
}

export const journalHistoryCache = new JournalHistoryCache();
let pluginCacheBytes = 0;
export function changePluginCacheBytes(delta: number): void {
  pluginCacheBytes += delta;
}

export function logHistoryLoad(
  logger: Logger,
  boundary: "start" | "end" | "error",
  source: "claude" | "journal",
  replayBytes: number,
): void {
  logger.info(
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
export async function* readHistoryLines(
  file: FileHandle,
  allowPartialLastLine = false,
): AsyncGenerator<HistoryLine> {
  const stream = file.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 });
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
        throw new Error("Incomplete timeline journal; retain for recovery");
      yield { text: Buffer.concat(pieces, bytes).toString("utf8"), offset, bytes };
    }
  } finally {
    stream.destroy();
  }
}
