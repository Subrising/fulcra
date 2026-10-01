import { createHash } from "node:crypto";
import { canonicalJson } from "@getpaseo/protocol/trusted-input";
import { NativeEvidenceFactSchema } from "@getpaseo/protocol/native-evidence";
export interface NativeCompletion {
  id: string;
  threadId: string;
  turnId: string;
  kind: "produced_artifact" | "file_touch" | "command_result";
  bodyHash: string;
}
interface Sink {
  capture: (
    completion: Readonly<NativeCompletion>,
    requireProvider: () => void,
  ) =>
    | {
        prepare: () => Promise<boolean>;
        publish: (fact: unknown) => Promise<void>;
        requireCurrent: () => void;
      }
    | undefined;
  seen: Map<string, string>;
}
const consumedErrors = new WeakSet<object>();
function consumed(message: string): Error {
  const error = new Error(message);
  consumedErrors.add(error);
  return error;
}
export function isConsumedNativeCompletion(error: unknown): boolean {
  return typeof error === "object" && error !== null && consumedErrors.has(error);
}
const sinks = new WeakMap<object, Sink>();
const attempts = new WeakMap<
  object,
  {
    requireCurrent: () => void;
    publish: (fact: unknown) => Promise<void>;
    used: boolean;
    kind: NativeCompletion["kind"];
  }
>();
/** Installed only by the owning manager against the actual provider object. Never wire configuration. */
export function registerNativeEvidenceSink(provider: object, capture: Sink["capture"]): void {
  if (sinks.has(provider)) throw new Error("Native evidence producer already registered");
  sinks.set(provider, { capture, seen: new Map() });
}
export function captureNativeEvidence(
  provider: object,
  completion: NativeCompletion,
  requireProvider: () => void,
): (() => Promise<object>) | undefined {
  const sink = sinks.get(provider);
  if (!sink) return undefined;
  requireProvider();
  const snapshot = Object.freeze({ ...completion });
  if (
    !snapshot.id ||
    snapshot.id.length > 200 ||
    !snapshot.threadId ||
    !snapshot.turnId ||
    !/^[a-f0-9]{64}$/.test(snapshot.bodyHash)
  )
    throw new Error("Native completion correlation refused");
  const key = canonicalJson({
    thread: snapshot.threadId,
    turn: snapshot.turnId,
    id: snapshot.id,
  });
  const old = sink.seen.get(key);
  if (old) {
    if (old !== snapshot.bodyHash) throw consumed("Native completion body conflict");
    throw consumed("Native completion already observed");
  }
  if (sink.seen.size >= 10000) throw new Error("Native completion ID maintenance required");
  // Permanent for this native provider handle, BEFORE any materialization. No retry of a failed/ambiguous completion.
  sink.seen.set(key, snapshot.bodyHash);
  const capture = sink.capture(snapshot, requireProvider);
  if (!capture) return undefined;
  return async () => {
    if (!(await capture.prepare())) throw consumed("Durable native completion already attempted");
    requireProvider();
    capture.requireCurrent();
    const handle = Object.freeze({});
    attempts.set(handle, {
      requireCurrent: capture.requireCurrent,
      publish: capture.publish,
      used: false,
      kind: snapshot.kind,
    });
    return handle;
  };
}
export async function beginNativeEvidence(
  provider: object,
  completion: NativeCompletion,
  requireProvider: () => void,
): Promise<object | undefined> {
  const prepare = captureNativeEvidence(provider, completion, requireProvider);
  return prepare ? prepare() : undefined;
}

export function assertNativeEvidence(handle: object): void {
  const state = attempts.get(handle);
  if (!state || state.used) throw new Error("Private current native evidence attempt required");
  state.requireCurrent();
}
export function publishNativeEvidence(handle: object, fact: unknown): Promise<void> {
  const state = attempts.get(handle);
  if (!state || state.used) throw new Error("Private native evidence attempt required");
  state.used = true;
  const snapshot = NativeEvidenceFactSchema.parse(fact);
  if (snapshot.kind !== state.kind) throw new Error("Native evidence kind conflict");
  state.requireCurrent();
  return state.publish(snapshot);
}
export function nativeEvidenceDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
