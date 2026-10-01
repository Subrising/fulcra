import { AsyncLocalStorage } from "node:async_hooks";

interface RequestEffects {
  dispatched: boolean;
  refusals: WeakMap<Error, string>;
}
const requests = new AsyncLocalStorage<RequestEffects>();

/** Internal host boundary. Neither provider error properties nor text are authority. */
export function admissionRequest<T>(run: () => T): T {
  return requests.run({ dispatched: false, refusals: new WeakMap() }, run);
}
export function admissionCheck<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    const denied = error instanceof Error ? error : new Error("Admission refused");
    const state = requests.getStore();
    if (state && !state.dispatched && !state.refusals.has(denied))
      state.refusals.set(denied, denied.message);
    throw denied;
  }
}
/** Call before handing a mutating operation to a provider, including retries. */
export function nativeDispatch<T>(run: () => T): T {
  const state = requests.getStore();
  if (state) state.dispatched = true;
  return run();
}
export function admissionOutcome(
  error: unknown,
): { code: "admission_refused"; nativeDispatched: false } | undefined {
  const state = requests.getStore();
  if (!state || state.dispatched || !(error instanceof Error) || !state.refusals.has(error))
    return undefined;
  return { code: "admission_refused", nativeDispatched: false };
}

/** Trusted-hook diagnostic only; it never determines whether the outcome is refused. */
export function admissionDiagnostic(error: Error, reason: string): void {
  const state = requests.getStore();
  if (state && !state.dispatched) state.refusals.set(error, reason.slice(0, 1024));
}
export function admissionRefusalMessage(error: unknown): string | undefined {
  return admissionOutcome(error) && error instanceof Error
    ? requests.getStore()?.refusals.get(error)
    : undefined;
}
