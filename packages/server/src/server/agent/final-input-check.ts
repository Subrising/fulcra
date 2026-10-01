/** Host-held refusal-only checks; never input authorization or a queue purpose. */
interface State {
  check: () => void;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}
const checks = new WeakMap<object, State>();
export function createFinalInputCheck(check: () => void): object {
  const handle = Object.freeze({});
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => {});
  checks.set(handle, { check, promise, resolve, reject });
  return handle;
}
export function assertFinalInputCheck(handle: object | undefined): void {
  if (!handle) return;
  const state = checks.get(handle);
  if (!state) throw new Error("Private final input check unavailable");
  try {
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
/** Called only AFTER the actual synchronous transport write/local SDK handoff, never an early manager event. */
export function recordFinalInputHandoff(handle: object | undefined): void {
  if (handle) checks.get(handle)?.resolve();
}
export function failFinalInputHandoff(handle: object | undefined, error: unknown): void {
  if (handle) checks.get(handle)?.reject(error);
}
export function waitForFinalInputHandoff(handle: object): Promise<void> {
  const state = checks.get(handle);
  if (!state) return Promise.reject(new Error("Private final input check unavailable"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Final notice handoff timed out")), 30000);
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
