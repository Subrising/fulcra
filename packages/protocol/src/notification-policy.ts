
/** Host-wide choice of which sessions may notify: every session, only primes and leads, or none. */
export const NOTIFICATION_MODES = ["all", "primes", "off"] as const;
export type NotificationMode = (typeof NOTIFICATION_MODES)[number];
export const DEFAULT_NOTIFICATION_MODE: NotificationMode = "primes";

/** Per-session override written by the "Notify me" toggle: "on" always notifies, "off" never does. */
export const NOTIFY_LABEL = "fulcra.notify";

// Roles that mark a prime or lead. "implementation" and "review" are workers.
const LEAD_ROLES: ReadonlySet<string> = new Set([
  "prime",
  "lead",
  "orchestrator",
  "orchestration",
  "planning",
]);

export function isNotificationMode(value: unknown): value is NotificationMode {
  return typeof value === "string" && (NOTIFICATION_MODES as readonly string[]).includes(value);
}

/** A prime or lead is a session whose role says so, or one that has spawned children. */
export function isPrimeOrLead(input: {
  labels: Record<string, string> | null | undefined;
  hasChildren: boolean;
}): boolean {
  if (input.hasChildren) return true;
  const role = input.labels?.["fulcra.role"];
  return typeof role === "string" && LEAD_ROLES.has(role.trim().toLowerCase());
}

export function shouldNotifyForSession(input: {
  mode: NotificationMode;
  labels: Record<string, string> | null | undefined;
  hasChildren: boolean;
}): boolean {
  const override = input.labels?.[NOTIFY_LABEL];
  if (override === "off") return false;
  if (input.mode === "off") return false;
  if (override === "on") return true;
  if (input.mode === "all") return true;
  return isPrimeOrLead(input);
}

