import { getPidLockInfo, isPidLockOwnerRunning, type PidLockInfo } from "./pid-lock.js";

/**
 * One daemon per home. The supervisor holds `paseo.pid` for its home, so a worker whose
 * home lock names a live process other than its own parent would run a second daemon on
 * the same agents, storage and sockets. Returns that other owner, or null when the worker
 * may start: no lock, an abandoned lock, or a lock held by its own supervisor.
 */
export async function findOtherHomeOwner(input: {
  paseoHome: string;
  parentPid: number;
}): Promise<PidLockInfo | null> {
  const lock = await getPidLockInfo(input.paseoHome);
  if (!lock || lock.pid === input.parentPid || lock.pid === process.pid) return null;
  return isPidLockOwnerRunning(lock) ? lock : null;
}

export function formatOtherHomeOwner(paseoHome: string, owner: PidLockInfo): string {
  return `Another Fulcra daemon owns ${paseoHome} (PID ${owner.pid}, started ${owner.startedAt}); this daemon worker exits`;
}
