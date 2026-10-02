// Update-7: continue a session on the next account when its account hits a usage limit.
//
// The usage-limit stop paths (usage-limits.mjs for Claude, provider-recovery.mjs for Codex) call rotateOnLimit once per
// stop. With a pool configured for the provider, the session's account is marked limited until its reset and the
// session is re-assigned to the next available account (orca-organization/server/accounts.mjs). The stop is then due
// in seconds rather than at the reset: the session is relaunched in place with its history (the controller's fenced
// reconnect -- the same fences as a provider restart), which takes the new account's credential through the launch
// hook, and one continuation is sent. No pool, or every account limited: nothing changes -- the stop waits for its reset
// as before, and the account screen shows the earliest reset.
// The session's owner (the seat that started it, or its manager) is told in its next wake batch.
import { takeOverSession } from "./session-takeover.mjs";
import { rotate, rotationFor, readAccounts } from "../../orca-organization/server/accounts.mjs";
import { installationConfig } from "./installation-settings.mjs";

export const ROTATE_DELAY_MS = [5000, 20000];
export function poolRoot() {
  try {
    return installationConfig()?.home ?? null;
  } catch {
    return null;
  }
}
// `delegated: false` (B4): a human-held session is not moved and nobody is woken; the account is still marked limited.
export async function rotateOnLimit(
  control,
  { session, provider, resetAt = null, note = null, stopId, now = Date.now(), delegated = true },
  root = control?.poolRoot ?? poolRoot(),
) {
  if (!root) return null;
  let r;
  try {
    r = await rotate(root, session, provider, { resetAt, note, stopId, reassign: delegated }, now);
  } catch {
    return null;
  }
  if (!r) return null;
  if (delegated)
    try {
      control.wakes?.accountRotated?.(session, r);
    } catch {}
  return r;
}
export function rotationOf(stopId, control = null, root = control?.poolRoot ?? poolRoot()) {
  try {
    return root ? rotationFor(root, stopId) : null;
  } catch {
    return null;
  }
}
export function rotateDelay(random = Math.random) {
  const [lo, hi] = ROTATE_DELAY_MS;
  return Math.round(lo + (hi - lo) * random());
}
// Codex puts the reset in its message: "... Try again at Oct 3, 2026 5:42 PM." (local time on this Mac).
export function codexResetAt(text, now = Date.now()) {
  const m = /Try again at ([A-Z][a-z]{2} \d{1,2}, \d{4},? \d{1,2}:\d{2} ?[AP]M)/.exec(
    String(text ?? ""),
  );
  const t = m ? Date.parse(m[1].replace(",", "").replace(/(\d)([AP]M)$/, "$1 $2")) : NaN;
  return Number.isFinite(t) && t > now ? new Date(t).toISOString() : null;
}
export function rotationNote(r) {
  return `This session's account "${r.fromName}" reached its usage limit (resets ${r.resetAt}); Fulcra moved the session to account "${r.toName}" with its history.`;
}
// The fenced in-place relaunch provider-recovery uses: delegated, same generation, no human activity or changed
// identity since delegation. Only pre-existing human input / identity drift revokes delegation;
// the quiet account reconnect itself neither records human input nor transfers ownership.
export async function fencedRelaunch(control, session, generation, accountId, now = Date.now) {
  const root = control?.poolRoot ?? poolRoot();
  const target = accountId ?? (root && readAccounts(root).assignments[session]?.accountId);
  return takeOverSession(session, target, { control, root, generation, now, reason: "limit" });
}
