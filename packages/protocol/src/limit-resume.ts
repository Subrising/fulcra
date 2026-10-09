/**
 * Auto-resume after a usage limit. The host writes LIMIT_RESUME_AT_LABEL (ISO time, empty when none) on a session
 * while a resume is queued; a session carrying LIMIT_RESUME_OPT_OUT_LABEL = "off" is never auto-resumed. Both ride
 * the existing agent labels, so no wire message changed.
 */
export const LIMIT_RESUME_REASON_LABEL = "fulcra.resume-reason";
export const LIMIT_RESUME_AT_LABEL = "fulcra.limit-resume-at";
export const LIMIT_RESUME_OPT_OUT_LABEL = "fulcra.limit-resume";
export const LIMIT_RESUME_PROMPT = "Usage limit has reset; continue where you left off.";
export const INTERRUPTED_RESUME_PROMPT =
  "The daemon restarted while you were working. Check your working tree and receipts, then continue where you left off; do not repeat an external action unless you verified it did not happen.";
export const NETWORK_RESUME_PROMPT =
  "The previous turn stopped after a temporary network failure. Check your working tree and receipts, then continue where you left off; do not repeat an external action unless you verified it did not happen.";

// A queued resume this far past its time did not happen (the host was down or dropped it); stop showing it.
const STALE_AFTER_MS = 15 * 60 * 1000;

/** When a queued resume is due, or null when none is shown. */
export function pendingLimitResumeAt(
  labels: Record<string, string> | null | undefined,
  nowMs: number,
): number | null {
  const raw = labels?.[LIMIT_RESUME_AT_LABEL];
  if (!raw) return null;
  const at = Date.parse(raw);
  if (!Number.isFinite(at) || nowMs - at > STALE_AFTER_MS) return null;
  return at;
}
