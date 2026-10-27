import { AsyncLocalStorage } from "node:async_hooks";

export const SEND_REQUEST_TIMEOUT_MS = 15_000;
const requests = new AsyncLocalStorage<AbortSignal>();

export class SendRequestTimeoutError extends Error {
  readonly code = "SEND_REQUEST_EXPIRED";
  constructor() {
    super(
      "Send timed out after 15 seconds. Delivery is unknown. Check this chat before sending again.",
    );
  }
}

export function sendRequestExpired(signal?: AbortSignal): boolean {
  return requests.getStore()?.aborted === true || signal?.aborted === true;
}

export function assertSendRequestActive(): void {
  requests.getStore()?.throwIfAborted();
}

export function captureSendRequestCheck(): () => void {
  const signal = requests.getStore();
  return () => signal?.throwIfAborted();
}

/** The disk operation keeps its receipt. Expiry withdraws any later direct provider input. */
export async function withSendRequestDeadline(run: () => Promise<void>): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new SendRequestTimeoutError();
      controller.abort(error);
      reject(error);
    }, SEND_REQUEST_TIMEOUT_MS);
  });
  try {
    await Promise.race([requests.run(controller.signal, run), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
