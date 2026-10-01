// When you last looked at Today, per host: browser storage on web (so it survives a restart), memory elsewhere.
// Opening Today reads the previous look and records this one, so the page keeps showing "since last time" until
// it is opened again. Nothing here is sent anywhere.
type BrowserStorage = { getItem(key: string): string | null; setItem(key: string, value: string): void };
const memory = new Map<string, number>();
const key = (host: string) => JSON.stringify(["fulcra.today.last-look.v1", host]);
function storage(web: boolean): BrowserStorage | undefined {
  if (!web) return;
  try { return (globalThis as { localStorage?: BrowserStorage }).localStorage; } catch { return; }
}
export function takeLastLook(host: string, web: boolean, now = Date.now()): number | null {
  let previous: number | null = memory.get(host) ?? null;
  try { const saved = Number(storage(web)?.getItem(key(host))); if (Number.isFinite(saved) && saved > 0 && saved <= now) previous = saved; } catch { /* memory only */ }
  memory.set(host, now);
  try { storage(web)?.setItem(key(host), String(now)); } catch { /* memory only */ }
  return previous;
}
