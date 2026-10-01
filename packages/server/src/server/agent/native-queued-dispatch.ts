/** Native-only operation handles. Neither symbols nor matching functions grant authority. */
const capabilities = new WeakMap<
  () => void,
  { check: () => void; attempted: boolean; accepted?: string }
>();
const refusals = new WeakSet<object>();
const providers = new WeakMap<object, () => boolean>();

function refusal(message: string): Error {
  const error = new Error(message);
  refusals.add(error);
  return error;
}

export function registerNativeQueuedProvider(
  provider: object,
  available: () => boolean = () => true,
): void {
  if (providers.has(provider)) throw new Error("Native queued provider already registered");
  providers.set(provider, available);
}

export function supportsNativeQueuedProvider(provider: object): boolean {
  try {
    return providers.get(provider)?.() === true;
  } catch {
    return false;
  }
}

/** Constructed by the native manager from its immutable ledger ticket, never a wire callback. */
export function createNativeQueuedDispatch(check: () => void): () => void {
  const handle = () => validateNativeQueuedDispatch(handle);
  capabilities.set(handle, { check, attempted: false });
  return handle;
}

export function validateNativeQueuedDispatch(handle: () => void): void {
  const state = capabilities.get(handle);
  if (!state) throw refusal("Native queued capability unavailable");
  if (state.attempted) throw new Error("Native queued submission already attempted");
  try {
    const verdict: unknown = state.check();
    if (verdict && typeof verdict === "object" && "then" in verdict) {
      void Promise.resolve(verdict).catch(() => {});
      throw new Error("Native queued authority check must be synchronous");
    }
  } catch (error) {
    throw refusal(error instanceof Error ? error.message : "Native queued authority refused");
  }
}

/** Caller must supply the captured synchronous transport write, with no preparation inside it. */
export function submitNativeQueuedDispatch<T>(
  handle: () => void,
  write: () => T,
  checkPrepared?: () => void,
): T {
  validateNativeQueuedDispatch(handle);
  const preparedVerdict: unknown = checkPrepared?.();
  if (preparedVerdict && typeof preparedVerdict === "object" && "then" in preparedVerdict) {
    void Promise.resolve(preparedVerdict).catch(() => {});
    throw refusal("Native queued prepared check must be synchronous");
  }
  const state = capabilities.get(handle)!;
  state.attempted = true;
  return write();
}

/** Only an adapter with a validated response correlated to its actual submission may call this. */
export function recordNativeQueuedAcceptance(handle: () => void, nativeTurnId: string): void {
  const state = capabilities.get(handle);
  if (!state?.attempted || !nativeTurnId || state.accepted) {
    throw new Error("Native queued acceptance evidence unavailable");
  }
  state.accepted = nativeTurnId;
}

export function nativeQueuedAcceptance(handle: () => void): string | undefined {
  return capabilities.get(handle)?.accepted;
}

export function isNativeQueuedRefusal(error: unknown): boolean {
  return typeof error === "object" && error !== null && refusals.has(error);
}

export function refuseNativeQueuedDispatch(handle: () => void, message: string): never {
  if (capabilities.get(handle)?.attempted) throw new Error(message);
  throw refusal(message);
}

/** Manager failures before the adapter's sole handoff are known refusals; later failures stay ambiguous. */
export function nativeQueuedFailure(handle: () => void, error: unknown): unknown {
  if (capabilities.get(handle)?.attempted || isNativeQueuedRefusal(error)) return error;
  return refusal(error instanceof Error ? error.message : "Native queued preparation refused");
}
