import { ControllerFrameError } from "./controller-frames.js";
const codes = [
  "uncertain",
  "unavailable",
  "invalid",
  "expired",
  "unauthorised",
  "refused",
] as const;
/** Preserve outcome codes and validated public preconditions, never arbitrary error details. */
export function managementFailure(failure: unknown) {
  const raw = failure instanceof Error ? Reflect.get(failure, "code") : undefined;
  const code = codes.find((value) => value === raw) ?? "refused";
  let error = `Management ${code}`;
  if (code === "uncertain") error = "Management outcome uncertain; do not replay";
  else if (failure instanceof ControllerFrameError && failure.publicMessage)
    error = failure.publicMessage;
  return { code, error };
}
/**
 * Fulcra 0.2.9: the real reason for the daemon log only. Clients still get the plain outcome code above; the log
 * needs the reason, or "Management refused" hides a stopped controller.
 */
export function managementReason(failure: unknown): string {
  const message = failure instanceof Error ? failure.message : String(failure);
  return message.slice(0, 300);
}
/** The command's method name for the log, or null. */
export function managementMethod(command: unknown): string | null {
  const method = (command as { method?: unknown } | null)?.method;
  return typeof method === "string" ? method.slice(0, 80) : null;
}
