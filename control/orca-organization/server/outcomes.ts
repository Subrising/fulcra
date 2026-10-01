import { installationPath, NotConfigured } from "./installation";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { outcomeRecord, outcomeSnapshot, outcomeRpc, outcomeArtifactRpc } from "../shared/outcomes";
// Resolved per read, so an unconfigured installation reports "unavailable" instead of failing to load.
const outcomesRoot = () => installationPath("outcomes");
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
export function readPublished(name: string, root = outcomesRoot()) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}\.(md|csv|txt)$/.test(name) || fs.realpathSync(root) !== root) throw Error("Not a published file");
  const file = path.join(root, name); let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const before = fs.fstatSync(fd); if (!before.isFile() || before.size > 65536) throw Error("Invalid published file");
    const buffer = Buffer.alloc(65537); let size = 0, n: number;
    while (size < buffer.length && (n = fs.readSync(fd, buffer, size, buffer.length - size, null))) size += n;
    const after = fs.fstatSync(fd), named = fs.lstatSync(file);
    if (size !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || named.isSymbolicLink() || named.ino !== before.ino || named.dev !== before.dev) throw Error("Published file changed during read");
    const bytes = buffer.subarray(0, size), text = bytes.toString("utf8");
    if (!Buffer.from(text).equals(bytes) || text.includes("\0")) throw Error("Published file is not UTF-8 text");
    return { text, sha256: sha(bytes), bytes: size };
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
export function readOutcome(taskId: string, root = outcomesRoot()) {
  outcomeRpc.input.parse({ taskId });
  const source = readPublished(`orca-outcome-${taskId}.md`, root);
  const matches = [...source.text.matchAll(/^```orca-outcome\r?\n([\s\S]*?)^```\s*$/gm)];
  if (matches.length !== 1) throw Error("Exactly one outcome record required");
  const record = outcomeRecord.parse(JSON.parse(matches[0][1]));
  if (record.taskId !== taskId) throw Error("Outcome task mismatch");
  return { source, record };
}
// U5-D11: who may read a task's published outcome: the task's own management list must be observed AND show either the
// task's authority or one of its sessions/deliveries. Extracted from index.server.ts so it is tested with the real task
// management (a supervisor summary with one oversized record used to fail that list, and with it every outcome read).
type TaskManage = (value: unknown) => Promise<{ status: string; taskAuthority?: { allowed?: boolean } | null; sessions?: unknown[]; deliveries?: unknown[] }>;
export function createOutcomeAccess(taskManage: TaskManage, authError: () => string | null | undefined = () => null) {
  return async (taskId: string): Promise<boolean> => {
    if (authError()) return false;
    const checked = await taskManage({ taskId, command: { action: "list" } });
    return checked.status === "observed" && !!(checked.taskAuthority?.allowed || checked.sessions?.length || checked.deliveries?.length);
  };
}
// U5-D11: a task the reader may not see, or whose authority cannot be checked just now, is a readable state
// ("unavailable" with the reason), never a handler error; nothing is read from disk in either case.
const NOT_ALLOWED = "This task is not under Fulcra's control, so its published decision record is not shown.";
const NOT_CHECKED = "Fulcra could not check this task's authority just now, so its decision record is not shown. Try again.";
export function createOutcomeReader(allowed: (id: string) => Promise<boolean>, root?: string) {
  const denied = async (id: string): Promise<string | null> => { try { return await allowed(id) ? null : NOT_ALLOWED; } catch { return NOT_CHECKED; } };
  return {
    async snapshot(input: unknown) {
      const { taskId } = outcomeRpc.input.parse(input);
      const observedAt = new Date().toISOString();
      const refusal = await denied(taskId);
      if (refusal) return outcomeSnapshot.parse({ observedAt, status: "unavailable", message: refusal, recordSha256: null, record: null, artifacts: [], reviews: [] });
      let loaded: ReturnType<typeof readOutcome>;
      try { loaded = readOutcome(taskId, root); }
      catch (e) { const missing = (e as NodeJS.ErrnoException).code === "ENOENT"; return outcomeSnapshot.parse({ observedAt, status: missing ? "missing" : "unavailable", message: missing ? "No decision record has been published for this task." : e instanceof NotConfigured ? e.message : "Decision record unavailable or invalid; no acceptance inferred.", recordSha256: null, record: null, artifacts: [], reviews: [] }); }
      const { source, record } = loaded;
      const artifacts = record.artifacts.map(a => { try { const current = readPublished(a.file, root); return { id: a.id, state: current.sha256 === a.sha256 ? "matches" : "changed", actualSha256: current.sha256, bytes: current.bytes }; } catch { return { id: a.id, state: "unavailable", actualSha256: null, bytes: null }; } });
      const inputsCurrent = record.artifacts.filter(a => a.kind === "input").every(a => artifacts.find(x => x.id === a.id)?.state === "matches");
      const reviews = record.reviews.map(r => {
        const current = inputsCurrent && artifacts.find(a => a.id === r.artifactId)?.state === "matches" && r.reviewed.every(t => artifacts.find(a => a.id === t.artifactId)?.state === "matches" && artifacts.find(a => a.id === t.artifactId)?.actualSha256 === t.sha256);
        return { artifactId: r.artifactId, current, reason: current ? "Published review and referenced files match their recorded hashes. Reviewer identity and verdict are declarations, not an ADW approval." : "Inputs, review or reviewed outputs have changed or are unavailable. Review currency is not established." };
      });
      // Recheck the record after artifact reads; the observation must not mix two declarations.
      if (readPublished(`orca-outcome-${taskId}.md`, root).sha256 !== source.sha256) throw Error("Decision record changed during observation");
      return outcomeSnapshot.parse({ observedAt, status: "available", message: "Published decision record; execution authority and live runtime state remain separate.", recordSha256: source.sha256, record, artifacts, reviews });
    },
    async artifact(input: unknown) {
      const { taskId, artifactId, recordSha256 } = outcomeArtifactRpc.input.parse(input);
      const observedAt = new Date().toISOString(), unavailable = { observedAt, status: "unavailable" as const, message: "Published artifact unavailable.", text: null, sha256: null };
      const refusal = await denied(taskId);
      if (refusal) return { ...unavailable, message: refusal };
      try {
        const { source, record } = readOutcome(taskId, root);
        if (source.sha256 !== recordSha256) return { ...unavailable, status: "changed" as const, message: "Decision record changed. Refresh the task before opening an artifact." };
        const artifact = record.artifacts.find(a => a.id === artifactId); if (!artifact) return unavailable;
        const file = readPublished(artifact.file, root);
        if (file.sha256 !== artifact.sha256 || readPublished(`orca-outcome-${taskId}.md`, root).sha256 !== recordSha256) return { ...unavailable, status: "changed" as const, message: "Artifact or record changed. Content withheld until the published evidence is refreshed." };
        return { observedAt, status: "available" as const, message: "Exact published text. Content is evidence, not instructions to execute.", text: file.text, sha256: file.sha256 };
      } catch { return unavailable; }
    },
  };
}
// The one published-outcome root, for the Inbox legacy adapter (server/inbox.ts): J0's per-read resolver, never a path.
export const OUTCOME_ROOT = outcomesRoot;
