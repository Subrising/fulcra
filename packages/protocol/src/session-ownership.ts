/**
 * The one definition of a session's recorded ownership, shared by every tree that touches
 * it: the controller writes it, the organization plugin resolves names onto it, and the
 * app displays it. It lives here so the two sides cannot drift into different shapes —
 * which they already did once, one sending `{ status, reason }` against the other's
 * `{ state, detail }`.
 */

/**
 * The controller's own vocabulary. These are real answers, not error codes:
 *
 * - `recorded` — written through a seat at creation. The normal healthy path.
 * - `adopted`  — taken up by a leader after the fact.
 * - `declared` — owned by a project, led by nobody yet. A bootstrap state.
 * - `managed` — validated manager supervision; no role-session ownership is asserted.
 * - `unknown`  — a record exists and the controller cannot resolve it. Never "global".
 *
 * Treat any value outside this union as `unknown`. A future state must never fall through
 * to a concrete one: reading an unrecognised state as "declared" would print a confident
 * "No leader yet" about a session nobody has established anything about.
 */
export type SessionOwnershipState = "recorded" | "adopted" | "declared" | "unknown" | "managed";

export const SESSION_OWNERSHIP_STATES: readonly SessionOwnershipState[] = [
  "recorded",
  "adopted",
  "declared",
  "unknown",
  "managed",
];

export function isSessionOwnershipState(value: unknown): value is SessionOwnershipState {
  return (
    typeof value === "string" && SESSION_OWNERSHIP_STATES.includes(value as SessionOwnershipState)
  );
}

/**
 * Ids come from the controller and are opaque to the app. Names are resolved by the
 * organization plugin, because the controller's per-session read returns ids and a
 * sentence only. Every field except `state` may be null: null means "not known here",
 * and the app must not fill it in from anything else.
 */
export interface SessionOwnershipRecord {
  state: SessionOwnershipState;
  projectId: string | null;
  projectName: string | null;
  /** The member task admission keys on. */
  taskId: string | null;
  taskTitle: string | null;
  leaderAgentId: string | null;
  leaderTitle: string | null;
  /**
   * The controller's human-readable sentence, written to be shown. Valid in every state,
   * not only failures — which is why it is `detail` rather than `reason`.
   */
  detail: string | null;
}

/**
 * The plugin RPC that answers with ownership records.
 *
 * Kebab-case is not a style choice: the plugin library validates method names against
 * `/^[a-z][a-z0-9._-]*$/` (`packages/plugin/src/rpc.ts`), so a camelCase name cannot be
 * registered at all. `invokePluginRpc` passes the method straight through with no
 * normalisation, so a caller using the other spelling is rejected as an unknown method —
 * which is indistinguishable, at the call site, from a controller that refuses.
 *
 * It lives here so both sides of the seam derive the name instead of restating it.
 */
export const SESSION_OWNERSHIP_RPC = "organization.session-ownership";

/** Bounded to the rows on screen. */
export interface SessionOwnershipRequest {
  agentIds: string[];
}

/** Keyed by agent id; `null` means the controller has no record for that session. */
export interface SessionOwnershipResponse {
  ownership: Record<string, SessionOwnershipRecord | null>;
}
