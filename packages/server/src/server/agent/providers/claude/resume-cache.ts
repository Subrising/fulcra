import { createHash, randomUUID } from "node:crypto";
import { promises } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

/**
 * A saved Claude resume point: the session state after the first `end` bytes of a transcript.
 * Claude Code only appends to a transcript, so the next resume reads only the bytes after `end`.
 * Bump the version when the state, the skipped records or the conversion it follows changes.
 */
const RESUME_POINT_VERSION = 1;
/** The bytes before `end` must still match. A rewritten or replaced transcript is read in full. */
const CHECK_BYTES = 64 * 1024;

export interface ClaudeResumeCacheOptions {
  dir: string;
  /** Smaller transcripts are read in full and get no resume point. */
  minBytes?: number;
}

export const DEFAULT_RESUME_CACHE_MIN_BYTES = 16 * 1024 * 1024;
/** A resume that read fewer new bytes than this keeps the older point. */
export const RESUME_POINT_REFRESH_BYTES = 1024 * 1024;

export interface ClaudeResumePoint {
  end: number;
  state: unknown;
}

interface ResumePointHeader {
  version: number;
  historyPath: string;
  dev: number;
  ino: number;
  end: number;
  check: string;
}

function resumePointFile(dir: string, historyPath: string): string {
  return path.join(
    dir,
    `${createHash("sha256").update(historyPath).digest("hex").slice(0, 32)}.json`,
  );
}

async function readAt(handle: FileHandle, offset: number, bytes: number): Promise<Buffer> {
  const buffer = Buffer.alloc(bytes);
  let filled = 0;
  while (filled < bytes) {
    const { bytesRead } = await handle.read(buffer, filled, bytes - filled, offset + filled);
    if (bytesRead === 0) throw new Error("Transcript ended before the resume point");
    filled += bytesRead;
  }
  return buffer;
}

async function checkBytes(handle: FileHandle, end: number): Promise<string> {
  const from = Math.max(0, end - CHECK_BYTES);
  return createHash("sha256")
    .update(await readAt(handle, from, end - from))
    .digest("hex");
}

/** The saved point for this transcript, or null when there is none or it no longer matches. */
export async function readClaudeResumePoint(
  options: ClaudeResumeCacheOptions,
  historyPath: string,
  handle: FileHandle,
): Promise<ClaudeResumePoint | null> {
  let parsed: (ResumePointHeader & { state?: unknown }) | null;
  try {
    parsed = JSON.parse(
      await promises.readFile(resumePointFile(options.dir, historyPath), "utf8"),
    ) as ResumePointHeader & { state?: unknown };
  } catch {
    return null; // No point yet, or a torn write. The full read writes a new one.
  }
  if (
    !parsed ||
    parsed.version !== RESUME_POINT_VERSION ||
    parsed.historyPath !== historyPath ||
    typeof parsed.end !== "number" ||
    parsed.end <= 0 ||
    parsed.state === undefined
  )
    return null;
  const stat = await handle.stat();
  if (stat.dev !== parsed.dev || stat.ino !== parsed.ino || stat.size < parsed.end) return null;
  if ((await checkBytes(handle, parsed.end)) !== parsed.check) return null;
  return { end: parsed.end, state: parsed.state };
}

/** Saves `state`, already JSON, as the state after the first `end` bytes. */
export async function writeClaudeResumePoint(
  options: ClaudeResumeCacheOptions,
  historyPath: string,
  handle: FileHandle,
  end: number,
  stateJson: string,
): Promise<void> {
  // A point must sit at a line start, or the next tail read would begin inside a record.
  if ((await readAt(handle, end - 1, 1))[0] !== 10) return;
  const stat = await handle.stat();
  const header: ResumePointHeader = {
    version: RESUME_POINT_VERSION,
    historyPath,
    dev: stat.dev,
    ino: stat.ino,
    end,
    check: await checkBytes(handle, end),
  };
  const file = resumePointFile(options.dir, historyPath);
  await promises.mkdir(options.dir, { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  const json = JSON.stringify(header);
  await promises.writeFile(temp, `${json.slice(0, -1)},"state":${stateJson}}`, { mode: 0o600 });
  await promises.rename(temp, file);
}
