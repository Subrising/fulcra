// G1 LaunchPad snooze: local to this window's host, until a time, and reversible. Browser storage on web (so it
// survives a restart), memory elsewhere. Nothing is sent to a tracker or the Command Centre.
type BrowserStorage = { getItem(key: string): string | null; setItem(key: string, value: string): void };
const memory = new Map<string, Record<string, number>>();
const key = (host: string) => JSON.stringify(["fulcra.launchpad.snoozed.v1", host]);
function storage(web: boolean): BrowserStorage | undefined {
  if (!web) return;
  try { return (globalThis as { localStorage?: BrowserStorage }).localStorage; } catch { return; }
}
export function readSnoozed(host: string, web: boolean, now = Date.now()): Record<string, number> {
  let saved: Record<string, number> = memory.get(host) ?? {};
  try {
    const raw = storage(web)?.getItem(key(host));
    if (raw) { const v = JSON.parse(raw); if (v && typeof v === "object" && !Array.isArray(v)) saved = v; }
  } catch { /* memory only */ }
  // Expired entries fall away; anything malformed is ignored rather than trusted.
  const live = Object.fromEntries(Object.entries(saved).filter(([k, t]) => typeof k === "string" && k.length <= 400 && Number.isFinite(t) && t > now).slice(0, 500));
  memory.set(host, live);
  return live;
}
function write(host: string, web: boolean, next: Record<string, number>) {
  memory.set(host, next);
  try { storage(web)?.setItem(key(host), JSON.stringify(next)); } catch { /* memory only */ }
  return next;
}
export function snooze(host: string, web: boolean, item: string, until: number, now = Date.now()) {
  return write(host, web, { ...readSnoozed(host, web, now), [item]: until });
}
export function unsnooze(host: string, web: boolean, item: string, now = Date.now()) {
  const { [item]: _gone, ...rest } = readSnoozed(host, web, now);
  return write(host, web, rest);
}
/** The snooze choices, as times from now: later today, tomorrow morning, next week. */
export function snoozeChoices(now: number): { label: string; until: number }[] {
  const d = new Date(now), tomorrow = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 9).getTime();
  return [{ label: "For 3 hours", until: now + 3 * 3_600_000 }, { label: "Until tomorrow", until: tomorrow }, { label: "For a week", until: now + 7 * 86_400_000 }];
}
