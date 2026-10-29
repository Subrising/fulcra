/** Host-held refusal-only checks; never input authorization or a queue purpose. */
interface State {
  check: () => void;
  beforeHandoff?: () => void;
  committed: boolean;
  failure?: unknown;
  managerOnly: boolean;
  promise: Promise<void>;
  handoffConfirmed: () => boolean;
  resolve: () => void;
  reject: (error: unknown) => void;
}
/**
 * A final check that withdraws its input on purpose: the session did not start a turn and stays as it was. The
 * manager does not record a failed turn for it. `reason` names the condition that refused.
 */
export class FinalInputWithdrawnError extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = "FinalInputWithdrawnError";
  }
}
const checks = new WeakMap<object, State>();
export class FinalInputHandoffTimeoutError extends Error {
  constructor() {
    super("Final notice handoff timed out");
  }
}
export function createFinalInputCheck(
  check: () => void,
  beforeHandoff?: () => void,
  managerOnly = false,
): object {
  if (managerOnly && beforeHandoff)
    throw new Error("A manager-only check cannot commit native authority");
  const handle = Object.freeze({});
  let resolve!: () => void, reject!: (error: unknown) => void;
  let outcome: "pending" | "confirmed" | "failed" = "pending";
  const promise = new Promise<void>((yes, no) => {
    resolve = () => {
      if (outcome === "pending") outcome = "confirmed";
      yes();
    };
    reject = (error) => {
      if (outcome === "pending") outcome = "failed";
      no(error);
    };
  });
  void promise.catch(() => {});
  checks.set(handle, {
    check,
    beforeHandoff,
    managerOnly,
    committed: false,
    promise,
    handoffConfirmed: () => outcome === "confirmed",
    resolve,
    reject,
  });
  return handle;
}
/** Plain queue checks can stop at the manager's provider call. Native authority checks require transport support. */
export function requiresProviderInputHandoff(handle: object | undefined): boolean {
  return Boolean(handle && !checks.get(handle)?.managerOnly);
}
export function recordManagerInputHandoff(handle: object | undefined): void {
  if (handle && !requiresProviderInputHandoff(handle)) recordFinalInputHandoff(handle);
}

export function assertFinalInputCheck(handle: object | undefined): void {
  if (!handle) return;
  const state = checks.get(handle);
  if (!state) throw new Error("Private final input check unavailable");
  try {
    if (state.failure) throw state.failure;
    const result: unknown = state.check();
    if (result && typeof result === "object" && "then" in result) {
      void Promise.resolve(result).catch(() => {});
      throw new Error("Private final input check must be synchronous");
    }
  } catch (error) {
    state.reject(error);
    throw error;
  }
}
/** Commit once at a concrete synchronous provider handoff; early refusal checks never consume. */
export function commitFinalInputCheck(handle: object | undefined): void {
  if (!handle) return;
  assertFinalInputCheck(handle);
  const state = checks.get(handle)!;
  if (state.committed) {
    if (state.beforeHandoff) throw new Error("Private final input handoff already committed");
    return;
  }
  try {
    const result: unknown = state.beforeHandoff?.();
    if (result && typeof result === "object" && "then" in result) {
      void Promise.resolve(result).catch(() => {});
      throw new Error("Private final input commit must be synchronous");
    }
    state.committed = true;
  } catch (error) {
    state.reject(error);
    throw error;
  }
}
/** Called only AFTER the actual synchronous transport write/local SDK handoff, never an early manager event. */
export function recordFinalInputHandoff(handle: object | undefined): void {
  if (handle) checks.get(handle)?.resolve();
}
export function failFinalInputHandoff(handle: object | undefined, error: unknown): void {
  if (!handle) return;
  const state = checks.get(handle);
  if (!state) return;
  state.failure = error;
  state.reject(error);
}
export function finalInputFailure(handle: object | undefined): unknown {
  return handle ? checks.get(handle)?.failure : undefined;
}
/** Read the native receipt without waiting for the dispatch reply or changing its timeout. */
export function hasFinalInputHandoff(handle: object | undefined): boolean {
  return Boolean(handle && checks.get(handle)?.handoffConfirmed());
}
/**
 * How long a send waits for the provider to take its input before the check is revoked. A loaded host with a
 * long session history took over 30 s (31.4 s seen for an 18k-item timeline); a dead handoff still fails and
 * revokes the check, so a late transport cannot send twice.
 */
export const FINAL_INPUT_HANDOFF_MS = 120_000;
export function waitForFinalInputHandoff(
  handle: object,
  timeoutMs = FINAL_INPUT_HANDOFF_MS,
): Promise<void> {
  const state = checks.get(handle);
  if (!state) return Promise.reject(new Error("Private final input check unavailable"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      // Revoke a delayed transport's check before exposing an uncertain result to recovery.
      const error = new FinalInputHandoffTimeoutError();
      failFinalInputHandoff(handle, error);
      reject(error);
    }, timeoutMs);
    state.promise.then(
      () => {
        clearTimeout(timer);
        resolve();
        return undefined;
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
        return undefined;
      },
    );
  });
}
