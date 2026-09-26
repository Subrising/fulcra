import { useEffect, useSyncExternalStore } from "react";
import {
  readSessionOwnership,
  requestSessionOwnership,
  subscribeSessionOwnership,
} from "./session-ownership-store";
import {
  selectSessionOwnership,
  type SessionOwnership,
  type SessionOwnershipRecord,
} from "./session-ownership";

/**
 * The single place the app learns a session's recorded owner.
 *
 * The record belongs to the ownership service and reaches the app through the organization
 * plugin's `organization.session-ownership` read. Nothing here mints ownership, invents a
 * project id, or resolves a name: an absent, refused or malformed answer leaves the row
 * exactly as it was before — the daemon's derived placement — rather than claiming a
 * project.
 *
 * Only rendered rows call this, so the request is bounded to what is on screen. A
 * successful answer is trusted for a bounded time and then dropped rather than aged: see
 * POSITIVE_TTL_MS in the store.
 */
export function useSessionOwnership(input: {
  serverId: string;
  agentId: string;
}): SessionOwnership {
  const { serverId, agentId } = input;
  // Deliberately every render, not just on mount: that is what makes an expired answer be
  // re-asked "the next time the row renders" without a timer anywhere. The call is two map
  // lookups and returns immediately while an answer is fresh or in flight, so a row that
  // renders often costs nothing extra and a row nobody looks at costs nothing at all.
  useEffect(() => {
    requestSessionOwnership(serverId, agentId);
  });
  return useSyncExternalStore(
    subscribeSessionOwnership,
    () => readSessionOwnership(serverId, agentId),
    () => readSessionOwnership(serverId, agentId),
  );
}

/** Map one record onto the display model; exported for callers holding a record already. */
export function sessionOwnershipFromRecord(
  record: SessionOwnershipRecord | null | undefined,
): SessionOwnership {
  return selectSessionOwnership(record);
}
