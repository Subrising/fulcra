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
