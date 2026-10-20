// FU-423: background work at controller start reads at most two sessions per second IN TOTAL, so a restart does not
// queue hundreds of per-agent requests on the daemon at once. Every paced pass shares one schedule: each caller
// gets the next free slot, STARTUP_FETCH_GAP_MS after the previous one. Requests that answer a person are not paced.
export const STARTUP_FETCH_GAP_MS = 500;
let nextSlot = 0;
// Reserves the next free slot and returns how long the caller waits for it.
export function reserveSlot(now = Date.now(), gapMs = STARTUP_FETCH_GAP_MS) {
  const slot = Math.max(now, nextSlot);
  nextSlot = slot + gapMs;
  return slot - now;
}
export function pace(gapMs = STARTUP_FETCH_GAP_MS) {
  const wait = reserveSlot(Date.now(), gapMs);
  if (wait <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, wait).unref?.());
}
