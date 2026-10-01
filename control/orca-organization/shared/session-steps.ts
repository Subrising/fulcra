// J6 step-through: the three reads behind the Sessions scrubber. Every path in these payloads is relative to the
// session's project folder; a file outside it is `path: null` and shown as "a file outside the project".
import { defineContract } from "./rpc-contract";
import { z } from "zod";
import { ref, parseRef } from "./cc/refs";
// C1 integration: J0's v1.9 refs API has no refOf(kind); a ref of one kind is the shared `ref` narrowed by parseRef.
const refOf = (kind: string) => ref.refine(value => parseRef(value)?.kind === kind, { message: `Not a ${kind} ref` });

/** The exact words the plugin shows on a host without the timeline turn index (the host client's own message). */
export const NEWER_HOST_NEEDED = "This needs a newer Fulcra host.";

const sessionId = z.string().uuid();
const plain = (max: number) => z.string().max(max);
// Relative only: no root, drive, UNC or backslash, no empty, "." or ".." segment. The server places every path
// before it gets here; the schema refuses anything that slipped through.
export const relativePath = z.string().min(1).max(512).refine(
  value => !/^[\\/]/.test(value) && !/^[A-Za-z]:/.test(value) && !value.includes("\\")
    && value.split("/").every(part => part !== "" && part !== "." && part !== ".."),
  "Paths are relative to the project",
);

export const stepFileSchema = z.object({
  /** Null for a file outside the project; its path is never sent. */
  path: relativePath.nullable(),
  change: z.enum(["read", "written", "created", "edited", "deleted"]),
  /** Unified diff for an edit or patch, with project-relative headers. */
  diff: plain(24000).nullable(),
  ref: refOf("file").nullable(),
}).strict();

export const stepSchema = z.object({
  /** Position in the turn, from 0. The UI test ids use it: `sessions-step-<n>`. */
  n: z.number().int().nonnegative(),
  seq: z.number().int().nonnegative(),
  at: plain(64),
  kind: z.enum(["edit", "create", "read", "command", "search", "web", "other"]),
  /** Plain words: "Edited 2 files", "Ran tests: 12 passed". */
  summary: plain(160),
  outcome: z.enum(["done", "failed", "running"]),
  changesFiles: z.boolean(),
  files: z.array(stepFileSchema).max(64),
  command: plain(2000).nullable(),
  exitCode: z.number().int().nullable(),
  /** The last lines of a command's output. */
  output: plain(4000).nullable(),
  /** The agent's reasoning or message just before this step, if one was recorded. */
  why: plain(1500).nullable(),
  /** Null when the provider's turn id cannot be written as a §2.1 turn ref. */
  ref: refOf("turn").nullable(),
}).strict();

export const turnSchema = z.object({
  n: z.number().int().nonnegative(),
  turnId: plain(128),
  ref: refOf("turn").nullable(),
  /** A turn opened by a message without a provider turn id (replayed history, for example). */
  implicit: z.boolean(),
  startedAt: plain(64),
  endedAt: plain(64),
  summary: plain(160),
  toolCount: z.number().int().nonnegative(),
  /** Shell commands the turn ran (0 from a host that does not count them). */
  commands: z.number().int().nonnegative(),
  files: z.array(relativePath).max(200),
  outsideFiles: z.number().int().nonnegative(),
  /**
   * Whether any step in the turn wrote a file. Null when it cannot be said: the page had too many files to check, or
   * the turn ran commands and touched no file through a file tool (what a command changes is not recorded).
   */
  changesFiles: z.boolean().nullable(),
  /** L38: "Ran 3 commands; changes made through commands are not listed." for such a turn; otherwise null. */
  note: plain(160).nullable(),
}).strict();

const unsupported = z.object({ status: z.literal("unsupported"), message: plain(200) }).strict();
const unavailable = z.object({ status: z.literal("unavailable"), message: plain(300) }).strict();
const base = { sessionId, retained: z.boolean() };

export const sessionTurnsRpc = defineContract({
  name: "organization.session-turns",
  input: z.object({ sessionId, cursor: z.number().int().nonnegative().nullable().optional() }).strict(),
  output: z.discriminatedUnion("status", [
    z.object({ status: z.literal("ok"), ...base, turns: z.array(turnSchema).max(100), totalTurns: z.number().int().nonnegative(), nextCursor: z.number().int().nonnegative().nullable() }).strict(),
    unsupported, unavailable,
  ]),
});

export const sessionStepRpc = defineContract({
  name: "organization.session-step",
  input: z.object({ sessionId, turnId: plain(128) }).strict(),
  output: z.discriminatedUnion("status", [
    z.object({
      status: z.literal("ok"), ...base, turnId: plain(128), ref: refOf("turn").nullable(), provider: plain(64),
      /** What was asked at the start of the turn, if recorded. */
      asked: plain(1500).nullable(),
      summary: plain(160),
      steps: z.array(stepSchema).max(400),
      /** More steps exist than one page shows. */
      truncated: z.boolean(),
    }).strict(),
    unsupported, unavailable,
  ]),
});

export const touchSchema = z.object({
  seq: z.number().int().nonnegative(), turnId: plain(128), ref: refOf("turn").nullable(), at: plain(64),
  change: z.enum(["read", "written", "edited"]), summary: plain(160),
}).strict();

export const sessionFileHistoryRpc = defineContract({
  name: "organization.session-file-history",
  input: z.object({ sessionId, path: z.string().min(1).max(512) }).strict(),
  output: z.discriminatedUnion("status", [
    z.object({ status: z.literal("ok"), ...base, path: relativePath.nullable(), label: plain(600), ref: refOf("file").nullable(), touches: z.array(touchSchema).max(500) }).strict(),
    unsupported, unavailable,
  ]),
});

export type SessionTurns = z.infer<typeof sessionTurnsRpc.output>;
export type SessionStep = z.infer<typeof sessionStepRpc.output>;
export type SessionFileHistory = z.infer<typeof sessionFileHistoryRpc.output>;
export type Step = z.infer<typeof stepSchema>;
export type Turn = z.infer<typeof turnSchema>;
